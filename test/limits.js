'use strict';
// Tes batas pesan (v0.7.0 tahap 1): 10.000 karakter, tolak (bukan potong), batas sinkronisasi per byte.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core, verifyMsg, MAX_TEXT } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-limits-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o));
const text = (c, id) => { const m = c.getState().messages.find((x) => x.id === id); return m && m.text; };

(async () => {
  const A = mk('A', { tickMs: 100, syncMs: 150 }), B = mk('B', { tickMs: 100, syncMs: 150 });
  await A.start(); await B.start();
  assert.strictEqual(MAX_TEXT, 10000);
  assert.strictEqual(A.getState().limits.maxText, 10000);
  ok('batas teks 10.000 dan terbaca lewat getState().limits');

  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 3000, 'A-B online');

  // ---- 1. tepat 10.000 lolos, 10.001 ditolak tanpa mengirim apa pun ----
  const edge = 'a'.repeat(10000);
  const m1 = A.sendText('  ' + edge + '  \n', 'public'); // spasi di ujung dipangkas, jadi tetap 10.000
  await until(() => text(B, m1.id) === edge, 3000, 'B menerima 10.000 karakter');
  ok('10.000 karakter publik terkirim utuh (spasi ujung tidak dihitung)');

  const before = Object.keys(A.store.msgs).length;
  assert.throws(() => A.sendText('b'.repeat(10001), 'public'), /terlalu panjang.*10\.001.*10\.000/);
  assert.throws(() => A.sendText('b'.repeat(10001), B.id), /terlalu panjang/);
  assert.strictEqual(Object.keys(A.store.msgs).length, before);
  ok('10.001 karakter ditolak dengan pesan jelas, tidak ada yang tersimpan atau terkirim (tidak dipotong diam-diam)');

  // ---- 2. verifikasi di sisi penerima ikut 10.000 ----
  assert(verifyMsg(A._makeMsg('public', null, 'x'.repeat(10000))));
  assert(!verifyMsg(A._makeMsg('public', null, 'x'.repeat(10001))));
  ok('penerima menolak pesan publik 10.001 karakter dari peer yang melanggar, menerima 10.000');

  // ---- 3. DM terenkripsi: huruf non-Latin & emoji (lebih besar di byte) ----
  const cjk = '漢'.repeat(10000);              // 30 KB UTF-8
  const emo = '😀'.repeat(5000);               // 10.000 unit UTF-16, 20 KB UTF-8
  const d1 = A.sendText(cjk, B.id), d2 = A.sendText(emo, B.id);
  await until(() => text(B, d1.id) === cjk && text(B, d2.id) === emo, 4000, 'DM besar sampai');
  assert(verifyMsg(d1) && verifyMsg(d2));
  ok('DM terenkripsi 10.000 karakter (CJK 30 KB, emoji 20 KB) terkirim dan terbaca utuh');

  // grup
  const gId = A.createGroup('G', [B.id]).id;
  await until(() => B.getState().groups.some((g) => g.id === gId), 4000, 'B masuk grup');
  const g1 = A.sendText(cjk, 'g:' + gId);
  await until(() => text(B, g1.id) === cjk, 4000, 'pesan grup besar');
  ok('pesan grup 10.000 karakter CJK terkirim dan terbaca utuh');

  // ---- 4. sinkronisasi dibatasi per byte: 300 pesan x ~30 KB = ~9 MB, tidak muat satu jawaban (8 MB) ----
  await B.stop();
  const C = mk('C', { tickMs: 100, syncMs: 150, pubMsgQuota: Infinity }); // tes ini tentang batas byte JAWABAN sync; kuota simpanan publik (10%/pengirim) diuji di pubquota.js
  await C.start();
  const ids = [];
  for (let i = 0; i < 300; i++) {
    const m = A._makeMsg('public', null, String(i).padStart(4, '0') + '漢'.repeat(9996));
    A.store.msgs[m.id] = m; ids.push(m.id);
  }
  const total = ids.reduce((n, id) => n + Buffer.byteLength(JSON.stringify(A.store.msgs[id])), 0);
  assert(total > 8e6, 'bahan uji cukup besar: ' + total);
  let maxRes = 0, rounds = 0;
  const h0 = A._handle.bind(A);
  A._handle = (o, ip) => { const r = h0(o, ip); if (r && r.t === 'sync_res') { rounds++; maxRes = Math.max(maxRes, Buffer.byteLength(JSON.stringify(r))); } return r; };
  await C.addPeer('127.0.0.1', A.port);
  await A.addPeer('127.0.0.1', C.port);
  await until(() => ids.every((id) => C.store.msgs[id]), 15000, 'C mengejar 300 pesan besar');
  assert(maxRes < 8e6, 'satu jawaban sinkronisasi muat di satu baris: ' + maxRes);
  assert(rounds >= 3, 'butuh beberapa putaran: ' + rounds);
  ok(`${(total / 1e6).toFixed(1)} MB riwayat tersinkron lewat ${rounds} putaran, jawaban terbesar ${(maxRes / 1e6).toFixed(2)} MB (< 8 MB)`);

  console.log(`\nSEMUA TES LULUS (${pass})`);
  await A.stop(); await C.stop();
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });
