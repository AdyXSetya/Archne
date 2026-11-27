'use strict';
// Halaman contoh (www/index.html) yang ditulis sekali saat situs dibuat. Pemilik menggantinya sesuai selera; situs lama tidak disentuh.
// Satu berkas mandiri (CSP situs mematikan jaringan luar): tanpa sumber luar, tema gelap / terang mengikuti perangkat, id + en dipilih dari bahasa peramban.
// <h1> hanya berisi judul situs. o = { title, domain, php }.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Jaring laba-laba kecil (8 jari-jari, 5 cincin) sebagai satu <path>, dihitung sekali.
const WEB = (() => {
  const N = 8, R = [34, 68, 104, 142, 182], f = (n) => Math.round(n * 10) / 10;
  const pt = (r, i) => [Math.cos((i / N) * 2 * Math.PI - Math.PI / 2) * r, Math.sin((i / N) * 2 * Math.PI - Math.PI / 2) * r];
  let d = '';
  for (let i = 0; i < N; i++) { const p = pt(R[R.length - 1], i); d += 'M0 0L' + f(p[0]) + ' ' + f(p[1]); }
  for (const r of R) for (let i = 0; i < N; i++) { const a = pt(r, i), b = pt(r, i + 1), m = pt(r * 0.9, i + 0.5); d += (i ? '' : 'M' + f(a[0]) + ' ' + f(a[1])) + 'Q' + f(m[0]) + ' ' + f(m[1]) + ' ' + f(b[0]) + ' ' + f(b[1]); }
  return d;
})();

const CSS = ':root{color-scheme:dark light;--bg:#0e141b;--sf:#151d26;--ln:#243140;--fg:#e8eef4;--dim:#8d9cac;--acc:#3bbfae;--acc2:#8ff0e1;--glow:#3bbfae38;--web:#2a3a4b}'
  + '@media(prefers-color-scheme:light){:root{--bg:#f2f5f8;--sf:#fff;--ln:#d8e1e8;--fg:#14202b;--dim:#5b6b7a;--acc:#0e8f81;--acc2:#2fc4b2;--glow:#0e8f8128;--web:#c7d3dc}}'
  + '*{box-sizing:border-box;margin:0}'
  + 'body{min-height:100vh;display:flex;flex-direction:column;align-items:center;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden;position:relative}'
  + '.bg{position:fixed;inset:0;pointer-events:none;background:radial-gradient(55% 45% at 50% 28%,var(--glow),transparent 70%)}'
  + '.web{position:absolute;left:50%;top:26%;width:min(110vmin,820px);translate:-50% -50%;fill:none;stroke:var(--web);stroke-width:1;opacity:.7;-webkit-mask-image:radial-gradient(closest-side,#000 30%,transparent 100%);mask-image:radial-gradient(closest-side,#000 30%,transparent 100%)}'
  + 'main{position:relative;width:100%;max-width:880px;padding:12vh 24px 32px;text-align:center;flex:1}'
  + '.chip{display:inline-flex;align-items:center;gap:8px;padding:5px 14px;border:1px solid var(--ln);border-radius:99px;background:var(--sf);color:var(--dim);font-size:13px;font-weight:600}'
  + '.chip i{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 4px var(--glow)}'
  + 'h1{margin-top:22px;font-size:clamp(2.2rem,7vw,4rem);line-height:1.1;font-weight:800;letter-spacing:-.03em;overflow-wrap:anywhere;background:linear-gradient(180deg,var(--fg) 30%,var(--dim) 140%);-webkit-background-clip:text;background-clip:text;color:transparent}'
  + '.dom{display:inline-block;margin-top:14px;padding:5px 14px;border:1px solid var(--ln);border-radius:9px;background:var(--sf);font:14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--acc);overflow-wrap:anywhere}'
  + '.lead{margin:20px auto 0;max-width:34rem;color:var(--dim)}'
  + '.grid{margin-top:44px;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;text-align:left}'
  + '.card{padding:20px;border:1px solid var(--ln);border-radius:14px;background:var(--sf);transition:border-color .15s,transform .15s}'
  + '.card:hover{border-color:var(--acc);transform:translateY(-2px)}'
  + '.n{display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border-radius:8px;background:linear-gradient(135deg,var(--acc2),var(--acc));color:#04211d;font-weight:800;font-size:14px}'
  + '.card h2{margin-top:12px;font-size:16px;font-weight:700}.card p{margin-top:6px;font-size:14px;color:var(--dim)}'
  + 'code{padding:1px 6px;border:1px solid var(--ln);border-radius:5px;background:var(--bg);font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--fg)}'
  + 'footer{position:relative;padding:0 24px 24px;font-size:12.5px;color:var(--dim);text-align:center}'
  + '[lang=en] .id,[lang=id] .en{display:none}'
  + '@media(prefers-reduced-motion:reduce){.card{transition:none}}';

const T = {
  id: {
    chip: 'Situs baru', chipPhp: 'Situs baru · PHP aktif',
    lead: 'Situs ini sudah aktif di Archne, tapi isinya masih halaman contoh. Ganti berkas ini dengan halamanmu sendiri.',
    c1: ['Ganti halaman ini', 'Edit <code>index.html</code> ini lewat editor berkas Archne, atau unggah berkas situsmu langsung ke akar situs (tanpa membuat folder <code>www</code> baru).'],
    c2: ['Tambah berkas', 'Taruh CSS, gambar, dan skrip di samping <code>index.html</code>, atau di subfolder seperti <code>css/</code>. Semuanya dilayani dari domain ini; sumber dari jaringan luar diblokir.'],
    c2p: ['HTML tetap jalan', 'Berkas <code>.html</code>, CSS, dan gambar dilayani apa adanya; hanya <code>.php</code> yang dijalankan. Bila ada <code>index.php</code> dan <code>index.html</code>, <code>index.php</code> yang dipakai.'],
    c3: ['Halaman 404 sendiri', 'Buat <code>404.html</code> di akar situs, sejajar dengan <code>index.html</code>, untuk mengganti halaman “tidak ditemukan” bawaan Archne.'],
    foot: 'Halaman contoh dari Archne · aman dihapus atau diganti',
  },
  en: {
    chip: 'New site', chipPhp: 'New site · PHP enabled',
    lead: 'This site is live on Archne, but it still shows a sample page. Replace this file with your own page.',
    c1: ['Replace this page', 'Edit this <code>index.html</code> with the Archne file editor, or upload your site files straight to the site root (no need to create a new <code>www</code> folder).'],
    c2: ['Add files', 'Put CSS, images, and scripts next to <code>index.html</code>, or in subfolders like <code>css/</code>. Everything is served from this domain; resources from the outside network are blocked.'],
    c2p: ['HTML still works', '<code>.html</code> files, CSS, and images are served as-is; only <code>.php</code> files are executed. If both <code>index.php</code> and <code>index.html</code> exist, <code>index.php</code> wins.'],
    c3: ['Your own 404 page', 'Create <code>404.html</code> at the site root, next to <code>index.html</code>, to replace Archne’s default “not found” page.'],
    foot: 'Sample page by Archne · safe to delete or replace',
  },
};

function starterHtml(o) {
  o = o || {};
  const title = esc(o.title || o.domain || ''), dom = esc(o.domain || ''), php = !!o.php;
  const two = (k) => ['id', 'en'].map((l) => '<span class="' + l + '">' + T[l][k] + '</span>').join('');
  const card = (n, k) => '<div class="card"><span class="n">' + n + '</span><h2>' + ['id', 'en'].map((l) => '<span class="' + l + '">' + T[l][k][0] + '</span>').join('') + '</h2><p>' + ['id', 'en'].map((l) => '<span class="' + l + '">' + T[l][k][1] + '</span>').join('') + '</p></div>';
  return '<!doctype html>\n<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>' + title + '</title><style>' + CSS + '</style></head>\n'
    + '<body><div class="bg" aria-hidden="true"><svg class="web" viewBox="-200 -200 400 400"><path d="' + WEB + '"/></svg></div>\n'
    + '<main><span class="chip"><i></i>' + two(php ? 'chipPhp' : 'chip') + '</span>\n'
    + '<h1>' + title + '</h1>\n<code class="dom">' + dom + '.archne</code>\n<p class="lead">' + two('lead') + '</p>\n'
    + '<div class="grid">' + card(1, 'c1') + card(2, php ? 'c2p' : 'c2') + card(3, 'c3') + '</div></main>\n'
    + '<footer>' + two('foot') + '</footer>\n'
    + '<script>(function(){var l=(navigator.language||"id").slice(0,2)==="id"?"id":"en";document.documentElement.lang=l})()</script></body></html>\n';
}

module.exports = { starterHtml };
