// js/archne-screen-picker.js — dialog pemilih layar/jendela untuk berbagi layar (v0.32.0 Fase C.2).
// Proses utama (src/archne-screenpick.js) mengirim daftar sumber lewat api.onScreenPick; pengguna HARUS memilih satu (tidak ada berbagi otomatis).
// Jawaban dikirim lewat api.screenPickDone(rid, id); batal / Esc / klik latar = null. Nama jendela berasal dari aplikasi lain, jadi hanya lewat textContent.
// Tidak aktif di mode peramban dan di cangkang Android: di sana api.onScreenPick tidak ada dan getDisplayMedia memakai pemilih peramban.
let spEl = null, spRid = '', spBack = null, spItems = [], spTab = 'screen', spAudio = false, spAudioBox = null; // spAudio: pemilih menawarkan audio sistem (Windows)
function spClose(answer) { // answer: string (id) | null (batal) | undefined (ditutup proses utama; tidak perlu menjawab lagi)
  const rid = spRid; spRid = '';
  if (spEl) { try { spEl.remove(); } catch (x) {} spEl = null; }
  try { if (spBack && spBack.focus) spBack.focus(); } catch (x) {} spBack = null;
  // Audio sistem hanya ikut bila kotaknya tercentang (bawaan mati) dan yang dipilih layar penuh (ditegakkan juga di proses utama).
  const aud = !!(spAudioBox && spAudioBox.checked && !spAudioBox.disabled);
  spAudioBox = null;
  if (rid && answer !== undefined) { try { window.api.screenPickDone(rid, answer, aud); } catch (x) {} }
}
function spRender() {
  if (!spEl) return;
  const grid = spEl.querySelector('.spg');
  const shown = spItems.filter((i) => i.type === spTab);
  grid.textContent = '';
  if (spAudioBox) { // audio sistem merekam seluruh perangkat: tidak ditawarkan saat tab Jendela
    const onScreen = spTab === 'screen';
    spAudioBox.disabled = !onScreen;
    spAudioBox.parentNode.classList.toggle('off', !onScreen);
  }
  for (const b of spEl.querySelectorAll('.spt button')) b.setAttribute('aria-selected', b.dataset.tab === spTab ? 'true' : 'false');
  if (!shown.length) { const e = document.createElement('div'); e.className = 'spe'; e.textContent = txf('scr.pick.empty', 'Tidak ada yang bisa dibagikan.'); grid.appendChild(e); return; }
  for (const it of shown) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'spi'; b.dataset.id = it.id;
    b.setAttribute('aria-label', txf('scr.pick.item', 'Bagikan {name}', { name: it.name || it.id }));
    if (typeof it.thumb === 'string' && it.thumb.indexOf('data:image/jpeg;base64,') === 0) { const im = document.createElement('img'); im.alt = ''; im.src = it.thumb; b.appendChild(im); }
    const n = document.createElement('span'); n.className = 'spn'; n.textContent = it.name || it.id; b.appendChild(n);
    b.onclick = () => spClose(it.id);
    grid.appendChild(b);
  }
  try { grid.querySelector('.spi').focus(); } catch (x) {}
}
function spOpen(p) {
  if (spEl) spClose(null);
  if (!p || typeof p.rid !== 'string' || !Array.isArray(p.items)) return;
  spAudio = p.audio === true;
  spRid = p.rid; spItems = p.items.filter((i) => i && typeof i.id === 'string'); spBack = document.activeElement;
  spTab = spItems.some((i) => i.type === 'screen') ? 'screen' : 'window';
  const el = document.createElement('div'); el.id = 'scrpick'; el.className = 'mbg'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', txf('scr.pick.aria', 'Pilih layar atau jendela untuk dibagikan'));
  const box = document.createElement('div'); box.className = 'box';
  const h = document.createElement('h3'); h.textContent = txf('scr.pick.title', 'Pilih yang dibagikan');
  const hint = document.createElement('p'); hint.className = 'sph'; hint.textContent = txf('scr.pick.hint', 'Semua yang tampil di sumber ini bisa dilihat peserta panggilan, termasuk notifikasi.');
  const tabs = document.createElement('div'); tabs.className = 'spt'; tabs.setAttribute('role', 'tablist');
  for (const [k, label] of [['screen', txf('scr.pick.screens', 'Layar')], ['window', txf('scr.pick.windows', 'Jendela')]]) {
    const t = document.createElement('button'); t.type = 'button'; t.dataset.tab = k; t.setAttribute('role', 'tab'); t.textContent = label;
    t.onclick = () => { spTab = k; spRender(); };
    tabs.appendChild(t);
  }
  const grid = document.createElement('div'); grid.className = 'spg';
  let aud = null;
  if (spAudio) {
    aud = document.createElement('label'); aud.className = 'spa';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = false; spAudioBox = cb; // mati secara bawaan: notifikasi dan musik ikut terkirim bila dicentang
    const lt = document.createElement('span'); lt.textContent = txf('scr.pick.audio', 'Bagikan audio sistem');
    const ln = document.createElement('small'); ln.textContent = txf('scr.pick.audioHint', 'Semua suara dari komputer ini ikut terdengar peserta, termasuk notifikasi dan musik. Hanya untuk layar penuh. Pakai headphone supaya suara peserta tidak kembali ke mereka.');
    const lw = document.createElement('span'); lw.className = 'spat'; lw.append(lt, ln);
    aud.append(cb, lw);
  }
  const row = document.createElement('div'); row.className = 'row';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = txf('common.cancel', 'Batal'); cancel.onclick = () => spClose(null);
  row.appendChild(cancel);
  box.append(h, hint, tabs, grid); if (aud) box.appendChild(aud); box.appendChild(row); el.appendChild(box);
  el.onclick = (e) => { if (e.target === el) spClose(null); };
  document.body.appendChild(el); el.style.display = 'flex'; spEl = el;
  spRender();
}
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', (e) => { if (spEl && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); spClose(null); } }, true);
if (typeof window !== 'undefined' && window.api && typeof window.api.onScreenPick === 'function' && typeof window.api.screenPickDone === 'function') {
  window.api.onScreenPick((p) => { if (p && p.cancel) { if (p.rid === spRid) spClose(undefined); } else spOpen(p); });
}
