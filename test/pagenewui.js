'use strict';
// Tes Halaman 5b-4a: state lencana di renderer (renderer/js/archne-pgnew.js) dijalankan sungguhan di vm dengan window.api palsu.
// (5b-4b) juga: titik di baris daftar (pgNewMark + rowH), titik + aria-label di tombol Halaman, gambar ulang daftar / profil, CSS.
// (5b-4c) juga: pgNewRefresh (jaring pengaman bila event on:false hilang; satu pengulangan bila diminta selagi pgNewList berjalan) dan pemanggilnya di pgLoad.
// Yang diuji: pemuatan awal, event on/off, event cacat diabaikan, event selama pemuatan tidak tertimpa hasil lama, gagal ambil mempertahankan set, hook hanya saat berubah, sinkron ulang berkala, urutan di archne-index.html.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer', 'js', 'archne-pgnew.js'), 'utf8');
const A = 'a'.repeat(16), B = 'b'.repeat(16), C = 'c'.repeat(16);
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function load(api) {
  const timers = [];
  const ctx = { window: { api }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, console };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;this.__t = { set: pgNewSet, has: pgNewHas, ev: pgNewEvent, load: pgNewLoad, hook: (f) => { pgNewOnChange = f; }, refresh: pgNewRefresh };', ctx);
  return { t: ctx.__t, timers };
}

(async () => {
  { // muat awal + event
    let handler = null;
    const { t, timers } = load({ pgNewList: async () => ({ ok: true, peers: [B, 'xyz', 5, A] }), onPgNew: (cb) => { handler = cb; } });
    await tick(); await tick();
    assert.deepStrictEqual([...t.set].sort(), [A, B]); ok('muat awal: hanya id sah masuk');
    assert.strictEqual(timers.length, 1); assert.strictEqual(timers[0].ms, 30000); ok('sinkron ulang terjadwal 30 dtk');
    let n = 0; t.hook(() => n++);
    handler({ peerId: C, on: true }); assert.ok(t.has(C)); assert.strictEqual(n, 1);
    handler({ peerId: C, on: true }); assert.strictEqual(n, 1); ok('event on menyalakan; ulangan tidak memicu hook');
    handler({ peerId: C, on: false }); assert.ok(!t.has(C)); assert.strictEqual(n, 2); ok('event off memadamkan');
    for (const bad of [null, 'x', {}, { peerId: 'zz', on: true }, { peerId: C, on: 1 }, { peerId: C, on: 'true' }, { peerId: C }, { peerId: 5, on: true }]) handler(bad);
    assert.ok(!t.has(C)); assert.strictEqual(n, 2); ok('event cacat diabaikan');
  }
  { // event selama pemuatan tidak tertimpa hasil lama
    let handler = null, release;
    const gate = new Promise((r) => { release = r; });
    const { t } = load({ pgNewList: async () => { await gate; return { ok: true, peers: [A] }; }, onPgNew: (cb) => { handler = cb; } });
    handler({ peerId: B, on: true }); handler({ peerId: A, on: false });
    release(); await tick(); await tick();
    assert.deepStrictEqual([...t.set], [B]); ok('event selama pemuatan diputar ulang di atas hasilnya');
  }
  { // gagal ambil / bentuk salah mempertahankan set
    let mode = 'ok';
    const { t } = load({ pgNewList: async () => { if (mode === 'throw') throw new Error('x'); if (mode === 'bad') return { ok: true, peers: 'a' }; if (mode === 'no') return { ok: false }; return { ok: true, peers: [A] }; }, onPgNew() {} });
    await tick(); await tick(); assert.deepStrictEqual([...t.set], [A]);
    for (mode of ['throw', 'bad', 'no']) { await t.load(); assert.deepStrictEqual([...t.set], [A]); }
    ok('gagal ambil / bentuk salah: set lama dipertahankan');
    mode = 'ok'; let n = 0; t.hook(() => n++); await t.load(); assert.strictEqual(n, 0); ok('hasil sama tidak memicu hook');
  }
  { // hasil baru menggantikan, hook melempar tidak merusak
    let list = [A];
    const { t } = load({ pgNewList: async () => ({ ok: true, peers: list }), onPgNew() {} });
    await tick(); await tick(); t.hook(() => { throw new Error('hook'); });
    list = [C]; await t.load(); assert.deepStrictEqual([...t.set], [C]); ok('sinkron ulang menggantikan set; hook melempar tidak merusak');
  }
  { // 5b-4c: refresh menutup event yang hilang
    let list = [A, B];
    const { t } = load({ pgNewList: async () => ({ ok: true, peers: list }), onPgNew() {} });
    await tick(); await tick(); assert.deepStrictEqual([...t.set].sort(), [A, B]);
    list = [B]; let n = 0; t.hook(() => n++); // Core sudah memadamkan A tetapi eventnya hilang
    t.refresh(); await tick(); await tick();
    assert.deepStrictEqual([...t.set], [B]); assert.strictEqual(n, 1); ok('pgNewRefresh: event off yang hilang tetap padam lewat pgNewList');
    t.refresh(); await tick(); await tick(); assert.strictEqual(n, 1); ok('pgNewRefresh tanpa perubahan: hook diam');
  }
  { // 5b-4c: refresh selagi pgNewList berjalan = satu pengulangan, hasil terbaru menang
    let calls = 0; const gates = []; let list = [A];
    const { t } = load({ pgNewList: () => { calls++; return new Promise((r) => gates.push(() => r({ ok: true, peers: list }))); }, onPgNew() {} });
    assert.strictEqual(calls, 1); t.refresh(); t.refresh(); t.refresh(); assert.strictEqual(calls, 1, 'tidak paralel');
    list = []; gates[0](); await tick(); await tick();
    assert.strictEqual(calls, 2, 'tepat satu pengulangan untuk beberapa permintaan'); gates[1](); await tick(); await tick();
    assert.strictEqual(calls, 2); assert.deepStrictEqual([...t.set], []); ok('refresh selagi sibuk: satu pengulangan, tidak paralel, hasil terbaru menang');
    t.refresh(); assert.strictEqual(calls, 3); gates[2](); await tick(); await tick(); assert.strictEqual(calls, 3); ok('sesudah selesai, refresh berikutnya jalan normal');
  }
  { // api lama tanpa pgNewList / onPgNew tidak merusak
    const { t, timers } = load({}); await tick(); assert.strictEqual(t.set.size, 0); ok('api tanpa pgNewList / onPgNew: tidak melempar');
    const r = load(undefined); assert.strictEqual(r.t.set.size, 0); ok('tanpa window.api: tidak melempar');
  }
  { // 5b-4b: tampilan
    const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
    const ME = '1'.repeat(16);
    let renders = 0, profs = 0, profId = null;
    const ctx = { S: { me: { id: ME } }, esc: (x) => String(x), nameOf: () => 'N', $: () => ({ style: {}, addEventListener() {} }), Date, Promise, setTimeout, setInterval: () => 0, document: { addEventListener() {} },
      render: () => { renders++; }, renderProfile: () => { profs++; }, window: { api: { pgNewList: async () => ({ ok: true, peers: [A] }), onPgNew() {}, pgAvail: async () => ({ ok: true }) } } };
    Object.defineProperty(ctx, 'profId', { get: () => profId });
    vm.createContext(ctx);
    vm.runInContext(require('./_src').txfJs(), ctx); vm.runInContext(src, ctx); vm.runInContext(require('./_src').pagesJs().replace(require('./_src').txfJs() + '\n', ''), ctx);
    await tick(); await tick();
    const run = (c) => vm.runInContext(c, ctx);
    // titik di baris
    assert.ok(run(`pgNewMark('${A}')`).includes('class="pgdot"') && run(`pgNewMark('${A}')`).includes('aria-label="Postingan baru di Halaman"'));
    assert.strictEqual(run(`pgNewMark('${B}')`), ''); assert.strictEqual(run(`pgNewMark('public')`), ''); ok('pgNewMark: titik berlabel hanya untuk pemilik yang menyala');
    // titik di tombol
    const on = run(`pgBtnFor({ ok: true }, '${A}')`), off = run(`pgBtnFor({ ok: true }, '${B}')`), noid = run('pgBtnFor({ ok: true })');
    assert.ok(on.includes('pgdot') && on.includes('aria-label="Halaman, ada postingan baru"') && on.includes('data-pg="open"'));
    assert.ok(!off.includes('pgdot') && !off.includes('postingan baru') && off.includes('aria-label="Halaman"') && !noid.includes('pgdot')); ok('tombol Halaman: titik + label hanya bila menyala; tanpa id aman');
    assert.ok(!run(`pgBtnFor({ ok: false, why: 'offline' }, '${A}')`).includes('pgdot')); ok('tombol nonaktif (offline) tidak bertitik');
    // jalur pgBtn (cache segar sesudah pgAvail): id diteruskan, titik muncul untuk A dan tidak untuk B
    run(`pgBtn('${A}')`); run(`pgBtn('${B}')`); await sleep(30);
    assert.ok(run(`pgBtn('${A}')`).includes('pgdot') && !run(`pgBtn('${B}')`).includes('pgdot')); ok('pgBtn (cache segar) meneruskan id: titik hanya untuk yang menyala');
    run(`pgAv['${A}'].t = 0; pgAv['${B}'].t = 0`); // cache basi: tombol lama tetap tampil sambil menyegarkan, titik ikut
    assert.ok(run(`pgBtn('${A}')`).includes('pgdot') && !run(`pgBtn('${B}')`).includes('pgdot')); await sleep(30); ok('pgBtn (cache basi) tetap membawa titik');
    // gambar ulang
    renders = 0; profs = 0; profId = null; run(`pgNewEvent({ peerId: '${B}', on: true })`);
    assert.strictEqual(renders, 1); assert.strictEqual(profs, 0); ok('perubahan: daftar digambar ulang, profil tertutup tidak');
    profId = B; run(`pgNewEvent({ peerId: '${B}', on: false })`); assert.strictEqual(profs, 1);
    profId = ME; run(`pgNewEvent({ peerId: '${B}', on: true })`); assert.strictEqual(profs, 1); ok('profil orang lain yang terbuka digambar ulang; profil sendiri tidak disentuh');
    renders = 0; run(`pgNewEvent({ peerId: '${B}', on: true })`); assert.strictEqual(renders, 0); ok('tanpa perubahan: tidak menggambar ulang');
    // 5b-4c: pgLoad memanggil pgNewRefresh hanya untuk halaman pertama feed orang lain yang berhasil
    {
      const api = ctx.window.api; let nl = 0; const orig = api.pgNewList; api.pgNewList = async () => { nl++; return orig(); };
      const setF = (mine, next) => run(`pgId = '${B}'; pgTok++; renderFeed = function () {}; pgF = { mine: ${mine}, items: [], ids: new Set(), next: ${next ? "'k'" : 'null'}, count: null, skipped: 0, busy: false, done: false, err: null, loaded: false, open: new Set(), full: {}, posting: false, cm: {}, cmWant: null }`);
      const go = async () => { const b = nl; await run('pgLoad()'); await tick(); await tick(); return nl - b; };
      api.pgList = async () => ({ ok: true, items: [], next: null, count: 0 }); api.pgMine = async () => ({ ok: true, items: [], next: null, count: 0 });
      setF(false, false); assert.strictEqual(await go(), 1); ok('pgLoad: halaman pertama feed orang lain memicu pgNewRefresh');
      setF(false, true); assert.strictEqual(await go(), 0); ok('pgLoad: halaman lanjutan (ada kursor) tidak memicu');
      setF(true, false); assert.strictEqual(await go(), 0); ok('pgLoad: Halamanku tidak memicu');
      api.pgList = async () => ({ ok: false, code: 'offline' }); setF(false, false); assert.strictEqual(await go(), 0); ok('pgLoad: gagal tidak memicu');
      api.pgList = async () => { throw new Error('x'); }; setF(false, false); assert.strictEqual(await go(), 0); ok('pgLoad: melempar tidak memicu');
      let rel; api.pgList = () => new Promise((r) => { rel = () => r({ ok: true, items: [], next: null, count: 0 }); });
      setF(false, false); const b = nl; const pr = run('pgLoad()'); run('pgClose = pgClose; pgTok++'); rel(); await pr; await tick(); await tick();
      assert.strictEqual(nl - b, 1); ok('layar ditutup selagi menunggu: lencana tetap disegarkan (Core sudah menandai)');
    }
    // statis
    const rr = rd('renderer', 'js', 'archne-render.js'), css = rd('renderer', 'css', 'archne-pages.css');
    assert.ok(/<span class="nm">\$\{name\}\$\{typeof pgNewMark === 'function' \? pgNewMark\(id\) : ''\}<\/span>/.test(rr)); ok('rowH memasang pgNewMark di dalam nama');
    assert.ok(/\.pgdot\{[^}]*border-radius:50%/.test(css)); ok('CSS .pgdot ada');
  }
  { // urutan di archne-index.html
    const h = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8');
    const i = h.indexOf('js/archne-pgnew.js'), j = h.indexOf('js/archne-pages.js');
    assert.ok(i > 0 && j > i); ok('archne-pgnew.js dimuat sebelum archne-pages.js');
  }
  console.log('pagenewui: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
