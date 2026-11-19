'use strict';
// Tes sesi channel voice publik di sisi UI (v0.20.0, pvch7): Controller.enterPublic (WebRTC palsu), PIN salah, keluar, sinkron, dikeluarkan,
// layar telpon / minimize yang dipakai ulang, dan pemasangan di archne-index.html.
const fs = require('fs'), path = require('path'), assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CH = 'c1'.repeat(8), CH2 = 'c2'.repeat(8), GID = 'a'.repeat(16), LEG = (n) => ('b' + n).repeat(8).slice(0, 16);
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
// o.enterRes: jawaban pvEnter; o.during: dipanggil di dalam pvEnter; o.micFail
function mk(o) {
  o = o || {}; FakePC.all = [];
  const s = sched(), calls = [], ended = [], legEnded = [], mics = []; let legSeq = 0, ctl;
  const api = new Proxy({}, { get: (_t, n) => async (...a) => {
    calls.push([n, ...a]);
    if (n === 'pvEnter') { if (o.during) await o.during(ctl); return typeof o.enterRes === 'function' ? o.enterRes(...a) : (o.enterRes || { ok: true }); }
    if (n === 'callLeg') return { ok: true, cid: LEG(++legSeq) };
    if (n === 'callStart') return { ok: true, cid: 'd1'.repeat(8) };
    return { ok: true };
  } });
  const rtc = { PeerConnection: FakePC, getUserMedia: async () => {
    calls.push(['gum']);
    if (o.micFail) { const e = new Error('x'); e.userMsg = 'Izin mikrofon ditolak'; throw e; }
    const t = { enabled: true, stopped: false, stop() { this.stopped = true; } }; mics.push(t); return { t, getTracks: () => [t], getAudioTracks: () => [t] };
  }, makeStream: (tr) => ({ tr }), playRemote: () => () => {} };
  ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended: (i) => ended.push(i), legEnded: (i) => legEnded.push(i) }, now: s.now, setTimeout: s.setTimeout, clearTimeout: s.clearTimeout });
  return { ctl, s, calls, ended, legEnded, mics, of: (n) => calls.filter((c) => c[0] === n), names: () => calls.map((c) => c[0]), pcs: () => FakePC.all };
}
const flush = () => new Promise((r) => setImmediate(r));
const enter = async (o, pin) => { const m = mk(o); const r = await m.ctl.enterPublic(CH, 'Santai', pin); return Object.assign(m, { r }); };
const J = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  { // 1. masuk: mikrofon dulu, baru pvEnter(cid, pin); sesi aktif tanpa kaki; bukan voice grup / telpon 1-1
    const m = await enter({}, '123456');
    assert.deepStrictEqual(m.r, { ok: true });
    assert.deepStrictEqual(m.names().filter((n) => n === 'gum' || n === 'pvEnter'), ['gum', 'pvEnter'], 'mikrofon sebelum pvEnter');
    assert.deepStrictEqual(J(m.of('pvEnter')[0]), ['pvEnter', CH, '123456']);
    const v = m.ctl.view();
    assert.deepStrictEqual(J(v.vc), { gid: '', cid: CH, name: 'Santai', pv: true }); assert.strictEqual(v.room, CH);
    assert.strictEqual(v.phase, 'active'); assert.strictEqual(v.legs.length, 0); assert(v.since > 0);
    assert.strictEqual(m.of('vcEnter').length + m.of('callStart').length, 0);
    assert.strictEqual(m.ended.length, 0);
    ok('enterPublic: mikrofon lebih dulu, lalu pvEnter(cid, pin); sesi langsung aktif, ditandai pv');
  }
  { // 2. channel gratis / pemilik: tanpa PIN -> undefined, bukan string kosong
    const m = await enter({}, '');
    assert.strictEqual(m.of('pvEnter')[0][1], CH);
    assert.strictEqual(m.of('pvEnter')[0][2], undefined, 'PIN kosong dikirim sebagai undefined');
    ok('tanpa PIN: pvEnter menerima undefined');
  }
  { // 3. legneed dan incoming auto: kaki ke anggota lewat callLeg(room = id channel); event yang mendahului jawaban pvEnter tidak hilang
    const m = await enter({ during: (ctl) => ctl.onEvent({ ev: 'legneed', room: CH, peer: P1, name: 'Budi', pv: { cid: CH } }) });
    assert.deepStrictEqual(J(m.of('callLeg')[0]), ['callLeg', CH, P1, 'OFFER-0']);
    await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'A' }); m.pcs()[0].state('connected');
    await m.ctl.onEvent({ ev: 'incoming', cid: LEG(9), room: CH, auto: true, peer: P2, name: 'Ani', sdp: 'OFR', ice: [] });
    assert.deepStrictEqual(J(m.of('callAnswer')[0]), ['callAnswer', LEG(9), 'ANSWER-1']);
    assert.deepStrictEqual(m.ctl.view().legs.map((l) => [l.peer, l.state]), [[P1, 'active'], [P2, 'connecting']]);
    assert.strictEqual(m.mics.length, 1, 'satu mikrofon untuk semua kaki');
    ok('anggota channel publik disambung seperti channel grup (legneed, incoming auto, satu mikrofon)');
  }
  { // 4. PIN salah: { ok:false, wrong:true }, sesi tertutup tanpa toast, mikrofon dilepas, Core tidak diminta keluar
    const m = await enter({ enterRes: { ok: false, err: 'PIN salah', code: 'pin' } }, '000000');
    assert.deepStrictEqual(J(m.r), { ok: false, wrong: true });
    assert.strictEqual(m.ctl.cur, null, 'tidak ada keadaan setengah masuk');
    assert.strictEqual(m.ended.length, 1); assert.strictEqual(m.ended[0].local, true); assert.strictEqual(LC.endText(m.ended[0]), '', 'PIN salah ditampilkan UI di dialog, bukan toast');
    assert(m.mics[0].stopped, 'mikrofon dilepas');
    assert.strictEqual(m.of('pvLeave').length, 0);
    const m2 = await enter({ enterRes: { ok: false, err: 'PIN salah' } }, '1'); // tanpa code (Core lama / jalur HTTP): teks galat tetap dikenali
    assert.strictEqual(m2.r.wrong, true);
    ok('PIN salah: wrong:true, sesi tertutup, mikrofon dilepas, tanpa toast');
  }
  { // 5. galat lain (penuh, ada panggilan lain, channel hilang): toast lewat ended, wrong tidak diset
    const m = await enter({ enterRes: { ok: false, err: 'Channel sudah penuh (maksimal 16 orang)' } }, '123456');
    assert.deepStrictEqual(J(m.r), { ok: false });
    assert.strictEqual(m.ended[0].reason, 'error'); assert.strictEqual(LC.endText(m.ended[0]), 'Channel sudah penuh (maksimal 16 orang)');
    assert.strictEqual(m.ctl.cur, null); assert(m.mics[0].stopped);
    const mm = await enter({ micFail: true });
    assert.deepStrictEqual(J(mm.r), { ok: false }); assert.strictEqual(mm.ended[0].reason, 'mic'); assert.strictEqual(mm.of('pvEnter').length, 0, 'tanpa mikrofon: Core tidak disentuh');
    ok('galat lain dan mikrofon ditolak: dilaporkan lewat ended, Core tidak dihadirkan tanpa audio');
  }
  { // 6. keluar: hangup -> pvLeave (bukan vcLeave), tanpa toast
    const m = await enter();
    m.ctl.hangup(); await flush();
    assert.strictEqual(m.ctl.cur, null);
    assert.strictEqual(m.of('pvLeave').length, 1); assert.strictEqual(m.of('vcLeave').length, 0);
    assert.strictEqual(LC.endText(m.ended[0]), '');
    assert(m.mics[0].stopped);
    ok('hangup di sesi publik memanggil pvLeave dan tidak menampilkan toast');
  }
  { // 7. sudah di channel yang sama: tidak masuk dua kali; pindah channel publik: lepas yang lama dulu
    const m = await enter();
    assert.deepStrictEqual(J(await m.ctl.enterPublic(CH, 'Santai')), { ok: true });
    assert.strictEqual(m.of('pvEnter').length, 1);
    const r = await m.ctl.enterPublic(CH2, 'Rapat', '123456');
    assert.deepStrictEqual(J(r), { ok: true });
    assert.deepStrictEqual(m.names().filter((n) => n === 'pvLeave' || n === 'pvEnter'), ['pvEnter', 'pvLeave', 'pvEnter']);
    assert.strictEqual(m.ctl.view().room, CH2); assert.strictEqual(m.ended.filter((x) => !x.local).length, 0, 'pindah tanpa pemberitahuan');
    ok('channel yang sama tidak dimasuki dua kali; pindah channel publik melepas yang lama tanpa toast');
  }
  { // 8. satu panggilan sekaligus: telpon 1-1 / channel grup menolak; dari channel publik ke channel grup memakai pvLeave
    const m = mk(); await m.ctl.start(P1, 'Budi');
    const r = await m.ctl.enterPublic(CH, 'Santai');
    assert.deepStrictEqual(J(r), { ok: false }); assert.strictEqual(m.of('pvEnter').length, 0); assert.strictEqual(m.ended.pop().err, 'Masih ada panggilan yang berlangsung');
    const g = mk(); await g.ctl.enterChannel(GID, CH2, 'Grup');
    const r2 = await g.ctl.enterPublic(CH, 'Santai');
    assert.deepStrictEqual(J(r2), { ok: false }); assert.strictEqual(g.of('pvEnter').length, 0); assert(/channel suara/.test(g.ended.pop().err));
    assert.strictEqual(g.ctl.view().vc.cid, CH2, 'sesi grup tidak terganggu');
    const p = await enter(); await p.ctl.enterChannel(GID, CH2, 'Grup');
    assert.strictEqual(p.of('pvLeave').length, 1); assert.strictEqual(p.of('vcLeave').length, 0, 'sesi publik dilepas dengan pvLeave');
    assert.strictEqual(p.of('vcEnter').length, 1); assert.strictEqual(J(p.ctl.view().vc).pv, undefined);
    ok('satu panggilan sekaligus: telpon / channel grup menolak channel publik; publik -> grup melepas lewat pvLeave');
  }
  { // 9. sinkron dengan Core: pv.me sama = tetap; beda / kosong = ditutup setelah masa tenggang; tidak ada media tapi Core mengira di channel = pvLeave
    const m = await enter();
    m.ctl.sync(null, null, CH); assert(m.ctl.cur, 'pv.me cocok');
    m.ctl.sync(null, null, null); assert(m.ctl.cur, 'masih dalam masa tenggang');
    m.s.tick(LC.SYNC_GUARD_MS + 1);
    m.ctl.sync(null, null, CH); assert(m.ctl.cur, 'cocok setelah tenggang');
    m.ctl.sync(null, null, CH2); assert.strictEqual(m.ctl.cur, null, 'Core catat channel lain: sesi ditutup');
    const e = mk(); e.ctl.sync(null, null, CH);
    assert.strictEqual(e.of('pvLeave').length, 1, 'halaman dimuat ulang: Core melepas channel tanpa media');
    const v = mk(); v.ctl.sync(null, { gid: GID, cid: CH2 }, null); assert.strictEqual(v.of('vcLeave').length, 1); assert.strictEqual(v.of('pvLeave').length, 0);
    const n = await enter(); n.s.tick(LC.SYNC_GUARD_MS + 1); n.ctl.sync(null, { gid: GID, cid: CH }, null); // vc di Core tapi aku di channel publik: bukan milikku
    assert.strictEqual(n.ctl.cur, null, 'pv.me kosong -> sesi publik ditutup');
    ok('sync: sesi publik mengikuti state().pv.me; halaman yatim dilepas lewat pvLeave');
  }
  { // 10. dikeluarkan Core (dihapus / dikunci / PIN diganti): sesi ditutup seketika, tanpa memanggil Core lagi, tanpa toast ganda
    const m = await enter();
    assert.strictEqual(m.ctl.pvKicked(CH2), false, 'channel lain diabaikan'); assert(m.ctl.cur);
    assert.strictEqual(m.ctl.pvKicked(CH), true);
    assert.strictEqual(m.ctl.cur, null); assert(m.mics[0].stopped);
    assert.strictEqual(m.of('pvLeave').length, 0, 'Core sudah melepas');
    assert.strictEqual(LC.endText(m.ended[0]), '');
    // ditutup lewat sync (bukan lokal): channel publik tidak menambah toast generik karena pvkick sudah menjelaskan alasannya
    assert.strictEqual(LC.endText({ reason: 'ended', vc: true, pv: true, local: false }), '');
    assert(/channel dihapus/.test(LC.endText({ reason: 'ended', vc: true, local: false })), 'channel grup tetap memberi tahu');
    const g = mk(); await g.ctl.enterChannel(GID, CH, 'G'); assert.strictEqual(g.ctl.pvKicked(CH), false, 'sesi grup tidak ikut tertutup');
    ok('pvKicked menutup sesi publik seketika tanpa memanggil Core; sesi grup tidak terpengaruh');
  }
  { // 11. layar telpon dipakai ulang: layar channel, minimize, tombol Keluar
    const m = await enter(); m.ctl.view();
    const v = m.ctl.view();
    const h = { esc: (x) => String(x), avatar: () => '', icons: { phone: 'P', mic: 'M', micOff: 'X', speaker: 'S', chev: 'v' }, meId: ME, here: [{ id: P1, name: 'Budi' }] };
    assert(LC.canMinimize(v), 'channel publik boleh dikecilkan');
    const full = LC.overlayHtml(v, h);
    assert(full.includes('Santai') && full.includes('Channel suara') && full.includes('Budi') && full.includes('Keluar') && !full.includes('Tambah orang'), 'layar channel: nama, peserta, Keluar, tanpa Tambah orang');
    const mini = LC.overlayHtml(v, Object.assign({ minimized: true }, h));
    assert(mini.includes('cmb') && mini.includes('Santai') && mini.includes('Keluar'), 'bar kecil: nama channel + Keluar');
    assert.strictEqual(LC.legText({ reason: 'failed', vc: true }), '', 'orang datang-pergi di channel tidak ditoast');
    ok('layar telpon, minimize, dan bar kecil dipakai ulang untuk channel publik');
  }
  { // 12. pemasangan di archne-index.html
    const html = require('./_src').htmlSrc();
    assert(/callCtl\.sync\(S\.call, S\.vc, S\.pv && S\.pv\.me \? S\.pv\.me : null\)/.test(html), 'sync membawa pv.me');
    assert(/window\.api\.onPvKick\(\(ev\) => \{\s*if \(callCtl && typeof callCtl\.pvKicked === 'function' && ev\) callCtl\.pvKicked\(ev\.cid\)/.test(html), 'pvkick menutup sesi');
    assert(/here: v && v\.vc \? vcHere\(v\.vc\) : null/.test(html) && /function vcHere\(vc\) \{ if \(vc\.pv\)/.test(html), 'peserta layar telpon untuk channel publik');
    assert(!/belum tersedia di versi ini/.test(html), 'tombol Masuk tidak lagi berupa placeholder');
    assert(/callCtl\.enterPublic\(c\.id, c\.name, pin \|\| ''\)/.test(html));
    ok('archne-index.html: sync, pvkick, nama/peserta layar telpon, dan Masuk tersambung ke Controller');
  }
  console.log(pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); });
