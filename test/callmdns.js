'use strict';
// v0.17.1: nama mDNS (.local) pada kandidat ICE diganti IP pengirim agar panggilan tersambung di jaringan tanpa multicast.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-mdns-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); } throw new Error('timeout: ' + label); }
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const N1 = '3f2b8c1e-9a4d-4e7b-8c21-5d6a7b8c9d0e.local', N2 = 'AAAAAAAA-1111-2222-3333-444444444444.local';
(async () => {
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  await Promise.all([A.addPeer('127.0.0.1', B.port), B.addPeer('127.0.0.1', A.port)]);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 8000, 'mesh');
  const ev = []; B.on('call', (e) => ev.push(e));
  const cand = (h) => JSON.stringify({ candidate: `candidate:1 1 udp 2113937151 ${h} 54321 typ host generation 0`, sdpMid: '0' });
  const cid = A.callStart(B.id, `v=0\r\na=candidate:1 1 udp 2113937151 ${N1} 50000 typ host\r\na=candidate:2 1 udp 2113937151 ${N2} 50001 typ host\r\na=candidate:3 1 udp 1 10.0.0.5 50002 typ host\r\n`);
  A.callIce(cid, cand(N1));
  await until(() => ev.some((e) => e.ev === 'incoming') && ev.some((e) => e.ev === 'ice'), 5000, 'B menerima');
  const inc = ev.find((e) => e.ev === 'incoming'), ice = ev.find((e) => e.ev === 'ice');
  assert(!/\.local/i.test(inc.sdp), 'SDP tanpa nama .local');
  assert(/ 127\.0\.0\.1 50000 typ host/.test(inc.sdp) && / 127\.0\.0\.1 50001 typ host/.test(inc.sdp), 'diganti IP pengirim');
  assert(/ 10\.0\.0\.5 50002 /.test(inc.sdp), 'IP biasa tidak disentuh');
  assert(!/\.local/i.test(ice.data) && ice.data.includes('127.0.0.1 54321'), 'kandidat ICE diganti');
  assert(!/\.local/i.test(JSON.stringify(B.getState().call || {})), 'snapshot tanpa nama .local');
  console.log('  OK  nama mDNS diganti IP pengirim (SDP dan ICE)');
  for (const n of [A, B]) { try { await n.stop(); } catch {} }
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
