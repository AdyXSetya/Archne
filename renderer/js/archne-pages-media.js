// Halaman, media di feed (dipecah dari archne-pages.js, 3d-a): gambar (thumbnail + sel tombol, grid), pembuka penampil gambar penuh (pgView), dan video (kartu + Putar -> <video> dari token penyaji).
// Skrip global biasa; dimuat setelah archne-pages-compose.js. Memakai pgF, pgId, pgTok, PG_HEX16, PG_ERR, PG_NORETRY, renderFeed dari archne-pages.js dan PG_IMG_MAX / PG_VID_MAX dari archne-pages-compose.js (semuanya saat dipakai, bukan saat dimuat).
// Media di feed (2b-3): thumbnail dari m.th (data: URI; CSP hanya mengizinkan img-src data:). Pemilik jauh tidak dipercaya: th harus base64 murni dan tidak terlalu panjang (wirePost/PageStore sudah memeriksa; ini lapis kedua).
// Tanpa th (gagal dibuat, atau postingan lama) tetap placeholder bernama.
// Gambar penuh (2d-5): tiap sel adalah tombol (data-pg="view") yang membuka penampil foto (openImgPage, js/archne-imgview.js) lewat api.pgImage. Sel hanya jadi tombol bila id postingan dan id gambar 16 heks;
// yang dipakai saat klik adalah entri di pgF.items (bukan atribut DOM), jadi hanya gambar yang memang ada di feed yang bisa diminta.
// Banyak gambar (2c): satu gambar tampil seperti sebelumnya; dua atau lebih dalam grid dua kolom (sel persegi, dipangkas), jumlah ganjil: yang terakhir selebar baris.
const PG_TH_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function pgMediaHtml(m, pid) {
  const nmE = m.name ? esc(m.name) : '', imgL = nmE ? txf('pg.imgNamed', 'Gambar: {name}', { name: nmE }) : txf('pg.img', 'Gambar');
  const inner = typeof m.th === 'string' && m.th.length <= 7000 && PG_TH_RE.test(m.th)
    ? `<div class="pgth"><img src="data:image/jpeg;base64,${m.th}" alt="${imgL}" loading="lazy" draggable="false"></div>`
    : `<div class="pgimgph" title="${txf('pg.imgPending', 'Gambar belum ditampilkan')}">🖼 ${imgL}</div>`;
  if (!PG_HEX16.test(String(pid)) || !PG_HEX16.test(String(m.id))) return inner;
  return `<button type="button" class="pgview" data-pg="view" data-pid="${pid}" data-mid="${m.id}" aria-label="${nmE ? txf('pg.imgOpenNamed', 'Buka gambar: {name}', { name: nmE }) : txf('pg.imgOpen', 'Buka gambar')}">${inner}</button>`;
}

// Carousel (v0.28.1): gambar + video satu postingan = satu baris slide yang bisa digeser (scroll-snap). Satu slide = satu gambar / satu video.
function pgMediaSlides(list, pid) {
  const l = Array.isArray(list) ? list.filter((m) => m && typeof m === 'object').slice(0, PG_IMG_MAX) : [];
  return l.map((m) => { const h = pgMediaHtml(m, pid), t = typeof m.th === 'string' && m.th.length <= 7000 && PG_TH_RE.test(m.th) ? `<img class="pgbk" src="data:image/jpeg;base64,${m.th}" alt="" aria-hidden="true" draggable="false">` : ''; return `<div class="pgslide">${t}${h}</div>`; });
}
function pgMediasHtml(list, pid) {
  const l = Array.isArray(list) ? list.filter((m) => m && typeof m === 'object').slice(0, PG_IMG_MAX) : []; // pemilik jauh tidak dipercaya: lapis kedua setelah wirePost
  if (!l.length) return '';
  return `<div class="pgmedia${l.length > 1 ? ' multi' : ''}">${l.map((m) => pgMediaHtml(m, pid)).join('')}</div>`;
}
// ---- video di feed (3c-8) ----
// Tiap video = kartu (nama, ukuran, tombol Putar). Token penyaji diminta HANYA saat Putar diklik (api.pgVideo), bukan saat feed dimuat: feed berisi puluhan video tidak membuka puluhan aliran ke pemilik.
// Sesudah token ada: <video controls preload="metadata"> bersumber plUrl4(tok) (archne-media: di desktop, /media/<tok> di Android; CSP media-src sudah mencakup). Yang diminta selalu entri di pgF.items (bukan atribut DOM); id 16 heks, mime mp4 | webm.
// pgVd: `${peerId}:${postId}:${videoId}` -> { state: 'load'|'ready'|'err', el, code, msg }. Elemen <video> disimpan di sini dan dipasang ulang ke slotnya sesudah feed digambar ulang (innerHTML membuang elemen lama; video yang sedang jalan dilanjutkan). Dilepas saat layar ditutup / dibuka lagi / postingan dihapus.
const PG_VMIME = ['video/mp4', 'video/webm'], PG_VTOK = /^[0-9a-f]{32}$/;
const pgVd = new Map();
function pgVdFree(k) { const e = k && k.el; if (!e) return; k.el = null; try { if (e.pause) e.pause(); e.onerror = null; e.removeAttribute('src'); if (e.load) e.load(); } catch (x) {} }
function pgVdClear(prefix) { for (const [key, k] of pgVd) if (!prefix || key.startsWith(prefix)) { pgVdFree(k); pgVd.delete(key); } }
// 3d-b2: satu video jalan pada satu waktu. Dijeda (bukan dilepas: posisi dan token tetap) setiap video lain yang sedang jalan: saat Putar diklik dan saat video ini mulai jalan (`play`, termasuk dari kontrol bawaan). Dijeda = berhenti membaca dari pemilik, jadi keluar dari hitungan stream Core sesudah beberapa detik.
function pgVdPauseOthers(except) { for (const k of pgVd.values()) { const e = k !== except && k.el; if (e && !e.paused) { try { e.pause(); } catch (x) {} } } }
function pgVideosHtml(list, pid) {
  const rows = pgVideoCells(list, pid);
  return rows.length ? `<div class="pgvideos">${rows.join('')}</div>` : '';
}
function pgVideoSlides(list, pid) { return pgVideoCells(list, pid).map((c) => `<div class="pgslide pgslidev">${c}</div>`); }
function pgVideoCells(list, pid) {
  if (!Array.isArray(list) || !list.length || !PG_HEX16.test(String(pid))) return [];
  const rows = [];
  for (const x of list.slice(0, PG_VID_MAX)) { // pemilik jauh tidak dipercaya: lapis kedua setelah wirePost
    if (!x || typeof x !== 'object' || !PG_HEX16.test(String(x.id)) || !PG_VMIME.includes(x.mime) || typeof x.name !== 'string' || !Number.isSafeInteger(x.size) || x.size <= 0) continue;
    const k = pgVd.get(pgId + ':' + pid + ':' + x.id), nm = esc(x.name);
    if (k && k.state === 'ready') { rows.push(`<div class="pgvslot" data-pgvk="${pid}:${x.id}"></div>`); continue; }
    const sz = typeof FileCard !== 'undefined' ? FileCard.esc(FileCard.fmtSize(x.size)) : '', err = k && k.state === 'err', noRetry = err && (PG_NORETRY[k.code] || k.code === 'none'), busy = k && k.state === 'load';
    // Kartu = bidang video gelap dengan tombol ikon besar di tengah (satu ketuk: token diminta, video dipasang, lalu langsung diputar). Nama + ukuran kecil di bawah.
    const lbl = busy ? txf('pg.loading', 'Memuat…') : err ? txf('pg.vRetryAria', 'Coba lagi memutar video: {name}', { name: nm }) : txf('pg.vPlayAria', 'Putar video: {name}', { name: nm });
    const btn = noRetry ? '' : `<button type="button" class="pgvbig" data-pg="vplay" data-pid="${pid}" data-vid="${x.id}" title="${esc(lbl)}" aria-label="${esc(lbl)}"${busy ? ' disabled' : ''}>${typeof icn === 'function' ? icn(err ? 'reload' : busy ? 'clock' : 'play') : ''}</button>`;
    rows.push(`<div class="pgvcard" title="${nm}">${btn}<div class="pgvcap"><span class="pgvi">${sz}</span></div>${err ? `<div class="pgvnote" role="alert">${esc(k.msg)}</div>` : ''}</div>`);
  }
  return rows;
}
async function pgVideoGo(pid, vid) {
  const f = pgF, peer = pgId, tok = pgTok; if (!f || !peer || !PG_HEX16.test(String(pid)) || !PG_HEX16.test(String(vid))) return;
  const post = f.items.find((p) => p.id === pid), ent = post && Array.isArray(post.videos) ? post.videos.find((x) => x && x.id === vid) : null;
  if (!ent || !PG_VMIME.includes(ent.mime) || typeof ent.name !== 'string') return;
  if (!window.api || typeof window.api.pgVideo !== 'function') { toast(txf('pg.vNoPlayer', 'Aplikasimu belum bisa memutar video Halaman.')); return; }
  const key = peer + ':' + pid + ':' + vid, cur = pgVd.get(key); if (cur && (cur.state === 'load' || cur.state === 'ready')) return;
  pgVdPauseOthers(null);
  const k = { state: 'load', el: null }; pgVd.set(key, k); renderFeed();
  let r; try { r = await window.api.pgVideo(peer, pid, vid); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgVd.get(key) !== k) return; // layar ditutup / diganti selagi menunggu
  const v = r && r.ok === true ? r.video : undefined, fail = (code, msg) => { k.state = 'err'; k.code = code; k.msg = msg; };
  if (!r || r.ok !== true) { const c = r && typeof r.code === 'string' ? r.code : ''; fail(c, PG_ERR[c] || (r && typeof r.err === 'string' && r.err ? r.err.slice(0, 200) : txf('pg.vLoadFail', 'Video tidak bisa dimuat.'))); }
  else if (v === null) fail('none', txf('pg.vNone', 'Video tidak tersedia. Mungkin sudah dihapus atau tidak untukmu.'));
  else if (!v || typeof v !== 'object' || !PG_VTOK.test(String(v.tok)) || !PG_VMIME.includes(v.mime) || typeof plUrl4 !== 'function' || !document || typeof document.createElement !== 'function') fail('proto', PG_ERR.proto);
  else {
    const el = document.createElement('video'); el.controls = true; el.preload = 'metadata'; el.setAttribute('playsinline', ''); el.setAttribute('aria-label', txf('pg.vAria', 'Video: {name}', { name: ent.name.slice(0, 200) }));
    el.onerror = () => { if (pgVd.get(key) === k && k.state === 'ready') { pgVdFree(k); fail('cut', txf('pg.vCut', 'Video terputus di tengah jalan (pemilik mungkin offline). Coba lagi.')); if (pgF === f) renderFeed(); } };
    el.onplay = () => { if (pgVd.get(key) === k) pgVdPauseOthers(k); };
    el.src = plUrl4(v.tok); k.el = el; k.state = 'ready';
  }
  if (pgF === f) renderFeed();
  if (k.state === 'ready' && k.el && pgVd.get(key) === k) { try { const pr = k.el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (x) {} } // ketukan tadi = niat memutar: langsung jalan, tanpa ketuk kedua
}
// Carousel: tombol panah (desktop, saat hover), penghitung "2/5", titik. Posisi slide disimpan di pgF.car[pid] supaya tidak lompat ke slide pertama saat feed digambar ulang.
function pgCarouselHtml(p) {
  const slides = pgMediaSlides(p.media, p.id).concat(pgVideoSlides(p.videos, p.id)); if (!slides.length) return '';
  const f = pgF, n = slides.length, i = Math.min(n - 1, Math.max(0, (f && f.car && f.car[p.id]) || 0));
  const nav = n > 1 ? `<button type="button" class="pgcarb prev" data-pg="cgo" data-pid="${p.id}" data-d="-1" aria-label="${txf('pg.prev', 'Sebelumnya')}">${typeof icn === 'function' ? icn('fwd') : ''}</button><button type="button" class="pgcarb next" data-pg="cgo" data-pid="${p.id}" data-d="1" aria-label="${txf('pg.next', 'Berikutnya')}">${typeof icn === 'function' ? icn('fwd') : ''}</button><span class="pgcarn">${i + 1}/${n}</span><div class="pgdots" aria-hidden="true">${slides.map((x, k) => `<i${k === i ? ' class="on"' : ''}></i>`).join('')}</div>` : '';
  return `<div class="pgcar${n > 1 ? ' multi' : ''}" data-pcar="${p.id}" data-i="${i}"><div class="pgtrack" tabindex="0">${slides.join('')}</div>${nav}</div>`;
}
function pgCarSet(box, i) { // satu-satunya tempat yang mengubah indeks aktif: simpan di pgF.car (supaya gambar ulang feed tidak mengembalikan ke slide 1), lalu perbarui penghitung / titik; jeda video di slide yang ditinggalkan
  const tr = box.querySelector('.pgtrack'), n = tr.children.length;
  if (pgF && pgF.car) pgF.car[box.dataset.pcar] = i;
  if (String(i) === box.dataset.i) return; box.dataset.i = String(i);
  const c = box.querySelector('.pgcarn'); if (c) c.textContent = (i + 1) + '/' + n;
  box.querySelectorAll('.pgdots i').forEach((d, k) => d.classList.toggle('on', k === i));
  Array.from(tr.children).forEach((sl, k) => { if (k !== i) sl.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (x) {} }); });
}
function pgCarSync(box) { // dipanggil saat scroll (geser jari / roda / animasi tombol)
  const tr = box.querySelector('.pgtrack'), w = tr.clientWidth || 1, n = tr.children.length;
  if (box._tgt != null) { // animasi dari tombol sedang berjalan: abaikan posisi di tengah jalan (kalau tidak, penghitung & titik berkedip balik), sampai tiba atau kehabisan waktu
    if (Math.abs(tr.scrollLeft - box._tgt * w) > 2 && Date.now() < box._tgtT) return;
    box._tgt = null;
  }
  pgCarSet(box, Math.min(n - 1, Math.max(0, Math.round(tr.scrollLeft / w))));
}
function pgCarGo(pid, d) {
  const L = $('pglist'); if (!L || typeof L.querySelector !== 'function') return; const box = L.querySelector('[data-pcar="' + pid + '"]'); if (!box) return;
  const tr = box.querySelector('.pgtrack'), w = tr.clientWidth || 1, n = tr.children.length; if (n < 2) return;
  const i = Number(box.dataset.i) || 0, j = ((i + d) % n + n) % n; // looping: dari slide terakhir ke pertama & sebaliknya
  box._tgt = j; box._tgtT = Date.now() + 1200;
  pgCarSet(box, j); // penghitung, titik, dan pgF.car langsung pindah ke tujuan (feed yang digambar ulang selagi animasi tetap mendarat di slide ini)
  tr.scrollTo({ left: j * w, behavior: (j === i + d || n <= 2) ? 'smooth' : 'auto' });
}
function pgCarRestore() { const L = $('pglist'); if (!pgF || !pgF.car || !L || typeof L.querySelectorAll !== 'function') return; for (const box of L.querySelectorAll('[data-pcar]')) { const i = pgF.car[box.dataset.pcar] || 0; if (i > 0) { const tr = box.querySelector('.pgtrack'); tr.style.scrollBehavior = 'auto'; tr.scrollLeft = i * tr.clientWidth; tr.style.scrollBehavior = ''; } } }
// Buka gambar penuh: cari entri di feed yang sedang tampil (bukan percaya atribut DOM), lalu serahkan ke penampil. Tanpa penampil (shell lama) = pesan, bukan galat.
function pgView(pid, mid) {
  const f = pgF; if (!f || !pgId) return;
  const p = f.items.find((x) => x.id === pid), m = p && Array.isArray(p.media) ? p.media.find((x) => x && x.id === mid) : null;
  if (!m) return;
  if (typeof openImgPage !== 'function' || !window.api || typeof window.api.pgImage !== 'function') { toast(txf('pg.noImgViewer', 'Aplikasimu belum bisa membuka gambar Halaman.')); return; }
  const sib = p.media.filter((x) => x && PG_HEX16.test(String(x.id))).slice(0, PG_IMG_MAX).map((x) => ({ id: x.id, name: typeof x.name === 'string' ? x.name : '' })); // semua gambar postingan ini, untuk tombol sebelumnya/berikutnya
  openImgPage(pgId, pid, mid, typeof m.name === 'string' ? m.name : '', sib);
}
