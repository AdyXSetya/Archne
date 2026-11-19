'use strict';
// Jalur notifikasi Android: pesan DM masuk -> core.notifyOf -> SSE 'notify' di /s/<token>/events (yang dibaca layanan Java).
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { startHeadless } = require('../src/archne-headless');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-sse-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const app = await startHeadless({ dataDir: path.join(tmp, 'A'), downloadDir: path.join(tmp, 'dl'), name: 'A', host: '127.0.0.1', canOpenFolder: false, canNotify: true, discovery: false });
  const B = new Core({ dataDir: path.join(tmp, 'B'), name: 'B', discovery: false }); await B.start();
  await B.addPeer('127.0.0.1', app.core.port); await app.core.addPeer('127.0.0.1', B.port);
  for (let i = 0; i < 100 && !(B.getState().peers.some((p) => p.online) && app.core.getState().peers.some((p) => p.online)); i++) await sleep(100);
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port: app.rpc.port, path: `/s/${app.rpc.token}/events` }, (res) => { res.setEncoding('utf8'); res.on('data', (d) => { buf += d; }); });
  await sleep(300);
  B.sendText('halo dari B', 'public');   // publik: bisu bawaan
  B.sendText('pesan penting', app.core.id);
  for (let i = 0; i < 60 && !buf.includes('event: notify'); i++) await sleep(100);
  const m = /event: notify\ndata: (.*)\n\n/.exec(buf);
  assert(m, 'ada event notify: ' + JSON.stringify(buf));
  const n = JSON.parse(m[1]);
  assert(Number.isFinite(n.ts) && Math.abs(Date.now() - n.ts) < 60000, 'ts: waktu pesan (ms)');
  assert.deepStrictEqual(n, { key: B.id, title: 'B', text: 'pesan penting', from: B.id, who: 'B', chat: '', ts: n.ts, av: '' }, 'isi dasar + pengirim, foto (kosong: belum punya), tanpa nama grup untuk DM');
  assert(!buf.includes('halo dari B'), 'publik tidak diberi notifikasi');
  const st = await new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: app.rpc.port, path: `/s/${app.rpc.token}/rpc/state`, method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(JSON.parse(d))); }); q.on('error', rej); q.end('[]'); });
  assert.strictEqual(st.canNotify, true); assert.strictEqual(st.canOpenFolder, false);
  console.log('  OK  DM memicu SSE notify, publik tidak; state membawa canNotify');
  req.destroy(); await app.stop(); await B.stop(); process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
