'use strict';
// Tes Halaman 4a-1 / 4a-2: reaksi pada postingan (src/archne-pagerx.js + PageStore.react / reactionsFor / withRx + wirePost / wireList). Lokal saja, tanpa jaringan (jaringan: pageserve.js grup 16).
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { PageRx, key } = require('../src/archne-pagerx');
const { PageStore, wirePost, wireList } = require('../src/archne-pagestore');
const RX = require('../src/archne-reactions');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-pagerx-'));
let n = 0, pass = 0;
const fresh = () => path.join(tmp, 'd' + (n++));
const ok = (s) => { pass++; console.log('  OK  ' + s); };
const thr = (f) => { try { f(); } catch (e) { return e.message; } return null; };
const H = (c) => c.repeat(16), P = H('a'), U1 = H('1'), U2 = H('2'), U3 = H('3');

// 1. PageRx: pasang / ganti / cabut / idempotent / tampilan
{
  const f = path.join(fresh(), 'r.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const r = new PageRx(f); assert.strictEqual(key(P), P + P); assert(/^[0-9a-f]{32}$/.test(key(P)));
  assert.deepStrictEqual(r.view(P, U1), { rx: [], mine: '' }, 'kosong');
  assert.strictEqual(r.set(U1, P, '👍', 1000), 'applied'); assert.strictEqual(r.set(U2, P, '👍', 1001), 'applied'); assert.strictEqual(r.set(U3, P, '🩷', 1002), 'applied');
  assert.deepStrictEqual(r.view(P, U1), { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '👍' }, 'terbanyak dulu, mine per penonton, TANPA daftar pelaku');
  assert.deepStrictEqual(r.view(P, U3), { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '🩷' });
  assert.deepStrictEqual(r.view(P, H('9')).mine, '', 'orang lain: mine kosong');
  const w = fs.statSync(f).mtimeMs; assert.strictEqual(r.set(U1, P, '👍', 5000), 'same'); assert.strictEqual(fs.statSync(f).mtimeMs, w, 'keadaan sama = tidak menulis');
  assert.strictEqual(r.set(U1, P, '😭', 1), 'applied'); assert.strictEqual(r.map[key(P)][U1].ts, 1001, 'ts dinaikkan agar mengalahkan register lama walau jam mundur');
  assert.strictEqual(r.view(P, U1).mine, '😭');
  assert.strictEqual(r.set(U1, P, '', 9000), 'applied'); assert.strictEqual(r.view(P, U1).mine, ''); assert.strictEqual(r.map[key(P)][U1].e, '', 'tombstone');
  assert.strictEqual(r.set(H('7'), P, '', 1), 'same', 'cabut tanpa register = tidak membuat tombstone'); assert(!r.map[key(P)][H('7')]);
  assert.strictEqual(r.set(U1, P, ' 🩷 ', 9100), 'applied'); assert.strictEqual(r.view(P, U1).mine, '🩷', 'emoji dikanonkan (spasi dibuang)');
  for (const bad of ['a', 'abc', '👍👍', '<b>', 5, null, undefined, '\u0000', '👍'.repeat(30)]) assert(/Emoji/.test(thr(() => r.set(U1, P, bad, 1))), 'emoji tak sah: ' + String(bad));
  assert(/Id/.test(thr(() => r.set('zz', P, '👍', 1))) && /Id/.test(thr(() => r.set(U1, 'x', '👍', 1))) && /Id/.test(thr(() => r.set(U1, P.toUpperCase(), '👍', 1))));
  ok('PageRx: pasang / ganti / cabut, idempotent tanpa tulis, tombstone hanya bila ada register, ts selalu menang, emoji dikanonkan, 9 emoji + 3 id tak sah ditolak, pelaku tidak keluar');
}

// 2. batas: 256 orang per postingan, total 5000, persisten + berkas rusak
{
  const f = path.join(fresh(), 'r.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const r = new PageRx(f), id = (i) => i.toString(16).padStart(16, '0');
  for (let i = 1; i <= RX.RX_MAX_REG_PER_MSG; i++) r.set(id(i), P, '👍', 100 + i);
  assert(/Terlalu banyak/.test(thr(() => r.set(id(9999), P, '👍', 1))), 'orang ke-257 ditolak');
  assert.strictEqual(r.set(id(5), P, '😭', 1), 'applied', 'yang sudah ada tetap bisa mengganti'); assert.strictEqual(r.set(id(5), P, '', 1), 'applied');
  assert.strictEqual(r.view(P, id(1)).rx.reduce((a, x) => a + x.n, 0), 255);
  const r2 = new PageRx(f); assert.deepStrictEqual(r2.view(P, id(7)), r.view(P, id(7)), 'dibaca ulang identik');
  fs.writeFileSync(f, '{bukan json'); assert.deepStrictEqual(new PageRx(f).view(P, id(1)), { rx: [], mine: '' }, 'rusak = kosong');
  fs.writeFileSync(f, JSON.stringify({ v: 1, map: { [key(P)]: { [U1]: { e: '👍', ts: 5 }, zz: { e: '👍', ts: 5 }, [U2]: { e: '<script>', ts: 5 }, [U3]: { e: '😭', ts: -1 } }, bukan32: { [U1]: { e: '👍', ts: 5 } } } }));
  assert.deepStrictEqual(new PageRx(f).view(P, U1), { rx: [{ e: '👍', n: 1 }], mine: '👍' }, 'isi disk dibersihkan: id / emoji / ts / kunci cacat dibuang');
  fs.writeFileSync(f, JSON.stringify({ v: 2, map: {} })); assert.deepStrictEqual(new PageRx(f).map, {}, 'versi asing diabaikan');
  ok('batas 256 per postingan (yang ada tetap bisa ganti), persisten identik, berkas rusak / versi asing = kosong, isi disk dibersihkan');
}

// 3. PageStore: izin = izin melihat postingan; seragam untuk tidak ada / bukan untukmu / diblokir; hapus postingan membuang reaksi; yatim dibuang saat dibuka
{
  const dir = fresh(), rel = { OWN: 'owner', [U1]: 'friend', [U2]: 'public', [U3]: 'blocked' };
  const ps = new PageStore(dir, { relation: (id) => (id === H('f') ? 'owner' : rel[id] || 'public') });
  const pub = ps.create({ text: 'publik' }), frd = ps.create({ text: 'teman', priv: 'friends' }), OWN = H('f');
  assert.deepStrictEqual(ps.react(U2, pub.id, '👍', 10), { rx: [{ e: '👍', n: 1 }], mine: '👍' }, 'asing bereaksi pada postingan publik');
  assert.deepStrictEqual(ps.react(U1, frd.id, '🩷', 11), { rx: [{ e: '🩷', n: 1 }], mine: '🩷' }, 'teman pada postingan Teman');
  assert.deepStrictEqual(ps.react(OWN, pub.id, '👍', 12), { rx: [{ e: '👍', n: 2 }], mine: '👍' }, 'pemilik pada postingannya sendiri');
  assert.deepStrictEqual(ps.reactionsFor(U1, pub.id), { rx: [{ e: '👍', n: 2 }], mine: '' }, 'mine per penonton');
  const missing = H('d'), before = JSON.stringify(ps.rx.map);
  for (const [who, id, why] of [[U2, frd.id, 'asing pada postingan Teman'], [U3, pub.id, 'diblokir'], [U1, missing, 'tidak ada'], ['xx', pub.id, 'id peminta cacat'], [U1, 'zz', 'id postingan cacat']]) {
    assert.strictEqual(ps.react(who, id, '👍', 20), null, why); assert.strictEqual(ps.reactionsFor(who, id), null, why + ' (baca)');
    assert.strictEqual(ps.react(who, id, 'bukan emoji', 20), null, why + ': emoji cacat pun null, bukan galat (tidak membocorkan)');
  }
  assert.strictEqual(JSON.stringify(ps.rx.map), before, 'penolakan tidak mengubah apa pun');
  assert(/Emoji/.test(thr(() => ps.react(U2, pub.id, 'x', 1))), 'yang boleh melihat + emoji cacat = galat');
  assert.strictEqual(ps.react(U2, pub.id, '', 30).mine, '', 'cabut'); assert.deepStrictEqual(ps.reactionsFor(OWN, pub.id).rx, [{ e: '👍', n: 1 }]);
  // dibuka ulang: tetap ada; hapus postingan membuang reaksinya (juga dari berkas); yatim dibuang saat dibuka
  const ps2 = new PageStore(dir, { relation: ps.relation }); assert.deepStrictEqual(ps2.reactionsFor(U1, frd.id), { rx: [{ e: '🩷', n: 1 }], mine: '🩷' }, 'bertahan sesudah dibuka ulang');
  assert(ps2.remove(pub.id)); assert(!JSON.parse(fs.readFileSync(path.join(dir, 'reactions.json'), 'utf8')).map[key(pub.id)], 'hapus: reaksi ikut keluar dari berkas');
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'reactions.json'), 'utf8')); j.map[key(H('c'))] = { [U1]: { e: '👍', ts: 5 } }; fs.writeFileSync(path.join(dir, 'reactions.json'), JSON.stringify(j));
  const ps3 = new PageStore(dir, { relation: ps.relation }); assert(!ps3.rx.map[key(H('c'))], 'yatim dibuang saat dibuka'); assert(ps3.rx.map[key(frd.id)], 'yang punya postingan tetap');
  const bare = new PageStore(fresh()), bp = bare.create({ text: 'x' }); assert.strictEqual(bare.react(U1, bp.id, '👍', 1).mine, '👍', 'tanpa relation: publik'); assert.strictEqual(bare.react(U1, bare.create({ text: 'y', priv: 'friends' }).id, '👍', 1), null, 'tanpa relation: Teman tertutup');
  ok('PageStore: izin = izin melihat; asing/diblokir/tidak ada/id cacat = null seragam (emoji cacat pun null) tanpa mengubah apa pun; pemilik boleh; bertahan dibuka ulang; hapus + yatim dibuang; tanpa relation tetap ketat');
}

// 4. (4a-2) withRx: yang keluar ke penonton hanya jumlah + reaksinya sendiri; wirePost / wireList memeriksa bentuk dan MENGABAIKAN yang cacat (postingan tetap tampil)
{
  const ps = new PageStore(fresh(), { relation: (id) => (id === U3 ? 'blocked' : 'public') });
  const a = ps.create({ text: 'a' }), b = ps.create({ text: 'b' });
  ps.react(U1, a.id, '👍', 1); ps.react(U2, a.id, '👍', 2); ps.react(H('4'), a.id, '🩷', 3);
  assert.strictEqual(ps.withRx(U1, b), b, 'tanpa reaksi: objek yang sama, tanpa field');
  const w1 = ps.withRx(U1, a), w9 = ps.withRx(H('9'), a);
  assert.deepStrictEqual(w1.rx, [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }]); assert.strictEqual(w1.mine, '👍'); assert.deepStrictEqual(w9.rx, w1.rx); assert(!('mine' in w9), 'bukan pereaksi: tanpa mine');
  assert.strictEqual(a.rx, undefined, 'objek asli tidak diubah'); assert(![U1, U2, H('4')].some((id) => JSON.stringify(w9).includes(id)), 'tak ada id pelaku di keluaran');
  const base = { v: 1, id: a.id, ts: 5, kind: 'text', text: 'x', priv: 'public' };
  const W = (extra) => wirePost(Object.assign({}, base, extra));
  assert.deepStrictEqual(W({ rx: [{ e: '👍', n: 2, by: U1 }], mine: '👍' }), Object.assign({}, base, { rx: [{ e: '👍', n: 2 }], mine: '👍' }), 'sah: bidang liar dalam entri dibuang');
  assert.deepStrictEqual(W({ rx: [{ e: '🩷', n: 256 }] }).rx, [{ e: '🩷', n: 256 }]); assert(!('mine' in W({ rx: [{ e: '🩷', n: 1 }] })));
  const twelve = ['👍', '🩷', '😭', '🤣', '🥺', '😮', '😢', '🙏', '😂', '🔥', '🎉', '👏'].map((e) => ({ e, n: 1 }));
  assert.strictEqual(W({ rx: twelve }).rx.length, 12, '12 jenis boleh'); assert(!('rx' in W({ rx: twelve.concat([{ e: '😎', n: 1 }]) })), '13 jenis diabaikan');
  const BAD = [['bukan larik', 'x'], ['larik kosong', []], ['entri null', [null]], ['emoji bukan emoji', [{ e: 'x', n: 1 }]], ['emoji tak kanonis (spasi)', [{ e: '👍 ', n: 1 }]], ['emoji kosong', [{ e: '', n: 1 }]], ['emoji ganda', [{ e: '👍', n: 1 }, { e: '👍', n: 2 }]],
    ['n 0', [{ e: '👍', n: 0 }]], ['n 257', [{ e: '👍', n: 257 }]], ['n pecahan', [{ e: '👍', n: 1.5 }]], ['n string', [{ e: '👍', n: '2' }]], ['n negatif', [{ e: '👍', n: -1 }]]];
  for (const [why, rx] of BAD) { const w = W({ rx, mine: '👍' }); assert(w && !('rx' in w) && !('mine' in w) && w.text === 'x', 'rx cacat diabaikan, postingan tetap: ' + why); }
  for (const [why, mine] of [['mine kosong', ''], ['mine bukan emoji', 'x'], ['mine angka', 5], ['mine tak kanonis', ' 👍'], ['mine null', null]]) { const w = W({ rx: [{ e: '👍', n: 1 }], mine }); assert(w && !('rx' in w) && !('mine' in w), why); }
  assert(!('mine' in W({ mine: '👍' })) && !('rx' in W({ mine: '👍' })), 'mine tanpa rx diabaikan');
  const L = wireList({ items: [Object.assign({}, base, { rx: [{ e: '👍', n: 3 }], mine: '👍' })], next: null, count: 1 }, { limit: 10 });
  assert.deepStrictEqual(L.items[0].rx, [{ e: '👍', n: 3 }]); assert.strictEqual(L.items[0].mine, '👍'); assert.strictEqual(L.skipped, 0);
  ok('withRx: tanpa reaksi = objek sama, jumlah + mine per penonton, asli tak diubah, tanpa id pelaku; wirePost: sah lolos (bidang liar dibuang, 12 jenis), 12 bentuk rx cacat + 5 mine cacat + mine tanpa rx diabaikan dengan postingan tetap tampil; wireList meneruskan');
}

// 5. (4a-4) wireRxState: hasil pg_rx dari pemilik (tidak dipercaya). Beda dengan hiasan: bentuk cacat = null (ditolak), bukan diabaikan
{
  const { wireRxState } = require('../src/archne-pagestore');
  assert.deepStrictEqual(wireRxState({ rx: [], mine: '' }), { rx: [], mine: '' });
  assert.deepStrictEqual(wireRxState({ rx: [{ e: '👍', n: 2, by: ['x'] }, { e: '🩷', n: 1 }], mine: '🩷', evil: 1 }), { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '🩷' }, 'bidang liar (termasuk by) dibuang');
  assert.deepStrictEqual(wireRxState({ rx: [{ e: '👍', n: 1 }], mine: '' }), { rx: [{ e: '👍', n: 1 }], mine: '' }, 'orang lain bereaksi, aku tidak');
  for (const bad of [null, 5, 'x', {}, { rx: [] }, { mine: '' }, { rx: [], mine: '👍' }, { rx: [{ e: '👍', n: 1 }], mine: '🩷' }, { rx: [{ e: '👍', n: 1 }], mine: 5 }, { rx: [{ e: 'x', n: 1 }], mine: '' }, { rx: [{ e: '👍', n: 0 }], mine: '' }, { rx: [{ e: '👍', n: 257 }], mine: '' }, { rx: [{ e: '👍', n: 1.5 }], mine: '' }, { rx: [{ e: '👍', n: 1 }, { e: '👍', n: 1 }], mine: '' }, { rx: 'x', mine: '' }, { rx: [null], mine: '' }, { rx: new Array(13).fill({ e: '👍', n: 1 }), mine: '' }, { rx: [{ e: ' 👍', n: 1 }], mine: '' }]) assert.strictEqual(wireRxState(bad), null, JSON.stringify(bad).slice(0, 70));
  ok('wireRxState: sah lolos (bidang liar dibuang), 18 bentuk cacat ditolak, mine harus ada di rx, rx kosong hanya dengan mine kosong');
}

// 6. (4a-7) owner() / ownerRx: daftar pelaku HANYA untuk pemilik; jalur penonton (view / withRx / wirePost) tetap tanpa id pelaku
{
  const ME = H('9'), ps = new PageStore(fresh(), { relation: (id) => (id === ME ? 'owner' : 'public') });
  const a = ps.create({ text: 'a' }), b = ps.create({ text: 'b' });
  ps.react(U1, a.id, '👍', 1); ps.react(U2, a.id, '🩷', 2); ps.react(U3, a.id, '👍', 3); ps.react(ME, a.id, '🩷', 4);
  assert.strictEqual(ps.ownerRx(ME, b), b, 'tanpa reaksi: objek yang sama, tanpa field');
  const o = ps.ownerRx(ME, a);
  assert.deepStrictEqual(o.rx, [{ e: '👍', n: 2 }, { e: '🩷', n: 2 }], 'seri: yang lebih dulu muncul menang'); assert.strictEqual(o.mine, '🩷', 'mine = reaksi pemilik sendiri');
  assert.deepStrictEqual(o.who, [{ e: '👍', by: [U1, U3] }, { e: '🩷', by: [U2, ME] }], 'who sejajar rx, pelaku terlama dulu');
  assert(o.rx.every((x, i) => o.who[i].e === x.e && o.who[i].by.length === x.n), 'jumlah = panjang daftar pelaku'); assert.strictEqual(a.rx, undefined); assert.strictEqual(a.who, undefined, 'objek asli tidak diubah');
  assert.strictEqual(ps.ownerRx(U1, a).mine, '👍', 'mine mengikuti id yang diberikan'); assert(!('mine' in ps.ownerRx(H('7'), a)), 'bukan pereaksi: tanpa mine');
  o.who[0].by.push('zz'); o.rx[0].n = 99; assert.deepStrictEqual(ps.ownerRx(ME, a).who[0].by, [U1, U3], 'salinan: mengubah keluaran tidak mengubah penyimpanan'); assert.strictEqual(ps.ownerRx(ME, a).rx[0].n, 2);
  // jalur penonton: tanpa who dan tanpa id pelaku
  for (const [who, v] of [['view', ps.rx.view(a.id, H('7'))], ['withRx', ps.withRx(H('7'), a)], ['reactionsFor', ps.reactionsFor(H('7'), a.id)], ['react', ps.react(U1, a.id, '👍', 9)]]) {
    const j = JSON.stringify(v); assert(!('who' in v) && !j.includes('"by"') && ![U1, U2, U3, ME].some((id) => j.includes(id)), who + ': tanpa daftar pelaku');
  }
  const w = wirePost(Object.assign({ v: 1, id: a.id, ts: 5, kind: 'text', text: 'x', priv: 'public' }, { rx: o.rx, who: o.who })); assert(w && !('who' in w) && !JSON.stringify(w).includes('"by"'), 'wirePost membuang who dari jawaban jauh');
  // ownerReactionsOf: sama dengan ownerRx tetapi per id; hilang bersama postingannya
  assert.deepStrictEqual(ps.ownerReactionsOf(ME, a.id), { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 2 }], mine: '🩷', who: [{ e: '👍', by: [U1, U3] }, { e: '🩷', by: [U2, ME] }] });
  assert.deepStrictEqual(ps.ownerReactionsOf(ME, b.id), { rx: [], mine: '', who: [] }, 'ada tapi tanpa reaksi'); assert.strictEqual(ps.ownerReactionsOf(ME, 'bbbbbbbbbbbbbbbb'), null, 'tidak ada = null'); assert.strictEqual(ps.ownerReactionsOf(ME, 'xyz'), null);
  ps.react(ME, a.id, '', 10); assert.deepStrictEqual(ps.ownerRx(ME, a).who[1], { e: '🩷', by: [U2] }, 'cabut: pelaku hilang dari daftar'); assert.strictEqual(ps.ownerRx(ME, a).mine, undefined);
  ps.react(U2, a.id, '', 11); assert.deepStrictEqual(ps.ownerRx(ME, a).who, [{ e: '👍', by: [U1, U3] }], 'emoji tanpa pelaku hilang dari rx dan who');
  ps.remove(a.id); assert.strictEqual(ps.ownerReactionsOf(ME, a.id), null, 'postingan dihapus = reaksi ikut hilang');
  ok('ownerRx / owner: rx + mine + who sejajar (pelaku terlama dulu), tanpa reaksi = objek sama, salinan aman; view / withRx / reactionsFor / react / wirePost tidak pernah membawa pelaku; ownerReactionsOf per id; cabut dan hapus bersih');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nLULUS ' + pass + ' kelompok');
