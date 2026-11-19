'use strict';
// Tes 5d-1: format arsip halaman (src/archne-pagearc.js). Wadah saja: penulis satu lintasan, pembaca menolak arsip jahat.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const A = require('../src/archne-pagearc');
const { ArcWriter, ArcReader, ArcError, encFoot, decFoot, FOOT_LEN, HEAD_LEN, MAGIC, CHUNK } = A;
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagearc-'));
const F = (n) => path.join(dir, n);
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const rejects = async (p, code, msg) => { try { await p; } catch (e) { assert(e instanceof ArcError, msg + ' (bukan ArcError: ' + e + ')'); assert.strictEqual(e.code, code, msg + ' (kode ' + e.code + ')'); return; } assert.fail(msg + ' (tidak ditolak)'); };
const openRej = async (f, code, msg) => rejects(ArcReader.open(f), code, msg);
// Susun arsip dengan manifest SEMBARANG tapi footer dan hash yang benar (untuk menguji pembaca terhadap manifest jahat).
function forge(name, payload, manifestObj) {
  const man = Buffer.from(typeof manifestObj === 'string' ? manifestObj : JSON.stringify(manifestObj));
  const off = HEAD_LEN + payload.length;
  fs.writeFileSync(F(name), Buffer.concat([MAGIC, payload, man, encFoot(off, man.length, sha(man))]));
  return F(name);
}
const man = (entries, extra) => Object.assign({ v: 1, created: 1, meta: {}, entries }, extra || {});
const ent = (n, o, buf) => ({ n, o, s: buf.length, h: sha(buf).toString('hex') });

(async () => {
  // A. bolak-balik: buffer, berkas, entri kosong, meta
  const big = crypto.randomBytes(CHUNK * 2 + 12345), small = Buffer.from('halo dunia ☃'), src = F('src.bin');
  fs.writeFileSync(src, big);
  const w = await ArcWriter.create(F('a.arc'));
  assert(!fs.existsSync(F('a.arc')), 'berkas akhir belum ada sebelum finish');
  let seen = 0;
  await w.addBuffer('p/0123456789abcdef.json', small);
  await w.addFile('media/img.bin', src, { onBytes: (n) => { seen += n; }, expectSize: big.length });
  await w.addBuffer('kosong', Buffer.alloc(0));
  const fin = await w.finish({ owner: 'ab'.repeat(8), note: 'x' });
  assert.strictEqual(seen, big.length); assert.strictEqual(fin.entries, 3); assert.strictEqual(fin.size, fs.statSync(F('a.arc')).size);
  assert(!fs.existsSync(F('a.arc.tmp')), 'tmp diganti nama');
  const r = await ArcReader.open(F('a.arc'));
  assert.deepStrictEqual(r.names(), ['p/0123456789abcdef.json', 'media/img.bin', 'kosong']);
  assert.deepStrictEqual(r.meta, { owner: 'ab'.repeat(8), note: 'x' }); assert(r.created > 0);
  assert.deepStrictEqual(r.info('media/img.bin'), { size: big.length, hash: sha(big).toString('hex') }); assert.strictEqual(r.info('nope'), null);
  assert(r.has('kosong') && !r.has('nope'));
  assert(r.readBuffer && (await r.readBuffer('p/0123456789abcdef.json')).equals(small), 'buffer kembali persis');
  assert.strictEqual((await r.readBuffer('kosong')).length, 0, 'entri kosong');
  const parts = []; let mx = 0;
  await r.read('media/img.bin', (c) => { mx = Math.max(mx, c.length); parts.push(Buffer.from(c)); });
  assert(Buffer.concat(parts).equals(big), 'berkas besar kembali persis'); assert(mx <= CHUNK && parts.length === 3, 'dialirkan berpotongan, bukan utuh');
  await r.verifyAll(); await r.close();
  ok('bolak-balik: buffer, berkas berpotongan, entri kosong, meta; berkas akhir baru ada setelah finish');

  // B. kodek footer di atas 4 GiB
  for (const off of [0, 8, TWOGB(), 2 ** 32 + 5, 2 ** 40 + 123, Number.MAX_SAFE_INTEGER - 99]) {
    const h = sha(Buffer.from(String(off))), d = decFoot(encFoot(off, 77, h));
    assert(d && d.off === off && d.len === 77 && d.hash.equals(h), 'footer posisi ' + off);
  }
  assert.strictEqual(decFoot(Buffer.alloc(FOOT_LEN)), null); assert.strictEqual(decFoot(Buffer.alloc(3)), null);
  ok('footer: posisi 64-bit (di atas 4 GiB) bolak-balik; footer kosong / pendek ditolak');
  function TWOGB() { return 2 * 1024 * 1024 * 1024; }

  // C. arsip rusak / terpotong / bukan arsip
  const good = fs.readFileSync(F('a.arc'));
  const put = (n, b) => { fs.writeFileSync(F(n), b); return F(n); };
  await openRej(put('c1', Buffer.alloc(0)), 'bad', 'berkas kosong');
  await openRej(put('c2', Buffer.from('bukan arsip sama sekali, hanya teks biasa yang cukup panjang untuk lewat ukuran minimum')), 'bad', 'bukan arsip');
  await openRej(put('c3', good.slice(0, good.length - 1)), 'bad', 'footer terpotong 1 byte');
  await openRej(put('c4', good.slice(0, good.length - FOOT_LEN)), 'bad', 'tanpa footer');
  await openRej(put('c5', Buffer.concat([good, Buffer.from('x')])), 'bad', 'sisa di belakang footer');
  await openRej(put('c6', Buffer.concat([Buffer.from('ARCHPGA2'), good.slice(8)])), 'bad', 'magic kepala salah');
  const m1 = Buffer.from(good); m1[good.length - FOOT_LEN - 5] ^= 1; // satu bit di manifest
  await openRej(put('c7', m1), 'hash', 'manifest dibalik 1 bit');
  const m2 = Buffer.from(good); m2[100] ^= 1; // satu bit di isi: arsip tetap terbuka, tapi entri itu gagal diverifikasi
  const r2 = await ArcReader.open(put('c8', m2));
  await rejects(r2.verify('media/img.bin'), 'hash', 'isi dibalik 1 bit ditolak saat dibaca'); await r2.close();
  ok('arsip rusak: kosong, bukan arsip, terpotong, tanpa footer, sisa di belakang, magic salah, manifest dibalik, isi dibalik');

  // D. manifest jahat (hash footer benar, isinya bohong)
  const pa = Buffer.from('AAAA'), pb = Buffer.from('BB');
  const both = Buffer.concat([pa, pb]);
  const e1 = ent('a', 8, pa), e2 = ent('b', 12, pb);
  const rd0 = await ArcReader.open(forge('d0', both, man([e1, e2]))); assert.strictEqual(rd0.names().length, 2, 'bentuk sah dulu diterima'); await rd0.verifyAll(); await rd0.close();
  const cases = [
    ['v=2', man([e1, e2], { v: 2 })], ['bukan objek', '[]'], ['bukan JSON', '{{{'], ['created bukan angka', man([e1, e2], { created: 'x' })],
    ['meta larik', man([e1, e2], { meta: [] })], ['entries bukan larik', man([e1, e2], { entries: {} })],
    ['nama ../', man([Object.assign({}, e1, { n: '../x' }), e2])], ['nama /abs', man([Object.assign({}, e1, { n: '/etc/passwd' }), e2])],
    ['nama a/../b', man([Object.assign({}, e1, { n: 'a/../b' }), e2])], ['nama titik di depan', man([Object.assign({}, e1, { n: '.rahasia' }), e2])],
    ['nama backslash', man([Object.assign({}, e1, { n: 'a\\b' }), e2])], ['nama kosong', man([Object.assign({}, e1, { n: '' }), e2])],
    ['nama kelewat dalam', man([Object.assign({}, e1, { n: 'a/b/c/d/e/f' }), e2])], ['nama ganda', man([e1, Object.assign({}, e2, { n: 'a' })])],
    ['tumpang tindih', man([e1, Object.assign({}, e2, { o: 10 })])], ['ada jarak', man([e1, Object.assign({}, e2, { o: 13 })])],
    ['melewati manifest', man([e1, Object.assign({}, e2, { s: 3 })])], ['byte tak terdaftar', man([e1])],
    ['ukuran negatif', man([e1, Object.assign({}, e2, { s: -1 })])], ['ukuran pecahan', man([Object.assign({}, e1, { s: 4.5 }), e2])],
    ['ukuran raksasa', man([Object.assign({}, e1, { s: 2 ** 60 }), e2])], ['hash bukan heks', man([e1, Object.assign({}, e2, { h: 'zz' })])],
    ['hash huruf besar', man([Object.assign({}, e1, { h: e1.h.toUpperCase() }), e2])], ['entri null', man([e1, null])],
  ];
  let n = 0;
  for (const [label, m] of cases) { await openRej(forge('dx' + n++, both, m), 'bad', 'manifest jahat: ' + label); }
  await openRej(forge('dbig', both, man(new Array(A.ENTRIES_MAX + 1).fill(e1))), 'bad', 'entri melebihi batas');
  // footer menunjuk manifest raksasa / posisi di dalam kepala
  const mb = Buffer.from(JSON.stringify(man([e1, e2])));
  fs.writeFileSync(F('df1'), Buffer.concat([MAGIC, both, mb, encFoot(HEAD_LEN + both.length, A.MANIFEST_MAX + 1, sha(mb))]));
  await openRej(F('df1'), 'bad', 'panjang manifest melebihi batas');
  fs.writeFileSync(F('df2'), Buffer.concat([MAGIC, both, mb, encFoot(2, mb.length, sha(mb))]));
  await openRej(F('df2'), 'bad', 'posisi manifest di dalam kepala');
  ok('manifest jahat (' + (cases.length + 3) + ' bentuk): versi, nama tak aman, ganda, tumpang tindih, jarak, byte tersembunyi, ukuran, hash, batas jumlah dan ukuran');

  // E. penulis: nama, batal, kegagalan, atomik
  const w2 = await ArcWriter.create(F('e1.arc'));
  for (const bad of ['', '../x', '/abs', 'a b', 'a//b', '.x', 'a/b/c/d/e/f', 'x'.repeat(65), 5, null]) await rejects(w2.addBuffer(bad, small), 'name', 'nama ditolak: ' + String(bad));
  await w2.addBuffer('ok', small); await rejects(w2.addBuffer('ok', small), 'name', 'nama ganda ditolak');
  await rejects(w2.addBuffer('buf', 'bukan buffer'), 'bad', 'isi bukan Buffer');
  await w2.addFile('tidakada', F('tidak-ada-berkas')).then(() => assert.fail('sumber hilang harus gagal'), (e) => assert.strictEqual(e.code, 'ENOENT'));
  await w2.addFile('tetap', src); // penulis tetap sah setelah kegagalan (di atas) ...
  await rejects(w2.addFile('sz', src, { expectSize: big.length + 1 }), 'size', 'ukuran berubah saat disalin');
  const ac = new AbortController(); ac.abort();
  await rejects(w2.addFile('btl', src, { signal: ac.signal }), 'abort', 'dibatalkan');
  await w2.addBuffer('akhir', pb);
  await w2.finish();
  const r4 = await ArcReader.open(F('e1.arc'));
  assert.deepStrictEqual(r4.names(), ['ok', 'tetap', 'akhir'], 'entri yang gagal tidak terdaftar, urutan terjaga');
  await r4.verifyAll(); assert.strictEqual(r4.size, fs.statSync(F('e1.arc')).size, 'sisa byte entri gagal dipangkas'); await r4.close();
  assert.deepStrictEqual(r4.meta, {}, 'meta bawaan objek kosong');
  ok('penulis: nama tak sah dan ganda ditolak; gagal / batal / ukuran berubah tidak merusak arsip; sisa byte dipangkas');

  // F. abort tidak menyentuh berkas akhir yang sudah ada; finish dua kali ditolak
  fs.writeFileSync(F('f.arc'), 'LAMA');
  const w3 = await ArcWriter.create(F('f.arc')); await w3.addBuffer('x', small);
  assert(fs.existsSync(F('f.arc.tmp')));
  await w3.abort(); await w3.abort();
  assert.strictEqual(fs.readFileSync(F('f.arc'), 'utf8'), 'LAMA', 'berkas akhir lama utuh'); assert(!fs.existsSync(F('f.arc.tmp')), 'tmp dibuang');
  await rejects(w3.addBuffer('y', small), 'dead', 'tulis setelah abort'); await rejects(w3.finish(), 'dead', 'finish setelah abort');
  const w4 = await ArcWriter.create(F('g.arc')); await w4.finish(); await rejects(w4.finish(), 'dead', 'finish dua kali');
  await w4.abort(); assert(fs.existsSync(F('g.arc')), 'abort sesudah finish tidak menghapus hasil');
  const rg = await ArcReader.open(F('g.arc')); assert.strictEqual(rg.entries.length, 0, 'arsip tanpa entri sah'); await rg.close();
  await rejects(w4.addBuffer('z', small), 'dead', 'tulis setelah finish');
  const w5 = await ArcWriter.create(F('h.arc')); await rejects(w5.finish([1]), 'bad', 'meta larik ditolak'); await w5.abort();
  await rejects(ArcWriter.create(''), 'bad', 'nama arsip kosong');
  ok('abort: berkas lama utuh dan tmp dibuang; finish dua kali / tulis sesudah selesai ditolak; arsip tanpa entri sah');

  // G. pembaca: nama tak ada, batas readBuffer, batal baca, 2 penulis bersamaan tidak bertabrakan
  const r5 = await ArcReader.open(F('a.arc'));
  await rejects(r5.read('nope', () => {}), 'name', 'entri tidak ada'); await rejects(r5.readBuffer('nope'), 'name', 'readBuffer tidak ada');
  await rejects(r5.readBuffer('media/img.bin', 100), 'limit', 'melebihi batas diminta ditolak sebelum dibaca');
  assert.strictEqual((await r5.readBuffer('media/img.bin', big.length)).length, big.length, 'tepat di batas boleh');
  const ac2 = new AbortController(); let got = 0;
  await rejects(r5.read('media/img.bin', () => { if (++got === 1) ac2.abort(); }, { signal: ac2.signal }), 'abort', 'baca dibatalkan di tengah'); assert.strictEqual(got, 1);
  const w6 = await ArcWriter.create(F('i.arc')); const pr = w6.addBuffer('a', big);
  await rejects(w6.addBuffer('b', small), 'dead', 'dua tulis bersamaan: yang kedua ditolak'); await pr; await w6.finish();
  await r5.close();
  ok('pembaca: entri tak ada, batas readBuffer, pembatalan baca; penulisan bersamaan ditolak');

  console.log('\n' + pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
