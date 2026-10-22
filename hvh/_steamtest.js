const U = require('./users');
const D = require('./db');
(async () => {
  await U.steamRemember({
    steam_id: '76561199648247559',
    steam64: '76561199648247559',
    persona: 'you',
    avatar: 'https://avatars.fastly.steamstatic.com/baf71e1e1ffcb3eea6e1e6fbebf8aee72de9cb19_full.jpg',
    background: 'https://shared.fastly.steamstatic.com/community_assets/images/items/730/955e56085e78606ce8b56d7d912e2cd738af4215.png',
    login: 'p3w1', user_id: 12, ip: '127.0.0.1'
  });
  console.log('local:', JSON.stringify(D.q.get('SELECT * FROM flux_steam WHERE steam_id = ?', '76561199648247559')));
  const mysql = require('mysql2/promise');
  const p = await mysql.createPool({ host: '185.9.145.160', port: 3306, user: 'gs143084', password: 'MI1fcExYi', database: 'gs143084', connectionLimit: 1 });
  const [rows] = await p.query('SELECT steam_id, steam64, persona, login, user_id, last_ip FROM flux_steam');
  console.log('mysql:', JSON.stringify(rows));
  const [fu] = await p.query("SELECT login, avatar FROM flux_users WHERE id = 3");
  console.log('flux_users:', JSON.stringify(fu));
  await p.end();
})();
