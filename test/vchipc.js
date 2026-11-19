'use strict';
// Tes jembatan channel voice (v0.19.0, langkah 5): src/archne-ipc.js dengan Electron palsu + Core sungguhan, kontrak preload/api-http, dan rute HTTP.
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { startHeadless } = require('../src/archne-headless');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-vchi-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, vcBeatMs: 300, vcTtlMs: 1500 });
function fake(core) {
  const handlers = {}, sent = [];
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, shell: {}, send: (ch, p) => sent.push([ch, p]), log: () => {}, pickFiles: async () => [] });
  return { sent, call: (n, ...a) => handlers[n]({}, ...a), handlers };
}
const req = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString() })); });
  r.on('error', reject); if (body) r.write(body); r.end();
});

(async () => {
  console.log('Archne vchan ipc test, dir: ' + tmp);
  const NAMES = ['vcList', 'vcCreate', 'vcDelete', 'vcUpdate', 'vcEnter', 'vcLeave'];

  // ---- A. kontrak nama: preload, api-http, event ----
  const root = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), apiHttp = fs.readFileSync(path.join(root, 'renderer', 'archne-api-http.js'), 'utf8'), ipcSrc = fs.readFileSync(path.join(root, 'src', 'archne-ipc.js'), 'utf8');
  for (const n of NAMES) {
    assert(new RegExp('^\\s{2}' + n + ':', 'm').test(preload), 'preload ' + n);
    assert(new RegExp("ipcRenderer\\.invoke\\('" + n + "'").test(preload), 'saluran ' + n);
    assert(new RegExp("\\bh\\('" + n + "'").test(ipcSrc), 'handler ' + n);
    assert(new RegExp("'" + n + "'").test(apiHttp), 'api-http ' + n);
  }
  assert(/onVcPres:.*ipcRenderer\.on\('vcpres'/.test(preload) && /api\.onVcPres/.test(apiHttp) && /addEventListener\('vcpres'/.test(apiHttp) && /toRenderer\('vcpres'/.test(ipcSrc), 'event vcpres di keempat sisi');
  ok('nama, saluran, handler, dan event vcpres ada di preload.js, archne-ipc.js, dan archne-api-http.js');

  // ---- B. alur lewat IPC dengan dua Core ----
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start(); await A.addPeer('127.0.0.1', B.port); await B.addPeer('127.0.0.1', A.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'online');
  const ia = fake(A), ib = fake(B);
  const g = await ia.call('createGroup', 'Tim', [B.id]); assert(g.ok);
  await until(() => B.getState().groups.some((x) => x.id === g.id), 8000, 'undangan');
  const mkc = await ia.call('vcCreate', g.id, '  Rapat  ', true, [B.id]);
  assert(mkc.ok && /^[0-9a-f]{16}$/.test(mkc.id));
  const bc = await ib.call('vcCreate', g.id, 'Santai', false);
  assert(bc.ok);
  await until(() => [A, B].every((n) => n.vcList(g.id).length === 2), 8000, 'sync');
  const ls = await ib.call('vcList', g.id);
  assert(ls.ok && ls.channels.length === 2 && ls.channels.find((c) => c.id === mkc.id).name === 'Rapat' && ls.channels.find((c) => c.id === mkc.id).locked);
  const st = await ia.call('state');
  const sg = st.groups.find((x) => x.id === g.id);
  assert.deepStrictEqual(sg.channels.map((c) => c.id).sort(), [mkc.id, bc.id].sort(), 'state().groups[].channels');
  assert.strictEqual(st.vc, null);
  const evs = ib.sent.length;
  assert.deepStrictEqual(await ia.call('vcEnter', g.id, mkc.id), { ok: true });
  assert.deepStrictEqual((await ia.call('state')).vc, { gid: g.id, cid: mkc.id });
  await until(() => ib.sent.some(([ch, p]) => ch === 'vcpres' && p.cid === mkc.id && p.on === 1 && !p.me), 6000, 'vcpres ke B');
  assert(ia.sent.some(([ch, p]) => ch === 'vcpres' && p.me && p.on === 1), 'event vcpres milik sendiri');
  assert((await ib.call('state')).groups.find((x) => x.id === g.id).channels.find((c) => c.id === mkc.id).here.some((h) => h.id === A.id), 'daftar here di state B');
  assert.deepStrictEqual(await ia.call('vcLeave'), { ok: true });
  assert.deepStrictEqual(await ia.call('vcLeave'), { ok: false });
  assert.deepStrictEqual(await ia.call('vcUpdate', g.id, mkc.id, { name: 'Rapat 2', locked: false, allow: [] }), { ok: true });
  await until(() => B.vcList(g.id).find((c) => c.id === mkc.id).name === 'Rapat 2', 6000, 'update sampai');
  assert.deepStrictEqual(await ia.call('vcDelete', g.id, mkc.id), { ok: true });
  await until(() => B.vcList(g.id).length === 1, 6000, 'hapus sampai');
  ok('buat/daftar/masuk/keluar/ubah/hapus lewat IPC; state membawa channels dan vc; event vcpres sampai ke renderer');

  // ---- C. galat Core diteruskan sebagai { ok:false }, bentuk argumen rusak ditolak sebelum Core ----
  const bad = async (n, ...a) => { const r = await ia.call(n, ...a); assert.strictEqual(r.ok, false, n + JSON.stringify(a)); return r.err; };
  const ac = await ia.call('vcCreate', g.id, 'Milik A', false); await until(() => B.vcList(g.id).length === 2, 6000, 'sync Milik A');
  const r2 = await ib.call('vcUpdate', g.id, ac.id, { name: 'dibajak' }); assert.strictEqual(r2.ok, false, 'member bukan pembuat ditolak oleh Core'); assert(/pembuat|admin/i.test(r2.err), r2.err);
  assert.strictEqual((await ib.call('vcDelete', g.id, ac.id)).ok, false);
  await ia.call('vcDelete', g.id, ac.id); await until(() => B.vcList(g.id).length === 1, 6000, 'hapus Milik A');
  await bad('vcCreate', 123, 'x'); await bad('vcCreate', g.id, 'x', false, 'bukan-larik'); await bad('vcCreate', g.id, 'x', false, [1, 2]);
  await bad('vcCreate', g.id, '   '); await bad('vcCreate', 'e'.repeat(16), 'x'); await bad('vcCreate', '__proto__', 'x');
  await bad('vcDelete', g.id, { toString: () => bc.id }); await bad('vcDelete', g.id); await bad('vcDelete', g.id, 'f'.repeat(16));
  await bad('vcUpdate', g.id, bc.id, null); await bad('vcUpdate', g.id, bc.id, [1]); await bad('vcUpdate', g.id, bc.id, { name: 5 });
  await bad('vcEnter', g.id, 5); await bad('vcEnter', 'x'.repeat(65), bc.id); await bad('vcList', {}); await bad('vcList', undefined);
  assert.deepStrictEqual(B.vcList(g.id).map((c) => c.name), ['Santai'], 'tidak ada yang berubah');
  assert.strictEqual(Object.prototype.polluted, undefined);
  ok('argumen rusak ditolak di IPC; galat izin Core diteruskan; tidak ada perubahan tersisa');
  await A.stop(); await B.stop();

  // ---- D. rute HTTP: nama terdaftar, token wajib, galat jinak ----
  const app = await startHeadless({ dataDir: path.join(tmp, 'H'), downloadDir: path.join(tmp, 'dl'), name: 'H', canOpenFolder: false });
  const { rpc } = app, port = rpc.port, J = { 'content-type': 'application/json' };
  assert.strictEqual((await req(port, 'POST', '/rpc/vcList', J, '["x"]')).status, 401, 'tanpa sesi ditolak');
  const login = await req(port, 'GET', '/?t=' + rpc.token);
  const H = { cookie: /lc=[0-9a-f]+/.exec(login.headers['set-cookie'][0])[0], 'content-type': 'application/json' };
  const r = await req(port, 'POST', '/rpc/vcList', H, JSON.stringify(['e'.repeat(16)]));
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(JSON.parse(r.body), { ok: true, channels: [] });
  const r3 = JSON.parse((await req(port, 'POST', '/rpc/vcCreate', H, JSON.stringify([{}, 'x']))).body);
  assert.strictEqual(r3.ok, false);
  assert.deepStrictEqual(JSON.parse((await req(port, 'POST', '/rpc/vcLeave', H, '[]')).body), { ok: false });
  assert.strictEqual(JSON.parse((await req(port, 'POST', '/rpc/state', H, '[]')).body).vc, null);
  await app.stop();
  ok('rute HTTP /rpc/vc*: sesi wajib, hasil sama dengan IPC, galat jinak, state membawa vc');

  console.log('\n' + pass + ' skenario lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
