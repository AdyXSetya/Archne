'use strict';
// src/core/archne-util.js — fungsi bantu murni: spam-norm, bigramDice, verifyMsg, aead*, lineReader, fitBytes, parseAddr, localAddrs… (pindahan apa adanya, Step 1)
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { DEFAULT_TCP_PORT, KINDS, LINE_MAX, MAX_CIPHER, MAX_TEXT, REPLY_OVERHEAD, REPLY_RE, SPAM_CMP_MAX, XTAG, canon, sha } = require('./archne-constants');

const ribu = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); // pemisah ribuan gaya Indonesia, tanpa bergantung pada data ICU (Android tidak membawa locale id)
// Runtime Node di HP bisa dibuat TANPA ICU (dulu nodejs-mobile; dijaga tetap aman): \p{L} melempar "Invalid property name in character class" dan normalize() tidak mengurai aksen.
// Jalur utama memakai properti Unicode; bila mesin tidak mendukung, dipakai daftar rentang tanda baca/simbol (tanpa ICU) dan normalize dilewati.
const NON_ALNUM_FALLBACK = /[\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u00a9\u00ab-\u00b1\u00b4\u00b6-\u00b8\u00bb\u00bf\u00d7\u00f7\u2000-\u206f\u20a0-\u20cf\u2100-\u214f\u2190-\u2bff\u3000-\u303f\ufe00-\ufe0f\ufe30-\ufe6f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\ud800-\udfff]+/g;
function buildSpamNorm(useProps, useNormalize) {
  let nonAlnum = NON_ALNUM_FALLBACK;
  if (useProps) { try { nonAlnum = new RegExp('[^\\p{L}\\p{N}]+', 'gu'); } catch {} }
  let norm = (x) => x;
  if (useNormalize) { try { if ('\u00e9'.normalize('NFKD').length === 2) norm = (x) => x.normalize('NFKD'); } catch {} }
  return function spamNorm(t) {
    const raw = String(t).replace(/\s+/g, '');
    const n = norm(raw).toLowerCase().replace(nonAlnum, '').replace(/(.)\1{2,}/gu, '$1$1');
    return (n || raw).slice(0, SPAM_CMP_MAX); // pesan tanpa huruf/angka (emoji saja) dibandingkan apa adanya
  };
}
const spamNorm = buildSpamNorm(true, true);
function bigramDice(a, b) {
  if (a === b) return 1;
  const x = Array.from(a), y = Array.from(b);
  if (x.length < 2 || y.length < 2) return 0;
  const cnt = new Map();
  for (let i = 0; i < x.length - 1; i++) { const k = x[i] + x[i + 1]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let hit = 0;
  for (let i = 0; i < y.length - 1; i++) { const k = y[i] + y[i + 1], c = cnt.get(k); if (c) { hit++; cnt.set(k, c - 1); } }
  return (2 * hit) / (x.length + y.length - 2);
}
const msgId = (m) => sha(canon(m)).slice(0, 32);
const idFromPub = (pubB64) => sha(Buffer.from(pubB64, 'base64')).slice(0, 16);
function verifyMsg(m) {
  try {
    if (!m || typeof m.text !== 'string' || typeof m.to !== 'string' || m.to.length > 40) return false;
    if (!Number.isSafeInteger(m.ts) || m.ts <= 0) return false;
    if (!KINDS.includes(m.kind)) return false;
    if (m.text.length > (m.kind ? MAX_CIPHER : MAX_TEXT + (REPLY_RE.test(m.text) ? REPLY_OVERHEAD : 0))) return false; // awalan balasan tidak dihitung ke batas pengguna
    if (m.ep !== undefined && (m.kind !== 'g1' || !Number.isInteger(m.ep) || m.ep < 1 || m.ep > 1e6)) return false;
    if (m.pc !== undefined && (m.pc !== 1 || (m.kind !== 'g1' && m.kind !== 'e1'))) return false; // penanda primer hanya untuk pesan terenkripsi grup/DM
    if (typeof m.pub !== 'string' || typeof m.sig !== 'string') return false;
    if (m.from !== idFromPub(m.pub)) return false;
    if (m.id !== msgId(m)) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(m.pub, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canon(m)), key, Buffer.from(m.sig, 'base64'));
  } catch { return false; }
}
function aeadSeal(key, aad, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function aeadOpen(key, aad, b64) {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 28) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(aad); d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
// Kunci enkripsi (xpub) harus ditandatangani kunci identitas, supaya tidak bisa dipalsukan di jaringan.
function verifyHelloKeys(h, prev) {
  if (!h.pub) return { ok: true, keys: null };
  try {
    if (typeof h.pub !== 'string' || typeof h.xpub !== 'string' || typeof h.xsig !== 'string') return { ok: false };
    if (prev && prev.pub === h.pub && prev.xpub === h.xpub && prev.xsig === h.xsig) return { ok: true, keys: { pub: h.pub, xpub: h.xpub, xsig: h.xsig } };
    if (h.id !== idFromPub(h.pub)) return { ok: false };
    const key = crypto.createPublicKey({ key: Buffer.from(h.pub, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(XTAG + h.xpub), key, Buffer.from(h.xsig, 'base64'))) return { ok: false };
    crypto.createPublicKey({ key: Buffer.from(h.xpub, 'base64'), format: 'der', type: 'spki' });
    return { ok: true, keys: { pub: h.pub, xpub: h.xpub, xsig: h.xsig } };
  } catch { return { ok: false }; }
}
function lineReader(sock, onLine) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    if (buf.length > LINE_MAX) { sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (l) onLine(l);
    }
  });
}
// Ambil dari daftar (urutan = prioritas) selama total byte JSON-nya masih di bawah anggaran.
function fitBytes(list, budget) {
  const out = []; let used = 0;
  for (const m of list) {
    const n = Buffer.byteLength(JSON.stringify(m)) + 1;
    if (used + n > budget) continue; // satu pesan besar tidak menghalangi yang lebih kecil
    used += n; out.push(m);
  }
  return out;
}
// Alamat peer: "ip", "ip:port", atau "nama-host[:port]" (mis. nama MagicDNS Tailscale). Port kosong = DEFAULT_TCP_PORT. null bila tidak sah.
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
function parseAddr(tok) {
  let host = String(tok == null ? '' : tok).trim(), port = DEFAULT_TCP_PORT;
  const m = /^(.+):(\d{1,5})$/.exec(host);
  if (m) { host = m[1]; port = Number(m[2]); }
  if (!(port >= 1 && port <= 65535) || !HOST_RE.test(host)) return null;
  if (/^[\d.]+$/.test(host) && !net.isIPv4(host)) return null; // angka bertitik yang bukan IPv4 sah (mis. 999.1.1.1)
  return { ip: host, port };
}
const ip4n = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const inCidr = (ip, base, bits) => { const sh = 2 ** (32 - bits); return Math.floor(ip4n(ip) / sh) === Math.floor(ip4n(base) / sh); };
// Rentang yang masuk akal untuk LAN/VPN: pribadi, link-local, CGNAT (Tailscale 100.64/10), Hamachi 25/8, Radmin 26/8.
const vpnish = (ip) => inCidr(ip, '100.64.0.0', 10) || inCidr(ip, '25.0.0.0', 8) || inCidr(ip, '26.0.0.0', 8);
const privateIp = (ip) => inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16) || inCidr(ip, '169.254.0.0', 16);
function localAddrs() { // [{ ip, mask, name }] antarmuka IPv4 aktif milik perangkat ini
  const out = [];
  let ifs = {};
  try { ifs = os.networkInterfaces(); } catch {} // Android 11+ bisa menolak membaca antarmuka; jangan sampai aplikasi mati
  for (const [name, list] of Object.entries(ifs)) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ ip: a.address, mask: a.netmask, name });
  return out;
}
function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  let ifs = {};
  try { ifs = os.networkInterfaces(); } catch {}
  for (const name of Object.keys(ifs)) for (const a of ifs[name] || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number), mk = a.netmask.split('.').map(Number);
    out.add(ip.map((o, i) => (o | (~mk[i] & 255))).join('.'));
  }
  return [...out];
}

module.exports = { ribu, NON_ALNUM_FALLBACK, buildSpamNorm, spamNorm, bigramDice, msgId, idFromPub, verifyMsg, aeadSeal, aeadOpen, verifyHelloKeys, lineReader, fitBytes, HOST_RE, parseAddr, ip4n, inCidr, vpnish, privateIp, localAddrs, broadcastAddrs };
