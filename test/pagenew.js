'use strict';
// Tes Halaman 5b-1: penanda "ada postingan baru" (src/archne-pagenew.js), murni lokal. Tanpa Core, tanpa jaringan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { PageNew, PGN_MAX, PGN_POLL } = require('../src/archne-pagenew');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagenew-'));
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const hex = (n) => n.toString(16).padStart(16, '0');
const P = (ts, n) => ({ ts, id: hex(n === undefined ? ts : n) });
const A = hex(1), B = hex(2), C = hex(3);
const thr = (f) => { try { f(); } catch (e) { return e.message; } return null; };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// 1. garis dasar diam; postingan lebih baru menyalakan; markSeen memadamkan
{
  const f = path.join(tmp, 'a', 'pgnew.json'), q = new PageNew(f);
  assert.strictEqual(q.size, 0); assert.strictEqual(fs.existsSync(f), false, 'membuat objek tidak menulis berkas');
  assert.strictEqual(q.observe(A, P(100)), false, 'pengamatan pertama = garis dasar, tidak menyala');
  assert.strictEqual(q.has(A), false); assert.deepStrictEqual(q.list(), []);
  assert.strictEqual(fs.existsSync(f), true, 'garis dasar disimpan (folder bersarang dibuat penulis bawaan)');
  assert.strictEqual(q.observe(A, P(100)), false, 'sama persis = tidak berubah');
  assert.strictEqual(q.observe(A, P(200)), true, 'lebih baru menyalakan'); assert.strictEqual(q.has(A), true); assert.deepStrictEqual(q.list(), [A]);
  assert.strictEqual(q.observe(A, P(300)), false, 'sudah menyala, tetap menyala = status tidak berubah'); assert.strictEqual(q.has(A), true);
  assert.strictEqual(q.markSeen(A), true, 'dibuka = padam'); assert.strictEqual(q.has(A), false);
  assert.strictEqual(q.markSeen(A), false, 'padam lagi tidak mengubah apa pun');
  assert.strictEqual(q.markSeen(B), false, 'pemilik tak dikenal: false'); assert.strictEqual(q.size, 1, 'markSeen tidak membuat entri');
  assert.strictEqual(q.observe(A, P(300)), false, 'postingan yang sama dengan yang sudah dilihat tidak menyala');
  assert.strictEqual(q.observe(A, P(301)), true);
  ok('garis dasar diam, lebih baru menyala, markSeen memadamkan, tak dikenal tidak membuat entri');
}

// 2. halaman kosong saat garis dasar lalu terisi = menyala; kosong lagi = padam
{
  const q = new PageNew(path.join(tmp, 'b.json'));
  assert.strictEqual(q.observe(A, null), false); assert.strictEqual(q.has(A), false); assert.strictEqual(q.size, 1, 'kosong tetap dicatat sebagai garis dasar');
  assert.strictEqual(q.observe(A, undefined), false, 'undefined = null');
  assert.strictEqual(q.observe(A, P(50)), true, 'kosong -> ada postingan = menyala'); assert.strictEqual(q.has(A), true);
  assert.strictEqual(q.observe(A, null), true, 'halaman jadi kosong / tak terlihat: lencana padam'); assert.strictEqual(q.has(A), false);
  assert.strictEqual(q.observe(A, P(50)), true, 'terisi lagi sesudah kosong = menyala lagi (s ikut dikosongkan)');
  ok('halaman kosong: garis dasar null, terisi menyala, kosong lagi padam');
}

// 3. postingan terbaru dihapus: s turun ke l, postingan baru di antaranya tetap menyala
{
  const q = new PageNew(path.join(tmp, 'c.json'));
  q.observe(A, P(500)); assert.strictEqual(q.has(A), false);
  assert.strictEqual(q.observe(A, P(400)), false, 'terbaru dihapus: tidak menyala'); assert.strictEqual(q.has(A), false);
  assert.strictEqual(q.observe(A, P(450)), true, 'postingan baru dengan ts di antara 400 dan 500 tetap terlihat baru');
  // sudah pernah melihat postingan, lalu halaman jadi kosong / tak terlihat (semua dihapus, atau berhenti berteman): tidak melempar, lalu postingan baru menyala
  const r = new PageNew(path.join(tmp, 'c2.json')); r.observe(A, P(100)); r.observe(A, P(200)); r.markSeen(A);
  assert.strictEqual(r.observe(A, null), false, 'kosong sesudah melihat: tidak menyala, tidak melempar'); assert.strictEqual(r.has(A), false);
  assert.strictEqual(r.observe(A, P(50)), true, 'postingan baru (ts lebih kecil dari yang pernah dilihat) tetap menyala: s dikosongkan');
  ok('postingan terbaru dihapus menurunkan titik "sudah dilihat"; halaman kosong sesudah dilihat mengosongkannya');
}

// 4. urutan: ts lalu id; ts sama id lebih besar = baru, id lebih kecil = bukan
{
  const q = new PageNew(path.join(tmp, 'd.json'));
  q.observe(A, { ts: 10, id: hex(5) });
  assert.strictEqual(q.observe(A, { ts: 10, id: hex(4) }), false, 'ts sama, id lebih kecil = bukan baru');
  assert.strictEqual(q.observe(A, { ts: 10, id: hex(6) }), true, 'ts sama, id lebih besar = baru');
  assert.strictEqual(q.markSeen(A), true); assert.strictEqual(q.observe(A, { ts: 10, id: hex(6) }), false, 'sudah dilihat: sama persis tidak menyala');
  assert.strictEqual(q.observe(B, { ts: 9, id: hex(9) }), false);
  assert.strictEqual(q.observe(B, { ts: 10, id: hex(1) }), true, 'ts lebih besar menang walau id lebih kecil');
  assert.deepStrictEqual(q.list(), [B], 'A sudah ditandai dilihat, hanya B menyala');
  assert.strictEqual(q.observe(A, { ts: 11, id: hex(1) }), true);
  assert.deepStrictEqual(q.list(), [A, B].sort(), 'list urut id');
  ok('urutan ts lalu id, list urut');
}

// 5. masukan tak sah melempar tanpa mengubah apa pun
{
  const f = path.join(tmp, 'e.json'), q = new PageNew(f);
  q.observe(A, P(1)); const before = fs.readFileSync(f, 'utf8');
  for (const bad of ['', 'abc', hex(10).toUpperCase(), hex(1) + 'x', null, undefined, 5, {}, []]) if (bad !== null && bad !== undefined) assert.ok(thr(() => q.observe(bad, P(1))), 'id tak sah ditolak: ' + JSON.stringify(bad));
  for (const bad of [{ ts: -1, id: hex(1) }, { ts: 1.5, id: hex(1) }, { ts: '5', id: hex(1) }, { ts: 1, id: 'zz' }, { ts: 1 }, { id: hex(1) }, 'x', 7, [], { ts: Number.MAX_SAFE_INTEGER + 2, id: hex(1) }]) assert.ok(thr(() => q.observe(A, bad)), 'postingan tak sah ditolak: ' + JSON.stringify(bad));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before, 'berkas tidak berubah'); assert.strictEqual(q.size, 1);
  assert.strictEqual(q.has('zz'), false); assert.strictEqual(q.markSeen('zz'), false); assert.strictEqual(q.forget('zz'), false);
  ok('id dan postingan tak sah melempar, keadaan dan berkas utuh');
}

// 6. simpan / buka ulang; berkas diubah tangan dibersihkan
{
  const f = path.join(tmp, 'f.json'), q = new PageNew(f);
  q.observe(A, P(100)); q.observe(A, P(200)); q.observe(B, P(7)); q.observe(C, null);
  const q2 = new PageNew(f);
  assert.strictEqual(q2.size, 3); assert.strictEqual(q2.has(A), true); assert.strictEqual(q2.has(B), false); assert.deepStrictEqual(q2.list(), [A], 'status menyala bertahan di berkas');
  assert.strictEqual(q2.markSeen(A), true); assert.strictEqual(new PageNew(f).has(A), false, 'markSeen tersimpan');
  const hand = (m) => { const g = path.join(tmp, 'g' + Math.random() + '.json'); fs.writeFileSync(g, JSON.stringify(m)); return new PageNew(g); };
  const ok1 = hex(1), ok2 = hex(2);
  const t = hand({ v: 1, m: { [ok1]: { s: [900, hex(1)], l: [100, hex(1)] }, [ok2]: { s: [5, hex(1)], l: null }, nothex: { s: null, l: [1, hex(1)] }, [hex(3)]: { s: null, l: [1, 'zz'] }, [hex(4)]: 'x', [hex(5)]: { s: 'x', l: [3, hex(5)] }, [hex(6)]: null } });
  assert.strictEqual(t.size, 4, 'kunci tak sah dan entri bukan objek dibuang');
  assert.strictEqual(t.has(ok1), false, 's > l diturunkan ke l (tidak menyala)');
  assert.strictEqual(t.has(ok2), false); assert.strictEqual(t.has(hex(3)), false, 'l tak sah = null');
  assert.strictEqual(t.has(hex(5)), true, 's tak sah = null, l sah = menyala');
  for (const junk of ['{tidak json', '[]', 'null', '{"v":2,"m":{}}', '{"v":1,"m":[1,2]}', '{"v":1}', '{"v":1,"m":"x"}']) { const g = path.join(tmp, 'j' + Math.random() + '.json'); fs.writeFileSync(g, junk); assert.strictEqual(new PageNew(g).size, 0, 'rusak / versi asing = kosong: ' + junk); }
  assert.strictEqual(new PageNew(path.join(tmp, 'tidak-ada.json')).size, 0);
  ok('simpan dan buka ulang, berkas diubah tangan dibersihkan, rusak / versi asing = kosong');
}

// 7. gagal tulis memulihkan memori dan melempar
{
  let fail = false, calls = 0;
  const q = new PageNew(path.join(tmp, 'h.json'), () => { calls++; if (fail) throw new Error('disk penuh'); });
  q.observe(A, P(100)); assert.strictEqual(calls, 1);
  q.observe(A, P(100)); assert.strictEqual(calls, 1, 'tanpa perubahan tidak menulis');
  assert.strictEqual(q.markSeen(A), false); assert.strictEqual(q.markSeen(B), false); assert.strictEqual(calls, 1, 'markSeen yang tidak mengubah apa pun (sudah dilihat / tak dikenal) tidak menulis');
  fail = true;
  assert.ok(thr(() => q.observe(A, P(200)))); assert.strictEqual(q.has(A), false, 'observe gagal tulis: memori pulih');
  assert.ok(thr(() => q.observe(B, P(1)))); assert.strictEqual(q.size, 1, 'entri baru gagal tulis: tidak tertinggal');
  fail = false; q.observe(A, P(200)); fail = true;
  assert.ok(thr(() => q.markSeen(A))); assert.strictEqual(q.has(A), true, 'markSeen gagal tulis: tetap menyala');
  assert.ok(thr(() => q.forget(A))); assert.strictEqual(q.size, 1); assert.strictEqual(q.has(A), true, 'forget gagal tulis: entri kembali');
  q.observe; fail = false; q.observe(B, P(1)); fail = true;
  assert.ok(thr(() => q.retain((k) => k === C))); assert.strictEqual(q.size, 2, 'retain gagal tulis: semua kembali'); assert.strictEqual(q.has(A), true);
  ok('gagal tulis: observe, markSeen, forget, retain memulihkan memori; tanpa perubahan tidak menulis');
}

// 8. forget / retain
{
  const f = path.join(tmp, 'i.json'), q = new PageNew(f);
  q.observe(A, P(1)); q.observe(A, P(2)); q.observe(B, P(1)); q.observe(C, P(1)); q.polled(A, 1000); q.polled(B, 1000);
  assert.strictEqual(q.forget(B), true); assert.strictEqual(q.forget(B), false); assert.strictEqual(q.size, 2); assert.strictEqual(new PageNew(f).size, 2, 'forget tersimpan');
  assert.strictEqual(q.due(B, 1000), true, 'jadwal pemilik yang dilupakan ikut hilang');
  assert.strictEqual(q.retain((k) => k === A), 1, 'C dibuang'); assert.deepStrictEqual(q.list(), [A]); assert.strictEqual(new PageNew(f).size, 1);
  assert.strictEqual(q.retain(() => true), 0, 'tidak ada yang dibuang = 0');
  const w = fs.statSync(f).mtimeMs; assert.strictEqual(q.retain(() => true), 0); assert.strictEqual(fs.statSync(f).mtimeMs, w, 'retain tanpa pembuangan tidak menulis');
  q.polled(C, 5); q.retain((k) => k === A); assert.strictEqual(q.due(C, 5), true, 'retain juga membuang jadwal pemilik yang tidak dipertahankan, walau tanpa entri');
  ok('forget dan retain: tersimpan, jadwal ikut dibuang, tanpa pembuangan tidak menulis');
}

// 9. batas PGN_MAX: yang baru tidak dilacak, yang lama tidak dibuang, yang sudah ada tetap bisa diperbarui
{
  const q = new PageNew(path.join(tmp, 'k.json'));
  for (let i = 1; i <= PGN_MAX; i++) q.observe(hex(i), P(1));
  assert.strictEqual(q.size, PGN_MAX);
  assert.strictEqual(q.observe(hex(PGN_MAX + 1), P(1)), false); assert.strictEqual(q.size, PGN_MAX, 'penuh: yang baru diabaikan');
  assert.strictEqual(q.has(hex(PGN_MAX + 1)), false);
  assert.strictEqual(q.observe(hex(1), P(2)), true, 'yang sudah dilacak tetap diperbarui'); assert.strictEqual(q.has(hex(1)), true);
  const f = path.join(tmp, 'k2.json'), m = {}; for (let i = 1; i <= PGN_MAX + 5; i++) m[hex(i)] = { s: null, l: [1, hex(1)] };
  fs.writeFileSync(f, JSON.stringify({ v: 1, m })); assert.strictEqual(new PageNew(f).size, PGN_MAX, 'berkas membengkak dipotong saat dibuka');
  ok('batas PGN_MAX: baru diabaikan, lama utuh dan tetap bisa diperbarui, berkas membengkak dipotong');
}

// 10. jadwal tanya hanya di memori
{
  const f = path.join(tmp, 'l.json'), q = new PageNew(f);
  assert.strictEqual(q.due(A, 0), true, 'belum pernah ditanya = jatuh tempo');
  q.polled(A, 1000); assert.strictEqual(q.due(A, 1000), false); assert.strictEqual(q.due(A, 1000 + PGN_POLL - 1), false); assert.strictEqual(q.due(A, 1000 + PGN_POLL), true, 'tepat PGN_POLL = jatuh tempo');
  assert.strictEqual(q.due(B, 1000), true, 'per pemilik');
  q.polled(A, 2000); q.soon(A); assert.strictEqual(q.due(A, 2000), true, 'soon = langsung jatuh tempo');
  assert.strictEqual(fs.existsSync(f), false, 'jadwal tidak menulis berkas');
  q.observe(A, P(1)); q.polled(A, 3000); assert.strictEqual(new PageNew(f).due(A, 3000), true, 'jadwal tidak disimpan: objek baru menanyai lagi');
  assert.ok(PGN_POLL >= 60e3, 'selang wajar (tidak membanjiri pemilik)');
  ok('jadwal tanya: per pemilik, tepat PGN_POLL, soon, tidak disimpan');
}

console.log('\n' + pass + ' kelompok lulus');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
