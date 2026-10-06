'use strict';

/* Тесты групп и каналов: создание, доступ, права, каналы только для чтения. */

const assert = require('assert');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const stamp = Date.now().toString(36);

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓ ' + name);
}

async function req(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, data, cookie: setCookies.length ? setCookies[0].split(';')[0] : null };
}

async function register(username, displayName) {
  const r = await req('/api/register', {
    method: 'POST',
    body: { username, password: 'secret123', displayName },
  });
  if (r.status !== 200) throw new Error('регистрация ' + username + ': ' + JSON.stringify(r.data));
  return r;
}

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS, { headers: { Cookie: cookie } });
    ws.inbox = [];
    ws.on('message', (raw) => {
      try {
        ws.inbox.push(JSON.parse(String(raw)));
      } catch {}
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(ws, type, predicate = () => true, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = ws.inbox.find((m) => m.t === type && predicate(m));
    if (found) {
      ws.inbox = ws.inbox.filter((m) => m !== found);
      return found;
    }
    await wait(25);
  }
  return null;
}

async function main() {
  const anna = await register('ga_' + stamp, 'Анна');
  const boris = await register('gb_' + stamp, 'Борис');
  const veer = await register('gc_' + stamp, 'Вeer'.replace('e', 'е'));

  console.log('\n— Создание группы —');
  const noName = await req('/api/rooms', {
    method: 'POST',
    cookie: anna.cookie,
    body: { kind: 'group', name: 'а' },
  });
  assert.strictEqual(noName.status, 400);
  ok('слишком короткое название отклонено');

  const group = await req('/api/rooms', {
    method: 'POST',
    cookie: anna.cookie,
    body: {
      kind: 'group',
      name: 'Друзья Lilac',
      description: 'Наш чат',
      memberIds: [boris.data.user.id],
    },
  });
  assert.strictEqual(group.status, 200, JSON.stringify(group.data));
  assert.ok(group.data.room.room.startsWith('group:'), 'ключ группы');
  assert.strictEqual(group.data.room.members, 2, 'Анна + Борис');
  assert.strictEqual(group.data.room.isOwner, true);
  assert.strictEqual(group.data.room.canPost, true);
  ok('группа создаётся с участниками');

  const detail = await req(`/api/rooms/${group.data.room.room}`, { cookie: boris.cookie });
  assert.strictEqual(detail.status, 200, 'участник видит группу');
  assert.strictEqual(detail.data.members.length, 2);
  ok('участник открывает группу');

  const outsider = await req(`/api/rooms/${group.data.room.room}`, { cookie: veer.cookie });
  assert.strictEqual(outsider.status, 403, 'посторонний не видит группу');
  ok('посторонний не имеет доступа к закрытой группе (403)');

  console.log('\n— Переписка в группе —');
  const wsAnna = await connect(anna.cookie);
  const wsBoris = await connect(boris.cookie);
  const wsVeer = await connect(veer.cookie);

  wsAnna.send(JSON.stringify({ t: 'send', room: group.data.room.room, text: 'Привет, группа!' }));
  const got = await until(wsBoris, 'message', (m) => m.msg.room === group.data.room.room);
  assert.ok(got && got.msg.text === 'Привет, группа!');
  ok('участники видят сообщения группы в реальном времени');

  await wait(200);
  assert.ok(
    !wsVeer.inbox.some((m) => m.msg && m.msg.text === 'Привет, группа!'),
    'посторонний не получает сообщения группы'
  );
  ok('посторонний не получает сообщения группы');

  wsVeer.send(JSON.stringify({ t: 'send', room: group.data.room.room, text: 'влезаю' }));
  const refused = await until(wsVeer, 'error');
  assert.ok(refused, 'постороннему отказано в отправке');
  ok('посторонний не может писать в группу');

  console.log('\n— Управление группой —');
  const rename = await req(`/api/rooms/${group.data.room.room}`, {
    method: 'PATCH',
    cookie: anna.cookie,
    body: { name: 'Друзья' },
  });
  assert.strictEqual(rename.status, 200);
  assert.strictEqual(rename.data.room.name, 'Друзья');
  ok('владелец переименовывает группу');

  const renameByMember = await req(`/api/rooms/${group.data.room.room}`, {
    method: 'PATCH',
    cookie: boris.cookie,
    body: { name: 'Моё название' },
  });
  assert.strictEqual(renameByMember.status, 403, 'участник не может переименовать');
  ok('участник не может менять настройки группы (403)');

  const add = await req(`/api/rooms/${group.data.room.room}/members`, {
    method: 'POST',
    cookie: anna.cookie,
    body: { userId: veer.data.user.id },
  });
  assert.strictEqual(add.status, 200);
  ok('владелец добавляет участника');

  const addedOk = await req(`/api/rooms/${group.data.room.room}`, { cookie: veer.cookie });
  assert.strictEqual(addedOk.status, 200, 'новый участник видит группу');
  ok('добавленный участник получает доступ');

  const kickByMember = await req(`/api/rooms/${group.data.room.room}/members/${veer.data.user.id}`, {
    method: 'DELETE',
    cookie: boris.cookie,
  });
  assert.strictEqual(kickByMember.status, 403, 'участник не может убирать');
  ok('участник не может убирать людей (403)');

  const kick = await req(`/api/rooms/${group.data.room.room}/members/${veer.data.user.id}`, {
    method: 'DELETE',
    cookie: anna.cookie,
  });
  assert.strictEqual(kick.status, 200);
  const afterKick = await req(`/api/rooms/${group.data.room.room}`, { cookie: veer.cookie });
  assert.strictEqual(afterKick.status, 403, 'после удаления доступа нет');
  ok('владелец убирает участника, доступ пропадает');

  const kickOwner = await req(`/api/rooms/${group.data.room.room}/members/${anna.data.user.id}`, {
    method: 'DELETE',
    cookie: anna.cookie,
  });
  assert.strictEqual(kickOwner.status, 400, 'владельца убрать нельзя');
  ok('владельца нельзя убрать из группы');

  const ownerLeave = await req(`/api/rooms/${group.data.room.room}/leave`, {
    method: 'POST',
    cookie: anna.cookie,
  });
  assert.strictEqual(ownerLeave.status, 400, 'владелец не может выйти');
  ok('владелец не может покинуть свою группу');

  const memberLeave = await req(`/api/rooms/${group.data.room.room}/leave`, {
    method: 'POST',
    cookie: boris.cookie,
  });
  assert.strictEqual(memberLeave.status, 200);
  const afterLeave = await req(`/api/rooms/${group.data.room.room}`, { cookie: boris.cookie });
  assert.strictEqual(afterLeave.status, 403);
  ok('участник может покинуть группу');

  console.log('\n— Каналы —');
  const channel = await req('/api/rooms', {
    method: 'POST',
    cookie: anna.cookie,
    body: { kind: 'channel', name: 'Новости Lilac', description: 'Анонсы', memberIds: [boris.data.user.id] },
  });
  assert.strictEqual(channel.status, 200);
  assert.strictEqual(channel.data.room.kind, 'channel');
  assert.strictEqual(channel.data.room.canPost, true, 'владелец писать может');
  ok('канал создаётся');

  const chForMember = await req(`/api/rooms/${channel.data.room.room}`, { cookie: boris.cookie });
  assert.strictEqual(chForMember.data.room.canPost, false, 'участник только читает');
  ok('участник канала не может писать');

  wsBoris.send(JSON.stringify({ t: 'send', room: channel.data.room.room, text: 'можно я?' }));
  const chErr = await until(wsBoris, 'error');
  assert.ok(chErr && /только администраторы/.test(chErr.error), 'участнику канала отказано');
  ok('попытка писать в канал отклонена');

  wsAnna.send(JSON.stringify({ t: 'send', room: channel.data.room.room, text: 'Анонс!' }));
  const chGot = await until(wsBoris, 'message', (m) => m.msg.room === channel.data.room.room);
  assert.ok(chGot && chGot.msg.text === 'Анонс!');
  ok('администратор пишет в канал, участники видят');

  wsBoris.inbox = [];
  wsBoris.send(JSON.stringify({ t: 'read', room: channel.data.room.room, ts: Date.now() }));
  await wait(250);
  assert.ok(!wsAnna.inbox.some((m) => m.t === 'read'), 'в канале нет отметок о прочтении');
  ok('в каналах отметки о прочтении отключены');

  console.log('\n— Публичный канал —');
  const pub = await req('/api/rooms', {
    method: 'POST',
    cookie: anna.cookie,
    body: { kind: 'channel', name: 'Объявления', isPublic: true },
  });
  assert.strictEqual(pub.data.room.isPublic, true);
  const pubView = await req(`/api/rooms/${pub.data.room.room}`, { cookie: veer.cookie });
  assert.strictEqual(pubView.status, 200, 'публичный канал виден всем');
  const pubPost = await req(`/api/rooms/${pub.data.room.room}`, { cookie: veer.cookie });
  assert.strictEqual(pubPost.data.room.canPost, false, 'но писать нельзя');
  ok('публичный канал читают все, пишет только админ');

  console.log('\n— Список комнат —');
  // Борис вышел из группы, но остался в приватном канале
  const annaRooms = await req('/api/rooms', { cookie: anna.cookie });
  assert.ok(annaRooms.data.groups.length >= 1, 'группы в списке владельца');
  assert.ok(annaRooms.data.channels.length >= 2, 'каналы в списке владельца');
  ok('группы и каналы попадают в боковую панель');

  const borisRooms = await req('/api/rooms', { cookie: boris.cookie });
  assert.ok(borisRooms.data.groups.length === 0, 'группы, из которых вышел, пропали');
  assert.ok(
    borisRooms.data.channels.some((c) => c.name === 'Новости Lilac'),
    'приватный канал остался'
  );
  ok('после выхода группа исчезает, канал остаётся');

  const veerRooms = await req('/api/rooms', { cookie: veer.cookie });
  const kinds = veerRooms.data.channels.map((c) => c.isPublic);
  assert.ok(kinds.includes(true), 'публичный канал в списке постороннего');
  assert.ok(!veerRooms.data.groups.length, 'чужие закрытые группы не показываются');
  ok('в списке только доступные комнаты');

  console.log('\n— Удаление —');
  const delByMember = await req(`/api/rooms/${pub.data.room.room}`, {
    method: 'DELETE',
    cookie: veer.cookie,
  });
  assert.strictEqual(delByMember.status, 403);
  ok('не-владелец не может удалить комнату');

  const del = await req(`/api/rooms/${pub.data.room.room}`, { method: 'DELETE', cookie: anna.cookie });
  assert.strictEqual(del.status, 200);
  const gone = await req(`/api/rooms/${pub.data.room.room}`, { cookie: anna.cookie });
  assert.strictEqual(gone.status, 404);
  ok('владелец удаляет комнату, сообщения сносятся');

  wsAnna.close();
  wsBoris.close();
  wsVeer.close();

  console.log(`\n✅ Все ${passed} проверок пройдены\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Тест упал:', err.message, err.stack ? '\n' + err.stack.split('\n')[1] : '');
  process.exit(1);
});
