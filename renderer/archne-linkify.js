'use strict';
// renderer/archne-linkify.js — tautan web di chat (v0.25.1): fungsi murni, tanpa DOM, supaya bisa dites dengan Node.
// Tautan http(s):// atau www. di pesan ditampilkan sebagai chip ringkas (domain + sedikit jalur), bukan deretan teks panjang.
// Teks pesan TIDAK diubah: chip membawa tautan asli (data-url) supaya "Salin" mengembalikan persis yang dikirim.
// Hanya http dan https yang jadi tautan; skema lain (javascript:, file:, intent:) tidak pernah dijadikan chip.
// Satu pengecualian (0.34.0 F.5): archne://domain.archne@idPemilik (tautan situs Web Lokal) jadi chip bertipe 'site'. Isinya hanya domain + id pemilik; id situs TIDAK ada di tautan
// (dicari dari daftar milik pemilik saat diketuk), dan nama pemilik di chip dibaca dari daftar peer lokal (o.nameOf), bukan dari teks pesan, jadi tidak bisa dipalsukan.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Linkify = factory();
})(this, function () {
  const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  // Tautan situs: domain 3-32 (a-z, 0-9, tanda hubung) + '.archne' + '@' + id pemilik (16 heksa). Aturan domain sama dengan src/archne-webdomain.js (dicek ulang di proses utama).
  const SITE_RE = /archne:\/\/[a-z0-9-]+\.archne@[0-9a-f]{16}(?![0-9a-z])/i;
  const SITE_DOM = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/, SITE_RESERVED = /^(archne|localhost|www|con|prn|aux|nul|(com|lpt)[0-9])$/;
  const ALL_RE = new RegExp(URL_RE.source + '|' + SITE_RE.source, 'gi');
  const lowerAZ = (x) => x.replace(/[A-Z]/g, (c) => c.toLowerCase()); // hanya A-Z (toLowerCase penuh mengubah U+212A menjadi \"k\")
  // Tautan situs -> { domain, peerId, link } (bentuk baku huruf kecil) atau null.
  function parseSite(u) {
    const m = /^archne:\/\/([a-z0-9-]+)\.archne@([0-9a-f]{16})$/i.exec(String(u == null ? '' : u).trim());
    if (!m) return null;
    const domain = lowerAZ(m[1]), peerId = lowerAZ(m[2]);
    if (domain.length < 3 || domain.length > 32 || !SITE_DOM.test(domain) || domain.includes('--') || SITE_RESERVED.test(domain)) return null;
    return { domain, peerId, link: 'archne://' + domain + '.archne@' + peerId };
  }
  const MAX_URL = 2048;   // lebih panjang dari ini tidak dijadikan tautan
  const MAX_REST = 22;    // panjang jalur yang ditampilkan di chip (selebihnya …)
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const count = (s, ch) => { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] === ch) n++; return n; };

  // Buang tanda baca penutup kalimat; kurung tutup hanya dibuang bila tidak punya pasangan buka di dalam tautan.
  function trimEnd(u) {
    for (;;) {
      const c = u[u.length - 1];
      if (!c) return u;
      if ('.,;:!?'.indexOf(c) >= 0) { u = u.slice(0, -1); continue; }
      if (c === ')' || c === ']' || c === '}') {
        const o = c === ')' ? '(' : c === ']' ? '[' : '{';
        if (count(u, c) > count(u, o)) { u = u.slice(0, -1); continue; }
      }
      return u;
    }
  }

  // Tautan -> alamat aman (string) atau null. www.x dilengkapi https://.
  function safeHref(u) {
    u = String(u == null ? '' : u).trim();
    if (!u || u.length > MAX_URL) return null;
    if (/^www\./i.test(u)) u = 'https://' + u;
    if (!/^https?:\/\//i.test(u)) return null;
    let p;
    try { p = new URL(u); } catch (e) { return null; }
    if ((p.protocol !== 'http:' && p.protocol !== 'https:') || !p.hostname) return null;
    return p.href;
  }

  // Bagian tampilan: host dari penguraian URL (bukan dari teks), jadi "https://bank.com@evil.com" tampil sebagai evil.com.
  function parts(href) {
    const p = new URL(href);
    const host = p.hostname.replace(/^www\./i, '');
    let rest = (p.pathname === '/' ? '' : p.pathname) + p.search + p.hash;
    let cut = false;
    try { rest = decodeURI(rest); } catch (e) { /* biarkan apa adanya */ }
    if (rest.length > MAX_REST) { rest = rest.slice(0, MAX_REST).replace(/[\uD800-\uDBFF]$/, ''); cut = true; }
    return { host, rest, cut, secure: p.protocol === 'https:' };
  }

  // Teks -> [{ t: 'text', v } | { t: 'url', v (asli), href, s, e } | { t: 'site', v (asli), domain, peerId, link, s, e }]
  function split(text) {
    text = String(text == null ? '' : text);
    const out = [];
    let last = 0, m;
    ALL_RE.lastIndex = 0;
    while ((m = ALL_RE.exec(text))) {
      if (/^archne:/i.test(m[0])) { // tautan situs
        const sl = parseSite(m[0]);
        if (!sl) continue;
        if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
        out.push({ t: 'site', v: m[0], domain: sl.domain, peerId: sl.peerId, link: sl.link, s: m.index, e: m.index + m[0].length });
        last = m.index + m[0].length;
        ALL_RE.lastIndex = last;
        continue;
      }
      const orig = trimEnd(m[0]);
      const href = safeHref(orig);
      if (!href) continue;
      if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
      out.push({ t: 'url', v: orig, href, s: m.index, e: m.index + orig.length });
      last = m.index + orig.length;
      ALL_RE.lastIndex = last;
    }
    if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
    return out;
  }

  const has = (text) => split(text).some((x) => x.t === 'url');
  const urls = (text) => split(text).filter((x) => x.t === 'url').map((x) => x.v);

  // Chip: <span.lnkw data-url=asli><a.lnk href=aman>ikon host jalur</a><button.lnkcp>salin</button></span>
  // o = { icon, copy, esc } (ikon SVG disuntik renderer; tanpa ikon tetap jalan)
  const T = (k, fb) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k) : fb); // i18n (D2); tanpa I18N teks Indonesia cadangan
  function chip(u, o) {
    o = o || {};
    const e = o.esc || esc, pt = parts(u.href);
    return '<span class="lnkw" data-url="' + e(u.v) + '"><a class="lnk" href="' + e(u.href) + '" rel="noopener noreferrer" title="' + e(u.href) + '">'
      + (o.icon || '') + '<span class="lh">' + e(pt.host) + '</span>' + (pt.rest ? '<span class="lp">' + e(pt.rest) + (pt.cut ? '…' : '') + '</span>' : '') + '</a>'
      + '<button type="button" class="lnkcp" data-lcopy title="' + e(T('link.copy', 'Salin tautan')) + '" aria-label="' + e(T('link.copy', 'Salin tautan')) + '">' + (o.copy || '') + '</button></span>';
  }

  // Chip situs: ketuk = penampil (js/archne-sitelink.js). href '#' (tidak pernah menavigasi); tautan lengkap ada di data-url untuk Salin. Nama pemilik dari o.nameOf (daftar peer lokal).
  function siteChip(u, o) {
    o = o || {};
    const e = o.esc || esc;
    let nm = ''; try { nm = typeof o.nameOf === 'function' ? String(o.nameOf(u.peerId) || '') : ''; } catch (x) { nm = ''; }
    nm = nm.slice(0, 32) || u.peerId.slice(0, 6);
    const by = T('lw.by', 'oleh {name}').replace('{name}', () => nm), dom = u.domain + '.archne';
    return '<span class="lnkw lnks" data-url="' + e(u.v) + '"><a class="lnk lns" href="#" role="button" data-sdom="' + e(u.domain) + '" data-speer="' + e(u.peerId) + '" title="' + e(dom + ' · ' + by) + '">'
      + (o.icon || '') + '<span class="lh">' + e(dom) + '</span><span class="lp">' + e(by) + '</span></a>'
      + '<button type="button" class="lnkcp" data-lcopy title="' + e(T('link.copy', 'Salin tautan')) + '" aria-label="' + e(T('link.copy', 'Salin tautan')) + '">' + (o.copy || '') + '</button></span>';
  }

  // Teks pesan -> HTML aman: teks di-escape, tautan jadi chip.
  function html(text, o) {
    const e = (o && o.esc) || esc;
    return split(text).map((x) => (x.t === 'url' ? chip(x, o) : x.t === 'site' ? siteChip(x, o) : e(x.v))).join('');
  }

  // Titik potong n yang jatuh di tengah tautan digeser ke akhir tautan itu (tautan tidak pernah terbelah).
  function cut(text, n) {
    text = String(text == null ? '' : text);
    for (const x of split(text)) if ((x.t === 'url' || x.t === 'site') && n > x.s && n < x.e) return x.e;
    return n;
  }

  // Untuk pratinjau satu baris (balasan, sematan, daftar chat): tautan jadi "domain/jalur…".
  function short(text) {
    return split(text).map((x) => { if (x.t === 'site') return x.domain + '.archne'; if (x.t !== 'url') return x.v; const p = parts(x.href); return p.host + p.rest + (p.cut ? '…' : ''); }).join('');
  }

  return { split, has, urls, safeHref, parts, chip, siteChip, parseSite, html, cut, short, esc, URL_RE, SITE_RE, MAX_URL };
});
