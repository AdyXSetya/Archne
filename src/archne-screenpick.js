'use strict';
// Pemilih sumber berbagi layar (v0.32.0 Fase C.1-C.2). Dipisah dari main.js supaya bisa dites tanpa Electron.
//
// Alur: renderer memanggil navigator.mediaDevices.getDisplayMedia -> Electron memanggil handler() di sini ->
//   1. hanya halaman Archne sendiri yang dilayani (frame.url harus di dalam renderer/), selain itu ditolak;
//   2. daftar layar + jendela diambil lewat desktopCapturer.getSources (jendela Archne sendiri dikeluarkan dari daftar);
//   3. daftar (id, nama, thumbnail) dikirim ke renderer ('screenpick') untuk ditampilkan sebagai dialog;
//   4. pengguna HARUS memilih; renderer menjawab lewat choose(rid, id). Tidak ada berbagi otomatis;
//   5. id yang dijawab harus salah satu id dari daftar yang baru dikirim, kalau tidak ditolak.
// Batal, waktu habis (60 dtk), jendela ditutup, atau permintaan kedua saat satu masih terbuka = ditolak (getDisplayMedia gagal NotAllowedError/NotSupportedError).
// Audio sistem (C.6, mengubah D5): hanya Windows (loopback), hanya bila renderer memintanya (audioRequested) DAN pengguna mencentang
// "Bagikan audio sistem" di dialog (mati secara bawaan). Tanpa keduanya `audio` tidak pernah dikembalikan. Jawaban renderer hanya boleh
// berupa boolean; nilai yang dikembalikan ke Electron selalu literal 'loopback', tidak pernah berasal dari renderer.
const { isAppUrl } = require('./archne-permissions');

const TIMEOUT_MS = 60000;
const THUMB = { width: 320, height: 200 };
const NAME_MAX = 120;

function createScreenPicker(deps) {
  const { desktopCapturer, getWindow, rendererDir } = deps;
  const audioCapable = (deps.platform || process.platform) === 'win32'; // loopback sistem hanya andal di Windows
  const send = deps.send || (() => {});
  const log = deps.log || (() => {});
  const timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : TIMEOUT_MS;
  let pending = null; // { rid, sources: Map(id -> source), callback, timer }
  let seq = 0;

  const deny = (callback) => { try { callback({}); } catch { try { callback(); } catch {} } };

  function finish(p, result) { // satu-satunya pintu keluar permintaan: pasti dijawab tepat satu kali
    if (!p || p.done) return;
    p.done = true;
    clearTimeout(p.timer);
    if (pending === p) pending = null;
    if (result) { try { p.callback(p.wantAudio && audioCapable ? { video: result, audio: 'loopback' } : { video: result }); } catch (e) { log('screenpick: callback gagal ' + e.message); } } else deny(p.callback);
  }

  // Dipasang ke session.setDisplayMediaRequestHandler. request: { frame, videoRequested, audioRequested, ... }
  async function handler(request, callback) {
    const win = getWindow && getWindow();
    const url = request && request.frame && request.frame.url;
    if (!win || (win.isDestroyed && win.isDestroyed())) return deny(callback);
    if (!isAppUrl(url, rendererDir)) { log('screenpick: permintaan dari halaman selain Archne ditolak'); return deny(callback); }
    if (!request.videoRequested) return deny(callback); // harus meminta video; audio saja tidak dilayani
    if (pending) { log('screenpick: ada pemilih yang masih terbuka; permintaan kedua ditolak'); return deny(callback); }
    const p = { rid: 'sp' + (++seq) + '-' + Date.now().toString(36), sources: new Map(), callback, timer: null, done: false, canAudio: !!request.audioRequested && audioCapable, wantAudio: false };
    pending = p; // dipasang sebelum await pertama supaya dua permintaan beruntun tidak lolos keduanya
    let list;
    try {
      const own = typeof win.getMediaSourceId === 'function' ? win.getMediaSourceId() : '';
      const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: THUMB, fetchWindowIcons: false });
      if (p.done) return; // dibatalkan (dispose) saat menunggu daftar
      list = [];
      for (const s of srcs || []) {
        if (!s || typeof s.id !== 'string' || !s.id) continue;
        if (own && s.id === own) continue; // jendela Archne sendiri tidak boleh dibagikan (cermin tak berujung)
        const type = s.id.indexOf('screen:') === 0 ? 'screen' : 'window';
        let thumb = '';
        try { if (s.thumbnail && !s.thumbnail.isEmpty()) thumb = 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(70).toString('base64'); } catch {}
        p.sources.set(s.id, s);
        list.push({ id: s.id, type, name: String(s.name || '').slice(0, NAME_MAX), thumb });
      }
    } catch (e) { log('screenpick: getSources gagal ' + e.message); return finish(p, null); }
    if (!list.length) return finish(p, null);
    if (win.isDestroyed && win.isDestroyed()) return finish(p, null);
    p.timer = setTimeout(() => { log('screenpick: waktu habis'); finish(p, null); send('screenpick', { rid: p.rid, cancel: true }); }, timeoutMs);
    if (p.timer.unref) p.timer.unref();
    send('screenpick', { rid: p.rid, items: list, audio: p.canAudio });
  }

  // Jawaban renderer. id kosong/null = batal. id yang tidak ada di daftar ditolak (renderer tidak bisa mengarang sumber).
  // audio: kotak "Bagikan audio sistem"; hanya `true` (boolean persis) yang dihitung, dan hanya bila pemilih menawarkannya (canAudio).
  // Audio sistem hanya ikut untuk layar penuh: loopback merekam seluruh perangkat, jadi untuk satu jendela tidak ditawarkan (seperti Meet).
  function choose(rid, id, audio) {
    const p = pending;
    if (!p || p.done || typeof rid !== 'string' || rid !== p.rid) return { ok: false };
    const src = typeof id === 'string' ? p.sources.get(id) : null;
    p.wantAudio = !!(src && audio === true && p.canAudio && String(src.id).indexOf('screen:') === 0);
    finish(p, src || null);
    return src ? { ok: true, audio: p.wantAudio } : { ok: false };
  }

  function dispose() { if (pending) finish(pending, null); }

  return { handler, choose, dispose, isPending: () => !!pending };
}

module.exports = { createScreenPicker, TIMEOUT_MS };
