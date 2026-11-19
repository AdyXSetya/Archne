'use strict';
// Tes kamera DM (v0.23.0): kamera on/off di panggilan 1-1 / grup (seperti channel). Panggilan suara membawa jalur video kosong (a=msid:-), jadi bukan panggilan video;
// kamera dinyalakan lewat replaceTrack tanpa negosiasi ulang (suara -> video) dan dimatikan lagi (video -> suara). SDP di bawah ini keluaran Chromium asli.
const assert = require('assert');
const LC = require('../renderer/archne-call');
const { sdpVideo } = require('../src/core/archne-constants');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8), PEER = 'p'.repeat(64);
const flush = () => new Promise((r) => setImmediate(r));

const AUD = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=sendrecv\r\na=msid:S1 T1\r\n';
const SDP = {
  voiceOld: AUD,                                                                                                  // peer lama: tanpa jalur video
  latent: AUD + 'm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=sendrecv\r\na=msid:- d9fbbf9f-a8e7-4ff5-80f4-ecb43449a366\r\n', // jalur video kosong
  real: AUD + 'm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=sendrecv\r\na=msid:S1 c233a83a-2510-43c2-a180-0b22323482e6\r\n',    // panggilan video
  noMsid: AUD + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',                                                               // SDP tanpa msid (tes lama / peer aneh): dianggap video
  rejected: AUD + 'm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=msid:S1 T9\r\n',
  mixed: AUD + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=msid:- x\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=msid:S1 y\r\n',
};

const track = (kind) => ({ kind, enabled: true, readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } });
const mkStream = (kinds) => { const ts = kinds.map(track); return { ts, getTracks: () => ts.slice(), getAudioTracks: () => ts.filter((t) => t.kind === 'audio'), getVideoTracks: () => ts.filter((t) => t.kind === 'video'), addTrack(t) { ts.push(t); }, removeTrack(t) { const i = ts.indexOf(t); if (i >= 0) ts.splice(i, 1); } }; };
const sender = () => { const s = { track: null, replaced: [], replaceTrack: async (n) => { s.track = n; s.replaced.push(n); } }; return s; };
class FakePC {
  constructor() { this.trans = []; this.senders = []; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { const s = sender(); s.track = t; this.senders.push(s); if (t.kind === 'video') this.trans.push({ kind: 'video', sender: s, receiver: { track: { kind: 'video' } }, direction: 'sendrecv' }); return s; }
  addTransceiver(kind, init) { const t = { kind, sender: sender(), receiver: { track: { kind } }, direction: (init && init.direction) || 'sendrecv', own: true }; this.trans.push(t); return t; }
  getTransceivers() { return this.trans; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { // tawaran bermuatan video: peramban membuat transceiver recvonly sendiri bila belum ada yang bisa dipakai
    if (/m=video [1-9]/.test(d.sdp || '') && !this.trans.some((t) => t.kind === 'video')) this.trans.push({ kind: 'video', sender: sender(), receiver: { track: { kind: 'video' } }, direction: 'recvonly' });
  }
  async addIceCandidate() {}
  close() {}
}
FakePC.all = [];
function mk() {
  FakePC.all = [];
  const calls = [], notes = [], asked = [];
  const api = new Proxy({}, { get: (_, name) => async (...a) => { calls.push([name, ...a]); return { ok: true, cid: CID }; } });
  const rtc = { PeerConnection: FakePC, getUserMedia: async (c) => { asked.push(c); return mkStream(c.video && c.audio ? ['audio', 'video'] : c.video ? ['video'] : ['audio']); }, makeStream: (t) => ({ t }), playRemote: () => () => {} };
  const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended() {}, notice: (t) => notes.push(t) }, now: () => 1000, setTimeout: () => 1, clearTimeout() {} });
  return { ctl, calls, notes, asked, media: () => calls.filter((c) => c[0] === 'callMedia').map((c) => c.slice(1)), pc: () => FakePC.all[FakePC.all.length - 1] };
}
const incoming = async (m, sdp, accept) => { m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: PEER, name: 'Budi', sdp, ice: [] }); if (accept) { await m.ctl.accept(); await flush(); } };

(async () => {
  // 1. klasifikasi SDP: jalur kosong bukan video; Core dan UI sepakat
  for (const k of ['voiceOld', 'latent', 'real', 'noMsid', 'rejected', 'mixed']) {
    const want = k === 'real' || k === 'noMsid' || k === 'mixed';
    assert.strictEqual(LC.sdpHasVideo(SDP[k]), want, 'UI: ' + k); assert.strictEqual(sdpVideo(SDP[k]), want, 'Core: ' + k);
  }
  assert.strictEqual(LC.sdpVideoKind(SDP.latent), 'latent'); assert.strictEqual(LC.sdpVideoKind(SDP.real), 'real'); assert.strictEqual(LC.sdpVideoKind(SDP.voiceOld), null); assert.strictEqual(LC.sdpVideoKind(null), null);
  ok('SDP: jalur video kosong (a=msid:-) bukan panggilan video; video sungguhan tetap terdeteksi');

  // 2. penelepon (suara): jalur video kosong sendrecv, kamera mati, tombol kamera tersedia saat tersambung
  let m = mk();
  await m.ctl.start(PEER, 'Budi'); await flush();
  const pc = m.pc(), lat = pc.trans.find((t) => t.own);
  assert(lat && lat.kind === 'video' && lat.direction === 'sendrecv', 'jalur video kosong dibuat penelepon');
  assert.strictEqual(m.ctl.cur.legs[0].vsender, lat.sender);
  assert.deepStrictEqual(Object.keys(m.asked[0]), ['audio'], 'suara: hanya mikrofon diminta');
  assert.strictEqual(m.ctl.view().camOff, true); assert.strictEqual(m.ctl.view().video, false);
  ok('penelepon suara: jalur video kosong, kamera mati, izin kamera belum diminta');

  // 3. penjawab panggilan suara dari peer baru: bukan panggilan video; jalur dijadikan sendrecv; kamera bisa dinyalakan lalu dimatikan
  m = mk();
  await incoming(m, SDP.latent);
  assert.strictEqual(m.ctl.view().video, false, 'layar dering: suara');
  assert(/Panggilan suara masuk/.test(LC.overlayHtml(m.ctl.view(), { esc: (x) => x, avatar: () => '', icons: {} })));
  await m.ctl.accept(); await flush();
  assert.deepStrictEqual(Object.keys(m.asked[0]), ['audio']);
  const tr = m.pc().trans.find((t) => t.kind === 'video');
  assert.strictEqual(tr.direction, 'sendrecv', 'jalur video dari tawaran dijadikan sendrecv');
  assert.strictEqual(m.ctl.cur.legs[0].vsender, tr.sender);
  m.pc().connectionState = 'connected'; m.pc().onconnectionstatechange(); await flush();
  assert.strictEqual(m.ctl.view().phase, 'active');
  assert.strictEqual(m.media().length, 0, 'suara saja: belum ada kabar kamera');
  assert.strictEqual(await m.ctl.camera(true), false);
  assert.deepStrictEqual(m.media().pop(), [CID, false, false, true], 'kamera hidup dikabarkan');
  assert(m.asked[1].video && !m.asked[1].audio); assert.strictEqual(tr.sender.track.kind, 'video', 'kamera lewat replaceTrack di jalur yang sudah ada');
  assert.strictEqual(m.ctl.view().video, true); assert(m.ctl.localVideo());
  assert.strictEqual(await m.ctl.camera(false), true);
  assert.deepStrictEqual(m.media().pop(), [CID, false, false, false]); assert.strictEqual(tr.sender.track, null); assert.strictEqual(m.ctl.localVideo(), null);
  assert.strictEqual(FakePC.all.length, 1, 'tanpa negosiasi ulang / PeerConnection baru');
  ok('penjawab suara: dering "suara", kamera menyala lewat jalur kosong (suara -> video) dan mati lagi (video -> suara)');

  // 4. kamera lawan: jalur kosong tidak ditampilkan sebelum lawan mengabarkan kamera hidup
  const l = m.ctl.cur.legs[0];
  l.vremote = { id: 'RV' };
  assert.strictEqual(m.ctl.view().legs[0].video, false, 'jalur kosong dari tawaran: bukan video'); assert.strictEqual(m.ctl.remoteVideo(PEER), null);
  assert(!LC.videoView(Object.assign({}, m.ctl.view(), { camOff: true })), 'belum ada yang berkamera: layar suara');
  await m.ctl.onEvent({ ev: 'peerstate', cid: CID, room: CID, peer: PEER, muted: false, deafened: false, cam: true });
  assert.strictEqual(m.ctl.remoteVideo(PEER), l.vremote); assert(LC.videoView(m.ctl.view()), 'lawan menyalakan kamera: layar video');
  await m.ctl.onEvent({ ev: 'peerstate', cid: CID, room: CID, peer: PEER, muted: false, deafened: false, cam: false });
  assert.strictEqual(m.ctl.remoteVideo(PEER), null); assert(!LC.videoView(m.ctl.view()), 'lawan mematikan kamera: kembali ke layar suara');
  ok('kamera lawan: tampil hanya saat cam=true, kembali ke layar suara saat mati');

  // 5. panggilan video: kamera ikut, tombol mati melepas trek dan kembali ke suara; peer lama (tanpa kabar kamera) tetap tampil bila ada aliran video asli
  m = mk();
  await incoming(m, SDP.real, true);
  assert.strictEqual(m.ctl.view().video, true); assert(m.asked[0].video && m.asked[0].audio);
  assert.strictEqual(m.ctl.view().camOff, false);
  const vsnd = m.ctl.cur.legs[0].vsender, vtr = m.ctl.cur.stream.getVideoTracks()[0];
  assert.strictEqual(vsnd.track, vtr);
  await m.ctl.camera(false);
  assert.strictEqual(vtr.stopped, true); assert.strictEqual(vsnd.track, null); assert.strictEqual(m.ctl.view().camOff, true);
  m.ctl.cur.legs[0].vremote = { id: 'RV' };
  assert.strictEqual(m.ctl.view().legs[0].video, true, 'tawaran video asli: aliran lawan dihitung');
  assert(LC.videoView(m.ctl.view()), 'peer lama tanpa kabar kamera: tetap layar video selama ada aliran');
  ok('panggilan video: kamera mati melepas trek; peer lama tanpa kabar kamera tetap kompatibel');

  // 6. peer lama (tawaran tanpa jalur video): kamera tidak bisa terkirim, jangan membuka kamera sia-sia
  m = mk();
  await incoming(m, SDP.voiceOld, true);
  assert(!m.pc().trans.some((t) => t.kind === 'video'));
  assert.strictEqual(await m.ctl.camera(true), true); assert.strictEqual(m.asked.length, 1, 'kamera tidak dibuka');
  assert(m.notes.some((t) => /versi lama/.test(t)));
  ok('lawan versi lama: pemberitahuan, kamera tidak dibuka');

  // 7. kamera dimatikan selagi menunggu izin (panggilan video masuk): kamera dilepas begitu didapat; undangan membawa penanda video hanya bila kamera hidup
  m = mk();
  m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: PEER, name: 'Budi', sdp: SDP.real, ice: [] });
  const p = m.ctl.accept(); // belum ada stream: camera(false) dicatat
  await m.ctl.camera(false); await p; await flush();
  assert.strictEqual(m.ctl.view().camOff, true); assert.strictEqual(m.ctl.cur.stream.getVideoTracks().length, 0);
  m.pc().connectionState = 'connected'; m.pc().onconnectionstatechange(); await flush();
  await m.ctl.invite('q'.repeat(64), 'Sari');
  assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callInvite'), ['callInvite', CID, 'q'.repeat(64)], 'kamera mati: undangan suara');
  await m.ctl.camera(true);
  await m.ctl.invite('r'.repeat(64), 'Dewi');
  assert.deepStrictEqual(m.calls.filter((c) => c[0] === 'callInvite').pop(), ['callInvite', CID, 'r'.repeat(64), true], 'kamera hidup: undangan video');
  ok('kamera mati sebelum izin keluar berlaku; undangan membawa penanda video sesuai kamera');

  console.log('\ndmcam: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
