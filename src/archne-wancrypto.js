'use strict';
// Kripto mode lintas jaringan (langkah 2): kode jaringan -> netId/netKey, pembungkus presence dan signaling (rencana bagian 4).
// Modul murni (tanpa jaringan, tanpa status); Core memanggilnya lewat wanSeal/wanOpen. Kunci identitas tidak pernah keluar dari Core.
//
// Dua lapis:
//   1. tanda tangan Ed25519 identitas atas [tag, type, from, to, ts, b]  (b = isi persis seperti yang dikirim)
//   2. AES-256-GCM dengan netKey, AAD = netId + '|' + topik (pesan yang dipindah ke topik lain gagal dibuka)
// Signaling antar dua peer yang sudah saling kenal memakai lapis tambahan kunci pasangan pada `b` (flag pk=1).
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_RE = /^[A-Z2-7]{26,64}$/;
const TAG = 'archne-wan1';
const MAX_ENVELOPE = 64 * 1024;  // batas ukuran bungkus (base64) yang mau diproses
const MAX_BODY = 32 * 1024;      // batas isi (SDP besar masih muat)
const SKEW_MS = 5 * 60 * 1000;   // toleransi selisih jam; juga jendela signaling
const PRESENCE_TTL_MS = 15 * 60 * 1000; // presence "online" lebih tua dari ini dianggap basi (klien menyiarkan ulang tiap 5 menit)
const TYPES = ['presence', 'signal'];
const HEX16 = /^[0-9a-f]{16}$/;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function b32(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

// 16 byte acak (128 bit) -> 26 karakter base32, ditampilkan berkelompok 5 (XXXXX-XXXXX-...).
function newCode() { return b32(crypto.randomBytes(16)).match(/.{1,5}/g).join('-'); }

// Kode yang diketik/ditempel: huruf besar, tanpa spasi/tanda hubung. null bila bentuknya tidak sah.
function normCode(s) {
  if (typeof s !== 'string') return null;
  const c = s.toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(c) ? c : null;
}

function derive(code) {
  const c = normCode(code);
  if (!c) throw new Error('Kode jaringan tidak valid');
  return {
    code: c,
    netId: sha(Buffer.from('archne-net-v1\0' + c)).slice(0, 16),
    netKey: Buffer.from(crypto.hkdfSync('sha256', Buffer.from(c), Buffer.from('archne-net-salt-v1'), Buffer.from('archne-net-key-v1'), 32)),
  };
}

const topicOf = (netId, type, id) => `archne/v1/${netId}/${type === 'presence' ? 'p' : 's'}/${id}`;
const topicsFor = (netId, myId) => ({
  netId, mine: topicOf(netId, 'presence', myId), presence: `archne/v1/${netId}/p/+`, inbox: topicOf(netId, 'signal', myId),
});

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

const sigInput = (type, from, to, ts, b) => Buffer.from(JSON.stringify([TAG, type, from, to === null ? '' : to, ts, b]));

// me = { id, pub, privKey, pairKey(id) -> Buffer|null }; wan = derive(...); in = { type, to, body, now }
// Mengembalikan { topic, payload }. Presence: to = null (topik milik pengirim). Signal: to = id penerima.
function seal(me, wan, { type, to, body, now }) {
  if (!TYPES.includes(type)) throw new Error('Jenis tidak dikenal');
  if (type === 'signal' && !HEX16.test(String(to))) throw new Error('Penerima tidak valid');
  if (type === 'presence') to = null;
  const ts = Number.isSafeInteger(now) ? now : Date.now();
  let b = JSON.stringify(body === undefined ? null : body), pk = 0;
  if (b.length > MAX_BODY) throw new Error('Isi terlalu besar');
  const topic = topicOf(wan.netId, type, type === 'presence' ? me.id : to);
  if (type === 'signal') {
    const k = me.pairKey(to);
    if (k) { b = aeadSeal(k, Buffer.from(JSON.stringify([TAG, me.id, to, ts])), b); pk = 1; }
  }
  const sig = crypto.sign(null, sigInput(type, me.id, to, ts, b), me.privKey).toString('base64');
  const env = JSON.stringify({ v: 1, type, from: me.id, to, ts, b, pk, pub: me.pub, sig });
  return { topic, payload: aeadSeal(wan.netKey, Buffer.from(wan.netId + '|' + topic), env) };
}

// Mengembalikan { type, from, to, ts, body, pk } atau null (apa pun alasannya: kode salah, rusak, tanda tangan salah, basi, bukan untukku).
// `seen` (Map iv -> waktu, milik Core) mencegah pemutaran ulang signaling yang sama persis.
function open(me, wan, { topic, payload, now, seen }) {
  try {
    if (typeof payload !== 'string' || typeof topic !== 'string' || payload.length > MAX_ENVELOPE) return null;
    const t = Number.isSafeInteger(now) ? now : Date.now();
    const plain = aeadOpen(wan.netKey, Buffer.from(wan.netId + '|' + topic), payload);
    if (plain === null) return null;
    const e = JSON.parse(plain);
    if (!e || e.v !== 1 || !TYPES.includes(e.type) || !HEX16.test(String(e.from)) || typeof e.pub !== 'string' || typeof e.sig !== 'string' || typeof e.b !== 'string') return null;
    if (!Number.isSafeInteger(e.ts) || e.ts <= 0) return null;
    if (e.from === me.id) return null; // gema pesan sendiri
    if (e.from !== sha(Buffer.from(e.pub, 'base64')).slice(0, 16)) return null;
    // topik harus cocok dengan jenis dan alamat di dalam bungkus (bungkus sah tidak bisa dipindah ke topik lain)
    if (e.type === 'presence') { if (e.to !== null || topic !== topicOf(wan.netId, 'presence', e.from)) return null; }
    else { if (e.to !== me.id || topic !== topicOf(wan.netId, 'signal', me.id)) return null; }
    const key = crypto.createPublicKey({ key: Buffer.from(e.pub, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, sigInput(e.type, e.from, e.to, e.ts, e.b), key, Buffer.from(e.sig, 'base64'))) return null;
    let body;
    if (e.type === 'presence') {
      body = JSON.parse(e.b);
      if (!body || typeof body !== 'object') return null;
      if (e.ts - t > SKEW_MS) return null; // dari masa depan
      // Offline (LWT) dibuat saat connect, jadi bisa jauh lebih tua dari online berikutnya: keabsahannya dijaga sid sesi di pemanggil.
      if (body.state === 'online' && t - e.ts > PRESENCE_TTL_MS) return null;
    } else {
      if (Math.abs(t - e.ts) > SKEW_MS) return null;
      if (seen) { // iv GCM 12 byte pertama dari payload luar = pengenal unik bungkus
        const iv = payload.slice(0, 16);
        if (seen.has(iv)) return null;
        seen.set(iv, t);
        if (seen.size > 2000) for (const [k, v] of seen) { if (t - v > SKEW_MS * 2 || seen.size > 1500) seen.delete(k); else break; }
      }
      if (e.pk === 1) {
        const k = me.pairKey(e.from);
        if (!k) return null;
        const inner = aeadOpen(k, Buffer.from(JSON.stringify([TAG, e.from, e.to, e.ts])), e.b);
        if (inner === null) return null;
        body = JSON.parse(inner);
      } else body = JSON.parse(e.b);
    }
    return { type: e.type, from: e.from, to: e.to, ts: e.ts, body, pk: e.pk === 1 };
  } catch { return null; }
}

module.exports = { newCode, normCode, derive, topicOf, topicsFor, seal, open, SKEW_MS, PRESENCE_TTL_MS, MAX_BODY };
