'use strict';
// Tes video tahap 4 (Core asli): undangan ke panggilan grup membawa penanda video; tanpa penanda tetap seperti semula.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cvi-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, callRingMs: 3000, callConnMs: 3000 });
const rec = (c) => { const ev = []; c.on('call', (e) => ev.push(e)); return ev; };
const of = (ev, name) => ev.filter((e) => e.ev === name);
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

(async () => {
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map(mk), all = [A, B, C, D];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await Promise.all(all.slice(i + 1).map((x) => all[i].addPeer('127.0.0.1', x.port)));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 3), 8000, 'mesh');
  const ec = rec(C), ed = rec(D);
  const cid = A.callStart(B.id, 'SDP-A');
  await until(() => B.getState().call && B.getState().call.state === 'ringing', 5000, 'B berdering');
  B.callAnswer(cid, 'SDP-B');
  await until(() => A.getState().call.state === 'connecting', 5000, 'A connecting');
  A.callConnected(cid); B.callConnected(cid);

  // undangan video: penanda ikut ke event dan ke snapshot (UI yang baru terpasang)
  A.callInvite(cid, C.id, true);
  await until(() => of(ec, 'invited').length === 1, 5000, 'C menerima undangan');
  assert.strictEqual(of(ec, 'invited')[0].video, true);
  assert.strictEqual(C.getState().call.video, true, 'snapshot undangan memuat video');
  ok('undangan video: event dan snapshot membawa video: true');

  // undangan suara: tidak ada medan video sama sekali (bentuk lama tidak berubah)
  A.callInvite(cid, D.id);
  await until(() => of(ed, 'invited').length === 1, 5000, 'D menerima undangan');
  assert(!('video' in of(ed, 'invited')[0]), 'event suara tanpa medan video');
  assert(!('video' in D.getState().call), 'snapshot suara tanpa medan video');
  ok('undangan suara tetap tanpa penanda');

  for (const n of all) await n.stop();
  console.log('\ncallvideoinv: ' + pass + ' OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
