// Web Lokal (0.34.0 Fase E.2): tab Berkas di layar Ubah situs. Daftar isi folder, breadcrumb, folder / berkas baru, ganti nama, pindah (menu atau seret), hapus (massal, dengan konfirmasi).
// Renderer hanya memegang id situs dan jalur RELATIF di www/ (nama berkas dari IPC webFiles); tidak ada jalur disk. Validasi nama dan jalur ada di Core / WebFiles, galatnya ditampilkan apa adanya di panel.
// Unggah + seret-lepas dari luar aplikasi = archne-web-up.js; editor teks = archne-web-edit.js (keduanya Fase E, Sesi E-3). Satu operasi sekaligus (F.busy); balasan yang datang sesudah layar ditutup dibuang (F !== lwF).
// Kembali (lwFilesBack): editor (bila terbuka di tab Berkas) atau panel inline (nama / pindah) ditutup dulu; sesudah itu urusan layar situs di archne-web-mine.js.
let lwF = null; // { id, dir, items: null | [{ name, type, size, mtime }], err, loading, busy, sel: Set(nama), mode: null | { kind, ... }, drag: null | [nama], up: null | { done, total }, ed: null | keadaan editor (archne-web-edit.js), vw: null | keadaan penampil media (archne-web-view.js) }; null = tab tidak aktif
const lwFIc = (d) => svg(d).replace('<svg ', '<svg class="ic" ');
const LW_FIC = { dir: lwFIc('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'), file: lwFIc('<path d="M6 3h8l5 5v12a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/>') };
const lwFJoin = (dir, name) => (dir ? dir + '/' + name : name);
const lwFParts = (dir) => (dir ? dir.split('/') : []);
const lwFPath = (arr, n) => arr.slice(0, n).join('/');

function lwFilesStop() { if (lwF && lwF.vw) lwVwRevoke(lwF.vw); lwF = null; }
function lwFilesStart(id) { lwF = { id, dir: '', items: null, err: '', loading: false, busy: false, sel: new Set(), mode: null, drag: null, up: null, ed: null, vw: null }; lwFilesPaint(); lwFilesLoad(''); }
function lwFilesBack() { // true bila ada yang ditutup: penampil media / editor (hanya bila tab Berkas aktif) atau panel inline
  if (lwF && lwF.vw && lwM && lwM.site && lwM.site.tab === 'files') { lwVwClose(); return true; }
  if (lwF && lwF.ed && lwM && lwM.site && lwM.site.tab === 'files') { lwEdClose(); return true; }
  if (!lwF || !lwF.mode) return false;
  lwF.mode = null; lwFilesPaint();
  return true;
}
function lwFilesFail(r) { return (r && r.err) || txf('common.error', 'Terjadi kesalahan'); }
// Muat isi folder `dir`. Gagal membuka folder lain (mis. sudah dihapus) = tetap di folder sekarang + pemberitahuan; gagal memuat pertama = pesan + Coba lagi.
async function lwFilesLoad(dir) {
  const F = lwF; if (!F) return;
  F.loading = true; lwFilesPaint();
  let r; try { r = await window.api.webFiles(F.id, dir); } catch (x) { r = null; }
  if (F !== lwF) return;
  F.loading = false;
  if (r && r.ok) { F.dir = dir; F.items = Array.isArray(r.items) ? r.items : []; F.err = ''; F.sel = new Set(); }
  else if (F.items === null) F.err = lwFilesFail(r);
  else { notify(lwFilesFail(r)); if (dir !== F.dir) { lwFilesPaint(); return; } F.err = ''; }
  lwFilesPaint();
}
const lwFSiteDomain = () => { const s = lwM && (lwM.items || []).find((x) => x.id === (lwF && lwF.id)); return s ? s.domain : ''; };
function lwFCrumbHtml(F) {
  const parts = lwFParts(F.dir), root = (lwFSiteDomain() || 'web') + '.archne';
  const one = (label, n) => (n === parts.length ? `<span class="lwcr" aria-current="page">${esc(label)}</span>` : `<button type="button" class="lwcr" data-lw="fcrumb" data-d="${esc(lwFPath(parts, n))}" data-drop="${esc(lwFPath(parts, n))}">${esc(label)}</button>`);
  return `<nav class="lwcrumb" aria-label="${esc(txf('lw.f.loc', 'Lokasi berkas'))}">${[one(root, 0)].concat(parts.map((p, i) => one(p, i + 1))).join('<span class="lwsep" aria-hidden="true">/</span>')}</nav>`;
}
const lwFBtn = (act, name, icon, label, cls) => `<button type="button" class="pib${cls ? ' ' + cls : ''}" data-lw="${act}" data-n="${esc(name)}" title="${esc(label)}" aria-label="${esc(label + ': ' + name)}">${icn(icon)}</button>`;
const LW_FCODE_RE = /\.(html?|css|m?js|json|php|xml|sql|ya?ml|webmanifest)$/i;
const LW_FVIC = { image: 'image', audio: 'music', video: 'film' };
const lwFIcon = (it) => { // ikon menurut jenis: folder, gambar / audio / video, kode, atau berkas biasa (svg dihitung gambar)
  if (it.type === 'dir') return LW_FIC.dir;
  const k = lwVwKind(it.name);
  if (k) return icn(LW_FVIC[k], 'lwfi ' + k);
  return LW_FCODE_RE.test(it.name) ? icn('code', 'lwfi code') : LW_FIC.file;
};
const lwFPh = () => '<span class="pib ph" aria-hidden="true"></span>'; // tempat kosong supaya tombol sejajar antar baris
function lwFRowHtml(F, it) {
  const sel = F.sel.has(it.name), dir = it.type === 'dir', kind = dir ? '' : lwVwKind(it.name), text = !dir && lwEdOk(it.name);
  const size = dir ? '—' : (typeof FileCard !== 'undefined' && FileCard.fmtSize ? FileCard.fmtSize(it.size) : it.size + ' B');
  let when = ''; try { when = shortWhen(it.mtime); } catch (x) {}
  const ic = lwFIcon(it);
  const nm = dir ? `<button type="button" class="lwfn dir" data-lw="fopen" data-n="${esc(it.name)}">${ic}<span>${esc(it.name)}</span></button>`
    : text ? `<button type="button" class="lwfn dir" data-lw="fedit" data-n="${esc(it.name)}" title="${esc(txf('lw.e.open', 'Buka di editor'))}">${ic}<span>${esc(it.name)}</span></button>`
    : kind ? `<button type="button" class="lwfn dir" data-lw="fview" data-n="${esc(it.name)}" title="${esc(txf('lw.f.view', 'Lihat'))}">${ic}<span>${esc(it.name)}</span></button>`
    : `<span class="lwfn">${ic}<span>${esc(it.name)}</span></span>`;
  const acts = (kind ? lwFBtn('fview', it.name, 'eye', txf('lw.f.view', 'Lihat')) : (typeof lwZipRowBtn === 'function' && lwZipRowBtn(it)) || lwFPh()) + (text ? lwFBtn('fedit', it.name, 'edit', txf('lw.f.edit', 'Edit')) : lwFPh())
    + lwFBtn('fren', it.name, 'rename', txf('lw.f.rename', 'Ganti nama')) + lwFBtn('fmv', it.name, 'fwd', txf('lw.f.move', 'Pindah')) + lwFBtn('fdel', it.name, 'trash', txf('lw.f.del', 'Hapus'), 'dng');
  return `<tr class="lwfr${sel ? ' sel' : ''}" draggable="true" data-n="${esc(it.name)}"${dir ? ` data-drop="${esc(lwFJoin(F.dir, it.name))}"` : ''}>`
    + `<td class="lwfc"><input type="checkbox" data-lw="fsel" data-n="${esc(it.name)}"${sel ? ' checked' : ''} aria-label="${esc(txf('lw.f.sel', 'Pilih {name}', { name: it.name }))}"></td>`
    + `<td>${nm}</td><td class="lwfs">${esc(size)}</td><td class="lwfm">${esc(when)}</td>`
    + `<td class="lwfa">${acts}</td></tr>`;
}
function lwFModeHtml(F) {
  const m = F.mode; if (!m) return '';
  const err = m.err ? `<p class="lwnote err" role="alert">${esc(m.err)}</p>` : '';
  if (m.kind === 'move') {
    const parts = lwFParts(m.dest), crumbs = [`<button type="button" class="lwcr" data-lw="fmvgo" data-d="">${esc((lwFSiteDomain() || 'web') + '.archne')}</button>`].concat(parts.map((p, i) => `<button type="button" class="lwcr" data-lw="fmvgo" data-d="${esc(lwFPath(parts, i + 1))}">${esc(p)}</button>`)).join('<span class="lwsep" aria-hidden="true">/</span>');
    const list = m.dirs === null ? `<p class="lwnote">${esc(txf('lw.loading', 'Memuat…'))}</p>` : m.dirs.length ? `<div class="lwmvl">${m.dirs.map((d) => `<button type="button" class="sec lwmvd" data-lw="fmvgo" data-d="${esc(lwFJoin(m.dest, d))}">${LW_FIC.dir}<span>${esc(d)}</span></button>`).join('')}</div>` : `<p class="lwnote">${esc(txf('lw.f.moveNone', 'Tidak ada folder lagi di sini.'))}</p>`;
    return `<div class="lwfmode"><b>${esc(txf('lw.f.moveTo', 'Pindahkan {n} item ke:', { n: m.names.length }))}</b><nav class="lwcrumb">${crumbs}</nav>${list}${err}<div class="lwacts"><button type="button" data-lw="fmvdo"${F.busy || m.dest === F.dir ? ' disabled' : ''}>${esc(txf('lw.f.moveHere', 'Pindah ke sini'))}</button>${m.dest ? `<button type="button" class="sec" data-lw="fmvgo" data-d="${esc(lwFPath(parts, parts.length - 1))}">${esc(txf('lw.f.moveUp', 'Naik satu tingkat'))}</button>` : ''}<button type="button" class="sec" data-lw="fcancel">${esc(txf('common.cancel', 'Batal'))}</button></div></div>`;
  }
  const label = m.kind === 'mkdir' ? txf('lw.f.nameMk', 'Nama folder baru') : m.kind === 'newfile' ? txf('lw.f.nameNew', 'Nama berkas baru') : txf('lw.f.nameRen', 'Nama baru untuk “{name}”', { name: m.name });
  const hint = m.kind === 'newfile' ? `<small>${esc(txf('lw.f.nameHint', 'Berkas teks: .html .css .js .json .txt .svg .md'))}</small>` : '';
  return `<form id="lwfmode" class="lwfmode" novalidate><label class="lwfl" for="lwfname"><span>${esc(label)}</span><input id="lwfname" type="text" maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(m.value)}">${hint}</label>${err}<div class="lwacts"><button type="submit"${F.busy ? ' disabled' : ''}>${esc(txf('lw.f.ok', 'OK'))}</button><button type="button" class="sec" data-lw="fcancel">${esc(txf('common.cancel', 'Batal'))}</button></div></form>`;
}
function lwFilesHtml(F) {
  const n = F.sel.size, items = F.items || [];
  let h = lwFCrumbHtml(F) + `<div class="lwftb"><button type="button" class="sec" data-lw="fmk">${esc(txf('lw.f.mkdir', 'Folder baru'))}</button><button type="button" class="sec" data-lw="fnew">${esc(txf('lw.f.newfile', 'Berkas baru'))}</button><button type="button" class="sec" data-lw="fup">${esc(txf('lw.u.btn', 'Unggah'))}</button>${typeof S !== 'undefined' && S.canDirect ? `<button type="button" class="sec" data-lw="fupdir">${esc(txf('lw.u.btnDir', 'Unggah folder'))}</button>` : ''}${typeof lwZipBtn === 'function' ? lwZipBtn(F) : ''}`;
  if (n) h += `<span class="lwsel">${esc(txf('lw.f.selN', '{n} dipilih', { n }))}</span><button type="button" class="sec" data-lw="fmv">${esc(txf('lw.f.move', 'Pindah'))}</button><button type="button" class="sec dng" data-lw="fdel">${esc(txf('lw.f.del', 'Hapus'))}</button>`;
  h += `</div>` + lwUpHtml(F) + lwFModeHtml(F);
  if (F.err) h += `<p class="lwnote err" role="alert">${esc(F.err)} <button type="button" class="sec" data-lw="fretry">${esc(txf('lw.retry', 'Coba lagi'))}</button></p>`;
  if (F.items === null) { if (!F.err) h += `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>`; return h; }
  if (!items.length) return h + `<p class="lwempty">${esc(txf('lw.f.empty', 'Folder ini kosong.'))}<br><small>${esc(txf('lw.u.dropHint', 'Seret berkas ke sini atau ketuk Unggah.'))}</small></p>`;
  return h + `<div class="lwfwrap"><table class="lwft"><thead><tr><th class="lwfc"><input type="checkbox" data-lw="fall" aria-label="${esc(txf('lw.f.selAll', 'Pilih semua'))}"${n === items.length ? ' checked' : ''}></th><th>${esc(txf('lw.f.col.name', 'Nama'))}</th><th class="lwfs">${esc(txf('lw.f.col.size', 'Ukuran'))}</th><th class="lwfm">${esc(txf('lw.f.col.mod', 'Diubah'))}</th><th></th></tr></thead><tbody>${items.map((it) => lwFRowHtml(F, it)).join('')}</tbody></table></div>`;
}
function lwFilesPaint() {
  const el = $('lwsb'), F = lwF; if (!el || !F || !lwM || !lwM.site || lwM.site.tab !== 'files') return;
  if (F.ed) lwEdPaint(el, F); else if (F.vw) lwVwPaint(el, F); else el.innerHTML = lwFilesHtml(F);
}
// Item yang dituju: satu baris (data-n) atau seluruh pilihan.
const lwFTargets = (F, d) => (d && d.n != null && d.n !== '' ? [d.n] : [...F.sel]).filter((n) => (F.items || []).some((it) => it.name === n));
function lwFMode(F, m) { F.mode = m; lwFilesPaint(); if (m.kind !== 'move') lwFocus('lwfname'); }
async function lwFMoveDirs(F, m) { // folder tujuan yang bisa dipilih (kecuali item yang sedang dipindah)
  m.dirs = null; lwFilesPaint();
  let r; try { r = await window.api.webFiles(F.id, m.dest); } catch (x) { r = null; }
  if (F !== lwF || F.mode !== m) return;
  if (!r || !r.ok) { m.err = lwFilesFail(r); m.dirs = []; } else { m.err = ''; m.dirs = (r.items || []).filter((it) => it.type === 'dir' && !m.names.some((n) => lwFJoin(m.from, n) === lwFJoin(m.dest, it.name))).map((it) => it.name); }
  lwFilesPaint();
}
function lwFilesAct(act, d) {
  const F = lwF; d = d || {};
  if (!F || !lwM || !lwM.site || lwM.site.tab !== 'files' || !/^f/.test(act)) return false;
  if (F.busy && act !== 'fcancel') return true;
  const names = () => lwFTargets(F, d);
  switch (act) {
    case 'fopen': case 'fcrumb': F.mode = null; lwFilesLoad(act === 'fopen' ? lwFJoin(F.dir, d.n) : d.d || ''); return true;
    case 'fretry': F.err = ''; lwFilesLoad(F.dir); return true;
    case 'fsel': if (F.sel.has(d.n)) F.sel.delete(d.n); else F.sel.add(d.n); lwFilesPaint(); return true;
    case 'fall': F.sel = F.sel.size === (F.items || []).length ? new Set() : new Set((F.items || []).map((it) => it.name)); lwFilesPaint(); return true;
    case 'fmk': lwFMode(F, { kind: 'mkdir', value: '', err: '' }); return true;
    case 'fnew': lwFMode(F, { kind: 'newfile', value: '', err: '' }); return true;
    case 'fren': if (names().length === 1) lwFMode(F, { kind: 'rename', name: names()[0], value: names()[0], err: '' }); return true;
    case 'fmv': { const ns = names(); if (!ns.length) return true; const m = { kind: 'move', names: ns, from: F.dir, dest: F.dir, dirs: null, err: '' }; F.mode = m; lwFMoveDirs(F, m); return true; }
    case 'fmvgo': if (F.mode && F.mode.kind === 'move') { F.mode.dest = d.d || ''; lwFMoveDirs(F, F.mode); } return true;
    case 'fmvdo': if (F.mode && F.mode.kind === 'move') lwFilesMove(F.mode.names, F.mode.dest); return true;
    case 'fdel': lwFilesDelete(names()); return true;
    case 'fedit': lwEdOpen(d.n); return true;
    case 'fview': lwVwOpen(d.n); return true;
    case 'fcancel': F.mode = null; lwFilesPaint(); return true;
    default: return lwUpAct(act) || lwEdAct(act) || lwVwAct(act) || (typeof lwZipAct === 'function' && lwZipAct(act, d));
  }
}
// Hasil operasi massal ({ n, failed }) -> pesan. Semua gagal = galat; sebagian = ringkasan.
const lwFWhy = (code) => txf('lw.f.code.' + (code === 'exists' || code === 'nofile' ? code : 'other'), code === 'exists' ? 'nama sudah dipakai di tujuan' : code === 'nofile' ? 'sudah tidak ada' : 'tidak bisa diproses');
function lwFBulkMsg(r, okKey, okFb) {
  const bad = (r.failed || []).length;
  if (!bad) return { ok: true, text: txf(okKey, okFb, { n: r.n }) };
  return { ok: false, text: txf('lw.f.partial', '{ok} berhasil, {bad} gagal ({why}).', { ok: r.n, bad, why: lwFWhy(r.failed[0] && r.failed[0].code) }) };
}
async function lwFRun(F, call, done) { // satu operasi: busy -> panggil -> galat di panel / pemberitahuan -> muat ulang
  if (F.busy) return;
  F.busy = true; lwFilesPaint();
  let r; try { r = await call(); } catch (x) { r = null; }
  if (F !== lwF) return;
  F.busy = false;
  if (!r || !r.ok) { const e = lwFilesFail(r); if (F.mode) { F.mode.err = e; lwFilesPaint(); lwFocus('lwfname'); } else { lwFilesPaint(); notify(e); } return; }
  const msg = done ? done(r) : null; F.mode = null;
  if (msg) { if (msg.ok) toast(msg.text, true); else notify(msg.text); }
  await lwFilesLoad(F.dir);
}
async function lwFilesSubmit() { // panel nama (folder baru / berkas baru / ganti nama)
  const F = lwF, m = F && F.mode; if (!F || !m || m.kind === 'move' || F.busy) return;
  const el = $('lwfname'), name = (el ? String(el.value == null ? '' : el.value) : m.value).trim(); m.value = name;
  if (!name) { m.err = txf('lw.f.nameEmpty', 'Nama tidak boleh kosong.'); lwFilesPaint(); lwFocus('lwfname'); return; }
  if (/[\\/]/.test(name)) { m.err = txf('lw.f.nameSlash', 'Nama tidak boleh memuat garis miring.'); lwFilesPaint(); lwFocus('lwfname'); return; }
  if (m.kind === 'rename' && name === m.name) { F.mode = null; lwFilesPaint(); return; }
  const rel = lwFJoin(F.dir, m.kind === 'rename' ? m.name : name), api = window.api;
  if (m.kind === 'mkdir') return lwFRun(F, () => api.webMkdir(F.id, rel), () => ({ ok: true, text: txf('lw.f.made', 'Folder dibuat') }));
  if (m.kind === 'newfile') return lwFRun(F, () => api.webFileWrite(F.id, rel, '', { create: true }), () => ({ ok: true, text: txf('lw.f.created', 'Berkas dibuat') }));
  return lwFRun(F, () => api.webRename(F.id, rel, name), () => ({ ok: true, text: txf('lw.f.renamed', 'Nama diganti') }));
}
function lwFilesMove(names, dest) { // dari panel Pindah dan dari seret-lepas; dest = jalur relatif folder tujuan ('' = utama)
  const F = lwF; if (!F || F.busy) return;
  const rels = names.map((n) => lwFJoin(F.dir, n)).filter((p) => dest !== p && !(dest + '/').startsWith(p + '/')); // tidak ke dirinya / ke dalam dirinya
  if (!rels.length || dest === F.dir) { if (F.mode) { F.mode = null; lwFilesPaint(); } return; }
  return lwFRun(F, () => window.api.webMove(F.id, rels, dest), (r) => lwFBulkMsg(r, 'lw.f.moved', '{n} item dipindah'));
}
async function lwFilesDelete(names) {
  const F = lwF; if (!F || F.busy || !names.length) return;
  const what = names.length === 1 ? '“' + names[0] + '”' : txf('lw.f.items', '{n} item', { n: names.length });
  if (!await ask(txf('lw.f.delAsk', 'Hapus {what}?\nIsinya (termasuk isi folder) hilang permanen dari situs ini. Ini tidak bisa dibatalkan.', { what }), { ok: txf('lw.f.del', 'Hapus'), danger: true })) return;
  if (F !== lwF) return;
  return lwFRun(F, () => window.api.webDelete(F.id, names.map((n) => lwFJoin(F.dir, n))), (r) => lwFBulkMsg(r, 'lw.f.deleted', '{n} item dihapus'));
}
// Seret antar folder di dalam daftar (hanya sumber dari daftar ini; seret dari luar aplikasi = Sesi E-3).
(function lwFilesWire() {
  const page = $('webpage'); if (!page || !page.addEventListener) return;
  const row = (e) => (e.target && e.target.closest ? e.target.closest('tr[data-n]') : null);
  const zone = (e) => (e.target && e.target.closest ? e.target.closest('[data-drop]') : null);
  page.addEventListener('dragstart', (e) => {
    const r = row(e), F = lwF; if (!r || !F || F.busy) return;
    const n = r.dataset.n; F.drag = F.sel.has(n) ? [...F.sel] : [n];
    if (e.dataTransfer) { try { e.dataTransfer.setData('text/plain', 'archne-lw'); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} }
  });
  const mark = (el, on) => { try { if (el && el.classList) el.classList[on ? 'add' : 'remove']('dropon'); } catch (x) {} };
  page.addEventListener('dragover', (e) => { const z = zone(e); if (lwF && lwF.drag && z) { if (e.preventDefault) e.preventDefault(); mark(z, true); } });
  page.addEventListener('dragleave', (e) => mark(zone(e), false));
  page.addEventListener('drop', (e) => {
    const z = zone(e), F = lwF; if (!F || !F.drag || !z) return;
    if (e.preventDefault) e.preventDefault();
    mark(z, false); const names = F.drag; F.drag = null; lwFilesMove(names, z.dataset.drop || '');
  });
  page.addEventListener('dragend', () => { if (lwF) lwF.drag = null; });
})();
