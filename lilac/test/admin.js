'use strict';

/* Тесты админки: вход админом, запрет для обычных, удаление, очистка */

const assert = require('assert');

const BASE = process.env.BASE || 'http://localhost:3000';
const stamp = Date.now().toString(36);

const ADMIN_USER = process.env.ADMIN_USER || 'p3w1';
const ADMIN_PASS = process.env.ADMIN_PASS || '228_1337';

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓ ' + name);
}

async function req(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, data, cookie: setCookies.length ? setCookies[0].split(';')[0] : null };
}

async function login(username, password) {
  const r = await req('/api/login', { method: 'POST', body: { username, password } });
  return r;
}

async function register(username, password, displayName) {
  const r = await req('/api/register', { method: 'POST', body: { username, password, displayName } });
  if (r.status === 200) return r.data.user;
  // уже существует — просто логинимся
  const l = await req('/api/login', { method: 'POST', body: { username, password } });
  return l.data.user;
}

async function main() {
  console.log('\n— Вход администратора —');
  const admin = await login(ADMIN_USER, ADMIN_PASS);
  assert.strictEqual(admin.status, 200, 'вход админа не удался: ' + JSON.stringify(admin.data));
  assert.ok(admin.cookie, 'кука выдана');
  assert.strictEqual(admin.data.user.passwordHash, undefined, 'хеш пароля не отдаётся');
  ok(`вход как "${ADMIN_USER}" с правами админа`);

  const access = await req('/api/admin/access', { cookie: admin.cookie });
  assert.strictEqual(access.status, 200);
  assert.strictEqual(access.data.isAdmin, true);
  ok('эндпоинт проверки прав подтверждает админа');

  console.log('\n— Обычный пользователь не админ —');
  const userName = 'user_' + stamp;
  const user = await register(userName, 'lilac2026', 'Обычный');
  assert.ok(user && user.id, 'создан обычный пользователь');

  const fake = await login(ADMIN_USER, 'неправильный');
  assert.strictEqual(fake.status, 401);
  ok('неверный пароль админа отклонён');

  const reg = await req('/api/register', { method: 'POST', body: { username: ADMIN_USER, password: 'x'.repeat(10) } });
  assert.strictEqual(reg.status, 409, 'нельзя перехватить логин админа регистрацией');
  ok('логин админа защищён от перехвата через регистрацию');

  // Обычный пользователь получает настоящую cookie и пробует админские методы
  const userLogin = await login(userName, 'lilac2026');
  assert.strictEqual(userLogin.status, 200);
  const setCookie = userLogin.cookie;
  assert.ok(setCookie, 'получили cookie обычного пользователя');

  console.log('\n— Закрытые двери —');
  const noAuth = await req('/api/admin/stats');
  assert.strictEqual(noAuth.status, 401);
  ok('без входа админка недоступна (401)');

  const noAuthAccess = await req('/api/admin/access');
  assert.strictEqual(noAuthAccess.status, 401);
  ok('проверка прав без входа недоступна (401)');

  const userAccess = await req('/api/admin/access', { cookie: setCookie });
  assert.strictEqual(userAccess.data.isAdmin, false, 'обычный пользователь не админ');
  ok('обычному пользователю права не выдаются');

  const notAdmin = await req('/api/admin/stats', { cookie: setCookie });
  assert.strictEqual(notAdmin.status, 403);
  ok('обычному пользователю админка закрыта (403)');

  const listUsers = await req('/api/admin/users', { cookie: setCookie });
  assert.strictEqual(listUsers.status, 403);
  ok('список пользователей закрыт (403)');

  const delUser = await req('/api/admin/delete-user', { method: 'POST', cookie: setCookie, body: { userId: 1 } });
  assert.strictEqual(delUser.status, 403);
  ok('удаление пользователя закрыто (403)');

  const clear = await req('/api/admin/clear', { method: 'POST', cookie: setCookie, body: {} });
  assert.strictEqual(clear.status, 403);
  ok('очистка чата закрыта (403)');

  console.log('\n— Возможности администратора —');
  const stats = await req('/api/admin/stats', { cookie: admin.cookie });
  assert.strictEqual(stats.status, 200);
  assert.ok(stats.data.users >= 2, 'статистика считает пользователей');
  ok('статистика работает');

  const list = await req('/api/admin/users', { cookie: admin.cookie });
  assert.strictEqual(list.status, 200);
  const adminRow = list.data.users.find((u) => u.username === ADMIN_USER);
  assert.ok(adminRow && adminRow.isOwner, 'владелец помечен в списке');
  assert.strictEqual(adminRow.role, 'admin', 'у владельца роль admin');
  ok('список пользователей с ролями и флагом владельца');

  // Сообщение в общий чат обычным пользователем, потом удаление админом
  const newUserName = 'msg_' + stamp;
  await register(newUserName, 'lilac2026', 'Пишущий');

  // список нужно перечитать: новый пользователь появился после прошлой загрузки
  const freshList = await req('/api/admin/users', { cookie: admin.cookie });
  const target = freshList.data.users.find((u) => u.username === newUserName);
  assert.ok(target, 'тестовый пользователь найден');

  const deleted = await req('/api/admin/delete-user', {
    method: 'POST',
    cookie: admin.cookie,
    body: { userId: target.id },
  });
  assert.strictEqual(deleted.status, 200);
  ok('удаление пользователя работает');

  const afterDelete = await req('/api/admin/users', { cookie: admin.cookie });
  assert.ok(!afterDelete.data.users.some((u) => u.username === newUserName), 'удалённый исчез из списка');
  ok('удалённый пользователь исчез');

  const loginDeleted = await login(newUserName, 'lilac2026');
  // 401 — пароль не подошёл, 429 — сработал лимит попыток. Главное, что вход не удался.
  assert.notStrictEqual(loginDeleted.status, 200, 'удалённый не должен войти');
  ok('удалённый пользователь больше не может войти');

  // Админа удалить нельзя
  const delAdmin = await req('/api/admin/delete-user', {
    method: 'POST',
    cookie: admin.cookie,
    body: { userId: adminRow.id },
  });
  assert.strictEqual(delAdmin.status, 400, 'себя удалять нельзя');
  ok('администратора удалить нельзя (защита от ошибки)');

  console.log('\n— Очистка —');
  await fetch(BASE + '/api/messages?room=general'); // просто прогреваем
  const clearGeneral = await req('/api/admin/clear', {
    method: 'POST',
    cookie: admin.cookie,
    body: { room: 'general' },
  });
  assert.strictEqual(clearGeneral.status, 200);
  const afterClear = await req('/api/admin/messages', { cookie: admin.cookie });
  assert.ok(!afterClear.data.messages.some((m) => m.room === 'general'), 'общий чат очищен');
  ok('очистка общем чата работает');

  console.log(`\n✅ Все ${passed} проверок админки пройдены\n`);
}

main().catch((err) => {
  console.error('\n❌ Тест админки упал:', err.message);
  process.exit(1);
});
