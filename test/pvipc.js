'use strict';
// Tes kontrak API channel voice publik (v0.20.0, pvch5): nama di preload/api-http/ipc, event, bentuk argumen, rute HTTP, dan state().pv tanpa data PIN.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), http = require('http');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { startHeadless } = require('../src/archne-headless');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pvi-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, vcBeatMs: 300, vcTtlMs: 1500, syncMs: 400 });
function fake(core) {
  const handlers = {}, sent = [];
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, shell: {}, send: (ch, p) => sent.push([ch, p]), log: () => {}, pickFiles: async () => [] });
  return { sent, call: (n, ...a) => handlers[n]({}, ...a) };
}
const req = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString() })); });
  r.on('error', reject); if (body) r.write(body); r.end();
});

(async () => {
  console.log('Archne pvch ipc test, dir: ' + tmp);
  const NAMES = ['pvList', 'pvCreate', 'pvDelete', 'pvUpdate', 'pvEnter', 'pvLeave'];

  // ---- A. kontrak nama ----
  const root = path.join(__dirname, '..');
  const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  const preload = rd('preload.js'), apiHttp = rd('renderer', 'archne-api-http.js'), ipcSrc = rd('src', 'archne-ipc.js');
  for (const n of NAMES) {
    assert(new RegExp('^\\s{2}' + n + ':', 'm').test(preload), 'preload ' + n);
    assert(new RegExp("ipcRenderer\\.invoke\\('" + n + "'").test(preload), 'saluran ' + n);
    assert(new RegExp("\\bh\\('" + n + "'").test(ipcSrc), 'handler ' + n);
    assert(new RegExp("'" + n + "'").test(apiHttp), 'api-http ' + n);
  }
  for (const [fn, ev] of [['onPvPres', 'pvpres'], ['onPvKick', 'pvkick']]) {
    assert(new RegExp(fn + ':.*ipcRenderer\\.on\\(\'' + ev + "'").test(preload) && new RegExp('api\\.' + fn).test(apiHttp) && new RegExp("addEventListener\\('" + ev + "'").test(apiHttp) && new RegExp("toRenderer\\('" + ev + "'").test(ipcSrc), 'event ' + ev + ' di keempat sisi');
  }
  ok('nama, saluran, handler, dan event pvpres/pvkick ada di preload.js, archne-ipc.js, dan archne-api-http.js');

  // ---- B. alur lewat IPC dengan dua Core ----
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start(); await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'online');
  const ia = fake(A), ib = fake(B);
  const mkc = await ia.call('pvCreate', '  Rapat  ', '123456'); assert(mkc.ok && /^[0-9a-f]{16}$/.test(mkc.id));
  const fr = await ia.call('pvCreate', 'Bebas'); assert(fr.ok);
  await until(() => B.pvList({ empty: true }).length === 2, 8000, 'sync');
  const ls = await ib.call('pvList', true);
  assert.strictEqual(ls.ok, true); assert.deepStrictEqual(ls.channels.map((c) => c.name).sort(), ['Bebas', 'Rapat']);
  assert.deepStrictEqual((await ib.call('pvList')).channels, [], 'tanpa empty: kosong disembunyikan');
  assert.strictEqual((await ib.call('pvEnter', mkc.id, '000000')).ok, false);
  assert.strictEqual((await ib.call('pvEnter', mkc.id)).ok, false, 'tanpa PIN');
  assert.deepStrictEqual(await ib.call('pvEnter', mkc.id, '123456'), { ok: true });
  assert.strictEqual(B.getState().pv.me, mkc.id);
  await until(() => A.pvList().some((c) => c.id === mkc.id && c.count === 1), 6000, 'A melihat B masuk');
  assert(ia.sent.some(([ch, p]) => ch === 'pvpres' && p.on === 1 && p.cid === mkc.id), 'event pvpres sampai ke renderer A');
  assert.strictEqual((await ib.call('pvUpdate', mkc.id, { name: 'x' })).ok, false, 'bukan pemilik');
  assert.strictEqual((await ib.call('pvDelete', mkc.id)).ok, false, 'bukan pemilik');
  assert.deepStrictEqual(await ia.call('pvUpdate', mkc.id, { name: 'Rapat 2', pin: '654321' }), { ok: true });
  await until(() => !B._pvMe, 6000, 'B dikeluarkan karena PIN berubah');
  assert(ib.sent.some(([ch, p]) => ch === 'pvkick' && p.cid === mkc.id && p.reason === 'pin'), 'event pvkick sampai ke renderer B');
  assert.deepStrictEqual(await ib.call('pvLeave'), { ok: false });
  assert.deepStrictEqual(await ia.call('pvUpdate', mkc.id, { pin: null }), { ok: true });
  assert.deepStrictEqual(await ia.call('pvDelete', mkc.id), { ok: true });
  ok('alur IPC: buat, daftar, masuk (PIN), event pvpres/pvkick, ubah/hapus hanya pemilik');

  // ---- C. state().pv tidak membawa pemeriksa PIN ----
  assert(!/"(hash|salt|pin)"/.test(JSON.stringify(A.getState().pv)), 'state().pv tanpa hash/salt/pin');
  ok('state().pv membawa me + channels tanpa hash/salt');

  // ---- D. argumen rusak ditolak, tidak ada yang berubah ----
  const bad = async (n, ...a) => assert.strictEqual((await ia.call(n, ...a)).ok, false, n + ' ' + JSON.stringify(a));
  const before = A.pvList({ empty: true }).length;
  await bad('pvCreate', 'x', 123456); await bad('pvCreate', 'x', '12'); await bad('pvCreate', 'x', 'a'.repeat(33)); await bad('pvCreate', {}, '123456'.split('')) ;
  await bad('pvDelete'); await bad('pvDelete', 5); await bad('pvDelete', 'x'.repeat(65)); await bad('pvDelete', 'f'.repeat(16));
  await bad('pvUpdate', fr.id, null); await bad('pvUpdate', fr.id, [1]); await bad('pvUpdate', fr.id, { name: 5 }); await bad('pvUpdate', fr.id, { pin: 5 });
  await bad('pvEnter', 5); await bad('pvEnter', fr.id, { a: 1 });
  assert.strictEqual(A.pvList({ empty: true }).length, before, 'tidak ada channel tambahan');
  assert.strictEqual(Object.prototype.polluted, undefined);
  ok('argumen rusak ditolak di IPC tanpa mengubah apa pun');
  await A.stop(); await B.stop();

  // ---- E. rute HTTP ----
  const app = await startHeadless({ dataDir: path.join(tmp, 'H'), downloadDir: path.join(tmp, 'dl'), name: 'H', canOpenFolder: false });
  const { rpc } = app, port = rpc.port, J = { 'content-type': 'application/json' };
  assert.strictEqual((await req(port, 'POST', '/rpc/pvList', J, '[]')).status, 401, 'tanpa sesi ditolak');
  const login = await req(port, 'GET', '/?t=' + rpc.token);
  const H = { cookie: /lc=[0-9a-f]+/.exec(login.headers['set-cookie'][0])[0], 'content-type': 'application/json' };
  const post = async (n, a) => JSON.parse((await req(port, 'POST', '/rpc/' + n, H, JSON.stringify(a))).body);
  assert.deepStrictEqual(await post('pvList', []), { ok: true, channels: [] });
  const c = await post('pvCreate', ['Lewat HTTP', '123456']); assert(c.ok);
  assert.deepStrictEqual((await post('pvList', [])).channels.map((x) => [x.name, x.locked, x.mine]), [['Lewat HTTP', true, true]], 'milik sendiri tampil walau kosong');
  assert.strictEqual((await post('pvCreate', [{}, 'x'])).ok, false);
  assert.deepStrictEqual(await post('pvLeave', []), { ok: false });
  assert.deepStrictEqual((await post('state', [])).pv.me, null);
  assert.deepStrictEqual(await post('pvDelete', [c.id]), { ok: true });
  await app.stop();
  ok('rute HTTP /rpc/pv*: sesi wajib, hasil sama dengan IPC, state membawa pv');

  console.log('\n' + pass + ' skenario lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
