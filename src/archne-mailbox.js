'use strict';
// Kripto kotak surat (langkah 4a): amplop tersegel untuk peer yang sedang offline, dititipkan lewat broker MQTT.
// Modul murni (tanpa jaringan, tanpa status); Core memanggilnya lewat mailboxSeal/mailboxOpen. Kunci identitas tidak pernah keluar dari Core.
//
// Tiga lapis (bentuknya sengaja searah dengan archne-wancrypto.js):
//   1. isi (`b`) dienkripsi AES-256-GCM dengan kunci pasangan pengirim-penerima, AAD = [TAG, from, to, mid, ts, exp]
//      -> hanya penerima yang bisa membaca; anggota jaringan lain dan broker tidak.
//   2. tanda tangan Ed25519 identitas pengirim atas [TAG, from, to, mid, ts, exp, b]
//      -> penerima tahu siapa pengirimnya; amplop tidak bisa dipalsukan atau diubah masa berlakunya.
//   3. AES-256-GCM dengan netKey, AAD = netId + '|' + topik
//      -> orang di luar jaringan tidak melihat isi amplop (pengirim, penerima, waktu); amplop tidak bisa dipindah ke topik lain.
// Broker tetap melihat metadata topik (netId, id penerima, id pesan), waktu, dan ukuran. Isi tidak.
//
// Beda dengan signaling: amplop boleh tinggal berhari-hari di broker, jadi tidak memakai jendela SKEW_MS 5 menit.
// Gantinya: masa berlaku eksplisit (`exp`, ditandatangani) dan pencatat id (`seen`) supaya satu amplop tidak diproses dua kali.
const crypto = require('crypto');

const TAG = 'archne-mbox1';
const HEX16 = /^[0-9a-f]{16}$/;
const MAX_ENVELOPE = 64 * 1024;        // batas ukuran bungkus luar (base64) yang mau diproses
const MAX_BODY = 24 * 1024;            // batas isi (JSON) sebelum dienkripsi; bungkus tetap muat di MAX_ENVELOPE setelah base64 berlapis
const SKEW_MS = 5 * 60 * 1000;         // toleransi jam pengirim yang lebih cepat dari jam penerima
const MIN_TTL_MS = 60 * 1000;          // masa berlaku terpendek yang masuk akal
const MAX_TTL_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const SEEN_CAP = 20000;                // batas pencatat id (hanya di Core; lihat pruneSeen)
const OUT_PER_PEER = 50;               // titipan yang masih hidup (belum lewat exp) ke satu penerima (langkah 4b)
const OUT_TOTAL = 500;                 // titipan yang masih hidup ke semua penerima

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// archne/v1/<netId>/m/<penerima>/<mid>: satu topik per pesan (retained MQTT hanya satu per topik, jadi pesan tidak saling menimpa).
const topicOf = (netId, to, mid) => `archne/v1/${netId}/m/${to}/${mid}`;
const inboxFilter = (netId, myId) => `archne/v1/${netId}/m/${myId}/+`;
const TOPIC_RE = /^archne\/v1\/([0-9a-f]{16})\/m\/([0-9a-f]{16})\/([0-9a-f]{16})$/;
function parseTopic(topic) {
  const m = typeof topic === 'string' ? TOPIC_RE.exec(topic) : null;
  return m ? { netId: m[1], to: m[2], mid: m[3] } : null;
}

function aeadSeal(key, aad, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function aeadOpen(key, aad, b64) {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 28) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(aad); d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

const innerAad = (from, to, mid, ts, exp) => Buffer.from(JSON.stringify([TAG, from, to, mid, ts, exp]));
const sigInput = (from, to, mid, ts, exp, b) => Buffer.from(JSON.stringify([TAG, from, to, mid, ts, exp, b]));
const newMid = () => crypto.randomBytes(8).toString('hex');
const seenKey = (from, mid) => from + ':' + mid;

// me = { id, pub, privKey, pairKey(id) -> Buffer|null }; wan = derive(...) dari archne-wancrypto.js; in = { to, body, ttlMs, now, mid }
// Mengembalikan { topic, payload, mid, exp } untuk di-publish apa adanya (retained, QoS 1) oleh pemanggil.
// Melempar bila: penerima tidak sah / diri sendiri, kunci pasangan belum ada (peer belum pernah terlihat), isi terlalu besar, TTL di luar batas.
function seal(me, wan, { to, body, ttlMs, now, mid }) {
  if (!HEX16.test(String(to)) || to === me.id) throw new Error('Penerima tidak valid');
  const k = me.pairKey(to);
  if (!k) throw new Error('Kunci pasangan belum ada');
  const ts = Number.isSafeInteger(now) ? now : Date.now();
  const ttl = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) throw new Error('Masa berlaku tidak valid');
  const id = mid === undefined ? newMid() : mid;
  if (!HEX16.test(String(id))) throw new Error('Id pesan tidak valid');
  const exp = ts + ttl;
  const plain = JSON.stringify(body === undefined ? null : body);
  if (plain.length > MAX_BODY) throw new Error('Isi terlalu besar');
  const b = aeadSeal(k, innerAad(me.id, to, id, ts, exp), plain);
  const sig = crypto.sign(null, sigInput(me.id, to, id, ts, exp, b), me.privKey).toString('base64');
  const env = JSON.stringify({ v: 1, from: me.id, to, mid: id, ts, exp, b, pub: me.pub, sig });
  const topic = topicOf(wan.netId, to, id);
  const payload = aeadSeal(wan.netKey, Buffer.from(wan.netId + '|' + topic), env);
  if (payload.length > MAX_ENVELOPE) throw new Error('Isi terlalu besar');
  return { topic, payload, mid: id, exp };
}

const no = (why, extra) => Object.assign({ ok: false, why }, extra);

// Membuka satu amplop. Hasil:
//   { ok: true, mid, from, to, ts, exp, body }
//   { ok: false, why, mid? } dengan why salah satu dari:
//     'bad'      rusak, kode jaringan salah, tanda tangan salah, kunci pasangan tidak cocok, bentuk tidak sah, atau topik tidak cocok
//     'notmine'  bukan untukku (topik atau isi menunjuk id lain) / gema pesanku sendiri
//     'expired'  tanda tangan sah, tetapi masa berlakunya lewat (aman dihapus dari broker; `mid` ikut dikembalikan)
//     'dup'      id ini sudah pernah diproses (aman dihapus dari broker; `mid` ikut dikembalikan)
// `seen` (Map 'from:mid' -> exp, milik Core) dicatat HANYA setelah amplop lolos semua pemeriksaan, jadi amplop rusak tidak bisa "membakar" id.
function open(me, wan, { topic, payload, now, seen }) {
  try {
    if (typeof payload !== 'string' || payload.length > MAX_ENVELOPE) return no('bad');
    const t = Number.isSafeInteger(now) ? now : Date.now();
    const tp = parseTopic(topic);
    if (!tp || tp.netId !== wan.netId) return no('bad');
    if (tp.to !== me.id) return no('notmine');
    const plain = aeadOpen(wan.netKey, Buffer.from(wan.netId + '|' + topic), payload);
    if (plain === null) return no('bad');
    const e = JSON.parse(plain);
    if (!e || e.v !== 1 || !HEX16.test(String(e.from)) || !HEX16.test(String(e.to)) || !HEX16.test(String(e.mid)) || typeof e.pub !== 'string' || typeof e.sig !== 'string' || typeof e.b !== 'string') return no('bad');
    if (!Number.isSafeInteger(e.ts) || e.ts <= 0 || !Number.isSafeInteger(e.exp) || e.exp <= e.ts) return no('bad');
    if (e.to !== me.id || e.mid !== tp.mid) return no('bad'); // bungkus sah tidak bisa dipindah ke topik atau penerima lain
    if (e.from === me.id) return no('notmine');
    if (e.from !== sha(Buffer.from(e.pub, 'base64')).slice(0, 16)) return no('bad');
    const key = crypto.createPublicKey({ key: Buffer.from(e.pub, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, sigInput(e.from, e.to, e.mid, e.ts, e.exp, e.b), key, Buffer.from(e.sig, 'base64'))) return no('bad');
    // Dari sini pengirim terbukti: ts dan exp sah (ditandatangani).
    const ttl = e.exp - e.ts;
    if (ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) return no('bad');
    if (e.ts - t > SKEW_MS) return no('bad'); // dari masa depan
    if (t > e.exp) return no('expired', { mid: e.mid });
    const sk = seenKey(e.from, e.mid);
    if (seen && seen.has(sk)) return no('dup', { mid: e.mid });
    const k = me.pairKey(e.from);
    if (!k) return no('bad');
    const inner = aeadOpen(k, innerAad(e.from, e.to, e.mid, e.ts, e.exp), e.b);
    if (inner === null) return no('bad');
    const body = JSON.parse(inner);
    if (seen) seen.set(sk, e.exp);
    return { ok: true, mid: e.mid, from: e.from, to: e.to, ts: e.ts, exp: e.exp, body };
  } catch { return no('bad'); }
}

// Pangkas pencatat id: buang yang sudah lewat masa berlakunya (amplopnya sendiri sudah ditolak sebagai 'expired', jadi aman dilupakan);
// bila masih melebihi SEEN_CAP, buang yang tertua dicatat. Mengembalikan jumlah yang dibuang.
function pruneSeen(seen, now) {
  const t = Number.isSafeInteger(now) ? now : Date.now();
  let n = 0;
  for (const [k, exp] of seen) if (t > exp) { seen.delete(k); n++; }
  for (const k of seen.keys()) { if (seen.size <= SEEN_CAP) break; seen.delete(k); n++; }
  return n;
}

// Pencatat titipan keluar (langkah 4b): { [penerima]: { [mid]: exp } }, objek biasa supaya bisa disimpan di store.json.
// Retained di broker tidak bisa kita hitung dari sini, jadi pengirim membatasi dirinya sendiri: tiap titipan dicatat sampai exp-nya lewat.
// Mengembalikan jumlah titipan yang dibuang karena sudah lewat masa berlakunya (broker sendiri tidak menghapusnya, tapi penerima menolaknya sebagai 'expired').
function outPrune(out, now) {
  const t = Number.isSafeInteger(now) ? now : Date.now();
  let n = 0;
  for (const to of Object.keys(out)) {
    const m = out[to];
    for (const mid of Object.keys(m)) if (t > m[mid]) { delete m[mid]; n++; }
    if (!Object.keys(m).length) delete out[to];
  }
  return n;
}
function outCount(out, to) {
  if (to === undefined) { let n = 0; for (const k of Object.keys(out)) n += Object.keys(out[k]).length; return n; }
  return out[to] ? Object.keys(out[to]).length : 0;
}
// null bila masih muat; 'peerFull' bila kotak surat penerima ini penuh; 'totalFull' bila seluruh titipan keluar penuh. Panggil outPrune dulu.
function outCheck(out, to) {
  if (outCount(out, to) >= OUT_PER_PEER) return 'peerFull';
  if (outCount(out) >= OUT_TOTAL) return 'totalFull';
  return null;
}
function outAdd(out, to, mid, exp) { (out[to] || (out[to] = {}))[mid] = exp; }
function outRemove(out, to, mid) {
  if (!out[to] || !(mid in out[to])) return false;
  delete out[to][mid];
  if (!Object.keys(out[to]).length) delete out[to];
  return true;
}

module.exports = { seal, open, pruneSeen, outPrune, outCount, outCheck, outAdd, outRemove, OUT_PER_PEER, OUT_TOTAL, topicOf, inboxFilter, parseTopic, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS, MAX_BODY, SKEW_MS, SEEN_CAP };
