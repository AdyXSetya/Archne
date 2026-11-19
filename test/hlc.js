'use strict';
// Tes hybrid logical clock: urutan sebab-akibat tahan jam PC yang meleset.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-hlc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
// skew = selisih jam PC ini terhadap jam sebenarnya (ms)
const mk = (n, skew = 0, o = {}) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false, now: () => Date.now() + skew }, o));
const order = (c, to) => c.getState().messages.filter((m) => m.to === to).map((m) => m.text);

(async () => {
  // 1. ts naik tegas walau dipanggil beruntun dalam milidetik yang sama
  const S = mk('S'); await S.start();
  let prev = 0;
  for (let i = 0; i < 2000; i++) { const t = S._tsNow(); assert(t > prev, 'tidak naik'); prev = t; }
  assert(prev - Date.now() < 5000, 'hanyut terlalu jauh dari jam dinding: ' + (prev - Date.now()));
  ok('ts selalu naik tegas, 2000 pesan beruntun hanya menyimpang sedikit dari jam dinding');
  const m1 = S._send('sama', 'public'), m2 = S._send('sama', 'public'); // _send: melewati anti-spam v0.9.2 (sendText menolak teks kembar); yang diuji di sini hanya ID
  assert.notStrictEqual(m1.id, m2.id);
  ok('dua pesan identik dalam 1 ms tidak lagi bentrok jadi satu (ID berbeda)');

  // 2. jam B terlambat 60 detik; balasan B tetap muncul SETELAH pesan A yang dibalas
  const A = mk('A', 0, { tickMs: 100 }), B = mk('B', -60000, { tickMs: 100 });
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 3000, 'online');
  A.sendText('pertanyaan', 'public');
  await until(() => order(B, 'public').includes('pertanyaan'), 4000, 'B menerima');
  B.sendText('jawaban', 'public');
  await until(() => order(A, 'public').includes('jawaban'), 4000, 'A menerima');
  assert.deepStrictEqual(order(A, 'public'), ['pertanyaan', 'jawaban']);
  assert.deepStrictEqual(order(B, 'public'), ['pertanyaan', 'jawaban']);
  const q = A.getState().messages.find((m) => m.text === 'pertanyaan'), j = A.getState().messages.find((m) => m.text === 'jawaban');
  assert(j.ts > q.ts);
  ok('jam B terlambat 60 dtk: balasan tetap berurutan setelah pesan yang dibalas, di kedua PC');

  // 3. kontrol: tanpa HLC, jam terlambat memang membalik urutan (membuktikan tesnya bermakna)
  const naive = Date.now() - 60000;
  assert(naive < q.ts);
  ok('kontrol: jam mentah B (−60 dtk) memang lebih lama dari pesan A');

  // 4. jam C maju 1 hari (di luar batas): pesan diterima, tapi tidak meracuni jam & urutan peer lain
  const C = mk('C', 86400000, { tickMs: 100 });
  await C.start();
  await C.addPeer('127.0.0.1', A.port);
  await until(() => A.getState().peers.filter((p) => p.online).length === 2, 4000, 'C online');
  const far = C.sendText('dari masa depan', 'public');
  await until(() => order(A, 'public').includes('dari masa depan'), 4000, 'A menerima pesan C');
  assert(A.hlc < Date.now() + 60000, 'jam A diracuni: ' + (A.hlc - Date.now()));
  A.sendText('sesudahnya', 'public');
  const L = order(A, 'public');
  assert(L.indexOf('sesudahnya') > L.indexOf('dari masa depan'), 'urutan: ' + L.join(','));
  const shown = A.getState().messages.find((m) => m.id === far.id).ts;
  assert(shown < Date.now() + 5000, 'ts tampilan memakai waktu kedatangan');
  ok('jam C maju 1 hari: pesan diterima, jam A tidak ikut melompat, urutan & waktu tampil memakai waktu kedatangan');

  // 5. jam yang meleset masih dalam batas (maju 3 menit) ikut menjaga urutan sebab-akibat
  await C.stop();
  const D = mk('D', 180000, { tickMs: 100 }); await D.start();
  await D.addPeer('127.0.0.1', B.port);
  await until(() => B.getState().peers.some((p) => p.id === D.id && p.online), 4000, 'D online');
  D.sendText('dari D maju', 'public');
  await until(() => order(B, 'public').includes('dari D maju'), 4000, 'B menerima D');
  B.sendText('balasan B ke D', 'public');
  const LB = order(B, 'public');
  assert(LB.indexOf('balasan B ke D') > LB.indexOf('dari D maju'));
  ok('jam peer maju 3 menit (dalam batas): balasan dari PC berjam lambat tetap sesudahnya');

  // 6. jam bertahan lewat restart walau jam dinding mundur
  const dir = path.join(tmp, 'R');
  const R1 = new Core({ dataDir: dir, name: 'R', discovery: false, now: () => Date.now() + 120000 });
  await R1.start();
  const t1 = R1.sendText('sebelum restart', 'public').ts;
  await R1.stop();
  const R2 = new Core({ dataDir: dir, name: 'R', discovery: false }); // jam dinding "mundur" 2 menit
  await R2.start();
  const t2 = R2.sendText('sesudah restart', 'public').ts;
  assert(t2 > t1, 'ts mundur setelah restart');
  ok('jam HLC bertahan lewat restart: jam dinding mundur tidak membuat ts mundur');
  await R2.stop();

  // 7. nilai hlc di store yang tidak masuk akal diabaikan; ts tidak sah ditolak
  const dir2 = path.join(tmp, 'T');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'store.json'), JSON.stringify({ hlc: Date.now() + 10 * 864e5 }));
  const T = new Core({ dataDir: dir2, name: 'T', discovery: false }); await T.start();
  assert(T.sendText('x', 'public').ts < Date.now() + 5000);
  ok('nilai hlc 10 hari ke depan di store.json diabaikan');
  const { verifyMsg } = require('../src/archne-core');
  const good = A.sendText('valid', 'public');
  assert(verifyMsg(good));
  for (const bad of ['123', 1.5, -5, 0, NaN, null]) assert(!verifyMsg(Object.assign({}, good, { ts: bad })));
  ok('ts bukan bilangan bulat positif ditolak');
  await T.stop();

  console.log(`\nSEMUA TES HLC LULUS (${pass})`);
  await S.stop(); await A.stop(); await B.stop(); await D.stop();
  process.exit(0);
})().catch((e) => { console.error('\nTES GAGAL: ' + e.stack); process.exit(1); });
