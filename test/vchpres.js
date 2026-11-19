'use strict';
// Tes channel voice grup (v0.19.0, langkah 3): presence. Siapa yang sedang di channel mana, lewat sinyal langsung (tidak disimpan).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vchp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
// Siaran ulang 300 ms dan kedaluwarsa 1,5 dtk supaya tes cepat; tick 100 ms.
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, vcBeatMs: 300, vcTtlMs: 1500 }, o || {}));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const cidOf = (c, gid, name) => c.vcList(gid).find((x) => x.name === name).id;
const here = (c, gid, cid) => { const ch = c.vcList(gid).find((x) => x.id === cid); return ch ? ch.here.map((x) => x.name).sort().join() : '?'; };
const everyHere = (ns, gid, cid, want) => ns.every((n) => here(n, gid, cid) === want);

(async () => {
  console.log('Archne vchan presence test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E');
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 4), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id, D.id]).id; // E sengaja bukan anggota
  await until(() => [B, C, D].every((n) => n.getState().groups.some((g) => g.id === gid)), 8000, 'undangan');
  const santai = C.vcCreate(gid, 'Santai', false);
  const rapat = A.vcCreate(gid, 'Rapat', true, [B.id]);
  await until(() => [A, B, C, D].every((n) => n.vcList(gid).length === 2), 8000, 'sync channel');
  const four = [A, B, C, D];

  // ---- A. masuk: semua anggota online melihatnya, di luar anggota tidak ----
  const evs = []; A.on('vcpres', (e) => evs.push(e));
  B.vcEnter(gid, santai);
  await until(() => everyHere([A, B, C, D], gid, santai, 'B'), 6000, 'B masuk');
  assert.strictEqual(here(B, gid, santai), 'B', 'aku melihat diriku sendiri');
  assert(B.vcList(gid).find((x) => x.id === santai).here[0].me, 'penanda me');
  assert.deepStrictEqual(evs.map((e) => [e.peer === B.id, e.on, e.cid === santai]), [[true, 1, true]], 'satu event masuk, tidak berulang walau ada siaran ulang');
  await sleep(800); // melewati beberapa siaran ulang
  assert.strictEqual(evs.length, 1, 'siaran ulang tidak memicu event baru');
  assert.strictEqual(E.vcList(gid).length, 0); assert.strictEqual(E._vcAt.size, 0, 'bukan anggota tidak menerima apa pun');
  ok('B masuk channel: A, C, D melihatnya (satu event, siaran ulang tidak berisik); E yang bukan anggota tidak tahu apa-apa');

  // ---- B. izin, pindah channel, dua orang ----
  assert.throws(() => D.vcEnter(gid, rapat), /izin/, 'member biasa ditolak di channel terkunci');
  assert.throws(() => C.vcEnter(gid, rapat), /izin/, 'pembuat channel lain pun ditolak');
  assert.throws(() => D.vcEnter(gid, 'f'.repeat(16)), /tidak ditemukan/);
  assert.throws(() => E.vcEnter(gid, rapat), /Grup tidak dikenal/);
  B.vcEnter(gid, rapat); // diizinkan, sekaligus pindah dari Santai
  await until(() => everyHere(four, gid, rapat, 'B') && everyHere(four, gid, santai, ''), 6000, 'B pindah');
  A.vcEnter(gid, rapat); // pemilik grup selalu boleh
  await until(() => everyHere(four, gid, rapat, 'A,B'), 6000, 'A ikut');
  A.vcLeave();
  await until(() => everyHere(four, gid, rapat, 'B'), 6000, 'A keluar');
  assert.strictEqual(A.vcLeave(), false, 'keluar dua kali: tidak ada efek');
  B.vcLeave();
  await until(() => everyHere(four, gid, rapat, ''), 6000, 'B keluar');
  ok('terkunci ditolak (member biasa, pembuat channel lain), diizinkan (daftar izin, pemilik); pindah channel melepas yang lama; keluar terlihat semua');

  // ---- C. tempaan: sinyal sah-tanda-tangan tapi tidak berhak diabaikan penerima ----
  const sig = (from, to, o) => from._callSend(to.id, Object.assign({ t: 'vp', g: gid, on: 1 }, o));
  assert.strictEqual(await sig(D, A, { cid: rapat }), true, 'diterima tanpa kesalahan, tapi diabaikan'); // D tidak boleh di Rapat
  assert.strictEqual(await sig(E, A, { cid: santai }), true); // E bukan anggota
  assert.strictEqual(await sig(D, A, { cid: 'f'.repeat(16) }), true); // channel tidak ada
  assert.strictEqual(await sig(D, A, { cid: santai, g: 'e'.repeat(16) }), true); // grup tidak ada
  assert.strictEqual(await sig(D, A, { cid: santai, g: '__proto__' }), true);
  assert.strictEqual(await sig(D, A, { cid: santai, on: 2 }), false, 'bentuk tidak sah ditolak');
  assert.strictEqual(await sig(D, A, { cid: 'bukan-hex' }), false);
  assert.strictEqual(A._vcAt.size, 0, 'tidak ada yang tercatat');
  assert.strictEqual(await sig(D, A, { cid: santai }), true);
  assert.strictEqual(here(A, gid, santai), 'D', 'sinyal yang sah diterima');
  assert.strictEqual(await sig(C, A, { cid: santai, on: 0 }), true); // C melepas kehadiran D? tidak bisa: hanya miliknya sendiri
  assert.strictEqual(here(A, gid, santai), 'D', 'keluar atas nama orang lain tidak berlaku');
  assert.strictEqual(await sig(D, A, { cid: rapat, on: 0 }), true); // keluar dari channel yang bukan tempatnya
  assert.strictEqual(here(A, gid, santai), 'D', 'keluar dari channel lain tidak melepas');
  D.vcEnter(gid, santai); D.vcLeave();
  await until(() => everyHere(four, gid, santai, ''), 6000, 'bersih');
  ok('tempaan diabaikan: bukan anggota, channel terkunci, channel/grup tidak ada, keluar atas nama orang lain; bentuk rusak ditolak');

  // ---- D. peer yang baru online langsung diberi tahu (tanpa menunggu siaran ulang) ----
  B.vcEnter(gid, santai);
  await until(() => everyHere(four, gid, santai, 'B'), 6000, 'B masuk lagi');
  B._vcNext = Infinity; // matikan siaran ulang B untuk menguji jawaban langsung
  A._vcAt.delete(B.id);
  assert.strictEqual(here(A, gid, santai), '', 'A lupa B');
  B._vcGreet(B.peers.get(A.id));
  await until(() => here(A, gid, santai) === 'B', 1000, 'sapaan'); // kurang dari satu siaran ulang (300 ms) tidak dijamin, tapi jauh di bawah kedaluwarsa
  B._vcNext = 0;
  B.vcLeave();
  await until(() => everyHere(four, gid, santai, ''), 6000, 'B keluar');
  ok('peer yang baru online dijawab langsung dengan keberadaan kita');

  // ---- E. siaran ulang menjaga tetap ada; yang diam kedaluwarsa; yang pulih muncul lagi ----
  D.vcEnter(gid, santai);
  await until(() => everyHere([A, B, C], gid, santai, 'D'), 6000, 'D masuk');
  await sleep(2500); // lebih lama dari kedaluwarsa (1,5 dtk)
  assert(everyHere([A, B, C], gid, santai, 'D'), 'siaran ulang menjaganya tetap ada');
  D._vcBroadcast = () => 0; D._callSend = async () => false; // D mendadak senyap (HP mati sinyal, aplikasi macet)
  await until(() => everyHere([A, B, C], gid, santai, ''), 5000, 'kedaluwarsa');
  assert.strictEqual(here(D, gid, santai), 'D', 'D sendiri tidak tahu dirinya dianggap hilang');
  delete D._vcBroadcast; delete D._callSend; // sinyal pulih
  await until(() => everyHere([A, B, C], gid, santai, 'D'), 5000, 'pulih');
  ok('siaran ulang menjaga kehadiran; yang senyap dianggap pergi setelah kedaluwarsa; muncul lagi begitu sinyal pulih');

  // ---- F. hak masuk dicabut / channel dihapus saat sedang di dalam: otomatis keluar ----
  B.vcEnter(gid, rapat);
  await until(() => everyHere(four, gid, rapat, 'B'), 6000, 'B di Rapat');
  A.vcUpdate(gid, rapat, { allow: [] }); // izin B dicabut
  await until(() => B._vcMe === null && everyHere([A, C, D], gid, rapat, ''), 6000, 'izin dicabut');
  A.vcDelete(gid, santai); // D sedang di Santai; pemilik grup menghapusnya
  await until(() => D._vcMe === null && [A, B, C].every((n) => n.vcList(gid).length === 1), 6000, 'channel dihapus');
  assert.strictEqual(A._vcAt.size, 0); assert.strictEqual(C._vcAt.size, 0);
  ok('izin dicabut atau channel dihapus saat sedang di dalam: otomatis keluar, daftar kehadiran bersih');

  // ---- G. orang yang kublokir tidak tampil; dibuka blokir, tampil lagi ----
  const baru = A.vcCreate(gid, 'Baru', false);
  await until(() => four.every((n) => n.vcList(gid).some((x) => x.id === baru)), 6000, 'sync Baru');
  C.vcEnter(gid, baru);
  await until(() => everyHere([A, B, D], gid, baru, 'C'), 6000, 'C masuk Baru');
  B.blockUser(C.id);
  assert.strictEqual(here(B, gid, baru), '', 'langsung hilang dari daftar B');
  await sleep(900);
  assert.strictEqual(here(B, gid, baru), '', 'siaran ulang dari yang diblokir dibuang');
  assert.strictEqual(here(A, gid, baru), 'C', 'yang lain tidak terpengaruh');
  B.unblockUser(C.id);
  await until(() => here(B, gid, baru) === 'C', 5000, 'buka blokir');
  ok('yang diblokir tidak tampil di daftar dan siarannya dibuang; yang lain tidak terpengaruh; buka blokir memulihkan');

  // ---- H. berhenti = keluar ----
  await C.stop();
  await until(() => everyHere([A, B, D], gid, baru, ''), 5000, 'C berhenti');
  ok('node yang berhenti hilang dari channel');

  // ---- I. tidak pernah disimpan ----
  A._saveNow();
  const raw = fs.readFileSync(path.join(tmp, 'A', fs.readdirSync(path.join(tmp, 'A')).find((f) => /store/.test(f)) || ''), 'utf8');
  assert(!raw.includes('"_vcAt"') && !raw.includes('"here"'), 'presence tidak masuk ke disk');
  ok('presence hanya di memori, tidak masuk ke penyimpanan');

  for (const n of [A, B, D, E]) await n.stop();

  // ---- J. pengaturan bawaan, tiga node: peer yang baru tersambung melihat siapa yang sudah di channel ----
  const d = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
  const X = d('X'), Y = d('Y'), Z = d('Z');
  for (const n of [X, Y, Z]) await n.start();
  await lan(X, Y, Z);
  await until(() => X.getState().peers.filter((p) => p.online).length === 2, 8000, 'X-Y-Z');
  const g2 = X.createGroup('Tiga', [Y.id, Z.id]).id;
  await until(() => [Y, Z].every((n) => n.getState().groups.some((g) => g.id === g2)), 8000, 'grup tiga');
  const cx = X.vcCreate(g2, 'Umum', false);
  await until(() => [Y, Z].every((n) => n.vcList(g2).length === 1), 8000, 'channel tiga');
  Y.vcEnter(g2, cx);
  await until(() => here(X, g2, cx) === 'Y', 6000, 'X melihat Y');
  await lan(Y, Z); // Y dan Z baru bertemu langsung (bisa juga sudah dipertemukan X): Z harus melihat Y tanpa menunggu siaran ulang 20 dtk
  await until(() => here(Z, g2, cx) === 'Y', 8000, 'Z melihat Y');
  for (const n of [X, Y, Z]) await n.stop();
  ok('dengan pengaturan bawaan: anggota yang baru tersambung melihat siapa yang sudah di channel');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
