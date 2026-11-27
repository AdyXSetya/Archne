// ---- Pengaturan (v0.22.1, Step 2f): tombol gear di baris profil membuka dialog berbagian. ----
// Dialog hanya kerangka: tiap BAGIAN didaftarkan ke SET_SECTIONS dengan { id, title, html(data), change(e), save(data) }.
//   html(data)   -> HTML isi bagian (data = hasil api.getSettings())
//   change(e)    -> opsional, dipanggil saat kontrol di dalam dialog berubah
//   save(data)   -> async; { ok:true, data? } (data baru bila ada), { ok:false, err } (tampilkan), atau { ok:false, cancel:true } (batal diam-diam)
//   order        -> opsional, urutan tampil (kecil dulu; bawaan 50)
//   cancel()     -> opsional, dipanggil saat dialog ditutup (setelah simpan maupun tidak): batalkan pratinjau yang belum disimpan
// Bagian baru (mis. tampilan, bahasa) cukup memanggil SET_SECTIONS.push({...}); backend kuota ada di src/core/archne-settings.js.
const SET_SECTIONS = [];
let setData = null, setBusy = false;
const MBYTE = 1048576, UNL = 'unlimited';
const setMb = (mb) => (mb >= 1024 && mb % 1024 === 0 ? mb / 1024 + ' GB' : mb + ' MB');

// Baris kuota. pools: yang dipakai untuk menampilkan pemakaian; trims: kolam yang ikut dibuang saat kuota diturunkan (kolam berkas DM tidak).
const SET_ROWS = [ // title/hint/warn/label berupa getter: dibaca saat dipakai agar mengikuti bahasa aktif (jangan disalin ke const saat load)
  { key: 'cust', presets: [10, 50, 100, 500, 1024, 2048],
    get title() { return txf('set.cust.title', 'Titipan pesan'); },
    get hint() { return txf('set.cust.hint', 'Pesan pribadi dan pesan grup milik orang lain yang kamu bawa sampai penerimanya online. Pesan DM dan pesan grup masing-masing boleh sebesar ini.'); },
    get pools() { return [[txf('set.pool.dm', 'Pesan pribadi'), (u) => u.cust.dm, true], [txf('set.pool.gmsg', 'Pesan grup'), (u) => u.cust.gmsg, true]]; } },
  { key: 'files', presets: [100, 250, 500, 1024, 5120, 10240],
    get title() { return txf('set.files.title', 'Titipan berkas'); },
    get hint() { return txf('set.files.hint', 'Berkas milik orang lain yang kamu simpan sementara, dan salinan unduhanmu yang ikut dibagikan. Tiap jenis di bawah boleh sebesar ini.'); },
    get warn() { return txf('set.files.warn', 'Tanpa batas, penyimpanan perangkat bisa penuh.'); },
    get pools() { return [[txf('set.pool.fdm', 'Berkas pribadi'), (u) => u.files.dm, false], [txf('set.pool.fpub', 'Berkas publik'), (u) => u.files.pub, true], [txf('set.pool.fgrp', 'Berkas grup'), (u) => u.files.grp, true], [txf('set.pool.seed', 'Salinan unduhan'), (u) => u.files.seed, true]]; } },
  { key: 'pubMsgs', presets: [5, 10, 20, 50, 100],
    get title() { return txf('set.pub.title', 'Riwayat obrolan publik'); },
    get hint() { return txf('set.pub.hint', 'Pesan publik milik orang lain yang kamu simpan dan bagikan ke teman baru. Tersimpan utuh di memori, jadi nilai besar membuat aplikasi lebih berat. Pesanmu sendiri tidak dihitung.'); },
    get warn() { return txf('set.pub.warn', 'Tanpa batas, memori dan waktu simpan terus bertambah.'); },
    get pools() { return [[txf('set.pool.pub', 'Pesan publik'), (u) => u.pubMsgs, true]]; } },
];

// Nilai terpilih sekarang -> kode kontrol: 'default' | 'unlimited' | '<MB preset>' | 'custom'
function setChoice(row, it) {
  if (it.value === UNL) return UNL;
  if (it.value === it.def) return 'default';
  const mb = it.value / MBYTE;
  return row.presets.includes(mb) ? String(mb) : 'custom';
}
function setRowHtml(row, d) {
  const it = d.items[row.key], ch = setChoice(row, it), minMb = Math.ceil(it.min / MBYTE), defMb = it.def / MBYTE;
  const opts = [['default', txf('set.default', 'Bawaan ({size})', { size: setMb(defMb) })]].concat(row.presets.filter((m) => m >= minMb && m !== defMb).map((m) => [String(m), setMb(m)]), [[UNL, txf('set.unlimited', 'Tanpa batas')], ['custom', txf('set.other', 'Lainnya…')]]);
  const sel = `<select id="setsel-${row.key}" aria-label="${esc(row.title)}">${opts.map(([v, l]) => `<option value="${v}"${v === ch ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const mbv = ch === 'custom' ? Math.round((it.value / MBYTE) * 100) / 100 : '';
  const num = `<input id="setmb-${row.key}" class="stmb" type="number" min="${minMb}" step="1" inputmode="numeric" value="${mbv}" aria-label="${esc(txf('set.inMb', '{title} dalam MB', { title: row.title }))}" style="display:${ch === 'custom' ? 'inline-block' : 'none'}"><span id="setmbl-${row.key}" class="stmbl" style="display:${ch === 'custom' ? 'inline' : 'none'}">${esc(txf('set.mbMin', 'MB (min {size})', { size: setMb(minMb) }))}</span>`;
  const use = row.pools.map(([label, get]) => {
    const u = get(d.usage), lim = u.quota === UNL ? null : u.quota, pct = lim ? Math.min(100, Math.round((u.used / lim) * 100)) : 0;
    return `<div class="stu"><span>${esc(label)}</span><b>${esc(lim ? txf('set.usage', '{used} dari {total}', { used: FileCard.fmtSize(u.used), total: FileCard.fmtSize(lim) }) : txf('set.usageUnl', '{used} (tanpa batas)', { used: FileCard.fmtSize(u.used) }))}</b></div>` + (lim ? `<div class="stbar"><i class="${pct >= 90 ? 'hi' : ''}" style="width:${pct}%"></i></div>` : '');
  }).join('');
  const warn = row.warn ? `<div class="stwarn" id="setwarn-${row.key}" role="note" style="display:${ch === UNL ? 'block' : 'none'}">${esc(row.warn)}</div>` : '';
  return `<div class="strow"><div class="stt">${esc(row.title)}</div><div class="sth">${esc(row.hint)}</div><div class="stc">${sel}${num}</div>${warn}${use}</div>`;
}
// Pilihan pengguna dari kontrol -> { v: 'default' | 'unlimited' | bytes } atau { err }
function setRead(row, d) {
  const it = d.items[row.key], c = $('setsel-' + row.key).value;
  if (c === 'default' || c === UNL) return { v: c };
  if (c !== 'custom') return { v: Number(c) * MBYTE };
  const raw = String($('setmb-' + row.key).value).trim().replace(',', '.'), mb = Number(raw);
  if (!raw || !Number.isFinite(mb) || mb <= 0) return { err: txf('set.errSize', 'Isi ukuran dalam MB untuk "{title}"', { title: row.title }) };
  if (mb * MBYTE < it.min) return { err: txf('set.errMinFor', 'Minimal {size} untuk "{title}"', { size: setMb(Math.ceil(it.min / MBYTE)), title: row.title }) };
  if (mb > 1e7) return { err: txf('set.errBig', 'Ukuran untuk "{title}" terlalu besar', { title: row.title }) };
  return { v: Math.round(mb * MBYTE) };
}
function setErr(r) {
  const row = SET_ROWS.find((x) => x.key === r.key);
  if (r.code === 'min') { const size = setMb(Math.ceil(r.min / MBYTE)); return row ? txf('set.errMinFor', 'Minimal {size} untuk "{title}"', { size, title: row.title }) : txf('set.errMin', 'Minimal {size}', { size }); }
  if (r.code === 'max') { const size = setMb(Math.floor(r.max / MBYTE)); return row ? txf('set.errMaxFor', 'Maksimal {size} untuk "{title}"', { size, title: row.title }) : txf('set.errMax', 'Maksimal {size}', { size }); }
  if (r.code === 'io') return txf('set.errIo', 'Gagal menyimpan pengaturan. Penyimpanan perangkat mungkin penuh atau tidak bisa ditulis.');
  return r.err || txf('set.errBad', 'Pengaturan tidak sah');
}
SET_SECTIONS.push({
  id: 'storage', icon: 'db', order: 30,
  get title() { return txf('set.storage.title', 'Penyimpanan'); },
  html: (d) => '<div class="sint">' + esc(txf('set.storage.intro', 'Batas ruang yang dipakai Archne untuk membantu mengantar pesan dan berkas orang lain. Kuota yang diturunkan langsung membuang kelebihannya, yang terlama dulu.')) + '</div><div class="setgrp">' + SET_ROWS.map((r) => setRowHtml(r, d)).join('') + '</div>',
  change: (e) => {
    const id = e && e.target && e.target.id; if (!id || id.indexOf('setsel-') !== 0) return;
    const key = id.slice(7), v = $(id).value, cu = v === 'custom';
    $('setmb-' + key).style.display = cu ? 'inline-block' : 'none'; $('setmbl-' + key).style.display = cu ? 'inline' : 'none';
    const w = $('setwarn-' + key); if (w) w.style.display = v === UNL ? 'block' : 'none';
    if (cu) $('setmb-' + key).focus();
  },
  async save(d) {
    const patch = {}, shrink = [];
    for (const row of SET_ROWS) {
      const it = d.items[row.key], r = setRead(row, d);
      if (r.err) return { ok: false, err: r.err };
      const eff = r.v === 'default' ? it.def : r.v;
      if (eff === it.value) continue; // tidak berubah: jangan menulis apa pun
      patch[row.key] = r.v === 'default' ? null : r.v;
      if (eff !== UNL && row.pools.some(([, get, trims]) => trims && get(d.usage).used > eff)) shrink.push(row.title);
    }
    if (!Object.keys(patch).length) return { ok: true };
    if (shrink.length && !await ask(txf('set.shrinkConfirm', 'Kuota baru untuk {names} lebih kecil dari isi saat ini. Kelebihannya akan langsung dibuang, dimulai dari yang paling lama. Lanjutkan?', { names: shrink.join(', ') }), { ok: txf('dlg.continue', 'Lanjutkan'), danger: true })) return { ok: false, cancel: true };
    const r = await window.api.setSettings(patch);
    return r && r.ok ? { ok: true, data: r, changed: true } : { ok: false, err: setErr(r || {}) };
  },
});

// Tab samping (desktop) / tab atas yang bisa digeser (HP): bagian dikelompokkan per topik. Semua bagian tetap digambar (yang tidak aktif hanya disembunyikan) supaya ketikan dan pilihan di tab lain ikut tersimpan saat Simpan.
const SET_TABS = [
  { id: 'general', icon: 'gear', secs: ['lang', 'theme', 'app'], get title() { return txf('set.tab.general', 'Umum'); } },
  { id: 'network', icon: 'relay', secs: ['relay', 'direct'], get title() { return txf('set.tab.network', 'Jaringan'); } },
  { id: 'storage', icon: 'db', secs: ['storage', 'media'], get title() { return txf('set.tab.storage', 'Penyimpanan'); } },
  { id: 'pages', icon: 'home', secs: ['pages'], get title() { return txf('set.tab.pages', 'Halaman'); } },
];
const setTabOf = (sid) => (SET_TABS.find((t) => t.secs.includes(sid)) || SET_TABS[0]).id; // bagian baru tanpa pemetaan masuk Umum
let setTab = 'general';
function setShowTab(id) {
  setTab = id;
  const body = $('setbody'); if (!body || typeof body.querySelectorAll !== 'function') return;
  for (const t of body.querySelectorAll('[data-settab]')) { const on = t.dataset.settab === id; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; t.classList.toggle('on', on); }
  for (const sec of body.querySelectorAll('.setsec')) sec.hidden = sec.dataset.tab !== id;
  const pane = $('setpane'); if (pane) pane.scrollTop = 0;
}
function renderSettings() {
  // bagian yang tidak punya isi (mis. Kirim Langsung di Android/headless) tidak digambar, judulnya pun tidak; tab tanpa bagian ikut hilang
  const items = SET_SECTIONS.slice().sort((a, b) => (a.order || 50) - (b.order || 50)).map((s) => ({ s, h: s.html(setData), tab: setTabOf(s.id) })).filter((x) => x.h);
  const tabs = SET_TABS.filter((t) => items.some((x) => x.tab === t.id));
  if (!tabs.some((t) => t.id === setTab)) setTab = tabs.length ? tabs[0].id : 'general';
  const nav = `<div class="settabs" role="tablist" aria-orientation="vertical" aria-label="${esc(txf('settings.title', 'Pengaturan'))}">${tabs.map((t) => `<button type="button" role="tab" class="settab${t.id === setTab ? ' on' : ''}" data-settab="${t.id}" aria-selected="${t.id === setTab}" tabindex="${t.id === setTab ? 0 : -1}">${icn(t.icon)}<span>${esc(t.title)}</span></button>`).join('')}</div>`;
  const secs = items.map((x) => `<section class="setsec" data-sec="${x.s.id}" data-tab="${x.tab}"${items.filter((y) => y.tab === x.tab).length === 1 ? ' data-single="1"' : ''}${x.tab === setTab ? '' : ' hidden'}><h4>${x.s.icon && IC[x.s.icon] ? icn(x.s.icon) : ''}${esc(x.s.title)}</h4>${x.h}</section>`).join('');
  $('setbody').innerHTML = nav + `<div class="setpane" id="setpane">${secs}</div>`;
}
async function openSettings() {
  const r = await window.api.getSettings();
  if (!r || r.ok === false) return toast((r && r.err) || txf('set.openFail', 'Pengaturan belum bisa dibuka'));
  setData = r; setTab = 'general'; renderSettings();
  $('setmodal').style.display = 'flex';
}
const closeSettings = () => { $('setmodal').style.display = 'none'; for (const s of SET_SECTIONS) if (s.cancel) s.cancel(); };
$('setbtn').onclick = openSettings;
$('setclose').onclick = closeSettings;
$('setbody').onchange = (e) => { for (const s of SET_SECTIONS) if (s.change) s.change(e); };
$('setsave').onclick = async () => {
  if (setBusy || !setData) return;
  setBusy = true; $('setsave').disabled = true;
  try {
    let changed = false;
    for (const s of SET_SECTIONS) {
      const r = await s.save(setData);
      if (r && r.cancel) return;
      if (!r || r.ok === false) return toast((r && r.err) || txf('set.saveFail', 'Gagal menyimpan'));
      if (r.data) setData = r.data;
      if (r.changed) changed = true;
    }
    closeSettings();
    if (changed) toast(txf('set.saved', 'Pengaturan disimpan'), true);
    await refresh();
  } finally { setBusy = false; $('setsave').disabled = false; }
};
// Klik tab + panah (atas/bawah/kiri/kanan, Home/End) memindah tab. addEventListener (bukan onclick) karena archne-direct.js memakai setbody.onclick.
if ($('setbody').addEventListener) {
  $('setbody').addEventListener('click', (e) => { const b = e.target && e.target.closest && e.target.closest('[data-settab]'); if (b) setShowTab(b.dataset.settab); });
  $('setbody').addEventListener('keydown', (e) => {
    const b = e.target && e.target.closest && e.target.closest('[data-settab]'); if (!b || !$('setbody').querySelectorAll) return;
    const all = [...$('setbody').querySelectorAll('[data-settab]')], i = all.indexOf(b), k = e.key;
    const j = k === 'ArrowDown' || k === 'ArrowRight' ? (i + 1) % all.length : k === 'ArrowUp' || k === 'ArrowLeft' ? (i - 1 + all.length) % all.length : k === 'Home' ? 0 : k === 'End' ? all.length - 1 : -1;
    if (j < 0) return; e.preventDefault(); setShowTab(all[j].dataset.settab); all[j].focus();
  });
}
