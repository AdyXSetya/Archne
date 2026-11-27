'use strict';
// P.9 langkah 3: engine.js — mengeksekusi hasil terjemahan mysql2sqlite terhadap node:sqlite.
// Dipanggil oleh fakemysql.js (lapisan protokol MySQL wire).
const { translate, splitStatements, SqlError } = require('./mysql2sqlite.js');
const Q = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const dfltSql = (v) => /^(-?\d+(\.\d+)?|'([^']|'')*'|NULL|CURRENT_(TIMESTAMP|DATE|TIME)|TRUE|FALSE)$/i.test(String(v).trim()) ? String(v).trim() : '(' + v + ')';
const { DatabaseSync } = require('node:sqlite');
const { applyDecimals } = require('./decimal.js');
const { columnTypes, tableTypes, shownType, marker, baseOf, sizeOf } = require('./mytypes.js');

// tipe kolom SQLite → kode tipe MySQL wire
const typeCode = (v) =>
  typeof v === 'number' ? (Number.isInteger(v) ? 0x08 : 0x05) :
  typeof v === 'bigint' ? 0x08 :
  (Buffer.isBuffer(v) || v instanceof Uint8Array) ? 0xfc : 0xfd;

// Ambil semua baris sebagai array. Integer dibaca sebagai BigInt lalu dikembalikan ke Number bila aman: tanpa ini node:sqlite
// melempar RangeError untuk bigint di atas 2^53.
function allRows(st, params = []) {
  st.setReturnArrays(true); st.setReadBigInts(true);
  const rows = st.all(...params);
  for (const r of rows) for (let i = 0; i < r.length; i++) if (typeof r[i] === 'bigint' && r[i] >= -9007199254740991n && r[i] <= 9007199254740991n) r[i] = Number(r[i]);
  return rows;
}

// Potong LIMIT/OFFSET tingkat atas dari SELECT hasil terjemahan (untuk FOUND_ROWS). null = tidak ada LIMIT tingkat atas.
function stripTopLimit(sql) {
  let d = 0, pos = -1;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < sql.length) { if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } break; } i++; } continue; }
    if (c === '(') d++; else if (c === ')') d--;
    else if (d === 0 && (c === 'L' || c === 'l') && /^limit\b/i.test(sql.slice(i, i + 6)) && (i === 0 || /[\s)]/.test(sql[i - 1]))) pos = i;
  }
  return pos < 0 ? null : sql.slice(0, pos).replace(/[\s;]+$/, '');
}

class Engine {
  constructor({ file = ':memory:', ftStrict = true, busyTimeout = 5000, txMode = 'deferred' } = {}) {
    this._txMode = txMode;               // 'immediate': BEGIN langsung mengambil kunci tulis (tak ada konflik snapshot 1213, transaksi diserialkan); 'deferred': kunci diambil saat tulis pertama
    this._ftStrict = ftStrict;           // MATCH tanpa FULLTEXT KEY yang cocok → galat 1191 seperti MySQL
    this._epoch = 0; this._ftCache = new Map(); this._ftCur = new Map();   // statistik korpus FULLTEXT (6c-8)
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=' + (busyTimeout | 0) + ';');   // beberapa Engine dapat berbagi satu file (satu per koneksi MySQL): busy_timeout = menunggu kunci tulis seperti innodb_lock_wait_timeout
    this._stmts = new Map();
    this._nextStmt = 1;
    this._inTx = false;
    this._sps = [];   // nama savepoint aktif (huruf kecil), urutan pembuatan: meniru aturan MySQL (nama sama menggantikan yang lama)
    this._initInfoSchema();
    this._initFuncs();
    this._lastId = 0; this._rc = -1;
  }

  // ------------------------------------------------------------------ fungsi MySQL sederhana (UDF)
  _initFuncs() {
    const crypto = require('node:crypto'), d = this.db;
    const hash = (alg) => (v) => v == null ? null : crypto.createHash(alg).update(String(v)).digest('hex');
    d.function('LAST_INSERT_ID', () => this._lastId);
    d.function('ROW_COUNT', () => this._rc);
    d.function('CHAR_LENGTH', (s) => s == null ? null : [...String(s)].length);
    d.function('CHARACTER_LENGTH', (s) => s == null ? null : [...String(s)].length);
    d.function('MD5', hash('md5'));
    d.function('SHA1', hash('sha1'));
    d.function('SHA', hash('sha1'));
    d.function('RAND', () => Math.random());
    // sesi dianggap UTC (time_zone +00:00)
    const pad = (x) => String(x).padStart(2, '0');
    d.function('UNIX_TIMESTAMP', { varargs: true }, (...a) => {
      if (!a.length) return Math.floor(Date.now() / 1000);
      if (a[0] == null) return null; if (typeof a[0] === 'number') return Math.floor(a[0]);
      const ms = Date.parse(String(a[0]).trim().replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(a[0]).trim()) ? '' : 'Z'));
      return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
    });
    d.function('FROM_UNIXTIME', (n) => { if (n == null) return null; const x = new Date(Number(n) * 1000); return Number.isNaN(x.getTime()) ? null : x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate()) + ' ' + pad(x.getUTCHours()) + ':' + pad(x.getUTCMinutes()) + ':' + pad(x.getUTCSeconds()); });
    d.function('CONNECTION_ID', () => 1);
    d.function('USER', () => 'root@localhost');
    d.function('CURRENT_USER', () => 'root@localhost');
    d.function('SESSION_USER', () => 'root@localhost');
    d.function('SYSTEM_USER', () => 'root@localhost');
    require('./funcs.js').install(d);
    this._vars = new Map();   // variabel sesi @nama (huruf kecil)
    d.function('__getvar', (n) => this._vars.has(n) ? this._vars.get(n) : null);
    d.function('__setvar', (n, v) => { this._vars.set(n, v); return v; });
    const ft = require('./ft.js');   // MATCH ... AGAINST (6c-7): __ft_match(label, mode, query, kolom...)
    d.function('__ft_match', { varargs: true }, (label, mode, key, q, ...cols) => ft.match(mode, q, cols, key ? this._ftCur.get(key) : undefined));
    // `x REGEXP y` dipanggil SQLite sebagai regexp(y, x); MySQL tidak membedakan huruf besar/kecil
    d.function('regexp', (pat, v) => { if (pat == null || v == null) return null; try { return new RegExp(String(pat), 'i').test(String(v)) ? 1 : 0; } catch (_) { throw new SqlError(3692, '42000', 'Regular expression error'); } });
  }

  // ------------------------------------------------------------------ pernyataan administratif / DDL tambahan (tanpa penerjemah)
  _special(raw) {
    const ok = { type: 'ok', changes: 0, lastId: 0 };
    if (/^(LOCK\s+TABLES?|UNLOCK\s+TABLES?|FLUSH\b|KILL\b|DO\b|RESET\b|(CREATE|DROP)\s+(DATABASE|SCHEMA)\b)/i.test(raw)) return ok;
    let m;
    if ((m = /^(OPTIMIZE|ANALYZE|CHECK|REPAIR)\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?TABLES?\s+(.+)$/is.exec(raw))) {
      const op = m[1].toLowerCase();
      const rows = m[2].split(',').map(t => t.trim().replace(/^`|`$/g, '').replace(/^.*`\.`/, '').replace(/^.*\./, '').replace(/`/g, '')).filter(Boolean)
        .map(t => { this._tableInfo(t); return ['archne.' + t, op, op === 'optimize' ? 'note' : 'status', op === 'optimize' ? 'Table does not support optimize, doing recreate + analyze instead' : 'OK']; });
      return { type: 'rows', cols: ['Table', 'Op', 'Msg_type', 'Msg_text'].map(name => ({ name })), rows };
    }
    if ((m = /^RENAME\s+TABLE\s+(.+)$/is.exec(raw))) {
      const pairs = m[1].split(',').map(x => x.trim().split(/\s+TO\s+/i).map(n => n.trim().replace(/^.*`\.`|^.*\./, '').replace(/`/g, '')));
      this.db.exec('SAVEPOINT archne_rn');
      try { for (const [a, b] of pairs) { if (!b) throw new SqlError(1064, '42000', 'You have an error in your SQL syntax near RENAME TABLE'); this._tableInfo(a); this._renameTable(a, b); } this.db.exec('RELEASE archne_rn'); }
      catch (e) { try { this.db.exec('ROLLBACK TO archne_rn; RELEASE archne_rn'); } catch (_) {} throw e; }
      return ok;
    }
    if ((m = /^DROP\s+(?:TEMPORARY\s+)?TABLE\s+(IF\s+EXISTS\s+)?(.+?)(?:\s+(?:RESTRICT|CASCADE))?$/is.exec(raw))) {
      const ie = m[1] ? 'IF EXISTS ' : '';
      const names = m[2].split(',').map(x => x.trim().replace(/^.*`\.`|^.*\./, '').replace(/`/g, '')).filter(Boolean);
      if (names.length === 1 && raw === 'DROP TABLE ' + ie + m[2]) return null;   // bentuk biasa: biarkan jalur normal (hindari rekursi)
      for (const t of names) this._query('DROP TABLE ' + ie + Q(t));
      return ok;
    }
    if ((m = /^DROP\s+INDEX\s+(`[^`]+`|\w+)\s+ON\s+(`[^`]+`|[\w.]+)/i.exec(raw))) { this._query('ALTER TABLE ' + m[2] + ' DROP INDEX ' + m[1]); return ok; }
    return null;
  }
  _renameTable(a, b) {   // indeks internal bernama `tabel__nama` ikut dinamai ulang
    const idx = this.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE ? ESCAPE '\\' AND sql IS NOT NULL").all(a, a.replace(/[%_\\]/g, '\\$&') + '\\_\\_%');
    this.db.exec('ALTER TABLE ' + Q(a) + ' RENAME TO ' + Q(b));
    for (const ix of idx) {
      const nn = b + '__' + ix.name.slice(a.length + 2);
      const sql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(ix.name).sql;
      this.db.exec('DROP INDEX ' + Q(ix.name));
      this.db.exec(sql.replace(/^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)("(?:[^"]|"")*"|\S+)/i, (_, h) => h + Q(nn)));
    }
  }

  // ------------------------------------------------------------------ information_schema (TABLES/COLUMNS/STATISTICS)
  _initInfoSchema() {
    this.db.function('DATABASE', () => 'archne');
    this.db.function('SCHEMA', () => 'archne');
    this.db.exec("ATTACH ':memory:' AS information_schema");
    this.db.exec(`
      CREATE TABLE information_schema.TABLES (TABLE_CATALOG TEXT, TABLE_SCHEMA TEXT, TABLE_NAME TEXT, TABLE_TYPE TEXT, ENGINE TEXT, VERSION INT, ROW_FORMAT TEXT, TABLE_ROWS INT, AVG_ROW_LENGTH INT, DATA_LENGTH INT, MAX_DATA_LENGTH INT, INDEX_LENGTH INT, DATA_FREE INT, AUTO_INCREMENT INT, CREATE_TIME TEXT, UPDATE_TIME TEXT, CHECK_TIME TEXT, TABLE_COLLATION TEXT, CHECKSUM INT, CREATE_OPTIONS TEXT, TABLE_COMMENT TEXT);
      CREATE TABLE information_schema.COLUMNS (TABLE_CATALOG TEXT, TABLE_SCHEMA TEXT, TABLE_NAME TEXT, COLUMN_NAME TEXT, ORDINAL_POSITION INT, COLUMN_DEFAULT TEXT, IS_NULLABLE TEXT, DATA_TYPE TEXT, CHARACTER_MAXIMUM_LENGTH INT, COLUMN_TYPE TEXT, COLUMN_KEY TEXT, EXTRA TEXT, COLUMN_COMMENT TEXT);
      CREATE TABLE information_schema.STATISTICS (TABLE_CATALOG TEXT, TABLE_SCHEMA TEXT, TABLE_NAME TEXT, NON_UNIQUE INT, INDEX_SCHEMA TEXT, INDEX_NAME TEXT, SEQ_IN_INDEX INT, COLUMN_NAME TEXT, NULLABLE TEXT, INDEX_TYPE TEXT);
      CREATE TABLE information_schema.SCHEMATA (CATALOG_NAME TEXT, SCHEMA_NAME TEXT, DEFAULT_CHARACTER_SET_NAME TEXT, DEFAULT_COLLATION_NAME TEXT);
    `);
  }
  _refreshInfoSchema() {
    const d = this.db, I = 'information_schema.';
    for (const t of ['TABLES', 'COLUMNS', 'STATISTICS', 'SCHEMATA']) d.exec('DELETE FROM ' + I + t);
    d.exec("INSERT INTO information_schema.SCHEMATA VALUES ('def','archne','utf8mb4','utf8mb4_general_ci')");
    const insT = d.prepare('INSERT INTO ' + I + "TABLES (TABLE_CATALOG,TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE,ENGINE,VERSION,ROW_FORMAT,TABLE_ROWS,AVG_ROW_LENGTH,DATA_LENGTH,MAX_DATA_LENGTH,INDEX_LENGTH,DATA_FREE,AUTO_INCREMENT,TABLE_COLLATION,TABLE_COMMENT) VALUES ('def','archne',?,'BASE TABLE','InnoDB',10,'Dynamic',?,100,?,0,16384,0,?,'utf8mb4_general_ci','')");   // ukuran = perkiraan (halaman 16 KB per ±150 baris), bukan ukuran berkas
    const insC = d.prepare('INSERT INTO ' + I + "COLUMNS VALUES ('def','archne',?,?,?,?,?,?,?,?,?,?,'')");
    const insS = d.prepare('INSERT INTO ' + I + "STATISTICS VALUES ('def','archne',?,?,'archne',?,?,?,?,?)");
    const tabs = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_new\\_%' ESCAPE '\\' ORDER BY name").all();
    for (const { name } of tabs) {
      const info = d.prepare('PRAGMA table_info(' + Q(name) + ')').all();
      const idx = this._idxList(name, info);
      const keys = this._colKeys(info, idx);
      let rows = 0, ai = null;
      try { rows = Number(d.prepare('SELECT COUNT(*) AS n FROM ' + Q(name)).get().n); } catch (_) {}
      const pk = info.filter(x => x.pk);
      if (pk.length === 1 && /^int/i.test(pk[0].type)) { try { const m = d.prepare('SELECT MAX(' + Q(pk[0].name) + ') AS m FROM ' + Q(name)).get().m; ai = Number(m || 0) + 1; } catch (_) {} }
      insT.run(name, rows, 16384 * Math.max(1, Math.ceil(rows / 150)), ai);
      const types = tableTypes(d, name);
      info.forEach((x, i) => {
        let t = (x.type || 'text').toLowerCase(); if (t === 'integer') t = 'int';
        const isAi = pk.length === 1 && x.pk && /^int/.test(t);
        const my = types.get(x.name.toLowerCase()); if (my) t = my;
        insC.run(name, x.name, i + 1, x.dflt_value == null ? null : String(x.dflt_value).replace(/^'(.*)'$/s, '$1'), (x.notnull || x.pk) ? 'NO' : 'YES', t.replace(/[( ].*$/, ''), my && /^(var)?char/.test(my) ? (sizeOf(my) ?? 1) : /^(text|char|varchar)/.test(t) ? 65535 : null, t, keys[x.name] || '', isAi ? 'auto_increment' : '');
      });
      for (const ix of idx) ix.cols.forEach((cn, i) => insS.run(name, ix.unique ? 0 : 1, ix.key, i + 1, cn, (info.find(x => x.name === cn) || {}).notnull || ix.key === 'PRIMARY' ? '' : 'YES', ix.ft ? 'FULLTEXT' : 'BTREE'));
    }
  }
  _colKeys(info, idx) {   // kolom → PRI / UNI / MUL (aturan MySQL: berdasarkan kolom pertama indeks)
    const k = {};
    for (const ix of idx) {
      const first = ix.cols[0];
      if (ix.key === 'PRIMARY') { ix.cols.forEach(cn => { k[cn] = 'PRI'; }); continue; }
      if (k[first] === 'PRI') continue;
      if (ix.unique && ix.cols.length === 1) k[first] = 'UNI';
      else if (k[first] !== 'UNI') k[first] = 'MUL';
    }
    return k;
  }

  // ------------------------------------------------------------------ query teks
  _deleteMulti(targets, rest) {
    // pisahkan di tingkat atas (di luar kutip dan kurung): bagian tabel = sebelum WHERE
    let d = 0, q = null, wi = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(') d++; else if (c === ')') d--;
      else if (d === 0 && /^WHERE\b/i.test(rest.slice(i)) && (i === 0 || /\s|\)/.test(rest[i - 1]))) { wi = i; break; }
    }
    const from = rest.slice(0, wi);
    const pieces = []; { let cur = '', dd = 0, qq = null;
      for (let i = 0; i < from.length; i++) {
        const c = from[i];
        if (qq) { cur += c; if (c === qq) qq = null; continue; }
        if (c === "'" || c === '"' || c === '`') { qq = c; cur += c; continue; }
        if (c === '(') dd++; else if (c === ')') dd--;
        if (dd === 0 && c === ',') { pieces.push(cur); cur = ''; continue; }
        const m = dd === 0 ? /^(?:(?:INNER|LEFT|RIGHT|CROSS|NATURAL)\s+(?:OUTER\s+)?)?JOIN\b/i.exec(from.slice(i)) : null;
        if (m && (i === 0 || /\s|\)/.test(from[i - 1]))) { pieces.push(cur); cur = ''; i += m[0].length - 1; continue; }
        cur += c;
      }
      pieces.push(cur); }
    const KW = /^(ON|USING|WHERE|INNER|LEFT|RIGHT|CROSS|JOIN|NATURAL|AS)$/i, map = new Map();
    for (const pc of pieces) {
      const m = /^\s*`?(\w+)`?(?:\s+(?:AS\s+)?`?(\w+)`?)?\s*(?:ON\b[\s\S]*|USING\b[\s\S]*)?$/i.exec(pc);
      if (!m) throw new SqlError(1064, '42000', 'DELETE multi-tabel: bentuk FROM belum didukung oleh shim');
      const alias = m[2] && !KW.test(m[2]) ? m[2] : m[1];
      map.set(alias.toLowerCase(), m[1]);
    }
    const ids = new Map(); // tabel -> Set rowid (self-join: dua alias, satu tabel)
    const sels = [];
    for (let t of targets.split(',')) {
      t = t.trim().replace(/`/g, '');
      const tbl = map.get(t.toLowerCase()); if (!tbl) throw new SqlError(1109, '42S02', "Unknown table '" + t + "' in MULTI DELETE");
      sels.push([t, tbl]);
    }
    for (const [alias, tbl] of sels) {
      const r = this._query('SELECT `' + alias + '`.rowid FROM ' + rest);
      const set = ids.get(tbl) || ids.set(tbl, new Set()).get(tbl);
      for (const row of r.rows || []) set.add(Number(row[0]));
    }
    let changes = 0;
    for (const [tbl, set] of ids) {
      const all = [...set];
      for (let i = 0; i < all.length; i += 500) changes += this._query('DELETE FROM `' + tbl + '` WHERE rowid IN (' + all.slice(i, i + 500).join(',') + ')').changes || 0;
    }
    return { type: 'ok', changes, lastId: 0 };
  }
  query(sql) {
    const r = this._query(sql);
    if (r.type === 'ok') { if (r.lastId) this._lastId = r.lastId; this._rc = r.changes; } else this._rc = -1;
    return r;
  }
  _query(sql) {
    let raw = sql.trim().replace(/;+\s*$/, '');
    if (/^(CREATE|DROP|ALTER|RENAME|TRUNCATE)\b/i.test(raw)) this._epoch++;   // skema berubah → statistik FULLTEXT usang
    const sp = this._special(raw); if (sp) return sp;
    raw = raw.replace(/^DESC\s+(?=[`\w])/i, 'DESCRIBE ').replace(/\s+FOR\s+UPDATE(\s+(NOWAIT|SKIP\s+LOCKED))?\s*$/i, '').replace(/\s+LOCK\s+IN\s+SHARE\s+MODE\s*$/i, '').replace(/\bFROM\s+DUAL\b/i, '');

    // SHOW TABLE STATUS [FROM db] [LIKE 'p' | WHERE ...] -> information_schema.TABLES dengan nama kolom MySQL (WordPress, phpMyAdmin)
    { const ts = /^SHOW\s+(?:FULL\s+)?TABLE\s+STATUS(?:\s+(?:FROM|IN)\s+`?\w+`?)?(?:\s+LIKE\s+('(?:[^'\\]|\\.|'')*'))?(?:\s+WHERE\s+([\s\S]+))?$/i.exec(raw);
      if (ts) raw = 'SELECT TABLE_NAME AS `Name`, ENGINE AS `Engine`, VERSION AS `Version`, ROW_FORMAT AS `Row_format`, TABLE_ROWS AS `Rows`, AVG_ROW_LENGTH AS `Avg_row_length`, DATA_LENGTH AS `Data_length`, MAX_DATA_LENGTH AS `Max_data_length`, INDEX_LENGTH AS `Index_length`, DATA_FREE AS `Data_free`, AUTO_INCREMENT AS `Auto_increment`, CREATE_TIME AS `Create_time`, UPDATE_TIME AS `Update_time`, CHECK_TIME AS `Check_time`, TABLE_COLLATION AS `Collation`, CHECKSUM AS `Checksum`, CREATE_OPTIONS AS `Create_options`, TABLE_COMMENT AS `Comment` FROM information_schema.TABLES WHERE TABLE_SCHEMA = \'archne\'' + (ts[1] ? ' AND TABLE_NAME LIKE ' + ts[1] : '') + (ts[2] ? ' AND (' + ts[2] + ')' : '') + ' ORDER BY TABLE_NAME'; }

    // passthrough cepat tanpa terjemahan
    if (/^(SET|USE)\b/i.test(raw) && !/^SET\s+@(?!@)/i.test(raw)) return { type: 'ok', changes: 0, lastId: 0 };

    // DELETE a, b FROM t1 a JOIN t2 b ON ... WHERE ... (WordPress: hapus transient kedaluwarsa). SQLite tak punya; kumpulkan rowid dulu, baru hapus.
    const md = /^DELETE\s+(?!FROM\b)((?:`?\w+`?\s*,\s*)*`?\w+`?)\s+FROM\s+([\s\S]+)$/i.exec(raw);
    if (md) return this._deleteMulti(md[1], md[2]);

    if (/^(START\s+TRANSACTION|BEGIN)\b/i.test(raw)) {
      // START TRANSACTION READ ONLY tidak menulis → selalu deferred (tidak mengambil kunci tulis)
      if (!this._inTx) this.db.exec(this._txMode === 'immediate' && !/^START\s+TRANSACTION\s+READ\s+ONLY\b/i.test(raw) ? 'BEGIN IMMEDIATE' : 'BEGIN');
      this._inTx = true;
      return { type: 'ok', changes: 0, lastId: 0 };
    }
    if (/^(COMMIT)\b/i.test(raw)) {
      if (this._inTx) this.db.exec('COMMIT');
      this._inTx = false; this._sps = [];
      return { type: 'ok', changes: 0, lastId: 0 };
    }
    const spName = (str) => { const q = /^(?:ROLLBACK\s+(?:WORK\s+)?TO|RELEASE|SAVEPOINT)\s+(?:SAVEPOINT\s+)?(?:`((?:[^`]|``)+)`|"([^"]+)"|(\w+))\s*$/i.exec(str); return q ? (q[1] || q[2] || q[3]).replace(/``/g, '`').toLowerCase() : null; };
    if (/^SAVEPOINT\s/i.test(raw)) {   // SAVEPOINT x: bila nama sudah ada, yang lama dihapus (MySQL); SQLite menumpuknya
      const nm = spName(raw);
      this.db.exec(raw);
      if (nm !== null) { this._sps = this._sps.filter((x) => x !== nm); this._sps.push(nm); }
      return { type: 'ok', changes: 0, lastId: 0 };
    }
    if (/^RELEASE\s+SAVEPOINT\s/i.test(raw)) {
      const nm = spName(raw);
      if (nm !== null && !this._sps.includes(nm)) throw new Error('no such savepoint: ' + nm);
      this.db.exec(raw);
      if (nm !== null) this._sps.length = this._sps.indexOf(nm);   // SQLite melepas yang terbaru bernama itu beserta yang lebih baru
      return { type: 'ok', changes: 0, lastId: 0 };
    }
    if (/^ROLLBACK\s+(WORK\s+)?TO\b/i.test(raw)) {   // ROLLBACK TO [SAVEPOINT] x: hanya sampai savepoint, transaksi tetap hidup
      const nm = spName(raw);
      if (nm !== null && !this._sps.includes(nm)) throw new Error('no such savepoint: ' + nm);
      this.db.exec(raw.replace(/^ROLLBACK\s+(WORK\s+)?TO\s+(SAVEPOINT\s+)?/i, 'ROLLBACK TO ')); this._epoch++;
      if (nm !== null) this._sps.length = this._sps.indexOf(nm) + 1;
      return { type: 'ok', changes: 0, lastId: 0 };
    }
    if (/^(ROLLBACK)\b/i.test(raw)) {
      if (this._inTx) this.db.exec('ROLLBACK');
      this._inTx = false; this._epoch++; this._sps = [];
      return { type: 'ok', changes: 0, lastId: 0 };
    }

    // SELECT @@var
    let m;
    if ((m = /^SELECT\s+@@(\w+)/i.exec(raw))) {
      const k = m[1].toLowerCase();
      const val = k === 'version' ? '8.0.36-archne-sqlite' :
                  k === 'autocommit' ? '1' :
                  k === 'max_allowed_packet' ? '67108864' : '';
      return { type: 'rows', cols: [{ name: '@@' + m[1] }], rows: [[val]] };
    }
    if (/^SELECT\s+DATABASE\(\)/i.test(raw)) return { type: 'rows', cols: [{ name: 'DATABASE()' }], rows: [['archne']] };
    if (/^SELECT\s+VERSION\(\)/i.test(raw)) return { type: 'rows', cols: [{ name: 'VERSION()' }], rows: [['8.0.36-archne-sqlite']] };
    if (/^SELECT\s+FOUND_ROWS\(\)/i.test(raw)) return { type: 'rows', cols: [{ name: 'FOUND_ROWS()' }], rows: [[String(this._found || 0)]] };

    if (/information_schema/i.test(raw)) this._refreshInfoSchema();
    const tr = translate(raw);
    if (tr.pre) for (const x of tr.pre) this.db.exec(x);   // inisialisasi variabel sesi
    if (tr.ft) this._ftCur = this._ftResolve(raw, tr.ft);   // MATCH ... AGAINST: cek FULLTEXT KEY + statistik korpus

    // SHOW khusus
    if (tr.type === 'show_tables') {
      const rows = tr.like !== undefined
        ? this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name LIKE ? ORDER BY name").all(tr.like)
        : this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return { type: 'rows', cols: [{ name: 'Tables_in_archne' }], rows: rows.map(r => [r.name]) };
    }
    if (tr.type === 'show_columns') {
      const tbl = tr.table;
      let info;
      try { info = this.db.prepare('PRAGMA table_info("' + tbl.replace(/"/g, '""') + '")').all(); }
      catch (e) { throw new SqlError(1146, '42S02', "Table '" + tbl + "' doesn't exist"); }
      const cols = [{ name: 'Field' }, { name: 'Type' }, { name: 'Null' }, { name: 'Key' }, { name: 'Default' }, { name: 'Extra' }];
      const keys = this._colKeys(info, this._idxList(tbl, info));
      const types = tableTypes(this.db, tbl);
      const rows = info.map(c => [c.name, shownType(types, c) || 'TEXT', c.notnull ? 'NO' : 'YES', keys[c.name] || '', c.dflt_value ?? null, c.pk === 1 ? 'auto_increment' : '']);
      return { type: 'rows', cols, rows };
    }
    if (tr.type === 'show_databases') {
      return { type: 'rows', cols: [{ name: 'Database' }], rows: [['archne']] };
    }
    if (tr.type === 'show_warnings' || tr.type === 'show_status' || tr.type === 'show_unknown') {
      return { type: 'rows', cols: [{ name: 'result' }], rows: [] };
    }
    if (tr.type === 'show_indexes') return this.showIndexes(tr.table);
    if (tr.type === 'show_create') return this.showCreate(tr.table);
    if (tr.type === 'empty') return { type: 'ok', changes: 0, lastId: 0 };
    if (tr.type === 'transaction') {
      this.db.exec(tr.sql);
      return { type: 'ok', changes: 0, lastId: 0 };
    }

    if (tr.type === 'create_like') { this.createLike(tr); return { type: 'ok', changes: 0, lastId: 0 }; }
    if (tr.type === 'alter') { this.alter(tr); return { type: 'ok', changes: 0, lastId: 0 }; }
    if (tr.sqls) { for (const x of tr.sqls) this.db.exec(x); return { type: 'ok', changes: 0, lastId: 0 }; }

    // eksekusi SQL hasil terjemahan
    const finalSql = tr.sql;
    const st = this.db.prepare(finalSql);
    const cols = fixCols(st.columns());
    if (cols.length) {
      const rows = allRows(st);
      // FOUND_ROWS(): tanpa SQL_CALC_FOUND_ROWS = jumlah baris hasil; dengan flag itu = jumlah baris TANPA LIMIT (paginasi WordPress)
      if (/^\s*SELECT\s+(?:(?:ALL|DISTINCT|DISTINCTROW|HIGH_PRIORITY|STRAIGHT_JOIN|SQL_SMALL_RESULT|SQL_BIG_RESULT|SQL_BUFFER_RESULT|SQL_NO_CACHE)\s+)*SQL_CALC_FOUND_ROWS\b/i.test(raw)) {
        const cut = stripTopLimit(finalSql);
        let total = rows.length;
        if (cut !== null) { try { total = Number(this.db.prepare('SELECT COUNT(*) FROM (' + cut + ')').get()['COUNT(*)']); } catch { total = rows.length; } }
        this._found = total;
      } else this._found = rows.length;
      return { type: 'rows', ...applyDecimals(this.db, finalSql, cols, rows) };
    }
    const r = st.run();
    return { type: 'ok', changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  // ------------------------------------------------------------------ SHOW INDEX / SHOW CREATE TABLE
  _tableInfo(tbl) {
    const info = this.db.prepare('PRAGMA table_info(' + Q(tbl) + ')').all();
    if (!info.length) throw new SqlError(1146, '42S02', "Table 'archne." + tbl + "' doesn't exist");
    return info;
  }
  _idxList(tbl, info) {   // [{key, unique, cols[]}] — PRIMARY dulu, lalu indeks lain urut nama
    const out = [];
    const pk = info.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
    if (pk.length) out.push({ key: 'PRIMARY', unique: true, cols: pk });
    const pre = tbl + '__';
    const order = this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY rowid").all(tbl).map(r => r.name);   // urutan pembuatan, seperti MySQL
    const rank = (n) => { const i = order.indexOf(n); return i < 0 ? 1e9 : i; };
    for (const ix of this.db.prepare('PRAGMA index_list(' + Q(tbl) + ')').all().sort((a, b) => rank(a.name) - rank(b.name))) {
      if (ix.origin === 'pk') continue;
      const cols = this.db.prepare('PRAGMA index_info(' + Q(ix.name) + ')').all().sort((a, b) => a.seqno - b.seqno).map(r => r.name);
      if (cols.some(n => n == null)) continue;   // indeks ekspresi dilewati
      const key = ix.name.startsWith(pre) ? ix.name.slice(pre.length) : ix.name.replace(/^sqlite_autoindex_.*$/, cols.join('_'));
      out.push({ key, unique: !!ix.unique, cols, ft: !!ix.partial });
    }
    return out;
  }
  showIndexes(tbl) {
    const info = this._tableInfo(tbl);
    const nullable = Object.fromEntries(info.map(c => [c.name, !c.notnull && !c.pk]));
    const names = ['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name', 'Collation', 'Cardinality', 'Sub_part', 'Packed', 'Null', 'Index_type', 'Comment', 'Index_comment', 'Visible', 'Expression'];
    const rows = [];
    for (const ix of this._idxList(tbl, info)) ix.cols.forEach((cn, i) => rows.push([tbl, ix.unique ? '0' : '1', ix.key, String(i + 1), cn, 'A', '0', null, null, nullable[cn] ? 'YES' : '', ix.ft ? 'FULLTEXT' : 'BTREE', '', '', 'YES', null]));
    return { type: 'rows', cols: names.map(name => ({ name })), rows };
  }
  showCreate(tbl) {
    const info = this._tableInfo(tbl);
    const B = (n) => '`' + n + '`';
    const pkCols = info.filter(c => c.pk).sort((a, b) => a.pk - b.pk);
    const types = tableTypes(this.db, tbl);
    const lines = info.map(c => {
      let t = (c.type || 'text').toLowerCase(); if (t === 'integer') t = 'int';
      const ai = pkCols.length === 1 && c.pk && /^int/.test(t);
      t = types.get(c.name.toLowerCase()) ?? t;
      let s = '  ' + B(c.name) + ' ' + t + (c.notnull || c.pk ? ' NOT NULL' : '');
      if (ai) s += ' AUTO_INCREMENT';
      else if (c.dflt_value != null) s += ' DEFAULT ' + c.dflt_value;
      else if (!c.notnull && !c.pk) s += ' DEFAULT NULL';
      return s;
    });
    for (const ix of this._idxList(tbl, info)) {
      const cl = '(' + ix.cols.map(B).join(',') + ')';
      lines.push('  ' + (ix.key === 'PRIMARY' ? 'PRIMARY KEY ' : (ix.unique ? 'UNIQUE KEY ' : ix.ft ? 'FULLTEXT KEY ' : 'KEY ') + B(ix.key) + ' ') + cl);
    }
    const sql = 'CREATE TABLE ' + B(tbl) + ' (\n' + lines.join(',\n') + '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
    return { type: 'rows', cols: [{ name: 'Table' }, { name: 'Create Table' }], rows: [[tbl, sql]] };
  }


  // ------------------------------------------------------------------ FULLTEXT (6c-7/6c-8)
  // FULLTEXT KEY = indeks parsial `WHERE 0` (tanpa entri; hanya mencatat daftar kolom). Sebelum pernyataan dengan MATCH
  // dijalankan: cari indeks yang kolomnya sama (himpunan), lempar 1191 bila tak ada, dan siapkan statistik korpus.
  _ftResolve(sql, keys) {
    const out = new Map(); if (!keys || !keys.length) return out;
    const cat = [];
    for (const r of this.db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql LIKE '% WHERE 0'").all())
      cat.push({ table: r.tbl_name, cols: this.db.prepare('PRAGMA index_info(' + Q(r.name) + ')').all().sort((a, b) => a.seqno - b.seqno).map(x => x.name) });
    // tabel yang dirujuk pernyataan (FROM/JOIN/UPDATE, termasuk daftar berkoma) + peta alias → tabel
    const alias = new Map(), used = new Set();
    const RES = '(?:WHERE|JOIN|ON|LEFT|RIGHT|INNER|CROSS|SET|GROUP|ORDER|LIMIT|USING|NATURAL|STRAIGHT_JOIN|FULL|OUTER|HAVING|UNION|SELECT)';
    const ref = new RegExp('`?(\\w+)`?(?:\\s+(?:AS\\s+)?`?(?!' + RES + '\\b)(\\w+)`?)?', 'iy');
    const head = /\b(?:FROM|JOIN|UPDATE)\s+/gi; let hm;
    while ((hm = head.exec(sql))) {
      let pos = head.lastIndex;
      for (;;) {
        ref.lastIndex = pos; const rm = ref.exec(sql); if (!rm || new RegExp('^' + RES + '$', 'i').test(rm[1])) break;
        used.add(rm[1].toLowerCase()); if (rm[2]) alias.set(rm[2].toLowerCase(), rm[1]);
        const cm = /^\s*,\s*/.exec(sql.slice(ref.lastIndex)); if (!cm) break;
        pos = ref.lastIndex + cm[0].length;
      }
    }
    for (const key of keys) {
      const [qual, cs] = key.split('|'), want = cs.split(',').map(x => x.toLowerCase()).sort().join(',');
      const pool = cat.filter(x => x.cols.map(c => c.toLowerCase()).sort().join(',') === want);
      let hit;
      if (qual) {
        const tname = (alias.get(qual) ?? qual).toLowerCase();
        const isTable = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND lower(name)=?").get(tname);
        hit = isTable ? pool.find(x => x.table.toLowerCase() === tname) : pool.find(x => used.has(x.table.toLowerCase()));
      } else hit = pool.find(x => used.has(x.table.toLowerCase()));
      if (!hit) {
        if (this._ftStrict) throw new SqlError(1191, 'HY000', "Can't find FULLTEXT index matching the column list");
        out.set(key, undefined); continue;
      }
      out.set(key, this._ftStats(hit.table, hit.cols));
    }
    return out;
  }
  _ftStats(table, cols) {
    const ver = Number(this.db.prepare('SELECT total_changes() AS c').get().c) + ':' + this._epoch + ':' + Number(this.db.prepare('PRAGMA data_version').get().data_version), ck = table + '|' + cols.join(',');
    // data_version berubah bila koneksi LAIN meng-commit (total_changes hanya menghitung koneksi ini)
    let st = this._ftCache.get(ck); if (st && st.ver === ver) return st.s;
    const sel = this.db.prepare('SELECT ' + cols.map(Q).join(',') + ' FROM ' + Q(table)); sel.setReturnArrays(true);
    const rows = sel.all();
    st = { ver, s: require('./ft.js').buildStats(rows) }; this._ftCache.set(ck, st); return st.s;
  }

  // ------------------------------------------------------------------ multi-statement
  split(sql) { return splitStatements(sql); }

  // ------------------------------------------------------------------ ALTER TABLE
  alter(tr) {
    this.db.exec('SAVEPOINT archne_alt');
    try { let t = tr.table; for (const op of tr.ops) t = this._alterOp(t, op) ?? t; this.db.exec('RELEASE archne_alt'); }
    catch (e) { try { this.db.exec('ROLLBACK TO archne_alt; RELEASE archne_alt'); } catch (_) {} throw e; }
  }

  createLike(tr) {
    const src = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tr.from);
    if (!src) throw new SqlError(1146, '42S02', "Table '" + tr.from + "' doesn't exist");
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tr.table)) {
      if (tr.ifNotExists) return;
      throw new SqlError(1050, '42S01', "Table '" + tr.table + "' already exists");
    }
    const m = this._model(tr.from);
    this.db.exec(src.sql.replace(/^\s*CREATE\s+TABLE\s+("(?:[^"]|"")*"|\S+)/i, () => 'CREATE TABLE ' + Q(tr.table)));
    for (const ix of m.indexes) {
      const nm = ix.name.startsWith(tr.from + '__') ? tr.table + '__' + ix.name.slice(tr.from.length + 2) : tr.table + '__' + ix.name;
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(nm)) continue;
      this.db.exec('CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX ' + Q(nm) + ' ON ' + Q(tr.table) + ' (' + ix.cols.map(Q).join(', ') + ')' + (ix.ft ? ' WHERE 0' : ''));
    }
  }

  _model(table) {
    const info = this.db.prepare('PRAGMA table_info(' + Q(table) + ')').all();
    if (!info.length) throw new SqlError(1146, '42S02', "Table '" + table + "' doesn't exist");
    const ddl = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || '';
    const pk = info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    const auto = /AUTOINCREMENT/i.test(ddl) && pk.length === 1;
    const nc = nocaseCols(ddl);
    const types = columnTypes(ddl);
    const cols = info.map(c => ({ mtype: types.get(c.name.toLowerCase()), name: c.name, src: c.name, type: c.type || 'TEXT', notnull: !!c.notnull, dflt: c.dflt_value, inlinePk: auto && c.name === pk[0], coll: nc.has(c.name.toLowerCase()) }));
    const indexes = [];
    for (const ix of this.db.prepare('PRAGMA index_list(' + Q(table) + ')').all()) {
      if (ix.origin === 'pk') continue;
      const names = this.db.prepare('PRAGMA index_info(' + Q(ix.name) + ')').all().map(r => r.name);
      if (!names.length || names.some(n => n == null)) continue;
      indexes.push({ name: ix.origin === 'u' ? table + '__' + names.join('_') : ix.name, unique: !!ix.unique, cols: names, ft: !!ix.partial });
    }
    return { table, cols, pk: auto ? [] : pk, indexes };
  }

  _rebuild(m) {
    const defOf = (c) => c.raw ?? (Q(c.name) + ' ' + c.type + marker(c.mtype) + (c.coll ? ' COLLATE NOCASE' : '') + (c.inlinePk ? ' PRIMARY KEY AUTOINCREMENT' : (c.notnull ? ' NOT NULL' : '')) + (c.dflt != null ? ' DEFAULT ' + dfltSql(c.dflt) : ''));
    const inl = m.cols.some(c => c.inlinePk || /PRIMARY KEY/i.test(c.raw || ''));
    const tmp = '__new_' + m.table;
    const body = m.cols.map(defOf).concat(!inl && m.pk.length ? ['PRIMARY KEY (' + m.pk.map(Q).join(', ') + ')'] : []).join(', ');
    this.db.exec('CREATE TABLE ' + Q(tmp) + ' (' + body + ')');
    const cp = m.cols.filter(c => c.src);
    if (cp.length) this.db.exec('INSERT INTO ' + Q(tmp) + ' (' + cp.map(c => Q(c.name)).join(',') + ') SELECT ' + cp.map(c => Q(c.src)).join(',') + ' FROM ' + Q(m.table));
    this.db.exec('DROP TABLE ' + Q(m.table));
    this.db.exec('ALTER TABLE ' + Q(tmp) + ' RENAME TO ' + Q(m.table));
    const have = new Set(m.cols.map(c => c.name));
    for (const ix of m.indexes) {
      const cs = ix.cols.filter(c => have.has(c)); if (!cs.length) continue;
      this.db.exec('CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX ' + Q(ix.name) + ' ON ' + Q(m.table) + ' (' + cs.map(Q).join(', ') + ')' + (ix.ft ? ' WHERE 0' : ''));
    }
  }

  _alterOp(table, op) {
    const find = (m, n) => { const i = m.cols.findIndex(c => c.name.toLowerCase() === String(n).toLowerCase()); if (i < 0) throw new SqlError(1054, '42S22', "Unknown column '" + n + "' in '" + table + "'"); return i; };
    const notNullFix = (d) => { if (/\bNOT NULL\b/i.test(d) && !/\bDEFAULT\b/i.test(d) && !/PRIMARY KEY/i.test(d)) { const t = (/^(?:"(?:[^"]|"")*"|\S+)\s+(\w+)/.exec(d) || [])[1] || 'TEXT'; return d + (/^(INTEGER|REAL|DECIMAL)$/i.test(t) ? ' DEFAULT 0' : " DEFAULT ''"); } return d; };
    switch (op.op) {
      case 'noop': return;
      case 'rename_table': this._renameTable(table, op.to); return op.to;
      case 'rename_col': this.db.exec('ALTER TABLE ' + Q(table) + ' RENAME COLUMN ' + Q(op.from) + ' TO ' + Q(op.to)); return;
      case 'add_index': { const m = this._model(table); op.cols.forEach(c => find(m, c)); this.db.exec('CREATE ' + (op.unique ? 'UNIQUE ' : '') + 'INDEX ' + Q(table + '__' + (op.name || op.cols.join('_'))) + ' ON ' + Q(table) + ' (' + op.cols.map(Q).join(', ') + ')' + (op.ft ? ' WHERE 0' : '')); return; }
      case 'rename_index': {
        const m = this._model(table); const pf = table + '__';
        const ix = m.indexes.find(x => x.name === pf + op.from || x.name === op.from);
        if (!ix) throw new SqlError(1176, '42000', "Key '" + op.from + "' doesn't exist in table '" + table + "'");
        if (m.indexes.some(x => x !== ix && (x.name === pf + op.to || x.name === op.to))) throw new SqlError(1061, '42000', "Duplicate key name '" + op.to + "'");
        ix.name = pf + op.to; this._rebuild(m); return;
      }
      case 'drop_index': {
        const have = this.db.prepare('PRAGMA index_list(' + Q(table) + ')').all().map(r => r.name);
        const hit = [table + '__' + op.name, op.name].find(n => have.includes(n));
        if (hit) { this.db.exec('DROP INDEX ' + Q(hit)); return; }
        const m = this._model(table); const ix = m.indexes.find(x => x.name === table + '__' + op.name);   // indeks dari constraint UNIQUE inline
        if (!ix) throw new SqlError(1091, '42000', "Can't DROP '" + op.name + "'; check that column/key exists");
        m.indexes = m.indexes.filter(x => x !== ix); this._rebuild(m); return;
      }
      case 'add': {
        const d = notNullFix(op.def);
        const simple = !op.first && !op.after && !/\b(UNIQUE|PRIMARY KEY)\b/i.test(d) && !/DEFAULT\s*\(|CURRENT_/i.test(d);
        const m = this._model(table);
        if (m.cols.some(c => c.name.toLowerCase() === op.name.toLowerCase())) throw new SqlError(1060, '42S21', "Duplicate column name '" + op.name + "'");
        if (simple) { this.db.exec('ALTER TABLE ' + Q(table) + ' ADD COLUMN ' + d); return; }
        const at = op.first ? 0 : op.after ? find(m, op.after) + 1 : m.cols.length;
        m.cols.splice(at, 0, { name: op.name, src: null, raw: d.replace(/\s+UNIQUE\b/i, '') });
        if (/\bUNIQUE\b/i.test(d)) m.indexes.push({ name: table + '__' + op.name, unique: true, cols: [op.name] });
        this._rebuild(m); return;
      }
      case 'drop_col': {
        try { this.db.exec('ALTER TABLE ' + Q(table) + ' DROP COLUMN ' + Q(op.name)); return; } catch (_) { /* indeks/PK: rebuild */ }
        const m = this._model(table); const i = find(m, op.name); m.cols.splice(i, 1);
        m.pk = m.pk.filter(n => n.toLowerCase() !== op.name.toLowerCase());
        m.indexes = m.indexes.map(x => ({ ...x, cols: x.cols.filter(n => n.toLowerCase() !== op.name.toLowerCase()) })).filter(x => x.cols.length);
        this._rebuild(m); return;
      }
      case 'modify': {
        const m = this._model(table); const i = find(m, op.name); const old = m.cols[i];
        let at = i; if (op.first) at = 0; else if (op.after) at = find(m, op.after) + (find(m, op.after) < i ? 1 : 0);
        m.cols.splice(i, 1);
        m.cols.splice(Math.min(at, m.cols.length), 0, { name: op.newName, src: old.name, raw: op.def.replace(/\s+UNIQUE\b/i, '') });
        const ren = (n) => n.toLowerCase() === op.name.toLowerCase() ? op.newName : n;
        m.pk = m.pk.map(ren); m.indexes.forEach(x => { x.cols = x.cols.map(ren); });
        if (/\bUNIQUE\b/i.test(op.def) && !m.indexes.some(x => x.unique && x.cols.length === 1 && x.cols[0] === op.newName)) m.indexes.push({ name: table + '__' + op.newName, unique: true, cols: [op.newName] });
        this._rebuild(m); return;
      }
      case 'add_pk': { const m = this._model(table); if (m.pk.length || m.cols.some(c => c.inlinePk)) throw new SqlError(1068, '42000', 'Multiple primary key defined'); op.cols.forEach(c => find(m, c)); m.pk = op.cols; this._rebuild(m); return; }
      case 'drop_pk': { const m = this._model(table); if (!m.pk.length && !m.cols.some(c => c.inlinePk)) throw new SqlError(1091, '42000', "Can't DROP 'PRIMARY'; check that column/key exists"); m.pk = []; m.cols.forEach(c => { c.inlinePk = false; }); this._rebuild(m); return; }
      case 'set_default': { const m = this._model(table); const c = m.cols[find(m, op.name)]; c.dflt = op.value; this._rebuild(m); return; }
      default: throw new SqlError(1235, '42000', 'ALTER belum didukung: ' + op.op);
    }
  }

  // ------------------------------------------------------------------ prepared statement
  prepare(sql) {
    sql = sql.replace(/\s+FOR\s+UPDATE(\s+(NOWAIT|SKIP\s+LOCKED))?\s*;?\s*$/i, '').replace(/\s+LOCK\s+IN\s+SHARE\s+MODE\s*;?\s*$/i, '').replace(/\bFROM\s+DUAL\b/i, '');
    if (/information_schema/i.test(sql)) this._refreshInfoSchema();
    const tr = translate(sql.trim().replace(/;+\s*$/, ''));
    const finalSql = (tr.sqls && tr.sqls.length === 1 && !tr.sql) ? tr.sqls[0] : (tr.sql ?? sql);   // SET @a = ? → satu SELECT __setvar
    if (tr.ft) this._ftCur = this._ftResolve(sql, tr.ft);   // galat 1191 muncul saat prepare, seperti MySQL
    const st = this.db.prepare(finalSql);
    const cols = fixCols(st.columns());
    const np = tr.nparams ?? 0;
    const id = this._nextStmt++;
    this._stmts.set(id, { sql: finalSql, np, pre: tr.pre, ft: tr.ft, src: sql });
    return { id, cols, np };
  }

  execute(id, params) {
    const S = this._stmts.get(id);
    if (!S) throw new SqlError(1243, 'HY000', 'Unknown prepared statement handler');
    if (/information_schema/i.test(S.sql)) this._refreshInfoSchema();
    if (S.pre) for (const x of S.pre) this.db.exec(x);
    if (S.ft) this._ftCur = this._ftResolve(S.src, S.ft);
    const st = this.db.prepare(S.sql);
    const cols = fixCols(st.columns());
    if (!cols.length) {
      const r = st.run(...params);
      return { type: 'ok', changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    }
    const rows = allRows(st, params);
    return { type: 'rows', ...applyDecimals(this.db, S.sql, cols, rows) };
  }

  closeStmt(id) { this._stmts.delete(id); }

  close() { try { this.db.close(); } catch (_) {} }
}

// label kolom untuk ekspresi variabel sesi: __getvar('a') → @a ; __setvar('a',1) → @a := 1
function fixCols(cols) {
  return cols.map(c => {
    let n = c.name; if (typeof n !== 'string') return c;
    if (n.includes('/*dec*/')) { n = n.split('/*dec*/').join(''); c = { ...c, name: n }; }
    if (!n.includes('__')) return c;
    let m;
    if ((m = /^__ft_match\('((?:[^']|'')*)',/.exec(n))) return { ...c, name: m[1].replace(/''/g, "'") };
    if ((m = /^__setvar\('((?:[^']|'')*)',([\s\S]*)\)$/.exec(n))) n = '@' + m[1].replace(/''/g, "'") + ' := ' + m[2];
    n = n.replace(/__getvar\('((?:[^']|'')*)'\)/g, (_, v) => '@' + v.replace(/''/g, "'"));
    return n === c.name ? c : { ...c, name: n };
  });
}

// nama kolom yang ber-COLLATE NOCASE di DDL tabel (pemisah koma tingkat-1, abaikan isi string/kutip)
function nocaseCols(ddl) {
  const out = new Set(); const a = ddl.indexOf('('); if (a < 0) return out;
  let d = 0, q = null, cur = '', parts = [];
  for (let i = a; i < ddl.length; i++) {
    const ch = ddl[i];
    if (q) { cur += ch; if (ch === q) { if (ddl[i + 1] === q) { cur += ddl[++i]; } else q = null; } continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '(') { d++; if (d === 1) continue; } else if (ch === ')') { d--; if (d === 0) break; } else if (ch === ',' && d === 1) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  for (const pt of parts) {
    const m = /^\s*(?:"((?:[^"]|"")*)"|`([^`]*)`|(\w+))/.exec(pt); if (!m) continue;
    const name = (m[1] ?? m[2] ?? m[3]).replace(/""/g, '"').toLowerCase();
    if (/\bCOLLATE\s+NOCASE\b/i.test(pt.replace(/'(?:[^']|'')*'/g, "''"))) out.add(name);
  }
  return out;
}

// Petakan galat SQLite → kode/SQLSTATE MySQL (aplikasi PHP sering mengecek 1062, 1146, dst.)
function mapError(e) {
  if (e instanceof SqlError) return e;
  const m = String(e && e.message || e); let r;
  if (e && e.errcode === 517) return new SqlError(1213, '40001', 'Deadlock found when trying to get lock; try restarting transaction');   // SQLITE_BUSY_SNAPSHOT: transaksi ini membaca snapshot lama, tak bisa menulis
  if (/database is locked|database table is locked/.test(m)) return new SqlError(1205, 'HY000', 'Lock wait timeout exceeded; try restarting transaction');
  if ((r = /no such savepoint: (\S+)/.exec(m))) return new SqlError(1305, '42000', 'SAVEPOINT ' + r[1] + ' does not exist');
  if ((r = /UNIQUE constraint failed: (?:(\w+)\.)?([\w, .]+)/.exec(m))) return new SqlError(1062, '23000', "Duplicate entry '?' for key '" + (r[1] ? r[1] + '.' : '') + r[2].split(',')[0].trim().replace(/^\w+\./, '') + "'");
  if ((r = /NOT NULL constraint failed: \w+\.(\w+)/.exec(m))) return new SqlError(1048, '23000', "Column '" + r[1] + "' cannot be null");
  if ((r = /no such table: (?:main\.)?(\S+)/.exec(m))) return new SqlError(1146, '42S02', "Table 'archne." + r[1] + "' doesn't exist");
  if ((r = /no such column: (\S+)/.exec(m))) return new SqlError(1054, '42S22', "Unknown column '" + r[1] + "' in 'field list'");
  if ((r = /table (\S+) already exists/.exec(m))) return new SqlError(1050, '42S01', "Table '" + r[1].replace(/"/g, '') + "' already exists");
  if (/FOREIGN KEY constraint failed/.test(m)) return new SqlError(1452, '23000', 'Cannot add or update a child row: a foreign key constraint fails');
  if (/syntax error/.test(m)) return new SqlError(1064, '42000', 'You have an error in your SQL syntax; ' + m);
  return new SqlError(1105, 'HY000', m);
}

module.exports = { Engine, typeCode, mapError };
