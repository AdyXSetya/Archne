// Web Lokal (0.34.0 U1): penampil media di tab Berkas (tombol ikon mata). Gambar, audio, dan video milik situs sendiri dilihat / diputar di dalam aplikasi tanpa membuka tab Pratinjau.
// Isi diambil dari Core lewat api.webFileView(id, rel) (jalur RELATIF; Core memeriksa jenis dan ukuran, balasan base64). Gambar tampil lewat <img> data: (CSP hanya mengizinkan data:, jadi skrip di dalam SVG tidak berjalan); audio / video lewat blob: URL di <audio> / <video> bawaan.
// Keadaan ada di lwF.vw = { name, rel, kind: 'image' | 'audio' | 'video', loading, err, url, blob, mime, size }; null = daftar berkas yang tampil. Satu penampil sekaligus. Balasan yang datang sesudah ditutup dibuang (F.vw !== vw) dan blob: URL dilepas supaya memori kembali.
// Kembali (lwFilesBack) menutup penampil lebih dulu. Peta jenis di bawah harus sama dengan VIEW_MIME di src/archne-ipc-webfiles.js (dijaga test/webuiu1.js).
const LW_VIEW_KIND = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image', svg: 'image', mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video' };
const LW_VIEW_MIME_OK = /^(image|audio|video)\/[a-z0-9.+-]{1,40}$/i;
const lwVwKind = (name) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name)); const k = m ? m[1].toLowerCase() : ''; return Object.prototype.hasOwnProperty.call(LW_VIEW_KIND, k) ? LW_VIEW_KIND[k] : ''; };

function lwVwRevoke(vw) {
  if (!vw) return;
  if (vw.blob && vw.url) { try { URL.revokeObjectURL(vw.url); } catch (x) {} }
  vw.url = ''; vw.blob = false;
}
function lwVwClose() {
  const F = lwF; if (!F || !F.vw) return;
  lwVwRevoke(F.vw); F.vw = null; lwFilesPaint();
}
function lwVwBytes(b64) { // base64 -> Uint8Array (atob + salinan per potongan: berkas puluhan MB tidak boleh membuat satu string raksasa)
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 32768) { const end = Math.min(bin.length, i + 32768); for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j); }
  return out;
}
async function lwVwOpen(name) {
  const F = lwF, kind = lwVwKind(name);
  if (!F || F.busy || F.ed || F.vw || !kind) return;
  const vw = F.vw = { name, rel: lwFJoin(F.dir, name), kind, loading: true, err: '', url: '', blob: false, mime: '', size: 0 };
  lwFilesPaint();
  let r; try { r = await window.api.webFileView(F.id, vw.rel); } catch (x) { r = null; }
  if (F !== lwF || F.vw !== vw) return; // ditutup selagi menunggu
  vw.loading = false;
  if (!r || !r.ok || typeof r.b64 !== 'string' || r.kind !== kind || !LW_VIEW_MIME_OK.test(String(r.mime))) { vw.err = lwFilesFail(r && r.ok ? null : r); lwFilesPaint(); return; }
  vw.mime = r.mime; vw.size = r.size | 0;
  try {
    if (kind === 'image') vw.url = 'data:' + r.mime + ';base64,' + r.b64;
    else { vw.url = URL.createObjectURL(new Blob([lwVwBytes(r.b64)], { type: r.mime })); vw.blob = true; }
  } catch (x) { vw.url = ''; vw.err = txf('lw.v.fail', 'Berkas ini tidak bisa ditampilkan di sini'); }
  lwFilesPaint();
}
function lwVwHtml(F) {
  const vw = F.vw, size = typeof FileCard !== 'undefined' && FileCard.fmtSize && vw.size ? FileCard.fmtSize(vw.size) : '';
  const back = `<button type="button" class="sec" id="lwvclose" data-lw="fvclose">${icn('back')}<span>${esc(txf('lw.e.back', 'Berkas'))}</span></button>`;
  const name = `<span class="lwedn" title="${esc(vw.rel)}">${esc(vw.rel)}</span>${size ? `<span class="lwedst">${esc(size)}</span>` : ''}`;
  const edit = typeof lwEdOk === 'function' && lwEdOk(vw.name) ? `<button type="button" class="sec" data-lw="fvedit">${icn('edit')}<span>${esc(txf('lw.f.edit', 'Edit'))}</span></button>` : ''; // SVG: bisa dilihat dan disunting
  let body;
  if (vw.loading) body = `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>`;
  else if (vw.err) body = `<p class="lwnote err" role="alert">${esc(vw.err)}</p>`;
  else if (vw.kind === 'image') body = `<div class="lwvwbox"><img class="lwvwimg" alt="${esc(vw.name)}" src="${esc(vw.url)}"></div>`;
  else if (vw.kind === 'audio') body = `<div class="lwvwbox lwvwaud"><span class="lwvwic">${icn('music')}</span><audio controls preload="metadata" src="${esc(vw.url)}"></audio></div>`;
  else body = `<div class="lwvwbox"><video class="lwvwvid" controls playsinline preload="metadata" src="${esc(vw.url)}"></video></div>`;
  return `<div class="lwedh">${back}${name}${edit}</div>${body}`;
}
function lwVwPaint(el, F) { el.innerHTML = lwVwHtml(F); try { const b = $('lwvclose'); if (b && b.focus) b.focus(); } catch (x) {} }
function lwVwAct(act) {
  const F = lwF; if (!F || !F.vw) return false;
  if (act === 'fvclose') { lwVwClose(); return true; }
  if (act === 'fvedit') { const n = F.vw.name; lwVwClose(); lwEdOpen(n); return true; }
  return false;
}
