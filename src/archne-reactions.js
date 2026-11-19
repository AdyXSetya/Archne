'use strict';
// Reaksi pesan (langkah 2 / rx1): model data dan aturan. Murni: tanpa jaringan, tanpa UI, tanpa Core, tanpa ICU (aman di nodejs-mobile Node 12).
// Satu orang = satu reaksi per pesan (seperti WhatsApp). Tiap (pesan, pengirim) adalah satu register LWW:
//   map = { [mid]: { [by]: { e, ts } } }
//   mid = id pesan sasaran (32 hex); by = pengirim reaksi (16 hex, penanda tangan pesan pembawa, diverifikasi Core, TIDAK dibaca dari isi);
//   e   = emoji kanonis, atau '' = reaksi dicabut (register tetap disimpan sebagai tombstone supaya reaksi lama yang telat tidak hidup lagi);
//   ts  = urutan HLC saat mengetuk. Pemenang: ts lebih besar, lalu emoji lebih besar (urutan kode UTF-16): sama di semua node, jadi konvergen tanpa koordinasi.
// Rekaman di jaringan: {m, e, ts}. Satu pesan kontrol tersembunyi membawa maksimal RX_MAX_PER_MSG rekaman: '\u0001rx:' + JSON.
// Yang BUKAN urusan modul ini (Core): apakah sasaran ada dan satu chat (callback `known`), siapa peserta (`isParticipant`), pemblokiran, notifikasi, penjadwalan batch.

const { ek } = require('./core/archne-ecode'); // i18n (E8)
const HEX16 = /^[0-9a-f]{16}$/, HEX32 = /^[0-9a-f]{32}$/;
const RX_MAX_PER_MSG = 10;        // rekaman per pesan kontrol (sama dengan sematan)
const RX_MAX_CTL_BYTES = 8000;    // batas byte teks satu pesan kontrol; 10 rekaman biasanya ~1,2 KB, ini hanya pagar
const RX_BATCH_MS = 2000;         // ketukan dikumpulkan selama ini sebelum dikirim (dipakai pemanggil untuk timer)
const RX_SHOW_MAX = 12;           // jenis emoji berbeda yang ditampilkan per pesan
const RX_MAX_REG_PER_MSG = 256;   // register (orang) per pesan yang disimpan; peserta baru di atas batas ini ditolak
const RX_MAX_STORE = 5000;        // total register yang disimpan; di atasnya yang paling lama dibuang (tombstone dulu)
const RX_PEND_MAX = 300, RX_PEND_PER_SENDER = 30, RX_PEND_TTL = 24 * 3600e3; // reaksi yang sasarannya belum tiba
const RX_RATE_RECV = { max: 120, windowMs: 60e3 };  // rekaman per pengirim per menit yang diterima
const RX_RATE_SEND = { max: 30, windowMs: 60e3 };   // ketukan per menit yang dikirim sendiri
const RX_RECENT_MAX = 8;
const EMOJI_MAX_CP = 10;          // code point per emoji kanonis (urutan terpanjang yang lazim: pasangan + kulit + hati + cium = 10)
const RAW_CP_MAX = 16;            // masukan yang lebih panjang dari ini langsung ditolak sebelum diurai

// ---- tabel rentang code point (tanpa \p{...} dan Intl: tidak ada di Node 12 tanpa ICU) ----
// Dibuat dari data Unicode emoji (Emoji, Emoji_Presentation, Extended_Pictographic). BMP persis; rentang non-BMP sengaja agak longgar supaya emoji baru tidak ditolak; yang dijaga ketat adalah BENTUK urutannya.
function table(pairs) { // pencarian biner; gagal saat dimuat bila tabel tidak urut / tumpang tindih (jaga salah ketik)
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0] > pairs[i][1] || (i && pairs[i][0] <= pairs[i - 1][1])) throw new Error('tabel emoji rusak di indeks ' + i);
  return (cp) => {
    let lo = 0, hi = pairs.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cp < pairs[mid][0]) hi = mid - 1; else if (cp > pairs[mid][1]) lo = mid + 1; else return true; }
    return false;
  };
}
const bmpAll = table([[0xA9, 0xA9], [0xAE, 0xAE], [0x203C, 0x203C], [0x2049, 0x2049], [0x2122, 0x2122], [0x2139, 0x2139], [0x2194, 0x2199], [0x21A9, 0x21AA],
  [0x231A, 0x231B], [0x2328, 0x2328], [0x23CF, 0x23CF], [0x23E9, 0x23F3], [0x23F8, 0x23FA], [0x24C2, 0x24C2], [0x25AA, 0x25AB], [0x25B6, 0x25B6], [0x25C0, 0x25C0],
  [0x25FB, 0x25FE], [0x2600, 0x2604], [0x260E, 0x260E], [0x2611, 0x2611], [0x2614, 0x2615], [0x2618, 0x2618], [0x261D, 0x261D], [0x2620, 0x2620], [0x2622, 0x2623],
  [0x2626, 0x2626], [0x262A, 0x262A], [0x262E, 0x262F], [0x2638, 0x263A], [0x2640, 0x2640], [0x2642, 0x2642], [0x2648, 0x2653], [0x265F, 0x2660], [0x2663, 0x2663],
  [0x2665, 0x2666], [0x2668, 0x2668], [0x267B, 0x267B], [0x267E, 0x267F], [0x2692, 0x2697], [0x2699, 0x2699], [0x269B, 0x269C], [0x26A0, 0x26A1], [0x26A7, 0x26A7],
  [0x26AA, 0x26AB], [0x26B0, 0x26B1], [0x26BD, 0x26BE], [0x26C4, 0x26C5], [0x26C8, 0x26C8], [0x26CE, 0x26CF], [0x26D1, 0x26D1], [0x26D3, 0x26D4], [0x26E9, 0x26EA],
  [0x26F0, 0x26F5], [0x26F7, 0x26FA], [0x26FD, 0x26FD], [0x2702, 0x2702], [0x2705, 0x2705], [0x2708, 0x270D], [0x270F, 0x270F], [0x2712, 0x2712], [0x2714, 0x2714],
  [0x2716, 0x2716], [0x271D, 0x271D], [0x2721, 0x2721], [0x2728, 0x2728], [0x2733, 0x2734], [0x2744, 0x2744], [0x2747, 0x2747], [0x274C, 0x274C], [0x274E, 0x274E],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2763, 0x2764], [0x2795, 0x2797], [0x27A1, 0x27A1], [0x27B0, 0x27B0], [0x27BF, 0x27BF], [0x2934, 0x2935], [0x2B05, 0x2B07],
  [0x2B1B, 0x2B1C], [0x2B50, 0x2B50], [0x2B55, 0x2B55], [0x3030, 0x3030], [0x303D, 0x303D], [0x3297, 0x3297], [0x3299, 0x3299]]);
const bmpPres = table([[0x231A, 0x231B], [0x23E9, 0x23EC], [0x23F0, 0x23F0], [0x23F3, 0x23F3], [0x25FD, 0x25FE], [0x2614, 0x2615], [0x2648, 0x2653], [0x267F, 0x267F],
  [0x2693, 0x2693], [0x26A1, 0x26A1], [0x26AA, 0x26AB], [0x26BD, 0x26BE], [0x26C4, 0x26C5], [0x26CE, 0x26CE], [0x26D4, 0x26D4], [0x26EA, 0x26EA], [0x26F2, 0x26F3],
  [0x26F5, 0x26F5], [0x26FA, 0x26FA], [0x26FD, 0x26FD], [0x2705, 0x2705], [0x270A, 0x270B], [0x2728, 0x2728], [0x274C, 0x274C], [0x274E, 0x274E], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27B0, 0x27B0], [0x27BF, 0x27BF], [0x2B1B, 0x2B1C], [0x2B50, 0x2B50], [0x2B55, 0x2B55]]);
const hiBase = table([[0x1F004, 0x1F004], [0x1F0CF, 0x1F0CF], [0x1F170, 0x1F171], [0x1F17E, 0x1F17F], [0x1F18E, 0x1F18E], [0x1F191, 0x1F19A], [0x1F201, 0x1F202],
  [0x1F21A, 0x1F21A], [0x1F22F, 0x1F22F], [0x1F232, 0x1F23A], [0x1F250, 0x1F251], [0x1F300, 0x1F3FA], [0x1F400, 0x1F53D], [0x1F546, 0x1F64F], [0x1F680, 0x1F6FF],
  [0x1F7E0, 0x1F7FF], [0x1F90C, 0x1F93A], [0x1F93C, 0x1F945], [0x1F947, 0x1FAFF]]); // celah 1F3FB-1F3FF (penanda kulit) memang di luar; blok 1F90C+ dibiarkan penuh agar emoji baru tahun depan lolos
const hiText = table([[0x1F170, 0x1F171], [0x1F17E, 0x1F17F], [0x1F202, 0x1F202], [0x1F237, 0x1F237], [0x1F321, 0x1F321], [0x1F324, 0x1F32C], [0x1F336, 0x1F336],
  [0x1F37D, 0x1F37D], [0x1F396, 0x1F397], [0x1F399, 0x1F39B], [0x1F39E, 0x1F39F], [0x1F3CB, 0x1F3CE], [0x1F3D4, 0x1F3DF], [0x1F3F3, 0x1F3F3], [0x1F3F5, 0x1F3F5],
  [0x1F3F7, 0x1F3F7], [0x1F43F, 0x1F43F], [0x1F441, 0x1F441], [0x1F4FD, 0x1F4FD], [0x1F549, 0x1F54A], [0x1F56F, 0x1F570], [0x1F573, 0x1F579], [0x1F587, 0x1F587],
  [0x1F58A, 0x1F58D], [0x1F590, 0x1F590], [0x1F5A5, 0x1F5A5], [0x1F5A8, 0x1F5A8], [0x1F5B1, 0x1F5B2], [0x1F5BC, 0x1F5BC], [0x1F5C2, 0x1F5C4], [0x1F5D1, 0x1F5D3],
  [0x1F5DC, 0x1F5DE], [0x1F5E1, 0x1F5E1], [0x1F5E3, 0x1F5E3], [0x1F5E8, 0x1F5E8], [0x1F5EF, 0x1F5EF], [0x1F5F3, 0x1F5F3], [0x1F5FA, 0x1F5FA], [0x1F6CB, 0x1F6CB],
  [0x1F6CD, 0x1F6CF], [0x1F6E0, 0x1F6E5], [0x1F6E9, 0x1F6E9], [0x1F6F0, 0x1F6F0], [0x1F6F3, 0x1F6F3]]);
const VS16 = 0xFE0F, ZW = 0x200D, KEYCAP = 0x20E3, BLACKFLAG = 0x1F3F4, TAG_END = 0xE007F;
const isBase = (cp) => (cp < 0x10000 ? bmpAll(cp) : hiBase(cp));
const needsVS = (cp) => (cp < 0x10000 ? bmpAll(cp) && !bmpPres(cp) : hiText(cp)); // bentuk kanonis: dasar bergaya teks diberi VS16 (❤ → ❤️), dasar bergaya emoji tanpa VS16
const isMod = (cp) => cp >= 0x1F3FB && cp <= 0x1F3FF;
const isRI = (cp) => cp >= 0x1F1E6 && cp <= 0x1F1FF;
const isTag = (cp) => cp >= 0xE0061 && cp <= 0xE007A;
const isKeyBase = (cp) => cp === 0x23 || cp === 0x2A || (cp >= 0x30 && cp <= 0x39);

// Satu unsur: dasar + (VS16)? + (pengubah kulit)?. Menulis bentuk kanonis ke out; mengembalikan indeks berikutnya atau -1.
function element(c, i, out) {
  const b = c[i];
  if (b === undefined || !isBase(b)) return -1;
  i++;
  if (c[i] === VS16) i++;
  let mod = 0;
  if (i < c.length && isMod(c[i])) mod = c[i++];
  out.push(b);
  if (mod) out.push(mod); else if (needsVS(b)) out.push(VS16);
  return i;
}
// Urai satu emoji utuh dari larik code point. Mengembalikan larik kanonis atau null. Menerima persis SATU emoji:
//   keycap (1️⃣ #️⃣ *️⃣) | bendera negara (dua huruf regional) | bendera subdivisi (🏴 + tag + cancel) | unsur (ZWJ unsur)*. Panjang sambungan dibatasi sendiri oleh EMOJI_MAX_CP (5 sambungan sudah 11 code point).
function parse(c) {
  const n = c.length, out = [];
  if (!n || n > RAW_CP_MAX) return null;
  const c0 = c[0];
  if (isKeyBase(c0)) {
    let i = 1;
    if (c[i] === VS16) i++;
    if (c[i] !== KEYCAP || i + 1 !== n) return null;
    return [c0, VS16, KEYCAP];
  }
  if (isRI(c0)) return n === 2 && isRI(c[1]) ? [c0, c[1]] : null;
  if (c0 === BLACKFLAG && n > 1 && isTag(c[1])) {
    let i = 1;
    while (i < n && isTag(c[i])) i++;
    const tags = i - 1;
    return tags >= 2 && tags <= 7 && c[i] === TAG_END && i + 1 === n ? c.slice() : null;
  }
  let i = element(c, 0, out);
  if (i < 0) return null;
  while (i < n && c[i] === ZW) {
    out.push(ZW);
    i = element(c, i + 1, out);
    if (i < 0) return null;
  }
  return i === n && out.length <= EMOJI_MAX_CP ? out : null;
}
// Emoji kanonis (string) atau null. Spasi di tepi dibuang. Aman untuk masukan apa pun (termasuk surrogate yatim); tidak pernah melempar.
function cleanEmoji(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t || t.length > 40) return null;
  const out = parse(Array.from(t, (ch) => ch.codePointAt(0)));
  return out ? String.fromCodePoint.apply(String, out) : null;
}
const isEmoji = (s) => cleanEmoji(s) !== null;
// Enam emoji bawaan (☺️ memakai VS16). 🩷 baru ada di Unicode 15: perangkat lama bisa menampilkan kotak kosong (urusan tampilan, langkah 4).
const DEFAULTS = Object.freeze(['👍', '🩷', '\u263A\uFE0F', '🤣', '🥺', '😭']);

// ---- rekaman & urutan ----
const isTs = (t) => Number.isInteger(t) && t >= 0 && t <= Number.MAX_SAFE_INTEGER;
// Bersihkan satu rekaman dari jaringan/disk (tidak dipercaya). null = tidak sah. e kosong = cabut.
function cleanRec(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.m !== 'string' || !HEX32.test(r.m) || typeof r.e !== 'string' || !isTs(r.ts)) return null;
  const e = r.e === '' ? '' : cleanEmoji(r.e);
  return e === null ? null : { m: r.m, e, ts: r.ts };
}
const newer = (a, b) => (a.ts !== b.ts ? a.ts > b.ts : a.e > b.e);

// ---- operasi lokal ----
// Ketuk emoji e pada pesan mid: sama dengan reaksiku sekarang = cabut, lain = ganti/pasang. Mengembalikan rekaman untuk dikirim.
// ts dari HLC pemanggil; dinaikkan bila perlu agar selalu menang atas register milikku sendiri.
function toggle(map, by, mid, e, ts) {
  if (!HEX16.test(String(by))) throw new Error('ID pengirim tidak valid');
  if (typeof mid !== 'string' || !HEX32.test(mid)) throw new Error('Pesan tidak valid');
  const em = cleanEmoji(e);
  if (!em) throw new Error('Emoji tidak valid');
  if (!isTs(ts)) throw new Error('Waktu tidak valid');
  const row = map[mid], cur = row && row[by];
  if (!cur && row && Object.keys(row).length >= RX_MAX_REG_PER_MSG) throw ek('e.rx.full', null, 'Terlalu banyak reaksi pada pesan ini');
  const next = cur && cur.e === em ? '' : em;
  const t = cur ? Math.max(ts, cur.ts + 1) : ts;
  (map[mid] || (map[mid] = {}))[by] = { e: next, ts: t };
  return { m: mid, e: next, ts: t };
}

// ---- penerimaan ----
// Terapkan satu rekaman dari `from` (penanda tangan pesan, sudah diverifikasi Core). Hasil: 'applied' | 'stale' | 'reject' | 'pending'.
//   o.isParticipant(from)  pengirim harus peserta chat ini        o.known(mid)  sasaran ada DAN satu chat (bila tidak: 'pending', pemanggil menyimpan lewat hold)
//   o.maxTs                ts di atas ini ditolak (Core: ts pesan pembawa + HLC_DRIFT), supaya tak ada yang memasang ts "tak terkalahkan"
function applyRemote(map, from, raw, o) {
  o = o || {};
  if (typeof from !== 'string' || !HEX16.test(from)) return 'reject';
  if (o.isParticipant && !o.isParticipant(from)) return 'reject';
  const rec = cleanRec(raw);
  if (!rec) return 'reject';
  if (Number.isFinite(o.maxTs) && rec.ts > o.maxTs) return 'reject';
  if (o.known && !o.known(rec.m)) return 'pending';
  const row = map[rec.m], cur = row && row[from];
  if (cur) {
    if (!newer(rec, cur)) return 'stale';
    cur.e = rec.e; cur.ts = rec.ts;
    return 'applied';
  }
  if (row && Object.keys(row).length >= RX_MAX_REG_PER_MSG) return 'reject';
  (row || (map[rec.m] = {}))[from] = { e: rec.e, ts: rec.ts };
  return 'applied';
}
// Terapkan satu pesan kontrol (larik rekaman mentah); prune sekali di akhir (murah untuk sinkronisasi massal). Mengembalikan larik hasil sejajar.
function applyAll(map, from, raws, o) {
  const res = (Array.isArray(raws) ? raws : []).slice(0, RX_MAX_PER_MSG).map((r) => applyRemote(map, from, r, o));
  prune(map);
  return res;
}

// ---- tampilan ----
const byTs = (row) => (a, b) => row[a].ts - row[b].ts || (a < b ? -1 : 1);
// Chip di bawah gelembung: [{ e, n, mine, by }] terbanyak dulu (lalu yang lebih dulu muncul, lalu emoji), maksimal RX_SHOW_MAX jenis. by = pelaku, terlama dulu.
function summary(map, mid, me) {
  const row = map[mid];
  if (!row) return [];
  const g = new Map();
  for (const by of Object.keys(row).sort(byTs(row))) {
    const r = row[by];
    if (!r.e) continue;
    let x = g.get(r.e);
    if (!x) g.set(r.e, x = { e: r.e, n: 0, mine: false, by: [], first: r.ts });
    x.n++; x.by.push(by); if (by === me) x.mine = true;
  }
  return Array.from(g.values()).sort((a, b) => b.n - a.n || a.first - b.first || (a.e < b.e ? -1 : 1)).slice(0, RX_SHOW_MAX).map((x) => ({ e: x.e, n: x.n, mine: x.mine, by: x.by }));
}
function mineOf(map, mid, me) { const r = map[mid] && map[mid][me]; return r ? r.e : ''; } // reaksiku sekarang ('' = tidak ada)
function who(map, mid, e) { // daftar pelaku satu emoji (tekan lama pada chip)
  const row = map[mid];
  return row ? Object.keys(row).filter((by) => row[by].e === e && e).sort(byTs(row)) : [];
}

// ---- pembersihan ----
const dropMsg = (map, mid) => delete map[mid]; // pesan dihapus / "Bersihkan chat" / digusur kuota: reaksinya ikut hilang
function retain(map, keep) { // buang semua baris yang sasarannya tidak lolos keep(mid); mengembalikan jumlah yang dibuang
  let n = 0;
  for (const mid of Object.keys(map)) if (!keep(mid)) { delete map[mid]; n++; }
  return n;
}
// Batasi total register: tombstone terlama dulu, lalu reaksi hidup terlama. Deterministik.
function prune(map) {
  const all = [];
  for (const m of Object.keys(map)) for (const by of Object.keys(map[m])) all.push({ m, by, e: map[m][by].e, ts: map[m][by].ts });
  if (all.length <= RX_MAX_STORE) return 0;
  all.sort((a, b) => (!a.e - !b.e) * -1 || a.ts - b.ts || (a.m + a.by < b.m + b.by ? -1 : 1)); // tombstone (e kosong) di depan, lalu ts naik
  const drop = all.slice(0, all.length - RX_MAX_STORE);
  for (const d of drop) { delete map[d.m][d.by]; if (!Object.keys(map[d.m]).length) delete map[d.m]; }
  return drop.length;
}
// Bersihkan peta dari disk (isinya tidak dipercaya): kunci sah, emoji kanonis, batas per pesan dan total.
function clean(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [m, row] of Object.entries(map)) {
    if (!HEX32.test(m) || !row || typeof row !== 'object' || Array.isArray(row)) continue;
    const ok = {};
    for (const [by, r] of Object.entries(row)) {
      if (!HEX16.test(by) || !r || typeof r !== 'object' || Array.isArray(r) || !isTs(r.ts) || typeof r.e !== 'string') continue;
      const e = r.e === '' ? '' : cleanEmoji(r.e);
      if (e !== null) ok[by] = { e, ts: r.ts };
    }
    const keys = Object.keys(ok).sort(byTs(ok)).reverse().slice(0, RX_MAX_REG_PER_MSG);
    if (keys.length) { out[m] = {}; for (const k of keys) out[m][k] = ok[k]; }
  }
  prune(out);
  return out;
}

// ---- reaksi yang sasarannya belum tiba (pend = Map; kuncinya from+mid, jadi satu slot per orang per pesan, yang terbaru menang) ----
function hold(pend, from, raw, now) {
  const rec = cleanRec(raw);
  if (!rec || typeof from !== 'string' || !HEX16.test(from)) return false;
  const key = from + rec.m, cur = pend.get(key);
  if (cur && !newer(rec, cur.rec)) return false;
  pend.delete(key); pend.set(key, { from, rec, at: now }); // dipindah ke ujung: bila waktu seri, yang tergusur duluan selalu yang lebih lama
  const oldest = (pred) => { let k = null, t = Infinity; for (const [kk, v] of pend) if (pred(v) && v.at < t) { t = v.at; k = kk; } return k; };
  let mine = 0;
  for (const v of pend.values()) if (v.from === from) mine++;
  while (mine-- > RX_PEND_PER_SENDER) pend.delete(oldest((v) => v.from === from));
  while (pend.size > RX_PEND_MAX) pend.delete(oldest(() => true));
  return pend.has(key);
}
function release(pend, mid) { // sasaran tiba: ambil semua reaksi yang menunggu, urut ts
  const out = [];
  for (const [k, v] of pend) if (v.rec.m === mid) { out.push({ from: v.from, rec: v.rec }); pend.delete(k); }
  return out.sort((a, b) => a.rec.ts - b.rec.ts);
}
function gcPending(pend, now) { let n = 0; for (const [k, v] of pend) if (now - v.at > RX_PEND_TTL) { pend.delete(k); n++; } return n; }

// ---- pembatas laju: jendela tetap per kunci; take() menolak seluruh permintaan bila melewati batas ----
function limiter(cfg, maxKeys) {
  const w = new Map(), cap = maxKeys || 2000;
  return {
    take(key, n, now) {
      let e = w.get(key);
      if (!e || Math.abs(now - e.t0) >= cfg.windowMs) {
        e = { t0: now, n: 0 }; w.set(key, e);
        if (w.size > cap) for (const [k, v] of w) if (Math.abs(now - v.t0) >= cfg.windowMs) w.delete(k);
      }
      if (e.n + n > cfg.max) return false;
      e.n += n; return true;
    },
  };
}

// ---- antrean kirim (batching): ketukan dikumpulkan RX_BATCH_MS, satu slot per pesan (yang terakhir menang) ----
const queue = () => new Map();
function enqueue(q, rec) {
  const r = cleanRec(rec);
  if (!r) throw new Error('Rekaman reaksi tidak valid');
  q.set(r.m, r);
  return q.size;
}
function flush(q) { // kosongkan antrean menjadi teks kontrol siap kirim
  const recs = Array.from(q.values()).sort((a, b) => a.ts - b.ts);
  q.clear();
  return encodeAll(recs);
}

// ---- pesan kontrol tersembunyi ----
const CTL = '\u0001rx:';
const isCtl = (text) => typeof text === 'string' && text.startsWith(CTL);
const encodeCtl = (recs) => CTL + JSON.stringify(recs.slice(0, RX_MAX_PER_MSG).map((r) => ({ m: r.m, e: r.e, ts: r.ts })));
function encodeAll(recs) { // bagi menjadi beberapa teks yang masing-masing muat dalam batas jumlah dan byte
  const out = [];
  let cur = [];
  const fl = () => { if (cur.length) { out.push(encodeCtl(cur)); cur = []; } };
  for (const r of recs) {
    if (cur.length && (cur.length >= RX_MAX_PER_MSG || Buffer.byteLength(encodeCtl(cur.concat([r]))) > RX_MAX_CTL_BYTES)) fl();
    cur.push(r);
  }
  fl();
  return out;
}
// null = bukan pesan kontrol reaksi; selain itu larik rekaman mentah (kosong bila rusak: tetap disembunyikan, tidak diterapkan).
function parseCtl(text) {
  if (!isCtl(text)) return null;
  try { const a = JSON.parse(text.slice(CTL.length)); return Array.isArray(a) ? a.slice(0, RX_MAX_PER_MSG) : []; } catch { return []; }
}

// ---- "terakhir dipakai" (lokal): terbaru di depan, tanpa duplikat; mengembalikan larik baru ----
function pushRecent(list, e, max) {
  const em = cleanEmoji(e);
  const base = (Array.isArray(list) ? list : []).map(cleanEmoji).filter((x, i, a) => x && a.indexOf(x) === i);
  return em ? [em].concat(base.filter((x) => x !== em)).slice(0, max || RX_RECENT_MAX) : base.slice(0, max || RX_RECENT_MAX);
}

module.exports = {
  CTL, isCtl, encodeCtl, encodeAll, parseCtl,
  cleanEmoji, isEmoji, DEFAULTS, cleanRec, newer,
  toggle, applyRemote, applyAll, summary, mineOf, who, dropMsg, retain, prune, clean,
  hold, release, gcPending, limiter, queue, enqueue, flush, pushRecent,
  RX_MAX_PER_MSG, RX_MAX_CTL_BYTES, RX_BATCH_MS, RX_SHOW_MAX, RX_MAX_REG_PER_MSG, RX_MAX_STORE, RX_PEND_MAX, RX_PEND_PER_SENDER, RX_PEND_TTL,
  RX_RATE_RECV, RX_RATE_SEND, RX_RECENT_MAX, EMOJI_MAX_CP,
};
