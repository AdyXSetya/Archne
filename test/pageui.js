'use strict';
// Tes UI Halaman (1c-4b): tombol di profil + layar kerangka. Statis + logika renderer/js/archne-pages.js di vm dengan stub kecil.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x))); // objek dari vm punya prototipe lain: bandingkan lewat JSON

(async () => {
  // A. statis
  const idx = rd('renderer/archne-index.html'), prof = rd('renderer/js/archne-profile-compose.js'), http = rd('renderer/archne-api-http.js'), pre = rd('preload.js');
  assert(idx.includes('id="pgmodal"') && idx.includes('css/archne-pages.css'));
  assert(idx.indexOf('js/archne-profile-compose.js') < idx.indexOf('js/archne-pages.js') && idx.indexOf('js/archne-pages.js') < idx.indexOf('js/archne-voice-channel.js'), 'urutan skrip');
  assert((prof.match(/pgBtn\(profId\)/g) || []).length === 2, 'tombol di profil sendiri dan orang lain');
  for (const n of ['pgAvail', 'pgList', 'pgGet', 'pgImage', 'pgFileGet', 'pgFileCancel', 'pgMine', 'pgCreate', 'pgRemove']) assert(http.includes("'" + n + "'") && pre.includes(n + ':'), n + ' ada di api-http dan preload');
  assert(pre.includes("onPgDl: (cb) => ipcRenderer.on('pgdl'") && http.includes("addEventListener('pgdl'") && http.includes('api.onPgDl = '), 'event pgdl (3a-5b) ada di preload dan api-http');
  ok('statis: modal, css, urutan skrip, tombol di dua cabang profil, kanal pg* di api-http + preload');

  // B. logika
  const calls = []; let avail = { ok: true }, profId = 'a'.repeat(16), renders = 0;
  const els = {}; const el = (id) => els[id] || (els[id] = { style: {}, innerHTML: '', addEventListener(t, f) { (this.h = this.h || {})[t] = f; } });
  const ctx = { S: { me: { id: '1'.repeat(16) } }, esc: (s) => String(s), nameOf: (id) => 'Nama-' + id.slice(0, 2), $: el,
    renderProfile: () => { renders++; }, document: { addEventListener(t, f) { ctx._kd = f; } }, Date, Promise, setTimeout,
    window: { api: { pgAvail: async (id) => { calls.push(id); return avail; } } } };
  Object.defineProperty(ctx, 'profId', { get: () => profId });
  vm.createContext(ctx); vm.runInContext(require('./_src').pagesJs(), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  const peer = 'a'.repeat(16);
  assert(run(`pgBtn('${ctx.S.me.id}')`).includes('Halamanku') && calls.length === 0); // sendiri: tanpa IPC
  assert.strictEqual(run(`pgBtn('${peer}')`), ''); await sleep(20); // belum ada hasil: kosong, lalu refresh
  assert.strictEqual(calls.length, 1); assert(renders >= 1, 'profil digambar ulang setelah hasil datang');
  assert(run(`pgBtn('${peer}')`).includes('data-pg="open"') && !run(`pgBtn('${peer}')`).includes('disabled')); assert.strictEqual(calls.length, 1, 'cache 3 dtk: tidak ada IPC baru');
  ok('tombol: sendiri tanpa IPC, orang lain mengikuti pgAvail dan di-cache');
  const t = (r) => run(`pgBtnFor(${JSON.stringify(r)})`);
  assert(t({ ok: false, why: 'offline' }).includes('disabled') && t({ ok: false, why: 'old' }).includes('disabled'));
  assert.strictEqual(t({ ok: false, why: 'blocked' }), ''); assert.strictEqual(t({ ok: false, why: 'peer' }), '');
  ok('offline / versi lama = nonaktif dengan alasan; diblokir / tak dikenal = tersembunyi');
  // layar kerangka tetap: buka / Escape / klik latar (sekarang dengan feed di baliknya)
  run(`pgOpen('${peer}')`); await sleep(20);
  assert(els.pgmodal.style.display === 'flex' && els.pgbody.innerHTML.includes('Halaman Nama-aa'));
  ctx._kd({ key: 'Escape', preventDefault() {} }); assert.strictEqual(els.pgmodal.style.display, 'none');
  run(`pgOpen('${ctx.S.me.id}')`); await sleep(20); assert(els.pgbody.innerHTML.includes('Halamanku') && els.pgbody.innerHTML.includes('id="pgtxt"'), 'kotak tulis hanya di Halamanku');
  els.pgmodal.h.click({ target: els.pgmodal }); assert.strictEqual(els.pgmodal.style.display, 'none');
  run(`pgOpen('${peer}')`); await sleep(20); assert(!els.pgbody.innerHTML.includes('id="pgtxt"'), 'tanpa kotak tulis di halaman orang lain'); run('pgClose()');
  ok('layar: buka, Escape menutup, klik latar menutup; kotak tulis hanya di Halamanku');
  // C. 2a-5: tombol "Tambah gambar" + placeholder di feed
  Object.assign(ctx, { dayLabel: () => 'Hari ini', hm: () => '10:00', linkHtml: (t) => t, fmt: (n) => String(n), toast: () => {}, ask: async () => true });
  let picked = ['/tmp/dir/foto.png'], created = null, createRes;
  Object.assign(ctx.window.api, { pickFiles: async () => picked, pgCreate: async (...a) => { created = a; return createRes; } });
  const sk = ctx.S.me.id; run(`pgImgs = []; pgOpen('${sk}')`); await sleep(20);
  assert(els.pgbody.innerHTML.includes('id="pgimg"') && els.pgbody.innerHTML.includes('title="Tambah gambar"') && els.pgbody.innerHTML.includes('<svg'), 'tombol ada di kotak tulis'); assert(!/>Tambah (gambar|berkas|video)<\/button>/.test(els.pgbody.innerHTML), 'tombol tambah berupa ikon, bukan teks'); assert((els.pgbody.innerHTML.match(/class="ibtn pgatt"/g) || []).length === 3 && els.pgbody.innerHTML.includes('id="pgimgn"'), 'tiga ikon + lencana jumlah');
  await run('pgPick()'); assert.strictEqual(run('pgImgs[0].name'), 'foto.png'); assert(els.pgimgrow.innerHTML.includes('foto.png') && els.pgimgrow.innerHTML.includes('data-pg="imgx"') && els.pgimg.title === 'Tambah gambar (1/10)');
  picked = []; await run('pgPick()'); assert.strictEqual(run('pgImgs.length'), 1); assert.strictEqual(run('pgImgs[0].name'), 'foto.png', 'dialog dibatalkan: pilihan lama tetap');
  els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'imgx', i: '0' } }) } }); assert.strictEqual(run('pgImgs.length'), 0); assert.strictEqual(els.pgimgrow.innerHTML, ''); assert.strictEqual(els.pgimg.title, 'Tambah gambar');
  ok('2a-5/2c: pilih gambar menampilkan nama, batal dialog tidak mengubah, tombol ✕ membuang yang itu');
  picked = ['C:\\Users\\a\\foto.png']; await run('pgPick()'); assert.strictEqual(run('pgImgs[0].name'), 'foto.png', 'nama dari path Windows');
  els.pgtxt = { value: 'hai' }; els.pgpriv = { value: 'public' };
  createRes = { ok: false, err: 'Gambar terlalu besar.' }; await run('pgPost()');
  assert.deepStrictEqual(J(created[2]), [{ src: 'C:\\Users\\a\\foto.png' }]); assert(run('pgImgs.length') === 1 && els.pgcerr.textContent === 'Gambar terlalu besar.', 'gagal: gambar dan pesan tetap');
  createRes = { ok: true, post: { id: 'p1', ts: 1, text: 'hai', priv: 'public', media: [{ id: 'm1', mime: 'image/png', size: 5, name: 'foto.png' }] } }; await run('pgPost()');
  assert.strictEqual(run('pgImgs.length'), 0); assert(els.pglist.innerHTML.includes('pgimgph') && els.pglist.innerHTML.includes('foto.png'), 'placeholder di feed');
  created = null; els.pgtxt.value = 'tanpa gambar'; createRes = { ok: true, post: { id: 'p2', ts: 2, text: 'tanpa gambar', priv: 'public' } }; await run('pgPost()');
  assert.deepStrictEqual(J(created[2]), [], 'tanpa gambar: larik kosong'); assert.strictEqual((els.pglist.innerHTML.match(/pgimgph/g) || []).length, 1, 'postingan tanpa gambar tanpa placeholder'); run('pgClose()');
  ok('2a-5/2c: gambar dikirim sebagai larik { src, th } di argumen ke-3 pgCreate; gagal = tetap; sukses = bersih; placeholder hanya untuk postingan bergambar');
  // D. 2a-6: api-http (Android/peramban): File diunggah dulu, pgCreate menerima path hasil unggah
  const fcalls = []; const hctx = { location: { pathname: '/s/ab12/' }, document: {}, JSON, encodeURIComponent, Array, Promise, String, Object, Error };
  hctx.window = hctx; hctx.inflight = 0; hctx.maxInflight = 0;
  hctx.fetch = async (u, o) => {
    fcalls.push({ u, o });
    if (/upload/.test(u)) {
      const nm = decodeURIComponent(u.split('name=')[1]); hctx.inflight++; hctx.maxInflight = Math.max(hctx.maxInflight, hctx.inflight); await sleep(3); hctx.inflight--;
      return { ok: !(hctx.upFail || nm === hctx.failName), status: 500, json: async () => ({ path: '/data/shared/ab-' + nm }) };
    }
    return { ok: true, json: async () => ({ ok: true, post: { id: 'p9' } }) };
  };
  vm.createContext(hctx); vm.runInContext(rd('renderer/archne-api-http.js'), hctx);
  const body = (i) => JSON.parse(fcalls[i].o.body);
  const file = { size: 12, name: 'foto.png' };
  let r = await hctx.api.pgCreate('hai', 'public', [{ src: file }]);
  assert(r.ok && fcalls.length === 2 && fcalls[0].u === '/s/ab12/upload?name=foto.png' && fcalls[0].o.body === file, 'File diunggah dulu');
  assert.deepStrictEqual(body(1), ['hai', 'public', [{ src: '/data/shared/ab-foto.png' }]]); assert(fcalls[1].u === '/s/ab12/rpc/pgCreate');
  fcalls.length = 0; await hctx.api.pgCreate('hai', 'public'); assert.strictEqual(fcalls.length, 1, 'tanpa gambar: tanpa unggah'); assert.deepStrictEqual(body(0), ['hai', 'public', []]);
  fcalls.length = 0; hctx.upFail = true; r = await hctx.api.pgCreate('hai', 'public', [{ src: file }]); assert(r.ok === false && /Gagal menyiapkan gambar/.test(r.err) && fcalls.length === 1, 'unggah gagal: pgCreate tidak dipanggil');
  r = await hctx.api.pgCreate('hai', 'public', [{ src: { name: 'x' } }]); assert(r.ok === false && r.err === 'Gambar tidak valid');
  ok('2a-6/2c: api-http mengunggah File lalu memanggil pgCreate dengan larik path; tanpa gambar tanpa unggah; unggah gagal berhenti');
  picked = [{ size: 5, name: 'kamera.jpg' }]; run(`pgImgs = []; pgOpen('${sk}')`); await sleep(20); await run('pgPick()');
  assert.strictEqual(run('pgImgs[0].name'), 'kamera.jpg'); assert(els.pgimgrow.innerHTML.includes('kamera.jpg')); run('pgClose()');
  ok('2a-6: pemilih mengembalikan File (Android): nama dari File');
  // E. 2b-3: thumbnail dibuat saat memilih gambar, dikirim sebagai argumen ke-4; feed menampilkan <img> dari th
  const TH = 'QUJDRA=='; let fsCalls = [], fsMode = 'ok', fsRel = null;
  ctx.Media = { forSend: (src, to) => { fsCalls.push([src, to]); if (fsMode === 'throw') return Promise.reject(new Error('x')); if (fsMode === 'none') return Promise.resolve({ k: 'img' }); if (fsMode === 'slow') return new Promise((res) => { fsRel = () => res({ k: 'img', th: TH }); }); return Promise.resolve({ k: 'img', th: TH }); } };
  let mkN = 0; const mk = (th) => ({ id: 'q' + (++mkN), ts: 3 + mkN, text: 'x', priv: 'public', media: [{ id: 'm7', mime: 'image/png', size: 5, name: 'foto.png', th }] });
  picked = ['/tmp/dir/foto.png']; run(`pgImgs = []; pgOpen('${sk}')`); await sleep(20);
  els.pgtxt = { value: 'dengan thumbnail' }; els.pgpriv = { value: 'public' };
  await run('pgPick()'); assert.deepStrictEqual(fsCalls[0], ['/tmp/dir/foto.png', 'page'], 'Media.forSend dipanggil dengan sumber + tujuan bukan public');
  assert.strictEqual(await run('pgImgs[0].thP'), TH); assert.strictEqual(run('pgImgs[0].th'), TH);
  created = null; createRes = { ok: true, post: mk(TH) }; await run('pgPost()');
  assert.deepStrictEqual(J(created[2]), [{ src: '/tmp/dir/foto.png', th: TH }], 'th ikut di entri gambar');
  assert(els.pglist.innerHTML.includes('<img src="data:image/jpeg;base64,' + TH + '"') && !els.pglist.innerHTML.includes('pgimgph'), 'feed: <img> dari th');
  ok('2b-3/2c: thumbnail dibuat saat memilih, dikirim di entri gambar, feed menampilkan <img>');
  // pgPost menunggu thumbnail yang belum selesai; th gagal dibuat tidak menggagalkan postingan
  fsMode = 'slow'; picked = ['/tmp/dir/lambat.png']; await run('pgPick()'); assert.strictEqual(run('pgImgs[0].th'), undefined, 'belum selesai');
  created = null; createRes = { ok: true, post: mk(TH) }; els.pgtxt.value = 'menunggu'; const pp = run('pgPost()'); await sleep(20); assert.strictEqual(created, null, 'belum memanggil pgCreate selagi thumbnail dibuat');
  fsRel(); await pp; assert.strictEqual(J(created[2])[0].th, TH, 'sesudah selesai th ikut terkirim');
  for (const md of ['throw', 'none']) {
    fsMode = md; picked = ['/tmp/dir/rusak.heic']; await run('pgPick()'); assert.strictEqual(run('pgImgs[0].th'), undefined, md + ': tanpa th');
    created = null; createRes = { ok: true, post: mk(undefined) }; els.pgtxt.value = 'tanpa th ' + md; await run('pgPost()');
    assert(created && JSON.stringify(J(created[2])) === JSON.stringify([{ src: '/tmp/dir/rusak.heic' }]), md + ': postingan tetap dikirim tanpa th'); assert(!els.pgcerr.textContent, md + ': tanpa pesan galat');
  }
  assert(els.pglist.innerHTML.includes('pgimgph') && els.pglist.innerHTML.includes('foto.png'), 'tanpa th: placeholder bernama');
  ok('2b-3: pgPost menunggu thumbnail; gagal/tanpa th = postingan tetap jadi, placeholder di feed');
  // feed: th dari jaringan tidak dipercaya
  assert(run(`pgMediaHtml(${JSON.stringify(mk(TH).media[0])})`).includes('<img src="data:image/jpeg;base64,' + TH + '"'));
  for (const bad of ['"><script>alert(1)</script>', 'abc def', 'QUJD".onerror=x', 'A'.repeat(7004), 5, null]) { const h = run(`pgMediaHtml(${JSON.stringify(mk(bad).media[0])})`); assert(!h.includes('<img') && h.includes('pgimgph'), 'th cacat tidak jadi <img>: ' + String(bad).slice(0, 12)); }
  run('pgClose()'); ctx.Media = undefined;
  ok('2b-3: th cacat dari jaringan (tanda kutip, spasi, terlalu panjang, bukan string) jatuh ke placeholder');
  // api-http meneruskan th (argumen ke-4) bila ada
  fcalls.length = 0; hctx.upFail = false; await hctx.api.pgCreate('hai', 'public', [{ src: file, th: 'QUJD' }]); assert.deepStrictEqual(body(1), ['hai', 'public', [{ src: '/data/shared/ab-foto.png', th: 'QUJD' }]], 'th ikut ke RPC setelah unggah');
  fcalls.length = 0; await hctx.api.pgCreate('hai', 'public', [{ src: '/data/x.png', th: 'QUJD' }]); assert.deepStrictEqual(body(0), ['hai', 'public', [{ src: '/data/x.png', th: 'QUJD' }]]);
  ok('2b-3/2c: api-http meneruskan th per gambar; path string tidak diunggah');
  // F. 2c: banyak gambar. Pilih, dedupe, batas, antrean thumbnail, kirim berurutan, grid di feed
  {
    const MAX = require('../src/archne-pagestore').MEDIA_MAX;
    assert.strictEqual(run('PG_IMG_MAX'), MAX, 'batas renderer = batas pagestore'); assert(rd('renderer/css/archne-pages.css').includes('.pgmedia.multi'), 'CSS grid ada');
    let active = 0, maxActive = 0, started = []; const waiters = [];
    ctx.Media = { forSend: (src) => { started.push(src); active++; maxActive = Math.max(maxActive, active); return new Promise((res) => { waiters.push(() => { active--; res({ k: 'img', th: 'TH' + String(src).split('/').pop() }); }); }); } };
    const release = async () => { while (waiters.length) { waiters.shift()(); await sleep(1); } };
    let pickCalls = 0; ctx.window.api.pickFiles = async () => { pickCalls++; return picked; };
    const names = () => J(run('pgImgs.map((x) => x.name)'));
    const click = (o) => els.pgmodal.h.click({ target: { closest: () => ({ dataset: o }) } });
    run(`pgImgs = []; pgOpen('${sk}')`); await sleep(20); els.pgtxt = { value: 'banyak' }; els.pgpriv = { value: 'friends' }; els.pgcerr = { textContent: '' };

    // 1. beberapa sekaligus: urutan = urutan dialog; tiap baris bernomor; label menghitung
    picked = ['/a/1.png', '/a/2.png', '/a/3.png']; await run('pgPick()');
    assert.deepStrictEqual(names(), ['1.png', '2.png', '3.png']);
    assert(els.pgimgrow.innerHTML.includes('1. 1.png') && els.pgimgrow.innerHTML.includes('3. 3.png') && (els.pgimgrow.innerHTML.match(/data-pg="imgx"/g) || []).length === 3);
    assert.strictEqual(els.pgimg.title, 'Tambah gambar (3/10)');
    // 2. antrean thumbnail: hanya satu pembuatan berjalan pada satu waktu
    await sleep(5); assert.deepStrictEqual(started, ['/a/1.png'], 'baru gambar pertama yang diproses'); assert.strictEqual(maxActive, 1);
    waiters.shift()(); await sleep(5); assert.deepStrictEqual(started, ['/a/1.png', '/a/2.png'], 'berikutnya mulai setelah yang sebelumnya selesai');
    // 3. gambar yang dibuang sebelum gilirannya dilewati (tidak membuang waktu / memori)
    click({ pg: 'imgx', i: '2' }); assert.deepStrictEqual(names(), ['1.png', '2.png']);
    await release(); await sleep(5); assert.deepStrictEqual(started, ['/a/1.png', '/a/2.png'], 'yang dibuang tidak pernah dibuatkan thumbnail'); assert.strictEqual(maxActive, 1, 'tidak pernah dua sekaligus');
    // 4. buang yang tengah: sisanya tetap berurutan, nomor menyesuaikan; indeks ngawur diabaikan
    picked = ['/a/3.png', '/a/4.png']; await run('pgPick()'); await release(); await sleep(5);
    click({ pg: 'imgx', i: '1' }); assert.deepStrictEqual(names(), ['1.png', '3.png', '4.png']); assert(els.pgimgrow.innerHTML.includes('2. 3.png'));
    for (const bad of ['-1', '9', 'x', '1.5', undefined]) { click({ pg: 'imgx', i: bad }); assert.deepStrictEqual(names(), ['1.png', '3.png', '4.png'], 'indeks tak sah diabaikan: ' + bad); }
    // 5. path yang sama tidak ditambah dua kali (dialog dengan sebagian sudah terpilih)
    picked = ['/a/1.png', '/a/5.png', '/a/5.png']; await run('pgPick()'); await release(); await sleep(5);
    assert.deepStrictEqual(names(), ['1.png', '3.png', '4.png', '5.png'].slice(0, 4), 'tidak ada ganda');
    assert.strictEqual(names().filter((n) => n === '5.png').length, 1);
    // 6. batas: sisa tempat diisi, kelebihan dilaporkan, tombol terkunci, dialog tidak dibuka lagi saat penuh
    picked = Array.from({ length: 11 }, (_, i) => '/b/' + i + '.png'); await run('pgPick()'); await release(); await sleep(5);
    assert.strictEqual(run('pgImgs.length'), MAX, 'berhenti tepat di batas'); assert(els.pgcerr.textContent.includes('Maksimal ' + MAX) && els.pgcerr.textContent.includes('5 gambar terakhir tidak ikut'), els.pgcerr.textContent);
    assert.strictEqual(els.pgimg.title, `Tambah gambar (${MAX}/${MAX})`); assert.strictEqual(els.pgimg.disabled, true, 'tombol terkunci saat penuh');
    const pc = pickCalls; await run('pgPick()'); assert.strictEqual(pickCalls, pc, 'penuh: dialog tidak dibuka');
    click({ pg: 'imgx', i: '0' }); assert.strictEqual(els.pgimg.disabled, false, 'buang satu: tombol hidup lagi');
    // 7. dialog dibatalkan tidak menghapus pesan yang sedang tampil
    els.pgcerr.textContent = 'Gagal menyimpan postingan.'; picked = []; await run('pgPick()'); assert.strictEqual(els.pgcerr.textContent, 'Gagal menyimpan postingan.');
    // 8. kirim: semua gambar berurutan dengan th masing-masing; yang th-nya gagal tetap ikut
    run(`pgImgs = []; pgClose(); pgOpen('${sk}')`); await sleep(20); els.pgtxt = { value: 'tiga gambar' }; els.pgpriv = { value: 'friends' }; started = [];
    picked = ['/c/x.png', '/c/y.png', '/c/z.png']; await run('pgPick()');
    created = null; createRes = { ok: true, post: { id: 'pp1', ts: 50, text: 'tiga gambar', priv: 'friends', media: [] } };
    const pend = run('pgPost()'); await sleep(10); assert.strictEqual(created, null, 'menunggu semua thumbnail');
    waiters.shift()(); await sleep(3); waiters.shift()(); await sleep(3); assert.strictEqual(created, null, 'masih menunggu yang ketiga'); waiters.shift()(); await pend;
    assert.deepStrictEqual(J(created[2]), [{ src: '/c/x.png', th: 'THx.png' }, { src: '/c/y.png', th: 'THy.png' }, { src: '/c/z.png', th: 'THz.png' }], 'urutan dan th per gambar'); assert.strictEqual(created[1], 'friends');
    assert.strictEqual(run('pgImgs.length'), 0, 'sukses: daftar dikosongkan'); assert.strictEqual(els.pgimgrow.innerHTML, ''); assert.strictEqual(els.pgimg.title, 'Tambah gambar');
    // 9. gagal: seluruh daftar dan urutannya tetap untuk dicoba lagi
    picked = ['/d/p.png', '/d/q.png']; await run('pgPick()'); await release(); els.pgtxt.value = 'gagal'; createRes = { ok: false, err: 'Gambar ke-2: Bukan gambar yang didukung (jpg, png, webp, gif)' }; await run('pgPost()');
    assert.deepStrictEqual(names(), ['p.png', 'q.png'], 'gagal: daftar tetap'); assert(els.pgcerr.textContent.startsWith('Gambar ke-2'), 'pesan per gambar tampil');
    // 10. selagi mengirim, daftar dibekukan (✕ tidak berlaku)
    created = null; createRes = { ok: true, post: { id: 'pp2', ts: 51, text: 'x', priv: 'public' } }; els.pgtxt.value = 'beku';
    run(`pgImgs.push({ src: '/d/lambat.png', name: 'lambat.png', th: undefined, thP: new Promise((r) => { globalThis.__relThP = () => r('T'); }) })`);
    const pb = run('pgPost()'); await sleep(5); click({ pg: 'imgx', i: '0' }); assert.strictEqual(run('pgImgs.length'), 3, 'sedang mengirim: ✕ diabaikan'); assert.strictEqual(els.pgimg.disabled, true);
    ctx.__relThP(); await pb; assert.strictEqual(J(created[2]).length, 3); assert.strictEqual(run('pgImgs.length'), 0);
    ctx.Media = undefined; run('pgClose()');
    ok('2c: pilih beberapa, dedupe path, nomor + hapus per gambar, batas 10 dengan pesan dan tombol terkunci, batal dialog tak menghapus pesan');
    ok('2c: thumbnail diantre satu-satu, yang dibuang dilewati; kirim menunggu semua th dan menjaga urutan; gagal menyimpan daftar; ✕ beku saat mengirim');
  }

  // G. 2c: feed menampilkan satu gambar seperti biasa, banyak gambar dalam grid; data jaringan tidak dipercaya
  {
    const TH1 = 'QUJDRA==', med = (i, th) => ({ id: ('0000000000000000' + i.toString(16)).slice(-16), mime: 'image/png', size: 5, name: 'g' + i + '.png', th });
    const html = (list) => run(`pgMediasHtml(${JSON.stringify(list)})`);
    assert.strictEqual(html(undefined), ''); assert.strictEqual(html([]), ''); assert.strictEqual(html('x'), '');
    const one = html([med(1, TH1)]); assert(one.startsWith('<div class="pgmedia">') && !one.includes('multi') && (one.match(/<img /g) || []).length === 1, 'satu gambar: tampilan lama');
    const three = html([med(1, TH1), med(2, TH1), med(3, undefined)]);
    assert(three.startsWith('<div class="pgmedia multi">') && (three.match(/<img /g) || []).length === 2 && (three.match(/pgimgph/g) || []).length === 1, 'tiga gambar: grid, yang tanpa th jadi placeholder di posisinya');
    assert(three.indexOf('g3.png') > three.indexOf('base64,' + TH1), 'urutan terjaga (placeholder di posisi ketiga)');
    const hostile = html([med(1, TH1), null, 5, 'x', [], med(2, '"><script>alert(1)</script>'), ...Array.from({ length: 20 }, (_, i) => med(i + 3, TH1))]);
    assert(!hostile.includes('<script'), 'th jahat tidak menjadi markup'); assert(!hostile.includes('alert(1)') || hostile.includes('pgimgph'), 'jatuh ke placeholder');
    const cells = (hostile.match(/class="pgth"|class="pgimgph"/g) || []).length; assert.strictEqual(cells, MAXC(), 'peer jahat: paling banyak 10 sel (entri bukan objek dilewati dulu)');
    function MAXC() { return require('../src/archne-pagestore').MEDIA_MAX; }
    // di dalam postingan: gambar muncul setelah teks; pemilik dan penonton sama
    Object.assign(ctx, { dayLabel: () => 'Hari ini', hm: () => '10:00', linkHtml: (t) => t, fmt: (n) => String(n) });
    ctx.window.api.pgList = async () => ({ ok: true, items: [{ id: 'f1', ts: 9, text: 'ada grid', priv: 'public', media: [med(1, TH1), med(2, TH1)] }, { id: 'f2', ts: 8, text: 'sendiri', priv: 'public', media: [med(3, TH1)] }, { id: 'f3', ts: 7, text: 'polos', priv: 'public' }], next: null, count: 3 });
    run(`pgOpen('${peer}')`); await sleep(20);
    const fl = els.pglist.innerHTML; assert.strictEqual((fl.match(/class="pgcar multi"/g) || []).length, 1); assert.strictEqual((fl.match(/class="pgcar"/g) || []).length, 1); assert.strictEqual((fl.match(/data-pcar=/g) || []).length, 2, 'postingan polos tanpa carousel');
    assert(fl.indexOf('ada grid') < fl.indexOf('pgcar multi') && fl.indexOf('pgcar multi') < fl.indexOf('sendiri'), 'grid tepat di bawah teks postingannya'); run('pgClose()');
    ok('2c: feed: 1 gambar tampilan lama, 2+ gambar grid, th cacat per sel jadi placeholder, peer jahat dibatasi 10 sel, postingan polos tanpa wadah');
  }

  // H. 2c: api-http dengan banyak File: unggah berurutan, urutan dipertahankan, gagal di tengah menghentikan semuanya
  {
    const f1 = { size: 1, name: 'satu.png' }, f2 = { size: 2, name: 'dua.png' }, f3 = { size: 3, name: 'tiga.png' };
    fcalls.length = 0; hctx.upFail = false; hctx.failName = undefined; hctx.maxInflight = 0;
    let r = await hctx.api.pgCreate('hai', 'friends', [{ src: f1, th: 'T1' }, { src: '/data/lokal.png' }, { src: f2 }, { src: f3, th: 'T3' }]);
    assert(r.ok); assert.strictEqual(hctx.maxInflight, 1, 'unggahan satu per satu, tidak bersamaan');
    assert.deepStrictEqual(fcalls.filter((c) => /upload/.test(c.u)).map((c) => decodeURIComponent(c.u.split('name=')[1])), ['satu.png', 'dua.png', 'tiga.png'], 'hanya File yang diunggah (path string tidak), sesuai urutan');
    assert.deepStrictEqual(body(fcalls.length - 1), ['hai', 'friends', [{ src: '/data/shared/ab-satu.png', th: 'T1' }, { src: '/data/lokal.png' }, { src: '/data/shared/ab-dua.png' }, { src: '/data/shared/ab-tiga.png', th: 'T3' }]], 'urutan gambar asli terjaga walau campuran File dan path');
    fcalls.length = 0; hctx.failName = 'dua.png'; r = await hctx.api.pgCreate('hai', 'public', [{ src: f1 }, { src: f2 }, { src: f3 }]);
    assert(r.ok === false && /Gagal menyiapkan gambar/.test(r.err)); assert.strictEqual(fcalls.length, 2, 'berhenti di unggahan yang gagal: yang ketiga tidak diunggah, pgCreate tidak dipanggil'); assert(!fcalls.some((c) => /rpc\/pgCreate/.test(c.u)));
    fcalls.length = 0; hctx.failName = undefined; r = await hctx.api.pgCreate('hai', 'public', [{ src: f1 }, { th: 'x' }]); assert(r.ok === false && r.err === 'Gambar tidak valid'); assert(!fcalls.some((c) => /rpc\/pgCreate/.test(c.u)), 'entri tanpa src: tidak ada panggilan RPC');
    ok('2c: api-http: banyak File diunggah satu per satu, urutan terjaga (File + path), gagal di tengah menghentikan semuanya');
  }

  // I. 3a-6: "Tambah berkas" di kotak tulis + pgCreate dengan lampiran
  {
    const MAXF = 10, click = (o) => els.pgmodal.h.click({ target: { closest: () => ({ dataset: o }) } });
    const fnames = () => J(run('pgFiles.map((x) => x.name)'));
    assert.strictEqual(run('PG_FILE_MAX'), require('../src/archne-pagestore').FILES_MAX, 'batas renderer = FILES_MAX pagestore');
    let pickCalls = 0; ctx.window.api.pickFiles = async () => { pickCalls++; return picked; };
    run(`pgImgs = []; pgFiles = []; pgClose(); pgOpen('${sk}')`); await sleep(20); els.pgtxt = { value: 'ada berkas' }; els.pgpriv = { value: 'public' }; els.pgcerr = { textContent: '' };
    assert(els.pgbody.innerHTML.includes('id="pgfile" data-pg="file" title="Tambah berkas" aria-label="Tambah berkas">') && els.pgbody.innerHTML.includes('id="pgfilerow"'), 'tombol dan daftar ada di kotak tulis');
    // 1. pilih: urutan dialog, path sama tidak dobel, nama dari path Windows, objek File (Android); label menghitung
    picked = ['/a/laporan.pdf', 'C:\\Users\\a\\data.zip', '/a/laporan.pdf', { size: 9, name: 'hp.docx' }, 42, null, { name: 'tanpa-size' }]; await run('pgPickFile()');
    assert.deepStrictEqual(fnames(), ['laporan.pdf', 'data.zip', 'hp.docx'], 'dedupe, nama dasar, yang bukan path/File dilewati');
    assert(els.pgfilerow.innerHTML.includes('1. laporan.pdf') && els.pgfilerow.innerHTML.includes('3. hp.docx') && (els.pgfilerow.innerHTML.match(/data-pg="filex"/g) || []).length === 3);
    assert.strictEqual(els.pgfile.title, 'Tambah berkas (3/10)'); assert.strictEqual(run('pgImgs.length'), 0, 'daftar gambar tidak tersentuh');
    // 2. dialog dibatalkan: tidak berubah; path yang sudah ada tidak ditambah lagi
    picked = []; await run('pgPickFile()'); assert.strictEqual(fnames().length, 3); picked = ['/a/laporan.pdf']; await run('pgPickFile()'); assert.strictEqual(fnames().length, 3);
    // 3. buang: indeks sah menghapus + penomoran ulang; tak sah diabaikan
    click({ pg: 'filex', i: '1' }); assert.deepStrictEqual(fnames(), ['laporan.pdf', 'hp.docx']); assert(els.pgfilerow.innerHTML.includes('2. hp.docx'));
    for (const bad of ['-1', '9', 'x', '1.5', undefined]) { click({ pg: 'filex', i: bad }); assert.deepStrictEqual(fnames(), ['laporan.pdf', 'hp.docx'], 'indeks tak sah diabaikan: ' + bad); }
    // 4. batas 10: berhenti tepat di batas dengan pesan, tombol terkunci, dialog tidak dibuka saat penuh; buang satu = hidup lagi
    picked = Array.from({ length: 11 }, (_, i) => '/b/' + i + '.bin'); await run('pgPickFile()');
    assert.strictEqual(run('pgFiles.length'), MAXF); assert(els.pgcerr.textContent.includes('Maksimal ' + MAXF + ' berkas') && els.pgcerr.textContent.includes('3 berkas terakhir tidak ikut'), els.pgcerr.textContent);
    assert.strictEqual(els.pgfile.title, 'Tambah berkas (10/10)'); assert.strictEqual(els.pgfile.disabled, true);
    const pc = pickCalls; await run('pgPickFile()'); assert.strictEqual(pickCalls, pc, 'penuh: dialog tidak dibuka');
    click({ pg: 'filex', i: '0' }); assert.strictEqual(els.pgfile.disabled, false);
    // 5. kirim: gambar dan lampiran dipisah; lampiran hanya { src }; sukses mengosongkan keduanya; gagal menjaga daftar dan pesan
    run('pgFiles = []; pgImgs = []; pgFileUi()'); picked = ['/f/satu.pdf', '/f/dua.zip']; await run('pgPickFile()');
    created = null; createRes = { ok: true, post: { id: 'pf1', ts: 70, text: 'ada berkas', priv: 'public', files: [{ id: '0123456789abcdef', name: 'satu.pdf', size: 3 }] } };
    await run('pgPost()'); assert.deepStrictEqual(J(created[3]), [{ src: '/f/satu.pdf' }, { src: '/f/dua.zip' }], 'urutan, hanya src'); assert.deepStrictEqual(J(created[2]), [], 'tanpa gambar: larik kosong');
    assert.strictEqual(run('pgFiles.length'), 0, 'sukses: daftar dikosongkan'); assert.strictEqual(els.pgfilerow.innerHTML, ''); assert.strictEqual(els.pgfile.title, 'Tambah berkas');
    els.pgtxt.value = 'polos'; created = null; createRes = { ok: true, post: { id: 'pf0', ts: 69, text: 'polos', priv: 'public' } }; await run('pgPost()'); assert.strictEqual(created.length, 3, 'tanpa lampiran: tiga argumen seperti sebelum 3a-6');
    run(`pgImgs = []; pgClose(); pgOpen('${sk}')`); await sleep(20); els.pgtxt = { value: 'gambar dan berkas' }; els.pgpriv = { value: 'public' }; els.pgcerr = { textContent: '' };
    picked = ['/f/foto.png']; await run('pgPick()'); await sleep(5); picked = ['/f/zzz.bin']; await run('pgPickFile()');
    created = null; await run('pgPost()'); assert.deepStrictEqual(J(created[2]).map((x) => x.src), ['/f/foto.png']); assert.deepStrictEqual(J(created[3]), [{ src: '/f/zzz.bin' }], 'gambar di images, berkas di files');
    run('pgImgs = []; pgFiles = []'); picked = ['/g/p.bin', '/g/q.bin']; await run('pgPickFile()'); els.pgtxt.value = 'gagal'; createRes = { ok: false, err: 'Berkas ke-2: Berkas terlalu besar (maksimal 2 GB)' }; await run('pgPost()');
    assert.deepStrictEqual(fnames(), ['p.bin', 'q.bin'], 'gagal: daftar tetap'); assert(els.pgcerr.textContent.startsWith('Berkas ke-2'), 'pesan per berkas tampil');
    // 6. selagi mengirim: daftar dibeku, tombol terkunci; layar ditutup lalu dibuka lagi: daftar draf muncul lagi
    let gate; const held = new Promise((r) => { gate = r; }); const realCreate = ctx.window.api.pgCreate; ctx.window.api.pgCreate = async (...a) => { created = a; await held; return { ok: true, post: { id: 'pf2', ts: 71, text: 'x', priv: 'public' } }; };
    els.pgtxt.value = 'beku'; const pb = run('pgPost()'); await sleep(5); click({ pg: 'filex', i: '0' }); assert.strictEqual(run('pgFiles.length'), 2, 'sedang mengirim: ✕ diabaikan'); assert.strictEqual(els.pgfile.disabled, true);
    const pc2 = pickCalls; await run('pgPickFile()'); assert.strictEqual(pickCalls, pc2, 'sedang mengirim: dialog tidak dibuka'); gate(); await pb; ctx.window.api.pgCreate = realCreate; assert.strictEqual(run('pgFiles.length'), 0);
    run('pgClose()'); picked = ['/h/draf.txt']; run(`pgOpen('${sk}')`); await sleep(20); await run('pgPickFile()'); run('pgClose()'); els.pgfilerow.innerHTML = ''; els.pgfile.title = 'Tambah berkas'; run(`pgOpen('${sk}')`); await sleep(20); // elemen tiruan tidak dibuat ulang: kosongkan dulu supaya hanya render ulang yang bisa mengisinya
    assert(els.pgfilerow.innerHTML.includes('1. draf.txt') && els.pgfile.title === 'Tambah berkas (1/10)', 'draf lampiran bertahan saat layar dibuka lagi'); run('pgFiles = []; pgClose()');
    ok('3a-6: tombol Tambah berkas: dedupe, nama dari path/File, nomor + hapus, batas 10 + pesan + terkunci, kirim memisah gambar/berkas, sukses kosongkan, gagal menjaga daftar, beku saat mengirim, draf bertahan');
    // api-http: File lampiran diunggah (sesudah gambar), jadi { src } saja; gagal / tak valid menghentikan semuanya
    const f1 = { size: 1, name: 'satu.png' }, g1 = { size: 5, name: 'a.pdf' }, g2 = { size: 6, name: 'b.zip' };
    fcalls.length = 0; hctx.upFail = false; hctx.failName = undefined; hctx.maxInflight = 0;
    let r = await hctx.api.pgCreate('hai', 'public', [{ src: f1, th: 'T1' }], [{ src: g1, th: 'BOCOR' }, { src: '/data/lokal.bin' }, { src: g2 }]);
    assert(r.ok); assert.deepStrictEqual(fcalls.filter((c) => /upload/.test(c.u)).map((c) => decodeURIComponent(c.u.split('name=')[1])), ['satu.png', 'a.pdf', 'b.zip'], 'gambar dulu, lalu berkas, satu per satu');
    assert.strictEqual(hctx.maxInflight, 1); assert.deepStrictEqual(body(fcalls.length - 1), ['hai', 'public', [{ src: '/data/shared/ab-satu.png', th: 'T1' }], [{ src: '/data/shared/ab-a.pdf' }, { src: '/data/lokal.bin' }, { src: '/data/shared/ab-b.zip' }]]);
    fcalls.length = 0; hctx.failName = 'a.pdf'; r = await hctx.api.pgCreate('hai', 'public', [], [{ src: g1 }, { src: g2 }]);
    assert(r.ok === false && /Gagal menyiapkan berkas/.test(r.err) && fcalls.length === 1 && !fcalls.some((c) => /rpc\/pgCreate/.test(c.u)), 'berkas gagal: berhenti, tanpa RPC');
    fcalls.length = 0; hctx.failName = undefined; r = await hctx.api.pgCreate('hai', 'public', [], [{ src: g1 }, { th: 'x' }]); assert(r.ok === false && r.err === 'Berkas tidak valid' && !fcalls.some((c) => /rpc\/pgCreate/.test(c.u)));
    fcalls.length = 0; r = await hctx.api.pgCreate('hai', 'public'); assert(r.ok); assert.deepStrictEqual(body(fcalls.length - 1), ['hai', 'public', []], 'tanpa berkas: tiga argumen seperti dulu');
    ok('3a-6: api-http: File lampiran diunggah berurutan sesudah gambar; hanya { src } ke RPC; gagal / tak valid menghentikan semuanya');
  }

  // J. 3c-7: "Tambah video" di kotak tulis + pgCreate dengan opts.videos
  {
    const MAXV = 4, click = (o) => els.pgmodal.h.click({ target: { closest: () => ({ dataset: o }) } });
    const vnames = () => J(run('pgVids.map((x) => x.name)'));
    assert.strictEqual(run('PG_VID_MAX'), require('../src/archne-pagestore').VIDEOS_MAX, 'batas renderer = VIDEOS_MAX pagestore');
    let pickCalls = 0; ctx.window.api.pickFiles = async () => { pickCalls++; return picked; };
    const fresh = async () => { run(`pgImgs = []; pgFiles = []; pgVids = []; pgClose(); pgOpen('${sk}')`); await sleep(20); els.pgtxt = { value: 'ada video' }; els.pgpriv = { value: 'public' }; els.pgcerr = { textContent: '' }; };
    await fresh();
    assert(els.pgbody.innerHTML.includes('id="pgvid" data-pg="vid" title="Tambah video" aria-label="Tambah video">') && els.pgbody.innerHTML.includes('id="pgvidrow"'), 'tombol dan daftar ada di kotak tulis');
    run(`pgOpen('${peer}')`); await sleep(20); assert(!els.pgbody.innerHTML.includes('id="pgvid"'), 'tanpa tombol video di halaman orang lain'); await fresh();
    // 1. pilih: urutan dialog, dobel dibuang, nama dari path Windows / File, bukan video dilewati dengan pesan, label menghitung
    picked = ['/v/a.mp4', 'C:\\Users\\a\\b.WEBM', '/v/a.mp4', { size: 9, name: 'hp.m4v' }, '/v/c.mkv', { size: 3, name: 'x.mov' }, 42, null, { name: 'tanpa-size.mp4' }]; await run('pgPickVideo()');
    assert.deepStrictEqual(vnames(), ['a.mp4', 'b.WEBM', 'hp.m4v'], 'dedupe, nama dasar, ekstensi huruf besar sah, mkv / mov / bukan berkas dilewati');
    assert(els.pgcerr.textContent.includes('2 berkas bukan video'), els.pgcerr.textContent);
    assert(els.pgvidrow.innerHTML.includes('1. a.mp4') && els.pgvidrow.innerHTML.includes('3. hp.m4v') && (els.pgvidrow.innerHTML.match(/data-pg="vidx"/g) || []).length === 3);
    assert.strictEqual(els.pgvid.title, 'Tambah video (3/4)'); assert.strictEqual(run('pgImgs.length') + run('pgFiles.length'), 0, 'daftar gambar dan berkas tidak tersentuh');
    // 2. dialog dibatalkan / path sama: tidak berubah
    picked = []; await run('pgPickVideo()'); assert.strictEqual(vnames().length, 3); picked = ['/v/a.mp4']; await run('pgPickVideo()'); assert.strictEqual(vnames().length, 3);
    // 3. buang: indeks sah menghapus + penomoran ulang; tak sah diabaikan
    click({ pg: 'vidx', i: '1' }); assert.deepStrictEqual(vnames(), ['a.mp4', 'hp.m4v']); assert(els.pgvidrow.innerHTML.includes('2. hp.m4v'));
    for (const bad of ['-1', '9', 'x', '1.5', undefined]) { click({ pg: 'vidx', i: bad }); assert.deepStrictEqual(vnames(), ['a.mp4', 'hp.m4v'], 'indeks tak sah diabaikan: ' + bad); }
    // 4. batas 4: berhenti tepat di batas dengan pesan, tombol terkunci, dialog tidak dibuka saat penuh; buang satu = hidup lagi
    picked = Array.from({ length: 5 }, (_, i) => '/b/' + i + '.mp4'); await run('pgPickVideo()');
    assert.strictEqual(run('pgVids.length'), MAXV); assert(els.pgcerr.textContent.includes('Maksimal ' + MAXV + ' video') && els.pgcerr.textContent.includes('3 video terakhir tidak ikut'), els.pgcerr.textContent);
    assert.strictEqual(els.pgvid.title, 'Tambah video (4/4)'); assert.strictEqual(els.pgvid.disabled, true);
    const pc = pickCalls; await run('pgPickVideo()'); assert.strictEqual(pickCalls, pc, 'penuh: dialog tidak dibuka');
    click({ pg: 'vidx', i: '0' }); assert.strictEqual(els.pgvid.disabled, false);
    // 5. kirim: video di opts.videos (hanya { src }), lampiran tetap di argumen ke-4; tanpa lampiran argumen ke-4 = []; nodl tetap ikut
    await fresh(); picked = ['/f/a.mp4', '/f/b.webm']; await run('pgPickVideo()');
    created = null; createRes = { ok: true, post: { id: 'pv1', ts: 80, text: 'ada video', priv: 'public', videos: [{ id: '0123456789abcdef', mime: 'video/mp4', size: 3, name: 'a.mp4' }] } };
    await run('pgPost()'); assert.strictEqual(created.length, 5); assert.deepStrictEqual(J(created[3]), [], 'tanpa lampiran: larik kosong'); assert.deepStrictEqual(J(created[4]), { videos: [{ src: '/f/a.mp4' }, { src: '/f/b.webm' }] }, 'urutan, hanya src, tanpa nodl');
    assert.strictEqual(run('pgVids.length'), 0, 'sukses: daftar dikosongkan'); assert.strictEqual(els.pgvidrow.innerHTML, ''); assert.strictEqual(els.pgvid.title, 'Tambah video');
    picked = ['/f/q.mp4']; await run('pgPickVideo()'); picked = ['/f/l.pdf']; await run('pgPickFile()'); els.pgdl = { checked: false }; els.pgtxt.value = 'semua';
    created = null; await run('pgPost()'); assert.deepStrictEqual(J(created[3]), [{ src: '/f/l.pdf' }]); assert.deepStrictEqual(J(created[4]), { nodl: true, videos: [{ src: '/f/q.mp4' }] }, 'nodl dan video bersama'); els.pgdl = { checked: true };
    els.pgtxt.value = 'polos'; created = null; await run('pgPost()'); assert.strictEqual(created.length, 3, 'tanpa lampiran dan video: tiga argumen seperti sebelum 3a-6');
    picked = ['/f/l2.pdf']; await run('pgPickFile()'); els.pgtxt.value = 'berkas saja'; created = null; await run('pgPost()'); assert.strictEqual(created.length, 5); assert.strictEqual(J(created[4]), undefined, 'lampiran tanpa video: tanpa opts.videos'); assert.strictEqual(run('pgFiles.length'), 0);
    // 6. gagal: daftar dan pesan Core tetap (draf video tidak hilang)
    await fresh(); picked = ['/g/p.mp4', '/g/q.mp4']; await run('pgPickVideo()'); els.pgtxt.value = 'gagal'; createRes = { ok: false, err: 'Video ke-2: Isi berkas bukan video mp4 atau webm' }; await run('pgPost()');
    assert.deepStrictEqual(vnames(), ['p.mp4', 'q.mp4'], 'gagal: daftar tetap'); assert(els.pgcerr.textContent.startsWith('Video ke-2'), 'pesan per video tampil');
    // 7. selagi mengirim: daftar dibeku, tombol terkunci; layar ditutup lalu dibuka lagi: draf video muncul lagi
    let gate; const held = new Promise((r) => { gate = r; }); const realCreate = ctx.window.api.pgCreate; ctx.window.api.pgCreate = async (...a) => { created = a; await held; return { ok: true, post: { id: 'pv2', ts: 81, text: 'x', priv: 'public' } }; };
    els.pgtxt.value = 'beku'; const pb = run('pgPost()'); await sleep(5); click({ pg: 'vidx', i: '0' }); assert.strictEqual(run('pgVids.length'), 2, 'sedang mengirim: ✕ diabaikan'); assert.strictEqual(els.pgvid.disabled, true);
    const pc2 = pickCalls; await run('pgPickVideo()'); assert.strictEqual(pickCalls, pc2, 'sedang mengirim: dialog tidak dibuka'); gate(); await pb; ctx.window.api.pgCreate = realCreate; assert.strictEqual(run('pgVids.length'), 0);
    run('pgClose()'); picked = ['/h/draf.mp4']; run(`pgOpen('${sk}')`); await sleep(20); await run('pgPickVideo()'); run('pgClose()'); els.pgvidrow.innerHTML = ''; els.pgvid.title = 'Tambah video'; run(`pgOpen('${sk}')`); await sleep(20);
    assert(els.pgvidrow.innerHTML.includes('1. draf.mp4') && els.pgvid.title === 'Tambah video (1/4)', 'draf video bertahan saat layar dibuka lagi'); run('pgVids = []; pgClose()');
    // 8. lewat klik tombol (bukan panggilan langsung): "vid" membuka pemilih video (bukan berkas), data-i tiap baris = indeksnya, pesan lama hilang setelah pilihan sah, dialog yang basi (layar ditutup) tidak mengubah apa pun
    await fresh(); picked = ['/k/a.mp4', '/k/b.mp4', '/k/c.webm']; click({ pg: 'vid' }); await sleep(5);
    assert.deepStrictEqual(vnames(), ['a.mp4', 'b.mp4', 'c.webm']); assert.strictEqual(run('pgFiles.length'), 0, 'tombol video tidak mengisi daftar berkas');
    for (let i = 0; i < 3; i++) assert(els.pgvidrow.innerHTML.includes(`data-pg="vidx" data-i="${i}"`), 'data-i = indeks baris ' + i);
    click({ pg: 'vidx', i: '0' }); els.pgcerr.textContent = 'pesan lama'; picked = ['/k/d.mp4']; await run('pgPickVideo()'); assert.strictEqual(els.pgcerr.textContent, '', 'pilihan sah membersihkan pesan lama');
    els.pgcerr.textContent = 'tetap'; picked = []; await run('pgPickVideo()'); assert.strictEqual(els.pgcerr.textContent, 'tetap', 'dialog dibatalkan: pesan lama dibiarkan');
    let late; ctx.window.api.pickFiles = () => new Promise((r) => { late = r; }); const before = vnames(); const sp = run('pgPickVideo()'); run('pgClose()'); late(['/k/telat.mp4']); await sp; assert.deepStrictEqual(vnames(), before, 'layar ditutup selagi dialog terbuka: pilihan basi dibuang');
    ctx.window.api.pickFiles = async () => { pickCalls++; return picked; }; run('pgVids = []');
    ok('3c-7: tombol Tambah video: dedupe, hanya mp4/m4v/webm, nama dari path/File, nomor + hapus, batas 4 + pesan + terkunci, kirim lewat opts.videos (+ nodl), sukses kosongkan, gagal menjaga daftar, beku saat mengirim, draf bertahan');
  }

  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
