'use strict';
// Tes UI berkas (v0.7.0 tahap 5b): (1) fungsi murni renderer/archne-filecard.js, (2) kontrak archne-index.html <-> preload.js <-> archne-ipc.js,
// (3) skrip asli archne-index.html dijalankan di vm dengan DOM tiruan (tanpa Electron/jsdom): render kartu, klik tombol, progres, kirim, seret-lepas.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const FC = require('../renderer/archne-filecard');
const root = path.join(__dirname, '..');
const html = require('./_src').htmlSrc();
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const ID = 'a'.repeat(32), ID2 = 'b'.repeat(32);
const base = (file, extra) => Object.assign({ id: ID, from: 'peer', to: 'public', ts: 1, name: 'X', text: '📎', file }, extra);

(async () => {
  // ---- 1. fungsi murni ----
  assert.deepStrictEqual([0, 1023, 1024, 1536, 10240, 1048576, 5.5 * 1048576, 100 * 1048576, 1073741824].map(FC.fmtSize),
    ['0 B', '1023 B', '1,0 KB', '1,5 KB', '10 KB', '1,0 MB', '5,5 MB', '100 MB', '1,00 GB']);
  assert.deepStrictEqual([[0, 0], [5, 0], [0, 10], [5, 10], [10, 10], [11, 10], [-3, 10]].map(([d, t]) => FC.pct(d, t)), [0, 0, 0, 50, 100, 100, 0]);
  assert.strictEqual(FC.progressText('download', 512, 1024), '50% · 512 B / 1,0 KB');
  assert(/^Menyimpan/.test(FC.progressText('unpack', 1, 2)) && /^Menyiapkan/.test(FC.progressText('pack', 1, 2)));
  ok('fmtSize, pct (dibatasi 0-100, total 0 aman), teks progres per fase');

  // ---- 1b. (v0.7.4) helper foto: geometri dan pemilihan kualitas (pengecilan canvas sungguhan hanya bisa dijalankan di Electron) ----
  {
    const AV = require('../renderer/archne-avatar');
    assert.deepStrictEqual(AV.cropSquare(400, 300), { sx: 50, sy: 0, sw: 300, sh: 300 });
    assert.deepStrictEqual(AV.cropSquare(300, 400), { sx: 0, sy: 50, sw: 300, sh: 300 });
    assert.deepStrictEqual(AV.cropSquare(64, 64), { sx: 0, sy: 0, sw: 64, sh: 64 });
    const tried = [];
    let r = AV.pick((size, q) => { tried.push([size, q]); return 'x'.repeat(size === 128 && q === 0.85 ? 20000 : 5000); });
    assert.deepStrictEqual([r.size, r.quality, r.b64.length], [128, 0.72, 5000], 'kualitas turun dulu, ukuran tetap sebisanya');
    r = AV.pick((size, q) => (size === 64 ? 'y'.repeat(100) : 'x'.repeat(50000)));
    assert.strictEqual(r.size, 64, 'ukuran mengecil bila kualitas terendah pun masih terlalu besar');
    assert.strictEqual(AV.pick(() => 'x'.repeat(50000)), null, 'tidak ada yang muat: null');
    assert.strictEqual(AV.pick(() => null), null);
    assert(AV.MAX_B64 <= 14000, 'batas renderer tidak melebihi batas Core');
    await assert.rejects(AV.fromFile({ size: 30 * 1048576 }), /terlalu besar/);
    await assert.rejects(AV.fromFile(null), /tidak dipilih/);
    ok('helper foto: potong tengah persegi, kualitas turun lalu ukuran mengecil sampai muat, gambar terlalu besar ditolak');
  }

  // ---- 2. kartu: tiap keadaan ----
  const card = (file, prog) => FC.cardHtml(base(file), prog);
  const F = { name: 'laporan.pdf', size: 2 * 1048576, psize: 2 * 1048576, mode: 'raw' };
  let h = card(F);
  assert(h.includes('data-act="recv"') && h.includes('title="Terima"') && !h.includes('dikompres') && h.includes('2,0 MB'));
  h = card(Object.assign({}, F, { mode: 'br', psize: 500000 }));
  assert(h.includes('dikompres, dikirim 488 KB'));
  h = card(Object.assign({}, F, { rx: { phase: 'download', done: 1048576, total: 2097152 } }));
  assert(h.includes('width:50%') && h.includes('data-act="cancelrx"') && h.includes(`data-bar="${ID}"`) && h.includes('50% · ') && !h.includes('data-act="recv"'));
  h = card(Object.assign({}, F, { rx: { phase: 'download', done: 0, total: 100 } }), { [ID]: { phase: 'unpack', done: 90, total: 100 } });
  assert(h.includes('width:90%') && h.includes('Menyimpan 90%'), 'kemajuan dari event lebih baru daripada state');
  h = card(Object.assign({}, F, { rx: { phase: 'error', code: 'AbortError', err: 'dibatalkan', done: 0, total: 1 } }));
  assert(h.includes('Lanjutkan') && h.includes('Dibatalkan') && !h.includes('Gagal'));
  h = card(Object.assign({}, F, { rx: { phase: 'error', code: 'hash', err: 'hash tidak cocok', done: 0, total: 1 } }));
  assert(h.includes('Gagal: Berkas yang terunduh tidak sama dengan aslinya') && !h.includes('hash tidak cocok') && h.includes('Coba lagi') && h.includes('data-act="recv"') && h.includes('data-act="discard"'));
  h = card(Object.assign({}, F, { rx: { phase: 'error', code: 'zzz-baru', err: 'pesan asli <b>', done: 0, total: 1 } }));
  assert(h.includes('Gagal: pesan asli &lt;b&gt;') && h.includes('Coba lagi'), 'kode tak dikenal: pesan asli (di-escape), tetap bisa diulang');
  h = card(Object.assign({}, F, { saved: { name: 'laporan (1).pdf', path: 'C:\\x' } }));
  assert(h.includes('Tersimpan: laporan (1).pdf') && h.includes('data-act="open"') && FC.menuItems(base(Object.assign({}, F, { saved: { name: 'laporan (1).pdf' } }))).some((i) => i.act === 'f:show') && !h.includes('C:\\x'), 'path tidak ikut ke HTML');
  h = card(Object.assign({}, F, { mine: true }));
  assert(h.includes('Tawaran berkas terkirim') && !h.includes('data-act'));
  ok('kartu: terima, dikompres, mengunduh, kemajuan event menang atas state, dibatalkan/gagal, tersimpan, milik sendiri');

  // ---- 3. XSS: nama berkas, galat, nama simpan, id ----
  const evil = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  for (const file of [Object.assign({}, F, { name: evil }), Object.assign({}, F, { saved: { name: evil } }), Object.assign({}, F, { rx: { phase: 'error', code: 'x', err: evil } })]) {
    const out = FC.cardHtml(base(file), {});
    assert(!/<img|<script/i.test(out) && out.includes('&lt;img'), out);
  }
  const jo = FC.jobHtml({ job: 'j1', name: evil, phase: 'error', err: evil, done: 0, total: 1 });
  assert(!/<img|<script/i.test(jo));
  assert(!/<img|<script/i.test(FC.jobHtml({ job: 'j1', name: evil, phase: 'pack', done: 1, total: 2 })));
  ok('nama berkas, pesan galat, dan nama simpan di-escape di kartu dan gelembung kirim');

  // ---- 4. gelembung kirim ----
  h = FC.jobHtml({ job: 'j9', name: 'a.zip', phase: 'pack', done: 25, total: 100 });
  assert(h.includes('width:25%') && h.includes('data-bar="j:j9"') && h.includes('data-act="cancelsend"') && h.includes('data-id="j9"') && h.includes('Menyiapkan 25%'));
  h = FC.jobHtml({ job: 'j9', name: 'a.zip', phase: 'error', err: 'berkas terlalu besar', code: 'limit' });
  assert(h.includes('Gagal mengirim: berkas terlalu besar') && h.includes('data-act="dismiss"') && !h.includes('cancelsend'));
  assert.deepStrictEqual(FC.jobsFor([{ job: 1, to: 'public' }, { job: 2, to: 'g:x' }, { job: 3, to: 'public' }], 'public').map((j) => j.job), [1, 3]);
  assert.deepStrictEqual(FC.jobsFor(undefined, 'public'), []);
  ok('gelembung kirim: batang + Batal saat jalan, galat + Tutup saat gagal; hanya tampil di chat tujuannya');


  // ---- 4b. (5c) pesan galat ramah: semua kode yang ada di sumber punya pesan; yang final tidak menawarkan "Coba lagi" ----
  {
    const src = ['archne-xfer.js', 'archne-pack.js'].map((n) => fs.readFileSync(path.join(root, 'src', n), 'utf8')).join('\n') + require('./_src').coreSrc();
    const codes = new Set([...src.matchAll(/(?:XferError|PackError)\('([a-z]+)'/g)].map((m) => m[1]).concat([...src.matchAll(/\b(?:no|refuse\(sock,)\s*\(?'([a-z]+)'\)/g)].map((m) => m[1])));
    const skip = new Set(['abort', 'auth']); // abort ditangani sebagai "Dibatalkan"; auth bukan galat berkas
    for (const c of codes) if (!skip.has(c)) assert(FC.rxError(c, 'RAW').text !== 'RAW', 'kode galat tanpa pesan ramah: ' + c);
    assert(codes.size >= 12, 'pemindaian menemukan kode: ' + [...codes]);
    for (const c of ['gone', 'denied', 'limit', 'changed', 'meta']) assert.strictEqual(FC.rxError(c).retry, false, c);
    for (const c of ['net', 'timeout', 'busy', 'nokey', 'crypt', 'hash', 'size', 'corrupt', 'bomb', 'proto', 'ENOSPC', 'EACCES']) assert.strictEqual(FC.rxError(c).retry, true, c);
    assert.deepStrictEqual(FC.rxError('xx', 'asli'), { text: 'asli', retry: true });
    assert.deepStrictEqual(FC.rxError(undefined, undefined), { text: 'galat tidak dikenal', retry: true });
    let h = card(Object.assign({}, F, { rx: { phase: 'error', code: 'gone', err: 'Pengirim membatalkan berkas ini', done: 0, total: 1 } }));
    assert(h.includes('sudah membatalkan') && !h.includes('data-act="recv"') && h.includes('data-act="discard"') && h.includes('Tutup'));
    h = card(Object.assign({}, F, { rx: { phase: 'error', code: 'AbortError', err: 'x', done: 0, total: 1 } }));
    assert(h.includes('data-act="recv"') && h.includes('Buang sisa unduhan'));
    assert(FC.jobHtml({ job: 'j', name: 'a', phase: 'error', code: 'ENOENT', err: 'ENOENT: no such file' }).includes('tidak ditemukan'));
    assert(FC.jobHtml({ job: 'j', name: 'a', phase: 'error', code: 'limit', err: 'berkas terlalu besar: 51 MB (batas 50 MB)' }).includes('berkas terlalu besar: 51 MB'), 'pesan batas dari Pack sudah informatif, dipakai apa adanya');
    ok(`galat ramah: ${codes.size} kode di sumber semuanya punya pesan; final -> Tutup, sementara -> Coba lagi + Buang sisa; kode asing jatuh ke pesan asli`);
  }

  // ---- 4c. (5c) status kurir ----
  {
    const DMTO = '0123456789abcdef';
    let h = FC.cardHtml(base(Object.assign({}, F, { held: 2 }), { to: DMTO }), {});
    assert(h.includes('Tersedia di 2 kurir') && h.includes('data-act="recv"'));
    h = FC.cardHtml(base(Object.assign({}, F, { held: 1, rx: { phase: 'download', done: 1, total: 2 } }), { to: DMTO }), {});
    assert(h.includes('Tersedia di 1 kurir') && h.includes('cancelrx'));
    for (const to of ['public', 'g:abc']) { // publik/grup: pemegangnya kurir publik atau peer yang sudah mengunduh
      h = FC.cardHtml(base(Object.assign({}, F, { held: 2 }), { to }), {});
      assert(h.includes('Tersedia di 2 peer lain') && !h.includes('kurir:') && h.includes('data-act="recv"'));
    }
    h = FC.cardHtml(base(Object.assign({}, F, { held: 1, saved: { name: 'x.pdf' } })), {});
    assert(!h.includes('kurir'), 'sudah tersimpan: tidak perlu info kurir');
    h = FC.cardHtml(base(F, { to: '0123456789abcdef' }), {}, { senderOnline: false });
    assert(h.includes('Pengirim sedang offline dan belum ada kurir'), 'DM: kurir memang bisa memegang');
    h = FC.cardHtml(base(F, { to: 'public' }), {}, { senderOnline: false });
    assert(h.includes('belum ada kurir atau peer lain yang memegang') && !h.includes('hanya untuk berkas DM'), 'publik: kurir publik dan peer yang sudah mengunduh bisa memegang');
    h = FC.cardHtml(base(F, { to: 'g:abc' }), {}, { senderOnline: false });
    assert(h.includes('belum ada anggota grup lain yang memegang berkas ini') && !h.includes('belum ada kurir'), 'grup: petunjuknya menyebut anggota grup, bukan kurir');
    assert(!FC.cardHtml(base(F), {}, { senderOnline: true }).includes('offline') && !FC.cardHtml(base(F), {}, {}).includes('offline') && !FC.cardHtml(base(F), {}).includes('offline'));
    assert(!FC.cardHtml(base(Object.assign({}, F, { held: 1 })), {}, { senderOnline: false }).includes('Pengirim sedang offline'), 'ada kurir: tidak perlu peringatan offline');
    h = FC.cardHtml(base(Object.assign({}, F, { mine: true, pushed: 2 }), { to: DMTO }), {});
    assert(h.includes('Dititipkan di 2 kurir') && !h.includes('Menitipkan'));
    h = FC.cardHtml(base(Object.assign({}, F, { mine: true, pushed: 2 }), { to: 'public' }), {});
    assert(h.includes('Dipegang 2 peer lain') && h.includes('walau kamu offline') && !h.includes('Dititipkan di'));
    h = FC.cardHtml(base(Object.assign({}, F, { mine: true, pushing: true, pushed: 1 })), {});
    assert(h.includes('Menitipkan ke kurir') && !h.includes('Dititipkan di'));
    h = FC.cardHtml(base(Object.assign({}, F, { mine: true })), {});
    assert(!h.includes('kurir'));
    ok('status kurir: DM "tersedia di n kurir"/"dititipkan di n kurir"; publik/grup "peer lain"; petunjuk pengirim offline berbeda per jenis chat dan hanya bila tanpa pemegang');
  }

  // ---- 4d. (5c) berkas berbahaya ----
  {
    const ipcMod = require('../src/archne-ipc');
    assert.deepStrictEqual([...FC.RISKY].sort(), [...ipcMod.RISKY].sort(), 'daftar ekstensi UI dan IPC harus sama');
    for (const n of ['a.exe', 'x.BAT', 'y.ps1', 'z.Js', 'k.lnk']) assert(FC.isRisky(n) === ipcMod.isRisky(n) && FC.isRisky(n), n);
    for (const n of ['a.txt', 'exe', 'x.exe.txt', '', 'foto.png']) assert(FC.isRisky(n) === ipcMod.isRisky(n) && !FC.isRisky(n), n);
    const X = Object.assign({}, F, { name: 'setup.exe' });
    let h = FC.cardHtml(base(X), {});
    assert(h.includes('bisa dijalankan') && h.includes('Terima (berisiko)') && h.includes('data-risky="1"') && h.includes('danger'));
    assert(!FC.cardHtml(base(F), {}).includes('data-risky') && !FC.cardHtml(base(F), {}).includes('berisiko'));
    h = FC.cardHtml(base(Object.assign({}, X, { saved: { name: 'setup.exe' } })), {});
    assert(h.includes('tidak dibuka dari Archne') && h.includes('data-act="show"') && !h.includes('data-act="open"'));
    h = FC.cardHtml(base(Object.assign({}, X, { rx: { phase: 'error', code: 'net', err: 'x', done: 0, total: 1 } })), {});
    assert(h.includes('data-act="recv"') && h.includes('data-risky="1"'), 'Coba lagi tetap meminta konfirmasi untuk berkas berisiko');
    h = FC.cardHtml(base(Object.assign({}, F, { saved: { name: 'laporan.pdf' } })), {});
    assert(h.includes('data-act="open"') && !h.includes('dijalankan'));
    ok('berkas berbahaya: peringatan + tombol "Terima (berisiko)" bertanda data-risky; tersimpan -> hanya Tampilkan di folder; daftar UI = daftar IPC');
  }

  // ---- 5. kontrak: archne-index.html -> preload.js -> archne-ipc.js ----
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), ipc = fs.readFileSync(path.join(root, 'src', 'archne-ipc.js'), 'utf8');
  const used = new Set([...html.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]).concat([...html.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1])));
  const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
  const HTTP_ONLY = new Set(['dxUpload']); // hanya ada di jembatan HTTP (renderer/archne-api-http.js: HP tanpa pemilih berkas berpath)
  for (const n of used) assert(exposed.has(n) || HTTP_ONLY.has(n), 'archne-index.html memakai api.' + n + ' yang tidak ada di preload.js');
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\('(\w+)'/g)].map((m) => m[1]);
  const ipcDx = fs.readFileSync(path.join(root, 'src', 'archne-ipc-direct.js'), 'utf8'); // handler Kirim Langsung ada di modul sendiri
  const ipcPg = fs.readFileSync(path.join(root, 'src', 'archne-ipc-pages.js'), 'utf8'); // handler Halaman (1c-4a) ada di modul sendiri
  const handled = new Set([...ipc.matchAll(/\b(?:h|ipcMain\.handle)\('(\w+)'/g)].map((m) => m[1]).concat([...ipcDx.matchAll(/^\s*on\('(\w+)'/gm)].map((m) => m[1]), [...ipcPg.matchAll(/^\s*on\('(\w+)'/gm)].map((m) => m[1])));
  for (const c of channels) assert(handled.has(c), 'preload.js memanggil saluran ' + c + ' yang tidak punya handler di archne-ipc.js');
  const events = [...preload.matchAll(/ipcRenderer\.on\('(\w+)'/g)].map((m) => m[1]);
  const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  for (const e of events) assert(ipc.includes(`'${e}'`) || ipcDx.includes(`'${e}'`) || ipcPg.includes(`'${e}'`) || mainSrc.includes(`'${e}'`), 'tidak ada pengirim event ' + e);
  assert(/<script src="archne-filecard\.js"><\/script>/.test(html) && fs.existsSync(path.join(root, 'renderer', 'archne-filecard.js')));
  assert(/script-src 'self'/.test(html), 'CSP mengizinkan skrip dari berkas sendiri');
  assert(/img-src data:/.test(html) && !/img-src[^;]*https?:/.test(html), 'CSP mengizinkan gambar data: (foto profil) dan tidak ada gambar dari jaringan');
  assert(/<script src="archne-avatar\.js"><\/script>/.test(html) && fs.existsSync(path.join(root, 'renderer', 'archne-avatar.js')), 'archne-avatar.js dimuat');
  assert(used.has('setAvatar'), 'UI memakai api.setAvatar');
  for (const n of ['pickFiles', 'pathOf', 'sendFile', 'cancelSend', 'dismissSend', 'receiveFile', 'cancelReceive', 'discardIncoming', 'showFile', 'openFile', 'openDownloads', 'onProgress']) assert(used.has(n), 'UI belum memakai api.' + n);
  ok(`kontrak: ${used.size} pemanggilan api di UI semuanya ada di preload; ${channels.length} saluran semuanya punya handler; event ada pengirimnya`);

  // ---- 6. skrip asli archne-index.html di vm dengan DOM tiruan ----
  const inline = require('./_src').inlineJs();
  const els = {}, qs = {};
  const mkEl = (id) => ({ id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 0, scrollHeight: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() {}, requestSubmit() {} });
  const calls = [], toasts = [];
  let state;
  let progCb, updCb, remCb, failErr = null;
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'onProgress') return (cb) => { progCb = cb; };
    if (n === 'onUpdate') return (cb) => { updCb = cb; };
    if (n === 'onRemoved') return (cb) => { remCb = cb; };
    if (n === 'pickFiles') return async () => { calls.push(['pickFiles']); return ['C:\\a.txt', 'C:\\b.txt']; };
    if (n === 'pathOf') return (f) => f.path || '';
    if (n === 'sendFile') return async (job, src, to) => { calls.push(['sendFile', job, src, to]); return src.includes('besar') ? { ok: false, err: 'berkas terlalu besar', code: 'limit' } : { ok: true, id: ID2 }; };
    return async (...a) => { calls.push([n, ...a]); return failErr ? { ok: false, err: failErr } : { ok: true }; };
  } });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null,
    querySelector: (sel) => qs[sel] || null };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: FC, Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON };
  ctx.window.FileCard = FC;
  vm.createContext(ctx);
  const msgsEl = doc.getElementById('msgs');
  const mine = { id: ID2, from: 'me', to: 'public', ts: 3, name: 'Saya', text: '📎 saya.txt', file: { name: 'saya.txt', size: 10, psize: 10, mode: 'raw', mine: true } };
  state = { me: { id: 'me', name: 'Saya', port: 1 }, downloadDir: 'D:\\unduhan', peers: [], groups: [], limits: { maxText: 10000 }, sending: [{ job: 'jx', to: 'public', name: 'sedang.bin', phase: 'pack', done: 10, total: 100 }, { job: 'jy', to: 'g:lain', name: 'chat-lain.bin', phase: 'pack', done: 1, total: 2 }],
    messages: [Object.assign(base({ name: 'dari-peer.pdf', size: 3 * 1048576, psize: 3 * 1048576, mode: 'raw' }), { name: 'Budi', ts: 2 }), mine, { id: 'c'.repeat(32), from: 'peer', to: 'public', ts: 4, name: 'Budi', text: 'teks biasa <b>x</b>' }] };
  vm.runInContext(inline, ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  let out = msgsEl.innerHTML;
  assert(out.includes('dari-peer.pdf') && out.includes('title="Terima"') && out.includes('saya.txt') && out.includes('Tawaran berkas terkirim'));
  assert(out.includes('sedang.bin') && !out.includes('chat-lain.bin'), 'pekerjaan kirim hanya di chat tujuannya');
  assert(out.includes('teks biasa &lt;b&gt;x&lt;/b&gt;'), 'pesan teks biasa tetap di-escape');
  ok('archne-index.html asli: render kartu terima, tawaran milik sendiri, gelembung kirim (hanya chat ini), teks biasa tetap aman');

  // klik tombol di kartu (delegasi di #msgs)
  const click = async (act, id) => { calls.length = 0; await msgsEl.onclick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, id } } : null) } }); return calls.slice(); };
  assert.deepStrictEqual((await click('recv', ID))[0], ['receiveFile', ID]);
  assert.deepStrictEqual((await click('cancelrx', ID))[0], ['cancelReceive', ID]);
  assert.deepStrictEqual((await click('open', ID))[0], ['openFile', ID]);
  assert.deepStrictEqual((await click('show', ID))[0], ['showFile', ID]);
  assert.deepStrictEqual((await click('cancelsend', 'jx'))[0], ['cancelSend', 'jx']);
  assert.deepStrictEqual((await click('dismiss', 'jx'))[0], ['dismissSend', 'jx']);
  ok('tombol Terima/Batal/Buka/Tampilkan/Batal kirim/Tutup memanggil api yang benar dengan id-nya');

  // galat dari api muncul sebagai toast
  failErr = 'Berkas jenis ini tidak dibuka dari Archne.';
  await click('open', ID);
  assert.strictEqual(els.toast.textContent, failErr); assert.strictEqual(els.toast.style.display, 'block');
  els.toast.textContent = ''; failErr = null;
  await click('open', ID); assert.strictEqual(els.toast.textContent, '', 'sukses: tidak ada toast');
  ok('galat dari api (mis. openFile risky) tampil sebagai toast; hasil sukses tidak memunculkan apa pun');
  // progres langsung ke DOM
  const barEl = { style: {} }, txtEl = { textContent: '' };
  qs[`[data-bar="${ID}"]`] = barEl; qs[`[data-bartxt="${ID}"]`] = txtEl;
  progCb({ id: ID, phase: 'download', done: 30, total: 60 });
  assert.strictEqual(barEl.style.width, '50%'); assert(txtEl.textContent.startsWith('50% · '));
  progCb({ id: ID, phase: 'unpack', done: 6, total: 60 });
  assert.strictEqual(barEl.style.width, '10%'); assert(txtEl.textContent.startsWith('Menyimpan'));
  qs['[data-bar="j:jx"]'] = barEl; progCb({ job: 'jx', phase: 'pack', done: 3, total: 4 });
  assert.strictEqual(barEl.style.width, '75%');
  progCb({ id: ID, phase: 'done', done: 60, total: 60 }); // tidak melempar walau elemen sudah tidak ada
  ok('progres memperbarui batang dan teks langsung di DOM (id dan job), fase akhir tidak melempar');


  // (5c) konfirmasi berkas berisiko, buang sisa, folder unduhan, petunjuk pengirim offline
  {
    const clickD = async (act, id, ds) => { calls.length = 0; await msgsEl.onclick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: Object.assign({ act, id }, ds) } : null) } }); return calls.slice(); };
    ctx.confirm = () => false;
    assert.deepStrictEqual(await clickD('recv', ID, { risky: '1' }), [], 'konfirmasi ditolak: tidak mengunduh');
    ctx.confirm = () => true;
    assert.deepStrictEqual((await clickD('recv', ID, { risky: '1' }))[0], ['receiveFile', ID]);
    ctx.confirm = () => false;
    assert.deepStrictEqual((await clickD('recv', ID))[0], ['receiveFile', ID], 'berkas biasa: tanpa konfirmasi');
    ctx.confirm = () => true;
    assert.deepStrictEqual((await clickD('discard', ID))[0], ['discardIncoming', ID]);
    calls.length = 0; await els.dlbtn.onclick();
    assert.deepStrictEqual(calls[0], ['openDownloads']);
    failErr = 'Folder tidak bisa dibuka'; els.toast.textContent = ''; await els.dlbtn.onclick(); failErr = null;
    assert.strictEqual(els.toast.textContent, 'Folder tidak bisa dibuka');
    assert(/Buka folder unduhan: D:\\unduhan/.test(els.head.innerHTML), 'tooltip menampilkan folder unduhan');
    state.peers = [{ id: 'peer', name: 'Budi', online: false, secure: true }];
    await updCb(); await new Promise((r) => setImmediate(r));
    assert(msgsEl.innerHTML.includes('Pengirim sedang offline dan belum ada kurir atau peer lain'));
    state.peers = [{ id: 'peer', name: 'Budi', online: true, secure: true }];
    await updCb(); await new Promise((r) => setImmediate(r));
    assert(!msgsEl.innerHTML.includes('Pengirim sedang offline'));
    ok('UI: konfirmasi berkas berisiko, Buang sisa, tombol 📂 Unduhan (+ toast galat), petunjuk pengirim offline mengikuti status peer');
  }

  // tombol 📎: pilih berkas -> satu pekerjaan per berkas ke chat aktif; galat awal jadi toast
  calls.length = 0;
  await els.attbtn.onclick();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  const sends = calls.filter((c) => c[0] === 'sendFile');
  assert.strictEqual(sends.length, 2);
  assert(sends.every((c) => /^j[a-z0-9]+$/.test(c[1]) && c[3] === 'public') && sends[0][1] !== sends[1][1] && sends[0][2] === 'C:\\a.txt' && sends[1][2] === 'C:\\b.txt');
  ok('tombol 📎: tiap berkas jadi satu pekerjaan dengan id unik, dikirim ke chat yang sedang dibuka');

  // seret-lepas
  const drag = (type, extra) => { const ev = Object.assign({ dataTransfer: { types: ['Files'], files: [] }, preventDefault() { this.pd = true; } }, extra); (els.main.handlers[type] || []).forEach((fn) => fn(ev)); return ev; };
  let ev = drag('dragenter'); assert(ev.pd && els.main.classList.contains('drag'));
  drag('dragleave'); assert(!els.main.classList.contains('drag'));
  ev = drag('dragenter', { dataTransfer: { types: ['text/plain'], files: [] } }); assert(!ev.pd && !els.main.classList.contains('drag'), 'bukan berkas: diabaikan');
  drag('dragenter'); calls.length = 0;
  ev = drag('drop', { dataTransfer: { types: ['Files'], files: [{ path: 'C:\\seret1.txt' }, { path: '' }, { path: 'C:\\seret2.txt' }] } });
  await new Promise((r) => setImmediate(r));
  assert(ev.pd && !els.main.classList.contains('drag'));
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'sendFile').map((c) => c[2]), ['C:\\seret1.txt', 'C:\\seret2.txt'], 'path kosong dilewati');
  calls.length = 0; ev = drag('drop', { dataTransfer: { types: ['text/plain'], files: [] } });
  assert(!ev.pd && !calls.length, 'drop non-berkas tidak melakukan apa pun');
  // kegagalan awal (bukan abort, tidak ada di state.sending) -> toast; abort -> diam
  els.toast.textContent = '';
  drag('drop', { dataTransfer: { types: ['Files'], files: [{ path: 'C:\\besar.bin' }] } });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.strictEqual(els.toast.textContent, 'berkas terlalu besar');
  ok('seret-lepas: sorotan muncul/hilang, hanya berkas yang diterima, path kosong dilewati, drop teks diabaikan');

  // ---- tata letak: kiri = tab Publik/Grup/Teman (Teman = hanya yang ditambah), kanan = daftar orang menurut chat yang dibuka ----
  {
    const tabClick = async (t) => { await els.tabs.onclick({ target: { closest: (sel) => (sel === '[data-tab]' ? { dataset: { tab: t } } : null) } }); };
    const listClick = async (id) => { await els.list.onclick({ target: { closest: (sel) => (sel === '.item' ? { dataset: { id } } : null) } }); };
    const userClick = async (uid) => { await els.ulist.onclick({ target: { closest: (sel) => (sel === '.urow' ? { dataset: { uid } } : null) } }); };
    const pact = async (act) => { calls.length = 0; await els.pmodal.onclick({ target: { closest: (sel) => (sel === '[data-pact]' ? { dataset: { pact: act } } : null) } }); return calls.slice(); };
    const upd = async () => { await updCb(); await new Promise((r) => setImmediate(r)); };
    const peerList = (fr) => [{ id: 'peer', name: 'Budi', online: true, secure: true, friend: true }, { id: 'p2', name: 'Ani', online: false, secure: true, friend: true }, { id: 'p3', name: 'Citra', online: true, secure: true, friend: !!fr }];
    state.peers = peerList(false);
    state.bios = { me: 'Hidup itu indah', peer: 'Sibuk, balas nanti' };
    state.limits.maxBio = 140;
    state.groups = [{ id: 'gg1', name: 'Tim', creator: 'peer', members: [{ id: 'me', name: 'Saya' }, { id: 'peer', name: 'Budi' }] }];
    await tabClick('public'); await upd();
    assert(['public', 'grup', 'teman'].every((t) => els.tabs.innerHTML.includes('data-tab="' + t + '"')), 'tiga tab');
    assert(els.tabs.innerHTML.includes('tab sel" data-tab="public"'));
    assert(!els.list.innerHTML.includes('Ani#') && !els.list.innerHTML.includes('Tim'), 'tab Publik: daftar teman/grup tidak ikut di kiri');
    assert.strictEqual(els.users.style.display, 'flex');
    assert(els.uhead.textContent.startsWith('Semua user') && els.uhead.textContent.endsWith('2/3 online'), els.uhead.textContent);
    assert(['Budi', 'Ani', 'Citra'].every((n) => els.ulist.innerHTML.includes(n)) && !els.ulist.innerHTML.includes('Kamu') && !els.ulist.innerHTML.includes('data-uid="me"'), 'publik: semua orang lain di kanan, diri sendiri tidak ditampilkan');
    assert(els.ulist.innerHTML.includes('Sibuk, balas nanti') && !els.ulist.innerHTML.includes('Hidup itu indah') && els.ulist.innerHTML.includes('Hallo...'), 'deskripsi orang lain tampil (milik sendiri tidak); tanpa pengaturan = Hallo...');
    assert.strictEqual(els.newgrp.style.display, 'none');

    await tabClick('grup');
    assert(els.tabs.innerHTML.includes('tab sel" data-tab="grup"') && els.list.innerHTML.includes('Tim') && !els.list.innerHTML.includes('Budi#'));
    assert(els.head.innerHTML.includes('Tim') && els.users.style.display === 'flex' && els.newgrp.style.display === '');
    assert(els.uhead.textContent.startsWith('Anggota grup') && els.uhead.textContent.endsWith('1/1 online'), els.uhead.textContent);
    assert(els.ulist.innerHTML.includes('Budi') && els.ulist.innerHTML.includes('data-usec="Pemilik"') && els.ulist.innerHTML.includes('aria-label="Pemilik"') && !els.ulist.innerHTML.includes('Ani') && !els.ulist.innerHTML.includes('Kamu'), 'grup: hanya anggota lain di kanan, pemilik di bagian Pemilik dengan lencana');

    await tabClick('teman');
    assert(els.users.style.display === 'none', 'DM: tidak ada panel kanan');
    assert(['Budi#peer', 'Ani#p2'].every((n) => els.list.innerHTML.includes(n)) && !els.list.innerHTML.includes('Citra#p3') && !els.list.innerHTML.includes('Obrolan lain'), 'Teman: hanya yang sudah ditambah');
    assert(els.head.innerHTML.includes('data-uid="peer"') && els.head.innerHTML.includes('>Budi#peer</span>'), 'judul DM: nama bisa diklik');
    ok('tata letak: tab Publik/Grup/Teman di kiri; Teman hanya berisi teman; kanan = semua user (publik) / anggota (grup) / tidak ada (DM); bio tampil, bawaan "Hallo..."');

    // ---- profil: klik orang di kanan ----
    await tabClick('public'); await userClick('p3');
    assert.strictEqual(els.pmodal.style.display, 'flex');
    let pb = els.pbody.innerHTML;
    assert(pb.includes('Citra') && pb.includes('Hallo...') && /data-pact="friend"[^>]*aria-label="Teman"[^>]*><svg/.test(pb) && /data-pact="chat"[^>]*aria-label="Chat"[^>]*><svg/.test(pb) && !/<\/svg>(Teman|Chat)<\/button>/.test(pb) && !pb.includes('Hapus teman') && !pb.includes('Blokir') && pb.includes('data-pact="menu"') && !pb.includes('pbio'), 'profil orang lain: info + tombol utama hanya + Teman dan Chat; Blokir/Hapus teman tersembunyi di menu ⋮');
    assert.deepStrictEqual((await pact('friend'))[0], ['addFriend', 'p3']);
    state = Object.assign({}, state, { peers: peerList(true) }); await upd();
    pb = els.pbody.innerHTML;
    assert(/<svg class="ic fil"[^>]*>.*?<\/svg>Teman/.test(pb), 'sudah berteman: status Teman tampil');
    assert(!/data-pact=\"friend\"[^>]*aria-label=\"Teman\"/.test(pb) && !pb.includes('Tambah teman') && /data-pact=\"chat\"[^>]*aria-label=\"Chat\"/.test(pb) && !pb.includes('Hapus teman'), 'sudah berteman: tombol + Teman hilang, Hapus teman belum tampil sebelum menu dibuka');
    await pact('menu'); pb = els.pbody.innerHTML;
    assert(/<\/svg>Hapus teman<\/button>/.test(pb) && /<\/svg>Blokir<\/button>/.test(pb) && pb.indexOf('Hapus teman') < pb.indexOf('Blokir'), 'menu ⋮: Hapus teman di atas Blokir');
    assert.deepStrictEqual((await pact('unfriend'))[0], ['removeFriend', 'p3']);
    state = Object.assign({}, state, { peers: peerList(false) }); await upd();
    failErr = 'Orang ini belum pernah terlihat di jaringan'; els.toast.textContent = '';
    await pact('friend'); failErr = null;
    assert.strictEqual(els.toast.textContent, 'Orang ini belum pernah terlihat di jaringan', 'galat jadi toast');
    ok('profil orang lain: + Teman / Hapus teman (di menu ⋮) memanggil api yang benar dan tombolnya berganti; galat tampil sebagai toast');

    // Chat dengan orang yang belum jadi teman: percakapan tampil di "Obrolan lain", bukan di daftar teman
    await pact('chat');
    assert.strictEqual(els.pmodal.style.display, 'none');
    assert(els.head.innerHTML.includes('>Citra#p3</span>') && els.users.style.display === 'none' && els.tabs.innerHTML.includes('tab sel" data-tab="teman"'));
    assert(els.list.innerHTML.includes('Obrolan lain') && els.list.innerHTML.includes('Citra#p3'));
    ok('tombol Chat membuka chat privat; yang belum jadi teman tampil di "Obrolan lain"');

    // profil sendiri: ubah deskripsi
    await tabClick('public'); await userClick('me');
    pb = els.pbody.innerHTML;
    assert(pb.includes('id="pbio"') && pb.includes('Hidup itu indah') && pb.includes('Simpan') && !pb.includes('Tambah teman') && pb.includes('maxlength="140"'), 'profil sendiri: kotak deskripsi');
    els.pbio = { value: 'Semangat terus!' };
    assert.deepStrictEqual((await pact('save'))[0], ['setBio', 'Semangat terus!']);
    assert.strictEqual(els.pmodal.style.display, 'none', 'tersimpan: modal menutup');
    // ganti nama: lewat ikon pensil di profil sendiri (bukan input di sidebar)
    await userClick('me'); pb = els.pbody.innerHTML;
    assert(/data-pact="editname"[^>]*aria-label="Ubah nama"/.test(pb) && !pb.includes('id="pname"'), 'profil sendiri: ada pensil, belum mode ubah');
    await pact('editname'); pb = els.pbody.innerHTML;
    assert(pb.includes('id="pname"') && pb.includes('data-pact="savename"') && pb.includes('data-pact="cancelname"'), 'mode ubah: input + simpan + batal');
    els.pname = { value: '   ' }; assert.deepStrictEqual(await pact('savename'), [], 'nama kosong: tidak dikirim');
    els.pname = { value: '  Nama Baru  ' }; assert.deepStrictEqual((await pact('savename'))[0], ['setName', 'Nama Baru']);
    assert(!els.pbody.innerHTML.includes('id="pname"'), 'tersimpan: kembali ke tampilan biasa');
    await pact('editname'); await pact('cancelname'); assert(!els.pbody.innerHTML.includes('id="pname"'), 'batal: kembali, tanpa panggilan'); 
    await els.pmodal.onclick({ target: els.pmodal });
    ok('ganti nama: pensil -> input, kosong ditolak, simpan lewat api.setName (dipangkas), batal');
    await userClick('peer'); await els.pmodal.onclick({ target: els.pmodal });
    assert.strictEqual(els.pmodal.style.display, 'none', 'klik latar menutup');
    await userClick('peer'); await els.pmodal.onclick({ target: els.pmodal });
    assert.strictEqual(els.pmodal.style.display, 'none');
    ok('profil sendiri: deskripsi disimpan lewat api.setBio; klik latar menutup profil (tanpa tombol Tutup)');

    // ---- v0.7.4: klik nama di chat, judul chat privat, pencarian user, foto, pertemanan dua arah ----
    const stateBefore = state; // tes v0.7.4 memakai data sendiri; keadaan semula dipulihkan di akhir
    const msgClick = async (uid) => { await els.msgs.onclick({ target: { closest: (sel) => (sel === '[data-uid]' ? { dataset: { uid } } : null) } }); };
    const setQ = async (v) => { els.usearch.value = v; els.usearch.oninput(); };
    const names = () => [...els.ulist.innerHTML.matchAll(/data-uid="([^"]*)"/g)].map((m) => m[1]);
    state = Object.assign({}, state, { peers: [
      { id: 'a3f21111', name: 'Budi', online: true, secure: true, friend: true, fst: 'ok' },
      { id: 'a3f29999', name: 'budiman', online: false, secure: true, friend: false, fst: '' },
      { id: 'c0de0000', name: 'Ani Çelik', online: true, secure: true, friend: false, fst: '' },
    ], groups: [], messages: [{ id: 'e'.repeat(32), from: 'a3f21111', to: 'public', ts: 20, name: 'Budi', text: 'halo' }, { id: 'f'.repeat(32), from: 'me', to: 'public', ts: 21, name: 'Saya', text: 'hai juga' }], bios: {}, avatars: {} });
    await tabClick('public'); await upd();
    assert(els.msgs.innerHTML.includes('class="who lk" data-uid="a3f21111"') && els.msgs.innerHTML.includes('data-uid="me"'), 'nama pengirim di chat bisa diklik');
    await msgClick('a3f21111');
    assert.strictEqual(els.pmodal.style.display, 'flex');
    assert(els.pbody.innerHTML.includes('Budi') && /<svg class="ic fil"[^>]*>.*?<\/svg>Teman/.test(els.pbody.innerHTML), 'klik nama di chat membuka profil, tanpa lewat daftar user');
    await els.pmodal.onclick({ target: els.pmodal });
    await msgClick('me');
    assert(els.pbody.innerHTML.includes('id="pbio"'), 'klik namaku sendiri: profil sendiri (ubah deskripsi/foto)');
    await els.pmodal.onclick({ target: els.pmodal });
    await listClick('a3f21111'); // DM: judul chat privat
    await els.head.onclick({ target: { closest: (sel) => (sel === '[data-uid]' ? { dataset: { uid: 'a3f21111' } } : null) } });
    assert.strictEqual(els.pmodal.style.display, 'flex', 'klik nama di judul chat privat membuka profil');
    await els.pmodal.onclick({ target: els.pmodal });
    ok('klik nama pengirim di chat dan nama di judul chat privat membuka profil (tidak perlu mencari di daftar user)');

    // pencarian di panel kanan
    await tabClick('public'); await upd();
    assert.deepStrictEqual(names().sort(), ['a3f21111', 'a3f29999', 'c0de0000'], 'semua orang lain tampil tanpa kata kunci (diri sendiri tidak)');
    assert(els.usearch.value === '');
    await setQ('BUDI');
    assert.deepStrictEqual(names().sort(), ['a3f21111', 'a3f29999'], 'huruf besar/kecil tidak dibedakan, cocok di bagian mana pun nama');
    assert(els.uhead.textContent.endsWith('cocok 2'), els.uhead.textContent);
    await setQ('  budiman ');
    assert.deepStrictEqual(names(), ['a3f29999'], 'spasi di tepi diabaikan');
    await setQ('#a3f2');
    assert.deepStrictEqual(names().sort(), ['a3f21111', 'a3f29999'], '#id = awalan id');
    await setQ('#A3F29');
    assert.deepStrictEqual(names(), ['a3f29999'], '#id juga tidak membedakan huruf besar/kecil');
    await setQ('budi#a3f2');
    assert.deepStrictEqual(names().sort(), ['a3f21111', 'a3f29999'], 'nama#id: keduanya harus cocok');
    await setQ('ani#a3f2');
    assert.deepStrictEqual(names(), [], 'nama cocok tapi id tidak');
    assert(els.ulist.innerHTML.includes('Tidak ada yang cocok'), 'pesan kosong');
    await setQ('#zzzz'); assert.deepStrictEqual(names(), []);
    await setQ('#'); assert.strictEqual(names().length, 3, '# saja = semua');
    await setQ('çelik'); assert.deepStrictEqual(names(), ['c0de0000']);
    await setQ('<b>x');
    assert(els.ulist.innerHTML.includes('&lt;b&gt;x') && !els.ulist.innerHTML.includes('<b>x'), 'kata kunci di-escape');
    await setQ('kamu'); assert.deepStrictEqual(names(), [], 'diri sendiri tidak ada di daftar, jadi tidak bisa dicari');
    await setQ('budi'); await els.usearch.onkeydown({ key: 'Escape' });
    assert.strictEqual(els.usearch.value, '', 'Esc mengosongkan pencarian');
    assert.strictEqual(names().length, 3);
    await setQ('budi'); await tabClick('teman');
    assert.strictEqual(els.usearch.value, '', 'pindah chat mengosongkan pencarian');
    await tabClick('public');
    ok('pencarian user: nama (tanpa beda huruf besar/kecil, cocok di mana pun), #id (awalan), nama#id, kosong -> pesan, di-escape, Esc dan pindah chat membersihkan');

    // foto: tampil sebagai gambar bila ada, huruf bila tidak; tombol ganti/hapus di profil sendiri
    state = Object.assign({}, state, { avatars: { a3f21111: 'data:image/jpeg;base64,AAAA' } }); await upd();
    assert(els.ulist.innerHTML.includes('<img src="data:image/jpeg;base64,AAAA"'), 'foto tampil di daftar user');
    assert(els.ulist.innerHTML.includes('>A</div>') && els.ulist.innerHTML.includes('>B</div>'), 'tanpa foto: huruf pertama nama');
    state = Object.assign({}, state, { avatars: { a3f21111: '"><img src=x onerror=alert(1)>' } }); await upd();
    assert(!/<img src=x/.test(els.ulist.innerHTML), 'sumber foto di-escape');
    state = Object.assign({}, state, { avatars: {} }); await upd();
    await userClick('me');
    assert(els.pbody.innerHTML.includes('data-pact="avmenu"') && !els.pbody.innerHTML.includes('Pasang foto') && !els.pbody.innerHTML.includes('data-pact="photo"'), 'foto profil: menu tertutup sampai bola foto diketuk');
    await pact('avmenu');
    assert(/<\/svg>Pasang foto<\/button>/.test(els.pbody.innerHTML) && !els.pbody.innerHTML.includes('Hapus foto'), 'tanpa foto: menu hanya Pasang foto');
    let clicked = 0; els.pfile.click = () => { clicked++; };
    await pact('photo');
    assert.strictEqual(clicked, 1, 'tombol foto membuka pemilih berkas');
    assert(!els.pbody.innerHTML.includes('data-pact="photo"'), 'menu menutup setelah memilih');
    state = Object.assign({}, state, { avatars: { me: 'data:image/jpeg;base64,AAAA' } }); await upd();
    await pact('avmenu');
    assert(els.pbody.innerHTML.includes('Ganti foto') && els.pbody.innerHTML.includes('Hapus foto') && els.pbody.innerHTML.includes('<img'));
    assert.deepStrictEqual((await pact('rmphoto'))[0], ['setAvatar', '']);
    // gambar dipilih: dikecilkan di renderer (Avatar.fromFile, dipalsukan di sini karena butuh canvas) lalu dikirim ke api.setAvatar
    const realFrom = ctx.Avatar.fromFile;
    els.pfile.files = [{ name: 'a.png', size: 5 }]; els.pfile.value = 'x'; calls.length = 0;
    let gotName = null; ctx.Avatar.fromFile = async (f) => { gotName = f.name; return 'QkFTRTY0'; };
    await els.pfile.onchange();
    assert.strictEqual(gotName, 'a.png');
    assert.deepStrictEqual(calls.find((c) => c[0] === 'setAvatar'), ['setAvatar', 'QkFTRTY0']);
    assert.strictEqual(els.pfile.value, '', 'input dikosongkan supaya gambar yang sama bisa dipilih lagi');
    failErr = 'Foto tidak valid'; els.toast.textContent = ''; els.pfile.files = [{ name: 'b.png', size: 5 }];
    await els.pfile.onchange(); failErr = null;
    assert.strictEqual(els.toast.textContent, 'Foto tidak valid', 'galat dari Core tampil sebagai toast');
    ctx.Avatar.fromFile = async () => { throw new Error('Berkas ini bukan gambar yang bisa dibaca'); };
    els.pfile.files = [{ name: 'c.txt', size: 5 }]; calls.length = 0;
    await els.pfile.onchange();
    assert.strictEqual(els.toast.textContent, 'Berkas ini bukan gambar yang bisa dibaca');
    assert(!calls.some((c) => c[0] === 'setAvatar'), 'gagal dikecilkan: tidak ada yang dikirim');
    els.pfile.files = []; calls.length = 0; await els.pfile.onchange();
    assert(!calls.some((c) => c[0] === 'setAvatar'), 'dibatalkan: tidak ada yang dikirim');
    ctx.Avatar.fromFile = realFrom;
    await els.pmodal.onclick({ target: els.pmodal });
    ok('foto: gambar di daftar user dan profil (di-escape), huruf bila tanpa foto, tombol Pasang/Ganti/Hapus foto');

    // pertemanan dua arah di UI: keadaan tombol per status
    state = Object.assign({}, state, { peers: state.peers.map((p) => (p.id === 'c0de0000' ? Object.assign({}, p, { fst: 'in' }) : p.id === 'a3f29999' ? Object.assign({}, p, { fst: 'out' }) : p)) });
    await upd();
    await userClick('c0de0000'); pb = els.pbody.innerHTML;
    assert(/data-pact=\"friend\"[^>]*aria-label=\"Terima\"/.test(pb) && /data-pact=\"unfriend\"[^>]*aria-label=\"Tolak\"/.test(pb) && pb.includes('ingin berteman') && !/data-pact=\"friend\"[^>]*aria-label=\"Teman\"/.test(pb), 'permintaan masuk: Terima / Tolak');
    assert.deepStrictEqual((await pact('friend'))[0], ['addFriend', 'c0de0000'], 'Terima = addFriend');
    await userClick('c0de0000'); assert.deepStrictEqual((await pact('unfriend'))[0], ['removeFriend', 'c0de0000'], 'Tolak = removeFriend');
    await userClick('a3f29999'); pb = els.pbody.innerHTML;
    assert(pb.includes('Menunggu dia menyetujui') && !/<svg class="ic fil"[^>]*>.*?<\/svg>Teman/.test(pb) && !/data-pact=\"friend\"[^>]*aria-label=\"Teman\"/.test(pb), 'permintaan terkirim: menunggu');
    await pact('menu'); assert(/<\/svg>Batalkan permintaan<\/button>/.test(els.pbody.innerHTML), 'Batalkan permintaan ada di menu ⋮');
    assert.deepStrictEqual((await pact('unfriend'))[0], ['removeFriend', 'a3f29999']);
    await tabClick('teman');
    const L = els.list.innerHTML;
    assert(L.includes('Budi#a3f211') && L.includes('Permintaan teman') && L.includes('Ani Çelik#c0de00') && L.includes('Menunggu persetujuan') && L.includes('budiman#a3f299'), 'tab Teman: teman, permintaan masuk, menunggu');
    assert(L.indexOf('Budi#a3f211') < L.indexOf('Permintaan teman') && L.indexOf('Permintaan teman') < L.indexOf('Menunggu persetujuan'));
    assert(/data-id="c0de0000" data-prof="1"/.test(L) && !/data-id="a3f21111" data-prof/.test(L), 'baris permintaan membuka profil; teman membuka chat');
    await els.list.onclick({ target: { closest: (sel) => (sel === '.item' ? { dataset: { id: 'c0de0000', prof: '1' } } : null) } }); // baris permintaan (data-prof): profil, bukan chat
    assert.strictEqual(els.pmodal.style.display, 'flex'); assert(els.head.innerHTML.includes('>Budi#a3f211</span>'), 'tetap di chat sebelumnya');
    await els.pmodal.onclick({ target: els.pmodal });
    assert(/data-tab="teman"[^>]*>[^]*?<span>Teman<\/span><span class="badge">1<\/span>/.test(els.tabs.innerHTML), 'badge tab Teman memuat permintaan masuk');
    await tabClick('public');
    ok('pertemanan dua arah di UI: Terima/Tolak, menunggu + Batalkan, bagian Permintaan teman/Menunggu persetujuan di tab Teman, badge permintaan masuk');

    state = stateBefore; await upd();

    // pesan belum dibaca per tab; tab kosong tetap terbuka dengan petunjuk
    state = Object.assign({}, state, { messages: state.messages.concat([{ id: 'd'.repeat(32), from: 'p2', to: 'me', ts: 9, name: 'Ani', text: 'hai' }]) });
    await upd();
    assert(/data-tab="teman"[^>]*>[^]*?<span>Teman<\/span><span class="badge">1<\/span>/.test(els.tabs.innerHTML) && !/<span>Publik<\/span><span class="badge"/.test(els.tabs.innerHTML), 'badge di tab Teman');
    await listClick('p2');
    assert(!els.tabs.innerHTML.includes('class="badge"'), 'dibuka: badge hilang');
    state = Object.assign({}, state, { groups: [] }); await upd();
    await tabClick('grup');
    assert(els.list.innerHTML.includes('Belum ada grup') && els.tabs.innerHTML.includes('tab sel" data-tab="grup"') && els.newgrp.style.display === '');
    state = Object.assign({}, state, { peers: peerList(false).map((p) => Object.assign({}, p, { friend: false })), messages: state.messages.filter((m) => m.from !== 'p2') });
    await tabClick('public'); await upd(); await tabClick('teman');
    assert(els.list.innerHTML.includes('Belum ada teman') && !els.list.innerHTML.includes('Obrolan lain') && els.tabs.innerHTML.includes('tab sel" data-tab="teman"'));
    await tabClick('public');
    ok('badge belum dibaca per tab; tab Grup/Teman yang kosong tetap terbuka dengan petunjuk');
  }

  // ---- v0.8.0: peran grup (pembuat/admin/anggota), ganti nama, bubarkan, blokir ----
  {
    const tabClick = async (t) => { await els.tabs.onclick({ target: { closest: (sel) => (sel === '[data-tab]' ? { dataset: { tab: t } } : null) } }); };
    const userClick = async (uid) => { await els.ulist.onclick({ target: { closest: (sel) => (sel === '.urow' ? { dataset: { uid } } : null) } }); };
    const pact = async (act, extra) => { calls.length = 0; await els.pmodal.onclick({ target: { closest: (sel) => (sel === '[data-pact]' ? { dataset: Object.assign({ pact: act }, extra || {}) } : null) } }); return calls.slice(); };
    const upd = async () => { await updCb(); await new Promise((r) => setImmediate(r)); };
    const members = (meId) => [{ id: 'own', name: 'Pembuat' }, { id: 'adm', name: 'Admin' }, { id: 'mem', name: 'Biasa' }].concat(['own', 'adm', 'mem'].includes(meId) ? [] : [{ id: meId, name: 'Saya' }]); // yang melihat selalu anggota
    const mkState = (meId, extra) => Object.assign({}, state, { me: { id: meId, name: 'Saya', port: 1 }, blocked: [], messages: [], sending: [],
      peers: [{ id: 'own', name: 'Pembuat', online: true, secure: true }, { id: 'adm', name: 'Admin', online: true, secure: true }, { id: 'mem', name: 'Biasa', online: false, secure: true }, { id: 'zz', name: 'Orang Luar', online: true, secure: true }],
      groups: [{ id: 'g0123456789abcde'.slice(0, 16), name: 'Tim Seru', creator: 'own', admins: ['adm'], members: members(meId), epoch: 3 }] }, extra || {});
    const GID = 'g0123456789abcde'.slice(0, 16);
    const btnList = []; // tombol palsu yang dikembalikan querySelectorAll, supaya onclick-nya bisa dipanggil
    doc.querySelectorAll = (sel) => { // tombol di HTML modal anggota dibuat saat renderMembers memintanya; onclick yang dipasang UI bisa dipanggil tes
      const m = /^\[(data-\w+)\]$/.exec(sel);
      if (!m) return [];
      if (m[1] === 'data-kick') btnList.length = 0; // pemanggilan pertama tiap render
      const out = [];
      for (const x of doc.getElementById('mbody').innerHTML.matchAll(new RegExp('<button[^>]*?' + m[1] + '="([^"]+)"(?:[^>]*?data-on="(\\d)")?[^>]*>', 'g'))) out.push({ attr: m[1], dataset: { [m[1].slice(5)]: x[1], on: x[2] }, onclick: null });
      btnList.push(...out);
      return out;
    };
    const openMem = async (meId, extra) => {
      state = mkState(meId, extra); doc.getElementById('mmodal').style.display = 'none';
      await tabClick('grup'); await upd();
      await doc.getElementById('membtn').onclick();
      return doc.getElementById('mbody').innerHTML;
    };
    await tabClick('public'); state = mkState('own'); await upd();

    // pembuat: semua tombol
    let h = await openMem('own');
    assert(h.includes('ID grup: <code>' + GID + '</code>') && h.includes('id="mrename"') && h.includes('value="Tim Seru"') && h.includes('id="mdisband"'), 'pembuat: ID grup, ganti nama, bubarkan');
    assert(/data-adm="adm" data-on="0">Cabut admin/.test(h) && /data-adm="mem" data-on="1">Jadikan admin/.test(h), 'pembuat: atur admin');
    assert(h.includes('data-kick="adm"') && h.includes('data-kick="mem"') && !h.includes('data-kick="own"') && !h.includes('data-kick="me"'), 'pembuat: keluarkan siapa saja kecuali dirinya');
    assert(/class="role own">pemilik/.test(h) && /class="role">admin/.test(h));
    calls.length = 0;
    await btnList.find((b) => b.attr === 'data-kick' && b.dataset.kick === 'mem').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'removeMember'), ['removeMember', GID, 'mem']);
    calls.length = 0; await btnList.find((b) => b.attr === 'data-adm' && b.dataset.adm === 'mem').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'setGroupAdmin'), ['setGroupAdmin', GID, 'mem', true]);
    calls.length = 0; await btnList.find((b) => b.attr === 'data-adm' && b.dataset.adm === 'adm').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'setGroupAdmin'), ['setGroupAdmin', GID, 'adm', false]);
    calls.length = 0; doc.getElementById('mrename').value = 'Nama Baru'; await doc.getElementById('mrenok').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'renameGroup'), ['renameGroup', GID, 'Nama Baru']);
    calls.length = 0; await doc.getElementById('mdisband').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'disbandGroup'), ['disbandGroup', GID]);
    assert.strictEqual(doc.getElementById('mmodal').style.display, 'none', 'modal tertutup setelah bubarkan');
    ok('modal anggota (pembuat): ID grup, ganti nama, jadikan/cabut admin, keluarkan, bubarkan memanggil api yang benar');

    // foto grup (v0.26.0): admin/pemilik punya tombol; anggota biasa hanya melihat fotonya; foto tampil di daftar grup dan header chat
    const AVU = 'data:image/jpeg;base64,/9j/AAAA';
    h = await openMem('own');
    assert(h.includes('id="mgphoto"') && h.includes('Pasang foto grup') && !h.includes('id="mgrm"'), 'pembuat tanpa foto: Pasang foto grup, tanpa tombol Hapus');
    h = await openMem('own', { groups: [{ id: GID, name: 'Tim Seru', creator: 'own', admins: ['adm'], members: members('own'), epoch: 3, av: AVU }] });
    assert(h.includes('id="mgphoto"') && h.includes('Ganti foto grup') && h.includes('id="mgrm"') && h.includes('src="' + AVU + '"'), 'pembuat dengan foto: Ganti + Hapus, foto tampil');
    assert(doc.getElementById('gfile'), 'ada input berkas untuk foto grup');
    h = await openMem('mem', { groups: [{ id: GID, name: 'Tim Seru', creator: 'own', admins: ['adm'], members: members('mem'), epoch: 3, av: AVU }] });
    assert(h.includes('src="' + AVU + '"') && !h.includes('id="mgphoto"') && !h.includes('id="mgrm"'), 'anggota biasa: melihat foto, tanpa tombol ubah');
    h = await openMem('mem');
    assert(!h.includes('class="mgav"'), 'anggota biasa tanpa foto: tidak ada bagian foto');
    ok('foto grup di modal anggota: pemilik/admin dapat Pasang/Ganti/Hapus, anggota biasa hanya melihat');

    // admin: hanya keluarkan anggota biasa + ganti nama + tambah
    h = await openMem('adm');
    assert(h.includes('id="mrename"') && !h.includes('id="mdisband"') && !h.includes('data-adm='), 'admin: ganti nama, tanpa bubarkan dan atur admin');
    assert(h.includes('data-kick="mem"') && !h.includes('data-kick="own"') && !h.includes('data-kick="adm"') && !h.includes('data-kick="me"'), 'admin: hanya anggota biasa yang bisa dikeluarkan');
    assert(h.includes('Tambah anggota') && h.includes('Orang Luar'));
    // anggota biasa: tidak ada tombol sama sekali
    h = await openMem('mem');
    assert(!h.includes('data-kick=') && !h.includes('data-adm=') && !h.includes('id="mrename"') && !h.includes('id="mdisband"') && !h.includes('Tambah anggota') && h.includes('Hanya pemilik grup dan admin'), 'anggota biasa: hanya melihat');
    ok('modal anggota: admin hanya bisa keluarkan anggota biasa/ganti nama/tambah (tanpa bubarkan & atur admin); anggota biasa tidak melihat tombol apa pun');

    // v0.9.0: pindah pemilik dan keluar dari grup
    h = await openMem('own');
    assert(h.includes('data-own="adm"') && h.includes('data-own="mem"') && !h.includes('data-own="own"') && !h.includes('data-own="me"'), 'pemilik: Jadikan pemilik untuk setiap anggota lain (admin maupun biasa)');
    assert(h.includes('id="mleave"') && h.includes('id="mleaveto"') && h.includes('Otomatis (admin tertua') && h.includes('<option value="adm">') && h.includes('(admin)'), 'pemilik: Keluar + pilihan penerima kepemilikan (default otomatis, admin ditandai)');
    calls.length = 0; await btnList.find((b) => b.attr === 'data-own' && b.dataset.own === 'mem').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'transferOwner'), ['transferOwner', GID, 'mem']);
    const ownSaved = ctx.confirm; let askText = ''; ctx.confirm = (t) => { askText = t; return false; };
    calls.length = 0; await btnList.find((b) => b.attr === 'data-own' && b.dataset.own === 'mem').onclick(); ctx.confirm = ownSaved;
    assert(!calls.some((c) => c[0] === 'transferOwner') && /tetap di grup sebagai admin/.test(askText), 'batal di konfirmasi: tidak memindahkan; konfirmasi menjelaskan pemilik lama jadi admin');
    doc.getElementById('mleaveto').value = '';
    calls.length = 0; await doc.getElementById('mleave').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'leaveGroup'), ['leaveGroup', GID, undefined], 'pemilik tanpa pilihan: otomatis');
    assert.strictEqual(doc.getElementById('mmodal').style.display, 'none', 'modal tertutup setelah keluar');
    h = await openMem('own'); doc.getElementById('mleaveto').value = 'mem';
    calls.length = 0; await doc.getElementById('mleave').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'leaveGroup'), ['leaveGroup', GID, 'mem'], 'pemilik memilih penerima');
    ok('modal anggota (pemilik): Jadikan pemilik (dengan konfirmasi), Keluar dengan penerima otomatis atau pilihan memanggil api yang benar');

    h = await openMem('adm');
    assert(h.includes('id="mleave"') && !h.includes('id="mleaveto"') && !h.includes('data-own='), 'admin: bisa keluar, tanpa pilihan penerima dan tanpa Jadikan pemilik');
    calls.length = 0; await doc.getElementById('mleave').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'leaveGroup'), ['leaveGroup', GID, undefined]);
    h = await openMem('mem');
    assert(h.includes('id="mleave"') && !h.includes('id="mleaveto"') && !h.includes('data-own='), 'anggota biasa: bisa keluar');
    calls.length = 0; await doc.getElementById('mleave').onclick();
    assert.deepStrictEqual(calls.find((c) => c[0] === 'leaveGroup'), ['leaveGroup', GID, undefined], 'anggota biasa tidak pernah mengirim penerima kepemilikan');
    ok('modal anggota: admin dan anggota biasa melihat tombol Keluar (tanpa pilihan penerima), api dipanggil tanpa penerima');

    h = await openMem('own', { groups: [{ id: GID, name: 'Tim Seru', creator: 'own', admins: ['adm'], members: members('own'), epoch: 3, leaving: ['mem'] }] });
    assert(/class="role">keluar/.test(h) && !h.includes('data-kick="mem"') && !h.includes('data-own="mem"') && !h.includes('data-adm="mem"') && !h.includes('<option value="mem">'), 'anggota yang sudah menyatakan keluar: ada tanda, tanpa tombol, bukan calon pemilik');
    h = await openMem('own', { groups: [{ id: GID, name: 'Sendiri', creator: 'own', admins: [], members: [{ id: 'own', name: 'Pembuat' }], epoch: 1 }] });
    assert(!h.includes('id="mleave"') && h.includes('id="mdisband"'), 'pemilik sendirian: tidak bisa keluar, hanya bubarkan');
    ok('anggota yang menunggu dikeluarkan ditandai "keluar" tanpa tombol; pemilik yang sendirian hanya melihat Bubarkan');

    // panel kanan + header: peran dan ID grup
    state = mkState('me'); doc.getElementById('mmodal').style.display = 'none'; await tabClick('grup'); await upd();
    assert(els.head.innerHTML.includes('Tim Seru') && els.head.innerHTML.includes('#g012'), 'ID pendek grup di judul');
    assert(/data-usec="Pemilik"[\s\S]*?Pembuat[\s\S]*?bdg own/.test(els.ulist.innerHTML) && /data-usec="Admin"[\s\S]*?Admin[\s\S]*?bdg adm/.test(els.ulist.innerHTML), 'panel kanan: bagian Pemilik dan Admin dengan lencana mahkota');
    // v0.25.1: tanpa baris sendiri; bagian Pemilik / Admin / Teman / Tidak dikenal; lencana mahkota emas, mahkota perak, bintang
    {
      const GIDX = 'g0123456789abcde'.slice(0, 16);
      const pe = (fr) => [{ id: 'own', name: 'Pembuat', online: true, secure: true }, { id: 'adm', name: 'Admin', online: true, secure: true, friend: true }, { id: 'mem', name: 'Biasa', online: false, secure: true, friend: fr }, { id: 'zz', name: 'Orang Luar', online: true, secure: true }];
      const msg = { id: 'mx1', from: 'own', name: 'Pembuat', to: 'g:' + GIDX, ts: Date.now(), text: 'halo' };
      state = mkState('me', { peers: pe(true), messages: [msg] }); await upd();
      let h = els.ulist.innerHTML;
      assert(!h.includes('data-uid=\"me\"') && !h.includes('Kamu'), 'diri sendiri tidak ada di daftar anggota');
      const ix = (k) => h.indexOf('data-usec=\"' + k + '\"');
      assert(ix('Pemilik') >= 0 && ix('Pemilik') < ix('Admin') && ix('Admin') < ix('Teman') && ix('Tidak dikenal') < 0, 'urutan bagian: Pemilik, Admin, Teman; bagian kosong disembunyikan');
      const row = (id) => new RegExp('data-uid=\"' + id + '\"[\\s\\S]*?(?=data-uid=|$)').exec(h)[0];
      assert(/bdg own/.test(row('own')) && !/bdg fr/.test(row('own')), 'pemilik (bukan teman): mahkota emas saja');
      assert(/bdg adm/.test(row('adm')) && /bdg fr/.test(row('adm')) && !/bdg own/.test(row('adm')), 'admin yang juga teman: mahkota perak + bintang');
      assert(/bdg fr/.test(row('mem')) && !/bdg own|bdg adm/.test(row('mem')), 'anggota teman: bintang saja');
      assert(/class=\"who lk\"[^>]*>Pembuat#[0-9a-z]+<span class=\"bdg own\"/.test(els.msgs.innerHTML), 'nama pengirim di gelembung chat ikut berlencana');
      state = mkState('me', { peers: pe(false) }); await upd(); h = els.ulist.innerHTML;
      assert(ix('Tidak dikenal') > ix('Admin') && !/bdg/.test(row('mem')) && ix('Teman') < 0, 'bukan teman: bagian Tidak dikenal, tanpa lencana apa pun; bagian Teman kosong hilang');
      // saya sendiri pemilik: bagian Pemilik kosong tidak tampil
      state = mkState('own', { peers: [{ id: 'me', name: 'Saya', online: true, secure: true }].concat(pe(false).filter((x) => x.id !== 'own')) }); await upd(); h = els.ulist.innerHTML;
      assert(!h.includes('data-usec=\"Pemilik\"') && h.includes('data-usec=\"Admin\"'), 'jika aku pemilik: tidak ada bagian Pemilik');
      state = mkState('me'); await upd();
      ok('daftar anggota: tanpa diri sendiri, bagian Pemilik/Admin/Teman/Tidak dikenal, lencana mahkota emas/perak dan bintang (juga di nama pengirim)');
    }
    // orang yang diblokir hilang dari panel kanan, judul, dan daftar publik
    state = mkState('me', { blocked: [{ id: 'adm', name: 'Admin', at: 1 }], peers: mkState('me').peers.filter((p) => p.id !== 'adm') }); await upd();
    assert(!els.ulist.innerHTML.includes('Admin') && els.ulist.innerHTML.includes('Biasa') && !els.head.innerHTML.includes('Admin'), 'yang diblokir hilang dari anggota grup (panel kanan dan judul)');
    await tabClick('public'); await upd();
    assert(!els.ulist.innerHTML.includes('Admin#') && els.ulist.innerHTML.includes('Orang Luar'), 'hilang dari daftar publik');
    await tabClick('grup'); await doc.getElementById('membtn').onclick();
    assert(/class="tg blk"[^>]*><svg[\s\S]*?<\/svg> diblokir/.test(doc.getElementById('mbody').innerHTML), 'di modal anggota tetap ada (untuk pengelolaan) dengan tanda diblokir');
    doc.getElementById('mmodal').style.display = 'none';
    ok('panel kanan menandai pembuat/admin, judul grup memuat ID pendek; orang yang diblokir hilang dari panel kanan, judul, dan daftar publik');

    // blokir dari profil
    state = mkState('me'); await upd(); await tabClick('public'); await userClick('zz');
    await pact('menu'); let pb = els.pbody.innerHTML;
    assert(/<\/svg>Blokir<\/button>/.test(pb) && pb.includes('data-pact="block"'), 'profil orang lain: Blokir ada di menu ⋮');
    let r = await pact('block');
    assert.deepStrictEqual(r.find((c) => c[0] === 'blockUser'), ['blockUser', 'zz']);
    assert.strictEqual(els.pmodal.style.display, 'none', 'profil tertutup setelah memblokir');
    await userClick('zz');
    const saved = ctx.confirm; ctx.confirm = () => false;
    r = await pact('block'); ctx.confirm = saved;
    assert(!r.some((c) => c[0] === 'blockUser') && els.pmodal.style.display === 'flex', 'batal di konfirmasi: tidak memblokir');
    failErr = 'ID tidak valid'; await pact('block'); failErr = null;
    assert.strictEqual(els.pmodal.style.display, 'flex', 'galat: profil tetap terbuka');
    await els.pmodal.onclick({ target: els.pmodal });
    // profil sendiri memuat daftar blokir; orang terblokir: profilnya menawarkan Buka blokir
    state = mkState('me', { blocked: [{ id: 'zz', name: 'Orang <Luar>', at: 1 }], peers: mkState('me').peers.filter((p) => p.id !== 'zz') }); await upd();
    await userClick('me'); pb = els.pbody.innerHTML;
    assert(pb.includes('Diblokir (1)') && pb.includes('Orang &lt;Luar&gt;#zz') && pb.includes('data-pact="unblock"') && pb.includes('data-bid="zz"'), 'profil sendiri: daftar blokir (di-escape) + Buka blokir');
    r = await pact('unblock', { bid: 'zz' });
    assert.deepStrictEqual(r.find((c) => c[0] === 'unblockUser'), ['unblockUser', 'zz']);
    await els.pmodal.onclick({ target: els.pmodal });
    await userClick('zz'); // (tidak ada di daftar, tapi profil bisa dibuka dari tempat lain)
    pb = els.pbody.innerHTML;
    assert(pb.includes('Buka blokir') && !pb.includes('data-pact="block"') && pb.includes('memblokir orang ini') && !pb.includes('Tambah teman') && !/data-pact=\"chat\"[^>]*aria-label=\"Chat\"/.test(pb), 'profil orang terblokir: hanya Buka blokir');
    await els.pmodal.onclick({ target: els.pmodal });
    ok('blokir di profil: konfirmasi, batal/galat tidak memblokir, daftar blokir di profil sendiri (di-escape) dengan Buka blokir, profil orang terblokir hanya menawarkan Buka blokir');

    // chat privat yang sedang dibuka dengan orang yang baru diblokir: pindah ke Publik
    state = mkState('me', { peers: mkState('me').peers.map((p) => Object.assign({}, p, { friend: true, fst: 'ok' })) }); await upd();
    await tabClick('teman'); await els.list.onclick({ target: { closest: (sel) => (sel === '.item' ? { dataset: { id: 'zz' } } : null) } });
    assert(els.head.innerHTML.includes('Orang Luar'));
    state = mkState('me', { blocked: [{ id: 'zz', name: 'Orang Luar', at: 1 }], peers: mkState('me').peers.filter((p) => p.id !== 'zz') }); await upd();
    assert(els.head.innerHTML.includes('Obrolan publik'), 'chat privat dengan orang yang diblokir ditutup');
    ok('chat privat yang sedang dibuka ditutup (kembali ke Publik) saat lawan bicaranya diblokir');

    // pembubaran grup: toast untuk anggota
    remCb({ name: 'Tim Seru', by: 'Pembuat', disband: true });
    assert(/dibubarkan oleh Pembuat/.test(els.toast.textContent), els.toast.textContent);
    remCb({ name: 'Tim Seru', by: 'Pembuat' });
    assert(/dikeluarkan dari grup "Tim Seru" oleh Pembuat/.test(els.toast.textContent));
    // grup hilang saat modal anggota terbuka -> modal tertutup
    state = mkState('own'); await tabClick('grup'); await upd(); await doc.getElementById('membtn').onclick();
    assert.strictEqual(doc.getElementById('mmodal').style.display, 'flex');
    state = Object.assign({}, state, { groups: [] }); await upd();
    assert.strictEqual(doc.getElementById('mmodal').style.display, 'none', 'modal anggota tertutup bila grupnya hilang (dibubarkan)');
    await tabClick('public');
    ok('toast dibubarkan vs dikeluarkan; modal anggota menutup sendiri saat grup dibubarkan');
  }

  console.log(`\n${pass} tes UI OK`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', (e && e.stack) || e); process.exit(1); });
