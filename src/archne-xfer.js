'use strict';
// Transfer byte berkas lewat TCP (v0.7.0 tahap 3): langkah 2a = polos + resume, langkah 2b = enkripsi per potongan (DM/grup).
//
// Protokol (satu koneksi = satu permintaan):
//   klien -> server : satu baris JSON  { t:'file_get', id, off, hi }
//   server -> klien : satu baris JSON  { t:'file', ok:true, off, len, enc?, wl? }  lalu TEPAT `wl` byte (polos: wl = len), lalu menutup
//                     atau             { t:'file', ok:false, err }                  lalu menutup
// Klien tidak percaya header: off/len harus persis sama dengan yang diminta, dan byte lebih dari yang dijanjikan ditolak.
// Resume = `off` diisi ukuran .part yang sudah ada; server cukup mulai membaca dari situ.
//
// Enkripsi (enc:1, wajib untuk DM/grup; klien yang menentukan dari jenis pesan, bukan dari header, jadi tidak bisa diturunkan ke polos):
//   berkas dipotong per SEG byte plaintext (potongan terakhir lebih pendek). Tiap potongan disegel AES-256-GCM dan dikirim sebagai
//   ciphertext || tag(16). Panjang tiap potongan sudah pasti dari `total`, jadi tidak ada header per potongan.
//   nonce = nomor potongan (u64 BE, 12 byte); AAD = 'archne-file-v1' || nomor potongan || total. Kunci diturunkan per berkas (fileKey).
//   Potongan diacak urutannya, dipotong, atau diubah satu bit: tag gagal -> 'crypt'. .part menyimpan plaintext potongan yang sudah
//   lolos verifikasi, jadi selalu sejajar SEG dan `off` resume selalu kelipatan SEG (atau sama dengan total).
const net = require('net');
const dialTcp = (peer) => net.connect({ host: peer.ip, port: peer.port });
const crypto = require('crypto');
const fs = require('fs');
const { Transform } = require('stream');
const { pipeline } = require('./archne-compat');

const HEAD_MAX = 4096, IDLE_MS = 15000, CHUNK = 64 * 1024;
const SEG = 64 * 1024, TAG = 16, ADOMAIN = Buffer.from('archne-file-v1');

const TEXT = {
  bad: 'permintaan tidak valid',
  gone: 'berkas sudah tidak tersedia di pengirim',
  denied: 'kamu tidak berhak mengambil berkas ini',
  changed: 'berkas di pengirim berubah atau hilang',
  busy: 'pengirim sedang sibuk, coba lagi nanti',
  range: 'posisi lanjut tidak valid',
  nokey: 'kunci enkripsi berkas tidak tersedia',
  relaycap: 'berkas terlalu besar untuk jalur relay (batas antar jaringan di pengirim); coba lagi saat satu jaringan atau jalur langsung',
  crypt: 'data berkas rusak atau kunci tidak cocok',
  net: 'koneksi terputus',
  timeout: 'koneksi macet',
  proto: 'jawaban pengirim tidak sesuai protokol',
  abort: 'dibatalkan',
  nocustody: 'kurir tidak menitipkan pesan ini',
  kind: 'hanya DM yang bisa dititipkan berkasnya',
  receipt: 'pesan sudah diterima tujuan',
  big: 'berkas terlalu besar untuk dititipkan',
  quota: 'kuota titipan kurir penuh',
  sender: 'jatah titipan pengirim ini di kurir penuh',
  auth: 'tanda tangan pengirim tidak sah',
  over: 'byte melebihi ukuran yang didaftarkan',
  io: 'kurir gagal menulis ke disk',
};
// Penolakan yang sah dari kurir untuk file_put/esc_q (kode lain dianggap 'proto').
const PUT_REFUSALS = ['bad', 'gone', 'busy', 'range', 'nocustody', 'kind', 'receipt', 'big', 'quota', 'sender', 'auth', 'over', 'io'];
// Penolakan yang sah dari server (kode lain dari server dianggap 'proto').
const REFUSALS = ['bad', 'gone', 'denied', 'changed', 'busy', 'range', 'nokey', 'relaycap'];
// Kode yang boleh dicoba ulang (resume); sisanya final.
const RETRY = new Set(['net', 'timeout']);

class XferError extends Error {
  constructor(code, msg) { super(msg || TEXT[code] || code); this.name = 'XferError'; this.code = code; }
}

// ---- Enkripsi per potongan (2b) ----
// Kunci per berkas: HKDF dari kunci pasangan/grup, dengan id pesan sebagai salt dan pengirim sebagai konteks. Kunci DM/grup sendiri
// tidak pernah dipakai langsung untuk byte berkas, dan dua berkas tidak pernah berbagi kunci (nonce aman dari tabrakan).
function fileKey(base, from, id) {
  return Buffer.from(crypto.hkdfSync('sha256', base, Buffer.from(String(id), 'hex'), Buffer.from('archne-file-v1:' + from), 32));
}
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const nonceOf = (i) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(i), 4); return b; };
const aadOf = (i, total) => Buffer.concat([ADOMAIN, u64(i), u64(total)]);
const segLen = (i, total) => Math.max(0, Math.min(SEG, total - i * SEG));
// Jumlah byte di kabel untuk plaintext [off, total) (off sejajar SEG).
const wireLen = (off, total) => (total - off) + TAG * Math.ceil((total - off) / SEG);

// Plaintext (tepat `len` byte, mulai dari potongan off/SEG) -> potongan tersegel.
class Sealer extends Transform {
  constructor(key, total, off) {
    super();
    this.key = key; this.total = total; this.i = off / SEG; this.left = total - off; this.buf = [];  this.n = 0;
  }
  _seal(plain) {
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonceOf(this.i));
    c.setAAD(aadOf(this.i, this.total));
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    this.i++;
    return out;
  }
  _transform(chunk, _e, cb) {
    this.buf.push(chunk); this.n += chunk.length; this.left -= chunk.length;
    if (this.left < 0) return cb(new XferError('changed'));
    try {
      if (this.n >= SEG) {
        let all = Buffer.concat(this.buf), o = 0;
        while (all.length - o >= SEG) { this.push(this._seal(all.subarray(o, o + SEG))); o += SEG; }
        const rest = all.subarray(o);
        this.buf = rest.length ? [rest] : []; this.n = rest.length;
      }
      cb();
    } catch (e) { cb(e); }
  }
  _flush(cb) {
    if (this.left !== 0) return cb(new XferError('changed')); // berkas menyusut/membesar saat dibaca
    try { if (this.n) this.push(this._seal(Buffer.concat(this.buf))); cb(); } catch (e) { cb(e); }
  }
}

// Potongan tersegel -> plaintext. Potongan yang tag-nya gagal tidak pernah diteruskan ke berkas.
class Opener extends Transform {
  constructor(key, total, off) {
    super();
    this.key = key; this.total = total; this.i = off / SEG; this.buf = Buffer.alloc(0);
  }
  _transform(chunk, _e, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      for (;;) {
        const pl = segLen(this.i, this.total);
        if (pl === 0) { if (this.buf.length) return cb(new XferError('proto', 'byte berlebih setelah potongan terakhir')); break; }
        const need = pl + TAG;
        if (this.buf.length < need) break;
        const d = crypto.createDecipheriv('aes-256-gcm', this.key, nonceOf(this.i));
        d.setAAD(aadOf(this.i, this.total));
        d.setAuthTag(this.buf.subarray(pl, need));
        let plain;
        try { plain = Buffer.concat([d.update(this.buf.subarray(0, pl)), d.final()]); } catch { return cb(new XferError('crypt')); }
        this.push(plain);
        this.buf = this.buf.subarray(need); this.i++;
      }
      cb();
    } catch (e) { cb(e); }
  }
}

// Server: tulis header lalu isi berkas [start, start + len). `key` (kunci per berkas, dari fileKey) = kirim tersegel; start harus sejajar SEG
// (atau sama dengan total). `total` = ukuran penuh berkas, dipakai sebagai bagian AAD. Penutup koneksi ditangani pipeline.
async function serve(sock, file, start, len, key, total) {
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  const h = { t: 'file', ok: true, off: start, len };
  if (key) { h.enc = 1; h.wl = wireLen(start, total); }
  sock.write(JSON.stringify(h) + '\n');
  if (len === 0) { sock.end(); return; }
  try {
    const rs = fs.createReadStream(file, { start, end: start + len - 1, highWaterMark: CHUNK });
    if (key) await pipeline(rs, new Sealer(key, total, start), sock);
    else await pipeline(rs, sock);
  } catch { sock.destroy(); }
}

// Kurir -> penerima (4c): layani byte TERSEGEL yang tadinya didorong pengirim, apa adanya dari disk (kurir tidak punya kunci, tidak menyegel ulang).
// Protokol di kabel identik dengan serve() untuk berkas terenkripsi, jadi download() penerima tidak perlu tahu sumbernya.
// `start` = offset plaintext (sejajar SEG, atau sama dengan total); `total` = ukuran plaintext penuh. Byte di disk = wireLen(0, total).
async function serveSealed(sock, file, start, total) {
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  const wl = wireLen(start, total);
  sock.write(JSON.stringify({ t: 'file', ok: true, off: start, len: total - start, enc: 1, wl }) + '\n');
  if (wl === 0) { sock.end(); return; }
  const ws = (start / SEG) * (SEG + TAG);
  try { await pipeline(fs.createReadStream(file, { start: ws, end: ws + wl - 1, highWaterMark: CHUNK }), sock); } catch { sock.destroy(); }
}

function refuse(sock, err) {
  sock.end(JSON.stringify({ t: 'file', ok: false, err }) + '\n');
}

// Baca satu baris header dari soket mentah; sisa byte setelah baris dikembalikan ke soket (unshift) untuk badan berkas.
function readHead(sock) {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const off = () => { sock.removeListener('data', onData); sock.removeListener('close', onClose); };
    const onClose = () => { off(); rej(new XferError('net')); };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) { if (buf.length > HEAD_MAX) { off(); rej(new XferError('proto')); } return; }
      off(); sock.pause();
      const rest = buf.subarray(i + 1);
      if (rest.length) sock.unshift(rest);
      res(buf.subarray(0, i).toString('utf8'));
    };
    sock.on('data', onData); sock.on('close', onClose);
  });
}

// Unduh dari `peer` ke berkas `part` sampai berukuran `total`. Kalau `part` sudah ada, dilanjutkan dari ukurannya (resume).
// Mengembalikan total saat lengkap. Melempar XferError dengan code; code 'net'/'timeout' aman dicoba ulang (lihat canRetry).
// opts: { signal, onBytes(doneTotal), key } — `key` (kunci per berkas) = berkas HARUS terenkripsi: jawaban polos ditolak ('proto').
// Tanpa `key`, jawaban terenkripsi juga ditolak.
async function download(peer, req, part, total, opts = {}) {
  let off = 0;
  try { off = fs.statSync(part).size; } catch { fs.writeFileSync(part, ''); }
  if (off > total) { fs.truncateSync(part, 0); off = 0; }
  if (opts.key && off !== total && off % SEG) { off -= off % SEG; fs.truncateSync(part, off); } // .part tersegel selalu sejajar potongan
  if (off === total) return total;
  if (opts.signal && opts.signal.aborted) throw new XferError('abort');

  const sock = (opts.dial || dialTcp)(peer); // opts.dial: Core._dial (TCP atau transport rtc:)
  if (!sock) throw new XferError('net');
  const onAbort = () => sock.destroy(new XferError('abort'));
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  sock.setTimeout(IDLE_MS, () => sock.destroy(new XferError('timeout')));
  try {
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.on('error', () => {});
    sock.write(JSON.stringify(Object.assign({}, req, { t: 'file_get', off })) + '\n');
    let h;
    try { h = JSON.parse(await readHead(sock)); } catch (e) { throw e instanceof XferError ? e : new XferError('proto'); }
    if (!h || h.t !== 'file') throw new XferError('proto');
    if (!h.ok) throw new XferError(REFUSALS.includes(h.err) ? h.err : 'proto');
    if (h.off !== off || h.len !== total - off) throw new XferError('proto');
    if (!!h.enc !== !!opts.key) throw new XferError('proto', opts.key ? 'pengirim menjawab tanpa enkripsi (penurunan ditolak)' : 'jawaban terenkripsi tak terduga');
    const wl = opts.key ? wireLen(off, total) : h.len;
    if (opts.key && h.wl !== wl) throw new XferError('proto');

    const ws = fs.createWriteStream(part, { flags: 'a' });
    let wn = 0, n = 0;
    const lim = new Transform({ // batas byte di kabel: tidak boleh lebih dari yang dijanjikan
      transform(c, _e, cb) {
        wn += c.length;
        if (wn > wl) return cb(new XferError('proto', 'pengirim mengirim lebih dari yang dijanjikan'));
        cb(null, c);
      },
    });
    const prog = new Transform({ // plaintext yang sudah lolos verifikasi
      transform(c, _e, cb) { n += c.length; if (opts.onBytes) opts.onBytes(off + n); cb(null, c); },
    });
    await pipeline(...[sock, lim, opts.key ? new Opener(opts.key, total, off) : null, prog, ws].filter(Boolean));
    if (n !== h.len) throw new XferError('net');
    return total;
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw new XferError('abort');
    throw e instanceof XferError ? e : new XferError('net', e && e.message);
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    sock.destroy();
  }
}

// Pengirim -> kurir (titipan berkas, 4b). Kirim satu baris head { t:'file_put', ... } lalu byte tersegel (wire) dari plaintext
// [start, total) berkas `file` (start sejajar SEG), lalu tunggu satu baris jawaban { t:'file_put', ok, have, done } atau { ok:false, err, have? }.
// Soket TIDAK ditutup dari sisi kita setelah byte terakhir: kurir membalas setelah byte tertulis ke disk.
// Hasil: { have, done }. Penolakan kurir -> XferError(code) dengan `.have` bila kurir menyebutkannya.
async function put(peer, head, file, start, key, total, opts = {}) {
  if (opts.signal && opts.signal.aborted) throw new XferError('abort');
  const plain = !!head.plain; // berkas publik: byte polos (tanpa segel), boleh dilanjutkan dari offset mana pun
  if (plain ? (start < 0 || start > total) : (!key || start % SEG || start < 0 || start > total)) throw new XferError('bad');
  const sock = (opts.dial || dialTcp)(peer); // opts.dial: Core._dial (TCP atau transport rtc:)
  if (!sock) throw new XferError('net');
  const onAbort = () => sock.destroy(new XferError('abort'));
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  sock.setTimeout(IDLE_MS, () => sock.destroy(new XferError('timeout')));
  try {
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.on('error', () => {});
    let buf = Buffer.alloc(0), settle;
    const reply = new Promise((res, rej) => {
      settle = { res, rej };
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf(10);
        if (i >= 0) { try { res(JSON.parse(buf.subarray(0, i).toString('utf8'))); } catch { rej(new XferError('proto')); } }
        else if (buf.length > HEAD_MAX) rej(new XferError('proto'));
      });
      sock.once('close', () => rej(new XferError('net')));
    });
    reply.catch(() => {}); // ditunggu di bawah; cegah peringatan bila pipeline gagal duluan
    sock.write(JSON.stringify(Object.assign({}, head, { t: 'file_put' })) + '\n');
    let sent = 0;
    if (start < total) {
      const rs = fs.createReadStream(file, { start, end: total - 1, highWaterMark: CHUNK });
      const count = new Transform({ transform(c, _e, cb) { sent += c.length; if (opts.onBytes) opts.onBytes(start + sent); cb(null, c); } });
      try { await (plain ? pipeline(rs, count, sock, { end: false }) : pipeline(rs, count, new Sealer(key, total, start), sock, { end: false })); }
      catch (e) {
        // kurir bisa menolak lebih dulu lalu menutup: jawabannya lebih informatif daripada "koneksi putus"
        const r = await Promise.race([reply, new Promise((res) => setTimeout(() => res(null), 300))]).catch(() => null);
        if (!(r && r.ok === false)) throw e;
      }
    }
    const h = await reply;
    if (!h || h.t !== 'file_put') throw new XferError('proto');
    if (!h.ok) { const x = new XferError(PUT_REFUSALS.includes(h.err) ? h.err : 'proto'); if (Number.isSafeInteger(h.have)) x.have = h.have; throw x; }
    if (!Number.isSafeInteger(h.have)) throw new XferError('proto');
    return { have: h.have, done: !!h.done };
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw new XferError('abort');
    throw e instanceof XferError ? e : new XferError('net', e && e.message);
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    sock.destroy();
  }
}

const canRetry = (e) => !!e && RETRY.has(e.code);

// Panggil cb paling sering tiap 100 ms, dan selalu saat selesai.
function throttle(cb, total) {
  if (!cb) return undefined;
  let last = 0;
  return (n) => {
    const now = Date.now();
    if (n >= total || now - last >= 100) { last = now; cb({ done: n, total }); }
  };
}

module.exports = { readHead, XferError, serve, serveSealed, refuse, download, put, PUT_REFUSALS, Sealer, Opener, canRetry, throttle, fileKey, wireLen, SEG, TAG, IDLE_MS, HEAD_MAX };
