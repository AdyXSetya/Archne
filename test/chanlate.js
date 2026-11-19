'use strict';
// Tes bug "peserta baru tidak melihat kamera yang sudah hidup" (v0.21.0).
// Penyebab: kabar kamera (st.v) dari yang sudah menyala bisa tiba saat kaki di sisi pendatang masih 'connecting' (UI-nya belum memanggil callConnected);
// dulu kabar itu dibuang, sehingga kartu kamera tidak pernah muncul. Sekarang kabar terakhir ditahan dan dipakai begitu kaki aktif.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-late-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, callRingMs: 1500, callConnMs: 4000 });
const rec = (c) => { const ev = []; c.on('call', (e) => ev.push(e)); return ev; };
const ps = (ev) => ev.filter((e) => e.ev === 'peerstate');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  const [A, B] = ['A', 'B'].map(mk);
  for (const n of [A, B]) await n.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'saling melihat');
  // A (kamera sudah hidup) langsung aktif; B (pendatang) baru memanggil callConnected 600 ms kemudian: kabar kamera dari A tiba lebih dulu
  A.on('call', (e) => { if (e.ev === 'answer') A.callConnected(e.cid); });
  B.on('call', (e) => { if (e.ev === 'incoming' && !e.auto) { B.callAnswer(e.cid, 'ANS'); setTimeout(() => B.callConnected(e.cid), 600); } });
  const eb = rec(B);
  const room = A.callStart(B.id, 'S1');
  A.callMedia(room, false, false, true);
  await until(() => A.getState().call.state === 'active', 5000, 'A aktif');
  await sleep(300);
  const lb = [...B._calls.values()][0];
  assert.strictEqual(lb.state, 'connecting', 'B masih connecting saat kabar A tiba (syarat balapan)');
  await until(() => B.getState().call.state === 'active', 5000, 'B aktif');
  await until(() => ps(eb).some((e) => e.cam === true), 3000, 'B menerima kabar kamera A');
  assert.strictEqual(B.getState().call.cam, true, 'callInfo B: kamera A hidup');
  ok('kabar kamera yang tiba sebelum kaki aktif ditahan lalu dipakai saat aktif');

  // kabar terbaru yang menang: tiba saat connecting hidup lalu mati -> hasil akhirnya mati
  const [C, D] = ['C', 'D'].map(mk);
  for (const n of [C, D]) await n.start();
  await C.addPeer('127.0.0.1', D.port);
  await until(() => C.getState().peers.some((p) => p.online) && D.getState().peers.some((p) => p.online), 8000, 'C-D saling melihat');
  C.on('call', (e) => { if (e.ev === 'answer') C.callConnected(e.cid); });
  D.on('call', (e) => { if (e.ev === 'incoming' && !e.auto) { D.callAnswer(e.cid, 'ANS'); setTimeout(() => D.callConnected(e.cid), 700); } });
  const ed = rec(D);
  const r2 = C.callStart(D.id, 'S1');
  C.callMedia(r2, false, false, true);
  await until(() => C.getState().call.state === 'active', 5000, 'C aktif');
  C.callMedia(r2, false, false, false);
  await until(() => D.getState().call.state === 'active', 5000, 'D aktif');
  await sleep(300);
  assert.strictEqual(D.getState().call.cam, false, 'kabar terbaru (mati) yang berlaku');
  ok('kabar yang ditahan: yang terbaru menang');

  // kabar tanpa v (mute saja) yang menyusul tidak menghapus kabar kamera yang sudah ditahan
  const [G, H] = ['G', 'H'].map(mk);
  for (const n of [G, H]) await n.start();
  await G.addPeer('127.0.0.1', H.port);
  await until(() => G.getState().peers.some((p) => p.online) && H.getState().peers.some((p) => p.online), 8000, 'G-H saling melihat');
  G.on('call', (e) => { if (e.ev === 'answer') G.callConnected(e.cid); });
  H.on('call', (e) => { if (e.ev === 'incoming' && !e.auto) { H.callAnswer(e.cid, 'ANS'); setTimeout(() => H.callConnected(e.cid), 700); } });
  const r4 = G.callStart(H.id, 'S1');
  G.callMedia(r4, false, false, true);
  await until(() => G.getState().call.state === 'active', 5000, 'G aktif');
  G.callMedia(r4, true, false); // mute saja, tanpa kabar kamera
  await until(() => H.getState().call.state === 'active', 5000, 'H aktif');
  await sleep(300);
  assert.strictEqual(H.getState().call.cam, true, 'kamera tetap hidup walau kabar terakhir hanya mute');
  ok('kabar mute yang menyusul tidak menghapus kabar kamera yang ditahan');

  // bentuk aneh tetap ditolak walau ditahan
  const [E, F] = ['E', 'F'].map(mk);
  for (const n of [E, F]) await n.start();
  await E.addPeer('127.0.0.1', F.port);
  await until(() => E.getState().peers.some((p) => p.online) && F.getState().peers.some((p) => p.online), 8000, 'E-F saling melihat');
  E.on('call', (e) => { if (e.ev === 'answer') E.callConnected(e.cid); });
  F.on('call', (e) => { if (e.ev === 'incoming' && !e.auto) { F.callAnswer(e.cid, 'ANS'); setTimeout(() => F.callConnected(e.cid), 500); } });
  const r3 = E.callStart(F.id, 'S1');
  await until(() => E.getState().call.state === 'active', 5000, 'E aktif');
  const le = E._legs(r3)[0];
  E._callQueue(le, { t: 'st', cid: le.cid, m: 0, d: 0, v: 7 });
  await until(() => F.getState().call.state === 'active', 5000, 'F aktif');
  await sleep(300);
  assert.notStrictEqual(F.getState().call.cam, true, 'v=7 tidak dipakai');
  ok('bentuk kabar yang tidak valid tetap ditolak');
  for (const n of [A, B, C, D, E, F, G, H]) try { await n.stop(); } catch {}
  console.log('\nchanlate: ' + pass + ' lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
