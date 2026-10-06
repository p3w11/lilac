'use strict';

/* Клиент чата Lilac */

const $ = (id) => document.getElementById(id);
const GENERAL = 'general';

const state = {
  me: null,
  room: GENERAL,
  rooms: [],            // последние сообщения по всем комнатам
  usersById: new Map(), // все пользователи (для имён в переписках)
  online: [],
  unread: new Map(),
  ws: null,
  typingTimers: new Map(),
  reconnectIn: 1000,
};

/* ---------- утилиты ---------- */

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401) {
    location.replace('/');
    throw new Error('Нужно войти');
  }
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // без innerHTML — текст не превратится в HTML
  return node;
}

function nameOf(user) {
  return user.displayName || user.username;
}

function peerOfRoom(room) {
  const parts = String(room).split(':');
  if (parts[0] !== 'dm' || parts.length !== 3) return null;
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  const id = x === state.me.id ? y : x;
  return state.usersById.get(id) || { id, username: 'user' + id, displayName: 'user' + id };
}

function roomTitle(room) {
  return room === GENERAL ? 'Общий чат' : nameOf(peerOfRoom(room));
}

const time = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  if (isToday) return 'Сегодня';
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

const isOnline = (id) => state.online.some((u) => u.id === id);

/* ---------- отрисовка боковой панели ---------- */

function renderRooms() {
  const box = $('rooms');
  box.textContent = '';

  const addRoom = (room, name, preview, avatarText, onlineId) => {
    const btn = el('button', 'room' + (room === state.room ? ' active' : ''));
    btn.type = 'button';
    btn.appendChild(el('span', 'avatar', avatarText));

    const meta = el('div', 'meta');
    const nameRow = el('div', 'name');
    if (onlineId != null) nameRow.appendChild(el('span', 'dot' + (isOnline(onlineId) ? '' : ' off')));
    nameRow.appendChild(el('span', null, name));
    meta.appendChild(nameRow);
    meta.appendChild(el('div', 'preview', preview || 'Нет сообщений'));
    btn.appendChild(meta);

    const unread = state.unread.get(room) || 0;
    if (unread) btn.appendChild(el('span', 'dot', ''));
    if (unread) btn.lastChild.style.background = 'var(--lilac)';

    btn.addEventListener('click', () => openRoom(room));
    box.appendChild(btn);
  };

  const general = state.rooms.find((r) => r.room === GENERAL);
  addRoom(GENERAL, 'Общий чат', general ? `${general.displayName}: ${general.text}` : null, '🌸');

  box.appendChild(el('div', 'section-title', 'Личные переписки'));

  const dms = state.rooms.filter((r) => r.room !== GENERAL);
  if (!dms.length) box.appendChild(el('div', 'preview', 'Пока нет переписок'));

  for (const dm of dms) {
    const peer = peerOfRoom(dm.room);
    addRoom(
      dm.room,
      nameOf(peer),
      `${dm.displayName}: ${dm.text}`,
      nameOf(peer).slice(0, 1).toUpperCase(),
      peer.id
    );
  }
}

function renderOnline() {
  const box = $('onlineList');
  box.textContent = '';
  for (const u of state.online) {
    const row = el('div', 'online-user');
    row.appendChild(el('span', 'dot'));
    row.appendChild(el('span', null, nameOf(u) + (u.id === state.me.id ? ' (ты)' : '')));
    box.appendChild(row);
  }
  if (!state.online.length) box.appendChild(el('div', 'preview', 'Никого'));
}

/* ---------- сообщения ---------- */

function upsertRoomSummary(msg) {
  const idx = state.rooms.findIndex((r) => r.room === msg.room);
  const summary = { room: msg.room, text: msg.text, ts: msg.ts, displayName: msg.displayName };
  if (idx >= 0) state.rooms[idx] = summary;
  else state.rooms.push(summary);
  state.rooms.sort((a, b) => b.ts - a.ts);
}

function renderMessages(items) {
  const box = $('messages');
  box.textContent = '';

  if (!items.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('div', 'big', '💜'));
    empty.appendChild(el('div', null, 'Здесь пока пусто. Напиши первым!'));
    box.appendChild(empty);
    return;
  }

  // API отдаёт от свежих к старым — выводим в нормальном порядке
  let lastDay = '';
  for (const m of [...items].reverse()) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) {
      box.appendChild(el('div', 'day', day));
      lastDay = day;
    }
    box.appendChild(renderMessage(m));
  }
}

function renderMessage(m) {
  const mine = m.userId === state.me.id;
  const wrap = el('div', 'msg' + (mine ? ' mine' : ''));
  wrap.appendChild(el('div', 'author', nameOf(m)));
  wrap.appendChild(el('div', 'bubble', m.text));
  wrap.appendChild(el('div', 'time', time(m.ts)));
  return wrap;
}

function nearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function scrollDown() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  const box = $('messages');
  if (!box.firstChild || box.querySelector('.empty')) box.textContent = '';

  const needDay = !box.lastElementChild || !box.lastElementChild.classList.contains('day') ||
    box.lastElementChild.dataset.day !== dayLabel(m.ts);
  if (needDay) {
    const d = el('div', 'day', dayLabel(m.ts));
    d.dataset.day = dayLabel(m.ts);
    box.appendChild(d);
  }

  const stick = nearBottom();
  box.appendChild(renderMessage(m));
  if (stick || m.userId === state.me.id) scrollDown();
}

/* ---------- переписки ---------- */

async function openRoom(room) {
  state.room = room;
  state.unread.set(room, 0);
  $('sidebar').classList.remove('show');

  const peer = peerOfRoom(room);
  $('roomTitle').textContent = roomTitle(room);
  $('roomSub').textContent = room === GENERAL
    ? 'Все, кто сейчас в Lilac'
    : isOnline(peer.id) ? 'в сети' : peer.username;

  $('messages').textContent = '';
  $('messages').appendChild(el('div', 'empty', 'Загрузка...'));

  renderRooms();
  renderOnline();

  try {
    const data = await api(`/api/messages?room=${encodeURIComponent(room)}&limit=50`);
    if (state.room !== room) return; // пользователь успел переключиться
    renderMessages(data.items);
    scrollDown();
  } catch (err) {
    $('messages').textContent = '';
    $('messages').appendChild(el('div', 'empty', err.message));
  }
}

function showTyping(user) {
  if (user.id === state.me.id) return;
  const key = user.id;
  clearTimeout(state.typingTimers.get(key));
  $('typing').textContent = `${nameOf(user)} печатает...`;
  state.typingTimers.set(
    key,
    setTimeout(() => {
      $('typing').textContent = '';
      state.typingTimers.delete(key);
    }, 2500)
  );
}

/* ---------- WebSocket ---------- */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectIn = 1000;
  });

  ws.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (data.t) {
      case 'hello':
        state.me = data.user;
        state.online = data.online || [];
        renderOnline();
        renderRooms();
        return;

      case 'message': {
        const msg = data.msg;
        upsertRoomSummary(msg);
        if (msg.room === state.room) {
          appendMessage(msg);
        } else {
          state.unread.set(msg.room, (state.unread.get(msg.room) || 0) + 1);
        }
        renderRooms();
        return;
      }

      case 'presence':
        state.online = data.online;
        renderOnline();
        renderRooms();
        return;

      case 'typing':
        showTyping(data.from);
        return;

      case 'room': {
        // сервер открыл личную переписку
        const peer = data.peer;
        state.usersById.set(peer.id, peer);
        upsertRoomSummary({
          room: data.room,
          text: '',
          ts: Date.now(),
          displayName: nameOf(peer),
        });
        openRoom(data.room);
        return;
      }

      case 'error':
        console.warn('[lilac]', data.error);
        return;
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connect, state.reconnectIn);
    state.reconnectIn = Math.min(state.reconnectIn * 1.7, 15000);
  });
}

function sendWs(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

/* ---------- ввод сообщения ---------- */

function setupComposer() {
  const input = $('input');

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendWs({ t: 'send', room: state.room, text });
    input.value = '';
    input.style.height = '46px';
  });

  let lastTypingSent = 0;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';

    const now = Date.now();
    if (now - lastTypingSent > 1500) {
      lastTypingSent = now;
      sendWs({ t: 'typing', room: state.room });
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
}

/* ---------- поиск друзей ---------- */

function setupModal() {
  const modal = $('modal');
  const list = $('peerList');

  const close = () => {
    modal.hidden = true;
  };

  $('newChatBtn').addEventListener('click', async () => {
    modal.hidden = false;
    $('peerSearch').value = '';
    $('peerSearch').focus();
    list.textContent = '';
    try {
      const { users } = await api('/api/users');
      show(users);
    } catch (err) {
      list.textContent = err.message;
    }
  });

  function show(users) {
    list.textContent = '';
    if (!users.length) {
      list.appendChild(el('div', 'preview', 'Других пользователей пока нет'));
      return;
    }
    for (const u of users) {
      const row = el('div', 'peer');
      row.appendChild(el('span', 'dot' + (isOnline(u.id) ? '' : ' off')));
      row.appendChild(el('span', 'grow', `${nameOf(u)}  ·  ${u.username}`));
      row.addEventListener('click', () => {
        sendWs({ t: 'open', username: u.username });
        close();
      });
      list.appendChild(row);
    }
  }

  $('peerSearch').addEventListener('input', async (e) => {
    const q = e.target.value.trim().toLowerCase();
    try {
      const { users } = await api('/api/users');
      const filtered = users.filter(
        (u) => u.username.includes(q) || nameOf(u).toLowerCase().includes(q)
      );
      show(filtered);
    } catch {}
  });

  $('closeModal').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });
}

/* ---------- старт ---------- */

async function main() {
  const me = await api('/api/me').catch(() => null);
  if (!me || !me.user) {
    location.replace('/');
    return;
  }
  state.me = me.user;
  state.usersById.set(state.me.id, state.me);

  $('meName').textContent = nameOf(state.me);
  $('meLogin').textContent = '@' + state.me.username;
  $('meAvatar').textContent = nameOf(state.me).slice(0, 1).toUpperCase();

  const { users } = await api('/api/users').catch(() => ({ users: [] }));
  for (const u of users) state.usersById.set(u.id, u);

  const rooms = await api('/api/rooms').catch(() => ({ general: null, dms: [] }));
  state.rooms = [
    ...(rooms.general ? [{ room: GENERAL, text: rooms.general.text, ts: rooms.general.ts, displayName: rooms.general.displayName }] : []),
    ...rooms.dms.map((m) => ({ room: m.room, text: m.text, ts: m.ts, displayName: m.displayName })),
  ];

  setupComposer();
  setupModal();
  connect();

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.replace('/');
  });

  // Кнопка админки видна только у администратора (проверка ещё и на сервере)
  const adminBtn = $('adminBtn');
  adminBtn.hidden = !state.me.isAdmin;
  adminBtn.addEventListener('click', () => location.assign('/admin'));

  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('show'));

  await openRoom(GENERAL);
  $('input').focus();
}

main();
