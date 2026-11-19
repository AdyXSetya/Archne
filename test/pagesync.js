'use strict';
// Tes 5d-8: komentar dan reaksi baru muncul di layar Halaman yang sedang terbuka (renderer/js/archne-pages-sync.js + event lokal 'pgact').
// A: Core mengirim 'pgact' hanya saat benar-benar ada komentar / reaksi baru; IPC meneruskan { postId, kind } tanpa teks dan tanpa id penulis; event cacat tidak disiarkan.
// B: renderer (vm): Halamanku sinkron lewat event; (B5-B7: postingan dan komentar yang dihapus hilang, lebih dari 50 postingan baru disambung / dimuat ulang); halaman orang lain lewat siklus berkala; reaksi, postingan baru, komentar baru + hitungan; yang sedang berjalan tidak ditimpa; berhenti saat ditutup.
const os = require('os'), path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert'), crypto = require('crypto');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { cmtSign } = require('../src/archne-pagecmt');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagesync-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX = (c) => c.repeat(16);

(async () => {
  // ---- A. Core + IPC ----
  const A = new Core({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'A-dl'), name: 'A', discovery: false });
  await A.start();
  const h = {}, sent = [];
  register({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core: A, send: (ch, p) => sent.push([ch, p]), log: () => {} });
  const acts = () => sent.filter((x) => x[0] === 'pgact').map((x) => x[1]);
  const ps = A.pageStore(), post = ps.create({ text: 'halo', priv: 'public' });
  const k = crypto.generateKeyPairSync('ed25519'), pub = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const rid = HEX('b');
  // reaksi
  const rx = A._pgRxHandle({ id: post.id, e: '👍' }, rid);
  assert(rx.ok && rx.r, 'reaksi diterima');
  assert.deepStrictEqual(acts(), [{ postId: post.id, kind: 'rx' }]);
  A._pgRxHandle({ id: HEX('f'), e: '👍' }, rid); // postingan tak ada: r null, tanpa event
  A._pgRxHandle({ id: post.id, e: 'bukan emoji panjang sekali xxxxxxxxxxxxxxxxxxxxxxxxxxx' }, rid); // tak sah
  assert.strictEqual(acts().length, 1, 'tanpa event untuk yang gagal');
  // komentar
  const by = crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16);
  void by;
  const c = cmtSign(k.privateKey, pub, A.id, post.id, 'komentar satu', Date.now() - 1000);
  const r1 = A._pgCmtHandle({ t: 'pg_cmt', id: post.id, c }, c.by);
  assert(r1.ok && r1.r === 'added', 'komentar ditambah: ' + JSON.stringify(r1));
  assert.deepStrictEqual(acts()[1], { postId: post.id, kind: 'cmt' });
  assert(!JSON.stringify(acts()).includes('komentar satu') && !JSON.stringify(acts()).includes(c.by), 'tanpa teks dan tanpa id penulis');
  const r2 = A._pgCmtHandle({ t: 'pg_cmt', id: post.id, c }, c.by); // kirim ulang yang sama: 'same'
  assert(r2.ok && r2.r === 'same'); assert.strictEqual(acts().length, 2, "'same' tidak memicu event");
  ok('Core: event pgact hanya untuk reaksi / komentar yang benar-benar baru; IPC meneruskan { postId, kind } tanpa teks / penulis');
  for (const bad of [null, 5, {}, { post: 'xyz', kind: 'cmt' }, { post: post.id, kind: 'lain' }, { post: post.id }]) A.emit('pgact', bad);
  assert.strictEqual(acts().length, 2, 'event cacat tidak disiarkan');
  ok('IPC: event cacat tidak disiarkan');

  // ---- B. renderer ----
  const ME = HEX('1'), PEER = HEX('a');
  const P = (n, o) => Object.assign({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public' }, o || {});
  const C = (n, o) => Object.assign({ id: 'c' + n.toString(16).padStart(15, '0'), by: PEER, ts: 1700000100000 + n * 1000, text: 'k' + n }, o || {});
  function boot() {
    const els = {}, calls = [], st = { list: null, mine: null, cms: null }, tm = { ints: [], tos: [] };
    const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, h: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener(t, f) { this.h[t] = f; }, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
    const val = (r, ...a) => (typeof r === 'function' ? r(...a) : r);
    let onAct = null;
    const api = {
      pgList: async (...a) => { calls.push(['pgList', ...a]); return val(st.list, ...a); },
      pgMine: async (...a) => { calls.push(['pgMine', ...a]); return val(st.mine, ...a); },
      pgComments: async (...a) => { calls.push(['pgComments', ...a]); return val(st.cms, ...a); },
      onPgDl: () => {}, onPgAct: (cb) => { onAct = cb; },
    };
    const E = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ctx = { S: { me: { id: ME }, messages: [] }, esc: E, nameOf: (i) => 'nama-' + String(i).slice(0, 2), $: el, linkHtml: E, fmt: String, dayLabel: () => 'Hari ini', hm: () => '10:00', toast() {}, ask: async () => true,
      renderProfile() {}, document: { addEventListener() {}, activeElement: null }, Date, Promise, Set, JSON, setTimeout: (f, ms) => { const t = { f, ms }; tm.tos.push(t); return t; }, clearTimeout: (t) => { const i = tm.tos.indexOf(t); if (i >= 0) tm.tos.splice(i, 1); },
      setInterval: (f, ms) => { const t = { f, ms }; tm.ints.push(t); return t; }, clearInterval: (t) => { const i = tm.ints.indexOf(t); if (i >= 0) tm.ints.splice(i, 1); },
      window: { api, history: { pushState() {}, back() {} }, location: { protocol: 'file:', pathname: '/archne-index.html' } }, profId: PEER };
    vm.createContext(ctx);
    vm.runInContext(rd('renderer/archne-filecard.js'), ctx);
    vm.runInContext(require('./_src').pagesJs(), ctx);
    const run = (c) => vm.runInContext(c, ctx);
    const flush = async () => { for (let i = 0; i < 5; i++) { for (const t of tm.tos.splice(0)) t.f(); await sleep(5); } }; // jalankan timer tertunda (400 ms) tanpa menunggu
    return { els, calls, st, tm, run, ctx, fire: (e) => onAct && onAct(e), flush, H: () => els.pglist.innerHTML, n: (x) => calls.filter((c) => c[0] === x).length };
  }
  const items = (...ps) => ({ ok: true, items: ps, next: null, count: ps.length, skipped: 0 });

  // B1. Halamanku: event -> reaksi baru + who muncul tanpa tutup-buka; event cacat / halaman orang lain diabaikan
  {
    const t = boot(), a = P(1), b = P(2);
    t.st.mine = items(b, a); t.run(`pgOpen('${ME}')`); await sleep(15);
    assert(!t.H().includes('data-e="🩷"'), 'belum ada reaksi 🩷');
    assert.strictEqual(t.tm.ints.length, 1, 'siklus berkala terpasang'); assert.strictEqual(t.tm.ints[0].ms, 20000);
    t.st.mine = items(Object.assign({}, b, { rx: [{ e: '🩷', n: 2 }], mine: undefined, who: [{ e: '🩷', by: [PEER] }] }), a);
    t.fire({ postId: b.id, kind: 'rx' }); t.fire({ postId: b.id, kind: 'rx' }); t.fire({ postId: 'x', kind: 'rx' }); t.fire(null);
    assert.strictEqual(t.tm.tos.length, 1, 'banyak event digabung jadi satu penjadwalan');
    const before = t.n('pgMine'); await t.flush();
    assert.strictEqual(t.n('pgMine') - before, 1, 'satu muat ulang untuk dua event sah');
    assert(t.H().includes('data-e="🩷"') && t.H().includes('<b>2</b>'), 'reaksi baru tampil: ' + t.H().slice(0, 100));
    ok('Halamanku: event pgact -> reaksi baru tampil tanpa tutup-buka; digabung; event cacat diabaikan');
    t.run('pgClose()');
    assert.strictEqual(t.tm.ints.length, 0, 'siklus berhenti saat ditutup'); assert.strictEqual(t.tm.tos.length, 0);
  }

  // B2. halaman orang lain: tidak ada event, tetapi siklus 20 dtk menarik reaksi + postingan baru di atas; event 'pgact' diabaikan di sana
  {
    const t = boot(), a = P(1), b = P(2), c = P(3);
    t.st.list = items(b, a); t.run(`pgOpen('${PEER}')`); await sleep(15);
    t.st.list = items(c, Object.assign({}, b, { rx: [{ e: '👍', n: 1 }], mine: '👍' }), a);
    t.fire({ postId: b.id, kind: 'cmt' }); assert.strictEqual(t.tm.tos.length, 0, 'event lokal tidak berarti di halaman orang');
    const n0 = t.n('pgList'); t.tm.ints[0].f(); await sleep(15);
    assert.strictEqual(t.n('pgList') - n0, 1);
    const ids = JSON.parse(t.run('JSON.stringify(pgF.items.map((p) => p.id))'));
    assert.deepStrictEqual(ids, [c.id, b.id, a.id], 'postingan baru di atas, tanpa ganda');
    assert(t.H().includes('aria-pressed="true"') && t.H().includes('isi 3'), 'reaksiku dan postingan baru tampil');
    t.tm.ints[0].f(); await sleep(15); assert.strictEqual(JSON.parse(t.run('JSON.stringify(pgF.items.length)')), 3, 'siklus berikutnya tanpa perubahan: tetap 3');
    ok('halaman orang lain: siklus berkala menarik reaksi dan postingan baru (di atas, tanpa ganda)');
  }

  // B3. komentar: utas terbuka dan termuat penuh -> hanya yang lebih baru (kursor ts:id), hitungan naik; utas dengan halaman belum dimuat: hanya hitungan
  {
    const t = boot(), a = P(1), c1 = C(1), c2 = C(2);
    t.st.mine = items(a); t.st.cms = { ok: true, comments: { items: [c1], next: null, count: 1, skipped: 0 } };
    t.run(`pgOpen('${ME}')`); await sleep(15);
    t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'cmt', id: a.id } }) } }); await sleep(15);
    assert(t.H().includes('k1') && t.H().includes('aria-label="Komentar (1)"'));
    t.st.cms = (pid, id, o) => ({ ok: true, comments: { items: o.after ? [c2] : [c1, c2], next: null, count: 2, skipped: 0 } });
    t.fire({ postId: a.id, kind: 'cmt' }); await t.flush();
    const last = JSON.parse(JSON.stringify(t.calls.filter((c) => c[0] === 'pgComments').pop()));
    assert.strictEqual(last[3].after, c1.ts + ':' + c1.id, 'hanya yang lebih baru dari komentar terakhir (kursor)');
    assert(t.H().includes('k2') && t.H().includes('k1') && t.H().includes('Komentar (2)'), 'komentar baru + hitungan tampil');
    // utas dengan halaman belum dimuat (next terisi): hanya hitungan, tidak menyisipkan di tengah urutan
    t.run(`pgF.cm['${a.id}'].next = 'x'`); const cc = t.calls.length;
    t.st.cms = (pid, id, o) => ({ ok: true, comments: { items: [C(9)], next: null, count: 5, skipped: 0 } });
    t.fire({ postId: a.id, kind: 'cmt' }); await t.flush();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(t.calls.slice(cc).filter((c) => c[0] === 'pgComments').map((c) => c[3]))), [{ limit: 1 }]);
    assert(t.H().includes('Komentar (5)') && !t.H().includes('k9'), 'hitungan naik, komentar di luar halaman termuat tidak disisipkan');
    ok('komentar: utas penuh mengambil hanya yang lebih baru (kursor) dan hitungan; utas sebagian hanya hitungan');
  }

  // B4. tidak menimpa yang sedang berjalan; galat sesaat diam; layar ditutup di tengah = hasil dibuang; tersembunyi = lewati
  {
    const t = boot(), a = P(1);
    t.st.mine = items(a); t.run(`pgOpen('${ME}')`); await sleep(15);
    t.st.mine = items(Object.assign({}, a, { rx: [{ e: '👍', n: 3 }] }));
    t.run(`pgF.rxb = { '${a.id}': true }`); const n0 = t.n('pgMine'); t.fire({ postId: a.id, kind: 'rx' }); await t.flush();
    assert(!t.H().includes('<b>3</b>'), 'reaksi yang sedang dikirim tidak ditimpa');
    t.run('pgF.rxb = {}');
    t.st.mine = { ok: false, code: 'offline' }; t.fire({ postId: a.id, kind: 'rx' }); await t.flush(); assert(!t.H().includes('pgerr'), 'galat sesaat: diam');
    // ditutup selagi menunggu
    let rel; t.st.mine = () => new Promise((r) => { rel = r; });
    t.fire({ postId: a.id, kind: 'rx' }); await t.flush(); t.run('pgClose()'); rel(items(Object.assign({}, a, { rx: [{ e: '👍', n: 9 }] }))); await sleep(10);
    assert.strictEqual(t.run('pgF'), null); assert.strictEqual(t.tm.ints.length, 0);
    // jendela tersembunyi: lewati
    const u = boot(); u.st.mine = items(P(1)); u.run(`pgOpen('${ME}')`); await sleep(15);
    u.ctx.document.hidden = true; const c0 = u.n('pgMine'); u.tm.ints[0].f(); await sleep(10); assert.strictEqual(u.n('pgMine'), c0, 'tersembunyi: tidak menarik');
    ok('tidak menimpa reaksi yang sedang dikirim; galat sesaat diam; ditutup di tengah = dibuang; jendela tersembunyi dilewati');
  }

  // B5. postingan yang dihapus pemilik hilang dari layar (rentang yang dicakup daftar saja); yang kubuat selama menunggu tidak ikut hilang; komentar / keadaan postingan itu dibuang
  {
    const t = boot(), a = P(1), b = P(2), c = P(3);
    t.st.list = items(c, b, a); t.run(`pgOpen('${PEER}')`); await sleep(15);
    t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'cmt', id: b.id } }) } }); await sleep(15);
    t.st.list = items(c, a); t.tm.ints[0].f(); await sleep(20);
    assert.deepStrictEqual(JSON.parse(t.run('JSON.stringify(pgF.items.map((p) => p.id))')), [c.id, a.id], 'b dihapus pemilik: hilang');
    assert(!t.H().includes('isi 2') && t.H().includes('isi 3') && t.H().includes('isi 1'));
    assert.strictEqual(t.run(`pgF.ids.has('${b.id}') || !!pgF.cm['${b.id}'] || pgF.open.has('${b.id}')`), false, 'id, utas komentar, dan lipatan b dibersihkan');
    assert(t.H().includes('2 postingan') || t.els.pgcount.textContent === '2 postingan', 'hitungan ikut turun');
    // daftar terpotong (next terisi): hanya yang di dalam rentang dicakup yang dianggap hilang; yang lebih tua dari halaman ini tak disentuh
    const u = boot(), p1 = P(1), p2 = P(2), p3 = P(3), p4 = P(4);
    u.st.mine = items(p4, p3, p2, p1); u.run(`pgOpen('${ME}')`); await sleep(15);
    u.st.mine = { ok: true, items: [p4, p2], next: 'x:y', count: 4, skipped: 0 }; // p3 hilang di dalam rentang; p1 lebih tua dari halaman ini
    u.tm.ints[0].f(); await sleep(20);
    assert.deepStrictEqual(JSON.parse(u.run('JSON.stringify(pgF.items.map((p) => p.id))')), [p4.id, p2.id, p1.id], 'p3 hilang, p1 (di luar rentang) tetap');
    // postingan yang kubuat selama penarikan berjalan bukan "terhapus"
    const v = boot(), q1 = P(1); v.st.mine = items(q1); v.run(`pgOpen('${ME}')`); await sleep(15);
    let rel; v.st.mine = () => new Promise((r) => { rel = r; }); v.tm.ints[0].f(); await sleep(5);
    const mineNew = P(7, { priv: 'public' }); v.run(`pgF.ids.add('${mineNew.id}'); pgF.items.unshift(${JSON.stringify(mineNew)})`);
    rel(items(q1)); await sleep(20);
    assert.deepStrictEqual(JSON.parse(v.run('JSON.stringify(pgF.items.map((p) => p.id))')), [mineNew.id, q1.id], 'yang baru kubuat tetap ada');
    // semua dihapus (tanpa halaman berikutnya)
    const w = boot(); w.st.list = items(P(1), P(2)); w.run(`pgOpen('${PEER}')`); await sleep(15); w.st.list = items(); w.tm.ints[0].f(); await sleep(20);
    assert.strictEqual(JSON.parse(w.run('JSON.stringify(pgF.items.length)')), 0); assert(w.H() === '' || !w.H().includes('isi '));
    ok('postingan yang dihapus pemilik hilang (di dalam rentang daftar saja); yang baru kubuat tak ikut hilang; utas dan lipatannya dibersihkan');
  }

  // B6. lebih dari 50 postingan baru sekaligus: disambung lewat kursor; terlalu banyak = muat ulang dari atas
  {
    const old1 = P(1), old2 = P(2), mk = (from, n) => Array.from({ length: n }, (_, i) => P(from + n - 1 - i)); // terbaru dulu
    const t = boot(); t.st.list = items(old2, old1); t.run(`pgOpen('${PEER}')`); await sleep(15);
    const fresh = mk(100, 70); // 70 baru: p169 .. p100
    t.st.list = (id, o) => (o && o.after === 'c1' ? { ok: true, items: fresh.slice(50).concat([old2, old1]), next: null, count: 72, skipped: 0 } : { ok: true, items: fresh.slice(0, 50), next: 'c1', count: 72, skipped: 0 });
    const n0 = t.n('pgList'); t.tm.ints[0].f(); await sleep(30);
    assert.strictEqual(t.n('pgList') - n0, 2, 'dua halaman ditarik untuk menyambung celah');
    const ids = JSON.parse(t.run('JSON.stringify(pgF.items.map((p) => p.id))'));
    assert.strictEqual(ids.length, 72); assert.deepStrictEqual(ids.slice(0, 70), fresh.map((p) => p.id), 'urutan terbaru dulu, tanpa ganda'); assert.deepStrictEqual(ids.slice(70), [old2.id, old1.id]);
    // terlalu banyak (tak ketemu setelah PG_SYNC_PAGES halaman) = muat ulang dari atas
    const u = boot(); u.st.list = items(old2, old1); u.run(`pgOpen('${PEER}')`); await sleep(15);
    let pages = 0; u.st.list = (id, o) => { pages++; return { ok: true, items: mk(1000 + pages * 50, 50), next: 'n' + pages, count: 999, skipped: 0 }; };
    u.tm.ints[0].f(); await sleep(40);
    assert(pages >= 7, 'menyambung sampai batas lalu memuat ulang: ' + pages);
    assert(!JSON.parse(u.run('JSON.stringify(pgF.items.some((p) => p.id === "' + old1.id + '"))')), 'daftar lama dibuang');
    assert(JSON.parse(u.run('JSON.stringify(pgF.items.length)')) > 0 && u.run('pgF.loaded') === true, 'dimuat ulang dari atas');
    // galat di tengah penyambungan: tidak ada yang diubah
    const w = boot(); w.st.list = items(old2, old1); w.run(`pgOpen('${PEER}')`); await sleep(15);
    w.st.list = (id, o) => (o && o.after ? { ok: false, code: 'offline' } : { ok: true, items: mk(100, 50), next: 'c1', count: 52, skipped: 0 });
    w.tm.ints[0].f(); await sleep(20); assert.deepStrictEqual(JSON.parse(w.run('JSON.stringify(pgF.items.map((p) => p.id))')), [old2.id, old1.id], 'galat sesaat: daftar tak berubah');
    ok('lebih dari 50 postingan baru: disambung lewat kursor tanpa ganda; terlalu banyak = muat ulang dari atas; galat di tengah = tak berubah');
  }

  // B7. komentar yang dihapus hilang dari utas yang terbuka (utas penuh dan utas sebagian); tidak memuat ulang berulang untuk hitungan yang sama
  {
    const a = P(1), c1 = C(1), c2 = C(2), c3 = C(3);
    const open = async (t) => { t.run(`pgOpen('${ME}')`); await sleep(15); t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'cmt', id: a.id } }) } }); await sleep(15); };
    const t = boot(); t.st.mine = items(a); t.st.cms = { ok: true, comments: { items: [c1, c2, c3], next: null, count: 3, skipped: 0 } }; await open(t);
    assert(t.H().includes('k2'));
    t.st.cms = (pid, id, o) => ({ ok: true, comments: { items: o.after ? [] : [c1, c3], next: null, count: 2, skipped: 0 } }); // c2 dihapus
    t.fire({ postId: a.id, kind: 'cmt' }); await t.flush();
    assert(!t.H().includes('k2<') && t.H().includes('k1') && t.H().includes('k3'), 'k2 hilang dari layar');
    assert(t.H().includes('aria-label="Komentar (2)"'), 'hitungan 2');
    assert.deepStrictEqual(JSON.parse(t.run(`JSON.stringify(pgF.cm['${a.id}'].items.map((c) => c.id))`)), [c1.id, c3.id]);
    const n0 = t.n('pgComments'); t.fire({ postId: a.id, kind: 'cmt' }); await t.flush();
    assert.strictEqual(t.n('pgComments') - n0, 1, 'hitungan sama: tidak memuat ulang lagi (hanya satu tarikan kursor)');
    // hapus + tambah sekaligus (hitungan tetap): terdeteksi dari jumlah yang kupegang
    const c4 = C(4);
    t.st.cms = (pid, id, o) => ({ ok: true, comments: { items: o.after ? [c4] : [c1, c4], next: null, count: 2, skipped: 0 } }); // c3 dihapus, c4 datang
    t.fire({ postId: a.id, kind: 'cmt' }); await t.flush();
    assert(!t.H().includes('k3<') && t.H().includes('k4'), 'k3 hilang, k4 tampil');
    // utas sebagian (next terisi): hitungan turun = muat ulang rentang yang termuat
    const u = boot(); u.st.mine = items(a); u.st.cms = { ok: true, comments: { items: [c1, c2], next: 'x:y', count: 5, skipped: 0 } }; await open(u);
    u.st.cms = (pid, id, o) => (o.limit === 1 ? { ok: true, comments: { items: [c1], next: 'z', count: 4, skipped: 0 } } : { ok: true, comments: { items: [c1, c3], next: 'x:y', count: 4, skipped: 0 } });
    u.fire({ postId: a.id, kind: 'cmt' }); await u.flush();
    assert(!u.H().includes('k2<') && u.H().includes('k3') && u.H().includes('Muat komentar lagi'), 'rentang termuat disusun ulang, tombol muat lagi tetap');
    // galat saat memuat ulang: utas dibiarkan
    const w = boot(); w.st.mine = items(a); w.st.cms = { ok: true, comments: { items: [c1, c2], next: null, count: 2, skipped: 0 } }; await open(w);
    w.st.cms = (pid, id, o) => (o.after ? { ok: true, comments: { items: [], next: null, count: 1, skipped: 0 } } : { ok: false, code: 'offline' });
    w.fire({ postId: a.id, kind: 'cmt' }); await w.flush(); assert(w.H().includes('k2'), 'gagal memuat ulang: utas tak berubah');
    ok('komentar yang dihapus hilang dari utas terbuka (penuh dan sebagian, juga hapus + tambah sekaligus); tak berulang untuk hitungan yang sama; galat = utas dibiarkan');
  }

  // C. statis: preload + api-http + archne-index.html
  {
    assert(/onPgAct:[^\n]*'pgact'/.test(rd('preload.js')));
    const ah = rd('renderer', 'archne-api-http.js'); assert(/addEventListener\('pgact'/.test(ah) && /api\.onPgAct = /.test(ah) && /pgact: \[\]/.test(ah));
    const idx = rd('renderer', 'archne-index.html'); assert(idx.indexOf('js/archne-pages-arc.js') < idx.indexOf('js/archne-pages-sync.js') && idx.indexOf('js/archne-pages-sync.js') < idx.indexOf('js/archne-voice-channel.js'));
    ok('preload, api-http (SSE), dan urutan muat archne-index.html');
  }
  console.log(pass + ' tes lulus');
  try { await A.stop(); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
