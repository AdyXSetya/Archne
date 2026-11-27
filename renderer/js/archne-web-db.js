// Web Lokal (0.34.0 Fase P.7c-e): tab Database di layar situs (Berkas | Database | Pengaturan | Pratinjau). P.7c: daftar database di data/, struktur tabel, jelajah baris (urut, cari, halaman). P.7d: tambah / ubah / hapus baris (lewat rowid).
// Renderer hanya memegang id situs + NAMA berkas database (webDbList / webDbTables / webDbRows / webDbInsert / webDbUpdate / webDbDelete; jalur disk tidak pernah ada di sini). Nama tabel dan kolom dikirim apa adanya; yang menentukan sah atau tidak adalah skema database di sisi PHP.
// Isi database berasal dari situs (tidak tepercaya): semua nilai tampil lewat esc() sebagai teks; tidak ada innerHTML dari data. Nama tabel / kolom di atribut HTML diganti indeks (data-i), bukan teks.
// Balasan terlambat dibuang (D !== lwD atau urutan seq / rseq berbeda). Kembali (lwDbBack): tutup formulir / konfirmasi hapus, lalu dari tabel ke daftar database; sesudah itu urusan layar situs (archne-web-mine.js).
// Ubah baris: hanya kolom yang BERUBAH yang dikirim; kolom BLOB dan nilai yang terpotong (>= 500 karakter) dikunci agar tidak tertimpa versi terpotong. Tambah baris: kolom kosong dilewati (nilai bawaan tabel). Hapus: dua langkah (konfirmasi di baris).
// P.7f: tab SQL (satu pernyataan; bawaan baca-saja, tulis hanya bila kotak Mode tulis dicentang dan kotak itu kembali mati sesudah tiap eksekusi), Ekspor CSV per tabel, dan Impor & timpa (dengan konfirmasi; hanya bila nama sudah ada).
// Buat / Hapus database (layar daftar): Buat memakai isian nama inline (tanpa prompt(), tidak ada di Electron), nama tanpa ekstensi diberi .db; Hapus dua langkah (konfirmasi menyebut nama, lalu "Hapus permanen"). Keduanya lewat webDbCreate / webDbDrop.
// P.7e: Ekspor (tombol di layar satu database) mengunduh berkas database utuh; Impor (daftar database) memilih berkas lokal. Impor tidak pernah menimpa database yang sudah ada.
let lwD = null; // { id, seq, rseq, list, err, name, tables, tErr, trunc, ti, mode: 'rows' | 'struct', off, sort, dir, q, res: null | { columns, rows, ids, rw, total, more, view }, rErr, qt, form: null | { mode: 'add' | 'edit', ri }, del: indeks baris yang menunggu konfirmasi (-1 = tidak ada), msg, msgErr, busy }
const LW_DB_LIM = 50;
const LW_DB_CLIP = 500; // harus sama dengan pemendekan di archne-ipc-webdb.js
const lwDbFail = (r) => (r && r.err) || txf('common.error', 'Terjadi kesalahan');
const lwDbSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const lwDbTbl = () => (lwD && lwD.tables && lwD.tables[lwD.ti]) || null;
const lwDbCanWrite = (t) => !!(t && !t.view && !t.internal && !(lwD && lwD.ro));

function lwDbStop() { if (lwD && lwD.qt) clearTimeout(lwD.qt); lwDbMyDrop(lwD); lwD = null; }
function lwDbOn() { return !!(lwD && lwM && lwM.site && lwM.site.tab === 'db'); }
function lwDbPaint() { const el = $('lwsb'); if (el && lwDbOn()) el.innerHTML = lwDbHtml(); }
function lwDbPaintRes() { const el = $('lwdb-res'); if (el && lwDbOn()) el.innerHTML = lwDbResHtml(); else lwDbPaint(); }
function lwDbMsg(text, isErr) { // pesan tanpa menggambar ulang (isian formulir tidak hilang)
  const D = lwD; if (!D) return;
  D.msg = text || ''; D.msgErr = !!isErr;
  const el = $('lwdb-msg'); if (el) { el.textContent = D.msg; el.hidden = !D.msg; el.className = 'lwnote' + (D.msgErr ? ' err' : ''); }
}

function lwDbStart(id) {
  lwDbStop();
  lwD = { id, seq: 0, rseq: 0, list: null, err: '', name: '', tables: null, tErr: '', trunc: false, ti: -1, mode: 'rows', off: 0, sort: '', dir: 'asc', q: '', res: null, rErr: '', qt: 0, form: null, del: -1, msg: '', msgErr: false, busy: false, sqlText: '', sqlW: false, sqlRes: null, sqlErr: '', ow: null, cr: null, dr: null };
  lwDbPaint(); lwDbLoadList();
}
async function lwDbLoadList() {
  const D = lwD; if (!D) return;
  const seq = ++D.seq; D.err = '';
  let r; try { r = await window.api.webDbList(D.id); } catch (x) { r = null; }
  if (D !== lwD || seq !== D.seq) return;
  D.mysql = null; D.myDb = lwDbMyDbOf(r); D.myRun = lwDbMyRunOf(r);
  if (r && r.ok) { D.list = Array.isArray(r.items) ? r.items : []; const m = r.mysql; if (m && typeof m.host === 'string' && Number.isInteger(m.port) && typeof m.user === 'string') D.mysql = m; } else { D.list = []; D.err = lwDbFail(r); }
  lwDbPaint();
}
async function lwDbOpen(name, ro) {
  const D = lwD; if (!D || typeof name !== 'string') return;
  if (D.qt) clearTimeout(D.qt);
  Object.assign(D, { name, ro: ro === true, tables: null, tErr: '', trunc: false, ti: -1, mode: 'rows', off: 0, sort: '', dir: 'asc', q: '', res: null, rErr: '', qt: 0, form: null, del: -1, msg: '', msgErr: false, sqlText: '', sqlW: false, sqlRes: null, sqlErr: '', ow: null, cr: null, dr: null });
  const seq = ++D.seq; lwDbPaint();
  let r; try { r = await window.api.webDbTables(D.id, name, lwDbRo()); } catch (x) { r = null; }
  if (D !== lwD || seq !== D.seq || D.name !== name) return;
  if (r && r.ok) {
    D.tables = Array.isArray(r.tables) ? r.tables : []; D.trunc = !!r.truncated;
    const first = D.tables.findIndex((t) => t && !t.internal); D.ti = first >= 0 ? first : (D.tables.length ? 0 : -1);
    lwDbPaint(); if (D.ti >= 0) lwDbRows(false);
  } else { D.tables = []; D.tErr = lwDbFail(r); lwDbPaint(); }
}
async function lwDbRows(partial) {
  const D = lwD, t = D && D.tables && D.tables[D.ti]; if (!t) return;
  const closed = !!(D.form && D.form.mode === 'edit'); // indeks baris berubah: formulir ubah ditutup; formulir tambah dibiarkan (isiannya tidak boleh hilang)
  if (closed) D.form = null;
  D.del = -1;
  const rseq = ++D.rseq; D.rErr = '';
  const o = { table: t.name, offset: D.off, limit: LW_DB_LIM, dir: D.dir };
  if (D.sort) o.sort = D.sort;
  if (D.q) o.q = D.q;
  if (D.ro) o.readonly = true;
  let r; try { r = await window.api.webDbRows(D.id, D.name, o); } catch (x) { r = null; }
  if (D !== lwD || rseq !== D.rseq) return;
  if (r && r.ok) D.res = D.ro ? Object.assign({}, r, { rw: false, ids: [] }) : r; else { D.res = null; D.rErr = lwDbFail(r); }
  if (partial || (D.form && !closed)) lwDbPaintRes(); else lwDbPaint();
}
function lwDbReset() { const D = lwD; if (D) { D.form = null; D.del = -1; D.msg = ''; D.msgErr = false; } }
function lwDbPick(i) {
  const D = lwD; if (!D || !D.tables || !D.tables[i]) return;
  if (D.qt) clearTimeout(D.qt);
  lwDbReset();
  Object.assign(D, { ti: i, off: 0, sort: '', dir: 'asc', q: '', res: null, rErr: '', qt: 0 }); lwDbPaint();
  if (D.mode === 'rows') lwDbRows(false);
}
function lwDbMode(m) {
  const D = lwD; if (!D || (m !== 'rows' && m !== 'struct' && m !== 'sql') || m === D.mode) return;
  lwDbReset(); D.mode = m; lwDbPaint(); if (m === 'rows' && !D.res && D.ti >= 0) lwDbRows(false);
}
function lwDbSort(ci) {
  const D = lwD, col = D && D.res && D.res.columns && D.res.columns[ci]; if (typeof col !== 'string') return;
  if (D.sort === col) D.dir = D.dir === 'asc' ? 'desc' : 'asc'; else { D.sort = col; D.dir = 'asc'; }
  D.off = 0; lwDbRows(false);
}
function lwDbPage(dir) {
  const D = lwD; if (!D || !D.res) return;
  if (dir === 'next' && D.res.more) D.off += LW_DB_LIM; else if (dir === 'prev' && D.off > 0) D.off = Math.max(0, D.off - LW_DB_LIM); else return;
  lwDbRows(false);
}
function lwDbInput(v) { // cari: jeda 300 ms; hanya hasil yang digambar ulang, jadi kursor di kolom cari aman
  const D = lwD; if (!D || !lwDbOn()) return;
  D.q = String(v == null ? '' : v); if (D.qt) clearTimeout(D.qt);
  D.qt = setTimeout(() => { D.qt = 0; if (D !== lwD) return; D.off = 0; lwDbRows(true); }, 300);
}

// ---- tulis (P.7d) ----
function lwDbForm(mode, ri) {
  const D = lwD, t = lwDbTbl(); if (!D || !lwDbCanWrite(t) || D.busy) return;
  if (mode === 'edit') { const r = D.res; if (!r || r.rw !== true || !Array.isArray(r.rows) || !r.rows[ri] || !r.ids || typeof r.ids[ri] !== 'string') return; }
  else if (mode !== 'add') return;
  D.form = { mode, ri: mode === 'edit' ? ri : -1 }; D.del = -1; D.msg = ''; D.msgErr = false; lwDbPaint();
  const el = $('lwsb') && $('lwsb').querySelector('.lwdbf input[type=text]:not(:disabled), .lwdbf textarea:not(:disabled)'); if (el) el.focus();
}
function lwDbCancel() { const D = lwD; if (!D || !D.form) return; D.form = null; lwDbPaint(); }
function lwDbDel(i) {
  const D = lwD, r = D && D.res; if (!D || D.busy || !r || r.rw !== true || !r.ids || typeof r.ids[i] !== 'string') return;
  D.del = i; lwDbPaintRes();
}
// Sesudah tulis berhasil: tutup formulir, perbarui hitungan baris, muat ulang halaman.
function lwDbDone(msgKey, fb, delta) {
  const D = lwD, t = lwDbTbl(); if (!D) return;
  D.form = null; D.del = -1; D.msg = txf(msgKey, fb); D.msgErr = false;
  if (t && Number.isSafeInteger(t.rows)) t.rows = Math.max(0, t.rows + delta);
  if (delta < 0 && D.off > 0 && D.res && Array.isArray(D.res.rows) && D.res.rows.length <= 1) D.off = Math.max(0, D.off - LW_DB_LIM);
  lwDbRows(false);
}
async function lwDbSave() {
  const D = lwD, t = lwDbTbl(), f = D && D.form; if (!D || !f || !lwDbCanWrite(t) || D.busy) return;
  const r = D.res, edit = f.mode === 'edit', cols = Array.isArray(t.columns) ? t.columns : [];
  let rid = null; if (edit) { rid = r && r.ids && r.ids[f.ri]; if (typeof rid !== 'string' || !r.rows[f.ri]) return; }
  const pairs = [];
  for (let i = 0; i < cols.length; i++) {
    const el = $('lwdb-f-' + i), nl = $('lwdb-n-' + i); if (!el || el.disabled) continue;
    const isNull = !!(nl && nl.checked), txt = String(el.value);
    if (!edit) { if (isNull) pairs.push([cols[i].name, null]); else if (txt !== '') pairs.push([cols[i].name, txt]); continue; }
    const ci = r.columns.indexOf(cols[i].name); if (ci < 0) continue;
    const orig = r.rows[f.ri][ci], wasNull = orig == null;
    if (isNull !== wasNull || (!isNull && txt !== String(orig).replace(/\r\n/g, '\n'))) pairs.push([cols[i].name, isNull ? null : txt]);
  }
  if (edit && !pairs.length) { lwDbMsg(txf('lw.db.noChange', 'Tidak ada perubahan'), false); return; }
  const name = D.name, ti = D.ti; D.busy = true;
  let x; try { x = edit ? await window.api.webDbUpdate(D.id, name, { table: t.name, rid, values: pairs }) : await window.api.webDbInsert(D.id, name, { table: t.name, values: pairs }); } catch (e) { x = null; }
  if (D !== lwD) return; D.busy = false;
  if (D.name !== name || D.ti !== ti) return;
  if (x && x.ok) lwDbDone(edit ? 'lw.db.saved' : 'lw.db.added', edit ? 'Baris disimpan' : 'Baris ditambahkan', edit ? 0 : 1);
  else lwDbMsg(lwDbFail(x), true);
}
async function lwDbDelOk() {
  const D = lwD, t = lwDbTbl(), r = D && D.res; if (!D || !lwDbCanWrite(t) || !r || D.busy || D.del < 0) return;
  const rid = r.ids && r.ids[D.del]; D.del = -1;
  if (typeof rid !== 'string') { lwDbPaintRes(); return; }
  const name = D.name, ti = D.ti; D.busy = true;
  let x; try { x = await window.api.webDbDelete(D.id, name, { table: t.name, rid }); } catch (e) { x = null; }
  if (D !== lwD) return; D.busy = false;
  if (D.name !== name || D.ti !== ti) return;
  if (x && x.ok) lwDbDone('lw.db.deleted', 'Baris dihapus', -1);
  else { lwDbMsg(lwDbFail(x), true); lwDbPaintRes(); }
}

const LW_DB_XFER = 5 * 1024 * 1024; // harus sama dengan MAX_XFER di archne-ipc-webdb.js
const lwDbB64 = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => { const s = String(r.result || ''), i = s.indexOf(','); ok(i >= 0 ? s.slice(i + 1) : ''); }; r.onerror = () => no(r.error); r.readAsDataURL(f); });
function lwDbImpName(n) { // nama aman; keputusan akhir tetap di Node
  let s = String(n || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+/, '');
  if (!/\.(sqlite3?|db3?)$/i.test(s)) s = s.replace(/\.+$/, '') + '.db';
  if (s.length > 100) { const m = s.match(/\.[A-Za-z0-9]+$/), ext = m ? m[0] : '.db'; s = s.slice(0, 100 - ext.length) + ext; }
  return s;
}
function lwDbListTop() { // tombol Impor + pesan di layar daftar database
  const D = lwD; if (!D) return '';
  const dis = D.busy ? ' disabled' : '';
  const imp = `<div class="lwbar"><button type="button" class="sec" data-lw="dbimport"${dis}>${esc(txf('lw.db.import', 'Impor database'))}</button><button type="button" class="sec" data-lw="dbimportow"${dis}>${esc(txf('lw.db.importOw', 'Impor & timpa'))}</button>${lwDbMyBtn()}<button type="button" data-lw="dbcreate"${dis}>${esc(txf('lw.db.create', 'Buat database'))}</button></div>`;
  const cr = D.cr ? `<div class="lwbar"><input id="lwdb-cn" type="text" maxlength="100" autocomplete="off" spellcheck="false" value="${esc(D.cr.v)}" placeholder="${esc(txf('lw.db.createName', 'Nama database baru'))}" aria-label="${esc(txf('lw.db.createName', 'Nama database baru'))}"><button type="button" data-lw="dbcreateok"${dis}>${esc(txf('lw.db.createOk', 'Buat'))}</button><button type="button" class="sec" data-lw="dbcreateno">${esc(txf('lw.db.cancel', 'Batal'))}</button></div>` : '';
  const drop = D.dr && typeof D.dr.name === 'string' ? `<p class="lwnote err" role="alert">${esc(txf('lw.db.dropAsk', 'Hapus database "{n}" beserta seluruh isinya? Tidak bisa dibatalkan.', { n: D.dr.name }))} <button type="button" data-lw="dbdropok"${dis}>${esc(txf('lw.db.dropOk', 'Hapus permanen'))}</button> <button type="button" class="sec" data-lw="dbdropno">${esc(txf('lw.db.cancel', 'Batal'))}</button></p>` : '';
  const ask = D.ow && typeof D.ow.name === 'string' ? `<p class="lwnote err" role="alert">${esc(txf('lw.db.owAsk', 'Timpa database "{n}"? Isi lamanya akan hilang.', { n: D.ow.name }))} <button type="button" data-lw="dbowok"${dis}>${esc(txf('lw.db.owOk', 'Timpa'))}</button> <button type="button" class="sec" data-lw="dbowno">${esc(txf('lw.db.cancel', 'Batal'))}</button></p>` : '';
  return imp + cr + ask + drop + (D.msg ? `<p class="lwnote${D.msgErr ? ' err' : ''}" role="status">${esc(D.msg)}</p>` : '') + lwDbMyTop();
}
async function lwDbExport() {
  const D = lwD; if (!D || D.busy || D.ro || !D.name) return;
  const name = D.name; D.busy = true; lwDbMsg(txf('lw.db.exporting', 'Menyiapkan ekspor…'), false);
  let r; try { r = await window.api.webDbExport(D.id, name); } catch (x) { r = null; }
  if (D !== lwD) return;
  D.busy = false;
  if (!(r && r.ok && typeof r.data === 'string')) { lwDbMsg(lwDbFail(r), true); return; }
  if (lwDbDownload(r.data, name, 'application/octet-stream')) lwDbMsg(txf('lw.db.exported', 'Database diekspor: {n}', { n: name }), false);
  else lwDbMsg(txf('lw.db.exportFail', 'Gagal menyiapkan unduhan'), true);
}
function lwDbImport(over) {
  const D = lwD; if (!D || D.busy || D.name) return;
  D.ow = null;
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.sqlite,.sqlite3,.db,.db3';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f || D !== lwD || D.name) return;
    if (f.size > LW_DB_XFER) { D.msg = txf('e.db.tooBig', 'Database terlalu besar (maksimal 5 MB)'); D.msgErr = true; lwDbPaint(); return; }
    const nm = lwDbImpName(f.name);
    if (over && Array.isArray(D.list) && D.list.some((it) => it && it.name === nm)) { // ada nama yang sama: minta konfirmasi dulu, belum ada yang ditulis
      let data0; try { data0 = await lwDbB64(f); } catch (x) { data0 = null; }
      if (D !== lwD || D.name) return;
      if (data0 == null) { D.msg = txf('lw.db.exportFail', 'Gagal menyiapkan unduhan'); D.msgErr = true; lwDbPaint(); return; }
      D.ow = { name: nm, data: data0 }; D.msg = ''; D.msgErr = false; lwDbPaint(); return; // belum ada yang ditulis; lanjut lewat tombol Timpa (dbowok)
    }
    let data; try { data = await lwDbB64(f); } catch (x) { data = null; }
    if (D !== lwD || D.name) return;
    if (data == null) { D.msg = txf('lw.db.exportFail', 'Gagal menyiapkan unduhan'); D.msgErr = true; lwDbPaint(); return; }
    lwDbDoImport(nm, over === true, data);
  };
  inp.click();
}
async function lwDbDoImport(nm, over, data) {
  const D = lwD; if (!D || D.busy || D.name) return;
  D.busy = true; D.msg = txf('lw.db.importing', 'Mengimpor…'); D.msgErr = false; D.ow = null; lwDbPaint();
  let r; try { r = await window.api.webDbImport(D.id, over ? { name: nm, data, overwrite: true } : { name: nm, data }); } catch (x) { r = null; }
  if (D !== lwD) return;
  D.busy = false;
  if (r && r.ok) { D.msg = txf('lw.db.imported', 'Database diimpor: {n}', { n: typeof r.name === 'string' ? r.name : '' }); D.msgErr = false; lwDbPaint(); lwDbLoadList(); }
  else { D.msg = lwDbFail(r); D.msgErr = true; lwDbPaint(); }
}

function lwDbCreateOpen() {
  const D = lwD; if (!D || D.busy || D.name) return;
  D.cr = { v: '' }; D.dr = null; D.ow = null; D.msg = ''; D.msgErr = false; lwDbPaint();
  const el = $('lwdb-cn'); if (el && el.focus) el.focus();
}
function lwDbCreateNo() { const D = lwD; if (!D || !D.cr) return; D.cr = null; lwDbPaint(); }
async function lwDbCreateOk() {
  const D = lwD; if (!D || D.busy || D.name || !D.cr) return;
  const inp = $('lwdb-cn'), raw = String(inp ? inp.value : D.cr.v).trim(); D.cr.v = raw;
  if (!raw) { D.msg = txf('e.db.badName', 'Nama database tidak valid'); D.msgErr = true; lwDbPaint(); return; }
  const nm = lwDbImpName(raw);
  D.busy = true; D.msg = txf('lw.db.creating', 'Membuat…'); D.msgErr = false; lwDbPaint();
  let r; try { r = await window.api.webDbCreate(D.id, { name: nm }); } catch (x) { r = null; }
  if (D !== lwD) return;
  D.busy = false;
  if (r && r.ok) { D.cr = null; D.msg = txf('lw.db.created', 'Database dibuat: {n}', { n: typeof r.name === 'string' ? r.name : nm }); D.msgErr = false; lwDbPaint(); lwDbLoadList(); }
  else { D.msg = lwDbFail(r); D.msgErr = true; lwDbPaint(); } // formulir tetap terbuka dengan teks yang tadi diketik
}
function lwDbDropAsk(i) {
  const D = lwD, it = D && D.list && D.list[i]; if (!D || D.busy || D.name || !it || typeof it.name !== 'string') return;
  D.dr = { name: it.name }; D.cr = null; D.ow = null; D.msg = ''; D.msgErr = false; lwDbPaint();
}
function lwDbDropNo() { const D = lwD; if (!D || !D.dr) return; D.dr = null; lwDbPaint(); }
async function lwDbDropOk() {
  const D = lwD; if (!D || D.busy || D.name || !D.dr || typeof D.dr.name !== 'string') return;
  const nm = D.dr.name; D.dr = null; D.busy = true; D.msg = txf('lw.db.dropping', 'Menghapus…'); D.msgErr = false; lwDbPaint();
  let r; try { r = await window.api.webDbDrop(D.id, nm); } catch (x) { r = null; }
  if (D !== lwD) return;
  D.busy = false;
  if (r && r.ok) { D.msg = txf('lw.db.dropped', 'Database dihapus: {n}', { n: nm }); D.msgErr = false; lwDbPaint(); lwDbLoadList(); }
  else { D.msg = lwDbFail(r); D.msgErr = true; lwDbPaint(); }
}

function lwDbBack() { // true bila ada yang ditutup: formulir / konfirmasi hapus, lalu dari tabel ke daftar database
  const D = lwD; if (!D || !lwDbOn() || !D.name) return false;
  if (D.form) { D.form = null; lwDbPaint(); return true; }
  if (D.del >= 0) { D.del = -1; lwDbPaintRes(); return true; }
  if (D.qt) clearTimeout(D.qt);
  Object.assign(D, { name: '', ro: false, tables: null, tErr: '', trunc: false, ti: -1, res: null, rErr: '', q: '', sort: '', dir: 'asc', off: 0, qt: 0, msg: '', msgErr: false }); lwDbPaint();
  return true;
}
function lwDbAct(act, d) {
  if (!lwD || typeof act !== 'string' || act.slice(0, 2) !== 'db') return false;
  const i = parseInt(d && d.i, 10);
  if (act === 'dbopen') { const it = lwD.list && lwD.list[i]; if (it) lwDbOpen(it.name); return true; }
  if (act === 'dbback') { lwDbBack(); return true; }
  if (act === 'dbreload') { if (lwD.name) lwDbOpen(lwD.name, lwD.ro); else { lwD.list = null; lwDbPaint(); lwDbLoadList(); } return true; }
  if (act === 'dbtable') { lwDbPick(i); return true; }
  if (act === 'dbmode') { lwDbMode(d && d.m); return true; }
  if (act === 'dbsort') { lwDbSort(i); return true; }
  if (act === 'dbpage') { lwDbPage(d && d.p); return true; }
  if (act === 'dbadd') { lwDbForm('add', -1); return true; }
  if (act === 'dbedit') { lwDbForm('edit', i); return true; }
  if (act === 'dbcancel') { lwDbCancel(); return true; }
  if (act === 'dbsave') { lwDbSave(); return true; }
  if (act === 'dbdel') { lwDbDel(i); return true; }
  if (act === 'dbdelok') { lwDbDelOk(); return true; }
  if (act === 'dbexport') { lwDbExport(); return true; }
  if (act === 'dbimport') { lwDbImport(false); return true; }
  if (act === 'dbimportow') { lwDbImport(true); return true; }
  if (act === 'dbowok') { const o = lwD.ow; if (o) lwDbDoImport(o.name, true, o.data); return true; }
  if (act === 'dbcreate') { lwDbCreateOpen(); return true; }
  if (act === 'dbcreateok') { lwDbCreateOk(); return true; }
  if (act === 'dbcreateno') { lwDbCreateNo(); return true; }
  if (act === 'dbdrop') { lwDbDropAsk(i); return true; }
  if (act === 'dbdropok') { lwDbDropOk(); return true; }
  if (act === 'dbdropno') { lwDbDropNo(); return true; }
  if (act === 'dbowno') { lwD.ow = null; lwDbPaint(); return true; }
  if (act === 'dbrun') { lwDbRun(); return true; }
  if (act === 'dbcsv') { lwDbCsv(); return true; }
  if (act === 'dbdelno') { lwD.del = -1; lwDbPaintRes(); return true; }
  return lwDbActX(act); // reset data: archne-web-db-sql.js
}

// ---- tampilan ----
function lwDbCell(v) {
  if (v == null) return '<i class="lwdbnull">NULL</i>';
  if (typeof v === 'object') return '<i class="lwdbblob">' + esc(txf('lw.db.blob', 'BLOB {n} B', { n: Number.isSafeInteger(v.b) ? v.b : 0 })) + '</i>';
  return esc(String(v));
}
function lwDbStructHtml(t) {
  const cols = Array.isArray(t.columns) ? t.columns : [], yes = txf('lw.db.yes', 'ya');
  const rows = cols.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.type || '')}</td><td>${c.pk ? esc(yes) : ''}</td><td>${c.notnull ? esc(yes) : ''}</td><td>${c.default == null ? '' : esc(String(c.default))}</td></tr>`).join('');
  const th = [txf('lw.db.col', 'Kolom'), txf('lw.db.type', 'Tipe'), txf('lw.db.pk', 'Kunci utama'), txf('lw.db.notnull', 'Wajib'), txf('lw.db.default', 'Bawaan')].map((x) => `<th>${esc(x)}</th>`).join('');
  return `<div class="lwdbwrap"><table class="lwdbt"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function lwDbFormHtml(t) {
  const D = lwD, f = D && D.form; if (!f) return '';
  const r = D.res, edit = f.mode === 'edit';
  const row = edit ? (r && Array.isArray(r.rows) && r.rows[f.ri]) : null; if (edit && !row) return '';
  const cols = Array.isArray(t.columns) ? t.columns : [];
  const fields = cols.map((c, i) => {
    let v = '', isNull = false, lock = false;
    if (row) {
      const ci = r.columns.indexOf(c.name), x = ci >= 0 ? row[ci] : undefined;
      if (x === undefined) lock = true; else if (x === null) isNull = true; else if (typeof x === 'object') lock = true; else { v = String(x); if (v.length >= LW_DB_CLIP) lock = true; }
    }
    const id = 'lwdb-f-' + i, dis = lock ? ' disabled' : '';
    const input = (v.length > 60 || v.indexOf('\n') >= 0) ? `<textarea id="${id}" rows="3"${dis}>\n${esc(v)}</textarea>` : `<input id="${id}" type="text"${dis} value="${esc(v)}">`;
    const side = lock ? `<small>${esc(txf('lw.db.locked', 'Tidak bisa diubah di sini (BLOB atau nilai terpotong)'))}</small>` : `<label class="lwdbnl"><input type="checkbox" id="lwdb-n-${i}"${isNull ? ' checked' : ''}> NULL</label>`;
    const meta = [c.type, c.pk ? txf('lw.db.pk', 'Kunci utama') : '', c.notnull ? txf('lw.db.notnull', 'Wajib') : ''].filter(Boolean).join(' · ');
    return `<div class="lwdbf"><label for="${id}">${esc(c.name)}<br><small>${esc(meta)}</small></label>${input}<span>${side}</span></div>`;
  }).join('');
  const title = edit ? txf('lw.db.formEdit', 'Ubah baris') : txf('lw.db.formAdd', 'Baris baru');
  const hint = edit ? '' : `<p class="lwnote">${esc(txf('lw.db.addHint', 'Kosongkan kolom untuk memakai nilai bawaan.'))}</p>`;
  return `<div class="lwdbform"><p class="lwct">${esc(title)}</p>${hint}${fields}<div class="lwdbfb"><button type="button" data-lw="dbsave">${esc(txf('lw.db.save', 'Simpan'))}</button><button type="button" class="sec" data-lw="dbcancel">${esc(txf('lw.db.cancel', 'Batal'))}</button></div></div>`;
}
function lwDbResHtml() {
  const D = lwD; if (!D) return '';
  if (D.rErr) return `<p class="lwnote err" role="alert">${esc(D.rErr)} <button type="button" class="sec" data-lw="dbreload">${esc(txf('lw.retry', 'Coba lagi'))}</button></p>`;
  const r = D.res; if (!r) return `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>`;
  const cols = Array.isArray(r.columns) ? r.columns : [], rows = Array.isArray(r.rows) ? r.rows : [];
  const canW = lwDbCanWrite(lwDbTbl()), rw = canW && r.rw === true && Array.isArray(r.ids);
  const noRid = canW && !rw ? `<p class="lwnote">${esc(txf('lw.db.noRid', 'Tabel ini tidak punya rowid, baris hanya bisa ditambah.'))}</p>` : '';
  if (!rows.length) return noRid + `<p class="lwempty">${esc(D.q ? txf('lw.db.nomatch', 'Tidak ada baris yang cocok') : txf('lw.db.empty', 'Tabel ini kosong'))}</p>`;
  const arrow = (c) => (D.sort === c ? (D.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const head = cols.map((c, i) => `<th><button type="button" class="lwdbsort" data-lw="dbsort" data-i="${i}">${esc(c)}${arrow(c)}</button></th>`).join('') + (rw ? `<th>${esc(txf('lw.db.actions', 'Aksi'))}</th>` : '');
  const btn = (act, ri, label, cls) => `<button type="button" class="${cls}" data-lw="${act}" data-i="${ri}">${esc(label)}</button>`;
  const body = rows.map((row, ri) => {
    let act = '';
    if (rw) {
      const ok = typeof r.ids[ri] === 'string';
      act = D.del === ri
        ? `<td class="lwdbact"><span class="lwnote err">${esc(txf('lw.db.delAsk', 'Hapus baris ini?'))}</span> <button type="button" class="sec" data-lw="dbdelok">${esc(txf('lw.db.del', 'Hapus'))}</button><button type="button" class="sec" data-lw="dbdelno">${esc(txf('lw.db.cancel', 'Batal'))}</button></td>`
        : `<td class="lwdbact">${ok ? btn('dbedit', ri, txf('lw.db.edit', 'Ubah'), 'sec') + btn('dbdel', ri, txf('lw.db.del', 'Hapus'), 'sec') : ''}</td>`;
    }
    return '<tr>' + (Array.isArray(row) ? row : []).map((v) => `<td>${lwDbCell(v)}</td>`).join('') + act + '</tr>';
  }).join('');
  const a = D.off + 1, b = D.off + rows.length;
  const range = Number.isSafeInteger(r.total) ? txf('lw.db.range', '{a}–{b} dari {n}', { a, b, n: r.total }) : txf('lw.db.range2', '{a}–{b}', { a, b });
  const pager = `<div class="lwdbpg"><button type="button" class="sec" data-lw="dbpage" data-p="prev"${D.off > 0 ? '' : ' disabled'}>${esc(txf('lw.db.prev', 'Sebelumnya'))}</button><span class="lwnote">${esc(range)}</span><button type="button" class="sec" data-lw="dbpage" data-p="next"${r.more ? '' : ' disabled'}>${esc(txf('lw.db.next', 'Berikutnya'))}</button></div>`;
  return noRid + `<div class="lwdbwrap"><table class="lwdbt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${pager}`;
}
function lwDbChipsHtml() {
  const D = lwD; if (!D || !D.tables) return '';
  return D.tables.map((t, i) => `<button type="button" class="lwdbchip${i === D.ti ? ' on' : ''}${t.internal ? ' dim' : ''}" aria-pressed="${i === D.ti}" data-lw="dbtable" data-i="${i}">${esc(t.name)}${t.view ? ' · ' + esc(txf('lw.db.view', 'tampilan')) : ''}</button>`).join('');
}
function lwDbHtml() {
  const D = lwD, load = `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>`;
  if (!D) return load;
  const reload = `<button type="button" class="sec" data-lw="dbreload">${esc(txf('lw.db.reload', 'Muat ulang'))}</button>`;
  if (!D.name) { // daftar database
    if (D.list === null) return load;
    let h = lwDbListTop() + (D.err ? `<p class="lwnote err" role="alert">${esc(D.err)} ${reload}</p>` : '');
    h += lwDbMyInfo(); // Fase 5c: info koneksi MySQL selalu tampil (archne-web-db-sql.js)
    if (!D.list.length) return h + `<p class="lwempty">${esc(txf('lw.db.none', 'Belum ada database di folder data/ situs ini.'))}<br><small>${esc(txf('lw.db.noneHint', 'Berkas SQLite (.sqlite, .db) yang dibuat situsmu lewat PHP muncul di sini.'))}</small></p>`;
    h += `<div class="lwbar"><p class="lwnote">${esc(txf('lw.db.hint', 'Kamu bisa melihat dan mengubah isi database situsmu. Perubahan langsung tersimpan.'))}</p>${reload}</div>`;
    return h + D.list.map((it, i) => `<div class="lwdbrow"><button type="button" class="lwcard lwmine lwdbitem" data-lw="dbopen" data-i="${i}"><span class="lwct">${esc(it.name)}</span><span class="lwcd">${esc(lwDbSize(Number.isSafeInteger(it.size) ? it.size : 0))}</span></button><button type="button" class="sec" data-lw="dbdrop" data-i="${i}"${D.busy ? ' disabled' : ''} aria-label="${esc(txf('lw.db.drop', 'Hapus database') + ': ' + it.name)}">${esc(txf('lw.db.del', 'Hapus'))}</button></div>`).join('');
  }
  const bar = `<div class="lwbar"><button type="button" class="sec" data-lw="dbback">${esc(txf('lw.db.back', 'Semua database'))}</button><span class="lwct">${esc(D.name)}</span>${reload}${lwDbExpBtn()}${lwDbResetBtn()}</div>${lwDbResetAsk()}<p id="lwdb-msg" class="lwnote${D.msgErr ? ' err' : ''}" role="status"${D.msg ? '' : ' hidden'}>${esc(D.msg)}</p>`;
  if (D.tErr) return bar + `<p class="lwnote err" role="alert">${esc(D.tErr)}</p>`;
  if (D.tables === null) return bar + load;
  if (!D.tables.length) return bar + `<p class="lwempty">${esc(txf('lw.db.notables', 'Database ini belum punya tabel'))}</p>`;
  const chips = lwDbChipsHtml();
  const t = D.tables[D.ti];
  let h = bar + `<div class="lwdbchips">${chips}</div>` + (D.trunc ? `<p class="lwnote">${esc(txf('lw.db.truncated', 'Daftar tabel dipotong.'))}</p>` : '');
  if (!t) return h;
  const m = (k, fb, id) => `<button type="button" role="tab" class="lwtab lwstab${D.mode === id ? ' on' : ''}" aria-selected="${D.mode === id}" data-lw="dbmode" data-m="${id}">${esc(txf(k, fb))}</button>`;
  h += `<div class="lwtabs lwstabs" role="tablist">${m('lw.db.browse', 'Isi', 'rows')}${m('lw.db.structure', 'Struktur', 'struct')}${m('lw.db.sql', 'SQL', 'sql')}</div>`;
  if (D.mode === 'sql') return h + lwDbSqlHtml();
  if (D.mode === 'struct') return h + lwDbStructHtml(t) + (t.view ? '' : `<p class="lwnote">${esc(txf('lw.db.rowsN', 'Jumlah baris: {n}', { n: Number.isSafeInteger(t.rows) ? t.rows : '?' }))}</p>`);
  const add = lwDbCanWrite(t) ? `<button type="button" data-lw="dbadd">${esc(txf('lw.db.add', 'Tambah baris'))}</button>` : '';
  h += `<div class="lwbar"><input id="lwdb-q" type="search" maxlength="100" autocomplete="off" value="${esc(D.q)}" placeholder="${esc(txf('lw.db.search', 'Cari di tabel'))}" aria-label="${esc(txf('lw.db.search', 'Cari di tabel'))}">${add}<button type="button" class="sec" data-lw="dbcsv">${esc(txf('lw.db.csv', 'Ekspor CSV'))}</button></div>`;
  return h + lwDbFormHtml(t) + `<div id="lwdb-res">${lwDbResHtml()}</div>`;
}