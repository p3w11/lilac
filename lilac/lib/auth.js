'use strict';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

/* ---------- секрет для подписи сессий ---------- */
// Если задан JWT_SECRET (на хостинге) — используем его, иначе генерируем
// один раз и храним рядом с данными, чтобы сессии не слетали при рестарте.

function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(db.DATA_DIR, 'secret.key');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const secret = require('crypto').randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret);
    return secret;
  } catch (err) {
    console.error('[auth] не удалось прочитать секрет:', err.message);
    return require('crypto').randomBytes(48).toString('hex');
  }
}

const SECRET = getSecret();
const TOKEN_TTL = '30d';
const COOKIE = 'lilac_token';

/* ---------- валидация ---------- */

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function validateRegistration({ username, password, displayName }) {
  const name = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) {
    return 'Логин: 3–20 символов, только латиница в нижнем регистре, цифры и _';
  }
  const pass = String(password || '');
  if (pass.length < 6) return 'Пароль минимум 6 символов';
  if (pass.length > 200) return 'Слишком длинный пароль';

  const nick = String(displayName || '').trim();
  if (nick.length > 32) return 'Имя слишком длинное (максимум 32)';
  if (/[<>]/.test(nick)) return 'Имя не должно содержать символы < >';

  return null;
}

/* ---------- регистрация / вход / сессия ---------- */

async function register({ username, password, displayName, isAdmin = false }) {
  const name = String(username || '').trim().toLowerCase();
  if (db.findUserByUsername(name)) {
    const err = new Error('Такой логин уже занят');
    err.status = 409;
    throw err;
  }
  const hash = await bcrypt.hash(String(password), 10);
  const user = db.addUser({
    username: name,
    passwordHash: hash,
    displayName: String(displayName || '').trim(),
    isAdmin,
  });
  return user;
}

/* ---------- администратор ---------- */

const ADMIN_USER = String(process.env.ADMIN_USER || 'p3w1').trim().toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || 'iampidoras';

/**
 * Создаёт аккаунт администратора при первом запуске.
 * Важно: он создаётся здесь, а не через обычную регистрацию —
 * иначе любой мог бы зарегистрировать логин p3w1 первым и стать админом.
 */
async function ensureAdmin() {
  if (db.findUserByUsername(ADMIN_USER)) {
    console.log(`[admin] аккаунт "${ADMIN_USER}" уже существует`);
    return;
  }
  const user = await register({
    username: ADMIN_USER,
    password: ADMIN_PASS,
    displayName: 'Админ',
    isAdmin: true,
  });
  console.log(`[admin] создан администратор: ${user.username}`);
  if (!process.env.ADMIN_PASS) {
    console.log('[admin] ВНИМАНИЕ: пароль задан по умолчанию. Задай ADMIN_PASS в настройках хостинга.');
  }
}

async function login({ username, password }) {
  const user = db.findUserByUsername(username);
  // Сравниваем даже если юзера нет — чтобы нельзя было узнать список логинов по времени ответа
  const hash = user ? user.passwordHash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!user || !ok) {
    const err = new Error('Неверный логин или пароль');
    err.status = 401;
    throw err;
  }
  return user;
}

function signToken(user) {
  return jwt.sign({ uid: user.id, u: user.username }, SECRET, { expiresIn: TOKEN_TTL });
}

function userFromToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    return db.getUserById(payload.uid);
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIE === '1',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE);
}

/** Middleware: прикрепляет req.user, если есть валидная сессия. */
function attachUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  req.user = token ? userFromToken(token) : null;
  next();
}

/** Middleware: пускает только авторизованных. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  next();
}

/** Middleware: пускает только администратора. */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Доступ только для администратора' });
  next();
}

/** Разбор Cookie заголовка вручную (нужно для WebSocket upgrade). */
function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function userFromCookieHeader(header) {
  const token = parseCookieHeader(header)[COOKIE];
  return token ? userFromToken(token) : null;
}

module.exports = {
  COOKIE,
  ADMIN_USER,
  ADMIN_PASS,
  validateRegistration,
  register,
  ensureAdmin,
  login,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  userFromCookieHeader,
  db,
};
