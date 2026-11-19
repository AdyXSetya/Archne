'use strict';
// Tes foto (v0.25.0 Step 1), sisi renderer: pembuat thumbnail (renderer/archne-media.js), kartu berkas dengan foto (renderer/archne-filecard.js),
// kontrak preload/api-http untuk saluran baru, dan penampil foto (js/archne-imgview.js) dengan DOM palsu.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const FC = require('../renderer/archne-filecard');
const Media = require('../renderer/archne-media');
const O = require('../src/archne-fileoffer');
const { htmlSrc, inlineJs } = require('./_src');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 1. archne-media.js: batas sama dengan Core ----
  assert.deepStrictEqual(Media.TH_MAX, O.TH_MAX, 'batas karakter thumbnail renderer = Core');
  assert.strictEqual(Media.DIM_MAX, 16384);
  assert(Math.max(...Media.PLAN.direct.sizes, ...Media.PLAN.public.sizes) <= O.TH_DIM, 'ukuran thumbnail tidak melewati batas dimensi Core');
  assert(Math.max(...Media.PLAN.public.sizes) < Math.max(...Media.PLAN.direct.sizes), 'Publik lebih kecil dari DM/grup');
  assert.strictEqual(Media.kindOf('public'), 'public'); assert.strictEqual(Media.kindOf('g:abc'), 'direct'); assert.strictEqual(Media.kindOf('0123456789abcdef'), 'direct');
  ok('archne-media.js: batas karakter dan dimensi thumbnail sama dengan src/archne-fileoffer.js; Publik lebih kecil');

  // ---- 2. fitDims ----
  assert.deepStrictEqual(Media.fitDims(4000, 3000, 256), { w: 256, h: 192 });
  assert.deepStrictEqual(Media.fitDims(3000, 4000, 256), { w: 192, h: 256 });
  assert.deepStrictEqual(Media.fitDims(100, 50, 256), { w: 100, h: 50 }, 'tidak pernah diperbesar');
  assert.deepStrictEqual(Media.fitDims(10000, 10, 256), { w: 256, h: 1 }, 'sisi minimal 1');
  assert.deepStrictEqual(Media.fitDims(1, 1, 256), { w: 1, h: 1 });
  ok('fitDims: sisi terpanjang = batas, tidak diperbesar, sisi minimal 1');

  // ---- 3. pickThumb: ukuran/kualitas turun sampai muat; Publik lebih ketat ----
  const b64 = (n) => 'A'.repeat(n);
  const calls = [];
  let r = Media.pickThumb((s, q) => { calls.push([s, q]); return b64(s * 40); }, '0123456789abcdef'); // 256 -> 10240 (kebesaran), 192 -> 7680, 144 -> 5760 (muat)
  assert(r && r.size === 144 && r.b64.length === 5760, JSON.stringify(r));
  assert.deepStrictEqual(calls[0], [256, 0.72], 'mulai dari ukuran dan kualitas tertinggi');
  r = Media.pickThumb((s) => b64(s * 40), 'public'); // 128 -> 5120 (kebesaran), 96 -> 3840, 72 -> 2880 (muat)
  assert(r && r.size === 72 && r.b64.length === 2880 && r.b64.length <= O.TH_MAX.public);
  r = Media.pickThumb((s, q) => b64(Math.round(s * q * 10) * 4), '0123456789abcdef'); // kualitas ikut menurunkan ukuran
  assert(r && r.b64.length <= O.TH_MAX.direct && r.b64.length % 4 === 0);
  assert.strictEqual(Media.pickThumb(() => b64(99999), 'public'), null, 'tidak ada yang muat: null (berkas tetap terkirim tanpa thumbnail)');
  assert.strictEqual(Media.pickThumb(() => null, 'public'), null);
  assert.strictEqual(Media.pickThumb(() => '', '0123456789abcdef'), null);
  assert.strictEqual(Media.pickThumb(() => 'AAA', '0123456789abcdef'), null, 'bukan kelipatan 4: ditolak');
  ok('pickThumb: mencoba ukuran/kualitas turun sampai muat; Publik ≤ ' + O.TH_MAX.public + ', DM/grup ≤ ' + O.TH_MAX.direct + '; tidak muat = null');

  // forSend: yang bukan gambar / tanpa jalur baca -> null tanpa menyentuh canvas
  assert.strictEqual(await Media.forSend('/tmp/laporan.pdf', 'public', { mediaPrep: async () => ({ ok: true }) }), null, 'ekstensi bukan gambar');
  assert.strictEqual(await Media.forSend('/tmp/a.jpg', 'public', {}), null, 'tanpa api.mediaPrep');
  assert.strictEqual(await Media.forSend('/tmp/a.jpg', 'public', { mediaPrep: async () => ({ ok: false }) }), null, 'proses utama menolak');
  assert.strictEqual(await Media.forSend(null, 'public', {}), null);
  assert.strictEqual(await Media.forSend({ size: 40 * 1048576, name: 'a.jpg', type: 'image/jpeg' }, 'public', {}), null, 'terlalu besar');
  assert.strictEqual(await Media.forSend({ size: 10, name: 'a.pdf', type: 'application/pdf' }, 'public', {}), null, 'File bukan gambar');
  ok('forSend: bukan gambar, tanpa jalur baca, ditolak proses utama, terlalu besar -> null (dikirim sebagai berkas biasa)');

  // ---- 4. kartu berkas ----
  const th = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 64, 0, 96, 1, 1, 0x11, 0, 0xff, 0xd9]).toString('base64');
  const ID = 'ab'.repeat(16), DM = '0123456789abcdef';
  const card = (file, to, prog, ctx) => FC.cardHtml({ id: ID, to: to || DM, file: Object.assign({ name: 'liburan.jpg', size: 3145728, psize: 3145728, mode: 'raw' }, file) }, prog || {}, ctx);
  const X = { k: 'img', w: 4000, h: 3000, th };
  let h = card({ x: X });
  assert(h.includes('class="fc fcimg"') && h.includes('data:image/jpeg;base64,' + th), 'thumbnail tampil');
  assert(/<button type="button" class="fth recv" data-act="recv" data-id="[a-f0-9]+" style="width:240px;aspect-ratio:4000\/3000"/.test(h), 'ketuk thumbnail = unduh; ukuran tampil dan rasio dari w/h');
  assert(h.includes('3,0 MB') && h.includes('Unduh foto') && !h.includes('class="fn"') && !h.includes('⬇'), 'badge ukuran dan label Unduh foto; tanpa nama dan tanpa teks tombol (nama ada di menu ⋮)');
  // tanpa x / x bukan foto: kartu lama persis
  assert(card({}) === FC.cardHtml({ id: ID, to: DM, file: { name: 'liburan.jpg', size: 3145728, psize: 3145728, mode: 'raw' } }, {}) && !card({}).includes('fth'), 'tanpa x: tanpa thumbnail');
  assert(!card({ x: { k: 'vid', d: 1000, th } }).includes('fth'), 'video: belum ada pratinjau di step ini');
  assert(!card({ x: { k: 'img', w: 10, h: 10 } }).includes('fth') && card({ x: { k: 'img', w: 10, h: 10 } }).includes('title="Terima"'), 'foto tanpa thumbnail: kartu biasa');
  ok('kartu foto: thumbnail + badge ukuran + tombol Unduh foto; tanpa x, video, atau tanpa thumbnail tetap kartu biasa');

  // sedang mengunduh / sudah tersimpan / milikku
  h = card({ x: X, rx: { phase: 'download', done: 5, total: 10 } });
  assert(h.includes('class="fth"') && !h.includes('data-act="recv"') && h.includes('data-bar'), 'mengunduh: thumbnail tidak bisa diketuk lagi, ada bilah progres');
  h = card({ x: X, saved: { name: 'liburan.jpg' } });
  assert(/class="fth view" data-act="view"/.test(h) && !h.includes('>Lihat<') && !h.includes('title="Buka"'), 'tersimpan: ketuk thumbnail / Lihat membuka penampil');
  h = card({ x: X, mine: true });
  assert(h.includes('class="fth"') && !/class="fth (view|recv)"/.test(h) && h.includes('data:image/jpeg'), 'milikku: thumbnail tampil, tanpa aksi');
  h = card({ x: X, rx: { phase: 'error', code: 'net', err: 'x', done: 0, total: 1 } });
  assert(h.includes('Coba lagi') && /class="fth recv"/.test(h), 'gagal: bisa dicoba lagi dari thumbnail');
  ok('kartu foto: status mengunduh, tersimpan (Lihat), milikku, gagal');

  // tersimpan tanpa x (kiriman versi lama) tetap bisa dilihat bila ekstensinya foto
  h = card({ saved: { name: 'lama.png' }, name: 'lama.png' });
  assert(h.includes('title="Lihat"') && !h.includes('fth'), 'foto dari versi lama: tombol Lihat tanpa thumbnail');
  assert(card({ saved: { name: 'x.pdf' }, name: 'x.pdf' }).includes('title="Buka"'), 'bukan foto: Buka biasa');
  assert(card({ saved: { name: 'x.heic' }, name: 'x.heic', x: X }).includes('title="Buka"') && !/class="fth view"/.test(card({ saved: { name: 'x.heic' }, name: 'x.heic', x: X })), 'HEIC: thumbnail tampil, tapi dibuka aplikasi lain');

  // ---- 5. pertahanan terhadap penyamaran dan data berbahaya ----
  for (const name of ['invoice.pdf', 'setup.exe', 'foto.jpg.exe', 'a.js', 'skrip.hta', 'laporan.docx', 'arsip.zip', 'x.svg']) {
    const hh = card({ name, x: X });
    assert(!hh.includes('fth') && !hh.includes('data:image'), 'thumbnail tidak tampil untuk ' + name);
  }
  assert(card({ name: 'invoice.pdf', x: X }).includes('title="Terima"'), 'berkas yang menyamar: kartu biasa');
  assert(card({ name: 'foto.jpg.exe', x: X }).includes('berisiko'), 'ekstensi berisiko tetap diperingatkan');
  for (const bad of ['"><img src=x onerror=alert(1)>', 'AAAA"onerror="x', 'abc', 'AA==AA', '<svg/onload=1>', 'A'.repeat(7) + ' ', '']) {
    const hh = card({ x: { k: 'img', w: 10, h: 10, th: bad } });
    assert(!hh.includes('fth') && !hh.includes('onerror') && !hh.includes('<img'), 'thumbnail berbahaya tidak dirender: ' + bad.slice(0, 20));
  }
  const evil = card({ name: '"><script>x</script>.jpg', x: X });
  assert(!evil.includes('<script>') && evil.includes('&lt;script&gt;'), 'nama berkas tetap di-escape');
  // w/h aneh tidak masuk ke atribut style
  for (const [w, hgt] of [['1;background:url(x)', 5], [5, '9px;x'], [-5, 5], [0, 5], [1.5, 5], [NaN, 5], [null, 5], [undefined, 5]]) {
    const hh = card({ x: { k: 'img', w, h: hgt, th } });
    assert(!/style="[^"]*(url|;x|NaN|-5)/.test(hh), 'w/h tidak masuk style: ' + w + ',' + hgt);
    assert(hh.includes('data:image/jpeg') && !/style="width/.test(hh) , 'w/h tidak sah: thumbnail tetap tampil tanpa ukuran khusus');
  }
  h = card({ x: { k: 'img', w: 30000, h: 10, th } });
  assert(h.includes('width:240px') && !h.includes('aspect-ratio'), 'rasio ekstrem: tanpa aspect-ratio (hindari tinggi 0)');
  h = card({ x: { k: 'img', w: 50, h: 40, th } });
  assert(h.includes('width:50px;aspect-ratio:50/40'), 'gambar kecil tidak diperbesar melewati ukuran aslinya');
  assert.strictEqual(FC.hasThumb({ name: 'a.jpg', x: { k: 'img', w: 10, h: 10, th } }), true);
  ok('thumbnail tidak tampil untuk nama berkas bukan gambar/berisiko dan untuk base64 tidak sah; nama di-escape; w/h aneh tidak masuk style');

  // ---- 6. kontrak preload/api-http/ipc ----
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), httpSrc = fs.readFileSync(path.join(root, 'renderer', 'archne-api-http.js'), 'utf8'), ipc = fs.readFileSync(path.join(root, 'src', 'archne-ipc.js'), 'utf8');
  for (const n of ['mediaPrep', 'mediaRead']) {
    assert(new RegExp('^\\s{2}' + n + ':', 'm').test(preload), n + ' ada di preload');
    assert(new RegExp("'" + n + "'").test(httpSrc), n + ' ada di api-http NAMES');
    assert(ipc.includes("ipcMain.handle('" + n + "'"), n + ' punya handler');
  }
  assert(/sendFile: \(job, src, to, media\) => ipcRenderer\.invoke\('sendFile', job, src, to, media\)/.test(preload), 'preload meneruskan media');
  assert(/api\.sendFile = async \(job, src, to, media\)/.test(httpSrc) && !/rpc\('sendFile', \[job, (src|up\.path), to\]\)/.test(httpSrc), 'api-http meneruskan media di kedua jalur');
  assert(/handlers\.set\('sendFile', async \(e, job, src, to, media\)/.test(fs.readFileSync(path.join(root, 'src', 'archne-rpc.js'), 'utf8')), 'adaptor HTTP meneruskan media');
  const html = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
  assert(/<script src="archne-media\.js"><\/script>/.test(html) && /<script src="js\/archne-imgview\.js"><\/script>/.test(html) && /<script src="js\/archne-settings-media\.js"><\/script>/.test(html));
  assert(/img-src data: archne-media: 'self';/.test(html) && !/img-src[^;]*(blob:|https?:|file:|\*)/.test(html), 'CSP gambar: data: (foto chat lewat data URL) + penyaji lokal archne-media:/self (gambar Halaman, 2d-5); tanpa blob/http/file/wildcard');
  assert(html.indexOf('js/archne-imgview.js') < html.indexOf('js/archne-settings.js') && html.indexOf('js/archne-settings.js') < html.indexOf('js/archne-settings-media.js'), 'urutan muat skrip');
  ok('kontrak: mediaPrep/mediaRead di preload, api-http, dan ipc; sendFile meneruskan media di semua jalur; CSP tidak dilonggarkan');

  // ---- 7. penampil foto dengan DOM palsu ----
  const els = {}, bodyCls = new Set();
  const mkEl = (id) => ({ id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, disabled: false, scrollTop: 0, clientHeight: 600, clientWidth: 800, scrollHeight: 0, naturalWidth: 0, naturalHeight: 0,
    attrs: {}, handlers: {}, removeAttribute(a) { delete this.attrs[a]; if (a === 'src') this.src = undefined; }, setAttribute(a, v) { this.attrs[a] = v; },
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { this.handlers[t] = fn; }, setPointerCapture() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }, focus() {}, requestSubmit() {} });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null,
    body: { classList: { add: (c) => bodyCls.add(c), remove: (c) => bodyCls.delete(c), contains: (c) => bodyCls.has(c) } } };
  const hist = { pushes: 0, backs: 0, pushState() { this.pushes++; }, back() { this.backs++; } };
  const reads = [];
  let readResult = { ok: true, mime: 'image/jpeg', w: 1600, h: 1200, size: 10, b64: 'QUJD' };
  const api = new Proxy({}, { get: (_t, n) => {
    if (Object.prototype.hasOwnProperty.call(_t, n)) return _t[n];
    if (n === 'state') return async () => state;
    if (['onProgress', 'onUpdate', 'onRemoved', 'onCall'].includes(n)) return () => {};
    if (n === 'mediaRead') return async (id) => { reads.push(id); return readResult; };
    if (n === 'getSettings') return async () => ({ ok: true, items: {}, usage: {}, autoImg: { mode: 'lan', max: 8388608 } });
    return async () => ({ ok: true });
  } });
  const win = { api, history: hist, matchMedia: () => ({ matches: false }), addEventListener(t, fn) { (this._l = this._l || {})[t] = fn; }, navigator: {} };
  const toasts = [];
  const ctx = { window: win, document: doc, CSS: { escape: (s) => s }, FileCard: FC, Avatar: require('../renderer/archne-avatar'), Media, confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, localStorage: { getItem() {}, setItem() {}, removeItem() {} } };
  let state = { me: { id: 'me', name: 'Saya', port: 1 }, peers: [], groups: [], messages: [{ id: ID, from: 'ff'.repeat(8), to: 'me', ts: Date.now(), name: 'Budi', text: '📎 liburan.jpg', file: { name: 'liburan.jpg', size: 100, psize: 100, mode: 'raw', saved: { name: 'liburan.jpg' }, x: X } }], sending: [], limits: { maxText: 10000 }, call: null, calls: [] };
  vm.createContext(ctx);
  vm.runInContext(inlineJs(), ctx);
  await sleep(30);
  const E = (id) => els[id];
  assert(vm.runInContext('typeof openImg === "function" && typeof closeImg === "function" && typeof imgvOpen === "function"', ctx), 'fungsi penampil ada');
  assert.strictEqual(vm.runInContext('imgvOpen()', ctx), false);
  await vm.runInContext(`openImg('${ID}')`, ctx);
  assert.deepStrictEqual(reads, [ID], 'foto dibaca lewat id');
  assert(E('imgv').classList.contains('on') && E('ivt').textContent === 'liburan.jpg', 'penampil terbuka dengan nama berkas');
  assert(E('ivimg').src === 'data:image/jpeg;base64,QUJD', 'isi lewat data URL (CSP)');
  assert.strictEqual(hist.pushes, 1, 'Kembali Android menutup penampil: satu entri riwayat');
  assert.strictEqual(vm.runInContext('imgvOpen()', ctx), true);
  // gambar selesai dimuat: pas layar
  E('ivimg').naturalWidth = 1600; E('ivimg').naturalHeight = 1200; E('ivimg').onload();
  assert.strictEqual(E('ivimg').style.visibility, 'visible');
  assert.strictEqual(E('ivzl').textContent, '50%', '1600x1200 di layar 800x600 = 50%');
  assert(/scale\(0\.5\)/.test(E('ivimg').style.transform));
  E('ivzi').onclick(); assert.strictEqual(E('ivzl').textContent, '75%');
  for (let i = 0; i < 20; i++) E('ivzi').onclick(); assert(parseInt(E('ivzl').textContent, 10) <= 800, 'zoom dibatasi');
  for (let i = 0; i < 30; i++) E('ivzo').onclick(); assert.strictEqual(E('ivzl').textContent, '50%', 'tidak lebih kecil dari pas layar');
  E('ivfit').onclick(); assert.strictEqual(E('ivzl').textContent, '50%');
  // gambar kecil tidak diperbesar saat pas layar
  E('ivimg').naturalWidth = 200; E('ivimg').naturalHeight = 100; E('ivimg').onload(); assert.strictEqual(E('ivzl').textContent, '100%');
  // Kembali (popstate) menutup penampil dulu, bukan meninggalkan chat
  bodyCls.add('inchat');
  win._l.popstate();
  assert(!E('imgv').classList.contains('on') && bodyCls.has('inchat') && E('ivimg').src === undefined && vm.runInContext('imgvOpen()', ctx) === false, 'popstate menutup penampil, chat tetap terbuka, isi gambar dilepas');
  win._l.popstate(); assert(!bodyCls.has('inchat'), 'popstate berikutnya meninggalkan chat seperti biasa');
  ok('penampil: buka lewat id, data URL, pas layar/zoom terbatas, gambar kecil tidak diperbesar, Kembali menutup penampil dulu, memori dilepas');

  // galat dan penutupan saat memuat
  readResult = { ok: false, code: 'notimg', err: 'Berkas ini bukan gambar yang valid' };
  await vm.runInContext(`openImg('${ID}')`, ctx);
  assert.strictEqual(E('ivmsg').textContent, 'Berkas ini bukan gambar yang valid'); assert(E('ivimg').src === undefined || E('ivimg').src === null, 'tidak ada gambar');
  vm.runInContext('closeImg()', ctx); assert.strictEqual(hist.backs, 1, 'tombol Tutup memakai history.back agar entri riwayat tidak menumpuk'); win._l.popstate();
  let release; readResult = new Promise((res) => { release = res; });
  const pend = vm.runInContext(`openImg('${ID}')`, ctx);
  vm.runInContext('closeImg()', ctx); win._l.popstate();
  const read2 = { ok: true, mime: 'image/png', w: 1, h: 1, size: 1, b64: 'QQ==' };
  // readResult adalah promise: api.mediaRead mengembalikannya; selesaikan setelah ditutup
  release(read2); await pend; assert(E('ivimg').src === undefined, 'ditutup selagi memuat: hasil terlambat diabaikan');
  ok('penampil: galat dari Core ditampilkan; ditutup selagi memuat tidak memasang gambar terlambat');

  // klik kartu -> openImg, tanpa menyentuh unduhan
  vm.runInContext(`window.api.receiveFile = async () => { throw new Error('tidak boleh'); }; openImg = (id) => { globalThis.__opened = id; };`, ctx);
  const fcl = vm.runInContext('typeof document.getElementById("msgs").onclick', ctx);
  assert.strictEqual(fcl, 'function', 'penangan klik chat ada');
  const click = (act) => E('msgs').onclick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, id: ID } } : null) } });
  await click('view');
  assert.strictEqual(vm.runInContext('globalThis.__opened', ctx), ID, 'aksi view membuka penampil');
  ok('klik thumbnail/Lihat memanggil penampil dan tidak memulai unduhan');

  // ---- 8. bagian Pengaturan > Foto ----
  const sec = vm.runInContext('SET_SECTIONS.find((s) => s.id === "media")', ctx);
  assert(sec && sec.title === 'Foto');
  let sh = sec.html({ autoImg: { mode: 'lan', max: 8388608 } });
  assert(/id="setautoimg" checked/.test(sh) && sh.includes('8,0 MB') && sh.includes('Publik'), 'bawaan menyala, menyebut batas dan pengecualian Publik');
  assert(!/checked/.test(sec.html({ autoImg: { mode: 'off', max: 8388608 } })), 'mode off: tidak tercentang');
  vm.runInContext('window.api.setSettings = async (p) => { globalThis.__set = p; return { ok: true, autoImg: { mode: "off" } }; }', ctx);
  E('setautoimg') || doc.getElementById('setautoimg'); els.setautoimg.checked = true;
  let sv = await sec.save({ autoImg: { mode: 'lan' } }); assert(sv.ok && !sv.changed, 'tidak berubah: tidak menyimpan');
  els.setautoimg.checked = false; sv = await sec.save({ autoImg: { mode: 'lan' } });
  assert(sv.ok && sv.changed && JSON.stringify(vm.runInContext('globalThis.__set', ctx)) === '{"autoImg":"off"}', 'mematikan menyimpan "off"');
  els.setautoimg.checked = true; sv = await sec.save({ autoImg: { mode: 'off' } });
  assert(sv.ok && vm.runInContext('globalThis.__set', ctx).autoImg === null, 'menyalakan kembali = bawaan (null)');
  ok('Pengaturan > Foto: bawaan menyala, menyimpan hanya bila berubah, mati = "off", nyala = bawaan');

  console.log('\nOK: ' + pass + ' kelompok');
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
