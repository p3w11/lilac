'use strict';

/**
 * TURN-серверы для звонков.
 *
 * Поддерживаются два источника:
 *
 * 1. Xirsys (рекомендуется) — временные креды, которые сервер получает
 *    по их API и отдаёт браузеру. Секрет хранится только здесь,
 *    в клиентский код не попадает.
 *
 * 2. Ручная настройка в админке — на случай, если Xirsys не настроен.
 *
 * Креды Xirsys живут недолго (по умолчанию 60 секунд), поэтому держим кэш
 * и обновляем заранее.
 */

const db = require('./db');

const API_BASE = process.env.XIRSYS_API_URL || 'https://global.xirsys.net';

// Запрашиваем креды на час — этого хватает на много звонков.
// Документация допускает максимум 6 часов, но не стоит забирать слишком много.
const EXPIRE_SECONDS = Math.min(Number(process.env.XIRSYS_EXPIRE) || 3600, 21600);

const hasXirsys = () =>
  Boolean(process.env.XIRSYS_IDENT && process.env.XIRSYS_SECRET && process.env.XIRSYS_CHANNEL);

let cache = {
  iceServers: null,
  fetchedAt: 0,
  expiresAt: 0,
  lastError: null,
};

/** Живы ли креды: за 60 секунд до конца считаем, что пора обновлять. */
function isFresh() {
  if (!cache.iceServers) return false;
  return Date.now() < cache.expiresAt - 60_000;
}

function authHeader() {
  const basic = Buffer.from(
    `${process.env.XIRSYS_IDENT}:${process.env.XIRSYS_SECRET}`
  ).toString('base64');
  return `Basic ${basic}`;
}

/** Забирает свежие креды у Xirsys. */
async function fetchFromXirsys() {
  const channel = encodeURIComponent(process.env.XIRSYS_CHANNEL);
  const url = `${API_BASE}/_turn/${channel}?webrtc=1&expire=${EXPIRE_SECONDS}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: authHeader() },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Xirsys вернул не JSON (HTTP ${res.status})`);
  }

  if (!res.ok || data.s !== 'ok') {
    throw new Error(`Xirsys ответил HTTP ${res.status}, s=${data.s || 'нет'}`);
  }

  const servers = data.v && data.v.iceServers;
  if (!Array.isArray(servers) || !servers.length) {
    throw new Error('Xirsys не вернул iceServers');
  }

  // Chrome ломается на TURN без логина и пароля — выбрасываем такие записи
  const usable = servers.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    const hasTurn = urls.some((u) => /^turns?:/i.test(u));
    return !hasTurn || (s.username && s.credential);
  });

  if (!usable.length) {
    throw new Error('Xirsys вернул TURN без логина и пароля — Chrome сломал бы звонки');
  }

  cache.iceServers = usable;
  cache.fetchedAt = Date.now();
  cache.expiresAt = Date.now() + EXPIRE_SECONDS * 1000;
  cache.lastError = null;
  return usable;
}

/** Ручные настройки из админки, если Xirsys не настроен. */
function fromSettings() {
  const turn = db.getTurnConfig();
  if (!turn.urls.length) return [];
  if (!turn.username || !turn.credential) {
    // только stun-адреса — они пароля не требуют
    const stunOnly = turn.urls.filter((u) => !/^turns?:/i.test(u));
    if (!stunOnly.length) return [];
    return [{ urls: stunOnly }];
  }
  return [{ urls: turn.urls, username: turn.username, credential: turn.credential }];
}

/** Креды для браузера. Никогда не отдаёт Xirsys-секрет. */
async function getIceServers() {
  if (hasXirsys()) {
    if (isFresh()) return { source: 'xirsys', iceServers: cache.iceServers, cached: true };

    try {
      const servers = await fetchFromXirsys();
      return { source: 'xirsys', iceServers: servers, cached: false };
    } catch (err) {
      cache.lastError = err.message;
      console.error('[turn] Xirsys недоступен:', err.message);

      // если прошлые креды ещё живые — отдадим их, звонок может удаться
      if (cache.iceServers && Date.now() < cache.expiresAt) {
        return { source: 'xirsys', iceServers: cache.iceServers, cached: true, stale: true };
      }
    }
  }

  const manual = fromSettings();
  return { source: 'manual', iceServers: manual, cached: false };
}

/** Статус для админки: настроен ли Xirsys, есть ли свежие креды. */
function status() {
  return {
    xirsysConfigured: hasXirsys(),
    hasCredentials: Boolean(cache.iceServers),
    expiresAt: cache.expiresAt || null,
    lastError: cache.lastError,
    expireSeconds: EXPIRE_SECONDS,
    channel: process.env.XIRSYS_CHANNEL || '',
    ident: process.env.XIRSYS_IDENT || '',
  };
}

/** Заранее обновляем креды, чтобы они не кончились посреди разговора. */
function startAutoRefresh() {
  if (!hasXirsys()) return;
  fetchFromXirsys()
    .then(() => console.log('[turn] креды Xirsys получены'))
    .catch((err) => console.error('[turn] не удалось получить креды:', err.message));

  const timer = setInterval(() => {
    if (!isFresh()) {
      fetchFromXirsys().catch((err) => console.error('[turn] обновление не удалось:', err.message));
    }
  }, 60_000);
  timer.unref();
}

module.exports = { getIceServers, status, startAutoRefresh, hasXirsys };