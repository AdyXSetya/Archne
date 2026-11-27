'use strict';
// Fase 4 — tipe MySQL asli (varchar(50), bigint(20) unsigned, datetime, enum(...)) disimpan sebagai komentar di definisi kolom SQLite:
//   "title" TEXT /*my:varchar%2850%29*/ COLLATE NOCASE
// SQLite menyimpan teks DDL apa adanya, jadi penanda ikut bertahan lewat RENAME TABLE/COLUMN, ADD dan DROP COLUMN tanpa tabel tambahan.
// Afinitas SQLite tidak berubah. DECIMAL tidak perlu penanda: tipe deklarasinya sudah DECIMAL(p,s).

const KNOWN = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'bit', 'float', 'double', 'char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext',
  'enum', 'set', 'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'date', 'time', 'datetime', 'timestamp', 'year', 'json']);
const ALIAS = { integer: 'int', real: 'double' };
const quote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";

// Token tipe dari tokenizer mysql2sqlite → teks tipe baku, atau null bila tidak dikenal.
function canonicalType(toks) {
  if (!toks.length) return null;
  let base = String(toks[0].v).toLowerCase(), i = 1;
  if (base === 'bool' || base === 'boolean') return 'tinyint(1)';
  base = ALIAS[base] || base;
  if (!KNOWN.has(base)) return null;
  if (base === 'double' && String(toks[i]?.v).toLowerCase() === 'precision') i++;
  let args = '';
  if (toks[i]?.v === '(') {
    const parts = [];
    for (i++; i < toks.length && toks[i].v !== ')'; i++) if (toks[i].v !== ',') parts.push(toks[i].t === 'str' ? quote(toks[i].v) : String(toks[i].v));
    i++; args = '(' + parts.join(',') + ')';
  }
  const rest = toks.slice(i).map((t) => String(t.v).toLowerCase());
  return base + args + (rest.includes('unsigned') ? ' unsigned' : '') + (rest.includes('zerofill') ? ' zerofill' : '');
}

// Di-encode agar penanda tidak memuat kutip, kurung, koma, spasi, atau "*/" yang bisa mengecoh pembaca DDL.
const marker = (t) => (t ? ' /*my:' + encodeURIComponent(t).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()) + '*/' : '');

// DDL CREATE TABLE tersimpan → Map(nama kolom huruf kecil → tipe MySQL asli).
function columnTypes(ddl) {
  const out = new Map(), s = String(ddl || '');
  const re = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\/\*my:([^*]*)\*\/|\/\*[\s\S]*?\*\/|[(),]|[^'"`\/(),\s]+|\//g;
  let d = 0, name = null, m;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (t === '(') { d++; continue; }
    if (t === ')') { d--; continue; }
    if (t === ',') { if (d === 1) name = null; continue; }
    if (d !== 1) continue;
    if (m[1] !== undefined) { if (name !== null) out.set(name, decodeURIComponent(m[1])); }
    else if (name === null && !t.startsWith('/*')) name = (t[0] === '"' ? t.slice(1, -1).replace(/""/g, '"') : t[0] === '`' ? t.slice(1, -1) : t).toLowerCase();
  }
  return out;
}

function tableTypes(db, table) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return columnTypes(r && r.sql);
}

// Tipe yang ditampilkan ke aplikasi (SHOW COLUMNS, SHOW CREATE TABLE, browser): asli bila ada, selain itu tipe SQLite.
const shownType = (types, col) => types.get(String(col.name).toLowerCase()) ?? (/^DECIMAL\(/i.test(col.type) ? col.type.toLowerCase() : col.type);

const baseOf = (t) => /^[a-z]+/.exec(t)[0];
const sizeOf = (t) => { const m = /^[a-z]+\((\d+)/.exec(t); return m ? Number(m[1]) : null; };
const CAP = { tinytext: 255, text: 65535, mediumtext: 16777215, longtext: 4294967295, tinyblob: 255, blob: 65535, mediumblob: 16777215, longblob: 4294967295 };
const BITS = { tinyint: 8, smallint: 16, mediumint: 24, int: 32 };
const D = '[0-9]', DATE = D.repeat(4) + '-' + D + D + '-' + D + D, TIME = D + D + ':' + D + D + ':' + D + D;

// Syarat SQL (untuk kolom `q`, nilai bukan NULL) agar nilai muat di tipe asli. SQLite tidak menegakkan tipe, jadi ekspor harus memeriksa.
function fitsSql(type, q) {
  const base = baseOf(type), n = sizeOf(type), uns = / unsigned/.test(type), kind = 'typeof(' + q + ')', bytes = 'length(CAST(' + q + ' AS BLOB))';
  const isInt = kind + " = 'integer'", isText = kind + " = 'text'", glob = (g) => q + " GLOB '" + g + "'";
  if (BITS[base]) { const b = BITS[base]; return isInt + ' AND ' + q + ' BETWEEN ' + (uns ? 0 : -(2 ** (b - 1))) + ' AND ' + (uns ? 2 ** b - 1 : 2 ** (b - 1) - 1); }
  switch (base) {
    case 'bigint': return isInt + (uns ? ' AND ' + q + ' >= 0' : '');
    case 'bit': return isInt + ((n || 1) < 53 ? ' AND ' + q + ' BETWEEN 0 AND ' + (2 ** (n || 1) - 1) : '');
    case 'year': return 'CAST(' + q + ' AS TEXT) GLOB ' + "'" + D.repeat(4) + "' OR " + q + ' = 0';
    case 'float': case 'double': return kind + " IN ('integer','real')";
    case 'char': case 'varchar': return isText + ' AND length(' + q + ') <= ' + (n ?? 1);
    case 'binary': case 'varbinary': return kind + " IN ('text','blob') AND " + bytes + ' <= ' + (n ?? 1);
    case 'tinytext': case 'text': case 'mediumtext': case 'longtext': return isText + ' AND ' + bytes + ' <= ' + CAP[base];
    case 'tinyblob': case 'blob': case 'mediumblob': case 'longblob': return kind + " IN ('text','blob') AND " + bytes + ' <= ' + CAP[base];
    case 'date': return glob(DATE);
    case 'datetime': case 'timestamp': return glob(DATE + ' ' + TIME) + ' OR ' + glob(DATE + ' ' + TIME + '.' + D + '*');
    case 'time': return glob('*' + D + D + ':' + D + D + '*');
    case 'enum': return isText + ' AND ' + q + " IN ('', " + (type.match(/'(?:[^']|'')*'/g) || ["''"]).map((v) => v.replace(/\\\\/g, '\\')).join(', ') + ') COLLATE NOCASE';
    case 'json': return 'CASE WHEN ' + isText + ' THEN json_valid(' + q + ') ELSE 0 END';
    default: return isText;   // set
  }
}

module.exports = { canonicalType, marker, columnTypes, tableTypes, shownType, fitsSql, baseOf, sizeOf };
