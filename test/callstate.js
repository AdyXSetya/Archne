'use strict';
// Tes 4c-1: mute dan deafen lokal (belum ada siaran ke peserta lain). Controller dengan RTC palsu.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));
const CID = 'b2'.repeat(8);

class FakePC {
  constructor() { this.tracks = []; this.remoteDescription = null; FakePC.all.push(this); }
  addTrack(t) { this.tracks.push(t); }
  async createOffer() { return { type: 'offer', sdp: 'O' }; }
  async createAnswer() { return { type: 'answer', sdp: 'A' }; }
  async setLocalDescription() {}
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() {}
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];

function mk(o) {
  o = o || {};
  FakePC.all = [];
  const players = [], renders = [], mics = [];
  const calls = [];
  const api = new Proxy({}, { get: (_, k) => async (...a) => { calls.push([k].concat(a)); return { ok: true, cid: CID }; } });
  const rtc = {
    PeerConnection: FakePC,
    getUserMedia: async () => { const t = { enabled: true, stop() {} }; mics.push(t); return { getTracks: () => [t], getAudioTracks: () => [t] }; },
    makeStream: (tr) => ({ tr, getAudioTracks: () => tr }),
    playRemote: (st) => {
      if (o.noMuteHook) return () => {};
      const p = { muted: false, stopped: false }; players.push(p);
      const stop = () => { p.stopped = true; }; stop.mute = (on) => { p.muted = !!on; };
      return stop;
    },
  };
  const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => renders.push(v), ring() {}, ended() {} } });
  return { ctl, players, renders, mics, calls, last: () => renders[renders.length - 1] };
}
async function active(m) {
  await m.ctl.start('p1', 'Budi'); await flush();
  m.ctl.cur.legs[0].pc.ontrack({ streams: [{}], track: {} });
  m.ctl.cur.legs[0].pc.state('connected'); await flush();
}

(async () => {
  // 1. deafen membisukan audio lawan dan mik; melepasnya memulihkan
  {
    const m = mk(); await active(m);
    assert.strictEqual(m.last().deafened, false); assert.strictEqual(m.last().muted, false);
    assert.strictEqual(m.ctl.deafen(), true);
    assert.strictEqual(m.players[0].muted, true, 'audio lawan dibisukan');
    assert.strictEqual(m.mics[0].enabled, false, 'mik ikut mati');
    assert.strictEqual(m.last().deafened, true); assert.strictEqual(m.last().muted, true);
    assert.strictEqual(m.ctl.deafen(), false);
    assert.strictEqual(m.players[0].muted, false); assert.strictEqual(m.mics[0].enabled, true);
    assert.strictEqual(m.last().muted, false);
    ok('deafen membisukan audio lawan + mik, dilepas: semuanya pulih');
  }
  // 2. sudah mute sebelum deafen -> tetap mute setelah deafen dilepas
  {
    const m = mk(); await active(m);
    m.ctl.mute(true); m.ctl.deafen(true); m.ctl.deafen(false);
    assert.strictEqual(m.last().muted, true); assert.strictEqual(m.mics[0].enabled, false);
    assert.strictEqual(m.players[0].muted, false);
    ok('mute sebelum deafen dipulihkan (tetap mute)');
  }
  // 3. membuka mik saat deafen = lepas deafen + unmute; mute(true) saat deafen tidak mengubah apa pun
  {
    const m = mk(); await active(m);
    m.ctl.deafen(true);
    assert.strictEqual(m.ctl.mute(true), true); assert.strictEqual(m.last().deafened, true);
    assert.strictEqual(m.ctl.mute(false), false);
    assert.strictEqual(m.last().deafened, false); assert.strictEqual(m.last().muted, false);
    assert.strictEqual(m.players[0].muted, false); assert.strictEqual(m.mics[0].enabled, true);
    m.ctl.deafen(true); m.ctl.mute(); // toggle
    assert.strictEqual(m.last().deafened, false); assert.strictEqual(m.last().muted, false);
    ok('unmute saat deafen melepas deafen (gaya Discord)');
  }
  // 4. deafen berulang idempoten; premute tidak tertimpa
  {
    const m = mk(); await active(m);
    m.ctl.mute(true); m.ctl.deafen(true); m.ctl.deafen(true); m.ctl.deafen(false);
    assert.strictEqual(m.last().muted, true);
    m.ctl.mute(false); m.ctl.deafen(true); m.ctl.deafen(true); m.ctl.deafen(false);
    assert.strictEqual(m.last().muted, false);
    ok('deafen berulang aman, keadaan mute awal tidak tertimpa');
  }
  // 5. kaki baru yang datang saat deafen aktif langsung dibisukan
  {
    const m = mk(); await active(m);
    m.ctl.deafen(true);
    const l = m.ctl.cur.legs[0];
    l.pc.ontrack({ streams: [{}], track: {} }); // pemutar baru untuk kaki yang sama / kaki baru
    assert.strictEqual(m.players[m.players.length - 1].muted, true);
    ok('audio baru saat deafen langsung bisu');
  }
  // 6. pemutar tanpa hook mute: cadangan lewat trek masuk
  {
    const m = mk({ noMuteHook: true }); await active(m);
    const tr = { enabled: true };
    const l = m.ctl.cur.legs[0]; l.remote = { getAudioTracks: () => [tr] };
    m.ctl.deafen(true); assert.strictEqual(tr.enabled, false);
    m.ctl.deafen(false); assert.strictEqual(tr.enabled, true);
    ok('cadangan: trek masuk dimatikan bila pemutar tak punya mute()');
  }
  // 7. berdering: deafen ditolak; tanpa panggilan: aman
  {
    const m = mk();
    assert.strictEqual(m.ctl.deafen(), false);
    await m.ctl.start('p1', 'Budi'); // dialing
    assert.strictEqual(m.ctl.deafen(true), true, 'saat memanggil boleh');
    ok('tanpa panggilan aman; saat memanggil boleh');
  }
  // 8. overlay: tombol deafen, label, kelas on, ikon
  {
    const h = { esc: (s) => s, avatar: () => '', icons: { phone: 'P', mic: 'MIC', micOff: 'MICOFF', head: 'HEAD', headOff: 'HEADOFF' } };
    const base = { phase: 'active', peer: 'p1', name: 'Budi', legs: [], invites: [], members: [], noise: 'standard', muted: false, deafened: false };
    let html = LC.overlayHtml(base, h);
    assert(/data-cact="deafen"/.test(html) && /HEAD/.test(html) && !/HEADOFF/.test(html) && /Deafen</.test(html));
    html = LC.overlayHtml(Object.assign({}, base, { muted: true, deafened: true }), h);
    assert(/HEADOFF/.test(html) && /Deafen aktif/.test(html) && /MICOFF/.test(html));
    assert(!/data-cact="deafen"/.test(LC.overlayHtml(Object.assign({}, base, { phase: 'ringing', canAccept: true }), h)), 'berdering: tanpa tombol deafen');
    ok('overlay: tombol deafen + ikon sesuai status');
  }
  // 4c-2a: setiap perubahan mute/deafen disiarkan lewat api.callMedia(room, muted, deafened)
  {
    const m = mk(); await active(m);
    const media = () => m.calls.filter((c) => c[0] === 'callMedia').map((c) => c.slice(1));
    assert.strictEqual(media().length, 0, 'tanpa perubahan: tidak ada siaran');
    m.ctl.mute(true); m.ctl.deafen(true); m.ctl.deafen(false); m.ctl.mute(false);
    assert.deepStrictEqual(media(), [[CID, true, false], [CID, true, true], [CID, true, false], [CID, false, false]]);
    m.ctl.deafen(true); m.ctl.mute(true); // mute saat deafen: tidak ada perubahan, tidak ada siaran
    assert.strictEqual(media().length, 5);
    m.ctl.mute(false); // buka mik saat deafen: lepas deafen + unmute, disiarkan sekali
    assert.deepStrictEqual(media()[5], [CID, false, false]); assert.strictEqual(media().length, 6);
    ok('mute/deafen disiarkan sekali per perubahan (termasuk unmute saat deafen)');
  }
  {
    const m = mk(); await m.ctl.start('p1', 'Budi'); await flush(); // masih memanggil (belum tersambung)
    m.ctl.deafen(true); m.ctl.mute(true);
    assert(m.ctl.cur.phase !== 'active');
    ok('belum aktif: deafen/mute tidak melempar galat');
  }
  // status lawan bicara (event peerstate) tersimpan di kaki yang benar; deafen selalu berarti mute
  {
    const m = mk(); await active(m);
    const leg = m.ctl.cur.legs[0];
    await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: 'p1', muted: false, deafened: true });
    assert.strictEqual(leg.deafened, true); assert.strictEqual(leg.muted, true);
    await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, room: CID, peer: 'p1', muted: true, deafened: false });
    assert.strictEqual(leg.deafened, false); assert.strictEqual(leg.muted, true);
    await m.ctl.onEvent({ ev: 'peerstate', cid: 'f'.repeat(16), room: CID, peer: 'p9', muted: true, deafened: true });
    assert.strictEqual(leg.muted, true, 'kaki lain/asing tidak mengubah kaki ini');
    await m.ctl.onEvent({ ev: 'peerstate', cid: leg.cid, peer: 'p1', muted: 'ya', deafened: 1 });
    assert.strictEqual(leg.deafened, false, 'nilai bukan boolean tidak dianggap benar');
    ok('peerstate: tersimpan per kaki, deafen => mute, nilai aneh ditolak');
  }
  console.log(pass + ' kelompok lulus');
})().catch((e) => { console.error(e); process.exit(1); });
