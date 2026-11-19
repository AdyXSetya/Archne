'use strict';
// Tes Halaman 5a-4: bagian Pengaturan > Halaman (renderer/js/archne-settings-pages.js), skrip asli di vm dengan DOM tiruan.
// Yang dicek: struktur statis (urutan skrip), tampilan (saklar + dua angka dari getSettings().pages), simpan hanya yang berubah dalam SATU panggilan,
// nilai bawaan dikirim sebagai null, validasi ramah sebelum menyentuh Core, pemetaan galat Core, dan tampil di dialog utama pada urutan yang benar.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const { inlineJs } = require('./_src');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const MB = 1048576;

(async () => {
  // ---- A. struktur statis ----
  const idx = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
  assert(fs.existsSync(path.join(root, 'renderer/js/archne-settings-pages.js')));
  assert(idx.indexOf('js/archne-settings.js') < idx.indexOf('js/archne-settings-pages.js') && idx.indexOf('js/archne-settings-pages.js') < idx.indexOf('js/archne-direct.js'), '87 dimuat setelah SET_SECTIONS (80) dan sebelum 88');
  assert(/<script src="js\/archne-settings-pages\.js"><\/script>/.test(idx));
  ok('archne-settings-pages.js ada dan dimuat sesudah archne-settings.js');

  // ---- B. harness ----
  const els = {};
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, scrollTop: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() {}, requestSubmit() {} });
  const calls = []; let getRet, setRet;
  const state = { me: { id: '1'.repeat(16), name: 'Saya', port: 1 }, peers: [], limits: { maxText: 10000 }, sending: [], messages: [], vc: null, groups: [], pv: { me: null, channels: [] } };
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'onUpdate') return () => {};
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    if (n === 'getSettings') return async () => (getRet && getRet.ok ? Object.assign({ lang: 'id' }, getRet) : getRet);
    if (n === 'setSettings') return async (p) => { calls.push(JSON.parse(JSON.stringify(p))); return setRet(p); };
    return async () => ({ ok: true });
  } });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
    localStorage: { getItem: () => null, setItem: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(inlineJs(), ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  for (const id of ['toast', 'setbody', 'setmodal', 'setbtn', 'setclose', 'setsave']) doc.getElementById(id);

  const sec = vm.runInContext('SET_SECTIONS.find((s) => s.id === "pages")', ctx);
  assert(sec && sec.title === 'Halaman' && sec.icon === 'globe' && sec.order === 25);
  const IC_OK = vm.runInContext('!!IC.globe', ctx); assert(IC_OK, 'ikon globe ada');
  const pages = (o) => Object.assign({ serve: true, def: true, streams: { max: 3, peer: 2, def: { max: 3, peer: 2 }, min: { max: 1, peer: 1 }, ceil: { max: 8, peer: 4 } } }, o);
  const D = (o) => ({ ok: true, pages: pages(o) });
  const setEls = (serve, max, peer) => { doc.getElementById('setpgserve').checked = serve; doc.getElementById('setpgmax').value = String(max); doc.getElementById('setpgpeer').value = String(peer); };
  setRet = (p) => ({ ok: true, pages: pages() });

  // ---- C. tampilan ----
  let h = sec.html(D());
  assert(/id="setpgserve" checked/.test(h), 'bawaan: aktif tercentang');
  assert(/id="setpgmax"[^>]*min="1" max="8"[^>]*value="3"/.test(h) && /id="setpgpeer"[^>]*min="1" max="4"[^>]*value="2"/.test(h), 'angka: nilai, minimum, maksimum dari Core');
  assert(h.includes('bawaan 3') && h.includes('bawaan 2') && h.includes('1 sampai 8') && h.includes('1 sampai 4'), 'rentang dan bawaan ditampilkan');
  assert(!/id="setpgserve" checked/.test(sec.html(D({ serve: false }))), 'nonaktif: tidak tercentang');
  h = sec.html(D({ streams: { max: 6, peer: 3, def: { max: 3, peer: 2 }, min: { max: 1, peer: 1 }, ceil: { max: 8, peer: 4 } } }));
  assert(/id="setpgmax"[^>]*value="6"/.test(h) && /id="setpgpeer"[^>]*value="3"/.test(h), 'nilai tersimpan tampil');
  assert.strictEqual(sec.html({ ok: true, items: {} }), '', 'inti lama tanpa pages: bagian tidak digambar');
  assert.strictEqual(sec.html({ ok: true, pages: { serve: true, def: true } }), '', 'tanpa streams: tidak digambar');
  ok('tampilan: saklar dan dua angka dari getSettings().pages; inti lama tanpa pages tidak menggambar bagian');

  // ---- D. simpan ----
  let r;
  setEls(true, 3, 2); calls.length = 0; r = await sec.save(D());
  assert(r.ok && !r.changed && !calls.length, 'tidak berubah: tidak menulis apa pun');
  setEls(false, 3, 2); r = await sec.save(D());
  assert(r.ok && r.changed && JSON.stringify(calls[0]) === '{"pagesServe":false}' && calls.length === 1, 'mematikan: pagesServe=false saja');
  calls.length = 0; setEls(true, 3, 2); r = await sec.save(D({ serve: false }));
  assert(r.ok && JSON.stringify(calls[0]) === '{"pagesServe":null}', 'menyalakan kembali = bawaan (null)');
  calls.length = 0; setEls(true, 5, 2); r = await sec.save(D());
  assert(JSON.stringify(calls[0]) === '{"pgStreamMax":5}', 'angka baru dikirim sendiri');
  calls.length = 0; setEls(true, 3, 2); r = await sec.save(D({ streams: { max: 6, peer: 3, def: { max: 3, peer: 2 }, min: { max: 1, peer: 1 }, ceil: { max: 8, peer: 4 } } }));
  assert(JSON.stringify(calls[0]) === '{"pgStreamMax":null,"pgStreamPeer":null}', 'sama dengan bawaan = null (kunci dibuang)');
  calls.length = 0; setEls(false, 8, 1); r = await sec.save(D());
  assert(calls.length === 1 && JSON.stringify(calls[0]) === '{"pagesServe":false,"pgStreamMax":8,"pgStreamPeer":1}' && r.data && r.changed, 'beberapa perubahan = satu panggilan (atomik di Core); data baru dikembalikan');
  calls.length = 0; setEls(true, ' 4 ', 2); r = await sec.save(D());
  assert(JSON.stringify(calls[0]) === '{"pgStreamMax":4}', 'spasi di sekitar angka diabaikan');
  ok('simpan: hanya yang berubah, satu panggilan, bawaan = null, nyalakan kembali = null');

  // ---- E. validasi sebelum Core ----
  for (const [mx, pr, frag] of [['', 2, 'Isi angka bulat'], [3, 'abc', 'Isi angka bulat'], [2.5, 2, 'Isi angka bulat'], [0, 2, 'Minimal 1'], [-1, 2, 'Minimal 1'], [9, 2, 'Maksimal 8'], [3, 5, 'Maksimal 4'], ['1e1', 2, 'Isi angka bulat'], [3, '0x2', 'Isi angka bulat']]) {
    calls.length = 0; setEls(false, mx, pr); r = await sec.save(D());
    assert(r.ok === false && r.err.includes(frag) && !calls.length, 'ditolak tanpa menyentuh Core: ' + mx + ',' + pr + ' -> ' + r.err);
  }
  ok('validasi: kosong, bukan bilangan bulat, di luar rentang ditolak dengan pesan ramah; saklar ikut tidak tersimpan');

  // ---- F. galat dari Core ----
  setEls(true, 5, 2);
  setRet = () => ({ ok: false, code: 'max', key: 'pgStreamMax', max: 8 }); r = await sec.save(D());
  assert(r.ok === false && r.err === 'Maksimal 8 untuk "Video bersamaan (semua pemilik)"', r.err);
  setRet = () => ({ ok: false, code: 'min', key: 'pgStreamPeer', min: 1 }); r = await sec.save(D());
  assert(r.ok === false && r.err === 'Minimal 1 untuk "Video bersamaan (per pemilik)"', r.err);
  setRet = () => ({ ok: false, code: 'io' }); r = await sec.save(D());
  assert(r.ok === false && /Gagal menyimpan/.test(r.err));
  setRet = () => ({ ok: false, code: 'bad', key: 'pagesServe' }); r = await sec.save(D());
  assert(r.ok === false && /tidak sah/.test(r.err));
  setRet = () => null; r = await sec.save(D());
  assert(r.ok === false && /tidak sah/.test(r.err), 'jawaban kosong tidak melempar');
  ok('galat Core (min, max, io, bad, kosong) dipetakan ke pesan; tidak ada yang melempar');

  // ---- G. tanpa elemen / inti lama ----
  setRet = (p) => ({ ok: true, pages: pages() }); els.setpgserve = { checked: undefined }; // DOM tiruan membuat ulang elemen yang dihapus; ini meniru "elemen tidak ada"
  calls.length = 0;
  r = await sec.save(D()); assert(r.ok && !r.changed && !calls.length, 'dialog tanpa bagian ini: tidak menyimpan');
  r = await sec.save({ ok: true, items: {} }); assert(r.ok && !r.changed && !calls.length, 'inti lama: tidak menyimpan');
  ok('tanpa elemen atau tanpa pages: simpan tidak melakukan apa pun');

  // ---- H. di dialog utama ----
  const MBv = (k) => ({ cust: 500 * MB, files: 500 * MB, pubMsgs: 20 * MB })[k];
  const items = {}, usage = { cust: {}, files: {}, pubMsgs: { used: 0, count: 0, quota: 20 * MB } };
  for (const k of ['cust', 'files', 'pubMsgs']) items[k] = { value: MBv(k), def: MBv(k), min: 5 * MB, custom: false };
  const u0 = { used: 0, count: 0, quota: 500 * MB };
  usage.cust = { dm: u0, gmsg: u0 }; usage.files = { dm: u0, pub: u0, grp: u0, seed: u0 };
  getRet = { ok: true, items, usage, pages: pages() };
  calls.length = 0; await els.setbtn.onclick();
  const body = els.setbody.innerHTML, at = (id) => body.indexOf('data-sec="' + id + '"');
  assert(at('pages') > 0 && at('pages') < at('storage'), 'bagian Halaman tampil di dialog, di atas Penyimpanan (order 25 < 30)');
  assert(/<h4>.*Halaman<\/h4>/.test(body) && body.includes('id="setpgserve"'), 'judul dan saklar tergambar');
  ok('dialog utama: bagian Halaman tergambar pada urutan yang benar');

  console.log('\nOK: ' + pass + ' kelompok');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
