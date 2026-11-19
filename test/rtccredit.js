'use strict';
// Tes kredit per stream di rtcmux (mode lintas jaringan, langkah 4): flow control per stream supaya penerima yang lambat
// (Core di balik IPC) tidak menumpuk memori di UI. window = 0 (bawaan) tidak berubah: ditegakkan seluruh test/archne-rtcmux.js.
const crypto = require('crypto'), assert = require('assert');
const { createMux, F_CREDIT, F_DATA, F_OPEN, F_FIN } = require('../renderer/archne-rtcmux');
const { FakeNet, FakeDC } = require('./lib/fakertc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(5); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const W = 64 * 1024;
function pair(net, oa, ob) {
  const a = new FakeDC(net, 'archne'), b = new FakeDC(net, 'archne'); a.remote = b; b.remote = a; a._open(); b._open();
  return { ca: a, cb: b, A: createMux(a, Object.assign({ initiator: true, window: W }, oa)), B: createMux(b, Object.assign({ initiator: false, window: W }, ob)) };
}
const frame = (id, flag, payload) => { const p = payload ? Buffer.from(payload) : Buffer.alloc(0); const f = Buffer.alloc(5 + p.length); f.writeUInt32BE(id, 0); f[4] = flag; p.copy(f, 5); return new Uint8Array(f); };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let finished = false;
process.on('exit', (c) => { if (!finished && c === 0) { console.error('GAGAL: proses berakhir sebelum semua tes selesai'); process.exitCode = 1; } });
setTimeout(() => { console.error('GAGAL: tes menggantung'); process.exit(1); }, 60000).unref();

(async () => {
  const net = new FakeNet();

  // ---------- 1. pengirim berhenti di batas kredit sampai penerima memanggil consumed() ----------
  {
    const { A, B } = pair(net); let rs = null, got = 0;
    B.on('stream', (s) => { rs = s; s.on('data', (d) => { got += d.length; }); });
    const s = A.open(); let done = false; const w = s.write(Buffer.alloc(W * 4, 1)).then(() => { done = true; });
    await until(() => rs && got >= W, 2000, 'jendela pertama tiba'); await sleep(60);
    assert.strictEqual(got, W, 'hanya sebanyak window yang sampai: ' + got); assert(!done, 'write() menunggu kredit');
    rs.consumed(W / 2); await sleep(40); // setengah window >= window/4: CREDIT dikirim
    assert.strictEqual(got, W + W / 2, 'kredit yang dipulihkan = yang dikirim lagi: ' + got);
    rs.consumed(W / 2); await until(() => got === W * 2, 1000, 'dua window'); rs.consumed(W); await until(() => got === W * 3, 1000, 'tiga');
    rs.consumed(W); await until(() => got === W * 4 && done, 1000, 'semua tiba'); await w;
    ok('1 pengirim berhenti di window byte; write() baru selesai setelah penerima consumed()');
  }

  // ---------- 2. integritas 5 MB lewat penerima lambat; memori penerima tidak pernah melebihi window ----------
  {
    const { A, B } = pair(net); const src = crypto.randomBytes(5 * 1024 * 1024); const chunks = []; let held = 0, maxHeld = 0, ended = false;
    B.on('stream', (s) => {
      s.on('data', (d) => { held += d.length; maxHeld = Math.max(maxHeld, held); chunks.push(Buffer.from(d)); setTimeout(() => { held -= d.length; s.consumed(d.length); }, 1); }); // memproses lambat
      s.on('end', () => { ended = true; });
    });
    const s = A.open(); await s.write(src); await s.end();
    await until(() => ended && held === 0, 20000, 'selesai');
    assert.strictEqual(sha(Buffer.concat(chunks)), sha(src), 'isi utuh'); assert(maxHeld <= W, 'penumpukan di penerima <= window: ' + maxHeld);
    ok('2 5 MB utuh lewat penerima lambat; yang belum diproses tidak pernah melebihi window (' + maxHeld + ' <= ' + W + ')');
  }

  // ---------- 3. stream lain tidak terhalang stream yang macet ----------
  {
    const { A, B } = pair(net); const rx = new Map();
    B.on('stream', (s) => { const e = { n: 0, s }; rx.set(s.id, e); s.on('data', (d) => { e.n += d.length; if (s.id !== 1) s.consumed(d.length); }); }); // stream 1: tidak pernah consumed
    const a1 = A.open(), a2 = A.open();
    a1.write(Buffer.alloc(W * 10, 1)).catch(() => {});
    await until(() => rx.get(1) && rx.get(1).n === W, 2000, 'stream 1 macet di window');
    const t0 = Date.now(); await a2.write(Buffer.alloc(W * 20, 2)); await until(() => rx.get(3).n === W * 20, 3000, 'stream 2 lancar');
    assert.strictEqual(rx.get(1).n, W, 'stream 1 tetap macet'); assert(Date.now() - t0 < 3000);
    ok('3 stream yang macet tidak menahan stream lain di channel yang sama');
  }

  // ---------- 4. bentuk bingkai CREDIT dan tidak berlebihan ----------
  {
    const { ca, A, B } = pair(net); let rs = null; const s = A.open(); void s;
    B.on('stream', (x) => { rs = x; });
    await s.write(Buffer.alloc(W)); await until(() => rs, 1000, 'stream'); const cb = ca.remote; cb.sent.length = 0;
    rs.consumed(1000); rs.consumed(1000); assert.strictEqual(cb.sent.length, 0, 'di bawah window/4: belum ada CREDIT (tidak berisik)');
    rs.consumed(W / 4); assert.strictEqual(cb.sent.length, 1); assert.strictEqual(Buffer.from(cb.sent[0]).toString('hex'), '00000001' + '05' + u32(2000 + W / 4).toString('hex'), 'CREDIT: [id][5][u32 jumlah terkumpul]');
    rs.consumed(10 ** 9); // melebihi yang pernah diterima: dibatasi pada yang ada
    const total = cb.sent.reduce((n, f) => n + Buffer.from(f).readUInt32BE(5), 0); assert(total <= W, 'CREDIT total tidak pernah melebihi byte yang diterima: ' + total);
    for (const bad of [0, -5, NaN, undefined, 'x']) rs.consumed(bad);
    ok('4 CREDIT: u32 BE, digabung per window/4, tidak melebihi byte yang diterima, nilai aneh diabaikan');
  }

  // ---------- 5. pelanggaran: pengirim melebihi window / CREDIT tidak sah ----------
  {
    const { ca, A, B } = pair(net); void A; let rs = null; B.on('stream', (x) => { rs = x; });
    ca.send(frame(1, F_OPEN)); await until(() => rs, 1000, 'stream');
    let err = null; rs.on('error', (e) => { err = e; });
    for (let i = 0; i < 5; i++) ca.send(frame(1, F_DATA, Buffer.alloc(W / 4, 1))); // 5/4 window tanpa consumed
    await until(() => rs.closed, 1000, 'stream ditutup'); assert(err && /jendela/.test(err.message), 'melanggar window: ' + (err && err.message));
    assert(B.isOpen(), 'link tetap hidup; hanya stream yang dikorbankan');

    // CREDIT tidak sah: nol, panjang salah, kelebihan
    const t = pair(net); let s1 = null; t.B.on('stream', (x) => { s1 = x; }); const o = t.A.open(); await o.write(Buffer.alloc(10)); await until(() => s1, 1000, 'stream');
    let oerr = null; o.on('error', (e) => { oerr = e; });
    t.cb.send(frame(1, F_CREDIT, u32(0))); await until(() => o.closed, 1000, 'CREDIT 0 menutup stream'); assert(oerr && /CREDIT/.test(oerr.message)); assert(t.A.isOpen());
    const t2 = pair(net); const o2 = t2.A.open(); await sleep(10); t2.cb.send(frame(1, F_CREDIT, Buffer.alloc(3))); await until(() => !t2.A.isOpen(), 1000, 'panjang salah = pelanggaran link');
    const t3 = pair(net); const o3 = t3.A.open(); await sleep(10); t3.cb.send(frame(1, F_CREDIT, u32(0x7FFFFFFF))); await until(() => o3.closed, 1000, 'kelebihan kredit menutup stream');
    ok('5 pelanggaran: lewat window, CREDIT nol/kelebihan menutup stream saja; CREDIT berpanjang salah menutup link');
  }

  // ---------- 6. FIN mengikuti data yang tertahan; reset saat menunggu kredit menolak write ----------
  {
    const { A, B } = pair(net); let rs = null, ended = false, got = 0; B.on('stream', (s) => { rs = s; s.on('data', (d) => { got += d.length; }); s.on('end', () => { ended = true; }); });
    const s = A.open(); const w = s.write(Buffer.alloc(W * 2)); const e = s.end();
    await until(() => got === W, 1000, 'window'); await sleep(30); assert(!ended, 'FIN tidak menyalip data yang menunggu kredit');
    rs.consumed(W); await until(() => got === W * 2, 1000, 'sisa'); await until(() => ended, 1000, 'FIN setelah semua data'); await Promise.all([w, e]);

    const t = pair(net); let r2 = null; t.B.on('stream', (x) => { r2 = x; }); const s2 = t.A.open(); const w2 = s2.write(Buffer.alloc(W * 3)); let rej = null; w2.catch((x) => { rej = x; });
    await until(() => r2, 1000, 'stream'); await sleep(30); r2.destroy(); await until(() => rej, 1000, 'write ditolak saat stream di-reset');
    ok('6 FIN tidak menyalip data tertahan; reset saat menunggu kredit menolak write()');
  }

  // ---------- 7. window = 0 pada satu sisi: CREDIT dari lawan diabaikan, tidak merusak link ----------
  {
    const { ca, A, B } = pair(net, { window: 0 }, { window: 0 }); let rs = null; B.on('stream', (x) => { rs = x; }); const s = A.open(); await s.write('x'); await until(() => rs, 1000, 'stream');
    ca.remote.send(frame(1, F_CREDIT, u32(5))); await sleep(20); assert(A.isOpen() && !s.closed, 'CREDIT diabaikan tanpa mode kredit');
    rs.consumed(100); // tanpa mode kredit consumed() tidak berbuat apa-apa
    ok('7 tanpa window: CREDIT diabaikan dan consumed() tak berefek');
  }

  // ---------- 8. consumed() pada stream tertutup/ber-FIN aman; tidak ada CREDIT yang tak berguna ----------
  {
    const { ca, A, B } = pair(net); let rs = null; B.on('stream', (x) => { rs = x; });
    const s = A.open(); await s.write(Buffer.alloc(W / 2)); await s.end(); await until(() => rs && rs.remoteEnded, 1000, 'FIN diterima');
    const cb = ca.remote; cb.sent.length = 0; rs.consumed(W / 2); assert.strictEqual(cb.sent.length, 0, 'sesudah FIN lawan tidak perlu kredit lagi');
    rs.destroy(); rs.consumed(10); // setelah tutup: tidak melempar
    ok('8 consumed() setelah FIN/penutupan tidak mengirim apa pun dan tidak melempar');
  }

  finished = true;
  console.log('\nrtccredit: ' + pass + ' OK');
})().catch((e) => { console.error(e); process.exit(1); });
