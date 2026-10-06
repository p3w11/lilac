'use strict';

/* Админ-панель Lilac */

const $ = (id) => document.getElementById(id);

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401 || res.status === 403) {
    location.replace('/');
    throw new Error('Нет доступа');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const dateTime = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function roomName(room) {
  return room === 'general' ? 'Общий чат' : 'Личная переписка';
}

function confirmThen(message, action) {
  if (!confirm(message)) return;
  action().catch((err) => alert(err.message));
}

async function loadStats() {
  const s = await api('/api/admin/stats');
  const box = $('cards');
  box.textContent = '';
  const items = [
    ['Пользователей', s.users],
    ['Сообщений', s.messages],
    ['Онлайн сейчас', s.online],
    ['Активны за 7 дней', s.active7d],
  ];
  for (const [cap, num] of items) {
    const card = el('div', 'stat');
    card.appendChild(el('div', 'num', String(num)));
    card.appendChild(el('div', 'cap', cap));
    box.appendChild(card);
  }
}

async function loadUsers() {
  const { users } = await api('/api/admin/users');
  $('usersCount').textContent = `всего: ${users.length}`;
  const body = $('usersBody');
  body.textContent = '';

  for (const u of users) {
    const tr = el('tr');

    const nameCell = el('td');
    nameCell.appendChild(document.createTextNode(u.displayName));
    if (u.isAdmin) {
      nameCell.appendChild(document.createTextNode(' '));
      nameCell.appendChild(el('span', 'tag', 'админ'));
    }
    tr.appendChild(nameCell);

    tr.appendChild(el('td', null, '@' + u.username));
    tr.appendChild(el('td', null, String(u.messages)));
    tr.appendChild(el('td', null, dateTime(u.createdAt)));
    tr.appendChild(el('td', null, dateTime(u.lastMessageAt)));

    const actions = el('td');
    if (!u.isAdmin) {
      const btn = el('button', 'btn-mini danger', 'Удалить');
      btn.type = 'button';
      btn.addEventListener('click', () =>
        confirmThen(
          `Удалить ${u.displayName} (@${u.username}) и все его сообщения? Отменить нельзя.`,
          async () => {
            await api('/api/admin/delete-user', { method: 'POST', body: JSON.stringify({ userId: u.id }) });
            await loadUsers();
            await loadStats();
          }
        )
      );
      actions.appendChild(btn);
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

async function loadMessages() {
  const { messages } = await api('/api/admin/messages?limit=60');
  const body = $('messagesBody');
  body.textContent = '';

  for (const m of messages) {
    const tr = el('tr');
    tr.appendChild(el('td', null, m.displayName));
    tr.appendChild(el('td', null, roomName(m.room)));
    tr.appendChild(el('td', 'msg-cell', m.text));
    tr.appendChild(el('td', null, dateTime(m.ts)));

    const actions = el('td');
    const btn = el('button', 'btn-mini danger', 'Удалить');
    btn.type = 'button';
    btn.addEventListener('click', () =>
      confirmThen('Удалить это сообщение?', async () => {
        await api('/api/admin/delete-message', { method: 'POST', body: JSON.stringify({ messageId: m.id }) });
        await loadMessages();
        await loadStats();
      })
    );
    actions.appendChild(btn);
    tr.appendChild(actions);

    body.appendChild(tr);
  }

  if (!messages.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'Сообщений пока нет');
    td.colSpan = 5;
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

function setupDangerButtons() {
  $('clearGeneral').addEventListener('click', () =>
    confirmThen('Очистить ВСЕ сообщения из общего чата?', async () => {
      await api('/api/admin/clear', { method: 'POST', body: JSON.stringify({ room: 'general' }) });
      await loadMessages();
      await loadStats();
    })
  );

  $('clearAll').addEventListener('click', () =>
    confirmThen('Удалить вообще все сообщения, включая личные переписки? Отменить нельзя.', async () => {
      await api('/api/admin/clear', { method: 'POST', body: JSON.stringify({}) });
      await loadMessages();
      await loadStats();
    })
  );

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.replace('/');
  });
}

async function main() {
  const me = await api('/api/me').catch(() => null);
  if (!me || !me.user) return location.replace('/');
  if (!me.user.isAdmin) {
    document.body.textContent = 'Доступ только для администратора';
    return;
  }
  setupDangerButtons();
  await loadStats();
  await loadUsers();
  await loadMessages();
}

main();
