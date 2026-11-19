'use strict';
require('./_lang')(); // catatan grup Indonesia (i18n E9a)
// Tes keluar dari grup, pindah pemilik, dan blokir yang memutus pertemanan (v0.9.0). Discovery UDP dimatikan; node dihubungkan manual (mesh).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-leave-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const OPT = { discovery: false, tickMs: 100, syncMs: 300, leaveDelayMs: 50, leaveStaggerMs: 700 };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n }, OPT, o));
const has = (c, text) => c.getState().messages.some((m) => !m.sys && m.text === text);
const stored = (c, text) => Object.values(c.store.msgs).some((m) => m.text === text || (m.kind && c._open(m) === text));
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);
const lan = (c, ...others) => Promise.all(others.map((o) => c.addPeer('127.0.0.1', o.port)));
const note = (c, re) => c.getState().messages.some((m) => m.sys && re.test(m.text));
const forge = (from, to, payload) => from._makeMsg(to.id, 'ginv', JSON.stringify(payload));
const mem = (...ns) => ns.map((n) => ({ id: n.id, name: n.name }));
const KEY = Buffer.alloc(32, 7).toString('base64');
const ids = (c, gid) => grp(c, gid).members.map((x) => x.id).sort();
const same = (a, b) => assert.deepStrictEqual(a, b);

async function mesh(nodes) {
  for (const n of nodes) await n.start();
  for (let i = 0; i < nodes.length; i++) await lan(nodes[i], ...nodes.slice(i + 1));
  await until(() => nodes.every((n) => n.getState().peers.filter((p) => p.online).length === nodes.length - 1), 8000, 'mesh');
}
async function mkGroup(owner, name, others, rest) {
  const gid = owner.createGroup(name, others.map((n) => n.id)).id;
  await until(() => others.every((n) => grp(n, gid)), 8000, 'undangan');
  return gid;
}

(async () => {
  console.log('Archne leave / transfer test, dir: ' + tmp);

  // ================= anggota biasa keluar =================
  {
    const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => mk(n));
    await mesh([A, B, C, D]);
    const gid = await mkGroup(A, 'Tim', [B, C, D]), G = 'g:' + gid;
    A.sendText('riwayat sebelum C keluar', G);
    await until(() => has(C, 'riwayat sebelum C keluar'), 8000, 'riwayat');
    const ep0 = grp(A, gid).epoch;
    const r = C.leaveGroup(gid);
    assert.strictEqual(r.ok, true);
    assert(!grp(C, gid), 'grup hilang segera di perangkat C');
    assert(!Object.values(C.store.msgs).some((m) => m.to === G), 'riwayat C ikut hilang');
    assert.throws(() => C.sendText('x', G), /Grup tidak dikenal/);
    assert.throws(() => C.leaveGroup(gid), /Grup tidak dikenal/);
    await until(() => [A, B, D].every((n) => grp(n, gid).members.length === 3 && !ids(n, gid).includes(C.id)), 10000, 'C dikeluarkan dari daftar');
    assert([A, B, D].every((n) => grp(n, gid).epoch === ep0 + 1), 'tepat satu epoch baru (pemilik yang mengeluarkan)');
    const keys = new Set([A, B, D].map((n) => n.store.groups[gid].eps[ep0 + 1].key));
    assert.strictEqual(keys.size, 1, 'kunci baru sama di semua anggota');
    assert(note(B, /C keluar dari grup/) && !note(B, /C dikeluarkan dari grup oleh/), 'catatan menyebut "keluar", bukan "dikeluarkan"');
    A.sendText('setelah C keluar', G);
    await until(() => has(B, 'setelah C keluar') && has(D, 'setelah C keluar'), 8000, 'pesan baru');
    await sleep(500);
    assert(!stored(C, 'setelah C keluar'), 'C tidak menerima pesan baru');
    B.sendText('B setelah C keluar', G);
    await until(() => has(A, 'B setelah C keluar') && has(D, 'B setelah C keluar'), 8000, 'B ke grup');
    ok('anggota C keluar: grup dan riwayat hilang di C, pemilik mengganti kunci (satu epoch), semua anggota mencatat "C keluar dari grup", C tidak menerima pesan baru, grup tetap jalan');

    // keluar lalu ditambahkan lagi oleh admin: boleh; undangan lama tidak menghidupkan grup
    const stale = forge(A, C, { gid, name: 'Tim', ts: 1, epoch: ep0, key: KEY, creator: A.id, admins: [], members: mem(A, B, C, D) });
    assert.strictEqual(C._ingest(stale), 'bad', 'undangan dari epoch sebelum keluar tidak menghidupkan grup lagi');
    A.addMembers(gid, [C.id]);
    await until(() => grp(C, gid) && grp(C, gid).members.length === 4, 10000, 'C ditambahkan lagi');
    C.sendText('C kembali', G);
    await until(() => [A, B, D].every((n) => has(n, 'C kembali')), 8000, 'C kembali');
    assert(!has(C, 'riwayat sebelum C keluar'), 'riwayat lama tidak kembali');
    ok('undangan basi tidak menghidupkan grup; ditambahkan lagi dengan sengaja tetap bisa dan C tidak mendapat riwayat lama');

    // ================= pemalsuan =================
    const gEp = grp(A, gid).epoch;
    // pernyataan keluar harus ditandatangani orang yang keluar sendiri
    const lvB = { pub: B.pub, ep: gEp, ts: Date.now(), sig: B._signLeave(gid, gEp, Date.now()) };
    const f1 = forge(C, D, { gid, epoch: gEp, leave: true, lv: lvB, members: mem(C) });
    assert.strictEqual(D._ingest(f1), 'bad', 'bukti keluar milik B tidak sah untuk pengirim C');
    const ts2 = Date.now();
    const f2 = forge(C, D, { gid, epoch: gEp, leave: true, lv: { pub: C.pub, ep: gEp, ts: ts2, sig: B._signLeave(gid, gEp, ts2) }, members: mem(C) });
    assert.strictEqual(D._ingest(f2), 'bad', 'tanda tangan orang lain ditolak');
    const f3 = forge(C, D, { gid, epoch: gEp, leave: true, members: mem(C) });
    assert.strictEqual(D._ingest(f3), 'bad', 'tanpa bukti ditolak');
    assert(grp(D, gid).members.some((x) => x.id === C.id) && !(grp(D, gid).leaving || []).length);
    // admin tidak bisa mengeluarkan admin lain dengan bukti palsu
    A.setAdmin(gid, B.id, true); A.setAdmin(gid, C.id, true);
    await until(() => [A, B, C, D].every((n) => grp(n, gid).admins.length === 2), 10000, 'dua admin');
    const e = grp(A, gid).epoch;
    const fakeLv = { pub: C.pub, ep: e, ts: Date.now(), sig: B._signLeave(gid, e, Date.now()) };
    const f4 = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 900, key: KEY, creator: A.id, admins: [B.id], members: mem(A, B, D), lv: [fakeLv] });
    assert.strictEqual(D._ingest(f4), 'bad', 'admin tidak bisa menyingkirkan admin C dengan bukti palsu');
    const f5 = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 900, key: KEY, creator: A.id, admins: [B.id], members: mem(A, B, D) });
    assert.strictEqual(D._ingest(f5), 'bad', 'admin tidak bisa menyingkirkan admin C tanpa bukti');
    // admin tidak bisa memindahkan kepemilikan
    const f6 = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 900, key: KEY, creator: B.id, admins: [C.id], members: mem(A, B, C, D) });
    assert.strictEqual(D._ingest(f6), 'bad', 'admin tidak bisa memindahkan kepemilikan ke dirinya');
    const f7 = forge(A, D, { gid, name: 'Tim', ts: 1, epoch: 900, key: KEY, creator: 'f'.repeat(16), admins: [], members: mem(A, B, C, D) });
    assert.strictEqual(D._ingest(f7), 'bad', 'pemilik baru harus anggota yang ada');
    for (const n of [A, B, C, D]) assert.strictEqual(grp(n, gid).epoch, e);
    ok('pemalsuan ditolak di sisi penerima: bukti keluar orang lain / tanpa tanda tangan, admin menyingkirkan admin tanpa bukti sah, admin memindahkan kepemilikan, pemilik baru bukan anggota');

    // ================= admin keluar dengan admin lain (pemilik offline) =================
    const aDir = A.opts.dataDir;
    await A.stop();
    const epB = grp(B, gid).epoch;
    const proofOld = { pub: C.pub, ep: epB, ts: Date.now(), sig: C._signLeave(gid, epB, Date.now()) }; // bukti keluar yang tidak pernah dikirim C (simulasi bocor): dipakai nanti
    C.leaveGroup(gid);
    await until(() => !grp(B, gid).members.some((x) => x.id === C.id) && !grp(D, gid).members.some((x) => x.id === C.id), 14000, 'admin B mengeluarkan C (pemilik offline)');
    assert.deepStrictEqual(grp(B, gid).admins, [B.id], 'daftar admin ikut bersih');
    assert(note(D, /C keluar dari grup/));
    assert.strictEqual(grp(D, gid).epoch, epB + 1);
    ok('admin C keluar saat pemilik offline: admin lain (B) mengeluarkannya memakai bukti keluar C yang bertanda tangan; D menerima dan menerapkannya');

    // pemilik online lagi: epoch dari B diterima tanpa konflik
    const A2 = new Core({ dataDir: aDir, name: 'A', ...OPT });
    await A2.start(); await lan(A2, B, D);
    await until(() => grp(A2, gid) && grp(A2, gid).epoch === epB + 1 && !ids(A2, gid).includes(C.id), 12000, 'A mengejar');
    assert.deepStrictEqual(grp(A2, gid).admins, [B.id]);
    ok('pemilik yang offline menerima epoch pengeluaran dari admin B setelah online lagi');

    // bukti lama (mis. C pernah keluar, lalu ditambahkan lagi) tidak bisa dipakai ulang
    A2.addMembers(gid, [C.id]);
    await until(() => grp(C, gid) && grp(C, gid).members.length === 4, 10000, 'C kembali lagi');
    A2.setAdmin(gid, C.id, true);
    await until(() => [A2, B, C, D].every((n) => grp(n, gid).admins.includes(C.id)), 10000, 'C admin lagi');
    const eNow = grp(D, gid).epoch;
    const joined = D._joinEpoch(D.store.groups[gid], C.id);
    assert(joined > epB, 'C masuk lagi di epoch yang lebih baru: ' + joined);
    const replay = forge(B, D, { gid, name: 'Tim', ts: 1, epoch: 950, key: KEY, creator: A2.id, admins: [B.id], members: mem(A2, B, D), lv: [{ pub: proofOld.pub, ep: proofOld.ep, ts: proofOld.ts, sig: proofOld.sig }] });
    assert.strictEqual(D._ingest(replay), 'bad', 'bukti keluar lama tidak bisa dipakai ulang setelah C ditambahkan lagi');
    assert.strictEqual(grp(D, gid).epoch, eNow);
    ok('bukti keluar yang basi (sebelum orangnya ditambahkan lagi) tidak bisa dipakai untuk mengeluarkannya');

    for (const n of [A2, B, C, D]) await n.stop();
  }

  // ================= pemilik keluar: kepemilikan pindah otomatis ke admin =================
  {
    const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map((n) => mk(n));
    await mesh([A, B, C, D, E]);
    const gid = await mkGroup(A, 'Bos', [B, C, D, E]), G = 'g:' + gid;
    A.setAdmin(gid, C.id, true);
    await until(() => [A, B, C, D, E].every((n) => grp(n, gid).admins.length === 1), 10000, 'C admin');
    A.setAdmin(gid, B.id, true);
    await until(() => [A, B, C, D, E].every((n) => grp(n, gid).admins.length === 2), 10000, 'B admin');
    assert.deepStrictEqual(grp(A, gid).admins, [C.id, B.id], 'urutan admin = urutan pengangkatan');
    const evs = []; A.on('removed', (x) => evs.push(x));
    A.leaveGroup(gid); // tanpa penerima: otomatis admin tertua = C
    assert(!grp(A, gid), 'grup hilang di perangkat pemilik lama');
    await until(() => [B, C, D, E].every((n) => { const g = grp(n, gid); return g && g.creator === C.id && g.members.length === 4 && !ids(n, gid).includes(A.id); }), 14000, 'kepemilikan pindah ke C dan A keluar');
    for (const n of [B, C, D, E]) assert.deepStrictEqual(grp(n, gid).admins, [B.id], 'C jadi pemilik (bukan admin lagi), B tetap admin');
    assert(note(D, /A menyerahkan kepemilikan grup kepada C/) && note(D, /A keluar dari grup/));
    const keys = new Set([B, C, D, E].map((n) => n.store.groups[gid].eps[grp(n, gid).epoch].key));
    assert.strictEqual(keys.size, 1, 'semua pegang kunci epoch terbaru yang sama');
    C.sendText('pemilik baru C', G); D.sendText('D di grup', G);
    await until(() => [B, E].every((n) => has(n, 'pemilik baru C') && has(n, 'D di grup')), 8000, 'pesan jalan');
    await sleep(300);
    assert(!stored(A, 'pemilik baru C'), 'A tidak menerima pesan baru');
    // pemilik baru benar-benar punya wewenang pemilik
    assert.throws(() => B.setAdmin(gid, D.id, true), /pembuat grup/);
    C.setAdmin(gid, D.id, true);
    await until(() => [B, C, D, E].every((n) => grp(n, gid).admins.includes(D.id)), 10000, 'C angkat D');
    ok('pemilik A keluar tanpa memilih: kepemilikan pindah ke admin tertua (C), A keluar, C tidak lagi tercatat admin, kunci sama, grup jalan, wewenang pemilik ada di C');

    // pemilik baru bisa dikeluarkan/dibubarkan oleh dirinya sendiri; pemilik lama (A) tidak bisa lagi
    const fakeDis = forge(A, D, { gid, epoch: 990, removed: true, disband: true, members: mem(A) });
    assert.strictEqual(D._ingest(fakeDis), 'bad', 'pemilik lama tidak bisa lagi membubarkan');
    ok('pemilik lama kehilangan seluruh wewenang (pembubaran darinya ditolak)');

    // keluar tanpa admin: anggota tertua; dengan penerima pilihan
    const s1 = C.leaveGroup(gid, D.id); // pemilik C memilih D (admin juga)
    assert.strictEqual(s1.ok, true);
    await until(() => [B, D, E].every((n) => { const g = grp(n, gid); return g && g.creator === D.id && !ids(n, gid).includes(C.id) && g.members.length === 3; }), 14000, 'D pemilik');
    assert.throws(() => D.leaveGroup(gid, A.id), /anggota grup/);
    assert.throws(() => D.leaveGroup(gid, D.id), /anggota grup/);
    assert.throws(() => E.leaveGroup('abcdef0123456789').x, /tidak dikenal/);
    ok('pemilik memilih penerima kepemilikan sendiri; penerima di luar grup / diri sendiri ditolak');
    for (const n of [A, B, C, D, E]) await n.stop();
  }

  // ================= pemilik keluar, grup tanpa admin: anggota tertua; pemilik sendirian =================
  {
    const [A, B, C] = ['A', 'B', 'C'].map((n) => mk(n));
    await mesh([A, B, C]);
    const gid = await mkGroup(A, 'Tanpa admin', [B, C]);
    A.leaveGroup(gid);
    await until(() => [B, C].every((n) => { const g = grp(n, gid); return g && g.creator === B.id && g.members.length === 2; }), 14000, 'anggota tertua B jadi pemilik');
    assert.deepStrictEqual(grp(C, gid).admins, []);
    B.leaveGroup(gid);
    await until(() => grp(C, gid) && grp(C, gid).creator === C.id && grp(C, gid).members.length === 1, 14000, 'C sendirian jadi pemilik');
    assert.throws(() => C.leaveGroup(gid), /Bubarkan/);
    assert.strictEqual(C.disbandGroup(gid), true);
    ok('tanpa admin: kepemilikan ke anggota tertua; pemilik yang tinggal sendirian tidak bisa keluar (disarankan membubarkan)');
    for (const n of [A, B, C]) await n.stop();
  }

  // ================= pindah pemilik (tanpa keluar) =================
  {
    const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => mk(n));
    await mesh([A, B, C, D]);
    const gid = await mkGroup(A, 'Serah', [B, C, D]), G = 'g:' + gid;
    A.setAdmin(gid, B.id, true);
    await until(() => [A, B, C, D].every((n) => grp(n, gid).admins.length === 1), 10000, 'B admin');
    assert.throws(() => B.transferOwner(gid, C.id), /pembuat grup/, 'admin tidak bisa memindahkan');
    assert.throws(() => A.transferOwner(gid, A.id), /sudah menjadi pemilik/);
    assert.throws(() => A.transferOwner(gid, 'f'.repeat(16)), /Bukan anggota/);
    A.transferOwner(gid, D.id); // ke anggota biasa
    await until(() => [A, B, C, D].every((n) => grp(n, gid).creator === D.id), 10000, 'D pemilik');
    for (const n of [A, B, C, D]) assert.deepStrictEqual([...grp(n, gid).admins].sort(), [A.id, B.id].sort(), 'pemilik lama jadi admin, admin lama tetap');
    assert(note(C, /A menyerahkan kepemilikan grup kepada D/));
    assert(!note(C, /A menjadi admin grup/), 'tidak ada catatan ganda "menjadi admin" untuk pemilik lama');
    assert.throws(() => A.setAdmin(gid, C.id, true), /pembuat grup/);
    assert.throws(() => A.disbandGroup(gid), /pembuat grup/);
    assert.throws(() => A.transferOwner(gid, C.id), /pembuat grup/);
    A.renameGroup(gid, 'Admin Lama'); // masih admin
    await until(() => [B, C, D].every((n) => grp(n, gid).name === 'Admin Lama'), 10000, 'rename oleh admin lama');
    D.setAdmin(gid, A.id, false); // pemilik baru boleh mencabut admin lama
    await until(() => [A, B, C, D].every((n) => !grp(n, gid).admins.includes(A.id)), 10000, 'D cabut A');
    C.sendText('C ke grup', G); await until(() => [A, B, D].every((n) => has(n, 'C ke grup')), 8000, 'pesan');
    ok('pindah kepemilikan ke anggota biasa: D pemilik, A (pemilik lama) jadi admin lalu bisa dicabut D, wewenang pemilik hilang dari A, grup jalan');

    // pemindahan bertabrakan dengan admin yang mengganti nama di epoch yang sama
    D.setAdmin(gid, B.id, false); D.setAdmin(gid, A.id, true);
    await until(() => [A, B, C, D].every((n) => grp(n, gid).admins.length === 1 && grp(n, gid).admins[0] === A.id), 10000, 'A admin lagi');
    const ep0 = grp(D, gid).epoch;
    D.transferOwner(gid, C.id);
    const sentB = A.renameGroup(gid, 'Rename Admin') && A.sendText('A saat tabrakan', G);
    const sentD = D.sendText('D saat tabrakan', G);
    await until(() => [A, B, C, D].every((n) => grp(n, gid).creator === C.id && grp(n, gid).epoch === ep0 + 1), 14000, 'pemindahan menang di semua');
    const kk = new Set([A, B, C, D].map((n) => n.store.groups[gid].eps[ep0 + 1].key));
    assert.strictEqual(kk.size, 1, 'kunci pemenang sama di semua perangkat');
    assert([A, B, C, D].some((n) => (n.store.groups[gid].eps[ep0 + 1].alt || []).length >= 1), 'tabrakan benar-benar terjadi (kunci yang kalah disimpan)');
    assert([A, B, C, D].every((n) => n.store.groups[gid].eps[ep0 + 1].by === D.id), 'pemenang = epoch pemindahan dari pemilik');
    await until(() => [A, B, C, D].every((n) => has(n, 'A saat tabrakan') && has(n, 'D saat tabrakan')), 14000, 'pesan dari kunci yang kalah tetap terbaca');
    assert(sentB && sentD);
    C.sendText('C setelah tabrakan', G); B.sendText('B setelah tabrakan', G);
    await until(() => [A, B, C, D].every((n) => has(n, 'C setelah tabrakan') && has(n, 'B setelah tabrakan')), 10000, 'setelah tabrakan');
    ok('pemindahan pemilik bertabrakan dengan ganti nama admin di epoch yang sama: pemindahan menang di semua perangkat (kunci sama), pesan dari kunci yang kalah tetap terbaca, perubahan nama admin yang kalah tertimpa');
    for (const n of [A, B, C, D]) await n.stop();
  }

  // ================= kurir: pernyataan keluar sampai ke anggota yang offline lewat peer lain =================
  {
    const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => mk(n));
    await mesh([A, B, C, D]);
    const gid = await mkGroup(A, 'Kurir', [B, C, D]);
    const cDir = C.opts.dataDir;
    await C.stop(); // C offline
    D.leaveGroup(gid);
    await until(() => [A, B].every((n) => Object.values(n.store.custody).some((c) => c.m.to === C.id && c.m.from === D.id)), 12000, 'A dan B membawa pemberitahuan D untuk C');
    assert(!/D keluar|leave/.test(JSON.stringify(A.store.custody)), 'kurir tidak bisa membaca isinya');
    await D.stop(); // pengirim hilang; hanya kurir yang membawa
    await until(() => !grp(A, gid).members.some((x) => x.id === D.id), 12000, 'A mengeluarkan D');
    const C2 = new Core({ dataDir: cDir, name: 'C', ...OPT });
    await C2.start();
    assert(grp(C2, gid).members.some((x) => x.id === D.id), 'C belum tahu D keluar');
    await lan(C2, A, B);
    await until(() => !grp(C2, gid).members.some((x) => x.id === D.id) && grp(C2, gid).epoch === grp(A, gid).epoch, 14000, 'C menerima lewat kurir/epoch');
    A.sendText('A ke C setelah D keluar', 'g:' + gid);
    await until(() => has(C2, 'A ke C setelah D keluar'), 10000, 'C dapat kunci baru');
    ok('kurir: pernyataan keluar D dibawa A dan B (terenkripsi, tak terbaca kurir) untuk C yang offline; D sudah mati tapi C tetap menerima epoch baru dan bisa membaca pesan baru');
    for (const n of [A, B, C2]) await n.stop();
  }

  console.log(`\nSEMUA TES KELUAR GRUP LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
