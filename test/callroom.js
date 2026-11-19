'use strict';
// Tes bentuk ruang + kaki di Controller (Step 2b-1): panggilan 1-1 = ruang dengan satu kaki; perilaku 1-1 tidak berubah.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8);

class FakePC {
  constructor() { this.senders = []; this.remoteDescription = null; this.localDescription = null; this.closed = false; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { const s = { track: t, async replaceTrack(x) { this.track = x; } }; this.senders.push(s); return s; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.closed = true; }
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
function mk() {
  FakePC.all = [];
  const calls = [], renders = [], ended = [];
  const api = new Proxy({}, { get: (_t, n) => async (...a) => { calls.push([n, ...a]); return n === 'callStart' ? { ok: true, cid: CID } : { ok: true }; } });
  const rtc = { PeerConnection: FakePC, getUserMedia: async () => { const t = { enabled: true, stop() { this.stopped = true; } }; return { t, getTracks: () => [t], getAudioTracks: () => [t] }; }, makeStream: (tr) => ({ tr }), playRemote: () => () => {} };
  const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended: (i) => ended.push(i) } });
  return { ctl, calls, renders, ended, names: () => calls.map((c) => c[0]) };
}
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  { // keluar: satu kaki, medan ruang menunjuk kaki pertama
    const m = mk(); await m.ctl.start('peer1', 'Budi');
    const c = m.ctl.cur;
    assert.strictEqual(c.legs.length, 1); assert.strictEqual(c.cid, CID); assert.strictEqual(c.room, CID); assert.strictEqual(c.legs[0].cid, CID);
    assert.strictEqual(c.legs[0].peer, 'peer1'); assert.strictEqual(c.pc, c.legs[0].pc); assert(c.pc);
    assert.deepStrictEqual(m.ctl.view().legs, [{ cid: CID, peer: 'peer1', name: 'Budi', dir: 'out', state: 'dialing', video: false, muted: false, deafened: false }]);
    await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'ANS' }); assert.strictEqual(m.ctl.view().legs[0].state, 'connecting');
    c.pc.state('connected'); assert.strictEqual(m.ctl.view().phase, 'active'); assert.strictEqual(m.ctl.view().legs[0].state, 'active');
    assert.strictEqual(m.names().filter((n) => n === 'callConnected').length, 1, 'callConnected sekali per kaki');
    ok('1-1 keluar: ruang dengan satu kaki, state kaki mengikuti koneksi');
  }
  { // event untuk kaki lain diabaikan; hangup mengakhiri tiap kaki dan melepas mikrofon
    const m = mk(); await m.ctl.start('peer1', 'Budi'); const c = m.ctl.cur, pc = c.pc, mic = c.stream.t;
    await m.ctl.onEvent({ ev: 'end', cid: 'b2'.repeat(8), reason: 'ended' }); assert(m.ctl.cur, 'cid asing tidak menutup ruang');
    m.ctl.hangup(); assert.strictEqual(m.ctl.cur, null); assert(pc.closed && mic.stopped);
    assert.deepStrictEqual(m.calls.filter((x) => x[0] === 'callEnd'), [['callEnd', CID]]); assert.strictEqual(m.ended[0].reason, 'cancelled');
    ok('hangup menutup kaki dan mikrofon, callEnd per kaki; event kaki asing diabaikan');
  }
  { // masuk: terima lewat kaki pertama
    const m = mk();
    await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer2', name: 'Ani', sdp: 'OFR', ice: ['{"candidate":"x"}'] });
    assert.strictEqual(m.ctl.view().canAccept, true); assert.strictEqual(m.ctl.view().legs[0].state, 'ringing');
    await m.ctl.onEvent({ ev: 'incoming', cid: 'c3'.repeat(8), peer: 'peer3', name: 'Cici', sdp: 'OFR' });
    assert.deepStrictEqual(m.calls.find((x) => x[0] === 'callReject'), ['callReject', 'c3'.repeat(8)], 'tawaran kedua ditolak otomatis');
    assert.deepStrictEqual(await m.ctl.accept(), { ok: true });
    assert.strictEqual(m.calls.find((x) => x[0] === 'callAnswer')[1], CID); assert.strictEqual(m.ctl.cur.legs[0].pc.remoteDescription.sdp, 'OFR');
    m.ctl.reject(); // bukan lagi 'ringing': diabaikan
    assert(m.ctl.cur);
    ok('1-1 masuk: terima lewat kaki pertama, tawaran kedua ditolak, reject setelah terima diabaikan');
  }
  console.log('\n' + pass + ' tes ruang/kaki Controller OK');
})().catch((e) => { console.error(e); process.exit(1); });
