'use strict';
// Tes jalur panggilan lewat archne-ipc.js (Electron palsu) dan lewat adaptor HTTP/SSE (Android/peramban) dengan Core sungguhan.
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { startHeadless } = require('../src/archne-headless');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-callipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

function fake(core) {
  const handlers = {}, sent = [];
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: (ch, p) => sent.push([ch, p]), log: () => {}, shell: {} });
  return { sent, call: (n, ...a) => handlers[n]({}, ...a), evs: (name, cid) => sent.filter(([c, p]) => c === 'call' && p.ev === name && (!cid || p.cid === cid)).map(([, p]) => p) };
}

(async () => {
  // ================= 1. archne-ipc.js =================
  const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, callRingMs: 3000, callConnMs: 3000 });
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.peers.get(B.id) && B.peers.get(A.id) && A.isOnline(A.peers.get(B.id)) && A.peers.get(B.id).xpub && B.peers.get(A.id).xpub, 6000, 'A-B');
  const ea = fake(A), eb = fake(B);

  // validasi: tidak melempar, mengembalikan { ok:false }
  for (const [n, args] of [['callStart', ['xyz', 'sdp']], ['callStart', [B.id, '']], ['callStart', [B.id, 42]], ['callStart', [A.id, 'sdp']],
    ['callAnswer', ['nope', 'sdp']], ['callAnswer', [{}, 'sdp']], ['callIce', [null, 'x']], ['callConnected', [1]], ['callReject', ['0'.repeat(16)]], ['callEnd', [[]]]]) {
    const r = await ea.call(n, ...args);
    assert.strictEqual(r.ok, false, n + ' ' + JSON.stringify(args) + ' -> ' + JSON.stringify(r));
    assert.strictEqual(typeof r.err, 'string');
  }
  assert.strictEqual((await ea.call('state')).call, null);
  ok('masukan tidak valid ditolak dengan { ok:false, err }, tanpa lemparan');

  const s = await ea.call('callStart', B.id, 'OFFER-1');
  assert(s.ok && /^[0-9a-f]{16}$/.test(s.cid));
  const cid = s.cid;
  await until(() => eb.evs('incoming', cid).length === 1, 5000, 'event incoming di renderer B');
  assert.strictEqual(eb.evs('incoming', cid)[0].sdp, 'OFFER-1');
  assert.strictEqual((await ea.call('callIce', cid, 'ice-a1')).ok, true);
  await until(() => eb.evs('ice', cid).length === 1, 5000, 'ICE');
  // UI yang terlambat terpasang: snapshot di state().call memuat tawaran dan ICE yang sudah lewat
  const snap = (await eb.call('state')).call;
  assert(snap && snap.cid === cid && snap.dir === 'in' && snap.state === 'ringing' && snap.sdp === 'OFFER-1' && snap.name === 'A');
  assert.deepStrictEqual(snap.ice, ['ice-a1']);
  const stA = (await ea.call("state")).call;
  assert(stA.state === "dialing" && stA.dir === "out" && stA.sdp === undefined, 'penelepon tidak memuat sdp di snapshot');
  assert.strictEqual((await eb.call('callAnswer', cid, 'ANSWER-1')).ok, true);
  await until(() => ea.evs('answer', cid).length === 1, 5000, 'answer');
  assert.strictEqual(ea.evs('answer', cid)[0].sdp, 'ANSWER-1');
  assert.strictEqual((await eb.call('state')).call.sdp, undefined, 'setelah dijawab tidak ada sdp di snapshot');
  assert.strictEqual((await ea.call('callConnected', cid)).ok, true);
  assert.strictEqual((await eb.call('callConnected', cid)).ok, true);
  assert.strictEqual((await ea.call('state')).call.state, 'active');
  assert.strictEqual((await eb.call('callEnd', cid)).ok, true);
  await until(() => ea.evs('end', cid).length === 1 && eb.evs('end', cid).length === 1, 5000, 'end di kedua renderer');
  assert.strictEqual(ea.evs('end', cid)[0].reason, 'ended');
  assert.strictEqual((await ea.call('state')).call, null);
  ok('ipc: mulai -> incoming -> ICE -> snapshot terlambat -> jawab -> tersambung -> akhir, event sampai ke renderer kedua sisi');

  const s2 = await ea.call('callStart', B.id, 'OFFER-2');
  await until(() => eb.evs('incoming', s2.cid).length === 1, 5000, 'tawaran 2');
  assert.strictEqual((await eb.call('callReject', s2.cid)).ok, true);
  await until(() => ea.evs('end', s2.cid).length === 1, 5000, 'ditolak');
  assert.strictEqual(ea.evs('end', s2.cid)[0].reason, 'rejected');
  ok('ipc: tolak');
  await A.stop(); await B.stop();

  // ================= 2. HTTP + SSE (jalur Android) =================
  const hA = await startHeadless({ dataDir: path.join(tmp, 'hA'), name: 'HA' }), hB = await startHeadless({ dataDir: path.join(tmp, 'hB'), name: 'HB' });
  for (const h of [hA, hB]) { h.core.opts.callRingMs = 3000; h.core.opts.callConnMs = 3000; }
  await hA.core.addPeer('127.0.0.1', hB.core.port);
  await until(() => hA.core.peers.get(hB.core.id) && hA.core.isOnline(hA.core.peers.get(hB.core.id)) && hA.core.peers.get(hB.core.id).xpub && hB.core.peers.get(hA.core.id) && hB.core.peers.get(hA.core.id).xpub, 6000, 'headless online');
  const sse = (h) => { const buf = { t: '' }; const r = http.request({ host: '127.0.0.1', port: h.rpc.port, path: '/s/' + h.rpc.token + '/events' }, (res) => res.on('data', (c) => { buf.t += c.toString(); })); r.end(); buf.close = () => r.destroy(); return buf; };
  const callEvents = (buf) => [...buf.t.matchAll(/event: call\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  const sa = sse(hA), sb = sse(hB);
  const rpc = (h, n, ...a) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: h.rpc.port, method: 'POST', path: '/s/' + h.rpc.token + '/rpc/' + n, headers: { 'content-type': 'application/json' } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))); });
    r.on('error', reject); r.end(JSON.stringify(a));
  });
  await sleep(300);
  const r1 = await rpc(hA, 'callStart', hB.core.id, 'HTTP-OFFER');
  assert(r1.ok && r1.cid, JSON.stringify(r1));
  await until(() => callEvents(sb).some((e) => e.ev === 'incoming' && e.cid === r1.cid), 5000, 'SSE call incoming');
  assert.strictEqual(callEvents(sb).find((e) => e.ev === 'incoming').sdp, 'HTTP-OFFER');
  assert.strictEqual((await rpc(hB, 'state')).call.cid, r1.cid);
  assert.strictEqual((await rpc(hB, 'callAnswer', r1.cid, 'HTTP-ANSWER')).ok, true);
  await until(() => callEvents(sa).some((e) => e.ev === 'answer' && e.sdp === 'HTTP-ANSWER'), 5000, 'SSE call answer');
  assert.strictEqual((await rpc(hA, 'callEnd', r1.cid)).ok, true);
  await until(() => callEvents(sb).some((e) => e.ev === 'end' && e.cid === r1.cid), 5000, 'SSE call end');
  assert.strictEqual((await rpc(hB, 'callEnd', 'bukan-id')).ok, false);
  ok('HTTP/SSE: callStart/answer/end lewat /rpc, event call sampai lewat /events di kedua sisi');
  sa.close(); sb.close();
  await hA.stop(); await hB.stop();

  console.log(`\n${pass} tes panggilan IPC/RPC OK`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
