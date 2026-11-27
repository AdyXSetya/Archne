'use strict';
// Situs PHP milik peer di sisi PENAMPIL (0.34.0 P.5d): tanpa manifest/berkas; semua permintaan lewat core.webRemoteReq (lw_req). Dipisah dari archne-sitebrowser.js (batas ukuran modul).
const { errText } = require('./core/archne-ecode');

// Situs PHP milik peer (P.5d): tidak punya manifest/berkas; semua permintaan lewat core.webRemoteReq. `first` = jawaban probe GET / yang dipakai ulang untuk permintaan pertama (PHP tidak dijalankan dua kali).
async function probeRemote(core, peerId, siteId, h, fail) {
  const ac = new AbortController(); h.setAc(ac);
  try {
    const first = await core.webRemoteReq(peerId, siteId, { method: 'GET', path: '/', headers: { accept: 'text/html' } }, { signal: ac.signal });
    if (first === null) return { err: fail('e.site.gone', 'Situs tidak ditemukan atau tidak lagi dibagikan pemiliknya', 'gone') };
    return { remote: true, php: true, first, firstAt: Date.now(), man: { entry: '', rev: 0, files: [] }, offline: false, stale: false };
  } catch (e) {
    const c = (e && e.code) || 'peer';
    if (c === 'cancel') return { err: { ok: false, err: errText(e), code: 'cancel' } };
    if (c === 'old') return { err: fail('e.site.phpOld', 'Aplikasi pemilik belum mendukung situs PHP', 'old') };
    return { err: { ok: false, err: errText(e), code: c } };
  }
}
const REMOTE_FIRST_TTL = 30000;
// send untuk gerbang cookie: permintaan penonton -> webRemoteReq. Galat jadi jawaban HTTP biasa (tidak melempar), null ("tidak terlihat") = 404.
function makeRemoteSend(core, peerId, siteId, first, firstAt, signal) {
  let pre = first || null;
  const text = (status, msg) => ({ status, headers: { 'content-type': ['text/plain; charset=utf-8'] }, body: Buffer.from(msg) });
  return async (rq) => {
    if (pre && rq.method === 'GET' && rq.path === '/' && !rq.query && Date.now() - (firstAt || 0) < REMOTE_FIRST_TTL) { const f = pre; pre = null; return f; }
    pre = null;
    try {
      const r = await core.webRemoteReq(peerId, siteId, { method: rq.method, path: rq.path, query: rq.query, headers: rq.headers, body: rq.body }, { signal });
      return r || text(404, 'Situs tidak tersedia');
    } catch (e) {
      const c = e && e.code;
      return text(c === 'busy' ? 503 : c === 'offline' ? 504 : c === 'bad' ? 400 : 502, errText(e));
    }
  };
}

module.exports = { probeRemote, makeRemoteSend, REMOTE_FIRST_TTL };
