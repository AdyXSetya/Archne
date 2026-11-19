// Halaman, kotak tulis Halamanku (dipecah dari archne-pages.js, 3d-a): gambar / berkas / video terpilih untuk postingan baru (pgImgs, pgFiles, pgVids), pemilih berkas, thumbnail, dan pgPost (kirim).
// Skrip global biasa; dimuat setelah archne-pages.js (memakai pgF, pgTok, pgId, renderFeed, PG_ERR di sana saat dipakai) dan sebelum archne-pages-media.js. Kerangka HTML kotak tulis (pgSkeleton) ada di archne-pages.js.
const PG_IMG_MAX = 10; // gambar per postingan; HARUS sama dengan MEDIA_MAX di src/archne-pagestore.js (dijaga test/pageui.js)
let pgImgs = [];    // gambar terpilih untuk postingan baru, urutan = urutan tampil: [{ src (path atau File), name, th, thP }] (th = thumbnail JPEG base64 dari pgThumb, thP = janjinya); bertahan seperti draf
const PG_FILE_MAX = 10; // lampiran per postingan; HARUS sama dengan FILES_MAX di src/archne-pagestore.js (dijaga test/pageui.js)
let pgFiles = [];   // lampiran terpilih untuk postingan baru, urutan = urutan tampil: [{ src (path atau File), name }]; bertahan seperti draf. Berkas apa saja (bukan hanya gambar); Core yang menolak kosong / bukan berkas biasa / > 2 GB
const PG_VID_MAX = 4; // video per postingan; HARUS sama dengan VIDEOS_MAX di src/archne-pagestore.js (dijaga test/pageui.js)
const PG_VID_EXT = /\.(mp4|m4v|webm)$/i; // pemeriksaan awal supaya pesannya cepat; yang menentukan tetap Core (ekstensi DAN isi berkas)
let pgVids = [];    // video terpilih untuk postingan baru (3c-7), urutan = urutan tampil: [{ src (path atau File), name }]; bertahan seperti draf
let pgThQ = Promise.resolve(); // antrean pembuatan thumbnail: satu per satu, supaya 10 gambar besar tidak didekode bersamaan (HP)
let pgDraft = '';   // draf kotak tulis, bertahan selama layar ditutup lalu dibuka lagi
const pgBase = (p) => String(p).split(/[\\/]/).pop();
// Tombol tambah di kotak tulis berupa ikon (bukan teks): gambar / berkas / video. Nama tombol ada di title + aria-label ("Tambah gambar (2/10)"); jumlah terpilih = lencana kecil di pojok.
const PG_ICO = {
  img: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-9 9"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/></svg>',
  vid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/></svg>',
};
function pgAttUi(id, label, n, max) { // id = id tombol (pgimg / pgfile / pgvid); lencana = elemen <id>n
  const b = $(id); if (!b) return;
  const t = n ? txf('pg.attCount', '{label} ({n}/{max})', { label, n, max }) : label;
  b.title = t; if (typeof b.setAttribute === 'function') { b.setAttribute('title', t); b.setAttribute('aria-label', t); }
  b.disabled = n >= max || !!(pgF && pgF.posting);
  const g = $(id + 'n'); if (g) { g.textContent = n ? String(n) : ''; g.hidden = !n; }
}
function pgImgUi() {
  const r = $('pgimgrow'); if (!r) return;
  r.innerHTML = pgImgs.map((im, i) => `<div class="pgimgi"><span class="pgimgn">${i + 1}. ${esc(im.name)}</span><button type="button" class="ibtn" data-pg="imgx" data-i="${i}" title="${txf('pg.rmImg', 'Buang gambar ini')}" aria-label="${txf('pg.rmImgN', 'Buang gambar {n}', { n: i + 1 })}">✕</button></div>`).join('');
  pgAttUi('pgimg', txf('pg.addImg', 'Tambah gambar'), pgImgs.length, PG_IMG_MAX);
}
function pgFileUi() {
  const r = $('pgfilerow'); if (!r) return;
  r.innerHTML = pgFiles.map((x, i) => `<div class="pgimgi"><span class="pgimgn">${i + 1}. ${esc(x.name)}</span><button type="button" class="ibtn" data-pg="filex" data-i="${i}" title="${txf('pg.rmFile', 'Buang berkas ini')}" aria-label="${txf('pg.rmFileN', 'Buang berkas {n}', { n: i + 1 })}">✕</button></div>`).join('');
  const dr = $('pgdlrow'); if (dr) dr.hidden = !pgFiles.length; // 3b: pilihan unduh hanya relevan bila ada lampiran
  pgAttUi('pgfile', txf('pg.addFile', 'Tambah berkas'), pgFiles.length, PG_FILE_MAX);
}
async function pgPickFile() {
  const f = pgF, tok = pgTok; if (!f || !f.mine || f.posting || pgFiles.length >= PG_FILE_MAX) return;
  let l; try { l = await window.api.pickFiles(); } catch (e) { l = []; }
  if (tok !== pgTok || pgF !== f || !Array.isArray(l)) return; // dibatalkan / layar berganti = tidak berubah
  const fresh = [], got = new Set(pgFiles.map((x) => x.src));
  for (const s of l) if (!got.has(s) && (typeof s === 'string' || (s && typeof s === 'object' && typeof s.size === 'number'))) { got.add(s); fresh.push(s); }
  const room = PG_FILE_MAX - pgFiles.length, take = fresh.slice(0, room), e = $('pgcerr');
  if (e) { if (fresh.length > room) e.textContent = tnf('pg.maxFiles', fresh.length - room, 'Maksimal {max} berkas per postingan; {n} berkas terakhir tidak ikut.', { max: PG_FILE_MAX }); else if (take.length) e.textContent = ''; }
  for (const s of take) pgFiles.push({ src: s, name: typeof s === 'string' ? pgBase(s) : String(s.name || txf('pg.defFile', 'berkas')) });
  pgFileUi();
}
function pgVidUi() {
  const r = $('pgvidrow'); if (!r) return;
  r.innerHTML = pgVids.map((x, i) => `<div class="pgimgi"><span class="pgimgn">${i + 1}. ${esc(x.name)}</span><button type="button" class="ibtn" data-pg="vidx" data-i="${i}" title="${txf('pg.rmVid', 'Buang video ini')}" aria-label="${txf('pg.rmVidN', 'Buang video {n}', { n: i + 1 })}">✕</button></div>`).join('');
  pgAttUi('pgvid', txf('pg.addVid', 'Tambah video'), pgVids.length, PG_VID_MAX);
}
async function pgPickVideo() {
  const f = pgF, tok = pgTok; if (!f || !f.mine || f.posting || pgVids.length >= PG_VID_MAX) return;
  let l; try { l = await window.api.pickFiles(); } catch (e) { l = []; }
  if (tok !== pgTok || pgF !== f || !Array.isArray(l)) return;
  const fresh = [], got = new Set(pgVids.map((x) => x.src)); let skip = 0;
  for (const s of l) {
    if (got.has(s) || !(typeof s === 'string' || (s && typeof s === 'object' && typeof s.size === 'number'))) continue;
    if (!PG_VID_EXT.test(typeof s === 'string' ? pgBase(s) : String(s.name || ''))) { skip++; continue; }
    got.add(s); fresh.push(s);
  }
  const room = PG_VID_MAX - pgVids.length, take = fresh.slice(0, room), e = $('pgcerr');
  if (e) { const m = []; if (skip) m.push(tnf('pg.notVideo', skip, '{n} berkas bukan video mp4 / webm dan dilewati.')); if (fresh.length > room) m.push(tnf('pg.maxVids', fresh.length - room, 'Maksimal {max} video per postingan; {n} video terakhir tidak ikut.', { max: PG_VID_MAX })); if (m.length) e.textContent = m.join(' '); else if (take.length) e.textContent = ''; }
  for (const s of take) pgVids.push({ src: s, name: typeof s === 'string' ? pgBase(s) : String(s.name || txf('pg.defVid', 'video')) });
  pgVidUi();
}
// Thumbnail postingan (2b-3): Media.forSend dengan tujuan bukan 'public' memakai rencana 'direct' (sisi <= 256 px, <= 7000 karakter), pas dengan batas PageStore.
// Gagal apa pun (HEIC tanpa kodek, bukan gambar, Media tak ada) = undefined: postingan tetap jadi, hanya tanpa thumbnail. Core memeriksa ulang th, jadi renderer tidak dipercaya.
async function pgThumb(src) {
  try {
    if (typeof Media === 'undefined' || !Media || typeof Media.forSend !== 'function') return undefined;
    const x = await Media.forSend(src, 'page', window.api);
    return x && typeof x.th === 'string' && x.th ? x.th : undefined;
  } catch (e) { return undefined; }
}
async function pgPick() {
  const f = pgF, tok = pgTok; if (!f || !f.mine || f.posting || pgImgs.length >= PG_IMG_MAX) return;
  let l; try { l = await window.api.pickFiles(); } catch (e) { l = []; }
  if (tok !== pgTok || pgF !== f || !Array.isArray(l)) return; // dibatalkan / layar berganti = tidak berubah
  // Electron: path (string); Android/peramban: objek File (diunggah api-http saat Kirim). Yang bukan keduanya dilewati; path yang sama dua kali tidak ditambah dua kali.
  const fresh = [], got = new Set(pgImgs.map((x) => x.src));
  for (const s of l) if (!got.has(s) && (typeof s === 'string' || (s && typeof s === 'object' && typeof s.size === 'number'))) { got.add(s); fresh.push(s); }
  const room = PG_IMG_MAX - pgImgs.length, take = fresh.slice(0, room), e = $('pgcerr');
  if (e) { if (fresh.length > room) e.textContent = tnf('pg.maxImgs', fresh.length - room, 'Maksimal {max} gambar per postingan; {n} gambar terakhir tidak ikut.', { max: PG_IMG_MAX }); else if (take.length) e.textContent = ''; } // dialog dibatalkan: pesan lama dibiarkan
  for (const s of take) {
    const cur = { src: s, name: typeof s === 'string' ? pgBase(s) : String(s.name || txf('pg.defImg', 'gambar')), th: undefined, thP: null };
    pgImgs.push(cur);
    cur.thP = pgThQ = pgThQ.then(() => (pgImgs.includes(cur) ? pgThumb(s) : undefined)).then((t) => { cur.th = t; return t; }); // antre sekarang; pgPost menunggu bila belum selesai. Yang sudah dibuang sebelum gilirannya dilewati
  }
  pgImgUi();
}
async function pgPost() {
  const f = pgF, t = $('pgtxt'); if (!f || !f.mine || f.posting || !t) return;
  const text = String(t.value || ''), e = $('pgcerr');
  if (!text.trim()) { if (e) e.textContent = txf('pg.writeFirst', 'Tulis sesuatu dulu.'); return; }
  f.posting = true; if (e) e.textContent = ''; renderFeed();
  const tok = pgTok, pv = $('pgpriv'), ims = pgImgs.slice(), fls = pgFiles.slice(), vds = pgVids.slice(); // salinan: daftar boleh berubah (tidak lewat tombol, tapi layar bisa ditutup) selagi menunggu
  let r;
  try {
    const images = []; for (const im of ims) images.push({ src: im.src, th: await im.thP }); // thumbnail yang belum selesai ditunggu; th kosong tidak menggagalkan
    const priv = pv && pv.value === 'friends' ? 'friends' : 'public';
    const dc = $('pgdl'), nodl = !!(fls.length && dc && dc.checked === false); // kotak dibaca saat Kirim; tanpa lampiran tidak berarti apa-apa
    const opts = nodl ? { nodl: true } : undefined; // 3c-7: video lewat opts.videos (hanya { src }); tanpa lampiran dan tanpa video panggilannya tetap tiga argumen seperti sebelum 3a-6
    r = vds.length ? await window.api.pgCreate(text, priv, images, fls.map((x) => ({ src: x.src })), Object.assign({}, opts, { videos: vds.map((x) => ({ src: x.src })) }))
      : fls.length ? await window.api.pgCreate(text, priv, images, fls.map((x) => ({ src: x.src })), opts) : await window.api.pgCreate(text, priv, images);
  } catch (x) { r = { ok: false, err: txf('pg.saveFail', 'Gagal menyimpan postingan.') }; }
  f.posting = false;
  if (r && r.ok && r.post) {
    pgDraft = ''; pgImgs = []; pgFiles = []; pgVids = []; { const dc = $('pgdl'); if (dc) dc.checked = true; } if (f.ids.has(r.post.id) === false) { f.ids.add(r.post.id); f.items.unshift(r.post); f.loaded = true; }
    if (tok === pgTok && pgF === f) { t.value = ''; if (e) e.textContent = ''; pgImgUi(); pgFileUi(); pgVidUi(); }
  } else if (tok === pgTok && pgF === f && e) e.textContent = (r && r.err) || txf('pg.saveFail', 'Gagal menyimpan postingan.'); // draf tetap ada
  if (tok === pgTok && pgF === f) renderFeed();
}
