'use strict';
// renderer/vendor/mqtt.min.js (bundel peramban mqtt.js) dimuat APA ADANYA dan diuji terhadap broker WebSocket mini.
// Tujuan: (1) versi tidak boleh turun di bawah 5.16.0 (perbaikan keamanan paket dari broker jahat/rusak), (2) opsi yang dipakai
// renderer/archne-wan.js (clean, keepalive, will, timerVariant, reconnectOnConnackError) sampai ke kawat, (3) CONNACK yang ditolak
// tetap dicoba ulang seperti perilaku lama (sejak 5.16.0 bawaannya berhenti; Archne memilih tetap mencoba ulang).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');
const ok = (m) => console.log('  OK  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); } throw new Error('timeout: ' + label); }

const code = fs.readFileSync(path.join(root, 'renderer', 'vendor', 'mqtt.min.js'), 'utf8');
function loadMqtt() {
  const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, TextEncoder, TextDecoder, URL, queueMicrotask, Uint8Array, ArrayBuffer, Promise, Buffer, AbortController, AbortSignal, Event, EventTarget, Error, Symbol, performance, navigator: { language: 'en', userAgent: 'node', product: 'node' } };
  sb.self = sb.window = sb.globalThis = sb;
  vm.createContext(sb); vm.runInContext(code + '\n;this.mqtt = mqtt;', sb);
  return sb.mqtt;
}

// 1. versi
const ver = (/version:"(\d+)\.(\d+)\.(\d+)"/.exec(code) || []).slice(1).map(Number);
assert.strictEqual(ver.length, 3, 'versi mqtt.js terbaca dari bundel');
assert(ver[0] === 5 && ver[1] >= 16, 'mqtt.js >= 5.16.0, ada ' + ver.join('.'));
ok('mqtt.js terpasang ' + ver.join('.') + ' (>= 5.16.0)');

// 2. renderer memilih tetap mencoba ulang setelah CONNACK ditolak
const wan = fs.readFileSync(path.join(root, 'renderer', 'archne-wan.js'), 'utf8');
assert(/reconnectOnConnackError:\s*true/.test(wan), 'archne-wan.js menyetel reconnectOnConnackError: true');
ok('archne-wan.js: reconnectOnConnackError: true');

// broker mini: connackCodes[i] = kode CONNACK untuk sambungan ke-(i+1) (terakhir dipakai berulang)
async function startBroker(connackCodes) {
  const st = { connects: 0, flags: null, clientIds: [] };
  const srv = new WebSocket.Server({ port: 0, host: '127.0.0.1', handleProtocols: (p) => [...p][0] });
  await new Promise((r) => srv.on('listening', r));
  srv.on('connection', (ws) => ws.on('message', (d) => {
    const b = Buffer.from(d); const t = b[0] >> 4;
    if (t === 1) {
      const code = connackCodes[Math.min(st.connects, connackCodes.length - 1)]; st.connects++;
      let i = 1; while (b[i] & 0x80) i++; i++;                  // lewati "remaining length"
      const nameLen = b.readUInt16BE(i); i += 2 + nameLen + 1;  // nama protokol + level
      st.flags = b[i]; i += 3;                                  // flag sambungan, keepalive
      const idLen = b.readUInt16BE(i); st.clientIds.push(b.slice(i + 2, i + 2 + idLen).toString());
      ws.send(Buffer.from([0x20, 0x02, 0x00, code]));
      if (code !== 0) setTimeout(() => ws.close(), 20); // MQTT: server menutup koneksi setelah CONNACK yang ditolak
    } else if (t === 12) ws.send(Buffer.from([0xd0, 0x00]));
  }));
  return { st, port: srv.address().port, close: () => { srv.clients.forEach((c) => c.terminate()); srv.close(); } };
}
const opts = (extra) => Object.assign({
  clientId: 'archne-test', clean: true, keepalive: 30, reconnectPeriod: 100, connectTimeout: 3000, timerVariant: 'native',
  will: { topic: 'a/presence', payload: 'x', qos: 1, retain: true },
  forceNativeWebSocket: true, createWebsocket: (u, p) => new WebSocket(u, p),
}, extra);

(async () => {
  // 3. sambungan normal: opsi sampai ke kawat (clean + will + will retain + will QoS1)
  let B = await startBroker([0]);
  let c = loadMqtt().connect('ws://127.0.0.1:' + B.port + '/mqtt', opts({ reconnectOnConnackError: true }));
  await new Promise((res, rej) => { c.on('connect', res); c.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 4000); });
  assert.strictEqual(B.st.flags & 0x2e, 0x2e, 'flag CONNECT: clean + will + will-QoS1 + will-retain, ada 0x' + B.st.flags.toString(16));
  assert.strictEqual(B.st.clientIds[0], 'archne-test');
  ok('CONNECT membawa clean, Last Will (QoS 1, retain) dan clientId; timerVariant native tanpa Web Worker');
  await new Promise((res) => c.end(true, {}, res)); B.close();

  // 4. CONNACK ditolak (0x03 "server unavailable") lalu diterima: dengan opsi true harus mencoba ulang dan tersambung
  B = await startBroker([3, 0]);
  c = loadMqtt().connect('ws://127.0.0.1:' + B.port + '/mqtt', opts({ reconnectOnConnackError: true }));
  c.on('error', () => {});
  await until(() => B.st.connects >= 2, 4000, 'sambung ulang setelah CONNACK ditolak');
  await new Promise((res, rej) => { if (c.connected) return res(); c.on('connect', res); setTimeout(() => rej(new Error('belum connect')), 3000); });
  assert(c.connected, 'klien tersambung setelah percobaan kedua');
  ok('CONNACK ditolak -> mencoba ulang -> tersambung (reconnectOnConnackError: true)');
  await new Promise((res) => c.end(true, {}, res)); B.close();

  // 5. kontrol: tanpa opsi itu mqtt.js >= 5.16 berhenti (inilah alasan opsi dipasang); 5.10.x masih mencoba ulang karena broker menutup soket
  B = await startBroker([3, 0]);
  c = loadMqtt().connect('ws://127.0.0.1:' + B.port + '/mqtt', opts({}));
  c.on('error', () => {});
  await until(() => B.st.connects >= 1, 3000, 'CONNECT pertama');
  await sleep(1200);
  assert.strictEqual(B.st.connects, 1, 'tanpa opsi, tidak ada percobaan ulang (perilaku bawaan 5.16)');
  ok('kontrol: tanpa opsi, CONNACK ditolak tidak dicoba ulang (perilaku bawaan 5.16)');
  await new Promise((res) => c.end(true, {}, res)); B.close();
  console.log('\n5 kelompok tes lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
