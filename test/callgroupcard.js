'use strict';
// Tes kartu panggilan grup (v0.18.0, Step 4a): label, daftar peserta (maks 3 nama + "+N"), kartu di DM tiap anggota,
// baris tab Panggilan, pratinjau daftar chat, dan penyembunyian per DM (hcs). Skrip asli archne-index.html di vm, DOM tiruan.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const LC = require('../renderer/archne-call');
const flush = () => new Promise((r) => setImmediate(r));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  console.log('Archne group-call-card test');
  const mem = (...n) => n.map((x, i) => ({ id: String(i + 1).repeat(16), name: x }));

  // ---------- 1. label ----------
  let L = LC.callLabel({ group: true, dir: 'out', out: 'done', dur: 300, members: mem('Budi') });
  assert.deepStrictEqual([L.title, L.short, L.bad], ['Panggilan grup · 5 mnt', 'Panggilan grup · 5 mnt', false]);
  L = LC.callLabel({ group: true, dir: 'in', out: 'missed', members: mem('Budi') }); assert(L.bad && L.title === 'Panggilan grup tak terjawab');
  assert.strictEqual(LC.callLabel({ group: true, dir: 'out', out: 'noanswer' }).title, 'Panggilan grup · Tidak dijawab');
  assert.strictEqual(LC.callLabel({ group: true, dir: 'out', out: 'failed' }).bad, true);
  assert.strictEqual(LC.callLabel({ dir: 'out', out: 'done', dur: 5 }).title, 'Panggilan suara', '1-1 tidak berubah');
  ok('label grup memuat hasil di judul; label 1-1 tidak berubah');

  // ---------- 2. daftar peserta ----------
  assert.strictEqual(LC.callMembers({ members: mem('Budi') }), 'Kamu, Budi');
  assert.strictEqual(LC.callMembers({ members: mem('Budi', 'Sari') }), 'Kamu, Budi, Sari');
  assert.strictEqual(LC.callMembers({ members: mem('Budi', 'Sari', 'Eka', 'Dewi', 'Tono') }), 'Kamu, Budi, Sari +3');
  assert.strictEqual(LC.callMembers({ members: mem('Budi', 'Sari', 'Eka', 'Dewi') }, { me: false }), 'Budi, Sari, Eka +1');
  assert.strictEqual(LC.callMembers({ members: mem('Budi#ab12') }), 'Kamu, Budi', 'tag #id dibuang');
  ok('maksimal 3 nama (termasuk Kamu), sisanya +N');

  // ---------- 3. UI ----------
  const html = require('./_src').htmlSrc();
  const inline = require('./_src').inlineJs();
  const els = {}, bodyCls = new Set();
  const mkEl = (id) => ({ id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener() {}, focus() {}, requestSubmit() {} });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null,
    body: { classList: { add: (c) => bodyCls.add(c), remove: (c) => bodyCls.delete(c), contains: (c) => bodyCls.has(c) } } };
  let state;
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (['onProgress', 'onUpdate', 'onRemoved', 'onCall'].includes(n)) return () => {};
    return async () => ({ ok: true });
  } });
  const win = { api, LanCall: LC, RTCPeerConnection: function () {}, MediaStream: function () {}, Audio: function () { this.play = () => Promise.resolve(); this.pause = () => {}; }, navigator: { mediaDevices: { getUserMedia: async () => ({}) } } };
  const ctx = { window: win, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON };
  vm.createContext(ctx);
  const now = Date.now();
  const B = 'b1'.repeat(8), S = 's1'.repeat(8), E = 'e1'.repeat(8), D = 'd1'.repeat(8), X = 'f1'.repeat(8);
  const M = [{ id: B, name: 'Budi' }, { id: S, name: 'Sari' }, { id: E, name: 'Eka' }, { id: D, name: 'Dewi' }];
  const peer = (id, name) => ({ id, name, online: true, secure: true, friend: true, fst: 'ok' });
  state = { me: { id: 'me', name: 'Saya', port: 1 }, peers: [peer(B, 'Budi'), peer(S, 'Sari'), peer(E, 'Eka'), peer(D, 'Dewi'), peer(X, 'Xena')], groups: [], messages: [], sending: [], limits: { maxText: 10000 }, call: null,
    calls: [
      { id: 'g1'.repeat(8), peer: B, name: 'Budi', dir: 'out', out: 'done', at: now - 1000, dur: 300, hc: false, group: true, members: M, hcs: [S] },
      { id: 'a1'.repeat(8), peer: X, name: 'Xena', dir: 'out', out: 'done', at: now - 60000, dur: 10, hc: false },
    ] };
  vm.runInContext(inline, ctx); await flush(); await flush();

  // DM dengan anggota: kartu grup tampil dengan daftar peserta
  vm.runInContext(`pickChat('${B}')`, ctx); await flush();
  let m = els.msgs.innerHTML;
  assert((m.match(/class="m call/g) || []).length === 1, 'satu kartu di DM Budi');
  assert(m.includes('Panggilan grup · 5 mnt') && m.includes('↗ Kamu, Budi, Sari +2'), 'judul + daftar peserta: ' + m);
  // DM dengan anggota yang menyembunyikannya (hcs) tidak menampilkan
  vm.runInContext(`pickChat('${S}')`, ctx); await flush();
  assert(!/class="m call/.test(els.msgs.innerHTML), 'DM Sari menyembunyikan kartu (hcs)');
  // DM dengan anggota lain tetap menampilkan
  vm.runInContext(`pickChat('${E}')`, ctx); await flush();
  assert(/class="m call/.test(els.msgs.innerHTML), 'DM Eka menampilkan kartu');
  // bukan anggota: tidak tampil; panggilan 1-1 tetap
  vm.runInContext(`pickChat('${X}')`, ctx); await flush();
  m = els.msgs.innerHTML; assert((m.match(/class="m call/g) || []).length === 1 && m.includes('Panggilan suara') && !m.includes('Panggilan grup'), 'DM non-anggota hanya 1-1');
  ok('kartu grup tampil di DM tiap anggota, hilang di DM yang disembunyikan, tidak bocor ke non-anggota');

  // pratinjau daftar chat
  vm.runInContext("tab = 'teman'; emptyTab = true; render()", ctx);
  const list = els.list.innerHTML;
  assert(/<svg class="ic"[^>]*>.*?<\/svg>Panggilan grup · 5 mnt/.test(list) && !list.includes('📞'), 'pratinjau memuat panggilan grup (ikon telepon svg, bukan emoji)');
  ok('pratinjau daftar chat menampilkan panggilan grup');

  // tab Panggilan
  vm.runInContext("tab = 'calls'; emptyTab = true; render()", ctx);
  const rows = els.list.innerHTML;
  assert((rows.match(/class="item crow"/g) || []).length === 2, 'dua baris: grup + 1-1');
  assert(rows.includes('Budi, Sari, Eka +1') && rows.includes('Grup · 5 mnt'), 'baris grup: nama tanpa Kamu + penanda Grup');
  assert((rows.match(/data-callback=/g) || []).length === 1, 'tombol Telepon lagi hanya di baris 1-1');
  ok('tab Panggilan: baris grup dengan daftar nama, tanpa tombol telepon ulang');

  console.log('\nOK: ' + pass + ' kelompok lulus');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
