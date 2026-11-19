'use strict';
// Tes jembatan panggilan grup (Step 2a): handler archne-ipc.js untuk callInvite / callInviteAccept / callInviteDecline / callLeg / callLeave
// dengan Core sungguhan (Electron palsu), dan kesamaan nama di preload.js + renderer/archne-api-http.js. Panggilan 1-1 tidak diuji ulang di sini.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const { register } = require('../src/archne-ipc');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-cgipc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); } throw new Error('timeout: ' + label); }
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

function fake(core) {
  const handlers = {}, sent = [];
  register({ ipcMain: { handle: (n, fn) => { handlers[n] = fn; } }, core, send: (ch, p) => sent.push([ch, p]), log: () => {}, shell: {} });
  return { sent, call: (n, ...a) => handlers[n]({}, ...a), evs: (name) => sent.filter(([c, p]) => c === 'call' && p.ev === name).map(([, p]) => p) };
}

(async () => {
  console.log('Archne group-call IPC test (2a), dir: ' + tmp);
  const NAMES = ['callInvite', 'callInviteAccept', 'callInviteDecline', 'callLeg', 'callLeave'];
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const http = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'archne-api-http.js'), 'utf8');
  for (const n of NAMES) { assert(new RegExp('^\\s{2}' + n + ':', 'm').test(preload), 'preload ' + n); assert(new RegExp("'" + n + "'").test(http), 'api-http ' + n); }
  ok('preload.js dan archne-api-http.js memuat kelima nama panggilan grup');

  const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false, tickMs: 100, callRingMs: 3000, callConnMs: 3000 });
  const [A, B, C] = ['A', 'B', 'C'].map(mk), all = [A, B, C];
  for (const n of all) await n.start();
  for (let i = 0; i < all.length; i++) await Promise.all(all.slice(i + 1).map((x) => all[i].addPeer('127.0.0.1', x.port)));
  await until(() => all.every((n) => n.getState().peers.filter((p) => p.online).length === 2), 8000, 'mesh');
  const [ea, eb, ec] = all.map(fake);

  // masukan tidak valid: { ok:false, err }, tanpa lemparan
  for (const [n, args] of [['callInvite', ['nope', C.id]], ['callInvite', [{}, C.id]], ['callInvite', ['0'.repeat(16), C.id]], ['callInviteAccept', [null]], ['callInviteAccept', ['0'.repeat(16)]],
    ['callInviteDecline', [7]], ['callInviteDecline', ['0'.repeat(16)]], ['callLeg', ['x', B.id, 'sdp']], ['callLeg', ['0'.repeat(16), B.id, 'sdp']], ['callLeg', ['0'.repeat(16), B.id, '']]]) {
    const r = await ea.call(n, ...args);
    assert.strictEqual(r.ok, false, n + ' ' + JSON.stringify(args));
    assert.strictEqual(typeof r.err, 'string');
  }
  assert.strictEqual((await ea.call('callLeave', '0'.repeat(16))).ok, false);
  assert.strictEqual((await ea.call('callLeave', 'bukan-id')).ok, false);
  ok('masukan tidak valid / ruang tak dikenal ditolak dengan { ok:false }');

  // A menelepon B (lewat Core: ini hanya bahan awal), lalu semuanya lewat handler ipc
  const cid = A.callStart(B.id, 'SDP-A');
  await until(() => eb.evs('incoming').length === 1, 5000, 'B berdering');
  assert.strictEqual((await eb.call('callAnswer', cid, 'SDP-B')).ok, true);
  await until(() => A.getState().call && A.getState().call.state === 'connecting', 5000, 'A connecting');
  assert.strictEqual((await ea.call('callConnected', cid)).ok, true);
  assert.strictEqual((await eb.call('callConnected', cid)).ok, true);

  // undang C lewat ipc: C menerima event 'invited', menolak dulu lewat ipc
  assert.strictEqual((await ea.call('callInvite', cid, C.id)).ok, true);
  assert.strictEqual((await ea.call('callInvite', cid, C.id)).ok, false, 'undangan ganda ditolak');
  assert.strictEqual((await ea.call('callInvite', cid, B.id)).ok, false, 'sudah di panggilan');
  await until(() => ec.evs('invited').length === 1, 5000, 'C diundang');
  assert.strictEqual(ec.evs('invited')[0].room, cid);
  assert.strictEqual((await ec.call('callInviteDecline', cid)).ok, true);
  await until(() => ea.evs('invitefail').length === 1, 5000, 'invitefail');
  assert.strictEqual(ea.evs('invitefail')[0].reason, 'declined');
  ok('ipc: callInvite -> event invited di C -> callInviteDecline -> invitefail(declined) di A');

  // undang lagi, kali ini diterima; pengemudi mini meniru UI: legneed -> callLeg, incoming auto -> callAnswer, lalu callConnected
  const seen = new Set();
  const drive = async () => {
    for (const [e, who] of [[ea, A], [eb, B], [ec, C]]) {
      for (const ev of e.evs('legneed')) { const k = who.id + ':' + ev.peer; if (seen.has(k)) continue; seen.add(k); const r = await e.call('callLeg', ev.room, ev.peer, 'SDP-LEG-' + who.name + '-' + ev.peer); assert.strictEqual(r.ok, true, JSON.stringify(r)); }
      for (const ev of e.evs('incoming')) { if (!ev.auto) continue; const k = who.id + ':in:' + ev.cid; if (seen.has(k)) continue; seen.add(k); assert.strictEqual((await e.call('callAnswer', ev.cid, 'SDP-ANS')).ok, true); }
      for (const l of (who.getState().call || {}).legs || []) if (l.state === 'connecting') { const k = who.id + ':up:' + l.cid; if (!seen.has(k)) { seen.add(k); await e.call('callConnected', l.cid); } }
    }
  };
  assert.strictEqual((await ea.call('callInvite', cid, C.id)).ok, true);
  await until(() => ec.evs('invited').length === 2, 5000, 'C diundang lagi');
  assert.strictEqual((await ec.call('callInviteAccept', cid)).ok, true);
  assert.strictEqual((await ec.call('callInviteAccept', cid)).ok, false, 'sudah bergabung');
  await until(async () => { await drive(); return [A, B, C].every((n) => { const c = n.getState().call; return c && c.members.length === 3 && (c.legs || []).filter((l) => l.state === 'active').length === 2; }); }, 10000, 'mesh 3 orang aktif');
  const legsOf = (n) => (n.getState().call.legs || []).map((l) => l.peer).sort();
  assert.deepStrictEqual(legsOf(A), [B.id, C.id].sort());
  assert.deepStrictEqual(legsOf(B), [A.id, C.id].sort());
  assert.deepStrictEqual(legsOf(C), [A.id, B.id].sort());
  ok('ipc: callInviteAccept + callLeg + callAnswer + callConnected membentuk mesh 3 orang, tiap sisi punya 2 kaki aktif');

  // C keluar lewat ipc: kakinya ditutup, A dan B tetap berdua
  assert.strictEqual((await ec.call('callLeave', cid)).ok, true);
  // catatan kontrak: callInfo() hanya menyertakan `legs` bila ruangnya berbeda dari cid kaki atau kakinya lebih dari satu, jadi 1-1 murni tidak punya `legs`
  await until(() => A.getState().call && B.getState().call && A.getState().call.members.length === 2 && B.getState().call.members.length === 2, 5000, 'A dan B tinggal berdua');
  assert.strictEqual(C.getState().call, null);
  assert.strictEqual((await ec.call('callLeave', cid)).ok, false, 'keluar dua kali');
  assert.strictEqual((await ea.call('callLeave', cid)).ok, true);
  await until(() => A.getState().call === null && B.getState().call === null, 5000, 'ruang bubar');
  ok('ipc: callLeave -> peserta lain tetap berbicara; keluar terakhir membubarkan ruang');

  for (const n of all) await n.stop();
  console.log(`\n${pass} tes jembatan grup OK`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e && e.stack || e); process.exit(1); });
