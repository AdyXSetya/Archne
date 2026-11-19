'use strict';
// Tes i18n A5: penjaga kamus. (1) kunci en == id, (2) placeholder {x} sama, (3) kunci jamak lengkap,
// (4) tidak ada kunci yatim (ada di kamus tapi tak dipakai), (5) semua kunci yang dipakai kode ada di kamus,
// (6) perilaku fallback/placeholder/jamak dari renderer/archne-i18n.js dengan kamus nyata.
// Kunci dinamis (disusun saat jalan, mis. tx('status.' + s)): tulis dengan awalan literal 'status.' + ... agar dikenali sebagai terpakai.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const ok = (n) => console.log('  OK  ' + n);

function load() {
  const ctx = { Intl, Object, Set, String, console };
  vm.createContext(ctx);
  for (const f of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js']) vm.runInContext(rd('renderer', f), ctx, { filename: f });
  return ctx.I18N;
}
const I = load();
const D = I._dict;
const en = D.en, id = D.id;
assert(en && id, 'kamus en dan id termuat');
const ks = (o) => Object.keys(o).sort();
const phs = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');

// 1. paritas kunci
const miss = ks(en).filter((k) => !(k in id)).map((k) => 'id kurang: ' + k)
  .concat(ks(id).filter((k) => !(k in en)).map((k) => 'en kurang: ' + k));
assert.deepStrictEqual(miss, [], 'kunci en dan id harus identik:\n  ' + miss.join('\n  '));
ok('paritas kunci en/id (' + ks(en).length + ' kunci)');

// kunci rapi + nilai string tak kosong
for (const [name, d] of [['en', en], ['id', id]]) {
  for (const k of ks(d)) {
    assert(/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(k), name + ': bentuk kunci salah: ' + k);
    assert(typeof d[k] === 'string' && d[k].trim() !== '', name + ': teks kosong/bukan string: ' + k);
  }
}
ok('bentuk kunci "bagian.nama" dan teks tidak kosong');

// 2. placeholder sama
const bad = ks(en).filter((k) => phs(en[k]) !== phs(id[k])).map((k) => k + ': en[' + phs(en[k]) + '] id[' + phs(id[k]) + ']');
assert.deepStrictEqual(bad, [], 'placeholder en dan id harus sama:\n  ' + bad.join('\n  '));
ok('placeholder {x} sama di en dan id');

// 3. kunci jamak: .one dan .other berpasangan, tidak ada .one tanpa .other
for (const d of [en, id]) {
  for (const k of ks(d)) {
    if (/\.one$/.test(k)) assert(d[k.replace(/\.one$/, '.other')] != null, 'kunci jamak .one tanpa .other: ' + k);
  }
}
ok('kunci jamak: setiap .one punya .other');

// 4 & 5. pemakaian kunci di kode
function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f), st = fs.statSync(p);
    if (st.isDirectory()) { if (!['vendor', 'node_modules', 'i18n'].includes(f)) walk(p, out); } else if (/\.(js|html)$/.test(f) && !(dir === path.join(root, 'renderer') && f === 'archne-i18n.js')) out.push(p);
  }
  return out;
}
const files = walk(path.join(root, 'renderer'), []).concat(walk(path.join(root, 'src'), []), ['main.js', 'preload.js', 'server.js'].map((f) => path.join(root, f)).filter(fs.existsSync));
const SRC = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const literals = new Set();
for (const m of SRC.matchAll(/(['"`])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\1/g)) literals.add(m[2]);
for (const m of SRC.matchAll(/data-i18n(?:-ph|-title|-aria)?=["']([^"']+)["']/g)) literals.add(m[1]);
const prefixes = [];
for (const m of SRC.matchAll(/(['"`])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\.)\1\s*\+/g)) prefixes.push(m[2]);
for (const m of SRC.matchAll(/`([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\.)\$\{/g)) prefixes.push(m[1]);
const used = (k) => {
  const base = k.replace(/\.(one|other|zero|two|few|many)$/, '');
  return literals.has(k) || literals.has(base) || prefixes.some((p) => k.indexOf(p) === 0);
};
const orphan = ks(en).filter((k) => !used(k));
assert.deepStrictEqual(orphan, [], 'kunci yatim (ada di kamus, tidak dipakai di kode):\n  ' + orphan.join('\n  '));
ok('tidak ada kunci yatim');

// kunci yang dipanggil langsung lewat tx('...') / tn('...') / data-i18n harus ada di kamus
const wanted = new Set();
for (const m of SRC.matchAll(/(?<![\w.$])tx\(\s*(['"`])([A-Za-z0-9_.]+)\1/g)) wanted.add(m[2]);
for (const m of SRC.matchAll(/(?<![\w.$])tn\(\s*(['"`])([A-Za-z0-9_.]+)\1/g)) wanted.add(m[2] + '.other');
for (const m of SRC.matchAll(/data-i18n(?:-ph|-title|-aria)?=["']([^"']+)["']/g)) wanted.add(m[1]);
const absent = [...wanted].filter((k) => !(k in en)).sort();
assert.deepStrictEqual(absent, [], 'kunci dipakai kode tetapi tidak ada di kamus:\n  ' + absent.join('\n  '));
ok('semua kunci tx()/tn()/data-i18n di kode ada di kamus (' + wanted.size + ' dicek)');

// 6. perilaku api dengan kamus nyata (kunci uji disuntik lewat add)
I.add('en', { 'zz.hello': 'Hello {name}', 'zz.only': 'Only English', 'zz.cnt.one': '{n} file', 'zz.cnt.other': '{n} files' });
I.add('id', { 'zz.hello': 'Halo {name}', 'zz.cnt.other': '{n} berkas' });
I.setLang('en');
assert.strictEqual(I.tx('zz.hello', { name: 'A' }), 'Hello A');
assert.strictEqual(I.tn('zz.cnt', 1), '1 file');
assert.strictEqual(I.tn('zz.cnt', 3), '3 files');
I.setLang('id');
assert.strictEqual(I.tx('zz.hello', { name: 'A' }), 'Halo A');
assert.strictEqual(I.tx('zz.only'), 'Only English', 'kunci hilang di id -> pakai en');
assert.strictEqual(I.tx('zz.nope.nothing'), 'zz.nope.nothing', 'kunci hilang di semua -> kunci itu sendiri');
assert.strictEqual(I.tn('zz.cnt', 1), '1 berkas', 'id hanya punya .other');
assert.strictEqual(I.tx('zz.hello'), 'Halo {name}', 'placeholder tanpa param dibiarkan');
I.setLang('xx');
assert.strictEqual(I.getLang(), 'en', 'bahasa tak dikenal -> en');
ok('api: placeholder, jamak, fallback id->en->kunci, bahasa tak dikenal -> en');

// 7. archne-index.html: teks cadangan di HTML (sebelum applyDom) harus sama dengan teks Indonesia di archne-id.js,
//    supaya teks asli tidak berubah diam-diam dan tes vm/aplikasi tanpa i18n tetap menampilkan Indonesia.
{
  const html = rd('renderer', 'archne-index.html').split('<script src=')[0];
  const un = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const attr = (a, n) => { const m = new RegExp('\\s' + n + '="([^"]*)"').exec(a); return m ? un(m[1]) : null; };
  const diffs = []; let n = 0;
  for (const m of html.matchAll(/<([a-z0-9]+)\b([^>]*\sdata-i18n[^>]*)>/g)) {
    const a = m[2];
    for (const [da, real] of [['data-i18n-ph', 'placeholder'], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label']]) {
      const key = attr(a, da); if (key == null) continue; n++;
      if (!(key in id)) diffs.push(da + '="' + key + '" tidak ada di archne-id.js');
      else if (attr(a, real) !== id[key]) diffs.push(key + ': ' + real + ' di HTML [' + attr(a, real) + '] != archne-id.js [' + id[key] + ']');
    }
    const key = attr(a, 'data-i18n');
    if (key != null) {
      n++;
      const rest = html.slice(m.index + m[0].length), txt = un(rest.slice(0, rest.indexOf('<')));
      if (!(key in id)) diffs.push('data-i18n="' + key + '" tidak ada di archne-id.js');
      else if (txt !== id[key]) diffs.push(key + ': teks HTML [' + txt + '] != archne-id.js [' + id[key] + ']');
    }
  }
  assert.deepStrictEqual(diffs, [], 'teks cadangan HTML harus = archne-id.js:\n  ' + diffs.join('\n  '));
  ok('archne-index.html: teks cadangan sama dengan archne-id.js (' + n + ' atribut data-i18n dicek)');
}

// ---- 8 (F1). test/_src.js: tes vm bawaan memakai kamus asli terkunci 'id'; 'off' = jalur cadangan; 'en' bisa dipilih ----
{
  const keep = process.env.ARCHNE_TEST_I18N, src = require('./_src');
  const at = (v, fn) => { if (v === undefined) delete process.env.ARCHNE_TEST_I18N; else process.env.ARCHNE_TEST_I18N = v; return src[fn || 'inlineJs'](); };
  const lock = (l) => "\nI18N.setLang('" + l + "');\n";
  try {
    assert(at(undefined).includes(lock('id')) && at(undefined).includes('I18N.add('), 'bawaan: kamus asli + setLang(id)');
    assert(at('en').includes(lock('en')) && !at('en').includes(lock('id')), 'en: setLang(en)');
    assert(!at('off').includes('// ---- i18n (A1)') && !at('off').includes(lock('id')) && at(undefined).includes('// ---- i18n (A1)'), 'off: tanpa kamus');
    assert(at(undefined, 'pagesJs').includes(lock('id')), 'pagesJs ikut terkunci');
  } finally { if (keep === undefined) delete process.env.ARCHNE_TEST_I18N; else process.env.ARCHNE_TEST_I18N = keep; }
  ok('_src.js: inlineJs()/pagesJs() bawaan = kamus asli + bahasa id; off dan en tersedia');
}

// ---- 9 (F-Android). Teks native Android: strings.xml en/id, ArchneLang, kamus halaman pembungkus ----
{
  const bgDir = path.join(root, 'android', 'localplugins', 'archne-background');
  const xml = (f) => { const t = fs.readFileSync(path.join(bgDir, 'src', 'android', 'res', f, 'archne_strings.xml'), 'utf8'), o = {}; for (const m of t.matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)) o[m[1]] = m[2]; return o; };
  const xe = xml('values'), xi = xml('values-in');
  assert.deepStrictEqual(Object.keys(xe).sort(), Object.keys(xi).sort(), 'strings.xml: nama en == id');
  const ph = (t) => (t.match(/%\d\$[sd]/g) || []).sort().join();
  for (const k of Object.keys(xe)) {
    assert(/^archne_[a-z_]+$/.test(k), 'nama string rapi: ' + k);
    assert(xe[k].trim() && xi[k].trim(), 'tidak kosong: ' + k);
    assert.strictEqual(ph(xe[k]), ph(xi[k]), 'placeholder sama: ' + k);
    assert(!/(^|[^\\])'/.test(xe[k] + xi[k]), 'apostrof di strings.xml harus di-escape: ' + k);
  }
  const ID_WORDS = /\b(Gagal|gagal|Memulai|Tidak|tidak|Tutup|Pilih|Sudah|Inti|inti|belum|Panggilan|Pesan|Tolak|Jawab|Balas|Kamu|Publik|Layanan|Menjaga|Mikrofon|Tandai|aplikasi|berlangsung|terjawab|masuk)\b/;
  for (const k of Object.keys(xe)) assert(!ID_WORDS.test(xe[k]), 'sisi English strings.xml memuat kata Indonesia: ' + k + ' = ' + xe[k]);
  // pemakaian: setiap kunci di ArchneLang.s(ctx, "kunci") ada di xml, dan setiap string xml dipakai (tanpa yatim)
  const javaDir = path.join(bgDir, 'src', 'android');
  const javas = fs.readdirSync(javaDir).filter((f) => f.endsWith('.java') && f !== 'ArchneLang.java');
  const used = new Set();
  const strip = (j) => j.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1');
  for (const f of javas) {
    const j = strip(fs.readFileSync(path.join(javaDir, f), 'utf8'));
    for (const m of j.matchAll(/ArchneLang\.s\([^,()]+,\s*(?:video \? )?"(\w+)"(?: : "(\w+)")?/g)) { used.add(m[1]); if (m[2]) used.add(m[2]); }
    // tidak ada teks tampil Indonesia polos di literal Java (teks tampil lewat ArchneLang)
    for (const m of j.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) assert(!/\b(Panggilan|Pesan|Tolak|Jawab|Balas|Kamu|Publik|Layanan|Menjaga|Mikrofon|Tidak|tidak|gagal|belum|Tandai|izin|folder|argumen)\b/.test(m[1]), f + ': teks Indonesia polos di literal Java: "' + m[1] + '"');
  }
  for (const k of used) assert(xe['archne_' + k] !== undefined, 'kunci ArchneLang tanpa string: ' + k);
  for (const k of Object.keys(xe)) assert(used.has(k.replace(/^archne_/, '')), 'string xml yatim (tak dipakai Java): ' + k);
  // plugin.xml mendaftarkan semuanya (dan berkasnya ada)
  const px = fs.readFileSync(path.join(bgDir, 'plugin.xml'), 'utf8');
  for (const f of ['src/android/ArchneLang.java', 'src/android/res/values/archne_strings.xml', 'src/android/res/values-in/archne_strings.xml']) assert(px.includes('src="' + f + '"') && fs.existsSync(path.join(bgDir, f)), 'plugin.xml mendaftarkan ' + f);
  ok('strings.xml en/id: nama dan placeholder sama, semua kunci Java ada, tanpa yatim, tanpa teks Indonesia polos di Java, terdaftar di plugin.xml');

  // halaman pembungkus (android/www/index.html): kamus W en == id, tanpa teks Indonesia di luar kamus, perilaku bahasa
  const html = rd('android', 'www', 'index.html');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  const wsrc = script.match(/var W = (\{[\s\S]*?\n  \});/)[1];
  const W = vm.runInNewContext('(' + wsrc + ')');
  assert.deepStrictEqual(Object.keys(W.en).sort(), Object.keys(W.id).sort(), 'pembungkus: kunci en == id');
  for (const k of Object.keys(W.en)) assert(!ID_WORDS.test(W.en[k]), 'sisi English kamus pembungkus memuat kata Indonesia: ' + k);
  const ph2 = (t) => (t.match(/\{\w+\}/g) || []).sort().join();
  for (const k of Object.keys(W.en)) assert.strictEqual(ph2(W.en[k]), ph2(W.id[k]), 'pembungkus: placeholder sama: ' + k);
  const rest = script.replace(wsrc, '').replace(/\/\/.*$/gm, '');
  assert(!/\b(Gagal|Memulai|Tidak|tidak|Tutup|Pilih|Sudah|Inti|belum)\b/.test([...rest.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]).join('\n')), 'pembungkus: tidak ada teks Indonesia di luar kamus W');
  // plugin unduhan: galat ke pengguna berupa kode "e:<nama>"; tiap kode punya terjemahan e_<nama> di W (en + id) dan sebaliknya
  const dlJ = strip(fs.readFileSync(path.join(root, 'android', 'localplugins', 'archne-downloads', 'src', 'android', 'ArchneDownloads.java'), 'utf8'));
  const codes = new Set([...dlJ.matchAll(/"e:(\w+)"/g)].map((m) => m[1]));
  assert(codes.size >= 10, 'ArchneDownloads memakai kode galat e:*');
  for (const c of codes) assert(W.en['e_' + c] && W.id['e_' + c], 'kode galat tanpa terjemahan en+id: e:' + c);
  for (const k of Object.keys(W.en)) if (/^e_/.test(k)) assert(codes.has(k.slice(2)), 'terjemahan galat yatim (tak ada di Java): ' + k);
  for (const m of dlJ.matchAll(/(?:IOException|error)\(\s*"((?:[^"\\\n]|\\.)*)"/g)) assert(/^(e:\w+|cancel)$/.test(m[1]), 'ArchneDownloads: galat harus kode, bukan kalimat: "' + m[1] + '"');
  const run = (store, readyInfo) => {
    const doc = {}, win = {}, execs = [], posted = [], chan = {}, msg = { style: {}, textContent: '' };
    const frame = { style: {}, contentWindow: { postMessage(m, o) { posted.push(m); } } };
    const ctx = {
      document: { getElementById: (i) => (i === 'f' ? frame : msg), addEventListener: (t, f) => { doc[t] = f; }, documentElement: {} },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
      nodejs: { channel: { on: (t, f) => { chan[t] = f; }, post() {} }, start() {} },
      cordova: { exec(okf, erf, plug, act, args) { execs.push({ plug, act, okf, erf, args: JSON.parse(JSON.stringify(args)) }); } },
      setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, console, addEventListener: (t, f) => { win[t] = f; },
    };
    ctx.window = ctx; vm.createContext(ctx); vm.runInContext(script, ctx);
    return { doc, win, chan, execs, posted, msg, frame, store, ctx, ready: (i) => { doc.deviceready(); chan.ready(Object.assign({ port: 4321, token: 'tok' }, i || {})); } };
  };
  let w = run({});
  assert.strictEqual(w.msg.textContent, 'Starting Archne...', 'bawaan English');
  w = run({ 'lc.lang': 'id' });
  assert.strictEqual(w.msg.textContent, 'Memulai Archne...', 'bahasa terakhir (localStorage) dipakai sebelum inti siap');
  w = run({}); w.ready({ lang: 'id' });
  const st = w.execs.find((x) => x.act === 'start');
  assert.deepStrictEqual(st.args, [4321, 'tok', 'id'], 'start() membawa bahasa dari inti');
  assert.strictEqual(w.store['lc.lang'], 'id', 'bahasa dicatat');
  w = run({ 'lc.lang': 'id' }); w.ready({});
  assert.deepStrictEqual(w.execs.find((x) => x.act === 'start').args, [4321, 'tok', 'en'], 'inti tanpa lang (versi lama) = en, cache dibuang');
  assert(!('lc.lang' in w.store));
  w = run({}); w.ready({ lang: 'en' });
  const ORIGIN = 'http://127.0.0.1:4321';
  w.win.message({ origin: ORIGIN, source: w.frame.contentWindow, data: { archne: 'native', action: 'lang', lang: 'id' } });
  assert.deepStrictEqual(w.execs.filter((x) => x.act === 'setLang').map((x) => x.args), [['id']], 'UI ganti bahasa -> plugin setLang');
  w.win.message({ origin: 'http://evil', source: w.frame.contentWindow, data: { archne: 'native', action: 'lang', lang: 'en' } });
  assert.strictEqual(w.execs.filter((x) => x.act === 'setLang').length, 1, 'origin asing diabaikan');
  // galat plugin unduhan diterjemahkan sesuai bahasa; pesan sistem mentah diteruskan apa adanya
  for (const [l, tt] of [['en', W.en.e_storageFull], ['id', W.id.e_storageFull]]) {
    w = run({}); w.ready({ lang: l, dxout: '/data/user/0/x/dxout' });
    w.win.message({ origin: ORIGIN, source: w.frame.contentWindow, data: { archne: 'native', action: 'dxpick', id: 7, job: 'j1' } });
    w.execs.find((x) => x.act === 'access').okf('ok');
    w.execs.find((x) => x.act === 'pick').erf('e:storageFull');
    assert.strictEqual(w.posted.filter((m) => m.archne === 'native-pick').pop().err, tt, 'galat pilih berkas (' + l + ')');
  }
  w = run({}); w.ready({ lang: 'id', dxout: '/data/user/0/x/dxout' });
  w.win.message({ origin: ORIGIN, source: w.frame.contentWindow, data: { archne: 'native', action: 'dxpick', id: 8, job: 'j2' } });
  w.execs.find((x) => x.act === 'access').okf('ok'); w.execs.find((x) => x.act === 'pick').erf('EIO: pesan sistem');
  assert.strictEqual(w.posted.filter((m) => m.archne === 'native-pick').pop().err, 'EIO: pesan sistem', 'pesan sistem mentah tidak diubah');
  // teks yang dikirim ke UI mengikuti bahasa (sekarang id, setelah pesan lang di atas)
  w.execs.length = 0;
  w.win.message({ origin: ORIGIN, source: w.frame.contentWindow, data: { archne: 'native', action: 'battery' } });
  w.execs.find((x) => x.act === 'batteryAsk').okf('ok');
  assert.strictEqual(w.posted[w.posted.length - 1].text, W.id.battOk, 'info baterai berbahasa Indonesia setelah diganti');
  w.win.message({ origin: ORIGIN, source: w.frame.contentWindow, data: { archne: 'native', action: 'lang', lang: 'en' } });
  w.win.message({ origin: ORIGIN, source: w.frame.contentWindow, data: { archne: 'native', action: 'battery' } });
  w.execs.filter((x) => x.act === 'batteryAsk').pop().okf('asked');
  assert.strictEqual(w.posted[w.posted.length - 1].text, W.en.battAsk, 'dan kembali English');
  ok('halaman pembungkus: kamus en==id, tanpa teks Indonesia di luar kamus, bahasa dari inti/cache/UI diteruskan ke plugin, origin dijaga');

  // sisi pengirim: inti Node mengirim lang di ready; UI mengirim pesan saat bahasa disimpan
  assert(/lang: langNow\(\)/.test(rd('android', 'www', 'nodejs-project', 'main.js')), "main.js: ready membawa lang");
  assert(/postMessage\(\{ archne: 'native', action: 'lang', lang: pick \}/.test(rd('renderer', 'js', 'archne-lang.js')), 'archne-lang.js memberi tahu pembungkus');
  const bgJ = rd('android', 'localplugins', 'archne-background', 'src', 'android', 'ArchneBackground.java');
  assert(/"setLang"\.equals\(action\)/.test(bgJ) && /args\.length\(\) > 2/.test(bgJ), 'plugin: setLang + argumen lang pada start');
  ok('jalur bahasa: inti (ready.lang) + UI (pesan lang) -> pembungkus -> plugin (start/setLang)');
}

console.log('i18n: semua lulus');
