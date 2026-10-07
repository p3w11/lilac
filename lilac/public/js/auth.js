'use strict';

/* Страница входа / регистрации */

const $ = (id) => document.getElementById(id);

let mode = 'login';
let needsInvite = false;

async function api(url, options) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
  return data;
}

// Уже вошли — сразу в чат
api('/api/me')
  .then((d) => {
    if (d.user) location.replace('/chat');
  })
  .catch(() => {});

// Если на сервере задан код приглашения — показываем поле
api('/api/config')
  .then((d) => {
    needsInvite = Boolean(d.inviteRequired);
    if (mode === 'reg') setMode('reg');
  })
  .catch(() => {});

function setMode(next) {
  mode = next;
  const isReg = next === 'reg';
  $('tabLogin').classList.toggle('active', !isReg);
  $('tabReg').classList.toggle('active', isReg);
  $('title').textContent = isReg ? 'Создай аккаунт' : 'С возвращением';
  $('subtitle').textContent = isReg
    ? 'Пара полей — и можно писать друзьям'
    : 'Войди, чтобы написать друзьям';
  $('submitBtn').textContent = isReg ? 'Зарегистрироваться' : 'Войти';
  $('nameBlock').hidden = !isReg;
  $('inviteBlock').hidden = !isReg || !needsInvite;
  $('password').autocomplete = isReg ? 'new-password' : 'current-password';
  $('error').textContent = '';
}

$('tabLogin').addEventListener('click', () => setMode('login'));
$('tabReg').addEventListener('click', () => setMode('reg'));

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submitBtn');
  const errorBox = $('error');
  errorBox.textContent = '';
  btn.disabled = true;
  try {
    const payload = {
      username: $('username').value.trim(),
      password: $('password').value,
      displayName: $('displayName').value.trim(),
      inviteCode: $('inviteCode').value.trim(),
    };
    await api(mode === 'reg' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    location.replace('/chat');
  } catch (err) {
    errorBox.textContent = err.message;
    btn.disabled = false;
  }
});
