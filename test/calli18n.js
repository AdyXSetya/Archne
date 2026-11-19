'use strict';
// Tes i18n D6: renderer/archne-call.js bagian 1 (durHuman, callLabel, callMembers, endText, galat Controller) dua bahasa.
// Tanpa I18N = teks Indonesia cadangan (dijaga test/call*.js). Log/komentar tidak diterjemahkan.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const R = path.join(__dirname, '..', 'renderer'), rd = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const ok = (n) => console.log('  OK  ' + n);
function load(lang) {
  const c = { Intl, Object, Set, Map, String, console, Error, Promise, setTimeout, clearTimeout, setInterval, clearInterval, Uint8Array, Array, JSON, Math, Date, Number, module: { exports: {} } };
  c.self = c; vm.createContext(c);
  if (lang) { for (const x of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd(x), c); c.I18N.setLang(lang); }
  vm.runInContext(rd('archne-call.js'), c); return c.module.exports;
}
const ID_WORDS = /\b(panggilan|tidak|dia|kamu|dibatalkan|ditolak|sibuk|gagal|tersambung|mikrofon|kamera|berakhir|dijawab|terjawab|sedang|mnt|dtk|jam|peserta|grup|suara|masuk|masih|sudah|siap)\b/i;
class FakePC {
  constructor() { this.localDescription = null; this.connectionState = 'new'; }
  addTrack(t) { return { track: t, async replaceTrack() {} }; }
  async createOffer() { return { type: 'offer', sdp: 'O' }; } async createAnswer() { return { type: 'answer', sdp: 'A' }; }
  async setLocalDescription(d) { this.localDescription = d; } async setRemoteDescription() {} async addIceCandidate() {} close() {}
}
const track = (kind) => ({ kind, enabled: true, readyState: 'live', stop() {} });
function mk(M, o) {
  o = o || {}; const ended = [], notices = [];
  const api = new Proxy({}, { get: (_t, n) => async () => (o.api && o.api[n] ? o.api[n]() : { ok: true, cid: 'd1'.repeat(8) }) });
  const rtc = { PeerConnection: FakePC, getUserMedia: async (c) => { if (o.gum) return o.gum(c); return { getTracks: () => [track('audio')], getAudioTracks: () => [track('audio')], getVideoTracks: () => [] }; }, playRemote: () => () => {}, makeStream: (t) => ({ getTracks: () => t, getAudioTracks: () => t, getVideoTracks: () => [] }) };
  const ui = { render() {}, ring() {}, ended: (i) => ended.push(i), notice: (m) => notices.push(m) };
  const ctl = new M.Controller({ api, rtc, ui, now: Date.now, setTimeout: (f) => 0, clearTimeout() {} });
  return { ctl, ended, notices };
}
const CASES = [[null, 'cadangan'], ['id', 'id'], ['en', 'en']];
(async () => {
  const Ms = {}; for (const [l, n] of CASES) Ms[n] = load(l);

  // 1) Label, durasi, anggota, toast: ID == cadangan; EN beda dan tanpa kata Indonesia
  const sample = []; for (const out of ['done', 'missed', 'rejected', 'noanswer', 'busy', 'cancelled', 'failed']) for (const video of [false, true]) for (const group of [false, true]) for (const dir of ['in', 'out']) sample.push({ out, video, group, dir, dur: 75, members: [{ name: 'Budi#x' }] });
  for (const r of sample) { assert.strictEqual(JSON.stringify(Ms.id.callLabel(r)), JSON.stringify(Ms.cadangan.callLabel(r))); assert.strictEqual(Ms.id.callMembers(r), Ms.cadangan.callMembers(r)); }
  const ends = []; for (const reason of ['mic', 'error', 'missed', 'rejected', 'busy', 'noanswer', 'unreachable', 'refused', 'failed', 'blocked', 'cancelled', 'ended']) for (const name of ['', 'Budi']) for (const f of [{}, { wan: 1 }, { wasActive: 1, dur: 75 }, { vc: 1 }]) ends.push(Object.assign({ reason, name }, f));
  for (const i of ends) assert.strictEqual(Ms.id.endText(i), Ms.cadangan.endText(i));
  for (const d of [5, 75, 3600, 3665]) assert.strictEqual(Ms.id.durHuman(d), Ms.cadangan.durHuman(d));
  assert.strictEqual(Ms.id.durHuman(75), '1 mnt 15 dtk'); assert.strictEqual(Ms.id.durHuman(3665), '1 jam 1 mnt');
  ok('label riwayat, anggota, durasi, toast akhir: mode ID identik cadangan');
  const en = Ms.en; const bad = [];
  for (const r of sample) { const l = en.callLabel(r); for (const v of [l.title, l.sub, l.short, en.callMembers(r)]) if (ID_WORDS.test(v) || !v) bad.push(v); }
  for (const i of ends) { const t = en.endText(i); if (ID_WORDS.test(t)) bad.push(t); }
  assert.strictEqual(JSON.stringify(bad), '[]');
  assert.strictEqual(en.durHuman(75), '1 min 15 s'); assert.strictEqual(en.durHuman(3665), '1 h 1 min'); assert.strictEqual(en.durHuman(5), '5 s');
  assert.strictEqual(en.callLabel({ out: 'busy', dir: 'out' }).short, 'Voice call · busy');
  assert.strictEqual(en.callMembers({ members: [{ name: 'Budi#1' }] }), 'You, Budi');
  assert.strictEqual(en.endText({ reason: 'busy', name: 'Budi' }), 'Budi is in another call'); assert.strictEqual(en.endText({ reason: 'busy' }), 'They are in another call');
  assert.strictEqual(en.endText({ wasActive: 1, dur: 75 }), 'Call ended · 01:15');
  ok('mode EN: tanpa kata Indonesia, urutan kata wajar (nama peer lewat kunci utuh)');

  // 2) Galat Controller per bahasa
  const E = {
    cadangan: { noCall: 'Tidak ada panggilan yang siap menambah peserta', already: 'Sudah tersambung ke dia', busy: 'Masih ada panggilan yang berlangsung', join: 'Gagal masuk channel', audio: 'Gagal menyiapkan audio: boom' },
    id: null, en: { noCall: 'There is no call ready to add participants', already: 'Already connected to them', busy: 'A call is already in progress', join: "Couldn't join the channel", audio: "Couldn't set up audio: boom" },
  }; E.id = E.cadangan;
  for (const k of ['cadangan', 'id', 'en']) {
    const M = Ms[k], w = E[k];
    let { ctl } = mk(M); const r0 = await ctl.addLeg('b'.repeat(16), 'B'); assert.strictEqual(r0.err, w.noCall, 'addLeg tanpa panggilan (' + k + ')');
    // start dua kali -> kedua ditolak 'masih ada panggilan'
    ({ ctl, ended: ctl.__e } = Object.assign(mk(M), {})); const m1 = mk(M); await m1.ctl.start('b'.repeat(16), 'B'); await m1.ctl.start('c'.repeat(16), 'C');
    assert(m1.ended.some((i) => i.err === w.busy), 'start ganda (' + k + '): ' + JSON.stringify(m1.ended.map((i) => i.err)));
    // masuk channel gagal tanpa pesan Core
    const m2 = mk(M, { api: { vcEnter: () => ({ ok: false }) } }); await m2.ctl.enterChannel('a'.repeat(16), 'c'.repeat(16), 'Ch');
    assert(m2.ended.some((i) => i.err === w.join), 'enterChannel gagal (' + k + '): ' + JSON.stringify(m2.ended));
    // audio gagal disiapkan: createOffer melempar
    const m3 = mk(M); const orig = FakePC.prototype.createOffer; FakePC.prototype.createOffer = async () => { throw new Error('boom'); };
    try { await m3.ctl.start('b'.repeat(16), 'B'); } finally { FakePC.prototype.createOffer = orig; }
    const hit = m3.ended.find((i) => i.err && /boom/.test(i.err)); assert(hit, 'galat audio muncul (' + k + '): ' + JSON.stringify(m3.ended)); assert.strictEqual(hit.err, w.audio, 'galat audio (' + k + ')');
  }
  ok('galat Controller: addLeg, start ganda, enterChannel gagal (cadangan/ID/EN)');

  // 3) Galat kamera/mikrofon dengan detail
  for (const [k, camRe, micRe] of [['cadangan', /^Kamera tidak bisa dipakai \[NotAllowedError: x\]\. Panggilan dilanjutkan tanpa video\.$/, /^Mikrofon tidak bisa dipakai \[NotAllowedError: x\]\. Izinkan akses mikrofon untuk Archne, lalu coba lagi\.$/], ['id', null, null], ['en', /^The camera can't be used \[NotAllowedError: x\]\. The call continues without video\.$/, /^The microphone can't be used \[NotAllowedError: x\]\. Allow microphone access for Archne, then try again\.$/]]) {
    const M = Ms[k]; const cr = k === 'id' ? Ms.cadangan : null;
    const err = () => { const e = new Error('x'); e.name = 'NotAllowedError'; return e; };
    const m = mk(M, { gum: async (c) => { if (c.video) throw err(); return { getTracks: () => [track('audio')], getAudioTracks: () => [track('audio')], getVideoTracks: () => [] }; } });
    await m.ctl.start('b'.repeat(16), 'B', { video: true });
    const camMsg = m.notices.find((x) => /amera|amera|camera/i.test(x));
    assert(camMsg, 'notice kamera muncul (' + k + '): ' + JSON.stringify(m.notices)); if (camRe) assert(camRe.test(camMsg), 'kamera (' + k + '): ' + camMsg);
    const mm = mk(M, { gum: async () => { throw err(); } }); await mm.ctl.start('b'.repeat(16), 'B');
    const mic = mm.ctl._micErr || (mm.ended[0] && mm.ended[0].err) || '';
    assert(mic, 'galat mikrofon muncul (' + k + ')'); if (micRe) assert(micRe.test(mic), 'mikrofon (' + k + '): ' + mic);
  }
  ok('galat kamera/mikrofon dengan detail per bahasa');
  // 4) D7: jawab, undang, notifikasi kamera latar belakang, kamera lain, peredam Kuat
  const W = {
    cadangan: { answer: 'Gagal menjawab panggilan', notConn: 'Panggilan belum tersambung', inCall: 'Dia sudah ada di panggilan ini', invite: 'Gagal mengundang', camBg: /^Kamera dimatikan saat aplikasi/, camOther: 'Kamera lain tidak tersedia', noise: /^Peredam Kuat tidak bisa dipakai/ },
    en: { answer: "Couldn't answer the call", notConn: "The call isn't connected yet", inCall: 'They are already in this call', invite: "Couldn't send the invitation", camBg: /^The camera was turned off while the app was in the background/, camOther: 'No other camera is available', noise: /^Strong noise reduction can't be used/ },
  }; W.id = W.cadangan;
  const aud = () => ({ getTracks: () => [track('audio')], getAudioTracks: () => [track('audio')], getVideoTracks: () => [] });
  for (const k of ['cadangan', 'id', 'en']) {
    const M = Ms[k], w = W[k];
    // undang tanpa panggilan -> belum tersambung
    assert.strictEqual((await mk(M).ctl.invite('p', 'P')).err, w.notConn, 'invite tanpa panggilan (' + k + ')');
    // panggilan aktif: undang ganda, undang gagal tanpa pesan Core
    const act = async (o) => { const m = mk(M, o); await m.ctl.start('peer1', 'Budi'); const cid = 'd1'.repeat(8); await m.ctl.onEvent({ ev: 'answer', cid, sdp: 'ANS' }); return m; };
    const a1 = await act({ api: { callInvite: () => ({ ok: false }) } });
    a1.ctl.cur.legs[0].phase = 'active';
    assert.strictEqual((await a1.ctl.invite('peer1', 'Budi')).err, w.inCall, 'sudah di panggilan (' + k + ')');
    assert.strictEqual((await a1.ctl.invite('peer9', 'X')).err, w.invite, 'undang gagal (' + k + ')');
    // jawab panggilan masuk: Core menolak tanpa pesan
    const m = mk(M, { api: { callAnswer: () => ({ ok: false }) } });
    await m.ctl.onEvent({ ev: 'incoming', cid: 'e1'.repeat(8), peer: 'peer2', name: 'Ani', sdp: 'OFFER', ice: [] });
    await m.ctl.accept();
    assert(m.ended.some((i) => i.err === w.answer), 'accept gagal (' + k + '): ' + JSON.stringify(m.ended));
    // kamera dimatikan saat latar belakang -> notifikasi saat kembali
    const v = mk(M, { api: { vcEnter: () => ({ ok: true }) } }); await v.ctl.enterChannel('a'.repeat(16), 'c'.repeat(16), 'Ch');
    assert(v.ctl.cur && v.ctl.cur.vc, 'sesi channel ada (' + k + ')'); v.ctl.cur.camBg = true; await v.ctl.appHidden(false);
    assert(v.notices.length === 1 && w.camBg.test(v.notices[0]), 'notif latar belakang (' + k + '): ' + JSON.stringify(v.notices));
    // putar kamera: kamera lain tidak ada
    const f = mk(M, { gum: async (c) => { if (c.video && !f.denyVideo) return { getTracks: () => [track('audio'), track('video')], getAudioTracks: () => [track('audio')], getVideoTracks: () => [track('video')] }; if (c.video) throw new Error('no'); return aud(); } });
    await f.ctl.start('peer1', 'Budi', { video: true }); await f.ctl.onEvent({ ev: 'answer', cid: 'd1'.repeat(8), sdp: 'ANS' });
    f.ctl.cur.camOff = false; f.denyVideo = true; f.ctl.cur.facing = 'user'; f.notices.length = 0;
    assert.strictEqual(await f.ctl.flipCamera(), false); assert(f.notices.includes(w.camOther), 'kamera lain (' + k + '): ' + JSON.stringify(f.notices));
    // peredam Kuat tidak tersedia -> kembali ke Standar + notifikasi
    const n = await act(); n.notices.length = 0; await n.ctl.setNoise('strong');
    assert(n.notices.some((x) => w.noise.test(x)), 'peredam Kuat (' + k + '): ' + JSON.stringify(n.notices));
  }
  ok('D7: jawab gagal, undang (belum tersambung/ganda/gagal), notif kamera latar belakang, kamera lain, peredam Kuat (cadangan/ID/EN)');
  // 5) D8: teks HTML layar panggilan, pilihan undangan, mini bar, pesan izin plugin Android
  const ic = { phone: 'P', mic: 'M', micOff: 'MO', chev: 'C', speaker: 'S', noise: 'N', noiseOff: 'NO', video: 'V', videoOff: 'VO', flip: 'F', head: 'H', headOff: 'HO', add: 'A', shrink: 'SH' };
  const hh = (x) => Object.assign({ esc: (s) => String(s), avatar: (p) => '[' + p + ']', icons: ic, speaker: true, flip: true, canAdd: true, meId: 'me1' }, x || {});
  const lg = [{ peer: 'a', name: 'Ani', state: 'active', muted: true }, { peer: 'b', name: 'Budi', state: 'connecting' }];
  const base = { phase: 'active', since: Date.now(), peer: 'a', name: 'Ani', legs: [lg[0]], invites: [], noise: 'standard' };
  const T = {
    cadangan: { f: 'Panggilan grup', inf: 'Budi menolak undangan', leg: 'Koneksi dengan Budi terputus', leg2: 'Seorang peserta keluar dari panggilan', friend: '⭐ Teman', none: 'Tidak ada orang online lain yang bisa diundang.', nz: 'Bising: Standar', hang: 'Akhiri', mute: 'Bisukan', ring: 'Panggilan video masuk', mic: 'Mik dimatikan', mini: 'Ketuk untuk kembali ke layar panggilan', vcw: 'Channel suara · menunggu orang lain masuk', vc2: 'Channel suara · 3 orang', camon: 'Kamera mati', micDen: 'Izin mikrofon diperlukan untuk panggilan. Coba lagi dan pilih Izinkan.', camDen: 'izin kamera ditolak; izinkan di Pengaturan > Aplikasi > Archne' },
    en: { f: 'Group call', inf: 'Budi declined the invitation', leg: 'The connection with Budi was lost', leg2: 'A participant left the call', friend: '⭐ Friend', none: 'No other online people can be invited.', nz: 'Noise: Standard', hang: 'End', mute: 'Mute', ring: 'Incoming video call', mic: 'Mic muted', mini: 'Tap to go back to the call screen', vcw: 'Voice channel · waiting for others to join', vc2: 'Voice channel · 3 people', camon: 'Camera off', micDen: 'Microphone permission is needed for calls. Try again and choose Allow.', camDen: 'camera permission denied; allow it in Settings > Apps > Archne' },
  }; T.id = T.cadangan;
  for (const k of ['cadangan', 'id', 'en']) {
    const M = Ms[k], t = T[k];
    assert.strictEqual(M.inviteFailText({ name: 'Budi', reason: 'declined' }), t.inf, 'undangan ditolak (' + k + ')');
    assert.strictEqual(M.legText({ name: 'Budi', reason: 'failed' }), t.leg, 'kaki terputus (' + k + ')');
    assert.strictEqual(M.legText({ reason: 'left' }), t.leg2, 'nama cadangan kaki (' + k + ')');
    const pk = M.overlayHtml(Object.assign({}, base), hh({ picker: [{ id: 'x', name: 'Xi', friend: true }, { id: 'y', name: 'Yu', friend: false }] }));
    assert(pk.includes(t.friend) && pk.includes('>Online<'), 'pilihan undangan (' + k + ')');
    assert(M.overlayHtml(Object.assign({}, base), hh({ picker: [] })).includes(t.none), 'pilihan kosong (' + k + ')');
    const ov = M.overlayHtml(Object.assign({}, base), hh());
    assert(ov.includes(t.nz) && ov.includes(t.hang) && ov.includes(t.mute), 'tombol overlay (' + k + ')');
    assert(M.overlayHtml(Object.assign({}, base, { phase: 'ringing', video: true, canAccept: true }), hh()).includes(t.ring), 'dering video (' + k + ')');
    const g = M.overlayHtml(Object.assign({}, base, { legs: lg }), hh());
    assert(g.includes(t.f) && g.includes(t.mic), 'grup + lencana (' + k + ')');
    assert(M.overlayHtml(Object.assign({}, base), hh({ minimized: true })).includes(t.mini), 'mini bar (' + k + ')');
    const vcv = Object.assign({}, base, { vc: { name: 'Ch' }, legs: [lg[0], Object.assign({}, lg[1], { state: 'active' })] });
    assert(M.overlayHtml(vcv, hh()).includes(t.vc2), 'jumlah channel (' + k + ')');
    assert(M.overlayHtml(Object.assign({}, base, { vc: { name: 'Ch' }, legs: [] }), hh()).includes(t.vcw), 'channel kosong (' + k + ')');
    assert(M.overlayHtml(Object.assign({}, base, { video: true, camOff: true, legs: [Object.assign({}, lg[0], { cam: true })] }), hh()).includes(t.camon), 'kamera mati (' + k + ')');
    // pesan izin plugin Android lewat browserRtc
    const rtc = M.browserRtc({ RTCPeerConnection: function () {}, navigator: { mediaDevices: { getUserMedia: async () => ({}) } } }, { audio: true, ask: async (a) => ({ ok: false, res: a === 'mic' ? 'denied' : 'blocked' }) });
    let e1 = null; try { await rtc.getUserMedia({ audio: true }); } catch (e) { e1 = e; }
    assert(e1 && e1.userMsg === t.micDen, 'pesan izin mikrofon (' + k + '): ' + (e1 && e1.userMsg));
    let e2 = null; try { await rtc.getUserMedia({ video: true }); } catch (e) { e2 = e; }
    assert(e2 && e2.userMsg === t.camDen, 'pesan izin kamera (' + k + '): ' + (e2 && e2.userMsg));
  }
  // callStart ditolak Core tanpa pesan -> teks cadangan 'Panggilan gagal' (D6 yang terlewat, dibenahi di D8)
  for (const [k, want] of [['cadangan', 'Panggilan gagal'], ['id', 'Panggilan gagal'], ['en', 'The call failed']]) {
    const m = mk(Ms[k], { api: { callStart: () => ({ ok: false }) } }); await m.ctl.start('peer1', 'Budi');
    assert(m.ended.some((i) => i.err === want), 'callStart gagal (' + k + '): ' + JSON.stringify(m.ended));
  }
  // EN tidak boleh bocor kata Indonesia di seluruh keadaan layar
  for (const phase of ['ringing', 'dialing', 'connecting', 'active']) for (const vc of [null, { name: 'Ch' }]) for (const video of [false, true]) for (const legs of [[], [lg[0]], lg]) for (const minimized of [false, true]) {
    const html = Ms.en.overlayHtml({ phase, vc, video, legs, invites: [{ peer: 'c', name: 'Cici' }], since: 0, peer: 'a', name: 'Ani', canAccept: phase === 'ringing', noise: 'strong', camCount: 1, camMax: 4, members: [{ id: 'k', name: 'Kiki' }] }, hh({ minimized, picker: [] }));
    assert(!ID_WORDS.test(html.replace(/Deafen/g, '')), 'kata Indonesia di EN (' + phase + '): ' + (html.match(ID_WORDS) || [])[0]);
  }
  ok('D8: undangan/kaki, pilihan, mini bar, overlay (grup, channel, video), pesan izin Android (cadangan/ID/EN); tanpa kata Indonesia di EN');
  console.log('calli18n: semua lulus');
})().catch((e) => { console.error(e); process.exit(1); });
