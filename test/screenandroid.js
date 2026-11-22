'use strict';
// Tes berbagi layar dari HP (fase E): sisi renderer (getDisplayMedia lewat loopback ke plugin native) dan relai pembungkus.
// Java dan WebRTC native tidak bisa dijalankan di sini; yang dijaga adalah kontrak sinyal dan siklus hidup trek.
const assert = require('assert'), fs = require('fs'), path = require('path');
const LC = require('../renderer/archne-call.js');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

class Track {
  constructor(kind) { this.kind = kind; this.stopped = false; this.ls = {}; }
  stop() { this.stopped = true; }
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  dispatchEvent(e) { for (const f of this.ls[e.type] || []) f(e); return true; }
  getSettings() { return { sampleRate: 48000 }; }
}
function fakeWin(opts) {
  const pcs = [];
  class PC {
    constructor(cfg) { this.cfg = cfg; this.ice = []; this.closed = false; pcs.push(this); }
    async setRemoteDescription(d) { this.remote = d; const v = new Track('video'); setTimeout(() => { if (this.ontrack) { if (opts.audio) this.ontrack({ track: this.a = new Track('audio') }); this.ontrack({ track: this.v = v }); } }, 0); }
    async createAnswer() { return { type: 'answer', sdp: 'ANS' }; }
    async setLocalDescription(d) { this.local = d; setTimeout(() => this.onicecandidate && this.onicecandidate({ candidate: { candidate: 'cand1', sdpMid: '0', sdpMLineIndex: 0 } }), 0); }
    async addIceCandidate(c) { this.ice.push(c); }
    close() { this.closed = true; }
  }
  class MS { constructor(t) { this.t = t || []; } getVideoTracks() { return this.t.filter((x) => x.kind === 'video'); } getAudioTracks() { return this.t.filter((x) => x.kind === 'audio'); } }
  class Audio { constructor() { this.muted = false; } play() { this.played = true; return Promise.resolve(); } pause() { this.paused = true; } }
  return { w: { navigator: { mediaDevices: {} }, RTCPeerConnection: PC, MediaStream: MS, Audio, Event: class { constructor(t) { this.type = t; } }, setTimeout, parent: null, addEventListener() {} }, pcs };
}
function fakeBridge(reply) {
  const sent = [];
  const b = { screen: true, audio: true, onScreenSig: null, sent,
    send(a, x) { sent.push([a, x]); },
    async ask(a, on, ms, x) { sent.push([a, x]); return reply(a, x, b); } };
  return b;
}
const flush = () => new Promise((r) => setTimeout(r, 15));

(async () => {
  // 1. kemampuan: getDisplayMedia hanya ada bila API-nya ada ATAU cangkang punya plugin layar
  {
    const f = fakeWin({}); const b = { screen: false };
    assert.strictEqual(LC.browserRtc(f.w, b).getDisplayMedia, undefined, 'tanpa API dan tanpa plugin: tidak ada');
    b.screen = true; // native-caps datang setelah iframe dimuat: accessor, bukan nilai tetap
    assert.strictEqual(typeof LC.browserRtc(f.w, b).getDisplayMedia, 'function', 'plugin layar: ada');
    const r = LC.browserRtc(f.w, b); b.screen = false; assert.strictEqual(r.getDisplayMedia, undefined, 'dibaca ulang tiap kali');
    const g = fakeWin({}); g.w.navigator.mediaDevices.getDisplayMedia = () => 'native';
    assert.strictEqual(typeof LC.browserRtc(g.w, { screen: true }).getDisplayMedia, 'function'); // API asli didahulukan
    ok('getDisplayMedia: dideteksi (API asli, atau plugin ArchneScreen), dibaca ulang saat caps berubah');
  }
  // 2. alur sukses: start -> offer -> answer -> ICE (yang datang lebih awal diantrekan) -> trek -> stop menghentikan native
  {
    const f = fakeWin({ audio: true });
    const b = fakeBridge((a, x, br) => { if (a === 'screen-start') { setTimeout(() => { br.onScreenSig({ t: 'ice', c: 'early', mid: '0', ml: 0 }); br.onScreenSig({ t: 'offer', sdp: 'OFFER' }); }, 0); return { ok: true, res: 'audio' }; } return { ok: true, res: '' }; });
    const gs = await LC.browserRtc(f.w, b).getDisplayMedia({});
    const pc = f.pcs[0];
    assert.deepStrictEqual(pc.cfg, { iceServers: [] }, 'tanpa STUN: loopback di perangkat sendiri');
    assert.strictEqual(pc.remote.sdp, 'OFFER');
    assert.deepStrictEqual(b.sent.map((x) => x[0]).slice(0, 2), ['screen-start', 'screen-answer'], 'answer dikirim setelah start');
    assert.deepStrictEqual(b.sent[0][1], { audio: true }, 'audio diminta bawaan');
    assert.deepStrictEqual(pc.ice.map((x) => x.candidate), ['early'], 'ICE yang datang sebelum remote description diantrekan lalu dipasang');
    await flush();
    assert(b.sent.some((x) => x[0] === 'screen-ice' && x[1].c === 'cand1'), 'kandidat lokal diteruskan ke native');
    assert.strictEqual(gs.getVideoTracks().length, 1); assert.strictEqual(gs.getAudioTracks().length, 1);
    const at = gs.getAudioTracks()[0];
    assert.strictEqual(at.getSettings().suppressLocalAudioPlayback, true, 'native mengeluarkan suara Archne (excludeUid): tanpa gema');
    assert(pc.a && f.w.Audio, 'elemen audio bisu menjaga trek mengalir ke WebAudio');
    const vt = gs.getVideoTracks()[0]; vt.stop();
    assert(pc.closed && b.sent.some((x) => x[0] === 'screen-stop'), 'stop() pada trek video: loopback ditutup dan native diminta berhenti');
    assert.strictEqual(b.onScreenSig, null, 'pendengar sinyal dilepas');
    vt.stop(); assert.strictEqual(b.sent.filter((x) => x[0] === 'screen-stop').length, 1, 'idempoten');
    ok('alur loopback: offer/answer/ICE (antrean), trek video+audio, stop() menghentikan tangkapan native sekali');
  }
  // 3. galat: ditolak = NotAllowedError (bukan galat); layanan belum siap = pesan; tak ada offer = batas waktu bersih
  {
    for (const [res, name, hasMsg] of [['denied', 'NotAllowedError', false], ['nosvc', 'NotReadableError', true]]) {
      const f = fakeWin({}); const b = fakeBridge(() => ({ ok: false, res }));
      let err = null; try { await LC.browserRtc(f.w, b).getDisplayMedia({}); } catch (e) { err = e; }
      assert(err && err.name === name && !!err.userMsg === hasMsg, res);
      assert(f.pcs[0].closed && b.sent.some((x) => x[0] === 'screen-stop') && b.onScreenSig === null, res + ': dibersihkan');
    }
    ok('izin ditolak = NotAllowedError (diam), layanan belum siap = pesan, keduanya membersihkan loopback');
  }
  // 4. kejadian native: ended (Berhenti berbagi dari sistem) -> trek ended; audiofail -> hanya audio ended, layar jalan terus
  {
    const f = fakeWin({ audio: true });
    const mk = () => fakeBridge((a, x, br) => { if (a === 'screen-start') setTimeout(() => br.onScreenSig({ t: 'offer', sdp: 'O' }), 0); return { ok: true, res: '' }; });
    let b = mk(); let gs = await LC.browserRtc(f.w, b).getDisplayMedia({});
    let ev = []; gs.getVideoTracks()[0].addEventListener('ended', () => ev.push('v')); gs.getAudioTracks()[0].addEventListener('ended', () => ev.push('a'));
    b.onScreenSig({ t: 'audiofail' }); assert.deepStrictEqual(ev, ['a'], 'audiofail: hanya audio');
    assert(!f.pcs[0].closed, 'layar tetap dibagikan');
    b.onScreenSig({ t: 'ended' }); assert.deepStrictEqual(ev, ['a', 'v'], 'audio sudah lepas: ended hanya mengenai video');
    assert(ev.includes('v') && f.pcs[0].closed, 'ended: video ended + loopback ditutup');
    assert(!b.sent.some((x) => x[0] === 'screen-stop'), 'native yang berhenti: tidak diminta berhenti lagi');
    ok('kejadian native: "Berhenti berbagi" sistem -> ended pada trek; audiofail melepas audio saja');
  }
  // 5. startScreen memakai jalur yang sama dengan desktop (replaceTrack ke tiap kaki) -> sudah dijaga test/screenshare.js; di sini: audio=false dihormati
  {
    const f = fakeWin({ audio: true }); const b = fakeBridge((a, x, br) => { if (a === 'screen-start') setTimeout(() => br.onScreenSig({ t: 'offer', sdp: 'O' }), 0); return { ok: true, res: '' }; });
    const gs = await LC.browserRtc(f.w, b).getDisplayMedia({ audio: false });
    assert.deepStrictEqual(b.sent[0][1], { audio: false }); assert.strictEqual(gs.getAudioTracks().length, 0);
    ok('audio:false dihormati (tidak diminta dan tidak dikembalikan)');
  }
  // 6. bridge + pembungkus
  {
    const w = { parent: {}, addEventListener(t, f) { this.fn = f; } }; w.parent = { postMessage(m) { (this.got = this.got || []).push(m); } };
    const br = LC.nativeBridge(w);
    w.fn({ source: w.parent, data: { archne: 'native-caps', audio: true, screen: true } }); assert.strictEqual(br.screen, true);
    let got = null; br.onScreenSig = (d) => { got = d; };
    w.fn({ source: w.parent, data: { archne: 'native-screen', t: 'offer', sdp: 'X' } }); assert.strictEqual(got.t, 'offer');
    br.send('screen-ice', { c: 'a' }); assert.deepStrictEqual(w.parent.got.pop(), { archne: 'native', action: 'screen-ice', id: 0, c: 'a' });
    const wrap = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'shell', 'index.html'), 'utf8');
    for (const k of ["'screen-start'", "'screen-answer'", "'screen-ice'", "'screen-stop'", "nat('ArchneScreen', 'caps')", "addListener('sig'", "archne: 'native-screen'", 'screen: screenCap']) assert(wrap.includes(k), 'pembungkus: ' + k);
    ok('jembatan: caps.screen, sinyal native-screen ke UI, send() satu arah; pembungkus meneruskan start/answer/ice/stop dan kejadian sig');
  }
  console.log('screenandroid: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
