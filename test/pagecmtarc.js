'use strict';
// Tes 5d-5: komentar + nisan di arsip halaman (ekspor opts.comments, impor memulihkan hanya untuk identitas yang sama, PageCmt.dump / merge) dengan Core dan PageStore sungguhan.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { PageStore } = require('../src/archne-pagestore');
const { PageCmt, cmtSign, CMT_PER_AUTHOR, CMT_SKEW } = require('../src/archne-pagecmt');
const { ArcWriter, ArcReader } = require('../src/archne-pagearc');
const { inspectArchive } = require('../src/archne-pageimport');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagecmtarc-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const out = (n) => path.join(tmp, n);
const mkCore = (n) => new Core({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false });
let sn = 0; const fresh = (owner) => new PageStore(path.join(tmp, 'S' + (sn++)), owner === null ? {} : { ownerId: owner });
function ident() {
  const k = crypto.generateKeyPairSync('ed25519'), pub = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { priv: k.privateKey, pub, id: crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 16) };
}
const U1 = ident(), U2 = ident();
const T0 = 1700000000000;
const sign = (u, owner, post, text, ts) => cmtSign(u.priv, u.pub, owner, post, text, ts == null ? T0 : ts);
const H = (n) => n.toString(16).padStart(16, '0');
const post = (id, x) => Object.assign({ v: 1, id, ts: 1700000000000, kind: 'text', text: 'halo ' + id, priv: 'public' }, x || {});
const J = (o) => Buffer.from(JSON.stringify(o));
async function mkc(name, posts, cmt, meta, opt) {
  opt = opt || {};
  const w = await ArcWriter.create(out(name));
  for (const p of posts) await w.addBuffer('post/' + p.id, J(p));
  let items = 0; if (cmt) for (const k of Object.keys(cmt.map)) items += cmt.map[k].length;
  if (cmt && !opt.noEntry) await w.addBuffer('comments', J(cmt));
  const m = Object.assign({ kind: 'archne-pages', fmt: 1, owner: cmt ? cmt.owner : null, posts: posts.map((p) => p.id) }, cmt && !opt.noMeta ? { comments: { items, tombs: cmt.rm.length } } : {}, meta || {});
  await w.finish(m);
  return out(name);
}
const snap = (dir) => { const r = []; (function w(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), s = fs.statSync(f); if (s.isDirectory()) w(f); else r.push(path.relative(dir, f) + ':' + s.size + ':' + s.mtimeMs); } })(dir); return r; };
const cids = (st, pid) => st.cmt.list(pid).map((c) => c.id);

(async () => {
  const A = mkCore('A'), B = mkCore('B'); await A.start(); await B.start();
  try {
    const ps = A.pageStore(), own = A.id;
    const p1 = ps.create({ text: 'satu' }), p2 = ps.create({ text: 'dua' }), p3 = ps.create({ text: 'tiga' });
    const c1 = sign(U1, own, p1.id, 'komentar 1', T0 + 1), c2 = sign(U2, own, p1.id, 'komentar 2', T0 + 2), c3 = sign(U1, own, p2.id, 'komentar 3', T0 + 3), c4 = sign(U2, own, p2.id, 'komentar 4', T0 + 4);
    for (const c of [c1, c2, c3, c4]) assert.strictEqual(ps.cmt.add(c), 'added');
    await ps.exportTo(out('pre.arc'), { comments: true }); // sebelum penghapusan
    assert.strictEqual(ps.removeComment(p1.id, c2.id), true);
    await ps.exportTo(out('post.arc'), { comments: true }); // sesudah: c2 jadi nisan
    await ps.exportTo(out('plain.arc'));

    // 1. ekspor: bawaan TANPA komentar; dicentang = entri comments (komentar hidup + nisan), meta menghitung, subset hanya postingan yang ikut
    {
      let rd = await ArcReader.open(out('plain.arc'));
      assert(!rd.has('comments') && rd.meta.comments === undefined, 'bawaan tanpa komentar'); await rd.close();
      rd = await ArcReader.open(out('post.arc'));
      assert.deepStrictEqual(rd.meta.comments, { items: 3, tombs: 1 });
      const j = JSON.parse((await rd.readBuffer('comments')).toString());
      assert.strictEqual(j.owner, own); assert.deepStrictEqual(Object.keys(j.map).sort(), [p1.id, p2.id].sort()); assert.deepStrictEqual(j.rm, [p1.id + ':' + c2.id]);
      assert.deepStrictEqual(j.map[p2.id].map((c) => c.id), [c3.id, c4.id], 'urutan tertua dulu'); await rd.close();
      const r = await ps.exportTo(out('sub.arc'), { ids: [p2.id], comments: true });
      assert.deepStrictEqual(r.comments, { items: 2, tombs: 0 }, 'subset: komentar postingan lain tidak ikut');
      const bare = fresh(null); await assert.rejects(() => bare.exportTo(out('x.arc'), { comments: true }), (e) => e.code === 'bad');
      assert(!fs.existsSync(out('x.arc')) && !fs.existsSync(out('x.arc.tmp')), 'gagal = tak ada sisa');
    }
    ok('ekspor: komentar hanya bila dicentang, nisan ikut, subset memangkas, store tanpa komentar menolak');

    // 2. arsip tanpa komentar: status none
    { const s = fresh(own); const r = await s.importFrom(out('plain.arc')); assert.deepStrictEqual([r.imported.length, r.comments.status], [3, 'none']); assert(!fs.existsSync(path.join(s.dir, 'comments.json'))); }
    ok('arsip tanpa komentar: status none, tak ada berkas komentar');

    // 3. identitas SAMA: komentar utuh, nisan ikut (komentar terhapus tidak hidup lagi), bertahan restart, urutan terjaga
    let same;
    {
      same = fresh(own);
      const d = await inspectArchive(same, out('post.arc'), { verify: false }), before = snap(same.dir);
      assert(d.comments.present && d.comments.restorable && d.comments.status === 'ok');
      assert.deepStrictEqual([d.comments.plan.added, d.comments.plan.tombAdded], [3, 1], 'dry-run merencanakan persis');
      assert.deepStrictEqual(snap(same.dir), before, 'dry-run tidak menulis');
      const r = await same.importFrom(out('post.arc'));
      assert.strictEqual(r.comments.status, 'done'); assert.deepStrictEqual([r.comments.added, r.comments.tombAdded, r.comments.bad], [3, 1, 0]);
      assert.deepStrictEqual(cids(same, p1.id), [c1.id]); assert.deepStrictEqual(cids(same, p2.id), [c3.id, c4.id]);
      assert.strictEqual(same.cmt.add(c2), 'removed', 'nisan ikut: c2 tidak bisa masuk lagi');
      const re = new PageStore(same.dir, { ownerId: own });
      assert.deepStrictEqual(cids(re, p2.id), [c3.id, c4.id]); assert.strictEqual(re.cmt.add(c2), 'removed', 'bertahan restart');
    }
    ok('identitas sama: komentar utuh dan berurutan, nisan ikut, dry-run akurat dan tanpa tulis, bertahan restart');

    // 4. impor ulang idempoten: tak ada tulis ke comments.json
    {
      const f = path.join(same.dir, 'comments.json'), b = fs.readFileSync(f), m = fs.statSync(f).mtimeMs;
      const r = await same.importFrom(out('post.arc'));
      assert.deepStrictEqual([r.imported.length, r.same.length, r.comments.status, r.comments.added, r.comments.same, r.comments.tombSame], [0, 3, 'done', 0, 3, 1]);
      assert(fs.readFileSync(f).equals(b) && fs.statSync(f).mtimeMs === m, 'berkas komentar tak disentuh');
    }
    ok('impor ulang: semua same, berkas komentar tidak ditulis');

    // 5. identitas BEDA: postingan masuk, komentar tidak dibawa dan dilaporkan; tidak ada berkas komentar
    {
      const sb = B.pageStore();
      const d = await inspectArchive(sb, out('post.arc'), { verify: false });
      assert(d.comments.present && !d.comments.restorable && d.comments.plan === null && d.ownerMatch === false);
      const r = await sb.importFrom(out('post.arc'));
      assert.strictEqual(r.imported.length, 3); assert.deepStrictEqual([r.comments.status, r.comments.why, r.comments.items, r.comments.tombs], ['skipped', 'owner', 3, 1]);
      assert.strictEqual(sb.cmt.count(p1.id) + sb.cmt.count(p2.id), 0); assert(!fs.existsSync(path.join(sb.dir, 'comments.json')));
      const bare = fresh(null); // store tanpa komentar (tanpa ownerId): juga dilewati, bukan gagal
      const r2 = await bare.importFrom(out('post.arc')); assert.deepStrictEqual([r2.imported.length, r2.comments.status, r2.comments.why], [3, 'skipped', 'off']);
      const unk = await mkc('unk.arc', [post(H(1))], { v: 1, owner: null, map: {}, rm: [] }); // pemilik tak diketahui: tak terbukti sama
      const r3 = await fresh(own).importFrom(unk); assert.deepStrictEqual([r3.imported.length, r3.comments.status, r3.comments.why], [1, 'skipped', 'owner']);
    }
    ok('identitas beda / tak diketahui / komentar mati: postingan masuk, komentar dilaporkan tidak dibawa');

    // 6. nisan menang atas komentar arsip; nisan arsip tidak menghapus komentar yang hidup
    {
      const f = fresh(own); await f.importFrom(out('post.arc')); // punya nisan c2
      const r = await f.importFrom(out('pre.arc')); // arsip lama masih memuat c2
      assert.deepStrictEqual([r.comments.removed, r.comments.added, r.comments.same], [1, 0, 3], 'c2 dari arsip lama ditolak nisan lokal'); assert(!cids(f, p1.id).includes(c2.id));
      const g = fresh(own); await g.importFrom(out('pre.arc')); // c2 hidup di sini
      const r2 = await g.importFrom(out('post.arc'));
      assert.deepStrictEqual([r2.comments.tombLive, r2.comments.tombAdded], [1, 0]); assert(cids(g, p1.id).includes(c2.id), 'impor tidak pernah menghapus komentar hidup');
    }
    ok('nisan lokal menang atas arsip lama; nisan arsip tak menghapus komentar yang hidup');

    // 7. arsip jahat: tiap komentar diverifikasi ulang, yang gagal dibuang dan dihitung
    {
      const P = post(H(100)), Q = post(H(101)), OR = H(102);
      const good = sign(U1, own, P.id, 'sah'), tam = Object.assign({}, sign(U1, own, P.id, 'asli', T0 + 1), { text: 'dipalsukan' });
      const other = sign(U1, H(999), P.id, 'untuk halaman lain', T0 + 2), fut = sign(U1, own, P.id, 'masa depan', Date.now() + CMT_SKEW + 3600e3);
      const orph = sign(U1, own, OR, 'yatim'), many = []; for (let i = 0; i < CMT_PER_AUTHOR + 1; i++) many.push(sign(U2, own, Q.id, 'banyak ' + i, T0 + 10 + i));
      const f = await mkc('evil.arc', [P, Q], { v: 1, owner: own, map: { [P.id]: [good, tam, other, fut], [Q.id]: many, [OR]: [orph] }, rm: [P.id + ':' + good.id.replace(/./, 'x'), H(555) + ':' + H(556)] });
      const s = fresh(own), r = await s.importFrom(f);
      assert.strictEqual(r.comments.status, 'done');
      assert.deepStrictEqual([r.comments.added, r.comments.bad, r.comments.ts, r.comments.full, r.comments.orphan], [1 + CMT_PER_AUTHOR, 2 + 1, 1, 1, 1]);
      assert.deepStrictEqual([r.comments.tombAdded, r.comments.tombOrphan], [0, 1], 'nisan rusak dihitung bad, nisan untuk postingan tak ikut = orphan');
      assert.deepStrictEqual(cids(s, P.id), [good.id]); assert.strictEqual(s.cmt.count(Q.id), CMT_PER_AUTHOR); assert.strictEqual(s.cmt.count(OR), 0);
      // komentar untuk postingan yang bentrok (id sama, isi beda) tidak ikut
      const X = post(H(200)), s2 = fresh(own); s2.adoptPost(Object.assign({}, X, { text: 'beda' }));
      const r2 = await s2.importFrom(await mkc('conf.arc', [X], { v: 1, owner: own, map: { [X.id]: [sign(U1, own, X.id, 'x')] }, rm: [] }));
      assert.deepStrictEqual([r2.conflict.length, r2.comments.added, r2.comments.orphan], [1, 0, 1]); assert.strictEqual(s2.cmt.count(X.id), 0);
    }
    ok('arsip jahat: tanda tangan palsu / halaman lain / masa depan / yatim / melebihi batas dibuang dan dihitung; postingan bentrok tak membawa komentar');

    // 8. entri komentar tidak konsisten dengan meta: komentar gagal ('bad'), postingan tetap masuk
    {
      const P = post(H(300)), cm = { v: 1, owner: own, map: { [P.id]: [sign(U1, own, P.id, 'x')] }, rm: [] };
      const cases = [
        ['nometa.arc', cm, { noMeta: true }, null, 'nometa'], ['noentry.arc', cm, { noEntry: true }, null, 'nocmt'],
        ['count.arc', cm, {}, { comments: { items: 9, tombs: 0 } }, 'count'], ['own.arc', Object.assign({}, cm, { owner: H(7) }), {}, { owner: own }, 'cmt'],
        ['shape.arc', Object.assign({}, cm, { map: [] }), {}, null, 'cmt'],
      ];
      for (const [n, c, opt, meta, why] of cases) {
        const s = fresh(own), r = await s.importFrom(await mkc(n, [P], c, meta, opt));
        assert.deepStrictEqual([r.imported.length, r.comments.status, r.comments.why], [1, 'bad', why], n); assert.strictEqual(s.cmt.count(P.id), 0, n);
      }
      const badMeta = await mkc('bm.arc', [P], cm, { comments: { items: -1, tombs: 0 } });
      await assert.rejects(() => inspectArchive(fresh(own), badMeta), (e) => e.code === 'bad', 'meta.comments tidak sah = arsip ditolak');
    }
    ok('entri komentar tak cocok meta (hilang, jumlah, pemilik, bentuk): komentar gagal tanpa menggagalkan postingan');

    // 9. gagal tulis komentar: memori kembali, postingan tetap masuk, e.partial; impor ulang melengkapi
    {
      const s = fresh(own), realW = s.cmt.write;
      s.cmt.write = () => { throw new Error('disk penuh'); };
      let err = null; try { await s.importFrom(out('post.arc')); } catch (e) { err = e; }
      assert(err && err.message === 'disk penuh' && err.partial && err.partial.imported.length === 3, 'dilempar dengan hasil sementara');
      assert.deepStrictEqual([s.cmt.count(p1.id), s.cmt.count(p2.id), s.cmt.total, s.cmt.rm.size], [0, 0, 0, 0], 'memori kembali');
      s.cmt.write = realW;
      const r = await s.importFrom(out('post.arc'));
      assert.deepStrictEqual([r.same.length, r.comments.status, r.comments.added], [3, 'done', 3]);
    }
    ok('gagal tulis komentar: dibatalkan utuh, postingan aman, impor ulang melengkapi');

    // 10. pembatalan: komentar tidak diproses; opts.comments:false; impor ulang memulihkan
    {
      const s = fresh(own), ac = new AbortController();
      const r = await s.importFrom(out('post.arc'), { signal: ac.signal, onProgress: (p) => { if (p.posts >= 1) ac.abort(); } });
      assert(r.aborted && r.imported.length < 3, 'terbatal di tengah'); assert.deepStrictEqual([r.comments.status, r.comments.why], ['skipped', 'abort']);
      assert.strictEqual(s.cmt.total, 0);
      const r2 = await s.importFrom(out('post.arc'), { comments: false });
      assert.deepStrictEqual([r2.aborted, r2.comments.status, r2.comments.why], [false, 'skipped', 'off']); assert.strictEqual(s.cmt.total, 0);
      const r3 = await s.importFrom(out('post.arc'));
      assert.deepStrictEqual([r3.comments.status, r3.comments.added], ['done', 3]);
    }
    ok('dibatalkan / dimatikan: komentar ditunda, impor ulang memulihkan');

    // 11. PageCmt.merge langsung: tanpa efek saat dry; batas berkas komentar
    {
      const f = path.join(tmp, 'm.json'), c = new PageCmt(f, own), P = H(400);
      const items = [sign(U1, own, P, 'a'), sign(U2, own, P, 'b', T0 + 1)];
      const d = c.merge({ [P]: items }, [], { dry: true }); assert.strictEqual(d.added, 2); assert(!fs.existsSync(f) && c.total === 0, 'dry tidak mengubah apa pun');
      assert.strictEqual(c.merge({ [P]: items }, []).added, 2); assert.strictEqual(c.total, 2);
      assert.deepStrictEqual(c.dump((id) => id === P).map[P].map((x) => x.id), c.list(P).map((x) => x.id));
      assert.deepStrictEqual(c.dump(() => false), { map: {}, rm: [] });
      assert.strictEqual(new PageCmt(f, own).total, 2, 'tersimpan');
      assert.strictEqual(c.merge(null, null).added, 0); assert.strictEqual(c.merge({ [P]: 5, zz: [1] }, ['x']).bad, 3);
    }
    ok('PageCmt.merge / dump: dry tanpa efek, tersimpan, masukan cacat dihitung bad');
    console.log('\n' + pass + ' kelompok tes lulus');
  } finally { try { await A.stop(); await B.stop(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
