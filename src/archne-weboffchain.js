'use strict';
// src/archne-weboffchain.js — Rantai di dalam CSS unduhan untuk "Jadikan offline" (0.34.0 Fase O3c). Tanpa jaringan, tanpa IPC, tanpa menulis berkas (hanya MEMBACA CSS di folder staging).
// Masalahnya: CSS dari CDN (contoh utama: Google Fonts) menunjuk font / gambar / CSS lain di domain lain. Salinan CSS-nya saja belum membuat situs offline.
// Modul ini menjawab dua hal untuk pemanggil (archne-ipc-weboffline.js, yang menjalankan putaran unduhan berikutnya lewat runJob):
//   discover(items, read, known?, opts?) -> Promise { list:[{ url, kind, cls:'local', chain:true }], skipped:[{ url, why }], skippedN, unreadN }
//     items = butir manifest berjenis 'style' dari putaran terakhir (hanya yang kind 'style' dibaca). read(item) -> Promise<string|null> (null = tidak terbaca / bukan UTF-8: CSS itu dibiarkan, referensinya tetap `unresolved`).
//     known = Set URL kanonik yang sudah diunduh atau ditolak (tidak diunduh lagi, tidak dihitung ulang). Referensi dicari dengan RW.cssRefs: urai terhadap URL akhir CSS-nya, aturan SAMA dengan penulis ulang, jadi yang ditemukan di sini = yang kelak dilaporkan `unresolved`.
//     Penggolongan sama dengan pemindai O1: alamat privat, layanan (peta, captcha, analitik, embed, pembayaran), dan alamat berisi kata sandi TIDAK diikuti (why 'private' | 'service' | 'cred'): tetap butuh internet.
//     opts: { max } (default LIM.round): lebih dari itu dibuang dan dihitung di skippedN (why 'limit').
//   readStyle(filesDir, item) -> Promise<string|null>   membaca satu CSS dari staging dengan syarat yang sama dengan penerapan (berkas biasa, ukuran = manifest, UTF-8 bulat).
//   assignAfter(prior, base?) -> fungsi assign untuk runJob (deps.assign): memberi jalur putaran baru dengan MENGHITUNG butir putaran sebelumnya lebih dulu, supaya jalur baru tidak pernah sama dengan jalur lama (tabrakan dibandingkan tanpa membedakan huruf besar / kecil oleh webpath).
//     prior = [{ url, kind, type?, rel }]. Jalur yang dihitung ulang untuk prior harus SAMA dengan rel-nya (assign deterministik, yang menang urutan list); beda = galat (commit putaran itu gagal), tidak diam-diam.
//   LIM = { rounds, round, total, bytes, minMs }
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/weboffchain.js): tiap penjaga satu baris.
const fs = require('fs'), path = require('path');
const RW = require('./archne-weboffrewrite');
const { privateHost, isService } = require('./archne-webassets');
const W = require('./archne-webpath');
const { utf8 } = require('./archne-weboffapply');

const LIM = { rounds: 3, round: 200, total: 500, bytes: 48 * 1024 * 1024, minMs: 5000, skipped: 50 };

function why(url) {
  let u; try { u = new URL(url); } catch { return 'bad'; }
  if (privateHost(u.hostname)) return 'private'; // G:private
  if (isService(u.hostname.toLowerCase(), u.pathname.toLowerCase())) return 'service'; // G:service
  return null;
}

async function readStyle(filesDir, it) {
  try {
    if (!it || typeof filesDir !== 'string' || typeof it.rel !== 'string') return null;
    const abs = path.join(filesDir, ...it.rel.split('/'));
    const ls = await fs.promises.lstat(abs);
    if (!ls.isFile() || ls.size !== it.bytes) return null;
    return utf8(await fs.promises.readFile(abs));
  } catch { return null; }
}

async function discover(items, read, known, opts) {
  opts = opts && typeof opts === 'object' ? opts : {};
  const max = Number.isInteger(opts.max) && opts.max >= 0 ? opts.max : LIM.round;
  const have = known instanceof Set ? known : new Set();
  const list = [], skipped = [], seen = new Set();
  let skippedN = 0, unreadN = 0;
  const skip = (url, w) => { skippedN++; if (skipped.length < LIM.skipped) skipped.push({ url: String(url).slice(0, 300), why: w }); };
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.kind !== 'style') continue; // G:kind
    let text = null;
    try { text = await read(it); } catch { text = null; }
    if (typeof text !== 'string') { unreadN++; continue; }
    for (const r of RW.cssRefs(text, it.finalUrl || it.url)) {
      if (have.has(r.url) || seen.has(r.url)) continue; // G:known
      seen.add(r.url);
      const w = r.cred ? 'cred' : why(r.url); // G:cred — kata sandi sudah dibuang dari r.url oleh canon: tandanya hanya dibawa r.cred
      if (w) { skip(r.url, w); continue; }
      if (list.length >= max) { skip(r.url, 'limit'); continue; } // G:max
      list.push({ url: r.url, kind: r.kind, cls: 'local', chain: true });
    }
  }
  return { list, skipped, skippedN, unreadN };
}

const prefixOk = (results, prior) => prior.every((x, k) => results[k] && results[k].ok && results[k].rel === x.rel);

function assignAfter(prior, base) {
  const run = typeof base === 'function' ? base : W.assign;
  const pri = (Array.isArray(prior) ? prior : []).map((x) => ({ url: x.url, kind: x.kind, type: x.type }));
  return (list) => {
    if (!Array.isArray(list)) return { ok: false, code: 'bad' };
    const all = run(pri.concat(list));
    if (!all || !all.ok || !Array.isArray(all.results) || all.results.length !== pri.length + list.length) return { ok: false, code: 'bad' };
    if (!prefixOk(all.results, prior)) return { ok: false, code: 'bad' }; // G:prefix — jalur butir lama tidak boleh bergeser
    return { ok: true, results: all.results.slice(pri.length).map((r, i) => Object.assign({}, r, { i })) };
  };
}

module.exports = { discover, readStyle, assignAfter, LIM };
