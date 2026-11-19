'use strict';
// Tes Halaman 5g: UI REAKSI pada KOMENTAR (renderer/js/archne-pages-cmt.js: pgCrxHtml / pgCmtRxFrom / pgCmtRxMenu / pgCmtWho / pgCmtRx; kait di archne-pages.js; penyegaran di archne-pages-sync.js). Backend: test/pagecmtrx.js.
// Kelompok: A statis (CSS, kait, preload), B tampilan chip (komentar + balasan, di-escape, disorot), C Halamanku (Siapa) vs halaman orang lain (tanpa Siapa), D alur pasang / ganti / cabut (optimistik lalu keadaan Core),
// E kegagalan = kembali ke keadaan lama (old, offline, null, melempar), F satu permintaan per komentar + jawaban basi, G pgCmtRxFrom (masukan cacat, komentar yang sedang dikirim tidak disentuh), H pemilih + Siapa (buka/tutup), I penyegaran Halamanku hanya saat event rx, J sinkron otomatis halaman orang lain.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = '1'.repeat(16), PEER = 'a'.repeat(16), P1 = '0000000000000001', P2 = '0000000000000002';
const post = (n, o) => Object.assign({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public' }, o || {});
const cmt = (n, o) => Object.assign({ id: 'c' + n.toString(16).padStart(15, '0'), by: PEER, ts: 1700000100000 + n * 1000, text: 'k' + n }, o || {});
const C1 = cmt(1).id, C2 = cmt(2).id, C3 = cmt(3).id;
const J = (x) => JSON.parse(JSON.stringify(x));

function boot() {
  const els = {}, calls = [], toasts = [];
  const st = { list: null, mine: null, cms: null, cmt: null, crx: null };
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener(t, f) { this.h[t] = f; }, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
  const val = (r, ...a) => (typeof r === 'function' ? r(...a) : r);
  const api = {
    pgList: async (...a) => { calls.push(['pgList', ...a]); return st.list; },
    pgMine: async (...a) => { calls.push(['pgMine', ...a]); return st.mine; },
    pgComments: async (...a) => { calls.push(['pgComments', ...a]); return val(st.cms, ...a); },
    pgComment: async (...a) => { calls.push(['pgComment', ...a]); return val(st.cmt, ...a); },
    pgCmtReact: async (...a) => { calls.push(['pgCmtReact', ...a]); return val(st.crx, ...a); },
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
  return { els, calls, toasts, st, run, ctx, doc, H: () => els.pglist.innerHTML, cc: (n) => J(calls.filter((c) => c[0] === n)) };
}
async function openFeed(t, posts, id) { t.st.list = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.st.mine = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.run(`pgOpen('${id || PEER}')`); await sleep(10); }
const click = (t, pg, id, extra) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: Object.assign({ pg, id }, extra || {}) }) } });
const cm = (t, id) => J(t.run(`(() => { const c = pgF.cm['${id}']; return c && Object.assign({}, c, { ids: [...c.ids], whoOpen: c.whoOpen ? [...c.whoOpen] : [], rm: undefined }); })()`));
const item = (t, pid, cid) => cm(t, pid).items.find((x) => x.id === cid);
const page = (items, o) => ({ ok: true, comments: Object.assign({ items, next: null, count: items.length, skipped: 0 }, o || {}) });
// buka utas satu postingan dengan komentar tertentu
async function openThread(t, who, items, rx, o) { await openFeed(t, [post(1), post(2)], who); t.st.cms = page(items, Object.assign(rx ? { rx } : {}, o || {})); click(t, 'cmt', P1); await sleep(10); }
const cr = (t, cid, e) => click(t, 'crx', P1, { cid, e });
const crxRow = (H, cid) => { const i = H.indexOf(`data-cid="${cid}"><div class="pgcmeta"`); if (i < 0) return ''; const m = /<div class="pgc[ "]/.exec(H.slice(i + 10)); return H.slice(i, m ? i + 10 + m.index : undefined); };

(async () => {
  // A. statis
  {
    const css = rd('renderer/css/archne-pages.css'), src = rd('renderer/js/archne-pages.js'), c = rd('renderer/js/archne-pages-cmt.js'), pre = rd('preload.js'), sync = rd('renderer/js/archne-pages-sync.js');
    for (const k of ['.pgcrxs', '.pgcrxs .pgrx', '.pgcrxpick', '.pgrxwho', '.pgwho']) assert(css.includes('#pgmodal ' + k), 'CSS ' + k);
    for (const k of ["a === 'crx' && id", "a === 'crxadd' && id", "a === 'cwho' && id", 'pgCmtRx(id, b.dataset.cid, b.dataset.e)', 'pgCmtRxMenu(id, b.dataset.cid)', 'pgCmtWho(id, b.dataset.cid)']) assert(src.includes(k), 'kait di archne-pages.js: ' + k);
    assert(c.includes('${pgCrxHtml(postId, c, cm)}'), 'baris chip digambar di bawah teks tiap komentar (balasan juga: pgCmtItemHtml dipakai semua tingkat)');
    assert(pre.includes("pgCmtReact: (peerId, postId, cid, e) => ipcRenderer.invoke('pgCmtReact', peerId, postId, cid, e)"), 'preload: pgCmtReact');
    assert(sync.includes('pgSyncCmtRx(f, tok, pid, cm)') && /f\.mine && rxHint/.test(sync), 'penyegaran reaksi komentar hanya di Halamanku dan hanya dengan petunjuk rx');
    // semua tombol baru membawa data-id (postingan) dan data-cid (komentar)
    for (const a of ['crx', 'crxadd', 'cwho']) assert(new RegExp('data-pg="' + a + '" data-id="\\$\\{postId\\}" data-cid="\\$\\{esc\\(c\\.id\\)\\}"').test(c), 'tombol ' + a + ' membawa id postingan + id komentar');
    ok('statis: CSS chip / pemilih, kait di archne-pages.js, preload pgCmtReact, penyegaran hanya Halamanku + petunjuk rx, tombol membawa id postingan dan id komentar');
  }
  // B. tampilan chip
  {
    const t = boot();
    const re = cmt(2, { re: C1, text: 'balasan' });
    await openThread(t, PEER, [cmt(1), re, cmt(3, { text: '<b>x</b>' })], { [C1]: { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '🩷' }, [C2]: { rx: [{ e: '👍', n: 1 }] }, [C3]: { rx: [{ e: '<i>', n: 1 }] } });
    const H = t.H();
    assert.strictEqual((H.match(/data-pg="crxadd"/g) || []).length, 3, 'tiap komentar (termasuk balasan) punya tombol tambah');
    const r1 = crxRow(H, C1), r2 = crxRow(H, C2), r3 = crxRow(H, C3);
    assert(r1.includes('aria-label="Reaksi 👍, 2 orang"') && r1.includes('<b>2</b>') && r1.includes(`data-id="${P1}" data-cid="${C1}" data-e="👍"`), 'chip + jumlah + label + id postingan/komentar');
    assert(/class="pgrx mine"[^>]*data-e="🩷"[^>]*aria-pressed="true"/.test(r1) && /class="pgrx"[^>]*data-e="👍"[^>]*aria-pressed="false"/.test(r1), 'hanya reaksiku yang disorot');
    assert(r2.includes('data-e="👍"') && !r2.includes('mine'), 'balasan punya reaksinya sendiri dan tidak ikut milik induk');
    assert(r3.includes('data-e="&lt;i&gt;"') && !r3.includes('data-e="<i>"'), 'emoji di-escape di atribut');
    assert(!H.includes('pgcrxpick') && !H.includes('data-pg="cwho"'), 'pemilih tertutup bawaan; halaman orang lain tanpa Siapa');
    // komentar tanpa reaksi: hanya tombol tambah
    const u = boot(); await openThread(u, PEER, [cmt(1)], null); assert(!crxRow(u.H(), C1).includes('data-pg="crx"') && crxRow(u.H(), C1).includes('data-pg="crxadd"'), 'tanpa reaksi: hanya tombol tambah');
    // komentar yang dihapus / utas tak tersedia: tanpa baris
    const g = boot(); await openFeed(g, [post(1)]); g.st.cms = { ok: true, comments: null }; click(g, 'cmt', P1); await sleep(10); assert(!g.H().includes('crxadd'), 'utas tidak tersedia: tanpa chip');
    ok('tampilan: tombol tambah di tiap komentar dan balasan, chip + jumlah + label + id, hanya milikku disorot, emoji di-escape, tanpa reaksi hanya tombol tambah, utas hilang tanpa chip');
  }
  // C. Halamanku vs halaman orang lain: daftar pelaku
  {
    const who = [{ e: '👍', by: [PEER, ME] }, { e: '🩷', by: ['b'.repeat(16)] }], rx = { [C1]: { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '👍', who } };
    const m = boot(); await openThread(m, ME, [cmt(1)], rx);
    assert(crxRow(m.H(), C1).includes('data-pg="cwho"'), 'Halamanku: tombol Siapa'); assert(!m.H().includes('class="pgwho"'), 'panel tertutup bawaan');
    click(m, 'cwho', P1, { cid: C1 }); assert(m.H().includes('class="pgwho"') && m.H().includes('nama-aa, nama-11') && m.H().includes('nama-bb'), 'panel Siapa membuka dan menyebut nama');
    click(m, 'cwho', P1, { cid: C1 }); assert(!m.H().includes('class="pgwho"'), 'ketuk lagi menutup');
    // halaman orang lain: sekalipun jawaban memuat who, tidak disimpan dan tidak digambar
    const o = boot(); await openThread(o, PEER, [cmt(1)], rx); assert(!o.H().includes('data-pg="cwho"') && !('who' in item(o, P1, C1)), 'halaman orang lain: who dibuang');
    click(o, 'cwho', P1, { cid: C1 }); assert(!o.H().includes('class="pgwho"') && cm(o, P1).whoOpen.length === 0, 'cwho di halaman orang lain tidak berefek');
    // Siapa hanya bila ada reaksi
    const e = boot(); await openThread(e, ME, [cmt(1)], null); assert(!e.H().includes('data-pg="cwho"'), 'tanpa reaksi: tanpa Siapa'); click(e, 'cwho', P1, { cid: C1 }); assert.strictEqual(cm(e, P1).whoOpen.length, 0, 'cwho tanpa reaksi tidak membuka apa pun');
    ok('Siapa: hanya Halamanku dan hanya bila ada reaksi (buka/tutup, nama tampil); who dari halaman orang lain dibuang dan cwho di sana tidak berefek');
  }
  // D. alur pasang / ganti / cabut
  {
    const t = boot(); await openThread(t, PEER, [cmt(1), cmt(2)], { [C1]: { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }] } });
    // pasang (lewat pemilih)
    click(t, 'crxadd', P1, { cid: C1 }); assert(crxRow(t.H(), C1).includes('pgcrxpick') && crxRow(t.H(), C1).includes('aria-expanded="true"'), 'pemilih terbuka di komentar itu saja'); assert(!crxRow(t.H(), C2).includes('pgcrxpick'), 'komentar lain tetap tertutup');
    assert.strictEqual((crxRow(t.H(), C1).split('pgcrxpick')[1].match(/data-pg="crx"/g) || []).length, 6, 'enam pilihan cepat');
    click(t, 'crxadd', P1, { cid: C1 }); assert(!t.H().includes('pgcrxpick'), 'ketuk lagi menutup'); click(t, 'crxadd', P1, { cid: C1 }); click(t, 'crxadd', P1, { cid: C2 }); assert(!crxRow(t.H(), C1).includes('pgcrxpick') && crxRow(t.H(), C2).includes('pgcrxpick'), 'satu pemilih terbuka sekaligus');
    let g; t.st.crx = new Promise((r) => { g = r; });
    cr(t, C1, '🥺');
    assert.deepStrictEqual(t.cc('pgCmtReact'), [['pgCmtReact', PEER, P1, C1, '🥺']], 'IPC: peer, postingan, komentar, emoji');
    assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }, { e: '🥺', n: 1 }], 'optimistik: langsung tampil'); assert.strictEqual(item(t, P1, C1).mine, '🥺');
    assert(!t.H().includes('pgcrxpick') && /data-pg="crx"[^>]*disabled/.test(crxRow(t.H(), C1)), 'pemilih menutup dan tombol terkunci selagi menunggu');
    g({ ok: true, react: { rx: [{ e: '👍', n: 2 }, { e: '🥺', n: 2 }, { e: '🩷', n: 1 }], mine: '🥺' } }); await sleep(5);
    assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 2 }, { e: '🥺', n: 2 }, { e: '🩷', n: 1 }], 'sesudahnya: keadaan dari Core'); assert(!/data-pg="crx"[^>]*disabled/.test(crxRow(t.H(), C1)), 'terbuka lagi');
    // ganti
    t.st.crx = { ok: true, react: { rx: [{ e: '👍', n: 3 }, { e: '🩷', n: 1 }], mine: '👍' } }; cr(t, C1, '👍'); assert.strictEqual(t.cc('pgCmtReact')[1][4], '👍'); await sleep(5);
    assert.strictEqual(item(t, P1, C1).mine, '👍'); assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 3 }, { e: '🩷', n: 1 }]);
    // cabut: ketuk reaksi sendiri = kirim '' ; Core menjawab tanpa reaksiku
    t.st.crx = { ok: true, react: { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '' } }; cr(t, C1, '👍'); assert.strictEqual(t.cc('pgCmtReact')[2][4], '', "mengetuk reaksi sendiri mengirim '' (cabut)"); await sleep(5);
    assert.strictEqual(item(t, P1, C1).mine, undefined, 'mine hilang'); assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }]);
    // cabut reaksi terakhir: field hilang seperti komentar tanpa reaksi
    t.st.crx = { ok: true, react: { rx: [], mine: '' } }; cr(t, C2, '👍'); await sleep(5); cr(t, C2, '👍'); await sleep(5); assert(!('rx' in item(t, P1, C2)) && !('mine' in item(t, P1, C2)), 'tanpa reaksi: tanpa field');
    ok('alur: pemilih per komentar (satu terbuka), pasang optimistik lalu keadaan Core, tombol terkunci selagi menunggu, ganti, cabut (kirim kosong), reaksi terakhir hilang tanpa sisa field');
  }
  // D2. Halamanku: who ikut diperbarui optimistik, lalu dari Core
  {
    const t = boot(); await openThread(t, ME, [cmt(1)], { [C1]: { rx: [{ e: '👍', n: 1 }], mine: '', who: [{ e: '👍', by: [PEER] }] } });
    let g; t.st.crx = new Promise((r) => { g = r; }); cr(t, C1, '🩷');
    assert.deepStrictEqual(t.cc('pgCmtReact')[0], ['pgCmtReact', ME, P1, C1, '🩷'], 'Halamanku: peer = id sendiri (lokal)');
    assert.deepStrictEqual(item(t, P1, C1).who, [{ e: '👍', by: [PEER] }, { e: '🩷', by: [ME] }], 'optimistik: aku masuk daftar pelaku');
    g({ ok: true, react: { rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], mine: '🩷', who: [{ e: '👍', by: [PEER] }, { e: '🩷', by: [ME] }] } }); await sleep(5);
    assert.deepStrictEqual(item(t, P1, C1).who, [{ e: '👍', by: [PEER] }, { e: '🩷', by: [ME] }], 'Halamanku menyimpan who dari Core');
    t.st.crx = { ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '', who: [{ e: '👍', by: [PEER] }] } }; cr(t, C1, '🩷'); await sleep(5);
    assert.deepStrictEqual(item(t, P1, C1).who, [{ e: '👍', by: [PEER] }], 'cabut: aku keluar dari daftar pelaku');
    ok('Halamanku: daftar pelaku ikut berubah optimistik (aku masuk / keluar) dan disimpan dari jawaban Core');
  }
  // E. kegagalan
  {
    for (const [label, reply, msg] of [
      ['old', { ok: false, code: 'old', err: 'x' }, (t) => t.run('PG_CMT_ERR.rxOld')],
      ['offline', { ok: false, code: 'offline', err: 'x' }, (t) => t.run('PG_ERR.offline')],
      ['busy', { ok: false, code: 'busy', err: 'x' }, (t) => t.run('PG_ERR.busy')],
      ['null', { ok: true, react: null }, () => 'Komentar ini sudah tidak tersedia.'],
      ['melempar', () => { throw new Error('putus'); }, (t) => t.run('PG_ERR.proto')],
    ]) {
      const t = boot(); await openThread(t, PEER, [cmt(1)], { [C1]: { rx: [{ e: '👍', n: 2 }], mine: '👍' } }); const before = J(item(t, P1, C1));
      t.st.crx = reply; cr(t, C1, '🩷'); assert.notDeepStrictEqual(item(t, P1, C1), before, label + ': optimistik sempat tampil'); await sleep(5);
      assert.deepStrictEqual(item(t, P1, C1), before, label + ': kembali persis ke keadaan lama'); assert.deepStrictEqual(t.toasts, [msg(t)], label + ': toast'); assert(!/data-pg="crx"[^>]*disabled/.test(crxRow(t.H(), C1)), label + ': tombol terbuka lagi');
      cr(t, C1, '🩷'); assert.strictEqual(t.cc('pgCmtReact').length, 2, label + ': bisa dicoba lagi');
    }
    assert(rd('renderer/js/archne-pages-cmt.js').includes("'Aplikasi pemilik belum mendukung reaksi pada komentar.'"), 'pesan old tepat');
    // komentar tanpa reaksi lalu gagal: tidak meninggalkan field
    const t = boot(); await openThread(t, PEER, [cmt(1)], null); t.st.crx = { ok: false, code: 'offline', err: 'x' }; cr(t, C1, '👍'); await sleep(5); assert(!('rx' in item(t, P1, C1)) && !('mine' in item(t, P1, C1)), 'gagal dari kosong: tanpa field');
    ok('kegagalan (old, offline, busy, null, melempar): kembali persis ke keadaan lama, toast tepat, tombol terbuka lagi dan bisa dicoba lagi; dari kosong tanpa sisa field');
  }
  // F. satu permintaan per komentar + jawaban basi
  {
    const t = boot(); await openThread(t, PEER, [cmt(1), cmt(2)], null); let g; t.st.crx = new Promise((r) => { g = r; });
    cr(t, C1, '👍'); cr(t, C1, '🩷'); cr(t, C1, '👍'); assert.strictEqual(t.cc('pgCmtReact').length, 1, 'klik ganda pada satu komentar: satu permintaan');
    cr(t, C2, '👍'); assert.strictEqual(t.cc('pgCmtReact').length, 2, 'komentar lain berjalan sendiri'); g({ ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍' } }); await sleep(5);
    // layar ditutup selagi menunggu: jawaban lama dibuang
    const u = boot(); await openThread(u, PEER, [cmt(1)], null); let g2; u.st.crx = new Promise((r) => { g2 = r; }); cr(u, C1, '👍'); u.run('pgClose()'); const toasts = u.toasts.length; g2({ ok: false, code: 'offline', err: 'x' }); await sleep(5);
    assert.strictEqual(u.toasts.length, toasts, 'jawaban basi tidak memunculkan toast');
    // layar dibuka ulang: keadaan baru tak tersentuh jawaban lama
    const w = boot(); await openThread(w, PEER, [cmt(1)], null); let g3; w.st.crx = new Promise((r) => { g3 = r; }); cr(w, C1, '👍'); await openThread(w, PEER, [cmt(1)], null); g3({ ok: true, react: { rx: [{ e: '👍', n: 9 }], mine: '👍' } }); await sleep(5);
    assert(!('rx' in item(w, P1, C1)), 'layar baru tidak tersentuh jawaban lama');
    // komentar hilang selagi menunggu: tanpa galat
    const x = boot(); await openThread(x, PEER, [cmt(1), cmt(2)], null); let g4; x.st.crx = new Promise((r) => { g4 = r; }); cr(x, C1, '👍'); x.run(`pgF.cm['${P1}'].items = pgF.cm['${P1}'].items.filter((c) => c.id !== '${C1}')`); g4({ ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍' } }); await sleep(5);
    assert.deepStrictEqual(cm(x, P1).items.map((c) => c.id), [C2], 'komentar yang hilang tidak muncul lagi'); assert.deepStrictEqual(x.toasts, [], 'tanpa toast');
    ok('satu permintaan per komentar (komentar lain tidak terhalang); jawaban basi (layar ditutup / dibuka ulang) dibuang; komentar hilang selagi menunggu aman');
  }
  // G. pgCmtRxFrom + masukan cacat
  {
    const t = boot(); await openThread(t, PEER, [cmt(1), cmt(2)], { [C1]: { rx: [{ e: '👍', n: 1 }] } });
    const from = (cs) => t.run(`pgCmtRxFrom(pgF.cm['${P1}'], ${JSON.stringify(cs)})`);
    assert.strictEqual(from({ items: [cmt(1), cmt(2)], rx: { [C1]: { rx: [{ e: '👍', n: 1 }] } } }), false, 'sama = tidak ada perubahan');
    assert.strictEqual(from({ items: [cmt(1), cmt(2)], rx: { [C1]: { rx: [{ e: '👍', n: 3 }], mine: '👍' }, [C2]: { rx: [{ e: '🩷', n: 1 }] } } }), true, 'berubah = true'); assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 3 }]); assert.strictEqual(item(t, P1, C2).rx[0].e, '🩷');
    assert.strictEqual(from({ items: [cmt(1), cmt(2)], rx: {} }), true, 'yang tak disebut = tanpa reaksi'); assert(!('rx' in item(t, P1, C1)) && !('rx' in item(t, P1, C2)));
    // masukan cacat dari IPC: tidak melempar
    for (const bad of [null, undefined, {}, { items: null }, { items: [null, 5, 'x', {}, { id: 7 }], rx: { [C1]: null } }, { items: [cmt(1)], rx: { [C1]: null } }, { items: [cmt(1)], rx: { [C1]: { rx: 'x' } } }, { items: [cmt(1)], rx: 'x' }, { items: [cmt(1)], rx: [] }]) assert.doesNotThrow(() => from(bad), 'masukan cacat ' + JSON.stringify(bad));
    assert.strictEqual(t.run(`pgCmtRxFrom(null, {items: []})`), false); assert.strictEqual(t.run(`pgCmtRxFrom({ items: null }, {items: []})`), false);
    // komentar yang reaksinya sedang dikirim tidak disentuh
    const u = boot(); await openThread(u, PEER, [cmt(1)], { [C1]: { rx: [{ e: '👍', n: 1 }] } }); let g; u.st.crx = new Promise((r) => { g = r; }); cr(u, C1, '🩷');
    const mid = J(item(u, P1, C1)); u.run(`pgCmtRxFrom(pgF.cm['${P1}'], ${JSON.stringify({ items: [cmt(1)], rx: {} })})`); assert.deepStrictEqual(item(u, P1, C1), mid, 'sedang dikirim: tidak ditimpa penyegaran'); g({ ok: true, react: { rx: [{ e: '🩷', n: 1 }], mine: '🩷' } }); await sleep(5);
    // halaman orang lain: who dari jawaban dibuang; Halamanku: dipertahankan
    const w = boot(); await openThread(w, PEER, [cmt(1)], null); w.run(`pgCmtRxFrom(pgF.cm['${P1}'], ${JSON.stringify({ items: [cmt(1)], rx: { [C1]: { rx: [{ e: '👍', n: 1 }], mine: '', who: [{ e: '👍', by: [PEER] }] } } })})`); assert(!('who' in item(w, P1, C1)), 'who dibuang di halaman orang lain');
    // jawaban pemuatan: reaksi masuk lewat pgComments (utas dimuat ulang)
    const v = boot(); await openThread(v, PEER, [cmt(1)], { [C1]: { rx: [{ e: '👍', n: 1 }] } }); assert.deepStrictEqual(item(v, P1, C1).rx, [{ e: '👍', n: 1 }], 'pemuatan awal membawa reaksi'); assert.strictEqual(v.cc('pgCmtReact').length, 0, 'memuat tidak memanggil pgCmtReact');
    ok('pgCmtRxFrom: perubahan terdeteksi, yang tak disebut dibersihkan, masukan cacat tidak melempar, komentar yang sedang dikirim tidak ditimpa, who dibuang di halaman orang lain');
  }
  // H. komentar dimuat bertahap + reaksi komentar tidak mengganggu draf / balasan
  {
    const t = boot(); await openThread(t, PEER, [cmt(1)], { [C1]: { rx: [{ e: '👍', n: 1 }] } }, { next: '1700000101000:' + C1, count: 2 });
    t.st.cms = page([cmt(2)], { rx: { [C2]: { rx: [{ e: '🩷', n: 1 }] } }, count: 2 }); click(t, 'cmore', P1); await sleep(10);
    assert.deepStrictEqual(cm(t, P1).items.map((c) => c.id), [C1, C2]); assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 1 }], 'halaman berikutnya tidak menghapus reaksi halaman pertama'); assert.deepStrictEqual(item(t, P1, C2).rx, [{ e: '🩷', n: 1 }]);
    // draf dan kotak balas utuh saat reaksi dipasang
    t.els.pgmodal.h.input({ target: { dataset: { pg: 'ctxt', id: P1 }, value: 'draf saya', parentNode: null } }); t.st.crx = { ok: true, react: { rx: [{ e: '👍', n: 2 }], mine: '👍' } }; cr(t, C1, '👍'); await sleep(5);
    assert.strictEqual(cm(t, P1).draft, 'draf saya', 'draf utuh'); assert(t.H().includes('draf saya'));
    click(t, 'creply', P1, { cid: C1 }); assert.strictEqual(cm(t, P1).reply, C1); cr(t, C2, '🩷'); await sleep(5); assert.strictEqual(cm(t, P1).reply, C1, 'kotak balas tetap terbuka');
    ok('halaman komentar berikutnya membawa reaksinya sendiri tanpa menghapus yang lama; draf dan kotak balas utuh saat bereaksi');
  }
  // I. penyegaran Halamanku: hanya sesudah event rx
  {
    const t = boot(); await openThread(t, ME, [cmt(1)], { [C1]: { rx: [{ e: '👍', n: 1 }], mine: '', who: [{ e: '👍', by: [PEER] }] } });
    assert(/function pgSyncCmtRx/.test(rd('renderer/js/archne-pages-sync.js')));
    t.st.cms = page([cmt(1)], { rx: { [C1]: { rx: [{ e: '👍', n: 2 }], mine: '', who: [{ e: '👍', by: [PEER, 'b'.repeat(16)] }] } } });
    const n0 = t.cc('pgComments').length; const ch = await t.run(`pgSyncCmtRx(pgF, pgTok, '${P1}', pgF.cm['${P1}'])`);
    assert.strictEqual(ch, true, 'ada perubahan'); assert.strictEqual(t.cc('pgComments').length, n0 + 1, 'satu tarikan lokal'); assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 2 }]); assert.strictEqual(item(t, P1, C1).who[0].by.length, 2, 'who ikut diperbarui di Halamanku');
    // halaman orang lain: tidak menarik
    const o = boot(); await openThread(o, PEER, [cmt(1)], null); const n1 = o.cc('pgComments').length; assert.strictEqual(await o.run(`pgSyncCmtRx(pgF, pgTok, '${P1}', pgF.cm['${P1}'])`), false); assert.strictEqual(o.cc('pgComments').length, n1, 'halaman orang lain: tanpa tarikan jaringan');
    // gagal tarik: tanpa melempar, keadaan tak berubah
    const s = boot(); await openThread(s, ME, [cmt(1)], { [C1]: { rx: [{ e: '👍', n: 1 }] } }); s.st.cms = () => { throw new Error('putus'); }; assert.strictEqual(await s.run(`pgSyncCmtRx(pgF, pgTok, '${P1}', pgF.cm['${P1}'])`), false); assert.deepStrictEqual(item(s, P1, C1).rx, [{ e: '👍', n: 1 }]);
    ok('penyegaran Halamanku: satu tarikan lokal menerapkan reaksi + who; halaman orang lain tanpa jaringan; gagal tarik tidak melempar dan tidak mengubah apa pun');
  }
  // J. sinkron otomatis di halaman ORANG LAIN: reaksi komentar menyegar lewat tarikan utas yang sudah ada (satu permintaan per utas per siklus)
  {
    const sync = (t) => t.run('pgSyncNow()');
    const t = boot(); await openThread(t, PEER, [cmt(1), cmt(2)], { [C1]: { rx: [{ e: '👍', n: 1 }] } });
    t.st.cms = page([cmt(1), cmt(2), cmt(3)], { rx: { [C1]: { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '🩷' }, [C2]: { rx: [{ e: '🥺', n: 1 }] } } });
    const n0 = t.cc('pgComments').length; await sync(t);
    const calls = t.cc('pgComments').slice(n0); assert.strictEqual(calls.length, 1, 'satu permintaan komentar per utas per siklus'); assert(!('after' in calls[0][3]), 'utas kecil ditarik dari awal (jawaban memuat reaksi semua komentar)');
    assert.deepStrictEqual(item(t, P1, C1).rx, [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], 'reaksi komentar lama ikut menyegar'); assert.strictEqual(item(t, P1, C1).mine, '🩷'); assert.deepStrictEqual(item(t, P1, C2).rx, [{ e: '🥺', n: 1 }]);
    assert.deepStrictEqual(cm(t, P1).items.map((c) => c.id), [C1, C2, C3], 'komentar baru tetap masuk, tanpa ganda'); assert(t.H().includes('aria-label="Reaksi 🩷, 1 orang"'), 'tampilan ikut berubah');
    // reaksi dicabut orang lain: hilang dari tampilan
    t.st.cms = page([cmt(1), cmt(2), cmt(3)], { rx: { [C2]: { rx: [{ e: '🥺', n: 1 }] } } }); await sync(t); assert(!('rx' in item(t, P1, C1)) && !('mine' in item(t, P1, C1)), 'reaksi yang hilang di pemilik ikut hilang');
    // reaksiku yang sedang dikirim tidak ditimpa penyegaran
    let g; t.st.crx = new Promise((r) => { g = r; }); cr(t, C2, '👍'); const mid = J(item(t, P1, C2)); t.st.cms = page([cmt(1), cmt(2), cmt(3)], {}); await sync(t); assert.deepStrictEqual(item(t, P1, C2), mid, 'sedang dikirim: tidak ditimpa'); g({ ok: true, react: { rx: [{ e: '👍', n: 1 }, { e: '🥺', n: 1 }], mine: '👍' } }); await sleep(5);
    // utas besar (>= 100): tetap memakai kursor, tanpa tarikan tambahan
    const big = Array.from({ length: 100 }, (_, i) => cmt(i + 1)); const b = boot(); await openThread(b, PEER, big, null); b.st.cms = page(big, {}); const nb = b.cc('pgComments').length; await sync(b);
    const cb = b.cc('pgComments').slice(nb); assert.strictEqual(cb.length, 1, 'utas besar: tetap satu permintaan'); assert(cb[0][3].after, 'utas besar: kursor dipakai');
    // Halamanku tidak memakai jalur ini (pakai event rx)
    const m = boot(); await openThread(m, ME, [cmt(1)], null); m.st.cms = page([cmt(1)], {}); const nm = m.cc('pgComments').length; await sync(m); assert(m.cc('pgComments').slice(nm).every((c) => c[3].after), 'Halamanku: tetap memakai kursor (reaksi lewat event rx)');
    ok('sinkron halaman orang lain: reaksi komentar (baru, berubah, dicabut) menyegar dalam satu permintaan per utas; yang sedang dikirim tidak ditimpa; utas besar dan Halamanku tetap memakai kursor');
  }
  console.log('\n' + pass + ' kelompok lulus');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
