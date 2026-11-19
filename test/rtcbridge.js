'use strict';
// Tes jembatan Core <-> UI (mode lintas jaringan, langkah 4), tanpa Core: src/archne-rtcbridge.js diuji sebagai transport murni dengan "UI" palsu
// yang mengirim pesan protokol. Yang diuji: validasi pesan, epoch, kredit dua arah (jendela, ack, pause), pelanggaran, link naik/turun, idle.
const assert = require('assert');
const { createBridge, WINDOW, CHUNK, ACK_AT, RX_LIMIT, MAX_SOCKS } = require('../src/archne-rtcbridge');
const T = require('../src/archne-transport');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(3); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const EP = 'aaaaaaaaaaaaaaaa', P = '1111111111111111', Q = '2222222222222222';
const rnd = (n) => require('crypto').randomBytes(n);

function mk(o) {
  const out = [], links = [];
  const br = createBridge(Object.assign({ send: (m) => out.push(m), binary: true }, o));
  br.onLink((e) => links.push(e));
  const ui = (m) => br.feed(Object.assign({ e: br.epoch || EP }, m));
  const take = (op) => { const r = out.filter((m) => m.op === op); return r; };
  return { br, out, links, ui, take };
}
const up = (h, peer = P) => { assert(h.br.feed({ op: 'attach', e: EP }).ok); assert(h.ui({ op: 'link', peer, state: 'open' }).ok); };
const peerReq = (peer) => ({ ip: T.rtcAddr(peer), port: 1 });
const dataOf = (h, sid) => Buffer.concat(h.out.filter((m) => m.op === 'data' && m.sid === sid).map((m) => Buffer.from(m.d)));

let finished = false;
process.on('exit', (c) => { if (!finished && c === 0) { console.error('GAGAL: proses berakhir sebelum semua tes selesai'); process.exitCode = 1; } });
setTimeout(() => { console.error('GAGAL: tes menggantung'); process.exit(1); }, 60000).unref();

(async () => {
  // ---------- 1. validasi pesan dan epoch ----------
  {
    const h = mk();
    for (const bad of [null, undefined, 5, 'x', {}, { op: 5 }, []]) assert.strictEqual(h.br.feed(bad).ok === false || Array.isArray(bad), true, 'pesan bentuk salah: ' + JSON.stringify(bad));
    assert.strictEqual(h.br.feed({ op: 'link', e: EP, peer: P, state: 'open' }).stale, true, 'sebelum attach: basi');
    for (const e of [undefined, 'zz', EP + '0', 'AAAAAAAAAAAAAAAA', 5]) assert.strictEqual(h.br.feed({ op: 'attach', e }).ok, false);
    assert(h.br.feed({ op: 'attach', e: EP }).ok); assert(h.br.attached());
    assert.strictEqual(h.br.feed({ op: 'link', e: 'bbbbbbbbbbbbbbbb', peer: P, state: 'open' }).stale, true, 'epoch lain ditolak');
    assert.strictEqual(h.br.feed({ op: 'link', peer: P, state: 'open' }).stale, true, 'tanpa epoch ditolak');
    assert.strictEqual(h.ui({ op: 'tidak-ada' }).ok, false);
    for (const bad of [{ peer: 'zz', state: 'open' }, { peer: P, state: 'aneh' }, { peer: P + '0', state: 'open' }]) assert.strictEqual(h.ui(Object.assign({ op: 'link' }, bad)).ok, false);
    assert.strictEqual(h.br.feed(new Array(300).fill({ op: 'detach' })).ok, false, 'batch > 256 ditolak');
    assert(h.br.feed([{ op: 'link', e: EP, peer: P, state: 'open' }, { op: 'link', e: EP, peer: Q, state: 'open' }]).ok, 'batch diproses berurutan');
    assert.deepStrictEqual(h.br.links().map((l) => l.peerId).sort(), [P, Q]);
    assert.strictEqual(h.br.feed([{ op: 'link', e: EP, peer: P, state: 'closed' }, { op: 'x', e: EP }, { op: 'link', e: EP, peer: Q, state: 'closed' }]).ok, false, 'batch berhenti di pesan salah');
    assert.deepStrictEqual(h.br.links().map((l) => l.peerId), [Q], 'pesan sesudah yang salah tidak diproses');
    ok('1 validasi: bentuk pesan, epoch (basi/tanpa), batch berurutan dan berhenti di kesalahan');
  }

  // ---------- 2. connect: tanpa link null; dengan link membuka stream ganjil dan memancarkan "connect" ----------
  {
    const h = mk();
    assert.strictEqual(h.br.transport.connect(peerReq(P)), null, 'belum attach');
    h.br.feed({ op: 'attach', e: EP });
    assert.strictEqual(h.br.transport.connect(peerReq(P)), null, 'tanpa link terbuka: null, tidak memicu apa pun'); assert.strictEqual(h.take('open').length, 0);
    for (const ip of ['10.0.0.1', 'rtc:zz', undefined, 'rtc:' + P + '0']) assert.strictEqual(h.br.transport.connect({ ip, port: 1 }), null);
    assert.strictEqual(h.br.transport.connect(null), null);
    h.ui({ op: 'link', peer: P, state: 'open', path: 'relay' });
    assert.strictEqual(h.br.links()[0].path, 'relay'); assert(h.br.transport.reachable(P) && !h.br.transport.reachable(Q));
    const s1 = h.br.transport.connect(peerReq(P)), s2 = h.br.transport.connect(peerReq(P));
    assert.deepStrictEqual(h.take('open').map((m) => [m.sid, m.peer, m.e]), [[1, P, EP], [3, P, EP]], 'sid ganjil dari Core');
    let connected = 0; s1.on('connect', () => { connected++; }); await sleep(10); assert.strictEqual(connected, 1, "event 'connect' sekali, setelah connect() kembali");
    s1.destroy(); s2.destroy(); await sleep(5);
    assert.deepStrictEqual(h.take('rst').map((m) => m.sid).sort(), [1, 3], 'destroy sebelum selesai = rst ke UI');
    ok('2 connect: null tanpa link/alamat sah; stream ganjil; connect optimis; destroy mengirim rst');
  }

  // ---------- 3. tulis besar: potongan <= CHUNK, salinan bersih, berhenti di WINDOW sampai ada ack ----------
  {
    const h = mk(); up(h);
    const s = h.br.transport.connect(peerReq(P)); const src = rnd(1024 * 1024 + 123); let done = false;
    s.write(src, () => { done = true; });
    await sleep(20);
    const sent = h.take('data'); const total = sent.reduce((n, m) => n + m.d.length, 0);
    assert.strictEqual(total, WINDOW, 'tepat sebanyak jendela sebelum ada ack: ' + total); assert(!done, 'write() menunggu ack');
    assert(sent.every((m) => m.d instanceof Uint8Array && m.d.length <= CHUNK), 'potongan <= CHUNK');
    assert(sent.every((m) => m.d.buffer.byteLength === m.d.byteLength && m.d.byteOffset === 0), 'tiap potongan adalah salinan sendiri (structured clone tidak menyerialkan buffer besar)');
    h.ui({ op: 'ack', sid: s.sid, n: 64 * 1024 }); await sleep(10);
    assert.strictEqual(h.take('data').reduce((n, m) => n + m.d.length, 0), WINDOW + 64 * 1024, 'ack 64K -> 64K lagi');
    let acked = 64 * 1024;
    while (!done) { h.ui({ op: 'ack', sid: s.sid, n: 32 * 1024 }); acked += 32 * 1024; await sleep(2); if (acked > 3 * src.length) throw new Error('tidak selesai'); }
    assert(dataOf(h, s.sid).equals(src), 'isi utuh dan berurutan');
    s.end(); await sleep(5); assert.deepStrictEqual(h.take('fin').map((m) => m.sid), [s.sid], 'end() -> fin sekali');
    h.ui({ op: 'ack', sid: s.sid, n: 999999999 }); // ack berlebihan tidak merusak (inflight tidak negatif)
    h.ui({ op: 'ack', sid: s.sid, n: -5 }); h.ui({ op: 'ack', sid: 999, n: 5 }); h.ui({ op: 'ack', sid: s.sid, n: 1.5 });
    ok('3 tulis 1 MB: potongan <= CHUNK dan salinan bersih; berhenti tepat di WINDOW, lanjut per ack, isi utuh, fin sekali');
  }

  // ---------- 4. mode base64 ----------
  {
    const h = mk({ binary: false }); up(h);
    const s = h.br.transport.connect(peerReq(P)); const src = rnd(70000); s.write(src); await sleep(10);
    const dm = h.take('data'); assert(dm.length >= 3 && dm.every((m) => typeof m.d === 'string' && /^[A-Za-z0-9+/]+=*$/.test(m.d)));
    assert(Buffer.concat(dm.map((m) => Buffer.from(m.d, 'base64'))).equals(src));
    // masuk: base64 sah diterima, tidak sah ditolak
    let sock = null; h.br.transport.onIncoming = (x) => { sock = x; }; h.ui({ op: 'in', sid: 2, peer: P }); const got = []; sock.on('data', (d) => got.push(Buffer.from(d)));
    h.ui({ op: 'data', sid: 2, d: src.subarray(0, 30000).toString('base64') }); h.ui({ op: 'data', sid: 2, d: '' }); await sleep(5);
    assert(Buffer.concat(got).equals(src.subarray(0, 30000)), 'base64 masuk didekode');
    ok('4 base64: byte keluar sebagai string base64 yang bisa dipulihkan');
  }

  // ---------- 5. masuk: in/data/fin, ack, pause ----------
  {
    const h = mk(); up(h); const incoming = [];
    h.br.transport.onIncoming = (sock, id) => incoming.push([sock, id]);
    assert.strictEqual(h.ui({ op: 'in', sid: 3, peer: P }).ok, false, 'sid ganjil dari UI = salah');
    assert.strictEqual(h.ui({ op: 'in', sid: 0, peer: P }).ok, false); assert.strictEqual(h.ui({ op: 'in', sid: 2, peer: 'zz' }).ok, false); assert.strictEqual(h.ui({ op: 'in', sid: 2.5, peer: P }).ok, false);
    h.ui({ op: 'in', sid: 2, peer: Q }); assert.deepStrictEqual(h.take('rst').map((m) => m.sid), [2], 'peer tanpa link: rst'); assert.strictEqual(incoming.length, 0);
    h.out.length = 0;
    h.ui({ op: 'in', sid: 2, peer: P }); assert.strictEqual(incoming.length, 1); assert.strictEqual(incoming[0][1], P);
    const sock = incoming[0][0]; const got = []; sock.on('data', (d) => got.push(Buffer.from(d))); let ended = false; sock.on('end', () => { ended = true; });
    h.ui({ op: 'in', sid: 2, peer: P }); assert.strictEqual(h.take('rst').length, 1, 'sid ganda ditolak'); assert.strictEqual(incoming.length, 1);
    const a = rnd(50000), b = rnd(50000);
    h.ui({ op: 'data', sid: 2, d: a }); h.ui({ op: 'data', sid: 2, d: b }); await sleep(10);
    assert(Buffer.concat(got).equals(Buffer.concat([a, b])));
    const acks = h.take('ack'); assert.strictEqual(acks.reduce((n, m) => n + m.n, 0), 100000, 'ack = byte yang diberikan ke pendengar (dikelompokkan di >= ACK_AT): ' + JSON.stringify(acks.map((m) => m.n)));
    // pause: tidak di-ack selama tidak dibaca
    h.out.length = 0; sock.pause();
    for (let i = 0; i < 4; i++) h.ui({ op: 'data', sid: 2, d: rnd(60000) }); await sleep(10);
    assert.strictEqual(h.take('ack').length, 0, 'soket di-pause: tidak ada ack (UI menahan lawan lewat kredit)');
    sock.resume(); await sleep(10); assert.strictEqual(h.take('ack').reduce((n, m) => n + m.n, 0), 240000, 'resume: semua di-ack');
    // fin: end -> auto-end sisi tulis -> fin ke UI; setelah keduanya selesai destroy tidak mengirim rst
    h.out.length = 0; h.ui({ op: 'fin', sid: 2 }); await sleep(10);
    assert(ended); assert.deepStrictEqual(h.take('fin').map((m) => m.sid), [2], 'half-open dimatikan: end sisi baca menutup sisi tulis (seperti net.Socket)');
    sock.destroy(); await sleep(5); assert.strictEqual(h.take('rst').length, 0, 'kedua arah selesai: destroy tidak mengirim rst');
    ok('5 masuk: sid genap, peer harus berlink, ack sesuai byte yang dibaca (pause = tanpa ack), fin dua arah tanpa rst');
  }

  // ---------- 6. pelanggaran dari UI: data rusak/terlalu besar/melebihi jendela ----------
  {
    const h = mk(); up(h); const socks = []; h.br.transport.onIncoming = (s) => socks.push(s);
    const open = (sid) => { h.ui({ op: 'in', sid, peer: P }); return socks[socks.length - 1]; };
    for (const [nama, d] of [['base64 rusak', '@@@@'], ['bukan byte', 12345], ['terlalu besar', Buffer.alloc(256 * 1024 + 1)], ['objek', { a: 1 }], ['base64 terlalu panjang', 'A'.repeat(400000)]]) {
      const s = open(2 + socks.length * 2); let closed = false; s.on('close', () => { closed = true; }); h.out.length = 0;
      h.ui({ op: 'data', sid: s.sid, d }); await sleep(5);
      assert(closed && h.take('rst').some((m) => m.sid === s.sid), nama + ': stream ditutup dan UI diberi rst');
    }
    const s = open(100); s.pause(); let err = null; s.on('error', (e) => { err = e; }); h.out.length = 0;
    const chunk = Buffer.alloc(200 * 1024); let n = 0; while (!s.destroyed && n < 40) { h.ui({ op: 'data', sid: 100, d: chunk }); n++; }
    await sleep(5); assert(s.destroyed && err && /jendela/.test(err.message), 'melebihi RX_LIMIT: ditutup (n=' + n + ')'); assert(n * chunk.length <= RX_LIMIT + chunk.length); assert(h.take('rst').length >= 1);
    assert(h.ui({ op: 'data', sid: 12345, d: Buffer.alloc(5) }).ok, 'data untuk stream yang tidak ada diabaikan diam-diam');
    assert(h.ui({ op: 'fin', sid: 12345 }).ok && h.ui({ op: 'rst', sid: 12345 }).ok);
    // tanpa onIncoming: tidak ada yang menerima -> rst
    const h2 = mk(); up(h2); h2.ui({ op: 'in', sid: 2, peer: P }); assert.strictEqual(h2.take('rst').length, 1);
    ok('6 pelanggaran UI: data rusak/besar/di luar jendela menutup stream saja dan UI diberi rst; stream tak dikenal diabaikan');
  }

  // ---------- 7. batas soket ----------
  {
    const h = mk(); up(h); const made = [];
    for (let i = 0; i < MAX_SOCKS + 10; i++) { const s = h.br.transport.connect(peerReq(P)); if (s) made.push(s); }
    assert.strictEqual(made.length, MAX_SOCKS, 'batas ' + MAX_SOCKS);
    made[0].destroy(); await sleep(2); assert(h.br.transport.connect(peerReq(P)), 'slot kembali setelah ditutup');
    made.forEach((s) => s.destroy());
    ok('7 batas soket total; slot kembali setelah ditutup');
  }

  // ---------- 8. link putus: soket ke peer itu ditutup, peer lain tidak ----------
  {
    const h = mk(); up(h); h.ui({ op: 'link', peer: Q, state: 'open' });
    const sp = h.br.transport.connect(peerReq(P)), sq = h.br.transport.connect(peerReq(Q)); let ep = null; sp.on('error', (e) => { ep = e; }); let qc = false; sq.on('close', () => { qc = true; });
    h.out.length = 0; h.links.length = 0;
    h.ui({ op: 'link', peer: P, state: 'failed', reason: 'ice-failed' }); await sleep(5);
    assert(sp.destroyed && ep && /link putus/.test(ep.message)); assert(!qc && !sq.destroyed);
    assert.strictEqual(h.take('rst').length, 0, 'link sudah mati: tidak perlu rst ke UI');
    assert.deepStrictEqual(h.links.map((e) => [e.peerId, e.state, e.reason]), [[P, 'closed', 'ice-failed']]);
    assert.strictEqual(h.br.transport.connect(peerReq(P)), null, 'link putus: connect null lagi');
    h.ui({ op: 'link', peer: P, state: 'closed' }); assert.strictEqual(h.links.length, 1, 'penutupan ganda tidak memancarkan lagi');
    h.ui({ op: 'link', peer: Q, state: 'open', path: 'direct' }); assert.strictEqual(h.links[h.links.length - 1].state, 'update', 'link terbuka lagi dengan info jalur baru: update, bukan open ganda');
    ok('8 link putus menutup soket peer itu saja, memancarkan event sekali; update jalur tidak dihitung open ganda');
  }

  // ---------- 9. UI baru (epoch lain) mengambil alih ----------
  {
    const h = mk(); up(h); const s = h.br.transport.connect(peerReq(P)); let closed = false; s.on('close', () => { closed = true; });
    h.out.length = 0; h.links.length = 0;
    const E2 = 'bbbbbbbbbbbbbbbb'; assert(h.br.feed({ op: 'attach', e: E2 }).ok);
    assert.deepStrictEqual(h.out.map((m) => [m.op, m.e]), [['detached', EP]], 'UI lama diberi tahu (dengan epoch lamanya)');
    await sleep(5); assert(closed); assert.deepStrictEqual(h.links.map((e) => e.state), ['closed']); assert.deepStrictEqual(h.br.links(), []);
    assert.strictEqual(h.br.feed({ op: 'link', e: EP, peer: P, state: 'open' }).stale, true, 'epoch lama sekarang basi');
    assert(h.br.feed({ op: 'link', e: E2, peer: P, state: 'open' }).ok);
    // attach ulang epoch yang SAMA tidak membuang apa pun
    const s2 = h.br.transport.connect(peerReq(P)); assert(h.br.feed({ op: 'attach', e: E2 }).ok); assert(!s2.destroyed && h.br.links().length === 1);
    // detach dari UI
    h.ui({ op: 'detach' }); assert(!h.br.attached()); assert(s2.destroyed); assert.strictEqual(h.br.transport.connect(peerReq(P)), null);
    ok('9 attach epoch baru: UI lama di-detach, soket/link lama dibuang; epoch sama tidak mereset; detach melepas semuanya');
  }

  // ---------- 10. Core berhenti: rst per soket + detached ----------
  {
    const h = mk(); up(h); const s = h.br.transport.connect(peerReq(P)); h.out.length = 0;
    h.br.transport.close(); await sleep(5);
    assert(s.destroyed); assert.deepStrictEqual(h.out.map((m) => m.op), ['rst', 'detached']); assert(!h.br.attached());
    h.br.transport.close(); // aman dipanggil dua kali
    ok('10 transport.close(): rst tiap soket lalu detached; aman dua kali');
  }

  // ---------- 11. idle timeout seperti net.Socket ----------
  {
    const h = mk(); up(h); const s = h.br.transport.connect(peerReq(P)); let fired = 0; s.setTimeout(60, () => { fired++; });
    await sleep(110); assert.strictEqual(fired, 1, 'diam 60 ms -> callback');
    s.setTimeout(80, () => { fired += 10; }); await sleep(50); h.ui({ op: 'ack', sid: s.sid, n: 1 }); s.write('x'); await sleep(50); assert.strictEqual(fired, 1, 'aktivitas menunda batas diam');
    await sleep(60); assert.strictEqual(fired, 11); s.setTimeout(0); s.destroy();
    ok('11 setTimeout = batas diam (idle), tertunda oleh aktivitas tulis');
  }

  // ---------- 12. setEncoding utf8 dengan karakter multibyte terbelah: ack tetap akurat ----------
  {
    const h = mk(); up(h); let sock = null; h.br.transport.onIncoming = (s) => { sock = s; }; h.ui({ op: 'in', sid: 2, peer: P });
    sock.setEncoding('utf8'); let txt = ''; sock.on('data', (d) => { txt += d; });
    const full = Buffer.from('é😀ü'.repeat(60000)); let off = 0; const sizes = [4999, 7, 30011, 1];
    let i = 0; while (off < full.length) { const n = Math.min(sizes[i++ % sizes.length], full.length - off); h.ui({ op: 'data', sid: 2, d: full.subarray(off, off + n) }); off += n; if (i % 20 === 0) await sleep(1); }
    await sleep(20);
    assert.strictEqual(txt, full.toString('utf8'), 'teks utuh'); const acked = h.take('ack').reduce((n, m) => n + m.n, 0);
    assert(acked <= full.length && acked >= full.length - ACK_AT - 4, 'ack ~ byte (bukan jumlah karakter): ' + acked + ' dari ' + full.length);
    ok('12 setEncoding(utf8) + multibyte terbelah: ack dihitung dalam byte, bukan karakter');
  }

  // ---------- 13. unshift (file_put) tidak membuat ack melebihi yang pernah masuk ----------
  {
    const h = mk(); up(h); let sock = null; h.br.transport.onIncoming = (s) => { sock = s; }; h.ui({ op: 'in', sid: 2, peer: P });
    let first = true; sock.on('data', (d) => { if (first) { first = false; sock.pause(); sock.unshift(d); setImmediate(() => sock.resume()); } });
    h.ui({ op: 'data', sid: 2, d: rnd(100000) }); await sleep(20);
    assert(h.take('ack').reduce((n, m) => n + m.n, 0) <= 100000, 'ack <= byte yang masuk walau data keluar dua kali');
    ok('13 unshift: ack tidak pernah melebihi byte yang masuk');
  }

  // ---------- 14. tulis ketika sudah di-detach / dihancurkan di tengah ----------
  {
    const h = mk(); up(h); const s = h.br.transport.connect(peerReq(P)); let wrote = false; s.write(rnd(WINDOW * 2), () => { wrote = true; });
    await sleep(5); s.destroy(); await sleep(5); h.ui({ op: 'ack', sid: s.sid, n: 1000 }); await sleep(5);
    assert(!wrote, 'tulisan yang digantung tidak pernah selesai setelah destroy (tidak ada kebocoran callback)');
    assert.strictEqual(h.take('data').reduce((n, m) => n + m.d.length, 0), WINDOW, 'tidak ada data lagi setelah destroy');
    // send() yang melempar tidak merusak Core
    const h2 = mk({ send: () => { throw new Error('IPC mati'); } }); h2.br.feed({ op: 'attach', e: EP }); h2.br.feed({ op: 'link', e: EP, peer: P, state: 'open' });
    assert.strictEqual(h2.br.transport.connect(peerReq(P)), null, 'UI tidak tercapai: connect gagal bersih (null), tidak melempar');
    ok('14 destroy di tengah tulis: berhenti bersih; send() UI yang melempar -> connect null, tanpa pengecualian');
  }

  finished = true;
  console.log('\nrtcbridge: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
