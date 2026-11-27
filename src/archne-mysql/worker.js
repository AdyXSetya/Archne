'use strict';
// Isi Worker server MySQL palsu (P.9 integrasi): satu per situs PHP, di thread sendiri supaya SQLite sinkron tidak membekukan proses utama.
// workerData: { file, port, lockWaitMs }. Pesan keluar: { ready:true, port } | { fatal } | { id, ok, result|error } (balasan permintaan).
// Pesan masuk (fase 1b, impor dump): { id, op:'import-prepare', text } | { id, op:'import-commit', token } | { id, op:'import-cancel', token }
//   (fase 2a, browser baca-saja): { id, op:'browse-tables' } | { id, op:'browse-rows', args } | { id, op:'browse-exec', args } | { id, op:'browse-csv', args }
//   (fase 3-3, ekspor dump): { id, op:'export-run', out } (balasan perantara: { id, progress:{tables,rows,bytes} }) | { id, op:'export-cancel' }
const { parentPort, workerData: W } = require('worker_threads');
const { startFakeMysql } = require('./fakemysql.js');
const { createImportService } = require('./importer.js');
const { createBrowseService } = require('./browser.js');
const { createExportService } = require('./exporter.js');
(async () => {
  const opt = { file: W.file, user: null, host: '127.0.0.1', lockWaitMs: W.lockWaitMs || 5000, txMode: 'immediate' };
  let r;
  try { r = await startFakeMysql(Object.assign({ port: W.port || 0 }, opt)); }
  catch (e) { if (W.port && e && e.code === 'EADDRINUSE') r = await startFakeMysql(Object.assign({ port: 0 }, opt)); else throw e; }
  parentPort.postMessage({ ready: true, port: r.port });
})().catch((e) => parentPort.postMessage({ fatal: String((e && e.message) || e).slice(0, 500) }));
// Satu layanan impor per Worker (= per situs). Dibuat malas supaya boot Worker tidak berubah bagi situs yang tak pernah mengimpor.
let imp = null;
const svc = () => imp || (imp = createImportService({ file: W.file, lockWaitMs: Math.max(W.lockWaitMs || 0, 10000) }));
// Browser baca-saja (fase 2a): koneksi sendiri per permintaan dengan query_only; dibuat malas seperti layanan impor.
let brw = null;
const bsvc = () => brw || (brw = createBrowseService({ file: W.file }));
// Ekspor dump (fase 3-3): satu per Worker, dibuat malas. Menulis ke disk dari Worker sendiri; jalur berkas dipilih main process lewat dialog simpan.
let exp = null;
const esvc = () => exp || (exp = createExportService({ file: W.file }));
parentPort.on('message', async (m) => {
  if (!m || m.id == null || typeof m.op !== 'string') return;
  const reply = (o) => parentPort.postMessage(Object.assign({ id: m.id }, o));
  try {
    if (m.op === 'import-prepare') return reply({ ok: true, result: svc().prepare(String(m.text == null ? '' : m.text)) });
    if (m.op === 'import-commit') return reply({ ok: true, result: await svc().commit(String(m.token || '')) });
    if (m.op === 'import-cancel') return reply({ ok: true, result: svc().cancel(m.token ? String(m.token) : null) });
    if (m.op === 'browse-tables') return reply({ ok: true, result: bsvc().tables() });
    if (m.op === 'browse-rows') return reply({ ok: true, result: bsvc().rows(m.args) });
    if (m.op === 'browse-exec') return reply({ ok: true, result: bsvc().exec(m.args) });
    if (m.op === 'browse-csv') return reply({ ok: true, result: bsvc().csv(m.args) });
    if (m.op === 'export-run') return reply({ ok: true, result: await esvc().run({ out: m.out, onProgress: (p) => parentPort.postMessage({ id: m.id, progress: p }) }) });
    if (m.op === 'export-cancel') return reply({ ok: true, result: esvc().cancel() });
    reply({ ok: false, error: { message: 'op tidak dikenal: ' + m.op } });
  } catch (e) { reply({ ok: false, error: { message: String((e && e.message) || e).slice(0, 600), code: e && e.code || null, line: e && e.line || null } }); }
});
