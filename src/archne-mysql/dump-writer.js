'use strict';
// Fase 3-2 — penulis dump MySQL: skema (sqlite2mysql.js) + data → potongan teks gaya mysqldump.
//   dumpChunks(db, opts) → generator string; satu potongan = satu pernyataan/blok komentar (INSERT ≤ opts.maxRows baris dan ≈ opts.maxBytes).
//   dumpToString(db, opts) → string utuh (hanya untuk dump kecil / tes).
// opts: { maxRows=500, maxBytes=1 MiB, now=()=>Date, stats={} }  — `stats` DIISI selama berjalan: { tables, rows, statements, bytes, bigStatements, nonFinite, nulText, warnings[], skipped[] }
// Pemanggil (Worker, fase 3-3) cukup `for (const s of dumpChunks(db)) { await tulis(s); }` — memori tetap kecil karena baris dibaca per baris (iterate) dan dikirim per potongan.
// SNAPSHOT: generator membuka SATU transaksi baca (BEGIN) sebelum membaca skema dan menutupnya di `finally` (juga bila pemanggil berhenti di tengah / return()), jadi skema dan semua tabel satu snapshot walau PHP menulis di sela.
// Nilai: NULL · integer persis (BigInt, tanpa kehilangan presisi >2^53) · real (Infinity/NaN → NULL, dihitung di stats.nonFinite) · BLOB → X'…' (kosong → X'') · teks → '…' dengan escape MySQL.
// Teks dibaca sebagai BYTE (CAST AS BLOB) lalu didekode UTF-8: node:sqlite memotong string di byte NUL, padahal objek PHP ter-serialize (WordPress) berisi \0; nilai teks ber-NUL ditulis sebagai X'..' (stats.nulText).
const { exportSchema, quoteId: Q } = require('./sqlite2mysql.js');
const { scaleOfType, formatDecimal } = require('./decimal.js');

const SQ = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const ESC = { '\\': '\\\\', "'": "''", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' };
const lit = (s) => "'" + s.replace(/[\\'\0\n\r\x1a]/g, (c) => ESC[c]) + "'";
// X'..' (bukan 0x..): sah di MySQL (string biner) DAN di SQLite (BLOB). 0x.. dibaca SQLite sebagai integer (maks 16 digit) sehingga importer Archne merusaknya.
const hex = (u) => "X'" + Buffer.from(u.buffer, u.byteOffset, u.length).toString('hex') + "'";
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');

function* dumpChunks(db, opts) {
  const o = opts || {};
  const maxRows = Number.isSafeInteger(o.maxRows) && o.maxRows > 0 ? o.maxRows : 500;
  const maxBytes = Number.isSafeInteger(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : 1048576;
  const now = o.now || (() => new Date());
  const stats = o.stats || {};
  Object.assign(stats, { tables: 0, rows: 0, statements: 0, bytes: 0, bigStatements: 0, nonFinite: 0, nulText: 0, warnings: [], skipped: [] });
  const out = (s) => { stats.statements++; stats.bytes += Buffer.byteLength(s); return s; };

  db.exec('BEGIN');   // transaksi baca (snapshot dimulai pada SELECT pertama)
  try {
    const sc = exportSchema(db);
    for (const t of sc.tables) for (const w of t.warnings) stats.warnings.push(w);
    stats.skipped = sc.skipped.map((x) => ({ name: x.name, kind: x.kind, reason: x.reason }));
    let head = '-- Archne MySQL dump\n-- Dibuat: ' + now().toISOString() + '\n-- Sumber: mysql.sqlite (tipe kolom: asli bila tersimpan, selain itu diturunkan dari data)\n--\n';
    for (const s of stats.skipped) head += '-- Dilewati: ' + oneLine(s.kind + ' ' + s.name + ' — ' + s.reason) + '\n';
    for (const w of stats.warnings) head += '-- Peringatan: ' + oneLine(w) + '\n';
    head += '\n/*!40101 SET NAMES utf8mb4 */;\n/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE=\'NO_AUTO_VALUE_ON_ZERO\' */;\n';
    yield out(head);

    for (const t of sc.tables) {
      stats.tables++;
      yield out('\n--\n-- Struktur tabel ' + oneLine(t.name) + '\n--\n\nDROP TABLE IF EXISTS ' + Q(t.name) + ';\n' + t.sql + ';\n');
      const cols = t.columns.map((c) => Q(c.name)).join(', ');
      const sel = t.columns.map((c) => 'typeof(' + SQ(c.name) + "), CASE typeof(" + SQ(c.name) + ") WHEN 'text' THEN CAST(" + SQ(c.name) + ' AS BLOB) ELSE ' + SQ(c.name) + ' END').join(', ');
      const st = db.prepare('SELECT ' + sel + ' FROM ' + SQ(t.name));
      st.setReturnArrays(true); st.setReadBigInts(true);
      const scales = t.columns.map((c) => scaleOfType(c.type));
      const prefix = 'INSERT INTO ' + Q(t.name) + ' (' + cols + ') VALUES\n';
      let buf = [], size = 0, first = true;
      const flush = () => {
        const s = prefix + buf.join(',\n') + ';\n';
        buf = []; size = 0;
        if (s.length > 4194304) stats.bigStatements++;
        return out((first ? '\n--\n-- Data tabel ' + oneLine(t.name) + '\n--\n\n' : '') + s);
      };
      for (const r of st.iterate()) {
        const v = new Array(t.columns.length);
        for (let i = 0; i < v.length; i++) {
          const k = r[i * 2], x = r[i * 2 + 1];
          if (k === 'null' || x == null) v[i] = 'NULL';
          else if ((k === 'integer' || (k === 'real' && Number.isFinite(x))) && scales[i] != null) v[i] = formatDecimal(x, scales[i]);
          else if (k === 'integer') v[i] = x.toString();
          else if (k === 'real') { if (Number.isFinite(x)) v[i] = String(x); else { v[i] = 'NULL'; stats.nonFinite++; } }
          else if (k === 'blob') v[i] = hex(x);
          else {   // teks (dibaca sebagai byte). Berisi NUL → X'..': escape \0 menjadi byte NUL mentah di SQL, yang tak bisa dibaca SQLite/importer Archne; MySQL tetap menyimpannya benar ke kolom teks.
            const bytes = Buffer.from(x.buffer, x.byteOffset, x.length);
            if (bytes.includes(0)) { v[i] = hex(bytes); stats.nulText++; } else v[i] = lit(bytes.toString('utf8'));
          }
        }
        const row = '(' + v.join(',') + ')';
        buf.push(row); size += row.length + 2; stats.rows++;
        if (buf.length >= maxRows || size >= maxBytes) { yield flush(); first = false; }
      }
      if (buf.length) yield flush();
    }
    yield out('\n/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n-- Selesai: ' + stats.tables + ' tabel, ' + stats.rows + ' baris\n');
  } finally {
    try { if (db.isTransaction) db.exec('COMMIT'); } catch (_) { /* koneksi baca: tak ada yang perlu dibatalkan */ }
  }
}

function dumpToString(db, opts) { let s = ''; for (const c of dumpChunks(db, opts)) s += c; return s; }

module.exports = { dumpChunks, dumpToString, sqlLiteral: lit, hexLiteral: hex };
