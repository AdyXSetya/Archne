'use strict';
// Tes alamat peer (v0.9.3): port tetap, tambah peer cukup IP / nama host / banyak alamat, pertukaran alamat peer, dan batasnya.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core, parseAddr, DEFAULT_TCP_PORT } = require('../src/archne-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-addr-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (name) => { pass++; console.log('  OK  ' + name); };
const mk = (n, o = {}) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 150, hintOk: (ip) => ip === '127.0.0.1' }, o));
const online = (c, id) => c.getState().peers.some((p) => p.id === id && p.online);

(async () => {
  console.log('Archne addr test, dir: ' + tmp);

  // ---------- parseAddr ----------
  const P = parseAddr;
  assert.deepStrictEqual(P('100.64.1.2'), { ip: '100.64.1.2', port: DEFAULT_TCP_PORT }, 'IP saja = port tetap');
  assert.deepStrictEqual(P('  192.168.1.5:5000 '), { ip: '192.168.1.5', port: 5000 });
  assert.deepStrictEqual(P('budi-pc.tailnet.ts.net'), { ip: 'budi-pc.tailnet.ts.net', port: DEFAULT_TCP_PORT }, 'nama host (MagicDNS)');
  assert.deepStrictEqual(P('pc-budi:41999'), { ip: 'pc-budi', port: 41999 });
  for (const bad of ['', '   ', '999.1.1.1', '1.2.3', '10.0.0.1:0', '10.0.0.1:65536', '10.0.0.1:abc', 'a b', 'http://x.com', '-x', 'x_y', null, undefined]) assert.strictEqual(P(bad), null, 'tidak sah: ' + bad);
  ok('parseAddr: IP saja, ip:port, nama host; angka ngawur dan format salah ditolak');

  // ---------- port tetap ----------
  const A = mk('A'), B = mk('B'), C = mk('C');
  await A.start(); await B.start(); await C.start();
  const free = A.port === DEFAULT_TCP_PORT;
  if (free) assert(B.port !== DEFAULT_TCP_PORT && C.port !== DEFAULT_TCP_PORT && B.port !== C.port, 'yang kedua dst. jatuh ke port acak');
  assert(A.port > 0 && B.port > 0);
  ok(free ? `port tetap ${DEFAULT_TCP_PORT} dipakai instance pertama; yang berikutnya jatuh ke port acak tanpa gagal start` : 'port tetap sedang dipakai proses lain di mesin ini: jatuh ke port acak (tidak gagal start)');

  // ---------- tambah peer: IP saja / banyak alamat ----------
  if (free) {
    const r = await B.addPeers('127.0.0.1');
    assert.deepStrictEqual(r.added, ['127.0.0.1:' + DEFAULT_TCP_PORT], 'cukup IP, port tetap dipakai otomatis');
    await until(() => online(B, A.id) && online(A, B.id), 8000, 'A-B online');
    ok('addPeers("127.0.0.1") tersambung tanpa mengetik port');
  } else {
    await B.addPeer('127.0.0.1', A.port);
    await until(() => online(B, A.id) && online(A, B.id), 8000, 'A-B online');
  }
  const r2 = await C.addPeers(`  127.0.0.1:${A.port}, 127.0.0.1:1;  bukan_alamat\n999.9.9.9 127.0.0.1:${A.port} `);
  assert.deepStrictEqual(r2.added, ['127.0.0.1:' + A.port], 'duplikat digabung, yang benar tersambung');
  assert.deepStrictEqual(r2.fail, ['127.0.0.1:1'], 'port mati dilaporkan gagal');
  assert.deepStrictEqual(r2.bad.sort(), ['999.9.9.9', 'bukan_alamat'].sort(), 'teks yang bukan alamat (underscore, angka ngawur) dilaporkan terpisah');
  await until(() => online(C, A.id), 8000, 'C-A online');
  assert.deepStrictEqual(await C.addPeers(''), { added: [], fail: [], bad: [] });
  assert.strictEqual(await C.addPeer('bukan alamat'), false);
  const many = await C.addPeers(Array.from({ length: 30 }, (_, i) => `10.255.255.${i + 1}:1`).join(' '));
  assert(many.added.length + many.fail.length + many.bad.length <= 10, 'dibatasi 10 alamat sekali tambah');
  ok('beberapa alamat sekaligus (koma/spasi/baris baru): yang benar tersambung, yang mati dan yang bukan alamat dilaporkan; maks 10');

  // ---------- pertukaran alamat: B dan C hanya mengenal A ----------
  assert(!B.peers.has(C.id) && !C.peers.has(B.id), 'awalnya B dan C belum saling kenal');
  await until(() => online(B, C.id) && online(C, B.id), 12000, 'B menemukan C lewat A');
  ok('cukup tersambung ke satu peer (A): B dan C saling menemukan lewat pertukaran alamat');

  // ---------- batas pertukaran ----------
  const hints = A._peerHints(B.id);
  assert(hints.some((h) => h.id === C.id) && !hints.some((h) => h.id === B.id) && hints.every((h) => /^[0-9a-f]{16}$/.test(h.id) && h.ip && h.port), 'petunjuk berisi peer online lain, bukan peminta');
  A.blockUser(C.id);
  assert(!A._peerHints(B.id).some((h) => h.id === C.id), 'peer yang kublokir tidak dibagikan');
  A.unblockUser(C.id);
  const real = new Core({ dataDir: path.join(tmp, 'R'), name: 'R', discovery: false });
  await real.start();
  const own = os.networkInterfaces();
  for (const [ip, want] of [['192.168.1.9', true], ['10.8.0.3', true], ['172.20.1.1', true], ['100.64.0.7', true], ['26.1.2.3', true], ['8.8.8.8', false], ['1.1.1.1', false], ['203.0.113.5', false], ['127.0.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false], ['bukan-ip', false]]) {
    assert.strictEqual(real._hintOk(ip, 41235), want, `${ip} -> ${want}`);
  }
  assert.strictEqual(real._hintOk('192.168.1.9', 80), false, 'port rendah ditolak');
  assert.strictEqual(real._hintOk('192.168.1.9', 70000), false);
  for (const list of Object.values(own)) for (const a of list) if (a.family === 'IPv4' && !a.internal) assert.strictEqual(real._hintOk(a.address, 41235), false, 'alamat diri sendiri ditolak');
  await real.stop();
  ok('petunjuk alamat: yang diblokir tidak dibagikan; hanya rentang pribadi/VPN yang dicoba (internet publik, loopback, multicast, port rendah, alamat sendiri ditolak)');

  // ---------- petunjuk palsu tidak bisa memalsukan identitas ----------
  const evil = mk('E'); await evil.start();
  evil._peerHints = () => [{ id: 'f'.repeat(16), ip: '127.0.0.1', port: C.port }]; // klaim "peer ffff.." ada di alamat C
  await C.stop();
  const C2 = mk('C', {}); await C2.start();
  await evil.addPeer('127.0.0.1', B.port);
  await sleep(1500);
  assert(![...B.peers.keys()].includes('f'.repeat(16)), 'id dari petunjuk tidak pernah dipercaya; yang dicatat hanya identitas yang membalas hello bertanda tangan');
  ok('id dalam petunjuk tidak dipercaya: yang dicatat hanya peer yang benar-benar menjawab hello terverifikasi');

  // ---------- port lama basi: peer dibuka ulang di port tetap ----------
  if (free) {
    const Z = mk('Z'); // port acak (A memegang port tetap)
    await Z.start();
    const stale = mk('S', { tcpPort: undefined });
    await stale.start();
    stale.peers.set(A.id, { id: A.id, name: 'A', ip: '127.0.0.1', port: 1, lastSeen: 0 }); // catatan lama: port 1 sudah basi
    await until(() => online(stale, A.id), 12000, 'menemukan A lewat port tetap');
    ok('catatan peer dengan port basi pulih sendiri lewat percobaan port tetap');
    await Z.stop(); await stale.stop();
  }

  for (const n of [A, B, C2, evil]) await n.stop();
  console.log(`\nSEMUA TES ALAMAT PEER LULUS (${pass})`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
