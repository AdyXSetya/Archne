'use strict';
// Petunjuk TURN tidak boleh muncul bila panggilan tersambung; hanya bila macet (10 dtk belum aktif) atau gagal, dan hanya sekali.
const assert = require('assert');
const LC = require('../renderer/archne-call');
const flush = () => new Promise((r) => setImmediate(r));
class FakePC {
  constructor() { this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack() {} async createOffer() { return { type: 'offer', sdp: 'O' }; } async setLocalDescription(d) { this.localDescription = d; } async setRemoteDescription() {} async addIceCandidate() {} close() {}
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
function sched() { let now = 1000, id = 0; const q = new Map(); return { now: () => now, setTimeout: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (i) => q.delete(i), tick(ms) { now += ms; for (const [i, t] of [...q]) if (t.at <= now) { q.delete(i); t.fn(); } } }; }
function mk(turn) {
  FakePC.all = []; const s = sched(), notices = [];
  const api = new Proxy({}, { get: (_t, n) => async () => (n === 'turnIce' ? Object.assign({ ok: true, iceServers: [], wan: true }, turn) : n === 'callStart' ? { ok: true, cid: 'a1'.repeat(8) } : { ok: true }) });
  const rtc = { PeerConnection: FakePC, getUserMedia: async () => { const t = { enabled: true, stop() {} }; return { getTracks: () => [t], getAudioTracks: () => [t] }; }, makeStream: (tr) => ({ tr }), playRemote: () => () => {} };
  const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended() {}, notice: (t) => notices.push(t) }, now: s.now, setTimeout: s.setTimeout, clearTimeout: s.clearTimeout });
  return { ctl, s, notices };
}
(async () => {
  // tersambung cepat: tidak ada petunjuk walau TURN belum diatur
  let m = mk({ provider: 'none' }); await m.ctl.start('b'.repeat(16), 'Budi'); await flush();
  m.s.tick(3000); FakePC.all[0].state('connected'); m.s.tick(60000);
  assert.deepStrictEqual(m.notices, [], 'tersambung: tanpa petunjuk');
  // macet 10 dtk: petunjuk sekali
  m = mk({ provider: 'none' }); await m.ctl.start('b'.repeat(16), 'Budi'); await flush();
  m.s.tick(9000); assert.strictEqual(m.notices.length, 0, 'belum 10 dtk'); m.s.tick(2000); assert.strictEqual(m.notices.length, 1); assert(/TURN belum diatur/.test(m.notices[0]));
  FakePC.all[0].state('failed'); assert.strictEqual(m.notices.length, 1, 'tidak diulang');
  // gagal sebelum 10 dtk, TURN gagal diambil: petunjuk "tidak bisa dihubungi"
  m = mk({ provider: 'cloudflare', err: 'Waktu habis' }); await m.ctl.start('b'.repeat(16), 'Budi'); await flush();
  FakePC.all[0].state('failed'); assert.strictEqual(m.notices.length, 1); assert(/tidak bisa dihubungi/.test(m.notices[0]));
  // TURN beres (tanpa err) atau peer LAN: tidak pernah ada petunjuk
  m = mk({ provider: 'cloudflare' }); await m.ctl.start('b'.repeat(16), 'Budi'); await flush(); m.s.tick(20000); FakePC.all[0].state('failed');
  assert.deepStrictEqual(m.notices, []);
  m = mk({ wan: false, provider: undefined }); await m.ctl.start('b'.repeat(16), 'Budi'); await flush(); m.s.tick(20000);
  assert.deepStrictEqual(m.notices, []);
  console.log('  OK  petunjuk TURN: hanya saat macet/gagal, sekali, tidak bila tersambung');
})().catch((e) => { console.error(e); process.exit(1); });
