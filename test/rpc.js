'use strict';
// Tes adaptor HTTP (v0.10.0): src/archne-rpc.js + src/archne-headless.js dengan Core sungguhan, klien http sungguhan.
// Juga menjaga renderer/archne-api-http.js tetap sama kontraknya dengan preload.js.
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { startHeadless } = require('../src/archne-headless');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-rpc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString() }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

(async () => {
  // ---- 0. kontrak: archne-api-http.js menyediakan semua nama di preload.js ----
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8');
  const want = [...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const win = { parent: null, document: { createElement() { return {}; }, body: { appendChild() {} } } }; win.parent = win;
  global.window = win; global.document = win.document; global.fetch = async () => { throw new Error('x'); };
  eval(apiSrc);
  const have = Object.keys(win.api);
  assert.deepStrictEqual(want.filter((n) => !have.includes(n)), [], 'archne-api-http.js kekurangan: ' + want.filter((n) => !have.includes(n)));
  assert.deepStrictEqual((await win.api.state()).ok, false, 'tanpa server, galat jinak (bukan lemparan)');
  delete global.window; delete global.document; delete global.fetch;
  ok(`archne-api-http.js memenuhi ${want.length} nama di preload.js; tanpa server mengembalikan { ok:false }`);

  // ---- 1. server ----
  const app = await startHeadless({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'dl'), name: 'Tes', canOpenFolder: false });
  const { rpc } = app, port = rpc.port;
  assert(port > 0 && /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/.test(rpc.url()));
  ok('server mendengarkan 127.0.0.1 dengan token acak 48 heks');

  // ---- 2. akses: tanpa token/cookie ditolak, token salah ditolak, host asing ditolak ----
  assert.strictEqual((await req(port, 'GET', '/')).status, 401);
  assert.strictEqual((await req(port, 'POST', '/rpc/state', { headers: { 'content-type': 'application/json' }, body: '[]' })).status, 401);
  assert.strictEqual((await req(port, 'GET', '/?t=' + 'a'.repeat(48))).status, 403);
  assert.strictEqual((await req(port, 'GET', '/?t=' + rpc.token, { headers: { host: 'evil.example:' + port } })).status, 403, 'DNS rebinding');
  const login = await req(port, 'GET', '/?t=' + rpc.token);
  assert.strictEqual(login.status, 302);
  const ck = /lc=[0-9a-f]+/.exec(login.headers['set-cookie'][0])[0];
  assert(/HttpOnly/.test(login.headers['set-cookie'][0]) && /SameSite=Strict/.test(login.headers['set-cookie'][0]));
  const H = { cookie: ck };
  ok('tanpa cookie 401, token salah 403, Host asing 403 (rebinding), cookie HttpOnly + SameSite=Strict');

  // ---- 3. UI statis, tanpa lolos dari folder renderer ----
  const idx = await req(port, 'GET', '/', { headers: H });
  assert.strictEqual(idx.status, 200); assert(/Archne/.test(idx.body));
  assert.strictEqual((await req(port, 'GET', '/archne-api-http.js', { headers: H })).status, 200);
  for (const u of ['/..%2fsrc%2fcore.js', '/%2e%2e/package.json', '/..%5csrc%5ccore.js', '/../package.json']) {
    const r = await req(port, 'GET', u, { headers: H });
    assert([403, 404].includes(r.status) && !/"name": "archne"|class Core/.test(r.body), u + ' -> ' + r.status);
  }
  ok('archne-index.html dan archne-api-http.js dilayani; ../ tidak bisa keluar dari renderer/');

  // ---- 3b. sesi lewat jalur /s/<token>/ (iframe Android: tanpa cookie) ----
  const SP = '/s/' + rpc.token + '/';
  assert.strictEqual(rpc.sessionUrl(), 'http://127.0.0.1:' + port + SP);
  const nc = await req(port, 'GET', SP); // sengaja TANPA cookie
  assert.strictEqual(nc.status, 200); assert(/Archne/.test(nc.body)); assert.strictEqual(nc.headers['referrer-policy'], 'no-referrer');
  assert.strictEqual((await req(port, 'GET', SP + 'archne-api-http.js')).status, 200);
  const stp = await req(port, 'POST', SP + 'rpc/state', { headers: { 'content-type': 'application/json' }, body: '[]' });
  assert.strictEqual(stp.status, 200); assert.strictEqual(typeof JSON.parse(stp.body), 'object');
  assert.strictEqual((await req(port, 'POST', SP + 'rpc/state', { headers: { 'content-type': 'text/plain' }, body: '[]' })).status, 415, 'CSRF: tetap wajib application/json');
  assert.strictEqual((await req(port, 'GET', '/s/' + 'a'.repeat(48) + '/')).status, 403, 'token salah di jalur');
  assert.strictEqual((await req(port, 'GET', '/s/abc/')).status, 403, 'token pendek');
  assert.strictEqual((await req(port, 'GET', '/s/' + rpc.token + '/', { headers: { host: 'evil.example:' + port } })).status, 403, 'DNS rebinding tetap ditahan');
  const noslash = await req(port, 'GET', '/s/' + rpc.token);
  assert.strictEqual(noslash.status, 302); assert.strictEqual(noslash.headers.location, SP, 'tanpa garis miring -> diarahkan, supaya jalur relatif jatuh ke awalan sesi');
  for (const u of ['..%2fsrc%2fcore.js', '%2e%2e/package.json', '../package.json']) {
    const r = await req(port, 'GET', SP + u);
    assert([403, 404].includes(r.status) && !/"name": "archne"|class Core/.test(r.body), 'jalur sesi + ' + u + ' -> ' + r.status);
  }
  assert.strictEqual((await req(port, 'GET', '/')).status, 401, 'tanpa awalan dan tanpa cookie tetap 401');
  // klien: archne-api-http.js memakai awalan sesi bila halaman dibuka di /s/<token>/
  {
    const calls = [];
    const w2 = { parent: null, document: { createElement() { return {}; }, body: { appendChild() {} } } }; w2.parent = w2;
    global.window = w2; global.document = w2.document; global.location = { pathname: SP + 'archne-index.html' };
    global.fetch = async (u) => { calls.push(u); return { ok: true, json: async () => ({ ok: true }) }; };
    eval(apiSrc);
    await w2.api.state();
    assert.strictEqual(calls[0], SP + 'rpc/state', 'fetch memakai awalan sesi: ' + calls[0]);
    delete global.window; delete global.document; delete global.fetch; delete global.location;
    const w3 = { parent: null, document: w2.document }; w3.parent = w3; global.window = w3; global.document = w3.document; global.location = { pathname: '/' };
    global.fetch = async (u) => { calls.push(u); return { ok: true, json: async () => ({ ok: true }) }; };
    eval(apiSrc);
    await w3.api.state();
    assert.strictEqual(calls[1], '/rpc/state', 'tanpa awalan: jalur akar biasa');
    delete global.window; delete global.document; delete global.fetch; delete global.location;
  }
  ok('sesi lewat jalur /s/<token>/ bekerja tanpa cookie; token salah/pendek 403, rebinding dan CSRF tetap ditahan, ../ tidak lolos; klien memakai awalan');


  // ---- 4. RPC ----
  const J = { cookie: ck, 'content-type': 'application/json' };
  const call = async (n, ...a) => JSON.parse((await req(port, 'POST', '/rpc/' + n, { headers: J, body: JSON.stringify(a) })).body);
  assert.strictEqual((await req(port, 'POST', '/rpc/state', { headers: { cookie: ck, 'content-type': 'text/plain' }, body: '[]' })).status, 415, 'POST non-JSON ditolak (CSRF)');
  assert.strictEqual((await req(port, 'POST', '/rpc/tidakada', { headers: J, body: '[]' })).status, 404);
  assert.strictEqual((await req(port, 'POST', '/rpc/state', { headers: J, body: '{bukan json' })).status, 400);
  assert.strictEqual((await req(port, 'POST', '/rpc/state', { headers: J, body: '{}' })).status, 400, 'argumen harus larik');
  const st = await call('state');
  assert(st.me && st.me.id && st.downloadDir);
  assert.strictEqual((await call('setName', 'Budi')), true);
  assert.strictEqual((await call('state')).me.name, 'Budi');
  assert.strictEqual((await call('send', 'halo', 'public')), true);
  const od = await call('openDownloads');
  assert.strictEqual(od.ok, false, 'Android: tidak ada folder terbuka');
  assert.strictEqual((await call('state')).canOpenFolder, false, 'Android: UI diberi tahu agar menyembunyikan tombol Unduhan');
  ok('state, setName, send lewat HTTP; JSON/Content-Type diperiksa; openDownloads diganti pesan di Android');

  // ---- 5. SSE ----
  const events = [];
  await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/events', headers: H }, (res) => {
      assert.strictEqual(res.headers['content-type'], 'text/event-stream');
      res.on('data', (c) => { events.push(c.toString()); });
      resolve(r);
    });
    r.on('error', () => {}); r.end();
    global._sse = r;
  });
  await call('send', 'pesan kedua', 'public');
  await sleep(200);
  assert(events.join('').includes('event: update'), 'update tersiar lewat SSE: ' + JSON.stringify(events));
  events.length = 0;
  const P16 = 'a1'.repeat(8), PO16 = 'b2'.repeat(8), CM16 = 'c3'.repeat(8);
  app.core.emit('pgcq', { ev: 'sent', peer: P16, post: PO16, id: CM16, why: 'added', text: 'rahasia', c: { sig: 'S' } });
  app.core.emit('pgcq', { ev: 'aneh', peer: P16, post: PO16, id: CM16 });
  await sleep(200);
  const sse = events.join(''), cqm = [...sse.matchAll(/event: pgcq\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  assert.deepStrictEqual(cqm, [{ ev: 'sent', peerId: P16, postId: PO16, id: CM16, why: 'added' }], 'pgcq tersiar lewat SSE, lima bidang, event cacat tidak: ' + sse);
  assert(!sse.includes('rahasia') && !sse.includes('"sig"'), 'teks dan tanda tangan tidak ikut');
  events.length = 0;
  app.core.emit('pgnew', { peer: P16, on: true, rahasia: 'x' }); app.core.emit('pgnew', { peer: P16, on: 'ya' }); app.core.emit('pgnew', { peer: 'zz', on: false }); app.core.emit('pgnew', { peer: P16, on: false });
  await sleep(200);
  const sse2 = events.join(''), nwm = [...sse2.matchAll(/event: pgnew\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  assert.deepStrictEqual(nwm, [{ peerId: P16, on: true }, { peerId: P16, on: false }], 'pgnew tersiar lewat SSE, dua bidang, event cacat tidak: ' + sse2);
  assert(!sse2.includes('rahasia'), 'bidang tambahan tidak ikut');
  assert.deepStrictEqual(await call('pgNewList', P16, { quiet: true }), { ok: true, peers: [] }, 'pgNewList lewat RPC: daftar kosong, argumen diabaikan');
  global._sse.destroy();
  ok('event update dan pgcq tersiar lewat SSE (pgcq: lima bidang saja, event cacat tidak disiarkan); pgnew: dua bidang, event cacat tidak, pgNewList lewat RPC');

  // ---- 6. unggah + sendFile (publik) ----
  const payload = Buffer.alloc(300000, 'abc');
  const up = JSON.parse((await req(port, 'POST', '/upload?name=' + encodeURIComponent('../../laporan:x.txt'), { headers: { cookie: ck, 'content-type': 'application/octet-stream' }, body: payload })).body);
  assert(up.path.startsWith(path.join(tmp, 'A', 'shared') + path.sep), 'unggahan di folder shared');
  assert(!path.basename(up.path).includes('..') && !path.basename(up.path).includes(':'), 'nama dibersihkan');
  assert.strictEqual(fs.statSync(up.path).size, payload.length);
  assert.strictEqual((await req(port, 'POST', '/upload?name=a', { headers: { cookie: ck, 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  const sent = await call('sendFile', 'j1', up.path, 'public');
  assert.strictEqual(sent.ok, true, JSON.stringify(sent));
  const rec = app.core.store.files[sent.id];
  assert(rec && rec.path, 'Core mencatat tawaran berkas');
  await sleep(100);
  assert.strictEqual(fs.existsSync(up.path), !rec.staged, 'salinan unggahan dihapus HANYA bila Core sudah membuat salinan sendiri');
  assert(fs.existsSync(rec.path), 'berkas yang dirujuk Core tetap ada');
  ok(`unggah → sendFile: nama dibersihkan, tawaran tercatat; salinan unggahan ${rec.staged ? 'dihapus (Core menyalin sendiri)' : 'dipertahankan (Core masih merujuk)'}`);

  // ---- 7. sendFile ke path liar di luar kontrak tetap lewat pemeriksaan archne-ipc.js ----
  assert.strictEqual((await call('sendFile', 'j2', 'relatif/x.txt', 'public')).ok, false);
  assert.strictEqual((await call('sendFile', 'j3', path.join(tmp, 'tidak-ada'), 'public')).ok, false);
  ok('path relatif / tidak ada ditolak oleh archne-ipc.js seperti di Electron');

  // ---- 7a. Halaman (2c): beberapa gambar diunggah lalu pgCreate; unggahan di shared/ dibersihkan, sukses maupun gagal ----
  {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const upl = async (name, body) => JSON.parse((await req(port, 'POST', '/upload?name=' + encodeURIComponent(name), { headers: { cookie: ck, 'content-type': 'application/octet-stream' }, body })).body).path;
    const shared = path.join(tmp, 'A', 'shared'), media = path.join(tmp, 'A', 'pages', 'media');
    const nShared = () => fs.readdirSync(shared).length, nMedia = () => (fs.existsSync(media) ? fs.readdirSync(media).length : 0);
    const s0 = nShared();
    const a = await upl('a.png', png), b = await upl('b.png', png);
    const r1 = await call('pgCreate', 'dua gambar', 'public', [{ src: a }, { src: b }]);
    assert.strictEqual(r1.ok, true, JSON.stringify(r1)); assert.strictEqual(r1.post.media.length, 2); assert(r1.post.media[0].name.endsWith('-a.png') && r1.post.media[1].name.endsWith('-b.png'), 'urutan terjaga: ' + JSON.stringify(r1.post.media.map((m) => m.name)));
    await sleep(100);
    assert.strictEqual(nMedia(), 2, 'dua salinan di penyimpanan halaman'); assert.strictEqual(nShared(), s0, 'unggahan di shared/ dihapus setelah sukses');
    // gagal (gambar ke-2 palsu): tidak ada postingan, tidak ada salinan, unggahan tetap dibersihkan
    const c = await upl('c.png', png), d = await upl('d.png', 'bukan gambar'), before = (await call('pgMine', {})).items.length;
    const r2 = await call('pgCreate', 'gagal', 'public', [{ src: c }, { src: d }]);
    assert.strictEqual(r2.ok, false); assert(/Image 2: /.test(r2.err), r2.err);
    await sleep(100);
    assert.strictEqual(nMedia(), 2, 'gagal tidak menambah salinan'); assert.strictEqual(nShared(), s0, 'unggahan dibersihkan juga saat gagal');
    assert.strictEqual((await call('pgMine', {})).items.length, before, 'gagal tidak membuat postingan');
    // jalur di luar shared/ tidak pernah dihapus (pemilik desktop memilih berkas sendiri)
    const own = path.join(tmp, 'milikku.png'); fs.writeFileSync(own, png);
    assert.strictEqual((await call('pgCreate', 'berkasku', 'public', [{ src: own }])).ok, true); await sleep(50);
    assert(fs.existsSync(own), 'berkas di luar shared/ tidak disentuh');
    ok('pgCreate banyak gambar lewat HTTP: berurutan, unggahan shared/ dibersihkan (sukses dan gagal), berkas di luar shared/ aman');
  }

  // ---- 7a2. Halaman (3a/3b): lampiran (argumen ke-4) dan opts (ke-5) harus sampai ke pgCreate lewat HTTP; unggahan lampiran di shared/ ikut dibersihkan ----
  // Sebelumnya pembungkus pgCreate hanya meneruskan tiga argumen: lampiran dari HP / peramban hilang diam-diam dan unggahannya menumpuk di shared/.
  {
    const upl = async (name, body) => JSON.parse((await req(port, 'POST', '/upload?name=' + encodeURIComponent(name), { headers: { cookie: ck, 'content-type': 'application/octet-stream' }, body })).body).path;
    const shared = path.join(tmp, 'A', 'shared'), nShared = () => fs.readdirSync(shared).length, s0 = nShared();
    const f1 = await upl('laporan.pdf', 'isi laporan'), f2 = await upl('data.zip', 'zzzz');
    const r1 = await call('pgCreate', 'ada lampiran', 'public', [], [{ src: f1 }, { src: f2 }], { nodl: true });
    assert.strictEqual(r1.ok, true, JSON.stringify(r1)); assert.strictEqual(r1.post.files.length, 2, 'lampiran sampai: ' + JSON.stringify(r1.post));
    assert(r1.post.files[0].name.endsWith('laporan.pdf') && r1.post.files[1].name.endsWith('data.zip'), 'urutan terjaga'); assert.strictEqual(r1.post.nodl, true, 'opts sampai');
    await sleep(100); assert.strictEqual(nShared(), s0, 'unggahan lampiran di shared/ dihapus');
    // tanpa opts = normal; gagal (opts cacat) juga membersihkan unggahan
    const f3 = await upl('lagi.pdf', 'lagi'), r2 = await call('pgCreate', 'normal', 'public', [], [{ src: f3 }]);
    assert.strictEqual(r2.ok, true); assert.strictEqual('nodl' in r2.post, false); await sleep(100); assert.strictEqual(nShared(), s0);
    const f4 = await upl('gagal.pdf', 'gagal'), r3 = await call('pgCreate', 'gagal', 'public', [], [{ src: f4 }], { nodl: 'ya' });
    assert.strictEqual(r3.ok, false); await sleep(100); assert.strictEqual(nShared(), s0, 'unggahan dibersihkan juga saat gagal');
    const t = await call('pgSetDl', r1.post.id, true); assert.deepStrictEqual(t, { ok: true, found: true, nodl: false }, 'pgSetDl terdaftar di jalur HTTP');
    const sid = (await call('state')).me.id; // 4a-5: pgReact terjangkau lewat HTTP (peminta = id sendiri, lokal)
    const rx1 = await call('pgReact', sid, r1.post.id, ' 👍 '); assert.deepStrictEqual(rx1, { ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍', who: [{ e: '👍', by: [sid] }] } }, 'pgReact lewat HTTP (4a-7: reaksi ke id sendiri membawa who): ' + JSON.stringify(rx1));
    { const mp = (await call('pgMine', {})).items.find((p) => p.id === r1.post.id); assert(mp && mp.mine === '👍' && JSON.stringify(mp.who) === JSON.stringify([{ e: '👍', by: [sid] }]), 'pgMine lewat HTTP membawa rx / mine / who: ' + JSON.stringify(mp)); }
    assert.strictEqual((await call('pgReact', sid, r1.post.id, 5)).code, 'bad', 'argumen cacat = bad lewat HTTP');
    { // 4b-3: pgComment / pgComments terjangkau lewat HTTP (peminta = id sendiri, lokal)
      const cm = await call('pgComment', sid, r1.post.id, '  halo   HTTP  ');
      assert(cm.ok === true && cm.comment && cm.comment.st === 'added' && cm.comment.c.by === sid && cm.comment.c.text === 'halo HTTP' && JSON.stringify(Object.keys(cm.comment.c).sort()) === JSON.stringify(['by', 'id', 'text', 'ts']), 'pgComment lewat HTTP: ' + JSON.stringify(cm));
      const cl = await call('pgComments', sid, r1.post.id, { limit: 10 }); assert.deepStrictEqual(cl, { ok: true, comments: { items: [cm.comment.c], next: null, count: 1, skipped: 0 } }, 'pgComments lewat HTTP: ' + JSON.stringify(cl));
      assert.strictEqual((await call('pgComment', sid, r1.post.id, 5)).code, 'bad', 'argumen cacat = bad lewat HTTP'); assert.strictEqual((await call('pgComments', sid, r1.post.id, { after: 'ngawur' })).code, 'bad');
    }
    { // 4c-2: pgCommentQueue / pgCommentPending / pgCommentCancel terjangkau lewat HTTP (satu Core: id sendiri = self; jalur sukses dua Core ada di test/pagecmtipc.js)
      const X = 'a'.repeat(16);
      const q1 = await call('pgCommentQueue', sid, r1.post.id, 'halo'); assert(q1.ok === false && q1.code === 'self', 'antre ke id sendiri = self: ' + JSON.stringify(q1));
      assert.strictEqual((await call('pgCommentQueue', sid, r1.post.id, 5)).code, 'bad'); assert.strictEqual((await call('pgCommentQueue', 'zz', r1.post.id, 'x')).code, 'bad');
      assert.strictEqual((await call('pgCommentQueue', X, r1.post.id, 'x'.repeat(4097))).code, 'bad', 'di atas batas kasar = bad tanpa menyentuh Core');
      assert.strictEqual((await call('pgCommentQueue', X, r1.post.id, 'halo')).code, 'peer', 'peer tak dikenal = peer');
      assert.deepStrictEqual(await call('pgCommentPending', X, r1.post.id), { ok: true, pending: [] }, 'tanpa antrean = daftar kosong');
      assert.strictEqual((await call('pgCommentPending', X, 'zz')).code, 'bad'); assert.strictEqual((await call('pgCommentPending', 7, r1.post.id)).code, 'bad');
      assert.deepStrictEqual(await call('pgCommentCancel', X, X), { ok: true, cancelled: false }, 'tidak ada = cancelled false');
      assert.strictEqual((await call('pgCommentCancel', X, 'zz')).code, 'bad'); assert.strictEqual((await call('pgCommentCancel', X)).code, 'bad');
    }
    { // 5c-1: pgCmtRemove terjangkau lewat HTTP (moderasi pemilik, lokal)
      const own = (await call('pgComments', sid, r1.post.id, {})).comments.items[0]; assert(own, 'ada komentar dari blok 4b-3');
      assert.deepStrictEqual(await call('pgCmtRemove', r1.post.id, own.id), { ok: true, removed: true }, 'pgCmtRemove lewat HTTP');
      assert.deepStrictEqual(await call('pgCmtRemove', r1.post.id, own.id), { ok: true, removed: false }, 'ulang = removed:false');
      assert.strictEqual((await call('pgCmtRemove', r1.post.id, 'zz')).code, 'bad'); assert.strictEqual((await call('pgCmtRemove', r1.post.id)).code, 'bad'); assert.strictEqual((await call('pgCmtRemove', 5, own.id)).code, 'bad');
    }
    ok('pgCreate lewat HTTP meneruskan lampiran + opts, unggahan lampiran di shared/ dibersihkan (sukses dan gagal), pgSetDl, pgReact, pgComment, pgComments dan pgCmtRemove terjangkau');
  }

  // ---- 7a3. Halaman (3c-6): video diunggah lewat /upload, dikirim di opts.videos; unggahan di shared/ dibersihkan (sukses dan gagal); pgVideo terjangkau lewat HTTP ----
  {
    const upl = async (name, body) => JSON.parse((await req(port, 'POST', '/upload?name=' + encodeURIComponent(name), { headers: { cookie: ck, 'content-type': 'application/octet-stream' }, body })).body).path;
    const shared = path.join(tmp, 'A', 'shared'), vdir = path.join(tmp, 'A', 'pages', 'videos'), nShared = () => fs.readdirSync(shared).length, nVid = () => (fs.existsSync(vdir) ? fs.readdirSync(vdir).length : 0);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(2000, 5)]);
    const s0 = nShared(), v0 = nVid();
    const v1 = await upl('klip.mp4', mp4), v2 = await upl('dua.mp4', mp4);
    const r1 = await call('pgCreate', 'berbideo', 'public', [], [], { videos: [{ src: v1 }, { src: v2 }], nodl: true });
    assert.strictEqual(r1.ok, true, JSON.stringify(r1)); assert.strictEqual(r1.post.videos.length, 2, 'video sampai lewat opts: ' + JSON.stringify(r1.post)); assert.strictEqual(r1.post.nodl, true, 'opts lain ikut');
    assert(r1.post.videos[0].name.endsWith('-klip.mp4') && r1.post.videos[1].name.endsWith('-dua.mp4') && r1.post.videos[0].mime === 'video/mp4', 'urutan dan mime');
    assert.strictEqual(nVid(), v0 + 2, 'dua salinan di penyimpanan halaman'); await sleep(100); assert.strictEqual(nShared(), s0, 'unggahan video di shared/ dihapus setelah sukses');
    const pv = await call('pgVideo', app.core.id, r1.post.id, r1.post.videos[0].id);
    assert(pv.ok && pv.video && pv.video.mime === 'video/mp4' && pv.video.total === mp4.length && /^[0-9a-f]{32}$/.test(pv.video.tok), 'pgVideo lewat HTTP: ' + JSON.stringify(pv));
    assert.strictEqual((await call('pgVideo', 'zz', 'x', 'y')).code, 'bad', 'masukan cacat = bad');
    // gagal (video kedua bukan video): tidak ada postingan, salinan video dibuang, unggahan di shared/ dibersihkan juga
    const v3 = await upl('ok.mp4', mp4), v4 = await upl('palsu.mp4', 'bukan video'), before = (await call('pgMine', {})).items.length;
    const r2 = await call('pgCreate', 'gagal', 'public', [], [], { videos: [{ src: v3 }, { src: v4 }] });
    assert.strictEqual(r2.ok, false); assert(/Video 2: /.test(r2.err), r2.err); await sleep(100);
    assert.strictEqual(nVid(), v0 + 2, 'salinan video yang gagal dibuang'); assert.strictEqual(nShared(), s0, 'unggahan dibersihkan juga saat gagal'); assert.strictEqual((await call('pgMine', {})).items.length, before);
    // opts cacat: unggahan tetap dibersihkan
    const v5 = await upl('lagi.mp4', mp4), r3 = await call('pgCreate', 'x', 'public', [], [], { videos: [{ src: v5 }], nodl: 'ya' });
    assert.strictEqual(r3.ok, false); await sleep(100); assert.strictEqual(nShared(), s0, 'opts cacat: unggahan dibersihkan');
    // jalur di luar shared/ tidak pernah dihapus
    const own = path.join(tmp, 'milikku.mp4'); fs.writeFileSync(own, mp4);
    assert.strictEqual((await call('pgCreate', 'videoku', 'public', [], [], { videos: [{ src: own }] })).ok, true); await sleep(50); assert(fs.existsSync(own), 'berkas di luar shared/ tidak disentuh');
    ok('pgCreate lewat HTTP meneruskan opts.videos, unggahan video di shared/ dibersihkan (sukses, gagal, opts cacat), berkas di luar shared/ aman, pgVideo terjangkau');
  }

  // ---- 7b. buka/tampilkan hasil unduhan: native diteruskan; berkas berisiko (.apk) diblokir untuk open DAN show ----
  {
    const idOk = 'c'.repeat(32), idApk = 'd'.repeat(32);
    const f1 = path.join(tmp, 'terima.txt'), f2 = path.join(tmp, 'pasang.apk');
    fs.writeFileSync(f1, 'x'); fs.writeFileSync(f2, 'x');
    app.core.store.got[idOk] = { path: f1, name: 'terima.txt' };
    app.core.store.got[idApk] = { path: f2, name: 'pasang.apk' };
    const o = await call('openFile', idOk), s1 = await call('showFile', idOk);
    assert.deepStrictEqual([o.ok, o.native && o.native.action, o.native && o.native.path], [true, 'open', f1]);
    assert.deepStrictEqual([s1.ok, s1.native && s1.native.action], [true, 'show']);
    const o2 = await call('openFile', idApk), s2 = await call('showFile', idApk);
    assert.strictEqual(o2.ok, false); assert(o2.risky && !o2.native);
    assert.strictEqual(s2.ok, false); assert(s2.risky && !s2.native, '"show" tidak boleh jadi jalan belakang untuk .apk');
    delete app.core.store.got[idOk]; delete app.core.store.got[idApk];
    ok('openFile/showFile meneruskan tindakan native ke cangkang; .apk ditolak di keduanya');
  }

  // ---- 8. sisa unggahan yang tidak dirujuk dibersihkan saat start ----
  await app.stop();
  fs.writeFileSync(path.join(tmp, 'A', 'shared', 'sisa.bin'), 'x');
  const app2 = await startHeadless({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'dl'), name: 'Tes' });
  assert(!fs.existsSync(path.join(tmp, 'A', 'shared', 'sisa.bin')), 'sisa dibersihkan');
  assert(fs.existsSync(rec.path), 'yang masih dirujuk Core tidak disentuh');
  await app2.stop();
  ok('start ulang membersihkan unggahan yatim, tidak menyentuh yang masih dirujuk');

  console.log(`\n${pass} tes RPC OK`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
