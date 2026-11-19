'use strict';
// src/core/archne-pages-rx.js — Halaman 4a-3: PEMILIK menerima reaksi penonton lewat pg_rx { id, e } (e = emoji, '' = cabut).
// Lewat _handle -> _pgGate (tanda tangan menutup id dan e, jam +-2 mnt, nonce di penampung SENDIRI) -> _pgHandle -> sini. Identitas = rid TERBUKTI.
// Balasan: { t:'pg_rx', ok:true, r:{ rx:[{e,n}], mine } | null }. r null = postingan tidak ada / bukan untukmu / peminta diblokir / postingan sudah penuh (256 orang) / folder halaman belum ada: tak dibedakan.
// Urutan jawaban: bentuk salah ('bad') -> laju ('busy') -> relasi. Dua yang pertama tidak bergantung pada relasi, jadi tak bisa dipakai menebak postingan Teman atau blokir.
// Laju: RX_RATE_RECV per peer terbukti (jendela tetap, dipakai ulang dari reaksi chat) + satu batas global kecil, supaya banyak identitas baru tidak bisa membanjiri penulisan reactions.json.
const fs = require('fs');
const RX = require('../archne-reactions');
const { HEX16 } = require('./archne-constants');
const { pgErr } = require('./archne-pgerr');
const { ek } = require('./archne-ecode');
const { wireRxState } = require('../archne-pagestore');
const PG_RX_ALL = { max: 300, windowMs: 10e3 };

module.exports = {
  _pgRxHandle(o, rid) {
    const bad = { t: 'pg_rx', ok: false, err: 'bad' };
    if (typeof o.id !== 'string' || !HEX16.test(o.id) || typeof o.e !== 'string' || (o.e !== '' && RX.cleanEmoji(o.e) === null)) return bad;
    const lim = this._pgRxLim || (this._pgRxLim = { peer: RX.limiter(RX.RX_RATE_RECV), all: RX.limiter(PG_RX_ALL, 1) }), now = Date.now();
    if (!lim.peer.take(rid || '-', 1, now) || !lim.all.take('*', 1, now)) return { t: 'pg_rx', ok: false, err: 'busy' }; // peer dulu: yang melebihi jatahnya sendiri tidak memakan jatah global
    const ps = this._pgServePs(); // jangan membuat folder hanya karena ada yang bereaksi
    let r = null;
    if (ps) { try { r = ps.react(rid, o.id, o.e); } catch (e) { r = null; this.opts.log('pg_rx: ' + e.message); } } // penuh / gagal tulis: tampak sama dengan "tidak ada"
    if (r) this.emit('pgact', { post: o.id, kind: 'rx' }); // 5d-8 (lokal)
    return { t: 'pg_rx', ok: true, r };
  },

  // 5g: PEMILIK menerima reaksi penonton pada satu komentar lewat pg_rc { id, cid, e } (caps 'pgk'). Lewat _pgGate (tanda tangan menutup id, cid, e) -> sini; identitas = rid TERBUKTI.
  // Balasan: { t:'pg_rc', ok:true, r:{ rx, mine } | null }. r null = postingan tak terlihat / komentar tidak ada / diblokir / komentar sudah penuh (256 orang) / folder halaman belum ada: tak dibedakan.
  // Urutan: bentuk ('bad') -> laju ('busy', ember yang sama dengan pg_rx: satu peer tidak mendapat jatah ganda) -> relasi. Dua yang pertama tidak bergantung pada relasi.
  _pgRcHandle(o, rid) {
    const bad = { t: 'pg_rc', ok: false, err: 'bad' };
    if (typeof o.id !== 'string' || !HEX16.test(o.id) || typeof o.cid !== 'string' || !HEX16.test(o.cid) || typeof o.e !== 'string' || (o.e !== '' && RX.cleanEmoji(o.e) === null)) return bad;
    const lim = this._pgRxLim || (this._pgRxLim = { peer: RX.limiter(RX.RX_RATE_RECV), all: RX.limiter(PG_RX_ALL, 1) }), now = Date.now();
    if (!lim.peer.take(rid || '-', 1, now) || !lim.all.take('*', 1, now)) return { t: 'pg_rc', ok: false, err: 'busy' };
    const ps = this._pgServePs();
    let r = null;
    if (ps) { try { r = ps.reactComment(rid, o.id, o.cid, o.e); } catch (e) { r = null; this.opts.log('pg_rc: ' + e.message); } }
    if (r) this.emit('pgact', { post: o.id, kind: 'rx' });
    return { t: 'pg_rc', ok: true, r };
  },

  // 5g: reaksi pada komentar (peminta). pageReactComment(peerId, postId, cid, e) -> { rx, mine } SESUDAH perubahan, atau null (tidak ada / bukan untukku / diblokir / komentar penuh: tak dibedakan).
  // e = emoji atau '' (cabut); dikanonkan dulu, yang tak sah = 'bad' tanpa jaringan. peerId = id sendiri: lokal tanpa jaringan. Pemilik yang hello-nya sudah dikenal tanpa 'pgk' = 'old' (pesan khusus); jawaban cacat / mine != emoji kita = 'proto'.
  async pageReactComment(peerId, postId, cid, e) {
    if (![peerId, postId, cid].every((x) => typeof x === 'string' && HEX16.test(x)) || typeof e !== 'string') throw pgErr('bad');
    const em = e === '' ? '' : RX.cleanEmoji(e);
    if (em === null) throw pgErr('bad');
    if (peerId === this.id) { try { return (this._pages || fs.existsSync(this._pagesDir())) ? this.pageStore().reactComment(this.id, postId, cid, em) : null; } catch { return null; } }
    const a = this.pageAvail(peerId);
    if (!a.ok) throw pgErr(a.why);
    const p = this.peers.get(peerId);
    if (Array.isArray(p.caps) && !p.caps.includes('pgk')) throw ek('e.pg.oldCmtRx', null, 'Aplikasi pemilik belum mendukung reaksi pada komentar.', 'old');
    const r = await this._pgAsk(peerId, { t: 'pg_rc', id: postId, cid, e: em }, 10000);
    if (r.r == null) return null;
    const w = wireRxState(r.r);
    if (!w || w.mine !== em) throw pgErr('proto');
    return w;
  },
};
