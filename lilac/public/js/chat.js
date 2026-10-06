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
  // только личная переписка "dm:1:2" — у групп и каналов собеседника нет
  if (parts[0] !== 'dm' || parts.length !== 3) return null;
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  const id = x === state.me.id ? y : x;
  return state.usersById.get(id) || { id, username: 'user' + id, displayName: 'user' + id };
}

function roomTitle(room) {
  if (room === GENERAL) return 'Общий чат';
  const summary = state.rooms.find((r) => r.room === room);
  if (summary && summary.name) return summary.name;
  const peer = peerOfRoom(room);
  return peer ? nameOf(peer) : 'Чат';
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

  const addRoom = (room, name, preview, icon, extra) => {
    const btn = el('button', 'room' + (room === state.room ? ' active' : ''));
    btn.type = 'button';

    if (extra && extra.kind) btn.appendChild(el('span', 'kind', extra.kind === 'channel' ? '📢' : '👥'));
    else btn.appendChild(el('span', 'avatar', icon));

    const meta = el('div', 'meta');
    const nameRow = el('div', 'name');
    if (extra && extra.onlineId != null) {
      nameRow.appendChild(el('span', 'dot' + (isOnline(extra.onlineId) ? '' : ' off')));
    }
    nameRow.appendChild(el('span', null, name));
    if (extra && extra.tag) nameRow.appendChild(el('span', 'tagline', extra.tag));
    meta.appendChild(nameRow);
    meta.appendChild(el('div', 'preview', preview || 'Нет сообщений'));
    btn.appendChild(meta);

    const unread = state.unread.get(room) || 0;
    if (unread) {
      const dot = el('span', 'dot', '');
      dot.style.background = 'var(--lilac)';
      btn.appendChild(dot);
    }

    if (extra && extra.info) {
      const info = el('button', 'info-btn', 'ℹ');
      info.type = 'button';
      info.title = 'О группе';
      info.addEventListener('click', (e) => {
        e.stopPropagation();
        openRoomModal(room);
      });
      btn.appendChild(info);
    }

    btn.addEventListener('click', () => openRoom(room));
    box.appendChild(btn);
  };

  const general = state.rooms.find((r) => r.room === GENERAL);
  addRoom(GENERAL, 'Общий чат', general ? `${general.displayName}: ${general.text}` : null, '🌸');

  const groups = state.rooms.filter((r) => r.kind === 'group');
  const channels = state.rooms.filter((r) => r.kind === 'channel');

  if (groups.length) {
    box.appendChild(el('div', 'section-title', 'Группы'));
    for (const g of groups) {
      addRoom(g.room, g.name, g.lastText, '', {
        kind: 'group',
        info: true,
        tag: g.isPublic ? 'публичная' : null,
      });
    }
  }

  if (channels.length) {
    box.appendChild(el('div', 'section-title', 'Каналы'));
    for (const c of channels) {
      addRoom(c.room, c.name, c.lastText, '', {
        kind: 'channel',
        info: true,
        tag: c.isPublic ? 'публичный' : null,
      });
    }
  }

  const dms = state.rooms.filter((r) => r.kind === 'dm');
  if (dms.length) {
    box.appendChild(el('div', 'section-title', 'Личные переписки'));
    for (const dm of dms) {
      const peer = peerOfRoom(dm.room);
      addRoom(dm.room, nameOf(peer), `${dm.displayName}: ${dm.text}`, nameOf(peer).slice(0, 1).toUpperCase(), {
        onlineId: peer.id,
      });
    }
  }

  if (!groups.length && !channels.length && !dms.length) {
    box.appendChild(el('div', 'preview', 'Пока только общий чат'));
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

/**
 * Обновляет строчку превью в списке.
 * Важно: метаданные комнаты (название, тип, участники) при этом сохраняются —
 * иначе превью сообщения стирало бы «Наша группа» до «Чат».
 */
let refreshTimer = null;
function scheduleRoomsRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadRooms().catch(() => {});
  }, 800);
}

function upsertRoomSummary(msg) {
  const idx = state.rooms.findIndex((r) => r.room === msg.room);
  // общий чат и переписки читают text, группы и каналы — lastText,
  // поэтому пишем в оба поля
  const patch = {
    text: msg.text,
    ts: msg.ts,
    displayName: msg.displayName,
    lastText: msg.text,
    lastTs: msg.ts,
    lastName: msg.displayName,
  };

  if (idx >= 0) {
    state.rooms[idx] = { ...state.rooms[idx], ...patch };
  } else {
    // комнаты не было в списке — тип угадываем, а точные данные подтянем с сервера
    state.rooms.push({
      room: msg.room,
      kind: String(msg.room).startsWith('dm:') ? 'dm' : 'group',
      name: '',
      members: 0,
      ...patch,
    });
    scheduleRoomsRefresh();
  }
  state.rooms.sort((a, b) => (b.ts || b.lastTs || 0) - (a.ts || a.lastTs || 0));
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

  const peer = room === GENERAL ? null : peerOfRoom(room);
  const summary = room === GENERAL ? null : state.rooms.find((r) => r.room === room);

  if (room === GENERAL) {
    $('roomTitle').textContent = 'Общий чат';
    $('roomSub').textContent = 'Все, кто сейчас в Lilac';
  } else if (peer) {
    // личная переписка: имя всегда есть у собеседника
    $('roomTitle').textContent = nameOf(peer);
    $('roomSub').textContent = isOnline(peer.id) ? 'в сети' : peer.username;
  } else if (summary) {
    // группа или канал: имя берём из сводки
    $('roomTitle').textContent = summary.name || 'Чат';
    const bits = [];
    if (summary.kind === 'group') bits.push(`${summary.members} участник(ов)`);
    else if (summary.kind === 'channel') bits.push(summary.canPost ? 'можно писать' : 'только чтение');
    $('roomSub').textContent = bits.join(' · ');
  } else {
    $('roomTitle').textContent = roomTitle(room);
    $('roomSub').textContent = '';
  }

  // В канале участник только читает — прячем поле ввода
  const readOnly = Boolean(summary && summary.kind === 'channel' && !summary.canPost);
  $('composerRow').hidden = readOnly;
  $('composerNote').hidden = !readOnly;

  // Звонок только в личной переписке
  const callBtn = $('callBtn');
  callBtn.hidden = !isDmRoom(room);
  callBtn.disabled = call.phase !== 'idle';

  renderRooms();
  renderOnline();

  $('messages').textContent = '';
  $('messages').appendChild(el('div', 'empty', 'Загрузка...'));

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

      case 'call':
        onCallSignal(data);
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

/* ---------- создание групп и каналов ---------- */

let createKind = 'group';

function openCreate(kind) {
  createKind = kind;
  $('cmTitle').textContent = kind === 'channel' ? 'Новый канал' : 'Новая группа';
  $('cmNameLabel').textContent = kind === 'channel' ? 'Название канала' : 'Название группы';
  $('cmPublicBlock').hidden = kind !== 'channel';
  $('cmName').value = '';
  $('cmDesc').value = '';
  $('cmPublic').checked = false;
  $('cmError').textContent = '';
  $('createModal').hidden = false;
  $('cmName').focus();
}

async function createRoom() {
  const btn = $('cmCreate');
  btn.disabled = true;
  $('cmError').textContent = '';
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        kind: createKind,
        name: $('cmName').value,
        description: $('cmDesc').value,
        isPublic: $('cmPublic').checked,
      }),
    });
    $('createModal').hidden = true;
    await loadRooms();
    await openRoom(data.room.room);
  } catch (err) {
    $('cmError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- управление группой / каналом ---------- */

let roomModalData = null;

async function openRoomModal(key) {
  const rm = $('roomModal');
  rm.hidden = false;
  $('rmError').textContent = '';

  try {
    const data = await api('/api/rooms/' + encodeURIComponent(key));
    roomModalData = data;

    $('rmTitle').textContent = data.room.name;
    $('rmKind').textContent =
      data.room.kind === 'channel'
        ? `Канал · ${data.room.members} участник(ов) · сообщения только от админов`
        : `Группа · ${data.room.members} участник(ов)`;

    const canEdit = data.room.isAdmin;
    $('rmName').value = data.room.name;
    $('rmDesc').value = data.room.description || '';
    $('rmName').disabled = !canEdit;
    $('rmDesc').disabled = !canEdit;
    $('rmPublicBlock').hidden = data.room.kind !== 'channel';
    $('rmPublic').checked = Boolean(data.room.isPublic);
    $('rmMemberSearch').disabled = !canEdit;
    $('rmSave').hidden = !canEdit;

    const leave = $('rmLeave');
    leave.hidden = data.room.isOwner;
    leave.textContent = data.room.kind === 'channel' ? 'Покинуть канал' : 'Покинуть группу';

    renderRoomMembers(data);
  } catch (err) {
    $('rmTitle').textContent = 'Недоступно';
    $('rmKind').textContent = '';
    $('rmMembers').textContent = err.message;
  }
}

function renderRoomMembers(data) {
  const box = $('rmMembers');
  box.textContent = '';

  for (const u of data.members) {
    const row = el('div', 'member-row');

    if (u.id === state.me.id) row.appendChild(el('span', 'dot'));
    else row.appendChild(el('span', 'dot off'));

    const label = el('span', 'grow', `${nameOf(u)}  ·  ${u.username}`);
    if (u.id === data.ownerId) {
      label.appendChild(document.createTextNode(' '));
      label.appendChild(el('span', 'tagline', 'владелец'));
    } else if (data.mods.includes(u.id)) {
      label.appendChild(document.createTextNode(' '));
      label.appendChild(el('span', 'tagline', 'помощник'));
    }
    row.appendChild(label);

    // Назначить помощника может только владелец
    if (data.room.isOwner && u.id !== data.ownerId) {
      const modBtn = el('button', 'mini-btn' + (data.mods.includes(u.id) ? ' on' : ''),
        data.mods.includes(u.id) ? 'Снять' : 'Помощник');
      modBtn.type = 'button';
      modBtn.addEventListener('click', async () => {
        try {
          await api(`/api/rooms/${encodeURIComponent(data.room.room)}/mods/${u.id}`, { method: 'POST' });
          await reloadRoomModal();
        } catch (err) {
          $('rmError').textContent = err.message;
        }
      });
      row.appendChild(modBtn);
    }

    // Убрать может админ, кроме владельца
    if (data.room.isAdmin && u.id !== data.ownerId && u.id !== state.me.id) {
      const kick = el('button', 'mini-btn danger', 'Убрать');
      kick.type = 'button';
      kick.addEventListener('click', async () => {
        try {
          await api(`/api/rooms/${encodeURIComponent(data.room.room)}/members/${u.id}`, { method: 'DELETE' });
          await reloadRoomModal();
        } catch (err) {
          $('rmError').textContent = err.message;
        }
      });
      row.appendChild(kick);
    }

    box.appendChild(row);
  }
}

async function reloadRoomModal() {
  if (!roomModalData) return;
  await loadRooms();
  await openRoomModal(roomModalData.room.room);
}

async function saveRoomModal() {
  const data = roomModalData;
  if (!data) return;
  $('rmError').textContent = '';
  try {
    await api('/api/rooms/' + encodeURIComponent(data.room.room), {
      method: 'PATCH',
      body: JSON.stringify({ name: $('rmName').value, description: $('rmDesc').value }),
    });
    await loadRooms();
    $('roomModal').hidden = true;
    if (state.room === data.room.room) await openRoom(state.room);
  } catch (err) {
    $('rmError').textContent = err.message;
  }
}

async function addMemberByLogin() {
  const data = roomModalData;
  if (!data) return;
  const login = $('rmMemberSearch').value.trim().toLowerCase();
  if (!login) return;
  $('rmError').textContent = '';
  try {
    const { users } = await api('/api/users');
    const target = users.find((u) => u.username === login);
    if (!target) {
      $('rmError').textContent = 'Такого пользователя нет';
      return;
    }
    await api('/api/rooms/' + encodeURIComponent(data.room.room) + '/members', {
      method: 'POST',
      body: JSON.stringify({ userId: target.id }),
    });
    $('rmMemberSearch').value = '';
    await reloadRoomModal();
  } catch (err) {
    $('rmError').textContent = err.message;
  }
}

/* ---------- голосовые звонки ---------- */

// Публичные STUN-серверы нужны, чтобы узнать внешний адрес и пробить NAT.
// Симметричный NAT без TURN-сервера соединить не получится — об этом
// предупреждаем пользователя.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const CALL_RING_TIMEOUT = 45000;

const call = {
  room: null,
  pc: null,
  local: null,
  role: null, // 'caller' | 'callee'
  phase: 'idle', // idle | connecting | active
  muted: false,
  timer: null,
  startedAt: 0,
  peer: null,
  incoming: null,
};

const isDmRoom = (room) => Boolean(peerOfRoom(room));

function callSeconds() {
  return Math.floor((Date.now() - call.startedAt) / 1000);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showCallBar(hint) {
  const bar = $('callBar');
  bar.hidden = false;
  $('callName').textContent = call.peer ? nameOf(call.peer) : 'Звонок';
  $('callHint').textContent = hint || '';
  $('callTime').textContent = formatTime(callSeconds());
  $('callMute').classList.toggle('on', call.muted);
  $('callMute').textContent = call.muted ? 'Микрофон выкл' : 'Микрофон вкл';
  $('callLive').classList.toggle('connecting', call.phase !== 'active');
}

function hideCallBar() {
  $('callBar').hidden = true;
  $('callTime').textContent = '0:00';
}

/** Просит доступ к микрофону. Без HTTPS это невозможно. */
async function getMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Браузер не даёт доступ к микрофону. Нужен HTTPS (в localhost работает)');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

let remoteAudio = null;

function attachRemoteAudio(stream) {
  if (!remoteAudio) {
    remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute('playsinline', '');
    document.body.appendChild(remoteAudio);
  }
  if (remoteAudio.srcObject !== stream) {
    remoteAudio.srcObject = stream;
    remoteAudio.play().catch(() => {});
  }
}

function startCallTimer() {
  clearInterval(call.timer);
  call.timer = setInterval(() => {
    if (call.phase !== 'active') return;
    $('callTime').textContent = formatTime(callSeconds());
  }, 1000);
}

/** Короткое уведомление в строке «печатает...». */
let noticeTimer = null;
function notice(text) {
  const box = $('typing');
  box.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (call.phase === 'idle') box.textContent = '';
  }, 4000);
}

function newPeerConnection() {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate && call.room) {
      sendWs({ t: 'call', action: 'ice', room: call.room, payload: e.candidate.toJSON() });
    }
  };

  pc.ontrack = (e) => {
    // голос не показываем картинкой, но поток держим живым
    if (e.streams[0]) attachRemoteAudio(e.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (!call.pc) return;
    if (pc.connectionState === 'connected') {
      call.phase = 'active';
      call.startedAt = Date.now();
      startCallTimer();
      showCallBar('соединено');
    } else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      if (call.phase !== 'idle') {
        notice('Связь прервалась');
        endCall(false);
      }
    }
  };

  return pc;
}

/* --- исходящий звонок --- */

async function startCall() {
  const room = state.room;
  if (!isDmRoom(room)) {
    alert('Звонки доступны только в личных переписках');
    return;
  }
  if (call.phase !== 'idle') {
    alert('Ты уже в звонке');
    return;
  }

  call.room = room;
  call.peer = peerOfRoom(room);
  call.role = 'caller';
  call.phase = 'connecting';

  try {
    call.local = await getMic();
  } catch (err) {
    resetCall();
    alert('Не получилось включить микрофон:\n\n' + err.message);
    return;
  }

  call.pc = newPeerConnection();
  for (const track of call.local.getTracks()) call.pc.addTrack(track, call.local);

  try {
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    sendWs({ t: 'call', action: 'offer', room, payload: { type: offer.type, sdp: offer.sdp } });
    showCallBar('звоним...');
  } catch (err) {
    notice('Не удалось начать звонок');
    endCall(false);
    return;
  }

  // если за 45 секунд не ответили — сбрасываем
  setTimeout(() => {
    if (call.phase === 'connecting' && call.role === 'caller') {
      notice('Нет ответа');
      endCall(false);
    }
  }, CALL_RING_TIMEOUT);
}

/* --- входящий звонок --- */

function onCallOffer(msg) {
  if (call.phase !== 'idle') {
    // мы уже заняты — сразу отклоняем, чтобы не висело звонком
    sendWs({ t: 'call', action: 'decline', room: msg.room });
    return;
  }
  call.incoming = msg;
  $('callInName').textContent = nameOf(msg.from) + ' зовёт';
  $('callInError').textContent = '';
  $('callIn').hidden = false;
}

async function acceptCall() {
  const msg = call.incoming;
  if (!msg) return;

  $('callIn').hidden = true;
  call.incoming = null;
  call.room = msg.room;
  call.peer = msg.from;
  call.role = 'callee';
  call.phase = 'connecting';

  try {
    call.local = await getMic();
  } catch (err) {
    sendWs({ t: 'call', action: 'hangup', room: msg.room });
    resetCall();
    $('callInError').textContent = 'Микрофон недоступен: ' + err.message;
    return;
  }

  call.pc = newPeerConnection();
  for (const track of call.local.getTracks()) call.pc.addTrack(track, call.local);

  try {
    await call.pc.setRemoteDescription(msg.payload);
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    sendWs({ t: 'call', action: 'answer', room: msg.room, payload: { type: answer.type, sdp: answer.sdp } });
    showCallBar('соединяемся...');
  } catch (err) {
    notice('Не удалось ответить');
    endCall(false);
  }
}

function declineCall() {
  const msg = call.incoming;
  $('callIn').hidden = true;
  call.incoming = null;
  if (msg) sendWs({ t: 'call', action: 'decline', room: msg.room });
}

/* --- управление звонком --- */

function toggleMute() {
  if (!call.local) return;
  call.muted = !call.muted;
  for (const track of call.local.getAudioTracks()) track.enabled = !call.muted;
  $('callMute').classList.toggle('on', call.muted);
  $('callMute').textContent = call.muted ? 'Микрофон выкл' : 'Микрофон вкл';
}

function hangUp() {
  if (call.room) sendWs({ t: 'call', action: 'hangup', room: call.room });
  endCall(false);
}

/** Уборка. notify — отправить собеседнику «сбросил». */
function endCall(notify) {
  if (notify && call.room) sendWs({ t: 'call', action: 'hangup', room: call.room });

  clearInterval(call.timer);
  if (call.pc) {
    try {
      call.pc.close();
    } catch {}
  }
  if (call.local) {
    for (const track of call.local.getTracks()) track.stop();
  }
  if (remoteAudio) {
    remoteAudio.srcObject = null;
    remoteAudio.pause();
  }
  resetCall();
  hideCallBar();
}

/** Сброс без обращения к собеседнику. */
function resetCall() {
  clearInterval(call.timer);
  call.room = null;
  call.pc = null;
  call.local = null;
  call.peer = null;
  call.role = null;
  call.phase = 'idle';
  call.muted = false;
  call.startedAt = 0;
  call.incoming = null;
  $('callIn').hidden = true;
}

/** Обработка сигналов от собеседника. */
function onCallSignal(data) {
  const { action, room } = data;

  switch (action) {
    case 'offer':
      onCallOffer(data);
      return;

    case 'decline':
      if (call.room === room) {
        notice('Вызов отклонён');
        endCall(false);
      }
      return;

    case 'hangup':
      if (call.room === room) {
        notice('Звонок завершён');
        endCall(false);
      }
      if (call.incoming && call.incoming.room === room) {
        $('callIn').hidden = true;
        call.incoming = null;
      }
      return;

    case 'answer':
      if (!call.pc || call.room !== room) return;
      call.pc.setRemoteDescription(data.payload).catch(() => {});
      return;

    case 'ice':
      if (!call.pc || call.room !== room || !data.payload) return;
      call.pc.addIceCandidate(data.payload).catch(() => {});
      return;
  }
}

/* ---------- загрузка списка комнат ---------- */

async function loadRooms() {
  const data = await api('/api/rooms');
  // kind проставляем всем, иначе общий чат попадёт в список личных переписок
  state.rooms = [
    ...(data.general
      ? [{
          room: GENERAL,
          kind: 'general',
          text: data.general.text,
          ts: data.general.ts,
          displayName: data.general.displayName,
        }]
      : []),
    ...data.groups,
    ...data.channels,
    ...data.dms.map((m) => ({
      room: m.room,
      kind: 'dm',
      text: m.text,
      ts: m.ts,
      displayName: m.displayName,
    })),
  ];
  renderRooms();
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

  setupComposer();
  setupModal();
  connect();

  updateMeHeader();

  $('newGroupBtn').addEventListener('click', () => openCreate('group'));
  $('newChannelBtn').addEventListener('click', () => openCreate('channel'));
  $('cmCreate').addEventListener('click', createRoom);
  $('cmCancel').addEventListener('click', () => ($('createModal').hidden = true));

  $('callBtn').addEventListener('click', startCall);
  $('callMute').addEventListener('click', toggleMute);
  $('callHangup').addEventListener('click', hangUp);
  $('callAccept').addEventListener('click', acceptCall);
  $('callDecline').addEventListener('click', declineCall);

  // при выходе со страницы предупреждаем собеседника
  window.addEventListener('beforeunload', () => {
    if (call.phase !== 'idle' && call.room) {
      sendWs({ t: 'call', action: 'hangup', room: call.room });
    }
  });

  $('rmClose').addEventListener('click', () => ($('roomModal').hidden = true));
  $('rmSave').addEventListener('click', saveRoomModal);
  $('rmMemberSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addMemberByLogin();
    }
  });
  $('rmLeave').addEventListener('click', async () => {
    const data = roomModalData;
    if (!data) return;
    if (!confirm(`Покинуть «${data.room.name}»?`)) return;
    try {
      await api('/api/rooms/' + encodeURIComponent(data.room.room) + '/leave', { method: 'POST' });
      $('roomModal').hidden = true;
      await loadRooms();
      await openRoom(GENERAL);
    } catch (err) {
      $('rmError').textContent = err.message;
    }
  });

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
  closeOnBackdrop('roomModal');
  closeOnBackdrop('createModal');

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['profileModal', 'settingsModal', 'peerModal', 'roomModal', 'createModal']) {
      $(id).hidden = true;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.replace('/');
  });

  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('show'));

  await loadRooms();
  await openRoom(GENERAL);
  $('input').focus();
}

main();
