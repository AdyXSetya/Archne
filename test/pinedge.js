'use strict';
// Tes sematan pesan (v0.20.0, pin3): kasus tepi di Core. Orang yang kublokir (tampilan, pemulihan saat blokir dibuka, DM) dan anggota yang dikeluarkan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const Pins = require('../src/archne-pins');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pinedge-'));
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
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);
const texts = (c, scope) => c.pinList(scope).shared.map((p) => p.text).sort();
const mine = (c, scope) => c.pinList(scope).mine.map((p) => p.text).sort();
const waitCarrier = (c, id) => until(() => c.store.msgs[id], 8000, 'pesan kontrol tiba');

(async () => {
  console.log('Archne pins edge test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D');
  const all = [A, B, C, D];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');
  const gid = A.createGroup('Tim', [B.id, C.id, D.id]).id, G = 'g:' + gid;
  await until(() => [B, C, D].every((n) => grp(n, gid)), 8000, 'undangan');
  A.setAdmin(gid, B.id, true);
  await until(() => all.every((n) => grp(n, gid).epoch === 1), 10000, 'admin B');

  const tA = A.sendText('pesan dari A', G);
  await until(() => all.every((n) => n.getState().messages.some((m) => m.id === tA.id)), 8000, 'pesan tiba');
  B.pinAdd(G, tA.id, true);                       // dipasang B, isinya pesan A
  const pidInfoB = B.pinNote(G, 'info dari B', true);
  A.pinNote(G, 'info dari A', true);
  C.pinAdd(G, tA.id, false);                      // pribadi C: salinan pesan A
  C.pinNote(G, 'catatan C', false);
  await until(() => all.every((n) => n.pinList(G).shared.length === 3), 8000, 'sematan tersebar');
  assert.deepStrictEqual(texts(C, G), ['info dari A', 'info dari B', 'pesan dari A']);
  assert.deepStrictEqual(mine(C, G), ['catatan C', 'pesan dari A']);

  // ---- A. memblokir: sematan yang dipasangnya dan salinan pesannya hilang dari TAMPILANKU; data tetap, anggota lain tidak terpengaruh ----
  C.blockUser(B.id);
  assert.deepStrictEqual(texts(C, G), ['info dari A'], 'sematan pasangan B hilang, termasuk salinan pesan A yang dipasang B');
  assert.deepStrictEqual(texts(D, G), ['info dari A', 'info dari B', 'pesan dari A'], 'anggota lain tidak terpengaruh');
  assert.strictEqual(Object.keys(C.store.pins[G].m).length, 3, 'datanya tetap');
  C.blockUser(A.id);
  assert.deepStrictEqual(texts(C, G), [], 'sematan pasangan A dan salinan pesan A hilang');
  assert.deepStrictEqual(mine(C, G), ['catatan C'], 'sematan pribadi yang menyalin pesan A ikut hilang; catatanku sendiri tetap');
  assert.throws(() => C.pinAdd(G, tA.id, false), /tidak ditemukan/, 'pesan orang yang kublokir tidak bisa disematkan');
  assert.throws(() => C.pinAdd(G, tA.id, true), /tidak ditemukan|admin atau pemilik/);
  C.unblockUser(A.id); C.unblockUser(B.id);
  assert.deepStrictEqual(texts(C, G), ['info dari A', 'info dari B', 'pesan dari A'], 'blokir dibuka: muncul lagi');
  assert.deepStrictEqual(mine(C, G), ['catatan C', 'pesan dari A']);
  ok('memblokir menyembunyikan sematan pasangannya dan salinan pesannya (bersama dan pribadi) di tampilanku saja; hilang blokir, muncul lagi');

  // ---- B. perubahan saat diblokir tersimpan tersembunyi, lalu diterapkan ketika blokir dibuka ----
  C.blockUser(B.id);
  const pidNew = B.pinNote(G, 'dipasang saat diblokir', true);
  B.pinRemove(G, pidInfoB);                       // dilepas saat diblokir
  const carrierB = B.store.pins[G].r[pidNew];
  await waitCarrier(C, carrierB);
  await until(() => [A, D].every((n) => texts(n, G).includes('dipasang saat diblokir') && !texts(n, G).includes('info dari B')), 8000, 'tersebar ke lain');
  assert.deepStrictEqual(texts(C, G), ['info dari A'], 'selama diblokir semua pasangan B tersembunyi dan tidak ada yang baru diterapkan');
  assert(C.store.pins[G].m[pidInfoB] && !C.store.pins[G].m[pidInfoB].del, 'tombstone dari B belum diterapkan di C');
  C.unblockUser(B.id);
  assert(texts(C, G).includes('dipasang saat diblokir'), 'diterapkan dari simpanan saat blokir dibuka');
  assert(!texts(C, G).includes('info dari B'), 'pelepasan juga diterapkan');
  assert.deepStrictEqual(texts(C, G), texts(A, G), 'C kembali sama dengan anggota lain');
  ok('sematan dari admin yang kublokir tidak diterapkan selagi diblokir, tetapi diterapkan dari simpanan saat blokir dibuka (pesannya sudah "dup" di sync)');

  // ---- C. DM: memblokir lawan bicara menyembunyikan sematan bersamanya; tidak bisa menyematkan; pulih saat dibuka ----
  const d1 = A.sendText('alamat gudang', B.id);
  await until(() => B.getState().messages.some((m) => m.id === d1.id), 8000, 'DM tiba');
  A.pinAdd(B.id, d1.id, true);
  await until(() => B.pinList(A.id).shared.length === 1, 8000, 'sematan DM tiba');
  B.pinNote(A.id, 'catatan pribadi B di DM', false);
  B.blockUser(A.id);
  assert.deepStrictEqual(B.pinList(A.id).shared, [], 'sematan bersama dari lawan bicara yang diblokir tersembunyi');
  assert.deepStrictEqual(mine(B, A.id), ['catatan pribadi B di DM'], 'catatan pribadiku sendiri tetap');
  assert.throws(() => B.pinNote(A.id, 'x', true), /memblokir/, 'tidak bisa menyebar ke orang yang kublokir (dan dibatalkan bersih)');
  assert.strictEqual(Object.keys(B.store.pins[A.id].m).length, 1, 'penyebaran gagal tidak meninggalkan sisa');
  B.unblockUser(A.id);
  assert.deepStrictEqual(texts(B, A.id), ['alamat gudang']);
  ok('DM: blokir menyembunyikan sematan bersama, menolak penyebaran tanpa sisa, dan memulihkannya saat dibuka');

  // ---- D. dikeluarkan: perangkat yang dikeluarkan menghapus sematan grup itu; yang lain tetap menyimpan sematan mantan anggota ----
  B.pinNote(G, 'pribadi B di grup', false);
  assert(B.store.pins[G] && B.store.mypins[G]);
  A.removeMember(gid, B.id);
  await until(() => !grp(B, gid), 10000, 'B dikeluarkan');
  assert.strictEqual(B.store.pins[G], undefined); assert.strictEqual(B.store.mypins[G], undefined);
  assert.deepStrictEqual(B.pinList(G), { shared: [], mine: [], canShare: false });
  assert.throws(() => B.pinNote(G, 'masih bisa?', true), /Grup tidak dikenal/);
  await until(() => [A, C, D].every((n) => grp(n, gid).members.length === 3), 10000, 'epoch tanpa B');
  for (const n of [A, C, D]) assert(texts(n, G).includes('dipasang saat diblokir'), 'sematan mantan anggota tetap di anggota lain');
  assert(A.pinList(G).shared.find((p) => p.by === B.id).canRemove, 'admin aktif boleh melepasnya');
  assert(!C.pinList(G).shared.find((p) => p.by === B.id).canRemove, 'member biasa tidak');
  // pesan kontrol atas nama mantan anggota ditolak (bukan peserta lagi)
  const fakeId = Pins.newId(B.id);
  const fake = { id: 'f'.repeat(32), from: B.id, kind: 'g1', to: G };
  const before = JSON.stringify(A.store.pins[G]);
  assert.strictEqual(A._applyPinCtl(fake, [{ id: fakeId, by: B.id, kind: 'note', text: 'dari mantan', from: B.id, name: 'B', at: 1, mid: '', ts: Date.now(), v: 1, del: false }]), 0);
  assert.strictEqual(JSON.stringify(A.store.pins[G]), before, 'tidak ada yang berubah');
  A.pinRemove(G, pidNew);
  await until(() => [A, C, D].every((n) => !texts(n, G).includes('dipasang saat diblokir')), 8000, 'dilepas admin aktif');
  ok('dikeluarkan: sematan grup dihapus di perangkatnya; sematan mantan anggota tetap di yang lain dan bisa dilepas admin aktif; kontrol palsu dari mantan anggota ditolak');

  // ---- E. dimasukkan lagi: sematan yang hidup diumumkan ulang ----
  A.addMembers(gid, [B.id]);
  await until(() => grp(B, gid) && texts(B, G).length === 2, 12000, 'B dapat sematan lagi');
  assert.deepStrictEqual(texts(B, G), texts(A, G));
  assert.deepStrictEqual(mine(B, G), [], 'sematan pribadi lama tidak kembali (hilang bersama grup)');
  assert.strictEqual(B.pinList(G).canShare, false, 'bukan admin lagi');
  ok('dimasukkan kembali: melihat sematan yang hidup, tanpa sematan pribadi lama');

  for (const n of all) await n.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
