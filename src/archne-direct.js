'use strict';
// src/archne-direct.js — Kirim Langsung (v0.24.0): transfer berkas/folder tanpa batas ukuran, HANYA di jaringan lokal (LAN), kedua pihak harus online.
// Modul ini murni protokol byte + berkas (tanpa tahu Core): pindai folder, aturan path aman, melayani byte, dan mengunduh dengan resume.
// Keputusan "siapa boleh" (LAN saja, sesi, pemblokiran) ada di src/core/direct-*.js.
//
// Protokol (satu koneksi = satu permintaan, seperti file_get):
//   klien -> server : { t:'dx_get', id, i, off, hi }      i = nomor berkas di daftar sesi, off = posisi lanjut (ukuran .part)
//   server -> klien : { t:'dx', ok:true, off, len } lalu TEPAT `len` byte polos, lalu menutup
//                     { t:'dx', ok:false, err }      lalu menutup
// Polos (tanpa enkripsi) dan tanpa pembatas laju: jalur LAN dianggap tepercaya, jadi tidak ada ongkos CPU di jalur byte.
// Klien tidak percaya header: off/len harus persis seperti yang diminta, dan byte lebih dari yang dijanjikan ditolak.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { Transform } = require('stream');
const { pipeline } = require('./archne-compat');
const { readHead } = require('./archne-xfer');
const { ek } = require('./core/archne-ecode'); // i18n (E8)

const IDLE_MS = 20000, CHUNK = 1024 * 1024, PATH_MAX = 1024, SEG_MAX = 200;
const PART = '.archne-part';

const TEXT = {
  bad: 'permintaan tidak valid',
  gone: 'sesi kirim sudah tidak ada di pengirim',
  denied: 'kamu tidak berhak mengambil kiriman ini',
  changed: 'berkas di pengirim berubah atau hilang',
  busy: 'pengirim sedang sibuk, coba lagi nanti',
  range: 'posisi lanjut tidak valid',
  lan: 'Kirim Langsung hanya untuk jaringan lokal (LAN)',
  net: 'koneksi terputus',
  timeout: 'koneksi macet',
  proto: 'jawaban pengirim tidak sesuai protokol',
  abort: 'dibatalkan',
  disk: 'disk penuh',
  io: 'gagal menulis ke disk',
  unsafe: 'nama berkas dari pengirim tidak aman',
};
// Penolakan sah dari server (kode lain dianggap 'proto'). Hanya net/timeout/busy yang layak dicoba ulang (sambung ulang otomatis).
const REFUSALS = ['bad', 'gone', 'denied', 'changed', 'busy', 'range', 'lan'];
const RETRY = new Set(['net', 'timeout', 'busy']);

class DxError extends Error {
  constructor(code, msg) { super(msg || TEXT[code] || code); this.name = 'DxError'; this.code = code; }
}
const canRetry = (e) => !!e && RETRY.has(e.code);

// ---- Nama aman ----
// Satu segmen nama dari pengirim -> nama yang sah di Windows/Linux/Android (karakter terlarang jadi "_", nama cadangan diawali "_").
function cleanSeg(s) {
  s = String(s).replace(/[<>:"|?*\\\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (!s) s = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
  return s.length > SEG_MAX ? s.slice(0, SEG_MAX) : s;
}
// Path relatif dari pengirim ("a/b/c.txt", pemisah "/") -> daftar segmen mentah, atau null bila tidak sah (mutlak, "..", kosong, NUL, "\").
function splitRel(p) {
  if (typeof p !== 'string' || !p || p.length > PATH_MAX) return null;
  if (p.indexOf('\u0000') >= 0 || p.indexOf('\\') >= 0 || p[0] === '/' || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.split('/');
  for (const s of segs) if (!s || s === '.' || s === '..') return null;
  return segs;
}
// Daftar entri { p, s, d? } -> path tujuan relatif ('/') tiap entri; nama yang bertabrakan setelah dibersihkan (huruf besar/kecil dianggap sama)
// diberi akhiran " (n)". Null di posisi entri yang path-nya tidak sah. Deterministik untuk urutan yang sama.
function planRel(files) {
  const used = new Set();
  return files.map((f) => {
    const raw = splitRel(f.p);
    if (!raw) return null;
    const segs = raw.map(cleanSeg);
    let rel = segs.join('/'), n = 1;
    while (used.has(rel.toLowerCase())) {
      n++;
      const last = segs[segs.length - 1], ext = f.d ? '' : path.extname(last);
      const stem = ext ? last.slice(0, -ext.length) : last;
      rel = segs.slice(0, -1).concat(stem + ' (' + n + ')' + ext).join('/');
    }
    used.add(rel.toLowerCase());
    return rel;
  });
}
// Gabungkan root + rel dan pastikan hasilnya tetap di dalam root (pertahanan berlapis setelah splitRel/cleanSeg).
function under(root, rel) {
  const full = path.resolve(root, ...rel.split('/'));
  const r = path.resolve(root);
  return full.startsWith(r + path.sep) ? full : null;
}

// ---- Pindai (pengirim) ----
// paths: array path absolut berkas/folder. Hasil { files:[{p,s,m,a,d?}], total, count, tops:[nama teratas] }.
// p = path relatif ('/') termasuk nama teratas, s = ukuran, m = mtime (ms, bulat), a = path absolut di pengirim (tidak pernah dikirim), d:1 = folder kosong.
// Symlink dilewati (tidak diikuti: tidak ada putaran tak berujung dan tidak membocorkan isi di luar pilihan). Yang tak terbaca dilewati dan dihitung di `skipped`.
async function scan(paths, opts = {}) {
  const files = [], tops = [], seen = new Set();
  let total = 0, skipped = 0, tick = 0;
  const abortChk = () => { if (opts.signal && opts.signal.aborted) throw new DxError('abort'); };
  for (const src of paths) {
    abortChk();
    if (typeof src !== 'string' || !path.isAbsolute(src)) throw ek('e.dx.pathAbs', null, 'Path harus absolut');
    let st; try { st = await fs.promises.lstat(src); } catch { throw ek('e.dx.cantRead', { name: path.basename(src) }, 'Tidak bisa membaca: {name}'); }
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw ek('e.dx.notRegular', { name: path.basename(src) }, 'Bukan berkas atau folder biasa: {name}');
    let top = cleanSeg(path.basename(src) || 'folder'), k = 1;
    while (seen.has(top.toLowerCase())) { k++; top = cleanSeg(path.basename(src)) + ' (' + k + ')'; }
    seen.add(top.toLowerCase()); tops.push(top);
    if (st.isFile()) { files.push({ p: top, s: st.size, m: Math.floor(st.mtimeMs), a: src }); total += st.size; continue; }
    const stack = [{ abs: src, rel: top }];
    while (stack.length) {
      const { abs, rel } = stack.pop();
      abortChk();
      let ents; try { ents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { skipped++; continue; }
      ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      let kept = 0;
      const dirs = [];
      for (const e of ents) {
        const a = path.join(abs, e.name), p = rel + '/' + e.name;
        if (p.length > PATH_MAX || e.name.indexOf('/') >= 0) { skipped++; continue; }
        if (e.isDirectory()) { dirs.push({ abs: a, rel: p }); kept++; continue; }
        if (!e.isFile()) { skipped++; continue; } // symlink, soket, perangkat: dilewati
        let fst; try { fst = await fs.promises.stat(a); } catch { skipped++; continue; }
        files.push({ p, s: fst.size, m: Math.floor(fst.mtimeMs), a }); total += fst.size; kept++;
        if (opts.onProgress && ++tick % 500 === 0) opts.onProgress({ count: files.length, total });
      }
      if (!kept) files.push({ p: rel, s: 0, m: 0, a: abs, d: 1 }); // folder kosong tetap ikut agar strukturnya sama
      for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]); // urutan alfabet saat dipop
    }
  }
  return { files, total, count: files.length, tops, skipped };
}

// ---- Server: layani byte ----
// Header sudah divalidasi pemanggil (sesi, i, off, ukuran/mtime). Penutup koneksi ditangani pipeline.
function refuse(sock, err) { try { sock.end(JSON.stringify({ t: 'dx', ok: false, err }) + '\n'); } catch {} }
async function serve(sock, file, off, len) {
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  sock.write(JSON.stringify({ t: 'dx', ok: true, off, len }) + '\n');
  if (len === 0) { sock.end(); return; }
  try { await pipeline(fs.createReadStream(file, { start: off, end: off + len - 1, highWaterMark: CHUNK }), sock); } catch { sock.destroy(); }
}

// ---- Klien: unduh satu berkas dengan resume ----
// `part` sudah ada = lanjut dari ukurannya. Mengembalikan size bila lengkap; melempar DxError (net/timeout/busy = coba lagi).
// opts: { signal, onBytes(doneTotal), dial(peer) }
async function download(peer, req, part, size, opts = {}) {
  let off = 0;
  try { off = fs.statSync(part).size; } catch { fs.mkdirSync(path.dirname(part), { recursive: true }); fs.writeFileSync(part, ''); }
  if (off > size) { fs.truncateSync(part, 0); off = 0; }
  if (off === size) return size;
  if (opts.signal && opts.signal.aborted) throw new DxError('abort');
  const sock = (opts.dial || ((p) => net.connect({ host: p.ip, port: p.port })))(peer);
  if (!sock) throw new DxError('net');
  const onAbort = () => sock.destroy(new DxError('abort'));
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  sock.setTimeout(IDLE_MS, () => sock.destroy(new DxError('timeout')));
  try {
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.on('error', () => {});
    sock.write(JSON.stringify(Object.assign({}, req, { t: 'dx_get', off })) + '\n');
    let h;
    try { h = JSON.parse(await readHead(sock)); } catch (e) { throw e && e.code ? new DxError(e.code === 'net' ? 'net' : 'proto') : new DxError('proto'); }
    if (!h || h.t !== 'dx') throw new DxError('proto');
    if (!h.ok) throw new DxError(REFUSALS.includes(h.err) ? h.err : 'proto');
    if (h.off !== off || h.len !== size - off) throw new DxError('proto');
    const ws = fs.createWriteStream(part, { flags: 'a', highWaterMark: CHUNK });
    let wn = 0;
    const lim = new Transform({ // jangan terima lebih dari yang dijanjikan; sekaligus hitung progres
      transform(c, _e, cb) {
        wn += c.length;
        if (wn > h.len) return cb(new DxError('proto', 'pengirim mengirim lebih dari yang dijanjikan'));
        if (opts.onBytes) opts.onBytes(off + wn);
        cb(null, c);
      },
    });
    await pipeline(sock, lim, ws);
    if (wn !== h.len) throw new DxError('net');
    return size;
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw new DxError('abort');
    if (e instanceof DxError) throw e;
    if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')) throw new DxError('disk');
    if (e && ['EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'EMFILE', 'EIO', 'ENAMETOOLONG'].includes(e.code)) throw new DxError('io', e.message);
    throw new DxError('net', e && e.message);
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    sock.destroy();
  }
}

module.exports = { DxError, canRetry, cleanSeg, splitRel, planRel, under, scan, serve, refuse, download, PART, TEXT, IDLE_MS, PATH_MAX };
