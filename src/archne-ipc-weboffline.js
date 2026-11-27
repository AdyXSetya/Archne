'use strict';
// src/archne-ipc-weboffline.js — kanal "Jadikan offline" (0.34.0 Fase O2e): merakit pemindai O1 -> archne-webjob (O2d-5) di balik IPC. Dipanggil dari registerWeb() (archne-ipc-web.js).
// Start hanya MENGUNDUH ke folder staging (<dataDir>/webstage); situs (www/) baru diubah oleh webOfflineApply (O3). Jalur disk (folder pekerjaan, cadangan) TIDAK pernah keluar ke renderer.
// Kanal (semua -> { ok:true, ... } | { ok:false, err, code }):
//   webOfflineStart(id, { urls? }) -> { ok:true, aborted:false, total, fetched, failed, bytes, limits, saved, savedBytes, rejectedN, items:[{ url, kind, bytes, sri }], rejected:[{ url, kind, code }], more } | { ok:true, aborted:true, cancelled, total, fetched, failed, bytes, limits }
//       Menunggu sampai selesai (maks. 3 menit, tenggat runAll); kemajuan lewat event 'weboff'. Pemindaian O1 DIHITUNG ULANG di sini: renderer hanya memilih dari URL hasil pindai (urls), tidak pernah menyodorkan daftar sendiri
//       (jadi tidak bisa menyuruh proses utama mengambil URL sembarang). Hanya butir cls 'local'. Tanpa urls = hanya yang rank 'cdn' (yang 'other' harus dicentang pengguna, sesuai O1). Tidak ada yang bisa dipilih -> code 'none'.
//       Kode galat: bad | nosite | busy (ada pekerjaan lain, di situs mana pun, ATAU operasi berkas / pemindaian situs ini) | none | io.
//       O3c: sesudah putaran pertama, Start MENGIKUTI rantai di dalam CSS yang baru diunduh (@import, url() font / gambar, CSS lain), putaran demi putaran (maks. 3 putaran, 200 butir per putaran, 500 butir dan 48 MB seluruhnya, dalam tenggat 3 menit yang sama).
//       Alamat privat, layanan (peta, captcha, analitik ...) dan alamat berkata sandi tidak diikuti. Hasil bertambah `chain: { rounds, added, failed, limits:['time'|'items'|'bytes'|'io'], skipped:[{ url, why:'service'|'private'|'cred'|'limit' }], skippedN }`.
//       Putaran lanjutan yang gagal / lewat tenggat / melewati 48 MB dibuang SENDIRI (putaran sebelumnya tetap; sisanya tinggal `unresolved` di Apply). Batal di tengah rantai membuang SELURUH hasil.
//   webOfflineCancel()  -> { ok:true, cancelled:boolean }   membatalkan pekerjaan yang berjalan; hasilnya dibuang seluruhnya (webjob): tanpa folder, tanpa manifest.
//   webOfflineStatus()  -> { ok:true, state:'idle' } | { state:'running', id, phase, done, total, okN, failN, bytes } | { state:'ready', id, stale, saved, savedBytes, rejectedN, ts }   (tanpa jalur)
//       'ready' = hasil staging yang belum dipakai O3. stale:true = situs berubah (rev) atau hilang sejak dipindai, atau lewat 23 jam (pembersih webclean menghapus pada 24 jam): O3 tidak boleh memakainya.
//   webOfflineDiscard() -> { ok:true }   membuang hasil 'ready' (folder dihapus). Ditolak 'busy' saat pekerjaan berjalan.
//   webOfflineApply(id) -> { ok:true, added, reused, nochange, edited:[{ p, n }], editedN, replaced, sriRemoved, conflicts:[{ url, kind, why }], conflictN, unresolved:[{ p, url }], unresolvedN, skippedN, limits, undo } (O3)
//       Menerapkan hasil 'ready' milik situs ini: menyalin aset ke www/assets/vendor dan menulis ulang referensinya (src/archne-weboffapply.js). Berkas asli dicadangkan lebih dulu; Batalkan mengembalikannya. Berkas milik pemilik di jalur yang sama TIDAK ditimpa (conflicts).
//       Kode galat: bad | nosite | busy | nostage (tidak ada hasil 'ready' untuk situs ini) | stale | io. Hasil 'ready' DIPAKAI (dibuang) hanya bila berhasil; gagal = masih bisa dicoba lagi. Tidak bisa dibatalkan di tengah jalan (Cancel -> cancelled:false).
//   webOfflineUndoInfo(id) -> { ok:true, has:false } | { ok:true, has:true, ts, editedN, addedN }
//   webOfflineUndo(id) -> { ok:true, restored, removed, kept:[{ p, why:'changed'|'gone'|'backup' }] } | { ok:false, code:'nosite'|'busy'|'noundo'|'io' }   hanya SATU penerapan terakhir per situs yang bisa dibatalkan; berkas yang sudah diubah pemilik sesudahnya dibiarkan.
//   event 'weboff' { id, phase:'scan'|'run'|'apply'|'end', done?, total?, okN?, failN?, bytes?, ok?, aborted? }  dibatasi 200 ms; 'scan', 'apply' dan 'end' selalu dikirim.
// Kebijakan (keputusan O2e):
//   - SATU pekerjaan sekaligus di seluruh aplikasi (anggaran memori 48 MB runAll berlaku per pekerjaan). Pemindaian situs memegang `running` (berbagi dengan unggah / ZIP / pemindaian O1) HANYA selama membaca berkas; fase jaringan tidak,
//     supaya situs tidak terkunci hingga 3 menit. Gantinya: rev situs dicatat saat dipindai, dan hasil yang rev-nya sudah beda ditandai stale (O3 menolak).
//   - Hanya SATU hasil 'ready' disimpan. Pekerjaan baru (atau webOfflineDiscard) membuangnya lebih dulu lewat archne-webclean.sweep({ keepMs:0 }).
//   - Saat registrasi: archne-webclean.sweep({ startup:true }) dipanggil sekali (pekerjaan tanpa manifest = yatim proses lama). Start menunggu sapuan ini selesai supaya tidak bersaing dengan pekerjaan baru. Hasil bermanifest dari proses lama
//     TIDAK diingat (tidak ada di memori) dan disapu pada 24 jam.
//   - Untuk O3: registerWebOffline() mengembalikan { take(id) } -> { job, dir, filesDir, manifest, rev } | null. Mengambil = hasil jadi milik pemanggil (tidak dicatat lagi di sini, tidak dibuang oleh Start berikutnya; pembersih tetap menghapus pada 24 jam).
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/weboffline.js): tiap penjaga satu baris.
const path = require('path');
const { ek } = require('./core/archne-ecode');
const { scan } = require('./archne-webassets');
const { runJob } = require('./archne-webjob');
const { sweep } = require('./archne-webclean');
const AP = require('./archne-weboffapply');
const CH = require('./archne-weboffchain');
const RW = require('./archne-weboffrewrite');

const HEX16 = /^[0-9a-f]{16}$/;
const LIM = { urls: 500, url: 2048, rej: 50, saved: 100, str: 300, progMs: 200, readyMs: 23 * 3600e3, chainMs: 180000 };
const bad = () => ek('e.lw.err.bad', null, 'Permintaan tidak valid', 'bad');
const busy = () => ek('e.lw.off.busy', null, 'Masih ada pengunduhan aset yang berjalan', 'busy');
const clip = (s) => String(s).slice(0, LIM.str);

// Isian pilihan dari renderer -> null (bawaan) | Set URL; bentuk salah = bad.
function selOf(o) {
  if (o == null) return null;
  if (typeof o !== 'object' || Array.isArray(o)) throw bad();
  if (o.urls == null) return null;
  if (!Array.isArray(o.urls) || o.urls.length > LIM.urls || o.urls.some((u) => typeof u !== 'string' || u.length > LIM.url)) throw bad();
  return new Set(o.urls);
}

// deps (tes): { root, undoRoot, plan, commit, undo, scan, runJob, sweep, now, chainMs, chainBytes, jobOpts (opsi tambahan ke runJob, mis. allowHttp), jobDeps (deps runJob, mis. fetchOne) }
function registerWebOffline({ on, core, send, running }, deps) {
  deps = deps && typeof deps === 'object' ? deps : {};
  const doScan = deps.scan || scan, doJob = deps.runJob || runJob, doSweep = deps.sweep || sweep;
  const doPlan = deps.plan || AP.buildPlan, doCommit = deps.commit || AP.commit, doUndo = deps.undo || AP.undo;
  const nowMs = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
  const rootOf = () => deps.root || path.join(path.resolve(core.opts.dataDir), 'webstage'); // malas: Core tiruan di tes lain tidak punya opts
  // cadangan Batalkan: di folder situs (DI LUAR www/), ikut terhapus bersama situsnya
  const undoDirOf = (id) => (deps.undoRoot ? path.join(deps.undoRoot, id) : path.join(path.resolve(core.webStore().dir), id, 'offline-undo'));
  let cur = null, ready = null, taken = []; // taken = pekerjaan yang sudah diambil O3: sapuan keepMs:0 tidak boleh menghapusnya
  const boot = (deps.root || (core.opts && core.opts.dataDir)) ? Promise.resolve().then(() => doSweep(rootOf(), { startup: true })).catch(() => {}) : Promise.resolve();

  const emit = (me, p, force) => {
    const t = Date.now();
    if (!send || (!force && t - me.last < LIM.progMs)) return;
    me.last = t; try { send('weboff', Object.assign({ id: me.id }, p)); } catch { /* */ }
  };
  const fresh = (r) => {
    try {
      const ws = core.webStore();
      if (!ws.has(r.id) || nowMs() - r.ts > LIM.readyMs) return false;
      return ws.get(r.id).rev === r.rev; // G:stale
    } catch { return false; }
  };
  const discardReady = async () => {
    ready = null;
    try { await doSweep(rootOf(), { keepMs: 0, active: taken }); } catch { /* sapuan tidak pernah melempar; tiruan tes boleh */ } // G:keep
  };

  on('webOfflineStart', async (id, o) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    const sel = selOf(o);
    const ws = core.webStore();
    if (!ws.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    if (cur) throw busy(); // G:busy
    if (running.has(id)) throw ek('e.lw.zip.busy', null, 'Masih ada operasi berkas yang berjalan untuk situs ini', 'busy'); // G:files
    const me = cur = { id, ac: new AbortController(), cancelled: false, last: 0, rev: 0, prog: { phase: 'scan', done: 0, total: 0, okN: 0, failN: 0, bytes: 0 } };
    let out = null;
    try {
      emit(me, { phase: 'scan' }, true);
      await boot;
      let sc;
      running.add(id);
      try { me.rev = ws.get(id).rev; sc = await doScan(ws.files(id)); } finally { running.delete(id); }
      const pick = (it) => {
        if (!it || it.cls !== 'local') return false; // G:cls
        return sel ? sel.has(it.url) : it.rank === 'cdn'; // G:sel
      };
      const list = (sc && Array.isArray(sc.items) ? sc.items : []).filter(pick).map((it) => ({ url: it.url, kind: it.kind, cls: it.cls, integrity: it.integrity }));
      if (!list.length) throw ek('e.lw.off.none', null, 'Tidak ada aset yang bisa disalin dari pilihan ini', 'none');
      if (me.ac.signal.aborted) { out = { ok: true, aborted: true, cancelled: true, total: 0, fetched: 0, failed: 0, bytes: 0, limits: [] }; return out; }
      await discardReady(); // G:prev
      me.prog.phase = 'run'; me.prog.total = list.length;
      const jo = Object.assign({}, deps.jobOpts, {
        root: rootOf(), signal: me.ac.signal,
        onProgress: (p) => {
          me.prog = { phase: 'run', done: p.done, total: p.total, okN: p.okN, failN: p.failN, bytes: p.bytes };
          emit(me, me.prog, false);
        },
      });
      const t0 = Date.now();
      const r = await doJob(list, jo, deps.jobDeps);
      if (!r || !r.ok) throw ek('e.lw.ioFail', null, 'Gagal mengakses penyimpanan situs', 'io');
      const tot = { total: r.total, fetched: r.fetched, failed: r.failed, bytes: r.bytes };
      const headOf = () => Object.assign({}, tot, { limits: Array.isArray(r.limits) ? r.limits.slice() : [] });
      if (r.aborted) { out = Object.assign({ ok: true, aborted: true, cancelled: me.cancelled }, headOf()); return out; }

      // O3c: rantai di dalam CSS unduhan (font / gambar / CSS lain di domain lain). Putaran lanjutan memakai folder staging sendiri; hasilnya digabung di memori (butir.d = indeks folder).
      const root = rootOf(), deadline = t0 + (Number.isFinite(deps.chainMs) ? deps.chainMs : LIM.chainMs), capBytes = Number.isFinite(deps.chainBytes) ? deps.chainBytes : CH.LIM.bytes; // deps.chainMs / chainBytes: hanya untuk tes
      const dirs = [r.filesDir];
      let items = r.manifest.items.map((x) => Object.assign({}, x, { d: 0 }));
      let rejected = r.manifest.rejected.slice();
      let used = r.manifest.totals.bytes, latest = items;
      const chain = { rounds: 0, added: 0, failed: 0, limits: [], skipped: [], skippedN: 0 };
      const known = new Set();
      for (const x of items.concat(rejected)) { const c = RW.canon(x.url); if (c) known.add(c); }
      const cancelOut = async () => { await discardReady(); out = Object.assign({ ok: true, aborted: true, cancelled: true }, headOf()); return out; }; // batal di tengah rantai: SELURUH hasil dibuang, termasuk putaran yang sudah selesai
      const lim = (k) => { if (!chain.limits.includes(k)) chain.limits.push(k); };
      while (chain.rounds < CH.LIM.rounds) {
        if (me.ac.signal.aborted) return await cancelOut(); // (hemat satu putaran; runJob yang sudah dibatalkan juga berakhir di cancelOut)
        const left = deadline - Date.now();
        if (left < CH.LIM.minMs) { lim('time'); break; } // G:ctime
        const room = CH.LIM.total - items.length - rejected.length;
        if (room <= 0) { lim('items'); break; }
        const dsc = await CH.discover(latest, (it) => CH.readStyle(dirs[it.d], it), known, { max: Math.min(CH.LIM.round, room) });
        chain.skippedN += dsc.skippedN;
        for (const x of dsc.skipped) if (chain.skipped.length < LIM.rej) chain.skipped.push({ url: clip(x.url), why: x.why });
        if (dsc.skipped.some((x) => x.why === 'limit')) lim('items');
        if (!dsc.list.length) break;
        for (const x of dsc.list) known.add(x.url);
        chain.rounds++;
        const b = { done: tot.total, total: tot.total, okN: tot.fetched, failN: tot.failed, bytes: tot.bytes };
        me.prog = { phase: 'run', done: b.done, total: b.total + dsc.list.length, okN: b.okN, failN: b.failN, bytes: b.bytes };
        emit(me, me.prog, true); // total naik: UI perlu tahu segera, tanpa menunggu kemajuan pertama
        const rr = await doJob(dsc.list, Object.assign({}, deps.jobOpts, {
          root, signal: me.ac.signal, ms: left,
          onProgress: (p) => { me.prog = { phase: 'run', done: b.done + p.done, total: b.total + dsc.list.length, okN: b.okN + p.okN, failN: b.failN + p.failN, bytes: b.bytes + p.bytes }; emit(me, me.prog, false); },
        }), Object.assign({}, deps.jobDeps, { assign: CH.assignAfter(items, deps.jobDeps && deps.jobDeps.assign) }));
        if (rr && rr.ok && rr.aborted) { if (me.cancelled) return await cancelOut(); lim('time'); break; } // tenggat: putaran ini dibuang, putaran sebelumnya tetap
        if (!rr || !rr.ok) { lim('io'); break; } // gagal di putaran lanjutan tidak menggagalkan pekerjaan: yang sudah ada tetap konsisten, sisanya tinggal `unresolved`
        tot.total += rr.total; tot.fetched += rr.fetched; tot.failed += rr.failed; tot.bytes += rr.bytes;
        const rm = rr.manifest;
        if (used + rm.totals.bytes > capBytes) { lim('bytes'); break; } // G:cbytes — jumlah seluruh putaran tidak boleh melewati batas staging
        const off = items.concat(rejected).reduce((a, x) => Math.max(a, x.i), -1) + 1;
        const d = dirs.push(rr.filesDir) - 1;
        const add = rm.items.map((x) => Object.assign({}, x, { i: x.i + off, d }));
        items = items.concat(add); rejected = rejected.concat(rm.rejected.map((x) => Object.assign({}, x, { i: x.i + off })));
        used += rm.totals.bytes; chain.added += add.length; chain.failed += rm.rejected.length;
        latest = add;
      }
      if (me.ac.signal.aborted) return await cancelOut();

      const m = Object.assign({}, r.manifest, { items, rejected, totals: { okN: items.length, rejectedN: rejected.length, bytes: used } });
      ready = { id, rev: me.rev, ts: nowMs(), job: r.job, dir: r.dir, filesDir: r.filesDir, dirs, manifest: m };
      out = Object.assign({ ok: true, aborted: false }, headOf(), {
        saved: m.totals.okN, savedBytes: m.totals.bytes, rejectedN: m.totals.rejectedN,
        items: m.items.slice(0, LIM.saved).map((x) => ({ url: clip(x.url), kind: x.kind, bytes: x.bytes, sri: x.sri && x.sri.status })),
        rejected: m.rejected.slice(0, LIM.rej).map((x) => ({ url: clip(x.url), kind: x.kind, code: x.code })),
        more: m.items.length > LIM.saved || m.rejected.length > LIM.rej,
        chain,
      });
      return out;
    } finally {
      cur = null;
      emit(me, { phase: 'end', ok: !!(out && out.ok), aborted: !!(out && out.aborted) }, true);
    }
  });

  const STAGE_ERR = () => ek('e.lw.off.nostage', null, 'Belum ada hasil unduhan untuk situs ini', 'nostage');
  const clipList = (a, n, f) => a.slice(0, n).map(f);

  on('webOfflineApply', async (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    const ws = core.webStore();
    if (!ws.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    if (cur) throw busy(); // G:abusy
    if (running.has(id)) throw ek('e.lw.zip.busy', null, 'Masih ada operasi berkas yang berjalan untuk situs ini', 'busy');
    if (!ready || ready.id !== id) throw STAGE_ERR(); // G:astage
    const me = cur = { id, apply: true, ac: new AbortController(), cancelled: false, last: 0, rev: ready.rev, prog: { phase: 'apply', done: 0, total: 0, okN: 0, failN: 0, bytes: 0 } };
    running.add(id);
    let out = null;
    try {
      emit(me, { phase: 'apply' }, true);
      const wf = ws.files(id);
      if (!fresh(ready)) throw ek('e.lw.off.stale', null, 'Situs berubah sejak aset diunduh; unduh ulang', 'stale'); // G:astale — dicek SETELAH memegang running (tidak ada operasi lain yang bisa mengubah situs di antara cek dan tulis)
      const pl = await doPlan(wf, { filesDir: ready.filesDir, dirs: ready.dirs, manifest: ready.manifest }, { now: nowMs });
      if (!pl || !pl.ok) throw ek('e.lw.ioFail', null, 'Gagal mengakses penyimpanan situs', 'io');
      const plan = pl.plan;
      const c = await doCommit(wf, plan, { undoDir: undoDirOf(id), job: ready.job, now: nowMs() });
      if (!c || !c.ok) throw ek('e.lw.ioFail', null, 'Gagal mengakses penyimpanan situs', 'io');
      const used = ready; // berhasil: hasil staging sudah habis dipakai
      ready = null;
      try { await doSweep(rootOf(), { keepMs: 0, active: taken }); } catch { /* */ } // G:akeep
      void used;
      out = {
        ok: true, added: c.added, reused: c.reused, nochange: !!c.nochange,
        edited: clipList(plan.edits, LIM.saved, (e) => ({ p: clip(e.rel), n: e.n })), editedN: plan.edits.length, replaced: plan.replaced, sriRemoved: plan.sri,
        conflicts: clipList(plan.conflicts, LIM.rej, (x) => ({ url: clip(x.url), kind: x.kind, why: x.why })), conflictN: plan.conflicts.length,
        unresolved: clipList(plan.unresolved, LIM.rej, (x) => ({ p: clip(x.p), url: clip(x.url) })), unresolvedN: plan.unresolvedN,
        skippedN: plan.skippedN, limits: plan.limits.slice(), undo: !c.nochange,
      };
      return out;
    } finally {
      running.delete(id); cur = null;
      emit(me, { phase: 'end', ok: !!out, aborted: false }, true);
    }
  });

  on('webOfflineUndoInfo', async (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    if (!core.webStore().has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    return Object.assign({ ok: true }, await AP.undoInfo(undoDirOf(id)));
  });

  on('webOfflineUndo', async (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    const ws = core.webStore();
    if (!ws.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    if (cur) throw busy(); // G:ubusy
    if (running.has(id)) throw ek('e.lw.zip.busy', null, 'Masih ada operasi berkas yang berjalan untuk situs ini', 'busy');
    cur = { id, apply: true, ac: new AbortController(), cancelled: false, last: 0, rev: 0, prog: { phase: 'apply', done: 0, total: 0, okN: 0, failN: 0, bytes: 0 } };
    running.add(id);
    try {
      const r = await doUndo(ws.files(id), undoDirOf(id));
      if (!r || !r.ok) {
        if (r && r.code === 'noundo') throw ek('e.lw.off.noundo', null, 'Tidak ada penerapan yang bisa dibatalkan', 'noundo');
        throw ek('e.lw.ioFail', null, 'Gagal mengakses penyimpanan situs', 'io');
      }
      return { ok: true, restored: r.restored, removed: r.removed, kept: clipList(r.kept, LIM.rej, (x) => ({ p: clip(x.p), why: x.why })) };
    } finally { running.delete(id); cur = null; }
  });

  on('webOfflineCancel', () => {
    if (!cur || cur.apply) return { ok: true, cancelled: false }; // penerapan tidak bisa dibatalkan di tengah jalan: berkasnya ditulis atomik dan bisa di-Batalkan sesudahnya
    cur.cancelled = true; cur.ac.abort();
    return { ok: true, cancelled: true };
  });

  on('webOfflineStatus', () => {
    if (cur) return Object.assign({ ok: true, state: 'running', id: cur.id }, cur.prog);
    if (ready) {
      const m = ready.manifest;
      return { ok: true, state: 'ready', id: ready.id, stale: !fresh(ready), saved: m.totals.okN, savedBytes: m.totals.bytes, rejectedN: m.totals.rejectedN, ts: ready.ts };
    }
    return { ok: true, state: 'idle' };
  });

  on('webOfflineDiscard', async () => {
    if (cur) throw busy();
    await discardReady();
    return { ok: true };
  });

  // Untuk O3 (proses utama saja; bukan kanal).
  function take(id) {
    if (!ready || ready.id !== id || !fresh(ready)) return null;
    const r = ready;
    ready = null; // G:take
    taken = taken.concat(r.job).slice(-20);
    return { job: r.job, dir: r.dir, filesDir: r.filesDir, dirs: r.dirs, manifest: r.manifest, rev: r.rev };
  }
  const peek = (id) => (!ready || ready.id !== id ? 'none' : fresh(ready) ? 'ok' : 'stale');
  return { take, peek };
}

module.exports = { registerWebOffline };
