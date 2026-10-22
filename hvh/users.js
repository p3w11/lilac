'use strict';
/* =========================================================
   Пользователи портала: единый слой над тремя источниками.

   local  — встроенная база портала (SQLite, data/portal.db)
   mysql  — внешняя MySQL напрямую (например таблица flux_users)
   bridge — та же внешняя БД, но через PHP-мост по HTTP
            (для хостингов, где порт MySQL закрыт снаружи)

   Во внешних режимах источник правды для логина, почты, пароля
   и баланса — внешняя таблица. Локальная таблица users хранит
   «зеркало»: ext_id (id во внешней базе), SteamID, игровой ник,
   права админа и заметки. Сессии, заказы и донаты работают как
   раньше — они ссылаются на локальный id.

   Пароли во внешней базе — bcrypt ($2y$/$2a$/$2b$), как у PHP.
   ========================================================= */
const D = require('./db');

const KEY = 'users_db';
const BCRYPT_ROUNDS = 10;

/* ---------- bcrypt (ленивый require, чтобы портал жил без него) ---------- */
let _bcrypt = null;
let _bcryptTried = false;
function bcrypt() {
  if (_bcryptTried) return _bcrypt;
  _bcryptTried = true;
  try { _bcrypt = require('bcryptjs'); } catch { _bcrypt = null; }
  return _bcrypt;
}

/* ---------- понятные ошибки сети ---------- */
function friendlyNetError(e) {
  const code = e && (e.code || e.errno) ? String(e.code || e.errno) : '';
  const msg = (e && e.message) || String(e);
  if (/ECONNREFUSED/.test(code + msg)) {
    return 'сервер MySQL не отвечает на порту. Чаще всего на шаред-хостинге порт MySQL закрыт снаружи — ' +
      'тогда включи режим «через PHP-мост» (файл bridge/flux_users.php)';
  }
  if (/ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/.test(code + msg)) {
    return 'не дозвонились до MySQL (' + (code || 'таймаут') + '). Проверь хост и порт';
  }
  if (/ER_HOST_NOT_PRIVILEGED|Access denied/.test(code + msg)) {
    return 'сервер MySQL не пускает с этого IP (или неверный логин/пароль). ' +
      'На шаред-хостинге используй режим «через PHP-мост»';
  }
  if (/ER_BAD_DB_ERROR|Unknown database/.test(code + msg)) return 'нет базы данных с таким именем';
  return msg;
}

/* ---------- настройки ---------- */
function cfg() {
  const c = D.getSettings(KEY) || {};
  return {
    mode: ['mysql', 'bridge'].includes(c.mode) ? c.mode : 'local',
    host: String(c.host || '').trim(),
    port: Number(c.port) || 3306,
    user: String(c.user || '').trim(),
    password: String(c.password || ''),
    database: String(c.database || '').trim(),
    table: (String(c.table || 'flux_users').replace(/[^\w]/g, '').slice(0, 64)) || 'flux_users',
    rolesTable: (String(c.roles_table || 'flux_roles').replace(/[^\w]/g, '').slice(0, 64)) || 'flux_roles',
    userRolesTable: (String(c.user_roles_table || 'flux_user_roles').replace(/[^\w]/g, '').slice(0, 64)) || 'flux_user_roles',
    url: String(c.url || '').trim().replace(/\/$/, ''),
    token: String(c.token || ''),
    sync_name: !!c.sync_name
  };
}
function setCfg(patch) {
  const c = { ...cfg(), ...patch };
  D.setSettings(KEY, c);
  return c;
}
const external = () => cfg().mode !== 'local';

/* =========================================================
   Транспорт: общение с внешней базой
   ========================================================= */

/* ---------- прямой MySQL ---------- */
class MysqlTransport {
  constructor(c) { this.c = c; this.pool = null; }

  async getPool() {
    if (this.pool) return this.pool;
    let mysql;
    try { mysql = require('mysql2/promise'); }
    catch { throw new Error('нет пакета mysql2 — выполни npm install в папке портала'); }
    this.pool = mysql.createPool({
      host: this.c.host,
      port: this.c.port,
      user: this.c.user,
      password: this.c.password,
      database: this.c.database,
      waitForConnections: true,
      connectionLimit: 4,
      charset: 'utf8mb4_general_ci',
      dateStrings: true,
      ssl: undefined
    });
    return this.pool;
  }

  async ping() {
    const pool = await this.getPool();
    try {
      const [rows] = await pool.query('SELECT VERSION() AS v, DATABASE() AS db');
      return { ok: true, info: { server: rows[0].v, database: rows[0].db } };
    } catch (e) { throw new Error(friendlyNetError(e)); }
  }
  async tables() {
    const pool = await this.getPool();
    const [rows] = await pool.query('SHOW TABLES');
    return rows.map(r => Object.values(r)[0]);
  }
  async describe(table) {
    const pool = await this.getPool();
    const [rows] = await pool.query('SHOW COLUMNS FROM `' + String(table).replace(/`/g, '') + '`');
    return rows.map(r => ({
      field: r.Field, type: r.Type, null: r.Null, key: r.Key,
      def: r.Default === null ? null : r.Default, extra: r.Extra
    }));
  }
  async all(sql, params = []) {
    const pool = await this.getPool();
    const [rows] = await pool.query(sql, params);
    return rows;
  }
  async one(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] || null;
  }
  async run(sql, params = []) {
    const pool = await this.getPool();
    const [r] = await pool.query(sql, params);
    return { insertId: r.insertId, affectedRows: r.affectedRows };
  }
}

/* ---------- PHP-мост (HTTP) ---------- */
class BridgeTransport {
  constructor(c) { this.c = c; }
  async call(action, payload = {}) {
    if (!this.c.url) throw new Error('не задан адрес PHP-моста');
    const res = await fetch(this.c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Flux-Token': this.c.token },
      body: JSON.stringify({ action, ...payload }),
      signal: AbortSignal.timeout(15000)
    });
    const txt = await res.text();
    let j = {};
    try { j = JSON.parse(txt); } catch { throw new Error('мост вернул не JSON: ' + txt.slice(0, 200)); }
    if (!res.ok || j.error) throw new Error(j.error || ('мост: HTTP ' + res.status));
    return j;
  }
  async ping() {
    try { const j = await this.call('ping'); return { ok: true, info: j.info || {} }; }
    catch (e) { throw new Error(friendlyNetError(e)); }
  }
  async tables() { const j = await this.call('tables'); return j.tables || []; }
  async describe(table) { const j = await this.call('describe', { table }); return j.columns || []; }
  async all(sql, params = []) { const j = await this.call('all', { sql, params }); return j.rows || []; }
  async one(sql, params = []) { const j = await this.call('one', { sql, params }); return j.row || null; }
  async run(sql, params = []) { const j = await this.call('run', { sql, params }); return { insertId: j.insertId, affectedRows: j.affectedRows }; }
}

/* =========================================================
   Определение колонок внешней таблицы
   ========================================================= */
const CANDIDATES = {
  id:       ['id', 'user_id', 'uid'],
  login:    ['login', 'username', 'user_name'],
  email:    ['email', 'mail'],
  pass:     ['password', 'pass', 'pass_hash', 'password_hash'],
  balance:  ['balance', 'credits', 'money'],
  name:     ['name', 'display_name', 'nickname'],
  steam:    ['steam_id', 'steamid', 'steam64', 'steam_id64'],
  avatar:   ['avatar', 'avatar_url', 'avatarfull'],
  banner:   ['banner', 'banner_url', 'background', 'profile_background'],
  gameLogin:['game_login', 'game_nick'],
  gameAdmin:['game_admin', 'is_game_admin'],
  isAdmin:  ['is_admin', 'admin'],
  notes:    ['notes', 'note', 'comment'],
  created:  ['created_at', 'created'],
  updated:  ['updated_at', 'updated'],
  lastLog:  ['last_logged', 'last_login', 'last_seen'],
  verified: ['verified'],
  approved: ['approved'],
  hidden:   ['hidden'],
  temp:     ['is_temporary'],
  deleted:  ['deleted_at'],
  uri:      ['uri', 'slug']
};

function detectMap(columns) {
  const names = columns.map(c => String(c.field || '').toLowerCase());
  const map = {};
  for (const [key, cands] of Object.entries(CANDIDATES)) {
    for (const c of cands) {
      const i = names.indexOf(c);
      if (i >= 0) { map[key] = columns[i].field; break; }
    }
  }
  return map;
}

/* =========================================================
   Внешние пользователи
   ========================================================= */
class ExternalUsers {
  constructor(c, t) { this.c = c; this.t = t; this._map = null; this._cols = null; }

  get table() { return this.c.table; }
  q(name) { return '`' + String(name).replace(/`/g, '') + '`'; }

  async columns() {
    if (!this._cols) this._cols = await this.t.describe(this.table);
    return this._cols;
  }
  async map() {
    if (!this._map) this._map = detectMap(await this.columns());
    return this._map;
  }
  reset() { this._map = null; this._cols = null; }

  async structure() {
    const cols = await this.columns();
    const m = await this.map();
    return {
      table: this.table,
      columns: cols,
      mapped: m,
      missing: ['login', 'email', 'pass'].filter(k => !m[k]),
      extrasInTable: ['steam', 'gameAdmin', 'isAdmin', 'notes'].filter(k => m[k])
    };
  }

  /* по какому полю искать конкретную запись */
  idCol(m) { return m.id || m.login; }
  /* ключ записи во внешней базе */
  keyOf(raw, m) {
    if (!raw) return 0;
    const v = m.id ? raw[m.id] : raw[m.login];
    return v === undefined || v === null ? 0 : v;
  }

  /* --- чтение --- */
  async rawById(id) {
    const m = await this.map();
    const col = this.idCol(m);
    if (!col) throw new Error('в таблице нет колонки login');
    return this.t.one('SELECT * FROM ' + this.q(this.table) + ' WHERE ' + this.q(col) + ' = ? LIMIT 1', [id]);
  }
  async rawByLogin(login) {
    const m = await this.map();
    if (!m.login) throw new Error('в таблице нет колонки login');
    return this.t.one('SELECT * FROM ' + this.q(this.table) + ' WHERE ' + this.q(m.login) + ' = ? LIMIT 1', [login]);
  }
  async rawByEmail(email) {
    const m = await this.map();
    if (!m.email) return null;
    return this.t.one('SELECT * FROM ' + this.q(this.table) + ' WHERE ' + this.q(m.email) + ' = ? LIMIT 1', [email]);
  }
  async rawList(limit = 1000) {
    const m = await this.map();
    if (!m.login) throw new Error('в таблице нет колонки login');
    let sql = 'SELECT * FROM ' + this.q(this.table);
    if (m.deleted) sql += ' WHERE ' + this.q(m.deleted) + ' IS NULL';
    sql += ' ORDER BY ' + this.q(m.login) + ' LIMIT ' + Number(limit);
    return this.t.all(sql, []);
  }

  /* --- создание --- */
  async create({ login, email, pass, balance = 0, game_login = '', steam_id = '', is_admin = 0, game_admin = 0 }) {
    const m = await this.map();
    const cols = await this.columns();
    if (!m.login) throw new Error('в таблице нет колонки login');
    if (!m.pass) throw new Error('в таблице нет колонки password');

    const hash = bcrypt() ? bcrypt().hashSync(String(pass), BCRYPT_ROUNDS) : '';
    if (!hash) throw new Error('нет пакета bcryptjs — выполни npm install в папке портала');

    const values = {};
    values[m.login] = login;
    if (m.email) values[m.email] = email || '';
    values[m.pass] = hash;
    if (m.balance) values[m.balance] = Number(balance) || 0;
    if (m.name) values[m.name] = game_login || login;
    if (m.uri) values[m.uri] = String(login).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (m.steam) values[m.steam] = steam_id || '';
    if (m.gameLogin) values[m.gameLogin] = game_login || '';
    if (m.gameAdmin) values[m.gameAdmin] = game_admin ? 1 : 0;
    if (m.isAdmin) values[m.isAdmin] = is_admin ? 1 : 0;
    if (m.verified) values[m.verified] = 1;
    if (m.approved) values[m.approved] = 1;
    if (m.hidden) values[m.hidden] = 0;
    if (m.temp) values[m.temp] = 0;
    if (m.notes) values[m.notes] = '';
    if (m.created) values[m.created] = new Date();
    if (m.updated) values[m.updated] = new Date();
    if (m.lastLog) values[m.lastLog] = null;

    // добиваем обязательные колонки, которых мы не знаем
    for (const c of cols) {
      const f = c.field;
      if (f in values) continue;
      const nullable = String(c.null || '').toUpperCase() === 'YES';
      const hasDefault = c.def !== null && c.def !== undefined;
      if (nullable || hasDefault) continue;
      if (String(c.extra || '').includes('auto_increment')) continue;
      values[f] = defaultForType(c.type);
    }

    const keys = Object.keys(values);
    const sql = 'INSERT INTO ' + this.q(this.table) + ' (' +
      keys.map(k => this.q(k)).join(', ') + ') VALUES (' +
      keys.map(() => '?').join(', ') + ')';
    const res = await this.t.run(sql, keys.map(k => values[k]));
    return { id: res.insertId, hash };
  }

  /* --- роли --- */
  async listRoles() {
    return this.t.all('SELECT * FROM `' + this.c.rolesTable + '` ORDER BY id', []);
  }
  async rolesOfUser(extId) {
    if (!extId) return [];
    return this.t.all('SELECT r.id, r.name, r.title, r.is_admin FROM `' + this.c.userRolesTable +
      '` ur JOIN `' + this.c.rolesTable + '` r ON r.id = ur.role_id WHERE ur.user_id = ?', [extId]);
  }
  async rolesOfUsers(extIds) {
    const map = new Map();
    if (!extIds || !extIds.length) return map;
    const ph = extIds.map(() => '?').join(',');
    const rows = await this.t.all('SELECT ur.user_id, r.id, r.name, r.title, r.is_admin FROM `' +
      this.c.userRolesTable + '` ur JOIN `' + this.c.rolesTable + '` r ON r.id = ur.role_id WHERE ur.user_id IN (' + ph + ')', extIds);
    for (const row of rows) {
      if (!map.has(row.user_id)) map.set(row.user_id, []);
      map.get(row.user_id).push(row);
    }
    return map;
  }
  async setRoles(extId, names) {
    if (!extId) return [];
    await this.t.run('DELETE FROM `' + this.c.userRolesTable + '` WHERE user_id = ?', [extId]);
    const list = (names || []).filter(Boolean);
    if (list.length) {
      const ph = list.map(() => '?').join(',');
      await this.t.run('INSERT INTO `' + this.c.userRolesTable + '` (user_id, role_id, created_at) ' +
        'SELECT ?, id, NOW() FROM `' + this.c.rolesTable + '` WHERE name IN (' + ph + ')', [extId, ...list]);
    }
    roleCache.delete(Number(extId));
    return this.rolesOfUser(extId);
  }

  /* --- изменение --- */
  async setPasswordById(id, pass) {
    const m = await this.map();
    if (!m.pass) throw new Error('в таблице нет колонки password');
    const hash = bcrypt() ? bcrypt().hashSync(String(pass), BCRYPT_ROUNDS) : '';
    if (!hash) throw new Error('нет пакета bcryptjs');
    await this.t.run('UPDATE ' + this.q(this.table) + ' SET ' + this.q(m.pass) + ' = ? WHERE ' + this.q(this.idCol(m)) + ' = ?',
      [hash, id]);
    return hash;
  }
  async addBalanceById(id, delta) {
    const m = await this.map();
    if (!m.balance) throw new Error('в таблице нет колонки balance');
    await this.t.run('UPDATE ' + this.q(this.table) + ' SET ' + this.q(m.balance) +
      ' = ' + this.q(m.balance) + ' + ? WHERE ' + this.q(this.idCol(m)) + ' = ?', [Number(delta) || 0, id]);
    return this.balanceOf(await this.rawById(id));
  }
  async setFieldById(id, field, value) {
    const m = await this.map();
    const col = m[field] || field;
    await this.t.run('UPDATE ' + this.q(this.table) + ' SET ' + this.q(col) + ' = ? WHERE ' + this.q(this.idCol(m)) + ' = ?',
      [value, id]);
  }
  async touchLogin(id) {
    const m = await this.map();
    if (!m.lastLog) return;
    await this.t.run('UPDATE ' + this.q(this.table) + ' SET ' + this.q(m.lastLog) + ' = ? WHERE ' + this.q(this.idCol(m)) + ' = ?',
      [new Date(), id]);
  }

  balanceOf(raw) {
    const m = this._map || {};
    if (!raw) return 0;
    const v = raw[m.balance || 'balance'];
    return Math.round(Number(v) || 0);
  }
}

/* значение по типу колонки — для автозаполнения обязательных полей */
function defaultForType(type) {  const t = String(type || '').toLowerCase();
  if (t.includes('int') || t.includes('bit') || t.includes('bool')) return 0;
  if (t.includes('decimal') || t.includes('float') || t.includes('double') || t.includes('numeric')) return 0;
  if (t.includes('date') || t.includes('timestamp')) return new Date();
  if (t.includes('json')) return '{}';
  if (t.includes('blob') || t.includes('text')) return '';
  return '';
}

/* =========================================================
   Зеркало в локальной базе
   ========================================================= */
function mirrorByExt(extId) {
  return D.q.get('SELECT * FROM users WHERE ext_id = ? AND ext_id > 0', Number(extId));
}
function mirrorByLogin(login) {
  return D.q.get('SELECT * FROM users WHERE login = ?', String(login));
}
function mirrorUpsert(ext) {
  let row = mirrorByExt(ext.ext_id);
  if (!row) row = mirrorByLogin(ext.login);
  if (row) {
    D.q.run('UPDATE users SET ext_id = ?, email = ?, auth_src = ? WHERE id = ?',
      Number(ext.ext_id), String(ext.email || ''), 'mysql', row.id);
    return D.q.get('SELECT * FROM users WHERE id = ?', row.id);
  }
  const r = D.q.run(`INSERT INTO users (login, email, pass_hash, salt, balance, created_at, ext_id, auth_src)
                     VALUES (?,?,'','',?,?,?,?)`,
    String(ext.login), String(ext.email || ''), Math.round(Number(ext.balance) || 0), D.now(),
    Number(ext.ext_id), 'mysql');
  return D.q.get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
}

/* ---------- кэш ролей (чтобы не дёргать базу на каждый запрос) ---------- */
const roleCache = new Map();          // ext_id -> { at, roles }
const ROLE_TTL = 20000;

function rolesFromCache(extId) {
  const c = roleCache.get(Number(extId));
  if (!c) return null;
  if (Date.now() - c.at > ROLE_TTL) { roleCache.delete(Number(extId)); return null; }
  return c.roles;
}

/* навесить роли на нормализованного пользователя */
async function withRoles(u) {
  if (!u) return u;
  if (u.source === 'mysql' && u.ext_id) {
    try {
      const ext = externalStore();
      let roles = rolesFromCache(u.ext_id);
      if (!roles) {
        roles = await ext.rolesOfUser(u.ext_id);
        roleCache.set(Number(u.ext_id), { at: Date.now(), roles });
      }
      const admin = roles.some(r => Number(r.is_admin) === 1) || !!u.is_admin;
      u.roles = roles.length ? roles.map(r => r.name) : ['user'];
      u.role = admin ? 'admin' : 'user';
      u.is_admin = admin ? 1 : 0;
    } catch (e) { console.error('роли:', e.message); }
  } else {
    u.roles = u.is_admin ? ['admin'] : ['user'];
    u.role = u.is_admin ? 'admin' : 'user';
  }
  return u;
}

/* =========================================================
   Нормализованный пользователь
   ========================================================= */
function normLocal(row) {
  if (!row) return null;
  return {
    id: row.id, ext_id: row.ext_id || 0,
    login: row.login, email: row.email || '',
    game_login: row.game_login || '', steam_id: row.steam_id || '',
    avatar: row.avatar || '', persona: row.persona || '',
    balance: Number(row.balance) || 0,
    is_admin: row.is_admin ? 1 : 0, game_admin: row.game_admin ? 1 : 0,
    notes: row.notes || '',
    created_at: row.created_at || 0, last_login: row.last_login || 0,
    pass_hash: row.pass_hash || '', salt: row.salt || '',
    source: row.auth_src === 'mysql' ? 'mysql' : 'local'
  };
}
function normExternal(mirror, raw, map) {
  const balance = raw && map.balance ? Number(raw[map.balance]) || 0 : (mirror.balance || 0);
  const last = raw && map.lastLog ? Date.parse(raw[map.lastLog]) || 0 : (mirror.last_login || 0);
  return {
    id: mirror.id, ext_id: mirror.ext_id || 0,
    login: (raw && map.login && raw[map.login]) || mirror.login,
    email: (raw && map.email && raw[map.email]) || mirror.email || '',
    game_login: mirror.game_login || (raw && map.gameLogin ? raw[map.gameLogin] : '') ||
                (raw && map.name ? raw[map.name] : '') || '',
    steam_id: mirror.steam_id || (raw && map.steam ? raw[map.steam] : '') || '',
    avatar: mirror.avatar || (raw && map.avatar ? raw[map.avatar] : '') || '',
    persona: mirror.persona || '',
    balance: Math.round(balance),
    is_admin: (raw && map.isAdmin && Number(raw[map.isAdmin]) === 1) ? 1 : (mirror.is_admin ? 1 : 0),
    game_admin: mirror.game_admin ? 1 : 0,
    notes: mirror.notes || '',
    created_at: mirror.created_at || 0, last_login: last,
    pass_hash: (raw && map.pass ? raw[map.pass] : '') || '',
    salt: '',
    source: 'mysql'
  };
}

/* =========================================================
   Публичное API
   ========================================================= */
let _ext = null;           // кэш внешнего источника
let _extKey = '';

function externalStore() {
  const c = cfg();
  const key = JSON.stringify(c);
  if (_ext && _extKey === key) return _ext;
  const t = c.mode === 'mysql' ? new MysqlTransport(c) : new BridgeTransport(c);
  _ext = new ExternalUsers(c, t);
  _extKey = key;
  return _ext;
}
function resetCache() { _ext = null; _extKey = ''; }

/* --- поиск --- */
async function findById(id) {
  const local = D.q.get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!local) return null;
  if (!external()) return normLocal(local);
  if (local.ext_id && local.auth_src === 'mysql') {
    try {
      const ext = externalStore();
      const raw = await ext.rawById(local.ext_id);
      if (raw) return await withRoles(normExternal(local, raw, await ext.map()));
    } catch (e) { console.error('внешняя БД:', e.message); }
  }
  return withRoles(normLocal(local));
}

async function findByLogin(login) {
  const l = String(login || '').trim();
  if (!l) return null;
  const local = D.q.get('SELECT * FROM users WHERE login = ?', l);
  if (!external()) return normLocal(local);
  try {
    const ext = externalStore();
    const raw = await ext.rawByLogin(l);
    if (raw) {
      const map = await ext.map();
      const mirror = mirrorUpsert({
        ext_id: ext.keyOf(raw, map),
        login: raw[map.login], email: raw[map.email] || '', balance: ext.balanceOf(raw)
      });
      return await withRoles(normExternal(mirror, raw, map));
    }
  } catch (e) { console.error('внешняя БД:', e.message); }
  return withRoles(normLocal(local));
}

async function findByEmail(email) {
  const m = String(email || '').trim().toLowerCase();
  if (!m) return null;
  if (!external()) {
    const r = D.q.get('SELECT * FROM users WHERE lower(email) = ? LIMIT 1', m);
    return normLocal(r);
  }
  try {
    const ext = externalStore();
    const raw = await ext.rawByEmail(m);
    if (raw) {
      const map = await ext.map();
      const mirror = mirrorUpsert({
        ext_id: ext.keyOf(raw, map),
        login: raw[map.login], email: raw[map.email] || '', balance: ext.balanceOf(raw)
      });
      return await withRoles(normExternal(mirror, raw, map));
    }
  } catch (e) { console.error('внешняя БД:', e.message); }
  const r = D.q.get('SELECT * FROM users WHERE lower(email) = ? LIMIT 1', m);
  return withRoles(normLocal(r));
}

/* проверка «занято»: в внешнем режиме смотрим во внешнюю базу,
   локальные (не зеркальные) аккаунты тоже считаем занятыми */
async function exists(login, email) {
  const l = String(login || '').trim();
  const e = String(email || '').trim().toLowerCase();
  if (!external()) {
    return {
      login: !!D.q.get('SELECT id FROM users WHERE login = ?', l),
      email: !!D.q.get('SELECT id FROM users WHERE lower(email) = ? LIMIT 1', e)
    };
  }
  let extLogin = null, extEmail = null;
  try {
    const ext = externalStore();
    extLogin = await ext.rawByLogin(l);
    if (e) extEmail = await ext.rawByEmail(e);
  } catch (err) { console.error('внешняя БД:', err.message); }
  const localLogin = D.q.get("SELECT id FROM users WHERE login = ? AND auth_src != 'mysql'", l);
  const localEmail = D.q.get("SELECT id FROM users WHERE lower(email) = ? AND auth_src != 'mysql' LIMIT 1", e);
  return {
    login: !!extLogin || !!localLogin,
    email: !!extEmail || !!localEmail
  };
}

/* что вводит пользователь: логин или почта */
async function findByLoginOrEmail(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.includes('@')) return (await findByEmail(t)) || (await findByLogin(t));
  return (await findByLogin(t)) || (await findByEmail(t));
}

/* --- проверка пароля --- */
async function verify(user, pass) {
  if (!user) return false;
  const p = String(pass || '');
  if (user.source === 'mysql') {
    const h = String(user.pass_hash || '');
    if (!h) return false;
    if (/^\$2[aby]\$/.test(h)) {
      const b = bcrypt();
      if (!b) return false;
      const norm = h.startsWith('$2y$') ? h.replace('$2y$', '$2b$') : h;
      try { return b.compareSync(p, norm); } catch { return false; }
    }
    // локальный scrypt-хеш, если внешняя строка — это наш же аккаунт
    if (user.salt) return D.checkPass(p, user.salt, h);
    return false;
  }
  return D.checkPass(p, user.salt, user.pass_hash);
}

/* --- поиск по SteamID --- */
async function findBySteam(steamId) {
  const sid = String(steamId || '').trim();
  if (!sid) return null;

  const local = D.q.get('SELECT * FROM users WHERE steam_id = ? LIMIT 1', sid);
  if (!external()) return local ? withRoles(normLocal(local)) : null;
  if (local && local.auth_src !== 'mysql') return withRoles(normLocal(local));

  try {
    const ext = externalStore();
    const map = await ext.map();
    if (map.steam) {
      const raws = await ext.rawList(100000);
      const raw = raws.find(r => String(r[map.steam] || '').trim() === sid);
      if (raw) {
        const mirror = mirrorUpsert({
          ext_id: ext.keyOf(raw, map),
          login: raw[map.login],
          email: raw[map.email] || '',
          balance: ext.balanceOf(raw)
        });
        D.q.run('UPDATE users SET steam_id = ? WHERE id = ?', sid, mirror.id);
        mirror.steam_id = sid;
        if (map.avatar) {
          const av = String(raw[map.avatar] || '').trim();
          if (av && av !== mirror.avatar) {
            D.q.run('UPDATE users SET avatar = ? WHERE id = ?', av, mirror.id);
            mirror.avatar = av;
          }
        }
        return withRoles(normExternal(mirror, raw, map));
      }
    }
  } catch (e) { console.error('findBySteam:', e.message); }

  return local ? withRoles(normLocal(local)) : null;
}

/* --- регистрация --- */
async function create({ login, email, pass, balance = 0, game_admin = 0, is_admin = 0, game_login = '', steam_id = '' }) {
  if (!external()) {
    const { salt, hash } = D.hashPass(pass);
    const r = D.q.run(`INSERT INTO users (login, email, pass_hash, salt, balance, game_admin, is_admin, steam_id, game_login, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      login, email, hash, salt, balance, game_admin, is_admin,
      steam_id || '', game_login || '', D.now());
    return { ok: true, id: Number(r.lastInsertRowid) };
  }
  const ext = externalStore();
  const exist = await ext.rawByLogin(login);
  if (exist) return { ok: false, error: 'Такой логин уже занят' };
  const ex = await ext.rawByEmail(email);
  if (ex) return { ok: false, error: 'Эта почта уже зарегистрирована' };
  const created = await ext.create({ login, email, pass, balance, game_admin, is_admin, game_login, steam_id });
  const mirror = mirrorUpsert({ ext_id: created.id, login, email, balance });
  try { await ext.setRoles(created.id, is_admin ? ['admin'] : ['user']); } catch (e) { console.error('роли:', e.message); }
  D.q.run('UPDATE users SET is_admin = ?, game_admin = ? WHERE id = ?',
    is_admin ? 1 : 0, game_admin ? 1 : 0, mirror.id);
  return { ok: true, id: mirror.id };
}

/* --- список --- */
async function list(opts = {}) {
  const search = String(opts.search || '').trim().toLowerCase();
  if (!external()) {
    let rows = D.q.all("SELECT * FROM users WHERE auth_src != 'mysql' ORDER BY id DESC");
    if (search) rows = rows.filter(r => (r.login + ' ' + r.email + ' ' + (r.game_login || '') + ' ' + (r.steam_id || '')).toLowerCase().includes(search));
    return rows.map(normLocal);
  }
  const out = [];
  const seen = new Set();
  try {
    const ext = externalStore();
    const map = await ext.map();
    const raws = await ext.rawList(opts.limit || 1000);
    const mirrors = [];
    for (const raw of raws) {
      const login = raw[map.login];
      const mirror = mirrorUpsert({
        ext_id: ext.keyOf(raw, map),
        login, email: raw[map.email] || '', balance: ext.balanceOf(raw)
      });
      seen.add(mirror.id);
      mirrors.push(mirror);
      out.push(normExternal(mirror, raw, map));
    }
    // роли — одной выборкой на всех
    const extIds = mirrors.map(m => m.ext_id).filter(Boolean);
    if (extIds.length) {
      const map2 = await ext.rolesOfUsers(extIds);
      for (const m of mirrors) {
        const roles = map2.get(Number(m.ext_id)) || [];
        const u = out.find(x => x.id === m.id);
        if (!u) continue;
        const admin = roles.some(r => Number(r.is_admin) === 1) || !!u.is_admin;
        u.roles = roles.length ? roles.map(r => r.name) : ['user'];
        u.role = admin ? 'admin' : 'user';
        u.is_admin = admin ? 1 : 0;
      }
    }
  } catch (e) { console.error('внешняя БД:', e.message); }
  // локальные аккаунты, которых нет во внешней базе (например админ портала)
  for (const row of D.q.all('SELECT * FROM users ORDER BY id DESC')) {
    if (seen.has(row.id)) continue;
    if (row.auth_src === 'mysql') continue;
    out.push(await withRoles(normLocal(row)));
  }
  if (search) out = out.filter(u => (u.login + ' ' + u.email + ' ' + u.game_login + ' ' + u.steam_id).toLowerCase().includes(search));
  return out;
}

async function count() {
  if (!external()) return D.q.get('SELECT COUNT(*) AS c FROM users').c;
  try {
    const ext = externalStore();
    const raws = await ext.rawList(100000);
    const local = D.q.get("SELECT COUNT(*) AS c FROM users WHERE auth_src != 'mysql'").c;
    return raws.length + local;
  } catch { return D.q.get('SELECT COUNT(*) AS c FROM users').c; }
}
async function countAdmins() {
  return D.q.get('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').c;
}

/* --- баланс --- */
async function getBalance(user) {
  if (!user) return 0;
  if (user.source === 'mysql' && user.ext_id) {
    try {
      const ext = externalStore();
      const raw = await ext.rawById(user.ext_id);
      if (raw) return ext.balanceOf(raw);
    } catch (e) { console.error('внешняя БД:', e.message); }
  }
  return user.balance || 0;
}
async function addBalance(user, delta) {
  const d = Math.round(Number(delta) || 0);
  if (!user) return 0;
  if (user.source === 'mysql' && user.ext_id) {
    try {
      const ext = externalStore();
      const bal = await ext.addBalanceById(user.ext_id, d);
      D.q.run('UPDATE users SET balance = ? WHERE id = ?', bal, user.id);
      return bal;
    } catch (e) {
      console.error('внешняя БД:', e.message);
      return { error: e.message };
    }
  }
  D.q.run('UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?', d, user.id);
  return D.q.get('SELECT balance FROM users WHERE id = ?', user.id).balance;
}

/* --- привязка игрового аккаунта --- */
async function setLink(user, { game_login, steam_id }) {
  if (!user) return { ok: false, error: 'нет пользователя' };
  const gl = String(game_login ?? user.game_login ?? '').trim().slice(0, 64);
  const sid = String(steam_id ?? user.steam_id ?? '').trim().slice(0, 32);
  if (sid) {
    const dup = D.q.get('SELECT id, login FROM users WHERE steam_id = ? AND id != ?', sid, user.id);
    if (dup) return { ok: false, error: 'Этот SteamID уже привязан к ' + dup.login };
  }
  D.q.run('UPDATE users SET game_login = ?, steam_id = ? WHERE id = ?', gl, sid, user.id);
  if (user.source === 'mysql' && user.ext_id) {
    try {
      const ext = externalStore();
      const map = await ext.map();
      if (map.steam) await ext.setFieldById(user.ext_id, map.steam, sid);
      if (map.gameLogin) await ext.setFieldById(user.ext_id, map.gameLogin, gl);
      if (map.name && ext.c.sync_name) await ext.setFieldById(user.ext_id, map.name, gl);
    } catch (e) { console.error('внешняя БД:', e.message); }
  }
  return { ok: true, game_login: gl, steam_id: sid };
}

/* --- права --- */
async function setRole(user, { is_admin, game_admin }) {
  if (!user) return { ok: false, error: 'нет пользователя' };
  const adm = is_admin === undefined ? user.is_admin : (is_admin ? 1 : 0);
  const ga = game_admin === undefined ? user.game_admin : (game_admin ? 1 : 0);
  D.q.run('UPDATE users SET is_admin = ?, game_admin = ? WHERE id = ?', adm, ga, user.id);
  if (user.source === 'mysql' && user.ext_id) {
    try {
      const ext = externalStore();
      const map = await ext.map();
      if (map.isAdmin) await ext.setFieldById(user.ext_id, map.isAdmin, adm);
      if (map.gameAdmin) await ext.setFieldById(user.ext_id, map.gameAdmin, ga);
      // роль admin в flux_roles — источник правды
      const cur = await ext.rolesOfUser(user.ext_id);
      const names = cur.map(r => r.name).filter(n => n !== 'admin' && n !== 'user');
      names.push(adm ? 'admin' : 'user');
      await ext.setRoles(user.ext_id, names);
      roleCache.delete(Number(user.ext_id));
    } catch (e) { console.error('внешняя БД:', e.message); }
  }
  return { ok: true, is_admin: adm, game_admin: ga };
}

/* --- заметки --- */
async function setNotes(user, notes) {
  if (!user) return { ok: false, error: 'нет пользователя' };
  const n = String(notes || '').slice(0, 300);
  D.q.run('UPDATE users SET notes = ? WHERE id = ?', n, user.id);
  return { ok: true, notes: n };
}

/* --- пароль --- */
async function setPassword(user, pass) {
  if (!user) return { ok: false, error: 'нет пользователя' };
  const p = String(pass || '');
  if (p.length < 5) return { ok: false, error: 'Пароль минимум 5 символов' };
  if (user.source === 'mysql' && user.ext_id) {
    try {
      const ext = externalStore();
      await ext.setPasswordById(user.ext_id, p);
      D.q.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  const { salt, hash } = D.hashPass(p);
  D.q.run('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', hash, salt, user.id);
  D.q.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  return { ok: true };
}

/* --- последний вход --- */
async function touchLogin(user) {
  if (!user) return;
  D.q.run('UPDATE users SET last_login = ? WHERE id = ?', D.now(), user.id);
  if (user.source === 'mysql' && user.ext_id) {
    try {
      const ext = externalStore();
      await ext.touchLogin(user.ext_id);
    } catch (e) { console.error('внешняя БД:', e.message); }
  }
}

/* =========================================================
   flux_steam — аккаунты для входа через Steam
   (локальная таблица + такая же во внешней MySQL)
   ========================================================= */
let _steamDdlDone = false;
async function ensureSteamTable() {
  if (_steamDdlDone) return true;
  const c = cfg();
  if (c.mode !== 'mysql') { _steamDdlDone = true; return false; }
  try {
    const ext = externalStore();
    await ext.t.run(`CREATE TABLE IF NOT EXISTS \`flux_steam\` (
      steam_id   VARCHAR(20)  NOT NULL,
      steam64    VARCHAR(20)  NOT NULL DEFAULT '',
      persona    VARCHAR(128) NOT NULL DEFAULT '',
      avatar     VARCHAR(255) NOT NULL DEFAULT '',
      background VARCHAR(255) NOT NULL DEFAULT '',
      login      VARCHAR(64)  NOT NULL DEFAULT '',
      user_id    INT          NOT NULL DEFAULT 0,
      first_seen DATETIME     NULL,
      last_login DATETIME     NULL,
      last_ip    VARCHAR(64)  NOT NULL DEFAULT '',
      PRIMARY KEY (steam_id),
      KEY login_idx (login)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, []);
    _steamDdlDone = true;
    return true;
  } catch (e) {
    console.error('flux_steam (создание):', e.message);
    return false;
  }
}

/* запомнить/обновить Steam-аккаунт (вызывается при входе через Steam) */
async function steamRemember({ steam_id, steam64, persona, avatar, background, login, user_id, ip }) {
  const sid = String(steam_id || '').trim().slice(0, 20);
  if (!sid) return false;
  const now = D.now();
  const row = {
    steam64: String(steam64 || '').slice(0, 20),
    persona: String(persona || '').slice(0, 128),
    avatar: String(avatar || '').slice(0, 255),
    background: String(background || '').slice(0, 255),
    login: String(login || '').slice(0, 64),
    user_id: Number(user_id) || 0,
    last_ip: String(ip || '').slice(0, 64)
  };
  try {
    D.q.run(`INSERT INTO flux_steam
      (steam_id, steam64, persona, avatar, background, login, user_id, first_seen, last_login, last_ip)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(steam_id) DO UPDATE SET
        steam64 = excluded.steam64, persona = excluded.persona, avatar = excluded.avatar,
        background = excluded.background, login = excluded.login, user_id = excluded.user_id,
        last_login = excluded.last_login, last_ip = excluded.last_ip`,
      sid, row.steam64, row.persona, row.avatar, row.background, row.login, row.user_id, now, now, row.last_ip);
  } catch (e) { console.error('flux_steam (локально):', e.message); }

  if (cfg().mode === 'mysql') {
    try {
      await ensureSteamTable();
      const ext = externalStore();
      await ext.t.run(`INSERT INTO \`flux_steam\`
        (steam_id, steam64, persona, avatar, background, login, user_id, first_seen, last_login, last_ip)
        VALUES (?,?,?,?,?,?,?,NOW(),NOW(),?)
        ON DUPLICATE KEY UPDATE
          steam64 = VALUES(steam64), persona = VALUES(persona), avatar = VALUES(avatar),
          background = VALUES(background), login = VALUES(login), user_id = VALUES(user_id),
          last_login = NOW(), last_ip = VALUES(last_ip)`,
        [sid, row.steam64, row.persona, row.avatar, row.background, row.login, row.user_id, row.last_ip]);
    } catch (e) { console.error('flux_steam (mysql):', e.message); }
  }
  return true;
}

/* сохранить ник/аватар Steam в профиль портала */
async function setSteamProfile(user, { persona, avatar } = {}) {
  if (!user) return false;
  const av = String(avatar || '').trim().slice(0, 255);
  const ps = String(persona || '').trim().slice(0, 128);
  if (av) D.q.run('UPDATE users SET avatar = ? WHERE id = ?', av, user.id);
  if (ps) D.q.run('UPDATE users SET persona = ? WHERE id = ?', ps, user.id);
  if (user.source === 'mysql' && user.ext_id) {
    try {
      const ext = externalStore();
      if (av) await ext.setFieldById(user.ext_id, 'avatar', av);
    } catch (e) { console.error('аватар Steam:', e.message); }
  }
  if (user.id) {
    user.avatar = av || user.avatar;
    user.persona = ps || user.persona;
  }
  return true;
}

/* --- перенос локального аккаунта во внешнюю базу --- */
async function migrateLocal(user, pass) {
  if (!user) return { ok: false, error: 'нет пользователя' };
  if (user.source === 'mysql' && user.ext_id) return { ok: false, error: 'аккаунт уже во внешней базе' };
  const p = String(pass || '');
  if (p.length < 5) return { ok: false, error: 'пароль минимум 5 символов' };
  const ext = externalStore();
  const exist = await ext.rawByLogin(user.login);
  if (exist) return { ok: false, error: 'такой логин уже есть во внешней базе' };
  const created = await ext.create({
    login: user.login, email: user.email, pass: p,
    balance: user.balance, game_login: user.game_login, steam_id: user.steam_id,
    game_admin: user.game_admin, is_admin: user.is_admin
  });
  D.q.run('UPDATE users SET ext_id = ?, auth_src = ? WHERE id = ?', created.id, 'mysql', user.id);
  try { await ext.setRoles(created.id, user.is_admin ? ['admin'] : ['user']); } catch (e) { console.error('роли:', e.message); }
  roleCache.delete(Number(created.id));
  return { ok: true, ext_id: created.id };
}

/* --- роли --- */
async function listRoles() {
  if (!external()) {
    return [
      { id: 1, name: 'user', title: 'Пользователь', is_admin: 0 },
      { id: 2, name: 'admin', title: 'Администратор', is_admin: 1 }
    ];
  }
  try {
    const ext = externalStore();
    return await ext.listRoles();
  } catch (e) { console.error('роли:', e.message); return []; }
}
async function setUserRoles(user, names) {
  if (!user) return { ok: false, error: 'нет пользователя' };
  const list = (names || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return { ok: false, error: 'нужна хотя бы одна роль' };
  if (user.source !== 'mysql' || !user.ext_id) {
    // локальный аккаунт: роль админа хранится в самом портале
    const adm = list.includes('admin');
    D.q.run('UPDATE users SET is_admin = ? WHERE id = ?', adm ? 1 : 0, user.id);
    return { ok: true, roles: list };
  }
  try {
    const ext = externalStore();
    const known = (await ext.listRoles()).map(r => r.name);
    const unknown = list.filter(n => !known.includes(n));
    if (unknown.length) return { ok: false, error: 'нет таких ролей: ' + unknown.join(', ') };
    await ext.setRoles(user.ext_id, list);
    roleCache.delete(Number(user.ext_id));
    // права админа держим в одном месте с ролью
    const isAdmin = list.includes('admin') ? 1 : 0;
    try {
      const map = await ext.map();
      if (map.isAdmin) await ext.setFieldById(user.ext_id, map.isAdmin, isAdmin);
    } catch (e) { console.error('внешняя БД:', e.message); }
    D.q.run('UPDATE users SET is_admin = ? WHERE id = ?', isAdmin, user.id);
    return { ok: true, roles: list };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* --- проверка связи и структуры --- */
async function test() {
  const c = cfg();
  if (c.mode === 'local') return { ok: true, mode: 'local', info: { note: 'используется встроенная база портала' } };
  try {
    const ext = externalStore();
    const p = await ext.t.ping();
    const tables = await ext.t.tables();
    return { ok: true, mode: c.mode, info: p.info, tables };
  } catch (e) {
    return { ok: false, mode: c.mode, error: e.message };
  }
}
async function structure() {
  const c = cfg();
  if (c.mode === 'local') return { ok: true, mode: 'local', table: 'users (SQLite)', columns: [], missing: [] };
  try {
    const ext = externalStore();
    const st = await ext.structure();
    return { ok: true, mode: c.mode, ...st };
  } catch (e) {
    return { ok: false, mode: c.mode, error: e.message };
  }
}

/* --- массовый импорт --- */
async function importCsv(csv) {
  const lines = String(csv || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return { added: 0, updated: 0, skipped: 0, errors: ['Пустой список'] };
  const sep = s => (s.includes(';') ? ';' : ',');
  const flag = v => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'да', 'on'].includes(s)) return 1;
    if (['0', 'false', 'no', 'нет', 'off'].includes(s)) return 0;
    return null;
  };
  let added = 0, updated = 0, skipped = 0;
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(sep(lines[i])).map(s => s.trim());
    if (!parts[0] || parts[0].startsWith('#')) { skipped++; continue; }
    const [login, email, gameLogin, steamId, balance, gameAdmin, isAdmin] = parts;
    if (!/^[A-Za-z0-9_]{3,20}$/.test(login || '')) { errors.push(`строка ${i + 1}: плохой логин «${login}»`); continue; }
    const mail = String(email || '').trim().toLowerCase();
    const gl = String(gameLogin || '').slice(0, 64);
    const sid = String(steamId || '').slice(0, 32);
    const bal = Math.max(0, Math.round(Number(balance) || 0));
    const ga = flag(gameAdmin);
    const ia = flag(isAdmin);
    try {
      const exist = await findByLogin(login);
      if (exist) {
        if (mail || gl || sid) await setLink(exist, { game_login: gl || exist.game_login, steam_id: sid || exist.steam_id });
        if (bal > 0) await addBalance(exist, 0);
        if (ga !== null) await setRole(exist, { game_admin: ga });
        if (ia !== null) await setRole(exist, { is_admin: ia });
        updated++;
      } else {
        const pass = require('node:crypto').randomBytes(6).toString('base64url');
        const r = await create({ login, email: mail, pass, balance: bal, game_admin: ga || 0, is_admin: ia || 0, game_login: gl, steam_id: sid });
        if (!r.ok) { errors.push(`строка ${i + 1}: ${r.error}`); continue; }
        added++;
      }
    } catch (e) {
      errors.push(`строка ${i + 1}: ${e.message}`);
    }
  }
  return { added, updated, skipped, errors: errors.slice(0, 20) };
}

/* --- выгрузка --- */
async function exportCsv() {
  const all = await list({ limit: 100000 });
  const head = 'login;email;game_login;steam_id;balance;game_admin;is_admin';
  const rows = all.map(u => [u.login, u.email, u.game_login, u.steam_id, u.balance, u.game_admin, u.is_admin].join(';'));
  return '﻿' + [head, ...rows].join('\r\n');
}

module.exports = {
  cfg, setCfg, external, resetCache,
  findById, findByLogin, findByEmail, findByLoginOrEmail, findBySteam, verify, exists,
  create, list, count, countAdmins,
  getBalance, addBalance, setLink, setRole, setNotes, setPassword, touchLogin,
  setSteamProfile, steamRemember, ensureSteamTable,
  listRoles, setUserRoles, withRoles, migrateLocal,
  test, structure, importCsv, exportCsv
};
