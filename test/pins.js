'use strict';
// Tes sematan pesan (langkah 1 / pin1): model data, tiga lingkup (grup / DM / pribadi), batas 100, admin yang dicopot, validasi penerima,
// pembersihan data, pesan kontrol, dan konvergensi (semua permutasi + acak) dengan beberapa admin yang bekerja bersamaan.
const assert = require('assert');
const Pin = require('../src/archne-pins');

let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const id = (c) => c.repeat(16);
const OWN = id('a'), ADM = id('b'), MEM = id('c'), EXA = id('d'), OUT = id('e'), SND = id('f');
const mid = (n) => n.toString(16).padStart(32, '0');
let n = 0;
const pidOf = (by) => by.slice(0, 10) + (++n).toString(16).padStart(6, '0'); // ID sematan sah: awalan = awalan ID penyemat
const rnd = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const grp = () => ({ id: id('9'), creator: OWN, admins: [ADM, EXA], members: [OWN, ADM, EXA, MEM].map((x) => ({ id: x })), removed: false });
const msg = (k, o) => Object.assign({ kind: 'msg', text: 'Rapat jam 9 ya', from: SND, name: 'Budi', at: 5, mid: mid(k) }, o || {});
const tx = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map((p) => [x].concat(p))));
const canon = (m) => JSON.stringify(Object.values(m).sort((a, b) => (a.id < b.id ? -1 : 1)));

// 1. membuat sematan bersama di grup: admin dan pemilik boleh; member dan orang luar tidak; isi dibersihkan
{
  const g = grp(), pol = Pin.groupPolicy(g), m = {};
  const a = Pin.create(m, pol, ADM, pidOf(ADM), msg(1, { text: '  Rapat\u202e   jam\u0007 9  ', name: ' Bu\ndi ' }), 100);
  assert.strictEqual(a.text, 'Rapat jam 9'); assert.strictEqual(a.name, 'Bu di'); assert.strictEqual(a.by, ADM);
  assert.strictEqual(a.v, 1); assert.strictEqual(a.del, false); assert.strictEqual(a.kind, 'msg'); assert.strictEqual(a.from, SND);
  assert.strictEqual(a.mid, mid(1)); assert.strictEqual(a.at, 5); assert.strictEqual(a.ts, 100);
  Pin.create(m, pol, OWN, pidOf(OWN), msg(2), 101);
  assert(/admin atau pemilik/.test(tx(() => Pin.create(m, pol, MEM, pidOf(MEM), msg(3), 1))), 'member biasa ditolak');
  assert(/admin atau pemilik/.test(tx(() => Pin.create(m, pol, OUT, pidOf(OUT), msg(3), 1))), 'orang luar ditolak');
  assert(/ID sematan/.test(tx(() => Pin.create(m, pol, ADM, pidOf(OWN), msg(3), 1))), 'ID berawalan orang lain ditolak');
  assert(/ID sematan/.test(tx(() => Pin.create(m, pol, ADM, 'bukanhex', msg(3), 1))));
  assert(/tidak valid/.test(tx(() => Pin.create(m, pol, 'zz', pidOf(ADM), msg(3), 1))));
  assert(/sudah ada/.test(tx(() => Pin.create(m, pol, ADM, a.id, msg(3), 1))));
  assert(/Jenis/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(3, { kind: 'x' }), 1))));
  assert(/Pesan yang disematkan/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(3, { mid: 'abc' }), 1))), 'id pesan harus 32 hex');
  assert(/Pesan yang disematkan/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(3, { from: 'zz' }), 1))));
  assert(/kosong/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(3, { text: ' \n\u200b ' }), 1))));
  assert(/tidak valid/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(3, { text: ['x'] }), 1))), 'teks harus string');
  assert.strictEqual(Object.keys(m).length, 2, 'yang gagal tidak meninggalkan apa pun');
  ok('membuat di grup: admin/pemilik boleh, member dan orang luar ditolak, isi dibersihkan, ID dan data pesan divalidasi');
}

// 2. jenis berkas dan pengumuman
{
  const pol = Pin.groupPolicy(grp()), m = {};
  const f = Pin.create(m, pol, ADM, pidOf(ADM), msg(1, { kind: 'file', text: '📎 laporan.pdf' }), 10);
  assert.strictEqual(f.kind, 'file'); assert.strictEqual(f.text, '📎 laporan.pdf');
  const nt = Pin.create(m, pol, ADM, pidOf(ADM), { kind: 'note', text: 'Pengumuman: libur Jumat', name: 'Admin Budi' }, 20);
  assert.strictEqual(nt.kind, 'note'); assert.strictEqual(nt.from, ADM, 'pengirim pengumuman = penyemat'); assert.strictEqual(nt.mid, ''); assert.strictEqual(nt.at, 20);
  assert(/Pesan yang disematkan/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(9, { kind: 'file', mid: undefined }), 1))), 'berkas tetap butuh pesan asal');
  const nt2 = Pin.create(m, pol, ADM, pidOf(ADM), { kind: 'note', text: 'x', from: SND, mid: mid(77) }, 30);
  assert.strictEqual(nt2.from, ADM); assert.strictEqual(nt2.mid, '', 'pengumuman mengabaikan from/mid yang diselipkan');
  assert(/admin atau pemilik/.test(tx(() => Pin.create(m, pol, MEM, pidOf(MEM), { kind: 'note', text: 'x' }, 1))), 'member tidak bisa membuat pengumuman bersama');
  ok('berkas (label saja) dan pengumuman bebas; pengumuman tidak membawa pesan asal');
}

// 3. teks panjang dipotong, baris baru dipertahankan, surrogate tidak terpenggal, pembersihan idempoten
{
  const pol = Pin.selfPolicy(MEM), m = {};
  const long = Pin.create(m, pol, MEM, pidOf(MEM), msg(1, { text: 'x'.repeat(Pin.PIN_TEXT_MAX + 5000) }), 1);
  assert.strictEqual(long.text.length, Pin.PIN_TEXT_MAX); assert(long.text.endsWith('…'));
  const emo = Pin.create(m, pol, MEM, pidOf(MEM), msg(2, { text: 'a'.repeat(Pin.PIN_TEXT_MAX - 2) + '😀😀' }), 2);
  assert(!/[\ud800-\udbff]…$/.test(emo.text), 'pasangan surrogate tidak terpenggal'); assert(emo.text.length <= Pin.PIN_TEXT_MAX);
  const ml = Pin.create(m, pol, MEM, pidOf(MEM), msg(3, { text: 'baris 1\r\n\r\n\r\n\r\nbaris   2 \u2028 sambung' }), 3);
  assert.strictEqual(ml.text, 'baris 1\n\nbaris 2 sambung', 'baris baru dipertahankan, baris kosong berlebih diringkas');
  for (const r of [long, emo, ml]) assert.strictEqual(Pin.cleanText(r.text), r.text, 'pembersihan idempoten');
  assert.strictEqual(Pin.cleanLabel(null), ''); assert.strictEqual(Pin.cleanLabel('x'.repeat(100)).length, Pin.PIN_NAME_MAX);
  ok('teks panjang dipotong dengan …, baris baru dipertahankan, surrogate utuh, pembersihan idempoten');
}

// 4. batas 100 per lingkup; melepas membebaskan tempat; pesan yang sama tidak bisa disematkan dua kali
{
  const pol = Pin.groupPolicy(grp()), m = {};
  for (let i = 1; i <= 100; i++) Pin.create(m, pol, ADM, pidOf(ADM), msg(i), i);
  assert(/100 sematan/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(101), 101))), 'yang ke-101 ditolak');
  assert(/100 sematan/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), { kind: 'note', text: 'x' }, 101))), 'pengumuman ikut dihitung');
  assert.strictEqual(Pin.live(m).length, 100);
  const first = Object.values(m).find((c) => c.mid === mid(1));
  Pin.remove(m, pol, OWN, first.id, 200);
  assert.strictEqual(Pin.live(m).length, 99);
  Pin.create(m, pol, ADM, pidOf(ADM), msg(101), 201); // melepas membebaskan tempat
  assert.strictEqual(Pin.live(m).length, 100);
  const mm = {};
  const p1 = Pin.create(mm, pol, ADM, pidOf(ADM), msg(1), 1);
  assert(/sudah disematkan/.test(tx(() => Pin.create(mm, pol, OWN, pidOf(OWN), msg(1), 2))), 'pesan yang sama ditolak, juga oleh admin lain');
  Pin.remove(mm, pol, ADM, p1.id, 3);
  Pin.create(mm, pol, OWN, pidOf(OWN), msg(1), 4); // setelah dilepas boleh lagi
  const sp = Pin.selfPolicy(MEM), sm = {};
  for (let i = 1; i <= 100; i++) Pin.create(sm, sp, MEM, pidOf(MEM), msg(i), i);
  assert(/100 sematan/.test(tx(() => Pin.create(sm, sp, MEM, pidOf(MEM), msg(101), 101))), 'sematan pribadi juga 100');
  ok('batas 100 per lingkup (bersama dan pribadi); melepas membebaskan tempat; pesan yang sama tidak dua kali');
}

// 5. melepas: admin/pemilik mana pun; member dan admin yang sudah dicopot tidak; sematan mantan admin tetap sampai admin aktif melepasnya
{
  const g = grp(), pol = Pin.groupPolicy(g), m = {};
  const a = Pin.create(m, pol, EXA, pidOf(EXA), msg(1), 10), b = Pin.create(m, pol, ADM, pidOf(ADM), msg(2), 11);
  assert(/admin atau pemilik/.test(tx(() => Pin.remove(m, pol, MEM, b.id, 20))), 'member tidak bisa melepas');
  assert(/admin atau pemilik/.test(tx(() => Pin.remove(m, pol, OUT, b.id, 20))));
  assert(/tidak ditemukan/.test(tx(() => Pin.remove(m, pol, ADM, 'ffffffffffffffff', 20))));
  const r = Pin.remove(m, pol, OWN, b.id, 21); // pemilik melepas sematan admin
  assert.strictEqual(r.del, true); assert.strictEqual(r.v, 2); assert.strictEqual(r.ts, 21);
  assert(/tidak ditemukan/.test(tx(() => Pin.remove(m, pol, OWN, b.id, 22))), 'melepas dua kali ditolak');
  g.admins = g.admins.filter((x) => x !== EXA); // EXA dicopot dari admin
  assert(/admin atau pemilik/.test(tx(() => Pin.remove(m, pol, EXA, a.id, 30))), 'mantan admin tidak bisa melepas sematannya sendiri');
  assert(/admin atau pemilik/.test(tx(() => Pin.create(m, pol, EXA, pidOf(EXA), msg(5), 31))), 'mantan admin tidak bisa menyematkan lagi');
  assert.deepStrictEqual(Pin.live(m).map((c) => c.id), [a.id], 'sematan mantan admin tetap tampil');
  Pin.remove(m, pol, ADM, a.id, 40); // admin aktif melepasnya
  assert.strictEqual(Pin.live(m).length, 0);
  g.members = g.members.filter((x) => x.id !== ADM); // admin dikeluarkan dari grup: kehilangan hak juga
  assert(/admin atau pemilik/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(6), 50))));
  ok('melepas: admin/pemilik mana pun; member dan mantan admin tidak; sematan mantan admin tetap sampai admin aktif melepas');
}

// 6. edit: hanya pengumuman, urutan (ts) tetap, versi naik hanya bila isi berubah
{
  const pol = Pin.groupPolicy(grp()), m = {};
  const nt = Pin.create(m, pol, ADM, pidOf(ADM), { kind: 'note', text: 'Libur Jumat' }, 10), mp = Pin.create(m, pol, ADM, pidOf(ADM), msg(1), 11);
  const e = Pin.edit(m, pol, OWN, nt.id, '  Libur Jumat\ndan Sabtu ', 99); // pemilik boleh mengedit pengumuman admin
  assert.strictEqual(e.text, 'Libur Jumat\ndan Sabtu'); assert.strictEqual(e.v, 2); assert.strictEqual(e.ts, 10, 'urutan tidak berubah');
  assert.strictEqual(Pin.edit(m, pol, ADM, nt.id, 'Libur Jumat\ndan Sabtu', 100).v, 2, 'isi sama: versi tidak naik');
  assert(/Hanya pengumuman/.test(tx(() => Pin.edit(m, pol, ADM, mp.id, 'x', 1))), 'isi salinan pesan tidak bisa diubah');
  assert(/admin atau pemilik/.test(tx(() => Pin.edit(m, pol, MEM, nt.id, 'x', 1))));
  assert(/kosong/.test(tx(() => Pin.edit(m, pol, ADM, nt.id, '  ', 1))));
  Pin.remove(m, pol, ADM, nt.id, 101);
  assert(/tidak ditemukan/.test(tx(() => Pin.edit(m, pol, ADM, nt.id, 'x', 1))));
  ok('edit: hanya pengumuman, urutan tetap, versi naik hanya bila isi berubah');
}

// 7. DM: kedua orang boleh menyematkan dan melepas milik satu sama lain; orang lain tidak; peserta harus dua ID berbeda
{
  const A = id('1'), B = id('2'), pol = Pin.dmPolicy(A, B), m = {};
  const x = Pin.create(m, pol, A, pidOf(A), msg(1), 1), y = Pin.create(m, pol, B, pidOf(B), msg(2), 2);
  assert(/bukan peserta/.test(tx(() => Pin.create(m, pol, OUT, pidOf(OUT), msg(3), 3))));
  Pin.remove(m, pol, B, x.id, 4); Pin.remove(m, pol, A, y.id, 5);
  assert.strictEqual(Pin.live(m).length, 0);
  const z = Pin.create(m, pol, A, pidOf(A), msg(9), 7);
  assert(/bukan peserta/.test(tx(() => Pin.remove(m, pol, OUT, z.id, 8))));
  assert(/tidak valid/.test(tx(() => Pin.dmPolicy(A, A))) && /tidak valid/.test(tx(() => Pin.dmPolicy(A, 'zz'))));
  ok('DM: kedua orang boleh menyematkan dan melepas milik satu sama lain; orang lain tidak');
}

// 8. pribadi: milik sendiri saja (juga untuk member biasa dan di Publik), dihapus langsung tanpa tombstone
{
  const pol = Pin.selfPolicy(MEM), m = {};
  const a = Pin.create(m, pol, MEM, pidOf(MEM), msg(1), 1);
  assert(/pemiliknya/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), msg(2), 2))), 'milik orang lain ditolak');
  assert(/pemiliknya/.test(tx(() => Pin.remove(m, pol, ADM, a.id, 3))));
  const r = Pin.remove(m, pol, MEM, a.id, 4);
  assert.strictEqual(r.del, true); assert.strictEqual(m[a.id], undefined, 'dihapus langsung, tanpa tombstone');
  assert.strictEqual(Pin.create(m, pol, MEM, pidOf(MEM), { kind: 'note', text: 'catatan pribadi' }, 5).kind, 'note', 'catatan pribadi boleh');
  assert(/tidak valid/.test(tx(() => Pin.selfPolicy('zz'))));
  ok('pribadi: milik sendiri saja, dihapus langsung (tanpa tombstone), independen dari peran di grup');
}

// 9. tampilan: terbaru di atas, tombstone tidak tampil, paling banyak 100
{
  const pol = Pin.groupPolicy(grp()), m = {};
  const a = Pin.create(m, pol, ADM, pidOf(ADM), msg(1), 10), b = Pin.create(m, pol, ADM, pidOf(ADM), msg(2), 30), c = Pin.create(m, pol, ADM, pidOf(ADM), msg(3), 20);
  assert.deepStrictEqual(Pin.live(m).map((x) => x.id), [b.id, c.id, a.id], 'ts menurun');
  Pin.remove(m, pol, ADM, c.id, 40);
  assert.deepStrictEqual(Pin.live(m).map((x) => x.id), [b.id, a.id]);
  const big = {};
  for (let i = 0; i < 150; i++) { const r = Pin.cleanRec({ id: pidOf(SND), by: SND, kind: 'msg', text: 't' + i, from: SND, mid: mid(1000 + i), ts: i, v: 1 }); big[r.id] = r; }
  const v = Pin.live(big);
  assert.strictEqual(v.length, 100); assert.strictEqual(v[0].text, 't149'); assert.strictEqual(v[99].text, 't50', 'yang tampil 100 terbaru');
  const eq = {};
  for (const k of ['aa', 'bb']) { const r = Pin.cleanRec({ id: SND.slice(0, 10) + k + '0000', by: SND, kind: 'note', text: k, ts: 5, v: 1 }); eq[r.id] = r; }
  assert.deepStrictEqual(Pin.live(eq).map((x) => x.text), ['aa', 'bb'], 'ts sama: urut id');
  ok('tampilan: terbaru di atas, tombstone tersembunyi, maksimal 100, urutan tetap untuk ts sama');
}

// 10. penerima: sematan baru hanya dari yang berhak; admin aktif boleh mengumumkan ulang sematan mantan admin; tombstone final
{
  const g = grp(), pol = Pin.groupPolicy(g), m = {};
  const r1 = Pin.create({}, pol, ADM, pidOf(ADM), msg(1), 10); // pengirim membuat di petanya sendiri lalu menyiarkan rekamannya
  assert.strictEqual(Pin.applyRemote(m, pol, ADM, r1), 'applied');
  assert.deepStrictEqual(Pin.live(m).map((x) => x.id), [r1.id]);
  assert.strictEqual(Pin.applyRemote(m, pol, ADM, r1), 'stale', 'ulang: sudah sama');
  assert.strictEqual(Pin.applyRemote(m, pol, MEM, Object.assign({}, r1, { id: pidOf(MEM), by: MEM })), 'reject', 'member tidak bisa menyiarkan sematan bersama');
  assert.strictEqual(Pin.applyRemote(m, pol, OUT, Object.assign({}, r1, { id: pidOf(ADM), mid: mid(2) })), 'reject', 'orang luar ditolak');
  assert.strictEqual(Pin.applyRemote(m, pol, ADM, Object.assign({}, r1, { id: pidOf(OWN), mid: mid(2) })), 'reject', 'ID berawalan orang lain (by tidak cocok)');
  // mantan admin: sematannya sudah ada di admin lain; admin aktif mengumumkan ulang ke anggota baru
  const old = Pin.create({}, pol, EXA, pidOf(EXA), msg(2), 11);
  g.admins = g.admins.filter((x) => x !== EXA);
  const fresh = {};
  assert.strictEqual(Pin.applyRemote(fresh, pol, EXA, old), 'reject', 'mantan admin sendiri tidak bisa menyiarkan');
  assert.strictEqual(Pin.applyRemote(fresh, pol, OWN, old), 'applied', 'admin/pemilik aktif mengumumkan ulang (by = mantan admin)');
  assert.strictEqual(fresh[old.id].by, EXA, 'penyemat asli tetap tercatat');
  const unpin = Pin.remove(clone(fresh), pol, ADM, old.id, 50);
  assert.strictEqual(Pin.applyRemote(fresh, pol, ADM, unpin), 'applied', 'admin aktif melepas sematan mantan admin');
  assert.strictEqual(Pin.live(fresh).length, 0);
  // tombstone untuk sematan yang belum dikenal diterima (supaya tidak hidup lagi), tapi hanya dari yang berhak
  const tomb = Object.assign({}, r1, { id: pidOf(ADM), mid: mid(3), del: true, v: 2, ts: 60 });
  assert.strictEqual(Pin.applyRemote(m, pol, MEM, tomb), 'reject');
  assert.strictEqual(Pin.applyRemote(m, pol, ADM, tomb), 'applied');
  assert.strictEqual(Pin.applyRemote(m, pol, ADM, Object.assign({}, tomb, { del: false, v: 1, ts: 1 })), 'stale', 'tombstone final: tidak hidup lagi');
  assert.strictEqual(Pin.applyRemote(m, pol, ADM, Object.assign({}, tomb, { del: false, v: 99, ts: 99999 })), 'stale', 'bahkan dengan versi lebih tinggi');
  g.removed = true;
  assert.strictEqual(Pin.applyRemote({}, pol, OWN, r1), 'reject', 'grup yang sudah kutinggalkan menolak semuanya');
  ok('penerima: sematan baru hanya dari admin/pemilik; admin aktif mengumumkan ulang milik mantan admin; tombstone final');
}

// 11. penerima: pembaruan hanya yang sah; kolom tetap tidak bisa diubah; isi sematan pesan tidak bisa diubah; sampah ditolak
{
  const g = grp(), pol = Pin.groupPolicy(g), m = {};
  const mp = Pin.create(m, pol, ADM, pidOf(ADM), msg(1), 10), nt = Pin.create(m, pol, ADM, pidOf(ADM), { kind: 'note', text: 'v1' }, 11);
  const base = (r, o) => Object.assign(clone(r), o);
  const rx = clone(m);
  assert.strictEqual(Pin.applyRemote(rx, pol, MEM, base(nt, { text: 'x', v: 2 })), 'reject', 'member tidak bisa mengedit');
  assert.strictEqual(Pin.applyRemote(rx, pol, OWN, base(nt, { text: 'v2', v: 2 })), 'applied', 'pemilik mengedit pengumuman admin');
  assert.strictEqual(rx[nt.id].text, 'v2');
  assert.strictEqual(Pin.applyRemote(rx, pol, OWN, base(nt, { text: 'v1', v: 1 })), 'stale', 'versi lama');
  assert.strictEqual(Pin.applyRemote(rx, pol, OWN, base(mp, { text: 'diganti', v: 2 })), 'reject', 'isi salinan pesan tidak bisa diubah');
  for (const [k, val] of [['by', OWN], ['kind', 'note'], ['from', MEM], ['mid', mid(55)], ['at', 999], ['name', 'Palsu']])
    assert.strictEqual(Pin.applyRemote(rx, pol, OWN, base(mp, { [k]: val, v: 2 })), 'reject', 'kolom tetap: ' + k);
  assert.strictEqual(Pin.applyRemote(rx, pol, MEM, base(mp, { del: true, v: 2, ts: 70 })), 'reject', 'member tidak bisa melepas');
  assert.strictEqual(Pin.applyRemote(rx, pol, EXA, base(mp, { del: true, v: 2, ts: 70 })), 'applied', 'admin aktif melepas');
  g.admins = g.admins.filter((x) => x !== EXA);
  assert.strictEqual(Pin.applyRemote(rx, pol, EXA, base(mp, { del: true, v: 3, ts: 80 })), 'reject', 'mantan admin tidak bisa mengubah tombstone');
  for (const bad of [null, 1, 'x', [], {}, { id: 1 }, base(nt, { id: [nt.id] }), base(nt, { by: [OWN] }), base(nt, { v: 0 }), base(nt, { v: 1.5 }), base(nt, { v: 1e9 }), base(nt, { text: '' }), base(nt, { text: 5 }), base(mp, { mid: 'x' }), base(mp, { kind: 'zzz' })])
    assert.strictEqual(Pin.applyRemote({}, pol, ADM, bad), 'reject', 'sampah ditolak: ' + JSON.stringify(bad));
  assert.strictEqual(Pin.applyRemote({}, pol, 'zz', base(nt)), 'reject');
  assert.strictEqual(Pin.applyRemote({}, pol, [ADM], base(nt, { id: pidOf(ADM) })), 'reject');
  ok('penerima: pembaruan hanya dari yang berhak, kolom tetap dan isi pesan tidak bisa diubah, sampah ditolak');
}

// 12. DM di penerima: penyemat harus peserta; kedua pihak bisa melepas; pribadi menolak semua kiriman jaringan
{
  const A = id('1'), B = id('2'), pa = Pin.dmPolicy(A, B), pb = Pin.dmPolicy(B, A);
  const ma = {}, mb = {};
  const r = Pin.create(ma, pa, A, pidOf(A), msg(1), 1);
  assert.strictEqual(Pin.applyRemote(mb, pb, A, r), 'applied');
  assert.strictEqual(Pin.applyRemote({}, pb, OUT, r), 'reject', 'bukan peserta');
  assert.strictEqual(Pin.applyRemote({}, pb, A, Object.assign({}, r, { id: pidOf(OUT), by: OUT })), 'reject', 'penyemat harus peserta DM');
  const t = Pin.remove(mb, pb, B, r.id, 5); // B melepas sematan milik A
  assert.strictEqual(Pin.applyRemote(ma, pa, B, t), 'applied');
  assert.strictEqual(Pin.live(ma).length, 0); assert.strictEqual(Pin.live(mb).length, 0);
  assert.strictEqual(Pin.applyRemote({}, Pin.selfPolicy(A), B, r), 'reject', 'pribadi tidak pernah menerima dari jaringan');
  ok('DM di penerima: penyemat harus peserta, kedua pihak bisa melepas; pribadi menolak semua kiriman jaringan');
}

// 13. batas dari jaringan: 200 hidup; tombstone dipangkas 200 (terlama dulu); yang hidup tidak pernah dibuang
{
  const pol = Pin.groupPolicy(grp()), m = {};
  const note = (t, ts, o) => Object.assign({ id: pidOf(ADM), by: ADM, kind: 'note', text: t, ts, v: 1 }, o || {});
  for (let i = 0; i < 200; i++) assert.strictEqual(Pin.applyRemote(m, pol, ADM, note('n' + i, i)), 'applied');
  assert.strictEqual(Pin.applyRemote(m, pol, ADM, note('lebih', 999)), 'reject', 'melewati 200 hidup ditolak');
  assert.strictEqual(Pin.live(m).length, 100, 'tampil tetap 100');
  assert(/100 sematan/.test(tx(() => Pin.create(m, pol, ADM, pidOf(ADM), { kind: 'note', text: 'x' }, 5))), 'membuat lokal tetap ditolak');
  const d = {};
  for (let i = 0; i < 300; i++) Pin.applyRemote(d, pol, ADM, note('d', 1000 + i, { v: 2, del: true }));
  assert.strictEqual(Object.values(d).filter((c) => c.del).length, Pin.PIN_MAX_DEAD);
  assert.strictEqual(Math.min(...Object.values(d).map((c) => c.ts)), 1100, 'yang terlama yang dibuang');
  const mix = {}, lv = [];
  for (let i = 0; i < 50; i++) lv.push(Pin.create(mix, pol, ADM, pidOf(ADM), { kind: 'note', text: 'h' + i }, i));
  for (let i = 0; i < 300; i++) Pin.applyRemote(mix, pol, ADM, note('d', 5000 + i, { v: 2, del: true }));
  assert(lv.every((r) => mix[r.id] && !mix[r.id].del), 'sematan hidup tidak ikut terbuang');
  ok('batas jaringan: 200 hidup, tombstone dipangkas ke 200 (terlama dulu), yang hidup tak pernah dibuang');
}

// 14. data dari disk dibersihkan; batas dipaksakan deterministik
{
  const good = { id: pidOf(ADM), by: ADM, kind: 'msg', text: 'Halo', from: SND, name: 'Budi', at: 1, mid: mid(1), ts: 5, v: 1, del: false };
  const zid = good.id.slice(0, 15) + 'z';
  const noText = Object.assign({}, good, { id: pidOf(ADM), text: '' });
  const out = Pin.clean({ [good.id]: good, salah: good, kosong: null, x1: 'x', x2: [], [noText.id]: noText, [zid]: Object.assign({}, good, { id: zid }) });
  assert.deepStrictEqual(Object.keys(out), [good.id], 'kunci tak cocok, id bukan hex, null, string, array, teks kosong: dibuang');
  assert.deepStrictEqual(Pin.clean(null), {}); assert.deepStrictEqual(Pin.clean([good]), {}); assert.deepStrictEqual(Pin.clean('x'), {});
  const dirty = Pin.clean({ [good.id]: Object.assign({}, good, { text: 'a\u0007b\u202e', name: 'N\nm', ekstra: 'x', v: 3 }) })[good.id];
  assert.strictEqual(dirty.text, 'a b'); assert.strictEqual(dirty.name, 'N m'); assert.strictEqual(dirty.ekstra, undefined); assert.strictEqual(dirty.v, 3);
  const many = {};
  for (let i = 0; i < 260; i++) { const r = Object.assign({}, good, { id: pidOf(ADM), mid: mid(100 + i), ts: i }); many[r.id] = r; }
  const c = Pin.clean(many), vals = Object.values(c);
  assert.strictEqual(vals.length, Pin.PIN_MAX_STORE); assert.strictEqual(Math.min(...vals.map((x) => x.ts)), 60, 'yang terbaru dipertahankan');
  assert.deepStrictEqual(Pin.clean(clone(c)), c, 'membersihkan dua kali = sama');
  assert.deepStrictEqual(Pin.clean({ a: { id: pidOf(ADM), by: ADM, kind: 'note', text: 'x', v: 1 } }), {}, 'kunci harus sama dengan id');
  ok('clean: rekaman rusak dibuang, isi dibersihkan, kolom asing dibuang, batas deterministik, idempoten');
}

// 15. pesan kontrol: bulat-pulang, bukan kontrol = null, rusak = [], pembagian per jumlah dan per byte, tanpa kolom asing
{
  const pol = Pin.groupPolicy(grp());
  const r = Pin.create({}, pol, ADM, pidOf(ADM), msg(1, { text: 'Rapat 😀 jam 9' }), 10);
  r.rahasia = 'jangan bocor';
  const t = Pin.encodeCtl([r]);
  assert(t.startsWith(Pin.CTL)); assert(!t.includes('rahasia'), 'hanya kolom publik');
  const back = Pin.parseCtl(t);
  assert.strictEqual(back.length, 1); assert.strictEqual(Pin.applyRemote({}, pol, ADM, back[0]), 'applied');
  assert.strictEqual(Pin.parseCtl('halo'), null); assert.strictEqual(Pin.parseCtl(5), null);
  assert.strictEqual(Pin.parseCtl('\u0001vch:[]'), null, 'bukan milik channel voice grup'); assert.strictEqual(Pin.parseCtl('\u0001pvch:[]'), null, 'bukan milik channel publik');
  assert.deepStrictEqual(Pin.parseCtl(Pin.CTL + '{rusak'), []); assert.deepStrictEqual(Pin.parseCtl(Pin.CTL + '{"a":1}'), []);
  assert.strictEqual(Pin.parseCtl(Pin.CTL + JSON.stringify(new Array(50).fill({}))).length, Pin.PIN_MAX_PER_MSG, 'penerima hanya membaca PIN_MAX_PER_MSG');
  assert.strictEqual(Pin.parseCtl(Pin.encodeCtl(new Array(30).fill(r))).length, Pin.PIN_MAX_PER_MSG, 'encodeCtl memotong jumlah');
  // pembagian per jumlah: 100 rekaman penuh teks -> 10 pesan, semua rekaman terbawa tepat sekali
  const big = [];
  for (let i = 0; i < 100; i++) big.push(Pin.cleanRec({ id: pidOf(ADM), by: ADM, kind: 'note', text: '日'.repeat(Pin.PIN_TEXT_MAX), ts: i, v: 1 }));
  const parts = Pin.encodeAll(big);
  assert.strictEqual(parts.length, 100, 'rekaman 10.000 karakter CJK (~30 KB) tidak muat berdua: satu per pesan');
  const got = parts.flatMap((p) => { assert(Buffer.byteLength(p) <= Pin.PIN_MAX_CTL_BYTES); return Pin.parseCtl(p); });
  assert.deepStrictEqual(got.map((x) => x.id), big.map((x) => x.id));
  // pembagian per byte: rekaman mentah besar (di luar batas teks normal) tetap dipecah di bawah batas byte
  const huge = []; for (let i = 0; i < 5; i++) huge.push(Object.assign(clone(big[0]), { id: pidOf(ADM), text: 'x'.repeat(12000) }));
  const hp = Pin.encodeAll(huge);
  assert.deepStrictEqual(hp.map((p) => Pin.parseCtl(p).length), [2, 2, 1]);
  assert(hp.every((p) => Buffer.byteLength(p) <= Pin.PIN_MAX_CTL_BYTES));
  // satu salinan terburuk (10.000 karakter CJK ~30 KB) harus muat sendirian dalam satu pesan kontrol, dan tidak ada yang digabung melewati batas
  const one = Pin.encodeAll([big[0]]); assert.strictEqual(one.length, 1); assert(Buffer.byteLength(one[0]) <= Pin.PIN_MAX_CTL_BYTES, 'satu salinan 10.000 CJK muat dalam batas byte');
  assert.strictEqual(Pin.parseCtl(one[0])[0].text.length, Pin.PIN_TEXT_MAX);
  const quo = Pin.cleanRec({ id: pidOf(ADM), by: ADM, kind: 'note', text: '\\"'.repeat(Pin.PIN_TEXT_MAX / 2), ts: 1, v: 1 });
  assert(Buffer.byteLength(Pin.encodeAll([quo])[0]) <= Pin.PIN_MAX_CTL_BYTES, 'karakter yang di-escape JSON (kutip, garis miring) juga muat');
  assert.deepStrictEqual(Pin.encodeAll([]), []);
  ok('pesan kontrol: bulat-pulang, awalan tidak tertukar dengan vch/pvch, rusak aman, dibagi per jumlah dan per byte, tanpa kolom asing');
}

// 16. konvergensi: urutan tiba apa pun menghasilkan keadaan yang sama (edit dan hapus bersamaan; tombstone selalu menang)
{
  const g = grp(), pol = Pin.groupPolicy(g);
  const origin = {};
  const c0 = Pin.create(origin, pol, ADM, pidOf(ADM), { kind: 'note', text: 'awal' }, 10);
  const r1 = clone(c0);
  const sa = clone(origin), e2 = Pin.edit(sa, pol, OWN, c0.id, 'edit dari pemilik', 11); // v2
  const sb = clone(origin), e2b = Pin.edit(sb, pol, ADM, c0.id, 'edit dari admin', 12); // v2 bersamaan, isi lain
  const sc = clone(sa); const e3 = Pin.edit(sc, pol, OWN, c0.id, 'edit lagi', 13); // v3
  const sd = clone(origin), tomb = Pin.remove(sd, pol, EXA, c0.id, 14); // v2, dihapus bersamaan dengan edit v3
  const recs = [[ADM, r1], [OWN, clone(e2)], [ADM, clone(e2b)], [OWN, clone(e3)], [EXA, clone(tomb)]];
  const finals = new Set();
  for (const p of perms(recs)) {
    const m = {};
    for (const [from, r] of p) Pin.applyRemote(m, pol, from, r);
    finals.add(canon(m));
    assert.strictEqual(Pin.live(m).length, 0, 'tombstone menang atas edit v3 dalam urutan apa pun');
  }
  assert.strictEqual(finals.size, 1, 'semua 120 urutan menghasilkan keadaan yang sama');
  // tanpa tombstone: edit bersamaan dengan versi sama diputuskan deterministik (versi, lalu ts, lalu isi)
  const f2 = new Set(), noTomb = recs.slice(0, 4);
  for (const p of perms(noTomb)) { const m = {}; for (const [from, r] of p) Pin.applyRemote(m, pol, from, r); f2.add(canon(m)); }
  assert.strictEqual(f2.size, 1); assert.strictEqual(Object.values(JSON.parse([...f2][0]))[0].text, 'edit lagi', 'versi tertinggi menang');
  ok('konvergensi: semua urutan tiba menghasilkan keadaan yang sama; tombstone selalu menang atas edit bersamaan');
}

// 17. konvergensi acak: tiga admin bekerja bersamaan di replika masing-masing, pesan tiba acak dan ganda
{
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rnd(seed), g = grp(), pol = Pin.groupPolicy(g), actors = [OWN, ADM, EXA], R = [{}, {}, {}], log = [];
    let ts = 0, mc = 0;
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const emit = (from, rec) => log.push([from, clone(rec)]);
    for (let step = 0; step < 90; step++) {
      const k = Math.floor(rand() * 3), map = R[k], by = actors[k], lv = Pin.live(map), x = rand();
      if (x < 0.4 || !lv.length) emit(by, Pin.create(map, pol, by, pidOf(by), rand() < 0.5 ? { kind: 'note', text: 'n' + step } : msg(++mc, { text: 'm' + step }), ++ts));
      else if (x < 0.7) { const notes = lv.filter((c) => c.kind === 'note'); if (notes.length) emit(by, Pin.edit(map, pol, by, pick(notes).id, 'e' + step + '-' + k, ++ts)); }
      else emit(by, Pin.remove(map, pol, by, pick(lv).id, ++ts));
      if (log.length && rand() < 0.35) { const [from, rec] = pick(log); Pin.applyRemote(R[Math.floor(rand() * 3)], pol, from, rec); } // pengiriman di tengah jalan
    }
    const shuffled = () => { const a = log.concat(log); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    for (const map of R) for (const [from, rec] of shuffled()) Pin.applyRemote(map, pol, from, rec);
    assert.strictEqual(canon(R[0]), canon(R[1]), 'replika 0 dan 1 sama (seed ' + seed + ')');
    assert.strictEqual(canon(R[1]), canon(R[2]), 'replika 1 dan 2 sama (seed ' + seed + ')');
    assert.strictEqual(JSON.stringify(Pin.live(R[0])), JSON.stringify(Pin.live(R[2])), 'tampilan sama');
    const fresh = {}; for (const [from, rec] of shuffled()) Pin.applyRemote(fresh, pol, from, rec); // anggota baru yang menerima semuanya sekaligus
    assert.strictEqual(JSON.stringify(Pin.live(fresh)), JSON.stringify(Pin.live(R[0])), 'anggota baru melihat hal yang sama');
  }
  ok('konvergensi acak: 60 skenario, tiga admin bersamaan, pesan acak dan ganda, anggota baru ikut sama');
}

console.log(pass + ' tes lulus');
