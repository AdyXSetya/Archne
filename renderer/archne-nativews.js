'use strict';
// WebSocket yang dibuka di proses utama (lihat src/archne-wsproxy.js), dengan antarmuka secukupnya untuk mqtt.js (opsi createWebsocket):
// readyState/OPEN, binaryType, addEventListener (open|close|error|message), onopen/..., send, close, bufferedAmount.
// Dimuat dengan <script src="archne-nativews.js"> (global `ArchneNativeWs`); di Node (tes) lewat require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArchneNativeWs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // api: { wsOpen(id,url,protocols), wsSend(id,data), wsClose(id), onWs(cb) }. Mengembalikan createWebsocket(url, protocols, opts) untuk mqtt.js.
  function createNativeWs(api) {
    const socks = new Map();
    let seq = 0, hooked = false;
    const hook = () => {
      if (hooked) return; hooked = true;
      api.onWs((ev) => { const s = ev && socks.get(ev.id); if (s) s._ev(ev.t, ev.data); });
    };
    class NativeWebSocket {
      constructor(url, protocols, log) {
        hook(); this._log = typeof log === 'function' ? log : () => {}; this._nr = 0; this._ns = 0;
        this.url = url; this.protocol = ''; this.binaryType = 'arraybuffer'; this.readyState = 0; this.bufferedAmount = 0;
        this._L = { open: [], close: [], error: [], message: [] };
        this._id = 'n' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
        socks.set(this._id, this);
        Promise.resolve(api.wsOpen(this._id, url, protocols)).then((r) => {
          if (r && r.ok === false) { this._log('ws: dibuka ditolak: ' + (r.err || '?')); this._ev('error', r.err || 'wsOpen ditolak'); this._ev('close', 1006); }
        }, (e) => { this._log('ws: IPC gagal: ' + String((e && e.message) || e)); this._ev('error', String((e && e.message) || e)); this._ev('close', 1006); });
      }
      get OPEN() { return 1; }
      addEventListener(t, f) { if (this._L[t]) this._L[t].push(f); }
      removeEventListener(t, f) { if (this._L[t]) this._L[t] = this._L[t].filter((x) => x !== f); }
      _fire(t, e) {
        const h = this['on' + t];
        if (typeof h === 'function') { try { h.call(this, e); } catch { /* pendengar tidak boleh merusak */ } }
        for (const f of this._L[t].slice()) { try { f.call(this, e); } catch { /* idem */ } }
      }
      _ev(t, data) {
        if (t === 'error') this._log('ws: galat ' + data); else if (t === 'close') this._log('ws: ditutup kode ' + data); else if (t === 'open') this._log('ws: terbuka');
        if (this.readyState === 3 && t !== 'close') return;
        if (t === 'open') { this.readyState = 1; this._fire('open', { type: 'open' }); }
        else if (t === 'msg') {
          let d = data;
          if (d && typeof d === 'object' && typeof d.b64 === 'string') { const bin = atob(d.b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); d = u.buffer; }
          if (this._nr++ < 4) this._log('ws: terima #' + this._nr + ' ' + (typeof d === 'string' ? d.length : d.byteLength) + ' bita' + (d instanceof ArrayBuffer && d.byteLength ? ' tipe ' + (new Uint8Array(d)[0] >> 4) + ' hex ' + Array.from(new Uint8Array(d).slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('') : ''));
          this._fire('message', { type: 'message', data: d });
        } else if (t === 'error') this._fire('error', { type: 'error', message: String(data || '') });
        else if (t === 'close') {
          if (this.readyState === 3) return;
          this.readyState = 3; socks.delete(this._id); this._fire('close', { type: 'close', code: data || 1006, wasClean: false });
        }
      }
      send(data) {
        if (this.readyState !== 1) throw new Error('WebSocket belum terbuka');
        let text = false, payload;
        if (typeof data === 'string') { text = true; payload = data; }
        else {
          const u = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
          payload = btoa(bin);
          if (this._ns++ < 4) this._log('ws: kirim #' + this._ns + ' ' + u.length + ' bita tipe ' + (u[0] >> 4));
        }
        Promise.resolve(api.wsSend(this._id, payload, text)).then((r) => { if (r && r.ok === false) this._log('ws: kirim DITOLAK Core'); }, (e) => this._log('ws: kirim gagal: ' + String((e && e.message) || e)));
      }
      close() {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        Promise.resolve(api.wsClose(this._id)).catch(() => {});
        setTimeout(() => this._ev('close', 1000), 0);
      }
    }
    return (url, protocols, log) => new NativeWebSocket(url, protocols, log);
  }
  return { createNativeWs };
});
