'use strict';
/* =========================================================
   База данных портала: схема, сид, запросы.
   node:sqlite — без внешних зависимостей, база = data/portal.db
   Весь редактируемый контент двуязычный: { ru, en }.
   ========================================================= */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  login       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL DEFAULT '',
  game_login  TEXT NOT NULL DEFAULT '',
  steam_id    TEXT NOT NULL DEFAULT '',
  avatar      TEXT NOT NULL DEFAULT '',
  persona     TEXT NOT NULL DEFAULT '',
  pass_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  balance     INTEGER NOT NULL DEFAULT 0,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  game_admin  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_login  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flux_steam (
  steam_id   TEXT PRIMARY KEY,
  steam64    TEXT NOT NULL DEFAULT '',
  persona    TEXT NOT NULL DEFAULT '',
  avatar     TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  login      TEXT NOT NULL DEFAULT '',
  user_id    INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL DEFAULT 0,
  last_login INTEGER NOT NULL DEFAULT 0,
  last_ip    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS widgets (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  type     TEXT NOT NULL DEFAULT 'text',
  title    TEXT NOT NULL DEFAULT '{"ru":"","en":""}',
  body     TEXT NOT NULL DEFAULT '{"ru":"","en":""}',
  position TEXT NOT NULL DEFAULT 'main',
  enabled  INTEGER NOT NULL DEFAULT 1,
  sort     INTEGER NOT NULL DEFAULT 0,
  data     TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  subtitle    TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 0,
  period_days INTEGER NOT NULL DEFAULT 30,
  features    TEXT NOT NULL DEFAULT '',
  badge       TEXT NOT NULL DEFAULT '',
  game        TEXT NOT NULL DEFAULT 'flux',
  server_cmd  TEXT NOT NULL DEFAULT '',
  auto_issue  INTEGER NOT NULL DEFAULT 1,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS servers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  ip         TEXT NOT NULL,
  port       INTEGER NOT NULL,
  location   TEXT NOT NULL DEFAULT '',
  game       TEXT NOT NULL DEFAULT 'flux',
  players_limit INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  online      INTEGER NOT NULL DEFAULT 0,
  players     INTEGER NOT NULL DEFAULT 0,
  max_players INTEGER NOT NULL DEFAULT 0,
  map         TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  ping        INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_stats_server_ts ON server_stats(server_id, ts);

CREATE TABLE IF NOT EXISTS donations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  login      TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL,
  method     TEXT NOT NULL DEFAULT 'card',
  status     TEXT NOT NULL DEFAULT 'pending',
  comment    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  paid_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  done_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS news (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  tag        TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  published  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  login   TEXT NOT NULL DEFAULT '',
  action  TEXT NOT NULL,
  meta    TEXT NOT NULL DEFAULT '',
  ts      INTEGER NOT NULL
);
`);

/* ---------- утилиты ---------- */
const now = () => Date.now();
const q = {
  all: (sql, ...args) => db.prepare(sql).all(...args),
  get: (sql, ...args) => db.prepare(sql).get(...args),
  run: (sql, ...args) => db.prepare(sql).run(...args)
};

function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pass), salt, 64).toString('hex') };
}
function checkPass(pass, salt, hash) {
  try {
    const a = crypto.scryptSync(String(pass), salt, 64);
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/* ---------- миграции: добавить колонки, если их нет ---------- */
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    console.log(`миграция: ${table}.${col} добавлена`);
  }
}
ensureColumn('services', 'server_cmd', "TEXT NOT NULL DEFAULT ''");
ensureColumn('services', 'auto_issue', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'email', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'game_login', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'steam_id', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'avatar', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'persona', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'ext_id', "INTEGER NOT NULL DEFAULT 0");   // id во внешней базе
ensureColumn('users', 'auth_src', "TEXT NOT NULL DEFAULT 'local'"); // local | mysql

/* ---------- двуязычный контент ---------- */
const L = (ru, en) => ({ ru, en });

const DEFAULT_SETTINGS = {
  site: {
    title: L('FLUX HvH', 'FLUX HvH'),
    tagline: L('ONLY SCOUT · MIRAGE · Roll Fix', 'ONLY SCOUT · MIRAGE · Roll Fix'),
    lead: L('FLUX HvH — известная команда HvH-серверов для CS:GO. Только scout, только mirage, roll fix и честный разбор. Покупай админку, VIP и игровые рубли — выдаём за пять минут.',
           'FLUX HvH is a well-known HvH server team for CS:GO. Scout only, mirage only, roll fix and honest matchmaking. Buy admin, VIP and in-game rubles — delivered within five minutes.'),
    cta_text: L('Купить админку', 'Buy admin'),
    cta2_text: L('Подключиться к серверу', 'Join the server'),
    telegram: L('https://t.me/', 'https://t.me/'),
    discord: L('https://discord.gg/', 'https://discord.gg/'),
    email: L('support@example.com', 'support@example.com'),
    accent: L('НАБОР ОТКРЫТ', 'REGISTRATION OPEN'),
    stats: [
      { value: L('24/7', '24/7'), label: L('серверы онлайн', 'servers online') }
    ]
  },
  auth: {
    /* внешний адрес портала для Steam OpenID (пусто = из запроса) */
    base_url: ''
  },
  flux: {
    title: L('Про FLUX HvH', 'About FLUX HvH'),
    body: L('FLUX HvH — команда HvH-серверов для CS:GO. Работаем только в scout: арена 1x1 и 2x2 на mirage, roll fix, чтобы разброс не ломал разбор.\n\nСервер подключается по адресу из блока ниже: вставь его в консоль игры командой connect. Очередь, рантайм и разбор — на стороне сервера.',
             'FLUX HvH is an HvH server team for CS:GO. We run scout only: 1x1 and 2x2 arena on mirage, with roll fix so the spread never breaks the duel.\n\nConnect with the address from the block below — paste it into the game console with the connect command. Queues, runtime and matchmaking are handled on the server side.'),
    install_title: L('Как подключиться', 'How to connect'),
    install_steps: L('1. Открой консоль игры (~)\n2. Введи connect и адрес сервера из блока ниже\n3. Встань в очередь — ищи слоты scout 1x1 или 2x2\n4. Купи админку или VIP в разделе услуг',
                     '1. Open the game console (~)\n2. Type connect and the server address from the block below\n3. Join the queue — look for the scout 1x1 or 2x2 slots\n4. Buy admin or VIP in the services section'),
    server_button: L('Показать адреса', 'Show addresses')
  },
  about: {
    title: L('Почему FLUX', 'Why FLUX'),
    body: L('Мы не перепродаём чужие серверы и не ставим сомнительные плагины. FLUX HvH — свой продукт с обновлениями каждый сезон: новые режимы, честный античит и поддержка, которая отвечает в Telegram, а не через три дня.',
             'We do not resell other servers and we do not install sketchy plugins. FLUX HvH is our own product with updates every season: new modes, an honest anti-cheat and support that answers on Telegram, not three days later.')
  },
  payments: {
    title: L('Пополнение баланса', 'Top up balance'),
    lead: L('Выбери способ, переведи сумму и укажи логин. Баланс начислим после сверки — обычно за пару минут.',
            'Pick a method, transfer the amount and enter your login. We credit the balance after verification — usually within a couple of minutes.'),
    card: L('4276 **** **** 1234 (Альфа-Банк)', '4276 **** **** 1234 (Alpha Bank)'),
    sbp: L('Номер телефона: +7 900 000-00-00, банк: Т-Банк', 'Phone: +7 900 000-00-00, bank: T-Bank'),
    usdt: L('TON / USDT TRC-20: UQ... (реквизиты выдаёт админ)', 'TON / USDT TRC-20: UQ... (admin provides the details)'),
    note: L('Реквизиты выдаёт администратор в личных сообщениях. Не переводи никому, кроме нашего админа.',
            'The admin provides the payment details in direct messages. Do not transfer to anyone else.')
  },
  server: {
    admins_path: L('', ''),
    vip_cmd: L('', '')
  },
  footer: {
    about: L('FLUX HvH — игровой проект. Не связан с Valve Corporation.', 'FLUX HvH is a gaming project. Not affiliated with Valve Corporation.'),
    links: L('Пользовательское соглашение · Политика конфиденциальности · Помощь', 'Terms of service · Privacy policy · Support')
  }
};

function seedSettings() {
  const count = q.get('SELECT COUNT(*) AS c FROM settings').c;
  if (count > 0) return;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    q.run('INSERT INTO settings (key, value) VALUES (?, ?)', k, JSON.stringify(v));
  }
}

function seedData() {
  if (!q.get('SELECT id FROM users LIMIT 1')) {
    const { salt, hash } = hashPass('admin');
    q.run('INSERT INTO users (login, email, pass_hash, salt, balance, is_admin, created_at) VALUES (?,?,?,?,0,1,?)',
      'admin', 'admin@example.com', hash, salt, now());
    audit(null, 'admin', 'create', 'первый админ, пароль по умолчанию: admin');
  }

  if (!q.get('SELECT id FROM services LIMIT 1')) {
    const svc = [
      ['Админка', 'Полные права на сервере', 500, 30,
       'Все команды и админ-меню\nБан, кик, мут, слай\nДоступ к скрытым зонам', 'ХИТ', 'flux', 1, 1],
      ['VIP', 'Приоритет и комфорт', 250, 30,
       'Приоритетная очередь\nСвой префикс в чате\nВдвое больше слотов', '', 'flux', 1, 2]
    ];
    for (const s of svc) {
      q.run(`INSERT INTO services (title, subtitle, price, period_days, features, badge, game, enabled, sort)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, ...s);
    }
  }

  if (!q.get('SELECT id FROM servers LIMIT 1')) {
    const srv = [
      ['FLUX HvH | ONLY SCOUT | MIRAGE | Roll Fix', '185.9.145.160', 29999, 'Россия', 'flux', 32, 1, 1]
    ];
    for (const s of srv) {
      q.run('INSERT INTO servers (name, ip, port, location, game, players_limit, enabled, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ...s, now());
    }
  }

  if (!q.get('SELECT id FROM widgets LIMIT 1')) {
    const w = [
      {
        type: 'news', position: 'main', enabled: 1, sort: 5,
        data: { limit: 6 },
        title: L('Новости', 'News'),
        body: L('Свежие новости команды и обновления сервера.', 'Fresh news from the team and server updates.')
      },
    ];
    for (const x of w) {
      q.run(`INSERT INTO widgets (type, title, body, position, enabled, sort, data, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        x.type, JSON.stringify(x.title), JSON.stringify(x.body), x.position,
        x.enabled, x.sort, JSON.stringify(x.data), now());
    }
  }

  if (!q.get('SELECT id FROM news LIMIT 1')) {
    const nw = [
      [L('Открыли третий сервер', 'Third server is up'),
       L('Встречайте FLUX HvH #3 — отдельный рейтинг и очередь scout без ожидания.',
         'Meet FLUX HvH #3 — a separate ranking and a scout queue with no waiting.'),
       L('Новости', 'News')],
      [L('Обновили античит', 'Anti-cheat updated'),
       L('Новое ядро Flux ловит больше мувинг-читов и не отдаёт ложных срабатываний на флеш-интере.',
         'The new Flux core catches more movement cheats without false positives on flash interference.'),
       L('Техническое', 'Tech')],
      [L('Промокод на месяц', 'One month promo'),
       L('При пополнении баланса от 1000 ₽ — месяц VIP бесплатно. Напиши админу.',
         'Top up from 1000 ₽ and get a month of VIP for free. Message the admin.'),
       L('Акция', 'Promo')]
    ];
    for (const n of nw) {
      q.run('INSERT INTO news (title, body, tag, published, created_at) VALUES (?,?,?,1,?)',
        JSON.stringify(n[0]), JSON.stringify(n[1]), JSON.stringify(n[2]), now());
    }
  }
}

function audit(userId, login, action, meta = '') {
  q.run('INSERT INTO audit (user_id, login, action, meta, ts) VALUES (?,?,?,?,?)',
    userId ?? null, login ?? '', action, String(meta).slice(0, 400), now());
}

/* ---------- settings ---------- */
const getSettings = key => {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return DEFAULT_SETTINGS[key] ?? null;
  try { return JSON.parse(row.value); } catch { return DEFAULT_SETTINGS[key] ?? null; }
};
const setSettings = (key, value) => {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
};
const allSettings = () => {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of q.all('SELECT key, value FROM settings')) {
    try { out[r.key] = JSON.parse(r.value); } catch {}
  }
  return out;
};

/* ---------- виджеты ---------- */
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const widgetOut = w => ({
  ...w,
  title: parseJson(w.title, { ru: '', en: '' }),
  body: parseJson(w.body, { ru: '', en: '' }),
  data: parseJson(w.data, {})
});
const allWidgets = () => q.all('SELECT * FROM widgets ORDER BY sort, id').map(widgetOut);

module.exports = {
  db, q, now, hashPass, checkPass,
  seedSettings, seedData, audit, getSettings, setSettings, allSettings,
  allWidgets, widgetOut, parseJson, L, DEFAULT_SETTINGS
};
