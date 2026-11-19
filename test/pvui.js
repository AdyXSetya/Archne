'use strict';
// Tes UI daftar channel voice publik (v0.20.0, pvch6): skrip asli archne-index.html di vm dengan DOM tiruan (seperti test/ui.js).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const html = require('./_src').htmlSrc();
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const ME = '1'.repeat(16), BU = '2'.repeat(16), AN = '3'.repeat(16), GID = 'a'.repeat(16);
const P1 = 'd1'.repeat(8), P2 = 'd2'.repeat(8), P3 = 'd3'.repeat(8), P4 = 'd4'.repeat(8), P5 = 'd5'.repeat(8);

(async () => {
  // ---- A. struktur statis ----
  for (const id of ['pvbar', 'pvmodal', 'pvname', 'pvlock', 'pvpin', 'pvok', 'pvcancel', 'pvtitle', 'pinmodal', 'pinput', 'pinerr', 'pinok', 'pincancel', 'pintitle']) assert(new RegExp('id="' + id + '"').test(html), 'elemen ' + id);
  assert(/<div id="vcbar"><\/div>\s*<div id="pvbar"><\/div>\s*(?:<div id="sembar"><\/div>\s*)?<div id="msgs">/.test(html), 'pvbar di bawah vcbar, di atas pesan');
  assert(/#pvbar\{[^}]*max-height:36vh;[^}]*overflow:auto/.test(html), 'strip punya tinggi maksimum dan scroll sendiri');
  assert(/#pvbar \.vch-h\{[^}]*position:sticky/.test(html), 'header strip tetap terlihat saat di-scroll');
  ok('elemen strip dan dialog ada; strip punya tinggi maksimum + scroll, header menempel');

  const inline = require('./_src').inlineJs();
  const els = {};
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() {}, requestSubmit() {} });
  const calls = []; let state, updCb, failErr = null, confirmAns = true, storage = {};
  let kickCb = null, allList = [];
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'onUpdate') return (cb) => { updCb = cb; };
    if (n === 'onPvKick') return (cb) => { kickCb = cb; };
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    if (n === 'pvList') return async (...a) => { calls.push(['pvList', ...a]); return { ok: true, channels: allList }; };
    return async (...a) => { calls.push([n, ...a]); return failErr ? { ok: false, err: failErr } : { ok: true }; };
  } });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => confirmAns, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = v; } } };
  vm.createContext(ctx);
  const pv = (id, name, o) => Object.assign({ id, name, by: BU, locked: false, ts: 1, mine: false, canManage: false, count: 0, people: [], inside: false, full: false }, o);
  const rows = [
    pv(P1, 'Santai <b>', { count: 7, people: [{ id: BU, name: 'Budi' }, { id: AN, name: 'Ani' }, { id: 'x', name: 'Cici' }] }),
    pv(P2, 'Rapat', { locked: true, count: 2, people: [{ id: BU, name: 'Budi' }, { id: AN, name: 'Ani' }] }),
    pv(P3, 'Punyaku', { by: ME, mine: true, canManage: true, locked: true }),
    pv(P4, 'Penuh', { count: 16, full: true, people: [{ id: BU, name: 'Budi' }] })];
  allList = rows.concat([pv(P5, 'Sepi')]);
  state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [], limits: { maxText: 10000 }, sending: [], messages: [], vc: null, groups: [], pv: { me: null, channels: rows } };
  vm.runInContext(inline, ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const bar = els.pvbar, out = () => bar.innerHTML;
  const row = (cid) => { const o = out(), i = o.indexOf('data-cid="' + cid + '"'), j = o.indexOf('class="vch', i + 1); return o.slice(o.lastIndexOf('<div class="vch', i), j > 0 ? j : undefined); };
  const click = async (act, cid) => { calls.length = 0; await bar.onclick({ target: { closest: (sel) => (sel === '[data-pact]' ? { dataset: { pact: act, cid } } : null) }, stopPropagation() {} }); return calls.slice(); };
  const fc = (n) => JSON.parse(JSON.stringify(calls.filter((x) => x[0] === n))); // objek dari konteks vm berprototipe lain: bandingkan lewat JSON
  const toastTxt = () => els.toast.textContent;
  const cc = (o) => { const c = { cur: null, sync() {}, _render() {}, setChannelName() {}, onEvent() {}, hangup() { c.hung = true; }, enters: [], enterPublic: async (...a) => { c.enters.push(a); return c.next || { ok: true }; } }; Object.assign(c, o || {}); vm.runInContext('callCtl = __cc', Object.assign(ctx, { __cc: c })); return c; };

  // ---- B. tampilan di tab Publik ----
  assert.strictEqual(bar.style.display, 'block', 'tab Publik: strip tampil');
  assert(out().includes('Channel suara publik · 4'), 'jumlah channel');
  assert(out().includes('Santai &lt;b&gt;') && !out().includes('<b>'), 'nama di-escape');
  assert(out().includes('Budi, Ani, Cici +4') && out().includes('7/16'), 'tiga nama + sisanya + jumlah');
  assert(row(P3).includes('Kosong') && !row(P3).includes('/16'), 'milik sendiri yang kosong tetap tampil');
  assert(/data-pact="enter"/.test(row(P1)) && !/data-pact="del"|data-pact="edit"/.test(row(P1)), 'channel orang lain: Masuk saja');
  assert(/data-pact="enter"/.test(row(P3)) && /data-pact="del"/.test(row(P3)) && />Kelola</.test(row(P3)), 'milik sendiri: Masuk, Kelola, Hapus');
  assert(!/data-pact="enter"/.test(row(P4)) && /penuh/.test(row(P4)), 'penuh: tanpa tombol Masuk');
  assert(row(P2).includes('<rect') && !row(P1).includes('<rect'), 'gembok hanya di channel terkunci');
  vm.runInContext("cur = '" + BU + "'; render();", ctx);
  assert.strictEqual(bar.style.display, 'none', 'bukan tab Publik: strip tersembunyi');
  vm.runInContext("cur = 'public'; render();", ctx);
  assert.strictEqual(bar.style.display, 'block');
  ok('strip: jumlah, nama di-escape, "Budi, Ani, Cici +4" + 7/16, Kosong untuk milik sendiri, tombol sesuai hak, penuh, gembok; tersembunyi di luar Publik');

  // ---- C. "Yang kosong" ----
  assert(!out().includes('Sepi'), 'bawaan: channel kosong milik orang lain tersembunyi');
  let c = await click('empty');
  assert.deepStrictEqual(c, [['pvList', true]], 'meminta daftar lengkap ke Core');
  assert(out().includes('Sepi') && out().includes('Channel suara publik · 5') && out().includes('aria-pressed="true"'), 'channel kosong tampil, tombol menyala');
  assert.strictEqual(storage['lc.pvempty'], '1', 'pilihan diingat');
  await click('empty');
  assert(!out().includes('Sepi') && out().includes('aria-pressed="false"') && storage['lc.pvempty'] === '0');
  await click('fold'); assert.strictEqual(bar.className, 'vcfold'); assert.strictEqual(storage['lc.pvfold'], '1');
  await click('fold'); assert.strictEqual(bar.className, '');
  ok('"Yang kosong" menampilkan semua (diingat), lipat/buka diingat');

  // ---- D. masuk ----
  let ctl = cc(); c = await click('enter', P1);
  assert.deepStrictEqual(ctl.enters, [[P1, 'Santai <b>', '']], 'channel gratis: langsung masuk tanpa PIN');
  ctl = cc(); await click('enter', P3);
  assert.deepStrictEqual(ctl.enters, [[P3, 'Punyaku', '']], 'milik sendiri yang terkunci: tanpa PIN');
  ctl = cc(); await click('enter', P2);
  assert.strictEqual(ctl.enters.length, 0, 'terkunci tanpa PIN tersimpan: tidak langsung masuk');
  assert.strictEqual(els.pinmodal.style.display, 'flex'); assert(els.pintitle.innerHTML.includes('Rapat') && /<svg/.test(els.pintitle.innerHTML), 'judul modal PIN: ikon SVG gembok + nama channel');
  els.pinput.value = 'ab12cd3456789'; els.pinput.oninput(); assert.strictEqual(els.pinput.value, '123456', 'hanya angka, maksimal 6');
  els.pinput.value = '12'; await els.pinok.onclick();
  assert.strictEqual(ctl.enters.length, 0); assert(els.pinerr.textContent.includes('6 angka'), 'PIN kurang dari 6 angka ditolak di sisi UI');
  ctl.next = { ok: false, wrong: true }; els.pinput.value = '000000'; await els.pinok.onclick();
  assert.deepStrictEqual(ctl.enters, [[P2, 'Rapat', '000000']]);
  assert.strictEqual(els.pinerr.textContent, 'PIN salah'); assert.strictEqual(els.pinmodal.style.display, 'flex', 'dialog tetap terbuka');
  assert.strictEqual(storage['lc.pvpins'], undefined, 'PIN salah tidak diingat');
  ctl.next = { ok: true }; els.pinput.value = '123456'; await els.pinok.onclick();
  assert.strictEqual(els.pinmodal.style.display, 'none'); assert.deepStrictEqual(JSON.parse(storage['lc.pvpins']), { [P2]: '123456' }, 'PIN benar diingat');
  ctl.enters.length = 0; await click('enter', P2);
  assert.deepStrictEqual(ctl.enters, [[P2, 'Rapat', '123456']], 'masuk lagi memakai PIN yang diingat, tanpa dialog');
  ctl.next = { ok: false, wrong: true }; ctl.enters.length = 0; await click('enter', P2);
  assert.strictEqual(els.pinmodal.style.display, 'flex'); assert(els.pinerr.textContent.includes('diganti'), 'PIN lama ditolak: dibuang dan diminta ulang');
  assert.strictEqual(JSON.parse(storage['lc.pvpins'])[P2], undefined);
  await els.pincancel.onclick(); assert.strictEqual(els.pinmodal.style.display, 'none');
  ctl = cc({ cur: { vc: null } }); await click('enter', P1);
  assert.strictEqual(ctl.enters.length, 0, 'sedang dalam panggilan: tidak masuk'); assert(toastTxt().length > 0);
  ok('masuk: gratis/pemilik langsung, terkunci minta PIN (angka saja, 6), salah tidak diingat, benar diingat dan dipakai ulang, ditolak = diminta ulang, panggilan lain menolak');

  // ---- E. buat / kelola ----
  const open = (act, cid) => click(act, cid);
  await open('new'); assert.strictEqual(els.pvmodal.style.display, 'flex'); assert.strictEqual(els.pvpinbox.style.display, 'none');
  els.pvname.value = '   '; calls.length = 0; await els.pvok.onclick(); assert.strictEqual(calls.length, 0, 'nama kosong');
  els.pvname.value = '  Ngobrol  '; calls.length = 0; await els.pvok.onclick();
  assert.deepStrictEqual(fc('pvCreate'), [['pvCreate', 'Ngobrol', null]], 'gratis: tanpa PIN');
  await open('new'); els.pvname.value = 'Rahasia'; els.pvlock.checked = true; els.pvlock.onchange(); assert.strictEqual(els.pvpinbox.style.display, 'block');
  calls.length = 0; await els.pvok.onclick(); assert.strictEqual(calls.length, 0, 'kunci tanpa PIN ditolak'); assert(toastTxt().includes('PIN'));
  els.pvpin.value = '12ab'; els.pvpin.oninput(); assert.strictEqual(els.pvpin.value, '12');
  calls.length = 0; await els.pvok.onclick(); assert.strictEqual(calls.length, 0, 'PIN 2 angka ditolak');
  els.pvpin.value = '123456'; calls.length = 0; await els.pvok.onclick();
  assert.deepStrictEqual(fc('pvCreate'), [['pvCreate', 'Rahasia', '123456']]);
  // kelola channel terkunci milik sendiri
  await open('edit', P3);
  assert.strictEqual(els.pvname.value, 'Punyaku'); assert.strictEqual(els.pvlock.checked, true); assert.strictEqual(els.pvpin.value, ''); assert(els.pvpin.placeholder.includes('tidak diubah'));
  calls.length = 0; await els.pvok.onclick(); assert.strictEqual(calls.filter((x) => x[0] === 'pvUpdate').length, 0, 'tidak ada perubahan: tidak menaikkan versi');
  await open('edit', P3); els.pvname.value = 'Baru'; calls.length = 0; await els.pvok.onclick();
  assert.deepStrictEqual(fc('pvUpdate'), [['pvUpdate', P3, { name: 'Baru' }]], 'hanya nama: PIN tidak disentuh');
  await open('edit', P3); els.pvpin.value = '654321'; calls.length = 0; await els.pvok.onclick();
  assert.deepStrictEqual(fc('pvUpdate'), [['pvUpdate', P3, { pin: '654321' }]], 'ganti PIN');
  await open('edit', P3); els.pvlock.checked = false; els.pvlock.onchange(); calls.length = 0; await els.pvok.onclick();
  assert.deepStrictEqual(fc('pvUpdate'), [['pvUpdate', P3, { pin: null }]], 'buka kunci');
  // channel gratis milik sendiri dikunci: wajib PIN
  state.pv.channels[2] = pv(P3, 'Punyaku', { by: ME, mine: true, canManage: true }); await updCb(); await new Promise((r) => setImmediate(r));
  await open('edit', P3); els.pvlock.checked = true; els.pvlock.onchange(); calls.length = 0; await els.pvok.onclick();
  assert.strictEqual(calls.filter((x) => x[0] === 'pvUpdate').length, 0, 'mengunci tanpa PIN ditolak');
  els.pvpin.value = '111111'; calls.length = 0; await els.pvok.onclick();
  assert.deepStrictEqual(fc('pvUpdate'), [['pvUpdate', P3, { pin: '111111' }]]);
  failErr = 'Batas channel per orang tercapai'; await open('new'); els.pvname.value = 'Lagi'; await els.pvok.onclick();
  assert(toastTxt().includes('Batas channel'), 'galat Core ditampilkan'); assert.strictEqual(els.pvmodal.style.display, 'flex', 'dialog tetap terbuka'); failErr = null;
  ok('buat (gratis / kunci + PIN 6 angka) dan kelola (nama, ganti PIN, buka kunci, kunci wajib PIN, tanpa perubahan = tanpa update); galat Core tampil');

  // ---- F. hapus + keluar + dikeluarkan otomatis ----
  confirmAns = false;
  c = await click('del', P3); assert.deepStrictEqual(c, [], 'batal hapus');
  const del = await click('del', P1); assert.deepStrictEqual(del, [], 'bukan pemilik: tidak ada tombol hapus / tidak diproses');
  confirmAns = true; c = await click('del', P3); assert.deepStrictEqual(c.filter((x) => x[0] === 'pvDelete'), [['pvDelete', P3]]);
  state.pv.me = P1; await updCb(); await new Promise((r) => setImmediate(r));
  assert(/data-pact="leave"/.test(row(P1)), 'di dalam: tombol Keluar');
  c = await click('leave', P1); assert.deepStrictEqual(c.filter((x) => x[0] === 'pvLeave'), [['pvLeave']], 'tanpa sesi audio: keluar lewat API');
  ctl = cc({ cur: { pv: { cid: P1 } } }); await click('leave', P1); assert.strictEqual(ctl.hung, true, 'dengan sesi audio: lewat Controller');
  storage['lc.pvpins'] = JSON.stringify({ [P2]: '123456' });
  kickCb({ cid: P2, reason: 'pin' }); assert(toastTxt().includes('PIN channel "Rapat" diganti'), toastTxt()); assert.strictEqual(JSON.parse(storage['lc.pvpins'])[P2], undefined, 'PIN lama dibuang');
  kickCb({ cid: P2, reason: 'deleted' }); assert(toastTxt().includes('dihapus pemiliknya'));
  kickCb({ cid: P2, reason: 'locked' }); assert(toastTxt().includes('dikunci pemiliknya'));
  ok('hapus (konfirmasi, hanya pemilik), keluar (API atau Controller), dan pemberitahuan keluar otomatis (dihapus/dikunci/PIN diganti)');

  console.log('\n' + pass + ' tes UI channel publik lulus');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
