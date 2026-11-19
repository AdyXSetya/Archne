'use strict';
// Tes video tahap 6: kamera on/off dan balik kamera depan/belakang (replaceTrack tanpa renegotiation).
// Kamera DM: kamera mati = trek dilepas (lampu padam) dan jalur video dikosongkan; menyala = kamera dibuka lagi. Berlaku juga di panggilan suara (suara -> video).
// Kamera sungguhan hanya bisa diuji di perangkat; di sini getUserMedia dan RTCPeerConnection palsu.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8), PEER = 'p'.repeat(64);

class FakePC {
  constructor() { this.senders = []; FakePC.all.push(this); }
  addTrack(t) { const s = { track: t, replaced: [], replaceTrack: async (n) => { s.replaced.push(n); s.track = n; } }; this.senders.push(s); return s; }
  addTransceiver(kind, init) { const s = { track: null, replaced: [], replaceTrack: async (n) => { s.replaced.push(n); s.track = n; } }; this.lat = { kind, init, sender: s }; return this.lat; }
  getTransceivers() { return []; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}
FakePC.all = [];
let tid = 0;
const track = (kind, facing) => ({ kind, id: ++tid, facing, enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; this.stopped = true; } });
const mkStream = (kinds, facing) => {
  const ts = kinds.map((k) => track(k, facing));
  return { ts, all: ts.slice(), getTracks: () => ts.slice(), getAudioTracks: () => ts.filter((t) => t.kind === 'audio'), getVideoTracks: () => ts.filter((t) => t.kind === 'video'),
    addTrack(t) { ts.push(t); }, removeTrack(t) { const i = ts.indexOf(t); if (i >= 0) ts.splice(i, 1); } };
};
const flush = () => new Promise((r) => setImmediate(r));

// opts.failFacing: arah yang selalu gagal; opts.failAll: semua permintaan video setelah yang pertama gagal; opts.gate: tahan getUserMedia pertama sampai gate.open()
function mk(opts) {
  opts = opts || {};
  FakePC.all = [];
  const asked = [], streams = [], notes = [], renders = [];
  let release; const held = opts.gate ? new Promise((r) => { release = r; }) : null;
  let n = 0;
  const api = new Proxy({}, { get: () => async () => ({ ok: true, cid: CID }) });
  const rtc = {
    PeerConnection: FakePC,
    getUserMedia: async (c) => {
      asked.push(c); n++;
      if (n === 1 && held) await held;
      if (opts.slowFlip && n > 1) await opts.slowFlip;
      const f = c.video && c.video.facingMode;
      if (n > 1 && c.video && (opts.failAll || (opts.failFacing && f === opts.failFacing))) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
      const st = mkStream(c.audio ? ['audio', 'video'] : ['video'], f || 'user'); streams.push(st); return st;
    },
    makeStream: (t) => ({ t }),
    playRemote: () => () => {},
  };
  const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended() {}, notice: (t) => notes.push(t) }, now: () => 1000, setTimeout: () => 1, clearTimeout() {} });
  return { ctl, asked, streams, notes, renders, release, pc: () => FakePC.all[FakePC.all.length - 1] };
}
const call = async (m, video) => { await m.ctl.start(PEER, 'Budi', video === false ? undefined : { video: true }); await flush(); };
const vt = (m) => m.ctl.cur.stream.getVideoTracks()[0];

(async () => {
  // 1. kamera mati/nyala: mati melepas trek video (audio tidak tersentuh), jalur dikosongkan; nyala membuka kamera lagi
  let m = mk();
  await call(m);
  const [aud, vid] = m.streams[0].ts;
  assert.strictEqual(m.ctl.view().camOff, false);
  const snd1 = m.ctl.cur.legs[0].vsender;
  assert.strictEqual(await m.ctl.camera(), true, 'tanpa argumen = balik: mati');
  assert(vid.stopped === true && aud.stopped !== true && aud.enabled === true, 'video dilepas; audio tetap');
  assert.strictEqual(snd1.track, null, 'jalur video dikosongkan');
  assert.strictEqual(m.ctl.view().camOff, true); assert.strictEqual(m.ctl.localVideo(), null);
  assert.strictEqual(await m.ctl.camera(true), false, 'on=true menyalakan');
  assert.strictEqual(m.asked.length, 2); assert(!m.asked[1].audio && m.asked[1].video, 'hanya video diminta lagi');
  assert(vt(m) && vt(m) !== vid && vt(m).readyState === 'live' && snd1.track === vt(m), 'trek baru terpasang di jalur yang sama (tanpa renegotiation)');
  assert.strictEqual(await m.ctl.camera(false), true); assert.strictEqual(await m.ctl.camera(false), true, 'idempoten');
  m.ctl.mute(true); assert.strictEqual(m.ctl.cur.stream.getVideoTracks().length, 0); m.ctl.mute(false); assert.strictEqual(m.ctl.cur.stream.getVideoTracks().length, 0, 'mute/unmute tidak menyalakan kamera yang dimatikan');
  await m.ctl.camera(true); m.ctl.mute(true); assert.strictEqual(vt(m).enabled, true, 'mute tidak mematikan kamera'); assert.strictEqual(m.ctl.cur.stream.getAudioTracks()[0].enabled, false);
  assert.strictEqual(FakePC.all.length, 1, 'satu PeerConnection, tidak ada kaki baru');
  ok('kamera on/off: trek video dilepas / dibuka lagi, audio tidak tersentuh');

  // 2. panggilan suara: kamera bisa dinyalakan (suara -> video) lewat jalur video kosong, lalu dimatikan lagi; tidak berlaku tanpa panggilan / saat berdering
  m = mk();
  await call(m, false);
  assert.strictEqual(m.ctl.view().camOff, true, 'panggilan suara: kamera mati'); assert.strictEqual(m.ctl.view().video, false);
  assert(m.pc().lat && m.pc().lat.kind === 'video' && m.pc().lat.init.direction === 'sendrecv', 'penelepon membuat jalur video kosong sendrecv');
  assert.strictEqual(m.ctl.localVideo(), null);
  assert.strictEqual(await m.ctl.flipCamera(), false, 'kamera mati: tidak ada yang dibalik'); assert.strictEqual(m.asked.length, 1);
  assert.strictEqual(await m.ctl.camera(true), false); assert.strictEqual(m.ctl.view().camOff, false);
  assert.strictEqual(m.ctl.view().video, true); assert(m.ctl.localVideo(), 'pratinjau kamera sendiri tersedia');
  assert.strictEqual(m.pc().lat.sender.track, vt(m), 'kamera masuk lewat replaceTrack di jalur kosong');
  assert.strictEqual(await m.ctl.camera(false), true); assert.strictEqual(m.pc().lat.sender.track, null); assert.strictEqual(m.ctl.view().video, true, 'sudah pernah berkamera: kabar kamera tetap dibawa');
  assert.strictEqual(await mk().ctl.camera(), false); assert.strictEqual(await mk().ctl.flipCamera(), false, 'tanpa panggilan: aman');
  m = mk();
  m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: PEER, name: 'Budi', sdp: 'v=0\r\nm=audio 9 X 111\r\nm=video 9 X 96\r\n', ice: [] });
  assert.strictEqual(await m.ctl.camera(), false); assert.strictEqual(m.ctl.view().camOff, true, 'berdering: belum bisa');
  assert.strictEqual(await m.ctl.flipCamera(), false);
  ok('panggilan suara bisa jadi video (kamera dinyalakan), tidak berlaku tanpa panggilan atau saat berdering');

  // 3. kamera dimatikan saat dialog izin masih terbuka: berlaku begitu kamera didapat (trek dilepas, kamera tidak jadi dipakai)
  m = mk({ gate: true });
  const p = m.ctl.start(PEER, 'Budi', { video: true }); await flush();
  assert.strictEqual(await m.ctl.camera(false), true);
  m.release(); await p; await flush();
  assert.strictEqual(m.ctl.cur.stream.getVideoTracks().length, 0, 'pilihan mati dipakai pada trek yang baru datang');
  assert.strictEqual(m.streams[0].all[1].stopped, true, 'kamera yang tidak jadi dipakai dilepas');
  assert.strictEqual(m.ctl.view().camOff, true);
  ok('kamera mati dipilih sebelum izin keluar tetap berlaku');

  // 4. balik kamera: kamera lama dilepas dulu, hanya video diminta, trek baru ke sender tanpa renegotiation, stream dan status ikut berubah
  m = mk();
  await call(m);
  const oldV = vt(m), pc = m.pc(), snd = m.ctl.cur.legs[0].vsender, rev0 = m.ctl.view().vrev;
  assert.strictEqual(m.ctl.view().facing, 'user');
  assert.strictEqual(await m.ctl.flipCamera(), true);
  assert.strictEqual(oldV.stopped, true, 'kamera lama dilepas');
  const ask = m.asked[1];
  assert(!ask.audio && ask.video.facingMode === 'environment', 'hanya video, arah belakang');
  const nv = vt(m);
  assert(nv !== oldV && nv.facing === 'environment' && nv.enabled === true);
  assert.strictEqual(snd.track, nv, 'sender video memakai trek baru'); assert.strictEqual(snd.replaced.length, 1);
  assert.strictEqual(pc.senders.filter((s) => s.track.kind === 'video').length, 1, 'tidak ada sender baru');
  assert.strictEqual(m.ctl.cur.stream.getAudioTracks().length, 1, 'mikrofon tidak tersentuh');
  assert.strictEqual(m.ctl.view().facing, 'environment'); assert(m.ctl.view().vrev > rev0);
  assert.strictEqual(m.ctl.localVideo(), m.ctl.cur.stream);
  assert.strictEqual(await m.ctl.flipCamera(), true);
  assert.strictEqual(m.asked[2].video.facingMode, 'user'); assert.strictEqual(m.ctl.view().facing, 'user', 'balik lagi ke depan');
  ok('balik kamera: lepas yang lama, replaceTrack, stream dan status diperbarui');

  // 5. balik kamera hanya saat kamera hidup; kaki yang datang belakangan memakai kamera yang sedang dipakai
  m = mk();
  await call(m);
  await m.ctl.camera(false);
  assert.strictEqual(await m.ctl.flipCamera(), false, 'kamera mati: tidak bisa dibalik'); assert.strictEqual(m.ctl.view().camOff, true);
  await m.ctl.camera(true); assert(vt(m).enabled);
  await m.ctl.flipCamera();
  const l2 = m.ctl._leg('q'.repeat(64), 'Sari', 'out'); const pc2 = m.ctl._pc(m.ctl.cur, l2);
  assert.strictEqual(pc2.senders.find((s) => s.track.kind === 'video').track, vt(m), 'peserta baru mendapat kamera yang sedang dipakai');
  await m.ctl.camera(false);
  const l3 = m.ctl._leg('r'.repeat(64), 'Dewi', 'out'); const pc3 = m.ctl._pc(m.ctl.cur, l3);
  assert(!pc3.senders.some((s) => s.track.kind === 'video') && pc3.lat, 'kamera mati: peserta baru hanya mendapat jalur video kosong');
  ok('balik kamera hanya saat hidup dan berlaku untuk peserta baru');

  // 6. arah baru gagal: kembali ke arah lama, kamera tetap jalan, pesan muncul, facing tidak berubah
  m = mk({ failFacing: 'environment' });
  await call(m);
  assert.strictEqual(await m.ctl.flipCamera(), false);
  assert.strictEqual(m.ctl.view().facing, 'user'); assert.strictEqual(m.ctl.view().camOff, false);
  assert.strictEqual(m.asked.length, 3, 'coba belakang, lalu kembali ke depan');
  assert(vt(m) && vt(m).readyState === 'live' && vt(m).facing === 'user', 'kamera depan hidup kembali');
  ok('balik kamera gagal: kembali ke kamera semula');

  // 7. semua gagal: tampil sebagai kamera mati + pesan; menyalakan lagi membuka ulang kamera
  m = mk({ failAll: true });
  await call(m);
  const dead = vt(m);
  assert.strictEqual(await m.ctl.flipCamera(), false);
  assert.strictEqual(m.ctl.view().camOff, true); assert(m.notes.some((x) => /Kamera lain tidak tersedia/.test(x)));
  assert.strictEqual(dead.readyState, 'ended');
  m = mk({ failAll: false });
  await call(m);
  const t0 = vt(m); t0.stop(); // trek mati total (misal kamera direbut aplikasi lain)
  await m.ctl.camera(false); await m.ctl.camera(true);
  assert(vt(m) !== t0 && vt(m).readyState === 'live', 'menyalakan kamera yang sudah mati membuka kamera ulang');
  assert.strictEqual(m.ctl.view().camOff, false);
  ok('semua gagal: kamera mati + pesan; menyalakan lagi mencoba ulang');

  // 8. ketukan beruntun: satu balik kamera berjalan, sisanya diabaikan
  let go; const slow = new Promise((r) => { go = r; });
  m = mk({ slowFlip: slow });
  await call(m);
  const f1 = m.ctl.flipCamera(), f2 = m.ctl.flipCamera();
  assert.strictEqual(await f2, false);
  go(); assert.strictEqual(await f1, true);
  assert.strictEqual(m.asked.length, 2, 'hanya satu permintaan kamera baru');
  ok('ketukan beruntun tidak saling tabrak');

  // 9. panggilan berakhir saat menunggu kamera baru: trek baru dilepas, tidak ada galat
  go = null; const slow2 = new Promise((r) => { go = r; });
  m = mk({ slowFlip: slow2 });
  await call(m);
  const f3 = m.ctl.flipCamera(); await flush();
  await m.ctl.hangup(); await flush();
  go(); assert.strictEqual(await f3, false);
  assert(m.streams[1].ts.every((t) => t.stopped), 'kamera yang terlambat datang dilepas');
  ok('panggilan selesai saat balik kamera: kamera baru dilepas');

  // 10. akhir panggilan melepas trek yang sudah diganti
  m = mk();
  await call(m);
  await m.ctl.flipCamera();
  const live = vt(m);
  await m.ctl.hangup(); await flush();
  assert.strictEqual(live.stopped, true);
  ok('akhir panggilan melepas kamera hasil balik');

  // 11. overlay: tombol kamera (dan balik kamera bila h.flip), status, kartu sendiri saat kamera mati
  const H = { esc: (x) => x, avatar: (id) => '[av:' + id + ']', icons: { mic: 'M', micOff: 'm', head: 'H', headOff: 'h', phone: 'P', video: 'V', videoOff: 'v', flip: 'F' }, meId: 'ME' };
  const baseV = { phase: 'active', video: true, peer: 'PEER', name: 'Budi', muted: false, deafened: false, since: 1, noise: 'standard', camOff: false, facing: 'user',
    legs: [{ peer: 'PEER', name: 'Budi', state: 'active', muted: false, deafened: false }], invites: [], members: [] };
  let html = LC.overlayHtml(baseV, H);
  assert(/class="cbtn tog on" data-cact="cam"[^>]*aria-label="Kamera hidup"/.test(html) && />V</.test(html), 'tombol kamera menyala = kamera hidup (seperti channel)');
  assert(!/data-cact="flip"/.test(html), 'tanpa h.flip: tidak ada tombol balik');
  assert(!/class="cvt me camoff/.test(html));
  html = LC.overlayHtml(baseV, Object.assign({ flip: true }, H));
  assert(/data-cact="flip"[^>]*aria-label="Balik kamera"/.test(html) && />F</.test(html));
  const order = [...html.matchAll(/data-cact="(mute|cam|flip|deafen|hang)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(order, ['mute', 'cam', 'flip', 'deafen', 'hang']);
  html = LC.overlayHtml(Object.assign({}, baseV, { camOff: true, legs: [Object.assign({}, baseV.legs[0], { cam: true })] }), Object.assign({ flip: true }, H));
  assert(/class="cbtn tog" data-cact="cam"[^>]*aria-label="Kamera"/.test(html) && />v</.test(html) && !/data-cact="flip"/.test(html), 'kamera mati: ikon dicoret, tombol biasa, tanpa balik kamera');
  assert(/class="cvt me camoff wait"/.test(html) && /<span class="cvs">Kamera mati<\/span>/.test(html), 'kartu sendiri menampilkan avatar + keterangan');
  assert(/class="cvt" data-vkey="PEER"/.test(html), 'kartu lawan (kameranya hidup) tidak terpengaruh');
  html = LC.overlayHtml(Object.assign({}, baseV, { legs: [Object.assign({}, baseV.legs[0], { cam: false })] }), H);
  assert(/class="cvt camoff wait" data-vkey="PEER"/.test(html) && /<span class="cvs">Kamera mati<\/span>/.test(html), 'kamera lawan mati: avatar + keterangan, bukan bingkai hitam');
  // panggilan suara (kamera mati, tidak ada yang berkamera): layar suara biasa tapi tombol kamera ada saat tersambung; berdering / undangan / menyambung: tanpa tombol
  const voice = Object.assign({}, baseV, { video: false, camOff: true });
  assert(!/data-vkey/.test(LC.overlayHtml(voice, H)) && /class="cbtn tog" data-cact="cam"[^>]*aria-label="Kamera"/.test(LC.overlayHtml(voice, H)), 'suara saja: layar suara + tombol kamera');
  assert(LC.videoView(Object.assign({}, voice, { legs: [Object.assign({}, baseV.legs[0], { cam: true })] })), 'lawan menyalakan kamera: layar video');
  assert(!LC.videoView(Object.assign({}, baseV, { camOff: true, legs: [Object.assign({}, baseV.legs[0], { cam: false })] })), 'semua kamera mati: kembali ke layar suara');
  for (const [label, v] of [['berdering', { phase: 'ringing', canAccept: true }], ['layar undangan', { invite: true }], ['masih menyambung', { video: false, camOff: true, phase: 'connecting' }]]) {
    assert(!/data-cact="(cam|flip)"/.test(LC.overlayHtml(Object.assign({}, baseV, v), Object.assign({ flip: true }, H))), label + ': tanpa tombol kamera');
  }
  { // channel (langkah 2): tombol kamera selalu ada saat tersambung; menyala = kamera hidup; balik kamera hanya saat hidup
    const ch = Object.assign({}, baseV, { video: false, vc: { cid: 'x', gid: 'g', name: 'c' }, legs: [], camOff: true });
    const hf = Object.assign({ flip: true }, H);
    html = LC.overlayHtml(ch, hf);
    assert(/class="cbtn tog" data-cact="cam"[^>]*aria-label="Kamera"/.test(html) && !/data-cact="flip"/.test(html), 'channel, kamera mati: tombol biasa, tanpa balik kamera');
    html = LC.overlayHtml(Object.assign({}, ch, { camOff: false, video: true }), hf);
    assert(/class="cbtn tog on" data-cact="cam"[^>]*aria-label="Kamera hidup"/.test(html) && /data-cact="flip"/.test(html), 'channel, kamera hidup: tombol menyala + balik kamera');
    assert(!/data-cact="cam"/.test(LC.overlayHtml(Object.assign({}, ch, { phase: 'connecting' }), hf)), 'channel masih menyambung: belum ada tombol kamera');
  }
  const gv = Object.assign({}, baseV, { legs: [{ peer: 'P1', name: 'Budi', state: 'active', video: true }, { peer: 'P2', name: 'Sari', state: 'active' }], peer: 'P1' });
  assert(/data-cact="cam"/.test(LC.overlayHtml(gv, H)), 'grid grup juga punya tombol kamera');
  assert(/data-cact="cam"/.test(LC.overlayHtml(Object.assign({}, gv, { video: false, camOff: true }), H)), 'aku tanpa kamera (hanya melihat lawan): tombol kamera tetap ada, supaya bisa menyalakan');
  ok('overlay: tombol kamera dan balik kamera, status mati, kartu sendiri');

  // 12. kontrak archne-index.html: klik, ikon, balik hanya di perangkat sentuh, mirror hanya kamera depan, CSS
  const idx = require('./_src').htmlSrc();
  assert(/a === 'cam'\) callCtl\.camera\(\)/.test(idx) && /a === 'flip'\) callCtl\.flipCamera\(\)/.test(idx));
  assert(/videoOff: svg\(/.test(idx) && /flip: svg\(/.test(idx));
  assert(/flip: canFlipCam\(\)/.test(idx) && /pointer: coarse/.test(idx) && /nbridge \|\|/.test(idx));
  assert(/v\.facing !== 'environment' \? 'mirror'/.test(idx), 'kamera belakang tidak dicerminkan');
  assert(/#callov \.cvt\.camoff video\{visibility:hidden\}/.test(idx) && /#callov \.cvt\.camoff \.cva\{display:flex\}/.test(idx));
  // mountVideos: balik kamera memasang ulang srcObject dan mencerminkan sesuai arah
  const code = idx.slice(idx.indexOf('// <mountVideos>'), idx.indexOf('// </mountVideos>'));
  const tile = { dataset: { vkey: 'me' }, cls: new Set(), classList: { add: (c) => tile.cls.add(c), remove: (c) => tile.cls.delete(c) }, firstChild: null, insertBefore(el) { el.parentNode = tile; } };
  const els = []; const sets = [];
  const mkEl = () => { const e = { parentNode: null, _s: null, get srcObject() { return this._s; }, set srcObject(x) { this._s = x; sets.push(x); }, play: () => Promise.resolve(), pause() {}, setAttribute() {}, removeChild() {} }; els.push(e); return e; };
  const S = { id: 'S' };
  const cc = { localVideo: () => S, remoteVideo: () => null };
  const { mountVideos } = new Function('$', 'document', 'callCtl', 'LC', code + '\nreturn { mountVideos };')(() => ({ querySelectorAll: () => [tile] }), { createElement: mkEl }, cc, LC);
  mountVideos({ video: true, facing: 'user', vrev: 0 });
  assert.strictEqual(els[0].className, 'mirror');
  const n0 = sets.length; mountVideos({ video: true, facing: 'user', vrev: 0 });
  assert.strictEqual(sets.length, n0, 'render biasa tidak menyentuh srcObject');
  mountVideos({ video: true, facing: 'environment', vrev: 1 });
  assert.strictEqual(els[0].className, '', 'kamera belakang: tidak dicerminkan');
  assert(sets.length > n0 && els[0].srcObject === S, 'revisi baru: srcObject dipasang ulang');
  ok('kontrak archne-index.html: klik, ikon, perangkat sentuh, mirror, pasang ulang srcObject');

  console.log('\ncallcam: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
