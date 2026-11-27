'use strict';
// src/archne-webstage.js — Penulis staging untuk "Jadikan offline" (0.34.0 Fase O2d-3). Menulis byte hasil pengambilan ke folder staging di dataDir. TIDAK menyentuh situs (www/), tanpa jaringan, tanpa IPC.
// Pemanggil (O2d-5) memberi root staging (absolut, mis. <dataDir>/webstage). Jalur disk HANYA untuk proses utama: tidak boleh dikirim ke renderer atau peer.
// API:
//   open(root, opts?, deps?) -> Promise { ok:true, stage } | { ok:false, code:'bad'|'io'|'link' }   (TIDAK PERNAH menolak/melempar)
//     root = jalur absolut folder staging (dibuat bila belum ada; tautan simbolik ditolak 'link'). Tiap pekerjaan = satu folder 'j<ms>-<hex8>' (JOB_RE) berisi: pool/ (badan per indeks), tmp/ (penulisan sementara), files/ (pohon akhir), manifest.json (ADA = pekerjaan selesai).
//     opts: { now } (tes). deps (tes): { fsp } pengganti fs.promises, { assign } pengganti webpath.assign.
//   stage.add(entry) -> Promise { ok:true, i, bytes, sha256, sri:{ status, alg? } } | { ok:false, i, code }   (TIDAK PERNAH menolak)
//     entry = butir hasil runAll (archne-webjob menambahkan `integrity` dari butir pemindai): { i, url, kind, ok, body, type, sha256?, finalUrl?, integrity? }. Butir ok:false dicatat sebagai ditolak (code asli pengambil) tanpa menulis apa pun.
//     code: bad (bentuk) | dup (indeks sudah dipakai; yang pertama menang) | state (sudah commit/abort) | body (bukan byte / kosong) | big (> 16 MB) | quota (total > 48 MB) | hash (sha256 kiriman != hitungan sendiri) | sri (mismatch) | io.
//     Kebijakan SRI: mismatch = TOLAK (tidak ditulis). none / unsupported / invalid = TERIMA, statusnya dicatat di manifest. sha256 dihitung ulang di sini; kiriman pengambil hanya dibandingkan, tidak dipercaya.
//   stage.commit() -> Promise { ok:true, dir, filesDir, manifest } | { ok:false, code:'state'|'io' }
//     Menetapkan jalur akhir SETELAH semua tipe diketahui: webpath.assign atas butir yang diterima (urutan indeks => hasil deterministik, tidak bergantung urutan selesai unduhan), memindahkan pool/<i> ke files/<rel>, lalu menulis manifest.json terakhir (atomik).
//     manifest = { v:1, job, created, items:[{ i, url, finalUrl?, kind, rel, bytes, sha256, type, sri:{ status, alg?, sri? }, renamed }], rejected:[{ i, url, kind, code }], totals:{ okN, rejectedN, bytes } }
//   stage.abort() -> Promise { ok:true }   Menghapus folder pekerjaan ini saja. Pembersihan otomatis (start, umur) = O2d-4.
//   stage.stats() -> { state:'open'|'committing'|'committed'|'aborted', okN, rejectedN, bytes }
//   liveJobs() -> Set nama pekerjaan yang masih terbuka di proses ini (dipakai pembersih O2d-4).
// Sikap: jalur akhir diperiksa ULANG di sini (bentuk daftar-putih + berada di dalam files/) walau webpath sudah aman; berkas di pool diperiksa ukurannya sebelum dipindah. Berkas 0600, folder 0700. Tanpa fsync: staging sementara, manifest ada = lengkap.
//   Jalur absolut > 240 karakter ditolak (batas Windows 260) sebagai 'path' pada butir itu, bukan galat pekerjaan.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webstage.js): tiap penjaga satu baris.
const nodeFs = require('fs'), path = require('path'), crypto = require('crypto');
const W = require('./archne-webpath');
const S = require('./archne-websri');

const LIM = { items: 500, file: 16 * 1024 * 1024, total: 48 * 1024 * 1024, abs: 240 };
const JOB_RE = /^j(\d{10,15})-([0-9a-f]{8})$/;
const LIVE = new Set(); // pekerjaan yang masih terbuka di proses ini (belum commit/abort): pembersih (O2d-4) tidak boleh menyentuhnya
const REL_RE = /^assets\/vendor\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const bad = (code) => ({ ok: false, code });
const isBody = (b) => Buffer.isBuffer(b) || b instanceof Uint8Array;
const toBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));
const str = (v) => (typeof v === 'string' ? v : '');

function safeRel(rel) {
  if (typeof rel !== 'string' || !REL_RE.test(rel)) return false; // G:rel
  return rel.split('/').every((s) => s !== '.' && s !== '..');
}
function inside(base, abs) { const r = path.relative(base, abs); return !!r && !r.startsWith('..') && !path.isAbsolute(r); }

async function open(root, opts, deps) {
  try {
    opts = opts && typeof opts === 'object' ? opts : {};
    deps = deps && typeof deps === 'object' ? deps : {};
    if (typeof root !== 'string' || !root || !path.isAbsolute(root)) return bad('bad');
    const fsp = deps.fsp || nodeFs.promises;
    const assign = typeof deps.assign === 'function' ? deps.assign : W.assign;
    const base = path.resolve(root);
    try { await fsp.mkdir(base, { recursive: true, mode: 0o700 }); } catch { return bad('io'); }
    try { if ((await fsp.lstat(base)).isSymbolicLink()) return bad('link'); } catch { return bad('io'); } // G:link
    const created = Number.isFinite(opts.now) ? Math.floor(opts.now) : Date.now();
    const job = 'j' + String(created).padStart(10, '0') + '-' + crypto.randomBytes(4).toString('hex');
    const dir = path.join(base, job);
    try {
      await fsp.mkdir(dir, { mode: 0o700 }); // tanpa recursive: tabrakan nama = galat, bukan dipakai bersama
      for (const d of ['pool', 'tmp', 'files']) await fsp.mkdir(path.join(dir, d), { mode: 0o700 });
    } catch { try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* */ } return bad('io'); }
    LIVE.add(job);
    return { ok: true, stage: makeStage({ fsp, assign, dir, job, created }) };
  } catch { return bad('io'); }
}

function makeStage({ fsp, assign, dir, job, created }) {
  const pool = path.join(dir, 'pool'), tmp = path.join(dir, 'tmp'), filesDir = path.join(dir, 'files');
  let state = 'open', bytes = 0;
  const acc = new Map(), rej = new Map(), seen = new Set(), pending = new Set();
  const rm = async (p) => { try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* */ } };

  function reject(i, url, kind, code) { rej.set(i, { i, url, kind, code }); return { ok: false, i, code }; }

  async function addInner(e) {
    if (!e || typeof e !== 'object' || !Number.isInteger(e.i) || e.i < 0 || e.i >= LIM.items) return bad('bad');
    const i = e.i, url = str(e.url), kind = str(e.kind);
    if (state !== 'open') return { ok: false, i, code: 'state' }; // G:state
    if (seen.has(i)) return { ok: false, i, code: 'dup' }; // G:dup
    seen.add(i);
    if (e.ok !== true) return reject(i, url, kind, typeof e.code === 'string' && /^[a-z]{2,12}$/.test(e.code) ? e.code : 'net');
    if (!url || !kind) return reject(i, url, kind, 'bad');
    if (!isBody(e.body) || !e.body.length) return reject(i, url, kind, 'body'); // G:body
    const body = toBuf(e.body);
    if (body.length > LIM.file) return reject(i, url, kind, 'big'); // G:big
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    if (typeof e.sha256 === 'string' && e.sha256.toLowerCase() !== sha) return reject(i, url, kind, 'hash'); // G:hash
    const v = S.verify(e.integrity, body, { sha256: sha });
    const sri = v.ok ? { status: v.status } : { status: 'invalid' };
    if (v.ok && v.alg) sri.alg = v.alg;
    if (v.ok && v.sri) sri.sri = v.sri;
    if (sri.status === 'mismatch') return reject(i, url, kind, 'sri'); // G:sri
    if (bytes + body.length > LIM.total) return reject(i, url, kind, 'quota'); // G:quota
    bytes += body.length; // dipesan sebelum menulis: unduhan serentak tidak bisa sama-sama lolos kuota
    const part = path.join(tmp, i + '.' + crypto.randomBytes(4).toString('hex') + '.part');
    try {
      await fsp.writeFile(part, body, { flag: 'wx', mode: 0o600 });
      if (state === 'aborted') { await rm(part); bytes -= body.length; return { ok: false, i, code: 'state' }; } // hanya abort yang membatalkan tulisan berjalan; commit menunggunya
      await fsp.rename(part, path.join(pool, String(i)));
    } catch { await rm(part); bytes -= body.length; return reject(i, url, kind, 'io'); }
    const item = { i, url, kind, type: str(e.type), bytes: body.length, sha256: sha, sri };
    const fu = str(e.finalUrl);
    if (fu && fu !== url) item.finalUrl = fu;
    acc.set(i, item);
    return { ok: true, i, bytes: body.length, sha256: sha, sri };
  }

  function add(e) {
    const p = addInner(e).catch(() => bad('io'));
    pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  }

  async function commit() {
    if (state !== 'open') return bad('state');
    state = 'committing';
    try {
      await Promise.all([...pending]);
      const order = [...acc.keys()].sort((a, b) => a - b);
      const res = assign(order.map((i) => ({ url: acc.get(i).url, kind: acc.get(i).kind, type: acc.get(i).type })));
      if (!res || !res.ok || !Array.isArray(res.results) || res.results.length !== order.length) throw new Error('assign');
      const items = [];
      for (let n = 0; n < order.length; n++) {
        const it = acc.get(order[n]), r = res.results[n];
        if (!r || !r.ok) { rej.set(it.i, { i: it.i, url: it.url, kind: it.kind, code: r && r.code ? r.code : 'path' }); bytes -= it.bytes; acc.delete(it.i); continue; }
        const abs = path.join(filesDir, ...String(r.rel).split('/'));
        if (!safeRel(r.rel) || !inside(filesDir, abs)) { rej.set(it.i, { i: it.i, url: it.url, kind: it.kind, code: 'path' }); bytes -= it.bytes; acc.delete(it.i); continue; } // G:contain
        if (abs.length > LIM.abs) { rej.set(it.i, { i: it.i, url: it.url, kind: it.kind, code: 'path' }); bytes -= it.bytes; acc.delete(it.i); continue; } // G:abs
        const src = path.join(pool, String(it.i));
        try {
          const st = await fsp.lstat(src);
          if (!st.isFile() || st.size !== it.bytes) throw new Error('size'); // G:size
          await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
          await fsp.rename(src, abs);
        } catch { rej.set(it.i, { i: it.i, url: it.url, kind: it.kind, code: 'io' }); bytes -= it.bytes; acc.delete(it.i); continue; }
        const o = { i: it.i, url: it.url };
        if (it.finalUrl) o.finalUrl = it.finalUrl;
        Object.assign(o, { kind: it.kind, rel: r.rel, bytes: it.bytes, sha256: it.sha256, type: it.type, sri: it.sri, renamed: !!r.renamed });
        items.push(o);
      }
      const rejected = [...rej.values()].sort((a, b) => a.i - b.i);
      const manifest = { v: 1, job, created, items, rejected, totals: { okN: items.length, rejectedN: rejected.length, bytes: items.reduce((s, x) => s + x.bytes, 0) } };
      const mt = path.join(tmp, 'manifest.part');
      await fsp.writeFile(mt, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      await fsp.rename(mt, path.join(dir, 'manifest.json')); // terakhir: ada manifest = pekerjaan lengkap
      await rm(pool); await rm(tmp);
      state = 'committed'; LIVE.delete(job);
      return { ok: true, dir, filesDir, manifest };
    } catch {
      state = 'aborted'; LIVE.delete(job);
      await rm(dir);
      return bad('io');
    }
  }

  async function abort() {
    if (state === 'committed') return { ok: true };
    state = 'aborted'; LIVE.delete(job);
    await Promise.all([...pending]).catch(() => {});
    await rm(dir); // G:clean
    return { ok: true };
  }

  function stats() { return { state, okN: acc.size, rejectedN: rej.size, bytes }; }
  return { job, dir, add, commit, abort, stats };
}

const liveJobs = () => new Set(LIVE);
module.exports = { open, safeRel, liveJobs, JOB_RE, LIM };
