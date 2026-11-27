'use strict';
// src/core/archne-notify-state.js — notifikasi + getState()
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const Pack = require('../archne-pack');
const Pins = require('../archne-pins');
const I18N = require('./archne-i18n-node');
const { AV_MAX, HEX16, MAX_TEXT, NOTIFY_MAX_AGE, PROF_MAX } = require('./archne-constants');

module.exports = {
  // ---- Notifikasi (v0.11.0) ----
  // Kunci chat: 'public', 'g:<gid>', atau id teman (DM). Bawaan: publik mati, DM dan grup menyala; `store.notif[kunci]` (true/false) menimpanya.
  notifyOn(key) {
    const v = this.store.notif[key];
    return typeof v === 'boolean' ? v : key !== 'public';
  },
  // on: true/false = timpa bawaan; null = kembali ke bawaan.
  setNotify(key, on) {
    key = String(key);
    if (!(key === 'public' || (key.startsWith('g:') && HEX16.test(key.slice(2))) || HEX16.test(key))) throw new Error('Chat tidak valid');
    if (on === null || on === undefined || on === (key !== 'public')) delete this.store.notif[key]; // sama dengan bawaan: tidak perlu disimpan
    else this.store.notif[key] = !!on;
    this._save(); this.emit('update');
    return true;
  },
  // Isi pemberitahuan untuk pesan masuk, atau null bila tidak perlu (pesan sendiri, chat dibisukan, terlalu lama, tidak terbaca).
  // Pesan lama (hasil sinkronisasi riwayat) tidak memicu notifikasi.
  notifyOf(m) {
    if (!m || m.from === this.id || m.kind === 'ginv' || this.isBlocked(m.from)) return null;
    if (Date.now() - this._dts(m) > NOTIFY_MAX_AGE && !(this._mbFresh && this._mbFresh.has(m.id))) return null; // titipan kotak surat boleh berumur berhari-hari: yang dihitung saat tiba
    const key = m.to === 'public' ? 'public' : String(m.to).startsWith('g:') ? m.to : m.from;
    if (!this.notifyOn(key)) return null;
    let text = m.kind ? this._open(m) : m.text;
    if (typeof text !== 'string') return null;
    const off = this._offerOf(m);
    if (off) text = off.x && off.x.k === 'vc' ? I18N.tr('prev.voice', null, '🎤 Pesan suara') : '📎 ' + off.name;
    else text = this._splitReply(text).text;
    text = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) return null;
    const who = m.name || (this.peers.get(m.from) || {}).name || '?';
    let title = who;
    if (key === 'public') title = 'Publik · ' + who;
    else if (key.startsWith('g:')) { const g = this.store.groups[key.slice(2)]; title = (g ? g.name : 'Grup') + ' · ' + who; }
    return { key, title, text };
  },
  // Notifikasi kaya (Android): isi dasar notifyOf ditambah siapa pengirimnya, fotonya, dan nama grup/"Publik", supaya notifikasi bisa
  // digambar seperti aplikasi chat (foto profil, riwayat percakapan, tombol Balas). Isi dasar { key, title, text } tidak berubah.
  notifyRich(m) {
    const n = this.notifyOf(m);
    if (!n) return null;
    let chat = '';
    if (n.key === 'public') chat = 'Publik';
    else if (n.key.startsWith('g:')) { const g = this.store.groups[n.key.slice(2)]; chat = g ? g.name : 'Grup'; }
    return Object.assign({}, n, { from: m.from, who: m.name || (this.peers.get(m.from) || {}).name || '?', chat, ts: this._dts(m), av: this.avatarOf(m.from) });
  },
  getState() {
    const notes = this.store.notes.map((n) => ({ id: n.id, from: '', to: n.to, ts: n.ts, name: '', text: n.nk ? I18N.tr(n.nk, n.np, n.text) : n.text, status: null, sys: true }));
    const hid = this.store.hidden;
    const blk = this.store.blocked;
    const byBlocked = (m) => (m.from !== this.id && !!blk[m.from]) || (HEX16.test(m.to) && !!blk[m.to]); // pesan dari orang yang kublokir, dan chat privat dengannya
    const msgs = Object.values(this.store.msgs).filter((m) => m.kind !== 'ginv' && !hid[m.id] && !byBlocked(m) && !this._isCtlMsg(m))
      .map((m) => {
        const o = { id: m.id, from: m.from, to: m.to, ts: this._dts(m), name: m.name, text: m.text, status: this.store.status[m.id] || null };
        if (o.status === 'pending' && m.from === this.id) { const mb = this.mailboxStatus(m.id); if (mb) { o.mb = mb.state; if (mb.why) o.mbwhy = mb.why; } } // 4e: antre / dititipkan / gagal di kotak surat
        if (m.kind) {
          const t = this._open(m);
          o.text = t === null ? '🔒 (tidak bisa didekripsi)' : t;
          o.enc = true;
        }
        const sp = this._splitReply(o.text);
        if (sp.reply) { o.text = sp.text; o.reply = this._replyPreview(sp.reply, m); }
        const off = this._offerOf(m);
        if (off !== undefined) {
          if (off) { o.file = { name: off.name, size: off.meta.size, psize: off.meta.psize, mode: off.meta.mode };
            if (off.x) o.file.x = off.x; // info media tervalidasi (jenis, ukuran, durasi, thumbnail JPEG base64)
            if (m.from !== this.id) {
              const g = this.store.got[m.id];
              if (g) o.file.saved = { name: g.name, path: g.path };
              else {
                if (this._prog[m.id]) o.file.rx = Object.assign({}, this._prog[m.id]);
                const held = this._holdersOf(m.id).length; // kabar kurir (hanya di memori); bisa basi, yang menentukan tetap verifikasi potongan
                if (held) o.file.held = held;
              }
            } else {
              const f = this.store.files[m.id];
              if (f) {
                o.file.mine = true;
                const n = (m.to === 'public' || m.kind === 'g1') ? this._pubHave(m.id, f).size : (f.pushed ? Object.keys(f.pushed).length : 0); // publik/grup: pemegang online sekarang
                if (n) o.file.pushed = n;
                if (!this._escSizeOk(f.meta.psize)) o.file.cap = this._escMaxBytes(); // di atas batas titipan (hemat relay): tidak dititipkan, hanya diambil langsung dari pengirim; 0 = titipan dimatikan
              }
              for (const k of this._pushes.keys()) if (k.startsWith(m.id + ':')) { o.file.pushing = true; break; }
            }
            o.text = off.x && off.x.k === 'vc' ? I18N.tr('prev.voice', null, '🎤 Pesan suara') : '📎 ' + off.name; }
          else o.text = I18N.tr('prev.badOffer', null, '📎 (tawaran berkas tidak valid)');
        }
        const gs = this.store.gstatus[m.id];
        if (gs) { const v = Object.values(gs); o.gs = { done: v.filter((x) => x === 'delivered').length, total: v.length }; }
        if (this.store.react[m.id]) { const rx = this.reactions(m.id); if (rx.length) o.rx = rx; } // reaksi (v0.24.0): chip di bawah gelembung
        return o;
      });
    const all = msgs.concat(notes).sort((a, b) => a.ts - b.ts).slice(-500);
    const peers = [...this.peers.values()].filter((p) => !blk[p.id]).map((p) => ({ id: p.id, name: p.name, ip: p.ip, port: p.port, online: this.isOnline(p), bg: this.peerLive(p) === 'bg', secure: !!p.xpub, lan: this._directOk(p.ip), friend: this.fstate(p.id) === 'ok', fst: this.fstate(p.id) }));
    const groups = Object.values(this.store.groups).map((g) => Object.assign(this._pubGroup(g), { channels: this.vcList(g.id), av: g.av ? 'data:image/jpeg;base64,' + g.av : '' })); // channel voice (v0.19.0) ikut state supaya UI yang terlambat terpasang langsung tahu
    const bios = {}; // deskripsi semua orang yang tampil di UI (peer, anggota grup, aku)
    const avatars = {}; // foto (data URL) hanya untuk yang punya
    for (const id of [this.id, ...peers.map((p) => p.id), ...groups.flatMap((g) => g.members.map((x) => x.id))].filter((id) => !blk[id])) {
      bios[id] = this.bioOf(id);
      const av = this.avatarOf(id);
      if (av) avatars[id] = 'data:image/jpeg;base64,' + av;
    }
    const blocked = Object.entries(blk).map(([id, r]) => ({ id, name: (this.peers.get(id) || {}).name || r.name || '?', at: r.at })).sort((a, b) => b.at - a.at);
    return { me: { id: this.id, name: this.name, port: this.port, bio: this.bioOf(this.id), addrs: this.myAddrs() }, wan: Object.assign(this.wanInfo(), this.mailboxOutEnabled() ? { mbox: true } : {}), peers, groups, blocked, bios, avatars, notif: Object.assign({}, this.store.notif), call: this.callInfo(), vc: this._vcMe ? { gid: this._vcMe.gid, cid: this._vcMe.cid } : null, pv: { me: this._pvMe ? this._pvMe.cid : null, channels: this.pvList() }, pins: this.pinAll(), calls: this._callsOut(blk), messages: all, limits: { maxText: MAX_TEXT, pin: { max: Pins.PIN_MAX_LIVE, text: Pins.PIN_TEXT_MAX }, maxFile: Pack.LIMITS, maxBio: PROF_MAX, avatarDim: 128, avatarMax: AV_MAX } };
  },
};
