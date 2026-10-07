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
  pendingAvatar = undefined; // undefined — не трогаем, null — убрать
  fillAvatar($('pfAvatarPreview'), state.me, pendingAvatarPreview || avatarUrl(state.me));
  countBio();
  $('pfName').focus();
}

let pendingAvatar;
let pendingAvatarPreview;

function countBio() {
  $('pfBioCount').textContent = String($('pfBio').value.length);
}

async function saveProfile() {
  const btn = $('pfSave');
  btn.disabled = true;
  $('pfError').textContent = '';

  try {
    const body = { displayName: $('pfName').value, bio: $('pfBio').value };
    if (pendingAvatar !== undefined) body.avatar = pendingAvatar;

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
    pendingAvatar = undefined;
    pendingAvatarPreview = null;
    updateMeHeader();
    $('profileModal').hidden = true;
  } catch (err) {
    $('pfError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/** Выбор файла — сжимаем и показываем предпросмотр до сохранения. */
async function pickAvatarFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    $('pfError').textContent = 'Можно только картинку';
    return;
  }
  try {
    const data = await shrinkImage(file);
    pendingAvatar = data;
    pendingAvatarPreview = data;
    fillAvatar($('pfAvatarPreview'), state.me, data);
    $('pfError').textContent = '';
  } catch (err) {
    $('pfError').textContent = err.message;
  }
}

function updateMeHeader() {
  $('meName').textContent = nameOf(state.me);
  $('meLogin').textContent = '@' + state.me.username;
  // картинка закрывает букву полностью — буква остаётся только без аватара
  fillAvatar($('meAvatar'), state.me);
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
    const avatar = el('div', 'big-avatar');
    fillAvatar(avatar, u);
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

// Список серверов для обхода NAT.
//
// Раньше тут был один STUN Google. Отсюда и нерабочие звонки:
// если STUN недоступен из сети пользователя, остаются только внутренние
// адреса, и два человека из разных домашних сетей не соединятся.
//
// Основной источник — Xirsys: его креды живут недолго, поэтому сервер сам
// обновляет их и отдаёт браузеру готовый массив iceServers. Если Xirsys
// не настроен, остаются запасные STUN-адреса ниже.
//
// ВАЖНО: TURN нельзя указывать с пустыми логином и паролем — Chrome бросает
// исключение при создании соединения, и звонок не работает вообще.
const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.freespeech.org:3478',
  'stun:stun.voipbuster.com:3478',
  'stun:global.stun.twilio.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.qq.com:3478',
];

let rtcConfig = null;
let turnSource = 'stun';

async function loadTurnConfig() {
  try {
    const data = await api('/api/turn');
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      rtcConfig = { iceServers: data.iceServers, iceCandidatePoolSize: 4 };
      turnSource = data.source || 'server';
      const hasTurn = data.iceServers.some((s) =>
        (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u))
      );
      console.log('[звонок] источник серверов:', turnSource, hasTurn ? '(есть TURN)' : '(только STUN)');
      return;
    }
  } catch {
    // сервер недоступен — берём запасные адреса
  }

  rtcConfig = { iceServers: STUN_SERVERS.map((urls) => ({ urls })), iceCandidatePoolSize: 4 };
  turnSource = 'stun';
}

/** Перед звонком подтягиваем креды заново: у Xirsys они живут недолго. */
async function refreshTurn() {
  await loadTurnConfig();
}

const CALL_RING_TIMEOUT = 45000;

const call = {
  room: null,
  pc: null,
  local: null,
  role: null, // 'caller' | 'callee'
  phase: 'idle', // idle | connecting | active | failed
  muted: false,
  timer: null,
  startedAt: 0,
  peer: null,
  incoming: null,
  pendingIce: [], // кандидаты, пришедшие до готовности соединения
  status: '',
  candidates: { host: 0, srflx: 0, relay: 0 },
  spokeAt: { peer: 0, self: 0 },
  stopRemoteWatch: null,
  stopSelfWatch: null,
};

const isDmRoom = (room) => Boolean(peerOfRoom(room));

function callSeconds() {
  // до начала разговора таймер не тикает — иначе покажет мусорные миллионы минут
  if (!call.startedAt || call.phase !== 'active') return 0;
  return Math.floor((Date.now() - call.startedAt) / 1000);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setCallStatus(text) {
  call.status = text;
  showCallPanel(text);
}

/* ---------- аватары ---------- */

const AVATAR_MAX_BYTES = 400 * 1024;

function avatarUrl(user) {
  return user && user.hasAvatar ? '/api/avatar/' + user.id : null;
}

/** Кладёт в элемент картинку, а если её нет — первую букву имени. */
function fillAvatar(node, user, overrideUrl) {
  if (!node) return;
  node.textContent = '';
  const url = overrideUrl || avatarUrl(user);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.addEventListener('error', () => {
      // картинку удалили — показываем букву, не пустоту
      node.textContent = (user ? nameOf(user) : '?').slice(0, 1).toUpperCase();
    });
    node.appendChild(img);
  } else {
    node.textContent = (user ? nameOf(user) : '?').slice(0, 1).toUpperCase();
  }
}

/** Уменьшает картинку до 256px и жмёт в JPEG, чтобы весила мало. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Это не картинка'));
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        // обрезаем по центру, чтобы аватар был квадратным
        const side = Math.min(img.width, img.height);
        const x = (img.width - side) / 2;
        const y = (img.height - side) / 2;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, x, y, side, side, 0, 0, size, size);

        // GIF оставляем как есть — с анимацией
        if (file.type === 'image/gif') {
          resolve(reader.result);
          return;
        }
        let out = 'image/jpeg';
        let data = canvas.toDataURL('image/jpeg', 0.85);
        if (data.length > AVATAR_MAX_BYTES) {
          out = 'image/webp';
          data = canvas.toDataURL('image/webp', 0.8);
        }
        if (data.length > AVATAR_MAX_BYTES) {
          reject(new Error('Картинка слишком большая даже после сжатия'));
          return;
        }
        resolve(data);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- индикатор речи ---------- */

// Порог срабатывания и задержка отпускания, чтобы обводка не мигала
const SPEAKING_THRESHOLD = 0.02;
const SPEAKING_HOLD_MS = 420;

let levelsBox = null;
let levelBars = [];
let audioCtx = null;

/** Строит полоску уровня звука один раз. */
function buildLevelBars() {
  if (!levelsBox) levelsBox = document.getElementById('callLevels');
  if (!levelsBox || levelsBox.children.length) return;
  levelsBox.textContent = '';
  levelBars = [];
  for (let i = 0; i < 24; i++) {
    const bar = document.createElement('i');
    levelsBox.appendChild(bar);
    levelBars.push(bar);
  }
}

/**
 * Определяет речь по громкости потока.
 *
 * Считаем RMS по временному сигналу — так надёжнее, чем усреднять
 * по частотным полосам: чистый тон даёт там среднее около 6 при пике 255.
 *
 * Порог подстраивается под шум комнаты, чтобы тихий гул не выдавался
 * за речь.
 */
function watchLevel(stream, onLevel) {
  if (!stream || !stream.getAudioTracks().length) return null;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // на всякий случай: в некоторых браузерах контекст стартует приостановленным
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let smoothed = 0;
  let noiseFloor = 0.004;

  const tick = () => {
    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const x = (data[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / data.length);

    // быстрый подъём, плавное затухание — иначе полоса дёргается
    smoothed = rms > smoothed ? rms : smoothed * 0.8 + rms * 0.2;

    // тихо в комнате — пол шума; громко — не трогаем оценку
    if (rms < noiseFloor) noiseFloor = noiseFloor * 0.97 + rms * 0.03;

    onLevel(smoothed, Math.max(SPEAKING_THRESHOLD, noiseFloor * 3));
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    try {
      source.disconnect();
      audioCtx.close();
    } catch {}
    audioCtx = null;
  };
}

/** Обновляет полоску и обводку окна. */
function paintLevel(level, who, threshold) {
  buildLevelBars();
  if (!levelsBox) return;

  const limit = threshold || SPEAKING_THRESHOLD;
  const now = Date.now();
  if (level > limit) call.spokeAt[who] = now;
  const speaking = now - (call.spokeAt[who] || 0) < SPEAKING_HOLD_MS;

  // высоту полоски рисуем сглаженно, чтобы не дёргалось
  const target = Math.min(22, Math.max(3, level * 70));
  for (let i = 0; i < levelBars.length; i++) {
    const wave = 0.45 + 0.55 * Math.abs(Math.sin(now / 190 + i * 0.55));
    const h = speaking ? target * wave : 3;
    levelBars[i].style.height = h.toFixed(1) + 'px';
  }
  levelsBox.classList.toggle('active', speaking);

  const peerSpeaking = now - (call.spokeAt.peer || 0) < SPEAKING_HOLD_MS;
  const selfSpeaking = !call.muted && now - (call.spokeAt.self || 0) < SPEAKING_HOLD_MS;

  // сиреневая обводка на конкретном аватаре: кто говорит — тот подсвечен
  $('callPeerAvatar').classList.toggle('speaking', peerSpeaking);
  $('callMeAvatar').classList.toggle('speaking-self', selfSpeaking);
}

/** Показывает окно звонка. incoming=true — экран входящего. */
function showCallWindow(incoming) {
  const win = $('callWindow');
  win.hidden = false;
  win.classList.toggle('ringing', Boolean(incoming));
  $('callInView').hidden = !incoming;
  $('callActiveView').hidden = incoming;
  buildLevelBars();
}

/** Подпись под своим аватаром: таймер, когда говорим, иначе «ты». */
function myCallState() {
  if (call.muted) return 'микрофон выкл';
  if (call.phase === 'active') return formatTime(callSeconds());
  return 'ты';
}

/** Обновляет содержимое окна под текущее состояние звонка. */
function showCallPanel(hint) {
  // заставка входящего нужна только пока реально звонят — дальше сразу два аватара
  showCallWindow(false);

  const win = $('callWindow');
  const peer = call.peer;

  fillAvatar($('callPeerAvatar'), peer);
  $('callPeerName').textContent = peer ? nameOf(peer) : 'Собеседник';
  $('callPeerState').textContent = hint || '';

  fillAvatar($('callMeAvatar'), state.me);
  $('callMeName').textContent = state.me ? nameOf(state.me) : 'Ты';
  $('callMeState').textContent = myCallState();

  $('callWinError').textContent = '';

  win.classList.toggle('connecting', call.phase === 'connecting');
  win.classList.toggle('failed', call.phase === 'failed');
  win.classList.remove('ringing');

  const retry = $('callRetry');
  if (retry) retry.hidden = call.phase !== 'failed';

  updateMuteButton();
}

function updateMuteButton() {
  const btn = $('callMute');
  if (!btn) return;
  btn.classList.toggle('on', call.muted);
  btn.querySelector('.rb-icon').textContent = call.muted ? '🔇' : '🎤';
  const meAvatar = $('callMeAvatar');
  if (meAvatar) meAvatar.classList.toggle('dimmed', call.muted);
  const state_ = $('callMeState');
  if (state_) state_.textContent = myCallState();
}

function hideCallPanel() {
  $('callWindow').hidden = true;
  for (const bar of levelBars) bar.style.height = '3px';
  if (levelsBox) levelsBox.classList.remove('active');
  const win = $('callWindow');
  win.classList.remove('connecting', 'failed', 'ringing');
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
    remoteAudio.volume = 1;
    document.body.appendChild(remoteAudio);
  }
  if (remoteAudio.srcObject !== stream) {
    remoteAudio.srcObject = stream;
    // без жеста пользователя autoplay со звуком может не запуститься
    remoteAudio.play().catch(() => {
      remoteAudio.muted = false;
      return remoteAudio.play().catch(() => {});
    });
  }

  // следим за громкостью собеседника — по ней загорается обводка
  if (call.stopRemoteWatch) call.stopRemoteWatch();
  call.stopRemoteWatch = watchLevel(stream, (level, threshold) => paintLevel(level, 'peer', threshold));
}

/** Следит за своим голосом — видно, работает ли микрофон. */
function watchSelfLevel() {
  if (!call.local || call.stopSelfWatch) return;
  call.stopSelfWatch = watchLevel(call.local, (level, threshold) => {
    // если заглушили, сразу считаем, что молчим
    if (call.muted) {
      call.spokeAt.self = 0;
      return;
    }
    paintSelfLevel(level, threshold);
  });
}

function paintSelfLevel(level, threshold) {
  const now = Date.now();
  if (level > (threshold || SPEAKING_THRESHOLD)) call.spokeAt.self = now;
  // обводку от себя рисуем только если собеседник молчит
  if (now - (call.spokeAt.peer || 0) >= SPEAKING_HOLD_MS) {
    paintLevel(0, 'none', threshold);
  }
}

function startCallTimer() {
  clearInterval(call.timer);
  call.timer = setInterval(() => {
    if (call.phase !== 'active') return;
    const state_ = $('callMeState');
    if (state_) state_.textContent = myCallState();
  }, 1000);
}

let noticeTimer = null;
function notice(text) {
  const box = $('typing');
  box.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (call.phase === 'idle') box.textContent = '';
  }, 4000);
}

/** Заливаем кандидаты, пришедшие раньше, чем появилось соединение. */
async function flushPendingIce() {
  if (!call.pc || !call.pendingIce.length) return;
  const list = call.pendingIce.splice(0);
  for (const candidate of list) {
    try {
      await call.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('[звонок] кандидат не принят', err.message);
    }
  }
}

function newPeerConnection() {
  const pc = new RTCPeerConnection(rtcConfig || { iceServers: STUN_SERVERS.map((urls) => ({ urls })) });

  // сколько адресов нашли — по этому видно, работает ли STUN
  call.candidates = { host: 0, srflx: 0, relay: 0 };

  pc.onicecandidate = (e) => {
    if (!call.room || !e.candidate) return;

    // srflx — адрес из интернета (значит STUN сработал),
    // relay — через TURN-сервер (единственный способ при жёстком NAT)
    const type = e.candidate.type;
    if (type in call.candidates) call.candidates[type] += 1;

    console.log('[звонок] кандидат:', type, (e.candidate.candidate || '').slice(0, 60));
    sendWs({ t: 'call', action: 'ice', room: call.room, payload: e.candidate.toJSON() });
  };

  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) attachRemoteAudio(e.streams[0]);
    else if (e.track) attachRemoteAudio(new MediaStream([e.track]));
  };

  pc.onconnectionstatechange = () => {
    if (!call.pc || call.pc !== pc) return;
    if (pc.connectionState === 'connected') {
      call.phase = 'active';
      call.startedAt = Date.now();
      startCallTimer();
      setCallStatus('соединено');
      callBtnDisabled(false);
    } else if (pc.connectionState === 'connecting') {
      setCallStatus('соединяемся...');
    } else if (pc.connectionState === 'failed') {
      failCall('Сеть не дала соединить напрямую');
    } else if (pc.connectionState === 'disconnected') {
      setCallStatus('связь пропала, ждём...');
    } else if (pc.connectionState === 'closed') {
      endCall(false);
    }
  };

  // подробности помогают понять, в чём дело, если не соединилось
  pc.oniceconnectionstatechange = () => {
    if (!call.pc || call.pc !== pc) return;
    const s = pc.iceConnectionState;
    if (s === 'checking') setCallStatus('проверяем путь связи...');
    if (s === 'failed') failCall('Прямое соединение невозможно');
    console.log('[звонок] ice:', s);
  };

  return pc;
}

function callBtnDisabled(value) {
  const btn = $('callBtn');
  if (btn) btn.disabled = value;
}

/** Соединение не установилось — объясняем почему и предлагаем повторить. */
function failCall(reason) {
  if (call.phase === 'idle' || call.phase === 'failed') return;
  call.phase = 'failed';

  // если нашлись только внутренние адреса — STUN заблокирован, нужен TURN
  const c = call.candidates || {};
  let text = reason;
  if (c.srflx === 0 && c.relay === 0) {
    text = 'сеть блокирует прямые звонки — нужен TURN';
    console.warn(
      '[звонок] не нашлось ни одного внешнего адреса. STUN-серверы недоступны.',
      c
    );
  }

  setCallStatus(text);
  callBtnDisabled(false);

  clearTimeout(call.failTimer);
  call.failTimer = setTimeout(() => {
    if (call.phase === 'failed') endCall(false);
  }, 15000);
}

function addLocalTracks(pc) {
  for (const track of call.local.getTracks()) pc.addTrack(track, call.local);
}

/* --- исходящий звонок --- */

async function startCall() {
  const room = state.room;
  if (!isDmRoom(room)) {
    alert('Звонки доступны только в личных переписках');
    return;
  }
  if (call.phase !== 'idle') {
    // повтор после неудачи — просто начинаем заново
    if (call.phase !== 'failed') {
      alert('Ты уже в звонке');
      return;
    }
    resetCall();
  }

  call.room = room;
  call.peer = peerOfRoom(room);
  call.role = 'caller';
  call.phase = 'connecting';
  call.pendingIce = [];
  callBtnDisabled(true);

  // креды TURN живут недолго — берём свежие перед каждым звонком
  await refreshTurn();

  try {
    call.local = await getMic();
  } catch (err) {
    resetCall();
    alert('Не получилось включить микрофон:\n\n' + err.message);
    return;
  }

  call.pc = newPeerConnection();
  addLocalTracks(call.pc);
  watchSelfLevel();

  try {
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    sendWs({ t: 'call', action: 'offer', room, payload: { type: offer.type, sdp: offer.sdp } });
    setCallStatus('звоним...');
  } catch (err) {
    notice('Не удалось начать звонок');
    endCall(false);
    return;
  }

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
    sendWs({ t: 'call', action: 'decline', room: msg.room });
    return;
  }
  call.incoming = msg;

  // компактный экран входящего, как в Телеграме
  fillAvatar($('callInAvatar'), msg.from);
  $('callInName').textContent = nameOf(msg.from);
  $('callInSub').textContent = 'входящий звонок…';
  $('callInError').textContent = '';
  $('callRetry').hidden = true;
  showCallWindow(true);
}

async function acceptCall() {
  const msg = call.incoming;
  if (!msg) return;

  call.incoming = null;
  call.room = msg.room;
  call.peer = msg.from;
  call.role = 'callee';
  call.phase = 'connecting';
  call.pendingIce = [];
  callBtnDisabled(true);

  try {
    call.local = await getMic();
  } catch (err) {
    sendWs({ t: 'call', action: 'hangup', room: msg.room });
    const peer = msg.from;
    resetCall();
    // окно оставляем ненадолго, чтобы человек увидел причину
    fillAvatar($('callInAvatar'), peer);
    $('callInName').textContent = nameOf(peer);
    $('callInSub').textContent = 'звонок сброшен';
    $('callInError').textContent = 'Микрофон недоступен: ' + err.message;
    showCallWindow(true);
    setTimeout(() => hideCallPanel(), 4500);
    return;
  }

  call.pc = newPeerConnection();
  addLocalTracks(call.pc);
  watchSelfLevel();

  try {
    await call.pc.setRemoteDescription(msg.payload);
    // ключевой момент: кандидаты могли прийти пока мы показывали окно
    await flushPendingIce();

    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    sendWs({ t: 'call', action: 'answer', room: msg.room, payload: { type: answer.type, sdp: answer.sdp } });
    setCallStatus('соединяемся...');
  } catch (err) {
    notice('Не удалось ответить');
    endCall(false);
  }
}

function declineCall() {
  const msg = call.incoming;
  hideCallPanel();
  call.incoming = null;
  if (msg) sendWs({ t: 'call', action: 'decline', room: msg.room });
}

/* --- управление звонком --- */

function toggleMute() {
  if (!call.local) return;
  call.muted = !call.muted;
  for (const track of call.local.getAudioTracks()) track.enabled = !call.muted;
  updateMuteButton();

  // заглушил — свою подсветку сразу убираем, но полоску оставляем видеть собеседника
  if (call.muted) {
    call.spokeAt.self = 0;
    $('callMeAvatar').classList.remove('speaking-self');
    if (Date.now() - (call.spokeAt.peer || 0) >= SPEAKING_HOLD_MS) {
      paintLevel(0, 'none');
    }
  }
}

function hangUp() {
  if (call.room) sendWs({ t: 'call', action: 'hangup', room: call.room });
  endCall(false);
}

function retryCall() {
  if (call.phase !== 'failed') return;
  endCall(false);
  setTimeout(() => {
    if (state.room === call.room || true) startCall();
  }, 300);
}

/** Уборка. notify — отправить собеседнику «сбросил». */
function endCall(notify) {
  if (notify && call.room) sendWs({ t: 'call', action: 'hangup', room: call.room });

  clearInterval(call.timer);
  clearTimeout(call.failTimer);

  if (call.stopRemoteWatch) {
    call.stopRemoteWatch();
    call.stopRemoteWatch = null;
  }
  if (call.stopSelfWatch) {
    call.stopSelfWatch();
    call.stopSelfWatch = null;
  }

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
  hideCallPanel();
}

function resetCall() {
  clearInterval(call.timer);
  clearTimeout(call.failTimer);
  call.room = null;
  call.pc = null;
  call.local = null;
  call.peer = null;
  call.role = null;
  call.phase = 'idle';
  call.muted = false;
  call.startedAt = 0;
  call.status = '';
  call.pendingIce = [];
  call.spokeAt = { peer: 0, self: 0 };
  call.incoming = null;
  $('callWindow').hidden = true;
  const retry = $('callRetry');
  if (retry) retry.hidden = true;
  callBtnDisabled(false);
}

/** Обработка сигналов от собеседника. */
function onCallSignal(data) {
  const { action, room, payload } = data;

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
        hideCallPanel();
        call.incoming = null;
      }
      return;

    case 'answer':
      if (!call.pc || call.room !== room) return;
      call.pc
        .setRemoteDescription(payload)
        .then(() => flushPendingIce())
        .catch((err) => console.warn('[звонок] answer не принят', err.message));
      return;

    case 'ice':
      if (call.room !== room || !payload) return;
      // если соединения ещё нет — копим кандидаты, иначе они пропадут
      if (!call.pc || !call.pc.remoteDescription) {
        call.pendingIce.push(payload);
        return;
      }
      call.pc.addIceCandidate(payload).catch(() => {});
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

  // TURN для звонков подгружаем заранее, до первого звонка
  await loadTurnConfig();

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
  $('callRetry').addEventListener('click', retryCall);
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
  $('pfAvatarPick').addEventListener('click', () => $('pfAvatarFile').click());
  $('pfAvatarFile').addEventListener('change', (e) => pickAvatarFile(e.target.files[0]));
  $('pfAvatarClear').addEventListener('click', () => {
    pendingAvatar = null;
    pendingAvatarPreview = null;
    fillAvatar($('pfAvatarPreview'), state.me, null);
  });

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
