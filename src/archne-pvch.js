'use strict';
// Channel voice publik (v0.20.0, langkah 1 / pvch1): model data dan aturan. Murni: tanpa jaringan, tanpa UI, tidak menyentuh voice grup.
// Disimpan sebagai peta { [cid]: { id, name, by, locked, salt, hash, ts, v, del } }.
//   by     = pemilik channel (penanda tangan pesan). Hanya dia yang boleh hapus, ganti nama, kunci/buka, dan ganti PIN.
//   locked = true -> orang lain harus mengetik PIN 6 angka. salt+hash = pemeriksa PIN (scrypt), ikut disebar supaya anggota di dalam
//            bisa memeriksa tanpa pemilik online. Hanya 1 juta kemungkinan PIN: ini "pintu berkunci" di LAN, bukan rahasia kriptografis.
//   v      = versi naik tiap perubahan; del = tombstone supaya pesan lama tidak menghidupkan channel lagi.
const crypto = require('crypto');
const Vc = require('./archne-vchan'); // aturan nama dipakai ulang
const { ek } = require('./core/archne-ecode'); // i18n (E9e)

const HEX16 = /^[0-9a-f]{16}$/, HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/;
const PV_MAX_LIVE = 200;        // channel hidup (terlihat) di seluruh jaringan
const PV_MAX_PER_OWNER = 3;     // channel hidup per pemilik
const PV_MAX_DEAD = 500;        // tombstone yang disimpan
const PV_MAX_OWNER_DEAD = 20;   // tombstone per pemilik (satu identitas tidak bisa membilas tombstone orang lain)
const PV_MAX_MEMBERS = 16;      // orang per channel (mesh audio: tiap orang mengirim ke semua yang lain)
const PV_PIN_LEN = 6;
const PV_MAX_PER_MSG = 10;      // rekaman per pesan kontrol
const PV_MAX_V = 1000000;
const ID_PREFIX = 10;           // 10 hex pertama ID channel = 10 hex pertama ID pemilik (lihat newId)
const SCRYPT = { N: 16384, r: 8, p: 1 };

const cleanName = Vc.cleanName;
const validPin = (p) => typeof p === 'string' && /^[0-9]{6}$/.test(p);
function needPin(p) { if (!validPin(p)) throw ek('e.pv.pin', { len: PV_PIN_LEN }, 'PIN harus {len} angka'); return p; }

// ---- ID channel: awalan = awalan ID pemilik, jadi orang lain tidak bisa menyalin ID channel baru lalu mengaku pemiliknya ----
// (ID pengguna = hash kunci publik, jadi mencari ID dengan awalan yang sama tidak praktis.)
const newId = (by) => String(by).slice(0, ID_PREFIX) + crypto.randomBytes(3).toString('hex');
const idOwnedBy = (cid, by) => HEX16.test(String(cid)) && HEX16.test(String(by)) && String(cid).slice(0, ID_PREFIX) === String(by).slice(0, ID_PREFIX);

// ---- PIN ----
const hashPin = (cid, salt, pin) => crypto.scryptSync(cid + ':' + pin, Buffer.from(salt, 'hex'), 32, SCRYPT).toString('hex');
function makeLock(cid, pin) {
  needPin(pin);
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPin(cid, salt, pin) };
}
// true bila PIN cocok (perbandingan waktu-konstan). Channel tanpa kunci: selalu true.
function checkPin(ch, pin) {
  if (!ch || ch.del) return false;
  if (!ch.locked) return true;
  if (!validPin(pin)) return false;
  const a = Buffer.from(hashPin(ch.id, ch.salt, pin), 'hex'), b = Buffer.from(ch.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- tampilan: hanya PV_MAX_PER_OWNER pertama (urut ID) per pemilik yang terlihat, jadi hasilnya sama di semua node walau pesan datang acak ----
function live(map) {
  const per = {}, out = [];
  for (const c of Object.values(map || {}).filter((x) => !x.del).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    per[c.by] = (per[c.by] || 0) + 1;
    if (per[c.by] <= PV_MAX_PER_OWNER) out.push(c);
  }
  return out;
}
const storedLiveBy = (map, id) => Object.values(map || {}).filter((c) => !c.del && c.by === id).length;

// ---- hak akses ----
const isOwner = (ch, id) => !!ch && !ch.del && ch.by === id;
const canManage = isOwner; // hapus, ganti nama, kunci/buka, ganti PIN
const canCreate = (map, id) => HEX16.test(String(id)) && live(map).length < PV_MAX_LIVE && storedLiveBy(map, id) < PV_MAX_PER_OWNER;
const needsPin = (ch, id) => !!ch && !ch.del && ch.locked && ch.by !== id;
const hasRoom = (count) => Number.isInteger(count) && count < PV_MAX_MEMBERS;
// Boleh masuk? Pemilik selalu; channel gratis siapa saja; channel terkunci hanya dengan PIN benar. (Kapasitas: pakai hasRoom.)
const canJoin = (ch, id, pin) => !!ch && !ch.del && HEX16.test(String(id)) && (ch.by === id || !ch.locked || checkPin(ch, pin));

// ---- operasi pemilik (mengubah map, mengembalikan channel). cid dan ts disuplai pemanggil supaya mudah diuji. ----
function create(map, by, cid, name, pin, ts) {
  if (!HEX16.test(String(by))) throw new Error('ID pemilik tidak valid');
  if (!idOwnedBy(cid, by)) throw new Error('ID channel tidak valid');
  if (map[cid]) throw new Error('ID channel sudah ada');
  if (live(map).length >= PV_MAX_LIVE) throw ek('e.pv.full', { max: PV_MAX_LIVE }, 'Channel publik sudah penuh (maksimal {max})');
  if (storedLiveBy(map, by) >= PV_MAX_PER_OWNER) throw ek('e.pv.mine', { max: PV_MAX_PER_OWNER }, 'Kamu sudah punya {max} channel. Hapus salah satu dulu');
  const lock = pin == null || pin === '' ? null : makeLock(cid, pin);
  const ch = { id: cid, name: cleanName(name), by, locked: !!lock, salt: lock ? lock.salt : '', hash: lock ? lock.hash : '', ts, v: 1, del: false };
  map[cid] = ch;
  prune(map);
  return ch;
}
function remove(map, by, cid, ts) {
  const ch = map[cid];
  if (!ch || ch.del) throw ek('e.vc.gone', null, 'Channel tidak ditemukan');
  if (!canManage(ch, by)) throw ek('e.pv.delOwner', null, 'Hanya pemilik channel yang boleh menghapusnya');
  ch.del = true; ch.v++; ch.ts = ts;
  prune(map);
  return ch;
}
// patch.name: ganti nama. patch.pin: string 6 angka = kunci/ganti PIN; null = buka kunci; undefined = tidak diubah.
function update(map, by, cid, patch, ts) {
  const ch = map[cid];
  if (!ch || ch.del) throw ek('e.vc.gone', null, 'Channel tidak ditemukan');
  if (!canManage(ch, by)) throw ek('e.pv.editOwner', null, 'Hanya pemilik channel yang boleh mengubahnya');
  const n = {};
  if (patch.name !== undefined) n.name = cleanName(patch.name);
  if (patch.pin !== undefined) {
    if (patch.pin === null) Object.assign(n, { locked: false, salt: '', hash: '' });
    else Object.assign(n, { locked: true }, makeLock(cid, patch.pin));
  }
  Object.assign(ch, n); ch.v++; ch.ts = ts;
  return ch;
}
// Buang tombstone: per pemilik paling banyak PV_MAX_OWNER_DEAD (yang terbaru), lalu total PV_MAX_DEAD. Channel hidup tidak pernah dibuang.
function prune(map) {
  const dead = Object.values(map).filter((c) => c.del).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
  const per = {};
  const keep = [];
  for (const c of dead) {
    per[c.by] = (per[c.by] || 0) + 1;
    if (per[c.by] > PV_MAX_OWNER_DEAD) delete map[c.id]; else keep.push(c);
  }
  for (const c of keep.slice(PV_MAX_DEAD)) delete map[c.id];
}

// Bersihkan satu rekaman (dari disk atau jaringan; isinya tidak dipercaya). null = tidak sah.
function cleanRec(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (typeof c.id !== 'string' || typeof c.by !== 'string') return null; // String([x]) === x akan meloloskan array berisi satu ID
  if (!HEX16.test(c.by) || !idOwnedBy(c.id, c.by)) return null;
  let name; try { name = cleanName(c.name); } catch { return null; }
  const locked = c.locked === true;
  if (locked && !(HEX32.test(String(c.salt)) && HEX64.test(String(c.hash)))) return null; // terkunci tanpa pemeriksa PIN yang sah = rusak
  if (!Number.isInteger(c.v) || c.v < 1 || c.v > PV_MAX_V) return null;
  return { id: c.id, name, by: c.by, locked, salt: locked ? c.salt : '', hash: locked ? c.hash : '', ts: Number.isFinite(c.ts) ? c.ts : 0, v: c.v, del: c.del === true };
}
// Bersihkan peta dari disk: dipanggil saat memuat store. Batas dipaksakan secara deterministik (ID terkecil dulu).
function clean(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, c] of Object.entries(map)) {
    const r = cleanRec(c);
    if (r && r.id === k) out[k] = r;
  }
  const per = {};
  for (const c of Object.values(out).filter((x) => !x.del).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    per[c.by] = (per[c.by] || 0) + 1;
    if (per[c.by] > PV_MAX_PER_OWNER * 2) delete out[c.id];
  }
  prune(out);
  return out;
}

// ---- Penyebaran lewat pesan kontrol tersembunyi di aliran publik (langkah 2) ----
// Teks pesan = CTL + JSON array rekaman milik pengirim (maksimal PV_MAX_PER_MSG per pesan). Awalan berbeda dari voice grup.
const CTL = '\u0001pvch:';
const pub = (c) => ({ id: c.id, name: c.name, by: c.by, locked: c.locked, salt: c.salt, hash: c.hash, ts: c.ts, v: c.v, del: c.del });
const encodeCtl = (recs) => CTL + JSON.stringify(recs.slice(0, PV_MAX_PER_MSG).map(pub));
// null = bukan pesan kontrol channel publik; selain itu array rekaman mentah (bisa kosong bila rusak: tetap disembunyikan, tidak diterapkan).
function parseCtl(text) {
  if (typeof text !== 'string' || !text.startsWith(CTL)) return null;
  try { const a = JSON.parse(text.slice(CTL.length)); return Array.isArray(a) ? a.slice(0, PV_MAX_PER_MSG) : []; } catch { return []; }
}
// Urutan total supaya semua node konvergen walau pesan datang acak: versi, lalu penanda hapus, lalu ts, lalu isi.
const body = (c) => JSON.stringify([c.name, c.locked, c.salt, c.hash]);
function newer(a, b) {
  if (a.v !== b.v) return a.v > b.v;
  if (a.del !== b.del) return a.del;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return body(a) > body(b);
}
// Terapkan satu rekaman dari `from` (penanda tangan pesan, sudah diverifikasi core) ke map. 'applied' | 'stale' | 'reject'.
//  - hanya pemilik yang boleh menyiarkan channelnya (rec.by === from), dan ID channel harus berawalan ID pemilik
//  - channel baru ditolak bila jaringan sudah penuh atau pemilik menumpuk terlalu banyak (batas longgar 2x, supaya tombstone yang datang telat tidak membuat create sah ditolak)
//  - tombstone final: tidak pernah hidup lagi; hanya versi yang lebih baru diterima
function applyRemote(map, from, raw) {
  if (!HEX16.test(String(from))) return 'reject';
  const rec = cleanRec(raw);
  if (!rec || rec.by !== from) return 'reject';
  const cur = map[rec.id];
  if (!cur) {
    if (!rec.del) {
      if (live(map).length >= PV_MAX_LIVE) return 'reject';
      if (storedLiveBy(map, from) >= PV_MAX_PER_OWNER * 2) return 'reject';
    }
    map[rec.id] = rec; prune(map);
    return 'applied';
  }
  if (cur.by !== rec.by) return 'reject';
  if (cur.del) return 'stale';
  if (!newer(rec, cur)) return 'stale';
  Object.assign(cur, rec);
  prune(map);
  return 'applied';
}

module.exports = {
  CTL, encodeCtl, parseCtl, applyRemote, newer, cleanRec, clean, prune,
  PV_MAX_LIVE, PV_MAX_PER_OWNER, PV_MAX_DEAD, PV_MAX_OWNER_DEAD, PV_MAX_MEMBERS, PV_PIN_LEN, PV_MAX_PER_MSG,
  cleanName, validPin, newId, idOwnedBy, makeLock, checkPin,
  live, isOwner, canCreate, canManage, canJoin, needsPin, hasRoom, create, remove, update,
};
