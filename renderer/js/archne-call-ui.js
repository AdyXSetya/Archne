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
        el.className = key === 'me' && v.facing !== 'environment' ? 'mirror' : ''; // pratinjau kamera depan dicerminkan, kamera belakang tidak
        if (el.parentNode !== t) t.insertBefore(el, t.firstChild);
        t.classList.add('hasv');
        const p = el.play(); if (p && p.catch) p.catch(() => {});
      }
    }
  } catch (x) {}
  for (const [k, el] of [...vidEls]) if (!seen.has(k)) { try { el.pause(); el.srcObject = null; if (el.parentNode) el.parentNode.removeChild(el); } catch (x) {} vidEls.delete(k); }
}
// </mountVideos>
// Balik kamera hanya ditawarkan di perangkat sentuh (HP/tablet, termasuk cangkang Android): di desktop biasanya satu webcam, jadi tombolnya tidak berguna.
function canFlipCam() { try { return !!(nbridge || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)); } catch (x) { return false; } }
let callCtl = null, ringer = null, nbridge = null, callPick = false, callMin = false, vidFocus = null, callWasBusy = false; // callPick: lembar "Tambah orang" sedang terbuka; callMin: layar panggilan dikecilkan jadi bar
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
        if (!LC.videoView(v)) vidFocus = null; // kartu yang diperbesar hanya berlaku selama tampilan video
        const ovHtml = LC.overlayHtml(v, { minimized: mini, focus: vidFocus, esc, avatar: (id) => avHtml(id), icons: IC, here: v && v.vc ? vcHere(v.vc) : null, meId: S && S.me ? S.me.id : '', speaker: !!(nbridge && nbridge.audio), flip: canFlipCam(), picker: callPick && v ? LC.inviteCandidates(S.peers, v, blockedIds()) : null });
        // Tampilan video: HTML hanya dipasang bila berubah, supaya elemen video tidak dicopot dan dipasang ulang tanpa perlu.
        const vv = LC.videoView(v);
        if (!vv || ovHtml !== ovLast) $('callov').innerHTML = ovHtml;
        ovLast = vv ? ovHtml : null;
        mountVideos(v);
        $('callov').className = mini ? 'mini' : '';
        $('callov').style.display = v ? 'flex' : 'none';
        const b = bodyCl(); if (b) { v && !mini ? b.add('incall') : b.remove('incall'); mini ? b.add('callmin') : b.remove('callmin'); }
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
    document.addEventListener('visibilitychange', () => callCtl.appHidden(document.visibilityState === 'hidden'));
  }
  const callRerender = () => { if (callCtl && callCtl.cur) callCtl._render(); };
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
    if (a === 'min') { callMin = true; callPick = false; callRerender(); return; }
    if (a === 'max') { callMin = false; callRerender(); return; }
    if (a === 'focus') { vidFocus = b.dataset.vfocus || null; callRerender(); return; }
    if (a === 'unfocus') { vidFocus = null; callRerender(); return; }
    if (a === 'accept') callCtl.accept(); else if (a === 'reject') callCtl.reject(); else if (a === 'hang') callCtl.hangup(); else if (a === 'mute') callCtl.mute(); else if (a === 'deafen') callCtl.deafen(); else if (a === 'speaker') callCtl.speaker(); else if (a === 'cam') callCtl.camera(); else if (a === 'flip') callCtl.flipCamera();
    else if (a === 'add') {
      const v = callCtl.view();
      if (v && LC.roomCount(v) >= LC.CALL_MAX_PEERS) return toast(txf('call.full', 'Panggilan sudah penuh (maksimal {max} peserta)', { max: LC.CALL_MAX_PEERS }));
      callPick = true; callRerender();
    } else if (a === 'addclose') { callPick = false; callRerender(); }
  };
  $('callov').addEventListener('keydown', (e) => { // bar kecil bisa dibuka dengan Enter / Spasi
    const t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('cmb')) { e.preventDefault(); callMin = false; callRerender(); }
    if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('cvt') && t.dataset && t.dataset.vfocus) { e.preventDefault(); vidFocus = t.dataset.vfocus; callRerender(); } // kartu video diperbesar dengan papan ketik
  });
  setInterval(() => { const el = $('calltime'); if (el && callCtl.cur && callCtl.cur.phase === 'active') el.textContent = LC.fmtDur(callCtl.elapsed()); }, 1000);
}
refresh();
