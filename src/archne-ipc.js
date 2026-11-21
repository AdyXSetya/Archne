'use strict';
// Jembatan renderer <-> Core (v0.7.0 tahap 5a). Dipisah dari main.js supaya bisa dites tanpa Electron: semua yang menyentuh
// Electron (ipcMain, dialog, shell, jendela) masuk lewat `deps`.
//
// Aturan keamanan:
//  - Renderer tidak pernah mengirim path berkas HASIL UNDUHAN. Ia hanya mengirim id tawaran; path diambil dari catatan `got` milik Core.
//  - Berkas hasil unduhan yang ekstensinya bisa dieksekusi (.exe, .bat, .js, ...) tidak bisa dibuka dari aplikasi, hanya
//    ditampilkan di folder. Berkas dari peer bisa apa saja; mengeksekusinya harus keputusan pengguna di luar aplikasi.
//  - Path berkas yang DIKIRIM harus absolut dan berupa berkas biasa. Isi dan batas ukuran diperiksa Core (Pack).
const fs = require('fs');
const path = require('path');
const { createBridge } = require('./archne-rtcbridge');
const { registerDirect } = require('./archne-ipc-direct');
const { registerPages } = require('./archne-ipc-pages');
const Offer = require('./archne-fileoffer');
const MediaCheck = require('./archne-mediacheck');
const { ek, errText } = require('./core/archne-ecode'); // i18n (E3): galat berkunci diterjemahkan di perbatasan ini
const I18N = require('./core/archne-i18n-node');
const T = I18N.tr; // T('e.kunci', param, 'teks Indonesia cadangan')

const HEX32 = /^[0-9a-f]{32}$/;
const JOB = /^[A-Za-z0-9_-]{1,40}$/;
const PROG_MS = 120; // jarak minimal antar event progres ke renderer
const MAX_JOBS = 50;

const RISKY = new Set([
  '.exe', '.com', '.scr', '.pif', '.msi', '.msp', '.msix', '.appx', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.lnk', '.url', '.scf', '.reg', '.inf', '.cpl', '.dll', '.sys', '.gadget',
  '.apk', '.xapk', '.apks', '.apkm', '.aab', '.dex', // Android: memasang berkas ini = menjalankan kode asing
]);
const isRisky = (name) => RISKY.has(path.extname(String(name || '')).toLowerCase());

const fail = (e) => ({ ok: false, err: errText(e), code: e && e.code }); // errText: terjemahan bila galat berkunci (ek), kalau tidak .message apa adanya

function register(deps) {
  const { ipcMain, core } = deps;
  const log = deps.log || (() => {});
  const toRenderer = (ch, payload) => { try { deps.send && deps.send(ch, payload); } catch {} };
  const jobs = new Map(); // job -> { job, to, name, phase: 'pack' | 'error', done, total, err?, code?, ac }
  const h = (name, fn) => ipcMain.handle(name, (_e, ...a) => { try { return fn(...a); } catch (e) { return fail(e); } });

  // ---- progres (dibatasi supaya renderer tidak dibanjiri) ----
  const lastP = new Map(); // kunci -> waktu terakhir kirim
  function progress(payload, force) {
    const k = payload.job ? 'j:' + payload.job : 'r:' + payload.id, now = Date.now();
    if (!force && now - (lastP.get(k) || 0) < PROG_MS) return;
    lastP.set(k, now);
    if (lastP.size > 200) for (const x of lastP.keys()) { if (x !== k) lastP.delete(x); if (lastP.size <= 100) break; }
    toRenderer('fprog', payload);
  }
  core.on('file', (ev) => {
    // pergantian fase memicu 'update' dari Core (state diambil ulang); di sini hanya angka kemajuan
    progress({ id: ev.id, phase: ev.phase, done: ev.done, total: ev.total }, ev.phase !== 'download' && ev.phase !== 'unpack');
  });

  const sendingList = () => [...jobs.values()].map((j) => ({ job: j.job, to: j.to, name: j.name, phase: j.phase, done: j.done, total: j.total, err: j.err, code: j.code }));

  // ---- state ----
  h('state', () => Object.assign(core.getState(), { sending: sendingList(), downloadDir: core._downloadDir(), canDirect: !!deps.pickItems })); // canDirect: ada pemilih berkas/folder berpath (Electron); Android/headless tidak -> tombol Kirim Langsung disembunyikan

  // ---- pengaturan kuota (v0.22.1, Step 2e): validasi nilai, minimum, dan penyimpanan settings.json dijaga Core (src/core/archne-settings.js) ----
  // getSettings -> { ok, items: { cust|files|pubMsgs: { value, def, min, custom } }, usage }; value = byte atau 'unlimited'.
  // setSettings({ <kunci>: byte | 'unlimited' | null }) -> hasil getSettings, atau { ok:false, code: bad | min | io, key, min? }.
  // v0.24.0: hasil ditambah `direct` ({ dir, def, custom }: folder Kirim Langsung) dari Core, serta canDirect/canPickDir (ada pemilih berkas/folder berpath: Electron saja).
  // 5a-3 (Halaman): getSettings().pages = { serve, def, streams: { max, peer, def:{max,peer}, min:{max,peer}, ceil:{max,peer} } } (max/peer = nilai berlaku: batas stream video per Core / per pemilik).
  // setSettings menerima juga pagesServe (true | false | null) dan pgStreamMax / pgStreamPeer (bilangan bulat | null); galat: bad | min | max (ada `min` / `max`) | io. Validasi ada di Core (satu tempat); lapisan ini dan archne-rpc.js hanya meneruskan, jadi Electron dan HTTP identik.
  // i18n (A2): getSettings().lang = 'en' | 'id'; setSettings({ lang: 'en' | 'id' | null }) (galat bad bila lain). Diteruskan apa adanya, validasi di Core.
  // Catatan HTTP: JSON tidak punya NaN / Infinity (menjadi null = kembali ke bawaan), jadi UI harus memvalidasi angka sebelum mengirim.
  // `directDir` dari renderer HANYA boleh null/'default' (kembali ke bawaan): path tujuan simpan tidak pernah datang dari renderer, hanya dari dialog proses utama (dxChooseDir).
  const settingsOut = (r) => (r && r.ok ? Object.assign(r, { canDirect: !!deps.pickItems, canPickDir: !!deps.pickDir, canArchive: !!(deps.pickSave && deps.pickArc) }) : r);
  h('getSettings', () => settingsOut(core.getSettings()));
  h('setSettings', (patch) => {
    if (patch && typeof patch === 'object' && !Array.isArray(patch) && 'directDir' in patch && patch.directDir !== null && patch.directDir !== 'default') return { ok: false, code: 'bad', key: 'directDir', err: 'Folder tujuan hanya bisa dipilih lewat dialog' };
    return settingsOut(core.setSettings(patch));
  });

  // ---- panggilan suara (v0.13.0): sinyal lewat Core, audio (WebRTC) di UI ----
  // Event 'call' dari Core diteruskan apa adanya ke renderer; keadaan terkini ada di state().call (untuk UI yang terlambat terpasang).
  core.on('call', (ev) => toRenderer('call', ev));
  core.on('pvpres', (ev) => toRenderer('pvpres', ev)); // kehadiran di channel voice publik berubah; daftarnya ada di state().pv
  core.on('pvkick', (ev) => toRenderer('pvkick', ev)); // aku dikeluarkan otomatis dari channel publik: { cid, reason: deleted | locked | pin }
  core.on('vcpres', (ev) => toRenderer('vcpres', ev)); // kehadiran di channel voice berubah; daftar lengkapnya ada di state().groups[].channels
  const CID = /^[0-9a-f]{16}$/;
  const cidOf = (c) => { if (typeof c !== 'string' || !CID.test(c)) throw new Error('id panggilan tidak valid'); return c; };
  h('callStart', (peerId, sdp) => ({ ok: true, cid: core.callStart(peerId, sdp) }));
  h('callAnswer', (cid, sdp) => ({ ok: core.callAnswer(cidOf(cid), sdp) }));
  h('callIce', (cid, data) => ({ ok: core.callIce(cidOf(cid), data) }));
  h('callConnected', (cid) => ({ ok: core.callConnected(cidOf(cid)) }));
  h('callReject', (cid) => ({ ok: core.callReject(cidOf(cid)) }));
  h('callEnd', (cid) => ({ ok: core.callEnd(cidOf(cid)) }));
  // panggilan grup (v0.18.0, Step 2a): undang, jawab undangan, buat kaki ke anggota ruang, keluar dari seluruh ruang. `room` berbentuk sama dengan cid.
  h('callInvite', (cid, peerId, video) => ({ ok: core.callInvite(cidOf(cid), peerId, video === true) }));
  h('callInviteAccept', (room) => ({ ok: core.callInviteAccept(cidOf(room)) }));
  h('callInviteDecline', (room) => ({ ok: core.callInviteDecline(cidOf(room)) }));
  h('callLeg', (room, peerId, sdp) => ({ ok: true, cid: core.callLeg(cidOf(room), peerId, sdp) }));
  h('callMedia', (room, muted, deafened, cam) => { const r = core.callMedia(cidOf(room), muted === true, deafened === true, cam === true || cam === false ? cam : undefined); return r === 'full' ? { ok: false, err: 'cam_full' } : { ok: r === true }; }); // siaran status mik/deafen (4c-2)
  h('callLeave', (room) => ({ ok: core.callLeave(cidOf(room)) }));
  // channel voice grup (v0.19.0, langkah 5). Aturan hak akses dan batas dijaga Core (src/archne-vchan.js); di sini hanya bentuk argumen. Audio memakai jalur kaki yang sama dengan panggilan grup (event 'legneed' -> callLeg).
  const str = (v, what) => { if (typeof v !== 'string' || !v || v.length > 64) throw new Error(what + ' tidak valid'); return v; };
  const allowOf = (v) => { if (v === undefined || v === null) return []; if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string')) throw new Error('Daftar izin tidak valid'); return v; };
  h('vcList', (gid) => ({ ok: true, channels: core.vcList(str(gid, 'Grup')) }));
  h('vcCreate', (gid, name, locked, allow) => ({ ok: true, id: core.vcCreate(str(gid, 'Grup'), typeof name === 'string' ? name : '', locked === true, allowOf(allow)) }));
  h('vcDelete', (gid, cid) => ({ ok: core.vcDelete(str(gid, 'Grup'), str(cid, 'Channel')) }));
  h('vcUpdate', (gid, cid, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Perubahan tidak valid');
    const p = {};
    if (patch.name !== undefined) { if (typeof patch.name !== 'string') throw new Error('Nama tidak valid'); p.name = patch.name; }
    if (patch.locked !== undefined) p.locked = patch.locked === true;
    if (patch.allow !== undefined) p.allow = allowOf(patch.allow);
    return { ok: core.vcUpdate(str(gid, 'Grup'), str(cid, 'Channel'), p) };
  });
  h('vcEnter', (gid, cid) => ({ ok: core.vcEnter(str(gid, 'Grup'), str(cid, 'Channel')) }));
  h('vcLeave', () => ({ ok: core.vcLeave() }));
  // channel voice publik (v0.20.0, pvch5). Aturan (pemilik-saja, batas, PIN) dijaga Core (src/archne-pvch.js); di sini hanya bentuk argumen.
  // PIN: string (Core memeriksa 6 angka). Kosong/null = gratis (buat), tidak diubah (undefined) atau dibuka kuncinya (null) pada pvUpdate.
  const pinOf = (v) => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || v.length > 32) throw new Error('PIN tidak valid'); return v; };
  h('pvList', (empty) => ({ ok: true, channels: core.pvList(empty === true ? { empty: true } : undefined) }));
  h('pvCreate', (name, pin) => ({ ok: true, id: core.pvCreate(typeof name === 'string' ? name : '', pinOf(pin)) }));
  h('pvDelete', (cid) => ({ ok: core.pvDelete(str(cid, 'Channel')) }));
  h('pvUpdate', (cid, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Perubahan tidak valid');
    const p = {};
    if (patch.name !== undefined) { if (typeof patch.name !== 'string') throw new Error('Nama tidak valid'); p.name = patch.name; }
    if (patch.pin !== undefined) p.pin = pinOf(patch.pin);
    return { ok: core.pvUpdate(str(cid, 'Channel'), p) };
  });
  h('pvEnter', (cid, pin) => ({ ok: core.pvEnter(str(cid, 'Channel'), pinOf(pin) || undefined) }));
  h('pvLeave', () => ({ ok: core.pvLeave() }));
  // sematan pesan (v0.20.0, pin4). Aturan (siapa boleh, batas 100, salinan) dijaga Core (src/archne-pins.js); di sini hanya bentuk argumen.
  // scope: 'public' | 'g:<gid>' | id lawan bicara. shared: true = untuk semua di chat ini (grup: admin/pemilik; DM: kedua orang; Publik: tidak ada), selain itu pribadi.
  // Keadaan terkini ada di state().pins; pinList(scope) untuk satu chat (juga memberi canShare untuk chat yang belum punya sematan).
  const pscope = (v) => { if (typeof v !== 'string' || v.length > 40 || !(v === 'public' || /^g:[0-9a-f]{16}$/.test(v) || /^[0-9a-f]{16}$/.test(v))) throw new Error('Chat tidak valid'); return v; };
  const ptext = (v) => { if (typeof v !== 'string' || v.length > 10000) throw new Error('Teks sematan tidak valid'); return v; };
  h('pinList', (scope) => Object.assign({ ok: true }, core.pinList(pscope(scope))));
  h('pinAdd', (scope, mid, shared) => ({ ok: true, id: core.pinAdd(pscope(scope), str(mid, 'Pesan'), shared === true) }));
  h('pinNote', (scope, text, shared) => ({ ok: true, id: core.pinNote(pscope(scope), ptext(text), shared === true) }));
  h('pinEdit', (scope, pid, text) => ({ ok: core.pinEdit(pscope(scope), str(pid, 'Sematan'), ptext(text)) }));
  h('pinRemove', (scope, pid) => ({ ok: core.pinRemove(pscope(scope), str(pid, 'Sematan')) }));
  // reaksi pesan (v0.24.0, rx1). Aturan (DM, grup, dan Publik; satu reaksi per orang, versi lama, laju) dijaga Core (src/core/archne-reactions.js); di sini hanya bentuk argumen.
  // react(mid, e): ketuk emoji yang sama = cabut. Hasil { e, ts }, e kosong = dicabut. Chip ada di state().messages[].rx.
  const emo = (v) => { if (typeof v !== 'string' || !v || v.length > 32) throw new Error('Emoji tidak valid'); return v; };
  h('react', (mid, e) => Object.assign({ ok: true }, core.react(str(mid, 'Pesan'), emo(e))));
  h('reactWho', (mid, e) => ({ ok: true, who: core.reactWho(str(mid, 'Pesan'), emo(e)) }));
  h('reactRecent', () => ({ ok: true, recent: core.reactRecent() }));
  h('rxSupport', (scope) => { const s = core.rxSupport(pscope(scope)); return { ok: true, supported: s.ok, old: s.old }; });
  // mode lintas jaringan (langkah 2): UI memegang MQTT, Core memegang kode dan kunci. UI hanya menerima netId, topik, dan bungkus opak.
  // wanSeal -> { topic, payload } untuk di-publish apa adanya; wanOpen -> { type, from, to, ts, body } atau null (dibuang).
  const wkind = (v) => { if (v !== 'presence' && v !== 'signal') throw new Error('Jenis tidak valid'); return v; };
  // ICE lintas jaringan (langkah 5): turnSet menerima rahasia dari UI sekali; sesudah itu hanya turnInfo (tanpa rahasia) yang kembali.
  // pengaturan dan undangan (langkah 6)
  h('wanSettings', () => ({ ok: true, settings: core.wanSettings() }));
  h('wanEnable', (on) => ({ ok: true, settings: core.wanEnable(on === true) }));
  h('wanBroker', (url) => { if (url !== undefined && url !== null && typeof url !== 'string') throw new Error('Alamat broker tidak valid'); return { ok: true, settings: core.wanSetBroker(url || '') }; });
  h('wanRotate', () => ({ ok: true, settings: core.wanRotate() }));
  h('inviteMake', (withTurn) => Object.assign({ ok: true }, core.inviteMake(withTurn === true)));
  h('invitePeek', (text) => { if (typeof text !== 'string') throw new Error('Undangan tidak valid'); return { ok: true, info: core.invitePeek(text) }; });
  h('inviteApply', (text) => { if (typeof text !== 'string') throw new Error('Undangan tidak valid'); return { ok: true, settings: core.inviteApply(text) }; });
  h('turnInfo', () => ({ ok: true, turn: core.turnInfo() }));
  h('turnSet', (cfg) => { if (!cfg || typeof cfg !== 'object') throw new Error('Pengaturan TURN tidak valid'); return { ok: true, turn: core.turnSet(cfg) }; });
  h('turnClear', () => ({ ok: core.turnClear() }));
  h('turnIce', (peerId) => { const id = peerId === undefined || peerId === null ? undefined : str(peerId, 'Peer'); return core.turnIce(id).then((r) => Object.assign({ ok: true }, r), fail); });
  h('wanInfo', () => Object.assign({ ok: true }, core.wanInfo()));
  h('wanNewCode', () => ({ ok: true, code: core.wanNewCode() }));
  h('wanSetCode', (code) => { if (typeof code !== 'string' || code.length > 200) throw new Error('Kode jaringan tidak valid'); return { ok: true, netId: core.wanSetCode(code) }; });
  h('wanClear', () => ({ ok: core.wanClear() }));
  h('wanTopics', () => { const t = core.wanTopics(); return t ? Object.assign({ ok: true, id: core.id }, t) : { ok: false, err: T('e.wan.notSet', null, 'Mode lintas jaringan belum diatur') }; });
  h('wanSeal', (kind, to, body) => Object.assign({ ok: true }, core.wanSeal(wkind(kind), kind === 'signal' ? str(to, 'Penerima') : null, body)));
  h('wanOpen', (topic, payload) => {
    if (typeof topic !== 'string' || topic.length > 200 || typeof payload !== 'string' || payload.length > 70000) return { ok: true, msg: null };
    return { ok: true, msg: core.wanOpen(topic, payload) };
  });
  // mode lintas jaringan (langkah 4): jembatan DataChannel. Peer "rtc:<id>" di Core dilayani stream rtcmux di UI (renderer/archne-rtcglue.js).
  // rtcIn menerima satu pesan atau larik pesan dari UI (lihat src/archne-rtcbridge.js); Core -> UI lewat event 'rtcb'.
  // Adaptor tanpa jalur biner (HTTP/SSE: Android, peramban) memasang deps.rtcBase64 = true sehingga byte dikirim sebagai base64.
  const bridge = createBridge({ send: (m) => toRenderer('rtcb', m), binary: deps.rtcBase64 !== true, log });
  bridge.onLink((ev) => {
    if ((ev.state === 'open' || ev.state === 'update') && typeof core.rtcLinkPath === 'function') core.rtcLinkPath(ev.peerId, ev.path); // jalur direct/relay (archne-relay-policy.js)
    if (ev.state === 'open') { core.rtcLinkUp(ev.peerId).catch(() => {}); core.emit('update'); }
    else if (ev.state === 'closed') core.rtcLinkDown(ev.peerId);
    else core.emit('update');
  });
  if (typeof core.attachTransport === 'function') core.attachTransport(bridge.transport);
  // Jalur cadangan WebSocket MQTT lewat Node (v0.21.3): hanya ada bila host memasang deps.wsProxy (Electron). Lihat src/archne-wsproxy.js.
  h('wsOpen', (id, url, protocols) => { if (!deps.wsProxy) return { ok: false, err: T('e.ws.missing', null, 'paket ws tidak terpasang (jalankan setup.bat / npm install)') }; return { ok: deps.wsProxy.open(id, url, protocols) }; });
  h('wsSend', (id, data, text) => ({ ok: !!deps.wsProxy && deps.wsProxy.send(id, data, text === true) }));
  h('wsClose', (id) => ({ ok: !!deps.wsProxy && deps.wsProxy.close(id) }));
  h('rtcIn', (msg) => bridge.feed(msg));
  h('rtcStatus', () => ({ ok: true, attached: bridge.attached(), links: bridge.links() }));
  h('clearCalls', (peerId) => { try { core.clearCalls(typeof peerId === 'string' && peerId ? peerId : undefined); return { ok: true }; } catch (e) { return fail(e); } }); // riwayat panggilan: semua, atau satu orang

  h('setNotify', (key, on) => { try { core.setNotify(key, on); return { ok: true }; } catch (e) { return fail(e); } });

  // ---- pesan, grup, nama, peer (tidak berubah dari sebelum 5a) ----
  h('send', (text, to, replyTo) => { try { core.sendText(text, to, typeof replyTo === 'string' ? replyTo : undefined); return true; } catch (e) { return errText(e); } });
  h('createGroup', (name, ids) => { try { const g = core.createGroup(name, ids); return { ok: true, id: g.id }; } catch (e) { return fail(e); } });
  h('addMembers', (gid, ids) => { try { core.addMembers(gid, ids); return { ok: true }; } catch (e) { return fail(e); } });
  h('removeMember', (gid, id) => { try { core.removeMember(gid, id); return { ok: true }; } catch (e) { return fail(e); } });
  h('renameGroup', (gid, name) => { try { core.renameGroup(gid, name); return { ok: true }; } catch (e) { return fail(e); } });
  h('setGroupAvatar', (gid, b64) => { try { if (b64 != null && typeof b64 !== 'string') throw ek('e.group.badPhoto', null, 'Foto tidak valid'); core.setGroupAvatar(gid, b64); return { ok: true }; } catch (e) { return fail(e); } });
  h('setGroupAdmin', (gid, id, on) => { try { core.setAdmin(gid, id, !!on); return { ok: true }; } catch (e) { return fail(e); } });
  h('leaveGroup', (gid, successor) => { try { const r = core.leaveGroup(gid, successor || undefined); return { ok: true, notified: r.notified }; } catch (e) { return fail(e); } });
  h('transferOwner', (gid, id) => { try { core.transferOwner(gid, id); return { ok: true }; } catch (e) { return fail(e); } });
  h('disbandGroup', (gid) => { try { core.disbandGroup(gid); return { ok: true }; } catch (e) { return fail(e); } });
  h('clearChat', (key) => { try { core.clearChat(key); return { ok: true }; } catch (e) { return fail(e); } });
  h('deleteMessage', (id) => { try { core.deleteMessage(id); return { ok: true }; } catch (e) { return fail(e); } });
  h('setName', (n) => { core.setName(n); return true; });
  ipcMain.handle('addPeer', (_e, ip, port) => core.addPeer(ip, port));
  ipcMain.handle('addPeers', async (_e, text) => { try { return Object.assign({ ok: true }, await core.addPeers(typeof text === 'string' ? text.slice(0, 2000) : '')); } catch (e) { return fail(e); } });
  // profil dan teman
  h('setBio', (text) => { try { return { ok: true, bio: core.setBio(text) }; } catch (e) { return fail(e); } });
  h('setAvatar', (b64) => { try { if (b64 != null && typeof b64 !== 'string') throw ek('e.group.badPhoto', null, 'Foto tidak valid'); return { ok: true, has: core.setAvatar(b64) }; } catch (e) { return fail(e); } });
  h('addFriend', (id) => { try { return { ok: true, st: core.addFriend(id) }; } catch (e) { return fail(e); } }); // st: 'out' (menunggu persetujuan) atau 'ok'
  h('blockUser', (id) => { try { return { ok: core.blockUser(id) }; } catch (e) { return fail(e); } });
  h('unblockUser', (id) => { try { return { ok: core.unblockUser(id) }; } catch (e) { return fail(e); } });
  h('removeFriend', (id) => { try { return { ok: core.removeFriend(id) }; } catch (e) { return fail(e); } });

  // ---- mengirim berkas ----
  // Pilih berkas lewat dialog bawaan OS. Hasil: daftar path (kosong bila dibatalkan). Pengiriman sendiri lewat sendFile.
  ipcMain.handle('pickFiles', async () => {
    if (!deps.pickFiles) return [];
    try { const r = await deps.pickFiles(); return Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []; } catch (e) { log('pickFiles ' + e.message); return []; }
  });

  // job = id pekerjaan dari renderer (dipakai untuk progres dan pembatalan). Selesai setelah tawaran terkirim atau gagal.
  // Satu pekerjaan kirim, dipakai sendFile dan sendVoice: validasi umum, daftar pekerjaan (kemajuan, batal, galat), lalu `run` memanggil Core.
  async function sendJob(job, src, to, run) {
    try {
      if (typeof job !== 'string' || !JOB.test(job)) return { ok: false, err: 'id pekerjaan tidak valid' };
      if (jobs.has(job)) return { ok: false, err: 'pekerjaan sudah ada' };
      if (typeof src !== 'string' || !path.isAbsolute(src)) return { ok: false, err: 'path berkas harus absolut' };
      if (typeof to !== 'string' || !to) return { ok: false, err: 'tujuan tidak valid' };
      const st = await fs.promises.stat(src).catch(() => null);
      if (!st || !st.isFile()) return { ok: false, err: 'bukan berkas biasa atau tidak ditemukan' };
      if (jobs.size >= MAX_JOBS) return { ok: false, err: T('e.job.tooMany', null, 'terlalu banyak pekerjaan; tutup yang gagal dulu') };
      const j = { job, to, name: path.basename(src), phase: 'pack', done: 0, total: st.size, ac: new AbortController() };
      jobs.set(job, j);
      toRenderer('update');
      try {
        const m = await run(j.ac.signal, (p) => { j.done = p.done; j.total = p.total; progress({ job, phase: 'pack', done: p.done, total: p.total }); });
        jobs.delete(job); lastP.delete('j:' + job);
        toRenderer('update');
        return { ok: true, id: m.id };
      } catch (e) {
        const aborted = j.ac.signal.aborted || (e && e.name === 'AbortError');
        if (aborted) { jobs.delete(job); lastP.delete('j:' + job); toRenderer('update'); return { ok: false, err: 'Dibatalkan', code: 'abort' }; }
        j.phase = 'error'; j.err = errText(e); j.code = e.code || e.name;
        log(`sendFile ${j.name}: ${j.code} ${e.message}`);
        toRenderer('update');
        return fail(e);
      }
    } catch (e) { return fail(e); }
  }
  ipcMain.handle('sendFile', async (_e, job, src, to, media) => {
    // Info media (thumbnail dll) dari renderer tidak dipercaya: bila tidak sah, berkas tetap terkirim sebagai berkas biasa (tanpa pratinjau), bukan gagal.
    let mx;
    if (media !== undefined && media !== null) {
      const c = typeof media === 'object' && media.k !== 'vc' ? Offer.checkX(media, to) : { ok: false, err: 'bentuk tidak sah' };
      if (c.ok) mx = c.x; else log('sendFile: info media dibuang (' + c.err + ')');
    }
    return sendJob(job, src, to, (signal, onProgress) => core.sendFile(src, to, { media: mx, signal, onProgress }));
  });
  // Pesan suara (v0.25.0 Step 4): jalur terpisah dari sendFile, satu-satunya yang boleh membuat tawaran `vc`. Renderer hanya memberi sumber rekaman dan lama rekaman;
  // nama, jenis media, ukuran, dan kontainer ditentukan/diperiksa Core.sendVoice. Publik ditolak di sini dan di Core.
  ipcMain.handle('sendVoice', async (_e, job, src, to, durMs) => {
    if (to === 'public') return { ok: false, err: T('e.voice.noPublic', null, 'Pesan suara tidak bisa dikirim di Publik') };
    if (!Number.isSafeInteger(durMs)) return { ok: false, err: T('e.voice.badDur', null, 'Durasi pesan suara tidak sah') };
    return sendJob(job, src, to, (signal, onProgress) => core.sendVoice(src, to, { durMs, signal, onProgress }));
  });
  h('cancelSend', (job) => { const j = jobs.get(String(job)); if (!j || j.phase !== 'pack') return false; j.ac.abort(); return true; });
  h('dismissSend', (job) => { const j = jobs.get(String(job)); if (!j || j.phase !== 'error') return false; jobs.delete(j.job); toRenderer('update'); return true; });

  // Foto yang akan dikirim: renderer (Electron) hanya punya path, jadi bytenya dibaca di sini untuk membuat thumbnail. Hanya berkas biasa
  // yang isinya benar-benar gambar (JPEG/PNG/GIF/WebP, dicek lewat header) dan tidak terlalu besar; selain itu { ok:false } dan berkas
  // tetap dikirim biasa tanpa pratinjau. Hasil { ok, mime, w, h, b64 }.
  ipcMain.handle('mediaPrep', async (_e, src) => {
    try {
      if (typeof src !== 'string' || !path.isAbsolute(src)) return { ok: false, err: 'path berkas harus absolut' };
      if (!MediaCheck.thumbName(src)) return { ok: false, err: 'bukan jenis gambar' };
      const st = await fs.promises.stat(src).catch(() => null);
      if (!st || !st.isFile()) return { ok: false, err: 'bukan berkas biasa atau tidak ditemukan' };
      if (st.size > MediaCheck.VIEW_MAX) return { ok: false, err: T('e.thumb.tooBig', null, 'terlalu besar untuk pratinjau') };
      const buf = await fs.promises.readFile(src);
      const sn = MediaCheck.sniffImage(buf);
      if (!sn || !MediaCheck.pixelsOk(sn)) return { ok: false, err: T('e.thumb.notImage', null, 'bukan gambar yang bisa dibuatkan pratinjau') };
      return { ok: true, mime: sn.mime, w: sn.w, h: sn.h, b64: buf.toString('base64') };
    } catch (e) { return fail(e); }
  });
  // Foto hasil unduhan untuk penampil (hanya lewat id; isi diperiksa Core).
  // Hasil jepretan/rekaman kamera (v0.25.0 Step 3): renderer di Electron tidak punya path, jadi byte-nya disimpan di dataDir/capture lalu dikirim lewat sendFile
  // seperti berkas pilihan. Nama acak dari ekstensi tetap (jpg/mp4/webm), ukuran dibatasi, dan isinya diperiksa tanda tangannya.
  ipcMain.handle('captureSave', async (_e, name, bytes) => {
    try {
      const ext = /\.(jpg|mp4|webm|weba|ogg|m4a)$/i.exec(String(name || ''));
      if (!ext) return { ok: false, err: T('e.cam.badType', null, 'Jenis berkas kamera tidak dikenal') };
      const buf = Buffer.isBuffer(bytes) ? bytes : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
      if (!buf || buf.length < 12) return { ok: false, err: T('e.cam.empty', null, 'Data kamera kosong') };
      const e = ext[1].toLowerCase(), audio = e === 'weba' || e === 'ogg' || e === 'm4a'; // rekaman suara (Step 4): batas jauh lebih kecil dari video
      if (buf.length > (audio ? Offer.VC_MAX_BYTES : 64 * 1048576)) return { ok: false, err: audio ? T('e.voice.tooBig', null, 'Rekaman suara terlalu besar') : T('e.cam.tooBig', null, 'Rekaman terlalu besar') };
      const sig = { jpg: () => buf[0] === 0xff && buf[1] === 0xd8, mp4: () => buf.toString('latin1', 4, 8) === 'ftyp', m4a: () => buf.toString('latin1', 4, 8) === 'ftyp',
        webm: () => buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3, weba: () => buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3, ogg: () => buf.toString('latin1', 0, 4) === 'OggS' };
      if (!sig[e]()) return { ok: false, err: T('e.cam.mismatch', null, 'Isi berkas kamera tidak cocok dengan jenisnya') };
      const dir = path.join(core.opts.dataDir, 'capture');
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      for (const f of await fs.promises.readdir(dir).catch(() => [])) { // sapu hasil lama (lebih tua dari masa simpan tawaran di kurir: 14 hari)
        if (!/^cap-[0-9a-f]{16}\.(jpg|mp4|webm|weba|ogg|m4a)$/.test(f)) continue;
        try { const st = await fs.promises.stat(path.join(dir, f)); if (now - st.mtimeMs > 14 * 864e5) await fs.promises.rm(path.join(dir, f), { force: true }); } catch {}
      }
      const out = path.join(dir, 'cap-' + require('crypto').randomBytes(8).toString('hex') + '.' + e);
      await fs.promises.writeFile(out, buf, { mode: 0o600 });
      return { ok: true, path: out };
    } catch (e) { return fail(e); }
  });
  ipcMain.handle('mediaRead', async (_e, id) => { try { return await core.mediaRead(String(id)); } catch (e) { return fail(e); } });
  ipcMain.handle('mediaPlay', async (_e, id) => { try { return await core.mediaPlay(String(id)); } catch (e) { return fail(e); } });
  ipcMain.handle('mediaStream', async (_e, id) => { try { return await core.mediaStream(String(id)); } catch (e) { return fail(e); } });

  // ---- menerima berkas ----
  // Mengembalikan segera setelah penerimaan dimulai (unduhan bisa lama). Kemajuan lewat `fprog`, hasil lewat state (file.rx / file.saved).
  // Kegagalan langsung (tawaran tidak ada) dikembalikan di sini.
  ipcMain.handle('receiveFile', async (_e, id) => {
    try {
      id = String(id);
      if (!HEX32.test(id)) return { ok: false, err: 'id tidak valid' };
      const p = core.receiveFile(id);
      let early = null;
      p.then(() => {}, (e) => { early = fail(e); if (e && e.code !== 'abort') log(`receiveFile ${id.slice(0, 8)}: ${(e && e.code) || ''} ${e && e.message}`); });
      await new Promise((r) => setImmediate(r)); // penolakan langsung (tawaran tidak ada) sudah terselesaikan di sini
      return early || { ok: true };
    } catch (e) { return fail(e); }
  });
  h('cancelReceive', (id) => core.cancelFile(String(id))); // .part disimpan, bisa dilanjutkan
  ipcMain.handle('discardIncoming', async (_e, id) => { try { return { ok: await core.discardIncoming(String(id)) }; } catch (e) { return fail(e); } });

  // ---- membuka hasil unduhan (hanya lewat id) ----
  const savedPath = (id) => {
    id = String(id);
    const g = HEX32.test(id) ? core.store.got[id] : null;
    if (!g || !g.path || !fs.existsSync(g.path)) return null;
    return g;
  };
  ipcMain.handle('showFile', (_e, id) => {
    const g = savedPath(id);
    if (!g) return { ok: false, err: T('e.file.gone', null, 'Berkas tidak ditemukan (mungkin sudah dipindah atau dihapus)') };
    if (deps.shell) deps.shell.showItemInFolder(g.path);
    return { ok: true };
  });
  ipcMain.handle('openFile', async (_e, id) => {
    const g = savedPath(id);
    if (!g) return { ok: false, err: T('e.file.gone', null, 'Berkas tidak ditemukan (mungkin sudah dipindah atau dihapus)') };
    if (isRisky(g.name) || isRisky(g.path)) return { ok: false, risky: true, err: T('e.file.risky', null, 'Berkas jenis ini tidak dibuka dari Archne. Gunakan "Tampilkan di folder" bila kamu yakin.') };
    const r = deps.shell ? await deps.shell.openPath(g.path) : '';
    return r ? { ok: false, err: r } : { ok: true };
  });
  ipcMain.handle('openDownloads', async () => {
    const dir = core._downloadDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const r = deps.shell ? await deps.shell.openPath(dir) : '';
    return r ? { ok: false, err: r } : { ok: true };
  });

  // ---- peramban dalam aplikasi (v0.25.1): src/archne-webbrowser.js; renderer hanya mengirim alamat, validasi http(s) ada di sisi utama ----
  const web = deps.web, noWeb = () => ({ ok: false, err: T('e.web.none', null, 'Peramban dalam aplikasi tidak tersedia') }) // fungsi: bahasa dibaca saat dipanggil, bukan saat registrasi;
  h('webOpen', (url, top) => (web ? web.open(url, top) : noWeb()));
  h('webNav', (action) => (web ? web.nav(String(action)) : noWeb()));
  h('webBounds', (top) => (web ? web.setTop(top) : noWeb()));
  h('webClose', () => (web ? web.close() : { ok: true }));
  ipcMain.handle('webExternal', async (_e, url) => { try { return web ? await web.external(typeof url === 'string' ? url : '') : noWeb(); } catch (e) { return fail(e); } });

  // ---- Kirim Langsung (v0.24.0): src/archne-ipc-direct.js ----
  const direct = registerDirect({ ipcMain, core, deps, toRenderer, log, settingsOut });
  // ---- Halaman (1c-4a): src/archne-ipc-pages.js ----
  const pages = registerPages({ ipcMain, core, toRenderer, deps });

  return {
    jobs,
    direct,
    // Dipanggil saat aplikasi ditutup: hentikan semua persiapan kirim yang masih berjalan.
    dispose() { for (const j of jobs.values()) if (j.phase === 'pack') j.ac.abort(); try { direct.dispose(); } catch {} try { pages.dispose(); } catch {} try { bridge.detach(); } catch {} try { deps.wsProxy && deps.wsProxy.dispose(); } catch {} try { deps.web && deps.web.dispose(); } catch {} },
    bridge,
  };
}

module.exports = { register, isRisky, RISKY };
