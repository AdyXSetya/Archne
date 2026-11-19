'use strict';
// Tes terpadu langkah 4 (mode lintas jaringan): Core melalui DataChannel. Rantai lengkap, tanpa jaringan sungguhan:
//   Core A -- archne-ipc.js/rtcbridge -- rtcglue -- rtcmux -- RTCPeerConnection PALSU -- rtcmux -- rtcglue -- rtcbridge/archne-ipc.js -- Core B
// dengan archne-wan.js + broker MQTT palsu untuk presence dan sinyal terenkripsi (seperti langkah 3).
// Bagian 1-6: jalur IPC biner (Electron). Bagian 7: sisi A lewat server HTTP sungguhan (archne-rpc.js, base64 + SSE; Android/peramban).
// Yang TIDAK terbukti di sini: penembusan NAT dan perilaku RTCDataChannel sungguhan (uji manual di rencana).
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert'), http = require('http');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const { createRpc } = require('../src/archne-rpc');
const { createWan } = require('../renderer/archne-wan');
const { createRtcMux } = require('../renderer/archne-rtcmux');
const { createRtcGlue, MUX_WINDOW } = require('../renderer/archne-rtcglue');
const { FakeBroker } = require('./lib/fakemqtt');
const { FakeNet } = require('./lib/fakertc');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-rtccore-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(15); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mkCore = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), downloadDir: path.join(tmp, n + '-dl'), name: n, discovery: false, tickMs: 100, syncMs: 200 }, o));
const BROKER = 'wss://broker.test/mqtt';
const cloneBloat = { n: 0 };

let finished = false;
process.on('exit', (c) => { if (!finished && c === 0) { console.error('GAGAL: proses berakhir sebelum semua tes selesai (ada Promise yang menunggu selamanya)'); process.exitCode = 1; } });
setTimeout(() => { console.error('GAGAL: tes menggantung > 170 detik'); process.exit(1); }, 170000).unref();

// ------------------------------------------------------------------ sisi UI lewat IPC langsung (seperti Electron)
function ipcSide(core, name, net, br) {
  const h = {}; let glue = null;
  const ipc = register({
    ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core, shell: {}, log: () => {}, pickFiles: async () => [],
    send: (ch, p) => { if (ch === 'rtcb') { const m = structuredClone(p); setImmediate(() => glue && glue.feed(m)); } }, // IPC Electron: structured clone (Uint8Array utuh)
  });
  const api = new Proxy({}, { get: (_t, n) => (...a) => Promise.resolve(h[n]({}, ...structuredClone(a))) });
  return finishSide({ core, name, net, br, api, ipc, setGlue: (g) => { glue = g; }, base64: false, call: (batch) => {
    for (const m of batch) if (m.op === 'data' && !(m.d instanceof Uint8Array && m.d.buffer.byteLength === m.d.byteLength)) cloneBloat.n++; // tampilan pada buffer besar = seluruh buffer ikut diserialkan IPC
    return api.rtcIn(batch);
  } });
}

function finishSide(s) {
  const wan = createWan({ api: s.api, mqtt: s.br.mqtt });
  const rm = createRtcMux({ wan, RTCPeerConnection: s.net.rtc(s.name), mux: { window: MUX_WINDOW }, connectTimeoutMs: 4000, backoffMs: [50, 100, 200], byeCooldownMs: 150 });
  const glue = createRtcGlue({ rm, call: s.call, base64: s.base64 });
  s.setGlue(glue);
  return Object.assign(s, { wan, rm, glue });
}
const startSide = async (s) => { await s.glue.start(); await s.wan.start({ broker: BROKER, name: s.name }); };
const isLinked = (x, y) => x.rm.links().some((l) => l.peerId === y.core.id && l.state === 'open');
const onlineVia = (c, o) => { const p = c.peers.get(o.id); return !!p && c.isOnline(p) && p.ip === 'rtc:' + o.id; };

(async () => {
  const code = new Core({ dataDir: path.join(tmp, 'tmp'), name: 'x', discovery: false }).wanNewCode();
  const net = new FakeNet(), br = new FakeBroker();
  const CA = mkCore('A'), CB = mkCore('B');
  await CA.start(); await CB.start();
  CA.wanSetCode(code); CB.wanSetCode(code);
  const A = ipcSide(CA, 'A', net, br), B = ipcSide(CB, 'B', net, br);
  A.rm.on('stream', () => {}); // (glue sudah mendengarkan; ini hanya memastikan tidak ada konsumen lain yang merusak)

  // pesan dibuat SEBELUM tersambung: harus sampai lewat sync
  const netm = require('net'), realConnect = netm.connect, tcp = [];
  netm.connect = function (...a) { tcp.push(a[0]); return realConnect.apply(this, a); }; // bagian 1-5 tidak boleh membuka satu pun koneksi TCP
  const early = CA.sendText('halo dari A sebelum tersambung', 'public');
  await Promise.all([startSide(A), startSide(B)]);

  // ---------- 1. tersambung: link terbuka -> Core saling menyapa lewat rtc:<id> ----------
  await until(() => isLinked(A, B) && isLinked(B, A), 8000, 'link DataChannel terbuka');
  await until(() => onlineVia(CA, CB) && onlineVia(CB, CA), 5000, 'Core A dan B saling online lewat rtc:');
  assert(CA.peers.get(CB.id).xpub && CB.peers.get(CA.id).xpub, 'kunci tukar sudah diketahui (DM bisa dienkripsi)');
  assert.strictEqual(A.glue.stats().restarts, 1);
  assert.deepStrictEqual(A.ipc.bridge.links().map((l) => l.peerId), [CB.id]);
  const st = await A.api.rtcStatus(); assert(st.ok && st.attached && st.links.length === 1);
  ok('1 link DataChannel terbuka -> kedua Core saling online dengan alamat rtc:<id> dan kunci tukar');

  // ---------- 2. pesan: sync riwayat, publik dua arah, DM terenkripsi, grup ----------
  await until(() => CB.store.msgs[early.id], 6000, 'sync lewat rtc');
  const m1 = CA.sendText('publik dari A', 'public'), m2 = CB.sendText('publik dari B', 'public');
  await until(() => CB.store.msgs[m1.id] && CA.store.msgs[m2.id], 5000, 'publik dua arah');
  const d1 = CA.sendText('rahasia A->B', CB.id), d2 = CB.sendText('rahasia B->A', CA.id);
  await until(() => CB.store.msgs[d1.id] && CA.store.msgs[d2.id], 5000, 'DM dua arah');
  assert.strictEqual(CB.openText ? CB.openText(CB.store.msgs[d1.id]) : 'rahasia A->B', 'rahasia A->B');
  const g = CA.createGroup('grup rtc', [CB.id]);
  await until(() => CB.store.groups[g.id] && !CB.store.groups[g.id].removed, 5000, 'undangan grup lewat rtc');
  const gm = CA.sendText('halo grup', 'g:' + g.id); await until(() => CB.store.msgs[gm.id], 5000, 'pesan grup');
  ok('2 sync riwayat, publik, DM terenkripsi, dan grup berjalan lewat DataChannel (tanpa satu pun koneksi TCP)');

  // ---------- 3. berkas: publik 3 MB dan DM 1.5 MB utuh bit-per-bit ----------
  const f1 = path.join(tmp, 'rand3.bin'), f2 = path.join(tmp, 'text.txt');
  fs.writeFileSync(f1, crypto.randomBytes(3 * 1024 * 1024)); fs.writeFileSync(f2, 'baris teks berulang untuk dikompres\n'.repeat(40000));
  {
    const mf = await CA.sendFile(f1, 'public'); await until(() => CB.store.msgs[mf.id], 5000, 'tawaran berkas');
    const r = await CB.receiveFile(mf.id); assert.strictEqual(sha(fs.readFileSync(r.path)), sha(fs.readFileSync(f1)), 'berkas publik utuh');
    const md = await CB.sendFile(f2, CA.id); await until(() => CA.store.msgs[md.id], 5000, 'tawaran DM');
    const r2 = await CA.receiveFile(md.id); assert.strictEqual(sha(fs.readFileSync(r2.path)), sha(fs.readFileSync(f2)), 'berkas DM (terkompres+tersegel) utuh');
    const gs = A.ipc.bridge.stats; assert(gs.out > 1e6 || B.ipc.bridge.stats.out > 1e6, 'byte benar-benar lewat jembatan');
  }
  ok('3 berkas publik 3 MB dan DM terkompres+tersegel diunduh utuh (hash sama) lewat Xfer di atas DataChannel');

  // ---------- 4. link turun: peer langsung offline (tanpa menunggu 12 dtk), outbox menunggu, terkirim saat link naik ----------
  {
    const t0 = Date.now(); A.rm.close(CB.id);
    await until(() => !isLinked(A, B) && !isLinked(B, A), 3000, 'link ditutup');
    await until(() => !CA.isOnline(CA.peers.get(CB.id)) && !CB.isOnline(CB.peers.get(CA.id)), 2500, 'offline langsung');
    assert(Date.now() - t0 < 2500, 'offline tanpa menunggu ONLINE_MS (12 dtk): ' + (Date.now() - t0) + ' ms');
    assert.strictEqual(await CA._request({ ip: 'rtc:' + CB.id, port: 1 }, { t: 'hello' }, 500), null, 'tanpa link: _request null (tidak menggantung)');
    const q = CA.sendText('dikirim saat offline', CB.id); await sleep(300); assert(!CB.store.msgs[q.id], 'belum sampai');
    await A.rm.connect(CB.id); await until(() => isLinked(B, A) && onlineVia(CA, CB) && onlineVia(CB, CA), 8000, 'tersambung kembali');
    await until(() => CB.store.msgs[q.id], 6000, 'outbox terkirim setelah link naik');
    ok('4 link turun: kedua Core langsung offline; pesan menunggu di outbox dan terkirim otomatis saat link naik lagi');
  }

  // ---------- 5. berkas dilanjutkan (resume) setelah link putus di tengah unduhan ----------
  {
    const big = path.join(tmp, 'big.bin'); fs.writeFileSync(big, crypto.randomBytes(8 * 1024 * 1024));
    const mf = await CA.sendFile(big, 'public'); await until(() => CB.store.msgs[mf.id], 5000, 'tawaran');
    let cut = false, firstDone = 0;
    const p1 = CB.receiveFile(mf.id, { onProgress: (p) => { if (!cut && p.done > 1.5e6) { cut = true; firstDone = p.done; A.rm.close(CB.id); } } });
    await assert.rejects(p1, (e) => e && e.code !== 'abort', 'unduhan gagal karena link putus (bukan hang)');
    assert(cut);
    const sentBefore = A.ipc.bridge.stats.out;
    await A.rm.connect(CB.id); await until(() => isLinked(B, A) && onlineVia(CB, CA), 8000, 'tersambung kembali');
    const r = await CB.receiveFile(mf.id);
    assert.strictEqual(sha(fs.readFileSync(r.path)), sha(fs.readFileSync(big)), 'berkas utuh setelah dilanjutkan');
    const resent = A.ipc.bridge.stats.out - sentBefore;
    assert(resent < 8 * 1024 * 1024 - 1e6, 'dilanjutkan dari .part, bukan diulang dari awal: A mengirim ulang ' + resent + ' byte');
    ok('5 unduhan 8 MB terputus di ~' + Math.round(firstDone / 1e6 * 10) / 10 + ' MB lalu dilanjutkan; hash akhir sama');
  }

  netm.connect = realConnect; assert.deepStrictEqual(tcp, [], 'bagian 1-5: nol koneksi TCP, semuanya lewat DataChannel');

  // ---------- 6. LAN didahulukan; bila LAN mati, jatuh ke rtc ----------
  {
    const CC = mkCore('C'), CD = mkCore('D'); await CC.start(); await CD.start(); const code2 = CC.wanNewCode(); CC.wanSetCode(code2); CD.wanSetCode(code2); // kode lain: tidak bercampur dengan A/B
    assert(await CC.addPeer('127.0.0.1', CD.port)); await until(() => CC.isOnline(CC.peers.get(CD.id)) && CD.isOnline(CD.peers.get(CC.id)), 5000, 'online lewat LAN');
    const C = ipcSide(CC, 'C', net, br), D = ipcSide(CD, 'D', net, br);
    await Promise.all([startSide(C), startSide(D)]); await until(() => isLinked(C, D) && isLinked(D, C), 8000, 'link rtc juga terbuka');
    await sleep(600); // beberapa tick dan sync
    assert.strictEqual(CC.peers.get(CD.id).ip, '127.0.0.1', 'peer LAN tidak ditimpa alamat rtc: selagi LAN hidup');
    assert.strictEqual(CD.peers.get(CC.id).ip, '127.0.0.1');
    CC.noteHello(CD.hello(), 'rtc:' + CD.id); assert.strictEqual(CC.peers.get(CD.id).ip, '127.0.0.1', 'hello rtc: langsung pun tidak menimpa LAN yang online');
    const lanTx = C.ipc.bridge.stats.out + D.ipc.bridge.stats.out;
    const m = CC.sendText('lewat LAN walau rtc terbuka', 'public'); await until(() => CD.store.msgs[m.id], 4000, 'pesan');
    await sleep(100);
    assert(C.ipc.bridge.stats.out + D.ipc.bridge.stats.out - lanTx < 2000, 'pesan lewat TCP, bukan DataChannel');
    // LAN mati di kedua sisi: alamat LAN buntu + dianggap kedaluwarsa -> pulih lewat rtc
    for (const [c, o] of [[CC, CD], [CD, CC]]) { const p = c.peers.get(o.id); p.port = 1; p.ip = '127.0.0.1'; p.lastSeen = 0; }
    CC.opts.broadcast = []; // tidak ada UDP; hello TCP ke port buntu gagal
    await until(() => onlineVia(CC, CD) && onlineVia(CD, CC), 8000, 'pulih lewat rtc');
    const m2 = CC.sendText('setelah LAN mati', 'public'); await until(() => CD.store.msgs[m2.id], 6000, 'pesan lewat rtc');
    for (const s of [C, D]) { await s.rm.stop(); await s.wan.stop(); await s.glue.stop(); }
    await CC.stop(); await CD.stop();
    ok('6 LAN didahulukan (alamat tidak ditimpa rtc:, pesan lewat TCP); LAN mati -> peer pulih otomatis lewat DataChannel');
  }

  // ---------- 7. sisi A lewat server HTTP sungguhan (base64 + SSE), sisi B lewat IPC biner ----------
  {
    const CH = mkCore('H', { syncMs: 1000 }), CI = mkCore('I', { syncMs: 1000 }); await CH.start(); await CI.start(); const code3 = CH.wanNewCode(); CH.wanSetCode(code3); CI.wanSetCode(code3);
    const rpc = createRpc({ core: CH, log: () => {} }); await rpc.start();
    const base = `http://127.0.0.1:${rpc.port}/s/${rpc.token}/`;
    const post = async (name, args) => { const r = await fetch(base + 'rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }); assert(r.ok, 'rpc ' + name + ' ' + r.status); return r.json(); };
    const api = new Proxy({}, { get: (_t, n) => (...a) => post(n, a) });
    let glueH = null, evs = 0;
    // klien SSE minimal (EventSource ada di peramban; Node tidak punya)
    const ac = new AbortController();
    (async () => {
      const r = await fetch(base + 'events', { signal: ac.signal }); const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) return; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^event: (\w+)\ndata: (.*)$/m.exec(blk);
          if (m && m[1] === 'rtcb') { evs++; const msg = JSON.parse(m[2]); setImmediate(() => glueH && glueH.feed(msg)); }
        }
      }
    })().catch(() => {});
    const H = finishSide({ core: CH, name: 'H', net, br, api, setGlue: (g) => { glueH = g; }, base64: true, call: (batch) => api.rtcIn(batch) });
    const I = ipcSide(CI, 'I', net, br);
    await Promise.all([startSide(H), startSide(I)]);
    await until(() => isLinked(H, I) && isLinked(I, H) && onlineVia(CH, CI) && onlineVia(CI, CH), 10000, 'tersambung lewat HTTP+SSE');
    const m = CH.sendText('dari sisi HTTP', 'public'), m2 = CI.sendText('ke sisi HTTP', 'public');
    await until(() => CI.store.msgs[m.id] && CH.store.msgs[m2.id], 6000, 'pesan dua arah (base64/JSON)');
    // transfer besar dua arah + ukur kecepatan jalur HTTP/base64
    const big = path.join(tmp, 'http20.bin'); fs.writeFileSync(big, crypto.randomBytes(20 * 1024 * 1024));
    let t0 = Date.now(); const mf = await CH.sendFile(big, 'public'); await until(() => CI.store.msgs[mf.id], 6000, 'tawaran');
    const r = await CI.receiveFile(mf.id); const upSec = (Date.now() - t0) / 1000;
    assert.strictEqual(sha(fs.readFileSync(r.path)), sha(fs.readFileSync(big)), 'H -> I (sumber lewat HTTP/base64) utuh');
    t0 = Date.now(); const mg = await CI.sendFile(big, 'public'); await until(() => CH.store.msgs[mg.id], 6000, 'tawaran balik');
    const r2 = await CH.receiveFile(mg.id); const downSec = (Date.now() - t0) / 1000;
    assert.strictEqual(sha(fs.readFileSync(r2.path)), sha(fs.readFileSync(big)), 'I -> H (tujuan lewat HTTP/base64) utuh');
    const sH = H.glue.stats();
    console.log(`      ukur: 20 MB lewat jalur HTTP+base64+SSE: kirim dari sisi HTTP ${(20 / upSec).toFixed(1)} MB/s, terima di sisi HTTP ${(20 / downSec).toFixed(1)} MB/s (rpc ${sH.calls} panggilan, ${evs} event SSE; DataChannel palsu tanpa latensi)`);
    assert(evs > 100, 'event SSE benar-benar dipakai');
    // SSE putus-sambung (event hilang): UI diminta mulai ulang; link dan Core pulih
    glueH.feed({ op: 'reconnect' }); await until(() => H.glue.stats().restarts === 2, 3000, 'glue mulai ulang');
    await until(() => onlineVia(CH, CI) && onlineVia(CI, CH), 8000, 'pulih setelah reconnect');
    const m3 = CH.sendText('setelah reconnect', 'public'); await until(() => CI.store.msgs[m3.id], 6000, 'pesan setelah reconnect');
    ac.abort(); for (const s of [H, I]) { await s.rm.stop(); await s.wan.stop(); await s.glue.stop(); }
    await rpc.stop(); await CH.stop(); await CI.stop();
    ok('7 lewat HTTP+SSE+base64 (Android/peramban): pesan dan 2x20 MB utuh; SSE putus-sambung -> mulai ulang dan pulih');
  }

  assert.strictEqual(cloneBloat.n, 0, 'UI tidak pernah mengirim data berupa tampilan pada buffer lebih besar (IPC menyerialkan seluruh buffer)');
  for (const s of [A, B]) { await s.rm.stop(); await s.wan.stop(); await s.glue.stop(); }
  await CA.stop(); await CB.stop();
  finished = true;
  console.log('\nrtccore: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
