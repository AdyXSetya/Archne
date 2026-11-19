'use strict';
// Tes info media `x` pada tawaran berkas (v0.25.0 Step 0): validasi, batas Publik vs DM/grup, voice chat hanya DM/grup,
// x tidak sah dibuang (tawaran tetap berkas biasa), kompatibel dengan tawaran lama, sendFile({media}), dan sampai ke state penerima.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const O = require('../src/archne-fileoffer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-mediax-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout: ' + label);
}
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o));
const msg = (c, id) => c.getState().messages.find((x) => x.id === id);
const hash = crypto.createHash('sha256').update('x').digest('hex');
const meta = (o) => Object.assign({ v: 1, mode: 'raw', size: 10, psize: 10, hash }, o);
const DM = '0123456789abcdef';

// JPEG buatan: SOI + COM (bantalan sampai panjang yang diminta) + SOF0 (w x h) + EOI. Cukup untuk uji header (bukan gambar yang bisa didekode).
function jpeg(w, h, bytes) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const head = Buffer.from([0xff, 0xd8]), end = Buffer.from([0xff, 0xd9]);
  const pad = Math.max(0, (bytes || 0) - head.length - sof.length - end.length - 4);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, (pad + 2) >> 8, (pad + 2) & 255]), Buffer.alloc(pad, 0x41)]);
  return Buffer.concat([head, pad ? com : Buffer.alloc(0), sof, end]);
}
const b64 = (b) => b.toString('base64');
const small = b64(jpeg(256, 144, 1500)); // 2000 karakter base64
const bad = (x, to, re) => { const r = O.checkX(x, to); assert.strictEqual(r.ok, false, JSON.stringify(x).slice(0, 80) + ' harus ditolak'); if (re) assert(re.test(r.err), r.err); };

(async () => {
  // ---- 1. header JPEG ----
  assert.deepStrictEqual(O.jpegSize(jpeg(256, 144)), { w: 256, h: 144 });
  assert.deepStrictEqual(O.jpegSize(jpeg(10, 20, 900)), { w: 10, h: 20 }, 'segmen COM sebelum SOF dilewati');
  assert.strictEqual(O.jpegSize(Buffer.from('\x89PNG\r\n\x1a\n', 'binary')), null);
  assert.strictEqual(O.jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8])), null, 'terpotong');
  assert.strictEqual(O.jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null, 'EOI tanpa SOF');
  assert.strictEqual(O.jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0])), null, 'dimensi 0');
  ok('jpegSize: membaca lebar/tinggi dari header; PNG, terpotong, tanpa SOF, dimensi 0 -> null');

  // ---- 2. checkX: yang sah ----
  let r = O.checkX({ k: 'img', w: 1920, h: 1080, th: small }, 'public');
  assert(r.ok && r.x.k === 'img' && r.x.w === 1920 && r.x.th === small);
  assert(O.checkX({ k: 'img' }, 'public').ok, 'foto tanpa thumbnail sah');
  assert(O.checkX({ k: 'vid', w: 1280, h: 720, d: 61000, th: small }, DM).ok);
  assert(O.checkX({ k: 'aud', d: 180000 }, 'public').ok);
  assert(O.checkX({ k: 'vc', d: 12000 }, DM).ok && O.checkX({ k: 'vc', d: 12000 }, 'g:abc').ok, 'voice chat sah di DM dan grup');
  r = O.checkX({ k: 'img', w: 5, h: 5, junk: 'x', evil: { a: 1 } }, DM);
  assert(r.ok && !('junk' in r.x) && !('evil' in r.x), 'bidang tak dikenal dibuang');
  ok('checkX: foto/video/audio/voice sah; bidang tak dikenal dibuang');

  // ---- 3. checkX: yang ditolak ----
  bad(null, DM); bad('img', DM); bad([], DM); bad({}, DM, /jenis/); bad({ k: 'gif' }, DM, /jenis/); bad({ k: 'IMG' }, DM, /jenis/);
  bad({ k: 'img', w: 10 }, DM, /lebar/); bad({ k: 'img', w: 0, h: 5 }, DM); bad({ k: 'img', w: 1.5, h: 5 }, DM); bad({ k: 'img', w: 99999, h: 5 }, DM); bad({ k: 'img', w: '10', h: 5 }, DM);
  bad({ k: 'aud', w: 10, h: 10 }, DM, /foto\/video/); bad({ k: 'img', d: 1000 }, DM, /durasi/);
  bad({ k: 'vid', d: 0 }, DM); bad({ k: 'vid', d: -5 }, DM); bad({ k: 'vid', d: 1e12 }, DM); bad({ k: 'vid', d: 1.5 }, DM); bad({ k: 'vid', d: NaN }, DM);
  bad({ k: 'aud', th: small }, DM, /foto\/video/);
  ok('checkX: jenis, lebar/tinggi, durasi yang aneh atau tidak pada tempatnya ditolak');

  // ---- 4. thumbnail ----
  bad({ k: 'img', th: 'bukan base64!' }, DM, /base64/); bad({ k: 'img', th: 'abc' }, DM, /base64/); bad({ k: 'img', th: '' }, DM, /base64/); bad({ k: 'img', th: 123 }, DM, /base64/);
  bad({ k: 'img', th: b64(Buffer.from('\x89PNG\r\n\x1a\n0000', 'binary')) }, DM, /JPEG/);
  bad({ k: 'img', th: b64(jpeg(321, 100, 500)) }, DM, /dimensi/); bad({ k: 'img', th: b64(jpeg(100, 321, 500)) }, DM, /dimensi/);
  assert(O.checkX({ k: 'img', th: b64(jpeg(320, 320, 600)) }, DM).ok, '320 px masih boleh');
  const pubMax = b64(jpeg(200, 200, O.TH_MAX.public / 4 * 3)), dmMax = b64(jpeg(200, 200, O.TH_MAX.direct / 4 * 3));
  assert.strictEqual(pubMax.length, O.TH_MAX.public); assert.strictEqual(dmMax.length, O.TH_MAX.direct);
  assert(O.checkX({ k: 'img', th: pubMax }, 'public').ok && O.checkX({ k: 'img', th: dmMax }, DM).ok);
  bad({ k: 'img', th: dmMax }, 'public', /terlalu besar/);
  bad({ k: 'img', th: b64(jpeg(200, 200, O.TH_MAX.direct / 4 * 3 + 3)) }, DM, /terlalu besar/);
  ok('thumbnail: base64 ketat, harus JPEG, maks 320 px; batas karakter Publik (' + O.TH_MAX.public + ') lebih kecil dari DM/grup (' + O.TH_MAX.direct + ')');

  // ---- 5. voice chat ----
  bad({ k: 'vc', d: 5000 }, 'public', /Publik/);
  bad({ k: 'vc' }, DM, /durasi/); bad({ k: 'vc', d: O.VC_MAX_MS + 1 }, DM, /panjang/);
  assert(O.checkX({ k: 'vc', d: O.VC_MAX_MS }, DM).ok);
  bad({ k: 'vc', d: 5000, th: small }, DM, /gambar/); bad({ k: 'vc', d: 5000, w: 5, h: 5 }, DM, /gambar/);
  ok('voice chat: hanya DM/grup, wajib punya durasi, maks 5 menit, tanpa gambar');

  // ---- 6. encode/parse ----
  const enc = (x, to) => O.encodeOffer('a.jpg', meta(), x, to);
  let off = O.parseOffer(enc({ k: 'img', w: 640, h: 480, th: small }, DM), DM);
  assert.deepStrictEqual(off.x, { k: 'img', w: 640, h: 480, th: small });
  assert.strictEqual(off.name, 'a.jpg'); assert.strictEqual(off.meta.size, 10);
  assert.strictEqual(O.parseOffer(O.encodeOffer('a.txt', meta()), 'public').x, undefined, 'tawaran lama/tanpa x: tidak ada x');
  assert.deepStrictEqual(Object.keys(JSON.parse(O.encodeOffer('a.txt', meta()).slice(O.FILE.length))).sort(), ['m', 'n'], 'tanpa x: format byte-per-byte sama dengan sebelumnya');
  assert.throws(() => enc({ k: 'vc', d: 5000 }, 'public'), /Info media tidak sah/);
  assert.throws(() => enc({ k: 'xyz' }, DM), /Info media tidak sah/);
  // penerima: x tidak sah / jenis baru dibuang, tawaran tetap sah sebagai berkas biasa
  const raw = (x) => O.FILE + JSON.stringify({ n: 'a.bin', m: meta(), x });
  for (const [x, to] of [[{ k: 'vc', d: 5000 }, 'public'], [{ k: 'hologram' }, DM], [{ k: 'img', th: 'zzzz' }, DM], [{ k: 'img', th: pubMax + 'AAAA' }, 'public'], ['teks', DM], [7, DM], [[], DM]]) {
    const o = O.parseOffer(raw(x), to);
    assert(o && o.name === 'a.bin' && o.meta.size === 10 && o.x === undefined, 'x tidak sah dibuang: ' + JSON.stringify(x).slice(0, 40));
  }
  // x tidak mengubah keabsahan meta: meta yang melanggar batas tetap ditolak
  assert.strictEqual(O.parseOffer(O.FILE + JSON.stringify({ n: 'a', m: meta({ size: 60 * 1048576, psize: 60 * 1048576 }), x: { k: 'img' } }), 'public'), null);
  // seluruh tawaran dengan thumbnail maksimum tetap di bawah batas teks pesan (10000)
  assert(enc({ k: 'img', w: 16384, h: 16384, d: undefined, th: pubMax }, 'public').length < 10000 && enc({ k: 'vid', w: 16384, h: 16384, d: 864e5, th: dmMax }, DM).length < 10000);
  ok('encode/parse: roundtrip; tanpa x byte-per-byte sama dengan format lama; x tidak sah/jenis baru dibuang tanpa menolak tawaran; tawaran terbesar < 10000 karakter');

  // ---- 7. Core: sendFile({media}) ----
  const A = mk('A', { tickMs: 100, syncMs: 150 }), B = mk('B', { tickMs: 100, syncMs: 150 });
  await A.start(); await B.start();
  await A.addPeer('127.0.0.1', B.port);
  await until(() => A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online), 3000, 'A-B online');
  const img = path.join(tmp, 'foto.jpg'); fs.writeFileSync(img, crypto.randomBytes(5000));

  const m1 = await A.sendFile(img, 'public', { media: { k: 'img', w: 256, h: 144, th: small } });
  await until(() => msg(B, m1.id), 3000, 'B menerima foto publik');
  assert.deepStrictEqual(msg(B, m1.id).file.x, { k: 'img', w: 256, h: 144, th: small });
  assert.deepStrictEqual(msg(A, m1.id).file.x, { k: 'img', w: 256, h: 144, th: small }, 'pengirim juga melihat x');
  assert.strictEqual(msg(B, m1.id).text, '📎 foto.jpg');

  const m2 = await A.sendFile(img, B.id, { media: { k: 'img', w: 256, h: 144, th: b64(jpeg(256, 144, 5000)) } });
  assert(m2.kind === 'e1' && !m2.text.includes(small.slice(0, 20)), 'DM: x ikut terenkripsi');
  await until(() => msg(B, m2.id), 3000, 'B menerima foto DM');
  assert.strictEqual(msg(B, m2.id).file.x.k, 'img');

  await A.createGroup('G', [B.id]);
  await until(() => A.getState().groups.length && B.getState().groups.length, 4000, 'grup');
  const gid = 'g:' + A.getState().groups[0].id;
  const m3 = await A.sendFile(img, gid, { media: { k: 'vid', d: 5000, w: 640, h: 360 } });
  await until(() => msg(B, m3.id), 3000, 'B menerima video grup');
  assert.deepStrictEqual(msg(B, m3.id).file.x, { k: 'vid', w: 640, h: 360, d: 5000 });

  const m4 = await A.sendFile(img, 'public');
  await until(() => msg(B, m4.id), 3000, 'B menerima berkas biasa');
  assert.strictEqual(msg(B, m4.id).file.x, undefined, 'tanpa media: tanpa x');
  ok('sendFile({media}): foto Publik, foto DM (terenkripsi), video grup sampai ke state penerima lewat x; tanpa media tidak ada x');

  // ---- 8. sendFile menolak media tidak sah / voice, tanpa pesan dan tanpa sisa ----
  const n0 = Object.keys(A.store.msgs).length, out0 = fs.readdirSync(path.join(A.opts.dataDir, 'out')).length;
  await assert.rejects(() => A.sendFile(img, B.id, { media: { k: 'vc', d: 5000 } }), /Voice chat tidak bisa dikirim sebagai berkas/);
  await assert.rejects(() => A.sendFile(img, 'public', { media: { k: 'img', th: dmMax } }), /Info media tidak sah/);
  await assert.rejects(() => A.sendFile(img, 'public', { media: { k: 'aneh' } }), /Info media tidak sah/);
  assert.strictEqual(Object.keys(A.store.msgs).length, n0, 'tidak ada pesan');
  assert.strictEqual(fs.readdirSync(path.join(A.opts.dataDir, 'out')).length, out0, 'tidak ada sisa di folder out');
  ok('sendFile: voice chat tidak bisa lewat jalur berkas; media tidak sah ditolak sebelum menulis apa pun');

  // ---- 9. peer yang mengirim x tidak sah: tawaran diterima, x dibuang ----
  const forged = A._makeMsg('public', null, raw({ k: 'vc', d: 5000 }));
  assert.strictEqual(B._ingest(forged, true), 'new');
  assert.strictEqual(msg(B, forged.id).file.x, undefined, 'voice di Publik tidak pernah tampil sebagai voice');
  assert.strictEqual(msg(B, forged.id).file.name, 'a.bin');
  ok('tawaran dari peer dengan x tidak sah (voice di Publik): diterima sebagai berkas biasa, x tidak sampai ke UI');

  await A.stop(); await B.stop();
  console.log(`\n${pass} tes lulus`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
