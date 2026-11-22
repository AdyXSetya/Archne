'use strict';
// src/core/archne-wan.js — mode lintas jaringan (double NAT): transport rtc:<id>, kode jaringan, signaling terenkripsi, ICE/TURN, undangan.
// Dipindah dari archne-core.js monolit v0.22.0 ke mixin (v0.23.0); perilaku sama. Rancangan: docs/PLAN_mode_lintas_jaringan.md.
// Kode jaringan dan kredensial TURN hanya ada di Core (store.wan / store.turn); UI hanya menerima netId, topik, dan bungkus opak.
const net = require('net');
const Transport = require('../archne-transport');
const WanCrypto = require('../archne-wancrypto');
const Turn = require('../archne-turn');
const Invite = require('../archne-invite');
const I18N = require('./archne-i18n-node');
const { ek } = require('./archne-ecode');

module.exports = {
  // Dipanggil constructor (archne-index.js): turunan kode (netId/netKey, hanya di memori), iv signaling yang sudah terlihat, transport, konfigurasi ICE.
  _wanInit() {
    this._wan = null; this._wanSeen = new Map();
    this._rtc = null; // transport peer rtc:<id> (attachTransport); null = hanya TCP/LAN
    this._turn = Turn.createTurn(this.opts.turn || {}); // konfigurasi ICE lintas jaringan; kredensial hanya di Core
  },
  _wanLoad() { // dari _loadStore: konfigurasi TURN tersimpan rusak dibuang
    if (this.store.turn) { try { this._turn.set(this.store.turn); this._turn.ice().catch(() => {}); } catch { delete this.store.turn; } } // pemanasan: kredensial sudah siap saat panggilan pertama
  },
  _wanStop() { // dari stop()
    try { if (this._rtc) { if (typeof this._rtc.close === 'function') this._rtc.close(); this._rtc.onIncoming = null; } } catch {}
    this._rtc = null;
  },

  // Buka koneksi ke peer: TCP untuk ip:port, atau lewat transport terpasang untuk alamat "rtc:<id>". Null bila tidak ada rute.
  // Dipakai _request dan Xfer (unduh/unggah berkas), jadi semua protokol memakai jalur yang sama.
  _dial(peer) {
    if (!peer) return null;
    if (Transport.isRtcAddr(peer.ip)) return this._rtc && Transport.validRtcAddr(peer.ip) ? this._rtc.connect(peer) : null;
    return net.connect({ host: peer.ip, port: peer.port });
  },

  // ---- langkah 2: kode jaringan, presence dan signaling terenkripsi (src/archne-wancrypto.js) ----
  // Kode disimpan di store.wan.code (hanya di perangkat ini); UI tidak pernah menerima kode atau kunci, hanya netId dan topik.
  wanNewCode() { return WanCrypto.newCode(); },
  _wanCtx() {
    const code = this.store.wan && this.store.wan.code;
    if (!code) return null;
    if (!this._wan || this._wan.code !== code) { try { this._wan = WanCrypto.derive(code); } catch { this._wan = null; } }
    return this._wan;
  },
  wanSetCode(code) {
    const w = WanCrypto.derive(code); // melempar bila bentuknya tidak sah
    this.store.wan = { code: w.code };
    this._wan = w; this._wanSeen.clear();
    this._save(); this.emit('update');
    return w.netId;
  },
  wanClear() { delete this.store.wan; if (this.store.wanCfg) delete this.store.wanCfg.enabled; this._wan = null; this._wanSeen.clear(); this._save(); this.emit('update'); return true; },
  wanInfo() { const w = this._wanCtx(); return w ? { enabled: true, netId: w.netId } : { enabled: false }; },

  // ---- langkah 5: ICE (STUN/TURN) ----
  // Kredensial TURN hanya disimpan di perangkat ini (store.turn) dan tidak pernah dikirim ke UI; UI menerima turnInfo (tanpa rahasia) dan iceServers jadi.
  turnInfo() { return this._turn.info(); },
  turnSet(cfg) { const info = this._turn.set(cfg); const n = this._turn.get(); if (n.provider === 'none') delete this.store.turn; else this.store.turn = n; this._save(); this.emit('update'); return info; },
  turnClear() { this._turn.set({ provider: 'none' }); delete this.store.turn; this._save(); this.emit('update'); return true; },
  // iceServers untuk RTCPeerConnection. peerId diberikan (panggilan): peer yang dijangkau lewat LAN -> [] seperti sebelumnya; peer lintas jaringan
  // (alamat rtc:) -> STUN + TURN dari Pengaturan. Tanpa peerId (DataChannel antar-Core) selalu konfigurasi lintas jaringan.
  async turnIce(peerId) {
    if (peerId !== undefined && peerId !== null) {
      const p = this.peers.get(peerId);
      if (!p || !Transport.isRtcAddr(p.ip)) return { iceServers: [], wan: false };
    }
    const r = await this._turn.ice();
    return { iceServers: r.iceServers, wan: true, provider: r.provider, err: r.err || '' };
  },

  // ---- langkah 6: pengaturan dan undangan ----
  // store.wanCfg = { enabled, broker }; kode di store.wan.code. UI menyalakan atau mematikan tumpukan MQTT/WebRTC mengikuti wanSettings().
  wanSettings() {
    const w = this._wanCtx(), c = this.store.wanCfg || {};
    return { enabled: !!(w && c.enabled), hasCode: !!w, netId: w ? w.netId : null, broker: c.broker || Invite.DEFAULT_BROKER, defaultBroker: Invite.DEFAULT_BROKER, turn: this._turn.info() };
  },
  _wanCfgSet(patch) { this.store.wanCfg = Object.assign({}, this.store.wanCfg, patch); this._save(); this.emit('update'); },
  // Saklar. Menyalakan tanpa kode: buat kode acak baru (jaringan baru milik pengguna ini).
  wanEnable(on) {
    if (on && !this._wanCtx()) this.wanSetCode(this.wanNewCode());
    this._wanCfgSet({ enabled: !!on });
    return this.wanSettings();
  },
  wanSetBroker(url) {
    const u = typeof url === 'string' ? url.trim() : '';
    if (u && !Invite.validBroker(u)) throw ek('e.wan.badBroker', null, 'Alamat broker harus berawalan wss:// (ws:// hanya untuk localhost)');
    this._wanCfgSet({ broker: u && u !== Invite.DEFAULT_BROKER ? u : undefined });
    return this.wanSettings();
  },
  // Ganti kode: pintu lama tertutup; peserta lama harus memasukkan undangan baru. Pengaturan lain tetap.
  wanRotate() { this.wanSetCode(this.wanNewCode()); this._wanCfgSet({}); return this.wanSettings(); },
  // withTurn: sertakan kredensial TURN milik pemilik (keputusan pemilik; UI menampilkan peringatan). Hasil: { link, text, withTurn }.
  inviteMake(withTurn) {
    const w = this._wanCtx();
    if (!w) throw ek('e.wan.notSet', null, 'Mode lintas jaringan belum diatur');
    const t = withTurn ? this._turn.get() : null, inc = !!(t && t.provider !== 'none');
    const link = Invite.make({ code: w.code, broker: (this.store.wanCfg && this.store.wanCfg.broker) || Invite.DEFAULT_BROKER, turn: inc ? t : null });
    return { link, withTurn: inc, text: I18N.tr('wan.shareText', null, 'Gabung ke jaringan Archne-ku (ketuk Tambah, atau tempel di menu Lintas jaringan):') + '\n' + link };
  },
  // Mengintip undangan tanpa menerapkannya (kartu undangan di chat dan daftar di dialog Lintas jaringan). Kode tidak ikut keluar: hanya netId, broker, ada-tidaknya TURN.
  invitePeek(text) {
    const inv = Invite.parse(text), w = this._wanCtx(), c = this.store.wanCfg || {};
    return { netId: inv.netId, broker: inv.broker, hasTurn: !!inv.turn, current: !!(w && w.netId === inv.netId), enabled: !!(w && c.enabled) };
  },
  // Semua divalidasi dulu; baru diterapkan. Mengaktifkan mode. Undangan dengan TURN menggantikan TURN yang ada; tanpa TURN membiarkannya.
  inviteApply(text) {
    const inv = Invite.parse(text);
    this.wanSetCode(inv.code);
    if (inv.turn) this.turnSet(inv.turn);
    this._wanCfgSet({ enabled: true, broker: inv.broker !== Invite.DEFAULT_BROKER ? inv.broker : undefined });
    return this.wanSettings();
  },
  wanTopics() { const w = this._wanCtx(); return w ? WanCrypto.topicsFor(w.netId, this.id) : null; },
  _wanMe() { return { id: this.id, pub: this.pub, privKey: this.privKey, pairKey: (id) => this._pairKey(id) }; },
  // kind: 'presence' (to diabaikan) | 'signal' (to = id penerima). Hasil: { topic, payload } untuk di-publish UI apa adanya.
  wanSeal(kind, to, body) {
    const w = this._wanCtx();
    if (!w) throw ek('e.wan.notSet', null, 'Mode lintas jaringan belum diatur');
    return WanCrypto.seal(this._wanMe(), w, { type: kind, to, body, now: Date.now() });
  },
  // Hasil: { type, from, to, ts, body } atau null (dibuang). Peer yang kublokir dibuang di sini juga.
  wanOpen(topic, payload) {
    const w = this._wanCtx();
    if (!w) return null;
    const r = WanCrypto.open(this._wanMe(), w, { topic, payload, now: Date.now(), seen: this._wanSeen });
    if (!r || this.store.blocked[r.from]) return null;
    return { type: r.type, from: r.from, to: r.to, ts: r.ts, body: r.body };
  },

  // Pasang transport untuk peer "rtc:<id>" (lihat src/archne-transport.js untuk kontraknya). Hanya satu; memasang lagi menggantikan yang lama.
  attachTransport(t) {
    if (this._rtc && this._rtc !== t) { try { if (typeof this._rtc.close === 'function') this._rtc.close(); } catch {} this._rtc.onIncoming = null; }
    this._rtc = t || null;
    if (t) t.onIncoming = (sock, remoteId) => {
      if (this.stopped || !Transport.validRtcAddr(Transport.rtcAddr(String(remoteId)))) { try { sock.destroy(); } catch {} return; }
      this._onConn(sock, Transport.rtcAddr(remoteId));
    };
  },

  // Dari jembatan UI (src/archne-rtcbridge.js): link DataChannel ke peer terbuka/putus.
  // Terbuka: sapa lewat link itu supaya peer langsung online (sync, outbox, kurir berjalan lewat _onPeerOnline).
  // Putus: peer yang alamatnya rtc: langsung offline, tidak menunggu ONLINE_MS; peer LAN tidak terpengaruh.
  rtcLinkUp(id) {
    if (this.stopped || !Transport.validRtcAddr(Transport.rtcAddr(String(id))) || id === this.id || this.isBlocked(id)) return Promise.resolve(null);
    return this._request({ ip: Transport.rtcAddr(id), port: 1 }, { t: 'hello' }, 4000);
  },
  rtcLinkDown(id) {
    this.rtcLinkPath(id, null); // catatan jalur link (archne-relay-policy.js) ikut dibuang
    const p = this.peers.get(id);
    if (!p || !Transport.isRtcAddr(p.ip) || !p.lastSeen) return false;
    p.lastSeen = 0; this.emit('update');
    return true;
  },
};
