'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Notification, protocol, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Core } = require('./src/archne-core');
const { register } = require('./src/archne-ipc');
const { allowPermission } = require('./src/archne-permissions');
const { createScreenPicker } = require('./src/archne-screenpick');
const { createWsProxy } = require('./src/archne-wsproxy');
const { createPathGuard } = require('./src/archne-pathguard');
const { createWebBrowser } = require('./src/archne-webbrowser');
const { createSiteBrowser } = require('./src/archne-sitebrowser');
const { createPhpHost } = require('./src/archne-phphost');
const { createMysqlHost } = require('./src/archne-mysql');
const { createCronService } = require('./src/archne-webcronhost');
const I18N = require('./src/core/archne-i18n-node'); // i18n (E10): judul dialog native dan notifikasi memakai bahasa pengaturan, dibaca SAAT dipakai
const rendererDir = path.join(__dirname, 'renderer');

// WebSocket MQTT macet di beberapa jaringan/antivirus karena ClientHello TLS Chromium yang besar (pertukaran kunci pasca-kuantum Kyber).
// Dimatikan supaya handshake sama dengan TLS biasa. Jalur cadangan lewat Node (src/archne-wsproxy.js) tetap ada bila Chromium masih gagal.
app.commandLine.appendSwitch('disable-features', 'PostQuantumKyber,PostQuantumMlkem,EncryptedClientHello');

const logDir = path.join(app.getPath('userData'), 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'app.log');
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
  console.log(m);
};
process.on('uncaughtException', (e) => log('uncaughtException ' + (e && e.stack)));
process.on('unhandledRejection', (e) => log('unhandledRejection ' + (e && e.stack || e)));

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win, core, ipc, screen, site, phpHost = null, cron = null;

// Folder terima Kirim Langsung bawaan di Windows: <drive sistem>\file_transfer (mis. C:\file_transfer). Gagal dibuat/ditulisi -> null (Core memakai <unduhan>/file_transfer).
function directDefaultDir() {
  if (process.platform !== 'win32') return null;
  const d = path.join((process.env.SystemDrive || 'C:') + path.sep, 'file_transfer');
  try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { log('folder terima ' + d + ' tidak bisa dipakai: ' + e.message); return null; }
}

// Pemutar media (v0.25.0 Step 2b): archne-media://m/<token acak>. Token dibuat Core.mediaStream untuk satu berkas yang sudah lolos pemeriksaan;
// penyaji (src/archne-mediaserve.js) hanya membaca lewat core.mediaSrcRead, tidak pernah menerima jalur berkas.
// archne-site://<siteId>/ = penampil situs Web Lokal (src/archne-sitebrowser.js, 0.34.0 Fase F). registerSchemesAsPrivileged hanya boleh dipanggil SEKALI, jadi kedua skema didaftarkan bersama.
protocol.registerSchemesAsPrivileged([
  { scheme: 'archne-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'archne-site', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Penghentian bersih (dipakai penutupan jendela, tombol Keluar, dan Reset data). Idempoten: panggilan kedua menunggu yang pertama.
// app.quit() tidak memicu 'window-all-closed', jadi pembersihan tidak boleh hanya bergantung pada peristiwa itu.
let shuttingDown = null;
function shutdown() {
  if (!shuttingDown) shuttingDown = (async () => { try { if (site) site.dispose(); if (cron) cron.stop(); if (phpHost) phpHost.closeAll(); if (ipc) ipc.dispose(); await core.stop(); } catch {} })();
  return shuttingDown;
}

// Reset data (Pengaturan > Aplikasi): penanda ditulis dulu, aplikasi dimulai ulang, dan data baru dihapus SAAT BOOT sebelum Core dibuat,
// jadi tidak ada berkas yang masih terkunci atau ditulis Core. Penanda yang gagal dihapus dicoba lagi pada peluncuran berikutnya.
const dataDirPath = () => path.join(app.getPath('userData'), 'data');
const resetMarker = () => path.join(app.getPath('userData'), 'reset.pending');
async function applyPendingReset() {
  const m = resetMarker();
  if (!fs.existsSync(m)) return;
  try {
    fs.rmSync(dataDirPath(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(m, { force: true });
    try { await session.defaultSession.clearStorageData({ storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers'] }); } catch (e) { log('reset: penyimpanan peramban tidak bisa dibersihkan: ' + e.message); }
    log('reset data selesai: mulai sebagai akun baru');
  } catch (e) { log('reset data gagal (dicoba lagi saat peluncuran berikutnya): ' + e.message); }
}
// Mulai ulang. Versi portabel electron-builder dijalankan dari folder sementara: peluncuran ulang harus memakai berkas .exe aslinya.
function relaunch() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portable ? { execPath: portable } : undefined);
  app.exit(0);
}
function appQuit() {
  setTimeout(() => { shutdown().then(() => app.exit(0)); }, 150); // jawaban IPC sampai ke UI dulu
  return { ok: true };
}
function appReset() {
  try { fs.writeFileSync(resetMarker(), String(Date.now())); } catch (e) { log('reset: penanda tidak bisa ditulis: ' + e.message); return { ok: false, code: 'io' }; }
  setTimeout(() => { shutdown().then(relaunch); }, 150);
  return { ok: true };
}

async function boot() {
  await applyPendingReset(); // sebelum Core dibuat
  protocol.handle('archne-media', (req) => {
    try { const u = new URL(req.url); if (u.hostname === 'm' && core) return require('./src/archne-mediaserve').serveWeb(core, u.pathname.slice(1), req); } catch {}
    return new Response(null, { status: 404 });
  });
  core = new Core({
    dataDir: dataDirPath(),
    directDir: directDefaultDir() || undefined,
    name: (() => { try { return require('os').userInfo().username; } catch { return ''; } })() || 'Anon',
    log,
  });
  // Mesin PHP (Fase P): pool Worker dibuat malas, jadi situs statis tidak membayar apa pun. Gagal dibuat = tanpa PHP (situs PHP menampilkan galat, bukan berkas .php sebagai teks; caps 'lw2' tidak diumumkan).
  // Dipasang SEBELUM core.start(): peer mencatat caps dari hello, jadi penyaji lw_req harus sudah ada saat peer pertama terhubung (temuan P.5b).
  try { phpHost = createPhpHost({ core, log, mysql: createMysqlHost({ log }) }); core.setPhpServe((siteId) => phpHost.serve(siteId)); } catch (e) { phpHost = null; log('mesin PHP tidak tersedia: ' + e.message); }
  await core.start();
  // Cronjob (C6): layanan milik pemilik; penjadwal baru hidup setelah ada job. Tanpa mesin PHP, cron gagal dengan code 'site' (bukan galat fatal).
  try { cron = createCronService({ core, getPhpHost: () => phpHost, log }); cron.start(); } catch (e) { cron = null; log('cron tidak tersedia: ' + e.message); }
  const push = () => { if (win && !win.isDestroyed()) win.webContents.send('update'); };
  core.on('update', push);
  core.on('removed', (r) => { if (win && !win.isDestroyed()) win.webContents.send('removed', r); });
  core.on('reaction', () => { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); });
  core.on('message', (m) => { if (m.from !== core.id && win && !win.isFocused()) win.flashFrame(true); });
  // Panggilan masuk saat jendela tidak di depan: kedipkan, tampilkan notifikasi sistem. Ketuk = bawa jendela ke depan.
  core.on('call', (ev) => {
    if (ev.ev !== 'incoming' || ev.auto || !win || win.isDestroyed() || win.isFocused()) return;
    win.flashFrame(true);
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: ev.video ? I18N.tr('e.native.callVideo', null, 'Panggilan video masuk') : I18N.tr('e.native.callVoice', null, 'Panggilan suara masuk'), body: String(ev.name || I18N.tr('e.native.someone', null, 'Seseorang')), urgency: 'critical', timeoutType: 'never' });
      n.on('click', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
      const close = (e) => { if (e.cid === ev.cid && e.ev === 'end') { try { n.close(); } catch {} core.removeListener('call', close); } };
      core.on('call', close); n.show();
    } catch (e) { log('notifikasi panggilan gagal: ' + e.message); }
  });

  const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
  let wsProxy = null;
  try { wsProxy = createWsProxy({ WebSocket: require('ws'), send: (ev) => send('wsev', ev), log }); } catch (e) { log('wsproxy tidak tersedia: ' + e.message); }
  // Peramban dalam aplikasi (v0.25.1): tautan web di chat dibuka di WebContentsView dengan bilah alat dari renderer
  const web = createWebBrowser({ WebContentsView, getWindow: () => win, shell, send: (st) => send('webstate', st), log });
  // Penampil situs Web Lokal (0.34.0 Fase F): protokol archne-site:// + tampilan terisolasi. Nama pemilik di bilah dibaca dari Core di sini (nameOf), bukan dari renderer atau situs.
  // Tautan http(s) yang dipicu situs TIDAK dibuka langsung: 'siteext' membuat bilah meminta konfirmasi pengguna, lalu siteExternal membukanya di peramban luar.
  site = createSiteBrowser({ WebContentsView, session, getWindow: () => win, core, shell, nameOf: (id) => { const p = core.peers.get(id); return p && p.name ? p.name : ''; }, send: (st) => send('sitestate', st), onExternal: (url) => send('siteext', { url }), log, php: phpHost });
  // Berbagi layar (v0.32.0 Fase C): pemilih sumber milik Archne sendiri (src/archne-screenpick.js); pengguna harus memilih layar/jendela, tanpa audio sistem
  screen = createScreenPicker({ desktopCapturer, getWindow: () => win, rendererDir, send, log });
  ipc = register({
    ipcMain, core, log, shell, wsProxy, web, site, screen,
    getPhpHost: () => phpHost, // P.7a: alat database situs (dbTables)
    getCron: () => cron, // C6: kanal cron (hanya pemilik)
    quit: appQuit, reset: appReset, // Pengaturan > Aplikasi: Keluar dan Reset data
    metrics: () => { try { const kb = app.getAppMetrics().reduce((a, m) => a + ((m.memory && m.memory.workingSetSize) || 0), 0); return { appBytes: kb * 1024, src: 'processes' }; } catch { return null; } }, // Dasbor (U3): memori semua proses Archne (utama + render + GPU); gagal = RSS proses inti
    pathGuard: createPathGuard(), // hardening v1.0: renderer hanya boleh mengirim path yang dipilih lewat dialog/seret-lepas/jepretan
    send,
    pickFiles: async () => {
      const r = await dialog.showOpenDialog(win, { title: I18N.tr('e.native.sendFile', null, 'Kirim berkas'), properties: ['openFile', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    },
    // Kirim Langsung: pilih berkas ATAU folder (Windows/Linux tidak bisa gabungan di satu dialog) dan folder tujuan terima
    pickItems: async (kind) => {
      const r = await dialog.showOpenDialog(win, kind === 'folder'
        ? { title: I18N.tr('e.native.sendFolder', null, 'Kirim folder'), properties: ['openDirectory', 'multiSelections'] }
        : { title: I18N.tr('e.native.sendFile', null, 'Kirim berkas'), properties: ['openFile', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    },
    // Halaman: cadangan (5d-6). Jalur hanya dipakai proses utama; renderer tidak pernah melihatnya.
    pickSave: async (def, kind) => {
      const zip = kind === 'zip'; // ekspor situs Web Lokal (0.34.0 U2); selain itu = cadangan Halaman
      const r = await dialog.showSaveDialog(win, kind === 'sql'
        ? { title: I18N.tr('e.native.exportMysql', null, 'Ekspor dump MySQL'), defaultPath: def, filters: [{ name: I18N.tr('e.native.sqlFile', null, 'Dump SQL'), extensions: ['sql'] }] } // dump MySQL (Web Lokal › Database, fase 3-4)
        : zip
        ? { title: I18N.tr('e.native.exportSite', null, 'Ekspor situs sebagai ZIP'), defaultPath: def, filters: [{ name: I18N.tr('e.native.zipFile', null, 'Arsip ZIP'), extensions: ['zip'] }] }
        : { title: I18N.tr('e.native.exportPage', null, 'Ekspor halaman'), defaultPath: def, filters: [{ name: I18N.tr('e.native.pageArchive', null, 'Arsip Halaman Archne'), extensions: ['archpg'] }] });
      return r.canceled || !r.filePath ? '' : r.filePath;
    },
    // Impor dump MySQL (Web Lokal › Database): hanya proses utama yang melihat jalurnya; IPC membaca berkasnya sendiri.
    pickSql: async () => {
      const r = await dialog.showOpenDialog(win, { title: I18N.tr('e.native.importSql', null, 'Impor dump MySQL'), properties: ['openFile'], filters: [{ name: I18N.tr('e.native.sqlFile', null, 'Dump SQL'), extensions: ['sql'] }, { name: I18N.tr('e.native.allFiles', null, 'Semua berkas'), extensions: ['*'] }] });
      return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0];
    },
    pickArc: async () => {
      const r = await dialog.showOpenDialog(win, { title: I18N.tr('e.native.importPage', null, 'Impor halaman'), properties: ['openFile'], filters: [{ name: I18N.tr('e.native.pageArchive', null, 'Arsip Halaman Archne'), extensions: ['archpg'] }, { name: I18N.tr('e.native.allFiles', null, 'Semua berkas'), extensions: ['*'] }] });
      return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0];
    },
    pickDir: async (def) => {
      const r = await dialog.showOpenDialog(win, { title: I18N.tr('e.native.saveToFolder', null, 'Simpan ke folder'), defaultPath: def, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0];
    },
  });

  win = new BrowserWindow({
    width: 960, height: 640, minWidth: 640, minHeight: 420,
    backgroundColor: '#111418',
    icon: path.join(__dirname, 'assets', 'icon.png'), // ikon jendela/taskbar (juga saat dijalankan dengan `npm start`)
    // autoplayPolicy: nada dering dan audio lawan bicara harus bisa berbunyi tanpa menunggu klik (panggilan masuk datang tiba-tiba)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  // Hanya mikrofon/kamera dan tangkap layar (display-capture), hanya untuk jendela ini; izin lain ditolak.
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(wc === win.webContents && allowPermission(permission, { url: details && details.requestingUrl, mediaTypes: details && details.mediaTypes }, rendererDir)));
  ses.setPermissionCheckHandler((wc, permission, origin, details) => wc === win.webContents && allowPermission(permission, { url: details && details.requestingUrl, origin, mediaType: details && details.mediaType }, rendererDir));
  // Layar yang dibagikan hanya lahir dari sini. Tanpa useSystemPicker: dialog Archne (C.2) dipakai di semua sistem supaya perilakunya sama (pemilih sistem setahu kami hanya macOS; belum dicek untuk Electron 45).
  ses.setDisplayMediaRequestHandler((request, callback) => { screen.handler(request, callback).catch((e) => { log('display media gagal: ' + (e && e.message)); try { callback({}); } catch {} }); });
  // Hardening v1.0: jendela utama hanya boleh menampilkan UI lokal (file renderer/). Tidak ada jendela baru, tidak ada navigasi keluar;
  // tautan web dibuka lewat peramban dalam aplikasi (src/archne-webbrowser.js) atau peramban sistem setelah validasi http(s).
  const wc = win.webContents, uiRoot = require('url').pathToFileURL(rendererDir + path.sep).href;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (ev, u) => { if (!String(u).startsWith(uiRoot)) ev.preventDefault(); });
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(rendererDir, 'archne-index.html'));
  // Electron 35+: argumen tunggal berisi {level, message, ...}; bentuk lama (e, level, msg) sudah deprecated. Dua-duanya ditangani.
  win.webContents.on('console-message', (e, _level, msg) => log('renderer: ' + (e && typeof e.message === 'string' ? e.message : msg)));
  log('window ready, log: ' + logFile);
}

app.whenReady().then(boot).catch((e) => { log('boot error ' + (e && e.stack)); app.quit(); });
app.on('window-all-closed', async () => { await shutdown(); app.quit(); });
