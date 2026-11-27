'use strict';
// Fase 2a — lapisan BACA-SAJA untuk browser MySQL di UI Database. Berjalan DI DALAM Worker MySQL (worker.js), sehingga mysql.sqlite tetap hanya disentuh oleh Worker (nameOk() tidak diubah).
//   tables()                      → { tables:[{ name, view, internal, rows, columns:[{ name, type, notnull, pk, default }] }], truncated }
//   rows({ table, offset, limit, sort, dir, q }) → { columns, rows, total, more, view, ids:[], rw:false }
//   exec({ sql })                 → { columns, rows, more, changes:null }   dialek MySQL (diterjemahkan seperti koneksi PHP); satu pernyataan; hanya SELECT / WITH / VALUES / EXPLAIN / SHOW / DESCRIBE
//   csv({ table })                → { size, data(base64) }   UTF-8 tanpa BOM, maks ~1 MB
// Bentuk balasan sama dengan alat PHP (archne-sys/dbtool.php) supaya UI dan IPC memakai jalur yang sama: nilai selalu null | { b:ukuran } | string (maks 500 karakter).
// Pertahanan berlapis: koneksi sendiri per permintaan dengan PRAGMA query_only=1 (tulis ditolak SQLite sendiri), kata pertama dibatasi daftar putih, tidak ada jalur untuk menulis.
// Galat dilempar sebagai Error dengan .code ∈ NODB NOTABLE BADCOL BAD BUSY RO DENIED MULTI TOOBIG SQL (SQL membawa pesan bersih di .message).
const fs = require('fs');
const { Engine } = require('./engine.js');
const { translate } = require('./mysql2sqlite.js');
const { tableTypes, shownType } = require('./mytypes.js');
const { scaleOfType, formatDecimal, resultScales } = require('./decimal.js');

const MAX_TABLES = 500, MAX_COLS = 200, MAX_ROWS = 500, MAX_OFFSET = 10000000, MAX_SQL = 100000, MAX_CSV = 1000000, VAL = 500;
const READ_KW = new Set(['select', 'with', 'values', 'explain', 'show', 'describe', 'desc']);
const TYPED_KW = new Set(['select', 'with', 'values']);
const WRITE_KW = new Set(['insert', 'replace', 'update', 'delete', 'create', 'drop', 'alter', 'truncate', 'rename']);
const Q = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const fail = (code, msg) => Object.assign(new Error(msg || code), { code, browse: true });
const clean = (m) => String(m == null ? '' : m).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/^SQLSTATE\[[^\]]*\]:[^:]*:\s*/, '').slice(0, 200);
function lift(e) {
  if (e && e.browse) return e;
  const m = String((e && e.message) || e), lm = m.toLowerCase();
  if (lm.includes('locked') || lm.includes('busy')) return fail('BUSY');
  if (lm.includes('readonly') || lm.includes('read-only') || lm.includes('read only')) return fail('RO');
  return fail('SQL', clean(m));
}

// Pecah SQL tanpa menjalankannya (padanan sql_scan di dbtool.php): { first, single, end } atau null bila cacat (kutip / komentar tak tertutup).
// Memahami '..', "..", `..`, [..], -- komentar, /* komentar */. Hanya SATU pernyataan; ; penutup boleh.
function sqlScan(sql) {
  const n = sql.length; let i = 0, first = null, ended = false, end = n;
  while (i < n) {
    const c = sql[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '#') { const e = sql.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }   // komentar gaya MySQL
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue; }
    if (c === ';') { if (!ended) end = i; ended = true; i++; continue; }
    if (ended) return { first, single: false, end };
    if (first === null) { const m = /^[A-Za-z]+/.exec(sql.slice(i, i + 40)); if (!m) return { first: '', single: true, end }; first = m[0].toLowerCase(); }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c; let j = i + 1;
      for (;;) {
        const e = sql.indexOf(close, j); if (e < 0) return null;
        if (close !== ']' && sql[e + 1] === close) { j = e + 2; continue; }   // '' dan "" = tanda kutip di dalam
        if (close === "'" && sql[e - 1] === '\\') { j = e + 1; continue; }      // \' gaya MySQL
        i = e + 1; break;
      }
      continue;
    }
    i++;
  }
  return { first: first === null ? '' : first, single: true, end };
}

const cell = (k, v) => (k === 'null' ? null : k === 'blob' ? { b: Number(v) || 0 } : String(v));
// Nilai angka di kolom DECIMAL ditampilkan dengan skalanya ('12.50'), seperti phpMyAdmin.
const decCell = (k, v, s) => (s != null && (k === 'integer' || k === 'real') ? formatDecimal(k === 'integer' ? BigInt(v) : Number(v), s) : cell(k, v));
const rawCell = (v) => (v == null ? null : (v instanceof Uint8Array) ? { b: v.length } : String(v).slice(0, VAL));   // jalur tanpa typeof() (SHOW / EXPLAIN)

function createBrowseService({ file, busyMs = 5000 } = {}) {
  const open = () => {
    if (!file || !fs.existsSync(file)) throw fail('NODB');
    let eng;
    try { eng = new Engine({ file, busyTimeout: busyMs }); eng.db.exec('PRAGMA query_only=1'); }
    catch (e) { if (eng) try { eng.db.close(); } catch (_) {} throw lift(e); }
    return eng;
  };
  const using = (fn) => { const eng = open(); try { return fn(eng.db, eng); } catch (e) { throw lift(e); } finally { try { eng.db.close(); } catch (_) {} } };
  const kindOf = (d, t) => { const r = d.prepare("SELECT type FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(t); return r ? r.type : null; };
  const colsOf = (d, t) => d.prepare('PRAGMA table_info(' + Q(t) + ')').all().slice(0, MAX_COLS).map((c) => String(c.name));
  const tname = (t) => { if (typeof t !== 'string' || !t || t.length > 200 || t.includes('\0')) throw fail('BAD'); return t; };

  function tables() {
    return using((d) => {
      let rows = d.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name LIMIT 501").all();
      const truncated = rows.length > MAX_TABLES; if (truncated) rows = rows.slice(0, MAX_TABLES);
      return {
        truncated,
        tables: rows.map((r) => {
          const name = String(r.name), view = r.type === 'view';
          const types = tableTypes(d, name);
          const columns = d.prepare('PRAGMA table_info(' + Q(name) + ')').all().slice(0, MAX_COLS).map((c) => ({ name: String(c.name), type: String(shownType(types, c) || ''), notnull: Number(c.notnull) === 1, pk: Number(c.pk) || 0, default: c.dflt_value == null ? null : String(c.dflt_value) }));
          let n = null; if (!view) { try { n = Number(d.prepare('SELECT COUNT(*) AS n FROM ' + Q(name)).get().n); } catch (_) { n = null; } }   // tampilan tidak dihitung: bisa mahal
          return { name, view, internal: name.startsWith('sqlite_') || name.startsWith('__'), rows: n, columns };
        }),
      };
    });
  }

  function rows(o) {
    o = o && typeof o === 'object' ? o : {};
    const t = tname(o.table);
    const limit = Number.isSafeInteger(o.limit) ? Math.max(1, Math.min(MAX_ROWS, o.limit)) : 50;
    const offset = Number.isSafeInteger(o.offset) ? Math.max(0, Math.min(MAX_OFFSET, o.offset)) : 0;
    return using((d) => {
      const ty = kindOf(d, t); if (!ty) throw fail('NOTABLE');
      const cols = colsOf(d, t); if (!cols.length) throw fail('NOTABLE');
      let order = '';
      if (o.sort != null) { if (typeof o.sort !== 'string' || !cols.includes(o.sort)) throw fail('BADCOL'); order = ' ORDER BY ' + Q(o.sort) + (o.dir === 'desc' ? ' DESC' : ' ASC'); }
      let where = ''; const args = [];
      if (typeof o.q === 'string' && o.q !== '') {
        const needle = '%' + o.q.slice(0, 100).replace(/[%_\\]/g, '\\$&') + '%';
        where = ' WHERE ' + cols.map((c) => { args.push(needle); return '(typeof(' + Q(c) + ") <> 'blob' AND CAST(" + Q(c) + " AS TEXT) LIKE ? ESCAPE '\\')"; }).join(' OR ');
      }
      const sel = cols.map((c) => 'typeof(' + Q(c) + '), CASE typeof(' + Q(c) + ") WHEN 'blob' THEN length(" + Q(c) + ') ELSE substr(CAST(' + Q(c) + ' AS TEXT), 1, ' + VAL + ') END').join(', ');
      const scales = d.prepare('PRAGMA table_info(' + Q(t) + ')').all().map((c) => scaleOfType(c.type));
      const total = ty === 'table' ? Number(d.prepare('SELECT COUNT(*) AS n FROM ' + Q(t) + where).get(...args).n) : null;
      const st = d.prepare('SELECT ' + sel + ' FROM ' + Q(t) + where + order + ' LIMIT ' + (limit + 1) + ' OFFSET ' + offset); st.setReturnArrays(true);
      const all = st.all(...args), more = all.length > limit;
      const out = all.slice(0, limit).map((r) => cols.map((_, i) => decCell(r[i * 2], r[i * 2 + 1], scales[i])));
      return { columns: cols, rows: out, total, more, view: ty === 'view', ids: [], rw: false };
    });
  }

  function exec(o) {
    o = o && typeof o === 'object' ? o : {};
    const sql = o.sql;
    if (typeof sql !== 'string' || !sql.trim() || sql.length > MAX_SQL || sql.includes('\0')) throw fail('BAD');
    const sc = sqlScan(sql);
    if (sc === null) throw fail('SQL', 'Tanda kutip atau komentar tidak tertutup');
    if (!sc.single) throw fail('MULTI');
    if (!READ_KW.has(sc.first)) throw fail(WRITE_KW.has(sc.first) ? 'RO' : 'DENIED');
    const raw = sql.slice(0, sc.end).trim();
    return using((d, eng) => {
      if (TYPED_KW.has(sc.first)) { // dibungkus: kolom dinamai c0.. dan SQLite sendiri yang menjawab typeof(); LIMIT 501 membuat memori Worker terbatas
        let tr = null; try { tr = translate(raw); } catch (e) { throw lift(e); }
        if (tr && !tr.type && tr.sql && !tr.pre && !tr.ft && !tr.sqls && !tr.nparams && !/information_schema/i.test(raw)) {
          let nc = 0, names = [];
          const inner = d.prepare(tr.sql); const meta = inner.columns(); nc = Math.min(meta.length, MAX_COLS); names = meta.slice(0, nc).map((c, i) => String(c.name == null ? 'c' + i : c.name));
          if (nc > 0) {
            const cn = names.map((_, i) => 'c' + i), sel = cn.map((c) => 'typeof(' + c + '), CASE typeof(' + c + ") WHEN 'blob' THEN length(" + c + ') ELSE substr(CAST(' + c + ' AS TEXT), 1, ' + VAL + ') END').join(', ');
            let ws = null; try { ws = d.prepare('WITH u(' + cn.join(',') + ') AS (' + tr.sql + '\n) SELECT ' + sel + ' FROM u LIMIT ' + (MAX_ROWS + 1)); } catch (_) { ws = null; }
            if (ws) {
              ws.setReturnArrays(true); const all = ws.all();
              const scales = resultScales(d, tr.sql, meta);
              return { columns: names, rows: all.slice(0, MAX_ROWS).map((r) => names.map((_, i) => decCell(r[i * 2], r[i * 2 + 1], scales[i]))), more: all.length > MAX_ROWS, changes: null };
            }
          }
        }
      }
      let r; // SHOW / DESCRIBE / EXPLAIN / bentuk yang tak bisa dibungkus
      try { r = eng.query(raw); }
      catch (e) { // menyegarkan information_schema menulis ke tabel internal, yang ditolak koneksi baca-saja: beri jalan keluar, bukan "hanya baca"
        if (/information_schema/i.test(raw) && lift(e).code === 'RO') throw fail('SQL', 'information_schema belum tersedia di browser baca-saja; pakai SHOW TABLES atau DESCRIBE nama_tabel');
        throw e;
      }
      if (r.type === 'rows') {
        const cols = (r.cols || []).slice(0, MAX_COLS).map((c) => String(c.name));
        return { columns: cols, rows: (r.rows || []).slice(0, MAX_ROWS).map((row) => cols.map((_, i) => rawCell(row[i]))), more: (r.rows || []).length > MAX_ROWS, changes: null };
      }
      return { columns: [], rows: [], more: false, changes: Number(r.changes) || 0 };
    });
  }

  function csv(o) {
    const t = tname(o && o.table);
    return using((d) => {
      if (!kindOf(d, t)) throw fail('NOTABLE');
      const cols = colsOf(d, t); if (!cols.length) throw fail('NOTABLE');
      const f = (k, v) => (k === 'null' ? '' : v === '' ? '""' : /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
      const sel = cols.map((c) => 'typeof(' + Q(c) + "), CASE typeof(" + Q(c) + ") WHEN 'blob' THEN hex(" + Q(c) + ') ELSE ' + Q(c) + ' END').join(', ');
      const st = d.prepare('SELECT ' + sel + ' FROM ' + Q(t)); st.setReturnArrays(true); st.setReadBigInts(true);
      const scales = d.prepare('PRAGMA table_info(' + Q(t) + ')').all().map((c) => scaleOfType(c.type));
      let buf = cols.map((c) => f('text', c)).join(',') + '\r\n';
      for (const r of (typeof st.iterate === 'function' ? st.iterate() : st.all())) {
        buf += cols.map((_, i) => f(r[i * 2], scales[i] != null && (r[i * 2] === 'integer' || r[i * 2] === 'real') ? formatDecimal(r[i * 2 + 1], scales[i]) : r[i * 2 + 1])).join(',') + '\r\n';
        if (buf.length > MAX_CSV) throw fail('TOOBIG');
      }
      return { size: Buffer.byteLength(buf), data: Buffer.from(buf, 'utf8').toString('base64') };   // BOM ditambahkan oleh IPC (webDbCsv), sama seperti jalur PHP
    });
  }

  return { tables, rows, exec, csv };
}

module.exports = { createBrowseService, sqlScan };
