// Web Lokal (0.34.0 Fase E.4): editor teks sederhana di tab Berkas (kotak teks + nomor baris, Simpan / Ctrl+S, peringatan perubahan belum disimpan). Editor kode lengkap = nanti.
// Hanya jenis teks yang diterima Core (html css js json txt svg md ...; UTF-8, maksimal 2 MB); selebihnya Core menolak dan galatnya ditampilkan. Renderer hanya memegang id situs + jalur relatif.
// Keadaan ada di lwF.ed = { rel, name, ready, loading, err, code, cur (isi sekarang), saved (isi tersimpan), mtime, busy, n (jumlah baris), sc / a / b (gulir dan kursor) }.
// Mengetik TIDAK menggambar ulang (kotak teks akan kehilangan kursor): pendengar 'input' hanya memperbarui cur, status, tombol Simpan, dan nomor baris. Gambar ulang penuh hanya saat berpindah keadaan (muat, simpan, galat).
// Simpan memakai base:<mtime saat dibuka>; bila berkas berubah di luar editor Core menjawab 'changed' dan pengguna memilih Muat ulang atau Timpa. Perubahan belum disimpan ditanyakan saat menutup editor, meninggalkan layar situs, atau berganti tab Jelajah / Webku.
const LW_EDIT_RE = /\.(html?|css|m?js|json|txt|svg|md|xml|webmanifest|php|sql|csv|ya?ml)$/i; // sama dengan TEXT_EXT di src/archne-ipc-webfiles.js (dijaga test/webuiu1.js)
const lwEdOk = (name) => LW_EDIT_RE.test(String(name));
const lwEdDirty = () => !!(lwF && lwF.ed && lwF.ed.ready && lwF.ed.cur !== lwF.ed.saved);
const lwEdCount = (s) => { let n = 1, i = -1; while ((i = s.indexOf('\n', i + 1)) >= 0) n++; return n; };
const lwEdGut = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i + 1; return a.join('\n'); };
const lwEdTa = () => { try { return $('lwedta'); } catch (x) { return null; } };

function lwEdHtml(F) {
  const ed = F.ed, dirty = ed.ready && ed.cur !== ed.saved;
  const back = `<button type="button" class="sec" id="lwedclose" data-lw="fedclose">${icn('back')}<span>${esc(txf('lw.e.back', 'Berkas'))}</span></button>`;
  const name = `<span class="lwedn" title="${esc(ed.rel)}">${esc(ed.rel)}</span>`;
  if (!ed.ready) return `<div class="lwedh">${back}${name}</div>` + (ed.loading ? `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>` : `<p class="lwnote err" role="alert">${esc(ed.err)}</p>`);
  ed.n = lwEdCount(ed.cur);
  const st = `<span id="lwedst" class="lwedst${dirty ? ' dirty' : ''}" role="status">${esc(dirty ? txf('lw.e.dirty', 'Belum disimpan') : txf('lw.e.clean', 'Tersimpan'))}</span>`;
  const save = `<button type="button" id="lwedsave" data-lw="fedsave"${!dirty || ed.busy ? ' disabled' : ''}>${esc(ed.busy ? txf('lw.e.saving', 'Menyimpan…') : txf('lw.e.save', 'Simpan'))}</button>`;
  let err = '';
  if (ed.err) {
    err = `<div class="lwnote err" role="alert">${esc(ed.err)}`;
    if (ed.code === 'changed') err += `<div class="lwacts"><button type="button" class="sec" data-lw="fedreload">${esc(txf('lw.e.reload', 'Muat ulang'))}</button><button type="button" class="sec dng" data-lw="fedforce">${esc(txf('lw.e.force', 'Timpa'))}</button></div>`;
    err += '</div>';
  }
  return `<div class="lwedh">${back}${name}${st}${save}</div>${err}`
    + `<div class="lwedbox"><pre id="lwedgut" class="lwedgut" aria-hidden="true">${lwEdGut(ed.n)}</pre>`
    + `<textarea id="lwedta" class="lwedta" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="none" autocorrect="off" aria-label="${esc(txf('lw.e.area', 'Isi berkas {name}', { name: ed.rel }))}"${ed.busy ? ' readonly' : ''}>\n${esc(ed.cur)}</textarea></div>`; // "\n" pertama dibuang parser; tanpa itu baris kosong di awal isi hilang
}
function lwEdPaint(el, F) { // gambar ulang penuh; gulir dan kursor dipulihkan
  const ed = F.ed, old = ed.ready ? lwEdTa() : null;
  if (old) { ed.sc = old.scrollTop || 0; ed.a = old.selectionStart || 0; ed.b = old.selectionEnd || 0; }
  el.innerHTML = lwEdHtml(F);
  const ta = ed.ready ? lwEdTa() : null;
  if (ta) { try { ta.scrollTop = ed.sc || 0; ta.setSelectionRange(ed.a || 0, ed.b || 0); const g = $('lwedgut'); if (g) g.scrollTop = ed.sc || 0; } catch (x) {} }
}
function lwEdSync() { // status, tombol Simpan, nomor baris: tanpa gambar ulang
  const ed = lwF && lwF.ed; if (!ed || !ed.ready) return;
  const dirty = ed.cur !== ed.saved;
  const st = $('lwedst'); if (st) { st.textContent = dirty ? txf('lw.e.dirty', 'Belum disimpan') : txf('lw.e.clean', 'Tersimpan'); st.className = 'lwedst' + (dirty ? ' dirty' : ''); }
  const sv = $('lwedsave'); if (sv) sv.disabled = !dirty || ed.busy;
  const n = lwEdCount(ed.cur); if (n !== ed.n) { ed.n = n; const g = $('lwedgut'); if (g) g.textContent = lwEdGut(n); }
}
function lwEdInput(t) {
  const ed = lwF && lwF.ed; if (!ed || !ed.ready || ed.busy || !t) return;
  ed.cur = String(t.value == null ? '' : t.value); ed.a = t.selectionStart || 0; ed.b = t.selectionEnd || 0;
  lwEdSync();
}

async function lwEdLoad(F, rel, name) {
  const ed = F.ed = { rel, name, ready: false, loading: true, err: '', code: '', cur: '', saved: '', mtime: null, busy: false, n: 1, sc: 0, a: 0, b: 0 };
  F.mode = null; lwFilesPaint();
  let r; try { r = await window.api.webFileRead(F.id, rel); } catch (x) { r = null; }
  if (F !== lwF || F.ed !== ed) return;
  ed.loading = false;
  if (r && r.ok && typeof r.text === 'string') { ed.ready = true; ed.cur = ed.saved = r.text; ed.mtime = r.mtime; } else ed.err = lwFilesFail(r);
  lwFilesPaint(); lwFocus(ed.ready ? 'lwedta' : 'lwedclose');
}
function lwEdOpen(name) {
  const F = lwF; if (!F || F.busy || F.ed || !lwEdOk(name)) return;
  return lwEdLoad(F, lwFJoin(F.dir, name), name);
}
async function lwEdSave(force) {
  const F = lwF, ed = F && F.ed; if (!ed || !ed.ready || ed.busy || (!force && ed.cur === ed.saved)) return;
  const sent = ed.cur; ed.busy = true; ed.err = ''; ed.code = ''; lwFilesPaint();
  let r; try { r = await window.api.webFileWrite(F.id, ed.rel, sent, force ? {} : { base: ed.mtime }); } catch (x) { r = null; }
  if (F !== lwF || F.ed !== ed) return;
  ed.busy = false;
  if (r && r.ok) { ed.saved = sent; ed.mtime = r.mtime; toast(txf('lw.e.savedToast', 'Berkas disimpan'), true); } else { ed.err = lwFilesFail(r); ed.code = (r && r.code) || ''; }
  lwFilesPaint(); lwFocus('lwedta');
}
const lwEdDiscardAsk = (ed) => ask(txf('lw.e.discardAsk', 'Buang perubahan yang belum disimpan?\n“{name}” punya perubahan yang belum disimpan. Kalau dilanjutkan, perubahan itu hilang.', { name: ed.name }), { ok: txf('lw.e.discard', 'Buang perubahan'), cancel: txf('lw.e.keep', 'Lanjut mengedit'), danger: true });
async function lwEdClose() { // tutup editor (tanya bila ada yang belum disimpan), kembali ke daftar
  const F = lwF, ed = F && F.ed; if (!ed || ed.busy) return;
  if (lwEdDirty() && !(await lwEdDiscardAsk(ed))) return;
  if (F !== lwF || F.ed !== ed) return;
  F.ed = null; lwFilesPaint(); lwFilesLoad(F.dir); // ukuran / tanggal berubah
}
async function lwEdAskLeave(next) { // dipakai saat meninggalkan layar situs / berganti tab utama dengan perubahan belum disimpan
  const F = lwF, ed = F && F.ed; if (!ed) return next();
  if (!lwEdDirty() || await lwEdDiscardAsk(ed)) { if (F === lwF && F.ed === ed) F.ed = null; if (F === lwF) return next(); }
}
async function lwEdReload() {
  const F = lwF, ed = F && F.ed; if (!ed || ed.busy) return;
  if (lwEdDirty() && !(await lwEdDiscardAsk(ed))) return;
  if (F === lwF && F.ed === ed) return lwEdLoad(F, ed.rel, ed.name);
}
async function lwEdForce() {
  const F = lwF, ed = F && F.ed; if (!ed || ed.busy) return;
  if (!(await ask(txf('lw.e.forceAsk', 'Timpa versi yang ada di situs?\nBerkas ini berubah di luar editor. Kalau dilanjutkan, perubahan itu diganti dengan isi di editor.'), { ok: txf('lw.e.force', 'Timpa'), danger: true }))) return;
  if (F === lwF && F.ed === ed) return lwEdSave(true);
}
function lwEdAct(act) {
  if (!lwF || !lwF.ed) return false;
  switch (act) {
    case 'fedclose': lwEdClose(); return true;
    case 'fedsave': lwEdSave(); return true;
    case 'fedreload': lwEdReload(); return true;
    case 'fedforce': lwEdForce(); return true;
    default: return false;
  }
}

(function lwEdWire() {
  const page = $('webpage'); if (!page || !page.addEventListener) return;
  page.addEventListener('input', (e) => { if (e.target && e.target.id === 'lwedta') lwEdInput(e.target); });
  page.addEventListener('scroll', (e) => { // gulir tidak menggelembung: pendengar fase tangkap
    if (!e.target || e.target.id !== 'lwedta') return;
    const ed = lwF && lwF.ed; if (ed) ed.sc = e.target.scrollTop || 0;
    try { const g = $('lwedgut'); if (g) g.scrollTop = e.target.scrollTop; } catch (x) {}
  }, true);
})();
if (document.addEventListener) document.addEventListener('keydown', (e) => { // Ctrl+S / Cmd+S menyimpan (dan mencegah "simpan halaman" bawaan)
  if (!e || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 's') return;
  if (!lwOpen || lwDlgShown() || !lwF || !lwF.ed || !lwM || !lwM.site || lwM.site.tab !== 'files') return;
  if (e.preventDefault) e.preventDefault();
  lwEdSave();
});
