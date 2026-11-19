'use strict';
// Tes "Tambah orang" (Step 3b): tombol, daftar calon, lembar pilihan, teks undangan gagal.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const h = { esc: (s) => String(s).replace(/</g, '&lt;').replace(/"/g, '&quot;'), avatar: (id) => `<av ${id}>`, icons: { phone: '<P/>', mic: '<M/>', micOff: '<X/>', add: '<A/>' } };
const acts = (v, hh) => [...LC.overlayHtml(v, hh || h).matchAll(/data-cact="(\w+)"/g)].map((x) => x[1]);
const leg = (peer, name, state) => ({ cid: 'c' + peer, peer, name, dir: 'out', state: state || 'active' });
const act = (extra) => Object.assign({ phase: 'active', peer: 'p1', name: 'Budi', since: 1, legs: [leg('p1', 'Budi')], invites: [], members: [{ id: 'me', name: 'Aku' }, { id: 'p1', name: 'Budi' }] }, extra);
const P = (id, name, o) => Object.assign({ id, name, online: true, secure: true }, o);

// 1. tombol hanya saat tersambung
{
  assert.deepStrictEqual(acts(act()), ['min', 'mute', 'cam', 'deafen', 'add', 'hang'], '1-1 aktif punya tombol Tambah orang');
  assert(/<A\/><\/button><span>Tambah orang</.test(LC.overlayHtml(act(), h)), 'ikon dan label');
  for (const ph of ['dialing', 'connecting', 'ringing']) assert(!acts(act({ phase: ph, canAccept: ph === 'ringing' })).includes('add'), 'tanpa tombol saat ' + ph);
  assert(!acts({ invite: true, phase: 'ringing', canAccept: true, peer: 'p1', name: 'B', members: [], legs: [] }).includes('add'), 'layar undangan masuk tanpa tombol');
  assert(!acts(act(), Object.assign({}, h, { canAdd: false })).includes('add'), 'canAdd=false menyembunyikan tombol');
  ok('tombol Tambah orang hanya muncul saat panggilan tersambung');
}

// 2. calon: online, terenkripsi, tidak diblokir, belum di panggilan; teman dulu
{
  const v = act({ legs: [leg('p1', 'Budi'), leg('p2', 'Sari')], invites: [{ peer: 'p3', name: 'Andi' }], members: [{ id: 'me', name: 'Aku' }, { id: 'p1', name: 'Budi' }, { id: 'p2', name: 'Sari' }] });
  const peers = [P('p1', 'Budi'), P('p2', 'Sari'), P('p3', 'Andi'), P('p4', 'Zed'), P('p5', 'Cici', { fst: 'ok' }), P('p6', 'Dewi', { friend: true }), P('p7', 'Off', { online: false }),
    P('p8', 'Lama', { secure: false }), P('p9', 'Blok'), P('pa', 'Ana'), P('pb', 'Minta', { fst: 'in' })];
  const r = LC.inviteCandidates(peers, v, new Set(['p9']));
  assert.deepStrictEqual(r.map((x) => x.name), ['Cici', 'Dewi', 'Ana', 'Minta', 'Zed'], 'teman (menurut nama) di atas, lalu yang lain');
  assert.deepStrictEqual(r.map((x) => x.friend), [true, true, false, false, false]);
  assert.deepStrictEqual(LC.inviteCandidates(peers, v, ['p9']).length, 5, 'blokir boleh berupa array');
  assert.deepStrictEqual(LC.inviteCandidates(undefined, v), []);
  assert.deepStrictEqual(LC.inviteCandidates([P('p1', 'Budi')], undefined), [{ id: 'p1', name: 'Budi', friend: false }]);
  ok('calon: online + terenkripsi + tak diblokir + belum ada; teman di atas; offline/sudah ada disembunyikan');
}

// 3. lembar pilihan
{
  const list = [{ id: 'p5', name: 'Cici', friend: true }, { id: 'p4', name: '<b>Zed', friend: false }];
  const html = LC.overlayHtml(act(), Object.assign({}, h, { picker: list }));
  const ids = [...html.matchAll(/data-cinv="(\w+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(ids, ['p5', 'p4']);
  assert(/⭐ Teman/.test(html) && /Online</.test(html), 'label teman / online');
  assert(!/<b>Zed/.test(html) && /&lt;b>Zed/.test(html), 'nama di-escape');
  assert(/data-cact="addclose"/.test(html) && /class="cpk"/.test(html), 'ada tombol tutup dan latar');
  assert(/Tidak ada orang online lain/.test(LC.overlayHtml(act(), Object.assign({}, h, { picker: [] }))), 'daftar kosong diberi tahu');
  assert(!/cpk/.test(LC.overlayHtml(act(), h)) && !/cpk/.test(LC.overlayHtml(act(), Object.assign({}, h, { picker: null }))), 'tanpa picker, tanpa lembar');
  assert(!/cpk/.test(LC.overlayHtml(act({ phase: 'connecting' }), Object.assign({}, h, { picker: list }))), 'lembar tidak tampil kalau belum tersambung');
  // tampil di 1-1 maupun grup
  const g = act({ legs: [leg('p1', 'Budi'), leg('p2', 'Sari')] });
  assert(/cpk/.test(LC.overlayHtml(g, Object.assign({}, h, { picker: list }))), 'tampil juga di grup');
  ok('lembar pilihan: baris calon, di-escape, tombol tutup, kosong, hanya saat tersambung');
}

// 4. hitungan ruang penuh
{
  assert.strictEqual(LC.CALL_MAX_PEERS, 8);
  assert.strictEqual(LC.roomCount(act()), 2);
  assert.strictEqual(LC.roomCount(act({ invites: [{ peer: 'p2' }, { peer: 'p3' }] })), 4);
  assert.strictEqual(LC.roomCount(act({ legs: [leg('p1', 'B')], invites: [{ peer: 'p1' }] })), 2, 'tidak dihitung dua kali');
  const legs = Array.from({ length: 7 }, (_, i) => leg('q' + i, 'Q' + i));
  assert.strictEqual(LC.roomCount(act({ legs })), 8);
  assert.strictEqual(LC.roomCount(null), 1);
  ok('roomCount: aku + kaki + undangan menunggu, tanpa hitung ganda; batas 8');
}

// 5. teks undangan gagal
{
  const t = (reason) => LC.inviteFailText({ name: 'Sari', reason });
  assert.strictEqual(t('declined'), 'Sari menolak undangan');
  assert.strictEqual(t('busy'), 'Sari sedang dalam panggilan lain');
  assert.strictEqual(t('noanswer'), 'Sari tidak menjawab undangan');
  assert(/offline/.test(t('unreachable')) && /Coba lagi/.test(t('refused')));
  assert.strictEqual(LC.inviteFailText({ reason: 'x' }), 'Undangan untuk Dia gagal');
  assert.strictEqual(LC.inviteFailText(null), 'Undangan untuk Dia gagal');
  ok('teks undangan gagal untuk tiap alasan');
}

console.log('\n' + pass + ' tes lulus');
