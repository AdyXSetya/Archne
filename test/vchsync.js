'use strict';
// Tes channel voice grup (v0.19.0, langkah 2): penyebaran lewat pesan kontrol g1 tersembunyi, validasi di penerima, konvergensi, anggota baru.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Vc = require('../src/archne-vchan');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vchs-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const lan = (c, ...o) => Promise.all(o.map((x) => c.addPeer('127.0.0.1', x.port)));
const names = (c, gid) => c.vcList(gid).map((x) => x.name).sort();
const forge = (from, gid, recs) => from._makeMsg('g:' + gid, 'g1', Vc.encodeCtl(recs));
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);

// ---- A. aturan konvergensi (murni, tanpa jaringan) ----
{
  const OWN = 'a'.repeat(16), M1 = 'c'.repeat(16), M2 = 'd'.repeat(16), CID = '1'.repeat(16);
  const mkG = () => ({ id: '9'.repeat(16), creator: OWN, admins: [], removed: false, members: [OWN, M1, M2].map((x) => ({ id: x, name: x[0] })), vch: {} });
  const base = { id: CID, name: 'x', by: M1, locked: false, allow: [], ts: 1, v: 1, del: false };
  const u2 = Object.assign({}, base, { name: 'dua', v: 2, ts: 5 });
  const u2b = Object.assign({}, base, { name: 'dua-b', v: 2, ts: 6 });
  const d2 = Object.assign({}, base, { v: 2, ts: 4, del: true });
  const run = (order) => { const g = mkG(); for (const r of order) Vc.applyRemote(g, r.by, r); return JSON.stringify(g.vch); };
  // semua urutan datang menghasilkan keadaan akhir yang sama
  const perms = (a) => a.length < 2 ? [a] : a.flatMap((x, i) => perms(a.filter((_, j) => j !== i)).map((p) => [x].concat(p)));
  const sets = [[base, u2, u2b], [base, u2, d2], [base, u2b, d2, u2]];
  for (const set of sets) {
    const res = new Set(perms(set).map(run));
    assert.strictEqual(res.size, 1, 'konvergen untuk semua urutan: ' + set.map((r) => r.name + r.v).join(','));
  }
  assert.strictEqual(JSON.parse(run([base, u2, d2]))[CID].del, true, 'hapus menang atas ubah di versi yang sama');
  // tombstone final
  const g = mkG(); Vc.applyRemote(g, M1, d2);
  assert.strictEqual(Vc.applyRemote(g, M1, Object.assign({}, base, { v: 9, ts: 99 })), 'stale');
  assert.strictEqual(g.vch[CID].del, true);
  // tidak berhak
  const g2 = mkG(); Vc.applyRemote(g2, M1, base);
  assert.strictEqual(Vc.applyRemote(g2, M2, Object.assign({}, u2, { name: 'bajak' })), 'reject', 'member lain tidak boleh mengubah');
  assert.strictEqual(Vc.applyRemote(g2, OWN, Object.assign({}, u2, { by: OWN })), 'reject', 'pembuat tidak boleh diganti');
  assert.strictEqual(Vc.applyRemote(g2, 'e'.repeat(16), u2), 'reject', 'bukan anggota');
  assert.strictEqual(Vc.applyRemote(mkG(), M2, base), 'reject', 'memperkenalkan channel atas nama orang lain');
  assert.strictEqual(Vc.applyRemote(g2, OWN, u2), 'applied', 'pemilik grup boleh mengubah milik member');
  assert.strictEqual(Vc.applyRemote(g2, OWN, u2), 'stale', 'rekaman yang sama dua kali');
  assert.strictEqual(Vc.applyRemote(mkG(), OWN, base), 'applied', 'pemilik grup mengumumkan ulang milik member');
  assert.strictEqual(Vc.parseCtl('halo'), null); assert.deepStrictEqual(Vc.parseCtl(Vc.CTL + '{rusak'), []);
  assert.deepStrictEqual(Vc.parseCtl(Vc.CTL + '{"a":1}'), []);
  ok('aturan terima: konvergen di semua urutan, hapus menang dan final, hanya yang berhak, pengumuman ulang oleh pemilik/admin');
}

(async () => {
  console.log('Archne vchan sync test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), E = mk('E');
  const all = [A, B, C, D, E];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 4), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id, D.id]).id;
  await until(() => [B, C, D].every((n) => grp(n, gid)), 8000, 'undangan');
  A.setAdmin(gid, B.id, true);
  await until(() => [A, B, C, D].every((n) => grp(n, gid).epoch === 1), 10000, 'admin B');
  const members = [A, B, C, D];

  // ---- B. buat: C membuat, semua melihat; pesan kontrol tidak tampil di chat ----
  const seen = []; for (const n of [A, B, D]) n.on('message', (m) => seen.push(m));
  const ccid = C.vcCreate(gid, 'Santai', false);
  await until(() => [A, B, D].every((n) => names(n, gid).join() === 'Santai'), 8000, 'sync create');
  assert.strictEqual(A.vcList(gid)[0].by, C.id);
  assert(D.vcList(gid)[0].canJoin && !D.vcList(gid)[0].canManage, 'D bisa masuk, tidak bisa mengelola');
  assert(B.vcList(gid)[0].canManage, 'admin bisa mengelola milik C');
  for (const n of members) assert(!n.getState().messages.some((m) => String(m.text).includes('vch:') || String(m.text).includes('Santai')), 'tidak tampil di chat');
  assert.strictEqual(seen.length, 0, 'tidak memicu notifikasi pesan');
  const ctlMsg = Object.values(A.store.msgs).find((m) => m.kind === 'g1' && A._vcCtl(m));
  assert(ctlMsg, 'tersimpan sebagai pesan g1 (ikut sinkron/titip)');
  assert.throws(() => A.sendText('balas', 'g:' + gid, ctlMsg.id), /tidak ditemukan/, 'tidak bisa dibalas');
  ok('C membuat channel: A, B, D melihatnya; tersembunyi dari chat, tanpa notifikasi, tidak bisa dibalas');

  // ---- C. ubah dan kunci; izin sama di semua node ----
  C.vcUpdate(gid, ccid, { name: 'Rapat', locked: true, allow: [D.id] });
  await until(() => [A, B, D].every((n) => names(n, gid).join() === 'Rapat'), 8000, 'sync update');
  for (const n of [A, B, C, D]) { assert.strictEqual(n.vcCanJoin(gid, ccid, D.id), true); assert.strictEqual(n.vcCanJoin(gid, ccid, B.id), true, 'admin'); }
  A.vcUpdate(gid, ccid, { allow: [] });
  await until(() => [B, C, D].every((n) => n.vcCanJoin(gid, ccid, D.id) === false), 8000, 'pemilik grup cabut izin');
  assert.throws(() => D.vcUpdate(gid, ccid, { name: 'bajak' }), /pembuat channel atau admin/);
  ok('pembuat mengubah dan mengunci, pemilik grup mencabut izin: semua node sepakat siapa yang boleh masuk');

  // ---- D. tempaan: pesan sah-tanda-tangan tapi tidak berhak ditolak penerima ----
  const live = Object.assign({}, A.store.groups[gid].vch[ccid]);
  const hijack = forge(D, gid, [Object.assign({}, live, { v: live.v + 1, ts: live.ts + 10, del: true })]);
  assert.strictEqual(A._ingest(hijack), 'new'); // pesannya sah dan tersimpan, tetapi isinya tidak diterapkan
  assert.strictEqual(names(A, gid).join(), 'Rapat', 'member biasa tidak bisa menghapus milik orang lain');
  const fake = forge(D, gid, [{ id: 'f'.repeat(16), name: 'Palsu', by: C.id, locked: false, allow: [], ts: 1, v: 1, del: false }]);
  assert.strictEqual(A._ingest(fake), 'new');
  assert.strictEqual(names(A, gid).join(), 'Rapat', 'member tidak bisa memperkenalkan channel atas nama orang lain');
  const X = mk('X'); await X.start(); // bukan anggota grup: pesannya ditolak _allowed
  X.store.groups[gid] = { id: gid, name: 'Tim', creator: X.id, admins: [], removed: false, members: [{ id: X.id, name: 'X' }], epoch: 0, eps: { 0: { key: Buffer.alloc(32, 1).toString('base64'), members: [X.id], by: X.id, its: 1, top: 0 } }, leaves: {} };
  assert.strictEqual(A._ingest(forge(X, gid, [{ id: 'e'.repeat(16), name: 'x', by: X.id, locked: false, allow: [], ts: 1, v: 1, del: false }])), 'bad');
  await X.stop();
  ok('tempaan ditolak penerima: hapus oleh member lain, channel atas nama orang lain, dan pengirim bukan anggota');

  // ---- E. hapus oleh admin; pesan lama telat tidak menghidupkan lagi ----
  B.vcDelete(gid, ccid);
  await until(() => [A, C, D].every((n) => names(n, gid).length === 0), 8000, 'sync delete');
  const late = forge(C, gid, [Object.assign({}, live, { v: 50, ts: live.ts + 1000, name: 'Hidup lagi' })]);
  for (const n of [A, B, D]) { n._ingest(Object.assign({}, late)); assert.strictEqual(names(n, gid).length, 0, 'tombstone final'); }
  ok('admin menghapus milik C: semua node; pesan lama/datang terlambat tidak menghidupkannya lagi');

  // ---- F. gagal kirim: perubahan lokal dibatalkan ----
  const cid2 = C.vcCreate(gid, 'Dua', false);
  await until(() => [A, B, D].every((n) => names(n, gid).join() === 'Dua'), 8000, 'sync 2');
  const eps = C.store.groups[gid].eps; C.store.groups[gid].eps = {};
  assert.throws(() => C.vcCreate(gid, 'Gagal', false), /Kunci enkripsi/);
  assert.throws(() => C.vcDelete(gid, cid2), /Kunci enkripsi/);
  C.store.groups[gid].eps = eps;
  assert.deepStrictEqual(names(C, gid), ['Dua'], 'tidak ada perubahan setengah jalan');
  ok('kirim gagal: perubahan lokal dibatalkan (tidak menyimpang dari anggota lain)');

  // ---- G. anggota baru mendapat daftar channel lewat pengumuman ulang admin ----
  C.vcCreate(gid, 'Tiga', true, [D.id]);
  await until(() => [A, B, D].every((n) => names(n, gid).join() === 'Dua,Tiga'), 8000, 'sync 3');
  A.addMembers(gid, [E.id]);
  await until(() => grp(E, gid) && names(E, gid).join() === 'Dua,Tiga', 10000, 'E dapat daftar');
  assert.strictEqual(E.vcCanJoin(gid, E.vcList(gid).find((x) => x.name === 'Tiga').id, E.id), false, 'E tidak diizinkan ke channel terkunci');
  assert.strictEqual(E.vcCanJoin(gid, E.vcList(gid).find((x) => x.name === 'Dua').id, E.id), true);
  ok('anggota baru E langsung melihat channel yang ada (dengan izin yang benar)');

  // ---- H. bertahan setelah restart ----
  const dirB = path.join(tmp, 'B'); B._saveNow(); await B.stop();
  const B2 = new Core({ dataDir: dirB, name: 'B', discovery: false }); await B2.start();
  assert.deepStrictEqual(names(B2, gid), ['Dua', 'Tiga']);
  await B2.stop();
  ok('daftar channel hasil sinkron selamat setelah restart');

  for (const n of [A, C, D, E]) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
