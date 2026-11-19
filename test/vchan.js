'use strict';
// Tes channel voice grup (v0.19.0, langkah 1): model data, hak akses member/admin/pemilik, terbuka/terkunci, simpan-muat.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Vc = require('../src/archne-vchan');
const { Core } = require('../src/archne-core');

let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const id = (c) => c.repeat(16);
const OWN = id('a'), ADM = id('b'), M1 = id('c'), M2 = id('d'), OUT = id('e');
const mkG = () => ({ id: id('9'), creator: OWN, admins: [ADM], removed: false, members: [OWN, ADM, M1, M2].map((x) => ({ id: x, name: x[0] })), vch: {} });
let n = 0;
const cid = () => (++n).toString(16).padStart(16, '0');

// 1. member boleh membuat; bukan anggota tidak boleh
{
  const g = mkG();
  const c = Vc.create(g, M1, cid(), '  Ngobrol   santai ', false, [], 10);
  assert.strictEqual(c.name, 'Ngobrol santai');
  assert.strictEqual(c.by, M1); assert.strictEqual(c.locked, false); assert.strictEqual(c.v, 1);
  assert.throws(() => Vc.create(g, OUT, cid(), 'X', false, [], 11), /bukan anggota/);
  assert.throws(() => Vc.create(g, M1, cid(), '   ', false, [], 11), /kosong/);
  assert.throws(() => Vc.create(g, M1, 'bukanhex', 'X', false, [], 11), /ID channel/);
  assert.strictEqual(Vc.cleanName('a\u202eb\u0000c'), 'a b c', 'karakter kontrol/bidi dibuang');
  assert.strictEqual(Vc.cleanName('x'.repeat(80)).length, 32);
  ok('member boleh membuat; nama dibersihkan; non-anggota dan nama kosong ditolak');
}

// 2. hapus: member hanya miliknya; admin dan pemilik grup boleh siapa pun
{
  const g = mkG();
  const a = cid(), b = cid(), c = cid();
  Vc.create(g, M1, a, 'milik M1', false, [], 1);
  Vc.create(g, M1, b, 'milik M1 b', false, [], 2);
  Vc.create(g, M2, c, 'milik M2', false, [], 3);
  assert.throws(() => Vc.remove(g, M2, a, 5), /pembuat channel atau admin/);
  assert.throws(() => Vc.remove(g, OUT, a, 5), /pembuat channel atau admin/);
  Vc.remove(g, M1, a, 5);
  assert.strictEqual(g.vch[a].del, true); assert.strictEqual(g.vch[a].v, 2);
  Vc.remove(g, ADM, b, 6); // admin menghapus milik member
  Vc.remove(g, OWN, c, 7); // pemilik grup menghapus milik member
  assert.strictEqual(Vc.live(g).length, 0);
  assert.throws(() => Vc.remove(g, OWN, a, 8), /tidak ditemukan/, 'sudah terhapus');
  ok('hapus: member hanya miliknya, admin dan pemilik bisa semua, tombstone tersimpan');
}

// 3. terbuka vs terkunci
{
  const g = mkG();
  const open = Vc.create(g, M1, cid(), 'bebas', false, [], 1);
  const lock = Vc.create(g, M1, cid(), 'rahasia', true, [M2], 2);
  for (const who of [OWN, ADM, M1, M2]) assert(Vc.canJoin(g, open, who), 'terbuka: semua anggota');
  assert(!Vc.canJoin(g, open, OUT), 'bukan anggota tidak boleh walau terbuka');
  assert(Vc.canJoin(g, lock, M1), 'pembuat');
  assert(Vc.canJoin(g, lock, M2), 'yang diizinkan');
  assert(Vc.canJoin(g, lock, ADM) && Vc.canJoin(g, lock, OWN), 'admin dan pemilik selalu bisa');
  const g2 = mkG(); const l2 = Vc.create(g2, M1, cid(), 'kunci', true, [], 1);
  assert(!Vc.canJoin(g2, l2, M2), 'terkunci, tidak diizinkan');
  assert.throws(() => Vc.create(g, M1, cid(), 'z', true, [OUT], 3), /hanya boleh berisi anggota/);
  assert.throws(() => Vc.create(g, M1, cid(), 'z', true, ['zz'], 3), /tidak valid/);
  assert.deepStrictEqual(Vc.create(g, M1, cid(), 'z', true, [M1, M2, M2], 3).allow, [M2], 'pembuat dan duplikat dibuang dari daftar izin');
  ok('terbuka: semua anggota; terkunci: pembuat, yang diizinkan, admin, pemilik');
}

// 4. ubah: kunci/buka, izin, nama; hak sama dengan hapus
{
  const g = mkG();
  const c = Vc.create(g, M1, cid(), 'awal', false, [], 1);
  assert.throws(() => Vc.update(g, M2, c.id, { locked: true }, 2), /pembuat channel atau admin/);
  Vc.update(g, M1, c.id, { locked: true, allow: [M2] }, 2);
  assert(c.locked && c.allow.includes(M2) && c.v === 2);
  Vc.update(g, ADM, c.id, { name: 'diganti admin', allow: [] }, 3);
  assert.strictEqual(c.name, 'diganti admin'); assert.deepStrictEqual(c.allow, []); assert.strictEqual(c.v, 3);
  assert(!Vc.canJoin(g, c, M2), 'izin dicabut');
  Vc.remove(g, M1, c.id, 4);
  assert.throws(() => Vc.update(g, M1, c.id, { locked: false }, 5), /tidak ditemukan/);
  ok('ubah nama/kunci/izin hanya oleh pembuat dan admin; channel terhapus tidak bisa diubah');
}

// 5. anggota dikeluarkan tidak bisa masuk; grup dibubarkan
{
  const g = mkG();
  const c = Vc.create(g, M1, cid(), 'x', false, [], 1);
  g.members = g.members.filter((m) => m.id !== M2);
  assert(!Vc.canJoin(g, c, M2)); assert(!Vc.canManage(g, c, M2));
  g.removed = true;
  assert(!Vc.canJoin(g, c, M1) && !Vc.canCreate(g, M1));
  ok('anggota yang sudah keluar tidak bisa masuk; grup removed menutup semuanya');
}

// 6. batas jumlah
{
  const g = mkG();
  for (let i = 0; i < Vc.VC_MAX_LIVE; i++) Vc.create(g, M1, cid(), 'c' + i, false, [], i);
  assert.throws(() => Vc.create(g, M1, cid(), 'lebih', false, [], 99), /penuh/);
  assert(!Vc.canCreate(g, M1));
  const first = Object.keys(g.vch)[0]; Vc.remove(g, M1, first, 100);
  assert(Vc.canCreate(g, M1), 'tombstone tidak menghitung sebagai channel hidup');
  for (let i = 0; i < 200; i++) { const x = Vc.create(g, M1, cid(), 'y', false, [], 200 + i); Vc.remove(g, M1, x.id, 400 + i); }
  assert(Object.keys(g.vch).length <= Vc.VC_MAX_ALL, 'tombstone tertua dipangkas, total entri terbatas');
  assert.strictEqual(Vc.live(g).length, Vc.VC_MAX_LIVE - 1, 'channel hidup tidak ikut terpangkas');
  ok('maksimal 20 channel hidup; tombstone tidak menghitung dan dipangkas di 100 entri');
}

// 7. clean(): data rusak dari disk dibuang, data sah dipertahankan
{
  const good = { id: id('1'), name: 'ok', by: M1, locked: true, allow: [M2, 'zz', M2], ts: 5, v: 3, del: false };
  const out = Vc.clean({
    [id('1')]: good,
    [id('2')]: { id: id('3'), name: 'id beda', by: M1 },
    bukanhex: { id: 'bukanhex', name: 'x', by: M1 },
    [id('4')]: { id: id('4'), name: '   ', by: M1 },
    [id('5')]: { id: id('5'), name: 'tanpa by', by: 'zz' },
    [id('6')]: null,
    [id('7')]: { id: id('7'), name: 'longgar', by: M1, locked: 'ya', v: -4, ts: 'x' },
  });
  assert.deepStrictEqual(Object.keys(out).sort(), [id('1'), id('7')]);
  assert.deepStrictEqual(out[id('1')].allow, [M2], 'izin tidak valid dan duplikat dibuang');
  assert.strictEqual(out[id('7')].locked, false, 'locked hanya true bila benar-benar true');
  assert.strictEqual(out[id('7')].v, 1); assert.strictEqual(out[id('7')].ts, 0);
  assert.deepStrictEqual(Vc.clean(undefined), {}); assert.deepStrictEqual(Vc.clean([1, 2]), {}); assert.deepStrictEqual(Vc.clean('x'), {});
  ok('clean(): entri rusak dibuang, field longgar dinormalkan, bentuk salah menjadi {}');
}

// 8. lewat Core: API lokal, simpan, muat ulang
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vch-'));
  const mk = () => new Core({ dataDir: path.join(tmp, 'A'), name: 'A', discovery: false });
  let A = mk(); await A.start();
  const g = mkG(); g.creator = A.id; g.admins = []; g.members = [{ id: A.id, name: 'A' }, { id: M1, name: 'M1' }, { id: M2, name: 'M2' }];
  g.epoch = 0; g.eps = { 0: { key: Buffer.alloc(32, 7).toString('base64'), members: g.members.map((x) => x.id), by: A.id, its: 1, top: 0 } }; // vcCreate kini mengirim pesan kontrol g1: butuh kunci grup
  A.store.groups[g.id] = g;
  assert.deepStrictEqual(A.vcList(g.id), []);
  const c1 = A.vcCreate(g.id, 'Santai', false);
  const c2 = A.vcCreate(g.id, 'Rapat', true, [M1]);
  let l = A.vcList(g.id);
  assert.deepStrictEqual(l.map((x) => x.name), ['Santai', 'Rapat'], 'urut menurut waktu buat');
  assert(l.every((x) => x.canJoin && x.canManage), 'pemilik grup bisa masuk dan mengelola semuanya');
  assert.strictEqual(A.vcCanJoin(g.id, c2, M1), true);
  assert.strictEqual(A.vcCanJoin(g.id, c2, M2), false);
  assert.strictEqual(A.vcCanJoin(g.id, c1, M2), true);
  assert.strictEqual(A.vcCanJoin(g.id, 'tidakada0000000000', M1), false);
  A.vcUpdate(g.id, c2, { allow: [M1, M2] });
  assert.strictEqual(A.vcCanJoin(g.id, c2, M2), true);
  assert.throws(() => A.vcCreate('tidakada', 'x'), /Grup tidak dikenal/);
  A._saveNow(); await A.stop();

  A = mk(); await A.start();
  l = A.vcList(g.id);
  assert.deepStrictEqual(l.map((x) => x.name), ['Santai', 'Rapat'], 'channel selamat setelah muat ulang');
  assert.deepStrictEqual(l[1].allow.sort(), [M1, M2].sort());
  A.vcDelete(g.id, c1);
  assert.deepStrictEqual(A.vcList(g.id).map((x) => x.name), ['Rapat']);
  A.store.groups[g.id].removed = true;
  assert.deepStrictEqual(A.vcList(g.id), []);
  assert.throws(() => A.vcCreate(g.id, 'x'), /dikeluarkan/);
  A._saveNow(); await A.stop();
  ok('Core: vcCreate/vcList/vcUpdate/vcDelete/vcCanJoin, bertahan setelah muat ulang, grup removed ditutup');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
