'use strict';
// Tes sesi channel voice di sisi UI (v0.19.0, langkah 7): Controller (WebRTC palsu), layar peserta, dan pemasangan di archne-index.html.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const GID = 'a'.repeat(16), CH = 'c1'.repeat(8), CH2 = 'c2'.repeat(8), LEG = (n) => ('b' + n).repeat(8).slice(0, 16);
const ME = '1'.repeat(16), P1 = '2'.repeat(16), P2 = '3'.repeat(16);

class FakePC {
  constructor() { this.senders = []; this.remoteDescription = null; this.localDescription = null; this.closed = false; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { const s = { track: t, async replaceTrack(x) { this.track = x; } }; this.senders.push(s); return s; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER-' + FakePC.all.indexOf(this) }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER-' + FakePC.all.indexOf(this) }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.closed = true; }
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
function sched() {
  let now = 1000, id = 0; const q = new Map();
  return { now: () => now, setTimeout: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (i) => q.delete(i), tick(ms) { now += ms; for (const [i, t] of [...q]) if (t.at <= now) { q.delete(i); t.fn(); } } };
}
// o.during: dipanggil di dalam api.vcEnter (event yang tiba sebelum jawaban IPC); o.enterRes: jawaban vcEnter; o.micFail
function mk(o) {
  o = o || {}; FakePC.all = [];
  const s = sched(), calls = [], renders = [], ended = [], legEnded = [], mics = []; let legSeq = 0, ctl;
  const api = new Proxy({}, { get: (_t, n) => async (...a) => {
    calls.push([n, ...a]);
    if (n === 'vcEnter') { if (o.during) await o.during(ctl); return o.enterRes || { ok: true }; }
    if (n === 'callLeg') return { ok: true, cid: LEG(++legSeq) };
    if (n === 'callStart') return { ok: true, cid: 'd1'.repeat(8) };
    return { ok: true };
  } });
  const rtc = { PeerConnection: FakePC, getUserMedia: async () => {
    calls.push(['gum']);
    if (o.micFail) { const e = new Error('x'); e.userMsg = 'Izin mikrofon ditolak'; throw e; }
    if (o.micGate) await o.micGate;
    const t = { enabled: true, stopped: false, stop() { this.stopped = true; } }; mics.push(t); return { t, getTracks: () => [t], getAudioTracks: () => [t] };
  }, makeStream: (tr) => ({ tr }), playRemote: () => () => {} };
  ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended: (i) => ended.push(i), legEnded: (i) => legEnded.push(i) }, now: s.now, setTimeout: s.setTimeout, clearTimeout: s.clearTimeout });
  return { ctl, s, calls, renders, ended, legEnded, mics, of: (n) => calls.filter((c) => c[0] === n), names: () => calls.map((c) => c[0]), pcs: () => FakePC.all };
}
const flush = () => new Promise((r) => setImmediate(r));
const enter = async (o) => { const m = mk(o); const r = await m.ctl.enterChannel(GID, CH, 'Ngobrol'); return Object.assign(m, { r }); };

(async () => {
  { // 1. masuk: mikrofon dulu, baru Core; sesi aktif tanpa kaki
    const m = await enter();
    assert.deepStrictEqual(m.r, { ok: true });
    assert.deepStrictEqual(m.names().filter((n) => n === 'gum' || n === 'vcEnter'), ['gum', 'vcEnter'], 'mikrofon sebelum vcEnter');
    assert.deepStrictEqual(m.of('vcEnter')[0], ['vcEnter', GID, CH]);
    const v = m.ctl.view();
    assert.deepStrictEqual(v.vc, { gid: GID, cid: CH, name: 'Ngobrol' }); assert.strictEqual(v.room, CH);
    assert.strictEqual(v.phase, 'active'); assert.strictEqual(v.legs.length, 0); assert(v.since > 0);
    assert.strictEqual(m.ended.length, 0);
    assert.strictEqual(m.of('callStart').length, 0, 'bukan panggilan 1-1');
    ok('enterChannel: mikrofon lebih dulu, lalu vcEnter; sesi langsung aktif walau belum ada kaki');
  }
  { // 2. legneed dan incoming auto: kaki ke anggota channel lewat callLeg(room = id channel)
    const m = await enter();
    await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P1, name: 'Budi', vc: { gid: GID, cid: CH } });
    assert.deepStrictEqual(m.of('callLeg')[0], ['callLeg', CH, P1, 'OFFER-0']);
    await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'A' }); m.pcs()[0].state('connected');
    await m.ctl.onEvent({ ev: 'incoming', cid: LEG(9), room: CH, auto: true, peer: P2, name: 'Ani', sdp: 'OFR', ice: [] });
    assert.deepStrictEqual(m.of('callAnswer')[0], ['callAnswer', LEG(9), 'ANSWER-1']);
    assert.deepStrictEqual(m.ctl.view().legs.map((l) => [l.peer, l.state]), [[P1, 'active'], [P2, 'connecting']]);
    assert.strictEqual(m.mics.length, 1, 'satu mikrofon untuk semua kaki');
    assert.strictEqual(m.pcs()[0].senders[0].track, m.pcs()[1].senders[0].track);
    ok('anggota channel disambung: legneed -> callLeg dengan room = id channel, incoming auto dijawab, mikrofon dipakai bersama');
  }
  { // 3. event legneed yang tiba SEBELUM jawaban vcEnter tetap ditangani (mikrofon dan room sudah siap)
    const m = await enter({ during: (ctl) => ctl.onEvent({ ev: 'legneed', room: CH, peer: P1, name: 'Budi' }) });
    assert.strictEqual(m.of('callLeg').length, 1, 'kaki dibuat walau jawaban IPC belum kembali');
    assert.strictEqual(m.ctl.cur.legs.length, 1);
    const m2 = await enter({ during: (ctl) => ctl.onEvent({ ev: 'incoming', cid: LEG(7), room: CH, auto: true, peer: P2, name: 'Ani', sdp: 'OFR', ice: [] }) });
    assert.strictEqual(m2.of('callAnswer').length, 1);
    ok('legneed / incoming yang mendahului jawaban vcEnter tidak hilang');
  }
  { // 4. channel tidak bubar saat kaki habis: end (last true maupun false), kaki gagal, kaki terakhir putus
    const m = await enter();
    await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P1, name: 'Budi' });
    await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'A' }); m.pcs()[0].state('connected');
    await m.ctl.onEvent({ ev: 'end', cid: LEG(1), room: CH, peer: P1, reason: 'ended', last: true, wasActive: true });
    assert(m.ctl.cur, 'sesi tetap ada'); assert.strictEqual(m.ctl.cur.legs.length, 0); assert.strictEqual(m.ended.length, 0);
    assert.strictEqual(m.legEnded[0].vc, true, 'legEnded ditandai channel');
    assert.strictEqual(LC.legText(m.legEnded[0]), '', 'tidak ada toast per orang di channel');
    await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P2, name: 'Ani' });
    await m.ctl.onEvent({ ev: 'answer', cid: LEG(2), sdp: 'A' }); m.pcs()[1].state('connected');
    m.pcs()[1].state('failed'); await flush();
    assert(m.ctl.cur && m.ctl.cur.legs.length === 0, 'koneksi kaki terakhir gagal: sesi tetap, kakinya saja yang dilepas');
    assert.deepStrictEqual(m.of('callEnd').map((c) => c[1]), [LEG(2)], 'Core diberi tahu kaki itu selesai');
    assert.strictEqual(m.ended.length, 0); assert.strictEqual(m.of('vcLeave').length, 0);
    ok('channel tetap hidup saat sendirian: kaki habis/gagal hanya melepas kakinya, tanpa toast dan tanpa vcLeave');
  }
  { // 5. keluar: hanya vcLeave, tidak callEnd/callLeave; tanpa toast; mikrofon dilepas
    const m = await enter();
    await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P1, name: 'Budi' });
    await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'A' }); m.pcs()[0].state('connected');
    m.ctl.hangup();
    assert.strictEqual(m.ctl.cur, null);
    assert.deepStrictEqual(m.of('vcLeave'), [['vcLeave']]); assert.strictEqual(m.of('callEnd').length, 0); assert.strictEqual(m.of('callLeave').length, 0);
    assert(m.mics[0].stopped, 'mikrofon dimatikan'); assert(m.pcs()[0].closed);
    assert.strictEqual(m.ended[0].vc, true); assert.strictEqual(m.ended[0].local, true);
    assert.strictEqual(LC.endText(m.ended[0]), '', 'keluar sendiri: tanpa toast');
    ok('hangup di channel = vcLeave saja; koneksi dan mikrofon dilepas; tanpa toast');
  }
  { // 6. kegagalan masuk: mikrofon ditolak, Core menolak, panggilan lain berjalan
    let m = await enter({ micFail: true });
    assert.deepStrictEqual(m.r, { ok: false }); assert.strictEqual(m.of('vcEnter').length, 0, 'tanpa mikrofon, Core tidak disentuh');
    assert.strictEqual(m.ended[0].reason, 'mic'); assert.strictEqual(LC.endText(m.ended[0]), 'Izin mikrofon ditolak'); assert.strictEqual(m.ctl.cur, null);
    m = await enter({ enterRes: { ok: false, err: 'Channel sudah penuh (maksimal 8 orang)' } });
    assert.deepStrictEqual(m.r, { ok: false }); assert.strictEqual(m.ctl.cur, null);
    assert.strictEqual(LC.endText(m.ended[0]), 'Channel sudah penuh (maksimal 8 orang)'); assert(m.mics[0].stopped, 'mikrofon dilepas lagi');
    assert.strictEqual(m.of('vcLeave').length, 0, 'Core tidak pernah mencatatku masuk');
    m = mk(); await m.ctl.start('peer1', 'Budi'); m.calls.length = 0;
    assert.deepStrictEqual(await m.ctl.enterChannel(GID, CH, 'Ngobrol'), { ok: false });
    assert.strictEqual(LC.endText(m.ended[m.ended.length - 1]), 'Masih ada panggilan yang berlangsung'); assert.strictEqual(m.calls.length, 0, 'tidak menyentuh mikrofon maupun Core');
    ok('gagal masuk: mikrofon ditolak, Core menolak (mikrofon dilepas), atau sedang menelepon; semua jadi toast dan sesi bersih');
  }
  { // 7. keluar saat menunggu mikrofon / saat menunggu Core
    let release; const gate = new Promise((r) => { release = r; });
    const m = mk({ micGate: gate });
    const p = m.ctl.enterChannel(GID, CH, 'Ngobrol'); await flush();
    assert.strictEqual(m.ctl.view().phase, 'connecting', 'menunggu izin mikrofon');
    m.ctl.hangup(); release(); assert.deepStrictEqual(await p, { ok: false });
    assert.strictEqual(m.of('vcEnter').length, 0); assert(m.mics[0].stopped, 'mikrofon yang baru didapat dilepas');
    let m2; let rel2; const g2 = new Promise((r) => { rel2 = r; });
    m2 = mk({ during: () => g2 });
    const p2 = m2.ctl.enterChannel(GID, CH, 'Ngobrol'); await flush(); await flush();
    m2.ctl.hangup(); rel2(); await p2;
    assert.strictEqual(m2.of('vcLeave').length >= 1, true, 'Core sempat mencatat masuk: dilepas lagi'); assert.strictEqual(m2.ctl.cur, null);
    ok('keluar saat menunggu izin mikrofon atau jawaban Core tidak meninggalkan sisa');
  }
  { // 8. pindah channel dan masuk ulang channel yang sama
    const m = await enter();
    const before = m.calls.length;
    assert.deepStrictEqual(await m.ctl.enterChannel(GID, CH, 'Ngobrol'), { ok: true }); assert.strictEqual(m.calls.length, before, 'channel yang sama: tidak ada panggilan baru');
    assert.deepStrictEqual(await m.ctl.enterChannel(GID, CH2, 'Rapat'), { ok: true });
    assert.deepStrictEqual(m.names().filter((n) => n === 'vcLeave' || n === 'vcEnter'), ['vcEnter', 'vcLeave', 'vcEnter']);
    assert.deepStrictEqual(m.of('vcEnter')[1], ['vcEnter', GID, CH2]); assert.strictEqual(m.ctl.view().vc.name, 'Rapat');
    assert(m.mics[0].stopped && m.mics.length === 2, 'mikrofon lama dilepas, yang baru dipakai');
    assert.strictEqual(m.ended.filter((e) => LC.endText(e)).length, 0, 'pindah channel tanpa toast');
    ok('masuk channel yang sama = tidak berbuat apa-apa; pindah channel = keluar dari yang lama dulu, tanpa toast');
  }
  { // 9. mute / deafen mengabari peserta lewat callMedia(room channel)
    const m = await enter();
    m.ctl.mute(true); assert.deepStrictEqual(m.of('callMedia').pop(), ['callMedia', CH, true, false]);
    assert.strictEqual(m.mics[0].enabled, false);
    m.ctl.deafen(true); assert.deepStrictEqual(m.of('callMedia').pop(), ['callMedia', CH, true, true]);
    m.ctl.deafen(false); m.ctl.mute(false); assert.deepStrictEqual(m.of('callMedia').pop(), ['callMedia', CH, false, false]);
    ok('mute dan deafen di channel: mikrofon mengikuti dan status dikabarkan ke ruang channel');
  }
  { // 9b. bisu dipilih saat dialog mikrofon masih terbuka: diumumkan begitu Core mengenal ruangnya
    let release; const gate = new Promise((r) => { release = r; });
    const m = mk({ micGate: gate });
    const p = m.ctl.enterChannel(GID, CH, 'Ngobrol'); await flush();
    m.ctl.mute(true); release(); await p;
    const names = m.names(), iEnter = names.indexOf('vcEnter'), iMedia = names.lastIndexOf('callMedia');
    assert(iMedia > iEnter, 'callMedia terakhir dikirim sesudah vcEnter'); assert.deepStrictEqual(m.of('callMedia').pop(), ['callMedia', CH, true, false]);
    assert.strictEqual(m.mics[0].enabled, false, 'mikrofon memang bisu sejak awal');
    ok('bisu yang dipilih sebelum masuk diumumkan ulang setelah Core mencatatku di channel');
  }
  { // 10. sinkronisasi dengan Core
    // a) Core sudah tidak mencatatku di channel (dihapus / dikunci / dikeluarkan) -> sesi ditutup dengan pemberitahuan
    let m = await enter();
    m.ctl.sync(null, null); assert(m.ctl.cur, 'snapshot baru (< guard) dibiarkan');
    m.s.tick(LC.SYNC_GUARD_MS + 1); m.ctl.sync(null, { gid: GID, cid: CH }); assert(m.ctl.cur, 'Core masih mencatatku: aman');
    m.ctl.sync(null, null); assert.strictEqual(m.ctl.cur, null);
    assert.strictEqual(m.ended[0].vc, true); assert.strictEqual(m.ended[0].local, false); assert(/channel dihapus, dikunci/.test(LC.endText(m.ended[0])));
    assert.strictEqual(m.of('vcLeave').length, 0, 'Core sudah melepasku, tidak perlu vcLeave');
    // b) kaki yang sudah hilang di Core dilepas, sesi tetap
    m = await enter();
    await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P1, name: 'Budi' }); await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'A' }); m.pcs()[0].state('connected');
    m.s.tick(LC.SYNC_GUARD_MS + 1);
    m.ctl.sync(null, { gid: GID, cid: CH }); assert.strictEqual(m.ctl.cur.legs.length, 0); assert(m.ctl.cur, 'sesi tetap');
    // c) channel lain yang dicatat Core -> sesiku usang
    m = await enter(); m.s.tick(LC.SYNC_GUARD_MS + 1); m.ctl.sync(null, { gid: GID, cid: CH2 }); assert.strictEqual(m.ctl.cur, null);
    // d) halaman dimuat ulang: Core mengira aku di channel tapi tidak ada media di sini -> dilepas
    m = mk(); m.ctl.sync(null, { gid: GID, cid: CH }); assert.deepStrictEqual(m.of('vcLeave'), [['vcLeave']]);
    m = mk(); m.ctl.sync({ cid: LEG(1), room: CH, peer: P1, name: 'B', dir: 'out', state: 'active', vc: { gid: GID, cid: CH } }, { gid: GID, cid: CH });
    assert.strictEqual(m.of('vcLeave').length, 1); assert.strictEqual(m.of('callEnd').length, 0, 'cukup keluar dari channel, bukan menutup satu kaki');
    // e) tanpa channel dan tanpa sesi: tidak berbuat apa-apa
    m = mk(); m.ctl.sync(null, null); assert.strictEqual(m.calls.length, 0);
    ok('sync: Core melepasku -> sesi ditutup; kaki hilang dilepas tanpa menutup sesi; sisa Core tanpa media -> vcLeave');
  }
  { // 11. layar channel
    const h = { esc: (x) => String(x).replace(/</g, '&lt;'), avatar: (id) => '<i>' + id.slice(0, 1) + '</i>', icons: { phone: 'P', mic: 'M', micOff: 'MO', head: 'H', headOff: 'HO', add: 'ADD', speaker: 'S' }, meId: ME, here: [{ id: ME, name: 'Saya', me: true }, { id: P1, name: 'Budi' }, { id: P2, name: 'Ani' }] };
    const base = { vc: { gid: GID, cid: CH, name: 'Santai <b>' }, room: CH, phase: 'active', since: Date.now(), muted: false, deafened: false, noise: 'standard', legs: [{ peer: P1, name: 'Budi', state: 'active', muted: true, deafened: false }], invites: [], members: [] };
    let out = LC.overlayHtml(base, h);
    assert(out.includes('Santai &lt;b>'), 'nama channel lewat esc()'); assert(!out.includes('<b>'), 'tidak ada tag mentah');
    assert(out.includes('Channel suara · 3 orang'), 'jumlah orang'); assert(out.includes('>Kamu<'), 'aku di daftar');
    assert(/data-peer="[2]{16}"[^]*Tersambung/.test(out), 'kaki aktif: Tersambung'); assert(out.includes('cbd mute'), 'lencana mik mati milik Budi');
    assert(/data-peer="[3]{16}"[^]*Menyambung…/.test(out), 'hadir tapi belum tersambung: Menyambung…');
    assert(!out.includes('data-cact="add"'), 'tidak ada tombol Tambah orang di channel'); assert(out.includes('data-cact="hang"') && />Keluar</.test(out), 'tombol Keluar'); assert(!/>Akhiri</.test(out));
    assert(out.includes('data-cact="mute"') && out.includes('data-cact="deafen"') && out.includes('data-cnoise='), 'mute, deafen, peredam bising tetap ada');
    out = LC.overlayHtml(Object.assign({}, base, { legs: [], muted: true }), Object.assign({}, h, { here: [{ id: ME, name: 'Saya', me: true }] }));
    assert(out.includes('menunggu orang lain masuk'), 'sendirian: menunggu'); assert(out.includes('cbd mute'), 'lencana mik matiku sendiri');
    out = LC.overlayHtml(Object.assign({}, base, { phase: 'connecting', legs: [] }), h);
    assert(out.includes('Menyambungkan…'), 'menunggu izin mikrofon');
    ok('layar channel: nama di-escape, aku + yang tersambung + yang menunggu, lencana mik, Keluar tanpa Tambah orang, menunggu bila sendirian');
  }

  { // 11b. ganti nama channel: hanya sesi channel, hanya bila berubah
    const m = await enter(); let n = m.renders.length;
    assert.strictEqual(m.ctl.setChannelName('Ngobrol'), false, 'nama sama: tidak ada render ulang'); assert.strictEqual(m.renders.length, n);
    assert.strictEqual(m.ctl.setChannelName(''), false, 'nama kosong diabaikan');
    assert.strictEqual(m.ctl.setChannelName('Rapat'), true); assert.strictEqual(m.ctl.view().vc.name, 'Rapat'); assert(m.renders.length > n, 'layar dirender ulang');
    assert.deepStrictEqual(m.of('vcEnter').length, 1, 'tidak masuk ulang');
    const solo = mk(); assert.strictEqual(solo.ctl.setChannelName('X'), false, 'tanpa sesi: diabaikan');
    ok('setChannelName: mengganti judul sesi channel, hanya bila berubah; tanpa sesi diabaikan');
  }

  // 12. pemasangan di archne-index.html: skrip asli di vm dengan LanCall asli dan WebRTC palsu
  {
    const html = require('./_src').htmlSrc();
    const inline = require('./_src').inlineJs();
    const els = {};
    const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: false, style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener() {}, focus() {}, requestSubmit() {} });
    const calls = []; let state, updCb, callCb;
    const api = new Proxy({}, { get: (_t, n) => {
      if (n === 'state') return async () => state;
      if (n === 'onUpdate') return (cb) => { updCb = cb; };
      if (n === 'onCall') return (cb) => { callCb = cb; };
      if (n === 'pickFiles') return async () => [];
      if (n === 'pathOf') return () => '';
      return async (...a) => { calls.push([n, ...a]); return { ok: true }; };
    } });
    FakePC.all = [];
    const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null, body: { classList: { add() {}, remove() {} } } };
    const track = { enabled: true, stop() {} };
    const win = { api, addEventListener: () => {}, RTCPeerConnection: FakePC, LanCall: LC, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } } };
    const ctx = { window: win, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
      localStorage: { getItem: () => null, setItem() {} } };
    vm.createContext(ctx);
    const ch = (id, name, o) => Object.assign({ id, name, by: P1, locked: false, allow: [], ts: 1, canJoin: true, canManage: false, here: [] }, o);
    state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [{ id: P1, name: 'Budi', online: true, secure: true }], limits: { maxText: 10000 }, sending: [], messages: [], vc: null, call: null,
      groups: [{ id: GID, name: 'Tim', creator: P1, admins: [], members: [{ id: ME, name: 'Saya' }, { id: P1, name: 'Budi' }], epoch: 1, removed: false, leaving: [], channels: [ch(CH, 'Ngobrol', { here: [{ id: P1, name: 'Budi' }] })] }] };
    vm.runInContext(inline, ctx);
    await flush(); await flush();
    vm.runInContext("cur = 'g:" + GID + "'; render();", ctx);
    const click = async (act, cid) => els.vcbar.onclick({ target: { closest: (sel) => (sel === '[data-vact]' ? { dataset: { vact: act, cid } } : null) }, stopPropagation() {} });
    calls.length = 0; await click('enter', CH);
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'vcEnter'), [['vcEnter', GID, CH]], 'Masuk lewat Controller (mikrofon dulu, lalu vcEnter)');
    const ov = els.callov;
    assert.strictEqual(ov.style.display, 'flex', 'layar channel tampil'); assert(ov.innerHTML.includes('Ngobrol') && ov.innerHTML.includes('Budi'), 'nama channel dan penghuni dari state');
    assert(ov.innerHTML.includes('>Kamu<'));
    // presence berubah -> layar mengikuti
    state.vc = { gid: GID, cid: CH }; state.groups[0].channels[0].here = [{ id: ME, name: 'Saya', me: true }, { id: P1, name: 'Budi' }, { id: P2, name: 'Cici' }];
    await updCb(); await flush();
    assert(ov.innerHTML.includes('Cici'), 'peserta baru muncul di layar tanpa menunggu kaki');
    // channel diganti namanya saat aku di dalamnya: judul layar ikut berubah
    state.groups[0].channels[0].name = 'Rapat <b>';
    await updCb(); await flush();
    assert(ov.innerHTML.includes('Rapat &lt;b&gt;') && !ov.innerHTML.includes('Ngobrol'), 'judul layar mengikuti nama baru (di-escape)');
    // keluar dari layar channel
    calls.length = 0; await ov.onclick({ target: { classList: { contains: () => false }, closest: (sel) => (sel === '[data-cact]' ? { dataset: { cact: 'hang' } } : null) } });
    assert.deepStrictEqual(calls.filter((c) => /^vc|^call/.test(c[0])), [['vcLeave']]); assert.strictEqual(ov.style.display, 'none');
    ok('archne-index.html: Masuk membuka layar channel lewat Controller, layar mengikuti presence dan ganti nama, Akhiri = vcLeave');
  }

  console.log('\n' + pass + ' skenario lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
