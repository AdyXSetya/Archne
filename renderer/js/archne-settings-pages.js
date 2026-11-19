// ---- Pengaturan: Halaman (5a-4) ----
// Satu saklar (layani Halaman milikku ke orang lain) dan dua angka (batas stream video bersamaan dari Halaman orang lain: per aplikasi dan per pemilik).
// Backend dan validasi ada di Core (src/core/archne-settings.js, kunci pagesServe / pgStreamMax / pgStreamPeer); di sini hanya pra-cek ringan supaya galatnya ramah.
// Nilai bawaan, minimum, dan maksimum dibaca dari getSettings().pages (tidak disalin ke UI).
const PGS_ROWS = [ // title/hint getter: dibaca saat dipakai (mengikuti bahasa aktif)
  { key: 'pgStreamMax', f: 'max', id: 'setpgmax',
    get title() { return txf('pgs.maxTitle', 'Video bersamaan (semua pemilik)'); },
    get hint() { return txf('pgs.maxHint', 'Paling banyak berapa video dari Halaman orang lain yang boleh diputar sekaligus. Video yang sedang berjalan tidak dipotong saat batas diturunkan; hanya video baru yang ditolak.'); } },
  { key: 'pgStreamPeer', f: 'peer', id: 'setpgpeer',
    get title() { return txf('pgs.peerTitle', 'Video bersamaan (per pemilik)'); },
    get hint() { return txf('pgs.peerHint', 'Batas untuk satu pemilik Halaman, supaya satu orang tidak memakai seluruh jatah dan jaringanmu.'); } },
];
const pgsErr = (key, r) => {
  const row = PGS_ROWS.find((x) => x.key === key), title = row && row.title;
  if (r.code === 'min') return row ? txf('set.errMinFor', 'Minimal {size} untuk "{title}"', { size: r.min, title }) : txf('set.errMin', 'Minimal {size}', { size: r.min });
  if (r.code === 'max') return row ? txf('set.errMaxFor', 'Maksimal {size} untuk "{title}"', { size: r.max, title }) : txf('set.errMax', 'Maksimal {size}', { size: r.max });
  if (r.code === 'io') return txf('set.errIo', 'Gagal menyimpan pengaturan. Penyimpanan perangkat mungkin penuh atau tidak bisa ditulis.');
  return row ? txf('pgs.errBadFor', 'Pengaturan Halaman tidak sah untuk "{title}"', { title }) : txf('pgs.errBad', 'Pengaturan Halaman tidak sah');
};
SET_SECTIONS.push({
  id: 'pages', icon: 'globe', order: 25,
  get title() { return txf('pgs.title', 'Halaman'); },
  html(d) {
    const p = d.pages, st = p && p.streams;
    if (!p || !st) return ''; // inti lama tanpa pengaturan ini
    const rows = PGS_ROWS.map((r) => `<div class="strow"><div class="stt">${esc(r.title)}</div><div class="sth">${esc(r.hint)}</div><div class="stc"><input id="${r.id}" class="stmb" type="number" min="${st.min[r.f]}" max="${st.ceil[r.f]}" step="1" inputmode="numeric" value="${st[r.f]}" aria-label="${esc(r.title)}"><span class="stmbl">${esc(txf('pgs.range', '{min} sampai {max} (bawaan {def})', { min: st.min[r.f], max: st.ceil[r.f], def: st.def[r.f] }))}</span></div></div>`).join('');
    return '<div class="sint">' + esc(txf('pgs.intro', 'Atur siapa yang bisa membaca Halamanmu dan seberapa banyak video Halaman orang lain boleh memakai jaringanmu. Perubahan berlaku seketika.')) + '</div>'
      + `<div class="setgrp"><div class="strow"><div class="stt">${esc(txf('pgs.serveTitle', 'Layani Halamanku'))}</div><div class="sth">${esc(txf('pgs.serveHint', 'Bila dimatikan, orang lain tidak bisa membaca, bereaksi, atau berkomentar di Halamanmu, dan jawaban Archne-mu sama seperti pemilik yang belum punya Halaman. Kamu tetap bisa memakai Halamanmu sendiri. Komentar yang masih mengantre ke kamu dibuang.'))}</div><div class="stc"><label class="wchk"><input type="checkbox" id="setpgserve"${p.serve ? ' checked' : ''}> <span>${esc(txf('pgs.on', 'Aktif'))}</span></label></div></div>${rows}</div>`;
  },
  async save(d) {
    const p = d.pages, st = p && p.streams, sv = $('setpgserve');
    if (!p || !st || !sv || typeof sv.checked !== 'boolean') return { ok: true };
    const patch = {};
    if (sv.checked !== p.serve) patch.pagesServe = sv.checked ? null : false;
    for (const r of PGS_ROWS) {
      const el = $(r.id); if (!el) continue;
      const raw = String(el.value).trim(), n = Number(raw);
      if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(n)) return { ok: false, err: txf('pgs.errInt', 'Isi angka bulat untuk "{title}"', { title: r.title }) };
      if (n < st.min[r.f]) return { ok: false, err: pgsErr(r.key, { code: 'min', min: st.min[r.f] }) };
      if (n > st.ceil[r.f]) return { ok: false, err: pgsErr(r.key, { code: 'max', max: st.ceil[r.f] }) };
      if (n === st[r.f]) continue; // tidak berubah: jangan menulis apa pun
      patch[r.key] = n === st.def[r.f] ? null : n;
    }
    if (!Object.keys(patch).length) return { ok: true };
    const res = await window.api.setSettings(patch);
    if (res && res.ok) return { ok: true, data: res, changed: true };
    const r = res || {}, key = r.key && PGS_ROWS.some((x) => x.key === r.key) ? r.key : '';
    return { ok: false, err: pgsErr(key, r) };
  },
});
