'use strict';
/* =========================================================
   FLUX Agent — агент выдачи прав на стороне игрового сервера.

   Нужен, когда RCON не работает (панель/прокси принимает пароль, но
   команды не выполняет) или когда портал стоит на другом хосте.

   Запуск (на сервере, где лежат addons/sourcemod/... и база VIP):

       node agent.js --port 8791 --token СЕКРЕТНЫЙ_ТОКЕН \
            --admins addons/sourcemod/data/admins.json \
            --vipdb  addons/vipmodule/vipusers.db \
            --viptable vipusers

   Затем в портале: «Управление сервером» -> «Агент выдачи» ->
   адрес http://IP:8791 и тот же токен.

   Агент принимает POST /issue:
       { steamid, name, flags, days, credit, group }
   и отвечает { ok: true, admins: true/false, vip: true/false, log: [...] }

   Без внешних зависимостей: только node:http и node:sqlite.
   ========================================================= */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/* ---------------- аргументы ---------------- */
const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = name => argv.includes('--' + name);

const PORT = Number(arg('port', 8791));
const TOKEN = arg('token', '');
const ADMINS = arg('admins', 'addons/sourcemod/data/admins.json');
const VIPDB = arg('vipdb', '');
const VIPTABLE = arg('viptable', 'vipusers');
const VIPTPL = arg('viptpl', '');

if (!TOKEN) {
  console.error('Нужен --token (общий секрет с порталом)');
  process.exit(1);
}

/* ---------------- helpers ---------------- */
const toSteam2 = id => {
  const m = /^STEAM_([0-5]):([0-9]):(\d+)$/i.exec(String(id).trim());
  if (!m) return String(id).trim();
  const acc = Number(m[3]);
  return 'STEAM_' + m[1] + ':' + (acc % 2) + ':' + Math.floor(acc / 2);
};
const toSteam3 = id => {
  const m = /^STEAM_([0-5]):([0-9]):(\d+)$/i.exec(String(id).trim());
  if (!m) return String(id).trim();
  return 'STEAM_' + m[1] + ':X:' + (Number(m[3]) * 2 + Number(m[2]));
};

function writeAdmins(file, e) {
  let list = [];
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw) list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [];
    }
  } catch (err) { return { ok: false, error: 'не читается admins.json: ' + err.message }; }

  const found = list.find(x => String(x.steamid) === e.steamid);
  if (found) {
    found.name = e.name || found.name;
    found.flags = e.flags || found.flags;
  } else {
    list.push({ steamid: e.steamid, name: e.name || 'admin', flags: e.flags || 'b',
                immunity: 0, is_restricted: false });
  }
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, '\t'), 'utf8');
  } catch (err) { return { ok: false, error: 'не записался admins.json: ' + err.message }; }
  return { ok: true, count: list.length };
}

function writeVip(file, table, e, days, credit, group) {
  if (!file) return { ok: false, skipped: true };
  if (!fs.existsSync(file)) return { ok: false, error: 'нет файла БД: ' + file };
  let db;
  try { db = new DatabaseSync(file); }
  catch (err) { return { ok: false, error: 'БД: ' + err.message }; }
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
    if (!cols.length) return { ok: false, error: 'нет таблицы ' + table };
    // универсально: authid/steamid + vip + expiration
    const has = n => cols.includes(n);
    const steamCol = ['authid', 'steamid', 'steamid64', 'auth'].find(has);
    if (!steamCol) return { ok: false, error: 'нет колонки SteamID в ' + table + ' (' + cols.join(',') + ')' };

    const expire = Math.floor(Date.now() / 1000) + (Number(days) || 30) * 86400;
    const sets = [], vals = [];
    if (has('vip')) { sets.push('vip = ?'); vals.push(1); }
    if (has('expiration')) { sets.push('expiration = ?'); vals.push(expire); }
    if (has('credit')) { sets.push('credit = ?'); vals.push(Number(credit) || 0); }
    if (has('ncredit')) { sets.push('ncredit = ?'); vals.push(0); }
    if (has('group') && group) { sets.push('group = ?'); vals.push(group); }
    if (has('name') || has('nick')) {
      const c = has('name') ? 'name' : 'nick';
      sets.push(c + ' = ?'); vals.push(e.name || '');
    }
    const sql = `INSERT OR REPLACE INTO ${table} (${steamCol}${sets.length ? ', ' + sets.join(', ') : ''})
                VALUES (?${sets.length ? ', ' + sets.map(() => '?').join(', ') : ''})`;
    db.prepare(sql).run(e.steamid, ...vals);
    return { ok: true, sql };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { db.close(); } catch {}
  }
}

/* ---------------- сервер ---------------- */
const server = http.createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url.startsWith('/ping')) {
    return json(200, { ok: true, service: 'flux-agent', time: Date.now() });
  }

  if (req.method !== 'POST' || !req.url.startsWith('/issue')) {
    return json(404, { ok: false, error: 'нет такого метода' });
  }

  let token = '';
  const hdr = req.headers['x-agent-token'];
  if (hdr) token = String(hdr);
  else if (req.url.includes('token=')) {
    token = decodeURIComponent(req.url.split('token=')[1].split('&')[0]);
  }
  if (token !== TOKEN) return json(403, { ok: false, error: 'неверный токен' });

  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 64 * 1024) { req.destroy(); }
  });
  req.on('end', () => {
    let d = {};
    try { d = body ? JSON.parse(body) : {}; } catch { return json(400, { ok: false, error: 'битый JSON' }); }

    const steamid = String(d.steamid || '').trim();
    if (!steamid) return json(400, { ok: false, error: 'нет SteamID' });

    const e = {
      steamid: toSteam2(steamid),
      steam3: toSteam3(steamid),
      name: String(d.name || '').trim(),
      flags: String(d.flags || 'b').trim()
    };

    const log = [];
    const admins = writeAdmins(ADMINS, e);
    log.push(admins.ok ? 'admins.json: записан (' + admins.count + ')' : 'admins.json: ' + admins.error);

    const vip = writeVip(VIPDB, VIPTABLE, e, d.days, d.credit, d.group);
    log.push(vip.skipped ? 'VIP-БД: не задана, пропущено'
                 : vip.ok ? 'VIP-БД: записан' : 'VIP-БД: ' + vip.error);

    console.log('[' + new Date().toISOString() + '] ' + e.steamid + ' — ' + log.join('; '));
    json(200, { ok: admins.ok || vip.ok, admins: admins.ok, vip: !!vip.ok, log });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('FLUX Agent слушает 0.0.0.0:' + PORT);
  console.log('  admins.json: ' + path.resolve(ADMINS));
  console.log('  VIP-БД:      ' + (VIPDB ? path.resolve(VIPDB) + ' [' + VIPTABLE + ']' : 'не задана'));
  console.log('  токен:       ' + (TOKEN ? 'задан' : 'НЕТ'));
});
