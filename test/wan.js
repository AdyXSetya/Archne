'use strict';
// Tes klien mode lintas jaringan (langkah 2): renderer/archne-wan.js memakai Core asli (wanSeal/wanOpen lewat archne-ipc.js) dan broker MQTT palsu di memori.
// Yang diuji: presence online/offline, retained, Last Will, urutan sesi (sid), putar ulang, TTL, signaling terarah, kode salah, aturan penawar.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { createWan, validBroker } = require('../renderer/archne-wan');
const { FakeBroker } = require('./lib/fakemqtt');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-wan-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
// `window.api` palsu di atas archne-ipc.js asli (jadi kontrak argumen ikut teruji)
function apiOf(core) {
  const h = {};
  register({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core, shell: {}, send: () => {}, log: () => {}, pickFiles: async () => [] });
  return new Proxy({}, { get: (_t, n) => (...a) => Promise.resolve(h[n]({}, ...a)) });
}
const BROKER = 'wss://broker.test/mqtt';

(async () => {
  const A = mk('A'), B = mk('B'), C = mk('C'), X = mk('X');
  for (const c of [A, B, C, X]) await c.start();
  const code = A.wanNewCode();
  for (const c of [A, B, C]) c.wanSetCode(code);
  X.wanSetCode(A.wanNewCode()); // jaringan lain

  // ---------- 1. validasi ----------
  assert(validBroker('wss://broker.emqx.io:8084/mqtt') && validBroker('ws://localhost:8083/mqtt') && validBroker('ws://127.0.0.1:1883'));
  for (const bad of ['ws://broker.emqx.io:8083/mqtt', 'http://x', 'wss://', 'wss://a b', '', null, 'javascript:alert(1)', 'wss://x/' + 'a'.repeat(400)]) assert(!validBroker(bad), String(bad));
  const br = new FakeBroker();
  const mkw = (core, extra) => createWan(Object.assign({ api: apiOf(core), mqtt: br.mqtt }, extra));
  const wa = mkw(A);
  await assert.rejects(() => wa.start({ broker: 'ws://evil.example/mqtt', name: 'A' }), /broker/);
  const wNoCode = mkw(mk('N')); // tanpa kode
  await assert.rejects(async () => { const n = mk('N2'); await n.start(); await mkw(n).start({ broker: BROKER, name: 'n' }); }, /not set up/); // E3: pesan dari ipc wanTopics (e.wan.notSet), bawaan English
  ok('alamat broker: hanya wss:// (ws:// hanya localhost); tanpa kode jaringan start() ditolak');

  // ---------- 2. presence + retained ----------
  const st = {}; const sA = []; wa.on('status', (s) => sA.push(s.state));
  const wb = mkw(B), wc = mkw(C);
  const peersOf = (w) => w.peers().map((p) => p.id);
  await wa.start({ broker: BROKER, name: 'Alice' });
  await until(() => sA.includes('online'), 3000, 'A online');
  assert(br.retained.has(A.wanTopics().mine), 'presence A tersimpan retained');
  await wb.start({ broker: BROKER, name: 'Bob' });
  await until(() => peersOf(wb).includes(A.id) && peersOf(wa).includes(B.id), 3000, 'A dan B saling melihat');
  assert.strictEqual(wb.peers().find((p) => p.id === A.id).name, 'Alice');
  assert(!peersOf(wa).includes(A.id), 'tidak melihat diri sendiri');
  await wc.start({ broker: BROKER, name: 'Carol' }); // datang belakangan: A dan B diterima dari retained
  await until(() => peersOf(wc).length === 2, 3000, 'C melihat A dan B dari retained');
  ok('presence: saling melihat, nama terbawa, C yang datang belakangan melihat A dan B lewat retained, diri sendiri tidak muncul');

  // ---------- 3. payload di broker opak ----------
  for (const m of br.log) assert(!/online|Alice|Bob|offline/.test(m.payload) && !m.topic.includes(code.replace(/-/g, '')), 'broker hanya melihat byte acak');
  ok('yang terlihat di broker: topik berbasis hash dan payload opak (tanpa nama, status, atau kode)');

  // ---------- 4. Last Will & berhenti rapi ----------
  const changes = []; wb.on('peers', (l) => changes.push(l.map((p) => p.id)));
  wa._test_client = null;
  const clientA = [...br.clients].find((c) => c.o.clientId.startsWith('archne-' + A.id));
  assert(clientA && clientA.o.will && clientA.o.will.retain && clientA.o.will.qos === 1, 'Last Will terpasang (retained, QoS 1)');
  clientA.drop(); // jaringan A mati mendadak
  await until(() => !peersOf(wb).includes(A.id) && !peersOf(wc).includes(A.id), 3000, 'LWT membuat A offline');
  assert(peersOf(wb).includes(C.id), 'C tetap online di mata B');
  ok('Last Will: putus mendadak -> broker menyiarkan offline -> B dan C melihat A offline, C tidak ikut');
  await wc.stop();
  await until(() => !peersOf(wb).includes(C.id), 3000, 'C offline setelah stop');
  assert(!br.clients.has([...br.clients].find((c) => c.o.clientId.startsWith('archne-' + C.id))), 'C putus');
  ok('berhenti rapi: offline retained disiarkan sebelum putus');

  // ---------- 5. restart: sid baru, offline lama tidak mematikan sesi baru ----------
  const lastWillA = clientA.o.will; // offline untuk sid lama
  const wa2 = mkw(A); const sA2 = []; wa2.on('status', (s) => sA2.push(s.state));
  await wa2.start({ broker: BROKER, name: 'Alice2' });
  await until(() => peersOf(wb).includes(A.id) && wb.peers().find((p) => p.id === A.id).name === 'Alice2', 3000, 'A kembali dengan sesi baru');
  const nW = changes.length;
  br._deliver(lastWillA.topic, lastWillA.payload, true, null); // Last Will lama terlambat tiba
  await sleep(400); // lebih lama dari penundaan heal: lonjakan "A offline" sesaat pun tidak boleh pernah terlihat B
  assert(peersOf(wb).includes(A.id), 'offline milik sesi lama diabaikan (sid beda)');
  assert(changes.slice(nW).every((l) => l.includes(A.id)), 'B tidak pernah melihat A offline karena Last Will sesi lama');
  // retained milik A kini tertimpa Last Will lama di broker; klien A harus memperbaikinya sendiri (heal) supaya pendatang baru tetap melihatnya
  await until(() => { const r = br.retained.get(A.wanTopics().mine); return r && r !== lastWillA.payload; }, 3000, 'A memperbaiki retained-nya');
  ok('sesi baru tidak dimatikan oleh Last Will/offline lama (dijaga sid), dan retained yang tertimpa diperbaiki klien sendiri');

  // ---------- 6. putar ulang presence ----------
  const onlineA = [...br.log].reverse().find((m) => m.topic === A.wanTopics().mine && m.retain); // online terbaru A (sid baru)
  const n0 = changes.length;
  br._deliver(onlineA.topic, onlineA.payload, false, null); // sama persis (ts sama)
  await sleep(150);
  assert.strictEqual(changes.length, n0, 'putar ulang online dengan ts sama tidak mengubah apa pun');
  ok('putar ulang presence persis sama diabaikan');

  // ---------- 7. signaling terarah ----------
  const gotB = [], gotA = [], gotC = [];
  wb.on('signal', (s) => gotB.push(s)); wa2.on('signal', (s) => gotA.push(s));
  const wc2 = mkw(C); wc2.on('signal', (s) => gotC.push(s)); await wc2.start({ broker: BROKER, name: 'Carol' });
  await until(() => peersOf(wc2).length === 2, 3000, 'C kembali');
  assert.strictEqual(await wa2.sendSignal(B.id, { k: 'offer', sdp: 'RAHASIA' }), true);
  await until(() => gotB.length === 1, 3000, 'B menerima signal');
  assert(gotB[0].from === A.id && gotB[0].body.sdp === 'RAHASIA');
  assert.strictEqual(gotC.length, 0, 'C tidak menerima signal untuk B');
  assert(!br.log.some((m) => m.payload.includes('RAHASIA')), 'SDP tidak terbaca di broker');
  assert(br.log.filter((m) => m.topic.includes('/s/')).every((m) => !m.retain), 'signal tidak retained');
  assert.strictEqual(await wa2.sendSignal('zz', {}), false, 'penerima tidak valid');
  await wb.sendSignal(A.id, { k: 'answer' });
  await until(() => gotA.length === 1 && gotA[0].body.k === 'answer', 3000, 'A menerima jawaban');
  ok('signal: terarah ke penerima saja, terenkripsi, tidak retained; dua arah');

  // ---------- 8. putar ulang signal dibuang ----------
  const sigMsg = [...br.log].reverse().find((m) => m.topic === `archne/v1/${A.wanTopics().netId}/s/${B.id}`);
  br._deliver(sigMsg.topic, sigMsg.payload, false, null);
  await sleep(150);
  assert.strictEqual(gotB.length, 1, 'signal yang diputar ulang tidak diteruskan ke UI');
  ok('signal yang diputar ulang dari broker tidak diteruskan ke UI');

  // ---------- 9. jaringan lain tidak saling melihat ----------
  const wx = mkw(X); await wx.start({ broker: BROKER, name: 'Xavier' });
  await sleep(200);
  assert.strictEqual(wx.peers().length, 0, 'kode lain = topik lain: tidak melihat siapa pun');
  assert(!peersOf(wb).includes(X.id));
  ok('kode jaringan berbeda: tidak saling melihat di broker yang sama');

  // ---------- 10. aturan penawar ----------
  const ids = [A.id, B.id].sort();
  const lo = [A, B].find((c) => c.id === ids[0]), hi = [A, B].find((c) => c.id === ids[1]);
  const wLo = lo === A ? wa2 : wb, wHi = hi === A ? wa2 : wb;
  assert.strictEqual(wLo.isOfferer(hi.id), true); assert.strictEqual(wHi.isOfferer(lo.id), false);
  ok('aturan penawar: ID lebih kecil membuat offer, tepat satu sisi per pasangan');

  // ---------- 11. TTL: online yang tidak diperbarui dianggap offline ----------
  let clock = Date.now(); const ticks = [];
  const fakeT = { setInterval: (f, ms) => { ticks.push({ f, ms }); return ticks.length; }, clearInterval: () => {} };
  const br2 = new FakeBroker();
  const wt = createWan({ api: apiOf(B), mqtt: br2.mqtt, now: () => clock, timers: fakeT });
  const wp = createWan({ api: apiOf(A), mqtt: br2.mqtt });
  await wp.start({ broker: BROKER, name: 'P' }); await wt.start({ broker: BROKER, name: 'T' });
  await until(() => wt.peers().length === 1, 3000, 'T melihat P');
  assert(ticks.some((t) => t.ms === 5 * 60 * 1000) && ticks.some((t) => t.ms === 60 * 1000), 'heartbeat 5 menit dan sweep 1 menit terpasang');
  clock += 14 * 60 * 1000; ticks.find((t) => t.ms === 60000).f(); assert.strictEqual(wt.peers().length, 1, '14 menit: masih online');
  clock += 2 * 60 * 1000; ticks.find((t) => t.ms === 60000).f(); assert.strictEqual(wt.peers().length, 0, '16 menit tanpa pembaruan: offline');
  ticks.find((t) => t.ms === 5 * 60 * 1000).f(); // heartbeat P tidak ada di sini; heartbeat T sendiri menyiarkan ulang tanpa galat
  ok('TTL presence: tanpa siaran ulang >15 menit dianggap offline; heartbeat dan sweep terpasang');

  for (const w of [wa2, wb, wc2, wx, wt, wp]) await w.stop();
  for (const c of [A, B, C, X]) await c.stop();
  console.log(`\nSemua ${pass} tes klien WAN lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
