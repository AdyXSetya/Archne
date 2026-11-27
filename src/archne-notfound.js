'use strict';
// Halaman 404 bawaan untuk situs Web Lokal (PHP maupun statis). Hanya dipakai bila situs TIDAK punya 404 sendiri, seperti halaman bawaan Apache di XAMPP / Laragon:
//   - situs statis dengan 404.html di akarnya  -> 404.html itu yang tampil (status tetap 404), lihat archne-sitebrowser.js
//   - situs PHP dengan 404.html / 404.htm di akar www/ -> dipakai saat jalur tidak ketemu dan tidak ada index.php (archne-phproute.js)
//   - situs PHP yang menjawab 404 dengan badan HTML sendiri (WordPress, framework, dst.) -> TIDAK disentuh sama sekali
//   - jawaban 404 "kosong" atau teks polos bawaan ("Not found") ke permintaan halaman (Accept: text/html) -> diganti halaman ini
//   - permintaan sub-sumber (gambar, js, css, fetch/XHR tanpa Accept: text/html) tetap 404 polos: tidak membuang byte untuk halaman yang tidak dilihat siapa pun
// Satu berkas HTML mandiri: tanpa sumber luar (CSP situs mematikan jaringan), logo berupa data URI, gaya mengikuti token tema Archne (renderer/css/archne-app.css + archne-theme.css):
// gelap bawaan, terang bila perangkat memakai mode terang. Bahasa dari Accept-Language: id atau en.
const LOGO = require('./archne-notfound-logo');

const TEXT = {
  id: {
    title: 'Halaman tidak ditemukan',
    msg: 'Alamat yang kamu tuju tidak ada di situs ini. Mungkin sudah dipindahkan, dihapus, atau salah ketik.',
    back: 'Kembali', home: 'Ke beranda',
    foot: 'Halaman bawaan Archne · pemilik situs bisa menggantinya dengan berkas <code>404.html</code>',
  },
  en: {
    title: 'Page not found',
    msg: 'The address you’re looking for doesn’t exist on this site. It may have been moved, removed, or mistyped.',
    back: 'Go back', home: 'Home',
    foot: 'Default Archne page · site owners can replace it with a <code>404.html</code> file',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Jaring laba-laba: 12 jari-jari + 6 cincin yang melengkung ke dalam. Dihitung sekali, jadi satu <path> (gaya mengikuti --line).
function webPath() {
  const N = 12, R = [30, 60, 92, 126, 160, 196], pt = (r, i) => [Math.cos((i / N) * 2 * Math.PI - Math.PI / 2) * r, Math.sin((i / N) * 2 * Math.PI - Math.PI / 2) * r];
  const f = (n) => Math.round(n * 10) / 10;
  let d = '';
  for (let i = 0; i < N; i++) { const p = pt(R[R.length - 1], i); d += 'M0 0L' + f(p[0]) + ' ' + f(p[1]); }
  for (const r of R) {
    for (let i = 0; i < N; i++) {
      const a = pt(r, i), b = pt(r, i + 1), m = pt(r * 0.9, i + 0.5);
      d += (i ? '' : 'M' + f(a[0]) + ' ' + f(a[1])) + 'Q' + f(m[0]) + ' ' + f(m[1]) + ' ' + f(b[0]) + ' ' + f(b[1]);
    }
  }
  return d;
}
const WEB = webPath();

const CSS = ':root{color-scheme:dark light;--bg:#0e141b;--surface:#151d26;--line:#243140;--fg:#e8eef4;--dim:#8d9cac;--acc:#3bbfae;--acc2:#8ff0e1;--acc-ink:#04211d;--hover:#1a2430;--glow:#3bbfae38;--web:#2a3a4b}'
  + '@media (prefers-color-scheme:light){:root{--bg:#f2f5f8;--surface:#fff;--line:#d8e1e8;--fg:#14202b;--dim:#5b6b7a;--acc:#0e8f81;--acc2:#2fc4b2;--acc-ink:#fff;--hover:#eef3f6;--glow:#0e8f8128;--web:#c7d3dc}}'
  + '*{box-sizing:border-box;margin:0}[hidden]{display:none!important}'
  + 'html{height:100%}body{min-height:100%;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden}'
  + '.bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background:radial-gradient(60% 50% at 50% 46%,var(--glow),transparent 70%)}'
  + '.web{position:absolute;left:50%;top:46%;width:min(120vmin,880px);height:min(120vmin,880px);translate:-50% -50%;fill:none;stroke:var(--web);stroke-width:1;stroke-linecap:round;opacity:.75;-webkit-mask-image:radial-gradient(closest-side,#000 35%,transparent 100%);mask-image:radial-gradient(closest-side,#000 35%,transparent 100%);animation:spin 240s linear infinite}'
  + 'header{position:relative;z-index:1;padding:20px 28px}'
  + '.brand{display:inline-flex;align-items:center;gap:12px;text-decoration:none;color:var(--fg)}'
  + '.brand img{width:40px;height:40px;border-radius:10px;display:block;box-shadow:0 2px 10px #0006}'
  + '.bn{font-size:19px;font-weight:700;letter-spacing:.2px}'
  + 'main{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:8px 24px 40px;animation:up .6s cubic-bezier(.2,.7,.2,1) both}'
  + '.code{font-size:clamp(6.5rem,26vw,15rem);font-weight:800;letter-spacing:-.05em;line-height:.95;background:linear-gradient(180deg,var(--fg) 10%,var(--dim) 130%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 12px 40px var(--glow));user-select:none}'
  + '.code span{background:linear-gradient(135deg,var(--acc2),var(--acc) 70%);-webkit-background-clip:text;background-clip:text;color:transparent}'
  + 'h1{margin-top:10px;font-size:clamp(1.4rem,3.6vw,2rem);font-weight:700;letter-spacing:-.01em}'
  + '.msg{margin-top:10px;max-width:30rem;color:var(--dim)}'
  + '.path{margin-top:18px;max-width:min(92vw,34rem);padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--dim);font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}'
  + '.act{margin-top:26px;display:flex;gap:12px;flex-wrap:wrap;justify-content:center}'
  + '.btn{display:inline-flex;align-items:center;justify-content:center;min-width:128px;padding:11px 22px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--fg);font-weight:600;font-size:15px;line-height:1;font-family:inherit;text-decoration:none;cursor:pointer;transition:background .15s,transform .15s,border-color .15s}'
  + '.btn:hover{background:var(--hover);border-color:var(--acc)}.btn:active{transform:translateY(1px)}'
  + '.btn.pri{background:var(--acc);border-color:transparent;color:var(--acc-ink)}.btn.pri:hover{background:var(--acc);filter:brightness(1.08)}'
  + '.btn:focus-visible{outline:2px solid var(--acc);outline-offset:3px}'
  + 'footer{position:relative;z-index:1;padding:0 24px 22px;text-align:center;font-size:12.5px;color:var(--dim)}'
  + 'footer code{padding:1px 6px;border:1px solid var(--line);border-radius:5px;background:var(--surface);font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
  + '@keyframes spin{to{rotate:360deg}}@keyframes up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}'
  + '@media (prefers-reduced-motion:reduce){.web,main{animation:none}.btn{transition:none}}'
  + '@media (max-width:480px){header{padding:16px 18px}.btn{flex:1 1 100%}}';

// Bahasa dari Accept-Language (tag pertama): id* = Indonesia, lainnya = Inggris.
const langOf = (al) => { const v = String(al || ''); return /^\s*[a-z]/i.test(v) && !/^\s*id\b/i.test(v) ? 'en' : 'id'; };
// Permintaan halaman (navigasi / iframe) membawa Accept: text/html; fetch / XHR / gambar / skrip tidak.
const wantsHtml = (accept) => /text\/html/i.test(String(accept || ''));
// Jalur untuk ditampilkan: sudah didekode, tanpa karakter kendali / pengarah teks, dipotong. Selalu di-escape saat dirender.
function showPath(p) {
  let s = String(p || '/');
  try { s = decodeURIComponent(s); } catch { /* biarkan apa adanya */ }
  s = s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}
// Jawaban 404 yang dianggap "bawaan" (boleh diganti halaman ini): badan kosong, atau teks polos pendek buatan Archne / router sendiri.
// Badan HTML (atau JSON, dst.) berarti situs punya 404 sendiri: tidak disentuh. headers = { namaKecil: [nilai] }.
function isBare(headers, body) {
  const len = body ? body.length : 0;
  if (!len) return true;
  const ct = String(((headers && headers['content-type']) || [''])[0]).toLowerCase();
  if (!/^text\/plain\b/.test(ct) || len > 64) return false;
  return /^(not found|situs tidak tersedia)$/i.test(Buffer.from(body).toString('utf8').trim());
}

// Halaman lengkap -> string HTML. o = { path, lang }.
function render(o) {
  o = o || {};
  const t = TEXT[o.lang] || TEXT.id, p = esc(showPath(o.path));
  return '<!doctype html><html lang="' + (TEXT[o.lang] ? o.lang : 'id') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="dark light"><meta name="robots" content="noindex"><title>404 · ' + esc(t.title) + '</title><style>' + CSS + '</style></head><body>'
    + '<div class="bg" aria-hidden="true"><svg class="web" viewBox="-200 -200 400 400"><path d="' + WEB + '"/></svg></div>'
    + '<header><a class="brand" href="/"><img src="' + LOGO + '" alt="" width="40" height="40"><span class="bn">Archne</span></a></header>'
    + '<main><p class="code" role="img" aria-label="404">4<span>0</span>4</p><h1>' + esc(t.title) + '</h1><p class="msg">' + esc(t.msg) + '</p><code class="path">' + p + '</code>'
    + '<div class="act"><button type="button" class="btn" id="b">' + esc(t.back) + '</button><a class="btn pri" href="/">' + esc(t.home) + '</a></div></main>'
    + '<footer>' + t.foot + '</footer>'
    + '<script>(function(){var b=document.getElementById("b");if(!b)return;if(history.length<2){b.hidden=true;return}b.onclick=function(){history.back()}})()</script></body></html>';
}

// Response 404 berisi halaman bawaan. base = header dasar penampil (CSP dst., objek biasa). HEAD = tanpa badan.
function response(request, base) {
  let p = '/'; try { p = new URL(request.url).pathname; } catch { /* jalur bawaan */ }
  const html = render({ path: p, lang: langOf(request.headers.get('accept-language')) });
  const h = Object.assign({}, base, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)) });
  return new Response(request.method === 'HEAD' ? null : html, { status: 404, headers: h });
}
// Gerbang situs PHP: jawaban 404 kosong / teks polos bawaan ke permintaan halaman -> halaman bawaan; selain itu null (jawaban situs dipakai apa adanya).
function gate(request, r, base) {
  return r.status === 404 && request.method !== 'POST' && wantsHtml(request.headers.get('accept')) && isBare(r.headers, r.body) ? response(request, base) : null;
}

module.exports = { render, response, gate, wantsHtml, langOf, isBare, showPath, TEXT };
