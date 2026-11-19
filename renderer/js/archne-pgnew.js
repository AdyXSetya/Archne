// Lencana "postingan baru" di Halaman (5b-4a state, 5b-4b tampilan: titik di baris daftar lewat pgNewMark di archne-render.js dan di tombol Halaman lewat pgBtnFor di archne-pages.js; padam saat feed dibuka: 5b-4c lewat event Core + pgNewRefresh dari pgLoad). Skrip global biasa; dimuat sebelum archne-pages.js.
// Sumber kebenaran ada di Core: renderer cuma menyalin. pgNewSet = id pemilik (16 heks) yang lencananya menyala. Diisi dari window.api.pgNewList() saat mulai lalu disegarkan tiap PGN_RESYNC ms
// (jaga-jaga event hilang saat koneksi putus), dan diikuti lewat window.api.onPgNew({ peerId, on }). Event yang tiba selagi pgNewList berjalan diputar ulang di atas hasilnya, jadi hasil lama tidak menimpa event yang lebih baru.
// Data cacat (id bukan 16 heks, on bukan boolean, peers bukan larik) diabaikan. Gagal ambil = set lama dipertahankan. pgNewOnChange (bawaan pgNewRepaint, 5b-4b) dipanggil bila isi set benar-benar berubah.
const PGN_HEX = /^[0-9a-f]{16}$/, PGN_RESYNC = 30e3;
const pgNewSet = new Set();
const PGN_DOT = '<span class="pgdot" aria-hidden="true"></span>';
let pgNewOnChange = pgNewRepaint, pgNewWired = false, pgNewBusy = false, pgNewPend = null, pgNewAgain = false;
function pgNewHas(id) { return pgNewSet.has(id); }
// Titik untuk baris daftar (5b-4b): role img + label karena berdiri sendiri; di tombol Halaman labelnya ada di tombol (aria-label), titiknya aria-hidden.
function pgNewMark(id) { if (!pgNewSet.has(id)) return ''; const t = esc(txf('pg.newMark', 'Postingan baru di Halaman')); return '<span class="pgdot" role="img" aria-label="' + t + '" title="' + t + '"></span>'; }
// Gambar ulang daftar dan profil yang sedang terbuka (milik orang lain; profil sendiri tidak punya lencana, jadi tidak disentuh agar isian tidak hilang).
function pgNewRepaint() {
  if (typeof render === 'function') render();
  if (typeof profId !== 'undefined' && profId && !(S.me && profId === S.me.id) && typeof renderProfile === 'function') renderProfile();
}
function pgNewFire() { if (typeof pgNewOnChange === 'function') { try { pgNewOnChange(); } catch {} } }
function pgNewApply(id, on) { // -> true bila set berubah
  if (!PGN_HEX.test(String(id)) || typeof on !== 'boolean') return false;
  if (on === pgNewSet.has(id)) return false;
  if (on) pgNewSet.add(id); else pgNewSet.delete(id);
  return true;
}
function pgNewEvent(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.peerId !== 'string') return;
  if (pgNewBusy) pgNewPend.push(ev); // diputar ulang sesudah pgNewList selesai
  if (pgNewApply(ev.peerId, ev.on)) pgNewFire();
}
async function pgNewLoad() {
  if (pgNewBusy || !window.api || typeof window.api.pgNewList !== 'function') return;
  pgNewBusy = true; pgNewPend = []; pgNewAgain = false;
  let r = null;
  try { r = await window.api.pgNewList(); } catch { r = null; }
  const pend = pgNewPend, again = pgNewAgain; pgNewBusy = false; pgNewPend = null; pgNewAgain = false;
  try {
    if (!(r && r.ok === true && Array.isArray(r.peers))) return; // gagal: set lama tetap
    const before = [...pgNewSet].sort().join(',');
    pgNewSet.clear();
    for (const id of r.peers) if (typeof id === 'string' && PGN_HEX.test(id)) pgNewSet.add(id);
    for (const ev of pend) pgNewApply(ev.peerId, ev.on);
    if ([...pgNewSet].sort().join(',') !== before) pgNewFire();
  } finally { if (again) pgNewLoad(); } // ada permintaan segar selagi berjalan: hasil tadi bisa lebih tua dari perubahan di Core, ulangi sekali
}
// 5b-4c: dipanggil sesudah feed orang lain berhasil dibuka (halaman pertama). Core sudah menandai dilihat dan mengirim event on:false; ini jaring pengaman bila event hilang. Selagi pgNewList berjalan, permintaan dicatat dan diulang sekali sesudahnya.
function pgNewRefresh() { if (pgNewBusy) { pgNewAgain = true; return; } pgNewLoad(); }
function pgNewStart() {
  if (pgNewWired || !window.api) return;
  pgNewWired = true;
  if (typeof window.api.onPgNew === 'function') window.api.onPgNew(pgNewEvent);
  pgNewLoad();
  setInterval(pgNewLoad, PGN_RESYNC);
}
pgNewStart();
