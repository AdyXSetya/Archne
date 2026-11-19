// js/archne-weblink.js — tautan web di chat (v0.25.1): chip ringkas yang disalin utuh, dan peramban dalam aplikasi.
// Memakai $, toast, mmCopy, wanLinks (js/10, 45, 90). Teks pesan tidak pernah diubah: chip hanya tampilan, tautan asli ada di data-url.
//  - Ketuk chip: buka di peramban dalam aplikasi (Electron: WebContentsView di bawah bilah alat #webbr; Android: InAppBrowser lewat
//    cangkang; peramban biasa: tab baru). Bilah alat: Tutup, Mundur, Maju, Muat ulang, Buka di peramban luar.
//  - Tombol salin di chip / kartu undangan, dan Ctrl+C pada teks yang dipilih, menyalin tautan LENGKAP, bukan teks pendek di layar.
const wbApi = () => (window.api && typeof window.api.webOpen === 'function' ? window.api : null);
let wbOn = false;
const wbBar = () => document.querySelector('#webbr .wbbar');
const wbTop = () => { const b = wbBar(); return b ? Math.ceil(b.getBoundingClientRect().bottom) : 48; };
const wbHttp = (u) => /^https?:\/\//i.test(String(u || ''));
const wbLinkOf = (w) => (w ? (w.dataset.url || (w.dataset.inv !== undefined && typeof wanLinks !== 'undefined' ? wanLinks[Number(w.dataset.inv)] : '') || '') : '');

function wbPaint(st) {
  const el = $('webbr'); if (!el) return;
  if (!st || !st.open) { if (wbOn) wbHide(); return; }
  let host = '';
  try { host = new URL(st.url).host.replace(/^www\./i, ''); } catch (x) { host = String(st.url || ''); }
  const h = $('wbh'); h.textContent = host; h.classList.toggle('http', /^http:/i.test(st.url || '')); h.title = /^http:/i.test(st.url || '') ? txf('web.insecure', 'Tidak terenkripsi (http)') : st.url || '';
  $('wbs').textContent = st.crashed ? txf('web.crashed', 'Halaman berhenti bekerja') : st.loading && !st.title ? txf('pl.loading', 'Memuat…') : st.title || '';
  $('wbback').disabled = !st.canBack; $('wbfwd').disabled = !st.canFwd;
  $('wbload').hidden = !st.loading;
}
function wbHide() {
  wbOn = false; const el = $('webbr'); if (el) el.hidden = true;
  const b = document.body; if (b && b.classList) b.classList.remove('webopen');
}
function wbShow(url) {
  const el = $('webbr'); if (!el) return false;
  wbOn = true; el.hidden = false; $('wbh').textContent = ''; $('wbs').textContent = txf('pl.loading', 'Memuat…'); $('wbback').disabled = $('wbfwd').disabled = true; $('wbmsg').textContent = '';
  if (document.body && document.body.classList) document.body.classList.add('webopen');
  return true;
}
async function wbClose() { const a = wbApi(); wbHide(); if (a) { try { await a.webClose(); } catch (x) {} } }

// Buka tautan: peramban dalam aplikasi bila ada; kalau tidak, cangkang Android; kalau tidak, tab baru.
async function wbOpen(url) {
  url = String(url || ''); if (!wbHttp(url)) return;
  const a = wbApi();
  if (a && wbShow(url)) {
    let r; try { r = await a.webOpen(url, wbTop()); } catch (x) { r = { ok: false, err: txf('web.openFail', 'Gagal membuka tautan') }; }
    if (!r || !r.ok) { wbHide(); toast((r && r.err) || txf('web.openFail', 'Gagal membuka tautan')); }
    return;
  }
  try { if (window.parent && window.parent !== window) { window.parent.postMessage({ archne: 'native', action: 'weburl', url }, '*'); return; } } catch (x) {}
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (x) { toast(txf('web.cantOpen', 'Tidak bisa membuka tautan')); }
}
function wbExternal() {
  const a = wbApi(); if (!a || typeof a.webExternal !== 'function') return;
  a.webExternal().then((r) => { if (r && !r.ok) toast(r.err || txf('web.extFail', 'Gagal membuka peramban luar')); }, () => toast(txf('web.extFail', 'Gagal membuka peramban luar')));
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', (e) => {
    const t = e.target; if (!t || !t.closest) return;
    const cp = t.closest('[data-lcopy]');
    if (cp) { e.preventDefault(); e.stopPropagation(); const u = wbLinkOf(cp.closest('[data-url],[data-inv]')); if (u) mmCopy(u, txf('copy.link', 'Tautan')); return; }
    const a = t.closest('a.lnk');
    if (a) { e.preventDefault(); e.stopPropagation(); wbOpen(a.getAttribute('href')); }
  }, true);
  // Ctrl+C / Salin pada teks yang dipilih: chip dan kartu undangan diganti tautan aslinya.
  document.addEventListener('copy', (e) => {
    try {
      const sel = window.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
      const frag = sel.getRangeAt(0).cloneContents();
      const hits = frag.querySelectorAll('[data-url],[data-inv]'); if (!hits.length) return;
      for (const w of Array.from(hits)) w.replaceWith(document.createTextNode(wbLinkOf(w)));
      const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap'; box.appendChild(frag);
      document.body.appendChild(box); const txt = box.innerText; document.body.removeChild(box);
      e.clipboardData.setData('text/plain', txt); e.preventDefault();
    } catch (x) { /* biarkan penyalinan bawaan */ }
  });
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('wbx', wbClose);
  on('wbback', () => { const a = wbApi(); if (a) a.webNav('back'); });
  on('wbfwd', () => { const a = wbApi(); if (a) a.webNav('forward'); });
  on('wbre', () => { const a = wbApi(); if (a) a.webNav('reload'); });
  on('wbext', wbExternal);
  document.addEventListener('keydown', (e) => { if (wbOn && e.key === 'Escape') { e.preventDefault(); wbClose(); } });
  if (typeof window.addEventListener === 'function') window.addEventListener('resize', () => { const a = wbApi(); if (wbOn && a) a.webBounds(wbTop()).catch(() => {}); });
  const wa = wbApi(); if (wa && typeof wa.onWebState === 'function') wa.onWebState(wbPaint);
}
