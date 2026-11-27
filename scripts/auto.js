'use strict';
// Setup otomatis lintas OS (Windows / Linux / macOS / Termux).
//   node scripts/auto.js            -> setup + cetak cara menjalankan
//   node scripts/auto.js setup      -> hanya cek Node + pasang dependensi
//   node scripts/auto.js serve      -> setup + jalankan mode peramban (server.js)
// Build installer .exe dan APK memakai PowerShell (Windows): lihat auto.bat.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const win = process.platform === 'win32';
const cmd = process.argv[2] || 'all';
const log = (m) => console.log('[archne] ' + m);

function run(c, args, opts) {
  return cp.spawnSync(c, args, Object.assign({ cwd: root, stdio: 'inherit', shell: win }, opts || {}));
}

const major = Number(process.versions.node.split('.')[0]);
log('node v' + process.versions.node + ' (' + process.platform + '/' + process.arch + ')');
if (major < 22) {
  log('PERINGATAN: package.json meminta Node >= 22 untuk mesin build. Tes/server tetap bisa jalan, tapi disarankan pasang Node 22+ (https://nodejs.org).');
}
if (major < 18) { log('GAGAL: Node terlalu lama (minimal 18).'); process.exit(1); }

// 1. dependensi
const hasDeps = fs.existsSync(path.join(root, 'node_modules', 'ws'));
const needElectron = win || process.env.ARCHNE_WITH_ELECTRON === '1';
if (!hasDeps) {
  log('Memasang dependensi...');
  const r = run('npm', ['install', '--no-audit', '--no-fund']);
  if (r.status !== 0) { log('GAGAL: npm install (exit ' + r.status + ').'); process.exit(r.status || 1); }
} else { log('Dependensi sudah ada.'); }
// Electron 42+: npm install tidak mengunduh binary lagi. Unduh sekarang (hanya bila perlu desktop) supaya kegagalan jaringan/antivirus terlihat di sini, bukan saat npm start.
if (needElectron && !fs.existsSync(path.join(root, 'node_modules', 'electron', 'dist'))) {
  log('Mengunduh binary Electron...');
  const r = run('npx', ['install-electron', '--no']);
  if (r.status !== 0) { log('GAGAL: unduh Electron (exit ' + r.status + '). Cek koneksi/antivirus lalu ulangi.'); process.exit(r.status || 1); }
}

if (cmd === 'setup') { log('Setup selesai.'); process.exit(0); }

if (cmd === 'serve') { log('Menjalankan mode peramban...'); run('node', ['server.js']); process.exit(0); }

log('Selesai. Jalankan: ' + (win ? 'run.bat (desktop) atau serve.bat (peramban)' : 'npm run serve'));
if (win) log('Bangun installer + APK sekaligus: auto.bat');
