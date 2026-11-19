'use strict';
// Tes kurir: A kirim DM ke C, C offline, A dan C tidak pernah online bersamaan; B membawa pesannya.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-courier-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const st = (c, id) => (c.getState().messages.find((m) => m.id === id) || {}).status;

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C');
  await A.start(); await B.start(); await C.start();
  // semua saling kenal dulu (supaya A tahu kunci C), lalu C mati
  await A.addPeer('127.0.0.1', B.port); await A.addPeer('127.0.0.1', C.port); await B.addPeer('127.0.0.1', C.port);
  await until(() => [A, B, C].every((x) => x.getState().peers.filter((p) => p.online).length === 2), 5000, 'saling kenal');
  const cId = C.id, cDir = C.opts.dataDir, aId = A.id, aDir = A.opts.dataDir;
  await C.stop();

  const dm = A.sendText('rahasia A untuk C', cId);
  const inv = A.createGroup('Tim', [cId, B.id]);
  await sleep(200);
  assert.strictEqual(st(A, dm.id), 'pending');
  await B._syncFrom(B.peers.get(A.id));
  assert(B.store.custody[dm.id], 'B menyimpan titipan');
  assert(!B.getState().messages.some((m) => m.id === dm.id), 'titipan tidak tampil di B');
  assert(!/rahasia/.test(JSON.stringify(B.store.custody)), 'B tidak melihat isi pesan');
  ok('B menitip DM milik A untuk C; isinya tidak terbaca dan tidak tampil di B');

  // A mati; C hidup lagi dan hanya bertemu B
  await A.stop();
  const C2 = new Core({ dataDir: cDir, name: 'C', discovery: false });
  await C2.start();
  assert.strictEqual(C2.id, cId);
  await C2.addPeer('127.0.0.1', B.port);
  await until(() => C2.getState().messages.some((m) => m.text === 'rahasia A untuk C'), 8000, 'C menerima lewat B');
  ok('C menerima DM A lewat B, padahal A dan C tidak pernah online bersamaan');
  await until(() => !B.store.custody[dm.id], 8000, 'titipan dibuang');
  ok('B membuang titipan setelah penerima mengirim tanda terima');
  assert(C2.store.groups[inv.id], 'C masuk grup lewat undangan titipan');
  ok('undangan grup juga sampai lewat kurir');

  // A hidup lagi, hanya bertemu B: statusnya jadi delivered lewat tanda terima C
  const A2 = new Core({ dataDir: aDir, name: 'A', discovery: false });
  await A2.start();
  assert.strictEqual(st(A2, dm.id), 'pending');
  await A2.addPeer('127.0.0.1', B.port);
  await until(() => st(A2, dm.id) === 'delivered', 8000, 'tanda terima ke A');
  ok('A tahu pesannya sudah sampai (tanda terima C dibawa B), tanpa bertemu C');

  // duplikat: sinkron ulang tidak menggandakan pesan di C
  await C2._syncFrom({ id: B.id, ip: '127.0.0.1', port: B.port, name: 'B' });
  assert.strictEqual(C2.getState().messages.filter((m) => m.text === 'rahasia A untuk C').length, 1);
  ok('tidak ada duplikat');

  // tanda terima palsu ditolak
  assert.strictEqual(A2._addRcpt({ id: 'a'.repeat(32), by: B.id, pub: B.pub, sig: Buffer.alloc(64).toString('base64') }), false);
  ok('tanda terima palsu ditolak');

  // batas titipan per pengirim
  const X = mk('X'); await X.start();
  await X.addPeer('127.0.0.1', C2.port);
  await until(() => X.peers.get(cId) && X.peers.get(cId).xpub, 5000, 'X kenal C');
  let carried = 0;
  const spam = []; for (let i = 0; i < 60; i++) spam.push(X._makeMsg(cId, 'e1', 'spam' + String(i).padStart(2, '0'))); // panjang seragam = ongkos seragam
  const c0 = K.custCost(spam[0]);
  B.opts.custDmQuota = c0 * 500 + 100; // per pengirim = 10% kuota = 50 titipan (limit sekarang dalam byte, Step 2b)
  for (const m of spam) if (B._ingest(m) === 'carried') carried++;
  assert.strictEqual(carried, 50);
  ok('batas titipan per pengirim bekerja (10% kuota byte = 50 titipan)');

  console.log(`\nSEMUA TES KURIR LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
