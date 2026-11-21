'use strict';
// src/core/archne-index.js — class Core (constructor, start, _listen, stop) + perakitan mixin + ekspor. Method lain ada di berkas domain di folder ini.
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');
const { CALL_CAM_MAX, DEFAULT_TCP_PORT, DEL, DISCOVERY_PORT, MAX_TEXT, canon } = require('./archne-constants');
const { buildSpamNorm, idFromPub, msgId, parseAddr, verifyMsg } = require('./archne-util');
const Rx = require('../archne-reactions');
const I18N = require('./archne-i18n-node');

class Core extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = Object.assign({ discoveryPort: DISCOVERY_PORT, name: 'Anon', log: () => {} }, opts);
    this.log = this.opts.log;
    this.timers = [];
    this.peers = new Map();
    this.store = { msgs: {}, status: {}, gstatus: {}, groups: {}, peers: {}, notes: [], hidden: {}, left: {}, deleted: {}, custody: {}, esc: {}, seeds: {}, revokes: {}, freceipts: {}, receipts: {}, rx: {}, files: {}, got: {}, profiles: {}, friends: {}, blocked: {}, notif: {}, calls: [], hlc: 0, name: null, pvm: {}, react: {}, reactHold: [], reactRecent: [] };
    this._settings = {}; // pengaturan kuota pengguna (settings.json, Step 2e); kosong = bawaan
    I18N.bind(() => this._settings.lang || 'en'); // i18n (E3): bahasa galat/teks Core dibaca saat dipanggil dari settings.json; satu pintu untuk ipc, rpc, headless (Core terakhir yang dibuat menang; di aplikasi hanya ada satu)
    this._pqReset(); // penghitung pesan publik orang lain (Step 2d)
    this._cqReset(); this.store.custody = this._custWrap(this.store.custody); // penghitung byte titipan (Step 2c); juga untuk Core yang tidak di-start (tes)
    this.pv = {}; this._pvRef = {}; // v0.20.0: channel voice publik (turunan store.pvm)
    this.hlc = 0;
    this._pk = new Map(); this._plain = new Map(); this._fl = new Set();
    this._sy = new Map(); // peerId -> { next, busy }: jadwal sync berkala
    this._up = new Map(); // soket unggahan berkas -> ip
    this._dl = new Map(); // id tawaran -> promise unduhan yang sedang jalan
    this._rx = new Map(); // id tawaran -> { p, ac }: penerimaan penuh (unduh + unpack + simpan) yang sedang jalan
    this._prog = {};      // id tawaran -> { phase, done, total, code?, err? }: keadaan terakhir penerimaan, untuk getState()
    this._escNonce = new Map(); // nonce sekali pakai untuk file_put -> { id, exp }
    this._putIn = new Map();    // soket file_put yang sedang masuk -> { ip, id }
    this._pushBack = new Map(); // id:peerId -> { n, next }: jeda sebelum mencoba mendorong lagi (hanya di memori)
    this._pushes = new Map();   // id + ':' + peerId -> { p, ac }: dorongan ke kurir yang sedang jalan (pengirim)
    this._on = new Map(); // peerId -> online di tick sebelumnya (untuk mendeteksi peer yang baru offline)
    this._bad = new Map(); // id tawaran publik -> Set(peerId) pemegang yang pernah memberi data salah (hanya di memori)
    this._holders = new Map(); // id tawaran (untukku) -> Map(peerId -> waktu): kurir yang mengumumkan memegang byte berkasnya (hanya di memori)
    this._escW = new Map(); // id titipan berkas -> promise tulisan yang sedang jalan (pembuangan menunggunya)
    this._clean = Promise.resolve(); // antrean pembersihan berkas (3b): berjalan satu per satu, setelah penerimaan yang dibatalkan benar-benar berhenti
    this._px = new Map(); // peerId -> waktu berikutnya menanyakan alamat peer lain (hanya di memori)
    this._tickN = 0;
    this._pages = null; // PageStore (Halaman, 1c-1): dibuat malas oleh pageStore()
    this._pgSeen = null; // nonce permintaan Halaman yang sudah dipakai (anti putar ulang, 1c-3b): dibuat malas oleh _pgGate()
    this._lvT = new Map(); // gid -> timer: giliran mengeluarkan anggota yang sudah menyatakan keluar (hanya di memori)
    this._dxOut = new Map(); // Kirim Langsung (v0.24.0): id sesi -> sesi keluar (pengirim)
    this._dxIn = new Map();  // id sesi -> sesi masuk (penerima)
    this._dxFl = new Map();  // id sesi masuk -> daftar berkas (cache memori; sumbernya berkas di disk)
    this._dxUp = new Map();  // soket dx_get yang sedang melayani -> { id, ip }
    this._dxRun = new Map(); // id sesi masuk -> { ac, live, base, ... }: unduhan yang sedang jalan
    this._dxTimer = null;
    this._calls = new Map();    // cid -> panggilan yang sedang berjalan (maks satu; hanya di memori)
    this._invIn = new Map();    // room -> undangan masuk yang belum dijawab {room, from, name, members, timer} (hanya di memori)
    this._rjoin = new Set();    // room -> aku bergabung lewat undangan (bukan pembuat): catatannya selalu catatan grup (hanya di memori)
    this._rlog = new Map();     // room -> bahan satu catatan riwayat untuk seluruh ruang (kaki yang sudah selesai ikut menambah; ditulis saat ruang bubar) (hanya di memori)
    this._joins = new Map();    // room -> {room, members, timer}: aku sudah menerima undangan dan sedang menyambung ke anggota ruang (hanya di memori)
    this._expect = new Map();   // room -> Map(id -> timer): orang yang diumumkan anggota ruang akan bergabung, boleh menelepon aku (hanya di memori)
    this._callMy = new Map(); // room -> { muted, deafened, cam? }: status mik/deafen milikku, dikirim ke peserta lain (4c-2)
    this._invOut = new Map();   // 'room:peer' -> timer undangan keluar yang belum dijawab (hanya di memori)
    this._callSeen = new Map(); // id sinyal -> waktu: mencegah pemutaran ulang (hanya di memori)
    this._vcAt = new Map();     // peerId -> { gid, cid, at }: channel voice yang sedang dimasuki tiap anggota (presence; hanya di memori, kedaluwarsa kalau tak diperbarui)
    this._vcMe = null;          // { gid, cid }: channel voice yang sedang kumasuki (hanya di memori). Ruang panggilannya = cid channel.
    this._vcTry = new Map();    // peerId -> { at, n }: percobaan menyambung kaki audio ke anggota channel (pembatas ulang)
    this._vcNext = 0;           // kapan menyiarkan ulang kehadiranku
    this._pvAt = new Map();     // peerId -> { cid, at }: channel voice publik yang sedang dimasuki tiap peer (kehadiran; hanya di memori, kedaluwarsa kalau tak diperbarui)
    this._pvMe = null;          // { cid, pin, lk }: channel voice publik yang sedang kumasuki; pin = PIN yang kuketik (hanya di memori), lk = kunci yang tadi lolos (hanya di memori). Ruang panggilannya = cid channel.
    this._pvNext = 0;           // kapan menyiarkan ulang kehadiranku di channel publik
    this._pvBad = new Map();    // peerId -> { n, at }: PIN salah yang kuterima dari orang itu (pembatas percobaan)
    this._rxPend = new Map();  // Reaksi (v0.24.0): `from+mid` -> { from, rec, at }: reaksi yang sasarannya belum tiba (salinannya di store.reactHold)
    this._rxQ = new Map();     // scope -> antrean ketukan yang menunggu dikirim (batching; hanya di memori)
    this._rxT = null;          // timer batch
    this._rxIn = Rx.limiter(Rx.RX_RATE_RECV); this._rxOut = Rx.limiter(Rx.RX_RATE_SEND); // pembatas laju terima (per pengirim) dan kirim (aku)
    this.stopped = false;
    this._wanInit(); // mode lintas jaringan (v0.23.0): lihat archne-wan.js
  }
  async start() {
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    this._loadIdentity();
    this._loadSettings();
    this._loadStore();
    this._dxLoadOut(); this._dxLoadIn();
    await this._sweep(); // sebelum menerima koneksi: belum ada pengiriman/unduhan yang berjalan, jadi tidak ada berkas yang sedang dipakai
    if (Object.keys(this._settings).length) this._enforceQuotas(); // settings.json yang lebih kecil dari isi simpanan (atau diedit tangan)
    await this._listen();
    this.port = this.server.address().port;
    if (this.opts.discovery !== false) this._startUdp();
    this.timers.push(setInterval(() => this._tick(), this.opts.tickMs || 3000));
    this._tick();
    this._friendRetry();
    for (const g of Object.values(this.store.groups)) this._scheduleReconcile(g); // pernyataan keluar yang belum sempat diproses sebelum aplikasi ditutup
    this.log(`core start id=${this.id} name=${this.name} tcp=${this.port}`);
  }
  // Port tetap dulu (opts.tcpPort bila diberikan, kalau tidak DEFAULT_TCP_PORT); bila sudah dipakai, port acak.
  async _listen() {
    const tries = this.opts.tcpPort ? [this.opts.tcpPort] : [DEFAULT_TCP_PORT, 0];
    let last;
    for (const port of tries) {
      const srv = net.createServer((s) => this._onConn(s));
      try {
        await new Promise((res, rej) => { srv.once('error', rej); srv.listen(port, '0.0.0.0', () => { srv.removeListener('error', rej); res(); }); });
        srv.on('error', (e) => this.log('server error ' + e.message));
        this.server = srv;
        return;
      } catch (e) { last = e; try { srv.close(); } catch {} }
    }
    throw last;
  }
  async stop() {
    try { this.vcLeave(); } catch {}
    try { this._rxFlush(); } catch {} // ketukan reaksi yang masih menunggu batch tidak ikut hilang
    this.stopped = true;
    this._wanStop();
    for (const c of [...this._calls.values()]) this._callFinish(c, 'ended', 'end');
    for (const r of [...this._joins.keys()]) this._roomEnd(r);
    for (const r of [...this._rlog.keys()]) this._rlogFlush(r);
    for (const iv of this._invIn.values()) clearTimeout(iv.timer);
    this._invIn.clear();
    this.timers.forEach(clearInterval);
    clearTimeout(this._rs);
    for (const t of this._lvT.values()) clearTimeout(t);
    this._lvT.clear();
    for (const r of this._rx.values()) r.ac.abort();
    for (const r of this._pushes.values()) r.ac.abort();
    clearInterval(this._dxTimer); this._dxTimer = null;
    { const runs = [...this._dxRun.values()]; for (const r of runs) { r.stop = r.stop || 'paused'; r.ac.abort(); } await Promise.all(runs.map((r) => r.p)); }
    for (const s of this._dxUp.keys()) s.destroy();
    await this.flushCleanup();
    for (const s of this._up.keys()) s.destroy();
    for (const s of this._putIn.keys()) s.destroy();
    try { this.udp && this.udp.close(); } catch {}
    await new Promise((r) => { try { this.server.close(() => r()); } catch { r(); } setTimeout(r, 200); });
    this._saveNow();
  }
}

Object.assign(Core.prototype,
  require('./archne-identity-store'),
  require('./archne-net'),
  require('./archne-protocol'),
  require('./archne-courier'),
  require('./archne-custody-store'),
  require('./archne-pubmsg-store'),
  require('./archne-settings'),
  require('./archne-wan'),
  require('./archne-relay-policy'),
  require('./archne-escrow-store'),
  require('./archne-escrow-push'),
  require('./archne-messages'),
  require('./archne-file-send'),
  require('./archne-file-receive'),
  require('./archne-media'),
  require('./archne-direct-send'),
  require('./archne-direct-recv'),
  require('./archne-group-invite'),
  require('./archne-group-admin'),
  require('./archne-voice-group'),
  require('./archne-voice-public'),
  require('./archne-pin-sync'),
  require('./archne-reactions'),
  require('./archne-profile-social'),
  require('./archne-pages'),
  require('./archne-pages-rx'),
  require('./archne-pages-cmt'),
  require('./archne-pages-cq'),
  require('./archne-pages-cd'),
  require('./archne-pages-new'),
  require('./archne-call-core'),
  require('./archne-call-room'),
  require('./archne-notify-state')
);

module.exports = { CALL_CAM_MAX, DEL, MAX_TEXT, Core, verifyMsg, canon, msgId, idFromPub, DISCOVERY_PORT, DEFAULT_TCP_PORT, parseAddr, buildSpamNorm };
