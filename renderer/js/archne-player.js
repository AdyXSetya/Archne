// ---- Pemutar audio/video (v0.25.0 Step 2) ----
// Isi diambil dari Core lewat id (api.mediaPlay), yang memeriksa ekstensi dan kontainer. Diputar lewat blob: URL di <audio>/<video> bawaan
// (kontrol bawaan: putar/jeda, seek, volume; tombol kecepatan 1x/1,5x/2x). Satu pemutar saja: memutar yang baru menghentikan yang lama.
// Video = layar penuh (Kembali/Esc menutup); audio = bilah di bawah yang tetap jalan saat pindah chat. Berhenti saat ada panggilan.
let plId = null, plN = 0, plUrl = null, plPushed = false, plKind = '', plRate = 1;
const PL_RATES = [1, 1.5, 2];
// Label kecepatan: koma desimal di Indonesia ('1,5×'), titik di English ('1.5×'). Tanpa archne-i18n.js tetap koma (perilaku lama). Dipakai juga oleh archne-inline.js.
function plRateTxt(r) { const en = typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'en'; return (en ? String(r) : String(r).replace('.', ',')) + '×'; }
const playerOpenNow = () => plId !== null;
const playerModal = () => plId !== null && plKind === 'vid';
function plFree() {
  const b = $('mpb');
  if (b) { const el = b.firstChild; if (el) { try { el.pause(); } catch (x) {} el.removeAttribute('src'); try { el.load(); } catch (x) {} } b.innerHTML = ''; }
  if (plUrl) { try { URL.revokeObjectURL(plUrl); } catch (x) {} plUrl = null; }
}
function plDone() {
  plId = null; plN++; plKind = '';
  plFree();
  const m = $('mpl'); if (m) { m.classList.remove('on'); m.classList.remove('vid'); m.classList.remove('aud'); }
}
function playerStop() { if (typeof inlineStop === 'function') inlineStop(); if (plId === null) return; if (plPushed && window.history) { try { window.history.back(); return; } catch (x) {} } plPushed = false; plDone(); }
function playerPop() { plPushed = false; plDone(); } // dari popstate (js/archne-render.js) saat pemutar video terbuka
function plBytes(b64) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
// URL pemutar: desktop (file://) lewat protokol archne-media, Android/peramban lewat rute /media/ di bawah awalan sesi.
function plUrl4(tok) {
  const loc = window.location || {};
  if (loc.protocol === 'file:') return 'archne-media://m/' + tok;
  const m = /^\/s\/[0-9a-f]+\//.exec(loc.pathname || '');
  return (m ? m[0] : '/') + 'media/' + tok;
}
// Minta token stream. live: unduhan sedang berjalan, tunggu data pertama (maks ~40 dtk). null = dibatalkan/diganti selagi menunggu.
async function plResolve(id, live, my) {
  for (let i = 0; i < 60; i++) {
    let r;
    try { r = await window.api.mediaStream(id); } catch (e) { return { ok: false, noapi: true }; }
    if (my !== plN || plId !== id) return null;
    if (r && r.ok) return r;
    if (live && r && (r.code === 'wait' || r.code === 'notstarted')) {
      $('mpm').textContent = txf('pl.waitFirst', 'Menunggu data pertama…');
      await new Promise((res) => setTimeout(res, 700));
      if (my !== plN || plId !== id) return null;
      continue;
    }
    return r || { ok: false };
  }
  return { ok: false, err: txf('pl.noFirst', 'Data pertama belum datang. Coba lagi sebentar lagi.') };
}
// Jalur lama: seluruh isi lewat IPC menjadi blob (berkas <= 32 MB). Dipakai bila stream tidak tersedia atau gagal.
async function plBlob(id, my) {
  let r;
  try { r = await window.api.mediaPlay(id); } catch (e) { r = { ok: false, err: txf('pl.loadFail', 'Gagal memuat berkas') }; }
  if (my !== plN || plId !== id) return null;
  if (!r || !r.ok || typeof r.b64 !== 'string') return { ok: false, err: (r && r.err) || txf('pl.cantPlay', 'Tidak bisa diputar. Coba buka dengan aplikasi lain (ikon di kanan atas).') };
  try { const blob = new Blob([plBytes(r.b64)], { type: r.mime }); plUrl = URL.createObjectURL(blob); } catch (e) { return { ok: false, err: txf('pl.tooBig', 'Berkas terlalu besar untuk diputar di sini.') }; }
  return { ok: true, kind: r.kind, src: plUrl };
}
function plMount(kind, src, my, onfail) {
  plKind = kind === 'vid' ? 'vid' : 'aud';
  const el = document.createElement(plKind === 'vid' ? 'video' : 'audio');
  el.controls = true; el.preload = 'auto'; if (plKind === 'vid') el.setAttribute('playsinline', '');
  el.onerror = () => { if (my !== plN) return; if (onfail && onfail()) return; $('mpm').textContent = txf('pl.format', 'Format ini tidak didukung di perangkat ini. Coba buka dengan aplikasi lain (ikon di kanan atas).'); };
  el.onloadedmetadata = () => { if (my === plN) $('mpm').textContent = ''; };
  el.src = src; el.playbackRate = plRate = 1; $('mpsp').textContent = '1×';
  $('mpb').innerHTML = ''; $('mpb').appendChild(el);
  $('mpl').classList.remove('vid'); $('mpl').classList.remove('aud'); $('mpl').classList.add(plKind);
  if (plKind === 'vid' && !plPushed) { try { if (window.history) { window.history.pushState({ pl: 1 }, ''); plPushed = true; } } catch (x) {} }
  try { const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (x) {}
}
// live = putar sambil mengunduh (hanya DM/grup; Core menolak untuk Publik dan berkas terkompres dengan kode yang jelas).
async function openPlayer(id, live) {
  if (!$('mpl')) return;
  if (typeof inlineStop === 'function') inlineStop();
  if ((S && S.call) || (typeof callCtl !== 'undefined' && callCtl && callCtl.cur)) { toast(txf('pl.inCall', 'Tidak bisa memutar saat panggilan berlangsung')); return; }
  if (plId !== null) { plFree(); plN++; }
  const my = ++plN;
  plId = id; plKind = '';
  const nm = ((S.messages.find((m) => m.id === id) || {}).file || {}).name || txf('pl.defName', 'Media');
  $('mpt').textContent = nm; $('mpm').textContent = txf('pl.loading', 'Memuat…'); $('mpb').innerHTML = '';
  $('mpl').classList.remove('vid'); $('mpl').classList.remove('aud'); $('mpl').classList.add('on');
  const r = await plResolve(id, !!live, my);
  if (r === null || my !== plN || plId !== id) return; // ditutup atau diganti selagi memuat
  if (r.ok) {
    let fell = false;
    plMount(r.kind, plUrl4(r.tok), my, () => { // stream gagal (mis. WebView lama): berkas kecil yang sudah lengkap dicoba lewat blob sekali
      if (fell || r.live || !(r.total <= 32 * 1048576)) return false;
      fell = true;
      plBlob(id, my).then((b) => { if (b === null || my !== plN) return; if (!b.ok) { $('mpm').textContent = b.err; return; } plMount(b.kind, b.src, my, null); });
      return true;
    });
    return;
  }
  if (r.noapi) { // shell lama tanpa mediaStream
    const b = await plBlob(id, my);
    if (b === null) return;
    if (!b.ok) { $('mpm').textContent = b.err; return; }
    plMount(b.kind, b.src, my, null); return;
  }
  $('mpm').textContent = r.err || txf('pl.cantPlay', 'Tidak bisa diputar. Coba buka dengan aplikasi lain (ikon di kanan atas).');
}
if ($('mpl')) {
  $('mpx').onclick = playerStop;
  $('mpopen').onclick = async () => { if (plId === null) return; const r = await window.api.openFile(plId); if (r && r.ok === false && r.err) toast(r.err); };
  $('mpsp').onclick = () => {
    const el = $('mpb').firstChild; if (!el) return;
    plRate = PL_RATES[(PL_RATES.indexOf(plRate) + 1) % PL_RATES.length];
    el.playbackRate = plRate; $('mpsp').textContent = plRateTxt(plRate);
  };
  if (document.addEventListener) document.addEventListener('keydown', (e) => { if (playerModal() && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); playerStop(); } }, true);
}
