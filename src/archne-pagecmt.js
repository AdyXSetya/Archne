'use strict';
// Komentar pada postingan Halaman (tahap 4b-1). Murni lokal: tanpa jaringan, tanpa UI, tanpa Core. Dipakai PageStore (comment / commentsFor / removeComment).
// Komentar DITANDATANGANI oleh penulisnya (kunci identitas) dan bisa diperiksa siapa pun: bukan hanya pemilik halaman, tetapi kelak juga penonton yang menerima daftarnya.
// Itu bedanya dengan reaksi (4a): reaksi cukup dipercaya dari pemilik, komentar membawa BUKTI penulis, jadi pemilik tidak bisa memalsukan komentar atas nama orang lain
// (pemilik tetap bisa MENYEMBUNYIKAN komentar: itu haknya, bukan pemalsuan).
// Komentar = { id, post, by, pub, ts, text, sig }
//   by   = id penulis = 16 heks pertama sha256(pub) (pub = kunci publik Ed25519, DER spki base64): kunci tidak bisa diganti tanpa mengganti id.
//   ts   = jam penulis (ms). Hanya diperiksa terhadap jam pemilik saat MENAMBAH (tidak lebih dari PG_SKEW di masa depan); saat dibuka dari berkas tidak diperiksa lagi.
//   text = teks kanonis (cleanText) 1..CMT_TEXT_MAX; teks yang belum kanonis ditolak, jadi tanda tangan selalu menutup teks yang persis tampil.
//   sig  = Ed25519 atas CMT_TAG + id PEMILIK + id postingan + ts + text. Pemilik dan postingan ikut tertutup: komentar untuk satu postingan / halaman tidak bisa diputar ulang ke yang lain.
//   id   = 16 heks pertama sha256(sig). Ed25519 deterministik, jadi komentar yang sama persis = id sama (penambahan ulang = 'same', tanpa tulis).
// Berkas <dir>/comments.json = { v: 1, map: { postId: [komentar] } } (ditulis atomik oleh penulis yang diberikan PageStore). Bukan sumber kebenaran: SETIAP komentar diperiksa ulang
// (bentuk + tanda tangan) saat dibuka, jadi berkas yang diubah tangan tidak bisa menyelipkan komentar atas nama orang lain; yang tidak lolos dibuang diam-diam. Rusak / versi asing = kosong.
// Batas (anti banjir): CMT_PER_POST per postingan, CMT_PER_AUTHOR per penulis per postingan, CMT_STORE_MAX seluruh berkas; terlampaui = menolak (tidak ada yang dibuang otomatis).
// Jaringan (pg_cmt / pg_cml, caps 'pgc') ada di src/core/archne-pages-cmt.js (4b-2); wireComments (di bawah) memeriksa jawaban pemilik. IPC (pgComment / pgComments) ada di src/archne-ipc-pages.js (4b-3). UI di renderer/js/archne-pages-cmt.js (4b-4). Antrean untuk pemilik offline: src/archne-pagecq.js + src/core/archne-pages-cq.js (4c-1; komentar yang diantrekan memakai cmtSign / cmtVerify yang sama). Penghapusan oleh penulis (5e): pesan pg_cmd, src/core/archne-pages-cd.js; pemilik memeriksa bahwa c.by = pengirim terbukti (tanda tangan permintaan menutup id postingan + cid), jadi tidak perlu tanda tangan hapus terpisah. Balasan (5f): lihat di bawah.
// BALASAN (5f, pohon): komentar boleh membawa `re` = id komentar INDUK (16 heks, pada postingan yang sama). Komentar tanpa `re` = komentar tingkat atas dan byte yang ditandatangani TIDAK berubah (tag CMT_TAG, jadi semua komentar lama tetap sah).
// Balasan memakai tag lain (CMT_TAG2) dan `re` ikut tertutup: tanda tangan balasan tidak sah bagi peer lama (mereka menghitung dengan tag lama), jadi balasan tidak pernah tampil sebagai komentar tingkat atas di aplikasi lama, dan induk tidak bisa dipindah di jalan. Caps 'pgt' memberi tahu peminta bahwa pemilik mengerti balasan.
// add() menolak balasan bila induknya tidak ada pada postingan itu (code 'noparent'). Induk yang KEMUDIAN dihapus (pemilik / penulisnya) tidak membuang balasan: balasan tetap ada dan UI menampilkannya sebagai balasan untuk komentar yang tidak tersedia (tanpa kaskade: menghapus komentar sendiri tidak boleh menghapus tulisan orang lain). Saat dibuka dari berkas / impor arsip, induk tidak diperiksa lagi (yatim sah).
// ATURAN PRIVASI (5c-3, model Facebook): (1) MENULIS = izin MELIHAT postingan saat itu (PageStore._canSee). (2) Sesudah diterima, komentar TETAP ADA sampai pemilik menghapusnya (atau menghapus postingannya): putus pertemanan atau memblokir penulis TIDAK membuang komentarnya (pemilik yang memutuskan lewat Hapus). (3) MEMBACA daftar tetap butuh izin lihat SAAT INI (diblokir / bukan teman lagi = null). (4) Komentar yang dihapus pemilik TETAP TERHAPUS: id-nya dicatat sebagai nisan (rm) dan penambahan ulang komentar yang sama persis (kirim ulang penulis / antrean 4c) ditolak ('removed'); komentar BARU (teks sama, tanda tangan baru = id baru) tetap boleh: menghentikan orangnya = blokir.
// Nisan: file comments.json -> rm = ['postId:cid', ...] urut tertua dulu, maks CMT_RM_MAX seluruhnya (terlampaui = yang tertua dilepas: kirim ulang komentar yang SANGAT lama bisa masuk lagi; diterima sebagai batas, bukan celah yang bisa dipaksa penulis karena yang melepas hanya penghapusan baru oleh pemilik). Nisan ikut dibuang bersama postingannya (drop / retain).
const fs = require('fs'), crypto = require('crypto');
const HEX16 = /^[0-9a-f]{16}$/;
const CMT_TAG = 'archne-pc1:', CMT_TAG2 = 'archne-pc2:'; // pc2 = balasan (5f)
const CMT_TEXT_MAX = 1000, CMT_PER_POST = 500, CMT_PER_AUTHOR = 20, CMT_STORE_MAX = 10000, CMT_SKEW = 120e3, CMT_RM_MAX = 10000;
const RM_KEY = /^[0-9a-f]{16}:[0-9a-f]{16}$/;
const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const idOfPub = (pub) => sha16(Buffer.from(pub, 'base64'));
const idOfSig = (sig) => sha16(Buffer.from(sig, 'base64'));
const signedBytes = (owner, post, ts, text, re) => Buffer.from(re ? CMT_TAG2 + owner + ':' + post + ':' + re + ':' + ts + ':' + JSON.stringify(text) : CMT_TAG + owner + ':' + post + ':' + ts + ':' + JSON.stringify(text));
const clean = (s) => require('./archne-pagestore').cleanText(s); // malas: pagestore memuat modul ini, jadi tidak boleh saling memuat saat pemuatan

// Tanda tangani komentar. privKey = KeyObject privat identitas, pub = kunci publik DER spki base64 milik kunci itu. Melempar Error bila teks kosong / terlalu panjang / id tidak sah.
// now hanya untuk tes. re (opsional) = id komentar induk (5f): balasan ditandatangani dengan tag lain dan membawa `re`.
function cmtSign(privKey, pub, ownerId, postId, text, now, re) {
  if (!HEX16.test(String(ownerId)) || !HEX16.test(String(postId))) throw new Error('Id tidak valid');
  if (re != null && !HEX16.test(String(re))) throw new Error('Id tidak valid');
  if (typeof pub !== 'string' || !pub || pub.length > 200) throw new Error('Kunci tidak valid');
  const t = clean(text);
  if (t.length > CMT_TEXT_MAX) throw new Error('Komentar terlalu panjang');
  const ts = now == null ? Date.now() : now;
  if (!Number.isSafeInteger(ts) || ts < 0) throw new Error('Waktu tidak valid');
  const sig = crypto.sign(null, signedBytes(ownerId, postId, ts, t, re == null ? undefined : re), privKey).toString('base64');
  const c = { id: idOfSig(sig), post: postId, by: idOfPub(pub), pub, ts, text: t, sig };
  if (re != null) c.re = re;
  return c;
}

// Periksa komentar untuk halaman `ownerId`. -> { ok:true, c } (c = salinan bersih: hanya bidang yang dikenal) | { ok:false, why } (why: 'bad' bentuk / teks, 'auth' kunci atau tanda tangan, 'owner' bukan untuk halaman ini).
// Urutan: bentuk -> id cocok kunci dan tanda tangan -> tanda tangan. Tidak melempar.
function cmtVerify(c, ownerId, postId) {
  const BAD = { ok: false, why: 'bad' };
  try {
    if (!c || typeof c !== 'object' || !HEX16.test(String(ownerId))) return BAD;
    if (![c.id, c.post, c.by].every((x) => typeof x === 'string' && HEX16.test(x))) return BAD;
    if (typeof c.pub !== 'string' || !c.pub || c.pub.length > 200 || typeof c.sig !== 'string' || !c.sig || c.sig.length > 200) return BAD;
    if (!Number.isSafeInteger(c.ts) || c.ts < 0 || typeof c.text !== 'string' || !c.text || c.text.length > CMT_TEXT_MAX) return BAD;
    if (postId !== undefined && c.post !== postId) return BAD;
    if (c.re !== undefined && (typeof c.re !== 'string' || !HEX16.test(c.re) || c.re === c.id)) return BAD; // 5f: induk = id komentar lain pada postingan yang sama
    let t; try { t = clean(c.text); } catch { return BAD; }
    if (t !== c.text) return BAD; // belum kanonis: tanda tangan harus menutup teks yang persis tampil
    if (idOfPub(c.pub) !== c.by || idOfSig(c.sig) !== c.id) return { ok: false, why: 'auth' };
    const key = crypto.createPublicKey({ key: Buffer.from(c.pub, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, signedBytes(ownerId, c.post, c.ts, c.text, c.re), key, Buffer.from(c.sig, 'base64'))) return { ok: false, why: 'auth' };
    const out = { id: c.id, post: c.post, by: c.by, pub: c.pub, ts: c.ts, text: c.text, sig: c.sig };
    if (c.re !== undefined) out.re = c.re;
    return { ok: true, c: out };
  } catch { return { ok: false, why: 'auth' }; }
}

const noparent = (m) => Object.assign(new Error(m), { code: 'noparent' }); // 5f: balasan untuk induk yang tidak ada
const full = (m) => Object.assign(new Error(m), { code: 'full' }); // 4b-2: batas terlampaui (beda dengan gagal tulis / bentuk), supaya jaringan bisa menjawab 'full'
const order = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); // tertua dulu, id memutus seri

class PageCmt {
  constructor(file, ownerId, write) {
    if (!HEX16.test(String(ownerId))) throw new Error('Id pemilik tidak valid');
    this.file = file; this.owner = ownerId;
    this.write = typeof write === 'function' ? write : (f, s) => { fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); };
    this.map = {}; this.total = 0; this.rm = new Set(); // rm = nisan 'postId:cid' (Set menjaga urutan masuk)
    let raw = null, rmRaw = null;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === 1 && j.map && typeof j.map === 'object') { raw = j.map; if (Array.isArray(j.rm)) rmRaw = j.rm; } } catch {}
    if (rmRaw) for (const k of rmRaw.slice(-CMT_RM_MAX)) if (typeof k === 'string' && RM_KEY.test(k)) this.rm.add(k);
    // komentar yang bernisan tidak ikut dimuat (berkas yang diubah tangan tidak bisa menghidupkannya kembali)
    for (const pid of Object.keys(raw || {})) {
      if (!HEX16.test(pid) || !Array.isArray(raw[pid])) continue;
      const seen = new Set(), per = {}, out = [];
      for (const c of raw[pid]) {
        const v = cmtVerify(c, ownerId, pid);
        if (!v.ok || this.rm.has(pid + ':' + v.c.id) || seen.has(v.c.id) || out.length >= CMT_PER_POST || (per[v.c.by] || 0) >= CMT_PER_AUTHOR || this.total + out.length >= CMT_STORE_MAX) continue;
        seen.add(v.c.id); per[v.c.by] = (per[v.c.by] || 0) + 1; out.push(v.c);
      }
      if (out.length) { this.map[pid] = out.sort(order); this.total += out.length; }
    }
  }
  _save() { this.write(this.file, JSON.stringify(this.rm.size ? { v: 1, map: this.map, rm: [...this.rm] } : { v: 1, map: this.map })); } // tanpa nisan = bentuk berkas yang sama persis dengan sebelum 5c-3

  // Tambah komentar (sudah ditandatangani). -> 'added' | 'same' (id sama persis sudah ada, tanpa tulis) | 'removed' (pemilik pernah menghapus komentar ini: nisan, tanpa tulis; 5c-3).
  // Melempar Error: tidak lolos cmtVerify (bentuk / tanda tangan / bukan untuk halaman ini), terlalu jauh di masa depan (> CMT_SKEW dari `now`), melewati batas (code 'full'), atau balasan untuk induk yang tidak ada (code 'noparent', 5f).
  // Izin melihat postingan dan kecocokan penulis dengan pengirim BUKAN urusan modul ini (PageStore).
  add(c, now) {
    const v = cmtVerify(c, this.owner);
    if (!v.ok) throw new Error(v.why === 'auth' ? 'Tanda tangan komentar tidak sah' : 'Komentar tidak valid');
    const k = v.c, cur = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
    const arr = this.map[k.post] || [];
    if (this.rm.has(k.post + ':' + k.id)) return 'removed';
    if (arr.some((x) => x.id === k.id)) return 'same';
    if (k.ts > cur + CMT_SKEW) throw new Error('Waktu komentar terlalu jauh di masa depan');
    if (k.re !== undefined && !arr.some((x) => x.id === k.re)) throw noparent('Komentar yang dibalas tidak ada'); // 5f
    if (arr.length >= CMT_PER_POST) throw full('Komentar pada postingan ini sudah penuh');
    if (arr.filter((x) => x.by === k.by).length >= CMT_PER_AUTHOR) throw full('Terlalu banyak komentar dari satu orang pada postingan ini');
    if (this.total >= CMT_STORE_MAX) throw full('Penyimpanan komentar penuh');
    const had = Object.prototype.hasOwnProperty.call(this.map, k.post), prev = arr;
    this.map[k.post] = arr.concat(k).sort(order); this.total++;
    try { this._save(); } catch (e) { if (had) this.map[k.post] = prev; else delete this.map[k.post]; this.total--; throw e; } // gagal tulis: memori kembali seperti di berkas
    return 'added';
  }
  // Komentar satu postingan, tertua dulu (salinan). Komentar sudah terverifikasi saat masuk / dibuka.
  list(postId) { return (this.map[postId] || []).map((c) => Object.assign({}, c)); }
  count(postId) { return (this.map[postId] || []).length; }
  // Moderasi lokal oleh pemilik: buang satu komentar. -> true bila ada. Id-nya dicatat sebagai nisan (5c-3): penulis yang mengirim ulang komentar yang sama persis ditolak ('removed' di add).
  // Gagal tulis: memori kembali seperti di berkas (komentar kembali, nisan baru dibatalkan, nisan yang tergeser dikembalikan).
  remove(postId, cid) {
    const arr = this.map[postId]; if (!arr) return false;
    const i = arr.findIndex((c) => c.id === cid); if (i < 0) return false;
    const next = arr.slice(); next.splice(i, 1);
    const prev = arr, key = postId + ':' + cid, prevRm = this.rm;
    if (next.length) this.map[postId] = next; else delete this.map[postId]; this.total--;
    this.rm = new Set(prevRm); this.rm.add(key); while (this.rm.size > CMT_RM_MAX) this.rm.delete(this.rm.values().next().value);
    try { this._save(); } catch (e) { this.map[postId] = prev; this.total++; this.rm = prevRm; throw e; }
    return true;
  }
  // 5d-2/5: salinan komentar + nisan untuk postingan yang lolos has(id), urutan terjaga (untuk ekspor). -> { map, rm }
  dump(want) {
    const has = typeof want === 'function' ? want : (id) => want.has(id); // fungsi atau Set
    const map = {};
    for (const pid of Object.keys(this.map)) if (has(pid)) map[pid] = this.map[pid].map((c) => Object.assign({}, c));
    return { map, rm: [...this.rm].filter((k) => has(k.slice(0, 16))) };
  }
  // 5d-5: gabungkan komentar + nisan dari arsip (TIDAK dipercaya; hanya dipanggil bila pemilik arsip = pemilik store ini). map = { postId: [komentar] }, rm = ['postId:cid'].
  // Aturan sama dengan add(): tiap komentar lolos cmtVerify terhadap pemilik ini, nisan menang (r.removed), id sama = same, ts terlalu jauh di masa depan ditolak, batas per postingan / penulis / berkas = full.
  // Nisan dari arsip hanya ditambahkan bila komentarnya TIDAK hidup di sini (impor tidak pernah menghapus komentar yang ada: tombLive). opts.has(postId): hanya postingan itu yang ikut (lainnya orphan).
  // Satu tulis di akhir; gagal tulis = memori kembali seperti di berkas dan melempar. opts.dry: hanya hitung (tanpa mengubah apa pun). opts.now: untuk tes.
  merge(map, rm, opts) {
    opts = opts || {};
    const ok = typeof opts.has === 'function' ? opts.has : () => true;
    const cur = Number.isSafeInteger(opts.now) && opts.now >= 0 ? opts.now : Date.now();
    const r = { added: 0, same: 0, removed: 0, bad: 0, full: 0, ts: 0, orphan: 0, tombAdded: 0, tombSame: 0, tombLive: 0, tombOrphan: 0 };
    const nextRm = new Set(this.rm), nextMap = Object.assign({}, this.map);
    let total = this.total;
    for (const k of Array.isArray(rm) ? rm : []) {
      if (typeof k !== 'string' || !RM_KEY.test(k)) { r.bad++; continue; }
      const pid = k.slice(0, 16), cid = k.slice(17);
      if (!ok(pid)) { r.tombOrphan++; continue; }
      if (nextRm.has(k)) { r.tombSame++; continue; }
      if ((nextMap[pid] || []).some((c) => c.id === cid)) { r.tombLive++; continue; }
      nextRm.add(k); r.tombAdded++;
    }
    while (nextRm.size > CMT_RM_MAX) nextRm.delete(nextRm.values().next().value);
    for (const pid of Object.keys(map && typeof map === 'object' ? map : {})) {
      const list = map[pid];
      if (!HEX16.test(pid) || !Array.isArray(list)) { r.bad += Array.isArray(list) ? list.length : 1; continue; }
      if (!ok(pid)) { r.orphan += list.length; continue; }
      let arr = nextMap[pid] || [];
      const ids = new Set(arr.map((x) => x.id)), per = {};
      for (const x of arr) per[x.by] = (per[x.by] || 0) + 1;
      let grew = false;
      for (const raw of list) {
        const v = cmtVerify(raw, this.owner, pid);
        if (!v.ok) { r.bad++; continue; }
        const k = v.c;
        if (nextRm.has(pid + ':' + k.id)) { r.removed++; continue; }
        if (ids.has(k.id)) { r.same++; continue; }
        if (k.ts > cur + CMT_SKEW) { r.ts++; continue; }
        if (arr.length >= CMT_PER_POST || (per[k.by] || 0) >= CMT_PER_AUTHOR || total >= CMT_STORE_MAX) { r.full++; continue; }
        arr = arr.concat(k); ids.add(k.id); per[k.by] = (per[k.by] || 0) + 1; total++; r.added++; grew = true;
      }
      if (grew) nextMap[pid] = arr.sort(order);
    }
    if (opts.dry || !(r.added || r.tombAdded)) return r;
    const prevMap = this.map, prevRm = this.rm, prevTotal = this.total;
    this.map = nextMap; this.rm = nextRm; this.total = total;
    try { this._save(); } catch (e) { this.map = prevMap; this.rm = prevRm; this.total = prevTotal; throw e; }
    return r;
  }
  // Pembuangan: satu postingan dihapus; atau semua yang postingannya tidak lolos has(id). Menulis hanya bila ada yang berubah.
  _rmOf(postId) { const pre = postId + ':'; return [...this.rm].filter((k) => k.startsWith(pre)); }
  drop(postId) {
    const a = this.map[postId], n = this._rmOf(postId); if (!a && !n.length) return;
    if (a) { delete this.map[postId]; this.total -= a.length; }
    for (const k of n) this.rm.delete(k); // postingannya tiada: nisan tak berguna lagi
    this._save();
  }
  retain(has) {
    let n = 0;
    for (const pid of Object.keys(this.map)) if (!has(pid)) { n += this.map[pid].length; this.total -= this.map[pid].length; delete this.map[pid]; }
    let m = 0; for (const k of [...this.rm]) if (!has(k.slice(0, 16))) { this.rm.delete(k); m++; }
    if (n || m) this._save();
    return n;
  }
}

// 4b-2: satu halaman dari daftar komentar yang sudah terurut (order). after = kursor 'ts:id' (lihat CMT_CURSOR) = hanya yang SESUDAH itu; limit 1..CMT_PAGE_MAX.
// -> { items, next } (next = kursor komentar terakhir yang ikut bila masih ada sisa, selain itu null). Tidak menyentuh berkas.
const CMT_CURSOR = /^(\d+):([0-9a-f]{16})$/, CMT_PAGE_DEF = 50, CMT_PAGE_MAX = 100;
const cmtAfter = (c, ts, id) => c.ts > ts || (c.ts === ts && c.id > id);
function cmtPage(list, after, limit) {
  const m = after == null ? null : CMT_CURSOR.exec(String(after));
  if (after != null && !m) throw new Error('Kursor tidak valid');
  const lim = Math.min(CMT_PAGE_MAX, Math.max(1, Number.isInteger(limit) ? limit : CMT_PAGE_DEF));
  const from = m ? list.filter((c) => cmtAfter(c, Number(m[1]), m[2])) : list;
  const items = from.slice(0, lim), last = items[items.length - 1];
  return { items, next: items.length && from.length > lim ? last.ts + ':' + last.id : null };
}

// 4b-2: jawaban pg_cml dari pemilik (TIDAK dipercaya). r = { items, next, count }; req = { after?, limit } yang kuminta; ownerId = pemilik halaman; postId = postingan yang kuminta.
// Tiap komentar diperiksa penuh (cmtVerify: bentuk + tanda tangan + halaman + postingan): yang tidak lolos DIBUANG dan dihitung di `skipped` (pemilik tidak bisa memalsukan komentar; paling jauh menyelipkan sampah yang tak tampil).
// Yang lolos harus urut ketat (ts, id), sesudah kursor yang kuminta, tanpa ganda. Pelanggaran urutan / jumlah / kursor = null (jawaban cacat seluruhnya, seperti wireList). -> { items, next, count, skipped } | null.
function wireComments(r, req, ownerId, postId) {
  req = req || {};
  if (!r || typeof r !== 'object' || !Array.isArray(r.items)) return null;
  const lim = Math.min(CMT_PAGE_MAX, Math.max(1, Number.isInteger(req.limit) ? req.limit : CMT_PAGE_DEF));
  if (r.items.length > lim || !Number.isSafeInteger(r.count) || r.count < r.items.length || r.count > CMT_PER_POST) return null;
  let prev = req.after != null ? CMT_CURSOR.exec(String(req.after)) : null;
  prev = prev ? { ts: Number(prev[1]), id: prev[2] } : null;
  const items = []; let skipped = 0;
  for (const raw of r.items) {
    const v = cmtVerify(raw, ownerId, postId);
    if (!v.ok) { skipped++; continue; }
    if (prev && !cmtAfter(v.c, prev.ts, prev.id)) return null; // urutan salah / ulang / sebelum kursor
    items.push(v.c); prev = v.c;
  }
  let next = null;
  if (r.next != null) {
    const m = typeof r.next === 'string' ? CMT_CURSOR.exec(r.next) : null;
    if (!m || !r.items.length) return null; // kursor tanpa kemajuan
    const c = { ts: Number(m[1]), id: m[2] }, from = req.after != null ? CMT_CURSOR.exec(String(req.after)) : null;
    if (from && !cmtAfter(c, Number(from[1]), from[2])) return null; // harus maju dari yang kuminta
    if (items.length && cmtAfter(items[items.length - 1], c.ts, c.id)) return null; // dan tidak mundur ke belakang komentar terakhir
    next = r.next;
  }
  return { items, next, count: r.count, skipped };
}

module.exports = { CMT_TAG2, wireComments, cmtPage, cmtAfter, CMT_CURSOR, CMT_PAGE_DEF, CMT_PAGE_MAX, PageCmt, cmtSign, cmtVerify, CMT_TAG, CMT_TEXT_MAX, CMT_PER_POST, CMT_PER_AUTHOR, CMT_STORE_MAX, CMT_SKEW, CMT_RM_MAX };
