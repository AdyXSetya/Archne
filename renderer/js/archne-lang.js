// ---- Bahasa / Language (i18n A3): English (bawaan) / Bahasa Indonesia ----
// Pilihan disimpan di Core (settings.json, kunci `lang`; 'en' = kunci dibuang) dan dicatat di localStorage 'lc.lang' oleh I18N.setLang (renderer/archne-i18n.js).
// Meniru archne-theme.js: sinkron dari Core saat UI dibuka, bagian Pengaturan lewat SET_SECTIONS, simpan lewat window.api.setSettings.
// Beda dengan tema: TIDAK ada pratinjau langsung (teks baru dirender ulang setelah Simpan), jadi tidak perlu cancel().
// Judul bagian sengaja dwibahasa dan tidak diterjemahkan: orang yang tersesat di bahasa asing tetap bisa menemukannya.
// Aman dimuat tanpa archne-i18n.js (tes vm lama): semua akses ke I18N/tx dijaga typeof.
const LANG_OPTS = (typeof I18N !== 'undefined' && I18N.LANGS) || [['en', 'English'], ['id', 'Bahasa Indonesia']];
const langOk = (l) => LANG_OPTS.some((x) => x[0] === l);
const langT = (k) => (typeof tx === 'function' ? tx(k) : k);
function langUse(l) { if (typeof I18N !== 'undefined' && I18N.getLang() !== l) I18N.setLang(l); }
// Sinkron dengan Core saat UI dibuka (Core yang berwenang; cache hanya untuk kecepatan).
try {
  Promise.resolve(window.api.getSettings()).then((r) => { if (r && r.ok !== false && langOk(r.lang)) langUse(r.lang); }).catch(() => {});
} catch (x) {}

SET_SECTIONS.push({
  id: 'lang', title: 'Language / Bahasa', icon: 'globe', order: 5,
  html(d) {
    const cur = langOk(d.lang) ? d.lang : 'en';
    langUse(cur); // Core yang berwenang (mis. diganti dari jendela lain): samakan sebelum dialog menampilkannya
    return `<div class="sint">${esc(langT('settings.lang.hint'))}</div><div class="langset" role="radiogroup" aria-label="${esc(langT('settings.lang.label'))}">`
      + LANG_OPTS.map(([v, l]) => `<label class="lang"><input type="radio" name="setlang" id="setlang-${v}" value="${v}"${v === cur ? ' checked' : ''}><span class="langn" lang="${v}">${esc(l)}</span></label>`).join('')
      + '</div>';
  },
  change() {}, // tanpa pratinjau
  async save(d) {
    const was = langOk(d.lang) ? d.lang : 'en';
    const pick = LANG_OPTS.map(([v]) => v).find((v) => { const el = $('setlang-' + v); return el && el.checked; });
    if (!pick || pick === was) return { ok: true };
    const r = await window.api.setSettings({ lang: pick === 'en' ? null : pick });
    if (!r || !r.ok) return { ok: false, err: langT('settings.lang.saveFail') };
    langUse(pick); // setLang: cache + <html lang> + data-i18n; render ulang dilakukan refresh() di dialog Pengaturan
    // Android: halaman pembungkus (induk iframe) meneruskan bahasa ke teks native (notifikasi). Di Electron/peramban tidak ada induk: tidak berbuat apa-apa.
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ archne: 'native', action: 'lang', lang: pick }, '*'); } catch (x) {}
    return { ok: true, data: r, changed: true };
  },
});
