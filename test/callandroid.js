'use strict';
// Tes panggilan suara untuk cangkang Android (v0.13.0 tahap 4): jembatan UI <-> halaman induk, sesi audio di Controller, halaman induk
// (mobile/shell/index.html) dijalankan di vm dengan Capacitor palsu, dan kontrak berkas plugin/manifest.
// Yang TIDAK bisa dites di sini: Java (tidak ada JDK/Android SDK), WebView, mikrofon, rute earpiece/speaker. Lihat README.md bagian 6 (Manual tes).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const LC = require('../renderer/archne-call');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const flush = () => new Promise((r) => setImmediate(r));

// ---------- palsu: window di dalam iframe ----------
function fakeWin() {
  const ls = [];
  const parent = { posted: [], postMessage(m, o) { parent.posted.push([m, o]); } };
  const w = { parent, addEventListener: (t, f) => { if (t === 'message') ls.push(f); }, send(data, source) { for (const f of ls) f({ data, source: source === undefined ? parent : source }); } };
  return { w, parent };
}
function timers() {
  let id = 0; const q = new Map();
  return { setTimeout: (fn, ms) => { q.set(++id, { fn, ms }); return id; }, clearTimeout: (i) => q.delete(i), fire(ms) { for (const [i, t] of [...q]) if (t.ms <= ms) { q.delete(i); t.fn(); } }, pending: () => q.size };
}

(async () => {
  // ---------- 1. jembatan ----------
  {
    assert.strictEqual(LC.nativeBridge(null), null);
    const self = { addEventListener() {} }; self.parent = self;
    assert.strictEqual(LC.nativeBridge(self), null, 'tidak tertanam di iframe (Electron/peramban): tanpa jembatan');
    assert.strictEqual(LC.nativeBridge({ parent: {} }), null, 'tanpa addEventListener: tanpa jembatan');
    assert.strictEqual(LC.makeNative(null), null);

    const { w, parent } = fakeWin(), T = timers();
    const b = LC.nativeBridge(w, T);
    assert(b && b.audio === false);
    b.hello();
    assert.deepStrictEqual(parent.posted.pop()[0], { archne: 'native', action: 'hello', id: 0 });

    { // aplikasi ke latar belakang / kembali (cangkang meneruskan pause/resume Capacitor)
      const seen = [];
      assert.strictEqual(b.onApp, null);
      w.send({ archne: 'native-app', state: 'background' }); // belum ada pendengar: tidak error
      b.onApp = (hidden) => seen.push(hidden);
      w.send({ archne: 'native-app', state: 'background' }); w.send({ archne: 'native-app', state: 'foreground' });
      w.send({ archne: 'native-app', state: 'aneh' }); w.send({ archne: 'native-app' });
      w.send({ archne: 'native-app', state: 'background' }, {}); // bukan dari induk: diabaikan
      assert.deepStrictEqual(seen, [true, false]);
      b.onApp = () => { throw new Error('boom'); };
      w.send({ archne: 'native-app', state: 'background' }); // pendengar yang error tidak merusak jembatan
      b.onApp = null;
    }
    { // Picture-in-Picture: siaga hanya dikirim saat berubah; kejadian pip dari induk memperbarui pipOn dan memanggil onPip
      parent.posted.length = 0;
      b.pip(true); b.pip(true);
      assert.strictEqual(parent.posted.length, 1, 'siaga dikirim sekali');
      assert.deepStrictEqual(parent.posted[0][0], { archne: 'native', action: 'pip', id: 0, on: true });
      b.pip(false); assert.strictEqual(parent.posted.pop()[0].on, false);
      parent.posted.length = 0;
      const seen = [];
      b.onPip = (on) => seen.push(on);
      w.send({ archne: 'native-app', state: 'pip', on: true }); assert.strictEqual(b.pipOn, true);
      w.send({ archne: 'native-app', state: 'pip', on: false }); assert.strictEqual(b.pipOn, false);
      w.send({ archne: 'native-app', state: 'pip', on: true }, {}); // bukan dari induk: diabaikan
      assert.deepStrictEqual(seen, [true, false]);
      b.onPip = () => { throw new Error('boom'); };
      w.send({ archne: 'native-app', state: 'pip', on: true }); // pendengar yang error tidak merusak jembatan
      b.onPip = null; b.pipOn = false;
    }
    const p1 = b.ask('call-begin');
    const m1 = parent.posted.pop()[0];
    assert.strictEqual(m1.archne, 'native'); assert.strictEqual(m1.action, 'call-begin'); assert.strictEqual(m1.on, false); assert(Number.isInteger(m1.id) && m1.id > 0);
    w.send({ archne: 'native-reply', id: m1.id + 99, ok: true, res: 'x' });          // id lain
    w.send({ archne: 'native-reply', id: m1.id, ok: true, res: 'ok' }, { evil: 1 });   // bukan dari induk
    let settled = false; p1.then(() => { settled = true; }); await flush();
    assert.strictEqual(settled, false, 'balasan dari id/sumber lain diabaikan');
    w.send({ archne: 'native-reply', id: m1.id, ok: true, res: 'ok' });
    assert.deepStrictEqual(await p1, { ok: true, res: 'ok' });
    assert.strictEqual(T.pending(), 0, 'pewaktu dibersihkan setelah dijawab');

    const p2 = b.ask('speaker', true); const m2 = parent.posted.pop()[0];
    assert.strictEqual(m2.on, true); assert.notStrictEqual(m2.id, m1.id);
    w.send({ archne: 'native-reply', id: m2.id, ok: 'true', res: 5 }); // tipe salah: bukan ok
    assert.deepStrictEqual(await p2, { ok: false, res: '' });

    const p3 = b.ask('mic', undefined, 120000); parent.posted.pop();
    T.fire(4000); await flush();
    assert.strictEqual(T.pending(), 1, 'mic punya batas waktu 120 dtk, bukan 4 dtk');
    T.fire(120000);
    assert.deepStrictEqual(await p3, { ok: false, res: 'timeout' });
    const p4 = b.ask('call-end'); parent.posted.pop(); T.fire(4000);
    assert.deepStrictEqual(await p4, { ok: false, res: 'timeout' });

    w.send({ archne: 'native-caps', audio: true }); assert.strictEqual(b.audio, true);
    w.send({ archne: 'native-caps', audio: 'ya' }, { evil: 1 }); assert.strictEqual(b.audio, true, 'caps dari sumber lain diabaikan');
    w.send({ archne: 'native-caps', audio: 'ya' }); assert.strictEqual(b.audio, false, 'hanya true persis yang berlaku');

    const bad = { parent: { postMessage() { throw new Error('x'); } }, addEventListener() {} };
    assert.deepStrictEqual(await LC.nativeBridge(bad, T).ask('mic'), { ok: false, res: 'send' });
    ok('jembatan: tidak aktif di luar iframe, id/sumber dicek, batas waktu, caps, kegagalan kirim');
  }

  // ---------- 2. getUserMedia lewat jembatan ----------
  {
    const { w, parent } = fakeWin(), T = timers();
    let gum = 0;
    const win = Object.assign(w, { RTCPeerConnection: function () {}, navigator: { mediaDevices: { getUserMedia: async () => { gum++; return { s: 1 }; } } } });
    const b = LC.nativeBridge(win, T);
    const rtc = LC.browserRtc(win, b);
    await rtc.getUserMedia({ audio: true });
    assert.strictEqual(gum, 1); assert.strictEqual(parent.posted.length, 0, 'tanpa caps audio: langsung getUserMedia (peramban biasa)');
    w.send({ archne: 'native-caps', audio: true });
    const answer = async (res) => { const p = rtc.getUserMedia({ audio: true }); await flush(); const m = parent.posted.pop()[0]; assert.strictEqual(m.action, 'mic'); w.send({ archne: 'native-reply', id: m.id, ok: res === 'granted', res }); return p; };
    assert.deepStrictEqual(await answer('granted'), { s: 1 }); assert.strictEqual(gum, 2);
    await assert.rejects(answer('denied'), (e) => /Izinkan/.test(e.userMsg)); assert.strictEqual(gum, 2, 'ditolak: getUserMedia tidak dipanggil');
    await assert.rejects(answer('blocked'), (e) => /Pengaturan/.test(e.userMsg) && /Mikrofon/.test(e.userMsg));
    await assert.rejects(answer('noplugin'), (e) => e.userMsg === '', 'tanpa plugin: pesan umum');
    assert.strictEqual(LC.browserRtc(win).PeerConnection, win.RTCPeerConnection, 'Electron: browserRtc(w) tanpa jembatan tetap bekerja');
    ok('izin mikrofon: granted lanjut, denied/blocked/noplugin menolak dengan pesan yang sesuai tanpa menyentuh getUserMedia');
  }

  // ---------- 3. Controller + sesi audio cangkang ----------
  class PC {
    constructor() { this.tracks = []; this.remoteDescription = null; this.localDescription = null; PC.all.push(this); }
    addTrack(t) { this.tracks.push(t); } async createOffer() { return { type: 'offer', sdp: 'O' }; } async createAnswer() { return { type: 'answer', sdp: 'A' }; }
    async setLocalDescription(d) { this.localDescription = d; } async setRemoteDescription(d) { this.remoteDescription = d; } async addIceCandidate() {} close() {}
    state(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
  }
  PC.all = [];
  const CID = 'b2'.repeat(8);
  function mk(o) {
    o = o || {}; PC.all = [];
    const log = [], ui = { ended: [], renders: [] }, streams = [];
    const api = new Proxy({}, { get: (_t, n) => async (...a) => { log.push(n); return n === 'callStart' ? { ok: true, cid: CID } : { ok: true }; } });
    const gate = { p: null };
    const rtc = { PeerConnection: PC, makeStream: () => ({}), playRemote: () => () => {},
      getUserMedia: async () => { if (gate.p) await gate.p; if (o.micErr !== undefined) { const e = new Error('mic'); e.userMsg = o.micErr; throw e; } const t = { stopped: false, enabled: true, stop() { this.stopped = true; } }; const s = { t, getTracks: () => [t], getAudioTracks: () => [t] }; streams.push(s); return s; } };
    const nat = { log: [], begin() { nat.log.push('begin'); return Promise.resolve({ ok: true }); }, end() { nat.log.push('end'); return Promise.resolve({ ok: true }); },
      speaker(on) { nat.log.push('speaker:' + on); return Promise.resolve(o.speakerOk !== false); } };
    const ctl = new LC.Controller({ api, rtc, native: o.noNative ? null : nat, ui: { render: (v) => ui.renders.push(v), ring() {}, ended: (i) => ui.ended.push(i) } });
    return { ctl, nat, ui, gate, streams, log, pc: () => PC.all[PC.all.length - 1], lastView: () => ui.renders[ui.renders.length - 1] };
  }

  { // keluar: begin sesudah mikrofon, end tepat sekali di semua jalur penutupan
    const m = mk(); await m.ctl.start('p1', 'Budi'); await flush();
    assert.deepStrictEqual(m.nat.log, ['begin']);
    m.ctl.hangup(); m.ctl.hangup(); await m.ctl.onEvent({ ev: 'end', cid: CID, reason: 'ended' }); await flush();
    assert.deepStrictEqual(m.nat.log, ['begin', 'end'], 'end sekali walau hangup berulang');
    const r = mk(); await r.ctl.start('p1', 'Budi'); await r.ctl.onEvent({ ev: 'end', cid: CID, reason: 'rejected' }); await flush();
    assert.deepStrictEqual(r.nat.log, ['begin', 'end'], 'ditutup lawan: sesi dilepas');
    const f = mk(); await f.ctl.start('p1', 'Budi'); await f.ctl.onEvent({ ev: 'answer', cid: CID, sdp: 'A' }); f.pc().state('failed'); await flush();
    assert.deepStrictEqual(f.nat.log, ['begin', 'end'], 'gagal tersambung: sesi dilepas');
    ok('panggilan keluar: sesi audio dimulai setelah mikrofon dan dilepas tepat sekali (hangup, ditutup lawan, ICE gagal)');
  }
  { // masuk
    const m = mk(); await m.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'p2', name: 'Sari', sdp: 'OFFER' });
    assert.deepStrictEqual(m.nat.log, [], 'berdering: belum ada sesi (tidak memakai mikrofon)');
    m.ctl.reject(); await flush(); assert.deepStrictEqual(m.nat.log, [], 'ditolak: tidak pernah begin dan tidak end');
    const a = mk(); await a.ctl.onEvent({ ev: 'incoming', cid: CID, peer: 'p2', name: 'Sari', sdp: 'OFFER' });
    await a.ctl.accept(); await flush(); assert.deepStrictEqual(a.nat.log, ['begin']);
    await a.ctl.onEvent({ ev: 'end', cid: CID, reason: 'ended', wasActive: true }); await flush();
    assert.deepStrictEqual(a.nat.log, ['begin', 'end']);
    ok('panggilan masuk: sesi hanya saat diterima; ditolak tidak menyentuh sesi');
  }
  { // izin ditolak / dibatalkan saat dialog izin
    const m = mk({ micErr: 'Izin mikrofon ditolak. Buka Pengaturan > Aplikasi > Archne > Izin, lalu izinkan Mikrofon.' });
    await m.ctl.start('p1', 'Budi'); await flush();
    assert.strictEqual(m.ui.ended.length, 1); assert.strictEqual(m.ui.ended[0].reason, 'mic');
    assert(/Pengaturan/.test(LC.endText(m.ui.ended[0])), 'toast memuat petunjuk dari cangkang');
    assert.deepStrictEqual(m.nat.log, [], 'mikrofon gagal: sesi tidak dimulai');
    const g = mk({ micErr: '' }); await g.ctl.start('p1', 'Budi'); assert(/Izinkan akses mikrofon/.test(LC.endText(g.ui.ended[0])), 'tanpa pesan khusus: teks bawaan');
    const dg = mk({ micErr: '' }); await dg.ctl.start('p1', 'Budi');
    assert(/\[Error: mic\]/.test(LC.endText(dg.ui.ended[0])), 'penyebab tak dikenal ikut disebut di toast');
    { const { w } = fakeWin(), T2 = timers(), b2 = LC.nativeBridge(w, T2); w.send({ archne: 'native-caps', audio: true });
      const win2 = Object.assign(w, { RTCPeerConnection: function () {}, navigator: { mediaDevices: { getUserMedia: async () => ({}) } } });
      const p2 = LC.browserRtc(win2, b2).getUserMedia({}); await flush(); T2.fire(120000);
      await assert.rejects(p2, (e) => e.userMsg === '' && e.detail === 'plugin: timeout', 'plugin tidak menjawab: detail menyebut timeout'); }
    const c = mk(); let rel; c.gate.p = new Promise((r) => { rel = r; });
    const p = c.ctl.start('p1', 'Budi'); await flush(); c.ctl.hangup(); rel(); await p; await flush();
    assert.deepStrictEqual(c.nat.log, [], 'dibatalkan saat dialog izin terbuka: tanpa sesi');
    assert(c.streams.every((s) => s.t.stopped), 'dan mikrofon yang terlanjur didapat dilepas');
    ok('izin ditolak: pesan cangkang sampai ke toast; batal saat dialog izin tidak meninggalkan sesi/mikrofon');
  }
  { // speaker
    const m = mk(); await m.ctl.start('p1', 'Budi'); await flush();
    assert.strictEqual(m.lastView().speaker, false, 'awal: earpiece');
    assert.strictEqual(m.ctl.speaker(), true); await flush();
    assert.strictEqual(m.lastView().speaker, true); assert.deepStrictEqual(m.nat.log, ['begin', 'speaker:true']);
    assert.strictEqual(m.ctl.speaker(), false); await flush();
    assert.strictEqual(m.lastView().speaker, false); assert.deepStrictEqual(m.nat.log, ['begin', 'speaker:true', 'speaker:false']);
    const bad = mk({ speakerOk: false }); await bad.ctl.start('p1', 'Budi'); await flush();
    bad.ctl.speaker(true); assert.strictEqual(bad.lastView().speaker, true, 'optimistis dulu'); await flush();
    assert.strictEqual(bad.lastView().speaker, false, 'cangkang gagal memindah rute: tombol kembali');
    const none = mk({ noNative: true }); await none.ctl.start('p1', 'Budi');
    assert.strictEqual(none.ctl.speaker(), false, 'tanpa cangkang: tidak ada speaker'); assert.strictEqual(none.lastView().speaker, false);
    const idle = mk(); assert.strictEqual(idle.ctl.speaker(), false, 'tanpa panggilan: tidak berbuat apa-apa');
    ok('speaker: bolak-balik lewat cangkang, kembali bila gagal, mati tanpa cangkang/panggilan');
  }
  { // tombol di layar
    const h = { esc: (s) => s, avatar: () => '', icons: { phone: 'P', mic: 'M', micOff: 'X', speaker: 'SPK' } };
    const base = { cid: 'c', peer: 'p', name: 'Budi', dir: 'out', phase: 'active', muted: false, speaker: false, since: Date.now(), canAccept: false };
    assert(!/data-cact="speaker"/.test(LC.overlayHtml(base, Object.assign({ speaker: false }, h))), 'tanpa cangkang: tombol tersembunyi');
    assert(/data-cact="speaker"/.test(LC.overlayHtml(base, Object.assign({ speaker: true }, h))) && /SPK/.test(LC.overlayHtml(base, Object.assign({ speaker: true }, h))));
    assert(/cbtn tog on" data-cact="speaker"/.test(LC.overlayHtml(Object.assign({}, base, { speaker: true }), Object.assign({ speaker: true }, h))), 'menyala mengikuti state panggilan');
    assert(!/data-cact="speaker"/.test(LC.overlayHtml(Object.assign({}, base, { phase: 'ringing', dir: 'in', canAccept: true }), Object.assign({ speaker: true }, h))), 'berdering: belum ada speaker');
    ok('layar panggilan: tombol speaker hanya dengan cangkang dan setelah berdering');
  }

  // ---------- 4. halaman pembungkus Capacitor dijalankan di vm ----------
  {
    const { env } = require('./_mobilewrap');
    const ORIGIN = 'http://127.0.0.1:4321';
    const lastReply = (e) => { const r = e.sent().filter((x) => x[0].archne === 'native-reply'); return r.length ? r[r.length - 1] : null; };
    const val = (v) => () => ({ value: v });

    // hello + caps
    let e = await env(val('ok'));
    e.frame.onload();
    assert.deepStrictEqual(e.sent()[0], [{ archne: 'native-caps', audio: true, pick: false }, ORIGIN], 'iframe selesai dimuat: kabari bahwa audio tersedia (pick hanya bila inti memberi folder dxout), hanya ke origin iframe');
    await e.post({ archne: 'native', action: 'hello', id: 0 });
    assert.strictEqual(e.sent().filter((x) => x[0].archne === 'native-caps').length, 2);

    // mic: granted / denied / blocked / error
    for (const [res, wantOk] of [['granted', true], ['denied', false], ['blocked', false]]) {
      e = await env(val(res));
      await e.post({ archne: 'native', action: 'mic', id: 11 });
      const last = e.calls[e.calls.length - 1];
      assert.deepStrictEqual([last.plug, last.act, last.args], ['ArchneAudio', 'mic', {}]);
      assert.deepStrictEqual(lastReply(e), [{ archne: 'native-reply', id: 11, ok: wantOk, res }, ORIGIN]);
    }
    e = await env(() => { throw 'boom'; });
    await e.post({ archne: 'native', action: 'mic', id: 12 });
    assert.deepStrictEqual(lastReply(e)[0], { archne: 'native-reply', id: 12, ok: false, res: 'boom' });
    e = await env(val('ok'), {}, { noplugins: true });
    await e.post({ archne: 'native', action: 'call-begin', id: 13 });
    assert.deepStrictEqual(lastReply(e)[0], { archne: 'native-reply', id: 13, ok: false, res: 'noplugin' }, 'plugin tidak ada: dijawab gagal, bukan menggantung');

    // begin / end / speaker diteruskan dengan argumen yang benar
    e = await env(val('ok'));
    await e.post({ archne: 'native', action: 'call-begin', id: 1 });
    await e.post({ archne: 'native', action: 'call-end', id: 2 });
    await e.post({ archne: 'native', action: 'speaker', id: 3, on: true });
    await e.post({ archne: 'native', action: 'speaker', id: 4, on: 'ya' });
    assert.deepStrictEqual(e.plug('ArchneAudio').map((x) => x.act + JSON.stringify(x.args)), ['begin{}', 'end{}', 'speaker{"on":true}', 'speaker{"on":false}']);
    assert(e.sent().filter((x) => x[0].archne === 'native-reply').every((x) => x[0].ok === true));

    // penjagaan
    e = await env(val('ok'));
    const n0 = e.calls.length;
    await e.post({ archne: 'native', action: 'mic', id: 5 }, { origin: 'http://evil.example' });
    await e.post({ archne: 'native', action: 'mic', id: 5 }, { source: { postMessage() {} } });
    await e.post({ archne: 'native', action: 'mic', id: 'x' });
    await e.post({ archne: 'native', action: 'mic' });
    await e.post({ archne: 'native', action: 'constructor', id: 6 });
    await e.post({ archne: 'native', action: 'hasOwnProperty', id: 7 });
    await e.post({ archne: 'native', action: 'camera', id: 8 });
    assert.strictEqual(e.calls.length, n0, 'origin/sumber salah, id bukan angka, dan aksi di luar daftar tidak menyentuh plugin');
    await e.post({ archne: 'native', action: 'battery' });
    assert.strictEqual(e.calls[e.calls.length - 1].act, 'batteryAsk', 'aksi lama (baterai) tetap jalan');

    // Kirim Langsung dari HP: pemilih berpath (ArchneDownloads access / askAccess / pick)
    const DX = '/data/user/0/com.xyraori.archne/files/archne/data/dxout', dl = (e) => e.plug('ArchneDownloads'), lastPick = (e) => { const r = e.sent().filter((x) => x[0].archne === 'native-pick'); return r.length ? r[r.length - 1] : null; };
    e = await env(val('ok'), { dxout: DX }); e.frame.onload();
    assert.deepStrictEqual(e.sent()[0][0], { archne: 'native-caps', audio: true, pick: true }, 'caps: pemilih berpath tersedia setelah inti memberi folder dxout');
    e = await env((p, act) => (act === 'access' ? { value: 'ok' } : act === 'pick' ? { paths: ['/storage/emulated/0/DCIM/a.jpg', 7, '/storage/1234-ABCD/b.mkv'] } : {}), { dxout: DX });
    await e.post({ archne: 'native', action: 'dxpick', id: 21, job: 'xj1' });
    assert.deepStrictEqual(dl(e).map((x) => [x.act, x.args]), [['access', {}], ['pick', { root: DX, job: 'xj1' }]], 'izin ada: langsung memilih, folder dxout dari inti (bukan dari UI)');
    assert.deepStrictEqual(lastPick(e), [{ ok: true, paths: ['/storage/emulated/0/DCIM/a.jpg', '/storage/1234-ABCD/b.mkv'], archne: 'native-pick', id: 21 }, ORIGIN], 'hanya string yang diteruskan');
    e = await env((p, act) => (act === 'access' ? { value: 'no' } : { value: 'asked' }), { dxout: DX });
    await e.post({ archne: 'native', action: 'dxpick', id: 22, job: 'xj2' });
    assert.deepStrictEqual(dl(e).map((x) => x.act), ['access', 'askAccess'], 'izin belum ada: buka pengaturan, belum memilih');
    assert.strictEqual(lastPick(e)[0].code, 'perm');
    await e.post({ archne: 'native', action: 'dxpick', id: 23, job: 'xj2', skip: true });
    assert.strictEqual(dl(e)[dl(e).length - 1].act, 'pick', 'sudah pernah diminta (skip): lanjut memilih, berkas tak terbaca disalin cangkang');
    e = await env((p, act) => { if (act === 'access') return { value: 'ok' }; throw 'cancel'; }, { dxout: DX });
    await e.post({ archne: 'native', action: 'dxpick', id: 24, job: 'xj3' });
    assert.strictEqual(lastPick(e)[0].code, 'cancel');
    e = await env((p, act) => { if (act === 'access') return { value: 'ok' }; throw 'e:storageFull'; }, { dxout: DX });
    await e.post({ archne: 'native', action: 'dxpick', id: 25, job: 'xj4' });
    assert.deepStrictEqual([lastPick(e)[0].code, lastPick(e)[0].err], ['err', 'Phone storage is full']);
    e = await env(val('ok'), { dxout: DX }); const n1 = dl(e).length;
    for (const job of ['../x', 'a/b', '', 5, 'a'.repeat(41)]) await e.post({ archne: 'native', action: 'dxpick', id: 30, job });
    assert.strictEqual(dl(e).length, n1, 'job tak sah tidak menyentuh plugin'); assert(e.sent().filter((x) => x[0].archne === 'native-pick').every((x) => x[0].code === 'err'));
    await e.post({ archne: 'native', action: 'dxpick', id: 31, job: 'ok1' }, { origin: 'http://evil.example' });
    assert.strictEqual(dl(e).length, n1, 'origin asing diabaikan');
    e = await env(val('ok')); await e.post({ archne: 'native', action: 'dxpick', id: 32, job: 'ok1' });
    assert.strictEqual(lastPick(e)[0].code, 'err'); assert.strictEqual(dl(e).length, 0, 'tanpa folder dxout dari inti: ditolak');
    ok('Kirim Langsung dari HP: izin dicek, pengaturan dibuka sekali lalu lanjut, batal/galat dijawab, job dan origin dijaga, folder dxout hanya dari inti');
    ok('halaman pembungkus: caps, mic granted/denied/blocked/error, begin/end/speaker, tanpa plugin, penjagaan origin/sumber/id/aksi');
  }

  // ---------- 5. kontrak berkas ----------
  {
    const html = read('mobile', 'shell', 'index.html');
    const iframe = html.match(/<iframe[^>]*>/)[0];
    const allow = (iframe.match(/allow="([^"]*)"/) || [])[1] || '';
    const feats = allow.split(';').map((x) => x.trim()).filter(Boolean).sort();
    assert.deepStrictEqual(feats, ['autoplay', 'camera', 'clipboard-write', 'microphone'], 'iframe hanya mendelegasikan mikrofon, kamera (panggilan video), autoplay, clipboard (bukan lokasi)');
    const csp = html.match(/Content-Security-Policy" content="([^"]*)"/)[1];
    assert(/frame-src http:\/\/127\.0\.0\.1:\*(;|$)/.test(csp) && /default-src 'self' data:/.test(csp), 'CSP pembungkus tidak dilonggarkan');
    assert(!/media-src|\*\s*;/.test(csp.replace(/127\.0\.0\.1:\*/g, '')), 'tanpa media-src/wildcard baru');
    assert(/ArchneAudio/.test(html) && !/getUserMedia/.test(html), 'induk hanya meneruskan ke plugin; getUserMedia tetap di UI');

    const JD = ['mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'xyraori', 'archne'];
    const mf = read('mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const java = read(...JD, 'ArchneAudio.java');
    assert(/^package com\.xyraori\.archne;/m.test(java) && /public class ArchneAudio extends Plugin/.test(java));
    const perms = [...mf.matchAll(/uses-permission android:name="android\.permission\.(RECORD_AUDIO|CAMERA|MODIFY_AUDIO_SETTINGS)"/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(perms, ['CAMERA', 'MODIFY_AUDIO_SETTINGS', 'RECORD_AUDIO'], 'mikrofon + kamera (panggilan video)');
    assert(/uses-feature android:name="android\.hardware\.camera" android:required="false"/.test(mf), 'kamera opsional: perangkat tanpa kamera tetap bisa memasang');
    const shellActs = [...html.matchAll(/AUDIO_ACT = \{([^}]*)\}/g)][0][1].match(/'?[\w-]+'?\s*:\s*'(\w+)'/g).map((x) => x.match(/:\s*'(\w+)'/)[1]).filter((a) => a !== 'hello').sort();
    const javaActs = [...java.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(shellActs, javaActs, 'nama aksi di halaman pembungkus = nama @PluginMethod di Java');
    assert.deepStrictEqual(javaActs, ['begin', 'cam', 'end', 'mic', 'speaker']);
    assert(/@PermissionCallback/.test(java) && /"blocked"/.test(java) && /"denied"/.test(java) && /"granted"/.test(java));
    assert(/MODE_IN_COMMUNICATION/.test(java) && /setMode\(prevMode\)/.test(java) && /protected void handleOnDestroy\(\) \{ end\(\); \}/.test(java), 'mode panggilan selalu dikembalikan (end, handleOnDestroy)');
    assert(/Build\.VERSION\.SDK_INT >= 31/.test(java) && /setCommunicationDevice/.test(java) && /setSpeakerphoneOn/.test(java), 'rute speaker: API 31+ dan di bawahnya');

    assert(/FOREGROUND_SERVICE_MICROPHONE/.test(mf) && /foregroundServiceType="dataSync\|microphone"/.test(mf));
    const svc = read(...JD, 'ArchneService.java');
    assert(/"call"\.equals\(ev\)/.test(svc) && /CATEGORY_CALL/.test(svc) && /FOREGROUND_SERVICE_TYPE_MICROPHONE/.test(svc) && /FLAG_INSISTENT/.test(svc));
    assert(/clearCall\(/.test(read(...JD, 'ArchneBackground.java')), 'notifikasi panggilan dihapus saat aplikasi dibuka');
    assert(/if \(visible\) return;\s*\n\s*ringCid = cid;/.test(svc), 'tidak ada notifikasi panggilan saat UI tampil');

    // Konstanta Android yang pernah salah ketik (tertangkap build sungguhan, bukan di sini): semua konstanta AudioAttributes harus dari daftar yang dikenal.
    const known = new Set(['USAGE_VOICE_COMMUNICATION', 'USAGE_NOTIFICATION_RINGTONE', 'CONTENT_TYPE_SPEECH', 'CONTENT_TYPE_SONIFICATION']);
    for (const code of [java, svc]) for (const m of code.matchAll(/AudioAttributes\.((?:USAGE|CONTENT_TYPE)_\w+)/g)) assert(known.has(m[1]), 'konstanta AudioAttributes tidak dikenal: ' + m[1]);
    assert(!/CONTENT_TYPE_SONIC\b/.test(svc));

    // kurung Java seimbang (tanpa JDK di sini, ini pengaman minimum terhadap salah ketik)
    for (const [name, code] of [['ArchneAudio', java], ['ArchneService', svc], ['ArchneBackground', read(...JD, 'ArchneBackground.java')]]) {
      const bare = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'/g, ''); // satu lintasan: komentar dan string dikenali menurut mana yang mulai lebih dulu (mis. "http://" bukan komentar)
      for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.strictEqual(bare.split(o).length, bare.split(c).length, name + ': ' + o + c + ' tidak seimbang');
    }

    const ui = require('./_src').htmlSrc();
    assert(/LC\.nativeBridge\(window\)/.test(ui) && /LC\.browserRtc\(window, nbridge\)/.test(ui) && /native: LC\.makeNative\(nbridge\)/.test(ui) && /callCtl\.speaker\(\)/.test(ui));
    assert(/<script src="archne-call\.js">/.test(ui) || /archne-call\.js/.test(ui));
    { // Picture-in-Picture (Android): manifest, Activity, plugin, dan pembungkus saling cocok; layanan latar tetap tanpa tipe camera
      const act = read(...JD, 'MainActivity.java'), bg = read(...JD, 'ArchneBackground.java');
      assert(/<activity[^>]*android:supportsPictureInPicture="true"/.test(mf), 'activity mendukung PiP');
      assert(/configChanges="[^"]*screenSize[^"]*"/.test(mf) && /smallestScreenSize/.test(mf) && /screenLayout/.test(mf), 'configChanges PiP: activity tidak dibuat ulang saat jendela mengecil');
      assert(/onUserLeaveHint\(\)/.test(act) && /enterPictureInPictureMode\(/.test(act) && /ArchneBackground\.pipWanted/.test(act), 'Home masuk PiP hanya bila siaga');
      assert(/onPictureInPictureModeChanged\(/.test(act) && /ArchneBackground\.pipChanged\(/.test(act), 'perubahan mode PiP diteruskan');
      assert(/setAutoEnterEnabled\(auto\)/.test(act) && /SDK_INT >= 26/.test(act), 'API 26+ untuk PiP, auto-enter API 31+');
      assert(/@PluginMethod\s+public void pip\(PluginCall/.test(bg) && /@PluginMethod\s+public void pipState\(PluginCall/.test(bg) && /notifyListeners\("pip"/.test(bg), 'plugin: pip, pipState, kejadian pip');
      assert(/d\.action === 'pip'/.test(html) && /addListener\('pip'/.test(html) && /addEventListener\('archnepip'/.test(html), 'pembungkus: aksi pip, kejadian plugin, dan kejadian window');
      assert(/triggerWindowJSEvent\("archnepip"/.test(act), 'MainActivity: jalur kedua lewat kejadian window');
      assert(/nbridge\.onPip/.test(ui) && /archne-pip/.test(ui) && /nbridge\.pip\(/.test(ui), 'UI memasang onPip, kelas archne-pip, dan siaga');
      assert(/body\.archne-pip #callov>\*:not\(\.cvg\)\{display:none!important\}/.test(read('renderer', 'css', 'archne-app.css')), 'CSS: kontrol disembunyikan di jendela PiP (kartu tunggal dites di callpip.js)');
    }
    { // langkah 5: pembungkus meneruskan pause/resume, UI memasangnya ke Controller; layanan latar tetap tanpa tipe kamera
      assert(/function tellApp\(state\) \{ tell\(\{ archne: 'native-app', state: state \}\); \}/.test(html), 'pembungkus mengirim native-app ke origin UI (lewat tell)');
      assert(/addListener\('pause', function \(\) \{\s*paused = true;/.test(html) && /pipState'\)\.then\(function \(r\) \{ if \(!\(r && r\.on === true\)\) tellApp\('background'\)/.test(html) && /tellApp\('foreground'\)/.test(html), 'pause: background hanya bila PiP tidak aktif');
      assert(/if \(nbridge\) \{\s*nbridge\.onApp = \(hidden\) => callCtl\.appHidden\(hidden\);/.test(ui) && /visibilitychange', \(\) => \{ if \(pipShown\) return; callCtl\.appHidden\(document\.visibilityState === 'hidden'\);/.test(ui), 'UI: jembatan + visibilitas -> appHidden');
      assert(!/foregroundServiceType="[^"]*camera/.test(mf), 'layanan latar tanpa tipe camera (berisiko crash tanpa izin; kamera channel dimatikan di latar belakang)');
    }
    ok('kontrak: iframe allow, CSP utuh, nama aksi UI=pembungkus=Java, izin, mode panggilan dilepas, tipe layanan mikrofon, notifikasi panggilan, kurung Java seimbang');
  }

  console.log('\n' + pass + ' tes panggilan Android OK');
})().catch((e) => { console.error(e); process.exit(1); });
