'use strict';
// Tes lapisan transport (mode lintas jaringan, langkah 1). Dua Core saling bicara lewat transport palsu di memori (alamat "rtc:<id>"):
// hello, msg, sync_req, dan file_get (Xfer) tanpa satu pun koneksi TCP. TCP/LAN tidak berubah (ditegakkan seluruh suite lama).
const os = require('os'), path = require('path'), fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const Xfer = require('../src/archne-xfer');
const T = require('../src/archne-transport');
const { MemHub } = require('./lib/memtransport');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-transport-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(20); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 150 }, o));
const hello = (core, to) => core._request({ ip: T.rtcAddr(to.id), port: 1 }, { t: 'hello' }, 3000);

(async () => {
  // ---------- 1. alamat rtc ----------
  const ID = 'ab12cd34ef56ab12';
  assert.strictEqual(T.rtcAddr(ID), 'rtc:' + ID);
  assert(T.isRtcAddr('rtc:' + ID) && !T.isRtcAddr('10.0.0.5') && !T.isRtcAddr(undefined) && !T.isRtcAddr(5));
  assert.strictEqual(T.rtcId('rtc:' + ID), ID); assert.strictEqual(T.rtcId('10.0.0.5'), null);
  assert(T.validRtcAddr('rtc:' + ID));
  for (const bad of ['rtc:', 'rtc:zz', 'rtc:' + ID + '0', 'rtc:AB12CD34EF56AB12', 'rtc:../../x', '10.0.0.5']) assert(!T.validRtcAddr(bad), bad);
  ok('alamat rtc: pembentuk, pengurai, dan validasi ID 16 heksadesimal');

  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();

  // ---------- 2. tanpa transport: rtc: tidak pernah menyentuh TCP/DNS ----------
  const realConnect = net.connect; let tcpCalls = [];
  net.connect = function (...a) { tcpCalls.push(a[0]); return realConnect.apply(this, a); };
  try {
    assert.strictEqual(A._dial({ ip: 'rtc:' + B.id, port: 1 }), null, 'tanpa transport: tidak ada rute');
    assert.strictEqual(await hello(A, B), null, '_request menjawab null, bukan galat');
    assert.strictEqual(A._dial(null), null);
    assert.deepStrictEqual(tcpCalls, [], 'net.connect tidak dipanggil untuk alamat rtc:');
    // alamat rtc rusak tidak diteruskan ke transport walau terpasang
    const hub0 = new MemHub(), t0 = hub0.transport(A.id); A.attachTransport(t0);
    for (const bad of ['rtc:zz', 'rtc:' + B.id + 'x']) assert.strictEqual(await A._request({ ip: bad, port: 1 }, { t: 'hello' }, 500), null);
    assert.strictEqual(t0.dials, 0, 'alamat rtc rusak tidak sampai ke transport');
    A.attachTransport(null);
    // peer TCP biasa tetap lewat TCP
    const r = await A._request({ ip: '127.0.0.1', port: B.port }, { t: 'hello' }, 3000);
    assert(r && r.t === 'hello'); assert(tcpCalls.length >= 1 && tcpCalls.every((c) => c.host === '127.0.0.1'), 'semua koneksi TCP menuju IP nyata, tidak pernah host rtc:'); // sync latar belakang setelah saling kenal boleh menambah koneksi
    assert.strictEqual(A.peers.get(B.id).ip, '127.0.0.1', 'peer LAN dicatat dengan IP-nya, bukan rtc:');
  } finally { net.connect = realConnect; }
  ok('tanpa transport: rtc: tidak menyentuh jaringan; TCP/LAN tetap bekerja');

  // Core baru untuk jalur rtc murni (A dan B di atas sudah saling kenal lewat TCP)
  const C = mk('C'), D = mk('D');
  await C.start(); await D.start();
  const hub = new MemHub(), tc = hub.transport(C.id), td = hub.transport(D.id);
  C.attachTransport(tc); D.attachTransport(td);
  tcpCalls = []; net.connect = function (...a) { tcpCalls.push(a[0]); return realConnect.apply(this, a); };
  try {
    // pesan yang dibuat sebelum saling kenal: harus sampai lewat sync_req
    const early = C.sendText('halo dari C sebelum kenal', 'public');

    // ---------- 3. hello lewat transport ----------
    const r = await hello(C, D);
    assert(r && r.t === 'hello' && r.hi && r.hi.id === D.id, 'balasan hello dengan identitas D');
    await until(() => C.peers.get(D.id) && D.peers.get(C.id) && D.peers.get(C.id).xpub, 4000, 'saling kenal');
    assert.strictEqual(C.peers.get(D.id).ip, 'rtc:' + D.id); assert.strictEqual(D.peers.get(C.id).ip, 'rtc:' + C.id);
    assert(C.isOnline(C.peers.get(D.id)) && D.isOnline(D.peers.get(C.id)));
    assert(tc.dials >= 1 && td.incoming >= 1);
    ok('hello lewat transport: kedua sisi saling mencatat alamat rtc:<id> dan online');

    // ---------- 4. sync_req: riwayat C sampai ke D ----------
    await until(() => D.store.msgs[early.id], 5000, 'sync lewat rtc');
    ok('sync_req lewat transport: pesan lama C tiba di D');

    // ---------- 5. msg langsung ----------
    const m2 = C.sendText('kedua', 'public'); const m3 = D.sendText('balasan D', 'public');
    await until(() => D.store.msgs[m2.id] && C.store.msgs[m3.id], 4000, 'pesan dua arah');
    ok('msg dua arah lewat transport');

    // ---------- 6. berkas: file_get lewat Xfer ----------
    const src = path.join(tmp, 'rand.bin'); fs.writeFileSync(src, crypto.randomBytes(400000));
    const mf = await C.sendFile(src, 'public');
    await until(() => D.store.msgs[mf.id], 4000, 'pesan berkas');
    const got = await D.fetchPacked(mf.id);
    assert.strictEqual(fs.statSync(got.path).size, C.store.files[mf.id].meta.psize, 'berkas terunduh utuh (ukuran paket sama dengan milik pengirim)');
    assert(D.fetchPacked && (await D.fetchPacked(mf.id)).path === got.path, 'sudah lengkap: tidak diunduh lagi');
    assert.deepStrictEqual(tcpCalls, [], 'seluruh pertukaran tanpa satu pun koneksi TCP');
    ok('file_get (Xfer.download) lewat transport tanpa TCP');
  } finally { net.connect = realConnect; }

  // ---------- 7. hello yang mengaku ID lain ditolak ----------
  {
    const evilId = 'ee'.repeat(8), te = hub.transport(evilId);
    const s = te.connect({ ip: T.rtcAddr(D.id), port: 1 });
    const reply = new Promise((res) => { let b = ''; s.setEncoding('utf8'); s.on('data', (d) => { b += d; if (b.includes('\n')) res(b); }); s.on('error', () => res(null)); });
    s.on('connect', () => s.write(JSON.stringify({ t: 'hello', hi: B.hello() }) + '\n')); // mengaku B lewat koneksi milik evilId
    await reply; s.destroy();
    assert(!D.peers.has(B.id), 'hello yang mengaku B lewat alamat rtc:evil tidak dicatat');
    assert(!D.peers.has(evilId));
    // sebaliknya: balasan yang hi.id-nya tidak cocok dengan alamat rtc: yang kutuju tidak dicatat
    const alias = 'dd'.repeat(8); hub.nodes.set(alias, td); // alamat "rtc:dd.." sebenarnya mengantar ke D
    const ipBefore = C.peers.get(D.id).ip;
    const rr = await C._request({ ip: T.rtcAddr(alias), port: 1 }, { t: 'hello' }, 2000);
    assert(rr && rr.hi && rr.hi.id === D.id, 'balasan tetap sampai');
    assert(!C.peers.has(alias) && C.peers.get(D.id).ip === ipBefore, 'identitas D tidak dicatat di bawah alamat yang salah');
    hub.nodes.delete(alias);
    // noteHello langsung
    const before = D.peers.size; D.noteHello(B.hello(), T.rtcAddr(C.id)); assert.strictEqual(D.peers.size, before, 'noteHello: id B dari alamat rtc:C ditolak');
    D.noteHello(B.hello(), T.rtcAddr(B.id)); assert(D.peers.has(B.id) && D.peers.get(B.id).ip === 'rtc:' + B.id, 'id cocok alamat: diterima');
    D.noteHello(B.hello(), '127.0.0.1'); assert.strictEqual(D.peers.get(B.id).ip, '127.0.0.1', 'IP biasa tidak terpengaruh');
  }
  ok('hello hanya sah untuk ID yang terotentikasi transport');

  // ---------- 8. koneksi masuk dengan remoteId tidak sah dibuang ----------
  {
    const { MemSocket } = require('./lib/memtransport');
    for (const bad of ['zz', '', undefined, 'ab12cd34ef56ab1', ID + '0']) {
      const s = new MemSocket(); let closed = false; s.on('close', () => { closed = true; }); s.on('error', () => {});
      td.onIncoming(s, bad); await sleep(20); assert(closed || s.destroyed, 'remoteId ' + JSON.stringify(bad) + ' ditolak');
    }
  }
  ok('koneksi masuk dengan remoteId tidak sah ditutup');

  // ---------- 9. koneksi putus / peer tak terjangkau ----------
  {
    hub.sever(C.id, D.id);
    assert.strictEqual(await hello(C, D), null, 'terputus: null, bukan menggantung');
    hub.heal();
    const r = await hello(C, D); assert(r && r.t === 'hello', 'pulih setelah rute kembali');
    // peer tak dikenal transport
    assert.strictEqual(await C._request({ ip: T.rtcAddr('99'.repeat(8)), port: 1 }, { t: 'hello' }, 1000), null);
  }
  ok('rute putus atau peer tak terjangkau: null; pulih saat rute kembali');

  // ---------- 10. Xfer dengan dial yang gagal ----------
  {
    const part = path.join(tmp, 'x.part');
    await assert.rejects(() => Xfer.download({ ip: 'rtc:' + D.id }, { id: 'x' }, part, 100, { dial: () => null }), (e) => e.code === 'net');
    await assert.rejects(() => Xfer.put({ ip: 'rtc:' + D.id }, {}, path.join(tmp, 'rand.bin'), 0, Buffer.alloc(32), 100, { dial: () => null }), (e) => e.code === 'net' || e.code === 'bad');
  }
  ok('Xfer: tanpa rute (dial = null) -> XferError "net"');

  // ---------- 11. attach/ganti/lepas dan stop ----------
  {
    const E = mk('E'); await E.start();
    const h1 = new MemHub(), t1 = h1.transport(E.id), t2 = h1.transport(E.id);
    E.attachTransport(t1); assert.strictEqual(typeof t1.onIncoming, 'function');
    E.attachTransport(t2); assert(t1.closed && t1.onIncoming === null, 'transport lama ditutup saat diganti'); assert.strictEqual(typeof t2.onIncoming, 'function');
    E.attachTransport(t2); assert(!t2.closed, 'memasang objek yang sama lagi tidak menutupnya');
    await E.stop(); assert(t2.closed && t2.onIncoming === null, 'stop() menutup transport');
    assert.strictEqual(E._dial({ ip: 'rtc:' + ID, port: 1 }), null);
  }
  ok('attachTransport: ganti menutup yang lama; stop() menutup transport');

  await A.stop(); await B.stop(); await C.stop(); await D.stop();
  console.log('\ntransport: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
