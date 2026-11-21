'use strict';
// Kompresi berkas lossless untuk pengiriman (v0.7.0 tahap 2). Tanpa dependensi: hanya zlib/Brotli bawaan Node.
//
// Urutan di jalur kirim: pack() -> (nanti) enkripsi -> kirim. Kompres SEBELUM enkripsi, karena ciphertext itu acak dan tidak bisa dikecilkan.
// Di sisi terima: (nanti) dekripsi -> unpack(). unpack() memverifikasi ukuran dan SHA-256 terhadap meta, jadi hasilnya identik byte-per-byte.
//
// meta = { v, mode: 'br' | 'raw', size (ukuran asli), psize (ukuran yang dikirim), hash (sha256 hex berkas asli) }.
// meta harus ikut di daftar isi yang ditandatangani; unpack() memercayai meta.size sebagai batas keras keluaran.
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MB = 1048576;
const FORMAT = 1;
// Batas per berkas dihitung pada ukuran ASLI (sebelum kompres), supaya file raksasa tidak bisa diselundupkan lewat kompresi.
const LIMITS = { direct: 100 * MB, public: 50 * MB, courier: 100 * MB }; // courier = batas atas titipan (v0.23.1); batas yang berlaku untuk pengirim diatur di Pengaturan (bawaan 10 MB)
const BIG_FILE = 20 * MB;       // sampai ukuran ini: Brotli level 11; di atasnya level 9 (level 11 sekitar 1 MB/detik)
const LGWIN = 24;               // jendela terbesar yang didukung semua dekoder Brotli standar (16 MB)
const PROBE_BYTES = 1 * MB;     // contoh yang dicoba dulu
const PROBE_LEVEL = 5;          // cukup cepat dan cukup mewakili rasio level tinggi
const MIN_SAVING = 0.05;        // hemat kurang dari 5% -> kirim apa adanya
const CHUNK = 64 * 1024;

class PackError extends Error {
  constructor(code, msg) { super(msg); this.name = 'PackError'; this.code = code; }
}

const fmtMB = (n) => (n / MB).toFixed(n >= 10 * MB ? 0 : 1) + ' MB';

// Batas per berkas menurut jenis pengiriman ('direct' = DM/grup, 'public', 'courier').
function checkLimit(size, kind) {
  const max = LIMITS[kind];
  if (max === undefined) throw new PackError('limit', 'jenis pengiriman tidak dikenal: ' + kind);
  if (size > max) throw new PackError('limit', 'berkas terlalu besar: ' + fmtMB(size) + ' (batas ' + fmtMB(max) + ')');
}

// Yang dihitung ke kuota kurir adalah ukuran setelah kompres.
const quotaCost = (meta) => meta.psize;

function plan(size) {
  return { level: size <= BIG_FILE ? 11 : 9, lgwin: LGWIN };
}

function brotliParams(p, size) {
  const C = zlib.constants;
  return {
    [C.BROTLI_PARAM_QUALITY]: p.level,
    [C.BROTLI_PARAM_LGWIN]: p.lgwin,
    [C.BROTLI_PARAM_SIZE_HINT]: Math.min(size, 0x7fffffff),
  };
}

// Transform pass-through: hitung byte, batasi maksimum, hitung hash, laporkan progres.
function tap({ max, over, hash, onBytes }) {
  const h = hash ? crypto.createHash('sha256') : null;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      t.bytes += chunk.length;
      if (max !== undefined && t.bytes > max) return cb(over());
      if (h) h.update(chunk);
      if (onBytes) onBytes(t.bytes);
      cb(null, chunk);
    },
  });
  t.bytes = 0;
  t.digest = () => h.digest('hex');
  return t;
}

function throttled(cb, total) {
  if (!cb) return undefined;
  let last = 0;
  return (n) => {
    const now = Date.now();
    if (n >= total || now - last >= 100) { last = now; cb({ done: n, total }); }
  };
}

const rmQuiet = (p) => fs.promises.rm(p, { force: true }).catch(() => {});

// Ambil contoh: seluruh berkas bila kecil, selain itu 3 potongan (awal, tengah, akhir) supaya berkas campuran
// (kepala bisa dikompres, badan tidak) tidak salah dinilai hanya dari kepalanya.
async function readSample(fh, size) {
  if (size <= PROBE_BYTES) {
    const b = Buffer.alloc(size);
    if (size) await fh.read(b, 0, size, 0);
    return b;
  }
  const part = Math.floor(PROBE_BYTES / 3);
  const offs = [0, Math.floor((size - part) / 2), size - part];
  const bufs = [];
  for (const o of offs) {
    const b = Buffer.alloc(part);
    const { bytesRead } = await fh.read(b, 0, part, o);
    bufs.push(b.subarray(0, bytesRead));
  }
  return Buffer.concat(bufs);
}

function brotliAsync(buf, params) {
  return new Promise((res, rej) => zlib.brotliCompress(buf, { params }, (e, out) => (e ? rej(e) : res(out))));
}

// Perkiraan penghematan (0..1) dari contoh berkas. Tidak melihat ekstensi: .jpg yang diganti nama jadi .txt tetap terdeteksi.
async function probe(file, size) {
  if (size === 0) return 0;
  const fh = await fs.promises.open(file, 'r');
  let sample;
  try { sample = await readSample(fh, size); } finally { await fh.close(); }
  if (!sample.length) return 0;
  const out = await brotliAsync(sample, brotliParams({ level: PROBE_LEVEL, lgwin: LGWIN }, sample.length));
  return Math.max(0, 1 - out.length / sample.length);
}

// pack(src, dst, { kind, signal, onProgress, level })
// Mengembalikan { meta, path }: path = berkas yang harus dikirim. Mode 'br' -> dst (berkas baru); mode 'raw' -> src sendiri
// (tidak ada salinan, dst tidak dibuat). onProgress({done, total}) memakai ukuran asli. Proses berjalan async di thread pool zlib,
// jadi loop event (UI/jaringan) tidak macet. `level` hanya untuk pengujian.
async function pack(src, dst, opts = {}) {
  const st = await fs.promises.stat(src);
  if (!st.isFile()) throw new PackError('meta', 'bukan berkas biasa: ' + src);
  const size = st.size;
  if (opts.kind) checkLimit(size, opts.kind);
  const progress = throttled(opts.onProgress, size);
  const changed = () => new PackError('changed', 'berkas berubah saat dibaca');

  const saving = await probe(src, size);
  if (saving >= MIN_SAVING) {
    const p = plan(size);
    if (opts.level) p.level = opts.level;
    const part = dst + '.part';
    const tin = tap({ max: size, over: changed, hash: true, onBytes: progress });
    const tout = tap({ over: changed });
    try {
      await pipeline(
        fs.createReadStream(src, { highWaterMark: CHUNK }),
        tin,
        zlib.createBrotliCompress({ chunkSize: CHUNK, params: brotliParams(p, size) }),
        tout,
        fs.createWriteStream(part),
        { signal: opts.signal },
      );
      if (tin.bytes !== size) throw changed();
      const meta = { v: FORMAT, mode: 'br', size, psize: tout.bytes, hash: tin.digest() };
      if (meta.psize <= size * (1 - MIN_SAVING)) {
        await fs.promises.rename(part, dst);
        if (opts.onProgress) opts.onProgress({ done: size, total: size });
        return { meta, path: dst };
      }
      // Contoh meleset (hasil penuh tidak cukup hemat): buang hasil, kirim apa adanya.
      await rmQuiet(part);
      if (opts.onProgress) opts.onProgress({ done: size, total: size });
      return { meta: { v: FORMAT, mode: 'raw', size, psize: size, hash: meta.hash }, path: src };
    } catch (e) {
      await rmQuiet(part);
      throw e;
    }
  }

  // raw: cukup hitung hash (tetap perlu untuk verifikasi di penerima).
  const tin = tap({ max: size, over: changed, hash: true, onBytes: progress });
  await pipeline(fs.createReadStream(src, { highWaterMark: CHUNK }), tin, async function (source) { for await (const _ of source); }, { signal: opts.signal });
  if (tin.bytes !== size) throw changed();
  if (opts.onProgress) opts.onProgress({ done: size, total: size });
  return { meta: { v: FORMAT, mode: 'raw', size, psize: size, hash: tin.digest() }, path: src };
}

function checkMeta(meta, maxSize) {
  const bad = (m) => new PackError('meta', 'meta tidak valid: ' + m);
  if (!meta || typeof meta !== 'object') throw bad('kosong');
  if (meta.v !== FORMAT) throw bad('versi ' + meta.v);
  if (meta.mode !== 'br' && meta.mode !== 'raw') throw bad('mode ' + meta.mode);
  const isInt = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!isInt(meta.size) || !isInt(meta.psize)) throw bad('ukuran');
  if (meta.size > maxSize) throw new PackError('limit', 'ukuran asli ' + fmtMB(meta.size) + ' melebihi batas ' + fmtMB(maxSize));
  if (meta.mode === 'raw' && meta.psize !== meta.size) throw bad('raw harus psize == size');
  if (typeof meta.hash !== 'string' || !/^[0-9a-f]{64}$/.test(meta.hash)) throw bad('hash');
}

// unpack(src, dst, meta, { kind, signal, onProgress })
// Hasil ditulis ke dst + '.part' lalu di-rename ke dst hanya bila ukuran dan SHA-256 cocok; kalau gagal, tidak ada berkas yang tertinggal.
// Pengaman bom kompresi: keluaran dihentikan begitu melebihi meta.size (tidak pernah menampung lebih dari itu di RAM maupun disk).
async function unpack(src, dst, meta, opts = {}) {
  checkMeta(meta, LIMITS[opts.kind] !== undefined ? LIMITS[opts.kind] : Math.max(...Object.values(LIMITS)));
  const st = await fs.promises.stat(src);
  if (st.size !== meta.psize) throw new PackError('size', 'ukuran berkas ' + st.size + ' tidak sesuai daftar isi (' + meta.psize + ')');
  const progress = throttled(opts.onProgress, meta.size);
  const part = dst + '.part';
  const over = () => new PackError('bomb', 'keluaran melebihi ukuran asli di daftar isi (' + meta.size + ' byte): dibatalkan');
  const tout = tap({ max: meta.size, over, hash: true, onBytes: progress });
  const stages = [fs.createReadStream(src, { highWaterMark: CHUNK })];
  if (meta.mode === 'br') stages.push(zlib.createBrotliDecompress({ chunkSize: CHUNK }));
  stages.push(tout, fs.createWriteStream(part));
  try {
    try {
      await pipeline(...stages, { signal: opts.signal });
    } catch (e) {
      if (e instanceof PackError || e.name === 'AbortError') throw e;
      throw new PackError('corrupt', 'data rusak atau terpotong: ' + e.message);
    }
    if (tout.bytes !== meta.size) throw new PackError('size', 'ukuran hasil ' + tout.bytes + ' != ' + meta.size);
    if (tout.digest() !== meta.hash) throw new PackError('hash', 'hash tidak cocok: berkas rusak atau diubah');
    await fs.promises.rename(part, dst);
    if (opts.onProgress) opts.onProgress({ done: meta.size, total: meta.size });
    return meta;
  } catch (e) {
    await rmQuiet(part);
    throw e;
  }
}

module.exports = { pack, unpack, probe, plan, checkLimit, checkMeta, quotaCost, PackError, LIMITS, BIG_FILE, MIN_SAVING, PROBE_BYTES };
