'use strict';
// Tes UI Halaman 5d-6: panel "Cadangan" di Halamanku (renderer/js/archne-pages-arc.js + sambungan di archne-pages.js), skrip asli di vm dengan stub kecil (pola test/pageui.js).
// Yang dicek: statis (urutan skrip, kanal di preload / api-http), tombol hanya bila canArchive, alur ekspor (dialog batal, progres, ringkasan, galat), alur impor (pratinjau, komentar mengikuti identitas,
// konfirmasi, muat ulang feed), pembatalan, event pekerjaan lain diabaikan, keadaan menyusul saat layar dibuka lagi, dan semua teks dari luar di-escape.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = '1'.repeat(16), JOB = 'a'.repeat(16), JOB2 = 'b'.repeat(16), TOK = 'c'.repeat(16);
const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mk(opt) {
  opt = opt || {};
  const els = {}, calls = [], toasts = [];
  const el = (id) => els[id] || (els[id] = { style: {}, innerHTML: '', textContent: '', hidden: false, addEventListener(t, f) { (this.h = this.h || {})[t] = f; }, classList: { add() {}, remove() {}, toggle() {} } });
  const api = {
    getSettings: async () => (opt.settings || { ok: true, canArchive: true }),
    pgMine: async (o) => { calls.push(['pgMine', o]); return { ok: true, items: [], next: null, count: 0 }; },
    pgArcState: async () => (opt.state || { ok: true, run: null }),
    onPgArc: (cb) => { api.cb = cb; },
  };
  for (const n of ['pgArcExport', 'pgArcOpen', 'pgArcImport', 'pgArcCancel']) api[n] = async (...a) => { calls.push([n, ...JSON.parse(JSON.stringify(a))]); return api['ret_' + n] ? api['ret_' + n](...a) : { ok: true }; };
  const ctx = { S: { me: { id: ME } }, esc: escH, nameOf: () => 'N', $: el, renderProfile: () => {}, document: { addEventListener() {} }, Date, Promise, setTimeout, JSON,
    dayLabel: () => 'Hari ini', hm: () => '10:00', linkHtml: (t) => t, fmt: (n) => String(n), toast: (m) => toasts.push(m), ask: async () => true, FileCard: require('../renderer/archne-filecard'), window: { api } };
  Object.defineProperty(ctx, 'profId', { get: () => null });
  vm.createContext(ctx); vm.runInContext(require('./_src').pagesJs(), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  const click = (a) => els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: a } }) } });
  const open = async () => { run(`pgOpen('${ME}')`); await sleep(20); };
  const ev = (o) => api.cb(o);
  return { els, calls, toasts, api, ctx, run, click, open, ev, box: () => els.pgarc.innerHTML };
}
const sum = (o) => Object.assign({
  name: 'cadangan.archpg', size: 5000, created: 1700000000000, ownerMatch: true, counts: { total: 5, new: 3, same: 1, conflict: 1, bad: 0 }, why: { conflict: { id: 1 }, bad: {} },
  blobs: { new: 2, reuse: 0, bytesNew: 4096 }, extra: 0, comments: { status: 'ok', present: true, restorable: true, items: 4, tombs: 1, plan: { status: 'ok', added: 4, tombAdded: 1 } },
}, o || {});

(async () => {
  // A. statis
  const idx = rd('renderer/archne-index.html'), http = rd('renderer/archne-api-http.js'), pre = rd('preload.js'), main = rd('main.js'), css = rd('renderer/css/archne-pages.css');
  assert(idx.indexOf('js/archne-pages-cmt.js') < idx.indexOf('js/archne-pages-arc.js') && idx.indexOf('js/archne-pages-arc.js') < idx.indexOf('js/archne-voice-channel.js'));
  for (const n of ['pgArcExport', 'pgArcOpen', 'pgArcImport', 'pgArcCancel', 'pgArcState']) assert(http.includes("'" + n + "'") && pre.includes(n + ':'), n + ' ada di api-http dan preload');
  assert(pre.includes("onPgArc: (cb) => ipcRenderer.on('pgarc'") && http.includes("addEventListener('pgarc'") && http.includes('api.onPgArc = '));
  assert(main.includes('pickSave') && main.includes('pickArc') && css.includes('.pgarc'));
  ok('statis: urutan skrip, kanal pgArc* di api-http + preload, dialog di main.js, css');

  // B. tombol hanya bila canArchive; hanya di Halamanku
  {
    const t = mk(); await t.open();
    assert(t.els.pgbody.innerHTML.includes('id="pgarcbtn"') && t.els.pgbody.innerHTML.includes('id="pgarc"'));
    await sleep(20); assert.strictEqual(t.els.pgarcbtn.hidden, false, 'canArchive: tombol tampil'); assert.strictEqual(t.els.pgarc.hidden, true, 'panel tertutup bawaan');
    t.click('arc'); assert.strictEqual(t.els.pgarc.hidden, false); assert(/Ekspor…/.test(t.box()) && /Impor…/.test(t.box()) && t.box().includes('id="pgarccm"'));
    t.click('arc'); assert.strictEqual(t.els.pgarc.hidden, true, 'ketuk lagi menutup');
    const n = mk({ settings: { ok: true, canArchive: false } }); await n.open(); await sleep(20);
    assert.strictEqual(n.els.pgarcbtn.hidden, true, 'tanpa dialog (Android): tombol tersembunyi'); n.click('arc'); assert.strictEqual(n.els.pgarc.hidden, true);
    const o = mk({ settings: { ok: true } }); await o.open(); await sleep(20); assert.strictEqual(o.els.pgarcbtn.hidden, true, 'inti lama tanpa flag: tersembunyi');
    const other = mk(); other.run("pgOpen('" + 'a'.repeat(16) + "')"); await sleep(20);
    assert(!other.els.pgbody.innerHTML.includes('pgarc'), 'halaman orang lain: tanpa cadangan');
  }
  ok('tombol Cadangan hanya di Halamanku dan hanya bila canArchive; panel membuka / menutup');

  // C. ekspor
  {
    const t = mk(); await t.open(); await sleep(20); t.click('arc');
    t.api.ret_pgArcExport = async () => ({ ok: true, job: null }); t.click('arcexp'); await sleep(10);
    assert.strictEqual(t.run('pgArcS.phase'), 'idle', 'dialog dibatalkan: kembali idle'); assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'pgArcExport')[0].slice(1), [{ comments: false }]);
    t.api.ret_pgArcExport = async () => ({ ok: false, err: 'x', code: 'busy' }); t.click('arcexp'); await sleep(10);
    assert.strictEqual(t.run('pgArcS.phase'), 'idle'); assert(/sedang berjalan/.test(t.toasts[t.toasts.length - 1]), 'busy: pesan ramah');
    t.els.pgarccm = { checked: true }; t.api.ret_pgArcExport = async () => ({ ok: true, job: JOB, name: 'cadangan.archpg' }); t.click('arcexp'); await sleep(10);
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'pgArcExport').pop().slice(1), [{ comments: true }], 'kotak komentar dicentang diteruskan');
    assert.strictEqual(t.run('pgArcS.phase'), 'running'); assert(/Mengekspor/.test(t.box()) && t.box().includes('data-pg="arccancel"') && !/disabled/.test(t.box().split('arccancel')[1].slice(0, 12)));
    t.ev({ job: JOB2, kind: 'export', phase: 'progress', posts: 9, total: 9, bytes: 1, totalBytes: 1 }); assert(!/9 \/ 9/.test(t.box()), 'pekerjaan lain diabaikan');
    t.ev({ job: JOB, kind: 'export', phase: 'progress', posts: 2, total: 4, bytes: 512, totalBytes: 1024 });
    assert(/2 \/ 4 postingan/.test(t.box()) && t.box().includes('width:50%'), 'progres: jumlah dan lebar bar');
    t.ev({ job: JOB, kind: 'export', phase: 'done', result: { name: 'cadangan.archpg', size: 2048, posts: 4, media: 1, files: 2, videos: 0, bytes: 900, skipped: 1, skippedWhy: { missing: 1 }, comments: { items: 3, tombs: 1 } } });
    assert.strictEqual(t.run('pgArcS.phase'), 'done'); assert(/Selesai: 4 postingan, 1 gambar, 2 lampiran, 0 video/.test(t.box()) && t.box().includes('cadangan.archpg') && /1 postingan dilewati/.test(t.box()) && /Komentar ikut: 3 komentar, 1 penghapusan/.test(t.box()));
    t.click('arcok'); assert.strictEqual(t.run('pgArcS.phase'), 'idle'); assert(/Ekspor…/.test(t.box()));
    // galat di tengah jalan
    t.api.ret_pgArcExport = async () => ({ ok: true, job: JOB2, name: 'b.archpg' }); t.click('arcexp'); await sleep(10);
    t.ev({ job: JOB2, kind: 'export', phase: 'error', err: 'Penyimpanan penuh', code: 'ENOSPC' });
    assert.strictEqual(t.run('pgArcS.phase'), 'error'); assert(t.box().includes('Penyimpanan penuh') && t.box().includes('role="alert"')); t.click('arcok'); assert.strictEqual(t.run('pgArcS.phase'), 'idle');
  }
  ok('ekspor: dialog batal, busy, opsi komentar, progres (pekerjaan lain diabaikan), ringkasan, galat');

  // D. impor: pratinjau, komentar mengikuti identitas, konfirmasi, muat ulang feed
  {
    const t = mk(); await t.open(); await sleep(20); t.click('arc');
    t.api.ret_pgArcOpen = async () => ({ ok: true, token: null }); t.click('arcimp'); await sleep(10); assert.strictEqual(t.run('pgArcS.phase'), 'idle', 'dialog dibatalkan');
    t.api.ret_pgArcOpen = async () => ({ ok: false, err: 'bukan arsip halaman', code: 'bad' }); t.click('arcimp'); await sleep(10);
    assert.strictEqual(t.run('pgArcS.phase'), 'error'); assert(t.box().includes('bukan arsip Halaman yang sah')); t.click('arcok');
    // identitas sama: pratinjau lengkap + kotak komentar; matikan komentar
    t.api.ret_pgArcOpen = async () => ({ ok: true, token: TOK, name: 'cadangan.archpg', summary: sum() }); t.click('arcimp'); await sleep(10);
    assert.strictEqual(t.run('pgArcS.phase'), 'preview');
    let b = t.box(); assert(/5 postingan di arsip: <b>3 baru<\/b>, 1 sudah ada, 1 bentrok/.test(b) && b.includes('Lampiran baru: 2') && b.includes('id="pgarccmi"') && /4 komentar, 1 penghapusan; 4 akan ditambahkan/.test(b) && /Impor 3 postingan/.test(b));
    const before = t.calls.filter((c) => c[0] === 'pgMine').length;
    t.els.pgarccmi = { checked: false }; t.api.ret_pgArcImport = async () => ({ ok: true, job: JOB }); t.click('arcgo'); await sleep(10);
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'pgArcImport')[0].slice(1), [TOK, { comments: false }], 'token + pilihan komentar'); assert.strictEqual(t.run('pgArcS.phase'), 'running');
    t.ev({ job: JOB, kind: 'import', phase: 'progress', posts: 1, total: 3, bytes: 10, totalBytes: 40 }); assert(/Mengimpor/.test(t.box()) && /1 \/ 3/.test(t.box()));
    t.ev({ job: JOB, kind: 'import', phase: 'done', result: { imported: 3, same: 1, conflict: 1, bad: 0, failed: 0, aborted: false, total: 5, blobs: { written: 2, reuse: 0, bytes: 4096 }, ownerMatch: true, comments: { status: 'skipped', why: 'off', items: 4, tombs: 1 } } });
    b = t.box(); assert(/Selesai: <b>3 postingan masuk<\/b>, 1 sudah ada, 1 bentrok/.test(b) && /2 lampiran ditulis/.test(b) && /Komentar tidak dipulihkan/.test(b));
    assert(t.calls.filter((c) => c[0] === 'pgMine').length > before, 'daftar Halamanku dimuat ulang sesudah impor yang memasukkan postingan');
    t.click('arcok');
    // identitas beda: tanpa kotak komentar, penjelasan; tidak ada yang baru = tombol mati; batal kembali idle
    t.api.ret_pgArcOpen = async () => ({ ok: true, token: TOK, name: 'lain.archpg', summary: sum({ ownerMatch: false, counts: { total: 2, new: 0, same: 2, conflict: 0, bad: 0 }, comments: { status: 'ok', present: true, restorable: false, items: 3, tombs: 0, plan: null } }) }); t.click('arcimp'); await sleep(10);
    b = t.box(); assert(!b.includes('pgarccmi') && /identitas lain/.test(b) && /tidak dibawa/.test(b) && /data-pg="arcgo" disabled/.test(b) && /Tidak ada yang baru/.test(b));
    t.click('arcno'); assert.strictEqual(t.run('pgArcS.phase'), 'idle'); assert.strictEqual(t.run('pgArcS.token'), null);
    // komentar saja yang baru (postingan sudah ada) tetap bisa diimpor
    t.api.ret_pgArcOpen = async () => ({ ok: true, token: TOK, name: 'k.archpg', summary: sum({ counts: { total: 2, new: 0, same: 2, conflict: 0, bad: 0 } }) }); t.click('arcimp'); await sleep(10);
    assert(!/data-pg="arcgo" disabled/.test(t.box()), 'hanya komentar baru: tombol aktif');
    // token kedaluwarsa
    t.api.ret_pgArcImport = async () => ({ ok: false, err: 'Pilih arsip lagi', code: 'gone' }); t.click('arcgo'); await sleep(10);
    assert.strictEqual(t.run('pgArcS.phase'), 'error'); assert(/Arsip belum dipilih atau sudah dipakai/.test(t.box()));
  }
  ok('impor: batal dialog, arsip buruk, pratinjau + pilihan komentar, progres, ringkasan, feed dimuat ulang, identitas beda, token kedaluwarsa');

  // E. pembatalan, event saat layar tertutup, hasil sebagian, escape
  {
    const t = mk(); await t.open(); await sleep(20); t.click('arc');
    t.api.ret_pgArcExport = async () => ({ ok: true, job: JOB, name: 'c.archpg' }); t.click('arcexp'); await sleep(10);
    t.click('arccancel'); await sleep(10); assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'pgArcCancel')[0].slice(1), [JOB]);
    t.ev({ job: JOB, kind: 'export', phase: 'cancel' }); assert.strictEqual(t.run('pgArcS.phase'), 'idle'); assert.strictEqual(t.toasts.pop(), 'Dibatalkan.');
    // impor dibatalkan di tengah: hasil sebagian tampil, bisa diulang
    t.api.ret_pgArcOpen = async () => ({ ok: true, token: TOK, name: '<img src=x onerror=alert(1)>.archpg', summary: sum({ name: '<img src=x onerror=alert(1)>.archpg' }) }); t.click('arcimp'); await sleep(10);
    assert(!t.box().includes('<img') && t.box().includes('&lt;img'), 'nama arsip di-escape');
    t.api.ret_pgArcImport = async () => ({ ok: true, job: JOB }); t.click('arcgo'); await sleep(10);
    t.ev({ job: JOB, kind: 'import', phase: 'cancel', result: { imported: 1, same: 0, conflict: 0, bad: 0, failed: 0, aborted: true, total: 3, blobs: { written: 0, reuse: 0, bytes: 0 }, ownerMatch: true, comments: { status: 'skipped', why: 'abort', items: 4, tombs: 0 } } });
    assert.strictEqual(t.run('pgArcS.phase'), 'done'); assert(/Dibatalkan: <b>1 postingan masuk/.test(t.box()) && /Komentar menunggu/.test(t.box()) && /bisa diulang/.test(t.box()));
    t.click('arcok');
    // galat tak terduga membawa hasil sementara
    t.api.ret_pgArcOpen = async () => ({ ok: true, token: TOK, name: 'a.archpg', summary: sum() }); t.click('arcimp'); await sleep(10); t.click('arcgo'); await sleep(10);
    t.ev({ job: JOB, kind: 'import', phase: 'error', err: 'Penyimpanan penuh', code: 'ENOSPC', result: { imported: 2, same: 0, conflict: 0, bad: 0, failed: 0, aborted: false, total: 3, blobs: { written: 1, reuse: 0, bytes: 5 }, ownerMatch: true, comments: { status: 'pending' } } });
    assert(t.box().includes('Penyimpanan penuh') && /2 postingan masuk/.test(t.box()) && /belum sempat diproses/.test(t.box()));
    t.click('arcok');
    // layar ditutup: pekerjaan terus, event yang datang jadi toast, dan panel menyusul saat dibuka lagi
    t.api.ret_pgArcExport = async () => ({ ok: true, job: JOB2, name: 'd.archpg' }); t.click('arcexp'); await sleep(10); t.run('pgClose()');
    t.ev({ job: JOB2, kind: 'export', phase: 'done', result: { name: 'd.archpg', size: 1, posts: 1, media: 0, files: 0, videos: 0, bytes: 0, skipped: 0, comments: null } });
    assert(/Ekspor halaman selesai/.test(t.toasts.pop())); await t.open(); await sleep(20);
    assert.strictEqual(t.els.pgarc.hidden, false, 'ada hasil yang belum ditutup: panel terlihat'); assert(/Selesai: 1 postingan/.test(t.box()) && /Komentar tidak ikut/.test(t.box()));
  }
  ok('batal, impor sebagian bisa diulang, galat membawa hasil sementara, nama di-escape, hasil menyusul saat layar dibuka lagi');

  // F. menyusul pekerjaan yang masih berjalan saat layar dibuka (ctx baru: pgArcState)
  {
    const t = mk({ state: { ok: true, run: { job: JOB, kind: 'import', posts: 1, total: 4, bytes: 30, totalBytes: 60 } } }); await t.open(); await sleep(30);
    assert.strictEqual(t.run('pgArcS.phase'), 'running'); assert.strictEqual(t.els.pgarc.hidden, false); assert(/Mengimpor/.test(t.box()) && /1 \/ 4/.test(t.box()) && t.box().includes('width:50%'));
    t.ev({ job: JOB, kind: 'import', phase: 'done', result: { imported: 0, same: 4, conflict: 0, bad: 0, failed: 0, aborted: false, total: 4, blobs: { written: 0, reuse: 0, bytes: 0 }, ownerMatch: true, comments: { status: 'none' } } });
    assert.strictEqual(t.run('pgArcS.phase'), 'done'); assert(!t.calls.some((c) => c[0] === 'pgMine' && c[1] && c[1].after === 'x'));
    // event cacat tidak merusak keadaan
    const u = mk(); await u.open(); await sleep(20);
    for (const bad of [null, 5, {}, { job: 5, kind: 'export', phase: 'done' }, { job: JOB, kind: 'lain', phase: 'done' }, { job: JOB, kind: 'export', phase: 'aneh' }]) u.ev(bad);
    assert.strictEqual(u.run('pgArcS.phase'), 'idle');
  }
  ok('pekerjaan yang berjalan disusul saat layar dibuka; event cacat atau tak dikenal diabaikan');
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
