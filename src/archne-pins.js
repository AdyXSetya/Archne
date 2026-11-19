'use strict';
// Sematan pesan (langkah 1 / pin1): model data dan aturan. Murni: tanpa jaringan, tanpa UI, tidak menyentuh Core, voice grup, atau channel publik.
// Satu sematan = salinan (snapshot) isi pesan, BUKAN penunjuk ke pesan, supaya tetap ada setelah pesan dihapus atau "Bersihkan chat".
// Disimpan sebagai peta { [pid]: { id, by, kind, text, from, name, at, mid, ts, v, del } }.
//   by    = yang menyematkan (penanda tangan). id sematan berawalan ID-nya, jadi orang lain tidak bisa menyalin id lalu mengaku pembuatnya.
//   kind  = 'msg' (pesan teks) | 'file' (label berkas, bukan isinya) | 'note' (pengumuman bebas, bukan dari pesan; satu-satunya yang bisa diedit)
//   text  = isi salinan (maksimal PIN_TEXT_MAX karakter, baris baru dipertahankan); from/name/at/mid = pengirim asli, nama waktu itu, waktu pesan, id pesan (untuk "lompat ke pesan")
//   ts    = waktu menyematkan (urutan tampil: terbaru di atas); v = versi naik tiap perubahan; del = tombstone supaya sematan lama tidak hidup lagi
// Tiga lingkup, rumus yang sama, hanya kebijakan (policy) yang berbeda:
//   groupPolicy(g)    sematan bersama di grup: hanya admin dan pemilik yang boleh menyematkan dan melepas (admin yang sudah dicopot: sematannya tetap, admin aktif yang melepas)
//   dmPolicy(a, b)    sematan bersama di DM: kedua orang boleh menyematkan dan melepas
//   selfPolicy(me)    sematan pribadi: hanya lokal, tidak pernah disebar; dilepas = dihapus langsung (tanpa tombstone). Dipakai juga di tab Publik dan oleh member biasa di grup.
const crypto = require('crypto');
const Vc = require('./archne-vchan'); // isAdmin / isMember dipakai ulang
const { ek } = require('./core/archne-ecode'); // i18n (E8)

const HEX16 = /^[0-9a-f]{16}$/, HEX32 = /^[0-9a-f]{32}$/;
const PIN_TEXT_MAX = 10000;      // karakter per salinan (UTF-16): sama dengan batas pesan (MAX_TEXT di archne-core.js), jadi "Baca selengkapnya" selalu isi utuh
const PIN_NAME_MAX = 40;
const PIN_MAX_LIVE = 100;        // sematan hidup per lingkup (bersama maupun pribadi); membuat yang ke-101 ditolak
const PIN_MAX_STORE = 200;       // batas longgar untuk yang datang dari jaringan (dua admin bisa menyematkan bersamaan); yang tampil tetap PIN_MAX_LIVE terbaru
const PIN_MAX_DEAD = 200;        // tombstone yang disimpan per lingkup
const PIN_MAX_PER_MSG = 10;      // rekaman per pesan kontrol
const PIN_MAX_CTL_BYTES = 32000; // batas byte teks satu pesan kontrol (batas ciphertext Core 48.000). Satu salinan 10.000 karakter CJK = ~30,2 KB, jadi harus muat sendirian
const PIN_MAX_V = 1000000;
const ID_PREFIX = 10;
const KINDS = ['msg', 'file', 'note'];

// ---- pembersihan teks ----
// Karakter kontrol, pemisah baris aneh, dan pembalik arah teks dibuang; baris baru dipertahankan (tiga baris kosong atau lebih diringkas jadi satu).
const BAD = /[\u0000-\u0009\u000b-\u001f\u007f\u0085\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function clip(t, max) { // potong tanpa memenggal pasangan surrogate
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  const c = cut.charCodeAt(cut.length - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd() + '…';
}
function cleanText(s, max) {
  if (typeof s !== 'string') throw new Error('Teks sematan tidak valid');
  const t = s.replace(/\r\n?/g, '\n').replace(BAD, ' ').split('\n').map((l) => l.replace(/ +/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) throw ek('e.pin.empty', null, 'Teks sematan kosong');
  return clip(t, max || PIN_TEXT_MAX);
}
function cleanLabel(s) { // nama pengirim waktu itu: satu baris, boleh kosong
  if (s == null) return '';
  return clip(String(s).replace(BAD, ' ').replace(/\s+/g, ' ').trim(), PIN_NAME_MAX);
}

// ---- ID sematan: awalan = awalan ID penyemat, jadi id tidak bisa diklaim orang lain ----
const newId = (by) => String(by).slice(0, ID_PREFIX) + crypto.randomBytes(3).toString('hex');
const idOwnedBy = (pid, by) => HEX16.test(String(pid)) && HEX16.test(String(by)) && String(pid).slice(0, ID_PREFIX) === String(by).slice(0, ID_PREFIX);

// ---- kebijakan (siapa boleh apa). Semua membaca keadaan terbaru (admin yang dicopot langsung kehilangan hak). ----
// isParticipant: boleh menyiarkan sematan di lingkup ini; canPost: boleh menyematkan / mengedit pengumuman; canRemove: boleh melepas sematan siapa pun; strictBy: pembuat harus peserta.
function groupPolicy(g) {
  const adm = (id) => Vc.isMember(g, id) && Vc.isAdmin(g, id);
  return { kind: 'g', local: false, strictBy: false, isParticipant: (id) => Vc.isMember(g, id), canPost: adm, canRemove: adm,
    denyPost: () => ek('e.pin.denyGroupPost', null, 'Hanya admin atau pemilik grup yang boleh menyematkan untuk semua anggota. Kamu bisa menyematkan untuk dirimu sendiri.'),
    denyRemove: () => ek('e.pin.denyGroupRemove', null, 'Hanya admin atau pemilik grup yang boleh melepas sematan bersama.') };
}
function dmPolicy(a, b) {
  if (!HEX16.test(String(a)) || !HEX16.test(String(b)) || a === b) throw ek('e.pin.badPeer', null, 'Peserta chat tidak valid');
  const part = (id) => id === a || id === b;
  return { kind: 'dm', local: false, strictBy: true, isParticipant: part, canPost: part, canRemove: part,
    denyPost: () => ek('e.pin.notInChat', null, 'Kamu bukan peserta chat ini.'), denyRemove: () => ek('e.pin.notInChat', null, 'Kamu bukan peserta chat ini.') };
}
function selfPolicy(me) {
  if (!HEX16.test(String(me))) throw new Error('ID tidak valid');
  const mine = (id) => id === me;
  return { kind: 'self', local: true, strictBy: true, isParticipant: mine, canPost: mine, canRemove: mine,
    denyPost: () => ek('e.pin.selfOnly', null, 'Sematan pribadi hanya untuk pemiliknya.'), denyRemove: () => ek('e.pin.selfOnly', null, 'Sematan pribadi hanya untuk pemiliknya.') };
}

// ---- tampilan ----
const storedLive = (map) => Object.values(map || {}).filter((c) => !c.del).length;
// Yang tampil: hidup saja, terbaru di atas (ts menurun, lalu id), paling banyak PIN_MAX_LIVE. Urutannya sama di semua node untuk data yang sama.
function live(map) {
  return Object.values(map || {}).filter((c) => !c.del).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1)).slice(0, PIN_MAX_LIVE);
}

// ---- operasi (mengubah map, mengembalikan rekaman). pid dan ts disuplai pemanggil supaya mudah diuji. ----
// spec: { kind, text, from, name, at, mid } ; 'note' tidak butuh from/mid/at (pengirimnya = penyemat).
function create(map, pol, by, pid, spec, ts) {
  if (!HEX16.test(String(by))) throw new Error('ID penyemat tidak valid');
  if (!pol.canPost(by)) throw pol.denyPost();
  if (!idOwnedBy(pid, by)) throw new Error('ID sematan tidak valid');
  if (map[pid]) throw new Error('ID sematan sudah ada');
  if (!spec || !KINDS.includes(spec.kind)) throw new Error('Jenis sematan tidak valid');
  const note = spec.kind === 'note';
  if (!note && !(HEX32.test(String(spec.mid)) && HEX16.test(String(spec.from)))) throw new Error('Pesan yang disematkan tidak valid');
  if (storedLive(map) >= PIN_MAX_LIVE) throw ek('e.pin.full', { max: PIN_MAX_LIVE }, 'Sudah ada {max} sematan. Lepas salah satu dulu.');
  if (!note && Object.values(map).some((c) => !c.del && c.mid === spec.mid)) throw ek('e.pin.dup', null, 'Pesan ini sudah disematkan');
  cleanText(spec.text); // galat yang jelas (kosong / bukan teks) sebelum cleanRec yang hanya menjawab sah / tidak
  const rec = cleanRec({ id: pid, by, kind: spec.kind, text: spec.text, from: note ? by : spec.from, name: spec.name, at: note ? ts : spec.at, mid: note ? '' : spec.mid, ts, v: 1, del: false });
  if (!rec) throw new Error('Sematan tidak valid');
  map[pid] = rec;
  prune(map);
  return rec;
}
// Lepas sematan. Bersama: tombstone (v naik). Pribadi (pol.local): dihapus langsung; yang dikembalikan salinan bertanda del.
function remove(map, pol, by, pid, ts) {
  const rec = map[pid];
  if (!rec || rec.del) throw ek('e.pin.notFound', null, 'Sematan tidak ditemukan');
  if (!pol.canRemove(by, rec)) throw pol.denyRemove();
  if (pol.local) { delete map[pid]; return Object.assign({}, rec, { del: true }); }
  rec.del = true; rec.v++; rec.ts = ts;
  prune(map);
  return rec;
}
// Edit isi pengumuman. Hanya 'note'; waktu sematan (urutan) tetap.
function edit(map, pol, by, pid, text, ts) {
  const rec = map[pid];
  if (!rec || rec.del) throw ek('e.pin.notFound', null, 'Sematan tidak ditemukan');
  if (rec.kind !== 'note') throw ek('e.pin.noteOnly', null, 'Hanya pengumuman yang bisa diedit');
  if (!pol.canPost(by)) throw pol.denyPost();
  const t = cleanText(text);
  if (t === rec.text) return rec;
  rec.text = t; rec.v++;
  return rec;
}
// Buang tombstone terlama bila lebih dari PIN_MAX_DEAD. Sematan hidup tidak pernah dibuang.
function prune(map) {
  const dead = Object.values(map).filter((c) => c.del).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
  for (const c of dead.slice(PIN_MAX_DEAD)) delete map[c.id];
}

// Bersihkan satu rekaman (dari disk atau jaringan; isinya tidak dipercaya). null = tidak sah.
function cleanRec(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (typeof c.id !== 'string' || typeof c.by !== 'string' || typeof c.kind !== 'string') return null; // String([x]) === x akan meloloskan array berisi satu ID
  if (!HEX16.test(c.by) || !idOwnedBy(c.id, c.by) || !KINDS.includes(c.kind)) return null;
  let text; try { text = cleanText(c.text); } catch { return null; }
  const note = c.kind === 'note';
  if (!note && !(typeof c.mid === 'string' && HEX32.test(c.mid) && typeof c.from === 'string' && HEX16.test(c.from))) return null;
  if (!Number.isInteger(c.v) || c.v < 1 || c.v > PIN_MAX_V) return null;
  const ts = Number.isFinite(c.ts) ? c.ts : 0;
  return { id: c.id, by: c.by, kind: c.kind, text, from: note ? c.by : c.from, name: cleanLabel(c.name), at: Number.isFinite(c.at) ? c.at : ts, mid: note ? '' : c.mid, ts, v: c.v, del: c.del === true };
}
// Bersihkan peta dari disk: dipanggil saat memuat store. Batas dipaksakan deterministik (terbaru dulu).
function clean(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, c] of Object.entries(map)) {
    const r = cleanRec(c);
    if (r && r.id === k) out[k] = r;
  }
  const lv = Object.values(out).filter((x) => !x.del).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
  for (const c of lv.slice(PIN_MAX_STORE)) delete out[c.id];
  prune(out);
  return out;
}

// ---- Penyebaran lewat pesan kontrol tersembunyi (langkah 2) ----
// Teks pesan = CTL + JSON array rekaman (maksimal PIN_MAX_PER_MSG dan PIN_MAX_CTL_BYTES per pesan). Lingkupnya ditentukan oleh obrolan tempat pesan itu dikirim.
const CTL = '\u0001pin:';
const pub = (c) => ({ id: c.id, by: c.by, kind: c.kind, text: c.text, from: c.from, name: c.name, at: c.at, mid: c.mid, ts: c.ts, v: c.v, del: c.del });
const encodeCtl = (recs) => CTL + JSON.stringify(recs.slice(0, PIN_MAX_PER_MSG).map(pub));
// Bagi banyak rekaman jadi beberapa teks kontrol yang masing-masing muat dalam batas jumlah dan byte.
function encodeAll(recs) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) { out.push(encodeCtl(cur)); cur = []; } };
  for (const r of recs) {
    if (cur.length && (cur.length >= PIN_MAX_PER_MSG || Buffer.byteLength(encodeCtl(cur.concat([r]))) > PIN_MAX_CTL_BYTES)) flush();
    cur.push(r);
  }
  flush();
  return out;
}
// null = bukan pesan kontrol sematan; selain itu array rekaman mentah (bisa kosong bila rusak: tetap disembunyikan, tidak diterapkan).
function parseCtl(text) {
  if (typeof text !== 'string' || !text.startsWith(CTL)) return null;
  try { const a = JSON.parse(text.slice(CTL.length)); return Array.isArray(a) ? a.slice(0, PIN_MAX_PER_MSG) : []; } catch { return []; }
}
// Urutan total supaya semua node konvergen walau pesan datang acak: tombstone SELALU menang (jadi hapus dan edit yang bersamaan tidak bisa berselisih),
// lalu versi, lalu ts, lalu isi.
function newer(a, b) {
  if (a.del !== b.del) return a.del;
  if (a.v !== b.v) return a.v > b.v;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return a.text > b.text;
}
// Terapkan satu rekaman dari `from` (penanda tangan pesan, sudah diverifikasi Core) ke map. 'applied' | 'stale' | 'reject'.
//  - pengirim harus peserta lingkup ini
//  - sematan baru: pengirim harus berhak menyematkan. Pembuatnya (by) BOLEH orang lain: admin aktif mengumumkan ulang sematan lama untuk anggota baru,
//    termasuk sematan admin yang sudah dicopot
//  - sematan yang sudah ada: pembuat, jenis, pengirim asli, pesan asli tidak boleh berubah; yang boleh berubah hanya isi pengumuman dan penanda hapus,
//    dan pengirimnya harus berhak melepas. Isi sematan pesan tidak bisa diubah.
//  - tombstone final: sematan yang sudah dihapus tidak pernah hidup lagi
function applyRemote(map, pol, from, raw) {
  if (!HEX16.test(String(from)) || !pol.isParticipant(from)) return 'reject';
  const rec = cleanRec(raw);
  if (!rec) return 'reject';
  if (pol.strictBy && !pol.isParticipant(rec.by)) return 'reject';
  const cur = map[rec.id];
  if (!cur) {
    if (!pol.canPost(from)) return 'reject';
    if (!rec.del && storedLive(map) >= PIN_MAX_STORE) return 'reject';
    map[rec.id] = rec; prune(map);
    return 'applied';
  }
  if (cur.by !== rec.by || cur.kind !== rec.kind || cur.from !== rec.from || cur.mid !== rec.mid || cur.at !== rec.at || cur.name !== rec.name) return 'reject';
  if (cur.del && !rec.del) return 'stale';
  if (!pol.canRemove(from, cur)) return 'reject';
  if (!rec.del && cur.kind !== 'note' && rec.text !== cur.text) return 'reject';
  if (!newer(rec, cur)) return 'stale';
  Object.assign(cur, { text: rec.text, ts: rec.ts, v: rec.v, del: rec.del });
  prune(map);
  return 'applied';
}

module.exports = {
  CTL, encodeCtl, encodeAll, parseCtl, applyRemote, newer, cleanRec, clean, prune, live,
  PIN_TEXT_MAX, PIN_NAME_MAX, PIN_MAX_LIVE, PIN_MAX_STORE, PIN_MAX_DEAD, PIN_MAX_PER_MSG, PIN_MAX_CTL_BYTES, KINDS,
  cleanText, cleanLabel, newId, idOwnedBy, groupPolicy, dmPolicy, selfPolicy, create, remove, edit,
};
