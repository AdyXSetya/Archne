'use strict';
// src/archne-ipc-webdb.js — jembatan renderer <-> database SQLite situs sendiri (0.34.0 Fase P.7a-e). Dipanggil dari registerWeb() (archne-ipc-web.js).
// Renderer hanya mengirim id situs + NAMA berkas database (bukan jalur). Nama harus berkas biasa tepat di data/ situs itu; jalur disk tidak pernah keluar.
// Kanal (-> { ok:true, ... } | { ok:false, err, code }):
//   webDbList(id)          -> { items:[{ name, size, mtime }] }   dibaca di Node (tanpa Worker PHP): hanya berkas biasa di data/ berekstensi DB dan berkepala "SQLite format 3"
//   webDbTables(id, name)  -> { tables:[{ name, view, internal, rows, columns:[{ name, type, notnull, pk, default }] }], truncated }   lewat alat PHP milik aplikasi (host.dbTool)
//   webDbRows(id, name, o) -> { columns:[str], rows:[[null|{b:ukuran}|str]], total|null, more, view }   o = { table, offset, limit(1-500), sort, dir:'asc'|'desc', q }  (P.7b, hanya baca, parameter terikat di PHP)
//   webDbInsert(id, name, o) -> { rid }   o = { table, values:[[kolom, string|null]] }  (P.7d, satu baris)
//   webDbUpdate(id, name, o) -> {}        o = { table, rid, values:[[kolom, string|null]] (minimal satu) }
//   webDbDelete(id, name, o) -> {}        o = { table, rid }
//   rid = rowid sebagai string bilangan bulat (diambil dari ids milik webDbRows). Nama kolom disahkan terhadap skema di PHP; nilai selalu parameter terikat.
//   webDbExport(id, name)  -> { name, size, data(base64) }   seluruh berkas database (maks 5 MB), setelah checkpoint WAL  (P.7e)
//   webDbImport(id, o)     -> { name }    o = { name, data(base64) }: harus berkepala SQLite dan terbuka lewat alat PHP; menimpa database yang sudah ada HANYA bila o.overwrite === true (WAL/SHM lama dihapus)
//   webDbCreate(id, o)     -> { name }    o = { name }: membuat database SQLite KOSONG (tanpa tabel); nama harus lolos nameOk dan belum dipakai; maks MAX_ITEMS database per situs
//   webDbDrop(id, name)    -> { name }    menghapus berkas database beserta -wal / -shm / -journal; hanya berkas biasa berkepala SQLite (bukan symlink); tidak bisa dibatalkan
//   webDbReset(id, name)   -> { tables, rows }   mengosongkan SEMUA baris di semua tabel (struktur tetap; hitungan AUTOINCREMENT mulai dari 1); satu transaksi di PHP, gagal = tidak ada yang berubah
//   webDbExec(id, name, o) -> { columns, rows, more, changes }   o = { sql, write? }  kotak SQL (P.7f): satu pernyataan; baca-saja kecuali write === true; ATTACH/PRAGMA/VACUUM ditolak
//   webDbCsv(id, name, o)  -> { name, size, data(base64) }   o = { table }  CSV UTF-8 ber-BOM, maks ~1 MB
//   webDbMysqlChoose(id)   -> { canceled:true } | { token, file, size, preview }   Impor dump MySQL fase 1: dialog pilih .sql di proses utama (jalur tak pernah ke renderer), berkas dibaca UTF-8 di Node,
//                             di-parse di Worker MySQL situs. preview = { ok, tables:[{name,action}], skippable:[str], warnings:[str], errors:[{line,message}], willReplace:[str], stats }; token = null bila preview.ok === false.
//   webDbMysqlCommit(id, token) -> { tables, rows, skipped:[str], warnings:[str], ms }   satu transaksi di Worker; gagal = ROLLBACK, tidak ada yang berubah. Token sekali pakai.
//   webDbMysqlCancel(id, token) -> {}   membuang hasil parse tertunda (memori Worker)
//   webDbMysqlExport(id)   -> { canceled:true[, aborted:true] } | { name, size, tables, rows, skipped:[str], warnings:[str], warningsN, ms }   Ekspor dump MySQL (fase 3-4): dialog simpan di proses utama (deps.pickSave(def, 'sql')), Worker MySQL
//                             menulis dump langsung ke disk (renderer tak pernah melihat jalur maupun isi). Lokasi di dalam folder situs ditolak ('inside'): dump bisa terbaca dari web. Satu operasi MySQL per situs (bersama impor).
//                             Kemajuan: event 'webdbprog' { id, tables, rows, bytes }. aborted = dibatalkan lewat webDbMysqlExportCancel.
//   webDbMysqlExportCancel(id) -> {}   menghentikan ekspor yang berjalan (berkas sementara dibuang; berkas tujuan lama tidak tersentuh)
//   webDbMysqlCreate(id)   -> { created:boolean, port }   Buat database MySQL (fase 5e): mysql.sqlite kosong + port tetap di mysql.json, TANPA menyalakan server. Idempoten (yang sudah ada tidak ditimpa, created:false).
//                             Satu operasi MySQL per situs (penjaga sama dengan impor/ekspor): busy bila ada yang berjalan. Galat: nomysql, baddb (mysql.sqlite ada tapi bukan SQLite sah; tak diubah), io, busy.
//   webDbMysqlStart(id)   -> { running:true, port, already:boolean }   Nyalakan server MySQL (fase 6d): butuh mysql.sqlite (galat nodb bila belum dibuat) dan Mesin PHP situs menyala. Server di-PIN: host.stop / reload tidak mematikannya. already = Worker sudah jalan (hanya di-pin).
//   webDbMysqlStop(id)    -> { stopped:boolean }   Matikan server MySQL, juga yang di-pin; menunggu Worker keluar. Tidak butuh Mesin PHP menyala. stopped:false = memang sudah mati.
//                             Keduanya memakai penjaga satu operasi MySQL per situs (busy). Galat: nomysql, nodb (Start), busy, io, nosite, bad.
//   mysql.sqlite TETAP ditolak nameOk(): kanal-kanal ini tidak menerima nama berkas, hanya id situs.
//   Browser MySQL baca-saja (fase 2b): webDbList mengembalikan juga mysqlDb:{ name:'mysql.sqlite', size } | null. webDbTables(id,'mysql.sqlite',{readonly:true}), webDbRows / webDbExec / webDbCsv dengan o.readonly === true
//   dialihkan ke Worker MySQL (host.mysqlBrowse), BUKAN ke alat PHP. Tanpa readonly:true nama 'mysql.sqlite' tetap ditolak nameOk(); dengan readonly:true nama lain ditolak; write:true ditolak ('ro').
// Isi database berasal dari situs (tidak tepercaya): semua nilai dipaksa jadi string/angka dan dipendekkan sebelum ke renderer; renderer tetap harus menampilkannya sebagai teks.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ek } = require('./core/archne-ecode');

const HEX16 = /^[0-9a-f]{16}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EXT = new Set(['sqlite', 'sqlite3', 'db', 'db3']);
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|sessions|uploads)$/i; // nama perangkat Windows + folder milik mesin
const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const MAX_ITEMS = 200, MAX_TABLES = 500, MAX_COLS = 200, MAX_JSON = 2 * 1024 * 1024, MAX_ROWS = 500, MAX_OFFSET = 10000000;
const MAX_VAL = 200000, MAX_WRITE = 300000; // karakter per nilai / total per panggilan (PHP membaca paling banyak 1 MB)
const MAX_SQL = 100000, MAX_CSV = 1100000;
const RID_RE = /^-?[0-9]{1,19}$/;
const MAX_DUMP = 500 * 1024 * 1024; // batas string Node ~512 Mi karakter; byte >= karakter UTF-8, jadi 500 MB selalu muat
const TOKEN_RE = /^[0-9a-f]{24}$/;
const MAX_XFER = 5 * 1024 * 1024; // ekspor / impor satu berkas (base64 lewat IPC)
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// 108 byte pertama berkas SQLite kosong (kepala 100 byte + kepala halaman b-tree kosong), sisanya nol sampai 4096. Dibuat dengan sqlite3 sungguhan lalu diperiksa integrity_check = ok.
const EMPTY_HEAD = Buffer.from('53514c69746520666f726d61742033001000010100402020000000030000000100000000000000000000000300000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000003002e76890d00000000100000', 'hex');
const emptyDb = () => { const b = Buffer.alloc(4096); EMPTY_HEAD.copy(b, 0); return b; };
const SIDE = ['-wal', '-shm', '-journal'];
const sOk = (v, n) => typeof v === 'string' && v.length <= n && !v.includes('\0');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

function nameOk(n) {
  if (typeof n !== 'string' || !NAME_RE.test(n) || n.includes('..') || n.endsWith('.')) return false;
  const dot = n.lastIndexOf('.');
  if (dot < 1 || !EXT.has(n.slice(dot + 1).toLowerCase())) return false;
  if (n.toLowerCase() === 'mysql.sqlite') return false; // milik server MySQL palsu (WAL, dibuka proses lain): tak boleh disentuh lewat PHP/menu Database
  return !RESERVED.test(n.slice(0, dot).split('.')[0]);
}
function hasMagic(file) {
  let fd; try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); return fs.readSync(fd, b, 0, 16, 0) === 16 && b.equals(MAGIC); } catch { return false; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

function registerWebDb({ on, core, getPhpHost, pickSql, pickSave, send }) {
  const bad = () => ek('e.lw.err.bad', null, 'Permintaan tidak valid', 'bad');
  const dataDir = (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    const ws = core.webStore();
    if (!ws.has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    return ws.paths(id).data; // melempar e.lw.phpOff bila Mesin PHP mati
  };
  // Berkas database valid di data/ (bukan symlink, berkas biasa, berkepala SQLite) atau galat ber-kunci.
  const dbFile = (dir, name) => {
    if (!nameOk(name)) throw ek('e.db.badName', null, 'Nama database tidak valid', 'badname');
    const f = path.join(dir, name);
    let st; try { st = fs.lstatSync(f); } catch { throw ek('e.db.none', null, 'Database tidak ditemukan', 'nodb'); }
    if (!st.isFile()) throw ek('e.db.none', null, 'Database tidak ditemukan', 'nodb');
    if (!hasMagic(f)) throw ek('e.db.notSqlite', null, 'Berkas ini bukan database SQLite', 'notdb');
    return st;
  };

  on('webDbList', (id) => {
    const dir = dataDir(id), items = [];
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of ents) {
      if (!e.isFile() || !nameOk(e.name)) continue;      // isFile() false untuk symlink dan folder (sessions/, uploads/)
      const f = path.join(dir, e.name);
      if (!hasMagic(f)) continue;
      let st; try { st = fs.statSync(f); } catch { continue; }
      items.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Info MySQL palsu untuk aplikasi PHP (port tetap per situs, disimpan di <situs>/mysql.json di luar www/ dan data/); null bila belum pernah dijalankan.
    let mysql = null;
    try { const n = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'mysql.json'), 'utf8')).port; if (Number.isInteger(n) && n > 1023 && n < 65536) mysql = { host: '127.0.0.1', port: n, user: 'root' }; } catch {}
    // Fase 2b: berkas mysql.sqlite (dipegang Worker MySQL) hanya dilaporkan namanya + ukurannya; berkas biasa berkepala SQLite, bukan symlink. Tidak membutuhkan Worker menyala.
    let mysqlDb = null;
    try { const f = path.join(dir, 'mysql.sqlite'), st = fs.lstatSync(f); if (st.isFile() && hasMagic(f)) mysqlDb = { name: 'mysql.sqlite', size: st.size }; } catch {}
    // Fase 5a: ringkasan status MySQL untuk tampilan (tanpa mengubah mysql / mysqlDb): hasDb = mysql.sqlite ada, hasInfo = mysql.json punya port sah, port = angka itu atau null.
    // Fase 6a: running = true/false bila host punya status server MySQL; null = tidak diketahui (tanpa Mesin PHP / tanpa pengelola MySQL). Hanya membaca, tidak menyalakan Worker.
    // Fase 6b: starting = Worker dibuat tapi belum siap (true/false bila dilaporkan; null bila running tidak diketahui). Hanya dipercaya bila boolean DAN running = false (berjalan tidak mungkin sekaligus memulai).
    let running = null, starting = null;
    try { const h = typeof getPhpHost === 'function' ? getPhpHost() : null; if (h && typeof h.mysqlStatus === 'function') { const s = h.mysqlStatus(id); if (s && typeof s.running === 'boolean') { running = s.running; starting = !s.running && s.starting === true; } } } catch {}
    const mysqlState = { hasDb: mysqlDb !== null, hasInfo: mysql !== null, port: mysql ? mysql.port : null, running, starting };
    return { ok: true, items: items.slice(0, MAX_ITEMS), mysql, mysqlDb, mysqlState };
  });

  // Satu pintu ke alat PHP: kembalikan JSON ok:true atau lempar galat ber-kunci tanpa jalur/pesan mentah.
  const runTool = async (id, payload, w) => {
    const FAIL = () => (w ? ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io') : ek('e.db.fail', null, 'Gagal membaca database', 'io'));
    const host = typeof getPhpHost === 'function' ? getPhpHost() : null;
    if (!host || typeof host.dbTool !== 'function') throw ek('e.db.noPhp', null, 'Mesin PHP tidak tersedia, database tidak bisa dibaca', 'nophp');
    let res;
    try { res = await host.dbTool(id, payload); }
    catch (e) { if (e && e.ek) throw e; throw FAIL(); }
    let j = null;
    try { if (res && res.body && res.body.length <= MAX_JSON) j = JSON.parse(Buffer.from(res.body).toString('utf8')); } catch {}
    if (!j || typeof j !== 'object') throw FAIL();
    if (j.ok !== true) {
      const KEY = { busy: 'e.db.busy', nodb: 'e.db.none', notdb: 'e.db.notSqlite', badname: 'e.db.badName', notable: 'e.db.noTable', badcol: 'e.db.badCol', bad: 'e.lw.err.bad', constraint: 'e.db.constraint', norow: 'e.db.noRow', norowid: 'e.db.noRowid', readonly: 'e.db.readonly', ro: 'e.db.ro', needwrite: 'e.db.needWrite', denied: 'e.db.denied', multi: 'e.db.multi', toobig: 'e.db.csvBig' };
      if (j.code === 'sql') { const m = typeof j.msg === 'string' ? j.msg.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : ''; throw ek('e.db.sql', { m }, 'Galat SQL: {m}', 'sql'); }
      const c = typeof j.code === 'string' && KEY[j.code] ? j.code : null;
      if (c) throw ek(KEY[c], null, 'Gagal membaca database', c);
      throw FAIL();
    }
    return j;
  };


  // ---- Fase 2b: browser MySQL baca-saja. Bendera readonly harus persis true DAN nama persis 'mysql.sqlite'; jalurnya Worker MySQL, tak pernah alat PHP.
  const MY = 'mysql.sqlite';
  const isMy = (name, o) => {
    const f = o && typeof o === 'object' ? o.readonly : undefined;
    if (f == null || f === false) return false;
    if (f !== true || name !== MY) throw bad();
    return true;
  };
  const myHost = () => {
    const host = typeof getPhpHost === 'function' ? getPhpHost() : null;
    if (!host || !host.mysqlBrowse) throw ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    return host.mysqlBrowse;
  };
  const myErr = (e) => {
    if (e && e.ek) return e;
    switch (e && e.code) {
      case 'NODB': return ek('e.db.none', null, 'Database tidak ditemukan', 'nodb');
      case 'NOTABLE': return ek('e.db.noTable', null, 'Tabel tidak ditemukan di database', 'notable');
      case 'BADCOL': return ek('e.db.badCol', null, 'Kolom tidak dikenal', 'badcol');
      case 'BAD': return bad();
      case 'BUSY': return ek('e.db.busy', null, 'Database sedang dipakai, coba lagi', 'busy');
      case 'RO': return ek('e.db.myRo', null, 'Browser MySQL hanya bisa membaca: pernyataan yang mengubah data ditolak', 'ro');
      case 'DENIED': return ek('e.db.myDenied', null, 'Pernyataan ini tidak diizinkan di browser MySQL (hanya SELECT, SHOW, DESCRIBE, EXPLAIN)', 'denied');
      case 'MULTI': return ek('e.db.multi', null, 'Hanya satu pernyataan SQL per eksekusi', 'multi');
      case 'TOOBIG': return ek('e.db.csvBig', null, 'Tabel terlalu besar untuk CSV (maksimal 1 MB)', 'toobig');
      case 'SQL': { const m = typeof e.message === 'string' ? e.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : ''; return ek('e.db.sql', { m }, 'Galat SQL: {m}', 'sql'); }
      case 'NOMYSQL': return ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
      default: return ek('e.db.fail', null, 'Gagal membaca database', 'io');
    }
  };
  const myCall = async (id, fn) => { const b = myHost(); try { return await fn(b); } catch (e) { throw myErr(e); } };
  const cleanTables = (j) => ({
    tables: (Array.isArray(j.tables) ? j.tables : []).slice(0, MAX_TABLES).map((t) => ({
      name: clip(t && t.name, 200), view: !!(t && t.view), internal: !!(t && t.internal), rows: t ? int(t.rows) : null,
      columns: (t && Array.isArray(t.columns) ? t.columns : []).slice(0, MAX_COLS).map((c) => ({
        name: clip(c && c.name, 200), type: clip(c && c.type, 60), notnull: !!(c && c.notnull), pk: int(c && c.pk) || 0,
        default: c && c.default != null ? clip(c.default, 200) : null,
      })),
    })),
    truncated: j.truncated === true,
  });
  const cellOf = (v) => (v == null ? null : typeof v === 'object' ? { b: int(v.b) || 0 } : clip(v, 500));

  on('webDbTables', async (id, name, o) => {
    const dir = dataDir(id);
    if (isMy(name, o)) { const j = await myCall(id, (b) => b.tables(id)); return Object.assign({ ok: true }, cleanTables(j || {})); }
    dbFile(dir, name);
    const j = await runTool(id, { op: 'tables', db: name });
    return Object.assign({ ok: true }, cleanTables(j));
  });
  on('webDbRows', async (id, name, o) => {
    const dir = dataDir(id);
    o = o && typeof o === 'object' ? o : {};
    const my = isMy(name, o);
    if (!my) dbFile(dir, name);
    const str = (v, n) => typeof v === 'string' && v.length <= n && !v.includes('\0');
    if (!str(o.table, 200) || !o.table) throw bad();
    if (o.sort != null && (!str(o.sort, 200) || !o.sort)) throw bad();
    if (o.q != null && !str(o.q, 100)) throw bad();
    if (o.dir != null && o.dir !== 'asc' && o.dir !== 'desc') throw bad();
    for (const k of ['offset', 'limit']) if (o[k] != null && !Number.isSafeInteger(o[k])) throw bad();
    const limit = Math.min(MAX_ROWS, Math.max(1, o.limit == null ? 50 : o.limit));
    const offset = Math.min(MAX_OFFSET, Math.max(0, o.offset == null ? 0 : o.offset));
    const args = { table: o.table, offset, limit, sort: o.sort == null ? null : o.sort, dir: o.dir === 'desc' ? 'desc' : 'asc', q: o.q == null ? '' : o.q };
    const j = my ? (await myCall(id, (b) => b.rows(id, args))) || {} : await runTool(id, Object.assign({ op: 'rows', db: name }, args));
    const columns = (Array.isArray(j.columns) ? j.columns : []).slice(0, MAX_COLS).map((c) => clip(c, 200));
    const cell = (v) => (v == null ? null : typeof v === 'object' ? { b: int(v.b) || 0 } : clip(v, 500));
    const rows = (Array.isArray(j.rows) ? j.rows : []).slice(0, limit).map((r) => (Array.isArray(r) ? r : []).slice(0, columns.length).map(cell));
    const rw = !my && j.rw === true && j.view !== true; // browser MySQL: tak pernah bisa ditulis
    const ids = rw ? (Array.isArray(j.ids) ? j.ids : []).slice(0, limit).map((v) => (typeof v === 'string' && RID_RE.test(v) ? v : null)) : [];
    return { ok: true, columns, rows, ids, rw, total: int(j.total), more: j.more === true, view: j.view === true };
  });
  // ---- P.7d: tulis satu baris. Semua pemeriksaan bentuk dilakukan di sini SEBELUM host dipanggil; PHP memeriksa lagi terhadap skema.
  const valuesOf = (o) => {
    if (o.values == null) return [];
    if (!Array.isArray(o.values) || o.values.length > MAX_COLS) throw bad();
    const seen = new Set(), out = []; let total = 0;
    for (const p of o.values) {
      if (!Array.isArray(p) || p.length !== 2 || !sOk(p[0], 200) || !p[0] || seen.has(p[0])) throw bad();
      if (p[1] !== null && !(typeof p[1] === 'string' && p[1].length <= MAX_VAL)) throw bad();
      total += p[0].length + (p[1] === null ? 0 : p[1].length); if (total > MAX_WRITE) throw bad();
      seen.add(p[0]); out.push([p[0], p[1]]);
    }
    return out;
  };
  const writeOp = async (op, id, name, o) => {
    const dir = dataDir(id);
    dbFile(dir, name);
    o = o && typeof o === 'object' ? o : {};
    if (!sOk(o.table, 200) || !o.table) throw bad();
    const values = valuesOf(o), payload = { op, db: name, table: o.table };
    if (op === 'delete') { if (o.values != null) throw bad(); } else payload.values = values;
    if (op === 'update' && !values.length) throw bad();
    if (op !== 'insert') {
      const rid = typeof o.rid === 'number' && Number.isSafeInteger(o.rid) ? String(o.rid) : o.rid;
      if (typeof rid !== 'string' || !RID_RE.test(rid)) throw bad();
      payload.rid = rid;
    }
    return runTool(id, payload, true);
  };
  on('webDbInsert', async (id, name, o) => { const j = await writeOp('insert', id, name, o); return { ok: true, rid: typeof j.rid === 'string' && RID_RE.test(j.rid) ? j.rid : null }; });
  on('webDbUpdate', async (id, name, o) => { await writeOp('update', id, name, o); return { ok: true }; });
  on('webDbDelete', async (id, name, o) => { await writeOp('delete', id, name, o); return { ok: true }; });

  // ---- P.7f: kotak SQL, ekspor CSV per tabel, impor yang menimpa.
  // webDbExec(id, name, { sql, write? }) -> { columns, rows, more, changes }  write harus persis true; tanpa itu hanya SELECT/WITH/VALUES/EXPLAIN dan PHP membuka koneksi query_only.
  on('webDbExec', async (id, name, o) => {
    const dir = dataDir(id);
    o = o && typeof o === 'object' ? o : {};
    const my = isMy(name, o);
    if (!my) dbFile(dir, name);
    if (!sOk(o.sql, MAX_SQL) || !o.sql.trim()) throw bad();
    if (o.write != null && typeof o.write !== 'boolean') throw bad();
    const w = o.write === true;
    if (my && w) throw ek('e.db.myRo', null, 'Browser MySQL hanya bisa membaca: pernyataan yang mengubah data ditolak', 'ro');
    const j = my ? (await myCall(id, (b) => b.exec(id, { sql: o.sql }))) || {} : await runTool(id, { op: 'exec', db: name, sql: o.sql, write: w }, w);
    const columns = (Array.isArray(j.columns) ? j.columns : []).slice(0, MAX_COLS).map((c) => clip(c, 200));
    const cell = (v) => (v == null ? null : typeof v === 'object' ? { b: int(v.b) || 0 } : clip(v, 500));
    const rows = (Array.isArray(j.rows) ? j.rows : []).slice(0, MAX_ROWS).map((r) => (Array.isArray(r) ? r : []).slice(0, columns.length).map(cell));
    const changes = Number.isSafeInteger(j.changes) && j.changes >= 0 ? j.changes : null;
    return { ok: true, columns, rows, more: j.more === true, changes };
  });
  // webDbCsv(id, name, { table }) -> { name, size, data(base64) }  (UTF-8 dengan BOM agar Excel membacanya benar; maks ~1 MB)
  on('webDbCsv', async (id, name, o) => {
    const dir = dataDir(id);
    o = o && typeof o === 'object' ? o : {};
    const my = isMy(name, o);
    if (!my) dbFile(dir, name);
    if (!sOk(o.table, 200) || !o.table) throw bad();
    const j = my ? (await myCall(id, (b) => b.csv(id, { table: o.table }))) || {} : await runTool(id, { op: 'csv', db: name, table: o.table });
    if (typeof j.data !== 'string' || !B64_RE.test(j.data)) throw ek('e.db.fail', null, 'Gagal membaca database', 'io');
    const body = Buffer.from(j.data, 'base64');
    if (body.length > MAX_CSV) throw ek('e.db.csvBig', null, 'Tabel terlalu besar untuk CSV (maksimal 1 MB)', 'toobig');
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
    const base = o.table.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'tabel';
    return { ok: true, name: base + '.csv', size: buf.length, data: buf.toString('base64') };
  });
  // ---- P.7e: ekspor / impor SELURUH berkas database. Dibawa sebagai base64; jalur disk tidak pernah keluar dari Node.
  const tooBig = () => ek('e.db.tooBig', null, 'Database terlalu besar (maksimal 5 MB)', 'toobig');
  const notSqlite = () => ek('e.db.notSqlite', null, 'Berkas ini bukan database SQLite', 'notdb');
  on('webDbExport', async (id, name) => {
    const dir = dataDir(id), st = dbFile(dir, name);
    if (st.size > MAX_XFER) throw tooBig();
    const f = path.join(dir, name);
    let ck = true; try { await runTool(id, { op: 'checkpoint', db: name }, true); } catch { ck = false; } // gabungkan WAL ke berkas utama
    let wal = 0; try { wal = fs.statSync(f + '-wal').size; } catch {}
    if (wal > 0 && !ck) throw ek('e.db.busy', null, 'Database sedang dipakai, coba lagi', 'busy'); // WAL belum tergabung: salinan bisa tidak lengkap
    let buf; try { buf = fs.readFileSync(f); } catch { throw ek('e.db.none', null, 'Database tidak ditemukan', 'nodb'); }
    if (buf.length > MAX_XFER) throw tooBig();
    if (buf.length < 16 || !buf.subarray(0, 16).equals(MAGIC)) throw notSqlite();
    return { ok: true, name, size: buf.length, data: buf.toString('base64') };
  });
  on('webDbImport', async (id, o) => {
    const dir = dataDir(id);
    o = o && typeof o === 'object' ? o : {};
    if (!nameOk(o.name)) throw ek('e.db.badName', null, 'Nama database tidak valid', 'badname');
    if (typeof o.data !== 'string') throw bad();
    if (o.data.length > Math.ceil(MAX_XFER / 3) * 4 + 4) throw tooBig();
    if (!B64_RE.test(o.data)) throw bad();
    const buf = Buffer.from(o.data, 'base64');
    if (buf.length > MAX_XFER) throw tooBig();
    if (buf.length < 512 || !buf.subarray(0, 16).equals(MAGIC)) throw notSqlite();
    if (o.overwrite != null && typeof o.overwrite !== 'boolean') throw bad();
    const over = o.overwrite === true;
    const final = path.join(dir, o.name);
    const taken = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
    if (!over && (taken(final) || SIDE.some((x) => taken(final + x)))) throw ek('e.db.exists', null, 'Database dengan nama itu sudah ada', 'exists');
    if (over) { // menimpa hanya berkas biasa: bukan symlink, bukan folder
      let st = null; try { st = fs.lstatSync(final); } catch {}
      if (st && !st.isFile()) throw ek('e.db.exists', null, 'Database dengan nama itu sudah ada', 'exists');
      if (st && !hasMagic(final)) throw ek('e.db.notSqlite', null, 'Berkas ini bukan database SQLite', 'notdb'); // jangan menimpa berkas lain yang kebetulan berekstensi .db
    }
    const tmpName = 'imp' + crypto.randomBytes(6).toString('hex') + '.db', tmp = path.join(dir, tmpName);
    try {
      fs.writeFileSync(tmp, buf, { flag: 'wx' });
      try { await runTool(id, { op: 'tables', db: tmpName }); } // harus terbuka sebagai SQLite oleh alat PHP
      catch (e) { if (e && e.code === 'busy') throw e; throw ek('e.db.importBad', null, 'Berkas tidak bisa dibuka sebagai database SQLite', 'importbad'); }
      if (!over) {
        try { fs.copyFileSync(tmp, final, fs.constants.COPYFILE_EXCL); }
        catch (e) { throw e && e.code === 'EEXIST' ? ek('e.db.exists', null, 'Database dengan nama itu sudah ada', 'exists') : ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io'); }
      } else {
        // WAL/SHM lama milik isi lama: kalau tertinggal, SQLite memadukannya dengan berkas baru dan merusaknya. Hapus dulu, lalu ganti atomik.
        try {
          for (const x of SIDE) { try { fs.unlinkSync(final + x); } catch (e) { if (e && e.code !== 'ENOENT') throw e; } }
          fs.renameSync(tmp, final);
        } catch { throw ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io'); }
      }
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    return { ok: true, name: o.name };
  });
  // ---- Buat / hapus database sebagai berkas (tanpa lewat PHP situs). Pola sama dengan webDbImport: tulis ke berkas sementara, buktikan terbuka lewat alat PHP, baru pasang secara eksklusif.
  const countDbs = (dir) => {
    let n = 0, ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of ents) if (e.isFile() && nameOk(e.name) && hasMagic(path.join(dir, e.name))) n++;
    return n;
  };
  on('webDbCreate', async (id, o) => {
    const dir = dataDir(id);
    o = o && typeof o === 'object' ? o : {};
    if (!nameOk(o.name)) throw ek('e.db.badName', null, 'Nama database tidak valid', 'badname');
    const final = path.join(dir, o.name);
    const taken = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
    if (taken(final) || SIDE.some((x) => taken(final + x))) throw ek('e.db.exists', null, 'Database dengan nama itu sudah ada', 'exists');
    if (countDbs(dir) >= MAX_ITEMS) throw ek('e.db.tooMany', { n: MAX_ITEMS }, 'Terlalu banyak database (maksimal {n})', 'toomany');
    const tmpName = 'imp' + crypto.randomBytes(6).toString('hex') + '.db', tmp = path.join(dir, tmpName);
    try {
      fs.writeFileSync(tmp, emptyDb(), { flag: 'wx' });
      try { await runTool(id, { op: 'tables', db: tmpName }); }
      catch (e) { if (e && e.code === 'busy') throw e; throw ek('e.db.importBad', null, 'Berkas tidak bisa dibuka sebagai database SQLite', 'importbad'); }
      try { fs.copyFileSync(tmp, final, fs.constants.COPYFILE_EXCL); }
      catch (e) { throw e && e.code === 'EEXIST' ? ek('e.db.exists', null, 'Database dengan nama itu sudah ada', 'exists') : ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io'); }
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    return { ok: true, name: o.name };
  });
  on('webDbReset', async (id, name) => {
    const dir = dataDir(id);
    dbFile(dir, name);
    const j = await runTool(id, { op: 'reset', db: name }, true);
    return { ok: true, tables: int(j.tables) || 0, rows: int(j.rows) || 0 };
  });
  on('webDbDrop', async (id, name) => {
    const dir = dataDir(id);
    dbFile(dir, name); // nama sah, berkas biasa (bukan symlink / folder), berkepala SQLite; mysql.sqlite ditolak oleh nameOk
    const f = path.join(dir, name);
    // Berkas utama DULU: bila gagal (dipakai proses lain), tidak ada yang berubah. Sisa -wal/-shm/-journal sesudahnya, supaya tidak menempel ke database baru bernama sama.
    try { fs.unlinkSync(f); }
    catch (e) { throw e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') ? ek('e.db.busy', null, 'Database sedang dipakai, coba lagi', 'busy') : e && e.code === 'ENOENT' ? ek('e.db.none', null, 'Database tidak ditemukan', 'nodb') : ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io'); }
    for (const x of SIDE) { try { fs.unlinkSync(f + x); } catch (e) { if (!e || e.code !== 'ENOENT') throw ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io'); } }
    return { ok: true, name };
  });

  // ---- Impor dump MySQL (fase 1c). Satu operasi per situs (Choose + Commit), supaya dua klik cepat tidak saling menimpa token. ----
  const importing = new Set();
  const impHost = () => {
    const host = typeof getPhpHost === 'function' ? getPhpHost() : null;
    if (!host || !host.mysqlImport) throw ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    return host.mysqlImport;
  };
  const guard1 = async (id, fn) => {
    if (importing.has(id)) throw ek('e.db.imp.busy', null, 'Impor MySQL lain sedang berjalan untuk situs ini', 'busy');
    importing.add(id);
    try { return await fn(); } finally { importing.delete(id); }
  };
  // Isi pratinjau berasal dari berkas pengguna (tidak tepercaya): daftar dipotong, teks dipendekkan dan dibersihkan dari karakter kontrol.
  const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
  const list = (a, n, m, f) => (Array.isArray(a) ? a.slice(0, n).map(f || ((x) => txt(x, m))) : []);
  const cleanPreview = (p) => {
    p = p && typeof p === 'object' ? p : {};
    const tables = Array.isArray(p.tables) ? p.tables : [];
    return {
      ok: p.ok === true,
      tables: tables.slice(0, 1000).map((t) => ({ name: txt(t && t.name, 200), action: t && t.action === 'drop' ? 'drop' : 'create' })),
      moreTables: Math.max(0, tables.length - 1000),
      skippable: list(p.skippable, 200, 300),
      warnings: list(p.warnings, 10, 300),
      errors: list(p.errors, 20, 0, (e) => ({ line: int(e && e.line) || 0, message: txt(e && e.message, 300) })),
      willReplace: list(p.willReplace, 1000, 200),
      stats: { statements: int(p.stats && p.stats.statements) || 0, bytes: int(p.stats && p.stats.bytes) || 0, lines: int(p.stats && p.stats.lines) || 0 },
    };
  };
  on('webDbMysqlChoose', async (id) => {
    dataDir(id); // id sah + situs ada + Mesin PHP menyala
    const imp = impHost();
    return guard1(id, async () => {
      if (typeof pickSql !== 'function') throw ek('e.db.imp.noDialog', null, 'Memilih berkas dump hanya bisa dari aplikasi desktop', 'nodialog');
      const f = await pickSql();
      if (!f) return { ok: true, canceled: true };
      let st; try { st = fs.statSync(f); } catch { throw ek('e.db.imp.notFile', null, 'Berkas dump tidak bisa dibaca', 'nofile'); }
      if (!st.isFile()) throw ek('e.db.imp.notFile', null, 'Berkas dump tidak bisa dibaca', 'nofile');
      if (st.size > MAX_DUMP) throw ek('e.db.imp.tooBig', { max: '500 MB' }, 'Berkas dump terlalu besar (maksimal {max})', 'toobig');
      let text; try { text = await fs.promises.readFile(f, 'utf8'); } catch { throw ek('e.db.imp.notFile', null, 'Berkas dump tidak bisa dibaca', 'nofile'); }
      let r; try { r = await imp.prepare(id, text); } catch (e) { throw impErr(e); }
      return { ok: true, token: r && typeof r.token === 'string' && TOKEN_RE.test(r.token) ? r.token : null, file: txt(path.basename(f), 200), size: st.size, preview: cleanPreview(r && r.preview) };
    });
  });
  const impErr = (e) => {
    if (e && e.ek) return e;
    const c = e && e.code;
    if (c === 'EXPIRED') return ek('e.db.imp.expired', null, 'Pratinjau impor sudah kedaluwarsa. Pilih berkas dump lagi.', 'expired');
    if (c === 'BUSY') return ek('e.db.busy', null, 'Database sedang dipakai, coba lagi', 'busy');
    if (c === 'NOMYSQL') return ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    if (c === 'IMPORT') return ek('e.db.imp.fail', { m: txt(e.message, 400) }, 'Impor gagal: {m}', 'import');
    return ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io');
  };
  on('webDbMysqlCommit', async (id, token) => {
    dataDir(id);
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw bad();
    const imp = impHost();
    return guard1(id, async () => {
      let r; try { r = await imp.commit(id, token); } catch (e) { throw impErr(e); }
      return { ok: true, tables: int(r && r.tables) || 0, rows: int(r && r.rows) || 0, skipped: list(r && r.skipped, 200, 300), warnings: list(r && r.warnings, 10, 300), ms: int(r && r.ms) || 0 };
    });
  });
  on('webDbMysqlCancel', async (id, token) => {
    dataDir(id);
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw bad();
    try { await impHost().cancel(id, token); } catch { /* token sudah tidak ada / Worker berhenti: hasil yang sama */ }
    return { ok: true };
  });

  // ---- Ekspor dump MySQL (fase 3-4). Memakai penjaga yang sama dengan impor: satu operasi MySQL per situs. ----
  const expHost = () => {
    const host = typeof getPhpHost === 'function' ? getPhpHost() : null;
    if (!host || !host.mysqlExport) throw ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    return host.mysqlExport;
  };
  const inside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
  const realParent = (f) => { try { return fs.realpathSync(path.dirname(f)); } catch { return path.dirname(f); } };
  const expErr = (e) => {
    if (e && e.ek) return e;
    const c = e && e.code;
    if (c === 'BUSY') return ek('e.db.busy', null, 'Database sedang dipakai, coba lagi', 'busy');
    if (c === 'NOMYSQL') return ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    if (c === 'NODB') return ek('e.db.exp.nodb', null, 'Database MySQL belum ada', 'nodb');
    if (c === 'BADPATH') return ek('e.db.exp.badPath', null, 'Lokasi berkas tujuan tidak valid', 'badpath');
    if (c === 'EXPORTING') return ek('e.db.exp.busy', null, 'Ekspor MySQL lain sedang berjalan untuk situs ini', 'busy');
    if (c === 'EXPORT') return ek('e.db.exp.fail', { m: txt(e.message, 400) }, 'Ekspor gagal: {m}', 'export');
    return ek('e.db.wfail', null, 'Gagal menyimpan ke database', 'io');
  };
  on('webDbMysqlExport', async (id) => {
    const dir = dataDir(id); // id sah + situs ada + Mesin PHP menyala
    const exp = expHost();
    if (importing.has(id)) throw ek('e.db.exp.busy', null, 'Ekspor MySQL lain sedang berjalan untuk situs ini', 'busy');
    importing.add(id);
    try {
      if (typeof pickSave !== 'function') throw ek('e.db.imp.noDialog', null, 'Memilih berkas dump hanya bisa dari aplikasi desktop', 'nodialog');
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
      const f0 = await pickSave('mysql-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '.sql', 'sql');
      if (!f0 || typeof f0 !== 'string') return { ok: true, canceled: true };
      let out = path.resolve(f0);
      if (!path.extname(out) && !fs.existsSync(out + '.sql')) out += '.sql'; // dialog sistem tertentu tidak menambah ekstensi
      if (out.length > 1000 || out.includes('\0')) throw ek('e.db.exp.badPath', null, 'Lokasi berkas tujuan tidak valid', 'badpath');
      // Dump berisi seluruh data aplikasi: tidak boleh jatuh di dalam folder situs (www/ bisa dilayani PHP; data/ memuat mysql.sqlite sendiri).
      const root = (() => { try { return fs.realpathSync(path.dirname(dir)); } catch { return path.dirname(dir); } })();
      if (inside(root, path.join(realParent(out), path.basename(out)))) throw ek('e.db.exp.inside', null, 'Lokasi tujuan tidak boleh di dalam folder situs ini (dump bisa terbaca dari web)', 'inside');
      let r;
      try {
        r = await exp.run(id, out, (pr) => { if (typeof send === 'function') { try { send('webdbprog', { id, tables: int(pr && pr.tables) || 0, rows: int(pr && pr.rows) || 0, bytes: int(pr && pr.bytes) || 0 }); } catch {} } });
      } catch (e) {
        if (e && e.code === 'CANCELLED') return { ok: true, canceled: true, aborted: true };
        throw expErr(e);
      }
      return {
        ok: true, name: txt(path.basename(out), 200), size: int(r && r.bytes) || 0, tables: int(r && r.tables) || 0, rows: int(r && r.rows) || 0,
        skipped: list(r && r.skipped, 200, 300, (x) => txt((x && x.kind) + ' ' + (x && x.name), 300)),
        warnings: list(r && r.warnings, 10, 300), warningsN: Array.isArray(r && r.warnings) ? r.warnings.length : 0, ms: int(r && r.ms) || 0,
      };
    } finally { importing.delete(id); }
  });
  // ---- Buat database MySQL (fase 5e). Memakai penjaga yang sama dengan impor/ekspor: satu operasi MySQL per situs. Tidak menyalakan server. ----
  const creErr = (e) => {
    if (e && e.ek) return e;
    const c = e && e.code;
    if (c === 'NOMYSQL') return ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    if (c === 'BADDB') return ek('e.db.cre.badDb', null, 'mysql.sqlite sudah ada tetapi bukan database SQLite yang sah; tidak diubah', 'baddb');
    return ek('e.db.cre.fail', null, 'Gagal membuat database MySQL', 'io');
  };
  on('webDbMysqlCreate', async (id) => {
    dataDir(id); // id sah + situs ada + Mesin PHP menyala
    const host = typeof getPhpHost === 'function' ? getPhpHost() : null;
    if (!host || !host.mysqlCreate) throw ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    if (importing.has(id)) throw ek('e.db.cre.busy', null, 'Operasi MySQL lain sedang berjalan untuk situs ini', 'busy');
    importing.add(id);
    try {
      let r; try { r = await host.mysqlCreate.run(id); } catch (e) { throw creErr(e); }
      const port = int(r && r.port);
      return { ok: true, created: !!(r && r.created === true), port: port > 1023 && port < 65536 ? port : null };
    } finally { importing.delete(id); }
  });
  // ---- Nyalakan / matikan server MySQL (fase 6d). Penjaga sama dengan impor/ekspor/buat: satu operasi MySQL per situs (mematikan Worker di tengah impor/ekspor tidak boleh). ----
  // Nyalakan = hidupkan Worker (atau pakai yang sudah ada) lalu PIN: server milik pemilik tidak ikut mati saat Mesin PHP situs dimatikan. Matikan = paksa, juga yang di-pin.
  const powHost = () => {
    const host = typeof getPhpHost === 'function' ? getPhpHost() : null;
    if (!host || !host.mysqlPower) throw ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
    return host.mysqlPower;
  };
  const powBusy = () => ek('e.db.pow.busy', null, 'Operasi MySQL lain sedang berjalan untuk situs ini', 'busy');
  on('webDbMysqlStart', async (id) => {
    const dir = dataDir(id); // id sah + situs ada + Mesin PHP menyala
    const pow = powHost();
    if (importing.has(id)) throw powBusy();
    importing.add(id);
    try {
      let isDb = false; try { const f = path.join(dir, 'mysql.sqlite'); isDb = fs.lstatSync(f).isFile() && hasMagic(f); } catch {}
      if (!isDb) throw ek('e.db.exp.nodb', null, 'Database MySQL belum ada', 'nodb'); // Worker akan membuat berkas kosong sendiri; pemilik harus membuatnya lewat Buat database
      let r; try { r = await pow.start(id); } catch { throw ek('e.db.pow.startFail', null, 'Gagal menyalakan server MySQL', 'io'); }
      if (!r) throw ek('e.db.imp.noMysql', null, 'Server MySQL tidak tersedia di perangkat ini', 'nomysql');
      const port = int(r.port);
      return { ok: true, running: true, port: port > 1023 && port < 65536 ? port : null, already: r.already === true };
    } finally { importing.delete(id); }
  });
  on('webDbMysqlStop', async (id) => {
    // Sengaja TIDAK lewat dataDir()/paths(): server yang di-pin boleh tetap hidup setelah Mesin PHP situs dimatikan, dan harus tetap bisa dimatikan.
    if (typeof id !== 'string' || !HEX16.test(id)) throw bad();
    if (!core.webStore().has(id)) throw ek('e.lw.siteNone', null, 'Situs tidak ditemukan', 'nosite');
    const pow = powHost();
    if (importing.has(id)) throw powBusy();
    importing.add(id);
    try {
      let stopped; try { stopped = await pow.stop(id); } catch { throw ek('e.db.pow.stopFail', null, 'Gagal mematikan server MySQL', 'io'); }
      return { ok: true, stopped: stopped === true };
    } finally { importing.delete(id); }
  });
  on('webDbMysqlExportCancel', async (id) => {
    dataDir(id);
    try { await expHost().cancel(id); } catch { /* tidak ada ekspor berjalan / Worker berhenti: hasil yang sama */ }
    return { ok: true };
  });
}

module.exports = { registerWebDb, nameOk };
