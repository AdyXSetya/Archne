// Halaman (1c-4b tombol + layar, 1c-4c feed): tombol "Halaman" di profil, layar dengan feed berhalaman, hapus postingan, kerangka layar, dan pesan error. Skrip global biasa; dimuat setelah archne-profile-compose.js.
// Dipecah per domain (3d-a); semua berkas di bawah berbagi satu ruang nama global dan dimuat berurutan di archne-index.html: archne-pages.js (ini: kerangka + feed) -> archne-pages-compose.js (kotak tulis) -> archne-pages-media.js (gambar + video di feed) -> archne-pages-files.js (lampiran + unduhan) -> archne-pages-react.js (reaksi, 4a-6; Halamanku + daftar pelaku, 4a-7) -> archne-pages-cmt.js (komentar, 4b-4).
// Hanya deklarasi (const / let / function) yang dipakai lintas berkas; tidak ada kode yang berjalan saat dimuat selain pendengar di bagian bawah berkas ini, yang memakai fungsi berkas lain hanya saat peristiwa terjadi.
// Pesan galat dibaca lewat getter supaya mengikuti bahasa aplikasi saat dipakai (bukan saat berkas dimuat). Pemakai lain (34, 35, 36, 37, 62) tetap memakai PG_ERR[kode] / PG_ERR.kode apa adanya.
const PG_WHY = {
  get offline() { return txf('pg.why.offline', 'Pemilik sedang offline. Halaman hanya bisa dibuka saat pemilik online.'); },
  get old() { return txf('pg.why.old', 'Aplikasi pemilik belum mendukung Halaman.'); },
  get blocked() { return txf('pg.why.blocked', 'Kamu memblokir orang ini. Buka blokirnya dulu.'); },
  get peer() { return txf('pg.why.peer', 'Peer tidak dikenal.'); },
};
let pgId = null; // id pemilik halaman yang sedang dibuka (null = layar tertutup)
const pgAv = {}, pgBusy = {}; // id -> { r, t }; id -> true saat IPC berjalan

function pgRefresh(id, after) {
  if (pgBusy[id]) return; pgBusy[id] = true;
  Promise.resolve().then(() => window.api.pgAvail(id)).catch(() => ({ ok: false, why: 'peer' }))
    .then((r) => { pgAv[id] = { r: r || { ok: false, why: 'peer' }, t: Date.now() }; })
    .finally(() => { delete pgBusy[id]; if (after) after(); });
}
function pgFresh(id) { const e = pgAv[id]; return e && Date.now() - e.t < 3000 ? e.r : null; }

// Tombol ikon saja; ibtn() (archne-state-util.js) bila ada, cadangan sederhana untuk tes vm yang hanya memuat berkas Halaman.
const pgIb = (icon, label, attrs, cls) => (typeof ibtn === 'function' ? ibtn(icon, label, attrs, cls) : `<button type="button" class="pib${cls ? ' ' + cls : ''}" ${attrs || ''} title="${esc(label)}" aria-label="${esc(label)}"></button>`);
// HTML tombol untuk satu profil. Milik sendiri: selalu ada. Orang lain: aktif bila ok, nonaktif + alasan bila offline / versi lama, hilang bila diblokir / tak dikenal.
function pgBtn(id) {
  if (!id) return '';
  if (S.me && id === S.me.id) return pgIb('home', txf('pg.mine', 'Halamanku'), 'data-pg="open"');
  const r = pgFresh(id);
  if (!r) { pgRefresh(id, () => { if (profId === id) renderProfile(); }); return pgAv[id] ? pgBtnFor(pgAv[id].r, id) : ''; }
  return pgBtnFor(r, id);
}
function pgBtnFor(r, id) {
  const pb = txf('pg.btn', 'Halaman');
  if (r.ok) return typeof pgNewHas === 'function' && pgNewHas(id) ? pgIb('home', txf('pg.btnNew', 'Halaman, ada postingan baru'), 'data-pg="open"', 'pgnb').replace('</button>', PGN_DOT + '</button>') : pgIb('home', pb, 'data-pg="open"'); // 5b-4b: titik lencana bila ada postingan baru
  if (r.why === 'offline' || r.why === 'old') return pgIb('home', PG_WHY[r.why], 'disabled');
  return '';
}

// ---- feed (1c-4c) ----
// Pesan error per kode (kode dari Core lewat ipc-pages). Kode tanpa tombol coba-lagi: tidak akan berubah dengan mengulang.
const PG_ERR = {
  get offline() { return PG_WHY.offline; }, get old() { return PG_WHY.old; }, get blocked() { return PG_WHY.blocked; }, get peer() { return PG_WHY.peer; },
  get auth() { return txf('pg.err.auth', 'Pemilik menolak permintaanmu (tanda tangan tidak sah atau aplikasimu terlalu lama).'); },
  get time() { return txf('pg.err.time', 'Jam perangkatmu dan jam pemilik berbeda terlalu jauh. Samakan jam, lalu coba lagi.'); },
  get busy() { return txf('pg.err.busy', 'Pemilik sedang sibuk. Coba lagi sebentar lagi.'); },
  get streams() { return txf('pg.err.streams', 'Terlalu banyak video diputar sekaligus. Jeda salah satunya, tunggu beberapa detik, lalu coba lagi.'); },
  get proto() { return txf('pg.err.proto', 'Jawaban pemilik tidak dapat dibaca.'); }, get bad() { return txf('pg.err.bad', 'Permintaan tidak valid.'); },
};
const PG_NORETRY = { old: 1, blocked: 1, peer: 1, bad: 1 };
const PG_LIMIT = 10, PG_FOLD = 800, PG_NEAR = 300; // per halaman; lipat teks panjang; jarak (px) dari dasar yang memicu muat lagi
let pgTok = 0;      // naik tiap layar dibuka / ditutup: jawaban IPC yang basi dibuang
let pgF = null;     // { mine, items, ids, next, count, skipped, busy, done, err, open:Set, full:{}, posting }
const pgMsg = (r) => (r && PG_ERR[r.code]) || (r && r.err) || txf('pg.loadFail', 'Gagal memuat halaman.');
const pgCut = (t, n) => { let k = typeof Linkify === 'undefined' || !Linkify.cut ? n : Linkify.cut(t, n); const c = t.charCodeAt(k - 1); if (c >= 0xd800 && c <= 0xdbff) k--; return k; };
// PG_HEX16: pola id 16 heks, dipakai semua berkas Halaman (kotak tulis, media, lampiran, feed).
const PG_HEX16 = /^[0-9a-f]{16}$/;
function pgPostHtml(p, mine) {
  const f = pgF, text = (f.full[p.id] && f.full[p.id].text) || p.text, tr = p.trunc && !f.full[p.id] ? p.trunc : 0;
  const open = f.open.has(p.id), long = text.length > PG_FOLD;
  let body, more = '';
  if (long && !open) { body = linkHtml(text.slice(0, pgCut(text, PG_FOLD)).replace(/\s+$/, '')) + '…'; more = `<button type="button" class="morebtn" data-pg="more" data-id="${p.id}">${tnf('msg.more', tr || text.length, 'Lihat selengkapnya ({count} karakter)', { count: fmt(tr || text.length) })}</button>`; }
  else if (tr) { body = linkHtml(text) + '…'; more = `<button type="button" class="morebtn" data-pg="full" data-id="${p.id}">${f.full[p.id] === 0 ? txf('pg.loading', 'Memuat…') : tnf('pg.loadFull', tr, 'Muat teks utuh ({count} karakter)', { count: fmt(tr) })}</button>`; }
  else { body = linkHtml(text); if (long) more = `<button type="button" class="morebtn" data-pg="more" data-id="${p.id}">${txf('msg.less', 'Sembunyikan')}</button>`; }
  const tFr = txf('badge.friend', 'Teman');
  const tag = mine ? `<span class="pgtag${p.priv === 'friends' ? ' fr' : ''}">${p.priv === 'friends' ? tFr : txf('pg.public', 'Publik')}</span>` : (p.priv === 'friends' ? `<span class="pgtag fr">${tFr}</span>` : '');
  const del = mine ? `<button type="button" class="ibtn pgdel" data-pg="del" data-id="${p.id}" title="${txf('pg.delTitle', 'Hapus postingan')}" aria-label="${txf('pg.delTitle', 'Hapus postingan')}">✕</button>` : '';
  const img = pgCarouselHtml(p) + pgFilesHtml(p.files, p.id, !mine && p.nodl === true);
  const hasF = Array.isArray(p.files) && p.files.length > 0, off = p.nodl === true; // 3b: tombol hanya untuk pemilik dan hanya bila ada lampiran
  const dl = mine && hasF ? `<button type="button" class="pgtag pgdlbtn${off ? ' off' : ''}" data-pg="dl" data-id="${p.id}" aria-pressed="${off ? 'false' : 'true'}" title="${off ? txf('pg.dlOffTitle', 'Unduhan lampiran mati: ketuk untuk menyalakan') : txf('pg.dlOnTitle', 'Unduhan lampiran aktif: ketuk untuk mematikan')}"${f.dlBusy && f.dlBusy[p.id] ? ' disabled' : ''}>${off ? txf('pg.dlOff', 'Unduhan: mati') : txf('pg.dlOn', 'Unduhan: aktif')}</button>` : '';
  return `<div class="pgpost" data-pid="${p.id}"><div class="pgmeta"><span>${esc(dayLabel(p.ts))} · ${esc(hm(p.ts))}</span>${tag}${dl}${del}</div><div class="pgtxt">${body}</div>${img}${more ? `<div class="more">${more}</div>` : ''}${pgRxHtml(p)}${pgCmtHtml(p)}</div>`;
}

function renderFeed() {
  const f = pgF; if (!f) return;
  const cf = pgCmtFocusGet(); // fokus kotak komentar dijaga lintas gambar ulang (37)
  const live = []; for (const k of pgVd.values()) if (k.el && k.el.paused === false) live.push(k.el); // innerHTML melepas elemen video (peramban menjedanya): yang sedang jalan dilanjutkan
  $('pglist').innerHTML = f.items.map((p) => pgPostHtml(p, f.mine)).join('');
  if (typeof pgCarRestore === 'function') pgCarRestore();
  { const L = $('pglist'); if (L && typeof L.querySelectorAll === 'function') for (const s of L.querySelectorAll('[data-pgvk]')) { const k = pgVd.get(pgId + ':' + s.dataset.pgvk); if (k && k.el) s.appendChild(k.el); } }
  for (const e of live) { try { const r = e.play(); if (r && r.catch) r.catch(() => {}); } catch (x) {} }
  let foot = '';
  if (f.skipped) foot += `<div class="pgnote">${tnf('pg.skipped', f.skipped, '{count} postingan tidak bisa ditampilkan (jenis yang belum didukung aplikasimu).', { count: fmt(f.skipped) })}</div>`;
  if (f.busy) foot += `<div class="pgnote">${f.items.length ? txf('pg.loading', 'Memuat…') : txf('pg.loadingPage', 'Memuat halaman…')}</div>`;
  else if (f.err) foot += `<div class="pgerr" role="alert">${esc(f.err.msg)}${PG_NORETRY[f.err.code] ? '' : '<div class="row"><button class="sec" data-pg="retry">' + txf('common.retry', 'Coba lagi') + '</button></div>'}</div>`;
  else if (f.loaded && !f.items.length) foot += `<div class="pgnote">${f.mine ? txf('pg.emptyMine', 'Belum ada postingan. Tulis yang pertama di atas.') : txf('pg.emptyOther', 'Belum ada postingan yang bisa kamu lihat.')}</div>`;
  else if (f.next) foot += '<div class="row"><button class="sec" data-pg="more-feed">' + txf('pg.loadMore', 'Muat lagi') + '</button></div>';
  else if (f.items.length) foot += '<div class="pgnote">' + txf('pg.end', 'Sudah sampai postingan paling awal.') + '</div>';
  $('pgfoot').innerHTML = foot;
  pgCmtFocusPut(cf || (f.cmWant ? (typeof f.cmWant === 'object' ? f.cmWant : { id: f.cmWant }) : null)); f.cmWant = null;
  if (f.mine) { const b = $('pgsend'); if (b) b.disabled = !!f.posting; const g = $('pgimg'); if (g) g.disabled = !!f.posting || pgImgs.length >= PG_IMG_MAX; const h = $('pgfile'); if (h) h.disabled = !!f.posting || pgFiles.length >= PG_FILE_MAX; const v = $('pgvid'); if (v) v.disabled = !!f.posting || pgVids.length >= PG_VID_MAX; }
  const hc = $('pgcount'); if (hc && !f.mine && f.count != null) hc.textContent = tnf('pg.count', f.count, '{count} postingan', { count: fmt(f.count) });
  // Layar belum penuh tapi masih ada halaman: lanjutkan sendiri (tidak ada scroll yang bisa memicu).
  const bx = $('pgbox');
  if (f.next && !f.busy && !f.err && bx && bx.clientHeight > 0 && bx.scrollHeight <= bx.clientHeight + 1) Promise.resolve().then(() => pgLoad());
}

async function pgLoad() {
  const f = pgF; if (!f || f.busy || f.done) return;
  f.busy = true; f.err = null; renderFeed();
  const tok = pgTok, id = pgId, o = { limit: PG_LIMIT }; if (f.next) o.after = f.next;
  let r;
  try { r = f.mine ? await window.api.pgMine(o) : await window.api.pgList(id, o); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (r && r.ok && !f.mine && !o.after && typeof pgNewRefresh === 'function') pgNewRefresh(); // 5b-4c: Core menandai dilihat saat halaman pertama dibuka; segarkan lencana walau layar sudah ditutup
  if (tok !== pgTok || pgF !== f) return; // layar ditutup / pindah selagi menunggu
  f.busy = false;
  if (!r || !r.ok) f.err = { code: r && r.code, msg: pgMsg(r) };
  else {
    for (const p of r.items || []) if (!f.ids.has(p.id)) { f.ids.add(p.id); f.items.push(p); }
    f.next = r.next || null; f.done = !f.next; f.loaded = true;
    if (r.count != null) f.count = r.count;
    if (r.skipped) f.skipped += r.skipped;
  }
  renderFeed();
}

async function pgFull(id) {
  const f = pgF, tok = pgTok; if (!f || f.full[id] === 0) return;
  f.full[id] = 0; renderFeed();
  let r; try { r = await window.api.pgGet(pgId, id); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f) return;
  delete f.full[id];
  if (r && r.ok && r.post) f.full[id] = { text: r.post.text }; else toast(r && r.ok ? txf('pg.gone', 'Postingan ini sudah tidak tersedia.') : pgMsg(r));
  renderFeed();
}

async function pgDel(id) {
  const f = pgF, tok = pgTok; if (!f || !f.mine) return;
  if (!await ask(txf('pg.delConfirm', 'Hapus postingan ini?\n\nTidak bisa dibatalkan.'))) return;
  let r; try { r = await window.api.pgRemove(id); } catch (x) { r = { ok: false, err: txf('pg.delFail', 'Gagal menghapus.') }; }
  if (!(r && r.ok)) { toast((r && r.err) || txf('pg.delFail', 'Gagal menghapus.')); return; }
  if (tok !== pgTok || pgF !== f) return;
  pgVdClear(pgId + ':' + id + ':'); f.items = f.items.filter((p) => p.id !== id); delete f.cm[id]; renderFeed(); // id tetap di f.ids: postingan yang sudah terhapus tidak boleh muncul lagi dari halaman lama
}

function pgSkeleton(me) {
  const comp = me ? `<div class="pgcomp"><textarea id="pgtxt" rows="3" placeholder="${txf('pg.ph', 'Tulis postingan baru...')}" aria-label="${txf('pg.postAria', 'Postingan baru')}">${esc(pgDraft)}</textarea><div class="pgcrow"><select id="pgpriv" aria-label="${txf('pg.privAria', 'Siapa yang bisa melihat')}"><option value="public">${txf('pg.privPublic', 'Publik: semua peer')}</option><option value="friends">${txf('pg.privFriends', 'Teman saja')}</option></select><button type="button" class="ibtn pgatt" id="pgimg" data-pg="img" title="${txf('pg.addImg', 'Tambah gambar')}" aria-label="${txf('pg.addImg', 'Tambah gambar')}">${PG_ICO.img}<span class="pgbadge" id="pgimgn" hidden></span></button><button type="button" class="ibtn pgatt" id="pgfile" data-pg="file" title="${txf('pg.addFile', 'Tambah berkas')}" aria-label="${txf('pg.addFile', 'Tambah berkas')}">${PG_ICO.file}<span class="pgbadge" id="pgfilen" hidden></span></button><button type="button" class="ibtn pgatt" id="pgvid" data-pg="vid" title="${txf('pg.addVid', 'Tambah video')}" aria-label="${txf('pg.addVid', 'Tambah video')}">${PG_ICO.vid}<span class="pgbadge" id="pgvidn" hidden></span></button><button id="pgsend" data-pg="post">${txf('common.send', 'Kirim')}</button></div><div id="pgimgrow" class="pgimgrow"></div><div id="pgfilerow" class="pgimgrow"></div><div id="pgvidrow" class="pgimgrow"></div><label id="pgdlrow" class="pgdlrow" hidden><input type="checkbox" id="pgdl" checked> ${txf('pg.dlAllow', 'Izinkan unduh lampiran')}</label><div id="pgcerr" class="pgcerr" role="alert"></div></div>` : '';
  $('pgbody').innerHTML = `<div class="pghd"><b>${me ? esc(txf('pg.mine', 'Halamanku')) : txf('pg.of', 'Halaman {name}', { name: esc(nameOf(pgId)) })}</b><span id="pgcount" class="tg"></span>${me ? '<button type="button" class="pib" id="pgarcbtn" data-pg="arc" title="' + esc(txf('pg.arc', 'Cadangan')) + '" aria-label="' + esc(txf('pg.arc', 'Cadangan')) + '" hidden>' + (typeof icn === 'function' ? icn('db') : '') + '</button>' : ''}${pgIb('x', txf('common.close', 'Tutup'), 'data-pg="close"')}</div>${me ? '<div id="pgarc" class="pgarc" hidden></div>' : ''}${comp}<div id="pglist"></div><div id="pgfoot"></div>`;
  if (me) { pgImgUi(); pgFileUi(); pgVidUi(); pgArcUi(); }
}

function renderPage() { $('pgmodal').style.display = pgId ? 'flex' : 'none'; }
function pgOpen(id) {
  const me = !!(S.me && id === S.me.id);
  pgTok++; pgId = id; pgVdClear();
  for (const [k, v] of pgDl) if (v.state !== 'run') pgDl.delete(k); // hasil unduhan lama tidak terbawa ke layar baru; yang masih berjalan tetap
  if (!pgDlWired && window.api && typeof window.api.onPgDl === 'function') { pgDlWired = true; window.api.onPgDl(pgDlEvent); }
  pgF = { mine: me, items: [], ids: new Set(), next: null, count: null, skipped: 0, busy: false, done: false, err: null, loaded: false, open: new Set(), full: {}, posting: false, cm: {}, cmWant: null, car: {} };
  pgSkeleton(me); renderPage(); renderFeed();
  const bx = $('pgbox'); if (bx) bx.scrollTop = 0;
  pgLoad();
  if (typeof pgSyncStart === 'function') pgSyncStart(); // 5d-8: segarkan komentar / reaksi selagi layar terbuka
}
function pgClose() {
  const t = $('pgtxt'); if (pgId && t && typeof t.value === 'string') pgDraft = t.value;
  if (typeof pgSyncStop === 'function') pgSyncStop();
  pgTok++; pgId = null; pgF = null; pgVdClear(); renderPage(); $('pgbody').innerHTML = '';
}

$('pmodal').addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-pg="open"]');
  if (b && profId) pgOpen(profId);
});
$('pgmodal').addEventListener('click', (e) => {
  if (e.target === $('pgmodal')) { pgClose(); return; }
  const b = e.target.closest && e.target.closest('[data-pg]');
  if (!b || !pgF) return;
  const a = b.dataset.pg, id = b.dataset.id;
  if (a === 'close') pgClose();
  else if (a === 'post') pgPost();
  else if (a === 'img') pgPick();
  else if (a === 'file') pgPickFile();
  else if (a === 'vid') pgPickVideo();
  else if (a === 'vidx') { const i = Number(b.dataset.i); if (!pgF.posting && Number.isInteger(i) && i >= 0 && i < pgVids.length) { pgVids.splice(i, 1); pgVidUi(); } }
  else if (a === 'filex') { const i = Number(b.dataset.i); if (!pgF.posting && Number.isInteger(i) && i >= 0 && i < pgFiles.length) { pgFiles.splice(i, 1); pgFileUi(); } }
  else if (a === 'imgx') { const i = Number(b.dataset.i); if (!pgF.posting && Number.isInteger(i) && i >= 0 && i < pgImgs.length) { pgImgs.splice(i, 1); pgImgUi(); } } // sedang mengirim: daftar dibekukan
  else if (a === 'retry' || a === 'more-feed') pgLoad();
  else if (a === 'more' && id) { pgF.open.has(id) ? pgF.open.delete(id) : pgF.open.add(id); renderFeed(); }
  else if (a === 'full' && id) pgFull(id);
  else if (a === 'cgo') pgCarGo(b.dataset.pid, Number(b.dataset.d) || 0);
  else if (a === 'view') pgView(b.dataset.pid, b.dataset.mid);
  else if (a === 'vplay') pgVideoGo(b.dataset.pid, b.dataset.vid);
  else if (a === 'fget') pgFileGo(b.dataset.pid, b.dataset.fid);
  else if (a === 'fcancel') pgFileStop(b.dataset.pid, b.dataset.fid);
  else if (a === 'dl' && id) pgToggleDl(id);
  else if (a === 'arc') pgArcToggle();
  else if (a && a.slice(0, 3) === 'arc') pgArcClick(a);
  else if (a === 'rx' && id) pgRx(id, b.dataset.e);
  else if (a === 'rxadd' && id) pgRxMenu(id);
  else if (a === 'who' && id) pgWho(id);
  else if (a === 'crx' && id) pgCmtRx(id, b.dataset.cid, b.dataset.e);
  else if (a === 'crxadd' && id) pgCmtRxMenu(id, b.dataset.cid);
  else if (a === 'cwho' && id) pgCmtWho(id, b.dataset.cid);
  else if (a === 'cmt' && id) pgCmtToggle(id);
  else if (a === 'cmore' && id) pgCmtLoad(id);
  else if (a === 'csend' && id) pgCmtSend(id);
  else if (a === 'creply' && id) pgCmtReplyToggle(id, b.dataset.cid);
  else if (a === 'rsend' && id) pgCmtReplySend(id);
  else if (a === 'rcancel' && id) pgCmtReplyCancel(id);
  else if (a === 'cdel' && id) pgCmtDel(id, b.dataset.cid);
  else if (a === 'cmydel' && id) pgCmtDelMine(id, b.dataset.cid);
  else if (a === 'del' && id) pgDel(id);
});
$('pgmodal').addEventListener('keydown', (e) => {
  if (!((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target)) return;
  if (e.target.id === 'pgtxt') { e.preventDefault(); pgPost(); }
  else if (e.target.dataset && e.target.dataset.pg === 'ctxt') { e.preventDefault(); pgCmtSend(e.target.dataset.id); }
  else if (e.target.dataset && e.target.dataset.pg === 'rtxt') { e.preventDefault(); pgCmtReplySend(e.target.dataset.id); }
});
$('pglist').addEventListener('scroll', (e) => { const t = e.target; if (t && t.classList && t.classList.contains('pgtrack')) pgCarSync(t.parentNode); }, true); // scroll tidak menggelembung: tangkap di fase capture
$('pgbox').addEventListener('scroll', () => { const b = $('pgbox'), f = pgF; if (f && f.next && !f.busy && !f.err && b.scrollHeight - b.scrollTop - b.clientHeight < PG_NEAR) pgLoad(); });
if (document.addEventListener) document.addEventListener('keydown', (e) => { if (pgId && e.key === 'Escape') { e.preventDefault(); pgClose(); } });
