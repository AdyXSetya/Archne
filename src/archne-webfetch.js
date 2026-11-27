'use strict';
// src/archne-webfetch.js — Pengambil SATU URL untuk "Jadikan offline" (0.34.0 Fase O2b). Tanpa menulis berkas, tanpa IPC: hanya mengembalikan byte ke pemanggil (O2c = pelari banyak URL, O3 = penulis).
// API: fetchOne(url, kind, opts, deps) -> Promise (TIDAK PERNAH menolak/melempar) ->
//   { ok:true, url (akhir, sesudah redirect), body:Buffer, bytes, type, hops, sha256 } | { ok:false, code, status? }
//   kind: script | style | font | image (batas ukuran dan tipe dari archne-weburlguard).
//   code: dari penjaga O2a (bad insecure scheme cred port host private downgrade kind type) + redirects | status | encoding | toobig | empty | dns | tls | net | timeout | abort
//   opts: { signal (AbortSignal: Batal), ms (total, maks 20 dtk), idleMs (diam di soket, maks 8 dtk) } dan HANYA UNTUK TES: { allowHttp, allowPrivate, ports, ca }. Kode produksi tidak boleh menyetelnya.
//   deps (tes): { request(proto, options, cb), lookup(host, { all:true }, cb) }.
// Sikap: GET polos. Tanpa cookie, tanpa Authorization, tanpa Referer, tanpa Origin; hanya User-Agent, Accept, Accept-Encoding: identity. Verifikasi sertifikat TLS tidak pernah dimatikan (TLS >= 1.2).
//   DNS: nama diselesaikan lewat `lookup` MILIK permintaan itu sendiri; setiap alamat diperiksa isPublicIp dan hanya hasil yang sudah diperiksa itu yang dipakai menyambung (tanpa resolve kedua => tanpa DNS rebinding). Satu saja alamat privat = ditolak semua.
//   Redirect: maks 3, tiap lompatan lewat redirectTarget (skema, kredensial, port, host privat, turun ke http) SEBELUM permintaan berikutnya dibuat. Hanya 200 diterima. Content-Encoding selain identity ditolak (tanpa dekompresi => tanpa bom dekompresi).
//   Tipe dicek dari header sebelum badan dibaca; ukuran dicek dari Content-Length dan dihitung terus saat mengalir (berhenti dan putus di batas). Badan terpotong = galat. Badan kosong ditolak.
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/webfetch.js).
const nodeHttps = require('https'), nodeHttp = require('http'), nodeDns = require('dns'), crypto = require('crypto');
const G = require('./archne-weburlguard');

const LIM = { ms: 20000, idleMs: 8000, header: 16 * 1024 };
const REDIR = new Set([301, 302, 303, 307, 308]);
const UA = 'Archne-Offline/1';

const codeErr = (c) => { const e = new Error(c); e.fcode = c; return e; };
function mapErr(e) {
  if (e && e.fcode) return e.fcode;
  const c = e && e.code ? String(e.code) : '';
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NODATA|EAI_NONAME)$/.test(c)) return 'dns';
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HOSTNAME_MISMATCH|ERR_TLS/.test(c)) return 'tls';
  return 'net';
}

// lookup untuk opsi permintaan: hasilnya yang dipakai menyambung, dan sudah diperiksa.
function pinLookup(base, allowPrivate) {
  return (host, o, cb) => {
    if (typeof o === 'function') { cb = o; o = {}; }
    const all = !!(o && o.all);
    let done = false;
    const once = (...a) => { if (!done) { done = true; cb(...a); } };
    try {
      base(host, { all: true }, (err, addrs) => {
        if (err) return once(err);
        const list = Array.isArray(addrs) ? addrs.filter((a) => a && typeof a.address === 'string') : [];
        if (!list.length) return once(codeErr('dns'));
        if (!allowPrivate && list.some((a) => !G.isPublicIp(a.address))) return once(codeErr('private')); // G:pin
        const out = list.map((a) => ({ address: a.address, family: a.family === 6 || a.address.includes(':') ? 6 : 4 }));
        if (all) once(null, out); else once(null, out[0].address, out[0].family);
      });
    } catch { once(codeErr('dns')); }
  };
}

function fetchOne(raw, kind, opts, deps) {
  opts = opts && typeof opts === 'object' ? opts : {};
  deps = deps && typeof deps === 'object' ? deps : {};
  return new Promise((resolve) => {
    let settled = false, req = null, res = null, tTotal = null, hops = 0, cur = null;
    const onAbort = () => fail('abort');
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(tTotal);
      if (opts.signal && opts.signal.removeEventListener) { try { opts.signal.removeEventListener('abort', onAbort); } catch { /* */ } }
      try { if (res) res.destroy(); } catch { /* */ }
      try { if (req) req.destroy(); } catch { /* */ }
      resolve(r);
    };
    const fail = (code, extra) => finish(Object.assign({ ok: false, code }, extra));
    try {
      const limit = G.limitFor(kind);
      if (limit === null) return fail('kind');
      const gopt = { allowHttp: !!opts.allowHttp, allowPrivate: !!opts.allowPrivate, ports: Array.isArray(opts.ports) ? opts.ports : [] };
      cur = G.checkUrl(raw, gopt);
      if (!cur.ok) return fail(cur.code);
      const total = Math.min(opts.ms > 0 ? opts.ms : LIM.ms, LIM.ms), idle = Math.min(opts.idleMs > 0 ? opts.idleMs : LIM.idleMs, LIM.idleMs);
      const sig = opts.signal;
      if (sig && sig.aborted) return fail('abort');
      if (sig && sig.addEventListener) sig.addEventListener('abort', onAbort, { once: true });
      tTotal = setTimeout(() => fail('timeout'), total); // G:deadline
      const base = typeof deps.lookup === 'function' ? deps.lookup : nodeDns.lookup;
      const doReq = typeof deps.request === 'function' ? deps.request : (proto, o, cb) => (proto === 'https:' ? nodeHttps : nodeHttp).request(o, cb);

      const step = (href) => {
        const u = new URL(href);
        const o = {
          method: 'GET', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search,
          headers: { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity', connection: 'close' },
          agent: false, maxHeaderSize: LIM.header, lookup: pinLookup(base, !!opts.allowPrivate),
          timeout: idle,
        };
        if (u.protocol === 'https:') { o.minVersion = 'TLSv1.2'; if (opts.ca) o.ca = opts.ca; }
        const r = doReq(u.protocol, o, (rs) => { try { onRes(r, rs); } catch (e) { fail(mapErr(e)); } }); // callback tidak boleh melempar ke pemanggil (uncaught)
        req = r;
        r.on('error', (e) => { if (r === req) fail(mapErr(e)); });
        r.on('timeout', () => { if (r === req) fail('timeout'); });
        r.end();
      };

      const onRes = (r, rs) => {
        if (r !== req || settled) { try { rs.destroy(); } catch { /* */ } return; }
        res = rs;
        const st = rs.statusCode, h = rs.headers || {};
        if (REDIR.has(st)) {
          const loc = h.location;
          if (!loc) return fail('status', { status: st });
          if (hops >= G.LIM.redirects) return fail('redirects'); // G:hops
          hops++;
          const nx = G.redirectTarget(cur.url, loc, gopt); // G:hop
          if (!nx.ok) return fail(nx.code);
          cur = nx;
          try { rs.destroy(); } catch { /* */ }
          res = null;
          return step(nx.url);
        }
        if (st !== 200) return fail('status', { status: st }); // G:status
        const enc = String(h['content-encoding'] || '').trim().toLowerCase();
        if (enc && enc !== 'identity') return fail('encoding'); // G:enc
        const ty = G.checkType(kind, h['content-type']);
        if (!ty.ok) return fail(ty.code); // G:ct
        const cl = h['content-length'];
        if (cl !== undefined && Number(cl) > limit) return fail('toobig'); // G:cl
        const chunks = [];
        let n = 0;
        rs.on('data', (c) => { n += c.length; if (n > limit) return fail('toobig'); chunks.push(c); }); // G:size
        rs.on('error', () => fail('net'));
        rs.on('end', () => {
          if (!rs.complete) return fail('net');
          if (!n) return fail('empty'); // G:empty
          const body = Buffer.concat(chunks, n);
          finish({ ok: true, url: cur.url, body, bytes: n, type: ty.type, hops, sha256: crypto.createHash('sha256').update(body).digest('hex') });
        });
      };
      step(cur.url);
    } catch (e) { fail(mapErr(e)); }
  });
}

module.exports = { fetchOne, LIM };
