'use strict';
// src/archne-websri.js — Verifikasi SRI untuk "Jadikan offline" (0.34.0 Fase O2d-2). MURNI: tanpa jaringan, tanpa berkas, tanpa IPC. Hanya menguraikan atribut `integrity` dan membandingkannya dengan byte yang sudah diambil.
// API:
//   parse(integrity) -> { ok:true, status:'none'|'ok'|'unsupported'|'invalid', alg, digests:[Buffer], valid, unsupported, malformed } | { ok:false, code:'bad'|'long' }
//     integrity: string atribut (token dipisah spasi: 'sha384-<base64>[?opsi]'). undefined/null/'' atau hanya spasi => status 'none' (tidak ada metadata).
//     status 'ok'          = ada >=1 token sah; alg = algoritma TERKUAT di antara token sah, digests = digest (Buffer) token sah ber-alg itu.
//     status 'unsupported' = ada token tetapi semuanya algoritma yang tidak dikenal (md5, sha1, ...); 'invalid' = tidak ada token sah dan ada token yang cacat (alg dikenal, digest salah bentuk).
//   verify(integrity, body, opts?) -> { ok:true, status:'none'|'unsupported'|'invalid'|'match'|'mismatch', alg?, sri? } | { ok:false, code:'bad'|'long'|'body' }
//     body: Buffer / Uint8Array. opts.sha256: hex sha256 yang sudah dihitung pengambil (O2b), dipakai ulang agar tidak menghitung dua kali; HANYA dipercaya bila 64 hex.
//     'match' hanya bila digest body sama dengan SALAH SATU token berAlgoritma terkuat. Token yang lebih lemah tidak pernah menyelamatkan (anti-downgrade): 'sha512-salah sha256-benar' => 'mismatch'.
//     Pemanggil menentukan kebijakan: mismatch = tolak aset; none/unsupported/invalid = terima tapi catat statusnya di manifest (O2d-3).
//   make(body, alg?) -> 'sha384-<base64>' (alg bawaan sha384), untuk manifest; { ok:false } tidak ada: salah masukan melempar TypeError.
//   Sikap: nama algoritma tidak membedakan huruf besar/kecil (sha256, sha384, sha512). Digest boleh base64 baku atau base64url, dengan atau tanpa '=' tetapi harus persis sepanjang byte-nya (32/48/64) dan tanpa karakter lain,
//   lalu DIBANDINGKAN SEBAGAI BYTE (bukan string), jadi variasi penulisan yang sama tidak menghasilkan hasil berbeda. '?opsi' pada token dibuang. Batas: 4096 karakter, 32 token; token berlebih diabaikan (tidak menggagalkan).
// Tanda "// G:nama" menandai penjaga yang dilumpuhkan tes kontrol kepekaan (test/websri.js): tiap penjaga satu baris.
const crypto = require('crypto');

const LIM = { len: 4096, tokens: 32 };
const ALGS = { sha256: 32, sha384: 48, sha512: 64 }; // nama -> panjang digest (byte)
const RANK = { sha256: 1, sha384: 2, sha512: 3 };
const bad = (code) => ({ ok: false, code });

function decode(b64, want) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return null;
  const std = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const buf = Buffer.from(std, 'base64');
  if (buf.length !== want) return null; // G:bytes
  if (buf.toString('base64').replace(/=+$/, '') !== std) return null; // G:canon — bit sisa harus nol (satu digest = satu penulisan kanonik)
  return buf;
}

function parse(integrity) {
  if (integrity === undefined || integrity === null) return { ok: true, status: 'none', alg: null, digests: [], valid: 0, unsupported: 0, malformed: 0 };
  if (typeof integrity !== 'string') return bad('bad');
  if (integrity.length > LIM.len) return bad('long'); // G:len
  const toks = integrity.split(/[ \t\r\n\f]+/).filter(Boolean).slice(0, LIM.tokens); // G:tokens
  if (!toks.length) return { ok: true, status: 'none', alg: null, digests: [], valid: 0, unsupported: 0, malformed: 0 };
  const good = [];
  let unsupported = 0, malformed = 0;
  for (const t of toks) {
    const body = t.split('?')[0]; // G:opts
    const i = body.indexOf('-');
    const alg = (i > 0 ? body.slice(0, i) : body).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ALGS, alg)) { unsupported++; continue; } // G:alg
    const d = i > 0 ? decode(body.slice(i + 1), ALGS[alg]) : null;
    if (!d) { malformed++; continue; }
    good.push({ alg, d });
  }
  if (!good.length) return { ok: true, status: malformed ? 'invalid' : 'unsupported', alg: null, digests: [], valid: 0, unsupported, malformed };
  let top = good[0].alg;
  for (const g of good) if (RANK[g.alg] > RANK[top]) top = g.alg; // G:strong
  return { ok: true, status: 'ok', alg: top, digests: good.filter((g) => g.alg === top).map((g) => g.d), valid: good.length, unsupported, malformed };
}

function toBuf(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return null;
}

function verify(integrity, body, opts) {
  const p = parse(integrity);
  if (!p.ok) return p;
  const b = toBuf(body);
  if (!b) return bad('body'); // G:body
  if (p.status !== 'ok') return { ok: true, status: p.status };
  let got;
  const pre = opts && typeof opts.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(opts.sha256) ? Buffer.from(opts.sha256, 'hex') : null;
  if (p.alg === 'sha256' && pre) got = pre;
  else got = crypto.createHash(p.alg).update(b).digest();
  const hit = p.digests.some((d) => d.length === got.length && crypto.timingSafeEqual(d, got)); // G:cmp
  return hit ? { ok: true, status: 'match', alg: p.alg, sri: p.alg + '-' + got.toString('base64') } : { ok: true, status: 'mismatch', alg: p.alg };
}

function make(body, alg) {
  const a = alg === undefined ? 'sha384' : alg;
  if (!Object.prototype.hasOwnProperty.call(ALGS, a)) throw new TypeError('alg');
  const b = toBuf(body);
  if (!b) throw new TypeError('body');
  return a + '-' + crypto.createHash(a).update(b).digest('base64');
}

module.exports = { parse, verify, make, LIM };
