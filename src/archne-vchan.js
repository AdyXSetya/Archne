'use strict';
// Channel voice grup (v0.19.0, langkah 1): model data dan aturan hak akses. Murni: tanpa jaringan, tanpa UI.
// Disimpan di g.vch = { [cid]: { id, name, by, locked, allow, ts, v, del } }.
//   by     = pembuat channel (member biasa boleh membuat; hanya ia dan admin/pemilik grup yang boleh mengubah/menghapus)
//   locked = true -> hanya admin/pemilik grup, pembuat, dan yang ada di allow yang boleh masuk
//   v      = versi naik tiap perubahan; del = penanda hapus (tombstone) supaya pesan lama tidak menghidupkan channel lagi
const { ek } = require('./core/archne-ecode'); // i18n (E9e)
const HEX16 = /^[0-9a-f]{16}$/;
const VC_NAME_MAX = 32, VC_MAX_LIVE = 20, VC_MAX_ALL = 100, VC_MAX_ALLOW = 64;

const isAdmin = (g, id) => !!g && (g.creator === id || (g.admins || []).includes(id));
const isMember = (g, id) => !!g && !g.removed && (g.members || []).some((x) => x.id === id);
const live = (g) => Object.values((g && g.vch) || {}).filter((c) => !c.del);

function cleanName(s) {
  const n = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) throw ek('e.vch.nameEmpty', null, 'Nama channel kosong');
  return n.length > VC_NAME_MAX ? n.slice(0, VC_NAME_MAX).trim() : n;
}
function cleanAllow(list, g) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('Daftar izin tidak valid');
  const out = [...new Set(list.map(String))];
  if (out.some((x) => !HEX16.test(x))) throw ek('e.vch.allowId', null, 'ID dalam daftar izin tidak valid');
  if (g && out.some((x) => !isMember(g, x))) throw ek('e.vch.allowMembers', null, 'Daftar izin hanya boleh berisi anggota grup');
  if (out.length > VC_MAX_ALLOW) throw ek('e.vch.allowMax', { max: VC_MAX_ALLOW }, 'Daftar izin terlalu panjang (maksimal {max})');
  return out;
}

// ---- hak akses ----
const canCreate = (g, id) => isMember(g, id) && live(g).length < VC_MAX_LIVE;
const canManage = (g, ch, id) => !!ch && !ch.del && isMember(g, id) && (isAdmin(g, id) || ch.by === id); // hapus, kunci/buka, ubah izin, ganti nama
const canJoin = (g, ch, id) => !!ch && !ch.del && isMember(g, id) && (!ch.locked || isAdmin(g, id) || ch.by === id || ch.allow.includes(id));

// ---- operasi (mengubah g.vch, mengembalikan channel). ts dan cid disuplai pemanggil supaya mudah diuji. ----
function create(g, by, cid, name, locked, allow, ts) {
  if (!isMember(g, by)) throw ek('e.vch.notMember', null, 'Kamu bukan anggota grup ini');
  if (!HEX16.test(String(cid))) throw new Error('ID channel tidak valid');
  if (!g.vch) g.vch = {};
  if (g.vch[cid]) throw new Error('ID channel sudah ada');
  if (live(g).length >= VC_MAX_LIVE) throw ek('e.vch.full', { max: VC_MAX_LIVE }, 'Channel sudah penuh (maksimal {max} per grup)');
  const ch = { id: cid, name: cleanName(name), by, locked: !!locked, allow: cleanAllow(allow, g).filter((x) => x !== by), ts, v: 1, del: false };
  g.vch[cid] = ch;
  prune(g);
  return ch;
}
function remove(g, by, cid, ts) {
  const ch = g.vch && g.vch[cid];
  if (!ch || ch.del) throw ek('e.vc.gone', null, 'Channel tidak ditemukan');
  if (!canManage(g, ch, by)) throw ek('e.vch.delDenied', null, 'Hanya pembuat channel atau admin yang boleh menghapusnya');
  ch.del = true; ch.v++; ch.ts = ts;
  return ch;
}
function update(g, by, cid, patch, ts) {
  const ch = g.vch && g.vch[cid];
  if (!ch || ch.del) throw ek('e.vc.gone', null, 'Channel tidak ditemukan');
  if (!canManage(g, ch, by)) throw ek('e.vch.editDenied', null, 'Hanya pembuat channel atau admin yang boleh mengubahnya');
  const n = {};
  if (patch.name !== undefined) n.name = cleanName(patch.name);
  if (patch.locked !== undefined) n.locked = !!patch.locked;
  if (patch.allow !== undefined) n.allow = cleanAllow(patch.allow, g).filter((x) => x !== ch.by);
  Object.assign(ch, n); ch.v++; ch.ts = ts;
  return ch;
}
// Buang tombstone tertua kalau total entri melewati batas (channel hidup tidak pernah dibuang).
function prune(g) {
  const all = Object.values(g.vch || {});
  if (all.length <= VC_MAX_ALL) return;
  const dead = all.filter((c) => c.del).sort((a, b) => a.ts - b.ts);
  for (const c of dead.slice(0, all.length - VC_MAX_ALL)) delete g.vch[c.id];
}

// Bersihkan satu rekaman (dari disk atau dari jaringan; tidak percaya isinya). null = tidak sah.
function cleanRec(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || !HEX16.test(String(c.id)) || !HEX16.test(String(c.by))) return null;
  let name; try { name = cleanName(c.name); } catch { return null; }
  return {
    id: c.id, name, by: c.by, locked: c.locked === true,
    allow: Array.isArray(c.allow) ? [...new Set(c.allow.filter((x) => HEX16.test(String(x))))].slice(0, VC_MAX_ALLOW) : [],
    ts: Number.isFinite(c.ts) ? c.ts : 0, v: Number.isInteger(c.v) && c.v >= 1 ? c.v : 1, del: c.del === true,
  };
}
// Bersihkan data dari disk (tidak percaya isi file): dipanggil saat memuat store.
function clean(map, g) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, c] of Object.entries(map)) {
    const r = cleanRec(c);
    if (r && r.id === k) out[k] = r;
  }
  const tmp = { vch: out }; prune(tmp);
  return tmp.vch;
}

// ---- Penyebaran lewat pesan kontrol g1 tersembunyi (langkah 2) ----
// Teks pesan = CTL + JSON array rekaman channel (maksimal VC_MAX_LIVE per pesan). Pesan ini tidak tampil di chat.
const CTL = '\u0001vch:';
const pub = (c) => ({ id: c.id, name: c.name, by: c.by, locked: c.locked, allow: c.allow, ts: c.ts, v: c.v, del: c.del });
const encodeCtl = (recs) => CTL + JSON.stringify(recs.slice(0, VC_MAX_LIVE).map(pub));
// null = bukan pesan kontrol channel; selain itu array rekaman mentah (bisa kosong bila isinya rusak: tetap disembunyikan, tidak diterapkan).
function parseCtl(text) {
  if (typeof text !== 'string' || !text.startsWith(CTL)) return null;
  try { const a = JSON.parse(text.slice(CTL.length)); return Array.isArray(a) ? a.slice(0, VC_MAX_LIVE) : []; } catch { return []; }
}
// Urutan total supaya semua node konvergen walau pesan datang acak: versi, lalu penanda hapus, lalu ts, lalu isi.
const body = (c) => JSON.stringify([c.name, c.locked, c.allow]);
function newer(a, b) {
  if (a.v !== b.v) return a.v > b.v;
  if (a.del !== b.del) return a.del;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return body(a) > body(b);
}
// Terapkan satu rekaman dari `from` ke g.vch. Mengembalikan 'applied' | 'stale' (sah tapi lebih lama/sama) | 'reject' (tidak berhak).
//  - channel baru: hanya pembuatnya sendiri (by === from) atau admin/pemilik grup (mengumumkan ulang untuk anggota baru) yang boleh memperkenalkannya
//  - channel yang sudah ada: by tidak boleh berubah; pengirim harus pembuat atau admin/pemilik; hanya versi yang lebih baru diterima
//  - tombstone final: tidak pernah hidup lagi
function applyRemote(g, from, raw) {
  if (!g || g.removed || !isMember(g, from)) return 'reject';
  const rec = cleanRec(raw);
  if (!rec) return 'reject';
  const cur = g.vch && g.vch[rec.id];
  if (!cur) {
    if (rec.by !== from && !isAdmin(g, from)) return 'reject';
    if (!rec.del && live(g).length >= VC_MAX_LIVE) return 'reject';
    if (!g.vch) g.vch = {};
    g.vch[rec.id] = rec; prune(g);
    return 'applied';
  }
  if (rec.by !== cur.by) return 'reject';
  if (cur.del) return 'stale';
  if (!canManage(g, cur, from)) return 'reject';
  if (!newer(rec, cur)) return 'stale';
  Object.assign(cur, { name: rec.name, locked: rec.locked, allow: rec.allow, ts: rec.ts, v: rec.v, del: rec.del });
  return 'applied';
}

module.exports = { CTL, encodeCtl, parseCtl, applyRemote, newer, cleanRec, VC_NAME_MAX, VC_MAX_LIVE, VC_MAX_ALL, VC_MAX_ALLOW, cleanName, cleanAllow, canCreate, canManage, canJoin, create, remove, update, clean, live, isAdmin, isMember };
