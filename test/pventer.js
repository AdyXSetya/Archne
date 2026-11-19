'use strict';
// Tes masuk/keluar channel voice publik (v0.20.0, pvch4): PIN diperiksa penerima, batas percobaan, keluar otomatis (dihapus/dikunci/PIN diganti),
// audio mesh antar anggota, dan satu panggilan sekaligus. Core asli lewat loopback; UI diganti pemeran palsu yang hanya bertukar SDP rekaan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pve-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, vcBeatMs: 300, vcTtlMs: 1500, vcRetryMs: 150, syncMs: 400 });
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
function actor(c) {
  const a = { kicks: [], ends: [] };
  c.on('pvkick', (e) => a.kicks.push(e));
  c.on('call', (e) => {
    try {
      if (e.ev === 'legneed') c.callLeg(e.room, e.peer, 'OFFER-' + c.name);
      else if (e.ev === 'incoming' && e.auto) { c.callAnswer(e.cid, 'ANSWER-' + c.name); c.callConnected(e.cid); }
      else if (e.ev === 'answer') c.callConnected(e.cid);
      else if (e.ev === 'end') a.ends.push(e);
    } catch (err) { a.err = err; }
  });
  return a;
}
const legs = (c, room) => c._legs(room).map((l) => c.peers.get(l.peer).name + ':' + l.state).sort().join();
const active = (c, room, names) => legs(c, room) === names.map((n) => n + ':active').sort().join();
const names = (c, cid) => c._pvHere(cid).map((x) => x.name).sort().join();

(async () => {
  console.log('Archne pvch enter test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E');
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 4), 8000, 'mesh');
  const ac = { A: actor(A), B: actor(B), C: actor(C), D: actor(D), E: actor(E) };
  const santai = A.pvCreate('Santai', null);
  const rapat = B.pvCreate('Rapat', '123456');
  await until(() => all.every((n) => n.pvList({ empty: true }).length === 2), 8000, 'sync channel');

  // ---- A. channel gratis: masuk, audio mesh antar anggota, callInfo menandai ruang, tidak masuk riwayat panggilan ----
  C.pvEnter(santai); D.pvEnter(santai);
  await until(() => active(C, santai, ['D']) && active(D, santai, ['C']), 8000, 'C-D');
  assert.strictEqual(C.callInfo().pv.cid, santai);
  assert.strictEqual(C._roomMax(santai), 16, 'channel publik sampai 16 orang');
  assert.strictEqual(C._roomMax('0'.repeat(16)), 8, 'ruang lain tetap 8');
  assert.strictEqual(C.getState().calls.length, 0, 'channel tidak masuk riwayat panggilan');
  ok('channel gratis: C dan D tersambung, callInfo menandai channel, batas ruang 16');

  // ---- B. satu panggilan sekaligus ----
  assert.throws(() => C.callStart(E.id, 'SDP'), /Masih ada panggilan/, 'di channel tidak bisa menelepon');
  E.callStart(A.id, 'SDP-E'); // E sedang menelepon A (belum dijawab)
  assert.throws(() => E.pvEnter(santai), /Masih ada panggilan/, 'sedang menelepon tidak bisa masuk channel');
  E.callEnd(E.callInfo().cid);
  ok('selagi di channel tidak bisa menelepon, dan selagi menelepon tidak bisa masuk channel');

  // ---- C. channel terkunci: PIN salah ditolak, benar masuk, pemilik tanpa PIN; penerima memeriksa PIN (tanpa membaca daftar pengirim) ----
  C.pvLeave();
  await until(() => C._legs(santai).length === 0 && D._legs(santai).length === 0, 6000, 'C keluar');
  assert.throws(() => C.pvEnter(rapat, '000000'), /PIN salah/);
  assert.throws(() => C.pvEnter(rapat), /PIN salah/);
  C.pvEnter(rapat, '123456');
  B.pvEnter(rapat); // pemilik tanpa PIN
  await until(() => active(B, rapat, ['C']) && active(C, rapat, ['B']), 8000, 'B-C');
  // E memalsukan masuk: kirim sinyal langsung dengan PIN salah, lalu tanpa PIN. Penerima tidak menghitungnya, dan tidak menyambung audio.
  for (const pin of ['000000', undefined]) await E._callSend(D.id, Object.assign({ t: 'pp', cid: rapat, on: 1 }, pin ? { pin } : {}));
  await sleep(300);
  assert.strictEqual(names(D, rapat), 'B,C', 'D melihat B dan C saja');
  assert(!D._pvHere(rapat).some((x) => x.name === 'E'), 'E tidak lolos');
  assert(!D._pvAllowed(E.id, rapat), 'E tidak sah di channel terkunci');
  ok('PIN salah/kosong ditolak saat masuk; benar dan pemilik masuk; sinyal palsu tanpa PIN benar tidak dihitung hadir');

  // ---- D. batas percobaan: lebih dari 5 PIN salah dalam 5 menit -> pengirim diabaikan, walau lalu mengirim PIN benar ----
  for (let i = 0; i < 6; i++) await E._callSend(D.id, { t: 'pp', cid: rapat, on: 1, pin: '11111' + i });
  await E._callSend(D.id, { t: 'pp', cid: rapat, on: 1, pin: '123456' });
  await sleep(300);
  assert(D._pvBadBlocked(E.id), 'E kena batas');
  assert(!D._pvHere(rapat).some((x) => x.name === 'E'), 'PIN benar setelah kena batas tetap diabaikan');
  ok('percobaan PIN salah dibatasi per orang');

  // ---- E. PIN diganti: yang masuk dengan PIN lama keluar otomatis (diberi tahu), pemilik tetap; PIN baru bisa masuk ----
  B.pvUpdate(rapat, { pin: '654321' });
  await until(() => !C._pvMe && ac.C.kicks.length === 1, 6000, 'C keluar otomatis');
  assert.strictEqual(ac.C.kicks[0].reason, 'pin');
  assert(B._pvMe, 'pemilik tetap di channel');
  await until(() => B._legs(rapat).length === 0 && names(B, rapat) === 'B', 6000, 'kaki C ditutup');
  assert.throws(() => C.pvEnter(rapat, '123456'), /PIN salah/, 'PIN lama tidak berlaku');
  D.pvLeave(); D.pvEnter(rapat, '654321');
  await until(() => active(B, rapat, ['D']) && active(D, rapat, ['B']), 8000, 'B-D');
  ok('PIN diganti: yang lama keluar otomatis + diberi tahu + kakinya ditutup; PIN baru bisa masuk');

  // ---- F. channel gratis dikunci: yang di dalam tanpa PIN keluar; lalu dihapus: sisanya keluar ----
  const bebas = A.pvCreate('Bebas', null);
  await until(() => all.every((n) => n.pvList({ empty: true }).some((c) => c.id === bebas)), 8000, 'sync');
  C.pvEnter(bebas);
  await until(() => A.pvList().find((c) => c.id === bebas).count === 1, 6000, 'C di Bebas');
  A.pvUpdate(bebas, { pin: '222222' });
  await until(() => !C._pvMe, 6000, 'C dikeluarkan');
  assert.strictEqual(ac.C.kicks[1].reason, 'locked');
  A.pvEnter(bebas); D.pvLeave(); D.pvEnter(bebas, '222222');
  await until(() => active(A, bebas, ['D']) && active(D, bebas, ['A']), 8000, 'A-D');
  A.pvDelete(bebas);
  await until(() => !A._pvMe && !D._pvMe && ac.D.kicks.length === 1, 6000, 'dihapus: semua keluar');
  assert.strictEqual(ac.D.kicks[0].reason, 'deleted');
  assert.strictEqual(A._legs(bebas).length + D._legs(bebas).length, 0);
  ok('dikunci: yang tanpa PIN keluar; dihapus: semua keluar otomatis, kaki ditutup');

  // ---- G. pindah channel: kaki lama dilepas, yang baru tersambung ----
  B.pvLeave(); C.pvLeave(); D.pvLeave();
  C.pvEnter(santai); E.pvEnter(santai);
  await until(() => active(C, santai, ['E']) && active(E, santai, ['C']), 8000, 'C-E');
  C.pvEnter(rapat, '654321'); B.pvEnter(rapat);
  await until(() => active(C, rapat, ['B']) && active(B, rapat, ['C']) && E._legs(santai).length === 0, 8000, 'pindah');
  assert.strictEqual(C._legs(santai).length, 0);
  assert.strictEqual(ac.A.err || ac.B.err || ac.C.err || ac.D.err || ac.E.err, undefined);
  ok('pindah channel: kaki lama dilepas, kaki baru tersambung');

  for (const n of all) await n.stop();
  console.log('\n' + pass + ' OK');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
