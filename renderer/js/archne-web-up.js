// Web Lokal (0.34.0 Fase E.3): unggah ke situs sendiri dari tab Berkas. Tombol Unggah (berkas), Unggah folder (hanya desktop, S.canDirect), seret-lepas dari luar aplikasi, kemajuan, dan dialog tabrakan nama.
// Renderer tidak pernah memegang jalur situs di disk. Sumber = hasil pemilih (Electron: jalur yang sudah disetujui pathGuard; Android / peramban: objek File yang diunggah dulu lewat api.webUpload) atau api.pathOf(File) dari seret-lepas.
// Tabrakan nama: unggahan pertama TIDAK menimpa (overwrite:false). Bila ada yang dilewati dengan kode 'exists', pengguna ditanya sekali: Timpa (ulang dengan overwrite:true) atau Lewati. Kegagalan lain (tautan simbolis, nama tak sah, ...) dilaporkan di akhir, tidak menggagalkan sisanya.
// Satu operasi sekaligus: memakai lwFRun (F.busy), jadi tombol lain dan seretan baris ditahan selama unggahan. Kemajuan datang dari event 'webprog' dan hanya mengubah bilah (tanpa menggambar ulang daftar).
const LW_UP_CODES = ['exists', 'link', 'name', 'srcnone', 'type', 'io'];
const LW_UP_WHY = { exists: 'sudah ada', link: 'tautan simbolis tidak diunggah', name: 'nama tidak sah', srcnone: 'sumber tidak ditemukan', type: 'bukan berkas biasa', io: 'gagal dibaca atau ditulis' };
const lwUWhy = (c) => (LW_UP_CODES.includes(c) ? txf('lw.u.code.' + c, LW_UP_WHY[c]) : txf('lw.u.code.other', 'tidak bisa diunggah'));
const lwUBase = (p) => String(p == null ? '' : p).split('/').pop();

function lwUpHtml(F) { // bilah kemajuan di atas daftar (null bila tidak ada unggahan)
  const u = F.up; if (!u) return '';
  const pct = u.total ? Math.min(100, Math.round((u.done * 100) / u.total)) : 0;
  return `<div class="lwup" aria-live="polite"><span id="lwupt">${esc(lwUText(u))}</span><div class="lwupbar" aria-hidden="true"><i id="lwupf" style="width:${pct}%"></i></div></div>`;
}
const lwUText = (u) => (u.kind === 'zip' ? txf('lw.z.prog', 'Mengekstrak… {done} dari {total} berkas', { done: u.done, total: u.total }) : u.kind === 'pack' ? (u.total ? txf('lw.z.packProg', 'Mengemas… {done} dari {total} item', { done: u.done, total: u.total }) : txf('lw.z.pack', 'Menyiapkan ZIP…')) : u.total ? txf('lw.u.prog', 'Mengunggah… {done} dari {total} berkas', { done: u.done, total: u.total }) : txf('lw.u.prep', 'Menyiapkan unggahan…'));
function lwUpProg(p) { // event webprog { id, done, total }
  const F = lwF;
  if (!F || !F.up || !p || p.id !== F.id) return;
  F.up.done = Number(p.done) || 0; F.up.total = Number(p.total) || 0;
  try {
    const t = $('lwupt'), f = $('lwupf');
    if (t) t.textContent = lwUText(F.up);
    if (f && f.style) f.style.width = (F.up.total ? Math.min(100, Math.round((F.up.done * 100) / F.up.total)) : 0) + '%';
  } catch (x) {}
}

// Satu unggahan (dua tahap bila ada tabrakan). Mengembalikan hasil webUpload terakhir ({ ok, done, total, skipped, skippedN, cut }) atau galat.
async function lwUpCall(F, srcs, dir) {
  const api = window.api;
  F.up = { done: 0, total: 0 }; lwFilesPaint(); // lwFRun sudah menggambar (sibuk) sebelum memanggil ini; gambar lagi agar bilah muncul
  try {
    let r = await api.webUpload(F.id, dir, srcs, { overwrite: false });
    if (F !== lwF || !r || !r.ok) return r;
    const list = r.skipped || [], clash = list.filter((s) => s.code === 'exists');
    if (!clash.length) return r;
    F.up = null; lwFilesPaint(); // bilah disembunyikan selama dialog
    const more = (r.skippedN || 0) > list.length ? '+' : '';
    const yes = await ask(txf('lw.u.clashAsk', '{n}{more} berkas sudah ada di situs ini\nTimpa dengan yang baru? Contoh: {names}', { n: clash.length, more, names: clash.slice(0, 3).map((s) => lwUBase(s.p)).join(', ') }), { ok: txf('lw.u.overwrite', 'Timpa'), cancel: txf('lw.u.skip', 'Lewati'), danger: true });
    if (F !== lwF || !yes) return r;
    F.up = { done: 0, total: 0 }; lwFilesPaint();
    return await api.webUpload(F.id, dir, srcs, { overwrite: true });
  } finally { F.up = null; }
}
function lwUpMsg(r) { // hasil -> { ok, text } untuk toast (ok) atau pemberitahuan (ada yang dilewati)
  const sk = r.skipped || [], bad = r.skippedN || sk.length, done = r.done || 0;
  let text, ok = true;
  if (bad) {
    ok = false;
    text = txf('lw.u.partial', '{ok} berkas diunggah, {bad} dilewati ({why}): {names}', { ok: done, bad, why: lwUWhy(sk[0] && sk[0].code), names: sk.slice(0, 3).map((s) => lwUBase(s.p)).join(', ') });
  } else text = done ? txf('lw.u.done', '{n} berkas diunggah', { n: done }) : txf('lw.u.dirsOnly', 'Folder dibuat; tidak ada berkas di dalamnya');
  if (r.cut) { ok = false; text += ' ' + txf('lw.u.cut', 'Folder terlalu besar, sebagian tidak dibaca.'); }
  return { ok, text };
}
function lwUpload(srcs, dir) {
  const F = lwF;
  if (!F || !Array.isArray(srcs) || !srcs.length) return;
  if (F.busy || F.ed) { toast(txf('lw.u.wait', 'Tunggu operasi sebelumnya selesai.')); return; }
  return lwFRun(F, () => lwUpCall(F, srcs, dir == null ? F.dir : dir), lwUpMsg);
}
async function lwUpPick(kind) {
  const F = lwF; if (!F || F.busy) return;
  let src; try { src = kind === 'folder' ? await window.api.dxPick('folder') : await window.api.pickFiles(); } catch (x) { src = []; }
  if (F !== lwF || !Array.isArray(src) || !src.length) return;
  return lwUpload(src, F.dir);
}
function lwUpAct(act) {
  if (act === 'fup') { lwUpPick('files'); return true; }
  if (act === 'fupdir') { lwUpPick('folder'); return true; }
  return false;
}

// Seret-lepas dari luar aplikasi (File dari sistem). Seretan baris di dalam daftar (F.drag) bukan urusan di sini: lihat archne-web-files.js.
(function lwUpWire() {
  const page = $('webpage'); if (!page || !page.addEventListener) return;
  const active = () => !!(lwOpen && lwF && lwM && lwM.site && lwM.site.tab === 'files' && !lwF.ed);
  const hasFiles = (e) => { const t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.from(t).includes('Files'); };
  const zone = (e) => (e.target && e.target.closest ? e.target.closest('[data-drop]') : null) || $('lwsb');
  const mark = (el, on) => { try { if (el && el.classList) el.classList[on ? 'add' : 'remove']('dropon'); } catch (x) {} };
  page.addEventListener('dragover', (e) => {
    if (!lwOpen || (lwF && lwF.drag) || !hasFiles(e)) return;
    if (e.preventDefault) e.preventDefault(); // di luar tab Berkas pun dicegah: Electron akan membuka berkasnya sebagai halaman
    if (!active()) { try { e.dataTransfer.dropEffect = 'none'; } catch (x) {} return; }
    try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {}
    mark(zone(e), true);
  });
  page.addEventListener('dragleave', (e) => { mark(zone(e), false); mark($('lwsb'), false); });
  page.addEventListener('drop', (e) => {
    if (!lwOpen || (lwF && lwF.drag) || !hasFiles(e)) return;
    if (e.preventDefault) e.preventDefault();
    mark(zone(e), false); mark($('lwsb'), false);
    if (!active()) return;
    const F = lwF, z = e.target && e.target.closest ? e.target.closest('[data-drop]') : null, dt = e.dataTransfer;
    const files = Array.from(dt.files || []), items = Array.from(dt.items || []), srcs = [];
    let dirs = 0;
    files.forEach((f, i) => {
      const p = window.api.pathOf(f); if (!p) return;
      const en = items[i] && items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null; // harus dibaca sekarang, di dalam kejadian drop
      if (typeof p !== 'string' && en && en.isDirectory) { dirs++; return; } // Android / peramban: folder tidak punya jalur
      srcs.push(p);
    });
    if (dirs) notify(txf('lw.u.noFolder', 'Folder tidak bisa diunggah dengan cara ini di perangkat ini. Unggah berkasnya saja.'));
    if (srcs.length) lwUpload(srcs, z ? z.dataset.drop || '' : F.dir);
  });
})();
if (window.api && typeof window.api.onWebProg === 'function') window.api.onWebProg(lwUpProg);
