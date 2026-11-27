'use strict';
// Gerbang cookie + sesi untuk situs PHP (P.4), sisi PENAMPIL. Netral terhadap transport: send(req) bisa router PHP lokal (pratinjau pemilik, P.3)
// atau lw_req ke perangkat pemilik (P.5). Dipakai oleh archne-sitebrowser.respond() (Electron) dan lewat respond() oleh archne-siteserver (Android).
// Tugas: (1) header Cookie SELALU dari jar situs ini (Cookie dari peramban/halaman tidak dipercaya); (2) Set-Cookie dari PHP masuk jar, tidak diteruskan;
// (3) HTML disisipi shim document.cookie (HttpOnly tersembunyi); (4) Location: relatif tetap, absolut ke situs sendiri dijadikan relatif, absolut ke luar
// -> onExternal (konfirmasi pengguna) + 403, bukan diikuti; (5) header jawaban yang bisa melonggarkan kebijakan penampil dibuang (CSP, CORP, Refresh, dst.).
// Sesi PHP ada di data/sessions milik pemilik; yang dipegang penampil hanya cookie PHPSESSID.
const { shimOffset, shimTagBytes } = require('./archne-cookiejar');

const DROP_RES = new Set(['set-cookie', 'set-cookie2', 'content-security-policy', 'content-security-policy-report-only', 'permissions-policy', 'cross-origin-resource-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'referrer-policy', 'strict-transport-security', 'clear-site-data', 'x-content-type-options', 'cache-control', 'expires', 'pragma', 'refresh', 'link', 'transfer-encoding', 'connection', 'keep-alive', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers']);
const HTML_WIN = 65536;
const text = (status, t) => ({ status, headers: { 'content-type': ['text/plain; charset=utf-8'] }, body: Buffer.from(t || '') });

function createPhpGate(o) {
  if (!o || !o.jar || typeof o.send !== 'function') throw new Error('createPhpGate: jar dan send wajib');
  const { jar, send } = o;

  // Location -> { loc } (boleh dipakai), { external } atau { block }
  function location(v, host) {
    v = String(v || '');
    if (!v) return { block: true };
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) {
      let u; try { u = new URL(v.startsWith('//') ? 'http:' + v : v); } catch { return { block: true }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { block: true };
      if (host && u.host.toLowerCase() === String(host).toLowerCase()) return { loc: u.pathname + u.search + u.hash };
      return { external: u.href };
    }
    if (/[\r\n\0]/.test(v)) return { block: true };
    return { loc: v };
  }

  async function fetch(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = String(req.pathname || '/'), search = String(req.search || '').replace(/^\?/, '');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) { const n = k.toLowerCase(); if (n !== 'cookie') headers[n] = v; }
    const ck = jar.header(pathname); if (ck) headers.cookie = ck;
    const r = await send({ method, path: pathname, query: search, headers, body: req.body, peer: o.peer, host: o.host });

    const out = {};
    for (const [k, v] of Object.entries(r.headers || {})) if (!DROP_RES.has(k.toLowerCase())) out[k.toLowerCase()] = Array.isArray(v) ? v : [String(v)];
    const sc = (r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie'])) || [];
    jar.setAll(Array.isArray(sc) ? sc : [String(sc)], pathname);

    if (out.location) {
      const l = location(out.location[0], o.host);
      if (l.block) return text(502, 'Location tidak valid');
      if (l.external) { try { if (o.onExternal) o.onExternal(l.external); } catch (_) {} return text(403, 'Pengalihan ke situs luar diblokir'); }
      out.location = [l.loc];
    }

    let body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body || '');
    const ct = String((out['content-type'] || [''])[0]), noBody = r.status === 204 || r.status === 304 || (r.status >= 100 && r.status < 200);
    if (method !== 'HEAD' && !noBody && /^text\/html\b/i.test(ct) && !out['content-encoding'] && o.shim !== false) {
      const head = body.subarray(0, HTML_WIN);
      let off = shimOffset(head);
      if (off >= head.length && body.length > head.length) off = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
      body = Buffer.concat([body.subarray(0, off), shimTagBytes(jar.visible(pathname), o.nonce), body.subarray(off)]);
    }
    if (method !== 'HEAD') out['content-length'] = [String(body.length)];
    return { status: r.status, headers: out, body };
  }
  return { fetch };
}

module.exports = { createPhpGate, DROP_RES };
