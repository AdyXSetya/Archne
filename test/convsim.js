'use strict';
// Simulasi konvergensi grup (v0.20.0, grup 5). Banyak node, online-offline acak dengan seed tetap (bisa diulang: ARCHNE_SEEDS=7,8 node test/convsim.js).
//  Tokoh: A pemilik (akhirnya mati), B admin, C/D/E anggota yang kadang offline, F anggota yang offline lama, G anggota yang dikeluarkan saat offline,
//  H anggota baru yang ditambahkan di tengah jalan, N kurir non-anggota yang selalu online.
//  Fase acak: pesan, tambah/keluarkan anggota, admin, pindah pemilik, sematan, dan node mati-hidup (kadang dua perubahan admin bersamaan).
//  Lalu semua anggota yang hidup harus sama (anggota, admin, pemilik, epoch + kunci, sematan, pesan). Lalu SEMUA anggota dimatikan dan
//  F (offline sejak awal) serta G hanya tersambung ke N: F harus sampai ke keadaan akhir yang sama, G harus tahu dirinya dikeluarkan.
//  Terakhir TTL: setelah 20 hari, state tetap sampai ke F; pesan boleh sudah kedaluwarsa (14 hari) tetapi tidak boleh ada yang salah.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-convsim-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function runSeed(seed) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)];
  const dir = path.join(tmp, 's' + seed);
  const mkc = (n, d) => new Core({ dataDir: path.join(dir, d || n), name: n, discovery: false });
  const nodes = {};
  for (const n of 'ABCDEFGHN') { nodes[n] = mkc(n); await nodes[n].start(); }
  const up = new Set('ABCDEFGHN'.split(''));
  const online = () => [...up].map((n) => nodes[n]);
  const link = async (c, others) => { for (const o of others) if (o !== c) await c.addPeer('127.0.0.1', o.port); };
  const syncAll = async (list, passes = 2) => {
    for (let k = 0; k < passes; k++) for (const a of list) for (const b of list) {
      if (a === b) continue;
      const p = a.peers.get(b.id);
      if (p) { try { await a._syncFrom(p); await a._flushOutbox(p); } catch {} }
    }
  };
  const settle = (passes) => syncAll(online(), passes);
  const waitUntil = async (fn, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40); } throw new Error('timeout: ' + label + ' (seed ' + seed + ')'); };
  const stop = async (n) => { await nodes[n].stop(); up.delete(n); };
  const start = async (n, d, only) => { nodes[n] = mkc(n, d); await nodes[n].start(); up.add(n); await link(nodes[n], only || online().filter((x) => x !== nodes[n]).slice(0, 3)); await sleep(150); };

  for (const c of online()) await link(c, online());
  await waitUntil(() => online().every((c) => c.getState().peers.filter((p) => p.online).length === 8), 10000, 'mesh');

  const gid = nodes.A.createGroup('Sim', ['B', 'C', 'D', 'E', 'F', 'G'].map((n) => nodes[n].id)).id, G = 'g:' + gid;
  await waitUntil(() => 'BCDEFG'.split('').every((n) => nodes[n].store.groups[gid]), 8000, 'undangan');
  nodes.A.setAdmin(gid, nodes.B.id, true);
  await waitUntil(() => 'BCDEFG'.split('').every((n) => nodes[n].store.groups[gid].epoch === 1), 8000, 'admin B');
  for (const n of 'FG') await stop(n); // offline lama

  const msgs = []; let k = 0, owner = 'A', removedG = false, addedH = false;
  const alive = () => 'ABCDEH'.split('').filter((n) => up.has(n) && nodes[n].store.groups[gid] && !nodes[n].store.groups[gid].removed);
  const adminAct = () => {
    const c = nodes[pick(alive())], g = c.store.groups[gid], t = R();
    try {
      if (!removedG && t < 0.25) { c.removeMember(gid, nodes.G.id); removedG = true; }
      else if (!addedH && t < 0.5) { c.addMembers(gid, [nodes.H.id]); addedH = true; }
      else if (owner === 'A' && t < 0.7 && c === nodes.A) { c.transferOwner(gid, nodes.C.id); owner = 'C'; }
      else if (t < 0.85) { const m = Object.values(c.store.msgs).filter((x) => x.kind === 'g1' && x.to === G && c._open(x) && !c._isPinCtl(x)); if (m.length) c.pinAdd(G, pick(m).id, true); }
      else c.renameGroup(gid, 'Sim' + (++k));
    } catch { /* tidak berwenang menurut keadaan lokal: wajar */ }
  };
  const ROUNDS = 14;
  for (let r = 0; r < ROUNDS; r++) {
    const t = R();
    if (t < 0.45) { const c = nodes[pick(alive())]; try { const m = c.sendText('pesan-' + seed + '-' + r, G); msgs.push(m.id); } catch {} }
    else if (t < 0.7) { adminAct(); if (R() < 0.3) adminAct(); } // kadang dua perubahan bersamaan
    else if (t < 0.9) { const n = pick('CDE'.split('')); if (up.has(n)) { await settle(2); await stop(n); } else await start(n); }
    else { /* tidak ada kejadian: waktu berlalu */ }
    await settle(2);
  }
  for (const n of 'CDE') if (!up.has(n)) await start(n);
  await settle(3);

  // ---- 1. semua anggota yang hidup sama ----
  const view = (c) => {
    const g = c.store.groups[gid]; if (!g) return null;
    const e = g.eps[g.epoch];
    return { m: g.members.map((x) => x.id).sort(), a: [...(g.admins || [])].sort(), o: g.creator, e: g.epoch, k: e && e.key, rm: !!g.removed, n: g.name };
  };
  const texts = (c, ep0) => Object.values(c.store.msgs).filter((m) => m.kind === 'g1' && m.to === G && c._open(m) !== null && !c._isPinCtl(m) && !c._vcCtl(m)).map((m) => c._open(m)).sort();
  const pins = (c) => { try { return c.pinList(G).shared.map((p) => p.text).sort(); } catch { return null; } };
  const live = 'BCDE'.split('').map((n) => nodes[n]); // anggota sejak epoch 0 yang hidup (H baru: tanpa riwayat lama; A: mati nanti)
  const ref = view(nodes.B);
  const settled = () => live.every((c) => JSON.stringify(view(c)) === JSON.stringify(ref) && JSON.stringify(texts(c)) === JSON.stringify(texts(nodes.B)) && JSON.stringify(pins(c)) === JSON.stringify(pins(nodes.B)));
  for (let i = 0; i < 12 && !settled(); i++) await settle(1);
  const dump = () => JSON.stringify(live.map((c) => [c.name, view(c), texts(c).length, pins(c)]));
  assert(settled(), 'anggota yang hidup tidak sama (seed ' + seed + '): ' + dump());
  if (addedH) { const vh = view(nodes.H); assert.deepStrictEqual(vh && { m: vh.m, a: vh.a, o: vh.o, e: vh.e, k: vh.k }, { m: ref.m, a: ref.a, o: ref.o, e: ref.e, k: ref.k }, 'H (anggota baru) sama keadaan grupnya'); }
  // Dua admin yang bertindak bersamaan membuat epoch yang sama: satu pemenang (deterministik, pemilik menang), yang kalah hilang di SEMUA node (mis. pengeluaran G).
  // Itu sifat protokol yang sudah ada dan bukan urusan kurir; yang diuji di sini: semua node sepakat. G diperlakukan sesuai hasil akhir, bukan niat admin.
  const gRemoved = !ref.m.includes(nodes.G.id), lost = removedG && !gRemoved;
  const truth = { v: ref, t: texts(nodes.B), p: pins(nodes.B), ms: msgs.length };
  ok(`seed ${seed}: ${ROUNDS} putaran acak; anggota yang hidup sama (epoch ${ref.e}, ${ref.m.length} anggota, ${ref.a.length} admin, ${truth.t.length} pesan, ${truth.p.length} sematan, G ${gRemoved ? 'dikeluarkan' : lost ? 'tetap anggota: pengeluarannya kalah dari perubahan bersamaan' : 'tetap anggota'}, H ${addedH ? 'ditambahkan' : 'tidak'})`);

  // ---- 2. semua anggota mati; F dan G hanya lewat N ----
  for (const n of 'ABCDEH') if (up.has(n)) await stop(n);
  const N = nodes.N, dirF = path.join(dir, 'F'), dirG = path.join(dir, 'G');
  fs.cpSync(dirF, dirF + '_y', { recursive: true }); fs.cpSync(dirG, dirG + '_y', { recursive: true }); // salinan bersih F dan G sebelum tahap 2
  const ginvN = Object.values(N.store.custody).filter((x) => x.m.kind === 'ginv').length, gmN = Object.values(N.store.custody).filter((x) => x.m.kind === 'g1').length;
  const via = async (age, suffix) => {
    for (const x of Object.values(N.store.custody)) x.at -= age * DAY;
    N._gc();
    await start('F', 'F' + suffix, [N]); await start('G', 'G' + suffix, [N]); // F dan G hanya tersambung ke N (tidak saling, tidak ke anggota lain)
    nodes.F.peers.forEach((p, id) => { if (id !== N.id) nodes.F.peers.delete(id); }); nodes.G.peers.forEach((p, id) => { if (id !== N.id) nodes.G.peers.delete(id); });
    await waitUntil(() => 'FG'.split('').every((n) => nodes[n].peers.get(N.id)), 8000, 'F dan G melihat N');
    for (let i = 0; i < 12; i++) { for (const n of 'FG') { const p = nodes[n].peers.get(N.id); await nodes[n]._syncFrom(p); await nodes[n]._flushOutbox(p); } if (JSON.stringify(view(nodes.F)) === JSON.stringify(truth.v) && texts(nodes.F).length === truth.t.length) break; }
    for (let i = 0; i < 3; i++) for (const n of 'FG') { const p = nodes[n].peers.get(N.id); await nodes[n]._syncFrom(p); }
  };
  await via(10, '');
  assert.deepStrictEqual(view(nodes.F), truth.v, 'F sama keadaan grup akhir hanya lewat kurir N (seed ' + seed + ')');
  const tf = texts(nodes.F);
  assert.deepStrictEqual(tf, truth.t, 'F mendapat semua pesan lewat N (seed ' + seed + '): ' + tf.length + ' dari ' + truth.t.length);
  assert.deepStrictEqual(pins(nodes.F), truth.p, 'F mendapat sematan bersama yang sama (seed ' + seed + ')');
  const gone = (c) => !c.store.groups[gid] && (c.store.left[gid] || 0) >= 2; // dikeluarkan = grup dihapus dari perangkat dan epoch keluarnya dicatat (perilaku yang memang dirancang)
  if (gRemoved) assert(gone(nodes.G), 'G tahu dirinya dikeluarkan lewat N (seed ' + seed + ')'); else assert.deepStrictEqual(view(nodes.G), truth.v, 'G sama (tidak dikeluarkan)');
  ok(`seed ${seed}: semua anggota mati, F (offline sejak awal) hanya lewat kurir N: keadaan grup, kunci epoch, ${tf.length} pesan, sematan sama; G ${gRemoved ? 'tahu dirinya dikeluarkan' : 'sama'} (N membawa ${ginvN} state, ${gmN} pesan grup)`);
  await stop('F'); await stop('G');

  // ---- 3. TTL: setelah 20 hari state tetap sampai, pesan boleh kedaluwarsa tetapi tidak boleh salah ----
  fs.cpSync(dirF + '_y', dirF + '_b', { recursive: true }); fs.cpSync(dirG + '_y', dirG + '_b', { recursive: true }); // salinan bersih: tidak ada sisa dari tahap 2
  await via(10, '_b'); // total 20 hari sejak dititipkan
  assert.strictEqual(Object.values(N.store.custody).filter((x) => x.m.kind === 'ginv').length, ginvN, 'state masih dipegang N setelah 20 hari');
  assert.deepStrictEqual(view(nodes.F), truth.v, 'setelah 20 hari: keadaan grup, admin, pemilik, kunci epoch tetap sampai (seed ' + seed + ')');
  assert.strictEqual(texts(nodes.F).length, 0, 'pesan grup yang dititipkan lebih dari 14 hari dibuang kurir (seed ' + seed + ')');
  if (gRemoved) assert(gone(nodes.G), 'setelah 20 hari G tetap tahu dirinya dikeluarkan');
  ok(`seed ${seed}: setelah 20 hari state tetap sampai ke F dan G; pesan grup yang lebih dari 14 hari sudah dibuang kurir (${texts(nodes.F).length} dari ${truth.t.length}), state tidak`);
  for (const n of Object.keys(nodes)) if (up.has(n)) await stop(n);
}

(async () => {
  console.log('Archne convergence simulation, dir: ' + tmp);
  const seeds = (process.env.ARCHNE_SEEDS || '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number);
  for (const s of seeds) await runSeed(s);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' tes lolos');
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
