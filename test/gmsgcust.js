'use strict';
// Tes titipan pesan grup (v0.20.0, grup 3): non-anggota membawa `g1` sebagai ciphertext tertutup, kelas ketiga dengan kuota sendiri.
//  - banjir pesan grup tidak menggusur state (`ginv`) maupun DM (`e1`)
//  - kuota per pengirim, per grup, total, dan byte; penuh membuang dari grup/pengirim yang paling banyak menitip
//  - TTL pesan grup 14 hari (state tetap 180 hari)
//  - sync melayani peminta, state, DM, lalu pesan grup paling akhir
//  - ujung ke ujung: anggota offline menerima pesan grup lewat kurir non-anggota yang tidak bisa membacanya, saat pengirim sudah mati
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const KC = require('../src/core/archne-constants');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-gmsgcust-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o || {}));
const hex = (n, len) => n.toString(16).padStart(len, '0');
const sender = (i) => hex(i + 1, 16);
const gto = (i) => 'g:' + hex(i + 1, 16);
let seq = 0;
const fake = (kind, from, to, ts, text) => ({ id: hex(++seq, 32), from, to: to || 'a'.repeat(16), kind, ts: ts || Date.now(), text: text || 'x', pub: 'p', sig: 's' });
const count = (c, kind) => Object.values(c.store.custody).filter((x) => x.m.kind === kind).length;
const inGroup = (c, g) => Object.values(c.store.custody).filter((x) => x.m.kind === 'g1' && x.m.to === g).length;
const DAY = 864e5;
// Sejak Step 2b kuota titipan sub dalam BYTE. Pesan tes ber-teks 'x' berongkos U; kuota 1000*U (+ sedikit sisa) = 1000 pesan, per grup 20% = 200, per pengirim 4% = 40: sama dengan batas jumlah lama.
const U = KC.custCost({ text: 'x' }), QG = { custGmsgQuota: 1000 * U + 100 };
const quiet = (c) => { c._kick = () => {}; c._save = () => {}; return c; };

(async () => {
  console.log('Archne group-message custody test, dir: ' + tmp);

  // 1. banjir pesan grup tidak menggusur state dan DM
  const B = quiet(mk('B', QG));
  const st = fake('ginv', sender(0)), dm = fake('e1', sender(1));
  assert.strictEqual(B._carry(st), 'carried'); assert.strictEqual(B._carry(dm), 'carried');
  for (let g = 0; g < 10; g++) for (let s = 0; s < 25; s++) B._carry(fake('g1', sender(10 + g * 25 + s), gto(g)));
  for (let i = 0; i < 400; i++) B._carry(fake('g1', sender(300 + i), gto(20 + (i % 5))));
  assert.strictEqual(count(B, 'g1') <= 1000, true, 'kelas pesan grup dibatasi 1000');
  assert(B.store.custody[st.id] && B.store.custody[dm.id], 'state dan DM selamat dari banjir pesan grup');
  assert.strictEqual(count(B, 'ginv'), 1); assert.strictEqual(count(B, 'e1'), 1);
  ok('banjir pesan grup hanya menggusur pesan grup; state dan DM tetap ada (kuota terpisah)');

  // 2. kuota: per pengirim 40, per grup 200, penuh = adil antar grup, batas byte
  const Q = quiet(mk('Q', QG));
  for (let i = 0; i < 40; i++) assert.strictEqual(Q._carry(fake('g1', sender(0), gto(0))), 'carried');
  assert.strictEqual(Q._carry(fake('g1', sender(0), gto(0))), 'full', 'satu pengirim maksimal 40 pesan grup');
  assert.strictEqual(Q._carry(fake('g1', sender(0), gto(1))), 'full', 'batas per pengirim berlaku lintas grup');
  const R = quiet(mk('R', QG));
  for (let s = 0; s < 6; s++) for (let i = 0; i < 40; i++) R._carry(fake('g1', sender(s), gto(0)));
  assert.strictEqual(inGroup(R, gto(0)), 200, 'satu grup maksimal 200');
  const oldest = fake('g1', sender(50), gto(0), Date.now() - 5 * DAY); R._carry(oldest);
  assert.strictEqual(inGroup(R, gto(0)), 200, 'grup penuh membuang satu, tetap 200');
  // total 1000: grup kecil (30 pesan, paling lama) tidak digusur oleh lima grup besar
  const T = quiet(mk('T', QG));
  for (let i = 0; i < 30; i++) T._carry(fake('g1', sender(100 + i), gto(9)));
  for (const x of Object.values(T.store.custody)) x.at = Date.now() - 12 * DAY;
  for (let g = 0; g < 5; g++) for (let s = 0; s < 5; s++) for (let i = 0; i < 40; i++) T._carry(fake('g1', sender(200 + g * 5 + s), gto(g)));
  assert.strictEqual(count(T, 'g1'), 1000, 'total penuh di 1000');
  const extra = fake('g1', sender(400), gto(8)); assert.strictEqual(T._carry(extra), 'carried');
  assert.strictEqual(count(T, 'g1'), 1000);
  assert.strictEqual(inGroup(T, gto(9)), 30, 'grup kecil tidak digusur walau entrinya paling lama');
  assert(T.store.custody[extra.id], 'grup baru tetap diterima walau penuh');
  // batas byte: pesan besar mengusir yang lama, jumlah byte tidak melewati batas
  const Y = quiet(mk('Y', { custGmsgQuota: 12e6 })), big = 'z'.repeat(40000); // kuota 12 MB, per pengirim 4% = 480 KB (11 pesan besar)
  for (let s = 0; s < 40; s++) for (let i = 0; i < 40; i++) Y._carry(fake('g1', sender(s), gto(s % 8), Date.now(), big));
  const bytes = Object.values(Y.store.custody).reduce((n, x) => n + KC.custCost(x.m), 0);
  assert(bytes <= 12e6 && bytes > 11e6, 'total byte (termasuk overhead) pesan grup <= 12 MB dan benar-benar terisi, ada ' + bytes);
  assert(Y.custUsage().gmsg.used === bytes && Y.custUsage().gmsg.quota === 12e6, 'custUsage cocok');
  ok('kuota pesan grup (byte): 4% per pengirim, 20% per grup, total dibatasi; penuh membuang dari grup terbanyak, grup kecil tetap aman');

  // 3. TTL: pesan grup 14 hari, state 180 hari
  const L = quiet(mk('L'));
  const gOld = fake('g1', sender(0), gto(0)), gNew = fake('g1', sender(1), gto(0)), sOld = fake('ginv', sender(2));
  for (const m of [gOld, gNew, sOld]) L._carry(m);
  L.store.custody[gOld.id].at = Date.now() - 15 * DAY; L.store.custody[sOld.id].at = Date.now() - 100 * DAY;
  L._gc();
  assert(!L.store.custody[gOld.id], 'pesan grup umur 15 hari dibuang');
  assert(L.store.custody[gNew.id] && L.store.custody[sOld.id], 'pesan grup baru dan state 100 hari tetap');
  ok('pesan grup dipegang 14 hari; state tetap 180 hari');

  // 4. sync: peminta, state, DM, lalu pesan grup; pesan grup yang sudah dimiliki peminta (gx) tidak dikirim ulang
  const S = quiet(mk('S')), rid = 'd'.repeat(16), t0 = Date.now() - 50 * 36e5;
  for (let i = 0; i < 400; i++) { const m = fake('g1', sender(i % 20), gto(i % 4), t0 + i); S.store.custody[m.id] = { m, at: Date.now() }; }
  const dms = []; for (let i = 0; i < 100; i++) { const m = fake('e1', sender(40 + i % 10), 'e'.repeat(16), t0 + 1000 + i); dms.push(m); S.store.custody[m.id] = { m, at: Date.now() }; }
  const stn = fake('ginv', sender(60), 'e'.repeat(16), Date.now()); S.store.custody[stn.id] = { m: stn, at: Date.now() };
  const mine = fake('e1', sender(61), rid, Date.now()); S.store.custody[mine.id] = { m: mine, at: Date.now() };
  const r = S._handle({ t: 'sync_req', hi: { id: rid }, have: [], ch: [], rh: [], vh: [] });
  assert.strictEqual(r.cmsgs.length, 300);
  const order = r.cmsgs.map((m) => (m.to === rid ? 0 : m.kind === 'ginv' ? 1 : m.kind === 'e1' ? 2 : 3));
  assert(order.every((v, i) => i === 0 || order[i - 1] <= v), 'urutan: peminta, state, DM, pesan grup');
  assert.strictEqual(r.cmsgs.filter((m) => m.kind === 'e1').length, 101, 'semua DM ikut sebelum pesan grup');
  assert.strictEqual(r.cmsgs.filter((m) => m.kind === 'g1').length, 198, 'pesan grup mengisi sisa tempat');
  const have = r.cmsgs.filter((m) => m.kind === 'g1').map((m) => m.id);
  const r2 = S._handle({ t: 'sync_req', hi: { id: rid }, have: [], ch: [], gx: have, rh: [], vh: [] });
  assert(!r2.cmsgs.some((m) => have.includes(m.id)), 'pesan grup yang sudah dimiliki peminta tidak dikirim ulang');
  ok('sync melayani peminta, state, DM, baru pesan grup; yang sudah dimiliki tidak dikirim ulang');

  // 5. ujung ke ujung: C offline, pengirim A mati, pesan grup tetap sampai lewat D (bukan anggota) yang tidak bisa membacanya
  const A = mk('A'), C = mk('C'), D = mk('D');
  for (const n of [A, C, D]) await n.start();
  await A.addPeer('127.0.0.1', C.port); await A.addPeer('127.0.0.1', D.port); await D.addPeer('127.0.0.1', C.port);
  await until(() => [A, C, D].every((x) => x.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const gid = A.createGroup('Kurir pesan', [C.id]).id;
  await until(() => C.getState().groups.some((g) => g.id === gid), 8000, 'C masuk grup');
  const cDir = C.opts.dataDir;
  await C.stop();
  const secret = 'rahasia-grup-' + Date.now();
  const sent = A.sendGroup ? A.sendGroup(gid, secret) : A._send(secret, 'g:' + gid);
  const mid = sent.id;
  assert(Object.values(A.store.gstatus[mid]).includes('pending'), 'C belum menerima');
  await D._syncFrom(D.peers.get(A.id));
  await until(() => D.store.custody[mid], 8000, 'D membawa pesan grup');
  assert(!D.store.msgs[mid], 'D bukan anggota: tidak menyimpannya sebagai pesan');
  assert.strictEqual(D._open(D.store.custody[mid].m), null, 'D tidak bisa membacanya');
  assert(!JSON.stringify(D.store.custody[mid].m).includes(secret), 'isinya tidak terbaca di D');
  await A.stop();
  const C2 = new Core({ dataDir: cDir, name: 'C', discovery: false }); await C2.start();
  await C2.addPeer('127.0.0.1', D.port);
  await until(() => C2.store.msgs[mid], 15000, 'C menerima pesan grup lewat D');
  assert.strictEqual(C2._open(C2.store.msgs[mid]), secret, 'C membacanya dengan kunci epoch grup');
  ok('anggota yang offline menerima pesan grup lewat kurir non-anggota (tidak bisa membaca) saat pengirimnya sudah mati');
  await D.stop(); await C2.stop();

  // 6. anggota yang punya kunci epoch tidak menitipkan sampah; yang tidak bisa menilai (bukan anggota / kunci belum ada) menitipkan
  const gid6 = 'ab'.repeat(8), grp = (me, key) => ({ id: gid6, name: 'G', creator: me.id, admins: [], removed: false, members: [{ id: me.id, name: 'x' }], epoch: 0, eps: { 0: { key: Buffer.alloc(32, key).toString('base64'), members: [me.id], by: me.id, its: 1, top: 0 } }, leaves: {} });
  const M = mk('M'), X = mk('X'), Z = mk('Z'), K = mk('K');
  for (const n of [M, X, Z, K]) await n.start();
  M.store.groups[gid6] = grp(M, 1); X.store.groups[gid6] = grp(X, 2); K.store.groups[gid6] = grp(K, 3); K.store.groups[gid6].eps = {}; // K tahu grupnya tapi belum punya kunci epoch
  const junk = X._makeMsg('g:' + gid6, 'g1', 'sampah');
  assert.strictEqual(M._ingest(junk), 'bad', 'anggota dengan kunci epoch menolak pesan yang tidak terbuka');
  assert(!M.store.custody[junk.id]);
  assert.strictEqual(Z._ingest(junk), 'carried', 'non-anggota yang tidak bisa menilai membawanya');
  assert.strictEqual(K._ingest(junk), 'carried', 'anggota yang belum punya kunci epoch membawanya');
  assert.strictEqual(M._ingest(junk, true), 'bad'); assert.strictEqual(Z._ingest(junk, true), 'bad', 'kiriman langsung tidak pernah dititipkan');
  for (const n of [M, X, Z, K]) await n.stop();
  ok('anggota yang punya kunci epoch menolak sampah; non-anggota dan anggota tanpa kunci epoch membawanya; kiriman langsung tidak pernah dititipkan');

  // 7. penerima memproses state lebih dulu, walau datang belakangan dalam jawaban sync
  const P = quiet(mk('P')), seen = [];
  P._ingest = (m) => { seen.push(m.kind || 'pub'); return 'dup'; };
  P._request = async () => ({ t: 'sync_res', msgs: [fake(undefined, sender(1), 'public')], gmsgs: [fake('g1', sender(2), gto(0))], cmsgs: [fake('e1', sender(3)), fake('g1', sender(4), gto(0)), fake('ginv', sender(5))], rc: [], rv: [], fr: [], pf: [], pvm: [] });
  await P._syncFrom({ id: sender(9), name: 'x' });
  assert.deepStrictEqual(seen, ['ginv', 'pub', 'g1', 'e1', 'g1'], 'state dulu, lalu publik, pesan grup, dan sisa titipan');
  ok('penerima memproses state lebih dulu, sebelum pesan, dalam satu jawaban sync');

  // 8. pesan grup yang tiba SEBELUM kunci epoch-nya: dititipkan dulu, lalu dibuka otomatis begitu kuncinya datang (tidak tertinggal di titipan)
  const A8 = mk('A8'), K8 = mk('K8');
  await A8.start(); await K8.start();
  await A8.addPeer('127.0.0.1', K8.port); await K8.addPeer('127.0.0.1', A8.port);
  await until(() => A8.peers.get(K8.id) && A8.peers.get(K8.id).xpub, 8000, 'A8 melihat K8');
  const gid8 = A8.createGroup('Telat kunci', [K8.id]).id;
  await until(() => K8.store.groups[gid8], 8000, 'K8 masuk grup');
  await K8.stop(); // offline: tidak menerima apa pun langsung
  A8.renameGroup(gid8, 'Nama baru'); // epoch 1: ginv untuk K8 tertahan
  const late = A8.sendText('pesan di epoch 1', 'g:' + gid8);
  const ginv1 = Object.values(A8.store.msgs).filter((m) => m.kind === 'ginv' && m.to === K8.id).sort((a, b) => b.ts - a.ts)[0];
  assert.strictEqual(late.ep, 1);
  assert.strictEqual(K8._ingest(late), 'carried', 'kunci epoch 1 belum ada: pesan dititipkan dulu');
  assert(K8.store.custody[late.id] && !K8.store.msgs[late.id]);
  assert.strictEqual(K8._ingest(ginv1), 'new', 'undangan epoch 1 diterima');
  assert(!K8.store.custody[late.id], 'titipan dibuka otomatis setelah kuncinya datang');
  assert.strictEqual(K8._open(K8.store.msgs[late.id]), 'pesan di epoch 1', 'dan terbaca sebagai pesan biasa');
  ok('pesan grup yang datang sebelum kunci epoch-nya dibuka otomatis begitu state-nya tiba (tidak tertinggal di titipan)');
  await A8.stop();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
