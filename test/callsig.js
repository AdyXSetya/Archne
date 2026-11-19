'use strict';
// Tes 4c-2a/2b: siaran status mik/deafen lewat jalur sinyal (1-1 dan grup) + status terkini untuk kaki baru.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cs-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, callRingMs: 1500, callConnMs: 2000 });
const rec = (c) => { const ev = []; c.on('call', (e) => ev.push(e)); return ev; };
const ps = (ev) => ev.filter((e) => e.ev === 'peerstate');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  console.log('Archne call-state signal test (4c-2a/2b), dir: ' + tmp);
  const [A, B, C] = ['A', 'B', 'C'].map(mk), all = [A, B, C];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await Promise.all(all.slice(i + 1).map((x) => all[i].addPeer('127.0.0.1', x.port)));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  for (const n of all) n.on('call', (e) => {
    if (e.ev === 'legneed') n.callLeg(e.room, e.peer, 'SDP-' + n.name);
    else if (e.ev === 'incoming' && e.auto) { n.callAnswer(e.cid, 'ANS'); n.callConnected(e.cid); }
    else if (e.ev === 'answer') n.callConnected(e.cid);
  });
  const eb = rec(B), ec = rec(C);

  // ---------- 1-1 ----------
  const room = A.callStart(B.id, 'S1');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(room, 'S2'); B.callConnected(room);
  await until(() => A.getState().call.state === 'active', 5000, 'aktif');

  assert.strictEqual(A.getState().call.muted, undefined, 'belum ada status diterima: callInfo tidak membawa muted/deafened');
  assert.strictEqual(A.callMedia(room, true, false), true);
  await until(() => ps(eb).length === 1, 5000, 'B menerima mute');
  assert.deepStrictEqual([ps(eb)[0].peer, ps(eb)[0].muted, ps(eb)[0].deafened], [A.id, true, false]);
  assert.strictEqual(ps(eb)[0].room, room);
  assert.deepStrictEqual([B.getState().call.muted, B.getState().call.deafened], [true, false]);
  ok('1-1: mute A sampai ke B (event peerstate + callInfo)');

  A.callMedia(room, false, true);
  await until(() => ps(eb).length === 2, 5000, 'B menerima deafen');
  assert.deepStrictEqual([ps(eb)[1].muted, ps(eb)[1].deafened], [true, true], 'deafen selalu berarti mik mati');
  A.callMedia(room, false, false);
  await until(() => ps(eb).length === 3, 5000, 'B menerima pulih');
  assert.deepStrictEqual([ps(eb)[2].muted, ps(eb)[2].deafened], [false, false]);
  assert.deepStrictEqual([B.getState().call.muted, B.getState().call.deafened], [false, false]);
  ok('deafen menyiarkan muted+deafened; dilepas menyiarkan keduanya mati');

  B.callMedia(room, true, false);
  await until(() => A._calls.get(room).pst && A._calls.get(room).pst.muted === true, 5000, 'A menerima mute B');
  ok('dua arah: B juga bisa menyiarkan ke A');
  B.callMedia(room, false, false);
  await until(() => A._calls.get(room).pst.muted === false, 5000, 'A menerima pulih');

  // pesan cacat / bukan dari lawan bicara: diabaikan
  const n0 = ps(eb).length;
  for (const bad of [{ m: 2, d: 0 }, { m: '1', d: 0 }, { m: 1 }, { d: 1 }, { m: true, d: false }, { m: -1, d: 0 }, { m: 0, d: 5 }])
    await A._callSend(B.id, Object.assign({ t: 'st', cid: room }, bad));
  await A._callSend(B.id, { t: 'st', cid: 'f'.repeat(16), m: 1, d: 1 });
  await A._callSend(B.id, { t: 'st', cid: 'bukan-cid', m: 1, d: 1 });
  await sleep(300);
  assert.strictEqual(ps(eb).length, n0, 'pesan cacat dan cid asing tidak mengubah apa pun');
  await A._callSend(C.id, { t: 'st', cid: room, m: 1, d: 1 }); // C bukan lawan bicara panggilan ini
  await sleep(200);
  assert.strictEqual(ps(ec).length, 0, 'orang di luar panggilan tidak bisa memasang status');
  ok('pesan cacat, cid asing, dan pengirim bukan lawan bicara diabaikan');

  const cb = B._calls.get(room); cb.stn = 199; // batas 200 pesan per kaki
  A.callMedia(room, true, false); await until(() => ps(eb).length === n0 + 1, 5000, 'pesan ke-200 diterima');
  A.callMedia(room, false, false); await sleep(300);
  assert.strictEqual(ps(eb).length, n0 + 1, 'pesan di atas batas dibuang');
  ok('banjir status dibatasi per kaki');

  assert.strictEqual(A.callMedia('a'.repeat(16), true, false), false, 'ruang tak dikenal: ditolak tanpa galat');
  assert.strictEqual(A._callMy.size, 1, 'dan tidak ada yang tersimpan untuknya (hanya ruang 1-1 yang masih berjalan)');
  A.callEnd(room);
  await until(() => !A.getState().call && !B.getState().call, 5000, 'selesai');
  assert.strictEqual(A._callMy.size, 0, 'status milikku dibuang saat ruang bubar');
  ok('ruang bubar membersihkan status; ruang tak dikenal ditolak dan tidak menyimpan apa pun');

  // ---------- grup (3 orang) ----------
  const full = (n, k, rm) => n._calls.size === k - 1 && [...n._calls.values()].every((l) => l.state === 'active' && l.room === rm);
  const g = A.callStart(B.id, 'S1');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(g, 'S2'); B.callConnected(g);
  await until(() => A.getState().call.state === 'active', 5000, 'aktif');
  A.callInvite(g, C.id);
  await until(() => ec.some((e) => e.ev === 'invited'), 5000, 'C diundang');
  C.callInviteAccept(g);
  await until(() => all.every((n) => full(n, 3, g) && !n._joins.size), 8000, 'mesh 3');
  const b0 = ps(eb).length, c0 = ps(ec).length;
  A.callMedia(g, false, true);
  await until(() => ps(eb).length === b0 + 1 && ps(ec).length === c0 + 1, 5000, 'B dan C menerima');
  for (const e of [ps(eb)[b0], ps(ec)[c0]]) assert.deepStrictEqual([e.peer, e.room, e.muted, e.deafened], [A.id, g, true, true]);
  for (const n of [B, C]) {
    const leg = n.getState().call.legs.find((l) => l.peer === A.id);
    assert.deepStrictEqual([leg.muted, leg.deafened], [true, true], 'callInfo: status tercatat pada kaki A');
    const other = n.getState().call.legs.find((l) => l.peer !== A.id);
    assert.strictEqual(other.muted, undefined, 'kaki lain tidak ikut berubah');
  }
  ok('grup: satu siaran A sampai ke B dan C; status per peserta, tidak tertukar');

  C.callMedia(g, true, false);
  await until(() => ps(eb).some((e) => e.peer === C.id), 5000, 'B menerima mute C');
  const bl = B.getState().call.legs;
  assert.deepStrictEqual([bl.find((l) => l.peer === C.id).muted, bl.find((l) => l.peer === A.id).deafened], [true, true]);
  ok('grup: status A dan C tersimpan terpisah di B');

  for (const n of all) for (const l of [...n._calls.values()]) n.callEnd(l.cid);
  await until(() => all.every((n) => !n.getState().call), 5000, 'bubar');
  // ---------- 4c-2b: status terkini untuk kaki baru ----------
  const ea = rec(A);
  const r = A.callStart(B.id, 'S1');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  const b1 = ps(eb).length;
  assert.strictEqual(A.callMedia(r, true, false), true, 'masih memanggil: status disimpan');
  assert.strictEqual(ps(eb).length, b1, 'belum aktif: belum ada yang dikirim');
  B.callAnswer(r, 'S2'); B.callConnected(r);
  await until(() => ps(eb).length === b1 + 1, 5000, 'B menerima status yang diatur sebelum aktif');
  assert.deepStrictEqual([ps(eb)[b1].peer, ps(eb)[b1].muted, ps(eb)[b1].deafened], [A.id, true, false]);
  ok('status yang diatur sebelum kaki aktif dikirim begitu kaki aktif');

  await until(() => A.getState().call.state === 'active', 5000, 'A aktif');
  B.callMedia(r, false, true);
  await until(() => A._calls.get(r).pst && A._calls.get(r).pst.deafened === true, 5000, 'A tahu B deafen');
  const c1 = ps(ec).length;
  A.callInvite(r, C.id);
  await until(() => ec.some((e) => e.ev === 'invited' && e.room === r), 5000, 'C diundang');
  C.callInviteAccept(r);
  await until(() => all.every((n) => full(n, 3, r) && !n._joins.size), 8000, 'mesh 3');
  await until(() => ps(ec).slice(c1).length >= 2, 5000, 'C menerima status A dan B');
  const got = {}; for (const e of ps(ec).slice(c1)) got[e.peer] = [e.muted, e.deafened];
  assert.deepStrictEqual(got[A.id], [true, false], 'C melihat A: mute');
  assert.deepStrictEqual(got[B.id], [true, true], 'C melihat B: deafen (mik ikut mati)');
  const cl = C.getState().call.legs;
  assert.deepStrictEqual([cl.find((l) => l.peer === A.id).muted, cl.find((l) => l.peer === B.id).deafened], [true, true]);
  ok('anggota baru C langsung menerima status terkini A dan B (callInfo ikut terisi)');

  await sleep(300);
  assert.strictEqual(ps(ea).filter((e) => e.peer === C.id).length, 0, 'C berstatus bawaan: tidak mengirim apa-apa');
  assert.strictEqual(ps(ec).slice(c1).length, 2, 'tidak ada pesan ganda');
  ok('peserta berstatus bawaan tidak mengirim status; tidak ada duplikat');

  for (const n of all) for (const l of [...n._calls.values()]) n.callEnd(l.cid);
  await until(() => all.every((n) => !n.getState().call), 5000, 'bubar 2');
  console.log('\n' + pass + ' kelompok asersi OK');
  for (const n of all) await n.stop();
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
