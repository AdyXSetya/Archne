'use strict';
// Tes UI v0.23.1: bagian "Tampilan" (Otomatis/Gelap/Terang) dan "Hemat kuota relay" di dialog Pengaturan.
// Skrip asli renderer/js/*.js dijalankan di vm dengan DOM tiruan (pola test/setui.js).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const html = require('./_src').htmlSrc();
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const MB = 1048576, ME = '1'.repeat(16);

(async () => {
  // ---- A. struktur statis ----
  const idx = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
  assert(/<link rel="stylesheet" href="css\/archne-theme\.css">/.test(idx) && fs.existsSync(path.join(root, 'renderer/css/archne-theme.css')), 'archne-theme.css dimuat');
  assert(idx.indexOf('css/archne-app.css') < idx.indexOf('css/archne-theme.css'), 'archne-theme.css sesudah archne-app.css (menimpa token)');
  assert(/<script>[^<]*lc\.theme[^<]*data-theme[^<]*<\/script>/.test(idx.split('</head>')[0]), 'skrip kecil di <head> memasang tema sebelum tergambar');
  assert(idx.indexOf('js/archne-settings.js') < idx.indexOf('js/archne-settings-relay.js') && idx.indexOf('js/archne-settings-relay.js') < idx.indexOf('js/archne-theme.js'), 'urutan skrip');
  const css = fs.readFileSync(path.join(root, 'renderer/css/archne-theme.css'), 'utf8'), app = fs.readFileSync(path.join(root, 'renderer/css/archne-app.css'), 'utf8');
  assert(/:root\[data-theme="dark"\]\{color-scheme:dark\}/.test(css) && /:root\[data-theme="light"\]\{color-scheme:light;/.test(css), 'mode eksplisit');
  assert(/prefers-color-scheme:light\)\{:root:not\(\[data-theme\]\)\{/.test(css), 'Otomatis: terang hanya bila sistem terang dan tanpa pilihan eksplisit');
  const tok = (s) => (/--bg:#f2f5f8[^}]*/.exec(s) || [''])[0];
  const lights = css.match(/--bg:#f2f5f8[^}]*/g);
  assert.strictEqual(lights.length, 2); assert.strictEqual(lights[0], lights[1], 'token terang di kedua tempat identik');
  assert(!/prefers-color-scheme/.test(app), 'archne-app.css tidak lagi memuat token terang');
  // semua variabel yang dipakai CSS punya nilai di kedua tema
  const vars = (s) => new Set([...s.matchAll(/--([a-z0-9-]+):/g)].map((x) => x[1]));
  const dark = vars(/^:root\{[^}]*\}/m.exec(app)[0]), light = vars(lights[0]);
  for (const v of ['bg', 'surface', 'surface2', 'line', 'fg', 'dim', 'acc', 'acc-ink', 'mine', 'mine-fg', 'mine-line', 'danger', 'ok', 'warn', 'shadow', 'hover', 'sel', 'err']) assert(dark.has(v) && light.has(v), 'token ' + v + ' ada di gelap dan terang');
  ok('archne-theme.css: dimuat setelah archne-app.css, mode dark/light eksplisit, Otomatis lewat prefers-color-scheme, token identik dan lengkap');

  // ---- B. perilaku di vm ----
  const inline = require('./_src').inlineJs();
  const els = {}, attrs = {};
  const mkEl = (id) => ({ id, innerHTML: '', className: '', textContent: '', value: '', checked: id === 'setautoimg', style: {}, dataset: {}, disabled: false, handlers: {}, name: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, focus() {}, requestSubmit() {} });
  const calls = []; const cache = {};
  let getRet, setRet;
  const MIN = { cust: 10 * MB, files: 100 * MB, pubMsgs: 5 * MB, escMax: 0 }, DEF = { cust: 500 * MB, files: 500 * MB, pubMsgs: 20 * MB, escMax: 10 * MB };
  const state = { me: { id: ME, name: 'Saya', port: 1 }, peers: [], limits: { maxText: 10000 }, sending: [], messages: [], vc: null, groups: [], pv: { me: null, channels: [] } };
  const api = new Proxy({}, { get: (_t, n) => {
    if (n === 'state') return async () => state;
    if (n === 'onUpdate') return () => {};
    if (n === 'pickFiles') return async () => [];
    if (n === 'pathOf') return () => '';
    if (n === 'getSettings') return async () => { calls.push(['getSettings']); return getRet; };
    if (n === 'setSettings') return async (p) => { calls.push(['setSettings', JSON.parse(JSON.stringify(p))]); return setRet(p); };
    return async () => ({ ok: true });
  } });
  const root_ = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } };
  const doc = { documentElement: root_, getElementById: (id) => els[id] || (els[id] = mkEl(id)), querySelectorAll: () => [], activeElement: null, querySelector: () => null };
  let curTheme = 'system'; // tema yang "tersimpan di Core" pada mock
  // F1: Core palsu melaporkan lang: 'id' (tanpa ini archne-lang.js menyetel UI ke English saat kamus asli dimuat)
  const mkGet = (o) => {
    o = Object.assign({ theme: curTheme, escMax: DEF.escMax, custom: false }, o || {}); curTheme = o.theme;
    const it = (k, v) => ({ value: v === undefined ? DEF[k] : v, def: DEF[k], min: MIN[k], custom: false });
    const use = (u, q) => ({ used: u, count: 0, quota: q });
    const items = { cust: it('cust'), files: it('files'), pubMsgs: it('pubMsgs'), escMax: Object.assign(it('escMax', o.escMax), { max: 100 * MB, custom: o.custom }) };
    return { ok: true, lang: 'id', theme: o.theme, items, usage: { cust: { dm: use(0, DEF.cust), gmsg: use(0, DEF.cust) }, files: { dm: use(0, DEF.files), pub: use(0, DEF.files), grp: use(0, DEF.files), seed: use(0, DEF.files) }, pubMsgs: use(0, DEF.pubMsgs) } };
  };
  getRet = mkGet({ theme: 'dark' });
  setRet = (p) => { const g = mkGet({ theme: 'theme' in p ? (p.theme || 'system') : curTheme }); if ('escMax' in p) { g.items.escMax.value = p.escMax === null ? DEF.escMax : p.escMax; g.items.escMax.custom = p.escMax !== null; } return g; };
  const ctx = { window: { api }, document: doc, CSS: { escape: (s) => s }, FileCard: require('../renderer/archne-filecard'), Avatar: require('../renderer/archne-avatar'), confirm: () => true, alert: () => {}, console, setInterval: () => 0, setTimeout, clearTimeout, Date, parseInt, Set, Math, JSON,
    localStorage: { getItem: (k) => (k in cache ? cache[k] : null), setItem: (k, v) => { cache[k] = String(v); }, removeItem: (k) => { delete cache[k]; } } };
  vm.createContext(ctx);
  vm.runInContext(inline, ctx);
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  const E = (id) => doc.getElementById(id);
  for (const id of ['toast', 'setbody', 'setmodal', 'setbtn', 'setclose', 'setsave']) E(id);

  // saat dibuka, tema dari Core dipasang dan dicatat (tanpa kedip pada pembukaan berikutnya)
  assert.strictEqual(attrs['data-theme'], 'dark', 'tema dari Core dipasang saat UI dibuka');
  assert.strictEqual(cache['lc.theme'], 'dark');
  ok('saat UI dibuka: tema dari Core dipasang ke <html> dan dicatat di localStorage');

  const body = () => els.setbody.innerHTML;
  // DOM tiruan tidak mengisi .value dari <option selected> seperti peramban sungguhan: lakukan sendiri setelah dialog digambar
  const syncSelects = () => { for (const m of body().matchAll(/<select id="([^"]+)"[^>]*>(.*?)<\/select>/gs)) { const sel = /<option value="([^"]*)" selected>/.exec(m[2]); E(m[1]).value = sel ? sel[1] : ''; }
    for (const m of body().matchAll(/<input type="radio"[^>]*id="([^"]+)"[^>]*>/g)) E(m[1]).checked = /\schecked\b/.test(m[0]); };
  const open = async (o) => { getRet = mkGet(o); calls.length = 0; await els.setbtn.onclick(); syncSelects(); };
  const pickTheme = (v) => { for (const t of ['system', 'dark', 'light']) E('settheme-' + t).checked = t === v; const ev = { target: { name: 'settheme', value: v, id: 'settheme-' + v } }; els.setbody.onchange(ev); };
  const save = async () => { calls.length = 0; await els.setsave.onclick(); return calls.filter((c) => c[0] === 'setSettings').map((c) => c[1]); };

  // ---- C. dialog: urutan bagian dan isi ----
  await open({ theme: 'dark' });
  const h4s = [...body().matchAll(/<h4>(.*?)<\/h4>/gs)].map((x) => x[1]);
  const titles = h4s.map((h) => h.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim());
  assert.deepStrictEqual(titles, ['Language / Bahasa', 'Tampilan', 'Hemat kuota relay', 'Foto', 'Penyimpanan'], 'urutan bagian');
  assert(h4s.every((h) => /<svg/.test(h)), 'tiap bagian Pengaturan berikon SVG');
  for (const v of ['system', 'dark', 'light']) assert(body().includes('id="settheme-' + v + '"'), v);
  assert(/id="settheme-dark"[^>]*checked/.test(body()) && !/id="settheme-system"[^>]*checked/.test(body()), 'yang tersimpan terpilih');
  for (const l of ['Otomatis', 'Gelap', 'Terang']) assert(body().includes('>' + l + '<'), l);
  assert(/role="radiogroup"/.test(body()), 'radiogroup beraria');
  assert(body().includes('class="setgrp"'), 'panel berkelompok');
  ok('dialog: Tampilan, Hemat kuota relay, Penyimpanan berurutan; tiga pilihan tema dengan yang tersimpan terpilih');

  // relay: pilihan 0..100 MB, tanpa opsi tanpa batas
  const relayOpts = () => { const m = /id="setrelay"[^>]*>(.*?)<\/select>/s.exec(body())[1]; return [...m.matchAll(/value="([^"]+)"[^>]*>([^<]*)</g)].map((x) => [x[1], x[2]]); };
  assert.deepStrictEqual(relayOpts().map((x) => x[0]), ['0', '1', '5', '10', '25', '50', '100']);
  assert.strictEqual(relayOpts().find((x) => x[0] === '10')[1], '10 MB (bawaan)'); assert.strictEqual(relayOpts().find((x) => x[0] === '0')[1], 'Mati (tanpa berkas antar jaringan)');
  assert(!/unlimited|Tanpa batas/i.test(/id="setrelay"[^>]*>.*?<\/select>/s.exec(body())[0]), 'tidak ada opsi tanpa batas di bagian relay');
  assert(/<option value="10" selected>/.test(body()), 'bawaan terpilih');
  assert(body().includes('100 MB'), 'batas atas disebut');
  await open({ escMax: 25 * MB, custom: true }); assert(/<option value="25" selected>/.test(body()));
  await open({ escMax: 7 * MB, custom: true }); assert(/<option value="keep" selected>7 MB \(diatur manual\)/.test(body()), 'nilai manual dari berkas tetap tampil dan tidak dihapus diam-diam');
  ok('relay: 0/1/5/10/25/50/100 MB, bawaan 10 MB bertanda, tanpa opsi tanpa batas; nilai manual tetap tampil');

  // ---- D. tema: pratinjau, simpan, batal ----
  await open({ theme: 'dark' });
  pickTheme('light'); assert.strictEqual(attrs['data-theme'], 'light', 'pratinjau langsung');
  assert.strictEqual(cache['lc.theme'], 'dark', 'belum disimpan: cache tidak berubah');
  assert.strictEqual(calls.filter((c) => c[0] === 'setSettings').length, 0, 'pratinjau tidak menulis apa pun');
  await els.setclose.onclick(); // tutup tanpa simpan -> kembali
  assert.strictEqual(attrs['data-theme'], 'dark', 'ditutup tanpa simpan: kembali ke tema tersimpan');
  assert.strictEqual(els.setmodal.style.display, 'none');
  ok('pratinjau tema langsung; Tutup tanpa Simpan mengembalikan tema, tidak menulis apa pun');

  await open({ theme: 'dark' });
  pickTheme('light');
  let sets = await save();
  assert.deepStrictEqual(sets, [{ theme: 'light' }], 'hanya tema yang dikirim');
  assert.strictEqual(attrs['data-theme'], 'light'); assert.strictEqual(cache['lc.theme'], 'light');
  ok('Simpan: hanya { theme } dikirim; tema dan cache berganti');

  await open({ theme: 'light' }); pickTheme('system');
  sets = await save();
  assert.deepStrictEqual(sets, [{ theme: null }], 'Otomatis = null');
  assert(!('data-theme' in attrs), 'Otomatis: atribut dibuang (ikut sistem)'); assert(!('lc.theme' in cache), 'cache dibuang');
  ok('Otomatis: dikirim null, atribut data-theme dan cache dibuang (ikut sistem)');

  await open({ theme: 'dark' }); sets = await save();
  assert.deepStrictEqual(sets, [], 'tidak berubah: tidak menulis apa pun');
  ok('tanpa perubahan: tidak ada panggilan setSettings');

  // gagal simpan tema: dialog tetap terbuka, pratinjau tidak dianggap tersimpan
  await open({ theme: 'dark' }); pickTheme('light');
  const keepSet = setRet; setRet = () => ({ ok: false, code: 'io' });
  els.toast.textContent = '';
  await save();
  assert.strictEqual(els.setmodal.style.display, 'flex', 'gagal: dialog tetap terbuka'); assert(els.toast.textContent.length > 0, 'ada pesan galat');
  setRet = keepSet; await els.setclose.onclick();
  assert.strictEqual(attrs['data-theme'], 'dark', 'sesudah gagal lalu ditutup: kembali ke tema tersimpan');
  ok('gagal menyimpan tema: dialog tetap terbuka dan ada pesan; menutup mengembalikan tema');

  // ---- E. relay: simpan ----
  await open({ escMax: DEF.escMax }); E('setrelay').value = '50';
  sets = await save(); assert.deepStrictEqual(sets, [{ escMax: 50 * MB }]);
  await open({ escMax: 50 * MB, custom: true }); E('setrelay').value = '10';
  sets = await save(); assert.deepStrictEqual(sets, [{ escMax: null }], 'memilih bawaan = null');
  await open({ escMax: DEF.escMax }); E('setrelay').value = '0';
  sets = await save(); assert.deepStrictEqual(sets, [{ escMax: 0 }], '0 sah (mati)');
  await open({ escMax: DEF.escMax }); E('setrelay').value = '10'; sets = await save(); assert.deepStrictEqual(sets, [], 'sama: tidak menulis');
  await open({ escMax: 7 * MB, custom: true }); E('setrelay').value = 'keep'; sets = await save(); assert.deepStrictEqual(sets, [], 'nilai manual dibiarkan');
  for (const bad of ['unlimited', '101', '-1', 'abc']) { await open({ escMax: DEF.escMax }); E('setrelay').value = bad; sets = await save(); assert.deepStrictEqual(sets.filter((s) => 'escMax' in s), [], 'nilai ' + bad + ' tidak pernah dikirim'); }
  ok('relay: simpan angka, bawaan = null, 0 sah, tanpa perubahan tidak menulis, unlimited/di atas 100/negatif tidak pernah dikirim');
  // galat 'max' dari Core dipetakan
  await open({ escMax: DEF.escMax }); E('setrelay').value = '50';
  setRet = () => ({ ok: false, code: 'max', key: 'escMax', max: 100 * MB }); els.toast.textContent = '';
  await save(); assert(/Maksimal 100 MB/.test(els.toast.textContent), els.toast.textContent);
  ok("galat 'max' dari Core tampil sebagai \"Maksimal 100 MB\"");

  // ---- F. gaya dialog ----
  assert(/#setmodal \.box\{[^}]*padding:0[^}]*display:flex/.test(html), 'kotak dialog: header/isi/tombol terpisah');
  assert(/\.thm input:checked~\.thmp\{/.test(html) && /\.thm input:focus-visible~\.thmp\{/.test(html), 'pilihan tema: terpilih dan fokus keyboard terlihat');
  assert(/@media \(max-width:760px\)\{[^@]*#setmodal \.row\{[^}]*safe-area-inset-bottom/.test(fs.readFileSync(path.join(root, 'renderer/css/archne-settings.css'), 'utf8')), 'mobile: tombol di atas area aman bawah');
  ok('gaya: dialog tiga zona, pilihan tema (terpilih + fokus), mobile aman');

  console.log('\n' + pass + ' kelompok lulus');
})().catch((e) => { console.error(e); process.exit(1); });
