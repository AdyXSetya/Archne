'use strict';
// Tes Halaman 3b: toggle unduh per postingan (`nodl`). Lima kelompok:
//   1. PageStore: bentuk berkas (nodl hanya true), create, setDl (persisten, indeks tak berubah, masukan cacat)
//   2. Penegakan di PEMILIK: readFileFor menolak selain pemilik; gambar tidak terpengaruh; berlaku seketika
//   3. Kawat: wirePost / wireList hanya mengenali true
//   4. Core (jaringan sungguhan): pageFileGet -> 'nodl' sebelum potongan pertama, di tengah jalan, dibatalkan saat bertanya, permintaan mentah tetap ditolak server
//   5. IPC: pgCreate(…, opts), pgSetDl, kode nodl lewat event pgdl
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { PageStore, wirePost, wireList, FILE_CHUNK } = require('../src/archne-pagestore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagedl-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const code = async (p) => { try { await p; } catch (e) { return e.code || e.message; } return 'tidak melempar'; };
const throws = (f) => { try { f(); } catch (e) { return e.message; } return null; };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const U = { owner: '1'.repeat(16), friend: '2'.repeat(16), stranger: '3'.repeat(16), blocked: '4'.repeat(16) };
const rel = (id) => (id === U.owner ? 'owner' : id === U.friend ? 'friend' : id === U.blocked ? 'blocked' : 'public');
const rnd = (n, seed) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };

(async () => {
  // ---------- 1. PageStore ----------
  const sdir = path.join(tmp, 'store'), ps = new PageStore(sdir, { relation: rel });
  const srcF = path.join(tmp, 'laporan.pdf'); fs.writeFileSync(srcF, 'isi laporan penting');
  const srcI = path.join(tmp, 'foto.png'); fs.writeFileSync(srcI, PNG);
  const mkFiles = async () => ps.addFiles([{ src: srcF }]);
  {
    const [f1] = await mkFiles(), p1 = ps.create({ text: 'tanpa nodl', files: [f1] });
    assert.strictEqual('nodl' in p1, false, 'bawaan: tidak ada field'); assert.strictEqual('nodl' in ps.get(p1.id), false);
    const [f2] = await mkFiles(), p2 = ps.create({ text: 'dimatikan', files: [f2], nodl: true });
    assert.strictEqual(p2.nodl, true); assert.strictEqual(ps.get(p2.id).nodl, true, 'tersimpan di berkas');
    for (const v of [false, undefined, null]) { const [f] = await mkFiles(), p = ps.create({ text: 'x', files: [f], nodl: v }); assert.strictEqual('nodl' in p, false, 'tidak disimpan untuk ' + v); ps.remove(p.id); }
    // bukan boolean = ditolak, tidak ada postingan baru
    const n0 = ps.count();
    for (const v of ['true', 1, 0, {}, [], 'ya']) { const [f] = await mkFiles(); assert(/Pengaturan unduhan/.test(throws(() => ps.create({ text: 'x', files: [f], nodl: v })) || ''), 'ditolak: ' + JSON.stringify(v)); ps.dropFile(f.id); }
    assert.strictEqual(ps.count(), n0, 'tidak ada postingan dari masukan cacat');
    // berkas tulisan tangan dengan nodl:false / 'true' = rusak (dilewati), bukan dianggap sah
    for (const bad of [false, 'true', 1, null]) {
      const f = path.join(sdir, 'p', p1.id.slice(0, 2), p1.id + '.json'), raw = JSON.parse(fs.readFileSync(f, 'utf8')); raw.nodl = bad;
      fs.writeFileSync(f, JSON.stringify(raw)); assert.strictEqual(ps.get(p1.id), null, 'okPost menolak nodl=' + JSON.stringify(bad));
      delete raw.nodl; fs.writeFileSync(f, JSON.stringify(raw)); assert(ps.get(p1.id), 'dipulihkan');
    }
    ps.remove(p1.id); ps.remove(p2.id);
    ok('nodl: hanya true yang disimpan (bawaan tanpa field), create menolak bukan-boolean tanpa sisa, berkas tulisan tangan dengan nodl selain true dianggap rusak');
  }
  {
    const [f] = await mkFiles(), p = ps.create({ text: 'toggle', files: [f] }), idxBefore = fs.readFileSync(path.join(sdir, 'index.json'), 'utf8');
    assert.strictEqual(ps.setDl(p.id, false), true, 'dimatikan -> nodl true'); assert.strictEqual(ps.get(p.id).nodl, true);
    assert.strictEqual(ps.setDl(p.id, false), true, 'matikan lagi = idempoten'); assert.strictEqual(ps.setDl(p.id, true), false, 'dinyalakan -> nodl false'); assert.strictEqual('nodl' in ps.get(p.id), false, 'dinyalakan = field dibuang, bukan false');
    ps.setDl(p.id, false);
    assert.strictEqual(fs.readFileSync(path.join(sdir, 'index.json'), 'utf8'), idxBefore, 'indeks tidak disentuh');
    const re = new PageStore(sdir, { relation: rel }); assert.strictEqual(re.get(p.id).nodl, true, 'bertahan setelah dibuka ulang'); assert.deepStrictEqual(re.get(p.id).files, p.files, 'bidang lain utuh'); assert.strictEqual(re.get(p.id).text, 'toggle');
    for (const v of ['true', 1, 0, null, undefined, {}]) assert(/Pengaturan unduhan/.test(throws(() => ps.setDl(p.id, v)) || ''), 'allow cacat: ' + JSON.stringify(v));
    assert.strictEqual(ps.get(p.id).nodl, true, 'masukan cacat tidak mengubah apa pun');
    assert.strictEqual(ps.setDl('bbbbbbbbbbbbbbbb', true), null, 'id tak ada'); for (const id of ['../x', '', 5, null, undefined, 'ZZZZZZZZZZZZZZZZ']) assert.strictEqual(ps.setDl(id, true), null, 'id cacat: ' + id);
    assert(!fs.readdirSync(path.join(sdir, 'p', p.id.slice(0, 2))).some((n) => n.endsWith('.tmp')), 'tanpa sisa .tmp');
    ps.remove(p.id);
    ok('setDl: menyalakan/mematikan (field dibuang, bukan false), idempoten, bertahan setelah buka ulang, indeks tak berubah, bukan-boolean dilempar, id cacat/tak ada = null');
  }

  // ---------- 2. Penegakan di pemilik ----------
  {
    const [f] = await mkFiles(), [m] = await ps.addMedias([{ src: srcI }]), p = ps.create({ text: 'bergambar dan berlampiran', files: [f], media: [m], nodl: true }), pf = ps.create({ text: 'teman', priv: 'friends', files: [f] });
    // f dipakai dua postingan: salinan berkas ditunjuk keduanya (id sama) — cukup untuk tes baca
    const rd = (who, post = p.id, fid = f.id) => ps.readFileFor(who, post, fid, 0, 1000);
    assert(rd(U.owner), 'pemilik tetap bisa membaca lampirannya sendiri'); assert.strictEqual(rd(U.stranger), null, 'asing ditolak'); assert.strictEqual(rd(U.friend), null, 'teman pun ditolak'); assert.strictEqual(rd(U.blocked), null); assert.strictEqual(rd('xyz'), null);
    assert(ps.readMediaFor(U.stranger, p.id, m.id, 0, 100), 'gambar tidak terpengaruh nodl'); assert(ps.readMediaFor(U.friend, p.id, m.id, 0, 100));
    assert(rd(U.friend, pf.id), 'postingan lain tanpa nodl tetap terbuka untuk teman'); assert.strictEqual(rd(U.stranger, pf.id), null, 'privasi Teman tetap berlaku');
    ps.setDl(p.id, true); assert(rd(U.stranger) && rd(U.friend), 'dinyalakan: terbuka lagi');
    ps.setDl(p.id, false); assert.strictEqual(rd(U.stranger), null, 'dimatikan: tertutup lagi, seketika');
    // listFor / getFor tetap menampilkan postingan (nodl bukan privasi): penonton melihat kartu tanpa Unduh
    assert.strictEqual(ps.getFor(U.stranger, p.id).nodl, true); assert(ps.listFor(U.stranger, {}).items.find((x) => x.id === p.id).nodl === true);
    ps.remove(p.id); ps.remove(pf.id);
    ok('readFileFor: pemilik lolos, asing/teman/diblokir/tanpa id ditolak, gambar tidak terpengaruh, berlaku seketika, privasi Teman tetap, postingan tetap terlihat dengan nodl');
  }

  // ---------- 3. Kawat ----------
  {
    const base = { v: 1, id: 'a'.repeat(16), ts: 1700000000000, kind: 'text', text: 'x', priv: 'public', files: [{ id: 'b'.repeat(16), name: 'a.pdf', size: 5 }] };
    assert.strictEqual(wirePost({ ...base, nodl: true }).nodl, true, 'true diteruskan');
    for (const v of [false, 'true', 1, null, {}, []]) assert.strictEqual('nodl' in wirePost({ ...base, nodl: v }), false, 'bukan true dibuang: ' + JSON.stringify(v));
    assert.strictEqual('nodl' in wirePost(base), false);
    const r = wireList({ items: [{ ...base, nodl: true }], next: null, count: 1 }, { limit: 10 }); assert.strictEqual(r.items[0].nodl, true, 'wireList membawa nodl');
    ok('kawat: wirePost / wireList hanya meneruskan nodl === true');
  }

  // ---------- 4. Core, jaringan sungguhan ----------
  const mk = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 });
  const A = mk('A'), B = mk('B'), C = mk('C'); await A.start(); await B.start(); await C.start();
  try {
    for (const n of [B, C]) await n.addPeer('127.0.0.1', A.port);
    await until(() => [B, C].every((n) => n.peers.has(A.id) && A.peers.has(n.id)), 8000, 'saling kenal');
    A.store.friends[B.id] = { st: 'ok' };
    const aps = A.pageStore(), big = rnd(FILE_CHUNK * 2 + 100, 9), bsrc = path.join(tmp, 'besar.bin'); fs.writeFileSync(bsrc, big);
    const fresh = async () => (await aps.addFiles([{ src: bsrc }]))[0], dlDir = (c) => path.join(c._downloadDir(), 'halaman'), listDl = (c) => { try { return fs.readdirSync(dlDir(c)).sort(); } catch { return []; } };
    const asks = { n: 0, hook: null };
    for (const n of [A, B, C]) { const real = n._pgAsk.bind(n); n._pgAsk = async (...a) => { const isM = a[1] && a[1].t === 'pg_media'; if (isM) asks.n++; const r = await real(...a); return asks.hook && isM ? asks.hook(r, a[1]) : r; }; }

    // 4a. dimatikan sebelum mulai: 'nodl' tanpa satu pun permintaan potongan, tanpa jejak di folder unduhan
    {
      const fb = await fresh(), off = aps.create({ text: 'mati', files: [fb], nodl: true }); asks.n = 0;
      for (const who of [C, B]) { assert.strictEqual(await code(who.pageFileGet(A.id, off.id, fb.id)), 'nodl'); }
      assert.strictEqual(asks.n, 0, 'tidak ada permintaan potongan'); assert.deepStrictEqual([listDl(B), listDl(C)], [[], []], 'tidak memesan nama / membuat berkas');
      const mine = await A.pageFileGet(A.id, off.id, fb.id); assert(fs.readFileSync(mine.path).equals(big), 'pemilik tetap bisa menyalin miliknya sendiri');
      aps.setDl(off.id, true); const r = await B.pageFileGet(A.id, off.id, fb.id); assert(fs.readFileSync(r.path).equals(big), 'dinyalakan: unduhan berjalan normal');
      aps.remove(off.id); fs.rmSync(dlDir(B), { recursive: true, force: true }); fs.rmSync(dlDir(A), { recursive: true, force: true });
      ok('Core: dimatikan sebelum mulai = nodl tanpa permintaan potongan / berkas; pemilik tetap bisa menyalin sendiri; dinyalakan = normal');
    }
    // 4b. dimatikan di tengah unduhan: potongan berikut ditolak -> 'nodl' (bukan 'gone'), tanpa .part / tempat nama
    {
      let fb = await fresh(); const p = aps.create({ text: 'tengah', files: [fb] }); let n = 0;
      asks.hook = (r) => { if (++n === 2) aps.setDl(p.id, false); return r; }; // hook berjalan sesudah potongan ke-2 dilayani, jadi potongan ke-3 yang ditolak
      assert.strictEqual(await code(B.pageFileGet(A.id, p.id, fb.id)), 'nodl'); assert.deepStrictEqual(listDl(B), [], 'tanpa sisa');
      asks.hook = null; aps.setDl(p.id, true); n = 0;
      // berkas / postingan dihapus di tengah jalan = 'gone' (tetap)
      asks.hook = (r) => { if (++n === 2) aps.remove(p.id); return r; };
      assert.strictEqual(await code(C.pageFileGet(A.id, p.id, fb.id)), 'gone'); assert.deepStrictEqual(listDl(C), []);
      asks.hook = null; aps.remove(p.id);
      ok('Core: dimatikan di tengah unduhan = nodl (potongan berikut ditolak), dihapus di tengah = gone, tanpa sisa');
    }
    // 4c. bertanya ulang gagal / dibatalkan selagi bertanya
    {
      const fb = await fresh(), p = aps.create({ text: 'tanya', files: [fb] }); let n = 0;
      asks.hook = (r) => { if (++n === 2) aps.setDl(p.id, false); return r; };
      const real = B.pagePost.bind(B); B.pagePost = async (...a) => { if (n >= 2) throw Object.assign(new Error('x'), { code: 'offline' }); return real(...a); };
      assert.strictEqual(await code(B.pageFileGet(A.id, p.id, fb.id)), 'gone', 'gagal bertanya = gone (perilaku sebelum 3b)');
      aps.setDl(p.id, true); n = 0; const ac = new AbortController(); // dinyalakan lagi: skenario kedua harus lolos pemeriksaan awal
      B.pagePost = async (...a) => { if (n >= 2) ac.abort(); return real(...a); };
      assert.strictEqual(await code(B.pageFileGet(A.id, p.id, fb.id, { signal: ac.signal })), 'cancel', 'dibatalkan selagi bertanya = cancel');
      B.pagePost = real; asks.hook = null; assert.deepStrictEqual(listDl(B), []); aps.remove(p.id);
      ok('Core: bertanya ulang gagal = gone, dibatalkan selagi bertanya = cancel, tanpa sisa');
    }
    // 4d. klien nakal: permintaan mentah pg_media untuk postingan nodl tetap ditolak server (tidak bergantung pada tombol / pemeriksaan klien)
    {
      const fb = await fresh(), p = aps.create({ text: 'mentah', files: [fb], nodl: true });
      for (const who of [C, B]) { const r = await who._pgAsk(A.id, { t: 'pg_media', id: p.id, mid: fb.id, off: 0, len: 1000 }, 5000); assert.strictEqual(r.chunk, null, 'chunk null untuk ' + (who === B ? 'teman' : 'asing')); }
      const post = await C.pagePost(A.id, p.id); assert.strictEqual(post.nodl, true, 'postingan tetap tampil dengan nodl');
      aps.setDl(p.id, true); const r = await C._pgAsk(A.id, { t: 'pg_media', id: p.id, mid: fb.id, off: 0, len: 1000 }, 5000); assert(r.chunk && r.chunk.b64.length > 0, 'dinyalakan: terbuka');
      aps.remove(p.id);
      ok('server menolak pg_media mentah untuk postingan nodl (teman dan asing), postingan tetap tampil dengan nodl');
    }
  } finally { await A.stop(); await B.stop(); await C.stop(); }

  // ---------- 5. IPC ----------
  const A2 = mk('A2'), B2 = mk('B2');
  const fake = (core) => { const handlers = {}, sent = []; register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: (ch, p) => sent.push([ch, p]), log: () => {} }); const f = (n, ...a) => handlers[n]({}, ...a); f.sent = sent; return f; };
  const a = fake(A2), b = fake(B2); await A2.start(); await B2.start();
  try {
    await B2.addPeer('127.0.0.1', A2.port); await until(() => B2.peers.has(A2.id) && A2.peers.has(B2.id), 8000, 'saling kenal');
    const fdir = path.join(A2._pagesDir(), 'files'), nf = () => (fs.existsSync(fdir) ? fs.readdirSync(fdir).length : 0), np = async () => (await a('pgMine', {})).items.length;
    const f1 = path.join(tmp, 'ipc.pdf'); fs.writeFileSync(f1, 'isi ipc');
    // pgCreate opts
    let r = await a('pgCreate', 'mati', 'public', null, [{ src: f1 }], { nodl: true }); assert(r.ok && r.post.nodl === true && r.post.files.length === 1, JSON.stringify(r)); const off = r.post;
    for (const o of [undefined, null, {}, { nodl: false }, { nodl: undefined }, { lain: 1 }]) { r = await a('pgCreate', 'nyala', 'public', null, [{ src: f1 }], o); assert(r.ok && !('nodl' in r.post), 'tanpa nodl untuk ' + JSON.stringify(o)); await a('pgRemove', r.post.id); }
    r = await a('pgCreate', 'tanpa lampiran', 'public', null, null, { nodl: true }); assert(r.ok && r.post.nodl === true, 'sah walau tanpa lampiran (tidak berarti apa-apa)'); await a('pgRemove', r.post.id);
    const n0 = nf(), p0 = await np();
    for (const o of ['x', 5, true, [], [true], { nodl: 'true' }, { nodl: 1 }, { nodl: {} }]) { r = await a('pgCreate', 'cacat', 'public', null, [{ src: f1 }], o); assert(r.ok === false && r.code === 'bad', 'ditolak: ' + JSON.stringify(o)); }
    assert.strictEqual(nf(), n0, 'opts cacat ditolak SEBELUM menyalin apa pun'); assert.strictEqual(await np(), p0, 'tanpa postingan baru');
    ok('pgCreate opts: { nodl: true } = dimatikan sejak awal; undefined/null/{}/false = normal; bukan objek / nodl bukan boolean = bad tanpa salinan');
    // pgSetDl
    r = await a('pgSetDl', off.id, true); assert.deepStrictEqual(r, { ok: true, found: true, nodl: false }); assert.strictEqual((await a('pgMine', {})).items.find((p) => p.id === off.id).nodl, undefined);
    r = await a('pgSetDl', off.id, false); assert.deepStrictEqual(r, { ok: true, found: true, nodl: true }); assert.strictEqual((await a('pgMine', {})).items.find((p) => p.id === off.id).nodl, true);
    assert.deepStrictEqual(await a('pgSetDl', 'bbbbbbbbbbbbbbbb', true), { ok: true, found: false, nodl: false }, 'tak ada = found false');
    for (const args of [['../x', true], [5, true], [off.id, 'true'], [off.id, 1], [off.id, undefined], [off.id], [undefined, undefined]]) { r = await a('pgSetDl', ...args); assert(r.ok === false && r.code === 'bad', 'ditolak: ' + JSON.stringify(args)); }
    assert.strictEqual(A2.pageStore().get(off.id).nodl, true, 'masukan cacat tidak mengubah apa pun');
    ok('pgSetDl: { found, nodl } sesuai keadaan sebenarnya, id tak ada = found false, id / allow cacat = bad tanpa perubahan');
    // unduhan jauh lewat IPC: kode nodl lewat event pgdl (bukan galat langsung: pemeriksaan butuh jaringan)
    r = await b('pgFileGet', A2.id, off.id, off.files[0].id); assert(r.ok && /^[0-9a-f]{16}$/.test(r.id), JSON.stringify(r));
    await until(() => b.sent.some(([ch, p]) => ch === 'pgdl' && p.id === r.id && p.phase !== 'progress'), 8000, 'event akhir');
    let ev = b.sent.find(([ch, p]) => ch === 'pgdl' && p.id === r.id && p.phase !== 'progress')[1];
    assert.strictEqual(ev.phase, 'error'); assert.strictEqual(ev.code, 'nodl'); assert(/mematikan unduhan/.test(ev.err), ev.err); assert(!/[\\/]/.test(ev.err.replace(/\s\/\s/g, '')), 'tanpa jalur');
    await a('pgSetDl', off.id, true); r = await b('pgFileGet', A2.id, off.id, off.files[0].id); await until(() => b.sent.some(([ch, p]) => ch === 'pgdl' && p.id === r.id && p.phase === 'done'), 8000, 'selesai');
    ok('IPC: unduhan jauh dari postingan nodl = event error code nodl dengan pesan jelas (tanpa jalur); dinyalakan = selesai');
  } finally { await A2.stop(); await B2.stop(); }

  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
