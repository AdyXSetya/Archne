'use strict';
// Tes Halaman 4b-1: komentar ditandatangani (src/archne-pagecmt.js + PageStore.comment / commentsFor / removeComment + wiring Core). Lokal saja, tanpa jaringan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), crypto = require('crypto');
const { PageCmt, cmtSign, cmtVerify, CMT_TEXT_MAX, CMT_PER_POST, CMT_PER_AUTHOR, CMT_SKEW } = require('../src/archne-pagecmt');
const { PageStore } = require('../src/archne-pagestore');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagecmt-'));
let n = 0, pass = 0;
const fresh = () => { const d = path.join(tmp, 'd' + (n++)); fs.mkdirSync(d, { recursive: true }); return d; };
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const thr = (f) => { try { f(); } catch (e) { return e.message; } return null; };
const H = (c) => c.repeat(16);
// identitas tiruan: pasangan kunci Ed25519, id = 16 heks pertama sha256(pub) (sama dengan Core)
function ident() {
  const k = crypto.generateKeyPairSync('ed25519'), pub = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { priv: k.privateKey, pub, id: crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16) };
}
const OWNER = ident(), U1 = ident(), U2 = ident(), POST = H('a'), POST2 = H('b');
const sign = (u, text, ts, post, owner) => cmtSign(u.priv, u.pub, owner || OWNER.id, post || POST, text, ts);
const T0 = 1700000000000;

// 1. cmtSign / cmtVerify: murni
{
  const c = sign(U1, 'halo dunia', T0);
  assert.deepStrictEqual(Object.keys(c).sort(), ['by', 'id', 'post', 'pub', 'sig', 'text', 'ts']);
  assert(/^[0-9a-f]{16}$/.test(c.id) && c.by === U1.id && c.post === POST && c.ts === T0 && c.text === 'halo dunia');
  let v = cmtVerify(c, OWNER.id); assert(v.ok && JSON.stringify(v.c) === JSON.stringify(c), 'bolak-balik');
  assert(cmtVerify(c, OWNER.id, POST).ok && !cmtVerify(c, OWNER.id, POST2).ok, 'postingan yang diminta harus cocok');
  assert.deepStrictEqual(sign(U1, 'halo dunia', T0), c, 'deterministik: komentar sama persis = id sama');
  assert.notStrictEqual(sign(U1, 'halo dunia', T0 + 1).id, c.id); assert.notStrictEqual(sign(U2, 'halo dunia', T0).id, c.id);
  // bidang tambahan dibuang dari salinan bersih
  v = cmtVerify(Object.assign({}, c, { extra: 1, rahasia: 'x' }), OWNER.id); assert(v.ok && !('extra' in v.c) && !('rahasia' in v.c));
  // teks dibersihkan saat menandatangani (kanonis), dan yang belum kanonis ditolak saat memeriksa
  const cc = sign(U1, '  baris 1 \r\n\r\n\r\n\r\nbaris   2  ', T0); assert.strictEqual(cc.text, 'baris 1\n\nbaris 2'); assert(cmtVerify(cc, OWNER.id).ok);
  const raw = crypto.sign(null, Buffer.from('archne-pc1:' + OWNER.id + ':' + POST + ':' + T0 + ':' + JSON.stringify(' spasi ')), U1.priv).toString('base64'); // tanda tangan SAH atas teks yang belum kanonis
  const sigId = crypto.createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex').slice(0, 16);
  assert.strictEqual(cmtVerify({ id: sigId, post: POST, by: U1.id, pub: U1.pub, ts: T0, text: ' spasi ', sig: raw }, OWNER.id).why, 'bad', 'teks tak kanonis ditolak walau tanda tangannya sah');
  // pemalsuan: tiap bidang yang ditutup tanda tangan diubah satu per satu
  for (const [f, val, why] of [['text', 'halo dunia!', 'auth'], ['ts', T0 + 1, 'auth'], ['post', POST2, 'auth'], ['sig', sign(U1, 'lain', T0).sig, 'auth'], ['id', H('0'), 'auth'], ['by', U2.id, 'auth'], ['pub', U2.pub, 'auth']]) {
    const x = cmtVerify(Object.assign({}, c, { [f]: val }), OWNER.id); assert(!x.ok && x.why === why, 'ubah ' + f + ' -> ' + JSON.stringify(x));
  }
  // pub dan by diganti sekaligus ke identitas lain (konsisten) tetap gagal: tanda tangan bukan dari kunci itu
  assert.strictEqual(cmtVerify(Object.assign({}, c, { pub: U2.pub, by: U2.id }), OWNER.id).why, 'auth');
  // terikat ke halaman pemilik: komentar untuk pemilik lain tidak sah di sini
  assert.strictEqual(cmtVerify(c, ident().id).why, 'auth', 'diputar ulang ke pemilik lain');
  assert.strictEqual(cmtVerify(sign(U1, 'x', T0, POST, H('c')), OWNER.id).why, 'auth', 'ditandatangani untuk pemilik lain');
  // bentuk cacat: tidak melempar, why 'bad'
  for (const bad of [null, undefined, 5, 'x', [], {}, Object.assign({}, c, { id: 'xyz' }), Object.assign({}, c, { post: H('A') }), Object.assign({}, c, { by: 5 }), Object.assign({}, c, { text: '' }), Object.assign({}, c, { text: 5 }),
    Object.assign({}, c, { ts: 1.5 }), Object.assign({}, c, { ts: -1 }), Object.assign({}, c, { ts: '1' }), Object.assign({}, c, { pub: '' }), Object.assign({}, c, { pub: 'x'.repeat(201) }), Object.assign({}, c, { sig: 5 }), Object.assign({}, c, { sig: 'x'.repeat(201) }), Object.assign({}, c, { text: 'a'.repeat(CMT_TEXT_MAX + 1) })]) {
    const x = cmtVerify(bad, OWNER.id); assert(x.ok === false && (x.why === 'bad' || x.why === 'auth'), 'harus ditolak: ' + JSON.stringify(bad));
  }
  assert.strictEqual(cmtVerify(c, 'xyz').ok, false); assert.strictEqual(cmtVerify(Object.assign({}, c, { pub: '@@@', by: c.by }), OWNER.id).ok, false, 'kunci sampah tidak melempar');
  // teks terlalu panjang yang ditandatangani sah (dirakit tangan, melewati cmtSign): ditolak sebagai bentuk, bukan lolos
  { const big = 'a'.repeat(CMT_TEXT_MAX + 1), sg = crypto.sign(null, Buffer.from('archne-pc1:' + OWNER.id + ':' + POST + ':' + T0 + ':' + JSON.stringify(big)), U1.priv).toString('base64');
    const bc = { id: crypto.createHash('sha256').update(Buffer.from(sg, 'base64')).digest('hex').slice(0, 16), post: POST, by: U1.id, pub: U1.pub, ts: T0, text: big, sig: sg };
    assert.strictEqual(cmtVerify(bc, OWNER.id).why, 'bad', 'terlalu panjang = bentuk salah walau tanda tangannya sah'); assert.strictEqual(cmtVerify(Object.assign({}, bc, { text: big.slice(1) }), OWNER.id).why, 'auth', 'pembanding: panjang tepat tapi tanda tangan tak cocok'); }
  // batas teks tepat
  assert(cmtVerify(sign(U1, 'a'.repeat(CMT_TEXT_MAX), T0), OWNER.id).ok); assert(/panjang/.test(thr(() => sign(U1, 'a'.repeat(CMT_TEXT_MAX + 1), T0))));
  for (const bad of ['', '   ', '\u0000\u0001', 5, null]) assert(thr(() => sign(U1, bad, T0)) !== null, 'teks tak sah: ' + JSON.stringify(bad));
  assert(thr(() => cmtSign(U1.priv, U1.pub, 'xyz', POST, 'a', T0)) && thr(() => cmtSign(U1.priv, U1.pub, OWNER.id, 'xyz', 'a', T0)) && thr(() => cmtSign(U1.priv, '', OWNER.id, POST, 'a', T0)) && thr(() => cmtSign(U1.priv, U1.pub, OWNER.id, POST, 'a', -5)));
  ok('cmtSign / cmtVerify: bolak-balik, deterministik, teks kanonis, tiap bidang terkunci, terikat pemilik + postingan, cacat ditolak tanpa melempar');
}

// 2. PageCmt: tambah / daftar / batas / simpan / pemuatan ulang
{
  const f = path.join(fresh(), 'c.json'), cm = new PageCmt(f, OWNER.id);
  assert.deepStrictEqual(cm.list(POST), []); assert.strictEqual(cm.count(POST), 0);
  const c2 = sign(U2, 'kedua', T0 + 20), c1 = sign(U1, 'pertama', T0 + 10), c3 = sign(U1, 'ketiga', T0 + 10);
  assert.strictEqual(cm.add(c2, T0 + 30), 'added'); assert.strictEqual(cm.add(c1, T0 + 30), 'added'); assert.strictEqual(cm.add(c3, T0 + 30), 'added');
  assert.strictEqual(cm.list(POST)[0].id, c1.id < c3.id ? c1.id : c3.id, 'ts sama: id terkecil dulu'); assert.strictEqual(cm.list(POST)[1].id, c1.id < c3.id ? c3.id : c1.id);
  assert.strictEqual(cm.list(POST)[2].text, 'kedua', 'tertua dulu'); assert.strictEqual(cm.count(POST), 3);
  const w = fs.statSync(f).mtimeMs; const before = fs.readFileSync(f, 'utf8');
  assert.strictEqual(cm.add(c1, T0 + 99), 'same'); assert.strictEqual(fs.readFileSync(f, 'utf8'), before, 'komentar sama = tidak menulis'); assert.strictEqual(cm.count(POST), 3);
  assert.notStrictEqual(cm.list(POST)[0], cm.list(POST)[0], 'list memberi salinan'); cm.list(POST)[0].text = 'diubah'; assert.notStrictEqual(cm.list(POST)[0].text, 'diubah');
  // penolakan: tanda tangan, bentuk, pemilik lain, jam di masa depan
  assert(/Tanda tangan/.test(thr(() => cm.add(Object.assign({}, c1, { text: 'palsu' }), T0))));
  assert(/tidak valid/.test(thr(() => cm.add({ junk: 1 }, T0))) && /tidak valid/.test(thr(() => cm.add(null, T0))));
  assert(/Tanda tangan/.test(thr(() => cm.add(sign(U1, 'x', T0, POST, H('c')), T0))), 'untuk pemilik lain');
  assert(/masa depan/.test(thr(() => cm.add(sign(U1, 'dari masa depan', T0 + CMT_SKEW + 1), T0)))); assert.strictEqual(cm.add(sign(U1, 'tepat batas', T0 + CMT_SKEW), T0), 'added', 'tepat di batas boleh');
  assert.strictEqual(cm.count(POST), 4, 'penolakan tidak menambah apa pun');
  // dimuat ulang: isi sama, urutan sama
  const cm2 = new PageCmt(f, OWNER.id); assert.deepStrictEqual(cm2.list(POST), cm.list(POST)); assert.strictEqual(cm2.total, 4);
  // postingan lain terpisah
  assert.strictEqual(cm.add(sign(U1, 'di postingan lain', T0, POST2), T0), 'added'); assert.strictEqual(cm.count(POST2), 1); assert.strictEqual(cm.count(POST), 4);
  // remove / drop / retain
  assert.strictEqual(cm.remove(POST, H('0')), false); assert.strictEqual(cm.remove(H('9'), c1.id), false); assert.strictEqual(cm.remove(POST, c1.id), true); assert.strictEqual(cm.count(POST), 3); assert.strictEqual(cm.remove(POST, c1.id), false);
  assert.strictEqual(new PageCmt(f, OWNER.id).count(POST), 3, 'remove tersimpan'); assert.strictEqual(cm.total, 4);
  assert.strictEqual(cm.add(c1, T0 + 40), 'removed', 'komentar yang dibuang pemilik tetap terhapus: kirim ulang persis sama ditolak (nisan, 5c-3; rinci di test/pagecmtpriv.js)'); assert.strictEqual(cm.count(POST), 3);
  cm.drop(POST2); assert.strictEqual(cm.count(POST2), 0); assert(!(POST2 in cm.map)); assert.strictEqual(cm.total, 3); assert.strictEqual(new PageCmt(f, OWNER.id).count(POST2), 0);
  const w2 = fs.readFileSync(f, 'utf8'); cm.drop(H('9')); assert.strictEqual(fs.readFileSync(f, 'utf8'), w2, 'drop yang tak ada tidak menulis');
  assert.strictEqual(cm.retain((id) => id === POST), 0, 'tak ada yang dibuang'); assert.strictEqual(fs.readFileSync(f, 'utf8'), w2);
  assert.strictEqual(cm.retain(() => false), 3); assert.strictEqual(cm.total, 0); assert.deepStrictEqual(cm.map, {}); assert.strictEqual(new PageCmt(f, OWNER.id).total, 0);
  // ts sama: urutan ditentukan id (bukan urutan masuk), deterministik: yang id-nya lebih besar sengaja dimasukkan lebih dulu, juga saat dibuka dari berkas
  { const t1 = sign(U1, 'seri A', T0), t2 = sign(U2, 'seri B', T0), [lo, hi] = t1.id < t2.id ? [t1, t2] : [t2, t1], ff = path.join(fresh(), 's.json'), cs = new PageCmt(ff, OWNER.id);
    cs.add(hi, T0); cs.add(lo, T0); assert.deepStrictEqual(cs.list(POST).map((c) => c.id), [lo.id, hi.id]);
    fs.writeFileSync(ff, JSON.stringify({ v: 1, map: { [POST]: [hi, lo] } })); assert.deepStrictEqual(new PageCmt(ff, OWNER.id).list(POST).map((c) => c.id), [lo.id, hi.id]); }
  // penulis pencatat: yang tidak mengubah apa pun tidak boleh menulis; komentar terakhir dibuang = kunci ikut hilang
  { let w = 0; const cm5 = new PageCmt(path.join(fresh(), 'w.json'), OWNER.id, (ff, t) => { w++; fs.writeFileSync(ff, t); }), x = sign(U1, 'satu-satunya', T0);
    assert.strictEqual(cm5.add(x, T0), 'added'); assert.strictEqual(w, 1); cm5.add(x, T0); assert.strictEqual(w, 1, 'same = tanpa tulis');
    cm5.retain((id) => id === POST); assert.strictEqual(w, 1, 'retain tanpa perubahan = tanpa tulis'); cm5.drop(H('9')); assert.strictEqual(w, 1); cm5.remove(POST, H('0')); assert.strictEqual(w, 1, 'remove tak ada = tanpa tulis');
    assert.strictEqual(cm5.remove(POST, x.id), true); assert.strictEqual(w, 2); assert(!(POST in cm5.map), 'komentar terakhir dibuang = kunci hilang'); assert.strictEqual(cm5.total, 0); }
  ok('PageCmt: urutan tertua dulu, idempotent tanpa tulis, penolakan tanpa sisa, pemuatan ulang, remove / drop / retain');
}

// 3. batas, gagal tulis, berkas rusak / diubah tangan
{
  const d = fresh(), f = path.join(d, 'c.json'), cm = new PageCmt(f, OWNER.id), authors = Array.from({ length: 30 }, ident);
  for (let i = 0; i < CMT_PER_AUTHOR; i++) assert.strictEqual(cm.add(sign(U1, 'k' + i, T0 + i), T0 + 100), 'added');
  assert(/satu orang/.test(thr(() => cm.add(sign(U1, 'k-lebih', T0 + 50), T0 + 100)))); assert.strictEqual(cm.add(sign(U2, 'orang lain masih boleh', T0), T0 + 100), 'added');
  assert.strictEqual(cm.add(sign(U1, 'k-lebih', T0 + 50, POST2), T0 + 100), 'added', 'batas per penulis berlaku per postingan');
  // batas per postingan
  const cm2 = new PageCmt(path.join(d, 'c2.json'), OWNER.id); let i = 0;
  for (const a of Array.from({ length: CMT_PER_POST / CMT_PER_AUTHOR }, ident)) for (let j = 0; j < CMT_PER_AUTHOR; j++) { cm2.add(sign(a, 'x' + (i++), T0 + j), T0 + 100); }
  assert.strictEqual(cm2.count(POST), CMT_PER_POST); assert(/penuh/.test(thr(() => cm2.add(sign(ident(), 'melebihi', T0), T0 + 100)))); assert.strictEqual(cm2.count(POST), CMT_PER_POST);
  // batas total berkas (diperkecil lewat total buatan agar tes cepat)
  const cm3 = new PageCmt(path.join(d, 'c3.json'), OWNER.id); cm3.total = require('../src/archne-pagecmt').CMT_STORE_MAX; assert(/Penyimpanan/.test(thr(() => cm3.add(sign(U1, 'x', T0), T0 + 100)))); assert.strictEqual(cm3.count(POST), 0);
  // gagal tulis: memori kembali seperti di berkas (add dan remove)
  let fail = false; const cm4 = new PageCmt(path.join(d, 'c4.json'), OWNER.id, (ff, s) => { if (fail) throw new Error('disk penuh'); fs.writeFileSync(ff, s); });
  const keep = sign(U1, 'tersimpan', T0); cm4.add(keep, T0 + 100); fail = true;
  assert(/disk penuh/.test(thr(() => cm4.add(sign(U2, 'gagal tulis', T0 + 1), T0 + 100)))); assert.deepStrictEqual(cm4.list(POST).map((c) => c.text), ['tersimpan']); assert.strictEqual(cm4.total, 1);
  assert(/disk penuh/.test(thr(() => cm4.add(sign(U2, 'gagal di postingan baru', T0 + 1, POST2), T0 + 100)))); assert(!(POST2 in cm4.map), 'postingan baru yang gagal tidak meninggalkan kunci kosong'); assert.strictEqual(cm4.total, 1);
  assert(/disk penuh/.test(thr(() => cm4.remove(POST, keep.id)))); assert.strictEqual(cm4.count(POST), 1); assert.strictEqual(cm4.total, 1);
  fail = false; assert.strictEqual(cm4.remove(POST, keep.id), true);
  // berkas diubah tangan / rusak
  const g = path.join(d, 'g.json'), a = sign(U1, 'asli', T0), b = sign(U2, 'asli juga', T0 + 1);
  const wr = (obj) => fs.writeFileSync(g, typeof obj === 'string' ? obj : JSON.stringify(obj));
  wr({ v: 1, map: { [POST]: [a, Object.assign({}, b, { text: 'diubah tangan' }), Object.assign({}, a, { by: U2.id }), { sampah: 1 }, null, 5, a, sign(U1, 'untuk pemilik lain', T0, POST, H('c'))], [POST2]: 'bukan larik', xyz: [a], [H('c')]: [sign(U1, 'postingan lain id', T0, H('c'))] } });
  const lo = new PageCmt(g, OWNER.id); assert.deepStrictEqual(lo.list(POST).map((c) => c.text), ['asli'], 'hanya yang sah dan tunggal yang lolos'); assert.strictEqual(lo.count(POST2), 0); assert.strictEqual(lo.count('xyz'), 0); assert.strictEqual(lo.count(H('c')), 1); assert.strictEqual(lo.total, 2);
  wr({ v: 1, map: { [POST]: [b, a] } }); assert.deepStrictEqual(new PageCmt(g, OWNER.id).list(POST).map((c) => c.text), ['asli', 'asli juga'], 'urutan dipulihkan saat dibuka');
  wr({ v: 1, map: { [POST]: [Object.assign({}, a, { post: POST2 })] } }); assert.strictEqual(new PageCmt(g, OWNER.id).total, 0, 'komentar di kunci yang salah ditolak (post harus sama dengan kunci)');
  wr({ v: 1, map: { [POST]: [sign(U1, 'sah, tapi untuk postingan lain', T0, POST2)] } }); assert.strictEqual(new PageCmt(g, OWNER.id).total, 0, 'komentar SAH untuk postingan lain di bawah kunci yang salah ditolak');
  { const many = []; for (const au of Array.from({ length: CMT_PER_POST / CMT_PER_AUTHOR + 2 }, ident)) for (let j = 0; j < CMT_PER_AUTHOR; j++) many.push(sign(au, 'm' + j, T0 + j)); wr({ v: 1, map: { [POST]: many } });
    const big = new PageCmt(g, OWNER.id); assert.strictEqual(big.count(POST), CMT_PER_POST, 'kelebihan per postingan dibuang saat dibuka'); assert.strictEqual(big.total, CMT_PER_POST); }
  for (const junk of ['{rusak', '', '[]', 'null', '{"v":2,"map":{}}', '{"v":1}', '{"v":1,"map":5}', '{"v":1,"map":[]}']) { wr(junk); assert.strictEqual(new PageCmt(g, OWNER.id).total, 0, 'rusak = kosong: ' + junk); }
  wr({ v: 1, map: { [POST]: [a] } }); assert.strictEqual(new PageCmt(g, H('d')).total, 0, 'dibuka sebagai pemilik lain: tak satu pun sah');
  assert(/Id pemilik/.test(thr(() => new PageCmt(g, 'xyz'))) && /Id pemilik/.test(thr(() => new PageCmt(g))));
  // batas saat dibuka: kelebihan per penulis dibuang
  wr({ v: 1, map: { [POST]: Array.from({ length: CMT_PER_AUTHOR + 5 }, (_, k) => sign(U1, 'b' + k, T0 + k)) } }); assert.strictEqual(new PageCmt(g, OWNER.id).count(POST), CMT_PER_AUTHOR);
  ok('PageCmt: batas per penulis / postingan / total, gagal tulis memulihkan memori, berkas diubah tangan atau rusak dibersihkan');
}

// 4. PageStore: izin, penulis = pengirim terbukti, postingan Teman, hapus postingan, pemuatan ulang
{
  const dir = fresh(), rel = { [OWNER.id]: 'owner', [U1.id]: 'friend', [U2.id]: 'public', [H('d')]: 'blocked' };
  const mk = (o) => new PageStore(dir, Object.assign({ relation: (id) => rel[id] || 'public', ownerId: OWNER.id }, o));
  let ps = mk(); const pub = ps.create({ text: 'publik' }), frd = ps.create({ text: 'rahasia', priv: 'friends' });
  const cs = (u, text, p, ts) => cmtSign(u.priv, u.pub, OWNER.id, p.id, text, ts == null ? Date.now() : ts);
  // publik: semua yang tidak diblokir boleh; daftar sama untuk semua yang boleh melihat
  assert.strictEqual(ps.comment(U2.id, pub.id, cs(U2, 'dari publik', pub)), 'added'); assert.strictEqual(ps.comment(U1.id, pub.id, cs(U1, 'dari teman', pub)), 'added'); assert.strictEqual(ps.comment(OWNER.id, pub.id, cs(OWNER, 'dari pemilik', pub)), 'added', 'pemilik boleh berkomentar di postingannya sendiri');
  for (const who of [OWNER.id, U1.id, U2.id]) assert.deepStrictEqual(ps.commentsFor(who, pub.id).map((c) => c.text).sort(), ['dari pemilik', 'dari publik', 'dari teman'].sort());
  assert.strictEqual(ps.comment(U2.id, pub.id, ps.commentsFor(U2.id, pub.id).find((c) => c.by === U2.id)), 'same', 'kirim ulang = same');
  // diblokir / id sampah / tidak ada: null, tak terbedakan, TANPA memeriksa komentar
  for (const [who, pid] of [[H('d'), pub.id], ['xyz', pub.id], [U2.id, H('9')], [null, pub.id], [U2.id, 'xyz']]) { assert.strictEqual(ps.comment(who, pid, { sampah: 1 }), null, 'null: ' + who + ' ' + pid); assert.strictEqual(ps.commentsFor(who, pid), null); }
  // postingan Teman: asing = null SEBELUM komentar diperiksa (komentar sampah tidak melempar, jadi tidak membocorkan keberadaan postingan)
  assert.strictEqual(ps.comment(U2.id, frd.id, { sampah: 1 }), null); assert.strictEqual(ps.comment(U2.id, frd.id, cs(U2, 'asing menyusup', frd)), null); assert.strictEqual(ps.commentsFor(U2.id, frd.id), null);
  assert.strictEqual(ps.comment(U1.id, frd.id, cs(U1, 'teman boleh', frd)), 'added'); assert.deepStrictEqual(ps.commentsFor(U1.id, frd.id).map((c) => c.text), ['teman boleh']); assert.strictEqual(ps.cmt.count(frd.id), 1, 'asing tidak meninggalkan jejak');
  // penulis harus pengirim terbukti dan komentar harus untuk postingan ini
  assert(/bukan milik pengirim/.test(thr(() => ps.comment(U2.id, pub.id, cs(U1, 'dititipkan lewat U2', pub))))); assert(/bukan milik pengirim/.test(thr(() => ps.comment(U1.id, pub.id, cs(U1, 'postingan lain', frd)))));
  for (const bad of [null, undefined, 5, 'x', {}]) assert(/bukan milik pengirim/.test(thr(() => ps.comment(U1.id, pub.id, bad))), 'cacat: ' + JSON.stringify(bad));
  assert(/Tanda tangan/.test(thr(() => ps.comment(U1.id, pub.id, Object.assign(cs(U1, 'asli', pub), { text: 'diubah' })))));
  assert.strictEqual(ps.cmt.count(pub.id), 3);
  // diblokir sesudah berkomentar: komentar lama tetap ada, tapi dia tak bisa lagi melihat / menulis
  rel[U2.id] = 'blocked'; assert.strictEqual(ps.commentsFor(U2.id, pub.id), null); assert.strictEqual(ps.comment(U2.id, pub.id, cs(U2, 'lagi', pub)), null); assert.strictEqual(ps.cmt.count(pub.id), 3); rel[U2.id] = 'public';
  // moderasi lokal
  const victim = ps.commentsFor(OWNER.id, pub.id).find((c) => c.by === U2.id); assert.strictEqual(ps.removeComment(pub.id, victim.id), true); assert.strictEqual(ps.removeComment(pub.id, victim.id), false); assert.strictEqual(ps.removeComment(H('9'), victim.id), false); assert.strictEqual(ps.cmt.count(pub.id), 2);
  // dimuat ulang dari folder yang sama
  ps = mk(); assert.deepStrictEqual(ps.commentsFor(OWNER.id, pub.id).map((c) => c.text).sort(), ['dari pemilik', 'dari teman']); assert.deepStrictEqual(ps.commentsFor(U1.id, frd.id).map((c) => c.text), ['teman boleh']);
  // hapus postingan membuang komentarnya, juga dari berkas
  assert.strictEqual(ps.remove(frd.id), true); assert.strictEqual(ps.cmt.count(frd.id), 0); assert(!fs.readFileSync(path.join(dir, 'comments.json'), 'utf8').includes(frd.id)); assert.strictEqual(ps.commentsFor(U1.id, frd.id), null);
  // yatim: komentar yang postingannya hilang dibuang saat dibuka
  ps.cmt.map[H('e')] = [cmtSign(U1.priv, U1.pub, OWNER.id, H('e'), 'yatim', T0)]; ps.cmt.total++; ps.cmt._save(); ps = mk(); assert.strictEqual(ps.cmt.count(H('e')), 0); assert(!fs.readFileSync(path.join(dir, 'comments.json'), 'utf8').includes('yatim'));
  // tanpa ownerId komentar dimatikan (bukan ditebak) dan reaksi tak terpengaruh
  const dir2 = fresh(), off = new PageStore(dir2, { relation: (id) => (id === OWNER.id ? 'owner' : 'public') }), p2 = off.create({ text: 'tanpa pemilik' });
  assert.strictEqual(off.cmt, null); assert.strictEqual(off.comment(U1.id, p2.id, cs(U1, 'x', p2)), null); assert.strictEqual(off.commentsFor(U1.id, p2.id), null); assert.strictEqual(off.removeComment(p2.id, H('0')), false); assert(!fs.existsSync(path.join(dir2, 'comments.json')));
  assert.deepStrictEqual(off.react(U1.id, p2.id, '👍').rx, [{ e: '👍', n: 1 }]); assert(off.remove(p2.id));
  // komentar tidak bocor lewat jalur yang sudah ada: postingan di wire / daftar tidak membawa komentar
  const g = ps.getFor(U1.id, pub.id), l = ps.listFor(U1.id, {}); assert(!JSON.stringify(g).includes('dari teman') && !JSON.stringify(l).includes('dari teman'), 'getFor / listFor tidak membawa komentar'); assert(!('comments' in g) && !('cmt' in g));
  ok('PageStore: izin = izin lihat, null sebelum komentar diperiksa, penulis = pengirim terbukti, postingan Teman, hapus / yatim, tanpa ownerId = mati');
}

// 5. Core sungguhan: ownerId = id Core, komentar ditandatangani dengan kunci identitas Core
(async () => {
  const mk = (nm) => new Core({ dataDir: path.join(tmp, nm), name: nm, discovery: false });
  const A = mk('A'), B = mk('B'); await A.start(); await B.start();
  try {
    const ps = A.pageStore(), post = ps.create({ text: 'halaman A' });
    assert.strictEqual(ps.cmt.owner, A.id, 'PageStore Core memakai id Core sebagai pemilik');
    const own = cmtSign(A.privKey, A.pub, A.id, post.id, 'komentar pemilik', Date.now()); assert.strictEqual(own.by, A.id, 'id penulis = id Core (cara turunan sama)');
    assert.strictEqual(ps.comment(A.id, post.id, own), 'added');
    const fromB = cmtSign(B.privKey, B.pub, A.id, post.id, 'komentar dari B', Date.now()); assert.strictEqual(fromB.by, B.id);
    assert.strictEqual(ps.comment(B.id, post.id, fromB), 'added', 'B (publik) boleh berkomentar di postingan publik A');
    assert.strictEqual(cmtVerify(fromB, A.id).ok, true); assert.strictEqual(cmtVerify(fromB, B.id).ok, false, 'tidak sah sebagai komentar untuk halaman B');
    assert.deepStrictEqual(ps.commentsFor(B.id, post.id).map((c) => c.text).sort(), ['komentar dari B', 'komentar pemilik']);
    assert.strictEqual(ps.cmt.count(post.id), 2);
    const posts = fs.existsSync(path.join(A._pagesDir(), 'comments.json')); assert(posts, 'comments.json ada di folder halaman');
    ok('Core: ownerId = id Core, komentar bertanda tangan kunci identitas Core diterima, tidak sah di halaman lain');
  } finally { try { await A.stop(); await B.stop(); } catch {} }
  console.log('\n' + pass + ' kelompok lulus'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
