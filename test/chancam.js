'use strict';
// Tes langkah 2 (kamera di channel, gaya Discord): masuk hanya suara; tiap kaki membawa jalur video kosong; kamera dinyalakan lewat replaceTrack
// tanpa negosiasi ulang; izin kamera baru diminta saat dinyalakan; kaki yang datang belakangan ikut; mati melepas kamera.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const LC = require('../renderer/archne-call');
const { Core } = require('../src/archne-core');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CH = 'c1'.repeat(8), GID = 'g1'.repeat(8), P = (n) => String(n).repeat(16).slice(0, 16);

const track = (kind) => ({ kind, enabled: true, readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } });
const mkStream = (kinds) => { const ts = kinds.map(track); return { ts, getTracks: () => ts.slice(), getAudioTracks: () => ts.filter((t) => t.kind === 'audio'), getVideoTracks: () => ts.filter((t) => t.kind === 'video'), addTrack(t) { ts.push(t); }, removeTrack(t) { const i = ts.indexOf(t); if (i >= 0) ts.splice(i, 1); } }; };

class FakePC {
  constructor() { this.senders = []; this.trans = []; this.added = []; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { this.added.push(t.kind); const s = { track: t, replaced: [], replaceTrack: async (n) => { s.track = n; s.replaced.push(n); } }; this.senders.push(s); return s; }
  addTransceiver(kind, init) { const s = { track: null, replaced: [], replaceTrack: async (n) => { s.track = n; s.replaced.push(n); } }; const t = { kind, init, sender: s, receiver: { track: { kind } }, direction: (init && init.direction) || 'sendrecv', own: true }; this.trans.push(t); return t; }
  getTransceivers() { return this.trans; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' + (this.trans.some((t) => t.kind === 'video') ? ' m=video' : '') }; }
  async createAnswer() { this.answerDirs = this.trans.filter((t) => t.kind === 'video').map((t) => t.direction); return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { // tawaran bermuatan video -> peramban membuat transceiver recvonly sendiri (bukan yang dibuat addTransceiver)
    if (/m=video/.test(d.sdp || '') && !this.trans.some((t) => t.kind === 'video')) { const s = { track: null, replaced: [], replaceTrack: async (n) => { s.track = n; s.replaced.push(n); } }; this.trans.push({ kind: 'video', sender: s, receiver: { track: { kind: 'video' } }, direction: 'recvonly' }); }
  }
  async addIceCandidate() {}
  close() {}
}
FakePC.all = [];

function mk(opts) {
  opts = opts || {};
  FakePC.all = [];
  let n = 0; const calls = [], asked = [], notices = [];
  const api = new Proxy({}, { get: (_, name) => async (...a) => { calls.push([name, ...a]); if (name === 'callLeg') return { ok: true, cid: ('e' + (++n)).padEnd(16, '0') }; if (name === 'callMedia' && a[3] === true && opts.camFull) return { ok: false, err: 'cam_full' }; return { ok: true, cid: CH }; } });
  const rtc = {
    PeerConnection: FakePC,
    getUserMedia: async (c) => {
      asked.push(c);
      if (c.video && opts.camDenied) { const e = new Error('cam denied'); e.userMsg = 'Izin kamera ditolak'; throw e; }
      return mkStream(c.video && c.audio ? ['audio', 'video'] : c.video ? ['video'] : ['audio']);
    },
    makeStream: (t) => ({ t }), playRemote: () => () => {},
  };
  const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended() {}, notice: (t) => notices.push(t) }, now: () => 1000, setTimeout: () => 1, clearTimeout() {} });
  return { ctl, calls, asked, notices, media: () => calls.filter((c) => c[0] === 'callMedia').map((c) => c.slice(1)), pcs: () => FakePC.all };
}
const flush = () => new Promise((r) => setImmediate(r));
const join = async (m) => { await m.ctl.enterChannel(GID, CH, 'Ngobrol'); await flush(); };

(async () => {
  // 1. masuk = hanya suara: tidak minta kamera, kamera mati, tidak ada kabar kamera
  let m = mk(); await join(m);
  assert.strictEqual(m.ctl.cur.phase, 'active');
  assert.deepStrictEqual(Object.keys(m.asked[0]), ['audio'], 'hanya mikrofon');
  assert.strictEqual(m.ctl.view().camOff, true);
  assert.strictEqual(m.ctl.localVideo(), null);
  m.ctl.mute(true);
  assert.deepStrictEqual(m.media().pop(), [CH, true, false], 'belum pernah menyalakan kamera: tetap tiga argumen');
  ok('masuk channel: suara saja, tanpa izin kamera, kamera mati');

  // 2. kaki keluar (aku penelepon): jalur video kosong sendrecv, audio lewat addTrack, tidak ada addTrack video
  m = mk(); await join(m);
  await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P(2), name: 'Sari' }); await flush();
  let pc = m.pcs()[0];
  assert.deepStrictEqual(pc.added, ['audio']);
  assert.strictEqual(pc.trans.length, 1); assert.deepStrictEqual([pc.trans[0].kind, pc.trans[0].init.direction], ['video', 'sendrecv']);
  const l1 = m.ctl.cur.legs[0]; assert.strictEqual(l1.vsender, pc.trans[0].sender);
  assert(m.calls.find((c) => c[0] === 'callLeg')[3].includes('m=video'), 'tawaran memuat jalur video');
  ok('kaki keluar: jalur video kosong sendrecv, audio lewat addTrack');

  // 3. nyalakan kamera: izin diminta SEKARANG (video saja), replaceTrack di kaki, kabar kamera hidup
  assert.strictEqual(m.asked.filter((c) => c.video).length, 0);
  await m.ctl.camera(true);
  assert.deepStrictEqual(m.asked.filter((c) => c.video).map((c) => Object.keys(c)), [['video']], 'hanya video yang diminta');
  const vt = m.ctl.cur.stream.getVideoTracks()[0];
  assert(vt && l1.vsender.track === vt && pc.added.length === 1 && pc.trans.length === 1, 'trek kamera di jalur video, tanpa jalur baru');
  assert.strictEqual(m.ctl.view().camOff, false); assert(m.ctl.localVideo(), 'pratinjau sendiri');
  assert.deepStrictEqual(m.media().pop(), [CH, false, false, true]);
  ok('kamera dinyalakan: replaceTrack tanpa negosiasi ulang, kabar kamera hidup');

  // 4. kaki yang datang sesudah kamera hidup: ikut mengirim kamera
  await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P(3), name: 'Dewi' }); await flush();
  const l2 = m.ctl.cur.legs[1];
  assert.strictEqual(l2.vsender.track, vt, 'kaki baru langsung membawa kamera');
  assert.deepStrictEqual(m.pcs()[1].added, ['audio'], 'video tetap tidak lewat addTrack');
  ok('kaki baru sesudah kamera hidup ikut mengirim kamera');

  // 5. matikan: semua jalur dikosongkan, kamera dilepas, kabar mati; nyalakan lagi bekerja
  await m.ctl.camera(false);
  assert.strictEqual(l1.vsender.track, null); assert.strictEqual(l2.vsender.track, null);
  assert(vt.stopped, 'kamera dilepas (lampu padam)'); assert.strictEqual(m.ctl.cur.stream.getVideoTracks().length, 0);
  assert.strictEqual(m.ctl.view().camOff, true); assert.strictEqual(m.ctl.localVideo(), null);
  assert.deepStrictEqual(m.media().pop(), [CH, false, false, false]);
  m.ctl.mute(true);
  assert.deepStrictEqual(m.media().pop(), [CH, true, false, false], 'sesudah pernah hidup: kabar kamera ikut terus');
  await m.ctl.camera(true);
  assert.notStrictEqual(l1.vsender.track, null); assert.strictEqual(m.ctl.view().camOff, false);
  await m.ctl.camera(true); // sudah hidup: tidak meminta kamera lagi
  assert.strictEqual(m.asked.filter((c) => c.video).length, 2);
  ok('kamera dimatikan melepas kamera; bisa dinyalakan lagi; tidak minta dua kali');

  // 6. izin kamera ditolak: pemberitahuan, kamera tetap mati, tidak ada kabar kamera, suara aman
  m = mk({ camDenied: true }); await join(m);
  await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P(2), name: 'Sari' }); await flush();
  const r = await m.ctl.camera(true);
  assert.strictEqual(r, true); assert.strictEqual(m.ctl.view().camOff, true);
  assert(m.notices.length === 1 && /Izin kamera ditolak/.test(m.notices[0]), m.notices.join('|'));
  assert.strictEqual(m.media().filter((x) => x.length === 4).length, 0, 'tidak ada kabar kamera');
  assert.strictEqual(m.ctl.cur.phase, 'active');
  ok('izin kamera ditolak: pemberitahuan, kamera tetap mati, channel tetap berjalan');

  // 7. sisi penjawab: jalur video dari tawaran dijadikan sendrecv, dan kamera yang sedang hidup ikut dikirim
  m = mk(); await join(m);
  await m.ctl.camera(true);
  const vt2 = m.ctl.cur.stream.getVideoTracks()[0];
  await m.ctl.onEvent({ ev: 'incoming', auto: true, room: CH, cid: 'f1'.repeat(8), peer: P(4), name: 'Budi', sdp: 'OFFER m=video' }); await flush();
  pc = m.pcs()[0]; const lj = m.ctl.cur.legs[0];
  assert.strictEqual(pc.trans.length, 1, 'tidak membuat jalur video kedua');
  assert.deepStrictEqual(pc.answerDirs, ['sendrecv'], 'jawaban sendrecv (kamera bisa dikirim)');
  assert.strictEqual(lj.vsender, pc.trans[0].sender); assert.strictEqual(lj.vsender.track, vt2);
  ok('penjawab: jalur video tawaran jadi sendrecv dan membawa kamera yang hidup');

  // 8. peer lama (tawaran tanpa video): tidak ada jalur, tidak ada galat, kamera hidup/mati aman
  m = mk(); await join(m);
  await m.ctl.onEvent({ ev: 'incoming', auto: true, room: CH, cid: 'f2'.repeat(8), peer: P(5), name: 'Lama', sdp: 'OFFER' }); await flush();
  assert.strictEqual(m.ctl.cur.legs[0].vsender, null);
  await m.ctl.camera(true); await m.ctl.camera(false);
  assert.strictEqual(m.ctl.cur.phase, 'active'); assert.strictEqual(m.ctl.view().camOff, true);
  ok('peer lama tanpa jalur video: aman, suara tetap jalan');

  // 9. panggilan biasa tidak berubah: tanpa transceiver tambahan, kamera 1-1 tetap lewat addTrack
  m = mk(); await m.ctl.start(P(6), 'Budi', { video: true }); await flush();
  pc = m.pcs()[0];
  assert.strictEqual(pc.trans.length, 0); assert.deepStrictEqual(pc.added, ['audio', 'video']);
  ok('panggilan 1-1 berkamera tidak berubah');

  // ---- Langkah 3: batas 4 kamera ----
  const FULL = /Kamera penuh, maksimal 4/;
  const withLegs = async (m, n) => { for (let i = 0; i < n; i++) { await m.ctl.onEvent({ ev: 'legneed', room: CH, peer: P(i + 2), name: 'U' + i }); await flush(); } return m.ctl.cur.legs; };

  // 11. sudah ada 4 kamera hidup: ditolak sebelum izin kamera diminta
  m = mk(); await join(m);
  let lg = await withLegs(m, 4); lg.forEach((l) => { l.vcam = true; });
  assert.strictEqual(m.ctl.view().camCount, 4); assert.strictEqual(m.ctl.view().camMax, 4);
  await m.ctl.camera(true);
  assert.strictEqual(m.asked.filter((c) => c.video).length, 0, 'tidak meminta izin kamera');
  assert(m.notices.length === 1 && FULL.test(m.notices[0]), m.notices.join('|')); assert.strictEqual(m.ctl.view().camOff, true);
  lg[3].vcam = false; await m.ctl.camera(true); // satu orang mematikan: boleh
  assert.strictEqual(m.ctl.view().camOff, false); assert.strictEqual(m.ctl.view().camCount, 4);
  ok('4 kamera sudah hidup: ditolak tanpa meminta izin; ada yang mati: boleh');

  // 12. Core menolak (kalah balapan): kamera dilepas lagi, tidak pernah dikirim ke siapa pun
  m = mk({ camFull: true }); await join(m); lg = await withLegs(m, 2);
  await m.ctl.camera(true);
  assert.strictEqual(m.asked.filter((c) => c.video).length, 1, 'izin sempat diminta (Core belum tahu penuh)');
  assert(lg.every((l) => l.vsender.replaced.length === 0), 'tidak ada trek yang dipasang ke kaki');
  assert.strictEqual(m.ctl.view().camOff, true); assert.strictEqual(m.ctl.cur.stream.getVideoTracks().length, 0);
  assert(m.notices.length === 1 && FULL.test(m.notices[0]));
  ok('Core menjawab penuh: kamera dilepas, tidak ada yang terkirim');

  // 13. camoff dari Core (kalah urutan sesudah menyala): kamera dilepas, pemberitahuan, kabar mati
  m = mk(); await join(m); lg = await withLegs(m, 2);
  await m.ctl.camera(true); const vt3 = m.ctl.cur.stream.getVideoTracks()[0];
  await m.ctl.onEvent({ ev: 'camoff', room: CH, reason: 'full' });
  assert(vt3.stopped); assert(lg.every((l) => l.vsender.track === null)); assert.strictEqual(m.ctl.view().camOff, true);
  assert(m.notices.length === 1 && FULL.test(m.notices[0]));
  assert.deepStrictEqual(m.media().pop(), [CH, false, false, false]);
  await m.ctl.onEvent({ ev: 'camoff', room: 'z'.repeat(16), reason: 'full' }); // ruang lain: diabaikan
  await m.ctl.onEvent({ ev: 'camoff', room: CH, reason: 'full' }); // sudah mati: diam
  assert.strictEqual(m.notices.length, 1);
  ok('camoff dari Core: kamera dilepas, pemberitahuan sekali, ruang lain diabaikan');

  // 14. panggilan biasa tidak punya camCount
  m = mk(); await m.ctl.start(P(6), 'Budi', { video: true }); await flush();
  assert(!('camCount' in m.ctl.view()));
  ok('panggilan biasa tanpa camCount');

  // 15. Core: batas, urutan, pemutus seri
  const { CALL_CAM_MAX } = require('../src/archne-core');
  assert.strictEqual(CALL_CAM_MAX, 4);
  const mkCore = (vc) => {
    const core = new Core({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cl-')), name: 'Me', discovery: false });
    core.id = core.id || 'm'.repeat(16); const room = CH; if (vc === 'vc') core._vcMe = { cid: room, gid: GID }; else if (vc === 'pv') core._pvMe = { cid: room };
    const sent = [], ev = []; core._callQueue = (l, msg) => sent.push([l.peer, msg]); core.on('call', (e) => ev.push(e));
    const leg = (id, cam, vt, state) => core._calls.set('cid' + id, { cid: 'cid' + id, room, peer: id, state: state || 'active', pst: cam === undefined ? undefined : { muted: false, deafened: false, cam, vt } });
    return { core, room, sent, ev, leg };
  };
  for (const kind of ['vc', 'pv']) {
    let x = mkCore(kind);
    ['a', 'b', 'c', 'd'].forEach((id, i) => x.leg(id, true, 1000 + i));
    assert.strictEqual(x.core.callMedia(x.room, false, false, true), 'full', kind + ': 4 sudah hidup');
    assert.strictEqual(x.sent.length, 0); assert(!(x.core._callMy.get(x.room) || {}).cam, 'tidak disimpan');
    x = mkCore(kind); ['a', 'b', 'c'].forEach((id, i) => x.leg(id, true, 1000 + i)); x.leg('e', true, 1, 'connecting'); // yang belum aktif tidak dihitung
    assert.strictEqual(x.core.callMedia(x.room, false, false, true), true, kind + ': 3 hidup -> boleh');
    assert.strictEqual(x.sent.length, 3); const m0 = x.sent[0][1];
    assert(m0.v === 1 && Number.isFinite(m0.vt) && Math.abs(m0.vt - Date.now()) < 5000, 'v dan vt terkirim');
    const mine = x.core._callMy.get(x.room); assert(mine.cam === true && mine.vt === m0.vt);
    x.sent.length = 0; x.core.callMedia(x.room, true, false); // mute tanpa kabar kamera: kamera & vt tetap
    assert.deepStrictEqual(x.core._callMy.get(x.room), { muted: true, deafened: false, cam: true, vt: mine.vt }); assert(!('v' in x.sent[0][1]));
    x.core.callMedia(x.room, true, false, true); // sudah hidup: tidak dihitung ulang, vt tetap
    assert.strictEqual(x.core._callMy.get(x.room).vt, mine.vt);
    x.core.callMedia(x.room, true, false, false);
    assert.deepStrictEqual(x.core._callMy.get(x.room), { muted: true, deafened: false, cam: false });
  }
  ok('Core: 4 kamera hidup -> penuh; yang belum aktif tidak dihitung; vt dibawa; cam dipertahankan saat mute');

  // 16. pemutus seri / kalah balapan
  let x = mkCore('vc');
  ['a', 'b', 'c', 'd'].forEach((id, i) => x.leg(id, true, 1000 + i * 10));
  x.core._callMy.set(x.room, { muted: false, deafened: true, cam: true, vt: 5000 }); // aku kelima
  x.core._camEnforce(x.room);
  assert.strictEqual(x.core._callMy.get(x.room).cam, false);
  assert(x.sent.length === 4 && x.sent.every(([, msg]) => msg.v === 0 && msg.m === 1 && msg.d === 1), 'kabar mati ke semua kaki');
  assert.deepStrictEqual(x.ev.filter((e) => e.ev === 'camoff'), [{ ev: 'camoff', room: x.room, reason: 'full' }]);
  x = mkCore('vc'); ['a', 'b', 'c', 'd'].forEach((id, i) => x.leg(id, true, 1000 + i * 10));
  x.core._callMy.set(x.room, { muted: false, deafened: false, cam: true, vt: 1015 }); // aku ketiga dari lima: tetap
  x.core._camEnforce(x.room);
  assert.strictEqual(x.core._callMy.get(x.room).cam, true); assert.strictEqual(x.sent.length, 0);
  x = mkCore('vc'); ['a', 'b', 'c', 'd'].forEach((id) => x.leg(id, true, 7000)); // vt sama: id terkecil menang
  x.core._callMy.set(x.room, { muted: false, deafened: false, cam: true, vt: 7000 }); x.core.id = 'zz' + 'm'.repeat(14);
  x.core._camEnforce(x.room); assert.strictEqual(x.core._callMy.get(x.room).cam, false, 'seri: id lebih besar kalah');
  x = mkCore('vc'); ['b', 'c', 'd', 'e'].forEach((id) => x.leg(id, true, 7000)); x.core.id = 'a' + 'm'.repeat(15);
  x.core._callMy.set(x.room, { muted: false, deafened: false, cam: true, vt: 7000 }); x.core._camEnforce(x.room);
  assert.strictEqual(x.core._callMy.get(x.room).cam, true, 'seri: id lebih kecil menang');
  ok('Core: yang di luar 4 teratas mematikan kameranya sendiri; seri diputus id; urutan sama di semua peserta');

  // 17. di luar channel (panggilan grup) batas tidak berlaku
  x = mkCore(null); ['a', 'b', 'c', 'd', 'e'].forEach((id, i) => x.leg(id, true, 1000 + i));
  assert.strictEqual(x.core.callMedia(x.room, false, false, true), true); x.core._camEnforce(x.room); assert.strictEqual(x.ev.length, 0);
  ok('batas hanya untuk channel');

  // 18. ipc meneruskan "penuh" sebagai galat yang bisa dikenali
  assert(/r === 'full' \? \{ ok: false, err: 'cam_full' \}/.test(fs.readFileSync(path.join(__dirname, '../src/archne-ipc.js'), 'utf8')));
  ok('ipc: penuh -> { ok:false, err:cam_full }');

  // ---- Langkah 5 (Android): kamera channel dimatikan saat aplikasi ke latar belakang ----
  const BG = /Kamera dimatikan saat aplikasi di latar belakang/;
  m = mk(); await join(m); lg = await withLegs(m, 2);
  await m.ctl.camera(true); const vt5 = m.ctl.cur.stream.getVideoTracks()[0];
  await m.ctl.appHidden(true);
  assert(vt5.stopped, 'kamera dilepas'); assert(lg.every((l) => l.vsender.track === null)); assert.strictEqual(m.ctl.view().camOff, true);
  assert.deepStrictEqual(m.media().pop(), [CH, false, false, false], 'lawan tahu kamera mati (kartu hilang, slot 4 kosong)');
  assert.strictEqual(m.notices.length, 0, 'tidak ada pemberitahuan saat di latar belakang');
  await m.ctl.appHidden(true); assert.strictEqual(m.notices.length, 0, 'berulang: diam');
  await m.ctl.appHidden(false);
  assert(m.notices.length === 1 && BG.test(m.notices[0]), m.notices.join('|'));
  assert.strictEqual(m.ctl.view().camOff, true, 'kembali ke aplikasi: tidak menyala sendiri');
  assert.strictEqual(m.asked.filter((c) => c.video).length, 1, 'tidak meminta kamera lagi');
  await m.ctl.appHidden(false); assert.strictEqual(m.notices.length, 1, 'pemberitahuan sekali');
  ok('channel: ke latar belakang mematikan kamera, kembali memberi tahu sekali dan tidak menyalakan sendiri');

  m = mk(); await join(m);
  await m.ctl.appHidden(true); await m.ctl.appHidden(false); // kamera memang mati
  assert.strictEqual(m.notices.length, 0); assert.strictEqual(m.media().filter((x) => x.length === 4).length, 0);
  await m.ctl.camera(true); await m.ctl.appHidden(true); await m.ctl.camera(true); await m.ctl.appHidden(false); // dinyalakan sendiri lagi sebelum kembali
  assert.strictEqual(m.notices.length, 0, 'sudah dinyalakan lagi: tanpa pemberitahuan'); assert.strictEqual(m.ctl.view().camOff, false);
  ok('kamera memang mati / dinyalakan lagi sendiri: tanpa pemberitahuan');

  m = mk(); await m.ctl.start(P(6), 'Budi', { video: true }); await flush();
  m.pcs()[0].state = () => {}; const before = m.media().length;
  await m.ctl.appHidden(true); await m.ctl.appHidden(false);
  assert.strictEqual(m.ctl.view().camOff, false); assert.strictEqual(m.notices.length, 0); assert.strictEqual(m.media().length, before);
  await new LC.Controller({ api: {}, rtc: {}, ui: {} }).appHidden(true); // tanpa panggilan: aman
  ok('panggilan 1-1 berkamera dan tanpa panggilan tidak disentuh');

  // 10. Core: jalur video kosong di ruang channel tidak menandai panggilan sebagai video
  const core = new Core({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cc-')), name: 'X', discovery: false });
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
  assert.strictEqual(core._vidLeg(CH, sdp), true, 'bukan channel: video');
  core._vcMe = { cid: CH, gid: GID };
  assert.strictEqual(core._vidLeg(CH, sdp), false, 'channel grup: bukan video');
  core._vcMe = null; core._pvMe = { cid: CH };
  assert.strictEqual(core._vidLeg(CH, sdp), false, 'channel publik: bukan video');
  ok('Core: jalur video kosong di channel tidak dianggap panggilan video');

  console.log('\nchancam: ' + pass + ' OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
