'use strict';
// src/archne-webrun.js — Pelari banyak URL untuk "Jadikan offline" (0.34.0 Fase O2c; konkurensi dan dropBody: O2d-5). Tanpa menulis berkas, tanpa IPC: memanggil fetchOne (O2b) untuk tiap butir dan mengembalikan byte ke pemanggil (penulisnya: archne-webstage lewat archne-webjob).
// API: runAll(list, opts, deps) -> Promise (TIDAK PERNAH menolak/melempar) ->
//   { ok:true, total, okN, failN, bytes, aborted, limits:[kode], results:[...] } | { ok:false, code:'bad' } (list bukan larik)
//   list  = [{ url, kind, cls? }]: bentuk butir pemindai O1 (cls selain 'local' ditolak TANPA menyentuh jaringan). Hanya 500 butir pertama yang diproses; sisanya dibuang dan limits memuat 'urls'.
//   results SEJAJAR dengan list (indeks sama): { i, url, kind } + hasil fetchOne ({ ok:true, body, bytes, type, hops, sha256, url akhir => finalUrl } | { ok:false, code, status? }).
//   code tambahan di sini: bad (butir cacat) | cls (bukan 'local') | dup (URL + jenis sama dengan butir sebelumnya; of = indeks pertama) | budget (jumlah byte tersimpan melewati batas) | abort | timeout (tenggat seluruh pekerjaan).
//   opts: { signal (AbortSignal: Batal), ms (tenggat seluruh pekerjaan, maks 3 menit), onProgress({ done, total, okN, failN, bytes, url }), onResult(entry), dropBody (true = badan dibuang dari results SETELAH onResult dipanggil, supaya byte tidak menumpuk di memori; onResult wajib memakai/menyalin entry.body saat itu juga) } dan diteruskan ke fetchOne: { ms, idleMs } serta HANYA UNTUK TES { allowHttp, allowPrivate, ports, ca }.
//   deps (tes): diteruskan ke fetchOne, ditambah { fetchOne } untuk mengganti pengambil.
// Sikap: paling banyak 3 unduhan sekaligus dan 2 per host (host dari URL awal). Tiap unduhan memakai penjaga lengkap O2a/O2b. Satu butir gagal tidak menghentikan yang lain.
//   Anggaran memori: byte badan yang disimpan di results dibatasi 48 MB; butir yang akan melewatinya menjadi 'budget' (badannya dibuang), dan butir yang belum mulai ikut 'budget' tanpa jaringan. Yang sedang berjalan paling banyak 3 x 8 MB.
//   Batal / tenggat: butir yang belum mulai TIDAK PERNAH memulai permintaan; yang berjalan dibatalkan lewat AbortSignal. Pemanggil mendapat hasil sebagian lengkap (aborted:true), bukan galat.
//   Panggilan balik (onProgress/onResult) yang melempar atau menolak diabaikan. Tidak ada butir yang diselesaikan dua kali.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webrun.js): tiap penjaga satu baris.
const F = require('./archne-webfetch');

const LIM = { urls: 500, conc: 3, perHost: 2, bytes: 48 * 1024 * 1024, ms: 180000 };
const PASS = ['ms', 'idleMs', 'allowHttp', 'allowPrivate', 'ports', 'ca']; // opsi yang diteruskan ke fetchOne

function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }
const safe = (fn, arg) => { try { const r = fn(arg); if (r && typeof r.then === 'function') r.then(null, () => {}); } catch { /* panggilan balik pemanggil tidak boleh merusak pekerjaan */ } };

function runAll(list, opts, deps) {
  opts = opts && typeof opts === 'object' ? opts : {};
  deps = deps && typeof deps === 'object' ? deps : {};
  if (!Array.isArray(list)) return Promise.resolve({ ok: false, code: 'bad' });
  return new Promise((resolve) => {
    let finished = false;
    const limits = [];
    try {
      const fetchOne = typeof deps.fetchOne === 'function' ? deps.fetchOne : F.fetchOne;
      const fopts = {};
      for (const k of PASS) if (opts[k] !== undefined) fopts[k] = opts[k];
      let items = list;
      if (items.length > LIM.urls) { items = items.slice(0, LIM.urls); limits.push('urls'); } // G:cap
      const total = items.length;
      const results = new Array(total).fill(null);
      const ac = new AbortController();
      const sig = opts.signal;
      let reason = null, running = 0, done = 0, okN = 0, failN = 0, bytes = 0, over = false, grace = null;
      const state = new Array(total).fill(0); // 0 menunggu, 1 berjalan, 2 selesai
      const perHost = new Map();
      const onAbort = () => stop('abort');
      const ms = Math.min(opts.ms > 0 ? opts.ms : LIM.ms, LIM.ms);
      const tDead = setTimeout(() => stop('timeout'), ms); // G:deadline

      function stop(why) {
        if (reason || finished) return;
        reason = why;
        try { ac.abort(); } catch { /* */ }
        grace = setTimeout(() => { for (let i = 0; i < total; i++) if (state[i] === 1) settle(i, { ok: false, code: reason }); end(); }, 3000); // pengambil yang tidak menghormati AbortSignal tidak boleh menggantung pekerjaan
        pump();
      }
      function end() {
        if (finished) return;
        finished = true;
        clearTimeout(tDead); clearTimeout(grace);
        if (sig && sig.removeEventListener) { try { sig.removeEventListener('abort', onAbort); } catch { /* */ } }
        resolve({ ok: true, total, okN, failN, bytes, aborted: !!reason, limits, results });
      }
      function settle(i, r) {
        if (state[i] === 2) return; // tidak pernah diselesaikan dua kali
        state[i] = 2;
        const it = items[i], rest = Object.assign({}, r);
        delete rest.url;
        const e = Object.assign({ i, url: it && typeof it.url === 'string' ? it.url : '', kind: it && typeof it.kind === 'string' ? it.kind : '' }, rest);
        if (r.ok) e.finalUrl = r.url;
        results[i] = e;
        done++;
        if (e.ok) okN++; else failN++;
        if (typeof opts.onResult === 'function') safe(opts.onResult, e);
        if (opts.dropBody === true && e.body !== undefined) delete e.body; // G:drop
        if (typeof opts.onProgress === 'function') safe(opts.onProgress, { done, total, okN, failN, bytes, url: e.url });
      }
      function launch(i, host) {
        state[i] = 1; running++;
        perHost.set(host, (perHost.get(host) || 0) + 1);
        const it = items[i];
        let p;
        try { p = Promise.resolve(fetchOne(it.url, it.kind, Object.assign({}, fopts, { signal: ac.signal }), deps)); } catch { p = Promise.resolve({ ok: false, code: 'net' }); }
        p.then((r) => r, () => ({ ok: false, code: 'net' })).then((r) => {
          running--;
          const left = (perHost.get(host) || 1) - 1;
          if (left > 0) perHost.set(host, left); else perHost.delete(host);
          if (finished || state[i] === 2) return;
          if (!r || typeof r !== 'object') r = { ok: false, code: 'net' };
          if (r.ok) {
            const b = r.body && typeof r.body.length === 'number' ? r.body.length : 0;
            if (bytes + b > LIM.bytes) { over = true; if (!limits.includes('bytes')) limits.push('bytes'); r = { ok: false, code: 'budget' }; } // G:budget
            else bytes += b;
          } else if (r.code === 'abort' && reason === 'timeout') r = { ok: false, code: 'timeout' };
          settle(i, r);
          pump();
        });
      }
      function pump() {
        if (finished) return;
        if (reason || over) { // butir yang belum mulai tidak boleh memulai permintaan
          for (let i = 0; i < total; i++) if (state[i] === 0) settle(i, { ok: false, code: reason || 'budget' }); // G:halt
          if (!running) end();
          return;
        }
        for (let i = 0; i < total && running < LIM.conc; i++) { // G:conc
          if (state[i] !== 0) continue;
          const host = hostOf(items[i].url);
          if ((perHost.get(host) || 0) >= LIM.perHost) continue; // G:perhost
          launch(i, host);
        }
        if (!running && done >= total) end();
      }

      // pra-penyaringan: butir cacat / bukan 'local' / kembar diselesaikan SEKARANG, tanpa jaringan (yang pertama menang, urutan list)
      const firstOf = new Map();
      for (let i = 0; i < total; i++) {
        const it = items[i];
        if (!it || typeof it !== 'object' || typeof it.url !== 'string' || typeof it.kind !== 'string') { settle(i, { ok: false, code: 'bad' }); continue; }
        if (it.cls !== undefined && it.cls !== 'local') { settle(i, { ok: false, code: 'cls' }); continue; } // G:cls
        const key = it.kind + ' ' + it.url;
        if (firstOf.has(key)) { settle(i, { ok: false, code: 'dup', of: firstOf.get(key) }); continue; } // G:dup
        firstOf.set(key, i);
      }

      if (sig && sig.aborted) reason = 'abort';
      else if (sig && sig.addEventListener) sig.addEventListener('abort', onAbort, { once: true });
      if (reason) { try { ac.abort(); } catch { /* */ } }
      if (!total) return end();
      pump();
    } catch {
      if (!finished) { finished = true; resolve({ ok: true, total: 0, okN: 0, failN: 0, bytes: 0, aborted: false, limits: ['internal'], results: [] }); }
    }
  });
}

module.exports = { runAll, LIM };
