'use strict';
// Tes tampilan panggilan grup (Step 3a): daftar peserta di overlay, layar undangan masuk, panggilan 1-1 tidak berubah.
const assert = require('assert');
const LC = require('../renderer/archne-call');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const h = { esc: (s) => String(s).replace(/</g, '&lt;'), avatar: (id) => `<av ${id}>`, icons: { phone: '<P/>', mic: '<M/>', micOff: '<X/>' } };
const acts = (v) => [...LC.overlayHtml(v, h).matchAll(/data-cact="(\w+)"/g)].map((x) => x[1]);
const rows = (html) => [...html.matchAll(/<li class="(\w+)" data-peer="([^"]*)">.*?<span class="cpn">(.*?)<\/span><span class="cps">(.*?)<\/span><\/li>/g)].map((m) => ({ cls: m[1], peer: m[2], name: m[3], st: m[4] }));
const leg = (peer, name, state) => ({ cid: 'c' + peer, peer, name, dir: 'out', state });

// 1. 1-1: tidak ada daftar, tampilan lama utuh
{
  const v = { phase: 'active', peer: 'p1', name: 'Budi', since: 1, legs: [leg('p1', 'Budi', 'active')], invites: [] };
  const html = LC.overlayHtml(v, h);
  assert(!/cpl/.test(html) && /class="cnm">Budi</.test(html) && /<av p1>/.test(html), '1-1: nama peserta jadi judul, tanpa daftar');
  assert.deepStrictEqual(acts(v), ['min', 'mute', 'cam', 'deafen', 'add', 'hang']);
  assert(!/cpl/.test(LC.overlayHtml({ phase: 'dialing', peer: 'p', name: 'N' }, h)), 'tanpa legs sama sekali (bentuk lama)');
  ok('1-1: tanpa daftar, judul dan tombol seperti semula');
}

// 2. grup: daftar peserta dengan status
{
  const v = { phase: 'active', peer: 'p1', name: 'Budi', since: 1,
    legs: [leg('p1', 'Budi', 'active'), leg('p2', 'Sari', 'connecting'), leg('p3', 'Andi', 'dialing')], invites: [{ peer: 'p4', name: 'Dewi' }] };
  const html = LC.overlayHtml(v, h), r = rows(html);
  assert(/class="cnm">Panggilan grup</.test(html));
  assert.deepStrictEqual(r.map((x) => [x.peer, x.name, x.st, x.cls]), [
    ['p1', 'Budi', 'Tersambung', 'ok'], ['p2', 'Sari', 'Menyambung…', 'wait'], ['p3', 'Andi', 'Menyambung…', 'wait'], ['p4', 'Dewi', 'Mengundang…', 'inv'],
  ]);
  assert.deepStrictEqual(acts(v), ['min', 'mute', 'cam', 'deafen', 'add', 'hang'], 'tombol sama seperti 1-1');
  assert(/data-cnoise/.test(LC.overlayHtml(Object.assign({}, v, { phase: 'active' }), h)), 'peredam bising tetap ada');
  ok('grup: daftar peserta dengan status tersambung / menyambung / mengundang');
}

// 3. satu kaki + undangan keluar = sudah grup (undangan pertama dari 1-1)
{
  const v = { phase: 'active', peer: 'p1', name: 'Budi', since: 1, legs: [leg('p1', 'Budi', 'active')], invites: [{ peer: 'p2', name: 'Sari' }] };
  const r = rows(LC.overlayHtml(v, h));
  assert.deepStrictEqual(r.map((x) => x.name + ':' + x.st), ['Budi:Tersambung', 'Sari:Mengundang…']);
  ok('1-1 yang baru mengundang satu orang langsung tampil sebagai grup');
}

// 4. undangan yang sudah jadi kaki tidak muncul dua kali
{
  const v = { phase: 'active', peer: 'p1', name: 'Budi', since: 1, legs: [leg('p1', 'Budi', 'active'), leg('p2', 'Sari', 'connecting')], invites: [{ peer: 'p2', name: 'Sari' }] };
  const r = rows(LC.overlayHtml(v, h));
  assert.deepStrictEqual(r.map((x) => x.peer), ['p1', 'p2']);
  assert.strictEqual(r[1].st, 'Menyambung…');
  ok('peserta yang ada di legs dan invites hanya tampil sekali');
}

// 5. nama jahat di-escape
{
  const v = { phase: 'active', peer: 'p1', name: 'A', since: 1, legs: [leg('p1', '<b>x', 'active'), leg('p2', 'B', 'active')], invites: [] };
  const html = LC.overlayHtml(v, h);
  assert(!/<b>x/.test(html) && /&lt;b>x/.test(html));
  const inv = LC.overlayHtml({ invite: true, phase: 'ringing', canAccept: true, peer: 'p1', name: '<i>A', members: [{ id: 'p1', name: '<i>A' }, { id: 'p2', name: '<u>S' }], legs: [] }, h);
  assert(!/<i>A|<u>S/.test(inv));
  ok('nama peserta di-escape (daftar dan layar undangan)');
}

// 6. layar undangan masuk
{
  const v = { invite: true, phase: 'ringing', canAccept: true, peer: 'p1', name: 'Budi', members: [{ id: 'p1', name: 'Budi' }, { id: 'p2', name: 'Sari' }, { id: 'p3', name: 'Andi' }], legs: [], invites: [] };
  const html = LC.overlayHtml(v, h);
  assert(/class="cnm">Budi</.test(html) && /mengundangmu ke panggilan grup/.test(html), 'pengundang jadi judul');
  assert(/Di panggilan: Sari, Andi</.test(html), 'pengundang tidak diulang di daftar');
  assert.deepStrictEqual(acts(v), ['reject', 'accept']);
  assert(!/data-cnoise/.test(html) && !/cpl/.test(html));
  const solo = LC.overlayHtml(Object.assign({}, v, { members: [{ id: 'p1', name: 'Budi' }] }), h);
  assert(/Belum ada peserta lain/.test(solo));
  assert(/Belum ada peserta lain/.test(LC.overlayHtml(Object.assign({}, v, { members: undefined }), h)));
  ok('layar undangan: pengundang sebagai judul, daftar peserta lain, tombol Tolak / Terima');
}

// 7. view() Controller membawa members untuk undangan
{
  const calls = [];
  const api = new Proxy({}, { get: (_t, n) => async (...a) => { calls.push([n, ...a]); return { ok: true }; } });
  const renders = [];
  const c = new LC.Controller({ api, rtc: { PeerConnection: function () {}, getUserMedia: async () => ({}), makeStream: () => ({}), playRemote: () => () => {} }, ui: { render: (v) => renders.push(v), ring() {}, ended() {}, notice() {} } });
  c.onEvent({ ev: 'invited', room: 'f9'.repeat(8), peer: 'p1', name: 'Budi', members: [{ id: 'p1', name: 'Budi' }, { id: 'p2', name: 'Sari' }] });
  const v = renders[renders.length - 1];
  assert(v && v.invite === true && v.canAccept === true && v.legs.length === 0);
  assert.deepStrictEqual(v.members, [{ id: 'p1', name: 'Budi' }, { id: 'p2', name: 'Sari' }]);
  assert(/Di panggilan: Sari</.test(LC.overlayHtml(v, h)));
  c.cur = null; c._render();
  assert.strictEqual(c.view(), null);
  ok('Controller.view() meneruskan members; layar undangan dirender dari view()');
}

console.log('\n' + pass + ' tes lulus');
