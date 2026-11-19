'use strict';
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const mk = (n, extra = {}) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, extra));

(async () => {
  console.log('Archne core test, dir: ' + tmp);
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();

  assert(await A.addPeer('127.0.0.1', B.port)); 
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 5000, 'saling kenal');
  ok('dua peer saling kenal (hello)');

  A.sendText('halo publik dari A');
  await until(() => B.getState().messages.some((m) => m.text === 'halo publik dari A'), 5000, 'public');
  ok('chat publik terkirim ke peer online');

  // pesan privat saat B mati
  const bId = B.id, bDir = B.opts.dataDir;
  await B.stop();
  const pm = A.sendText('rahasia buat B', bId);
  await sleep(300);
  assert.strictEqual(A.getState().messages.find((m) => m.id === pm.id).status, 'pending');
  ok('pesan privat ke peer offline = pending (outbox)');

  // pesan publik saat B mati (B harus kejar ketinggalan lewat sync)
  A.sendText('pesan publik saat B mati');

  // B hidup lagi, identitas sama, port baru
  const B2 = new Core({ dataDir: bDir, name: 'B', discovery: false });
  await B2.start();
  assert.strictEqual(B2.id, bId);
  ok('identitas B tetap sama setelah restart');
  await B2.addPeer('127.0.0.1', A.port);
  await until(() => B2.getState().messages.some((m) => m.text === 'rahasia buat B'), 8000, 'privat delivered');
  await until(() => A.getState().messages.find((m) => m.id === pm.id).status === 'delivered', 8000, 'ack');
  ok('outbox terkirim + ACK setelah B online lagi');
  await until(() => B2.getState().messages.some((m) => m.text === 'pesan publik saat B mati'), 8000, 'sync');
  ok('B mengejar pesan publik yang terlewat (sync)');

  // peer baru C ambil riwayat publik
  const C = mk('C'); await C.start();
  await C.addPeer('127.0.0.1', A.port);
  await until(() => C.getState().messages.some((m) => m.text === 'halo publik dari A'), 8000, 'C sync');
  ok('peer baru mendapat riwayat publik');

  // C tidak boleh melihat pesan privat A->B
  assert(!C.getState().messages.some((m) => m.text === 'rahasia buat B'));
  ok('pesan privat tidak bocor ke peer ketiga');

  // pesan palsu ditolak
  const forged = Object.assign({}, A.sendText('asli'), { text: 'dipalsukan' });
  const before = C.getState().messages.length;
  assert.strictEqual(C._ingest(forged), 'bad');
  assert.strictEqual(C.getState().messages.length, before);
  ok('pesan yang diubah / tanda tangan salah ditolak');

  // duplikat diabaikan
  const real = A.sendText('sekali saja');
  await until(() => C.getState().messages.some((m) => m.id === real.id), 5000, 'dup');
  assert.strictEqual(C._ingest(real), 'dup');
  ok('duplikat diabaikan');

  // ---------- ENKRIPSI ----------
  assert(A.getState().peers.every((p) => p.secure));
  ok('kunci enkripsi peer diterima lewat hello (bertanda tangan)');

  const rawPm = B2.store.msgs[pm.id];
  assert.strictEqual(rawPm.kind, 'e1');
  assert(!rawPm.text.includes('rahasia'));
  assert(!JSON.stringify(A.store.msgs[pm.id]).includes('rahasia'));
  assert.strictEqual(A.getState().messages.find((m) => m.id === pm.id).text, 'rahasia buat B');
  ok('pesan privat tersimpan sebagai ciphertext, tetap terbaca di pengirim & penerima');

  assert.strictEqual(C._open(A.store.msgs[pm.id]), null);
  assert.strictEqual(C._ingest(A.store.msgs[pm.id], true), 'bad'); // langsung ke C: ditolak
  assert(['carried', 'dup'].includes(C._ingest(A.store.msgs[pm.id]))); // lewat sync: hanya dititipkan (kurir)
  assert(!C.getState().messages.some((m) => m.id === pm.id));
  ok('peer ketiga tidak bisa membaca/mendekripsi pesan privat A->B (hanya bisa jadi kurir)');

  const tampered = Object.assign({}, A.store.msgs[pm.id]);
  const raw = Buffer.from(tampered.text, 'base64'); raw[raw.length - 1] ^= 1; tampered.text = raw.toString('base64');
  assert.strictEqual(B2._ingest(tampered), 'bad');
  ok('ciphertext yang diubah ditolak');

  const aBefore = C.peers.get(A.id).port;
  C.noteHello({ id: A.id, name: 'palsu', port: 1, pub: A.pub, xpub: C.xpub, xsig: C.xsig }, '6.6.6.6');
  C.noteHello({ id: A.id, name: 'palsu', port: 1 }, '6.6.6.6');
  assert.strictEqual(C.peers.get(A.id).port, aBefore);
  assert.notStrictEqual(C.peers.get(A.id).ip, '6.6.6.6');
  ok('hello dengan kunci enkripsi palsu / downgrade ditolak');

  // ---------- GRUP ----------
  const D = mk('D'); await D.start();
  await D.addPeer('127.0.0.1', A.port);
  await B2.addPeer('127.0.0.1', C.port); // di LAN asli ini dikerjakan UDP discovery
  const g = A.createGroup('Tim', [B2.id, C.id]);
  await until(() => [B2, C].every((x) => x.getState().groups.some((q) => q.id === g.id)), 8000, 'invite');
  ok('undangan grup (terenkripsi) diterima semua anggota');

  const gm = A.sendText('halo grup', 'g:' + g.id);
  await until(() => [B2, C].every((x) => x.getState().messages.some((m) => m.text === 'halo grup')), 8000, 'gmsg');
  await until(() => A.getState().messages.find((m) => m.id === gm.id).gs.done === 2, 8000, 'gack');
  assert(!A.store.msgs[gm.id].text.includes('halo grup'));
  assert(!A.getState().messages.some((m) => m.text && m.text.includes('"key"')));
  ok('pesan grup terenkripsi, sampai ke semua anggota + ACK per anggota (2/2)');

  assert.strictEqual(D._ingest(A.store.msgs[gm.id], true), 'bad', 'kiriman langsung ke non-anggota ditolak');
  assert.strictEqual(D._ingest(A.store.msgs[gm.id]), 'carried', 'lewat sync: hanya dititipkan tertutup (v0.20.0)');
  assert(!D.store.msgs[gm.id] && D._open(D.store.custody[gm.id].m) === null);
  assert(!D.getState().messages.some((m) => m.text === 'halo grup'));
  ok('non-anggota tidak bisa membaca pesan grup (hanya membawanya sebagai ciphertext tertutup)');

  B2.sendText('balasan dari B', 'g:' + g.id);
  await until(() => [A, C].every((x) => x.getState().messages.some((m) => m.text === 'balasan dari B')), 8000, 'B reply');
  ok('anggota lain bisa membalas ke grup');

  // C mati, A kirim, A mati, C hidup lagi dan hanya kenal B -> dapat lewat sync grup
  const cDir = C.opts.dataDir;
  await C.stop();
  const gm2 = A.sendText('saat C mati', 'g:' + g.id);
  await until(() => B2.getState().messages.some((m) => m.text === 'saat C mati'), 8000, 'B gets');
  await until(() => A.getState().messages.find((m) => m.id === gm2.id).gs.done === 1, 8000, 'partial');
  assert.strictEqual(A.getState().messages.find((m) => m.id === gm2.id).gs.total, 2);
  ok('anggota offline = status tertahan (1/2)');
  await A.stop();
  const C2 = new Core({ dataDir: cDir, name: 'C', discovery: false });
  await C2.start();
  await C2.addPeer('127.0.0.1', B2.port);
  await until(() => C2.getState().messages.some((m) => m.text === 'saat C mati'), 10000, 'group sync');
  ok('anggota yang terlewat mengejar pesan grup lewat anggota lain (sync)');

  console.log(`\nSEMUA TES LULUS (${pass})`);
  await B2.stop(); await C2.stop(); await D.stop();
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });
