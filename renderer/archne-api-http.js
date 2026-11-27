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
    'webCronList', 'webCronAdd', 'webCronUpdate', 'webCronRemove', 'webCronRun', 'webCronLog', 'webCronLogClear', 'webCronCheck',
    'webAvail', 'webList', 'webMine', 'webCreate', 'webUpdate', 'webRemove', 'webCheckDomain', 'webPreview',
    'webFiles', 'webFileRead', 'webFileView', 'webFileWrite', 'webMkdir', 'webRename', 'webMove', 'webDelete', 'webZipList', 'webZipExtract', 'webZipExport', 'webAssetScan', 'webOfflineStart', 'webOfflineCancel', 'webOfflineStatus', 'webOfflineDiscard', 'webOfflineApply', 'webOfflineUndoInfo', 'webOfflineUndo', 'webDash', 'webDashPhp', 'webDbList', 'webDbTables', 'webDbRows', 'webDbInsert', 'webDbUpdate', 'webDbDelete', 'webDbExport', 'webDbImport', 'webDbCreate', 'webDbDrop', 'webDbReset', 'webDbExec', 'webDbCsv', 'webDbMysqlChoose', 'webDbMysqlCommit', 'webDbMysqlCancel', 'webDbMysqlExport', 'webDbMysqlExportCancel', 'webDbMysqlCreate', 'webDbMysqlStart', 'webDbMysqlStop',
    'dxState', 'dxPick', 'dxSend', 'dxCancelScan', 'dxAccept', 'dxDecline', 'dxPause', 'dxResume', 'dxCancel', 'dxCancelOut', 'dxRemove', 'dxChooseDir', 'dxOpenDir',
    'wanSettings', 'wanEnable', 'wanBroker', 'wanRotate', 'mailboxSet', 'mailboxRetry', 'inviteMake', 'invitePeek', 'inviteApply', 'turnInfo', 'turnSet', 'turnClear', 'turnIce', 'wanInfo', 'wanNewCode', 'wanSetCode', 'wanClear', 'wanTopics', 'wanSeal', 'wanOpen', 'wanHostView', 'wanHostSignal', 'wanHostAck', 'rtcIn', 'rtcStatus', 'wsOpen', 'wsSend', 'wsClose'];

  // Tindakan bawaan perangkat (buka berkas) diteruskan ke cangkang (halaman induk Android) lewat postMessage.
  function native(n) {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ archne: 'native', action: n.action, path: n.path, name: n.name }, '*'); } catch {}
  }

  // Panggilan singkat yang dipolling UI diberi tenggat: bila inti Node macet / beku (mis. HP menidurkan proses), fetch tidak pernah selesai dan UI
  // menunggu selamanya ("Memuat..." sampai aplikasi dihentikan paksa). Dengan tenggat, panggilan gagal, kunci di UI terlepas, dan polling berikutnya
  // otomatis mencoba lagi begitu inti hidup kembali. Panggilan lain (unduh, unggah, tugas panjang) sengaja tanpa tenggat.
  const RPC_MS = { webDash: 15000, webDashPhp: 45000, webCronList: 15000, webCronLog: 15000, webCronCheck: 15000, webAvail: 15000, webList: 20000, webMine: 15000 };
  async function rpc(name, args) {
    let r, timer = null, ctl = null, hit = false;
    const ms = RPC_MS[name];
    if (ms && typeof AbortController === 'function') { ctl = new AbortController(); timer = setTimeout(() => { hit = true; try { ctl.abort(); } catch {} }, ms); }
    try {
      r = await fetch(BASE + 'rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: ctl ? ctl.signal : undefined });
      if (!r.ok) return { ok: false, err: tr('api.httpErr', 'Galat {code}', { code: r.status }) };
      var j = await r.json(); // badan jawaban ikut dalam tenggat
    } catch (e) {
      if (hit) return { ok: false, code: 'timeout', err: tr('api.timeout', 'Inti aplikasi tidak menjawab. Mencoba lagi otomatis.') };
      return { ok: false, err: tr('api.noCore', 'Tidak tersambung ke inti aplikasi') };
    } finally { if (timer) clearTimeout(timer); }
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
  api.appQuit = undefined; api.appReset = undefined; // hanya Electron (Pengaturan > Aplikasi, lewat IPC). Di Android tombolnya memakai pesan ke cangkang; di peramban/Termux tidak ada. UI memeriksa typeof === 'function' (renderer/js/archne-settings-app.js).

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

  // Unggah ke situs Web Lokal (Fase E.3): srcs = jalur (Electron) atau objek File (Android/peramban: diunggah dulu ke inti lewat /upload, lalu jalurnya dikirim).
  api.webUpload = async (id, dir, srcs, o) => {
    if (!Array.isArray(srcs) || !srcs.length) return { ok: false, err: tr('api.badFile', 'Berkas tidak valid') };
    const paths = [];
    for (const src of srcs) {
      if (typeof src === 'string') { paths.push(src); continue; }
      if (!src || typeof src.size !== 'number') return { ok: false, err: tr('api.badFile', 'Berkas tidak valid') };
      try {
        const r = await fetch(BASE + 'upload?keep=1&name=' + encodeURIComponent(src.name || 'berkas'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: src });
        if (!r.ok) throw new Error('Galat ' + r.status);
        paths.push((await r.json()).path);
      } catch (e) { return { ok: false, err: tr('api.prepFile', 'Gagal menyiapkan berkas: {m}', { m: (e && e.message) || e }) }; }
    }
    return rpc('webUpload', [id, dir, paths, o]);
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
  const L = { update: [], removed: [], fprog: [], dxprog: [], pgdl: [], pgcq: [], pgnew: [], pgact: [], pgarc: [], dxscan: [], webprog: [], sitestate: [], webzip: [], weboff: [], webcron: [], webdbprog: [], call: [], vcpres: [], pvpres: [], pvkick: [], rtcb: [], wanst: [], wanpeers: [], wansig: [] };
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
    es.addEventListener('webprog', (e) => fire('webprog', JSON.parse(e.data)));
    es.addEventListener('webzip', (e) => fire('webzip', JSON.parse(e.data)));
    es.addEventListener('weboff', (e) => fire('weboff', JSON.parse(e.data)));
    es.addEventListener('webcron', (e) => fire('webcron', JSON.parse(e.data)));
    es.addEventListener('webdbprog', (e) => fire('webdbprog', JSON.parse(e.data)));
    es.addEventListener('sitestate', (e) => fire('sitestate', JSON.parse(e.data)));
    es.addEventListener('call', (e) => fire('call', JSON.parse(e.data)));
    es.addEventListener('vcpres', (e) => fire('vcpres', JSON.parse(e.data)));
    es.addEventListener('pvpres', (e) => fire('pvpres', JSON.parse(e.data)));
    es.addEventListener('pvkick', (e) => fire('pvkick', JSON.parse(e.data)));
    es.addEventListener('rtcb', (e) => fire('rtcb', JSON.parse(e.data)));
    es.addEventListener('wanst', (e) => fire('wanst', JSON.parse(e.data))); // lintas jaringan di inti Node (2c): status, daftar peer, signal masuk
    es.addEventListener('wanpeers', (e) => fire('wanpeers', JSON.parse(e.data)));
    es.addEventListener('wansig', (e) => fire('wansig', JSON.parse(e.data)));
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
  api.onWebProg = (cb) => { L.webprog.push(cb); connect(); };
  api.onWebZip = (cb) => { L.webzip.push(cb); connect(); };
  api.onWebOff = (cb) => { L.weboff.push(cb); connect(); };
  api.onWebCron = (cb) => { L.webcron.push(cb); connect(); };
  api.onWebDbProg = (cb) => { L.webdbprog.push(cb); connect(); };
  api.onCall = (cb) => { L.call.push(cb); connect(); };
  api.onVcPres = (cb) => { L.vcpres.push(cb); connect(); };
  api.onPvPres = (cb) => { L.pvpres.push(cb); connect(); };
  api.onPvKick = (cb) => { L.pvkick.push(cb); connect(); };
  api.onRtcb = (cb) => { L.rtcb.push(cb); connect(); };
  api.onWanSt = (cb) => { L.wanst.push(cb); connect(); };
  api.onWanPeers = (cb) => { L.wanpeers.push(cb); connect(); };
  api.onWanSig = (cb) => { L.wansig.push(cb); connect(); };
  // Peramban dalam aplikasi (v0.25.1): hanya Electron. Sengaja undefined (bukan RPC): renderer memeriksa typeof === 'function'
  // dan, bila tidak ada, meneruskan tautan ke cangkang Android (InAppBrowser) atau membuka tab baru.
  api.webOpen = api.webNav = api.webBounds = api.webClose = api.webExternal = api.onWebState = undefined;
  // Penampil situs Web Lokal (0.34.0 F.3.3b): sisi server sudah ada (archne-sitesession.js lewat RPC siteOpen/siteNav/siteRefresh/siteBounds/siteClose/siteExternal/siteExtNo + kejadian 'sitestate'),
  // dan penampilnya (iframe + bilah, js/archne-siteviewer.js + js/archne-sitebar.js) sudah ada. Renderer memeriksa typeof api.siteOpen === 'function' untuk memilih bilah.
  // Penjaga ini DIPERTAHANKAN sebagai sakelar: archne-index.html memasang window.ARCHNE_SITE_VIEWER = true SEBELUM berkas ini dimuat (F.3.5d); halaman tanpa penampil tidak memasangnya dan jatuh ke pesan lw.viewerSoon.
  // Balasan siteOpen/siteRefresh memuat `url` (src iframe) dan state-nya memuat `url`; riwayat (kembali / maju / muat ulang) dijalankan iframe, bukan server (siteNav -> code 'client').
  if (window.ARCHNE_SITE_VIEWER === true) {
    for (const n of ['siteOpen', 'siteNav', 'siteRefresh', 'siteBounds', 'siteClose', 'siteExternal', 'siteExtNo', 'siteWarnAck']) api[n] = (...a) => rpc(n, a);
    api.onSiteState = (cb) => { L.sitestate.push(cb); connect(); };
    api.onSiteExt = () => {}; // tautan keluar tidak lewat server di sini (siteExternal selalu "gone")
  } else {
    api.siteOpen = api.siteNav = api.siteRefresh = api.siteBounds = api.siteClose = api.siteExternal = api.siteExtNo = api.siteWarnAck = api.onSiteState = api.onSiteExt = undefined;
  }
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
