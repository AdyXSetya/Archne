'use strict';
// Tes kelas titipan kurir (v0.20.0, grup 1+2): state grup (`ginv`) dan pesan DM (`e1`) punya kuota sendiri-sendiri.
//  - banjir DM tidak menggusur state; state penuh membuang secara adil (pengirim yang paling banyak menitip)
//  - state dipegang sampai 180 hari (pesan DM tetap 14 hari)
//  - sync melayani state dulu sebelum pesan, walau pesan lebih lama dan jumlahnya banyak
//  - ujung ke ujung: anggota yang offline lebih dari 14 hari tetap mendapat undangan grup lewat kurir
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { STATE_MAX, STATE_PER_SENDER, custCost } = require('../src/core/archne-constants');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-statecust-'));
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
let seq = 0;
const fake = (kind, from, to, ts) => ({ id: hex(++seq, 32), from, to: to || 'a'.repeat(16), kind, ts: ts || Date.now(), text: 'x', pub: 'p', sig: 's' });
const count = (c, kind) => Object.values(c.store.custody).filter((x) => x.m.kind === kind).length;
const DAY = 864e5;

(async () => {
  console.log('Archne state custody test, dir: ' + tmp);
  const B = mk('B'); // kurir; tidak perlu start: _carry hanya menyentuh store
  B.opts.custDmQuota = 500 * custCost({ text: 'x' }) + 100; // titipan DM kini dibatasi byte (Step 2b): kuota setara 500 pesan uji, per pengirim 10% = 50
  B._kick = () => {}; B._save = () => {};

  // 1. banjir DM tidak menggusur state
  const g1 = fake('ginv', sender(0)); assert.strictEqual(B._carry(g1), 'carried');
  for (let s = 1; s <= 10; s++) for (let i = 0; i < 50; i++) B._carry(fake('e1', sender(s)));
  assert.strictEqual(count(B, 'e1'), 500, 'kelas pesan penuh di 500');
  for (let i = 0; i < 300; i++) B._carry(fake('e1', sender(11 + (i % 6))));
  assert(B.store.custody[g1.id], 'state selamat dari banjir DM, walau pesan terus menggusur pesan lama');
  assert.strictEqual(count(B, 'e1'), 500);
  ok('banjir DM hanya menggusur DM; undangan/pembaruan grup tetap ada (kuota terpisah)');

  // 2. kuota per pengirim dan total state; penuh = adil
  const S = mk('S'); S._kick = () => {}; S._save = () => {};
  for (let i = 0; i < STATE_PER_SENDER; i++) assert.strictEqual(S._carry(fake('ginv', sender(0), 'b'.repeat(16))), 'carried');
  assert.strictEqual(S._carry(fake('ginv', sender(0), 'b'.repeat(16))), 'full', 'satu pengirim maksimal STATE_PER_SENDER state');
  // pengirim kecil (100 entri) memegang entri PALING LAMA; tiga pengirim besar memegang sisanya. Yang digusur harus dari pengirim besar, bukan yang terlama.
  for (const x of Object.values(S.store.custody)) x.at = Date.now() - 10 * DAY; // sender(0): STATE_PER_SENDER entri
  for (let i = 0; i < 100; i++) S._carry(fake('ginv', sender(4), 'b'.repeat(16)));
  for (const x of Object.values(S.store.custody)) if (x.m.from === sender(4)) x.at = Date.now() - 20 * DAY; // paling lama
  const BIG = [0, 1, 2, 3]; // pengirim besar: masing-masing STATE_PER_SENDER; pengirim 5 mengisi sisanya sampai STATE_MAX (lebih sedikit dari yang besar)
  for (const k of BIG.slice(1)) for (let i = 0; i < STATE_PER_SENDER; i++) S._carry(fake('ginv', sender(k), 'b'.repeat(16)));
  while (count(S, 'ginv') < STATE_MAX) S._carry(fake('ginv', sender(5), 'b'.repeat(16)));
  const oldest4 = Math.min(...Object.values(S.store.custody).map((x) => x.at));
  assert(Object.values(S.store.custody).some((x) => x.m.from === sender(4) && x.at === oldest4), 'entri terlama milik pengirim kecil');
  assert.strictEqual(count(S, 'ginv'), STATE_MAX, 'state penuh di STATE_MAX');
  const bySender = (c, f) => Object.values(c.store.custody).filter((x) => x.m.from === f).length;
  const small = fake('ginv', sender(9), 'c'.repeat(16));
  assert.strictEqual(S._carry(small), 'carried', 'pengirim baru tetap diterima walau state penuh');
  assert(S.store.custody[small.id]); assert.strictEqual(count(S, 'ginv'), STATE_MAX);
  assert.strictEqual(bySender(S, sender(4)), 100, 'pengirim kecil tidak digusur walau entrinya paling lama');
  assert.strictEqual(BIG.filter((k) => bySender(S, sender(k)) === STATE_PER_SENDER - 1).length, 1, 'yang digusur satu entri dari pengirim terbanyak');
  assert.strictEqual(count(S, 'e1'), 0, 'kelas pesan tidak tersentuh');
  ok('kuota state per pengirim (STATE_PER_SENDER) dan total (STATE_MAX); penuh membuang dari pengirim yang paling banyak menitip, pengirim kecil tetap diterima');

  // 3. TTL: state 180 hari, pesan 14 hari
  const T = mk('T'); T._kick = () => {}; T._save = () => {};
  const sOld = fake('ginv', sender(0)), sOld2 = fake('ginv', sender(0)), mOld = fake('e1', sender(1)), mNew = fake('e1', sender(1));
  for (const m of [sOld, sOld2, mOld, mNew]) T._carry(m);
  T.store.custody[sOld.id].at = Date.now() - 100 * DAY; T.store.custody[sOld2.id].at = Date.now() - 181 * DAY;
  T.store.custody[mOld.id].at = Date.now() - 15 * DAY;
  T._gc();
  assert(T.store.custody[sOld.id], 'state umur 100 hari masih dipegang');
  assert(!T.store.custody[sOld2.id], 'state umur 181 hari dibuang');
  assert(!T.store.custody[mOld.id], 'pesan umur 15 hari dibuang');
  assert(T.store.custody[mNew.id]);
  ok('state dipegang sampai 180 hari; pesan DM tetap 14 hari');

  // 4. sync: state dilayani lebih dulu walau pesan lebih lama dan banyak
  const Q = mk('Q'); Q._kick = () => {}; Q._save = () => {};
  const t0 = Date.now() - 50 * 36e5;
  for (let i = 0; i < 400; i++) Q.store.custody[hex(1000 + i, 32)] = { m: fake('e1', sender(i % 20), 'd'.repeat(16), t0 + i), at: Date.now() };
  const newest = fake('ginv', sender(30), 'd'.repeat(16), Date.now()); Q.store.custody[newest.id] = { m: newest, at: Date.now() };
  const r = Q._handle({ t: 'sync_req', have: [], ch: [], rh: [], vh: [] });
  assert.strictEqual(r.cmsgs.length, 300, 'satu putaran membawa 300');
  assert(r.cmsgs.some((m) => m.id === newest.id), 'state yang terbaru ikut walau ada 400 pesan yang lebih lama');
  assert.strictEqual(r.cmsgs[0].kind, 'ginv', 'state di urutan terdepan');
  ok('sync melayani state sebelum pesan');

  // 5. ujung ke ujung: B offline lebih dari 14 hari, A sudah mati; undangan grup tetap sampai lewat kurir D
  const A = mk('A'), D = mk('D'), E = mk('E');
  for (const n of [A, D, E]) await n.start();
  await A.addPeer('127.0.0.1', D.port); await A.addPeer('127.0.0.1', E.port); await D.addPeer('127.0.0.1', E.port);
  await until(() => [A, D, E].every((x) => x.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const eId = E.id, eDir = E.opts.dataDir;
  await E.stop();
  const gid = A.createGroup('Lama offline', [eId]).id;
  await sleep(300);
  await D._syncFrom(D.peers.get(A.id));
  await until(() => count(D, 'ginv') >= 1, 8000, 'D membawa undangan');
  for (const c of Object.values(D.store.custody)) c.at -= 20 * DAY; // 20 hari berlalu
  D._gc();
  assert(count(D, 'ginv') >= 1, 'undangan grup tidak dibuang oleh TTL pesan 14 hari');
  await A.stop();
  const E2 = new Core({ dataDir: eDir, name: 'E', discovery: false }); await E2.start();
  await E2.addPeer('127.0.0.1', D.port);
  await until(() => E2.getState().groups.some((g) => g.id === gid), 15000, 'E menerima undangan lewat D');
  ok('anggota yang offline 20 hari dan pembuat grupnya sudah mati tetap menerima undangan grup lewat kurir');
  await D.stop(); await E2.stop();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
