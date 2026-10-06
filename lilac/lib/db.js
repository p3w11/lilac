'use strict';

/**
 * Хранилище данных.
 * По умолчанию — обычный JSON-файл в ./data (не требует БД и работает везде).
 * Если хочешь постоянное хранилище на бесплатном хостинге — см. README (Neon/Supabase).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

const MAX_MESSAGES = 5000; // чтобы файл не разрастался бесконечно

const EMPTY = { users: [], messages: [], nextUserId: 1, nextMsgId: 1 };

let state = clone(EMPTY);
let timer = null;

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = Object.assign(clone(EMPTY), parsed);
      console.log(`[db] загружено: ${state.users.length} юзеров, ${state.messages.length} сообщений`);
    } else {
      console.log('[db] создан новый файл данных');
      flush();
    }
  } catch (err) {
    console.error('[db] не удалось прочитать файл, начинаем заново:', err.message);
    state = clone(EMPTY);
  }
}

function flush() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}

function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      flush();
    } catch (err) {
      console.error('[db] ошибка записи:', err.message);
    }
  }, 250);
}

/* ---------- users ---------- */

const normalize = (name) => String(name || '').trim().toLowerCase();

function findUserByUsername(username) {
  const key = normalize(username);
  return state.users.find((u) => u.username === key) || null;
}

function getUserById(id) {
  return state.users.find((u) => u.id === id) || null;
}

function addUser({ username, passwordHash, displayName, isAdmin = false }) {
  const user = {
    id: state.nextUserId++,
    username: normalize(username),
    displayName: displayName || null,
    passwordHash,
    isAdmin: Boolean(isAdmin),
    createdAt: Date.now(),
  };
  state.users.push(user);
  save();
  return user;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    isAdmin: Boolean(user.isAdmin),
  };
}

/* ---------- messages ---------- */

function dmRoom(a, b) {
  const [x, y] = [a, b].sort((m, n) => m - n);
  return `dm:${x}:${y}`;
}

/** Разбирает "dm:1:2" в [1, 2]. null, если это не личная переписка. */
function parseDmRoom(room) {
  const parts = String(room || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'dm') return null;
  const a = Number(parts[1]);
  const b = Number(parts[2]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  return [a, b];
}

function addMessage({ room, user, text }) {
  const msg = {
    id: state.nextMsgId++,
    room,
    userId: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    text,
    ts: Date.now(),
  };
  state.messages.push(msg);
  if (state.messages.length > MAX_MESSAGES) {
    state.messages = state.messages.slice(state.messages.length - MAX_MESSAGES);
  }
  save();
  return msg;
}

/** Последние сообщения комнаты, снизу вверх (как в мессенджерах). */
function getMessages(room, limit = 50, before = 0) {
  let list = state.messages.filter((m) => m.room === room);
  if (before) list = list.filter((m) => m.ts < before);
  return list.slice(-limit).reverse();
}

function lastMessageIn(room) {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].room === room) return state.messages[i];
  }
  return null;
}

/** Список личных переписок пользователя + последнее сообщение в каждой. */
function dmRooms(userId) {
  const rooms = new Map();
  for (const m of state.messages) {
    const ids = parseDmRoom(m.room);
    if (!ids) continue;
    const [x, y] = ids;
    if (x !== userId && y !== userId) continue;
    const prev = rooms.get(m.room);
    if (!prev || prev.ts < m.ts) rooms.set(m.room, m);
  }
  return [...rooms.values()].sort((a, b) => b.ts - a.ts);
}

/** Список всех юзеров (для поиска собеседника). */
function listUsers(excludeId) {
  return state.users
    .filter((u) => u.id !== excludeId)
    .map(publicUser)
    .sort((a, b) => a.username.localeCompare(b.username));
}

/* ---------- админка ---------- */

/** Сводка по каждому пользователю: сколько сообщений и когда последнее. */
function userStats() {
  const stats = new Map();
  for (const u of state.users) {
    stats.set(u.id, { messages: 0, lastMessageAt: 0 });
  }
  for (const m of state.messages) {
    const s = stats.get(m.userId);
    if (!s) continue;
    s.messages += 1;
    if (m.ts > s.lastMessageAt) s.lastMessageAt = m.ts;
  }
  return stats;
}

/** Все пользователи со статистикой, для админ-панели. */
function adminUsers() {
  const stats = userStats();
  return state.users
    .map((u) => ({
      ...publicUser(u),
      createdAt: u.createdAt,
      messages: stats.get(u.id).messages,
      lastMessageAt: stats.get(u.id).lastMessageAt,
    }))
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
}

/** Удаляет пользователя вместе со всеми его сообщениями. */
function deleteUser(id) {
  const idx = state.users.findIndex((u) => u.id === id);
  if (idx < 0) return false;
  state.users.splice(idx, 1);
  state.messages = state.messages.filter((m) => m.userId !== id);
  save();
  return true;
}

function deleteMessage(id) {
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  state.messages.splice(idx, 1);
  save();
  return true;
}

/** Очищает комнату, либо весь чат, если комната не указана. */
function clearMessages(room) {
  const before = state.messages.length;
  state.messages = room ? state.messages.filter((m) => m.room !== room) : [];
  save();
  return before - state.messages.length;
}

/** Последние сообщения из всех комнат — для просмотра переписки. */
function recentMessages(limit = 60) {
  return state.messages.slice(-limit).reverse();
}

load();

module.exports = {
  DATA_DIR,
  findUserByUsername,
  getUserById,
  addUser,
  publicUser,
  dmRoom,
  parseDmRoom,
  addMessage,
  getMessages,
  lastMessageIn,
  dmRooms,
  listUsers,
  adminUsers,
  deleteUser,
  deleteMessage,
  clearMessages,
  recentMessages,
};
