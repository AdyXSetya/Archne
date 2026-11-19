'use strict';
// Tes Halaman 5a-3: pengaturan Halaman (pagesServe, pgStreamMax, pgStreamPeer) lewat lapisan IPC (src/archne-ipc.js dengan Electron palsu) DAN lewat HTTP (src/archne-rpc.js, klien http sungguhan).
// Yang dicek: kunci baru diteruskan dan hasilnya memuat pages.streams; semua kode galat sampai ke renderer; patch gagal tidak menerapkan sebagian; kunci berbahaya ditolak tanpa mencemari prototype;
// Core memancarkan 'update'; Electron dan HTTP identik; penjaga directDir tidak berubah.
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { startHeadless } = require('../src/archne-headless');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagessetipc-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

function post(port, base, name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: base + 'rpc/' + name, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString() || 'null') }));
    });
    r.on('error', reject); r.write(body); r.end();
  });
}

(async () => {
  // ---- A. lapisan IPC (Electron palsu) ----
  const core = new Core({ dataDir: path.join(tmp, 'A'), name: 'A', discovery: false });
  const handlers = {}, sent = [];
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: (ch, p) => sent.push([ch, p]), log: () => {} });
  const call = (n, ...a) => handlers[n]({}, ...a);
  await core.start();

  {
    const g = await call('getSettings');
    assert.strictEqual(g.ok, true);
    assert.deepStrictEqual(g.pages, { serve: true, def: true, streams: { max: 3, peer: 2, def: { max: 3, peer: 2 }, min: { max: 1, peer: 1 }, ceil: { max: 8, peer: 4 } } });
    assert.strictEqual(typeof g.canDirect, 'boolean');
    ok('getSettings: pages.serve dan pages.streams (nilai, bawaan, minimum, maksimum) sampai ke renderer');
  }
  {
    let upd = 0; const onUpd = () => upd++; core.on('update', onUpd);
    const r = await call('setSettings', { pagesServe: false, pgStreamMax: 6, pgStreamPeer: 3 });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.pages.serve, false); assert.strictEqual(r.pages.streams.max, 6); assert.strictEqual(r.pages.streams.peer, 3);
    assert.strictEqual('canDirect' in r, true, 'hasil setSettings lewat settingsOut, sama seperti kunci lain');
    assert.deepStrictEqual(core._pgStreamLimits(), { max: 6, peer: 3 }); assert.strictEqual(core._pgServePs(), null);
    assert.strictEqual(upd, 1, "Core memancarkan 'update' (diteruskan ke renderer oleh main.js / headless, bukan archne-ipc.js)"); core.off('update', onUpd);
    const back = await call('setSettings', { pagesServe: null, pgStreamMax: null, pgStreamPeer: 'default' });
    assert.deepStrictEqual(back.pages, (await call('getSettings')).pages); assert.strictEqual(back.pages.serve, true); assert.strictEqual(back.pages.streams.max, 3);
    ok('setSettings: tiga kunci baru diterapkan dan dikembalikan; null / default = bawaan; update dipancarkan');
  }
  {
    const e = async (patch) => call('setSettings', patch);
    assert.deepStrictEqual(await e({ pgStreamMax: 0 }), { ok: false, code: 'min', key: 'pgStreamMax', min: 1 });
    assert.deepStrictEqual(await e({ pgStreamPeer: 5 }), { ok: false, code: 'max', key: 'pgStreamPeer', max: 4 });
    for (const [k, v] of [['pgStreamMax', 2.5], ['pgStreamMax', '3'], ['pgStreamPeer', true], ['pagesServe', 'off'], ['pagesServe', 0], ['pagesServe', 'unlimited']]) assert.deepStrictEqual(await e({ [k]: v }), { ok: false, code: 'bad', key: k }, k + '=' + JSON.stringify(v));
    for (const p of [null, undefined, [], 'x', 7]) assert.deepStrictEqual(await e(p), { ok: false, code: 'bad' }, JSON.stringify(p));
    assert.strictEqual((await e({ pagesServe: false, pgStreamMax: 99 })).code, 'max');
    assert.strictEqual((await call('getSettings')).pages.serve, true, 'patch gagal tidak menerapkan sebagian');
    ok('galat bad / min / max sampai apa adanya; bentuk patch cacat = bad; patch gagal tidak menerapkan sebagian');
  }
  {
    for (const k of ['__proto__', 'constructor', 'toString', 'pgStreamMaxx', 'pagesserve']) {
      const patch = JSON.parse('{"' + k + '":{"pagesServe":false}}');
      assert.strictEqual((await call('setSettings', patch)).code, 'bad', k);
    }
    assert.strictEqual(({}).pagesServe, undefined, 'prototype tidak tercemar');
    assert.strictEqual((await call('setSettings', { directDir: '/tmp/x' })).code, 'bad', 'penjaga directDir tetap');
    assert.strictEqual((await call('setSettings', { directDir: null })).ok, true);
    assert.strictEqual((await call('setSettings', {})).ok, true, 'patch kosong sah');
    ok('kunci berbahaya / salah ketik = bad tanpa mencemari prototype; penjaga directDir tidak berubah');
  }
  await core.stop();

  // ---- B. lapisan HTTP (archne-rpc.js): hasil identik dengan IPC ----
  const app = await startHeadless({ dataDir: path.join(tmp, 'H'), downloadDir: path.join(tmp, 'dl'), name: 'H', canOpenFolder: false });
  const { rpc } = app, base = '/s/' + rpc.token + '/';
  {
    const g = await post(rpc.port, base, 'getSettings', []); assert.strictEqual(g.status, 200); assert.strictEqual(g.json.pages.streams.ceil.peer, 4);
    const s = await post(rpc.port, base, 'setSettings', [{ pagesServe: false, pgStreamMax: 5, pgStreamPeer: 4 }]);
    assert.strictEqual(s.json.ok, true); assert.strictEqual(s.json.pages.serve, false); assert.strictEqual(s.json.pages.streams.max, 5);
    assert.deepStrictEqual(app.core._pgStreamLimits(), { max: 5, peer: 4 });
    assert.deepStrictEqual((await post(rpc.port, base, 'setSettings', [{ pgStreamMax: 9 }])).json, { ok: false, code: 'max', key: 'pgStreamMax', max: 8 });
    assert.deepStrictEqual((await post(rpc.port, base, 'setSettings', [{ pgStreamPeer: 1.5 }])).json, { ok: false, code: 'bad', key: 'pgStreamPeer' });
    assert.deepStrictEqual(app.core._pgStreamLimits(), { max: 5, peer: 4 }, 'galat tidak mengubah apa pun');
    const nul = await post(rpc.port, base, 'setSettings', [{ pgStreamMax: null, pagesServe: null }]); // NaN / Infinity di JSON juga menjadi null: UI harus memvalidasi sebelum kirim
    assert.strictEqual(nul.json.pages.serve, true); assert.strictEqual(nul.json.pages.streams.max, 3);
    ok('HTTP: kunci baru diteruskan, galat identik dengan IPC, null kembali ke bawaan');
  }
  await app.stop().catch(() => {});
  console.log('\n' + pass + ' pemeriksaan lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
