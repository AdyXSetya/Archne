'use strict';
// Tes video tahap 1: lapisan media Controller (kamera di getUserMedia, trek video di PeerConnection, stream video lawan, jatuh ke suara saja).
// Belum ada UI. Kamera sungguhan hanya bisa diuji di perangkat.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8);

class FakePC {
  constructor() { this.senders = []; this.closed = false; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { const s = { track: t, replaceTrack: async (n) => { s.track = n; } }; this.senders.push(s); return s; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.closed = true; }
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
const track = (kind) => ({ kind, enabled: true, stopped: false, stop() { this.stopped = true; } });
const mkStream = (kinds) => { const ts = kinds.map(track); return { ts, getTracks: () => ts, getAudioTracks: () => ts.filter((t) => t.kind === 'audio'), getVideoTracks: () => ts.filter((t) => t.kind === 'video') }; };

function mk(opts) {
  opts = opts || {};
  FakePC.all = [];
  let now = 1000; const asked = [], streams = [], renders = [], ended = [];
  const api = new Proxy({}, { get: () => async () => ({ ok: true, cid: CID }) });
  const rtc = {
    PeerConnection: FakePC,
    getUserMedia: async (c) => {
      asked.push(c);
      if (c.video && opts.camDenied) { const e = new Error('NotAllowedError'); e.name = 'NotAllowedError'; throw e; }
      if (opts.micDenied) throw new Error('mic');
      const st = mkStream(c.video ? ['audio', 'video'] : ['audio']); streams.push(st); return st;
    },
    makeStream: (tr) => ({ tr }),
    playRemote: () => () => {},
  };
  const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended: (i) => ended.push(i) }, now: () => now, setTimeout: () => 1, clearTimeout() {} });
  return { ctl, asked, streams, renders, ended, pc: () => FakePC.all[FakePC.all.length - 1] };
}
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // 1. fungsi murni
  assert.strictEqual(LC.sdpHasVideo('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'), true);
  assert.strictEqual(LC.sdpHasVideo('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'), false);
  assert.strictEqual(LC.sdpHasVideo('m=video 0 UDP/TLS/RTP/SAVPF 96\r\n'), false, 'bagian video ditolak (port 0) bukan video');
  assert.strictEqual(LC.sdpHasVideo(undefined), false);
  assert.strictEqual(LC.videoConstraints().facingMode, 'user');
  assert.strictEqual(LC.videoConstraints('environment').facingMode, 'environment');
  ok('sdpHasVideo dan videoConstraints');

  // 2. telepon suara biasa: tidak minta kamera, bentuk constraint tidak berubah
  let m = mk();
  await m.ctl.start('p'.repeat(64), 'Budi'); await flush();
  assert.deepStrictEqual(Object.keys(m.asked[0]), ['audio']);
  assert.strictEqual(m.ctl.view().video, false);
  assert.strictEqual(m.ctl.localVideo(), null);
  ok('panggilan suara tidak meminta kamera');

  // 3. telepon video: audio + video diminta, kedua trek masuk ke PeerConnection, sender audio dan video terpisah
  m = mk();
  await m.ctl.start('p'.repeat(64), 'Budi', { video: true }); await flush();
  assert(m.asked[0].video && m.asked[0].audio, 'audio dan video diminta');
  assert.strictEqual(m.ctl.view().video, true);
  assert.strictEqual(m.ctl.localVideo(), m.streams[0]);
  const pc = m.pc();
  assert.deepStrictEqual(pc.senders.map((s) => s.track.kind), ['audio', 'video']);
  const leg = m.ctl.cur.legs[0];
  assert.strictEqual(leg.sender, pc.senders[0], 'l.sender tetap sender audio (untuk peredam bising)');
  assert.strictEqual(leg.vsender, pc.senders[1]);
  ok('panggilan video: kamera diminta, trek audio dan video terpisah');

  // 4. video lawan masuk lewat ontrack: disimpan per kaki, tidak diputar sebagai audio
  const rv = { id: 'remote-video' };
  pc.ontrack({ track: { kind: 'video' }, streams: [rv] });
  assert.strictEqual(m.ctl.remoteVideo('p'.repeat(64)), rv);
  assert.strictEqual(m.ctl.view().legs[0].video, true);
  assert.strictEqual(m.ctl.remoteVideo('x'.repeat(64)), null);
  ok('stream video lawan tersimpan per kaki');

  // 5. mute hanya menyentuh audio, tidak mematikan video
  m.ctl.mute && m.ctl.mute(true);
  assert.strictEqual(m.streams[0].ts[1].enabled, true, 'video tidak ikut dibisukan');
  ok('mute tidak mematikan video');

  // 6. akhir panggilan: semua trek (termasuk video) dihentikan, video lawan dilepas
  await m.ctl.hangup(); await flush();
  assert(m.streams[0].ts.every((t) => t.stopped), 'kamera dilepas');
  assert.strictEqual(m.ctl.localVideo(), null);
  assert.strictEqual(m.ctl.remoteVideo('p'.repeat(64)), null);
  ok('kamera dilepas saat panggilan berakhir');

  // 7. kamera ditolak: jatuh ke suara saja, panggilan tetap jalan, alasan tersedia
  m = mk({ camDenied: true });
  await m.ctl.start('p'.repeat(64), 'Budi', { video: true }); await flush();
  assert.strictEqual(m.asked.length, 2, 'coba video, lalu suara saja');
  assert(!m.asked[1].video);
  assert.strictEqual(m.ctl.view().video, false);
  assert(/Kamera tidak bisa dipakai/.test(m.ctl.view().camErr));
  assert(m.ctl.cur && m.ctl.cur.stream, 'panggilan tetap berjalan');
  ok('kamera ditolak: lanjut suara saja dengan pesan');

  // 8. mikrofon ditolak total: tetap gagal 'mic'
  m = mk({ camDenied: true, micDenied: true });
  await m.ctl.start('p'.repeat(64), 'Budi', { video: true }); await flush();
  assert.strictEqual(m.ctl.cur, null);
  assert.strictEqual(m.ended[0].reason, 'mic');
  ok('mikrofon ditolak total tetap menutup panggilan');

  // 9. penerima: tawaran berisi video -> kamera ikut diminta; tawaran suara -> tidak
  for (const [sdp, want] of [['v=0\r\nm=audio 9 X 111\r\nm=video 9 X 96\r\n', true], ['v=0\r\nm=audio 9 X 111\r\n', false]]) {
    m = mk();
    m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'p'.repeat(64), name: 'Budi', sdp, ice: [] });
    await m.ctl.accept(); await flush();
    assert.strictEqual(!!m.asked[0].video, want);
    assert.strictEqual(m.ctl.view().video, want);
  }
  ok('penerima menyalakan kamera hanya untuk tawaran video');


  // 10. layar dering menyebut video; kamera belum dinyalakan sebelum dijawab
  m = mk();
  m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'p'.repeat(64), name: 'Budi', sdp: 'v=0\r\nm=audio 9 X 111\r\nm=video 9 X 96\r\n', ice: [] });
  assert.strictEqual(m.ctl.view().video, true);
  assert.strictEqual(m.asked.length, 0, 'belum ada getUserMedia sebelum dijawab');
  const ov = LC.overlayHtml(m.ctl.view(), { esc: (x) => x, avatar: () => '', icons: {} });
  assert(/Panggilan video masuk/.test(ov) && !/Panggilan suara masuk/.test(ov));
  m = mk();
  m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'p'.repeat(64), name: 'Budi', sdp: 'v=0\r\nm=audio 9 X 111\r\n', ice: [] });
  assert(/Panggilan suara masuk/.test(LC.overlayHtml(m.ctl.view(), { esc: (x) => x, avatar: () => '', icons: {} })));
  ok('layar dering: "Panggilan video masuk" vs "Panggilan suara masuk"');

  // 11. kamera gagal -> ui.notice dipanggil sekali
  const notes = [];
  FakePC.all = [];
  { const api = new Proxy({}, { get: () => async () => ({ ok: true, cid: CID }) });
    let n = 0;
    const rtc = { PeerConnection: FakePC, getUserMedia: async (c) => { n++; if (c.video) throw new Error('NotFoundError'); return mkStream(['audio']); }, makeStream: (t) => ({ t }), playRemote: () => () => {} };
    const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended() {}, notice: (t) => notes.push(t) }, now: () => 1, setTimeout: () => 1, clearTimeout() {} });
    await ctl.start('p'.repeat(64), 'Budi', { video: true }); await flush();
    assert.strictEqual(n, 2); assert.strictEqual(notes.length, 1); assert(/tanpa video/.test(notes[0])); }
  ok('kamera gagal memunculkan notifikasi sekali');

  // 12. layout video 1-1: dua kartu (lawan lalu kamu), tanpa <video> di HTML string; dering tetap layar avatar
  const H = { esc: (x) => x, avatar: (id) => '[av:' + id + ']', icons: { mic: 'M', micOff: 'm', head: 'H', headOff: 'h', phone: 'P' }, meId: 'ME' };
  const baseV = { phase: 'active', video: true, peer: 'PEER', name: 'Budi', muted: false, deafened: false, since: 1, noise: 'standard', legs: [{ peer: 'PEER', name: 'Budi', state: 'active', muted: false, deafened: false }], invites: [], members: [] };
  let html = LC.overlayHtml(baseV, H);
  const keys = [...html.matchAll(/data-vkey="([^"]*)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(keys, ['PEER', 'me'], 'urutan: lawan di atas, kamu di bawah');
  assert(!/<video/.test(html), 'elemen video tidak dibuat di HTML string');
  assert(/class="cvt me"/.test(html) && /id="calltime"/.test(html) && /data-cact="hang"/.test(html), 'kartu sendiri, timer, tombol akhiri');
  assert(!/data-vkey/.test(LC.overlayHtml(Object.assign({}, baseV, { video: false }), H)), 'tanpa video: layar lama');
  assert(!/data-vkey/.test(LC.overlayHtml(Object.assign({}, baseV, { phase: 'ringing', canAccept: true }), H)), 'berdering: layar avatar');
  assert(/data-vkey/.test(LC.overlayHtml(Object.assign({}, baseV, { phase: 'dialing' }), H)), 'memanggil: pratinjau kamera sendiri sudah tampil');
  ok('layout kartu video 1-1');

  // 13. mountVideos (diambil dari archne-index.html): elemen video menetap, dipasang ulang ke kartu baru, dilepas saat video hilang
  const fs = require('fs'), path = require('path');
  const src = require('./_src').htmlSrc();
  const code = src.slice(src.indexOf('// <mountVideos>'), src.indexOf('// </mountVideos>'));
  const mkTile = (key) => { const t = { dataset: { vkey: key }, kids: [], cls: new Set(), classList: { add: (c) => t.cls.add(c), remove: (c) => t.cls.delete(c) }, insertBefore(el) { if (el.parentNode) el.parentNode.removeChild(el); el.parentNode = t; t.kids.unshift(el); }, removeChild(c) { t.kids = t.kids.filter((x) => x !== c); c.parentNode = null; } }; return t; };
  const mkVideo = () => { const el = { plays: 0, parentNode: null, srcObject: null, attrs: {}, play() { el.plays++; return Promise.resolve(); }, pause() { el.paused = true; }, setAttribute(k) { el.attrs[k] = 1; }, removeChild(c) { el.kids = (el.kids || []).filter((x) => x !== c); c.parentNode = null; } }; return el; };
  let tiles = [mkTile('PEER'), mkTile('me')];
  const root = { querySelectorAll: () => tiles };
  const created = [];
  const localS = { id: 'L' }, remoteS = { id: 'R' };
  let hasRemote = false;
  const callCtl = { localVideo: () => localS, remoteVideo: (k) => (hasRemote && k === 'PEER' ? remoteS : null) };
  const sandbox = new Function('$', 'document', 'callCtl', 'LC', code + '\nreturn { mountVideos, vidEls };');
  const { mountVideos, vidEls } = sandbox(() => root, { createElement: () => { const e = mkVideo(); created.push(e); return e; } }, callCtl, LC);
  mountVideos({ video: true });
  assert.strictEqual(created.length, 1, 'hanya kamera sendiri (video lawan belum ada)');
  assert(tiles[1].cls.has('hasv') && !tiles[0].cls.has('hasv'), 'kartu lawan tetap menampilkan avatar');
  assert(created[0].muted && created[0].autoplay && created[0].attrs.playsinline && created[0].className === 'mirror');
  hasRemote = true; mountVideos({ video: true });
  assert.strictEqual(created.length, 2); assert(tiles[0].cls.has('hasv')); assert.strictEqual(created[1].srcObject, remoteS);
  const mine = created[0], plays = mine.plays;
  tiles = [mkTile('PEER'), mkTile('me')]; // HTML dirender ulang: kartu baru
  mountVideos({ video: true });
  assert.strictEqual(created.length, 2, 'elemen video dipakai ulang, bukan dibuat baru');
  assert.strictEqual(tiles[1].kids[0], mine); assert(mine.plays > plays, 'play() dipanggil lagi setelah dipasang ulang');
  mountVideos(null);
  assert.strictEqual(vidEls.size, 0); assert(mine.paused && mine.srcObject === null);
  ok('mountVideos: elemen menetap, dipasang ulang, dibersihkan saat panggilan selesai');

  // 14. grup: grid 2 kolom, lawan-lawan lalu undangan menunggu, kamu terakhir; layout juga dipakai bila hanya lawan yang mengirim video
  const gv = { phase: 'active', video: true, peer: 'P1', name: 'Budi', muted: false, deafened: false, since: 1, noise: 'standard', invite: false, members: [],
    legs: [{ peer: 'P1', name: 'Budi', state: 'active', video: true }, { peer: 'P2', name: 'Sari', state: 'connecting' }], invites: [{ peer: 'P3', name: 'Dewi' }] };
  html = LC.overlayHtml(gv, H);
  assert.deepStrictEqual([...html.matchAll(/data-vkey="([^"]*)"/g)].map((x) => x[1]), ['P1', 'P2', 'P3', 'me']);
  assert(/class="cvg grid"/.test(html) && /Panggilan grup/.test(html) && !/<video/.test(html));
  assert(/Menyambung…/.test(html) && /Mengundang…/.test(html), 'kartu yang belum tersambung diberi status');
  assert(LC.videoView(Object.assign({}, gv, { video: false })), 'aku tanpa kamera tapi lawan kirim video: tetap grid');
  assert(!LC.videoView(Object.assign({}, gv, { video: false, legs: [{ peer: 'P1', state: 'active' }] })), 'tanpa video sama sekali: layar lama');
  assert(!LC.videoView(Object.assign({}, gv, { vc: { cid: 'x' } })) && !LC.videoView(Object.assign({}, gv, { invite: true })) && !LC.videoView(null));
  assert(/class="cpl"/.test(LC.overlayHtml(Object.assign({}, gv, { video: false, legs: gv.legs.map((x) => ({ peer: x.peer, name: x.name, state: x.state })) }), H)), 'grup tanpa video tetap list lama');
  ok('grid grup + videoView');

  // 15. Controller: undangan dari ruang video membawa penanda; undangan masuk bertanda video menyalakan kamera saat diterima
  { const calls = [];
    const api = new Proxy({}, { get: (_t, n) => async (...a) => { calls.push([n, ...a]); return { ok: true, cid: CID }; } });
    const asked = [];
    const rtc = { PeerConnection: FakePC, getUserMedia: async (c) => { asked.push(c); return mkStream(c.video ? ['audio', 'video'] : ['audio']); }, makeStream: (t) => ({ t }), playRemote: () => () => {} };
    const mkc = () => new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended() {} }, now: () => 1, setTimeout: () => 1, clearTimeout() {} });
    for (const video of [true, false]) {
      calls.length = 0;
      const ctl = mkc();
      await ctl.start('p'.repeat(64), 'Budi', { video }); await flush();
      ctl.cur.legs[0].cid = CID; ctl.cur.legs[0].phase = 'active'; ctl.cur.phase = 'active';
      await ctl.invite('q'.repeat(64), 'Sari');
      const call = calls.find((x) => x[0] === 'callInvite');
      assert.deepStrictEqual(call, video ? ['callInvite', CID, 'q'.repeat(64), true] : ['callInvite', CID, 'q'.repeat(64)], 'penanda hanya dikirim untuk ruang video');
      await ctl.hangup(); await flush();
    }
    const ctl = mkc(); asked.length = 0;
    ctl.onEvent({ ev: 'invited', room: CID, peer: 'p'.repeat(64), name: 'Budi', members: [], video: true });
    assert.strictEqual(ctl.view().video, true); assert.strictEqual(asked.length, 0, 'kamera belum menyala sebelum diterima');
    await ctl.accept(); await flush();
    assert(asked[0] && asked[0].video, 'diterima: kamera diminta');
    const ctl2 = mkc(); asked.length = 0;
    ctl2.onEvent({ ev: 'invited', room: CID, peer: 'p'.repeat(64), name: 'Budi', members: [] });
    await ctl2.accept(); await flush();
    assert(asked[0] && !('video' in asked[0]), 'undangan suara: tanpa kamera'); }
  ok('Controller: penanda video pada undangan keluar dan masuk');

  // 16. perbesar kartu: satu kartu penuh + tombol kembali; kartu lain tetap ada (video tidak dicopot); kunci basi diabaikan
  const H2 = Object.assign({}, H, { icons: Object.assign({}, H.icons, { shrink: 'S' }) });
  html = LC.overlayHtml(gv, H2);
  assert(!/cvx|class="cvg grid focus"| big/.test(html), 'tanpa fokus: grid biasa, tanpa tombol kembali');
  assert((html.match(/data-cact="focus"/g) || []).length === 4, 'tiap kartu bisa diketuk');
  html = LC.overlayHtml(gv, Object.assign({ focus: 'P2' }, H2));
  assert(/class="cvg grid focus"/.test(html));
  assert.strictEqual((html.match(/class="cvt[^"]*\bbig\b/g) || []).length, 1, 'hanya satu kartu besar');
  assert(/class="cvt wait big" data-vkey="P2"/.test(html));
  assert.strictEqual((html.match(/data-cact="unfocus"/g) || []).length, 1, 'satu tombol kembali, di kartu besar');
  assert.deepStrictEqual([...html.matchAll(/data-vkey="([^"]*)"/g)].map((x) => x[1]), ['P1', 'P2', 'P3', 'me'], 'kartu lain tetap di HTML');
  assert(/class="cvt me big"/.test(LC.overlayHtml(gv, Object.assign({ focus: 'me' }, H2))), 'kamera sendiri juga bisa diperbesar');
  assert(!/focus"|cvx/.test(LC.overlayHtml(gv, Object.assign({ focus: 'GONE' }, H2)).replace(/data-cact="focus"/g, '')), 'peserta sudah keluar: kembali ke grid');
  html = LC.overlayHtml(baseV, Object.assign({ focus: 'PEER' }, H2));
  assert(/class="cvg focus"/.test(html) && /class="cvt[^"]*\bbig\b" data-vkey="PEER"/.test(html), '1-1 juga bisa diperbesar');
  // kontrak archne-index.html: ketukan, tombol kembali, papan ketik, dan reset saat panggilan bukan tampilan video
  const idx = require('./_src').htmlSrc();
  assert(/a === 'focus'\) \{ vidFocus = b\.dataset\.vfocus/.test(idx) && /a === 'unfocus'\) \{ vidFocus = null/.test(idx));
  assert(/focus: vidFocus/.test(idx) && /if \(!LC\.videoView\(v\)\) vidFocus = null/.test(idx) && /t\.dataset\.vfocus\) \{ e\.preventDefault\(\); vidFocus/.test(idx));
  assert(/\.cvg\.focus \.cvt:not\(\.big\)\{display:none\}/.test(idx) && /shrink: svg\(/.test(idx));
  ok('perbesar kartu video + tombol kembali');

  console.log('\ncallvideo: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
