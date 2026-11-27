'use strict';
// Menyiapkan mobile/www/ untuk Capacitor (Fase 2C). Lintas OS. Aman dijalankan berulang.
//   node scripts/mobile-sync.js
// Hasil: mobile/www/index.html (pembungkus), mobile/www/capacitor.js, mobile/www/nodejs/{main.js,package.json,src/,renderer/,vendor/fs-ext-stub,node_modules/{ws,@php-wasm/*}}.
// PHP-WASM (0.34.0 P.2): hanya PHP 8.3, stub fs-ext nyata (bukan symlink), tanpa biner native: lihat scripts/mobile-php.js.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const phpPrep = require('./mobile-php');
const root = path.resolve(__dirname, '..');
const mob = path.join(root, 'mobile'), www = path.join(mob, 'www'), nd = path.join(www, 'nodejs'), shell = path.join(mob, 'shell');
const log = (m) => console.log('[mobile-sync] ' + m);
const die = (m) => { console.error('[mobile-sync] GAGAL: ' + m); process.exit(1); };

for (const f of ['index.html', 'main.js', 'package.json']) if (!fs.existsSync(path.join(shell, f))) die('mobile/shell/' + f + ' tidak ada');
// Sisa resource splash lama (Capacitor bawaan / nama lama drawable/splash.xml) bentrok "Duplicate resources" bila zip ditimpa tanpa menghapus file lama.
// Splash sekarang: drawable/launch_bg.xml + drawable-nodpi/splash_icon.png.
try {
  const res = path.join(mob, 'android', 'app', 'src', 'main', 'res');
  for (const d of fs.readdirSync(res)) {
    if (d.indexOf('drawable') !== 0) continue;
    for (const f of ['splash.png', 'splash.xml']) {
      const fp = path.join(res, d, f);
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); log('sisa lama dihapus: ' + d + '/' + f); }
    }
  }
} catch (e) { /* res belum ada (sebelum cap add android): abaikan */ }
fs.mkdirSync(nd, { recursive: true });

// 1. Kode inti: salinan bersih (hapus dulu agar berkas yang sudah dihapus di sumber ikut hilang)
for (const d of ['src', 'renderer']) {
  fs.rmSync(path.join(nd, d), { recursive: true, force: true });
  fs.cpSync(path.join(root, d), path.join(nd, d), { recursive: true });
}
log('src/ dan renderer/ disalin');

// 2. Titik masuk Node + dependensi produksi (ws, @php-wasm). Stub fs-ext HARUS ada sebelum npm install ("file:vendor/fs-ext-stub").
phpPrep.stageStub(root, nd);
const pkgNew = fs.readFileSync(path.join(shell, 'package.json'), 'utf8'), pkgDst = path.join(nd, 'package.json');
const pkgChanged = !fs.existsSync(pkgDst) || fs.readFileSync(pkgDst, 'utf8') !== pkgNew;
fs.copyFileSync(path.join(shell, 'main.js'), path.join(nd, 'main.js'));
fs.writeFileSync(pkgDst, pkgNew);
const phpDir = path.join(nd, 'node_modules', '@php-wasm');
if (pkgChanged || !fs.existsSync(path.join(nd, 'node_modules', 'ws')) || !fs.existsSync(path.join(phpDir, 'node'))) {
  log('npm install --omit=dev di www/nodejs (PHP-WASM ±460 MB diunduh lalu dipangkas ke PHP 8.3) ...');
  const r = cp.spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: nd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die('npm install di www/nodejs');
} else log('ws dan @php-wasm sudah ada');
// Dijalankan SETIAP kali (aman diulang): pangkas, stub nyata, pemeriksaan. Gagal = hentikan: APK tanpa ini membuat PHP gagal boot di HP.
const pr = phpPrep.finishPhp(root, nd, log);
if (pr.problems.length) die('PHP-WASM tidak siap untuk APK:\n  - ' + pr.problems.join('\n  - '));

// 3. Halaman pembungkus + capacitor.js (cadangan bila tidak disuntik otomatis oleh jembatan native)
fs.copyFileSync(path.join(shell, 'index.html'), path.join(www, 'index.html'));
const capJs = path.join(mob, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
if (fs.existsSync(capJs)) fs.copyFileSync(capJs, path.join(www, 'capacitor.js')); else log('PERINGATAN: capacitor.js tidak ditemukan (jalankan npm ci di mobile/ dulu)');
log('selesai: ' + path.relative(root, www));
