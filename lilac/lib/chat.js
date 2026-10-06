'use strict';

const { WebSocketServer } = require('ws');
const auth = require('./auth');
const db = require('./db');

const GENERAL = 'general';
const MAX_TEXT = 2000;

const sanitize = (s) =>
  String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();

/** Кто онлайн: Map<userId, Set<ws>> */
const online = new Map();

function addOnline(userId, ws) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(ws);
}

function removeOnline(userId, ws) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) online.delete(userId);
}

function onlineUsers() {
  return [...online.keys()].map((id) => db.getUserById(id)).filter(Boolean).map(db.publicUser);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastAll(payload, except = null) {
  for (const set of online.values()) {
    for (const ws of set) if (ws !== except) send(ws, payload);
  }
}

function sendToUser(userId, payload) {
  const set = online.get(userId);
  if (!set) return;
  for (const ws of set) send(ws, payload);
}

/** Может ли пользователь читать/писать в комнату. */
function canAccessRoom(user, room) {
  if (room === GENERAL) return true;
  const ids = db.parseDmRoom(room);
  if (!ids) return false;
  const [x, y] = ids;
  return x === user.id || y === user.id;
}

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const user = auth.userFromCookieHeader(req.headers.cookie);
    if (!user) {
      send(ws, { t: 'error', error: 'Нужно войти в аккаунт' });
      ws.close();
      return;
    }

    ws.userId = user.id;
    ws.isAlive = true;
    const wasOffline = !online.has(user.id);
    addOnline(user.id, ws);

    send(ws, {
      t: 'hello',
      user: db.publicUser(user),
      online: onlineUsers(),
    });
    if (wasOffline) broadcastAll({ t: 'presence', online: onlineUsers() }, ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return send(ws, { t: 'error', error: 'Некорректный запрос' });
      }
      handleMessage(ws, user, data);
    });

    ws.on('close', () => {
      removeOnline(user.id, ws);
      if (!online.has(user.id)) broadcastAll({ t: 'presence', online: onlineUsers() });
    });
  });

  // Рвём мёртвые соединения, чтобы список онлайна был честным
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  interval.unref();

  return wss;
}

function handleMessage(ws, user, data) {
  switch (data && data.t) {
    case 'send': {
      const room = String(data.room || GENERAL);
      const text = sanitize(data.text).slice(0, MAX_TEXT);
      if (!text) return;
      if (!canAccessRoom(user, room)) return send(ws, { t: 'error', error: 'Нет доступа к чату' });

      const msg = db.addMessage({ room, user, text });
      broadcastAll({ t: 'message', msg });
      return;
    }

    case 'typing': {
      const room = String(data.room || GENERAL);
      if (!canAccessRoom(user, room)) return;
      return broadcastAll({ t: 'typing', room, from: db.publicUser(user) }, ws);
    }

    case 'open': {
      // Открыть переписку с пользователем по логину
      const other = db.findUserByUsername(data.username);
      if (!other) return send(ws, { t: 'error', error: 'Пользователь не найден' });
      return send(ws, { t: 'room', room: db.dmRoom(user.id, other.id), peer: db.publicUser(other) });
    }

    case 'ping':
      return send(ws, { t: 'pong' });

    default:
      return send(ws, { t: 'error', error: 'Неизвестная команда' });
  }
}

module.exports = { attach, GENERAL, onlineUsers, sendToUser };
