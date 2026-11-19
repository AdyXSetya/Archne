// ---- Tampilan (v0.23.1): Otomatis (ikut sistem) / Gelap / Terang ----
// Pilihan disimpan di Core (settings.json, kunci `theme`, ikut ke semua jendela dan tidak hilang walau alamat UI berganti) dan dicatat juga di
// localStorage 'lc.theme' supaya skrip kecil di <head> archne-index.html bisa memasang tema sebelum halaman tergambar (tanpa kedip).
// Gaya ada di css/archne-theme.css: atribut data-theme="dark|light" di <html>; tanpa atribut = ikut sistem lewat prefers-color-scheme.
const THEME_KEY = 'lc.theme';
const themeOpts = () => [['system', txf('theme.auto', 'Otomatis')], ['dark', txf('theme.dark', 'Gelap')], ['light', txf('theme.light', 'Terang')]]; // label dibaca saat dipakai (mengikuti bahasa aktif)
const themeOk = (t) => t === 'system' || t === 'dark' || t === 'light';
let themeSaved = 'system';
function themeApply(t) {
  const root = typeof document !== 'undefined' && document.documentElement;
  if (!root || !root.setAttribute) return;
  if (t === 'dark' || t === 'light') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
}
function themeCache(t) {
  try { if (t === 'dark' || t === 'light') localStorage.setItem(THEME_KEY, t); else localStorage.removeItem(THEME_KEY); } catch (x) {}
}
function themeUse(t) { if (!themeOk(t)) t = 'system'; themeSaved = t; themeApply(t); themeCache(t); }
// Sinkron dengan Core saat UI dibuka (Core yang berwenang; cache hanya untuk kecepatan).
try {
  Promise.resolve(window.api.getSettings()).then((r) => { if (r && r.ok !== false && themeOk(r.theme)) themeUse(r.theme); }).catch(() => {});
} catch (x) {}

SET_SECTIONS.push({
  id: 'theme', icon: 'palette', order: 10,
  get title() { return txf('theme.title', 'Tampilan'); },
  html(d) {
    const cur = themeOk(d.theme) ? d.theme : 'system';
    if (cur !== themeSaved) themeUse(cur); // Core yang berwenang (mis. diganti dari jendela lain): samakan sebelum dialog menampilkannya
    const half = (k) => `<b class="${k}"><i></i><i></i></b>`;
    const prev = { system: half('d') + half('l'), dark: half('d'), light: half('l') };
    return '<div class="sint">' + esc(txf('theme.intro', 'Otomatis mengikuti mode gelap atau terang di perangkatmu.')) + '</div><div class="thmset" role="radiogroup" aria-label="' + esc(txf('theme.title', 'Tampilan')) + '">'
      + themeOpts().map(([v, l]) => `<label class="thm"><input type="radio" name="settheme" id="settheme-${v}" value="${v}"${v === cur ? ' checked' : ''}><span class="thmp" aria-hidden="true">${prev[v]}</span><span class="thmn">${esc(l)}</span></label>`).join('')
      + '</div>';
  },
  change(e) { // pratinjau langsung; baru tersimpan saat menekan Simpan
    const t = e && e.target;
    if (t && t.name === 'settheme' && themeOk(t.value)) themeApply(t.value);
  },
  async save(d) {
    const pick = themeOpts().map(([v]) => v).find((v) => { const el = $('settheme-' + v); return el && el.checked; });
    if (!pick || pick === (themeOk(d.theme) ? d.theme : 'system')) return { ok: true };
    const r = await window.api.setSettings({ theme: pick === 'system' ? null : pick });
    if (!r || !r.ok) return { ok: false, err: txf('theme.saveFail', 'Gagal menyimpan tampilan') };
    themeUse(pick);
    return { ok: true, data: r, changed: true };
  },
  cancel() { themeApply(themeSaved); }, // ditutup tanpa menyimpan: kembali ke tema yang tersimpan
});
