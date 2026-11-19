'use strict';
// src/core/archne-courier.js — titipan pesan (custody), _carry, _gc, tanda terima
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const { isPrimText, CUST_DM_QUOTA, CUST_GMSG_QUOTA, PUBMSG_QUOTA, PUBMSG_SENDER_FRAC, DM_SENDER_FRAC, GID_TO, GMSG_GROUP_FRAC, GMSG_SENDER_FRAC, UNLIM_SENDER, HEX16, HEX32, HLC_DRIFT, RCPT_MAX, RCPT_TTL, RTAG, RV_TTL, SEED_TTL, STATE_MAX, STATE_PER_SENDER, custClass, custCost, custTtl } = require('./archne-constants');
const { idFromPub, verifyMsg } = require('./archne-util');

module.exports = {
  // Pesan grup yang boleh hanya DIBAWA: aku tidak bisa menilainya karena bukan anggota atau belum punya kunci epoch-nya.
  // Bila aku anggota dan kunci epoch-nya ada, pesan yang tidak terbuka atau pengirimnya bukan anggota adalah sampah: ditolak, tidak dititipkan.
  _g1Carriable(m) {
    if (m.kind !== 'g1' || !GID_TO.test(m.to) || this._allowed(m) || this._open(m) !== null) return false;
    const g = this.store.groups[m.to.slice(2)];
    return !(g && !g.removed && g.eps[m.ep || 0]);
  },
  // Setelah state grup berubah (undangan/kunci epoch baru), pesan grup yang tadinya hanya kubawa mungkin sekarang bisa kunilai: buka, dan simpan sebagai
  // pesanku (atau tolak bila ternyata sampah). Tanpa ini mereka tinggal di titipan selamanya, karena peer menganggapku sudah memilikinya (id ada di `ch`).
  _reopenCustody() {
    let n = 0;
    for (const [id, c] of Object.entries(this.store.custody)) {
      if (c.m.kind !== 'g1' || !this.store.groups[String(c.m.to).slice(2)]) continue; // grup yang belum kukenal: masih tidak bisa kunilai (jangan baca isinya dari disk)
      if (this._g1Carriable(c.m)) continue;
      const full = this._custPlain(c.m); // salinan datar: pesan ini akan disimpan sebagai pesanku, segmennya dibuang
      this._dropCustody(id);
      if (this._ingest(full) === 'new') n++;
    }
    return n;
  },
  _ingest(m, direct) {
    if (!verifyMsg(m)) return 'bad';
    if (this.store.msgs[m.id]) return 'dup';
    if (this.store.deleted[m.id] === m.from) return 'dup'; // sudah dibatalkan pengirimnya
    // DM/undangan untuk orang lain: dititipkan (tidak bisa dibuka, kunci hanya milik pengirim & penerima)
    if (m.from !== this.id && this.isBlocked(m.from)) {
      // Orang yang kublokir: DM, permintaan teman, dan undangan grup baru dibuang diam-diam (pengirim tetap menerima ack, tidak tahu diblokir).
      // Pesan publik/grup disimpan tapi disembunyikan (supaya sync tidak menariknya terus). Pembaruan kunci untuk grup yang sudah kuikuti tetap
      // diterima, kalau tidak aku kehilangan akses ke grup hanya karena pembuatnya kublokir.
      if (!direct && m.to !== this.id && HEX16.test(m.to)) return 'dup';
      if (!direct && this._g1Carriable(m)) return 'dup'; // pesan grup yang bukan untukku dan dari orang terblokir: tidak dititipkan
      if (m.to === this.id) {
        let known = false;
        if (m.kind === 'ginv') { try { known = !!this.store.groups[JSON.parse(this._open(m)).gid]; } catch {} }
        if (!known) return 'dup';
      }
    }
    if (!direct && m.to !== this.id && (m.kind === 'e1' || m.kind === 'ginv') && HEX16.test(m.to)) return this._carry(m);
    if (!direct && this._g1Carriable(m)) return this._carry(m); // tidak bisa kunilai (bukan anggota / kunci epoch belum ada): bawa sebagai ciphertext tertutup
    if (!this._allowed(m)) return 'bad';
    if (m.pc === 1 && !isPrimText(this._open(m))) return 'bad'; // anggota menandai obrolan biasa sebagai primer: tolak (kurir luar tidak bisa memeriksa ini, jadi dibatasi kuota)
    if (m.kind === 'ginv' && !this._acceptInvite(m)) return 'bad';
    if (m.kind !== 'ginv' && this._offerOf(m) === null) return 'bad'; // tawaran berkas rusak atau melanggar batas ukuran chat ini
    const pubOther = this._isPubOther(m);
    if (pubOther && !this._pubAdmit(m)) return 'full'; // kuota pesan publik orang lain penuh dan tidak ada yang lebih tua untuk digusur (Step 2d)
    this._tsSeen(m.ts); // hanya pesan yang benar-benar kita terima yang memajukan jam
    if (this.store.custody[m.id]) this._dropCustody(m.id); // dulu hanya kubawa, sekarang aku bisa membukanya: simpan sebagai pesanku
    this.store.msgs[m.id] = m;
    if (pubOther) this._pqAdd(m);
    if (m.ts > this._wall() + HLC_DRIFT) this.store.rx[m.id] = this._wall();
    const del = this._isDel(m);
    if (del) this._applyDel(m);
    const fc = m.to === this.id && m.from !== this.id ? this._friendCtl(m) : null;
    if (fc) this._applyFriendCtl(m, fc);
    const vc = m.kind === 'g1' ? this._vcCtl(m) : null;
    if (vc) this._applyVcCtl(m, vc);
    const pc = this._pinCtl(m);
    if (pc) this._applyPinCtl(m, pc);
    const rc = this._rxCtl(m);
    if (rc) this._applyRxCtl(m, rc, direct);
    else this._rxArrive(m); // sasaran baru tiba: reaksi yang menunggunya diterapkan
    this._save();
    if (m.kind !== 'ginv' && !del && !fc && !vc && !pc && !rc && !this.isBlocked(m.from)) this.emit('message', m);
    if (m.kind !== 'ginv' && !del && !fc && !vc && !pc && !rc) this._autoImg(m); // foto masuk dari LAN: unduh otomatis bila diizinkan (core/archne-media.js)
    this.emit('update');
    if (!direct) this._myRcpt(m); // tanda terima ikut disebarkan lewat sync
    if (m.kind === 'ginv') this._reopenCustody(); // state baru: pesan grup titipan yang tadinya tak bisa kunilai mungkin sekarang bisa
    return 'new';
  },
  // ---- Kurir & tanda terima ----
  // Korban yang adil dari sebuah daftar [[id, titipan]]: yang terlama milik pengirim yang paling banyak menitip.
  _fairVictim(list) {
    const cnt = new Map(); for (const [, c] of list) cnt.set(c.m.from, (cnt.get(c.m.from) || 0) + 1);
    return list.slice().sort((a, b) => (cnt.get(b[1].m.from) - cnt.get(a[1].m.from)) || (a[1].at - b[1].at))[0][0];
  },
  // Subset daftar [[id, titipan]] untuk tujuan (m.to) yang paling banyak titipannya: banjir ke satu grup/penerima hanya menggusur dirinya sendiri.
  _bigTo(list) {
    const per = new Map(); for (const [, c] of list) per.set(c.m.to, (per.get(c.m.to) || 0) + 1);
    const big = [...per.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return list.filter(([, c]) => c.m.to === big);
  },
  // Batas titipan sub dan pesan publik orang lain (byte). Bisa diganti lewat opts (tes, dan pengaturan pengguna di Step 2e); Infinity = tanpa batas.
  _custLimits() {
    const o = this.opts, q = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
    const dm = q(o.custDmQuota, CUST_DM_QUOTA), gm = q(o.custGmsgQuota, CUST_GMSG_QUOTA), pb = q(o.pubMsgQuota, PUBMSG_QUOTA);
    const per = (quota, f) => (Number.isFinite(quota) ? Math.floor(quota * f) : UNLIM_SENDER);
    return {
      dm: { quota: dm, perSender: per(dm, DM_SENDER_FRAC) },
      gmsg: { quota: gm, perSender: per(gm, GMSG_SENDER_FRAC), perGroup: Number.isFinite(gm) ? Math.floor(gm * GMSG_GROUP_FRAC) : Infinity },
      pub: { quota: pb, perSender: per(pb, PUBMSG_SENDER_FRAC) }, // pesan publik orang lain (archne-pubmsg-store.js)
    };
  },
  // Pemakaian titipan per kelas: { used (byte, termasuk overhead), count, quota }. State tidak berkuota byte (kuota = null, hitungan saja).
  custUsage() {
    const L = this._custLimits(), q = this._cq;
    let ns = 0; for (const c of Object.values(this.store.custody)) if (custClass(c.m) === 'state') ns++;
    return { state: { used: 0, count: ns, quota: null }, dm: { used: q.dm.bytes, count: q.dm.n, quota: L.dm.quota }, gmsg: { used: q.gmsg.bytes, count: q.gmsg.n, quota: L.gmsg.quota }, pub: this.pubUsage() };
  },
  _carry(m) {
    const C = this.store.custody;
    if (C[m.id]) return 'dup';
    if (m.from === this.id || m.to === m.from || this.store.receipts[m.id + m.to]) return 'dup';
    const cls = custClass(m), all = () => Object.entries(C).filter(([, c]) => custClass(c.m) === cls); // kelas lain tidak ikut dihitung dan tidak pernah digusur
    const sz = custCost(m), cost = ([, c]) => c.sz;
    // penghitung dijaga lewat store.custody (Proxy): total byte kelas ini, milik pengirim ini, dan (pesan grup) tujuan ini, tanpa memindai
    const stat = () => { const q = this._cq[cls]; return { tot: q.bytes, from: q.from.get(m.from) || 0, to: (q.to && q.to.get(m.to)) || 0 }; };
    if (cls === 'gmsg') {
      const lim = this._custLimits().gmsg;
      if (sz > lim.quota) return 'full';
      let st = stat();
      if (st.from + sz > lim.perSender) return 'full';
      while (st.to + sz > lim.perGroup) { // grup ini penuh: yang digusur dari grup ini sendiri (pengirim yang paling banyak menitip)
        const list = all().filter(([, c]) => c.m.to === m.to);
        if (!list.length) break;
        this._dropCustody(this._fairVictim(list)); st = stat();
      }
      while (st.tot + sz > lim.quota) {
        const list = all();
        if (!list.length) break;
        const per = new Map(); for (const e of list) per.set(e[1].m.to, (per.get(e[1].m.to) || 0) + cost(e));
        const big = [...per.entries()].sort((a, b) => b[1] - a[1])[0][0]; // grup yang paling banyak menitip (byte): satu grup ramai tidak menggusur grup lain
        this._dropCustody(this._fairVictim(list.filter(([, c]) => c.m.to === big))); st = stat();
      }
    } else if (cls === 'dm') {
      const lim = this._custLimits().dm;
      if (sz > lim.quota) return 'full';
      let st = stat();
      if (st.from + sz > lim.perSender) return 'full';
      while (st.tot + sz > lim.quota) {
        const list = all();
        if (!list.length) break;
        this._dropCustody(list.sort((a, b) => a[1].at - b[1].at)[0][0]); st = stat(); // yang terlama keluar dulu
      }
    } else { // state/primer: berbasis jumlah, tidak bisa diatur pengguna
      if (all().filter(([, c]) => c.m.from === m.from).length >= STATE_PER_SENDER) return 'full';
      if (all().length >= STATE_MAX) this._dropCustody(this._fairVictim(this._bigTo(all()))); // adil: satu pengirim (atau banyak identitas palsu) tidak menggusur grup lain; yang dikorbankan dari tujuan (grup/penerima) paling penuh
    }
    C[m.id] = { m, at: Date.now() };
    this._save();
    if (cls !== 'gmsg') this._kick([m.to]); // kalau tujuannya sedang online, langsung titip-antar (pesan grup tidak punya satu tujuan)
    return 'carried';
  },
  // Titipan pesan dibuang (tanda terima, kedaluwarsa, tergusur, diantar): byte berkasnya ikut dibuang.
  // 4c: titipan PESAN dibuang (tanda terima pesan, diantar, tersingkir) tidak lagi membawa byte berkasnya: penerima justru baru bisa
  // mengambil berkas dari kurir setelah menerima tawarannya. Byte dibuang oleh tanda terima berkas, pencabutan, atau kedaluwarsa.
  _dropCustody(id) {
    delete this.store.custody[id];
    this._custForget(id);
  },
  // Tanda terima bertanda tangan penerima: bukti pesan sudah sampai, boleh dibawa siapa saja.
  _myRcpt(m) {
    if (!m || m.from === this.id || !this.store.msgs[m.id]) return null;
    const dm = m.to === this.id && (m.kind === 'e1' || m.kind === 'ginv');
    if (!dm && m.kind !== 'g1') return null;
    const k = m.id + this.id;
    let r = this.store.receipts[k];
    if (!r) {
      const sig = crypto.sign(null, Buffer.from(RTAG + m.id + ':' + this.id), this.privKey).toString('base64');
      r = this.store.receipts[k] = { id: m.id, by: this.id, pub: this.pub, sig, at: Date.now() };
      this._save();
    }
    return { id: r.id, by: r.by, pub: r.pub, sig: r.sig };
  },
  _addRcpt(rc) {
    if (!rc || !HEX32.test(String(rc.id)) || !HEX16.test(String(rc.by))) return false;
    if (typeof rc.pub !== 'string' || typeof rc.sig !== 'string' || rc.pub.length > 200 || rc.sig.length > 200) return false;
    const k = rc.id + rc.by, R = this.store.receipts;
    if (R[k]) return false;
    try {
      if (rc.by !== idFromPub(rc.pub)) return false;
      const key = crypto.createPublicKey({ key: Buffer.from(rc.pub, 'base64'), format: 'der', type: 'spki' });
      if (!crypto.verify(null, Buffer.from(RTAG + rc.id + ':' + rc.by), key, Buffer.from(rc.sig, 'base64'))) return false;
    } catch { return false; }
    R[k] = { id: rc.id, by: rc.by, pub: rc.pub, sig: rc.sig, at: Date.now() };
    const c = this.store.custody[rc.id];
    if (c && c.m.to === rc.by) this._dropCustody(rc.id); // sudah sampai, kurir boleh membuang salinan (termasuk byte berkasnya)
    const m = this.store.msgs[rc.id];
    if (m && m.from === this.id) {
      const gs = this.store.gstatus[m.id];
      if (m.kind === 'g1') { if (gs && gs[rc.by] === 'pending') gs[rc.by] = 'delivered'; }
      else if (m.to === rc.by && this.store.status[m.id] === 'pending') this.store.status[m.id] = 'delivered';
    }
    this._save(); this.emit('update');
    return true;
  },
  _gc() {
    const now = Date.now();
    let ch = false;
    for (const [id, c] of Object.entries(this.store.custody)) if (now - c.at > custTtl(c.m)) { this._dropCustody(id); ch = true; }
    if (this._custBad) for (const id of [...this._custBad]) { if (this.store.custody[id]) { this._dropCustody(id); ch = true; } this._custBad.delete(id); } // segmen hilang/rusak: titipannya tidak bisa dikirim, buang
    const R = Object.entries(this.store.receipts);
    for (const [k, r] of R) if (now - r.at > RCPT_TTL) { delete this.store.receipts[k]; ch = true; }
    const left = Object.entries(this.store.receipts);
    if (left.length > RCPT_MAX) {
      left.sort((a, b) => a[1].at - b[1].at).slice(0, left.length - RCPT_MAX).forEach(([k]) => delete this.store.receipts[k]);
      ch = true;
    }
    ch = this._escExpire(now) || ch;
    for (const [id, r] of Object.entries(this.store.revokes)) if (now - r.at > RV_TTL) { delete this.store.revokes[id]; ch = true; }
    for (const [id, r] of Object.entries(this.store.freceipts)) if (now - r.at > RV_TTL) { delete this.store.freceipts[id]; ch = true; }
    for (const [k, b] of this._pushBack) if (b.next < now - 36e5) this._pushBack.delete(k);
    const sttl = this.opts.seedTtlMs || SEED_TTL;
    for (const [id, sd] of Object.entries(this.store.seeds)) if (now - Math.max(sd.at, sd.used || 0) > sttl || !this.store.msgs[id]) this._dropSeed(id);
    for (const id of this._bad.keys()) if (!this.store.msgs[id]) this._bad.delete(id);
    for (const [id, h] of this._holders) {
      for (const [pid, at] of h) if (now - at > 10 * 60e3) h.delete(pid);
      if (!h.size || !this.store.msgs[id]) this._holders.delete(id);
    }
    if (ch) this._save();
  },
};
