// Web Lokal (0.34.0 Fase U2): ZIP di tab Berkas. Tombol "Unduh ZIP" (seluruh situs, atau item yang dipilih) dan ikon ekstrak di baris berkas .zip.
// Dialog simpan ada di proses utama (api.webZipExport): renderer tidak pernah menerima atau mengirim jalur disk, hanya id situs dan jalur RELATIF di www/. Tombol Unduh hanya tampil bila S.canSave (ada dialog simpan; Electron dan Android).
// Ekstrak: periksa dulu (webZipList, tanpa menulis) -> konfirmasi -> webZipExtract (tidak menimpa) -> bila ada tabrakan nama, tanya sekali: Timpa atau Lewati. Entri jahat / tak sah dilewati oleh Core dan dilaporkan, bukan menggagalkan sisanya.
// Satu operasi sekaligus: memakai lwFRun (F.busy). Kemajuan: event 'webprog' (bilah di archne-web-up.js; F.up.kind = 'zip' | 'pack'), selesai ekspor: event 'webzip'.
const LW_Z_CODES = ['exists', 'name', 'link', 'type', 'enc', 'method', 'dup', 'self', 'bad', 'crc', 'big', 'notfile', 'notdir', 'case', 'io'];
const LW_Z_WHY = { exists: 'sudah ada', name: 'nama tidak sah', link: 'tautan simbolis', type: 'bukan berkas biasa', enc: 'terenkripsi', method: 'metode kompresi tidak didukung', dup: 'nama kembar', self: 'menimpa ZIP-nya sendiri', bad: 'isi tidak cocok dengan header', crc: 'isi rusak', big: 'terlalu besar', notfile: 'bentrok dengan folder', notdir: 'bentrok dengan berkas', case: 'beda huruf besar-kecil saja', io: 'gagal ditulis' };
const lwZWhy = (c) => (LW_Z_CODES.includes(c) ? txf('lw.z.code.' + c, LW_Z_WHY[c]) : txf('lw.z.code.other', 'tidak bisa diproses'));
const lwZIs = (name) => /\.zip$/i.test(String(name || ''));
const lwZSize = (n) => (typeof FileCard !== 'undefined' && FileCard.fmtSize ? FileCard.fmtSize(n) : n + ' B');

function lwZipBtn(F) { // tombol di bilah alat Berkas (kosong bila tidak ada dialog simpan)
  if (typeof S === 'undefined' || !S.canSave) return '';
  const n = F && F.sel ? F.sel.size : 0, t = n ? txf('lw.z.btnSel', 'Unduh ZIP ({n})', { n }) : txf('lw.z.btn', 'Unduh ZIP');
  return `<button type="button" class="sec" data-lw="fzipx"${F && F.busy ? ' disabled' : ''}>${esc(t)}</button>`;
}
// Tombol ikon di baris berkas .zip (pengganti tempat kosong tombol Lihat); '' bila bukan .zip.
function lwZipRowBtn(it) { return it && it.type !== 'dir' && lwZIs(it.name) ? lwFBtn('fzip', it.name, 'unzip', txf('lw.z.extract', 'Ekstrak ZIP')) : ''; }

function lwZMsg(r) { // hasil ekstrak -> { ok, text }
  const sk = r.skipped || [], bad = r.skippedN || sk.length, done = r.done || 0;
  if (!bad) return { ok: true, text: done ? txf('lw.z.done', '{n} berkas diekstrak', { n: done }) : txf('lw.z.dirsOnly', 'Folder dibuat; tidak ada berkas di dalamnya') };
  return { ok: false, text: txf('lw.z.partial', '{ok} berkas diekstrak, {bad} dilewati ({why}): {names}', { ok: done, bad, why: lwZWhy(sk[0] && sk[0].code), names: sk.slice(0, 3).map((s) => lwUBase(s.p)).join(', ') }) };
}
async function lwZExtract(F, name) {
  const api = window.api, rel = lwFJoin(F.dir, name);
  const info = await api.webZipList(F.id, rel);
  if (F !== lwF || !info || !info.ok) return info;
  if (!info.files && !info.dirs) return { ok: true, done: 0, total: 0, skipped: info.skipped, skippedN: info.skippedN };
  const root = info.root ? txf('lw.z.askRoot', '\nFolder induk “{root}” dilepas.', { root: info.root }) : '';
  const yes = await ask(txf('lw.z.ask', 'Ekstrak {name} ke folder ini?\n{files} berkas ({size}){root}', { name, files: info.files, size: lwZSize(info.size), root }), { ok: txf('lw.z.extractGo', 'Ekstrak'), cancel: txf('common.cancel', 'Batal') });
  if (F !== lwF || !yes) return { ok: true, cancelled: true };
  F.up = { done: 0, total: info.files, kind: 'zip' }; lwFilesPaint();
  try {
    let r = await api.webZipExtract(F.id, rel, { overwrite: false });
    if (F !== lwF || !r || !r.ok) return r;
    const clash = (r.skipped || []).filter((s) => s.code === 'exists');
    if (!clash.length) return r;
    F.up = null; lwFilesPaint();
    const more = (r.skippedN || 0) > (r.skipped || []).length ? '+' : '';
    const over = await ask(txf('lw.u.clashAsk', '{n}{more} berkas sudah ada di situs ini\nTimpa dengan yang baru? Contoh: {names}', { n: clash.length, more, names: clash.slice(0, 3).map((s) => lwUBase(s.p)).join(', ') }), { ok: txf('lw.u.overwrite', 'Timpa'), cancel: txf('lw.u.skip', 'Lewati'), danger: true });
    if (F !== lwF || !over) return r;
    F.up = { done: 0, total: info.files, kind: 'zip' }; lwFilesPaint();
    return await api.webZipExtract(F.id, rel, { overwrite: true });
  } finally { F.up = null; }
}
async function lwZExport(F, rels) {
  F.up = { done: 0, total: 0, kind: 'pack' }; lwFilesPaint();
  try { return await window.api.webZipExport(F.id, rels); } finally { F.up = null; }
}
function lwZipAct(act, d) {
  const F = lwF; d = d || {};
  if (!F || F.busy) return false;
  if (act === 'fzip') {
    if (!d.n || !lwZIs(d.n)) return true;
    lwFRun(F, () => lwZExtract(F, d.n), (r) => (r.cancelled ? null : lwZMsg(r)));
    return true;
  }
  if (act === 'fzipx') {
    const rels = [...F.sel].filter((n) => (F.items || []).some((it) => it.name === n)).map((n) => lwFJoin(F.dir, n)); // kosong = seluruh situs
    lwFRun(F, () => lwZExport(F, rels), (r) => (r.cancelled ? null : { ok: true, text: txf('lw.z.exported', 'ZIP dibuat: {name} ({n} item)', { name: r.name, n: r.n }) }));
    return true;
  }
  return false;
}
