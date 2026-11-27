'use strict';
// Fase 3-1 — kebalikan mysql2sqlite.js, bagian SKEMA: baca mysql.sqlite → CREATE TABLE gaya mysqldump.
//   exportSchema(db) → { tables:[{ name, sql, autoIncrement, columns:[{ name, type, kind }], warnings:[] }], skipped:[{ name, kind, reason }] }
// `db` = koneksi node:sqlite (DatabaseSync) yang SUDAH dibuka pemanggil; modul ini hanya MEMBACA. Pemanggil (Worker, fase 3-3) membungkusnya dalam satu transaksi baca supaya skema dan data satu snapshot.
// Fase 4: tipe MySQL asli (penanda di DDL, mytypes.js) dipakai bila datanya muat. Aturan turunan dari DATA di bawah berlaku untuk kolom tanpa penanda atau yang datanya tidak muat.
// Aturan (hasilnya wajar untuk migrasi, bukan salinan skema asli):
//   INTEGER → int(11), atau bigint(20) bila ada nilai di luar int32 · REAL → double · NUMERIC → decimal(20,6) · BLOB → longblob
//   teks/lainnya → varchar(191) bila ikut indeks dan ≤191 karakter; text/mediumtext/longtext (menurut byte terbesar) bila tidak; kolom teks beriindeks yang >191 karakter diberi awalan kunci (191)
//   teks DEFAULT CURRENT_TIMESTAMP yang semua nilainya berformat "YYYY-MM-DD hh:mm:ss" → datetime
//   teks tanpa COLLATE NOCASE → utf8mb4_bin (padanan perilaku SQLite: bandingan biner); dengan NOCASE → bawaan tabel utf8mb4_general_ci
//   PRIMARY KEY satu kolom INTEGER → AUTO_INCREMENT (sama seperti SHOW CREATE TABLE di engine.js); AUTO_INCREMENT=n dari sqlite_sequence bila ada
// Dilewati dan dilaporkan di `skipped`: tampilan (VIEW; SQL SQLite tak bisa diterjemahkan andal ke MySQL), tabel tanpa kolom.
// Indeks ekspresi/parsial (selain FULLTEXT = `WHERE 0`) dilewati dengan peringatan di `warnings` tabel.
const { columnTypes, fitsSql, baseOf, sizeOf } = require('./mytypes.js');
const Q = (n) => '`' + String(n).replace(/`/g, '``') + '`';
const SQ = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const str = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/'/g, "''") + "'";   // literal MySQL: backslash adalah escape di MySQL, tidak di SQLite
const DT_GLOB = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'";
const INT_MIN = -2147483648, INT_MAX = 2147483647, PREFIX = 191, KEY_BYTES = 3072, CHUNK = 200;
const isTs = (d) => d != null && /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW\(\))$/i.test(String(d).trim());

function family(decl) {
  const d = String(decl || '').toUpperCase();
  if (/INT/.test(d)) return 'int';
  if (/BLOB/.test(d)) return 'blob';
  if (/REAL|FLOA|DOUB/.test(d)) return 'real';
  if (/NUMERIC|DECIMAL/.test(d)) return 'num';
  return 'text';   // TEXT, CHAR, CLOB, dan tipe kosong
}

// Fakta data per kolom: satu SELECT agregat per tabel (dipecah per CHUNK kolom).
function facts(db, table, cols) {
  const out = new Map();
  for (let s = 0; s < cols.length; s += CHUNK) {
    const part = cols.slice(s, s + CHUNK), parts = [];
    part.forEach((c, i) => {
      const q = SQ(c.name);
      parts.push(
        // dibandingkan di dalam SQL: node:sqlite melempar RangeError bila nilai integer >2^53 dibaca sebagai Number
        'MIN(CASE WHEN typeof(' + q + ") = 'integer' THEN " + q + ' END) < ' + INT_MIN + ' AS lo' + i,
        'MAX(CASE WHEN typeof(' + q + ") = 'integer' THEN " + q + ' END) > ' + INT_MAX + ' AS hi' + i,
        'SUM(typeof(' + q + ") NOT IN (" + (c.fam === 'int' ? "'integer'" : "'integer','real'") + ",'null')) AS odd" + i,   // "ganjil" = nilai yang tak cocok dengan keluarga kolom (REAL/NUMERIC boleh berisi integer)
        'SUM(typeof(' + q + ") = 'blob') AS blob" + i,
        'MAX(length(CAST(' + q + ' AS BLOB))) AS by' + i,
        'MAX(length(CASE WHEN typeof(' + q + ") = 'blob' THEN NULL ELSE " + q + ' END)) AS ch' + i,
        (c.ts ? 'MIN(' + q + ' GLOB ' + DT_GLOB + ')' : 'NULL') + ' AS dt' + i);
    });
    const r = db.prepare('SELECT ' + parts.join(', ') + ' FROM ' + SQ(table)).get() || {};
    part.forEach((c, i) => {
      const n = (k) => (r[k + i] == null ? null : Number(r[k + i]));
      out.set(c.name, { wide: n('lo') === 1 || n('hi') === 1, odd: n('odd') || 0, blob: n('blob') || 0, bytes: n('by') || 0, chars: n('ch') || 0, dt: n('dt') === 1 });
    });
  }
  return out;
}

// Kolom yang datanya tidak muat di tipe aslinya: satu pemindaian per tabel (dipecah per CHUNK kolom).
function misfits(db, table, cols) {
  const out = new Set(), typed = cols.filter((c) => c.orig);
  for (let s = 0; s < typed.length; s += CHUNK) {
    const part = typed.slice(s, s + CHUNK);
    const r = db.prepare('SELECT ' + part.map((c, i) => { const v = SQ(c.name); return 'MAX(CASE WHEN ' + v + ' IS NOT NULL AND NOT (' + fitsSql(c.orig, v) + ') THEN 1 ELSE 0 END) AS m' + i; }).join(', ') + ' FROM ' + SQ(table)).get() || {};
    part.forEach((c, i) => { if (Number(r['m' + i]) === 1) out.add(c.name); });
  }
  return out;
}

// Default SQLite → default MySQL, atau null (dibuang) bila tak berlaku di MySQL. `warn` menerima alasan.
function defaultFor(raw, mtype, warn) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (/^NULL$/i.test(v)) return 'NULL';
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return v;
  let m = /^'((?:[^']|'')*)'$/s.exec(v);
  if (m) return str(m[1].replace(/''/g, "'"));
  if (isTs(v)) { const dt = /^(?:datetime|timestamp)(\(\d\))?$/.exec(mtype);
    if (dt) return (v.toUpperCase().startsWith('NOW') ? 'CURRENT_TIMESTAMP' : v) + (dt[1] || ''); warn('DEFAULT ' + v + ' dibuang (kolom bukan datetime)'); return null; }
  warn('DEFAULT ' + v + ' dibuang (ekspresi tidak didukung ekspor)');
  return null;
}

function exportSchema(db) {
  const tables = [], skipped = [];
  const rows = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_new\\_%' ESCAPE '\\' ORDER BY name").all();
  let seqs = new Map();
  try { for (const r of db.prepare('SELECT name, seq FROM sqlite_sequence').all()) seqs.set(String(r.name), Number(r.seq)); } catch (_) { /* tidak ada AUTOINCREMENT sama sekali */ }

  for (const t of rows) {
    const name = String(t.name);
    if (t.type === 'view') { skipped.push({ name, kind: 'view', reason: 'Tampilan (VIEW) tidak diekspor: SQL SQLite tidak bisa diterjemahkan andal ke MySQL.' }); continue; }
    const info = db.prepare('PRAGMA table_info(' + SQ(name) + ')').all();
    if (!info.length) { skipped.push({ name, kind: 'table', reason: 'Tabel tanpa kolom.' }); continue; }
    const ddl = String(t.sql || ''), warnings = [], warn = (c, m) => warnings.push(c ? name + '.' + c + ': ' + m : name + ': ' + m);

    // --- indeks
    const pkCols = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => String(c.name));
    const idx = [];   // { key, unique, ft, cols[] }
    const prefix = name + '__';
    for (const ix of db.prepare('PRAGMA index_list(' + SQ(name) + ')').all()) {
      if (ix.origin === 'pk') continue;
      const cols = db.prepare('PRAGMA index_info(' + SQ(ix.name) + ')').all().sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
      const isql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(ix.name) || {}).sql || '';
      if (cols.some((c) => c == null)) { warn(null, 'indeks ' + ix.name + ' (ekspresi) dilewati'); continue; }
      const ft = !!ix.partial && /\bWHERE\s+0\s*$/i.test(isql);
      if (ix.partial && !ft) { warn(null, 'indeks ' + ix.name + ' (parsial) dilewati'); continue; }
      const key = String(ix.name).startsWith(prefix) ? String(ix.name).slice(prefix.length) : (/^sqlite_autoindex_/.test(ix.name) ? cols.join('_') : String(ix.name));
      idx.push({ key, unique: !!ix.unique && !ft, ft, cols: cols.map(String) });
    }
    const inIndex = new Set(pkCols), inFt = new Set();
    for (const x of idx) for (const c of x.cols) { (x.ft ? inFt : inIndex).add(c); }

    // --- kolom
    const types = columnTypes(ddl);
    const cols = info.map((c) => ({ orig: types.get(String(c.name).toLowerCase()) || null, name: String(c.name), decl: String(c.type || ''), fam: family(c.type), notnull: !!c.notnull || !!c.pk, pk: !!c.pk, dflt: c.dflt_value, ts: isTs(c.dflt_value) }));
    const f = facts(db, name, cols);
    const misfit = misfits(db, name, cols);
    const single = pkCols.length === 1 ? pkCols[0] : null;
    const autoInc = !!single && cols.find((c) => c.name === single).fam === 'int' && f.get(single).odd === 0;

    for (const c of cols) {
      const x = f.get(c.name);
      const nocase = new RegExp(SQ(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^,]*?COLLATE\\s+NOCASE', 'i').test(ddl);
      let type, collate = null, pre = false;
      const indexed = inIndex.has(c.name), ft = inFt.has(c.name);
      // Tipe asli (fase 4) dipakai bila semua datanya masih muat; kalau tidak, jatuh ke tipe turunan dari data di bawah.
      let orig = c.orig;
      if (orig) {
        if (misfit.has(c.name)) { warn(c.name, 'ada data yang tidak muat di tipe asli ' + orig + '; tipe diturunkan dari data'); orig = null; }
      }
      if (orig) {
        const base = baseOf(orig), len = sizeOf(orig) || 0;
        type = orig;
        if (/^((var)?char|(tiny|medium|long)?text|enum|set)$/.test(base)) collate = nocase ? null : 'utf8mb4_bin';
        if (indexed && !ft && (/(text|blob)$/.test(base) || (/char$/.test(base) && len > 768) || (/binary$/.test(base) && len > KEY_BYTES))) { pre = true; warn(c.name, 'kunci indeks dipotong ke awalan ' + PREFIX); }
      }
      else if (c.fam === 'int' && x.odd === 0) type = x.wide ? 'bigint(20)' : 'int(11)';
      else if (c.fam === 'real' && x.odd === 0) type = 'double';
      else if (c.fam === 'num' && x.odd === 0) { const d = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(c.decl); type = d ? 'decimal(' + d[1] + ',' + (d[2] || 0) + ')' : 'decimal(20,6)'; }
      else if (c.fam === 'blob' || x.blob > 0) type = 'longblob';
      else {   // teks, atau kolom numerik yang ternyata menyimpan teks (kolom bercampur → teks)
        if (c.fam !== 'text' && x.odd > 0) warn(c.name, 'kolom ' + c.decl + ' berisi teks; diekspor sebagai teks');
        if (c.ts && x.dt && !ft) type = 'datetime';
        else if (ft) type = x.bytes > 16777215 ? 'longtext' : x.bytes > 65535 ? 'mediumtext' : 'text';
        else if (indexed) { if (x.chars <= PREFIX && x.bytes <= PREFIX * 4) type = 'varchar(' + PREFIX + ')'; else { type = x.bytes > 16777215 ? 'longtext' : x.bytes > 65535 ? 'mediumtext' : 'text'; pre = true; warn(c.name, 'teks >' + PREFIX + ' karakter di indeks: kunci dipotong ke awalan ' + PREFIX); } }
        else if (c.dflt != null && !/^NULL$/i.test(String(c.dflt).trim()) && x.chars <= 255 && x.bytes <= 1020) type = 'varchar(255)';   // MySQL <8.0.13 menolak DEFAULT pada TEXT
        else type = x.bytes > 16777215 ? 'longtext' : x.bytes > 65535 ? 'mediumtext' : 'text';
        if (type !== 'datetime') collate = nocase ? null : 'utf8mb4_bin';
      }
      const head = baseOf(type);
      Object.assign(c, { type, collate, pre, kind: /^(tinyint|smallint|mediumint|int|bigint|bit|float|double|decimal|year)$/.test(head) ? 'num' : /(blob|binary)$/.test(head) ? 'blob' : 'text' });
    }

    // --- baris definisi
    const lines = cols.map((c) => {
      let s = '  ' + Q(c.name) + ' ' + c.type + (c.collate ? ' COLLATE ' + c.collate : '') + (c.notnull ? ' NOT NULL' : '');
      if (autoInc && c.name === single) return s + ' AUTO_INCREMENT';
      const big = /(text|blob)$|^json$/.test(c.type);   // TEXT/BLOB: MySQL lama menolak DEFAULT literal
      let d = null;
      if (big) { if (c.dflt != null && !/^NULL$/i.test(String(c.dflt).trim())) warn(c.name, 'DEFAULT ' + c.dflt + ' dibuang (TEXT/BLOB tak boleh punya default di MySQL lama)'); }
      else d = defaultFor(c.dflt, c.type, (m) => warn(c.name, m));
      if (d !== null && !(d === 'NULL' && c.notnull)) s += ' DEFAULT ' + d;
      else if (d === null && !c.notnull && !big) s += ' DEFAULT NULL';
      return s;
    });
    const col = (n, ft) => { const c = cols.find((x) => x.name === n); return Q(n) + (c.pre && !ft ? '(' + PREFIX + ')' : ''); };
    const width = (n) => { const c = cols.find((x) => x.name === n); return c.pre ? PREFIX * 4 : /char\((\d+)\)/.test(c.type) ? 4 * sizeOf(c.type) : /binary\(/.test(c.type) ? sizeOf(c.type) : /^bigint|^double/.test(c.type) ? 8 : /^(datetime|timestamp)/.test(c.type) ? 5 : /^decimal\((\d+)/.test(c.type) ? Math.ceil(Number(/\((\d+)/.exec(c.type)[1]) / 2) + 1 : 4; };
    const chk = (label, cs) => { const w = cs.reduce((a, n) => a + width(n), 0); if (w > KEY_BYTES) warn(null, label + ' melebihi batas ' + KEY_BYTES + ' byte kunci InnoDB (≈' + w + ')'); };
    if (pkCols.length) { lines.push('  PRIMARY KEY (' + pkCols.map((n) => col(n)).join(',') + ')'); chk('PRIMARY KEY', pkCols); }
    for (const x of idx) {
      lines.push('  ' + (x.ft ? 'FULLTEXT KEY ' : x.unique ? 'UNIQUE KEY ' : 'KEY ') + Q(x.key) + ' (' + x.cols.map((n) => col(n, x.ft)).join(',') + ')');
      if (!x.ft) chk('indeks ' + x.key, x.cols);
    }
    const seq = autoInc ? seqs.get(name) : undefined;
    const sql = 'CREATE TABLE ' + Q(name) + ' (\n' + lines.join(',\n') + '\n) ENGINE=InnoDB' + (seq != null && seq > 0 ? ' AUTO_INCREMENT=' + (seq + 1) : '') + ' DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
    tables.push({ name, sql, autoIncrement: autoInc ? single : null, columns: cols.map((c) => ({ name: c.name, type: c.type, kind: c.kind })), warnings });
  }
  return { tables, skipped };
}

module.exports = { exportSchema, quoteId: Q, mysqlString: str };
