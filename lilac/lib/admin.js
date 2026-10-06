'use strict';

/**
 * Админка и модерация Lilac.
 *
 * Права берутся из роли пользователя (user / moderator / admin),
 * а не из отдельного флага. Логин владельца задаётся ADMIN_USER,
 * его роль всегда admin и её нельзя понизить.
 */

const path = require('path');
const auth = require('./auth');
const db = require('./db');
const chat = require('./chat');

const ADMIN_USER = String(process.env.ADMIN_USER || 'p3w1').trim().toLowerCase();

/** Роль назначается по логину: у владельца она всегда admin. */
const roleOf = (user) => (user && user.username === ADMIN_USER ? 'admin' : user && user.role) || 'user';

const isAdmin = (user) => db.hasRight({ role: roleOf(user) }, 'manageRoles');

/**
 * Создаёт аккаунт владельца при первом запуске.
 * Именно здесь, а не через обычную регистрацию: иначе любой мог бы
 * зарегистрировать этот логин первым и получить права админа.
 */
async function ensureAdmin() {
  if (db.findUserByUsername(ADMIN_USER)) {
    const existing = db.findUserByUsername(ADMIN_USER);
    if (existing.role !== 'admin') db.setRole(existing.id, 'admin');
    console.log(`[admin] аккаунт "${ADMIN_USER}" уже существует`);
    return;
  }
  await auth.register({
    username: ADMIN_USER,
    password: process.env.ADMIN_PASS || '228_1337',
    displayName: 'Админ',
    role: 'admin',
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

function attach(app) {
  // Страница админки
  app.get('/admin', requireAdmin, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  const admin = [auth.requireAuth, requireAdmin];

  app.get('/api/admin/access', auth.requireAuth, (req, res) => {
    res.json({ isAdmin: isAdmin(req.user), role: roleOf(req.user) });
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
      moderators: users.filter((u) => roleOf(u) === 'moderator').length,
    });
  });

  app.get('/api/admin/users', admin, (_req, res) => {
    res.json({
      roles: db.ROLES,
      users: db.adminUsers().map((u) => ({
        ...u,
        role: roleOf(u),
        isOwner: u.username === ADMIN_USER,
      })),
    });
  });

  app.get('/api/admin/messages', admin, (req, res) => {
    res.json({ messages: db.recentMessages(Math.min(Number(req.query.limit) || 60, 200)) });
  });

  // Все группы и каналы — администратору сайта
  app.get('/api/admin/rooms', admin, (_req, res) => {
    res.json({ rooms: db.adminRooms() });
  });

  app.post('/api/admin/delete-room', admin, (req, res) => {
    const parsed = db.parseRoomKey(String((req.body || {}).room || ''));
    if (!parsed) return res.status(400).json({ error: 'Неизвестная комната' });
    if (!db.deleteRoom(parsed[0], parsed[1])) {
      return res.status(404).json({ error: 'Комната не найдена' });
    }
    res.json({ ok: true });
  });

  /* ---------- роли ---------- */

  app.post('/api/admin/set-role', admin, (req, res) => {
    const target = db.getUserById(Number((req.body || {}).userId));
    const role = String((req.body || {}).role || '');
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!db.ROLES.includes(role)) return res.status(400).json({ error: 'Неизвестная роль' });
    if (target.username === ADMIN_USER) {
      return res.status(400).json({ error: 'Роль владельца изменить нельзя' });
    }
    if (role === 'admin' && target.id === req.user.id) {
      // не страшно, но запретим выдать себе вторую админку без нужды — оставим как есть
      return res.status(400).json({ error: 'Себе дополнительные права выдать нельзя' });
    }
    db.setRole(target.id, role);
    res.json({ ok: true, role });
  });

  /* ---------- удаление ---------- */

  app.post('/api/admin/delete-user', admin, (req, res) => {
    const target = db.getUserById(Number((req.body || {}).userId));
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.username === ADMIN_USER) {
      return res.status(400).json({ error: 'Владельца удалить нельзя' });
    }
    db.deleteUser(target.id);
    res.json({ ok: true, removed: target.username });
  });

  // Модератор тоже может удалять сообщения
  app.post(
    '/api/admin/delete-message',
    [auth.requireAuth, auth.requireRight('deleteAnyMessage')],
    (req, res) => {
      const id = Number((req.body || {}).messageId);
      if (!db.deleteMessage(id)) return res.status(404).json({ error: 'Сообщение не найдено' });
      res.json({ ok: true });
    }
  );

  app.post('/api/admin/clear', admin, (req, res) => {
    const room = String((req.body || {}).room || '');
    res.json({ ok: true, removed: db.clearMessages(room || null) });
  });
}

module.exports = { ADMIN_USER, roleOf, isAdmin, ensureAdmin, requireAdmin, attach };
