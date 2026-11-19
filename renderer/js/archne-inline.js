// ---- Pemutar di dalam gelembung (v0.25.1 Step 2) ----
// Pesan suara dan video yang sudah terunduh diputar LANGSUNG di kartunya (tanpa bilah hitam/layar penuh). Layar penuh hanya dari menu ⋮ (pemutar modal js/63).
// Chat digambar ulang tiap beberapa detik (render()), jadi elemen media disimpan di sini dan dipasang kembali ke kartunya oleh inlineSync() di akhir render().
// Audio memakai elemen yang tidak ditempel ke DOM (tetap jalan walau kartunya hilang dari layar); video ikut berhenti bila kartunya tidak ada.
// Sumber sama dengan pemutar modal: api.mediaStream (token) dan jatuh balik ke api.mediaPlay (blob, <= 32 MB). Satu pemutar saja: yang baru menghentikan yang lama.
let ilId = null, ilN = 0, ilEl = null, ilUrl = null, ilKind = '', ilRate = 1, ilLoad = false;
const IL_RATES = [1, 1.5, 2];
const ilClock = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const ilCard = (id) => { const k = id === undefined ? ilId : id; return k ? document.querySelector(`#msgs [data-file="${CSS.escape(k)}"]`) : null; };
function ilFree() {
  if (ilEl) { try { ilEl.pause(); } catch (x) {} ilEl.removeAttribute('src'); try { ilEl.load(); } catch (x) {} if (ilEl.parentNode) ilEl.parentNode.removeChild(ilEl); }
  ilEl = null;
  if (ilUrl) { try { URL.revokeObjectURL(ilUrl); } catch (x) {} ilUrl = null; }
}
function ilPaint(c) {
  if (!c) return;
  const on = !!ilId && c.getAttribute('data-file') === ilId, el = on ? ilEl : null, playing = !!el && !el.paused;
  const d = el && isFinite(el.duration) && el.duration > 0 ? el.duration : 0, frac = d ? Math.min(1, el.currentTime / d) : 0;
  if (c.classList.contains('fcvc')) {
    const lead = c.querySelector('[data-act="play"]');
    if (lead) { lead.innerHTML = FileCard.ico(playing ? 'pause' : 'play'); const t = playing ? txf('common.pause', 'Jeda') : txf('common.play', 'Putar'); lead.title = t; lead.setAttribute('aria-label', t); lead.classList.toggle('ilload', on && ilLoad); }
    const tr = c.querySelector('.vtr i'); if (tr) tr.style.width = (frac * 100) + '%';
    const vd = c.querySelector('.vdur'); if (vd) vd.textContent = el && (playing || el.currentTime > 0.05) ? ilClock(el.currentTime) : vd.getAttribute('data-d');
    let sp = c.querySelector('.vsp');
    if (on && el) { if (!sp) { sp = document.createElement('button'); sp.type = 'button'; sp.className = 'vsp'; sp.title = txf('player.speed', 'Kecepatan putar'); sp.setAttribute('aria-label', sp.title); const fi = c.querySelector('.fi'); if (fi) fi.appendChild(sp); } sp.textContent = plRateTxt(ilRate); }
    else if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
  }
  const slot = c.querySelector('.fthw');
  if (slot) {
    let ov = slot.querySelector('.fvov'), pg = slot.querySelector('.fvp');
    if (on && ilKind === 'vid' && el) {
      if (el.parentNode !== slot) slot.appendChild(el); // dipasang kembali setelah chat digambar ulang (sinkron, jadi tidak terjeda)
      if (!ov) { ov = document.createElement('span'); ov.className = 'fvov'; ov.innerHTML = FileCard.ico('play'); slot.appendChild(ov); }
      if (!pg) { pg = document.createElement('div'); pg.className = 'fvp'; pg.innerHTML = '<i></i>'; slot.appendChild(pg); }
      slot.classList.toggle('ilpaused', !playing); pg.firstChild.style.width = (frac * 100) + '%';
    } else {
      const v = slot.querySelector('.fvid'); if (v && v !== ilEl && v.parentNode) v.parentNode.removeChild(v);
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov); if (pg && pg.parentNode) pg.parentNode.removeChild(pg);
      slot.classList.remove('ilpaused');
    }
  }
}
function inlineStop() {
  if (ilId === null) return;
  const c = ilCard(); ilId = null; ilN++; ilKind = ''; ilLoad = false;
  ilFree(); ilPaint(c);
}
// Dipanggil di akhir render(): pasang kembali elemen ke kartu baru; pesan yang dihapus / kartu video yang hilang menghentikan pemutaran.
function inlineSync() {
  if (ilId === null) return;
  if (!S.messages.some((m) => m.id === ilId)) { inlineStop(); return; }
  const c = ilCard(); if (!c) { if (ilKind === 'vid') inlineStop(); return; }
  ilPaint(c);
}
// Kartu ini bisa diputar di tempat? Suara: kartu .fcvc. Video: kartu berminiatur (.fthw) berekstensi video. Selain itu (mp3, video tanpa thumbnail) tetap pemutar modal.
function inlineCan(id) {
  const c = ilCard(id), m = S.messages.find((x) => x.id === id), f = m && m.file; if (!c || !f) return false;
  if (c.classList.contains('fcvc')) return true;
  return !!c.querySelector('.fthw') && FileCard.playKind((f.saved && f.saved.name) || f.name) === 'vid';
}
async function ilBlob(id, my, err) {
  let r; try { r = await window.api.mediaPlay(id); } catch (e) { r = null; }
  if (my !== ilN) return null;
  if (!r || !r.ok || typeof r.b64 !== 'string') return { ok: false, err: (r && r.err) || err || txf('il.cantPlay', 'Tidak bisa diputar.') };
  try { ilUrl = URL.createObjectURL(new Blob([plBytes(r.b64)], { type: r.mime })); } catch (e) { return { ok: false, err: txf('pl.tooBig', 'Berkas terlalu besar untuk diputar di sini.') }; }
  return { ok: true, src: ilUrl };
}
async function ilSource(id, my) {
  let r; try { r = await window.api.mediaStream(id); } catch (e) { r = { noapi: true }; }
  if (my !== ilN) return null;
  if (r && r.ok) return { ok: true, src: plUrl4(r.tok), blobOk: !r.live && r.total <= 32 * 1048576 };
  return ilBlob(id, my, r && r.err);
}
const ilGo = (el) => { try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (x) {} };
async function inlinePlay(id) {
  if (ilId === id && ilEl) { if (ilEl.paused) ilGo(ilEl); else ilEl.pause(); ilPaint(ilCard()); return; } // ketuk lagi: jeda / lanjut
  if ((S && S.call) || (typeof callCtl !== 'undefined' && callCtl && callCtl.cur)) { toast(txf('pl.inCall', 'Tidak bisa memutar saat panggilan berlangsung')); return; }
  if (typeof playerStop === 'function') playerStop(); // menghentikan pemutar modal (dan pemutar ini)
  inlineStop();
  const c = ilCard(id); if (!c) return;
  const kind = c.classList.contains('fcvc') ? 'aud' : 'vid', my = ++ilN;
  ilId = id; ilKind = kind; ilLoad = true; ilPaint(c);
  const r = await ilSource(id, my);
  if (r === null || my !== ilN) return;
  if (!r.ok) { toast(r.err || txf('il.cantPlay', 'Tidak bisa diputar.')); inlineStop(); return; }
  const el = document.createElement(kind === 'vid' ? 'video' : 'audio');
  el.preload = 'auto'; if (kind === 'vid') { el.setAttribute('playsinline', ''); el.className = 'fvid'; el.onclick = () => inlinePlay(id); }
  let fell = false;
  el.onerror = () => {
    if (my !== ilN) return;
    if (r.blobOk && !fell) { fell = true; ilBlob(id, my).then((b) => { if (b === null || my !== ilN) return; if (!b.ok) { toast(b.err); inlineStop(); return; } el.src = b.src; ilGo(el); }); return; }
    toast(txf('il.format', 'Format ini tidak didukung di perangkat ini.')); inlineStop();
  };
  el.onloadedmetadata = () => { if (my === ilN) { ilLoad = false; ilPaint(ilCard()); } };
  el.ontimeupdate = el.onplay = el.onpause = () => { if (my === ilN) ilPaint(ilCard()); };
  el.onended = () => { if (my !== ilN) return; try { el.currentTime = 0; } catch (x) {} ilPaint(ilCard()); };
  el.src = r.src; el.playbackRate = ilRate = 1; ilEl = el; ilLoad = false;
  ilPaint(ilCard()); ilGo(el);
}
if ($('msgs') && $('msgs').addEventListener) $('msgs').addEventListener('click', (e) => {
  const t = e.target; if (!t || !t.closest) return;
  const sp = t.closest('.vsp');
  if (sp) { if (ilEl) { ilRate = IL_RATES[(IL_RATES.indexOf(ilRate) + 1) % IL_RATES.length]; ilEl.playbackRate = ilRate; ilPaint(ilCard()); } return; }
  const tr = t.closest('.vtr'); // ketuk jalur: lompat ke posisi itu (hanya pesan yang sedang diputar)
  if (tr) { const c = tr.closest('[data-file]'); if (!c || !ilEl || c.getAttribute('data-file') !== ilId || !(ilEl.duration > 0)) return; const r = tr.getBoundingClientRect(); if (r.width > 0) { try { ilEl.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * ilEl.duration; } catch (x) {} ilPaint(c); } }
});
