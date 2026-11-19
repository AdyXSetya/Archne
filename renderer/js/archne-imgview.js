// ---- Penampil foto (v0.25.0 Step 1) ----
// Membuka foto hasil unduhan: isinya diambil dari Core lewat id (api.mediaRead), yang memeriksa bahwa berkas itu benar-benar gambar.
// Zoom: roda tetikus / tombol +/− / cubit dua jari; geser: tarik; ketuk dua kali: pas layar <-> 2x. Esc atau tombol Kembali Android menutup.
// Gambar tampil lewat <img> data: (CSP hanya mengizinkan data:), tanpa skrip. Isi dilepas saat ditutup supaya memori kembali.
let ivId = null, ivPg = null, ivPushed = false, ivN = 0, ivNW = 0, ivNH = 0, ivS = 1, ivFit = 1, ivX = 0, ivY = 0, ivLast = 0;
const ivPts = new Map();
let ivPinch = 0;
const imgvOpen = () => ivId !== null;
const ivMaxScale = () => Math.max(8, ivFit * 8);
function ivStage() { const s = $('ivs'); return { w: s.clientWidth || 1, h: s.clientHeight || 1 }; }
function ivClamp() {
  const st = ivStage(), w = ivNW * ivS, h = ivNH * ivS;
  ivX = w <= st.w ? (st.w - w) / 2 : Math.min(0, Math.max(st.w - w, ivX));
  ivY = h <= st.h ? (st.h - h) / 2 : Math.min(0, Math.max(st.h - h, ivY));
}
function ivApply() {
  ivClamp();
  const im = $('ivimg');
  im.style.transform = `translate(${ivX}px,${ivY}px) scale(${ivS})`;
  $('ivzl').textContent = Math.round(ivS * 100) + '%';
}
function ivFitAll() {
  const st = ivStage();
  ivFit = ivNW && ivNH ? Math.min(st.w / ivNW, st.h / ivNH, 1) : 1;
  ivS = ivFit; ivX = ivY = 0; ivApply();
}
// Zoom ke skala `s` dengan titik (cx, cy) di layar penampil tetap di tempatnya.
function ivZoomAt(s, cx, cy) {
  s = Math.min(ivMaxScale(), Math.max(ivFit, s));
  const k = s / ivS;
  ivX = cx - (cx - ivX) * k; ivY = cy - (cy - ivY) * k; ivS = s; ivApply();
}
function ivCenterZoom(f) { const st = ivStage(); ivZoomAt(ivS * f, st.w / 2, st.h / 2); }
// Mode Halaman (2d-5): gambar penuh milik peer, bukan berkas unduhan. ivPg = { peerId, postId, mediaId, name } (null = mode chat). Sumbernya URL penyaji lokal dari token pgImage
// (archne-media://m/<tok> di desktop, <awalan sesi>/media/<tok> di Android), BUKAN data URL: gambar bisa sampai 2 GiB dan dibaca per blok dari pemilik saat dibuka/di-zoom.
// Tombol "buka dengan aplikasi lain" disembunyikan (tidak ada berkas lokal). Galat: kode Core -> PG_ERR (js/archne-pages.js); null = tidak tersedia; <img> gagal di tengah aliran = terputus. Coba lagi = minta token baru.
const IV_TOK = /^[0-9a-f]{32}$/, IV_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
function ivShowErr(msg, retry) { $('ivmsg').textContent = msg; const b = $('ivretry'); if (b) b.style.display = retry ? '' : 'none'; }
// sib = [{ id, name }] seluruh gambar satu postingan (urutan tampil); bila lebih dari satu, tombol sebelumnya/berikutnya + panah kiri/kanan berpindah di antaranya.
// Pindah = openImgPage baru (token baru, entri riwayat tetap satu). Gestur geser sengaja tidak dipakai: bentrok dengan geser saat gambar di-zoom.
function ivNavUi() {
  const sib = ivPg && ivPg.sib, i = sib ? sib.findIndex((x) => x.id === ivPg.mediaId) : -1, on = !!sib && sib.length > 1 && i >= 0;
  const pv = $('ivprev'), nx = $('ivnext');
  if (pv) { pv.style.display = on ? '' : 'none'; pv.disabled = !on; }
  if (nx) { nx.style.display = on ? '' : 'none'; nx.disabled = !on; }
  return on ? { i, n: sib.length } : null;
}
function ivNav(d) {
  const sib = ivPg && ivPg.sib; if (!sib) return;
  const i = sib.findIndex((x) => x.id === ivPg.mediaId); if (i < 0 || sib.length < 2) return;
  const j = ((i + d) % sib.length + sib.length) % sib.length; // looping
  openImgPage(ivPg.peerId, ivPg.postId, sib[j].id, sib[j].name, sib);
}
async function openImgPage(peerId, postId, mediaId, name, sib) {
  if (!$('imgv')) return;
  const my = ++ivN;
  ivId = 'pg:' + mediaId; ivPg = { peerId, postId, mediaId, name, sib: Array.isArray(sib) ? sib : null }; ivNW = ivNH = 0;
  const nv = ivNavUi();
  $('ivt').textContent = (name || txf('imgv.defName', 'Gambar')) + (nv ? ` (${nv.i + 1}/${nv.n})` : '');
  const op = $('ivopen'); if (op) op.style.display = 'none';
  const im = $('ivimg'); im.style.visibility = 'hidden'; im.onload = im.onerror = null; im.removeAttribute('src');
  ivShowErr(txf('imgv.loadingImg', 'Memuat gambar…'), false);
  $('imgv').classList.add('on');
  if (!ivPushed) { try { if (window.history) { window.history.pushState({ iv: 1 }, ''); ivPushed = true; } } catch (x) {} }
  let r;
  try { r = await window.api.pgImage(peerId, postId, mediaId); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (my !== ivN || !ivPg || ivPg.mediaId !== mediaId) return; // ditutup atau diganti selagi menunggu
  if (!r || r.ok !== true) { const c = r && r.code; ivShowErr((c && PG_ERR[c]) || (r && r.err) || txf('imgv.loadFail', 'Gambar tidak bisa dimuat.'), !(c && PG_NORETRY[c])); return; }
  const g = r.image;
  if (g === null) { ivShowErr(txf('imgv.gone', 'Gambar tidak tersedia. Mungkin sudah dihapus atau tidak untukmu.'), false); return; }
  if (!g || typeof g !== 'object' || !IV_TOK.test(String(g.tok)) || !IV_MIME.includes(g.mime) || typeof plUrl4 !== 'function') { ivShowErr(PG_ERR.proto, false); return; }
  im.onload = () => {
    if (my !== ivN) return;
    ivNW = im.naturalWidth; ivNH = im.naturalHeight;
    ivShowErr('', false); im.style.visibility = 'visible'; ivFitAll();
  };
  im.onerror = () => { if (my === ivN) { im.style.visibility = 'hidden'; ivShowErr(txf('imgv.cut', 'Gambar terputus di tengah jalan (pemilik mungkin offline). Coba lagi.'), true); } };
  im.src = plUrl4(g.tok);
}
async function openImg(id) {
  if (!$('imgv')) return;
  const my = ++ivN;
  ivId = id; ivPg = null; ivNW = ivNH = 0; ivNavUi();
  { const op = $('ivopen'); if (op) op.style.display = ''; const rb = $('ivretry'); if (rb) rb.style.display = 'none'; }
  const nm = ((S.messages.find((m) => m.id === id) || {}).file || {}).name || txf('imgv.defPhoto', 'Foto');
  $('ivt').textContent = nm;
  $('ivimg').style.visibility = 'hidden'; $('ivimg').removeAttribute('src');
  $('ivmsg').textContent = txf('imgv.loadingPhoto', 'Memuat foto…');
  $('imgv').classList.add('on');
  if (!ivPushed) { try { if (window.history) { window.history.pushState({ iv: 1 }, ''); ivPushed = true; } } catch (x) {} }
  let r;
  try { r = await window.api.mediaRead(id); } catch (e) { r = { ok: false, err: txf('imgv.readFail', 'Gagal memuat foto') }; }
  if (my !== ivN || ivId !== id) return; // ditutup atau diganti selagi memuat
  if (!r || !r.ok || typeof r.b64 !== 'string') { $('ivmsg').textContent = (r && r.err) || txf('imgv.photoFail', 'Foto tidak bisa ditampilkan. Coba buka dengan aplikasi lain (ikon di kanan atas).'); return; }
  const im = $('ivimg');
  im.onload = () => {
    if (my !== ivN || ivId !== id) return;
    ivNW = im.naturalWidth; ivNH = im.naturalHeight;
    $('ivmsg').textContent = ''; im.style.visibility = 'visible'; ivFitAll();
  };
  im.onerror = () => { if (my === ivN) { $('ivmsg').textContent = txf('imgv.photoFail', 'Foto tidak bisa ditampilkan. Coba buka dengan aplikasi lain (ikon di kanan atas).'); im.style.visibility = 'hidden'; } };
  im.src = 'data:' + r.mime + ';base64,' + r.b64;
}
function ivDone() {
  ivId = null; ivPg = null; ivN++; ivPts.clear(); ivPinch = 0;
  ivNavUi();
  { const op = $('ivopen'); if (op) op.style.display = ''; const rb = $('ivretry'); if (rb) rb.style.display = 'none'; }
  const im = $('ivimg'); if (im) { im.onload = im.onerror = null; im.removeAttribute('src'); im.style.visibility = 'hidden'; }
  if ($('imgv')) $('imgv').classList.remove('on');
}
function closeImg() {
  if (ivId === null) return;
  if (ivPushed && window.history) { try { window.history.back(); return; } catch (x) {} } // popstate -> imgvPop -> ivDone
  ivPushed = false; ivDone();
}
function imgvPop() { ivPushed = false; ivDone(); } // dipanggil dari popstate (js/archne-render.js) saat penampil terbuka
if ($('imgv')) {
  $('ivx').onclick = closeImg;
  $('ivopen').onclick = async () => { if (ivId === null || ivPg) return; const r = await window.api.openFile(ivId); if (r && r.ok === false && r.err) toast(r.err); };
  if ($('ivretry')) $('ivretry').onclick = () => { if (ivPg) openImgPage(ivPg.peerId, ivPg.postId, ivPg.mediaId, ivPg.name, ivPg.sib); };
  if ($('ivprev')) $('ivprev').onclick = () => ivNav(-1);
  if ($('ivnext')) $('ivnext').onclick = () => ivNav(1);
  $('ivzi').onclick = () => ivCenterZoom(1.5);
  $('ivzo').onclick = () => ivCenterZoom(1 / 1.5);
  $('ivfit').onclick = () => ivFitAll();
  const stg = $('ivs');
  stg.addEventListener('wheel', (e) => {
    if (!ivNW) return;
    e.preventDefault();
    const r = stg.getBoundingClientRect();
    ivZoomAt(ivS * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  stg.addEventListener('pointerdown', (e) => {
    if (!ivNW) return;
    try { stg.setPointerCapture(e.pointerId); } catch (x) {}
    ivPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ivPts.size === 2) { const [a, b] = [...ivPts.values()]; ivPinch = Math.hypot(a.x - b.x, a.y - b.y) || 0; }
    else if (ivPts.size === 1) {
      stg.classList.add('drag');
      const now = Date.now(); // ketuk dua kali
      if (now - ivLast < 300) {
        const r = stg.getBoundingClientRect();
        if (ivS > ivFit * 1.05) ivFitAll(); else ivZoomAt(Math.max(ivFit * 2, 1), e.clientX - r.left, e.clientY - r.top);
        ivLast = 0;
      } else ivLast = now;
    }
  });
  stg.addEventListener('pointermove', (e) => {
    const p = ivPts.get(e.pointerId);
    if (!p || !ivNW) return;
    if (ivPts.size === 2) {
      ivPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...ivPts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (ivPinch > 0 && d > 0) { const r = stg.getBoundingClientRect(); ivZoomAt(ivS * (d / ivPinch), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); }
      ivPinch = d;
      return;
    }
    ivX += e.clientX - p.x; ivY += e.clientY - p.y;
    ivPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    ivApply();
  });
  const up = (e) => { ivPts.delete(e.pointerId); ivPinch = 0; if (!ivPts.size) stg.classList.remove('drag'); };
  stg.addEventListener('pointerup', up); stg.addEventListener('pointercancel', up);
  if (window.addEventListener) window.addEventListener('resize', () => { if (ivId !== null && ivNW) { const wasFit = ivS <= ivFit * 1.001; const st = ivS; ivFitAll(); if (!wasFit) { ivS = Math.min(ivMaxScale(), Math.max(ivFit, st)); ivApply(); } } });
  if (document.addEventListener) document.addEventListener('keydown', (e) => {
    if (ivId === null) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImg(); }
    else if (e.key === '+' || e.key === '=') ivCenterZoom(1.5);
    else if (e.key === '-' || e.key === '_') ivCenterZoom(1 / 1.5);
    else if (e.key === '0') ivFitAll();
    else if (e.key === 'ArrowLeft' && ivPg) { e.preventDefault(); ivNav(-1); }
    else if (e.key === 'ArrowRight' && ivPg) { e.preventDefault(); ivNav(1); }
  }, true);
}
