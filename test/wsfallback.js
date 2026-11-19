'use strict';
// Tes jalur cadangan WebSocket (v0.21.3): (1) mqtt.js asli lewat renderer/archne-nativews.js + src/archne-wsproxy.js ke server WebSocket lokal;
// (2) renderer/archne-wan.js beralih ke jalur Node bila Chromium gagal, dan tidak beralih bila sudah pernah tersambung.
const os = require('os'), path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert');
const WebSocket = require('ws');
const { createWsProxy } = require('../src/archne-wsproxy');
const { createNativeWs } = require('../renderer/archne-nativews');
const { createWan } = require('../renderer/archne-wan');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { FakeBroker } = require('./lib/fakemqtt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

// mqtt.min.js asli (bundel peramban) dimuat apa adanya di sandbox tanpa WebSocket global: semua lewat createWebsocket
function loadMqtt() {
  const code = fs.readFileSync(path.join(__dirname, '../renderer/vendor/mqtt.min.js'), 'utf8');
  const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, TextEncoder, TextDecoder, URL, queueMicrotask, Uint8Array, ArrayBuffer, Promise, Buffer, AbortController, AbortSignal, Event, EventTarget, Blob, Response, navigator: { userAgent: 'test', product: 'Electron' }, location: { protocol: 'file:' } };
  sb.self = sb.window = sb.globalThis = sb;
  vm.createContext(sb); vm.runInContext(code + '\n;this.mqtt = mqtt;', sb);
  return sb.mqtt;
}
// IPC palsu antara "renderer" dan wsproxy (struktur-klon dilewati, cukup byte)
function mkApi(proxy, evSink) {
  return {
    wsOpen: async (id, url, protos) => { try { return { ok: proxy.open(id, url, protos) }; } catch (e) { return { ok: false, err: e.message }; } },
    wsSend: async (id, d, t) => ({ ok: proxy.send(id, d, t) }),
    wsClose: async (id) => ({ ok: proxy.close(id) }),
    onWs: (cb) => evSink.push(cb),
  };
}

(async () => {
  // ---- 1. mqtt.js asli di atas jalur Node ----
  const got = { proto: null, connects: 0, subs: 0, pubs: [] };
  const srv = new WebSocket.Server({ port: 0, host: '127.0.0.1', handleProtocols: (p) => { got.proto = [...p][0]; return [...p][0]; } });
  await new Promise((r) => srv.on('listening', r));
  const port = srv.address().port;
  srv.on('connection', (ws) => {
    ws.on('message', (d) => {
      const b = Buffer.from(d); const t = b[0] >> 4;
      if (t === 1) { got.connects++; ws.send(Buffer.from([0x20, 0x02, 0x00, 0x00])); }           // CONNECT -> CONNACK
      else if (t === 8) { got.subs++; const id = b.slice(2, 4); ws.send(Buffer.concat([Buffer.from([0x90, 0x03]), id, Buffer.from([0x01])])); } // SUBSCRIBE -> SUBACK
      else if (t === 3) got.pubs.push(b);
      else if (t === 12) ws.send(Buffer.from([0xd0, 0x00]));                                       // PINGREQ -> PINGRESP
    });
  });
  const sinks = []; const emitEv = (ev) => sinks.forEach((f) => f(ev));
  const proxy = createWsProxy({ WebSocket, send: (ev) => setImmediate(() => emitEv(ev)), log: () => {} });
  const api = mkApi(proxy, sinks);
  const mqtt = loadMqtt();
  const c = mqtt.connect('ws://127.0.0.1:' + port + '/mqtt', { clientId: 't1', reconnectPeriod: 0, forceNativeWebSocket: true, createWebsocket: createNativeWs(api) });
  await new Promise((res, rej) => { c.on('connect', res); c.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 4000); });
  assert.strictEqual(got.proto, 'mqtt'); assert.strictEqual(got.connects, 1);
  ok('mqtt.js asli tersambung (CONNECT/CONNACK) lewat NativeWebSocket + wsproxy, subprotokol "mqtt"');
  await new Promise((res, rej) => c.subscribe('a/b', { qos: 1 }, (e) => (e ? rej(e) : res())));
  await new Promise((res, rej) => c.publish('a/b', 'halo', { qos: 0 }, (e) => (e ? rej(e) : res())));
  await until(() => got.subs === 1 && got.pubs.length === 1, 3000, 'subscribe/publish');
  ok('subscribe (SUBACK balik) dan publish biner sampai ke server');
  await new Promise((res) => c.end(false, {}, res));
  await until(() => proxy.size() === 0, 3000, 'soket ditutup');
  ok('c.end() menutup soket di proses utama');

  // alamat tak sah ditolak wsproxy; batas jumlah soket
  assert.throws(() => proxy.open('x1', 'http://x'), /tidak valid/);
  assert.throws(() => proxy.open('x1', 'ws://example.com:8083/mqtt'), /tidak valid/); // ws:// hanya ke localhost
  assert.throws(() => proxy.open('bad id', 'ws://127.0.0.1:' + port), /id soket/);
  const ids = []; for (let i = 0; i < 4; i++) { proxy.open('s' + i, 'ws://127.0.0.1:' + port + '/mqtt', ['mqtt']); ids.push('s' + i); }
  assert.throws(() => proxy.open('s9', 'ws://127.0.0.1:' + port + '/mqtt'), /Terlalu banyak/);
  proxy.dispose(); assert.strictEqual(proxy.size(), 0);
  ok('wsproxy menolak alamat/ID tidak sah dan membatasi 4 soket; dispose menutup semua');

  // server mati -> mqtt.js menerima galat/close (bukan menggantung)
  const dead = createNativeWs(mkApi(proxy, sinks));
  const ws = dead('ws://127.0.0.1:1/mqtt', ['mqtt']); const seen = [];
  ws.addEventListener('error', () => seen.push('error')); ws.addEventListener('close', () => seen.push('close'));
  await until(() => seen.includes('close'), 4000, 'close');
  assert.deepStrictEqual(seen, ['error', 'close']);
  ok('tujuan tidak terjangkau: error lalu close, readyState 3');
  srv.close();

  // ---- 2. failover di archne-wan.js ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-wsf-'));
  const mkCore = async (n) => { const cc = new Core({ dataDir: path.join(tmp, n), name: n, discovery: false }); await cc.start(); cc.wanSetCode(cc.wanNewCode()); return cc; };
  const apiOf = (core) => { const h = {}; register({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core, shell: {}, send: () => {}, log: () => {}, pickFiles: async () => [] }); return new Proxy({}, { get: (_t, n) => (...a) => Promise.resolve(h[n]({}, ...a)) }); };
  const A = await mkCore('A');
  const fb = new FakeBroker();
  const calls = [];
  // Chromium palsu gagal ("connack timeout"), jalur Node berhasil
  const mqttFail = { connect: (url, o) => { calls.push(!!o.createWebsocket); if (o.createWebsocket) return fb.mqtt.connect(url, o); const L = {}; const cl = { on: (k, f) => { (L[k] = L[k] || []).push(f); return cl; }, end: () => {}, removeAllListeners: () => { for (const k of Object.keys(L)) L[k] = []; }, publish() {}, subscribe() {} }; setTimeout(() => { (L.error || []).forEach((f) => f(new Error('connack timeout'))); (L.close || []).forEach((f) => f()); }, 20); return cl; } };
  const logs = []; const st = [];
  const w = createWan({ api: apiOf(A), mqtt: mqttFail, log: (m) => logs.push(m), nativeWs: () => ({}) });
  w.on('status', (s) => st.push(s.state));
  await w.start({ broker: 'wss://broker.test/mqtt', name: 'A' });
  await until(() => st.includes('online'), 4000, 'online lewat jalur Node');
  assert.deepStrictEqual(calls, [false, true]); assert(!st.includes('error') && !st.includes('offline'), 'tidak ada status galat/offline selama pindah: ' + st);
  assert(logs.some((l) => /beralih ke jalur Node/.test(l)) && logs.some((l) => /jalur Node/.test(l)));
  ok('Chromium gagal -> otomatis pindah ke jalur Node, status akhir online, tanpa galat di antaranya');
  await w.stop();

  // Chromium menggantung diam-diam (tanpa galat/close): watchdog memindahkan ke jalur Node
  const calls4 = [];
  const w4 = createWan({ api: apiOf(A), mqtt: { connect: (u, o) => { calls4.push(!!o.createWebsocket); if (o.createWebsocket) return fb.mqtt.connect(u, o); const cl = { on: () => cl, end() {}, removeAllListeners() {} }; return cl; } }, log: () => {}, nativeWs: () => ({}), watchdogMs: 150 });
  const st4 = []; w4.on('status', (s) => st4.push(s.state)); await w4.start({ broker: 'wss://broker.test/mqtt', name: 'A' });
  await until(() => st4.includes('online'), 3000, 'online setelah watchdog'); assert.deepStrictEqual(calls4, [false, true]);
  ok('Chromium menggantung tanpa galat: watchdog memindahkan ke jalur Node');
  await w4.stop();

  // Electron: mqtt.js tidak boleh memakai timer berbasis Worker (diblokir CSP) -> timerVariant 'native'
  const seenOpts = []; const w5 = createWan({ api: apiOf(A), mqtt: { connect: (u, o) => { seenOpts.push(o.timerVariant); return fb.mqtt.connect(u, o); } }, log: () => {}, nativeWs: () => ({}) });
  await w5.start({ broker: 'wss://broker.test/mqtt', name: 'A' }); assert.strictEqual(seenOpts[0], 'native');
  const w6 = createWan({ api: apiOf(A), mqtt: { connect: (u, o) => { seenOpts.push(o.timerVariant); return fb.mqtt.connect(u, o); } }, log: () => {} });
  await w6.start({ broker: 'wss://broker.test/mqtt', name: 'A' }); assert.strictEqual(seenOpts[1], undefined);
  ok("Electron memakai timerVariant 'native' (tanpa Worker blob yang diblokir CSP); Android/peramban tidak berubah");
  await w5.stop(); await w6.stop();

  // tanpa nativeWs: perilaku lama (status error)
  const calls2 = []; const st2 = [];
  const w2 = createWan({ api: apiOf(A), mqtt: { connect: (u, o) => { calls2.push(!!o.createWebsocket); const L = {}; const cl = { on: (k, f) => { (L[k] = L[k] || []).push(f); return cl; }, end: () => {}, publish() {}, subscribe() {} }; setTimeout(() => (L.error || []).forEach((f) => f(new Error('connack timeout'))), 10); return cl; } }, log: () => {} });
  w2.on('status', (s) => st2.push(s)); await w2.start({ broker: 'wss://broker.test/mqtt', name: 'A' });
  await until(() => st2.some((s) => s.state === 'error' && /connack/.test(s.err)), 2000, 'error lama'); assert.deepStrictEqual(calls2, [false]);
  await w2.stop();
  ok('tanpa nativeWs (Android/peramban): tidak ada pindah jalur, galat tetap dilaporkan');

  // sudah pernah tersambung lewat Chromium lalu putus: TIDAK pindah jalur (sambung ulang mqtt.js yang menangani)
  const calls3 = []; let cl3; const L3 = {};
  const w3 = createWan({ api: apiOf(A), mqtt: { connect: (u, o) => { calls3.push(!!o.createWebsocket); cl3 = fb.mqtt.connect(u, o); const on = cl3.on.bind(cl3); cl3.on = (k, f) => { (L3[k] = L3[k] || []).push(f); return on(k, f); }; return cl3; } }, log: () => {}, nativeWs: () => ({}) });
  const st3 = []; w3.on('status', (s) => st3.push(s.state)); await w3.start({ broker: 'wss://broker.test/mqtt', name: 'A' });
  await until(() => st3.includes('online'), 3000, 'online chromium');
  (L3.close || []).forEach((f) => f()); await sleep(100);
  assert.deepStrictEqual(calls3, [false]); assert.strictEqual(st3[st3.length - 1], 'offline');
  ok('setelah pernah online lewat Chromium, putus biasa tidak memicu pindah jalur');
  await w3.stop(); await A.stop();

  console.log('\nSemua ' + pass + ' tes jalur cadangan WebSocket lulus');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.name, String(e && e.message).slice(0, 300), String(e && e.stack).split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 4).join(' | ').slice(0, 400)); process.exit(1); });
