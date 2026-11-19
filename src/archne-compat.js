'use strict';
// Kompatibilitas Node 12. Cangkang Android (nodejs-mobile-cordova 0.4.3) membawa Node 12.19, sedangkan kode inti memakai API Node 15+.
// Semua tambalan hanya aktif bila API aslinya TIDAK ada, jadi di Electron/Node baru modul ini tidak mengubah apa pun.
const crypto = require('crypto');
const stream = require('stream');

// --- AbortController / AbortSignal (global baru di Node 15) -------------------------------------------------------------
if (typeof globalThis.AbortController === 'undefined') {
  class AbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this._l = new Set(); this.onabort = null; }
    addEventListener(type, fn, opts) {
      if (type !== 'abort' || typeof fn !== 'function') return;
      if (opts && opts.once) {
        const w = (e) => { this._l.delete(w); fn.call(this, e); };
        w._orig = fn;
        this._l.add(w);
      } else this._l.add(fn);
    }
    removeEventListener(type, fn) {
      if (type !== 'abort') return;
      for (const l of [...this._l]) if (l === fn || l._orig === fn) this._l.delete(l);
    }
    _fire() {
      const e = { type: 'abort', target: this };
      if (typeof this.onabort === 'function') { try { this.onabort(e); } catch {} }
      for (const l of [...this._l]) { try { l.call(this, e); } catch {} }
    }
  }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort(reason) {
      const s = this.signal;
      if (s.aborted) return;
      s.aborted = true;
      s.reason = reason;
      s._fire();
    }
  }
  globalThis.AbortController = AbortController;
  globalThis.AbortSignal = AbortSignal;
}

// --- crypto.hkdfSync (Node 15+) -----------------------------------------------------------------------------------------
if (typeof crypto.hkdfSync !== 'function') {
  crypto.hkdfSync = function hkdfSync(digest, ikm, salt, info, keylen) {
    const hlen = crypto.createHash(digest).digest().length;
    if (!Number.isInteger(keylen) || keylen < 0 || keylen > 255 * hlen) throw new RangeError('keylen tidak valid');
    const toBuf = (x) => (Buffer.isBuffer(x) ? x : ArrayBuffer.isView(x) ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : x instanceof ArrayBuffer ? Buffer.from(x) : Buffer.from(String(x)));
    const key = toBuf(ikm), sl = toBuf(salt), inf = toBuf(info);
    const prk = crypto.createHmac(digest, sl.length ? sl : Buffer.alloc(hlen)).update(key).digest();
    const out = Buffer.alloc(keylen);
    let t = Buffer.alloc(0), pos = 0;
    for (let i = 1; pos < keylen; i++) {
      t = crypto.createHmac(digest, prk).update(t).update(inf).update(Buffer.from([i])).digest();
      t.copy(out, pos, 0, Math.min(t.length, keylen - pos));
      pos += t.length;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.length); // seperti aslinya: ArrayBuffer
  };
}

// --- crypto.diffieHellman untuk X25519 (Node 13.9+). RFC 7748, BigInt (tangga Montgomery) --------------------------------
if (typeof crypto.diffieHellman !== 'function') {
  const P = (1n << 255n) - 19n, A24 = 121665n;
  const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
  const inv = (a) => { let r = 1n, b = mod(a), e = P - 2n; while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; };
  const leToBig = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
  const bigToLe = (n) => { const b = Buffer.alloc(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };
  const x25519 = (kBytes, uBytes) => {
    const k = Buffer.from(kBytes); k[0] &= 248; k[31] &= 127; k[31] |= 64;
    const ub = Buffer.from(uBytes); ub[31] &= 127;
    const x1 = mod(leToBig(ub)), kk = leToBig(k);
    let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
    for (let t = 254n; t >= 0n; t--) {
      const kt = (kk >> t) & 1n;
      swap ^= kt;
      if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
      swap = kt;
      const a = mod(x2 + z2), aa = mod(a * a), b = mod(x2 - z2), bb = mod(b * b), e = mod(aa - bb);
      const c = mod(x3 + z3), d = mod(x3 - z3), da = mod(d * a), cb = mod(c * b);
      x3 = mod((da + cb) ** 2n); z3 = mod(x1 * mod((da - cb) ** 2n));
      x2 = mod(aa * bb); z2 = mod(e * mod(aa + A24 * e));
    }
    if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    return bigToLe(mod(x2 * inv(z2)));
  };
  crypto.diffieHellman = function diffieHellman(o) {
    const priv = o.privateKey.export({ format: 'der', type: 'pkcs8' }); // ...04 20 <32 byte kunci>
    const pub = o.publicKey.export({ format: 'der', type: 'spki' });    // ...03 21 00 <32 byte kunci>
    const secret = x25519(priv.subarray(priv.length - 32), pub.subarray(pub.length - 32));
    if (secret.every((v) => v === 0)) throw new Error('rahasia bersama nol (titik berorde kecil)');
    return secret;
  };
}

// --- fs.promises.rm / fs.rmSync (Node 14.14+) --------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const rmOpts = (o) => ({ recursive: !!(o && o.recursive), force: !!(o && o.force) });
async function rmCompat(p, o) {
  const { recursive, force } = rmOpts(o);
  let st;
  try { st = await fs.promises.lstat(p); } catch (e) { if (force && e.code === 'ENOENT') return; throw e; }
  if (st.isDirectory()) {
    if (!recursive) { const e = new Error('EISDIR: ' + p + ' adalah folder (butuh recursive)'); e.code = 'ERR_FS_EISDIR'; throw e; }
    for (const n of await fs.promises.readdir(p)) await rmCompat(path.join(p, n), o);
    await fs.promises.rmdir(p);
  } else await fs.promises.unlink(p);
}
function rmSyncCompat(p, o) {
  const { recursive, force } = rmOpts(o);
  let st;
  try { st = fs.lstatSync(p); } catch (e) { if (force && e.code === 'ENOENT') return; throw e; }
  if (st.isDirectory()) {
    if (!recursive) { const e = new Error('EISDIR: ' + p + ' adalah folder (butuh recursive)'); e.code = 'ERR_FS_EISDIR'; throw e; }
    for (const n of fs.readdirSync(p)) rmSyncCompat(path.join(p, n), o);
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}
if (typeof fs.promises.rm !== 'function') fs.promises.rm = rmCompat;
if (typeof fs.rmSync !== 'function') fs.rmSync = rmSyncCompat;

// --- pipeline berbasis promise (stream/promises, Node 15+), termasuk opsi { signal } dan tahap akhir berupa fungsi async -----
let nativePipeline = null;
try { nativePipeline = require('stream/promises').pipeline; } catch {}

function pipelineCompat(...args) {
  let opts = {};
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && typeof last.pipe !== 'function' && typeof last.on !== 'function' && !last[Symbol.asyncIterator]) opts = args.pop();
  let tail = null;
  if (typeof args[args.length - 1] === 'function') tail = args.pop();
  const streams = args.slice();
  let sink = null;
  if (tail) { sink = new stream.PassThrough(); streams.push(sink); }
  const signal = opts.signal;
  const destroyAll = (err) => { for (const s of streams) { try { s.destroy(err); } catch {} } };
  const abortErr = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; e.code = 'ABORT_ERR'; return e; };
  const onAbort = () => destroyAll(abortErr());
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }

  let pStream;
  if (opts.end === false && streams.length >= 2) {
    // { end: false }: tahap terakhir (mis. soket) tidak boleh di-end setelah data habis. stream.pipeline Node 12 tidak punya opsi ini,
    // jadi bagian depan dirangkai lewat pipeline ke PassThrough lalu di-pipe manual ke tujuan dengan { end: false }.
    const dest = streams[streams.length - 1];
    const inner = streams.slice(0, -1);
    const mid = new stream.PassThrough();
    pStream = new Promise((res, rej) => {
      let finished = false;
      const cleanup = () => { dest.removeListener('error', onDestErr); dest.removeListener('close', onDestClose); };
      const fail = (e) => { if (finished) return; finished = true; cleanup(); mid.unpipe(dest); destroyAll(e); mid.destroy(e); rej(e); };
      const onDestErr = (e) => fail(e);
      const onDestClose = () => { const e = new Error('Premature close'); e.code = 'ERR_STREAM_PREMATURE_CLOSE'; fail(e); };
      dest.once('error', onDestErr); dest.once('close', onDestClose);
      stream.pipeline(...inner, mid, (e) => { if (e) fail(e); });
      mid.once('end', () => { if (finished) return; finished = true; cleanup(); res(); });
      mid.pipe(dest, { end: false });
    });
  } else {
    pStream = new Promise((res, rej) => stream.pipeline(...streams, (e) => (e ? rej(e) : res())));
  }
  const pTail = tail ? Promise.resolve().then(() => tail(sink)) : Promise.resolve();
  pStream.catch(() => {}); pTail.catch(() => {});
  return Promise.all([pStream, pTail]).then(
    () => { if (signal) signal.removeEventListener('abort', onAbort); },
    (e) => { if (signal) signal.removeEventListener('abort', onAbort); destroyAll(e); throw (signal && signal.aborted && !(e && e.name === 'AbortError') ? abortErr() : e); },
  );
}

module.exports = { pipeline: nativePipeline || pipelineCompat };
