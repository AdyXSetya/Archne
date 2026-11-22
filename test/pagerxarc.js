'use strict';
// Tes 5h: reaksi (postingan + komentar) ikut arsip halaman. Ekspor menulis entri `reactions`, impor memulihkannya HANYA untuk identitas yang sama,
// digabung per register (terbaru menang, tidak pernah mencabut yang ada), arsip tidak dipercaya (hitungan, id, emoji diperiksa), dengan PageStore sungguhan.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { PageStore } = require('../src/archne-pagestore');
const { PageRx, PageCmtRx } = require('../src/archne-pagerx');
const { cmtSign } = require('../src/archne-pagecmt');
const { ArcWriter, ArcReader } = require('../src/archne-pagearc');
const { inspectArchive } = require('../src/archne-pageimport');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagerxarc-'));
let pass = 0; const ok = (s) => { pass++; console.log('  OK  ' + s); };
const out = (n) => path.join(tmp, n);
const H = (n) => n.toString(16).padStart(16, '0');
const OWN = H(0xabc), OTHER = H(0xdef);
let sn = 0; const fresh = (owner) => new PageStore(path.join(tmp, 'S' + (sn++)), { ownerId: owner });
const U = (() => { const k = crypto.generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; })();
const T0 = Date.now() - 100000;
const F1 = H(0x11), F2 = H(0x22), F3 = H(0x33);
const who = (st, pid) => st.rx.owner(pid, OWN).who.map((w) => w.e + ':' + w.by.slice().sort().join(','));
const J = (o) => Buffer.from(JSON.stringify(o));

(async () => {
  try {
    const ps = fresh(OWN);
    const p1 = ps.create({ text: 'satu' }), p2 = ps.create({ text: 'dua' }), p3 = ps.create({ text: 'tiga' });
    const c1 = cmtSign(U.priv, U.pub, OWN, p1.id, 'komentar 1', T0 + 1), c2 = cmtSign(U.priv, U.pub, OWN, p2.id, 'komentar 2', T0 + 2);
    ps.cmt.add(c1); ps.cmt.add(c2);
    ps.rx.set(F1, p1.id, '👍', T0 + 10); ps.rx.set(F2, p1.id, '❤️', T0 + 11); ps.rx.set(F1, p2.id, '😂', T0 + 12);
    ps.crx.set(F1, p1.id, c1.id, '👍', T0 + 20); ps.crx.set(F3, p2.id, c2.id, '🔥', T0 + 21);
    ps.rx.set(F3, p3.id, '👍', T0 + 13); ps.rx.set(F3, p3.id, '', T0 + 14); // dicabut: tombstone ikut tersimpan

    // 1. ekspor: entri reactions + meta; reaksi komentar hanya bila komentarnya ikut; subset; dimatikan; tanpa reaksi = tanpa entri
    {
      const r = await ps.exportTo(out('full.arc'), { comments: true });
      assert.deepStrictEqual(r.reactions, { posts: 4, cmts: 2 }, 'tombstone ikut dihitung sebagai register');
      const rd = await ArcReader.open(out('full.arc'));
      assert.deepStrictEqual(rd.meta.reactions, { posts: 4, cmts: 2 });
      const j = JSON.parse((await rd.readBuffer('reactions')).toString());
      assert.strictEqual(j.owner, OWN); assert.strictEqual(j.v, 1);
      assert.deepStrictEqual(Object.keys(j.posts).sort(), [p1.id + p1.id, p2.id + p2.id, p3.id + p3.id].sort());
      assert.deepStrictEqual(Object.keys(j.cmts).sort(), [p1.id + c1.id, p2.id + c2.id].sort());
      await rd.close();
      const nc = await ps.exportTo(out('nocmt.arc')); // tanpa komentar -> reaksi komentar tidak ikut
      assert.deepStrictEqual(nc.reactions, { posts: 4, cmts: 0 });
      const sub = await ps.exportTo(out('sub.arc'), { ids: [p2.id], comments: true });
      assert.deepStrictEqual(sub.reactions, { posts: 1, cmts: 1 }, 'subset: reaksi postingan lain tidak ikut');
      const off = await ps.exportTo(out('off.arc'), { comments: true, reactions: false });
      assert.strictEqual(off.reactions, null); const rd2 = await ArcReader.open(out('off.arc')); assert(!rd2.has('reactions') && rd2.meta.reactions === undefined); await rd2.close();
      const empty = fresh(OWN); empty.create({ text: 'sepi' });
      const e = await empty.exportTo(out('empty.arc'), { comments: true }); assert.strictEqual(e.reactions, null);
      const rd3 = await ArcReader.open(out('empty.arc')); assert(!rd3.has('reactions')); await rd3.close();
    }
    ok('ekspor: entri reactions + meta, reaksi komentar ikut komentarnya, subset, bisa dimatikan, tanpa reaksi tanpa entri');

    // 2. impor ke identitas yang sama: semua kembali (reaksi postingan + komentar), tampilan dan daftar pelaku sama
    let dst;
    {
      dst = fresh(OWN);
      const rep = await inspectArchive(dst, out('full.arc'), { verify: false });
      assert.deepStrictEqual([rep.reactions.present, rep.reactions.status, rep.reactions.restorable, rep.reactions.posts, rep.reactions.cmts], [true, 'ok', true, 4, 2]);
      assert.deepStrictEqual([rep.reactions.plan.added, rep.reactions.plan.same], [3, 1], 'rencana dry-run: 3 reaksi hidup; tombstone tanpa lawan tidak dicatat');
      assert.deepStrictEqual(dst.rx.map, {}, 'pratinjau tidak menulis');
      const r = await dst.importFrom(out('full.arc'));
      assert.strictEqual(r.imported.length, 3);
      assert.deepStrictEqual([r.reactions.status, r.reactions.post.added, r.reactions.cmt.added], ['done', 3, 2]);
      for (const p of [p1, p2, p3]) assert.deepStrictEqual(dst.rx.owner(p.id, OWN), ps.rx.owner(p.id, OWN), 'reaksi postingan sama persis');
      assert.deepStrictEqual(dst.crx.owner(p1.id, c1.id, OWN), ps.crx.owner(p1.id, c1.id, OWN));
      assert.deepStrictEqual(dst.crx.owner(p2.id, c2.id, OWN), ps.crx.owner(p2.id, c2.id, OWN));
      assert.deepStrictEqual(who(dst, p1.id), who(ps, p1.id));
      assert.deepStrictEqual(new PageRx(path.join(dst.dir, 'reactions.json')).map, dst.rx.map, 'tersimpan di disk');
      assert.deepStrictEqual(new PageCmtRx(path.join(dst.dir, 'cmtreactions.json')).map, dst.crx.map);
      // impor ulang: idempoten
      const r2 = await dst.importFrom(out('full.arc'));
      assert.strictEqual(r2.imported.length, 0); assert.deepStrictEqual([r2.reactions.post.added, r2.reactions.post.same, r2.reactions.cmt.added, r2.reactions.cmt.same], [0, 4, 0, 2], '3 reaksi sama + 1 tombstone tanpa lawan; 2 reaksi komentar sama');
    }
    ok('impor identitas sama: reaksi postingan + komentar kembali persis, tersimpan, impor ulang tidak mengubah apa pun');

    // 3. gabung per register: yang lebih baru menang, yang ada tidak pernah dicabut, yang lain tidak tersentuh
    {
      const m = fresh(OWN);
      await m.importFrom(out('off.arc')); // postingan masuk, tanpa reaksi
      m.rx.set(F1, p1.id, '🎉', T0 + 999);   // lokal LEBIH BARU dari arsip (T0 + 10)
      m.rx.set(F2, p1.id, '😮', T0 + 1);     // lokal LEBIH LAMA dari arsip (T0 + 11), diperbarui
      m.rx.set(OTHER, p1.id, '👏', T0 + 50); // hanya ada di lokal
      const before = JSON.stringify(m.rx.map[p1.id + p1.id]);
      const r = await m.importFrom(out('nocmt.arc'));
      assert.strictEqual(r.reactions.status, 'done');
      const row = m.rx.map[p1.id + p1.id];
      assert.strictEqual(row[F1].e, '🎉', 'lokal lebih baru tidak ditimpa'); assert.strictEqual(row[F2].e, '❤️', 'lokal lebih lama diperbarui'); assert.strictEqual(row[OTHER].e, '👏', 'milik lokal tidak dicabut');
      assert.notStrictEqual(JSON.stringify(row), before);
      assert.deepStrictEqual([r.reactions.post.stale >= 1, r.reactions.post.updated >= 1], [true, true]);
    }
    ok('gabung: register terbaru menang, reaksi lokal tidak dicabut, yang lama diperbarui');

    // 4. identitas lain: postingan masuk, reaksi TIDAK dibawa (arsip tidak dipercaya), dilaporkan
    {
      const o = fresh(OTHER);
      const rep = await inspectArchive(o, out('full.arc'), { verify: false });
      assert.deepStrictEqual([rep.reactions.present, rep.reactions.restorable, rep.reactions.plan], [true, false, null]);
      const r = await o.importFrom(out('full.arc'));
      assert.strictEqual(r.imported.length, 3);
      assert.deepStrictEqual([r.reactions.status, r.reactions.why, r.reactions.posts, r.reactions.cmts], ['skipped', 'owner', 4, 2]);
      assert.deepStrictEqual(o.rx.map, {}); assert.deepStrictEqual(o.crx.map, {});
    }
    ok('identitas lain: postingan masuk, reaksi dilaporkan tidak dibawa dan tidak ada yang ditulis');

    // 5. komentar dimatikan saat impor: reaksi postingan tetap pulih, reaksi komentar yatim dibuang; reactions:false mematikan semuanya
    {
      const a = fresh(OWN);
      const r = await a.importFrom(out('full.arc'), { comments: false });
      assert.strictEqual(r.comments.status, 'skipped');
      assert.strictEqual(r.reactions.post.added, 3); assert.strictEqual(r.reactions.cmt.added, 0); assert.strictEqual(r.reactions.cmt.orphan, 2);
      assert.deepStrictEqual(a.crx.map, {});
      const b = fresh(OWN);
      const r2 = await b.importFrom(out('full.arc'), { reactions: false });
      assert.deepStrictEqual([r2.reactions.status, r2.reactions.why], ['skipped', 'off']); assert.deepStrictEqual(b.rx.map, {});
      assert.strictEqual(b.cmt.list(p1.id).length, 1, 'komentar tetap pulih');
    }
    ok('komentar mati: reaksi komentar yatim dibuang, reaksi postingan tetap; reactions:false mematikan reaksi saja');

    // 6. arsip tidak dipercaya: hitungan tak cocok = bad (postingan tetap masuk); id / emoji / ts cacat dibuang; kunci di luar daftar yatim
    {
      const pp = { v: 1, id: p1.id, ts: 1700000000000, kind: 'text', text: 'halo', priv: 'public' };
      const mk = async (name, rx, meta) => {
        const w = await ArcWriter.create(out(name));
        await w.addBuffer('post/' + p1.id, J(pp));
        if (rx) await w.addBuffer('reactions', J(rx));
        await w.finish(Object.assign({ kind: 'archne-pages', fmt: 1, owner: OWN, posts: [p1.id] }, meta || {}));
        return out(name);
      };
      const k1 = p1.id + p1.id;
      const good = { v: 1, owner: OWN, posts: { [k1]: { [F1]: { e: '👍', ts: 5 } } }, cmts: {} };
      // hitungan di meta tidak cocok
      let s = fresh(OWN); let r = await s.importFrom(await mk('c1.arc', good, { reactions: { posts: 9, cmts: 0 } }));
      assert.deepStrictEqual([r.imported.length, r.reactions.status, r.reactions.why], [1, 'bad', 'count']); assert.deepStrictEqual(s.rx.map, {});
      // meta menyebut reaksi tapi entri tidak ada, dan sebaliknya
      s = fresh(OWN); r = await s.importFrom(await mk('c2.arc', null, { reactions: { posts: 1, cmts: 0 } })); assert.strictEqual(r.reactions.status, 'bad');
      s = fresh(OWN); r = await s.importFrom(await mk('c3.arc', good, {})); assert.strictEqual(r.reactions.status, 'bad', 'entri tanpa meta ditolak');
      // pemilik di entri beda dengan meta
      s = fresh(OWN); r = await s.importFrom(await mk('c4.arc', Object.assign({}, good, { owner: OTHER }), { reactions: { posts: 1, cmts: 0 } })); assert.strictEqual(r.reactions.status, 'bad');
      // isi cacat: emoji bukan emoji, id pelaku bukan heks, ts negatif / pecahan, kunci bukan id+id, kunci postingan di luar daftar
      const evil = { v: 1, owner: OWN, posts: {
        [k1]: { [F1]: { e: '👍', ts: 5 }, [F2]: { e: '<script>', ts: 5 }, 'zz': { e: '👍', ts: 5 }, [F3]: { e: '👍', ts: -1 }, [H(0x44)]: { e: '👍', ts: 1.5 } },
        [H(1) + H(2)]: { [F1]: { e: '👍', ts: 5 } }, // bukan id + id
        [H(0x77) + H(0x77)]: { [F1]: { e: '👍', ts: 5 } }, // postingan tidak ada di arsip
      }, cmts: {} };
      s = fresh(OWN); r = await s.importFrom(await mk('c5.arc', evil, { reactions: { posts: 7, cmts: 0 } }));
      assert.strictEqual(r.reactions.status, 'done'); assert.deepStrictEqual(Object.keys(s.rx.map), [k1]); assert.deepStrictEqual(Object.keys(s.rx.map[k1]), [F1]);
      assert.deepStrictEqual([r.reactions.post.added, r.reactions.post.bad, r.reactions.post.orphan], [1, 4, 2]);
    }
    ok('arsip tidak dipercaya: hitungan / pemilik / entri tak cocok = bad (postingan tetap masuk), id-emoji-ts cacat dan yatim dibuang');

    // 7. PageRx / PageCmtRx.merge langsung: dry tanpa efek, batas 256 orang per sasaran
    {
      const f = path.join(tmp, 'rx.json'), rx = new PageRx(f), P = H(500), k = P + P;
      const raw = { [k]: { [F1]: { e: '👍', ts: 1 } } };
      assert.strictEqual(rx.merge(raw, { dry: true }).added, 1); assert(!fs.existsSync(f) && !Object.keys(rx.map).length, 'dry tidak mengubah apa pun');
      assert.strictEqual(rx.merge(raw).added, 1); assert(fs.existsSync(f));
      assert.strictEqual(rx.merge(raw).same, 1);
      assert.deepStrictEqual(rx.dump(() => false), {}); assert.deepStrictEqual(rx.dump((id) => id === P), rx.map);
      assert.deepStrictEqual([rx.merge(null).added, rx.merge({ x: 1 }).bad, rx.merge([]).added], [0, 1, 0]);
      const big = {}; for (let i = 0; i < 300; i++) big[H(0x1000 + i)] = { e: '👍', ts: 1 };
      const r = new PageRx(path.join(tmp, 'rx2.json')).merge({ [k]: big });
      assert.deepStrictEqual([r.added, r.full], [256, 44], 'batas 256 orang per sasaran');
      const c = new PageCmtRx(path.join(tmp, 'crx.json')), C = H(600);
      assert.strictEqual(c.merge({ [P + C]: { [F1]: { e: '🔥', ts: 2 } } }, { has: (pid, cid) => pid === P && cid === C }).added, 1);
      assert.strictEqual(c.merge({ [P + C]: { [F2]: { e: '🔥', ts: 2 } } }, { has: () => false }).orphan, 1);
    }
    ok('PageRx / PageCmtRx.merge: dry tanpa efek, tersimpan, idempoten, batas 256 orang, masukan cacat dihitung');

    console.log('\n' + pass + ' kelompok tes lulus');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
