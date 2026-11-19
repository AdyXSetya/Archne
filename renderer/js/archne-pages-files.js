// Halaman, lampiran di feed (dipecah dari archne-pages.js, 3d-a): kartu berkas, unduhan (progres / batal / galat, event pgdl), dan toggle unduh per postingan (pgToggleDl, pgMarkNodl).
// Skrip global biasa; dimuat setelah archne-pages-media.js. Memakai pgF, pgId, pgTok, PG_HEX16, PG_ERR, PG_NORETRY, renderFeed dari archne-pages.js dan PG_FILE_MAX dari archne-pages-compose.js (saat dipakai, bukan saat dimuat). FileCard (archne-filecard.js) dimuat lebih dulu di archne-index.html.
// ---- lampiran di feed (3a-7): kartu berkas + Unduh / progres / Batal / galat ----
// Memakai ulang FileCard (archne-filecard.js: ikon, fmtSize, progressText, isRisky, esc) dan kelas .fc/.fcg/.fb/.fs/.bar dari css/archne-filecard.css. Unduhan berjalan di Core (pgFileGet, 3a-5b); kemajuannya datang lewat event pgdl.
// pgDl: `${peerId}:${postId}:${fileId}` -> { id, state: 'run'|'done'|'err'|'none', done, total, name, code, msg, cancelling }. Kunci memakai id peer + postingan + berkas (bukan id unduhan) karena event bisa tiba SEBELUM balasan pgFileGet.
// Yang diunduh selalu diambil dari pgF.items (bukan atribut DOM); id harus 16 heks. Jalur lokal tidak ada di renderer: hasil hanya menampilkan nama; belum ada "Tampilkan di folder". Unduhan tetap jalan bila layar ditutup; dibuka lagi = state terbawa (yang bukan 'run' dibuang saat dibuka).
// Getter (seperti PG_ERR di archne-pages.js): teks mengikuti bahasa aktif saat dibaca.
const PG_FERR = {
  get many() { return txf('pg.fErr.many', 'Terlalu banyak unduhan berjalan. Tunggu salah satunya selesai.'); },
  get gone() { return txf('pg.fErr.gone', 'Pemilik berhenti menyediakan berkas ini.'); },
  get cancel() { return txf('pg.fErr.cancel', 'Unduhan dibatalkan.'); },
  get nodl() { return txf('pg.fErr.nodl', 'Pemilik mematikan unduhan untuk postingan ini.'); },
};
const PG_FNORETRY = { old: 1, blocked: 1, peer: 1, bad: 1, nodl: 1 };
let PG_DL_GRACE = 1500; // bila Core menjawab "tidak ada unduhan berjalan" saat batal, tunggu sebentar kejadian akhir yang mungkin masih di jalan, lalu kembali ke tombol Unduh
const pgDl = new Map();
let pgDlWired = false;
const pgDlMsg = (code, err) => PG_ERR[code] || PG_FERR[code] || (typeof err === 'string' && err ? err.slice(0, 200) : txf('pg.dlFail', 'Gagal mengunduh berkas.'));
// nodl (3b) = pemilik mematikan unduhan postingan ini (dan yang melihat bukan pemilik): kartu tetap tampil (nama, ukuran) tetapi tanpa tombol Unduh, dengan catatan. Unduhan yang sudah berjalan tetap menampilkan progres / Batal sampai Core menghentikannya.
function pgFilesHtml(files, pid, nodl) {
  if (!Array.isArray(files) || !files.length || typeof FileCard === 'undefined' || !PG_HEX16.test(String(pid))) return '';
  const FC = FileCard, btn = (a, ic, label, cls) => `<button type="button" class="fb ic-btn${cls ? ' ' + cls : ''}" data-pg="${a}" data-pid="${pid}" data-fid="__F__" title="${FC.esc(label)}" aria-label="${FC.esc(label)}">${FC.ico(ic)}</button>`;
  const rows = [];
  for (const x of files.slice(0, PG_FILE_MAX)) {
    if (!x || typeof x !== 'object' || !PG_HEX16.test(String(x.id)) || typeof x.name !== 'string' || !Number.isSafeInteger(x.size) || x.size <= 0) continue;
    const k = pgDl.get(pgId + ':' + pid + ':' + x.id), nm = FC.esc(x.name), key = pid + '-' + x.id;
    let info = FC.esc(FC.fmtSize(x.size)), act = '', note = '', bar = '', sb = (a, ic, l, c) => btn(a, ic, l, c).replace('__F__', x.id);
    if (!nodl && FC.isRisky(x.name)) note += `<div class="fs warn">${FC.ico('warn')}<span>${txf('pg.fRisky', 'Berkas ini bisa dijalankan (mis. program atau skrip). Unduh hanya jika kamu mengenal pemilik halaman ini.')}</span></div>`;
    if (k && k.state === 'run') {
      info = `<span id="pgdlt-${key}">${FC.esc(FC.progressText('download', k.done, k.total))}</span>`;
      bar = `<div class="bar"><i id="pgdlb-${key}" style="width:${FC.pct(k.done, k.total)}%"></i></div>`;
      act = k.cancelling ? sb('fcancel', 'x', txf('pg.fCancelling', 'Membatalkan…'), 'sec').replace('<button', '<button disabled') : sb('fcancel', 'x', txf('common.cancel', 'Batal'), 'sec');
    } else if (k && k.state === 'done') {
      info = txf('pg.fSaved', 'Tersimpan: {name} · {size}', { name: FC.esc(k.name || x.name), size: FC.esc(FC.fmtSize(x.size)) }); act = sb('fget', 'dl', txf('pg.fAgain', 'Unduh lagi'), 'sec');
    } else if (k && k.state === 'none') note += `<div class="fs warn">${FC.ico('warn')}<span>${txf('pg.fGone', 'Berkas ini sudah tidak tersedia.')}</span></div>`;
    else if (k && k.state === 'err') {
      note += `<div class="fs ${k.code === 'cancel' ? '' : 'err'}">${k.code === 'cancel' ? '' : FC.ico('warn')}<span>${FC.esc(k.msg)}</span></div>`;
      if (!PG_FNORETRY[k.code]) act = sb('fget', 'retry', txf('common.retry', 'Coba lagi'), 'sec');
    } else if (nodl) note += `<div class="fs">${FC.ico('warn')}<span>${PG_FERR.nodl}</span></div>`;
    else act = sb('fget', 'dl', txf('pg.fGet', 'Unduh'), '');
    rows.push(`<div class="fc fcg" data-pf="${x.id}"><div class="frow"><span class="fk" data-k="file">${FC.ico('file')}</span><div class="fmid"><div class="fn" title="${nm}">${nm}</div><div class="fi">${info}</div></div>${act ? `<div class="fact">${act}</div>` : ''}</div>${bar}${note}</div>`);
  }
  return rows.length ? `<div class="pgfiles">${rows.join('')}</div>` : '';
}
function pgDlEvent(p) {
  if (!p || typeof p !== 'object' || !['id', 'peerId', 'postId', 'fileId'].every((n) => PG_HEX16.test(String(p[n])))) return;
  const key = p.peerId + ':' + p.postId + ':' + p.fileId, k = pgDl.get(key);
  if (!k || k.state !== 'run' || (k.id !== undefined && k.id !== p.id)) return; // bukan unduhan kita / basi
  k.id = p.id;
  if (p.phase === 'progress') {
    if (!Number.isFinite(p.done) || !Number.isFinite(p.total) || p.total <= 0 || p.done < 0) return;
    k.done = Math.min(p.done, p.total); k.total = p.total;
    const sfx = p.postId + '-' + p.fileId, t = $('pgdlt-' + sfx), b = $('pgdlb-' + sfx); // diperbarui di tempat: feed tidak digambar ulang tiap 120 ms
    if (t) t.textContent = FileCard.progressText('download', k.done, k.total);
    if (b && b.style) b.style.width = FileCard.pct(k.done, k.total) + '%';
    return;
  }
  if (p.phase === 'done') { k.state = 'done'; k.name = typeof p.name === 'string' ? p.name.slice(0, 255) : ''; }
  else if (p.phase === 'none') k.state = 'none';
  else if (p.phase === 'error') { k.state = 'err'; k.code = typeof p.code === 'string' ? p.code.slice(0, 20) : ''; k.msg = pgDlMsg(k.code, p.err); if (k.code === 'nodl') pgMarkNodl(p.peerId, p.postId); }
  else return;
  if (pgF) renderFeed();
}
async function pgFileGo(pid, fid) {
  const f = pgF, peer = pgId; if (!f || !peer || !PG_HEX16.test(String(pid)) || !PG_HEX16.test(String(fid))) return;
  const post = f.items.find((p) => p.id === pid), ent = post && Array.isArray(post.files) ? post.files.find((x) => x && x.id === fid) : null; if (!ent || typeof ent.name !== 'string' || !Number.isSafeInteger(ent.size) || ent.size <= 0) return; // sama dengan syarat kartu di pgFilesHtml
  if (post.nodl && !f.mine) return; // 3b: kartunya tidak punya tombol Unduh; ini lapis kedua
  const key = peer + ':' + pid + ':' + fid, cur = pgDl.get(key); if (cur && cur.state === 'run') return;
  const k = { id: undefined, state: 'run', done: 0, total: ent.size, cancelling: false }; pgDl.set(key, k); renderFeed();
  let r; try { r = await window.api.pgFileGet(peer, pid, fid); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (pgDl.get(key) !== k) return;
  if (!r || !r.ok || !PG_HEX16.test(String(r.id))) { if (k.state === 'run') { k.state = 'err'; k.code = r && typeof r.code === 'string' ? r.code : ''; k.msg = pgDlMsg(k.code, r && r.err); if (k.code === 'nodl') pgMarkNodl(peer, pid); } }
  else { if (k.id === undefined) k.id = r.id; if (k.cancelling && k.state === 'run') pgDlCancel(key, k); }
  if (pgF) renderFeed();
}
async function pgFileStop(pid, fid) {
  if (!pgId || !PG_HEX16.test(String(pid)) || !PG_HEX16.test(String(fid))) return;
  const key = pgId + ':' + pid + ':' + fid, k = pgDl.get(key); if (!k || k.state !== 'run' || k.cancelling) return;
  k.cancelling = true; renderFeed();
  if (k.id !== undefined) pgDlCancel(key, k); // id belum ada = balasan pgFileGet belum tiba; pgFileGo membatalkan begitu id-nya ada
}
async function pgDlCancel(key, k) {
  let r; try { r = await window.api.pgFileCancel(k.id); } catch (e) { r = null; }
  if (!r || !r.ok || r.cancelled === false) setTimeout(() => { if (pgDl.get(key) === k && k.state === 'run') { pgDl.delete(key); if (pgF) renderFeed(); } }, PG_DL_GRACE);
}

// Toggle unduh (3b). pgMarkNodl: Core melapor 'nodl' untuk sebuah postingan yang feed-nya masih menganggap boleh (pemilik mematikannya sesudah feed dimuat): tandai di feed supaya kartunya berganti. Hanya feed yang sedang terbuka milik peer itu.
function pgMarkNodl(peer, pid) {
  const f = pgF; if (!f || f.mine || peer !== pgId) return;
  const p = f.items.find((x) => x.id === pid); if (p) p.nodl = true;
}
// Pemilik: nyalakan / matikan unduhan lampiran sebuah postingannya. Memakai keadaan yang dikembalikan Core (bukan menebak), jadi tombol selalu sama dengan yang berlaku.
async function pgToggleDl(id) {
  const f = pgF, tok = pgTok; if (!f || !f.mine || !PG_HEX16.test(String(id))) return;
  const p = f.items.find((x) => x.id === id); if (!p || f.dlBusy && f.dlBusy[id]) return;
  (f.dlBusy || (f.dlBusy = {}))[id] = true; renderFeed();
  let r; try { r = await window.api.pgSetDl(id, !!p.nodl); } catch (e) { r = { ok: false, err: txf('pg.dlSetFail', 'Gagal mengubah pengaturan unduhan.') }; } // p.nodl benar = sekarang mati -> minta allow=true
  if (f.dlBusy) delete f.dlBusy[id];
  if (tok !== pgTok || pgF !== f) return;
  if (!r || !r.ok) toast((r && r.err) || txf('pg.dlSetFail', 'Gagal mengubah pengaturan unduhan.'));
  else if (!r.found) { f.items = f.items.filter((x) => x.id !== id); toast(txf('pg.noPost', 'Postingan ini sudah tidak ada.')); }
  else if (r.nodl) p.nodl = true; else delete p.nodl;
  renderFeed();
}
