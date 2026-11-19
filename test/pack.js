'use strict';
// Tes kompresi berkas (v0.7.0 tahap 2): lossless, deteksi otomatis, bom kompresi, verifikasi hash, batas per berkas.
const os = require('os'), path = require('path'), fs = require('fs'), zlib = require('zlib'), crypto = require('crypto'), assert = require('assert');
const P = require('../src/archne-pack');
const MB = 1048576;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pack-'));
const f = (n) => path.join(tmp, n);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const rejects = async (fn, code, label) => {
  try { await fn(); } catch (e) { assert.strictEqual(e.code, code, label + ': kode ' + e.code + ' (' + e.message + ')'); return; }
  assert.fail(label + ': seharusnya ditolak');
};

// Data uji: log semi-acak (bisa dikompres), acak murni (tidak bisa).
function logText(bytes, seed = 1) {
  let s = seed, out = [], n = 0;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  while (n < bytes) {
    const l = '2026-11-10 16:' + String(Math.floor(rnd() * 60)).padStart(2, '0') + ' INFO user=' + Math.floor(rnd() * 500) + ' GET /api/item/' + Math.floor(rnd() * 9000) + ' 200 ' + Math.floor(rnd() * 5000) + 'ms\n';
    out.push(l); n += l.length;
  }
  return Buffer.from(out.join('')).subarray(0, bytes);
}
const rand = (n) => crypto.randomBytes(n);

(async () => {
  // ---- 1. teks: mengecil banyak, hasil identik ----
  fs.writeFileSync(f('log.txt'), logText(2 * MB));
  let r = await P.pack(f('log.txt'), f('log.txt.pk'));
  assert.strictEqual(r.meta.mode, 'br');
  assert.strictEqual(r.path, f('log.txt.pk'));
  assert(r.meta.psize < r.meta.size * 0.4, 'log harus hemat > 60%, dapat psize=' + r.meta.psize);
  assert.strictEqual(fs.statSync(r.path).size, r.meta.psize);
  await P.unpack(r.path, f('log.out'), r.meta);
  assert(fs.readFileSync(f('log.out')).equals(fs.readFileSync(f('log.txt'))));
  assert.strictEqual(sha(f('log.out')), r.meta.hash);
  assert(!fs.existsSync(f('log.out.part')));
  ok('log 2 MB: hemat ' + Math.round((1 - r.meta.psize / r.meta.size) * 100) + '%, hasil identik byte-per-byte');

  // ---- 2. acak/terkompresi: kirim apa adanya, tanpa salinan ----
  fs.writeFileSync(f('foto.jpg'), rand(1.5 * MB));
  r = await P.pack(f('foto.jpg'), f('foto.jpg.pk'));
  assert.strictEqual(r.meta.mode, 'raw');
  assert.strictEqual(r.path, f('foto.jpg'));
  assert.strictEqual(r.meta.psize, r.meta.size);
  assert(!fs.existsSync(f('foto.jpg.pk')) && !fs.existsSync(f('foto.jpg.pk.part')));
  await P.unpack(r.path, f('foto.out'), r.meta);
  assert.strictEqual(sha(f('foto.out')), sha(f('foto.jpg')));
  ok('berkas acak (mirip jpg/mp4): mode raw, tanpa salinan, tetap terverifikasi hash');

  // ---- 3. deteksi lewat isi, bukan ekstensi ----
  fs.writeFileSync(f('rahasia.txt'), rand(600 * 1024));            // acak berpura-pura teks
  fs.writeFileSync(f('data.jpg'), logText(600 * 1024, 7));         // teks berpura-pura jpg
  assert.strictEqual((await P.pack(f('rahasia.txt'), f('x1'))).meta.mode, 'raw');
  const rj = await P.pack(f('data.jpg'), f('x2'));
  assert.strictEqual(rj.meta.mode, 'br');
  ok('ekstensi tidak dipakai: acak ber-ekstensi .txt = raw, teks ber-ekstensi .jpg = br');

  // ---- 4. zip/docx (sudah terkompresi) ----
  fs.writeFileSync(f('arsip.zip'), zlib.deflateRawSync(logText(1 * MB, 3), { level: 9 }));
  assert.strictEqual((await P.pack(f('arsip.zip'), f('x3'))).meta.mode, 'raw');
  ok('data yang sudah terkompresi (deflate) tidak dikompres ulang');

  // ---- 5. berkas campuran ----
  // (a) kepala teks kecil (100 KB) + badan acak 3 MB: hemat nyata < 5%. Contoh 3 titik bisa saja menaksir lebih tinggi karena kepala
  //     terlalu berbobot di contoh; pemeriksaan hasil penuh harus menangkapnya: buang hasil kompres, kirim apa adanya.
  fs.writeFileSync(f('campur.bin'), Buffer.concat([logText(100 * 1024, 9), rand(3 * MB)]));
  r = await P.pack(f('campur.bin'), f('campur.pk'));
  assert.strictEqual(r.meta.mode, 'raw');
  assert.strictEqual(r.path, f('campur.bin'));
  assert(!fs.existsSync(f('campur.pk')) && !fs.existsSync(f('campur.pk.part')));
  await P.unpack(r.path, f('campur.out'), r.meta);
  assert.strictEqual(sha(f('campur.out')), sha(f('campur.bin')));
  // (b) separuh teks, separuh acak: hemat nyata sekitar 49%, layak dikompres
  fs.writeFileSync(f('campur2.bin'), Buffer.concat([logText(1.5 * MB, 4), rand(1.5 * MB)]));
  r = await P.pack(f('campur2.bin'), f('campur2.pk'));
  assert.strictEqual(r.meta.mode, 'br');
  assert(r.meta.psize < r.meta.size * 0.6 && r.meta.psize > r.meta.size * 0.4, 'psize ' + r.meta.psize);
  await P.unpack(r.path, f('campur2.out'), r.meta);
  assert.strictEqual(sha(f('campur2.out')), sha(f('campur2.bin')));
  ok('berkas campuran: hemat nyata < 5% jadi raw (hasil kompres dibuang), separuh teks tetap dikompres dan identik');

  // ---- 6. berkas kosong dan sangat kecil ----
  fs.writeFileSync(f('kosong'), '');
  r = await P.pack(f('kosong'), f('kosong.pk'));
  assert.strictEqual(r.meta.mode, 'raw'); assert.strictEqual(r.meta.size, 0);
  await P.unpack(r.path, f('kosong.out'), r.meta);
  assert.strictEqual(fs.statSync(f('kosong.out')).size, 0);
  fs.writeFileSync(f('kecil.txt'), 'halo '.repeat(2000));
  r = await P.pack(f('kecil.txt'), f('kecil.pk'));
  await P.unpack(r.path, f('kecil.out'), r.meta);
  assert.strictEqual(fs.readFileSync(f('kecil.out'), 'utf8'), 'halo '.repeat(2000));
  ok('berkas kosong dan kecil bolak-balik utuh');

  // ---- 7. rencana level adaptif ----
  assert.strictEqual(P.plan(20 * MB).level, 11);
  assert.strictEqual(P.plan(20 * MB + 1).level, 9);
  assert.strictEqual(P.plan(100 * MB).level, 9);
  assert.strictEqual(P.plan(1).lgwin, 24);
  ok('level 11 sampai 20 MB, level 9 di atasnya, jendela 24');

  // ---- 8. batas per berkas pada ukuran ASLI ----
  P.checkLimit(100 * MB, 'direct'); P.checkLimit(50 * MB, 'public'); P.checkLimit(100 * MB, 'courier');
  assert.throws(() => P.checkLimit(100 * MB + 1, 'direct'), (e) => e.code === 'limit');
  assert.throws(() => P.checkLimit(50 * MB + 1, 'public'), (e) => e.code === 'limit');
  assert.throws(() => P.checkLimit(100 * MB + 1, 'courier'), (e) => e.code === 'limit');
  fs.writeFileSync(f('besar.bin'), ''); fs.truncateSync(f('besar.bin'), 100 * MB + 1); // sparse: seluruhnya nol, sangat bisa dikompres
  await rejects(() => P.pack(f('besar.bin'), f('besar.pk'), { kind: 'courier' }), 'limit', 'berkas nol 100 MB+1 walau kompresnya kecil');
  assert(!fs.existsSync(f('besar.pk')) && !fs.existsSync(f('besar.pk.part')));
  assert.strictEqual(P.quotaCost({ psize: 1234, size: 99999 }), 1234);
  ok('batas 100/50/100 MB dihitung pada ukuran asli (berkas nol yang kecil setelah kompres tetap ditolak); kuota kurir pakai ukuran terkompres');

  // ---- 9. bom kompresi: 60 MB nol diklaim 1 MB ----
  const bomb = zlib.brotliCompressSync(Buffer.alloc(60 * MB), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } });
  fs.writeFileSync(f('bom.pk'), bomb);
  const bm = { v: 1, mode: 'br', size: 1 * MB, psize: bomb.length, hash: '0'.repeat(64) };
  await rejects(() => P.unpack(f('bom.pk'), f('bom.out'), bm), 'bomb', 'bom kompresi');
  assert(!fs.existsSync(f('bom.out')) && !fs.existsSync(f('bom.out.part')));
  ok('bom kompresi (' + bomb.length + ' byte -> 60 MB, diklaim 1 MB) dihentikan, tidak ada berkas tertinggal');

  // ---- 10. hash, ukuran, dan data rusak ----
  fs.writeFileSync(f('b.txt'), logText(500 * 1024, 5));
  r = await P.pack(f('b.txt'), f('b.pk'));
  await rejects(() => P.unpack(r.path, f('b.out'), Object.assign({}, r.meta, { hash: 'a'.repeat(64) })), 'hash', 'hash salah');
  await rejects(() => P.unpack(r.path, f('b.out'), Object.assign({}, r.meta, { size: r.meta.size - 1 })), 'bomb', 'size diklaim lebih kecil');
  await rejects(() => P.unpack(r.path, f('b.out'), Object.assign({}, r.meta, { size: r.meta.size + 1 })), 'size', 'size diklaim lebih besar');
  await rejects(() => P.unpack(r.path, f('b.out'), Object.assign({}, r.meta, { psize: r.meta.psize + 1 })), 'size', 'psize tidak sama dengan berkas');
  const raw = fs.readFileSync(r.path);
  fs.writeFileSync(f('b-trunc.pk'), raw.subarray(0, raw.length - 50));
  await rejects(() => P.unpack(f('b-trunc.pk'), f('b.out'), Object.assign({}, r.meta, { psize: raw.length - 50 })), 'corrupt', 'terpotong');
  const flip = Buffer.from(raw); flip[Math.floor(flip.length / 2)] ^= 0xff;
  fs.writeFileSync(f('b-flip.pk'), flip);
  try { await P.unpack(f('b-flip.pk'), f('b.out'), r.meta); assert.fail('byte terbalik harus ditolak'); }
  catch (e) { assert(['corrupt', 'hash', 'size', 'bomb'].includes(e.code), 'kode ' + e.code); }
  assert(!fs.existsSync(f('b.out')) && !fs.existsSync(f('b.out.part')));
  // raw yang diubah satu byte
  fs.writeFileSync(f('r.bin'), rand(300 * 1024));
  const rr = await P.pack(f('r.bin'), f('r.pk'));
  const rb = fs.readFileSync(f('r.bin')); rb[100] ^= 1; fs.writeFileSync(f('r2.bin'), rb);
  await rejects(() => P.unpack(f('r2.bin'), f('r.out'), rr.meta), 'hash', 'raw diubah satu byte');
  ok('hash salah, ukuran tidak cocok, terpotong, byte terbalik, raw diubah: semua ditolak, tidak ada berkas tertinggal');

  // ---- 11. meta tidak valid ----
  const good = r.meta;
  for (const [label, m] of [
    ['null', null], ['mode asing', { ...good, mode: 'gz' }], ['versi', { ...good, v: 2 }], ['hash pendek', { ...good, hash: 'abc' }],
    ['size negatif', { ...good, size: -1 }], ['size pecahan', { ...good, size: 1.5 }], ['raw psize beda', { v: 1, mode: 'raw', size: 5, psize: 6, hash: '0'.repeat(64) }],
  ]) await rejects(() => P.unpack(r.path, f('m.out'), m), 'meta', 'meta ' + label);
  await rejects(() => P.unpack(r.path, f('m.out'), { ...good, size: 100 * MB + 1 }), 'limit', 'size melebihi batas global');
  await rejects(() => P.unpack(r.path, f('m.out'), { ...good, size: 51 * MB }, { kind: 'public' }), 'limit', 'size > batas publik');
  ok('meta tidak valid atau melebihi batas ditolak sebelum menyentuh data');

  // ---- 12. progres: naik terus, berakhir tepat di total ----
  const ev = [];
  r = await P.pack(f('log.txt'), f('log2.pk'), { onProgress: (p) => ev.push(p) });
  assert(ev.length >= 2 && ev.every((p, i) => p.total === 2 * MB && (i === 0 || p.done >= ev[i - 1].done)));
  assert.strictEqual(ev[ev.length - 1].done, 2 * MB);
  const ev2 = [];
  await P.unpack(r.path, f('log2.out'), r.meta, { onProgress: (p) => ev2.push(p) });
  assert.strictEqual(ev2[ev2.length - 1].done, 2 * MB);
  ok('progres kompres dan dekompres monoton dan berakhir tepat di ukuran asli');

  // ---- 13. pembatalan ----
  const ac = new AbortController();
  const pr = P.pack(f('log.txt'), f('batal.pk'), { signal: ac.signal, level: 11 });
  setTimeout(() => ac.abort(), 5);
  let abortErr = null;
  try { await pr; } catch (e) { abortErr = e; }
  assert(abortErr && abortErr.name === 'AbortError', 'harus AbortError, dapat: ' + (abortErr && abortErr.name));
  assert(!fs.existsSync(f('batal.pk')) && !fs.existsSync(f('batal.pk.part')));
  ok('pembatalan di tengah jalan tidak meninggalkan berkas');

  // ---- 14. loop event tidak macet saat kompres level 11 ----
  fs.writeFileSync(f('lama.txt'), logText(3 * MB, 11));
  let last = Date.now(), maxGap = 0;
  const hb = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
  const t0 = Date.now();
  r = await P.pack(f('lama.txt'), f('lama.pk'));
  const dt = Date.now() - t0;
  clearInterval(hb);
  assert.strictEqual(r.meta.mode, 'br');
  assert(maxGap < 250, 'event loop tertahan ' + maxGap + ' ms');
  ok('kompres 3 MB level 11 (' + (dt / 1000).toFixed(1) + ' dtk) tanpa menahan event loop (jeda terpanjang ' + maxGap + ' ms)');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nSEMUA TES PACK LULUS (' + pass + ')');
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
