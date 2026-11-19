'use strict';
// Tes kontrak API sematan pesan (v0.20.0, pin4): nama di preload/api-http/ipc, bentuk argumen, state().pins, rute HTTP.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert'), http = require('http');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { startHeadless } = require('../src/archne-headless');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pini-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
function fake(core) {
  const handlers = {};
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, shell: {}, send: () => {}, log: () => {}, pickFiles: async () => [] });
  return { call: (n, ...a) => handlers[n]({}, ...a) };
}
const req = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString() })); });
  r.on('error', reject); if (body) r.write(body); r.end();
});

(async () => {
  console.log('Archne pins ipc test, dir: ' + tmp);
  const NAMES = ['pinList', 'pinAdd', 'pinNote', 'pinEdit', 'pinRemove'];

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
  ok('nama, saluran, dan handler sematan ada di preload.js, archne-ipc.js, dan archne-api-http.js');

  // ---- B. alur lewat IPC: grup (admin vs member), pribadi, Publik ----
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start(); await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'online');
  const ia = fake(A), ib = fake(B);
  const gid = A.createGroup('Tim', [B.id]).id, G = 'g:' + gid;
  await until(() => B.getState().groups.some((g) => g.id === gid), 8000, 'undangan');
  const m1 = A.sendText('rapat jam 9', G);
  await until(() => B.getState().messages.some((m) => m.id === m1.id), 8000, 'pesan tiba');
  assert.deepStrictEqual(A.getState().pins, {}, 'tanpa sematan: pins kosong');
  assert.deepStrictEqual(await ia.call('pinList', G), { ok: true, shared: [], mine: [], canShare: true });
  assert.deepStrictEqual(await ib.call('pinList', G), { ok: true, shared: [], mine: [], canShare: false });
  const r1 = await ia.call('pinAdd', G, m1.id, true); assert(r1.ok && /^[0-9a-f]{16}/.test(r1.id));
  const r2 = await ia.call('pinNote', G, 'Aturan: jangan spam', true); assert(r2.ok);
  await until(() => B.getState().pins[G] && B.getState().pins[G].shared.length === 2, 8000, 'tersebar');
  assert.deepStrictEqual((await ib.call('pinAdd', G, m1.id, true)).ok, false, 'member tidak boleh bersama');
  assert.strictEqual((await ib.call('pinAdd', G, m1.id)).ok, true, 'shared tidak true: pribadi');
  assert.strictEqual((await ib.call('pinNote', G, 'catatan B', 'true')).ok, true, 'hanya true persis yang bersama; string "true" = pribadi');
  const sb = B.getState().pins[G];
  assert.strictEqual(sb.shared.length, 2); assert.strictEqual(sb.mine.length, 2); assert.strictEqual(sb.canShare, false);
  assert(sb.shared.every((p) => p.canRemove === false));
  assert.strictEqual(A.getState().pins[G].mine.length, 0, 'pribadi B tidak bocor ke A');
  assert.deepStrictEqual(await ia.call('pinEdit', G, r2.id, 'Aturan baru'), { ok: true });
  await until(() => B.getState().pins[G].shared.some((p) => p.text === 'Aturan baru'), 8000, 'edit tersebar');
  assert.strictEqual((await ib.call('pinRemove', G, r2.id)).ok, false, 'member tidak boleh melepas bersama');
  assert.deepStrictEqual(await ia.call('pinRemove', G, r2.id), { ok: true });
  await until(() => B.getState().pins[G].shared.length === 1, 8000, 'lepas tersebar');
  const pubn = await ia.call('pinNote', 'public', 'catatan publik', false); assert(pubn.ok);
  assert.strictEqual((await ia.call('pinNote', 'public', 'x', true)).ok, false, 'Publik tidak punya sematan bersama');
  assert.strictEqual(A.getState().pins.public.mine.length, 1);
  assert.strictEqual(A.getState().limits.pin.max, 100); assert.strictEqual(A.getState().limits.pin.text, 10000);
  ok('alur IPC: bersama (admin) vs pribadi (member), edit/lepas, Publik hanya pribadi, state().pins dan limits.pin');

  // ---- C. state().pins tanpa data internal ----
  const dump = JSON.stringify(B.getState().pins);
  assert(!/"(r|m|del|v)":/.test(dump) && !dump.includes('\u0001'), 'state().pins tanpa peta mentah, tombstone, atau pembawa');
  ok('state().pins hanya membawa tampilan (tanpa tombstone/pembawa)');

  // ---- D. argumen rusak ditolak, tidak ada yang berubah ----
  const bad = async (n, ...a) => assert.strictEqual((await ia.call(n, ...a)).ok, false, n + ' ' + JSON.stringify(a));
  const snap = JSON.stringify(A.getState().pins);
  await bad('pinList'); await bad('pinList', 5); await bad('pinList', '__proto__'); await bad('pinList', 'g:xyz'); await bad('pinList', 'x'.repeat(41));
  await bad('pinAdd', G); await bad('pinAdd', G, 5); await bad('pinAdd', G, 'z'.repeat(65)); await bad('pinAdd', {}, m1.id); await bad('pinAdd', G, 'f'.repeat(32));
  await bad('pinNote', G, 5); await bad('pinNote', G, ''); await bad('pinNote', G, 'a'.repeat(10001)); await bad('pinNote', G, ['x']); await bad('pinNote', 'g:' + 'f'.repeat(16), 'x');
  await bad('pinEdit', G); await bad('pinEdit', G, r1.id, 'ubah'); await bad('pinEdit', G, 5, 'x');
  await bad('pinRemove', G); await bad('pinRemove', G, 'f'.repeat(16)); await bad('pinRemove', 'public', 5);
  assert.strictEqual(JSON.stringify(A.getState().pins), snap, 'tidak ada yang berubah');
  assert.strictEqual(Object.prototype.polluted, undefined);
  ok('argumen rusak ditolak di IPC tanpa mengubah apa pun');
  await A.stop(); await B.stop();

  // ---- E. rute HTTP ----
  const app = await startHeadless({ dataDir: path.join(tmp, 'H'), downloadDir: path.join(tmp, 'dl'), name: 'H', canOpenFolder: false });
  const { rpc } = app, port = rpc.port, J = { 'content-type': 'application/json' };
  assert.strictEqual((await req(port, 'POST', '/rpc/pinList', J, '["public"]')).status, 401, 'tanpa sesi ditolak');
  const login = await req(port, 'GET', '/?t=' + rpc.token);
  const H = { cookie: /lc=[0-9a-f]+/.exec(login.headers['set-cookie'][0])[0], 'content-type': 'application/json' };
  const post = async (n, a) => JSON.parse((await req(port, 'POST', '/rpc/' + n, H, JSON.stringify(a))).body);
  assert.deepStrictEqual(await post('pinList', ['public']), { ok: true, shared: [], mine: [], canShare: false });
  const n1 = await post('pinNote', ['public', 'Lewat HTTP', false]); assert(n1.ok);
  assert.deepStrictEqual((await post('pinList', ['public'])).mine.map((p) => p.text), ['Lewat HTTP']);
  assert.deepStrictEqual((await post('state', [])).pins.public.mine.map((p) => p.text), ['Lewat HTTP']);
  assert.strictEqual((await post('pinNote', [{}, 'x', false])).ok, false);
  assert.deepStrictEqual(await post('pinRemove', ['public', n1.id]), { ok: true });
  assert.deepStrictEqual((await post('state', [])).pins, {});
  await app.stop();
  ok('rute HTTP /rpc/pin*: sesi wajib, hasil sama dengan IPC, state membawa pins');

  console.log('\n' + pass + ' skenario lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
