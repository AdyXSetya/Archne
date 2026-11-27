'use strict';
// Web Lokal (Fase B.2): operasi berkas di dalam www/ satu situs. Murni lokal: tanpa jaringan, tanpa UI.
// SATU PINTU validasi: setiap operasi memanggil normRel() dulu, lalu menelusuri jalur per tingkat (lstat) dan menolak symlink di mana pun.
// Aturan jalur (keamanan, BUKAN batas produk; jumlah dan ukuran berkas tidak dibatasi): relatif ke www/, pemisah hanya "/", tanpa ".." atau ".", tanpa jalur absolut / UNC / huruf drive,
//   tanpa karakter kontrol, \0, ":", "\\", <>"|?*, tanpa pembalik arah dan karakter tak terlihat, tanpa akhiran titik atau spasi, tanpa nama perangkat Windows (CON, NUL, COM1, ...),
//   tanpa pengodean persen yang membongkar jadi titik / garis miring / titik dua, tabrakan huruf besar-kecil ditolak (Windows tidak peka huruf), kedalaman <= 12, jalur <= 240 karakter.
// Penulisan atomik: isi ditulis ke tmp/ (saudara www/, satu volume) lalu rename, jadi pembaca tidak pernah melihat berkas setengah jadi dan www/ tidak pernah berisi sisa .tmp.
// Batas yang diketahui: telusur lalu operasi bukan satu langkah atomik (TOCTOU). Penyerang yang bisa mengganti folder situs di disk pemilik sudah punya akses lokal; ancaman yang dijaga di sini = nama jalur kiriman/unggahan.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ek } = require('./core/archne-ecode');

const MAX_DEPTH = 12, MAX_PATH = 240, MAX_SEG = 120;
const BAD_CHAR = /[\u0000-\u001f\u007f-\u009f<>:"|?*\\\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffd]/;
const WIN_DEV = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const E_PATH = () => ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path');

// Satu nama (tanpa "/"). Mengembalikan true bila aman dipakai sebagai nama berkas/folder.
function segOk(s, depth = 0) {
  if (typeof s !== 'string' || !s || s.length > MAX_SEG || depth > 3) return false;
  if (s === '.' || s === '..' || /[. ]$/.test(s) || s[0] === ' ') return false;
  if (BAD_CHAR.test(s) || s.includes('/') || WIN_DEV.test(s)) return false;
  if (typeof s.isWellFormed === 'function' && !s.isWellFormed()) return false;
  if (s.includes('%')) { // "%2e%2e", "%2F", "%5c", "%00", dan pengodean ganda tidak boleh membongkar jadi sesuatu yang berbahaya
    let d;
    try { d = decodeURIComponent(s); } catch { return depth > 0; } // gagal bongkar di tingkat pertama = pengodean cacat (%ff) ditolak; di tingkat dalam = "%" polos hasil bongkar (mis. 100%25), sah
    if (d !== s && !segOk(d, depth + 1)) return false;
  }
  return true;
}
// Jalur relatif bersih (NFC) atau melempar galat 'path'. allowRoot: "" = folder utama www/.
function normRel(p, allowRoot) {
  if (typeof p !== 'string') throw E_PATH();
  if (p === '') { if (allowRoot) return ''; throw E_PATH(); }
  p = p.normalize('NFC');
  if (p.length > MAX_PATH) throw E_PATH();
  const segs = p.split('/');
  if (segs.length > MAX_DEPTH) throw E_PATH();
  for (const s of segs) if (!segOk(s)) throw E_PATH(); // segmen kosong (awal "/", "//", akhir "/") juga gagal di sini
  return p;
}
const tryRel = (p) => { try { return normRel(p, false); } catch { return null; } };
const fold = (s) => s.normalize('NFC').toLowerCase();

class WebFiles {
  // root = folder www/ (absolut), tmp = folder sementara di volume yang sama, onChange(kind, rel) dipanggil setelah tiap perubahan berhasil.
  constructor(root, tmp, onChange) {
    this.root = path.resolve(root); this.tmp = path.resolve(tmp); this.onChange = typeof onChange === 'function' ? onChange : null;
    fs.mkdirSync(this.root, { recursive: true }); fs.mkdirSync(this.tmp, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink() || fs.lstatSync(this.tmp).isSymbolicLink()) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    for (const f of fs.readdirSync(this.tmp)) { try { fs.rmSync(path.join(this.tmp, f), { force: true }); } catch {} } // sisa penulisan yang terputus
  }
  // hold()/release(): kumpulkan banyak perubahan (unggah, hapus massal) menjadi SATU panggilan onChange, supaya rev naik sekali dan site.json ditulis sekali.
  hold() { this._hold = (this._hold || 0) + 1; }
  release() { if (this._hold > 0 && --this._hold === 0 && this._pend) { this._pend = false; if (this.onChange) this.onChange('batch', ''); } }
  _changed(kind, rel) { if (this._hold) { this._pend = true; return; } if (this.onChange) this.onChange(kind, rel); }
  // Telusuri per tingkat. Semua leluhur yang ADA harus folder biasa (bukan symlink). Bila create, leluhur yang belum ada dibuat satu per satu.
  // Mengembalikan { abs, st } dengan st = lstat jalur akhir atau null bila belum ada.
  _prep(rel, create) {
    let cur = this.root;
    const segs = rel === '' ? [] : rel.split('/');
    for (let i = 0; i < segs.length; i++) {
      const next = path.join(cur, segs[i]), last = i === segs.length - 1;
      let st = null;
      try { st = fs.lstatSync(next); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // Windows/macOS tidak peka huruf: lstat("foto.png") menemukan "Foto.PNG". Agar perilakunya SAMA di semua OS, nama harus cocok persis dengan yang ada di disk; kalau tidak, dianggap belum ada
      // (pembuat nama baru lalu ditolak oleh _collide sebagai tabrakan huruf besar-kecil, pembaca mendapat "tidak ditemukan").
      if (st && !fs.readdirSync(cur).some((e) => e.normalize('NFC') === segs[i])) st = null;
      if (st && st.isSymbolicLink() && !last) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
      if (!st) {
        if (last) return { abs: next, st: null, parent: cur };
        if (!create) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
        this._collide(cur, segs[i]);
        fs.mkdirSync(next); // bukan recursive: tiap tingkat sudah diperiksa
        st = fs.lstatSync(next);
      } else if (!last && !st.isDirectory()) throw ek('e.lw.notDir', null, 'Bukan folder', 'notdir');
      if (last) return { abs: next, st, parent: cur };
      cur = next;
    }
    return { abs: cur, st: fs.lstatSync(cur), parent: path.dirname(cur) }; // root
  }
  // Nama baru tidak boleh hanya beda huruf besar-kecil dari saudara yang sudah ada (selain `self`, nama sumber saat ganti nama).
  _collide(parentAbs, name, self) {
    const f = fold(name);
    for (const e of fs.readdirSync(parentAbs)) if (e !== name && e !== self && fold(e) === f) throw ek('e.lw.pathCase', null, 'Sudah ada nama yang hanya beda huruf besar-kecil', 'case');
  }
  _inside(abs) { const r = path.relative(this.root, abs); if (r.startsWith('..') || path.isAbsolute(r)) throw E_PATH(); }

  stat(rel) {
    const p = normRel(rel, true);
    let r;
    try { r = this._prep(p, false); } catch (e) { if (e.code === 'nofile') return null; throw e; } // leluhur tidak ada = tidak ada (sama dengan jalur akhir yang tidak ada)
    if (!r.st) return null;
    return { type: r.st.isDirectory() ? 'dir' : r.st.isFile() ? 'file' : 'other', size: r.st.size, mtime: Math.floor(r.st.mtimeMs) };
  }
  // Isi satu folder: folder dulu, lalu berkas, urut nama. Symlink dan nama yang tidak lolos aturan jalur tidak ditampilkan (tidak bisa dialamati dengan aman).
  list(rel = '') {
    const p = normRel(rel, true), r = this._prep(p, false);
    if (!r.st) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
    if (!r.st.isDirectory()) throw ek('e.lw.notDir', null, 'Bukan folder', 'notdir');
    const out = [];
    for (const name of fs.readdirSync(r.abs)) {
      if (!segOk(name.normalize('NFC'))) continue;
      let st; try { st = fs.lstatSync(path.join(r.abs, name)); } catch { continue; }
      if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) continue;
      out.push({ name, type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : 0, mtime: Math.floor(st.mtimeMs) });
    }
    return out.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || (fold(a.name) < fold(b.name) ? -1 : fold(a.name) > fold(b.name) ? 1 : 0));
  }
  // Baca satu berkas. max (opsional) melindungi memori saat membuka untuk diedit; lebih besar = galat 'big'. O_NOFOLLOW (bila ada) menutup celah tukar-jadi-symlink setelah lstat.
  read(rel, opts) {
    const p = normRel(rel, false), r = this._prep(p, false);
    if (!r.st) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
    if (r.st.isSymbolicLink()) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    if (!r.st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
    const max = opts && Number.isFinite(opts.max) ? opts.max : Infinity;
    const fd = fs.openSync(r.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
      if (st.size > max) throw ek('e.lw.tooBig', null, 'Berkas terlalu besar untuk dibuka di sini', 'big');
      const buf = Buffer.allocUnsafe(st.size);
      let got = 0;
      while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, got); if (n <= 0) break; got += n; }
      return got === buf.length ? buf : buf.subarray(0, got);
    } finally { fs.closeSync(fd); }
  }
  // Potongan byte [off, off+len) satu berkas (untuk lw_file, Fase C). Mengembalikan { total, off, buf } atau null bila off di luar berkas (off === total hanya sah untuk berkas kosong).
  // Memakai satu pintu yang sama dengan read(): normRel, telusur per tingkat, tanpa symlink, O_NOFOLLOW. Galat jalur/berkas dilempar seperti read().
  readRange(rel, off, len) {
    const p = normRel(rel, false), r = this._prep(p, false);
    if (!r.st) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
    if (r.st.isSymbolicLink()) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    if (!r.st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
    if (!Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len) || len < 0) throw E_PATH();
    const fd = fs.openSync(r.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
      const total = st.size;
      if (off > total || (off === total && total > 0)) return null;
      const n = Math.min(len, total - off), buf = Buffer.allocUnsafe(n);
      let got = 0;
      while (got < n) { const k = fs.readSync(fd, buf, got, n - got, off + got); if (k <= 0) break; got += k; }
      return { total, off, buf: got === n ? buf : buf.subarray(0, got) };
    } finally { fs.closeSync(fd); }
  }
  // SHA-256 isi satu berkas (heks), dibaca per 1 MB secara async supaya berkas besar tidak membekukan proses. Mengembalikan { size, mtime, hash }; size = jumlah byte yang benar-benar terbaca.
  async digest(rel) {
    const p = normRel(rel, false), r = this._prep(p, false);
    if (!r.st) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
    if (r.st.isSymbolicLink()) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    if (!r.st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
    const fh = await fs.promises.open(r.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
      const h = crypto.createHash('sha256'), buf = Buffer.allocUnsafe(1 << 20);
      let pos = 0;
      for (;;) { const { bytesRead } = await fh.read(buf, 0, buf.length, pos); if (!bytesRead) break; h.update(buf.subarray(0, bytesRead)); pos += bytesRead; }
      return { size: pos, mtime: Math.floor(st.mtimeMs), hash: h.digest('hex') };
    } finally { await fh.close(); }
  }
  mkdir(rel) {
    const p = normRel(rel, false), r = this._prep(p, true);
    if (r.st) throw ek('e.lw.pathExists', null, 'Sudah ada berkas atau folder dengan nama itu', 'exists');
    this._collide(r.parent, path.basename(r.abs));
    fs.mkdirSync(r.abs);
    this._changed('mkdir', p);
  }
  // Tulis (atau timpa) satu berkas. data = Buffer / Uint8Array / string (UTF-8). Leluhur yang belum ada dibuat.
  write(rel, data) {
    const p = normRel(rel, false);
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    else if (!(data instanceof Uint8Array)) throw ek('e.lw.dataBad', null, 'Isi berkas tidak valid', 'data');
    const r = this._prep(p, true);
    if (r.st && r.st.isSymbolicLink()) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    if (r.st && !r.st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
    if (!r.st) this._collide(r.parent, path.basename(r.abs));
    this._inside(r.abs);
    const tmp = path.join(this.tmp, crypto.randomBytes(8).toString('hex'));
    try { fs.writeFileSync(tmp, data, { flag: 'wx' }); fs.renameSync(tmp, r.abs); }
    catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
    this._changed('write', p);
  }
  // Salin satu berkas dari disk (srcAbs, sudah disetujui pemanggil: dialog / seret-lepas) ke jalur rel di www/. Async + lewat tmp/ supaya berkas besar tidak membekukan proses dan pembaca tidak pernah melihat setengah jadi.
  // Sumber symlink / bukan berkas ditolak. opts.overwrite: timpa berkas yang sudah ada (bawaan: galat 'exists'). Leluhur yang belum ada dibuat.
  async importFile(rel, srcAbs, opts) {
    const p = normRel(rel, false);
    let ls; try { ls = await fs.promises.lstat(srcAbs); } catch { throw ek('e.lw.srcNone', null, 'Sumber unggahan tidak ditemukan', 'srcnone'); }
    if (ls.isSymbolicLink() || !ls.isFile()) throw ek('e.lw.srcBad', null, 'Sumber unggahan tidak diizinkan', 'src');
    const r = this._prep(p, true);
    if (r.st && r.st.isSymbolicLink()) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    if (r.st && !r.st.isFile()) throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
    if (r.st && !(opts && opts.overwrite)) throw ek('e.lw.pathExists', null, 'Sudah ada berkas atau folder dengan nama itu', 'exists');
    if (!r.st) this._collide(r.parent, path.basename(r.abs));
    this._inside(r.abs);
    const tmp = path.join(this.tmp, crypto.randomBytes(8).toString('hex'));
    try { await fs.promises.copyFile(srcAbs, tmp, fs.constants.COPYFILE_EXCL); await fs.promises.rename(tmp, r.abs); }
    catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
    this._changed('write', p);
    return { size: ls.size };
  }
  // Ganti nama di folder yang sama. newName = satu nama (tanpa "/").
  rename(rel, newName) {
    const p = normRel(rel, false);
    if (!segOk(typeof newName === 'string' ? newName.normalize('NFC') : newName)) throw E_PATH();
    const to = path.posix.join(path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p), newName.normalize('NFC'));
    return this._relocate(p, normRel(to, false), 'rename');
  }
  // Pindah ke jalur baru LENGKAP (termasuk nama). Tidak menimpa. Folder tujuan yang belum ada dibuat.
  move(from, to) { return this._relocate(normRel(from, false), normRel(to, false), 'move'); }
  _relocate(a, b, kind) {
    if (a === b) return;
    const A = fold(a), B = fold(b);
    if (B.startsWith(A + '/')) throw ek('e.lw.moveInto', null, 'Folder tidak bisa dipindah ke dalam dirinya sendiri', 'into');
    const src = this._prep(a, false);
    if (!src.st) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
    if (src.st.isSymbolicLink()) throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    if (src.st.isDirectory()) { // isi yang dipindah tidak boleh membuat jalur melewati batas kedalaman/panjang
      const sub = this._extent(src.abs, 0, 0);
      if (b.split('/').length + sub.depth > MAX_DEPTH || b.length + sub.len > MAX_PATH) throw E_PATH();
    }
    const dst = this._prep(b, true);
    const samePlace = fold(a) === fold(b); // ganti huruf besar-kecil saja pada nama yang sama
    if (dst.st && !samePlace) throw ek('e.lw.pathExists', null, 'Sudah ada berkas atau folder dengan nama itu', 'exists');
    this._collide(dst.parent, path.basename(dst.abs), samePlace ? path.basename(src.abs) : undefined);
    this._inside(dst.abs);
    fs.renameSync(src.abs, dst.abs);
    this._changed(kind, b);
  }
  // Kedalaman dan panjang jalur relatif terpanjang di bawah abs (tidak mengikuti symlink).
  _extent(abs, depth, len) {
    let d = 0, l = 0;
    for (const n of fs.readdirSync(abs)) {
      const f = path.join(abs, n);
      let st; try { st = fs.lstatSync(f); } catch { continue; }
      let cd = 1, cl = n.length + 1;
      if (st.isDirectory()) { const s = this._extent(f, depth + 1, len + n.length + 1); cd += s.depth; cl += s.len; }
      if (cd > d) d = cd;
      if (cl > l) l = cl;
    }
    return { depth: d, len: l };
  }
  // Hapus berkas atau folder (isi ikut). Symlink yang terselip dilepas sebagai tautan, targetnya tidak disentuh.
  remove(rel) {
    const p = normRel(rel, false), r = this._prep(p, false);
    if (!r.st) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
    this._inside(r.abs);
    fs.rmSync(r.abs, { recursive: true, force: false });
    this._changed('remove', p);
  }
}

module.exports = { WebFiles, normRel, tryRel, segOk, MAX_DEPTH, MAX_PATH, MAX_SEG };
