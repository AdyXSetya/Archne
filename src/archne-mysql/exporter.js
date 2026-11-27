'use strict';
// Fase 3-3 — layanan ekspor dump MySQL. Berjalan DI DALAM Worker MySQL (worker.js): mysql.sqlite tetap hanya disentuh Worker (nameOk() tidak diubah).
//   run({ out, onProgress }) → { ok, path, tables, rows, bytes, statements, skipped[], warnings[], nulText, nonFinite, bigStatements, ms }
//   cancel()                 → true bila ada ekspor berjalan (ekspor berhenti di potongan berikutnya, berkas sementara dihapus)
// Data dibaca lewat dump-writer.dumpChunks (SATU transaksi baca = satu snapshot, memori kecil) dan ditulis ke `out + '.part'` lalu di-rename ke `out`
// hanya bila selesai utuh: ekspor gagal/dibatalkan tidak pernah meninggalkan dump setengah jadi di tempat yang dipilih pengguna.
// Koneksi sendiri dengan query_only=1 (tulis ditolak SQLite sendiri). Di antara potongan, event loop Worker diberi giliran supaya PHP tetap terlayani.
// Galat: Error dengan .code ∈ NODB BUSY BADPATH EXPORTING CANCELLED EXPORT
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { dumpChunks } = require('./dump-writer.js');

const FLUSH_BYTES = 262144, PROGRESS_MS = 250, YIELD_MS = 30;
const fail = (code, msg) => Object.assign(new Error(msg || code), { code });
const yieldLoop = () => new Promise((r) => setImmediate(r));
const isBusy = (e) => e && (e.errcode === 5 || /database is locked|SQLITE_BUSY/i.test(String(e.message)));

function createExportService({ file, busyMs = 10000, now = Date.now } = {}) {
  let cur = null;   // { cancelled }

  async function run({ out, onProgress } = {}) {
    if (cur) throw fail('EXPORTING', 'Ekspor lain masih berjalan.');
    if (typeof out !== 'string' || !path.isAbsolute(out) || out.includes('\0')) throw fail('BADPATH', 'Lokasi berkas tujuan tidak valid.');
    if (!file || !fs.existsSync(file)) throw fail('NODB', 'Belum ada database MySQL untuk diekspor.');
    const job = { cancelled: false }; cur = job;
    const part = out + '.part', t0 = now();
    let db = null, fh = null, done = false;
    try {
      try { db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout=' + (busyMs | 0) + '; PRAGMA query_only=1'); }
      catch (e) { throw isBusy(e) ? fail('BUSY', 'Database MySQL sedang dipakai aplikasi PHP; coba lagi sebentar lagi.') : e; }
      fh = await fs.promises.open(part, 'w');
      const stats = {};
      let buf = [], size = 0, lastP = 0, lastY = now();
      const emit = (final) => { if (onProgress && (final || now() - lastP >= PROGRESS_MS)) { lastP = now(); try { onProgress({ tables: stats.tables, rows: stats.rows, bytes: stats.bytes }); } catch (_) {} } };
      const flush = async () => { if (!size) return; const s = buf.join(''); buf = []; size = 0; await fh.write(s); };
      const gen = dumpChunks(db, { stats });
      try {
        for (const s of gen) {
          if (job.cancelled) throw fail('CANCELLED', 'Ekspor dibatalkan.');
          buf.push(s); size += s.length;
          if (size >= FLUSH_BYTES) await flush();
          emit(false);
          if (now() - lastY >= YIELD_MS) { await yieldLoop(); lastY = now(); }   // transaksi baca tetap terbuka (generator tertunda); PHP boleh menulis di sela, snapshot tidak berubah
        }
        if (job.cancelled) throw fail('CANCELLED', 'Ekspor dibatalkan.');
        await flush();
      } finally { try { gen.return(); } catch (_) {} }   // menutup transaksi baca bila berhenti di tengah
      await fh.sync(); await fh.close(); fh = null;
      await fs.promises.rename(part, out); done = true;
      emit(true);
      return { ok: true, path: out, tables: stats.tables, rows: stats.rows, bytes: stats.bytes, statements: stats.statements, skipped: stats.skipped, warnings: stats.warnings, nulText: stats.nulText, nonFinite: stats.nonFinite, bigStatements: stats.bigStatements, ms: now() - t0 };
    } catch (e) {
      if (e && e.code && /^(NODB|BUSY|BADPATH|EXPORTING|CANCELLED)$/.test(e.code)) throw e;
      if (isBusy(e)) throw fail('BUSY', 'Database MySQL sedang dipakai aplikasi PHP; coba lagi sebentar lagi.');
      throw fail('EXPORT', 'Ekspor gagal: ' + String((e && e.message) || e).slice(0, 300));
    } finally {
      if (fh) { try { await fh.close(); } catch (_) {} }
      if (!done) { try { await fs.promises.unlink(part); } catch (_) {} }
      if (db) { try { db.close(); } catch (_) {} }
      cur = null;
    }
  }

  function cancel() { if (!cur) return false; cur.cancelled = true; return true; }
  return { run, cancel, running: () => !!cur };
}

module.exports = { createExportService };
