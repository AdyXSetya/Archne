'use strict';
// Tes reaksi pesan (langkah 2 / rx1): validasi emoji tanpa ICU (diterima / ditolak / kanonis / fuzz berbenih + pembanding Intl.Segmenter bila ada),
// register LWW per (pesan, pengirim), konvergensi (semua permutasi + acak), batas, pending, pembatas laju, batching, pesan kontrol.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const Rx = require('../src/archne-reactions');
const Pin = require('../src/archne-pins');

let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const id = (c) => c.repeat(16);
const A = id('a'), B = id('b'), C = id('c'), D = id('d'), OUT = id('e');
const mid = (n) => n.toString(16).padStart(32, '0');
const rnd = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const tx = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const cps = (s) => Array.from(s, (c) => c.codePointAt(0));
const canon = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, Object.keys(m[k]).sort().map((b) => [b, m[k][b].e, m[k][b].ts])]));
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map((p) => [x].concat(p))));
const shuffle = (a, r) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const HEART = '\u2764\uFE0F', SMILE = '\u263A\uFE0F';

// 1. emoji sah dan bentuk kanonisnya
{
  const good = [
    ['👍', '👍'], ['😀', '😀'], ['🤣', '🤣'], ['🥺', '🥺'], ['😭', '😭'], ['🩷', '🩷'], ['🙏', '🙏'],
    ['\u2764', HEART], [HEART, HEART], ['\u263A', SMILE], [SMILE, SMILE],          // dasar bergaya teks selalu diberi VS16 (satu bentuk, satu chip)
    ['⚡', '⚡'], ['⚡\uFE0F', '⚡'], ['✅', '✅'], ['⭐', '⭐'], ['😀\uFE0F', '😀'],      // dasar bergaya emoji: VS16 liar dibuang
    ['\u00A9', '\u00A9\uFE0F'], ['\u24C2', '\u24C2\uFE0F'], ['🕵', '🕵\uFE0F'],
    ['👍🏽', '👍🏽'], ['\u261D\uFE0F\u{1F3FD}', '\u261D\u{1F3FD}'], ['🫶🏽', '🫶🏽'],  // dengan penanda kulit: tanpa VS16
    ['🇮🇩', '🇮🇩'], ['🇺🇸', '🇺🇸'],
    ['1\uFE0F\u20E3', '1\uFE0F\u20E3'], ['1\u20E3', '1\uFE0F\u20E3'], ['#\uFE0F\u20E3', '#\uFE0F\u20E3'], ['*\u20E3', '*\uFE0F\u20E3'], ['0\uFE0F\u20E3', '0\uFE0F\u20E3'],
    ['🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
    ['👨\u200D👩\u200D👧\u200D👦', '👨\u200D👩\u200D👧\u200D👦'],
    ['🏳\uFE0F\u200D🌈', '🏳\uFE0F\u200D🌈'], ['🏳\u200D🌈', '🏳\uFE0F\u200D🌈'],
    ['\u2764\uFE0F\u200D🔥', '\u2764\uFE0F\u200D🔥'], ['\u2764\u200D🔥', '\u2764\uFE0F\u200D🔥'],
    ['🏃\u200D\u2640\uFE0F', '🏃\u200D\u2640\uFE0F'], ['🐻\u200D\u2744\uFE0F', '🐻\u200D\u2744\uFE0F'],
    ['👩🏽\u200D\u2764\uFE0F\u200D💋\u200D👨🏼', '👩🏽\u200D\u2764\uFE0F\u200D💋\u200D👨🏼'], // 10 code point: yang terpanjang yang lazim
    ['  👍  ', '👍'], ['👍\n', '👍'],
  ];
  for (const [i, o] of good) assert.strictEqual(Rx.cleanEmoji(i), o, 'harus sah: ' + JSON.stringify(i) + ' -> ' + JSON.stringify(Rx.cleanEmoji(i)));
  for (const e of Rx.DEFAULTS) assert.strictEqual(Rx.cleanEmoji(e), e, 'bawaan sudah kanonis: ' + e);
  assert.strictEqual(Rx.DEFAULTS.length, 6); assert(Object.isFrozen(Rx.DEFAULTS));
  assert.strictEqual(Rx.DEFAULTS[2], '\u263A\uFE0F', '☺️ membawa VS16');
  assert.strictEqual(cps(Rx.cleanEmoji('👩🏽\u200D\u2764\uFE0F\u200D💋\u200D👨🏼')).length, Rx.EMOJI_MAX_CP);
  assert.strictEqual(Rx.isEmoji('👍'), true); assert.strictEqual(Rx.isEmoji('a'), false);
  ok(good.length + ' emoji sah (bendera, keycap, ZWJ, kulit, tag) dan bentuk kanonisnya; 6 bawaan sudah kanonis');
}

// 2. yang harus ditolak (kanal teks bebas ditutup)
{
  const bad = ['', ' ', '\n', 'a', 'A', '1', '12', 'rx', '你', '٣', '<b>', '😀😀', '👍a', 'a👍', '👍 👍', '👍👍', '☀☀', '\u00A9\u00A9', '😀\u200D', '\u200D😀', '\u200D', '\uFE0F', '\u20E3',
    '\u{1F3FD}', '👍🏽🏽', '👨\u200Da', '😀\u0301', 'e\u0301', '😀\uFE0E', '\u200B', '\u202E', '\u2066',
    '\u{1F1EE}', '🇮🇩🇮', '🇮🇩🇮🇩', '🇮🇩\u200D🇮🇩', '1', '1\uFE0F', '1\u20E3\u20E3', 'a\u20E3', '1\u200D😀', '🏴\u{E0067}\u{E007F}', '🏴\u{E0067}\u{E0062}', '\u{E0067}\u{E007F}',
    '\uD83D', '\uDE00', '😀\uD83D', '\uD83D😀', '👨\u200D👨\u200D👨\u200D👨\u200D👨\u200D👨', '😀'.repeat(20), '\u0000', '😀\u0000', '\u00A0\u00A0',
    null, undefined, 5, true, [], ['👍'], { e: '👍' }];
  for (const b of bad) assert.strictEqual(Rx.cleanEmoji(b), null, 'harus ditolak: ' + JSON.stringify(b));
  assert.strictEqual(Rx.cleanEmoji('👨\u200D👨\u200D👨\u200D👨\u200D👨'), '👨\u200D👨\u200D👨\u200D👨\u200D👨', 'empat sambungan ZWJ (9 code point) masih boleh');
  assert.strictEqual(cps(Rx.cleanEmoji('👨\u200D👨\u200D👨\u200D👨\u200D👨')).length, 9);
  assert.strictEqual(Rx.cleanEmoji('👨\u200D👨\u200D👨\u200D👨\u200D👨\u200D👨\u200D👨'), null, 'lima sambungan sudah 11 code point: ditolak oleh batas panjang');
  ok(bad.length + ' masukan ditolak (teks, dua emoji, pecahan urutan, surrogate yatim, kontrol, bukan string)');
}

// 3. fuzz berbenih: tidak pernah melempar, idempoten, kanonis, ≤10 code point; bila Intl.Segmenter ada, hasil selalu SATU grafem
{
  const pool = ['👍', '😀', '\u2764', '\u263A', '⚡', '👨', '👩', '🏴', '🏳', '🌈', '🔥', '💋', '\u2640', '\u2744', '🇮', '🇩', '1', '#', 'a', ' ', '\n', 'é',
    '\uFE0F', '\uFE0E', '\u200D', '\u20E3', '\u{1F3FD}', '\u{1F3FB}', '\u{E0067}', '\u{E0062}', '\u{E007F}', '\u0301', '\uD83D', '\uDE00', '\u202E', '\u0000', '\u00A9', '🫶', '🩷'];
  const r = rnd(20260116);
  let accepted = 0, seg = null;
  try { seg = new Intl.Segmenter('en', { granularity: 'grapheme' }); } catch { seg = null; }
  for (let k = 0; k < 40000; k++) {
    const n = 1 + Math.floor(r() * 9);
    let s = ''; for (let i = 0; i < n; i++) s += pool[Math.floor(r() * pool.length)];
    let o; assert.doesNotThrow(() => { o = Rx.cleanEmoji(s); }, 'melempar untuk ' + JSON.stringify(s));
    if (o === null) continue;
    accepted++;
    assert.strictEqual(Rx.cleanEmoji(o), o, 'tidak idempoten: ' + JSON.stringify(s));
    assert(cps(o).length <= Rx.EMOJI_MAX_CP);
    if (seg) assert.strictEqual(Array.from(seg.segment(o)).length, 1, 'bukan satu grafem: ' + JSON.stringify(o));
  }
  assert(accepted > 2000, 'fuzz harus cukup sering menghasilkan emoji sah (' + accepted + ')');
  // dua emoji sah yang ditempel TANPA ZWJ tidak boleh lolos
  const ones = ['👍', '😀', HEART, SMILE, '🇮🇩', '1\uFE0F\u20E3', '👍🏽', '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', '🩷', '⚡'];
  for (const a of ones) for (const b of ones) assert.strictEqual(Rx.cleanEmoji(a + b), null, 'dua emoji lolos: ' + a + b);
  ok('fuzz 40.000 masukan: tak melempar, idempoten, ≤10 code point, ' + accepted + ' diterima' + (seg ? ', semuanya SATU grafem menurut Intl.Segmenter' : ' (Intl.Segmenter tak ada: pembanding dilewati)') + '; 100 pasangan tempel ditolak');
}

// 4. tanpa ICU: sumber modul tidak memakai \p{...}, Intl, normalize, Segmenter (runtime Node di HP tanpa ICU)
{
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'archne-reactions.js'), 'utf8').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const bad of [/\\p\{/, /\\P\{/, /\bIntl\b/, /\.normalize\(/, /Segmenter/, /matchAll\(/, /\bstructuredClone\b/, /\?\?=|\|\|=|&&=/, /\.at\(/, /\.flat\(/, /\.replaceAll\(/])
    assert(!bad.test(code), 'memakai fitur yang tak ada di Node 12 / tanpa ICU: ' + bad);
  ok('sumber tidak memakai \\p{}, Intl, normalize, Segmenter, matchAll, ??=, .at, .replaceAll');
}

// 5. rekaman: cleanRec
{
  const r = Rx.cleanRec({ m: mid(1), e: '\u2764', ts: 5, x: 'abaikan' });
  assert.deepStrictEqual(r, { m: mid(1), e: HEART, ts: 5 });
  assert.deepStrictEqual(Rx.cleanRec({ m: mid(1), e: '', ts: 0 }), { m: mid(1), e: '', ts: 0 }, 'e kosong = cabut');
  for (const x of [null, 5, 'x', [], [1], { m: mid(1), e: '👍' }, { m: mid(1), ts: 1 }, { e: '👍', ts: 1 }, { m: 'abc', e: '👍', ts: 1 }, { m: mid(255).toUpperCase(), e: '👍', ts: 1 },
    { m: [mid(1)], e: '👍', ts: 1 }, { m: mid(1), e: ['👍'], ts: 1 }, { m: mid(1), e: 'a', ts: 1 }, { m: mid(1), e: '😀😀', ts: 1 }, { m: mid(1), e: ' ', ts: 1 },
    { m: mid(1), e: '👍', ts: -1 }, { m: mid(1), e: '👍', ts: 1.5 }, { m: mid(1), e: '👍', ts: NaN }, { m: mid(1), e: '👍', ts: Infinity }, { m: mid(1), e: '👍', ts: '5' }, { m: mid(1), e: '👍', ts: 2 ** 60 }])
    assert.strictEqual(Rx.cleanRec(x), null, 'harus ditolak: ' + JSON.stringify(x));
  ok('cleanRec: kanonis, cabut = e kosong, 21 bentuk rusak ditolak');
}

// 6. toggle lokal: pasang, ganti, cabut, ts selalu naik
{
  const m = {};
  let r = Rx.toggle(m, A, mid(1), '👍', 10);
  assert.deepStrictEqual(r, { m: mid(1), e: '👍', ts: 10 });
  assert.strictEqual(Rx.mineOf(m, mid(1), A), '👍');
  r = Rx.toggle(m, A, mid(1), '🩷', 11); assert.strictEqual(r.e, '🩷'); assert.strictEqual(Rx.mineOf(m, mid(1), A), '🩷', 'ganti, bukan tambah');
  r = Rx.toggle(m, A, mid(1), '🩷', 12); assert.strictEqual(r.e, ''); assert.strictEqual(Rx.mineOf(m, mid(1), A), '', 'ketuk yang sama = cabut');
  r = Rx.toggle(m, A, mid(1), '🩷', 12); assert.strictEqual(r.ts, 13, 'ts dinaikkan bila jam tidak maju (selalu menang atas register sendiri)');
  r = Rx.toggle(m, A, mid(1), '🩷', 1); assert.strictEqual(r.e, ''); assert.strictEqual(r.ts, 14, 'jam mundur: tetap naik');
  assert.strictEqual(Rx.toggle(m, A, mid(2), '\u2764', 50).e, HEART, 'masukan dikanonkan');
  assert.strictEqual(Rx.toggle(m, B, mid(2), HEART, 51).e, HEART);
  assert(/Emoji/.test(tx(() => Rx.toggle(m, A, mid(1), 'a', 1))));
  assert(/Emoji/.test(tx(() => Rx.toggle(m, A, mid(1), '😀😀', 1))));
  assert(/Pesan/.test(tx(() => Rx.toggle(m, A, 'abc', '👍', 1))));
  assert(/pengirim/.test(tx(() => Rx.toggle(m, 'zz', mid(1), '👍', 1))));
  assert(/Waktu/.test(tx(() => Rx.toggle(m, A, mid(1), '👍', -1))));
  assert(/Waktu/.test(tx(() => Rx.toggle(m, A, mid(1), '👍', NaN))));
  // batas register per pesan
  const f = {};
  for (let i = 0; i < Rx.RX_MAX_REG_PER_MSG; i++) Rx.toggle(f, (i + 1).toString(16).padStart(16, '0'), mid(9), '👍', 1);
  assert(/Terlalu banyak/.test(tx(() => Rx.toggle(f, id('f'), mid(9), '👍', 1))));
  assert.doesNotThrow(() => Rx.toggle(f, '0000000000000001', mid(9), '🩷', 2), 'yang sudah punya register tetap boleh mengganti');
  ok('toggle: pasang / ganti / cabut, ts naik walau jam mundur, galat jelas, batas ' + Rx.RX_MAX_REG_PER_MSG + ' register per pesan');
}

// 7. penerimaan: reject / pending / stale / applied
{
  const m = {}, M = mid(7);
  const part = (x) => x === A || x === B || x === C;
  const o = { isParticipant: part, known: (x) => x === M || x === mid(8), maxTs: 1000 };
  assert.strictEqual(Rx.applyRemote(m, A, { m: M, e: '👍', ts: 10 }, o), 'applied');
  assert.strictEqual(Rx.applyRemote(m, A, { m: M, e: '👍', ts: 10 }, o), 'stale', 'sama persis = stale (idempoten)');
  assert.strictEqual(Rx.applyRemote(m, A, { m: M, e: '😭', ts: 9 }, o), 'stale', 'lebih lama = stale');
  assert.strictEqual(Rx.applyRemote(m, A, { m: M, e: '😭', ts: 11 }, o), 'applied'); assert.strictEqual(m[M][A].e, '😭');
  assert.strictEqual(Rx.applyRemote(m, OUT, { m: M, e: '👍', ts: 20 }, o), 'reject', 'bukan peserta');
  assert.strictEqual(Rx.applyRemote(m, 'zz', { m: M, e: '👍', ts: 20 }, o), 'reject', 'pengirim bukan ID');
  assert.strictEqual(Rx.applyRemote(m, [A], { m: M, e: '👍', ts: 20 }, o), 'reject', 'pengirim array');
  assert.strictEqual(Rx.applyRemote(m, B, { m: M, e: 'a', ts: 20 }, o), 'reject', 'bukan emoji');
  assert.strictEqual(Rx.applyRemote(m, B, { m: M, e: '👍', ts: 1001 }, o), 'reject', 'ts melewati maxTs');
  assert.strictEqual(Rx.applyRemote(m, B, { m: M, e: '👍', ts: 1000 }, o), 'applied', 'tepat di maxTs masih boleh');
  assert.strictEqual(Rx.applyRemote(m, C, { m: mid(99), e: '👍', ts: 5 }, o), 'pending', 'sasaran belum ada / beda chat');
  assert(!m[mid(99)], 'pending tidak menyentuh peta');
  assert.strictEqual(Rx.applyRemote(m, C, null, o), 'reject');
  assert.strictEqual(Rx.applyRemote(m, C, { m: M, e: '', ts: 4 }, o), 'applied', 'cabut tanpa reaksi sebelumnya: tombstone tersimpan');
  assert.strictEqual(Rx.applyRemote(m, C, { m: M, e: '👍', ts: 3 }, o), 'stale', 'reaksi lama yang telat tidak menghidupkan lagi yang sudah dicabut');
  assert.strictEqual(Rx.applyRemote(m, C, { m: M, e: '👍', ts: 5 }, o), 'applied');
  assert.strictEqual(Rx.applyRemote({}, OUT, { m: M, e: '👍', ts: 1 }), 'applied', 'tanpa opsi: tidak ada pagar tambahan');
  // pengirim tidak bisa bereaksi atas nama orang lain: nama pengirim TIDAK dibaca dari isi rekaman
  const m2 = {};
  assert.strictEqual(Rx.applyRemote(m2, A, { m: M, e: '👍', ts: 1, by: B, from: B }, o), 'applied');
  assert.deepStrictEqual(Object.keys(m2[M]), [A], 'by/from di dalam rekaman diabaikan');
  // batas register per pesan
  const f = {}, ids = [];
  for (let i = 0; i < Rx.RX_MAX_REG_PER_MSG; i++) { const x = (i + 1).toString(16).padStart(16, '0'); ids.push(x); assert.strictEqual(Rx.applyRemote(f, x, { m: M, e: '👍', ts: 1 }), 'applied'); }
  assert.strictEqual(Rx.applyRemote(f, id('f'), { m: M, e: '👍', ts: 1 }), 'reject', 'peserta baru di atas batas ditolak');
  assert.strictEqual(Rx.applyRemote(f, ids[0], { m: M, e: '😭', ts: 2 }), 'applied', 'yang sudah ada tetap bisa mengganti');
  ok('applyRemote: reject / pending / stale / applied, tombstone menahan reaksi lama, pengirim hanya dari penanda tangan, batas per pesan');
}

// 8. konvergensi: semua permutasi, lalu acak + duplikat, hasil sama dengan pembanding independen
{
  const M = mid(3), M2 = mid(4);
  const recs = [[A, { m: M, e: '👍', ts: 5 }], [A, { m: M, e: '🩷', ts: 9 }], [A, { m: M, e: '', ts: 7 }], [B, { m: M, e: '😭', ts: 9 }], [B, { m: M, e: '😭', ts: 9 }]];
  const outs = new Set();
  for (const p of perms(recs)) { const m = {}; for (const [f, r] of p) Rx.applyRemote(m, f, r); outs.add(canon(m)); }
  assert.strictEqual(outs.size, 1, 'semua ' + perms(recs).length + ' urutan menghasilkan peta yang sama');
  const m = {}; for (const [f, r] of recs) Rx.applyRemote(m, f, r);
  assert.strictEqual(m[M][A].e, '🩷'); assert.strictEqual(m[M][A].ts, 9);
  // seri ts: emoji yang lebih besar menang, di semua urutan
  const t = new Set();
  for (const p of perms([[A, { m: M, e: '👍', ts: 5 }], [A, { m: M, e: '🩷', ts: 5 }], [A, { m: M, e: '😭', ts: 5 }]])) { const x = {}; for (const [f, r] of p) Rx.applyRemote(x, f, r); t.add(x[M][A].e); }
  assert.strictEqual(t.size, 1, 'seri ts ditentukan deterministik');
  // acak: 400 rekaman, 3 pengirim, 5 pesan, 3 replika dengan urutan + duplikat berbeda
  const r = rnd(7), senders = [A, B, C], msgs = [1, 2, 3, 4, 5].map(mid), em = ['👍', '🩷', '😭', '', HEART, '🤣'];
  const all = [];
  for (let i = 0; i < 400; i++) all.push([senders[Math.floor(r() * 3)], { m: msgs[Math.floor(r() * 5)], e: em[Math.floor(r() * em.length)], ts: Math.floor(r() * 60) }]);
  const want = {};
  for (const [f, x] of all) { const e = Rx.cleanRec(x), c = want[e.m] && want[e.m][f]; if (!c || Rx.newer(e, c)) (want[e.m] || (want[e.m] = {}))[f] = { e: e.e, ts: e.ts }; } // pembanding: ambil yang terbesar
  for (let k = 0; k < 3; k++) {
    const rep = {};
    for (const [f, x] of shuffle(all.concat(shuffle(all, r).slice(0, 150)), r)) Rx.applyRemote(rep, f, x);
    assert.strictEqual(canon(rep), canon(want), 'replika ' + k + ' tidak konvergen');
  }
  // idempoten: menerapkan ulang semuanya tidak mengubah apa pun
  const before = canon(want); for (const [f, x] of all) assert.strictEqual(Rx.applyRemote(want, f, x), 'stale'); assert.strictEqual(canon(want), before);
  ok('konvergen: semua permutasi, seri ts deterministik, 3 replika acak (400 rekaman + duplikat) = pembanding, penerapan ulang = stale semua');
}

// 9. applyAll: satu pesan kontrol; batas 10 rekaman; prune sekali
{
  const m = {}, rs = [];
  for (let i = 0; i < 14; i++) rs.push({ m: mid(i + 1), e: '👍', ts: 1 });
  const res = Rx.applyAll(m, A, rs.concat([{ m: mid(1), e: 'x', ts: 1 }]));
  assert.strictEqual(res.length, 10, 'hanya 10 rekaman pertama diproses');
  assert(res.every((x) => x === 'applied'));
  assert.deepStrictEqual(Rx.applyAll(m, A, 'bukan array'), []);
  assert.deepStrictEqual(Rx.applyAll(m, A, [null, 5, { m: mid(1), e: '😭', ts: 2 }]), ['reject', 'reject', 'applied']);
  ok('applyAll: ≤10 rekaman per pesan, hasil sejajar, masukan bukan array diabaikan');
}

// 10. tampilan: chip terurut, batas 12 jenis, mine, who
{
  const m = {}, M = mid(5);
  const put = (by, e, ts) => Rx.applyRemote(m, by, { m: M, e, ts });
  put(A, '👍', 1); put(B, '🩷', 2); put(C, '🩷', 3); put(D, '😭', 4);
  let s = Rx.summary(m, M, A);
  assert.deepStrictEqual(s.map((x) => [x.e, x.n, x.mine]), [['🩷', 2, false], ['👍', 1, true], ['😭', 1, false]], 'terbanyak dulu, lalu yang lebih dulu muncul');
  assert.deepStrictEqual(s[0].by, [B, C], 'pelaku terlama dulu');
  assert.deepStrictEqual(Rx.who(m, M, '🩷'), [B, C]); assert.deepStrictEqual(Rx.who(m, M, 'z'), []); assert.deepStrictEqual(Rx.who(m, M, ''), [], 'who tidak membuka tombstone');
  put(B, '', 5); // B mencabut
  s = Rx.summary(m, M, B);
  assert.deepStrictEqual(s.map((x) => [x.e, x.n]), [['👍', 1], ['🩷', 1], ['😭', 1]]); assert(s.every((x) => !x.mine), 'yang dicabut tidak tampil dan bukan milikku');
  assert.deepStrictEqual(Rx.summary(m, mid(6), A), []); assert.strictEqual(Rx.mineOf(m, mid(6), A), '');
  // batas 12 jenis
  const big = {}, kinds = ['👍', '🩷', '😭', '🤣', '🥺', '😀', '🔥', '🎉', '🙏', '👏', '😮', '😢', '😡', '🤔', '✅'];
  kinds.forEach((e, i) => Rx.applyRemote(big, (i + 1).toString(16).padStart(16, '0'), { m: M, e, ts: i + 1 }));
  assert.strictEqual(Rx.summary(big, M, A).length, Rx.RX_SHOW_MAX); assert.strictEqual(Rx.RX_SHOW_MAX, 12);
  ok('summary: urutan stabil, mine, tombstone tersembunyi, maksimal 12 jenis; who: pelaku satu emoji');
}

// 11. pembersihan: dropMsg, retain, prune (tombstone dulu), clean dari disk
{
  const m = {};
  Rx.applyRemote(m, A, { m: mid(1), e: '👍', ts: 1 }); Rx.applyRemote(m, A, { m: mid(2), e: '👍', ts: 1 }); Rx.applyRemote(m, A, { m: mid(3), e: '👍', ts: 1 });
  assert.strictEqual(Rx.dropMsg(m, mid(1)), true); assert(!m[mid(1)]);
  assert.strictEqual(Rx.retain(m, (x) => x === mid(2)), 1); assert.deepStrictEqual(Object.keys(m), [mid(2)]);
  // prune: tombstone dibuang lebih dulu, lalu reaksi hidup terlama; deterministik
  const p = {}, N = Rx.RX_MAX_STORE;
  for (let i = 0; i < N; i++) (p[mid(i + 1)] = p[mid(i + 1)] || {})[A] = { e: '👍', ts: 100 + i };          // N hidup
  for (let i = 0; i < 50; i++) p[mid(N + i + 1)] = { [A]: { e: '', ts: 5000 + i } };                         // 50 tombstone (lebih baru!)
  p[mid(N + 100)] = { [B]: { e: '🩷', ts: 1 } };                                                            // hidup paling lama
  assert.strictEqual(Rx.prune(p), 51);
  let total = 0; for (const k of Object.keys(p)) total += Object.keys(p[k]).length;
  assert.strictEqual(total, N);
  assert(!p[mid(N + 1)] && !p[mid(N + 50)], '50 tombstone habis dulu walau lebih baru'); assert(!p[mid(N + 100)], 'lalu yang hidup paling lama');
  assert.strictEqual(Rx.prune(p), 0, 'sudah di bawah batas');
  // clean dari disk
  const raw = { [mid(1)]: { [A]: { e: '\u2764', ts: 3 }, [B]: { e: 'a', ts: 3 }, zz: { e: '👍', ts: 1 }, [C]: { e: '👍', ts: -1 }, [D]: { e: '', ts: 4 }, [OUT]: [1] }, bukan: { [A]: { e: '👍', ts: 1 } }, [mid(2)]: [1, 2], [mid(3)]: null, [mid(4)]: {} };
  const c = Rx.clean(raw);
  assert.deepStrictEqual(c, { [mid(1)]: { [A]: { e: HEART, ts: 3 }, [D]: { e: '', ts: 4 } } });
  for (const x of [null, [], 'x', 5, undefined]) assert.deepStrictEqual(Rx.clean(x), {});
  const many = { [mid(1)]: {} };
  for (let i = 0; i < Rx.RX_MAX_REG_PER_MSG + 40; i++) many[mid(1)][(i + 1).toString(16).padStart(16, '0')] = { e: '👍', ts: i };
  const cm = Rx.clean(many)[mid(1)];
  assert.strictEqual(Object.keys(cm).length, Rx.RX_MAX_REG_PER_MSG); assert(cm['0000000000000100'] && !cm['0000000000000001'], 'yang dipertahankan: terbaru');
  ok('dropMsg / retain; prune: tombstone dulu lalu terlama (' + N + ' maks); clean: buang rusak, kanonkan, batas per pesan');
}

// 12. reaksi yang sasarannya belum tiba
{
  const pend = new Map();
  const R = (i, ts) => ({ m: mid(i), e: '👍', ts });
  assert.strictEqual(Rx.hold(pend, A, R(1, 5), 100), true);
  assert.strictEqual(Rx.hold(pend, A, R(1, 4), 101), false, 'lebih lama dari yang menunggu: dibuang');
  assert.strictEqual(Rx.hold(pend, A, { m: mid(1), e: '🩷', ts: 6 }, 102), true); assert.strictEqual(pend.size, 1, 'satu slot per orang per pesan, yang terbaru menang');
  assert.strictEqual(Rx.hold(pend, B, R(1, 3), 103), true);
  assert.strictEqual(Rx.hold(pend, A, null, 1), false); assert.strictEqual(Rx.hold(pend, 'zz', R(1, 1), 1), false); assert.strictEqual(Rx.hold(pend, A, { m: 'x', e: '👍', ts: 1 }, 1), false);
  const got = Rx.release(pend, mid(1));
  assert.deepStrictEqual(got.map((x) => [x.from, x.rec.e, x.rec.ts]), [[B, '👍', 3], [A, '🩷', 6]], 'dilepas urut ts'); assert.strictEqual(pend.size, 0);
  assert.deepStrictEqual(Rx.release(pend, mid(1)), []);
  // batas per pengirim: yang tergusur adalah yang paling lama milik pengirim itu
  for (let i = 0; i < Rx.RX_PEND_PER_SENDER + 5; i++) Rx.hold(pend, A, R(100 + i, 1), 1000 + i);
  assert.strictEqual(pend.size, Rx.RX_PEND_PER_SENDER);
  assert(!pend.has(A + mid(100)) && pend.has(A + mid(100 + Rx.RX_PEND_PER_SENDER + 4)));
  // batas total: tidak pernah lewat RX_PEND_MAX, dan satu pengirim tidak menggusur sesama lewat batas per pengirim
  const p2 = new Map();
  for (let i = 0; i < 400; i++) Rx.hold(p2, (i % 40 + 1).toString(16).padStart(16, '0'), R(i + 1, 1), i);
  assert(p2.size <= Rx.RX_PEND_MAX);
  // TTL
  const p3 = new Map(); Rx.hold(p3, A, R(1, 1), 0); Rx.hold(p3, B, R(2, 1), Rx.RX_PEND_TTL);
  assert.strictEqual(Rx.gcPending(p3, Rx.RX_PEND_TTL + 1), 1); assert.strictEqual(p3.size, 1); assert(p3.has(B + mid(2)));
  ok('pending: satu slot per orang per pesan, dilepas urut ts, batas per pengirim dan total, kedaluwarsa');
}

// 13. pembatas laju
{
  const L = Rx.limiter({ max: 5, windowMs: 1000 });
  assert.strictEqual(L.take(A, 3, 0), true); assert.strictEqual(L.take(A, 3, 10), false, 'seluruh permintaan ditolak bila melewati batas');
  assert.strictEqual(L.take(A, 2, 20), true); assert.strictEqual(L.take(A, 1, 30), false);
  assert.strictEqual(L.take(B, 5, 30), true, 'kunci lain tidak terpengaruh');
  assert.strictEqual(L.take(A, 5, 1000), true, 'jendela baru'); assert.strictEqual(L.take(A, 1, 1500), false);
  assert.strictEqual(L.take(A, 1, 2000), true);
  assert.strictEqual(L.take(C, 1, 5000), true); assert.strictEqual(L.take(C, 1, 1), true, 'jam mundur jauh: jendela baru, bukan macet selamanya');
  const S = Rx.limiter({ max: 1, windowMs: 10 }, 50);
  for (let i = 0; i < 500; i++) S.take('k' + i, 1, i * 20); // kunci kedaluwarsa disapu; tidak membengkak tanpa batas (tak bisa diperiksa dari luar, cukup tidak melempar)
  assert(Rx.RX_RATE_RECV.max > Rx.RX_RATE_SEND.max && Rx.RX_RATE_SEND.max >= 10);
  ok('limiter: jendela tetap per kunci, tolak-semua, kunci terpisah, jam mundur tidak macet');
}

// 14. batching + pesan kontrol
{
  const q = Rx.queue();
  assert.strictEqual(Rx.enqueue(q, { m: mid(1), e: '👍', ts: 1 }), 1);
  assert.strictEqual(Rx.enqueue(q, { m: mid(1), e: '🩷', ts: 2 }), 1, 'ketukan berulang pada pesan yang sama jadi satu rekaman (terakhir menang)');
  Rx.enqueue(q, { m: mid(2), e: '\u2764', ts: 3 });
  assert(/Rekaman/.test(tx(() => Rx.enqueue(q, { m: 'x', e: '👍', ts: 1 }))));
  assert(/Rekaman/.test(tx(() => Rx.enqueue(q, { m: mid(1), e: 'abc', ts: 1 }))));
  const out = Rx.flush(q);
  assert.strictEqual(out.length, 1); assert.strictEqual(q.size, 0, 'flush mengosongkan');
  assert.deepStrictEqual(Rx.parseCtl(out[0]), [{ m: mid(1), e: '🩷', ts: 2 }, { m: mid(2), e: HEART, ts: 3 }]);
  assert.deepStrictEqual(Rx.flush(q), []);
  // 5 ketukan pada 5 pesan = SATU pesan kontrol (inti batching)
  for (let i = 0; i < 5; i++) Rx.enqueue(q, { m: mid(10 + i), e: '👍', ts: i });
  assert.strictEqual(Rx.flush(q).length, 1);
  // 25 pesan berbeda = 3 pesan kontrol (10 + 10 + 5), tidak ada yang hilang
  for (let i = 0; i < 25; i++) Rx.enqueue(q, { m: mid(100 + i), e: '👍', ts: i });
  const chunks = Rx.flush(q);
  assert.deepStrictEqual(chunks.map((c) => Rx.parseCtl(c).length), [10, 10, 5]);
  assert.strictEqual(Rx.RX_BATCH_MS, 2000);
  // pagar byte (rekaman buatan yang melewati cleanRec, hanya untuk memeriksa pemotongan)
  const fat = []; for (let i = 0; i < 6; i++) fat.push({ m: mid(i + 1), e: 'x'.repeat(2000), ts: i });
  const fc = Rx.encodeAll(fat);
  assert(fc.length >= 2 && fc.every((c) => Buffer.byteLength(c) <= Rx.RX_MAX_CTL_BYTES));
  assert.strictEqual(fc.reduce((n, c) => n + Rx.parseCtl(c).length, 0), 6);
  // satu pesan kontrol berisi 10 rekaman terpanjang tetap jauh di bawah pagar
  const worst = []; for (let i = 0; i < 10; i++) worst.push({ m: mid(i + 1), e: '👩🏽\u200D\u2764\uFE0F\u200D💋\u200D👨🏼', ts: Date.now() * 1000 });
  assert(Buffer.byteLength(Rx.encodeCtl(worst)) < Rx.RX_MAX_CTL_BYTES / 2, 'kasus terburuk ' + Buffer.byteLength(Rx.encodeCtl(worst)) + ' byte');
  // parseCtl / isCtl
  assert.strictEqual(Rx.parseCtl('halo'), null); assert.strictEqual(Rx.parseCtl(5), null); assert.strictEqual(Rx.parseCtl(null), null);
  assert.deepStrictEqual(Rx.parseCtl(Rx.CTL + '{rusak'), [], 'rusak: tetap kontrol (disembunyikan), tidak diterapkan');
  assert.deepStrictEqual(Rx.parseCtl(Rx.CTL + '{"a":1}'), []);
  assert.strictEqual(Rx.parseCtl(Rx.CTL + JSON.stringify(new Array(40).fill({ m: mid(1), e: '👍', ts: 1 }))).length, 10, 'dipotong 10');
  assert.strictEqual(Rx.isCtl(Rx.CTL + '[]'), true); assert.strictEqual(Rx.isCtl('rx:[]'), false); assert.strictEqual(Rx.isCtl(undefined), false);
  assert.strictEqual(Rx.CTL, '\u0001rx:');
  assert.strictEqual(Rx.parseCtl(Pin.encodeCtl([])), null, 'pesan sematan bukan pesan reaksi');
  assert.strictEqual(Pin.parseCtl(out[0]), null, 'pesan reaksi bukan pesan sematan');
  // alur utuh pengirim → penerima
  const m = {}; Rx.applyAll(m, A, Rx.parseCtl(out[0]));
  assert.strictEqual(Rx.mineOf(m, mid(1), A), '🩷'); assert.strictEqual(Rx.mineOf(m, mid(2), A), HEART);
  ok('batching: 5 ketukan = 1 pesan, 25 = 10+10+5, pagar byte, kasus terburuk ' + Buffer.byteLength(Rx.encodeCtl(worst)) + ' byte; parseCtl/isCtl; terpisah dari kontrol sematan');
}

// 15. terakhir dipakai
{
  let l = [];
  l = Rx.pushRecent(l, '👍'); l = Rx.pushRecent(l, '🩷'); l = Rx.pushRecent(l, '👍');
  assert.deepStrictEqual(l, ['👍', '🩷'], 'terbaru di depan, tanpa duplikat');
  assert.deepStrictEqual(Rx.pushRecent(l, '\u2764'), [HEART, '👍', '🩷']);
  assert.deepStrictEqual(Rx.pushRecent(l, 'abc'), ['👍', '🩷'], 'bukan emoji: daftar tidak berubah');
  assert.deepStrictEqual(Rx.pushRecent(['x', '👍', '👍', 5, '😭'], '🩷'), ['🩷', '👍', '😭'], 'daftar dari disk dibersihkan');
  assert.deepStrictEqual(Rx.pushRecent(null, '👍'), ['👍']);
  let big = []; for (const e of ['👍', '🩷', '😭', '🤣', '🥺', '😀', '🔥', '🎉', '🙏', '👏']) big = Rx.pushRecent(big, e);
  assert.strictEqual(big.length, Rx.RX_RECENT_MAX); assert.strictEqual(big[0], '👏');
  ok('pushRecent: MRU, dikanonkan, dibatasi ' + Rx.RX_RECENT_MAX);
}

console.log(pass + ' tes reactions OK');
