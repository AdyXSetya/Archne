'use strict';
// Tes channel voice publik (v0.20.0, langkah 1 / pvch1): model data, pemilik-saja, PIN 6 angka, batas, urutan versi/tombstone, kontrol tersembunyi.
const assert = require('assert');
const Pv = require('../src/archne-pvch');
const Vc = require('../src/archne-vchan');

let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const id = (c) => c.repeat(16);
const OWN = id('a'), OTH = id('b'), EVIL = id('c');
let n = 0;
const cidOf = (by) => by.slice(0, 10) + (++n).toString(16).padStart(6, '0'); // ID channel sah: awalan = awalan ID pemilik
const rnd = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

// 1. membuat: nama dibersihkan, gratis atau PIN 6 angka, ID harus berawalan ID pemilik
{
  const m = {};
  const a = Pv.create(m, OWN, cidOf(OWN), '  Ngobrol   santai ', null, 10);
  assert.strictEqual(a.name, 'Ngobrol santai'); assert.strictEqual(a.by, OWN);
  assert.strictEqual(a.locked, false); assert.strictEqual(a.salt, ''); assert.strictEqual(a.hash, '');
  assert.strictEqual(a.v, 1); assert.strictEqual(a.del, false);
  const b = Pv.create(m, OWN, cidOf(OWN), 'Rahasia', '123456', 11);
  assert.strictEqual(b.locked, true); assert(/^[0-9a-f]{32}$/.test(b.salt) && /^[0-9a-f]{64}$/.test(b.hash));
  assert(!JSON.stringify(b).includes('123456'), 'PIN polos tidak pernah disimpan');
  assert.strictEqual(Pv.create(m, OWN, cidOf(OWN), 'x', '', 12).locked, false, 'PIN kosong = gratis');
  assert.throws(() => Pv.create(m, OTH, cidOf(OTH), '   ', null, 1), /kosong/);
  assert.throws(() => Pv.create({}, OTH, cidOf(OTH), 'X', '12345', 1), /6 angka/);
  assert.throws(() => Pv.create({}, OTH, cidOf(OTH), 'X', '1234567', 1), /6 angka/);
  assert.throws(() => Pv.create({}, OTH, cidOf(OTH), 'X', 'abcdef', 1), /6 angka/);
  assert.throws(() => Pv.create({}, OTH, cidOf(OTH), 'X', 123456, 1), /6 angka/, 'PIN harus string');
  assert.throws(() => Pv.create({}, OWN, cidOf(OTH), 'X', null, 1), /ID channel/, 'ID berawalan pemilik lain ditolak');
  assert.throws(() => Pv.create({}, OWN, 'bukanhex', 'X', null, 1), /ID channel/);
  assert.throws(() => Pv.create({}, 'zz', cidOf(OWN), 'X', null, 1), /pemilik/);
  assert.throws(() => Pv.create(m, OWN, a.id, 'dobel', null, 1), /sudah ada/);
  assert(Pv.idOwnedBy(Pv.newId(OWN), OWN) && !Pv.idOwnedBy(Pv.newId(OWN), OTH));
  assert(/^[0-9a-f]{16}$/.test(Pv.newId(OWN)));
  ok('membuat: nama bersih, gratis/PIN 6 angka, PIN polos tidak tersimpan, ID wajib berawalan ID pemilik');
}

// 2. hanya pemilik yang boleh hapus, ganti nama, kunci/buka, ganti PIN
{
  const m = {}; const c = Pv.create(m, OWN, cidOf(OWN), 'milikku', null, 1);
  for (const who of [OTH, EVIL]) {
    assert.throws(() => Pv.remove(m, who, c.id, 2), /pemilik channel/);
    assert.throws(() => Pv.update(m, who, c.id, { name: 'x' }, 2), /pemilik channel/);
    assert.throws(() => Pv.update(m, who, c.id, { pin: '111111' }, 2), /pemilik channel/);
    assert(!Pv.canManage(c, who));
  }
  assert(Pv.canManage(c, OWN));
  assert.strictEqual(c.v, 1, 'upaya gagal tidak mengubah apa pun');
  Pv.remove(m, OWN, c.id, 5);
  assert(c.del && c.v === 2 && c.ts === 5);
  assert.throws(() => Pv.remove(m, OWN, c.id, 6), /tidak ditemukan/);
  assert.throws(() => Pv.update(m, OWN, c.id, { name: 'x' }, 6), /tidak ditemukan/);
  assert(!Pv.canManage(c, OWN), 'channel terhapus tidak bisa dikelola');
  ok('hapus/ubah hanya oleh pemilik; tombstone tersimpan; channel terhapus tidak bisa diubah');
}

// 3. ubah: nama, kunci, ganti PIN, buka kunci; versi naik tiap perubahan
{
  const m = {}; const c = Pv.create(m, OWN, cidOf(OWN), 'awal', null, 1);
  Pv.update(m, OWN, c.id, { name: ' baru  ' }, 2);
  assert.strictEqual(c.name, 'baru'); assert.strictEqual(c.v, 2); assert(!c.locked);
  Pv.update(m, OWN, c.id, { pin: '111111' }, 3);
  assert(c.locked && c.v === 3); assert(Pv.checkPin(c, '111111') && !Pv.checkPin(c, '222222'));
  const oldHash = c.hash;
  Pv.update(m, OWN, c.id, { pin: '222222' }, 4);
  assert(c.hash !== oldHash && c.v === 4);
  assert(!Pv.checkPin(c, '111111'), 'PIN lama tidak berlaku lagi');
  assert(Pv.checkPin(c, '222222'));
  Pv.update(m, OWN, c.id, { name: 'ganti nama saja' }, 5);
  assert(Pv.checkPin(c, '222222') && c.locked, 'ganti nama tidak mengubah kunci');
  assert.throws(() => Pv.update(m, OWN, c.id, { pin: '12' }, 6), /6 angka/);
  assert.strictEqual(c.v, 5, 'PIN tidak sah tidak mengubah apa pun');
  Pv.update(m, OWN, c.id, { pin: null }, 6);
  assert(!c.locked && c.salt === '' && c.hash === '' && c.v === 6);
  assert(Pv.checkPin(c, undefined), 'terbuka: tanpa PIN boleh');
  ok('ubah: ganti nama, kunci, ganti PIN (PIN lama mati), buka kunci; versi naik');
}

// 4. PIN dan izin masuk
{
  const m = {};
  const free = Pv.create(m, OWN, cidOf(OWN), 'gratis', null, 1);
  const lock = Pv.create(m, OWN, cidOf(OWN), 'kunci', '123456', 2);
  assert(Pv.canJoin(free, OTH) && Pv.canJoin(free, OWN), 'gratis: siapa saja');
  assert(Pv.canJoin(lock, OWN), 'pemilik masuk tanpa PIN');
  assert(!Pv.canJoin(lock, OTH) && !Pv.canJoin(lock, OTH, '000000') && !Pv.canJoin(lock, OTH, '12345') && !Pv.canJoin(lock, OTH, 123456));
  assert(Pv.canJoin(lock, OTH, '123456'));
  assert(Pv.needsPin(lock, OTH) && !Pv.needsPin(lock, OWN) && !Pv.needsPin(free, OTH));
  assert(!Pv.canJoin(lock, 'zz', '123456'), 'ID tidak sah ditolak');
  assert(!Pv.checkPin(null, '123456') && !Pv.canJoin(null, OTH));
  const l2 = Pv.create(m, OTH, cidOf(OTH), 'kunci2', '123456', 3);
  assert.notStrictEqual(lock.hash, l2.hash, 'PIN sama, salt dan ID beda -> hash beda');
  Pv.remove(m, OWN, lock.id, 4);
  assert(!Pv.canJoin(lock, OWN) && !Pv.canJoin(lock, OTH, '123456') && !Pv.checkPin(lock, '123456'), 'channel terhapus tidak bisa dimasuki');
  assert(!Pv.needsPin(lock, OTH));
  ok('PIN: pemilik tanpa PIN, orang lain harus PIN 6 angka yang benar; terhapus tidak bisa dimasuki');
}

// 5. batas orang per channel
{
  assert.strictEqual(Pv.PV_MAX_MEMBERS, 16);
  assert(Pv.hasRoom(0) && Pv.hasRoom(15));
  assert(!Pv.hasRoom(16) && !Pv.hasRoom(40) && !Pv.hasRoom(-1 / 2) && !Pv.hasRoom('3') && !Pv.hasRoom(NaN));
  ok('kapasitas: maksimal 16 orang per channel');
}

// 6. batas jumlah channel: 3 per pemilik, 200 total, tombstone tidak dihitung
{
  const m = {};
  const mine = [0, 1, 2].map((i) => Pv.create(m, OWN, cidOf(OWN), 'c' + i, null, i));
  assert(!Pv.canCreate(m, OWN));
  assert.throws(() => Pv.create(m, OWN, cidOf(OWN), 'keempat', null, 9), /sudah punya 3/);
  assert(Pv.canCreate(m, OTH), 'orang lain tidak terpengaruh');
  Pv.remove(m, OWN, mine[0].id, 10);
  assert(Pv.canCreate(m, OWN), 'tombstone tidak dihitung');
  Pv.create(m, OWN, cidOf(OWN), 'pengganti', null, 11);
  assert.strictEqual(Pv.live(m).filter((c) => c.by === OWN).length, 3);
  assert(!Pv.canCreate(m, 'zz'));

  const g = {};
  const owners = [];
  for (let i = 0; i < 70; i++) owners.push(i.toString(16).padStart(2, '0').repeat(8));
  let made = 0;
  for (let i = 0; made < Pv.PV_MAX_LIVE; i++) { Pv.create(g, owners[Math.floor(i / 3)], cidOf(owners[Math.floor(i / 3)]), 'c', null, i); made++; }
  assert.strictEqual(Pv.live(g).length, 200);
  assert(!Pv.canCreate(g, owners[69]));
  assert.throws(() => Pv.create(g, owners[69], cidOf(owners[69]), 'lebih', null, 999), /penuh/);
  Pv.remove(g, owners[0], Pv.live(g).find((c) => c.by === owners[0]).id, 1000);
  assert(Pv.canCreate(g, owners[69]));
  ok('batas: 3 per pemilik, 200 total; tombstone membebaskan tempat');
}

// 7. tampilan deterministik: pemilik yang menumpuk >3 hanya 3 (ID terkecil) yang terlihat, apa pun urutan datangnya
{
  const recs = [];
  for (let i = 0; i < 5; i++) recs.push({ id: OWN.slice(0, 10) + i.toString(16).padStart(6, '0'), name: 'c' + i, by: OWN, locked: false, salt: '', hash: '', ts: 100 - i, v: 1, del: false });
  const shown = (order) => { const m = {}; for (const r of order) m[r.id] = r; return Pv.live(m).map((c) => c.id).join(); };
  const base = shown(recs);
  assert.strictEqual(base.split(',').length, 3);
  const r = rnd(7);
  for (let k = 0; k < 20; k++) assert.strictEqual(shown([...recs].sort(() => r() - 0.5)), base);
  assert.deepStrictEqual(base.split(','), recs.slice(0, 3).map((c) => c.id), 'ID terkecil yang terlihat');
  ok('tampilan: batas per pemilik deterministik, tidak bergantung urutan pesan');
}

// 8. applyRemote: hanya penanda tangan = pemilik
{
  const m = {};
  const src = {}; const c = Pv.create(src, OWN, cidOf(OWN), 'dari pemilik', '123456', 5);
  assert.strictEqual(Pv.applyRemote(m, OWN, c), 'applied');
  assert.deepStrictEqual(m[c.id], c);
  assert(Pv.checkPin(m[c.id], '123456'), 'pemeriksa PIN ikut tersebar: node lain bisa memeriksa');
  assert.strictEqual(Pv.applyRemote(m, OWN, c), 'stale', 'sama = stale');
  // orang lain tidak bisa menyiarkan / mengubah / menghapus channel milik pemilik
  assert.strictEqual(Pv.applyRemote({}, OTH, c), 'reject', 'bukan pemilik menyiarkan channel orang');
  const hijack = Object.assign({}, c, { by: OTH, v: 99 });
  assert.strictEqual(Pv.applyRemote(m, OTH, hijack), 'reject', 'ID channel tidak berawalan ID OTH -> ditolak');
  const del = Object.assign({}, c, { del: true, v: 2, ts: 9 });
  assert.strictEqual(Pv.applyRemote(m, OTH, del), 'reject');
  assert.strictEqual(Pv.applyRemote(m, EVIL, del), 'reject');
  assert.strictEqual(m[c.id].del, false);
  // perebutan ID: penyerang menyalin ID channel lalu mengaku pemilik
  const squat = Object.assign({}, c, { by: EVIL });
  assert.strictEqual(Pv.applyRemote({}, EVIL, squat), 'reject', 'menyalin ID channel orang lain tidak mungkin');
  // pemilik sah: ganti nama, kunci, hapus
  const u = Object.assign({}, c, { name: 'baru', v: 2, ts: 6 });
  assert.strictEqual(Pv.applyRemote(m, OWN, u), 'applied'); assert.strictEqual(m[c.id].name, 'baru');
  assert.strictEqual(Pv.applyRemote(m, OWN, c), 'stale', 'versi lama tidak menimpa');
  assert.strictEqual(Pv.applyRemote(m, OWN, Object.assign({}, c, { del: true, v: 3, ts: 7 })), 'applied');
  assert(m[c.id].del);
  assert.strictEqual(Pv.applyRemote(m, OWN, Object.assign({}, c, { v: 50, ts: 99 })), 'stale', 'tombstone final: tidak hidup lagi');
  assert.strictEqual(Pv.applyRemote(m, 'zz', c), 'reject');
  assert.strictEqual(Pv.applyRemote(m, OWN, null), 'reject');
  ok('applyRemote: hanya pemilik; peniru, perebut ID, dan non-pemilik ditolak; tombstone final');
}

// 9. rekaman rusak / berbahaya dari jaringan ditolak
{
  const good = { id: cidOf(OWN), name: 'ok', by: OWN, locked: false, salt: '', hash: '', ts: 1, v: 1, del: false };
  const m = {};
  const bad = [
    null, 'x', [], 42,
    Object.assign({}, good, { name: '   ' }),
    Object.assign({}, good, { id: 'zz' }),
    Object.assign({}, good, { by: 'zz' }),
    Object.assign({}, good, { locked: true }), // terkunci tanpa salt/hash
    Object.assign({}, good, { locked: true, salt: 'ab', hash: 'cd' }),
    Object.assign({}, good, { id: [good.id] }), Object.assign({}, good, { by: [OWN] }), Object.assign({}, good, { id: { toString: () => good.id } }),
    Object.assign({}, good, { v: 0 }), Object.assign({}, good, { v: 1.5 }), Object.assign({}, good, { v: 2e9 }), Object.assign({}, good, { v: '2' }),
  ];
  for (const b of bad) assert.strictEqual(Pv.applyRemote(m, OWN, b), 'reject', JSON.stringify(b));
  assert.deepStrictEqual(m, {});
  const sloppy = Pv.cleanRec(Object.assign({}, good, { name: 'a\u202eb', locked: 'ya', salt: 'x', hash: 'y', ts: 'besok', del: 'ya', extra: 1 }));
  assert.deepStrictEqual(sloppy, { id: good.id, name: 'a b', by: OWN, locked: false, salt: '', hash: '', ts: 0, v: 1, del: false }, 'dinormalkan: bidi dibuang, bidang asing dibuang, locked/del hanya true yang sungguh true');
  const unl = Pv.cleanRec(Object.assign({}, good, { salt: 'a'.repeat(32), hash: 'b'.repeat(64) }));
  assert(unl.salt === '' && unl.hash === '', 'tidak terkunci: salt/hash dibuang');
  ok('rekaman rusak ditolak; yang longgar dinormalkan');
}

// 10. konvergen: urutan pesan acak, hasil sama di semua node
{
  const owners = [OWN, OTH, EVIL];
  const msgs = [];
  const src = {};
  // tiap pemilik: buat, ganti nama, kunci, hapus sebagian
  let ts = 1;
  for (const o of owners) {
    const a = Pv.create(src, o, cidOf(o), 'A', null, ts++); msgs.push([o, Object.assign({}, a)]);
    const b = Pv.create(src, o, cidOf(o), 'B', '123456', ts++); msgs.push([o, Object.assign({}, b)]);
    Pv.update(src, o, a.id, { name: 'A2' }, ts++); msgs.push([o, Object.assign({}, a)]);
    Pv.update(src, o, b.id, { pin: '654321' }, ts++); msgs.push([o, Object.assign({}, b)]);
    Pv.update(src, o, a.id, { pin: null }, ts++); msgs.push([o, Object.assign({}, a)]);
    if (o === OTH) { Pv.remove(src, o, b.id, ts++); msgs.push([o, Object.assign({}, b)]); }
  }
  const r = rnd(42);
  const final = (order) => { const m = {}; for (const [f, x] of order) Pv.applyRemote(m, f, x); return JSON.stringify(Object.keys(m).sort().map((k) => m[k])); };
  const ref = final(msgs);
  for (let k = 0; k < 60; k++) assert.strictEqual(final([...msgs].sort(() => r() - 0.5)), ref, 'urutan acak #' + k);
  const m = {}; for (const [f, x] of msgs) Pv.applyRemote(m, f, x);
  assert.strictEqual(Pv.live(m).length, 5, '3 pemilik x 2 channel, 1 dihapus');
  assert.strictEqual(m[Object.keys(src).find((k) => src[k].by === OTH && src[k].del)].del, true);
  // pesan diulang dua kali tidak mengubah apa pun
  assert.strictEqual(final([...msgs, ...msgs]), ref);
  ok('konvergen: 60 urutan acak + pesan ganda menghasilkan peta yang sama');
}

// 11. tie-break: versi sama, isi beda (ts sama) -> urutan total, hasil sama di dua arah
{
  const base = { id: cidOf(OWN), name: 'x', by: OWN, locked: false, salt: '', hash: '', ts: 5, v: 2, del: false };
  const a = Object.assign({}, base, { name: 'aaa' }), b = Object.assign({}, base, { name: 'bbb' });
  const m1 = {}, m2 = {};
  Pv.applyRemote(m1, OWN, Object.assign({}, base, { v: 1 })); Pv.applyRemote(m2, OWN, Object.assign({}, base, { v: 1 }));
  Pv.applyRemote(m1, OWN, a); Pv.applyRemote(m1, OWN, b);
  Pv.applyRemote(m2, OWN, b); Pv.applyRemote(m2, OWN, a);
  assert.deepStrictEqual(m1, m2);
  assert(Pv.newer(Object.assign({}, base, { del: true }), base) && !Pv.newer(base, Object.assign({}, base, { del: true })));
  assert(Pv.newer(Object.assign({}, base, { v: 3 }), base) && Pv.newer(Object.assign({}, base, { ts: 6 }), base));
  ok('urutan total: v, lalu del, lalu ts, lalu isi');
}

// 12. pesan kontrol tersembunyi
{
  const m = {}; const a = Pv.create(m, OWN, cidOf(OWN), 'a', '123456', 1); const b = Pv.create(m, OWN, cidOf(OWN), 'b', null, 2);
  const text = Pv.encodeCtl([a, b]);
  assert(text.startsWith('\u0001pvch:'));
  assert(!text.includes('123456'), 'PIN polos tidak ikut');
  const recs = Pv.parseCtl(text);
  assert.strictEqual(recs.length, 2);
  const node = {}; for (const r of recs) assert.strictEqual(Pv.applyRemote(node, OWN, r), 'applied');
  assert.deepStrictEqual(node, m, 'dikirim dan diterapkan menghasilkan peta yang sama');
  assert.strictEqual(Pv.parseCtl('halo dunia'), null);
  assert.strictEqual(Pv.parseCtl(null), null);
  assert.strictEqual(Pv.parseCtl(Vc.encodeCtl([])), null, 'kontrol voice grup bukan kontrol publik');
  assert.strictEqual(Vc.parseCtl(text), null, 'kontrol publik bukan kontrol voice grup');
  assert.deepStrictEqual(Pv.parseCtl('\u0001pvch:{bukan json'), []);
  assert.deepStrictEqual(Pv.parseCtl('\u0001pvch:{"a":1}'), []);
  const many = []; for (let i = 0; i < 25; i++) many.push(Object.assign({}, a, { id: OWN.slice(0, 10) + i.toString(16).padStart(6, '0') }));
  assert.strictEqual(Pv.parseCtl(Pv.encodeCtl(many)).length, Pv.PV_MAX_PER_MSG);
  assert.strictEqual(Pv.parseCtl('\u0001pvch:' + JSON.stringify(many)).length, Pv.PV_MAX_PER_MSG, 'pesan dari luar dipotong juga');
  ok('kontrol tersembunyi: bolak-balik utuh, tanpa PIN polos, terpisah dari voice grup, rusak = []');
}

// 13. batas penyebaran: banjir channel baru dan banjir tombstone
{
  const m = {};
  const mk = (by, extra) => Object.assign({ id: cidOf(by), name: 'c', by, locked: false, salt: '', hash: '', ts: 1, v: 1, del: false }, extra);
  // satu pemilik: batas longgar 6 yang tersimpan, 3 terlihat
  let acc = 0; for (let i = 0; i < 10; i++) if (Pv.applyRemote(m, EVIL, mk(EVIL)) === 'applied') acc++;
  assert.strictEqual(acc, 6); assert.strictEqual(Pv.live(m).filter((c) => c.by === EVIL).length, 3);
  // jaringan penuh: 200 terlihat
  const g = {};
  for (let i = 0; i < 70; i++) { const o = i.toString(16).padStart(2, '0').repeat(8); for (let j = 0; j < 3; j++) Pv.applyRemote(g, o, mk(o)); }
  assert.strictEqual(Pv.live(g).length, 200);
  assert.strictEqual(Pv.applyRemote(g, id('f'), mk(id('f'))), 'reject', 'jaringan penuh');
  assert.strictEqual(Pv.applyRemote(g, id('f'), mk(id('f'), { del: true, v: 2 })), 'applied', 'tombstone tetap diterima walau penuh');
  ok('batas penyebaran: 6 tersimpan per pemilik (3 terlihat), 200 total, tombstone tetap diterima');
}

// 14. tombstone: per pemilik 20, total 500, penyerang tidak bisa membilas tombstone orang lain
{
  const m = {};
  const dead = (by, ts) => ({ id: cidOf(by), name: 'd', by, locked: false, salt: '', hash: '', ts, v: 2, del: true });
  const victim = dead(OTH, 1);
  assert.strictEqual(Pv.applyRemote(m, OTH, victim), 'applied');
  for (let i = 0; i < 100; i++) Pv.applyRemote(m, EVIL, dead(EVIL, 1000 + i));
  const evil = Object.values(m).filter((c) => c.by === EVIL);
  assert.strictEqual(evil.length, Pv.PV_MAX_OWNER_DEAD);
  assert(Math.min(...evil.map((c) => c.ts)) === 1080, 'yang terbaru yang dipertahankan');
  assert(m[victim.id] && m[victim.id].del, 'tombstone korban masih ada');
  // total: 40 pemilik x 20 = 800 -> dipangkas ke 500, yang tertua dibuang
  const g = {};
  for (let o = 0; o < 40; o++) { const by = o.toString(16).padStart(2, '0').repeat(8); for (let i = 0; i < 20; i++) Pv.applyRemote(g, by, dead(by, o * 100 + i)); }
  assert.strictEqual(Object.keys(g).length, Pv.PV_MAX_DEAD);
  assert(Object.values(g).every((c) => c.ts >= 1500), 'yang tertua dibuang dulu');
  // lokal: hapus berulang tidak membengkakkan peta
  const l = {};
  for (let i = 0; i < 100; i++) { const c = Pv.create(l, OWN, cidOf(OWN), 'x', null, i); Pv.remove(l, OWN, c.id, 1000 + i); }
  assert.strictEqual(Object.keys(l).length, Pv.PV_MAX_OWNER_DEAD);
  ok('tombstone: 20 per pemilik, 500 total, penyerang tidak bisa membilas milik orang lain');
}

// 15. bersihkan data dari disk
{
  const good = (by, extra) => Object.assign({ id: cidOf(by), name: 'ok', by, locked: false, salt: '', hash: '', ts: 1, v: 1, del: false }, extra);
  const a = good(OWN), b = good(OTH, { del: true, v: 2 });
  const lockedOk = Pv.create({}, OWN, cidOf(OWN), 'k', '123456', 3);
  const noName = good(OWN, { name: '' }), junk = good(OWN);
  const disk = {
    [a.id]: a, [b.id]: b, [lockedOk.id]: lockedOk,
    salahKunci: good(OWN), // key != id
    [noName.id]: noName, // nama rusak
    [junk.id]: 'sampah', xx: null,
  };
  const out = Pv.clean(disk);
  assert.deepStrictEqual(Object.keys(out).sort(), [a.id, b.id, lockedOk.id].sort());
  assert(Pv.checkPin(out[lockedOk.id], '123456'), 'PIN tetap bisa diperiksa setelah dimuat');
  for (const bad of [null, [], 'x', 5, undefined]) assert.deepStrictEqual(Pv.clean(bad), {});
  const flood = {}; for (let i = 0; i < 20; i++) { const c = good(EVIL); flood[c.id] = c; }
  const k1 = Object.keys(Pv.clean(flood)).sort(), k2 = Object.keys(Pv.clean(Object.fromEntries(Object.entries(flood).reverse()))).sort();
  assert.strictEqual(k1.length, 6, 'file yang dibengkakkan dipangkas');
  assert.deepStrictEqual(k1, k2, 'pemangkasan stabil, tidak bergantung urutan di file');
  ok('clean: data disk rusak dibuang, PIN tetap sah, file yang dibengkakkan dipangkas');
}

console.log('\n' + pass + ' tes channel voice publik (pvch1) lulus');
