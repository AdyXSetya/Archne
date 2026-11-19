'use strict';
// Tes rtcmux (mode lintas jaringan, langkah 3): multiplexing di atas DataChannel dan pengelola link WebRTC.
// A: createMux di atas channel palsu (bingkai, stream paralel, pesan besar, backpressure, keadilan, half-close, reset, pelanggaran protokol).
// B: createRtcMux dengan RTCPeerConnection palsu + bus sinyal palsu (aturan penawar, trickle ICE, sinyal jahat/basi, gagal ICE, backoff, bye, batas link, jalur).
// C: terpadu: dua Core asli + renderer/archne-wan.js + broker MQTT palsu + RTCPeerConnection palsu (sinyal benar-benar lewat wanSeal/wanOpen).
// Yang TIDAK terbukti di sini: penembusan NAT dan perilaku RTCDataChannel sungguhan (lihat uji manual di rencana).
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { createMux, createRtcMux, explain, DEFAULT_STUN, F_OPEN, F_DATA, F_FIN, F_RST } = require('../renderer/archne-rtcmux');
const { FakeNet, FakeDC, FakeBus } = require('./lib/fakertc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(5); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const cat = (arr) => Buffer.concat(arr.map((u) => Buffer.from(u)));

function chPair(net) { const a = new FakeDC(net, 'archne'), b = new FakeDC(net, 'archne'); a.remote = b; b.remote = a; a._open(); b._open(); return [a, b]; }
function watch(s) { // kumpulkan semua yang terjadi pada sebuah stream
  const w = { chunks: [], ended: false, closed: false, err: null, opened: false };
  s.on('data', (d) => w.chunks.push(Buffer.from(d))); s.on('end', () => { w.ended = true; }); s.on('close', () => { w.closed = true; });
  s.on('error', (e) => { w.err = e; }); s.on('open', () => { w.opened = true; });
  w.data = () => Buffer.concat(w.chunks);
  return w;
}
const frame = (id, flag, payload) => { const p = payload ? Buffer.from(payload) : Buffer.alloc(0); const f = Buffer.alloc(5 + p.length); f.writeUInt32BE(id, 0); f[4] = flag; p.copy(f, 5); return new Uint8Array(f); };

// Penjaga: Promise yang menunggu selamanya membuat event loop kosong dan Node keluar dengan kode 0 tanpa pesan. Itu BUKAN lulus.
let finished = false;
process.on('exit', (c) => { if (!finished && c === 0) { console.error('GAGAL: proses berakhir sebelum semua tes selesai (ada Promise yang menunggu selamanya)'); process.exitCode = 1; } });
setTimeout(() => { console.error('GAGAL: tes menggantung > 150 detik'); process.exit(1); }, 150000).unref();

(async () => {
  // =================================================================== A. multiplexing
  {
    const net = new FakeNet();

    // ---------- A1. bentuk bingkai dan paritas ID ----------
    const [ca, cb] = chPair(net);
    const A = createMux(ca, { initiator: true }), B = createMux(cb, { initiator: false });
    const inB = []; B.on('stream', (s) => inB.push(s));
    const s1 = A.open(); const w1 = s1.write('hi'); const fin1 = s1.end();
    await Promise.all([w1, fin1]);
    assert.deepStrictEqual(ca.sent.map((u) => Buffer.from(u).toString('hex')), ['0000000101', '000000010268' + '69', '0000000103'], 'OPEN, DATA("hi"), FIN pada stream 1');
    await until(() => inB.length === 1, 2000, 'B menerima stream');
    assert.strictEqual(inB[0].id, 1);
    const sB = B.open(); await sB.end();
    assert.strictEqual(sB.id, 2, 'sisi penjawab memakai ID genap');
    assert.strictEqual(F_OPEN, 1); assert.strictEqual(F_DATA, 2); assert.strictEqual(F_FIN, 3); assert.strictEqual(F_RST, 4);
    ok('bingkai: [id u32 BE][flag][payload]; penawar ganjil, penjawab genap');

    // ---------- A2. banyak stream paralel, masing-masing utuh ----------
    {
      const [a, b] = chPair(net); const MA = createMux(a, { initiator: true }), MB = createMux(b, { initiator: false });
      MB.on('stream', (s) => { s.on('data', (d) => s.write(Buffer.from(d))); s.on('end', () => s.end()); }); // gema
      const jobs = [];
      for (let i = 0; i < 25; i++) {
        const payload = crypto.randomBytes(2000 + i * 977), s = (i % 2 ? MA : MB).open(), w = watch(s);
        (i % 2 ? null : null);
        jobs.push({ payload, s, w, via: i % 2 ? 'A' : 'B' });
      }
      // stream yang dibuka B diterima A: A harus menggemakan juga
      MA.on('stream', (s) => { s.on('data', (d) => s.write(Buffer.from(d))); s.on('end', () => s.end()); });
      for (const j of jobs) { j.s.write(j.payload); j.s.end(); }
      await until(() => jobs.every((j) => j.w.closed), 6000, 'semua stream paralel selesai');
      for (const j of jobs) { assert(j.w.data().equals(j.payload), 'isi stream utuh'); assert(!j.w.err); }
      const ids = jobs.map((j) => j.s.id); assert.strictEqual(new Set(ids).size, ids.length, 'ID unik');
      assert(jobs.filter((j) => j.via === 'A').every((j) => j.s.id % 2 === 1) && jobs.filter((j) => j.via === 'B').every((j) => j.s.id % 2 === 0));
      assert.strictEqual(MA.size(), 0); assert.strictEqual(MB.size(), 0, 'semua stream dibersihkan');
    }
    ok('25 stream paralel dua arah (gema) utuh, ID unik, tidak ada yang tersisa');

    // ---------- A3. pesan besar dipecah ----------
    {
      const [a, b] = chPair(net); const MA = createMux(a, { initiator: true }), MB = createMux(b, { initiator: false });
      let got; MB.on('stream', (s) => { got = watch(s); });
      const big = crypto.randomBytes(1024 * 1024 + 123), s = MA.open();
      await s.write(big); await s.end();
      await until(() => got && got.ended, 6000, 'B menerima semua');
      assert(got.data().equals(big), 'isi 1 MiB utuh');
      assert(a.sent.every((u) => u.length <= 16 * 1024 + 5), 'tiap bingkai <= 16 KiB + header');
      assert(a.sent.filter((u) => u[4] === F_DATA).length >= 64, 'dipecah menjadi banyak bingkai');
      assert.strictEqual(sha(got.data()), sha(big));
    }
    ok('pesan 1 MiB dipecah <= 16 KiB per bingkai dan tersusun kembali byte demi byte');

    // ---------- A4. backpressure ----------
    {
      const [a, b] = chPair(net); const MA = createMux(a, { initiator: true, high: 64 * 1024, low: 16 * 1024 }), MB = createMux(b, { initiator: false });
      let got; MB.on('stream', (s) => { got = watch(s); });
      net.paused = true;
      const big = crypto.randomBytes(2 * 1024 * 1024), s = MA.open();
      let done = false; const wp = s.write(big).then(() => { done = true; });
      await sleep(60);
      assert(!done, 'write() belum selesai selagi channel macet');
      assert(a.bufferedAmount <= 64 * 1024 + 16 * 1024 + 5, 'bufferedAmount tidak melewati high + satu bingkai: ' + a.bufferedAmount);
      const sentWhilePaused = a.sent.length;
      await sleep(60); assert.strictEqual(a.sent.length, sentWhilePaused, 'tidak ada pengiriman tambahan selagi macet');
      net.paused = false; a.resume();
      await wp; await s.end();
      await until(() => got && got.ended, 8000, 'B menerima semuanya setelah lancar');
      assert(got.data().equals(big), 'isi utuh setelah backpressure');
      assert(a.maxBuffered <= 64 * 1024 + 16 * 1024 + 5, 'puncak bufferedAmount selama transfer: ' + a.maxBuffered);
    }
    ok('backpressure: bufferedAmount dibatasi high (+1 bingkai), write() tertahan sampai channel lancar, lanjut lewat bufferedamountlow, isi utuh');

    // ---------- A5. keadilan antar stream ----------
    {
      const [a, b] = chPair(net); const MA = createMux(a, { initiator: true, high: 32 * 1024, low: 8 * 1024 }), MB = createMux(b, { initiator: false });
      const order = []; MB.on('stream', (s) => { s.on('data', () => order.push(s.id)); });
      const big = MA.open(), small = MA.open();
      const bw = big.write(crypto.randomBytes(1024 * 1024)); small.write('ping');
      await bw;
      const firstSmall = order.indexOf(small.id), bigFrames = order.filter((x) => x === big.id).length;
      assert(firstSmall >= 0 && firstSmall <= 4, 'stream kecil tiba di antara 5 bingkai pertama, bukan menunggu stream besar: indeks ' + firstSmall);
      assert(bigFrames >= 60);
    }
    ok('keadilan: stream kecil tidak menunggu stream 1 MiB selesai (bergiliran per bingkai)');

    // ---------- A6. half-close ----------
    {
      const [a, b] = chPair(net); const MA = createMux(a, { initiator: true }), MB = createMux(b, { initiator: false });
      let wb; MB.on('stream', (s) => { wb = watch(s); s.on('end', async () => { await s.write('balasan'); await s.end(); }); });
      const s = MA.open(), wa = watch(s);
      await s.write('tanya'); await s.end();
      await assert.rejects(() => s.write('lagi'), /di-end/, 'tulis setelah end ditolak');
      await until(() => wa.closed && wb.closed, 3000, 'kedua sisi tertutup');
      assert.strictEqual(wb.data().toString(), 'tanya'); assert.strictEqual(wa.data().toString(), 'balasan');
      assert(wa.ended && wb.ended && !wa.err && !wb.err, 'penutupan rapi tanpa galat');
    }
    ok('half-close: satu sisi end, sisi lain masih bisa membalas; tutup rapi bila keduanya selesai; tulis setelah end ditolak');

    // ---------- A7. reset ----------
    {
      const [a, b] = chPair(net); const MA = createMux(a, { initiator: true, high: 32 * 1024, low: 8 * 1024 }), MB = createMux(b, { initiator: false });
      let wb; MB.on('stream', (s) => { wb = watch(s); });
      const s = MA.open(), wa = watch(s);
      await s.write('awal'); await until(() => wb && wb.data().length === 4, 2000, 'awal tiba');
      net.paused = true;
      const pend = s.write(crypto.randomBytes(500000)); const pendErr = pend.catch((e) => e);
      await sleep(20);
      s.destroy(new Error('batal'));
      assert((await pendErr).message === 'batal', 'write tertunda ditolak dengan alasan yang sama');
      assert(wa.closed && wa.err.message === 'batal');
      net.paused = false; a.resume();
      await until(() => wb.closed, 3000, 'B melihat RST');
      assert(/reset/.test(wb.err.message), 'sisi lawan: galat reset');
      assert.strictEqual(MB.size(), 0);
      // DATA/FIN terlambat untuk stream yang sudah ditutup: diabaikan, tidak dibalas (tidak ada badai RST)
      const before = b.sent.length;
      a.send(frame(s.id, F_DATA, 'telat')); a.send(frame(s.id, F_FIN)); a.send(frame(s.id, F_RST));
      await sleep(40);
      assert.strictEqual(b.sent.length, before, 'tidak ada balasan untuk bingkai terlambat'); assert(MB.isOpen(), 'link tetap hidup');
      // stream yang dibatalkan sebelum OPEN terkirim tidak memunculkan apa pun di sisi lawan
      net.paused = true; const z = MA.open(); const zw = z.write('x').catch(() => {}); z.destroy(); net.paused = false; a.resume(); await zw; await sleep(30);
      assert.strictEqual(MB.size(), 0, 'stream yang dibatalkan sebelum terkirim tidak pernah muncul di lawan');
    }
    ok('reset: write tertunda ditolak, lawan melihat reset, bingkai terlambat diabaikan tanpa balasan, batal sebelum OPEN tidak terkirim');

    // ---------- A8. channel mati di tengah stream ----------
    {
      const [a, b] = chPair(net); const MA = createMux(a, { initiator: true, high: 32 * 1024, low: 8 * 1024 }), MB = createMux(b, { initiator: false });
      const wbs = []; MB.on('stream', (s) => wbs.push(watch(s)));
      const s1 = MA.open(), s2 = MA.open(), w1 = watch(s1), w2 = watch(s2);
      await s1.write('a'); await s2.write('b'); await until(() => wbs.length === 2, 2000, 'dua stream');
      net.paused = true; const pend = s1.write(crypto.randomBytes(300000)).catch((e) => e);
      let closeEv = 0, closeErr = null; MA.on('close', (e) => { closeEv++; closeErr = e; });
      b.close(); // lawan menutup channel
      await until(() => w1.closed && w2.closed && wbs.every((w) => w.closed), 3000, 'semua stream tertutup');
      assert(w1.err && w2.err, 'semua stream mendapat galat'); assert((await pend) instanceof Error, 'write tertunda ditolak');
      assert.strictEqual(closeEv, 1, 'mux memancarkan close tepat sekali'); assert(closeErr);
      assert.throws(() => MA.open(), /ditutup/, 'open setelah link mati melempar');
      assert(!MA.isOpen());
      net.paused = false;
    }
    ok('channel terputus di tengah stream: semua stream dan write tertunda gagal dengan galat, close sekali, open berikutnya ditolak');

    // ---------- A9. pelanggaran protokol ----------
    const violate = async (name, send, opt) => {
      const [a, b] = chPair(net); const MB = createMux(b, Object.assign({ initiator: false }, opt || {}));
      let closed = null; MB.on('close', (e) => { closed = e || true; });
      let n = 0; MB.on('stream', () => n++);
      send(a); await sleep(25);
      assert(closed, 'link ditutup karena: ' + name); assert(!MB.isOpen());
    };
    await violate('pesan string', (a) => a.send('halo'));
    await violate('bingkai < header', (a) => a.send(new Uint8Array(3)));
    await violate('flag tidak dikenal', (a) => a.send(frame(1, 9)));
    await violate('flag 0', (a) => a.send(frame(1, 0)));
    await violate('OPEN ID 0', (a) => a.send(frame(0, F_OPEN)));
    await violate('OPEN dengan ID milik sisi sendiri (genap untuk penjawab)', (a) => a.send(frame(2, F_OPEN)));
    await violate('OPEN ID mundur/berulang', (a) => { a.send(frame(3, F_OPEN)); a.send(frame(1, F_OPEN)); });
    await violate('OPEN ID sama dua kali', (a) => { a.send(frame(1, F_OPEN)); a.send(frame(1, F_OPEN)); });
    await violate('OPEN membawa data', (a) => a.send(frame(1, F_OPEN, 'x')));
    await violate('FIN membawa data', (a) => { a.send(frame(1, F_OPEN)); a.send(frame(1, F_FIN, 'x')); });
    await violate('bingkai melebihi recvMax', (a) => { a.send(frame(1, F_OPEN)); a.send(frame(1, F_DATA, Buffer.alloc(2000))); }, { recvMax: 1024 });
    {
      const [a, b] = chPair(net); const MB = createMux(b, { initiator: false }); const recv = []; a.onmessage = (e) => recv.push(Buffer.from(e.data));
      let w; MB.on('stream', (s) => { w = watch(s); });
      a.send(frame(1, F_OPEN)); a.send(frame(1, F_FIN)); a.send(frame(1, F_DATA, 'x'));
      await sleep(30);
      assert(MB.isOpen(), 'DATA setelah FIN hanya me-reset stream itu, link tetap hidup');
      assert(w.closed && /FIN/.test(w.err.message));
      assert(recv.some((f) => f.readUInt32BE(0) === 1 && f[4] === F_RST), 'lawan diberi RST');
    }
    {
      const [a, b] = chPair(net); const MB = createMux(b, { initiator: false, maxStreams: 2 }); const recv = []; a.onmessage = (e) => recv.push(Buffer.from(e.data));
      const got = []; MB.on('stream', (s) => got.push(s.id));
      a.send(frame(1, F_OPEN)); a.send(frame(3, F_OPEN)); a.send(frame(5, F_OPEN));
      await sleep(30);
      assert.deepStrictEqual(got, [1, 3], 'stream ke-3 melebihi batas tidak diteruskan');
      assert(recv.some((f) => f.readUInt32BE(0) === 5 && f[4] === F_RST), 'stream kelebihan ditolak dengan RST'); assert(MB.isOpen());
      const MA2 = createMux(chPair(net)[0], { initiator: true, maxStreams: 1 }); MA2.open(); assert.throws(() => MA2.open(), /terlalu banyak/, 'batas stream sisi sendiri');
    }
    ok('pelanggaran protokol: 11 jenis menutup link tanpa melempar; DATA setelah FIN hanya me-reset stream; stream di atas batas ditolak dengan RST');
  }

  // =================================================================== B. pengelola link
  const A = '1111111111111111', B = '2222222222222222', C = '3333333333333333', D = '4444444444444444';
  function world(ids, per) {
    const net = new FakeNet(), bus = new FakeBus(), w = { net, bus, wan: {}, rm: {}, events: {}, incoming: {} };
    for (const id of ids) {
      const node = bus.node(id); w.wan[id] = node; w.events[id] = []; w.incoming[id] = [];
      const o = Object.assign({ wan: node, RTCPeerConnection: net.rtc(id), connectTimeoutMs: 400, disconnectGraceMs: 60, backoffMs: [40, 80], byeCooldownMs: 600, sendTimeoutMs: 500 }, (per && per[id]) || {});
      w.rm[id] = createRtcMux(o);
      w.rm[id].on('link', (e) => w.events[id].push(e));
      w.rm[id].on('stream', (s, from) => w.incoming[id].push({ s, from }));
    }
    w.presence = (map) => { for (const id of ids) w.wan[id].setPeers((map ? map[id] : ids.filter((x) => x !== id))); };
    w.open = (id, peer) => w.rm[id].links().some((l) => l.peerId === peer && l.state === 'open');
    w.echo = (id) => w.rm[id].on('stream', (s) => { s.on('data', (d) => s.write(Buffer.from(d))); s.on('end', () => s.end()); });
    return w;
  }
  async function roundtrip(rm, peer, text) {
    const s = await rm.openStream(peer), wt = watch(s);
    await s.write(text); await s.end();
    await until(() => wt.closed, 3000, 'gema ' + text);
    return wt.data().toString();
  }

  // ---------- B1. aturan penawar + stream dua arah ----------
  {
    const w = world([A, B]); w.echo(A); w.echo(B);
    w.bus.latency = (from, to, b) => ((b.k === 'offer' || b.k === 'answer') ? 25 : 0); // offer/answer lambat dikirim: tanpa serialisasi, ICE-nya akan menyalip
    w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'A dan B tersambung otomatis');
    for (const [from, kind] of [[A, 'offer'], [B, 'answer']]) {
      const iD = w.bus.log.findIndex((m) => m.from === from && m.body.k === kind);
      assert(iD >= 0 && w.bus.log.slice(0, iD).every((m) => !(m.from === from && m.body.k === 'ice')), 'tidak ada ICE ' + from.slice(0, 1) + ' yang sampai ke broker sebelum ' + kind + '-nya (pengiriman sinyal diserialkan)');
    }
    const offers = w.bus.log.filter((m) => m.body.k === 'offer'), answers = w.bus.log.filter((m) => m.body.k === 'answer');
    assert(offers.length === 1 && offers[0].from === A, 'hanya ID yang lebih kecil membuat offer');
    assert(answers.length === 1 && answers[0].from === B);
    const iA = w.bus.log.findIndex((m) => m.body.k === 'offer'); assert(w.bus.log.slice(0, iA).every((m) => m.from !== A), 'tidak ada sinyal A sebelum offer');
    assert(w.bus.log.filter((m) => m.from === A && m.body.k === 'ice').every((m) => m.body.cid === offers[0].body.cid), 'ICE membawa cid percobaan');
    assert(w.bus.log.filter((m) => m.body.k === 'ice').length >= 2, 'trickle: kandidat dikirim terpisah dari offer');
    assert.strictEqual(await roundtrip(w.rm[A], B, 'dari A'), 'dari A');
    assert.strictEqual(await roundtrip(w.rm[B], A, 'dari B'), 'dari B');
    assert(w.incoming[B].every((x) => x.from === A && x.s.id % 2 === 1) && w.incoming[A].every((x) => x.from === B && x.s.id % 2 === 0), 'stream masuk menyebut peer asal; ID sesuai peran');
    assert.strictEqual(w.net.created, 2, 'tepat satu RTCPeerConnection per sisi');
    assert(w.events[A].some((e) => e.state === 'connecting') && w.events[A].some((e) => e.state === 'open' && e.peerId === B));
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B1 aturan penawar: ID kecil membuat offer, ICE trickle mengikuti offer, satu pc per sisi, stream mengalir dua arah dengan ID sesuai peran');

  // ---------- B2. urutan sinyal terbalik (ICE mendahului offer/answer) ----------
  {
    const w = world([A, B]); w.echo(B);
    w.bus.filter = (from, to, b) => ((b.k === 'offer' || b.k === 'answer') ? 70 : 0); // ICE melewati offer/answer di jalan
    w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung walau ICE tiba lebih dulu');
    const pcB = [...w.net.pcs.values()].find((p) => p.name === B), pcA = [...w.net.pcs.values()].find((p) => p.name === A);
    assert(pcB.addedCands.length >= 2 && pcA.addedCands.length >= 2, 'kandidat yang tiba duluan tetap dipasang setelah remote description');
    assert.strictEqual(await roundtrip(w.rm[A], B, 'x'), 'x');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B2 ICE tiba sebelum offer/answer: disimpan lalu dipasang; addIceCandidate tidak pernah dipanggil sebelum remote description');

  // ---------- B3. sinyal jahat, basi, atau salah peran ----------
  {
    const w = world([A, B]);
    w.presence(); // tidak ada peer yang auto-connect? (A akan offer ke B) -> matikan dulu
    await w.rm[A].stop(); await w.rm[B].stop();
    const w2 = world([A, B], { [A]: { autoConnect: false }, [B]: { autoConnect: false } });
    w2.presence();
    const inj = (to, from, body) => w2.wan[to].deliver(from, body);
    const SDP = 'v=0\r\nfake-pc 999', CID = 'abcdefabcdefabcd';
    // A: offer dari B (B lebih besar) = salah peran; answer tak diminta; ice tanpa link; want dari B (A penawar: sah, tapi ditolak oleh batas di bawah)
    inj(A, B, { k: 'offer', cid: CID, sdp: SDP }); inj(A, B, { k: 'answer', cid: CID, sdp: SDP });
    // B: offer dari A tapi cid/sdp rusak; offer dengan SDP terlalu besar; want dari A (B bukan penawar); bye/reject tanpa link
    for (const bad of [{ k: 'offer', cid: 'XYZ', sdp: SDP }, { k: 'offer', cid: CID, sdp: 'bukan sdp' }, { k: 'offer', cid: CID, sdp: 'v=0\r\n' + 'a'.repeat(20000) }, { k: 'offer', cid: 5, sdp: SDP }, { k: 'offer' }]) inj(B, A, bad);
    inj(B, A, { k: 'want', last: null }); inj(B, A, { k: 'bye', cid: 'cccccccccccccccc' }); inj(B, A, { k: 'reject', cid: 'cccccccccccccccc', why: 'busy' });
    for (const bad of [{ k: 'ice', cid: CID, c: { candidate: 'x'.repeat(600) } }, { k: 'ice', cid: CID, c: { candidate: 'c', sdpMLineIndex: 99 } }, { k: 'ice', cid: CID, c: 'str' }, { k: 'ice', cid: 'zz', c: { candidate: 'c' } }, { k: 'ice' }, { k: '???' }, { k: 'want', last: 'zz' }, {}]) { inj(A, B, bad); inj(B, A, bad); }
    for (const weird of [null, undefined, 5, 'str', []]) { try { w2.wan[A].deliver(B, weird); w2.wan[B].deliver('zz', { k: 'offer' }); } catch (e) { assert.fail('deliver tidak boleh melempar: ' + e.message); } }
    await sleep(80);
    assert.strictEqual(w2.net.created, 0, 'tidak ada RTCPeerConnection yang dibuat oleh sinyal tidak sah');
    assert.deepStrictEqual(w2.rm[A].links(), []); assert.deepStrictEqual(w2.rm[B].links(), []);
    assert.strictEqual(w2.bus.log.length, 0, 'tidak ada balasan atas sinyal tidak sah');
    await Promise.all([w2.rm[A].stop(), w2.rm[B].stop()]);
  }
  {
    const w = world([A, B]); w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung');
    const cid = w.rm[A].links()[0].cid, pcB = [...w.net.pcs.values()].find((p) => p.name === B);
    const n0 = pcB.addedCands.length;
    for (const c of [{ candidate: 'x'.repeat(600) }, { candidate: 'c', sdpMLineIndex: 99 }, { candidate: 'c', sdpMid: 5 }, 'str', null, { candidate: 7 }]) w.wan[B].deliver(A, { k: 'ice', cid, c });
    w.wan[B].deliver(A, { k: 'ice', cid: 'ffffffffffffffff', c: { candidate: 'candidate:9 1 udp 1 1.1.1.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } }); // cid lain
    await sleep(50); assert.strictEqual(pcB.addedCands.length, n0, 'kandidat rusak atau ber-cid lain tidak pernah sampai ke addIceCandidate');
    const good = { candidate: 'candidate:9 1 udp 1 1.1.1.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0, extra: 'dibuang', usernameFragment: 'uf' };
    w.wan[B].deliver(A, { k: 'ice', cid, c: good }); await until(() => pcB.addedCands.length === n0 + 1, 1000, 'kandidat sah dipasang');
    assert.deepStrictEqual(pcB.addedCands[n0], { candidate: good.candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'uf' }, 'hanya bidang yang dikenal yang diteruskan ke pc');
    for (let i = 0; i < 100; i++) w.wan[B].deliver(A, { k: 'ice', cid, c: { candidate: 'candidate:' + i, sdpMid: '0', sdpMLineIndex: 0 } });
    await sleep(60); assert(pcB.addedCands.length <= 70, 'jumlah kandidat per percobaan dibatasi: ' + pcB.addedCands.length);
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B3b pada link hidup: kandidat rusak, ber-cid lain, atau berlebih tidak sampai ke pc; kandidat sah diteruskan hanya dengan bidang yang dikenal');
  ok('B3 sinyal tidak sah (salah peran, cid/sdp/kandidat rusak, terlalu besar, tanpa link, bentuk aneh) dibuang diam-diam: tak ada pc, tak ada balasan, tak melempar');

  // ---------- B4. answer dengan cid lain tidak diterima ----------
  {
    const w = world([A, B]);
    w.bus.filter = (from, to, b) => (b.k === 'answer' ? null : 0); // jawaban asli dijatuhkan
    w.presence();
    await until(() => w.bus.log.some((m) => m.body.k === 'offer'), 2000, 'offer terkirim');
    w.wan[A].deliver(B, { k: 'answer', cid: 'ffffffffffffffff', sdp: 'v=0\r\nfake-pc 2' }); // cid palsu
    const ev = w.events[A]; await until(() => ev.some((e) => e.state === 'failed'), 2000, 'A gagal timeout');
    const f = ev.find((e) => e.state === 'failed');
    assert.strictEqual(f.reason, 'timeout', 'tanpa answer sah, kegagalannya timeout (bukan ice-failed)'); assert(/tidak menjawab/.test(f.explain));
    const pcA = [...w.net.pcs.values()].find((p) => p.name === A); assert.strictEqual(pcA.remoteDescription, null, 'answer ber-cid salah tidak pernah dipasang');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B4 answer ber-cid salah dibuang; tanpa answer sah percobaan berakhir "timeout"');

  // ---------- B5. ICE gagal: alasan jelas, retry dengan backoff, pulih ----------
  {
    const w = world([A, B]); w.echo(B);
    w.net.blocked = true;
    const p = w.rm[A].connect.bind(w.rm[A]);
    w.presence();
    await until(() => w.events[A].some((e) => e.state === 'failed'), 3000, 'gagal');
    const f = w.events[A].find((e) => e.state === 'failed');
    assert.strictEqual(f.reason, 'ice-failed'); assert(/TURN/.test(f.explain) && /langsung/.test(f.explain), 'pesan menyebut perlu TURN');
    const c1 = w.net.created;
    await until(() => w.net.created >= c1 + 2, 3000, 'percobaan ulang berjalan (backoff)');
    assert(w.events[A].filter((e) => e.state === 'connecting').length >= 2, 'link dilaporkan menyambung lagi');
    w.net.blocked = false;
    await until(() => w.open(A, B) && w.open(B, A), 6000, 'pulih setelah jaringan membaik');
    assert.strictEqual(await roundtrip(w.rm[A], B, 'pulih'), 'pulih');
    // peer offline -> retry berhenti
    w.net.blocked = true; w.rm[A].close(B); await sleep(30);
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  {
    const w = world([A, B]); w.net.blocked = true;
    w.presence(); await until(() => w.events[A].some((e) => e.state === 'failed'), 3000, 'gagal');
    w.wan[A].setPeers([]); w.wan[B].setPeers([]); // B hilang dari presence
    await sleep(60); const created = w.net.created; await sleep(400);
    assert.strictEqual(w.net.created, created, 'peer offline: tidak ada percobaan ulang');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B5 ICE gagal -> alasan "ice-failed" + penjelasan butuh TURN; retry dengan backoff; pulih sendiri; berhenti bila peer offline');

  // ---------- B6. penjawab ingin menyambung (want), timeout, dan offline ----------
  {
    const w = world([A, B], { [A]: { autoConnect: false }, [B]: { autoConnect: false } });
    w.echo(A); w.presence();
    await sleep(40); assert.strictEqual(w.net.created, 0, 'autoConnect mati: tidak ada yang menyambung sendiri');
    const lk = await w.rm[B].connect(A); // B penjawab -> mengirim want -> A membuat offer
    assert.strictEqual(lk.state, 'open'); assert(w.bus.log.some((m) => m.from === B && m.body.k === 'want' && m.body.last === null), 'B mengirim want');
    assert(w.bus.log.filter((m) => m.body.k === 'offer').every((m) => m.from === A), 'offer tetap dari A');
    assert.strictEqual(await roundtrip(w.rm[B], A, 'lewat want'), 'lewat want');
    assert.strictEqual(w.net.created, 2);
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  {
    const w = world([A, B], { [B]: { autoConnect: false, connectTimeoutMs: 200 } });
    w.presence();
    w.bus.filter = (from, to) => (to === A ? null : 0); // A tidak pernah menerima apa pun
    await w.rm[A].stop();
    await assert.rejects(() => w.rm[B].connect(A), (e) => e.reason === 'timeout' && /tidak menjawab/.test(e.message));
    await assert.rejects(() => w.rm[B].connect('9999999999999999'), (e) => e.reason === 'offline');
    await assert.rejects(() => w.rm[B].connect('zz'), (e) => e.reason === 'offline');
    assert.deepStrictEqual(w.rm[B].links(), [], 'tidak ada sisa link setelah gagal');
    await w.rm[B].stop();
    await assert.rejects(() => w.rm[B].connect(A), (e) => e.reason === 'stopped');
  }
  ok('B6 penjawab menyambung lewat want (offer tetap dari ID kecil); timeout, peer tak dikenal/offline, dan setelah stop ditolak dengan alasan jelas');

  // ---------- B7. link putus di tengah stream, lalu pulih ----------
  {
    const w = world([A, B]); w.echo(B); w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung');
    const s = await w.rm[A].openStream(B), wt = watch(s);
    await s.write('sebelum'); await sleep(20);
    const cid1 = w.rm[A].links()[0].cid;
    const pcA = [...w.net.pcs.values()].find((p) => p.name === A);
    const pend = s.write(crypto.randomBytes(4 * 1024 * 1024)).catch((e) => e);
    w.net.cut(pcA); // jaringan putus mendadak
    assert((await pend) instanceof Error, 'write tertunda gagal'); await until(() => wt.closed && wt.err, 2000, 'stream mati dengan galat');
    const down = w.events[A].find((e) => e.state === 'closed'); assert(down && /connection-lost|channel-closed/.test(down.reason), 'dilaporkan terputus: ' + (down && down.reason));
    await until(() => w.open(A, B) && w.open(B, A) && w.rm[A].links()[0].cid !== cid1, 6000, 'tersambung ulang otomatis dengan link baru');
    assert.strictEqual(await roundtrip(w.rm[A], B, 'sesudah'), 'sesudah');
    assert(wt.closed && s.closed, 'stream lama tetap mati (tidak hidup kembali)');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B7 jaringan putus mendadak: write dan stream gagal, link dilaporkan putus, tersambung ulang otomatis, stream baru jalan, stream lama tetap mati');

  // ---------- B8. koneksi hidup tidak bergantung presence; disconnected -> masa tenggang ----------
  {
    const w = world([A, B]); w.echo(B); w.presence();
    await until(() => w.open(A, B), 4000, 'tersambung');
    w.wan[A].setPeers([]); w.wan[B].setPeers([]); // broker putus: presence kosong
    await sleep(80);
    assert(w.open(A, B) && w.open(B, A), 'link yang sudah terbuka tidak ikut mati saat presence hilang');
    assert.strictEqual(await roundtrip(w.rm[A], B, 'tanpa broker'), 'tanpa broker');
    const pcA = [...w.net.pcs.values()].find((p) => p.name === A);
    pcA._state('disconnected'); await sleep(20); pcA._state('connected'); await sleep(120);
    assert(w.open(A, B), 'disconnected yang pulih dalam masa tenggang tidak memutus');
    pcA._state('disconnected'); await until(() => !w.open(A, B), 1000, 'disconnected terlalu lama memutus');
    assert(w.events[A].some((e) => e.state === 'closed' && e.reason === 'connection-lost'));
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  {
    const w = world([A, B]); w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung');
    const pcA = [...w.net.pcs.values()].find((p) => p.name === A);
    pcA.connectionState = undefined; pcA.iceConnectionState = 'failed'; pcA.oniceconnectionstatechange(); // WebView lama tanpa connectionState
    await until(() => !w.open(A, B), 1000, 'iceConnectionState failed memutus');
    assert(w.events[A].some((e) => e.state === 'closed' && e.reason === 'connection-lost'));
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B8 link terbuka bertahan walau presence broker hilang; "disconnected" sebentar ditoleransi, berkepanjangan memutus');

  // ---------- B9. batas sambungan ----------
  {
    const w = world([A, B, C], { [C]: { maxLinks: 1, backoffMs: [5000] }, [B]: { backoffMs: [5000] }, [A]: { backoffMs: [5000] } });
    w.presence({ [A]: [], [B]: [], [C]: [] }); // mulai kosong
    w.presence({ [A]: [C], [B]: [], [C]: [A] });
    await until(() => w.open(A, C) && w.open(C, A), 4000, 'A-C tersambung');
    w.presence({ [A]: [C], [B]: [C], [C]: [A, B] });
    await until(() => w.events[B].some((e) => e.state === 'failed'), 3000, 'B ditolak C');
    const f = w.events[B].find((e) => e.state === 'failed'); assert.strictEqual(f.reason, 'busy'); assert(/batas/.test(f.explain));
    assert(w.bus.log.some((m) => m.from === C && m.to === B && m.body.k === 'reject' && m.body.why === 'busy'));
    assert.strictEqual(w.rm[C].links().length, 1, 'C tetap satu link'); assert(w.open(A, C), 'link yang ada tidak terganggu');
    // sisi penawar juga menghormati batas
    const w2 = world([A, B, C], { [A]: { maxLinks: 1 } });
    w2.presence({ [A]: [B, C], [B]: [A], [C]: [A] });
    await sleep(300);
    assert.strictEqual(w2.rm[A].links().length, 1, 'A (penawar) tidak menyambung melewati batas'); assert.strictEqual(w2.net.created, 2);
    await Promise.all([w, w2].flatMap((x) => Object.values(x.rm)).map((r) => r.stop()));
  }
  ok('B9 batas sambungan: penjawab menolak dengan reject "busy" (penawar melapor gagal, link lama utuh); penawar tidak menyambung melewati batas');

  // ---------- B10. bye: penutupan sengaja tidak memicu sambung ulang ----------
  {
    const w = world([A, B]); w.echo(B); w.echo(A); w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung');
    const c = w.net.created;
    w.rm[A].close(B);
    await until(() => w.events[B].some((e) => e.state === 'closed') && w.bus.log.some((m) => m.from === A && m.body.k === 'bye'), 2000, 'B melihat link tertutup dan bye dikirim');
    assert(w.bus.log.findIndex((m) => m.body.k === 'bye') > w.bus.log.findIndex((m) => m.body.k === 'answer'), 'bye mengacu pada link yang berjalan');
    await sleep(300); // jauh lebih lama dari backoff (40 ms): tidak boleh ada percobaan baru selama jeda
    assert.strictEqual(w.net.created, c, 'tidak ada sambung ulang selama jeda bye'); assert(!w.open(A, B) && !w.open(B, A));
    // want OTOMATIS dari lawan (retry) selama jeda tidak dilayani; want eksplisit pengguna dilayani
    const offersBefore = w.bus.log.filter((m) => m.body.k === 'offer').length;
    w.wan[A].deliver(B, { k: 'want', last: null, auto: true }); await sleep(60);
    assert.strictEqual(w.bus.log.filter((m) => m.body.k === 'offer').length, offersBefore, 'want otomatis selama jeda diabaikan'); assert.strictEqual(w.net.created, c);
    const lk = await w.rm[A].connect(B); assert.strictEqual(lk.state, 'open', 'connect() eksplisit menembus jeda');
    assert.strictEqual(await roundtrip(w.rm[B], A, 'setelah bye'), 'setelah bye');
    w.rm[B].close(A); await sleep(50);
    // bye yang tiba SESUDAH channel terlihat mati (urutan nyata) tetap membatalkan retry lawan: tidak ada 'want' otomatis menembus jeda
    assert(!w.bus.log.some((m) => m.body.auto === true), 'tidak ada want otomatis selama jeda bye');
    const lk2 = await w.rm[A].connect(B); assert.strictEqual(lk2.state, 'open', 'penawar yang ditinggal bye dapat menyambung lagi');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  {
    const w = world([A, B]); w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung');
    const cid = w.rm[A].links()[0].cid;
    w.wan[B].deliver(A, { k: 'bye', cid: 'ffffffffffffffff' }); await sleep(30); assert(w.open(B, A), 'bye ber-cid lain diabaikan');
    w.wan[B].deliver(A, { k: 'bye', cid });
    await until(() => w.events[B].some((e) => e.state === 'closed' && e.reason === 'remote-bye'), 2000, 'bye yang tiba lebih dulu menutup link dengan alasan remote-bye');
    await sleep(250); assert(!w.bus.log.some((m) => m.from === B && (m.body.k === 'want' || m.body.k === 'offer')), 'sisi yang diberi bye tidak memulai sambungan apa pun (A tidak tahu ada bye palsu, jadi wajar mencoba lagi sebagai penawar)');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B10 bye: lawan menutup tanpa mencoba lagi selama jeda (bye tiba sebelum maupun sesudah channel mati); connect() eksplisit dari sisi mana pun tetap bisa');

  // ---------- B11. jalur langsung / relay ----------
  for (const [pt, want] of [['host', 'direct'], ['srflx', 'direct'], ['relay', 'relay']]) {
    const w = world([A, B]); w.net.pathType = pt; w.presence();
    await until(() => w.rm[A].links().some((l) => l.path === want), 3000, 'jalur ' + want);
    assert(w.events[A].some((e) => e.state === 'open' && e.path === want) || w.events[A].some((e) => e.path === want));
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
  }
  ok('B11 jalur terpilih dibaca dari getStats: host/srflx = langsung, relay = lewat relay');

  // ---------- B12. konfigurasi ICE ----------
  {
    const seen = [];
    const w = world([A, B], { [A]: { iceServers: async () => { seen.push('A'); return [{ urls: 'turn:t.example:3478', username: 'u', credential: 'c' }]; } }, [B]: { iceServers: () => { throw new Error('gagal'); } } });
    w.presence(); await until(() => w.open(A, B), 4000, 'tersambung');
    const pcA = [...w.net.pcs.values()].find((p) => p.name === A), pcB = [...w.net.pcs.values()].find((p) => p.name === B);
    assert.deepStrictEqual(pcA.config.iceServers, [{ urls: 'turn:t.example:3478', username: 'u', credential: 'c' }]); assert.strictEqual(pcA.config.iceTransportPolicy, 'all');
    assert.deepStrictEqual(pcB.config.iceServers, DEFAULT_STUN, 'fungsi ICE yang gagal -> STUN bawaan, bukan putus');
    assert(pcB.config.iceServers.length > 0, 'mode lintas jaringan tidak pernah memakai iceServers kosong');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
    const w3 = world([A, B], { [A]: { iceServers: [{ urls: 'stun:x.example' }] } }); w3.presence();
    await until(() => w3.open(A, B), 4000, 'tersambung'); assert.deepStrictEqual([...w3.net.pcs.values()].find((p) => p.name === A).config.iceServers, [{ urls: 'stun:x.example' }]);
    await Promise.all([w3.rm[A].stop(), w3.rm[B].stop()]);
  }
  ok('B12 iceServers: larik atau fungsi (async) per koneksi; galat -> STUN bawaan; iceTransportPolicy "all"');

  // ---------- B13. stop() ----------
  {
    const w = world([A, B]); w.presence(); await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung');
    const s = await w.rm[A].openStream(B), wt = watch(s);
    await w.rm[A].stop();
    assert(wt.closed && wt.err, 'stream ditutup saat stop'); assert.deepStrictEqual(w.rm[A].links(), []);
    await until(() => w.events[B].some((e) => e.state === 'closed') && w.bus.log.some((m) => m.from === A && m.body.k === 'bye'), 2000, 'B melihat link tertutup dan bye terkirim');
    const c = w.net.created; w.wan[A].setPeers([B]); w.wan[B].deliver(A, { k: 'want', last: null }); await sleep(100);
    assert.strictEqual(w.net.created, c, 'setelah stop tidak ada yang memulai koneksi baru');
    await w.rm[B].stop();
  }
  ok('B13 stop(): stream ditutup, lawan diberi bye, tidak ada koneksi baru sesudahnya');

  // ---------- B14. want basi / want saat offer berjalan ----------
  {
    const w = world([A, B]); w.presence();
    await until(() => w.open(A, B) && w.open(B, A), 4000, 'tersambung');
    const cid = w.rm[A].links()[0].cid, c0 = w.net.created;
    w.wan[A].deliver(B, { k: 'want', last: 'eeeeeeeeeeeeeeee' }); w.wan[A].deliver(B, { k: 'want', last: null });
    await sleep(80); assert.strictEqual(w.net.created, c0, 'want yang merujuk link lain/kosong tidak mematikan link yang sehat'); assert(w.open(A, B));
    w.wan[A].deliver(B, { k: 'want', last: cid }); // B menyatakan link yang SAMA sudah mati: A memulai ulang
    await until(() => w.net.created === c0 + 2 && w.open(A, B) && w.open(B, A) && w.rm[A].links()[0].cid !== cid, 4000, 'want yang cocok memulai ulang');
    await Promise.all([w.rm[A].stop(), w.rm[B].stop()]);
    // offer sedang berjalan (answer ditahan): want tidak memicu offer kedua
    const w2 = world([A, B]); w2.bus.filter = (f, t, b) => (b.k === 'answer' ? 150 : 0); w2.presence();
    await until(() => w2.bus.log.some((m) => m.body.k === 'offer'), 2000, 'offer berjalan');
    w2.wan[A].deliver(B, { k: 'want', last: null }); w2.wan[A].deliver(B, { k: 'want', last: null });
    await until(() => w2.open(A, B) && w2.open(B, A), 4000, 'tersambung');
    assert.strictEqual(w2.bus.log.filter((m) => m.body.k === 'offer').length, 1, 'tepat satu offer'); assert.strictEqual(w2.net.created, 2);
    await Promise.all([w2.rm[A].stop(), w2.rm[B].stop()]);
  }
  ok('B14 want: yang basi atau kosong tidak mematikan link sehat; yang cocok memulai ulang; saat offer berjalan tidak memicu offer kedua');

  // ---------- B15. stream masuk tanpa pendengar ----------
  {
    const net = new FakeNet(), bus = new FakeBus(), nA = bus.node(A), nB = bus.node(B);
    const ra = createRtcMux({ wan: nA, RTCPeerConnection: net.rtc(A), backoffMs: [40] }), rb = createRtcMux({ wan: nB, RTCPeerConnection: net.rtc(B), backoffMs: [40] }); // rb tanpa pendengar 'stream'
    nA.setPeers([B]); nB.setPeers([A]);
    await until(() => ra.links().some((l) => l.state === 'open') && rb.links().some((l) => l.state === 'open'), 4000, 'tersambung');
    const s = await ra.openStream(B), wt = watch(s); await s.write('halo').catch(() => {});
    await until(() => wt.closed, 2000, 'stream ditolak lawan');
    assert(wt.err && /reset/.test(wt.err.message), 'stream tanpa pendengar di-reset, tidak menggantung');
    assert(ra.links()[0].state === 'open', 'link tetap hidup');
    await Promise.all([ra.stop(), rb.stop()]);
  }
  ok('B15 stream masuk tanpa pendengar di-reset (tidak menggantung), link tetap hidup');

  // =================================================================== C. terpadu dengan Core + archne-wan.js asli
  {
    const { Core } = require('../src/archne-core');
    const { register } = require('../src/archne-ipc');
    const { createWan } = require('../renderer/archne-wan');
    const { FakeBroker } = require('./lib/fakemqtt');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-rtcmux-'));
    const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
    const apiOf = (core) => { const h = {}; register({ ipcMain: { handle: (n, fn) => { h[n] = fn; } }, core, shell: {}, send: () => {}, log: () => {}, pickFiles: async () => [] }); return new Proxy({}, { get: (_t, n) => (...a) => Promise.resolve(h[n]({}, ...a)) }); };
    const CA = mk('A'), CB = mk('B'), CX = mk('X');
    for (const c of [CA, CB, CX]) await c.start();
    const code = CA.wanNewCode(); CA.wanSetCode(code); CB.wanSetCode(code); CX.wanSetCode(CA.wanNewCode());
    const br = new FakeBroker(), net = new FakeNet();
    const mkSide = (core, nm) => {
      const wan = createWan({ api: apiOf(core), mqtt: br.mqtt });
      const rm = createRtcMux({ wan, RTCPeerConnection: net.rtc(nm), connectTimeoutMs: 3000, backoffMs: [50, 100] });
      return { core, wan, rm };
    };
    const sa = mkSide(CA, 'A'), sb = mkSide(CB, 'B'), sx = mkSide(CX, 'X');
    // penawar = ID lebih kecil; urutkan agar tes tidak bergantung pada ID acak
    sb.rm.on('stream', (s) => { s.on('data', (d) => s.write(Buffer.from(d))); s.on('end', () => s.end()); });
    sa.rm.on('stream', (s) => { s.on('data', (d) => s.write(Buffer.from(d))); s.on('end', () => s.end()); });
    await Promise.all([sa.wan.start({ broker: 'wss://broker.test/mqtt', name: 'A' }), sb.wan.start({ broker: 'wss://broker.test/mqtt', name: 'B' }), sx.wan.start({ broker: 'wss://broker.test/mqtt', name: 'X' })]);
    const linked = (x, y) => x.rm.links().some((l) => l.peerId === y.core.id && l.state === 'open');
    await until(() => linked(sa, sb) && linked(sb, sa), 8000, 'A dan B tersambung lewat sinyal terenkripsi Core');
    assert.strictEqual(await roundtrip(sa.rm, CB.id, 'lewat broker palsu'), 'lewat broker palsu');
    assert.strictEqual(await roundtrip(sb.rm, CA.id, 'arah sebaliknya'), 'arah sebaliknya');
    assert.strictEqual(net.created, 2, 'X (kode lain) tidak ikut terhubung'); assert.deepStrictEqual(sx.rm.links(), []);
    const sig = br.log.filter((m) => m.topic.includes('/s/'));
    assert(sig.length >= 3, 'offer, answer, dan ICE lewat broker'); assert(sig.every((m) => !m.retain && !/v=0|candidate|fake-pc|offer|answer/.test(m.payload)), 'broker hanya melihat byte opak, bukan SDP/kandidat');
    // X menyuntikkan sinyal palsu ke kotak masuk B: dibuang Core, rtcmux tidak pernah melihatnya
    const c0 = net.created, ev = []; sb.rm.on('link', (e) => ev.push(e));
    const inbox = sig.find((m) => m.topic.endsWith('/s/' + CB.id)).topic;
    const forged = await CX.wanSeal('signal', CB.id, { k: 'offer', cid: 'abcdefabcdefabcd', sdp: 'v=0\r\nfake-pc 1' });
    br._deliver(inbox, forged && forged.payload ? forged.payload : 'sampah', false, null);
    br._deliver(inbox, 'bukan-bungkus', false, null);
    await sleep(120); assert.strictEqual(net.created, c0); assert.strictEqual(ev.length, 0, 'sinyal dari jaringan/kode lain tidak berefek');
    for (const s of [sa, sb, sx]) { await s.rm.stop(); await s.wan.stop(); }
    for (const c of [CA, CB, CX]) await c.stop();
  }
  ok('C terpadu: dua Core asli menyambung lewat archne-wan.js + broker palsu (SDP/ICE terenkripsi di broker), stream dua arah, sinyal dari kode lain dibuang');

  console.log('\n' + pass + ' tes lulus');
  finished = true;
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
