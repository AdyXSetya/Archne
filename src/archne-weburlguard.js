'use strict';
// src/archne-weburlguard.js — Penjaga URL untuk pengunduh aset (0.34.0 Fase O2a, "Jadikan offline"). MURNI: tanpa jaringan, tanpa DNS, tanpa berkas. Dipakai pengambil (O2b) sebelum DAN sesudah tiap lompatan redirect, dan terhadap IP hasil resolve DNS.
// API:
//   checkUrl(raw, opts) -> { ok:true, url, host, https } | { ok:false, code }   code: bad | insecure | scheme | cred | port | host | private
//   redirectTarget(baseHref, location, opts) -> sama seperti checkUrl, ditambah code 'downgrade' (https -> http ditolak walau allowHttp)
//   isPublicIp(ip) -> boolean (GAGAL TERTUTUP: alamat yang tidak bisa diurai = false). Untuk memeriksa IP hasil resolve sebelum menyambung.
//   checkType(kind, contentType) -> { ok:true, type } | { ok:false, code:'type'|'kind' };  limitFor(kind) -> byte maksimum | null
//   opts: { allowHttp:false, ports:[] (selain port bawaan), allowPrivate:false }. allowPrivate HANYA untuk tes (server loopback); kode produksi tidak boleh menyetelnya.
// Sikap: daftar-putih. https saja; tanpa kata sandi di URL; port bawaan saja; host harus nama domain bertitik atau IP publik; IPv6 hanya 2000::/3 (kecuali 6to4, Teredo, dokumentasi) sehingga loopback, ULA, link-local, mapped-IPv4 dan NAT64 otomatis ditolak.
// Penguraian memakai WHATWG URL, jadi bentuk IP yang dikaburkan (2130706433, 0x7f.1, 127.1, 017700000001, [::ffff:7f00:1]) sudah dinormalkan sebelum diperiksa. Tanda "// G:nama" menandai penjaga yang dicabut oleh tes kontrol kepekaan (test/weburlguard.js): tiap penjaga harus satu baris.
// Batas tipe/ukuran per jenis berlaku untuk jenis yang bisa disalin menurut pemindai O1 (script, style, font, image).
const net = require('net');

const LIM = { url: 2048, redirects: 3, host: 253, label: 63 };
const KIND_LIMIT = { script: 2 * 1024 * 1024, style: 1024 * 1024, font: 4 * 1024 * 1024, image: 8 * 1024 * 1024 };
const TYPES = {
  script: ['application/javascript', 'text/javascript', 'application/x-javascript', 'application/ecmascript', 'text/ecmascript'],
  style: ['text/css'],
  font: ['font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'font/sfnt', 'application/font-woff', 'application/font-woff2', 'application/x-font-woff', 'application/x-font-ttf', 'application/x-font-otf', 'application/font-sfnt', 'application/vnd.ms-fontobject', 'application/octet-stream'],
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/bmp'],
};
const CTL = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff\\]/; // kendali, spasi, spasi Unicode, backslash (backslash dibaca sebagai "/" oleh parser => penyamaran host)
const PRIV_NAME = /\.(localhost|local|localdomain|internal|intranet|lan|home|corp|private|invalid|arpa)$/;
const LABEL = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;

const fail = (code) => ({ ok: false, code });
const u32 = (a, b, c, d) => (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
const parseV4 = (s) => { if (!net.isIPv4(s)) return null; const p = s.split('.').map(Number); return u32(p[0], p[1], p[2], p[3]); };
const B4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .map(([a, b]) => [parseV4(a), b]);

function classifyV4(n) { // -> 'private' | null
  if (B4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)))) return 'private'; // G:v4
  return null;
}

function parseV6(s) { // -> [8 x uint16] | null
  s = String(s).toLowerCase();
  if (s.indexOf('%') >= 0 || !net.isIPv6(s)) return null;
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const n = parseV4(m[2]); if (n === null) return null; s = m[1] + (n >>> 16).toString(16) + ':' + (n & 0xffff).toString(16); }
  const dc = s.indexOf('::');
  let g;
  if (dc >= 0) {
    const head = s.slice(0, dc) ? s.slice(0, dc).split(':') : [], rest = s.slice(dc + 2) ? s.slice(dc + 2).split(':') : [];
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    g = head.concat(Array(fill).fill('0'), rest);
  } else g = s.split(':');
  if (g.length !== 8) return null;
  g = g.map((x) => parseInt(x, 16));
  return g.some((x) => !(x >= 0 && x <= 0xffff)) ? null : g;
}

function classifyV6(g) { // -> 'private' | null
  if ((g[0] & 0xe000) !== 0x2000) return 'private'; // G:v6   daftar-putih 2000::/3: tolak ::, ::1, fc00::/7, fe80::/10, ff00::/8, ::ffff:0:0/96, 64:ff9b::/96 ...
  if (g[0] === 0x2002) return 'private'; // G:6to4   2002::/16 menyembunyikan IPv4 di dalamnya
  if (g[0] === 0x2001 && (g[1] < 0x200 || g[1] === 0x0db8)) return 'private'; // G:rsv   2001::/23 (termasuk Teredo 2001::/32) dan 2001:db8::/32
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return 'private'; // G:rsv2   3fff::/20 dokumentasi
  return null;
}

function isPublicIp(ip) {
  if (typeof ip !== 'string') return false;
  const v = net.isIP(ip);
  if (v === 4) { const n = parseV4(ip); return n !== null && classifyV4(n) === null; }
  if (v === 6) { const g = parseV6(ip); return g !== null && classifyV6(g) === null; }
  return false;
}

function checkUrl(raw, o) {
  o = o || {};
  if (typeof raw !== 'string' || !raw || raw.length > LIM.url) return fail('bad'); // G:len
  if (CTL.test(raw)) return fail('bad'); // G:ctl
  let u;
  try { u = new URL(raw); } catch { return fail('bad'); }
  const sch = u.protocol;
  if (sch !== 'https:' && !(sch === 'http:' && o.allowHttp)) return fail(sch === 'http:' ? 'insecure' : 'scheme'); // G:scheme
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw)) return fail('cred'); // G:cred
  if (u.port && !(Array.isArray(o.ports) && o.ports.includes(Number(u.port)))) return fail('port'); // G:port
  let h = u.hostname.toLowerCase();
  const priv = !o.allowPrivate;
  if (h[0] === '[') {
    const g = parseV6(h.slice(1, -1));
    if (!g) return fail('host');
    if (priv && classifyV6(g)) return fail('private');
    h = h.slice(1, -1);
  } else if (net.isIPv4(h)) {
    if (priv && classifyV4(parseV4(h))) return fail('private');
  } else {
    if (h.endsWith('.')) h = h.slice(0, -1);
    if (!h || h.length > LIM.host || h.split('.').some((l) => !l || l.length > LIM.label || !LABEL.test(l))) return fail('host'); // G:label
    if (priv && h.indexOf('.') < 0) return fail('private'); // G:single
    if (priv && (h === 'localhost' || PRIV_NAME.test(h))) return fail('private'); // G:name
  }
  u.hash = '';
  return { ok: true, url: u.href, host: h, https: sch === 'https:' };
}

function redirectTarget(base, location, o) {
  if (typeof location !== 'string' || !location || location.length > LIM.url || CTL.test(location)) return fail('bad');
  let b, t;
  try { b = new URL(base); t = new URL(location, b); } catch { return fail('bad'); }
  if (b.protocol === 'https:' && t.protocol === 'http:') return fail('downgrade'); // G:dgrade
  return checkUrl(t.href, o);
}

function checkType(kind, ct) {
  const allowed = Object.prototype.hasOwnProperty.call(TYPES, kind) ? TYPES[kind] : null;
  if (!allowed) return fail('kind');
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  return allowed.includes(t) ? { ok: true, type: t } : fail('type');
}
const limitFor = (kind) => (Object.prototype.hasOwnProperty.call(KIND_LIMIT, kind) ? KIND_LIMIT[kind] : null);

module.exports = { checkUrl, redirectTarget, isPublicIp, checkType, limitFor, LIM, KIND_LIMIT };
