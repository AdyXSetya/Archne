'use strict';
// src/archne-ipc-pages.js — jembatan renderer <-> Core untuk Halaman (1c-4a). Dipanggil dari register() di src/archne-ipc.js. UI di renderer/js/archne-pages.js (1c-4b, 1c-4c).
// Aturan: renderer hanya mengirim id peer / id postingan / teks / kursor; semua dicek di sini sebelum menyentuh Core. Satu-satunya jalur berkas: images[].src di pgCreate (pemilik), dibaca lalu diperiksa dari byte-nya oleh PageStore.addMedias; peminta jauh tidak punya jalan ke sini.
// Kanal (peminta): pgAvail(peerId), pgList(peerId, {after, limit}), pgGet(peerId, id), pgImage(peerId, postId, mediaId), pgVideo(peerId, postId, videoId), pgReact(peerId, postId, e), pgComment(peerId, postId, text), pgComments(peerId, postId, {after, limit}), pgCommentQueue(peerId, postId, text), pgCommentPending(peerId, postId), pgCommentCancel(peerId, commentId)
// pgMine (4a-7): tiap postingan membawa rx [{ e, n }], mine (reaksi pemilik) dan who [{ e, by: [id] }] bila ada reaksi (daftar pelaku HANYA di kanal ini); pgReact ke id sendiri ikut membawa react.who.
// Hapus komentar oleh penulis (5e), kanal peminta: pgCmtDelete(peerId, postId, cid) -> { ok:true, st:'removed'|'none'|'gone'|'queued' } (lihat on('pgCmtDelete')).
// Kanal (pemilik): pgMine({after, limit}), pgCreate(text, priv, images?, files?, opts?), pgSetDl(id, allow), pgRemove(id), pgCmtRemove(postId, cid)
// opts (3b, 3c-6) = null | { nodl?: boolean, videos?: [{ src }] }: nodl true = unduhan lampiran postingan baru ini dimatikan sejak awal. Bukan objek / nodl bukan boolean = bad (tanpa menyalin apa pun). Bidang lain diabaikan.
// opts.videos (3c-6) = larik 0..VIDEOS_MAX objek { src } (jalur absolut; hanya src yang diteruskan). SEMUA bentuk dicek sebelum menyalin apa pun (gambar, lampiran, video): satu cacat = bad dan tidak ada salinan. Urutan menyalin: gambar, lampiran, video (yang termahal terakhir), semua atau tidak sama sekali; jenis dan isi diperiksa PageStore.addVideos (mp4 / m4v / webm); pesan menyebut "Video ke-N".
// pgReact (4a-5) = Core.pageReact: { ok:true, react: { rx: [{ e, n }], mine } | null }, keadaan SESUDAH perubahan; e = emoji atau '' (cabut), dikanonkan Core. Hanya rx (e, n) dan mine yang keluar (bidang lain dari Core dibuang). null = tidak ada / bukan untuk Anda / diblokir / postingan penuh (tak dibedakan, seperti pgGet). peerId = id sendiri = reaksi lokal (tanpa jaringan). id cacat / e bukan string / e > REACT_IPC_MAX = bad sebelum menyentuh Core; emoji tak sah menurut Core juga bad.
// Komentar (4b-3), kanal peminta DAN pemilik (peerId = id sendiri = lokal, tanpa jaringan): pgComment(peerId, postId, text), pgComments(peerId, postId, { after, limit }).
// 5f: pgComment(peerId, postId, text, re?) / pgCommentQueue(..., re?): re = id komentar yang dibalas (balasan; pohon). Komentar dan daftar membawa `re` bila balasan. Galat tambahan: noparent.
// pgComment -> { ok:true, comment: { st:'added'|'same', c: { id, by, ts, text } } | null }. Teks dikanonkan dan DITANDATANGANI Core (kunci identitas); jembatan hanya meneruskan teks mentah. text bukan string / > CMT_IPC_MAX (batas kasar, sebelum dikanonkan) / id cacat = bad tanpa menyentuh Core; teks kosong atau > 1000 menurut Core juga bad. null = tidak ada / bukan untuk Anda / diblokir (tak dibedakan, seperti pgGet).
// pgComments -> { ok:true, comments: { items:[{ id, by, ts, text }], next, count, skipped } | null }, tertua dulu; next = kursor 'ts:id' untuk `after` berikutnya atau null; skipped = jumlah komentar palsu yang dibuang Core (wireComments). after / limit dicek seperti pgList (kursor cacat / limit bukan bilangan bulat = bad).
// Hanya id / by / ts / text yang keluar: pub dan sig (bukti penulis) dipakai Core dan tidak dibutuhkan renderer; bidang lain dari Core dibuang di sini, sebagai lapisan kedua sesudah wireComments.
// Galat komentar (cmtErr): kode Core yang dikenal (self peer blocked offline old bad auth time busy proto full) diteruskan beserta pesannya; 'full' (batas komentar) beda dari null. Galat lain (mis. EACCES dari penulisan lokal, pesannya memuat jalur) = pesan umum; ENOSPC = "Penyimpanan penuh".
// Antrean komentar (4c-2), peminta saja (id sendiri = self): pgCommentQueue -> { ok:true, queued: { st:'queued'|'same', c: { id, by, ts, text } } }; pgCommentPending -> { ok:true, pending:[{ id, ts, text }] } tertua dulu; pgCommentCancel(peerId, commentId) -> { ok:true, cancelled:boolean }. Galat: cmtErr (+ qfull = antrean penuh). Event 'pgcq' (4c-2 fase 2) ke renderer: { ev:'sent'|'drop', peerId, postId, id, why } (why: added | same | gone | full | bad | old | self | expired | gave; tak dikenal = ''), sama seperti 'pgdl' lewat toRenderer; satu event per komentar yang selesai (terkirim atau dibuang), tanpa teks.
// pgVideo (3c-6) = pgImage untuk video: { ok:true, video: { tok, mime, total } | null }, hanya token penyaji (Core.pageMedia, kontainer blok pertama sudah diperiksa), bukan byte dan bukan jalur. null = tidak ada / bukan untuk Anda / diblokir (tak dibedakan). Id yang ternyata bukan video (mime hasil bukan video/*) = bad dan tokennya dibuang.
// pgSetDl(id, allow) (3b): allow harus boolean persis, id 16 heks. -> { ok:true, found:boolean, nodl:boolean } (found false = postingan tidak ada; nodl = keadaan yang berlaku sekarang). Hanya pemilik (kanal ini tidak punya peminta jauh).
// files (3a-6) = larik 0..FILES_MAX objek { src } (jalur absolut berkas apa saja; hanya src yang diteruskan). Disalin berpotongan oleh PageStore.addFiles; gambar dan lampiran satu postingan = semua atau tidak sama sekali (gagal di mana pun membuang salinan yang sempat dibuat). Pesan menyebut "Berkas ke-N".
// images (2c; sebelumnya satu imagePath + th) = larik 0..MEDIA_MAX objek { src, th? }, urutan larik = urutan tampil. src = jalur absolut berkas gambar; null / larik kosong = postingan teks saja.
// th = thumbnail JPEG base64 dari renderer pemilik, per gambar. Bukan string / lebih dari TH_IPC_MAX = ditolak (bad); string tak sah menurut PageStore (bukan JPEG, >320 px, >7000 karakter) DIABAIKAN: gambar itu tetap ikut, hanya tanpa thumbnail.
// Semua gambar atau tidak sama sekali: satu gambar gagal (bukan gambar / terlalu besar / tak terbaca) = tidak ada postingan dan tidak ada salinan yang tersisa; pesan menyebut "Gambar ke-N".
// pgImage (2d-4) hanya mengembalikan { ok:true, image: { tok, mime, total } | null }: token penyaji media (Core.pageMedia), BUKAN byte dan bukan jalur berkas. Renderer membentuk URL dari tok (archne-media://m/<tok> di desktop, <awalan sesi>/media/<tok> di Android/peramban, sama dengan pemutar). null = tidak ada / bukan untuk Anda / diblokir (tak dibedakan, seperti pgGet).
// Unduh lampiran (3a-5b), kanal peminta: pgFileGet(peerId, postId, fileId) -> { ok:true, id } SEGERA (id unduhan 16 heks, buatan jembatan); unduhan jalan di latar. pgFileCancel(id) -> { ok:true, cancelled }.
// Kegagalan langsung (id cacat, 'many') dikembalikan di balasan pgFileGet sebagai { ok:false, err, code } dan TIDAK disiarkan sebagai event. Unduhan yang sama (peer+postingan+berkas) yang masih berjalan = id yang sama (klik ganda aman).
// Event 'pgdl' ke renderer: { id, peerId, postId, fileId, phase: 'progress', done, total } (dibatasi tiap DL_PROG_MS) lalu SATU kejadian akhir: { ..., phase:'done', name, size } | { ..., phase:'none' } (tidak ada / bukan untuk Anda / diblokir, tak dibedakan) | { ..., phase:'error', err, code } (dibatalkan = code 'cancel').
// Setiap event membawa peerId/postId/fileId selain id, jadi UI tidak bergantung pada urutan balasan vs event. Jalur berkas lokal TIDAK pernah keluar: hanya nama (sudah dibersihkan Core) dan ukuran; pesan galat sistem berisi jalur diganti pesan umum.
// Lencana postingan baru (5b-3a), kanal peminta: pgNewList() -> { ok:true, peers:[id 16 heks] } = pemilik yang lencananya menyala sekarang (Core.pageNewList: hanya teman yang tidak diblokir, urut id). Tanpa argumen: argumen apa pun diabaikan. Tidak ada kanal \"tandai dilihat\": membuka feed (pgList tanpa kursor) sudah menandai di Core, dan renderer tidak punya jalan ke opsi quiet (optsOf hanya meneruskan after / limit).
// Event 'pgnew' ke renderer (5b-3a): { peerId, on:boolean } hanya dua bidang ini, SATU per perubahan status lencana pemilik itu. Event cacat (peer bukan 16 heks, on bukan boolean persis) tidak disiarkan. Renderer mengambil pgNewList saat mulai / tersambung ulang, lalu mengikuti event.
// Moderasi komentar (5c-1), kanal pemilik (tanpa peerId: hanya postingan MILIK SENDIRI; tidak ada jalan untuk menyentuh halaman orang lain): pgCmtRemove(postId, cid) -> { ok:true, removed:boolean } (removed false = postingan / komentar tidak ada; tak dibedakan). id cacat = bad tanpa menyentuh Core. Galat: cmtErr (gagal tulis: ENOSPC = "Penyimpanan penuh", lainnya pesan umum tanpa jalur). Lokal saja, tidak ada event.
// Cadangan halaman (5d-6), kanal pemilik; dialog berkas ada di proses utama (deps.pickSave / deps.pickArc), jadi renderer TIDAK PERNAH mengirim atau menerima jalur berkas (hanya nama berkas untuk ditampilkan):
//   pgArcExport({ comments?: boolean }) -> { ok:true, job:null } (dialog dibatalkan) | { ok:true, job, name }; mengekspor SEMUA postingan (+ komentar bila comments === true) ke berkas pilihan pemilik (.archpg), di latar.
//   pgArcOpen() -> { ok:true, token:null } (dibatalkan) | { ok:true, token, name, summary }; memilih arsip dan memeriksanya TANPA menulis apa pun (5d-3, tanpa membaca isi lampiran). token berlaku untuk SATU pgArcImport.
//   pgArcImport(token, { comments?: boolean }) -> { ok:true, job }; comments === false = komentar tidak dipulihkan (bawaan: dipulihkan bila identitas sama). pgArcCancel(job) -> { ok:true, cancelled }. pgArcState() -> { ok:true, run: null | { job, kind, ... } }.
//   Hanya SATU pekerjaan arsip pada satu waktu (code 'busy'). Tanpa dialog (HTTP / Android): code 'nodialog'. Event 'pgarc': { job, kind:'export'|'import', phase:'progress', posts, total, bytes, totalBytes } lalu SATU akhir
//   { job, kind, phase:'done'|'cancel'|'error', result?, err?, code? }; result hanya angka dan nama berkas (tanpa id postingan, tanpa jalur). Galat tak terduga saat impor membawa result sementara.
// Semua kembali { ok:true, ... } atau { ok:false, err, code } (code dari Core: self | peer | blocked | offline | old | bad | auth | time | busy | proto; pgVideo juga streams, 3d-b1).
const path = require('path');
const crypto = require('crypto');
const { MEDIA_MAX, FILES_MAX, VIDEOS_MAX, VIDEO_MIME } = require('./archne-pagestore');
const HEX16 = /^[0-9a-f]{16}$/;
const CURSOR = /^\d+:[0-9a-f]{16}$/;
const TH_IPC_MAX = 16384; // batas kasar muatan IPC; batas sebenarnya (7000) dijaga PageStore.thOk
const REACT_IPC_MAX = 64; // batas kasar panjang e di IPC (sebelum dipangkas); emoji kanonis dijaga Core (reactions.cleanEmoji)
const CMT_IPC_MAX = 4096; // batas kasar teks komentar di IPC (sebelum dikanonkan); batas sebenarnya (1000, sesudah dikanonkan) dijaga Core (cmtSign)
const DL_PROG_MS = 120; // jarak minimal antar event progres unduhan
const { errText } = require('./core/archne-ecode'); // i18n (E4)
const T = require('./core/archne-i18n-node').tr; // T('e.kunci', param, 'teks Indonesia cadangan'); dihitung di dalam fungsi, bukan saat registrasi
const DL_CODES = new Set(['self', 'peer', 'blocked', 'offline', 'old', 'bad', 'auth', 'time', 'busy', 'proto', 'many', 'gone', 'nodl', 'cancel']); // kode galat Core yang pesannya aman diteruskan
// Galat unduhan -> { err, code } tanpa jalur lokal: kode dikenal = pesan apa adanya; ENOSPC = "Penyimpanan penuh"; lainnya (EACCES dll, pesannya memuat jalur) = pesan umum.
const dlErr = (e) => {
  const c = e && typeof e.code === 'string' ? e.code : '';
  if (DL_CODES.has(c)) return { err: errText(e) || c, code: c };
  if (c === 'ENOSPC') return { err: T('e.io.full', null, 'Penyimpanan penuh'), code: c };
  return { err: T('e.pg.saveFail', null, 'Gagal menyimpan berkas'), code: /^[A-Z0-9_]{2,20}$/.test(c) ? c : 'io' };
};
const CMT_CODES = new Set(['self', 'peer', 'blocked', 'offline', 'old', 'bad', 'auth', 'time', 'busy', 'proto', 'full', 'qfull', 'noparent']); // kode galat Core (komentar) yang pesannya aman diteruskan
// Galat komentar -> { ok:false, err, code } tanpa jalur lokal: kode dikenal = pesan apa adanya; ENOSPC = "Penyimpanan penuh"; lainnya (EACCES dll, pesannya memuat jalur) = pesan umum.
const cmtErr = (e) => {
  const c = e && typeof e.code === 'string' ? e.code : '';
  if (CMT_CODES.has(c)) return { ok: false, err: errText(e) || c, code: c };
  if (c === 'ENOSPC') return { ok: false, err: T('e.io.full', null, 'Penyimpanan penuh'), code: c };
  return { ok: false, err: T('e.pg.cmtFail', null, 'Gagal memproses komentar'), code: /^[A-Z0-9_]{2,20}$/.test(c) ? c : 'io' };
};
const wireRxOut = (v, who) => { // 5g: keadaan reaksi satu komentar yang boleh keluar ke renderer: rx [{ e, n }], mine, dan (HANYA kanal lokal pemilik) who [{ e, by: [id] }]
  const o = { rx: (Array.isArray(v && v.rx) ? v.rx : []).map((x) => ({ e: x.e, n: x.n })), mine: typeof (v && v.mine) === 'string' ? v.mine : '' };
  if (who && Array.isArray(v.who)) o.who = v.who.filter((w) => w && typeof w.e === 'string').map((w) => ({ e: w.e, by: (Array.isArray(w.by) ? w.by : []).filter((i) => typeof i === 'string' && HEX16.test(i)) }));
  return o;
};
const wireCrxMap = (m, who) => { const out = {}; if (m && typeof m === 'object') for (const k of Object.keys(m)) if (HEX16.test(k) && m[k] && Array.isArray(m[k].rx) && m[k].rx.length) out[k] = wireRxOut(m[k], who); return out; };
const wireCmt = (c) => { const o = { id: c.id, by: c.by, ts: c.ts, text: c.text }; if (typeof c.re === 'string' && HEX16.test(c.re)) o.re = c.re; return o; }; // hanya bidang ini yang keluar (tanpa pub / sig / post); re = id komentar induk bila balasan (5f)
const ARC_EXT = '.archpg', ARC_PROG_MS = 120;
const ARC_CODES = new Set(['bad', 'hash', 'size', 'name', 'limit', 'abort', 'dead']); // kode ArcError (archne-pagearc.js); pesannya tanpa jalur lokal
const num = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
const tally = (rows) => { const o = {}; for (const r of rows) { const w = r && typeof r.why === 'string' && /^[a-z]{2,8}$/.test(r.why) ? r.why : 'other'; o[w] = (o[w] || 0) + 1; } return o; };
// Galat arsip -> { err, code } tanpa jalur lokal: ArcError = pesan apa adanya; ENOSPC = "Penyimpanan penuh"; lainnya (EACCES / ENOENT dll, pesannya memuat jalur) = pesan umum.
const arcErr = (e) => {
  const c = e && typeof e.code === 'string' ? e.code : '';
  if (e && e.name === 'ArcError' && ARC_CODES.has(c)) return { err: errText(e), code: c };
  if (c === 'ENOSPC') return { err: T('e.io.full', null, 'Penyimpanan penuh'), code: c };
  return { err: T('e.pg.arcIo', null, 'Gagal membaca atau menulis berkas arsip'), code: /^[A-Z0-9_]{2,20}$/.test(c) ? c : 'io' };
};
const CM_NUMS = ['items', 'tombs', 'added', 'same', 'removed', 'bad', 'full', 'ts', 'orphan', 'tombAdded', 'tombSame', 'tombLive', 'tombOrphan'];
const wireCm = (c) => { // hanya bidang yang dikenal, nilai dipaksa ke bentuk aman
  if (!c || typeof c !== 'object') return { status: 'none' };
  const o = { status: ['none', 'pending', 'skipped', 'bad', 'done', 'ok'].includes(c.status) ? c.status : 'none' };
  if (typeof c.why === 'string' && /^[a-z]{2,8}$/.test(c.why)) o.why = c.why;
  for (const k of CM_NUMS) if (c[k] !== undefined) o[k] = num(c[k]);
  return o;
};
const sumReport = (r, name) => ({
  name, size: num(r.size), created: num(r.created), ownerMatch: r.ownerMatch === true ? true : r.ownerMatch === false ? false : null,
  counts: { total: num(r.counts.total), new: num(r.counts.new), same: num(r.counts.same), conflict: num(r.counts.conflict), bad: num(r.counts.bad) },
  why: { conflict: tally(r.posts.filter((x) => x.status === 'conflict')), bad: tally(r.posts.filter((x) => x.status === 'bad')) },
  blobs: { new: num(r.blobs.new), reuse: num(r.blobs.reuse), bytesNew: num(r.blobs.bytesNew) }, extra: num(r.extra),
  comments: Object.assign(wireCm(r.comments), { present: !!(r.comments && r.comments.present), restorable: !!(r.comments && r.comments.restorable), plan: r.comments && r.comments.plan ? wireCm(Object.assign({ status: 'ok' }, r.comments.plan)) : null }),
});
const sumExport = (r, name) => ({ name, size: num(r.size), posts: num(r.posts), media: num(r.media), files: num(r.files), videos: num(r.videos), bytes: num(r.bytes), skipped: r.skipped.length, skippedWhy: tally(r.skipped), comments: r.comments ? { items: num(r.comments.items), tombs: num(r.comments.tombs) } : null });
const sumImport = (r) => ({
  imported: r.imported.length, same: r.same.length, conflict: r.conflict.length, bad: r.bad.length, failed: r.failed.length, aborted: r.aborted === true, total: num(r.total),
  why: { conflict: tally(r.conflict), bad: tally(r.bad), failed: tally(r.failed) }, blobs: { written: num(r.blobs.written), reuse: num(r.blobs.reuse), bytes: num(r.blobs.bytes) },
  ownerMatch: r.ownerMatch === true ? true : r.ownerMatch === false ? false : null, comments: wireCm(r.comments),
});
const fail = (e) => ({ ok: false, err: errText(e), code: e && e.code });
const bad = (m) => ({ ok: false, err: m || 'Masukan tidak valid', code: 'bad' });

function registerPages({ ipcMain, core, toRenderer, deps }) {
  deps = deps || {};
  const on = (name, fn, err) => ipcMain.handle(name, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return (err || fail)(e); } }); // err (opsional) = pemeta galat khusus kanal (komentar: cmtErr)
  const emit = (p) => { try { toRenderer && toRenderer('pgdl', p); } catch {} };
  const dls = new Map(); // id -> { id, key, ac, last }; hanya unduhan yang sedang berjalan
  const peerOk = (id) => typeof id === 'string' && HEX16.test(id);
  const optsOf = (o) => {
    if (o == null) return {};
    if (typeof o !== 'object') return null;
    const r = {};
    if (o.after != null) { if (typeof o.after !== 'string' || !CURSOR.test(o.after)) return null; r.after = o.after; }
    if (o.limit != null) { if (!Number.isInteger(o.limit)) return null; r.limit = o.limit; }
    return r;
  };

  on('pgAvail', (peerId) => (peerOk(peerId) ? core.pageAvail(peerId) : { ok: false, why: 'peer' }));
  on('pgList', async (peerId, o) => {
    const opts = optsOf(o);
    if (!peerOk(peerId) || !opts) return bad();
    return Object.assign({ ok: true }, await core.pageList(peerId, opts));
  });
  on('pgNewList', () => ({ ok: true, peers: core.pageNewList().filter(peerOk) })); // filter kedua: hanya id sah yang keluar
  on('pgGet', async (peerId, id) => {
    if (!peerOk(peerId) || typeof id !== 'string' || !HEX16.test(id)) return bad();
    return { ok: true, post: await core.pagePost(peerId, id) };
  });

  on('pgImage', async (peerId, postId, mediaId) => {
    if (!peerOk(peerId) || typeof postId !== 'string' || !HEX16.test(postId) || typeof mediaId !== 'string' || !HEX16.test(mediaId)) return bad();
    const r = await core.pageMedia(peerId, postId, mediaId); // galat ber-code (self tidak terjadi di sini; old | offline | blocked | proto | ...) -> fail()
    return { ok: true, image: r ? { tok: r.tok, mime: r.mime, total: r.total } : null }; // hanya tiga bidang ini yang keluar
  });
  on('pgVideo', async (peerId, postId, videoId) => {
    if (!peerOk(peerId) || typeof postId !== 'string' || !HEX16.test(postId) || typeof videoId !== 'string' || !HEX16.test(videoId)) return bad();
    const r = await core.pageMedia(peerId, postId, videoId); // sama dengan pgImage: Core.pageMedia memeriksa kontainer video terhadap mime
    if (!r) return { ok: true, video: null };
    if (!VIDEO_MIME.includes(r.mime)) { try { core._ptok && core._ptok.delete(r.tok); } catch {} return bad('Bukan video'); } // id gambar dipakai sebagai id video: tolak dan buang tokennya (tidak menyingkirkan token sah)
    return { ok: true, video: { tok: r.tok, mime: r.mime, total: r.total } };
  });

  on('pgReact', async (peerId, postId, e) => {
    if (!peerOk(peerId) || typeof postId !== 'string' || !HEX16.test(postId) || typeof e !== 'string' || e.length > REACT_IPC_MAX) return bad();
    const r = await core.pageReact(peerId, postId, e); // galat ber-code (old | offline | blocked | proto | busy | auth | time | bad | peer) -> fail()
    const react = r ? { rx: (Array.isArray(r.rx) ? r.rx : []).map((x) => ({ e: x.e, n: x.n })), mine: typeof r.mine === 'string' ? r.mine : '' } : null; // hanya tiga bidang ini yang keluar
    if (react && peerId === core.id) { const o = core.pageStore().ownerReactionsOf(core.id, postId); if (o) react.who = o.who; } // 4a-7: reaksi di postingan sendiri membawa daftar pelaku terbaru (hanya jalur lokal pemilik)
    return { ok: true, react };
  });

  on('pgComment', async (peerId, postId, text, re) => {
    if (!peerOk(peerId) || !peerOk(postId) || typeof text !== 'string' || text.length > CMT_IPC_MAX || (re != null && !peerOk(re))) return bad();
    const r = re == null ? await core.pageComment(peerId, postId, text) : await core.pageComment(peerId, postId, text, re); // re hanya diteruskan bila ada (komentar tingkat atas = panggilan lama persis) // galat ber-code (full | old | offline | blocked | proto | busy | auth | time | bad | peer) -> cmtErr()
    return { ok: true, comment: r && r.c ? { st: r.st === 'same' ? 'same' : 'added', c: wireCmt(r.c) } : null };
  }, cmtErr);
  on('pgComments', async (peerId, postId, o) => {
    const opts = optsOf(o);
    if (!peerOk(peerId) || !peerOk(postId) || !opts) return bad();
    const r = await core.pageComments(peerId, postId, opts);
    if (!r) return { ok: true, comments: null };
    const comments = { items: (Array.isArray(r.items) ? r.items : []).map(wireCmt), next: typeof r.next === 'string' ? r.next : null, count: Number.isInteger(r.count) ? r.count : 0, skipped: Number.isInteger(r.skipped) ? r.skipped : 0 };
    const rx = wireCrxMap(r.rx, peerId === core.id); // 5g: reaksi komentar di halaman ini; who hanya untuk halaman sendiri
    if (Object.keys(rx).length) comments.rx = rx;
    return { ok: true, comments };
  }, cmtErr);
  // 5g: reaksi pada komentar. pgCmtReact(peerId, postId, cid, e) -> { ok:true, react: { rx, mine[, who] } | null }, keadaan SESUDAH perubahan (who hanya di halaman sendiri). Galat ber-code lewat cmtErr (old membawa pesannya).
  on('pgCmtReact', async (peerId, postId, cid, e) => {
    if (!peerOk(peerId) || !peerOk(postId) || !peerOk(cid) || typeof e !== 'string' || e.length > REACT_IPC_MAX) return bad();
    const r = await core.pageReactComment(peerId, postId, cid, e);
    if (!r) return { ok: true, react: null };
    let who = false, v = r;
    if (peerId === core.id) { const o = core.pageStore().ownerCommentReactionsOf(core.id, postId, cid); if (o) { v = o; who = true; } }
    return { ok: true, react: wireRxOut(v, who) };
  }, cmtErr);

  // 4c-2: antrean komentar untuk pemilik offline (Core 4c-1: pageCommentQueue / pageCommentPending / pageCommentCancel). Kode galat tambahan: qfull (antrean penuh).
  on('pgCommentQueue', async (peerId, postId, text, re) => {
    if (!peerOk(peerId) || !peerOk(postId) || typeof text !== 'string' || text.length > CMT_IPC_MAX || (re != null && !peerOk(re))) return bad();
    const r = re == null ? await core.pageCommentQueue(peerId, postId, text) : await core.pageCommentQueue(peerId, postId, text, re); // galat ber-code (self | peer | blocked | old | bad | qfull) -> cmtErr()
    return { ok: true, queued: r && r.c ? { st: r.st === 'same' ? 'same' : 'queued', c: wireCmt(r.c) } : null };
  }, cmtErr);
  on('pgCommentPending', (peerId, postId) => {
    if (!peerOk(peerId) || !peerOk(postId)) return bad();
    const r = core.pageCommentPending(peerId, postId);
    return { ok: true, pending: (Array.isArray(r) ? r : []).map((x) => ({ id: x.id, ts: x.ts, text: x.text })) }; // hanya tiga bidang ini yang keluar
  }, cmtErr);
  on('pgCommentCancel', (peerId, commentId) => {
    if (!peerOk(peerId) || !peerOk(commentId)) return bad();
    return { ok: true, cancelled: core.pageCommentCancel(peerId, commentId) === true };
  }, cmtErr);

  // 5e: penulis menghapus komentarnya sendiri di halaman orang lain (peerId = pemilik halaman, bukan id sendiri). -> { ok:true, st:'removed'|'none'|'gone'|'queued' }; queued = pemilik offline, dikirim otomatis saat online.
  // Hanya tiga id yang diteruskan; id cacat = bad tanpa menyentuh Core. Galat: cmtErr (self | peer | blocked | old | qfull | auth | time | busy | proto). Tidak ada event.
  on('pgCmtDelete', async (peerId, postId, cid) => {
    if (!peerOk(peerId) || !peerOk(postId) || !peerOk(cid)) return bad();
    const r = await core.pageCommentDelete(peerId, postId, cid);
    return { ok: true, st: r && ['removed', 'none', 'gone', 'queued'].includes(r.st) ? r.st : 'none' };
  }, cmtErr);
  // 5c-1: moderasi pemilik. Hanya (postId, cid): halaman selalu milik sendiri, jadi renderer tidak bisa meminta penghapusan di halaman orang lain.
  on('pgCmtRemove', (postId, cid) => {
    if (!peerOk(postId) || !peerOk(cid)) return bad();
    return { ok: true, removed: core.pageCommentRemove(postId, cid) === true };
  }, cmtErr);

  on('pgFileGet', async (peerId, postId, fileId) => {
    if (!peerOk(peerId) || typeof postId !== 'string' || !HEX16.test(postId) || typeof fileId !== 'string' || !HEX16.test(fileId)) return bad();
    const key = peerId + ':' + postId + ':' + fileId;
    for (const d of dls.values()) if (d.key === key) return { ok: true, id: d.id };
    const id = crypto.randomBytes(8).toString('hex'), d = { id, key, ac: new AbortController(), last: 0 }, tag = { id, peerId, postId, fileId };
    dls.set(id, d);
    let returned = false, early = null;
    const finish = (ev) => { dls.delete(id); if (returned) emit(Object.assign({}, tag, ev)); else early = ev; };
    const onProgress = (done, total) => {
      const now = Date.now();
      if (!returned || now - d.last < DL_PROG_MS) return;
      d.last = now; emit(Object.assign({}, tag, { phase: 'progress', done, total }));
    };
    (async () => core.pageFileGet(peerId, postId, fileId, { onProgress, signal: d.ac.signal }))().then(
      (r) => finish(r ? { phase: 'done', name: String(r.name), size: r.size } : { phase: 'none' }), // hanya nama dan ukuran; r.path tidak ikut
      (e) => finish(Object.assign({ phase: 'error' }, dlErr(e))));
    await new Promise((r) => setImmediate(r)); // penolakan langsung (id cacat, 'many') sudah terselesaikan di sini
    returned = true;
    if (early && early.phase === 'error') return { ok: false, err: early.err, code: early.code };
    if (early) setImmediate(() => emit(Object.assign({}, tag, early))); // selesai sebelum balasan (mis. salinan milik sendiri): tetap disiarkan, setelah balasan
    return { ok: true, id };
  });
  on('pgFileCancel', (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) return bad();
    const d = dls.get(id);
    if (d) d.ac.abort();
    return { ok: true, cancelled: !!d }; // id tak dikenal / sudah selesai = ok, cancelled:false
  });

  on('pgMine', (o) => {
    const opts = optsOf(o);
    if (!opts) return bad();
    const ps = core.pageStore(), r = ps.list(opts);
    return Object.assign({ ok: true }, r, { items: r.items.map((p) => ps.ownerRx(core.id, p)) }); // 4a-7: rx / mine / who (daftar pelaku) hanya di kanal pemilik ini
  });
  on('pgCreate', async (text, priv, images, files, opts) => {
    if (typeof text !== 'string') return bad('Teks tidak valid');
    if (priv != null && typeof priv !== 'string') return bad();
    if (opts != null && (typeof opts !== 'object' || Array.isArray(opts) || (opts.nodl != null && typeof opts.nodl !== 'boolean'))) return bad('Pengaturan unduhan tidak valid');
    const nodl = !!(opts && opts.nodl === true); // dicek sebelum menyalin apa pun, jadi masukan cacat tidak meninggalkan salinan
    const vl = [];
    if (opts && opts.videos != null) {
      if (!Array.isArray(opts.videos) || opts.videos.length > VIDEOS_MAX) return bad('Daftar video tidak valid (maksimal ' + VIDEOS_MAX + ' video)');
      for (const it of opts.videos) {
        if (!it || typeof it !== 'object' || typeof it.src !== 'string' || !it.src || it.src.length > 4096 || !path.isAbsolute(it.src)) return bad('Jalur video tidak valid');
        vl.push({ src: it.src }); // hanya src; jenis, nama, dan ukuran ditentukan PageStore dari berkasnya
      }
    }
    let list = [];
    if (images != null) {
      if (!Array.isArray(images) || images.length > MEDIA_MAX) return bad('Daftar gambar tidak valid (maksimal ' + MEDIA_MAX + ' gambar)');
      for (const it of images) {
        if (!it || typeof it !== 'object' || typeof it.src !== 'string' || !it.src || it.src.length > 4096 || !path.isAbsolute(it.src)) return bad('Jalur gambar tidak valid');
        if (it.th != null && (typeof it.th !== 'string' || it.th.length > TH_IPC_MAX)) return bad('Thumbnail tidak valid');
        list.push({ src: it.src, th: it.th == null ? undefined : it.th }); // hanya dua bidang ini yang diteruskan
      }
    }
    const fl = [];
    if (files != null) {
      if (!Array.isArray(files) || files.length > FILES_MAX) return bad('Daftar berkas tidak valid (maksimal ' + FILES_MAX + ' berkas)');
      for (const it of files) {
        if (!it || typeof it !== 'object' || typeof it.src !== 'string' || !it.src || it.src.length > 4096 || !path.isAbsolute(it.src)) return bad('Jalur berkas tidak valid');
        fl.push({ src: it.src }); // hanya src yang diteruskan (nama dan ukuran ditentukan PageStore dari berkasnya)
      }
    }
    const ps = core.pageStore();
    if (!list.length && !fl.length && !vl.length) return { ok: true, post: ps.create({ text, priv, nodl: nodl || undefined }) };
    let ms = [], fs2 = [], vs = [];
    try {
      if (list.length) ms = await ps.addMedias(list); // gagal (bukan gambar / terlalu besar / tak terbaca) melempar dan sudah membuang salinan yang sempat dibuat
      if (fl.length) fs2 = await ps.addFiles(fl); // gagal = salinan lampiran dibuang addFiles; gambar yang sudah tersalin dibuang di catch
      if (vl.length) vs = await ps.addVideos(vl); // paling akhir: video termahal; gagal = salinan video dibuang addVideos, gambar dan lampiran dibuang di catch
      return { ok: true, post: ps.create({ text, priv, media: ms.length ? ms : undefined, files: fs2.length ? fs2 : undefined, videos: vs.length ? vs : undefined, nodl: nodl || undefined }) };
    } catch (e) { for (const m of ms) ps.dropMedia(m.id); for (const f of fs2) ps.dropFile(f.id); for (const v of vs) ps.dropVideo(v.id); throw e; } // teks/privasi tak sah: salinan tidak ditinggal yatim
  });
  on('pgSetDl', (id, allow) => {
    if (typeof id !== 'string' || !HEX16.test(id) || typeof allow !== 'boolean') return bad();
    const nodl = core.pageStore().setDl(id, allow);
    return { ok: true, found: nodl !== null, nodl: nodl === true };
  });
  on('pgRemove', (id) => {
    if (typeof id !== 'string' || !HEX16.test(id)) return bad();
    return { ok: true, removed: core.pageStore().remove(id) };
  });
  // ---- 5d-6: cadangan halaman ----
  let cur = null, picking = false, pending = null; // cur = pekerjaan berjalan { job, kind, ac, prog }; pending = { token, file } (hasil pgArcOpen, satu kali pakai)
  const arcEmit = (j, ev) => { try { toRenderer && toRenderer('pgarc', Object.assign({ job: j.job, kind: j.kind }, ev)); } catch {} };
  const arcBusy = () => ({ ok: false, err: T('e.pg.arcBusy', null, 'Ekspor atau impor lain sedang berjalan'), code: 'busy' });
  const noDlg = () => ({ ok: false, err: T('e.pg.noPicker', null, 'Pemilih berkas tidak tersedia di perangkat ini'), code: 'nodialog' }); // fungsi: bahasa dibaca saat dipanggil
  const arcStart = (kind, run) => { // run(signal, onProgress) -> Promise<ev akhir>; balasan dikirim dulu, pekerjaan mulai sesudahnya (event tak mendahului balasan)
    const j = { job: crypto.randomBytes(8).toString('hex'), kind, ac: new AbortController(), prog: null, last: 0 };
    cur = j;
    const onProgress = (p) => {
      const now = Date.now(); if (cur !== j || now - j.last < ARC_PROG_MS) return;
      j.last = now; j.prog = { posts: num(p.posts), total: num(p.total), bytes: num(p.bytes), totalBytes: num(p.totalBytes) };
      arcEmit(j, Object.assign({ phase: 'progress' }, j.prog));
    };
    setImmediate(() => {
      Promise.resolve().then(() => run(j.ac.signal, onProgress)).then((ev) => ev, (e) => (e && e.code === 'abort' ? { phase: 'cancel' } : Object.assign({ phase: 'error' }, arcErr(e), e && e.partial ? { result: sumImport(e.partial) } : {})))
        .then((ev) => { if (cur === j) cur = null; arcEmit(j, ev); });
    });
    return j;
  };
  const boolOpt = (o, k) => (o == null ? { v: undefined } : typeof o !== 'object' || Array.isArray(o) || (o[k] != null && typeof o[k] !== 'boolean') ? null : { v: o[k] });
  on('pgArcState', () => ({ ok: true, run: cur ? Object.assign({ job: cur.job, kind: cur.kind }, cur.prog || {}) : null }));
  on('pgArcCancel', (job) => {
    if (typeof job !== 'string' || !HEX16.test(job)) return bad();
    const hit = !!cur && cur.job === job; if (hit) cur.ac.abort();
    return { ok: true, cancelled: hit };
  });
  on('pgArcExport', async (o) => {
    const b = boolOpt(o, 'comments'); if (!b) return bad();
    if (typeof deps.pickSave !== 'function') return noDlg();
    if (cur || picking) return arcBusy();
    picking = true; let f;
    try { const d = new Date(), p2 = (n) => String(n).padStart(2, '0'); f = await deps.pickSave('halaman-archne-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ARC_EXT); } finally { picking = false; }
    if (typeof f !== 'string' || !f) return { ok: true, job: null }; // dibatalkan
    if (!path.isAbsolute(f) || f.length > 4096) return bad('Jalur tujuan tidak valid');
    if (cur) return arcBusy();
    if (!f.toLowerCase().endsWith(ARC_EXT)) f += ARC_EXT;
    const name = path.basename(f), ps = core.pageStore();
    const j = arcStart('export', async (signal, onProgress) => ({ phase: 'done', result: sumExport(await ps.exportTo(f, { comments: b.v === true, signal, onProgress }), name) }));
    return { ok: true, job: j.job, name };
  }, (e) => Object.assign({ ok: false }, arcErr(e)));
  on('pgArcOpen', async () => {
    if (typeof deps.pickArc !== 'function') return noDlg();
    if (cur || picking) return arcBusy();
    picking = true;
    try {
      const f = await deps.pickArc();
      if (typeof f !== 'string' || !f) return { ok: true, token: null };
      if (!path.isAbsolute(f) || f.length > 4096) return bad('Jalur berkas tidak valid');
      const rep = await require('./archne-pageimport').inspectArchive(core.pageStore(), f, { verify: false }); // cepat: manifest + postingan; isi lampiran diperiksa saat disalin
      pending = { token: crypto.randomBytes(8).toString('hex'), file: f };
      return { ok: true, token: pending.token, name: path.basename(f), summary: sumReport(rep, path.basename(f)) };
    } finally { picking = false; }
  }, (e) => Object.assign({ ok: false }, arcErr(e)));
  on('pgArcImport', (token, o) => {
    if (typeof token !== 'string' || !HEX16.test(token)) return bad();
    const b = boolOpt(o, 'comments'); if (!b) return bad();
    if (cur || picking) return arcBusy();
    if (!pending || pending.token !== token) return { ok: false, err: T('e.pg.pickAgain', null, 'Pilih arsip lagi'), code: 'gone' };
    const f = pending.file; pending = null; // satu kali pakai
    const ps = core.pageStore();
    const j = arcStart('import', async (signal, onProgress) => {
      const r = await ps.importFrom(f, { signal, onProgress, comments: b.v === false ? false : undefined });
      return { phase: r.aborted ? 'cancel' : 'done', result: sumImport(r) };
    });
    return { ok: true, job: j.job };
  }, (e) => Object.assign({ ok: false }, arcErr(e)));

  // 4c-2 fase 2: event 'pgcq' dari Core (hasil kiriman antrean) -> renderer. Bentuk keluar: { ev:'sent'|'drop', peerId, postId, id, why } (peerId / postId seperti 'pgdl'); hanya lima bidang ini, nilai tak sah dibuang (event cacat tidak disiarkan).
  const CQ_EV = new Set(['sent', 'drop']), CQ_WHY = new Set(['added', 'same', 'gone', 'full', 'bad', 'old', 'self', 'expired', 'gave']);
  const onCq = (x) => {
    if (!x || typeof x !== 'object' || !CQ_EV.has(x.ev) || !peerOk(x.peer) || !peerOk(x.post) || !peerOk(x.id)) return;
    try { toRenderer && toRenderer('pgcq', { ev: x.ev, peerId: x.peer, postId: x.post, id: x.id, why: CQ_WHY.has(x.why) ? x.why : '' }); } catch {}
  };
  const cqOn = typeof core.on === 'function' && typeof core.removeListener === 'function'; // Core asli = EventEmitter; Core tiruan di tes lama tidak punya
  if (cqOn) core.on('pgcq', onCq);
  // 5b-3a: event 'pgnew' dari Core (status lencana satu pemilik berubah) -> renderer. Bentuk keluar { peerId, on }; event cacat tidak disiarkan.
  const onNew = (x) => {
    if (!x || typeof x !== 'object' || !peerOk(x.peer) || typeof x.on !== 'boolean') return;
    try { toRenderer && toRenderer('pgnew', { peerId: x.peer, on: x.on }); } catch {}
  };
  if (cqOn) core.on('pgnew', onNew);
  // 5d-8: komentar / reaksi baru masuk ke halaman milikku -> renderer (Halamanku terbuka menyegarkan diri). Bentuk keluar { postId, kind:'cmt'|'rx' }, tanpa teks dan tanpa id penulis; event cacat tidak disiarkan.
  const onAct = (x) => {
    if (!x || typeof x !== 'object' || typeof x.post !== 'string' || !HEX16.test(x.post) || (x.kind !== 'cmt' && x.kind !== 'rx')) return;
    try { toRenderer && toRenderer('pgact', { postId: x.post, kind: x.kind }); } catch {}
  };
  if (cqOn) core.on('pgact', onAct);
  return { dispose() { if (cqOn) { core.removeListener('pgcq', onCq); core.removeListener('pgnew', onNew); core.removeListener('pgact', onAct); } for (const d of dls.values()) d.ac.abort(); if (cur) cur.ac.abort(); } }; // aplikasi ditutup: hentikan semua unduhan (.part dibuang Core)
}

module.exports = { registerPages };
