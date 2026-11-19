'use strict';
require('./_lang')(); // catatan grup Indonesia (i18n E9a)
// Tes tambah / keluarkan anggota grup (v0.3.0). Discovery UDP dimatikan; node dihubungkan manual (mesh).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-mem-'));
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

(async () => {
  console.log('Archne members test, dir: ' + tmp);
  const A = mk('A'), C = mk('C'), D = mk('D');
  let B = mk('B');
  for (const n of [A, B, C, D]) await n.start();
  await lan(A, B, C, D); await lan(B, C, D); await lan(C, D);
  await until(() => [A, B, C, D].every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');

  // ---------- grup epoch 0 ----------
  const gid = A.createGroup('Tim', [B.id, C.id]).id, G = 'g:' + gid;
  await until(() => [B, C].every((n) => grp(n, gid)), 8000, 'undangan');
  const m1 = A.sendText('pesan epoch0', G);
  await until(() => [B, C].every((n) => has(n, 'pesan epoch0')), 8000, 'm1');
  assert.strictEqual(A.store.msgs[m1.id].ep, undefined);
  assert.strictEqual(grp(A, gid).epoch, 0);
  ok('grup baru = epoch 0, pesan tanpa field ep (tetap kompatibel dengan v0.2.0)');

  // ---------- migrasi store v0.2.0 ----------
  const bDir = B.opts.dataDir;
  await B.stop();
  const sf = path.join(bDir, 'store.json'), st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  for (const g of Object.values(st.groups)) { g.key = g.eps[0].key; delete g.eps; delete g.epoch; delete g.removed; }
  delete st.notes;
  fs.writeFileSync(sf, JSON.stringify(st));
  B = new Core({ dataDir: bDir, name: 'B', discovery: false });
  await B.start();
  assert.strictEqual(B.store.groups[gid].epoch, 0);
  assert(B.store.groups[gid].eps[0].key && !B.store.groups[gid].key);
  assert(has(B, 'pesan epoch0'));
  await lan(B, A, C, D);
  const m1b = A.sendText('masih jalan setelah migrasi', G);
  await until(() => has(B, 'masih jalan setelah migrasi') && has(C, 'masih jalan setelah migrasi'), 8000, 'post-migrasi');
  B.sendText('B setelah migrasi', G);
  await until(() => has(A, 'B setelah migrasi'), 8000, 'B kirim');
  ok('store format v0.2.0 dimigrasi otomatis, pesan lama tetap terbaca, grup tetap jalan');

  // ---------- tambah anggota ----------
  assert.throws(() => B.addMembers(gid, [D.id]), /pembuat grup/);
  assert.throws(() => A.addMembers(gid, [B.id]), /anggota baru/);
  A.addMembers(gid, [D.id]);
  await until(() => [A, B, C, D].every((n) => { const g = grp(n, gid); return g && g.epoch === 1 && g.members.length === 4; }), 10000, 'epoch 1');
  ok('tambah anggota: semua (termasuk anggota baru D) pindah ke epoch 1, 4 anggota');

  assert(!has(D, 'pesan epoch0') && !has(D, 'masih jalan setelah migrasi'));
  await D._syncFrom(D.peers.get(A.id));
  await sleep(300);
  assert(!has(D, 'pesan epoch0'));
  assert.deepStrictEqual(Object.keys(D.store.groups[gid].eps), ['1']);
  ok('anggota baru tidak mendapat kunci/riwayat sebelum dia bergabung (sync pun tidak memberi)');

  const m2 = A.sendText('selamat datang D', G);
  await until(() => [B, C, D].every((n) => has(n, 'selamat datang D')), 8000, 'm2');
  D.sendText('halo dari D', G);
  await until(() => [A, B, C].every((n) => has(n, 'halo dari D')), 8000, 'D reply');
  assert.strictEqual(A.store.msgs[m2.id].ep, 1);
  assert(!A.store.msgs[m2.id].text.includes('selamat'));
  ok('pesan epoch 1 (terenkripsi, bertanda ep=1) dua arah antara anggota lama dan baru');
  assert(B.getState().messages.some((m) => m.sys && /D ditambahkan/.test(m.text)));
  ok('catatan sistem "D ditambahkan ke grup" muncul di anggota lain');

  // ---------- bukan admin tidak bisa mengubah anggota ----------
  assert.throws(() => B.removeMember(gid, C.id), /pembuat grup/);
  const evil = B._makeMsg(C.id, 'ginv', JSON.stringify({
    gid, name: 'Tim', ts: 1, epoch: 2, key: Buffer.alloc(32, 7).toString('base64'),
    members: [{ id: A.id, name: 'A' }, { id: B.id, name: 'B' }, { id: C.id, name: 'C' }],
  }));
  assert.strictEqual(C._ingest(evil), 'bad');
  assert.strictEqual(grp(C, gid).epoch, 1);
  ok('undangan perubahan dari non-pembuat grup ditolak (anggota tidak bisa mengeluarkan orang lain)');

  // ---------- keluarkan anggota ----------
  assert.throws(() => A.removeMember(gid, A.id), /tidak bisa dikeluarkan/);
  let removedEv = null; C.on('removed', (r) => { removedEv = r; });
  A.removeMember(gid, C.id);
  await until(() => [A, B, D].every((n) => { const g = grp(n, gid); return g.epoch === 2 && g.members.length === 3; }), 10000, 'epoch 2');
  await until(() => !grp(C, gid), 10000, 'C tahu dikeluarkan');
  assert(removedEv && removedEv.name === 'Tim' && /A/.test(removedEv.by));
  assert(!Object.values(C.store.msgs).some((m) => m.to === G) && !C.getState().messages.some((m) => m.to === G));
  assert(!Object.values(C.store.msgs).some((m) => { try { const j = JSON.parse(C._open(m)); return m.kind === 'ginv' && j.gid === gid && !j.removed; } catch { return false; } }));
  ok('keluarkan anggota: sisa anggota pindah ke epoch 2; grup + riwayat + kunci + undangan terhapus total di perangkat C, C diberi event');

  const m4 = A.sendText('rahasia tanpa C', G);
  await until(() => [B, D].every((n) => has(n, 'rahasia tanpa C')), 8000, 'm4');
  await sleep(1500);
  assert(!has(C, 'rahasia tanpa C'));
  assert(!C.store.groups[gid]);
  const gs4 = A.getState().messages.find((m) => m.id === m4.id).gs;
  assert.deepStrictEqual([gs4.done, gs4.total], [2, 2]);
  ok('C tidak menerima pesan baru dan tidak punya kunci epoch 2; status pengirim 2/2 (C tidak dihitung)');

  assert.throws(() => C.sendText('x', G), /Grup tidak dikenal/);
  // C yang jahat menyimpan sendiri kunci epoch 1 (kunci lama), walau aplikasinya sudah menghapus grup
  C.store.groups[gid] = { id: gid, epoch: 1, eps: { 1: { key: A.store.groups[gid].eps[1].key, members: [] } }, members: [] };
  const spam = C._makeMsg(G, 'g1', 'spam dari C pakai kunci lama', 1);
  delete C.store.groups[gid];
  assert.strictEqual(B._ingest(spam), 'bad');
  assert.strictEqual(D._ingest(spam), 'bad');
  assert.strictEqual(A._ingest(spam), 'bad');
  ok('anggota yang dikeluarkan tidak bisa menulis, termasuk dengan kunci epoch lama');

  await C._syncFrom(C.peers.get(B.id));
  await sleep(300);
  assert(!has(C, 'rahasia tanpa C'));
  ok('sync tidak memberikan pesan ke anggota yang sudah dikeluarkan');

  // ---------- anggota offline saat perubahan, dan masuk kembali ----------
  const bdir2 = B.opts.dataDir;
  await B.stop();
  A.removeMember(gid, D.id); // epoch 3: A, B
  await until(() => !grp(D, gid), 10000, 'D dikeluarkan');
  const m6 = A.sendText('epoch3 saat B mati', G);
  await sleep(300);
  const gs6 = A.getState().messages.find((m) => m.id === m6.id).gs;
  assert.deepStrictEqual([gs6.done, gs6.total], [0, 1]);
  A.addMembers(gid, [C.id]); // epoch 4: A, B, C (C masuk kembali)
  assert.strictEqual(C.store.left[gid], 2);
  await until(() => grp(C, gid) && grp(C, gid).epoch === 4, 10000, 'C kembali');
  assert.strictEqual(C.store.left[gid], undefined);
  C.sendText('C sudah kembali', G);
  await until(() => has(A, 'C sudah kembali'), 8000, 'C kirim');
  assert(!has(C, 'rahasia tanpa C') && !has(C, 'epoch3 saat B mati'));
  await C._syncFrom(C.peers.get(A.id));
  await sleep(300);
  assert(!has(C, 'epoch3 saat B mati') && !has(C, 'rahasia tanpa C'));
  ok('C masuk kembali dengan kunci baru; pesan saat dia dikeluarkan tetap tidak terbaca');

  B = new Core({ dataDir: bdir2, name: 'B', discovery: false });
  await B.start();
  await lan(B, A, C);
  await until(() => { const g = grp(B, gid); return g.epoch === 4 && g.members.length === 3 && !g.removed; }, 15000, 'B kejar epoch');
  await until(() => has(B, 'epoch3 saat B mati') && has(B, 'C sudah kembali'), 15000, 'B kejar pesan');
  assert(!has(D, 'epoch3 saat B mati') && !has(D, 'C sudah kembali'));
  ok('anggota yang offline selama 3 perubahan menerima semua kunci berurutan + pesan yang terlewat; D tetap tidak menerima apa pun');
  assert(!grp(D, gid));

  // ---------- bersihkan chat (lokal) ----------
  A.sendText('publik-1', 'public');
  await until(() => has(B, 'publik-1'), 8000, 'publik-1');
  B.clearChat('public');
  assert(!has(B, 'publik-1') && has(A, 'publik-1'));
  await B._syncFrom(B.peers.get(A.id)); await sleep(400);
  assert(!has(B, 'publik-1'));
  A.sendText('publik-2', 'public');
  await until(() => has(B, 'publik-2'), 8000, 'publik-2');
  assert(!has(B, 'publik-1') && has(A, 'publik-1'));
  ok('clear chat publik: hanya hilang di yang clear, tidak muncul lagi lewat sync, pesan baru tetap masuk');
  A.sendText('rahasia-dm', B.id);
  await until(() => has(B, 'rahasia-dm'), 8000, 'dm');
  B.clearChat(A.id);
  assert(!has(B, 'rahasia-dm') && has(A, 'rahasia-dm'));
  B.clearChat(G);
  assert(!B.getState().messages.some((m) => m.to === G));
  A.sendText('grup-baru', G);
  await until(() => has(B, 'grup-baru'), 8000, 'grup baru');
  assert(!has(B, 'C sudah kembali') && has(A, 'C sudah kembali'));
  ok('clear chat privat & grup (termasuk catatan sistem) bersifat lokal; pesan sesudahnya tetap muncul');
  assert.throws(() => B.clearChat('xyz'), /tidak dikenal/);

  // ---------- batal kirim ----------
  const { DEL } = require('../src/archne-core');
  const t1 = A.sendText('typo publik', 'public');
  await until(() => has(B, 'typo publik') && has(C, 'typo publik'), 8000, 'typo publik');
  A.deleteMessage(t1.id);
  await until(() => !has(A, 'typo publik') && !has(B, 'typo publik') && !has(C, 'typo publik'), 8000, 'batal publik');
  await B._syncFrom(B.peers.get(C.id)); await sleep(300);
  assert(!has(B, 'typo publik'));
  assert(!B.getState().messages.some((m) => m.text.startsWith(DEL)));
  ok('batal kirim publik: hilang di pengirim & penerima, tidak hidup lagi lewat sync, pesan kontrol tidak tampil');
  const t2 = B.sendText('typo grup', G);
  await until(() => has(A, 'typo grup') && has(C, 'typo grup'), 8000, 'typo grup');
  B.deleteMessage(t2.id);
  await until(() => !has(A, 'typo grup') && !has(B, 'typo grup') && !has(C, 'typo grup'), 8000, 'batal grup');
  ok('batal kirim di grup (terenkripsi) hilang di semua anggota');
  const t3 = A.sendText('typo dm', B.id);
  await until(() => has(B, 'typo dm'), 8000, 'typo dm');
  A.deleteMessage(t3.id);
  await until(() => !has(B, 'typo dm') && !has(A, 'typo dm'), 8000, 'batal dm');
  ok('batal kirim pesan privat hilang di kedua sisi');
  assert.throws(() => B.deleteMessage(A.sendText('milik A', 'public').id), /tidak bisa dibatalkan/);
  const mine = A.sendText('punya A asli', 'public');
  await until(() => has(B, 'punya A asli'), 8000, 'asli');
  const forged = B._makeMsg('public', null, DEL + mine.id);
  assert.strictEqual(A._ingest(forged), 'new');
  assert(has(A, 'punya A asli') && B.sendText('x\u0001del:' + mine.id, 'public'));
  const o = A._makeMsg('public', null, 'datang telat'), od = A._makeMsg('public', null, DEL + o.id);
  assert.strictEqual(B._ingest(od), 'new');
  assert.strictEqual(B._ingest(o), 'dup');
  assert(!has(B, 'datang telat'));
  ok('hanya pemilik pesan yang bisa membatalkan; pembatalan yang tiba sebelum pesannya tetap berlaku; teks pengguna tidak bisa menyamar jadi perintah');

  // ---------- undangan yang belum sampai dibatalkan saat anggota dikeluarkan ----------
  const E = mk('E'); await E.start();
  await A.addPeer('127.0.0.1', E.port);
  await until(() => A.getState().peers.find((p) => p.id === E.id && p.secure), 5000, 'A kenal E');
  const eDir = E.opts.dataDir;
  await E.stop();
  const g2 = A.createGroup('Tes2', [E.id]).id;
  const invs = Object.values(A.store.msgs).filter((m) => m.kind === 'ginv' && m.to === E.id);
  assert(invs.length === 1 && A.store.status[invs[0].id] === 'pending');
  A.removeMember(g2, E.id);
  assert.strictEqual(A.store.status[invs[0].id], 'cancelled');
  const bye = Object.values(A.store.msgs).find((m) => m.kind === 'ginv' && m.to === E.id && m.id !== invs[0].id);
  const E2 = new Core({ dataDir: eDir, name: 'E', discovery: false });
  await E2.start();
  await E2.addPeer('127.0.0.1', A.port);
  await until(() => A.store.status[bye.id] === 'rejected', 10000, 'notice ditolak');
  await sleep(500);
  assert.strictEqual(E2.getState().groups.length, 0);
  ok('undangan yang masih tertahan dibatalkan; orang yang dikeluarkan sebelum sempat bergabung tidak pernah menerima kunci');

  console.log(`\nSEMUA TES ANGGOTA LULUS (${pass})`);
  for (const n of [A, B, C, D, E2]) await n.stop();
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });
