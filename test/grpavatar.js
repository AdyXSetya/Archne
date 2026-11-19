'use strict';
require('./_lang')(); // catatan grup Indonesia (i18n E9a)
// Tes foto grup (v0.26.0): foto grup = STATE grup (payload epoch `ginv`, kelas primer), bukan berkas grup (tawaran berkas / sendFile).
// Discovery UDP dimatikan; node dihubungkan manual (mesh).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { Core } = require('../src/archne-core');
const { isStateMsg } = require('../src/core/archne-constants');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-gav-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);
const avOf = (c, gid) => { const g = grp(c, gid); return g ? g.av : undefined; };
const lan = (c, ...others) => Promise.all(others.map((o) => c.addPeer('127.0.0.1', o.port)));
const note = (c, re) => c.getState().messages.some((m) => m.sys && re.test(m.text));
const forge = (from, to, payload) => from._makeMsg(to.id, 'ginv', JSON.stringify(payload));
const KEY = Buffer.alloc(32, 7).toString('base64');
const URL = (b) => 'data:image/jpeg;base64,' + b;
// JPEG minimal yang sah secara struktur (SOI, SOF0 w x h, SOS, data, EOI), sama dengan test/profile.js.
const jpeg = (w, h, pad = 300) => {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), crypto.randomBytes(pad), Buffer.from([0xff, 0xd9])]).toString('base64');
};

(async () => {
  console.log('Archne group avatar test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
  const all = [A, B, C, D];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');

  const gid = A.createGroup('Tim', [B.id, C.id]).id, G = 'g:' + gid;
  await until(() => [B, C].every((n) => grp(n, gid)), 8000, 'undangan');
  assert.strictEqual(avOf(A, gid), '', 'grup baru tanpa foto: av kosong di state');

  // ---------- pasang foto ----------
  const p1 = jpeg(128, 128);
  assert.throws(() => B.setGroupAvatar(gid, p1), /pembuat grup dan admin/, 'anggota biasa tidak boleh');
  assert.throws(() => A.setGroupAvatar(gid, 'bukan-gambar'), /Foto tidak valid/);
  assert.throws(() => A.setGroupAvatar(gid, jpeg(500, 500)), /Foto tidak valid/, 'dimensi terlalu besar');
  assert.throws(() => A.setGroupAvatar(gid, jpeg(128, 128, 20000)), /Foto tidak valid/, 'terlalu besar');
  assert.throws(() => A.setGroupAvatar(gid, Buffer.from('GIF89a' + 'x'.repeat(300)).toString('base64')), /Foto tidak valid/, 'bukan JPEG');
  assert.throws(() => A.setGroupAvatar('0000000000000000', p1), /Grup tidak dikenal/);
  assert.strictEqual(grp(A, gid).epoch, 0, 'penolakan tidak membuat epoch');
  A.setGroupAvatar(gid, 'data:image/jpeg;base64,' + p1); // boleh berawalan data URL
  await until(() => [A, B, C].every((n) => avOf(n, gid) === URL(p1)), 10000, 'foto sampai');
  assert([A, B, C].every((n) => grp(n, gid).epoch === 1), 'foto = epoch baru, sama seperti mengganti nama');
  assert(note(B, /A mengganti foto grup/) && note(A, /A mengganti foto grup/), 'catatan sistem');
  ok('pembuat memasang foto grup: semua anggota menerimanya di state (data URL), catatan sistem; anggota biasa, foto rusak/besar/bukan JPEG ditolak tanpa epoch');

  // ---------- primer, bukan berkas ----------
  const carriers = Object.values(A.store.msgs).filter((m) => m.kind === 'ginv' && m.from === A.id && m.to === B.id);
  assert(carriers.length >= 2 && carriers.every(isStateMsg), 'pembawanya ginv = kelas primer');
  assert.strictEqual(Object.values(A.store.msgs).filter((m) => m.to === G && m.kind === 'g1').length, 0, 'tidak ada pesan g1 (berkas/obrolan) yang dibuat');
  assert(!A.getState().messages.some((m) => m.file || m.offer), 'tidak ada tawaran berkas di chat');
  assert.deepStrictEqual(Object.keys(A.getState().avatars), [], 'tidak bercampur dengan foto profil');
  ok('foto grup dibawa payload epoch `ginv` (state primer, ditanggung kurir sampai ada tanda terima), bukan tawaran berkas atau pesan chat');

  // ---------- sama = tidak ada epoch ----------
  A.setGroupAvatar(gid, p1);
  assert.strictEqual(grp(A, gid).epoch, 1, 'foto yang sama tidak membuat epoch baru');
  ok('memasang foto yang sama tidak membuat epoch baru');

  // ---------- admin boleh mengganti ----------
  A.setAdmin(gid, B.id, true);
  await until(() => [A, B, C].every((n) => grp(n, gid).epoch === 2 && grp(n, gid).admins.includes(B.id)), 10000, 'admin B');
  assert.strictEqual(avOf(C, gid), URL(p1), 'epoch lain (admin) tetap membawa foto');
  const p2 = jpeg(100, 100);
  B.setGroupAvatar(gid, p2);
  await until(() => [A, B, C].every((n) => avOf(n, gid) === URL(p2)), 10000, 'foto B sampai');
  assert(note(C, /B mengganti foto grup/));
  ok('epoch lain (jadikan admin) tidak menghapus foto; admin B bisa mengganti foto dan semua menerimanya');

  // ---------- anggota baru mendapat foto lewat ginv undangan ----------
  A.addMembers(gid, [D.id]);
  await until(() => grp(D, gid) && avOf(D, gid) === URL(p2), 10000, 'D dapat foto');
  ok('anggota baru langsung menerima foto grup terkini bersama undangannya');

  // ---------- ganti nama tidak menghapus foto ----------
  A.renameGroup(gid, 'Tim Baru');
  await until(() => [A, B, C, D].every((n) => grp(n, gid).name === 'Tim Baru'), 10000, 'rename');
  assert([A, B, C, D].every((n) => avOf(n, gid) === URL(p2)), 'ganti nama tidak menghapus foto');
  ok('mengganti nama grup tidak menghapus foto');

  // ---------- pemalsuan ----------
  const mem = [A, B, C, D].map((c) => ({ id: c.id, name: c.name }));
  const evil = jpeg(64, 64);
  const g0 = grp(D, gid), ep = g0.epoch + 1;
  const base = { gid, name: 'Tim Baru', ts: 1, epoch: ep, key: KEY, creator: A.id, admins: [B.id], members: mem };
  assert.strictEqual(D._ingest(forge(C, D, Object.assign({}, base, { av: evil }))), 'bad', 'anggota biasa tidak bisa mengubah foto lewat epoch palsu');
  assert.strictEqual(avOf(D, gid), URL(p2));
  // foto tidak valid dari admin sah: epoch tetap diterima (kunci tidak boleh hilang), fotonya diabaikan
  const bad = D._ingest(forge(B, D, Object.assign({}, base, { av: jpeg(900, 900) })));
  assert.strictEqual(bad, 'new', 'epoch sah dengan foto rusak tetap diterima');
  assert.strictEqual(avOf(D, gid), URL(p2), 'foto rusak diabaikan, foto lama tetap');
  // pengirim versi lama (tanpa kolom av): foto tidak berubah
  const old = D._ingest(forge(B, D, Object.assign({}, base, { epoch: ep + 1, key: Buffer.alloc(32, 8).toString('base64') })));
  assert.strictEqual(old, 'new');
  assert.strictEqual(avOf(D, gid), URL(p2), 'epoch tanpa av (versi lama) tidak menghapus foto');
  ok('pemalsuan: anggota biasa ditolak; foto rusak dari admin diabaikan tanpa menolak epoch; epoch tanpa kolom av tidak menghapus foto');

  // ---------- hapus foto ----------
  const A2 = A; // epoch dari D sudah maju lewat pemalsuan hanya di D; A tetap pemilik
  A2.setGroupAvatar(gid, '');
  await until(() => [A, B, C].every((n) => avOf(n, gid) === ''), 10000, 'foto dihapus');
  assert(note(B, /A menghapus foto grup/));
  assert.strictEqual(grp(A, gid).epoch, grp(B, gid).epoch);
  ok('admin menghapus foto: kembali ke huruf pertama di semua anggota, catatan sistem');

  // ---------- tetap ada setelah restart ----------
  A.setGroupAvatar(gid, p1);
  await until(() => [B, C].every((n) => avOf(n, gid) === URL(p1)), 10000, 'foto lagi');
  await A.stop();
  const A3 = new Core({ dataDir: path.join(tmp, 'A'), name: 'A', discovery: false });
  await A3.start();
  assert.strictEqual(avOf(A3, gid), URL(p1), 'foto grup tersimpan di store');
  ok('foto grup tetap ada setelah restart');

  // ---------- grup yang terlalu besar tidak merusak epoch ----------
  {
    const g = A3.store.groups[gid];
    const before = g.epoch, bigMembers = [];
    for (let i = 0; i < 700; i++) bigMembers.push({ id: crypto.randomBytes(8).toString('hex'), name: 'n'.repeat(40) });
    const saveM = g.members; g.members = saveM.concat(bigMembers);
    assert.throws(() => A3.setGroupAvatar(gid, jpeg(128, 128, 5000)), /terlalu besar/);
    assert.strictEqual(g.epoch, before, 'galat sebelum epoch dibuat: tidak ada yang berubah');
    assert.strictEqual(g.av, p1);
    assert(JSON.parse(A3._newEpoch(g, g.members)).av === undefined, 'epoch lain melewati foto bila tidak muat (muatan tetap sah)');
    g.epoch = before; delete g.eps[before + 1]; g.members = saveM;
    ok('grup terlalu besar: setGroupAvatar menolak sebelum membuat epoch, epoch lain melewati foto supaya ginv tidak melebihi batas');
  }

  await Promise.all([A3, B, C, D].map((c) => c.stop()));
  console.log('\n' + pass + ' kelompok tes lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
