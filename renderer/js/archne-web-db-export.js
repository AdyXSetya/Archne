// Web Lokal (fase 3-4): Ekspor dump MySQL di layar browser MySQL (webDbMysqlExport / webDbMysqlExportCancel). Dimuat SESUDAH archne-web-db-sql.js; memakai lwD, lwDbMsg, lwDbPaint, lwDbFail, lwDbSize, lwDbNum, txf, esc.
// Alur: Ekspor dump -> dialog simpan di proses utama (renderer tidak pernah melihat jalur) -> Worker menulis dump ke disk; kemajuan lewat event 'webdbprog' -> ringkasan.
// D.mx = null | { running:true } ; selama berjalan D.busy = true (tombol lain mati) dan hanya tombol Batalkan ekspor yang hidup. Pesan kemajuan lewat lwDbMsg (tanpa menggambar ulang).
// Teks dari database (nama tabel yang dilewati) tidak tepercaya: semua lewat esc() / textContent.
function lwDbMxBtn() { // dipanggil lwDbExpBtn() untuk layar MySQL
  const D = lwD; if (!D) return '';
  if (D.mx) return `<button type="button" class="sec" data-lw="dbmyexpx">${esc(txf('lw.db.my.expCancel', 'Batalkan ekspor'))}</button>`;
  return `<button type="button" class="sec" data-lw="dbmyexp"${D.busy ? ' disabled' : ''}>${esc(txf('lw.db.my.export', 'Ekspor dump MySQL'))}</button>`;
}
function lwDbMxProg(p) { // event 'webdbprog': { id, tables, rows, bytes }
  const D = lwD; if (!D || !D.mx || !p || p.id !== D.id) return;
  lwDbMsg(txf('lw.db.my.expProg', 'Mengekspor… {t} tabel, {r} baris, {s}', { t: lwDbNum(p.tables), r: lwDbNum(p.rows), s: lwDbSize(lwDbNum(p.bytes)) }), false);
}
async function lwDbMxRun() {
  const D = lwD; if (!D || D.busy || D.mx || !D.ro) return;
  D.mx = { running: true }; D.busy = true; D.msg = txf('lw.db.my.expStart', 'Memilih lokasi simpan…'); D.msgErr = false; lwDbPaint();
  let r; try { r = await window.api.webDbMysqlExport(D.id); } catch (x) { r = null; }
  if (D !== lwD) return; // tab ditinggalkan selagi mengekspor: Worker tetap menyelesaikannya
  D.mx = null; D.busy = false; D.msg = ''; D.msgErr = false;
  if (r && r.canceled === true) { if (r.aborted === true) D.msg = txf('lw.db.my.expAborted', 'Ekspor dibatalkan. Tidak ada berkas yang tersimpan.'); lwDbPaint(); return; }
  if (!(r && r.ok)) { D.msg = lwDbFail(r); D.msgErr = true; lwDbPaint(); return; }
  const sk = Array.isArray(r.skipped) ? r.skipped.filter((x) => typeof x === 'string') : [], wn = lwDbNum(r.warningsN);
  D.msg = txf('lw.db.my.expDone', 'Dump diekspor: {n} · {t} tabel, {r} baris, {s}.', { n: typeof r.name === 'string' ? r.name : '', t: lwDbNum(r.tables), r: lwDbNum(r.rows), s: lwDbSize(lwDbNum(r.size)) })
    + (sk.length ? ' ' + txf('lw.db.my.expSkipped', 'Dilewati: {list}.', { list: lwDbMyJoin(sk, 5) }) : '')
    + (wn ? ' ' + txf('lw.db.my.expWarn', '{n} peringatan dicatat di awal berkas.', { n: wn }) : '')
    + ' ' + txf('lw.db.my.expTypes', 'Tipe MySQL asli dipakai bila tersimpan dan datanya muat; selain itu diturunkan dari isi data.');
  lwDbPaint();
}
function lwDbMxStop() { // batalkan ekspor yang berjalan; hasil akhirnya (aborted) tiba lewat lwDbMxRun
  const D = lwD; if (!D || !D.mx) return;
  try { const p = window.api.webDbMysqlExportCancel(D.id); if (p && p.catch) p.catch(() => {}); } catch (x) { /* sudah selesai = sama saja */ }
}
function lwDbMxAct(act) {
  if (act === 'dbmyexp') { lwDbMxRun(); return true; }
  if (act === 'dbmyexpx') { lwDbMxStop(); return true; }
  return false;
}
if (window.api && typeof window.api.onWebDbProg === 'function') window.api.onWebDbProg(lwDbMxProg);
