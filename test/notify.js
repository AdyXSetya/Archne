'use strict';
// Tes notifikasi (v0.11.0): aturan bisu per chat. Bawaan: publik mati, DM dan grup menyala; bisa ditimpa per chat dan bertahan lewat restart.
// Pesan sendiri, pesan lama (sinkronisasi riwayat), dan orang yang diblokir tidak memicu notifikasi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-ntf-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });

(async () => {
  console.log('Archne notify test, dir: ' + tmp);
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'mesh');

  const got = [];
  A.on('message', (m) => got.push(m));
  const next = async (n) => { await until(() => got.length >= n, 8000, 'pesan ke-' + n); return got[n - 1]; };

  // bawaan
  assert.strictEqual(A.notifyOn('public'), false);
  assert.strictEqual(A.notifyOn(B.id), true);
  assert.strictEqual(A.notifyOn('g:' + 'a'.repeat(16)), true);
  B.sendText('halo publik', 'public');
  const pub = await next(1);
  assert.strictEqual(A.notifyOf(pub), null, 'publik: mati bawaan');
  B.sendText('halo DM', A.id);
  const dm = await next(2);
  const nd = A.notifyOf(dm);
  assert(nd && nd.key === B.id && nd.title === 'B' && nd.text === 'halo DM', 'DM: menyala bawaan, judul = pengirim');
  ok('bawaan: publik mati, DM menyala dengan judul dan isi yang benar');

  // grup
  const gid = B.createGroup('Tim', [A.id]).id, G = 'g:' + gid;
  await until(() => A.getState().groups.some((g) => g.id === gid), 8000, 'grup tiba');
  const before = got.length;
  B.sendText('rapat jam 3', G);
  const gm = await next(before + 1);
  const ng = A.notifyOf(gm);
  assert(ng && ng.key === G && ng.title === 'Tim · B' && ng.text === 'rapat jam 3', 'grup: menyala bawaan, judul = grup · pengirim');
  ok('grup: menyala bawaan, judul "grup · pengirim"');

  // timpa
  A.setNotify(B.id, false);
  assert.strictEqual(A.notifyOf(dm), null, 'DM dibisukan');
  A.setNotify('public', true);
  const np = A.notifyOf(pub);
  assert(np && np.key === 'public' && np.title === 'Publik · B', 'publik dinyalakan');
  A.setNotify(G, false);
  assert.strictEqual(A.notifyOf(gm), null, 'grup dibisukan');
  assert.deepStrictEqual(A.getState().notif, { [B.id]: false, public: true, [G]: false });
  A.setNotify(B.id, true); // sama dengan bawaan: tidak disimpan
  assert(!(B.id in A.getState().notif), 'nilai yang sama dengan bawaan dihapus dari catatan');
  A.setNotify('public', null);
  assert.strictEqual(A.notifyOn('public'), false, 'null = kembali ke bawaan');
  assert.throws(() => A.setNotify('bukan-kunci', true), /tidak valid/);
  assert.throws(() => A.setNotify('g:xyz', true), /tidak valid/);
  ok('timpa per chat, kembali ke bawaan, kunci tidak valid ditolak');

  // bertahan lewat restart
  A.setNotify(G, false);
  await A.stop();
  const A2 = mk('A'); await A2.start();
  assert.strictEqual(A2.notifyOn(G), false, 'pengaturan bertahan setelah restart');
  assert.strictEqual(A2.notifyOn(B.id), true);
  ok('pengaturan bertahan lewat restart');

  // pesan sendiri, lama, terblokir, berkas, balasan
  assert.strictEqual(A2.notifyOf({ id: 'x', from: A2.id, to: 'public', ts: Date.now(), text: 'aku', name: 'A' }), null, 'pesan sendiri');
  A2.setNotify('public', true);
  assert.strictEqual(A2.notifyOf(Object.assign({}, pub, { ts: Date.now() - 2 * 3600e3, id: 'old' })), null, 'pesan lama (sinkronisasi) tidak memicu notifikasi');
  A2.store.rx = {};
  ok('pesan sendiri dan pesan lama tidak memicu notifikasi');

  for (const n of [A2, B]) await n.stop();
  console.log(`\n${pass} tes notifikasi OK`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
