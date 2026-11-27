// Web Lokal (0.34.0 Fase P.7f): bagian tab Database untuk kotak SQL (webDbExec), ekspor CSV per tabel (webDbCsv), pembantu unduhan, Reset data, dan Impor dump MySQL (webDbMysqlChoose / Commit / Cancel). Dipisah dari archne-web-db.js (batas ukuran berkas, test/size-guard.js).
// Dimuat SESUDAH archne-web-db.js dan memakai status dan pembantunya (lwD, lwDbOn, lwDbPaint, lwDbTbl, lwDbCell, lwDbFail, lwDbMsg, lwDbChipsHtml). Aturan sama: semua teks dari database / galat lewat esc(); mode tulis tidak pernah "menempel".
function lwDbDownload(b64, name, mime) { // true bila unduhan dimulai
  try {
    const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([u], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (x) { return false; }
}
async function lwDbCsv() {
  const D = lwD, t = lwDbTbl(); if (!D || D.busy || !t) return;
  const name = D.name, ti = D.ti; D.busy = true; lwDbMsg(txf('lw.db.csving', 'Menyiapkan CSV…'), false);
  let r; try { r = await window.api.webDbCsv(D.id, name, Object.assign({ table: t.name }, lwDbRo())); } catch (x) { r = null; }
  if (D !== lwD) return; D.busy = false;
  if (D.name !== name || D.ti !== ti) return;
  if (!(r && r.ok && typeof r.data === 'string')) { lwDbMsg(lwDbFail(r), true); return; }
  const fn = typeof r.name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(r.name) ? r.name : 'tabel.csv';
  if (lwDbDownload(r.data, fn, 'text/csv;charset=utf-8')) lwDbMsg(txf('lw.db.csved', 'CSV diekspor: {n}', { n: fn }), false); else lwDbMsg(txf('lw.db.exportFail', 'Gagal menyiapkan unduhan'), true);
}
// ---- kotak SQL (P.7f) ----
function lwDbSqlText(v) { if (lwD) lwD.sqlText = String(v == null ? '' : v); }
function lwDbSqlW(on) { if (lwD) lwD.sqlW = !!on && !lwD.ro; const el = $('lwdb-warn'); if (el) el.hidden = !on; }
function lwDbSqlPaint() { const el = $('lwdb-sqlres'); if (el && lwDbOn()) el.innerHTML = lwDbSqlResHtml(); else lwDbPaint(); }
async function lwDbRun() {
  const D = lwD; if (!D || D.busy || !D.name) return;
  const ta = $('lwdb-sql'); if (ta) D.sqlText = ta.value;
  const wb = $('lwdb-w'); if (wb) D.sqlW = wb.checked;
  const sql = D.sqlText; if (!sql.trim()) return;
  const name = D.name, w = D.sqlW === true && !D.ro; D.busy = true; D.sqlErr = ''; D.sqlRes = null;
  const rb = $('lwdb-run'); if (rb) rb.disabled = true;
  let r; try { r = await window.api.webDbExec(D.id, name, w ? { sql, write: true } : Object.assign({ sql }, lwDbRo())); } catch (x) { r = null; }
  if (D !== lwD) return; D.busy = false;
  if (D.name !== name) return;
  if (r && r.ok) D.sqlRes = r; else D.sqlErr = lwDbFail(r);
  if (w) { D.sqlW = false; const wb2 = $('lwdb-w'); if (wb2) wb2.checked = false; const wn = $('lwdb-warn'); if (wn) wn.hidden = true; } // mode tulis tidak "menempel": harus dicentang lagi untuk tiap eksekusi
  if (rb) rb.disabled = false;
  lwDbSqlPaint();
  if (w && r && r.ok) lwDbReloadTables(); // jumlah baris / tabel baru
}
async function lwDbReloadTables() {
  const D = lwD; if (!D || !D.name) return;
  const name = D.name, cur = lwDbTbl() && lwDbTbl().name;
  let r; try { r = await window.api.webDbTables(D.id, name, lwDbRo()); } catch (x) { r = null; }
  if (D !== lwD || D.name !== name || !(r && r.ok)) return;
  D.tables = Array.isArray(r.tables) ? r.tables : []; D.trunc = !!r.truncated;
  const k = D.tables.findIndex((t) => t && t.name === cur); D.ti = k >= 0 ? k : (D.tables.findIndex((t) => t && !t.internal));
  D.res = null; D.off = 0; D.form = null; D.del = -1;
  // tidak menggambar ulang layar SQL (teks dan hasil tetap); tabel baru muncul di deretan tabel saat pindah tab
  const chips = document.querySelector('#lwsb .lwdbchips'); if (chips && lwDbOn()) lwDbPaintChips();
}
function lwDbPaintChips() {
  const D = lwD, el = document.querySelector('#lwsb .lwdbchips'); if (!D || !el || !D.tables) return;
  el.innerHTML = lwDbChipsHtml();
}
function lwDbSqlResHtml() {
  const D = lwD; if (!D) return '';
  if (D.sqlErr) return `<p class="lwnote err" role="alert">${esc(D.sqlErr)}</p>`;
  const r = D.sqlRes; if (!r) return '';
  const cols = Array.isArray(r.columns) ? r.columns : [], rows = Array.isArray(r.rows) ? r.rows : [];
  if (!cols.length) return `<p class="lwnote" role="status">${esc(Number.isSafeInteger(r.changes) ? txf('lw.db.sqlChanges', '{n} baris berubah', { n: r.changes }) : txf('lw.db.sqlDone', 'Selesai'))}</p>`;
  if (!rows.length) return `<p class="lwempty">${esc(txf('lw.db.sqlEmpty', 'Tidak ada baris'))}</p>`;
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.map((row) => '<tr>' + (Array.isArray(row) ? row : []).map((v) => `<td>${lwDbCell(v)}</td>`).join('') + '</tr>').join('');
  const note = txf('lw.db.sqlRows', '{n} baris', { n: rows.length }) + (r.more ? ' · ' + txf('lw.db.sqlMore', 'Hanya 500 baris pertama yang ditampilkan.') : '');
  return `<p class="lwnote" role="status">${esc(note)}</p><div class="lwdbwrap"><table class="lwdbt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function lwDbSqlHtml() {
  const D = lwD; if (!D) return '';
  const ro = D.ro === true;
  return `<p class="lwnote">${esc(ro ? txf('lw.db.my.sqlHint', 'Satu pernyataan per eksekusi. Browser MySQL hanya membaca: SELECT, SHOW, DESCRIBE, EXPLAIN.') : txf('lw.db.sqlHint', 'Satu pernyataan per eksekusi. Bawaannya hanya membaca (SELECT).'))}</p>`
    + `<textarea id="lwdb-sql" class="lwdbsql" rows="6" maxlength="100000" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="${esc(txf('lw.db.sqlPh', 'SELECT * FROM nama_tabel LIMIT 10'))}" aria-label="SQL">${'\n' + esc(D.sqlText)}</textarea>`
    + `<div class="lwbar"><button type="button" id="lwdb-run" data-lw="dbrun"${D.busy ? ' disabled' : ''}>${esc(txf('lw.db.sqlRun', 'Jalankan'))}</button><label class="lwdbnl"><input type="checkbox" id="lwdb-w"${ro ? ' disabled' : D.sqlW ? ' checked' : ''}> ${esc(ro ? txf('lw.db.my.locked', 'Mode tulis terkunci: browser MySQL hanya membaca') : txf('lw.db.sqlWrite', 'Mode tulis: boleh mengubah database'))}</label></div>`
    + `<p id="lwdb-warn" class="lwnote err"${D.sqlW ? '' : ' hidden'}>${esc(txf('lw.db.sqlWarn', 'Mode tulis mengubah database langsung dan tidak bisa dibatalkan. Ekspor dulu bila ragu.'))}</p>`
    + `<div id="lwdb-sqlres">${lwDbSqlResHtml()}</div>`;
}

// Reset data (layar satu database): kosongkan semua tabel, struktur tetap. Dua langkah: tombol Reset data -> kalimat konfirmasi yang menyebut nama -> "Reset sekarang".
// D.rs = NAMA database yang menunggu konfirmasi (bukan boolean): berpindah database tidak pernah membawa konfirmasi ke database lain.
function lwDbResetBtn() {
  const D = lwD; if (!D || !D.name || D.ro || !Array.isArray(D.tables) || !D.tables.length) return '';
  return `<button type="button" class="sec" data-lw="dbreset"${D.busy ? ' disabled' : ''}>${esc(txf('lw.db.reset', 'Reset data'))}</button>`;
}
function lwDbResetAsk() { // di layar MySQL (baca-saja) tempat ini juga memuat panel Impor dump
  const D = lwD; if (D && D.ro) return lwDbMyHtml(); if (!D || !D.name || D.rs !== D.name) return '';
  return `<p class="lwnote err" role="alert">${esc(txf('lw.db.resetAsk', 'Hapus SEMUA data di "{n}"? Semua baris di semua tabel dihapus, struktur (tabel, kolom, indeks) tetap. Tidak bisa dibatalkan.', { n: D.name }))} <button type="button" data-lw="dbresetok"${D.busy ? ' disabled' : ''}>${esc(txf('lw.db.resetOk', 'Reset sekarang'))}</button> <button type="button" class="sec" data-lw="dbresetno">${esc(txf('lw.db.cancel', 'Batal'))}</button></p>`;
}
async function lwDbResetOk() {
  const D = lwD; if (!D || D.busy || D.ro || !D.name || D.rs !== D.name) return;
  const name = D.name; D.rs = ''; D.busy = true; D.msg = txf('lw.db.resetting', 'Mengosongkan…'); D.msgErr = false; lwDbPaint();
  let r; try { r = await window.api.webDbReset(D.id, name); } catch (x) { r = null; }
  if (D !== lwD) return;
  D.busy = false;
  if (D.name !== name) return;
  if (!(r && r.ok)) { D.msg = lwDbFail(r); D.msgErr = true; lwDbPaint(); return; }
  const n = (v) => (Number.isSafeInteger(v) ? v : 0), m = txf('lw.db.resetDone', 'Data dikosongkan: {r} baris dari {t} tabel. Struktur tetap.', { r: n(r.rows), t: n(r.tables) });
  await lwDbOpen(name); // muat ulang tabel + hitungan baris (lwDbOpen mengosongkan pesan, jadi pesan dipasang sesudahnya)
  if (D !== lwD || D.name !== name) return;
  D.msg = m; D.msgErr = false; lwDbPaint();
}
function lwDbActX(act) {
  const D = lwD; if (!D) return false;
  if (act === 'dbreset') { if (!D.busy && D.name && !D.ro) { D.rs = D.name; D.form = null; D.del = -1; D.msg = ''; D.msgErr = false; lwDbPaint(); } return true; }
  if (act === 'dbresetok') { lwDbResetOk(); return true; }
  if (act === 'dbresetno') { D.rs = ''; lwDbPaint(); return true; }
  if (act === 'dbmyopen') { if (!D.busy && D.myDb) lwDbOpen('mysql.sqlite', true); return true; }
  if (act === 'dbmycopy') { lwDbMyCopy(); return true; }
  if (act === 'dbmycreate') { lwDbMyCreate(); return true; }
  if (act === 'dbmystart' || act === 'dbmystop') { lwDbMyPower(act === 'dbmystart'); return true; }
  if (act === 'dbmypick') { lwDbMyPick(); return true; }
  if (act === 'dbmyok') { lwDbMyOk(); return true; }
  if (act === 'dbmyno') { lwDbMyDrop(D); lwDbPaint(); return true; }
  if (act === 'dbmyexp' || act === 'dbmyexpx') return lwDbMxAct(act); // ekspor dump MySQL: archne-web-db-export.js
  return false;
}

// ---- Impor dump MySQL (layar daftar database) ----
// Alur: Impor dump MySQL -> dialog .sql di proses utama (renderer hanya menerima nama berkas + ukuran) -> pratinjau -> "Impor sekarang" (SATU klik: daftar tabel yang diganti sudah terlihat) -> laporan.
// D.my = null | { token, file, size, pv } (pratinjau menunggu konfirmasi; token null = dump tidak bisa diimpor) | { rep } (laporan). Token dibuang (webDbMysqlCancel) bila pratinjau ditutup, tab ditinggalkan, atau balasan datang terlambat.
// Teks dari dump (nama tabel, galat, peringatan) tidak tepercaya: semua lewat esc().
const lwDbNum = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
function lwDbMyCancel(id, token) { if (!token) return; try { const p = window.api.webDbMysqlCancel(id, token); if (p && p.catch) p.catch(() => {}); } catch (x) { /* token kedaluwarsa = sama saja */ } }
function lwDbMyDrop(D) { if (!D) return; const my = D.my; D.my = null; if (my && my.token) lwDbMyCancel(D.id, my.token); }
function lwDbMyBtn() { return `<button type="button" class="sec" data-lw="dbmypick"${lwD && lwD.busy ? ' disabled' : ''}>${esc(txf('lw.db.my.import', 'Impor dump MySQL'))}</button>`; }
function lwDbMyJoin(a, max) { // "a, b, c, +N lainnya"
  const L = Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  return L.slice(0, max).join(', ') + (L.length > max ? ', ' + txf('lw.db.my.more', '+{n} lainnya', { n: L.length - max }) : '');
}
async function lwDbMyPick() {
  const D = lwD; if (!D || D.busy || (D.name && !D.ro)) return;
  lwDbMyDrop(D); D.cr = null; D.dr = null; D.ow = null;
  D.busy = true; D.msg = txf('lw.db.my.reading', 'Membaca dan memeriksa berkas dump…'); D.msgErr = false; lwDbPaint();
  let r; try { r = await window.api.webDbMysqlChoose(D.id); } catch (x) { r = null; }
  if (D !== lwD) { if (r && typeof r.token === 'string') lwDbMyCancel(D.id, r.token); return; } // tab ditinggalkan selagi memilih
  D.busy = false; D.msg = ''; D.msgErr = false;
  if (r && r.canceled === true) { lwDbPaint(); return; }
  if (!(r && r.ok && r.preview && typeof r.preview === 'object')) { D.msg = lwDbFail(r); D.msgErr = true; lwDbPaint(); return; }
  const pv = r.preview, good = pv.ok === true && typeof r.token === 'string' && r.token;
  D.my = { token: good ? r.token : null, file: typeof r.file === 'string' ? r.file : '', size: lwDbNum(r.size), pv };
  lwDbPaint();
}
async function lwDbMyOk() {
  const D = lwD, my = D && D.my; if (!D || D.busy || (D.name && !D.ro) || !my || !my.token) return;
  const token = my.token; D.my = null; D.busy = true; D.msg = txf('lw.db.my.importing', 'Mengimpor dump… Satu transaksi: bila gagal, tidak ada yang berubah.'); D.msgErr = false; lwDbPaint(); // token sekali pakai: dilepas sebelum panggilan
  let r; try { r = await window.api.webDbMysqlCommit(D.id, token); } catch (x) { r = null; }
  if (D !== lwD) return;
  D.busy = false; D.msg = '';
  if (r && r.ok) D.my = { rep: { tables: lwDbNum(r.tables), rows: lwDbNum(r.rows), skipped: Array.isArray(r.skipped) ? r.skipped : [], warnings: Array.isArray(r.warnings) ? r.warnings : [] } };
  else { D.msg = lwDbFail(r); D.msgErr = true; }
  lwDbPaint();
  if (r && r.ok) { if (D.ro) await lwDbOpen(D.name, true); if (D === lwD) lwDbLoadList(); } // tabel di layar MySQL dimuat ulang, lalu ukuran mysql.sqlite di daftar; berurutan karena berbagi D.seq (laporan tetap tampil)
}
function lwDbMyHtml() {
  const D = lwD, my = D && D.my; if (!my) return '';
  const note = (t, err) => `<p class="lwnote${err ? ' err' : ''}">${esc(t)}</p>`;
  const close = (k, fb) => `<button type="button" class="sec" data-lw="dbmyno">${esc(txf(k, fb))}</button>`;
  const skipped = (a) => (Array.isArray(a) && a.length ? note(txf('lw.db.my.skipped', 'Dilewati (tidak memengaruhi data): {list}', { list: lwDbMyJoin(a, 10) })) : '');
  const warns = (a) => (Array.isArray(a) ? a.slice(0, 10).filter((x) => typeof x === 'string').map((w) => note(txf('lw.db.my.warn', 'Peringatan: {w}', { w }))).join('') : '');
  if (my.rep) {
    const rep = my.rep;
    return `<div class="lwdbform" role="status">${note(txf('lw.db.my.done', 'Impor selesai: {t} tabel, {r} baris.', { t: lwDbNum(rep.tables), r: lwDbNum(rep.rows) }))}${skipped(rep.skipped)}${warns(rep.warnings)}${note(txf('lw.db.my.where', 'Datanya ada di MySQL untuk aplikasi PHP situs ini, bukan di daftar database di bawah.'))}<div class="lwdbfb">${close('lw.db.my.close', 'Tutup')}</div></div>`;
  }
  const pv = my.pv || {}, names = [...new Set((Array.isArray(pv.tables) ? pv.tables : []).map((t) => t && t.name).filter((n) => typeof n === 'string'))], st = pv.stats || {};
  const head = `<p class="lwct">${esc(my.file)}${my.size ? ' · ' + esc(lwDbSize(my.size)) : ''}</p>` + note(txf('lw.db.my.stats', '{s} pernyataan, {l} baris', { s: lwDbNum(st.statements), l: lwDbNum(st.lines) }));
  if (!my.token) { // tidak bisa diimpor: tidak ada tombol Impor
    const errs = Array.isArray(pv.errors) ? pv.errors.slice(0, 20).map((e) => `<li>${esc(txf('lw.db.my.errLine', 'Baris {l}: {m}', { l: lwDbNum(e && e.line), m: e && typeof e.message === 'string' ? e.message : '' }))}</li>`).join('') : '';
    const why = errs ? `${note(txf('lw.db.my.errs', 'Dump ini tidak bisa diimpor:'), true)}<ul class="lwnote err">${errs}</ul>` : note(txf('lw.db.my.empty', 'Berkas ini tidak berisi pernyataan yang bisa diimpor.'), true);
    return `<div class="lwdbform" role="alert">${head}${why}<div class="lwdbfb">${close('lw.db.my.close', 'Tutup')}</div></div>`;
  }
  const more = lwDbNum(pv.moreTables), repl = Array.isArray(pv.willReplace) ? pv.willReplace : [];
  const tbl = names.length ? note(txf('lw.db.my.tables', 'Tabel dalam dump ({n}): {list}', { n: names.length + more, list: lwDbMyJoin(names, 50) })) : '';
  const rp = repl.length ? note(txf('lw.db.my.replace', 'Tabel ini sudah ada dan akan DIGANTI, isi lamanya hilang: {list}', { list: lwDbMyJoin(repl, 50) }), true) : note(txf('lw.db.my.replaceNone', 'Tidak ada tabel yang sudah ada yang akan diganti.'));
  return `<div class="lwdbform">${head}${tbl}${rp}${skipped(pv.skippable)}${warns(pv.warnings)}<div class="lwdbfb"><button type="button" data-lw="dbmyok"${D.busy ? ' disabled' : ''}>${esc(txf('lw.db.my.go', 'Impor sekarang'))}</button>${close('lw.db.cancel', 'Batal')}</div></div>`;
}

// ---- Browser MySQL baca-saja (fase 2c) ----
// Entri khusus di layar daftar: "MySQL (aplikasi PHP)" · mysql.sqlite · ukuran (dari webDbList.mysqlDb; tidak butuh Worker). Dibuka dengan lwDbOpen('mysql.sqlite', true): D.ro = true, dan SEMUA panggilan
// webDbTables / Rows / Exec / Csv membawa { readonly: true } (lwDbRo). Tanpa tombol tulis (lwDbCanWrite), kotak Mode tulis terkunci, tanpa Reset data dan tanpa Ekspor database SQLite
// (webDbExport menolak mysql.sqlite; ekspor dump MySQL = tombol Ekspor dump MySQL, archne-web-db-export.js). Tombol Impor dump MySQL tetap ada (menimpa lewat pratinjau yang sama).
const lwDbRo = () => (lwD && lwD.ro === true ? { readonly: true } : undefined);
function lwDbMyDbOf(r) { const m = r && r.ok ? r.mysqlDb : null; return m && m.name === 'mysql.sqlite' && Number.isSafeInteger(m.size) && m.size >= 0 ? { name: m.name, size: m.size } : null; }
function lwDbMyEntry() {
  const D = lwD; if (!D || D.list === null) return ''; // daftar belum dimuat: jangan berkedip
  // Fase 5b: kartu selalu tampil. Belum ada mysql.sqlite = kartu mati berstatus "Belum dibuat" (tidak bisa diklik).
  // Fase 5f: tombol "Buat database MySQL" jadi saudara kartu (bukan di dalam <button> kartu). Mati selagi ada operasi lain atau pratinjau impor menunggu (impor membuat mysql.sqlite sendiri).
  if (!D.myDb) {
    const dis = D.busy || (D.my && D.my.token) ? ' disabled' : '';
    return `<div class="lwdbrow"><button type="button" class="lwcard lwmine lwdbitem" data-lw="dbmynone" disabled aria-disabled="true"><span class="lwct">${esc(txf('lw.db.my.entry', 'MySQL (aplikasi PHP)'))}</span><span class="lwcd">${esc(txf('lw.db.my.none', 'Belum dibuat'))}</span></button><button type="button" class="sec" data-lw="dbmycreate"${dis}>${esc(txf('lw.db.my.create', 'Buat database MySQL'))}</button></div>`;
  }
  return `<div class="lwdbrow"><button type="button" class="lwcard lwmine lwdbitem" data-lw="dbmyopen"${D.busy ? ' disabled' : ''}><span class="lwct">${esc(txf('lw.db.my.entry', 'MySQL (aplikasi PHP)'))}</span><span class="lwcd">mysql.sqlite · ${esc(lwDbSize(D.myDb.size))}</span></button></div>`;
}
// Fase 6b: status server MySQL dari webDbList.mysqlState: 'running' | 'starting' | 'stopped' | null (tidak diketahui: tanpa label). Hanya boolean yang dipercaya; running menang atas starting.
function lwDbMyRunOf(r) {
  const m = r && r.ok ? r.mysqlState : null; if (!m || typeof m.running !== 'boolean') return null;
  return m.running ? 'running' : (m.starting === true ? 'starting' : 'stopped');
}
function lwDbMyRunHtml() {
  const k = lwD && lwD.myRun; if (k !== 'running' && k !== 'starting' && k !== 'stopped') return '';
  const t = k === 'running' ? txf('lw.db.my.run', 'Berjalan') : k === 'starting' ? txf('lw.db.my.starting', 'Memulai…') : txf('lw.db.my.stopped', 'Berhenti');
  return `<span class="lwnote lwmyrun" data-run="${k}" role="status">${esc(t)}</span>`;
}
// Fase 5c: info koneksi MySQL di layar daftar, selalu terlihat. Port sah (mysql.json) = host/port/pengguna + tombol Salin ("host:port"); belum ada = keterangan bahwa port ditetapkan saat pertama dijalankan.
function lwDbMyInfo() {
  const D = lwD; if (!D) return '';
  if (!D.mysql) return `${lwDbMyRunHtml()}<p class="lwnote">${esc(txf('lw.db.my.noPort', 'MySQL untuk aplikasi PHP: port ditetapkan saat pertama dijalankan (situs dibuka dengan Mesin PHP menyala atau setelah impor dump). Pakai alamat IP 127.0.0.1, bukan localhost.'))}</p>${lwDbMyPowHtml()}`;
  return `<div class="lwbar">${lwDbMyRunHtml()}<p class="lwnote">${esc(txf('lw.db.mysql', 'MySQL untuk aplikasi PHP: host {host}, port {port}, pengguna {user}, tanpa kata sandi. Aktif saat situs dibuka; bila dinyalakan dari sini, tetap hidup sampai dimatikan. Pakai alamat IP, bukan localhost.', D.mysql))}</p><button type="button" class="sec" data-lw="dbmycopy">${esc(txf('lw.db.my.copy', 'Salin'))}</button></div>${lwDbMyPowHtml()}`;
}
async function lwDbMyCopy() {
  const D = lwD, m = D && D.mysql; if (!m) return;
  const t = m.host + ':' + m.port;
  if (await copyText(t)) toast(txf('lw.db.my.copied', 'Disalin: {addr}', { addr: t }), true); else toast(txf('lw.db.my.copyFail', 'Tidak bisa menyalin. Ketik manual: {addr}', { addr: t }));
}
// Fase 6e: Nyalakan / Matikan server MySQL (webDbMysqlStart / Stop). Hanya bila database ada dan statusnya diketahui; satu tombol sesuai status (Berhenti -> Nyalakan, Berjalan -> Matikan,
// Memulai -> mati). Peringatan singkat selalu menyertai. Nyalakan mem-PIN server (tidak ikut mati saat Mesin PHP dimatikan), jadi pemilik harus bisa melihat dan mematikannya dari sini.
function lwDbMyPowHtml() {
  const D = lwD, k = D && D.myRun; if (!D || !D.myDb || (k !== 'running' && k !== 'starting' && k !== 'stopped')) return '';
  const on = k === 'running', dis = D.busy || k === 'starting' || (D.my && D.my.token) ? ' disabled' : '';
  return `<div class="lwbar"><button type="button" class="sec" data-lw="${on ? 'dbmystop' : 'dbmystart'}"${dis}>${esc(on ? txf('lw.db.my.stop', 'Matikan') : txf('lw.db.my.start', 'Nyalakan'))}</button><p class="lwnote">${esc(txf('lw.db.my.pwWarn', 'Server hanya bisa dijangkau dari perangkat ini (127.0.0.1) dan tanpa kata sandi. Yang dinyalakan di sini tetap hidup sampai Anda mematikannya.'))}</p></div>`;
}
async function lwDbMyPower(on) {
  const D = lwD; if (!D || D.busy || D.name || !D.myDb || D.list === null || (D.my && D.my.token) || D.myRun !== (on ? 'stopped' : 'running')) return;
  D.cr = null; D.dr = null; D.ow = null;
  D.busy = true; D.msg = on ? txf('lw.db.my.pwStarting', 'Menyalakan server MySQL…') : txf('lw.db.my.pwStopping', 'Mematikan server MySQL…'); D.msgErr = false; lwDbPaint();
  let r; try { r = await (on ? window.api.webDbMysqlStart(D.id) : window.api.webDbMysqlStop(D.id)); } catch (x) { r = null; }
  if (D !== lwD) return; // tab ditinggalkan: status diambil ulang saat tab dibuka lagi
  D.busy = false;
  if (r && r.ok) {
    D.msg = on ? (r.already === true ? txf('lw.db.my.pwAlready', 'Server MySQL sudah berjalan. Sekarang tetap hidup sampai Anda mematikannya.') : txf('lw.db.my.pwStarted', 'Server MySQL dinyalakan. Tetap hidup sampai Anda mematikannya.'))
      : (r.stopped === true ? txf('lw.db.my.pwStopped', 'Server MySQL dimatikan.') : txf('lw.db.my.pwWasOff', 'Server MySQL memang sudah mati.'));
    D.msgErr = false;
  } else { D.msg = lwDbFail(r); D.msgErr = true; }
  lwDbPaint();
  if (r && r.ok) lwDbLoadList(); // status + tombol diambil ulang; pesan tetap tampil
}
// Fase 5f: Buat database MySQL (webDbMysqlCreate): mysql.sqlite kosong + port tetap, TANPA menyalakan server. Idempoten di sisi backend (yang sudah ada tidak ditimpa).
// Sesudah berhasil, daftar dimuat ulang: kartu jadi aktif dan info koneksi (5c) memuat port yang baru ditetapkan. Hanya di layar daftar, hanya saat belum ada database.
async function lwDbMyCreate() {
  const D = lwD; if (!D || D.busy || D.name || D.myDb || D.list === null || (D.my && D.my.token)) return;
  D.cr = null; D.dr = null; D.ow = null;
  D.busy = true; D.msg = txf('lw.db.my.creating', 'Membuat database MySQL…'); D.msgErr = false; lwDbPaint();
  let r; try { r = await window.api.webDbMysqlCreate(D.id); } catch (x) { r = null; }
  if (D !== lwD) return; // tab ditinggalkan selagi membuat: hasilnya sudah di disk, daftar dimuat ulang saat tab dibuka lagi
  D.busy = false;
  if (r && r.ok) { D.msg = r.created === true ? txf('lw.db.my.created', 'Database MySQL dibuat. Kartunya sekarang bisa dibuka.') : txf('lw.db.my.exists', 'Database MySQL sudah ada; tidak ada yang diubah.'); D.msgErr = false; }
  else { D.msg = lwDbFail(r); D.msgErr = true; }
  lwDbPaint();
  if (r && r.ok) lwDbLoadList(); // kartu aktif + port; pesan tetap tampil (lwDbLoadList tidak menghapusnya)
}
function lwDbMyTop() { return lwDbMyHtml() + lwDbMyEntry(); } // layar daftar: panel impor (bila ada) + entri MySQL
function lwDbExpBtn() { // bilah layar database: SQLite = Ekspor; MySQL = keterangan baca-saja + Impor dump
  const D = lwD; if (D && D.ro) return `<span class="lwnote">${esc(txf('lw.db.my.ro', 'Hanya baca'))}</span>${lwDbMxBtn()}${lwDbMyBtn()}`;
  return `<button type="button" class="sec" data-lw="dbexport">${esc(txf('lw.db.export', 'Ekspor'))}</button>`;
}
