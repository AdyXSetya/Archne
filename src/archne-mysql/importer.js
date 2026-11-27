'use strict';
// Fase 1b — layanan impor dump MySQL ke mysql.sqlite. Berjalan DI DALAM Worker MySQL (worker.js), sehingga file yang sama
// tidak pernah disentuh dari jalur lain (nameOk() tetap menolak mysql.sqlite).
//   prepare(text) → { token, preview }   parse + validasi DDL; hasil parse ditahan di memori Worker dengan token acak
//   commit(token) → laporan              satu transaksi BEGIN IMMEDIATE … COMMIT; gagal = ROLLBACK, tidak ada yang berubah
//   cancel(token)
// Satu impor tertunda per situs; prepare baru menggantikan yang lama. Token kedaluwarsa setelah 30 menit.
const crypto = require('crypto');
const { Engine } = require('./engine.js');
const { translate } = require('./mysql2sqlite.js');
const { parseDump, summarizeSkipped, toPreview } = require('./dump-parser.js');

const TOKEN_TTL = 30 * 60 * 1000;
const isBusy = (e) => e && (e.errcode === 5 || /database is locked|SQLITE_BUSY/i.test(String(e.message)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldLoop = () => new Promise((r) => setImmediate(r));

function createImportService({ file, lockWaitMs = 10000, yieldEveryMs = 40, now = Date.now } = {}) {
  let pending = null; // { token, parsed, at }

  // Engine sementara dengan koneksi sendiri: busyTimeout 0 (tunggu kunci dilakukan asinkron, bukan membekukan Worker).
  const open = () => new Engine({ file, busyTimeout: 0, txMode: 'immediate' });

  function existingTables() {
    const eng = open();
    try { return new Set(eng.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)); }
    finally { try { eng.db.close(); } catch (_) {} }
  }

  function prepare(text) {
    const parsed = parseDump(text);
    const pv = toPreview(parsed);
    // Validasi DDL lebih awal supaya galat "tidak didukung" muncul di pratinjau, bukan setelah klik Impor.
    // INSERT tidak diterjemahkan di sini (mahal untuk dump besar; gagal di commit = ROLLBACK + nomor baris).
    for (const st of parsed.statements) {
      if (st.type === 'insert') continue;
      try { translate(st.sql); } catch (e) { pv.errors.push({ line: st.line, message: String((e && e.message) || e).slice(0, 300) }); }
    }
    const named = new Set(parsed.tables.map((t) => t.name));
    let have; try { have = existingTables(); } catch (_) { have = new Set(); }
    const out = Object.assign(pv, {
      willReplace: [...named].filter((n) => have.has(n)),
      stats: { statements: parsed.stats.exec, bytes: parsed.stats.bytes, lines: parsed.stats.lines },
    });
    out.ok = pv.errors.length === 0 && parsed.statements.length > 0;
    if (!parsed.statements.length && !pv.errors.length) out.errors.push({ line: 0, message: 'Dump tidak berisi pernyataan yang bisa diimpor.' });
    if (!out.ok) { pending = null; return { token: null, preview: out }; }   // tidak ada yang bisa dikonfirmasi
    const token = crypto.randomBytes(12).toString('hex');
    pending = { token, parsed, at: now() };
    return { token, preview: out };
  }

  async function commit(token) {
    if (!pending || pending.token !== token || now() - pending.at > TOKEN_TTL) { if (pending && now() - pending.at > TOKEN_TTL) pending = null; throw Object.assign(new Error('Pratinjau impor sudah kedaluwarsa. Pilih berkas dump lagi.'), { code: 'EXPIRED' }); }
    const { parsed } = pending, t0 = now();
    const eng = open();
    let began = false, cur = null, rows = 0, last = now();
    const created = new Set();
    try {
      // Dump MySQL membuang/membuat tabel tanpa memedulikan urutan kunci asing (SET FOREIGN_KEY_CHECKS=0); PRAGMA ini tak berlaku di dalam transaksi, jadi diset dulu.
      eng.db.exec('PRAGMA foreign_keys=OFF');
      for (const w0 = now(); ;) {
        try { eng.query('BEGIN'); began = true; break; }
        catch (e) { if (!isBusy(e) || now() - w0 >= lockWaitMs) throw Object.assign(new Error(isBusy(e) ? 'Database MySQL sedang dipakai aplikasi PHP; coba lagi sebentar lagi.' : e.message), { code: isBusy(e) ? 'BUSY' : undefined }); }
        await sleep(25);
      }
      for (const st of parsed.statements) {
        cur = st;
        for (let tries = 0; ; tries++) {   // PHP bisa memegang kunci tulis sesaat di tengah; BEGIN IMMEDIATE kita sudah memilikinya, jadi ini jarang
          try { const r = eng.query(st.sql); if (st.type === 'insert') rows += Number(r.changes) || 0; break; }
          catch (e) { if (!isBusy(e) || tries > 200) throw e; await sleep(25); }
        }
        if (st.type === 'create_table') created.add(st.table);
        if (now() - last >= yieldEveryMs) { await yieldLoop(); last = now(); }   // beri Worker kesempatan melayani koneksi lain di antara pernyataan
      }
      eng.query('COMMIT');
      began = false;
      const warnings = parsed.warnings.slice();   // (FOREIGN KEY dibuang penerjemah — tak ada pemeriksaan kunci asing pascaimpor)
      pending = null;
      return { ok: true, tables: created.size, rows, skipped: summarizeSkipped(parsed.skipped), warnings, ms: now() - t0 };
    } catch (e) {
      if (began) { try { eng.query('ROLLBACK'); } catch (_) {} }
      const msg = String((e && e.message) || e).slice(0, 400);
      const err = new Error(cur ? 'Baris ' + cur.line + ' (' + cur.type + (cur.table ? ' ' + cur.table : '') + '): ' + msg + ' — impor dibatalkan, tidak ada yang berubah.' : msg);
      err.code = cur ? 'IMPORT' : (e.code || 'IMPORT'); err.line = cur ? cur.line : null; throw err;
    } finally { try { eng.db.close(); } catch (_) {} }
  }

  function cancel(token) { if (pending && (!token || pending.token === token)) pending = null; return true; }
  return { prepare, commit, cancel, hasPending: () => !!pending };
}

module.exports = { createImportService };
