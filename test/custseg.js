'use strict';
// Tes penyimpanan titipan bersegmen (v0.22.1, Step 2a): satu berkas per pesan di custody/<2 hex>/<id>.json, simpan hanya menulis yang baru/dibuang,
// migrasi dari custody.json lama, segmen rusak tidak menggagalkan muat, dan format lama tidak dibuang sebelum semua segmen tertulis.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const { Core } = require('../src/archne-core');
const K = require('../src/core/archne-constants');
const { idFromPub, msgId } = require('../src/core/archne-util');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-custseg-'));
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discovery: false });
const dir = (n) => path.join(tmp, n, 'custody');
const segf = (n, id) => path.join(dir(n), id.slice(0, 2), id + '.json');
const hex = (n) => crypto.randomBytes(n).toString('hex');

// pesan sah dari identitas acak, ciphertext tak terbaca: jadi titipan sub (e1 ke penerima acak, atau g1 ke grup acak)
function forge(kind, to) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const m = { from: idFromPub(pub), to: to || (kind === 'g1' ? 'g:' + hex(8) : hex(8)), ts: Date.now(), text: crypto.randomBytes(40).toString('base64'), kind };
  m.id = msgId(m);
  m.sig = crypto.sign(null, Buffer.from(K.canon(m)), privateKey).toString('base64');
  m.pub = pub; m.name = 'x';
  return m;
}
const countSegs = (n) => { let c = 0; for (const sh of fs.existsSync(dir(n)) ? fs.readdirSync(dir(n)) : []) c += fs.readdirSync(path.join(dir(n), sh)).filter((f) => f.endsWith('.json')).length; return c; };
// hitung penulisan berkas di bawah custody/ selama fn berjalan
function writes(fn) {
  const real = fs.writeFileSync, hit = [];
  fs.writeFileSync = function (f, ...a) { if (String(f).includes(path.sep + 'custody' + path.sep)) hit.push(String(f)); return real.call(fs, f, ...a); };
  try { fn(); } finally { fs.writeFileSync = real; }
  return hit;
}

(async () => {
  // ---- 1. satu berkas per pesan, kelas state tetap di primary.json ----
  const B = mk('B'); await B.start();
  const ms = [forge('e1'), forge('g1'), forge('e1')];
  for (const m of ms) assert.strictEqual(B._carry(m), 'carried');
  B._saveNow();
  for (const m of ms) {
    const f = segf('B', m.id);
    assert(fs.existsSync(f), 'segmen ada');
    const [h, b] = fs.readFileSync(f, 'utf8').split('\n'); // format 2 baris (Step 2c): metadata, lalu isi berat
    const c = JSON.parse(h); assert.strictEqual(c.m.id, m.id); assert(Number.isFinite(c.at) && Number.isFinite(c.sz)); assert.strictEqual(JSON.parse(b).text, m.text); assert(!('text' in c.m));
  }
  assert.strictEqual(countSegs('B'), 3);
  assert(!fs.existsSync(path.join(tmp, 'B', 'custody.json')));
  ok('tiap titipan sub = satu berkas custody/<2 hex>/<id>.json; custody.json tidak dibuat');

  // ---- 2. simpan inkremental: tanpa perubahan = nol tulis; tambah satu = satu tulis ----
  assert.strictEqual(writes(() => B._saveNow()).length, 0, 'tanpa perubahan tidak menulis segmen');
  const extra = forge('e1'); B._carry(extra);
  const w = writes(() => B._saveNow());
  assert.strictEqual(w.length, 1, 'hanya segmen baru yang ditulis'); assert(w[0].includes(extra.id));
  assert.strictEqual(countSegs('B'), 4);
  ok('simpan inkremental: tanpa perubahan 0 tulisan; tambah 1 titipan = 1 tulisan');

  // ---- 3. dibuang -> segmennya dihapus ----
  B._dropCustody(ms[0].id); B._saveNow();
  assert(!fs.existsSync(segf('B', ms[0].id)) && fs.existsSync(segf('B', ms[1].id)));
  assert.strictEqual(countSegs('B'), 3);
  ok('titipan dibuang (tanda terima/kedaluwarsa/tergusur) -> segmennya ikut terhapus');

  // ---- 4. restart: semua kembali ----
  await B.stop();
  const B2 = mk('B'); await B2.start();
  assert.deepStrictEqual(Object.keys(B2.store.custody).sort(), [ms[1].id, ms[2].id, extra.id].sort());
  assert.strictEqual(B2.store.custody[ms[1].id].m.text, ms[1].text);
  assert.strictEqual(writes(() => B2._saveNow()).length, 0, 'setelah muat, tidak menulis ulang segmen yang sudah ada');
  ok('restart: titipan kembali utuh dan tidak ditulis ulang');

  // ---- 5. segmen rusak / tidak sah dilewati, sisa .tmp dibersihkan ----
  await B2.stop();
  const good = ms[1].id, bad = ms[2].id;
  fs.writeFileSync(segf('B', bad), '{rusak');
  let other = forge('e1'); while (other.id.slice(0, 2) === '00') other = forge('e1'); // berkas bernama id lain (isi tidak cocok dengan nama) di shard yang salah
  fs.mkdirSync(path.join(dir('B'), '00'), { recursive: true });
  fs.writeFileSync(path.join(dir('B'), '00', other.id + '.json'), JSON.stringify({ m: other, at: Date.now() }));
  const tmpf = segf('B', extra.id) + '.tmp'; fs.writeFileSync(tmpf, 'setengah');
  fs.writeFileSync(path.join(dir('B'), '00', 'catatan.json'), '{}');
  const B3 = mk('B'); await B3.start();
  assert(B3.store.custody[good] && B3.store.custody[extra.id]);
  assert(!B3.store.custody[bad] && !B3.store.custody[other.id], 'rusak dan salah-shard dilewati');
  assert(!fs.existsSync(tmpf), 'sisa .tmp dibersihkan');
  ok('segmen rusak/salah-shard dilewati tanpa menggagalkan muat; sisa .tmp dibersihkan');

  // ---- 6. migrasi dari custody.json lama ----
  await B3.stop();
  const D = path.join(tmp, 'M'); fs.mkdirSync(D);
  const l1 = forge('e1'), l2 = forge('g1');
  fs.writeFileSync(path.join(D, 'custody.json'), JSON.stringify({ custody: { [l1.id]: { m: l1, at: Date.now() }, [l2.id]: { m: l2, at: Date.now() } } }));
  const M = mk('M'); await M.start();
  assert(M.store.custody[l1.id] && M.store.custody[l2.id], 'custody.json lama terbaca');
  M._saveNow();
  assert(fs.existsSync(segf('M', l1.id)) && fs.existsSync(segf('M', l2.id)));
  assert(!fs.existsSync(path.join(D, 'custody.json')), 'format lama dibuang setelah semua segmen tertulis');
  await M.stop();
  const M2 = mk('M'); await M2.start();
  assert(M2.store.custody[l1.id] && M2.store.custody[l2.id]);
  ok('migrasi: custody.json lama dipecah jadi segmen pada simpan pertama, lalu dibuang; restart utuh');

  // ---- 7. gagal tulis segmen: custody.json lama TIDAK dibuang, tidak ada yang hilang ----
  await M2.stop();
  const F = path.join(tmp, 'F'); fs.mkdirSync(F);
  const f1 = forge('e1');
  fs.writeFileSync(path.join(F, 'custody.json'), JSON.stringify({ custody: { [f1.id]: { m: f1, at: Date.now() } } }));
  fs.writeFileSync(path.join(F, 'custody'), 'bukan direktori'); // mkdir segmen pasti gagal
  const FC = mk('F'); await FC.start();
  assert(FC.store.custody[f1.id]);
  FC._saveNow();
  assert(fs.existsSync(path.join(F, 'custody.json')), 'format lama tetap ada selama segmen gagal tertulis');
  fs.rmSync(path.join(F, 'custody'));
  FC._saveNow(); // pulih: coba lagi
  assert(fs.existsSync(segf('F', f1.id)) && !fs.existsSync(path.join(F, 'custody.json')));
  ok('segmen gagal tertulis: custody.json lama dipertahankan; pulih dan dimigrasi pada simpan berikutnya');
  await FC.stop();

  // ---- 8. banyak titipan: simpan kedua tanpa perubahan tidak menulis apa pun ----
  const BIG = mk('BIG'); await BIG.start();
  const t0 = Date.now(); let n = 0;
  for (let i = 0; i < 400; i++) { if (BIG._carry(forge('e1', hex(8))) === 'carried') n++; } // tujuan acak: tiap pengirim satu pesan
  BIG._saveNow();
  assert.strictEqual(countSegs('BIG'), Object.keys(BIG.store.custody).filter((id) => K.custClass(BIG.store.custody[id].m) !== 'state').length);
  assert.strictEqual(writes(() => BIG._saveNow()).length, 0);
  ok('banyak titipan (' + n + '): jumlah segmen = jumlah titipan sub; simpan ulang tanpa perubahan 0 tulisan (' + (Date.now() - t0) + ' ms)');
  await BIG.stop();

  console.log('\n' + pass + ' pemeriksaan lulus'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
