'use strict';
// Tawaran berkas (v0.7.0 tahap 3, langkah 1). Tawaran = pesan biasa (bertanda tangan, terenkripsi untuk DM/grup) yang isinya
// diawali penanda kontrol FILE. Penanda memakai karakter yang disaring dari ketikan pengguna (lihat CTRL di archne-core.js),
// jadi teks biasa tidak bisa memalsukan tawaran. Isi tawaran hanya metadata; byte berkas diambil terpisah (langkah berikutnya).
const { checkMeta, checkLimit, PackError } = require('./archne-pack');

const FILE = '\u0002file:';
const NAME_MAX = 120;

// ---- Info media `x` (opsional, v0.25.0 Step 0): jenis berkas + ukuran gambar/durasi + thumbnail kecil, supaya foto bisa tampil sebelum diunduh. ----
// Ikut dalam pesan bertanda tangan. Peer versi lama mengabaikannya (berkas tampil biasa). Bila `x` tidak sah atau jenisnya belum dikenal,
// tawarannya tetap sah tetapi `x` dibuang: berkas tampil sebagai berkas biasa. Jadi klaim aneh tidak pernah membuat tampilan palsu.
// k: img = foto, vid = video, aud = berkas audio, vc = voice chat (hanya dari perekam; tidak boleh di Publik).
const X_KINDS = ['img', 'vid', 'aud', 'vc'];
const TH_MAX = { public: 3000, direct: 7000 }; // karakter base64 thumbnail; seluruh tawaran harus tetap di bawah MAX_TEXT (10000) dan Publik ikut kuota byte
const TH_DIM = 320;                             // sisi terpanjang thumbnail (px): dekoder tidak diberi gambar besar
const DIM_MAX = 16384, DUR_MAX = 864e5, VC_MAX_MS = 5 * 60e3; // durasi dalam milidetik
// Voice chat (v0.25.0 Step 4): hanya dibuat oleh Core.sendVoice (perekam), tidak pernah lewat sendFile. Penerima TIDAK percaya klaim `vc`:
// ukuran dibatasi, nama harus berekstensi suara, dan ukuran harus wajar untuk durasinya; selain itu `x` dibuang dan tawaran tampil sebagai berkas biasa.
const VC_MAX_BYTES = 5 * 1048576, VC_BPS_MAX = 40000, VC_SLACK = 65536; // 40 KB/dtk = 320 kbps, jauh di atas Opus 32-64 kbps
const VC_NAME = /\.(weba|ogg|m4a)$/i;
const vcSizeOk = (size, d) => Number.isSafeInteger(size) && size > 0 && size <= VC_MAX_BYTES && size <= (d / 1000) * VC_BPS_MAX + VC_SLACK;

// Baca lebar/tinggi dari header JPEG tanpa mendekode gambarnya. null bila bukan JPEG yang utuh.
function jpegSize(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const mk = b[i + 1];
    if (mk === 0xff) { i++; continue; } // bantalan
    if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; } // penanda tanpa panjang
    if (mk === 0xd9 || mk === 0xda) return null; // akhir/awal data tanpa pernah bertemu SOF
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      if (len < 8) return null;
      const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

// Hasil: { ok: true, x } (x sudah dinormalkan, hanya bidang yang dikenal) atau { ok: false, err }. `to` menentukan batas (Publik lebih ketat).
function checkX(x, to) {
  const bad = (err) => ({ ok: false, err });
  if (!x || typeof x !== 'object' || Array.isArray(x)) return bad('x bukan objek');
  if (!X_KINDS.includes(x.k)) return bad('jenis media tidak dikenal');
  const pub = kindOf(to) === 'public', int = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
  const out = { k: x.k };
  const hasDim = x.w !== undefined || x.h !== undefined;
  if (hasDim) {
    if (x.k !== 'img' && x.k !== 'vid') return bad('ukuran gambar hanya untuk foto/video');
    if (!int(x.w, 1, DIM_MAX) || !int(x.h, 1, DIM_MAX)) return bad('lebar/tinggi tidak sah');
    out.w = x.w; out.h = x.h;
  }
  if (x.d !== undefined) {
    if (x.k === 'img') return bad('foto tidak punya durasi');
    if (!int(x.d, 1, DUR_MAX)) return bad('durasi tidak sah');
    out.d = x.d;
  }
  if (x.k === 'vc') {
    if (pub) return bad('voice chat tidak boleh di Publik');
    if (out.d === undefined) return bad('voice chat wajib punya durasi');
    if (out.d > VC_MAX_MS) return bad('voice chat terlalu panjang');
    if (x.th !== undefined || hasDim) return bad('voice chat tidak punya gambar');
  }
  if (x.th !== undefined) {
    if (x.k !== 'img' && x.k !== 'vid') return bad('thumbnail hanya untuk foto/video');
    const t = x.th;
    if (typeof t !== 'string' || !t || t.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return bad('thumbnail bukan base64');
    if (t.length > TH_MAX[pub ? 'public' : 'direct']) return bad('thumbnail terlalu besar');
    const sz = jpegSize(Buffer.from(t, 'base64'));
    if (!sz) return bad('thumbnail bukan JPEG');
    if (sz.w > TH_DIM || sz.h > TH_DIM) return bad('dimensi thumbnail terlalu besar');
    out.th = t;
  }
  return { ok: true, x: out };
}

// Nama hanya untuk tampilan dan nama simpan: tanpa folder, tanpa karakter kontrol, tanpa nama khusus Windows.
function safeName(n) {
  let s = String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > NAME_MAX) {
    const dot = s.lastIndexOf('.'), ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, NAME_MAX - ext.length) + ext;
  }
  return s || 'berkas';
}

const kindOf = (to) => (to === 'public' ? 'public' : 'direct');

// x (opsional) = info media; `to` dibutuhkan bila x ada (batas Publik berbeda). x yang tidak sah melempar galat: itu kesalahan pengirim.
function encodeOffer(name, meta, x, to) {
  checkMeta(meta, Infinity);
  const o = { n: safeName(name), m: meta };
  if (x !== undefined && x !== null) {
    const r = checkX(x, to);
    if (!r.ok) throw new Error('Info media tidak sah: ' + r.err);
    o.x = r.x;
  }
  return FILE + JSON.stringify(o);
}

// undefined = bukan tawaran; null = tawaran rusak/melanggar batas; selain itu { name, meta, x? }.
function parseOffer(text, to) {
  if (typeof text !== 'string' || !text.startsWith(FILE)) return undefined;
  try {
    const o = JSON.parse(text.slice(FILE.length));
    if (!o || typeof o.n !== 'string' || !o.m) return null;
    const m = o.m;
    checkMeta({ v: m.v, mode: m.mode, size: m.size, psize: m.psize, hash: m.hash }, Infinity);
    if (m.mode === 'br' && m.psize > m.size + 1024) return null; // Brotli tidak membesar signifikan; kalau begitu mode seharusnya raw
    checkLimit(m.size, kindOf(to));
    const res = { name: safeName(o.n), meta: { v: m.v, mode: m.mode, size: m.size, psize: m.psize, hash: m.hash } };
    if (o.x !== undefined) {
      const r = checkX(o.x, to);
      if (r.ok && (r.x.k !== 'vc' || (VC_NAME.test(res.name) && vcSizeOk(res.meta.size, r.x.d)))) res.x = r.x;
    } // x tidak sah/baru: dibuang, tawarannya tetap berkas biasa
    return res;
  } catch (e) {
    if (e instanceof PackError) return null;
    return null;
  }
}

module.exports = { FILE, NAME_MAX, X_KINDS, TH_MAX, TH_DIM, VC_MAX_MS, VC_MAX_BYTES, VC_NAME, vcSizeOk, safeName, kindOf, jpegSize, checkX, encodeOffer, parseOffer };
