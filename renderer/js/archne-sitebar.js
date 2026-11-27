// js/archne-sitebar.js — bilah penampil situs Web Lokal (0.34.0 Fase F.2, Electron). Pola js/archne-weblink.js.
// Situs sendiri dirender proses utama di WebContentsView di bawah bilah ini (src/archne-sitebrowser.js); renderer hanya menggambar bilah dari kejadian 'sitestate'.
//  - Alamat = domain.archne, nama pemilik = dari proses utama (state.owner, dibaca dari Core): situs tidak bisa mengubah keduanya karena bilah ada di UI Archne, bukan di dalam situs.
//  - Tautan http(s) yang dipicu situs TIDAK dibuka diam-diam: kejadian 'siteext' menampilkan baris konfirmasi di bawah bilah (dialog biasa akan tertutup tampilan situs); hanya "Buka" yang memanggil siteExternal.
//  - Bagikan: tautan archne://domain.archne@idPemilik (dibuat proses utama) disalin dan ditaruh di kolom pesan obrolan yang sedang dipakai; tidak dikirim otomatis.
// Memakai $, txf, toast, mmCopy, nameOf (js/archne-state-util.js, archne-dialog.js, archne-msgmenu.js).
const sbApi = () => (window.api && typeof window.api.siteOpen === 'function' ? window.api : null);
let sbOn = false, sbLink = '', sbExt = '', sbBusy = false, sbWarn = null; // sbWarn = { peerId, siteId, domain } selama halaman peringatan pertama kali (G.2) tampil
// Situs milik sendiri (pratinjau, F.4): label "Pratinjau situsmu" menggantikan "oleh {nama}". Penentu sebenarnya = proses utama (state.own); id sendiri dipakai hanya untuk tampilan sebelum state pertama tiba.
const sbIsMe = (peerId) => !!(typeof S !== 'undefined' && S && S.me && S.me.id && peerId === S.me.id);
const sbOwnerText = (own, peerId, name) => (own ? txf('site.previewOwn', 'Pratinjau situsmu') : txf('lw.by', 'oleh {name}', { name: name == null ? nameOf(peerId) : name }));
const sbTop = () => { const b = $('sbtop'); return b && typeof b.getBoundingClientRect === 'function' ? Math.ceil(b.getBoundingClientRect().bottom) : 48; };
const sbSyncTop = () => { const a = sbApi(); if (a && sbOn) a.siteBounds(sbTop()).catch(() => {}); };

function sbHost(u) { try { return new URL(u).hostname || String(u); } catch (x) { return String(u).slice(0, 60); } }

function sbPaint(st) {
  const el = $('sitebr'); if (!el) return;
  if (sbWarn) return; // G.2: selama halaman peringatan tampil, kejadian state (mis. penutupan situs sebelumnya) tidak boleh menutup atau menimpanya
  if (!st || (!st.open && st.status !== 'syncing')) { if (sbOn) sbHide(); return; }
  if (!sbOn) return; // kejadian yang datang sesudah bilah ditutup dibuang
  if (st.domain) $('sbh').textContent = st.domain + '.archne';
  if (st.own || st.owner) { const o = $('sbo'); o.textContent = sbOwnerText(!!st.own, st.peerId, st.owner); o.title = o.textContent; }
  sbLink = st.link || ''; $('sbshare').disabled = !sbLink;
  const syncing = st.status === 'syncing';
  let sub = '';
  if (st.crashed) sub = txf('site.crashed', 'Situs berhenti bekerja');
  else if (syncing) sub = st.progress && st.progress.total ? txf('site.sync', 'Mengunduh situs… {done}/{total}', { done: st.progress.done, total: st.progress.total }) : txf('site.sync0', 'Menghubungi pemilik…');
  else if (st.offline) sub = txf('site.offline', 'Pemilik offline: menampilkan salinan tersimpan');
  else if (st.stale) sub = txf('site.stale', 'Gagal memperbarui: menampilkan salinan tersimpan');
  else sub = st.loading && !st.title ? txf('pl.loading', 'Memuat…') : st.title || '';
  if (st.own && st.priv === 'private' && !syncing && !st.crashed) sub = (sub ? sub + ' · ' : '') + txf('site.privNote', 'Situs privat: peer belum bisa membukanya');
  $('sbs').textContent = sub;
  // Android / peramban: state membawa `url` (iframe), dan riwayat ada di iframe lintas-origin yang tidak terbaca induk, jadi Mundur / Maju disembunyikan (bukan mati selamanya). Electron: state tanpa `url`, tombol tetap.
  const framed = typeof st.url === 'string'; $('sbback').hidden = $('sbfwd').hidden = framed;
  $('sbback').disabled = !st.canBack; $('sbfwd').disabled = !st.canFwd;
  $('sbre').disabled = syncing;
  $('sbstop').hidden = !(syncing || st.loading);
  sbPwSet(!!st.pw && !st.own); // G.2b: halaman meminta kata sandi
  $('sbload').hidden = !(syncing || st.loading || (typeof svLoading === 'function' && svLoading())); // Android: iframe belum selesai memuat
}
// Halaman peringatan pertama kali (G.2): tampil SEBELUM situs dibuka; proses utama belum menghubungi pemilik. Teks pemilik lewat textContent (nama dari peer = tak tepercaya).
function sbWarnHide() { sbWarn = null; const w = $('sbwarn'); if (w) w.hidden = true; }
function sbWarnShow(peerId, siteId, domain) {
  const w = $('sbwarn'); if (!w) return false;
  // Penutupan situs sebelumnya (siteOpen memanggil site.close() sebelum menjawab 'warn') mengirim state open:false; bila kejadian itu tiba SEBELUM balasan, sbPaint sudah menyembunyikan bilah (sbHide). Pulihkan bilah di sini supaya peringatan tidak tampil di dalam bilah yang tersembunyi (di HP: "gagal, ulangi" sampai urutan kejadian kebetulan menguntungkan).
  { const el = $('sitebr'); if (el) { sbOn = true; el.hidden = false; } }
  sbWarn = { peerId, siteId, domain: domain || '' };
  $('sbwo').textContent = txf('site.warn.owner', 'Pemilik: {name}', { name: nameOf(peerId) });
  $('sbs').textContent = ''; $('sbload').hidden = true; $('sbstop').hidden = true; $('sbshare').disabled = true;
  $('sbback').hidden = $('sbfwd').hidden = $('sbre').hidden = $('sbshare').hidden = true; // peringatan: hanya Tutup + judul (tombol lain tidak berguna dan berdesakan di layar sempit)
  w.hidden = false;
  try { $('sbwno').focus(); } catch (x) {} // fokus ke Batal: Enter tidak menyetujui tanpa sengaja
  return true;
}
async function sbWarnYes() {
  const a = sbApi(), w = sbWarn; if (!a || !w || sbBusy) return;
  sbBusy = true; let r; try { r = await a.siteWarnAck(w.peerId); } catch (x) { r = null; } finally { sbBusy = false; }
  if (sbWarn !== w) return; // ditutup selagi menunggu
  if (!r || r.ok !== true) { toast(txf('site.openFail', 'Gagal membuka situs')); return; }
  sbWarnHide();
  await sbOpen(w.peerId, w.siteId, w.domain);
}

// Strip peringatan kata sandi (G.2b): menyala dari state.pw (proses utama yang mendeteksi, bukan situs); tampilan situs digeser agar tidak menutupinya.
function sbPwSet(on) { const p = $('sbpw'); if (!p || p.hidden === !on) return; p.hidden = !on; sbSyncTop(); }
function sbHide() {
  sbOn = false; sbLink = ''; sbExtHide(); sbWarnHide(); { const p = $('sbpw'); if (p) p.hidden = true; }
  if (typeof svUnmount === 'function') svUnmount(); // iframe situs (js/archne-siteviewer.js, F.3.5b) ikut dilepas; tidak ada di Electron
  const el = $('sitebr'); if (el) el.hidden = true;
}
function sbShow(domain, peerId) {
  const el = $('sitebr'); if (!el) return false;
  sbOn = true; el.hidden = false; sbExtHide(); sbWarnHide(); sbPwSet(false);
  $('sbh').textContent = domain ? domain + '.archne' : ''; const o = $('sbo'); o.textContent = sbOwnerText(sbIsMe(peerId), peerId); o.title = o.textContent;
  $('sbs').textContent = sbIsMe(peerId) ? txf('pl.loading', 'Memuat…') : txf('site.sync0', 'Menghubungi pemilik…'); $('sbmsg').textContent = '';
  $('sbre').hidden = $('sbshare').hidden = false; $('sbback').hidden = $('sbfwd').hidden = typeof svReply === 'function'; // Android / peramban (iframe): Mundur / Maju memang tidak dipakai, jangan sempat tampil
  $('sbback').disabled = $('sbfwd').disabled = $('sbre').disabled = true; $('sbstop').hidden = false; $('sbload').hidden = false; $('sbshare').disabled = true; sbLink = '';
  return true;
}
async function sbClose() { const a = sbApi(); sbHide(); if (a) { try { await a.siteClose(); } catch (x) {} } }

// Buka situs milik peer (dipanggil dari kartu Jelajah, tautan chat) atau situs sendiri (pratinjau, tab Pratinjau). false = tidak ada penampil di platform ini (pemanggil memberi tahu).
async function sbOpen(peerId, siteId, domain) {
  const a = sbApi(); if (!a) return false;
  if (sbBusy) return true; sbBusy = true;
  try {
    if (!sbShow(domain, peerId)) return false;
    const my = {}; sbOpen.cur = my;
    let r; try { r = await a.siteOpen({ peerId, siteId, domain: domain || '' }, sbTop()); } /* getBoundingClientRect memaksa tata letak: tinggi bilah sudah benar tanpa menunggu */ catch (x) { r = { ok: false, err: txf('site.openFail', 'Gagal membuka situs') }; }
    if (sbOpen.cur !== my) return true;
    if (r && r.code === 'warn') { if (!sbWarnShow(peerId, siteId, domain)) { if (sbOn) sbHide(); toast(txf('site.openFail', 'Gagal membuka situs')); } return true; } // G.2
    if (!r || !r.ok) { if (!r || r.code !== 'cancel') { if (sbOn) sbHide(); toast((r && r.err) || txf('site.openFail', 'Gagal membuka situs')); } }
    else if (typeof svReply === 'function') svReply(r); // Android: alamat iframe dari balasan server (js/archne-siteviewer.js)
  } finally { sbBusy = false; }
  return true;
}

function sbShare() {
  if (!sbLink) { toast(txf('site.noLink', 'Tautan belum tersedia untuk situs ini')); return; }
  mmCopy(sbLink, txf('copy.link', 'Tautan'));
  try {
    const t = $('text');
    if (t && !t.disabled) { t.value = t.value && !/\s$/.test(t.value) ? t.value + ' ' + sbLink : t.value + sbLink; t.dispatchEvent(new Event('input', { bubbles: true })); toast(txf('site.copied', 'Tautan situs disalin dan ditaruh di kolom pesan'), true); }
  } catch (x) {}
}

// Konfirmasi tautan keluar (dipicu situs). Satu permintaan tampil sekaligus; yang baru menggantikan yang lama.
function sbExtShow(url) {
  if (!sbOn || typeof url !== 'string') return;
  sbExt = url; const c = $('sbconf'); if (!c) return;
  $('sbct').textContent = txf('site.extAsk', 'Situs ini ingin membuka {host} di peramban luar.', { host: sbHost(url) }); $('sbct').title = url;
  c.hidden = false; sbSyncTop();
  try { $('sbno').focus(); } catch (x) {} // fokus ke Batal: Enter tidak membuka tanpa sengaja
}
function sbExtHide() { sbExt = ''; const c = $('sbconf'); if (c && !c.hidden) { c.hidden = true; sbSyncTop(); } }
async function sbExtYes() {
  const a = sbApi(), u = sbExt; sbExtHide(); if (!a || !u) return;
  let r; try { r = await a.siteExternal(u); } catch (x) { r = null; }
  if (r && !r.ok) toast(r.err || txf('web.extFail', 'Gagal membuka peramban luar'));
}
function sbExtNo() { const a = sbApi(), had = sbExt; sbExtHide(); if (a && had) a.siteExtNo().catch(() => {}); }

if (typeof document !== 'undefined' && document.addEventListener) {
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('sbx', sbClose);
  on('sbback', () => { const a = sbApi(); if (a) a.siteNav('back'); });
  on('sbfwd', () => { const a = sbApi(); if (a) a.siteNav('forward'); });
  on('sbre', () => { const a = sbApi(); if (a) a.siteRefresh(); });
  on('sbstop', () => { const a = sbApi(); if (!a) return; if ($('sbs') && $('sbs').textContent === txf('site.sync0', 'Menghubungi pemilik…')) sbClose(); else a.siteNav('stop'); });
  on('sbshare', sbShare);
  on('sbwyes', sbWarnYes);
  on('sbwno', sbClose);
  on('sbyes', sbExtYes);
  on('sbno', sbExtNo);
  document.addEventListener('keydown', (e) => { if (!sbOn || e.key !== 'Escape') return; e.preventDefault(); if (sbExt) sbExtNo(); else sbClose(); });
  if (typeof window.addEventListener === 'function') window.addEventListener('resize', sbSyncTop);
  const sa = sbApi();
  if (sa && typeof sa.onSiteState === 'function') sa.onSiteState(sbPaint);
  if (sa && typeof sa.onSiteExt === 'function') sa.onSiteExt((x) => sbExtShow(x && x.url));
}
