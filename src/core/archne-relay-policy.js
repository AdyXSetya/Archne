'use strict';
// src/core/archne-relay-policy.js — hemat kuota relay TURN (Cloudflare/Metered), v0.23.1.
// Relay hanya dipakai bila dua perangkat tidak bisa terhubung langsung, dan ongkos terbesarnya adalah BYTE BERKAS yang dititipkan ke kurir
// (satu berkas bisa lewat relay ±3 kali: dua dorongan + satu unduhan). Teks, pesan primer (`ginv`, kontrol `pc`) dan tawaran berkas tetap lewat
// jalur mana pun karena ukurannya sangat kecil. Aturannya:
//   1. Berkas hanya dititipkan ke kurir yang jalurnya LANGSUNG (LAN/TCP, atau DataChannel yang terpilih `direct`). Jalur relay atau yang belum pasti dilewati.
//   2. Batas ukuran ANTAR JARINGAN (Pengaturan `escMax`, bawaan 10 MB, maksimal 100 MB, tidak ada opsi tanpa batas; 0 = mati). Jaringan lokal (LAN/TCP) TANPA batas
//      ukuran ini (hanya batas berkas 100 MB dan kuota kolam). Berkas lewat koneksi antar jaringan (alamat `rtc:`) dititipkan hanya bila ukurannya (setelah kompres) <= batas.
//   3. Berkas di atas batas tidak dititipkan: penerima mengambilnya langsung dari pengirim saat dia online (tawarannya tetap sampai lewat kurir).
//      Pengambilan langsung pengirim -> penerima yang jalurnya terpilih RELAY juga dibatasi batas yang sama (ditolak `relaycap`); jalur langsung dan LAN tidak.
//   4. Salinan seed (peer yang sudah mengunduh berkas publik/grup) tidak dilayankan lewat jalur relay.
// Jalur tiap link dicatat dari jembatan DataChannel (archne-ipc.js -> rtcLinkPath); peer LAN tidak punya catatan karena memang tidak lewat relay.
const Transport = require('../archne-transport');
const { ESC_MAX_CEIL, ESC_MAX_DEF } = require('./archne-constants');

module.exports = {
  // Dari jembatan UI (src/archne-ipc.js): jalur terpilih link ke peer 'direct' | 'relay' | tidak diketahui. path null = link putus (catatan dibuang).
  rtcLinkPath(id, path) {
    if (!this._rtcPath) this._rtcPath = new Map();
    id = String(id);
    if (path === null || path === undefined) return this._rtcPath.delete(id);
    this._rtcPath.set(id, path === 'direct' || path === 'relay' ? path : 'unknown');
    return true;
  },
  // true bila rute ke alamat/peer itu lewat relay, atau belum bisa dipastikan langsung (konservatif: 'unknown' dihitung relay).
  // addr: string alamat ("1.2.3.4" atau "rtc:<id>") atau objek peer ({ ip }). Alamat TCP/LAN selalu langsung.
  _viaRelay(addr) {
    const id = Transport.rtcId(typeof addr === 'string' ? addr : addr && addr.ip);
    if (!id) return false;
    return !this._rtcPath || this._rtcPath.get(id) !== 'direct';
  },
  // Batas titipan berkas (byte) yang berlaku: nilai Pengaturan (opts.escMaxBytes) dijepit ke batas atas, kalau tidak ada = bawaan.
  _escMaxBytes() {
    const v = this.opts.escMaxBytes;
    return Number.isSafeInteger(v) && v >= 0 ? Math.min(v, ESC_MAX_CEIL) : ESC_MAX_DEF;
  },
  // true bila alamat itu koneksi ANTAR JARINGAN (rtc:<id>); alamat TCP/LAN = false.
  _isWan(addr) {
    return !!Transport.rtcId(typeof addr === 'string' ? addr : addr && addr.ip);
  },
  // Boleh dititipkan menurut ukuran? psize = ukuran setelah kompres (yang benar-benar dikirim).
  // addr (opsional): peer tujuan. LAN = tanpa batas ukuran; antar jaringan atau addr tidak diketahui = ikut batas Pengaturan (konservatif).
  _escSizeOk(psize, addr) {
    if (!Number.isFinite(psize) || psize < 0) return false;
    if (addr && !this._isWan(addr)) return true;
    const max = this._escMaxBytes();
    return max > 0 && psize <= max;
  },
  // Pengambilan langsung (pengirim -> penerima) lewat jalur yang TERPILIH relay (bukan 'unknown') dibatasi batas antar jaringan. 0 = tidak ada berkas lewat relay.
  _relayServeOk(addr, psize) {
    const id = Transport.rtcId(typeof addr === 'string' ? addr : addr && addr.ip);
    if (!id || !this._rtcPath || this._rtcPath.get(id) !== 'relay') return true;
    return this._escSizeOk(psize, 'rtc:' + id);
  },
};
