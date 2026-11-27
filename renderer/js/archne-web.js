// Web Lokal (0.34.0 Fase D.1, D.2, D.5): tombol Web (#webbtn), halaman penuh #webpage, tab Jelajah | Webku, dan tombol Kembali / Esc.
// Halaman penuh, BUKAN popup (.mbg): menutupi seluruh layar di atas obrolan, di bawah dialog konfirmasi (#dlg) dan toast. Skrip global biasa, dimuat setelah archne-wan.js.
// Dipecah per tanggung jawab (batas ukuran): archne-web.js (ini: kerangka + tab + Kembali) -> archne-web-browse.js (Jelajah, situs peer) -> archne-web-mine.js (Webku: daftar, layar situs, Pengaturan) -> archne-web-files.js (tab Berkas) -> archne-web-up.js (unggah, seret-lepas), archne-web-edit.js (editor teks) dan archne-web-set.js (cek langsung Pengaturan, zona hapus, Pratinjau sementara).
// Hanya deklarasi yang dipakai lintas berkas; kode yang berjalan saat dimuat hanya pemasangan pendengar di bagian bawah berkas ini.
// Kembali (urutan, D.5 + E.1): dialog konfirmasi -> editor / panel inline berkas (nama / pindah) -> layar situs atau formulir buat (kembali ke daftar Webku) -> halaman Web (kembali ke obrolan). Dipanggil dari uiBack() (archne-call-ui.js) dan dari Esc di desktop.
// Penampil situs (ketuk kartu) = Fase F; sementara kartu hanya memberi tahu bahwa penampil belum ada.
let lwOpen = false, lwTab = 'browse'; // lwTab: 'browse' | 'mine' | 'dash' (Dasbor, U3: metrik perangkat sendiri) | 'privacy' (Catatan privasi, G.3: teks statis)
const LW_TABS = ['browse', 'mine', 'dash', 'privacy'];
const LW_TAB_FB = { browse: 'Jelajah', mine: 'Webku', dash: 'Dasbor', privacy: 'Privasi' };
const lwDlgShown = () => { try { const d = $('dlg'); return !!d && d.style.display !== 'none' && d.style.display !== ''; } catch (x) { return false; } };

function lwHeadHtml() {
  const tabs = LW_TABS.map((t) => `<button type="button" role="tab" class="lwtab${t === lwTab ? ' on' : ''}" aria-selected="${t === lwTab}" data-lw="tab" data-tab="${t}">${esc(txf('lw.tab.' + t, LW_TAB_FB[t]))}</button>`).join('');
  return `<div class="lwhd"><button type="button" class="pib" data-lw="back" title="${esc(txf('lw.back', 'Kembali'))}" aria-label="${esc(txf('lw.back', 'Kembali'))}">${icn('back')}</button><h2 id="lwtitle">${esc(txf('lw.title', 'Web'))}</h2></div><div class="lwtabs" role="tablist" aria-label="${esc(txf('lw.tabs', 'Bagian Web'))}">${tabs}</div><div id="lwbody" class="lwbody"></div>`;
}
// Catatan privasi (G.3): teks statis dari i18n, tanpa IPC. Tiap bagian = judul + paragraf; semua lewat esc().
const LW_PV = ['see', 'static', 'php', 'vis', 'mod', 'local', 'dash'];
const LW_PV_FB = {
  see: ['Yang dilihat pemilik situs', 'Saat kamu menyinkronkan atau membuka situs seseorang, perangkatmu terhubung ke perangkat pemilik lewat sambungan antar-perangkat Archne (tidak ada server pusat). Pemilik bisa tahu ID peer-mu, sama seperti saat kamu mengobrol dengannya.'],
  static: ['Situs statis', 'Setelah disinkronkan, situs statis dibuka dari salinan di perangkatmu. Halaman yang kamu buka dari salinan itu tidak dilaporkan ke pemilik.'],
  php: ['Situs PHP', 'Situs PHP berjalan di perangkat pemilik. Tiap permintaan dinamis (misalnya mengirim formulir) sampai ke pemilik, dan pemilik bisa membaca ID peer-mu bersamanya. Kalau kamu pemilik situs PHP, skripmu bisa membacanya lewat $_SERVER[\'ARCHNE_PEER\']: jaga seperti data pribadi.'],
  vis: ['Siapa yang bisa melihat situsmu', 'Pribadi: hanya kamu. Teman: hanya teman yang terhubung. Publik: semua peer yang terhubung ke perangkatmu dan tidak kamu blokir. Situs baru dimulai sebagai Pribadi.'],
  mod: ['Isi situs', 'Archne tidak punya server pusat dan tidak memoderasi isi situs. Pemilik bertanggung jawab atas isi situsnya. Perlindunganmu ada di perangkatmu sendiri: peringatan pertama kali per pemilik, peringatan saat situs meminta kata sandi, penampil terisolasi (tanpa akses ke akun dan data Archne-mu, jaringan luar mati, formulir tidak bisa mengirim keluar), dan pemblokiran peer.'],
  local: ['Data situs di perangkatmu', 'Cookie dan data lokal sebuah situs dibuang saat situs itu ditutup.'],
  dash: ['Dasbor', 'Angka di Dasbor (memori, Worker, penyimpanan) hanya dibaca dari perangkatmu sendiri dan tidak dikirim ke peer mana pun.'],
};
function lwPrivHtml() {
  return `<div class="lwpv"><h3 class="lwpvt">${esc(txf('lw.pv.title', 'Catatan privasi Web Lokal'))}</h3>` + LW_PV.map((k) => `<h4>${esc(txf('lw.pv.' + k + '.h', LW_PV_FB[k][0]))}</h4><p>${esc(txf('lw.pv.' + k + '.p', LW_PV_FB[k][1]))}</p>`).join('') + '</div>';
}
function lwRender() {
  const p = $('webpage'); if (!p) return;
  p.innerHTML = lwHeadHtml();
  if (lwTab !== 'dash') lwDashStop();
  if (lwTab === 'privacy') { lwMineStop(); lwBrowseStop(); const b = $('lwbody'); if (b) b.innerHTML = lwPrivHtml(); return; }
  if (lwTab === 'mine') lwMineStart(); else if (lwTab === 'dash') { lwMineStop(); lwBrowseStop(); lwDashStart(); } else { lwMineStop(); lwBrowseStart(); } // meninggalkan Webku: layar situs dan berkasnya ikut ditutup (draf editor sudah ditanyakan di lwTabTo)
}
function lwTabTo(t) {
  if (!LW_TABS.includes(t) || t === lwTab) return;
  if (lwEdDirty()) { lwEdAskLeave(() => lwTabTo(t)); return; } // editor berisi perubahan belum disimpan
  lwTab = t; lwRender();
}
function lwShow() {
  if (lwOpen) return;
  lwOpen = true; lwTab = 'browse';
  const p = $('webpage'); p.style.display = 'flex'; p.setAttribute('aria-hidden', 'false');
  lwRender();
  try { const b = p.querySelector('[data-lw="back"]'); if (b && b.focus) b.focus(); } catch (x) {}
}
function lwHide() {
  if (!lwOpen) return false;
  lwOpen = false;
  const p = $('webpage'); p.style.display = 'none'; p.setAttribute('aria-hidden', 'true'); p.innerHTML = '';
  lwBrowseStop(); lwMineStop(); lwDashStop();
  try { const b = $('webbtn'); if (b && b.focus) b.focus(); } catch (x) {}
  return true;
}
// Tombol Kembali / Esc. true = ditangani. Dialog konfirmasi yang sedang tampil didahulukan (backModal / pendengar dialog yang menutupnya), jadi di sini false.
function lwBackKey() {
  if (!lwOpen || lwDlgShown()) return false;
  if (lwTab === 'mine' && lwMineBack()) return true; // formulir terbuka: kembali ke daftar
  lwHide();
  return true;
}
// Satu pintu aksi dari atribut data-lw (pendengar klik di bawah dan tes memanggilnya langsung).
function lwAct(act, d) {
  d = d || {};
  if (act === 'back') { lwBackKey(); return true; }
  if (act === 'tab') { lwTabTo(d.tab); return true; }
  return lwBrowseAct(act, d) || lwMineAct(act, d) || lwFilesAct(act, d) || lwDbAct(act, d) || lwOffAct(act, d) || lwCronAct(act, d) || lwDashAct(act) || lwSetAct(act);
}
// Ketuk kartu Jelajah: penampil Electron (js/archne-sitebar.js, F.2). Platform tanpa penampil (Android = F.3, peramban biasa) tetap memberi tahu.
function lwOpenSite(peer, site, domain) { if (typeof sbApi === 'function' && sbApi()) { sbOpen(peer, site, domain); return; } notify(txf('lw.viewerSoon', 'Penampil situs hadir di versi berikutnya.')); }

(function lwWire() {
  const btn = $('webbtn'), page = $('webpage');
  if (btn && btn.addEventListener) btn.addEventListener('click', lwShow);
  if (!page || !page.addEventListener) return;
  page.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-lw]') : null;
    if (b) lwAct(b.dataset.lw, b.dataset);
  });
  page.addEventListener('input', (e) => { if (!e.target) return; if (e.target.id === 'lwq') lwBrowseInput(e.target.value); else if (e.target.id === 'lwdb-q') lwDbInput(e.target.value); else if (e.target.id === 'lwdb-sql') lwDbSqlText(e.target.value); else if (e.target.id === 'lwdb-w') lwDbSqlW(e.target.checked); else if (String(e.target.id).slice(0, 5) === 'lwcr-') lwCronInput(e.target); else lwSetInput(e.target.id); });
  page.addEventListener('change', (e) => { if (e.target && e.target.id === 'lwsort') lwBrowseSort(e.target.value); if (e.target && e.target.id === 'lwf-priv') lwMinePrivHint(); if (e.target && e.target.id === 'lwf-limp') lwLimPreset(e.target.value); });
  page.addEventListener('submit', (e) => { if (e.preventDefault) e.preventDefault(); if (e.target && e.target.id === 'lwform') lwMineSave(); else if (e.target && e.target.id === 'lwfmode') lwFilesSubmit(); });
})();
// Esc (desktop). Dialog konfirmasi menutup dirinya lebih dulu dan menandai kejadian (defaultPrevented): jangan ikut menutup halaman.
if (document.addEventListener) document.addEventListener('keydown', (e) => { if (e && e.key === 'Escape' && lwOpen && !e.defaultPrevented && lwBackKey() && e.preventDefault) e.preventDefault(); });
