// js/archne-siteviewer.js — kerangka penampil situs di WebView / peramban (0.34.0 F.3.5b, c). Hanya iframe dan garis muat; alamat / pemilik / status digambar archne-sitebar.js dari state server. Penyalaan fitur = F.3.5d.
// Lapisan layar penuh = #sitebr (js/archne-sitebar.js: bilah di induk). Iframe situs dipasang di #sbframe, di bawah bilah, dan HANYA mengikuti server:
//  - alamat iframe berasal dari state `sitestate` (status 'ready') atau balasan siteOpen, tidak pernah dari argumen renderer / tautan / situs;
//  - atribut iframe dan pemeriksaan alamat = renderer/archne-siteframe.js (V2: sandbox, port sama dengan UI, host <16 heks>.lw.localhost). Alamat tidak sah = tidak ada iframe;
//  - iframe hanya ada selama lapisan tampil dan server melaporkan situs terbuka; sinkron / error / tutup / lapisan disembunyikan = iframe dilepas (situs berhenti, bukan disembunyikan).
// Di Electron state tidak memuat alamat http (situs dirender WebContentsView), jadi tidak pernah ada iframe di sana. Memakai $ (js/archne-state-util.js), SiteFrame (archne-siteframe.js).
const svHolder = () => $('sbframe');
const svLayerOn = () => { const l = $('sitebr'); return !!l && !l.hidden; };
let svFrame = null, svSrc = '', svPend = false; // svPend = iframe terpasang tetapi belum selesai memuat
const svLoading = () => svPend; // dibaca bilah supaya garis muat tidak padam oleh state baru

function svUnmount() {
  const f = svFrame; svFrame = null; svSrc = ''; svPend = false;
  if (f && f.parentNode) f.parentNode.removeChild(f);
  const h = svHolder(); if (h) h.hidden = true;
}

// true = iframe terpasang untuk alamat itu (alamat sama dengan yang sudah terpasang tidak memuat ulang).
function svMount(url) {
  const h = svHolder(), port = typeof location !== 'undefined' && location ? location.port : '';
  if (!h || typeof SiteFrame === 'undefined' || !port) { svUnmount(); return false; } // tanpa port UI, "port sama" tidak bisa dijamin: tidak ada iframe
  const src = SiteFrame.check(url, port);
  if (!src) { svUnmount(); return false; }
  if (svFrame && svSrc === src && svFrame.parentNode === h) return true;
  svUnmount();
  const f = SiteFrame.build(document, src, { port });
  if (!f) return false;
  h.appendChild(f); h.hidden = false; svFrame = f; svSrc = src;
  // Garis muat bilah menyala sampai iframe selesai memuat (state server tidak tahu kapan iframe selesai; judul / riwayat tidak terbaca induk).
  svPend = true; const ld = $('sbload'); if (ld) ld.hidden = false;
  if (typeof f.addEventListener === 'function') f.addEventListener('load', () => { if (svFrame !== f) return; svPend = false; const l = $('sbload'); if (l) l.hidden = true; });
  return true;
}

function svSync(st) {
  if (!svLayerOn() || !st || st.open !== true || st.status !== 'ready' || typeof st.url !== 'string' || !st.url) { svUnmount(); return; }
  svMount(st.url);
}

// Balasan siteOpen (jaga-jaga bila kejadian sitestate 'ready' hilang): alamat tetap dari server dan tetap diperiksa svMount.
function svReply(r) {
  if (!svLayerOn() || !r || r.ok !== true) return;
  svMount(r.url);
}

if (typeof document !== 'undefined' && document.addEventListener) {
  const sa = typeof sbApi === 'function' ? sbApi() : null; // penampil hanya ada bila api.siteOpen ada (F.3.5d menyalakannya di Android)
  if (sa && typeof sa.onSiteState === 'function') sa.onSiteState(svSync);
}
