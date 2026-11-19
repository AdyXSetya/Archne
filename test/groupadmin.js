'use strict';
require('./_lang')(); // catatan grup Indonesia (i18n E9a)
// Tes admin grup, ganti nama, bubarkan grup (v0.8.0). Discovery UDP dimatikan; node dihubungkan manual (mesh).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-gadm-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const has = (c, text) => c.getState().messages.some((m) => !m.sys && m.text === text);
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);
const lan = (c, ...others) => Promise.all(others.map((o) => c.addPeer('127.0.0.1', o.port)));
const note = (c, re) => c.getState().messages.some((m) => m.sys && re.test(m.text));
const forge = (from, to, payload) => from._makeMsg(to.id, 'ginv', JSON.stringify(payload));
const KEY = Buffer.alloc(32, 9).toString('base64');

(async () => {
  console.log('Archne group admin test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
  let E = mk('E');
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 4), 8000, 'mesh');

  // ---------- peran ----------
  const gid = A.createGroup('Tim', [B.id, C.id, D.id]).id, G = 'g:' + gid;
  await until(() => [B, C, D].every((n) => grp(n, gid)), 8000, 'undangan');
  assert.deepStrictEqual(grp(A, gid).admins, []);
  assert.strictEqual(grp(B, gid).creator, A.id);
  assert.throws(() => B.setAdmin(gid, C.id, true), /pembuat grup/);
  assert.throws(() => B.disbandGroup(gid), /pembuat grup/);
  assert.throws(() => A.setAdmin(gid, A.id, true), /sudah punya semua wewenang/);
  assert.throws(() => A.setAdmin(gid, E.id, true), /Bukan anggota/);
  A.setAdmin(gid, B.id, true);
  await until(() => [A, B, C, D].every((n) => { const g = grp(n, gid); return g.epoch === 1 && g.admins.length === 1 && g.admins[0] === B.id; }), 10000, 'admin B');
  assert(note(C, /B menjadi admin grup/));
  A.sendText('setelah B jadi admin', G);
  await until(() => [B, C, D].every((n) => has(n, 'setelah B jadi admin')), 8000, 'msg');
  ok('pembuat menjadikan B admin: semua anggota melihat admin, epoch naik, catatan sistem, grup tetap jalan; non-pembuat tidak bisa mengatur admin / membubarkan');

  // ---------- admin: mengeluarkan anggota biasa ----------
  assert.throws(() => C.removeMember(gid, D.id), /pembuat grup dan admin/);
  assert.throws(() => B.removeMember(gid, A.id), /Pembuat grup tidak bisa dikeluarkan/);
  assert.throws(() => B.removeMember(gid, B.id), /dirimu sendiri/);
  B.removeMember(gid, D.id);
  await until(() => [A, B, C].every((n) => { const g = grp(n, gid); return g.epoch === 2 && g.members.length === 3; }), 10000, 'B kick D');
  await until(() => !grp(D, gid), 10000, 'D tahu');
  assert(note(A, /D dikeluarkan dari grup oleh B/));
  ok('admin B mengeluarkan anggota biasa D: grup pindah epoch, D kehilangan grup; catatan menyebut siapa yang mengeluarkan');

  // ---------- admin tidak bisa mengeluarkan pembuat / admin lain ----------
  A.addMembers(gid, [D.id]); // D masuk lagi (epoch 3)
  await until(() => [A, B, C, D].every((n) => { const g = grp(n, gid); return g && g.epoch === 3 && g.members.length === 4; }), 10000, 'D kembali');
  A.setAdmin(gid, C.id, true); // admin: B, C (epoch 4)
  await until(() => [A, B, C, D].every((n) => grp(n, gid).epoch === 4 && grp(n, gid).admins.length === 2), 10000, 'C admin');
  assert.throws(() => B.removeMember(gid, C.id), /Admin tidak bisa mengeluarkan admin lain/);
  // admin B yang dimodifikasi: tetap ditolak di sisi penerima
  const noA = forge(B, A, { gid, epoch: 99, removed: true, members: [{ id: B.id, name: 'B' }] });
  assert.strictEqual(A._ingest(noA), 'bad', 'admin tidak bisa mengeluarkan pembuat');
  const noC = forge(B, C, { gid, epoch: 99, removed: true, members: [{ id: B.id, name: 'B' }] });
  assert.strictEqual(C._ingest(noC), 'bad', 'admin tidak bisa mengeluarkan admin lain');
  const mem = (...ns) => ns.map((n) => ({ id: n.id, name: n.name }));
  const dropAdmin = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 99, key: KEY, creator: A.id, admins: [B.id], members: mem(A, B, D) });
  assert.strictEqual(D._ingest(dropAdmin), 'bad', 'admin tidak bisa menyingkirkan admin lain lewat pembaruan epoch');
  const dropOwner = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 99, key: KEY, creator: A.id, admins: [B.id, C.id], members: mem(B, C, D) });
  assert.strictEqual(D._ingest(dropOwner), 'bad', 'admin tidak bisa menyingkirkan pembuat lewat pembaruan epoch');
  const promote = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 99, key: KEY, creator: A.id, admins: [B.id, C.id, D.id], members: mem(A, B, C, D) });
  assert.strictEqual(D._ingest(promote), 'bad', 'admin tidak bisa mengangkat admin baru');
  const hijack = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 99, key: KEY, creator: B.id, admins: [C.id], members: mem(A, B, C, D) });
  assert.strictEqual(D._ingest(hijack), 'bad', 'pembuat grup tidak bisa diganti');
  const plain = forge(D, C, { gid, name: 'Tim', ts: 1, epoch: 99, key: KEY, creator: A.id, admins: [B.id, C.id], members: mem(A, B, C, D) });
  assert.strictEqual(C._ingest(plain), 'bad', 'anggota biasa tidak berwenang');
  for (const n of [A, B, C, D]) assert.strictEqual(grp(n, gid).epoch, 4);
  ok('batas wewenang admin: tidak bisa mengeluarkan pembuat/admin lain, mengangkat admin, mengganti pembuat; anggota biasa tidak berwenang (tes pemalsuan di sisi penerima)');

  // ---------- ganti nama ----------
  assert.throws(() => D.renameGroup(gid, 'Retas'), /pembuat grup dan admin/);
  assert.throws(() => B.renameGroup(gid, '  \u0001 '), /kosong/);
  B.renameGroup(gid, ' Tim‮ Baru\n ');
  await until(() => [A, B, C, D].every((n) => grp(n, gid).name === 'Tim Baru' && grp(n, gid).epoch === 5), 10000, 'rename');
  for (const n of [A, B, C, D]) assert.strictEqual(grp(n, gid).id, gid, 'id grup tetap');
  assert(note(D, /B mengganti nama grup dari "Tim" menjadi "Tim Baru"/));
  const m5 = D.sendText('pesan setelah ganti nama', G);
  A.renameGroup(gid, 'Tim Pembuat');
  await until(() => [A, B, C, D].every((n) => grp(n, gid).name === 'Tim Pembuat'), 10000, 'rename pembuat');
  await until(() => [A, B, C].every((n) => has(n, 'pesan setelah ganti nama')), 8000, 'msg rename');
  assert.strictEqual(m5.to, G);
  ok('ganti nama oleh admin dan pembuat: nama berubah di semua anggota, id grup tetap, riwayat dan pesan baru tetap jalan, karakter kontrol dibuang');

  // ---------- pembuat mengeluarkan admin; admin menambah anggota ----------
  B.addMembers(gid, [E.id]);
  await until(() => grp(E, gid) && grp(E, gid).members.length === 5, 10000, 'B tambah E');
  assert.strictEqual(grp(E, gid).creator, A.id, 'anggota baru yang diundang admin tetap tahu siapa pembuatnya');
  assert.deepStrictEqual([...grp(E, gid).admins].sort(), [B.id, C.id].sort());
  E.sendText('halo dari E', G);
  await until(() => [A, B, C, D].every((n) => has(n, 'halo dari E')), 8000, 'E kirim');
  assert.throws(() => E.removeMember(gid, D.id), /pembuat grup dan admin/);
  A.removeMember(gid, C.id); // pembuat boleh mengeluarkan admin
  await until(() => !grp(C, gid) && [A, B, D, E].every((n) => !grp(n, gid).members.some((x) => x.id === C.id) && grp(n, gid).admins.length === 1), 10000, 'A kick admin C');
  ok('admin B menambah E (E tahu pembuatnya A dan daftar admin); pembuat boleh mengeluarkan admin C, daftar admin ikut bersih');

  // ---------- dua admin bertindak bersamaan ----------
  A.setAdmin(gid, D.id, true);
  await until(() => [A, B, D, E].every((n) => grp(n, gid).admins.includes(D.id)), 10000, 'D admin');
  const ep0 = grp(A, gid).epoch;
  B.renameGroup(gid, 'Nama dari B');
  const fromB = B.sendText('pesan B sebelum konvergen', G);
  D.renameGroup(gid, 'Nama dari D');
  const fromD = D.sendText('pesan D sebelum konvergen', G);
  await until(() => {
    const ns = [A, B, D, E].map((n) => grp(n, gid));
    return ns.every((g) => g.epoch === ep0 + 1 && g.name === ns[0].name) && [A, B, D, E].every((n) => new Set([A, B, D, E].map((x) => x.store.groups[gid].eps[ep0 + 1].key)).size === 1);
  }, 12000, 'konvergen');
  await until(() => [A, B, D, E].every((n) => has(n, 'pesan B sebelum konvergen') && has(n, 'pesan D sebelum konvergen')), 12000, 'pesan konvergen');
  assert(fromB.id && fromD.id);
  assert([A, B, D, E].some((n) => (n.store.groups[gid].eps[ep0 + 1].alt || []).length >= 1), 'konflik benar-benar terjadi (kunci yang kalah disimpan)');
  E.sendText('E setelah konvergen', G); A.sendText('A setelah konvergen', G);
  await until(() => [A, B, D, E].every((n) => has(n, 'E setelah konvergen') && has(n, 'A setelah konvergen')), 10000, 'sesudah konvergen');
  ok('dua admin mengganti nama di epoch yang sama bersamaan: semua perangkat memilih pemenang yang sama (kunci sama), pesan dari kunci yang kalah tetap terbaca');

  // ---------- bubarkan grup (anggota offline menerimanya saat online lagi) ----------
  const eDir = E.opts.dataDir;
  await E.stop();
  assert.strictEqual(A.disbandGroup(gid), true);
  assert(!grp(A, gid), 'pembuat: grup hilang segera');
  assert.throws(() => A.sendText('x', G), /Grup tidak dikenal/);
  assert.throws(() => A.disbandGroup(gid), /Grup tidak dikenal/);
  await until(() => [B, D].every((n) => !grp(n, gid)), 10000, 'grup bubar di B dan D');
  for (const n of [A, B, D]) assert(!Object.values(n.store.msgs).some((m) => m.to === G), 'riwayat hilang');
  let ev = null; E = new Core({ dataDir: eDir, name: 'E', discovery: false }); E.on('removed', (r) => { ev = r; });
  await E.start();
  assert(grp(E, gid), 'E masih punya grup (belum tahu)');
  await lan(E, A, B, D);
  await until(() => !grp(E, gid), 12000, 'E offline menerima pembubaran');
  assert(ev && ev.disband === true && ev.by === 'A', JSON.stringify(ev));
  assert.strictEqual(A.store.left[gid] >= 1, true);
  // undangan lama tidak menghidupkan grup lagi; pembubaran palsu dari non-pembuat ditolak
  const stale = forge(A, B, { gid, name: 'Zombie', ts: 1, epoch: 1, key: KEY, creator: A.id, admins: [], members: mem(A, B) });
  assert.strictEqual(B._ingest(stale), 'bad');
  assert(!grp(B, gid));
  ok('bubarkan grup: grup + riwayat hilang di semua anggota, anggota yang offline menerimanya saat online lagi (event removed.disband), undangan lama tidak menghidupkannya');

  const g2 = A.createGroup('Kedua', [B.id, D.id]).id;
  await until(() => [B, D].every((n) => grp(n, g2)), 8000, 'g2');
  const fake = forge(B, D, { gid: g2, epoch: 50, removed: true, disband: true, members: mem(B) });
  assert.strictEqual(D._ingest(fake), 'bad');
  assert(grp(D, g2));
  const fakeA = forge(D, B, { gid: g2, epoch: 50, removed: true, disband: true, members: mem(D) });
  assert.strictEqual(B._ingest(fakeA), 'bad');
  ok('pembubaran palsu dari admin/anggota biasa ditolak');

  // ---------- kompatibilitas: payload tanpa creator/admins/ets (pembuat versi lama) ----------
  const old = A._makeMsg(D.id, 'ginv', JSON.stringify({ gid: 'abcdef0123456789', name: 'Lama', members: mem(A, D), key: KEY, ts: 5, epoch: 0 }));
  assert.strictEqual(D._ingest(old), 'new');
  assert.strictEqual(grp(D, 'abcdef0123456789').creator, A.id);
  assert.deepStrictEqual(grp(D, 'abcdef0123456789').admins, []);
  ok('undangan format lama (tanpa creator/admins) tetap diterima; pengirimnya jadi pembuat');

  // ---------- migrasi store lama: grup tanpa admins ----------
  const dDir = D.opts.dataDir;
  await D.stop();
  const sf = path.join(dDir, 'store.json'), st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  for (const g of Object.values(st.groups)) delete g.admins;
  fs.writeFileSync(sf, JSON.stringify(st));
  const D2 = new Core({ dataDir: dDir, name: 'D', discovery: false });
  await D2.start();
  assert(Object.values(D2.store.groups).length >= 2 && Object.values(D2.store.groups).every((g) => Array.isArray(g.admins)));
  ok('store lama tanpa daftar admin dimigrasi (admins = [])');

  for (const n of [A, B, E, D2]) await n.stop();
  console.log(`\nSEMUA TES ADMIN GRUP LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
