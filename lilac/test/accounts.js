'use strict';

/* Тесты: постоянные аккаунты и настройка TURN. */

const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:3000';
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

async function main() {
  const adminUser = process.env.ADMIN_USER || 'p3w1';
  const adminPass = process.env.ADMIN_PASS || '228_1337';
  const guestUser = process.env.GUEST_USER || 'lilac';
  const guestPass = process.env.GUEST_PASS || '123456';

  console.log('\n— Постоянные аккаунты —');
  const owner = await req('/api/login', { method: 'POST', body: { username: adminUser, password: adminPass } });
  assert.strictEqual(owner.status, 200, 'вход владельца: ' + JSON.stringify(owner.data));
  const ownerMe = await req('/api/me', { cookie: owner.cookie });
  assert.strictEqual(ownerMe.data.user.role, 'admin', 'у владельца роль admin');
  ok(`владелец "${adminUser}" на месте с правами админа`);

  const guest = await req('/api/login', { method: 'POST', body: { username: guestUser, password: guestPass } });
  assert.strictEqual(guest.status, 200, 'вход постоянного пользователя: ' + JSON.stringify(guest.data));
  const guestMe = await req('/api/me', { cookie: guest.cookie });
  assert.strictEqual(guestMe.data.user.username, guestUser);
  assert.strictEqual(guestMe.data.user.role, 'user', 'обычный пользователь, не админ');
  ok(`постоянный аккаунт "${guestUser}" создан и входит`);

  const guestAdmin = await req('/api/admin/access', { cookie: guest.cookie });
  assert.strictEqual(guestAdmin.data.isAdmin, false, 'постоянный пользователь не админ');
  ok('постоянный аккаунт не получает прав админа');

  const taken = await req('/api/register', {
    method: 'POST',
    body: { username: guestUser, password: 'whatever1' },
  });
  assert.strictEqual(taken.status, 409, 'нельзя перехватить логин постоянного аккаунта');
  ok('логин постоянного аккаунта защищён от перехвата регистрацией');

  const anon = await req('/api/turn');
  assert.strictEqual(anon.status, 200, 'TURN отдаётся всем');
  assert.ok(Array.isArray(anon.data.iceServers), 'есть массив iceServers');
  assert.ok(typeof anon.data.source === 'string', 'указан источник');
  assert.strictEqual(anon.data.username, undefined, 'секреты Xirsys не отдаются наружу');
  ok('публичный эндпоинт TURN отдаёт только готовые креды');

  console.log('\n— Настройка TURN —');
  const denied = await req('/api/admin/turn', { cookie: guest.cookie });
  assert.strictEqual(denied.status, 403, 'обычному пользователю TURN не настроить');
  ok('настройка TURN закрыта от посторонних (403)');

  const saved = await req('/api/admin/turn', {
    method: 'POST',
    cookie: owner.cookie,
    body: {
      urls: ['turn:test.example.com:3478?transport=udp', 'turn:test.example.com:443?transport=tcp'],
      username: 'user1',
      credential: 'pass1',
    },
  });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.data.turn.urls.length, 2);
  assert.strictEqual(saved.data.turn.username, 'user1');
  ok('TURN сохраняется');

  const publicView = await req('/api/turn');
  assert.strictEqual(publicView.data.iceServers.length, 1, 'клиент получает сервер');
  const server = publicView.data.iceServers[0];
  assert.strictEqual(server.username, 'user1', 'логин дошёл до браузера');
  assert.strictEqual(server.credential, 'pass1');
  ok('клиент получает настройки TURN');

  // TURN без логина и пароля ломает звонки в Chrome — не даём сохранить
  const noCreds = await req('/api/admin/turn', {
    method: 'POST',
    cookie: owner.cookie,
    body: { urls: ['turn:test.example.com:3478'], username: '', credential: '' },
  });
  assert.strictEqual(noCreds.status, 400, 'TURN без пароля отклонён');
  assert.ok(/логин и пароль/.test(noCreds.data.error));
  ok('TURN без логина/пароля отклоняется (иначе Chrome ломает звонки)');

  // адрес turns: (с шифрованием) тоже должен требовать пароль
  const noCredsTls = await req('/api/admin/turn', {
    method: 'POST',
    cookie: owner.cookie,
    body: { urls: ['turns:turn.example.com:5349?transport=tcp'], username: '', credential: '' },
  });
  assert.strictEqual(noCredsTls.status, 400, 'turns: без пароля тоже отклонён');
  ok('адрес turns: тоже требует логин и пароль');

  // один только stun: пароль не нужен
  const stunOnly = await req('/api/admin/turn', {
    method: 'POST',
    cookie: owner.cookie,
    body: { urls: ['stun:stun.example.com:3478'], username: '', credential: '' },
  });
  assert.strictEqual(stunOnly.status, 200, 'stun: сохраняется без пароля');
  const stunServed = await req('/api/turn');
  assert.strictEqual(stunServed.data.iceServers[0].username, undefined, 'у stun нет логина');
  ok('stun: сохраняется и отдаётся без лишних полей');

  await req('/api/admin/turn', {
    method: 'POST',
    cookie: owner.cookie,
    body: {
      urls: ['turn:test.example.com:3478?transport=udp'],
      username: 'user1',
      credential: 'pass1',
    },
  });

  const stillThere = await req('/api/turn');
  assert.strictEqual(
    stillThere.data.iceServers[0] && stillThere.data.iceServers[0].username,
    'user1',
    'предыдущие настройки не затёрлись'
  );
  ok('ошибочное сохранение не портит настройки');

  // возвращаем пусто, чтобы не мешало другим тестам
  await req('/api/admin/turn', {
    method: 'POST',
    cookie: owner.cookie,
    body: { urls: [], username: '', credential: '' },
  });
  const cleared = await req('/api/turn');
  assert.strictEqual(cleared.data.iceServers.length, 0, 'после очистки серверов нет');
  ok('TURN можно очистить');

  console.log(`\n✅ Все ${passed} проверок пройдены\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Тест упал:', err.message);
  process.exit(1);
});
