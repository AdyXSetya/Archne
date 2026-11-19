'use strict';
// Tes langkah 1 (kamera di channel, gaya Discord): kabar "kamera hidup/mati" lewat sinyal status (st.v), sampai ke Controller.
// Core: callMedia(room, muted, deafened, cam) -> peerstate.cam + callInfo; peer lama (tanpa cam) tidak terganggu; nilai aneh ditolak.
// Controller: panggilan berkamera mengabarkan kamera; suara saja tetap tiga argumen.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const LC = require('../renderer/archne-call');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cam-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, callRingMs: 1500, callConnMs: 2000 });
const rec = (c) => { const ev = []; c.on('call', (e) => ev.push(e)); return ev; };
const ps = (ev) => ev.filter((e) => e.ev === 'peerstate');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  // ---------- Core ----------
  const [A, B] = ['A', 'B'].map(mk);
  for (const n of [A, B]) await n.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'saling melihat');
  for (const n of [A, B]) n.on('call', (e) => {
    if (e.ev === 'incoming' && !e.auto) { n.callAnswer(e.cid, 'ANS'); n.callConnected(e.cid); }
    else if (e.ev === 'answer') n.callConnected(e.cid);
  });
  const eb = rec(B);
  const room = A.callStart(B.id, 'S1');
  // kabar kamera disimpan saat masih memanggil, lalu dikirim begitu kaki aktif (replay untuk kaki baru)
  assert.strictEqual(A.callMedia(room, false, false, true), true);
  await until(() => A.getState().call.state === 'active' && B.getState().call.state === 'active', 5000, 'aktif');
  await until(() => ps(eb).length >= 1, 5000, 'B menerima kabar kamera');
  assert.strictEqual(ps(eb)[0].cam, true);
  assert.strictEqual(B.getState().call.cam, true, 'callInfo membawa cam');
  ok('kamera hidup yang dikabarkan sebelum aktif sampai ke kaki yang baru tersambung');

  const n0 = ps(eb).length;
  A.callMedia(room, false, false, false);
  await until(() => ps(eb).length === n0 + 1, 5000, 'B menerima kamera mati');
  assert.strictEqual(ps(eb)[n0].cam, false); assert.strictEqual(B.getState().call.cam, false);
  A.callMedia(room, true, false); // tanpa kabar kamera: mik berubah, kamera tetap seperti terakhir
  await until(() => ps(eb).length === n0 + 2, 5000, 'B menerima mute');
  assert.strictEqual(ps(eb)[n0 + 1].muted, true); assert(!('cam' in ps(eb)[n0 + 1]), 'tanpa v: event tanpa cam');
  assert.strictEqual(B.getState().call.cam, false, 'cam terakhir dipertahankan');
  ok('cam hidup/mati disiarkan; callMedia tanpa cam tidak mengubahnya (peer lama / suara saja)');

  // v di luar 0/1 ditolak, tidak ada event
  const before = ps(eb).length, l = A._legs(room)[0];
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 2 });
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 'x' });
  await sleep(400);
  assert.strictEqual(ps(eb).length, before, 'v tidak valid diabaikan');
  ok('nilai v yang aneh ditolak');
  // vt (urutan menyala, langkah 3): jam pengirim hanya dipercaya bila wajar; dipertahankan selama kamera tetap hidup
  const lb = [...B._calls.values()][0];
  let k = ps(eb).length;
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 1, vt: Date.now() + 9e12 });
  await until(() => ps(eb).length === k + 1, 5000, 'v=1 vt ngawur');
  assert(lb.pst.cam === true && Math.abs(lb.pst.vt - Date.now()) < 5000, 'vt di luar 10 menit diganti waktu terima');
  const first = lb.pst.vt;
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 1, vt: Date.now() - 1000 });
  await until(() => ps(eb).length === k + 2, 5000, 'v=1 lagi');
  assert.strictEqual(lb.pst.vt, first, 'sudah hidup: vt pertama dipertahankan');
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 0 });
  const sane = Date.now() - 2000;
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 1, vt: sane });
  await until(() => ps(eb).length === k + 4, 5000, 'mati lalu hidup');
  assert.strictEqual(lb.pst.vt, sane, 'menyala lagi: vt baru dari pengirim');
  ok('vt: jam ngawur diganti, vt dipertahankan selama hidup, vt baru saat menyala lagi');
  for (const n of [A, B]) try { await n.stop(); } catch {}

  // ---------- Controller ----------
  const CID = 'a1'.repeat(8);
  class FakePC {
    constructor() { this.senders = []; FakePC.all.push(this); this.connectionState = 'new'; }
    addTrack(t) { const s = { track: t, replaceTrack: async () => {} }; this.senders.push(s); return s; }
    addTransceiver() { return { sender: { track: null, replaceTrack: async () => {} } }; } // jalur video kosong di panggilan suara
    async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    close() {}
    state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
  }
  FakePC.all = [];
  const track = (kind) => ({ kind, enabled: true, stop() {} });
  const ctlMk = () => {
    FakePC.all = [];
    const calls = [];
    const api = new Proxy({}, { get: (_, name) => async (...a) => { calls.push([name, ...a]); return { ok: true, cid: CID }; } });
    const rtc = { PeerConnection: FakePC, getUserMedia: async (c) => { const ts = c.video ? [track('audio'), track('video')] : [track('audio')]; return { getTracks: () => ts, getAudioTracks: () => ts.filter((t) => t.kind === 'audio'), getVideoTracks: () => ts.filter((t) => t.kind === 'video') }; }, makeStream: (t) => ({ t }), playRemote: () => () => {} };
    const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended() {} }, now: () => 1000, setTimeout: () => 1, clearTimeout() {} });
    return { ctl, media: () => calls.filter((c) => c[0] === 'callMedia').map((c) => c.slice(1)), pc: () => FakePC.all[FakePC.all.length - 1] };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  let m = ctlMk();
  await m.ctl.start('p'.repeat(64), 'Budi', { video: true }); await flush();
  assert.strictEqual(m.media().length, 0, 'belum tersambung: belum ada kabar');
  m.pc().state('connected'); await flush();
  assert.deepStrictEqual(m.media()[0], [CID, false, false, true], 'tersambung: kamera hidup dikabarkan');
  await m.ctl.camera(false);
  assert.deepStrictEqual(m.media().pop(), [CID, false, false, false], 'kamera dimatikan: dikabarkan');
  await m.ctl.camera(true);
  assert.deepStrictEqual(m.media().pop(), [CID, false, false, true]);
  m.ctl.mute(true);
  assert.deepStrictEqual(m.media().pop(), [CID, true, false, true], 'mute di panggilan berkamera membawa status kamera');
  ok('Controller: panggilan berkamera mengabarkan kamera saat tersambung dan tiap on/off');

  m = ctlMk();
  await m.ctl.start('p'.repeat(64), 'Budi'); await flush();
  m.pc().state('connected'); await flush();
  m.ctl.mute(true);
  assert.deepStrictEqual(m.media(), [[CID, true, false]], 'suara saja: tetap tiga argumen, tidak ada kabar kamera saat tersambung');
  await m.ctl.camera(true);
  assert.deepStrictEqual(m.media().pop(), [CID, true, false, true], 'suara -> video: kamera dinyalakan, dikabarkan bersama status mik');
  await m.ctl.camera(false);
  assert.deepStrictEqual(m.media().pop(), [CID, true, false, false], 'video -> suara: kamera dimatikan, dikabarkan');
  ok('Controller: panggilan suara tetap tiga argumen sampai kamera pernah dinyalakan');

  // peerstate dengan cam -> kaki -> view(); tanpa cam tidak menimpa
  m = ctlMk();
  await m.ctl.start('p'.repeat(64), 'Budi', { video: true }); await flush();
  const leg = m.ctl.cur.legs[0];
  assert(!('cam' in m.ctl.view().legs[0]), 'belum ada kabar: tanpa cam');
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: 'p'.repeat(64), muted: false, deafened: false, cam: true });
  assert.strictEqual(m.ctl.view().legs[0].cam, true);
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: 'p'.repeat(64), muted: true, deafened: false });
  assert.strictEqual(m.ctl.view().legs[0].cam, true, 'peerstate tanpa cam tidak menimpa');
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: 'p'.repeat(64), muted: true, deafened: false, cam: false });
  assert.strictEqual(m.ctl.view().legs[0].cam, false);
  ok('Controller: kamera lawan tersimpan di kaki dan tampil di view()');

  console.log('\ncallcamsig: ' + pass + ' OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
