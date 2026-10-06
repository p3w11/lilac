'use strict';

/*
 * Тесты голосовых звонков.
 * Проверяется сигналинг (пересылка offer/answer/ice/hangup через WebSocket)
 * и запреты: только личные переписки, нельзя позвонить себе, чужой чат.
 * Сам звук проверить нельзя — для этого нужен настоящий микрофон.
 */

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

async function openDm(a, b) {
  const wsA = await connect(a.cookie);
  wsA.send(JSON.stringify({ t: 'open', username: b.data.user.username }));
  const room = await until(wsA, 'room');
  wsA.close();
  return room.room;
}

async function main() {
  const alice = await register('ca_' + stamp, 'Алиса');
  const bob = await register('cb_' + stamp, 'Борис');
  const eve = await register('ce_' + stamp, 'Ева');

  const room = await openDm(alice, bob);
  assert.ok(room && room.startsWith('dm:'), 'личная переписка создана');

  console.log('\n— Сигналинг —');
  const wsA = await connect(alice.cookie);
  const wsB = await connect(bob.cookie);

  wsA.send(JSON.stringify({ t: 'call', action: 'offer', room, payload: { type: 'offer', sdp: 'FAKE-SDP-1' } }));
  const offer = await until(wsB, 'call', (m) => m.action === 'offer');
  assert.ok(offer, 'оффер доставлен');
  assert.strictEqual(offer.room, room);
  assert.strictEqual(offer.from.username, alice.data.user.username, 'отправитель известен');
  assert.strictEqual(offer.payload.sdp, 'FAKE-SDP-1', 'SDP не потерялся');
  ok('offer доставлен собеседнику');

  wsB.send(JSON.stringify({ t: 'call', action: 'answer', room, payload: { type: 'answer', sdp: 'FAKE-SDP-2' } }));
  const answer = await until(wsA, 'call', (m) => m.action === 'answer');
  assert.ok(answer && answer.payload.sdp === 'FAKE-SDP-2');
  ok('answer доставлен обратно');

  wsA.send(JSON.stringify({ t: 'call', action: 'ice', room, payload: { candidate: 'ice-1', sdpMid: '0' } }));
  const ice = await until(wsB, 'call', (m) => m.action === 'ice');
  assert.ok(ice && ice.payload.candidate === 'ice-1', 'ICE-кандидат переслан');
  ok('ICE-кандидаты пересылаются');

  wsB.send(JSON.stringify({ t: 'call', action: 'hangup', room }));
  const hangup = await until(wsA, 'call', (m) => m.action === 'hangup');
  assert.ok(hangup, 'сброс звонка доставлен');
  ok('завершение звонка доходит до собеседника');

  wsB.send(JSON.stringify({ t: 'call', action: 'decline', room }));
  const decline = await until(wsA, 'call', (m) => m.action === 'decline');
  assert.ok(decline, 'отклонение доставлено');
  ok('отклонение звонка доходит');

  console.log('\n— Запреты —');
  const wsE = await connect(eve.cookie);

  wsE.send(JSON.stringify({ t: 'call', action: 'offer', room, payload: { type: 'offer', sdp: 'X' } }));
  const notInDm = await until(wsE, 'error');
  assert.ok(notInDm && /не ваш чат/.test(notInDm.error));
  ok('чужой не может слать сигналы в чужую переписку');

  const mine = await openDm(alice, alice);
  assert.ok(mine, 'переписка с собой создаётся как dm');
  wsA.send(JSON.stringify({ t: 'call', action: 'offer', room: mine, payload: { sdp: 'X' } }));
  const selfCall = await until(wsA, 'error');
  assert.ok(selfCall && /самому себе/.test(selfCall.error));
  ok('нельзя позвонить самому себе');

  const group = await req('/api/rooms', {
    method: 'POST',
    cookie: alice.cookie,
    body: { kind: 'group', name: 'Звонки нельзя', memberIds: [bob.data.user.id] },
  });
  assert.strictEqual(group.status, 200);
  wsA.send(JSON.stringify({ t: 'call', action: 'offer', room: group.data.room.room, payload: { sdp: 'X' } }));
  const inGroup = await until(wsA, 'error');
  assert.ok(inGroup && /только в личных/.test(inGroup.error), 'в группе звонить нельзя');
  ok('в группах и каналах звонить нельзя');

  wsA.send(JSON.stringify({ t: 'call', action: 'что-то', room }));
  const badAction = await until(wsA, 'error');
  assert.ok(badAction && /Неизвестное действие/.test(badAction.error));
  ok('неизвестные команды звонка отклоняются');

  wsA.send(JSON.stringify({ t: 'call', action: 'offer', room, payload: { sdp: 'A'.repeat(120000) } }));
  const tooBig = await until(wsA, 'error');
  assert.ok(tooBig && /Слишком большой/.test(tooBig.error), 'огромный пакет отбит');
  ok('слишком большой пакет не проходит');

  console.log('\n— Приватность собеседника —');
  await req('/api/me/settings', {
    method: 'PUT',
    cookie: bob.cookie,
    body: { directMessages: 'nobody' },
  });
  wsA.send(JSON.stringify({ t: 'call', action: 'offer', room, payload: { sdp: 'X' } }));
  const blocked = await until(wsA, 'error');
  assert.ok(blocked && /недоступен/.test(blocked.error), 'позвонить запретившему нельзя');
  ok('тому, кто запретил личные сообщения, нельзя позвонить');

  wsA.close();
  wsB.close();
  wsE.close();

  console.log(`\n✅ Все ${passed} проверок пройдены\n`);
  console.log('Звук и микрофон эти тесты не проверяют — для этого нужен браузер с устройством.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Тест упал:', err.message, err.stack ? '\n' + err.stack.split('\n')[1] : '');
  process.exit(1);
});
