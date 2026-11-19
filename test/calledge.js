'use strict';
// Tes 4b: kasus tepi panggilan grup di sisi UI: pemberitahuan peserta keluar/putus/gagal, status peserta tidak bocor ke yang baru, undangan gagal.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8), LEG = (n) => ('b' + n).repeat(8).slice(0, 16);

class FakePC {
  constructor() { this.senders = []; this.remoteDescription = null; this.localDescription = null; this.closed = false; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { const s = { track: t, async replaceTrack(x) { this.track = x; } }; this.senders.push(s); return s; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER-' + FakePC.all.indexOf(this) }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER-' + FakePC.all.indexOf(this) }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { if (d.sdp === 'BAD') throw new Error('sdp rusak'); this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.closed = true; }
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
function sched() {
  let now = 1000, id = 0; const q = new Map();
  return { now: () => now, setTimeout: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (i) => q.delete(i), tick(ms) { now += ms; for (const [i, t] of [...q]) if (t.at <= now) { q.delete(i); t.fn(); } } };
}
function mk(o) {
  o = o || {}; FakePC.all = [];
  const s = sched(), calls = [], renders = [], ended = [], legEnded = [], mics = []; let legSeq = 0;
  const api = new Proxy({}, { get: (_t, n) => async (...a) => {
    calls.push([n, ...a]);
    if (n === 'callStart') return { ok: true, cid: CID };
    if (n === 'callLeg') { if (o.legDelay) await o.legDelay; return o.legRes || { ok: true, cid: LEG(++legSeq) }; }
    return { ok: true };
  } });
  const rtc = { PeerConnection: FakePC, getUserMedia: async () => { const t = { enabled: true, stopped: false, stop() { this.stopped = true; } }; mics.push(t); return { t, getTracks: () => [t], getAudioTracks: () => [t] }; }, makeStream: (tr) => ({ tr }), playRemote: (st) => { calls.push(['playRemote']); return () => calls.push(['stopRemote']); } };
  const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended: (i) => ended.push(i), legEnded: (i) => legEnded.push(i) }, now: s.now, setTimeout: s.setTimeout, clearTimeout: s.clearTimeout });
  return { ctl, s, calls, renders, ended, legEnded, mics, of: (n) => calls.filter((c) => c[0] === n), pcs: () => FakePC.all };
}
// panggilan keluar ke peer1 yang sudah aktif
async function active(o) {
  const m = mk(o); await m.ctl.start('peer1', 'Budi');
  await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'ANS' }); m.pcs()[0].state('connected');
  assert.strictEqual(m.ctl.view().phase, 'active'); return m;
}

const H = { esc: (s) => String(s), avatar: (id) => '[av ' + id + ']', icons: { micOff: 'MICOFF', headOff: 'HEADOFF', mic: 'MIC', head: 'HEAD', phone: 'PH' } };
const badges = (html) => (html.match(/class="cbd (deaf|mute)"/g) || []).length;
async function grup(o) { // A (aku) aktif dengan peer1 dan peer2
  const m = await active(o);
  await m.ctl.addLeg('peer2', 'Ani'); await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'A2' }); m.pcs()[1].state('connected');
  assert.strictEqual(m.ctl.cur.legs.length, 2); return m;
}

(async () => {
  { // 1. teks pemberitahuan
    assert.strictEqual(LC.legText({ name: 'Ani', reason: 'ended' }), 'Ani keluar dari panggilan');
    assert.strictEqual(LC.legText({ name: 'Ani', reason: 'failed', failed: false }), 'Koneksi dengan Ani terputus');
    assert.strictEqual(LC.legText({ name: 'Ani', reason: 'failed', failed: true }), 'Ani gagal tersambung');
    assert.strictEqual(LC.legText({ name: 'Ani', reason: 'rejected' }), 'Ani menolak bergabung');
    assert.strictEqual(LC.legText({ name: 'Ani', reason: 'busy' }), 'Ani sedang dalam panggilan lain');
    assert.strictEqual(LC.legText({ name: 'Ani', reason: 'noanswer' }), 'Ani tidak menjawab');
    assert.strictEqual(LC.legText({ reason: 'ended' }), 'Seorang peserta keluar dari panggilan');
    assert.strictEqual(LC.legText({ name: 'Ani', reason: 'error' }), '', 'galat addLeg dilaporkan pemanggilnya');
    assert.strictEqual(LC.legText(null), '');
    ok('legText: teks per alasan, kosong untuk galat dan null');
  }
  { // 2. peserta keluar / putus: legEnded membawa data yang cukup untuk diberitahukan
    const m = await grup();
    await m.ctl.onEvent({ ev: 'end', cid: LEG(1), room: CID, reason: 'ended', last: false });
    assert.strictEqual(m.legEnded.length, 1); assert.strictEqual(LC.legText(m.legEnded[0]), 'Ani keluar dari panggilan');
    assert.strictEqual(m.ctl.cur.legs.length, 1); assert.strictEqual(m.ended.length, 0, 'ruang tetap jalan');
    const m2 = await grup();
    m2.pcs()[1].state('disconnected'); m2.s.tick(8000);
    assert.strictEqual(LC.legText(m2.legEnded[0]), 'Koneksi dengan Ani terputus');
    const m3 = await active(); await m3.ctl.addLeg('peer2', 'Ani'); m3.pcs()[1].state('failed');
    assert.strictEqual(LC.legText(m3.legEnded[0]), 'Ani gagal tersambung');
    ok('keluar / putus / gagal tersambung menghasilkan pemberitahuan yang tepat, ruang tetap jalan');
  }
  { // 3. hangup sendiri tidak memicu pemberitahuan "peserta keluar"
    const m = await grup(); m.ctl.hangup();
    assert.strictEqual(m.legEnded.length, 0); assert.strictEqual(m.ended.length, 1);
    ok('hangup sendiri: tidak ada pemberitahuan peserta keluar');
  }
  { // 4. status mute/deafen peserta yang keluar tidak bocor ke yang menggantikan
    const m = await grup();
    await m.ctl.onEvent({ ev: 'peerstate', cid: LEG(1), room: CID, peer: 'peer2', muted: true, deafened: true });
    assert.strictEqual(badges(LC.overlayHtml(m.ctl.view(), H)), 1);
    await m.ctl.onEvent({ ev: 'end', cid: LEG(1), room: CID, reason: 'ended', last: false });
    assert.strictEqual(badges(LC.overlayHtml(m.ctl.view(), H)), 0, 'ikon ikut hilang saat peserta keluar');
    await m.ctl.addLeg('peer2', 'Ani'); await m.ctl.onEvent({ ev: 'answer', cid: LEG(2), sdp: 'A3' }); m.pcs()[2].state('connected');
    const v = m.ctl.view().legs.find((x) => x.peer === 'peer2');
    assert.strictEqual(v.muted, false); assert.strictEqual(v.deafened, false, 'bergabung ulang mulai dari status bawaan');
    ok('status peserta hilang saat keluar dan tidak terbawa ketika dia bergabung lagi');
  }
  { // 5. peserta tanpa status di tengah peserta berstatus; status dari kaki yang sudah hilang diabaikan
    const m = await grup();
    await m.ctl.onEvent({ ev: 'end', cid: LEG(1), room: CID, reason: 'ended', last: false });
    const r0 = m.renders.length;
    await m.ctl.onEvent({ ev: 'peerstate', cid: LEG(1), room: CID, peer: 'peer2', muted: true, deafened: false });
    assert.strictEqual(m.ctl.cur.legs.length, 1); assert(m.ctl.cur.legs.every((l) => !l.muted), 'status kiriman terlambat tidak menempel ke peserta lain');
    assert.strictEqual(m.renders.length, r0, 'tidak render ulang tanpa perubahan');
    ok('status terlambat dari kaki yang sudah hilang diabaikan');
  }
  { // 6. kaki terakhir yang tersisa putus: ruang berakhir, tidak ada pemberitahuan ganda
    const m = await grup();
    await m.ctl.onEvent({ ev: 'end', cid: LEG(1), room: CID, reason: 'ended', last: false });
    m.pcs()[0].state('failed');
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended.length, 1);
    ok('semua peserta lain pergi: ruang berakhir sekali');
  }
  console.log(pass + ' kelompok lulus');
})().catch((e) => { console.error(e); process.exit(1); });
