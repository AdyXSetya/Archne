'use strict';
// src/core/archne-group-invite.js — epoch, keluar/reconcile, _acceptInvite
// Dipindah apa adanya dari src/archne-core.js (PLAN-RESTRUKTUR Step 1); method di-mixin ke Core.prototype (lihat archne-index.js).
const crypto = require('crypto');
const { BIO_BAD, HEX16, HLC_DRIFT, LEAVE_DELAY, LEAVE_STAGGER, LVTAG } = require('./archne-constants');
const { idFromPub } = require('./archne-util');

module.exports = {
  _cleanGroupName(n) {
    return Array.from(String(n == null ? '' : n).replace(new RegExp(BIO_BAD.source, 'g'), '').trim()).slice(0, 40).join('').trim();
  },
  // Prioritas bila dua admin membuat epoch yang sama bersamaan (angka lebih kecil menang): pemilik dulu, lalu yang lebih awal, lalu id.
  // `top` (0 = dibuat pemilik saat itu) disimpan di epoch-nya, bukan dihitung ulang dari g.creator, karena pemilik bisa berpindah tangan
  // dan semua perangkat harus tetap memilih pemenang yang sama apa pun urutan datangnya.
  _epRank(top, by, ets) { return [top, ets, by]; },
  _rankLess(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; },
  // ---- Keluar dari grup ----
  // Epoch paling awal (berurutan sampai sekarang) di mana `id` menjadi anggota: bukti keluar yang lebih tua dari ini sudah basi
  // (orangnya sempat dikeluarkan lalu ditambahkan lagi) dan tidak boleh dipakai ulang untuk mengeluarkannya lagi.
  _joinEpoch(g, id) {
    let join = 0, seen = false;
    for (let k = g.epoch; k >= 0; k--) {
      const e = g.eps[k];
      if (!e || !(e.members || []).includes(id)) break;
      join = k; seen = true;
    }
    return seen ? join : 0;
  },
  _signLeave(gid, ep, ts) {
    return crypto.sign(null, Buffer.from(LVTAG + gid + ':' + ep + ':' + ts), this.privKey).toString('base64');
  },
  // Bukti keluar { pub, ep, ts, sig } milik `id` untuk grup g. Hanya `id` sendiri yang bisa membuatnya (tanda tangan kunci identitasnya).
  _verifyLeave(g, id, lv) {
    try {
      if (!lv || typeof lv !== 'object' || typeof lv.pub !== 'string' || typeof lv.sig !== 'string') return false;
      if (!Number.isInteger(lv.ep) || lv.ep < 0 || lv.ep > 1e6 || !Number.isSafeInteger(lv.ts) || lv.ts <= 0) return false;
      if (lv.pub.length > 200 || lv.sig.length > 200 || idFromPub(lv.pub) !== id) return false;
      if (lv.ep < this._joinEpoch(g, id)) return false;
      const key = crypto.createPublicKey({ key: Buffer.from(lv.pub, 'base64'), format: 'der', type: 'spki' });
      return crypto.verify(null, Buffer.from(LVTAG + g.id + ':' + lv.ep + ':' + lv.ts), key, Buffer.from(lv.sig, 'base64'));
    } catch { return false; }
  },
  _cleanLv(g, list) { // bukti keluar dalam payload epoch -> Map(id -> bukti) yang sah
    const out = new Map();
    if (!Array.isArray(list)) return out;
    for (const lv of list.slice(0, 50)) {
      try { const id = idFromPub(lv.pub); if (!out.has(id) && this._verifyLeave(g, id, lv)) out.set(id, { pub: lv.pub, ep: lv.ep, ts: lv.ts, sig: lv.sig }); } catch {}
    }
    return out;
  },
  // Pemilik dan admin yang online secara berurutan mengeluarkan anggota yang sudah menyatakan keluar (kunci grup diganti supaya dia
  // tidak bisa membaca pesan baru). Pemilik langsung; admin menunggu giliran dan memeriksa lagi, jadi biasanya hanya satu epoch yang dibuat.
  _scheduleReconcile(g) {
    if (!g || g.removed || this.stopped || !this._isAdminOf(g, this.id) || this._lvT.has(g.id)) return;
    if (!Object.keys(g.leaves || {}).some((id) => g.members.some((x) => x.id === id))) return;
    const rank = g.creator === this.id ? 0 : 1 + Math.max(0, (g.admins || []).indexOf(this.id));
    const delay = (this.opts.leaveDelayMs !== undefined ? this.opts.leaveDelayMs : LEAVE_DELAY) + rank * (this.opts.leaveStaggerMs !== undefined ? this.opts.leaveStaggerMs : LEAVE_STAGGER);
    const t = setTimeout(() => {
      this._lvT.delete(g.id);
      if (this.stopped) return;
      try { this._reconcileLeaves(this.store.groups[g.id]); } catch (e) { this.log('reconcile ' + e.message); }
    }, delay);
    if (t.unref) t.unref();
    this._lvT.set(g.id, t);
  },
  _reconcileLeaves(g) {
    if (!g || g.removed || !this._isAdminOf(g, this.id)) return false;
    const gone = g.members.filter((x) => x.id !== this.id && x.id !== g.creator && g.leaves && g.leaves[x.id] && this._verifyLeave(g, x.id, g.leaves[x.id]));
    if (!gone.length) return false;
    const drop = new Set(gone.map((x) => x.id));
    const lv = gone.map((x) => { const l = g.leaves[x.id]; return { pub: l.pub, ep: l.ep, ts: l.ts, sig: l.sig }; });
    const payload = this._newEpoch(g, g.members.filter((x) => !drop.has(x.id)), { lv });
    for (const id of drop) { delete g.leaves[id]; this._forgetPending(id); }
    const to = this._sendEpoch(g, payload);
    this._save(); this.emit('update');
    this._kick(to);
    return true;
  },
  _forgetPending(id) { // batalkan yang masih tertahan untuk orang ini (undangan lama yang belum sampai, pesan grup)
    for (const [mid, st] of Object.entries(this.store.status)) {
      const m = this.store.msgs[mid];
      if (st === 'pending' && m && m.to === id && m.kind === 'ginv') this.store.status[mid] = 'cancelled';
    }
    for (const gs of Object.values(this.store.gstatus)) if (gs[id] === 'pending') delete gs[id];
  },
  // Undangan/pembaruan grup (kind ginv). Wewenang:
  //  - pembuat: semua (tambah/keluarkan, ganti nama, atur admin, bubarkan);
  //  - admin: tambah anggota, ganti nama, mengeluarkan anggota biasa. Tidak boleh mengubah daftar admin atau mengeluarkan pembuat/admin lain.
  // Aturan ini diperiksa lagi di sisi penerima (pengirim yang dimodifikasi tidak dipercaya).
  _acceptInvite(m) {
    try {
      const j = JSON.parse(this._open(m));
      if (!HEX16.test(String(j.gid)) || !Array.isArray(j.members) || j.members.length > 200) return false;
      const members = j.members.map((x) => ({ id: String(x.id), name: String(x.name || '?').slice(0, 32) }));
      if (!members.every((x) => HEX16.test(x.id)) || !members.some((x) => x.id === m.from)) return false;
      const epoch = j.epoch === undefined ? 0 : j.epoch;
      if (!Number.isInteger(epoch) || epoch < 0 || epoch > 1e6) return false;
      const g = this.store.groups[j.gid], me = this.id;
      const nameOf = (id, list) => ((list || []).find((x) => x.id === id) || {}).name || '?';
      const ids = members.map((x) => x.id);

      if (j.leave === true) { // pengirim menyatakan keluar dari grup (bukti bertanda tangan, tanpa kunci baru)
        if (!g || g.removed) return false;
        if (!g.members.some((x) => x.id === m.from)) return true; // sudah bukan anggota di catatanku: tidak ada yang perlu dikerjakan
        if (!this._verifyLeave(g, m.from, j.lv)) return false;
        if (!g.leaves[m.from]) {
          const lv = j.lv;
          g.leaves[m.from] = { pub: lv.pub, ep: lv.ep, ts: lv.ts, sig: lv.sig, noted: m.from !== g.creator };
          if (m.from !== g.creator) this._note(g.id, 'note.left', { name: nameOf(m.from, g.members) }, '{name} keluar dari grup'); // pemilik: catatannya dibuat saat kepemilikan berpindah
          this._save(); this.emit('update');
        }
        this._scheduleReconcile(g);
        return true;
      }

      if (j.removed === true) { // pemberitahuan dikeluarkan / grup dibubarkan (tanpa kunci baru)
        if (!g) return false;
        if (j.disband === true) { // bubarkan: hanya pembuat
          if (g.creator !== m.from) return false;
          const by = nameOf(m.from, g.members), name = g.name;
          this.log(`grup ${name} (${g.id}) dibubarkan oleh ${by}`);
          this._purgeGroup(g, Math.max(epoch, g.epoch + 1));
          this.emit('removed', { name, by, disband: true });
          return true;
        }
        if (!this._isAdminOf(g, m.from) || ids.includes(me)) return false;
        if (m.from !== g.creator && this._isAdminOf(g, me)) return false; // admin tidak bisa mengeluarkan pembuat atau admin lain
        if (epoch > g.epoch) {
          const by = nameOf(m.from, g.members), name = g.name;
          this.log(`dikeluarkan dari grup ${name} (${g.id}), grup dihapus dari perangkat ini`);
          this._purgeGroup(g, epoch);
          this.emit('removed', { name, by });
        }
        return true;
      }

      const key = Buffer.from(String(j.key), 'base64');
      if (key.length !== 32 || !ids.includes(me)) return false;
      const kb = key.toString('base64');
      const cleanAdm = (list, creator) => [...new Set(list.map(String).filter((x) => HEX16.test(x) && ids.includes(x) && x !== creator))].slice(0, 50);
      const adm = Array.isArray(j.admins) ? j.admins : null; // null = pengirim versi lama: peran tidak berubah
      const ets = Number.isSafeInteger(j.ets) && j.ets > 0 && j.ets <= this._wall() + HLC_DRIFT ? j.ets : m.ts;
      const gname = this._cleanGroupName(j.name);
      const gav = typeof j.av === 'string' && this._validAvatar(j.av) ? j.av : undefined; // foto grup (v0.26.0): undefined = tidak berubah / tidak valid (epoch tetap diterima)
      if (!g) {
        const creator = HEX16.test(String(j.creator)) ? j.creator : m.from;
        const admins = cleanAdm(adm || [], creator);
        if (!ids.includes(creator) || !(m.from === creator || admins.includes(m.from))) return false;
        const left = this.store.left[j.gid];
        if (left !== undefined && epoch <= left) return false; // undangan lama untuk grup yang sudah dikeluarkan darinya
        delete this.store.left[j.gid];
        this.store.groups[j.gid] = {
          id: j.gid, name: gname || 'Grup', creator, admins, ts: Number(j.ts) || m.ts,
          epoch, eps: { [epoch]: { key: kb, members: ids, by: m.from, its: ets, top: m.from === creator ? 0 : 1 } }, members, removed: false, leaves: {},
        };
        if (gav !== undefined) this.store.groups[j.gid].av = gav;
        this._note(j.gid, 'note.youAdded', { by: nameOf(m.from, members) }, 'Kamu ditambahkan ke grup oleh {by}');
        this.log(`masuk grup ${j.name} (${j.gid})`);
        this._resync();
        return true;
      }
      const byOwner = g.creator === m.from;
      if (!byOwner && !(g.admins || []).includes(m.from)) return false; // hanya pemilik/admin yang boleh mengubah anggota/kunci/nama
      const newCreator = j.creator === undefined ? g.creator : (HEX16.test(String(j.creator)) ? String(j.creator) : null);
      if (!newCreator) return false;
      const transfer = newCreator !== g.creator; // pemindahan kepemilikan
      const top = byOwner ? 0 : 1;
      const lvm = this._cleanLv(g, j.lv); // bukti keluar yang ikut dalam epoch ini
      const proven = (id) => lvm.has(id) || (!!g.leaves[id] && this._verifyLeave(g, id, g.leaves[id]));
      if (transfer) {
        if (!byOwner) { // admin yang belum tahu kepemilikan sudah berpindah (epoch-nya bertabrakan dengan pemindahan): simpan kuncinya saja
          if (epoch > g.epoch) return false;
          const ex0 = g.eps[epoch];
          if (!ex0) { g.eps[epoch] = { key: kb, members: ids, by: m.from, its: ets, top }; this._resync(); }
          else if (ex0.key !== kb) ex0.alt = [...new Set((ex0.alt || []).concat(kb))].filter((k) => k !== ex0.key).slice(-4);
          this._save();
          return true;
        }
        // hanya pemilik yang boleh memindahkan, dan hanya ke anggota yang sudah ada
        if (!ids.includes(newCreator) || !g.members.some((x) => x.id === newCreator)) return false;
      } else if (!ids.includes(g.creator)) return false; // pemilik tidak bisa dikeluarkan
      const admins = adm === null ? g.admins.filter((a) => ids.includes(a) && a !== newCreator) : cleanAdm(adm, newCreator);
      if (!byOwner) {
        // admin tidak boleh mengubah peran atau mengeluarkan admin lain, kecuali admin itu sendiri sudah menyatakan keluar (bukti bertanda tangannya)
        if (g.admins.some((a) => !ids.includes(a) && !proven(a))) return false;
        const expect = g.admins.filter((a) => ids.includes(a));
        if (admins.length !== expect.length || !admins.every((a) => expect.includes(a))) return false;
      }
      let changed = false, apply = epoch > g.epoch;
      const ex = g.eps[epoch];
      if (!ex) { g.eps[epoch] = { key: kb, members: ids, by: m.from, its: ets, top }; changed = true; } // kunci epoch lama yang terlewat tetap disimpan
      else if (ex.key !== kb) { // dua admin membuat epoch yang sama bersamaan: satu pemenang yang pasti sama di semua perangkat
        const alt = ex.alt = ex.alt || [];
        const exTop = ex.top !== undefined ? ex.top : (ex.by === g.creator ? 0 : 1);
        const theirsWins = ex.its !== undefined && this._rankLess(this._epRank(top, m.from, ets), this._epRank(exTop, ex.by || '', ex.its));
        if (theirsWins) {
          alt.push(ex.key);
          Object.assign(ex, { key: kb, members: ids, by: m.from, its: ets, top });
          if (epoch === g.epoch) apply = true;
        } else alt.push(kb);
        ex.alt = [...new Set(alt)].filter((k) => k !== ex.key).slice(-4);
        changed = true;
      }
      if (apply) {
        const old = g.members, actor = nameOf(m.from, members.concat(old));
        for (const x of members) if (!old.some((o) => o.id === x.id)) this._note(g.id, 'note.added', { name: x.name }, '{name} ditambahkan ke grup');
        for (const o of old) {
          if (ids.includes(o.id)) continue;
          const lf = g.leaves[o.id];
          if (lf) { if (!lf.noted) this._note(g.id, 'note.left', { name: o.name }, '{name} keluar dari grup'); } // sudah dicatat saat pernyataan keluarnya diterima
          else if (lvm.has(o.id)) this._note(g.id, 'note.left', { name: o.name }, '{name} keluar dari grup');
          else this._note(g.id, 'note.removed', { name: o.name, by: actor }, '{name} dikeluarkan dari grup oleh {by}');
        }
        if (transfer) this._note(g.id, 'note.owner', { who: actor, name: nameOf(newCreator, members) }, '{who} menyerahkan kepemilikan grup kepada {name}');
        for (const a of admins) if (!g.admins.includes(a) && !(transfer && a === g.creator)) this._note(g.id, 'note.adminOn', { name: nameOf(a, members) }, '{name} menjadi admin grup');
        for (const a of g.admins) if (!admins.includes(a) && ids.includes(a) && a !== newCreator) this._note(g.id, 'note.adminOff', { name: nameOf(a, members) }, '{name} bukan admin lagi');
        if (gname && gname !== g.name) this._note(g.id, 'note.renamed', { who: actor, old: g.name, name: gname }, '{who} mengganti nama grup dari "{old}" menjadi "{name}"');
        g.epoch = epoch; g.members = members; g.admins = admins; g.removed = false; g.creator = newCreator;
        for (const k of Object.keys(g.leaves)) if (!ids.includes(k)) delete g.leaves[k];
        if (gname) g.name = gname;
        if (gav !== undefined && gav !== (g.av || '')) { // foto grup berubah (hanya dari epoch pemenang yang diterapkan; pengirimnya sudah dipastikan pemilik/admin di atas)
          this._note(g.id, gav ? 'note.avSet' : 'note.avDel', { who: actor }, gav ? '{who} mengganti foto grup' : '{who} menghapus foto grup');
          g.av = gav;
        } else if (gav !== undefined && g.av === undefined) g.av = gav;
        changed = true;
      }
      if (changed) { this._resync(); this._scheduleReconcile(g); }
      return true;
    } catch { return false; }
  },
};
