'use strict';
// Tes pustaka Halaman (langkah 1a + 1b): penyimpanan postingan teks dan penyaring privasi penonton. Murni lokal, tanpa Core dan tanpa jaringan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { PageStore, coreRelation, wirePost, wireList, normMedia, normFiles, normVideos, VIDEOS_MAX, PAGE_VIDEO_MAX, VIDEO_MIME, FILES_MAX, PAGE_FILE_MAX, MEDIA_MAX, MEDIA_CHUNK, FILE_CHUNK, VIDEO_CHUNK, PAGE_MEDIA_MAX } = require('../src/archne-pagestore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagestore-'));
let pass = 0, n = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const fresh = () => path.join(tmp, 'd' + (n++));
const leftovers = (dir) => { // semua berkas .tmp yang tersisa di bawah dir
  const out = [], walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.tmp')) out.push(f); } };
  walk(dir); return out;
};
const postPath = (dir, id) => path.join(dir, 'p', id.slice(0, 2), id + '.json');
const ids = (r) => r.items.map((p) => p.id);

console.log('Archne pagestore test, dir: ' + tmp);

// ---- A. buat dan baca ----
{
  const dir = fresh(), ps = new PageStore(dir);
  assert.strictEqual(ps.count(), 0);
  assert.deepStrictEqual(ps.list(), { items: [], next: null });
  const p = ps.create({ text: 'Halo dunia' });
  assert.match(p.id, /^[0-9a-f]{16}$/);
  assert.strictEqual(p.v, 1); assert.strictEqual(p.kind, 'text'); assert.strictEqual(p.text, 'Halo dunia');
  assert.strictEqual(p.priv, 'public', 'privasi bawaan Publik');
  assert(Math.abs(p.ts - Date.now()) < 5000);
  assert.deepStrictEqual(ps.get(p.id), p);
  assert.strictEqual(ps.count(), 1); assert(ps.has(p.id));
  assert.strictEqual(ps.create({ text: 'rahasia', priv: 'friends' }).priv, 'friends');
  assert.throws(() => ps.create({ text: 'x', priv: 'semua' }), /Privasi/);
  assert.throws(() => ps.create({ text: 'x', priv: '' }), /Privasi/);
  assert.throws(() => ps.create(), /tidak valid/);
  assert.strictEqual(ps.count(), 2, 'gagal tidak meninggalkan apa pun');
  ok('buat dan baca: id 16 hex, privasi bawaan Publik, privasi tak sah ditolak tanpa sisa');
}

// ---- B. pembersihan dan batas teks ----
{
  const ps = new PageStore(fresh());
  assert.strictEqual(ps.create({ text: '  baris1\r\n\r\n\r\n\r\nbaris2\u0000\u202e  \t ok  ' }).text, 'baris1\n\nbaris2 ok');
  assert.throws(() => ps.create({ text: '' }), /kosong/);
  assert.throws(() => ps.create({ text: ' \n\t\u200b ' }), /kosong/);
  for (const bad of [null, undefined, 42, {}, ['a']]) assert.throws(() => ps.create({ text: bad }), /tidak valid/);
  const long = ('Paragraf cerita panjang. ' + 'a'.repeat(80) + '\n\n').repeat(2000); // ~210 ribu karakter: postingan bukan chat, tanpa batas panjang
  const lp = ps.create({ text: long });
  assert(lp.text.length > 200000, 'teks panjang tidak ditolak dan tidak dipotong');
  assert.strictEqual(lp.text, long.trim()); assert.strictEqual(ps.get(lp.id).text, long.trim(), 'utuh setelah dibaca ulang dari disk');
  const fam = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // emoji keluarga: ZWJ harus selamat
  assert.strictEqual(ps.create({ text: 'Keluarga ' + fam + ' \u062F\u0627\u0631\u0647\u200C\u0627\u06CC' }).text, 'Keluarga ' + fam + ' \u062F\u0627\u0631\u0647\u200C\u0627\u06CC');
  assert.strictEqual(ps.create({ text: 'Selamat pagi, ini postingan pertamaku \u{1F31E}\nBaris dua' }).text, 'Selamat pagi, ini postingan pertamaku \u{1F31E}\nBaris dua');
  ok('teks dibersihkan, kosong ditolak, teks sangat panjang utuh (tanpa batas), ZWJ/ZWNJ dan emoji utuh');
}

// ---- C. urutan, ts naik ketat, halaman berkursor ----
{
  const ps = new PageStore(fresh());
  const made = []; for (let i = 0; i < 25; i++) made.push(ps.create({ text: 'p' + i }));
  for (let i = 1; i < made.length; i++) assert(made[i].ts > made[i - 1].ts, 'ts naik ketat walau dibuat dalam satu milidetik');
  const all = ps.list({ limit: 50 });
  assert.deepStrictEqual(ids(all), made.map((p) => p.id).reverse(), 'terbaru di atas');
  assert.strictEqual(all.next, null);
  const seen = []; let cur = null, pages = 0;
  do { const r = ps.list({ limit: 10, after: cur }); seen.push(...ids(r)); cur = r.next; pages++; } while (cur);
  assert.strictEqual(pages, 3); assert.deepStrictEqual(seen, ids(all), 'tanpa duplikat, tanpa yang terlewat');
  assert.strictEqual(ps.list({ limit: 25 }).next, null, 'tepat habis = tidak ada halaman kosong');
  assert.notStrictEqual(ps.list({ limit: 24 }).next, null);
  assert.strictEqual(ps.list().items.length, 10, 'bawaan 10');
  assert.strictEqual(ps.list({ limit: 0 }).items.length, 1); assert.strictEqual(ps.list({ limit: 9999 }).items.length, 25);
  assert.strictEqual(ps.list({ limit: 'x' }).items.length, 10);
  for (const bad of ['abc', '1:zz', '12:abcd', ':', '-1:0123456789abcdef']) assert.throws(() => ps.list({ after: bad }), /Kursor/);
  // kursor tetap benar setelah postingan di tengah dihapus dan setelah ada yang baru
  const r1 = ps.list({ limit: 5 }); ps.remove(r1.items[4].id); ps.create({ text: 'baru' });
  const r2 = ps.list({ limit: 5, after: r1.next });
  assert.deepStrictEqual(ids(r2), ids(all).slice(5, 10), 'kursor berdasarkan posisi (ts,id), bukan nomor halaman');
  assert.strictEqual(ps.list({ after: '9999999999999999:ffffffffffffffff' }).items.length, 10, 'kursor di depan semua = dari awal');
  assert.deepStrictEqual(ps.list({ after: '1:0000000000000000' }), { items: [], next: null }, 'kursor melewati yang terakhir = kosong');
  ok('terbaru dulu, ts naik ketat, 3 halaman lengkap tanpa duplikat, kursor tahan hapus dan postingan baru, kursor jelek ditolak');
}

// ---- D. hapus ----
{
  const dir = fresh(), ps = new PageStore(dir);
  const a = ps.create({ text: 'a' }), b = ps.create({ text: 'b' });
  assert(fs.existsSync(postPath(dir, a.id)));
  assert.strictEqual(ps.remove(a.id), true);
  assert(!fs.existsSync(postPath(dir, a.id)), 'berkas ikut terhapus');
  assert.strictEqual(ps.get(a.id), null); assert(!ps.has(a.id)); assert.strictEqual(ps.count(), 1);
  assert.strictEqual(ps.remove(a.id), false, 'hapus dua kali = false, tidak melempar');
  assert.deepStrictEqual(ids(ps.list()), [b.id]);
  // id jahat tidak bisa menyentuh berkas di luar folder
  const canary = path.join(tmp, 'canary.json'); fs.writeFileSync(canary, '{}');
  for (const bad of ['../../canary', '../canary', '..\\..\\canary', '', null, undefined, 123, {}, 'ABCDEF0123456789', 'p/../x', b.id + '/..']) {
    assert.strictEqual(ps.get(bad), null); assert.strictEqual(ps.remove(bad), false); assert.strictEqual(ps.has(bad), false);
  }
  assert(fs.existsSync(canary), 'berkas di luar folder aman'); assert.strictEqual(ps.count(), 1);
  ok('hapus membuang berkas dan indeks, hapus ulang false, id jahat (path traversal) tidak berefek');
}

// ---- E. tahan tutup-buka ----
{
  const dir = fresh(); let ps = new PageStore(dir);
  const made = []; for (let i = 0; i < 12; i++) made.push(ps.create({ text: 'k' + i, priv: i % 2 ? 'friends' : 'public' }));
  ps.remove(made[3].id);
  const before = ps.list({ limit: 50 });
  ps = new PageStore(dir);
  assert.deepStrictEqual(ps.list({ limit: 50 }), before, 'isi dan urutan sama setelah dibuka ulang');
  assert.strictEqual(ps.count(), 11); assert.strictEqual(ps.get(made[3].id), null);
  const nx = ps.create({ text: 'sesudah buka ulang' });
  assert(nx.ts > made[11].ts, 'ts tetap naik ketat lintas sesi');
  assert.strictEqual(ps.list().items[0].id, nx.id);
  assert.deepStrictEqual(leftovers(dir), [], 'tidak ada .tmp tersisa');
  ok('tutup-buka: isi, urutan, privasi, dan ts tetap utuh; tidak ada .tmp tersisa');
}

// ---- F. penyembuhan indeks (indeks cuma cache) ----
{
  const dir = fresh(); let ps = new PageStore(dir);
  const made = []; for (let i = 0; i < 6; i++) made.push(ps.create({ text: 'h' + i, priv: i === 2 ? 'friends' : 'public' }));
  const want = ids(ps.list({ limit: 50 })), idxF = path.join(dir, 'index.json');

  fs.unlinkSync(idxF);
  ps = new PageStore(dir);
  assert.deepStrictEqual(ids(ps.list({ limit: 50 })), want, 'indeks hilang: dibangun ulang dari berkas');
  assert.strictEqual(ps.get(made[2].id).priv, 'friends');

  fs.writeFileSync(idxF, '{{{ bukan json');
  ps = new PageStore(dir);
  assert.deepStrictEqual(ids(ps.list({ limit: 50 })), want, 'indeks rusak: dibangun ulang');
  assert.strictEqual(JSON.parse(fs.readFileSync(idxF, 'utf8')).posts.length, 6, 'indeks ditulis ulang bersih');

  fs.writeFileSync(idxF, JSON.stringify({ v: 1, posts: [{ id: 'bukan-hex', ts: 1, priv: 'public' }, null, 7, { id: made[0].id, ts: 5, priv: 'zzz' }] }));
  ps = new PageStore(dir);
  assert.deepStrictEqual(ids(ps.list({ limit: 50 })), want, 'isi indeks ngawur: entri tak sah dibuang, sisanya dari berkas');

  // crash antara tulis berkas dan tulis indeks: postingan yatim ditemukan lagi
  const j = JSON.parse(fs.readFileSync(idxF, 'utf8')); j.posts = j.posts.filter((e) => e.id !== made[4].id); fs.writeFileSync(idxF, JSON.stringify(j));
  ps = new PageStore(dir);
  assert(ps.has(made[4].id)); assert.deepStrictEqual(ids(ps.list({ limit: 50 })), want, 'postingan yatim terbit lagi di urutan yang benar');

  // crash antara buang berkas dan tulis indeks: entri hantu hilang
  fs.unlinkSync(postPath(dir, made[1].id));
  ps = new PageStore(dir);
  assert(!ps.has(made[1].id)); assert.strictEqual(ps.count(), 5);
  assert.strictEqual(JSON.parse(fs.readFileSync(idxF, 'utf8')).posts.length, 5);

  // sisa .tmp dari crash dibuang; berkas rusak tidak menggagalkan apa pun
  fs.writeFileSync(postPath(dir, made[0].id) + '.tmp', 'setengah'); fs.writeFileSync(idxF + '.tmp', 'setengah');
  fs.mkdirSync(path.dirname(postPath(dir, 'aaaaaaaaaaaaaaaa')), { recursive: true });
  fs.writeFileSync(postPath(dir, 'aaaaaaaaaaaaaaaa'), 'sampah');   // yatim rusak
  fs.writeFileSync(path.join(dir, 'p', 'aa', 'catatan.txt'), 'abaikan'); // berkas asing
  fs.writeFileSync(postPath(dir, made[5].id), '{"v":1,"id":"salah"}'); // terindeks tapi isinya rusak
  ps = new PageStore(dir);
  assert(!ps.has('aaaaaaaaaaaaaaaa'), 'yatim rusak diabaikan');
  assert.strictEqual(fs.readFileSync(postPath(dir, 'aaaaaaaaaaaaaaaa'), 'utf8'), 'sampah', 'tidak dihapus diam-diam');
  assert.strictEqual(ps.get(made[5].id), null, 'berkas rusak = get null, tidak melempar');
  const r = ps.list({ limit: 50 });
  assert.deepStrictEqual(ids(r), want.filter((id) => id !== made[1].id && id !== made[5].id), 'list melewati yang rusak');
  assert.deepStrictEqual(leftovers(path.join(dir, 'p')), [], 'sisa .tmp postingan dibuang');
  ok('indeks hilang / rusak / ngawur / tertinggal / berhantu semuanya pulih dari berkas; sisa .tmp dibuang; berkas rusak tidak menggagalkan');
}

// ---- G. terpisah dari data lain ----
{
  const dir = fresh(), ps = new PageStore(dir);
  ps.create({ text: 'x' });
  const top = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(top, ['index.json', 'p'], 'hanya index.json dan p/ di folder halaman');
  assert.throws(() => new PageStore(''), /tidak valid/); assert.throws(() => new PageStore(null), /tidak valid/);
  const parent = fs.readdirSync(path.dirname(dir));
  assert(!parent.includes('store.json') && !parent.includes('primary.json'), 'tidak menyentuh store.json / primary.json');
  ok('menulis hanya di foldernya sendiri; tidak menyentuh store.json / primary.json');
}

// ---- H. penyaring privasi untuk penonton (1b) ----
{
  const ME = 'aaaaaaaaaaaaaaaa', FR = '1111111111111111', ST = '2222222222222222', BL = '3333333333333333', PEND = '4444444444444444';
  const rel = { [ME]: 'owner', [FR]: 'friend', [ST]: 'public', [BL]: 'blocked' }; // PEND (permintaan belum disetujui) tidak terdaftar = public
  const ps = new PageStore(fresh(), { relation: (id) => rel[id] || 'public' });
  const made = []; for (let i = 0; i < 30; i++) made.push(ps.create({ text: 'q' + i, priv: i % 3 === 0 ? 'friends' : 'public' }));
  const pub = made.filter((p) => p.priv === 'public').map((p) => p.id).reverse(), all = made.map((p) => p.id).reverse();
  const walk = (peer, limit) => { const seen = []; let cur = null; do { const r = ps.listFor(peer, { limit, after: cur }); seen.push(...ids(r)); cur = r.next; } while (cur); return seen; };

  assert.deepStrictEqual(walk(FR, 7), all, 'teman melihat Publik dan Teman, lengkap');
  assert.deepStrictEqual(walk(ME, 50), all, 'pemilik melihat semuanya');
  assert.deepStrictEqual(walk(ST, 7), pub, 'bukan teman hanya melihat Publik, tanpa duplikat dan tanpa yang terlewat');
  assert.deepStrictEqual(walk(PEND, 4), pub, 'permintaan teman yang belum disetujui = belum teman');
  assert.strictEqual(ps.countFor(ST), 20); assert.strictEqual(ps.countFor(FR), 30); assert.strictEqual(ps.countFor(ME), 30);
  assert.strictEqual(ps.count(), 30, 'count() tetap tampilan pemilik');

  // halaman dan kursor tidak membocorkan: halaman penuh walau ada yang disaring, kursor hanya menunjuk postingan yang terlihat
  const r = ps.listFor(ST, { limit: 5 });
  assert.strictEqual(r.items.length, 5, 'halaman terisi penuh dari yang terlihat (tidak berlubang karena disaring)');
  assert(r.items.every((p) => p.priv === 'public'));
  assert.strictEqual(r.next, r.items[4].ts + ':' + r.items[4].id, 'kursor = postingan terlihat terakhir, bukan yang tersaring');
  assert.strictEqual(ps.listFor(ST, { limit: 20 }).next, null, 'tepat habis = tidak ada halaman kosong');
  const priv0 = made[0]; // Teman
  assert.deepStrictEqual(ids(ps.listFor(ST, { after: priv0.ts + ':' + priv0.id, limit: 50 })), pub.filter((id) => made.find((p) => p.id === id).ts < priv0.ts), 'kursor yang menunjuk postingan Teman tidak membocorkan apa pun');
  assert.throws(() => ps.listFor(ST, { after: 'jelek' }), /Kursor/);

  // getFor: tidak ada / bukan untukmu / diblokir semuanya sama (null)
  const friendPost = made[0], pubPost = made[1];
  assert.deepStrictEqual(ps.getFor(FR, friendPost.id), friendPost); assert.deepStrictEqual(ps.getFor(ST, pubPost.id), pubPost);
  assert.strictEqual(ps.getFor(ST, friendPost.id), null, 'postingan Teman tidak terbaca bukan teman');
  assert.strictEqual(ps.getFor(ST, 'ffffffffffffffff'), null, 'sama dengan id yang tidak ada: keberadaannya tidak bisa ditebak');
  assert.strictEqual(ps.getFor(ME, friendPost.id).id, friendPost.id);

  // diblokir ditolak total
  assert.strictEqual(ps.listFor(BL), null); assert.strictEqual(ps.countFor(BL), null); assert.strictEqual(ps.getFor(BL, pubPost.id), null);
  // id penonton tidak sah ditolak
  for (const bad of ['', null, undefined, 5, '../x', 'ZZ']) { assert.strictEqual(ps.listFor(bad), null); assert.strictEqual(ps.countFor(bad), null); assert.strictEqual(ps.getFor(bad, pubPost.id), null); }

  // berubah relasi berlaku seketika (tanpa cache): teman diputus -> postingan Teman hilang; diblokir -> ditolak
  rel[FR] = 'public'; assert.deepStrictEqual(walk(FR, 50), pub); rel[FR] = 'blocked'; assert.strictEqual(ps.listFor(FR), null);
  // hapus postingan Teman: hilang dari teman juga
  rel[FR] = 'friend'; ps.remove(friendPost.id); assert(!walk(FR, 50).includes(friendPost.id));

  // aman secara bawaan: tanpa relation, semua penonton = Publik; relation yang melempar / ngawur = ditutup
  const d = new PageStore(fresh()); d.create({ text: 'a', priv: 'friends' }); const dp = d.create({ text: 'b' });
  assert.deepStrictEqual(ids(d.listFor(FR)), [dp.id], 'tanpa relation: postingan Teman tidak pernah bocor');
  const bad1 = new PageStore(fresh(), { relation: () => { throw new Error('boom'); } }); bad1.create({ text: 'x' });
  assert.strictEqual(bad1.listFor(FR), null, 'relation melempar = ditolak');
  const bad2 = new PageStore(fresh(), { relation: () => 'admin' }); bad2.create({ text: 'x' });
  assert.strictEqual(bad2.listFor(FR), null, 'relation mengembalikan nilai tak dikenal = ditolak');
  assert.throws(() => new PageStore(fresh(), { relation: 'x' }), /fungsi/);
  ok('penyaring privasi: teman vs bukan teman vs pemilik vs diblokir, halaman dan kursor tidak bocor, getFor seragam, bawaan aman');
}

// ---- I. penghubung ke Core (coreRelation) ----
{
  const fake = { id: 'aaaaaaaaaaaaaaaa', blockedSet: new Set(['3333333333333333', '5555555555555555']), fs: { '1111111111111111': 'ok', '2222222222222222': 'in', '4444444444444444': 'out', '5555555555555555': 'ok' },
    isBlocked(id) { return this.blockedSet.has(id); }, fstate(id) { return this.fs[id] || ''; } };
  const r = coreRelation(fake);
  assert.strictEqual(r('aaaaaaaaaaaaaaaa'), 'owner');
  assert.strictEqual(r('1111111111111111'), 'friend', "hanya st 'ok' (saling setuju) yang teman");
  assert.strictEqual(r('2222222222222222'), 'public', "'in' belum teman"); assert.strictEqual(r('4444444444444444'), 'public', "'out' belum teman");
  assert.strictEqual(r('3333333333333333'), 'blocked'); assert.strictEqual(r('5555555555555555'), 'blocked', 'blokir mengalahkan pertemanan');
  assert.strictEqual(r('9999999999999999'), 'public', 'orang asing tetap boleh melihat yang Publik');
  const ps = new PageStore(fresh(), { relation: r }); ps.create({ text: 'umum' }); ps.create({ text: 'teman', priv: 'friends' });
  assert.strictEqual(ps.listFor('1111111111111111').items.length, 2); assert.strictEqual(ps.listFor('2222222222222222').items.length, 1); assert.strictEqual(ps.listFor('5555555555555555'), null);
  ok('coreRelation: pemilik / teman (hanya ok) / publik / diblokir (mengalahkan teman)');
}

// ---- J. field media (2a-1) + salin berkas (2a-2) ----
{
  const dir = fresh(); const ps = new PageStore(dir);
  // PNG 1x1 sah (header + IHDR cukup untuk sniffImage)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  const src = path.join(tmp, 'foto asli.png'); fs.writeFileSync(src, png);
  const m = ps.addMedia(src);
  assert.strictEqual(m.mime, 'image/png'); assert.strictEqual(m.size, png.length); assert.strictEqual(m.name, 'foto asli.png');
  assert.ok(fs.readFileSync(path.join(dir, 'media', m.id + '.png')).equals(png), 'salinan identik di pages/media');
  fs.unlinkSync(src); // berkas asli hilang: salinan tetap ada
  const a = ps.create({ text: 'dengan gambar', media: [m] });
  assert.deepStrictEqual(ps.get(a.id).media, [m], 'media tersimpan dan terbaca ulang');
  assert.deepStrictEqual(new PageStore(dir).get(a.id).media, [m], 'tetap ada setelah dibuka ulang');
  assert.deepStrictEqual(wirePost(ps.get(a.id)).media, [m], 'wirePost meneruskan media');
  const b = ps.create({ text: 'tanpa gambar' });
  assert.ok(!('media' in ps.get(b.id)) && !('media' in wirePost(ps.get(b.id))), 'tanpa media tidak punya field media');
  for (const bad of [[m, m] /* id ganda (sejak 2c ditolak karena duplikat, bukan lagi karena batas 1) */, [{ ...m, mime: 'image/svg+xml' }], [{ ...m, id: '../x' }], [{ ...m, size: 0 }], 'x'])
    assert.throws(() => ps.create({ text: 'x', media: bad }), /Media/, 'media cacat ditolak');
  assert.throws(() => ps.create({ text: 'x', media: [{ ...m, id: '0123456789abcdef' }] }), /belum disalin/, 'rujukan ke berkas yang tak ada ditolak');
  assert.strictEqual(wirePost({ ...wirePost(ps.get(a.id)), media: [{ ...m, mime: 'text/html' }] }), null, 'wirePost menolak media cacat');
  // kasus gagal: bukan gambar (isi teks berekstensi .png), berkas tak ada, dan tidak ada sisa
  const fake = path.join(tmp, 'palsu.png'); fs.writeFileSync(fake, 'ini bukan gambar sama sekali, hanya teks biasa');
  assert.throws(() => ps.addMedia(fake), /Bukan gambar/); assert.throws(() => ps.addMedia(path.join(tmp, 'tidak-ada.png')));
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'media')), [m.id + '.png'], 'gagal tidak meninggalkan berkas');
  // dropMedia membuang yatim; remove membuang salinan bersama postingannya
  const m2 = ps.addMedia((fs.writeFileSync(src, png), src)); ps.dropMedia(m2.id);
  assert.ok(!fs.existsSync(path.join(dir, 'media', m2.id + '.png')), 'dropMedia');
  assert.strictEqual(ps.remove(a.id), true);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'media')), [], 'hapus postingan ikut menghapus gambarnya');
  assert.deepStrictEqual(leftovers(dir), []);
  ok('media: simpan/baca/wire, salin ke media/, tolak palsu/cacat, dropMedia, hapus ikut membuang berkas');
}

// ---- K. thumbnail th (2b-1) ----
{
  const dir = fresh(); const ps = new PageStore(dir);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  const src = path.join(tmp, 'k.png'); fs.writeFileSync(src, png);
  const jpg = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]).copy(b); return b.toString('base64'); }; // SOI + SOF0 saja: cukup untuk jpegSize
  const th = jpg(320, 200), big = jpg(321, 10);
  const m = ps.addMedia(src, th); assert.strictEqual(m.th, th, 'addMedia menyimpan th sah');
  const a = ps.create({ text: 'ber-thumb', media: [m] });
  assert.strictEqual(ps.get(a.id).media[0].th, th); assert.strictEqual(new PageStore(dir).get(a.id).media[0].th, th, 'th bertahan setelah dibuka ulang');
  assert.strictEqual(wirePost(ps.get(a.id)).media[0].th, th, 'wirePost meneruskan th');
  assert.ok(!('th' in ps.addMedia(src)), 'tanpa th tidak ada field th');
  for (const bad of [big, 'bukan base64!', Buffer.from('halo dunia 1234').toString('base64'), 'A'.repeat(7004), 5]) assert.ok(!('th' in ps.addMedia(src, bad)), 'addMedia mengabaikan th tidak sah');
  for (const bad of [big, '%%%%', 'A'.repeat(7004), 5]) assert.throws(() => ps.create({ text: 'x', media: [{ ...m, th: bad }] }), /Media/, 'create menolak th cacat');
  assert.strictEqual(wirePost({ ...ps.get(a.id), media: [{ ...m, th: big }] }), null, 'wire dengan th cacat dilewati');
  ok('thumbnail th: tersimpan, terbaca ulang, ikut wire; th tidak sah diabaikan saat salin dan ditolak saat create/wire');
}

// ---- L. banyak gambar per postingan (2c) ----
(async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  const jpg = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]).copy(b); return b.toString('base64'); };
  const mk = (name) => { const f = path.join(tmp, name); fs.writeFileSync(f, png); return f; };
  const mediaFiles = (dir) => { try { return fs.readdirSync(path.join(dir, 'media')).sort(); } catch { return []; } };
  assert.strictEqual(MEDIA_MAX, 10, 'batas 10 gambar');

  // 1. salin beberapa gambar sekaligus: urutan terjaga, th hanya di yang diberi, tiap berkas ada
  {
    const dir = fresh(), ps = new PageStore(dir), th = jpg(200, 100);
    const ms = await ps.addMedias([{ src: mk('l1.png'), th }, { src: mk('l2.png') }, { src: mk('l3.png'), th: 'rusak!' }]);
    assert.deepStrictEqual(ms.map((m) => m.name), ['l1.png', 'l2.png', 'l3.png'], 'urutan = urutan masukan');
    assert.strictEqual(new Set(ms.map((m) => m.id)).size, 3, 'id berbeda');
    assert.strictEqual(ms[0].th, th); assert.ok(!('th' in ms[1]) && !('th' in ms[2]), 'th tidak ada / tak sah diabaikan per gambar');
    assert.strictEqual(mediaFiles(dir).length, 3);
    const a = ps.create({ text: 'tiga gambar', media: ms });
    assert.deepStrictEqual(ps.get(a.id).media, ms, 'tersimpan utuh dan berurutan');
    assert.deepStrictEqual(new PageStore(dir).get(a.id).media, ms, 'bertahan setelah dibuka ulang');
    assert.deepStrictEqual(wirePost(ps.get(a.id)).media, ms, 'wirePost meneruskan semuanya');
    const wl = wireList({ items: [ps.get(a.id)], next: null, count: 1 }, { limit: 10 });
    assert.deepStrictEqual(wl.items[0].media, ms, 'wireList (sisi peminta) juga');
    assert.strictEqual(ps.remove(a.id), true); assert.deepStrictEqual(mediaFiles(dir), [], 'hapus postingan membuang SEMUA gambarnya');
    assert.deepStrictEqual(leftovers(dir), []);
  }
  ok('banyak gambar: salinan berurutan, th per gambar, tersimpan/dibuka ulang/wire, hapus membuang semuanya');

  // 2. batas: tepat MEDIA_MAX boleh, lebih ditolak (tanpa menyalin apa pun)
  {
    const dir = fresh(), ps = new PageStore(dir), f = mk('batas.png');
    const full = await ps.addMedias(Array.from({ length: MEDIA_MAX }, () => ({ src: f })));
    assert.strictEqual(ps.create({ text: 'penuh', media: full }).media.length, MEDIA_MAX);
    const before = mediaFiles(dir).length;
    await assert.rejects(ps.addMedias(Array.from({ length: MEDIA_MAX + 1 }, () => ({ src: f }))), /Daftar gambar/);
    assert.strictEqual(mediaFiles(dir).length, before, 'ditolak sebelum menyalin');
    const over = [...full, { ...full[0], id: 'fedcba9876543210' }];
    assert.throws(() => ps.create({ text: 'x', media: over }), /Media/, 'create menolak lebih dari batas');
    assert.strictEqual(wirePost({ v: 1, id: '0123456789abcdef', ts: 1, kind: 'text', text: 'x', priv: 'public', media: over }), null, 'wirePost menolak lebih dari batas');
    assert.strictEqual(normMedia(over), null);
  }
  ok('batas: tepat 10 gambar boleh; 11 ditolak di addMedias, create, dan wirePost');

  // 3. id ganda ditolak (create dan wire)
  {
    const dir = fresh(), ps = new PageStore(dir);
    const [m1, m2] = await ps.addMedias([{ src: mk('d1.png') }, { src: mk('d2.png') }]);
    assert.throws(() => ps.create({ text: 'x', media: [m1, m2, { ...m2 }] }), /Media/, 'id ganda ditolak');
    assert.strictEqual(wirePost({ v: 1, id: '0123456789abcdef', ts: 1, kind: 'text', text: 'x', priv: 'public', media: [m1, m1] }), null, 'wire: id ganda dilewati');
    assert.ok(wirePost({ v: 1, id: '0123456789abcdef', ts: 1, kind: 'text', text: 'x', priv: 'public', media: [m1, m2] }), 'dua id berbeda sah');
    assert.strictEqual(ps.count(), 0, 'gagal tidak membuat postingan');
  }
  ok('id media ganda dalam satu postingan ditolak di create dan wire');

  // 4. semua-atau-tidak-sama-sekali: satu gagal membuang yang sudah tersalin
  {
    const dir = fresh(), ps = new PageStore(dir), bad = path.join(tmp, 'palsu2.png'); fs.writeFileSync(bad, 'bukan gambar, hanya teks');
    await assert.rejects(ps.addMedias([{ src: mk('g1.png') }, { src: bad }, { src: mk('g3.png') }]), /Gambar ke-2: Bukan gambar/);
    assert.deepStrictEqual(mediaFiles(dir), [], 'gambar ke-1 yang sempat tersalin dibuang lagi');
    await assert.rejects(ps.addMedias([{ src: mk('g4.png') }, { src: path.join(tmp, 'tak-ada.png') }]), /Gambar ke-2/);
    await assert.rejects(ps.addMedias([null]), /Gambar tidak valid/); await assert.rejects(ps.addMedias('x'), /Daftar gambar/);
    await assert.rejects(ps.addMedias([{ src: mk('g5.png') }, 5]), /Gambar ke-2: Gambar tidak valid/);
    assert.deepStrictEqual(mediaFiles(dir), [], 'tidak ada sisa dari kegagalan apa pun'); assert.deepStrictEqual(leftovers(dir), []);
    await assert.rejects(ps.addMedias([{ src: bad }]), (e) => /^Bukan gambar/.test(e.message), 'satu gambar: pesan tanpa awalan "Gambar ke-"');
  }
  ok('addMedias semua-atau-tidak: satu gagal membuang yang sudah tersalin; pesan menyebut gambar ke berapa');

  // 5. daftar kosong = postingan tanpa gambar; rujukan ke berkas yang hilang (di posisi mana pun) ditolak
  {
    const dir = fresh(), ps = new PageStore(dir);
    assert.deepStrictEqual(await ps.addMedias([]), []);
    assert.ok(!('media' in ps.create({ text: 'kosong', media: [] })), 'media [] = tanpa field media');
    const ms = await ps.addMedias([{ src: mk('h1.png') }, { src: mk('h2.png') }, { src: mk('h3.png') }]);
    ps.dropMedia(ms[1].id); // gambar tengah hilang
    assert.throws(() => ps.create({ text: 'x', media: ms }), /belum disalin/, 'gambar yang hilang di tengah tetap ketahuan');
    assert.strictEqual(ps.count(), 1);
  }
  ok('daftar kosong = tanpa media; berkas hilang di posisi mana pun menolak create');

  // ---- M. potongan byte gambar untuk penonton (2d-1) ----
  {
    const ME = 'aaaaaaaaaaaaaaaa', FR = '1111111111111111', ST = '2222222222222222', BL = '3333333333333333';
    const rel = { [ME]: 'owner', [FR]: 'friend', [ST]: 'public', [BL]: 'blocked' };
    const dir = fresh(), ps = new PageStore(dir, { relation: (id) => rel[id] || 'public' });
    const big = Buffer.concat([png, Buffer.alloc(MEDIA_CHUNK * 2 + 123, 7)]); // 2 potongan penuh + sisa
    const fb = path.join(tmp, 'besar.png'); fs.writeFileSync(fb, big);
    const [mb, ms2] = await ps.addMedias([{ src: fb }, { src: mk('kecil.png') }]);
    const pubPost = ps.create({ text: 'publik', media: [mb] }), frPost = ps.create({ text: 'teman', priv: 'friends', media: [ms2] });

    // 1. pemilik dan orang asing merakit berkas utuh potongan demi potongan; len dipangkas ke MEDIA_CHUNK dan ke sisa berkas
    for (const who of [ME, ST, FR]) {
      const parts = []; let off = 0, total = 0;
      while (off < big.length) { const r = ps.readMediaFor(who, pubPost.id, mb.id, off, 99999999); assert.ok(r && r.b.length > 0 && r.b.length <= MEDIA_CHUNK, 'potongan sah'); assert.strictEqual(r.off, off); assert.strictEqual(r.mime, 'image/png'); total = r.total; parts.push(r.b); off += r.b.length; }
      assert.strictEqual(total, big.length); assert.ok(Buffer.concat(parts).equals(big), 'hasil rakitan identik');
      assert.strictEqual(parts.length, 3, '2 potongan penuh + 1 sisa');
    }
    assert.strictEqual(ps.readMediaFor(ST, pubPost.id, mb.id, 10, 5).b.length, 5, 'len kecil dihormati');

    // 2. privasi: postingan Teman hanya untuk teman dan pemilik; asing dan diblokir null, sama dengan "tidak ada"
    assert.ok(ps.readMediaFor(FR, frPost.id, ms2.id, 0, 10) && ps.readMediaFor(ME, frPost.id, ms2.id, 0, 10), 'teman dan pemilik boleh');
    assert.strictEqual(ps.readMediaFor(ST, frPost.id, ms2.id, 0, 10), null, 'orang asing tidak boleh');
    assert.strictEqual(ps.readMediaFor(BL, pubPost.id, mb.id, 0, 10), null, 'diblokir tidak boleh walau postingannya Publik');
    assert.strictEqual(ps.readMediaFor(null, pubPost.id, mb.id, 0, 10), null, 'tanpa identitas tidak boleh');

    // 3. id media harus milik postingan yang diminta; argumen dan rentang cacat = null
    assert.strictEqual(ps.readMediaFor(FR, pubPost.id, ms2.id, 0, 10), null, 'media postingan lain tidak bisa diambil lewat postingan ini');
    assert.strictEqual(ps.readMediaFor(FR, 'bbbbbbbbbbbbbbbb', mb.id, 0, 10), null, 'postingan tidak ada');
    for (const [o, l] of [[big.length, 1], [-1, 10], [1.5, 10], [0, 0], [0, -4], [0, NaN], ['0', 10]]) assert.strictEqual(ps.readMediaFor(ME, pubPost.id, mb.id, o, l), null, 'rentang cacat: ' + o + ',' + l);
    for (const mid of ['../x', 5, null, 'zzzzzzzzzzzzzzzz']) assert.strictEqual(ps.readMediaFor(ME, pubPost.id, mid, 0, 10), null, 'id media cacat');

    // 4. berkas hilang atau ukurannya berubah di disk = null (bukan data rusak)
    fs.appendFileSync(path.join(dir, 'media', mb.id + '.png'), 'x');
    assert.strictEqual(ps.readMediaFor(ME, pubPost.id, mb.id, 0, 10), null, 'ukuran tak cocok');
    fs.unlinkSync(path.join(dir, 'media', ms2.id + '.png'));
    assert.strictEqual(ps.readMediaFor(ME, frPost.id, ms2.id, 0, 10), null, 'berkas hilang');
  }
  ok('readMediaFor: rakit potongan identik, privasi, id milik postingan, rentang cacat, berkas berubah');

  // ---- N. gambar besar sampai 2 GiB, disalin berpotongan (2d-6) ----
  {
    const crypto = require('crypto');
    assert.strictEqual(PAGE_MEDIA_MAX, 2 * 1024 * 1024 * 1024, 'batas 2 GiB');
    const sha = (f) => { const h = crypto.createHash('sha256'), fd = fs.openSync(f, 'r'), b = Buffer.alloc(1 << 20); let r; while ((r = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, r)); fs.closeSync(fd); return h.digest('hex'); };
    const sparse = (name, size, head) => { const f = path.join(tmp, name), fd = fs.openSync(f, 'w'); fs.writeSync(fd, head || png, 0, (head || png).length, 0); fs.ftruncateSync(fd, size); return { f, fd }; };
    const noTmp = (dir) => assert.deepStrictEqual(leftovers(dir), [], 'tidak ada .tmp tersisa');

    // 1. 100 MB (jauh di atas batas lama 32 MB): isi identik, TANPA readFileSync, dan event loop tetap bernapas selama menyalin
    {
      const dir = fresh(), ps = new PageStore(dir), SZ = 100 * 1048576, { f, fd } = sparse('besar100.png', SZ);
      for (const off of [5 * 1048576 + 3, 50 * 1048576, SZ - 9]) fs.writeSync(fd, crypto.randomBytes(9), 0, 9, off); // isi acak di tempat berbeda, termasuk ujung
      fs.closeSync(fd);
      const rfs = fs.readFileSync; let big = 0; fs.readFileSync = function (p, ...a) { try { if (typeof p === 'string' && fs.statSync(p).size > 8e6) big++; } catch {} return rfs.call(fs, p, ...a); };
      let ticks = 0; const iv = setInterval(() => ticks++, 0);
      let ms; try { ms = await ps.addMedias([{ src: f }]); } finally { fs.readFileSync = rfs; clearInterval(iv); }
      assert.strictEqual(big, 0, 'berkas besar tidak dibaca utuh ke memori'); assert(ticks >= 5, 'event loop tetap berjalan selama salinan (ticks=' + ticks + ')');
      assert.strictEqual(ms[0].size, SZ); assert.strictEqual(sha(path.join(dir, 'media', ms[0].id + '.png')), sha(f), 'salinan identik');
      const p = ps.create({ text: 'besar', media: ms });
      assert.strictEqual(ps.readMediaFor(null, p.id, ms[0].id, SZ - 9, 100) === null, true, 'tanpa identitas tetap ditolak');
      const r = new PageStore(dir).get(p.id); assert.strictEqual(r.media[0].size, SZ, 'tersimpan dan terbaca ulang');
      noTmp(dir);
      // versi sinkron memberi hasil yang sama
      const m2 = ps.addMedia(f); assert.strictEqual(sha(path.join(dir, 'media', m2.id + '.png')), sha(f)); noTmp(dir);
    }

    // 2. batas atas: 2 GiB + 1 ditolak sebelum menyalin apa pun; normMedia/wirePost menolak ukuran di atas batas, menerima tepat batas
    {
      const dir = fresh(), ps = new PageStore(dir), { f, fd } = sparse('terlalubesar.png', PAGE_MEDIA_MAX + 1); fs.closeSync(fd);
      await assert.rejects(() => ps.addMedias([{ src: f }]), /terlalu besar \(maksimal 2 GB\)/);
      assert.throws(() => ps.addMedia(f), /terlalu besar/);
      assert.deepStrictEqual(mediaFiles(dir), [], 'tidak ada salinan'); noTmp(dir);
      const e = { id: 'aaaaaaaaaaaaaaaa', mime: 'image/png', name: 'x.png' };
      assert.ok(normMedia([{ ...e, size: PAGE_MEDIA_MAX }]), 'tepat 2 GiB sah'); assert.strictEqual(normMedia([{ ...e, size: PAGE_MEDIA_MAX + 1 }]), null, 'lebih dari 2 GiB cacat');
      assert.strictEqual(wirePost({ v: 1, id: 'bbbbbbbbbbbbbbbb', ts: 5, kind: 'text', text: 'x', priv: 'public', media: [{ ...e, size: 2 ** 40 }] }), null, 'klaim ukuran mustahil dari jaringan ditolak');
    }

    // 3. kepala besar: JPEG dengan 3 segmen APP @60 KB (SOF baru setelah ~180 KB) tetap dikenali; bukan gambar besar ditolak bersih
    {
      const dir = fresh(), ps = new PageStore(dir), app = (n) => { const b = Buffer.alloc(n + 2); b[0] = 0xff; b[1] = 0xe1; b.writeUInt16BE(n, 2); return b; };
      const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 64, 0, 96, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
      const jf = path.join(tmp, 'kepala-besar.jpg'); fs.writeFileSync(jf, Buffer.concat([Buffer.from([0xff, 0xd8]), app(60000), app(60000), app(60000), sof, Buffer.alloc(2e6, 1)]));
      const m = ps.addMedia(jf); assert.strictEqual(m.mime, 'image/jpeg');
      const nf = path.join(tmp, 'bukan-gambar.png'); fs.writeFileSync(nf, Buffer.alloc(20 * 1048576, 3));
      await assert.rejects(() => ps.addMedias([{ src: nf }]), /Bukan gambar/); assert.deepStrictEqual(mediaFiles(dir), [m.id + '.jpg'], 'hanya gambar sah yang ada'); noTmp(dir);
    }

    // 4. sumber berubah di tengah salinan: membesar / mengecil / dihapus = gagal bersih, tanpa .tmp dan tanpa berkas media
    {
      const dir = fresh(), ps = new PageStore(dir), mkBig = (n) => { const { f, fd } = sparse(n, 10 * 1048576); fs.closeSync(fd); return f; };
      let f = mkBig('tumbuh.png'), job = ps._beginCopy(f); while (ps._copyStep(job)); fs.appendFileSync(f, 'x');
      try { assert.throws(() => ps._endCopy(job), /berubah/); } finally { ps._abortCopy(job, null); }
      f = mkBig('susut.png'); job = ps._beginCopy(f); fs.truncateSync(f, 6 * 1048576);
      try { assert.throws(() => { while (ps._copyStep(job)); }, /berubah/); } finally { ps._abortCopy(job, null); }
      assert.deepStrictEqual(mediaFiles(dir), [], 'tidak ada berkas media'); noTmp(dir);
    }

    // 5. disk penuh di tengah salinan: pesan jelas, salinan sebagian dibuang, gambar sebelumnya dalam daftar ikut dibuang
    {
      const dir = fresh(), ps = new PageStore(dir), { f, fd } = sparse('penuh.png', 9 * 1048576); fs.closeSync(fd);
      const ok1 = mk('ok1.png'), ws = fs.writeSync; let calls = 0; fs.writeSync = function (...a) { if (++calls === 3) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return ws.apply(fs, a); };
      try { await assert.rejects(() => ps.addMedias([{ src: ok1 }, { src: f }]), (e) => e.code === 'ENOSPC' && /Gambar ke-2: Penyimpanan penuh/.test(e.message)); } finally { fs.writeSync = ws; }
      assert.deepStrictEqual(mediaFiles(dir), [], 'yang sudah tersalin ikut dibuang'); noTmp(dir);
    }
  }
  ok('gambar besar: 100 MB disalin berpotongan (tanpa readFileSync, event loop hidup, isi identik); batas 2 GiB; kepala JPEG besar; sumber berubah dan disk penuh gagal bersih');

  // ---- O. berkas lampiran: metadata saja (3a-1) ----
  {
    const dir = fresh(), ps = new PageStore(dir);
    const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';
    assert.strictEqual(FILES_MAX, 10); assert.strictEqual(PAGE_FILE_MAX, 2 * 1024 * 1024 * 1024);
    // normal: tersimpan, dibuka ulang, lewat wirePost dan wireList; tanpa files = tanpa field (postingan lama sama persis)
    const f1 = path.join(tmp, 'laporan.pdf'), f2 = path.join(tmp, 'a\u202eb.zip'); fs.writeFileSync(f1, Buffer.alloc(1234, 7)); fs.writeFileSync(f2, Buffer.alloc(99, 1));
    const files = await ps.addFiles([{ src: f1 }, { src: f2 }]);
    const p = ps.create({ text: 'ada lampiran', files });
    assert.deepStrictEqual(p.files.map((f) => [f.name, f.size]), [['laporan.pdf', 1234], ['ab.zip', 99]], 'nama dibersihkan, urutan terjaga');
    assert.deepStrictEqual(new PageStore(dir).get(p.id).files, p.files, 'bertahan setelah dibuka ulang');
    assert.deepStrictEqual(wirePost(ps.get(p.id)).files, p.files, 'wirePost meneruskan');
    assert.deepStrictEqual(wireList({ items: [ps.get(p.id)], next: null, count: 1 }, { limit: 10 }).items[0].files, p.files, 'wireList juga');
    assert.ok(!('files' in ps.create({ text: 'polos' })) && !('files' in ps.create({ text: 'kosong', files: [] })), 'tanpa/kosong = tanpa field');
    // berdampingan dengan gambar: boleh bila id berbeda; id sama di keduanya = cacat
    const med = [{ id: C, mime: 'image/png', size: 10, name: 'g.png' }];
    // (gambar belum disalin, jadi create menolak; yang diuji di sini hanya bentuk lewat normFiles/wirePost)
    assert.ok(wirePost({ v: 1, id: A.replace(/a/g, '1'), ts: 5, kind: 'text', text: 'x', priv: 'public', media: med, files: [{ id: A, name: 'f.bin', size: 1 }] }), 'id beda = sah');
    assert.strictEqual(wirePost({ v: 1, id: A.replace(/a/g, '1'), ts: 5, kind: 'text', text: 'x', priv: 'public', media: med, files: [{ id: C, name: 'f.bin', size: 1 }] }), null, 'id sama dengan gambar = cacat');
    // cacat: semuanya ditolak tanpa sisa
    const bad = [
      [{ id: 'xyz', name: 'a', size: 1 }], [{ id: A, name: '', size: 1 }], [{ id: A, name: '\u200b', size: 1 }], [{ id: A, name: 'a', size: 0 }], [{ id: A, name: 'a', size: -1 }],
      [{ id: A, name: 'a', size: 1.5 }], [{ id: A, name: 'a', size: PAGE_FILE_MAX + 1 }], [{ id: A, name: 'x'.repeat(121), size: 1 }], [{ id: A, name: 5, size: 1 }],
      [{ id: A, name: 'a', size: 1 }, { id: A, name: 'b', size: 2 }], Array.from({ length: FILES_MAX + 1 }, (_, i) => ({ id: String(i).padStart(16, '0'), name: 'f', size: 1 })), 'bukan larik', [null],
    ];
    for (const b of bad) { assert.strictEqual(normFiles(b), null, 'cacat: ' + JSON.stringify(b).slice(0, 60)); assert.throws(() => ps.create({ text: 'x', files: b }), /tidak valid/); }
    assert.strictEqual(ps.count(), 3, 'yang cacat tidak meninggalkan postingan');
    assert.throws(() => ps.create({ text: 'x', files: [{ id: A, name: 'tak-ada.bin', size: 5 }] }), /Berkas lampiran belum disalin/, 'metadata tanpa berkas ditolak (3a-2)');
    assert.strictEqual(normFiles(Array.from({ length: FILES_MAX }, (_, i) => ({ id: String(i).padStart(16, '0'), name: 'f', size: 1 }))).length, FILES_MAX, 'tepat batas boleh');
    // berkas di disk yang rusak (files cacat) membuat postingan dianggap rusak, bukan lolos
    const raw = JSON.parse(fs.readFileSync(postPath(dir, p.id), 'utf8')); raw.files = [{ id: 'bukan-hex', name: 'a', size: 1 }];
    const d2 = fresh(), s2 = new PageStore(d2), q = s2.create({ text: 'ok' });
    fs.writeFileSync(postPath(d2, q.id), JSON.stringify(Object.assign({}, q, { files: raw.files })));
    assert.strictEqual(new PageStore(d2).get(q.id), null, 'files cacat di disk = postingan tidak terbaca');
    ok('berkas lampiran (3a-1): tersimpan/dibuka ulang/wire, nama dibersihkan, batas 10 dan 2 GiB, id ganda atau sama dengan gambar dan semua bentuk cacat ditolak');
  }

  // ---- P. salin berkas lampiran addFiles (3a-2) ----
  {
    const filesOn = (dir) => { try { return fs.readdirSync(path.join(dir, 'files')).sort(); } catch { return []; } };
    const mkf = (name, buf) => { const f = path.join(tmp, name); fs.writeFileSync(f, buf); return f; };
    const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const noTmp = (dir) => assert.deepStrictEqual(leftovers(dir), [], 'tidak ada .tmp tersisa');
    // 1. normal: apa pun isinya (bukan gambar pun boleh), identik, tanpa ekstensi di penyimpanan, bertahan walau sumber dihapus, hapus postingan membuang berkasnya
    {
      const dir = fresh(), ps = new PageStore(dir), buf = require('crypto').randomBytes(5 * 1048576 + 17); // lebih dari satu potongan 4 MB
      const src = mkf('data.bin', buf), src2 = mkf('catatan.txt', Buffer.from('halo'));
      const fs2 = await ps.addFiles([{ src }, { src: src2 }]);
      assert.deepStrictEqual(fs2.map((f) => [f.name, f.size]), [['data.bin', buf.length], ['catatan.txt', 4]]);
      assert.deepStrictEqual(filesOn(dir), fs2.map((f) => f.id).sort(), 'tersalin di files/<id> tanpa ekstensi');
      assert.strictEqual(sha(path.join(dir, 'files', fs2[0].id)), sha(src), 'salinan identik');
      assert.strictEqual(ps.filePath(fs2[0]), path.join(dir, 'files', fs2[0].id)); assert.strictEqual(ps.filePath({ id: 'cccccccccccccccc', name: 'x', size: 1 }), null);
      fs.unlinkSync(src);
      const p = ps.create({ text: 'lampiran', files: fs2 });
      assert.deepStrictEqual(new PageStore(dir).get(p.id).files, fs2);
      assert.strictEqual(ps.remove(p.id), true); assert.deepStrictEqual(filesOn(dir), [], 'hapus postingan membuang SEMUA lampirannya'); noTmp(dir);
      ps.dropFile('../x'); ps.dropFile('zz'); // id jahat tidak berefek dan tidak melempar
    }
    // 2. ditolak tanpa sisa: kosong, folder, tak ada, jalur cacat, terlalu banyak, satu gagal membuang yang sudah tersalin (pesan menyebut urutan)
    {
      const dir = fresh(), ps = new PageStore(dir), ok1 = mkf('ok1.bin', Buffer.from('a')), empty = mkf('kosong.bin', Buffer.alloc(0));
      await assert.rejects(ps.addFiles([{ src: empty }]), /Berkas kosong/);
      await assert.rejects(ps.addFiles([{ src: tmp }]), /Bukan berkas biasa/);
      await assert.rejects(ps.addFiles([{ src: path.join(tmp, 'tak-ada') }]), (e) => e.code === 'ENOENT');
      await assert.rejects(ps.addFiles([{ src: '' }]), /Jalur berkas/); await assert.rejects(ps.addFiles([null]), /Berkas tidak valid/); await assert.rejects(ps.addFiles('x'), /Daftar berkas/);
      await assert.rejects(ps.addFiles(Array.from({ length: FILES_MAX + 1 }, () => ({ src: ok1 }))), /Daftar berkas/);
      await assert.rejects(ps.addFiles([{ src: ok1 }, { src: ok1 }, { src: empty }]), /Berkas ke-3: Berkas kosong/);
      assert.deepStrictEqual(filesOn(dir), [], 'yang sudah tersalin dibuang lagi'); noTmp(dir);
      assert.strictEqual((await ps.addFiles(Array.from({ length: FILES_MAX }, () => ({ src: ok1 })))).length, FILES_MAX, 'tepat batas boleh');
      assert.deepStrictEqual(await new PageStore(fresh()).addFiles([]), [], 'daftar kosong = kosong');
    }
    // 3. nama panjang mempertahankan ekstensi; nama hanya karakter kontrol jadi "berkas"
    {
      const dir = fresh(), ps = new PageStore(dir), long = 'n'.repeat(200) + '.pdf';
      const [a] = await ps.addFiles([{ src: mkf(long, Buffer.from('x')) }]);
      assert.strictEqual(a.name.length, 120); assert.ok(a.name.endsWith('.pdf'), 'ekstensi terjaga');
      const [b] = await ps.addFiles([{ src: mkf('\u200b', Buffer.from('x')) }]); assert.strictEqual(b.name, 'berkas');
    }
    // 4. berkas besar (100 MB sparse): berpotongan, event loop hidup, 2 GiB ditolak, sumber berubah dan disk penuh gagal bersih
    {
      const dir = fresh(), ps = new PageStore(dir), SZ = 100 * 1048576, f = path.join(tmp, 'besar.bin'), fd = fs.openSync(f, 'w'); fs.ftruncateSync(fd, SZ); fs.closeSync(fd);
      const orig = fs.readFileSync, seen = []; fs.readFileSync = function (...a) { if (a[0] === f) seen.push(1); return orig.apply(fs, a); };
      let ticks = 0; const iv = setInterval(() => ticks++, 1);
      let r; try { r = await ps.addFiles([{ src: f }]); } finally { fs.readFileSync = orig; clearInterval(iv); }
      assert.strictEqual(seen.length, 0, 'tidak readFileSync utuh'); assert.ok(ticks > 0, 'event loop tetap hidup selama menyalin');
      assert.strictEqual(fs.statSync(path.join(dir, 'files', r[0].id)).size, SZ); noTmp(dir);
      const big = path.join(tmp, 'raksasa.bin'), bfd = fs.openSync(big, 'w'); fs.ftruncateSync(bfd, PAGE_FILE_MAX + 1); fs.closeSync(bfd);
      await assert.rejects(ps.addFiles([{ src: big }]), /terlalu besar/);
      const grow = mkf('tumbuh.bin', Buffer.alloc(9 * 1048576, 1)), rs = fs.writeSync; let calls = 0;
      fs.writeSync = function (...a) { if (++calls === 2) fs.appendFileSync(grow, 'tambah'); return rs.apply(fs, a); };
      try { await assert.rejects(ps.addFiles([{ src: grow }]), /Berkas berubah saat disalin/); } finally { fs.writeSync = rs; }
      calls = 0; fs.writeSync = function (...a) { if (++calls === 3) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return rs.apply(fs, a); };
      try { await assert.rejects(ps.addFiles([{ src: mkf('ok2.bin', Buffer.from('z')) }, { src: grow }]), (e) => e.code === 'ENOSPC' && /Berkas ke-2: Penyimpanan penuh/.test(e.message)); } finally { fs.writeSync = rs; }
      assert.deepStrictEqual(filesOn(dir), [r[0].id], 'hanya salinan sukses sebelumnya yang tersisa'); noTmp(dir);
    }
    // 5. sisa .tmp dari crash dibuang saat dibuka; create menolak berkas yang hilang atau ukurannya tak cocok
    {
      const dir = fresh(), ps = new PageStore(dir), [a] = await ps.addFiles([{ src: mkf('c.bin', Buffer.from('abcd')) }]);
      fs.writeFileSync(path.join(dir, 'files', 'dddddddddddddddd.tmp'), 'sisa'); new PageStore(dir); assert.ok(!fs.existsSync(path.join(dir, 'files', 'dddddddddddddddd.tmp')), 'sisa .tmp dibuang');
      assert.throws(() => ps.create({ text: 'x', files: [{ ...a, size: 5 }] }), /belum disalin/, 'ukuran tak cocok');
      ps.dropFile(a.id); assert.throws(() => ps.create({ text: 'x', files: [a] }), /belum disalin/, 'berkas hilang');
      assert.strictEqual(ps.count(), 0);
      // id jahat pada dropFile tidak boleh keluar dari files/ (path traversal)
      const victim = path.join(dir, 'x'); fs.writeFileSync(victim, 'jangan dihapus'); ps.dropFile('../x'); assert.ok(fs.existsSync(victim), 'dropFile menolak id bukan 16 hex');
      // berkas menyusut antara stat dan baca: gagal, bukan salinan terpotong
      const sh = mkf('susut.bin', Buffer.alloc(10, 1)), st0 = fs.statSync; fs.statSync = function (f, ...r) { const o = st0.call(fs, f, ...r); return f === sh ? Object.assign(Object.create(Object.getPrototypeOf(o)), o, { size: 50, isFile: () => true }) : o; };
      try { await assert.rejects(ps.addFiles([{ src: sh }]), /Berkas berubah saat dibaca/); } finally { fs.statSync = st0; }
      assert.deepStrictEqual(filesOn(dir), [a.id].filter(() => false), 'tidak ada sisa'); noTmp(dir);
    }
    ok('addFiles (3a-2): salin berpotongan identik tanpa ekstensi, semua-atau-tidak, kosong/folder/tak ada/terlalu banyak ditolak, nama panjang mempertahankan ekstensi, 100 MB tanpa readFileSync, sumber berubah dan disk penuh bersih, hapus membuang lampiran, create memeriksa berkasnya');
  }

  // ---- Q. potongan byte lampiran untuk penonton (3a-3) ----
  {
    const ME = 'aaaaaaaaaaaaaaaa', FR = '1111111111111111', ST = '2222222222222222', BL = '3333333333333333';
    const rel = { [ME]: 'owner', [FR]: 'friend', [ST]: 'public', [BL]: 'blocked' };
    const dir = fresh(), ps = new PageStore(dir, { relation: (id) => rel[id] || 'public' });
    assert.strictEqual(FILE_CHUNK, MEDIA_CHUNK, 'satu ukuran potongan untuk gambar dan lampiran');
    const big = require('crypto').randomBytes(FILE_CHUNK * 2 + 123), fb = path.join(tmp, 'lampiran-besar.bin'); fs.writeFileSync(fb, big);
    const sm = path.join(tmp, 'lampiran-kecil.txt'); fs.writeFileSync(sm, 'rahasia teman');
    const pngf = path.join(tmp, 'g.png'); fs.writeFileSync(pngf, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex'));
    const [fbig, fsm] = await ps.addFiles([{ src: fb }, { src: sm }]), [img] = await ps.addMedias([{ src: pngf }]);
    const pubPost = ps.create({ text: 'publik', files: [fbig], media: [img] }), frPost = ps.create({ text: 'teman', priv: 'friends', files: [fsm] });

    // 1. pemilik, teman, dan orang asing merakit berkas utuh; len dipangkas ke FILE_CHUNK dan ke sisa; tanpa mime
    for (const who of [ME, ST, FR]) {
      const parts = []; let off = 0, total = 0;
      while (off < big.length) { const r = ps.readFileFor(who, pubPost.id, fbig.id, off, 99999999); assert.ok(r && r.b.length > 0 && r.b.length <= FILE_CHUNK); assert.strictEqual(r.off, off); assert.ok(!('mime' in r)); total = r.total; parts.push(r.b); off += r.b.length; }
      assert.strictEqual(total, big.length); assert.ok(Buffer.concat(parts).equals(big), 'hasil rakitan identik'); assert.strictEqual(parts.length, 3, '2 potongan penuh + 1 sisa');
    }
    assert.strictEqual(ps.readFileFor(ST, pubPost.id, fbig.id, 10, 5).b.length, 5, 'len kecil dihormati');

    // 2. privasi: sama dengan gambar; ditolak = null, tak terbedakan dari "tidak ada"
    assert.ok(ps.readFileFor(FR, frPost.id, fsm.id, 0, 99) && ps.readFileFor(ME, frPost.id, fsm.id, 0, 99), 'teman dan pemilik boleh');
    assert.strictEqual(ps.readFileFor(ST, frPost.id, fsm.id, 0, 99), null, 'orang asing tidak boleh membaca lampiran postingan Teman');
    assert.strictEqual(ps.readFileFor(BL, pubPost.id, fbig.id, 0, 10), null, 'diblokir tidak boleh walau postingannya Publik');
    assert.strictEqual(ps.readFileFor(null, pubPost.id, fbig.id, 0, 10), null); assert.strictEqual(ps.readFileFor('bukan-id', pubPost.id, fbig.id, 0, 10), null);
    rel[FR] = 'public'; assert.strictEqual(ps.readFileFor(FR, frPost.id, fsm.id, 0, 99), null, 'relasi dilihat tiap panggilan: bukan teman lagi = ditolak'); rel[FR] = 'friend';

    // 3. id harus milik postingan itu dan berjenis lampiran; gambar dan lampiran tidak tertukar; argumen dan rentang cacat = null
    assert.strictEqual(ps.readFileFor(ME, pubPost.id, fsm.id, 0, 10), null, 'lampiran postingan lain tidak bisa diambil lewat postingan ini');
    assert.strictEqual(ps.readFileFor(ME, pubPost.id, img.id, 0, 10), null, 'id gambar tidak bisa dibaca sebagai lampiran');
    assert.strictEqual(ps.readMediaFor(ME, pubPost.id, fbig.id, 0, 10), null, 'id lampiran tidak bisa dibaca sebagai gambar');
    assert.strictEqual(ps.readFileFor(ME, 'bbbbbbbbbbbbbbbb', fbig.id, 0, 10), null, 'postingan tidak ada');
    for (const bad of ['../x', 5, null, undefined, 'cccccccccccccccc']) assert.strictEqual(ps.readFileFor(ME, pubPost.id, bad, 0, 10), null, 'id cacat/asing: ' + bad);
    for (const [o, l] of [[big.length, 1], [-1, 10], [1.5, 10], [0, 0], [0, -4], [0, NaN], ['0', 10], [Infinity, 1]]) assert.strictEqual(ps.readFileFor(ME, pubPost.id, fbig.id, o, l), null, 'rentang cacat: ' + o + ',' + l);

    // 4. berkas hilang / berubah ukuran = null, bukan potongan rusak; postingan tanpa lampiran = null
    const plain = ps.create({ text: 'polos' }); assert.strictEqual(ps.readFileFor(ME, plain.id, fbig.id, 0, 10), null);
    fs.appendFileSync(path.join(dir, 'files', fsm.id), 'x'); assert.strictEqual(ps.readFileFor(ME, frPost.id, fsm.id, 0, 10), null, 'ukuran berubah');
    ps.dropFile(fbig.id); assert.strictEqual(ps.readFileFor(ME, pubPost.id, fbig.id, 0, 10), null, 'berkas hilang');
    ok('readFileFor (3a-3): rakit potongan identik tanpa mime, privasi seperti gambar, id gambar dan lampiran tak tertukar, rentang cacat/berkas hilang/berubah = null');
  }

  // ---- R. video: metadata (3c-1; berkas nyata sejak 3c-2) ----
  const mp4 = (n) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), require('crypto').randomBytes(Math.max(0, n - 12))]);
  const webm = (n) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm'), require('crypto').randomBytes(Math.max(0, n - 12))]);
  const mkv = (name, buf) => { const f = path.join(tmp, name); fs.writeFileSync(f, buf); return f; };
  {
    const dir = fresh(), ps = new PageStore(dir);
    const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc', D = 'dddddddddddddddd', PID = '1111111111111111';
    assert.strictEqual(VIDEOS_MAX, 4); assert.strictEqual(PAGE_VIDEO_MAX, 2 * 1024 * 1024 * 1024); assert.deepStrictEqual(VIDEO_MIME, ['video/mp4', 'video/webm']);
    // normal: tersimpan, nama dibersihkan, bidang asing dibuang, urutan terjaga, bertahan dibuka ulang, lewat wirePost dan wireList
    const vids = await ps.addVideos([{ src: mkv('liburan\u202e.mp4', mp4(5000)) }, { src: mkv('klip.webm', webm(77)) }]);
    const p = ps.create({ text: 'ada video', videos: vids.map((v) => Object.assign({ extra: 'dibuang' }, v)) });
    const want = [{ id: vids[0].id, mime: 'video/mp4', size: 5000, name: 'liburan.mp4' }, { id: vids[1].id, mime: 'video/webm', size: 77, name: 'klip.webm' }];
    assert.deepStrictEqual(p.videos, want, 'nama dibersihkan, bidang asing dibuang, urutan terjaga');
    assert.deepStrictEqual(new PageStore(dir).get(p.id).videos, want, 'bertahan setelah dibuka ulang');
    assert.deepStrictEqual(wirePost(ps.get(p.id)).videos, want, 'wirePost meneruskan');
    assert.deepStrictEqual(wireList({ items: [ps.get(p.id)], next: null, count: 1 }, { limit: 10 }).items[0].videos, want, 'wireList juga');
    assert.ok(!('videos' in ps.create({ text: 'polos' })) && !('videos' in ps.create({ text: 'kosong', videos: [] })), 'tanpa/kosong = tanpa field (postingan lama sama persis)');
    // berdampingan dengan gambar dan lampiran: boleh bila semua id berbeda; id sama di dua daftar mana pun = cacat
    const base = { v: 1, id: PID, ts: 5, kind: 'text', text: 'x', priv: 'public' };
    const med = [{ id: C, mime: 'image/png', size: 10, name: 'g.png' }], fil = [{ id: D, name: 'f.bin', size: 1 }], vid = [{ id: A, mime: 'video/mp4', size: 9, name: 'v.mp4' }];
    const w3 = wirePost(Object.assign({}, base, { media: med, files: fil, videos: vid }));
    assert.ok(w3 && w3.media && w3.files && w3.videos, 'tiga jenis sekaligus, id berbeda = sah');
    assert.strictEqual(wirePost(Object.assign({}, base, { media: med, videos: [{ id: C, mime: 'video/mp4', size: 9, name: 'v.mp4' }] })), null, 'id video = id gambar -> cacat');
    assert.strictEqual(wirePost(Object.assign({}, base, { files: fil, videos: [{ id: D, mime: 'video/mp4', size: 9, name: 'v.mp4' }] })), null, 'id video = id lampiran -> cacat');
    // cacat: semuanya ditolak tanpa sisa
    const V = (o) => Object.assign({ id: A, mime: 'video/mp4', size: 1, name: 'v.mp4' }, o);
    const bad = [
      [V({ id: 'xyz' })], [V({ mime: 'video/quicktime' })], [V({ mime: 'image/png' })], [V({ mime: 'video/mp4; codecs=avc1' })], [V({ mime: 'VIDEO/MP4' })], [V({ mime: undefined })],
      [V({ size: 0 })], [V({ size: -1 })], [V({ size: 1.5 })], [V({ size: PAGE_VIDEO_MAX + 1 })], [V({ name: '' })], [V({ name: '\u200b' })], [V({ name: 'x'.repeat(121) })], [V({ name: 5 })],
      [V({}), V({ mime: 'video/webm', name: 'b.webm' })], Array.from({ length: VIDEOS_MAX + 1 }, (_, i) => V({ id: String(i).padStart(16, '0') })), 'bukan larik', [null],
    ];
    for (const b of bad) { assert.strictEqual(normVideos(b), null, 'cacat: ' + JSON.stringify(b).slice(0, 70)); assert.throws(() => ps.create({ text: 'x', videos: b }), /tidak valid/); }
    assert.strictEqual(ps.count(), 3, 'yang cacat tidak meninggalkan postingan');
    assert.strictEqual(normVideos(Array.from({ length: VIDEOS_MAX }, (_, i) => V({ id: String(i).padStart(16, '0') }))).length, VIDEOS_MAX, 'tepat batas jumlah boleh');
    assert.strictEqual(normVideos([V({ size: PAGE_VIDEO_MAX })])[0].size, PAGE_VIDEO_MAX, 'tepat batas ukuran boleh');
    // berkas di disk yang rusak (videos cacat) membuat postingan dianggap rusak, bukan lolos
    const d2 = fresh(), s2 = new PageStore(d2), q = s2.create({ text: 'ok' });
    fs.writeFileSync(postPath(d2, q.id), JSON.stringify(Object.assign({}, q, { videos: [V({ mime: 'video/x-matroska' })] })));
    assert.strictEqual(new PageStore(d2).get(q.id), null, 'videos cacat di disk = postingan tidak terbaca');
    ok('video (3c-1): metadata tersimpan/dibuka ulang/wire, nama dibersihkan, mime mp4/webm saja, batas 4 dan 2 GiB, id ganda atau sama dengan gambar/lampiran dan semua bentuk cacat ditolak');
  }

  // ---- S. salin video addVideos (3c-2) ----
  {
    const vidsOn = (dir) => { try { return fs.readdirSync(path.join(dir, 'videos')).sort(); } catch { return []; } };
    const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const noTmp = (dir) => assert.deepStrictEqual(leftovers(dir), [], 'tidak ada .tmp tersisa');
    // 1. normal: identik, tanpa ekstensi di penyimpanan, mime dari isi, bertahan walau sumber dihapus, hapus postingan membuang berkasnya
    {
      const dir = fresh(), ps = new PageStore(dir), b1 = mp4(5 * 1048576 + 17); // lebih dari satu potongan 4 MB
      const s1 = mkv('a1.mp4', b1), s2 = mkv('b1.m4v', mp4(40)), s3 = mkv('c1.webm', webm(40));
      const r = await ps.addVideos([{ src: s1 }, { src: s2 }, { src: s3 }]);
      assert.deepStrictEqual(r.map((v) => [v.name, v.mime, v.size]), [['a1.mp4', 'video/mp4', b1.length], ['b1.m4v', 'video/mp4', 40], ['c1.webm', 'video/webm', 40]]);
      assert.deepStrictEqual(vidsOn(dir), r.map((v) => v.id).sort(), 'tersalin di videos/<id> tanpa ekstensi');
      assert.strictEqual(sha(path.join(dir, 'videos', r[0].id)), sha(s1), 'salinan identik');
      assert.strictEqual(ps.videoPath(r[0]), path.join(dir, 'videos', r[0].id)); assert.strictEqual(ps.videoPath({ id: 'cccccccccccccccc', mime: 'video/mp4', size: 1, name: 'x.mp4' }), null);
      fs.unlinkSync(s1);
      const p = ps.create({ text: 'video', videos: r });
      assert.deepStrictEqual(new PageStore(dir).get(p.id).videos, r);
      assert.strictEqual(ps.remove(p.id), true); assert.deepStrictEqual(vidsOn(dir), [], 'hapus postingan membuang SEMUA videonya'); noTmp(dir);
      ps.dropVideo('../x'); ps.dropVideo('zz');
    }
    // 2. ditolak tanpa sisa: kosong, folder, tak ada, jalur cacat, jenis salah (ekstensi atau isi), terlalu banyak; satu gagal membuang yang sudah tersalin
    {
      const dir = fresh(), ps = new PageStore(dir), ok1 = mkv('ok1.mp4', mp4(50));
      await assert.rejects(ps.addVideos([{ src: mkv('kosong.mp4', Buffer.alloc(0)) }]), /Video kosong/);
      await assert.rejects(ps.addVideos([{ src: tmp }]), /Bukan berkas biasa/);
      await assert.rejects(ps.addVideos([{ src: path.join(tmp, 'tak-ada.mp4') }]), (e) => e.code === 'ENOENT');
      await assert.rejects(ps.addVideos([{ src: '' }]), /Jalur video/); await assert.rejects(ps.addVideos([null]), /Video tidak valid/); await assert.rejects(ps.addVideos('x'), /Daftar video/);
      await assert.rejects(ps.addVideos(Array.from({ length: VIDEOS_MAX + 1 }, () => ({ src: ok1 }))), /Daftar video/);
      await assert.rejects(ps.addVideos([{ src: mkv('v.mkv', mp4(50)) }]), /Bukan video yang didukung/, 'ekstensi mkv');
      await assert.rejects(ps.addVideos([{ src: mkv('v.txt', mp4(50)) }]), /Bukan video yang didukung/, 'ekstensi txt');
      await assert.rejects(ps.addVideos([{ src: mkv('v.m4a', mp4(50)) }]), /Bukan video yang didukung/, 'ekstensi audio');
      await assert.rejects(ps.addVideos([{ src: mkv('palsu1.mp4', webm(50)) }]), /Isi berkas bukan video/, 'isi webm berekstensi mp4');
      await assert.rejects(ps.addVideos([{ src: mkv('palsu2.webm', mp4(50)) }]), /Isi berkas bukan video/, 'isi mp4 berekstensi webm');
      await assert.rejects(ps.addVideos([{ src: mkv('palsu3.mp4', Buffer.from('ini bukan video sama sekali, hanya teks biasa')) }]), /Isi berkas bukan video/, 'isi teks');
      await assert.rejects(ps.addVideos([{ src: mkv('palsu4.mp4', Buffer.from('ftyp')) }]), /Isi berkas bukan video/, 'terlalu pendek untuk dikenali');
      await assert.rejects(ps.addVideos([{ src: mkv('palsu5.mp4', Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(40)])) }]), /Isi berkas bukan video/, 'isi mp3');
      await assert.rejects(ps.addVideos([{ src: ok1 }, { src: ok1 }, { src: mkv('palsu6.mp4', Buffer.alloc(30)) }]), /Video ke-3: Isi berkas bukan video/);
      assert.deepStrictEqual(vidsOn(dir), [], 'yang sudah tersalin dibuang lagi, tanpa sisa'); noTmp(dir);
      assert.strictEqual((await ps.addVideos(Array.from({ length: VIDEOS_MAX }, () => ({ src: ok1 })))).length, VIDEOS_MAX, 'tepat batas boleh');
      assert.deepStrictEqual(await new PageStore(fresh()).addVideos([]), [], 'daftar kosong = kosong');
    }
    // 3. nama panjang mempertahankan ekstensi
    {
      const ps = new PageStore(fresh()), [a] = await ps.addVideos([{ src: mkv('n'.repeat(200) + '.webm', webm(30)) }]);
      assert.strictEqual(a.name.length, 120); assert.ok(a.name.endsWith('.webm'), 'ekstensi terjaga'); assert.strictEqual(a.mime, 'video/webm');
    }
    // 4. video besar (100 MB sparse): berpotongan, event loop hidup, 2 GiB ditolak, sumber berubah dan disk penuh gagal bersih
    {
      const dir = fresh(), ps = new PageStore(dir), SZ = 100 * 1048576, f = path.join(tmp, 'besar.mp4'), fd = fs.openSync(f, 'w'); fs.writeSync(fd, mp4(64), 0, 64, 0); fs.ftruncateSync(fd, SZ); fs.closeSync(fd);
      const orig = fs.readFileSync, seen = []; fs.readFileSync = function (...a) { if (a[0] === f) seen.push(1); return orig.apply(fs, a); };
      let ticks = 0; const iv = setInterval(() => ticks++, 1);
      let r; try { r = await ps.addVideos([{ src: f }]); } finally { fs.readFileSync = orig; clearInterval(iv); }
      assert.strictEqual(seen.length, 0, 'tidak readFileSync utuh'); assert.ok(ticks > 0, 'event loop tetap hidup selama menyalin');
      assert.strictEqual(fs.statSync(path.join(dir, 'videos', r[0].id)).size, SZ); noTmp(dir);
      const big = path.join(tmp, 'raksasa.mp4'), bfd = fs.openSync(big, 'w'); fs.writeSync(bfd, mp4(64), 0, 64, 0); fs.ftruncateSync(bfd, PAGE_VIDEO_MAX + 1); fs.closeSync(bfd);
      await assert.rejects(ps.addVideos([{ src: big }]), /terlalu besar/);
      const grow = mkv('tumbuh.mp4', mp4(9 * 1048576)), rs = fs.writeSync; let calls = 0;
      fs.writeSync = function (...a) { if (++calls === 2) fs.appendFileSync(grow, 'tambah'); return rs.apply(fs, a); };
      try { await assert.rejects(ps.addVideos([{ src: grow }]), /Video berubah saat disalin/); } finally { fs.writeSync = rs; }
      calls = 0; fs.writeSync = function (...a) { if (++calls === 3) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); return rs.apply(fs, a); };
      try { await assert.rejects(ps.addVideos([{ src: mkv('ok2.mp4', mp4(100)) }, { src: grow }]), (e) => e.code === 'ENOSPC' && /Video ke-2: Penyimpanan penuh/.test(e.message)); } finally { fs.writeSync = rs; }
      assert.deepStrictEqual(vidsOn(dir), [r[0].id], 'hanya salinan sukses sebelumnya yang tersisa'); noTmp(dir);
    }
    // 5. sisa .tmp dibuang saat dibuka; create menolak video yang hilang / ukurannya tak cocok; dropVideo tidak keluar dari videos/
    {
      const dir = fresh(), ps = new PageStore(dir), [a] = await ps.addVideos([{ src: mkv('c2.mp4', mp4(64)) }]);
      fs.writeFileSync(path.join(dir, 'videos', 'dddddddddddddddd.tmp'), 'sisa'); new PageStore(dir); assert.ok(!fs.existsSync(path.join(dir, 'videos', 'dddddddddddddddd.tmp')), 'sisa .tmp dibuang');
      assert.throws(() => ps.create({ text: 'x', videos: [Object.assign({}, a, { size: 65 })] }), /Berkas video belum disalin/, 'ukuran tak cocok');
      const keep = path.join(dir, 'files'); fs.mkdirSync(keep, { recursive: true }); fs.writeFileSync(path.join(keep, 'eeeeeeeeeeeeeeee'), 'x');
      ps.dropVideo('../files/eeeeeeeeeeeeeeee'); assert.ok(fs.existsSync(path.join(keep, 'eeeeeeeeeeeeeeee')), 'id jahat tidak menghapus berkas di luar videos/');
      ps.dropVideo(a.id); assert.throws(() => ps.create({ text: 'x', videos: [a] }), /Berkas video belum disalin/, 'berkas hilang');
      assert.strictEqual(ps.count(), 0);
    }
    ok('addVideos (3c-2): salin berpotongan identik tanpa ekstensi, mime dari isi, ekstensi dan isi harus cocok (mkv/txt/m4a/webm-di-mp4/teks/mp3 ditolak), semua-atau-tidak, nama panjang mempertahankan ekstensi, 100 MB tanpa readFileSync, 2 GiB, sumber berubah dan disk penuh bersih, hapus membuang video, create memeriksa berkasnya');
  }

  // ---- T. potongan byte video untuk penonton (3c-3) ----
  {
    const ME = 'aaaaaaaaaaaaaaaa', FR = '1111111111111111', ST = '2222222222222222', BL = '3333333333333333';
    const rel = { [ME]: 'owner', [FR]: 'friend', [ST]: 'public', [BL]: 'blocked' };
    const dir = fresh(), ps = new PageStore(dir, { relation: (id) => rel[id] || 'public' });
    assert.strictEqual(VIDEO_CHUNK, MEDIA_CHUNK, 'satu ukuran potongan untuk gambar, lampiran, dan video');
    const big = mp4(VIDEO_CHUNK * 3 + 123), small = webm(900);
    const [vbig, vsm] = await ps.addVideos([{ src: mkv('t-besar.mp4', big) }, { src: mkv('t-kecil.webm', small) }]);
    const [fl] = await ps.addFiles([{ src: mkv('t-lampiran.bin', Buffer.from('lampiran')) }]);
    const pubPost = ps.create({ text: 'publik', videos: [vbig], files: [fl] }), frPost = ps.create({ text: 'teman', priv: 'friends', videos: [vsm] });
    const ndPost = ps.create({ text: 'tanpa unduh', videos: [vsm.id === vbig.id ? vbig : Object.assign({}, vbig)], nodl: true });

    // 1. pemilik, teman, orang asing merakit video utuh dari awal ke akhir; len dipangkas ke VIDEO_CHUNK dan ke sisa; mime ikut
    for (const who of [ME, ST, FR]) {
      const parts = []; let off = 0, total = 0;
      while (off < big.length) { const r = ps.readVideoFor(who, pubPost.id, vbig.id, off, 99999999); assert.ok(r && r.b.length > 0 && r.b.length <= VIDEO_CHUNK); assert.strictEqual(r.off, off); assert.strictEqual(r.mime, 'video/mp4'); total = r.total; parts.push(r.b); off += r.b.length; }
      assert.strictEqual(total, big.length); assert.ok(Buffer.concat(parts).equals(big), 'hasil rakitan identik'); assert.strictEqual(parts.length, 4, '3 potongan penuh + 1 sisa');
    }
    assert.strictEqual(ps.readVideoFor(ST, pubPost.id, vbig.id, 10, 5).b.length, 5, 'len kecil dihormati');
    // akses acak (seek): potongan dari posisi mana pun identik dengan aslinya, termasuk tepat di batas dan byte terakhir
    for (const o of [0, 1, VIDEO_CHUNK - 1, VIDEO_CHUNK, VIDEO_CHUNK + 7, 2 * VIDEO_CHUNK + 4096, big.length - 1, big.length - 100]) {
      const r = ps.readVideoFor(ST, pubPost.id, vbig.id, o, 4096); assert.ok(r, 'seek ke ' + o); assert.strictEqual(r.off, o);
      assert.ok(r.b.equals(big.subarray(o, o + r.b.length)), 'isi di ' + o + ' cocok'); assert.strictEqual(r.b.length, Math.min(4096, big.length - o));
    }
    assert.strictEqual(ps.readVideoFor(ST, pubPost.id, vsm.id, 0, 10), null, 'video postingan lain tidak bisa diambil lewat postingan ini');

    // 2. privasi: sama dengan gambar; ditolak = null, tak terbedakan dari "tidak ada"
    assert.ok(ps.readVideoFor(FR, frPost.id, vsm.id, 0, 99) && ps.readVideoFor(ME, frPost.id, vsm.id, 0, 99), 'teman dan pemilik boleh');
    assert.strictEqual(ps.readVideoFor(ST, frPost.id, vsm.id, 0, 99), null, 'orang asing tidak boleh memutar video postingan Teman');
    assert.strictEqual(ps.readVideoFor(BL, pubPost.id, vbig.id, 0, 10), null, 'diblokir tidak boleh walau postingannya Publik');
    assert.strictEqual(ps.readVideoFor(null, pubPost.id, vbig.id, 0, 10), null); assert.strictEqual(ps.readVideoFor('bukan-id', pubPost.id, vbig.id, 0, 10), null);
    rel[FR] = 'public'; assert.strictEqual(ps.readVideoFor(FR, frPost.id, vsm.id, 0, 99), null, 'relasi dilihat tiap panggilan: bukan teman lagi = ditolak'); rel[FR] = 'friend';

    // 3. nodl tidak berlaku untuk video (diputar, bukan diunduh), padahal lampiran postingan yang sama ditutup
    assert.ok(ps.readVideoFor(ST, ndPost.id, vbig.id, 0, 10), 'video tetap bisa diputar walau nodl');
    ps.setDl(pubPost.id, false); assert.strictEqual(ps.readFileFor(ST, pubPost.id, fl.id, 0, 5), null, 'lampiran ditutup oleh nodl'); assert.ok(ps.readVideoFor(ST, pubPost.id, vbig.id, 0, 10), 'video tidak ikut ditutup'); ps.setDl(pubPost.id, true);

    // 4. id harus milik postingan itu dan berjenis video; jenis tidak tertukar; argumen dan rentang cacat = null
    assert.strictEqual(ps.readVideoFor(ME, pubPost.id, fl.id, 0, 10), null, 'id lampiran tidak bisa dibaca sebagai video');
    assert.strictEqual(ps.readFileFor(ME, pubPost.id, vbig.id, 0, 10), null, 'id video tidak bisa dibaca sebagai lampiran');
    assert.strictEqual(ps.readMediaFor(ME, pubPost.id, vbig.id, 0, 10), null, 'id video tidak bisa dibaca sebagai gambar');
    assert.strictEqual(ps.readVideoFor(ME, 'bbbbbbbbbbbbbbbb', vbig.id, 0, 10), null, 'postingan tidak ada');
    for (const bad of ['../x', 5, null, undefined, 'cccccccccccccccc']) assert.strictEqual(ps.readVideoFor(ME, pubPost.id, bad, 0, 10), null, 'id cacat/asing: ' + bad);
    for (const [o, l] of [[big.length, 1], [-1, 10], [1.5, 10], [0, 0], [0, -4], [0, NaN], ['0', 10], [Infinity, 1]]) assert.strictEqual(ps.readVideoFor(ME, pubPost.id, vbig.id, o, l), null, 'rentang cacat: ' + o + ',' + l);

    // 5. berkas hilang / berubah ukuran = null, bukan potongan rusak; postingan tanpa video = null
    const plain = ps.create({ text: 'polos' }); assert.strictEqual(ps.readVideoFor(ME, plain.id, vbig.id, 0, 10), null);
    fs.appendFileSync(path.join(dir, 'videos', vsm.id), 'x'); assert.strictEqual(ps.readVideoFor(ME, frPost.id, vsm.id, 0, 10), null, 'ukuran berubah');
    ps.dropVideo(vbig.id); assert.strictEqual(ps.readVideoFor(ME, pubPost.id, vbig.id, 0, 10), null, 'berkas hilang');
    ok('readVideoFor (3c-3): rakit dan seek identik dengan mime, privasi seperti gambar, nodl tidak berlaku, id video/gambar/lampiran tak tertukar, rentang cacat/berkas hilang/berubah = null');
  }
  console.log('\n' + pass + ' kelompok OK');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
