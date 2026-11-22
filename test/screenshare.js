'use strict';
// Tes Fase B berbagi layar (v0.32.0): sinyal layar (medan s di pesan st) dan Controller.startScreen/stopScreen.
// Core: callMedia(..., cam, scr) -> peerstate.scr + callInfo.scr; peer v0.31 (tanpa s) dan nilai aneh tidak mengubah apa pun; jenis pesan asing diabaikan.
// Controller: mulai/berhenti tanpa memutus panggilan, kamera dipulihkan, trek ended, satu pembagi per panggilan, batas bitrate, rtc tanpa getDisplayMedia.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const LC = require('../renderer/archne-call');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-scr-'));
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
  // layar dikabarkan saat masih memanggil: dikirim begitu kaki aktif (replay untuk kaki baru)
  assert.strictEqual(A.callMedia(room, false, false, true, true), true);
  await until(() => A.getState().call.state === 'active' && B.getState().call.state === 'active', 5000, 'aktif');
  await until(() => ps(eb).length >= 1, 5000, 'B menerima kabar layar');
  assert.strictEqual(ps(eb)[0].cam, true); assert.strictEqual(ps(eb)[0].scr, true);
  assert.strictEqual(B.getState().call.cam, true); assert.strictEqual(B.getState().call.scr, true, 'callInfo membawa scr');
  ok('layar yang dikabarkan sebelum aktif sampai ke kaki yang baru tersambung (cam + scr)');

  // mute saat berbagi (tanpa kabar kamera/layar): layar tetap
  let n0 = ps(eb).length;
  A.callMedia(room, true, false);
  await until(() => ps(eb).length === n0 + 1, 5000, 'mute');
  assert.strictEqual(ps(eb)[n0].scr, true, 'mute tidak menutup layar'); assert.strictEqual(B.getState().call.scr, true);
  A.callMedia(room, true, false, true); // controller mengirim cam=true tanpa scr saat mute: layar tetap
  await until(() => ps(eb).length === n0 + 2, 5000, 'mute + cam');
  assert.strictEqual(ps(eb)[n0 + 1].scr, true);
  ok('mute saat berbagi tidak menutup layar (dengan atau tanpa kabar kamera)');

  // layar ditutup (cam tetap hidup = kamera kembali)
  A.callMedia(room, false, false, true, false);
  await until(() => ps(eb).length === n0 + 3, 5000, 'layar ditutup');
  assert.strictEqual(ps(eb)[n0 + 2].scr, false); assert.strictEqual(ps(eb)[n0 + 2].cam, true);
  assert(!('scr' in B.getState().call), 'callInfo tanpa scr setelah ditutup');
  // buka lagi, lalu kamera dimatikan: layar ikut tertutup
  A.callMedia(room, false, false, true, true);
  await until(() => ps(eb).length === n0 + 4, 5000, 'layar dibuka lagi');
  assert.strictEqual(B.getState().call.scr, true);
  A.callMedia(room, false, false, false);
  await until(() => ps(eb).length === n0 + 5, 5000, 'cam mati');
  assert.strictEqual(ps(eb)[n0 + 4].cam, false); assert.strictEqual(ps(eb)[n0 + 4].scr, false, 'v=0 menutup layar');
  assert(!('scr' in B.getState().call));
  ok('layar bisa ditutup/dibuka lagi; kamera mati selalu menutup layar');

  // peer lama: tanpa s -> bentuk event tidak berubah, tidak ada scr
  const l = A._legs(room)[0], lb = [...B._calls.values()][0];
  n0 = ps(eb).length;
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 1 });
  await until(() => ps(eb).length === n0 + 1, 5000, 'st gaya v0.31');
  assert(!('scr' in ps(eb)[n0]), 'tanpa s: event tanpa scr'); assert(!lb.pst.scr);
  ok('pesan st gaya v0.31 (tanpa s) tidak berubah bentuknya dan tidak pernah menjadi layar');

  // F.4: nilai aneh ditolak; s=1 tanpa kamera hidup tidak jadi layar; jenis pesan asing diabaikan tanpa galat
  n0 = ps(eb).length;
  for (const bad of [2, 'x', -1, null, {}, true]) A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 1, s: bad });
  A._callQueue(l, { t: 'screen:start', cid: l.cid });
  A._callQueue(l, { t: 'screen', cid: l.cid, s: 1 });
  await sleep(500);
  assert.strictEqual(ps(eb).length, n0, 'nilai s tidak sah dan jenis pesan asing: tidak ada event');
  A._callQueue(l, { t: 'st', cid: l.cid, m: 0, d: 0, v: 0, s: 1 });
  await until(() => ps(eb).length === n0 + 1, 5000, 's=1 tanpa kamera');
  assert(!('scr' in ps(eb)[n0]), 's=1 tanpa kamera: tidak ada kabar layar');
  assert(!lb.pst.scr, 'kamera mati: tidak pernah dianggap layar');
  assert.strictEqual(B.getState().call.state, 'active', 'panggilan tetap aktif');
  ok('s tidak sah ditolak, s=1 tanpa kamera diabaikan, jenis pesan asing tidak mengganggu panggilan');
  for (const n of [A, B]) try { await n.stop(); } catch {}

  // ---------- Controller ----------
  const CID = 'a1'.repeat(8), PEER = 'p'.repeat(64);
  class FakeSender {
    constructor() { this.tracks = []; this.params = { encodings: [{}] }; this.set = []; }
    async replaceTrack(t) { this.tracks.push(t); }
    getParameters() { return JSON.parse(JSON.stringify(this.params)); }
    async setParameters(p) { this.set.push(p); this.params = p; }
  }
  class FakePC {
    constructor() { this.senders = []; this.vsenders = []; FakePC.all.push(this); this.connectionState = 'new'; }
    addTrack(t) { const s = new FakeSender(); s.track = t; this.senders.push(s); if (t.kind === 'video') this.vsenders.push(s); return s; }
    addTransceiver() { const s = new FakeSender(); this.vsenders.push(s); return { sender: s }; }
    async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    close() {}
    state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
  }
  FakePC.all = [];
  let tid = 0;
  const track = (kind) => { const t = { id: ++tid, kind, enabled: true, readyState: 'live', ls: {}, stopped: 0, stop() { this.stopped++; this.readyState = 'ended'; }, addEventListener(ev, f) { (this.ls[ev] = this.ls[ev] || []).push(f); }, fire(ev) { for (const f of this.ls[ev] || []) f(); } }; return t; };
  const stream = (ts) => { const s = { ts: ts.slice(), getTracks: () => s.ts.slice(), getAudioTracks: () => s.ts.filter((t) => t.kind === 'audio'), getVideoTracks: () => s.ts.filter((t) => t.kind === 'video'), addTrack(t) { s.ts.push(t); }, removeTrack(t) { s.ts = s.ts.filter((x) => x !== t); } }; return s; };
  const ctlMk = (o) => {
    o = o || {};
    FakePC.all = [];
    const calls = [], notices = [], screens = [], cams = [];
    const api = new Proxy({}, { get: (_, name) => async (...a) => { calls.push([name, ...a]); return name === 'callMedia' && o.full ? { ok: false, err: 'cam_full' } : { ok: true, cid: CID }; } });
    const rtc = { PeerConnection: FakePC, makeStream: (t) => stream(t), playRemote: () => () => {},
      getUserMedia: async (c) => { const ts = c.video ? [track('audio'), track('video')] : [track('audio')]; if (c.video) cams.push(ts[ts.length - 1]); return stream(ts); } };
    const mixes = [], sysTracks = [];
    if (o.noScreen !== true) rtc.getDisplayMedia = async (opts) => {
      if (o.deny) { const e = new Error('x'); e.name = o.deny; throw e; }
      const t = track('video'); screens.push(t);
      if (!o.sys) return stream([t]);
      const a = track('audio'); a.getSettings = () => (o.sup ? { suppressLocalAudioPlayback: true } : {}); sysTracks.push(a); // audio sistem ada hanya bila pemilih mengembalikannya
      return stream([t, a]);
    };
    if (o.mix !== false) rtc.mixAudio = (mic, sys) => { if (o.mix === 'null') return null; const mt = track('audio'); const mx = { mic, sys, stream: stream([mt]), track: mt, stopped: 0, stop() { this.stopped++; } }; mixes.push(mx); return mx; };
    if (o.strong) rtc.strengthen = async (st) => ({ src: st, stream: stream([track('audio')]), stopped: 0, stop() { this.stopped++; } });
    const ended = [];
    const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring() {}, ended(i) { ended.push(i); }, notice(t) { notices.push(t); } }, now: () => 1000, setTimeout: () => 1, clearTimeout() {} });
    return { ctl, notices, screens, cams, ended, mixes, sysTracks, media: () => calls.filter((c) => c[0] === 'callMedia').map((c) => c.slice(1)), pc: () => FakePC.all[FakePC.all.length - 1] };
  };
  const flush = () => new Promise((r) => setImmediate(r));
  const begin = async (m, opts) => { await m.ctl.start(PEER, 'Budi', opts); await flush(); m.pc().state('connected'); await flush(); };

  // rtc tanpa getDisplayMedia: tidak tersedia, tidak ada galat membingungkan, panggilan aman (B.1, D.3)
  let m = ctlMk({ noScreen: true });
  await begin(m, { video: true });
  assert.strictEqual(m.ctl.canScreen(), false); assert.strictEqual(m.ctl.view().scrCan, false);
  assert.strictEqual(await m.ctl.startScreen(), false);
  assert.strictEqual(m.ctl.view().scr, false); assert.strictEqual(m.notices.length, 1, 'satu pemberitahuan singkat');
  assert(!m.media().some((a) => a[3] === true && a[4] === true), 'tidak ada kabar layar');
  ok('tanpa getDisplayMedia: canScreen false, startScreen gagal rapi, tidak ada kabar layar');

  // mulai dari panggilan video: kamera dimatikan sementara, layar masuk ke jalur video semua kaki
  m = ctlMk();
  await begin(m, { video: true });
  const cam1 = m.cams[0], vs = m.pc().vsenders[0];
  assert.strictEqual(m.ctl.canScreen(), true); assert.strictEqual(m.ctl.view().scrCan, true);
  assert.strictEqual(await m.ctl.startScreen(), true);
  const scr1 = m.screens[0];
  assert.deepStrictEqual(m.media().pop(), [CID, false, false, true, true], 'dikabarkan: kamera-slot hidup + layar');
  assert.strictEqual(vs.tracks[vs.tracks.length - 1], scr1, 'trek layar dipasang lewat replaceTrack');
  assert.strictEqual(scr1.contentHint, 'detail');
  assert(cam1.stopped >= 1, 'kamera dimatikan sementara (B.3)');
  assert(vs.set.length >= 1 && vs.set[0].encodings[0].maxBitrate > 0 && vs.set[0].encodings[0].maxFramerate > 0, 'bitrate dan fps dibatasi (B.6)');
  assert.strictEqual(m.ctl.view().scr, true); assert(m.ctl.localVideo(), 'pratinjau lokal memakai layar');
  assert.strictEqual(m.ctl.localVideo().getVideoTracks()[0], scr1);
  assert.strictEqual(m.ended.length, 0, 'panggilan tidak putus');
  assert.strictEqual(await m.ctl.startScreen(), true, 'mulai dua kali: tetap satu layar'); assert.strictEqual(m.screens.length, 1);
  ok('startScreen: layar menggantikan kamera di jalur video, dikabarkan, dibatasi bitrate/fps, panggilan tetap');

  // berhenti dari tombol Archne: layar dilepas, kamera dipulihkan
  assert.strictEqual(await m.ctl.stopScreen(), true);
  const med = m.media();
  assert.deepStrictEqual(med[med.length - 2], [CID, false, false, false, false], 'layar ditutup dikabarkan');
  assert.deepStrictEqual(med[med.length - 1], [CID, false, false, true], 'kamera pulih dikabarkan seperti kamera biasa');
  assert(scr1.stopped >= 1, 'trek layar dihentikan (indikator sistem padam)');
  assert.strictEqual(m.ctl.view().scr, false); assert.strictEqual(m.ctl.view().camOff, false, 'kamera hidup lagi');
  const nv = m.ctl.localVideo().getVideoTracks()[0];
  assert(nv && nv !== scr1 && nv.kind === 'video', 'trek kamera baru, bukan layar');
  assert.strictEqual(vs.tracks[vs.tracks.length - 1], nv, 'kamera kembali ke jalur video');
  assert.strictEqual(await m.ctl.stopScreen(), false, 'berhenti dua kali aman');
  ok('stopScreen: layar dilepas dan kamera yang tadinya hidup dipulihkan');

  // berhenti dari bilah sistem (trek ended)
  assert.strictEqual(await m.ctl.startScreen(), true);
  const scr2 = m.screens[1]; scr2.readyState = 'ended'; scr2.fire('ended');
  await until(() => m.ctl.view().scr === false, 2000, 'ended -> stopScreen');
  await until(() => m.ctl.view().camOff === false, 2000, 'kamera pulih setelah ended');
  assert.strictEqual(m.ended.length, 0);
  ok('trek layar ended (Stop sharing dari sistem operasi) menghentikan berbagi dan memulihkan kamera (B.4)');

  // panggilan suara: kamera tadinya mati -> tetap mati setelah berhenti
  m = ctlMk();
  await begin(m);
  assert.strictEqual(await m.ctl.startScreen(), true);
  assert.deepStrictEqual(m.media().pop(), [CID, false, false, true, true]);
  assert.strictEqual(await m.ctl.stopScreen(), true);
  assert.deepStrictEqual(m.media().pop(), [CID, false, false, false, false]);
  assert.strictEqual(m.cams.length, 0, 'kamera tidak pernah dibuka');
  assert.strictEqual(m.ctl.view().camOff, true);
  ok('panggilan suara: berbagi layar tidak membuka kamera, dan kamera tetap mati sesudahnya');

  // tombol kamera saat berbagi
  m = ctlMk();
  await begin(m, { video: true });
  await m.ctl.startScreen();
  const nN = m.notices.length;
  assert.strictEqual(await m.ctl.camera(true), false, 'menyalakan kamera saat berbagi ditolak'); assert.strictEqual(m.notices.length, nN + 1); assert.strictEqual(m.ctl.view().scr, true);
  assert.strictEqual(await m.ctl.flipCamera(), false, 'balik kamera tidak berlaku saat berbagi');
  await m.ctl.camera(false);
  assert.strictEqual(m.ctl.view().scr, false, 'mematikan kamera saat berbagi = menghentikan layar'); assert.strictEqual(m.ctl.view().camOff, true, 'tanpa memulihkan kamera');
  ok('saat berbagi: kamera tidak bisa dinyalakan/dibalik; mematikan kamera menghentikan layar tanpa memunculkan kamera');

  // pemilih dibatalkan: bukan galat
  m = ctlMk({ deny: 'NotAllowedError' });
  await begin(m, { video: true });
  assert.strictEqual(await m.ctl.startScreen(), false);
  assert.strictEqual(m.notices.length, 0, 'dibatalkan: diam'); assert.strictEqual(m.ctl.view().scr, false); assert.strictEqual(m.ctl.view().camOff, false, 'kamera tidak tersentuh');
  assert(!m.media().some((a) => a[4] === true));
  m = ctlMk({ deny: 'NotReadableError' });
  await begin(m, { video: true });
  assert.strictEqual(await m.ctl.startScreen(), false); assert.strictEqual(m.notices.length, 1, 'galat sungguhan: satu pemberitahuan'); assert.strictEqual(m.ctl.view().camOff, false);
  ok('pemilih dibatalkan = diam dan tanpa perubahan; galat sungguhan = satu pemberitahuan, kamera tidak tersentuh');

  // Core menolak (channel penuh)
  m = ctlMk({ full: true });
  await begin(m, { video: true });
  assert.strictEqual(await m.ctl.startScreen(), false);
  assert.strictEqual(m.ctl.view().scr, false); assert.strictEqual(m.screens[0].stopped >= 1, true, 'layar dilepas tanpa pernah dikirim');
  ok('ditolak Core (cam_full): layar dilepas, tidak dikirim ke siapa pun');

  // D2: satu pembagi per panggilan
  m = ctlMk();
  await begin(m, { video: true });
  const leg = m.ctl.cur.legs[0];
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: PEER, muted: false, deafened: false, cam: true, scr: true });
  assert.strictEqual(m.ctl.view().legs[0].scr, true); assert.strictEqual(m.ctl.remoteScreen(PEER), true);
  assert.strictEqual(await m.ctl.startScreen(), false); assert.strictEqual(m.screens.length, 0, 'pemilih tidak dibuka'); assert.strictEqual(m.notices.length, 1);
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: PEER, muted: true, deafened: false }); // hanya mute: layar tetap
  assert.strictEqual(m.ctl.remoteScreen(PEER), true);
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: PEER, muted: true, deafened: false, cam: true, scr: false });
  assert.strictEqual(m.ctl.remoteScreen(PEER), false); assert(!('scr' in m.ctl.view().legs[0]));
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: PEER, muted: false, deafened: false, cam: true, scr: true });
  await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: PEER, muted: false, deafened: false, cam: false });
  assert.strictEqual(m.ctl.remoteScreen(PEER), false, 'kamera lawan mati = layarnya juga tertutup');
  assert.strictEqual(await m.ctl.startScreen(), true, 'setelah lawan berhenti, aku boleh berbagi');
  ok('satu pembagi per panggilan (D2); status layar lawan tersimpan, tahan mute, dan ditutup oleh kamera mati');

  // F.4 di Controller: nilai scr aneh dari peer tidak mengubah tampilan
  m = ctlMk();
  await begin(m, { video: true });
  const lg = m.ctl.cur.legs[0];
  for (const bad of ['yes', 1, null, {}, []]) await m.ctl.onEvent({ ev: 'peerstate', cid: lg.cid, room: CID, peer: PEER, muted: false, deafened: false, cam: true, scr: bad });
  assert.strictEqual(m.ctl.remoteScreen(PEER), false); assert(!('scr' in m.ctl.view().legs[0]));
  m = ctlMk();
  await begin(m, { video: true });
  const lg2 = m.ctl.cur.legs[0];
  await m.ctl.onEvent({ ev: 'peerstate', cid: lg2.cid, room: CID, peer: PEER, muted: false, deafened: false, scr: true }); // scr tanpa kamera lawan yang diketahui hidup: tidak sah
  assert.strictEqual(m.ctl.remoteScreen(PEER), false); assert(!('scr' in m.ctl.view().legs[0]));
  ok('nilai scr yang aneh dari peer tidak mengubah tampilan');

  // panggilan berakhir saat berbagi: layar berhenti, tidak ada pemulihan liar
  m = ctlMk();
  await begin(m, { video: true });
  await m.ctl.startScreen();
  const scr = m.screens[0];
  m.ctl.hangup();
  await flush();
  assert(scr.stopped >= 1, 'trek layar dihentikan saat panggilan berakhir (F.2)'); assert.strictEqual(m.ctl.view(), null);
  scr.fire('ended'); await flush(); // listener lama tidak boleh melempar atau menyentuh apa pun
  ok('panggilan berakhir saat berbagi: layar berhenti otomatis, listener lama tidak berbuat apa-apa');

  // B.7: banyak penonton -> peringatan (tidak memblokir)
  m = ctlMk();
  await begin(m, { video: true });
  const base = m.ctl.cur;
  for (let i = 0; i < 3; i++) base.legs.push(Object.assign({}, base.legs[0], { peer: String(i).repeat(64), cid: 'b' + i, vsender: new FakeSender() }));
  const nm = m.notices.length;
  assert.strictEqual(await m.ctl.startScreen(), true); assert.strictEqual(m.notices.length, nm + 1, 'satu peringatan beban');
  assert(base.legs.every((x) => x.vsender.tracks.length >= 1 && x.vsender.set.length >= 1), 'semua kaki dapat layar dan dibatasi');
  ok('banyak penonton: layar tetap dikirim ke semua kaki, dengan satu peringatan beban (B.7)');

  // ---------- C.6 audio sistem ----------
  const sender0 = (mm) => mm.pc().senders[0]; // jalur audio kaki pertama
  const last = (sd) => sd.tracks[sd.tracks.length - 1];
  // tanpa audio sistem (kotak tidak dicentang): tidak ada pencampur, mikrofon tetap dikirim
  m = ctlMk(); await begin(m, { video: true });
  assert.strictEqual(await m.ctl.startScreen(), true);
  assert.strictEqual(m.mixes.length, 0, 'tanpa audio dari pemilih: tidak ada campuran'); assert.strictEqual(m.ctl.view().scrAudio, false);
  ok('audio sistem: tanpa centang, tidak ada pencampur dan indikator audio mati');

  // dengan audio sistem: campuran dikirim ke kaki, indikator menyala, mikrofon tetap sumbernya
  m = ctlMk({ sys: true, sup: true }); await begin(m, { video: true });
  const cc = m.ctl.cur, mic0 = cc.stream.getAudioTracks()[0], nA = m.notices.length;
  assert.strictEqual(await m.ctl.startScreen(), true);
  assert.strictEqual(m.mixes.length, 1); assert.strictEqual(m.mixes[0].mic, cc.stream, 'sumber mikrofon = mikrofon panggilan'); assert.strictEqual(m.mixes[0].sys, m.sysTracks[0]);
  assert.strictEqual(last(sender0(m)), m.mixes[0].track, 'kaki mengirim campuran'); assert.strictEqual(m.ctl.view().scrAudio, true);
  assert.strictEqual(m.notices.length, nA, 'pencegah gema aktif: tidak ada peringatan');
  // mute: hanya mikrofon yang diam; audio sistem terus mengalir (seperti Discord)
  m.ctl.mute(true); assert.strictEqual(mic0.enabled, false, 'mikrofon bisu'); assert.strictEqual(m.sysTracks[0].enabled, true, 'audio sistem tidak ikut bisu'); assert.strictEqual(m.sysTracks[0].stopped, 0);
  m.ctl.mute(false); assert.strictEqual(mic0.enabled, true);
  ok('audio sistem: campuran mikrofon + sistem dikirim ke kaki, indikator menyala, mute hanya membisukan mikrofon');

  // peredam Kuat menyala saat berbagi: campuran dibangun ulang dari keluaran RNNoise (audio sistem tidak lewat RNNoise), yang lama dihentikan
  m = ctlMk({ sys: true, sup: true, strong: true }); await begin(m, { video: true });
  await m.ctl.startScreen();
  const first = m.mixes[0]; await m.ctl.setNoise('strong'); await flush();
  const proc = m.ctl.cur.proc; assert(proc, 'peredam Kuat aktif');
  assert.strictEqual(m.mixes.length, 2); assert.strictEqual(m.mixes[1].mic, proc.stream, 'mikrofon yang masuk campuran = keluaran RNNoise');
  assert.strictEqual(m.mixes[1].sys, m.sysTracks[0], 'audio sistem masuk langsung, tidak lewat RNNoise'); assert.strictEqual(first.stopped, 1, 'campuran lama dihentikan');
  assert.strictEqual(last(sender0(m)), m.mixes[1].track);
  await m.ctl.setNoise('standard'); await flush();
  assert.strictEqual(m.mixes.length, 3); assert.strictEqual(m.mixes[2].mic, m.ctl.cur.stream, 'kembali ke mikrofon asli'); assert.strictEqual(proc.stopped, 1);
  ok('audio sistem + peredam bising: campuran dibangun ulang saat Kuat nyala/mati; audio sistem tidak ditekan RNNoise');

  // kaki yang datang saat berbagi audio langsung mengirim campuran
  m = ctlMk({ sys: true, sup: true }); await begin(m, { video: true });
  await m.ctl.startScreen();
  const lgN = { dir: 'in', localIce: [], remoteIce: [], peer: 'z'.repeat(64) }; m.ctl._pc(m.ctl.cur, lgN); await flush();
  assert.strictEqual(last(lgN.sender), m.mixes[m.mixes.length - 1].track, 'kaki baru mengirim campuran');
  ok('audio sistem: kaki yang datang belakangan ikut menerima campuran');

  // gema tidak terbukti dicegah: satu peringatan, audio tetap jalan
  m = ctlMk({ sys: true, sup: false }); await begin(m, { video: true });
  const n1 = m.notices.length; assert.strictEqual(await m.ctl.startScreen(), true);
  assert.strictEqual(m.notices.length, n1 + 1, 'satu peringatan gema (pakai headphone)'); assert.strictEqual(m.ctl.view().scrAudio, true);
  ok('audio sistem: bila pencegah gema tidak aktif, pengguna diberi tahu (headphone), audio tetap dibagikan');

  // pencampur gagal: layar tetap dibagikan tanpa suara, mikrofon tidak terganggu, trek audio sistem dilepas
  for (const mode of ['null', false]) {
    m = ctlMk({ sys: true, mix: mode }); await begin(m, { video: true });
    const mic = m.ctl.cur.stream.getAudioTracks()[0], n2 = m.notices.length;
    assert.strictEqual(await m.ctl.startScreen(), true, 'layar tetap dibagikan');
    assert.strictEqual(m.ctl.view().scrAudio, false); assert.strictEqual(m.notices.length, n2 + 1); assert(m.sysTracks[0].stopped >= 1, 'trek audio sistem dilepas');
    assert.strictEqual(last(sender0(m)), mic, 'yang dikirim tetap mikrofon');
  }
  ok('audio sistem: pencampur gagal / tidak ada -> layar tanpa suara, satu pemberitahuan, mikrofon utuh');

  // berhenti: mikrofon saja kembali, campuran dan trek sistem dihentikan
  m = ctlMk({ sys: true, sup: true }); await begin(m, { video: true });
  const micS = m.ctl.cur.stream.getAudioTracks()[0];
  await m.ctl.startScreen(); await m.ctl.stopScreen();
  assert.strictEqual(last(sender0(m)), micS, 'mikrofon kembali'); assert.strictEqual(m.mixes[0].stopped >= 1, true); assert(m.sysTracks[0].stopped >= 1); assert.strictEqual(m.ctl.view().scrAudio, false);
  ok('audio sistem: berhenti berbagi mengembalikan mikrofon saja dan melepas campuran + trek sistem');

  // audio sistem berhenti sendiri (ended): layar jalan terus, mikrofon kembali
  m = ctlMk({ sys: true, sup: true }); await begin(m, { video: true });
  const micE = m.ctl.cur.stream.getAudioTracks()[0];
  await m.ctl.startScreen(); m.sysTracks[0].fire('ended'); await flush(); await flush();
  assert.strictEqual(m.ctl.view().scr, true, 'layar tetap'); assert.strictEqual(m.ctl.view().scrAudio, false); assert.strictEqual(last(sender0(m)), micE);
  ok('audio sistem: trek audio berakhir sendiri -> layar lanjut, mikrofon saja');

  // panggilan berakhir saat berbagi audio: semua dilepas
  m = ctlMk({ sys: true, sup: true }); await begin(m, { video: true });
  await m.ctl.startScreen(); m.ctl.hangup(); await flush();
  assert(m.mixes[0].stopped >= 1 && m.sysTracks[0].stopped >= 1, 'campuran dan trek sistem dilepas saat panggilan berakhir');
  ok('audio sistem: panggilan berakhir melepas campuran dan trek sistem');

  // browserRtc.mixAudio: grafik simpul. Audio sistem TIDAK boleh tersambung ke speaker lokal (itu yang menimbulkan gema)
  {
    const log = []; let ctxN = 0;
    class N { constructor(k) { this.k = k; this.gain = { value: 1 }; } connect(x) { log.push([this.k, x.k]); } disconnect() { log.push([this.k, 'x']); } }
    class AC { constructor(o) { this.o = o; this.destination = new N('speaker'); this.state = 'running'; this.closed = 0; ctxN++; AC.last = this; }
      createMediaStreamSource(st) { return new N(st.tag); } createGain() { const g = new N('gain'); return g; } createDynamicsCompressor() { return new N('lim'); }
      createMediaStreamDestination() { const d = new N('dst'); d.stream = { tag: 'out' }; return d; } close() { this.closed++; } resume() {} }
    const w = { AudioContext: AC, MediaStream: function (t) { this.tag = 'sys'; this.t = t; }, RTCPeerConnection: function () {} };
    const r = LC.browserRtc(w, null).mixAudio({ tag: 'mic' }, { kind: 'audio' });
    assert(r && r.engine === 'mix' && r.stream.tag === 'out'); assert.strictEqual(AC.last.o.sampleRate, 48000);
    assert(log.some((e) => e[0] === 'mic' && e[1] === 'gain') && log.some((e) => e[0] === 'sys' && e[1] === 'gain') && log.some((e) => e[0] === 'lim' && e[1] === 'dst'), 'mic dan sistem -> penguat -> pembatas -> keluaran');
    assert(!log.some((e) => e[1] === 'speaker'), 'tidak ada simpul yang tersambung ke speaker lokal');
    r.stop(); assert.strictEqual(AC.last.closed, 1, 'stop menutup konteks');
    assert.strictEqual(LC.browserRtc({ RTCPeerConnection: function () {} }, null).mixAudio({}, {}), null, 'tanpa AudioContext: null');
    assert.strictEqual(LC.browserRtc(Object.assign({}, w, { AudioContext: function () { throw new Error('x'); } }), null).mixAudio({}, {}), null, 'AudioContext melempar: null');
    assert.strictEqual(LC.browserRtc(w, null).mixAudio(null, { kind: 'audio' }), null, 'tanpa mikrofon: null');
    ok('mixAudio: graf mic+sistem -> pembatas -> keluaran, tidak ke speaker, stop menutup konteks, null bila gagal');
  }

  console.log('\nscreenshare: ' + pass + ' OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
