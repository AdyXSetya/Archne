'use strict';
// Tes titipan sub di DISK (v0.22.1, Step 2c): setelah tersimpan, RAM hanya memegang metadata; isi berat (text/sig/pub/name) dibaca dari segmen saat dibutuhkan.
// Memastikan pesan tetap utuh dan bertanda tangan sah saat dikirim, penghitung byte konsisten, segmen hilang tidak merusak, dan format 2a dikonversi.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const { idFromPub, msgId, verifyMsg } = require('../src/core/archne-util');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-custlazy-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => { const c = new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o || {})); c._kick = () => {}; return c; };
const hex = (n) => crypto.randomBytes(n).toString('hex');
const segf = (n, id) => path.join(tmp, n, 'custody', id.slice(0, 2), id + '.json');
function forge(kind, to, text) { // pesan bertanda tangan sah dari identitas acak
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const m = { from: idFromPub(pub), to: to || (kind === 'g1' ? 'g:' + hex(8) : hex(8)), ts: Date.now(), text: text || crypto.randomBytes(300).toString('base64'), kind };
  m.id = msgId(m);
  m.sig = crypto.sign(null, Buffer.from(K.canon(m)), privateKey).toString('base64');
  m.pub = pub; m.name = 'pengirim';
  return m;
}
const isLight = (c) => ['text', 'sig', 'pub', 'name'].every((k) => { const d = Object.getOwnPropertyDescriptor(c.m, k); return d && typeof d.get === 'function' && d.value === undefined; });

(async () => {
  // ---- 1. setelah disimpan: m ringan, tapi isinya tetap terbaca dan bertanda tangan sah ----
  const B = mk('B'); await B.start();
  const ms = [forge('e1'), forge('g1'), forge('e1')];
  for (const m of ms) assert.strictEqual(B._carry(m), 'carried');
  assert(!isLight(B.store.custody[ms[0].id]), 'sebelum disimpan masih utuh di RAM');
  B._saveNow();
  for (const m of ms) {
    const c = B.store.custody[m.id];
    assert(isLight(c), 'setelah disimpan, isi berat tidak ada di RAM');
    assert.strictEqual(c.m.text, m.text); assert.strictEqual(c.m.sig, m.sig); assert.strictEqual(c.m.pub, m.pub);
    assert(verifyMsg(c.m), 'pesan ringan tetap bertanda tangan sah');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(c.m)), m, 'serialisasi (dikirim ke peer) identik dengan aslinya');
  }
  const u0 = B.custUsage(); assert.strictEqual(u0.dm.count, 2); assert.strictEqual(u0.gmsg.count, 1);
  assert.strictEqual(u0.dm.used, K.custCost(ms[0]) + K.custCost(ms[2]));
  ok('setelah disimpan RAM hanya memegang metadata; isi dibaca dari disk, tanda tangan sah, serialisasi identik');

  // ---- 2. restart: dimuat ringan, penghitung benar, tanpa membaca isi ----
  await B.stop();
  const B2 = mk('B'); await B2.start();
  for (const m of ms) assert(isLight(B2.store.custody[m.id]));
  assert.deepStrictEqual(B2.custUsage(), u0);
  for (const m of ms) assert.strictEqual(B2.store.custody[m.id].m.text, m.text);
  ok('restart: titipan dimuat sebagai metadata ringan; penghitung byte sama; isi tetap terbaca');

  // ---- 3. sync melayani titipan dengan isi lengkap dan tanda tangan sah ----
  const rid = ms[0].to;
  const r = B2._handle({ t: 'sync_req', hi: { id: rid }, have: [], ch: [], rh: [], vh: [] });
  assert.strictEqual(r.cmsgs.length, 3);
  for (const m of r.cmsgs) { const o = JSON.parse(JSON.stringify(m)); assert(verifyMsg(o), 'terkirim utuh'); assert(typeof o.text === 'string' && o.text.length > 100 && o.name === 'pengirim'); }
  ok('sync mengirim titipan dari disk dengan isi lengkap dan tanda tangan sah');

  // ---- 4. segmen hilang/rusak saat dibaca: tidak melempar, titipan disapu _gc ----
  const gone = ms[0];
  B2._custCache.clear(); B2._custCacheBytes = 0;
  fs.rmSync(segf('B', gone.id));
  assert.strictEqual(B2.store.custody[gone.id].m.text, undefined, 'tidak melempar; isi tidak ada');
  B2._gc();
  assert(!B2.store.custody[gone.id] && B2.store.custody[ms[1].id], 'titipan tanpa segmen dibuang, yang lain tetap');
  assert.strictEqual(B2.custUsage().dm.count, 1);
  ok('segmen hilang: pembacaan tidak melempar; _gc membuang titipannya dan penghitung ikut turun');

  // ---- 5. _custPlain: salinan datar untuk disimpan lama (mis. jadi pesanku) ----
  const plain = B2._custPlain(B2.store.custody[ms[1].id].m);
  assert.deepStrictEqual(plain, ms[1]); assert(typeof Object.getOwnPropertyDescriptor(plain, 'text').value === 'string');
  ok('_custPlain menghasilkan salinan datar tanpa getter');

  // ---- 6. penghitung konsisten untuk tambah/ganti/buang langsung ----
  const Q = mk('Q'); const a = forge('e1'), b = forge('e1', null, 'kecil');
  Q.store.custody[a.id] = { m: a, at: 1 }; Q.store.custody[b.id] = { m: b, at: 2 };
  assert.strictEqual(Q.custUsage().dm.used, K.custCost(a) + K.custCost(b));
  Q.store.custody[a.id] = { m: a, at: 3 }; // ganti entri yang sama: tidak dihitung dua kali
  assert.strictEqual(Q.custUsage().dm.used, K.custCost(a) + K.custCost(b));
  delete Q.store.custody[a.id];
  assert.strictEqual(Q.custUsage().dm.used, K.custCost(b)); assert.strictEqual(Q.custUsage().dm.count, 1);
  Q._dropCustody(b.id); assert.deepStrictEqual([Q.custUsage().dm.used, Q.custUsage().dm.count], [0, 0]);
  assert.strictEqual(Q._cq.dm.from.size, 0, 'peta per pengirim bersih');
  ok('penghitung byte konsisten untuk tambah, ganti, dan buang (termasuk penugasan langsung)');

  // ---- 7. format 2a (satu baris berisi pesan lengkap) dikonversi saat dimuat ----
  const D = path.join(tmp, 'V1'); fs.mkdirSync(D, { recursive: true });
  let v1 = forge('e1'); while (v1.id.slice(0, 2) !== '00') v1 = forge('e1'); // cari id berawalan 00 (shard '00')
  const AT = Date.now() - 1000; // jangan terlalu tua: _gc membuang titipan yang lewat TTL
  fs.mkdirSync(path.join(D, 'custody', '00'), { recursive: true });
  fs.writeFileSync(path.join(D, 'custody', '00', v1.id + '.json'), JSON.stringify({ m: v1, at: AT }));
  const V = mk('V1'); await V.start();
  const cv = V.store.custody[v1.id];
  assert(cv && isLight(cv) && cv.at === AT && cv.m.text === v1.text);
  assert.strictEqual(fs.readFileSync(segf('V1', v1.id), 'utf8').split('\n').length, 2, 'ditulis ulang jadi 2 baris');
  assert.strictEqual(V.custUsage().dm.used, K.custCost(v1));
  ok('segmen format 2a dikonversi ke 2 baris saat dimuat; dimuat ringan');
  await V.stop();

  // ---- 8. banyak titipan besar: tidak ada isi berat di RAM ----
  const BIG = mk('BIG', { custDmQuota: Infinity }); await BIG.start();
  for (let i = 0; i < 300; i++) BIG._carry(forge('e1', null, 'q'.repeat(20000)));
  BIG._saveNow();
  const heavy = Object.values(BIG.store.custody).filter((c) => !isLight(c)).length;
  assert.strictEqual(heavy, 0, 'semua 300 titipan (6 MB teks) ringan di RAM');
  assert(BIG._custCacheBytes <= 8e6 + 25000, 'cache isi dibatasi ~8 MB, ada ' + BIG._custCacheBytes);
  ok('300 titipan x 20 KB: nol isi berat di RAM; cache dibatasi 8 MB');
  await BIG.stop(); await B2.stop();

  console.log('\n' + pass + ' pemeriksaan lulus'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
