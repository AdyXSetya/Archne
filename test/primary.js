'use strict';
// Tes primer (v0.22.0): pesan kontrol bertanda `pc` jadi kelas state di kurir (tidak tergusur banjir DM/pesan grup),
// penanda ikut ditandatangani, anggota menolak penyalahgunaan, dan penyimpanan dipisah (primary.json / custody/ bersegmen / store.json).
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const { verifyMsg, idFromPub, msgId } = require('../src/core/archne-util');
const Pins = require('../src/archne-pins'), Vc = require('../src/archne-vchan');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-primary-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const rd = (n, f) => JSON.parse(fs.readFileSync(path.join(tmp, n, f), 'utf8'));
const seg = (n, id) => path.join(tmp, n, 'custody', id.slice(0, 2), id + '.json'); // titipan sub: satu berkas per pesan (v0.22.1)

// Pesan g1/e1 sah (bertanda tangan) dari identitas acak yang tidak dikenal siapa pun: ciphertext tak terbaca, seperti banjir dari luar.
function forge(kind, to, pc) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const m = { from: idFromPub(pub), to, ts: Date.now(), text: crypto.randomBytes(40).toString('base64'), kind };
  if (pc) m.pc = 1;
  m.id = msgId(m);
  m.sig = crypto.sign(null, Buffer.from(K.canon(m)), privateKey).toString('base64');
  m.pub = pub; m.name = 'x';
  return m;
}

(async () => {
  // ---- 1. awalan kontrol sama dengan sumbernya ----
  assert.deepStrictEqual(K.PRIM_CTL.slice().sort(), [Pins.CTL, Vc.CTL, K.DEL, K.FTEXT.frq, K.FTEXT.fac, K.FTEXT.fdl].sort());
  assert(K.isPrimText(Pins.CTL + '[]') && K.isPrimText(K.DEL + 'x') && !K.isPrimText('halo') && !K.isPrimText(null));
  ok('PRIM_CTL sama dengan Pins.CTL, Vc.CTL, DEL, dan FTEXT');

  const A = mk('A'), C = mk('C'), B = mk('B');
B.opts.custGmsgQuota = 1000 * K.custCost({ text: 'x'.repeat(56) }); B.opts.custDmQuota = 500 * K.custCost({ text: 'x'.repeat(56) }); // kuota byte setara batas jumlah lama (teks palsu ~56 byte); banjir harus memenuhinya
  await A.start(); await C.start(); await B.start();
  await A.addPeer('127.0.0.1', C.port);
  await until(() => A.getState().peers.some((p) => p.online), 5000, 'A-C kenal');
  const gid = A.createGroup('Tim', [C.id]).id;
  await until(() => C.store.groups[gid], 5000, 'C masuk grup');

  // ---- 2. penanda pc: hanya untuk pesan kontrol, ikut ditandatangani ----
  const pin = A._send(Pins.CTL + '[]', 'g:' + gid), chat = A._send('halo grup', 'g:' + gid);
  assert.strictEqual(pin.pc, 1); assert.strictEqual(chat.pc, undefined);
  assert(verifyMsg(pin) && verifyMsg(chat));
  const fake = Object.assign({}, chat, { pc: 1 }); assert(!verifyMsg(fake), 'menambah pc ke chat biasa merusak tanda tangan');
  const strip = Object.assign({}, pin); delete strip.pc; assert(!verifyMsg(strip), 'membuang pc dari kontrol merusak tanda tangan');
  const pub = Object.assign({}, A._makeMsg('public', null, 'x'), { pc: 1 }); assert(!verifyMsg(pub));
  const pcBad = forge('g1', 'g:' + 'a'.repeat(16), true); pcBad.pc = 2; assert(!verifyMsg(pcBad), 'nilai pc selain 1 ditolak');
  assert(!verifyMsg(forge('ginv', 'g:' + 'a'.repeat(16), true)), 'pc pada kind selain g1/e1 ditolak');
  assert.strictEqual(K.custClass(pin), 'state'); assert.strictEqual(K.custClass(chat), 'gmsg');
  ok('pc ikut ditandatangani (tidak bisa ditambah/dibuang), hanya berlaku untuk g1/e1; kelas kurir = state');

  // ---- 3. anggota menolak chat biasa yang ditandai primer, menerima kontrol sungguhan ----
  const bad = A._makeMsg('g:' + gid, 'g1', 'obrolan biasa', undefined, true);
  assert.strictEqual(C._ingest(bad), 'bad');
  assert.strictEqual(C._ingest(pin), 'new');
  ok('anggota menolak pc palsu pada obrolan biasa; kontrol sungguhan diterima');

  // ---- 4. kurir luar membawa primer; banjir tidak menggusurnya ----
  const dmCtl = A._send(K.FTEXT.frq, C.id); // kontrol teman DM: primer juga
  assert.strictEqual(dmCtl.pc, 1);
  assert.strictEqual(B._ingest(pin), 'carried'); assert.strictEqual(B._ingest(dmCtl), 'carried');
  assert.strictEqual(B._ingest(chat), 'carried');
  const g2 = A.createGroup('Tim2', [C.id]).id; // grup lain yang B juga bukan anggotanya
  const pin2 = A._send(Pins.CTL + '[]', 'g:' + g2); assert.strictEqual(B._ingest(pin2), 'carried');
  for (let i = 0; i < 1100; i++) B._ingest(forge('g1', 'g:' + (i % 12).toString(16).repeat(16)));   // banjir pesan grup (12 grup palsu)
  for (let i = 0; i < 700; i++) B._ingest(forge('e1', crypto.randomBytes(8).toString('hex')));       // banjir DM
  const cnt = (cls) => Object.values(B.store.custody).filter((c) => K.custClass(c.m) === cls).length;
  const U = B.custUsage();
  assert(U.gmsg.used <= U.gmsg.quota && U.gmsg.used > U.gmsg.quota / 2 && U.dm.used <= U.dm.quota && U.dm.used > U.dm.quota * 0.6 && cnt('gmsg') > 500 && cnt('dm') > 300, 'banjir benar-benar memenuhi kelas sub');
  assert(B.store.custody[pin.id] && B.store.custody[pin2.id] && B.store.custody[dmCtl.id], 'primer tetap ada');
  ok('B (bukan anggota) membawa sematan grup + kontrol DM; banjir 1100 pesan grup + 700 DM tidak menggusurnya');

  // primer diprioritaskan saat melayani sync (di atas DM dan pesan grup)
  assert(K.custRank(pin, 'f'.repeat(16)) < K.custRank(forge('e1', 'f'.repeat(16) + ''), 'z') && K.custRank(pin, 'x') < K.custRank(chat, 'x'));
  ok('urutan sync: primer lebih dulu daripada DM dan pesan grup');

  // banjir primer palsu ke satu grup hanya menggusur dirinya sendiri
  const victimGroup = 'g:' + 'e'.repeat(16);
  for (let i = 0; i < K.STATE_MAX + 50; i++) B._ingest(forge('g1', victimGroup, true));
  assert(cnt('state') <= K.STATE_MAX);
  assert(B.store.custody[pin.id] && B.store.custody[pin2.id] && B.store.custody[dmCtl.id], 'primer asli selamat dari banjir primer palsu ke satu grup');
  ok('banjir primer palsu ke satu grup hanya menggusur dirinya sendiri (tujuan terpenuh dikorbankan dulu)');

  // ---- 5. penyimpanan terpisah ----
  B._saveNow();
  const P = rd('B', 'primary.json'), R = rd('B', 'store.json');
  assert(P.custody[pin.id] && P.custody[dmCtl.id] && !P.custody[chat.id]);
  assert(fs.existsSync(seg('B', chat.id)) && !fs.existsSync(seg('B', pin.id)), 'chat biasa = segmen di custody/, primer tidak');
  assert(!fs.existsSync(path.join(tmp, 'B', 'custody.json')), 'custody.json lama tidak dibuat lagi');
  assert(R.custody === undefined && R.profiles === undefined && R.receipts === undefined, 'store.json tidak lagi memuat custody/profil/tanda terima');
  assert('profiles' in P && 'receipts' in P);
  ok('primary.json memuat titipan primer + profil + tanda terima; custody/ hanya sub (satu berkas per pesan); store.json sisanya');

  const total = Object.keys(B.store.custody).length;
  await B.stop();
  const B2 = mk('B'); await B2.start();
  assert.strictEqual(Object.keys(B2.store.custody).length, total);
  assert(B2.store.custody[pin.id] && B2.store.custody[dmCtl.id]);
  ok('restart: semua titipan (primer dan sub) kembali utuh');

  // primary.json rusak -> pulih dari .bak
  B2._saveNow(); B2._saveNow(); // simpan kedua membuat .bak dari versi sebelumnya
  await B2.stop();
  assert(fs.existsSync(path.join(tmp, 'B', 'primary.json.bak')));
  fs.writeFileSync(path.join(tmp, 'B', 'primary.json'), '{rusak');
  const B3 = mk('B'); await B3.start();
  assert(B3.store.custody[pin.id] && B3.store.custody[dmCtl.id], 'primer pulih dari cadangan');
  ok('primary.json rusak: dipulihkan dari primary.json.bak, tidak ada primer yang hilang');

  // ---- 6. migrasi store lama (custody di dalam store.json) ----
  await B3.stop();
  const old = rd('B', 'store.json'); old.custody = { [pin.id]: { m: pin, at: Date.now() }, [chat.id]: { m: chat, at: Date.now() } };
  fs.rmSync(path.join(tmp, 'B', 'primary.json')); fs.rmSync(path.join(tmp, 'B', 'primary.json.bak')); fs.rmSync(path.join(tmp, 'B', 'custody'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'B', 'store.json'), JSON.stringify(old));
  const B4 = mk('B'); await B4.start();
  assert(B4.store.custody[pin.id] && B4.store.custody[chat.id]);
  B4._saveNow();
  assert(fs.existsSync(seg('B', chat.id)) && rd('B', 'primary.json').custody[pin.id] && rd('B', 'store.json').custody === undefined);
  ok('migrasi: store lama otomatis dipecah ke primary.json, custody/, dan store.json pada simpan pertama');

  await A.stop(); await C.stop(); await B4.stop();
  console.log(`\nSEMUA TES PRIMER LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
