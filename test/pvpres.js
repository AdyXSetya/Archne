'use strict';
// Tes kehadiran channel voice publik (v0.20.0, pvch3): siapa di channel mana, disiarkan ke SEMUA peer online (bukan anggota grup),
// kedaluwarsa kalau tidak diperbarui, dan penyaringan daftar (channel kosong disembunyikan). Core asli lewat jaringan loopback.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pvp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
// Siaran ulang 300 ms, kedaluwarsa 1,5 dtk, tick 100 ms supaya tes cepat.
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, vcBeatMs: 300, vcTtlMs: 1500, syncMs: 400 }, o || {}));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const online = (n, k) => n.getState().peers.filter((p) => p.online).length === k;
const row = (c, cid, empty) => c.pvList(empty ? { empty: true } : undefined).find((x) => x.id === cid);
const who = (c, cid) => { const r = row(c, cid, true); return r ? r.count + ':' + c._pvHere(cid).map((x) => x.name).join() : '?'; };
const everyWho = (ns, cid, want) => ns.every((n) => who(n, cid) === want);

(async () => {
  console.log('Archne pvch presence test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E');
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => online(n, 4)), 8000, 'mesh');
  const santai = A.pvCreate('Santai', null);                 // milik A, gratis
  const rapat = B.pvCreate('Rapat', '123456');               // milik B, terkunci
  const sepi = C.pvCreate('Sepi', null);                     // milik C, tidak akan dimasuki siapa pun
  await until(() => all.every((n) => n.pvList({ empty: true }).length === 3), 8000, 'sync channel');

  // ---- A. channel kosong disembunyikan, kecuali milik sendiri; opts.empty menampilkan semua ----
  assert.deepStrictEqual(D.pvList(), [], 'D (bukan pemilik) tidak melihat channel kosong');
  assert.deepStrictEqual(A.pvList().map((c) => c.name), ['Santai'], 'pemilik tetap melihat channelnya yang kosong');
  assert.deepStrictEqual(C.pvList().map((c) => c.name), ['Sepi']);
  assert.deepStrictEqual(D.pvList({ empty: true }).map((c) => c.name).sort(), ['Rapat', 'Santai', 'Sepi'], 'tombol "Tampilkan yang kosong"');
  assert(D.pvList({ empty: true }).every((c) => c.count === 0 && c.people.length === 0 && !c.inside));
  ok('channel kosong tersembunyi; milik sendiri selalu tampil; opts.empty menampilkan semua');

  // ---- B. masuk: SEMUA peer online melihatnya (tanpa grup), termasuk orang di luar jaringan pemilik ----
  const evs = []; D.on('pvpres', (e) => evs.push(e));
  B.pvEnter(santai);
  await until(() => everyWho(all, santai, '1:B'), 6000, 'B masuk');
  assert.strictEqual(who(B, santai), '1:B', 'aku melihat diriku sendiri');
  assert.deepStrictEqual(D.pvList().map((c) => [c.name, c.count]), [['Santai', 1]], 'sekarang tampil di daftar D');
  assert.deepStrictEqual(row(D, santai).people.map((p) => [p.name, !!p.me]), [['B', false]]);
  assert(row(B, santai).inside && !row(D, santai).inside && row(B, santai).people[0].me === true);
  assert(evs.some((e) => e.on === 1 && e.peer === B.id && e.cid === santai && !e.me), 'event vcpres-sejenis untuk UI');
  ok('B masuk: semua peer online melihatnya dan channel kosong itu jadi tampil');

  // ---- C. beberapa orang: urutan paling ramai dulu (bukan urutan dibuat), tiga nama + jumlah; pindah channel melepas yang lama ----
  C.pvEnter(rapat, '123456'); E.pvEnter(rapat, '123456'); // Rapat dibuat belakangan tapi lebih ramai (2) daripada Santai (1: B)
  await until(() => all.every((n) => row(n, rapat, true).count === 2 && row(n, santai, true).count === 1), 6000, 'sebaran');
  assert.deepStrictEqual(A.pvList().map((c) => [c.name, c.count]), [['Rapat', 2], ['Santai', 1]], 'yang lebih ramai di atas walau lebih baru; Sepi (kosong, bukan milik A) tersembunyi');
  evs.length = 0;
  D.pvEnter(santai); C.pvEnter(santai); // C pindah dari Rapat ke Santai
  await until(() => all.every((n) => row(n, santai, true).count === 3 && row(n, rapat, true).count === 1), 6000, 'C pindah');
  assert.deepStrictEqual(A.pvList().map((c) => [c.name, c.count]), [['Santai', 3], ['Rapat', 1]], 'urutan berbalik mengikuti keramaian');
  const mv = evs.filter((e) => e.peer === C.id).map((e) => (e.on ? '+' : '-') + (e.cid === santai ? 'santai' : 'rapat'));
  assert.deepStrictEqual(mv, ['-rapat', '+santai'], 'pindah: yang lama dilepas dulu lalu yang baru, sebagai dua event');
  E.pvEnter(santai);
  await until(() => all.every((n) => row(n, santai, true).count === 4 && row(n, rapat, true).count === 0), 6000, 'E pindah');
  const r = row(A, santai); assert.strictEqual(r.people.length, 3, 'paling banyak 3 nama'); assert.deepStrictEqual(r.people.map((p) => p.name), ['B', 'C', 'D']);
  assert.strictEqual(row(E, santai).people[0].name, 'E', 'aku disebut lebih dulu di daftarku sendiri');
  assert.deepStrictEqual(A.pvList().map((c) => c.name), ['Santai'], 'Rapat kosong lagi: hilang dari daftar A');
  ok('urutan paling ramai dulu; tiga nama + jumlah; pindah channel melepas yang lama (event keluar lalu masuk)');

  // ---- D. keluar: semua peer langsung melihatnya; satu channel sekaligus ----
  assert.strictEqual(E.pvLeave(), true); assert.strictEqual(E.pvLeave(), false, 'sudah keluar');
  await until(() => all.every((n) => row(n, santai, true).count === 3), 900, 'E keluar langsung (bukan menunggu kedaluwarsa 1,5 dtk)');
  C.pvEnter(santai); // masuk lagi ke channel yang sama: tidak menggandakan
  assert.strictEqual(row(C, santai).count, 3);
  ok('keluar disiarkan; masuk dua kali ke channel yang sama tidak menggandakan');

  // ---- E. kedaluwarsa: berhenti menyiarkan -> hilang setelah TTL; siaran berkala menjaga yang aktif tetap ada ----
  await sleep(2200); // > TTL 1,5 dtk: yang masih hadir tetap ada karena disiarkan ulang tiap 300 ms
  assert(all.every((n) => row(n, santai, true).count === 3), 'siaran berkala menjaga kehadiran melewati TTL');
  B._pvNext = Infinity; // B diam-diam berhenti menyiarkan, tetap online
  await until(() => [A, C, D].every((n) => row(n, santai, true).count === 2), 6000, 'B kedaluwarsa');
  assert.strictEqual(row(B, santai).count, 3, 'B sendiri masih menganggap dirinya di dalam');
  B._pvNext = 0; await until(() => [A, C, D].every((n) => row(n, santai, true).count === 3), 6000, 'B muncul lagi saat menyiarkan');
  ok('kedaluwarsa kalau tidak diperbarui, pulih saat siaran lanjut; siaran berkala menjaga yang aktif');

  // ---- F. peer yang baru online: dijawab kehadiran, dan siaran yang datang sebelum daftar channel dikenal diperbaiki siaran ulang ----
  const F = mk('F'); await F.start(); await lan(F, B, C, D);
  await until(() => row(F, santai, true) && row(F, santai, true).count === 3, 10000, 'F melihat kehadiran');
  assert.deepStrictEqual(F.pvList().map((c) => c.name), ['Santai'], 'F hanya melihat channel yang ada orangnya');
  ok('pendatang baru melihat siapa di mana (daftar lewat sync, kehadiran lewat sapaan dan siaran ulang)');

  // ---- G. peer offline -> hilang; peer diblokir -> hilang, kembali setelah blokir dibuka ----
  await D.stop();
  await until(() => [A, B, C].every((n) => row(n, santai, true).count === 2), 10000, 'D offline');
  A.blockUser(C.id);
  assert.strictEqual(row(A, santai, true).count, 1, 'C diblokir A: tidak terhitung di A');
  assert.strictEqual(row(B, santai, true).count, 2, 'B tidak memblokir: tetap terhitung');
  A.unblockUser(C.id);
  await until(() => row(A, santai, true).count === 2, 6000, 'C kembali di A');
  ok('peer offline dan peer yang diblokir tidak terhitung; kembali saat blokir dibuka');

  // ---- H. channel dihapus saat ada orang: yang di dalam keluar otomatis, hilang dari daftar ----
  assert(B._pvMe && B._pvMe.cid === santai);
  A.pvDelete(santai);
  await until(() => !B._pvMe && !C._pvMe, 6000, 'keluar otomatis');
  await until(() => [A, B, C].every((n) => !row(n, santai, true)), 6000, 'channel hilang');
  await until(() => ![...A._pvAt.values(), ...B._pvAt.values(), ...C._pvAt.values()].some((x) => x.cid === santai), 6000, 'sisa kehadiran dibersihkan');
  ok('channel dihapus: yang di dalam keluar otomatis, kehadiran dibersihkan');

  // ---- I. aturan masuk lokal: PIN, penuh, tidak ada ----
  assert.throws(() => A.pvEnter(rapat), /PIN salah/);
  assert.throws(() => A.pvEnter(rapat, '000000'), /PIN salah/);
  assert.throws(() => A.pvEnter(santai), /tidak ditemukan/, 'channel yang sudah dihapus');
  assert.throws(() => A.pvEnter('nope'), /tidak ditemukan/);
  assert(!A._pvMe, 'gagal masuk tidak mengubah apa pun');
  A.pvEnter(rapat, '123456'); assert.strictEqual(A._pvMe.cid, rapat);
  B.pvLeave(); B.pvEnter(rapat); assert.strictEqual(B._pvMe.cid, rapat, 'pemilik masuk tanpa PIN');
  A.pvLeave();
  const full = 1; A._pvHere = () => new Array(16).fill({ id: 'x', name: 'x' });
  assert.throws(() => A.pvEnter(rapat, '123456'), /penuh \(maksimal 16 orang\)/);
  delete A._pvHere; void full;
  assert(row(A, rapat, true).full === false);
  ok('masuk: PIN salah ditolak, pemilik tanpa PIN, channel hilang/penuh ditolak, gagal tidak mengubah apa pun');

  // ---- J. sinyal palsu/rusak ditolak: bukan peer, channel tak dikenal, nilai aneh ----
  const ackf = (ok) => ({ ok }), sz = A._pvAt.size;
  assert.strictEqual(A._pvPresIn({ from: 'f'.repeat(16) }, { t: 'pp', cid: rapat, on: 1 }, 'x', ackf).ok, true);
  assert.strictEqual(A._pvAt.size, sz, 'bukan peer yang kukenal: tidak disimpan');
  A._pvPresIn({ from: C.id }, { t: 'pp', cid: 'a'.repeat(16), on: 1 }, 'x', ackf);
  assert(!A._pvAt.has(C.id) || A._pvAt.get(C.id).cid !== 'a'.repeat(16), 'channel tak dikenal diabaikan');
  assert.strictEqual(A._pvPresIn({ from: C.id }, { t: 'pp', cid: rapat, on: 2 }, 'x', ackf).ok, false, 'nilai on aneh ditolak');
  assert.strictEqual(A._pvPresIn({ from: C.id }, { t: 'pp', cid: rapat, on: 0 }, 'x', ackf).ok, true, 'keluar dari channel yang tak dimasuki: aman');
  // channel yang tersimpan tapi tersembunyi (di luar batas 3 per pemilik) tidak menerima kehadiran
  const Pv = require('../src/archne-pvch');
  C.pvCreate('Dua', null); C.pvCreate('Tiga', null);
  const hid = C.id.slice(0, 10) + 'ffffff';
  assert.strictEqual(A._pvIngest(C._makeMsg('pvch', null, Pv.encodeCtl([{ id: hid, name: 'Tersembunyi', by: C.id, locked: false, salt: '', hash: '', ts: Date.now(), v: 1, del: false }]))), 'new');
  await until(() => Pv.live(A.pv).filter((c) => c.by === C.id).length === 3, 6000, 'C punya 3 channel terlihat');
  assert(A.pv[hid] && !A.pvList({ empty: true }).some((c) => c.id === hid), 'tersimpan tapi tidak terlihat');
  A._pvPresIn({ from: B.id }, { t: 'pp', cid: hid, on: 1 }, 'x', ackf);
  assert(!A._pvAt.has(B.id) || A._pvAt.get(B.id).cid !== hid, 'kehadiran di channel tersembunyi diabaikan');
  // lewat jalur nyata: pesan 'pp' bertanda tangan C ke A diterima; yang bukan untuk A atau rusak ditolak
  const good = C._makeMsg(A.id, 'c1', JSON.stringify({ t: 'pp', cid: rapat, on: 1, pin: '123456' })); // Rapat terkunci: sejak pvch4 penerima memeriksa PIN
  assert.strictEqual(A._callIn(good).ok, true); assert.strictEqual(A._pvAt.get(C.id).cid, rapat);
  const bad = C._makeMsg(A.id, 'c1', JSON.stringify({ t: 'pp', cid: 'zz', on: 1 }));
  assert.strictEqual(A._callIn(bad).ok, false, 'cid tidak sah ditolak oleh jalur sinyal');
  ok('sinyal kehadiran palsu atau rusak ditolak; yang sah lewat jalur sinyal diterima');

  for (const n of [A, B, C, E, F]) await n.stop().catch(() => {});
  console.log('\n' + pass + ' tes kehadiran channel voice publik (pvch3) lulus');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
