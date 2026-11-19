'use strict';
// Penyaji media lokal (v0.25.0 Step 2b): Range + berkas yang masih tumbuh. Dipakai dua tempat: protokol archne-media:// di Electron (main.js)
// dan rute GET /media/<token> di server HTTP Android (src/archne-rpc.js). Semua byte dibaca lewat core.mediaSrcRead(token, start, len),
// jadi penyaji tidak pernah menerima jalur berkas dan tidak bisa diminta membaca berkas lain.
const { Readable } = require('stream');
const CHUNK = 256 * 1024, POLL_MS = 150, DEAD_MS = 20000; // DEAD_MS: tidak ada data dan unduhan tidak berjalan lagi -> berhenti

// "bytes=a-b" | "bytes=a-" | "bytes=-n" -> { start, end } | null (tanpa Range: kirim semua) | 'bad' (416). Hanya satu rentang.
function parseRange(h, total) {
  if (h === undefined || h === null || h === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let a, b;
  if (m[1] === '') { const n = Number(m[2]); if (!(n > 0)) return 'bad'; a = Math.max(0, total - n); b = total - 1; }
  else { a = Number(m[1]); b = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a > b || a >= total) return 'bad';
  return { start: a, end: b };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Generator potongan [start, end]. Menunggu selama unduhan masih berjalan; berhenti bila `signal` dibatalkan.
async function* chunks(core, tok, start, end, signal) {
  let pos = start, dead = 0;
  while (pos <= end && !(signal && signal.aborted)) {
    const b = await core.mediaSrcRead(tok, pos, Math.min(CHUNK, end - pos + 1));
    if (b === null) return;
    if (b.length) { pos += b.length; dead = 0; yield b; continue; }
    if (!core.mediaSrcLive(tok) && (dead += POLL_MS) > DEAD_MS) return;
    await sleep(POLL_MS);
  }
}
// Rencana respons dari token + header Range: { status, headers, from, to } atau { status: 404|416, headers }.
function plan(core, tok, rangeHeader) {
  const info = /^[0-9a-f]{32}$/.test(String(tok)) ? core.mediaSrcInfo(tok) : null;
  if (!info) return { status: 404, headers: { 'cache-control': 'no-store' } };
  const base = { 'content-type': info.mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  const r = parseRange(rangeHeader, info.total);
  if (r === 'bad') return { status: 416, headers: Object.assign({}, base, { 'content-range': `bytes */${info.total}` }) };
  if (!r) return { status: 200, headers: Object.assign({}, base, { 'content-length': String(info.total) }), from: 0, to: info.total - 1 };
  return { status: 206, headers: Object.assign({}, base, { 'content-range': `bytes ${r.start}-${r.end}/${info.total}`, 'content-length': String(r.end - r.start + 1) }), from: r.start, to: r.end };
}
// Node http: GET /media/<token>
async function serveHttp(core, tok, req, res) {
  const p = plan(core, tok, req.headers.range);
  res.writeHead(p.status, p.headers);
  if (req.method === 'HEAD' || p.from === undefined) return res.end();
  const ac = new AbortController(); const stop = () => ac.abort();
  res.on('close', stop); req.on('close', stop);
  try {
    for await (const b of chunks(core, tok, p.from, p.to, ac.signal)) { if (!res.write(b)) await new Promise((r) => { res.once('drain', r); res.once('close', r); }); if (ac.signal.aborted) break; }
  } catch {} finally { res.off && res.off('close', stop); res.end(); }
}
// Electron protocol.handle: (Request) -> Response
function serveWeb(core, tok, request) {
  const p = plan(core, tok, request.headers.get('range'));
  if (p.from === undefined || request.method === 'HEAD') return new Response(null, { status: p.status, headers: p.headers });
  const ac = new AbortController();
  if (request.signal) request.signal.addEventListener('abort', () => ac.abort(), { once: true });
  const body = Readable.toWeb(Readable.from(chunks(core, tok, p.from, p.to, ac.signal), { objectMode: false }));
  return new Response(body, { status: p.status, headers: p.headers });
}
module.exports = { parseRange, plan, chunks, serveHttp, serveWeb, CHUNK };
