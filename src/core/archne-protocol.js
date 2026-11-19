'use strict';
// src/core/archne-protocol.js — _onConn, _handle, _request, _allowed, _flushOutbox, _syncFrom
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const { HEX16, LINE_MAX, RCPT_MAX, SYNC_CUS_BYTES, SYNC_GRP_BYTES, SYNC_PROF_BYTES, SYNC_PUB_BYTES, custRank, isStateMsg } = require('./archne-constants');
const { fitBytes, lineReader } = require('./archne-util');

module.exports = {
  _onConn(sock, from) {
    sock.on('error', () => {});
    const ip = from || sock.remoteAddress; // from: alamat "rtc:<id>" dari transport lintas jaringan (otentikasi ID oleh transport)
    // Baca mentah (Buffer), pecah per baris baru, dan decode hanya baris lengkap. Untuk file_get/file_put koneksi diserahkan ke
    // penangannya (file_put: byte setelah baris head adalah badan biner dan dikembalikan ke soket).
    let buf = Buffer.alloc(0), handoff = false;
    const onData = (d) => {
      if (handoff) return;
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      if (buf.length > LINE_MAX) { sock.destroy(); return; }
      let i;
      while (!handoff && (i = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (!o || typeof o !== 'object') continue;
        if (o.t === 'file_get') { handoff = true; sock.removeListener('data', onData); this._serveFile(sock, o, ip); return; }
        if (o.t === 'dx_get') { handoff = true; sock.removeListener('data', onData); this._dxServe(sock, o, ip); return; }
        if (o.t === 'file_put') {
          handoff = true; sock.removeListener('data', onData); sock.pause();
          if (buf.length) sock.unshift(buf);
          this._escPutServe(sock, o, ip); return;
        }
        const r = this._handle(o, ip);
        if (r) { r.hi = this.hello(); sock.end(JSON.stringify(r) + '\n'); }
      }
    };
    sock.on('data', onData);
  },
  _handle(o, ip) {
    if (o.hi) this.noteHello(o.hi, ip);
    const rid0 = o.hi && HEX16.test(String(o.hi.id)) ? o.hi.id : null, blk = !!rid0 && this.isBlocked(rid0); // peminta yang kublokir
    switch (o.t) {
      case 'hello': return { t: 'hello' };
      case 'peers': return { t: 'peers', list: blk ? [] : this._peerHints(rid0) };
      case 'esc_q': return blk ? { t: 'esc_r', ok: false, err: 'denied' } : this._escQuery(o);
      case 'dx_offer': return this._dxOffer(o, ip, rid0);
      case 'dx_list': return this._dxList(o, ip, rid0);
      case 'dx_done': return this._dxCtl(o, rid0);
      case 'dx_cancel': return this._dxOut.has(String(o.id)) ? this._dxCtl(o, rid0) : this._dxCtlIn(o, rid0);
      case 'pg_list': case 'pg_get': case 'pg_media': case 'pg_rx': case 'pg_rc': case 'pg_cmt': case 'pg_cml': case 'pg_cmd': return this._pgGate(o); // Halaman (1c-2); identitas dibuktikan tanda tangan (1c-3b), bukan hi.id
      case 'call': return this._callIn(o.m);
      case 'pvch': return { t: 'ack', ok: blk ? true : this._pvIngest(o.m) !== 'bad' }; // kontrol channel publik; yang kublokir diabaikan diam-diam
      case 'msg': {
        const r = this._ingest(o.m, true); // langsung: hanya untuk tujuan sebenarnya, bukan titipan
        const res = { t: 'ack', id: o.m && o.m.id, ok: r !== 'bad' };
        const rc = (r === 'new' || r === 'dup') ? this._myRcpt(o.m) : null;
        if (rc) res.rc = rc;
        return res;
      }
      case 'sync_req': {
        if (blk) return { t: 'sync_res', msgs: [], gmsgs: [], cmsgs: [], rc: [], rv: [], eh: [], fr: [], pf: [], pvm: [] }; // orang yang diblokir tidak mendapat apa pun dariku
        const have = new Set(o.have || []);
        // terbaru dulu, dibatasi jumlah (500) dan byte; lalu dikembalikan ke urutan waktu
        const pmin = Number.isFinite(o.pmin) ? o.pmin : 0; // peminta yang simpanan publiknya hampir penuh: pesan orang lain yang lebih tua dari ini pasti ditolaknya (Step 2d)
        const msgs = fitBytes(Object.values(this.store.msgs)
          .filter((m) => m.to === 'public' && !have.has(m.id) && !(pmin && m.ts < pmin && m.from !== rid0))
          .sort((a, b) => b.ts - a.ts).slice(0, 500), SYNC_PUB_BYTES).reverse();
        let gmsgs = [];
        const rid = o.hi && o.hi.id;
        if (o.gh && typeof o.gh === 'object' && rid) {
          const pinMs = [];
          for (const [gid, ids] of Object.entries(o.gh)) {
            const g = this.store.groups[gid];
            if (!g || g.removed || !Array.isArray(ids) || !g.members.some((x) => x.id === rid)) continue;
            const hv = new Set(ids);
            for (const m of Object.values(this.store.msgs)) {
              if (m.kind !== 'g1' || m.to !== 'g:' + gid || hv.has(m.id)) continue;
              const e = g.eps[m.ep || 0]; // anggota baru tidak boleh dapat riwayat sebelum dia masuk
              if (e && e.members.includes(rid)) gmsgs.push(m);
            }
            for (const m of this._pinCarriers('g:' + gid)) { // pembawa versi terkini tiap sematan bersama selalu ikut, walau chat ramai mendorongnya keluar dari 500 pesan terbaru
              const e = g.eps[m.ep || 0];
              if (!hv.has(m.id) && e && e.members.includes(rid)) pinMs.push(m);
            }
          }
          const pinIds = new Set(pinMs.map((m) => m.id));
          const rest = gmsgs.filter((m) => !pinIds.has(m.id)).sort((a, b) => b.ts - a.ts).slice(0, 500);
          gmsgs = fitBytes(pinMs.sort((a, b) => b.ts - a.ts).slice(0, 100).concat(rest), SYNC_GRP_BYTES).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
        }
        // Kurir: titipan + pesan DM milikku yang masih tertahan, hanya yang belum dimiliki peminta dan belum ada tanda terima.
        const ch = new Set(Array.isArray(o.ch) ? o.ch : []), rh = new Set(Array.isArray(o.rh) ? o.rh : []);
        const cand = Object.values(this.store.custody).map((c) => c.m);
        for (const [id, st] of Object.entries(this.store.status)) {
          const m = this.store.msgs[id];
          if (st === 'pending' && m && m.from === this.id && (m.kind === 'e1' || m.kind === 'ginv')) cand.push(m);
        }
        for (const [id, gs] of Object.entries(this.store.gstatus)) { // pesan grupku yang masih tertahan untuk anggota yang offline: boleh dititipkan ke siapa saja (tersegel)
          const m = this.store.msgs[id];
          if (m && m.from === this.id && m.kind === 'g1' && Object.values(gs).some((v) => v === 'pending')) cand.push(m);
        }
        const gx = new Set(Array.isArray(o.gx) ? o.gx : []);
        const cmsgs = fitBytes(cand.filter((m) => !ch.has(m.id) && !(m.kind === 'g1' && gx.has(m.id)) && !this.store.receipts[m.id + m.to])
          .sort((a, b) => (custRank(a, rid) - custRank(b, rid)) || a.ts - b.ts).slice(0, 300), SYNC_CUS_BYTES); // untuk peminta, lalu state, lalu DM, pesan grup paling akhir; di tiap tingkat yang lama dulu
        const rc = Object.entries(this.store.receipts).filter(([k]) => !rh.has(k))
          .sort((a, b) => b[1].at - a[1].at).slice(0, 300).map(([, r]) => ({ id: r.id, by: r.by, pub: r.pub, sig: r.sig }));
        const vh = new Set(Array.isArray(o.vh) ? o.vh : []);
        const rv = Object.values(this.store.revokes).filter((r) => !vh.has(r.id)).sort((a, b) => b.at - a.at).slice(0, 300)
          .map((r) => ({ id: r.id, by: r.by, pub: r.pub, sig: r.sig }));
        // 4c: berkas lengkap yang kupegang untuk peminta (tujuan pesannya) diumumkan; tanda terima berkas untuk titipan yang peminta pegang dikembalikan
        const eh = [];
        if (rid) for (const [id, e] of Object.entries(this.store.esc)) {
          if (eh.length >= 200) break;
          if (e.done && e.to === rid && !this.store.revokes[id] && !this.store.freceipts[id]) eh.push(id);
        }
        // berkas publik di kolam kurir publik, dan salinan seed (publik/grup) yang boleh diambil peminta
        for (const [id, e] of Object.entries(this.store.esc)) {
          if (eh.length >= 200) break;
          if (e.done && e.to === 'public' && !this.store.revokes[id] && !this.store.deleted[id]) eh.push(id);
        }
        for (const [id, e] of Object.entries(this.store.esc)) { // titipan berkas grup: hanya diumumkan ke anggota grupnya
          if (eh.length >= 200) break;
          if (!e.done || this._poolOf(e.to) !== 'grp' || this.store.revokes[id] || this.store.deleted[id]) continue;
          const gm = this.store.msgs[id];
          if (gm && this._canFetch(gm, rid)) eh.push(id);
        }
        for (const id of Object.keys(this.store.seeds)) {
          if (eh.length >= 200) break;
          const sm = this.store.msgs[id];
          if (sm && this._canFetch(sm, rid)) eh.push(id);
        }
        const fr = [];
        if (Array.isArray(o.eq)) for (const id of o.eq.slice(0, 300)) {
          const r = this.store.freceipts[String(id)];
          if (r) fr.push({ id: r.id, by: r.by, pub: r.pub, sig: r.sig });
        }
        // profil: yang belum dimiliki peminta atau versinya lebih lama (bertanda tangan pemiliknya, jadi boleh diteruskan peer mana pun)
        const pv = o.pv && typeof o.pv === 'object' ? o.pv : {};
        const pf = fitBytes(Object.values(this.store.profiles).filter((x) => !(Number.isSafeInteger(pv[x.id]) && pv[x.id] >= x.ts))
          .sort((a, b) => b.ts - a.ts).slice(0, 200).map((x) => this._wireProfile(x)), SYNC_PROF_BYTES); // foto membuat catatan besar: sisanya menyusul di sync berikutnya
        return { t: 'sync_res', msgs, gmsgs, cmsgs, rc, rv, eh, fr, pf, pvm: this._pvForSync(o.pvh, o.pvb) };
      }
    }
    return null;
  },
  _request(peer, obj, timeout = 3000) {
    return new Promise((res) => {
      let s = null;
      try { s = this._dial(peer); } catch { s = null; }
      if (!s) return res(null); // tidak ada rute (mis. peer rtc: tanpa transport terpasang)
      let done = false;
      const fin = (v) => { if (done) return; done = true; clearTimeout(t); s.destroy(); res(v); };
      const t = setTimeout(() => fin(null), timeout);
      s.on('error', () => fin(null));
      lineReader(s, (l) => {
        try { const r = JSON.parse(l); if (r.hi) this.noteHello(r.hi, peer.ip); fin(r); } catch { fin(null); }
      });
      s.on('connect', () => s.write(JSON.stringify(Object.assign({ hi: this.hello() }, obj)) + '\n'));
    });
  },
  _allowed(m) {
    const k = m.kind;
    if (m.to === 'public') return !k;
    if (m.to.startsWith('g:')) {
      const g = this.store.groups[m.to.slice(2)];
      // pengirim harus anggota grup saat ini: orang yang sudah dikeluarkan tidak bisa menulis walau masih punya kunci lama
      return k === 'g1' && !!g && g.members.some((x) => x.id === m.from) && this._open(m) !== null;
    }
    return m.to === this.id && (k === 'e1' || k === 'ginv') && this._open(m) !== null;
  },
  async _flushOutbox(p) {
    const blk = this.store.blocked[p.id];
    if (this._fl.has(p.id) || (blk && !blk.fdl)) return;
    this._fl.add(p.id);
    try {
      const M = this.store.msgs, ids = [];
      if (blk) { if (this.store.status[blk.fdl] === 'pending' && M[blk.fdl]) ids.push(blk.fdl); } // diblokir: hanya pemberitahuan putus teman, sekali
      else {
        for (const [id, st] of Object.entries(this.store.status)) if (st === 'pending' && M[id] && M[id].to === p.id) ids.push(id);
        for (const [id, gs] of Object.entries(this.store.gstatus)) if (gs[p.id] === 'pending' && M[id]) ids.push(id);
      }
      ids.sort((a, b) => M[a].ts - M[b].ts);
      for (const id of ids) {
        const r = await this._request(p, { t: 'msg', m: M[id] });
        if (!r) break;
        if (r.t === 'ack' && r.rc) this._addRcpt(r.rc);
        if (r.t === 'ack' && r.ok) {
          if (this.store.gstatus[id]) this.store.gstatus[id][p.id] = 'delivered';
          else this.store.status[id] = 'delivered';
          if (blk && blk.fdl === id) delete blk.fdl;
          this._save(); this.emit('update');
        } else if (r.t === 'ack' && M[id].kind === 'ginv') {
          this.store.status[id] = 'rejected'; // penerima menolak (mis. sudah tidak relevan); jangan dicoba terus
          this._save(); this.emit('update');
        }
      }
      // titipan untuk peer ini: antar langsung; ack penerima = bukti, salinan titipan dibuang
      if (!blk) for (const [id, c] of Object.entries(this.store.custody)) {
        if (c.m.to !== p.id) continue;
        const r = await this._request(p, { t: 'msg', m: c.m });
        if (!r) break;
        if (r.t === 'ack') { if (r.rc) this._addRcpt(r.rc); this._dropCustody(id); this._save(); }
      }
    } finally { this._fl.delete(p.id); }
  },
  async _syncFrom(p) {
    if (this.isBlocked(p.id)) return true; // tidak menarik apa pun dari orang yang kublokir
    const have = Object.values(this.store.msgs).filter((m) => m.to === 'public')
      .sort((a, b) => b.ts - a.ts).slice(0, 5000).map((m) => m.id);
    const gh = {};
    for (const g of Object.values(this.store.groups)) if (!g.removed && g.members.some((x) => x.id === p.id)) gh[g.id] = [];
    if (Object.keys(gh).length) for (const m of Object.values(this.store.msgs)) if (m.kind === 'g1' && gh[m.to.slice(2)]) gh[m.to.slice(2)].push(m.id);
    const ch = Object.keys(this.store.custody)
      .concat(Object.values(this.store.msgs).filter((m) => m.kind === 'e1' || m.kind === 'ginv').sort((a, b) => b.ts - a.ts).map((m) => m.id)).slice(0, 8000);
    const gx = Object.values(this.store.msgs).filter((m) => m.kind === 'g1').sort((a, b) => b.ts - a.ts).map((m) => m.id).slice(0, 4000); // pesan grup yang sudah kupunya (terpisah dari ch supaya tidak menggeser id state)
    const rh = Object.keys(this.store.receipts).slice(-RCPT_MAX); // sama dengan batas simpanan: sisanya akan dikirim ulang terus dan menutup yang benar-benar belum ada
    const vh = Object.keys(this.store.revokes).slice(-2000);
    const eq = Object.keys(this.store.esc).concat(Object.entries(this.store.files).filter(([, f]) => f.escTouched).map(([id]) => id)).slice(-300); // byte berkas yang kupegang / pernah kudorong: peer yang punya tanda terima berkasnya membalas
    const pv = {};
    for (const [id, x] of Object.entries(this.store.profiles).sort((a, b) => b[1].ts - a[1].ts).slice(0, 500)) pv[id] = x.ts;
    const pvh = {};
    for (const [cid, c] of Object.entries(this.pv).slice(0, 1000)) pvh[cid] = c.v; // versi channel publik yang kupunya
    const pvb = Object.keys(this.store.blocked).slice(0, 200); // pengirim yang kublokir: tidak usah dikirimi lagi
    const pmin = this._pubFloor(), req = { t: 'sync_req', have, gh, ch, gx, rh, vh, eq, pv, pvh, pvb };
    if (pmin) req.pmin = pmin;
    const r = await this._request(p, req, 5000);
    if (r && r.t === 'sync_res') {
      let n = 0, c = 0;
      for (const rc of (Array.isArray(r.rc) ? r.rc : []).slice(0, 500)) this._addRcpt(rc); // tanda terima dulu, supaya titipan yang sudah sampai tidak diambil
      for (const rv of (Array.isArray(r.rv) ? r.rv : []).slice(0, 300)) this._addRevoke(rv);
      for (const fr of (Array.isArray(r.fr) ? r.fr : []).slice(0, 300)) this._addFileRcpt(fr);
      const cm = Array.isArray(r.cmsgs) ? r.cmsgs.slice(0, 300) : [];
      // state (anggota, admin, pemilik, kunci epoch) diproses PERTAMA, sebelum pesan: pesan grup dan pesan kontrol sematan dinilai dengan keadaan grup terbaru
      // (kunci epoch baru, siapa admin sekarang), jadi tidak ada yang tertolak atau salah dinilai hanya karena datang lebih dulu dari state-nya dalam satu jawaban.
      const list = [].concat(cm.filter(isStateMsg), Array.isArray(r.msgs) ? r.msgs : [], Array.isArray(r.gmsgs) ? r.gmsgs : [], cm.filter((m) => !isStateMsg(m)));
      for (const m of list) { const x = this._ingest(m); if (x === 'new') n++; else if (x === 'carried') c++; }
      for (const m of (Array.isArray(r.pvm) ? r.pvm : []).slice(0, 800)) if (this._pvIngest(m) === 'new') n++;
      let pc = 0;
      for (const pf of (Array.isArray(r.pf) ? r.pf : []).slice(0, 300)) if (this._addProfile(pf)) pc++;
      if (pc) { this._save(); this.emit('update'); }
      this._noteHolders(p, r.eh); // setelah pesan masuk: tawaran yang baru tiba dari kurir ini sudah dikenal
      if (n || c) this.log(`sync dari ${p.name}: ${n} pesan baru, ${c} titipan`);
      return true;
    }
    return false;
  },
};
