'use strict';

/* Сквозной тест: регистрация, вход, WebSocket-чат, личные переписки, доступ. */

const assert = require('assert');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://localhost:3000';
const WS = BASE.replace(/^http/, 'ws') + '/ws';

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ✓ ' + name);
}

async function post(path, body, cookie) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : null;
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

async function get(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

/** Подключается по WS и ждёт событий. */
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
    ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждём сообщения нужного типа (максимум 2 секунды). */
async function until(ws, type, predicate = () => true, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = ws.inbox.find((m) => m.t === type && predicate(m));
    if (found) {
      ws.inbox = ws.inbox.filter((m) => m !== found);
      return found;
    }
    await wait(25);
  }
  throw new Error(`Не дождался события "${type}"`);
}

async function main() {
  // уникальные имена, чтобы тест можно было гонять повторно
  const stamp = Date.now().toString(36);
  const alice = { username: `alice_${stamp}`, password: 'secret123', displayName: 'Алиса' };
  const bob = { username: `bob_${stamp}`, password: 'secret123', displayName: 'Борис' };

  console.log('\n— Регистрация —');
  const a = await post('/api/register', alice);
  assert.strictEqual(a.status, 200, 'регистрация Алисы: ' + JSON.stringify(a.data));
  assert.ok(a.cookie, 'cookie выдан');
  assert.strictEqual(a.data.user.displayName, 'Алиса');
  assert.strictEqual(a.data.user.passwordHash, undefined, 'хеш пароля не отдаётся клиенту');
  ok('Алиса зарегистрировалась и получила cookie');

  const b = await post('/api/register', bob);
  assert.strictEqual(b.status, 200);
  ok('Борис зарегистрировался');

  const dup = await post('/api/register', alice);
  assert.strictEqual(dup.status, 409);
  ok('повторный логин занят (409)');

  const weak = await post('/api/register', { username: 'x', password: '123' });
  assert.strictEqual(weak.status, 400, 'короткий логин/пароль отклонены');
  ok('валидация логина и пароля');

  console.log('\n— Вход —');
  const badPass = await post('/api/login', { username: alice.username, password: 'wrong' });
  assert.strictEqual(badPass.status, 401);
  ok('неверный пароль отклонён (401)');

  const noUser = await post('/api/login', { username: 'nobody_here', password: 'whatever' });
  assert.strictEqual(noUser.status, 401);
  ok('несуществующий логин тоже 401, без утечки информации');

  const login = await post('/api/login', { username: alice.username, password: alice.password });
  assert.strictEqual(login.status, 200);
  ok('вход по паролю работает');

  const anon = await get('/api/messages?room=general');
  assert.strictEqual(anon.status, 401);
  ok('без входа сообщения не отдаются (401)');

  console.log('\n— Чат в реальном времени —');
  const wsA = await connect(a.cookie);
  const wsB = await connect(b.cookie);
  const hello = await until(wsA, 'hello');
  assert.strictEqual(hello.user.username, alice.username);
  ok('WebSocket: авторизация по cookie, приветствие');

  // список онлайна теперь свой у каждого — берём из приветствия второго,
  // там уже видны оба собеседника
  const helloB = await until(wsB, 'hello');
  assert.ok(
    helloB.online.some((u) => u.username === alice.username),
    'в списке онлайн есть второй человек'
  );
  ok('список онлайн приходит');

  wsA.send(JSON.stringify({ t: 'send', room: 'general', text: 'Привет, Боря!' }));
  const got = await until(wsB, 'message');
  assert.strictEqual(got.msg.text, 'Привет, Боря!');
  assert.strictEqual(got.msg.displayName, 'Алиса');
  ok('сообщение в общий чат доставлено в реальном времени');

  wsA.send(JSON.stringify({ t: 'typing', room: 'general' }));
  const typing = await until(wsB, 'typing');
  assert.strictEqual(typing.from.username, alice.username);
  ok('индикатор «печатает...»');

  console.log('\n— Личные переписки —');
  wsA.send(JSON.stringify({ t: 'open', username: bob.username }));
  const room = await until(wsA, 'room');
  assert.strictEqual(room.peer.username, bob.username);
  assert.ok(room.room.startsWith('dm:'));
  ok('личная переписка открывается по логину');

  wsB.send(JSON.stringify({ t: 'send', room: room.room, text: 'Привет, Алис!' }));
  const dmGot = await until(wsA, 'message', (m) => m.msg.room === room.room);
  assert.strictEqual(dmGot.msg.text, 'Привет, Алис!');
  ok('сообщение в личку доставлено');

  const dmList = await get('/api/rooms', a.cookie);
  assert.ok(dmList.data.dms.length >= 1, 'переписка появилась в списке');
  ok('переписка сохранилась и видна в списке');

  console.log('\n— Безопасность —');
  const eve = { username: `eve_${stamp}`, password: 'secret123' };
  const e = await post('/api/register', eve);
  assert.strictEqual(e.status, 200);

  const peek = await get(`/api/messages?room=${room.room}`, e.cookie);
  assert.strictEqual(peek.status, 403, 'чужую переписку читать нельзя');
  ok('чужая переписка недоступна (403)');

  const wsE = await connect(e.cookie);
  wsE.send(JSON.stringify({ t: 'send', room: room.room, text: 'подслушиваю' }));
  await wait(200);
  assert.ok(!wsA.inbox.some((m) => m.msg && m.msg.text === 'подслушиваю'), 'чужое сообщение не ушло');
  ok('нельзя писать в чужую переписку');

  // Чужая переписка не показывается и в общем чате
  const noLeak = await get('/api/rooms', e.cookie);
  assert.ok(!noLeak.data.dms.some((m) => m.room === room.room), 'в списке чужих переписок нет');
  ok('переписки не утекают в список');

  const noAuthWs = await connect('lilac_token=подделка').then(
    () => null,
    () => 'rejected'
  );
  assert.strictEqual(noAuthWs, 'rejected', 'WS с чужим токеном не подключается');
  ok('WebSocket отклоняет поддельную сессию');

  const xss = '<script>alert(1)</' + 'script>';
  wsE.send(JSON.stringify({ t: 'send', room: 'general', text: xss }));
  const xssGot = await until(wsA, 'message', (m) => m.msg.text === xss);
  assert.strictEqual(xssGot.msg.text, xss);
  ok('HTML хранится как текст (на клиенте вставляется через textContent)');

  console.log('\n— История и выход —');
  const history = await get('/api/messages?room=general&limit=10', a.cookie);
  assert.ok(history.data.items.length >= 2);
  ok('история сообщений сохраняется');

  const out = await post('/api/logout', {}, a.cookie);
  assert.strictEqual(out.status, 200);
  ok('выход работает');

  wsA.close();
  wsB.close();
  wsE.close();

  console.log(`\n✅ Все ${passed} проверок пройдены\n`);
}

main().catch((err) => {
  console.error('\n❌ Тест упал:', err.message);
  process.exit(1);
});
