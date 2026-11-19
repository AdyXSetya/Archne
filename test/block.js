'use strict';
// Tes blokir user (v0.8.0): hanya berlaku di perangkat yang memblokir, pihak yang diblokir tidak diberi tahu.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-blk-'));
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
const stored = (c, text) => Object.values(c.store.msgs).some((m) => m.text === text || (m.kind && c._open(m) === text));
const grp = (c, gid) => c.getState().groups.find((g) => g.id === gid);
const lan = (c, ...others) => Promise.all(others.map((o) => c.addPeer('127.0.0.1', o.port)));
const mem = (...ns) => ns.map((n) => ({ id: n.id, name: n.name }));

(async () => {
  console.log('Archne block test, dir: ' + tmp);
  const A = mk('A'), B = mk('B'), C = mk('C');
  let D = mk('D');
  const all = [A, B, C, D];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await lan(all[i], ...all.slice(i + 1));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');

  // bahan: pesan publik sebelum blokir, grup A+B+C (dibuat C), pertemanan A<->B
  B.sendText('publik B lama', 'public');
  await until(() => has(A, 'publik B lama') && has(C, 'publik B lama'), 8000, 'pub lama');
  const gid = C.createGroup('Rame', [A.id, B.id]).id, G = 'g:' + gid;
  await until(() => [A, B].every((n) => grp(n, gid)), 8000, 'grup');
  B.sendText('grup B lama', G);
  await until(() => has(A, 'grup B lama'), 8000, 'grup lama');
  A.addFriend(B.id); B.addFriend(A.id);
  await until(() => A.fstate(B.id) === 'ok' && B.fstate(A.id) === 'ok', 8000, 'teman');
  A.sendText('dm lama A ke B', B.id);
  await until(() => has(B, 'dm lama A ke B'), 8000, 'dm lama');
  B.sendText('dm lama B ke A', A.id);
  await until(() => has(A, 'dm lama B ke A'), 8000, 'dm lama 2');
  A.setBio('bio rahasia A');

  // ---------- memblokir ----------
  assert.throws(() => A.blockUser(A.id), /tidak valid/);
  assert.throws(() => A.blockUser('xyz'), /tidak valid/);
  let msgEv = 0; A.on('message', () => { msgEv++; });
  assert.strictEqual(A.blockUser(B.id), true);
  assert.strictEqual(A.blockUser(B.id), true, 'idempoten');
  let st = A.getState();
  assert(A.isBlocked(B.id) && st.blocked.length === 1 && st.blocked[0].id === B.id && st.blocked[0].name === 'B');
  assert(!st.peers.some((p) => p.id === B.id), 'hilang dari daftar user/teman');
  assert(!has(A, 'publik B lama') && !has(A, 'grup B lama') && !has(A, 'dm lama B ke A') && !has(A, 'dm lama A ke B'), 'semua pesan dan chat privat dengannya disembunyikan');
  assert(!(B.id in st.bios) && !(B.id in st.avatars), 'bio/foto tidak ikut');
  assert(has(C, 'publik B lama') && has(B, 'dm lama A ke B'), 'orang lain dan B sendiri tidak terpengaruh');
  assert.strictEqual(A.fstate(B.id), '', 'pertemanan putus di sisi A');
  await until(() => B.fstate(A.id) === '', 8000, 'B menerima pemutusan pertemanan');
  assert(!B.getState().peers.find((p) => p.id === A.id).friend, 'B juga tidak lagi menganggap A teman');
  assert(!A.store.blocked[B.id].fdl, 'pemberitahuan putus teman sudah terkirim (sekali)');
  assert(!B.isBlocked(A.id) && !('blocked' in B.getState().peers.find((p) => p.id === A.id)), 'B tidak diberi tanda apa pun bahwa dia diblokir');
  assert(grp(A, gid).members.some((x) => x.id === B.id), 'tetap anggota grup (data grup utuh; UI yang menyembunyikan)');
  ok('blokir: B hilang dari daftar user/teman, semua pesannya (publik, grup, privat) dan chat privat disembunyikan, bio/foto tidak ikut, pertemanan putus di DUA sisi (B menerima pemutusan biasa, bukan kabar diblokir)');

  // ---------- pesan baru dari B ----------
  B.sendText('publik B baru', 'public');
  const dm = B.sendText('dm B baru ke A', A.id);
  B.sendText('grup B baru', G);
  const fr = B.sendText('tolong terima', A.id);
  B.addFriend(A.id);
  await until(() => has(C, 'publik B baru') && has(C, 'grup B baru'), 8000, 'C menerima');
  await until(() => B.getState().messages.find((m) => m.id === dm.id).status === 'delivered', 8000, 'B melihat terkirim');
  await sleep(500);
  assert(!has(A, 'publik B baru') && !has(A, 'grup B baru'), 'publik/grup tidak tampil');
  assert(!stored(A, 'dm B baru ke A') && !stored(A, 'tolong terima'), 'DM tidak disimpan sama sekali');
  assert.strictEqual(A.fstate(B.id), '', 'permintaan teman dari B diabaikan');
  assert.strictEqual(msgEv, 0, 'tidak ada notifikasi pesan baru');
  await until(() => B.getState().messages.find((m) => m.id === fr.id).status === 'delivered', 8000, 'B melihat terkirim (permintaan/DM kedua)'); // diblokir diam-diam: B tetap melihat "terkirim"
  assert(!stored(A, 'tolong terima'));
  ok('pesan baru B: publik/grup tidak tampil, DM dan permintaan teman dibuang diam-diam, tanpa notifikasi; B tetap melihat "terkirim"');

  // ---------- A tidak mengirim apa pun ke B ----------
  assert.throws(() => A.sendText('x', B.id), /memblokir/);
  assert.throws(() => A.addFriend(B.id), /memblokir/);
  assert.throws(() => A.createGroup('Baru', [B.id]), /memblokir/);
  const g3 = A.createGroup('A dan C', [C.id]).id;
  assert.throws(() => A.addMembers(g3, [B.id]), /memblokir/);
  const gm = A.sendText('grup A ke B C', G);
  await until(() => has(C, 'grup A ke B C'), 8000, 'C dapat');
  await until(() => A.getState().messages.find((m) => m.id === gm.id).gs.done === 1, 8000, 'status 1/1');
  const gs = A.getState().messages.find((m) => m.id === gm.id).gs;
  assert.deepStrictEqual([gs.done, gs.total], [1, 1], 'penerima langsung hanya C (B tidak dihitung)');
  assert.strictEqual(A.store.gstatus[gm.id][B.id], undefined);
  ok('A tidak bisa DM, mengajak berteman, atau mengundang B; pesan grup A tidak dikirim langsung ke B');

  // ---------- A tidak melayani B ----------
  const sync = A._handle({ t: 'sync_req', hi: B.hello(), have: [], gh: { [gid]: [] }, ch: [], rh: [], vh: [], eq: [], pv: {} }, '127.0.0.1');
  assert.strictEqual(sync.t, 'sync_res');
  for (const k of ['msgs', 'gmsgs', 'cmsgs', 'rc', 'rv', 'eh', 'fr', 'pf']) assert.deepStrictEqual(sync[k], [], k);
  const sync2 = A._handle({ t: 'sync_req', hi: C.hello(), have: [], gh: { [gid]: [] }, ch: [], rh: [], vh: [], eq: [], pv: {} }, '127.0.0.1');
  assert(sync2.msgs.length > 0 && sync2.pf.length > 0, 'peer lain tetap dilayani');
  const esc = A._handle({ t: 'esc_q', hi: B.hello(), id: 'a'.repeat(32), psize: 10 }, '127.0.0.1');
  assert.deepStrictEqual([esc.ok, esc.err], [false, 'denied']);
  assert.strictEqual(await A._syncFrom(A.peers.get(B.id)), true);
  assert.strictEqual(await A._flushOutbox(A.peers.get(B.id)), undefined);
  ok('sync/esc dari B dijawab kosong/ditolak (tanpa pesan, profil, titipan); A tidak menarik apa pun dari B');

  // ---------- berkas ----------
  const f = path.join(tmp, 'rahasia.txt'); fs.writeFileSync(f, 'isi berkas '.repeat(100));
  const offerB = await B.sendFile(f, 'public');
  await until(() => !!A.store.msgs[offerB.id], 8000, 'tawaran B sampai di store A (disembunyikan)');
  assert(!A.getState().messages.some((m) => m.id === offerB.id), 'tawaran B tidak tampil');
  await assert.rejects(A.receiveFile(offerB.id), /blokir/);
  const offerA = await A.sendFile(f, 'public');
  await sleep(300);
  assert(!B.store.msgs[offerA.id], 'pesan publik A tidak didorong langsung ke B');
  assert.strictEqual(B._ingest(offerA), 'new'); // seandainya B memperolehnya lewat peer lain (sync)
  await assert.rejects(B.receiveFile(offerA.id), (e) => { assert(e); return true; });
  assert(!B.store.got[offerA.id], 'B tidak mendapat berkas A');
  const ctl = []; const sock = { end: (x) => ctl.push(x), destroy() {}, write() {}, on() {}, pause() {}, resume() {}, removeListener() {} };
  A._serveFile(sock, { t: 'file_get', id: offerA.id, off: 0, hi: B.hello() }, '127.0.0.1');
  assert(ctl.length && /denied/.test(ctl.join('')), 'unduhan langsung dari B ditolak: ' + ctl.join('|'));
  ok('berkas: tawaran B tidak bisa diterima A; B tidak bisa mengunduh berkas A (ditolak "denied")');

  // ---------- pembaruan kunci dari pembuat grup yang diblokir tetap diterima; undangan baru tidak ----------
  A.blockUser(C.id); // C = pembuat grup "Rame"
  C.addMembers(gid, [D.id]);
  await until(() => grp(D, gid) && grp(A, gid).epoch === 1 && grp(A, gid).members.length === 4, 10000, 'A tetap menerima epoch baru dari C');
  C.sendText('grup C setelah blok', G);
  await sleep(600);
  assert(!has(A, 'grup C setelah blok'), 'pesan C disembunyikan');
  D.sendText('D ke grup', G);
  await until(() => has(A, 'D ke grup') && has(C, 'D ke grup'), 10000, 'A tetap dapat pesan D (kunci baru)');
  const g4 = C.createGroup('Undangan baru', [A.id, D.id]).id;
  await until(() => grp(D, g4), 8000, 'D dapat undangan');
  await sleep(600);
  assert(!grp(A, g4), 'undangan grup BARU dari orang yang diblokir dibuang');
  ok('kunci grup baru dari pembuat yang diblokir tetap diterima (A tidak kehilangan akses), tapi pesannya disembunyikan dan undangan grup baru darinya dibuang');
  A.unblockUser(C.id);

  // ---------- DM tertahan dibatalkan saat blokir ----------
  A.addFriend(D.id); D.addFriend(A.id);
  await until(() => A.fstate(D.id) === 'ok' && D.fstate(A.id) === 'ok', 8000, 'teman A-D');
  const dDir = D.opts.dataDir;
  await D.stop();
  const pend = A.sendText('untuk D yang offline', D.id);
  assert.strictEqual(A.store.status[pend.id], 'pending');
  A.blockUser(D.id);
  assert.strictEqual(A.store.status[pend.id], 'cancelled');
  assert(A.store.blocked[D.id].fdl && A.store.status[A.store.blocked[D.id].fdl] === 'pending', 'pemutusan pertemanan menunggu D online');
  D = new Core({ dataDir: dDir, name: 'D', discovery: false }); await D.start();
  assert.strictEqual(D.fstate(A.id), 'ok', 'D belum tahu');
  await lan(D, A, B, C);
  await until(() => D.fstate(A.id) === '', 12000, 'D menerima pemutusan pertemanan setelah online lagi');
  await until(() => !A.store.blocked[D.id].fdl, 8000, 'fdl selesai');
  await sleep(800);
  assert(!has(D, 'untuk D yang offline') && !stored(D, 'untuk D yang offline'));
  assert.strictEqual(Object.values(A.store.msgs).filter((m) => m.to === D.id && A.store.status[m.id] === 'pending').length, 0);
  ok('DM yang masih tertahan untuk orang yang diblokir dibatalkan, tidak terkirim belakangan; pemutusan pertemanan menunggu dia online lalu terkirim sekali saja (tanpa membawa DM lain)');

  // ---------- buka blokir + bertahan setelah restart ----------
  const aDir = A.opts.dataDir;
  await A.stop();
  const A2 = new Core({ dataDir: aDir, name: 'A', discovery: false }); await A2.start();
  assert(A2.isBlocked(B.id) && A2.isBlocked(D.id) && !A2.isBlocked(C.id), 'daftar blokir tersimpan');
  await lan(A2, B, C, D);
  assert(!A2.getState().peers.some((p) => p.id === B.id));
  assert.strictEqual(A2.unblockUser(B.id), true);
  assert.strictEqual(A2.unblockUser(B.id), false);
  const s2 = A2.getState();
  assert(s2.peers.some((p) => p.id === B.id) && s2.blocked.length === 1 && s2.blocked[0].id === D.id);
  assert(has(A2, 'publik B lama') && has(A2, 'dm lama B ke A'), 'riwayat tampil lagi');
  assert.strictEqual(A2.fstate(B.id), '', 'pertemanan tidak otomatis kembali');
  A2.sendText('halo lagi B', B.id);
  await until(() => has(B, 'halo lagi B'), 8000, 'DM jalan lagi');
  B.sendText('balas A', A2.id);
  await until(() => has(A2, 'balas A'), 8000, 'B bisa DM lagi');
  ok('daftar blokir bertahan setelah restart; buka blokir mengembalikan daftar dan riwayat, DM dua arah jalan lagi, pertemanan tidak otomatis kembali');

  for (const n of [A2, B, C, D]) await n.stop();
  console.log(`\nSEMUA TES BLOKIR LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
