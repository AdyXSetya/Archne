// ---- Pesan suara (v0.25.0 Step 4) ----
// Ketuk 🎤 -> lembar perekam: izin mikrofon, langsung merekam dengan penanda merah + waktu, lalu Selesai -> tinjau (putar) -> Kirim/Ulangi.
// Hanya DM dan grup (Publik tidak). Dikirim lewat api.sendVoice (jalur sendiri; Core memeriksa isi, ukuran, dan membuat nama tawaran).
// Mikrofon tidak pernah dibuka tanpa lembar ini tampak, dan dilepas pada: Batal/Tutup, Kembali/Esc, kirim, panggilan masuk/berlangsung, dan saat aplikasi
// pindah ke latar (rekaman dihentikan, hasilnya masuk ke tinjauan). Tidak pernah diputar otomatis di penerima.
let vnOn = false, vnPushed = false, vnStream = null, vnRec = null, vnChunks = [], vnBytes = 0, vnT0 = 0, vnTick = 0, vnN = 0, vnBusy = false;
let vnBlob = null, vnUrl = null, vnMime = null, vnDur = 0, vnTo = '';
const voiceOpen = () => vnOn;
// Tinjauan: putar/jeda + jalur yang bisa diketuk, tanpa bilah audio bawaan peramban. Durasi dari hitungan sendiri (vnDur): rekaman WebM sering melaporkan durasi Infinity.
const VN_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" class="f"><path d="M8 5.2v13.6a.6.6 0 00.9.5l11-6.8a.6.6 0 000-1l-11-6.8a.6.6 0 00-.9.5z"/></svg>';
const VN_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5v13M15 5.5v13"/></svg>';
function vnPlayUi() {
  const a = $('vra'), b = $('vrplay'); if (!a || !b) return;
  const on = a.paused === false && !a.ended, tot = vnDur / 1000 || 0;
  b.innerHTML = on ? VN_PAUSE : VN_PLAY; b.title = on ? txf('common.pause', 'Jeda') : txf('common.play', 'Putar'); if (b.setAttribute) b.setAttribute('aria-label', b.title);
  const cur = Number(a.currentTime) || 0, frac = tot > 0 ? Math.max(0, Math.min(1, cur / tot)) : 0;
  const bar = $('vrbar'); if (bar && bar.style) bar.style.width = (on || cur > 0 ? frac * 100 : 0) + '%';
  const tr = $('vrtr'); if (tr && tr.setAttribute) tr.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  const d = $('vrd'); if (d && vnDur) d.textContent = VoiceNote.fmtClock(on ? cur * 1000 : vnDur);
}
function vnToggle() {
  const a = $('vra'); if (!a || !vnBlob) return;
  try {
    if (a.paused !== false || a.ended) { if (a.ended) a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } else a.pause();
  } catch (x) {}
  vnPlayUi();
}
function vnSeek(clientX) {
  const a = $('vra'), tr = $('vrtr'); if (!a || !tr || !vnBlob || !(vnDur > 0) || !tr.getBoundingClientRect) return;
  const r = tr.getBoundingClientRect(); if (!(r.width > 0)) return;
  const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  try { a.currentTime = f * (vnDur / 1000); } catch (x) {}
  vnPlayUi();
}
const vnState = (c) => { const e = $('vrec'); if (!e) return; for (const k of ['rec', 'rev', 'err']) e.classList.remove(k); if (c) e.classList.add(c); };
const vnMsg = (t) => { const m = $('vrm'); if (m) m.textContent = t || ''; };
const vnCallBusy = () => !!((S && S.call) || (typeof callCtl !== 'undefined' && callCtl && callCtl.cur));
function vnStopStream() { if (vnStream) { for (const t of vnStream.getTracks()) { try { t.stop(); } catch (x) {} } vnStream = null; } }
function vnFreeBlob() { vnBlob = null; if (vnUrl) { try { URL.revokeObjectURL(vnUrl); } catch (x) {} vnUrl = null; } const a = $('vra'); if (a) { try { a.pause(); } catch (x) {} a.removeAttribute('src'); vnPlayUi(); } }
function vnStopRec(discard) {
  clearInterval(vnTick); vnTick = 0;
  const r = vnRec; vnRec = null;
  if (r) { r.onstop = null; r.ondataavailable = null; r.onerror = null; try { if (r.state !== 'inactive') r.stop(); } catch (x) {} }
  if (discard) { vnChunks = []; vnBytes = 0; }
}
async function vnPerm() {
  if (typeof nbridge === 'undefined' || !nbridge) return true; // desktop/peramban: Chromium/WebView menanyakan sendiri
  const m = await nbridge.ask('mic', undefined, 120000);
  return !!(m && m.ok);
}
async function vnStart() {
  const my = ++vnN;
  vnStopRec(true); vnStopStream(); vnFreeBlob();
  vnState('err'); vnMsg(txf('vn.opening', 'Membuka mikrofon…')); $('vrt').textContent = '';
  if (!(await vnPerm())) { if (my === vnN) vnMsg(txf('vn.perm', 'Izin mikrofon ditolak. Aktifkan di pengaturan perangkat.')); return; }
  if (my !== vnN) return;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) { vnMsg(txf('vn.none', 'Mikrofon tidak tersedia di perangkat ini.')); return; }
  const mt = VoiceNote.pickRecMime((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
  if (!mt) { vnMsg(txf('vn.recUnsupported', 'Perekaman suara tidak didukung di perangkat ini.')); return; }
  let st;
  try { st = await md.getUserMedia(VoiceNote.constraints()); }
  catch (e) { if (my === vnN) vnMsg(e && e.name === 'NotAllowedError' ? 
      txf('vn.denied', 'Izin mikrofon ditolak.') : e && e.name === 'NotFoundError' ? txf('vn.notFound', 'Mikrofon tidak ditemukan.') : txf('vn.openFail', 'Mikrofon tidak bisa dibuka (mungkin sedang dipakai aplikasi lain).')); return; }
  if (my !== vnN || !vnOn) { for (const t of st.getTracks()) t.stop(); return; }
  let r;
  try { r = new MediaRecorder(st, { mimeType: mt.mime, audioBitsPerSecond: VoiceNote.BPS }); }
  catch (e) { for (const t of st.getTracks()) t.stop(); vnMsg(txf('vn.startFail', 'Perekaman suara tidak bisa dimulai.')); return; }
  vnStream = st; vnMime = mt; vnChunks = []; vnBytes = 0;
  r.ondataavailable = (e) => { if (e.data && e.data.size) { vnChunks.push(e.data); vnBytes += e.data.size; } };
  r.onerror = () => { if (my !== vnN) return; vnStopRec(true); vnStopStream(); vnState('err'); vnMsg(txf('cam.recFail', 'Perekaman gagal.')); };
  r.start(1000); vnRec = r; vnT0 = Date.now();
  vnMsg(''); vnState('rec'); $('vrt').textContent = '● 0:00';
  vnTick = setInterval(() => {
    if (vnCallBusy()) { closeVoice(); toast(txf('vn.callCancel', 'Perekaman dibatalkan karena ada panggilan')); return; }
    const ms = Date.now() - vnT0;
    $('vrt').textContent = '● ' + VoiceNote.fmtClock(ms);
    if (VoiceNote.shouldStop(ms, vnBytes)) vnFinish();
  }, 250);
}
async function openVoice() {
  if (!$('vrec') || vnOn) return;
  if (cur === 'public') { toast(txf('vn.noPublic', 'Pesan suara tidak tersedia di Publik')); return; }
  if (vnCallBusy()) { toast(txf('vn.inCall', 'Pesan suara tidak bisa direkam saat panggilan berlangsung')); return; }
  if (typeof cameraOpen === 'function' && cameraOpen()) return;
  if (typeof playerStop === 'function') playerStop(); // jangan merekam bunyi pemutar sendiri
  vnOn = true; vnTo = cur; vnBusy = false;
  $('vrec').classList.add('on');
  if (!vnPushed) { try { if (window.history) { window.history.pushState({ vn: 1 }, ''); vnPushed = true; } } catch (x) {} }
  await vnStart();
}
function vnDone() {
  vnOn = false; vnN++; vnBusy = false;
  vnStopRec(true); vnStopStream(); vnFreeBlob();
  const e = $('vrec'); if (e) { e.classList.remove('on'); vnState(''); }
}
function closeVoice() { if (!vnOn) return; if (vnPushed && window.history) { try { window.history.back(); return; } catch (x) {} } vnPushed = false; vnDone(); }
function voicePop() { vnPushed = false; vnDone(); } // dari popstate (js/archne-render.js)
function vnFinish() {
  const r = vnRec; if (!r) return;
  clearInterval(vnTick); vnTick = 0;
  const ms = Date.now() - vnT0, my = vnN, mt = vnMime;
  r.onstop = () => {
    if (my !== vnN || !vnOn) return;
    vnRec = null; vnStopStream();
    const b = new Blob(vnChunks, { type: mt.mime.split(';')[0] }); vnChunks = [];
    if (VoiceNote.tooShort(ms) || !b.size) { vnMsg(txf('vn.short', 'Rekaman terlalu pendek.')); vnState('err'); return; }
    vnBlob = b; vnDur = VoiceNote.clampDur(ms);
    vnUrl = URL.createObjectURL(b);
    const a = $('vra'); a.src = vnUrl; $('vrd').textContent = VoiceNote.fmtClock(vnDur); vnMsg(''); vnState('rev'); vnPlayUi();
  };
  try { if (r.state !== 'inactive') r.stop(); else r.onstop(); } catch (x) { r.onstop(); }
}
async function vnSend() {
  if (vnBusy || !vnBlob) return;
  vnBusy = true;
  const to = vnTo;
  try {
    const u8 = new Uint8Array(await vnBlob.arrayBuffer()), ext = vnMime.ext;
    if (!VoiceNote.looksRight(ext, u8) || !VoiceNote.sizeOk(u8.length, vnDur)) { toast(txf('vn.invalid', 'Hasil rekaman tidak valid. Coba rekam ulang.')); vnBusy = false; return; }
    const name = VoiceNote.fileName(new Date(), ext), dur = vnDur;
    let src;
    if (typeof window.api.captureSave === 'function') { // Electron: simpan byte lalu kirim lewat path
      const r = await window.api.captureSave(name, u8);
      if (!r || !r.ok) { toast((r && r.err) || txf('vn.saveFail', 'Gagal menyimpan rekaman')); vnBusy = false; return; }
      src = r.path;
    } else src = new File([vnBlob], name, { type: vnBlob.type }); // Android/peramban: File diunggah api-http
    closeVoice();
    const job = 'j' + Date.now().toString(36) + (jobN++);
    window.api.sendVoice(job, src, to, dur).then(async (r) => {
      await refresh();
      if (!r.ok && r.code !== 'abort' && !(S.sending || []).some((j) => j.job === job)) toast(r.err || txf('cam.sendFail', 'Gagal mengirim'));
    });
    await refresh();
  } catch (e) { toast(txf('vn.sendFail', 'Gagal mengirim pesan suara')); vnBusy = false; }
}
function voiceBtnSync() { const b = $('micbtn'); if (b) b.style.display = cur === 'public' ? 'none' : ''; } // Publik: tidak ada pesan suara
if ($('vrec')) {
  $('micbtn').onclick = () => { openVoice(); };
  $('vrx').onclick = () => closeVoice();
  $('vrstop').onclick = () => { if (vnRec) vnFinish(); };
  $('vrredo').onclick = () => { vnStart(); };
  $('vrsend').onclick = vnSend;
  if ($('vrplay')) $('vrplay').onclick = vnToggle;
  if ($('vrtr') && $('vrtr').addEventListener) {
    $('vrtr').addEventListener('click', (e) => vnSeek(e.clientX));
    $('vrtr').addEventListener('keydown', (e) => { const a = $('vra'); if (!a || !vnBlob || !(vnDur > 0)) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); try { a.currentTime = Math.max(0, Math.min(vnDur / 1000, (Number(a.currentTime) || 0) + (e.key === 'ArrowRight' ? 5 : -5))); } catch (x) {} vnPlayUi(); } });
  }
  { const a = $('vra'); if (a) { a.onplay = a.onpause = a.onended = a.ontimeupdate = vnPlayUi; } }
  if (document.addEventListener) {
    document.addEventListener('keydown', (e) => { if (vnOn && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeVoice(); } }, true);
    document.addEventListener('visibilitychange', () => { if (vnOn && document.hidden && vnRec) vnFinish(); }); // ke latar: berhenti merekam, mikrofon dilepas
  }
  voiceBtnSync();
}
