'use strict';
// Tes 4c-3: ikon status mute/deafen peserta di layar panggilan (1-1 dan grup).
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));
const CID = 'b2'.repeat(8);
const H = { esc: (s) => String(s), avatar: (id) => '[av ' + id + ']', icons: { phone: 'PH', mic: 'MIC', micOff: 'MICOFF', head: 'HEAD', headOff: 'HEADOFF' } };
const badges = (html) => (html.match(/class="cbd (deaf|mute)"/g) || []).map((x) => x.slice(11, -1));
const leg = (peer, name, o) => Object.assign({ cid: CID, peer, name, dir: 'out', state: 'active', muted: false, deafened: false }, o);
const view = (legs, o) => Object.assign({ cid: CID, room: CID, invite: false, invites: [], members: [], peer: legs[0].peer, name: legs[0].name, dir: 'out', phase: 'active', muted: false, deafened: false, speaker: false, noise: 'standard', since: 1, canAccept: false, legs }, o);

class FakePC {
  constructor() { this.tracks = []; FakePC.all.push(this); }
  addTrack(t) { this.tracks.push(t); }
  async createOffer() { return { type: 'offer', sdp: 'O' }; }
  async createAnswer() { return { type: 'answer', sdp: 'A' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];

(async () => {
  // 1. 1-1: tanpa status tidak ada ikon; mute = mik dicoret; deafen = hanya headphone dicoret
  {
    assert.deepStrictEqual(badges(LC.overlayHtml(view([leg('p1', 'Budi')]), H)), []);
    const hm = LC.overlayHtml(view([leg('p1', 'Budi', { muted: true })]), H);
    assert.deepStrictEqual(badges(hm), ['mute']); assert(hm.includes('MICOFF') && hm.includes('Mik dimatikan'));
    const hd = LC.overlayHtml(view([leg('p1', 'Budi', { muted: true, deafened: true })]), H);
    assert.deepStrictEqual(badges(hd), ['deaf'], 'deafen: hanya satu ikon');
    assert(hd.includes('HEADOFF') && hd.includes('Tidak mendengar')); assert(!/class="cbd mute"/.test(hd));
    ok('1-1: tanpa ikon / mik dicoret / hanya headphone dicoret saat deafen');
  }
  // 2. status dari lawan tidak mengubah tombolku sendiri (ikon lawan beda dengan tombolku)
  {
    const html = LC.overlayHtml(view([leg('p1', 'Budi', { muted: true })], { muted: false }), H);
    assert(html.includes('aria-label="Bisukan"'), 'tombol mik milikku tetap normal');
    ok('ikon lawan tidak mengubah tombol sendiri');
  }
  // 3. grup: ikon per baris, hanya pada yang bersangkutan
  {
    const v = view([leg('p1', 'Budi', { muted: true }), leg('p2', 'Sari', { muted: true, deafened: true }), leg('p3', 'Andi')]);
    const html = LC.overlayHtml(v, H);
    const rows = html.split('<li ').slice(1);
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(badges(rows[0]), ['mute']); assert.deepStrictEqual(badges(rows[1]), ['deaf']); assert.deepStrictEqual(badges(rows[2]), []);
    assert(!rows[1].includes('MICOFF'), 'deafen tidak menampilkan mik dicoret');
    ok('grup: ikon mute/deafen per peserta, deafen hanya headphone');
  }
  // 4. kaki yang belum tersambung tidak menampilkan ikon; nama berisi HTML tetap aman
  {
    const v = view([leg('p1', 'Budi', { muted: true, state: 'connecting' }), leg('p2', 'Sari', { deafened: true, state: 'dialing' }), leg('p3', 'Andi')]);
    assert.deepStrictEqual(badges(LC.overlayHtml(v, H)), []);
    const one = LC.overlayHtml(view([leg('p1', 'Budi', { muted: true, state: 'connecting' })], { phase: 'connecting' }), H);
    assert.deepStrictEqual(badges(one), []);
    ok('kaki belum aktif: tidak ada ikon');
  }
  // 5. ikon tidak muncul di layar undangan masuk, dan tidak melempar bila ikon tidak tersedia
  {
    const inv = LC.overlayHtml(view([leg('p1', 'Budi', { muted: true })], { invite: true, members: [{ id: 'p1', name: 'Budi' }] }), H);
    assert.deepStrictEqual(badges(inv), []);
    const bare = LC.overlayHtml(view([leg('p1', 'Budi', { deafened: true })]), { esc: H.esc, avatar: H.avatar, icons: {} });
    assert.deepStrictEqual(badges(bare), ['deaf']);
    ok('layar undangan tanpa ikon; ikon hilang tidak melempar galat');
  }
  // 6. ujung ke ujung: peristiwa peerstate -> view() -> HTML, lalu dilepas -> ikon hilang
  {
    FakePC.all = [];
    const renders = [];
    const api = new Proxy({}, { get: (_, k) => async () => ({ ok: true, cid: CID }) });
    const rtc = { PeerConnection: FakePC, getUserMedia: async () => { const t = { enabled: true, stop() {} }; return { getTracks: () => [t], getAudioTracks: () => [t] }; }, makeStream: (tr) => ({ getAudioTracks: () => tr }), playRemote: () => () => {} };
    const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended() {} } });
    await ctl.start('p1', 'Budi'); await flush();
    ctl.cur.legs[0].pc.state('connected'); await flush();
    const l = ctl.cur.legs[0];
    await ctl.onEvent({ ev: 'peerstate', cid: l.cid, room: CID, peer: 'p1', muted: true, deafened: false });
    let v = renders[renders.length - 1];
    assert.strictEqual(v.legs[0].muted, true); assert.strictEqual(v.legs[0].deafened, false);
    assert.deepStrictEqual(badges(LC.overlayHtml(v, H)), ['mute']);
    await ctl.onEvent({ ev: 'peerstate', cid: l.cid, room: CID, peer: 'p1', muted: true, deafened: true });
    v = renders[renders.length - 1];
    assert.deepStrictEqual(badges(LC.overlayHtml(v, H)), ['deaf']);
    await ctl.onEvent({ ev: 'peerstate', cid: l.cid, room: CID, peer: 'p1', muted: false, deafened: false });
    v = renders[renders.length - 1];
    assert.deepStrictEqual(badges(LC.overlayHtml(v, H)), []);
    ok('peerstate -> ikon muncul, berganti, dan hilang saat dilepas');
  }
  console.log(pass + ' kelompok lulus');
})().catch((e) => { console.error(e); process.exit(1); });
