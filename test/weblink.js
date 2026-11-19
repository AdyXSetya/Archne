'use strict';
// Tautan web di chat + peramban dalam aplikasi (v0.25.1): (1) renderer/archne-linkify.js murni, (2) src/archne-webbrowser.js dengan Electron tiruan,
// (3) skrip renderer asli di vm dengan DOM tiruan: chip, salin utuh, lipatan tidak membelah tautan, ketuk membuka peramban,
// (4) kontrak markup / IPC / cangkang Android, dan modal yang sudah bebas emoji.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');
const root = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let pass = 0;
const ok = (m) => { pass++; console.log('  OK  ' + m); };
const L = require('../renderer/archne-linkify.js');

// ---- 1. linkify murni ----
(function () {
  const urls = (t) => L.urls(t);
  assert.deepStrictEqual(urls('lihat https://example.com/a/b?x=1&y=2.'), ['https://example.com/a/b?x=1&y=2'], 'titik penutup kalimat tidak ikut');
  assert.deepStrictEqual(urls('(https://en.wikipedia.org/wiki/Foo_(bar))'), ['https://en.wikipedia.org/wiki/Foo_(bar)'], 'kurung berpasangan tetap, kurung penutup luar dibuang');
  assert.deepStrictEqual(urls('cek www.google.com, lalu http://a.b!'), ['www.google.com', 'http://a.b'], 'www. dan http; koma/tanda seru dibuang');
  assert.strictEqual(L.split('www.google.com')[0].href, 'https://www.google.com/', 'www. dilengkapi https');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'intent://x#Intent;end', 'ftp://x.y/z', 'archne://join?v=1&d=AAAA', 'https://']) assert.deepStrictEqual(urls(bad), [], 'bukan tautan web: ' + bad);
  assert.strictEqual(L.safeHref('https://' + 'a'.repeat(2100) + '.com'), null, 'terlalu panjang ditolak');
  const sp = L.split('https://bank.com@evil.com/login');
  assert.strictEqual(L.parts(sp[0].href).host, 'evil.com', 'host diambil dari penguraian URL (bukan teks): bank.com@evil.com tampil sebagai evil.com');
  const long = 'https://example.com/' + 'p'.repeat(200);
  assert(L.short('buka ' + long).length < 50, 'pratinjau memendekkan tautan panjang');
  assert(/^buka example\.com\/p+…$/.test(L.short('buka ' + long)));
  ok('linkify: tautan dikenali (www, kurung, tanda baca), skema berbahaya ditolak, host asli yang tampil, pratinjau memendek');

  const h = L.html('x <b> https://example.com/a?q=1&r=2"onmouseover="x y', { esc: L.esc });
  assert(!h.includes('<b>') && h.includes('x &lt;b&gt; '), 'teks biasa di-escape');
  assert(h.includes('data-url="https://example.com/a?q=1&amp;r=2"') && h.includes('data-lcopy'), 'data-url menyimpan tautan asli (di-escape), tombol salin ada');
  const attrs = [...h.matchAll(/\s[\w-]+="([^"]*)"/g)].map((m) => m[1]);
  assert(attrs.every((v) => !/[<>"]/.test(v)) && (h.match(/"/g) || []).length % 2 === 0, 'tanda kutip dan kurung sudut tidak pernah lolos ke dalam atribut');
  assert(h.includes('onmouseover=&quot;') || h.includes('"onmouseover'), 'sisa setelah tanda kutip diperlakukan sebagai teks, bukan atribut');
  const chip = L.html('https://example.com/' + 'p'.repeat(300));
  assert(chip.includes('class="lh">example.com<') && chip.includes('…</span>') && (chip.replace(/"[^"]*"/g, '""').match(/p/g) || []).length < 40, 'jalur panjang dipotong di chip, tapi utuh di data-url');
  assert(chip.includes('data-url="https://example.com/' + 'p'.repeat(300) + '"'), 'data-url tetap utuh walau chip dipendekkan');
  assert.strictEqual(L.cut('aaa https://example.com/xyz bbb', 10), 4 + 'https://example.com/xyz'.length, 'titik potong di tengah tautan digeser ke akhir tautan');
  assert.strictEqual(L.cut('aaa https://example.com/xyz bbb', 2), 2, 'di luar tautan tidak digeser');
  ok('linkify.html: teks di-escape, atribut aman, chip memendek tapi data-url utuh, lipatan tidak membelah tautan');
})();

// ---- 2. src/archne-webbrowser.js dengan Electron tiruan ----
(function () {
  const { createWebBrowser, safeUrl } = require('../src/archne-webbrowser');
  assert.strictEqual(safeUrl('https://a.b/c'), 'https://a.b/c');
  for (const b of ['javascript:1', 'file:///x', 'intent://x', 'market://details?id=x', 'about:blank', '', null, 42, 'http://', 'https://x/' + 'a'.repeat(2100)]) assert.strictEqual(safeUrl(b), null, 'ditolak: ' + String(b).slice(0, 30));
  ok('webbrowser.safeUrl: hanya http(s)');

  class WC extends EventEmitter {
    constructor() { super(); this.url = ''; this.hist = []; this.pos = -1; this.loads = []; this.destroyed = false; this.closed = false; this.sessionH = {}; this.session = { setPermissionRequestHandler: (f) => { this.sessionH.req = f; }, setPermissionCheckHandler: (f) => { this.sessionH.chk = f; }, on: (e, f) => { this.sessionH[e] = f; } }; this.navigationHistory = { canGoBack: () => this.pos > 0, canGoForward: () => this.pos < this.hist.length - 1, goBack: () => { this.pos--; this.url = this.hist[this.pos]; this.emit('did-navigate'); }, goForward: () => { this.pos++; this.url = this.hist[this.pos]; this.emit('did-navigate'); } }; }
    setWindowOpenHandler(f) { this.openH = f; }
    loadURL(u) { this.loads.push(u); this.hist = this.hist.slice(0, this.pos + 1); this.hist.push(u); this.pos++; this.url = u; this.emit('did-navigate'); }
    getURL() { return this.url; } getTitle() { return 'Judul'; } isLoading() { return false; } isDestroyed() { return this.destroyed; }
    reload() { this.reloaded = true; } stop() { this.stopped = true; } close() { this.closed = true; this.destroyed = true; }
  }
  class View { constructor(o) { this.opts = o; this.webContents = new WC(); this.bounds = null; } setBounds(b) { this.bounds = b; } }
  const mkWin = (zoom) => { const w = new EventEmitter(); w.views = []; w.destroyed = false; w.contentView = { addChildView: (v) => w.views.push(v), removeChildView: (v) => { w.views = w.views.filter((x) => x !== v); } }; w.getContentBounds = () => ({ width: 1000, height: 700 }); w.isDestroyed = () => w.destroyed; w.webContents = { getZoomFactor: () => zoom || 1 }; return w; };
  const mk = (zoom) => { const win = mkWin(zoom), sent = [], opened = []; const web = createWebBrowser({ WebContentsView: View, getWindow: () => win, shell: { openExternal: async (u) => { opened.push(u); } }, send: (s) => sent.push(s), log: () => {} }); return { win, web, sent, opened }; };

  let t = mk();
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x', '']) assert.strictEqual(t.web.open(bad, 48).ok, false, 'open menolak ' + bad);
  assert.strictEqual(t.win.views.length, 0, 'tampilan tidak dibuat untuk alamat ditolak');
  assert.strictEqual(t.web.open('https://example.com/x', 48).ok, true);
  const v = t.win.views[0], wc = v.webContents;
  assert(v.opts.webPreferences.sandbox === true && v.opts.webPreferences.nodeIntegration === false && v.opts.webPreferences.contextIsolation === true && !v.opts.webPreferences.preload, 'sandbox, tanpa Node, tanpa preload');
  assert.strictEqual(v.opts.webPreferences.partition, 'archne-web', 'sesi terpisah dan hanya di memori (tanpa awalan persist:)');
  assert.deepStrictEqual(v.bounds, { x: 0, y: 48, width: 1000, height: 652 }, 'tampilan di bawah bilah alat 48 px');
  assert.deepStrictEqual(wc.loads, ['https://example.com/x']);
  ok('webbrowser.open: alamat non-http ditolak, tampilan tersandbox di sesi terpisah, pas di bawah bilah alat');

  t.win.getContentBounds = () => ({ width: 800, height: 500 }); t.win.emit('resize');
  assert.deepStrictEqual(v.bounds, { x: 0, y: 48, width: 800, height: 452 }, 'ukuran ikut jendela');
  t.web.setTop(60); assert.strictEqual(v.bounds.y, 60);
  const z = mk(1.25); z.web.open('https://a.b/', 48); assert.strictEqual(z.win.views[0].bounds.y, 60, 'zoom 125% menggeser batas (48 x 1,25)');
  ok('webbrowser: ukuran mengikuti jendela dan zoom');

  assert.deepStrictEqual(wc.openH({ url: 'https://ads.example/pop' }), { action: 'deny' });
  assert.strictEqual(wc.loads[wc.loads.length - 1], 'https://ads.example/pop', 'popup http(s) dimuat di tampilan yang sama (bisa di-Mundur)');
  const n0 = wc.loads.length; wc.openH({ url: 'intent://evil#Intent;end' }); wc.openH({ url: 'javascript:1' });
  assert.strictEqual(wc.loads.length, n0, 'popup berskema lain tidak dimuat');
  let prevented = 0; const evt = () => ({ preventDefault() { prevented++; } });
  wc.emit('will-navigate', evt(), 'market://details?id=x'); wc.emit('will-redirect', evt(), 'intent://x#Intent;end'); wc.emit('will-navigate', evt(), 'https://ok.example/');
  assert.strictEqual(prevented, 2, 'pengalihan ke market:/intent: diblokir, https dibiarkan');
  let granted = 'x'; wc.sessionH.req(null, 'media', (g) => { granted = g; }); assert.strictEqual(granted, false, 'izin kamera/mikrofon/lokasi ditolak');
  assert.strictEqual(wc.sessionH.chk(), false);
  let dl = 0; wc.sessionH['will-download']({ preventDefault() { dl++; } }); assert.strictEqual(dl, 1, 'unduhan diblokir');
  ok('webbrowser: popup iklan dimuat di tampilan sama, skema asing dan izin dan unduhan diblokir');

  const last = () => t.sent[t.sent.length - 1];
  assert.strictEqual(last().canBack, true, 'setelah popup, Mundur aktif');
  assert.strictEqual(last().open, true);
  assert.deepStrictEqual(t.web.nav('back'), { ok: true });
  assert.strictEqual(wc.url, 'https://example.com/x', 'Mundur kembali ke halaman sebelum iklan');
  assert.strictEqual(last().canFwd, true, 'Maju aktif setelah Mundur');
  t.web.nav('forward'); assert.strictEqual(wc.url, 'https://ads.example/pop');
  t.web.nav('reload'); assert(wc.reloaded);
  assert.strictEqual(t.web.nav('hapus').ok, false, 'aksi tak dikenal ditolak');
  ok('webbrowser.nav: Mundur / Maju / Muat ulang; status tombol dikirim ke renderer');

  (async () => {
    const r = await t.web.external();
    assert.deepStrictEqual(t.opened, ['https://ads.example/pop'], 'Buka di luar memakai alamat halaman sekarang');
    assert.strictEqual((await t.web.external('javascript:alert(1)')).ok, false, 'alamat berbahaya tidak diteruskan ke sistem');
    assert.strictEqual((await t.web.external('https://x.y/z')).ok, true); assert.strictEqual(t.opened[1], 'https://x.y/z');
    assert(r.ok);
    t.web.close(); assert.strictEqual(t.win.views.length, 0, 'tampilan dilepas'); assert(wc.closed, 'halaman ditutup');
    assert.strictEqual(last().open, false, 'renderer diberi tahu: tertutup');
    assert.strictEqual(t.web.nav('back').ok, false); assert.strictEqual(t.web.close().ok, true, 'tutup dua kali aman');
    t.web.open('https://again.example/', 48); assert.strictEqual(t.win.views.length, 1, 'bisa dibuka lagi');
    t.web.open('https://again2.example/', 48); assert.strictEqual(t.win.views.length, 1, 'membuka lagi memakai tampilan yang sama');
    t.win.emit('closed'); assert.strictEqual(t.win.views.length, 0, 'jendela utama ditutup: tampilan ikut dibersihkan');
    ok('webbrowser: Buka di luar hanya http(s); tutup membersihkan; satu tampilan dipakai ulang');
    parts34();
  })().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
})();

function parts34() {
  // ---- 3. renderer asli di vm ----
  const inline = require('./_src').inlineJs();
  const els = {}, docH = {}, calls = [], clip = [];
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, hidden: false, scrollTop: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() {}, select() {}, requestSubmit() {}, querySelectorAll: () => [], classList2: null });
  let stCb = null;
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'onUpdate') return (cb) => {};
    if (n === 'onWebState') return (cb) => { stCb = cb; };
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    if (n === 'wanSettings') return async () => ({ ok: true, settings: { enabled: false, hasCode: false, netId: null, broker: 'wss://broker.emqx.io:8084/mqtt', turn: { provider: 'none' } } });
    if (n === 'invitePeek') return async () => ({ ok: true, info: { netId: 'aaaaaa111111', broker: 'wss://broker.emqx.io:8084/mqtt', hasTurn: false, current: false, enabled: false } });
    return async (...a) => { calls.push([n, ...a]); return { ok: true }; };
  } });
  const ME = '1'.repeat(16), URL1 = 'https://example.com/artikel/panjang/sekali?utm_source=x&utm_medium=y&ref=zzzzzzzzzzzzzzzz';
  const INV = 'archne://join?v=1&d=AAAA';
  const filler = 'kata '.repeat(190);
  const state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [], limits: { maxText: 10000 }, sending: [], groups: [], pv: { me: null, channels: [] }, messages: [
    { id: 'u1', from: 'f'.repeat(16), name: 'Budi#ffff', to: 'public', ts: Date.now() - 5000, text: 'baca ini ' + URL1 + ' ya' },
    { id: 'u2', from: ME, name: 'Saya', to: 'public', ts: Date.now() - 4000, text: filler + URL1 + ' selesai' },
    { id: 'u3', from: 'f'.repeat(16), name: 'Budi#ffff', to: 'public', ts: Date.now() - 3000, text: 'gabung: ' + INV + ' dan ' + URL1 },
  ] };
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null, addEventListener: (t, fn) => { (docH[t] = docH[t] || []).push(fn); }, body: { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } } };
  const opened = [];
  const ctx = { window: { api, open: (...a) => opened.push(a), getSelection: () => ({ isCollapsed: true }), parent: null }, document: doc, navigator: { clipboard: { writeText: async (t) => { clip.push(t); } } }, CSS: { escape: (s) => s },
    FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), Linkify: L, URL, confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, clearInterval: () => {}, localStorage: { getItem: () => null, setItem: () => {} } };
  ctx.window.parent = ctx.window;
  vm.createContext(ctx); vm.runInContext(inline, ctx);
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const ev = (c) => vm.runInContext(c, ctx);
  (async () => {
    await flush();
    const b1 = ev('bodyHtml(' + JSON.stringify(state.messages[0]) + ')');
    assert(b1.includes('class="lnk"') && b1.includes('class="lh">example.com<'), 'URL jadi chip');
    assert(!b1.replace(/data-url="[^"]*"|href="[^"]*"|title="[^"]*"/g, '').includes('utm_source=x&amp;utm_medium'), 'teks tampak tidak memuat deretan URL panjang (hanya di atribut)');
    assert(b1.startsWith('baca ini ') && b1.endsWith(' ya'), 'teks di sekitar tautan tetap');
    ok('bodyHtml: tautan jadi chip ringkas, teks sekitar tetap');

    const b2 = ev('bodyHtml(' + JSON.stringify(state.messages[1]) + ')');
    assert(b2.includes('Lihat selengkapnya') && b2.includes('class="lnk"') && b2.includes('data-url="' + URL1.replace(/&/g, '&amp;') + '"'), 'pesan panjang: lipatan, tautan di batas lipatan tetap utuh');
    ok('lipatan pesan panjang tidak membelah tautan');

    const b3 = ev('bodyHtml(' + JSON.stringify(state.messages[2]) + ')');
    assert(b3.includes('class="inv"') && b3.includes('data-inv="0"') && b3.includes('class="lnk"') && !b3.includes('archne://'), 'undangan tetap kartu, URL di pesan yang sama jadi chip');
    ok('pesan berisi undangan + URL: kartu dan chip berdampingan');

    // klik chip -> peramban dalam aplikasi
    const click = (target) => { let pd = 0, sp = 0; for (const f of docH.click || []) f({ target, preventDefault() { pd++; }, stopPropagation() { sp++; } }); return { pd, sp }; };
    const wrap = { dataset: { url: URL1 } };
    const aEl = { getAttribute: () => URL1, closest: (s) => (s === 'a.lnk' ? aEl : s.includes('data-url') ? wrap : null) };
    calls.length = 0; const r = click({ closest: (s) => (s === '[data-lcopy]' ? null : s === 'a.lnk' ? aEl : null) });
    await flush();
    assert(r.pd === 1, 'klik chip tidak menavigasi halaman utama (preventDefault)');
    const wo = calls.find((c) => c[0] === 'webOpen');
    assert(wo && wo[1] === URL1 && typeof wo[2] === 'number', 'ketuk chip memanggil api.webOpen(url, tinggiBilah)');
    assert.strictEqual(els.webbr.hidden, false, 'overlay peramban tampil');
    ok('ketuk chip membuka peramban dalam aplikasi di bawah bilah alat');

    // status dari peramban -> tombol
    assert(typeof stCb === 'function', 'renderer mendengarkan onWebState');
    stCb({ open: true, url: URL1, title: 'Artikel', canBack: true, canFwd: false, loading: true });
    assert.strictEqual(els.wbback.disabled, false); assert.strictEqual(els.wbfwd.disabled, true); assert.strictEqual(els.wbload.hidden, false);
    assert.strictEqual(els.wbh.textContent, 'example.com'); assert.strictEqual(els.wbs.textContent, 'Artikel');
    stCb({ open: true, url: 'http://plain.example/', title: '', canBack: false, canFwd: true, loading: false });
    assert(els.wbh.classList.contains('http'), 'http (tanpa enkripsi) ditandai');
    calls.length = 0; els.wbback.onclick(); els.wbfwd.onclick(); els.wbre.onclick(); els.wbext.onclick(); await flush();
    assert.deepStrictEqual(calls.map((c) => c.slice(0, 2).join(':')), ['webNav:back', 'webNav:forward', 'webNav:reload', 'webExternal'], 'tombol Mundur / Maju / Muat ulang / Buka di luar');
    calls.length = 0; els.wbx.onclick(); await flush();
    assert(calls.some((c) => c[0] === 'webClose') && els.webbr.hidden === true, 'Tutup melepas peramban dan menyembunyikan overlay');
    ok('bilah alat: status Mundur/Maju/memuat, tanda http, empat aksi + Tutup');

    // salin: tombol di chip dan kartu undangan
    clip.length = 0;
    click({ closest: (s) => (s === '[data-lcopy]' ? { closest: () => wrap } : null) }); await flush();
    assert.deepStrictEqual(clip, [URL1], 'tombol salin chip menyalin tautan LENGKAP');
    ev('wanLid(' + JSON.stringify(INV) + ')');
    click({ closest: (s) => (s === '[data-lcopy]' ? { closest: () => ({ dataset: { inv: '0' } }) } : null) }); await flush();
    assert.strictEqual(clip[1], INV, 'tombol salin kartu undangan menyalin tautan undangan lengkap');
    // Ctrl+C pada teks terpilih
    const fake = (kids) => ({ querySelectorAll: () => kids.map((k) => ({ dataset: k, replaceWith(n) { this.rep = n; } })) });
    assert(docH.copy && docH.copy.length, 'ada penangan copy');
    ok('salin: tombol chip, tombol kartu undangan, penangan Ctrl+C terpasang; teks pesan (menu "Salin teks") memang tidak pernah diubah');

    // tanpa api.webOpen (peramban biasa / Android): cadangan
    const savedApi = ctx.window.api; ctx.window.api = {};
    const par = []; ctx.window.parent = { postMessage: (m) => par.push(m) };
    await ev('wbOpen')('https://x.example/y');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(par)), [{ archne: 'native', action: 'weburl', url: 'https://x.example/y' }], 'di dalam iframe Android: dikirim ke cangkang');
    ctx.window.parent = ctx.window; await ev('wbOpen')('https://x.example/z');
    assert.strictEqual(opened.length, 1, 'peramban biasa: tab baru'); assert.deepStrictEqual(opened[0].slice(0, 2), ['https://x.example/z', '_blank']); assert(/noopener/.test(opened[0][2]));
    par.length = 0; opened.length = 0; ctx.window.parent = { postMessage: (m) => par.push(m) };
    await ev('wbOpen')('javascript:alert(1)'); await ev('wbOpen')('file:///etc/passwd');
    assert(!par.length && !opened.length, 'skema selain http(s) tidak pernah dibuka');
    ctx.window.api = savedApi;
    ok('cadangan tanpa peramban dalam aplikasi: cangkang Android atau tab baru (noopener); skema asing tidak dibuka');

    // pratinjau
    const pv = ev('lnkShort(' + JSON.stringify('ke ' + URL1) + ')');
    assert(pv.length < 55 && pv.startsWith('ke example.com/'), 'pratinjau daftar/balasan memendekkan tautan');
    ok('pratinjau daftar chat dan kutipan balasan memendekkan tautan');
    parts4();
  })().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
}

function parts4() {
  // ---- 4. kontrak ----
  const html = rd('renderer/archne-index.html');
  assert(html.indexOf('src="archne-linkify.js"') > 0 && html.indexOf('src="archne-linkify.js"') < html.indexOf('src="js/archne-state-util.js"'), 'archne-linkify.js dimuat sebelum js/10');
  assert(html.indexOf('src="js/archne-weblink.js"') > html.indexOf('src="js/archne-inline.js"') && html.indexOf('src="js/archne-weblink.js"') < html.indexOf('src="js/archne-call-ui.js"'));
  for (const id of ['wbx', 'wbback', 'wbfwd', 'wbre', 'wbext']) {
    const m = new RegExp('<button id="' + id + '"[^>]*>([\\s\\S]*?)</button>').exec(html); assert(m, id);
    assert(/title="[^"]+"/.test(m[0]) && /aria-label="[^"]+"/.test(m[0]) && m[1].startsWith('<svg') && m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').trim() === '', id + ': tombol ikon dengan title + aria-label');
  }
  assert(!/frame-src|child-src/.test(html.split('\n')[2]), 'CSP renderer tidak dilonggarkan untuk iframe web');
  const preload = rd('preload.js'), ipc = rd('src/archne-ipc.js'), main = rd('main.js');
  for (const c of ['webOpen', 'webNav', 'webBounds', 'webClose', 'webExternal']) assert(preload.includes("invoke('" + c + "'") && ipc.includes("'" + c + "'"), 'saluran ' + c);
  assert(main.includes("'webstate'") && main.includes('WebContentsView'), 'main.js menyambungkan peramban');
  const android = rd('android/www/index.html');
  assert(/action === 'weburl'/.test(android) && /\^https\?:/.test(android) && /InAppBrowser/.test(android), 'cangkang Android: weburl -> InAppBrowser, hanya http(s)');
  assert(/cordova-plugin-inappbrowser/.test(rd('scripts/android-build.ps1')), 'plugin InAppBrowser dipasang oleh skrip build Android');
  ok('kontrak: markup bilah alat, urutan skrip, CSP tetap, saluran IPC, event webstate, cangkang Android + plugin');

  // modal bebas emoji (Step 3c)
  const EM = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const vp = rd('renderer/js/archne-voice-public.js').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const needle of ['diblokir', 'Keluar dari grup', 'Bubarkan grup', 'anggota\'', 'pintitle']) { const l = vp.split('\n').filter((x) => x.includes(needle)); assert(l.length, needle); for (const x of l) assert(!EM.test(x), 'tanpa emoji: ' + needle); }
  const idx = html.split('\n').filter((l) => /id="(vmodal|pvmodal|setmodal)"/.test(l)).join('\n'); assert(!EM.test(idx), 'modal channel dan Pengaturan tanpa emoji');
  for (const f of ['settings', 'settings-relay', 'theme', 'settings-media']) assert(/icon: '(db|relay|palette|image)'/.test(rd('renderer/js/archne-' + f + '.js')), f + ' punya ikon bagian');
  ok('Step 3c: modal anggota grup, judul/label modal channel, dan dialog Pengaturan memakai ikon SVG, bukan emoji');
  console.log(pass + ' tes lulus');
}
