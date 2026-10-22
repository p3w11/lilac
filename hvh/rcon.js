'use strict';
/* =========================================================
   Клиент Source RCON (протокол Valve).

   Пакет: int32 length | int32 id | int32 type | body
     type 3 — авторизация (клиент -> сервер)
     type 2 — ответ на авторизацию (id = -1 означает неверный пароль)
              и ответ на команду
     type 0 — данные ответа на команду

   Особенность: на команду сервер отвечает ДВУМЯ пакетами — с данными
   и пустым («конец ответа»). Поэтому读完 первый пакет нельзя закрывать
   соединение: ждём пустой пакет или таймаут.
   ========================================================= */
const net = require('node:net');

const PKT_RESPONSE = 0;
const PKT_AUTH_RESPONSE = 2;
const PKT_AUTH = 3;
const PKT_EXEC = 2;

function packet(id, type, body) {
  const buf = Buffer.from(body + '\0\0', 'utf8');
  const head = Buffer.alloc(12);
  head.writeInt32LE(buf.length + 4, 0);   // длина тела + id
  head.writeInt32LE(id, 4);
  head.writeInt32LE(type, 8);
  return Buffer.concat([head, buf]);
}

/**
 * Выполнить команду на сервере.
 * @param {{host:string, port:number, password:string}} cfg
 * @param {string} cmd
 * @param {number} timeout мс
 */
function exec(cfg, cmd, timeout = 8000) {
  return new Promise(resolve => {
    if (!cfg || !cfg.host || !cfg.port) {
      return resolve({ ok: false, output: '', error: 'RCON не настроен' });
    }

    const pass = cfg.password || '';
    const sock = net.createConnection({ host: cfg.host, port: cfg.port });
    let buf = Buffer.alloc(0);
    let authed = false;
    let done = false;
    let out = '';
    let cmdId = 2;

    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(r);
    };

    const timer = setTimeout(() => {
      // если данные успели прийти — считаем успехом
      if (out.trim()) finish({ ok: true, output: out.trim() });
      else if (authed) {
        // пароль принят, но сервер не выполнил команду.
        // В CS:GO это почти всегда из-за выключенного sv_cheats 1.
        finish({ ok: false, output: '',
                 error: 'пароль принят, но сервер не выполняет команды. В CS:GO нужен sv_cheats 1 в server.cfg' });
      } else {
        finish({ ok: false, output: '', error: 'таймаут RCON (сервер не ответил на авторизацию)' });
      }
    }, timeout);

    sock.on('error', e => finish({ ok: false, output: out, error: 'RCON: ' + e.message }));

    sock.on('connect', () => {
      sock.write(packet(1, PKT_AUTH, pass));
    });

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const size = buf.readInt32LE(0);
        if (size < 4 || buf.length < 4 + size) return;

        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + size).toString('utf8').replace(/\0+$/, '');
        buf = buf.subarray(4 + size);

        if (type === PKT_AUTH_RESPONSE && !authed) {
          // ответ на авторизацию
          if (id === -1) {
            return finish({ ok: false, output: '', error: 'неверный RCON-пароль' });
          }
          authed = true;
          cmdId = 2;
          sock.write(packet(cmdId, PKT_EXEC, cmd));
          continue;
        }

        if (type === PKT_RESPONSE) {
          if (body.length) {
            out += (out ? '\n' : '') + body;
            continue;                       // ждём пустой пакет-«конец»
          }
          // пустой пакет = конец ответа
          return finish({ ok: true, output: out.trim() || '(пусто)' });
        }
      }
    });
  });
}

/** Проверка связи и прав. */
async function check(cfg) {
  const r = await exec(cfg, 'echo rcon_ok', 6000);
  return r;
}

module.exports = { exec, check };
