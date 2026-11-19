// ---- Kamera foto dan video (v0.25.0 Step 3) ----
// getUserMedia + canvas (foto) / MediaRecorder (video) di renderer, sama untuk desktop dan Android. Hasilnya masuk ke jalur kirim berkas yang sama
// (sendFile), lengkap dengan thumbnail dan info media. Di Android izin kamera/mikrofon diminta lewat jembatan cangkang (nbridge, seperti panggilan).
// Foto dikodekan ulang lewat canvas, jadi EXIF/GPS tidak ikut. Hitungan murni ada di archne-camera.js.
let cmOn = false, cmPushed = false, cmMode = 'photo', cmFacing = 'environment', cmStream = null, cmRec = null, cmChunks = [], cmBytes = 0, cmT0 = 0, cmTick = 0;
let cmBlob = null, cmUrl = null, cmMime = null, cmDur = 0, cmThumb = null, cmDims = null, cmN = 0, cmBusy = false;
const cameraOpen = () => cmOn;
const cmState = (c) => { const e = $('cam'); if (!e) return; for (const k of ['live', 'shot', 'vrev', 'rec', 'vid']) e.classList.remove(k); for (const k of c) if (k) e.classList.add(k); };
function cmStopStream() { if (cmStream) { for (const t of cmStream.getTracks()) { try { t.stop(); } catch (x) {} } cmStream = null; } const v = $('cmv'); if (v) { try { v.srcObject = null; } catch (x) {} } }
function cmFreeBlob() { cmBlob = null; cmThumb = null; cmDims = null; if (cmUrl) { try { URL.revokeObjectURL(cmUrl); } catch (x) {} cmUrl = null; } const r = $('cmr'); if (r) { try { r.pause(); } catch (x) {} r.removeAttribute('src'); } }
function cmStopRec(discard) {
  clearInterval(cmTick); cmTick = 0;
  const r = cmRec; cmRec = null;
  if (r) { r.onstop = null; r.ondataavailable = null; try { if (r.state !== 'inactive') r.stop(); } catch (x) {} }
  if (discard) cmChunks = [];
}
function cmMsg(t) { const m = $('cmm'); if (m) m.textContent = t || ''; }
async function cmPerm(video) {
  if (typeof nbridge === 'undefined' || !nbridge) return true; // desktop/peramban: WebView/Chromium menanyakan sendiri
  const c = await nbridge.ask('cam', undefined, 120000);
  if (!c.ok) return false;
  if (video) { const m = await nbridge.ask('mic', undefined, 120000); if (!m.ok) return false; }
  return true;
}
async function cmStart() {
  const my = ++cmN;
  cmStopRec(true); cmStopStream(); cmFreeBlob();
  cmState(['live', cmMode === 'video' ? 'vid' : '']); cmMsg(txf('cam.opening', 'Membuka kamera…'));
  $('cmmp').classList.toggle('on', cmMode === 'photo'); $('cmmv').classList.toggle('on', cmMode === 'video');
  if (!(await cmPerm(cmMode === 'video'))) { if (my === cmN) { cmMsg(cmMode === 'video' ? txf('cam.permMic', 'Izin kamera atau mikrofon ditolak. Aktifkan di pengaturan perangkat.') : txf('cam.perm', 'Izin kamera ditolak. Aktifkan di pengaturan perangkat.')); } return; }
  if (my !== cmN) return;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) { cmMsg(txf('cam.none', 'Kamera tidak tersedia di perangkat ini.')); return; }
  let st;
  try { st = await md.getUserMedia(Camera.constraints(cmMode, cmFacing)); }
  catch (e) {
    try { const c = Camera.constraints(cmMode, cmFacing); st = await md.getUserMedia({ video: true, audio: c.audio }); } // tanpa syarat resolusi/arah: perangkat tanpa kamera belakang dll
    catch (e2) { if (my === cmN) cmMsg(e2 && e2.name === 'NotAllowedError' ? 
      txf('cam.denied', 'Izin kamera ditolak.') : e2 && e2.name === 'NotFoundError' ? txf('cam.notFound', 'Kamera tidak ditemukan.') : txf('cam.openFail', 'Kamera tidak bisa dibuka (mungkin sedang dipakai aplikasi lain).')); return; }
  }
  if (my !== cmN || !cmOn) { for (const t of st.getTracks()) t.stop(); return; }
  cmStream = st;
  const v = $('cmv'); v.srcObject = st; try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (x) {}
  cmMsg('');
}
async function openCamera() {
  if (!$('cam') || cmOn) return;
  if ((S && S.call) || (typeof callCtl !== 'undefined' && callCtl && callCtl.cur)) { toast(txf('cam.inCall', 'Kamera tidak bisa dipakai saat panggilan berlangsung')); return; }
  if (typeof voiceOpen === 'function' && voiceOpen()) return;
  if (typeof playerStop === 'function') playerStop();
  cmOn = true; cmMode = 'photo';
  $('cam').classList.add('on');
  if (!cmPushed) { try { if (window.history) { window.history.pushState({ cam: 1 }, ''); cmPushed = true; } } catch (x) {} }
  const fl = $('cmflip'); if (fl) fl.style.display = (typeof canFlipCam === 'function' && canFlipCam()) ? '' : 'none';
  await cmStart();
}
function cmDone() {
  cmOn = false; cmN++; cmBusy = false;
  cmStopRec(true); cmStopStream(); cmFreeBlob();
  const e = $('cam'); if (e) { e.classList.remove('on'); cmState([]); }
}
function closeCamera() { if (!cmOn) return; if (cmPushed && window.history) { try { window.history.back(); return; } catch (x) {} } cmPushed = false; cmDone(); }
function cameraPop() { cmPushed = false; cmDone(); } // dari popstate (js/archne-render.js)
function cmFrame(video) { // satu bingkai dari <video> ke canvas kecil untuk thumbnail
  const w = video.videoWidth, h = video.videoHeight;
  if (!(w > 0 && h > 0)) return null;
  const d = Media.fitDims(w, h, 320), cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
  cv.getContext('2d').drawImage(video, 0, 0, d.w, d.h);
  return { cv, w, h };
}
function cmShoot() {
  const v = $('cmv');
  const d = Camera.photoDims(v.videoWidth, v.videoHeight);
  if (!d) { cmMsg(txf('cam.notReady', 'Kamera belum siap.')); return; }
  const cv = $('cmc'); cv.width = d.w; cv.height = d.h;
  cv.getContext('2d').drawImage(v, 0, 0, d.w, d.h);
  const my = cmN;
  cv.toBlob((b) => {
    if (my !== cmN || !cmOn) return;
    if (!b) { cmMsg(txf('cam.shotFail', 'Gagal mengambil foto.')); return; }
    cmBlob = b; cmMime = 'image/jpeg'; cmDims = { w: d.w, h: d.h };
    cmStopStream(); cmState(['shot']);
  }, 'image/jpeg', Camera.PHOTO_Q);
}
function cmRecord() {
  if (cmRec) { cmFinish(); return; }
  const mt = Camera.pickRecMime((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
  if (!mt || !cmStream) { cmMsg(txf('cam.recUnsupported', 'Perekaman video tidak didukung di perangkat ini.')); return; }
  let r;
  try { r = new MediaRecorder(cmStream, { mimeType: mt.mime, videoBitsPerSecond: Camera.BITS.video, audioBitsPerSecond: Camera.BITS.audio }); }
  catch (e) { cmMsg(txf('cam.recStartFail', 'Perekaman video tidak bisa dimulai.')); return; }
  cmChunks = []; cmBytes = 0; cmMime = mt;
  r.ondataavailable = (e) => { if (e.data && e.data.size) { cmChunks.push(e.data); cmBytes += e.data.size; } };
  r.onerror = () => { cmMsg(txf('cam.recFail', 'Perekaman gagal.')); cmStopRec(true); cmState(['live', 'vid']); };
  r.start(1000); cmRec = r; cmT0 = Date.now();
  cmState(['live', 'vid', 'rec']); $('cmrec').textContent = '● 0:00';
  setTimeout(() => { const f = cmRec === r && cmStream ? cmFrame($('cmv')) : null; if (f) cmThumb = f; }, 500); // bingkai awal sebagai thumbnail
  cmTick = setInterval(() => {
    const ms = Date.now() - cmT0;
    $('cmrec').textContent = '● ' + Camera.fmtClock(ms);
    if (Camera.shouldStop(ms, cmBytes)) cmFinish();
  }, 250);
}
function cmFinish() {
  const r = cmRec; if (!r) return;
  clearInterval(cmTick); cmTick = 0;
  const ms = Date.now() - cmT0, my = cmN, mt = cmMime;
  if (!cmThumb) cmThumb = cmFrame($('cmv'));
  r.onstop = () => {
    if (my !== cmN || !cmOn) return;
    cmRec = null;
    const b = new Blob(cmChunks, { type: mt.mime.split(';')[0] }); cmChunks = [];
    if (!b.size) { cmMsg(txf('cam.recEmpty', 'Rekaman kosong.')); cmState(['live', 'vid']); return; }
    cmBlob = b; cmDur = ms; cmDims = cmThumb ? { w: cmThumb.w, h: cmThumb.h } : null;
    cmStopStream();
    cmUrl = URL.createObjectURL(b);
    const rv = $('cmr'); rv.src = cmUrl; cmState(['vrev']);
  };
  try { if (r.state !== 'inactive') r.stop(); else r.onstop(); } catch (x) { r.onstop(); }
}
async function cmSend() {
  if (cmBusy || !cmBlob) return;
  cmBusy = true;
  const to = cur, isImg = cmMode === 'photo', kind = isImg ? 'img' : 'vid';
  try {
    const u8 = new Uint8Array(await cmBlob.arrayBuffer());
    const ext = isImg ? 'jpg' : cmMime.ext;
    if (!Camera.looksRight(kind, ext, u8)) { toast(txf('cam.invalid', 'Hasil kamera tidak valid. Coba ambil ulang.')); cmBusy = false; return; }
    const name = Camera.shotName(kind, new Date(), ext);
    const th = isImg ? Media.thumbFrom($('cmc'), cmDims.w, cmDims.h, to) : (cmThumb ? Media.thumbFrom(cmThumb.cv, cmThumb.w, cmThumb.h, to) : null);
    const media = Camera.buildX(kind, { w: cmDims && cmDims.w, h: cmDims && cmDims.h, d: isImg ? undefined : cmDur, th: th || undefined });
    let src;
    if (typeof window.api.captureSave === 'function') { // Electron: simpan byte lalu kirim lewat path
      const r = await window.api.captureSave(name, u8);
      if (!r || !r.ok) { toast((r && r.err) || txf('cam.saveFail', 'Gagal menyimpan hasil kamera')); cmBusy = false; return; }
      src = r.path;
    } else src = new File([cmBlob], name, { type: cmBlob.type }); // Android/peramban: File diunggah api-http
    closeCamera();
    const job = 'j' + Date.now().toString(36) + (jobN++);
    window.api.sendFile(job, src, to, media).then(async (r) => {
      await refresh();
      if (!r.ok && r.code !== 'abort' && !(S.sending || []).some((j) => j.job === job)) toast(r.err || txf('cam.sendFail', 'Gagal mengirim'));
    });
    await refresh();
  } catch (e) { toast(txf('cam.sendResultFail', 'Gagal mengirim hasil kamera')); cmBusy = false; }
}
if ($('cam')) {
  $('cambtn').onclick = () => { openCamera(); };
  $('cmx').onclick = closeCamera;
  $('cmmp').onclick = () => { if (cmRec || cmMode === 'photo') return; cmMode = 'photo'; cmStart(); };
  $('cmmv').onclick = () => { if (cmRec || cmMode === 'video') return; cmMode = 'video'; cmStart(); };
  $('cmflip').onclick = () => { if (cmRec) return; cmFacing = cmFacing === 'user' ? 'environment' : 'user'; cmStart(); };
  $('cmshot').onclick = () => { if (!cmStream) return; if (cmMode === 'photo') cmShoot(); else cmRecord(); };
  $('cmredo').onclick = () => { cmStart(); };
  $('cmsend').onclick = cmSend;
  if (document.addEventListener) document.addEventListener('keydown', (e) => { if (cmOn && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCamera(); } }, true);
}
