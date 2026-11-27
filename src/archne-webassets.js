'use strict';
// src/archne-webassets.js — Pemindai aset eksternal situs (0.34.0 Fase O1, "Jadikan offline"). BACA SAJA: tanpa jaringan, tanpa menulis, tanpa jalur disk keluar. Dipanggil dari archne-ipc-web.js (webAssetScan).
// Latar: penampil membatalkan SEMUA permintaan keluar (webRequest + CSP 'self'), jadi aset CDN tidak pernah termuat di Archne, online maupun offline. O1 hanya MENCARI dan MENGGOLONGKAN; mengunduh = O2, menulis ulang = O3.
// Hasil scan(wf) -> { files, scanned, bytes, skipped:[{ p, code }], skippedN, limits:[kode], items:[...], itemsN, hosts:[...], dynamic:[...], ignoredN }
//   item = { url, host, kind, cls:'local'|'online', why?, rank?, chain?, insecure?, proto?, sri?, integrity?, refs:[{ p, n }], refsN }
//   integrity = isi atribut `integrity` tag yang memuat URL itu (bila ada): sampai 4 nilai berbeda digabung spasi, tiap nilai <= 1024 karakter (yang lebih panjang tidak dibawa; sri tetap true). DATA dari berkas situs: renderer wajib menyisipkannya sebagai teks; yang memverifikasi adalah archne-websri (O2d-2) lewat archne-webstage.
//   cls 'local'  = bisa dijadikan salinan lokal (skrip / gaya / font / gambar statis). rank 'cdn' = CDN statis yang dikenal, 'other' = host lain (UI sebaiknya tidak mencentangnya otomatis).
//   cls 'online' = TETAP butuh internet, tidak boleh disalin: why = 'service' (peta, captcha, analitik, embed, pembayaran) | 'runtime' (fetch / XHR / WebSocket) | 'module' (import ES) | 'embed' (iframe) | 'media' (audio / video) | 'private' (localhost / jaringan privat) | 'cred' (URL memuat kata sandi).
//   dynamic = [{ p, hint:'wp'|'dom'|'concat'|'tpl', n }]: tanda URL yang dirakit saat jalan dan TIDAK bisa dipindai; UI wajib menampilkan "mungkin ada yang terlewat".
// Keamanan: isi hasil berasal dari berkas situs (bisa dari peer): URL dan jalur adalah DATA, renderer wajib menyisipkannya sebagai teks (bukan HTML). URL dipangkas dari kata sandi; panjang dan jumlah dibatasi.
// Batas kerja (melindungi proses utama; BUKAN batas ukuran situs): per berkas 1 MB, 3000 berkas, 32 MB total, 4 detik, 500 URL. Bila tercapai, `limits` memuat kodenya dan UI harus menyebut hasil tidak lengkap.
const net = require('net');

const LIM = { integ: 1024, integN: 4, file: 1024 * 1024, files: 3000, entries: 50000, bytes: 32 * 1024 * 1024, ms: 4000, items: 500, refs: 10, dyn: 80, skip: 30, hrefs: 4000 };
const SCAN_EXT = new Set(['html', 'htm', 'xhtml', 'php', 'svg', 'css', 'js', 'mjs']);
const SKIP_DIR = new Set(['node_modules', '.git']);
const VENDOR_DIR = 'assets/vendor'; // keluaran O3: tidak dipindai ulang
const FONT = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);
const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp']);
const MEDIA = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac']);
const NS_HOST = new Set(['www.w3.org', 'w3.org', 'schema.org', 'www.sitemaps.org', 'purl.org', 'xmlns.com', 'ns.adobe.com']); // alamat ruang nama, bukan permintaan

// CDN statis yang dikenal (host persis atau sufiks).
const CDN = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'code.jquery.com', 'stackpath.bootstrapcdn.com', 'maxcdn.bootstrapcdn.com', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'use.fontawesome.com', 'ajax.googleapis.com', 'cdn.datatables.net', 'cdn.bootcss.com', 'stackpath.bootstrapcdn.com'];
const isCdn = (h) => CDN.some((c) => h === c || h.endsWith('.' + c));
// Layanan yang hidup dari server mereka (data / skrip dinamis): tidak boleh disalin. Diuji terhadap "host/jalur".
const SERVICE = [
  /(^|\.)google\.com\/(recaptcha|maps|jsapi)/, /(^|\.)gstatic\.com\/recaptcha/, /(^|\.)googleapis\.com\/maps/, /^(maps|places)\.googleapis\.com/,
  /(^|\.)(googletagmanager|google-analytics|googlesyndication|googleadservices|doubleclick)\.(com|net)/, /(^|\.)(facebook\.net|facebook\.com|fbcdn\.net)/, /(^|\.)(twitter|x)\.com/,
  /(^|\.)(youtube|youtube-nocookie|ytimg)\.com/, /(^|\.)youtu\.be/, /(^|\.)vimeo\.com/, /(^|\.)(stripe|paypal|paypalobjects|midtrans|xendit)\.(com|co)/,
  /(^|\.)(hcaptcha\.com|challenges\.cloudflare\.com|cloudflareinsights\.com)/, /(^|\.)kit(-free)?\.fontawesome\.com/, /(^|\.)(hotjar|clarity|segment|mixpanel|sentry|crisp|tawk|disqus)\./, /(^|\.)(tiktok|instagram)\.com/,
];
const isService = (host, path) => SERVICE.some((r) => r.test(host + path));

function privateHost(h) {
  h = String(h).replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h)) return true;
  const v = net.isIP(h);
  if (v === 4) { const [a, b] = h.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  if (v === 6) return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}

const dec = (s) => String(s).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'");
const TPL = /<\?|\{\{|\$\{|\{%|<%/;
function attr(tag, name) { // lookbehind: "src" tidak boleh cocok dengan "data-src" / "xlink:href"
  const m = new RegExp('(?<![\\w:-])' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? dec(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
}
const extOfUrl = (u) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(u.pathname); return m ? m[1].toLowerCase() : ''; };
const kindByExt = (u, dflt) => { const e = extOfUrl(u); return e === 'css' ? 'style' : e === 'js' || e === 'mjs' ? 'script' : FONT.has(e) ? 'font' : IMG.has(e) ? 'image' : MEDIA.has(e) ? 'media' : dflt; };

// ---- pengumpul ----
function mkCtx() { return { items: new Map(), dyn: new Map(), ignored: 0, droppedN: 0 }; }
function ref(ctx, raw, kind, rel, ex) {
  if (typeof raw !== 'string') return;
  let s = raw.trim();
  if (!s || s.length > 2048) return;
  if (TPL.test(s) && /\/\//.test(s)) { dyn(ctx, rel, 'tpl'); return; } // alamat berisi templat: dirakit saat jalan
  let proto = false;
  if (s.startsWith('//')) { s = 'https:' + s; proto = true; }
  if (!/^https?:\/\//i.test(s)) return; // relatif, data:, blob:, mailto: dst. bukan urusan di sini
  let u; try { u = new URL(s); } catch { return; }
  if (!u.hostname) return;
  const cred = !!(u.username || u.password);
  u.username = ''; u.password = ''; u.hash = '';
  const key = u.href;
  let it = ctx.items.get(key);
  if (!it) {
    if (ctx.items.size >= LIM.items) { ctx.droppedN++; return; }
    it = { url: key, host: u.hostname.toLowerCase(), u, kinds: new Set(), insecure: u.protocol === 'http:' && !proto, proto, cred, sri: false, integ: [], refs: new Map() };
    ctx.items.set(key, it);
  }
  it.kinds.add(kind === 'other' ? kindByExt(u, 'other') : kind);
  if (ex && ex.sri) it.sri = true;
  if (ex && typeof ex.integrity === 'string') { const v = ex.integrity.trim(); if (v && v.length <= LIM.integ && it.integ.length < LIM.integN && !it.integ.includes(v)) it.integ.push(v); } // string atribut integrity (DATA dari berkas situs; O2d-3 yang memverifikasi)
  it.refs.set(rel, (it.refs.get(rel) || 0) + 1);
}
function dyn(ctx, rel, hint) { const k = rel + '\n' + hint; if (ctx.dyn.size < LIM.dyn || ctx.dyn.has(k)) ctx.dyn.set(k, (ctx.dyn.get(k) || 0) + 1); }

// ---- CSS ----
function scanCss(ctx, css, rel) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let m;
  const imp = /@import\s+(?:url\(\s*)?["']?([^"')\s;]{1,2048})/gi;
  while ((m = imp.exec(css))) ref(ctx, m[1], 'style', rel);
  const url = /url\(\s*(["']?)([^"')]{1,2048})\1\s*\)/gi;
  while ((m = url.exec(css))) ref(ctx, m[2], 'other', rel);
}

// ---- JS / PHP: hanya string yang SELURUHNYA berupa URL (bukan teks bebas / komentar) ----
const STR = /(["'`])((?:https?:)?\/\/[^"'`\s\\]{3,2000})\1/g;
const FETCHCTX = /(?:fetch|axios(?:\.\w+)?|\.open|\.ajax|\.get|\.post|WebSocket|EventSource|sendBeacon|importScripts|file_get_contents|curl_init|wp_remote_\w+|CURLOPT_URL|url\s*:)\s*[(,:=]?\s*$/i;
function scanStrings(ctx, text, rel) {
  let m;
  STR.lastIndex = 0;
  while ((m = STR.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (/href\s*=\s*$/i.test(before)) continue; // tautan, bukan aset
    let host = '';
    try { host = new URL(m[2].startsWith('//') ? 'https:' + m[2] : m[2]).hostname.toLowerCase(); } catch { continue; }
    if (NS_HOST.has(host)) continue;
    let kind = null;
    if (/(?:\bimport\s*\(|\bfrom\s*|\bimport\s*)$/.test(before)) kind = 'import';
    else if (/wp_(?:enqueue|register)_script\s*\(\s*(?:['"][^'"]*['"]\s*,\s*)?$/.test(before)) kind = 'script';
    else if (/wp_(?:enqueue|register)_style\s*\(\s*(?:['"][^'"]*['"]\s*,\s*)?$/.test(before)) kind = 'style';
    else if (FETCHCTX.test(before)) kind = 'fetch';
    else { const u = new URL(m[2].startsWith('//') ? 'https:' + m[2] : m[2]); const k = kindByExt(u, ''); if (k && k !== 'media') kind = k; }
    if (!kind) { ctx.ignored++; continue; } // URL polos tanpa ciri aset (kemungkinan tautan): diabaikan
    ref(ctx, m[2], kind, rel);
  }
  const ws = /\bnew\s+(?:WebSocket|EventSource)\s*\(\s*(["'`])(wss?:\/\/[^"'`\s\\]{3,2000})\1/g;
  while ((m = ws.exec(text))) ref(ctx, m[2].replace(/^ws/i, 'http'), 'ws', rel);
}

// ---- tanda URL dinamis ----
function scanDyn(ctx, text, rel, php) {
  if (php && /\bwp_(?:enqueue|register)_(?:script|style)\s*\(|\bwp_(?:head|footer)\s*\(/.test(text)) dyn(ctx, rel, 'wp');
  if (/createElement\(\s*["'](?:script|link)["']\s*\)|document\.write\s*\([^)]{0,200}<script/i.test(text)) dyn(ctx, rel, 'dom');
  if (/["'`](?:https?:)?\/\/["'`]\s*\+|["'`]https?:["'`]\s*\+|["'`]https?:\/\/["'`]\s*\+|`(?:https?:)?\/\/\$\{/.test(text)) dyn(ctx, rel, 'concat');
}

// ---- HTML / PHP / SVG ----
const SRCSET = (v) => String(v).split(/,\s+/).map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
function scanTag(ctx, tag, name, rel) {
  const a = (n) => attr(tag, n), iv = a('integrity'), sri = iv != null;
  const one = (n, kind) => { const v = a(n); if (v != null) ref(ctx, v, kind, rel, { sri, integrity: iv }); };
  const set = (n, kind) => { const v = a(n); if (v != null) { if (TPL.test(v)) { ref(ctx, v, kind, rel); } else for (const s of SRCSET(v)) ref(ctx, s, kind, rel); } };
  switch (name) {
    case 'script': one('src', 'script'); break;
    case 'link': {
      const rl = (a('rel') || '').toLowerCase(), as = (a('as') || '').toLowerCase();
      if (!/\b(stylesheet|preload|modulepreload|prefetch|icon|apple-touch-icon|mask-icon)\b/.test(rl)) break; // preconnect / dns-prefetch / canonical / manifest dll. bukan aset
      one('href', /stylesheet/.test(rl) || as === 'style' ? 'style' : as === 'font' ? 'font' : as === 'script' || /modulepreload/.test(rl) ? 'script' : /icon/.test(rl) || as === 'image' ? 'image' : 'other');
      if (a('imagesrcset') != null) set('imagesrcset', 'image');
      break;
    }
    case 'img': one('src', 'image'); set('srcset', 'image'); one('data-src', 'image'); set('data-srcset', 'image'); break;
    case 'input': if ((a('type') || '').toLowerCase() === 'image') one('src', 'image'); break;
    case 'source': one('src', 'other'); set('srcset', 'image'); break;
    case 'video': one('src', 'media'); one('poster', 'image'); break;
    case 'audio': one('src', 'media'); break;
    case 'iframe': case 'frame': case 'embed': one('src', 'frame'); break;
    case 'object': one('data', 'frame'); break;
    case 'image': case 'use': one('href', 'image'); one('xlink:href', 'image'); break;
    default: break;
  }
  const st = a('style'); if (st && /url\(/i.test(st)) scanCss(ctx, st, rel);
}
function scanHtml(ctx, text, rel, php) {
  text = text.replace(/<!--[\s\S]*?-->/g, ''); // tautan yang dikomentari tidak dihitung
  let m;
  const tags = /<(script|link|img|input|source|video|audio|iframe|frame|embed|object|image|use|div|body|section|span|a|p|td|header|footer|main|li|ul|button)\b((?:"[^"]*"|'[^']*'|[^'">]){0,4000})>/gi;
  while ((m = tags.exec(text))) scanTag(ctx, m[0], m[1].toLowerCase(), rel);
  const sty = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = sty.exec(text))) scanCss(ctx, m[1], rel);
  const scr = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = scr.exec(text))) { if (!/\bsrc\s*=/i.test(m[1]) && m[2].trim()) scanStrings(ctx, m[2], rel); }
  if (php) scanStrings(ctx, text, rel);
  scanDyn(ctx, text, rel, php);
}

// ---- penggolongan ----
const PRI = ['fetch', 'ws', 'import', 'frame', 'script', 'style', 'font', 'image', 'media', 'other'];
function classify(it) {
  const k = PRI.find((x) => it.kinds.has(x)) || 'other';
  const o = { url: it.url, host: it.host, kind: k, cls: 'local' };
  const path = it.u.pathname.toLowerCase();
  if (it.cred) { o.cls = 'online'; o.why = 'cred'; }
  else if (privateHost(it.host)) { o.cls = 'online'; o.why = 'private'; }
  else if (it.kinds.has('fetch') || it.kinds.has('ws')) { o.cls = 'online'; o.why = 'runtime'; }
  else if (it.kinds.has('import')) { o.cls = 'online'; o.why = 'module'; }
  else if (isService(it.host, path)) { o.cls = 'online'; o.why = 'service'; }
  else if (it.kinds.has('frame')) { o.cls = 'online'; o.why = 'embed'; }
  else if (k === 'media') { o.cls = 'online'; o.why = 'media'; }
  if (o.cls === 'local') {
    o.rank = isCdn(it.host) ? 'cdn' : 'other';
    if (k === 'style') o.chain = true; // CSS bisa menunjuk ke font / gambar lain (O3 mengikutinya)
    if (it.insecure) o.insecure = true;
  }
  if (it.proto) o.proto = true;
  if (it.sri) o.sri = true;
  if (it.integ.length) o.integrity = it.integ.join(' ');
  const refs = [...it.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  o.refs = refs.slice(0, LIM.refs).map(([p, n]) => ({ p, n }));
  o.refsN = refs.length;
  return o;
}

const tick = () => new Promise((r) => setImmediate(r));
const extOf = (p) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(p); return m ? m[1].toLowerCase() : ''; };

// wf = WebFiles situs. Menelusuri melebar (berkas di akar dipindai lebih dulu bila batas tercapai).
async function scan(wf) {
  const ctx = mkCtx(), t0 = Date.now(), limits = new Set(), skipped = [];
  let files = 0, scanned = 0, bytes = 0, entries = 0, skippedN = 0;
  const skip = (p, code) => { skippedN++; if (skipped.length < LIM.skip) skipped.push({ p, code }); };
  const queue = [''];
  outer: while (queue.length) {
    const dir = queue.shift();
    let list;
    try { list = wf.list(dir); } catch { continue; }
    for (const e of list) {
      if (++entries > LIM.entries) { limits.add('entries'); break outer; }
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.type === 'dir') { if (!SKIP_DIR.has(e.name.toLowerCase()) && rel !== VENDOR_DIR) queue.push(rel); continue; }
      const ext = extOf(e.name);
      if (!SCAN_EXT.has(ext)) continue;
      files++;
      if (scanned >= LIM.files) { limits.add('files'); break outer; }
      if (bytes + e.size > LIM.bytes) { limits.add('bytes'); break outer; }
      if (Date.now() - t0 > LIM.ms) { limits.add('time'); break outer; }
      if (e.size > LIM.file) { skip(rel, 'big'); continue; }
      let buf;
      try { buf = wf.read(rel, { max: LIM.file }); } catch { skip(rel, 'io'); continue; }
      if (buf.indexOf(0) >= 0) { skip(rel, 'bin'); continue; }
      bytes += buf.length; scanned++;
      const text = buf.toString('utf8');
      if (ext === 'css') scanCss(ctx, text, rel);
      else if (ext === 'js' || ext === 'mjs') { scanStrings(ctx, text, rel); scanDyn(ctx, text, rel, false); }
      else scanHtml(ctx, text, rel, ext === 'php');
      if (scanned % 25 === 0) await tick();
    }
  }
  if (ctx.droppedN) limits.add('items');
  const items = [...ctx.items.values()].map(classify).sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const hm = new Map();
  for (const it of items) { const h = hm.get(it.host) || { host: it.host, local: 0, online: 0 }; h[it.cls]++; hm.set(it.host, h); }
  const dynamic = [...ctx.dyn.entries()].map(([k, n]) => { const [p, hint] = k.split('\n'); return { p, hint, n }; }).sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : a.hint < b.hint ? -1 : 1));
  return { files, scanned, bytes, skipped, skippedN, limits: [...limits], items, itemsN: items.length, hosts: [...hm.values()].sort((a, b) => (a.host < b.host ? -1 : 1)), dynamic, ignoredN: ctx.ignored };
}

module.exports = { scan, LIM, privateHost, isCdn, isService };
