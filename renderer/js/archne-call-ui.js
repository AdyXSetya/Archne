// ---- panggilan suara (v0.13.0): audio WebRTC di sini, sinyal lewat fungsi call* di api ----
const LC = window.LanCall;
// Siapa saja yang ada di sebuah channel menurut state terakhir (untuk layar channel): [{ id, name, me }].
function pvCh(cid) { const l = S && S.pv && S.pv.channels; return Array.isArray(l) ? l.find((x) => x.id === cid) : null; }
function vcName(vc) { if (vc.pv) { const c = pvCh(vc.cid); return c ? c.name : ''; } const g = S && S.groups && S.groups.find((x) => x.id === vc.gid), ch = g && (g.channels || []).find((x) => x.id === vc.cid); return ch ? ch.name : ''; }
function vcHere(vc) { if (vc.pv) { const c = pvCh(vc.cid); return c && c.people ? c.people : []; } const g = S && S.groups && S.groups.find((x) => x.id === vc.gid), ch = g && (g.channels || []).find((x) => x.id === vc.cid); return ch && ch.here ? ch.here : []; }
// <mountVideos>
// Elemen <video> menetap di sini (bukan di HTML string overlay). Tiap render, kartu .cvt[data-vkey] diisi elemen milik kuncinya:
// 'me' = kamera sendiri, selain itu id peserta. Video selalu muted: suara lawan diputar terpisah lewat rtc.playRemote.
const vidEls = new Map();
let ovLast = null;
function mountVideos(v) {
  const seen = new Set();
  try {
    const root = $('callov');
    if (v && LC.videoView(v) && callCtl && root && typeof root.querySelectorAll === 'function') {
      for (const t of root.querySelectorAll('.cvt[data-vkey]')) {
        const key = t.dataset.vkey, st = key === 'me' ? callCtl.localVideo() : callCtl.remoteVideo(key);
        seen.add(key);
        if (!st) { // tidak ada video (kamera mati / jalur kosong): avatar saja; elemen video yang masih menempel dilepas supaya tidak menutupi avatar
          t.classList.remove('hasv');
          const e0 = vidEls.get(key);
          if (e0 && e0.parentNode === t) { try { e0.pause(); e0.srcObject = null; t.removeChild(e0); } catch (x) {} vidEls.delete(key); }
          continue;
        }
        let el = vidEls.get(key);
        if (!el) { el = document.createElement('video'); el.muted = true; el.autoplay = true; el.playsInline = true; el.setAttribute('playsinline', ''); vidEls.set(key, el); }
        const rev = key === 'me' ? (v.vrev || 0) : 0; // balik kamera mengganti trek di stream yang sama: pasang ulang agar <video> tidak membeku
        if (el.srcObject !== st || el._rev !== rev) { if (el._rev !== rev) el.srcObject = null; el.srcObject = st; el._rev = rev; }
        el.className = key === 'me' ? (v.scr ? 'scr' : v.facing !== 'environment' ? 'mirror' : '') : (callCtl.remoteScreen(key) ? 'scr' : ''); // pratinjau kamera depan dicerminkan, kamera belakang tidak; layar yang dibagikan (milikku atau lawan) utuh (contain), tidak dipotong
        if (el.parentNode !== t) t.insertBefore(el, t.firstChild);
        t.classList.add('hasv');
        const p = el.play(); if (p && p.catch) p.catch(() => {});
      }
    }
  } catch (x) {}
  for (const [k, el] of [...vidEls]) if (!seen.has(k)) { try { el.pause(); el.srcObject = null; if (el.parentNode) el.parentNode.removeChild(el); } catch (x) {} vidEls.delete(k); }
}
// </mountVideos>
// <pip>
// Jendela Picture-in-Picture memuat SATU kartu video: lawan bicara (1-1; kameranya mati = kameraku), atau yang sedang bicara (grup / channel).
// Kartu lain tetap ada di DOM (supaya <video> tidak dicopot), hanya disembunyikan CSS; kartu terpilih diberi kelas pipsel. LC.pickPip memilih.
let pipSt = null, pipMeter = null, pipTimer = null, pipShown = false;
// Jendela PiP menurut kabar native, atau (cadangan bila kabar tidak sampai) viewport sangat kecil selagi siaga: PiP selalu sempit/pendek, HP biasa tidak.
function pipSmall() { try { return window.innerWidth < 300 || window.innerHeight < 250; } catch (x) { return false; } }
function pipCheck() {
  const on = !!(nbridge && (nbridge.pipOn || (nbridge.pipWant && pipSmall())));
  if (on === pipShown) return;
  pipShown = on;
  if (on && viewerExit() && callCtl && callCtl.cur) callCtl._render(); // jendela kecil tidak cocok dengan layar penuh landscape
  const b = bodyCl(); if (b) on ? b.add('archne-pip') : b.remove('archne-pip');
  on ? pipStart() : pipStop();
}
function pipApply() {
  try {
    const root = $('callov');
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const tiles = [...root.querySelectorAll('.cvt[data-vkey]')];
    if (!pipShown) { for (const t of tiles) t.classList.remove('pipsel'); return; }
    const cands = tiles.filter((t) => t.classList.contains('hasv')).map((t) => t.dataset.vkey);
    let levels = {};
    if (pipMeter && cands.filter((k) => k !== 'me').length > 1) levels = pipMeter.levels(); // hanya bila ada beberapa orang berkamera (1-1 tidak perlu mengukur)
    pipSt = LC.pickPip(cands, levels, pipSt, Date.now());
    const want = pipSt.key || (tiles[0] && tiles[0].dataset.vkey) || null;
    for (const t of tiles) t.classList.toggle('pipsel', t.dataset.vkey === want);
  } catch (x) {}
}
function pipSync() { // dipanggil tiap jeda: pasang pengamat suara untuk kartu berkamera (selain aku, bila ada yang lain)
  try {
    if (!pipMeter || !callCtl) return;
    const map = {};
    const root = $('callov'), tiles = root && root.querySelectorAll ? [...root.querySelectorAll('.cvt.hasv[data-vkey]')] : [];
    for (const t of tiles) { const k = t.dataset.vkey; if (k === 'me') continue; const s = callCtl.remoteAudio(k); if (s) map[k] = s; } // kameraku tidak ikut dipilih bila ada orang lain berkamera
    pipMeter.sync(map);
  } catch (x) {}
}
function pipStart() {
  pipSt = null;
  if (!pipMeter) pipMeter = LC.levelMeter(window.AudioContext || window.webkitAudioContext);
  if (!pipTimer) pipTimer = setInterval(() => { pipSync(); pipApply(); }, 400);
  pipSync(); pipApply();
}
function pipStop() {
  if (pipTimer) { clearInterval(pipTimer); pipTimer = null; }
  if (pipMeter) { pipMeter.stop(); pipMeter = null; }
  pipSt = null; pipApply();
}
// </pip>
// <speaking>
// Siapa yang sedang bicara (gaya Discord): bingkai foto profil dan kartu jadi hijau. Selama panggilan berjalan, suara tiap peserta (dan mikku bila tidak dibisukan)
// diukur lewat levelMeter; elemen bertanda data-vkey (kartu video, 'me' = aku) atau data-peer (baris daftar / avatar besar, id-ku = aku) diberi kelas "speaking".
let spkMeter = null, spkTimer = null, spkOn = new Set();
const SPK_ON = 0.04, SPK_OFF = 0.02; // histeresis supaya bingkai tidak berkedip
function spkApply() {
  try {
    const root = $('callov'); if (!root || typeof root.querySelectorAll !== 'function') return;
    const meId = S && S.me ? S.me.id : '';
    for (const el of root.querySelectorAll('[data-vkey],[data-peer]')) {
      let k = el.dataset.vkey || el.dataset.peer; if (meId && k === meId) k = 'me';
      el.classList.toggle('speaking', spkOn.has(k));
    }
  } catch (x) {}
}
function spkTick() {
  try {
    if (!spkMeter || !callCtl || !callCtl.cur) return;
    const map = {}, a = callCtl.localAudio(); if (a) map.me = a;
    for (const l of callCtl.cur.legs || []) { if (!l || !l.peer || l.state !== 'active') continue; const s = callCtl.remoteAudio(l.peer); if (s) map[l.peer] = s; }
    spkMeter.sync(map);
    const lv = spkMeter.levels(), next = new Set();
    for (const k of Object.keys(lv)) if (lv[k] >= (spkOn.has(k) ? SPK_OFF : SPK_ON)) next.add(k);
    spkOn = next; spkApply();
  } catch (x) {}
}
function spkSet(on) {
  if (on) {
    if (!spkMeter) spkMeter = LC.levelMeter(window.AudioContext || window.webkitAudioContext);
    if (spkMeter && !spkTimer) spkTimer = setInterval(spkTick, 200);
  } else {
    if (spkTimer) { clearInterval(spkTimer); spkTimer = null; }
    if (spkMeter) { spkMeter.stop(); spkMeter = null; }
    spkOn = new Set();
  }
}
// </speaking>
// <back>
// Tombol Kembali perangkat (Android): urutan paling atas dulu. Dialog / lembar (.mbg) ditutup lewat tombol Batal / Tutup-nya sendiri, jadi keadaan UI tetap konsisten.
// Layar panggilan ada di atas dialog (z-index): mode tonton layar penuh ditutup, lembar "Tambah orang" ditutup, kartu yang diperbesar dikecilkan, lalu panggilan dikecilkan jadi bar (seperti WhatsApp).
// Yang tidak ditangani (false): cangkang mundur lewat riwayat (chat -> daftar, penampil gambar) atau menyembunyikan aplikasi bila sudah di dasar.
function backModal() {
  try {
    const vis = (el) => { try { return window.getComputedStyle(el).display !== 'none'; } catch (x) { return false; } };
    const dlg = $('dlg'), all = [...document.querySelectorAll('.mbg')].filter(vis);
    const top = dlg && vis(dlg) ? dlg : all[all.length - 1];
    if (!top) return false;
    const b = top.querySelector('#dlgno,#vcancel,#mclose,[id$="cancel"],[id$="close"],[id$="no"]') || [...top.querySelectorAll('button.sec')].pop();
    if (b) b.click();
    return true; // dialog terbuka: Kembali tidak boleh meninggalkan chat di belakangnya
  } catch (x) { return false; }
}
function uiBack() {
  try {
    const v = callCtl && callCtl.view();
    if (viewKey) { viewerExit(); if (callCtl) callCtl._render(); return true; } // D.1f: layar penuh ditutup lebih dulu, baru urutan lama
    if (v && callPick) { callPick = false; callCtl._render(); return true; }
    if (v && vidFocus && LC.videoView(v)) { vidFocus = null; callBar = true; callCtl._render(); return true; }
    if (v && LC.canMinimize(v) && !callMin) { callMin = true; callPick = false; callCtl._render(); return true; }
  } catch (x) {}
  return backModal();
}
// </back>
// Balik kamera hanya ditawarkan di perangkat sentuh (HP/tablet, termasuk cangkang Android): di desktop biasanya satu webcam, jadi tombolnya tidak berguna.
function canFlipCam() { try { return !!(nbridge || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)); } catch (x) { return false; } }
let callCtl = null, ringer = null, nbridge = null, callPick = false, callMin = false, vidFocus = null, callWasBusy = false, callBar = true; // callBar: tombol layar panggilan tampil (ketuk video yang diperbesar = tutup/buka, seperti WhatsApp); callPick: lembar "Tambah orang" sedang terbuka; callMin: layar panggilan dikecilkan jadi bar
// <viewer>
// Mode tonton layar penuh (D.1, Android): layar yang dibagikan lawan bicara memenuhi layar HP. Native memutar ke landscape (mengikuti sensor) dan menyembunyikan bilah sistem (nbridge.viewer).
// Tidak pernah otomatis (D.1b): pengguna memilihnya lewat tombol "Layar penuh" di kartu layar atau lewat ajakan yang muncul sebentar saat layar mulai dibagikan.
// Keluar: tombol di pojok, tombol Kembali, atau otomatis saat berbagi berhenti / panggilan berakhir / dikecilkan / jendela PiP tampil (D.1e).
let viewKey = null, viewInv = '', viewInvTimer = null, scrSeen = new Set(), vz = { s: 1, x: 0, y: 0 };
function viewZoomApply() { const el = viewKey && vidEls.get(viewKey); if (el) el.style.transform = LC.vzCss(vz); }
function viewZoomReset() { vz = { s: 1, x: 0, y: 0 }; for (const el of vidEls.values()) { try { el.style.transform = ''; } catch (x) {} } }
function viewInvClear() { viewInv = ''; if (viewInvTimer) { clearTimeout(viewInvTimer); viewInvTimer = null; } }
function viewInvite(k) {
  viewInvClear(); viewInv = k;
  viewInvTimer = setTimeout(() => { viewInvTimer = null; if (viewInv === k) { viewInv = ''; if (callCtl && callCtl.cur) callCtl._render(); } }, 12000);
}
function viewerEnter(key) {
  if (!nbridge || !key || viewKey === key) return false;
  viewInvClear(); callPick = false;
  viewKey = key; vidFocus = key; callBar = false; // kartu diperbesar + tombol panggilan disembunyikan; nbridge.viewer mengunci landscape
  viewZoomReset();
  nbridge.viewer(true);
  return true;
}
function viewerExit() {
  if (!viewKey) return false;
  viewKey = null; vidFocus = null; callBar = true;
  viewZoomReset();
  if (nbridge) nbridge.viewer(false);
  return true;
}
// Dipanggil tiap render: ajakan untuk layar yang baru dibagikan, dan keluar otomatis bila syarat mode tonton tidak berlaku lagi.
function viewerSync(v, mini) {
  const keys = v && v.phase === 'active' && Array.isArray(v.legs) ? v.legs.filter((l) => l && l.peer && l.scr === true).map((l) => l.peer) : [];
  for (const k of keys) if (!scrSeen.has(k)) { scrSeen.add(k); if (nbridge && !viewKey && !mini) viewInvite(k); }
  for (const k of [...scrSeen]) if (!keys.includes(k)) { scrSeen.delete(k); if (viewInv === k) viewInvClear(); }
  if (viewKey && (!v || mini || pipShown || !LC.videoView(v) || !keys.includes(viewKey))) viewerExit();
}
// Cubit untuk zoom + geser (D.1c). Titik jari relatif ke tengah kartu; hitungannya di LC.vzGesture. Ketuk dua kali = perbesar di titik itu / kembali ke ukuran asli.
const vgPts = new Map();
let vgStart = null, vgMoved = false, vgLast = 0, vgLastPt = null;
function vgBox() { const root = $('callov'), t = viewKey && root && root.querySelector ? root.querySelector('.cvt.viewer') : null; return t ? { t, r: t.getBoundingClientRect() } : null; }
function vgRel(b, p) { return { x: p.x - (b.r.left + b.r.width / 2), y: p.y - (b.r.top + b.r.height / 2) }; }
function vgBegin(b) { vgStart = { z: vz, pts: [...vgPts.values()].map((p) => vgRel(b, p)) }; }
function vgDown(e) {
  if (!viewKey || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const b = vgBox();
  if (!b || !b.t.contains(e.target) || (e.target.closest && e.target.closest('button'))) return;
  if (!vgPts.size) vgMoved = false;
  vgPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (vgPts.size > 1) vgMoved = true;
  vgBegin(b);
}
function vgMove(e) {
  if (!viewKey || !vgPts.has(e.pointerId)) return;
  const b = vgBox(); if (!b || !vgStart) return;
  vgPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pts = [...vgPts.values()].map((p) => vgRel(b, p));
  if (pts.some((p, i) => vgStart.pts[i] && Math.hypot(p.x - vgStart.pts[i].x, p.y - vgStart.pts[i].y) > 8)) vgMoved = true;
  const nz = LC.vzGesture(vgStart, pts, b.r.width, b.r.height);
  if (nz.s !== vz.s || nz.x !== vz.x || nz.y !== vz.y) { vz = nz; viewZoomApply(); }
}
function vgUp(e) {
  if (!vgPts.has(e.pointerId)) return;
  vgPts.delete(e.pointerId);
  const b = vgBox();
  if (vgPts.size) { if (b) vgBegin(b); return; } // jari tersisa: gestur baru dari keadaan sekarang
  vgStart = null;
  if (!b || vgMoved || e.type !== 'pointerup') { vgLast = 0; return; }
  const now = Date.now(), pt = { x: e.clientX, y: e.clientY };
  if (vgLast && now - vgLast < 320 && vgLastPt && Math.hypot(pt.x - vgLastPt.x, pt.y - vgLastPt.y) < 40) {
    vz = LC.vzDoubleTap(vz, vgRel(b, pt), b.r.width, b.r.height); viewZoomApply(); vgLast = 0;
  } else { vgLast = now; vgLastPt = pt; }
}
// </viewer>
if (LC && LC.supported(window) && window.api.onCall) {
  ringer = LC.makeRinger(window.AudioContext || window.webkitAudioContext);
  nbridge = LC.nativeBridge(window); // di cangkang Android (iframe): izin mikrofon, mode panggilan, speaker lewat halaman induk
  if (nbridge) nbridge.hello();
  callCtl = new LC.Controller({
    api: window.api, rtc: LC.browserRtc(window, nbridge), native: LC.makeNative(nbridge),
    ui: {
      render(v) {
        if (!v || v.phase !== 'active') callPick = false;
        if (!LC.canMinimize(v)) callMin = false; // tidak ada panggilan / sedang berdering: selalu layar penuh
        const mini = !!v && callMin;
        viewerSync(v, mini); // D.1e: keluar otomatis dari layar penuh (berbagi berhenti, panggilan berakhir / dikecilkan) + ajakan layar baru
        if (!LC.videoView(v)) vidFocus = null; // kartu yang diperbesar hanya berlaku selama tampilan video
        const ovHtml = LC.overlayHtml(v, { minimized: mini, focus: vidFocus, esc, avatar: (id) => avHtml(id), icons: IC, here: v && v.vc ? vcHere(v.vc) : null, meId: S && S.me ? S.me.id : '', speaker: !!(nbridge && nbridge.audio), viewer: !!nbridge, viewKey, viewInvite: viewInv, flip: canFlipCam(), picker: callPick && v ? LC.inviteCandidates(S.peers, v, blockedIds()) : null });
        // Tampilan video: HTML hanya dipasang bila berubah, supaya elemen video tidak dicopot dan dipasang ulang tanpa perlu.
        const vv = LC.videoView(v);
        if (!vv || ovHtml !== ovLast) $('callov').innerHTML = ovHtml;
        ovLast = vv ? ovHtml : null;
        const root0 = $('callov');
        mountVideos(v);
        pipApply(); // jendela PiP: kartu terpilih tetap ditandai setelah HTML dirender ulang
        if (!vv) callBar = true; // tanpa tampilan video tombol selalu ada
        const hideBar = !!(vv && !mini && !callBar && root0 && root0.querySelector && root0.querySelector('.cvg.focus')); // tombol hanya bisa disembunyikan selagi satu kartu diperbesar (layar penuh)
        $('callov').className = mini ? 'mini' : hideBar ? 'nobar' : '';
        spkSet(!!v); spkApply();
        $('callov').style.display = v ? 'flex' : 'none';
        const b = bodyCl(); if (b) { v && !mini ? b.add('incall') : b.remove('incall'); mini ? b.add('callmin') : b.remove('callmin'); }
        if (nbridge) { nbridge.pip(!!(vv && !mini && v && v.phase === 'active')); pipCheck(); } // siaga Picture-in-Picture: hanya selagi video tampil, layar penuh, dan panggilan aktif
        if (callWasBusy !== !!v) { callWasBusy = !!v; paintCallBusy(); } // mulai / selesai panggilan: tombol telepon dan Masuk channel ikut berubah
      },
      ring(k) { if (!ringer) return; k ? ringer.start(k) : ringer.stop(); },
      ended(info) { const t = LC.endText(info); if (t) toast(t); },
      notice(t) { toast(t); },
      inviteFailed(info) { toast(LC.inviteFailText(info)); },
      legEnded(info) { const t = LC.legText(info); if (t) toast(t); },
    },
  });
  window.api.onCall((ev) => { if (typeof playerStop === 'function') playerStop(); callCtl.onEvent(ev); });
  // Android (cangkang): aplikasi ke latar belakang / kembali. Datang dari cangkang lewat jembatan dan dari visibilitas halaman sebagai cadangan; aman dipanggil dua kali.
  if (nbridge) {
    nbridge.onApp = (hidden) => callCtl.appHidden(hidden);
    nbridge.onBack = () => uiBack(); // tombol Kembali perangkat
    nbridge.onPip = () => pipCheck(); // jendela kecil: satu kartu video, tanpa tombol
    window.addEventListener('resize', pipCheck); // cadangan bila kabar native tidak sampai
    document.addEventListener('visibilitychange', () => { if (pipShown) return; callCtl.appHidden(document.visibilityState === 'hidden'); }); // di jendela PiP aplikasi masih tampil; saat jendela ditutup, cangkang yang mengabari
  }
  const callRerender = () => { if (callCtl && callCtl.cur) callCtl._render(); };
  { const ov = $('callov'); ov.addEventListener('pointerdown', vgDown); ov.addEventListener('pointermove', vgMove); ov.addEventListener('pointerup', vgUp); ov.addEventListener('pointercancel', vgUp); } // cubit / geser / ketuk dua kali di mode tonton
  window.addEventListener('resize', () => { if (viewKey) { viewZoomReset(); } }); // HP diputar: ukuran kartu berubah, zoom kembali ke 1
  $('callov').onclick = async (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('cpk')) { callPick = false; callRerender(); return; } // ketuk latar gelap = tutup
    const iv = t.closest && t.closest('[data-cinv]');
    if (iv) {
      callPick = false;
      const r = await callCtl.invite(iv.dataset.cinv, iv.dataset.cname);
      callRerender();
      if (r && r.ok === false && r.err) toast(r.err);
      return;
    }
    const nb = e.target.closest && e.target.closest('[data-cnoise]'); if (nb) { callCtl.setNoise(nb.dataset.cnoise); return; }
    const b = e.target.closest && e.target.closest('[data-cact]'); if (!b) return;
    const a = b.dataset.cact;
    if (a === 'viewer') { viewerEnter(b.dataset.vfocus || ''); callRerender(); return; } // tombol "Layar penuh" / ajakan di kartu layar
    if (a === 'unview') { viewerExit(); callRerender(); return; }
    if (a === 'min') { callMin = true; callPick = false; callRerender(); return; }
    if (a === 'max') { callMin = false; callRerender(); return; }
    if (a === 'focus' && viewKey) return; // mode tonton: ketukan hanya untuk gestur (ketuk dua kali = zoom); tombol keluar ada di pojok
    if (a === 'focus') { // ketuk kartu = perbesar dan sembunyikan tombol (layar penuh); ketuk kartu yang sudah diperbesar = tombol tutup/buka
      const k = b.dataset.vfocus || null;
      if (k && vidFocus === k) callBar = !callBar; else { vidFocus = k; callBar = false; }
      callRerender(); return;
    }
    if (a === 'unfocus') { vidFocus = null; callBar = true; viewerExit(); callRerender(); return; }
    if (a === 'accept') callCtl.accept(); else if (a === 'reject') callCtl.reject(); else if (a === 'hang') callCtl.hangup(); else if (a === 'mute') callCtl.mute(); else if (a === 'deafen') callCtl.deafen(); else if (a === 'speaker') callCtl.speaker(); else if (a === 'cam') callCtl.camera(); else if (a === 'flip') callCtl.flipCamera();
    else if (a === 'scr') { const v0 = callCtl.view(); (v0 && v0.scr ? callCtl.stopScreen() : callCtl.startScreen()).catch(() => {}); } // berbagi layar (C.5): pemilihnya dialog dari proses utama (js/archne-screen-picker.js)
    else if (a === 'scrstop') callCtl.stopScreen().catch(() => {});
    else if (a === 'add') {
      const v = callCtl.view();
      if (v && LC.roomCount(v) >= LC.CALL_MAX_PEERS) return toast(txf('call.full', 'Panggilan sudah penuh (maksimal {max} peserta)', { max: LC.CALL_MAX_PEERS }));
      callPick = true; callRerender();
    } else if (a === 'addclose') { callPick = false; callRerender(); }
  };
  $('callov').addEventListener('keydown', (e) => { // bar kecil bisa dibuka dengan Enter / Spasi
    const t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('cmb')) { e.preventDefault(); callMin = false; callRerender(); }
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('cvt') && t.dataset && t.dataset.vfocus) { e.preventDefault(); vidFocus = t.dataset.vfocus; callBar = false; callRerender(); } // kartu video diperbesar dengan papan ketik
  });
  setInterval(() => { const el = $('calltime'); if (el && callCtl.cur && callCtl.cur.phase === 'active') el.textContent = LC.fmtDur(callCtl.elapsed()); }, 1000);
}
refresh();
