'use strict';

/**
 * Админка Lilac — всё в одном файле.
 *
 * Логин и пароль администратора задаются переменными окружения
 * ADMIN_USER / ADMIN_PASS. Значения по умолчанию — только для локального
 * запуска; на хостинге лучше задать свои через настройки сервиса.
 */

const path = require('path');
const auth = require('./auth');
const db = require('./db');
const chat = require('./chat');

const ADMIN_USER = String(process.env.ADMIN_USER || 'p3w1').trim().toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || '228_1337';

/** Админ — это тот, чей логин совпадает с ADMIN_USER. */
const isAdmin = (user) => Boolean(user) && user.username === ADMIN_USER;

/**
 * Создаёт аккаунт администратора при первом запуске.
 * Именно здесь, а не через обычную регистрацию: иначе любой мог бы
 * зарегистрировать логин p3w1 первым и получить права админа.
 */
async function ensureAdmin() {
  if (db.findUserByUsername(ADMIN_USER)) {
    console.log(`[admin] аккаунт "${ADMIN_USER}" уже существует`);
    return;
  }
  await auth.register({
    username: ADMIN_USER,
    password: ADMIN_PASS,
    displayName: 'Админ',
  });
  console.log(`[admin] создан администратор: ${ADMIN_USER}`);
  if (!process.env.ADMIN_PASS) {
    console.log('[admin] ВНИМАНИЕ: пароль дефолтный. Задай ADMIN_PASS в настройках хостинга.');
  }
}

/** Middleware: только администратор. */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Доступ только для администратора' });
  next();
}

/** Регистрирует страницу админки и её API. Вызывать до catch-all в server.js. */
function attach(app) {
  app.get('/admin', requireAdmin, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  const admin = [auth.requireAuth, requireAdmin];

  // Есть ли у текущего пользователя права админа
  app.get('/api/admin/access', auth.requireAuth, (req, res) => {
    res.json({ isAdmin: isAdmin(req.user) });
  });

  app.get('/api/admin/stats', admin, (_req, res) => {
    const users = db.adminUsers();
    res.json({
      users: users.length,
      messages: db.messageCount(),
      online: chat.onlineUsers().length,
      active7d: users.filter(
        (u) => Date.now() - (u.lastMessageAt || u.createdAt) < 7 * 86400000
      ).length,
    });
  });

  app.get('/api/admin/users', admin, (_req, res) => {
    // флаг проставляем здесь: в базе он не хранится и не может быть подделан
    const users = db.adminUsers().map((u) => ({ ...u, isAdmin: u.username === ADMIN_USER }));
    res.json({ users });
  });

  app.get('/api/admin/messages', admin, (req, res) => {
    res.json({ messages: db.recentMessages(Math.min(Number(req.query.limit) || 60, 200)) });
  });

  app.post('/api/admin/delete-user', admin, (req, res) => {
    const target = db.getUserById(Number((req.body || {}).userId));
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (isAdmin(target)) return res.status(400).json({ error: 'Администратора удалить нельзя' });
    db.deleteUser(target.id);
    res.json({ ok: true, removed: target.username });
  });

  app.post('/api/admin/delete-message', admin, (req, res) => {
    const id = Number((req.body || {}).messageId);
    if (!db.deleteMessage(id)) return res.status(404).json({ error: 'Сообщение не найдено' });
    res.json({ ok: true });
  });

  app.post('/api/admin/clear', admin, (req, res) => {
    const room = String((req.body || {}).room || '');
    res.json({ ok: true, removed: db.clearMessages(room || null) });
  });
}

module.exports = { ADMIN_USER, ADMIN_PASS, isAdmin, ensureAdmin, requireAdmin, attach };
