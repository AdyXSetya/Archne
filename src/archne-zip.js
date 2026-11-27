'use strict';
// src/archne-zip.js — pembaca dan penulis ZIP tanpa dependensi (0.34.0 Fase U2), di atas zlib bawaan Node (seperti archne-pack.js).
// MURNI format: tidak tahu apa-apa tentang folder situs. Pemetaan nama -> jalur situs (zip-slip, symlink, nama tak sah) ada di src/archne-ipc-webfiles.js lewat WebFiles.
//
// PEMBACA (ekstraksi dari sumber tak tepercaya). Prinsip: header hanya KLAIM; yang dipercaya hanya byte yang benar-benar terbaca dan terurai.
//   - Direktori pusat dibaca dari EOCD (komentar harus tepat sampai akhir berkas); disk ganda, ZIP64, dan jumlah entri di luar batas ditolak seluruhnya.
//   - Header lokal diperiksa lawan direktori pusat (tanda tangan + nama sama); rentang data tiap entri harus di dalam berkas dan TIDAK tumpang tindih (zip quine / bom tumpang tindih).
//   - Terurai dengan batas keras: keluaran inflate tidak boleh melebihi ukuran yang dinyatakan (maxOutputLength), hasilnya harus sama persis dengan ukuran dan CRC-32 yang dinyatakan.
//   - Batas bom: jumlah entri, ukuran total terurai, ukuran per berkas, dan rasio kompresi (per entri besar dan total).
//   - Entri terenkripsi, metode selain simpan / deflate, dan tautan simbolik (atribut Unix) ditandai per entri (flag), bukan menggagalkan seluruh arsip; pemanggil memutuskan.
// PENULIS: aliran per berkas (memori tetap kecil), tanpa ZIP64 (di atas 4 GB ditolak), nama UTF-8 (flag bit 11), berkas yang sudah terkompresi (jpg, mp4, zip, ...) disimpan apa adanya. Ditulis ke berkas sementara lalu di-rename.
const fs = require('fs'), zlib = require('zlib'), crypto = require('crypto');
const { promisify } = require('util');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const inflateRaw = promisify(zlib.inflateRaw);

const MB = 1048576;
const LIMITS = { entries: 10000, total: 300 * MB, file: 50 * MB, ratioFile: 200, ratioMin: 1 * MB, ratioTotal: 200, ratioTotalMin: 10 * MB, cd: 16 * MB, exportTotal: 1024 * MB };
const U32 = 0xffffffff;

class ZipError extends Error { constructor(code, msg) { super(msg); this.name = 'ZipError'; this.code = code; } }
const bad = (msg) => new ZipError('bad', msg || 'arsip ZIP rusak atau tidak dikenal');

// ---- CRC-32 (tabel; bisa dilanjutkan: crc32(b2, crc32(b1)) === crc32(b1 + b2)) ----
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf, prev) {
  let c = ((prev || 0) ^ U32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ U32) >>> 0;
}

// ---- Pembaca ----
// read(off, len) -> Buffer berpanjang TEPAT len (sinkron); size = ukuran arsip. Mengembalikan { entries, total, cdOff, size }.
// entri: { name, nameBuf, method, flags, crc, csize, usize, off, dir, enc, link, special, nameOk }
function openZip(read, size, lim) {
  const L = Object.assign({}, LIMITS, lim || {});
  const rd = (off, len) => { const b = read(off, len); if (!b || b.length !== len) throw bad('arsip terpotong'); return b; };
  if (!Number.isSafeInteger(size) || size < 22) throw bad('berkas ini bukan arsip ZIP');
  if (size >= 0x100000000) throw new ZipError('zip64', 'ZIP64 (arsip di atas 4 GB) belum didukung');
  const tailLen = Math.min(size, 22 + 0xffff), tailOff = size - tailLen, tail = rd(tailOff, tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tailLen) { e = i; break; } // komentar harus tepat sampai akhir berkas
  }
  if (e < 0) throw bad('berkas ini bukan arsip ZIP');
  const disk = tail.readUInt16LE(e + 4), cdDisk = tail.readUInt16LE(e + 6), nHere = tail.readUInt16LE(e + 8), n = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) throw new ZipError('zip64', 'ZIP64 belum didukung');
  if (n === 0xffff || cdSize === U32 || cdOff === U32) throw new ZipError('zip64', 'ZIP64 belum didukung');
  if (disk !== 0 || cdDisk !== 0 || nHere !== n) throw bad('arsip beberapa bagian tidak didukung');
  if (n > L.entries) throw new ZipError('many', 'terlalu banyak entri di dalam arsip (maksimal ' + L.entries + ')');
  const eocdAt = tailOff + e;
  if (cdSize > L.cd || cdOff + cdSize > eocdAt) throw bad('direktori arsip tidak sah');
  const cd = n ? rd(cdOff, cdSize) : Buffer.alloc(0);
  const entries = []; let p = 0, total = 0, csum = 0;
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < n; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw bad('direktori arsip rusak');
    const madeBy = cd.readUInt16LE(p + 4), flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), dsk = cd.readUInt16LE(p + 34), ext = cd.readUInt32LE(p + 38), off = cd.readUInt32LE(p + 42);
    if (p + 46 + nl + xl + cl > cd.length) throw bad('direktori arsip rusak');
    if (csize === U32 || usize === U32 || off === U32) throw new ZipError('zip64', 'ZIP64 belum didukung');
    if (dsk !== 0) throw bad('arsip beberapa bagian tidak didukung');
    const nameBuf = Buffer.from(cd.subarray(p + 46, p + 46 + nl));
    let name = '', nameOk = true; try { name = dec.decode(nameBuf); } catch { nameOk = false; } // bukan UTF-8 sah (mis. CP437) = nama tak sah (dilewati per entri)
    const mode = (madeBy >> 8) === 3 ? (ext >>> 16) & 0xffff : 0, fmt = mode & 0xf000;
    const dir = nameOk && name.endsWith('/') ? true : false;
    entries.push({ name, nameBuf, nameOk, method, flags, crc, csize, usize, off, dir, enc: (flags & 0x41) !== 0, link: fmt === 0xa000, special: fmt !== 0 && fmt !== 0x8000 && fmt !== 0x4000 && fmt !== 0xa000 });
    total += usize; csum += csize; p += 46 + nl + xl + cl;
  }
  if (p !== cd.length) throw bad('direktori arsip rusak');
  // Rentang data: di dalam berkas, tidak tumpang tindih.
  const order = entries.map((x, i) => i).sort((a, b) => entries[a].off - entries[b].off);
  let prevEnd = 0;
  for (const i of order) {
    const x = entries[i], minEnd = x.off + 30 + x.nameBuf.length + x.csize;
    if (x.off < prevEnd || minEnd > cdOff) throw bad('entri arsip tumpang tindih atau di luar berkas');
    prevEnd = minEnd;
  }
  if (total > L.total) throw new ZipError('zipbig', 'isi arsip terlalu besar setelah diurai (maksimal ' + Math.round(L.total / MB) + ' MB)');
  if (total > L.ratioTotalMin && total / Math.max(1, size) > L.ratioTotal) throw new ZipError('bomb', 'arsip ditolak: rasio kompresi tidak wajar (kemungkinan zip bomb)');
  for (const x of entries) if (!x.dir && x.usize > L.ratioMin && x.usize / Math.max(1, x.csize) > L.ratioFile) throw new ZipError('bomb', 'arsip ditolak: rasio kompresi tidak wajar (kemungkinan zip bomb)');
  return { entries, total, cdOff, size, lim: L };
}

// Isi satu entri (Buffer). Melempar ZipError bila terenkripsi / metode tak didukung / lebih besar dari batas berkas / header tak cocok / CRC atau ukuran salah.
async function readEntry(zip, read, x) {
  const L = zip.lim;
  if (x.dir) throw bad('entri ini folder');
  if (x.enc) throw new ZipError('enc', 'entri terenkripsi tidak didukung');
  if (x.method !== 0 && x.method !== 8) throw new ZipError('method', 'metode kompresi tidak didukung');
  if (x.usize > L.file) throw new ZipError('big', 'berkas terlalu besar (maksimal ' + Math.round(L.file / MB) + ' MB per berkas)');
  if (x.method === 0 && x.csize !== x.usize) throw bad('ukuran entri tidak cocok');
  if (x.csize > L.file + MB) throw new ZipError('big', 'berkas terlalu besar');
  const rd = (off, len) => { const b = read(off, len); if (!b || b.length !== len) throw bad('arsip terpotong'); return b; };
  const h = rd(x.off, 30);
  if (h.readUInt32LE(0) !== 0x04034b50) throw bad('header entri rusak');
  const nl = h.readUInt16LE(26), xl = h.readUInt16LE(28);
  if (nl !== x.nameBuf.length || !rd(x.off + 30, nl).equals(x.nameBuf)) throw bad('header entri tidak cocok dengan direktori');
  const start = x.off + 30 + nl + xl;
  if (start + x.csize > zip.cdOff) throw bad('data entri di luar berkas');
  const raw = x.csize ? rd(start, x.csize) : Buffer.alloc(0);
  let out;
  if (x.method === 0) out = raw;
  else {
    try { out = x.usize === 0 && x.csize === 0 ? Buffer.alloc(0) : await inflateRaw(raw, { maxOutputLength: Math.max(1, x.usize) }); }
    catch (e) { throw bad(e && e.code === 'ERR_BUFFER_TOO_LARGE' ? 'isi entri lebih besar dari yang dinyatakan' : 'data entri rusak'); }
  }
  if (out.length !== x.usize) throw bad('ukuran isi entri tidak cocok');
  if (crc32(out) !== x.crc) throw new ZipError('crc', 'isi entri rusak (CRC tidak cocok)');
  return out;
}

// ---- Penulis ----
const STORE_RE = /\.(zip|gz|tgz|bz2|xz|7z|rar|zst|jpe?g|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|oga|opus|flac|mp4|m4v|mov|webm|mkv|ogv|woff2?|br|jar|apk|pdf)$/i;
const CH = 1 * MB;
function dosTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function localHeader(nameBuf, f) {
  const b = Buffer.alloc(30 + nameBuf.length);
  b.writeUInt32LE(0x04034b50, 0); b.writeUInt16LE(20, 4); b.writeUInt16LE(0x0800, 6); b.writeUInt16LE(f.method, 8); b.writeUInt16LE(f.time, 10); b.writeUInt16LE(f.date, 12);
  b.writeUInt32LE(f.crc >>> 0, 14); b.writeUInt32LE(f.csize, 18); b.writeUInt32LE(f.usize, 22); b.writeUInt16LE(nameBuf.length, 26); b.writeUInt16LE(0, 28);
  nameBuf.copy(b, 30);
  return b;
}
function centralHeader(f) {
  const b = Buffer.alloc(46 + f.nameBuf.length);
  b.writeUInt32LE(0x02014b50, 0); b.writeUInt16LE((3 << 8) | 20, 4); b.writeUInt16LE(20, 6); b.writeUInt16LE(0x0800, 8); b.writeUInt16LE(f.method, 10); b.writeUInt16LE(f.time, 12); b.writeUInt16LE(f.date, 14);
  b.writeUInt32LE(f.crc >>> 0, 16); b.writeUInt32LE(f.csize, 20); b.writeUInt32LE(f.usize, 24); b.writeUInt16LE(f.nameBuf.length, 28);
  b.writeUInt32LE(f.dir ? ((0o040755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38); b.writeUInt32LE(f.off, 42);
  f.nameBuf.copy(b, 46);
  return b;
}
async function writeAt(fh, buf, pos) { let o = 0; while (o < buf.length) { const { bytesWritten } = await fh.write(buf, o, buf.length - o, pos + o); if (!bytesWritten) throw new ZipError('io', 'gagal menulis ZIP'); o += bytesWritten; } }

// items: [{ name:'a/b.txt', size, mtime, read(off, len) -> Buffer }  |  { name:'folder', dir:true, mtime }]; nama memakai "/" tanpa awalan. Menulis ke dest (lewat berkas sementara lalu rename).
// opts: { onProgress(done, total), maxTotal }. Mengembalikan { n, size (ukuran ZIP), usize (jumlah isi) }.
async function writeZip(dest, items, opts) {
  const o = opts || {}, maxTotal = o.maxTotal || LIMITS.exportTotal;
  if (items.length > LIMITS.entries) throw new ZipError('many', 'terlalu banyak berkas untuk satu ZIP (maksimal ' + LIMITS.entries + ')');
  let sum = 0; for (const it of items) if (!it.dir) sum += it.size || 0;
  if (sum > maxTotal) throw new ZipError('zipbig', 'isi terlalu besar untuk satu ZIP (maksimal ' + Math.round(maxTotal / MB) + ' MB)');
  const tmp = dest + '.' + crypto.randomBytes(6).toString('hex') + '.part';
  const fh = await fs.promises.open(tmp, 'wx');
  const recs = []; let pos = 0, closed = false;
  try {
    let done = 0;
    for (const it of items) {
      const nameBuf = Buffer.from(it.dir ? it.name.replace(/\/*$/, '/') : it.name, 'utf8'), t = dosTime(it.mtime);
      if (nameBuf.length > 0xffff) throw new ZipError('name', 'nama terlalu panjang');
      const off = pos;
      if (off > U32 - 1) throw new ZipError('big', 'ZIP melebihi 4 GB (belum didukung)');
      if (it.dir) {
        const f = { nameBuf, method: 0, crc: 0, csize: 0, usize: 0, off, dir: true, time: t.time, date: t.date };
        const h = localHeader(nameBuf, f); await writeAt(fh, h, pos); pos += h.length; recs.push(f);
      } else {
        if (it.size > U32 - 1) throw new ZipError('big', 'ada berkas di atas 4 GB (belum didukung)');
        const method = STORE_RE.test(it.name) ? 0 : 8, f = { nameBuf, method, crc: 0, csize: 0, usize: 0, off, dir: false, time: t.time, date: t.date };
        const h0 = localHeader(nameBuf, f); await writeAt(fh, h0, pos); const dataAt = pos + h0.length; let w = dataAt;
        async function* chunks() {
          for (let c = 0; c < it.size; c += CH) {
            const len = Math.min(CH, it.size - c), b = it.read(c, len);
            if (!b || b.length !== len) throw new ZipError('changed', 'berkas berubah saat dibaca');
            f.crc = crc32(b, f.crc); f.usize += b.length; yield b;
          }
        }
        const sink = new Writable({ write(chunk, _e, cb) { writeAt(fh, chunk, w).then(() => { w += chunk.length; cb(); }, cb); } });
        if (method === 8) await pipeline(Readable.from(chunks(), { objectMode: false }), zlib.createDeflateRaw({ level: 6 }), sink);
        else await pipeline(Readable.from(chunks(), { objectMode: false }), sink);
        f.csize = w - dataAt;
        if (f.usize !== it.size) throw new ZipError('changed', 'berkas berubah saat dibaca');
        await writeAt(fh, localHeader(nameBuf, f), off); // isi header sebenarnya (ukuran + CRC) sekarang sudah diketahui
        pos = w; recs.push(f);
      }
      done++; if (o.onProgress) o.onProgress(done, items.length);
    }
    const cdOff = pos; let cdLen = 0;
    for (const f of recs) { const c = centralHeader(f); await writeAt(fh, c, pos); pos += c.length; cdLen += c.length; }
    if (pos > U32 - 22) throw new ZipError('big', 'ZIP melebihi 4 GB (belum didukung)');
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(recs.length, 8); eo.writeUInt16LE(recs.length, 10); eo.writeUInt32LE(cdLen, 12); eo.writeUInt32LE(cdOff, 16);
    await writeAt(fh, eo, pos); pos += 22;
    await fh.close(); closed = true;
    await fs.promises.rename(tmp, dest);
    return { n: recs.length, size: pos, usize: sum };
  } catch (e) {
    if (!closed) { try { await fh.close(); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

module.exports = { openZip, readEntry, writeZip, crc32, ZipError, LIMITS, STORE_RE };
