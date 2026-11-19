// ---- Pengaturan foto (v0.25.0 Step 1): unduh foto otomatis ----
// Bawaan menyala: foto (hingga batas ukuran di bawah) yang dikirim lewat chat pribadi atau grup oleh pengirim yang terhubung lewat jaringan lokal
// diunduh sendiri, jadi langsung tampil penuh. Tidak pernah berlaku di Publik. Mati = foto hanya diunduh saat diketuk.
// Backend: src/core/archne-media.js dan src/core/archne-settings.js (kunci `autoImg`).
SET_SECTIONS.push({
  id: 'media', icon: 'image', order: 22,
  get title() { return txf('media.title', 'Foto'); },
  html(d) {
    const a = d.autoImg || { mode: 'lan', max: 8 * 1048576 }, on = a.mode !== 'off';
    return `<label class="wchk"><input type="checkbox" id="setautoimg"${on ? ' checked' : ''}> <span>${esc(txf('media.auto', 'Unduh foto otomatis dari jaringan lokal'))}</span></label>`
      + `<div class="sint">${esc(txf('media.hint', 'Foto hingga {size} dari chat pribadi dan grup, hanya bila pengirim satu Wi-Fi/LAN denganmu. Foto di Publik tidak pernah diunduh otomatis. Pratinjau kecil selalu tampil tanpa mengunduh.', { size: FileCard.fmtSize(a.max) }))}</div>`;
  },
  async save(d) {
    const el = $('setautoimg');
    if (!el || typeof el.checked !== 'boolean') return { ok: true };
    const was = !d.autoImg || d.autoImg.mode !== 'off';
    if (el.checked === was) return { ok: true };
    const r = await window.api.setSettings({ autoImg: el.checked ? null : 'off' });
    if (!r || !r.ok) return { ok: false, err: txf('media.saveFail', 'Gagal menyimpan pengaturan foto') };
    return { ok: true, data: r, changed: true };
  },
});
