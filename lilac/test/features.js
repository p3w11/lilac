'use strict';

/* Тесты: профиль, настройки приватности, роли и модерация. */

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
  console.log('\n— Профиль —');
  const anna = await register('anna_' + stamp, 'Анна');
  const bob = await register('bobr_' + stamp, 'Борис');

  assert.strictEqual(anna.data.user.bio, '', ' bio по умолчанию пустой');
  assert.deepStrictEqual(
    anna.data.user.settings,
    {
      profileVisibility: 'everyone',
      onlineStatus: 'everyone',
      directMessages: 'everyone',
      typingIndicator: 'everyone',
      readReceipts: 'everyone',
    },
    'настройки по умолчанию — как в Telegram'
  );
  ok('у нового пользователя пустой профиль и настройки по умолчанию');

  const ren = await req('/api/me/profile', {
    method: 'PATCH',
    cookie: anna.cookie,
    body: { displayName: 'Анна Петрова', bio: 'Люблю сиреневый цвет' },
  });
  assert.strictEqual(ren.status, 200);
  assert.strictEqual(ren.data.user.displayName, 'Анна Петрова');
  assert.strictEqual(ren.data.user.bio, 'Люблю сиреневый цвет');
  assert.strictEqual(ren.data.user.username, 'anna_' + stamp, ' логин не меняется');
  ok('имя и «о себе» редактируются');

  const tooLong = await req('/api/me/profile', {
    method: 'PATCH',
    cookie: anna.cookie,
    body: { displayName: 'x'.repeat(40) },
  });
  assert.strictEqual(tooLong.status, 400);
  ok('слишком длинное имя отклоняется');

  const seen = await req(`/api/users/anna_${stamp}`, { cookie: bob.cookie });
  assert.strictEqual(seen.status, 200);
  assert.strictEqual(seen.data.user.bio, 'Люблю сиреневый цвет', 'другой видит описание');
  assert.strictEqual(seen.data.user.settings, undefined, ' чужие настройки не отдаются');
  ok('другой видит профиль, но не видит настройки приватности');

  console.log('\n— Приватность —');
  await req('/api/me/settings', {
    method: 'PUT',
    cookie: anna.cookie,
    body: { profileVisibility: 'nobody' },
  });
  const hidden = await req(`/api/users/anna_${stamp}`, { cookie: bob.cookie });
  assert.strictEqual(hidden.status, 403, 'скрытый профиль недоступен');
  ok('скрытый профиль никому не показывается (403)');

  const list = await req('/api/users', { cookie: bob.cookie });
  assert.ok(!list.data.users.some((u) => u.username === 'anna_' + stamp), 'скрытого нет в списке');
  ok('скрытый пользователь исчезает из списка');

  const badLevel = await req('/api/me/settings', {
    method: 'PUT',
    cookie: anna.cookie,
    body: { profileVisibility: 'всем' },
  });
  assert.strictEqual(badLevel.status, 200);
  assert.strictEqual(badLevel.data.user.settings.profileVisibility, 'everyone', 'мусор отброшен');
  ok('некорректное значение отбрасывается, остаётся дефолт');

  // Личные сообщения запрещены
  await req('/api/me/settings', {
    method: 'PUT',
    cookie: anna.cookie,
    body: { directMessages: 'nobody' },
  });
  const wsBob = await connect(bob.cookie);
  wsBob.send(JSON.stringify({ t: 'open', username: 'anna_' + stamp }));
  const refused = await until(wsBob, 'error');
  assert.ok(refused && /запретил/.test(refused.error), 'личные сообщения запрещены');
  ok('запрет личных сообщений работает');

  await req('/api/me/settings', {
    method: 'PUT',
    cookie: anna.cookie,
    body: { directMessages: 'nobody' },
  });
  const wsBob2 = await connect(bob.cookie);
  wsBob2.send(JSON.stringify({ t: 'send', room: 'dm:1:99999', text: 'привет' }));
  await wait(200);
  const canWrite = await req(`/api/users/anna_${stamp}`, { cookie: bob.cookie });
  assert.strictEqual(canWrite.data.canWrite, false, 'кнопка «написать» скрыта');
  ok('в профиле видно, что писать нельзя');

  await req('/api/me/settings', { method: 'PUT', cookie: anna.cookie, body: { directMessages: 'everyone' } });

  console.log('\n— Онлайн и приватность —');
  wsBob2.inbox = []; // отбрасываем события, накопленные пока
  const wsAnna = await connect(anna.cookie);
  const helloBob = await until(wsBob2, 'presence');
  assert.ok(helloBob && helloBob.online.some((u) => u.username === 'anna_' + stamp), 'онлайн виден');
  ok('онлайн виден по умолчанию');

  wsBob2.inbox = [];
  await req('/api/me/settings', { method: 'PUT', cookie: anna.cookie, body: { onlineStatus: 'nobody' } });
  const hiddenOnline = await until(wsBob2, 'presence');
  assert.ok(
    hiddenOnline && !hiddenOnline.online.some((u) => u.username === 'anna_' + stamp),
    'онлайн скрыт'
  );
  ok('скрытый онлайн пропадает из чужого списка');

  wsBob2.inbox = [];
  await req('/api/me/settings', { method: 'PUT', cookie: anna.cookie, body: { onlineStatus: 'everyone' } });
  await until(wsBob2, 'presence');

  console.log('\n— Роли —');
  const admin = await req('/api/login', { method: 'POST', body: { username: 'p3w1', password: process.env.ADMIN_PASS || '228_1337' } });
  assert.strictEqual(admin.status, 200, 'вход админом не удался');

  const usersRes = await req('/api/admin/users', { cookie: admin.cookie });
  const annaRow = usersRes.data.users.find((u) => u.username === 'anna_' + stamp);
  const ownerRow = usersRes.data.users.find((u) => u.username === 'p3w1');
  assert.ok(annaRow && ownerRow, 'пользователи найдены');
  assert.strictEqual(ownerRow.isOwner, true, 'владелец помечен');
  assert.strictEqual(ownerRow.role, 'admin');
  ok('владелец помечен как админ');

  const asMod = await req('/api/admin/set-role', {
    method: 'POST',
    cookie: admin.cookie,
    body: { userId: annaRow.id, role: 'moderator' },
  });
  assert.strictEqual(asMod.status, 200);
  ok('роль модератора выдаётся');

  const loginMod = await req('/api/login', { method: 'POST', body: { username: 'anna_' + stamp, password: 'secret123' } });
  const modStats = await req('/api/admin/stats', { cookie: loginMod.cookie });
  assert.strictEqual(modStats.status, 403, 'модератор не видит админку');
  ok('модератор не попадает в админку');

  const modDelete = await req('/api/admin/delete-message', {
    method: 'POST',
    cookie: loginMod.cookie,
    body: { messageId: 999999 },
  });
  assert.notStrictEqual(modDelete.status, 403, 'модератор может удалять сообщения (нужны права)');
  ok('модератору доступно удаление сообщений');

  const modDeleteUser = await req('/api/admin/delete-user', {
    method: 'POST',
    cookie: loginMod.cookie,
    body: { userId: bob.data.user.id },
  });
  assert.strictEqual(modDeleteUser.status, 403, 'модератор не удаляет людей');
  ok('модератор не может удалять пользователей (403)');

  const ownerRole = await req('/api/admin/set-role', {
    method: 'POST',
    cookie: admin.cookie,
    body: { userId: ownerRow.id, role: 'user' },
  });
  assert.strictEqual(ownerRole.status, 400, 'роль владельца менять нельзя');
  ok('роль владельца изменить нельзя');

  const backToUser = await req('/api/admin/set-role', {
    method: 'POST',
    cookie: admin.cookie,
    body: { userId: annaRow.id, role: 'user' },
  });
  assert.strictEqual(backToUser.status, 200);
  const after = await req('/api/admin/users', { cookie: admin.cookie });
  assert.strictEqual(after.data.users.find((u) => u.id === annaRow.id).role, 'user');
  ok('роль можно вернуть обратно');

  console.log('\n— Прочтения —');
  const wsA = await connect(admin.cookie);
  const wsB = await connect(bob.cookie);
  wsA.send(JSON.stringify({ t: 'send', room: 'general', text: 'Кто прочитал?' }));
  const sent = await until(wsB, 'message', (m) => m.msg.text === 'Кто прочитал?');
  assert.ok(sent, 'сообщение доставлено');
  wsB.send(JSON.stringify({ t: 'read', room: 'general', ts: sent.msg.ts }));
  const readEvent = await until(wsA, 'read');
  assert.ok(readEvent && readEvent.userId === bob.data.user.id, 'событие прочтения пришло');
  ok('отметка «прочитано» доходит до автора');

  const bobRead = await until(wsB, 'read');
  assert.ok(bobRead, 'отправитель тоже видит своё прочтение');
  ok('подтверждение прочтения возвращается');

  console.log('\n— Смена пароля —');
  const wrong = await req('/api/me/password', {
    method: 'POST',
    cookie: bob.cookie,
    body: { currentPassword: 'неправильный', newPassword: 'newsecret123' },
  });
  assert.strictEqual(wrong.status, 401);
  ok('неверный текущий пароль отклонён');

  const good = await req('/api/me/password', {
    method: 'POST',
    cookie: bob.cookie,
    body: { currentPassword: 'secret123', newPassword: 'newsecret123' },
  });
  assert.strictEqual(good.status, 200);
  const relogin = await req('/api/login', { method: 'POST', body: { username: 'bobr_' + stamp, password: 'newsecret123' } });
  assert.strictEqual(relogin.status, 200, 'вход с новым паролем');
  ok('пароль меняется и вход с новым работает');

  wsA.close();
  wsB.close();
  wsAnna.close();
  wsBob.close();
  wsBob2.close();

  console.log(`\n✅ Все ${passed} проверок пройдены\n`);
  // открытые сокеты держат событийный цикл — выходим явно
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Тест упал:', err.message, err.stack ? '\n' + err.stack.split('\n')[1] : '');
  process.exit(1);
});
