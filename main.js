'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Notification, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Core } = require('./src/archne-core');
const { register } = require('./src/archne-ipc');
const { allowMedia } = require('./src/archne-permissions');
const { createWsProxy } = require('./src/archne-wsproxy');
const { createWebBrowser } = require('./src/archne-webbrowser');
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

let win, core, ipc;

// Folder terima Kirim Langsung bawaan di Windows: <drive sistem>\file_transfer (mis. C:\file_transfer). Gagal dibuat/ditulisi -> null (Core memakai <unduhan>/file_transfer).
function directDefaultDir() {
  if (process.platform !== 'win32') return null;
  const d = path.join((process.env.SystemDrive || 'C:') + path.sep, 'file_transfer');
  try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { log('folder terima ' + d + ' tidak bisa dipakai: ' + e.message); return null; }
}

// Pemutar media (v0.25.0 Step 2b): archne-media://m/<token acak>. Token dibuat Core.mediaStream untuk satu berkas yang sudah lolos pemeriksaan;
// penyaji (src/archne-mediaserve.js) hanya membaca lewat core.mediaSrcRead, tidak pernah menerima jalur berkas.
protocol.registerSchemesAsPrivileged([{ scheme: 'archne-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

async function boot() {
  protocol.handle('archne-media', (req) => {
    try { const u = new URL(req.url); if (u.hostname === 'm' && core) return require('./src/archne-mediaserve').serveWeb(core, u.pathname.slice(1), req); } catch {}
    return new Response(null, { status: 404 });
  });
  core = new Core({
    dataDir: path.join(app.getPath('userData'), 'data'),
    directDir: directDefaultDir() || undefined,
    name: (() => { try { return require('os').userInfo().username; } catch { return ''; } })() || 'Anon',
    log,
  });
  await core.start();
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
  ipc = register({
    ipcMain, core, log, shell, wsProxy, web,
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
    pickSave: async (def) => {
      const r = await dialog.showSaveDialog(win, { title: I18N.tr('e.native.exportPage', null, 'Ekspor halaman'), defaultPath: def, filters: [{ name: I18N.tr('e.native.pageArchive', null, 'Arsip Halaman Archne'), extensions: ['archpg'] }] });
      return r.canceled || !r.filePath ? '' : r.filePath;
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  // Hanya mikrofon dan hanya untuk jendela ini; izin lain ditolak.
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(wc === win.webContents && allowMedia(permission, { url: details && details.requestingUrl, mediaTypes: details && details.mediaTypes }, rendererDir)));
  ses.setPermissionCheckHandler((wc, permission, origin, details) => wc === win.webContents && allowMedia(permission, { url: details && details.requestingUrl, origin, mediaType: details && details.mediaType }, rendererDir));
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(rendererDir, 'archne-index.html'));
  win.webContents.on('console-message', (_e, level, msg) => log('renderer: ' + msg));
  log('window ready, log: ' + logFile);
}

app.whenReady().then(boot).catch((e) => { log('boot error ' + (e && e.stack)); app.quit(); });
app.on('window-all-closed', async () => { try { if (ipc) ipc.dispose(); await core.stop(); } catch {} app.quit(); });
