'use strict';
// Tes Halaman 5f: tampilan POHON balasan komentar (renderer/js/archne-pages-cmt.js: pgCmtTree, tombol "Balas", kotak balas, pgCmtReplySend; kait 'creply' / 'rsend' / 'rcancel' di archne-pages.js; CSS archne-pages.css).
// Kelompok: A statis, B pohon (urutan DFS, indentasi, batas 5 tingkat, nama yang dibalas, yatim), C tombol Balas + kotak balas (satu saja, draf per induk, batal), D kirim (argumen IPC, penempatan, hitungan, draf),
// E galat (draf utuh + pesan, old memakai pesan Core, noparent membuang induk + toast), F klik dipalsukan, G induk dihapus (yatim + kotak balas tertutup), H Ctrl+Enter, I Halamanku (pemilik juga bisa membalas).
// Core / jaringan / antrean: test/pagecmtreply.js.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = '1'.repeat(16), PEER = 'a'.repeat(16), P1 = '0000000000000001', P2 = '0000000000000002';
const post = (n) => ({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public' });
const cmt = (n, o) => Object.assign({ id: 'c' + n.toString(16).padStart(15, '0'), by: PEER, ts: 1700000100000 + n * 1000, text: 'k' + n }, o || {});
const cid = (n) => cmt(n).id;

function boot(opt) {
  opt = opt || {};
  const els = {}, calls = [], toasts = [], asks = [];
  const st = { list: null, mine: null, cms: null, rm: { ok: true, removed: true }, del: { ok: true, st: 'removed' }, send: null, ans: true };
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener(t, f) { this.h[t] = f; }, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
  const val = (r, ...a) => (typeof r === 'function' ? r(...a) : r);
  const api = {
    pgList: async (...a) => { calls.push(['pgList', ...a]); return st.list; },
    pgMine: async (...a) => { calls.push(['pgMine', ...a]); return st.mine; },
    pgComments: async (...a) => { calls.push(['pgComments', ...a]); return val(st.cms, ...a); },
    pgCmtRemove: async (...a) => { calls.push(['pgCmtRemove', ...a]); return val(st.rm, ...a); },
    pgCmtDelete: async (...a) => { calls.push(['pgCmtDelete', ...a]); return val(st.del, ...a); },
    pgComment: async (...a) => { calls.push(['pgComment', ...a]); return val(st.send, ...a); },
    onPgDl: () => {},
  };
  const E = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { S: { me: { id: ME }, messages: [] }, esc: E, nameOf: (i) => 'nama-' + String(i).slice(0, 2), $: el, linkHtml: E, fmt: String, dayLabel: () => 'Hari ini', hm: () => '10:00', toast: (t) => toasts.push(t),
    ask: async (t) => { asks.push(t); return val(st.ans, t); }, renderProfile() {}, document: { addEventListener() {}, activeElement: null }, Date, Promise, setTimeout, Set,
    window: { api, history: { pushState() {}, back() {} }, location: { protocol: 'file:', pathname: '/archne-index.html' } }, profId: PEER };
  vm.createContext(ctx);
  vm.runInContext(rd('renderer/archne-filecard.js'), ctx);
  vm.runInContext(require('./_src').pagesJs(), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  return { els, calls, toasts, asks, st, run, ctx, H: () => els.pglist.innerHTML, cc: (n) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] === n))) };
}
const page = (items, o) => ({ ok: true, comments: Object.assign({ items, next: null, count: items.length, skipped: 0 }, o || {}) });
async function openMine(t, posts, items, o) { t.st.mine = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.st.cms = page(items, o); t.run(`pgOpen('${ME}')`); await sleep(10); await open(t, posts[0].id); }
async function openOther(t, posts, items, o) { t.st.list = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.st.cms = page(items, o); t.run(`pgOpen('${PEER}')`); await sleep(10); await open(t, posts[0].id); }
const open = async (t, id) => { click(t, 'cmt', id); await sleep(10); };
const click = (t, pg, id, c) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg, id, cid: c } }) } });
const type = (t, id, c, value) => t.els.pgmodal.h.input({ target: { dataset: { pg: 'rtxt', id, cid: c }, value, parentNode: null } });
const order = (t) => [...t.H().matchAll(/class="pgc[^"]*" data-cid="([^"]+)"/g)].map((m) => m[1]);
const cls = (t, c) => { const m = new RegExp('class="(pgc[^"]*)" data-cid="' + c + '"').exec(t.H()); return m ? m[1] : null; };
const boxes = (t) => (t.H().match(/data-pg="rtxt"/g) || []).length;
// c1 (atas) / c2 (balas c1) / c3 (balas c2) / c4 (balas c1) / c5 (atas)
const TREE = () => [cmt(1), cmt(2, { re: cid(1), by: ME }), cmt(3, { re: cid(2) }), cmt(4, { re: cid(1) }), cmt(5)];

(async () => {
  // A. statis
  {
    const js = rd('renderer/js/archne-pages-cmt.js'), pg = rd('renderer/js/archne-pages.js'), css = rd('renderer/css/archne-pages.css');
    for (const k of ["'creply'", "'rsend'", "'rcancel'"]) assert(pg.includes(k), 'kait ' + k + ' di archne-pages.js');
    assert(pg.includes("pg === 'rtxt'"), 'Ctrl+Enter di kotak balasan');
    for (const k of ['pgcrep', 'pgcre', 'pgcto', 'pgcd1', 'pgcd5', 'pgcrcomp']) assert(css.includes('.' + k), 'CSS ' + k);
    assert(!/pgcd6/.test(css) && /Math\.min\(5/.test(js), 'indentasi dibatasi 5 tingkat');
    assert(!/innerHTML\s*\+=/.test(js), 'pohon tidak disusun dengan rekursi DOM');
    ok('statis: kait klik, Ctrl+Enter, CSS (indentasi maks 5), pohon datar tanpa rekursi DOM');
  }
  // B. pohon
  {
    const t = boot(); await openOther(t, [post(1)], TREE());
    assert.deepStrictEqual(order(t), [1, 2, 3, 4, 5].map(cid), 'urutan DFS: induk, anak-anaknya (tertua dulu), lalu komentar atas berikutnya');
    assert.strictEqual(cls(t, cid(1)), 'pgc', 'tingkat atas = kelas lama persis'); assert.strictEqual(cls(t, cid(2)), 'pgc pgcd1 pgcre'); assert.strictEqual(cls(t, cid(3)), 'pgc pgcd2 pgcre'); assert.strictEqual(cls(t, cid(4)), 'pgc pgcd1 pgcre'); assert.strictEqual(cls(t, cid(5)), 'pgc');
    const H = t.H();
    assert(H.includes('↳ membalas nama-aa'), 'balasan menyebut nama yang dibalas (c2 membalas c1, c4 membalas c1)'); assert(H.includes('↳ membalas nama-11'), 'c3 membalas c2 yang ditulis ME');
    t.st.cms = page([cmt(1)]); // sudah dimuat: tidak memuat ulang
    // urutan masuk tidak penting: balasan lebih dulu di daftar (ts lebih kecil karena jam miring) tetap di bawah induknya
    const s = boot(); await openOther(s, [post(1)], [cmt(2, { re: cid(1), ts: 1700000000500 }), cmt(1)]);
    assert.deepStrictEqual(order(s), [1, 2].map(cid), 'balasan dengan ts lebih kecil dari induk tetap di bawah induknya');
    // yatim: induk tidak ada di daftar
    const o = boot(); await openOther(o, [post(1)], [cmt(2, { re: cid(9) }), cmt(3)]);
    assert.deepStrictEqual(order(o), [2, 3].map(cid)); assert.strictEqual(cls(o, cid(2)), 'pgc pgcre', 'yatim: tingkat atas'); assert(o.H().includes('↳ membalas komentar yang tidak tersedia'), 'keterangan yatim');
    // rantai dalam: indentasi dibatasi
    const chain = [cmt(1)]; for (let i = 2; i <= 9; i++) chain.push(cmt(i, { re: cid(i - 1) }));
    const d = boot(); await openOther(d, [post(1)], chain);
    assert.deepStrictEqual(order(d), chain.map((c) => c.id), 'rantai 9 tingkat: urutan benar'); assert.strictEqual(cls(d, cid(6)), 'pgc pgcd5 pgcre'); assert.strictEqual(cls(d, cid(9)), 'pgc pgcd5 pgcre', 'lebih dalam dari 5 sejajar tingkat 5'); assert(!d.H().includes('pgcd6') && !d.H().includes('pgcd8'));
    // nama dan teks di-escape; id bukan heks tidak menjadi tombol
    const e = boot(); await openOther(e, [post(1)], [cmt(1, { text: '<img src=x>' }), cmt(2, { re: cid(1), text: '<b>x</b>' })]); assert(!e.H().includes('<img') && !e.H().includes('<b>x'), 'teks balasan di-escape');
    ok('pohon: urutan DFS, tingkat atas = kelas lama, indentasi 1..5 (lebih dalam sejajar 5), nama yang dibalas, yatim berketerangan, ts miring tetap di bawah induk, escape');
  }
  // C. tombol Balas + kotak balas
  {
    const t = boot(); await openOther(t, [post(1)], TREE());
    assert.strictEqual((t.H().match(/data-pg="creply"/g) || []).length, 5, 'tombol Balas di SETIAP komentar (milik sendiri juga)'); assert.strictEqual(boxes(t), 0, 'tertutup: tanpa kotak balas');
    click(t, 'creply', P1, cid(2)); const H = t.H();
    assert.strictEqual(boxes(t), 1, 'satu kotak balas'); assert(H.includes('placeholder="Balas nama-11..."') && H.includes('data-cid="' + cid(2) + '"') && H.includes('aria-expanded="true"'), 'kotak untuk komentar yang diklik');
    assert(H.indexOf('data-pg="rtxt"') > H.indexOf('data-cid="' + cid(2) + '"') && H.indexOf('data-pg="rtxt"') < H.indexOf('data-cid="' + cid(3) + '"'), 'kotak tepat di bawah komentar yang dibalas (sebelum balasannya)');
    assert(/class="pgccomp pgcrcomp pgcd2"/.test(H), 'kotak menjorok satu tingkat di bawah induk'); assert(H.includes('data-pg="rsend"') && H.includes('data-pg="rcancel"'));
    assert.strictEqual(t.run('pgF').cmWant, null, 'niat fokus dipakai lalu dibersihkan oleh renderFeed');
    // pindah ke komentar lain: kotak berpindah (tetap satu), draf induk lama dipertahankan
    type(t, P1, cid(2), 'draf untuk c2'); click(t, 'creply', P1, cid(4)); assert.strictEqual(boxes(t), 1); assert(t.H().includes('placeholder="Balas nama-aa..."'));
    click(t, 'creply', P1, cid(2)); assert(t.H().includes('>draf untuk c2</textarea>'), 'draf per induk kembali saat kotak dibuka lagi');
    // klik tombol yang sama = tutup; Batal = tutup
    click(t, 'creply', P1, cid(2)); assert.strictEqual(boxes(t), 0, 'klik lagi menutup'); click(t, 'creply', P1, cid(3)); assert.strictEqual(boxes(t), 1); click(t, 'rcancel', P1); assert.strictEqual(boxes(t), 0, 'Batal menutup');
    assert.strictEqual(t.cc('pgComment').length, 0, 'membuka / menutup tidak menyentuh IPC');
    // kotak komentar tingkat atas tetap ada dan terpisah
    assert(t.H().includes('data-pg="ctxt"'), 'kotak komentar baru (tingkat atas) tetap ada');
    ok('tombol Balas di tiap komentar; kotak balas tepat di bawah komentarnya, menjorok, hanya satu; draf per induk; klik lagi / Batal menutup; tanpa IPC');
  }
  // D. kirim
  {
    const t = boot(); await openOther(t, [post(1)], TREE()); const n0 = t.run('pgF').cm[P1].count;
    click(t, 'creply', P1, cid(3)); type(t, P1, cid(3), 'ini balasannya');
    let g; t.st.send = () => new Promise((r) => { g = r; }); click(t, 'rsend', P1); await sleep(5);
    assert.deepStrictEqual(t.cc('pgComment'), [['pgComment', PEER, P1, 'ini balasannya', cid(3)]], 'pgComment(peer, post, teks, idInduk)'); assert(t.H().includes('Mengirim…') && /data-pg="rsend"[^>]*disabled/.test(t.H()), 'tombol dikunci selagi mengirim');
    click(t, 'rsend', P1); await sleep(5); assert.strictEqual(t.cc('pgComment').length, 1, 'klik ganda: satu permintaan');
    const mine = { id: 'd' + '0'.repeat(14) + '1', by: ME, ts: 1700000900000, text: 'ini balasannya', re: cid(3) };
    g({ ok: true, comment: { st: 'added', c: mine } }); await sleep(10);
    assert.deepStrictEqual(order(t), [1, 2, 3, mine.id, 4, 5].map((x) => (typeof x === 'string' ? x : cid(x))), 'balasan baru tepat di bawah induknya (sebelum c4), bukan di ujung daftar');
    assert.strictEqual(cls(t, mine.id), 'pgc pgcd3 pgcre', 'tiga tingkat'); assert.strictEqual(boxes(t), 0, 'kotak tertutup'); assert.strictEqual(t.run('pgF').cm[P1].count, n0 + 1, 'hitungan naik satu'); assert.strictEqual(t.run('pgF').cm[P1].rd[cid(3)], undefined, 'draf dibersihkan');
    // kirim ulang yang sama persis ("same") tidak menaikkan hitungan; komentar tingkat atas tetap 3 argumen
    t.st.send = { ok: true, comment: { st: 'added', c: { id: 'd' + '0'.repeat(14) + '2', by: ME, ts: 1700000950000, text: 'atas' } } }; t.run('pgF').cm[P1].draft = 'atas'; click(t, 'csend', P1); await sleep(10);
    assert.deepStrictEqual(t.cc('pgComment')[1], ['pgComment', PEER, P1, 'atas'], 'komentar tingkat atas: tanpa argumen re (panggilan lama persis)');
    // yang diketik selama menunggu tidak dihapus
    const u = boot(); await openOther(u, [post(1)], TREE()); click(u, 'creply', P1, cid(1)); type(u, P1, cid(1), 'awal'); let g2; u.st.send = () => new Promise((r) => { g2 = r; }); click(u, 'rsend', P1); await sleep(5);
    u.run('pgF').cm[P1].rd[cid(1)] = 'awal plus'; g2({ ok: true, comment: { st: 'added', c: { id: 'e' + '0'.repeat(15), by: ME, ts: 1700000990000, text: 'awal', re: cid(1) } } }); await sleep(10);
    assert.strictEqual(u.run('pgF').cm[P1].rd[cid(1)], 'awal plus', 'ketikan baru dipertahankan'); assert.strictEqual(boxes(u), 1, 'kotak tetap terbuka bila draf berubah');
    ok('kirim: pgComment(peer, post, teks, idInduk), tombol terkunci, klik ganda satu permintaan, balasan masuk tepat di bawah induknya, hitungan naik, draf bersih; komentar atas tanpa re; ketikan baru dipertahankan');
  }
  // E. galat
  {
    const t = boot(); await openOther(t, [post(1)], TREE()); click(t, 'creply', P1, cid(1));
    click(t, 'rsend', P1); await sleep(5); assert(t.H().includes('Tulis balasannya dulu.') && t.cc('pgComment').length === 0, 'kosong: pesan, tanpa IPC');
    type(t, P1, cid(1), 'x'.repeat(1001)); click(t, 'rsend', P1); await sleep(5); assert(t.H().includes('tidak lebih dari 1000') && t.cc('pgComment').length === 0, 'terlalu panjang: tanpa IPC');
    type(t, P1, cid(1), 'balas'); t.st.send = { ok: false, code: 'offline', err: 'x' }; click(t, 'rsend', P1); await sleep(10);
    assert(t.H().includes('Pemilik sedang offline'), 'galat jaringan tampil'); assert(t.H().includes('>balas</textarea>') && boxes(t) === 1, 'draf utuh, kotak tetap terbuka'); assert.strictEqual(order(t).length, 5, 'daftar tak berubah');
    t.st.send = { ok: false, code: 'old', err: 'Aplikasi pemilik belum mendukung balasan komentar.' }; click(t, 'rsend', P1); await sleep(10);
    assert(t.H().includes('belum mendukung balasan komentar') && !t.H().includes('belum mendukung komentar.'), "old: pesan Core (balasan), bukan pesan komentar biasa");
    t.st.send = { ok: true, comment: null }; click(t, 'rsend', P1); await sleep(10); assert(t.H().includes('Postingan ini sudah tidak tersedia.'));
    t.st.send = { ok: false, code: 'noparent', err: 'x' }; const n0 = t.run('pgF').cm[P1].count; click(t, 'rsend', P1); await sleep(10);
    assert(!order(t).includes(cid(1)) && boxes(t) === 0, 'noparent: komentar yang dibalas dibuang dari layar dan kotak tertutup'); assert(t.toasts.some((x) => /sudah tidak ada/.test(x)), 'toast'); assert.strictEqual(t.run('pgF').cm[P1].count, n0 - 1);
    assert(t.H().includes('↳ membalas komentar yang tidak tersedia'), 'anak-anaknya menjadi yatim berketerangan');
    ok('galat: kosong / terlalu panjang tanpa IPC; gagal = draf utuh + pesan; old memakai pesan Core; noparent membuang induk + toast; yatim berketerangan');
  }
  // F. klik dipalsukan
  {
    const t = boot(); await openOther(t, [post(1)], TREE());
    for (const [id, c] of [[P1, undefined], [P1, 'zz'], [P1, 'c' + '9'.repeat(15)], ['xyz', cid(1)], [P2, cid(1)], [undefined, cid(1)]]) { click(t, 'creply', id, c); await sleep(3); }
    assert.strictEqual(boxes(t), 0, 'id cacat / tak dikenal: tanpa kotak'); click(t, 'rsend', P1); click(t, 'rsend', P2); click(t, 'rcancel', P2); await sleep(5); assert.strictEqual(t.cc('pgComment').length, 0, 'rsend tanpa kotak terbuka: tanpa IPC');
    const g = boot(); await openOther(g, [post(1)], TREE()); g.run('pgF').cm[P1].gone = true; click(g, 'creply', P1, cid(1)); assert.strictEqual(boxes(g), 0, 'komentar tak tersedia: tanpa balas');
    ok('klik dipalsukan (id cacat, komentar tak dikenal, tanpa kotak, komentar tak tersedia) tak berefek');
  }
  // G. induk dihapus
  {
    const t = boot(); await openOther(t, [post(1)], TREE()); click(t, 'creply', P1, cid(2)); type(t, P1, cid(2), 'draf');
    click(t, 'cmydel', P1, cid(2)); await sleep(15); // c2 milik ME
    assert.deepStrictEqual(order(t), [1, 4, 3, 5].map(cid), 'induk dihapus: balasannya tetap (tanpa kaskade); c4 tetap di bawah c1, c3 yang kehilangan induk pindah ke tingkat atas'); assert.strictEqual(boxes(t), 0, 'kotak balas untuk komentar yang dihapus tertutup'); assert.strictEqual(t.run('pgF').cm[P1].rd[cid(2)], undefined, 'drafnya dibuang');
    assert.strictEqual(cls(t, cid(3)), 'pgc pgcre', 'anak c2 jadi yatim tingkat atas'); assert(t.H().includes('↳ membalas komentar yang tidak tersedia'));
    ok('komentar yang dihapus: balasannya tetap (yatim), kotak balas + draf-nya dibuang');
  }
  // H. Ctrl+Enter
  {
    const t = boot(); await openOther(t, [post(1)], TREE()); click(t, 'creply', P1, cid(1)); type(t, P1, cid(1), 'lewat keyboard'); let pd = 0;
    t.els.pgmodal.h.keydown({ ctrlKey: true, key: 'Enter', target: { id: '', dataset: { pg: 'rtxt', id: P1, cid: cid(1) } }, preventDefault() { pd++; } }); await sleep(5);
    assert.strictEqual(pd, 1); assert.deepStrictEqual(t.cc('pgComment'), [['pgComment', PEER, P1, 'lewat keyboard', cid(1)]], 'Ctrl+Enter mengirim balasan');
    ok('Ctrl+Enter di kotak balasan mengirim balasan');
  }
  // I. Halamanku
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2, { re: cid(1), by: ME })]);
    assert.strictEqual((t.H().match(/data-pg="creply"/g) || []).length, 2, 'pemilik: Balas di setiap komentar'); assert(t.H().includes('data-pg="cdel"'), 'tombol Hapus pemilik tetap ada');
    click(t, 'creply', P1, cid(1)); type(t, P1, cid(1), 'dari pemilik'); t.st.send = { ok: true, comment: { st: 'added', c: { id: 'f' + '0'.repeat(15), by: ME, ts: 1700000999000, text: 'dari pemilik', re: cid(1) } } }; click(t, 'rsend', P1); await sleep(10);
    assert.deepStrictEqual(t.cc('pgComment'), [['pgComment', ME, P1, 'dari pemilik', cid(1)]], 'di Halamanku pgId = id sendiri (lokal)'); assert.deepStrictEqual(order(t), [cid(1), cid(2), 'f' + '0'.repeat(15)].sort(), 'tiga komentar tampil'); assert.strictEqual(/class="(pgc[^"]*)" data-cid="f0+"/.exec(t.H())[1], 'pgc pgcd1 pgcre', 'balasan pemilik menjorok di bawah komentar yang dibalas');
    ok('Halamanku: pemilik juga bisa membalas (lokal), tombol Hapus pemilik tidak terganggu');
  }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
