'use strict';
// src/archne-ipc-webfiles.js — jembatan renderer <-> berkas situs sendiri untuk pengelola berkas Web Lokal (0.34.0 Fase E). Dipanggil dari registerWeb() (archne-ipc-web.js).
// Semua operasi lewat WebFiles (satu pintu validasi jalur, tanpa symlink). Renderer hanya mengirim id situs + jalur RELATIF di www/ + teks; jalur disk tidak pernah keluar dan tidak pernah diterima kecuali sumber unggahan.
// Kanal (semua -> { ok:true, ... } | { ok:false, err, code }):
//   webFiles(id, dir?)                        -> { items:[{ name, type:'dir'|'file', size, mtime }] }  folder dulu, urut nama; dir '' = utama
//   webFileRead(id, rel)                      -> { text, size, mtime }   hanya jenis teks (TEXT_EXT), maksimal EDIT_MAX, harus UTF-8 sah
//   webFileView(id, rel)                      -> { kind:'image'|'audio'|'video', mime, size, b64 }   pratinjau media (ikon mata di Berkas); hanya jenis VIEW_MIME, maksimal VIEW_MAX[jenis]; isi dikirim base64 agar jalan juga lewat HTTP (Android / peramban)
//   webFileWrite(id, rel, text, { create?, base? }) -> { size, mtime }   create: harus belum ada ('exists'); base: mtime saat dibuka, berubah di luar = 'changed'
//   webMkdir(id, rel)  webRename(id, rel, newName)  webMove(id, rels[], destDir)  webDelete(id, rels[])   -> { n, failed:[{ p, code }] } untuk yang massal
//   webUpload(id, dir, paths[], { overwrite? }) -> { done, total, skipped:[{ p, code }], skippedN }  paths = berkas/folder di disk yang DIPILIH pengguna (dialog / seret-lepas; pathGuard di Electron)
// Unggahan: struktur folder dipertahankan; symlink, nama tak sah, dan tabrakan dilewati (dilaporkan), bukan menggagalkan semuanya. Sumber di dalam dataDir ditolak kecuali dataDir/shared (salinan sementara unggahan Android, dihapus setelah disalin).
const fs = require('fs'), path = require('path');
const { ek } = require('./core/archne-ecode');
const { tryRel, segOk, MAX_PATH } = require('./archne-webfiles');

const HEX16 = /^[0-9a-f]{16}$/;
const TEXT_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'svg', 'md', 'xml', 'webmanifest', 'php', 'sql', 'csv', 'yml', 'yaml']); // sama dengan LW_EDIT_RE di renderer/js/archne-web-edit.js (dijaga test/webuiu1.js)
const EDIT_MAX = 2 * 1024 * 1024; // batas editor teks (melindungi memori; bukan batas ukuran situs)
// Pratinjau media: ekstensi -> [jenis, MIME]. Sama dengan LW_VIEW_RE di renderer/js/archne-web-view.js (dijaga test/webuiu1.js). PDF tidak termasuk: CSP aplikasi tidak mengizinkan bingkai / objek untuk PDF.
const VIEW_MIME = { png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], avif: ['image', 'image/avif'], bmp: ['image', 'image/bmp'], ico: ['image', 'image/x-icon'], svg: ['image', 'image/svg+xml'],
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], ogg: ['audio', 'audio/ogg'], oga: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'], m4a: ['audio', 'audio/mp4'], aac: ['audio', 'audio/aac'], flac: ['audio', 'audio/flac'],
  mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], webm: ['video', 'video/webm'], ogv: ['video', 'video/ogg'] };
const VIEW_MAX = { image: 10 * 1024 * 1024, audio: 25 * 1024 * 1024, video: 25 * 1024 * 1024 }; // batas pratinjau per jenis (base64 melewati IPC / HTTP; gambar masuk lewat data: URL); yang lebih besar dibuka lewat Pratinjau situs
const MAX_PATHS = 1000, MAX_BULK = 500, MAX_WALK = 200000, SKIP_KEEP = 50, PROG_MS = 200, REL_MAX = 300;

const extOf = (p) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(p); return m ? m[1].toLowerCase() : ''; };
const inside = (p, base) => { const f = process.platform === 'win32' ? (x) => x.toLowerCase() : (x) => x; const r = path.relative(f(base), f(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function registerWebFiles({ on, core, guard, send, running }) {
  const dirs = () => { const d = path.resolve(core.opts.dataDir); return { dataDir: d, sharedDir: path.join(d, 'shared') }; }; // malas: Core tiruan di tes lain tidak punya opts
  const bad = () => ek('e.lw.err.bad', null, 'Permintaan tidak valid', 'bad');
  const siteFiles = (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    const ws = core.webStore();
    if (!ws.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    return ws.files(id);
  };
  const relOf = (p) => { if (typeof p !== 'string' || p.length > REL_MAX) throw bad(); return p; };
  const listOf = (a) => { if (!Array.isArray(a) || !a.length || a.length > MAX_BULK) throw bad(); return a.map(relOf); };
  const srcOk = (p) => {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.indexOf('\0') >= 0 || !path.isAbsolute(p)) return false;
    if (guard && !guard.has(p)) return false; // Electron: hanya yang dipilih lewat dialog / seret-lepas
    const { dataDir, sharedDir } = dirs(), r = path.resolve(p);
    return !inside(r, dataDir) || (inside(r, sharedDir) && r !== sharedDir); // data Archne (kunci identitas dst.) tidak boleh ikut terunggah
  };
  running = running || new Set(); // id situs yang sedang memproses berkas (satu per situs; dipakai bersama ZIP, lihat archne-ipc-webzip.js)

  on('webFiles', (id, dir) => ({ ok: true, items: siteFiles(id).list(dir == null || dir === '' ? '' : relOf(dir)) }));

  on('webFileRead', (id, rel) => {
    const wf = siteFiles(id), p = tryRel(relOf(rel));
    if (!p) throw ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path');
    if (!TEXT_EXT.has(extOf(p))) throw ek('e.lw.editType', null, 'Jenis berkas ini tidak bisa diedit sebagai teks', 'type');
    const buf = wf.read(p, { max: EDIT_MAX });
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw ek('e.lw.notText', null, 'Berkas ini bukan teks UTF-8, jadi tidak bisa diedit di sini', 'notext'); }
    return { ok: true, text, size: buf.length, mtime: wf.stat(p).mtime };
  });
  on('webFileView', (id, rel) => {
    const wf = siteFiles(id), p = tryRel(relOf(rel));
    if (!p) throw ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path');
    const m = Object.prototype.hasOwnProperty.call(VIEW_MIME, extOf(p)) ? VIEW_MIME[extOf(p)] : null;
    if (!m) throw ek('e.lw.viewType', null, 'Jenis berkas ini tidak bisa dipratinjau di sini', 'type');
    const buf = wf.read(p, { max: VIEW_MAX[m[0]] });
    return { ok: true, kind: m[0], mime: m[1], size: buf.length, b64: buf.toString('base64') };
  });
  on('webFileWrite', (id, rel, text, o) => {
    const wf = siteFiles(id), p = tryRel(relOf(rel));
    if (!p) throw ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path');
    if (typeof text !== 'string' || (o != null && (typeof o !== 'object' || Array.isArray(o)))) throw bad();
    if (!TEXT_EXT.has(extOf(p))) throw ek('e.lw.editType', null, 'Jenis berkas ini tidak bisa diedit sebagai teks', 'type');
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > EDIT_MAX) throw ek('e.lw.tooBig', null, 'Berkas terlalu besar untuk dibuka di sini', 'big');
    const st = wf.stat(p);
    if (o && o.create === true && st) throw ek('e.lw.pathExists', null, 'Sudah ada berkas atau folder dengan nama itu', 'exists');
    if (o && Number.isFinite(o.base) && st && st.mtime !== o.base) throw ek('e.lw.changed', null, 'Berkas berubah di luar editor sejak dibuka. Muat ulang dulu agar perubahan lain tidak tertimpa.', 'changed');
    wf.write(p, buf);
    const n = wf.stat(p);
    return { ok: true, size: n.size, mtime: n.mtime };
  });

  on('webMkdir', (id, rel) => { siteFiles(id).mkdir(relOf(rel)); return { ok: true }; });
  on('webRename', (id, rel, name) => { if (typeof name !== 'string') throw bad(); siteFiles(id).rename(relOf(rel), name); return { ok: true }; });

  // Massal: satu kegagalan tidak menggagalkan yang lain; rev naik sekali (hold/release).
  const bulk = (wf, items, fn) => {
    let n = 0; const failed = [];
    wf.hold();
    try { for (const it of items) { try { fn(it); n++; } catch (e) { failed.push({ p: it, code: e && typeof e.code === 'string' ? e.code : 'io' }); } } } finally { wf.release(); }
    return { ok: true, n, failed };
  };
  on('webMove', (id, rels, destDir) => {
    const wf = siteFiles(id), list = listOf(rels), dest = destDir === '' ? '' : tryRel(relOf(destDir));
    if (dest === null) throw ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path');
    if (dest !== '') { const st = wf.stat(dest); if (st && st.type !== 'dir') throw ek('e.lw.notDir', null, 'Bukan folder', 'notdir'); }
    return bulk(wf, list, (p) => { const q = tryRel(p); if (!q) throw ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path'); wf.move(q, dest ? dest + '/' + q.split('/').pop() : q.split('/').pop()); });
  });
  on('webDelete', (id, rels) => {
    const wf = siteFiles(id);
    return bulk(wf, listOf(rels), (p) => { try { wf.remove(p); } catch (e) { if (e && e.code !== 'nofile') throw e; } }); // sudah hilang (mis. folder induknya ikut terhapus) = berhasil
  });

  // Kumpulkan isi satu folder sumber (tanpa mengikuti symlink). Nama / jalur tak sah dilewati bersama isinya.
  async function walk(abs, rel, out, skipped, ctx) {
    let ents; try { ents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { skipped.push({ p: rel, code: 'io' }); return; }
    out.dirs.push(rel);
    for (const e of ents) {
      if (out.files.length + out.dirs.length > MAX_WALK) { ctx.cut = true; return; }
      const name = e.name.normalize('NFC'), child = rel + '/' + name;
      if (e.isSymbolicLink()) { skipped.push({ p: child, code: 'link' }); continue; }
      if (!segOk(name) || !tryRel(child)) { skipped.push({ p: child, code: 'name' }); continue; }
      if (e.isDirectory()) await walk(path.join(abs, e.name), child, out, skipped, ctx);
      else if (e.isFile()) out.files.push({ abs: path.join(abs, e.name), rel: child });
      else skipped.push({ p: child, code: 'type' });
      if (ctx.cut) return;
    }
  }
  on('webUpload', async (id, dir, paths, o) => {
    const wf = siteFiles(id);
    const base = dir == null || dir === '' ? '' : tryRel(relOf(dir));
    if (base === null) throw ek('e.lw.pathBad', null, 'Jalur berkas tidak valid', 'path');
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) throw bad();
    if (o != null && (typeof o !== 'object' || Array.isArray(o))) throw bad();
    if (!paths.every(srcOk)) throw ek('e.lw.srcBad', null, 'Sumber unggahan tidak diizinkan', 'src');
    if (running.has(id)) throw ek('e.lw.upBusy', null, 'Masih ada unggahan yang berjalan untuk situs ini', 'busy');
    if (base !== '') { const st = wf.stat(base); if (st && st.type !== 'dir') throw ek('e.lw.notDir', null, 'Bukan folder', 'notdir'); }
    running.add(id);
    const { sharedDir } = dirs();
    const overwrite = !!(o && o.overwrite === true), skipped = [], plan = { dirs: [], files: [] }, ctx = { cut: false }, temps = [];
    try {
      for (const src of paths) {
        const name = path.basename(src).normalize('NFC'), rel = base ? base + '/' + name : name;
        let st; try { st = await fs.promises.lstat(src); } catch { skipped.push({ p: name, code: 'srcnone' }); continue; }
        if (st.isSymbolicLink()) { skipped.push({ p: name, code: 'link' }); continue; }
        if (!segOk(name) || !tryRel(rel) || rel.length > MAX_PATH) { skipped.push({ p: name, code: 'name' }); continue; }
        if (st.isDirectory()) await walk(src, rel, plan, skipped, ctx);
        else if (st.isFile()) { plan.files.push({ abs: src, rel }); if (inside(path.resolve(src), sharedDir)) temps.push(src); }
        else skipped.push({ p: name, code: 'type' });
        if (ctx.cut) break;
      }
      const total = plan.files.length; let done = 0, last = 0;
      wf.hold();
      try {
        for (const d of plan.dirs) { try { if (!wf.stat(d)) wf.mkdir(d); } catch (e) { skipped.push({ p: d, code: e && typeof e.code === 'string' ? e.code : 'io' }); } }
        for (const f of plan.files) {
          try { await wf.importFile(f.rel, f.abs, { overwrite }); done++; } catch (e) { skipped.push({ p: f.rel, code: e && typeof e.code === 'string' && /^[a-z]{2,12}$/.test(e.code) ? e.code : 'io' }); }
          const now = Date.now();
          if (send && now - last >= PROG_MS) { last = now; try { send('webprog', { id, done: done + 0, total }); } catch {} }
        }
      } finally { wf.release(); }
      if (send) { try { send('webprog', { id, done, total }); } catch {} }
      for (const t of temps) { try { fs.rmSync(t, { force: true }); const h = path.dirname(t); if (path.dirname(path.resolve(h)) === path.resolve(sharedDir)) fs.rmdirSync(h); } catch {} } // salinan sementara unggahan Android
      return { ok: true, done, total, skipped: skipped.slice(0, SKIP_KEEP), skippedN: skipped.length, cut: ctx.cut };
    } finally { running.delete(id); }
  });
}

module.exports = { registerWebFiles, TEXT_EXT, EDIT_MAX, VIEW_MIME, VIEW_MAX, extOf };
