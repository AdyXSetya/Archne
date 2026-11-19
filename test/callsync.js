'use strict';
// Tes sync + snapshot panggilan grup (Step 2d): undangan masuk dari snapshot, kaki hilang / yatim, pemangkasan undangan keluar, bentuk snapshot Core.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const LC = require('../renderer/archne-call');
const { Core } = require('../src/archne-core');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8), LEG = (n) => ('b' + n).repeat(8).slice(0, 16), ROOM = 'f9'.repeat(8), G = LC.SYNC_GUARD_MS;

class FakePC {
  constructor() { this.remoteDescription = null; this.localDescription = null; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { return { track: t, async replaceTrack() {} }; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER-' + FakePC.all.indexOf(this) }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER-' + FakePC.all.indexOf(this) }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() {}
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
function sched() {
  let now = 1000;
  return { now: () => now, setTimeout: () => 0, clearTimeout: () => {}, tick(ms) { now += ms; } };
}
function mk() {
  FakePC.all = [];
  const s = sched(), calls = [], ended = [], rings = [], legEnded = []; let legSeq = 0;
  const api = new Proxy({}, { get: (_t, n) => async (...a) => { calls.push([n, ...a]); if (n === 'callStart') return { ok: true, cid: CID }; if (n === 'callLeg') return { ok: true, cid: LEG(++legSeq) }; return { ok: true }; } });
  const rtc = { PeerConnection: FakePC, getUserMedia: async () => { const t = { enabled: true, stop() {} }; return { getTracks: () => [t], getAudioTracks: () => [t] }; }, makeStream: (tr) => ({ tr }), playRemote: () => () => {} };
  const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring: (k) => rings.push(k), ended: (i) => ended.push(i), legEnded: (i) => legEnded.push(i) }, now: s.now, setTimeout: s.setTimeout, clearTimeout: s.clearTimeout });
  return { ctl, s, calls, ended, rings, legEnded, of: (n) => calls.filter((c) => c[0] === n) };
}
const flush = () => new Promise((r) => setImmediate(r));
async function room3() { // panggilan keluar ke peer1 (aktif) + kaki ke peer3 lewat undangan; peer3 juga aktif
  const m = mk(); await m.ctl.start('peer1', 'Budi');
  await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'ANS' }); FakePC.all[0].state('connected');
  await m.ctl.invite('peer3', 'Cici');
  await m.ctl.onEvent({ ev: 'legneed', room: CID, peer: 'peer3', name: 'Cici' });
  await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'ANS3' }); FakePC.all[1].state('connected');
  return m;
}
const SNAP_INV = { cid: ROOM, room: ROOM, peer: 'peer1', name: 'Budi', dir: 'in', state: 'ringing', at: 1, invite: true, legs: [], members: [{ id: 'peer1', name: 'Budi' }, { id: 'peer2', name: 'Ani' }] };

(async () => {
  { // 1. undangan masuk yang terlewat: muncul dari snapshot, tidak berdering dua kali, hilang bila inti sudah tidak punya
    const m = mk();
    m.ctl.sync(SNAP_INV); await flush();
    const v = m.ctl.view();
    assert(v.invite && v.room === ROOM && v.canAccept && v.legs.length === 0); assert.deepStrictEqual(m.rings, ['in']);
    assert.deepStrictEqual(m.ctl.cur.members.map((x) => x.id), ['peer1', 'peer2']);
    m.ctl.sync(SNAP_INV); await flush(); assert.strictEqual(m.rings.length, 1, 'snapshot yang sama tidak berdering ulang');
    m.s.tick(500); m.ctl.sync(null); assert(m.ctl.cur, 'snapshot basi tepat setelah undangan muncul diabaikan');
    m.s.tick(G); m.ctl.sync(null);
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended[0].reason, 'missed', 'undangan hilang di inti = tak terjawab');
    ok('undangan dari snapshot: dering sekali, snapshot basi diabaikan, undangan yang hilang ditutup');
  }
  { // 2. undangan masih berdering tetapi snapshot menunjuk hal lain
    const m = mk(); m.ctl.sync(SNAP_INV); await flush(); m.s.tick(G + 1);
    m.ctl.sync(SNAP_INV); assert(m.ctl.cur, 'undangan yang sama: tetap');
    m.ctl.sync({ cid: CID, room: CID, peer: 'p', name: 'x', dir: 'out', state: 'active' });
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended[0].reason, 'missed');
    ok('dering undangan ditutup bila inti tidak lagi menyimpan undangan itu');
  }
  { // 3. ruang yang sedang bergabung, lalu inti kehilangan ruangnya
    const m = mk(); m.ctl.sync(SNAP_INV); await flush(); await m.ctl.accept();
    assert(m.ctl.cur.joining);
    m.s.tick(500); m.ctl.sync(null); assert(m.ctl.cur, 'masih baru: dibiarkan');
    m.s.tick(G); m.ctl.sync(null);
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended[0].reason, 'ended');
    ok('ruang yang sedang bergabung ikut ditutup bila inti sudah tidak punya ruangnya');
  }
  { // 4. halaman dimuat ulang: ruang yatim di inti ditutup sesuai bentuknya
    let m = mk();
    m.ctl.sync({ cid: CID, room: CID, peer: 'p1', name: 'x', dir: 'out', state: 'active', legs: [{ cid: CID, peer: 'p1' }, { cid: LEG(1), peer: 'p3' }, { cid: LEG(2), peer: 'p4' }] });
    assert.deepStrictEqual(m.calls, [['callLeave', CID]], 'banyak kaki: keluar dari ruang sekaligus (bukan hanya kaki pertama)');
    m = mk(); m.ctl.sync({ cid: ROOM, room: ROOM, peer: 'p1', name: 'x', dir: 'in', state: 'connecting', joining: true, legs: [], members: [] });
    assert.deepStrictEqual(m.calls, [['callLeave', ROOM]], 'sedang bergabung tanpa kaki: keluar dari ruang');
    m = mk(); m.ctl.sync({ cid: LEG(1), room: ROOM, peer: 'p3', name: 'x', dir: 'out', state: 'active', legs: [{ cid: LEG(1), peer: 'p3' }] });
    assert.deepStrictEqual(m.calls, [['callEnd', LEG(1)]], 'satu kaki tersisa: tutup kakinya');
    ok('sync tanpa panggilan lokal: ruang berkaki banyak / bergabung memakai callLeave, kaki tunggal memakai callEnd');
  }
  { // 5. kaki yang kupegang sudah hilang di inti (event end terlewat)
    const m = await room3();
    const both = { cid: CID, room: CID, peer: 'peer1', name: 'Budi', dir: 'out', state: 'active', legs: [{ cid: CID, peer: 'peer1' }, { cid: LEG(1), peer: 'peer3' }] };
    m.ctl.sync(both); assert.strictEqual(m.ctl.cur.legs.length, 2);
    const one = Object.assign({}, both, { legs: [{ cid: CID, peer: 'peer1' }] });
    m.ctl.sync(one); assert.strictEqual(m.ctl.cur.legs.length, 2, 'kaki masih baru: snapshot mungkin lebih tua, dibiarkan');
    m.s.tick(G + 1); m.ctl.sync(one);
    assert.strictEqual(m.ctl.cur.legs.length, 1); assert.strictEqual(m.ctl.cur.legs[0].peer, 'peer1');
    assert.strictEqual(m.legEnded.length, 1); assert.strictEqual(m.legEnded[0].peer, 'peer3');
    assert.strictEqual(m.of('callEnd').length, 0, 'inti sudah melepasnya: tidak dipanggil callEnd');
    const lone = { cid: CID, room: CID, peer: 'peer1', name: 'Budi', dir: 'out', state: 'active' }; // kaki terakhir tetap ada
    m.ctl.sync(lone); assert(m.ctl.cur, 'kaki terakhir yang masih ada di inti: ruang tetap');
    ok('kaki yang hilang di inti dilepas (setelah guard), kaki lain dan ruang tetap jalan');
  }
  { // 6. semua kaki hilang di inti, tidak sedang bergabung: ruang ditutup
    const m = await room3(); m.s.tick(G + 1);
    m.ctl.sync({ cid: 'zz', room: CID, peer: 'x', name: 'x', dir: 'out', state: 'active', legs: [{ cid: 'zz', peer: 'x' }] }); await flush();
    // kedua kaki hilang -> pelepasan pertama menyisakan satu kaki, pelepasan kedua menutup ruang
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended.length, 1);
    ok('semua kaki hilang di inti: ruang ditutup sekali');
  }
  { // 7. kaki yatim di inti (ada di snapshot, tidak ada di sini): ditutup hanya bila terlihat dua kali berselang >= guard
    const m = await room3();
    const snap = { cid: CID, room: CID, peer: 'peer1', name: 'Budi', dir: 'out', state: 'active', legs: [{ cid: CID, peer: 'peer1' }, { cid: LEG(1), peer: 'peer3' }, { cid: LEG(9), peer: 'peer4' }] };
    m.ctl.sync(snap); assert.strictEqual(m.of('callEnd').length, 0, 'terlihat pertama kali: event incoming-nya mungkin masih di jalan');
    m.s.tick(G - 1); m.ctl.sync(snap); assert.strictEqual(m.of('callEnd').length, 0);
    m.s.tick(1); m.ctl.sync(snap); assert.deepStrictEqual(m.of('callEnd'), [['callEnd', LEG(9)]]);
    m.s.tick(10); m.ctl.sync(snap); assert.strictEqual(m.of('callEnd').length, 1, 'penghitung direset setelah ditutup');
    // kaki yang tiba lewat event sebelum guard habis tidak ditutup
    const m2 = await room3();
    const s2 = Object.assign({}, snap); m2.ctl.sync(s2);
    await m2.ctl.onEvent({ ev: 'incoming', cid: LEG(9), room: CID, peer: 'peer4', name: 'Dedi', sdp: 'OFFER-4', ice: [], auto: true });
    m2.s.tick(G + 1); m2.ctl.sync(s2); assert.strictEqual(m2.of('callEnd').length, 0, 'sudah punya kaki: bukan yatim');
    ok('kaki yatim di inti: ditutup setelah terlihat dua kali; kaki yang menyusul lewat event aman');
  }
  { // 8. undangan keluar: dipangkas bila inti sudah tidak menunggunya
    const m = await room3();
    await m.ctl.invite('peer5', 'Eka'); assert.strictEqual(m.ctl.view().invites.length, 1);
    const snap = (inv) => ({ cid: CID, room: CID, peer: 'peer1', name: 'Budi', dir: 'out', state: 'active', legs: [{ cid: CID, peer: 'peer1' }, { cid: LEG(1), peer: 'peer3' }], invites: inv });
    m.ctl.sync(snap(undefined)); assert.strictEqual(m.ctl.view().invites.length, 1, 'undangan baru: snapshot lebih tua boleh belum memuatnya');
    m.s.tick(G + 1);
    m.ctl.sync(snap([{ peer: 'peer5', name: 'Eka' }])); assert.deepStrictEqual(m.ctl.view().invites, [{ peer: 'peer5', name: 'Eka' }], 'inti masih menunggu jawabannya: tetap');
    m.ctl.sync(snap(undefined)); assert.deepStrictEqual(m.ctl.view().invites, [], 'invitefail terlewat: undangan dipangkas');
    assert.strictEqual(m.ctl.cur.legs.length, 2, 'kaki tidak tersentuh');
    ok('undangan keluar dipangkas hanya bila inti tidak lagi menunggunya dan sudah lewat guard');
  }

  // ---- bentuk snapshot Core ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cs-'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); };
  const mkc = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, callRingMs: 1500, callConnMs: 1500 });
  const [A, B, C] = ['A', 'B', 'C'].map(mkc), all = [A, B, C];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await Promise.all(all.slice(i + 1).map((x) => all[i].addPeer('127.0.0.1', x.port)));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const cid = A.callStart(B.id, 'SDP-A');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(cid, 'SDP-B'); await until(() => A.getState().call.state === 'connecting', 5000, 'A connecting');
  A.callConnected(cid); B.callConnected(cid);
  assert(!('invites' in A.getState().call) && !('invite' in A.getState().call), 'bentuk snapshot 1-1 tidak berubah (tidak ada medan baru)');

  A.callInvite(cid, C.id);
  const sa = A.getState().call;
  assert.deepStrictEqual(sa.invites, [{ peer: C.id, name: 'C' }], 'pengundang: undangan keluar tampak di snapshot');
  await until(() => C.getState().call, 5000, 'C menerima undangan');
  const sc = C.getState().call;
  assert(sc.invite === true && sc.room === cid && sc.peer === A.id && sc.name === 'A' && sc.dir === 'in' && sc.state === 'ringing' && sc.legs.length === 0);
  assert.deepStrictEqual(sc.members.map((x) => x.id).sort(), [A.id, B.id].sort());
  assert(!('sdp' in sc), 'undangan belum membawa tawaran');
  ok('Core: undangan masuk tampak di snapshot penerima, undangan keluar tampak di snapshot pengundang');

  C.callInviteDecline(cid);
  assert.strictEqual(C.getState().call, null, 'ditolak: snapshot penerima kosong');
  await until(() => !A.getState().call.invites, 5000, 'undangan keluar hilang');
  A.callEnd(cid); await until(() => B.getState().call === null, 5000, 'B selesai');
  ok('Core: undangan ditolak membersihkan kedua snapshot');

  for (const n of all) { try { await n.stop(); } catch {} }
  console.log('\n' + pass + ' tes lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
