'use strict';
// renderer/archne-siteframe.js — atribut iframe penampil situs (0.34.0 F.3.5a). Fungsi murni, tanpa UI, supaya bisa dites dengan Node.
// Keputusan V2 (hasil F.3.4): iframe situs memakai sandbox="allow-scripts allow-same-origin allow-forms" (allow-forms ditambah 25 Nov 2026: di Android situs tampil di iframe ini, dan tanpa allow-forms WebView memblokir pengiriman formulir secara diam-diam, jadi login situs PHP tidak jalan; Electron memakai WebContentsView, tanpa iframe). Formulir tetap dibatasi CSP: situs statis form-action 'none', situs PHP 'self'. Tanpa sandbox (V1) situs bisa memanggil top.location dan menavigasi UI pergi.
// allow-same-origin dipasang bersama allow-scripts supaya situs tetap punya origin sendiri (localStorage, fetch ke host sendiri, shim cookie); origin itu
// BUKAN origin UI, jadi allow-same-origin tidak memberi situs jalan ke UI. Tidak ada allow-top-navigation*, allow-popups*, allow-modals, allow-downloads.
// Alamat iframe hanya diterima bila bentuknya persis http://<16 heks>.lw.localhost:PORT/... (PORT sama dengan UI bila diberikan); selain itu tidak ada iframe.
// Perilaku sandbox di WebView Android BELUM terbukti: itu F.3.6.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SiteFrame = factory();
})(this, function () {
  const SANDBOX = 'allow-scripts allow-same-origin allow-forms';
  const HOST_RE = /^[0-9a-f]{16}\.lw\.localhost$/;

  // Mengembalikan alamat yang sudah dinormalkan, atau '' bila bukan alamat situs yang sah. port: string port UI (location.port) atau kosong.
  function check(url, port) {
    if (typeof url !== 'string' || !url || url.length > 2048) return '';
    let u; try { u = new URL(url); } catch (e) { return ''; }
    if (u.protocol !== 'http:' || u.username || u.password || !HOST_RE.test(u.hostname) || !u.port) return '';
    if (port !== undefined && port !== null && port !== '' && String(port) !== u.port) return '';
    if (u.hash) u.hash = '';
    return u.href;
  }

  // Atribut iframe, atau null bila alamatnya tidak sah.
  function attrs(url, opts) {
    const src = check(url, opts && opts.port);
    if (!src) return null;
    return { src, sandbox: SANDBOX, allow: '', referrerpolicy: 'no-referrer', title: 'site' };
  }

  // Membuat elemen iframe lewat doc.createElement (atribut lewat setAttribute, tanpa innerHTML). null bila alamat tidak sah.
  function build(doc, url, opts) {
    const a = attrs(url, opts);
    if (!a || !doc || typeof doc.createElement !== 'function') return null;
    const f = doc.createElement('iframe');
    // sandbox dipasang SEBELUM src, supaya muatan pertama sudah ber-sandbox
    for (const k of ['sandbox', 'allow', 'referrerpolicy', 'title', 'src']) f.setAttribute(k, a[k]);
    return f;
  }

  return { SANDBOX, HOST_RE, check, attrs, build };
});
