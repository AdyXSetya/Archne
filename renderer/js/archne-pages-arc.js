// Halaman (5d-6): cadangan — ekspor semua postingan ke satu berkas arsip dan impor dari arsip, di panel kecil pada "Halamanku". Skrip global biasa; dimuat setelah archne-pages-cmt.js.
// Semua kerja (dialog berkas, ekspor, impor, verifikasi) ada di proses utama lewat IPC pgArc*; di sini hanya tampilan dan keadaan. Renderer tidak pernah melihat jalur berkas, hanya nama berkas dan angka.
// Alur: Ekspor -> dialog simpan -> progres -> ringkasan. Impor -> dialog buka -> PRATINJAU (apa yang akan masuk, tanpa menulis apa pun) -> konfirmasi -> progres -> ringkasan.
// Keadaan hidup di pgArcS (bukan di DOM): pekerjaan terus berjalan walau layar Halamanku ditutup, dan panel menyusul keadaan terakhir saat dibuka lagi. Tombol disembunyikan di perangkat tanpa dialog berkas (canArchive dari getSettings).
const PG_ARC_ERR = { // getter: mengikuti bahasa aktif saat dibaca (jangan disalin ke const saat load)
  get busy() { return txf('arc.err.busy', 'Ekspor atau impor lain sedang berjalan. Tunggu sampai selesai.'); },
  get nodialog() { return txf('arc.err.nodialog', 'Perangkat ini tidak punya pemilih berkas, jadi cadangan tidak tersedia.'); },
  get gone() { return txf('arc.err.gone', 'Arsip belum dipilih atau sudah dipakai. Pilih arsipnya lagi.'); },
  get bad() { return txf('arc.err.bad', 'Berkas ini bukan arsip Halaman yang sah.'); },
  get hash() { return txf('arc.err.hash', 'Isi arsip rusak (hash tidak cocok).'); },
  get limit() { return txf('arc.err.limit', 'Arsip terlalu besar untuk diproses.'); },
};
let pgArcS = { can: null, open: false, phase: 'idle', kind: null, job: null, token: null, name: '', sum: null, prog: null, res: null, err: null, cm: true, cmImp: true };
let pgArcWired = false, pgArcBoot = false;
const pgArcSz = (n) => (typeof FileCard !== 'undefined' && FileCard.fmtSize ? FileCard.fmtSize(n) : fmt(n) + ' B');
const pgArcMsg = (r) => (r && PG_ARC_ERR[r.code]) || (r && r.err) || txf('arc.fail', 'Gagal memproses arsip.');
const pgArcN = (n) => fmt(Number.isFinite(n) ? n : 0);
// Kata benda berjamak: pgArcC(kunci, cadangan, n) -> mis. "1 post" / "3 posts" (kunci .one/.other, param {count} sudah diformat).
const pgArcC = (k, fb, n) => { const v = Number.isFinite(n) ? n : 0; return tnf(k, v, fb, { count: pgArcN(v) }); };
function pgArcDate(ts) { try { return new Date(ts).toLocaleString(typeof I18N !== 'undefined' && typeof uiLoc === 'function' ? uiLoc() : 'id-ID'); } catch (e) { return ''; } }

// Kalimat tentang komentar. c = comments dari ringkasan (pratinjau) atau hasil (impor).
function pgArcCmLine(c) {
  if (!c || c.status === 'none') return '';
  const n = (x) => pgArcN(x || 0);
  if (c.status === 'skipped') {
    if (c.why === 'owner') return txf('arc.cm.owner', 'Komentar di arsip ({items}, {tombs}) tidak dibawa: arsip ini dibuat oleh identitas lain, dan tanda tangan komentar hanya sah di identitas yang sama.', { items: pgArcC('arc.nComments', '{count} komentar', c.items || 0), tombs: pgArcC('arc.nDeletions', '{count} penghapusan', c.tombs || 0) });
    if (c.why === 'abort') return txf('arc.cm.abort', 'Komentar menunggu: impor dibatalkan. Impor ulang arsip yang sama untuk melengkapinya.');
    return txf('arc.cm.skip', 'Komentar tidak dipulihkan.');
  }
  if (c.status === 'bad') return txf('arc.cm.bad', 'Komentar di arsip rusak dan tidak diimpor. Postingan tidak terpengaruh.');
  if (c.status === 'pending') return txf('arc.cm.pending', 'Komentar belum sempat diproses. Impor ulang arsip yang sama untuk melengkapinya.');
  if (c.status === 'done') {
    const drop = (c.bad || 0) + (c.ts || 0) + (c.full || 0) + (c.orphan || 0) + (c.removed || 0);
    return drop
      ? txf('arc.cm.doneDrop', 'Komentar: {added} dipulihkan, {same} sudah ada, {drop} dibuang (tanda tangan tak sah, sudah dihapus, atau melebihi batas).', { added: n(c.added), same: n(c.same), drop: n(drop) })
      : txf('arc.cm.done', 'Komentar: {added} dipulihkan, {same} sudah ada.', { added: n(c.added), same: n(c.same) });
  }
  return '';
}

// 5h: kalimat tentang reaksi. r = reactions dari ringkasan (pratinjau) atau hasil (impor).
function pgArcRxLine(r) {
  if (!r || r.status === 'none') return '';
  const n = (x) => pgArcN(x || 0), o = { posts: n(r.posts), cmts: n(r.cmts) };
  if (r.status === 'skipped') {
    if (r.why === 'owner') return txf('arc.rx.owner', 'Reaksi di arsip ({posts} pada postingan, {cmts} pada komentar) tidak dibawa: arsip ini dibuat oleh identitas lain.', o);
    if (r.why === 'abort') return txf('arc.rx.abort', 'Reaksi menunggu: impor dibatalkan. Impor ulang arsip yang sama untuk melengkapinya.');
    return txf('arc.rx.skip', 'Reaksi tidak dipulihkan.');
  }
  if (r.status === 'bad') return txf('arc.rx.bad', 'Reaksi di arsip rusak dan tidak diimpor. Postingan tidak terpengaruh.');
  if (r.status === 'pending') return txf('arc.rx.pending', 'Reaksi belum sempat diproses. Impor ulang arsip yang sama untuk melengkapinya.');
  if (r.status === 'done') {
    const a = r.post || {}, b = r.cmt || {}, sum = (k) => (a[k] || 0) + (b[k] || 0);
    return txf('arc.rx.done', 'Reaksi: {added} dipulihkan, {updated} diperbarui, {same} sudah ada.', { added: n(sum('added')), updated: n(sum('updated')), same: n(sum('same')) });
  }
  return '';
}

function pgArcSumHtml(s, st) {
  const c = s.counts, cm = s.comments || {};
  const top = [`<b>${esc(s.name)}</b>`, esc(pgArcSz(s.size))];
  if (s.created) top.push(esc(txf('arc.createdAt', 'dibuat {date}', { date: pgArcDate(s.created) })));
  let h = `<div class="pgarcl">${top.join(' · ')}</div>`;
  const list = [`<b>${esc(txf('arc.pNew', '{count} baru', { count: pgArcN(c.new) }))}</b>`, esc(txf('arc.pSame', '{count} sudah ada', { count: pgArcN(c.same) }))];
  if (c.conflict) list.push(esc(txf('arc.pConflict', '{count} bentrok (dilewati)', { count: pgArcN(c.conflict) })));
  if (c.bad) list.push(esc(txf('arc.pBad', '{count} rusak (dilewati)', { count: pgArcN(c.bad) })));
  h += `<div class="pgarcl">${txf('arc.sumHead', '{total} di arsip: {list}.', { total: esc(pgArcC('arc.nPosts', '{count} postingan', c.total)), list: list.join(', ') })}</div>`;
  if (s.blobs.new || s.blobs.reuse) h += `<div class="pgarcl">${esc(txf('arc.newAtt', 'Lampiran baru: {count} ({size}).', { count: pgArcN(s.blobs.new), size: pgArcSz(s.blobs.bytesNew) }))}</div>`;
  if (s.ownerMatch === false) h += `<div class="pgarcl dim">${esc(txf('arc.otherId', 'Arsip ini dibuat oleh identitas lain. Postingannya tetap bisa diimpor sebagai salinan.'))}</div>`;
  if (cm.present) {
    if (cm.restorable && cm.status === 'ok') {
      const p = cm.plan || {};
      const o = { items: pgArcC('arc.nComments', '{count} komentar', cm.items || 0), tombs: pgArcC('arc.nDeletions', '{count} penghapusan', cm.tombs || 0), added: pgArcN(p.added) };
      const lbl = p.added != null ? txf('arc.restoreAdd', 'Pulihkan komentar ({items}, {tombs}; {added} akan ditambahkan)', o) : txf('arc.restore', 'Pulihkan komentar ({items}, {tombs})', o);
      h += `<label class="pgarcl"><input type="checkbox" id="pgarccmi" ${st.cmImp ? 'checked' : ''}> ${esc(lbl)}</label>`;
    } else h += `<div class="pgarcl dim">${esc(cm.status === 'bad' ? pgArcCmLine({ status: 'bad' }) : pgArcCmLine({ status: 'skipped', why: 'owner', items: cm.items, tombs: cm.tombs }))}</div>`;
  }
  const rx = s.reactions || {};
  if (rx.present) {
    if (rx.restorable && rx.status === 'ok') h += `<div class="pgarcl">${esc(txf('arc.rx.preview', 'Reaksi ikut dipulihkan ({posts} pada postingan, {cmts} pada komentar).', { posts: pgArcN(rx.posts), cmts: pgArcN(rx.cmts) }))}</div>`;
    else h += `<div class="pgarcl dim">${esc(rx.status === 'bad' ? pgArcRxLine({ status: 'bad' }) : pgArcRxLine({ status: 'skipped', why: 'owner', posts: rx.posts, cmts: rx.cmts }))}</div>`;
  }
  return h;
}

function pgArcResHtml(st) {
  const r = st.res; if (!r) return '';
  if (st.kind === 'export') {
    const parts = [pgArcC('arc.nPosts', '{count} postingan', r.posts), pgArcC('arc.nImages', '{count} gambar', r.media), pgArcC('arc.nFiles', '{count} lampiran', r.files), pgArcC('arc.nVideos', '{count} video', r.videos)];
    let h = `<div class="pgarcl">${txf('arc.expDone', 'Selesai: {parts} ({size}) disimpan sebagai {name}.', { parts: esc(parts.join(', ')), size: esc(pgArcSz(r.size)), name: `<b>${esc(r.name)}</b>` })}</div>`;
    if (r.skipped) h += `<div class="pgarcl dim">${esc(pgArcC('arc.expSkipped', '{count} postingan dilewati karena lampirannya hilang atau berubah saat disalin.', r.skipped))}</div>`;
    h += r.comments ? `<div class="pgarcl">${esc(txf('arc.expCm', 'Komentar ikut: {items}, {tombs}.', { items: pgArcC('arc.nComments', '{count} komentar', r.comments.items), tombs: pgArcC('arc.nDeletions', '{count} penghapusan', r.comments.tombs) }))}</div>` : `<div class="pgarcl dim">${esc(txf('arc.expNoCm', 'Komentar tidak ikut.'))}</div>`;
    h += r.reactions ? `<div class="pgarcl">${esc(txf('arc.expRx', 'Reaksi ikut: {posts} pada postingan, {cmts} pada komentar.', { posts: pgArcN(r.reactions.posts), cmts: pgArcN(r.reactions.cmts) }))}</div>` : `<div class="pgarcl dim">${esc(txf('arc.expNoRx', 'Belum ada reaksi untuk disimpan.'))}</div>`;
    return h;
  }
  const list = [`<b>${esc(pgArcC('arc.pImported', '{count} postingan masuk', r.imported))}</b>`, esc(txf('arc.pSame', '{count} sudah ada', { count: pgArcN(r.same) }))];
  if (r.conflict) list.push(esc(txf('arc.pConflictR', '{count} bentrok', { count: pgArcN(r.conflict) })));
  if (r.bad) list.push(esc(txf('arc.pBadR', '{count} rusak', { count: pgArcN(r.bad) })));
  if (r.failed) list.push(esc(txf('arc.pFailed', '{count} gagal disalin', { count: pgArcN(r.failed) })));
  let h = `<div class="pgarcl">${txf('arc.impHead', '{state}: {list}.', { state: r.aborted ? txf('arc.stCancelled', 'Dibatalkan') : txf('arc.done', 'Selesai'), list: list.join(', ') })}</div>`;
  if (r.blobs.written) h += `<div class="pgarcl">${esc(tnf('arc.blobsWritten', Number.isFinite(r.blobs.written) ? r.blobs.written : 0, '{count} lampiran ditulis ({size}).', { count: pgArcN(r.blobs.written), size: pgArcSz(r.blobs.bytes) }))}</div>`;
  const cl = pgArcCmLine(r.comments); if (cl) h += `<div class="pgarcl">${esc(cl)}</div>`;
  const rl = pgArcRxLine(r.reactions); if (rl) h += `<div class="pgarcl">${esc(rl)}</div>`;
  if (r.aborted || r.failed) h += `<div class="pgarcl dim">${esc(txf('arc.retry', 'Impor bisa diulang: yang sudah masuk dilewati dan sisanya dilengkapi.'))}</div>`;
  return h;
}

function pgArcHtml() {
  const st = pgArcS, busy = st.phase === 'picking';
  const head = `<div class="pgarct">${esc(txf('arc.title', 'Cadangan Halaman'))}</div>`;
  if (st.phase === 'idle' || st.phase === 'picking') {
    return head + `<div class="pgarcl dim">${esc(txf('arc.intro', 'Simpan semua postingan Halamanmu (beserta gambar, video, dan lampiran) ke satu berkas, atau pulihkan dari berkas yang pernah diekspor. Postingan yang sudah ada tidak pernah ditimpa.'))}</div>`
      + `<label class="pgarcl"><input type="checkbox" id="pgarccm" ${st.cm ? 'checked' : ''}${busy ? ' disabled' : ''}> ${esc(txf('arc.incCm', 'Sertakan komentar saat ekspor'))}</label>`
      + `<div class="pgarcl dim">${esc(txf('arc.cmNote', 'Komentar bertanda tangan dan hanya bisa dipulihkan di identitas yang sama dengan pemilik arsip.'))}</div>`
      + `<div class="row"><button class="sec" data-pg="arcexp"${busy ? ' disabled' : ''}>${esc(txf('arc.export', 'Ekspor…'))}</button><button class="sec" data-pg="arcimp"${busy ? ' disabled' : ''}>${esc(txf('arc.import', 'Impor…'))}</button><button class="sec" data-pg="arcx">${esc(txf('arc.closePanel', 'Tutup panel'))}</button></div>`;
  }
  if (st.phase === 'preview') {
    const s = st.sum, can = s.counts.new > 0 || (st.cmImp && s.comments && s.comments.plan && (s.comments.plan.added > 0 || s.comments.plan.tombAdded > 0)) || !!(s.reactions && s.reactions.restorable && s.reactions.plan && (s.reactions.plan.added > 0 || s.reactions.plan.updated > 0)) || !!(s.reactions && s.reactions.restorable && s.reactions.cmts > 0);
    return head + pgArcSumHtml(s, st) + `<div class="row"><button data-pg="arcgo"${can ? '' : ' disabled'}>${esc(s.counts.new ? pgArcC('arc.importN', 'Impor {count} postingan', s.counts.new) : txf('arc.importBtn', 'Impor'))}</button><button class="sec" data-pg="arcno">${esc(txf('common.cancel', 'Batal'))}</button></div>`
      + (can ? '' : `<div class="pgarcl dim">${esc(txf('arc.nothingNew', 'Tidak ada yang baru untuk diimpor.'))}</div>`);
  }
  if (st.phase === 'running') {
    const p = st.prog, pct = p && p.totalBytes > 0 ? Math.min(100, Math.floor((p.bytes / p.totalBytes) * 100)) : null;
    const lbl = esc(st.kind === 'export' ? txf('arc.exporting', 'Mengekspor…') : txf('arc.importing', 'Mengimpor…')) + (p ? ' ' + esc(tnf('arc.prog', Number.isFinite(p.total) ? p.total : 0, '{posts} / {total} postingan', { posts: pgArcN(p.posts), total: pgArcN(p.total) })) + (p.totalBytes ? ' · ' + esc(pgArcSz(p.bytes)) + ' / ' + esc(pgArcSz(p.totalBytes)) : '') : '');
    return head + `<div class="pgarcl">${lbl}</div><div class="pgarcbar"><i style="width:${pct == null ? 0 : pct}%"></i></div><div class="row"><button class="sec" data-pg="arccancel"${st.job ? '' : ' disabled'}>${esc(txf('common.cancelOp', 'Batalkan'))}</button></div>`;
  }
  if (st.phase === 'done') return head + pgArcResHtml(st) + `<div class="row"><button class="sec" data-pg="arcok">${esc(txf('arc.done', 'Selesai'))}</button></div>`;
  if (st.phase === 'error') {
    return head + `<div class="pgerr" role="alert">${esc(st.err || txf('arc.fail', 'Gagal memproses arsip.'))}</div>` + (st.res ? pgArcResHtml(st) : '') + `<div class="row"><button class="sec" data-pg="arcok">${esc(txf('common.close', 'Tutup'))}</button></div>`;
  }
  return '';
}

function pgArcRender() {
  const box = $('pgarc'), btn = $('pgarcbtn');
  if (btn) btn.hidden = pgArcS.can !== true;
  if (!box) return;
  box.hidden = !(pgArcS.can === true && (pgArcS.open || pgArcS.phase === 'running' || pgArcS.phase === 'preview'));
  if (!box.hidden) box.innerHTML = pgArcHtml();
}
function pgArcSet(p) { Object.assign(pgArcS, p); pgArcRender(); }

// Dipanggil tiap layar Halamanku dibuka: pasang pendengar sekali, cari tahu apakah cadangan tersedia, dan menyusul pekerjaan yang masih berjalan.
function pgArcUi() {
  if (!pgArcWired && window.api && typeof window.api.onPgArc === 'function') { pgArcWired = true; window.api.onPgArc(pgArcEvent); }
  pgArcRender();
  if (pgArcBoot) return;
  pgArcBoot = true;
  Promise.resolve().then(async () => {
    let g = null; try { g = await window.api.getSettings(); } catch (e) { g = null; }
    const can = !!(g && g.ok && g.canArchive === true && typeof window.api.pgArcExport === 'function');
    pgArcS.can = can;
    if (can && typeof window.api.pgArcState === 'function') {
      let r = null; try { r = await window.api.pgArcState(); } catch (e) { r = null; }
      if (r && r.ok && r.run && pgArcS.phase === 'idle') { pgArcS.phase = 'running'; pgArcS.kind = r.run.kind === 'import' ? 'import' : 'export'; pgArcS.job = r.run.job; pgArcS.prog = r.run.totalBytes != null ? { posts: r.run.posts || 0, total: r.run.total || 0, bytes: r.run.bytes || 0, totalBytes: r.run.totalBytes || 0 } : null; }
    }
    pgArcRender();
  }).catch(() => { pgArcBoot = false; });
}
function pgArcToggle() { if (pgArcS.can !== true) return; pgArcS.open = !pgArcS.open; pgArcRender(); }

async function pgArcExportGo() {
  if (pgArcS.phase !== 'idle') return;
  const cb = $('pgarccm'); if (cb && typeof cb.checked === 'boolean') pgArcS.cm = cb.checked;
  pgArcSet({ phase: 'picking', err: null, res: null });
  let r; try { r = await window.api.pgArcExport({ comments: pgArcS.cm }); } catch (e) { r = { ok: false, err: txf('arc.exportFail', 'Gagal memulai ekspor.') }; }
  if (!(r && r.ok)) { pgArcSet({ phase: 'idle' }); toast(pgArcMsg(r)); return; }
  if (!r.job) { pgArcSet({ phase: 'idle' }); return; } // dialog dibatalkan
  if (pgArcS.phase === 'done' || pgArcS.phase === 'error') return; // pekerjaan sudah selesai dan melapor sebelum balasan tiba
  pgArcSet({ phase: 'running', kind: 'export', job: r.job, name: r.name || '', prog: null });
}
async function pgArcOpenGo() {
  if (pgArcS.phase !== 'idle') return;
  pgArcSet({ phase: 'picking', err: null, res: null });
  let r; try { r = await window.api.pgArcOpen(); } catch (e) { r = { ok: false, err: txf('arc.openFail', 'Gagal membuka arsip.') }; }
  if (!(r && r.ok)) { pgArcSet({ phase: 'error', kind: 'import', err: pgArcMsg(r) }); return; }
  if (!r.token) { pgArcSet({ phase: 'idle' }); return; }
  pgArcSet({ phase: 'preview', kind: 'import', token: r.token, name: r.name || '', sum: r.summary, cmImp: true });
}
async function pgArcImportGo() {
  const st = pgArcS; if (st.phase !== 'preview' || !st.token) return;
  const cb = $('pgarccmi'); if (cb && typeof cb.checked === 'boolean') st.cmImp = cb.checked;
  const o = st.sum && st.sum.comments && st.sum.comments.restorable ? { comments: st.cmImp } : {};
  const tok = st.token;
  pgArcSet({ phase: 'running', kind: 'import', job: null, token: null, prog: null });
  let r; try { r = await window.api.pgArcImport(tok, o); } catch (e) { r = { ok: false, err: txf('arc.importFail', 'Gagal memulai impor.') }; }
  if (!(r && r.ok)) { pgArcSet({ phase: 'error', err: pgArcMsg(r) }); return; }
  if (pgArcS.phase === 'running') pgArcSet({ job: r.job });
}
async function pgArcCancelGo() {
  const j = pgArcS.job; if (!j) return;
  try { await window.api.pgArcCancel(j); } catch (e) {} // hasil akhir datang lewat event 'pgarc'
}
function pgArcClick(a) {
  if (a === 'arcexp') pgArcExportGo();
  else if (a === 'arcimp') pgArcOpenGo();
  else if (a === 'arcgo') pgArcImportGo();
  else if (a === 'arcno') pgArcSet({ phase: 'idle', token: null, sum: null });
  else if (a === 'arccancel') pgArcCancelGo();
  else if (a === 'arcok') pgArcSet({ phase: 'idle', res: null, err: null, sum: null, job: null });
  else if (a === 'arcx') pgArcSet({ open: false });
}

// Setelah impor yang memasukkan postingan: muat ulang daftar Halamanku (kotak tulis dan draf tidak disentuh).
function pgArcRefreshFeed() {
  const f = pgF; if (!f || !f.mine) return;
  pgTok++; f.items = []; f.ids = new Set(); f.next = null; f.done = false; f.loaded = false; f.busy = false; f.err = null; f.cm = {}; f.full = {}; f.open = new Set();
  renderFeed(); pgLoad();
}
function pgArcEvent(ev) {
  const st = pgArcS;
  if (!ev || typeof ev !== 'object' || typeof ev.job !== 'string' || (ev.kind !== 'export' && ev.kind !== 'import')) return;
  if (st.phase !== 'running' || (st.job && st.job !== ev.job)) return; // bukan pekerjaan kita (atau sudah ditutup)
  if (ev.phase === 'progress') {
    st.job = ev.job; st.kind = ev.kind; st.prog = { posts: ev.posts, total: ev.total, bytes: ev.bytes, totalBytes: ev.totalBytes };
    if (pgId) pgArcRender();
    return;
  }
  if (ev.phase !== 'done' && ev.phase !== 'cancel' && ev.phase !== 'error') return;
  st.job = null; st.kind = ev.kind;
  if (ev.phase === 'error') { st.phase = 'error'; st.err = pgArcMsg(ev); st.res = ev.result || null; }
  else if (ev.phase === 'cancel') { st.phase = ev.result ? 'done' : 'idle'; st.res = ev.result || null; if (!ev.result) toast(txf('arc.cancelled', 'Dibatalkan.')); }
  else { st.phase = 'done'; st.res = ev.result || null; }
  if (ev.kind === 'import' && ev.result && ev.result.imported > 0) pgArcRefreshFeed();
  if (!pgId) toast(ev.phase === 'done' ? (ev.kind === 'export' ? txf('arc.expToast', 'Ekspor halaman selesai.') : txf('arc.impToast', 'Impor halaman selesai.')) : ev.phase === 'error' ? pgArcMsg(ev) : txf('arc.cancelled', 'Dibatalkan.'));
  pgArcRender();
}
