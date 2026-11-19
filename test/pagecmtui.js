'use strict';
// Tes 4b-4: UI komentar Halaman (renderer/js/archne-pages-cmt.js + kait di archne-pages.js). Keenam berkas Halaman dimuat BERSAMA di satu vm dengan DOM tiruan (seperti pagerxui.js).
// Kelompok: A statis, B tampilan + buka (memuat), C paging + hitungan, D kirim, E kegagalan kirim (draf utuh), F validasi sebelum IPC, G kegagalan muat / null, H jawaban basi,
// I Halamanku (lokal), J draf lintas gambar ulang + fokus + Ctrl+Enter, K satu permintaan per postingan, L sisip berurutan tanpa ganda, M masukan cacat dari IPC.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = '1'.repeat(16), PEER = 'a'.repeat(16), P1 = '0000000000000001', P2 = '0000000000000002';
const post = (n, o) => Object.assign({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public' }, o || {});
const cmt = (n, o) => Object.assign({ id: 'c' + n.toString(16).padStart(15, '0'), by: PEER, ts: 1700000100000 + n * 1000, text: 'k' + n }, o || {});

function boot() {
  const els = {}, calls = [], toasts = [];
  const st = { list: null, mine: null, cms: null, cmt: null };
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener(t, f) { this.h[t] = f; }, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
  const val = (r, ...a) => (typeof r === 'function' ? r(...a) : r);
  const api = {
    pgList: async (...a) => { calls.push(['pgList', ...a]); return st.list; },
    pgMine: async (...a) => { calls.push(['pgMine', ...a]); return st.mine; },
    pgComments: async (...a) => { calls.push(['pgComments', ...a]); return val(st.cms, ...a); },
    pgComment: async (...a) => { calls.push(['pgComment', ...a]); return val(st.cmt, ...a); },
    onPgDl: () => {},
  };
  const E = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const doc = { addEventListener() {}, activeElement: null };
  const ctx = { S: { me: { id: ME }, messages: [] }, esc: E, nameOf: (i) => 'nama-' + String(i).slice(0, 2), $: el, linkHtml: E, fmt: String, dayLabel: () => 'Hari ini', hm: () => '10:00', toast: (t) => toasts.push(t), ask: async () => true,
    renderProfile() {}, document: doc, Date, Promise, setTimeout, Set, window: { api, history: { pushState() {}, back() {} }, location: { protocol: 'file:', pathname: '/archne-index.html' } }, profId: PEER };
  vm.createContext(ctx);
  vm.runInContext(rd('renderer/archne-filecard.js'), ctx);
  vm.runInContext(require('./_src').pagesJs(), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  return { els, calls, toasts, st, run, ctx, doc, H: () => els.pglist.innerHTML, cc: (n) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] === n))) }; // JSON: objek dari vm beda prototipe
}
async function openFeed(t, posts, id) { t.st.list = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.run(`pgOpen('${id || PEER}')`); await sleep(10); }
const click = (t, pg, id) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg, id } }) } });
const type = (t, id, value) => t.els.pgmodal.h.input({ target: { dataset: { pg: 'ctxt', id }, value, parentNode: null } });
const cm = (t, id) => JSON.parse(t.run(`(() => { const c = pgF.cm['${id}']; return JSON.stringify(c && Object.assign({}, c, { ids: [...c.ids] })); })()`));
const page = (items, o) => ({ ok: true, comments: Object.assign({ items, next: null, count: items.length, skipped: 0 }, o || {}) });
const sentOk = (c, st) => ({ ok: true, comment: { st: st || 'added', c } });

(async () => {
  // A. statis
  {
    const css = rd('renderer/css/archne-pages.css'), src = rd('renderer/js/archne-pages.js'), c = rd('renderer/js/archne-pages-cmt.js'), html = rd('renderer/archne-index.html');
    for (const k of ['.pgcm', '.pgcbtn', '.pgcbtn:focus-visible', '.pgcbtn svg', '.pgcn', '.pgatt', '.pgbadge', '.pgcl', '.pgc', '.pgcmeta', '.pgcme', '.pgctext', '.pgccomp', '.pgccomp textarea']) assert(css.includes('#pgmodal ' + k), 'CSS ' + k);
    assert(src.includes('${pgRxHtml(p)}${pgCmtHtml(p)}'), 'kait: komentar di bawah baris reaksi');
    for (const k of ["a === 'cmt' && id", "a === 'cmore' && id", "a === 'csend' && id", 'pgCmtFocusGet()', 'pgCmtFocusPut(', 'cm: {}', 'delete f.cm[id]']) assert(src.includes(k), 'kait di archne-pages.js: ' + k);
    assert(html.indexOf('js/archne-pages-react.js') < html.indexOf('js/archne-pages-cmt.js') && html.indexOf('js/archne-pages-cmt.js') < html.indexOf('js/archne-voice-channel.js'), 'urutan skrip');
    assert(/CMT_TEXT_MAX di src\/archne-pagecmt\.js/.test(c), 'asal PG_CMT_MAX tercatat');
    assert.strictEqual(boot().run('PG_CMT_MAX'), require('../src/archne-pagecmt').CMT_TEXT_MAX, 'PG_CMT_MAX = CMT_TEXT_MAX (renderer tidak bisa require; tes ini yang menjaganya)');
    assert(!/window\.api\.\w+/.test(c.replace(/window\.api\.(pgComments|pgComment|pgCmtRemove|pgCmtDelete|pgCmtReact)\b/g, '')), 'hanya memakai pgComments / pgComment / pgCmtRemove (5c-2) / pgCmtDelete (5e) / pgCmtReact (5g)');
    const pre = rd('preload.js'), http = rd('renderer/archne-api-http.js'); for (const n of ['pgComment', 'pgComments']) assert(pre.includes(n + ':') && http.includes("'" + n + "'"), n + ' terdaftar di preload dan api-http');
    ok('statis: CSS, kait di archne-pages.js, urutan skrip, PG_CMT_MAX = CMT_TEXT_MAX, hanya dua kanal IPC komentar');
  }
  // B. tampilan tertutup, buka = memuat, escape
  {
    const t = boot(); await openFeed(t, [post(1), post(2)]);
    assert.strictEqual((t.H().match(/data-pg="cmt"/g) || []).length, 2, 'tiap postingan punya tombol Komentar'); assert(/aria-expanded="false"[^>]*aria-label="Komentar">/.test(t.H()) && !t.H().includes('pgcn'), 'tertutup, tanpa hitungan (ikon saja)');
    assert(!t.H().includes('pgcl') && !t.H().includes('data-pg="ctxt"') && t.cc('pgComments').length === 0, 'tertutup: tanpa daftar, tanpa kotak, tanpa IPC');
    let gate; t.st.cms = new Promise((r) => { gate = r; }); click(t, 'cmt', P1);
    assert.deepStrictEqual(t.cc('pgComments'), [['pgComments', PEER, P1, { limit: 10 }]], 'buka = pgComments(peer, post, { limit })'); assert(t.H().includes('Memuat komentar…') && t.H().includes('aria-expanded="true"'), 'memuat');
    assert(t.H().includes('data-pg="ctxt"') && t.H().includes('maxlength="1000"'), 'kotak tulis ada dengan batas 1000');
    gate(page([cmt(1, { text: '<b>x</b>\nbaris dua' }), cmt(2, { by: ME, text: 'dariku' })])); await sleep(5);
    const H = t.H(); assert(H.includes('&lt;b&gt;x&lt;/b&gt;') && !H.includes('<b>x</b>'), 'teks komentar di-escape'); assert(H.includes('nama-aa') && H.includes('<span class="pgcme">kamu</span>'), 'nama penulis; komentarku ditandai');
    assert.strictEqual((H.match(/class="pgc"/g) || []).length, 2); assert(/aria-expanded="true"[^>]*aria-label="Komentar \(2\)"/.test(H) && H.includes('<span class="pgcn">2</span>'), 'hitungan dari Core'); assert(!H.includes('Muat komentar lagi') && !H.includes('Belum ada komentar'));
    click(t, 'cmt', P1); assert(!t.H().includes('class="pgc"') && !t.H().includes('data-pg="ctxt"'), 'tutup menyembunyikan'); click(t, 'cmt', P1); assert.strictEqual(t.cc('pgComments').length, 1, 'buka lagi: tanpa memuat ulang'); assert(t.H().includes('class="pgc"'), 'isi tetap');
    { const n = boot(); await openFeed(n, [post(1)]); n.st.cms = page([cmt(1, { by: '<img>' })]); click(n, 'cmt', P1); await sleep(5); assert(n.H().includes('nama-&lt;i') && !n.H().includes('<img'), 'nama penulis di-escape'); }
    const e = boot(); await openFeed(e, [post(1)]); e.st.cms = page([]); click(e, 'cmt', P1); await sleep(5); assert(e.H().includes('Belum ada komentar.') && /Komentar \(0\)/.test(e.H()), 'kosong: pesan + (0)');
    ok('tampilan: tombol tiap postingan, tertutup tanpa IPC, buka memuat pgComments(peer, post, { limit: 10 }), escape, penanda milikku, hitungan, kosong, tutup / buka tanpa muat ulang');
  }
  // C. paging
  {
    const t = boot(); await openFeed(t, [post(1)]); const c = (n) => cmt(n);
    t.st.cms = page([c(1), c(2)], { next: '1700000102000:' + c(2).id, count: 5 }); click(t, 'cmt', P1); await sleep(5);
    assert(t.H().includes('Muat komentar lagi') && /Komentar \(5\)/.test(t.H()), 'masih ada sisa: tombol + total dari Core');
    t.st.cms = page([c(3), c(4)], { next: '1700000104000:' + c(4).id, count: 5, skipped: 1 }); click(t, 'cmore', P1); await sleep(5);
    assert.deepStrictEqual(t.cc('pgComments')[1], ['pgComments', PEER, P1, { limit: 10, after: '1700000102000:' + c(2).id }], 'halaman berikutnya memakai kursor'); assert.deepStrictEqual(cm(t, P1).items.map((x) => x.text), ['k1', 'k2', 'k3', 'k4']);
    t.st.cms = page([c(5)], { count: 5, skipped: 2 }); click(t, 'cmore', P1); await sleep(5);
    assert.deepStrictEqual(cm(t, P1).items.map((x) => x.text), ['k1', 'k2', 'k3', 'k4', 'k5']); assert(!t.H().includes('Muat komentar lagi') && t.H().includes('3 komentar dibuang karena tidak sah.'), 'habis: tombol hilang; yang dibuang dari semua halaman dijumlahkan');
    ok('paging: kursor diteruskan, hasil digabung berurutan, total dari Core, tombol hilang di akhir, komentar yang dibuang Core dilaporkan');
  }
  // D. kirim
  {
    const t = boot(); await openFeed(t, [post(1)]); t.st.cms = page([cmt(1), cmt(3)]); click(t, 'cmt', P1); await sleep(5);
    type(t, P1, 'halo dunia'); assert.strictEqual(cm(t, P1).draft, 'halo dunia'); let gate; t.st.cmt = new Promise((r) => { gate = r; }); click(t, 'csend', P1);
    assert.deepStrictEqual(t.cc('pgComment'), [['pgComment', PEER, P1, 'halo dunia']], 'kirim teks mentah lewat pgComment(peer, post, text)'); assert(/data-pg="ctxt"[^>]*disabled/.test(t.H()) && /data-pg="csend"[^>]*disabled/.test(t.H()) && t.H().includes('Mengirim…'), 'terkunci selagi menunggu');
    gate(sentOk(cmt(2, { by: ME, text: 'halo dunia' }))); await sleep(5);
    assert.deepStrictEqual(cm(t, P1).items.map((x) => x.text), ['k1', 'halo dunia', 'k3'], 'disisipkan di tempatnya (ts, id), bukan di ujung'); assert.strictEqual(cm(t, P1).count, 3, 'hitungan naik'); assert.strictEqual(cm(t, P1).draft, ''); assert(!/disabled/.test(t.H().split('data-pg="ctxt"')[1].split('</textarea>')[0]));
    // 'same': sudah ada -> tidak ganda, hitungan tetap
    type(t, P1, 'halo dunia'); t.st.cmt = sentOk(cmt(2, { by: ME, text: 'halo dunia' }), 'same'); click(t, 'csend', P1); await sleep(5);
    assert.strictEqual(cm(t, P1).items.length, 3, 'tanpa ganda'); assert.strictEqual(cm(t, P1).count, 3, "'same' tidak menambah hitungan");
    // diketik selama menunggu: draf baru tidak dihapus
    type(t, P1, 'satu'); let g2; t.st.cmt = new Promise((r) => { g2 = r; }); click(t, 'csend', P1); type(t, P1, 'satu dua'); g2(sentOk(cmt(9, { by: ME, text: 'satu' }))); await sleep(5);
    assert.strictEqual(cm(t, P1).draft, 'satu dua', 'ketikan selama menunggu tidak hilang'); assert.strictEqual(cm(t, P1).count, 4);
    {
      // 'same' untuk komentar yang belum termuat (halaman berikutnya): masuk daftar, tapi sudah terhitung di Core -> hitungan tetap
      const u = boot(); await openFeed(u, [post(1)]); u.st.cms = page([cmt(1)], { next: 'x', count: 8 }); u.st.cms = page([cmt(1)], { next: '1700000101000:' + cmt(1).id, count: 8 }); click(u, 'cmt', P1); await sleep(5);
      type(u, P1, 'lagi'); u.st.cmt = sentOk(cmt(7, { by: ME }), 'same'); click(u, 'csend', P1); await sleep(5); assert.strictEqual(cm(u, P1).items.length, 2, "'same' tetap disisipkan"); assert.strictEqual(cm(u, P1).count, 8, "'same' tidak menambah hitungan walau belum termuat");
      // 'added' tapi komentarnya sudah ada di daftar (mis. ikut termuat bersamaan): tidak dihitung dua kali
      type(u, P1, 'dua'); u.st.cmt = sentOk(cmt(1), 'added'); click(u, 'csend', P1); await sleep(5); assert.strictEqual(cm(u, P1).count, 8, "'added' yang sudah ada di daftar tidak menambah hitungan");
      // muat gagal -> hitungan tak diketahui: kirim sukses tidak mengarang hitungan
      const v = boot(); await openFeed(v, [post(1)]); v.st.cms = { ok: false, code: 'offline', err: 'x' }; click(v, 'cmt', P1); await sleep(5);
      type(v, P1, 'tetap bisa'); v.st.cmt = sentOk(cmt(1, { by: ME })); click(v, 'csend', P1); await sleep(5); assert.strictEqual(cm(v, P1).count, null, 'hitungan tetap tak diketahui'); assert(/aria-label="Komentar">/.test(v.H()) && v.H().includes('class="pgc"'), 'tombol tanpa angka, komentar tampil');
    }
    ok("kirim: teks mentah ke pgComment, terkunci selagi menunggu, disisipkan berurutan, hitungan naik, 'same' tanpa ganda / tanpa hitungan, ketikan selama menunggu aman");
  }
  // E. kegagalan kirim: draf utuh + pesan
  {
    for (const [label, reply, msg] of [
      ['full', { ok: false, code: 'full', err: 'x' }, (t) => t.run('PG_CMT_ERR.full')],
      ['old', { ok: false, code: 'old', err: 'x' }, () => 'Aplikasi pemilik belum mendukung komentar.'],
      ['offline', { ok: false, code: 'offline', err: 'x' }, (t) => t.run('PG_ERR.offline')],
      ['busy', { ok: false, code: 'busy', err: 'x' }, (t) => t.run('PG_ERR.busy')],
      ['bad', { ok: false, code: 'bad', err: 'x' }, (t) => t.run('PG_CMT_ERR.bad')],
      ['kode asing', { ok: false, code: 'ZZ', err: 'pesan sendiri' }, () => 'pesan sendiri'],
      ['null', { ok: true, comment: null }, () => 'Postingan ini sudah tidak tersedia.'],
      ['melempar', () => { throw new Error('putus'); }, (t) => t.run('PG_ERR.proto')],
    ]) {
      const t = boot(); await openFeed(t, [post(1)]); t.st.cms = page([cmt(1)]); click(t, 'cmt', P1); await sleep(5);
      type(t, P1, 'draf saya'); t.st.cmt = reply; click(t, 'csend', P1); await sleep(5);
      const c = cm(t, P1); assert.strictEqual(c.draft, 'draf saya', label + ': draf utuh'); assert.strictEqual(c.sending, false, label + ': terbuka lagi'); assert.strictEqual(c.items.length, 1, label + ': daftar tak berubah'); assert.strictEqual(c.count, 1);
      assert.strictEqual(c.cerr, msg(t), label + ': pesan'); assert(t.H().includes('draf saya') && t.H().includes(msg(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')), label + ': draf dan pesan tampil'); assert.strictEqual(t.toasts.length, 0, label + ': pesan di bawah kotak, bukan toast');
      type(t, P1, 'draf saya!'); assert.strictEqual(cm(t, P1).cerr, '', label + ': mengetik menghapus pesan lama');
    }
    { const t = boot(); await openFeed(t, [post(1)]); t.st.cms = page([]); click(t, 'cmt', P1); await sleep(5); type(t, P1, 'a'); t.st.cmt = { ok: false, code: 'ZZ', err: '<i>nakal</i>' }; click(t, 'csend', P1); await sleep(5); assert(t.H().includes('&lt;i&gt;nakal&lt;/i&gt;') && !t.H().includes('<i>nakal</i>'), 'pesan galat di-escape'); }
    ok('kegagalan kirim (full, old, offline, busy, bad, kode asing, null, melempar): draf utuh, daftar dan hitungan tak berubah, pesan tepat di bawah kotak, mengetik menghapus pesan');
  }
  // F. validasi sebelum IPC
  {
    const t = boot(); await openFeed(t, [post(1)]); t.st.cms = page([]); click(t, 'cmt', P1); await sleep(5);
    click(t, 'csend', P1); assert.strictEqual(cm(t, P1).cerr, 'Tulis komentarnya dulu.'); type(t, P1, ' \n\t '); click(t, 'csend', P1); assert.strictEqual(cm(t, P1).cerr, 'Tulis komentarnya dulu.', 'hanya spasi = kosong');
    type(t, P1, 'x'.repeat(1001)); click(t, 'csend', P1); assert.strictEqual(cm(t, P1).cerr, t.run('PG_CMT_ERR.bad')); assert.strictEqual(t.cc('pgComment').length, 0, 'tidak satu pun sampai ke IPC');
    type(t, P1, 'x'.repeat(1000)); t.st.cmt = sentOk(cmt(1, { text: 'x'.repeat(1000) })); click(t, 'csend', P1); await sleep(5); assert.strictEqual(t.cc('pgComment').length, 1, '1000 persis lolos');
    ok('validasi: kosong / spasi saja / 1001 karakter ditolak sebelum IPC dengan pesan; 1000 persis lolos');
  }
  // G. kegagalan muat, null
  {
    const t = boot(); await openFeed(t, [post(1), post(2)]); t.st.cms = { ok: false, code: 'offline', err: 'x' }; click(t, 'cmt', P1); await sleep(5);
    assert(t.H().includes(t.run('PG_ERR.offline')) && t.H().includes('data-pg="cmore"'), 'offline: pesan + Coba lagi'); assert.strictEqual(cm(t, P1).loaded, false);
    t.st.cms = page([cmt(1)]); click(t, 'cmore', P1); await sleep(5); assert(!t.H().includes('data-pg="cmore"') && t.H().includes('class="pgc"'), 'coba lagi berhasil');
    t.st.cms = { ok: false, code: 'old', err: 'x' }; click(t, 'cmt', P2); await sleep(5); assert(t.H().includes('Aplikasi pemilik belum mendukung komentar.') && !/data-pg="cmore"[^>]*data-id="0000000000000002"/.test(t.H()), 'old: pesan khusus komentar, tanpa Coba lagi');
    const n = boot(); await openFeed(n, [post(1)]); n.st.cms = { ok: true, comments: null }; click(n, 'cmt', P1); await sleep(5);
    assert(n.H().includes('Komentar postingan ini tidak tersedia.') && !n.H().includes('data-pg="ctxt"'), 'null: pesan, tanpa kotak tulis'); assert.strictEqual(n.cc('pgComments').length, 1); click(n, 'cmt', P1); click(n, 'cmt', P1); assert.strictEqual(n.cc('pgComments').length, 1, 'null tidak dimuat ulang tiap dibuka');
    const x = boot(); await openFeed(x, [post(1)]); x.st.cms = () => { throw new Error('putus'); }; click(x, 'cmt', P1); await sleep(5); assert(x.H().includes(x.run('PG_ERR.proto')), 'melempar = proto');
    ok('muat gagal: pesan + Coba lagi (berhasil di percobaan kedua), old tanpa Coba lagi, null = tidak tersedia tanpa kotak dan tanpa muat ulang, melempar = proto');
  }
  // H. jawaban basi
  {
    const t = boot(); await openFeed(t, [post(1)]); let g; t.st.cms = new Promise((r) => { g = r; }); click(t, 'cmt', P1); t.run('pgClose()'); const before = t.H(); g(page([cmt(1)])); await sleep(5); assert.strictEqual(t.H(), before, 'muat basi dibuang'); assert.strictEqual(t.run('pgF'), null);
    { const w = boot(); await openFeed(w, [post(1)]); w.run('var __n = 0; const __o = renderFeed; renderFeed = function () { __n++; return __o(); };'); let g1; w.st.cms = new Promise((r) => { g1 = r; }); click(w, 'cmt', P1); const n0 = w.run('__n'); await openFeed(w, [post(1)]); const n1 = w.run('__n'); g1(page([cmt(1)])); await sleep(5); assert.strictEqual(w.run('__n'), n1, 'muat basi tidak menggambar ulang layar baru'); void n0; }
    { const w = boot(); await openFeed(w, [post(1)]); w.st.cms = page([]); click(w, 'cmt', P1); await sleep(5); type(w, P1, 'x'); w.run('var __n = 0; const __o = renderFeed; renderFeed = function () { __n++; return __o(); };'); let g1; w.st.cmt = new Promise((r) => { g1 = r; }); click(w, 'csend', P1); await openFeed(w, [post(1)]); const n1 = w.run('__n'); g1(sentOk(cmt(1))); await sleep(5); assert.strictEqual(w.run('__n'), n1, 'kirim basi tidak menggambar ulang layar baru'); }
    const u = boot(); await openFeed(u, [post(1)]); u.st.cms = page([]); click(u, 'cmt', P1); await sleep(5); type(u, P1, 'x'); let g2; u.st.cmt = new Promise((r) => { g2 = r; }); click(u, 'csend', P1);
    await openFeed(u, [post(1)]); g2(sentOk(cmt(1))); await sleep(5); assert.strictEqual(u.run('Object.keys(pgF.cm).length'), 0, 'layar baru: keadaan komentar baru dan tak tersentuh jawaban lama'); assert(!u.H().includes('class="pgc"'));
    ok('jawaban basi (layar ditutup / dibuka ulang selagi menunggu) dibuang; keadaan layar baru bersih');
  }
  // I. Halamanku
  {
    const t = boot(); t.st.mine = { ok: true, items: [post(1)], next: null, count: 1, skipped: 0 }; t.run(`pgOpen('${ME}')`); await sleep(10);
    t.st.cms = page([cmt(1, { by: PEER })]); click(t, 'cmt', P1); await sleep(5); assert.deepStrictEqual(t.cc('pgComments')[0], ['pgComments', ME, P1, { limit: 10 }], 'Halamanku: peer = id sendiri (lokal)');
    type(t, P1, 'balasan pemilik'); t.st.cmt = sentOk(cmt(2, { by: ME, text: 'balasan pemilik' })); click(t, 'csend', P1); await sleep(5); assert.deepStrictEqual(t.cc('pgComment')[0], ['pgComment', ME, P1, 'balasan pemilik']); assert(t.H().includes('<span class="pgcme">kamu</span>'));
    ok('Halamanku: komentar dimuat dan dikirim dengan peer = id sendiri; komentar pemilik ditandai');
  }
  // J. draf lintas gambar ulang, fokus, Ctrl+Enter
  {
    const t = boot(); await openFeed(t, [post(1), post(2)]); t.st.cms = page([]); click(t, 'cmt', P1); await sleep(5); type(t, P1, 'draf <panjang>');
    t.run('renderFeed()'); assert(t.H().includes('draf &lt;panjang&gt;'), 'draf tampil lagi sesudah digambar ulang (di-escape)'); click(t, 'cmt', P2); await sleep(5); assert(t.H().includes('draf &lt;panjang&gt;'), 'membuka postingan lain tidak menghapus draf');
    click(t, 'cmt', P1); click(t, 'cmt', P1); assert(t.H().includes('draf &lt;panjang&gt;'), 'tutup lalu buka: draf tetap');
    // fokus: elemen aktif = kotak komentar P1 -> dipulihkan di elemen baru
    const spy = { focused: 0, sel: null, disabled: false, focus() { this.focused++; }, setSelectionRange(a, b) { this.sel = [a, b]; } };
    t.els.pglist.querySelector = (q) => (q === `[data-pg="ctxt"][data-id="${P1}"]` ? spy : null); t.doc.activeElement = { dataset: { pg: 'ctxt', id: P1 }, selectionStart: 3, selectionEnd: 5 };
    t.run('renderFeed()'); assert.strictEqual(spy.focused, 1); assert.deepStrictEqual(spy.sel, [3, 5], 'fokus dan seleksi dipulihkan');
    t.doc.activeElement = { dataset: { pg: 'ctxt', id: 'bukan-hex' } }; t.run('renderFeed()'); assert.strictEqual(spy.focused, 1, 'id cacat tidak dipakai di selektor');
    t.doc.activeElement = null; t.run('renderFeed()'); assert.strictEqual(spy.focused, 1, 'tanpa fokus di kotak komentar: tidak mencuri fokus');
    // sesudah kirim sukses fokus kembali ke kotak walau tak ada elemen aktif (kotak sempat disabled)
    { const f2 = { focused: 0, disabled: false, focus() { this.focused++; } }; t.els.pglist.querySelector = () => f2; t.doc.activeElement = null; type(t, P1, 'fokus'); t.st.cmt = sentOk(cmt(4)); click(t, 'csend', P1); await sleep(5); assert.strictEqual(f2.focused, 1, 'fokus kembali sesudah kirim');
      const f3 = { focused: 0, disabled: true, focus() { this.focused++; } }; t.els.pglist.querySelector = () => f3; t.doc.activeElement = { dataset: { pg: 'ctxt', id: P1 } }; t.run('renderFeed()'); assert.strictEqual(f3.focused, 0, 'kotak disabled tidak difokuskan'); t.els.pglist.querySelector = () => null; t.doc.activeElement = null; }
    // input dari elemen lain tidak menyentuh draf; id seperti 'constructor' tidak menyentuh prototipe
    type(t, P1, 'asli'); t.els.pgmodal.h.input({ target: { dataset: { pg: 'lain', id: P1 }, value: 'rusak' } }); assert.strictEqual(cm(t, P1).draft, 'asli', 'hanya kotak komentar yang mengubah draf');
    type(t, 'constructor', 'x'); type(t, '__proto__', 'x'); t.run("pgCmtSend('constructor'); pgCmtLoad('constructor'); pgCmtToggle('constructor')"); await sleep(5); assert.strictEqual(t.run('Object.draft === undefined && Object.busy === undefined && Object.open === undefined && Object.prototype.draft === undefined'), true, 'tidak mencemari prototipe');
    // Ctrl+Enter di kotak komentar = kirim; Enter saja tidak; kotak lain tidak
    const base = t.cc('pgComment').length; t.st.cmt = sentOk(cmt(1)); const kd = (o) => { const ev = Object.assign({ preventDefault() { ev.pd = true; } }, o); t.els.pgmodal.h.keydown(ev); return ev; };
    const e1 = { key: 'Enter', target: { id: '', dataset: { pg: 'ctxt', id: P1 } } }; kd(e1); assert.strictEqual(t.cc('pgComment').length, base, 'Enter saja tidak mengirim');
    const e2 = { ctrlKey: true, key: 'Enter', target: { id: '', dataset: { pg: 'ctxt', id: P1 } } }; const r2 = kd(e2); await sleep(5); assert.strictEqual(t.cc('pgComment').length, base + 1, 'Ctrl+Enter mengirim'); assert.strictEqual(r2.pd, true, 'preventDefault dipanggil');
    const e3 = { metaKey: true, key: 'Enter', target: { id: 'lain', dataset: {} } }; kd(e3); assert.strictEqual(t.cc('pgComment').length, base + 1, 'kotak lain tidak memicu kirim komentar');
    ok('draf bertahan lintas gambar ulang / buka postingan lain / tutup-buka, fokus + seleksi dipulihkan (id cacat dan tanpa fokus diabaikan), Ctrl+Enter mengirim (Enter saja tidak)');
  }
  // K. satu permintaan per postingan
  {
    const t = boot(); await openFeed(t, [post(1), post(2)]); let g; t.st.cms = new Promise((r) => { g = r; }); click(t, 'cmt', P1); click(t, 'cmore', P1); click(t, 'cmt', P1); click(t, 'cmt', P1);
    assert.strictEqual(t.cc('pgComments').length, 1, 'muat ganda dicegah'); g(page([cmt(1)])); await sleep(5);
    type(t, P1, 'a'); let g2; t.st.cmt = new Promise((r) => { g2 = r; }); click(t, 'csend', P1); click(t, 'csend', P1); click(t, 'csend', P1); assert.strictEqual(t.cc('pgComment').length, 1, 'kirim ganda dicegah'); g2(sentOk(cmt(2))); await sleep(5);
    t.st.cms = page([cmt(5)]); click(t, 'cmt', P2); await sleep(5); assert.strictEqual(t.cc('pgComments').length, 2, 'postingan lain berjalan sendiri');
    ok('satu permintaan muat dan satu permintaan kirim per postingan; postingan lain tidak terhalang');
  }
  // L. sisip berurutan tanpa ganda walau halaman belum termuat semua
  {
    const t = boot(); await openFeed(t, [post(1)]); const c = (n) => cmt(n);
    t.st.cms = page([c(1), c(5)], { next: '1700000105000:' + c(5).id, count: 8 }); click(t, 'cmt', P1); await sleep(5);
    type(t, P1, 'tengah'); t.st.cmt = sentOk(c(7)); click(t, 'csend', P1); await sleep(5);
    assert.deepStrictEqual(cm(t, P1).items.map((x) => x.id), [c(1).id, c(5).id, c(7).id], 'komentarku masuk berurutan di antara yang termuat'); assert.strictEqual(cm(t, P1).count, 9);
    t.st.cms = page([c(6), c(7), c(8)], { count: 9 }); click(t, 'cmore', P1); await sleep(5);
    assert.deepStrictEqual(cm(t, P1).items.map((x) => x.id), [c(1), c(5), c(6), c(7), c(8)].map((x) => x.id), 'halaman berikutnya digabung berurutan; komentarku (c7) tidak ganda'); assert.strictEqual(cm(t, P1).count, 9, 'hitungan dari Core yang terbaru');
    const eq = boot(); await openFeed(eq, [post(1)]); eq.st.cms = page([{ id: 'c000000000000002', by: PEER, ts: 5, text: 'b' }, { id: 'c000000000000001', by: PEER, ts: 5, text: 'a' }]); click(eq, 'cmt', P1); await sleep(5);
    assert.deepStrictEqual(cm(eq, P1).items.map((x) => x.id), ['c000000000000001', 'c000000000000002'], 'ts sama: id memutus seri (sama dengan Core)');
    ok('sisip berurutan (ts, id) walau halaman belum termuat semua, tanpa ganda saat halaman berikutnya datang, hitungan Core menang');
  }
  // M. masukan cacat dari IPC tidak merusak tampilan
  {
    const t = boot(); await openFeed(t, [post(1)]);
    t.st.cms = { ok: true, comments: { items: [null, 5, { id: 1 }, { id: 'c1', text: 'tanpa ts', by: PEER }, { id: 'c2', text: 'sah', by: PEER, ts: 10 }, { id: 'c2', text: 'ganda', by: PEER, ts: 11 }, { id: 'c3', text: 7, by: PEER, ts: 12 }], next: 123, count: 'banyak', skipped: 'x' } };
    click(t, 'cmt', P1); await sleep(5); const c = cm(t, P1);
    assert.deepStrictEqual(c.items.map((x) => x.text), ['sah'], 'hanya komentar berbentuk benar; ganda dibuang'); assert.strictEqual(c.next, null, 'next bukan string = null'); assert.strictEqual(c.count, null, 'count bukan bilangan bulat diabaikan'); assert.strictEqual(c.skipped, 0);
    assert(/aria-label="Komentar">/.test(t.H()), 'tanpa hitungan'); assert(!t.H().includes('NaN') && !t.H().includes('undefined'));
    t.st.cms = { ok: true, comments: { items: 'bukan larik', next: null, count: 0, skipped: 0 } }; const u = boot(); await openFeed(u, [post(1)]); u.st.cms = t.st.cms; click(u, 'cmt', P1); await sleep(5); assert.strictEqual(cm(u, P1).items.length, 0, 'items bukan larik = kosong');
    t.run("pgCmtToggle('bukan-hex'); pgCmtToggle('00000000000000ff')"); assert.strictEqual(t.run('Object.keys(pgF.cm).length'), 1, 'id cacat / postingan yang tidak ada diabaikan');
    ok('masukan cacat: butir bukan komentar dan id ganda dibuang, next / count / skipped / items bertipe salah diabaikan, tanpa NaN / undefined, id cacat diabaikan');
  }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
