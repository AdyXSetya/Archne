'use strict';
// Reaksi pada postingan Halaman (tahap 4a-1). Murni lokal: tanpa jaringan, tanpa UI, tanpa Core. Dipakai PageStore (react / reactionsFor).
// PEMILIK halaman adalah satu-satunya penentu: penonton mengirim keadaan yang diinginkan (4a-3), pemilik yang mencatat. Karena itu tidak perlu HLC lintas perangkat:
// ts = jam pemilik, dinaikkan bila perlu supaya perubahan baru selalu menang atas register orang yang sama (cur.ts + 1).
// Aturan dipakai ulang dari src/archne-reactions.js (reaksi chat): satu orang satu reaksi per sasaran, emoji kanonis (cleanEmoji), register LWW dengan tombstone,
// batas 256 orang per sasaran (RX_MAX_REG_PER_MSG), total 5000 register (RX_MAX_STORE, tombstone dibuang dulu), tampilan terbanyak dulu maks RX_SHOW_MAX jenis.
// archne-reactions.js menuntut kunci sasaran 32 heks (id pesan chat), sedangkan id postingan 16 heks: kuncinya diturunkan key(id) = id + id (deterministik, satu-satu).
// Berkas <dir>/reactions.json = { v: 1, map } (ditulis atomik oleh penulis yang diberikan PageStore). Bukan sumber kebenaran postingan: isinya dibersihkan (RX.clean) saat dibuka,
// dan reaksi yang postingannya sudah tidak ada dibuang (retain). Rusak / tak terbaca = mulai kosong.
// 5g: reaksi komentar ada di kelas PageCmtRx (bawah), berkas terpisah.
// Tampilan untuk penonton hanya { rx: [{ e, n }], mine }: daftar pelaku (`by`) TIDAK keluar lewat view(). Satu-satunya jalan keluarnya daftar pelaku adalah owner() (4a-7), yang hanya dipanggil untuk pemilik (PageStore.ownerRx).
const fs = require('fs');
const RX = require('./archne-reactions');
const { ek } = require('./core/archne-ecode'); // i18n (E7)
const HEX16 = /^[0-9a-f]{16}$/;
const key = (postId) => postId + postId;

class PageRx {
  constructor(file, write) {
    this.file = file;
    this.write = typeof write === 'function' ? write : (f, s) => { fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); };
    this.map = {};
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === 1) this.map = RX.clean(j.map); } catch {}
  }
  _save() { this.write(this.file, JSON.stringify({ v: 1, map: this.map })); }

  // Pasang keadaan reaksi `by` pada postingan: e = emoji, atau '' = cabut. Idempotent (keadaan sama = 'same', tanpa tulis). Mengembalikan 'applied' | 'same'.
  // Melempar Error: id tidak sah, emoji tidak sah, atau postingan sudah penuh (256 orang). Izin melihat postingan BUKAN urusan modul ini (PageStore).
  set(by, postId, e, now) {
    if (!HEX16.test(String(by)) || !HEX16.test(String(postId))) throw new Error('Id tidak valid');
    const em = e === '' ? '' : RX.cleanEmoji(e);
    if (em === null) throw new Error('Emoji tidak valid');
    const k = key(postId), cur = this.map[k] && this.map[k][by];
    if ((cur ? cur.e : '') === em) return 'same'; // tanpa register sama dengan cabut: tidak membuat tombstone
    const ts = Math.max(Number.isSafeInteger(now) && now >= 0 ? now : Date.now(), cur ? cur.ts + 1 : 0);
    if (RX.applyRemote(this.map, by, { m: k, e: em, ts }, {}) !== 'applied') throw ek('e.pg.rxFullPost', null, 'Terlalu banyak reaksi pada postingan ini');
    RX.prune(this.map);
    this._save();
    return 'applied';
  }
  // { rx: [{ e, n }], mine } untuk penonton `me` (id terbukti). mine = reaksiku sekarang ('' = tidak ada).
  view(postId, me) {
    const k = key(postId);
    return { rx: RX.summary(this.map, k, me).map((x) => ({ e: x.e, n: x.n })), mine: RX.mineOf(this.map, k, me) };
  }
  // 4a-7, KHUSUS PEMILIK: { rx, mine, who } dengan rx / mine sama dengan view(postId, me) dan who = [{ e, by: [id] }] sejajar rx (urutan sama, pelaku terlama dulu). Penonton tidak pernah memanggil ini.
  owner(postId, me) {
    const k = key(postId), s = RX.summary(this.map, k, me);
    return { rx: s.map((x) => ({ e: x.e, n: x.n })), mine: RX.mineOf(this.map, k, me), who: s.map((x) => ({ e: x.e, by: x.by.slice() })) };
  }
  // Pembuangan: satu postingan dihapus; atau semua yang postingannya tidak lolos has(id). Menulis hanya bila ada yang berubah.
  drop(postId) { if (this.map[key(postId)]) { RX.dropMsg(this.map, key(postId)); this._save(); } }
  retain(has) {
    const n = RX.retain(this.map, (k) => k.slice(0, 16) === k.slice(16) && has(k.slice(0, 16)));
    if (n) this._save();
    return n;
  }
}

// 5g: reaksi pada KOMENTAR. Berkas terpisah (<dir>/cmtreactions.json, bentuk sama { v: 1, map }) supaya reactions.json postingan tidak berubah sama sekali dan batas 5000 register dihitung sendiri.
// Aturan sama dengan PageRx (satu orang satu reaksi per komentar, LWW + tombstone, 256 orang per komentar, tampilan penonton hanya { rx, mine }, daftar pelaku hanya lewat owner*()).
// Kunci sasaran = postId + cid (32 heks; dua id berbeda, jadi tidak pernah bentrok dengan kunci postingan id + id). Izin dan keberadaan komentar BUKAN urusan modul ini (PageStore).
const ckey = (postId, cid) => postId + cid;
class PageCmtRx {
  constructor(file, write) {
    this.file = file;
    this.write = typeof write === 'function' ? write : (f, s) => { fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); };
    this.map = {};
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === 1) this.map = RX.clean(j.map); } catch {}
  }
  _save() { this.write(this.file, JSON.stringify({ v: 1, map: this.map })); }
  // Pasang keadaan reaksi `by` pada komentar: e = emoji, '' = cabut. -> 'applied' | 'same'. Melempar Error: id / emoji tak sah, atau komentar penuh (256 orang).
  set(by, postId, cid, e, now) {
    if (![by, postId, cid].every((x) => HEX16.test(String(x)))) throw new Error('Id tidak valid');
    const em = e === '' ? '' : RX.cleanEmoji(e);
    if (em === null) throw new Error('Emoji tidak valid');
    const k = ckey(postId, cid), cur = this.map[k] && this.map[k][by];
    if ((cur ? cur.e : '') === em) return 'same';
    const ts = Math.max(Number.isSafeInteger(now) && now >= 0 ? now : Date.now(), cur ? cur.ts + 1 : 0);
    if (RX.applyRemote(this.map, by, { m: k, e: em, ts }, {}) !== 'applied') throw ek('e.pg.rxFullCmt', null, 'Terlalu banyak reaksi pada komentar ini');
    RX.prune(this.map);
    this._save();
    return 'applied';
  }
  view(postId, cid, me) {
    const k = ckey(postId, cid);
    return { rx: RX.summary(this.map, k, me).map((x) => ({ e: x.e, n: x.n })), mine: RX.mineOf(this.map, k, me) };
  }
  // KHUSUS PEMILIK: { rx, mine, who } (who sejajar rx, pelaku terlama dulu).
  owner(postId, cid, me) {
    const k = ckey(postId, cid), s = RX.summary(this.map, k, me);
    return { rx: s.map((x) => ({ e: x.e, n: x.n })), mine: RX.mineOf(this.map, k, me), who: s.map((x) => ({ e: x.e, by: x.by.slice() })) };
  }
  // Keadaan untuk banyak komentar sekaligus (satu halaman pg_cml): { cid: { rx, mine[, who] } } HANYA untuk komentar yang punya reaksi (atau yang kureaksi). withWho = true hanya untuk pemilik.
  many(postId, cids, me, withWho) {
    const out = {};
    for (const cid of cids) {
      if (!HEX16.test(String(cid))) continue;
      const v = withWho ? this.owner(postId, cid, me) : this.view(postId, cid, me);
      if (v.rx.length || v.mine) out[cid] = v;
    }
    return out;
  }
  drop(postId, cid) { const k = ckey(postId, cid); if (this.map[k]) { RX.dropMsg(this.map, k); this._save(); } }
  dropPost(postId) { let n = 0; for (const k of Object.keys(this.map)) if (k.slice(0, 16) === postId) { RX.dropMsg(this.map, k); n++; } if (n) this._save(); return n; }
  retain(has) { const n = RX.retain(this.map, (k) => has(k.slice(0, 16), k.slice(16))); if (n) this._save(); return n; }
}

module.exports = { PageRx, PageCmtRx, key, ckey };
