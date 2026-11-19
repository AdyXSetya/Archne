'use strict';
// src/core/archne-direct-recv.js — Kirim Langsung, sisi PENERIMA (v0.24.0). Protokol byte ada di src/archne-direct.js, sisi pengirim di archne-direct-send.js.
// Sesi masuk: { id, from, fromName, ip, port, ts, name, kind, count, size, state, dir, done, failed:[{p,code}], err?, code? }.
// state: offered | listing | running | waiting | paused | done | error | cancelled.
//   running = byte mengalir; waiting = pengirim putus/sibuk, sambung ulang otomatis; paused = dijeda (pengguna, aplikasi ditutup, atau macet > 3 menit).
// Daftar berkas (dx_list) disimpan di dataDir/direct/in-<id>.files.json: tiap entri { p, s, m, r, d? }, r = path tujuan relatif yang SUDAH dibersihkan.
// Resume tidak butuh catatan per berkas: berkas final bersize benar = selesai, `<berkas>.archne-part` = lanjut dari ukurannya.
// Struktur folder sama persis dengan pengirim; nama yang tak sah di sistem berkas ini dibersihkan, nama teratas yang sudah ada diberi akhiran " (n)".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Direct = require('../archne-direct');
const { HEX16, HEX32 } = require('./archne-constants');
const { ek } = require('./archne-ecode');

const DX_CONNS = 4, DX_STALL_MS = 180000, DX_MAX_IN = 200, DX_PER_PEER = 20, DX_COUNT_MAX = 5e6, DX_KEEP_MS = 14 * 86400000;
const sleep = (ms, sig) => new Promise((res) => { const t = setTimeout(res, ms); if (sig) sig.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };

module.exports = {
  // Folder tujuan: Pengaturan pengguna (settings.json `directDir`) > bawaan. Bawaan = opts.directDir (diberikan cangkang: PC Windows = C:\file_transfer) atau <folder unduhan>/file_transfer. Per sesi bisa diganti lewat directAccept({ dir }).
  _directDirDef() { return this.opts.directDir || path.join(this._downloadDir(), 'file_transfer'); },
  _directDir() { return (this._settings && this._settings.directDir) || this.opts.directDir || this._directDirDef(); },
  _dxSaveIn(s, files) {
    try {
      fs.mkdirSync(this._dxDir(), { recursive: true });
      if (files) wj(this._dxFile('in', s.id, '.files.json'), files);
      wj(this._dxFile('in', s.id, '.json'), s);
    } catch (e) { this.log('direct simpan gagal: ' + e.message); }
  },
  _dxFiles(s) {
    let f = this._dxFl.get(s.id);
    if (!f) { f = JSON.parse(fs.readFileSync(this._dxFile('in', s.id, '.files.json'), 'utf8')); this._dxFl.set(s.id, f); }
    return f;
  },
  _dxDropIn(id) {
    this._dxIn.delete(id); this._dxFl.delete(id);
    for (const ext of ['.json', '.files.json']) { try { fs.unlinkSync(this._dxFile('in', id, ext)); } catch {} }
  },
  _dxLoadIn() {
    let names = [];
    try { names = fs.readdirSync(this._dxDir()); } catch { return; }
    for (const n of names) {
      const mt = /^in-([0-9a-f]{32})\.json$/.exec(n);
      if (!mt) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this._dxDir(), n), 'utf8'));
        if (s.id !== mt[1] || Date.now() - s.ts > DX_KEEP_MS) { this._dxDropIn(mt[1]); continue; }
        if (s.state === 'listing' || s.state === 'running' || s.state === 'waiting') { s.state = 'paused'; s.code = 'restart'; } // aplikasi ditutup di tengah jalan: lanjut manual
        if (s.state === 'listing' && !fs.existsSync(this._dxFile('in', s.id, '.files.json'))) s.state = 'offered';
        this._dxIn.set(s.id, s);
      } catch { this._dxDropIn(mt[1]); }
    }
  },

  // ---- tawaran masuk (dari _handle) ----
  _dxOffer(o, ip, rid) {
    const no = (err) => ({ t: 'ack', ok: false, err });
    if (!this._directOk(ip)) return no('lan');
    const p = rid ? this.peers.get(rid) : null;
    if (!p) return no('bad');
    if (this.isBlocked(rid)) return { t: 'ack', ok: true }; // dibuang diam-diam: pengirim tidak tahu diblokir
    if (!HEX32.test(String(o.id)) || typeof o.name !== 'string' || (o.kind !== 'file' && o.kind !== 'dir')) return no('bad');
    if (!Number.isSafeInteger(o.count) || o.count < 1 || o.count > DX_COUNT_MAX || !Number.isSafeInteger(o.size) || o.size < 0) return no('bad');
    if (this._dxIn.has(o.id)) return { t: 'ack', ok: true };
    let all = 0, mine = 0;
    for (const s of this._dxIn.values()) { all++; if (s.from === rid && s.state === 'offered') mine++; }
    if (all >= DX_MAX_IN || mine >= DX_PER_PEER) return no('busy');
    const s = { id: o.id, from: rid, fromName: p.name, ip: String(ip).replace('::ffff:', ''), port: p.port, ts: Date.now(), name: Direct.cleanSeg(o.name.slice(0, 200)), kind: o.kind, count: o.count, size: o.size, tops: Number.isSafeInteger(o.tops) ? o.tops : 1, state: 'offered', done: 0, failed: [] };
    this._dxIn.set(s.id, s);
    this._dxSaveIn(s);
    this.emit('update'); this.emit('direct_offer', this._dxSumIn(s));
    return { t: 'ack', ok: true };
  },
  // Buang berkas setengah jadi (.archne-part) milik sesi; yang sudah lengkap dibiarkan.
  async _dxRmParts(s) {
    if (!s.dir) return;
    let files = []; try { files = this._dxFiles(s); } catch { return; }
    for (const f of files) if (!f.d) { const full = Direct.under(s.dir, f.r); if (full) await fs.promises.rm(full + Direct.PART, { force: true }).catch(() => {}); }
  },
  // Pengirim membatalkan sesi yang sedang kuterima.
  _dxCtlIn(o, rid) {
    const s = HEX32.test(String(o.id)) ? this._dxIn.get(o.id) : null;
    if (!s || !rid || rid !== s.from) return { t: 'ack', ok: false };
    const run = this._dxRun.get(s.id);
    if (run) { run.stop = 'cancelled'; run.ac.abort(); }
    if (s.state === 'offered') this._dxDropIn(s.id);
    else if (s.state !== 'done') {
      s.state = 'cancelled'; s.code = 'gone'; s.err = Direct.TEXT.gone; this._dxSaveIn(s);
      Promise.resolve(run && run.p).then(() => this._dxRmParts(s)); // tunggu unduhan benar-benar berhenti, lalu buang .part
    }
    this.emit('update');
    return { t: 'ack', ok: true };
  },

  _dxPeer(s) {
    const p = this.peers.get(s.from);
    const ip = p && this.isOnline(p) ? p.ip : s.ip, port = (p && p.port) || s.port;
    if (!this._directOk(ip)) throw new Direct.DxError('lan');
    return { ip, port };
  },
  async _dxFree(dir, name, isFile) {
    const ext = isFile ? path.extname(name) : '', stem = ext ? name.slice(0, -ext.length) : name;
    let n = 1, cand = name;
    while (await fs.promises.access(path.join(dir, cand)).then(() => true, () => false)) cand = stem + ' (' + (++n) + ')' + ext;
    return cand;
  },

  // Terima tawaran: ambil daftar berkas, buat struktur folder di <dir>/..., lalu mulai mengunduh. opts.dir = folder tujuan (bawaan: _directDir()).
  async directAccept(id, opts = {}) {
    const s = this._dxIn.get(String(id));
    if (!s || s.state !== 'offered') throw ek('e.dx.offerGone', null, 'Tawaran tidak ditemukan', 'gone');
    const fail = (e) => { s.state = 'error'; s.code = e.code || 'net'; s.err = e.message; this._dxSaveIn(s); this.emit('update'); throw e; };
    s.state = 'listing'; delete s.err; delete s.code; this.emit('update');
    try {
      const base = path.resolve(opts.dir || this._directDir());
      await fs.promises.mkdir(base, { recursive: true });
      const files = [];
      for (let from = 0, guard = 0; from !== null && guard < 100000; guard++) {
        const pr = this._dxPeer(s);
        const r = await this._request(pr, { t: 'dx_list', id: s.id, from }, 10000);
        if (!r || r.t !== 'dx_list') throw new Direct.DxError('net');
        if (!r.ok) throw new Direct.DxError(['gone', 'denied', 'lan'].includes(r.err) ? r.err : 'proto');
        if (r.from !== from || !Array.isArray(r.files) || (r.next !== null && !(Number.isSafeInteger(r.next) && r.next > from))) throw new Direct.DxError('proto');
        for (const f of r.files) {
          if (!f || typeof f.p !== 'string' || !Number.isSafeInteger(f.s) || f.s < 0 || !Number.isSafeInteger(f.m) || f.m < 0) throw new Direct.DxError('proto');
          files.push(f.d ? { p: f.p, s: 0, m: 0, d: 1 } : { p: f.p, s: f.s, m: f.m });
        }
        if (files.length > DX_COUNT_MAX) throw new Direct.DxError('proto');
        from = r.next;
      }
      if (!files.length) throw new Direct.DxError('proto');
      const rels = Direct.planRel(files);
      if (rels.some((x) => x === null)) throw new Direct.DxError('unsafe');
      // nama teratas yang sudah ada di folder tujuan diberi akhiran " (n)" (sekali, sekarang; resume memakai hasil yang tersimpan)
      const tops = new Map();
      rels.forEach((r, i) => { const t = r.split('/')[0]; if (!tops.has(t)) tops.set(t, !r.includes('/') && !files[i].d); });
      const ren = new Map();
      for (const [t, isFile] of tops) ren.set(t, await this._dxFree(base, t, isFile));
      files.forEach((f, i) => { const k = rels[i].indexOf('/'), t = k < 0 ? rels[i] : rels[i].slice(0, k); f.r = ren.get(t) + (k < 0 ? '' : rels[i].slice(k)); });
      const total = files.reduce((a, f) => a + f.s, 0);
      if (fs.promises.statfs) { // pra-periksa ruang disk bila API-nya ada (Node 18.15+)
        const st = await fs.promises.statfs(base).catch(() => null);
        if (st && st.bavail * st.bsize < total) throw new Direct.DxError('disk');
      }
      for (const f of files) { // buat folder (termasuk folder kosong) di dalam root
        const full = Direct.under(base, f.r);
        if (!full) throw new Direct.DxError('unsafe');
        await fs.promises.mkdir(f.d ? full : path.dirname(full), { recursive: true });
      }
      s.dir = base; s.size = total; s.count = files.length; s.done = 0; s.failed = [];
      this._dxFl.set(s.id, files);
      this._dxSaveIn(s, files);
    } catch (e) { fail(e instanceof Direct.DxError ? e : Object.assign(new Error(e.message), { code: 'io' })); }
    this._dxRunStart(s);
    return this._dxSumIn(s);
  },
  async directDecline(id) {
    const s = this._dxIn.get(String(id));
    if (!s || s.state !== 'offered') return false;
    this._dxDropIn(s.id);
    this._request({ ip: s.ip, port: s.port }, { t: 'dx_cancel', id: s.id, why: 'declined' }, 3000);
    this.emit('update');
    return true;
  },
  async directPause(id) {
    const s = this._dxIn.get(String(id)), run = s && this._dxRun.get(s.id);
    if (!run) return false;
    run.stop = 'paused'; run.ac.abort();
    await run.p;
    return true;
  },
  directResume(id) {
    const s = this._dxIn.get(String(id));
    if (!s || !(s.state === 'paused' || s.state === 'error') || !s.dir) return false;
    if (s.state === 'error' && s.code === 'gone') return false; // pengirim sudah membatalkan: tidak ada yang bisa dilanjutkan
    this._dxRunStart(s);
    return true;
  },
  // Batalkan penerimaan: hentikan, buang berkas setengah jadi (.archne-part; yang sudah lengkap dibiarkan), beri tahu pengirim, hapus dari daftar.
  async directCancel(id) {
    const s = this._dxIn.get(String(id));
    if (!s) return false;
    const run = this._dxRun.get(s.id), was = s.state; // status SEBELUM dihentikan: loop unduhan mengubahnya jadi 'cancelled'
    if (run) { run.stop = 'cancelled'; run.ac.abort(); await run.p; }
    if (was !== 'done') await this._dxRmParts(s);
    if (was !== 'done' && was !== 'cancelled') this._request({ ip: s.ip, port: s.port }, { t: 'dx_cancel', id: s.id, why: 'cancelled' }, 3000);
    this._dxDropIn(s.id);
    this.emit('update');
    return true;
  },
  directRemove(id) { // hapus catatan sesi yang sudah selesai/gagal dari daftar (berkas hasil tidak disentuh)
    const s = this._dxIn.get(String(id)) || this._dxOut.get(String(id));
    if (!s || ['offered', 'listing', 'running', 'waiting'].includes(s.state) || (s.files && ['offered', 'active'].includes(s.state))) return false;
    if (this._dxIn.has(s.id)) this._dxDropIn(s.id); else this._dxDropOut(s.id);
    this.emit('update');
    return true;
  },

  // ---- unduh ----
  _dxRunStart(s) {
    if (this._dxRun.has(s.id)) return;
    const run = { ac: new AbortController(), live: new Map(), base: 0, filesDone: 0, stop: null, last: Date.now(), retry: 0 };
    this._dxRun.set(s.id, run);
    s.state = 'running'; delete s.err; delete s.code;
    this._dxSaveIn(s); this.emit('update'); this._dxPulseOn();
    run.p = this._dxWork(s, run).catch((e) => { s.state = 'error'; s.code = (e && e.code) || 'io'; s.err = (e && e.message) || String(e); })
      .then(() => {
        this._dxRun.delete(s.id);
        s.done = Math.min(s.size, run.base + [...run.live.values()].reduce((a, b) => a + b, 0));
        this._dxSaveIn(s); this.emit('update'); this._dxPulse(true);
      });
    return run.p;
  },
  async _dxWork(s, run) {
    const files = this._dxFiles(s), sig = run.ac.signal, queue = [];
    for (let i = 0; i < files.length; i++) { // apa yang sudah selesai? (berkas final bersize benar)
      const f = files[i];
      if (f.d) continue;
      const full = Direct.under(s.dir, f.r);
      if (!full) { s.failed.push({ p: f.p, code: 'unsafe' }); continue; }
      const st = await fs.promises.stat(full).catch(() => null);
      if (st && st.isFile() && st.size === f.s) { run.base += f.s; run.filesDone++; continue; }
      if (f.s === 0) { await fs.promises.writeFile(full, '').catch(() => {}); run.filesDone++; continue; }
      queue.push(i);
    }
    s.failed = []; // dihitung ulang tiap putaran jalan
    const fatal = (e) => { if (!run.stop) { run.stop = 'error'; s.state = 'error'; s.code = e.code || 'io'; s.err = e.message; run.ac.abort(); } };
    const worker = async () => {
      while (queue.length && !sig.aborted) {
        const i = queue.shift(), f = files[i], full = Direct.under(s.dir, f.r), part = full + Direct.PART;
        try {
          await Direct.download(this._dxPeer(s), { id: s.id, i, hi: this.hello() }, part, f.s, {
            signal: sig, dial: (p) => this._dial(p),
            onBytes: (n) => { run.live.set(i, n); run.last = Date.now(); run.retry = 0; if (s.state === 'waiting') { s.state = 'running'; this.emit('update'); } },
          });
          await fs.promises.rename(part, full);
          if (f.m > 0) await fs.promises.utimes(full, f.m / 1000, f.m / 1000).catch(() => {});
          this.emit('direct_file', { id: s.id, path: full, rel: f.r }); // satu berkas lengkap (cangkang Android menyalinnya ke Download/file_transfer)
          run.live.delete(i); run.base += f.s; run.filesDone++;
        } catch (e) {
          if (sig.aborted) return;
          const code = e && e.code;
          if (Direct.canRetry(e)) { // sambung ulang otomatis; menyerah (jeda) bila tak ada kemajuan 3 menit
            queue.unshift(i); run.retry++;
            if (s.state === 'running') { s.state = 'waiting'; this.emit('update'); }
            if (Date.now() - run.last > DX_STALL_MS) { run.stop = 'paused'; s.code = 'stall'; s.err = Direct.TEXT.net; run.ac.abort(); return; }
            await sleep(Math.min(5000, 400 * run.retry), sig);
            continue;
          }
          if (code === 'changed' || code === 'bad' || code === 'range') { s.failed.push({ p: f.p, code }); run.live.delete(i); await fs.promises.rm(part, { force: true }).catch(() => {}); continue; } // satu berkas gagal, sisanya jalan terus
          fatal(e instanceof Direct.DxError ? e : Object.assign(new Error((e && e.message) || 'io'), { code: 'io' }));
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.directConns || DX_CONNS, queue.length) }, worker));
    if (run.stop === 'paused' || run.stop === 'cancelled') { if (run.stop === 'paused' && s.code !== 'stall') delete s.code; s.state = run.stop; return; }
    if (run.stop === 'error' || s.state === 'error') return;
    s.state = 'done'; s.done = s.size; s.end = Date.now();
    try { this._request(this._dxPeer(s), { t: 'dx_done', id: s.id }, 3000); } catch {} // kabari pengirim: sesinya selesai
    this._dxFl.delete(s.id);
  },

  // ---- ringkasan untuk UI + denyut progres ----
  _dxSumIn(s) {
    const run = this._dxRun.get(s.id);
    const done = run ? Math.min(s.size, run.base + [...run.live.values()].reduce((a, b) => a + b, 0)) : s.done || 0;
    return { id: s.id, from: s.from, fromName: s.fromName, name: s.name, kind: s.kind, state: s.state, count: s.count, total: s.size, done, speed: s._v || 0, filesDone: run ? run.filesDone : undefined, failed: (s.failed || []).length, err: s.err, code: s.code, dir: s.dir, ts: s.ts };
  },
  directState() {
    return { dir: this._directDir(), shown: this.opts.directShown || undefined, in: [...this._dxIn.values()].map((s) => this._dxSumIn(s)).sort((a, b) => b.ts - a.ts), out: [...this._dxOut.values()].map((s) => this._dxSumOut(s)).sort((a, b) => b.ts - a.ts) };
  },
  // Denyut 400 ms selama ada transfer: hitung kecepatan (rata-rata bergerak) dan kirim event 'direct' { id, dir, state, done, total, speed } ke UI.
  _dxPulseOn() { if (!this._dxTimer && !this.stopped) { this._dxTimer = setInterval(() => this._dxPulse(), 400); if (this._dxTimer.unref) this._dxTimer.unref(); } },
  _dxPulse(force) {
    const now = Date.now();
    let busy = false;
    for (const s of this._dxIn.values()) {
      if (!this._dxRun.has(s.id) && !force) continue;
      const sum = this._dxSumIn(s);
      const r = s._r || (s._r = { t: now, b: sum.done, v: 0 });
      if (now > r.t) { const inst = ((sum.done - r.b) * 1000) / (now - r.t); r.v = r.v ? r.v * 0.6 + inst * 0.4 : inst; r.t = now; r.b = sum.done; }
      s._v = this._dxRun.has(s.id) ? r.v : 0; sum.speed = s._v;
      if (this._dxRun.has(s.id)) busy = true;
      this.emit('direct', { id: s.id, dir: 'in', state: sum.state, done: sum.done, total: sum.total, speed: sum.speed });
    }
    for (const s of this._dxOut.values()) {
      const sum = this._dxSumOut(s);
      let act = false; for (const u of this._dxUp.values()) if (u.id === s.id) act = true;
      if (!act && !force) continue;
      busy = busy || act;
      const r = s._r || (s._r = { t: now, b: sum.sent, v: 0 });
      if (now > r.t) { const inst = ((sum.sent - r.b) * 1000) / (now - r.t); r.v = r.v ? r.v * 0.6 + inst * 0.4 : inst; r.t = now; r.b = sum.sent; }
      this.emit('direct', { id: s.id, dir: 'out', state: sum.state, done: sum.sent, total: sum.total, speed: act ? r.v : 0 });
    }
    if (!busy && this._dxTimer && !force) { clearInterval(this._dxTimer); this._dxTimer = null; }
  },
};
