'use strict';
// Tes Halaman 5a-2: batas stream video bersamaan yang bisa diatur (pgStreamMax per Core, pgStreamPeer per pemilik jauh). Berlaku seketika (dibaca tiap panggilan),
// stream yang sudah berjalan tidak dipotong, validasi [min, maks], bertahan lewat restart. Jaringan sungguhan (soket lokal).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagestreamlimit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label); }
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'tidak melempar'; };

(async () => {
  const A = mk('A'), C = mk('C');
  for (const n of [A, C]) await n.start();
  await C.addPeer('127.0.0.1', A.port);
  await until(() => C.peers.has(A.id) && A.peers.has(C.id), 8000, 'peer saling kenal');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(2000, 7)]);
  const sp = path.join(tmp, 's.mp4'); fs.writeFileSync(sp, mp4);
  const ps = A.pageStore();
  const v1 = await ps.addVideos([{ src: sp }, { src: sp }, { src: sp }, { src: sp }]), v2 = await ps.addVideos([{ src: sp }, { src: sp }]); // satu postingan memuat paling banyak VIDEOS_MAX
  const p1 = ps.create({ text: 'video 1-4', videos: v1 }), p2 = ps.create({ text: 'video 5-6', videos: v2 });
  const vs = [...v1, ...v2].map((v, i) => ({ id: v.id, post: i < v1.length ? p1.id : p2.id }));
  const reset = () => { A._pgMediaRate = new Map(); C._ptok = new Map(); };
  const get = (i) => C.pageMedia(A.id, vs[i].post, vs[i].id);
  const fake = (i) => C._ptok.set(String(i).repeat(32), { vid: true, self: false, peerId: String(i).repeat(16), exp: Date.now() + 1e6, last: Date.now() }); // aktif dari pemilik lain
  reset();

  // 1. bawaan 3 / 2, rentang untuk UI
  {
    const s = C.getSettings().pages.streams;
    assert.deepStrictEqual(s, { def: { max: 3, peer: 2 }, min: { max: 1, peer: 1 }, ceil: { max: 8, peer: 4 }, max: 3, peer: 2 });
    assert.deepStrictEqual(C._pgStreamLimits(), { max: 3, peer: 2 });
    assert.strictEqual('pgStreamMax' in C._settings || 'pgStreamPeer' in C._settings, false);
    await get(0); await get(1); assert.strictEqual(await code(get(2)), 'streams');
    ok('bawaan 3 per Core / 2 per pemilik: perilaku lama tetap (ke-3 dari satu pemilik = streams)');
  }

  // 2. per pemilik dinaikkan / diturunkan: seketika, tanpa restart
  {
    reset();
    assert.strictEqual(C.setSettings({ pgStreamPeer: 1 }).pages.streams.peer, 1);
    const r1 = await get(0); assert.strictEqual(await code(get(1)), 'streams', 'peer = 1: yang kedua ditolak');
    assert.strictEqual(C.setSettings({ pgStreamMax: 5, pgStreamPeer: 4 }).ok, true);
    await get(1); await get(2); await get(3);
    assert.strictEqual(await code(get(4)), 'streams', 'peer = 4: yang kelima ditolak');
    assert.strictEqual((await C.mediaSrcRead(r1.tok, 0, 8)).length, 8);
    ok('per pemilik: 1, lalu 4, berlaku seketika; batas dibaca tiap panggilan');
  }

  // 3. per Core lintas pemilik; menurunkan batas tidak memotong stream yang sedang jalan
  {
    reset(); C.setSettings({ pgStreamMax: 2, pgStreamPeer: 4 });
    fake(1); const a = await get(0); assert.strictEqual(await code(get(1)), 'streams', 'max = 2: sudah 2 aktif (1 pemilik lain + 1 ini)');
    C.setSettings({ pgStreamMax: 1 });
    assert.strictEqual((await C.mediaSrcRead(a.tok, 0, 8)).length, 8, 'token yang sudah ada tetap terbaca meski batas diturunkan di bawah jumlah aktif');
    assert.strictEqual(await code(get(2)), 'streams');
    C.setSettings({ pgStreamMax: 8 }); fake(2); fake(3); fake(4);
    assert.strictEqual((await get(3)).mime, 'video/mp4', 'max = 8: lolos');
    ok('per Core lintas pemilik; batas diturunkan tidak memotong stream yang berjalan, hanya menolak yang baru');
  }

  // 4. validasi: bad / min / max, null / default, nilai bawaan tidak disimpan, patch gagal tidak menerapkan sebagian
  {
    for (const v of [1.5, '3', true, false, NaN, Infinity, {}, [], 'unlimited']) assert.deepStrictEqual(C.setSettings({ pgStreamMax: v }), { ok: false, code: 'bad', key: 'pgStreamMax' }, JSON.stringify(v));
    assert.deepStrictEqual(C.setSettings({ pgStreamMax: 0 }), { ok: false, code: 'min', key: 'pgStreamMax', min: 1 });
    assert.deepStrictEqual(C.setSettings({ pgStreamPeer: -1 }), { ok: false, code: 'min', key: 'pgStreamPeer', min: 1 });
    assert.deepStrictEqual(C.setSettings({ pgStreamMax: 9 }), { ok: false, code: 'max', key: 'pgStreamMax', max: 8 });
    assert.deepStrictEqual(C.setSettings({ pgStreamPeer: 5 }), { ok: false, code: 'max', key: 'pgStreamPeer', max: 4 });
    C.setSettings({ pgStreamMax: 6, pgStreamPeer: 3 });
    assert.strictEqual(C.setSettings({ pgStreamMax: 7, pgStreamPeer: 99 }).code, 'max');
    assert.deepStrictEqual(C._pgStreamLimits(), { max: 6, peer: 3 }, 'patch gagal tidak menerapkan sebagian');
    C.setSettings({ pgStreamMax: 3 }); assert.strictEqual('pgStreamMax' in C._settings, false, 'nilai bawaan = kunci dibuang');
    C.setSettings({ pgStreamPeer: null }); assert.strictEqual('pgStreamPeer' in C._settings, false);
    C.setSettings({ pgStreamMax: 4, pgStreamPeer: 3 }); C.setSettings({ pgStreamMax: 'default', pgStreamPeer: 'default' });
    assert.deepStrictEqual(C._pgStreamLimits(), { max: 3, peer: 2 });
    assert.strictEqual(C.setSettings({ pagesServe: false, pgStreamMax: 4 }).pages.serve, false); C.setSettings({ pagesServe: null, pgStreamMax: null });
    ok('validasi: bad / min / max; null dan default = bawaan; nilai bawaan tidak disimpan; patch gagal tidak menerapkan sebagian; hidup berdampingan dengan pagesServe');
  }

  // 5. bertahan lewat restart; berkas diedit tangan: di luar batas / bukan bilangan bulat dibuang (bawaan)
  {
    C.setSettings({ pgStreamMax: 6, pgStreamPeer: 3 });
    const f = path.join(C.opts.dataDir, 'settings.json'), j = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(j.pgStreamMax, 6); assert.strictEqual(j.pgStreamPeer, 3);
    await C.stop();
    const C2 = new Core({ dataDir: C.opts.dataDir, name: 'C', discovery: false }); await C2.start();
    assert.deepStrictEqual(C2._pgStreamLimits(), { max: 6, peer: 3 }); await C2.stop();
    for (const bad of [0, 9, -2, 2.5, '4', null, true, 'x']) {
      fs.writeFileSync(f, JSON.stringify({ v: 1, pgStreamMax: bad, pgStreamPeer: bad }));
      const X = new Core({ dataDir: C.opts.dataDir, name: 'C', discovery: false }); X._loadSettings();
      assert.deepStrictEqual(X._pgStreamLimits(), { max: 3, peer: 2 }, 'sampah = bawaan: ' + JSON.stringify(bad));
    }
    ok('bertahan lewat restart; nilai tidak sah di settings.json dibuang (bawaan)');
  }

  await A.stop();
  console.log('\n' + pass + ' pemeriksaan lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
