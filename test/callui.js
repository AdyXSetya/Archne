'use strict';
// Tes sisi UI panggilan suara (v0.13.0 tahap 3): Controller WebRTC dengan RTC palsu, teks akhir panggilan, nada dering, izin mikrofon Electron,
// dan kontrak archne-index.html. Audio sungguhan tidak bisa dites di sini: lihat daftar uji manual di README.md bagian 6 (Manual tes).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const LC = require('../renderer/archne-call');
const { allowMedia, isAppUrl } = require('../src/archne-permissions');
const root = path.join(__dirname, '..');
const html = require('./_src').htmlSrc();
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));
const CID = 'a1'.repeat(8);

// ---------- palsu ----------
class FakePC {
  constructor(cfg) { this.cfg = cfg; this.tracks = []; this.remoteDescription = null; this.localDescription = null; this.ice = []; this.closed = false; this.connectionState = 'new'; FakePC.all.push(this); }
  addTrack(t) { this.tracks.push(t); }
  async createOffer() { return { type: 'offer', sdp: 'OFFER-SDP' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER-SDP' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { if (d.sdp === 'BAD') throw new Error('sdp rusak'); this.remoteDescription = d; }
  async addIceCandidate(c) { if (!this.remoteDescription) throw new Error('belum ada remote'); if (c && c.bad) throw new Error('kandidat buruk'); this.ice.push(c); }
  close() { this.closed = true; }
  gather(cand) { this.onicecandidate && this.onicecandidate({ candidate: { candidate: cand, toJSON() { return { candidate: cand, sdpMid: '0' }; } } }); }
  state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
FakePC.all = [];
const mkStream = () => { const t = { enabled: true, stopped: false, stop() { this.stopped = true; } }; return { t, getTracks: () => [t], getAudioTracks: () => [t] }; };

function sched() { // pewaktu palsu
  let now = 1000, id = 0; const q = new Map();
  return { now: () => now, setTimeout: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (i) => q.delete(i),
    tick(ms) { now += ms; for (const [i, t] of [...q]) if (t.at <= now) { q.delete(i); t.fn(); } }, pending: () => q.size };
}

function mk(opts) {
  opts = opts || {};
  FakePC.all = [];
  const s = sched(), calls = [], ui = { renders: [], rings: [], ended: [] }, streams = [];
  const gate = { gum: null }; // bila diisi: promise yang ditunggu getUserMedia
  const api = new Proxy({}, { get: (_t, n) => async (...a) => {
    calls.push([n, ...a]);
    if (n === 'callStart') { if (opts.startDelay) await opts.startDelay; return opts.startRes || { ok: true, cid: CID }; }
    return { ok: true };
  } });
  const rtc = {
    PeerConnection: FakePC,
    getUserMedia: async () => { if (gate.gum) await gate.gum; if (opts.micDenied) throw new Error('NotAllowedError'); const st = mkStream(); streams.push(st); return st; },
    makeStream: (tr) => ({ tr }),
    playRemote: (st) => { calls.push(['playRemote']); return () => calls.push(['stopRemote']); },
  };
  const ctl = new LC.Controller({ api, rtc, ui: { render: (v) => ui.renders.push(v), ring: (k) => ui.rings.push(k), ended: (i) => ui.ended.push(i) }, now: s.now, setTimeout: s.setTimeout, clearTimeout: s.clearTimeout });
  const names = () => calls.map((c) => c[0]);
  const lastView = () => ui.renders[ui.renders.length - 1];
  return { ctl, api, calls, ui, s, gate, streams, names, lastView, pc: () => FakePC.all[FakePC.all.length - 1] };
}

(async () => {
  // ---------- 1. fungsi murni ----------
  assert.deepStrictEqual([0, 5, 65, 3599, 3600, 3725, -3, 'x'].map(LC.fmtDur), ['00:00', '00:05', '01:05', '59:59', '1:00:00', '1:02:05', '00:00', '00:00']);
  const E = (o) => LC.endText(Object.assign({ wasActive: false, dur: 0, name: 'Budi', local: false }, o));
  assert.strictEqual(E({ reason: 'ended', wasActive: true, dur: 83 }), 'Panggilan berakhir · 01:23');
  assert.strictEqual(E({ reason: 'missed' }), 'Panggilan tak terjawab dari Budi');
  assert.strictEqual(E({ reason: 'rejected' }), 'Panggilan ditolak');
  assert.strictEqual(E({ reason: 'busy' }), 'Budi sedang dalam panggilan lain');
  assert.strictEqual(E({ reason: 'noanswer' }), 'Tidak dijawab');
  assert(/offline/.test(E({ reason: 'unreachable' })) && /Gagal tersambung/.test(E({ reason: 'failed' })) && /Mikrofon/.test(E({ reason: 'mic' })));
  assert.strictEqual(E({ reason: 'error', err: 'Dia sedang offline' }), 'Dia sedang offline');
  assert.strictEqual(E({ reason: 'glare' }), '', 'saling menelepon bersamaan: diam');
  assert.strictEqual(E({ reason: 'cancelled', local: true }), '', 'tindakan sendiri: tanpa toast');
  assert.strictEqual(E({ reason: 'rejected', local: true }), '');
  assert.strictEqual(E({ reason: 'ended', wasActive: true, dur: 5, local: true }), 'Panggilan berakhir · 00:05', 'panggilan yang sempat tersambung selalu menampilkan durasi');
  ok('fmtDur dan teks akhir panggilan (tindakan sendiri diam, durasi hanya bila sempat tersambung)');

  // ---------- 2. keluar: mic -> tawaran -> ICE tertahan -> jawaban -> tersambung -> bisu -> tutup ----------
  {
    let release; const delay = new Promise((r) => { release = r; });
    const m = mk({ startDelay: delay });
    const p = m.ctl.start('peer1', 'Budi');
    await flush();
    assert.deepStrictEqual(m.ui.rings, ['out']);
    assert.strictEqual(m.lastView().phase, 'dialing');
    await flush();
    assert.deepStrictEqual(m.pc().cfg, { iceServers: [] }, 'tanpa server STUN/TURN');
    assert.strictEqual(m.pc().tracks.length, 1);
    assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callStart'), ['callStart', 'peer1', 'OFFER-SDP']);
    m.pc().gather('candidate:1 host'); // inti belum membalas: kandidat harus ditahan
    assert(!m.names().includes('callIce'));
    release(); const r = await p;
    assert.deepStrictEqual(r, { ok: true, cid: CID });
    const ice = m.calls.filter((c) => c[0] === 'callIce');
    assert.strictEqual(ice.length, 1); assert.strictEqual(ice[0][1], CID); assert.strictEqual(JSON.parse(ice[0][2]).candidate, 'candidate:1 host');
    m.pc().gather('candidate:2 host'); assert.strictEqual(m.calls.filter((c) => c[0] === 'callIce').length, 2, 'setelah cid ada: langsung dikirim');
    m.pc().gather(''); m.pc().onicecandidate({ candidate: null }); assert.strictEqual(m.calls.filter((c) => c[0] === 'callIce').length, 2, 'akhir pengumpulan tidak dikirim');
    // ICE dari lawan datang sebelum jawaban: ditahan
    await m.ctl.onEvent({ ev: 'ice', cid: CID, data: JSON.stringify({ candidate: 'remote-1' }) });
    assert.strictEqual(m.pc().ice.length, 0);
    await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'ANS' });
    assert.strictEqual(m.pc().remoteDescription.type, 'answer');
    assert.strictEqual(m.pc().ice.length, 1, 'ICE tertahan dilepas setelah jawaban');
    assert.strictEqual(m.lastView().phase, 'connecting'); assert.strictEqual(m.ui.rings[m.ui.rings.length - 1], null, 'nada tunggu berhenti');
    await m.ctl.onEvent({ ev: 'ice', cid: CID, data: JSON.stringify({ candidate: 'remote-2' }) });
    assert.strictEqual(m.pc().ice.length, 2);
    await m.ctl.onEvent({ ev: 'ice', cid: CID, data: JSON.stringify({ bad: true }) }); // kandidat buruk tidak menjatuhkan
    await m.ctl.onEvent({ ev: 'ice', cid: 'f'.repeat(16), data: '{}' }); // panggilan lain: diabaikan
    assert(m.ctl.cur);
    m.pc().ontrack({ streams: [{}], track: {} });
    assert(m.names().includes('playRemote'), 'audio lawan diputar');
    m.pc().state('connecting'); assert.strictEqual(m.lastView().phase, 'connecting');
    m.pc().state('connected');
    assert.strictEqual(m.lastView().phase, 'active'); assert(m.names().includes('callConnected'));
    m.s.tick(65000); assert.strictEqual(LC.fmtDur(m.ctl.elapsed()), '01:05');
    assert.strictEqual(m.ctl.mute(), true); assert.strictEqual(m.streams[0].t.enabled, false); assert.strictEqual(m.lastView().muted, true);
    assert.strictEqual(m.ctl.mute(), false); assert.strictEqual(m.streams[0].t.enabled, true);
    m.ctl.hangup();
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.lastView(), null);
    assert(m.pc().closed && m.streams[0].t.stopped && m.names().includes('stopRemote'), 'koneksi, mikrofon, dan audio lawan dilepas');
    assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callEnd'), ['callEnd', CID]);
    const e = m.ui.ended[0]; assert(e.wasActive && Math.round(e.dur) === 65 && e.reason === 'ended');
    m.ctl.hangup(); assert.strictEqual(m.calls.filter((c) => c[0] === 'callEnd').length, 1, 'hangup ganda aman');
    ok('keluar: ICE tertahan sampai cid ada, ICE lawan tertahan sampai jawaban, tersambung, bisu, tutup melepas semuanya');
  }

  // ---------- 3. masuk: dering -> terima -> tersambung -> lawan menutup ----------
  {
    const m = mk();
    await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'REMOTE-OFFER', ice: [JSON.stringify({ candidate: 'early-1' })] });
    assert.deepStrictEqual(m.ui.rings, ['in']); assert(m.lastView().canAccept && m.lastView().phase === 'ringing');
    assert.strictEqual(FakePC.all.length, 0, 'belum menyentuh mikrofon/RTC sebelum diterima');
    await m.ctl.onEvent({ ev: 'ice', cid: CID, data: JSON.stringify({ candidate: 'early-2' }) });
    await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'REMOTE-OFFER' }); // snapshot ganda: diabaikan
    assert.strictEqual(m.ui.rings.length, 1);
    const r = await m.ctl.accept();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(m.pc().remoteDescription, { type: 'offer', sdp: 'REMOTE-OFFER' });
    assert.strictEqual(m.pc().ice.length, 2, 'ICE yang datang saat berdering dipasang setelah diterima');
    assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callAnswer'), ['callAnswer', CID, 'ANSWER-SDP']);
    assert.strictEqual(m.lastView().phase, 'connecting'); assert.strictEqual(m.ui.rings[m.ui.rings.length - 1], null);
    assert.deepStrictEqual(await m.ctl.accept(), { ok: false }, 'terima dua kali tidak membuat koneksi kedua');
    assert.strictEqual(FakePC.all.length, 1);
    m.pc().state('connected'); assert.strictEqual(m.lastView().phase, 'active');
    await m.ctl.onEvent({ ev: 'end', cid: CID, reason: 'ended', wasActive: true });
    assert.strictEqual(m.ctl.cur, null); assert(m.pc().closed && m.streams[0].t.stopped);
    assert.strictEqual(m.ui.ended[0].reason, 'ended'); assert(m.ui.ended[0].wasActive);
    assert(!m.names().includes('callEnd'), 'lawan yang menutup: tidak perlu memberi tahu inti lagi');
    ok('masuk: tidak menyentuh mikrofon sebelum diterima; ICE dini dipasang; terima ganda aman; lawan menutup');
  }

  // ---------- 4. tolak, mikrofon ditolak, dibatalkan saat menunggu izin ----------
  {
    let m = mk();
    await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'S' });
    m.ctl.reject();
    assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callReject'), ['callReject', CID]);
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(E(m.ui.ended[0]), '');
    m.ctl.reject(); assert.strictEqual(m.calls.filter((c) => c[0] === 'callReject').length, 1);

    m = mk({ micDenied: true });
    assert.deepStrictEqual(await m.ctl.start('peer1', 'Budi'), { ok: false });
    assert.strictEqual(m.ui.ended[0].reason, 'mic'); assert(!m.names().includes('callStart'), 'tanpa mikrofon tidak menelepon');
    assert.strictEqual(m.ctl.cur, null);
    m = mk({ micDenied: true });
    await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'S' });
    await m.ctl.accept();
    assert.strictEqual(m.ui.ended[0].reason, 'mic'); assert(m.names().includes('callReject'), 'mikrofon ditolak saat menerima: penelepon diberi tahu ditolak');
    assert.strictEqual(m.ctl.cur, null);

    // menutup saat dialog izin masih terbuka: mikrofon yang akhirnya diberikan harus dilepas dan tidak ada tawaran
    let rel; m = mk(); m.gate.gum = new Promise((r) => { rel = r; });
    const p = m.ctl.start('peer1', 'Budi'); await flush();
    m.ctl.hangup(); rel(); await p; await flush();
    assert(!m.names().includes('callStart') && m.streams[0].t.stopped && FakePC.all.length === 0);
    // penelepon membatalkan saat penerima masih memilih izin
    m = mk(); await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'S' });
    m.gate.gum = new Promise((r) => { rel = r; });
    const pa = m.ctl.accept(); await flush();
    await m.ctl.onEvent({ ev: 'end', cid: CID, reason: 'missed' });
    rel(); await pa; await flush();
    assert(m.streams[0].t.stopped && !m.names().includes('callAnswer'), 'tidak menjawab panggilan yang sudah dibatalkan');
    ok('tolak, mikrofon ditolak (keluar dan masuk), menutup/dibatalkan saat dialog izin terbuka tidak membocorkan mikrofon');
  }

  // ---------- 5. gagal dari inti, tutup saat menunggu inti, ditolak/sibuk ----------
  {
    let m = mk({ startRes: { ok: false, err: 'Dia sedang offline' } });
    await m.ctl.start('peer1', 'Budi');
    assert.strictEqual(E(m.ui.ended[0]), 'Dia sedang offline'); assert.strictEqual(m.ctl.cur, null); assert(m.pc().closed && m.streams[0].t.stopped);

    let rel; const delay = new Promise((r) => { rel = r; });
    m = mk({ startDelay: delay });
    const p = m.ctl.start('peer1', 'Budi'); await flush(); await flush();
    m.ctl.hangup(); rel(); await p;
    assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callEnd'), ['callEnd', CID], 'inti baru membalas setelah ditutup: panggilan itu tetap diakhiri');

    for (const [reason, text] of [['rejected', 'Panggilan ditolak'], ['busy', 'Budi sedang dalam panggilan lain'], ['noanswer', 'Tidak dijawab'], ['unreachable', 'Tidak terjangkau. Dia sedang offline?']]) {
      m = mk(); await m.ctl.start('peer1', 'Budi');
      await m.ctl.onEvent({ ev: 'end', cid: CID, reason });
      assert.strictEqual(E(m.ui.ended[0]), text); assert.strictEqual(m.ctl.cur, null);
    }
    // saling menelepon bersamaan: yang mengalah berhenti diam-diam lalu menerima tawaran masuk
    m = mk(); await m.ctl.start('peer1', 'Budi');
    await m.ctl.onEvent({ ev: 'end', cid: CID, reason: 'glare' });
    assert.strictEqual(E(m.ui.ended[0]), ''); assert.strictEqual(m.ctl.cur, null);
    await m.ctl.onEvent({ ev: 'incoming', cid: 'b2'.repeat(8), peer: 'peer1', name: 'Budi', sdp: 'S' });
    assert.strictEqual(m.lastView().cid, 'b2'.repeat(8));
    // sedang sibuk di sisi UI: tawaran lain ditolak, panggilan berjalan tidak terganggu
    await m.ctl.onEvent({ ev: 'incoming', cid: 'c3'.repeat(8), peer: 'peer2', name: 'Ani', sdp: 'S' });
    assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callReject'), ['callReject', 'c3'.repeat(8)]); assert.strictEqual(m.ctl.cur.cid, 'b2'.repeat(8));
    // tawaran masuk yang tidak berdering karena sibuk: dicatat tak terjawab
    m = mk(); await m.ctl.onEvent({ ev: 'missed', cid: 'd4'.repeat(8), peer: 'peer2', name: 'Ani', reason: 'busy' });
    assert.strictEqual(E(m.ui.ended[0]), 'Panggilan tak terjawab dari Ani');
    // start saat sudah ada panggilan
    m = mk(); await m.ctl.start('peer1', 'Budi'); assert.deepStrictEqual(await m.ctl.start('peer2', 'Ani'), { ok: false }); assert.strictEqual(m.ctl.cur.peer, 'peer1');
    ok('gagal dari inti, tutup saat menunggu inti, ditolak/sibuk/tak dijawab/glare, tawaran kedua ditolak, tak terjawab karena sibuk');
  }

  // ---------- 6. kegagalan koneksi ----------
  {
    let m = mk(); await m.ctl.start('peer1', 'Budi'); await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'A' });
    m.pc().state('failed');
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ui.ended[0].reason, 'failed'); assert(/Gagal tersambung/.test(E(m.ui.ended[0])));
    assert.deepStrictEqual(m.calls.find((c) => c[0] === 'callEnd'), ['callEnd', CID]);

    m = mk(); await m.ctl.start('peer1', 'Budi'); await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'A' }); m.pc().state('connected');
    m.pc().state('disconnected'); assert(m.ctl.cur, 'putus sesaat: masih ditunggu');
    m.s.tick(3000); m.pc().state('connected'); m.s.tick(20000); assert(m.ctl.cur, 'pulih sebelum batas: lanjut');
    assert.strictEqual(m.s.pending(), 0, 'pewaktu putus dibatalkan saat pulih');
    m.pc().state('disconnected'); m.s.tick(LC.DISCONNECT_GRACE_MS + 10);
    assert.strictEqual(m.ctl.cur, null); assert(m.ui.ended[0].wasActive && m.ui.ended[0].reason === 'ended' && m.names().includes('callEnd'));

    m = mk(); await m.ctl.start('peer1', 'Budi');
    await m.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'BAD' });
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ui.ended[0].reason, 'failed'); assert(m.names().includes('callEnd'), 'SDP rusak dari lawan: panggilan diakhiri');
    m = mk(); await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'peer1', name: 'Budi', sdp: 'BAD' });
    await m.ctl.accept();
    assert.strictEqual(m.ctl.cur, null); assert.strictEqual(m.ui.ended[0].reason, 'error'); assert(m.names().includes('callEnd') && m.streams[0].t.stopped);
    ok('failed, putus sesaat yang pulih / tidak pulih, SDP rusak dari lawan (keluar dan masuk)');
  }

  // ---------- 7. sync dengan state (event terlewat) ----------
  {
    let m = mk();
    m.ctl.sync({ cid: CID, peer: 'peer1', name: 'Budi', dir: 'in', state: 'ringing', sdp: 'SNAP-OFFER', ice: [JSON.stringify({ candidate: 'snap-ice' })] });
    await flush();
    assert.strictEqual(m.lastView().cid, CID); assert(m.lastView().canAccept); assert.deepStrictEqual(m.ui.rings, ['in']);
    m.ctl.sync({ cid: CID, peer: 'peer1', name: 'Budi', dir: 'in', state: 'ringing', sdp: 'SNAP-OFFER', ice: [] }); await flush();
    assert.strictEqual(m.ui.rings.length, 1, 'snapshot yang sama tidak berdering dua kali');
    await m.ctl.accept(); assert.strictEqual(m.pc().ice.length, 1, 'ICE dari snapshot ikut dipasang');
    m.s.tick(500); m.ctl.sync(null); assert(m.ctl.cur, 'snapshot basi tepat setelah panggilan dibuat tidak mengakhirinya');
    m.s.tick(LC.SYNC_GUARD_MS); m.ctl.sync(null);
    assert.strictEqual(m.ctl.cur, null, 'inti sudah tidak punya panggilan: UI menyusul');
    m = mk(); m.ctl.sync({ cid: CID, peer: 'p', name: 'x', dir: 'out', state: 'active' });
    assert.deepStrictEqual(m.calls[0], ['callEnd', CID], 'panggilan yang media-nya hilang (halaman dimuat ulang) diakhiri');
    ok('sync: dering dari snapshot (tanpa ganda, ICE ikut), snapshot basi diabaikan, panggilan yatim diakhiri');
  }

  // ---------- 8. tampilan layar panggilan ----------
  {
    const h = { esc: (s) => String(s).replace(/</g, '&lt;'), avatar: (id) => `<av ${id}>`, icons: { phone: '<P/>', mic: '<M/>', micOff: '<X/>' } };
    const acts = (v) => [...LC.overlayHtml(v, h).matchAll(/data-cact="(\w+)"/g)].map((x) => x[1]);
    assert.strictEqual(LC.overlayHtml(null, h), '');
    assert.deepStrictEqual(acts({ phase: 'ringing', canAccept: true, peer: 'p', name: 'N' }), ['reject', 'accept']);
    assert.deepStrictEqual(acts({ phase: 'dialing', peer: 'p', name: 'N' }), ['min', 'mute', 'deafen', 'hang']);
    assert.deepStrictEqual(acts({ phase: 'active', peer: 'p', name: 'N', since: 1 }), ['min', 'mute', 'cam', 'deafen', 'add', 'hang']);
    assert(/Batal/.test(LC.overlayHtml({ phase: 'dialing', peer: 'p', name: 'N' }, h)) && /Akhiri/.test(LC.overlayHtml({ phase: 'active', peer: 'p', name: 'N', since: 1 }, h)));
    assert(/Memanggil/.test(LC.overlayHtml({ phase: 'dialing', peer: 'p', name: 'N' }, h)) && /masuk/.test(LC.overlayHtml({ phase: 'ringing', canAccept: true, peer: 'p', name: 'N' }, h)));
    const x = LC.overlayHtml({ phase: 'dialing', peer: 'p', name: '<img onerror=x>' }, h);
    assert(!x.includes('<img') && x.includes('&lt;img'), 'nama peer di-escape');
    assert(/Suara mati/.test(LC.overlayHtml({ phase: 'active', muted: true, peer: 'p', name: 'N', since: 1 }, h)));
    assert(acts({ phase: 'active', peer: 'p', name: 'N', since: 1 }).length === 6 && !acts({ phase: 'active', peer: 'p', name: 'N', since: 1 }).includes('speaker'));
    assert.deepStrictEqual(acts({ phase: 'active', peer: 'p', name: 'N', since: 1, muted: false }).concat(), ['min', 'mute', 'cam', 'deafen', 'add', 'hang']);
    const sp = [...LC.overlayHtml({ phase: 'active', peer: 'p', name: 'N', since: 1 }, Object.assign({ speaker: true }, h)).matchAll(/data-cact="(\w+)"/g)].map((q) => q[1]);
    assert.deepStrictEqual(sp, ['min', 'mute', 'cam', 'deafen', 'speaker', 'add', 'hang'], 'tombol speaker hanya bila cangkangnya menyediakan (Android)');
    ok('layar panggilan: tombol sesuai fase, teks, escape nama, speaker opsional');
  }

  // ---------- 9. nada dering ----------
  {
    const osc = []; let ctxN = 0;
    class FakeCtx { constructor() { ctxN++; this.currentTime = 0; this.state = 'running'; this.destination = {}; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
      createOscillator() { const o = { frequency: {}, connect() {}, start() {}, stop() {} }; osc.push(o); return o; } }
    const ints = []; const T = { setInterval: (fn, ms) => { ints.push({ fn, ms, on: true }); return ints.length; }, clearInterval: (i) => { ints[i - 1].on = false; } };
    const r = LC.makeRinger(FakeCtx, T);
    r.start('in'); assert.strictEqual(osc.length, 2, 'dering masuk: dua nada'); assert.strictEqual(ints[0].ms, 3000); assert(r.playing);
    ints[0].fn(); assert.strictEqual(osc.length, 4, 'berulang');
    r.start('out'); assert(!ints[0].on && ints[1].on && ints[1].ms === 4000 && osc.length === 5, 'ganti jenis: yang lama berhenti');
    r.stop(); assert(!ints[1].on && !r.playing); r.stop();
    assert.strictEqual(ctxN, 1, 'satu AudioContext dipakai ulang');
    const none = LC.makeRinger(null, T); none.start('in'); none.stop();
    ok('nada dering: dua nada berulang untuk masuk, nada tunggu untuk keluar, berhenti bersih, tanpa AudioContext tidak melempar');
  }

  // ---------- 10. izin mikrofon Electron ----------
  {
    const dir = path.join(root, 'renderer'), url = 'file://' + path.join(dir, 'archne-index.html').replace(/\\/g, '/');
    const winUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
    assert(isAppUrl(winUrl(path.join(dir, 'archne-index.html')), dir));
    assert.strictEqual(allowMedia('media', { url, mediaTypes: ['audio'] }, dir), true);
    assert.strictEqual(allowMedia('media', { url, mediaTypes: ['audio', 'video'] }, dir), true, 'panggilan video: mikrofon + kamera');
    assert.strictEqual(allowMedia('media', { url, mediaTypes: ['video'] }, dir), true, 'balik kamera: video saja');
    assert.strictEqual(allowMedia('media', { url, mediaTypes: [] }, dir), false);
    assert.strictEqual(allowMedia('media', { url, mediaTypes: ['audio', 'screen'] }, dir), false);
    assert.strictEqual(allowMedia('media', { url: 'https://evil.example/', mediaTypes: ['audio', 'video'] }, dir), false, 'kamera bukan untuk halaman luar');
    assert.strictEqual(allowMedia('media', { url: 'https://evil.example/', mediaTypes: ['audio'] }, dir), false, 'bukan halaman aplikasi');
    assert.strictEqual(allowMedia('media', { url: 'file:///etc/passwd', mediaTypes: ['audio'] }, dir), false, 'berkas lokal lain bukan aplikasi');
    assert.strictEqual(allowMedia('media', { url: 'file://' + path.join(dir, '..', 'secret.html').replace(/\\/g, '/'), mediaTypes: ['audio'] }, dir), false, 'keluar dari renderer/');
    for (const p of ['geolocation', 'notifications', 'camera', 'clipboard-read', 'openExternal', 'midi']) assert.strictEqual(allowMedia(p, { url, mediaTypes: ['audio'] }, dir), false, p);
    assert.strictEqual(allowMedia('media', { origin: 'file:///', mediaType: 'audio' }, dir), true, 'pemeriksaan hanya dengan origin file://');
    assert.strictEqual(allowMedia('media', { origin: 'file:///', mediaType: 'video' }, dir), true);
    assert.strictEqual(allowMedia('media', { origin: 'https://evil.example', mediaType: 'audio' }, dir), false);
    assert.strictEqual(allowMedia('media', { origin: 'file:///', mediaType: 'unknown' }, dir), false);
    assert.strictEqual(allowMedia('media', null, dir), false);
    ok('izin Electron: hanya mikrofon, hanya halaman aplikasi, semua izin lain dan kamera ditolak');
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert(/setPermissionRequestHandler/.test(mainSrc) && /setPermissionCheckHandler/.test(mainSrc) && /autoplayPolicy: 'no-user-gesture-required'/.test(mainSrc));
    ok('main.js memasang penangan izin dan autoplayPolicy');
  }

  // ---------- 11. kontrak archne-index.html + render di vm ----------
  {
    assert(/<script src="archne-call\.js"><\/script>/.test(html) && fs.existsSync(path.join(root, 'renderer', 'archne-call.js')));
    assert(html.indexOf('<script src="archne-call.js">') < html.indexOf('<script src="js/archne-state-util.js">'), 'archne-call.js dimuat sebelum skrip utama');
    assert(/id="callov"/.test(html));
    assert(/default-src 'self'; img-src data: archne-media: 'self'; media-src blob: 'self' archne-media:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self' wss: ws:\/\/localhost:\* ws:\/\/127\.0\.0\.1:\*"/.test(html) && !/'unsafe-eval'/.test(html), "CSP tetap ketat: hanya 'wasm-unsafe-eval' (untuk RNNoise, v0.17.0), tanpa 'unsafe-eval'; connect-src hanya self, wss: dan ws localhost (broker lintas jaringan, v0.21.0)");
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    for (const n of ['callStart', 'callAnswer', 'callIce', 'callConnected', 'callReject', 'callEnd', 'onCall']) assert(new RegExp('^\\s{2}' + n + ':', 'm').test(preload), n);

    const inline = require('./_src').inlineJs();
    const els = {}, bodyCls = new Set();
    const mkEl = (id) => ({ id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0, handlers: {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      addEventListener() {}, focus() {}, requestSubmit() {} });
    const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null,
      body: { classList: { add: (c) => bodyCls.add(c), remove: (c) => bodyCls.delete(c), contains: (c) => bodyCls.has(c) } } };
    const calls = []; let callCb = null, state;
    const api = new Proxy({}, { get: (_t, n) => {
      if (n === 'state') return async () => state;
      if (n === 'onCall') return (cb) => { callCb = cb; };
      if (['onProgress', 'onUpdate', 'onRemoved'].includes(n)) return () => {};
      if (n === 'callStart') return async (...a) => { calls.push([n, ...a]); return { ok: true, cid: CID }; };
      return async (...a) => { calls.push([n, ...a]); return { ok: true }; };
    } });
    FakePC.all = [];
    const win = { api, addEventListener: () => {}, LanCall: LC, RTCPeerConnection: FakePC, MediaStream: function (t) { this.t = t; }, Audio: function () { this.play = () => Promise.resolve(); this.pause = () => {}; },
      navigator: { mediaDevices: { getUserMedia: async () => mkStream() } } };
    const ctx = { window: win, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON };
    vm.createContext(ctx);
    state = { me: { id: 'me', name: 'Saya', port: 1 }, peers: [{ id: 'peer1', name: 'Budi', online: true, secure: true }], groups: [], messages: [], sending: [], limits: { maxText: 10000 }, call: null };
    vm.runInContext(inline, ctx); await flush(); await flush();
    assert(!els.head.innerHTML.includes('callbtn'), 'obrolan publik: tanpa tombol telepon');
    vm.runInContext("pickChat('peer1')", ctx); await flush();
    assert(els.head.innerHTML.includes('id="callbtn"'), 'DM: ada tombol telepon');
    assert(els.head.innerHTML.includes('id="vcallbtn"'), 'DM: ada tombol panggilan video');
    vm.runInContext("pickChat('public')", ctx);
    assert(!els.head.innerHTML.includes('callbtn'));
    vm.runInContext("pickChat('peer1')", ctx);
    state.peers[0].online = false; await els.callbtn.onclick(); assert.strictEqual(els.toast.style.display, 'block'); assert(/offline/.test(els.toast.textContent)); assert(!calls.some((c) => c[0] === 'callStart'));
    await els.vcallbtn.onclick(); assert(/offline/.test(els.toast.textContent) && !calls.some((c) => c[0] === 'callStart'), 'tombol video memakai aturan yang sama (offline)');
    state.peers[0].online = true; state.peers[0].secure = false; vm.runInContext('refresh()', ctx); await flush(); await flush();
    await els.callbtn.onclick(); assert(/enkripsi/.test(els.toast.textContent) && !calls.some((c) => c[0] === 'callStart'));
    state.peers[0].secure = true; vm.runInContext('refresh()', ctx); await flush(); await flush();
    els.callbtn.onclick(); await flush(); await flush(); await flush();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'callStart'), ['callStart', 'peer1', 'OFFER-SDP']);
    assert(els.callov.style.display === 'flex' && /Memanggil/.test(els.callov.innerHTML) && /Budi/.test(els.callov.innerHTML) && bodyCls.has('incall'));
    // tombol di layar panggilan
    const press = (a) => els.callov.onclick({ target: { closest: (sel) => (/cact/.test(sel) ? { dataset: { cact: a } } : null) } });
    press('mute'); assert(/Suara mati/.test(els.callov.innerHTML));
    calls.length = 0; press('hang'); assert.deepStrictEqual(calls[0], ['callEnd', CID]);
    assert(els.callov.style.display === 'none' && els.callov.innerHTML === '' && !bodyCls.has('incall'));
    // panggilan masuk dari event
    calls.length = 0;
    callCb({ ev: 'incoming', cid: 'e5'.repeat(8), peer: 'peer1', name: 'Budi', sdp: 'S' }); await flush();
    assert(els.callov.style.display === 'flex' && /data-cact="accept"/.test(els.callov.innerHTML) && /data-cact="reject"/.test(els.callov.innerHTML));
    press('reject'); assert.deepStrictEqual(calls[0], ['callReject', 'e5'.repeat(8)]); assert.strictEqual(els.callov.style.display, 'none');
    // panggilan masuk yang hanya ada di state (event terlewat)
    state.call = { cid: 'f6'.repeat(8), peer: 'peer1', name: 'Budi', dir: 'in', state: 'ringing', at: 1, sdp: 'S', ice: [] };
    vm.runInContext('refresh()', ctx); await flush(); await flush();
    assert(els.callov.style.display === 'flex' && /data-cact="accept"/.test(els.callov.innerHTML), 'dering muncul dari snapshot state');
    ok('archne-index.html: tombol telepon hanya di DM, offline/tanpa enkripsi ditolak dengan toast, layar panggilan keluar/masuk, tombol Bisukan/Akhiri/Tolak, dering dari snapshot');

    // tanpa dukungan WebRTC (mis. peramban lama): fitur mati total, UI lain tidak terpengaruh
    const els2 = {}; const doc2 = Object.assign({}, doc, { getElementById: (id) => els2[id] || (els2[id] = mkEl(id)) });
    const ctx2 = Object.assign({}, ctx, { document: doc2, window: { api, addEventListener: () => {}, LanCall: LC, navigator: {} } });
    vm.createContext(ctx2); vm.runInContext(inline, ctx2); await flush(); await flush();
    vm.runInContext("pickChat('peer1')", ctx2);
    assert(!els2.head.innerHTML.includes('callbtn'));
    ok('tanpa WebRTC/mikrofon di peramban: tombol telepon tidak muncul, UI lain normal');
  }

  console.log(`\n${pass} tes UI panggilan OK`);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
