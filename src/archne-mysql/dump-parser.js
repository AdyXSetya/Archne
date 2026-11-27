'use strict';
// Fase 1a — pemilah dump MySQL (.sql dari phpMyAdmin / mysqldump). MURNI: tanpa SQLite, tanpa I/O, tanpa terjemahan.
// Tugasnya hanya memecah teks dump menjadi pernyataan dan mengelompokkannya:
//   exec     → akan diterjemahkan mysql2sqlite.js lalu dieksekusi (fase 1b)
//   skipped  → dilewati TAPI dilaporkan (trigger, procedure, LOCK TABLES, SET tak dikenal, pernyataan tak dikenal, …)
//   ignored  → dibuang diam-diam (komentar, /*!40101 SET … */, SET NAMES, START TRANSACTION, COMMIT, USE, …)
// Mengerti `DELIMITER` apa pun (;; $$ // …) sehingga isi trigger/procedure tidak membuat pemisahan salah; tiap trigger dilaporkan
// sendiri dengan nama dan nomor barisnya. Nomor baris 1-based, menunjuk huruf pertama pernyataan (komentar di depannya dilewati).
//
// parseDump(teks) → { ok, statements, skipped, tables, warnings, errors, stats }
//   statements: [{ type, sql, line, table?, tables? }]   type ∈ drop_table|drop_view|create_table|create_index|create_view|alter_table|insert
//   skipped:    [{ what, name, line, reason }]
//   tables:     [{ name, action:'drop'|'create' }]       urutan kemunculan, tanpa duplikat
//   errors:     [{ line, message }]                       ok=false bila ada (mis. kutip tak tertutup) → jangan dieksekusi
const ID = '(?:`[^`]+`|"[^"]+"|[\\w$]+)';
const QID = ID + '(?:\\s*\\.\\s*' + ID + ')?';
const HEAD = 1500; // klasifikasi hanya melihat awal pernyataan; INSERT sepanjang megabita tidak disalin/di-regex utuh

const RE = {
  set: /^SET\s+/i,
  txn: /^(?:START\s+TRANSACTION|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i,
  lock: /^(LOCK|UNLOCK)\s+TABLES?\b/i,
  useDb: /^(?:USE\b|CREATE\s+(?:DATABASE|SCHEMA)\b)/i,
  dropDb: /^DROP\s+(?:DATABASE|SCHEMA)\b/i,
  dropTable: /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?/i,
  dropView: /^DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?/i,
  dropRoutine: new RegExp('^DROP\\s+(TRIGGER|PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+EXISTS\\s+)?(' + QID + ')', 'i'),
  createRoutine: new RegExp('^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:AGGREGATE\\s+)?(TRIGGER|PROCEDURE|FUNCTION|EVENT)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(' + QID + ')', 'i'),
  createView: new RegExp('^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\w+\\s+)?(?:SQL\\s+SECURITY\\s+\\w+\\s+)?VIEW\\s+(' + QID + ')', 'i'),
  createTable: new RegExp('^CREATE\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(' + QID + ')', 'i'),
  createIndex: new RegExp('^CREATE\\s+(?:UNIQUE\\s+|FULLTEXT\\s+|SPATIAL\\s+)?INDEX\\s+' + ID + '\\s+(?:USING\\s+\\w+\\s+)?ON\\s+(' + QID + ')', 'i'),
  alter: new RegExp('^ALTER\\s+(?:IGNORE\\s+)?TABLE\\s+(' + QID + ')\\s*([\\s\\S]*)$', 'i'),
  insert: new RegExp('^(?:INSERT|REPLACE)\\s+(?:LOW_PRIORITY\\s+|DELAYED\\s+|HIGH_PRIORITY\\s+)?(?:IGNORE\\s+)?(?:INTO\\s+)?(' + QID + ')', 'i'),
};
// Variabel SET yang tak bermakna di SQLite → dibuang diam-diam. SET lain yang tak dikenal dilaporkan (keputusan #4).
const SET_QUIET = /^(?:(?:@@)?(?:(?:session|global|local|persist)\s*\.\s*)?(?:names|character_set_\w+|collation_\w+|foreign_key_checks|unique_checks|autocommit|sql_mode|time_zone|sql_notes|sql_warnings|sql_safe_updates|sql_log_bin|sql_quote_show_create|sql_require_primary_key|gtid_purged|max_allowed_packet|net_buffer_length|innodb_\w+)\b|names\b|character\s+set\b|transaction\b|@(?:old_|saved_)\w*)/i;
const DEFINER = /\bDEFINER\s*=\s*(?:`[^`]*`|'[^']*'|"[^"]*"|\w+)(?:\s*@\s*(?:`[^`]*`|'[^']*'|"[^"]*"|[\w%.]+))?(?:\s*\(\s*\))?/gi;

// Nama tabel/objek terakhir dari "db.nama" / `db`.`nama`.
function lastId(q) {
  const parts = q.match(new RegExp(ID, 'g')) || [q];
  return parts[parts.length - 1].replace(/^[`"]|[`"]$/g, '');
}

// Lewati spasi + komentar biasa (-- , #, /* */ yang BUKAN /*!…*/) mulai dari q; kembalikan posisi karakter bermakna pertama.
function skipBlank(s, q) {
  const n = s.length;
  for (;;) {
    while (q < n && s.charCodeAt(q) <= 32) q++;
    const c = s[q];
    if (c === '#' || (c === '-' && s[q + 1] === '-' && (q + 2 >= n || /\s/.test(s[q + 2])))) { const e = s.indexOf('\n', q); if (e < 0) return n; q = e + 1; continue; }
    if (c === '/' && s[q + 1] === '*' && s[q + 2] !== '!') { const e = s.indexOf('*/', q + 2); if (e < 0) return n; q = e + 2; continue; }
    return q;
  }
}

// Akhir literal berkutip yang dimulai di p (src[p] = kutip); kembalikan indeks SETELAH kutip penutup, atau -1 bila tak tertutup.
// Tanpa regex berulang: dump berisi string megabita, regex `(?:[^'\\]|\\.|'')*` bisa meluap tumpukan.
function skipQuoted(s, p) {
  const q = s[p], bs = q !== '`'; let i = p + 1, nq = -2, nb = -2;
  for (;;) {
    if (nq < i) { nq = s.indexOf(q, i); if (nq < 0) return -1; }
    if (bs && nb < i) { nb = s.indexOf('\\', i); if (nb < 0) nb = Infinity; }
    if (bs && nb < nq) { i = nb + 2; continue; }
    if (s[nq + 1] === q) { i = nq + 2; continue; }   // '' / "" / `` = kutip yang di-escape
    return nq + 1;
  }
}

function parseDump(input) {
  let src = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const n = src.length;
  const out = { ok: true, statements: [], skipped: [], tables: [], warnings: [], errors: [], stats: { bytes: n, lines: 0, statements: 0, exec: 0, skipped: 0, ignored: 0 } };
  const seenTbl = new Set(); let decimal = false;

  // nomor baris, menaik monoton (pernyataan dipanggil berurutan)
  let lnPos = 0, lnCount = 1;
  const lineAt = (pos) => { for (;;) { const e = src.indexOf('\n', lnPos); if (e < 0 || e >= pos) break; lnCount++; lnPos = e + 1; } return lnCount; };

  const addTable = (name, action) => { const k = action + '\0' + name; if (seenTbl.has(k)) return; seenTbl.add(k); out.tables.push({ name, action }); };
  const skip = (what, name, line, reason) => { out.skipped.push({ what, name: name || null, line, reason: reason || null }); out.stats.skipped++; };
  const quiet = () => { out.stats.ignored++; };

  function classify(sql, line) {
    // Bentuk klasifikasi: komentar biasa dibuang, pembungkus /*!NNNNN … */ dibuka, DEFINER=… dibuang, spasi dipadatkan.
    const cls = sql.slice(0, HEAD).replace(/\/\*(?!!)[\s\S]*?\*\//g, ' ').replace(/\/\*!\d*/g, ' ').replace(/\*\//g, ' ')
      .replace(DEFINER, ' ').replace(/\s+/g, ' ').trim();
    if (!cls) return quiet();
    let m;
    if (RE.set.test(cls)) {
      const rest = cls.replace(RE.set, '').replace(/^(?:GLOBAL|SESSION|LOCAL|PERSIST)\s+/i, '');
      return SET_QUIET.test(rest) ? quiet() : skip('SET', rest.split(/[\s=]/)[0], line, 'SET tidak dikenali');
    }
    if (RE.txn.test(cls)) return quiet();
    if ((m = RE.lock.exec(cls))) return skip(m[1].toUpperCase() + ' TABLES', null, line);
    if (RE.useDb.test(cls)) return quiet();
    if (RE.dropDb.test(cls)) return skip('DROP DATABASE', null, line, 'satu situs = satu database');
    if ((m = RE.dropRoutine.exec(cls))) return skip('DROP ' + m[1].toUpperCase(), lastId(m[2]), line);
    if ((m = RE.createRoutine.exec(cls))) return skip('CREATE ' + m[1].toUpperCase(), lastId(m[2]), line);
    if ((m = RE.dropTable.exec(cls))) {
      const names = (cls.slice(m[0].length).replace(/\b(?:RESTRICT|CASCADE)\b.*$/i, '').match(new RegExp(QID, 'g')) || []).map(lastId);
      if (!names.length) return skip('DROP TABLE', null, line, 'nama tabel tidak terbaca');
      for (const t of names) addTable(t, 'drop');
      return exec('drop_table', sql, line, names[0], names);
    }
    if (RE.dropView.test(cls)) { const names = (cls.replace(RE.dropView, '').match(new RegExp(QID, 'g')) || []).map(lastId); return exec('drop_view', sql, line, names[0], names); }
    if ((m = RE.createView.exec(cls))) {
      // ALGORITHM= / DEFINER= / SQL SECURITY pada tampilan tidak bermakna di SQLite → dibuang dari teks yang dieksekusi.
      const clean = sql.replace(/\/\*!\d*\s*/g, ' ').replace(/\*\//g, ' ').replace(DEFINER, ' ')
        .replace(/\bALGORITHM\s*=\s*\w+/i, ' ').replace(/\bSQL\s+SECURITY\s+\w+/i, ' ').replace(/^\s+/, '');
      return exec('create_view', clean, line, lastId(m[1]));
    }
    if ((m = RE.createTable.exec(cls))) { const t = lastId(m[1]); addTable(t, 'create'); if (/\b(?:DECIMAL|NUMERIC)\b/i.test(sql)) decimal = true; return exec('create_table', sql, line, t); }
    if ((m = RE.createIndex.exec(cls))) return exec('create_index', sql, line, lastId(m[1]));
    if ((m = RE.alter.exec(cls))) {
      if (/^(?:DISABLE|ENABLE)\s+KEYS\s*$/i.test(m[2].trim())) return quiet();   // /*!40000 ALTER TABLE x DISABLE KEYS */ — hanya optimasi MySQL
      return exec('alter_table', sql, line, lastId(m[1]));
    }
    if ((m = RE.insert.exec(cls))) return exec('insert', sql, line, lastId(m[1]));
    skip((cls.match(/^\w+/) || [cls.slice(0, 20)])[0].toUpperCase(), null, line, 'pernyataan tidak dikenali');
  }
  function exec(type, sql, line, table, tables) {
    // pernyataan yang dibungkus /*!NNNNN … */ (jarang) dibuka dulu supaya penerjemah tidak melihatnya sebagai komentar
    if (sql.startsWith('/*!')) sql = sql.replace(/^\/\*!\d*\s*/, '').replace(/\*\/\s*$/, '');
    const st = { type, sql, line, table: table || null }; if (tables && tables.length > 1) st.tables = tables;
    out.statements.push(st); out.stats.exec++;
  }
  function handle(raw, absStart) {
    out.stats.statements++;
    const off = skipBlank(raw, 0);
    if (off >= raw.length) return quiet();                 // hanya komentar / kosong
    classify(raw.slice(off).trimEnd(), lineAt(absStart + off));
  }

  // ---- pemindai utama ----
  let delim = ';', start = 0, i = 0, re;
  const mkRe = () => { re = new RegExp('[\'"`#/\\-' + delim[0].replace(/[\]\\^-]/g, '\\$&') + ']', 'g'); };
  const DELIM_RE = /DELIMITER[ \t]+(\S+)[^\n]*/iy;
  mkRe();
  // `DELIMITER x` hanya dikenali di awal pernyataan (setelah spasi/komentar), seperti klien mysql.
  const readDelimiters = () => {
    for (;;) {
      const q = skipBlank(src, start); DELIM_RE.lastIndex = q;
      const m = q < n ? DELIM_RE.exec(src) : null;
      if (!m) return;
      delim = m[1]; start = i = q + m[0].length; mkRe(); quiet();
    }
  };
  readDelimiters();
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(src); if (!m) break;
    const p = m.index, c = src[p];
    if (src.startsWith(delim, p)) { handle(src.slice(start, p), start); start = i = p + delim.length; readDelimiters(); continue; }
    if (c === "'" || c === '"' || c === '`') {
      const e = skipQuoted(src, p);
      if (e < 0) { out.errors.push({ line: lineAt(p), message: 'literal berkutip (' + c + ') tidak tertutup' }); start = i = n; break; }
      i = e; continue;
    }
    if (c === '#' || (c === '-' && src[p + 1] === '-' && (p + 2 >= n || /\s/.test(src[p + 2])))) { const e = src.indexOf('\n', p); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && src[p + 1] === '*') { const e = src.indexOf('*/', p + 2); i = e < 0 ? n : e + 2; continue; }
    i = p + 1;
  }
  if (start < n) handle(src.slice(start), start);          // pernyataan terakhir tanpa pemisah
  if (decimal) out.warnings.push('DECIMAL/NUMERIC dipetakan ke REAL — cocok untuk data non-keuangan.');
  out.stats.lines = lineAt(n);
  out.ok = out.errors.length === 0;
  return out;
}

// Bentuk untuk renderer (spek 1.6): { tables:[{name,action}], skippable:['CREATE TRIGGER x (baris 142)', …] }
function summarizeSkipped(skipped, maxLines = 5) {
  const g = new Map();
  for (const s of skipped) { const k = s.what + '\0' + (s.name || ''); if (!g.has(k)) g.set(k, { s, lines: [] }); g.get(k).lines.push(s.line); }
  return [...g.values()].map(({ s, lines }) => {
    const nm = s.name ? ' ' + s.name : '', ln = lines.slice(0, maxLines).join(', ') + (lines.length > maxLines ? ', …' : '');
    return s.what + nm + (lines.length > 1 ? ' ×' + lines.length : '') + ' (baris ' + ln + ')';
  });
}
function toPreview(parsed) { return { tables: parsed.tables, skippable: summarizeSkipped(parsed.skipped), warnings: parsed.warnings, errors: parsed.errors }; }

module.exports = { parseDump, summarizeSkipped, toPreview };
