'use strict';
// Tes kuota BYTE pesan publik orang lain (v0.22.1, Step 2d): hanya pesan publik orang lain yang dihitung (bukan pesanku, bukan batal-kirim),
// per pengirim 10%, penuh = pengirim terbanyak kehilangan pesan terlamanya dulu, pesan lebih tua dari semua yang bisa digusur ditolak,
// pesan yang sedang diunduh tidak digusur, tanpa batas, bertahan lewat restart, batas bawah sync (pmin).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { Core, msgId, canon, DEL } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pubquota-'));
let pass = 0, seq = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o, keepSave) => {
  const dir = path.join(tmp, n); fs.mkdirSync(dir, { recursive: true });
  const c = new Core(Object.assign({ dataDir: dir, name: n, discovery: false }, o || {}));
  c._loadIdentity(); c._kick = () => {}; if (!keepSave) c._save = () => {};
  return c;
};
const UC = K.custCost({ text: '0000' }); // ongkos satu pesan uji: 4 byte + overhead
const BASE = 1.7e12;
// pesan publik bertanda tangan dari identitas S dengan ts yang kukendalikan; teks 4 karakter supaya ongkosnya seragam
const signed = (S, text, ts) => {
  const m = { from: S.id, to: 'public', ts, text };
  m.id = msgId(m); m.sig = crypto.sign(null, Buffer.from(canon(m)), S.privKey).toString('base64'); m.pub = S.pub; m.name = S.name;
  return m;
};
const pm = (S, ts) => signed(S, String(++seq).padStart(4, '0'), ts);
const senders = (n) => Array.from({ length: n }, (_, i) => mk('S' + (seq++) + '_' + i));
const recount = (R) => { let n = 0, b = 0; const f = new Map(); for (const m of Object.values(R.store.msgs)) if (R._isPubOther(m)) { n++; b += K.custCost(m); f.set(m.from, (f.get(m.from) || 0) + K.custCost(m)); } return { n, b, f }; };
const same = (R) => { const r = recount(R), q = R._pq; assert.strictEqual(q.n, r.n); assert.strictEqual(q.bytes, r.b); assert.deepStrictEqual([...q.from.entries()].sort(), [...r.f.entries()].sort()); };
const held = (R, S) => Object.values(R.store.msgs).filter((m) => m.from === S.id).map((m) => m.ts).sort((a, b) => a - b);

(async () => {
  // 1. hanya pesan publik orang lain yang dihitung; ongkos = custCost; pesanku, batal-kirim, DM tidak
  const R = mk('R', { pubMsgQuota: 100 * UC }), [A] = senders(1);
  assert.strictEqual(K.PUBMSG_QUOTA, 20 * 1048576);
  assert.strictEqual(new Core({ dataDir: tmp, discovery: false })._custLimits().pub.quota, K.PUBMSG_QUOTA, 'bawaan 20 MB');
  const a1 = pm(A, BASE + 1), a2 = pm(A, BASE + 2), a3 = pm(A, BASE + 3);
  for (const m of [a1, a2, a3]) assert.strictEqual(R._ingest(m), 'new');
  const mine = R._makeMsg('public', null, 'punyaku'); R.store.msgs[mine.id] = mine;
  assert(!R._isPubOther(mine)); assert(R._isPubOther(a1));
  assert.strictEqual(R._ingest(signed(A, DEL + a1.id, BASE + 4)), 'new'); // batal-kirim dari pengirimnya sendiri
  assert(!R.store.msgs[a1.id], 'pesan yang dibatalkan hilang'); assert(R._isPubOther(a2) && !R._isPubOther(signed(A, DEL + a1.id, BASE + 9)));
  const u = R.custUsage().pub;
  assert.deepStrictEqual([u.used, u.count, u.quota], [2 * UC, 2, 100 * UC]); same(R);
  assert.deepStrictEqual(R.pubUsage(), u);
  ok('hanya pesan publik orang lain yang dihitung (bukan milikku, bukan batal-kirim); batal-kirim mengurangi hitungan; custUsage().pub');

  // 2. per pengirim 10%: pengirim yang melewati bagiannya kehilangan pesan terlamanya sendiri
  const R2 = mk('R2', { pubMsgQuota: 100 * UC }), [F] = senders(1), sent = [];
  for (let i = 1; i <= 25; i++) { const m = pm(F, BASE + i); sent.push(m.ts); assert.strictEqual(R2._ingest(m), 'new'); }
  const h = held(R2, F);
  assert(h.length >= 8 && h.length <= 10, 'tersisa 8-10 pesan, ada ' + h.length);
  assert.deepStrictEqual(h, sent.slice(sent.length - h.length), 'yang tersisa adalah yang terbaru');
  assert(R2._pq.from.get(F.id) <= 10 * UC); same(R2);
  ok('per pengirim 10%: banjir satu pengirim hanya menggusur pesan lamanya sendiri (yang terbaru tetap)');

  // 3. kuota total, pengirim sama besar: tiap pengirim kehilangan yang TERLAMA, tidak ada yang dikorbankan habis
  const R3 = mk('R3', { pubMsgQuota: 100 * UC }), S10 = senders(10), all = {};
  for (let i = 0; i < 10; i++) for (const S of S10) { const m = pm(S, BASE + 100 + i * 10 + S10.indexOf(S)); (all[S.id] = all[S.id] || []).push(m.ts); assert.strictEqual(R3._ingest(m), 'new'); }
  assert.strictEqual(R3._pq.bytes, 100 * UC);
  const [K1] = senders(1), newest = pm(K1, BASE + 500);
  assert.strictEqual(R3._ingest(newest), 'new'); assert(R3.store.msgs[newest.id]);
  assert(R3._pq.bytes <= 100 * UC && R3._pq.bytes >= 85 * UC, 'turun ke ~90% kuota, bukan hanya satu pesan: ' + R3._pq.bytes / UC);
  for (const S of S10) { const h3 = held(R3, S); assert(h3.length >= 8, 'tidak ada pengirim yang dihabisi'); assert.deepStrictEqual(h3, all[S.id].slice(all[S.id].length - h3.length)); }
  same(R3);
  ok('kuota total penuh: air-meratakan antar pengirim, yang digusur selalu yang terlama tiap pengirim, turun ke ~90%');

  // 4. pengirim yang memegang paling banyak kehilangan duluan; pengirim kecil tidak tersentuh
  const R4 = mk('R4', { pubMsgQuota: 100 * UC }), big = senders(5), small = senders(25);
  for (const S of big) for (let i = 0; i < 10; i++) R4._ingest(pm(S, BASE + 1000 + i));
  for (const S of small) for (let i = 0; i < 2; i++) R4._ingest(pm(S, BASE + 2000 + i));
  assert.strictEqual(R4._pq.bytes, 100 * UC);
  const [Z] = senders(1); assert.strictEqual(R4._ingest(pm(Z, BASE + 3000)), 'new');
  for (const S of small) assert.strictEqual(held(R4, S).length, 2, 'pengirim kecil utuh');
  assert(big.reduce((a, S) => a + held(R4, S).length, 0) <= 40, 'yang gemuk yang menanggung'); same(R4);
  ok('yang memegang paling banyak menanggung penggusuran; pengirim kecil tidak tersentuh');

  // 5. pesan masuk yang lebih tua dari semua yang bisa digusur ditolak ('full'), tanpa menggusur apa pun; yang baru tetap masuk
  const R5 = mk('R5', { pubMsgQuota: 100 * UC }), S5 = senders(10);
  for (const S of S5) for (let i = 0; i < 10; i++) R5._ingest(pm(S, BASE + 5000 + i));
  const before = Object.keys(R5.store.msgs).length, [O] = senders(1);
  assert.strictEqual(R5._ingest(pm(O, BASE + 1)), 'full');
  assert.strictEqual(Object.keys(R5.store.msgs).length, before, 'tidak ada yang digusur untuk pesan lama'); same(R5);
  assert.strictEqual(R5._ingest(pm(O, BASE + 9000)), 'new');
  const tiny = mk('R5b', { pubMsgQuota: 5 * UC }); // 10% dari kuota < ongkos satu pesan: tidak ada yang muat
  assert.strictEqual(tiny._ingest(pm(O, BASE + 9100)), 'full', 'pesan yang lebih besar dari bagian per pengirim ditolak'); assert.strictEqual(tiny._pq.n, 0);
  ok("pesan lama saat penuh = 'full' (tidak menggusur); yang baru masuk; pesan yang tidak muat di bagian per pengirim ditolak");

  // 6. pesanku tidak ikut dihitung dan tidak pernah digusur
  const R6 = mk('R6', { pubMsgQuota: 20 * UC }), own = [];
  for (let i = 0; i < 10; i++) { const m = R6._makeMsg('public', null, 'pesanku ' + i); R6.store.msgs[m.id] = m; own.push(m.id); }
  for (const S of senders(15)) for (let i = 0; i < 2; i++) R6._ingest(pm(S, BASE + 6000 + i));
  for (const id of own) assert(R6.store.msgs[id], 'pesanku utuh'); same(R6);
  assert(R6._pq.bytes <= 20 * UC);
  ok('pesanku tidak dihitung dan tidak pernah digusur');

  // 7. pesan yang berkasnya sedang diunduh tidak digusur
  const R7 = mk('R7', { pubMsgQuota: 20 * UC }), S7 = senders(10), first = [];
  for (const S of S7) for (let i = 0; i < 2; i++) { const m = pm(S, BASE + 7000 + i); if (!i) first.push(m); R7._ingest(m); }
  R7._rx.set(first[0].id, { p: Promise.resolve(), ac: { abort() {} } });
  const [Y] = senders(1); R7._ingest(pm(Y, BASE + 7100));
  assert(R7.store.msgs[first[0].id], 'yang sedang diunduh tetap ada'); same(R7);
  ok('pesan yang penerimaannya sedang berjalan tidak digusur');

  // 8. tanpa batas
  const R8 = mk('R8', { pubMsgQuota: Infinity }), [U] = senders(1);
  assert.strictEqual(R8._custLimits().pub.perSender, K.UNLIM_SENDER);
  for (let i = 0; i < 300; i++) assert.strictEqual(R8._ingest(pm(U, BASE + 8000 + i)), 'new');
  assert.strictEqual(R8._pq.n, 300); assert.strictEqual(R8._pubFloor(), 0);
  const bad = mk('R8b', { pubMsgQuota: -5 }); assert.strictEqual(bad._custLimits().pub.quota, K.PUBMSG_QUOTA, 'nilai tidak sah jatuh ke bawaan');
  ok('tanpa batas (Infinity): semua diterima; nilai opts tidak sah jatuh ke bawaan');

  // 9. bertahan lewat restart: penghitung dibangun ulang dari isi
  const R9 = mk('R9', { pubMsgQuota: 100 * UC }, true), [P] = senders(1);
  R9._loadStore(); // seperti start(): menetapkan berkas simpanan
  for (let i = 0; i < 5; i++) R9._ingest(pm(P, BASE + 9500 + i));
  clearTimeout(R9._st); R9._st = null; R9._saveNow();
  const R9b = new Core({ dataDir: path.join(tmp, 'R9'), name: 'R9', discovery: false, pubMsgQuota: 100 * UC });
  R9b._loadIdentity(); R9b._loadStore();
  assert.deepStrictEqual([R9b._pq.n, R9b._pq.bytes], [5, 5 * UC]); same(R9b);
  ok('restart: penghitung pesan publik dibangun ulang dari store');

  // 10. batas bawah sync: hanya saat >85% penuh; peer melewatkan pesan orang lain yang lebih tua dari pmin
  const R10 = mk('R10', { pubMsgQuota: 100 * UC }), S10b = senders(10);
  for (const S of S10b.slice(0, 5)) for (let i = 0; i < 10; i++) R10._ingest(pm(S, BASE + 10000 + i));
  assert.strictEqual(R10._pubFloor(), 0, 'di bawah 85%: tanpa batas bawah');
  for (const S of S10b.slice(5)) for (let i = 0; i < 9; i++) R10._ingest(pm(S, BASE + 10100 + i));
  assert(R10._pq.bytes > 85 * UC);
  assert.strictEqual(R10._pubFloor(), BASE + 10000, 'batas bawah = pesan orang lain terlama yang kupegang');
  const srv = mk('Srv', { pubMsgQuota: Infinity }), [W] = senders(1);
  for (let i = 0; i < 20; i++) srv._ingest(pm(W, BASE + 20000 + i));
  assert.strictEqual(srv._handle({ t: 'sync_req', have: [] }).msgs.length, 20);
  const cut = srv._handle({ t: 'sync_req', have: [], pmin: BASE + 20010 }).msgs;
  assert.strictEqual(cut.length, 10); assert(cut.every((m) => m.ts >= BASE + 20010));
  assert.strictEqual(srv._handle({ t: 'sync_req', have: [], pmin: 'abc' }).msgs.length, 20, 'pmin tidak sah diabaikan');
  ok('sync: pmin hanya dikirim saat hampir penuh; peer tidak mengirim pesan yang pasti ditolak; pmin tidak sah diabaikan');

  // 11. dua node sungguhan: B berkuota kecil menarik dari A (tanpa batas); sesudah penuh, putaran sync berikutnya tidak membawa pesan lama lagi
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const A2 = mk('NA', { pubMsgQuota: Infinity, tickMs: 100 }, true), B2 = mk('NB', { pubMsgQuota: 40 * UC, tickMs: 100 }, true);
  const SS = senders(10), tsAll = [];
  for (const S of SS) for (let i = 0; i < 10; i++) { const m = pm(S, BASE + 30000 + i * 10 + SS.indexOf(S)); tsAll.push(m.ts); assert.strictEqual(A2._ingest(m), 'new'); }
  await A2.start(); await B2.start();
  const res = []; const orig = B2._ingest.bind(B2); B2._ingest = (m, d) => { const r = orig(m, d); res.push(r); return r; };
  const reqs = []; const origReq = B2._request.bind(B2); B2._request = (p, o, t) => { if (o && o.t === 'sync_req') reqs.push(o); return origReq(p, o, t); };
  await B2.addPeer('127.0.0.1', A2.port);
  for (let i = 0; i < 100 && !(B2.peers.get(A2.id) && B2.isOnline(B2.peers.get(A2.id))); i++) await sleep(50);
  const pa = B2.peers.get(A2.id);
  for (let i = 0; i < 4; i++) await B2._syncFrom(pa);
  assert(B2._pq.bytes <= 40 * UC && B2._pq.n >= 30, 'B menahan sekitar kuotanya: ' + B2._pq.n); same(B2);
  const mxB = Math.max(...Object.values(B2.store.msgs).map((m) => m.ts));
  assert.strictEqual(mxB, Math.max(...tsAll), 'yang terbaru ada di B');
  const n0 = res.length; await B2._syncFrom(pa);
  assert.strictEqual(res.length - n0, 0, 'putaran sync berikutnya tidak membawa pesan yang pasti ditolak');
  assert(reqs.some((r) => Number.isFinite(r.pmin) && r.pmin > 0), 'B mengirim pmin saat hampir penuh'); assert(!('pmin' in reqs[0]), 'putaran pertama (kosong) tanpa pmin');
  await A2.stop(); await B2.stop();
  ok('dua node: B berkuota kecil tetap di bawah kuota, A tidak mengirim ulang pesan lama (pmin lewat jaringan)');

  console.log(`\n${pass} kelompok pengecekan lulus (pubquota)`);
})().catch((e) => { console.error(e); process.exit(1); });
