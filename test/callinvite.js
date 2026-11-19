'use strict';
// Tes Controller undangan + bergabung (Step 2c): mengundang, menerima/menolak undangan, legneed, kaki jatuh saat bergabung, keluar saat bergabung.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const CID = 'a1'.repeat(8), LEG = (n) => ('b' + n).repeat(8).slice(0, 16), ROOM = 'f9'.repeat(8), IN = (n) => ('c' + n).repeat(8).slice(0, 16);

class FakePC {
  constructor() { this.senders = []; this.remoteDescription = null; this.localDescription = null; this.closed = false; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { const s = { track: t, async replaceTrack(x) { this.track = x; } }; this.senders.push(s); return s; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER-' + FakePC.all.indexOf(this) }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER-' + FakePC.all.indexOf(this) }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.closed = true; }
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
function sched() {
  let now = 1000, id = 0; const q = new Map();
  return { now: () => now, setTimeout: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (i) => q.delete(i), tick(ms) { now += ms; for (const [i, t] of [...q]) if (t.at <= now) { q.delete(i); t.fn(); } } };
}
// o.micGate: Promise yang menahan getUserMedia; o.micFail: izin ditolak; o.acceptGate: menahan jawaban callInviteAccept; o.acceptRes: jawaban lain
function mk(o) {
  o = o || {}; FakePC.all = [];
  const s = sched(), calls = [], ended = [], failed = [], mics = [], rings = []; let legSeq = 0;
  const api = new Proxy({}, { get: (_t, n) => async (...a) => {
    calls.push([n, ...a]);
    if (n === 'callStart') return { ok: true, cid: CID };
    if (n === 'callLeg') return { ok: true, cid: LEG(++legSeq) };
    if (n === 'callInviteAccept') { if (o.acceptGate) await o.acceptGate; return o.acceptRes || { ok: true }; }
    return { ok: true };
  } });
  const rtc = { PeerConnection: FakePC, getUserMedia: async () => { if (o.micGate) await o.micGate; if (o.micFail) throw new Error('ditolak'); const t = { enabled: true, stopped: false, stop() { this.stopped = true; } }; mics.push(t); return { getTracks: () => [t], getAudioTracks: () => [t] }; }, makeStream: (tr) => ({ tr }), playRemote: () => () => {} };
  const ctl = new LC.Controller({ api, rtc, ui: { render() {}, ring: (k) => rings.push(k), ended: (i) => ended.push(i), inviteFailed: (i) => failed.push(i) }, now: s.now, setTimeout: s.setTimeout, clearTimeout: s.clearTimeout });
  return { ctl, s, calls, ended, failed, mics, rings, of: (n) => calls.filter((c) => c[0] === n), pcs: () => FakePC.all };
}
const flush = () => new Promise((r) => setImmediate(r));
async function active(o) { // panggilan keluar ke peer1, sudah aktif
  const m = mk(o); await m.ctl.start('peer1', 'Budi');
  await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'ANS' }); m.pcs()[0].state('connected'); return m;
}
const INVITED = { ev: 'invited', room: ROOM, cid: ROOM, peer: 'peer1', name: 'Budi', members: [{ id: 'peer1', name: 'Budi' }, { id: 'peer2', name: 'Ani' }] };

(async () => {
  { // 1. mengundang: lewat kaki yang aktif, menunggu di daftar, hilang saat kakinya terbentuk
    const m = await active();
    const r = await m.ctl.invite('peer3', 'Cici');
    assert.deepStrictEqual(r, { ok: true });
    assert.deepStrictEqual(m.of('callInvite')[0], ['callInvite', CID, 'peer3']);
    assert.deepStrictEqual(m.ctl.view().invites, [{ peer: 'peer3', name: 'Cici' }]);
    assert.strictEqual((await m.ctl.invite('peer3', 'Cici')).ok, false, 'undangan ganda ditolak di sisi UI');
    assert.strictEqual((await m.ctl.invite('peer1', 'Budi')).ok, false, 'yang sudah di panggilan tidak diundang');
    await m.ctl.onEvent({ ev: 'legneed', room: CID, peer: 'peer3', name: 'Cici' }); // dia menerima, id-ku lebih kecil
    assert.deepStrictEqual(m.ctl.view().invites, []); assert.strictEqual(m.ctl.cur.legs.length, 2);
    assert.deepStrictEqual(m.of('callLeg')[0], ['callLeg', CID, 'peer3', 'OFFER-1']);
    ok('undangan keluar: lewat kaki aktif, daftar menunggu, hilang saat kaki terbentuk');
  }
  { // 2. undangan gagal / belum tersambung
    const m = await active();
    await m.ctl.invite('peer3', 'Cici');
    await m.ctl.onEvent({ ev: 'invitefail', room: CID, peer: 'peer3', name: 'Cici', reason: 'declined' });
    assert.deepStrictEqual(m.ctl.view().invites, []);
    assert.deepStrictEqual(m.failed, [{ peer: 'peer3', name: 'Cici', reason: 'declined' }]);
    const m2 = mk(); await m2.ctl.start('peer1', 'Budi');
    assert.strictEqual((await m2.ctl.invite('peer3')).ok, false, 'belum tersambung');
    assert.strictEqual(m2.of('callInvite').length, 0);
    ok('undangan gagal dilaporkan; sebelum tersambung tidak bisa mengundang');
  }
  { // 3. diundang: berdering, terima -> mikrofon -> Core; legneed (aku penelepon) dan tawaran masuk (dia penelepon)
    const m = mk(); await m.ctl.onEvent(INVITED);
    let v = m.ctl.view();
    assert.strictEqual(v.invite, true); assert.strictEqual(v.canAccept, true); assert.strictEqual(v.room, ROOM); assert.strictEqual(v.name, 'Budi');
    assert.deepStrictEqual(m.rings, ['in']);
    const r = await m.ctl.accept();
    assert.deepStrictEqual(r, { ok: true });
    assert.deepStrictEqual(m.of('callInviteAccept')[0], ['callInviteAccept', ROOM]);
    assert.strictEqual(m.mics.length, 1);
    v = m.ctl.view(); assert.strictEqual(v.phase, 'connecting'); assert.strictEqual(v.invite, false);
    await m.ctl.onEvent({ ev: 'legneed', room: ROOM, peer: 'peer9', name: 'Zed' });
    await m.ctl.onEvent({ ev: 'incoming', cid: IN(1), room: ROOM, auto: true, peer: 'peer1', name: 'Budi', sdp: 'OFF1' });
    assert.strictEqual(m.ctl.cur.legs.length, 2);
    assert.deepStrictEqual(m.of('callLeg')[0], ['callLeg', ROOM, 'peer9', 'OFFER-0']);
    assert.deepStrictEqual(m.of('callAnswer')[0], ['callAnswer', IN(1), 'ANSWER-1']);
    assert.strictEqual(m.pcs()[0].senders[0].track, m.pcs()[1].senders[0].track, 'satu mikrofon untuk semua kaki');
    m.pcs()[1].state('connected');
    v = m.ctl.view(); assert.strictEqual(v.phase, 'active'); assert.strictEqual(m.ctl.cur.joining, false);
    ok('diundang: terima -> legneed + tawaran masuk -> aktif');
  }
  { // 4. legneed tiba sebelum jawaban IPC callInviteAccept (urutan kanal event vs invoke tidak dijamin)
    let release; const acceptGate = new Promise((r) => { release = r; });
    const m = mk({ acceptGate }); await m.ctl.onEvent(INVITED);
    const p = m.ctl.accept(); await flush(); await flush();
    await m.ctl.onEvent({ ev: 'legneed', room: ROOM, peer: 'peer9', name: 'Zed' });
    assert.strictEqual(m.of('callLeg').length, 1, 'kaki dibuat walau jawaban belum tiba');
    release(); assert.deepStrictEqual(await p, { ok: true });
    ok('legneed sebelum jawaban IPC tetap diproses');
  }
  { // 5. tolak, kedaluwarsa, dibatalkan pengundang
    const m = mk(); await m.ctl.onEvent(INVITED); m.ctl.reject();
    assert.deepStrictEqual(m.of('callInviteDecline'), [['callInviteDecline', ROOM]]); assert.strictEqual(m.ctl.cur, null);
    assert.strictEqual(m.ended[0].reason, 'rejected'); assert.strictEqual(m.of('callReject').length, 0);
    const m2 = mk(); await m2.ctl.onEvent(INVITED); await m2.ctl.onEvent({ ev: 'inviteend', room: ROOM, peer: 'peer1', reason: 'expired' });
    assert.strictEqual(m2.ctl.cur, null); assert.strictEqual(m2.ended[0].reason, 'missed'); assert.strictEqual(m2.of('callInviteDecline').length, 0);
    const m3 = mk(); await m3.ctl.onEvent(INVITED); await m3.ctl.onEvent({ ev: 'inviteend', room: ROOM, peer: 'peer1', reason: 'cancelled' });
    assert.strictEqual(m3.ended[0].reason, 'cancelled');
    const m4 = mk(); await m4.ctl.onEvent(INVITED); await m4.ctl.onEvent({ ev: 'inviteend', room: 'e1'.repeat(8), peer: 'peer1', reason: 'expired' });
    assert.ok(m4.ctl.cur, 'undangan ruang lain tidak mengganggu');
    ok('undangan ditolak / kedaluwarsa / dibatalkan');
  }
  { // 6. batal di tengah dialog izin mikrofon: Core diberi tahu undangan ditolak, mikrofon dilepas; undangan kedaluwarsa saat dialog terbuka
    let release; const micGate = new Promise((r) => { release = r; });
    const m = mk({ micGate }); await m.ctl.onEvent(INVITED);
    const p = m.ctl.accept(); await flush(); m.ctl.hangup();
    assert.deepStrictEqual(m.of('callInviteDecline'), [['callInviteDecline', ROOM]]); assert.strictEqual(m.of('callLeave').length, 0);
    release(); await p; assert.strictEqual(m.mics[0].stopped, true); assert.strictEqual(m.of('callInviteAccept').length, 0);
    let rel2; const g2 = new Promise((r) => { rel2 = r; });
    const m2 = mk({ micGate: g2 }); await m2.ctl.onEvent(INVITED);
    const p2 = m2.ctl.accept(); await flush();
    await m2.ctl.onEvent({ ev: 'inviteend', room: ROOM, peer: 'peer1', reason: 'expired' });
    rel2(); await p2; assert.strictEqual(m2.mics[0].stopped, true); assert.strictEqual(m2.of('callInviteAccept').length, 0); assert.strictEqual(m2.ctl.cur, null);
    ok('batal / kedaluwarsa saat menunggu izin mikrofon');
  }
  { // 7. izin mikrofon ditolak: undangan ditolak ke Core
    const m = mk({ micFail: true }); await m.ctl.onEvent(INVITED); await m.ctl.accept();
    assert.deepStrictEqual(m.of('callInviteDecline'), [['callInviteDecline', ROOM]]); assert.strictEqual(m.ended[0].reason, 'mic'); assert.strictEqual(m.ctl.cur, null);
    ok('mikrofon ditolak -> undangan ditolak');
  }
  { // 8. Core menolak callInviteAccept (mis. sudah sibuk): berakhir dengan galat
    const m = mk({ acceptRes: { ok: false, err: 'Masih ada panggilan yang berlangsung' } }); await m.ctl.onEvent(INVITED); await m.ctl.accept();
    assert.strictEqual(m.ended[0].reason, 'error'); assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.mics[0].stopped, true);
    ok('callInviteAccept ditolak Core -> galat, mikrofon dilepas');
  }
  { // 9. keluar saat bergabung dan belum punya kaki: satu callLeave(room); keluar saat ada satu kaki yang belum aktif: juga callLeave
    const m = mk(); await m.ctl.onEvent(INVITED); await m.ctl.accept(); m.ctl.hangup();
    assert.deepStrictEqual(m.of('callLeave'), [['callLeave', ROOM]]); assert.strictEqual(m.of('callEnd').length, 0); assert.strictEqual(m.mics[0].stopped, true);
    const m2 = mk(); await m2.ctl.onEvent(INVITED); await m2.ctl.accept();
    await m2.ctl.onEvent({ ev: 'incoming', cid: IN(1), room: ROOM, auto: true, peer: 'peer1', name: 'Budi', sdp: 'OFF1' }); m2.ctl.hangup();
    assert.deepStrictEqual(m2.of('callLeave'), [['callLeave', ROOM]]); assert.strictEqual(m2.of('callEnd').length, 0);
    ok('keluar saat bergabung -> callLeave(room), tanpa kaki yatim di Core');
  }
  { // 10. bergabung: kaki tunggal jatuh sebelum aktif tidak membubarkan ruang; ruang bubar kalau Core bilang last
    const m = mk(); await m.ctl.onEvent(INVITED); await m.ctl.accept();
    await m.ctl.onEvent({ ev: 'incoming', cid: IN(1), room: ROOM, auto: true, peer: 'peer1', name: 'Budi', sdp: 'OFF1' });
    m.pcs()[0].state('failed');
    assert.ok(m.ctl.cur, 'masih menunggu anggota lain'); assert.strictEqual(m.ctl.cur.legs.length, 0);
    assert.deepStrictEqual(m.of('callEnd'), [['callEnd', IN(1)]]);
    await m.ctl.onEvent({ ev: 'end', cid: IN(1), room: ROOM, peer: 'peer1', reason: 'failed', wasActive: false, last: true });
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended.length, 1); assert.strictEqual(m.ended[0].reason, 'failed');
    // Core bubar-kan ruang tanpa kaki yang masih kupegang (waktu bergabung habis)
    const m2 = mk(); await m2.ctl.onEvent(INVITED); await m2.ctl.accept();
    await m2.ctl.onEvent({ ev: 'end', cid: ROOM, room: ROOM, peer: 'peer1', name: 'Budi', dir: 'in', reason: 'failed', wasActive: false, last: true });
    assert.strictEqual(m2.ctl.cur, null); assert.strictEqual(m2.ended[0].reason, 'failed');
    ok('bergabung: kaki jatuh tidak membubarkan ruang; end last dari Core menutup');
  }
  { // 11. sedang dalam panggilan lalu ada undangan: ditolak, panggilan berjalan
    const m = await active(); await m.ctl.onEvent(INVITED);
    assert.deepStrictEqual(m.of('callInviteDecline'), [['callInviteDecline', ROOM]]); assert.strictEqual(m.ctl.view().peer, 'peer1');
    ok('undangan saat sedang dalam panggilan ditolak');
  }
  { // 12. catatan 2b-2: kaki ke-2 gagal sebelum aktif, lalu kaki ke-1 menyusul putus
    const m = await active();
    await m.ctl.addLeg('peer2', 'Ani'); await m.ctl.onEvent({ ev: 'answer', cid: LEG(1), sdp: 'ANS2' });
    m.pcs()[1].state('failed'); // kaki 2 gagal (belum aktif)
    assert.strictEqual(m.ctl.cur.legs.length, 1); assert.deepStrictEqual(m.of('callEnd'), [['callEnd', LEG(1)]]); assert.strictEqual(m.ended.length, 0);
    m.pcs()[0].state('failed'); // kaki 1 menyusul
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ended.length, 1);
    assert.deepStrictEqual(m.of('callEnd'), [['callEnd', LEG(1)], ['callEnd', CID]]); assert.strictEqual(m.of('callLeave').length, 0);
    assert.strictEqual(m.ended[0].reason, 'ended'); assert.strictEqual(m.ended[0].wasActive, true);
    ok('kaki ke-2 gagal lalu kaki ke-1 putus: tiap kaki ditutup sekali, tidak ada kaki yatim');
  }
  console.log('\n' + pass + ' tes undangan + bergabung OK');
})().catch((e) => { console.error(e); process.exit(1); });
