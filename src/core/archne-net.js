'use strict';
// src/core/archne-net.js — peer, UDP, _tick, sync berkala, alamat
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const dgram = require('dgram');
const net = require('net');
const { DEFAULT_TCP_PORT, HEX16, ONLINE_MS, PX_MAX, PX_MS, PX_PROBE, SYNC_MS, SYNC_RETRY_MS } = require('./archne-constants');
const { broadcastAddrs, localAddrs, parseAddr, privateIp, verifyHelloKeys, vpnish } = require('./archne-util');
const Transport = require('../archne-transport');

const CAPS = ['rx', 'pg', 'pgm', 'pgr', 'pgc', 'pgd', 'pgt', 'pgk']; // PERHATIAN: capsOf memotong sampai 8 entri dan daftar ini sudah penuh (tambah kemampuan lagi = naikkan batas itu dulu). 'pg' = melayani Halaman (pg_list / pg_get); 'pgm' = juga melayani potongan gambar (pg_media, 2d-2); 'pgr' = juga menerima reaksi (pg_rx, 4a-3); 'pgc' = juga melayani komentar (pg_cmt / pg_cml, 4b-2); 'pgd' = juga menerima permintaan hapus komentar oleh penulisnya (pg_cmd, 5e); 'pgt' = juga menerima balasan komentar (pg_cmt dengan c.re, 5f); 'pgk' = juga menerima reaksi pada komentar (pg_rc) dan menyertakan reaksi komentar di jawaban pg_cml (5g)
const capsOf = (c) => (Array.isArray(c) ? c.filter((x) => typeof x === 'string' && /^[a-z0-9]{1,8}$/.test(x)).slice(0, 8) : []);

module.exports = {
  hello() { return { id: this.id, name: this.name, port: this.port, pub: this.pub, xpub: this.xpub, xsig: this.xsig, caps: CAPS }; }, // caps: kemampuan protokol ('rx' = reaksi); peer lama tidak mengirimnya
  isOnline(p) { return !!p && Date.now() - p.lastSeen < ONLINE_MS; },
  noteHello(h, ip) {
    if (!h || !HEX16.test(String(h.id)) || h.id === this.id || !Number.isInteger(h.port)) return;
    if (Transport.isRtcAddr(String(ip)) && String(ip) !== Transport.rtcAddr(h.id)) return; // lewat transport lintas jaringan, hello hanya sah untuk ID yang terotentikasi transport
    const prev = this.peers.get(h.id);
    const kv = verifyHelloKeys(h, prev);
    if (!kv.ok) return;
    if (!kv.keys && prev && prev.xpub) return; // tolak downgrade ke hello tanpa kunci
    ip = String(ip).replace('::ffff:', '');
    const was = this.isOnline(prev);
    // Jalur LAN didahulukan: selagi peer masih online lewat alamat LAN, kabar dari jalur rtc: tidak menimpa alamatnya (dan tidak memperpanjang
    // statusnya). Bila LAN mati, peer jadi offline lalu dipulihkan lewat rtc (lihat _tick dan rtcLinkUp).
    if (was && Transport.isRtcAddr(ip) && prev.ip && !Transport.isRtcAddr(prev.ip)) return;
    const p = Object.assign({ id: h.id, name: String(h.name || '?').slice(0, 32), ip, port: h.port, lastSeen: Date.now(), caps: capsOf(h.caps) }, kv.keys || {});
    this.peers.set(h.id, p);
    if (!was) {
      this.log(`peer online ${p.name}#${p.id.slice(0, 6)} ${ip}:${p.port}`);
      this.emit('update');
      setImmediate(() => this._onPeerOnline(p));
      this._save();
    } else if (prev.name !== p.name || prev.xpub !== p.xpub) { this.emit('update'); }
  },
  async addPeer(ip, port) {
    const a = parseAddr(port === undefined || port === null || port === '' ? ip : `${ip}:${port}`);
    if (!a) return false;
    const r = await this._request(a, { t: 'hello' }, 3000);
    this.log(`addPeer ${a.ip}:${a.port} -> ${r ? 'ok' : 'gagal'}`);
    return !!r;
  },
  // Tambah satu atau banyak alamat sekaligus (dipisah spasi, koma, titik koma, atau baris baru), mis. hasil salin "Alamatku" dari temanmu.
  // Port boleh kosong. Hasil: { added: [alamat yang tersambung], fail: [alamat yang tidak menjawab], bad: [teks yang bukan alamat] }.
  async addPeers(text) {
    const toks = [...new Set(String(text == null ? '' : text).split(/[\s,;]+/).filter(Boolean))].slice(0, 10);
    const res = { added: [], fail: [], bad: [] };
    await Promise.all(toks.map(async (t) => {
      const a = parseAddr(t);
      if (!a) { res.bad.push(t); return; }
      const label = `${a.ip}:${a.port}`;
      const r = await this._request(a, { t: 'hello' }, 3000);
      this.log(`addPeers ${label} -> ${r ? 'ok' : 'gagal'}`);
      (r ? res.added : res.fail).push(label);
    }));
    return res;
  },
  // Alamat yang bisa dibagikan ke teman: VPN dulu (Tailscale/Hamachi/Radmin), lalu jaringan lokal.
  myAddrs() {
    const rank = (ip) => (vpnish(ip) ? 0 : privateIp(ip) ? 1 : 2);
    return localAddrs().sort((a, b) => rank(a.ip) - rank(b.ip)).map((a) => ({ ip: a.ip, name: a.name, vpn: vpnish(a.ip), addr: a.ip + (this.port === DEFAULT_TCP_PORT ? '' : ':' + this.port) }));
  },
  // Pertukaran alamat peer: cukup tersambung ke satu orang, sisanya ditemukan lewat dia (siaran UDP tidak menembus VPN).
  // Alamat dari peer hanyalah PETUNJUK: yang menentukan tetap hello yang kunci identitasnya diverifikasi (noteHello), dan hanya
  // alamat jaringan pribadi/VPN yang dicoba supaya peer tidak bisa menyuruh kita menyentuh alamat internet sembarang.
  _peerHints(excludeId) {
    return [...this.peers.values()].filter((p) => p.id !== excludeId && this.isOnline(p) && !this.isBlocked(p.id) && net.isIPv4(p.ip) && p.port)
      .slice(0, PX_MAX).map((p) => ({ id: p.id, ip: p.ip, port: p.port }));
  },
  _hintOk(ip, port) {
    if (this.opts.hintOk) return !!this.opts.hintOk(ip, port); // hook tes (alamat loopback)
    if (!net.isIPv4(ip) || !Number.isInteger(port) || port < 1024 || port > 65535) return false;
    const mine = localAddrs();
    if (mine.some((a) => a.ip === ip)) return false;
    if (privateIp(ip) || vpnish(ip)) return true;
    return mine.some((a) => { const mk = a.mask.split('.').map(Number), x = ip.split('.').map(Number), y = a.ip.split('.').map(Number); return x.every((o, i) => (o & mk[i]) === (y[i] & mk[i])); });
  },
  async _askPeers(p) {
    const r = await this._request(p, { t: 'peers' }, 3000);
    if (!r || r.t !== 'peers' || !Array.isArray(r.list)) return 0;
    let n = 0;
    for (const h of r.list.slice(0, PX_MAX)) {
      if (!h || !HEX16.test(String(h.id)) || h.id === this.id || this.isBlocked(h.id)) continue;
      const known = this.peers.get(h.id);
      if (known && this.isOnline(known)) continue;
      if (!this._hintOk(h.ip, h.port)) continue;
      if (++n > PX_PROBE) break;
      this._request({ ip: h.ip, port: h.port }, { t: 'hello' }, 2000);
    }
    return n;
  },
  async _onPeerOnline(p) {
    this._sy.delete(p.id); // jadwal berkala dimulai ulang setelah sync awal ini
    this._px.set(p.id, Date.now() + PX_MS);
    this._askPeers(p).catch(() => {});
    this._vcGreet(p);
    this._pvGreet(p);
    await this._flushOutbox(p);
    await this._syncFrom(p);
  },
  _startUdp() {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = s;
    s.on('error', (e) => this.log('udp error ' + e.message));
    s.on('message', (buf, rinfo) => {
      try {
        const o = JSON.parse(buf.toString());
        if (o.t === 'hello' && o.app === 'archne') this.noteHello(o, rinfo.address);
      } catch {}
    });
    s.bind(this.opts.discoveryPort, () => { try { s.setBroadcast(true); } catch {} });
  },
  _tick() {
    if (this.stopped) return;
    if (this.udp) {
      const b = Buffer.from(JSON.stringify(Object.assign({ t: 'hello', app: 'archne' }, this.hello())));
      for (const a of this.opts.broadcast || broadcastAddrs()) {
        try { this.udp.send(b, this.opts.discoveryPort, a, () => {}); } catch {}
      }
    }
    this._tickN++;
    this._friendRetry();
    this._vcTick();
    this._pvTick();
    this._rxGc();
    this._pcqGc();
    this._pgnPrune();
    let wentOff = false;
    for (const p of this.peers.values()) {
      const on = this.isOnline(p);
      if (this._on.get(p.id) && !on) { wentOff = true; this._vcDrop(p.id); this._pvDrop(p.id); }
      this._on.set(p.id, on);
    }
    // Ada peer yang baru offline: jangan menunggu jadwal berkala, tanyakan kabar kurir/pemegang berkas ke peer lain sekarang juga.
    if (wentOff) for (const s of this._sy.values()) s.next = 0;
    for (const p of this.peers.values()) {
      if (this.isOnline(p) && !this.isBlocked(p.id)) {
        this._flushOutbox(p); this._periodicSync(p); this._pushTick(p); this._pcqTick(p); this._pgnTick(p);
        if (Date.now() >= (this._px.get(p.id) || 0)) { this._px.set(p.id, Date.now() + PX_MS); this._askPeers(p).catch(() => {}); }
      }
      else if (this.isOnline(p)) this._flushOutbox(p); // diblokir: hanya pemutusan pertemanan yang masih tertahan (lihat blockUser)
      else if (p.ip && p.port) {
        // peer yang kukenal lewat LAN tetapi sedang offline, padahal ada link lintas jaringan terbuka: coba lewat sana
        if (this._rtc && typeof this._rtc.reachable === 'function' && !Transport.isRtcAddr(p.ip) && this._rtc.reachable(p.id)) this._request({ ip: Transport.rtcAddr(p.id), port: p.port }, { t: 'hello' }, 2000);
        this._request(p, { t: 'hello' }, 2000);
        // dia mungkin dibuka ulang dan kini memakai port tetap (port lamanya basi): coba juga port tetap, tiap ~15 detik
        if (p.port !== DEFAULT_TCP_PORT && this._tickN % 5 === 0) this._request({ ip: p.ip, port: DEFAULT_TCP_PORT }, { t: 'hello' }, 2000);
      }
    }
    this._gc();
    this.emit('tick');
  },
  // Sinkronisasi berkala: menarik pesan/titipan/tanda terima yang terlewat tanpa menunggu peer "baru online".
  // Satu sync per peer pada satu waktu; jadwal diacak; kalau gagal dicoba lagi lebih cepat.
  _periodicSync(p) {
    const every = this.opts.syncMs || SYNC_MS;
    let s = this._sy.get(p.id);
    if (!s) { s = { next: Date.now() + this._jitter(every), busy: false }; this._sy.set(p.id, s); return; } // sync awal sudah dikerjakan _onPeerOnline
    if (s.busy || Date.now() < s.next) return;
    s.busy = true;
    this._syncFrom(p).then((okSync) => {
      s.next = Date.now() + (okSync ? this._jitter(every) : Math.min(SYNC_RETRY_MS, every));
    }).catch(() => { s.next = Date.now() + SYNC_RETRY_MS; }).finally(() => { s.busy = false; });
  },
  _jitter(ms) { return Math.round(ms * (0.8 + Math.random() * 0.4)); },
};
