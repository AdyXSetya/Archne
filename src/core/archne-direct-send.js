'use strict';
// src/core/archne-direct-send.js — Kirim Langsung, sisi PENGIRIM + aturan LAN-only (v0.24.0). Protokol byte ada di src/archne-direct.js.
// Sesi keluar: { id, to, toName, ts, state, files:[{p,s,m,a,d?}], total, count, sent }. state: offered | active | done | declined | cancelled.
// Daftar berkas hanya dikirim ke penerima SETELAH dia menerima tawaran (dx_list); `a` (path absolut) tidak pernah keluar dari perangkat ini.
// Sesi disimpan di dataDir/direct/out-<id>.json (+ .files.json) supaya pengiriman bisa dilanjutkan setelah aplikasi dibuka ulang.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const Direct = require('../archne-direct');
const Transport = require('../archne-transport');
const { HEX16, HEX32 } = require('./archne-constants');
const { localAddrs, privateIp, vpnish } = require('./archne-util');
const { ek } = require('./archne-ecode');

const DX_UP_MAX = 64, DX_UP_IP = 16, DX_PAGE = 1500, DX_ITEMS_MAX = 1000, DX_KEEP_MS = 86400000, DX_OLD_MS = 14 * 86400000;
const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };

module.exports = {
  _dxDir() { return path.join(this.opts.dataDir, 'direct'); },
  // LAN saja: alamat TCP biasa yang pribadi (RFC1918/link-local), loopback (satu perangkat), atau satu subnet dengan salah satu antarmukaku.
  // Alamat rtc: (antar jaringan/relay) DITOLAK, begitu juga IP publik dan VPN (kecuali opts.directVpn = true).
  _directOk(addr) {
    let ip = typeof addr === 'string' ? addr : addr && addr.ip;
    ip = String(ip || '').replace('::ffff:', '');
    if (Transport.isRtcAddr(ip) || !net.isIPv4(ip)) return false;
    if (this.opts.directAllow) return !!this.opts.directAllow(ip); // hook tes
    if (ip.startsWith('127.') || privateIp(ip)) return true;
    if (this.opts.directVpn && vpnish(ip)) return true;
    return localAddrs().some((a) => { const mk = a.mask.split('.').map(Number), x = ip.split('.').map(Number), y = a.ip.split('.').map(Number); return x.every((o, i) => (o & mk[i]) === (y[i] & mk[i])); });
  },
  // Salinan sementara berkas yang dipilih di HP (Android tidak punya path berkas): <dataDir>/dxout/<job>/<acak>/<nama>. Dihapus saat sesi berakhir (selesai/ditolak/dibatalkan), dibuang, atau gagal ditawarkan.
  _dxTmpRoot() { return path.join(this.opts.dataDir, 'dxout'); },
  _dxIsTmp(p) { return typeof p === 'string' && path.resolve(p).startsWith(path.resolve(this._dxTmpRoot()) + path.sep); },
  _dxRmTmpList(list) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!this._dxIsTmp(p)) continue;
      const a = path.resolve(p), root = path.resolve(this._dxTmpRoot()) + path.sep;
      try { fs.rmSync(a, { force: true }); } catch {}
      for (let d = path.dirname(a), n = 0; d.startsWith(root) && n < 2; d = path.dirname(d), n++) { try { fs.rmdirSync(d); } catch { break; } } // folder acak, lalu folder job, hanya bila sudah kosong
    }
  },
  _dxRmTmp(s) { const l = s.tmp; s.tmp = []; this._dxRmTmpList(l); },
  // Saat start: salinan yang tidak dipakai sesi mana pun (aplikasi ditutup di tengah menyalin, dll.) dibuang.
  _dxSweepTmp() {
    const root = this._dxTmpRoot(), keep = new Set();
    let jobs = [];
    try { jobs = fs.readdirSync(root); } catch { return; }
    for (const s of this._dxOut.values()) for (const p of s.tmp || []) keep.add(path.resolve(p));
    for (const j of jobs) {
      const jd = path.join(root, j); let subs = [];
      try { subs = fs.readdirSync(jd); } catch { try { fs.rmSync(jd, { force: true }); } catch {} continue; }
      for (const r of subs) {
        const rd = path.join(jd, r); let fl = [];
        try { fl = fs.readdirSync(rd); } catch { try { fs.rmSync(rd, { force: true }); } catch {} continue; }
        for (const f of fl) { const fp = path.join(rd, f); if (!keep.has(path.resolve(fp))) { try { fs.rmSync(fp, { force: true, recursive: true }); } catch {} } }
        try { fs.rmdirSync(rd); } catch {}
      }
      try { fs.rmdirSync(jd); } catch {}
    }
  },
  _dxFile(kind, id, ext) { return path.join(this._dxDir(), kind + '-' + id + ext); },
  _dxSaveOut(s, withFiles) {
    try {
      fs.mkdirSync(this._dxDir(), { recursive: true });
      if (withFiles) wj(this._dxFile('out', s.id, '.files.json'), s.files);
      const m = Object.assign({}, s); delete m.files; delete m.live;
      wj(this._dxFile('out', s.id, '.json'), m);
    } catch (e) { this.log('direct simpan gagal: ' + e.message); }
  },
  _dxDropOut(id) {
    const s = this._dxOut.get(id);
    if (s) for (const [sock, u] of this._dxUp) if (u.id === id) sock.destroy();
    if (s) this._dxRmTmp(s);
    this._dxOut.delete(id);
    for (const ext of ['.json', '.files.json']) { try { fs.unlinkSync(this._dxFile('out', id, ext)); } catch {} }
  },
  // Muat sesi keluar dari disk (dipanggil start). Sesi selesai > 1 hari atau umur > 14 hari dibuang.
  _dxLoadOut() {
    let names = [];
    try { names = fs.readdirSync(this._dxDir()); } catch { return; }
    for (const n of names) {
      const mt = /^out-([0-9a-f]{32})\.json$/.exec(n);
      if (!mt) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this._dxDir(), n), 'utf8'));
        s.files = JSON.parse(fs.readFileSync(this._dxFile('out', mt[1], '.files.json'), 'utf8'));
        const old = Date.now() - s.ts > DX_OLD_MS, fin = s.state !== 'offered' && s.state !== 'active';
        if (s.id !== mt[1] || old || (fin && Date.now() - (s.end || s.ts) > DX_KEEP_MS)) { this._dxDropOut(mt[1]); continue; }
        this._dxOut.set(s.id, s);
      } catch { this._dxDropOut(mt[1]); }
    }
    this._dxSweepTmp();
  },

  // Tawarkan berkas/folder (path absolut) ke satu peer di LAN. Tidak ada batas ukuran. Mengembalikan ringkasan sesi.
  // Penerima harus menerima dulu; byte baru mengalir setelah itu. Kedua pihak harus online sampai selesai (tidak ada kurir).
  // opts.tmp = path salinan sementara (di bawah dxout) yang dihapus bila tawaran gagal atau sesinya berakhir.
  directSend(peerId, paths, opts = {}) {
    return this._directSend(peerId, paths, opts).catch((e) => { this._dxRmTmpList(opts.tmp); throw e; });
  },
  async _directSend(peerId, paths, opts = {}) {
    const p = this.peers.get(String(peerId));
    if (!p || !HEX16.test(String(peerId))) throw ek('e.dx.noPeer', null, 'Peer tidak dikenal', 'peer');
    if (this.isBlocked(p.id)) throw ek('e.profile.blockedPeer', null, 'Kamu memblokir orang ini. Buka blokirnya dulu.', 'blocked');
    if (!this._directOk(p.ip)) throw Object.assign(new Error(Direct.TEXT.lan), { code: 'lan' });
    if (!this.isOnline(p)) throw ek('e.dx.peerOffline', null, 'Peer sedang offline. Kirim Langsung butuh kedua pihak online.', 'offline');
    if (!Array.isArray(paths) || !paths.length || paths.length > DX_ITEMS_MAX) throw ek('e.dx.pickItems', { max: DX_ITEMS_MAX }, 'Pilih 1–{max} berkas/folder');
    const sc = await Direct.scan(paths, { signal: opts.signal, onProgress: opts.onScan });
    if (!sc.count) throw ek('e.dx.empty', null, 'Tidak ada isi yang bisa dikirim', 'empty');
    const id = crypto.randomBytes(16).toString('hex');
    const kind = paths.length === 1 && sc.files.length === 1 && !sc.files[0].d && sc.files[0].p === sc.tops[0] ? 'file' : 'dir';
    const name = sc.tops.length === 1 ? sc.tops[0] : sc.tops[0] + ' +' + (sc.tops.length - 1);
    const s = { id, to: p.id, toName: p.name, ts: Date.now(), state: 'offered', files: sc.files, total: sc.total, count: sc.count, tops: sc.tops.length, name, kind, sent: 0, skipped: sc.skipped, tmp: (Array.isArray(opts.tmp) ? opts.tmp : []).filter((x) => this._dxIsTmp(x)) };
    this._dxOut.set(id, s);
    this._dxSaveOut(s, true);
    const r = await this._request(p, { t: 'dx_offer', id, name, kind, count: sc.count, size: sc.total, tops: sc.tops.length }, 5000);
    if (!r || r.t !== 'ack' || !r.ok) {
      this._dxDropOut(id);
      throw r ? ek('e.dx.declined', null, 'Tawaran ditolak oleh penerima', 'denied') : ek('e.dx.noAnswer', null, 'Penerima tidak menjawab', 'offline');
    }
    this.emit('update');
    return this._dxSumOut(s);
  },
  // Batalkan sesi keluar: soket yang sedang melayani diputus, penerima diberi tahu.
  async directCancelOut(id) {
    const s = this._dxOut.get(String(id));
    if (!s) return false;
    const p = this.peers.get(s.to);
    if (s.state === 'offered' || s.state === 'active') this._dxEnd(s, 'cancelled');
    this._dxDropOut(s.id);
    if (p && this.isOnline(p)) this._request(p, { t: 'dx_cancel', id: s.id, why: 'cancelled' }, 3000);
    this.emit('update');
    return true;
  },
  // Akhiri sesi (selesai/ditolak/dibatalkan): putus soket, simpan, tetap tampil di daftar sebentar.
  _dxEnd(s, state) {
    s.state = state; s.end = Date.now();
    this._dxRmTmp(s); // salinan sementara tidak diperlukan lagi
    for (const [sock, u] of this._dxUp) if (u.id === s.id) sock.destroy();
    this._dxSaveOut(s, false); this.emit('update');
    this._dxPulse(true); // denyut akhir: UI pengirim pasti melihat angka terakhir/status akhir, juga untuk transfer yang selesai < 400 ms
  },
  _dxSumOut(s) {
    let live = 0;
    for (const [sock, u] of this._dxUp) if (u.id === s.id) live += sock.bytesWritten;
    return { id: s.id, to: s.to, toName: s.toName, name: s.name, kind: s.kind, state: s.state, count: s.count, total: s.total, sent: Math.min(s.total, s.sent + live), ts: s.ts, skipped: s.skipped || 0 };
  },

  // ---- Penanganan pesan dari penerima (dipanggil _handle; balasan satu baris JSON) ----
  // dx_list: halaman daftar berkas. Dipanggil penerima setelah menerima tawaran (itulah yang menandai sesi aktif).
  _dxList(o, ip, rid) {
    const no = (err) => ({ t: 'dx_list', ok: false, err });
    if (!this._directOk(ip)) return no('lan');
    const s = HEX32.test(String(o.id)) ? this._dxOut.get(o.id) : null;
    if (!s || (s.state !== 'offered' && s.state !== 'active')) return no('gone');
    if (!rid || rid !== s.to || this.isBlocked(rid)) return no('denied');
    const from = Number.isSafeInteger(o.from) && o.from >= 0 ? o.from : 0;
    const files = [];
    let bytes = 0, i = from;
    for (; i < s.files.length && files.length < DX_PAGE && bytes < 500000; i++) {
      const f = s.files[i], e = { p: f.p, s: f.s, m: f.m };
      if (f.d) e.d = 1;
      files.push(e); bytes += f.p.length + 40;
    }
    if (s.state === 'offered') { s.state = 'active'; this._dxSaveOut(s, false); this.emit('update'); }
    return { t: 'dx_list', ok: true, from, files, next: i < s.files.length ? i : null, total: s.files.length };
  },
  // dx_done / dx_cancel dari penerima: tandai sesi selesai, atau ditolak/dibatalkan.
  _dxCtl(o, rid) {
    const s = HEX32.test(String(o.id)) ? this._dxOut.get(o.id) : null;
    if (!s || !rid || rid !== s.to) return { t: 'ack', ok: false };
    if (o.t === 'dx_done') { s.sent = s.total; this._dxEnd(s, 'done'); }
    else this._dxEnd(s, o.why === 'declined' ? 'declined' : 'cancelled');
    return { t: 'ack', ok: true };
  },

  // dx_get: layani byte satu berkas dari posisi `off`. Dipanggil _onConn (koneksi diserahkan ke sini, seperti file_get).
  _dxServe(sock, o, ip) {
    ip = String(ip).replace('::ffff:', '');
    const no = (err) => Direct.refuse(sock, err);
    if (this.stopped) return sock.destroy();
    if (!this._directOk(ip)) return no('lan');
    if (!HEX32.test(String(o.id)) || !Number.isSafeInteger(o.i) || o.i < 0 || !Number.isSafeInteger(o.off) || o.off < 0) return no('bad');
    if (o.hi) this.noteHello(o.hi, ip);
    const rid = o.hi && HEX16.test(String(o.hi.id)) ? o.hi.id : null;
    const s = this._dxOut.get(o.id);
    if (!s || (s.state !== 'offered' && s.state !== 'active')) return no('gone');
    if (!rid || rid !== s.to || this.isBlocked(rid)) return no('denied');
    const f = s.files[o.i];
    if (!f || f.d) return no('bad');
    if (o.off > f.s) return no('range');
    let same = 0; for (const u of this._dxUp.values()) if (u.ip === ip) same++;
    if (this._dxUp.size >= DX_UP_MAX || same >= DX_UP_IP) return no('busy');
    const u = { id: s.id, ip }; this._dxUp.set(sock, u); // didaftarkan sebelum await: batas koneksi tetap berlaku untuk permintaan yang berpacu
    sock.once('close', () => {
      this._dxUp.delete(sock);
      s.sent += sock.bytesWritten; // byte yang benar-benar ditulis ke soket (perkiraan terkirim)
      if (s.sent > s.total) s.sent = s.total;
    });
    sock.setNoDelay(false);
    this._dxPulseOn();
    fs.promises.stat(f.a).then((st) => {
      // berkas asli bisa diubah/dipindah pengguna setelah ditawarkan: ukuran dan mtime harus sama dengan saat dipindai
      if (!st.isFile() || st.size !== f.s || Math.floor(st.mtimeMs) !== f.m) return no('changed');
      if (s.state === 'offered') { s.state = 'active'; this._dxSaveOut(s, false); }
      return Direct.serve(sock, f.a, o.off, f.s - o.off);
    }).catch(() => no('changed'));
  },
};
