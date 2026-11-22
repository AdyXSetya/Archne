'use strict';
// Jembatan `window.api` versi HTTP (v0.10.0): dipakai bila halaman dibuka lewat server (Android WebView, peramban, Termux).
// Di Electron, preload.js sudah mendefinisikan window.api dan berkas ini tidak berbuat apa-apa.
// Kontrak nama dan argumen harus sama dengan preload.js (dijaga oleh test/ui.js).
(function () {
  if (typeof window === 'undefined' || window.api) return;

  // Bila dibuka lewat /s/<token>/ (Android), semua permintaan harus memakai awalan itu; selain itu, akar biasa (cookie).
  // i18n (D4): galat yang tampil di UI. Tanpa I18N teks Indonesia cadangan dipakai.
  const tr = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb));
  const BASE = (typeof location !== 'undefined' && location && /^\/s\/[0-9a-f]+\//.exec(location.pathname || '') || ['/'])[0];

  const NAMES = ['state', 'send', 'setName', 'createGroup', 'addMembers', 'removeMember', 'renameGroup', 'setGroupAvatar', 'setGroupAdmin', 'leaveGroup',
    'transferOwner', 'disbandGroup', 'clearChat', 'deleteMessage', 'addPeer', 'addPeers', 'setBio', 'setAvatar', 'addFriend', 'blockUser',
    'unblockUser', 'removeFriend', 'cancelSend', 'dismissSend', 'receiveFile', 'cancelReceive', 'discardIncoming', 'showFile', 'openFile',
    'openDownloads', 'mediaPrep', 'mediaRead', 'mediaPlay', 'mediaStream', 'setNotify', 'callStart', 'callAnswer', 'callIce', 'callConnected', 'callReject', 'callEnd', 'callInvite', 'callInviteAccept', 'callInviteDecline', 'callLeg', 'callLeave', 'callMedia', 'clearCalls',
    'vcList', 'vcCreate', 'vcDelete', 'vcUpdate', 'vcEnter', 'vcLeave',
    'pvList', 'pvCreate', 'pvDelete', 'pvUpdate', 'pvEnter', 'pvLeave',
    'pinList', 'pinAdd', 'pinNote', 'pinEdit', 'pinRemove',
    'react', 'reactWho', 'reactRecent', 'rxSupport',
    'getSettings', 'setSettings',
    'pgAvail', 'pgList', 'pgGet', 'pgImage', 'pgVideo', 'pgReact', 'pgComment', 'pgComments', 'pgCmtReact', 'pgCommentQueue', 'pgCommentPending', 'pgCommentCancel', 'pgCmtRemove', 'pgCmtDelete', 'pgFileGet', 'pgFileCancel', 'pgMine', 'pgCreate', 'pgSetDl', 'pgRemove', 'pgNewList', 'pgArcExport', 'pgArcOpen', 'pgArcImport', 'pgArcCancel', 'pgArcState',
    'dxState', 'dxPick', 'dxSend', 'dxCancelScan', 'dxAccept', 'dxDecline', 'dxPause', 'dxResume', 'dxCancel', 'dxCancelOut', 'dxRemove', 'dxChooseDir', 'dxOpenDir',
    'wanSettings', 'wanEnable', 'wanBroker', 'wanRotate', 'inviteMake', 'invitePeek', 'inviteApply', 'turnInfo', 'turnSet', 'turnClear', 'turnIce', 'wanInfo', 'wanNewCode', 'wanSetCode', 'wanClear', 'wanTopics', 'wanSeal', 'wanOpen', 'rtcIn', 'rtcStatus', 'wsOpen', 'wsSend', 'wsClose'];

  // Tindakan bawaan perangkat (buka berkas) diteruskan ke cangkang (halaman induk Android) lewat postMessage.
  function native(n) {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ archne: 'native', action: n.action, path: n.path, name: n.name }, '*'); } catch {}
  }

  async function rpc(name, args) {
    let r;
    try {
      r = await fetch(BASE + 'rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    } catch (e) { return { ok: false, err: tr('api.noCore', 'Tidak tersambung ke inti aplikasi') }; }
    if (!r.ok) return { ok: false, err: tr('api.httpErr', 'Galat {code}', { code: r.status }) };
    const j = await r.json();
    if (j && typeof j === 'object' && j.native) { native(j.native); delete j.native; }
    return j;
  }

  const api = {};
  for (const n of NAMES) api[n] = (...a) => rpc(n, a);

  // Pemilih berkas: mengembalikan objek File (bukan path). Pada Android tidak ada path; berkas diunggah ke inti lewat sendFile.
  api.pickFiles = () => new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.style.display = 'none';
    inp.onchange = () => { const fs = Array.from(inp.files || []); inp.remove(); resolve(fs); };
    inp.addEventListener('cancel', () => { inp.remove(); resolve([]); });
    document.body.appendChild(inp);
    inp.click();
  });
  api.pathOf = (file) => file || ''; // "sumber berkas": File itu sendiri
  api.captureSave = undefined; // hanya Electron (hasil kamera disimpan lewat path). Di sini hasil kamera dikirim sebagai File lewat sendFile/upload; UI memeriksa typeof === 'function'.

  api.sendFile = async (job, src, to, media) => {
    if (typeof src === 'string') return rpc('sendFile', [job, src, to, media]);
    if (!src || typeof src.size !== 'number') return { ok: false, err: tr('api.badFile', 'Berkas tidak valid') };
    let up;
    try {
      const r = await fetch(BASE + 'upload?name=' + encodeURIComponent(src.name || 'berkas'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: src });
      if (!r.ok) throw new Error('Galat ' + r.status);
      up = await r.json();
    } catch (e) { return { ok: false, err: tr('api.prepFile', 'Gagal menyiapkan berkas: {m}', { m: (e && e.message) || e }) }; }
    return rpc('sendFile', [job, up.path, to, media]);
  };

  // Pesan suara (Step 4): sama dengan sendFile, tetapi lewat jalur sendiri. Hasil rekaman di Android/peramban berupa File yang diunggah dulu.
  api.sendVoice = async (job, src, to, durMs) => {
    if (typeof src === 'string') return rpc('sendVoice', [job, src, to, durMs]);
    if (!src || typeof src.size !== 'number') return { ok: false, err: tr('api.badRec', 'Rekaman tidak valid') };
    let up;
    try {
      const r = await fetch(BASE + 'upload?name=' + encodeURIComponent(src.name || 'suara'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: src });
      if (!r.ok) throw new Error('Galat ' + r.status);
      up = await r.json();
    } catch (e) { return { ok: false, err: tr('api.prepRec', 'Gagal menyiapkan rekaman: {m}', { m: (e && e.message) || e }) }; }
    return rpc('sendVoice', [job, up.path, to, durMs]);
  };

  // Kirim Langsung dari HP: salin satu berkas ke cache aplikasi (dihapus inti saat transfer berakhir). Hasil { ok, path } atau { ok:false, code:'abort'|'full'|..., err }.
  api.dxUpload = async (job, file, signal) => {
    if (!file || typeof file.size !== 'number') return { ok: false, err: tr('api.badFile', 'Berkas tidak valid') };
    try {
      const r = await fetch(BASE + 'dxupload?job=' + encodeURIComponent(job) + '&name=' + encodeURIComponent(file.name || 'berkas'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, signal });
      if (r.status === 507) return { ok: false, code: 'full', err: tr('api.storageFull', 'Penyimpanan HP penuh') };
      if (!r.ok) return { ok: false, err: tr('api.httpErr', 'Galat {code}', { code: r.status }) };
      const j = await r.json();
      return j && typeof j.path === 'string' ? { ok: true, path: j.path } : { ok: false, err: tr('api.badReply', 'Jawaban tidak valid') };
    } catch (e) { return e && e.name === 'AbortError' ? { ok: false, code: 'abort', err: tr('arc.stCancelled', 'Dibatalkan') } : { ok: false, err: tr('api.copyFail', 'Gagal menyalin berkas: {m}', { m: (e && e.message) || e }) }; }
  };

  // Event: satu EventSource untuk semuanya. Saat tersambung ulang, minta UI menyegarkan diri.
  const L = { update: [], removed: [], fprog: [], dxprog: [], pgdl: [], pgcq: [], pgnew: [], pgact: [], pgarc: [], dxscan: [], call: [], vcpres: [], pvpres: [], pvkick: [], rtcb: [] };
  let es = null, was = false;
  function connect() {
    if (es) return;
    es = new EventSource(BASE + 'events');
    const fire = (k, p) => L[k].forEach((cb) => { try { cb(p); } catch (e) { console.log('listener ' + k + ': ' + (e && e.message)); } });
    es.addEventListener('update', () => fire('update'));
    es.addEventListener('removed', (e) => fire('removed', JSON.parse(e.data)));
    es.addEventListener('fprog', (e) => fire('fprog', JSON.parse(e.data)));
    es.addEventListener('dxprog', (e) => fire('dxprog', JSON.parse(e.data)));
    es.addEventListener('pgdl', (e) => fire('pgdl', JSON.parse(e.data)));
    es.addEventListener('pgcq', (e) => fire('pgcq', JSON.parse(e.data)));
    es.addEventListener('pgnew', (e) => fire('pgnew', JSON.parse(e.data)));
    es.addEventListener('pgact', (e) => fire('pgact', JSON.parse(e.data)));
    es.addEventListener('pgarc', (e) => fire('pgarc', JSON.parse(e.data)));
    es.addEventListener('dxscan', (e) => fire('dxscan', JSON.parse(e.data)));
    es.addEventListener('call', (e) => fire('call', JSON.parse(e.data)));
    es.addEventListener('vcpres', (e) => fire('vcpres', JSON.parse(e.data)));
    es.addEventListener('pvpres', (e) => fire('pvpres', JSON.parse(e.data)));
    es.addEventListener('pvkick', (e) => fire('pvkick', JSON.parse(e.data)));
    es.addEventListener('rtcb', (e) => fire('rtcb', JSON.parse(e.data)));
    es.onopen = () => { if (was) { fire('update'); fire('rtcb', { op: 'reconnect' }); } was = true; }; // SSE putus-sambung: event yang lewat hilang, jembatan lintas jaringan harus mulai ulang (rtcglue)
  }
  api.onUpdate = (cb) => { L.update.push(cb); connect(); };
  api.onRemoved = (cb) => { L.removed.push(cb); connect(); };
  api.onProgress = (cb) => { L.fprog.push(cb); connect(); };
  api.onDxProg = (cb) => { L.dxprog.push(cb); connect(); };
  api.onPgDl = (cb) => { L.pgdl.push(cb); connect(); };
  api.onPgCq = (cb) => { L.pgcq.push(cb); connect(); };
  api.onPgNew = (cb) => { L.pgnew.push(cb); connect(); };
  api.onPgAct = (cb) => { L.pgact.push(cb); connect(); };
  api.onPgArc = (cb) => { L.pgarc.push(cb); connect(); };
  api.onDxScan = (cb) => { L.dxscan.push(cb); connect(); };
  api.onCall = (cb) => { L.call.push(cb); connect(); };
  api.onVcPres = (cb) => { L.vcpres.push(cb); connect(); };
  api.onPvPres = (cb) => { L.pvpres.push(cb); connect(); };
  api.onPvKick = (cb) => { L.pvkick.push(cb); connect(); };
  api.onRtcb = (cb) => { L.rtcb.push(cb); connect(); };
  // Peramban dalam aplikasi (v0.25.1): hanya Electron. Sengaja undefined (bukan RPC): renderer memeriksa typeof === 'function'
  // dan, bila tidak ada, meneruskan tautan ke cangkang Android (InAppBrowser) atau membuka tab baru.
  api.webOpen = api.webNav = api.webBounds = api.webClose = api.webExternal = api.onWebState = undefined;
  api.onScreenPick = api.screenPickDone = undefined; // pemilih layar Archne hanya di Electron (v0.32.0 C.2); peramban memakai pemilih bawaannya lewat getDisplayMedia
  api.onWs = () => {}; // jalur WebSocket cadangan hanya ada di Electron (proses utama); di HTTP tidak ada kejadian ws

  // Halaman (2a-6, banyak gambar di 2c, video di 3c-6 lewat opts.videos): gambar postingan di Android/peramban berupa File. Tiap File diunggah dulu ke <dataDir>/shared (sama dengan sendFile), berurutan
  // supaya tidak menumpuk bandwidth dan memori HP; lalu pgCreate menyalin semuanya ke penyimpanan halaman. images = [{ src: path (string) | File, th? }]; yang string diteruskan apa adanya.
  // Satu unggahan gagal = berhenti (pgCreate tidak dipanggil). Sisa unggahan sebelumnya dibersihkan Core di sapuan <dataDir>/shared saat mulai.
  api.pgCreate = async (text, priv, images, files, opts) => {
    const KIND = {
      Gambar: { def: 'gambar', bad: () => tr('api.badImg', 'Gambar tidak valid'), prep: (m) => tr('api.prepImg', 'Gagal menyiapkan gambar: {m}', { m }) },
      Berkas: { def: 'berkas', bad: () => tr('api.badFile', 'Berkas tidak valid'), prep: (m) => tr('api.prepFile', 'Gagal menyiapkan berkas: {m}', { m }) },
      Video: { def: 'video', bad: () => tr('api.badVideo', 'Video tidak valid'), prep: (m) => tr('api.prepVideo', 'Gagal menyiapkan video: {m}', { m }) },
    }; // kunci = label internal (bukan teks tampil); def = nama berkas bawaan
    const up = async (list, what) => { // list = [{ src: path | File, th? }] -> [{ src: path, th? }] atau { ok:false }
      const out = [];
      for (const it of Array.isArray(list) ? list : []) {
        const s = it && it.src;
        if (typeof s === 'string') { out.push({ src: s, th: it.th }); continue; }
        if (!s || typeof s.size !== 'number') return { ok: false, err: KIND[what].bad() };
        try {
          const r = await fetch(BASE + 'upload?name=' + encodeURIComponent(s.name || KIND[what].def), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: s });
          if (r.status === 507) return { ok: false, code: 'full', err: tr('api.storageFull', 'Penyimpanan HP penuh') };
          if (!r.ok) throw new Error('Galat ' + r.status);
          out.push({ src: (await r.json()).path, th: it.th });
        } catch (e) { return { ok: false, err: KIND[what].prep((e && e.message) || e) }; }
      }
      return { ok: true, out };
    };
    const im = await up(images, 'Gambar'); if (!im.ok) return im;
    const fl = await up(files, 'Berkas'); if (!fl.ok) return fl; // berkas diunggah sesudah gambar; satu gagal = berhenti (pgCreate tidak dipanggil)
    if (opts && typeof opts === 'object' && Array.isArray(opts.videos) && opts.videos.length) { // 3c-6: video diunggah paling akhir (termahal), berurutan, ke shared/ seperti lampiran; yang string diteruskan apa adanya
      const vd = await up(opts.videos, 'Video'); if (!vd.ok) return vd;
      opts = Object.assign({}, opts, { videos: vd.out.map((x) => ({ src: x.src })) });
    }
    const args = [text, priv, im.out]; if (fl.out.length) args.push(fl.out.map((x) => ({ src: x.src }))); // argumen keempat hanya bila ada lampiran: kontrak lama (tiga argumen) tidak berubah
    if (opts != null) { if (args.length < 4) args.push(null); args.push(opts); } // 3b: argumen kelima hanya bila ada opts (4 diisi null bila tanpa lampiran)
    return rpc('pgCreate', args); // th undefined hilang sendiri dari JSON
  };

  window.api = api;
})();
