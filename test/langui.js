'use strict';
// Tes i18n A3: bagian Pengaturan "Language / Bahasa" (renderer/js/archne-lang.js) dijalankan di vm bersama renderer/archne-i18n.js + kamus.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const ok = (n) => console.log('  OK  ' + n);

(async () => {
  // ---- A4: struktur archne-index.html ----
  const idx = rd('renderer', 'archne-index.html'), head = idx.split('</head>')[0];
  assert(/<html lang="en">/.test(idx), 'bawaan <html lang="en">');
  assert(/<script>[^<]*lc\.lang[^<]*setAttribute\('lang'[^<]*<\/script>/.test(head), 'skrip kecil di <head> memasang lang dari cache sebelum render');
  const pos = (f) => idx.indexOf('<script src="' + f + '"></script>');
  const seq = ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js', 'archne-api-http.js'].map(pos);
  assert(seq.every((p, i) => p > 0 && (!i || p > seq[i - 1])), 'archne-i18n.js, kamus en, kamus id dimuat berurutan, paling awal (sebelum archne-api-http.js dan semua skrip lain)');
  assert(idx.indexOf('<script>I18N.applyDom()</script>') > pos('i18n/archne-id.js') && idx.indexOf('<script>I18N.applyDom()</script>') < pos('archne-api-http.js'), 'applyDom() awal sesudah kamus');
  assert(pos('js/archne-settings-relay.js') < pos('js/archne-lang.js') && pos('js/archne-lang.js') < pos('js/archne-theme.js'), 'archne-lang.js di antara 82 dan 85');
  for (const f of ['archne-i18n.js', 'i18n/archne-en.js', 'i18n/archne-id.js', 'js/archne-lang.js']) assert(fs.existsSync(path.join(root, 'renderer', f)), f + ' ada');
  ok('archne-index.html: lang bawaan en + skrip <head>, urutan muat archne-i18n.js -> en -> id -> applyDom -> archne-api-http.js, archne-lang.js antara 82 dan 85');

  const api = {
    getSettings: async () => api.ret,
    setSettings: async (p) => { api.calls.push(JSON.parse(JSON.stringify(p))); return { ok: true, lang: p.lang || 'en' }; },
    ret: { ok: true, lang: 'en' }, calls: [],
  };
  const calls = api.calls;
  // konteks vm baru: archne-i18n.js + kamus + archne-lang.js (cache localStorage awal bisa diisi)
  async function mk(ret, cache0) {
    const els = {}, cache = Object.assign({}, cache0), attrs = {};
    api.ret = ret;
    const E = (id) => els[id] || (els[id] = { id, checked: false });
    const ctx = { window: { api }, SET_SECTIONS: [], esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), $: E,
      document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
      localStorage: { getItem: (k) => (k in cache ? cache[k] : null), setItem: (k, v) => { cache[k] = String(v); }, removeItem: (k) => { delete cache[k]; } },
      Promise, Intl, Object, Set, String, console };
    vm.createContext(ctx);
    for (const f of [['renderer', 'archne-i18n.js'], ['renderer', 'i18n', 'archne-en.js'], ['renderer', 'i18n', 'archne-id.js'], ['renderer', 'js', 'archne-lang.js']]) vm.runInContext(rd(...f), ctx, { filename: f.join('/') });
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    return { ctx, E, cache, attrs, I: ctx.I18N, S: ctx.SET_SECTIONS.find((s) => s.id === 'lang') };
  }
  let { ctx, E, cache, attrs, I, S } = await mk({ ok: true, lang: 'en' });
  assert(S && S.icon === 'globe' && S.title === 'Language / Bahasa', 'bagian terdaftar, judul dwibahasa');
  assert(S.order < 10, 'tampil paling atas (sebelum Tampilan)');
  ok('bagian "Language / Bahasa" terdaftar di SET_SECTIONS (paling atas, ikon globe)');

  // sinkron dari Core saat UI dibuka (cache lama 'en', Core bilang 'id')
  assert.strictEqual(I.getLang(), 'en');
  ({ ctx, E, cache, attrs, I, S } = await mk({ ok: true, lang: 'id' }));
  assert.strictEqual(I.getLang(), 'id', 'bahasa dari Core dipasang saat UI dibuka');
  assert.strictEqual(cache['lc.lang'], 'id'); assert.strictEqual(attrs.lang, 'id');
  ok('saat UI dibuka: bahasa dari Core dipasang, dicatat di localStorage dan <html lang>');
  const S2 = S;
  const h = S2.html({ lang: 'id' });
  assert(/id="setlang-id"[^>]*checked/.test(h) && !/id="setlang-en"[^>]*checked/.test(h), 'yang tersimpan terpilih');
  assert(h.includes('>English<') && h.includes('>Bahasa Indonesia<'), 'nama bahasa asli');
  assert(h.includes('Pilih bahasa aplikasi'), 'teks petunjuk memakai kamus bahasa aktif');
  assert(/id="setlang-en"[^>]*checked/.test(S2.html({ lang: 'xx' })), 'nilai tak dikenal -> English');
  ok('html(): radio English/Indonesia, yang tersimpan terpilih, teks dari kamus');

  // simpan
  const pick = (v) => { for (const l of ['en', 'id']) E('setlang-' + l).checked = l === v; };
  pick('id'); calls.length = 0;
  let r = await S2.save({ lang: 'id' });
  assert(r.ok && !r.changed && !calls.length, 'tidak berubah -> tidak menyimpan');
  pick('en');
  r = await S2.save({ lang: 'id' });
  assert.deepStrictEqual(calls, [{ lang: null }], "English dikirim sebagai null (bawaan, kunci dibuang)");
  assert(r.ok && r.changed && r.data.lang === 'en');
  assert.strictEqual(I.getLang(), 'en'); assert(!('lc.lang' in cache), "cache dibuang bila 'en'"); assert.strictEqual(attrs.lang, 'en');
  pick('id'); calls.length = 0;
  r = await S2.save({ lang: 'en' });
  assert.deepStrictEqual(calls, [{ lang: 'id' }]); assert.strictEqual(I.getLang(), 'id'); assert.strictEqual(cache['lc.lang'], 'id');
  ok('save(): tidak berubah = tanpa panggilan; en -> {lang:null}; id -> {lang:"id"}; I18N.setLang + cache + <html lang> ikut');

  // gagal simpan: bahasa tidak berubah
  I.setLang('en'); pick('id');
  const bad = api.setSettings; api.setSettings = async () => ({ ok: false });
  r = await S2.save({ lang: 'en' });
  assert(r.ok === false && r.err === 'Could not save the language' && I.getLang() === 'en');
  api.setSettings = bad;
  ok('gagal simpan: galat ditampilkan (kamus), bahasa tidak berubah');

  // tanpa archne-i18n.js (tes vm lama) tetap aman dimuat
  const bare = { window: { api }, SET_SECTIONS: [], esc: ctx.esc, $: E, Promise, Object, console };
  vm.createContext(bare); vm.runInContext(rd('renderer', 'js', 'archne-lang.js'), bare);
  assert.strictEqual(bare.SET_SECTIONS.length, 1); assert(bare.SET_SECTIONS[0].html({ lang: 'en' }).includes('setlang-en'));
  ok('aman dimuat tanpa archne-i18n.js (tes vm lama)');
  console.log('langui: lulus');
})().catch((e) => { console.error(e); process.exit(1); });
