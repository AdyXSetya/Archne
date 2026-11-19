'use strict';
// Tes ujung ke ujung channel voice (v0.19.0, langkah 7): tiga Core sungguhan di jaringan lokal, masing-masing dengan Controller asli.
// Hanya WebRTC yang palsu: sebuah kaki dianggap "tersambung" begitu SDP sudah bertukar. Sinyal, izin, presence, dan penyambungan mesh asli.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const LC = require('../renderer/archne-call');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vchc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, vcBeatMs: 300, vcTtlMs: 1500, vcRetryMs: 150 });

class FakePC {
  constructor() { this.senders = []; this.remoteDescription = null; this.localDescription = null; this.closed = false; this.connectionState = 'new'; }
  addTrack(t) { const s = { track: t, async replaceTrack(x) { this.track = x; } }; this.senders.push(s); return s; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  _up() { setImmediate(() => { if (!this.closed) { this.connectionState = 'connected'; this.onconnectionstatechange && this.onconnectionstatechange(); } }); }
  async setLocalDescription(d) { this.localDescription = d; if (d.type === 'answer') this._up(); } // sisi penjawab: siap setelah jawaban dibuat
  async setRemoteDescription(d) { this.remoteDescription = d; if (d.type === 'answer') this._up(); } // sisi penelepon: siap setelah jawaban diterima
  async addIceCandidate() {}
  close() { this.closed = true; }
}

// Satu "perangkat": Core + Controller yang bicara ke Core persis seperti IPC (galat jadi { ok:false, err }).
function device(core, clockSkew) {
  const wrap = (f) => async (...a) => { try { return f(...a); } catch (e) { return { ok: false, err: e.message }; } };
  const api = {
    vcEnter: wrap((g, c) => ({ ok: core.vcEnter(g, c) })), vcLeave: wrap(() => ({ ok: core.vcLeave() })),
    callLeg: wrap((room, peer, sdp) => ({ ok: true, cid: core.callLeg(room, peer, sdp) })), callAnswer: wrap((cid, sdp) => ({ ok: core.callAnswer(cid, sdp) })),
    callIce: wrap((cid, d) => ({ ok: core.callIce(cid, d) })), callConnected: wrap((cid) => ({ ok: core.callConnected(cid) })), callEnd: wrap((cid) => ({ ok: core.callEnd(cid) })),
    callLeave: wrap((room) => ({ ok: core.callLeave(room) })), callReject: wrap((cid) => ({ ok: core.callReject(cid) })), callMedia: wrap((room, m, d) => ({ ok: core.callMedia(room, m === true, d === true) })),
  };
  const d = { ended: [], pcs: [], mics: [], skew: 0 };
  const rtc = { PeerConnection: function () { const p = new FakePC(); d.pcs.push(p); return p; }, getUserMedia: async () => { const t = { enabled: true, stopped: false, stop() { this.stopped = true; } }; d.mics.push(t); return { getTracks: () => [t], getAudioTracks: () => [t] }; }, makeStream: (tr) => ({ tr }), playRemote: () => () => {} };
  d.ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended: (i) => d.ended.push(i), legEnded() {} }, now: () => Date.now() + d.skew });
  core.on('call', (e) => { d.ctl.onEvent(e); });
  d.core = core;
  d.enter = (gid, cid, name) => d.ctl.enterChannel(gid, cid, name);
  d.view = () => d.ctl.view();
  d.sync = () => d.ctl.sync(core.callInfo(), core.getState().vc); // = refresh() de archne-index.html
  d.peers = () => (d.view() ? d.view().legs.map((l) => core.peers.get(l.peer).name + ':' + l.state).sort().join() : null);
  return d;
}
const peersIs = (d, names) => d.peers() === names.map((n) => n + ':active').sort().join();

(async () => {
  console.log('Archne vchan UI end-to-end test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), all = [A, B, C];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) for (const x of all.slice(i + 1)) await all[i].addPeer('127.0.0.1', x.port);
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id]).id;
  await until(() => [B, C].every((n) => n.getState().groups.some((g) => g.id === gid)), 8000, 'undangan');
  const room = A.vcCreate(gid, 'Santai', false);
  await until(() => [A, B, C].every((n) => n.vcList(gid).length === 1), 8000, 'sync channel');
  const dA = device(A), dB = device(B), dC = device(C);

  // 1. sendirian: sesi aktif, tanpa kaki, Core tidak punya panggilan
  assert.deepStrictEqual(await dA.enter(gid, room, 'Santai'), { ok: true });
  await sleep(600);
  assert.strictEqual(dA.view().phase, 'active'); assert.strictEqual(dA.view().legs.length, 0); assert.strictEqual(dA.ended.length, 0);
  assert.strictEqual(A.callInfo(), null); assert.deepStrictEqual(A.getState().vc, { gid, cid: room });
  ok('masuk sendirian: sesi aktif tanpa kaki, tidak bubar, Core mencatat kehadiranku');

  // 2. yang datang disambung, mesh penuh
  assert.deepStrictEqual(await dB.enter(gid, room, 'Santai'), { ok: true });
  await until(() => peersIs(dA, ['B']) && peersIs(dB, ['A']), 8000, 'A-B');
  assert.deepStrictEqual(await dC.enter(gid, room, 'Santai'), { ok: true });
  await until(() => peersIs(dA, ['B', 'C']) && peersIs(dB, ['A', 'C']) && peersIs(dC, ['A', 'B']), 10000, 'mesh penuh');
  for (const d of [dA, dB, dC]) { assert.strictEqual(d.pcs.length, 2, 'tepat dua PeerConnection per orang'); assert.strictEqual(d.mics.length, 1, 'satu mikrofon'); assert.strictEqual(d.ended.length, 0); }
  // Core dan Controller sepakat soal kaki
  for (const [d, core] of [[dA, A], [dB, B], [dC, C]]) assert.strictEqual(core._legs(room).filter((l) => l.state === 'active').length, 2);
  ok('tiga orang saling tersambung lewat sinyal Core asli; tepat dua koneksi dan satu mikrofon per orang');

  // 3. status mik sampai ke peserta lain; layar menampilkannya
  dB.ctl.mute(true);
  await until(() => { const l = dA.view().legs.find((x) => x.peer === B.id); return l && l.muted === true; }, 6000, 'status mik B');
  const html = LC.overlayHtml(dA.view(), { esc: (x) => String(x), avatar: () => '', icons: { mic: 'M', micOff: 'MO', head: 'H', headOff: 'HO', phone: 'P' }, meId: A.id, here: A.getState().groups[0].channels[0].here });
  assert(html.includes('cbd mute'), 'lencana mik mati tampil di layar A'); assert(html.includes('Channel suara · 3 orang'));
  ok('mute B terlihat di layar A (lencana mik mati) dan jumlah orang benar');

  // 4. keluar: yang lain tetap, tidak ada toast, dan yang sendirian tidak bubar
  dC.ctl.hangup();
  await until(() => peersIs(dA, ['B']) && peersIs(dB, ['A']) && !C._vcMe, 8000, 'C keluar');
  assert.deepStrictEqual(C.getState().vc, null); assert(dC.mics[0].stopped && dC.pcs.every((p) => p.closed));
  assert.strictEqual(dA.ended.length + dB.ended.length, 0, 'yang tinggal tidak mendapat pemberitahuan apa pun');
  dB.ctl.hangup();
  await until(() => dA.view().legs.length === 0, 8000, 'B keluar');
  assert(dA.ctl.cur && A._vcMe, 'A menunggu sendirian'); assert.strictEqual(dA.ended.length, 0);
  ok('C dan B keluar satu per satu: kakinya dilepas di sisi lain, A tetap di channel tanpa toast');

  // 5. masuk lagi disambung lagi walau A sudah sendirian
  assert.deepStrictEqual(await dC.enter(gid, room, 'Santai'), { ok: true });
  await until(() => peersIs(dA, ['C']) && peersIs(dC, ['A']), 8000, 'C masuk lagi');
  ok('masuk lagi tersambung lagi');

  // 6. channel dihapus pemiliknya: Core melepas semua yang di dalam; sync menutup sesi di UI dengan penjelasan
  A.vcDelete(gid, room);
  await until(() => !A._vcMe && !C._vcMe, 8000, 'Core melepas');
  dA.skew = dC.skew = LC.SYNC_GUARD_MS + 1000;
  dA.sync(); dC.sync();
  assert.strictEqual(dA.ctl.cur, null); assert.strictEqual(dC.ctl.cur, null);
  for (const d of [dA, dC]) { const e = d.ended[d.ended.length - 1]; assert(e && e.vc && !e.local); assert(/channel dihapus, dikunci/.test(LC.endText(e))); assert(d.mics[d.mics.length - 1].stopped); }
  ok('channel dihapus: Core melepas semua orang, sync menutup sesi UI dengan pemberitahuan dan melepas mikrofon');

  for (const n of all) await n.stop();
  console.log('\n' + pass + ' skenario lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
