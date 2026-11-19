'use strict';
// src/core/archne-group-admin.js — createGroup, tambah/hapus anggota, admin, owner, keluar, bubar
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const { AV_DIM, AV_MAX, MAX_CIPHER } = require('./archne-constants');
const { ek } = require('./archne-ecode');

module.exports = {
  createGroup(name, memberIds) {
    name = this._cleanGroupName(name);
    if (!name) throw ek('e.group.nameEmpty', null, 'Nama grup kosong');
    const ids = [...new Set(memberIds || [])].filter((id) => id !== this.id);
    if (!ids.length) throw ek('e.group.pickMin', null, 'Pilih minimal 1 anggota');
    for (const id of ids) {
      const p = this.peers.get(id);
      if (this.isBlocked(id)) throw ek('e.group.blockedMember', null, 'Kamu memblokir salah satu anggota yang dipilih; buka blokirnya dulu');
      if (!p || !p.xpub) throw ek('e.group.noKey', null, 'Anggota belum punya kunci enkripsi (versi lama atau belum terlihat)');
    }
    const key = crypto.randomBytes(32).toString('base64');
    const members = [{ id: this.id, name: this.name }].concat(ids.map((id) => ({ id, name: this.peers.get(id).name })));
    const ts = this._tsNow();
    const g = {
      id: crypto.randomBytes(8).toString('hex'), name, creator: this.id, admins: [], ts,
      epoch: 0, eps: { 0: { key, members: members.map((x) => x.id), by: this.id, its: ts, top: 0 } }, members, removed: false, leaves: {},
    };
    const payload = JSON.stringify({ gid: g.id, name, members, key, ts: g.ts, epoch: 0, creator: this.id, admins: [], ets: ts });
    const invs = ids.map((id) => this._makeMsg(id, 'ginv', payload));
    this.store.groups[g.id] = g;
    for (const m of invs) { this.store.msgs[m.id] = m; this.store.status[m.id] = 'pending'; }
    this._save(); this.emit('update');
    this._kick(ids);
    return this._pubGroup(g);
  },
  // Pembuat atau admin (mengubah anggota, mengganti nama).
  _adminGroup(gid) {
    const g = this.store.groups[gid];
    if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
    if (!this._isAdminOf(g, this.id)) throw ek('e.group.adminOnly', null, 'Hanya pembuat grup dan admin yang bisa mengubah grup ini');
    if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
    return g;
  },
  // Hanya pembuat (atur admin, bubarkan).
  _ownerGroup(gid) {
    const g = this.store.groups[gid];
    if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
    if (g.creator !== this.id) throw ek('e.group.ownerOnly', null, 'Hanya pembuat grup yang bisa melakukan ini');
    if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
    return g;
  },
  // Setiap perubahan anggota/nama/admin/pemilik = epoch baru dengan kunci baru. Kunci lama tetap disimpan untuk membaca riwayat.
  // o.creator: pemilik baru (pemindahan); o.admins: daftar admin baru; o.lv: bukti keluar anggota yang dikeluarkan karena menyatakan keluar.
  _newEpoch(g, members, o = {}) {
    const key = crypto.randomBytes(32).toString('base64'), ets = this._tsNow(), top = g.creator === this.id ? 0 : 1;
    const creator = o.creator || g.creator;
    g.epoch += 1; g.members = members;
    g.admins = (o.admins || g.admins || []).filter((a) => a !== creator && members.some((x) => x.id === a));
    g.creator = creator;
    g.eps[g.epoch] = { key, members: members.map((x) => x.id), by: this.id, its: ets, top };
    const p = { gid: g.id, name: g.name, members, key, ts: g.ts, epoch: g.epoch, creator: g.creator, admins: g.admins, ets };
    if (o.lv && o.lv.length) p.lv = o.lv;
    // Foto grup (v0.26.0): bagian dari STATE grup (kelas primer, seperti nama dan admin), bukan berkas grup. Setiap epoch membawa foto terkini supaya anggota baru
    // dan anggota yang lama offline ikut mendapatnya lewat jalur `ginv` (dipegang kurir sampai ada tanda terima). Tanpa kolom `av` = tidak berubah
    // (pengirim versi lama); `av: ''` = foto dicabut. Bila muatan jadi terlalu besar untuk satu `ginv` (grup sangat besar), foto dilewati: penerima menyimpan foto lamanya.
    if (typeof g.av === 'string') { p.av = g.av; if (!this._epochFits(JSON.stringify(p))) delete p.av; }
    return JSON.stringify(p);
  },
  _epochFits(json) { return Math.ceil(Buffer.byteLength(json) * 4 / 3) + 96 <= MAX_CIPHER; }, // ciphertext = base64 + nonce/tag; batas sama dengan archne-util.js
  // Kirim payload epoch baru ke semua anggota lain (kecuali `skip`), lalu simpan dan bangunkan pengiriman.
  _sendEpoch(g, payload, skip) {
    const to = g.members.map((x) => x.id).filter((id) => id !== this.id && id !== skip);
    for (const id of to) { const m = this._makeMsg(id, 'ginv', payload); this.store.msgs[m.id] = m; this.store.status[m.id] = 'pending'; }
    return to;
  },
  addMembers(gid, memberIds) {
    const g = this._adminGroup(gid);
    const ids = [...new Set(memberIds || [])].filter((id) => id !== this.id && !g.members.some((x) => x.id === id));
    if (!ids.length) throw ek('e.group.pickMinNew', null, 'Pilih minimal 1 anggota baru');
    for (const id of ids) {
      const p = this.peers.get(id);
      if (this.isBlocked(id)) throw ek('e.group.blockedMember', null, 'Kamu memblokir salah satu anggota yang dipilih; buka blokirnya dulu');
      if (!p || !p.xpub) throw ek('e.group.noKey', null, 'Anggota belum punya kunci enkripsi (versi lama atau belum terlihat)');
    }
    const added = ids.map((id) => ({ id, name: this.peers.get(id).name }));
    const payload = this._newEpoch(g, g.members.concat(added));
    const to = this._sendEpoch(g, payload);
    for (const x of added) this._note(g.id, 'note.added', { name: x.name }, '{name} ditambahkan ke grup');
    this._save(); this.emit('update');
    this._kick(to);
    try { if (this._vcAnnounce(g)) this._kick(g.members.map((x) => x.id).filter((id) => id !== this.id)); } catch {} // anggota baru perlu tahu channel yang ada
    try { if (this._pinAnnounce(g)) this._kick(g.members.map((x) => x.id).filter((id) => id !== this.id)); } catch {} // ...dan sematan bersama yang ada
    return this._pubGroup(g);
  },
  // Pembuat boleh mengeluarkan siapa saja (kecuali dirinya); admin hanya anggota biasa (bukan pembuat atau admin lain).
  removeMember(gid, id) {
    const g = this._adminGroup(gid);
    if (id === g.creator) throw ek('e.group.creatorNoKick', null, 'Pembuat grup tidak bisa dikeluarkan');
    if (id === this.id) throw ek('e.group.selfKick', null, 'Kamu tidak bisa mengeluarkan dirimu sendiri');
    const gone = g.members.find((x) => x.id === id);
    if (!gone) throw ek('e.group.notMember', null, 'Bukan anggota grup ini');
    if (g.creator !== this.id && g.admins.includes(id)) throw ek('e.group.adminNoKickAdmin', null, 'Admin tidak bisa mengeluarkan admin lain; hanya pembuat grup');
    const rest = g.members.filter((x) => x.id !== id);
    const payload = this._newEpoch(g, rest);
    this._forgetPending(id); // batalkan semua yang masih tertahan untuk orang ini (undangan lama yang belum sampai, pesan grup)
    const to = this._sendEpoch(g, payload);
    const bye = this._makeMsg(id, 'ginv', JSON.stringify({ gid: g.id, epoch: g.epoch, removed: true, members: rest }));
    this.store.msgs[bye.id] = bye; this.store.status[bye.id] = 'pending';
    this._note(g.id, 'note.removed', { name: gone.name, by: this.name }, '{name} dikeluarkan dari grup oleh {by}');
    this._save(); this.emit('update');
    this._kick(to.concat(id));
    return this._pubGroup(g);
  },
  // Ganti nama grup (pembuat/admin). Grup dikenali lewat id acaknya (g.id), bukan namanya, jadi mengganti nama tidak memutus apa pun.
  renameGroup(gid, name) {
    const g = this._adminGroup(gid);
    name = this._cleanGroupName(name);
    if (!name) throw ek('e.group.nameEmpty', null, 'Nama grup kosong');
    if (name === g.name) return this._pubGroup(g);
    const old = g.name;
    g.name = name;
    const payload = this._newEpoch(g, g.members);
    const to = this._sendEpoch(g, payload);
    this._note(g.id, 'note.renamed', { who: this.name, old, name }, '{who} mengganti nama grup dari "{old}" menjadi "{name}"');
    this._save(); this.emit('update');
    this._kick(to);
    return this._pubGroup(g);
  },
  // Ganti / cabut foto grup (pembuat/admin). b64 = JPEG base64 (format dan batas yang sama dengan foto profil) atau '' untuk mencabut.
  // Foto ikut payload epoch (state primer, lihat _newEpoch), jadi mengganti foto = epoch baru dengan kunci baru, sama seperti mengganti nama.
  setGroupAvatar(gid, b64) {
    const g = this._adminGroup(gid);
    const av = String(b64 == null ? '' : b64).trim().replace(/^data:image\/jpeg;base64,/i, '');
    if (!this._validAvatar(av)) throw ek('e.group.avInvalid', { dim: AV_DIM, kb: Math.floor(AV_MAX * 3 / 4 / 1024) }, 'Foto tidak valid: harus JPEG maks {dim}x{dim} px dan {kb} KB');
    if ((g.av || '') === av) return this._pubGroup(g); // tidak berubah: tidak usah membuat epoch
    // Periksa muat-tidaknya SEBELUM mengubah apa pun (epoch tidak bisa dibatalkan setelah dibuat).
    const probe = JSON.stringify({ gid: g.id, name: g.name, members: g.members, key: 'k'.repeat(44), ts: g.ts, epoch: g.epoch + 1, creator: g.creator, admins: g.admins, ets: this._tsNow(), av });
    if (av && !this._epochFits(probe)) throw ek('e.group.avTooBig', null, 'Grup ini terlalu besar untuk memuat foto grup');
    g.av = av;
    const payload = this._newEpoch(g, g.members);
    const to = this._sendEpoch(g, payload);
    this._note(g.id, av ? 'note.avSet' : 'note.avDel', { who: this.name }, av ? '{who} mengganti foto grup' : '{who} menghapus foto grup');
    this._save(); this.emit('update');
    this._kick(to);
    return this._pubGroup(g);
  },
  // Jadikan / cabut admin (hanya pembuat).
  setAdmin(gid, id, on) {
    const g = this._ownerGroup(gid);
    const x = g.members.find((y) => y.id === id);
    if (!x) throw ek('e.group.notMember', null, 'Bukan anggota grup ini');
    if (id === g.creator) throw ek('e.group.creatorAllPow', null, 'Pembuat grup sudah punya semua wewenang');
    on = !!on;
    if (g.admins.includes(id) === on) return this._pubGroup(g);
    g.admins = on ? g.admins.concat(id) : g.admins.filter((a) => a !== id);
    const to = this._sendEpoch(g, this._newEpoch(g, g.members));
    this._note(g.id, on ? 'note.adminOn' : 'note.adminOff', { name: x.name }, on ? '{name} menjadi admin grup' : '{name} bukan admin lagi');
    this._save(); this.emit('update');
    this._kick(to);
    return this._pubGroup(g);
  },
  // Pindahkan kepemilikan ke anggota (admin atau anggota biasa). Pemilik lama tetap di grup sebagai admin. Hanya pemilik.
  transferOwner(gid, id) {
    const g = this._ownerGroup(gid);
    id = String(id);
    if (id === this.id) throw ek('e.group.alreadyOwner', null, 'Kamu sudah menjadi pemilik grup');
    const x = g.members.find((y) => y.id === id);
    if (!x) throw ek('e.group.notMember', null, 'Bukan anggota grup ini');
    if (g.leaves[id]) throw ek('e.group.alreadyLeft', null, 'Anggota ini sudah menyatakan keluar dari grup');
    const me = g.members.find((y) => y.id === this.id) || { id: this.id, name: this.name };
    const admins = g.admins.filter((a) => a !== id).concat(this.id);
    const payload = this._newEpoch(g, g.members, { creator: id, admins });
    const to = this._sendEpoch(g, payload);
    this._note(g.id, 'note.owner', { who: this.name, name: x.name }, '{who} menyerahkan kepemilikan grup kepada {name}');
    this._save(); this.emit('update');
    this._kick(to);
    return this._pubGroup(g);
  },
  // Keluar dari grup (anggota, admin, atau pemilik). Grup dan riwayatnya hilang dari perangkat ini; anggota lain menerima pernyataan keluar
  // yang ditandatangani (lewat DM terenkripsi dan kurir, jadi yang offline menerimanya belakangan), lalu pemilik/admin yang online
  // mengeluarkannya dari daftar dan mengganti kunci grup. Pemilik yang keluar menyerahkan kepemilikan dulu: ke `successor`, atau
  // otomatis ke admin tertua (kalau tidak ada admin: anggota tertua). Grup yang tinggal pemilik sendirian tidak bisa ditinggal: bubarkan saja.
  leaveGroup(gid, successor) {
    const g = this.store.groups[gid];
    if (!g) throw ek('e.group.unknown', null, 'Grup tidak dikenal');
    if (g.removed) throw ek('e.group.removed', null, 'Kamu sudah dikeluarkan dari grup ini');
    const others = g.members.filter((x) => x.id !== this.id && !g.leaves[x.id]);
    let transfer = null;
    if (g.creator === this.id) {
      if (!others.length) throw ek('e.group.noSuccessor', null, 'Tidak ada anggota lain untuk menerima kepemilikan. Bubarkan grup saja.');
      let s = successor ? String(successor) : null;
      if (s && !others.some((x) => x.id === s)) throw ek('e.group.badSuccessor', null, 'Penerima kepemilikan harus anggota grup ini');
      if (!s) s = (g.admins.find((a) => others.some((x) => x.id === a)) || others[0].id);
      transfer = this._newEpoch(g, g.members, { creator: s, admins: g.admins.filter((a) => a !== s).concat(this.id) });
    }
    const ep = g.epoch, ts = this._tsNow(), lv = { pub: this.pub, ep, ts, sig: this._signLeave(g.id, ep, ts) };
    const leave = JSON.stringify({ gid: g.id, epoch: ep, leave: true, lv, members: [{ id: this.id, name: this.name }] });
    const everyone = g.members.map((x) => x.id).filter((id) => id !== this.id);
    // Menghapus grup juga menghapus undangan lama (termasuk yang masih tertahan); pemberitahuan dibuat sesudahnya. left = ep+1: epoch
    // sebelum keluar yang masih di jalan tidak menghidupkan grup lagi, sedangkan penambahan ulang yang disengaja (epoch lebih baru) tetap bisa.
    this._purgeGroup(g, ep + 1);
    const sent = [];
    for (const id of everyone) { // pemindahan kepemilikan dulu, lalu pernyataan keluar (urutan ts = urutan kirim)
      try {
        if (transfer) { const t = this._makeMsg(id, 'ginv', transfer); this.store.msgs[t.id] = t; this.store.status[t.id] = 'pending'; }
        const m = this._makeMsg(id, 'ginv', leave); this.store.msgs[m.id] = m; this.store.status[m.id] = 'pending'; sent.push(id);
      } catch {} // tanpa kunci enkripsi: tidak ada jalan memberi tahu orang itu
    }
    this._save(); this.emit('update');
    this._kick(sent);
    return { ok: true, notified: sent.length };
  },
  // Bubarkan grup (hanya pembuat): grup hilang dari semua anggota (perangkat yang offline menerimanya begitu online lagi, lewat kurir/antrean).
  disbandGroup(gid) {
    const g = this._ownerGroup(gid);
    const epoch = g.epoch + 1, others = g.members.map((x) => x.id).filter((id) => id !== this.id);
    const payload = JSON.stringify({ gid: g.id, epoch, removed: true, disband: true, members: [{ id: this.id, name: this.name }] });
    this._purgeGroup(g, epoch); // menghapus undangan lama, termasuk yang masih tertahan; pemberitahuan dibuat sesudahnya
    const to = [];
    for (const id of others) {
      try { const m = this._makeMsg(id, 'ginv', payload); this.store.msgs[m.id] = m; this.store.status[m.id] = 'pending'; to.push(id); } catch {} // tanpa kunci enkripsi: tidak ada jalan memberi tahu
    }
    this._save(); this.emit('update');
    this._kick(to);
    return true;
  },
  _pubGroup(g) { return { id: g.id, name: g.name, creator: g.creator, admins: g.admins || [], members: g.members, epoch: g.epoch, removed: !!g.removed, leaving: Object.keys(g.leaves || {}).filter((id) => g.members.some((x) => x.id === id)) }; },
};
