// Web Lokal (0.34.0 Fase D.4): tab Webku. Daftar situs milik perangkat ini, formulir buat / ubah (metadata), dan hapus dengan konfirmasi.
// U1: kartu = Kelola (layar situs) | Pratinjau (langsung ke penampil) | Hapus. Fase E.1: "Kelola" (aksi 'edit') membuka layar situs (tab Berkas | Pengaturan | Pratinjau). Berkas = archne-web-files.js; Pengaturan = formulir metadata di bawah (domain, judul, deskripsi, kata kunci, berkas awal, visibilitas) + hapus situs; cek langsung domain / berkas awal, zona hapus, dan tab Pratinjau = archne-web-set.js (Sesi E-4).
// Visibilitas bawaan situs baru: Pribadi (keputusan Lampiran B no. 2).
// Semua isian dikirim apa adanya ke IPC (api.webCreate / webUpdate); Core yang mengkanonkan dan memvalidasi, galatnya ditampilkan di dalam formulir. Tidak ada jalur berkas di renderer.
let lwM = null; // { items: null | [...], err, form: null | { id, busy, err, entry0?, v: { domain, title, desc, tags, priv, entry? } }, site: null | { id, tab: 'files' | 'settings' | 'preview', pv?: keadaan pratinjau (archne-web-set.js) } }; null = tab tidak aktif
const LW_SITE_TABS = ['files', 'db', 'offline', 'settings', 'preview'];
const LW_PRIV = ['private', 'friends', 'public'];
const LW_PRIV_FB = { private: 'Pribadi', friends: 'Teman', public: 'Publik' };
const lwPrivName = (p) => txf('lw.priv.' + p, LW_PRIV_FB[p] || p);

function lwMineStop() { lwM = null; lwFilesStop(); lwDbStop(); lwOffStop(); }
function lwMineBack() { // true bila ada yang ditutup: editor / panel inline berkas -> layar situs -> formulir buat (kembali ke daftar)
  if (!lwM) return false;
  if (lwM.site) {
    if (lwFilesBack() || lwDbBack()) return true;
    const close = () => { if (!lwM || !lwM.site) return; lwM.site = null; lwM.form = null; lwFilesStop(); lwDbStop(); lwOffStop(); lwM.items = null; lwMinePaint(); lwMineLoad(); }; // jumlah berkas di kartu bisa berubah
    if (lwEdDirty()) lwEdAskLeave(close); else close(); // perubahan editor belum disimpan (tab lain sedang aktif): tanya dulu
    return true;
  }
  if (!lwM.form) return false;
  lwM.form = null; lwMinePaint();
  return true;
}
const lwSiteItem = (id) => (lwM && (lwM.items || []).find((x) => x.id === id)) || null;
function lwSiteForm(s) { return { id: s.id, busy: false, err: '', entry0: s.entry, v: { domain: s.domain, title: s.title, desc: s.desc, tags: s.tags.join(', '), priv: s.priv, entry: s.entry, php: !!s.php, lim: s.lim || null } }; }
function lwSiteEnsure() { // dipanggil sesudah daftar dimuat: situs yang sedang dibuka harus masih ada; tab Pengaturan butuh formulirnya
  const M = lwM, st = M && M.site; if (!st) return;
  const s = lwSiteItem(st.id);
  if (!s && M.items) { M.site = null; M.form = null; lwFilesStop(); lwDbStop(); lwOffStop(); return; }
  if (s && st.tab === 'settings' && !M.form) M.form = lwSiteForm(s);
}
async function lwMineLoad() {
  const M = lwM; if (!M) return;
  const r = await window.api.webMine();
  if (M !== lwM) return;
  if (r && r.ok) { M.items = Array.isArray(r.items) ? r.items : []; M.err = ''; } else { M.items = M.items || []; M.err = (r && r.err) || txf('common.error', 'Terjadi kesalahan'); }
  lwSiteEnsure();
  lwMinePaint();
}
function lwMineStart() {
  lwM = { items: null, err: '', form: null, site: null };
  lwMinePaint();
  lwMineLoad();
}
function lwMineAct(act, d) {
  if (!lwM) return false;
  if (act === 'new') { if (lwM.site) return true; lwM.form = { id: null, busy: false, err: '', v: { domain: '', title: '', desc: '', tags: '', priv: 'private' } }; lwMinePaint(); lwFocus('lwf-domain'); return true; }
  if (act === 'edit') { // layar situs, tab Berkas dulu
    const s = lwSiteItem(d.id); if (!s) return true;
    lwM.site = { id: s.id, tab: 'files' }; lwM.form = null; lwMinePaint(); lwFilesStart(s.id); return true;
  }
  if (act === 'prev') { lwMinePreview(d.id); return true; }
  if (act === 'sitetab') { lwSiteTab(d.st); return true; }
  if (act === 'reset') { const s = lwM.site && lwSiteItem(lwM.site.id); if (s) { lwM.form = lwSiteForm(s); lwMinePaint(); } return true; }
  if (act === 'sitedel') { if (lwM.site) lwMineDelete(lwM.site.id); return true; }
  if (act === 'cancel') { if (lwM.site) lwMineAct('reset', d); else lwMineBack(); return true; }
  if (act === 'retry') { lwM.items = null; lwMinePaint(); lwMineLoad(); return true; }
  return false;
}
function lwFocus(id) { try { const el = $(id); if (el && el.focus) el.focus(); } catch (x) {} }
function lwMineCard(s) {
  const b = (act, cls, icon, key, fb) => { const t = txf(key, fb); return `<button type="button" class="${cls}" data-lw="${act}" data-id="${esc(s.id)}" title="${esc(t)}" aria-label="${esc(t + ': ' + s.title)}">${icn(icon)}<span>${esc(t)}</span></button>`; }; // di layar sempit teksnya disembunyikan (CSS): nama tetap ada di aria-label
  return `<div class="lwcard lwmine"><span class="lwct">${esc(s.title)}</span><span class="lwcd">${esc(s.domain)}.archne</span><span class="lwco"><span class="lwbadge ${esc(s.priv)}">${esc(lwPrivName(s.priv))}</span>${s.php ? '<span class="lwbadge php">PHP</span>' : ''}${esc(txf('lw.mine.files', 'Berkas: {n}', { n: s.n }))}</span><span class="lwcx">${esc(s.desc || txf('lw.noDesc', 'Tanpa deskripsi'))}</span><span class="lwacts">${b('edit', '', 'gear', 'lw.mine.manage', 'Kelola')}${b('prev', 'sec', 'eye', 'lw.mine.preview', 'Pratinjau')}</span></div>`;
}
function lwMinePreview(id) { // Pratinjau langsung dari kartu: penampil yang sama dengan tab Pratinjau; tanpa penampil (peramban biasa) buka layar situs di tab Pratinjau
  const s = lwSiteItem(id); if (!s) return;
  if (lwPrevViewer()) { sbOpen(S.me.id, s.id, s.domain); return; }
  lwM.site = { id: s.id, tab: 'preview' }; lwM.form = null; lwMinePaint(); lwFilesStart(s.id); lwPrevLoad();
}
function lwMineListHtml(M) {
  let h = `<div class="lwbar"><p class="lwnote">${esc(txf('lw.mine.hint', 'Situs tersimpan di perangkat ini. Peer hanya bisa melihatnya saat perangkatmu online dan visibilitasnya bukan Pribadi.'))}</p><button type="button" data-lw="new">${esc(txf('lw.mine.create', 'Buat web'))}</button></div>`;
  if (M.err) h += `<p class="lwnote err" role="alert">${esc(M.err)} <button type="button" class="sec" data-lw="retry">${esc(txf('lw.retry', 'Coba lagi'))}</button></p>`;
  if (M.items === null) h += `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>`;
  else if (!M.items.length) h += `<p class="lwempty">${esc(txf('lw.mine.empty', 'Kamu belum punya situs. Buat situs pertamamu.'))}</p>`;
  else h += `<div class="lwgrid">${M.items.map(lwMineCard).join('')}</div>`;
  return h;
}
function lwMineFormHtml(F, inSite) {
  const v = F.v, f = (id, label, input, hint, st) => `<label class="lwfl" for="${id}"><span>${esc(label)}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ''}${st ? `<small id="${st}" class="lwst" aria-live="polite"></small>` : ''}</label>`;
  const opts = LW_PRIV.map((p) => `<option value="${p}"${p === v.priv ? ' selected' : ''}>${esc(lwPrivName(p))}</option>`).join('');
  return `<form id="lwform" class="lwform" novalidate><h3>${esc(txf(F.id ? 'lw.form.edit' : 'lw.form.new', F.id ? 'Ubah web' : 'Buat web'))}</h3>`
    + f('lwf-domain', txf('lw.form.domain', 'Domain'), `<span class="lwdom"><input id="lwf-domain" type="text" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(v.domain)}"><b>.archne</b></span>`, txf('lw.form.domainHint', 'Huruf kecil, angka, dan tanda hubung (3 sampai 32). Unik hanya di perangkat ini.'), 'lwf-domst')
    + f('lwf-title', txf('lw.form.title', 'Judul'), `<input id="lwf-title" type="text" maxlength="80" value="${esc(v.title)}">`)
    + f('lwf-desc', txf('lw.form.desc', 'Deskripsi'), `<textarea id="lwf-desc" maxlength="300" rows="3">${esc(v.desc)}</textarea>`)
    + f('lwf-tags', txf('lw.form.tags', 'Kata kunci'), `<input id="lwf-tags" type="text" maxlength="300" value="${esc(v.tags)}">`, txf('lw.form.tagsHint', 'Pisahkan dengan koma (maksimal 10).'))
    + (inSite ? f('lwf-entry', txf('lw.form.entry', 'Berkas awal'), `<input id="lwf-entry" type="text" maxlength="300" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(v.entry || '')}">`, txf('lw.form.entryHint', 'Berkas yang dibuka pertama kali, misalnya index.html. Harus sudah ada di situs.'), 'lwf-entst') : '')
    + (inSite ? f('lwf-php', txf('lw.form.php', 'Mesin PHP'), `<select id="lwf-php"><option value="off"${v.php ? '' : ' selected'}>${esc(txf('lw.php.off', 'Mati (situs statis)'))}</option><option value="on"${v.php ? ' selected' : ''}>${esc(txf('lw.php.on', 'Menyala'))}</option></select>`, txf('lw.php.hint', 'Menjalankan berkas .php di perangkat ini. Situs PHP hanya bisa dipratinjau di sini; peer belum bisa membukanya dan situs ini tidak muncul di daftar mereka.')) : '')
    + (inSite ? lwLimHtml(v.lim) : '')
    + f('lwf-priv', txf('lw.form.priv', 'Visibilitas'), `<select id="lwf-priv">${opts}</select>`, txf('lw.privHint.' + v.priv, ''))
    + `<p id="lwferr" class="lwnote err" role="alert"${F.err ? '' : ' hidden'}>${esc(F.err)}</p>`
    + `<div class="lwacts"><button type="submit"${F.busy ? ' disabled' : ''}>${esc(txf(F.id ? 'lw.form.save' : 'lw.form.make', F.id ? 'Simpan' : 'Buat'))}</button><button type="button" class="sec" data-lw="${inSite ? 'reset' : 'cancel'}">${esc(inSite ? txf('lw.form.reset', 'Kembalikan') : txf('common.cancel', 'Batal'))}</button></div></form>`;
}
function lwSiteHtml(M) {
  const st = M.site, s = lwSiteItem(st.id), tabs = LW_SITE_TABS.map((t) => `<button type="button" role="tab" class="lwtab lwstab${t === st.tab ? ' on' : ''}" aria-selected="${t === st.tab}" data-lw="sitetab" data-st="${t}">${esc(txf('lw.site.tab.' + t, t))}</button>`).join('');
  let body = '';
  if (st.tab === 'settings') body = M.form ? lwMineFormHtml(M.form, true) + lwSetDangerHtml() : `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>`;
  else if (st.tab === 'preview') body = lwPrevHtml(st);
  else if (st.tab === 'db') body = lwDbHtml();
  else if (st.tab === 'offline') body = lwOffHtml();
  return `<div class="lwsite"><div class="lwsh"><span class="lwct">${esc(s ? s.title : '')}</span><span class="lwcd">${esc(s ? s.domain + '.archne' : '')}</span></div><div class="lwtabs lwstabs" role="tablist" aria-label="${esc(txf('lw.site.tabs', 'Bagian situs'))}">${tabs}</div><div id="lwsb" class="lwsb">${body}</div></div>`;
}
function lwSiteTab(t) {
  const M = lwM, st = M && M.site; if (!st || !LW_SITE_TABS.includes(t) || t === st.tab) return;
  lwSetLeave(); if (st.tab === 'db') lwDbStop(); if (st.tab === 'offline') lwOffStop(); st.tab = t; M.form = null; st.pv = null; lwSiteEnsure(); lwMinePaint(); if (t === 'preview') lwPrevLoad(); if (t === 'db') lwDbStart(st.id); if (t === 'offline') lwOffStart(st.id); // Berkas memuat ulang isi folder (bisa berubah di tab lain); keadaan folder dipertahankan
  if (t === 'files' && lwF) lwFilesLoad(lwF.dir);
}
function lwMinePaint() {
  const el = $('lwbody'), M = lwM; if (!el || !M) return;
  if (M.site) { el.innerHTML = lwSiteHtml(M); if (M.site.tab === 'files') lwFilesPaint(); else if (M.site.tab === 'offline') lwOffRepaint(); return; }
  el.innerHTML = M.form ? lwMineFormHtml(M.form) : lwMineListHtml(M);
}
function lwMinePrivHint() { // petunjuk di bawah pilihan visibilitas mengikuti pilihan (tanpa menggambar ulang formulir)
  const sel = $('lwf-priv'); if (!sel || !lwM || !lwM.form) return;
  lwM.form.v.priv = LW_PRIV.includes(sel.value) ? sel.value : 'private';
  try { const sm = sel.parentNode && sel.parentNode.querySelector ? sel.parentNode.querySelector('small') : null; if (sm) sm.textContent = txf('lw.privHint.' + lwM.form.v.priv, ''); } catch (x) {}
}
function lwMineRead(F) { // isian terkini -> objek untuk IPC
  const g = (id) => { const el = $(id); return el ? String(el.value == null ? '' : el.value) : ''; };
  F.v = { domain: g('lwf-domain').trim(), title: g('lwf-title'), desc: g('lwf-desc'), tags: g('lwf-tags'), priv: LW_PRIV.includes(g('lwf-priv')) ? g('lwf-priv') : 'private' };
  const o = { domain: F.v.domain.trim(), title: F.v.title, desc: F.v.desc, tags: F.v.tags, priv: F.v.priv };
  const pv = g('lwf-php'); // 'on' | 'off' hanya bila kolomnya ada (tab Pengaturan); formulir ubah dari daftar tidak punya kolom ini dan tidak boleh mematikan PHP diam-diam
  if (F.id && (pv === 'on' || pv === 'off')) { F.v.php = pv === 'on'; o.php = F.v.php; }
  const lm = lwLimRead(); if (F.id && lm !== undefined) { F.v.lim = lm; o.lim = lm; } // angka tak sah (kosong / bukan bilangan bulat) dikirim apa adanya: Core yang menolak dengan pesan
  if (F.id) { F.v.entry = g('lwf-entry').trim(); if (F.v.entry !== F.entry0) o.entry = F.v.entry; } // berkas awal hanya dikirim bila diubah: berkas awal lama yang sudah terhapus tidak boleh menggagalkan simpan judul / visibilitas
  return o;
}
async function lwMineSave() {
  const M = lwM, F = M && M.form; if (!F || F.busy) return;
  const o = lwMineRead(F);
  F.busy = true; F.err = '';
  let r;
  try { r = F.id ? await window.api.webUpdate(F.id, o) : await window.api.webCreate(o); } catch (x) { r = { ok: false, err: txf('common.error', 'Terjadi kesalahan') }; }
  if (M !== lwM || M.form !== F) return; // formulir ditutup selagi menunggu
  F.busy = false;
  if (!r || !r.ok) { F.err = (r && r.err) || txf('lw.form.err', 'Isian belum benar'); lwMinePaint(); lwFocus('lwf-domain'); return; }
  M.form = null; M.items = null; if (!M.site) lwMinePaint(); // di layar situs: tetap di sana (judul dan formulir dimuat ulang dari daftar)
  toast(txf(F.id ? 'lw.form.saved' : 'lw.form.made', F.id ? 'Situs disimpan' : 'Situs dibuat'), true);
  lwMineLoad();
}
async function lwMineDelete(id) {
  const M = lwM, s = M && (M.items || []).find((x) => x.id === id); if (!s) return;
  if (!await ask(txf('lw.del.ask', 'Hapus situs ini?\n“{title}” dan semua berkasnya akan hilang permanen dari perangkat ini. Ini tidak bisa dibatalkan.', { title: s.title }), { ok: txf('lw.del.ok', 'Hapus'), danger: true })) return;
  if (M !== lwM) return;
  const r = await window.api.webRemove(id);
  if (M !== lwM) return;
  if (!r || !r.ok) { notify((r && r.err) || txf('common.error', 'Terjadi kesalahan')); return; }
  if (M.site && M.site.id === id) { M.site = null; M.form = null; lwFilesStop(); lwDbStop(); lwOffStop(); } // dihapus dari layar situs (tab Pengaturan): kembali ke daftar
  M.items = null; lwMinePaint();
  toast(txf('lw.del.done', 'Situs dihapus'), true);
  lwMineLoad();
}
