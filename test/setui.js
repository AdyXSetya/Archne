'use strict';
// Tes UI pengaturan (v0.22.1, Step 2f): skrip asli archne-index.html di vm dengan DOM tiruan (seperti test/pvui.js).
// Tombol gear, dialog berbagian, baris kuota (pilihan, "Lainnya", tanpa batas, pemakaian), simpan hanya yang berubah, konfirmasi saat diturunkan, galat, kerangka bagian baru.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const html = require('./_src').htmlSrc();
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const MB = 1048576, ME = '1'.repeat(16);
const DEF = { cust: 500 * MB, files: 500 * MB, pubMsgs: 20 * MB }, MIN = { cust: 10 * MB, files: 100 * MB, pubMsgs: 5 * MB };

(async () => {
  // ---- A. struktur statis ----
  const idx = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
  for (const id of ['setbtn', 'setmodal', 'settitle', 'setbody', 'setclose', 'setsave']) assert(new RegExp('id="' + id + '"').test(idx), 'elemen ' + id);
  assert(/<div id="me">.*?id="setbtn"[^>]*aria-label="Pengaturan".*?<\/div>\s*<div id="tabs"/s.test(idx), 'gear ada di baris profil (#me), berlabel');
  assert(/<link rel="stylesheet" href="css\/archne-settings\.css">/.test(idx) && fs.existsSync(path.join(root, 'renderer/css/archne-settings.css')), 'archne-settings.css dimuat');
  assert(idx.indexOf('js/archne-call-ui.js') < idx.indexOf('js/archne-settings.js'), 'archne-settings.js dimuat setelah modul lain');
  assert(/#setmodal \.box\{/.test(html) && /\.strow \.stbar/.test(html), 'gaya dialog ada');
  ok('gear di #me (berlabel), dialog, archne-settings.css, urutan skrip');

  const inline = require('./_src').inlineJs();
  const els = {};
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: id === 'setautoimg', style: {}, dataset: {}, disabled: false, scrollTop: 0, handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }, focus() { this.focused = true; }, requestSubmit() {} });
  const calls = []; let getRet, setRet, dxRet, confirmAns = true, confirmTxt = [], updCb;
  const state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [], limits: { maxText: 10000 }, sending: [], messages: [], vc: null, groups: [], pv: { me: null, channels: [] } };
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => { calls.push(['state']); return state; };
    if (n === 'onUpdate') return (cb) => { updCb = cb; };
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    if (n === 'getSettings') return async () => { calls.push(['getSettings']); return (getRet && getRet.ok ? Object.assign({ lang: 'id' }, getRet) : getRet); };
    if (n === 'setSettings') return async (p) => { calls.push(['setSettings', JSON.parse(JSON.stringify(p))]); return setRet(p); };
    if (n === 'dxChooseDir') return async () => { calls.push(['dxChooseDir']); return dxRet; };
    return async (...a) => { calls.push([n, ...a]); return { ok: true }; };
  } });
  const doc = { getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: (t) => { confirmTxt.push(t); return confirmAns; }, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
    localStorage: { getItem: () => null, setItem: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(inline, ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));

  const E = (id) => doc.getElementById(id);
  for (const id of ['toast', 'setbody', 'setmodal', 'setbtn', 'setclose', 'setsave']) doc.getElementById(id);
  const item = (k, value, custom) => ({ value: value === undefined ? DEF[k] : value, def: DEF[k], min: MIN[k], custom: !!custom });
  const use = (used, quota) => ({ used, count: 1, quota });
  const mkGet = (o) => {
    o = o || {};
    const items = { cust: o.cust || item('cust'), files: o.files || item('files'), pubMsgs: o.pubMsgs || item('pubMsgs') };
    const usage = Object.assign({ cust: { dm: use(2 * MB, items.cust.value), gmsg: use(0, items.cust.value) }, files: { dm: use(0, items.files.value), pub: use(0, items.files.value), grp: use(0, items.files.value), seed: use(0, items.files.value) }, pubMsgs: use(MB, items.pubMsgs.value) }, o.usage);
    return { ok: true, items, usage };
  };
  const body = () => els.setbody.innerHTML;
  const shown = () => els.setmodal.style.display;
  const toastTxt = () => els.toast.textContent;
  const open = async (o) => { getRet = mkGet(o); calls.length = 0; confirmTxt = []; els.toast.textContent = ''; await els.setbtn.onclick(); };
  const pick = (c, f, p, mb) => { E('setsel-cust').value = c; E('setsel-files').value = f; E('setsel-pubMsgs').value = p; if (mb) for (const [k, v] of Object.entries(mb)) E('setmb-' + k).value = v; };
  const save = async () => { calls.length = 0; confirmTxt = []; els.toast.textContent = ''; await els.setsave.onclick(); return calls.slice(); };
  const sets = () => calls.filter((c) => c[0] === 'setSettings').map((c) => c[1]);
  const okSet = (p) => { const g = mkGet(); for (const [k, v] of Object.entries(p)) g.items[k] = item(k, v === null ? DEF[k] : v, v !== null); g.ok = true; return g; };
  setRet = okSet;

  // ---- B. membuka dialog: bawaan ----
  await open();
  assert.strictEqual(shown(), 'flex'); assert(calls.some((c) => c[0] === 'getSettings'));
  for (const t of ['Titipan pesan', 'Titipan berkas', 'Riwayat obrolan publik', 'Penyimpanan']) assert(body().includes(t), t);
  for (const k of ['cust', 'files', 'pubMsgs']) assert(body().includes('id="setsel-' + k + '"') && body().includes('id="setmb-' + k + '"'), 'kontrol ' + k);
  assert(body().includes('Bawaan (500 MB)') && body().includes('Bawaan (20 MB)'), 'bawaan ditampilkan dengan angkanya');
  assert(/<option value="default" selected>/.test(body()), 'pilihan awal = Bawaan');
  assert(body().includes('Tanpa batas') && body().includes('Lainnya…'));
  const optsOf = (k) => { const m = new RegExp('id="setsel-' + k + '"[^>]*>(.*?)</select>', 's').exec(body())[1]; return [...m.matchAll(/value="([^"]+)"/g)].map((x) => x[1]); };
  assert.deepStrictEqual(optsOf('cust'), ['default', '10', '50', '100', '1024', '2048', 'unlimited', 'custom']);
  assert.deepStrictEqual(optsOf('files'), ['default', '100', '250', '1024', '5120', '10240', 'unlimited', 'custom']);
  assert.deepStrictEqual(optsOf('pubMsgs'), ['default', '5', '10', '50', '100', 'unlimited', 'custom']);
  assert(body().includes('min="10"') && body().includes('min="100"') && body().includes('min="5"'), 'input angka membawa minimum');
  assert(body().includes('2,0 MB dari 500 MB') && body().includes('1,0 MB dari 20 MB'), 'pemakaian dari kuota');
  assert(/id="setwarn-files"[^>]*display:none/.test(body()) && /id="setwarn-pubMsgs"[^>]*display:none/.test(body()), 'peringatan tanpa batas tersembunyi');
  assert(/id="setmb-cust"[^>]*display:none/.test(body()), 'input angka tersembunyi');
  ok('dialog terbuka: tiga baris, pilihan di atas minimum, Bawaan (angka), pemakaian; peringatan dan input angka tersembunyi');

  // ---- C. keadaan tersimpan: Lainnya, preset, tanpa batas ----
  await open({ cust: item('cust', 64 * MB, true), files: item('files', 'unlimited', true), pubMsgs: item('pubMsgs', 50 * MB, true),
    usage: { files: { dm: use(0, 'unlimited'), pub: use(3 * MB, 'unlimited'), grp: use(0, 'unlimited'), seed: use(0, 'unlimited') } } });
  assert(/<option value="custom" selected>/.test(body()) && /id="setmb-cust"[^>]*value="64"/.test(body()) && /id="setmb-cust"[^>]*display:inline-block/.test(body()), '64 MB bukan preset -> Lainnya dengan angka 64');
  assert(/<option value="unlimited" selected>/.test(body()) && /id="setwarn-files"[^>]*display:block/.test(body()), 'tanpa batas terpilih, peringatan tampil');
  assert(/<option value="50" selected>/.test(body()), '50 MB = preset terpilih');
  assert(body().includes('3,0 MB (tanpa batas)') && !/\(tanpa batas\)<\/b><\/div><div class="stbar"><i[^>]*width:NaN/.test(body()), 'pemakaian tanpa batas tanpa bilah');
  ok('nilai tersimpan: Lainnya (angka terisi), preset, tanpa batas (peringatan, pemakaian tanpa bilah)');

  // ---- D. perubahan kontrol ----
  await open();
  E('setsel-files').value = 'unlimited'; els.setbody.onchange({ target: { id: 'setsel-files' } });
  assert.strictEqual(E('setwarn-files').style.display, 'block');
  E('setsel-files').value = 'custom'; els.setbody.onchange({ target: { id: 'setsel-files' } });
  assert.strictEqual(E('setmb-files').style.display, 'inline-block'); assert.strictEqual(E('setwarn-files').style.display, 'none'); assert(E('setmb-files').focused, 'fokus ke input angka');
  E('setsel-files').value = '250'; els.setbody.onchange({ target: { id: 'setsel-files' } });
  assert.strictEqual(E('setmb-files').style.display, 'none');
  els.setbody.onchange({ target: { id: 'lain' } }); els.setbody.onchange({});
  ok('mengubah pilihan menampilkan/menyembunyikan input angka dan peringatan; elemen lain diabaikan');

  // ---- E. simpan ----
  await open(); pick('default', 'default', 'default');
  assert.deepStrictEqual(sets(await save().then(() => calls)), [], 'tidak ada perubahan: tidak memanggil setSettings');
  assert.strictEqual(shown(), 'none', 'ditutup'); assert.strictEqual(toastTxt(), '', 'tanpa toast');

  await open(); pick('50', 'default', 'default'); await save();
  assert.deepStrictEqual(sets(calls), [{ cust: 50 * MB }], 'hanya kunci yang berubah');
  assert.strictEqual(shown(), 'none'); assert.strictEqual(toastTxt(), 'Pengaturan disimpan'); assert(calls.some((c) => c[0] === 'state'), 'tampilan disegarkan');
  assert(els.setsave.disabled === false, 'tombol aktif lagi');

  await open({ cust: item('cust', 64 * MB, true) }); pick('default', 'default', 'default'); await save();
  assert.deepStrictEqual(sets(calls), [{ cust: null }], 'kembali ke bawaan = null');

  await open({ cust: item('cust', 64 * MB, true) }); pick('custom', 'default', 'default', { cust: '64' }); await save();
  assert.deepStrictEqual(sets(calls), [], 'angka sama dengan sekarang = tidak berubah');

  await open(); pick('custom', 'unlimited', 'custom', { cust: '1,5', pubMsgs: '7' }); await save();
  assert.deepStrictEqual(sets(calls), [], 'angka cust 1,5 MB < minimum: tidak dikirim'); assert.strictEqual(toastTxt(), 'Minimal 10 MB untuk "Titipan pesan"'); assert.strictEqual(shown(), 'flex', 'dialog tetap terbuka');
  await open(); pick('custom', 'default', 'default', { cust: '' }); await save();
  assert(/Isi ukuran dalam MB/.test(toastTxt()) && !sets(calls).length);
  for (const bad of ['abc', '-5', '0', '1e9']) { await open(); pick('custom', 'default', 'default', { cust: bad }); await save(); assert(!sets(calls).length && toastTxt(), 'ditolak: ' + bad); }
  await open(); pick('custom', 'unlimited', 'custom', { cust: '12,5', pubMsgs: '7' }); await save();
  assert.deepStrictEqual(sets(calls), [{ cust: Math.round(12.5 * MB), files: 'unlimited', pubMsgs: 7 * MB }], 'koma desimal, tanpa batas, dan beberapa kunci sekaligus');
  ok('simpan: hanya yang berubah, null = bawaan, angka sama dilewati, minimum/angka rusak ditolak di klien, dialog tetap terbuka saat gagal');

  // ---- F. konfirmasi saat kuota diturunkan ----
  const big = { cust: { dm: use(30 * MB, 500 * MB), gmsg: use(0, 500 * MB) } };
  confirmAns = false; await open({ usage: big }); pick('10', 'default', 'default'); await save();
  assert.strictEqual(confirmTxt.length, 1, 'diminta konfirmasi'); assert(/Titipan pesan/.test(confirmTxt[0]) && /dibuang/.test(confirmTxt[0]));
  assert.deepStrictEqual(sets(calls), [], 'batal: tidak dikirim'); assert.strictEqual(shown(), 'flex'); assert.strictEqual(toastTxt(), '', 'batal tanpa galat'); assert.strictEqual(els.setsave.disabled, false);
  confirmAns = true; await save(); assert.deepStrictEqual(sets(calls), [{ cust: 10 * MB }], 'setuju: dikirim');
  confirmAns = true; await open({ usage: { cust: { dm: use(5 * MB, 500 * MB), gmsg: use(0, 500 * MB) } } }); pick('10', 'default', 'default'); await save();
  assert.strictEqual(confirmTxt.length, 0, 'isi lebih kecil dari kuota baru: tanpa konfirmasi');
  await open({ usage: { files: { dm: use(400 * MB, 500 * MB), pub: use(0, 500 * MB), grp: use(0, 500 * MB), seed: use(0, 500 * MB) } } }); pick('default', '100', 'default'); await save();
  assert.strictEqual(confirmTxt.length, 0, 'kolam berkas pribadi tidak digusur: tanpa konfirmasi'); assert.deepStrictEqual(sets(calls), [{ files: 100 * MB }]);
  await open({ usage: { files: { dm: use(0, 500 * MB), pub: use(300 * MB, 500 * MB), grp: use(0, 500 * MB), seed: use(0, 500 * MB) } } }); pick('default', '100', 'default'); await save();
  assert(confirmTxt.length === 1 && /Titipan berkas/.test(confirmTxt[0]), 'kolam publik terisi melebihi kuota baru: konfirmasi');
  await open({ usage: { pubMsgs: use(15 * MB, 20 * MB) } }); pick('default', 'default', 'unlimited'); await save();
  assert.strictEqual(confirmTxt.length, 0, 'ke tanpa batas: tanpa konfirmasi');
  ok('konfirmasi hanya bila isi yang akan dibuang melebihi kuota baru (kolam berkas pribadi dan "tanpa batas" tidak memicu); batal tidak mengirim apa pun');

  // ---- G. galat dari Core ----
  setRet = () => ({ ok: false, code: 'min', key: 'files', min: 100 * MB });
  await open(); pick('default', '100', 'default'); await save();
  assert.strictEqual(toastTxt(), 'Minimal 100 MB untuk "Titipan berkas"'); assert.strictEqual(shown(), 'flex');
  setRet = () => ({ ok: false, code: 'io' }); await open(); pick('50', 'default', 'default'); await save();
  assert(/Gagal menyimpan pengaturan/.test(toastTxt()));
  setRet = () => ({ ok: false, code: 'bad', key: 'cust' }); await open(); pick('50', 'default', 'default'); await save();
  assert.strictEqual(toastTxt(), 'Pengaturan tidak sah');
  setRet = () => ({ ok: false, err: 'rusak' }); await open(); pick('50', 'default', 'default'); await save();
  assert.strictEqual(toastTxt(), 'rusak');
  setRet = () => null; await open(); pick('50', 'default', 'default'); await save(); assert(toastTxt());
  setRet = okSet;
  getRet = { ok: false, err: 'macet' }; els.toast.textContent = ''; els.setmodal.style.display = 'none'; await els.setbtn.onclick();
  assert.strictEqual(toastTxt(), 'macet'); assert.strictEqual(shown(), 'none', 'getSettings gagal: dialog tidak dibuka');
  ok('galat Core dipetakan ke pesan (min, io, bad, err, null); getSettings gagal tidak membuka dialog');

  // ---- G2. (2d) bagian Kirim Langsung: folder terima (dipilih lewat dialog proses utama, langsung tersimpan) ----
  const DEFDIR = '/home/u/Unduhan/file_transfer';
  const dxGet = (o) => Object.assign(mkGet(), { canDirect: true, canPickDir: true, direct: { dir: DEFDIR, def: DEFDIR, custom: false } }, o);
  const dxOpen = async (o) => { getRet = dxGet(o); calls.length = 0; els.toast.textContent = ''; await els.setbtn.onclick(); };
  await dxOpen();
  assert(body().includes('data-sec=\"direct\"') && body().includes('<h4>Kirim Langsung</h4>') && body().includes('Folder terima'));
  assert(body().includes('id=\"setdxdir\"') && body().includes(DEFDIR) && body().includes('id=\"setdxpick\"') && body().includes('id=\"setdxreset\"'));
  assert(/id=\"setdxreset\" class=\"sec\" disabled/.test(body()), 'bawaan: tombol kembalikan nonaktif');
  assert(body().indexOf('data-sec=\"direct\"') < body().indexOf('data-sec=\"storage\"'), 'urutan: bagian Kirim Langsung sebelum bagian Penyimpanan');
  // ---- tab samping: bagian dikelompokkan per topik; semua bagian tetap digambar, yang bukan tab aktif hidden ----
  {
    const b = body(), tabIds = [...b.matchAll(/data-settab=\"(\w+)\"/g)].map((m) => m[1]);
    assert.deepStrictEqual(tabIds, ['general', 'network', 'storage', 'pages'].filter((t) => tabIds.includes(t)), 'urutan tab tetap');
    assert(tabIds.includes('general') && tabIds.includes('network') && tabIds.includes('storage'), 'tab Umum, Jaringan, Penyimpanan ada');
    assert(/role=\"tab\" class=\"settab on\" data-settab=\"general\" aria-selected=\"true\"/.test(b), 'Umum aktif saat dibuka');
    const sec = (n, v) => { const m = new RegExp('<section[^>]*data-sec=\\W*' + n + '\\W+data-tab=\\W*' + v + '\\W[^>]*>').exec(b); return m ? / hidden/.test(m[0]) : null; };
    assert(sec('lang', 'general') === false && sec('theme', 'general') === false && sec('direct', 'network') === true && sec('storage', 'storage') === true, 'bagian ikut tab-nya; yang lain hidden tetapi tetap digambar');
    assert(b.includes('id=\"setsel-cust\"') && b.includes('id=\"setdxdir\"'), 'kontrol di tab tersembunyi tetap ada (Simpan membacanya)');
    // pindah tab: tombol dan bagian tiruan diperbarui tanpa menggambar ulang
    const mk = (d) => ({ dataset: d, hidden: false, attrs: {}, tabIndex: 0, classList: { on: false, toggle(c, v) { this.on = v; } }, setAttribute(k, v) { this.attrs[k] = v; } });
    const tb = ['general', 'network', 'storage', 'pages'].map((t) => mk({ settab: t })), sc = ['general', 'network', 'storage'].map((t) => mk({ tab: t }));
    els.setbody.querySelectorAll = (q) => (q === '[data-settab]' ? tb : q === '.setsec' ? sc : []);
    vm.runInContext("setShowTab('network')", ctx);
    assert.deepStrictEqual(tb.map((x) => x.attrs['aria-selected']), ['false', 'true', 'false', 'false']); assert.deepStrictEqual(sc.map((x) => x.hidden), [true, false, true]); assert(tb[1].classList.on && tb[1].tabIndex === 0 && tb[0].tabIndex === -1);
    vm.runInContext("setShowTab('general')", ctx); delete els.setbody.querySelectorAll;
    ok('Pengaturan bertab: bagian per topik (Umum/Jaringan/Penyimpanan), bagian tab lain hidden tapi tetap digambar, pindah tab memperbarui aria-selected dan bagian');
  }
  // Ubah…: dialog (proses utama) -> Core menyimpan -> path tampil, tombol kembalikan aktif; renderer tidak mengirim path apa pun
  dxRet = { ok: true, direct: { dir: '/data/Terima', def: DEFDIR, custom: true } };
  await els.setbody.onclick({ target: { id: 'setdxpick' } });
  assert.deepStrictEqual(calls.map((c) => c[0]).filter((n) => n === 'dxChooseDir' || n === 'setSettings'), ['dxChooseDir'], 'hanya dxChooseDir, tanpa path dari renderer');
  assert.strictEqual(E('setdxdir').textContent, '/data/Terima'); assert.strictEqual(E('setdxreset').disabled, false);
  assert.strictEqual(toastTxt(), 'Folder terima diubah');
  // dialog dibatalkan: diam, tidak ada perubahan; galat Core: path tidak berubah
  els.toast.textContent = ''; dxRet = { ok: false, code: 'abort', err: 'Dibatalkan' };
  await els.setbody.onclick({ target: { id: 'setdxpick' } }); assert.strictEqual(toastTxt(), ''); assert.strictEqual(E('setdxdir').textContent, '/data/Terima');
  dxRet = { ok: false, code: 'dir', err: 'Folder itu tidak bisa ditulisi' };
  await els.setbody.onclick({ target: { id: 'setdxpick' } }); assert.strictEqual(E('setdxdir').textContent, '/data/Terima');
  // kembalikan ke bawaan: setSettings({ directDir: null })
  const keepSet = setRet; setRet = () => ({ ok: true, direct: { dir: DEFDIR, def: DEFDIR, custom: false } });
  calls.length = 0; await els.setbody.onclick({ target: { id: 'setdxreset' } });
  assert.deepStrictEqual(sets(), [{ directDir: null }]); assert.strictEqual(E('setdxdir').textContent, DEFDIR); assert.strictEqual(E('setdxreset').disabled, true);
  assert.strictEqual(toastTxt(), 'Folder terima dikembalikan ke bawaan');
  // klik di luar tombol diabaikan; Simpan tidak menulis apa pun untuk bagian ini
  calls.length = 0; await els.setbody.onclick({ target: { id: 'lain' } }); await els.setbody.onclick({}); await els.setbody.onclick();
  assert(!calls.some((c) => c[0] === 'dxChooseDir' || c[0] === 'setSettings'));
  pick('default', 'default', 'default'); await save(); assert(!sets().length, 'Simpan: tidak ada setSettings bila tidak ada kuota yang berubah');
  setRet = keepSet;
  // tersembunyi: tanpa pemilih berpath (Android/headless), inti lama tanpa `direct`; tanpa dialog hanya path yang tampil
  await dxOpen({ canDirect: false }); assert(!body().includes('Kirim Langsung') && !body().includes('setdxdir') && !body().includes('<h4></h4>'));
  await dxOpen({ direct: undefined }); assert(!body().includes('data-sec=\"direct\"'));
  await dxOpen({ canPickDir: false }); assert(body().includes(DEFDIR) && !body().includes('id=\"setdxpick\"') && body().includes('id=\"setdxreset\"'));
  await dxOpen({ direct: { dir: '<b>x</b>\"', def: DEFDIR, custom: true } }); assert(!body().includes('<b>x</b>') && body().includes('&lt;b&gt;x&lt;/b&gt;'), 'path di-escape');
  getRet = mkGet(); await els.setbtn.onclick();
  ok('(2d) bagian Kirim Langsung: path + Ubah… (dialog proses utama, tanpa path dari renderer) + Kembalikan; batal/galat diam; tersembunyi di Android/headless; di-escape');

  // ---- H. kerangka bagian baru + tutup ----
  const SEC = vm.runInContext('SET_SECTIONS', ctx), log = [];
  SEC.push({ id: 'tampilan', title: 'Tampilan <b>', html: (d) => '<div id="tamp">ok ' + (d.ok ? 'data' : '') + '</div>', change: (e) => log.push(['change', e.target && e.target.id]), async save() { log.push(['save']); return { ok: true, changed: true }; } });
  await open(); assert(body().includes('id="tamp">ok data') && body().includes('Tampilan &lt;b&gt;') && body().includes('data-sec="tampilan"'), 'bagian baru dirender, judul di-escape');
  els.setbody.onchange({ target: { id: 'x' } }); assert.deepStrictEqual(JSON.parse(JSON.stringify(log[0])), ['change', 'x'], 'change diteruskan ke semua bagian');
  pick('default', 'default', 'default'); await save(); assert(log.some((l) => l[0] === 'save'), 'save semua bagian dipanggil'); assert.strictEqual(toastTxt(), 'Pengaturan disimpan');
  SEC.push({ id: 'gagal', title: 'G', html: () => '', async save() { return { ok: false, err: 'bagian gagal' }; } }); SEC.push({ id: 'akhir', title: 'A', html: () => '', async save() { log.push(['akhir']); return { ok: true }; } });
  log.length = 0; await open(); pick('default', 'default', 'default'); await save();
  assert.strictEqual(toastTxt(), 'bagian gagal'); assert.strictEqual(shown(), 'flex'); assert(!log.some((l) => l[0] === 'akhir'), 'berhenti di bagian yang gagal');
  await els.setclose.onclick(); assert.strictEqual(shown(), 'none');
  ok('bagian baru cukup didaftarkan ke SET_SECTIONS (html/change/save); gagal berhenti; Tutup menutup');

  console.log('\n' + pass + ' kelompok lulus');
})().catch((e) => { console.error(e); process.exit(1); });
