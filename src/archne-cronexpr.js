'use strict';
// src/archne-cronexpr.js — Ekspresi cron 5 kolom untuk penjadwal Web Lokal (Cronjob C1). MURNI: tanpa disk, jaringan, atau timer.
// API: parse(text) -> { ok:true, spec } | { ok:false, code }   code: bad (bukan teks / kosong / terlalu panjang) | fields | value | step | range | preset
//      nextRun(spec, fromMs) -> ms (menit penuh PERTAMA yang > fromMs, waktu lokal perangkat) | null (tidak ada dalam 5 tahun, mis. 31 Feb)
// Kolom: menit 0-59, jam 0-23, tanggal 1-31, bulan 1-12 (atau JAN-DEC), hari 0-7 (atau SUN-SAT; 0 dan 7 = Minggu).
// Isi kolom: * | angka | a-b | daftar a,b,c | langkah */n atau a-b/n atau a/n. Preset: @hourly @daily @midnight @weekly @monthly @yearly @annually.
// Tanggal dan hari: bila KEDUANYA dibatasi (bukan *), cocok salah satu (aturan cron standar); bila salah satu *, yang lain yang menentukan.
// Sengaja tidak ada: nama hari/bulan dengan rentang berputar (FRI-MON), L/W/#, detik, dan @reboot (penjadwal bukan init).
const MAXLEN = 100, YEARS = 5;
const PRESET = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DOW = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const FIELDS = [{ lo: 0, hi: 59 }, { lo: 0, hi: 23 }, { lo: 1, hi: 31 }, { lo: 1, hi: 12, names: MON }, { lo: 0, hi: 7, names: DOW }];
const fail = (code) => ({ ok: false, code });

function num(tok, f) {
  if (/^\d{1,2}$/.test(tok)) return Number(tok);
  const n = f.names && f.names[String(tok).toUpperCase()];
  return n === undefined ? NaN : n;
}
function field(text, f) {
  const set = new Set(); let star = false;
  for (const part of text.split(',')) {
    if (!part) return fail('value');
    const [rng, st, extra] = part.split('/');
    if (extra !== undefined) return fail('step');
    let step = 1;
    if (st !== undefined) { if (!/^\d{1,2}$/.test(st) || Number(st) < 1) return fail('step'); step = Number(st); }
    let a, b;
    if (rng === '*') { a = f.lo; b = f.hi === 7 ? 6 : f.hi; if (st === undefined) star = true; }
    else if (rng.includes('-')) { const [x, y, z] = rng.split('-'); if (z !== undefined) return fail('range'); a = num(x, f); b = num(y, f); if (Number.isNaN(a) || Number.isNaN(b)) return fail('value'); if (a > b) return fail('range'); }
    else { a = num(rng, f); if (Number.isNaN(a)) return fail('value'); b = st !== undefined ? f.hi : a; }
    if (a < f.lo || b > f.hi) return fail('value');
    for (let v = a; v <= b; v += step) set.add(f.hi === 7 && v === 7 ? 0 : v);
  }
  return { ok: true, set, star };
}
function parse(text) {
  if (typeof text !== 'string') return fail('bad');
  let t = text.trim().replace(/\s+/g, ' ');
  if (!t || t.length > MAXLEN) return fail('bad');
  if (t[0] === '@') { const p = PRESET[t.toLowerCase()]; if (!p) return fail('preset'); t = p; }
  const parts = t.split(' ');
  if (parts.length !== 5) return fail('fields');
  const out = [];
  for (let i = 0; i < 5; i++) { const r = field(parts[i], FIELDS[i]); if (!r.ok) return r; out.push(r); }
  return { ok: true, spec: { min: out[0].set, hour: out[1].set, dom: out[2].set, mon: out[3].set, dow: out[4].set, domStar: out[2].star, dowStar: out[4].star } };
}
function dayOk(s, d) {
  const a = s.dom.has(d.getDate()), b = s.dow.has(d.getDay());
  return s.domStar && s.dowStar ? true : s.domStar ? b : s.dowStar ? a : a || b;
}
function nextRun(spec, fromMs) {
  if (!spec || !spec.min || !Number.isFinite(fromMs)) return null;
  const d = new Date(fromMs); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const limit = fromMs + YEARS * 366 * 86400e3;
  for (let i = 0; i < 400000 && d.getTime() <= limit; i++) {
    if (!spec.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayOk(spec, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!spec.hour.has(d.getHours())) { const h = d.getHours(); d.setHours(h + 1, 0, 0, 0); if (d.getHours() === h) d.setHours(h + 2, 0, 0, 0); continue; } // jaga celah DST: jam tidak boleh macet
    if (!spec.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    const t = d.getTime(); return t > fromMs ? t : null;
  }
  return null;
}
module.exports = { parse, nextRun, PRESET };
