'use strict';
// Titik masuk Node di dalam aplikasi Android (nodejs-mobile). Folder src/ dan renderer/ disalin ke sebelah berkas ini oleh scripts/android-build.ps1.
const path = require('path');
const fs = require('fs');
const cordova = require('cordova-bridge');

const base = path.join(cordova.app.datadir(), 'archne');
fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
const logFile = path.join(base, 'logs', 'app.log');
const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch {} console.log(m); };
const fatal = (e) => { log('fatal ' + (e && e.stack || e)); try { cordova.channel.post('fatal', String(e && e.message || e)); } catch {} };
process.on('uncaughtException', (e) => log('uncaughtException ' + (e && e.stack)));
process.on('unhandledRejection', (e) => log('unhandledRejection ' + (e && e.stack || e)));

(async () => {
  const { startHeadless } = require('./src/headless');
  const app = await startHeadless({
    dataDir: path.join(base, 'data'),
    downloadDir: path.join(base, 'downloads'),
    name: 'Android',
    host: '127.0.0.1',
    directShown: 'Download/file_transfer', // Kirim Langsung: berkas diterima di folder privat aplikasi lalu disalin ke sini (folder publik)
    canOpenFolder: false,
    canNotify: true,
    canDirectCopy: true, // Kirim Langsung dari HP: berkas dikirim dari lokasi aslinya (izin akses semua berkas); yang path-nya tak terbaca disalin ke cache aplikasi (dxout) dan dihapus saat transfer berakhir
    log,
  });
  // Berkas yang selesai diterima: minta cangkang menyalinnya ke folder Download publik perangkat.
  app.core.on('file', (e) => {
    if (e && e.phase === 'done' && typeof e.path === 'string') {
      try { cordova.channel.post('saved', { path: e.path, name: path.basename(e.path) }); } catch (x) { log('saved gagal ' + x); }
    }
  });
  // Kirim Langsung: tiap berkas yang lengkap disalin ke Download/file_transfer (struktur folder dipertahankan).
  app.core.on('direct_file', (e) => {
    if (!e || typeof e.path !== 'string' || typeof e.rel !== 'string') return;
    try {
      const d = path.posix.dirname(e.rel.replace(/\\/g, '/'));
      cordova.channel.post('saved', { path: e.path, name: path.basename(e.path), sub: 'file_transfer' + (d && d !== '.' ? '/' + d : '') });
    } catch (x) { log('saved (direct) gagal ' + x); }
  });
  const langNow = () => { try { return app.core.getSettings().lang === 'id' ? 'id' : 'en'; } catch { return 'en'; } };
  log('siap di port ' + app.rpc.port);
  const announce = () => cordova.channel.post('ready', { port: app.rpc.port, token: app.rpc.token, dxout: app.core._dxTmpRoot(), lang: langNow() }); // lang: bahasa aplikasi ('en'|'id') untuk teks native (notifikasi) dan halaman pembungkus
  // Aplikasi bisa dibuka ulang saat inti Node masih hidup (layanan latar belakang): halaman baru menanyakan port dan token lagi.
  cordova.channel.on('hello', announce);
  announce();
})().catch(fatal);
