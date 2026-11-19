// js/archne-direct.js — panel Kirim Langsung (v0.24.0, step 2b): daftar transfer masuk/keluar lewat LAN.
// Tampilan baris dari renderer/archne-dxcard.js (fungsi murni). Progres diperbarui di tempat (tanpa menggambar ulang) lewat event dxprog;
// perubahan status memicu 'update' -> daftar digambar ulang. Hanya pemanggil api.dx* di sini; semua keputusan keamanan ada di Core/IPC.
// var + deklarasi fungsi (bukan let/const): refresh() bisa memanggil dxSoon() sebelum berkas ini selesai dimuat (tes menyatukan semua skrip).
var dxData = { dir: '', in: [], out: [] }, dxTimer = null, dxBusy = false;
function dxOpen() { return $('dxmodal').style.display === 'flex'; }
function dxBadge() { // lencana jumlah tawaran menunggu: di tombol ⋮ header chat dan di butir menu "Transfer berkas"
  if (typeof DxCard === 'undefined') return;
  const n = DxCard.pending(dxData), t = n ? String(Math.min(n, 99)) : '';
  const m = $('morebtn'), l = $('dxlistbtn');
  if (m) { m.classList.toggle('has', !!n); m.setAttribute('data-n', t); }
  if (l) { l.setAttribute('data-n', t); l.title = n ? tnf('dx.badgeTitle', n, 'Transfer berkas ({count} tawaran menunggu)', { count: n }) : txf('dx.listTitle', 'Daftar transfer Kirim Langsung'); }
}
function dxRender() {
  dxBadge();
  if (typeof DxCard === 'undefined' || !dxOpen()) return;
  $('dxlist').innerHTML = DxCard.listHtml(dxData);
  const shown = dxData.shown || dxData.dir; $('dxdir').textContent = shown ? txf('dx.savedIn', 'Tersimpan di: {dir}', { dir: shown }) : '';
}
async function dxLoad() {
  if (dxBusy) return; dxBusy = true;
  try { const r = await window.api.dxState(); if (r && Array.isArray(r.in)) { dxData = r; dxRender(); } } catch {} finally { dxBusy = false; }
}
function dxSoon() { if (!dxTimer) dxTimer = setTimeout(() => { dxTimer = null; dxLoad(); }, 250); } // 'update' bisa deras: satukan
// dxSoon dipanggil dari refresh() (archne-profile-compose.js) setiap ada 'update' Core.
window.api.onDxProg((p) => {
  if (!p || !dxOpen()) return;
  const row = $('dxlist').querySelector('[data-dxrow="' + p.id + '"]');
  if (!row) return;
  const bar = row.querySelector('[data-dxbar]'), pt = row.querySelector('[data-dxpt]');
  if (bar) bar.style.width = DxCard.pct(p.done, p.total) + '%';
  if (pt) pt.textContent = DxCard.progressText(p.done, p.total, p.speed);
});
async function dxAct(act, id) {
  const A = window.api, F = {
    accept: () => A.dxAccept(id, false), acceptas: () => A.dxAccept(id, true), decline: () => A.dxDecline(id),
    pause: () => A.dxPause(id), resume: () => A.dxResume(id), cancel: () => A.dxCancel(id), cancelout: () => A.dxCancelOut(id),
    remove: () => A.dxRemove(id), opendir: () => A.dxOpenDir(id),
  };
  if (!F[act]) return;
  if ((act === 'cancel' || act === 'cancelout') && !(await ask(txf('dx.cancelConfirm', 'Batalkan transfer ini?\nBerkas setengah jadi dibuang dan pihak lain diberi tahu.'), { ok: txf('dx.cancelOk', 'Batalkan transfer'), cancel: txf('dx.cancelBack', 'Kembali'), danger: true }))) return;
  const r = await F[act]();
  if (r && r.ok === false && r.code !== 'abort') notify(r.err);
  dxLoad();
}
$('dxlist').onclick = (e) => { const b = e.target.closest && e.target.closest('[data-act]'); if (b) dxAct(b.getAttribute('data-act'), b.getAttribute('data-id')); };
function dxClose() { $('dxmodal').style.display = 'none'; }
$('dxclose').onclick = dxClose;
$('dxmodal').onclick = (e) => { if (e.target === $('dxmodal')) dxClose(); };
$('dxfolder').onclick = async () => { const r = await window.api.dxOpenDir(''); if (r && r.ok === false) notify(r.err); };
dxLoad();

// ---- Kirim dari chat pribadi (step 2c): butir "Kirim berkas…" / "Kirim folder…" di menu ⋮ header -> dialog sistem -> tawaran ----
var dxJobN = 0;
function dxShow() { $('dxmodal').style.display = 'flex'; dxRender(); return dxLoad(); }
// Bilah "Menyiapkan tawaran…" dengan tombol Batalkan selama pemindaian/pengiriman tawaran (folder besar bisa lama). Batal = api.dxCancelScan(job); Core tidak mengirim tawaran apa pun.
var dxJobCur = null;
function dxScanBar(on, txt) {
  const b = $('dxscanbar'); if (!b) return;
  b.style.display = on ? 'flex' : 'none';
  if (on && txt) $('dxscantxt').textContent = txt;
}
// HP (tanpa pemilih berkas berpath, S.canDirectCopy): bila cangkang Android bisa memilih berpath (dxNat.pick) berkas dikirim dari lokasi aslinya; kalau tidak, pemilih web + salin satu per satu ke cache aplikasi (inti menghapusnya saat transfer berakhir), lalu tawarkan salinannya.
var dxCopyAc = null;
// Cangkang Android bisa memilih berkas dengan path aslinya (tanpa menyalin): induk -> UI { native-caps, pick:true }, { native-pick, id, ok, paths | code }.
var dxNat = { pick: false, seq: 0, wait: new Map(), asked: false };
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || typeof d !== 'object') return;
    try { if (!window.parent || window.parent === window || e.source !== window.parent) return; } catch { return; }
    if (d.archne === 'native-caps') dxNat.pick = d.pick === true;
    else if (d.archne === 'native-pick' && dxNat.wait.has(d.id)) { const f = dxNat.wait.get(d.id); dxNat.wait.delete(d.id); f(d); }
  });
}
// Hasil: daftar path (asli, atau salinan sementara di dxout untuk berkas yang path-nya tak terbaca) atau null (batal/perlu izin/galat; sudah diberi tahu).
async function dxPickNative(job) {
  const r = await new Promise((resolve) => {
    const id = ++dxNat.seq;
    dxNat.wait.set(id, resolve);
    try { window.parent.postMessage({ archne: 'native', action: 'dxpick', id, job, skip: dxNat.asked }, '*'); } catch { dxNat.wait.delete(id); resolve({ ok: false, code: 'err', err: txf('dx.pickOpenFail', 'Gagal membuka pemilih berkas') }); }
  });
  if (r.code === 'cancel') return null;
  if (r.code === 'perm') { dxNat.asked = true; notify(txf('dx.permNote', 'Nyalakan "Izinkan akses semua berkas" untuk Archne di pengaturan yang terbuka, lalu kembali ke Archne dan ketuk Kirim berkas lagi. Tanpa izin itu, berkas disalin dulu ke cache sebelum dikirim.')); return null; }
  if (!r.ok || !Array.isArray(r.paths) || !r.paths.length) { if (!r.ok) notify(r.err || txf('dx.pickFail', 'Gagal memilih berkas')); return null; }
  return r.paths;
}
async function dxCopyPick(job) {
  const files = await window.api.pickFiles();
  if (!files || !files.length) return null;
  dxJobCur = job; dxCopyAc = new AbortController(); $('dxscancancel').disabled = false;
  const out = [];
  for (let i = 0; i < files.length; i++) {
    dxScanBar(true, txf('dx.copying', 'Menyalin ke cache… {i}/{n}', { i: i + 1, n: files.length }));
    const r = await window.api.dxUpload(job, files[i], dxCopyAc.signal);
    if (!r || !r.ok) {
      if (r && r.code === 'abort') { toast(txf('dx.aborted', 'Pengiriman dibatalkan')); return null; }
      window.api.dxCancelScan(job); // buang salinan yang sudah masuk
      notify((r && r.err) || txf('dx.copyFail', 'Gagal menyalin berkas')); return null;
    }
    out.push(r.path);
  }
  return out;
}
async function dxSendRun(kind, to) {
  if (dxJobCur) return toast(txf('dx.busy', 'Masih menyiapkan tawaran sebelumnya'));
  const job = 'x' + Date.now().toString(36) + (dxJobN++), copy = !S.canDirect && !!S.canDirectCopy;
  let ps;
  if (copy && dxNat.pick) { // HP: kirim dari lokasi aslinya; hanya berkas yang path-nya tak terbaca yang disalin (oleh cangkang)
    ps = await dxPickNative(job);
    if (!ps) return;
    dxJobCur = job;
  } else if (copy) { // tanpa cangkang yang bisa memilih berpath: pemilih web + unggah ke cache
    try { ps = await dxCopyPick(job); } finally { if (!ps) { dxJobCur = null; dxCopyAc = null; dxScanBar(false); } }
    if (!ps) return;
  } else {
    ps = await window.api.dxPick(kind);
    if (!ps || !ps.length) return;
    dxJobCur = job;
  }
  $('dxscancancel').disabled = false; dxScanBar(true, txf('dx.scanning', 'Menyiapkan tawaran…'));
  let r;
  try { r = await window.api.dxSend(job, to, ps); } finally { dxJobCur = null; dxCopyAc = null; dxScanBar(false); }
  if (!r || r.ok === false) { if (!r || r.code !== 'abort') notify((r && r.err) || txf('cam.sendFail', 'Gagal mengirim')); else toast(txf('dx.aborted', 'Pengiriman dibatalkan')); return; }
  toast(txf('dx.sent', 'Tawaran terkirim. Menunggu penerima…'));
  dxShow();
}
$('dxscancancel').onclick = () => { if (dxJobCur) { $('dxscancancel').disabled = true; if (dxCopyAc) dxCopyAc.abort(); window.api.dxCancelScan(dxJobCur); } };
window.api.onDxScan((p) => { if (p && p.count && dxJobCur && (!p.job || p.job === dxJobCur)) dxScanBar(true, tnf('dx.scanN', p.count, 'Memindai folder… {count} berkas', { count: p.count })); });

// ---- Pengaturan: Kirim Langsung (step 2d) ----
// Folder tujuan terima. Path TIDAK pernah lewat renderer: "Ubah…" membuka dialog folder di proses utama (api.dxChooseDir), Core memvalidasi lalu menyimpannya (settings.json `directDir`).
// Jadi perubahan folder langsung berlaku (tidak menunggu tombol Simpan); "Kembalikan ke bawaan" juga. Hanya tawaran yang diterima sesudahnya memakai folder baru.
// Bagian ini kosong (tidak digambar) di perangkat tanpa pemilih folder berpath (Android/headless) dan bila inti lama tidak mengirim `direct`.
var dxDirBusy = false;
function dxDirPaint(x) {
  const p = $('setdxdir'), b = $('setdxreset');
  if (p) { p.textContent = x.dir; p.title = x.dir; }
  if (b) b.disabled = !x.custom;
}
SET_SECTIONS.push({
  id: 'direct', order: 25,
  get title() { return txf('dx.title', 'Kirim Langsung'); },
  html(d) {
    const x = d && d.direct;
    if (!d || !d.canDirect || !x || typeof x.dir !== 'string') return '';
    const pick = d.canPickDir === false ? '' : '<button type="button" id="setdxpick" class="sec">' + esc(txf('dx.dirChange', 'Ubah…')) + '</button>';
    return '<div class="sint">' + esc(txf('dx.dirIntro', 'Berkas dan folder yang kamu terima lewat Kirim Langsung (antar perangkat di jaringan yang sama) disimpan di sini.')) + '</div>'
      + '<div class="setgrp"><div class="strow"><div class="stt">' + esc(txf('dx.dirTitle', 'Folder terima')) + '</div><div class="sth stpath" id="setdxdir" title="' + esc(x.dir) + '">' + esc(x.dir) + '</div>'
      + '<div class="stc">' + pick + '<button type="button" id="setdxreset" class="sec"' + (x.custom ? '' : ' disabled') + '>' + esc(txf('dx.dirResetBtn', 'Kembalikan ke bawaan')) + '</button></div></div></div>'
      + '<div class="setnote">' + esc(txf('dx.dirNote', 'Berlaku untuk tawaran yang kamu terima sesudah mengubahnya. Transfer yang sedang berjalan tetap di foldernya. Saat menerima, kamu juga bisa memilih folder lain untuk satu transfer saja.')) + '</div>';
  },
  async save() { return { ok: true }; }, // perubahan folder sudah tersimpan saat dipilih
});
$('setbody').onclick = async (e) => {
  const t = e && e.target, b = t && (t.closest ? t.closest('button') : t), id = b && b.id;
  if (id !== 'setdxpick' && id !== 'setdxreset') return;
  if (dxDirBusy) return;
  dxDirBusy = true;
  try {
    const r = id === 'setdxpick' ? await window.api.dxChooseDir() : await window.api.setSettings({ directDir: null });
    if (!r || r.ok === false) { if (r && r.code === 'abort') return; return notify((r && r.err) || txf('dx.dirFail', 'Gagal mengubah folder terima')); }
    if (r.direct) { if (setData) setData.direct = r.direct; dxDirPaint(r.direct); }
    toast(id === 'setdxpick' ? txf('dx.dirChanged', 'Folder terima diubah') : txf('dx.dirResetDone', 'Folder terima dikembalikan ke bawaan'), true);
    dxLoad();
  } finally { dxDirBusy = false; }
};
