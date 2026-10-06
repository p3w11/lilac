'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const auth = require('./lib/auth');
const db = require('./lib/db');
const chat = require('./lib/chat');
const adminPanel = require('./lib/admin');
const limit = require('./lib/ratelimit');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(auth.attachUser);

// Заголовки безопасности
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/* ================= страницы ================= */

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/chat', auth.requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

/* ================= вход и регистрация ================= */

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  res.status(err.status || 500).json({ error: err.message || 'Ошибка сервера' });
});

// Лимиты можно отключить: полезно для локальных тестов и когда все
// сидят за одним IP (например, домашний интернет через NAT).
const noLimit = process.env.DISABLE_RATE_LIMIT === '1';
if (noLimit) console.log('[внимание] ограничения на вход и регистрацию ОТКЛЮЧЕНЫ');

app.post('/api/register', wrap(async (req, res) => {
  if (!noLimit) {
    const gate = limit.hit(`reg:${req.ip}`, 10, 60 * 60 * 1000);
    if (!gate.ok) return res.status(429).json({ error: 'Слишком много регистраций. Попробуй позже' });
  }

  const problem = auth.validateRegistration(req.body || {});
  if (problem) return res.status(400).json({ error: problem });

  // Необязательный код приглашения: задаётся через INVITE_CODE на хостинге
  const invite = String((req.body || {}).inviteCode || '');
  if (process.env.INVITE_CODE && invite !== process.env.INVITE_CODE) {
    return res.status(403).json({ error: 'Нужен правильный код приглашения' });
  }

  const user = await auth.register(req.body);
  auth.setAuthCookie(res, auth.signToken(user));
  res.json({ user: db.privateUser(user) });
}));

app.post('/api/login', wrap(async (req, res) => {
  if (!noLimit) {
    const gate = limit.hit(`login:${req.ip}`, 10, 10 * 60 * 1000);
    if (!gate.ok) {
      return res.status(429).json({ error: 'Слишком много попыток. Подожди 10 минут' });
    }
  }
  const user = await auth.login(req.body || {});
  auth.setAuthCookie(res, auth.signToken(user));
  res.json({ user: db.privateUser(user) });
}));

app.post('/api/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

// Настройки для клиента: нужно ли поле кода приглашения
app.get('/api/config', (_req, res) => {
  res.json({ inviteRequired: Boolean(process.env.INVITE_CODE) });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: db.privateUser(req.user) });
});

/* ================= профиль и настройки ================= */

// Справка для страницы настроек: какие бывают уровни приватности
app.get('/api/privacy-options', auth.requireAuth, (_req, res) => {
  res.json({
    levels: db.SETTING_LEVELS,
    labels: db.SETTING_LABELS,
    defaults: db.DEFAULT_SETTINGS,
  });
});

// Редактирование профиля: имя и «о себе»
app.patch('/api/me/profile', auth.requireAuth, (req, res) => {
  const { displayName, bio } = req.body || {};
  if (displayName !== undefined) {
    const name = String(displayName).trim();
    if (name.length > 32) return res.status(400).json({ error: 'Имя максимум 32 символа' });
    if (/[<>]/.test(name)) return res.status(400).json({ error: 'Имя не должно содержать < или >' });
  }
  if (bio !== undefined && String(bio).length > 200) {
    return res.status(400).json({ error: 'Описание максимум 200 символов' });
  }
  const user = db.updateProfile(req.user.id, { displayName, bio });
  res.json({ user: db.privateUser(user) });
});

// Смена пароля
app.post('/api/me/password', auth.requireAuth, wrap(async (req, res) => {
  const gate = limit.hit(`pass:${req.user.id}`, 5, 60 * 60 * 1000);
  if (!gate.ok) return res.status(429).json({ error: 'Слишком много попыток. Подожди час' });

  const current = String((req.body || {}).currentPassword || '');
  const next = String((req.body || {}).newPassword || '');
  if (next.length < 6) return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });

  const ok = await bcrypt.compare(current, req.user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Текущий пароль неверный' });

  db.updatePassword(req.user.id, await bcrypt.hash(next, 10));
  res.json({ ok: true });
}));

// Настройки приватности
app.put('/api/me/settings', auth.requireAuth, (req, res) => {
  const user = db.updateSettings(req.user.id, req.body || {});
  // После смены настроек список онлайна у всех может измениться
  chat.pushPresenceEverywhere();
  res.json({ user: db.privateUser(user) });
});

/* ================= чат ================= */

app.get('/api/rooms', auth.requireAuth, (req, res) => {
  const rooms = db
    .listRoomsForUser(req.user.id)
    .map((room) => db.roomSummary(room, req.user.id));
  res.json({
    general: db.lastMessageIn(chat.GENERAL),
    dms: db.dmRooms(req.user.id),
    groups: rooms.filter((r) => r.kind === 'group'),
    channels: rooms.filter((r) => r.kind === 'channel'),
  });
});

/* ================= группы и каналы ================= */

/** Комната из ключа "group:1", с проверкой что ключ нормальный. */
function roomFromParams(req, res) {
  const parsed = db.parseRoomKey(req.params.key);
  if (!parsed) {
    res.status(400).json({ error: 'Такой комнаты не бывает' });
    return null;
  }
  const room = db.getRoom(parsed[0], parsed[1]);
  if (!room) {
    res.status(404).json({ error: 'Группа или канал не найден' });
    return null;
  }
  return room;
}

app.post('/api/rooms', auth.requireAuth, (req, res) => {
  const kind = req.body && req.body.kind === 'channel' ? 'channel' : 'group';
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Название минимум 2 символа' });
  if (name.length > 40) return res.status(400).json({ error: 'Название максимум 40 символов' });

  const rawMembers = Array.isArray((req.body || {}).memberIds) ? req.body.memberIds : [];
  // берём только тех, кого реально видно и кому вообще можно писать
  const memberIds = rawMembers
    .map(Number)
    .filter((id) => Number.isInteger(id) && id !== req.user.id)
    .filter((id) => {
      const u = db.getUserById(id);
      return u && db.canSeeProfile(req.user, u);
    });

  const isPublic = kind === 'channel' && Boolean((req.body || {}).isPublic);
  const room = db.addRoom({
    kind,
    name,
    description: (req.body || {}).description,
    ownerId: req.user.id,
    members: memberIds,
    isPublic,
  });

  chat.pushPresenceEverywhere();
  res.json({ room: db.roomSummary(room, req.user.id) });
});

app.get('/api/rooms/:key', auth.requireAuth, (req, res) => {
  const room = roomFromParams(req, res);
  if (!room) return;
  if (!db.isVisible(room, req.user.id)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  res.json({
    room: db.roomSummary(room, req.user.id),
    members: db.roomMembers(room),
    mods: room.mods,
    ownerId: room.ownerId,
  });
});

app.patch('/api/rooms/:key', auth.requireAuth, (req, res) => {
  const room = roomFromParams(req, res);
  if (!room) return;
  if (!db.isRoomAdmin(room, req.user.id)) {
    return res.status(403).json({ error: 'Менять может только администратор группы' });
  }
  const updated = db.updateRoom(room.kind, room.id, req.body || {});
  res.json({ room: db.roomSummary(updated, req.user.id) });
});

app.post('/api/rooms/:key/members', auth.requireAuth, (req, res) => {
  const room = roomFromParams(req, res);
  if (!room) return;
  if (!db.isRoomAdmin(room, req.user.id)) {
    return res.status(403).json({ error: 'Добавлять может только администратор группы' });
  }
  const ids = Array.isArray((req.body || {}).userIds) ? req.body.userIds : [req.body && req.body.userId];
  const added = [];
  for (const raw of ids) {
    const target = db.getUserById(Number(raw));
    if (target && db.addMember(room.kind, room.id, target.id)) added.push(target.username);
  }
  res.json({ ok: true, added });
});

app.delete('/api/rooms/:key/members/:userId', auth.requireAuth, (req, res) => {
  const room = roomFromParams(req, res);
  if (!room) return;

  const targetId = Number(req.params.userId);
  const isSelf = targetId === req.user.id;
  if (!isSelf && !db.isRoomAdmin(room, req.user.id)) {
    return res.status(403).json({ error: 'Убирать может только администратор группы' });
  }
  if (room.ownerId === targetId) {
    return res.status(400).json({ error: 'Владельца нельзя убрать из группы' });
  }

  db.removeMember(room.kind, room.id, targetId);
  res.json({ ok: true });
});

// Назначить / снять помощника администратора
app.post('/api/rooms/:key/mods/:userId', auth.requireAuth, (req, res) => {
  const room = roomFromParams(req, res);
  if (!room) return;
  if (room.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Назначать может только владелец' });
  }
  const result = db.toggleMod(room.kind, room.id, Number(req.params.userId));
  if (result === null) return res.status(400).json({ error: 'Этот человек не в группе' });
  res.json({ ok: true, isMod: result === true });
});

app.post('/api/rooms/:key/leave', auth.requireAuth, (req, res) => {
  const room = roomFromParams(req, res);
  if (!room) return;
  if (room.ownerId === req.user.id) {
    return res.status(400).json({ error: 'Владелец не может выйти — удали группу или передай права' });
  }
  db.removeMember(room.kind, room.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/rooms/:key', auth.requireAuth, (req, res) => {
  const room = roomFromParams(req, res);
  if (!room) return;
  if (room.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Удалить может только владелец' });
  }
  db.deleteRoom(room.kind, room.id);
  res.json({ ok: true });
});

app.get('/api/messages', auth.requireAuth, (req, res) => {
  const room = String(req.query.room || chat.GENERAL);

  let allowed = room === chat.GENERAL;
  let peerCheck = null;

  if (!allowed) {
    const dm = db.parseDmRoom(room);
    if (dm) {
      allowed = dm[0] === req.user.id || dm[1] === req.user.id;
      if (allowed) {
        const peerId = dm[0] === req.user.id ? dm[1] : dm[0];
        const peer = db.getUserById(peerId);
        peerCheck = peer && db.canSendDm(req.user, peer);
      }
    } else {
      const parsed = db.parseRoomKey(room);
      const group = parsed ? db.getRoom(parsed[0], parsed[1]) : null;
      allowed = Boolean(group) && db.isVisible(group, req.user.id);
    }
  }

  if (!allowed) return res.status(403).json({ error: 'Нет доступа к чату' });
  if (peerCheck === false) {
    return res.status(403).json({ error: 'Личные сообщения с этим человеком отключены' });
  }

  const limitN = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = Number(req.query.before) || 0;
  const items = db.getMessages(room, limitN, before);
  res.json({ items, readTs: db.getRead(req.user.id, room) });
});

// Список людей для поиска собеседника, с учётом видимости профилей
app.get('/api/users', auth.requireAuth, (req, res) => {
  const users = db
    .listUsers(req.user.id)
    .filter((u) => db.canSeeProfile(req.user, db.getUserById(u.id)));
  res.json({ users });
});

// Профиль одного человека
app.get('/api/users/:username', auth.requireAuth, (req, res) => {
  const target = db.findUserByUsername(req.params.username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (!db.canSeeProfile(req.user, target)) {
    return res.status(403).json({ error: 'Профиль скрыт настройками приватности' });
  }
  res.json({
    user: db.publicUser(target),
    canWrite: db.canSendDm(req.user, target),
  });
});

/* ================= админка ================= */

// Админка: страница /admin и её API. Обязательно до catch-all ниже.
adminPanel.attach(app);

/* ================= запуск ================= */

// Любая неизвестная страница -> на главную. Обязательно последним,
// иначе перехватит и API-роуты.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
chat.attach(server);

adminPanel.ensureAdmin().catch((err) => console.error('[admin] ошибка:', err.message));

server.listen(PORT, () => {
  console.log(`\n  💜 Lilac запущен: http://localhost:${PORT}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nЗавершаю работу...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
