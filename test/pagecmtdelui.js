'use strict';
// Tes Halaman 5e: tombol "Hapus" untuk komentar milik SENDIRI di halaman orang lain (renderer/js/archne-pages-cmt.js pgCmtDelMine + kait 'cmydel' di archne-pages.js).
// Kelompok: A statis, B tombol hanya di komentar milik sendiri dan hanya di halaman orang lain, C hapus berhasil (konfirmasi, IPC, daftar + hitungan), D batal, E gagal (daftar utuh + toast),
// F queued (pemilik offline) memberi toast, G klik ganda, H jawaban basi, I klik yang dipalsukan (komentar orang lain / Halamanku / id cacat) tak berefek.
// Core / jaringan / IPC: test/pagecmtdel.js.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = '1'.repeat(16), PEER = 'a'.repeat(16), P1 = '0000000000000001', P2 = '0000000000000002';
const post = (n) => ({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public' });
const cmt = (n, o) => Object.assign({ id: 'c' + n.toString(16).padStart(15, '0'), by: PEER, ts: 1700000100000 + n * 1000, text: 'k' + n }, o || {});

function boot(opt) {
  opt = opt || {};
  const els = {}, calls = [], toasts = [], asks = [];
  const st = { list: null, mine: null, cms: null, rm: { ok: true, removed: true }, del: { ok: true, st: 'removed' }, ans: true };
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener(t, f) { this.h[t] = f; }, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
  const val = (r, ...a) => (typeof r === 'function' ? r(...a) : r);
  const api = {
    pgList: async (...a) => { calls.push(['pgList', ...a]); return st.list; },
    pgMine: async (...a) => { calls.push(['pgMine', ...a]); return st.mine; },
    pgComments: async (...a) => { calls.push(['pgComments', ...a]); return val(st.cms, ...a); },
    pgCmtRemove: async (...a) => { calls.push(['pgCmtRemove', ...a]); return val(st.rm, ...a); },
    pgCmtDelete: async (...a) => { calls.push(['pgCmtDelete', ...a]); return val(st.del, ...a); },
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
// Halamanku: pgMine + pgComments lokal. Orang lain: pgList + pgComments lewat jaringan.
async function openMine(t, posts, items, o) { t.st.mine = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.st.cms = page(items, o); t.run(`pgOpen('${ME}')`); await sleep(10); await open(t, posts[0].id); }
async function openOther(t, posts, items) { t.st.list = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.st.cms = page(items); t.run(`pgOpen('${PEER}')`); await sleep(10); await open(t, posts[0].id); }
const open = async (t, id) => { click(t, 'cmt', id); await sleep(10); };
const click = (t, pg, id, cid) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg, id, cid } }) } });
const btns = (t) => (t.H().match(/data-pg="cmydel"/g) || []).length;


(async () => {
  // A. statis
  {
    const c = rd('renderer', 'js', 'archne-pages-cmt.js'), src = rd('renderer', 'js', 'archne-pages.js');
    assert(src.includes("a === 'cmydel' && id") && src.includes('pgCmtDelMine(id, b.dataset.cid)'), 'kait di archne-pages.js');
    assert(/function pgCmtDelMine/.test(c) && /window\.api\.pgCmtDelete\(pgId, id, cid\)/.test(c), 'pgCmtDelMine memanggil pgCmtDelete(pgId, postId, cid)');
    ok('statis: kait cmydel di archne-pages.js, pgCmtDelMine -> pgCmtDelete(peerId, postId, cid)');
  }
  // B. tombol hanya di komentar milik sendiri di halaman orang lain
  {
    const o = boot(); await openOther(o, [post(1)], [cmt(1), cmt(2, { by: ME })]);
    assert.strictEqual(btns(o), 1, 'satu tombol: komentar milik sendiri'); assert(o.H().includes('data-id="' + P1 + '"') && o.H().includes('data-cid="' + cmt(2).id + '"'));
    assert(!o.H().includes('data-pg="cdel"'), 'tanpa tombol pemilik'); assert(!new RegExp('data-cid="' + cmt(1).id + '"[^>]*data-pg="cmydel"|data-pg="cmydel"[^>]*data-cid="' + cmt(1).id + '"').test(o.H()), 'komentar orang lain tanpa tombol');
    const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2, { by: ME })]);
    assert.strictEqual(btns(t), 0, 'Halamanku: tombol penulis tidak ada (pemilik memakai cdel)'); assert((t.H().match(/data-pg="cdel"/g) || []).length === 2);
    ok('tombol cmydel hanya pada komentar milik sendiri di halaman orang lain; Halamanku tetap memakai cdel');
  }
  // C. hapus berhasil
  {
    const t = boot(); await openOther(t, [post(1)], [cmt(1), cmt(2, { by: ME }), cmt(3, { by: ME })]);
    assert(/Komentar \(3\)/.test(t.H()));
    click(t, 'cmydel', P1, cmt(2).id); await sleep(10);
    assert.strictEqual(t.asks.length, 1); assert(/Hapus komentarmu/.test(t.asks[0]) && /offline/.test(t.asks[0]), 'konfirmasi menyebut penghapusan menunggu bila offline');
    assert.deepStrictEqual(t.cc('pgCmtDelete'), [['pgCmtDelete', PEER, P1, cmt(2).id]], 'IPC: (pemilik halaman, postingan, komentar)'); assert.strictEqual(t.cc('pgCmtRemove').length, 0, 'bukan jalur pemilik');
    assert(!t.H().includes(cmt(2).id) && t.H().includes(cmt(3).id) && t.H().includes('k1'), 'hanya itu yang hilang'); assert(/Komentar \(2\)/.test(t.H()), 'hitungan turun satu'); assert.deepStrictEqual(t.toasts, []);
    for (const st of ['none', 'gone']) { const u = boot(); u.st.del = { ok: true, st }; await openOther(u, [post(1)], [cmt(2, { by: ME })]); click(u, 'cmydel', P1, cmt(2).id); await sleep(10); assert(!u.H().includes(cmt(2).id), st + ': tetap dibuang dari layar'); assert.deepStrictEqual(u.toasts, []); }
    ok('hapus berhasil: konfirmasi, IPC (pemilik, postingan, komentar), daftar dan hitungan, none / gone sama-sama dibuang');
  }
  // D. batal
  {
    const t = boot(); t.st.ans = false; await openOther(t, [post(1)], [cmt(2, { by: ME })]);
    click(t, 'cmydel', P1, cmt(2).id); await sleep(10); assert.strictEqual(t.asks.length, 1); assert.strictEqual(t.cc('pgCmtDelete').length, 0, 'batal = tanpa IPC'); assert.strictEqual(btns(t), 1); assert(/Komentar \(1\)/.test(t.H()));
    ok('batal di dialog: tanpa IPC, komentar tetap');
  }
  // E. gagal
  {
    for (const bad of [{ ok: false, err: 'Aplikasi pemilik belum mendukung penghapusan komentar oleh penulisnya.', code: 'old' }, null]) {
      const t = boot(); t.st.del = bad; await openOther(t, [post(1)], [cmt(2, { by: ME })]);
      click(t, 'cmydel', P1, cmt(2).id); await sleep(10);
      assert.strictEqual(btns(t), 1, 'daftar tak berubah'); assert(/Komentar \(1\)/.test(t.H()));
      assert.deepStrictEqual(t.toasts, [bad ? bad.err : 'Gagal menghapus komentar.']);
      assert(!/disabled/.test(t.H().match(/<button[^>]*cmydel[^>]*>/)[0]), 'tombol aktif lagi');
    }
    { const t = boot(); await openOther(t, [post(1)], [cmt(2, { by: ME })]); t.ctx.window.api.pgCmtDelete = async () => { throw new Error('putus'); }; click(t, 'cmydel', P1, cmt(2).id); await sleep(10); assert.deepStrictEqual(t.toasts, ['Gagal menghapus komentar.']); assert.strictEqual(btns(t), 1); }
    ok('gagal: daftar utuh, toast memakai pesan Core (old dll) atau pesan umum, tombol aktif lagi; IPC melempar = pesan umum');
  }
  // F. queued
  {
    const t = boot(); t.st.del = { ok: true, st: 'queued' }; await openOther(t, [post(1)], [cmt(2, { by: ME }), cmt(3)]);
    click(t, 'cmydel', P1, cmt(2).id); await sleep(10);
    assert(!t.H().includes(cmt(2).id) && t.H().includes(cmt(3).id), 'disembunyikan dari layar'); assert(/Komentar \(1\)/.test(t.H()));
    assert.strictEqual(t.toasts.length, 1); assert(/offline/.test(t.toasts[0]) && /dihapus/.test(t.toasts[0]));
    ok('queued: komentar disembunyikan dan toast menjelaskan penghapusan menunggu pemilik online');
  }
  // G. klik ganda
  {
    const t = boot(); let g; t.st.del = () => new Promise((r) => { g = r; }); await openOther(t, [post(1)], [cmt(2, { by: ME })]);
    click(t, 'cmydel', P1, cmt(2).id); await sleep(10); assert(/disabled/.test(t.H().match(/<button[^>]*cmydel[^>]*>/)[0]) && t.H().includes('Menghapus…'), 'tombol nonaktif selagi menunggu');
    click(t, 'cmydel', P1, cmt(2).id); await sleep(10); assert.strictEqual(t.asks.length, 1, 'klik kedua tak membuka konfirmasi'); assert.strictEqual(t.cc('pgCmtDelete').length, 1);
    g({ ok: true, st: 'removed' }); await sleep(10); assert(!t.H().includes(cmt(2).id));
    ok('klik ganda: satu konfirmasi, satu IPC, tombol "Menghapus…" selagi menunggu');
  }
  // H. jawaban basi
  {
    const t = boot(); let g; t.st.del = () => new Promise((r) => { g = r; }); await openOther(t, [post(1)], [cmt(2, { by: ME })]);
    click(t, 'cmydel', P1, cmt(2).id); await sleep(10); t.run('pgClose()'); g({ ok: false, err: 'x' }); await sleep(10); assert.deepStrictEqual(t.toasts, [], 'layar ditutup: jawaban basi diabaikan');
    ok('jawaban basi sesudah layar ditutup diabaikan');
  }
  // I. klik yang dipalsukan
  {
    const t = boot(); await openOther(t, [post(1)], [cmt(1), cmt(2, { by: ME })]);
    for (const [id, cid] of [[P1, cmt(1).id], [undefined, cmt(2).id], [P1, undefined], [P1, 'zz'], ['xyz', cmt(2).id], [P2, cmt(2).id], [P1, 'c' + '9'.repeat(15)]]) { click(t, 'cmydel', id, cid); await sleep(5); }
    assert.strictEqual(t.cc('pgCmtDelete').length, 0, 'komentar orang lain / id cacat / tak dikenal: tanpa IPC'); assert.strictEqual(t.asks.length, 0, 'tanpa konfirmasi');
    const m = boot(); await openMine(m, [post(1)], [cmt(2, { by: ME })]); click(m, 'cmydel', P1, cmt(2).id); await sleep(10); assert.strictEqual(m.cc('pgCmtDelete').length, 0, 'Halamanku: kait penulis tak berlaku'); assert.strictEqual(m.asks.length, 0);
    ok('klik cmydel yang dipalsukan (komentar orang lain, id cacat, Halamanku) tak berefek');
  }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
