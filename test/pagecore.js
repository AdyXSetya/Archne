'use strict';
// Tes Halaman 1c-1: PageStore tersambung ke Core (folder terpisah, relasi hidup dari Core). Tanpa jaringan.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagecore-'));
let pass = 0;
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const mk = (n) => { const c = new Core({ dataDir: path.join(tmp, n), name: n, discovery: false }); c._kick = () => {}; c._save = () => {}; return c; };
const X = 'a'.repeat(16), Y = 'b'.repeat(16), Z = 'c'.repeat(16);

// 1. malas, folder terpisah, satu instance
{
  const c = mk('A'); c.id = 'd'.repeat(16);
  assert(!fs.existsSync(path.join(tmp, 'A', 'pages')), 'belum ada folder sebelum dipakai');
  const ps = c.pageStore();
  assert.strictEqual(c.pageStore(), ps, 'satu instance per Core');
  assert(fs.existsSync(path.join(tmp, 'A', 'pages', 'p')));
  assert.strictEqual(ps.dir, path.join(tmp, 'A', 'pages'));
  assert.notStrictEqual(ps.dir, path.dirname(c.storeFile || path.join(tmp, 'A', 'store.json')) , 'folder bukan dataDir itu sendiri');
  ok('malas, satu instance, folder <dataDir>/pages terpisah dari store.json');
}

// 2. relasi hidup dari Core: publik -> teman -> blokir (tanpa cache)
{
  const c = mk('B'); c.id = 'd'.repeat(16);
  const ps = c.pageStore();
  const pub = ps.create({ text: 'umum' }), fr = ps.create({ text: 'teman saja', priv: 'friends' });
  assert.strictEqual(ps.countFor(X), 1); assert.deepStrictEqual(ps.listFor(X).items.map((p) => p.id), [pub.id]);
  assert.strictEqual(ps.getFor(X, fr.id), null);
  c.store.friends[X] = { st: 'in' }; c.store.friends[Y] = { st: 'out' };
  assert.strictEqual(ps.countFor(X), 1, "'in' belum teman"); assert.strictEqual(ps.countFor(Y), 1, "'out' belum teman");
  c.store.friends[X] = { st: 'ok' };
  assert.strictEqual(ps.countFor(X), 2); assert.strictEqual(ps.getFor(X, fr.id).text, 'teman saja');
  assert.strictEqual(ps.countFor(Y), 1, 'peer lain tidak ikut berubah');
  c.store.blocked[X] = 1;
  assert.strictEqual(ps.listFor(X), null, 'blokir mengalahkan teman, seketika'); assert.strictEqual(ps.getFor(X, pub.id), null); assert.strictEqual(ps.countFor(X), null);
  delete c.store.blocked[X]; delete c.store.friends[X];
  assert.strictEqual(ps.countFor(X), 1, 'putus teman berlaku seketika');
  assert.strictEqual(ps.countFor(c.id), 2, 'pemilik melihat semuanya');
  assert.strictEqual(ps.countFor('bukan-id'), null);
  ok("relasi hidup: 'in'/'out' bukan teman, 'ok' teman, blokir > teman, putus teman seketika, pemilik lihat semua");
}

// 3. bertahan lewat "restart" (Core baru, dataDir sama) dan tidak menyentuh store.json
{
  const c = mk('C'); c.id = 'd'.repeat(16);
  const p = c.pageStore().create({ text: 'tahan' });
  const sf = path.join(tmp, 'C', 'store.json');
  assert(!fs.existsSync(sf) || !fs.readFileSync(sf, 'utf8').includes('tahan'), 'isi halaman tidak masuk store.json');
  const c2 = mk('C'); c2.id = 'd'.repeat(16);
  assert.deepStrictEqual(c2.pageStore().get(p.id), p);
  assert(!('pages' in c2.store) && !('pages' in c.store), 'store tidak punya kunci pages');
  ok('bertahan lewat restart; store.json dan store tidak disentuh');
}

console.log('\n' + pass + ' kelompok lulus');
fs.rmSync(tmp, { recursive: true, force: true });
