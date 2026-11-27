'use strict';
// src/archne-weboffapply.js — Penerapan "Jadikan offline" (0.34.0 Fase O3b): hasil staging (O2d) -> salinan di www/assets/vendor + penulisan ulang referensi, dengan CADANGAN dan BATALKAN. Tanpa jaringan, tanpa IPC (kanalnya di archne-ipc-weboffline.js).
// API (semuanya async, TIDAK melempar untuk masukan buruk; galat = { ok:false, code }):
//   buildPlan(wf, job, deps?) -> { ok:true, plan } | { ok:false, code:'bad'|'io' }       TIDAK menulis apa pun.
//     wf = WebFiles situs; job = { filesDir, manifest, dirs? } (hasil take O2e). dirs (O3c) = folder files/ tiap putaran unduhan; butir manifest dengan `d` mengambil berkasnya dari dirs[d], selain itu dari filesDir. Langkah: (1) tiap butir manifest dicocokkan dengan www/: belum ada = tambah, ada dengan isi sama = pakai ulang, selain itu = BENTROK (butir itu tidak dipakai, referensinya tetap ke URL asli;
//     berkas milik pemilik tidak pernah ditimpa). (2) CSS hasil unduhan ditulis ulang (referensi relatif diurai terhadap URL asalnya); referensi yang belum ada salinannya = `unresolved` (rantai font / gambar dalam CSS CDN: butuh unduhan lanjutan, O3c).
//     (3) berkas situs (ekstensi dan batas sama dengan pemindai O1; assets/vendor, node_modules, .git dilewati) ditulis ulang di memori. Ulangi (1)-(2) sampai bentrok stabil.
//     plan = { entries:[{ rel, kind:'add'|'reuse', ... }], conflicts:[{ url, rel, kind }], edits:[{ rel, n, before, after }], replaced, sri, unresolved:[{ p, url }], unresolvedN, skippedN, limits:[kode] }
//   commit(wf, plan, { undoDir, job?, now? }) -> { ok:true, added, reused, edited, nochange? } | { ok:false, code:'io' }
//     Tidak ada perubahan (semua dipakai ulang, tidak ada berkas yang perlu ditulis ulang) = { ok:true, nochange:true } dan cadangan sebelumnya dibiarkan.
//     Urutan aman terhadap crash: (1) cadangan berkas asli + undo.json (atomik) di undoDir (DI LUAR www/), (2) berkas vendor, (3) berkas situs yang diedit TERAKHIR. Mati di tengah = situs masih menunjuk ke URL asli (aman). Gagal di tengah = dikembalikan dari cadangan.
//     Cadangan penerapan sebelumnya dibuang: hanya SATU penerapan yang bisa dibatalkan (yang terakhir). rev situs naik sekali (hold / release).
//   undo(wf, undoDir) -> { ok:true, restored, removed, kept:[{ p, why:'changed'|'gone'|'backup' }] } | { ok:false, code:'noundo'|'bad'|'io' }
//     Hanya berkas yang isinya MASIH sama dengan hasil penerapan (sha256) yang dikembalikan / dihapus; yang sudah diubah pemilik sesudahnya dibiarkan (kept). Folder di bawah assets/ yang menjadi kosong dirapikan (sampai assets itu sendiri). Cadangan dibuang setelahnya.
//   undoInfo(undoDir) -> { has:false } | { has:true, ts, editedN, addedN }
// Jalur disk (filesDir, undoDir) hanya untuk proses utama; yang keluar hanyalah jalur DI DALAM situs (rel).
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/weboffapply.js): tiap penjaga satu baris.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const RW = require('./archne-weboffrewrite');
const { tryRel } = require('./archne-webfiles');

const fsp = fs.promises;
const SCAN_EXT = new Set(['html', 'htm', 'xhtml', 'php', 'svg', 'css', 'js', 'mjs']);
const SKIP_DIR = new Set(['node_modules', '.git']);
const VENDOR = 'assets/vendor';
const LIM = { file: 1024 * 1024, files: 3000, entries: 50000, bytes: 32 * 1024 * 1024, ms: 8000, vendor: 16 * 1024 * 1024, list: 500, passes: 8 };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const REL_RE = /^assets\/vendor\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/; // jalur butir manifest: hanya di bawah assets/vendor (webpath menjamin; dicek ulang di sini)
const bad = (code) => ({ ok: false, code });
const extOf = (p) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(p); return m ? m[1].toLowerCase() : ''; };
const tick = () => new Promise((r) => setImmediate(r));
const inside = (base, abs) => { const r = path.relative(base, abs); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
function utf8(buf) { // teks yang BISA ditulis balik persis (tanpa NUL, tanpa urutan UTF-8 rusak); selain itu berkas tidak disentuh
  if (buf.indexOf(0) >= 0) return null;
  const t = buf.toString('utf8');
  return Buffer.from(t, 'utf8').equals(buf) ? t : null;
}
function statOf(wf, rel) { try { return wf.stat(rel); } catch { return 'err'; } }
function readIf(wf, rel, max) { try { return wf.read(rel, { max }); } catch { return null; } }
async function putFile(abs, buf) { // atomik: tulis sementara lalu rename; berkas 0600, folder 0700
  await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = abs + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  try { await fsp.writeFile(tmp, buf, { flag: 'wx', mode: 0o600 }); await fsp.rename(tmp, abs); } catch (e) { try { await fsp.rm(tmp, { force: true }); } catch { /* */ } throw e; }
}
const rmrf = async (p) => { try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* */ } };

// ---- rencana ----
async function buildPlan(wf, job, deps) {
  try {
    deps = deps && typeof deps === 'object' ? deps : {};
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    if (!wf || !job || typeof job.filesDir !== 'string' || !job.manifest || !Array.isArray(job.manifest.items)) return bad('bad');
    const items = job.manifest.items.slice().sort((a, b) => a.i - b.i);
    const dirOf = (it) => (Array.isArray(job.dirs) && Number.isInteger(it.d) && typeof job.dirs[it.d] === 'string' ? job.dirs[it.d] : job.filesDir);
    const conflicts = new Map(); // rel -> { url, rel, kind }
    let pass = null;
    for (let n = 0; n < Math.max(LIM.passes, items.length + 2); n++) {
      const map = RW.makeMap(items.filter((it) => !conflicts.has(it.rel)));
      const st = { n: 0, sri: 0, unresolved: [], unresolvedN: 0 };
      const entries = [];
      let more = false;
      for (const it of items) {
        if (conflicts.has(it.rel)) continue;
        if (!it || typeof it.rel !== 'string' || !REL_RE.test(it.rel) || it.rel.split('/').some((x) => x === '.' || x === '..')) { conflicts.set(String(it && it.rel), { url: String(it && it.url), rel: String(it && it.rel), kind: String(it && it.kind), why: 'path' }); more = true; continue; } // G:rel
        const abs = path.join(dirOf(it), ...String(it.rel).split('/')); // O3c: butir putaran lanjutan ada di folder staging lain (it.d = indeks di job.dirs)
        let buf;
        try {
          const ls = await fsp.lstat(abs);
          if (!ls.isFile() || ls.size !== it.bytes) throw new Error('size');
          buf = await fsp.readFile(abs);
        } catch { conflicts.set(it.rel, { url: it.url, rel: it.rel, kind: it.kind, why: 'missing' }); more = true; continue; }
        let data = null;
        if (it.kind === 'style') {
          const t = utf8(buf);
          if (t != null) { const out = RW.rewriteVendorCss(it.rel, t, it.finalUrl || it.url, map, st); if (out !== t) data = Buffer.from(out, 'utf8'); }
        }
        const body = data || buf;
        const cur = statOf(wf, it.rel);
        if (cur === 'err' || (cur && cur.type !== 'file')) { conflicts.set(it.rel, { url: it.url, rel: it.rel, kind: it.kind, why: 'path' }); more = true; continue; }
        if (!cur) { entries.push({ rel: it.rel, kind: 'add', url: it.url, bytes: body.length, sha: sha(body), data: data || null, abs: data ? null : abs }); continue; }
        const have = cur.size <= LIM.vendor ? readIf(wf, it.rel, LIM.vendor) : null;
        const hv = have ? sha(have) : '';
        if (hv && (hv === sha(buf) || hv === sha(body))) { entries.push({ rel: it.rel, kind: 'reuse', url: it.url }); continue; } // G:reuse
        conflicts.set(it.rel, { url: it.url, rel: it.rel, kind: it.kind, why: 'exists' }); more = true; // G:overwrite — berkas lain di jalur itu: tidak pernah ditimpa
      }
      pass = { map, st, entries };
      if (!more) break;
      pass = null;
    }
    if (!pass) return bad('io');
    const { map, entries } = pass;
    const vst = pass.st;

    // berkas situs
    const lim = new Set(), edits = [], sst = { n: 0, sri: 0 };
    let skippedN = 0, scanned = 0, bytes = 0, entriesN = 0;
    const t0 = Date.now();
    if (map.size) {
      const queue = [''];
      outer: while (queue.length) {
        const dir = queue.shift();
        let list; try { list = wf.list(dir); } catch { continue; }
        for (const e of list) {
          if (++entriesN > LIM.entries) { lim.add('entries'); break outer; }
          const rel = dir ? dir + '/' + e.name : e.name;
          if (e.type === 'dir') { if (!SKIP_DIR.has(e.name.toLowerCase()) && rel !== VENDOR) queue.push(rel); continue; }
          if (!SCAN_EXT.has(extOf(e.name))) continue;
          if (scanned >= LIM.files) { lim.add('files'); break outer; }
          if (bytes + e.size > LIM.bytes) { lim.add('bytes'); break outer; }
          if (Date.now() - t0 > LIM.ms) { lim.add('time'); break outer; }
          if (e.size > LIM.file) { skippedN++; continue; }
          const buf = readIf(wf, rel, LIM.file);
          if (!buf) { skippedN++; continue; }
          bytes += buf.length; scanned++;
          const t = utf8(buf);
          if (t == null) { skippedN++; continue; }
          const b = sst.n;
          const out = RW.rewriteFile(rel, t, map, sst);
          if (out !== t) edits.push({ rel, n: sst.n - b, before: buf, after: Buffer.from(out, 'utf8') });
          if (scanned % 25 === 0) await tick();
        }
      }
    }
    return {
      ok: true,
      plan: {
        entries, conflicts: [...conflicts.values()], edits, replaced: sst.n, sri: sst.sri,
        unresolved: vst.unresolved, unresolvedN: vst.unresolvedN, skippedN, limits: [...lim], now: now(),
      },
    };
  } catch { return bad('io'); }
}

// ---- penerapan ----
async function commit(wf, plan, o) {
  o = o && typeof o === 'object' ? o : {};
  const undoDir = o.undoDir;
  if (!wf || !plan || typeof undoDir !== 'string' || !path.isAbsolute(undoDir)) return bad('bad');
  const adds = plan.entries.filter((e) => e.kind === 'add');
  const reused = plan.entries.length - adds.length;
  if (!adds.length && !plan.edits.length) return { ok: true, nochange: true, added: 0, reused, edited: 0 }; // tidak ada yang berubah: cadangan penerapan sebelumnya TETAP (masih bisa dibatalkan)
  const done = { added: [], edited: [] };
  let held = false;
  try {
    await rmrf(undoDir); // penerapan sebelumnya menjadi permanen
    const filesBase = path.join(undoDir, 'files');
    await fsp.mkdir(filesBase, { recursive: true, mode: 0o700 });
    for (const e of plan.edits) {
      const dst = path.join(filesBase, ...e.rel.split('/'));
      if (!inside(filesBase, dst)) throw new Error('path');
      await putFile(dst, e.before); // G:backup
    }
    const rec = {
      v: 1, ts: Number.isFinite(o.now) ? o.now : Date.now(), job: typeof o.job === 'string' ? o.job : '',
      edited: plan.edits.map((e) => ({ rel: e.rel, before: sha(e.before), after: sha(e.after) })),
      added: adds.map((e) => ({ rel: e.rel, sha: e.sha })),
    };
    await putFile(path.join(undoDir, 'undo.json'), Buffer.from(JSON.stringify(rec), 'utf8'));
    wf.hold(); held = true;
    for (const e of adds) {
      if (e.data) wf.write(e.rel, e.data);
      else await wf.importFile(e.rel, e.abs, { overwrite: false });
      done.added.push(e);
    }
    for (const e of plan.edits) { wf.write(e.rel, e.after); done.edited.push(e); } // berkas situs ditulis TERAKHIR (dites dengan pencatat urutan tulis)
  } catch {
    let clean = true;
    if (held) {
      for (const e of done.edited) { try { wf.write(e.rel, e.before); } catch { clean = false; } }
      for (const e of done.added) { try { const c = readIf(wf, e.rel, LIM.vendor); if (c && sha(c) === e.sha) wf.remove(e.rel); } catch { clean = false; } }
      try { wf.release(); } catch { /* */ }
      held = false;
    }
    if (clean) await rmrf(undoDir); // tidak ada yang perlu dibatalkan
    return bad('io');
  }
  try { wf.release(); } catch { /* */ }
  return { ok: true, added: adds.length, reused, edited: plan.edits.length };
}

// ---- Batalkan ----
async function readUndo(undoDir) {
  if (typeof undoDir !== 'string' || !path.isAbsolute(undoDir)) return null;
  let raw;
  try { const f = path.join(undoDir, 'undo.json'); const ls = await fsp.lstat(f); if (!ls.isFile() || ls.size > 4 * 1024 * 1024) return null; raw = await fsp.readFile(f, 'utf8'); } catch { return null; }
  let r; try { r = JSON.parse(raw); } catch { return null; }
  if (!r || r.v !== 1 || !Array.isArray(r.edited) || !Array.isArray(r.added) || !Number.isFinite(r.ts)) return null;
  const okRel = (x) => x && typeof x.rel === 'string' && tryRel(x.rel) === x.rel;
  if (!r.edited.every((x) => okRel(x) && HEX64.test(x.before) && HEX64.test(x.after))) return null;
  if (!r.added.every((x) => okRel(x) && x.rel.startsWith(VENDOR + '/') && HEX64.test(x.sha))) return null;
  return r;
}

async function undoInfo(undoDir) {
  const r = await readUndo(undoDir);
  return r ? { has: true, ts: r.ts, editedN: r.edited.length, addedN: r.added.length } : { has: false };
}

async function undo(wf, undoDir) {
  if (!wf) return bad('bad');
  const r = await readUndo(undoDir);
  if (!r) return bad('noundo');
  const kept = [];
  let restored = 0, removed = 0, held = false;
  const dirs = new Set();
  try {
    wf.hold(); held = true;
    const filesBase = path.join(undoDir, 'files');
    for (const e of r.edited) {
      const cur = readIf(wf, e.rel, LIM.file * 2);
      if (!cur) { kept.push({ p: e.rel, why: 'gone' }); continue; }
      const h = sha(cur);
      if (h === e.before) continue; // sudah asli (penerapan terhenti sebelum menulis berkas ini)
      if (h !== e.after) { kept.push({ p: e.rel, why: 'changed' }); continue; } // G:guardE — pemilik mengubahnya sesudah penerapan
      let orig = null;
      try { const src = path.join(filesBase, ...e.rel.split('/')); if (inside(filesBase, src)) orig = await fsp.readFile(src); } catch { /* */ }
      if (!orig || sha(orig) !== e.before) { kept.push({ p: e.rel, why: 'backup' }); continue; }
      wf.write(e.rel, orig); restored++;
    }
    for (const a of r.added) {
      const cur = readIf(wf, a.rel, LIM.vendor);
      if (!cur) continue;
      if (sha(cur) !== a.sha) { kept.push({ p: a.rel, why: 'changed' }); continue; } // G:guardA
      wf.remove(a.rel); removed++;
      dirs.add(path.posix.dirname(a.rel));
    }
    // rapikan folder yang menjadi kosong, dari yang terdalam, naik sampai 'assets' (folder lain tidak disentuh)
    const order = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    for (let d of order) {
      while (d && (d === 'assets' || d.startsWith(VENDOR))) { // leluhur diperiksa ulang tiap rantai: baru kosong setelah rantai saudaranya selesai
        let empty = false; try { empty = wf.list(d).length === 0; } catch { break; }
        if (!empty) break;
        try { wf.remove(d); } catch { break; }
        d = path.posix.dirname(d);
      }
    }
  } catch {
    if (held) { try { wf.release(); } catch { /* */ } }
    return bad('io');
  }
  try { wf.release(); } catch { /* */ }
  await rmrf(undoDir);
  return { ok: true, restored, removed, kept };
}

module.exports = { buildPlan, commit, undo, undoInfo, utf8, LIM };
