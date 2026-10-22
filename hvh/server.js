'use strict';
/* =========================================================
   Портал игрового сервера — HTTP-сервер.
   Без внешних зависимостей: node:http + node:sqlite.
   ========================================================= */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const D = require('./db');
const { Monitor, queryPlayers } = require('./monitor');
const rcon = require('./rcon');
const issue = require('./issue');
const U = require('./users');
const G = require('./gamestats');
const vipdb = require('./vipdb');

/* ---------- RCON ---------- */
function rconCfg() {
  const s = D.getSettings('rcon') || {};
  return {
    host: String(s.host || '').trim(),
    port: Number(s.port) || 0,
    password: String(s.password || '')
  };
}

const PORT = Number(process.env.PORT || 8813);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14;

/* ---------- старт базы ---------- */
D.seedSettings();
D.seedData();

/* пароль админа из настроек (по умолчанию admin) */
function ensureAdminPassword() {
  const s = D.q.get('SELECT value FROM settings WHERE key = ?', 'admin_password');
  if (!s) {
    const pass = process.env.ADMIN_PASSWORD || 'admin';
    D.setSettings('admin_password', { hash: D.hashPass(pass).hash, salt: D.hashPass(pass).salt });
  }
}
ensureAdminPassword();

/* ---------- мониторинг ---------- */
const monitor = new Monitor(D, 45000);
monitor.start();

/* ---------- прокси виджета мониторинга ----------
   MonWave отдаёт SVG с логотипом и своим синим цветом.
   Мы убираем брендинг и перекрашиваем под палитру сайта. */
const WIDGET_CACHE = new Map();

const WIDGET_COLORS = {
  '#1a1d23': '#120e21',   // фон карточки
  '#2d3139': '#2a2148',   // рамка и шкала
  '#e8eaed': '#c9a4ff',   // основной текст -> светло-фиолетовый сайта
  '#9aa0a6': '#8b86a3',   // приглушённый текст
  '#2ecc71': '#34d399',   // зелёный «онлайн»
  '#4a9eff': '#a855f7'    // синий акцент -> фиолетовый сайта
};

async function fetchWidget(id) {
  const key = String(id);
  const cached = WIDGET_CACHE.get(key);
  if (cached && Date.now() - cached.at < 20000) return cached.svg;

  const res = await fetch(`https://monwave.ru/api/widget/${encodeURIComponent(key)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; flux-hvh-portal)' }
  });
  if (!res.ok) throw new Error('виджет недоступен: HTTP ' + res.status);
  let svg = await res.text();

  // вырезаем блок с логотипом и подписью MonWave
  svg = svg.replace(/<a\b[\s\S]*?<\/a>/gi, '');

  // перекрашиваем под сайт
  for (const [from, to] of Object.entries(WIDGET_COLORS)) {
    svg = svg.split(from).join(to);
  }
  svg = svg.replace(/fill="#fff"/gi, 'fill="#c9a4ff"');


  WIDGET_CACHE.set(key, { svg, at: Date.now() });
  return svg;
}
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  // HEAD отвечает заголовками, но без тела
  if (res.req && res.req.method === 'HEAD') return res.end();
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const ok = (res, data) => send(res, 200, data);
const fail = (res, code, msg) => send(res, code, { error: msg });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------- сессии ---------- */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function getSession(req) {
  const tok = parseCookies(req).sid;
  if (!tok) return null;
  const s = D.q.get('SELECT * FROM sessions WHERE token = ?', tok);
  if (!s) return null;
  if (s.expires_at < D.now()) { D.q.run('DELETE FROM sessions WHERE token = ?', tok); return null; }
  const u = await U.findById(s.user_id);
  if (!u) return null;
  return { session: s, user: u };
}

function setSessionCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie',
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`);
}

/* ---------- простой антибрутфорс ---------- */
const attempts = new Map();
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (a.until < Date.now()) { attempts.delete(ip); return false; }
  return a.count >= 8;
}
function noteFail(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count++; a.until = Date.now() + 10 * 60 * 1000;
  attempts.set(ip, a);
}
const clearFails = ip => attempts.delete(ip);

/* ---------- проверка CSRF ---------- */
function checkCsrf(req, sess) {
  if (!sess) return false;
  const h = req.headers['x-csrf'];
  if (!h || !sess.session.csrf) return false;
  const a = Buffer.from(String(h));
  const b = Buffer.from(sess.session.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const publicUser = u => ({
  id: u.id, login: u.login, email: u.email || '', game_login: u.game_login || '',
  steam_id: u.steam_id || '', avatar: u.avatar || '', persona: u.persona || '',
  balance: u.balance, is_admin: !!u.is_admin, game_admin: !!u.game_admin, created_at: u.created_at,
  last_login: u.last_login || 0,
  roles: (u.roles && u.roles.length) ? u.roles : [u.is_admin ? 'admin' : 'user'],
  role: u.role || (u.is_admin ? 'admin' : 'user')
});

/* ---------- API ---------- */
const api = {

  /* --- виджет мониторинга (SVG от внешнего сервиса) --- */
  'GET /api/widget': async (req, res, ctx) => {
    const id = (ctx.query.get('id') || '17984');
    try {
      const svg = await fetchWidget(id);
      send(res, 200, svg, 'image/svg+xml; charset=utf-8', {
        'Cache-Control': 'public, max-age=20'
      });
    } catch (e) {
      send(res, 502, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120">
        <rect width="320" height="120" rx="8" fill="#120e21" stroke="#2a2148"/>
        <text x="16" y="60" font-family="Inter,sans-serif" font-size="13" fill="#8b86a3">Виджет временно недоступен</text>
      </svg>`, 'image/svg+xml; charset=utf-8');
    }
  },

  /* --- публичное --- */
  'GET /api/site': (req, res) => {
    const settings = D.allSettings();
    const services = D.q.all('SELECT * FROM services WHERE enabled = 1 ORDER BY sort, id')
      .map(s => ({ ...s, title: D.parseJson(s.title, { ru: s.title, en: s.title }),
                   subtitle: D.parseJson(s.subtitle, { ru: s.subtitle, en: s.subtitle }),
                   features: D.parseJson(s.features, { ru: s.features, en: s.features }) }));
    const news = D.q.all('SELECT * FROM news WHERE published = 1 ORDER BY created_at DESC LIMIT 20')
      .map(n => ({ ...n, title: D.parseJson(n.title, { ru: n.title, en: n.title }),
                   body: D.parseJson(n.body, { ru: n.body, en: n.body }),
                   tag: D.parseJson(n.tag, { ru: n.tag, en: n.tag }) }));
    const servers = D.q.all('SELECT * FROM servers WHERE enabled = 1 ORDER BY sort, id')
      .map(s => ({ ...s, status: monitor.status(s) }));
    const widgets = D.allWidgets().filter(w => w.enabled);
    ok(res, { settings, services, news, servers, widgets, demo: true });
  },

  /* публичная статистика: онлайн, игроки, топ донатеров */
  'GET /api/stats': async (req, res) => {
    const servers = D.q.all('SELECT * FROM servers WHERE enabled = 1 ORDER BY sort, id')
      .map(s => ({ ...s, status: monitor.status(s) }));
    let players = 0, maxPlayers = 0;
    for (const s of servers) {
      players += s.status.players || 0;
      maxPlayers += s.status.max_players || 0;
    }
    const tops = D.q.all(`SELECT login, SUM(amount) AS sum, MAX(created_at) AS last FROM donations
                           WHERE status = 'paid' AND login <> ''
                           GROUP BY login ORDER BY sum DESC LIMIT 3`);
    const tops7 = D.q.all(`SELECT login, SUM(amount) AS sum, MAX(created_at) AS last FROM donations
                           WHERE status = 'paid' AND login <> '' AND created_at >= ?
                           GROUP BY login ORDER BY sum DESC LIMIT 3`, Date.now() - 7 * 86400000);
    const tops30 = D.q.all(`SELECT login, SUM(amount) AS sum, MAX(created_at) AS last FROM donations
                           WHERE status = 'paid' AND login <> '' AND created_at >= ?
                           GROUP BY login ORDER BY sum DESC LIMIT 3`, Date.now() - 30 * 86400000);
    const drops = D.q.all(`SELECT login, amount, created_at FROM donations
                           WHERE status = 'paid' AND login <> ''
                           ORDER BY id DESC LIMIT 12`);
    const one = (sql, ...a) => { try { const r = D.q.get(sql, ...a); return r ? (r.c || 0) : 0; } catch { return 0; } };
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const total = one('SELECT COUNT(*) AS c FROM users');
    const d7 = one('SELECT COUNT(*) AS c FROM users WHERE last_login >= ?', Date.now() - 7 * 86400000);
    const today = one('SELECT COUNT(*) AS c FROM users WHERE last_login >= ?', dayStart.getTime());
    const site = one('SELECT COUNT(DISTINCT user_id) AS c FROM sessions WHERE expires_at > ?', Date.now());

    /* игровая статистика: lvl_base / vip_users / sb_bans / sb_comms / карточки */
    let g = null;
    try { g = await G.stats(); } catch (e) { console.error('gamestats:', e.message); }

    ok(res, {
      players, maxPlayers, site, tops, drops,
      tops_by_day: { 7: tops7, 30: tops30, 0: tops },
      total: g ? g.total : total,
      d7: g ? g.d7 : d7,
      today: g ? g.today : today,
      vip: g ? g.vip : 0,
      banned: g ? g.banned : 0,
      muted: g ? g.muted : 0,
      cardDrops: (g && g.drops) || []
    });
  },

  /* --- списки VIP, банов и мутов --- */
  'GET /api/game/vip': async (req, res, ctx) => {
    ok(res, { vip: await G.vip(ctx.query.get('limit')) });
  },

  'GET /api/game/bans': async (req, res, ctx) => {
    ok(res, { bans: await G.bans(ctx.query.get('limit'), ctx.query.get('active') === '1') });
  },

  'GET /api/game/mutes': async (req, res, ctx) => {
    ok(res, { mutes: await G.mutes(ctx.query.get('limit'), ctx.query.get('active') === '1') });
  },

  /* профиль игрока (публичная статистика из lvl_base) */
  'GET /api/game/profile': async (req, res, ctx) => {
    const id = String(ctx.query.get('id') || '').trim();
    if (!id) return fail(res, 400, 'Нужен SteamID');
    const data = await G.profile(id);
    if (!data) return fail(res, 503, 'Игровая база недоступна');

    /* аккаунт портала, если Steam привязан */
    let portal = null;
    try {
      const u = await U.findBySteam(data.steamid64);
      if (u) {
        const self = ctx.user && ctx.user.id === u.id;
        portal = {
          login: u.login,
          is_admin: !!u.is_admin,
          self,
          balance: self ? u.balance : null,
          created_at: u.created_at || null
        };
      }
    } catch { /* портал может быть недоступен */ }

    ok(res, { profile: data, portal, steam: await steamArt(data.steamid64) });
  },

  'GET /api/servers': (req, res) => {
    const servers = D.q.all('SELECT * FROM servers WHERE enabled = 1 ORDER BY sort, id')
      .map(s => ({ ...s, status: monitor.status(s) }));
    ok(res, { servers });
  },

  'GET /api/servers/refresh': async (req, res) => {
    const servers = D.q.all('SELECT * FROM servers WHERE enabled = 1');
    await Promise.all(servers.map(s => monitor.refresh(s)));
    ok(res, { servers: servers.map(s => ({ id: s.id, status: monitor.status(s) })) });
  },

  'POST /api/auth/register': async (req, res) => {
    /* вход и регистрация на сайте — только через Steam */
    return fail(res, 403, 'Регистрация доступна только через Steam');
  },

  'POST /api/auth/login': async (req, res) => {
    const ip = req.socket.remoteAddress || '?';
    if (tooManyAttempts(ip)) return fail(res, 429, 'Слишком много попыток. Подожди 10 минут.');
    const { login, pass } = await readBody(req);
    const l = String(login || '').trim();
    const u = await U.findByLoginOrEmail(l);
    if (!u || !(await U.verify(u, pass))) {
      noteFail(ip);
      D.audit(u?.id ?? null, l, 'login_fail', 'неверный пароль');
      return fail(res, 401, 'Неверный логин или пароль');
    }
    /* на сайт пускаем только через Steam; пароль оставлен для админки */
    if (!u.is_admin) {
      noteFail(ip);
      return fail(res, 403, 'Вход на сайт — только через Steam');
    }
    clearFails(ip);
    await U.touchLogin(u);

    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(24).toString('hex');
    D.q.run('INSERT INTO sessions (token, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)',
      token, u.id, csrf, D.now(), D.now() + SESSION_TTL);
    setSessionCookie(res, token, SESSION_TTL);
    D.audit(u.id, u.login, 'login', 'вход');
    ok(res, { user: publicUser(u), csrf });
  },

  'POST /api/auth/logout': async (req, res) => {
    const s = await getSession(req);
    if (s) D.q.run('DELETE FROM sessions WHERE token = ?', s.session.token);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    ok(res, { ok: true });
  },

  'GET /api/me': async (req, res) => {
    const s = await getSession(req);
    if (!s) return ok(res, { user: null });
    /* если Steam привязан, а аватар ещё не сохранён — подтягиваем из Steam */
    if (s.user.steam_id && !s.user.avatar) {
      try {
        const art = await Promise.race([
          steamArt(s.user.steam_id),
          new Promise(done => setTimeout(() => done(null), 2500))
        ]);
        if (art && art.avatar) {
          await U.setSteamProfile(s.user, { avatar: art.avatar });
          s.user.avatar = art.avatar;
        }
      } catch { /* без аватара */ }
    }
    ok(res, {
      user: publicUser(s.user),
      csrf: s.session.csrf,
      donations: D.q.all('SELECT * FROM donations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', s.user.id),
      orders: D.q.all(`SELECT o.*, s.title AS service_title FROM orders o
                       LEFT JOIN services s ON s.id = o.service_id
                       WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50`, s.user.id)
    });
  },

  /* привязка игрового аккаунта (SteamID) */
  'POST /api/me/steam': async (req, res, ctx) => {
    const { steam_id, game_login } = await readBody(req);
    const sid = String(steam_id || '').trim();
    const nick = String(game_login || '').trim().slice(0, 64);
    if (sid && !/^(STEAM_[0-5]:[01]:\d+|STEAM_0:X:\d+|[A-Z]:[0-9A-Z]{5})$/i.test(sid)) {
      return fail(res, 400, 'Похоже на SteamID? Ожидаем STEAM_0:1:12345678');
    }
    const r = await U.setLink(ctx.user, { steam_id: sid, game_login: nick });
    if (!r.ok) return fail(res, 409, r.error);
    D.audit(ctx.user.id, ctx.user.login, 'steam_link', sid + ' / ' + nick);
    ok(res, { steam_id: r.steam_id, game_login: r.game_login });
  },

  'POST /api/me/password': async (req, res, ctx) => {
    const { old, neu } = await readBody(req);
    if (!(await U.verify(ctx.user, old))) return fail(res, 400, 'Текущий пароль неверен');
    if (String(neu || '').length < 5) return fail(res, 400, 'Новый пароль минимум 5 символов');
    const r = await U.setPassword(ctx.user, neu);
    if (!r.ok) return fail(res, 400, r.error);
    D.audit(ctx.user.id, ctx.user.login, 'password_change', '');
    ok(res, { ok: true });
  },

  /* пополнение баланса */
  'POST /api/donate': async (req, res, ctx) => {
    const { amount, method, comment } = await readBody(req);
    const a = Math.round(Number(amount));
    if (!Number.isFinite(a) || a < 10 || a > 200000) return fail(res, 400, 'Сумма от 10 до 200 000 ₽');
    const m = ['card', 'sbp', 'usdt'].includes(method) ? method : 'card';
    const r = D.q.run(`INSERT INTO donations (user_id, login, amount, method, status, comment, created_at)
                      VALUES (?,?,?,?, 'pending', ?, ?)`,
      ctx.user.id, ctx.user.login, a, m, String(comment || '').slice(0, 300), D.now());
    D.audit(ctx.user.id, ctx.user.login, 'donation', `заявка на ${a} ₽ (${m})`);
    ok(res, { id: Number(r.lastInsertRowid) });
  },

  /* игрок нажал «я оплатил» — ждём подтверждения админа */
  'POST /api/donate/paid': async (req, res, ctx) => {
    const { id, note } = await readBody(req);
    const d = D.q.get('SELECT * FROM donations WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!d) return fail(res, 404, 'Заявка не найдена');
    if (d.status === 'paid') return fail(res, 400, 'Уже зачислено');
    D.q.run("UPDATE donations SET status = 'review', comment = ? WHERE id = ?",
      String(note || d.comment || '').slice(0, 300), d.id);
    D.audit(ctx.user.id, ctx.user.login, 'donation_paid_claim', '#' + d.id + ' на ' + d.amount + ' ₽');
    ok(res, { id: d.id, status: 'review' });
  },

  'POST /api/donate/pay': async (req, res, ctx) => {
    const { id } = await readBody(req);
    const d = D.q.get('SELECT * FROM donations WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!d) return fail(res, 404, 'Заявка не найдена');
    if (d.status === 'paid') return fail(res, 400, 'Уже оплачено');
    D.q.run(`UPDATE donations SET status = 'paid', paid_at = ? WHERE id = ?`, D.now(), d.id);
    const bal = await U.addBalance(ctx.user, d.amount);
    D.audit(ctx.user.id, ctx.user.login, 'donation_paid', `${d.amount} ₽ начислено`);
    ok(res, { balance: bal });
  },

  /* заказ услуги */
  'POST /api/me/orders': async (req, res, ctx) => {
    const { service_id } = await readBody(req);
    const svc = D.q.get('SELECT * FROM services WHERE id = ? AND enabled = 1', Number(service_id));
    if (!svc) return fail(res, 404, 'Услуга не найдена');
    const amount = svc.price;
    const curBal = await U.getBalance(ctx.user);
    if (curBal < amount) return fail(res, 400, 'Недостаточно средств на балансе');
    await U.addBalance(ctx.user, -amount);
    const r = D.q.run(`INSERT INTO orders (user_id, service_id, title, amount, status, created_at)
                       VALUES (?,?,?,?, 'new', ?)`,
      ctx.user.id, svc.id, svc.title, amount, D.now());
    D.audit(ctx.user.id, ctx.user.login, 'order', `${svc.title} за ${amount} ₽`);

    // автовыдача, если услуга это умеет и у игрока есть SteamID
    let issued = null;
    if (svc.auto_issue && (svc.server_cmd || issue.serverCfg().adminsPath) && ctx.user.steam_id) {
      issued = await issue.issueOrder(Number(r.lastInsertRowid));
    }
    ok(res, { id: Number(r.lastInsertRowid),
               balance: await U.getBalance(ctx.user),
               issued: issued ? (issued.ok ? issued.output : issued.error) : null });
  },

  /* ---------------- админ ---------------- */
  'GET /api/admin/overview': async (req, res) => {
    const users = await U.count();
    const admins = await U.countAdmins();
    const pending = D.q.get("SELECT COUNT(*) AS c FROM donations WHERE status = 'pending'").c;
    const paid = D.q.get("SELECT COALESCE(SUM(amount),0) AS s FROM donations WHERE status = 'paid'").s;
    const orders = D.q.get("SELECT COUNT(*) AS c FROM orders WHERE status = 'new'").c;
    const servers = D.q.all('SELECT * FROM servers ORDER BY sort, id')
      .map(s => ({ ...s, status: monitor.status(s) }));
    const online = servers.filter(s => s.status.online).length;
    const players = servers.reduce((a, s) => a + (s.status.players || 0), 0);
    ok(res, { users, admins, pending, paid, orders, servers, online, players });
  },

  'PUT /api/admin/settings': async (req, res, ctx) => {
    const { key, value } = await readBody(req);
    if (!key || typeof value !== 'object') return fail(res, 400, 'Некорректные данные');
    D.setSettings(key, value);
    D.audit(ctx.user.id, ctx.user.login, 'settings', key);
    ok(res, { ok: true, settings: D.allSettings() });
  },

  /* ---------------- управление сервером ---------------- */
  'GET /api/admin/server': async (req, res) => {
    const cfg = rconCfg();
    const servers = D.q.all('SELECT * FROM servers WHERE enabled = 1 ORDER BY sort, id')
      .map(s => ({ ...s, status: monitor.status(s) }));

    let players = [], playersError = '';
    if (servers[0]) {
      const p = await queryPlayers(servers[0].ip, servers[0].port);
      players = p.players || [];
      if (!p.ok) playersError = p.error || '';
    }

    let rconState = { ok: false, error: 'RCON не настроен', auth: false };
    if (cfg.host && cfg.port) {
      const c = await rcon.check(cfg);
      rconState = { ok: c.ok, error: c.error || '',
                    auth: /пароль принят|неверный RCON-пароль/.test(c.error || '') || c.ok };
    }

    ok(res, { servers, players, playersError, rcon: rconState, rconConfigured: !!(cfg.host && cfg.port) });
  },

  'GET /api/admin/rcon': (req, res) => {
    ok(res, { rcon: rconCfg() });
  },

  'PUT /api/admin/rcon': async (req, res, ctx) => {
    const { host, port, password } = await readBody(req);
    D.setSettings('rcon', {
      host: String(host || '').trim(),
      port: Number(port) || 0,
      password: String(password || '')
    });
    D.audit(ctx.user.id, ctx.user.login, 'rcon_settings', 'хост ' + host);
    ok(res, { ok: true });
  },

  'POST /api/admin/server/cmd': async (req, res, ctx) => {
    const { cmd } = await readBody(req);
    const c = String(cmd || '').trim();
    if (!c) return fail(res, 400, 'Пустая команда');
    if (c.length > 300) return fail(res, 400, 'Слишком длинная команда');
    const r = await rcon.exec(rconCfg(), c);
    D.audit(ctx.user.id, ctx.user.login, 'rcon', c);
    if (!r.ok) return fail(res, 502, r.error || 'RCON недоступен');
    ok(res, { output: r.output || '(пусто)' });
  },

  'POST /api/admin/server/action': async (req, res, ctx) => {
    const { action, steamid, name, reason, map, text } = await readBody(req);
    const cfg = rconCfg();
    let cmd = '';

    switch (action) {
      case 'kick': {
        const who = String(steamid || name || '').trim();
        if (!who) return fail(res, 400, 'Укажи SteamID или ник');
        cmd = 'kick "' + who.replace(/"/g, '') + '" ' + String(reason || 'AFK').replace(/"/g, '');
        break;
      }
      case 'ban': {
        const who = String(steamid || name || '').trim();
        if (!who) return fail(res, 400, 'Укажи SteamID или ник');
        cmd = 'ban_add "' + who.replace(/"/g, '') + '" ' + String(reason || 'AFK').replace(/"/g, '');
        break;
      }
      case 'unban': {
        const who = String(steamid || name || '').trim();
        if (!who) return fail(res, 400, 'Укажи SteamID или ник');
        cmd = 'ban_remove ' + who + ' banid';
        break;
      }
      case 'map': {
        const m = String(map || '').trim();
        if (!m) return fail(res, 400, 'Укажи карту');
        cmd = 'changelevel ' + m;
        break;
      }
      case 'say': {
        const t = String(text || '').trim();
        if (!t) return fail(res, 400, 'Пустое сообщение');
        cmd = 'say ' + t;
        break;
      }
      case 'restart': cmd = 'restart'; break;
      default: return fail(res, 400, 'Неизвестное действие');
    }

    const r = await rcon.exec(cfg, cmd);
    D.audit(ctx.user.id, ctx.user.login, 'rcon_action', action + ': ' + cmd);
    if (!r.ok) return fail(res, 502, r.error || 'RCON недоступен');
    ok(res, { cmd, output: r.output || '(ок)' });
  },

  /* ---------------- выдача прав на сервере ---------------- */
  'POST /api/admin/orders/issue': async (req, res, ctx) => {
    const { id } = await readBody(req);
    const r = await issue.issueOrder(Number(id));
    D.audit(ctx.user.id, ctx.user.login, 'issue_order', '#' + id + ' -> ' + (r.output || r.error));
    if (!r.ok) return fail(res, 400, r.error);
    ok(res, { output: r.output || '(ок)' });
  },

  'POST /api/admin/orders/revoke': async (req, res, ctx) => {
    const { id } = await readBody(req);
    const r = await issue.revokeOrder(Number(id));
    D.audit(ctx.user.id, ctx.user.login, 'revoke_order', '#' + id);
    if (!r.ok) return fail(res, 400, r.error);
    ok(res, { output: r.output || '(ок)' });
  },

  'GET /api/admin/servercfg': (req, res) => {
    ok(res, { cfg: issue.serverCfg(), rcon: issue.rconCfg(), agent: issue.AGENT() });
  },

  'POST /api/admin/agent/test': async (req, res, ctx) => {
    const { url, token } = await readBody(req);
    try {
      const r = await fetch(String(url).replace(/\/$/, '') + '/ping', {
        headers: { 'x-agent-token': token || '' },
        signal: AbortSignal.timeout(6000)
      });
      const j = await r.json().catch(() => ({}));
      ok(res, { ok: !!r.ok, reply: j });
    } catch (e) {
      fail(res, 502, 'агент недоступен: ' + e.message);
    }
  },

  'PUT /api/admin/servercfg': async (req, res, ctx) => {
    const { admins_path, vip_cmd } = await readBody(req);
    D.setSettings('server', {
      admins_path: String(admins_path || '').trim(),
      vip_cmd: String(vip_cmd || '').trim()
    });
    D.audit(ctx.user.id, ctx.user.login, 'servercfg', 'путь ' + admins_path);
    ok(res, { ok: true });
  },

  /* ---------------- VIP-база ---------------- */
  'GET /api/admin/vipdb': (req, res) => {
    ok(res, { cfg: vipdb.cfg(), info: vipdb.inspect() });
  },

  'PUT /api/admin/vipdb': async (req, res, ctx) => {
    const c = await readBody(req);
    vipdb.saveCfg(c);
    D.audit(ctx.user.id, ctx.user.login, 'vipdb', c.file || '');
    ok(res, { cfg: vipdb.cfg(), info: vipdb.inspect() });
  },

  'GET /api/admin/vipdb/list': (req, res) => {
    ok(res, vipdb.listVip(200));
  },

  /* ---------------- внешняя база пользователей (MySQL) ---------------- */
  'GET /api/admin/usersdb': async (req, res) => {
    const c = U.cfg();
    const st = await U.structure();
    const tt = await U.test();
    ok(res, {
      cfg: { ...c, password: c.password ? '••••••' : '' },
      hasPassword: !!c.password,
      structure: st, test: tt
    });
  },

  'POST /api/admin/usersdb/save': async (req, res, ctx) => {
    const b = await readBody(req);
    const cur = U.cfg();
    const next = {
      mode: ['local', 'mysql', 'bridge'].includes(b.mode) ? b.mode : cur.mode,
      host: String(b.host ?? cur.host).trim(),
      port: Number(b.port ?? cur.port) || 3306,
      user: String(b.user ?? cur.user).trim(),
      password: b.password === undefined || b.password === '••••••' ? cur.password : String(b.password),
      database: String(b.database ?? cur.database).trim(),
      table: (String(b.table ?? cur.table).replace(/[^\w]/g, '').slice(0, 64)) || 'flux_users',
      url: String(b.url ?? cur.url).trim(),
      token: String(b.token ?? cur.token),
      sync_name: !!b.sync_name
    };
    U.setCfg(next);
    U.resetCache();
    D.audit(ctx.user.id, ctx.user.login, 'usersdb', 'источник базы: ' + next.mode + ' / ' + next.table);
    const tt = await U.test();
    ok(res, { ok: true, cfg: { ...next, password: next.password ? '••••••' : '' }, test: tt });
  },

  'POST /api/admin/usersdb/test': async (req, res) => {
    ok(res, await U.test());
  },

  'POST /api/admin/usersdb/structure': async (req, res) => {
    ok(res, await U.structure());
  },

  'GET /api/admin/users': async (req, res) => {
    ok(res, { users: await U.list() });
  },

  /* привязка игрового аккаунта (ник в CS:GO / SteamID) */
  'POST /api/admin/users/link': async (req, res, ctx) => {
    const { id, game_login, steam_id } = await readBody(req);
    const u = await U.findById(Number(id));
    if (!u) return fail(res, 404, 'Пользователь не найден');
    const r = await U.setLink(u, { game_login, steam_id });
    if (!r.ok) return fail(res, 409, r.error);
    D.audit(ctx.user.id, ctx.user.login, 'user_link', `${u.login} -> ${r.game_login || r.steam_id}`);
    ok(res, { game_login: r.game_login, steam_id: r.steam_id });
  },

  /* массовый импорт/обновление пользователей из CSV */
  'POST /api/admin/users/import': async (req, res, ctx) => {
    const { csv } = await readBody(req, 512 * 1024);
    const r = await U.importCsv(csv);
    D.audit(ctx.user.id, ctx.user.login, 'users_import', `добавлено ${r.added}, обновлено ${r.updated}`);
    ok(res, r);
  },

  /* выгрузка пользователей в CSV (для правки в Excel и обратной загрузки) */
  'GET /api/admin/users/export': async (req, res) => {
    const csv = await U.exportCsv();
    send(res, 200, csv, 'text/csv; charset=utf-8', {
      'Content-Disposition': 'attachment; filename="users.csv"'
    });
  },

  'GET /api/admin/roles': async (req, res) => {
    ok(res, { roles: await U.listRoles() });
  },

  /* выдать/снять роли пользователю (хранятся в flux_user_roles) */
  /* перенос локального аккаунта в flux_users (с ролью) */
  'POST /api/admin/users/migrate': async (req, res, ctx) => {
    const { id, pass } = await readBody(req);
    const u = await U.findById(Number(id));
    if (!u) return fail(res, 404, 'Пользователь не найден');
    const r = await U.migrateLocal(u, pass);
    if (!r.ok) return fail(res, 400, r.error);
    D.audit(ctx.user.id, ctx.user.login, 'user_migrate', `${u.login} -> flux_users`);
    ok(res, { ok: true, ext_id: r.ext_id });
  },

  'POST /api/admin/users/roles': async (req, res, ctx) => {
    const { id, roles } = await readBody(req);
    const u = await U.findById(Number(id));
    if (!u) return fail(res, 404, 'Пользователь не найден');
    const r = await U.setUserRoles(u, roles);
    if (!r.ok) return fail(res, 400, r.error);
    D.audit(ctx.user.id, ctx.user.login, 'user_roles', `${u.login}: ${r.roles.join(', ')}`);
    ok(res, { roles: r.roles });
  },

  'POST /api/admin/users/role': async (req, res, ctx) => {
    const { id, is_admin, game_admin } = await readBody(req);
    const u = await U.findById(Number(id));
    if (!u) return fail(res, 404, 'Пользователь не найден');
    const adm = is_admin === undefined ? u.is_admin : (is_admin ? 1 : 0);
    const ga = game_admin === undefined ? u.game_admin : (game_admin ? 1 : 0);
    await U.setRole(u, { is_admin: adm, game_admin: ga });
    D.audit(ctx.user.id, ctx.user.login, 'user_role', `${u.login}: админ=${adm} игровая админка=${ga}`);
    ok(res, { ok: true });
  },

  'POST /api/admin/users/balance': async (req, res, ctx) => {
    const { id, delta, note } = await readBody(req);
    const u = await U.findById(Number(id));
    if (!u) return fail(res, 404, 'Пользователь не найден');
    const d = Math.round(Number(delta));
    if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 1000000) return fail(res, 400, 'Сумма от 1 до 1 000 000');
    const bal = await U.addBalance(u, d);
    await U.setNotes(u, String(note || u.notes).slice(0, 300));
    D.audit(ctx.user.id, ctx.user.login, 'balance', `${u.login}: ${d > 0 ? '+' : ''}${d} ₽`);
    ok(res, { balance: bal });
  },

  'POST /api/admin/users/password': async (req, res, ctx) => {
    const { id, pass } = await readBody(req);
    const u = await U.findById(Number(id));
    if (!u) return fail(res, 404, 'Пользователь не найден');
    const p = String(pass || '');
    if (p.length < 5) return fail(res, 400, 'Пароль минимум 5 символов');
    const r = await U.setPassword(u, p);
    if (!r.ok) return fail(res, 400, r.error);
    D.audit(ctx.user.id, ctx.user.login, 'user_password', u.login);
    ok(res, { ok: true });
  },

  'GET /api/admin/donations': (req, res) => {
    ok(res, { donations: D.q.all('SELECT * FROM donations ORDER BY created_at DESC LIMIT 200') });
  },

  'POST /api/admin/donations/status': async (req, res, ctx) => {
    const { id, status } = await readBody(req);
    const d = D.q.get('SELECT * FROM donations WHERE id = ?', Number(id));
    if (!d) return fail(res, 404, 'Заявка не найдена');
    const st = ['pending', 'paid', 'rejected'].includes(status) ? status : 'pending';
    D.q.run('UPDATE donations SET status = ?, paid_at = ? WHERE id = ?', st, st === 'paid' ? D.now() : 0, d.id);
    if (st === 'paid' && d.status !== 'paid' && d.user_id) {
      D.q.run('UPDATE users SET balance = balance + ? WHERE id = ?', d.amount, d.user_id);
      D.audit(ctx.user.id, ctx.user.login, 'balance_topup', `${d.login}: +${d.amount} ₽`);
    }
    D.audit(ctx.user.id, ctx.user.login, 'donation_status', `#${d.id} -> ${st}`);
    ok(res, { ok: true });
  },

  'GET /api/admin/orders': (req, res) => {
    ok(res, { orders: D.q.all(`SELECT o.*, u.login, u.steam_id, u.game_login FROM orders o
                               LEFT JOIN users u ON u.id = o.user_id
                               ORDER BY o.created_at DESC LIMIT 200`) });
  },

  'POST /api/admin/orders/complete': async (req, res, ctx) => {
    const { id, game_admin } = await readBody(req);
    const o = D.q.get('SELECT * FROM orders WHERE id = ?', Number(id));
    if (!o) return fail(res, 404, 'Заказ не найден');
    D.q.run("UPDATE orders SET status = 'done', done_at = ? WHERE id = ?", D.now(), o.id);
    if (game_admin) {
      const u = await U.findById(o.user_id);
      if (u) await U.setRole(u, { game_admin: 1 });
    }
    D.audit(ctx.user.id, ctx.user.login, 'order_done', `#${o.id} ${o.title}`);
    ok(res, { ok: true });
  },

  'GET /api/admin/services': (req, res) => {
    ok(res, { services: D.q.all('SELECT * FROM services ORDER BY sort, id')
      .map(s => ({ ...s, title: D.parseJson(s.title, { ru: s.title, en: s.title }),
                   subtitle: D.parseJson(s.subtitle, { ru: s.subtitle, en: s.subtitle }),
                   features: D.parseJson(s.features, { ru: s.features, en: s.features }) })) });
  },

  'POST /api/admin/services/save': async (req, res, ctx) => {
    const s = await readBody(req);
    const id = Number(s.id) || 0;
    const tr = v => JSON.stringify({ ru: String(v?.ru ?? v ?? ''), en: String(v?.en ?? v?.ru ?? '') });
    const title = String(s.title?.ru || s.title || '').trim();
    if (!title) return fail(res, 400, 'Нужно название');
    const price = Math.max(0, Math.round(Number(s.price) || 0));
    const fields = [
      tr({ ru: title, en: s.title?.en || title }),
      tr(s.subtitle || { ru: '', en: '' }),
      price,
      Math.max(0, Math.round(Number(s.period_days) || 0)),
      tr(s.features || { ru: '', en: '' }),
      String(s.badge || ''),
      String(s.game || 'flux'),
      s.enabled === false ? 0 : 1,
      Math.round(Number(s.sort) || 0)
    ];
    if (id) {
      D.q.run(`UPDATE services SET title=?, subtitle=?, price=?, period_days=?, features=?, badge=?, game=?, enabled=?, sort=? WHERE id=?`,
        ...fields, id);
    } else {
      D.q.run(`INSERT INTO services (title, subtitle, price, period_days, features, badge, game, enabled, sort)
               VALUES (?,?,?,?,?,?,?,?,?)`, ...fields);
    }
    D.audit(ctx.user.id, ctx.user.login, 'service_save', title);
    ok(res, { services: D.q.all('SELECT * FROM services ORDER BY sort, id') });
  },

  'POST /api/admin/services/delete': async (req, res, ctx) => {
    const { id } = await readBody(req);
    D.q.run('DELETE FROM services WHERE id = ?', Number(id));
    D.audit(ctx.user.id, ctx.user.login, 'service_delete', String(id));
    ok(res, { services: D.q.all('SELECT * FROM services ORDER BY sort, id') });
  },

  'GET /api/admin/servers': (req, res) => {
    ok(res, { servers: D.q.all('SELECT * FROM servers ORDER BY sort, id').map(s => ({ ...s, status: monitor.status(s) })) });
  },

  'POST /api/admin/servers/save': async (req, res, ctx) => {
    const s = await readBody(req);
    const id = Number(s.id) || 0;
    const name = String(s.name || '').trim();
    const ip = String(s.ip || '').trim();
    const port = Math.round(Number(s.port) || 0);
    if (!name) return fail(res, 400, 'Нужно название');
    if (!ip || port < 1 || port > 65535) return fail(res, 400, 'Нужны IP и порт (1–65535)');
    const loc = String(s.location || '');
    const game = String(s.game || 'flux');
    const lim = Math.max(0, Math.round(Number(s.players_limit) || 0));
    const en = s.enabled === false ? 0 : 1;
    const sort = Math.round(Number(s.sort) || 0);
    if (id) {
      D.q.run('UPDATE servers SET name=?, ip=?, port=?, location=?, game=?, players_limit=?, enabled=?, sort=? WHERE id=?',
        name, ip, port, loc, game, lim, en, sort, id);
    } else {
      D.q.run('INSERT INTO servers (name, ip, port, location, game, players_limit, enabled, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        name, ip, port, loc, game, lim, en, sort, D.now());
    }
    D.audit(ctx.user.id, ctx.user.login, 'server_save', `${name} ${ip}:${port}`);
    const srv = D.q.all('SELECT * FROM servers ORDER BY sort, id');
    await Promise.all(srv.filter(x => x.enabled).map(x => monitor.refresh(x)));
    ok(res, { servers: srv.map(s2 => ({ ...s2, status: monitor.status(s2) })) });
  },

  'POST /api/admin/servers/delete': async (req, res, ctx) => {
    const { id } = await readBody(req);
    D.q.run('DELETE FROM servers WHERE id = ?', Number(id));
    D.audit(ctx.user.id, ctx.user.login, 'server_delete', String(id));
    ok(res, { servers: D.q.all('SELECT * FROM servers ORDER BY sort, id') });
  },

  'GET /api/admin/news': (req, res) => {
    ok(res, { news: D.q.all('SELECT * FROM news ORDER BY created_at DESC')
      .map(n => ({ ...n, title: D.parseJson(n.title, { ru: n.title, en: n.title }),
                   body: D.parseJson(n.body, { ru: n.body, en: n.body }),
                   tag: D.parseJson(n.tag, { ru: n.tag, en: n.tag }) })) });
  },

  'POST /api/admin/news/save': async (req, res, ctx) => {
    const n = await readBody(req);
    const id = Number(n.id) || 0;
    const tr = v => JSON.stringify({ ru: String(v?.ru ?? v ?? ''), en: String(v?.en ?? v?.ru ?? '') });
    const title = String(n.title?.ru || n.title || '').trim();
    if (!title) return fail(res, 400, 'Нужно заголовок');
    const body = tr(n.body || { ru: '', en: '' });
    const tag = tr(n.tag || { ru: '', en: '' });
    const pub = n.published === false ? 0 : 1;
    if (id) D.q.run('UPDATE news SET title=?, body=?, tag=?, published=? WHERE id=?', tr({ ru: title, en: n.title?.en || title }), body, tag, pub, id);
    else D.q.run('INSERT INTO news (title, body, tag, published, created_at) VALUES (?,?,?,?,?)',
      tr({ ru: title, en: n.title?.en || title }), body, tag, pub, D.now());
    D.audit(ctx.user.id, ctx.user.login, 'news_save', title);
    ok(res, { news: D.q.all('SELECT * FROM news ORDER BY created_at DESC') });
  },

  'POST /api/admin/news/delete': async (req, res, ctx) => {
    const { id } = await readBody(req);
    D.q.run('DELETE FROM news WHERE id = ?', Number(id));
    D.audit(ctx.user.id, ctx.user.login, 'news_delete', String(id));
    ok(res, { news: D.q.all('SELECT * FROM news ORDER BY created_at DESC') });
  },

  /* ---- виджеты ---- */
  'GET /api/admin/widgets': (req, res) => {
    ok(res, { widgets: D.allWidgets() });
  },

  'POST /api/admin/widgets/save': async (req, res, ctx) => {
    const w = await readBody(req);
    const id = Number(w.id) || 0;
    const type = String(w.type || 'text');
    const title = JSON.stringify({ ru: String(w.title?.ru ?? ''), en: String(w.title?.en ?? '') });
    const body = JSON.stringify({ ru: String(w.body?.ru ?? ''), en: String(w.body?.en ?? '') });
    const position = String(w.position || 'main');
    const en = w.enabled === false ? 0 : 1;
    const sort = Math.round(Number(w.sort) || 0);
    const data = JSON.stringify(w.data && typeof w.data === 'object' ? w.data : {});
    if (id) {
      D.q.run('UPDATE widgets SET type=?, title=?, body=?, position=?, enabled=?, sort=?, data=? WHERE id=?',
        type, title, body, position, en, sort, data, id);
    } else {
      D.q.run('INSERT INTO widgets (type, title, body, position, enabled, sort, data, created_at) VALUES (?,?,?,?,?,?,?,?)',
        type, title, body, position, en, sort, data, D.now());
    }
    D.audit(ctx.user.id, ctx.user.login, 'widget_save', `${type} @${position}`);
    ok(res, { widgets: D.allWidgets() });
  },

  'POST /api/admin/widgets/delete': async (req, res, ctx) => {
    const { id } = await readBody(req);
    D.q.run('DELETE FROM widgets WHERE id = ?', Number(id));
    D.audit(ctx.user.id, ctx.user.login, 'widget_delete', String(id));
    ok(res, { widgets: D.allWidgets() });
  },

  'POST /api/admin/widgets/reorder': async (req, res, ctx) => {
    const { order } = await readBody(req);
    if (!Array.isArray(order)) return fail(res, 400, 'Нужен массив id');
    order.forEach((id, i) => D.q.run('UPDATE widgets SET sort = ? WHERE id = ?', i, Number(id)));
    D.audit(ctx.user.id, ctx.user.login, 'widget_reorder', order.join(','));
    ok(res, { widgets: D.allWidgets() });
  },

  'GET /api/admin/audit': (req, res) => {
    ok(res, { log: D.q.all('SELECT * FROM audit ORDER BY ts DESC LIMIT 300') });
  }
};

/* ---------- статика ---------- */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  // страницы профиля и списков игроков рендерятся тем же index.html
  if (/^\/(?:profiles\/\d{17}\/?|profile\/?|players(?:\/(?:vip|banned|muted))?\/?)$/.test(rel)) rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA-подобный фолбэк на 404
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (e2) return fail(res, 404, 'not found');
        send(res, 404, idx, 'text/html; charset=utf-8');
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const extra = ext === '.html'
      ? { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' }
      : {};
    send(res, 200, data, MIME[ext] || 'application/octet-stream', extra);
  });
}

/* ---------- роутинг ---------- */
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  let method = req.method.toUpperCase();
  if (method === 'HEAD') method = 'GET';   // HEAD отвечает как GET, но без тела

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': 'null' });
    return res.end();
  }

  if (url.startsWith('/api/')) {
    const key = method + ' ' + url.split('?')[0];
    const handler = api[key];
    if (!handler) return fail(res, 404, 'нет такого метода: ' + key);

    const sess = await getSession(req);
    const needsAuth = !['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout',
      'GET /api/site', 'GET /api/servers', 'GET /api/servers/refresh', 'GET /api/stats',
      'GET /api/me', 'GET /api/widget', 'GET /api/game/bans', 'GET /api/game/mutes',
      'GET /api/game/vip', 'GET /api/game/profile'].includes(key);
    const needsAdmin = key.startsWith('GET /api/admin/') || key.includes('/api/admin/');

    if (needsAuth && !sess) return fail(res, 401, 'Нужно войти');
    if (needsAdmin && (!sess || !sess.user.is_admin)) return fail(res, 403, 'Доступ только для админа');

    const isMutation = method !== 'GET';
    if (isMutation && sess && !['POST /api/auth/login', 'POST /api/auth/register'].includes(key)) {
      if (!checkCsrf(req, sess)) return fail(res, 403, 'CSRF-токен не совпал, обнови страницу');
    }

    try {
      const u = new URL(url, 'http://localhost');
      await handler(req, res, { session: sess?.session, user: sess?.user, query: u.searchParams, url: u });
    } catch (e) {
      console.error('API error', key, e);
      if (!res.headersSent) fail(res, 500, 'внутренняя ошибка: ' + e.message);
    }
    return;
  }

  const pathOnly = url.split('?')[0];
  if (pathOnly === '/auth/steam') return redirect(res, steamLoginUrl(req));
  if (pathOnly === '/auth/steam/callback') return handleSteamCallback(req, res);

  serveStatic(req, res, url);
});


/* =========================================================
   Steam OpenID 2.0 — вход через Steam
   ========================================================= */
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

/* базовый адрес портала: настройка из админки, иначе из запроса */
function publicBase(req) {
  const envBase = String(process.env.PUBLIC_URL || '').trim();
  if (envBase) return envBase.replace(/\/+$/, '');

  let cfgBase = '';
  try {
    const a = D.getSettings('auth');
    cfgBase = String((a && a.base_url) || '').trim();
  } catch { /* нет настроек */ }
  if (cfgBase) return cfgBase.replace(/\/+$/, '');

  const proto = String(req.headers['x-forwarded-proto'] || 'http')
    .split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || (HOST + ':' + PORT))
    .split(',')[0].trim();
  return proto + '://' + host;
}

function steamLoginUrl(req) {
  const base = publicBase(req);
  const qs = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': base + '/auth/steam/callback',
    'openid.realm': base + '/',
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  });
  return STEAM_OPENID + '?' + qs.toString();
}

/* проверка подписи у Steam: возвращает steamid64 или null */
async function verifySteam(query) {
  if (query.get('openid.mode') !== 'id_res') return null;

  const check = new URLSearchParams();
  for (const [k, v] of query) check.append(k, v);
  check.set('openid.mode', 'check_authentication');

  const r = await fetch(STEAM_OPENID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: check.toString()
  });
  const text = await r.text();
  if (!/is_valid\s*:\s*true/i.test(text)) return null;

  const claimed = query.get('openid.claimed_id') || '';
  const m = claimed.match(/\/(?:id|profiles)\/(\d{17})\s*$/);
  return m ? m[1] : null;
}

/* ник и аватар из публичного профиля (без API-ключа) */
async function steamProfile(sid) {
  try {
    const r = await fetch('https://steamcommunity.com/profiles/' + sid + '/?xml=1', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; flux-hvh portal)' }
    });
    if (!r.ok) return null;
    const xml = await r.text();
    const pick = re => { const m = xml.match(re); return m ? m[1].trim() : ''; };
    return {
      name: pick(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/),
      avatar: pick(/<avatarMedium><!\[CDATA\[([\s\S]*?)\]\]><\/avatarMedium>/)
    };
  } catch { return null; }
}

/* аватар и фон профиля Steam (кэш 10 минут) */
const steamArtCache = new Map();
async function steamArt(sid) {
  const key = String(sid || '');
  if (!/^\d{17}$/.test(key)) return { avatar: '', background: '' };

  const hit = steamArtCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
  let avatar = '', background = '', persona = '';

  try {
    const r = await fetch('https://steamcommunity.com/profiles/' + key + '/?xml=1', {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000)
    });
    if (r.ok) {
      const t = await r.text();
      const pick = re => { const m = t.match(re); return m ? m[1].trim() : ''; };
      persona = pick(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/);
      avatar = pick(/<avatarFull><!\[CDATA\[([\s\S]*?)\]\]><\/avatarFull>/) ||
        pick(/<avatarMedium><!\[CDATA\[([\s\S]*?)\]\]><\/avatarMedium>/);
    }
  } catch { /* Steam мог не ответить */ }

  try {
    const r = await fetch('https://steamcommunity.com/profiles/' + key + '/?l=english', {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000)
    });
    if (r.ok) {
      const t = await r.text();
      const m = t.match(/background-image:\s*url\(\s*'([^']+)'\s*\)/) ||
        t.match(/"profile_background_image_url":"([^"]*)"/);
      if (m) background = m[1].replace(/\\\//g, '/');
    }
  } catch { /* фон необязателен */ }

  const data = { avatar, background, persona };
  steamArtCache.set(key, { at: Date.now(), data });
  if (steamArtCache.size > 400) {
    const first = steamArtCache.keys().next().value;
    steamArtCache.delete(first);
  }
  return data;
}

/* ник из Steam -> безопасный логин портала */
function steamLogin(raw) {
  let l = String(raw || '').replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (l.length < 3) l = 'steam_' + (l || 'player');
  return l.slice(0, 20);
}

async function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  D.q.run('INSERT INTO sessions (token, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)',
    token, user.id, csrf, D.now(), D.now() + SESSION_TTL);
  setSessionCookie(res, token, SESSION_TTL);
  return csrf;
}

async function handleSteamCallback(req, res) {
  const u = new URL(req.url, 'http://localhost');
  let sid = null;
  try {
    sid = await verifySteam(u.searchParams);
  } catch (e) {
    console.error('steam verify:', e.message);
  }
  if (!sid) return redirect(res, '/?steam=invalid');

  /* ник, аватар и фон Steam — из публичного профиля (кэш 10 минут) */
  let art = { avatar: '', background: '', persona: '' };
  try { art = await steamArt(sid); } catch { /* без данных Steam */ }
  const ip = req.socket.remoteAddress || '';

  /* если уже вошёл — не входим заново, а привязываем Steam к аккаунту */
  const current = await getSession(req);
  if (current) {
    if (String(current.user.steam_id || '') === sid) {
      await U.setSteamProfile(current.user, { avatar: art.avatar, persona: art.persona });
      await U.steamRemember({
        steam_id: sid, steam64: sid, persona: art.persona || current.user.game_login || current.user.login,
        avatar: art.avatar, background: art.background, login: current.user.login,
        user_id: current.user.id, ip
      });
      return redirect(res, '/?steam=linked');
    }
    const busy = await U.findBySteam(sid);
    if (busy && busy.id !== current.user.id) return redirect(res, '/?steam=taken');
    const linked = await U.setLink(current.user, { steam_id: sid });
    if (!linked.ok) return redirect(res, '/?steam=taken');
    await U.setSteamProfile(current.user, { avatar: art.avatar, persona: art.persona });
    await U.steamRemember({
      steam_id: sid, steam64: sid, persona: art.persona || current.user.game_login || current.user.login,
      avatar: art.avatar, background: art.background, login: current.user.login,
      user_id: current.user.id, ip
    });
    D.audit(current.user.id, current.user.login, 'steam_link', sid);
    return redirect(res, '/?steam=linked');
  }

  try {
    let user = await U.findBySteam(sid);
    let prof = null;

    if (!user) {
      try { prof = await steamProfile(sid); } catch { /* ник необязателен */ }
      const persona = art.persona || (prof && prof.name) || '';
      const base = persona ? steamLogin(persona) : ('steam_' + sid.slice(-8));
      let login = base;
      let i = 2;
      while (await U.findByLogin(login)) {
        login = (base.slice(0, 15) + '_' + i).slice(0, 20);
        if (++i > 60) { login = 'steam_' + sid.slice(-10); break; }
      }
      const pass = crypto.randomBytes(24).toString('hex');
      const created = await U.create({
        login,
        email: sid + '@steam.local',
        pass,
        steam_id: sid,
        game_login: persona || login
      });
      if (!created.ok) {
        console.error('steam create:', created.error);
        return redirect(res, '/?steam=error');
      }
      user = await U.findById(created.id);
    }

    if (!user) return redirect(res, '/?steam=error');

    if (user.is_banned) return redirect(res, '/?steam=banned');

    /* сохраняем аватар/ник в профиль и в flux_steam */
    await U.setSteamProfile(user, {
      avatar: art.avatar || (prof && prof.avatar) || '',
      persona: art.persona || (prof && prof.name) || ''
    });
    await U.steamRemember({
      steam_id: sid, steam64: sid,
      persona: art.persona || (prof && prof.name) || user.game_login || user.login,
      avatar: art.avatar || (prof && prof.avatar) || '',
      background: art.background, login: user.login, user_id: user.id, ip
    });

    await U.touchLogin(user);
    await startSession(res, user);
    D.audit(user.id, user.login, 'login', 'вход через Steam');
    redirect(res, '/?steam=ok');
  } catch (e) {
    console.error('steam login:', e);
    redirect(res, '/?steam=error');
  }
}

/* таблица аккаунтов Steam — создаём при старте (локально + во внешней MySQL) */
U.ensureSteamTable()
  .then(ok => { if (ok) console.log('flux_steam: таблица готова'); })
  .catch(e => console.error('flux_steam:', e.message));

server.listen(PORT, HOST, () => {
  console.log(`Портал: http://${HOST}:${PORT}/`);
  console.log(`Админка: http://${HOST}:${PORT}/admin  (логин admin, пароль admin)`);
});

process.on('SIGINT', () => { monitor.stop(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { monitor.stop(); server.close(() => process.exit(0)); });
