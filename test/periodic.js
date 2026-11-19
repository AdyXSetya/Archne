'use strict';
// Tes sinkronisasi berkala: pesan yang terlewat dikejar tanpa peer harus offline/online lagi.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-periodic-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o));
const has = (c, t) => c.getState().messages.some((m) => m.text === t);

(async () => {
  // ---- 1. pesan terlewat dikejar oleh sync berkala ----
  const A = mk('A', { syncMs: 400, tickMs: 100 }), B = mk('B', { syncMs: 400, tickMs: 100 }), X = mk('X', { discovery: false });
  await A.start(); await B.start(); await X.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 3000, 'A-B online');
  await sleep(300); // sync awal selesai

  const m = X.sendText('pesan terlewat', 'public');
  assert.strictEqual(A._ingest(m), 'new'); // A punya, tapi tidak mendorongnya ke B (mirip pesan yang gagal terkirim)
  assert(!has(B, 'pesan terlewat'));
  await until(() => has(B, 'pesan terlewat'), 4000, 'periodic catch-up');
  ok('pesan yang terlewat dikejar sync berkala, padahal A-B tidak offline/online ulang');

  // ---- 2. titipan kurir sampai ke B lewat sync berkala (tanpa _syncFrom manual) ----
  await X.stop();
  const C = mk('C', { syncMs: 400, tickMs: 100 });
  await C.start();
  await A.addPeer('127.0.0.1', C.port); await B.addPeer('127.0.0.1', C.port);
  await until(() => [A, B, C].every((x) => x.getState().peers.filter((p) => p.online).length === 2), 5000, 'saling kenal');
  const cId = C.id; await C.stop();
  const dm = A.sendText('rahasia A untuk C', cId);
  await until(() => B.store.custody[dm.id], 4000, 'B menitip lewat sync berkala');
  assert(!B.getState().messages.some((m) => m.id === dm.id));
  ok('DM untuk peer offline sampai ke kurir B lewat sync berkala, tidak tampil di B');
  await A.stop(); await B.stop();

  // ---- 3. interval panjang: tidak ada sync ekstra ----
  const P = mk('P', { tickMs: 100, syncMs: 60000 }), Q = mk('Q', { tickMs: 100, syncMs: 60000 });
  await P.start(); await Q.start();
  let calls = 0; const orig = P._syncFrom.bind(P); P._syncFrom = (p) => { calls++; return orig(p); };
  await P.addPeer('127.0.0.1', Q.port);
  await until(() => P.getState().peers.some((p) => p.online), 3000, 'P-Q online');
  await sleep(1500);
  assert(calls <= 2, 'sync awal saja, bukan tiap tick: ' + calls);
  ok(`interval 60 dtk: tidak ada sync ekstra di tiap tick (${calls}x total)`);

  // ---- 4. tidak tumpang tindih saat sync lambat ----
  const R = mk('R', { tickMs: 50, syncMs: 100 }), S = mk('S', { tickMs: 50, syncMs: 100 });
  await R.start(); await S.start();
  await R.addPeer('127.0.0.1', S.port);
  await until(() => R.getState().peers.some((p) => p.online), 3000, 'R-S online');
  await sleep(300);
  let active = 0, maxActive = 0, total = 0;
  const o2 = R._syncFrom.bind(R);
  R._syncFrom = async (p) => { total++; active++; maxActive = Math.max(maxActive, active); await sleep(400); try { return await o2(p); } finally { active--; } };
  await sleep(2000);
  assert(total >= 2, 'sync berkala berjalan: ' + total);
  assert.strictEqual(maxActive, 1);
  ok(`sync lambat tidak menumpuk (maks ${maxActive} bersamaan, ${total}x jalan)`);

  // ---- 5. gagal -> dicoba lagi lebih cepat ----
  let fails = 0;
  R._syncFrom = async () => { fails++; return false; };
  const t0 = fails; await sleep(1500);
  assert(fails - t0 >= 2, 'retry setelah gagal: ' + (fails - t0));
  ok('sync gagal dicoba lagi tanpa menunggu interval penuh');

  console.log(`\nSEMUA TES LULUS (${pass})`);
  await P.stop(); await Q.stop(); await R.stop(); await S.stop();
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });
