'use strict';
// Tes channel voice publik (v0.20.0, pvch2): penyimpanan dan penyebaran lewat pesan kontrol 'pvch' (bukan pesan chat), sync untuk yang baru online,
// diteruskan peer lain, penegakan pemilik di penerima, blokir, restart, dan "Bersihkan chat".
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Pv = require('../src/archne-pvch');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pvs-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false, syncMs: 400 }, o));
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const names = (c) => c.pvList({ empty: true }).map((x) => x.name).sort().join();
const forge = (from, recs) => from._makeMsg('pvch', null, Pv.encodeCtl(recs));
const rec = (by, extra) => Object.assign({ id: Pv.newId(by), name: 'x', by, locked: false, salt: '', hash: '', ts: Date.now(), v: 1, del: false }, extra);
const online = (n, k) => n.getState().peers.filter((p) => p.online).length === k;

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
  for (const n of [A, B, C]) await n.start();
  await lan(A, B, C); await lan(B, C);
  await until(() => [A, B, C].every((n) => online(n, 2)), 8000, 'mesh');

  // ---- A. buat: semua online melihat; bukan pesan chat; PIN tidak bocor ----
  const seen = []; for (const n of [B, C]) n.on('message', (m) => seen.push(m));
  const free = A.pvCreate('  Ngobrol  santai ', null);
  const lock = A.pvCreate('Rahasia', '123456');
  await until(() => [B, C].every((n) => names(n) === 'Ngobrol santai,Rahasia'), 8000, 'sync create');
  assert.deepStrictEqual(B.pvList({ empty: true }).map((c) => [c.name, c.locked, c.by, c.mine, c.canManage]).sort(), [['Ngobrol santai', false, A.id, false, false], ['Rahasia', true, A.id, false, false]].sort());
  assert.deepStrictEqual(A.pvList({ empty: true }).map((c) => c.canManage), [true, true]);
  assert(Pv.checkPin(B.pv[lock], '123456') && !Pv.checkPin(B.pv[lock], '000000'), 'node lain bisa memeriksa PIN tanpa pemilik');
  assert(!JSON.stringify(B.pvList({ empty: true })).includes('"hash"') && !JSON.stringify(B.pvList({ empty: true })).includes('"salt"'), 'daftar untuk UI tanpa pemeriksa PIN');
  for (const n of [A, B, C]) {
    assert(!Object.values(n.store.msgs).some((m) => m.to === 'pvch' || String(m.text).includes('pvch')), 'bukan pesan chat');
    assert(!n.getState().messages.some((m) => String(m.text).includes('pvch') || String(m.text).includes('Rahasia')), 'tidak tampil di chat');
    assert(!JSON.stringify(n.store).includes('123456'), 'PIN polos tidak ada di penyimpanan');
  }
  assert.strictEqual(seen.length, 0, 'tanpa notifikasi pesan');
  assert.strictEqual(Object.keys(B.store.pvm).length, 2);
  ok('A membuat 2 channel: B dan C melihatnya; bukan pesan chat, tanpa notifikasi, PIN polos tidak tersimpan');

  // ---- B. pendatang baru dapat daftar lewat sync, walau obrolan publik sangat ramai (>500 pesan) ----
  for (let i = 0; i < 620; i++) { const m = A._makeMsg('public', null, 'obrolan ke-' + i); A.store.msgs[m.id] = m; }
  await D.start(); await lan(D, B);
  await until(() => names(D) === 'Ngobrol santai,Rahasia', 10000, 'D dapat daftar dari B');
  assert.strictEqual(D.pvList({ empty: true }).find((c) => c.name === 'Rahasia').by, A.id);
  assert(Pv.checkPin(D.pv[lock], '123456'));
  ok('D (baru online, hanya terhubung ke B) langsung mendapat daftar; jendela sync 500 pesan publik tidak mengganggu');

  // ---- C. diteruskan peer lain: pemilik offline, tetap sampai ke pendatang berikutnya ----
  const E = mk('E'); const dirA = path.join(tmp, 'A'); A._saveNow(); await A.stop();
  await E.start(); await lan(E, D);
  await until(() => names(E) === 'Ngobrol santai,Rahasia', 10000, 'E dapat daftar dari D, pemilik offline');
  ok('pemilik offline: daftar tetap sampai ke E lewat D (pesan bertanda tangan boleh diteruskan)');

  // ---- D. pemilik kembali, ubah/kunci/ganti PIN/hapus: semua node sepakat ----
  const A2 = new Core({ dataDir: dirA, name: 'A', discovery: false, syncMs: 400 }); await A2.start();
  assert.strictEqual(names(A2), 'Ngobrol santai,Rahasia', 'daftar milik sendiri selamat setelah restart');
  await lan(A2, B, C);
  A2.pvUpdate(free, { name: 'Santai' });
  A2.pvUpdate(lock, { pin: '654321' });
  await until(() => [B, C, D].every((n) => names(n) === 'Rahasia,Santai') && [B, C, D].every((n) => Pv.checkPin(n.pv[lock], '654321')), 10000, 'sync update');
  for (const n of [B, C, D]) assert(!Pv.checkPin(n.pv[lock], '123456'), 'PIN lama mati di semua node');
  await until(() => names(E) === 'Rahasia,Santai', 10000, 'E ikut');
  A2.pvUpdate(lock, { pin: null });
  await until(() => [B, C, D, E].every((n) => n.pv[lock] && !n.pv[lock].locked), 10000, 'buka kunci');
  A2.pvDelete(free);
  await until(() => [B, C, D, E].every((n) => names(n) === 'Rahasia'), 10000, 'sync delete');
  for (const n of [B, C, D, E]) assert(n.pv[free].del === true, 'tombstone tersimpan');
  assert(Object.keys(B.store.pvm).length <= 2, 'pesan lama dibuang: penyimpanan tidak membengkak');
  ok('A mengubah nama, ganti PIN, buka kunci, hapus: B, C, D, E sepakat; pesan lama dibuang');

  // ---- E. tempaan: pesan sah-tanda-tangan dari orang yang bukan pemilik tidak diterapkan ----
  const live = Object.assign({}, B.pv[lock]);
  const del = forge(B, [Object.assign({}, live, { v: live.v + 5, ts: live.ts + 10, del: true })]);
  assert.strictEqual(C._ingest(del), 'bad', 'bukan pesan chat: ditolak jalur chat');
  assert.strictEqual(C._pvIngest(del), 'stale'); assert.strictEqual(names(C), 'Rahasia', 'B tidak bisa menghapus milik A');
  assert.strictEqual(C._pvIngest(forge(B, [Object.assign({}, live, { name: 'bajak', v: live.v + 5, ts: live.ts + 10 })])), 'stale');
  assert.strictEqual(C.pv[lock].name, 'Rahasia');
  const squat = forge(B, [Object.assign({}, live, { by: B.id, v: 99 })]); // menyalin ID channel A dengan nama sendiri
  assert.strictEqual(C._pvIngest(squat), 'stale'); assert.strictEqual(C.pv[lock].by, A.id);
  const fake = forge(B, [rec(A.id, { name: 'Palsu' })]); // mengaku channel A baru
  assert.strictEqual(C._pvIngest(fake), 'stale'); assert(!names(C).includes('Palsu'));
  // pesan publik biasa berisi teks kontrol bukan kontrol
  const sneaky = B._makeMsg('public', null, Pv.encodeCtl([rec(B.id, { name: 'Selundupan' })]));
  assert.strictEqual(C._pvIngest(sneaky), 'bad', 'pesan publik biasa tidak diterima di jalur kontrol');
  assert.strictEqual(C._ingest(sneaky), 'new'); assert(!names(C).includes('Selundupan'), 'teks di chat publik tidak pernah jadi channel');
  // rusak
  const tampered = Object.assign({}, forge(A2, [rec(A2.id, { name: 'asli' })])); tampered.text = tampered.text.replace('asli', 'palsu');
  assert.strictEqual(C._pvIngest(tampered), 'bad', 'tanda tangan tidak cocok');
  assert.strictEqual(C._pvIngest(Object.assign(forge(A2, [rec(A2.id)]), { kind: 'e1' })), 'bad');
  assert.strictEqual(C._pvIngest(null), 'bad'); assert.strictEqual(C._pvIngest({ to: 'public' }), 'bad');
  assert.strictEqual(C._pvIngest(A2._makeMsg('pvch', null, 'bukan kontrol')), 'bad');
  const farMsg = A2._makeMsg('pvch', null, Pv.encodeCtl([rec(A2.id, { name: 'jauh' })])); farMsg.ts = Date.now() + 3600e3;
  assert.strictEqual(C._pvIngest(farMsg), 'bad', 'ts pesan jauh di masa depan');
  const farRec = forge(A2, [rec(A2.id, { name: 'masa depan', ts: Date.now() + 3600e3 })]);
  assert.strictEqual(C._pvIngest(farRec), 'stale'); assert(!names(C).includes('masa depan'), 'ts rekaman jauh di masa depan ditolak');
  ok('tempaan ditolak: non-pemilik, perebut ID, pengaku channel, teks di chat publik, tanda tangan rusak, ts masa depan');

  // ---- F. batas lewat jaringan, dan pesan basi tidak dipakai ulang ----
  const flood = []; for (let i = 0; i < 10; i++) flood.push(forge(B, [rec(B.id, { name: 'banjir' + i })]));
  for (const m of flood) C._pvIngest(m);
  assert.strictEqual(Object.values(C.pv).filter((c) => c.by === B.id && !c.del).length, 6, 'tersimpan maksimal 6 per pemilik');
  assert.strictEqual(C.pvList({ empty: true }).filter((c) => c.by === B.id).length, 3, 'terlihat 3');
  const before = Object.keys(C.store.pvm).length;
  assert.strictEqual(C._pvIngest(flood[0]), 'dup'); assert.strictEqual(Object.keys(C.store.pvm).length, before);
  ok('banjir channel dari satu pemilik: 6 tersimpan, 3 terlihat; pesan ganda tidak menambah penyimpanan');

  // ---- G. "Bersihkan chat" tidak menghapus channel ----
  const pubBefore = names(B);
  B.clearChat('public');
  assert.strictEqual(names(B), pubBefore, 'Bersihkan chat publik tidak menghapus channel');
  await sleep(100);
  ok('Bersihkan chat publik: daftar channel tetap');

  // ---- H. ditolak/gagal: tidak mengubah dan tidak menyebarkan apa pun ----
  const sent = []; const orig = B._request.bind(B); B._request = (...a) => { if (a[1].t === 'pvch') sent.push(a[1].m.id); return orig(...a); };
  B.pvCreate('b1', null); B.pvCreate('b2', null); B.pvCreate('b3', null);
  const peersOn = [...B.peers.values()].filter((p) => B.isOnline(p) && !B.isBlocked(p.id)).length;
  assert(peersOn >= 3, 'B punya peer online');
  assert.strictEqual(sent.length, 3 * peersOn, 'tiap perubahan didorong ke tiap peer online');
  const mine = () => B.pvList({ empty: true }).filter((c) => c.mine).length;
  assert.strictEqual(mine(), 3);
  const snap = JSON.stringify(B.pv), pvm = JSON.stringify(Object.keys(B.store.pvm).sort()), pushed = sent.length;
  assert.throws(() => B.pvCreate('b4', null), /sudah punya 3/);
  const snapA = JSON.stringify(A2.pv);
  assert.throws(() => A2.pvCreate('x', 'abc'), /6 angka/);
  assert.throws(() => A2.pvCreate('   ', null), /kosong/);
  assert.strictEqual(JSON.stringify(A2.pv), snapA, 'PIN/nama tidak sah tidak mengubah peta');
  assert.throws(() => B.pvDelete(lock), /pemilik channel/);
  assert.throws(() => B.pvUpdate(lock, { name: 'x' }), /pemilik channel/);
  assert.throws(() => B.pvDelete('f'.repeat(16)), /tidak ditemukan/);
  const real = B._makeMsg.bind(B); B._makeMsg = () => { throw new Error('kunci hilang'); }; // gagal setelah peta lokal berubah: harus dibatalkan
  const mineId = B.pvList({ empty: true }).find((c) => c.mine).id;
  assert.throws(() => B.pvDelete(mineId), /kunci hilang/);
  assert.throws(() => B.pvUpdate(mineId, { name: 'tidak jadi' }), /kunci hilang/);
  B._makeMsg = real;
  assert.strictEqual(JSON.stringify(B.pv), snap, 'peta tidak berubah');
  assert.strictEqual(JSON.stringify(Object.keys(B.store.pvm).sort()), pvm);
  assert.strictEqual(sent.length, pushed, 'tidak ada yang disebarkan');
  B._request = orig;
  ok('operasi ditolak atau gagal di tengah jalan: peta dan penyimpanan tidak berubah, tidak ada yang disebarkan');

  // ---- I. blokir: channel pengirim yang diblokir hilang, dibuang, tidak diterima lagi; buka blokir -> kembali ----
  await until(() => [A2, C, D].every((n) => n.pvList({ empty: true }).filter((c) => c.by === B.id).length === 3), 10000, 'channel B menyebar');
  C.blockUser(B.id);
  assert.strictEqual(C.pvList({ empty: true }).filter((c) => c.by === B.id).length, 0, 'disembunyikan dan dibuang');
  assert(!Object.values(C.store.pvm).some((m) => m.from === B.id), 'pesannya dibuang dari penyimpanan');
  assert.strictEqual(C._pvIngest(forge(B, [rec(B.id, { name: 'baru dari B' })])), 'dup', 'tidak diterima');
  assert.strictEqual(C.pvList({ empty: true }).filter((c) => c.by === A2.id).length, 1, 'milik orang lain tidak terpengaruh');
  const viaD = D.pvList({ empty: true }).filter((c) => c.by === B.id).length; assert.strictEqual(viaD, 3, 'D (tidak memblokir) tetap melihatnya');
  await sleep(1500); // sync dari D tidak boleh membawanya kembali
  assert.strictEqual(C.pvList({ empty: true }).filter((c) => c.by === B.id).length, 0, 'tidak kembali lewat peer lain selama diblokir');
  C.unblockUser(B.id);
  await until(() => C.pvList({ empty: true }).filter((c) => c.by === B.id).length === 3, 10000, 'kembali setelah buka blokir');
  ok('blokir: channel orang itu hilang & dibuang, tidak kembali lewat peer lain; buka blokir memulihkannya lewat sync');

  // ---- J. restart: daftar selamat; yang diblokir tidak ikut dimuat ----
  const dirC = path.join(tmp, 'C'); C.blockUser(B.id); C._saveNow(); const listC = names(C); await C.stop();
  const C2 = new Core({ dataDir: dirC, name: 'C', discovery: false, syncMs: 400 }); await C2.start();
  assert.strictEqual(names(C2), listC); assert.strictEqual(C2.pvList({ empty: true }).filter((c) => c.by === B.id).length, 0);
  assert(Object.keys(C2.store.pvm).length > 0);
  await C2.stop();
  ok('restart: daftar channel selamat; pengirim yang diblokir tetap tersaring');

  // ---- K. isi balasan sync: hanya yang lebih baru dari yang dimiliki peminta, tanpa pengirim yang diblokir peminta; masukan rusak aman ----
  const all = D._pvForSync({}, []);
  assert(all.length >= 2 && all.every((m) => m.to === 'pvch'));
  const ids = (list) => list.map((m) => m.id);
  const pvh = Object.fromEntries(Object.entries(D.pv).map(([cid, c]) => [cid, c.v]));
  assert.strictEqual(D._pvForSync(pvh, []).length, 0, 'peminta sudah punya semuanya');
  const behind = Object.assign({}, pvh, { [lock]: D.pv[lock].v - 1 });
  assert.deepStrictEqual(ids(D._pvForSync(behind, [])), [D._pvRef[lock]], 'hanya yang tertinggal');
  const noA = D._pvForSync({}, [A2.id]);
  assert(noA.length > 0 && noA.every((m) => m.from !== A2.id), 'pengirim yang diblokir peminta tidak dikirim');
  assert(all.some((m) => m.from === A2.id));
  for (const bad of [null, undefined, 5, 'x', [], [1, 2], { [lock]: 'tinggi' }, { [lock]: -1 }, { [lock]: 1e99 }]) assert.deepStrictEqual(ids(D._pvForSync(bad, bad)), ids(all), 'masukan rusak = peminta yang belum punya apa-apa');
  assert.strictEqual(D._pvForSync({ [lock]: 1e99 }, []).length, all.length, 'versi tidak masuk akal tidak dipercaya');
  ok('isi balasan sync: hanya yang tertinggal, tanpa pengirim yang diblokir peminta, masukan rusak aman');

  for (const n of [A2, B, D, E]) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' tes penyebaran channel voice publik (pvch2) lulus');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
