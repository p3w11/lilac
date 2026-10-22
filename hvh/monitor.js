'use strict';
/* =========================================================
   Мониторинг игровых серверов через Source Engine Query (A2S_INFO).
   Это настоящий UDP-опрос: сервер отвечает на \xFF\xFF\xFF\xFFTSource
   Engine Query и отдаёт имя, карту, количество игроков и свои теги.

   Поддерживаются два формата ответа:
     • классический (Source 2003–2016) — позиционный, с бинарными полями
       app (3 байта) и players (2 байта);
     • ключевой (Source 2016+) — пары key\0value\0.
   ========================================================= */
const dgram = require('node:dgram');

const A2S_INFO = Buffer.from([
  0xff, 0xff, 0xff, 0xff, 0x54, 0x53, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x20,
  0x45, 0x6e, 0x67, 0x69, 0x6e, 0x65, 0x20, 0x51, 0x75, 0x65, 0x72, 0x79, 0x00
]);
const S2A_INFO_SRC = 0x49;   // 'I'

function query(ip, port, timeout = 2500) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now();
    let done = false;

    const finish = r => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      resolve(r);
    };

    sock.on('error', err => finish({ online: false, error: err.message }));
    sock.on('message', msg => {
      try { finish(parseInfo(msg, Date.now() - t0)); }
      catch (e) { finish({ online: false, error: 'непонятный ответ' }); }
    });

    sock.send(A2S_INFO, port, ip, err => { if (err) finish({ online: false, error: err.message }); });
    setTimeout(() => finish({ online: false, error: 'таймаут' }), timeout);
  });
}

function parseInfo(buf, ping) {
  let i = 0;
  while (i < buf.length && buf[i] === 0xff) i++;
  if (i >= buf.length) throw new Error('пустой ответ');
  const type = buf[i++];
  if (type !== S2A_INFO_SRC) throw new Error('не A2S_INFO');

  const out = { online: true, ping, name: '', map: '', players: 0, maxPlayers: 0, tags: '', error: '' };

  let pos = i;
  const readStr = () => {
    if (pos >= buf.length) return null;
    const end = buf.indexOf(0, pos);
    if (end < 0) return null;
    const s = buf.toString('utf8', pos, end);
    pos = end + 1;
    return s;
  };
  const readBytes = n => {
    if (pos + n > buf.length) return null;
    const b = buf.subarray(pos, pos + n);
    pos += n;
    return b;
  };

  if (pos < buf.length && buf[pos] === 0x21) {
    /* ---------- новый формат: gamedir + версия + ключи ---------- */
    pos++;
    if (readStr() === null) throw new Error('обрыв');
    if (readStr() === null) throw new Error('обрыв');
    for (let guard = 0; guard < 32; guard++) {
      const key = readStr();
      if (key === null || key === '') break;
      const val = readStr();
      if (val === null) break;
      switch (key) {
        case 'hostname': out.name = val; break;
        case 'map': out.map = val; break;
        case 'players': out.players = parseInt(val, 10) || 0; break;
        case 'maxplayers': out.maxPlayers = parseInt(val, 10) || 0; break;
      }
    }
  } else {
    /* ---------- классический формат Source ----------
       после game идут: appid(1), версия(1), ИГРОКИ(1), МАКСИМУМ(1),
       затем служебные байты и строка версии, затем «расширенная» строка
       с тегами сервера. Проверено на реальных ответах:
         FLUX    48 23 0e 20 -> 14 игроков из 32
         CyberCS 48 23 08 40 ->  8 игроков из 64          */
    pos++;                             // байт протокола
    const name = readStr(); if (name === null) throw new Error('обрыв');
    const map = readStr(); if (map === null) throw new Error('обрыв');
    readStr();                       // folder
    readStr();                       // game

    const appid = readBytes(1);      // appid
    const ver = readBytes(1);         // версия протокола
    const pl = readBytes(1);          // игроки
    const mx = readBytes(1);          // максимум игроков
    if (!appid || !pl || !mx) throw new Error('обрыв');

    out.name = name;
    out.map = map || '';
    out.players = pl[0];
    out.maxPlayers = mx[0];
    if (appid[0]) out.appId = appid[0];
    if (ver && ver[0]) out.gameVersion = ver[0];

    // дальше — служебные байты до строки версии вида «1.38.8.1»
    for (let guard = 0; guard < 24; guard++) {
      const s = readStr();
      if (s === null) break;
      if (/^\d+(\.\d+)+/.test(s)) { out.version = s; break; }
      out.extra = (out.extra || '') + s + ',';
    }

    // теги сервера: ищем в «хвосте» списком через запятую
    // (у FLUX: tick,comp,hvh,mirage,scout,insecure)
    const tail = buf.toString('latin1', Math.max(0, pos - 8));
    const m = /([a-z][a-z0-9_]*(?:,[a-z0-9_]+){2,})/i.exec(tail);
    if (m) out.tags = m[1];
  }

  if (!out.maxPlayers && out.name) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(out.name);
    if (m) { out.players = +m[1]; out.maxPlayers = +m[2]; }
  }
  return out;
}

/* Список игроков: A2S_PLAYER */
function queryPlayers(ip, port, timeout = 2500) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now();
    let done = false;
    const finish = r => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      resolve(r);
    };
    sock.on('error', e => finish({ ok: false, players: [], error: e.message }));
    sock.on('message', msg => {
      try { finish(parsePlayers(msg, Date.now() - t0)); }
      catch (e) { finish({ ok: false, players: [], error: 'непонятный ответ' }); }
    });
    const req = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x55, 0x00]);
    sock.send(req, port, ip, e => { if (e) finish({ ok: false, players: [], error: e.message }); });
    setTimeout(() => finish({ ok: false, players: [], error: 'таймаут' }), timeout);
  });
}

function parsePlayers(buf, ping) {
  let i = 0;
  while (i < buf.length && buf[i] === 0xff) i++;
  if (i >= buf.length) throw new Error('пустой ответ');
  const type = buf[i++];
  if (type !== 0x44) throw new Error('не A2S_PLAYER');   // 'D'
  const count = buf[i++];
  const players = [];
  for (let n = 0; n < count && i < buf.length; n++) {
    const index = buf[i++];
    const end = buf.indexOf(0, i);
    if (end < 0) break;
    const name = buf.toString('utf8', i, end);
    i = end + 1;
    if (i + 3 >= buf.length) break;
    const score = buf.readInt32LE(i); i += 4;
    const duration = buf.readFloatLE(i); i += 4;
    players.push({ index, name, score, duration: Math.round(duration) });
  }
  return { ok: true, players, ping };
}

/* ---------- планировщик опроса ---------- */
class Monitor {
  constructor(db, intervalMs = 45000) {
    this.db = db;
    this.interval = intervalMs;
    this.cache = new Map();     // server_id -> последний результат
    this.timer = null;
  }

  start() {
    this.refreshAll();
    this.timer = setInterval(() => this.refreshAll(), this.interval);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async refreshAll() {
    const servers = this.db.q.all('SELECT * FROM servers WHERE enabled = 1');
    await Promise.all(servers.map(s => this.refresh(s)));
  }

  async refresh(server) {
    const r = await query(server.ip, server.port);
    const st = {
      online: r.online ? 1 : 0,
      players: r.players || 0,
      max_players: r.maxPlayers || 0,
      map: r.map || '',
      name: r.name || '',
      tags: r.tags || '',
      ping: r.ping || 0,
      error: r.online ? '' : (r.error || 'оффлайн')
    };
    this.cache.set(server.id, st);
    try {
      this.db.q.run(`INSERT INTO server_stats
        (server_id, ts, online, players, max_players, map, name, ping, error)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        server.id, this.db.now(), st.online, st.players, st.max_players, st.map, st.name, st.ping, st.error);
    } catch {}
    return st;
  }

  status(server) {
    return this.cache.get(server.id) ||
      { online: 0, players: 0, max_players: 0, map: '', name: '', tags: '', ping: 0, error: 'ожидание' };
  }
}

module.exports = { query, queryPlayers, Monitor };
