'use strict';
// Tes kripto mode lintas jaringan (langkah 2): kode -> netId/netKey, wanSeal/wanOpen di Core, bungkus dua lapis.
// Yang diuji: bungkus/buka, tamper, putar ulang, tanda tangan/identitas palsu, kode salah, topik dipindah, jendela waktu, kunci pasangan, persistensi.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const W = require('../src/archne-wancrypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-wancrypto-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[b.length - 1] ^= 1; return b.toString('base64'); };

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C');
  await A.start(); await B.start(); await C.start();
  const CODE = A.wanNewCode();

  // ---------- 1. kode ----------
  assert(/^([A-Z2-7]{5}-){5}[A-Z2-7]{1}$/.test(CODE), 'bentuk kode: ' + CODE);
  assert.notStrictEqual(A.wanNewCode(), A.wanNewCode());
  assert.strictEqual(W.normCode(CODE.toLowerCase().replace(/-/g, ' ')), CODE.replace(/-/g, ''));
  for (const bad of ['', 'abc', 'A'.repeat(25), '0'.repeat(26), 'A'.repeat(65), null, 5, undefined]) assert.strictEqual(W.normCode(bad), null, String(bad));
  const d = W.derive(CODE);
  assert(/^[0-9a-f]{16}$/.test(d.netId) && !CODE.replace(/-/g, '').includes(d.netId) && d.netKey.length === 32);
  assert.deepStrictEqual(W.derive(CODE.toLowerCase()).netId, d.netId);
  assert.notStrictEqual(W.derive(A.wanNewCode()).netId, d.netId);
  assert.throws(() => A.wanSetCode('pendek'), /tidak valid/);
  assert.deepStrictEqual(A.wanInfo(), { enabled: false });
  assert.throws(() => A.wanSeal('presence', null, {}), /belum diatur/);
  assert.strictEqual(A.wanOpen('x', 'y'), null);
  ok('kode: bentuk 128 bit, normalisasi, netId tidak membocorkan kode, kode rusak ditolak, tanpa kode tidak bisa bungkus/buka');

  for (const c of [A, B, C]) c.wanSetCode(CODE);
  assert.strictEqual(A.wanInfo().netId, d.netId);
  assert.strictEqual(A.getState().wan.netId, d.netId);
  assert(!JSON.stringify(A.getState()).includes(CODE.replace(/-/g, '')), 'state tidak membawa kode');
  const T = A.wanTopics();
  assert.deepStrictEqual(T, { netId: d.netId, mine: `archne/v1/${d.netId}/p/${A.id}`, presence: `archne/v1/${d.netId}/p/+`, inbox: `archne/v1/${d.netId}/s/${A.id}` });
  ok('state().wan hanya netId; topik sesuai rencana 4.2');

  // ---------- 2. presence: bungkus/buka ----------
  const pr = A.wanSeal('presence', null, { state: 'online', sid: '0123456789abcdef', name: 'A' });
  assert.strictEqual(pr.topic, T.mine);
  assert(!pr.payload.includes('online') && !Buffer.from(pr.payload, 'base64').toString('latin1').includes('online'), 'payload opak');
  const o = B.wanOpen(pr.topic, pr.payload);
  assert(o && o.type === 'presence' && o.from === A.id && o.to === null && o.body.state === 'online' && o.body.name === 'A');
  assert.strictEqual(A.wanOpen(pr.topic, pr.payload), null, 'gema pesan sendiri dibuang');
  ok('presence: dibungkus opak, dibuka pemegang kode, gema sendiri dibuang');

  // ---------- 3. kode salah, tamper, topik dipindah ----------
  const X = mk('X'); await X.start(); X.wanSetCode(A.wanNewCode());
  assert.strictEqual(X.wanOpen(pr.topic, pr.payload), null, 'kode salah');
  assert.strictEqual(B.wanOpen(pr.topic, flip(pr.payload)), null, 'tamper');
  assert.strictEqual(B.wanOpen(pr.topic, pr.payload.slice(0, -8)), null, 'terpotong');
  for (const junk of ['', 'AAAA', 'bukan base64!!', 'x'.repeat(100000)]) assert.strictEqual(B.wanOpen(pr.topic, junk), null);
  assert.strictEqual(B.wanOpen(pr.topic.replace('/p/' + A.id, '/p/' + C.id), pr.payload), null, 'presence dipindah ke topik orang lain');
  assert.strictEqual(B.wanOpen(`archne/v1/${d.netId}/s/${B.id}`, pr.payload), null, 'presence di kotak masuk');
  // AAD mengikat bungkus ke topiknya sendiri (lapis pertahanan terpisah dari cek topik di dalam bungkus)
  const aadOpen = (topic) => { const b = Buffer.from(pr.payload, 'base64'); const dd = crypto.createDecipheriv('aes-256-gcm', d.netKey, b.subarray(0, 12)); dd.setAAD(Buffer.from(d.netId + '|' + topic)); dd.setAuthTag(b.subarray(12, 28)); return Buffer.concat([dd.update(b.subarray(28)), dd.final()]); };
  assert(aadOpen(pr.topic).length > 0);
  assert.throws(() => aadOpen(pr.topic.replace('/p/' + A.id, '/p/' + C.id)), /authenticate/, 'AAD memuat topik');
  assert.throws(() => aadOpen(pr.topic.replace(d.netId, '0'.repeat(16))), /authenticate/, 'AAD memuat netId');
  ok('kode salah, tamper, terpotong, sampah, dan topik dipindah semuanya dibuang; AAD terikat ke topik dan netId');

  // ---------- 4. signaling: tanpa kunci pasangan ----------
  const sdp = { k: 'offer', sdp: 'v=0 o=- 4611 IN IP4 203.0.113.9 SECRET-SDP' };
  const s1 = A.wanSeal('signal', B.id, sdp);
  assert.strictEqual(s1.topic, `archne/v1/${d.netId}/s/${B.id}`);
  const r1 = B.wanOpen(s1.topic, s1.payload);
  assert(r1 && r1.type === 'signal' && r1.from === A.id && r1.to === B.id);
  assert.deepStrictEqual(r1.body, sdp);
  assert.strictEqual(B.wanOpen(s1.topic, s1.payload), null, 'putar ulang persis sama dibuang');
  assert.strictEqual(C.wanOpen(s1.topic, s1.payload), null, 'bukan untuk C (topik bukan kotak masuk C)');
  const s1c = A.wanSeal('signal', B.id, sdp);
  assert.strictEqual(C.wanOpen(`archne/v1/${d.netId}/s/${C.id}`, s1c.payload), null, 'dialihkan ke kotak masuk C: AAD topik tidak cocok');
  assert.throws(() => A.wanSeal('signal', 'zz', {}), /Penerima/);
  assert.throws(() => A.wanSeal('signal', B.id, { x: 'a'.repeat(40000) }), /terlalu besar/);
  assert.throws(() => A.wanSeal('foo', B.id, {}), /Jenis/);
  ok('signal: sampai ke penerima, putar ulang dibuang, tidak bisa dialihkan ke orang lain, batas ukuran dan penerima dijaga');

  // ---------- 5. kunci pasangan (lapis tambahan) ----------
  const link = (x, y) => x.peers.set(y.id, { id: y.id, name: y.name, ip: '127.0.0.1', port: 1, xpub: y.xpub, pub: y.pub, xsig: y.xsig, lastSeen: Date.now() });
  link(A, B); link(B, A);
  const s2 = A.wanSeal('signal', B.id, sdp);
  const r2 = B.wanOpen(s2.topic, s2.payload);
  assert(r2 && r2.body.sdp.includes('SECRET-SDP'));
  // pemegang kode lain (C) yang membuka lapis luar tetap tidak bisa membaca isi: b adalah ciphertext
  const rawEnv = JSON.parse(Buffer.concat((() => {
    const b = Buffer.from(s2.payload, 'base64');
    const dd = crypto.createDecipheriv('aes-256-gcm', d.netKey, b.subarray(0, 12));
    dd.setAAD(Buffer.from(d.netId + '|' + s2.topic)); dd.setAuthTag(b.subarray(12, 28));
    return [dd.update(b.subarray(28)), dd.final()];
  })()).toString('utf8'));
  assert.strictEqual(rawEnv.pk, 1);
  assert(!rawEnv.b.includes('SECRET-SDP') && !Buffer.from(rawEnv.b, 'base64').toString('latin1').includes('SECRET-SDP'), 'isi tidak terbaca pemegang kode');
  // B tanpa kunci pasangan dengan pengirim tidak bisa membuka bungkus pk=1
  B.peers.delete(A.id); B._pk.clear();
  const s3 = A.wanSeal('signal', B.id, sdp);
  assert.strictEqual(B.wanOpen(s3.topic, s3.payload), null, 'pk=1 tanpa kunci pasangan dibuang');
  link(B, A);
  ok('kunci pasangan: isi SDP tidak terbaca sesama pemegang kode; tanpa kunci pasangan dibuang');

  // ---------- 6. identitas/tanda tangan palsu (penyerang pemegang kode) ----------
  const forge = (over, signer, topic) => {
    const ts = over.ts || Date.now(), b = JSON.stringify(over.body === undefined ? null : over.body);
    const from = over.from, to = over.to === undefined ? B.id : over.to;
    const sig = crypto.sign(null, Buffer.from(JSON.stringify(['archne-wan1', over.type || 'signal', from, to === null ? '' : to, ts, b])), signer.privKey).toString('base64');
    const env = JSON.stringify({ v: 1, type: over.type || 'signal', from, to, ts, b, pk: 0, pub: over.pub || signer.pub, sig });
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', d.netKey, iv);
    c.setAAD(Buffer.from(d.netId + '|' + topic));
    const ct = Buffer.concat([c.update(env, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  };
  const inbox = `archne/v1/${d.netId}/s/${B.id}`;
  assert(B.wanOpen(inbox, forge({ from: C.id, body: { a: 1 } }, C, inbox)), 'pembungkus uji sendiri sah');
  assert.strictEqual(B.wanOpen(inbox, forge({ from: A.id, body: { a: 1 } }, C, inbox)), null, 'mengaku A, ditandatangani C, kunci publik C');
  assert.strictEqual(B.wanOpen(inbox, forge({ from: A.id, pub: A.pub, body: { a: 1 } }, C, inbox)), null, 'mengaku A dengan pub A, tanda tangan C');
  assert.strictEqual(B.wanOpen(inbox, forge({ from: C.id, to: A.id, body: {} }, C, inbox)), null, 'to bukan B');
  assert.strictEqual(B.wanOpen(inbox, forge({ from: C.id, ts: Date.now() - 6 * 60 * 1000, body: {} }, C, inbox)), null, 'signal basi (>5 menit)');
  assert.strictEqual(B.wanOpen(inbox, forge({ from: C.id, ts: Date.now() + 6 * 60 * 1000, body: {} }, C, inbox)), null, 'signal dari masa depan');
  assert.strictEqual(B.wanOpen(inbox, forge({ from: C.id, body: { a: 1 }, type: 'bogus' }, C, inbox)), null, 'jenis tidak dikenal');
  ok('identitas/tanda tangan palsu, penerima salah, jendela waktu, dan jenis asing dibuang');

  // ---------- 7. aturan waktu presence ----------
  const pt = W.topicOf(d.netId, 'presence', C.id);
  const online = (ts) => forge({ from: C.id, to: null, type: 'presence', ts, body: { state: 'online', sid: 'aaaaaaaaaaaaaaaa' } }, C, pt);
  const offline = (ts) => forge({ from: C.id, to: null, type: 'presence', ts, body: { state: 'offline', sid: 'aaaaaaaaaaaaaaaa' } }, C, pt);
  assert(B.wanOpen(pt, online(Date.now() - 60 * 1000)), 'online segar');
  assert.strictEqual(B.wanOpen(pt, online(Date.now() - 16 * 60 * 1000)), null, 'online basi (retained usang) dibuang');
  assert.strictEqual(B.wanOpen(pt, online(Date.now() + 6 * 60 * 1000)), null, 'online dari masa depan');
  assert(B.wanOpen(pt, offline(Date.now() - 3 * 3600 * 1000)), 'Last Will lama tetap sah (sid yang menjaga di klien)');
  assert.strictEqual(B.wanOpen(pt, forge({ from: C.id, to: B.id, type: 'presence', body: { state: 'online', sid: 'aaaaaaaaaaaaaaaa' } }, C, pt)), null, 'presence tidak boleh punya penerima');
  ok('presence: online basi/masa depan dibuang; Last Will lama sah');

  // ---------- 8. blokir ----------
  B.store.blocked[C.id] = { at: Date.now(), name: 'C' };
  assert.strictEqual(B.wanOpen(inbox, forge({ from: C.id, body: { z: 1 } }, C, inbox)), null, 'pengirim terblokir dibuang');
  delete B.store.blocked[C.id];
  ok('pengirim yang diblokir dibuang di Core');

  // ---------- 9. persistensi dan Ganti kode ----------
  A._saveNow();
  const A2 = new Core({ dataDir: path.join(tmp, 'A'), name: 'A', discovery: false });
  await A2.start();
  assert.deepStrictEqual(A2.wanInfo(), A.wanInfo());
  assert.strictEqual(A2.id, A.id);
  const keep = A2.wanSeal('signal', B.id, { n: 1 });
  assert(B.wanOpen(keep.topic, keep.payload), 'setelah restart, kode yang sama tetap cocok');
  const old = A2.wanSeal('signal', B.id, { n: 2 });
  A2.wanSetCode(A2.wanNewCode()); // Ganti kode
  assert.notStrictEqual(A2.wanInfo().netId, d.netId);
  assert.strictEqual(B.wanOpen(old.topic, old.payload) && 'x', 'x', 'bungkus lama (belum diganti di B) masih terbuka di B, itu wajar');
  const neu = A2.wanSeal('signal', B.id, { n: 3 });
  assert.strictEqual(B.wanOpen(neu.topic, neu.payload), null, 'setelah Ganti kode, peserta lama tidak lagi bisa membuka');
  A2.wanClear();
  assert.deepStrictEqual(A2.wanInfo(), { enabled: false });
  assert.throws(() => A2.wanSeal('presence', null, {}), /belum diatur/);
  A2._saveNow();
  const A3 = new Core({ dataDir: path.join(tmp, 'A'), name: 'A', discovery: false }); await A3.start();
  assert.deepStrictEqual(A3.wanInfo(), { enabled: false }, 'wanClear bertahan setelah restart');
  ok('kode bertahan setelah restart; Ganti kode memutus peserta lama; wanClear bertahan');

  for (const c of [A, B, C, X, A2, A3]) await c.stop();
  console.log(`\nSemua ${pass} tes kripto WAN lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
