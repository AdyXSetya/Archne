'use strict';
// P.9 langkah 6c-1: fungsi skalar MySQL tambahan. Semua waktu dianggap UTC.
const crypto = require('node:crypto');
const p2 = (n) => String(n).padStart(2, '0');
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 'YYYY-MM-DD[ HH:MM:SS]' → Date (UTC) atau null
function pd(v) {
  if (v == null) return null;
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}):(\d{1,2}))?/.exec(String(v));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  return isNaN(d) || d.getUTCMonth() !== +m[2] - 1 ? null : d;
}
const ymd = (d) => d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
const hms = (d) => p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
const doy = (d) => Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
const nn = (f) => { const w = (...a) => (a.some(x => x == null) ? null : f(...a)); Object.defineProperty(w, 'length', { value: f.length }); return w; };
const toSec = (t) => { const m = /^(-?)(\d+):(\d{1,2})(?::(\d{1,2}))?/.exec(String(t)); return m ? (m[1] ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60 + +(m[4] || 0)) : null; };

function strToDate(s, f) {
  let re = '', keys = [], hasT = false;
  const fm = String(f).replace(/%T/g, '%H:%i:%s');
  for (let i = 0; i < fm.length; i++) {
    const c = fm[i];
    if (c !== '%') { re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    const k = fm[++i];
    if ('YymcdeHkhIlisSpbM'.includes(k)) {
      re += k === 'Y' ? '(\\d{4})' : k === 'p' ? '(AM|PM|am|pm)' : (k === 'b' || k === 'M') ? '([A-Za-z]+)' : '(\\d{1,2})';
      keys.push(k); if ('HkhIlisSp'.includes(k)) hasT = true;
    } else re += k === '%' ? '%' : '.*?';
  }
  const m = new RegExp('^\\s*' + re).exec(String(s));
  if (!m) return null;
  let Y = 0, Mo = 0, D = 0, H = 0, I = 0, S = 0, pm = null;
  keys.forEach((k, j) => {
    const v = m[j + 1];
    if (k === 'Y') Y = +v; else if (k === 'y') Y = +v < 70 ? 2000 + +v : 1900 + +v;
    else if (k === 'm' || k === 'c') Mo = +v; else if (k === 'd' || k === 'e') D = +v;
    else if ('HkhIl'.includes(k)) H = +v; else if (k === 'i') I = +v; else if (k === 's' || k === 'S') S = +v;
    else if (k === 'p') pm = v.toUpperCase() === 'PM';
    else if (k === 'b' || k === 'M') Mo = MON.findIndex(n => n.toLowerCase().startsWith(v.toLowerCase().slice(0, 3))) + 1;
  });
  if (pm !== null) H = (H % 12) + (pm ? 12 : 0);
  const out = (Y || Mo || D) ? Y + '-' + p2(Mo) + '-' + p2(D) : '';
  if (!hasT) return out || null;
  return (out ? out + ' ' : '') + p2(H) + ':' + p2(I) + ':' + p2(S);
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const n = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - n + 3);
  const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - f) / 864e5 - 3 + ((f.getUTCDay() + 6) % 7)) / 7);
}
function week0(d) {
  const j1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).getUTCDay();
  const first = 1 + ((7 - j1) % 7), n = doy(d);
  return n < first ? 0 : Math.floor((n - first) / 7) + 1;
}
const crc = (s) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xFFFFFFFF; for (const b of Buffer.from(String(s))) c = t[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function install(d) {
  const f = (name, fn) => d.function(name, fn);
  const fv = (name, fn) => d.function(name, { varargs: true }, fn);
  const chars = (s) => [...String(s)];
  fv('CHARSET', () => 'utf8mb4'); fv('COLLATION', () => 'utf8mb4_general_ci'); fv('COERCIBILITY', () => 4);
  // string
  f('LEFT', nn((s, n) => chars(s).slice(0, Math.max(0, n)).join('')));
  f('RIGHT', nn((s, n) => n <= 0 ? '' : chars(s).slice(-n).join('')));
  f('REVERSE', nn((s) => chars(s).reverse().join('')));
  f('REPEAT', nn((s, n) => n > 0 ? String(s).repeat(Math.min(n, 1e6)) : ''));
  f('SPACE', nn((n) => ' '.repeat(Math.max(0, Math.min(n, 1e6)))));
  f('LCASE', nn((s) => String(s).toLowerCase()));
  f('UCASE', nn((s) => String(s).toUpperCase()));
  fv('LOCATE', nn((sub, s, pos) => { const p = pos == null ? 1 : pos; if (p < 1) return 0; return String(s).indexOf(String(sub), p - 1) + 1; }));
  fv('CONCAT_WS', (sep, ...a) => sep == null ? null : a.filter(x => x != null).join(String(sep)));
  f('FIND_IN_SET', nn((s, l) => l === '' ? 0 : String(l).split(',').indexOf(String(s)) + 1));
  fv('ELT', (n, ...a) => (n == null || n < 1 || n > a.length) ? null : a[n - 1]);
  fv('MAKE_SET', (bits, ...a) => bits == null ? null : a.filter((x, i) => (bits >> i) & 1 && x != null).join(','));
  f('ASCII', nn((s) => String(s).length ? Buffer.from(String(s))[0] : 0));
  f('ORD', nn((s) => String(s).length ? String(s).codePointAt(0) : 0));
  f('HEX', nn((v) => typeof v === 'number' ? BigInt(Math.trunc(v)).toString(16).toUpperCase() : Buffer.from(v).toString('hex').toUpperCase()));
  f('BIN', nn((n) => BigInt(Math.trunc(n)).toString(2)));
  f('OCT', nn((n) => BigInt(Math.trunc(n)).toString(8)));
  f('CONV', nn((n, a, b) => { const v = parseInt(String(n), Math.abs(a)); return isNaN(v) ? '0' : v.toString(Math.abs(b)).toUpperCase(); }));
  f('TO_BASE64', nn((s) => Buffer.from(String(s)).toString('base64')));
  f('FROM_BASE64', nn((s) => Buffer.from(String(s), 'base64').toString('utf8')));
  f('STRCMP', nn((a, b) => { a = String(a).toLowerCase(); b = String(b).toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; }));
  f('BIT_LENGTH', nn((s) => Buffer.byteLength(String(s)) * 8));
  f('CRC32', nn(crc));
  f('SHA2', nn((s, n) => crypto.createHash('sha' + (n === 0 ? 256 : n)).update(String(s)).digest('hex')));
  f('SUBSTRING_INDEX', nn((s, dl, c) => {
    s = String(s); dl = String(dl); if (!dl || c === 0) return '';
    const p = s.split(dl);
    return c > 0 ? p.slice(0, c).join(dl) : p.slice(c).join(dl);
  }));
  f('INET_ATON', nn((s) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(s)); return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : null; }));
  f('UUID', () => crypto.randomUUID());
  f('REGEXP_LIKE', nn((s, p) => { try { return new RegExp(String(p), 'i').test(String(s)) ? 1 : 0; } catch { return null; } }));
  fv('REGEXP_REPLACE', nn((s, p, r) => { try { return String(s).replace(new RegExp(String(p), 'gi'), String(r).replace(/\$(\d)/g, '$$$1')); } catch { return null; } }));
  f('JSON_UNQUOTE', nn((s) => { try { const v = JSON.parse(String(s)); return typeof v === 'string' ? v : String(s); } catch { return String(s); } }));
  f('ANY_VALUE', (v) => v);
  f('BIT_COUNT', nn((n) => { let c = 0n, x = BigInt.asUintN(64, BigInt(Math.trunc(n))); while (x) { c += x & 1n; x >>= 1n; } return Number(c); }));
  // numeric
  f('TRUNCATE', nn((x, n) => { const m = Math.pow(10, n); return Math.trunc(x * m) / m; }));
  // locks / misc (no-op, sesi tunggal)
  fv('GET_LOCK', () => 1);
  fv('RELEASE_LOCK', () => 1);
  fv('SLEEP', () => 0);
  // dipanggil dari hasil penulisan ulang penerjemah (6c-2)
  f('TSDIFF', nn((u, a, b) => {
    const x = pd(a), y = pd(b); if (!x || !y) return null;
    u = String(u).toUpperCase(); const ms = y - x;
    const sec = { SECOND: 1, MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800 }[u];
    if (sec) return Math.trunc(ms / 1000 / sec);
    if (!['MONTH', 'QUARTER', 'YEAR'].includes(u)) return null;
    let m = (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth();
    const tail = (d) => d.getUTCDate() * 86400 + d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    if (m > 0 && tail(y) < tail(x)) m--; else if (m < 0 && tail(y) > tail(x)) m++;
    return Math.trunc(m / (u === 'MONTH' ? 1 : u === 'QUARTER' ? 3 : 12));
  }));
  f('EXTRACT_', nn((u, v) => {
    const x = pd(v); if (!x) return null;
    switch (String(u).toUpperCase()) {
      case 'YEAR': return x.getUTCFullYear(); case 'MONTH': return x.getUTCMonth() + 1; case 'DAY': return x.getUTCDate();
      case 'HOUR': return x.getUTCHours(); case 'MINUTE': return x.getUTCMinutes(); case 'SECOND': return x.getUTCSeconds();
      case 'QUARTER': return Math.floor(x.getUTCMonth() / 3) + 1; case 'WEEK': return week0(x); case 'MICROSECOND': return 0;
      case 'YEAR_MONTH': return x.getUTCFullYear() * 100 + x.getUTCMonth() + 1;
      default: return null;
    }
  }));
  f('STR_INSERT', (s, pos, len, n) => {
    if (s == null || pos == null || len == null || n == null) return null;
    const c = chars(s); if (pos < 1 || pos > c.length) return String(s);
    return c.slice(0, pos - 1).join('') + n + (len < 0 ? '' : c.slice(pos - 1 + len).join(''));
  });
  // tanggal
  const dd = (name, fn) => f(name, (v) => { const x = pd(v); return x ? fn(x) : null; });
  dd('DAYOFMONTH', (x) => x.getUTCDate());
  dd('DAYOFYEAR', doy);
  dd('DAYOFWEEK', (x) => x.getUTCDay() + 1);
  dd('WEEKDAY', (x) => (x.getUTCDay() + 6) % 7);
  dd('WEEKOFYEAR', isoWeek);
  dd('QUARTER', (x) => Math.floor(x.getUTCMonth() / 3) + 1);
  dd('MONTHNAME', (x) => MON[x.getUTCMonth()]);
  dd('DAYNAME', (x) => DAY[x.getUTCDay()]);
  dd('LAST_DAY', (x) => ymd(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0))));
  dd('TO_DAYS', (x) => Math.round(x.getTime() / 864e5) + 719528);
  dd('MICROSECOND', () => 0);
  fv('WEEK', (v, mode) => { const x = pd(v); return x ? ((mode === 3) ? isoWeek(x) : week0(x)) : null; });
  f('FROM_DAYS', nn((n) => ymd(new Date((n - 719528) * 864e5))));
  f('MAKEDATE', nn((y, n) => ymd(new Date(Date.UTC(y, 0, n)))));
  f('STR_TO_DATE', nn(strToDate));
  f('TIME_TO_SEC', nn(toSec));
  f('SEC_TO_TIME', nn((n) => { const s = Math.abs(Math.trunc(n)); return (n < 0 ? '-' : '') + p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60); }));
  f('CURTIME', () => hms(new Date()));
  f('UTC_TIMESTAMP', () => { const n = new Date(); return ymd(n) + ' ' + hms(n); });
  f('UTC_DATE', () => ymd(new Date()));
}
module.exports = { install, strToDate };
