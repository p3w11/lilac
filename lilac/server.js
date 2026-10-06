'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');

const auth = require('./lib/auth');
const db = require('./lib/db');
const chat = require('./lib/chat');
const limit = require('./lib/ratelimit');
const adminPanel = require('./lib/admin');

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

app.get('/admin', auth.requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* ================= API ================= */

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  res.status(err.status || 500).json({ error: err.message || 'Ошибка сервера' });
});

// Настройки для клиента: нужно ли поле кода приглашения
app.get('/api/config', (_req, res) => {
  res.json({ inviteRequired: Boolean(process.env.INVITE_CODE) });
});

app.post('/api/register', wrap(async (req, res) => {
  const gate = limit.hit(`reg:${req.ip}`, 10, 60 * 60 * 1000);
  if (!gate.ok) return res.status(429).json({ error: 'Слишком много регистраций. Попробуй позже' });

  const problem = auth.validateRegistration(req.body || {});
  if (problem) return res.status(400).json({ error: problem });

  // Необязательный код приглашения: задаётся через INVITE_CODE на хостинге
  const invite = String((req.body || {}).inviteCode || '');
  if (process.env.INVITE_CODE && invite !== process.env.INVITE_CODE) {
    return res.status(403).json({ error: 'Нужен правильный код приглашения' });
  }

  const user = await auth.register(req.body);
  auth.setAuthCookie(res, auth.signToken(user));
  res.json({ user: db.publicUser(user) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const gate = limit.hit(`login:${req.ip}`, 10, 10 * 60 * 1000);
  if (!gate.ok) {
    return res.status(429).json({ error: 'Слишком много попыток. Подожди 10 минут' });
  }
  const user = await auth.login(req.body || {});
  auth.setAuthCookie(res, auth.signToken(user));
  res.json({ user: db.publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: db.publicUser(req.user) });
});

app.get('/api/rooms', auth.requireAuth, (req, res) => {
  res.json({ general: db.lastMessageIn(chat.GENERAL), dms: db.dmRooms(req.user.id) });
});

app.get('/api/messages', auth.requireAuth, (req, res) => {
  const room = String(req.query.room || chat.GENERAL);
  const ids = db.parseDmRoom(room);
  const allowed =
    room === chat.GENERAL || (ids && (ids[0] === req.user.id || ids[1] === req.user.id));
  if (!allowed) return res.status(403).json({ error: 'Нет доступа к чату' });

  const limitN = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = Number(req.query.before) || 0;
  res.json({ items: db.getMessages(room, limitN, before) });
});

app.get('/api/users', auth.requireAuth, (req, res) => {
  res.json({ users: db.listUsers(req.user.id) });
});

/* ================= админка ================= */

const admin = [auth.requireAuth, auth.requireAdmin];

app.get('/api/admin/stats', admin, (_req, res) => {
  const users = db.adminUsers();
  res.json({
    users: users.length,
    messages: db.recentMessages(1_000_000).length,
    admins: users.filter((u) => u.isAdmin).length,
    online: chat.onlineUsers().length,
    active7d: users.filter((u) => Date.now() - (u.lastMessageAt || u.createdAt) < 7 * 86400000).length,
  });
});

app.get('/api/admin/users', admin, (_req, res) => {
  res.json({ users: db.adminUsers() });
});

app.get('/api/admin/messages', admin, (req, res) => {
  res.json({ messages: db.recentMessages(Math.min(Number(req.query.limit) || 60, 200)) });
});

app.post('/api/admin/delete-user', admin, (req, res) => {
  const id = Number((req.body || {}).userId);
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.isAdmin) return res.status(400).json({ error: 'Администратора удалить нельзя' });
  db.deleteUser(id);
  res.json({ ok: true, removed: target.username });
});

app.post('/api/admin/delete-message', admin, (req, res) => {
  const id = Number((req.body || {}).messageId);
  if (!db.deleteMessage(id)) return res.status(404).json({ error: 'Сообщение не найдено' });
  res.json({ ok: true });
});

app.post('/api/admin/clear', admin, (req, res) => {
  const room = String((req.body || {}).room || '');
  const removed = db.clearMessages(room || null);
  res.json({ ok: true, removed });
});

/* ================= запуск ================= */

// Любая неизвестная страница -> на главную. Обязательно последним,
// иначе перехватит и API-роуты.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
chat.attach(server);

auth.ensureAdmin().catch((err) => console.error('[admin] ошибка:', err.message));

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
