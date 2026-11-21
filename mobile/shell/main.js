'use strict';
// Titik masuk Node di dalam aplikasi Android (Capacitor + @capawesome/capacitor-nodejs, Node 24).
// Disalin ke mobile/www/nodejs/ oleh scripts/mobile-sync.js bersama src/ dan renderer/. Nama event aplikasi berawalan "archne:".
const path = require('path');
const fs = require('fs');
const { app, channel } = require('bridge');

const base = path.join(app.datadir(), 'archne'); // sama dengan lokasi lama (getFilesDir()/archne): data pengguna lama terbawa
fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
const logFile = path.join(base, 'logs', 'app.log');
const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch {} console.log(m); };
const post = (ev, data) => { try { channel.post('archne:' + ev, data); } catch (x) { log('post ' + ev + ' gagal ' + x); } };
const fatal = (e) => { log('fatal ' + (e && e.stack || e)); post('fatal', String(e && e.message || e)); };
process.on('uncaughtException', (e) => log('uncaughtException ' + (e && e.stack)));
process.on('unhandledRejection', (e) => log('unhandledRejection ' + (e && e.stack || e)));

// Cadangan Halaman (ekspor / impor arsip .archpg). Android tak punya dialog berkas milik proses Node:
// - Ekspor: arsip ditulis ke folder privat (exports/), begitu selesai cangkang menyalinnya ke folder Download publik (kejadian 'saved', sama seperti berkas terima).
// - Impor: Node meminta cangkang membuka pemilih berkas sistem (archne:arcpick); jalur hasilnya (asli, atau salinan sementara) kembali lewat archne:arcpicked.
const exportDir = path.join(base, 'exports');
let exportFile = '', arcWait = null;
const pickSave = async (def) => {
  try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(exportDir, { recursive: true });
  exportFile = path.join(exportDir, path.basename(String(def || 'halaman-archne.archpg')));
  return exportFile;
};
const pickArc = () => new Promise((resolve) => {
  if (arcWait) { resolve(''); return; }
  const w = { resolve, tm: setTimeout(() => { if (arcWait === w) { arcWait = null; resolve(''); } }, 10 * 60 * 1000) };
  arcWait = w;
  post('arcpick', { job: 'arcimp' });
});
const onArcPicked = (p) => {
  const w = arcWait; if (!w) return; arcWait = null; clearTimeout(w.tm);
  const f = p && typeof p.path === 'string' ? p.path : '';
  w.resolve(path.isAbsolute(f) ? f : '');
};
const onPgArc = (ev, p) => { // ekspor selesai: salin ke Download. Gagal / batal: buang salinan privat.
  if (ev !== 'pgarc' || !p || p.kind !== 'export' || !exportFile) return;
  if (p.phase === 'done') { const f = exportFile; exportFile = ''; post('saved', { path: f, name: path.basename(f) }); }
  else if (p.phase === 'error' || p.phase === 'cancel') { try { fs.rmSync(exportFile, { force: true }); } catch {} exportFile = ''; }
};

(async () => {
  const { startHeadless } = require('./src/archne-headless');
  const rt = await startHeadless({
    dataDir: path.join(base, 'data'),
    downloadDir: path.join(base, 'downloads'),
    name: 'Android',
    host: '127.0.0.1',
    directShown: 'Download/file_transfer', // Kirim Langsung: berkas diterima di folder privat aplikasi lalu disalin ke sini (folder publik)
    canOpenFolder: false,
    canNotify: true,
    pickSave, pickArc, onEvent: onPgArc, // cadangan Halaman: tombol Ekspor / Impor di Halamanku
    canDirectCopy: true, // Kirim Langsung dari HP: berkas dikirim dari lokasi aslinya; yang path-nya tak terbaca disalin ke cache aplikasi (dxout) dan dihapus saat transfer berakhir
    log,
  });
  // Berkas yang selesai diterima: minta cangkang menyalinnya ke folder Download publik perangkat.
  rt.core.on('file', (e) => {
    if (e && e.phase === 'done' && typeof e.path === 'string') post('saved', { path: e.path, name: path.basename(e.path) });
  });
  // Kirim Langsung: tiap berkas yang lengkap disalin ke Download/file_transfer (struktur folder dipertahankan).
  rt.core.on('direct_file', (e) => {
    if (!e || typeof e.path !== 'string' || typeof e.rel !== 'string') return;
    const d = path.posix.dirname(e.rel.replace(/\\/g, '/'));
    post('saved', { path: e.path, name: path.basename(e.path), sub: 'file_transfer' + (d && d !== '.' ? '/' + d : '') });
  });
  const langNow = () => { try { return rt.core.getSettings().lang === 'id' ? 'id' : 'en'; } catch { return 'en'; } };
  log('siap di port ' + rt.rpc.port);
  // lang: bahasa aplikasi ('en'|'id') untuk teks native (notifikasi) dan halaman pembungkus
  const announce = () => post('ready', { port: rt.rpc.port, token: rt.rpc.token, dxout: rt.core._dxTmpRoot(), lang: langNow() });
  // Aplikasi bisa dibuka ulang saat inti Node masih hidup (layanan latar belakang): halaman baru menanyakan port dan token lagi.
  channel.on('archne:hello', announce);
  channel.on('archne:arcpicked', onArcPicked);
  announce();
})().catch(fatal);
