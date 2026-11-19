'use strict';
// 5d-1: format arsip halaman (ekspor/impor). Hanya WADAH: tidak tahu apa itu postingan, komentar, atau store. 5d-2 mengisinya, 5d-3/4 membacanya.
// Tanpa dependensi, tanpa ?. / ?? (cangkang Android memakai Node 12).
//
// Tata letak berkas (satu lintasan tulis; berkas 2 GiB tidak pernah dimuat utuh ke memori):
//   MAGIC (8)                                 'ARCHPGA1'
//   isi entri 1 | isi entri 2 | ...           berurutan rapat, tanpa jarak, tanpa pembatas
//   manifest (JSON utf8)                      { v:1, created, meta, entries:[{ n: nama, o: posisi, s: ukuran, h: sha256 heks }] }
//   footer (52)                               'ARCHPGZ1' | posisi manifest (hi u32, lo u32) | panjang manifest (u32) | sha256(manifest) (32)
// Manifest di BELAKANG supaya penulis cukup satu lintasan (hash dihitung sambil menulis). Pembaca membaca footer dulu (seek), jadi daftar isi
// tersedia sebelum satu byte isi pun dibaca: itulah dasar tahap periksa (5d-3).
//
// Aturan pembaca (arsip adalah masukan TIDAK DIPERCAYA): footer + manifest + hash manifest harus cocok; tepat tanpa sisa di belakang footer; nama aman
// (tanpa '..', tanpa '/' di depan, tanpa karakter aneh); nama unik; entri berurutan dan rapat dari byte 8 sampai awal manifest (tidak ada byte tersembunyi,
// tidak ada tumpang tindih); jumlah dan ukuran manifest dibatasi. Isi baru terbukti utuh SETELAH read() selesai tanpa melempar: pemanggil menulis ke berkas
// sementara dan baru memakainya sesudah itu.
const fs = require('fs');
const crypto = require('crypto');

const MAGIC = Buffer.from('ARCHPGA1');
const FOOT_MAGIC = Buffer.from('ARCHPGZ1');
const FOOT_LEN = 8 + 4 + 4 + 4 + 32;
const HEAD_LEN = MAGIC.length;
const FORMAT = 1;
const ENTRIES_MAX = 200000;
const MANIFEST_MAX = 32 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const BUF_MAX = 16 * 1024 * 1024; // bawaan batas readBuffer
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}){0,3}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TWO32 = 4294967296;

class ArcError extends Error {
  constructor(code, msg) { super(msg); this.name = 'ArcError'; this.code = code; } // code: bad | hash | size | name | limit | abort | dead | io
}
const bad = (m) => new ArcError('bad', m);
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const okName = (n) => typeof n === 'string' && n.length <= 200 && NAME_RE.test(n) && n.split('/').every((s) => s !== '..' && s !== '.');
const isUInt = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

function encFoot(off, len, mh) {
  const b = Buffer.alloc(FOOT_LEN);
  FOOT_MAGIC.copy(b, 0);
  b.writeUInt32BE(Math.floor(off / TWO32), 8); b.writeUInt32BE(off % TWO32, 12);
  b.writeUInt32BE(len, 16);
  mh.copy(b, 20);
  return b;
}
function decFoot(b) {
  if (!Buffer.isBuffer(b) || b.length !== FOOT_LEN || !b.slice(0, 8).equals(FOOT_MAGIC)) return null;
  const off = b.readUInt32BE(8) * TWO32 + b.readUInt32BE(12);
  if (!Number.isSafeInteger(off)) return null;
  return { off, len: b.readUInt32BE(16), hash: b.slice(20, 52) };
}

async function readAt(fh, buf, pos) {
  let got = 0;
  while (got < buf.length) {
    const r = await fh.read(buf, got, buf.length - got, pos + got);
    if (!r.bytesRead) throw bad('arsip terpotong');
    got += r.bytesRead;
  }
}
const aborted = (sig) => { if (sig && sig.aborted) throw new ArcError('abort', 'dibatalkan'); };

class ArcWriter {
  constructor(file, tmp, fh) { this.file = file; this.tmp = tmp; this.fh = fh; this.pos = HEAD_LEN; this.entries = []; this.names = new Set(); this.dead = false; this.done = false; this.busy = false; }
  static async create(file) {
    if (typeof file !== 'string' || !file) throw new ArcError('bad', 'Nama berkas arsip tidak valid');
    const tmp = file + '.tmp';
    const fh = await fs.promises.open(tmp, 'w');
    try { await fh.write(MAGIC, 0, MAGIC.length, 0); } catch (e) { await fh.close().catch(() => {}); throw e; }
    return new ArcWriter(file, tmp, fh);
  }
  has(name) { return this.names.has(name); }
  _begin(name) {
    if (this.done) throw new ArcError('dead', 'arsip sudah selesai atau dibatalkan');
    if (this.dead) throw new ArcError('dead', 'arsip rusak: panggil abort()');
    if (this.busy) throw new ArcError('dead', 'penulisan sedang berjalan');
    if (!okName(name)) throw new ArcError('name', 'nama entri tidak valid');
    if (this.names.has(name)) throw new ArcError('name', 'nama entri ganda');
    if (this.entries.length >= ENTRIES_MAX) throw new ArcError('limit', 'terlalu banyak entri');
    this.busy = true;
  }
  _push(name, size, hash) { this.entries.push({ n: name, o: this.pos, s: size, h: hash }); this.names.add(name); this.pos += size; }
  async addBuffer(name, buf) {
    if (!Buffer.isBuffer(buf)) throw new ArcError('bad', 'isi entri harus Buffer');
    this._begin(name);
    try {
      let at = this.pos;
      for (let i = 0; i < buf.length; i += CHUNK) { const part = buf.slice(i, i + CHUNK); await this.fh.write(part, 0, part.length, at); at += part.length; }
      this._push(name, buf.length, sha(buf).toString('hex'));
    } finally { this.busy = false; } // gagal tulis: this.pos tidak maju, jadi sisa byte ditimpa entri berikutnya / dipangkas finish(); penulis tetap bisa dipakai
  }
  // Salin berkas disk berpotongan. opts: { signal, onBytes(n), expectSize } ; expectSize != null dan ukuran terbaca berbeda -> 'size' (berkas berubah saat disalin).
  async addFile(name, srcPath, opts) {
    opts = opts || {};
    this._begin(name);
    let src = null;
    try {
      src = await fs.promises.open(srcPath, 'r');
      const h = crypto.createHash('sha256'), buf = Buffer.alloc(CHUNK);
      let at = this.pos, total = 0;
      for (;;) {
        aborted(opts.signal);
        const r = await src.read(buf, 0, CHUNK, total);
        if (!r.bytesRead) break;
        const part = buf.slice(0, r.bytesRead);
        h.update(part);
        await this.fh.write(part, 0, part.length, at);
        at += part.length; total += part.length;
        if (typeof opts.onBytes === 'function') opts.onBytes(part.length);
      }
      if (opts.expectSize != null && total !== opts.expectSize) throw new ArcError('size', 'ukuran berkas berubah saat disalin');
      this._push(name, total, h.digest('hex'));
    } finally { this.busy = false; if (src) await src.close().catch(() => {}); } // gagal (batal, sumber hilang, ukuran berubah): entri tidak terdaftar, penulis tetap sah
  }
  // Tulis manifest + footer, sync, lalu ganti nama atomik ke berkas akhir. Sebelum ini berkas akhir TIDAK ada / tidak berubah.
  async finish(meta) {
    if (this.done) throw new ArcError('dead', 'arsip sudah selesai atau dibatalkan');
    if (this.dead || this.busy) throw new ArcError('dead', 'arsip rusak: panggil abort()');
    if (meta == null) meta = {};
    if (typeof meta !== 'object' || Array.isArray(meta)) throw new ArcError('bad', 'meta harus objek');
    this.busy = true;
    try {
      const man = Buffer.from(JSON.stringify({ v: FORMAT, created: Date.now(), meta, entries: this.entries }));
      if (man.length > MANIFEST_MAX) throw new ArcError('limit', 'manifest terlalu besar');
      await this.fh.write(man, 0, man.length, this.pos);
      const foot = encFoot(this.pos, man.length, sha(man));
      await this.fh.write(foot, 0, foot.length, this.pos + man.length);
      await this.fh.truncate(this.pos + man.length + FOOT_LEN); // buang sisa byte dari entri yang gagal
      await this.fh.sync();
      await this.fh.close();
      await fs.promises.rename(this.tmp, this.file);
      this.done = true;
      return { size: this.pos + man.length + FOOT_LEN, entries: this.entries.length };
    } catch (e) { this.dead = true; throw e; } finally { this.busy = false; }
  }
  // Buang hasil sebagian; aman dipanggil berkali-kali dan setelah finish (tidak menyentuh berkas akhir).
  async abort() {
    if (this.done) return;
    this.done = true;
    await this.fh.close().catch(() => {});
    await fs.promises.unlink(this.tmp).catch(() => {});
  }
}

// Periksa bentuk manifest (sudah lolos hash). -> { created, meta, entries, map } atau melempar ArcError('bad').
function parseManifest(buf, manOff) {
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { throw bad('manifest bukan JSON'); }
  if (!j || typeof j !== 'object' || j.v !== FORMAT) throw bad('versi arsip tidak didukung');
  if (typeof j.created !== 'number' || !Number.isFinite(j.created)) throw bad('manifest: created tidak valid');
  if (!j.meta || typeof j.meta !== 'object' || Array.isArray(j.meta)) throw bad('manifest: meta tidak valid');
  if (!Array.isArray(j.entries) || j.entries.length > ENTRIES_MAX) throw bad('manifest: daftar entri tidak valid');
  const map = new Map(), entries = [];
  let at = HEAD_LEN;
  for (const e of j.entries) {
    if (!e || typeof e !== 'object' || !okName(e.n)) throw bad('manifest: nama entri tidak aman');
    if (map.has(e.n)) throw bad('manifest: nama entri ganda');
    if (!isUInt(e.o) || !isUInt(e.s) || typeof e.h !== 'string' || !HEX64.test(e.h)) throw bad('manifest: entri tidak valid');
    if (e.o !== at) throw bad('manifest: entri tidak rapat / tumpang tindih');
    at += e.s;
    if (!Number.isSafeInteger(at) || at > manOff) throw bad('manifest: entri melewati batas');
    const c = { n: e.n, o: e.o, s: e.s, h: e.h };
    entries.push(c); map.set(c.n, c);
  }
  if (at !== manOff) throw bad('manifest: ada byte tak terdaftar');
  return { created: j.created, meta: j.meta, entries, map };
}

class ArcReader {
  constructor(file, fh, size, man) { this.file = file; this.fh = fh; this.size = size; this.created = man.created; this.meta = man.meta; this.entries = man.entries; this._map = man.map; }
  static async open(file) {
    if (typeof file !== 'string' || !file) throw bad('Nama berkas arsip tidak valid');
    const fh = await fs.promises.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      if (size < HEAD_LEN + FOOT_LEN) throw bad('arsip terlalu pendek');
      const head = Buffer.alloc(HEAD_LEN); await readAt(fh, head, 0);
      if (!head.equals(MAGIC)) throw bad('bukan arsip halaman');
      const fb = Buffer.alloc(FOOT_LEN); await readAt(fh, fb, size - FOOT_LEN);
      const f = decFoot(fb);
      if (!f) throw bad('footer tidak sah');
      if (f.len > MANIFEST_MAX || f.off < HEAD_LEN || f.off + f.len + FOOT_LEN !== size) throw bad('footer tidak cocok dengan ukuran berkas');
      const mb = Buffer.alloc(f.len); await readAt(fh, mb, f.off);
      if (!sha(mb).equals(f.hash)) throw new ArcError('hash', 'manifest rusak');
      return new ArcReader(file, fh, size, parseManifest(mb, f.off));
    } catch (e) { await fh.close().catch(() => {}); throw e; }
  }
  has(name) { return this._map.has(name); }
  info(name) { const e = this._map.get(name); return e ? { size: e.s, hash: e.h } : null; }
  names() { return this.entries.map((e) => e.n); }
  // Alirkan isi satu entri berpotongan ke onChunk(buf) (boleh async; buf dipakai ulang oleh pembaca: salin bila perlu disimpan).
  // Selesai TANPA melempar = ukuran dan SHA-256 cocok manifest. Gagal ('hash' / 'bad') = buang apa pun yang sudah ditulis dari potongan tadi.
  async read(name, onChunk, opts) {
    opts = opts || {};
    const e = this._map.get(name);
    if (!e) throw new ArcError('name', 'entri tidak ada');
    const h = crypto.createHash('sha256'), buf = Buffer.alloc(Math.min(CHUNK, Math.max(e.s, 1)));
    for (let done = 0; done < e.s;) {
      aborted(opts.signal);
      const n = Math.min(buf.length, e.s - done), part = n === buf.length ? buf : buf.slice(0, n);
      await readAt(this.fh, part, e.o + done);
      h.update(part);
      if (typeof onChunk === 'function') await onChunk(part);
      done += n;
    }
    if (h.digest('hex') !== e.h) throw new ArcError('hash', 'isi entri rusak: ' + name);
  }
  async verify(name, opts) { await this.read(name, null, opts); }
  async verifyAll(opts) { for (const e of this.entries) await this.verify(e.n, opts); }
  // Baca satu entri kecil utuh ke memori (terverifikasi). max = batas keras (bawaan 16 MiB); entri lebih besar -> 'limit' SEBELUM dibaca.
  async readBuffer(name, max) {
    const e = this._map.get(name);
    if (!e) throw new ArcError('name', 'entri tidak ada');
    if (e.s > (max == null ? BUF_MAX : max)) throw new ArcError('limit', 'entri lebih besar dari batas');
    const out = Buffer.alloc(e.s); let at = 0;
    await this.read(name, (c) => { c.copy(out, at); at += c.length; });
    return out;
  }
  async close() { await this.fh.close().catch(() => {}); }
}

module.exports = { ArcWriter, ArcReader, ArcError, okName, encFoot, decFoot, MAGIC, FOOT_MAGIC, FOOT_LEN, HEAD_LEN, FORMAT, ENTRIES_MAX, MANIFEST_MAX, CHUNK, BUF_MAX };
