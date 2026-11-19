'use strict';
// Mode tanpa Electron: jalankan inti + UI lewat peramban. Cocok untuk Linux/macOS/Termux (HP) atau uji cepat di PC.
//   node server.js [--data DIR] [--name NAMA] [--port N]
// Lalu buka tautan yang dicetak (berisi token, hanya berlaku di perangkat ini).
const os = require('os');
const path = require('path');
const fs = require('fs');
const { startHeadless } = require('./src/archne-headless');

const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
let user = 'Anon'; try { user = os.userInfo().username || user; } catch {}
const dataDir = path.resolve(arg('data') || path.join(os.homedir(), '.archne'));
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
const logFile = path.join(dataDir, 'logs', 'app.log');
const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch {} console.log(m); };
process.on('uncaughtException', (e) => log('uncaughtException ' + (e && e.stack)));
process.on('unhandledRejection', (e) => log('unhandledRejection ' + (e && e.stack || e)));

startHeadless({ dataDir: path.join(dataDir, 'data'), name: arg('name') || user, port: Number(arg('port')) || 0, log }).then((app) => {
  console.log('\nArchne berjalan. Buka di peramban perangkat ini:\n\n  ' + app.rpc.url() + '\n');
  const quit = async () => { try { await app.stop(); } catch {} process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
}).catch((e) => { log('gagal mulai ' + (e && e.stack)); process.exit(1); });
