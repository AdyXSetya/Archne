'use strict';
// Tes kuota BYTE titipan sub (v0.22.1, Step 2b): ongkos = byte teks + overhead, DM dan pesan grup berkuota sendiri-sendiri, state (primer) tidak ikut,
// pesan tunggal yang lebih besar dari kuota ditolak, tanpa batas (Infinity) tetap menahan satu pengirim, nilai opts tidak sah jatuh ke bawaan, custUsage.
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { Core } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-custquota-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n, o) => { const c = new Core(Object.assign({ dataDir: path.join(tmp, n), name: n, discovery: false }, o || {})); c._kick = () => {}; c._save = () => {}; return c; };
const hex = (n, len) => n.toString(16).padStart(len, '0');
const sender = (i) => hex(i + 1, 16), gto = (i) => 'g:' + hex(i + 1, 16);
let seq = 0;
const fake = (kind, from, to, text, ts) => ({ id: hex(++seq, 32), from, to: to || 'a'.repeat(16), kind, ts: ts || Date.now(), text: text || 'x', pub: 'p', sig: 's' });
const U = K.custCost({ text: 'x' });

(async () => {
  // 1. ongkos = byte teks (UTF-8) + overhead; custUsage menjumlahkannya per kelas
  assert.strictEqual(K.custCost({ text: 'abc' }), 3 + K.CUST_OVERHEAD);
  assert.strictEqual(K.custCost({ text: 'あ' }), 3 + K.CUST_OVERHEAD, 'dihitung dalam byte UTF-8, bukan karakter');
  assert.strictEqual(K.custCost({}), K.CUST_OVERHEAD);
  const A = mk('A');
  A._carry(fake('e1', sender(0), null, 'x'.repeat(100))); A._carry(fake('g1', sender(1), gto(0), 'y'.repeat(50))); A._carry(fake('ginv', sender(2)));
  const u = A.custUsage();
  assert.deepStrictEqual([u.dm.used, u.dm.count, u.gmsg.used, u.gmsg.count, u.state.count], [100 + K.CUST_OVERHEAD, 1, 50 + K.CUST_OVERHEAD, 1, 1]);
  assert.strictEqual(u.state.quota, null); assert.strictEqual(u.dm.quota, K.CUST_DM_QUOTA); assert.strictEqual(u.gmsg.quota, K.CUST_GMSG_QUOTA);
  ok('ongkos titipan = byte UTF-8 + overhead; custUsage per kelas (state tanpa kuota byte)');

  // 2. DM: per pengirim 10%, penuh membuang yang terlama, pesan tunggal > kuota ditolak
  const D = mk('D', { custDmQuota: 100 * U + 50 });
  assert.strictEqual(D._carry(fake('e1', sender(0), null, 'x'.repeat(100 * U))), 'full', 'pesan tunggal lebih besar dari kuota ditolak');
  const old = [];
  for (let s = 1; s <= 10; s++) for (let i = 0; i < 10; i++) { const m = fake('e1', sender(s), null); old.push(m); assert.strictEqual(D._carry(m), 'carried'); D.store.custody[m.id].at = 1000 + old.length; }
  assert.strictEqual(D.custUsage().dm.count, 100);
  assert.strictEqual(D._carry(fake('e1', sender(1), null)), 'full', 'pengirim ke-11 titipan melewati 10% kuota');
  const fresh = fake('e1', sender(20), null); assert.strictEqual(D._carry(fresh), 'carried');
  assert(!D.store.custody[old[0].id] && D.store.custody[old[1].id] && D.store.custody[fresh.id], 'yang terlama keluar, yang lain tetap');
  assert(D.custUsage().dm.used <= D.custUsage().dm.quota);
  ok('DM: 10% per pengirim; kuota penuh = yang terlama keluar; total byte tidak melewati kuota');

  // 3. pesan besar mengusir beberapa pesan kecil sekaligus
  const E = mk('E', { custDmQuota: 100 * U + 50 });
  const smalls = []; for (let s = 1; s <= 10; s++) for (let i = 0; i < 10; i++) { const m = fake('e1', sender(s), null); smalls.push(m); E._carry(m); E.store.custody[m.id].at = 1000 + smalls.length; }
  const bigM = fake('e1', sender(30), null, 'z'.repeat(9 * U)); // ongkosnya ~10U: tepat di batas per pengirim (10% kuota), tapi kuota sudah penuh
  assert.strictEqual(E._carry(bigM), 'carried');
  assert(E.custUsage().dm.used <= 100 * U + 50 && E.store.custody[bigM.id]);
  assert(!E.store.custody[smalls[0].id] && !E.store.custody[smalls[8].id], 'beberapa yang terlama keluar untuk memberi tempat');
  ok('pesan besar mengusir beberapa titipan terlama sekaligus sampai muat');

  // 4. pesan kecil sangat banyak tetap dibatasi (overhead): jumlah titipan <= kuota / ongkos
  const T = mk('T', { custGmsgQuota: 10e6 });
  let n = 0; for (let i = 0; i < 3000; i++) if (T._carry(fake('g1', sender(i), gto(i % 20), '')) === 'carried') n++;
  assert(T.custUsage().gmsg.used <= 10e6); assert(n <= 10e6 / K.CUST_OVERHEAD + 1);
  ok('pesan kosong tidak lolos tanpa batas: ongkos overhead ikut dihitung');

  // 5. DM dan pesan grup berkuota sendiri; state tidak terpengaruh walau kuota sub kecil
  const S = mk('S', { custDmQuota: 5 * U, custGmsgQuota: 5 * U });
  const st = []; for (let i = 0; i < 30; i++) { const m = fake('ginv', sender(i)); st.push(m); assert.strictEqual(S._carry(m), 'carried'); }
  for (let i = 0; i < 40; i++) { S._carry(fake('e1', sender(100 + i))); S._carry(fake('g1', sender(200 + i), gto(i))); }
  assert(st.every((m) => S.store.custody[m.id]), 'state tidak digusur banjir sub');
  assert(S.custUsage().dm.used <= 5 * U && S.custUsage().gmsg.used <= 5 * U);
  ok('state tidak ikut kuota byte sub dan tidak digusur; DM dan pesan grup masing-masing berkuota');

  // 6. tanpa batas: tidak ada pengusiran, tapi satu pengirim tetap dibatasi UNLIM_SENDER
  const I = mk('I', { custDmQuota: Infinity, custGmsgQuota: Infinity });
  const L = I._custLimits();
  assert.strictEqual(L.dm.quota, Infinity); assert.strictEqual(L.dm.perSender, K.UNLIM_SENDER); assert.strictEqual(L.gmsg.perSender, K.UNLIM_SENDER); assert.strictEqual(L.gmsg.perGroup, Infinity);
  for (let i = 0; i < 300; i++) assert.strictEqual(I._carry(fake('e1', sender(i % 7))), 'carried');
  assert.strictEqual(I.custUsage().dm.count, 300);
  ok('tanpa batas (Infinity): tidak ada pengusiran; batas per pengirim = UNLIM_SENDER, per grup tanpa batas');

  // 7. nilai opts tidak sah jatuh ke bawaan
  for (const bad of [0, -5, NaN, '99', null, undefined]) {
    const c = mk('B' + String(bad), { custDmQuota: bad, custGmsgQuota: bad });
    assert.strictEqual(c._custLimits().dm.quota, K.CUST_DM_QUOTA, 'dm ' + String(bad)); assert.strictEqual(c._custLimits().gmsg.quota, K.CUST_GMSG_QUOTA, 'gmsg ' + String(bad));
  }
  ok('opts kuota tidak sah (0, negatif, NaN, string, null) memakai bawaan');

  console.log('\n' + pass + ' pemeriksaan lulus'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
