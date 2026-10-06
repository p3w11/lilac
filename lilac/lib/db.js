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

/* ---------- роли ---------- */

const ROLES = ['user', 'moderator', 'admin'];

/** Что умеет каждая роль. Проверяется на сервере. */
const ROLE_RIGHTS = {
  user: {},
  moderator: { deleteAnyMessage: true },
  admin: { deleteAnyMessage: true, deleteUsers: true, manageRoles: true, clearChats: true },
};

const can = (user, right) => Boolean(user && ROLE_RIGHTS[user.role || 'user'] && ROLE_RIGHTS[user.role][right]);

/* ---------- настройки приватности ---------- */

// Значения по умолчанию — как в Telegram/Discord: всё открыто.
// 'contacts' — только тем, с кем уже есть личная переписка.
const DEFAULT_SETTINGS = {
  profileVisibility: 'everyone', // кто видит профиль
  onlineStatus: 'everyone', // кто видит мой онлайн
  directMessages: 'everyone', // кто может писать в личку
  typingIndicator: 'everyone', // кто видит, что я печатаю
  readReceipts: 'everyone', // кому отправлять «прочитано»
};

const SETTING_LEVELS = ['everyone', 'contacts', 'nobody'];

const SETTING_LABELS = {
  profileVisibility: 'Видимость профиля',
  onlineStatus: 'Видимость онлайна',
  directMessages: 'Личные сообщения',
  typingIndicator: 'Индикатор набора',
  readReceipts: 'Отметки о прочтении',
};

/** Приводит присланные настройки к допустимым значениям. */
function sanitizeSettings(input) {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = input && input[key];
    if (SETTING_LEVELS.includes(value)) out[key] = value;
  }
  return out;
}

/* ---------- база ---------- */

const EMPTY = { users: [], rooms: [], messages: [], reads: {}, nextUserId: 1, nextMsgId: 1, nextRoomId: 1 };

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
      // Старые аккаунты без настроек/ролей достраиваем на лету
      for (const u of state.users) {
        if (!u.settings) u.settings = { ...DEFAULT_SETTINGS };
        if (!ROLES.includes(u.role)) u.role = 'user';
      }
      if (!state.reads) state.reads = {};
      if (!state.rooms) state.rooms = [];
      if (!state.nextRoomId) state.nextRoomId = 1;
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

/**
 * Записывает файл через временный и переименовывает.
 * Переименование может не сработать — например, если файл держит
 * синхронизация OneDrive. Поэтому делаем несколько попыток.
 */
function flush() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, FILE);
      return;
    } catch (err) {
      lastError = err;
      // Windows иногда отдаёт EPERM, если файл на секунду занят
      if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') break;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 30 * (attempt + 1));
    }
  }

  // запасной путь: пишем прямо в файл, пусть даже не атомарно
  try {
    fs.writeFileSync(FILE, JSON.stringify(state));
  } catch (err) {
    console.error('[db] не удалось сохранить:', lastError?.message, '/', err.message);
  }
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

/* ---------- пользователи ---------- */

const normalize = (name) => String(name || '').trim().toLowerCase();

function findUserByUsername(username) {
  const key = normalize(username);
  return state.users.find((u) => u.username === key) || null;
}

function getUserById(id) {
  return state.users.find((u) => u.id === id) || null;
}

function addUser({ username, passwordHash, displayName, bio = '', role = 'user', settings = null }) {
  const user = {
    id: state.nextUserId++,
    username: normalize(username),
    displayName: displayName || null,
    bio: String(bio || '').slice(0, 200),
    passwordHash,
    role: ROLES.includes(role) ? role : 'user',
    settings: settings ? sanitizeSettings(settings) : { ...DEFAULT_SETTINGS },
    createdAt: Date.now(),
  };
  state.users.push(user);
  save();
  return user;
}

/** То, что видят другие люди. Настройки приватности сюда НЕ попадают. */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    bio: user.bio || '',
    role: user.role || 'user',
  };
}

/** То, что видит сам человек: публичное + его настройки. */
function privateUser(user) {
  return { ...publicUser(user), settings: sanitizeSettings(user.settings) };
}

const hasRight = can;

function updateProfile(id, { displayName, bio }) {
  const user = getUserById(id);
  if (!user) return null;
  if (displayName !== undefined) user.displayName = String(displayName).trim().slice(0, 32) || null;
  if (bio !== undefined) user.bio = String(bio).trim().slice(0, 200);
  save();
  return user;
}

function updateSettings(id, patch) {
  const user = getUserById(id);
  if (!user) return null;
  user.settings = sanitizeSettings({ ...user.settings, ...patch });
  save();
  return user;
}

/** Смена роли. Возвращает false, если роль недопустима. */
function setRole(id, role) {
  if (!ROLES.includes(role)) return false;
  const user = getUserById(id);
  if (!user) return false;
  user.role = role;
  save();
  return true;
}

function updatePassword(id, passwordHash) {
  const user = getUserById(id);
  if (!user) return null;
  user.passwordHash = passwordHash;
  save();
  return user;
}

/* ---------- переписки и видимость ---------- */

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

/** Есть ли уже личная переписка между двумя людьми. */
function hasDmBetween(a, b) {
  const room = dmRoom(a, b);
  return state.messages.some((m) => m.room === room);
}

/**
 * Проверка уровня приватности: может ли viewer видеть то, что скрыто
 * настройкой target. 'contacts' трактуется как «есть общая переписка».
 */
function visibilityAllowed(level, viewer, target) {
  if (!target || !viewer) return false;
  if (viewer.id === target.id) return true;
  const setting = (sanitizeSettings(target.settings) || {})[level];
  if (setting === 'nobody') return false;
  if (setting === 'contacts') return hasDmBetween(viewer.id, target.id);
  return true; // everyone
}

const canSeeProfile = (viewer, target) => visibilityAllowed('profileVisibility', viewer, target);
const canSeeOnline = (viewer, target) => visibilityAllowed('onlineStatus', viewer, target);
const canSendDm = (viewer, target) => visibilityAllowed('directMessages', viewer, target);
const canSeeTyping = (viewer, target) => visibilityAllowed('typingIndicator', viewer, target);
const canSeeRead = (viewer, target) => visibilityAllowed('readReceipts', viewer, target);

/* ---------- сообщения ---------- */

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

/** Последнее прочитанное время пользователя в комнате. */
function getRead(userId, room) {
  const byRoom = state.reads[String(userId)] || {};
  return byRoom[room] || 0;
}

function markRead(userId, room, ts) {
  const key = String(userId);
  if (!state.reads[key]) state.reads[key] = {};
  if ((state.reads[key][room] || 0) >= ts) return state.reads[key][room];
  state.reads[key][room] = ts;
  save();
  return ts;
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

/* ---------- группы и каналы ---------- */

const ROOM_KINDS = ['group', 'channel'];

/** Ключ комнаты в поле room у сообщений: "group:1" или "channel:2". */
function roomKey(kind, id) {
  return `${kind}:${id}`;
}

/** Разбирает "group:1" в ['group', 1]. null, если это не группа/канал. */
function parseRoomKey(key) {
  const parts = String(key || '').split(':');
  if (parts.length !== 2 || !ROOM_KINDS.includes(parts[0])) return null;
  const id = Number(parts[1]);
  if (!Number.isInteger(id)) return null;
  return [parts[0], id];
}

function getRoom(kind, id) {
  return state.rooms.find((r) => r.kind === kind && r.id === Number(id)) || null;
}

function addRoom({ kind, name, description = '', ownerId, members = [], isPublic = false }) {
  const room = {
    id: state.nextRoomId++,
    kind,
    name: String(name || '').trim().slice(0, 40) || (kind === 'channel' ? 'Канал' : 'Группа'),
    description: String(description || '').trim().slice(0, 200),
    ownerId,
    members: [...new Set([ownerId, ...members.map(Number).filter(Number.isInteger)])],
    mods: [],
    isPublic: Boolean(isPublic),
    createdAt: Date.now(),
  };
  state.rooms.push(room);
  save();
  return room;
}

const isMember = (room, userId) => Boolean(room) && room.members.includes(Number(userId));
const isRoomAdmin = (room, userId) =>
  Boolean(room) && (room.ownerId === Number(userId) || room.mods.includes(Number(userId)));

/** Публичные каналы видны всем, чтобы в них можно было зайти. */
const isVisible = (room, userId) =>
  isMember(room, userId) || (room.kind === 'channel' && room.isPublic);

/**
 * В группе писать может любой участник, в канале — только владелец и помощники.
 */
function canPostIn(room, userId) {
  if (!room) return false;
  if (room.kind === 'group') return isMember(room, userId);
  return isRoomAdmin(room, userId);
}

/** Комнаты, которые показываем пользователю в боковой панели. */
function listRoomsForUser(userId) {
  return state.rooms.filter((r) => isVisible(r, userId));
}

function roomMembers(room) {
  return room.members.map((id) => getUserById(id)).filter(Boolean).map(publicUser);
}

/** Краткая карточка для боковой панели. */
function roomSummary(room, viewerId) {
  const last = lastMessageIn(roomKey(room.kind, room.id));
  return {
    room: roomKey(room.kind, room.id),
    kind: room.kind,
    id: room.id,
    name: room.name,
    description: room.description,
    members: room.members.length,
    isPublic: room.isPublic,
    isOwner: room.ownerId === Number(viewerId),
    isAdmin: isRoomAdmin(room, viewerId),
    canPost: canPostIn(room, viewerId),
    lastText: last ? last.text : '',
    lastTs: last ? last.ts : room.createdAt,
    lastName: last ? last.displayName : '',
  };
}

function updateRoom(kind, id, { name, description }) {
  const room = getRoom(kind, id);
  if (!room) return null;
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, 40);
    if (!clean) return room;
    room.name = clean;
  }
  if (description !== undefined) room.description = String(description).trim().slice(0, 200);
  save();
  return room;
}

function addMember(kind, id, userId) {
  const room = getRoom(kind, id);
  const target = getUserById(userId);
  if (!room || !target) return false;
  if (room.members.includes(target.id)) return false;
  room.members.push(target.id);
  save();
  return true;
}

function removeMember(kind, id, userId) {
  const room = getRoom(kind, id);
  if (!room) return false;
  const i = room.members.indexOf(Number(userId));
  if (i < 0) return false;
  room.members.splice(i, 1);
  room.mods = room.mods.filter((m) => m !== Number(userId));
  save();
  return true;
}

/** Назначает или снимает помощника администратора. */
function toggleMod(kind, id, userId) {
  const room = getRoom(kind, id);
  if (!room) return null;
  const uid = Number(userId);
  if (room.ownerId === uid) return room.mods.includes(uid) ? 'owner' : 'owner';
  const i = room.mods.indexOf(uid);
  if (i >= 0) {
    room.mods.splice(i, 1);
    save();
    return false;
  }
  if (!room.members.includes(uid)) return null;
  room.mods.push(uid);
  save();
  return true;
}

/** Удаляет комнату вместе с её сообщениями. */
function deleteRoom(kind, id) {
  const idx = state.rooms.findIndex((r) => r.kind === kind && r.id === Number(id));
  if (idx < 0) return false;
  state.rooms.splice(idx, 1);
  const key = roomKey(kind, id);
  state.messages = state.messages.filter((m) => m.room !== key);
  for (const byRoom of Object.values(state.reads)) delete byRoom[key];
  save();
  return true;
}

/** Все комнаты для админки, со счётчиками. */
function adminRooms() {
  return state.rooms
    .map((r) => {
      const key = roomKey(r.kind, r.id);
      const messages = state.messages.filter((m) => m.room === key);
      return {
        room: key,
        kind: r.kind,
        id: r.id,
        name: r.name,
        description: r.description,
        members: r.members.length,
        messages: messages.length,
        owner: publicUser(getUserById(r.ownerId)),
        isPublic: r.isPublic,
        createdAt: r.createdAt,
        lastMessageAt: messages.length ? messages[messages.length - 1].ts : r.createdAt,
      };
    })
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
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
      settings: sanitizeSettings(u.settings),
    }))
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
}

/** Удаляет пользователя вместе со всеми его сообщениями. */
function deleteUser(id) {
  const idx = state.users.findIndex((u) => u.id === id);
  if (idx < 0) return false;
  state.users.splice(idx, 1);
  state.messages = state.messages.filter((m) => m.userId !== id);
  delete state.reads[String(id)];
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

/** Всего сообщений во всех чатах. */
function messageCount() {
  return state.messages.length;
}

load();

module.exports = {
  DATA_DIR,
  ROLES,
  ROLE_RIGHTS,
  DEFAULT_SETTINGS,
  SETTING_LEVELS,
  SETTING_LABELS,
  findUserByUsername,
  getUserById,
  addUser,
  publicUser,
  privateUser,
  hasRight,
  updateProfile,
  updateSettings,
  setRole,
  updatePassword,
  dmRoom,
  parseDmRoom,
  hasDmBetween,
  visibilityAllowed,
  canSeeProfile,
  canSeeOnline,
  canSendDm,
  canSeeTyping,
  canSeeRead,
  addMessage,
  getMessages,
  lastMessageIn,
  getRead,
  markRead,
  dmRooms,
  listUsers,
  ROOM_KINDS,
  roomKey,
  parseRoomKey,
  getRoom,
  addRoom,
  isMember,
  isRoomAdmin,
  canPostIn,
  isVisible,
  listRoomsForUser,
  roomMembers,
  roomSummary,
  updateRoom,
  addMember,
  removeMember,
  toggleMod,
  deleteRoom,
  adminRooms,
  adminUsers,
  deleteUser,
  deleteMessage,
  clearMessages,
  recentMessages,
  messageCount,
};
