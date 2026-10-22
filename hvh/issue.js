'use strict';
/* =========================================================
   Выдача прав на игровом сервере по заказу из портала.

   Два пути (оба работают с любого хоста):
     1. RCON-команда — у услуги задана команда с плейсхолдерами
        {steamid} {name} {login} {flags}. Подходит для мост-плагина
        на сервере или для сторонних систем (vip-плагины и т.п.).
     2. Прямая запись в addons/sourcemod/data/admins.json — если портал
        видит файлы сервера (общий VPS/папка). Права подхватываются
        при смене карты либо командой sm_reloadadmins.
   ========================================================= */
const fs = require('node:fs');
const path = require('node:path');
const D = require('./db');
const rcon = require('./rcon');
const vipdb = require('./vipdb');

/* ---------- агент выдачи на стороне сервера ---------- */
const AGENT = () => {
  const a = D.getSettings('agent') || {};
  return { url: String(a.url || '').trim().replace(/\/$/, ''), token: String(a.token || '') };
};

async function issueViaAgent(ctx) {
  const a = AGENT();
  if (!a.url) return null;                       // агент не настроен
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(a.url + '/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': a.token },
      body: JSON.stringify(ctx),
      signal: ctl.signal
    });
    clearTimeout(t);
    const j = await res.json();
    if (!res.ok) return { ok: false, error: 'агент: ' + (j.error || res.status) };
    return { ok: true, output: (j.log || []).join('; ') || 'агент: ок' };
  } catch (e) {
    return { ok: false, error: 'агент недоступен: ' + e.message };
  }
}

const serverCfg = () => {
  const s = D.getSettings('server') || {};
  return {
    adminsPath: String(s.admins_path || '').trim(),
    vipCmd: String(s.vip_cmd || '').trim(),
    days: Number(s.days) || 30,
    credit: Number(s.credit) || 0,
    group: String(s.group || '').trim()
  };
};

const rconCfg = () => {
  const s = D.getSettings('rcon') || {};
  return { host: String(s.host || '').trim(), port: Number(s.port) || 0, password: String(s.password || '') };
};

/* подстановка плейсхолдеров в команду */
function fillTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => {
    switch (key) {
      case 'steamid': return ctx.steamid || '';
      case 'name': return ctx.name || '';
      case 'login': return ctx.login || '';
      case 'flags': return ctx.flags || '';
      case 'server': return ctx.server || '';
      default: return m;
    }
  }).trim();
}

/* запись в admins.json */
function writeAdmins(file, entry) {
  let list = [];
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw) list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [];
    }
  } catch (e) {
    return { ok: false, error: 'не читается admins.json: ' + e.message };
  }

  const steam = entry.steamid;
  const existing = list.find(x => String(x.steamid) === steam);
  if (existing) {
    existing.name = entry.name || existing.name;
    existing.flags = entry.flags || existing.flags;
  } else {
    list.push({
      steamid: steam,
      name: entry.name || 'admin',
      flags: entry.flags || 'b',
      immunity: 0,
      is_restricted: false
    });
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, '\t'), 'utf8');
  } catch (e) {
    return { ok: false, error: 'не записался admins.json: ' + e.message };
  }
  return { ok: true, count: list.length };
}

/**
 * Выдать услугу на сервере.
 * @param {number} orderId
 */
async function issueOrder(orderId) {
  const order = D.q.get('SELECT * FROM orders WHERE id = ?', Number(orderId));
  if (!order) return { ok: false, error: 'заказ не найден' };

  const user = D.q.get('SELECT * FROM users WHERE id = ?', order.user_id);
  if (!user) return { ok: false, error: 'пользователь не найден' };
  if (!user.steam_id) {
    return { ok: false, error: 'у игрока не привязан SteamID — попроси его указать в кабинете' };
  }

  const svc = D.q.get('SELECT * FROM services WHERE id = ?', order.service_id);
  if (!svc) return { ok: false, error: 'услуга не найдена' };

  const ctx = {
    steamid: user.steam_id,
    name: user.game_login || user.login,
    login: user.login,
    flags: svc.flags || 'b',
    server: ''
  };

  const scfg = serverCfg();
  const cmd = fillTemplate(svc.server_cmd, ctx);
  const results = [];

  /* 0. агент на сервере — самый надёжный путь */
  const agent = await issueViaAgent({
    steamid: user.steam_id,
    steam2: user.steam_id,
    name: ctx.name,
    login: ctx.login,
    flags: ctx.flags,
    days: scfg.days || 30,
    credit: scfg.credit || 0,
    group: scfg.group || '',
    service: svc.title
  });
  if (agent && agent.ok) {
    results.push(agent.output);
    D.q.run("UPDATE orders SET status = 'done', done_at = ? WHERE id = ?", D.now(), order.id);
    D.audit(null, user.login, 'issue', `${svc.title} -> ${user.steam_id} (агент)`);
    return { ok: true, output: results.join(' | ') };
  }
  if (agent && !agent.ok) results.push(agent.error);

  /* 1. RCON-команда */
  if (cmd) {
    const r = await rcon.exec(rconCfg(), cmd);
    results.push((r.ok ? 'RCON: ' : 'RCON ошибка: ') + (r.output || r.error || ''));
    if (!r.ok) {
      // попробуем записать в файл, если он задан
      if (scfg.adminsPath) {
        const w = writeAdmins(scfg.adminsPath, ctx);
        results.push(w.ok ? 'admins.json обновлён' : 'admins.json: ' + w.error);
        if (!w.ok) return { ok: false, error: results.join(' | ') };
      } else {
        return { ok: false, error: results.join(' | ') };
      }
    }
  }

  /* 1b. VIP-база — если у услуги не задана команда RCON, но настроена БД VIP */
  if (!cmd && vipdb.cfg().template) {
    const v = vipdb.issueVip(user.steam_id, ctx.name);
    results.push(v.ok ? 'VIP-база обновлена' : 'VIP-база: ' + v.error);
    if (!v.ok) return { ok: false, error: results.join(' | ') };
  }

  /* 2. admins.json — если команда не задана, но путь указан */
  if (!cmd && scfg.adminsPath) {
    const w = writeAdmins(scfg.adminsPath, ctx);
    results.push(w.ok ? 'admins.json обновлён' : 'admins.json: ' + w.error);
    if (!w.ok) return { ok: false, error: results.join(' | ') };
  }

  if (!cmd && !scfg.adminsPath && !vipdb.cfg().template) {
    return { ok: false, error: 'не задано, как выдавать: команда RCON у услуги, путь к admins.json или SQL-шаблон VIP-базы' };
  }

  D.q.run("UPDATE orders SET status = 'done', done_at = ? WHERE id = ?", D.now(), order.id);
  D.audit(null, user.login, 'issue', `${svc.title} -> ${user.steam_id}`);
  return { ok: true, output: results.join(' | ') };
}

/** Снять права (для услуг с командой на удаление) */
async function revokeOrder(orderId) {
  const order = D.q.get('SELECT * FROM orders WHERE id = ?', Number(orderId));
  if (!order) return { ok: false, error: 'заказ не найден' };
  const user = D.q.get('SELECT * FROM users WHERE id = ?', order.user_id);
  const svc = D.q.get('SELECT * FROM services WHERE id = ?', order.service_id);
  if (!user || !svc) return { ok: false, error: 'нет пользователя или услуги' };

  const ctx = {
    steamid: user.steam_id || '',
    name: user.game_login || user.login,
    login: user.login,
    flags: svc.flags || 'b',
    server: ''
  };
  const cmd = fillTemplate(svc.server_cmd, ctx);
  if (!cmd) return { ok: false, error: 'у услуги не задана команда' };
  const r = await rcon.exec(rconCfg(), cmd);
  return r.ok ? { ok: true, output: r.output || '(ок)' } : { ok: false, error: r.error };
}

module.exports = { issueOrder, revokeOrder, serverCfg, rconCfg, fillTemplate, writeAdmins, issueViaAgent, AGENT };
