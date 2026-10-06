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

/** Онлайн-статусы, которые видит конкретный человек (с учётом приватности). */
function onlineVisibleTo(viewer) {
  const out = [];
  for (const id of online.keys()) {
    const target = db.getUserById(id);
    if (!target) continue;
    if (!db.canSeeOnline(viewer, target)) continue;
    out.push(db.publicUser(target));
  }
  return out;
}

/** Все, кто сейчас подключён (для админки). */
function onlineUsers() {
  return [...online.keys()].map((id) => db.getUserById(id)).filter(Boolean).map(db.publicUser);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** Рассылка всем, кроме указанного сокета (для общих событий). */
function broadcastAll(payload, exceptWs = null) {
  for (const set of online.values()) {
    for (const ws of set) {
      if (ws !== exceptWs) send(ws, payload);
    }
  }
}

function sendToUser(userId, payload) {
  const set = online.get(userId);
  if (!set) return;
  for (const ws of set) send(ws, payload);
}

/**
 * Рассылка по комнате. В общем чате сообщение получают все,
 * в личке — только участники переписки.
 */
function broadcastToRoom(room, payload, sender, exceptWs = null) {
  if (room === GENERAL) {
    broadcastAll(payload, exceptWs);
    return;
  }

  // Группа или канал — только участникам
  const audience = roomAudienceIds(room);
  if (audience.length) {
    for (const id of audience) {
      for (const ws of online.get(id) || []) {
        if (ws !== exceptWs) send(ws, payload);
      }
    }
    return;
  }

  // Личная переписка
  const ids = db.parseDmRoom(room);
  if (!ids) return;
  for (const id of ids) {
    if (id === sender.id) {
      for (const ws of online.get(id) || []) {
        if (ws !== exceptWs) send(ws, payload);
      }
      continue;
    }
    const peer = db.getUserById(id);
    if (peer && db.canSendDm({ id: sender.id }, peer)) {
      for (const ws of online.get(id) || []) send(ws, payload);
    }
  }
}

/** Комната по ключу "group:1" / "channel:2", либо null. */
function roomOf(key) {
  const parsed = db.parseRoomKey(key);
  return parsed ? db.getRoom(parsed[0], parsed[1]) : null;
}

/**
 * Может ли пользователь читать комнату.
 * Общий чат — всем, личка — участникам, группа — участникам,
 * публичный канал — всем остальным тоже.
 */
function canAccessRoom(user, room) {
  if (room === GENERAL) return true;

  const dm = db.parseDmRoom(room);
  if (dm) return dm[0] === user.id || dm[1] === user.id;

  const group = roomOf(room);
  if (!group) return false;
  return db.isVisible(group, user.id);
}

/** Может ли пользователь писать в комнату. */
function canPostInRoom(user, room) {
  if (room === GENERAL) return true;
  const dm = db.parseDmRoom(room);
  if (dm) return dm[0] === user.id || dm[1] === user.id;
  const group = roomOf(room);
  return group ? db.canPostIn(group, user.id) : false;
}

/** Участники комнаты, которым имеет смысл слать события. */
function roomAudienceIds(room) {
  const group = roomOf(room);
  return group ? group.members : [];
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
      user: db.privateUser(user),
      online: onlineVisibleTo(user),
    });
    // Появление/исчезновение видят только те, кому не запрещена видимость
    pushPresenceEverywhere();

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
      if (!online.has(user.id)) pushPresenceEverywhere();
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

/** Пересчитывает и рассылает список онлайна каждому своему */
function pushPresenceEverywhere() {
  for (const [userId, set] of online) {
    const viewer = db.getUserById(userId);
    if (!viewer) continue;
    const list = onlineVisibleTo(viewer);
    for (const ws of set) send(ws, { t: 'presence', online: list });
  }
}

function handleMessage(ws, user, data) {
  switch (data && data.t) {
    case 'send': {
      const room = String(data.room || GENERAL);
      const text = sanitize(data.text).slice(0, MAX_TEXT);
      if (!text) return;
      if (!canAccessRoom(user, room)) return send(ws, { t: 'error', error: 'Нет доступа к чату' });

      const group = roomOf(room);
      if (group && !db.canPostIn(group, user.id)) {
        return send(ws, { t: 'error', error: 'В этом канале пишут только администраторы' });
      }

      // В личку писать можно только если собеседник разрешил
      if (!group) {
        const ids = db.parseDmRoom(room);
        if (ids) {
          const peerId = ids[0] === user.id ? ids[1] : ids[0];
          const peer = db.getUserById(peerId);
          if (!peer) return send(ws, { t: 'error', error: 'Собеседник не найден' });
          if (!db.canSendDm(user, peer)) {
            return send(ws, { t: 'error', error: `${peer.displayName || peer.username} запретил личные сообщения` });
          }
        }
      }

      const msg = db.addMessage({ room, user, text });
      broadcastToRoom(room, { t: 'message', msg }, user);
      return;
    }

    case 'typing': {
      const room = String(data.room || GENERAL);
      if (!canAccessRoom(user, room)) return;
      // в канале печатать нечего
      if (!canPostInRoom(user, room)) return;

      const from = db.publicUser(user);
      if (room === GENERAL) {
        for (const [id, set] of online) {
          const target = db.getUserById(id);
          if (!target || !db.canSeeTyping(target, user)) continue;
          for (const peerWs of set) send(peerWs, { t: 'typing', room, from });
        }
        return;
      }

      const ids = db.parseDmRoom(room);
      if (ids) {
        const peerId = ids[0] === user.id ? ids[1] : ids[0];
        const peer = db.getUserById(peerId);
        if (!peer || !db.canSeeTyping(peer, user)) return;
        sendToUser(peerId, { t: 'typing', room, from });
        return;
      }

      // группа или канал — участникам, кому не запрещено
      for (const id of roomAudienceIds(room)) {
        const target = db.getUserById(id);
        if (!target || !db.canSeeTyping(target, user)) continue;
        sendToUser(id, { t: 'typing', room, from });
      }
      return;
    }

    case 'read': {
      const room = String(data.room || GENERAL);
      if (!canAccessRoom(user, room)) return;
      // в каналах отметки о прочтении не показываются
      const group = roomOf(room);
      if (group && group.kind === 'channel') return;
      const last = db.lastMessageIn(room);
      if (!last) return;
      const ts = db.markRead(user.id, room, Number(data.ts) || last.ts);
      const payload = { t: 'read', room, userId: user.id, ts };

      if (room === GENERAL) {
        // «прочитано» видят те, кому автор разрешил присылать отметки
        for (const [id, set] of online) {
          const target = db.getUserById(id);
          const allowed = id === user.id || (target && db.canSeeRead(target, user));
          if (allowed) for (const w of set) send(w, payload);
        }
        return;
      }

      const ids = db.parseDmRoom(room);
      if (ids) {
        const peerId = ids[0] === user.id ? ids[1] : ids[0];
        const peer = db.getUserById(peerId);
        if (peer && db.canSeeRead(peer, user)) sendToUser(peerId, payload);
        for (const w of online.get(user.id) || []) send(w, payload);
        return;
      }

      // группа — всем участникам, кому не запрещено
      for (const id of roomAudienceIds(room)) {
        const target = db.getUserById(id);
        if (id === user.id || (target && db.canSeeRead(target, user))) sendToUser(id, payload);
      }
      return;
    }

    case 'open': {
      // Открыть переписку с пользователем по логину
      const other = db.findUserByUsername(data.username);
      if (!other) return send(ws, { t: 'error', error: 'Пользователь не найден' });
      if (!db.canSeeProfile(user, other)) {
        return send(ws, { t: 'error', error: 'Профиль скрыт настройками приватности' });
      }
      if (!db.canSendDm(user, other)) {
        return send(ws, { t: 'error', error: 'Этот человек запретил личные сообщения' });
      }
      return send(ws, {
        t: 'room',
        room: db.dmRoom(user.id, other.id),
        peer: db.publicUser(other),
      });
    }

    case 'ping':
      return send(ws, { t: 'pong' });

    default:
      return send(ws, { t: 'error', error: 'Неизвестная команда' });
  }
}

module.exports = {
  attach,
  GENERAL,
  onlineUsers,
  onlineVisibleTo,
  pushPresenceEverywhere,
  sendToUser,
};
