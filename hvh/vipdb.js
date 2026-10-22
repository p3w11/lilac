'use strict';
/* =========================================================
   Модуль работы с базой VIP.

   Типичный VIP-плагин для SourceMod (VipModule, VIP System и т.п.)
   хранит игроков в SQLite-файле рядом с плагином, например:
       addons/vipmodule/vipusers.db
   таблица вида:
       vipusers(authid TEXT, vip INTEGER, expiration INTEGER,
                credit INTEGER, ncredit INTEGER, group TEXT)

   Здесь мы НЕ угадываем структуру: админ указывает файл, таблицу и
   SQL-шаблон выдачи, который мы подставляем и выполняем. Так работает
   с любым плагином.

   Поддерживается и «просто SQL-файл», и внешняя БД через переменную
   окружения (если плагин пишет в MySQL — см. README).
   ========================================================= */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const D = require('./db');

let cached = null;      // { file, mtime, db }
let cachedPath = '';

function cfg() {
  const s = D.getSettings('vipdb') || {};
  return {
    file: String(s.file || '').trim(),
    table: String(s.table || 'vipusers').trim(),
    template: String(s.template || '').trim(),
    days: Number(s.days) || 30,
    credit: Number(s.credit) || 0,
    group: String(s.group || '').trim(),
    steam_format: String(s.steam_format || 'steam2').trim()
  };
}

const saveCfg = c => D.setSettings('vipdb', {
  file: String(c.file || '').trim(),
  table: String(c.table || 'vipusers').trim(),
  template: String(c.template || '').trim(),
  days: Number(c.days) || 30,
  credit: Number(c.credit) || 0,
  group: String(c.group || '').trim(),
  steamFormat: String(c.steam_format || 'steam2').trim()
});

/* ---------- SteamID в нужном формате ---------- */
function toSteam2(id) {
  // STEAM_0:1:XXXXX  <- из STEAM_0:X:YYYYY
  const m = /^STEAM_([0-5]):([0-9]):(\d+)$/i.exec(String(id).trim());
  if (!m) return String(id).trim();
  const acc = Number(m[3]);
  return 'STEAM_' + m[1] + ':' + (acc % 2) + ':' + Math.floor(acc / 2);
}
function toSteam3(id) {
  // STEAM_0:X:YYYYY <- из STEAM_0:1:XXXXX
  const m = /^STEAM_([0-5]):([0-9]):(\d+)$/i.exec(String(id).trim());
  if (!m) return String(id).trim();
  const base = Number(m[3]) * 2 + Number(m[2]);
  return 'STEAM_' + m[1] + ':X:' + base;
}
function formatSteamId(id) {
  const f = cfg().steamFormat;
  if (f === 'steam3') return toSteam3(id);
  if (f === 'steam2') return toSteam2(id);
  return String(id).trim();
}

/* ---------- открытие базы ---------- */
function open() {
  const c = cfg();
  if (!c.file) throw new Error('файл базы не указан');
  if (!fs.existsSync(c.file)) throw new Error('файла нет: ' + c.file);
  const st = fs.statSync(c.file);
  if (cached && cachedPath === c.file && cached.mtime === st.mtimeMs) return cached.db;
  if (cached) { try { cached.db.close(); } catch {} }
  const db = new DatabaseSync(c.file);
  db.exec('PRAGMA journal_mode = WAL');
  cached = { file: c.file, mtime: st.mtimeMs, db };
  cachedPath = c.file;
  return db;
}

/* ---------- диагностика ---------- */
function inspect() {
  const c = cfg();
  if (!c.file) return { ok: false, error: 'файл базы не указан', file: c.file };
  if (!fs.existsSync(c.file)) return { ok: false, error: 'файла нет: ' + c.file, file: c.file };
  try {
    const db = open();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(r => r.name);
    let rows = [];
    let columns = [];
    if (tables.includes(c.table)) {
      columns = db.prepare(`PRAGMA table_info(${c.table})`).all().map(x => x.name);
      rows = db.prepare(`SELECT * FROM ${c.table} LIMIT 50`).all();
    }
    return { ok: true, file: c.file, size: fs.statSync(c.file).size, tables, table: c.table, columns, rows, count: rows.length };
  } catch (e) {
    return { ok: false, error: e.message, file: c.file };
  }
}

/* ---------- выдача ---------- */
function issueVip(steamid, name) {
  const c = cfg();
  if (!c.template) return { ok: false, error: 'не задан SQL-шаблон выдачи' };

  const tpl = c.template
    .replace(/\{steamid\}/g, formatSteamId(steamid))
    .replace(/\{steam2\}/g, toSteam2(steamid))
    .replace(/\{steam3\}/g, toSteam3(steamid))
    .replace(/\{name\}/g, String(name || '').replace(/'/g, ''))
    .replace(/\{days\}/g, String(c.days))
    .replace(/\{credit\}/g, String(c.credit))
    .replace(/\{group\}/g, c.group.replace(/'/g, ''));

  try {
    const db = open();
    db.exec(tpl);
    return { ok: true, sql: tpl };
  } catch (e) {
    return { ok: false, error: 'SQL: ' + e.message, sql: tpl };
  }
}

/* ---------- список VIP-игроков ---------- */
function listVip(limit = 100) {
  const c = cfg();
  try {
    const db = open();
    if (!c.table) return { ok: false, error: 'таблица не указана' };
    const rows = db.prepare(`SELECT * FROM ${c.table} LIMIT ${Number(limit) || 100}`).all();
    return { ok: true, rows, table: c.table };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { cfg, saveCfg, open, inspect, issueVip, listVip, formatSteamId, toSteam2, toSteam3 };
