'use strict';
// Jalur cadangan WebSocket untuk MQTT (v0.21.3): sambungan dibuka di proses utama Electron lewat Node (paket `ws`), bukan lewat
// jaringan Chromium. Dipakai renderer/archne-nativews.js hanya bila sambungan WebSocket Chromium gagal (mis. handshake TLS macet di jaringan/antivirus tertentu).
// Renderer hanya boleh membuka alamat yang lolos validBroker (wss://, atau ws:// ke localhost), paling banyak MAX soket sekaligus.
const { validBroker } = require('./archne-invite');

const MAX = 4;
const HANDSHAKE_MS = 15000;

function createWsProxy({ WebSocket, send, log }) {
  const socks = new Map(); // id -> ws
  const lg = (m) => { try { log && log(m); } catch { /* log tidak boleh merusak */ } };
  const emit = (id, t, data) => { try { send && send({ id, t, data }); } catch { /* jendela sudah tutup */ } };
  const okId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id);

  function open(id, url, protocols) {
    if (!okId(id)) throw new Error('id soket tidak valid');
    if (!validBroker(url)) throw new Error('Alamat broker tidak valid');
    const protos = Array.isArray(protocols) ? protocols.filter((p) => typeof p === 'string' && /^[\w.-]{1,32}$/.test(p)).slice(0, 4) : [];
    if (socks.has(id)) throw new Error('id soket sudah dipakai');
    if (socks.size >= MAX) throw new Error('Terlalu banyak soket');
    const ws = new WebSocket(url, protos, { handshakeTimeout: HANDSHAKE_MS, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
    socks.set(id, ws);
    lg('wsproxy: buka ' + url);
    ws.on('open', () => emit(id, 'open'));
    ws.on('message', (data, isBinary) => {
      const b = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      emit(id, 'msg', isBinary ? { b64: b.toString('base64') } : b.toString('utf8')); // base64: byte mentah lewat contextBridge/IPC tidak dapat diandalkan di Electron
    });
    ws.on('error', (e) => { lg('wsproxy: galat ' + (e && e.message)); emit(id, 'error', String((e && e.message) || e)); });
    ws.on('unexpected-response', (_req, res) => { lg('wsproxy: respons tak terduga HTTP ' + res.statusCode); emit(id, 'error', 'HTTP ' + res.statusCode); });
    ws.on('close', (code) => { if (socks.get(id) === ws) socks.delete(id); emit(id, 'close', code); });
    return true;
  }
  function sendData(id, data, text) {
    const ws = socks.get(id);
    if (!ws) { lg('wsproxy: kirim ke soket yang tidak ada'); return false; }
    if (ws.readyState !== 1) { lg('wsproxy: kirim saat readyState=' + ws.readyState); return false; }
    if (typeof data !== 'string' || data.length > 8 * 1024 * 1024) throw new Error('Data tidak valid');
    if (text === true) ws.send(data, { binary: false });
    else ws.send(Buffer.from(data, 'base64'), { binary: true });
    return true;
  }
  function close(id) {
    const ws = socks.get(id);
    if (!ws) return false;
    socks.delete(id);
    try { ws.close(); } catch { /* sudah mati */ }
    try { setTimeout(() => { try { ws.terminate(); } catch { /* */ } }, 1000).unref(); } catch { /* */ }
    return true;
  }
  function dispose() { for (const id of [...socks.keys()]) close(id); }
  return { open, send: sendData, close, dispose, size: () => socks.size };
}

module.exports = { createWsProxy };
