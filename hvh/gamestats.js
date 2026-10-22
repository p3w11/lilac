'use strict';
/* =========================================================
   Игровая статистика (только чтение) из MySQL портала.

   Источники:
     lvl_base            — база игроков (lastconnect)  → всего / 7 дней / сегодня
     vip_users           — VIP-аккаунты                → VIP игроков
     sb_bans             — SourceBans, баны            → всего забанено
     sb_comms            — SourceBans, муты/гаги       → всего заглушено
     neo_cards_history   — дропы из карточек           → последний дроп
   ========================================================= */

const U = require('./users');

const TTL = 60 * 1000;          // кэш на минуту: не дёргаем MySQL на каждый запрос
let pool = null, poolKey = '', cache = { at: 0, data: null }, pending = null;

function cfg() {
  const c = U.cfg();
  if (c.mode !== 'mysql' || !c.host || !c.database) return null;
  return c;
}

async function getPool() {
  const c = cfg();
  if (!c) return null;

  const key = [c.host, c.port, c.user, c.database].join('|');
  if (pool && poolKey === key) return pool;
  if (pool) { try { await pool.end(); } catch { /* уже закрыт */ } pool = null; }

  const mysql = require('mysql2/promise');
  pool = mysql.createPool({
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
    waitForConnections: true, connectionLimit: 2, queueLimit: 20,
    connectTimeout: 8000, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: true   // steamid64 без потери точности
  });
  poolKey = key;
  return pool;
}

/* SteamID64 -> STEAM_1:Y:Z (в таком виде пишет lvl_base) */
function steam3(id) {
  try {
    const base = 76561197960265728n;
    const n = BigInt(String(id)) - base;
    const y = n % 2n;
    const z = (n - y) / 2n;
    return `STEAM_1:${y}:${z}`;
  } catch { return ''; }
}

async function read() {
  const p = await getPool();
  if (!p) return null;

  const count = async sql => {
    try { const [r] = await p.query(sql); return Number(r[0] && r[0].c) || 0; }
    catch { return 0; }
  };

  /* lvl_base пишет время в UNIX-секундах, MySQL живёт в MSK */
  const [total, d7, today, vip, banned, muted] = await Promise.all([
    count('SELECT COUNT(*) AS c FROM lvl_base'),
    count('SELECT COUNT(*) AS c FROM lvl_base WHERE lastconnect >= UNIX_TIMESTAMP() - 7 * 86400'),
    count('SELECT COUNT(*) AS c FROM lvl_base WHERE lastconnect >= UNIX_TIMESTAMP(CURDATE())'),
    count('SELECT COUNT(*) AS c FROM vip_users WHERE expires = 0 OR expires > UNIX_TIMESTAMP()'),
    count('SELECT COUNT(*) AS c FROM sb_bans WHERE (RemovedBy IS NULL OR RemovedBy = 0) AND (ends = 0 OR ends > UNIX_TIMESTAMP())'),
    count('SELECT COUNT(*) AS c FROM sb_comms WHERE (RemovedBy IS NULL OR RemovedBy = 0) AND (ends = 0 OR ends > UNIX_TIMESTAMP())')
  ]);

  /* последние дропы из карточек */
  let drops = [];
  try {
    const [rows] = await p.query(`
      SELECT h.id, h.steamid, h.created_at, r.type, r.count, r.rare
      FROM neo_cards_history h
      LEFT JOIN neo_cards_rewards r ON r.id = h.reward_id
      ORDER BY h.id DESC LIMIT 12`);

    const keys = [...new Set(rows.map(r => steam3(r.steamid)).filter(Boolean))];
    const names = new Map();
    if (keys.length) {
      try {
        const [nr] = await p.query('SELECT steam, name FROM lvl_base WHERE steam IN (?)', [keys]);
        for (const x of nr) names.set(x.steam, x.name);
      } catch { /* нет lvl_base — обойдёмся без имён */ }
    }

    drops = rows.map(r => ({
      id: Number(r.id) || 0,
      name: names.get(steam3(r.steamid)) || 'Игрок',
      type: r.type || 'credits',
      count: Number(r.count) || 0,
      rare: Number(r.rare) || 0,
      at: (Number(r.created_at) || 0) * 1000
    }));
  } catch { drops = []; }

  return { total, d7, today, vip, banned, muted, drops, at: Date.now() };
}

/* кэшированные цифры; при ошибке отдаём последнее удачное значение */
async function stats() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;

  if (!pending) {
    pending = read()
      .then(d => {
        if (d) cache = { at: Date.now(), data: d };
        return d || cache.data;
      })
      .catch(e => {
        console.error('gamestats:', e.message);
        return cache.data;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

/* ---------- VIP-игроки ---------- */
async function vip(limit = 200) {
  const p = await getPool();
  if (!p) return [];
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  try {
    const [rows] = await p.query(
      `SELECT account_id, name, lastvisit, \`group\`, expires
       FROM vip_users
       WHERE expires = 0 OR expires > UNIX_TIMESTAMP()
       ORDER BY lastvisit DESC LIMIT ${lim}`);
    return rows.map(v => {
      const acc = Number(v.account_id) || 0;
      const sid = acc ? String(76561197960265728n + BigInt(acc)) : '';
      return {
        steamid64: sid,
        steam: sid ? steam3(sid) : '',
        name: String(v.name || 'Игрок'),
        group: String(v.group || 'VIP'),
        expires: (Number(v.expires) || 0) * 1000,
        lastvisit: (Number(v.lastvisit) || 0) * 1000
      };
    });
  } catch (e) {
    console.error('gamestats vip:', e.message);
    return [];
  }
}

/* ---------- списки банов и мутов ---------- */
async function bans(limit = 100, activeOnly = false) {
  const p = await getPool();
  if (!p) return [];
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const where = activeOnly
    ? 'WHERE (RemovedBy IS NULL OR RemovedBy = 0) AND (ends = 0 OR ends > UNIX_TIMESTAMP())'
    : '';
  try {
    const [rows] = await p.query(
      `SELECT bid, name, authid, created, ends, length, reason, RemovedBy, RemoveType
       FROM sb_bans ${where} ORDER BY bid DESC LIMIT ${lim}`);
    const now = Math.floor(Date.now() / 1000);
    return rows.map(b => ({
      id: b.bid,
      name: b.name,
      steam: b.authid,
      steamid64: toSteam64(b.authid),
      created: (Number(b.created) || 0) * 1000,
      ends: (Number(b.ends) || 0) * 1000,
      length: Number(b.length) || 0,
      reason: b.reason || '',
      active: !b.RemovedBy && (!b.ends || Number(b.ends) > now)
    }));
  } catch { return []; }
}

async function mutes(limit = 100, activeOnly = false) {
  const p = await getPool();
  if (!p) return [];
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const where = activeOnly
    ? 'WHERE (RemovedBy IS NULL OR RemovedBy = 0) AND (ends = 0 OR ends > UNIX_TIMESTAMP())'
    : '';
  try {
    const [rows] = await p.query(
      `SELECT bid, name, authid, created, ends, length, reason, type, RemovedBy, RemoveType
       FROM sb_comms ${where} ORDER BY bid DESC LIMIT ${lim}`);
    const now = Math.floor(Date.now() / 1000);
    return rows.map(m => ({
      id: m.bid,
      name: m.name,
      steam: m.authid,
      steamid64: toSteam64(m.authid),
      type: Number(m.type) || 0,          // 1 — мут, 2 — гаг, 3 — silence
      created: (Number(m.created) || 0) * 1000,
      ends: (Number(m.ends) || 0) * 1000,
      length: Number(m.length) || 0,
      reason: m.reason || '',
      active: !m.RemovedBy && (!m.ends || Number(m.ends) > now)
    }));
  } catch { return []; }
}

function reset() {
  cache = { at: 0, data: null };
  if (pool) { try { pool.end(); } catch { /* уже */ } }
  pool = null; poolKey = '';
}

/* проверка подключения для админки */
async function test() {
  const p = await getPool();
  if (!p) return { ok: false, error: 'внешняя MySQL не настроена' };
  try {
    const [r] = await p.query('SELECT COUNT(*) AS c FROM lvl_base');
    return { ok: true, players: Number(r[0].c) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* SteamID в любом виде -> SteamID64 */
function toSteam64(v) {
  const s = String(v || '').trim();
  if (/^\d{17}$/.test(s)) return s;
  let m = s.match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (m) return String(76561197960265728n + BigInt(m[2]) * 2n + BigInt(m[1]));
  m = s.match(/^\[?U:1:(\d+)\]?$/i);
  if (m) return String(76561197960265728n + BigInt(m[1]));
  m = s.match(/^(\d{1,10})$/);
  if (m) return String(76561197960265728n + BigInt(m[1]));
  return '';
}

/* ---------- профиль игрока по SteamID64 ---------- */
async function profile(steamid64) {
  const sid = toSteam64(steamid64);
  if (!sid) return null;
  const p = await getPool();
  if (!p) return null;

  const s3 = steam3(sid);
  const num = v => Number(v) || 0;

  try {
    const [rows] = await p.query('SELECT * FROM lvl_base WHERE steam = ? LIMIT 1', [s3]);
    const row = rows[0] || null;

    let place = 0;
    if (row) {
      const [pr] = await p.query('SELECT COUNT(*) AS c FROM lvl_base WHERE value > ?', [num(row.value)]);
      place = (Number(pr[0] && pr[0].c) || 0) + 1;
    }

    const kills = num(row && row.kills);
    const deaths = num(row && row.deaths);
    const shoots = num(row && row.shoots);
    const hits = num(row && row.hits);
    const headshots = num(row && row.headshots);
    const roundWin = num(row && row.round_win);
    const roundLose = num(row && row.round_lose);
    const rounds = roundWin + roundLose;
    const playtime = num(row && row.playtime);

    return {
      found: !!row,
      steamid64: sid,
      steam3: s3,
      name: row ? String(row.name || '') : '',
      rank: num(row && row.rank),
      experience: num(row && row.value),
      place,
      playtime,
      hours: Math.round(playtime / 3600),
      kills, deaths,
      kd: deaths ? Math.round((kills / deaths) * 10) / 10 : kills,
      headshots,
      headshotsPct: kills ? Math.round((headshots / kills) * 1000) / 10 : 0,
      assists: num(row && row.assists),
      shoots,
      hits,
      accuracy: shoots ? Math.round((hits / shoots) * 100) : 0,
      roundWin, roundLose, rounds,
      winrate: rounds ? Math.round((roundWin / rounds) * 1000) / 10 : 0,
      lastconnect: num(row && row.lastconnect)
    };
  } catch (e) {
    console.error('gamestats profile:', e.message);
    return null;
  }
}

module.exports = { stats, vip, bans, mutes, profile, reset, test, steam3 };
