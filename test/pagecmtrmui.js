'use strict';
// Tes Halaman 5c-2: tombol "Hapus komentar" di UI pemilik (renderer/js/archne-pages-cmt.js pgCmtDel + kait 'cdel' di archne-pages.js + CSS).
// Kelompok: A statis, B tombol hanya di Halamanku, C hapus berhasil (konfirmasi, IPC, daftar + hitungan), D batal, E gagal (daftar utuh + toast),
// F removed:false, G klik ganda, H jawaban basi (layar ditutup / postingan dihapus), I masukan cacat, J sisip ulang sesudah hapus, K habis = "Belum ada komentar".
// Penyimpanan / Core / IPC: test/pagecmtrm.js.
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
  const st = { list: null, mine: null, cms: null, rm: { ok: true, removed: true }, ans: true };
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener(t, f) { this.h[t] = f; }, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
  const val = (r, ...a) => (typeof r === 'function' ? r(...a) : r);
  const api = {
    pgList: async (...a) => { calls.push(['pgList', ...a]); return st.list; },
    pgMine: async (...a) => { calls.push(['pgMine', ...a]); return st.mine; },
    pgComments: async (...a) => { calls.push(['pgComments', ...a]); return val(st.cms, ...a); },
    pgCmtRemove: async (...a) => { calls.push(['pgCmtRemove', ...a]); return val(st.rm, ...a); },
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
const btns = (t) => (t.H().match(/data-pg="cdel"/g) || []).length;

(async () => {
  // A. statis
  {
    const css = rd('renderer/css/archne-pages.css'), src = rd('renderer/js/archne-pages.js'), c = rd('renderer/js/archne-pages-cmt.js');
    for (const k of ['.pgcdel', '.pgcdel:hover', '.pgcdel:focus-visible', '.pgcdel[disabled]']) assert(css.includes('#pgmodal ' + k), 'CSS ' + k);
    assert(src.includes("a === 'cdel' && id") && src.includes('pgCmtDel(id, b.dataset.cid)'), 'kait di archne-pages.js');
    assert(/function pgCmtDel/.test(c) && /window\.api\.pgCmtRemove\(id, cid\)/.test(c), 'pgCmtDel memanggil pgCmtRemove(postId, cid)');
    ok('statis: CSS tombol Hapus, kait cdel di archne-pages.js, pgCmtDel -> pgCmtRemove(postId, cid)');
  }
  // B. tombol hanya di Halamanku
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2, { by: ME })]);
    assert.strictEqual(btns(t), 2, 'tiap komentar (orang lain DAN milik sendiri) punya tombol Hapus'); assert(t.H().includes('data-cid="' + cmt(1).id + '"') && t.H().includes('aria-label="Hapus komentar dari nama-aa"'));
    const o = boot(); await openOther(o, [post(1)], [cmt(1), cmt(2, { by: ME })]);
    assert.strictEqual(btns(o), 0, 'halaman orang lain: tanpa tombol Hapus milik pemilik'); assert.strictEqual((o.H().match(/class="pgcdel"/g) || []).length, 1, '5e: hanya komentar milik sendiri yang punya tombol (cmydel), komentar orang lain tidak'); assert(o.H().includes('data-pg="cmydel"') && o.H().includes('data-cid="' + cmt(2).id + '"'));
    // klik 'cdel' yang dipalsukan di halaman orang lain tetap tak berefek
    click(o, 'cdel', P1, cmt(1).id); await sleep(10); assert.strictEqual(o.cc('pgCmtRemove').length, 0, 'tanpa IPC'); assert.strictEqual(o.asks.length, 0, 'tanpa konfirmasi');
    // komentar tertutup / belum dimuat: tanpa tombol
    const c = boot(); c.st.mine = { ok: true, items: [post(1)], next: null, count: 1, skipped: 0 }; c.run(`pgOpen('${ME}')`); await sleep(10); assert.strictEqual(btns(c), 0);
    ok('tombol Hapus hanya di Halamanku (semua komentar); halaman orang lain tanpa tombol dan klik palsu tak berefek');
  }
  // C. hapus berhasil
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2), cmt(3)]);
    assert(/aria-label="Komentar \(3\)"/.test(t.H()) && t.H().includes('<span class="pgcn">3</span>'));
    click(t, 'cdel', P1, cmt(2).id); await sleep(10);
    assert.strictEqual(t.asks.length, 1); assert(/^Hapus komentar ini\?/.test(t.asks[0]), 'konfirmasi berawalan "Hapus" (tombol merah)');
    assert.deepStrictEqual(t.cc('pgCmtRemove'), [['pgCmtRemove', P1, cmt(2).id]], 'tepat (postId, cid)');
    assert.deepStrictEqual(JSON.parse(t.run('JSON.stringify(pgF.cm["' + P1 + '"].items.map((c) => c.id))')), [cmt(1).id, cmt(3).id], 'sisa urut'); assert.strictEqual(t.run('pgF.cm["' + P1 + '"].count'), 2);
    assert(/aria-label="Komentar \(2\)"/.test(t.H()) && !t.H().includes('k2<') && btns(t) === 2, 'hitungan turun, komentar hilang dari layar'); assert.deepStrictEqual(t.toasts, []);
    assert.strictEqual(t.run('pgF.cm["' + P1 + '"].rm.size'), 0, 'penanda sedang-menghapus dibersihkan');
    ok('hapus: konfirmasi -> pgCmtRemove(postId, cid) -> komentar hilang, hitungan turun satu, sisa urut');
  }
  // D. batal
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1)]); t.st.ans = false;
    click(t, 'cdel', P1, cmt(1).id); await sleep(10); assert.strictEqual(t.asks.length, 1); assert.strictEqual(t.cc('pgCmtRemove').length, 0, 'batal = tanpa IPC'); assert.strictEqual(btns(t), 1); assert(/Komentar \(1\)/.test(t.H()));
    ok('batal di konfirmasi: tanpa IPC, daftar dan hitungan utuh');
  }
  // E. gagal
  {
    for (const [r, msg] of [[{ ok: false, code: 'ENOSPC', err: 'Penyimpanan penuh' }, 'Penyimpanan penuh'], [{ ok: false, code: 'io', err: 'Gagal memproses komentar' }, 'Gagal memproses komentar'], [{ ok: false, code: 'proto' }, 'Gagal menghapus komentar.'], [null, 'Gagal menghapus komentar.']]) {
      const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2)]); t.st.rm = r;
      click(t, 'cdel', P1, cmt(1).id); await sleep(10);
      assert.strictEqual(t.toasts.length, 1, JSON.stringify(r)); assert.strictEqual(t.toasts[0], msg, 'pesan: ' + t.toasts[0]);
      assert.strictEqual(btns(t), 2, 'daftar utuh'); assert(/Komentar \(2\)/.test(t.H()), 'hitungan utuh'); assert(!t.H().includes('Menghapus…'), 'tombol aktif lagi'); assert.strictEqual(t.run('pgF.cm["' + P1 + '"].rm.size'), 0);
    }
    { const t = boot(); await openMine(t, [post(1)], [cmt(1)]); t.ctx.window.api.pgCmtRemove = async () => { throw new Error('putus'); }; click(t, 'cdel', P1, cmt(1).id); await sleep(10); assert.deepStrictEqual(t.toasts, ['Gagal menghapus komentar.']); assert.strictEqual(btns(t), 1); }
    ok('gagal (galat Core, tanpa kode, null, IPC melempar): toast, daftar + hitungan utuh, tombol aktif lagi');
  }
  // F. removed:false
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2)]); t.st.rm = { ok: true, removed: false };
    click(t, 'cdel', P1, cmt(1).id); await sleep(10); assert.strictEqual(btns(t), 1, 'sudah tidak ada di Core: tetap dibuang dari layar'); assert(/Komentar \(1\)/.test(t.H())); assert.deepStrictEqual(t.toasts, []);
    ok('removed:false (sudah hilang): dibuang dari layar tanpa galat');
  }
  // G. klik ganda
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2)]); let gate; t.st.rm = new Promise((r) => { gate = r; });
    click(t, 'cdel', P1, cmt(1).id); await sleep(10);
    assert(t.H().includes('Menghapus…') && /data-cid="c000000000000001"[^>]*disabled/.test(t.H()), 'tombol nonaktif + "Menghapus…" selagi menunggu');
    click(t, 'cdel', P1, cmt(1).id); await sleep(10); assert.strictEqual(t.asks.length, 1, 'klik kedua tak membuka konfirmasi lagi'); assert.strictEqual(t.cc('pgCmtRemove').length, 1, 'satu IPC');
    // komentar lain tetap bisa dihapus bersamaan
    click(t, 'cdel', P1, cmt(2).id); await sleep(10); assert.strictEqual(t.cc('pgCmtRemove').length, 2, 'komentar lain tak terhalang');
    gate({ ok: true, removed: true }); await sleep(10); assert.strictEqual(btns(t), 0); assert(/Komentar \(0\)/.test(t.H()));
    // klik ganda saat dialog masih terbuka
    const u = boot(); await openMine(u, [post(1)], [cmt(1)]); let g2; u.st.ans = new Promise((r) => { g2 = r; });
    click(u, 'cdel', P1, cmt(1).id); click(u, 'cdel', P1, cmt(1).id); g2(true); await sleep(10); assert.strictEqual(u.cc('pgCmtRemove').length, 1, 'dua klik sebelum menjawab dialog = paling banyak satu IPC');
    ok('klik ganda: satu IPC per komentar, tombol nonaktif selagi menunggu, komentar lain tak terhalang');
  }
  // H. jawaban basi
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1)]); let gate; t.st.rm = new Promise((r) => { gate = r; });
    click(t, 'cdel', P1, cmt(1).id); await sleep(10); t.run('pgClose()'); gate({ ok: false, err: 'x' }); await sleep(10); assert.deepStrictEqual(t.toasts, [], 'layar ditutup: jawaban basi diabaikan');
    const u = boot(); await openMine(u, [post(1)], [cmt(1)]); let g; u.st.rm = new Promise((r) => { g = r; });
    click(u, 'cdel', P1, cmt(1).id); await sleep(10); u.run(`delete pgF.cm['${P1}']`); g({ ok: true, removed: true }); await sleep(10); assert.deepStrictEqual(u.toasts, [], 'postingan dihapus selagi menunggu: tanpa galat');
    // layar ditutup saat dialog masih terbuka: tanpa IPC
    const w = boot(); await openMine(w, [post(1)], [cmt(1)]); let g3; w.st.ans = new Promise((r) => { g3 = r; });
    click(w, 'cdel', P1, cmt(1).id); w.run('pgClose()'); g3(true); await sleep(10); assert.strictEqual(w.cc('pgCmtRemove').length, 0, 'layar berganti selagi dialog terbuka = tanpa IPC');
    ok('jawaban basi: layar ditutup / postingan dihapus / dialog dijawab sesudah layar berganti = diabaikan, tanpa galat');
  }
  // I. masukan cacat
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1)]);
    for (const [id, cid] of [[undefined, cmt(1).id], [P1, undefined], [P1, 'zz'], [P1, 'C000000000000001'], ['xyz', cmt(1).id], [P2, cmt(1).id], [P1, 'c' + '9'.repeat(15)]]) { click(t, 'cdel', id, cid); await sleep(5); }
    assert.strictEqual(t.asks.length, 0, 'id cacat / komentar yang tak ada di daftar: tanpa dialog'); assert.strictEqual(t.cc('pgCmtRemove').length, 0, 'tanpa IPC');
    const x = boot(); await openMine(x, [post(1)], [cmt(1, { id: 'bukan-hex' })]); assert.strictEqual(btns(x), 0, 'id komentar cacat dari IPC: tanpa tombol');
    ok('masukan cacat: id bukan hex16 / postingan tak dikenal / komentar tak ada di daftar = tanpa dialog dan tanpa IPC');
  }
  // J. sisip ulang sesudah hapus
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1), cmt(2)]); click(t, 'cdel', P1, cmt(1).id); await sleep(10);
    assert.strictEqual(t.run(`pgCmtMerge(pgF.cm['${P1}'], [${JSON.stringify(cmt(1))}])`), 1, 'UI tidak menahan id yang sudah dibuang (keputusan ditolak / tidaknya ada di Core: nisan, test/pagecmtpriv.js)'); assert.strictEqual(t.run(`pgF.cm['${P1}'].items.length`), 2);
    ok('sesudah dihapus, id keluar dari ids: UI tidak menahan apa pun; menolak kirim ulang adalah urusan Core (nisan)');
  }
  // K. habis
  {
    const t = boot(); await openMine(t, [post(1)], [cmt(1)]); click(t, 'cdel', P1, cmt(1).id); await sleep(10);
    assert(t.H().includes('Belum ada komentar.') && /Komentar \(0\)/.test(t.H()) && btns(t) === 0, 'habis = "Belum ada komentar."');
    const u = boot(); await openMine(u, [post(1)], [cmt(1)], { next: 'cur', count: 5 }); click(u, 'cdel', P1, cmt(1).id); await sleep(10);
    assert(/Komentar \(4\)/.test(u.H()) && u.H().includes('Muat komentar lagi') && !u.H().includes('Belum ada komentar'), 'masih ada halaman berikutnya: hitungan turun, tombol muat tetap');
    ok('habis = "Belum ada komentar."; masih ada halaman berikutnya = "Muat komentar lagi" tetap, hitungan dari Core turun satu');
  }
  console.log('\n' + pass + ' tes lulus');
})().catch((e) => { console.error(e); process.exit(1); });
