'use strict';
// src/core/archne-messages.js — sendText, _send, hapus pesan, clearChat, anti-spam, balas
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const { CTRL, DEL, HEX16, HEX32, MAX_TEXT, isPrimText, PREVIEW_MAX, REPLY, REPLY_OVERHEAD, REPLY_RE, SPAM_SHORT_LEN, SPAM_SHORT_WINDOW, SPAM_SIM, SPAM_WINDOW } = require('./archne-constants');
const { bigramDice, spamNorm } = require('./archne-util');
const { ek } = require('./archne-ecode');
const T = require('./archne-i18n-node').tr; // dipanggil saat dipakai (bahasa dibaca saat itu), bukan saat load

module.exports = {
  // Pesan kontrol tersembunyi (batal kirim, pertemanan, channel suara, sematan, reaksi): tidak tampil, tidak dihitung spam, tidak bisa dibalas, disematkan, atau diberi reaksi.
  _isCtlMsg(m) { return this._isDel(m) || this._friendCtl(m) || this._vcCtl(m) || this._isPinCtl(m) || this._isRxCtl(m); },
  _isDel(m) {
    if (m.kind === 'ginv') return false;
    const t = m.kind ? this._open(m) : m.text;
    return typeof t === 'string' && t.startsWith(DEL);
  },
  // Pesan batal kirim hanya sah untuk pesan milik pengirimnya sendiri, di chat yang sama.
  // Kalau pesan aslinya belum sampai, penanda disimpan dulu supaya pesan itu dibuang begitu tiba.
  _applyDel(dm) {
    const id = String(dm.kind ? this._open(dm) : dm.text).slice(DEL.length);
    if (!/^[0-9a-f]{32}$/.test(id)) return;
    const t = this.store.msgs[id];
    if (t) {
      if (t.from !== dm.from || this._chatKey(t) !== this._chatKey(dm) || t.kind === 'ginv' || this._isDel(t)) return;
      if (this._isPubOther(t)) this._pqSub(t);
      delete this.store.msgs[id]; delete this.store.status[id]; delete this.store.gstatus[id];
      delete this.store.hidden[id]; this._plain.delete(id);
    }
    this.store.deleted[id] = dm.from;
    this._rxDrop([id]); // reaksi pada pesan itu ikut hilang
    if (t) this._dropOffer([id]); // unduhan yang sedang jalan dihentikan, sisa .part/.pk dan catatan `got` dibuang
  },
  // Batal kirim (hapus untuk semua). Pesan hilang di perangkat penerima, juga yang masih offline saat dia online lagi.
  deleteMessage(id) {
    const t = this.store.msgs[String(id)];
    if (!t || t.from !== this.id || t.kind === 'ginv' || this._isDel(t)) throw ek('e.msg.noUnsend', null, 'Pesan tidak bisa dibatalkan');
    const dm = this._send(DEL + t.id, t.to);
    this._applyDel(dm);
    this._dropFile(t.id);
    this._save(); this.emit('update');
    return true;
  },
  // Dikeluarkan dari grup = grup hilang dari perangkat ini: pesan, kunci, catatan, dan undangannya ikut dihapus.
  // `left` menyimpan epoch terakhir supaya undangan lama yang telat sampai tidak menghidupkan grup lagi.
  _purgeGroup(g, epoch) {
    const to = 'g:' + g.id;
    const drop = [];
    for (const [id, m] of Object.entries(this.store.msgs)) {
      if (m.to === to) { drop.push(id); continue; }
      if (m.kind === 'ginv') {
        try { const j = JSON.parse(this._open(m)); if (j && j.gid === g.id) drop.push(id); } catch {}
      }
    }
    for (const id of drop) {
      delete this.store.msgs[id]; delete this.store.status[id]; delete this.store.gstatus[id];
      delete this.store.hidden[id]; this._plain.delete(id);
    }
    this._dropOffer(drop); // sisa unduhan dan salinan kompres kiriman kita di grup ini
    this._rxDrop(drop); // reaksi pada pesan grup ini
    this.store.notes = this.store.notes.filter((n) => n.to !== to);
    delete this.store.pins[to]; delete this.store.mypins[to]; // sematan grup ikut hilang bersama grupnya
    delete this.store.groups[g.id];
    this.store.left[g.id] = Math.max(epoch || 0, this.store.left[g.id] || 0);
    this._save(); this.emit('update');
  },
  _chatKey(m) {
    if (m.to === 'public' || m.to.startsWith('g:')) return m.to;
    return m.from === this.id ? m.to : m.from;
  },
  // Bersihkan chat (seperti WhatsApp): hanya di perangkat ini. Pesan ditandai tersembunyi (bukan dihapus dari store)
  // supaya sinkronisasi dari peer tidak memunculkannya lagi dan outbox yang masih tertahan tetap terkirim.
  clearChat(key) {
    key = String(key);
    if (key !== 'public' && !(key.startsWith('g:') && this.store.groups[key.slice(2)]) && !HEX16.test(key)) throw ek('e.msg.chatUnknown', null, 'Chat tidak dikenal');
    const offers = [];
    for (const [id, m] of Object.entries(this.store.msgs)) {
      if (m.kind === 'ginv' || this._chatKey(m) !== key) continue;
      this.store.hidden[id] = 1;
      if (this._offerOf(m) !== undefined) offers.push(id);
    }
    this._dropOffer(offers); // berkas yang sudah ada di folder unduhan tidak disentuh
    this.store.notes = this.store.notes.filter((n) => n.to !== key);
    if (HEX16.test(key)) for (const r of this.store.calls) { // hilang dari chat, tetap ada di tab Panggilan
      if (r.group) { if (r.members.some((x) => x.id === key)) r.hcs = [...new Set([...(r.hcs || []), key])]; } // kartu grup tampil di DM tiap anggota: tiap DM menyembunyikan miliknya sendiri
      else if (r.peer === key) r.hc = 1;
    }
    this._save(); this.emit('update');
  },
  // Setelah menerima kunci baru, tarik ulang pesan yang tadi gagal dibuka karena kuncinya belum ada.
  _resync() {
    if (this._rs || this.stopped) return;
    this._rs = setTimeout(() => {
      this._rs = null;
      if (this.stopped) return;
      for (const p of this.peers.values()) if (this.isOnline(p)) this._syncFrom(p);
    }, 200);
  },
  _kick(ids) {
    for (const id of ids) { const p = this.peers.get(id); if (this.isOnline(p)) this._flushOutbox(p); }
  },
  // replyTo (opsional): id pesan yang dibalas. Harus ada di chat yang sama dan berupa pesan biasa (bukan kontrol/undangan).
  sendText(text, to = 'public', replyTo) {
    text = String(text).replace(CTRL, '').trim();
    if (!text) return null;
    if (text.length > MAX_TEXT) throw ek('e.msg.tooLong', { n: text.length, max: MAX_TEXT }, 'Pesan terlalu panjang: {n} dari maks {max} karakter. Persingkat atau pecah jadi beberapa pesan; pesan tidak dikirim.');
    this._checkSpam(text, to);
    if (replyTo !== undefined && replyTo !== null && replyTo !== '') {
      const rid = String(replyTo), t = HEX32.test(rid) ? this.store.msgs[rid] : null;
      if (!t || t.kind === 'ginv' || this._isCtlMsg(t) || this.store.hidden[rid]) throw ek('e.msg.replyGone', null, 'Pesan yang dibalas tidak ditemukan (mungkin sudah dibatalkan atau dibersihkan)');
      if (this._chatKey(t) !== to) throw ek('e.msg.replyOther', null, 'Pesan yang dibalas bukan dari chat ini');
      text = REPLY + rid + '\u0003' + text;
    }
    return this._send(text, to);
  },
  // Tolak teks yang sama/mirip dengan pesan terakhirku di chat ini. Teks pendek (< 12 huruf/angka): hanya yang sama persis dan dalam 30 detik
  // (supaya "ok" atau "ya" sesekali tetap bisa); teks lebih panjang: kemiripan >= 85% dalam 10 menit.
  _checkSpam(text, to) {
    const n = spamNorm(text), now = Date.now();
    for (const m of Object.values(this.store.msgs)) {
      if (m.from !== this.id || now - m.ts > SPAM_WINDOW || m.kind === 'ginv' || this._chatKey(m) !== to || this._isCtlMsg(m)) continue; // kontrol (batal kirim, pertemanan, channel) bukan pesan pengguna
      const raw = m.kind ? this._open(m) : m.text;
      if (typeof raw !== 'string' || this._offerOf(m) !== undefined) continue;
      const o = spamNorm(this._splitReply(raw).text);
      const short = Math.min(n.length, o.length) < SPAM_SHORT_LEN;
      const same = short ? (n === o && now - m.ts <= SPAM_SHORT_WINDOW) : bigramDice(n, o) >= SPAM_SIM;
      if (same) throw ek('e.msg.spam', null, 'Pesan ini sama (atau sangat mirip) dengan pesan yang baru kamu kirim di chat ini, jadi tidak dikirim untuk mencegah spam. Ubah isinya atau batalkan pesan sebelumnya dulu.', 'SPAM');
    }
  },
  // Pisahkan awalan balasan: { reply: id|null, text }.
  _splitReply(t) {
    const x = typeof t === 'string' ? REPLY_RE.exec(t) : null;
    return x ? { reply: x[1], text: t.slice(REPLY_OVERHEAD) } : { reply: null, text: t };
  },
  // Pratinjau pesan yang dibalas untuk ditampilkan di perangkat ini. Hanya memakai pesan di chat yang SAMA dengan balasannya
  // (referensi ke chat lain tidak membocorkan isinya). Kalau pesan aslinya tidak ada (dibatalkan/dibersihkan/belum tiba): { id, gone: true }.
  _replyPreview(id, m) {
    const t = this.store.msgs[id];
    if (!t || t.kind === 'ginv' || this.store.hidden[id] || this._isCtlMsg(t) || this._chatKey(t) !== this._chatKey(m)) return { id, gone: true };
    const raw = t.kind ? this._open(t) : t.text;
    if (raw === null) return { id, from: t.from, name: t.name, text: T('prev.undecrypted', null, '🔒 (tidak bisa didekripsi)') };
    const off = this._offerOf(t);
    let body = off ? (off.x && off.x.k === 'vc' ? T('prev.voice', null, '🎤 Pesan suara') : '📎 ' + off.name) : off === null ? T('prev.fileUnknown', null, '📎 (berkas)') : this._splitReply(raw).text;
    body = String(body).replace(/\s+/g, ' ');
    if (body.length > PREVIEW_MAX) body = body.slice(0, PREVIEW_MAX) + '…';
    return { id, from: t.from, name: t.name, text: body };
  },
  _send(text, to) {
    let m, targets;
    if (to === 'public') {
      m = this._makeMsg('public', null, text);
      this.store.msgs[m.id] = m;
      this._save(); this.emit('update');
      for (const p of this.peers.values()) if (this.isOnline(p) && !this.isBlocked(p.id)) this._request(p, { t: 'msg', m });
      return m;
    }
    if (to.startsWith('g:')) {
      const g = this.store.groups[to.slice(2)];
      if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
      if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
      m = this._makeMsg(to, 'g1', text, undefined, isPrimText(text));
      targets = g.members.map((x) => x.id).filter((id) => id !== this.id && !this.isBlocked(id)); // yang kublokir tidak dikirimi langsung
      this.store.gstatus[m.id] = Object.fromEntries(targets.map((id) => [id, 'pending']));
    } else {
      if (this.isBlocked(to)) throw ek('e.msg.blockedSend', null, 'Kamu memblokir orang ini. Buka blokirnya dulu untuk mengirim pesan.');
      m = this._makeMsg(to, 'e1', text, undefined, isPrimText(text));
      this.store.status[m.id] = 'pending';
      targets = [to];
    }
    this.store.msgs[m.id] = m;
    this._save(); this.emit('update');
    this._kick(targets);
    return m;
  },
};
