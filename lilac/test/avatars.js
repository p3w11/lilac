'use strict';

/* Тесты аватарок: загрузка, проверка формата, отдача картинкой. */

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
  return { status: res.status, data, res };
}

// Крошечный настоящий PNG 1x1
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC';

async function main() {
  const reg = await req('/api/register', {
    method: 'POST',
    body: { username: 'av_' + stamp, password: 'secret123', displayName: 'Аватарщик' },
  });
  assert.strictEqual(reg.status, 200, 'регистрация: ' + JSON.stringify(reg.data));
  const cookie = reg.res.headers.getSetCookie()[0].split(';')[0];
  const id = reg.data.user.id;

  console.log('\n— Аватар —');
  const me = await req('/api/me', { cookie });
  assert.strictEqual(me.data.user.hasAvatar, false, 'изначально аватара нет');
  ok('новый пользователь без аватара');

  const set = await req('/api/me/profile', {
    method: 'PATCH',
    cookie,
    body: { avatar: PNG_1PX },
  });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.data.user.hasAvatar, true, 'аватар сохранился');
  assert.strictEqual(set.data.user.avatar, undefined, 'сам аватар не отдаётся в /api/me');
  ok('аватар загружен');

  console.log('\n— Проверка формата —');
  const notImage = await req('/api/me/profile', {
    method: 'PATCH',
    cookie,
    body: { avatar: 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=' },
  });
  assert.strictEqual(notImage.status, 400, 'html не принимаем — защита от XSS');
  assert.ok(/PNG|JPEG|WebP|GIF/.test(notImage.data.error));
  ok('не-картинка отклоняется');

  const garbage = await req('/api/me/profile', {
    method: 'PATCH',
    cookie,
    body: { avatar: 'data:image/png;base64,НЕБАЗА64' },
  });
  assert.strictEqual(garbage.status, 400);
  ok('битые данные отклоняются');

  const huge = await req('/api/me/profile', {
    method: 'PATCH',
    cookie,
    body: { avatar: 'data:image/png;base64,' + 'A'.repeat(700 * 1024) },
  });
  assert.strictEqual(huge.status, 400, 'слишком большой отклоняется');
  ok('аватар больше лимита отклоняется');

  const afterBad = await req('/api/me', { cookie });
  assert.strictEqual(afterBad.data.user.hasAvatar, true, 'старый аватар не испорчен');
  ok('неудачная загрузка не стирает прежний аватар');

  console.log('\n— Отдача картинкой —');
  const img = await fetch(`${BASE}/api/avatar/${id}`);
  assert.strictEqual(img.status, 200);
  assert.ok(/^image\//.test(img.headers.get('content-type')), 'отдаётся как картинка');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.ok(bytes.length > 8, 'файл не пустой');
  assert.strictEqual(bytes[0], 0x89, 'это действительно PNG');
  ok('картинка отдаётся отдельным запросом');

  const missing = await fetch(`${BASE}/api/avatar/999999`);
  assert.strictEqual(missing.status, 404);
  ok('нет аватара — 404');

  console.log('\n— В чужих данных —');
  const other = await req('/api/register', {
    method: 'POST',
    body: { username: 'bv_' + stamp, password: 'secret123', displayName: 'Сосед' },
  });
  const list = await req('/api/users', { cookie: other.res.headers.getSetCookie()[0].split(';')[0] });
  const row = list.data.users.find((u) => u.id === id);
  assert.ok(row, 'пользователь есть в списке');
  assert.strictEqual(row.hasAvatar, true, 'видно, что аватар есть');
  assert.strictEqual(row.avatar, undefined, 'сам файл в список не попадает');
  ok('в списках только флаг, без тяжёлых данных');

  const profile = await req(`/api/users/av_${stamp}`, {
    cookie: other.res.headers.getSetCookie()[0].split(';')[0],
  });
  assert.strictEqual(profile.data.user.hasAvatar, true);
  assert.strictEqual(profile.data.user.avatar, undefined);
  ok('в профиле тоже только флаг');

  console.log('\n— Удаление —');
  const cleared = await req('/api/me/profile', {
    method: 'PATCH',
    cookie,
    body: { avatar: null },
  });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(cleared.data.user.hasAvatar, false, 'аватар убран');
  const gone = await fetch(`${BASE}/api/avatar/${id}`);
  assert.strictEqual(gone.status, 404, 'файла больше нет');
  ok('аватар можно убрать');

  console.log(`\n✅ Все ${passed} проверок пройдены\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Тест упал:', err.message);
  process.exit(1);
});