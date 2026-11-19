'use strict';
// Peramban dalam aplikasi (v0.25.1, Electron): tautan web di chat dibuka di WebContentsView di bawah bilah alat milik renderer
// (Tutup, Mundur, Maju, Muat ulang, Buka di luar). Dipisah dari main.js supaya bisa dites tanpa Electron: semua yang menyentuh
// Electron masuk lewat `deps` ({ WebContentsView, getWindow, shell, send(state), log }).
//
// Aturan keamanan:
//  - Hanya http dan https. Skema lain (file:, javascript:, intent:, market:, ...) ditolak, juga saat pengalihan di dalam halaman.
//  - Halaman web tidak mendapat preload, tidak ada Node, sandbox menyala, dan sesi sendiri yang hanya hidup di memori
//    (tidak berbagi cookie dengan aplikasi, hilang saat ditutup).
//  - Semua izin (kamera, mikrofon, lokasi, notifikasi, ...) ditolak, dan unduhan diblokir.
//  - Popup / target=_blank (iklan yang membuka tab baru) dibuka di tampilan yang sama, jadi tombol Mundur bisa kembali.
const I18N = require('./core/archne-i18n-node'); // i18n (E9e): err ke UI diterjemahkan; cadangan = teks Indonesia asli
const MAX_URL = 2048;

function safeUrl(u) {
  if (typeof u !== 'string' || !u || u.length > MAX_URL) return null;
  let p;
  try { p = new URL(u); } catch (e) { return null; }
  if ((p.protocol !== 'http:' && p.protocol !== 'https:') || !p.hostname) return null;
  return p.href;
}

function createWebBrowser(deps) {
  const log = deps.log || function () {};
  const send = (st) => { try { deps.send && deps.send(st); } catch (e) {} }; // main.js meneruskan ke saluran 'webstate'
  let view = null, win = null, top = 48, onResize = null, onClosed = null;

  const wcOf = () => (view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null);
  const hist = (wc) => wc.navigationHistory || wc; // Electron 32+: wc.navigationHistory; sebelumnya langsung di wc
  const state = (extra) => {
    const wc = wcOf();
    const o = { open: !!wc, url: '', title: '', canBack: false, canFwd: false, loading: false };
    if (wc) {
      try { o.url = wc.getURL(); o.title = wc.getTitle(); o.loading = !!wc.isLoading(); const h = hist(wc); o.canBack = !!h.canGoBack(); o.canFwd = !!h.canGoForward(); } catch (e) {}
    }
    return Object.assign(o, extra || {});
  };
  const push = (extra) => send(state(extra));

  function layout() {
    if (!view || !win || win.isDestroyed()) return;
    const cb = win.getContentBounds();
    const z = (win.webContents && typeof win.webContents.getZoomFactor === 'function' ? win.webContents.getZoomFactor() : 1) || 1;
    const y = Math.max(0, Math.min(Math.round(top * z), cb.height - 40));
    view.setBounds({ x: 0, y, width: Math.max(1, cb.width), height: Math.max(1, cb.height - y) });
  }

  function build() {
    const v = new deps.WebContentsView({ webPreferences: { partition: 'archne-web', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
    const wc = v.webContents, ses = wc.session;
    try { ses.setPermissionRequestHandler((_w, _p, cb) => cb(false)); ses.setPermissionCheckHandler(() => false); } catch (e) {}
    try { ses.on('will-download', (ev) => ev.preventDefault()); } catch (e) {}
    wc.setWindowOpenHandler((d) => { const u = safeUrl(d && d.url); if (u) { try { wc.loadURL(u); } catch (e) {} } return { action: 'deny' }; });
    const guard = (ev, u) => { if (!safeUrl(u)) { try { ev.preventDefault(); } catch (e) {} log('peramban: skema ditolak ' + String(u).slice(0, 40)); } };
    wc.on('will-navigate', (ev, u) => guard(ev, u));
    wc.on('will-redirect', (ev, u) => guard(ev, u));
    for (const e of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) wc.on(e, () => push());
    wc.on('render-process-gone', () => push({ crashed: true }));
    return v;
  }

  function open(url, topPx) {
    const u = safeUrl(url);
    if (!u) return { ok: false, err: I18N.tr('e.web.badUrl', null, 'Tautan tidak bisa dibuka (hanya http dan https)') };
    win = deps.getWindow();
    if (!win || win.isDestroyed()) return { ok: false, err: I18N.tr('e.web.noWin', null, 'Jendela tidak tersedia') };
    if (typeof topPx === 'number' && isFinite(topPx)) top = Math.max(0, Math.min(400, topPx));
    if (!view) {
      view = build();
      win.contentView.addChildView(view);
      onResize = () => layout();
      onClosed = () => dispose();
      win.on('resize', onResize); win.on('closed', onClosed);
    }
    layout();
    try { view.webContents.loadURL(u); } catch (e) { log('peramban: loadURL gagal ' + e.message); }
    push({ url: u });
    return { ok: true };
  }

  function close() {
    if (!view) return { ok: true };
    const v = view; view = null;
    try { if (win && !win.isDestroyed()) { win.contentView.removeChildView(v); win.removeListener('resize', onResize); win.removeListener('closed', onClosed); } } catch (e) {}
    try { if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close(); } catch (e) {}
    send({ open: false, url: '', title: '', canBack: false, canFwd: false, loading: false });
    return { ok: true };
  }
  const dispose = () => { try { close(); } catch (e) {} };

  function nav(action) {
    const wc = wcOf();
    if (!wc) return { ok: false };
    const h = hist(wc);
    if (action === 'back') { if (h.canGoBack()) { if (typeof h.goBack === 'function') h.goBack(); else wc.goBack(); } }
    else if (action === 'forward') { if (h.canGoForward()) { if (typeof h.goForward === 'function') h.goForward(); else wc.goForward(); } }
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
    else return { ok: false, err: I18N.tr('e.web.badAction', null, 'Aksi tidak dikenal') };
    return { ok: true };
  }

  function setTop(px) { if (typeof px === 'number' && isFinite(px)) { top = Math.max(0, Math.min(400, px)); layout(); } return { ok: true }; }

  // Buka di peramban luar: tautan yang sedang tampil (atau url yang diberikan), tetap hanya http(s).
  async function external(url) {
    const wc = wcOf();
    const u = safeUrl(typeof url === 'string' && url ? url : (wc ? wc.getURL() : ''));
    if (!u) return { ok: false, err: I18N.tr('e.web.badUrl', null, 'Tautan tidak bisa dibuka (hanya http dan https)') };
    try { await deps.shell.openExternal(u); return { ok: true }; } catch (e) { return { ok: false, err: I18N.tr('e.web.extFail', null, 'Gagal membuka peramban luar') }; }
  }

  return { open, close, nav, setTop, external, dispose, state, safeUrl, get isOpen() { return !!view; } };
}

module.exports = { createWebBrowser, safeUrl };
