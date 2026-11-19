'use strict';
// Tes Controller banyak kaki (Step 2b-2): tambah kaki, kaki masuk otomatis, tutup satu kaki, keluar sekaligus, mikrofon bersama.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8), LEG = (n) => ('b' + n).repeat(8).slice(0, 16), ROOMX = 'f9'.repeat(8);

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
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  { // 1. tambah kaki: PeerConnection baru, mikrofon yang sama, sinyal lewat callLeg
    const m = await active();
    const r = await m.ctl.addLeg('peer2', 'Ani');
    assert.deepStrictEqual(r, { ok: true, cid: LEG(1) });
    assert.deepStrictEqual(m.of('callLeg')[0], ['callLeg', CID, 'peer2', 'OFFER-1']);
    assert.strictEqual(m.pcs().length, 2); assert.strictEqual(m.ctl.cur.legs.length, 2);
    assert.strictEqual(m.pcs()[0].senders[0].track, m.pcs()[1].senders[0].track, 'satu trek mikrofon untuk semua kaki');
    assert.strictEqual(m.mics.length, 1, 'tidak ada getUserMedia baru');
    assert.deepStrictEqual(m.ctl.view().legs.map((l) => [l.peer, l.state]), [['peer1', 'active'], ['peer2', 'dialing']]);
    await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'ANS2' }); assert.strictEqual(m.ctl.view().legs[1].state, 'connecting');
    m.pcs()[1].state('connected'); assert.strictEqual(m.ctl.view().legs[1].state, 'active');
    assert.deepStrictEqual(m.of('callConnected').map((c) => c[1]), [CID, LEG(1)]);
    // regresi: ruang yang sudah aktif tetap aktif dan durasinya tidak diulang saat kaki baru dijawab/tersambung
    { const m2 = await active(); m2.s.tick(60000); const since = m2.ctl.view().since;
      await m2.ctl.addLeg('peer2', 'Ani'); await m2.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'ANS2' });
      assert.strictEqual(m2.ctl.view().phase, 'active', 'jawaban kaki baru tidak memundurkan fase ruang');
      m2.s.tick(2000); m2.pcs()[1].state('connected');
      assert.strictEqual(m2.ctl.view().since, since, 'since tidak diset ulang'); assert.strictEqual(m2.ctl.elapsed(), 62); }
    ok('addLeg: kaki baru dengan PC sendiri, mikrofon dipakai bersama, callLeg dengan tawaran, callConnected per kaki');
  }
  { // 2. penjaga addLeg
    let m = mk(); assert.strictEqual((await m.ctl.addLeg('peer2', 'Ani')).ok, false, 'tanpa panggilan');
    m = await active(); assert.strictEqual((await m.ctl.addLeg('peer1', 'Budi')).ok, false, 'sudah ada kakinya');
    m = await active({ legRes: { ok: false, err: 'Dia sedang offline' } });
    const r = await m.ctl.addLeg('peer2', 'Ani'); assert.deepStrictEqual(r, { ok: false, err: 'Dia sedang offline' });
    assert.strictEqual(m.ctl.cur.legs.length, 1); assert(m.pcs()[1].closed, 'PC kaki gagal ditutup'); assert(m.ctl.cur, 'ruang jalan terus');
    assert.strictEqual(m.legEnded[0].peer, 'peer2');
    ok('addLeg ditolak: tanpa panggilan, kaki ganda, atau ditolak Core (kaki dibersihkan, ruang tetap)');
  }
  { // 3. kaki masuk otomatis dari anggota ruang
    const m = await active();
    const inc = (x) => m.ctl.onEvent(Object.assign({ ev: 'incoming', cid: LEG(5), room: CID, auto: true, peer: 'peer3', name: 'Cici', sdp: 'OFR3', ice: ['{"candidate":"x"}'] }, x));
    await inc(); assert.strictEqual(m.ctl.cur.legs.length, 2);
    assert.deepStrictEqual(m.of('callAnswer')[0], ['callAnswer', LEG(5), 'ANSWER-1']); assert.strictEqual(m.pcs()[1].remoteDescription.sdp, 'OFR3');
    assert.strictEqual(m.ctl.view().canAccept, false); assert.strictEqual(m.mics.length, 1);
    await inc({ cid: LEG(6) }); assert.deepStrictEqual(m.of('callReject').pop(), ['callReject', LEG(6)], 'peer ganda ditolak');
    await inc({ cid: LEG(7), peer: 'peer4', room: ROOMX }); assert.deepStrictEqual(m.of('callReject').pop(), ['callReject', LEG(7)], 'ruang lain ditolak');
    await inc({ cid: LEG(8), peer: 'peer4', auto: false }); assert.deepStrictEqual(m.of('callReject').pop(), ['callReject', LEG(8)], 'bukan auto ditolak');
    assert.strictEqual(m.ctl.cur.legs.length, 2);
    m.pcs()[1].state('connected'); assert.strictEqual(m.ctl.view().legs[1].state, 'active');
    ok('kaki masuk otomatis dari anggota ruang dijawab tanpa dering; peer ganda, ruang lain, dan non-auto ditolak');
  }
  { // 4. SDP rusak pada kaki masuk: hanya kaki itu yang jatuh
    const m = await active();
    await m.ctl.onEvent({ ev: 'incoming', cid: LEG(5), room: CID, auto: true, peer: 'peer3', name: 'Cici', sdp: 'BAD' });
    assert.strictEqual(m.ctl.cur.legs.length, 1); assert(m.pcs()[1].closed); assert.deepStrictEqual(m.of('callEnd').pop(), ['callEnd', LEG(5)]); assert(m.ctl.cur);
    ok('kaki masuk gagal (SDP rusak): kaki itu ditutup dan Core diberi tahu, ruang tetap berjalan');
  }
  { // 5. event end per kaki: last=false menutup satu kaki saja; last=true menutup ruang
    const m = await active(); await m.ctl.addLeg('peer2', 'Ani'); await m.ctl.addLeg('peer3', 'Cici');
    assert.strictEqual(m.ctl.cur.legs.length, 3); const mic = m.mics[0];
    await m.ctl.onEvent({ ev: 'end', cid: LEG(1), reason: 'ended', last: false });
    assert.deepStrictEqual(m.ctl.cur.legs.map((l) => l.peer), ['peer1', 'peer3']); assert(m.pcs()[1].closed && !m.pcs()[0].closed && !m.pcs()[2].closed && !mic.stopped);
    assert.deepStrictEqual(m.legEnded.map((x) => [x.peer, x.reason]), [['peer2', 'ended']]); assert.strictEqual(m.ended.length, 0);
    await m.ctl.onEvent({ ev: 'end', cid: CID, reason: 'ended', last: false }); // kaki pertama (pembuka ruang) keluar
    assert.strictEqual(m.ctl.cur.legs.length, 1); assert.strictEqual(m.ctl.cur.legs[0].peer, 'peer3'); assert.strictEqual(m.ctl.view().legs[0].cid, LEG(2));
    await m.ctl.onEvent({ ev: 'end', cid: LEG(2), reason: 'ended', wasActive: true, last: true });
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended.length, 1); assert(mic.stopped && m.pcs().every((p) => p.closed));
    ok('end per kaki: last=false hanya menutup kaki itu (termasuk kaki pertama); last=true menutup ruang, mikrofon dilepas');
  }
  { // 6. putus sesaat pada satu kaki dari dua: hanya kaki itu; kaki terakhir putus = ruang berakhir
    const m = await active(); await m.ctl.addLeg('peer2', 'Ani'); await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'A2' }); m.pcs()[1].state('connected');
    m.pcs()[1].state('disconnected'); m.s.tick(3000); m.pcs()[1].state('connected'); m.s.tick(20000);
    assert.strictEqual(m.ctl.cur.legs.length, 2, 'pulih sebelum batas: lanjut');
    m.pcs()[1].state('disconnected'); m.s.tick(8000);
    assert.deepStrictEqual(m.ctl.cur.legs.map((l) => l.peer), ['peer1']); assert.deepStrictEqual(m.of('callEnd').pop(), ['callEnd', LEG(1)]); assert.strictEqual(m.ended.length, 0);
    assert.strictEqual(m.legEnded[0].failed, false, 'kaki yang sempat aktif bukan "gagal tersambung"');
    m.pcs()[0].state('failed'); assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended.length, 1); assert.strictEqual(m.ended[0].reason, 'ended');
    ok('putus pada satu kaki menutup kaki itu saja; kaki terakhir putus mengakhiri ruang');
  }
  { // 7. kaki yang belum tersambung gagal (ICE failed) saat kaki lain aktif
    const m = await active(); await m.ctl.addLeg('peer2', 'Ani');
    m.pcs()[1].state('failed'); assert.strictEqual(m.ctl.cur.legs.length, 1); assert.strictEqual(m.legEnded[0].failed, true); assert.deepStrictEqual(m.of('callEnd').pop(), ['callEnd', LEG(1)]);
    assert.strictEqual(m.ctl.view().phase, 'active');
    ok('kaki baru gagal tersambung: dilepas dengan failed=true, panggilan yang sedang berjalan tidak terganggu');
  }
  { // 8. hangup dengan banyak kaki = satu callLeave
    const m = await active(); await m.ctl.addLeg('peer2', 'Ani'); await m.ctl.addLeg('peer3', 'Cici'); const mic = m.mics[0];
    m.ctl.hangup();
    assert.strictEqual(m.ctl.cur, null); assert.deepStrictEqual(m.of('callLeave'), [['callLeave', CID]]); assert.strictEqual(m.of('callEnd').length, 0);
    assert(m.pcs().every((p) => p.closed) && mic.stopped); assert.strictEqual(m.ended.length, 1); assert.strictEqual(m.ended[0].reason, 'ended');
    ok('hangup dengan 3 kaki: satu callLeave, semua PC ditutup, mikrofon dilepas, ui.ended sekali');
  }
  { // 9. hangup saat addLeg menunggu Core: kaki yang terlambat diakhiri
    let go; const gate = new Promise((r) => { go = r; });
    const m = await active({ legDelay: gate }); const p = m.ctl.addLeg('peer2', 'Ani'); await flush();
    m.ctl.hangup(); go(); const r = await p;
    assert.strictEqual(r.ok, false); assert.deepStrictEqual(m.of('callEnd').pop(), ['callEnd', LEG(1)], 'kaki yang terlanjur dibuat Core ditutup');
    ok('hangup saat addLeg menunggu Core: tidak ada kaki yatim');
  }
  { // 10. mikrofon bersama: bisu berlaku ke semua kaki; jalur peredam Kuat diteruskan ke kaki baru dan diganti di semua kaki
    const m = await active(); await m.ctl.addLeg('peer2', 'Ani');
    m.ctl.mute(true); assert.strictEqual(m.mics[0].enabled, false); assert.strictEqual(m.pcs()[0].senders[0].track.enabled, false); assert.strictEqual(m.pcs()[1].senders[0].track.enabled, false);
    m.ctl.mute(false);
    const pt = { enabled: true }, proc = { stream: { getAudioTracks: () => [pt] }, stop() { this.stopped = true; } };
    m.ctl.cur.proc = proc; await m.ctl.addLeg('peer3', 'Cici');
    await flush(); assert.strictEqual(m.pcs()[2].senders[0].track, pt, 'kaki baru langsung mengirim jalur olahan');
    assert.strictEqual(await m.ctl._send(m.ctl.cur, { getAudioTracks: () => [m.mics[0]] }), true);
    assert(m.pcs().every((p) => p.senders[0].track === m.mics[0]), 'ganti trek berlaku ke semua kaki');
    ok('bisu berlaku ke semua kaki; kaki baru memakai jalur peredam yang sedang aktif; ganti trek menjangkau semua kaki');
  }
  console.log('\n' + pass + ' tes banyak kaki Controller OK');
})().catch((e) => { console.error(e); process.exit(1); });
