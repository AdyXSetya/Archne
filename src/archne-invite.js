'use strict';
// Undangan mode lintas jaringan (langkah 6): archne://join?v=1&d=<base64url(JSON)>, JSON { code, broker, turn? }.
// Dibuat dan dibaca di Core (kode dan kredensial TURN tidak pernah lewat UI selain sebagai teks undangan yang diminta pemiliknya).
// Node 12 ke atas; tanpa ?. dan ??.
const WanCrypto = require('./archne-wancrypto');
const Turn = require('./archne-turn');
const { ek } = require('./core/archne-ecode'); // i18n (E9e)

const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
const MAX_D = 4096;                     // batas panjang bagian d (karakter)
const LINK_RE = /archne:\/\/join\?[^\s"'<>]+/i;

// wss:// untuk broker publik; ws:// hanya untuk localhost (percobaan). Sama dengan validBroker di renderer/archne-wan.js.
function validBroker(u) {
  if (typeof u !== 'string' || u.length > 300) return false;
  if (/^wss:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u)) return true;
  return /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i.test(u);
}
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad'); return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); };

// obj: { code, broker, turn? } -> teks tautan
function make(obj) {
  const o = { code: obj.code, broker: obj.broker };
  if (obj.turn && obj.turn.provider && obj.turn.provider !== 'none') o.turn = obj.turn;
  return 'archne://join?v=1&d=' + b64u(JSON.stringify(o));
}

// text: tautan, atau teks apa pun yang memuat tautan. Melempar Error berpesan Indonesia bila tidak sah.
// Hasil: { code, netId, broker, turn? } (turn sudah dinormalkan). Tidak mengubah apa pun.
function parse(text) {
  if (typeof text !== 'string' || text.length > 8192) throw ek('e.inv.bad', null, 'Undangan tidak valid');
  const m = LINK_RE.exec(text);
  if (!m) throw ek('e.inv.noLink', null, 'Tidak ada tautan undangan (archne://join?...) di teks itu');
  let q;
  try { q = new URL(m[0].replace(/^archne:/i, 'http:')).searchParams; } catch { throw ek('e.inv.broken', null, 'Undangan rusak'); }
  const v = q.get('v');
  if (v !== '1') throw ek('e.inv.version', { v: String(v).slice(0, 10) }, 'Versi undangan tidak dikenal ({v}). Perbarui Archne.');
  const d = q.get('d');
  if (!d || d.length > MAX_D) throw ek('e.inv.brokenBig', null, 'Undangan rusak atau terlalu besar');
  let j;
  try { j = JSON.parse(unb64u(d)); } catch { throw ek('e.inv.broken', null, 'Undangan rusak'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw ek('e.inv.broken', null, 'Undangan rusak');
  let w;
  try { w = WanCrypto.derive(j.code); } catch { throw ek('e.inv.badCode', null, 'Kode jaringan di undangan tidak sah'); }
  const broker = j.broker === undefined || j.broker === null || j.broker === '' ? DEFAULT_BROKER : j.broker;
  if (!validBroker(broker)) throw ek('e.inv.badBroker', null, 'Alamat broker di undangan tidak sah');
  const out = { code: w.code, netId: w.netId, broker };
  if (j.turn !== undefined && j.turn !== null) { out.turn = Turn.normalize(j.turn); if (out.turn.provider === 'none') delete out.turn; }
  return out;
}

module.exports = { make, parse, validBroker, DEFAULT_BROKER };
