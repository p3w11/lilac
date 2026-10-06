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
  loaded: new Map(),    // загруженные сообщения по комнатам
  reads: new Map(),     // время прочтения по комнатам
  readSent: new Map(),  // что мы уже отметили прочитанным
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
  wrap.dataset.ts = String(m.ts);
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
    state.loaded.set(room, data.items);
    if (data.readTs) state.reads.set(room, data.readTs);
    renderMessages(data.items);
    scrollDown();
    markRoomRead();
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
        const list = state.loaded.get(msg.room);
        if (list && msg.id > (list[list.length - 1] || {}).id) list.push(msg);

        if (msg.room === state.room) {
          appendMessage(msg);
          markRoomRead();
        } else {
          state.unread.set(msg.room, (state.unread.get(msg.room) || 0) + 1);
        }
        renderRooms();
        return;
      }

      case 'read':
        applyRead(data);
        return;

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

/* ---------- профиль ---------- */

async function openProfile() {
  const pf = $('profileModal');
  pf.hidden = false;
  $('pfError').textContent = '';
  $('pfName').value = state.me.displayName || '';
  $('pfBio').value = state.me.bio || '';
  $('pfLogin').textContent = 'Логин: @' + state.me.username + ' (не меняется)';
  $('pfOld').value = '';
  $('pfNew').value = '';
  countBio();
  $('pfName').focus();
}

function countBio() {
  $('pfBioCount').textContent = String($('pfBio').value.length);
}

async function saveProfile() {
  const btn = $('pfSave');
  btn.disabled = true;
  $('pfError').textContent = '';

  try {
    const body = { displayName: $('pfName').value, bio: $('pfBio').value };

    const oldPass = $('pfOld').value;
    const newPass = $('pfNew').value;
    if (oldPass || newPass) {
      if (!newPass) throw new Error('Введи новый пароль');
      await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: oldPass, newPassword: newPass }),
      });
      $('pfOld').value = '';
      $('pfNew').value = '';
    }

    const data = await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify(body) });
    state.me = data.user;
    updateMeHeader();
    $('profileModal').hidden = true;
  } catch (err) {
    $('pfError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function updateMeHeader() {
  $('meName').textContent = nameOf(state.me);
  $('meLogin').textContent = '@' + state.me.username;
  $('meAvatar').textContent = nameOf(state.me).slice(0, 1).toUpperCase();
}

/* ---------- настройки приватности ---------- */

const LEVEL_LABELS = {
  everyone: 'Все',
  contacts: 'Только контакты',
  nobody: 'Никто',
};

// labels задаётся null, а не {}: иначе проверка ниже всегда даёт false
let privacyOptions = { labels: null, defaults: {} };

async function openSettings() {
  const sm = $('settingsModal');
  sm.hidden = false;
  $('stError').textContent = '';

  if (!privacyOptions.labels) {
    privacyOptions = await api('/api/privacy-options').catch(() => privacyOptions);
  }

  const list = $('settingsList');
  list.textContent = '';

  for (const key of Object.keys(privacyOptions.labels || {})) {
    const box = el('div', 'setting');
    box.appendChild(el('div', 'name', privacyOptions.labels[key]));

    const desc = {
      profileVisibility: 'Кто может найти и открыть твой профиль',
      onlineStatus: 'Кто видит, что ты сейчас в сети',
      directMessages: 'Кто может начать с тобой личную переписку',
      typingIndicator: 'Кто видит, что ты печатаешь сообщение',
      readReceipts: 'Кому отправлять отметку «прочитано»',
    }[key];
    if (desc) box.appendChild(el('div', 'desc', desc));

    const choices = el('div', 'choices');
    const current = (state.me.settings && state.me.settings[key]) || privacyOptions.defaults[key];

    for (const level of privacyOptions.levels || ['everyone', 'contacts', 'nobody']) {
      const btn = el('button', 'choice' + (level === current ? ' on' : ''), LEVEL_LABELS[level] || level);
      btn.type = 'button';
      btn.dataset.key = key;
      btn.dataset.level = level;
      btn.addEventListener('click', () => {
        for (const other of choices.querySelectorAll('.choice')) other.classList.remove('on');
        btn.classList.add('on');
      });
      choices.appendChild(btn);
    }
    box.appendChild(choices);
    list.appendChild(box);
  }
}

async function saveSettings() {
  const btn = $('stSave');
  btn.disabled = true;
  $('stError').textContent = '';

  const patch = {};
  for (const b of $('settingsList').querySelectorAll('.choice.on')) {
    patch[b.dataset.key] = b.dataset.level;
  }

  try {
    const data = await api('/api/me/settings', { method: 'PUT', body: JSON.stringify(patch) });
    state.me = data.user;
    $('settingsModal').hidden = true;
  } catch (err) {
    $('stError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- чужой профиль ---------- */

async function openPeerProfile(username) {
  const pm = $('peerModal');
  pm.hidden = false;
  $('pmBody').textContent = 'Загрузка...';

  try {
    const data = await api(`/api/users/${encodeURIComponent(username)}`);
    const u = data.user;
    $('pmName').textContent = nameOf(u);
    $('pmLogin').textContent = '@' + u.username;

    const body = $('pmBody');
    body.textContent = '';

    const head = el('div', 'profile-head');
    const avatar = el('div', 'big-avatar', nameOf(u).slice(0, 1).toUpperCase());
    head.appendChild(avatar);

    const info = el('div');
    if (u.role !== 'user') {
      const roleNames = { moderator: 'Модератор', admin: 'Админ' };
      info.appendChild(el('span', 'role-badge ' + u.role, roleNames[u.role] || u.role));
    }
    head.appendChild(info);
    body.appendChild(head);

    if (u.bio) body.appendChild(el('p', null, u.bio));
    else body.appendChild(el('div', 'hint', 'Описание не заполнено'));

    const writeBtn = $('pmWrite');
    writeBtn.hidden = !data.canWrite;
    writeBtn.onclick = () => {
      pm.hidden = true;
      sendWs({ t: 'open', username: u.username });
    };
  } catch (err) {
    $('pmName').textContent = 'Недоступно';
    $('pmLogin').textContent = '';
    $('pmBody').textContent = err.message;
    $('pmWrite').hidden = true;
  }
}

/* ---------- прочтения ---------- */

function markRoomRead() {
  const items = state.loaded[state.room];
  if (!items || !items.length) return;
  const last = items[items.length - 1];
  if (!last || last.userId === state.me.id) return;
  if (state.readSent[state.room] === last.ts) return;
  state.readSent[state.room] = last.ts;
  sendWs({ t: 'read', room: state.room, ts: last.ts });
}

function applyRead(event) {
  state.reads.set(event.room, Math.max(state.reads.get(event.room) || 0, event.ts));
  if (event.room === state.room) {
    for (const node of $('messages').querySelectorAll('.msg.mine')) {
      const ts = Number(node.dataset.ts || 0);
      const label = node.querySelector('.time');
      if (!label) continue;
      const isRead = (state.reads.get(event.room) || 0) >= ts;
      const otherRead = event.userId !== state.me.id && isRead;
      label.textContent = label.textContent.split(' · ')[0] + (otherRead ? ' · прочитано' : '');
    }
  }
}


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

      const info = el('span', 'grow');
      info.appendChild(document.createTextNode(`${nameOf(u)}  ·  ${u.username}`));
      if (u.role !== 'user') {
        info.appendChild(document.createTextNode(' '));
        info.appendChild(el('span', 'role-badge ' + u.role, u.role === 'admin' ? 'админ' : 'модератор'));
      }
      row.appendChild(info);

      const infoBtn = el('button', 'icon-btn', 'Профиль');
      infoBtn.type = 'button';
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        openPeerProfile(u.username);
      });
      row.appendChild(infoBtn);

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

  updateMeHeader();

  $('profileBtn').addEventListener('click', openProfile);
  $('pfCancel').addEventListener('click', () => ($('profileModal').hidden = true));
  $('pfSave').addEventListener('click', saveProfile);
  $('pfBio').addEventListener('input', countBio);

  $('settingsBtn').addEventListener('click', openSettings);
  $('stCancel').addEventListener('click', () => ($('settingsModal').hidden = true));
  $('stSave').addEventListener('click', saveSettings);

  $('pmClose').addEventListener('click', () => ($('peerModal').hidden = true));

  const closeOnBackdrop = (id) =>
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id)) $(id).hidden = true;
    });
  closeOnBackdrop('profileModal');
  closeOnBackdrop('settingsModal');
  closeOnBackdrop('peerModal');

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['profileModal', 'settingsModal', 'peerModal']) $(id).hidden = true;
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.replace('/');
  });

  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('show'));

  await openRoom(GENERAL);
  $('input').focus();
}

main();
