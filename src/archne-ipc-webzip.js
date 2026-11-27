'use strict';
// src/archne-ipc-webzip.js — ZIP untuk pengelola berkas Web Lokal (0.34.0 Fase U2). Dipanggil dari registerWeb() (archne-ipc-web.js). Format ZIP ada di src/archne-zip.js; di sini HANYA pemetaan nama entri -> jalur situs dan penulisan lewat WebFiles.
// Kanal (semua -> { ok:true, ... } | { ok:false, err, code }):
//   webZipList(id, rel, { strip? })                       -> { files, dirs, root, size, packed, skipped:[{ p, code }], skippedN }  memeriksa .zip di dalam situs TANPA menulis; root = folder induk bersama yang dilepas ('' bila tidak ada); strip:false = jangan lepas
//   webZipExtract(id, rel, { strip?, overwrite? })        -> { done, total, skipped:[{ p, code }], skippedN }  ekstrak ke folder tempat .zip berada; rev naik SEKALI; kemajuan lewat event 'webprog' { id, done, total }
//   webZipExport(id, rels[])                              -> { name, n, size } | { cancelled:true }  rels kosong = seluruh situs; dialog simpan ada di proses utama (deps.pickSave(def, 'zip')), jalur tujuan TIDAK pernah keluar; selesai: event 'webzip' { id, phase:'done'|'error', name?, code? }
// Aturan nama entri (zip-slip dll.): tiap segmen harus lolos segOk, jalur akhir (di bawah folder tujuan) harus lolos tryRel (kedalaman, panjang), tanpa symlink / perangkat / terenkripsi / metode asing, huruf kembar dan entri yang menimpa ZIP-nya sendiri dilewati.
//   Entri yang dilewati dilaporkan (planning: nama asli di ZIP; saat menulis: jalur di situs), TIDAK menggagalkan sisanya. Arsip yang ditolak seluruhnya (rusak, ZIP64, bom, terlalu banyak entri) tidak menulis apa pun.
const fs = require('fs'), path = require('path');
const { ek } = require('./core/archne-ecode');
const { tryRel, segOk, MAX_PATH } = require('./archne-webfiles');
const Z = require('./archne-zip');

const HEX16 = /^[0-9a-f]{16}$/;
const REL_MAX = 300, SKIP_KEEP = 50, PROG_MS = 200, MAX_BULK = 500, MAX_WALK = 200000;
const fold = (s) => s.normalize('NFC').toLowerCase();
const inside = (p, base) => { const f = process.platform === 'win32' ? (x) => x.toLowerCase() : (x) => x; const r = path.relative(f(base), f(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const codeOf = (e) => (e && typeof e.code === 'string' && /^[a-z]{2,12}$/.test(e.code) ? e.code : 'io');
const tick = () => new Promise((r) => setImmediate(r));

// ZipError (tanpa kunci i18n) -> galat ber-kunci; galat lain dibiarkan.
function zerr(e) {
  if (!e || e.name !== 'ZipError') return e;
  switch (e.code) {
    case 'zip64': return ek('e.lw.zip.zip64', null, 'ZIP64 (arsip di atas 4 GB) belum didukung', 'zip64');
    case 'many': return ek('e.lw.zip.many', { max: Z.LIMITS.entries }, 'Terlalu banyak entri (maksimal {max})', 'zipmany');
    case 'zipbig': return ek('e.lw.zip.big', null, 'Isi ZIP terlalu besar setelah diurai atau sebelum dikemas', 'zipbig');
    case 'bomb': return ek('e.lw.zip.bomb', null, 'Arsip ditolak: rasio kompresi tidak wajar (kemungkinan zip bomb)', 'bomb');
    case 'changed': return ek('e.lw.zip.changed', null, 'Berkas berubah saat dibaca. Coba lagi.', 'changed');
    case 'big': return ek('e.lw.zip.fileBig', null, 'Ada berkas yang terlalu besar untuk ZIP ini', 'big');
    case 'io': return ek('e.lw.ioFail', null, 'Gagal mengakses penyimpanan situs', 'io');
    default: return ek('e.lw.zip.bad', null, 'Berkas ZIP rusak atau tidak dikenal', 'zip');
  }
}

function registerWebZip({ on, core, send, pickSave, running }) {
  const busyZ = () => ek('e.lw.zip.busy', null, 'Masih ada operasi berkas yang berjalan untuk situs ini', 'busy');
  const bad = () => ek('e.lw.err.bad', null, 'Permintaan tidak valid', 'bad');
  const pathBad = () => ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path');
  const siteFiles = (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    const ws = core.webStore();
    if (!ws.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    return ws.files(id);
  };
  const relOf = (p) => { if (typeof p !== 'string' || p.length > REL_MAX) throw bad(); return p; };
  const optsOf = (o) => {
    if (o == null) return { strip: true, overwrite: false };
    if (typeof o !== 'object' || Array.isArray(o)) throw bad();
    return { strip: o.strip !== false, overwrite: o.overwrite === true };
  };
  const prog = (id, st, done, total, force) => { // kemajuan dibatasi PROG_MS; kejadian akhir selalu dikirim
    const now = Date.now();
    if (!send || (!force && now - st.last < PROG_MS)) return;
    st.last = now; try { send('webprog', { id, done, total }); } catch {}
  };

  // Buka .zip di dalam situs (hanya lewat WebFiles: tanpa symlink) dan baca direktorinya.
  function openSrc(wf, rel) {
    const p = tryRel(rel);
    if (!p) throw pathBad();
    if (!/\.zip$/i.test(p)) throw ek('e.lw.zip.type', null, 'Hanya berkas .zip yang bisa dibuka di sini', 'type');
    const st = wf.stat(p);
    if (!st) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
    if (st.type === 'dir') throw ek('e.lw.notFile', null, 'Bukan berkas', 'notfile');
    if (st.type !== 'file') throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    const rd = (off, len) => { const r = wf.readRange(p, off, len); return r ? r.buf : null; };
    let zip; try { zip = Z.openZip(rd, st.size); } catch (e) { throw zerr(e); }
    const i = p.lastIndexOf('/');
    return { p, size: st.size, rd, zip, dest: i < 0 ? '' : p.slice(0, i) };
  }

  // Rencana ekstraksi: entri -> jalur di situs, atau dilewati dengan kode. Tidak menulis apa pun.
  function plan(src, strip) {
    const skipped = [], ents = [];
    const sk = (name, code) => skipped.push({ p: String(name).slice(0, REL_MAX), code });
    for (const x of src.zip.entries) {
      if (!x.nameOk) { sk('?', 'name'); continue; }
      const shown = x.dir ? x.name.slice(0, -1) : x.name, nm = shown.normalize('NFC'), segs = nm.split('/');
      if (segs[0] === '__MACOSX' || /^(\.DS_Store|Thumbs\.db)$/i.test(segs[segs.length - 1])) continue; // sampah pengarsip: diabaikan tanpa laporan
      if (!segs.every((s) => segOk(s))) { sk(shown, 'name'); continue; }
      if (x.link) { sk(shown, 'link'); continue; }
      if (x.special) { sk(shown, 'type'); continue; }
      if (!x.dir) {
        if (x.enc) { sk(shown, 'enc'); continue; }
        if (x.method !== 0 && x.method !== 8) { sk(shown, 'method'); continue; }
      }
      ents.push({ x, shown, segs, dir: x.dir });
    }
    let root = '';
    if (strip && ents.length) { // folder induk dilepas hanya bila SEMUA entri berada di bawahnya
      const first = ents[0].segs[0];
      if (ents.every((e) => e.segs[0] === first && (e.segs.length > 1 || e.dir))) root = first;
    }
    const out = [], seen = new Map(), selfKey = fold(src.p);
    for (const e of ents) {
      const rest = root ? e.segs.slice(1) : e.segs;
      if (!rest.length) continue; // folder induk itu sendiri
      const t = tryRel((src.dest ? src.dest + '/' : '') + rest.join('/'));
      if (!t || t.length > MAX_PATH) { sk(e.shown, 'name'); continue; }
      const key = fold(t);
      if (key === selfKey) { sk(e.shown, 'self'); continue; } // tidak boleh menimpa ZIP yang sedang dibaca
      if (seen.has(key)) { if (!(e.dir && seen.get(key))) sk(e.shown, 'dup'); continue; }
      seen.set(key, e.dir);
      out.push({ x: e.x, rel: t, dir: e.dir });
    }
    return { root, files: out.filter((e) => !e.dir), dirs: out.filter((e) => e.dir), skipped };
  }

  on('webZipList', (id, rel, o) => {
    const wf = siteFiles(id), r = relOf(rel), opt = optsOf(o);
    const src = openSrc(wf, r), pl = plan(src, opt.strip);
    let size = 0; for (const f of pl.files) size += f.x.usize;
    return { ok: true, files: pl.files.length, dirs: pl.dirs.length, root: pl.root, size, packed: src.size, skipped: pl.skipped.slice(0, SKIP_KEEP), skippedN: pl.skipped.length };
  });

  on('webZipExtract', async (id, rel, o) => {
    const wf = siteFiles(id), r = relOf(rel), opt = optsOf(o);
    if (running.has(id)) throw busyZ();
    running.add(id);
    try {
      const src = openSrc(wf, r), pl = plan(src, opt.strip), skipped = pl.skipped.slice(), total = pl.files.length, st = { last: 0 };
      let done = 0;
      wf.hold(); // rev naik sekali untuk seluruh ekstraksi
      try {
        for (const d of pl.dirs) {
          try { const s = wf.stat(d.rel); if (!s) wf.mkdir(d.rel); else if (s.type !== 'dir') skipped.push({ p: d.rel, code: 'notdir' }); }
          catch (e) { if (e && e.code === 'ENOSPC') throw e; skipped.push({ p: d.rel, code: codeOf(e) }); }
        }
        for (const f of pl.files) {
          try {
            if (wf.stat(f.rel) && !opt.overwrite) skipped.push({ p: f.rel, code: 'exists' });
            else { const buf = await Z.readEntry(src.zip, src.rd, f.x); wf.write(f.rel, buf); done++; }
          } catch (e) { if (e && e.code === 'ENOSPC') throw e; skipped.push({ p: f.rel, code: codeOf(e) }); }
          prog(id, st, done, total, false);
          await tick(); // jangan membekukan proses pada ZIP besar
        }
      } finally { wf.release(); }
      prog(id, st, done, total, true);
      return { ok: true, done, total, skipped: skipped.slice(0, SKIP_KEEP), skippedN: skipped.length };
    } finally { running.delete(id); }
  });

  // ---- Ekspor ----
  const destOk = (f) => {
    if (typeof f !== 'string' || !f || f.length > 4096 || f.indexOf('\0') >= 0 || !path.isAbsolute(f)) return false;
    return !inside(path.resolve(f), path.resolve(core.opts.dataDir)); // data Archne (termasuk www/ semua situs) bukan tujuan simpan
  };
  let picking = false;
  on('webZipExport', async (id, rels) => {
    const wf = siteFiles(id);
    if (!Array.isArray(rels) || rels.length > MAX_BULK) throw bad();
    const sel = rels.map((r) => { const p = tryRel(relOf(r)); if (!p) throw pathBad(); return p; });
    if (typeof pickSave !== 'function') throw ek('e.lw.zip.nodialog', null, 'Dialog simpan tidak tersedia di perangkat ini', 'nodialog');
    // kumpulkan isi (tanpa symlink; list() sudah menyaring nama tak sah)
    const items = [], seen = new Set(), add = (it) => { if (items.length >= Z.LIMITS.entries) throw zerr({ name: 'ZipError', code: 'many' }); items.push(it); };
    let walked = 0;
    const fileItem = (rel, size, mtime) => ({ name: rel, size, mtime, read: (off, len) => { const r = wf.readRange(rel, off, len); return r ? r.buf : null; } });
    const walk = (dir) => {
      for (const e of wf.list(dir)) {
        if (++walked > MAX_WALK) throw zerr({ name: 'ZipError', code: 'many' });
        const nm = e.name.normalize('NFC'), rel = dir ? dir + '/' + nm : nm;
        if (seen.has(rel)) continue; seen.add(rel);
        if (e.type === 'dir') { add({ name: rel, dir: true, mtime: e.mtime }); walk(rel); } else add(fileItem(rel, e.size, e.mtime));
      }
    };
    if (!sel.length) walk('');
    else for (const p of sel) {
      if (seen.has(p)) continue;
      const s = wf.stat(p);
      if (!s) throw ek('e.lw.pathNone', null, 'Berkas atau folder tidak ditemukan', 'nofile');
      if (s.type === 'file') { seen.add(p); add(fileItem(p, s.size, s.mtime)); }
      else if (s.type === 'dir') { seen.add(p); add({ name: p, dir: true, mtime: s.mtime }); walk(p); }
      else throw ek('e.lw.pathLink', null, 'Tautan simbolik (symlink) tidak diizinkan', 'link');
    }
    if (!items.length) throw ek('e.lw.zip.empty', null, 'Situs ini belum punya berkas untuk diekspor', 'empty');
    if (picking) throw busyZ();
    picking = true; let f;
    try {
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0'), dom = String(core.webStore().get(id).domain || 'situs').replace(/[^A-Za-z0-9._-]/g, '-');
      f = await pickSave(dom + '-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '.zip', 'zip');
    } finally { picking = false; }
    if (typeof f !== 'string' || !f) return { ok: true, cancelled: true };
    if (!destOk(f)) throw ek('e.lw.zip.dest', null, 'Tujuan simpan tidak diizinkan', 'dest');
    if (!/\.zip$/i.test(f)) f += '.zip';
    if (running.has(id)) throw busyZ();
    running.add(id);
    const name = path.basename(f), st = { last: 0 };
    try {
      const r = await Z.writeZip(f, items, { onProgress: (done, total) => prog(id, st, done, total, done === total) });
      if (send) { try { send('webzip', { id, phase: 'done', name, n: r.n, size: r.size }); } catch {} }
      return { ok: true, name, n: r.n, size: r.size };
    } catch (e) {
      const z = zerr(e);
      if (send) { try { send('webzip', { id, phase: 'error', code: codeOf(z) }); } catch {} }
      throw z;
    } finally { running.delete(id); }
  });
}

module.exports = { registerWebZip };
