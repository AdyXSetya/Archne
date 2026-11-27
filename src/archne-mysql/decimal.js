'use strict';
// DECIMAL ala MySQL di atas SQLite. Skala disimpan di tipe deklarasi (DECIMAL(p,s)); nilai tetap angka di SQLite, dan modul ini
// menentukan skala tiap kolom HASIL lalu memformat nilainya menjadi teks ('12.50') seperti MySQL.
// Yang diturunkan skalanya: kolom langsung (juga lewat alias/join/subquery), SUM/MIN/MAX/AVG, COALESCE/IFNULL, ROUND, CAST DECIMAL, + - *.
// Di luar itu (pembagian, CASE, IF, UNION, fungsi lain) nilainya dibiarkan apa adanya.

function scaleOfType(decl) {
  const m = /^\s*(?:DECIMAL|NUMERIC)\s*\(\s*\d+\s*(?:,\s*(\d+)\s*)?\)/i.exec(String(decl || ''));
  return m ? Number(m[1] || 0) : null;
}

// Pembulatan setengah menjauhi nol seperti DECIMAL MySQL (toFixed saja membulatkan 2.345 menjadi 2.34).
function formatDecimal(v, s) {
  if (typeof v === 'bigint') return v.toString() + (s ? '.' + '0'.repeat(s) : '');
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const a = Math.abs(v), t = String(a);
  const r = t.includes('e') ? a : Number(Math.round(Number(t + 'e' + s)) + 'e-' + s);
  const out = r.toFixed(s);
  return v < 0 && Number(out) !== 0 ? '-' + out : out;
}

const TOKEN = /\/\*dec\*\/|\/\*[\s\S]*?\*\/|--[^\n]*|\s+|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_$]*|[<>!=]=|<>|\|\||[\s\S]/g;
const lex = (sql) => (sql.match(TOKEN) || []).filter((t) => t === '/*dec*/' || !/^(\s|\/\*|--)/.test(t));
const unq = (t) => (/^["`\[]/.test(t) ? t.slice(1, -1) : t).toLowerCase();

// Daftar ekspresi SELECT tingkat atas, atau null bila bentuknya tidak bisa dianalisis dengan aman.
function selectList(toks) {
  let d = 0, start = -1;
  const items = []; let cur = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], u = t.toUpperCase();
    if (t === '(') d++; else if (t === ')') d--;
    if (d === 0 && (u === 'UNION' || u === 'INTERSECT' || u === 'EXCEPT')) return null;
    if (start < 0) { if (d === 0 && u === 'SELECT') { start = i; if (/^(DISTINCT|ALL)$/i.test(toks[i + 1] || '')) i++; } continue; }
    if (start === -2) continue;
    if (d === 0 && u === 'FROM') { items.push(cur); start = -2; continue; }
    if (d === 0 && t === ',') { items.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (start >= 0) items.push(cur);
  return start === -1 ? null : items;
}

// Buang alias di ujung item: "expr AS x" atau "expr x".
function stripAlias(it) {
  const n = it.length;
  if (n >= 3 && /^AS$/i.test(it[n - 2])) return it.slice(0, -2);
  if (n >= 2 && /^["`\[A-Za-z_]/.test(it[n - 1]) && (it[n - 2] === ')' || /^["`\[A-Za-z_]/.test(it[n - 2])) && !/^(END|NULL)$/i.test(it[n - 1])) return it.slice(0, -1);
  return it;
}

// Skala sebuah ekspresi: { s, dec } (dec=false: bilangan bulat/literal, ikut dihitung tetapi bukan DECIMAL sendiri) atau null.
function infer(e, cols) {
  let i = 0;
  const peek = () => e[i];
  const combine = (a, b, mul) => (a && b ? { s: mul ? a.s + b.s : Math.max(a.s, b.s), dec: a.dec || b.dec } : null);
  function sum() { let a = product(); while (peek() === '+' || peek() === '-') { i++; a = combine(a, product(), false); } return a; }
  function product() { let a = atom(); while (peek() === '*') { i++; a = combine(a, atom(), true); } return a; }
  function args() {   // posisi di '(' → daftar potongan token per argumen
    const out = [[]]; let d = 0;
    for (; i < e.length; i++) {
      const t = e[i];
      if (t === '(') { if (++d === 1) continue; } else if (t === ')') { if (--d === 0) { i++; return out; } } else if (t === ',' && d === 1) { out.push([]); continue; }
      out[out.length - 1].push(t);
    }
    return out;
  }
  function atom() {
    const t = peek();
    if (t === undefined) return null;
    if (t === '-' || t === '+') { i++; return atom(); }
    if (t === '(') { const a = args(); return a.length === 1 ? infer(a[0], cols) : null; }
    if (/^\d/.test(t)) { i++; return { s: (t.split('.')[1] || '').length, dec: false }; }
    if (!/^["`\[A-Za-z_]/.test(t)) return null;
    i++;
    if (peek() === '(') {
      const f = t.toUpperCase(), a = args();
      if (f === 'ROUND' || f === '__ROUND') {
        const n = a[1] && /^\d+$/.test(a[1][0]) ? Number(a[1][0]) : 0;
        if (a[1] && a[1][1] === '/*dec*/') return { s: n, dec: true };
        const x = infer(a[0], cols); return x && x.dec ? { s: n, dec: true } : null;
      }
      const first = a[0][0] && /^DISTINCT$/i.test(a[0][0]) ? a[0].slice(1) : a[0];
      if ((f === 'SUM' || f === 'MIN' || f === 'MAX') && a.length === 1) return infer(first, cols);
      if (f === 'AVG') { const x = infer(first, cols); return x && x.dec ? { s: x.s + 4, dec: true } : null; }
      if (f === 'COALESCE' || f === 'IFNULL') return a.map((p) => infer(p, cols)).reduce((x, y) => combine(x, y, false));
      return null;
    }
    let name = t;
    while (peek() === '.') { i++; name = e[i++]; }
    const c = name === undefined ? undefined : cols.get(unq(name));
    return c || null;
  }
  const r = sum();
  return i === e.length ? r : null;
}

// Peta nama kolom → skala untuk semua tabel yang disebut dalam SQL. Nama sama dengan skala berbeda = ambigu (tidak dipakai).
function columnScales(db, toks) {
  const map = new Map();
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND lower(name) = ?");
  for (const n of new Set(toks.filter((t) => /^["`\[A-Za-z_]/.test(t)).map(unq))) {
    const r = has.get(n); if (!r) continue;
    for (const c of db.prepare('SELECT name, type FROM pragma_table_info(?)').all(String(r.name))) {
      const k = String(c.name).toLowerCase(), s = scaleOfType(c.type);
      const v = s != null ? { s, dec: true } : /INT/i.test(c.type) ? { s: 0, dec: false } : null;
      if (!map.has(k)) map.set(k, v);
      else { const o = map.get(k); if (!o || !v || o.s !== v.s || o.dec !== v.dec) map.set(k, null); }
    }
  }
  return map;
}

// Skala tiap kolom hasil (null = bukan DECIMAL). `meta` = st.columns().
function resultScales(db, sql, meta) {
  const out = meta.map((c) => scaleOfType(c.type));
  if (!meta.some((c) => c.type == null)) return out;
  const toks = lex(sql), items = selectList(toks);
  if (!items || items.length !== meta.length) return out;   // mis. SELECT * bercampur ekspresi: jangan menebak
  let cols = null;
  meta.forEach((c, i) => {
    if (c.type != null) return;
    if (!cols) cols = columnScales(db, toks);
    const r = infer(stripAlias(items[i]), cols);
    if (r && r.dec) out[i] = Math.min(r.s, 30);
  });
  return out;
}

// Format baris (array) di tempat dan tandai kolom DECIMAL (c.decimals) untuk lapisan protokol.
function applyDecimals(db, sql, cols, rows) {
  if (!cols.length) return { cols, rows };
  const scales = resultScales(db, sql, cols);
  if (scales.every((s) => s == null)) return { cols, rows };
  for (const row of rows) scales.forEach((s, i) => { if (s != null) row[i] = formatDecimal(row[i], s); });
  return { cols: cols.map((c, i) => (scales[i] == null ? c : { ...c, decimals: scales[i] })), rows };
}

module.exports = { scaleOfType, formatDecimal, resultScales, applyDecimals };
