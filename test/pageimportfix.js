'use strict';
// Tes 5d-7 (perbaikan hasil audit 5d-4): (1) sisa .tmp gambar dibuang saat start, (2) lampiran yatim akibat crash dibuang lewat jurnal impor,
// (3) id yang muncul di store selagi lampiran disalin menjadi same / conflict, bukan galat yang menghentikan seluruh impor.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { PageStore } = require('../src/archne-pagestore');
const { ArcWriter } = require('../src/archne-pagearc');
const { importArchive } = require('../src/archne-pageimport');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pageimportfix-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const out = (n) => path.join(tmp, n);
const J = (o) => Buffer.from(JSON.stringify(o));
const H = (n) => n.toString(16).padStart(16, '0');
const post = (id, x) => Object.assign({ v: 1, id, ts: 1700000000000, kind: 'text', text: 'halo ' + id, priv: 'public' }, x || {});
const fl = (i, b) => ({ id: i, name: 'b.bin', size: b.length });
const files = (dir) => { const r = []; (function w(d) { try { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) w(f); else r.push(path.relative(dir, f)); } } catch {} })(dir); return r.sort(); };
async function mk(name, entries) {
  const w = await ArcWriter.create(out(name));
  for (const n of Object.keys(entries)) await w.addBuffer(n, entries[n]);
  await w.finish({ kind: 'archne-pages', fmt: 1, owner: null, posts: Object.keys(entries).filter((n) => /^post\//.test(n)).map((n) => n.slice(5)) });
  return out(name);
}
(async () => {
  // 1. sisa .tmp di media/ files/ videos/ dibuang saat start
  {
    const d = out('S1'); new PageStore(d, { ownerId: H(9) });
    for (const k of ['media', 'files', 'videos']) { fs.mkdirSync(path.join(d, k), { recursive: true }); fs.writeFileSync(path.join(d, k, H(5) + '.png.tmp'), 'x'); }
    new PageStore(d, { ownerId: H(9) });
    assert.deepStrictEqual(files(d).filter((f) => f.endsWith('.tmp')), [], 'semua .tmp dibuang');
  }
  ok('start: sisa .tmp gambar, lampiran, dan video dibuang');

  // 2. crash sesudah lampiran dibuat tetapi sebelum postingan diterima: jurnal membuang lampiran yatim; sesudah postingan diterima, lampiran dipertahankan
  {
    const d = out('S2'), b = Buffer.from('xyz');
    const T = new PageStore(d, { ownerId: H(9) });
    const f = mk('j.arc', { ['post/' + H(1)]: J(post(H(1), { files: [fl(H(71), b)] })), ['file/' + H(71)]: b });
    const real = T.adoptPost.bind(T);
    // simulasi crash: jurnal ditulis dan lampiran ada, tetapi proses "mati" (tanpa pembersihan) = salin keadaan disk saat adoptPost dipanggil
    let snapDir = null;
    T.adoptPost = (p, o) => { snapDir = out('S2crash'); copyDir(d, snapDir); return real(p, o); };
    await importArchive(T, await f);
    assert(snapDir, 'adoptPost sempat dipanggil');
    assert(fs.existsSync(path.join(snapDir, 'import.journal')), 'jurnal ada saat lampiran sudah dibuat dan postingan belum');
    assert(fs.existsSync(path.join(snapDir, 'files', H(71))));
    const R = new PageStore(snapDir, { ownerId: H(9) }); // start ulang sesudah crash
    assert.strictEqual(R.count(), 0);
    assert.deepStrictEqual(files(snapDir).filter((x) => x.startsWith('files') || x === 'import.journal'), [], 'lampiran yatim dan jurnal dibuang');
    // sukses normal: jurnal dihapus, lampiran tetap
    assert(!fs.existsSync(path.join(d, 'import.journal')) && T.count() === 1 && fs.existsSync(path.join(d, 'files', H(71))));
    // crash SESUDAH postingan diterima (jurnal belum sempat dihapus): lampiran dipertahankan
    fs.writeFileSync(path.join(d, 'import.journal'), JSON.stringify({ v: 1, id: H(1), files: ['files/' + H(71)] }));
    const R2 = new PageStore(d, { ownerId: H(9) });
    assert.strictEqual(R2.count(), 1); assert(fs.existsSync(path.join(d, 'files', H(71))) && !fs.existsSync(path.join(d, 'import.journal')));
  }
  ok('crash di sela lampiran dan postingan: lampiran yatim + jurnal dibuang saat start; postingan sudah masuk = lampiran tetap');

  // 2b. jurnal jahat / rusak tidak bisa menyentuh berkas di luar media/ files/ videos/
  {
    const d = out('S3'); const T = new PageStore(d, { ownerId: H(9) }); fs.writeFileSync(path.join(d, 'keep.txt'), 'k');
    fs.writeFileSync(path.join(d, 'import.journal'), JSON.stringify({ v: 1, id: H(2), files: ['../keep.txt', 'keep.txt', 'index.json', 'files/../keep.txt', 'files\\..\\keep.txt', 5] }));
    const R = new PageStore(d, { ownerId: H(9) });
    assert(fs.existsSync(path.join(d, 'keep.txt')) && fs.existsSync(path.join(d, 'index.json')), 'berkas di luar lampiran tak tersentuh');
    assert(!fs.existsSync(path.join(d, 'import.journal')));
    fs.writeFileSync(path.join(d, 'import.journal'), '{bukan json'); new PageStore(d, { ownerId: H(9) }); assert(!fs.existsSync(path.join(d, 'import.journal')));
    void R; void T;
  }
  ok('jurnal jahat atau rusak: hanya jalur lampiran yang sah disentuh, jurnal tetap dibuang');

  // 3. id muncul di store selagi lampiran disalin: same / conflict, impor lanjut, lampiran postingan yang sudah ada tidak dibuang
  {
    const b = Buffer.from('xyz'), b2 = Buffer.from('uvw');
    for (const same of [true, false]) {
      const T = new PageStore(out(same ? 'S4a' : 'S4b'), { ownerId: H(9) });
      const p1 = post(H(1), { files: [fl(H(71), b)] }), p2 = post(H(2), { ts: 1700000000001, files: [fl(H(72), b2)] });
      const f = await mk(same ? 'r4a.arc' : 'r4b.arc', { ['post/' + H(1)]: J(p1), ['file/' + H(71)]: b, ['post/' + H(2)]: J(p2), ['file/' + H(72)]: b2 });
      // saat adoptPost pertama dipanggil, "pihak lain" sudah menaruh postingan H(1) di store (lewat adoptPost asli)
      const real = T.adoptPost.bind(T);
      const origHas = T.has.bind(T); let planted = false;
      T.has = (id) => {
        if (id === H(1) && !planted && fs.existsSync(path.join(out(same ? 'S4a' : 'S4b'), 'files', H(71)))) { // lampiran selesai disalin: sekarang id itu "muncul"
          planted = true;
          real(same ? p1 : post(H(1), { text: 'beda', files: [fl(H(71), b)] }), { defer: false });
        }
        return origHas(id);
      };
      const r = await importArchive(T, f);
      assert(planted, 'skenario terpasang');
      assert.deepStrictEqual(r.imported, [H(2)], 'impor lanjut ke postingan berikutnya');
      if (same) assert.deepStrictEqual(r.same, [H(1)]); else assert.deepStrictEqual(r.conflict, [{ id: H(1), why: 'id' }]);
      assert(fs.existsSync(path.join(out(same ? 'S4a' : 'S4b'), 'files', H(71))), 'lampiran milik postingan yang sudah ada tetap');
      assert(!fs.existsSync(path.join(out(same ? 'S4a' : 'S4b'), 'import.journal')));
    }
  }
  ok('id muncul selagi disalin: dihitung same / conflict, impor lanjut, lampiran postingan yang ada tidak dibuang');
  console.log(pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); });
function copyDir(a, b) { fs.mkdirSync(b, { recursive: true }); for (const n of fs.readdirSync(a)) { const s = path.join(a, n), t = path.join(b, n); if (fs.statSync(s).isDirectory()) copyDir(s, t); else fs.copyFileSync(s, t); } }
