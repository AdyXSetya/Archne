'use strict';
// src/core/archne-mailbox.js — kotak surat lintas jaringan (langkah 4a): membungkus dan membuka amplop untuk peer yang sedang offline.
// Lapisan kripto + pencatat id (4a) + keputusan menitip dan kuota (4b); belum ada jaringan di sini: publish ke broker dilakukan pemanggil (host/wanhost), ambil = 4c, outbox = 4d. Rancangan amplop: src/archne-mailbox.js.
// Kode jaringan dan kunci hanya di Core: UI/host hanya menerima topik dan bungkus opak, atau isi yang sudah terbuka.
const Mailbox = require('../archne-mailbox');
const { ek } = require('./archne-ecode');

module.exports = {
  // Pencatat id amplop yang sudah diproses: 'from:mid' -> exp. Lazy dari store.mbox.seen (objek biasa di store.json), jadi tahan restart.
  _mboxSeen() {
    if (!this._mbSeen) {
      const m = this.store.mbox && this.store.mbox.seen;
      this._mbSeen = new Map(m && typeof m === 'object' ? Object.entries(m).filter(([, v]) => Number.isSafeInteger(v)) : []);
    }
    return this._mbSeen;
  },
  // Pencatat titipan keluar (4b): { penerima: { mid: exp } }, dari store.mbox.out. Lazy, tahan restart.
  _mboxOut() {
    if (!this._mbOut) {
      const o = this.store.mbox && this.store.mbox.out;
      const out = {};
      if (o && typeof o === 'object') for (const [to, m] of Object.entries(o)) {
        if (!m || typeof m !== 'object') continue;
        for (const [mid, exp] of Object.entries(m)) if (Number.isSafeInteger(exp)) Mailbox.outAdd(out, to, mid, exp);
      }
      this._mbOut = out;
    }
    return this._mbOut;
  },
  _mboxPersist() {
    Mailbox.pruneSeen(this._mboxSeen(), Date.now());
    Mailbox.outPrune(this._mboxOut(), Date.now());
    const cfg = this.store.mbox && this.store.mbox.cfg; // pengaturan (4d) ikut dipertahankan
    this.store.mbox = { seen: Object.fromEntries(this._mboxSeen()), out: this._mboxOut(), q: this._mboxQ() };
    if (cfg) this.store.mbox.cfg = cfg;
    this._save();
  },
  // Filter langganan kotak suratku (untuk 4c) atau null bila mode lintas jaringan belum diatur.
  mailboxFilter() { const w = this._wanCtx(); return w ? Mailbox.inboxFilter(w.netId, this.id) : null; },
  // Tutup amplop untuk `to`. Hasil: { topic, payload, mid, exp } untuk di-publish apa adanya (retained). ttlMs bawaan 7 hari (batas 1 menit..30 hari).
  // Melempar bila mode belum diatur, peer diblokir, kunci pasangan belum ada (peer belum pernah terlihat), atau isi/TTL tidak sah.
  mailboxSeal(to, body, ttlMs) {
    const w = this._wanCtx();
    if (!w) throw ek('e.wan.notSet', null, 'Mode lintas jaringan belum diatur');
    if (!/^[0-9a-f]{16}$/.test(String(to)) || to === this.id) throw new Error('Penerima tidak valid');
    if (this.isBlocked(to)) throw new Error('Penerima diblokir');
    if (!this._pairKey(to)) throw ek('e.file.noKey', null, 'Kunci enkripsi belum tersedia (peer versi lama atau belum terlihat)');
    return Mailbox.seal(this._wanMe(), w, { to, body, ttlMs, now: Date.now() });
  },
  // Buka satu amplop dari topik kotak suratku. Hasil: { ok: true, mid, from, ts, exp, body } atau { ok: false, why, mid? }
  // why: 'bad' | 'notmine' | 'expired' | 'dup' | 'blocked' | 'off'. 'expired' dan 'dup' membawa mid: pemanggil boleh menghapusnya dari broker.
  // Id dicatat (dan disimpan) hanya bila lolos semua pemeriksaan; isi tidak disimpan di sini, itu tugas pemanggil (masuk ke penyimpanan chat).
  mailboxOpen(topic, payload) {
    const w = this._wanCtx();
    if (!w) return { ok: false, why: 'off' };
    const r = Mailbox.open(this._wanMe(), w, { topic, payload, now: Date.now(), seen: this._mboxSeen() });
    if (!r.ok) return r;
    this._mboxPersist();
    if (this.store.blocked[r.from]) return { ok: false, why: 'blocked', mid: r.mid };
    return { ok: true, mid: r.mid, from: r.from, ts: r.ts, exp: r.exp, body: r.body };
  },

  // Terima satu pesan dari langganan kotak suratku (4c-1). Murni: tanpa jaringan dan tanpa menyimpan chat; hanya memutuskan apa yang harus dilakukan pemanggil.
  // Hasil:
  //   { action: 'deliver', topic, mid, from, ts, exp, body }  amplop sah dan baru: pemanggil menyimpannya ke chat (4c-2), lalu boleh menghapusnya dari broker (4c-4)
  //   { action: 'clear', topic, mid, why }                     'expired' | 'dup' | 'blocked': tidak ada yang perlu disimpan, aman dihapus dari broker
  //   { action: 'ignore', why }                                'empty' (payload kosong = kabar penghapusan retained) | 'bad' | 'notmine' | 'off': jangan disentuh, jangan dihapus
  // Catatan: id sudah dicatat sebagai 'seen' begitu amplop terbuka (lihat mailboxOpen), jadi bila penyimpanan chat gagal setelah 'deliver', pesan yang sama akan terbaca 'dup'.
  mailboxReceive(topic, payload) {
    if (payload === null || payload === undefined || payload === '' || (Buffer.isBuffer(payload) && !payload.length)) return { action: 'ignore', why: 'empty' };
    const r = this.mailboxOpen(topic, typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : payload);
    if (r.ok) return { action: 'deliver', topic, mid: r.mid, from: r.from, ts: r.ts, exp: r.exp, body: r.body };
    if (r.why === 'expired' || r.why === 'dup' || r.why === 'blocked') return { action: 'clear', topic, mid: r.mid, why: r.why };
    return { action: 'ignore', why: r.why };
  },

  // Terima dan MASUKKAN satu pesan dari kotak suratku ke penyimpanan chat (4c-2): mailboxReceive + _ingest (jalur yang sama dengan pesan langsung).
  // Isi amplop yang sah adalah { k: 'msg', m } dengan m = pesan bertanda tangan utuh (lihat mailboxDepositMsg). m.from harus sama dengan pengirim amplop dan m.to harus aku.
  // Hasil: { action, topic?, mid?, why?, result? }
  //   'stored'  pesan masuk (result 'new') atau sudah kupunya (result 'dup'): aman dihapus dari broker (4c-4)
  //   'clear'   tidak ada yang perlu disimpan, aman dihapus dari broker: 'expired' | 'dup' | 'blocked' | 'badbody' (isi bukan pesan yang sah) | 'rejected' (_ingest menolak: 'bad')
  //   'retry'   gagal di sisiku ('full' atau galat): JANGAN hapus dari broker; id dilepas dari pencatat supaya pengambilan berikutnya bisa mencoba lagi
  //   'ignore'  jangan disentuh (kosong, rusak, bukan untukku, mode belum diatur)
  mailboxIngest(topic, payload) {
    const r = this.mailboxReceive(topic, payload);
    if (r.action !== 'deliver') return r;
    const b = r.body;
    if (b && b.k === 'rc') return this._mboxIngestRc(r, b); // tanda terima dari penerima yang mengambil titipanku (4d)
    const m = b && b.k === 'msg' && b.m && typeof b.m === 'object' ? b.m : null;
    if (!m || m.from !== r.from || m.to !== this.id) return { action: 'clear', topic, mid: r.mid, why: 'badbody' };
    let res;
    (this._mbFresh || (this._mbFresh = new Set())).add(m.id); // baru tiba dari broker: notifyOf tidak boleh menolaknya karena umur pesan (4e)
    try { res = this._ingest(m, true); } catch { res = 'error'; } finally { this._mbFresh.delete(m.id); }
    if (res === 'new' || res === 'dup') {
      try { if (this._myRcpt(m)) this._mboxEnqRc(r.from, m.id); } catch { /* tanda terima hanya tambahan: jalur sync tetap membawanya */ } // 4d: beri tahu pengirim lewat kotak suratnya
      return { action: 'stored', topic, mid: r.mid, from: r.from, result: res, id: m.id };
    }
    if (res === 'bad') return { action: 'clear', topic, mid: r.mid, why: 'rejected' };
    this._mboxUnsee(r.from, r.mid); // 'full' / galat: biarkan titipan di broker dan izinkan coba lagi
    return { action: 'retry', topic, mid: r.mid, why: res === 'error' ? 'error' : String(res) };
  },
  // Tanda terima lewat kotak surat (4d): rc harus ditandatangani pengirim amplop itu sendiri (rc.by === from). Hasil 'stored' (result 'rcpt' baru, 'dup' sudah kupunya) atau 'clear' 'badbody'.
  // _addRcpt memverifikasi tanda tangan dan, bila pesannya milikku dan masih 'pending', menandainya 'delivered'.
  _mboxIngestRc(r, b) {
    const rc = b.rc, bad = { action: 'clear', topic: r.topic, mid: r.mid, why: 'badbody' };
    if (!rc || typeof rc !== 'object' || rc.by !== r.from) return bad;
    const had = typeof rc.id === 'string' && !!this.store.receipts[rc.id + rc.by];
    let good = had;
    if (!had) { try { good = this._addRcpt(rc) === true; } catch { good = false; } }
    if (!good) return bad;
    return { action: 'stored', topic: r.topic, mid: r.mid, from: r.from, result: had ? 'dup' : 'rcpt', id: rc.id };
  },
  // Lepas satu id dari pencatat 'seen' (hanya untuk mencoba lagi setelah gagal menyimpan).
  _mboxUnsee(from, mid) { if (this._mboxSeen().delete(from + ':' + mid)) this._mboxPersist(); },

  // Titip satu pesan ke kotak surat `to` (4b). Hanya MEMUTUSKAN dan MENYEGEL; publish dilakukan pemanggil dengan hasilnya, apa adanya.
  // opts: { ttlMs, force } . Tanpa force, hanya menitip bila peer terdeteksi offline (this._on); peer yang sedang online dikirimi langsung, bukan lewat broker.
  // Hasil: { ok: true, topic, payload, mid, exp, retain: true, qos: 1 }  atau  { ok: false, why }
  //   why: 'online' (peer sedang online, kirim langsung) | 'peerFull' (titipan hidup ke peer ini sudah OUT_PER_PEER) | 'totalFull' (seluruh titipan sudah OUT_TOTAL)
  // Melempar bila: mode belum diatur, penerima tidak sah / diblokir, kunci pasangan belum ada, isi/TTL tidak sah (lihat mailboxSeal).
  // Titipan dicatat sampai exp-nya SEBELUM publish: bila publish gagal, panggil mailboxRelease(to, mid) supaya kuotanya kembali.
  mailboxDeposit(to, body, opts) {
    const o = opts || {};
    if (!o.force && this._on.get(to)) return { ok: false, why: 'online' };
    const out = this._mboxOut();
    Mailbox.outPrune(out, Date.now());
    const full = Mailbox.outCheck(out, to);
    if (full) return { ok: false, why: full };
    const s = this.mailboxSeal(to, body, o.ttlMs); // melempar bila tidak sah; kuota belum terpakai
    Mailbox.outAdd(out, to, s.mid, s.exp);
    this._mboxPersist();
    return { ok: true, topic: s.topic, payload: s.payload, mid: s.mid, exp: s.exp, retain: true, qos: 1 };
  },
  // Titip satu pesan bertanda tangan `m` (hasil sendText dsb.) ke kotak surat m.to, dalam bentuk isi yang dikenali mailboxIngest.
  mailboxDepositMsg(m, opts) {
    if (!m || typeof m !== 'object') throw new Error('Pesan tidak sah');
    return this.mailboxDeposit(m.to, { k: 'msg', m }, opts);
  },
  // Lepas satu titipan dari pencatat (publish gagal, atau kabar bahwa penerima sudah mengambilnya). Mengembalikan true bila ada yang dilepas.
  mailboxRelease(to, mid) {
    const r = Mailbox.outRemove(this._mboxOut(), to, mid);
    if (r) this._mboxPersist();
    return r;
  },
  // Jumlah titipan yang masih hidup ke `to` (atau ke semua penerima bila `to` tidak diberikan).
  mailboxPending(to) {
    Mailbox.outPrune(this._mboxOut(), Date.now());
    return Mailbox.outCount(this._mboxOut(), to);
  },
};
