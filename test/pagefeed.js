'use strict';
// Tes feed Halaman (1c-4c): logika renderer/js/archne-pages.js di vm dengan stub kecil (tanpa DOM penuh).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.parse(JSON.stringify(x));

const ME = '1'.repeat(16), PEER = 'a'.repeat(16);
const mk = (n, o) => Object.assign({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public' }, o || {});

function boot() {
  const els = {}, calls = [], api = {}, toasts = []; let answers = [], profId = PEER, asked = [], askAns = true;
  const el = (id) => els[id] || (els[id] = { style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, h: {}, addEventListener(t, f) { this.h[t] = f; } });
  const ctx = { S: { me: { id: ME } }, esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), nameOf: (id) => 'N-' + id.slice(0, 2), $: el,
    linkHtml: (t) => ctx.esc(t), fmt: (n) => String(n), dayLabel: () => 'Hari ini', hm: () => '10:00', toast: (t) => toasts.push(t), ask: async (t) => { asked.push(t); return askAns; },
    renderProfile() {}, document: { addEventListener(t, f) { ctx._kd = f; } }, Date, Promise, setTimeout, Set, window: { api } };
  Object.defineProperty(ctx, 'profId', { get: () => profId });
  for (const n of ['pgAvail', 'pgList', 'pgGet', 'pgMine', 'pgCreate', 'pgRemove']) api[n] = async (...a) => { calls.push([n, ...a]); const f = answers.shift(); return typeof f === 'function' ? f(...a) : f; };
  vm.createContext(ctx); vm.runInContext(require('./_src').pagesJs(), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  const click = (pg, id) => { const b = { dataset: { pg, id } }; els.pgmodal.h.click({ target: { closest: () => b } }); };
  return { els, calls, toasts, run, click, ctx, set answers(a) { answers = a; }, get asked() { return asked; }, set askAns(v) { askAns = v; } };
}

(async () => {
  // A. statis: kode error Core tercakup, id pgbox ada, urutan tetap
  const idx = rd('renderer/archne-index.html'), core = rd('src/core/archne-pgerr.js'), css = rd('renderer/css/archne-pages.css');
  assert(idx.includes('id="pgbox"'));
  const coreErr = /const PG_ERR = \{([\s\S]*?)\n\};/.exec(core)[1];
  const b = boot();
  for (const code of ['peer', 'blocked', 'offline', 'old', 'auth', 'time', 'busy', 'bad', 'proto']) { assert(new RegExp('\\b' + code + ':').test(coreErr), 'Core punya ' + code); assert(b.run(`typeof PG_ERR.${code}`) === 'string', 'renderer punya pesan ' + code); }
  for (const c of ['.pgpost', '.pgerr', '.pgcomp', '.pgtxt']) assert(css.includes(c), c);
  ok('statis: pgbox, pesan error renderer mencakup semua kode Core, CSS feed ada');

  // B. muat berhalaman (peer): kursor, dedup, selesai
  let t = boot();
  t.answers = [{ ok: true, items: [mk(5), mk(4)], next: '1700000000004:0000000000000004', count: 4, skipped: 1 },
               { ok: true, items: [mk(4), mk(3), mk(2)], next: null, count: 4, skipped: 0 }];
  t.run(`pgOpen('${PEER}')`); await sleep(10);
  assert.deepStrictEqual(J(t.calls[0]), ['pgList', PEER, { limit: 10 }], 'muat awal tanpa kursor');
  assert(t.els.pglist.innerHTML.includes('isi 5') && !t.els.pglist.innerHTML.includes('isi 3'));
  assert(t.els.pgfoot.innerHTML.includes('more-feed') && t.els.pgfoot.innerHTML.includes('1 postingan tidak bisa'), 'tombol Muat lagi + catatan dilewati');
  assert(t.els.pgcount.textContent === '4 postingan');
  t.click('more-feed'); await sleep(10);
  assert.deepStrictEqual(J(t.calls[1]), ['pgList', PEER, { limit: 10, after: '1700000000004:0000000000000004' }]);
  assert.strictEqual((t.els.pglist.innerHTML.match(/class="pgpost"/g) || []).length, 4, 'id ganda (4) tidak muncul dua kali');
  assert(t.els.pgfoot.innerHTML.includes('paling awal') && !t.els.pgfoot.innerHTML.includes('more-feed'));
  t.click('more-feed'); await sleep(5); assert.strictEqual(t.calls.length, 2, 'selesai: tidak meminta lagi');
  ok('feed peer: muat awal, kursor halaman berikut, id ganda dibuang, berhenti di ujung');

  // C. scroll memicu muat lagi, tidak saat sibuk / error
  t = boot(); t.answers = [{ ok: true, items: [mk(9)], next: '1700000000009:0000000000000009', count: 9, skipped: 0 }, { ok: true, items: [mk(8)], next: null, count: 9, skipped: 0 }];
  t.run(`pgOpen('${PEER}')`); await sleep(10);
  Object.assign(t.els.pgbox, { scrollHeight: 2000, scrollTop: 100, clientHeight: 600 }); t.els.pgbox.h.scroll(); await sleep(5); assert.strictEqual(t.calls.length, 1, 'jauh dari dasar: diam');
  t.els.pgbox.scrollTop = 1300; t.els.pgbox.h.scroll(); await sleep(10); assert.strictEqual(t.calls.length, 2, 'dekat dasar: muat');
  ok('scroll: muat hanya saat dekat dasar');

  // D. error: tiap kode ada pesannya, daftar yang sudah termuat tetap, coba lagi memakai kursor yang sama
  for (const [code, retry] of [['auth', 1], ['time', 1], ['busy', 1], ['offline', 1], ['old', 0], ['blocked', 0], ['proto', 1]]) {
    t = boot(); t.answers = [{ ok: false, err: 'x', code }];
    t.run(`pgOpen('${PEER}')`); await sleep(10);
    const h = t.els.pgfoot.innerHTML; assert(h.includes('role="alert"'), code);
    assert(h.includes(t.run(`esc(PG_ERR.${code})`)), 'pesan ' + code);
    assert.strictEqual(h.includes('data-pg="retry"'), !!retry, 'retry ' + code);
  }
  t = boot(); t.answers = [{ ok: true, items: [mk(5)], next: '1700000000005:0000000000000005', count: 5, skipped: 0 }, { ok: false, code: 'offline' }, { ok: true, items: [mk(4)], next: null, count: 5, skipped: 0 }];
  t.run(`pgOpen('${PEER}')`); await sleep(10); t.click('more-feed'); await sleep(10);
  assert(t.els.pglist.innerHTML.includes('isi 5') && t.els.pgfoot.innerHTML.includes('Pemilik sedang offline'), 'offline di tengah gulir: isi lama tetap');
  t.click('retry'); await sleep(10);
  assert.deepStrictEqual(J(t.calls[2]), J(t.calls[1]), 'coba lagi memakai kursor yang sama');
  assert(t.els.pglist.innerHTML.includes('isi 4') && t.els.pgfoot.innerHTML.includes('paling awal'));
  t = boot(); t.answers = [() => { throw new Error('boom'); }]; t.run(`pgOpen('${PEER}')`); await sleep(10); assert(t.els.pgfoot.innerHTML.includes('role="alert"'), 'IPC melempar: tetap pesan, bukan crash');
  ok('error: auth/time/busy/offline/old/blocked/proto bermakna, retry sesuai, isi lama aman, IPC melempar ditangani');

  // E. jawaban basi dibuang
  t = boot(); let rel; t.answers = [() => new Promise((r) => { rel = r; })];
  t.run(`pgOpen('${PEER}')`); await sleep(5); t.run('pgClose()'); const before = t.els.pgfoot.innerHTML;
  rel({ ok: true, items: [mk(1)], next: null, count: 1, skipped: 0 }); await sleep(10);
  assert.strictEqual(t.els.pgfoot.innerHTML, before, 'tidak menggambar setelah ditutup');
  t = boot(); t.answers = [() => new Promise((r) => { rel = r; }), { ok: true, items: [mk(2)], next: null, count: 1, skipped: 0 }];
  t.run(`pgOpen('${PEER}')`); await sleep(5); t.run(`pgOpen('${'b'.repeat(16)}')`); await sleep(10); rel({ ok: true, items: [mk(1, { text: 'dari-lama' })], next: null, count: 1, skipped: 0 }); await sleep(10);
  assert(!t.els.pglist.innerHTML.includes('dari-lama') && t.els.pglist.innerHTML.includes('isi 2'), 'jawaban halaman lama tidak masuk ke halaman baru');
  ok('jawaban basi: ditutup atau pindah halaman, hasil lama dibuang');

  // F. teks: escape, lipat, terpotong (trunc) diambil utuh
  const long = 'x'.repeat(2000);
  t = boot(); t.answers = [{ ok: true, items: [mk(3, { text: '<img src=x onerror=1>' }), mk(2, { text: long }), mk(1, { text: 'awal', trunc: 5000000 })], next: null, count: 3, skipped: 0 }, { ok: true, post: mk(1, { text: 'teks utuh sekali' }) }];
  t.run(`pgOpen('${PEER}')`); await sleep(10);
  let h = t.els.pglist.innerHTML;
  assert(h.includes('&lt;img') && !h.includes('<img'), 'HTML di-escape');
  assert(h.includes('Lihat selengkapnya (2000') && !h.includes(long), 'teks panjang dilipat');
  t.click('more', mk(2).id); h = t.els.pglist.innerHTML; assert(h.includes(long) && h.includes('Sembunyikan'));
  t.click('more', mk(2).id); assert(!t.els.pglist.innerHTML.includes(long));
  assert(h.includes('Muat teks utuh (5000000'), 'trunc: tombol ambil utuh');
  t.click('full', mk(1).id); await sleep(10);
  assert.deepStrictEqual(J(t.calls[1]), ['pgGet', PEER, mk(1).id]); assert(t.els.pglist.innerHTML.includes('teks utuh sekali') && !t.els.pglist.innerHTML.includes('Muat teks utuh'));
  ok('teks: di-escape, lipat/buka, teks terpotong diambil lewat pgGet');

  // G. Halamanku: pgMine, kotak tulis, kirim, gagal menjaga draf, hapus
  t = boot(); t.answers = [{ ok: true, items: [mk(2, { priv: 'friends' }), mk(1)], next: null }, { ok: false, err: 'Disk penuh' }, { ok: true, post: mk(3) }, { ok: true, removed: true }];
  t.run(`pgOpen('${ME}')`); await sleep(10);
  assert.deepStrictEqual(J(t.calls[0]), ['pgMine', { limit: 10 }]);
  assert(t.els.pglist.innerHTML.includes('pgtag fr') && t.els.pglist.innerHTML.includes('data-pg="del"'), 'tag privasi + tombol hapus di milik sendiri');
  t.ctx.$('pgtxt'); t.ctx.$('pgpriv'); t.els.pgtxt.value = '   '; t.click('post'); await sleep(5);
  assert.strictEqual(t.calls.length, 1, 'kosong: tanpa IPC'); assert(t.els.pgcerr.textContent.includes('Tulis sesuatu'));
  t.els.pgtxt.value = 'halo dunia'; t.els.pgpriv.value = 'friends'; t.click('post'); await sleep(10);
  assert.deepStrictEqual(J(t.calls[1]), ['pgCreate', 'halo dunia', 'friends', []]); // sejak 2c: argumen ke-3 = larik gambar (kosong untuk postingan teks)
  assert.strictEqual(t.els.pgtxt.value, 'halo dunia', 'gagal: draf tetap'); assert(t.els.pgcerr.textContent.includes('Disk penuh'));
  t.click('post'); await sleep(10);
  assert.strictEqual(t.els.pgtxt.value, '', 'sukses: kotak dikosongkan'); assert(t.els.pglist.innerHTML.indexOf('isi 3') < t.els.pglist.innerHTML.indexOf('isi 2'), 'postingan baru di paling atas');
  t.askAns = false; t.click('del', mk(3).id); await sleep(5); assert.strictEqual(t.calls.length, 3, 'batal konfirmasi: tidak menghapus');
  t.askAns = true; t.click('del', mk(3).id); await sleep(10);
  assert.deepStrictEqual(J(t.calls[3]), ['pgRemove', mk(3).id]); assert(!t.els.pglist.innerHTML.includes('isi 3') && t.asked.length === 2);
  ok('Halamanku: pgMine, kirim (kosong ditolak), draf aman saat gagal, hapus dengan konfirmasi');

  // H. draf bertahan saat layar ditutup dan dibuka lagi
  t = boot(); t.answers = [{ ok: true, items: [], next: null }, { ok: true, items: [], next: null }];
  t.run(`pgOpen('${ME}')`); await sleep(10); t.ctx.$('pgtxt'); t.els.pgtxt.value = 'setengah jadi'; t.run('pgClose()');
  t.run(`pgOpen('${ME}')`); await sleep(10); assert(t.els.pgbody.innerHTML.includes('setengah jadi'), 'draf kembali');
  assert(t.els.pgfoot.innerHTML.includes('Belum ada postingan. Tulis'), 'keadaan kosong milik sendiri');
  ok('draf bertahan; keadaan kosong benar');

  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
