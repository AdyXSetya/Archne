// Halaman, reaksi (4a-6; dipecah dari archne-pages.js seperti 33-35): baris chip di bawah postingan orang lain + pemilih reaksi. Skrip global biasa, dimuat sesudah archne-pages-files.js; memakai pgF, pgId, pgTok, pgMsg, PG_HEX16, renderFeed (32), S, nameOf, fmt, esc, toast, dan rxShow (archne-msgmenu.js, hanya saat dipanggil).
// Feed orang lain DAN Halamanku (4a-7): pgMine membawa rx / mine / who. Di Halamanku pemilik bereaksi lewat peer = id sendiri (lokal, tanpa jaringan) dan melihat SIAPA yang bereaksi (p.who = [{ e, by: [id] }], hanya dari kanal pemilik; feed orang lain tidak pernah membawanya).
// Ketuk chip / emoji = pasang; ketuk reaksiku sendiri = cabut; emoji lain = ganti (satu reaksi per orang, aturan pemilik). Pembaruan optimistik: tampilan berubah dulu, lalu diganti keadaan dari Core ({ rx, mine } sesudah perubahan); gagal atau null = kembali ke keadaan lama + pesan.
const PG_RX_QUICK = ['👍', '🩷', '\u263A\uFE0F', '🤣', '🥺', '😭']; // sama dengan DEFAULTS di src/archne-reactions.js (renderer tidak bisa require); emoji lain muncul sebagai chip dari penonton lain dan bisa diketuk
const PG_RX_ERR = { get old() { return txf('pg.rxOld', 'Aplikasi pemilik belum mendukung reaksi.'); } }; // getter: mengikuti bahasa aktif
const pgRxShow = (e) => (typeof rxShow === 'function' ? rxShow(e) : esc(e));
// Keadaan setelah `mine` diganti `next` ('' = cabut): rx = [{ e, n }] terbanyak dulu (urutan sama tetap), mine = next. Murni; tidak mengubah masukan.
function pgRxApply(rx, mine, next) {
  const out = [];
  for (const x of Array.isArray(rx) ? rx : []) { const n = mine && x.e === mine ? x.n - 1 : x.n; if (n > 0) out.push({ e: x.e, n }); }
  if (next) { const t = out.find((x) => x.e === next); if (t) t.n++; else out.push({ e: next, n: 1 }); }
  return { rx: out.map((x, i) => [x, i]).sort((a, b) => b[0].n - a[0].n || a[1] - b[1]).map((a) => a[0]), mine: next };
}
// 4a-7 (pemilik): daftar pelaku sesudah `me` mengganti `mine` dengan `next` ('' = cabut); disejajarkan dengan rx baru (urutan sama), pelaku baru di ujung. Murni; tidak mengubah masukan.
function pgWhoApply(who, me, mine, next, rx) {
  const m = new Map();
  for (const w of Array.isArray(who) ? who : []) { if (!w || typeof w.e !== 'string') continue; const by = (Array.isArray(w.by) ? w.by : []).filter((i) => !(mine && w.e === mine && i === me)); if (by.length) m.set(w.e, by); }
  if (next) { const by = (m.get(next) || []).slice(); if (!by.includes(me)) by.push(me); m.set(next, by); }
  return rx.map((x) => ({ e: x.e, by: (m.get(x.e) || []).slice() }));
}
function pgRxSet(p, s) { // tulis { rx, mine, who? } ke postingan; kosong = tanpa field (sama dengan postingan tanpa reaksi)
  if (s && Array.isArray(s.rx) && s.rx.length) p.rx = s.rx.map((x) => ({ e: x.e, n: x.n })); else delete p.rx;
  if (s && s.mine && p.rx) p.mine = s.mine; else delete p.mine;
  if (s && Array.isArray(s.who) && p.rx) p.who = s.who.filter((w) => w && typeof w.e === 'string').map((w) => ({ e: w.e, by: (Array.isArray(w.by) ? w.by : []).slice() })); else delete p.who;
}
const PG_WHO_SHOW = 20; // nama yang ditampilkan per emoji; sisanya "dan N lainnya"
const pgWhoNames = (by) => { const ids = (Array.isArray(by) ? by : []).filter((i) => typeof i === 'string' && PG_HEX16.test(i)), names = ids.slice(0, PG_WHO_SHOW).map((i) => esc(nameOf(i))).join(', '); return ids.length > PG_WHO_SHOW ? tnf('pg.whoMore', ids.length - PG_WHO_SHOW, '{names} dan {count} lainnya', { names, count: fmt(ids.length - PG_WHO_SHOW) }) : names; }; // {names} sudah di-esc
function pgWhoHtml(p) { // panel "siapa yang bereaksi": hanya Halamanku
  const rows = (Array.isArray(p.who) ? p.who : []).filter((w) => w && typeof w.e === 'string' && Array.isArray(w.by) && w.by.length);
  return `<div class="pgwho" role="group" aria-label="${txf('pg.whoAria', 'Siapa yang bereaksi')}">${rows.map((w) => `<div class="pgwhorow"><span class="pgwhoe">${pgRxShow(w.e)}</span><span>${pgWhoNames(w.by)}</span></div>`).join('')}</div>`;
}
function pgRxHtml(p) {
  const f = pgF, rx = Array.isArray(p.rx) ? p.rx : [], busy = !!(f.rxb && f.rxb[p.id]), dis = busy ? ' disabled' : '';
  const btn = (e, n) => `<button type="button" class="pgrx${e === p.mine ? ' mine' : ''}" data-pg="rx" data-id="${p.id}" data-e="${esc(e)}" aria-pressed="${e === p.mine}" aria-label="${n ? tnf('pg.rxAriaN', n, 'Reaksi {e}, {n} orang', { e: esc(e) }) : txf('pg.rxAria', 'Reaksi {e}', { e: esc(e) })}"${dis}>${pgRxShow(e)}${n ? '<b>' + n + '</b>' : ''}</button>`;
  const open = f.rxOpen === p.id;
  const add = `<button type="button" class="pgrx pgrxadd" data-pg="rxadd" data-id="${p.id}" aria-label="${txf('pg.rxAdd', 'Tambah reaksi')}" aria-expanded="${open}"${dis}>＋</button>`;
  const hasWho = f.mine && rx.length > 0 && Array.isArray(p.who) && p.who.some((w) => w && Array.isArray(w.by) && w.by.length), wopen = hasWho && !!(f.whoOpen && f.whoOpen.has(p.id)); // daftar pelaku: hanya pemilik, hanya bila ada reaksi
  const who = hasWho ? `<button type="button" class="pgrx pgrxwho" data-pg="who" data-id="${p.id}" aria-label="${txf('pg.whoAria', 'Siapa yang bereaksi')}" aria-expanded="${wopen}">${txf('pg.who', 'Siapa')}</button>` : '';
  return `<div class="pgrxs">${rx.map((r) => btn(r.e, r.n)).join('')}${add}${who}</div>${open ? `<div class="pgrxpick" role="group" aria-label="${txf('pg.rxPick', 'Pilih reaksi')}">${PG_RX_QUICK.map((e) => btn(e, 0)).join('')}</div>` : ''}${wopen ? pgWhoHtml(p) : ''}`;
}
function pgRxMenu(id) { const f = pgF; if (!f) return; f.rxOpen = f.rxOpen === id ? null : id; renderFeed(); }
function pgWho(id) { const f = pgF; if (!f || !f.mine || !f.items.some((p) => p.id === id && Array.isArray(p.rx) && p.rx.length)) return; const o = f.whoOpen || (f.whoOpen = new Set()); if (o.has(id)) o.delete(id); else o.add(id); renderFeed(); } // hanya postingan yang punya reaksi
async function pgRx(id, e) {
  const f = pgF, tok = pgTok; if (!f || typeof e !== 'string' || !e) return;
  const p = f.items.find((x) => x.id === id); if (!p) return;
  const rb = f.rxb || (f.rxb = {}); if (rb[id]) return; // satu permintaan per postingan
  const next = p.mine === e ? '' : e, before = { rx: p.rx, mine: p.mine, who: p.who }, peer = pgId; // di Halamanku peer = id sendiri: reaksi lokal tanpa jaringan
  const ap = pgRxApply(p.rx, p.mine, next); if (f.mine) ap.who = pgWhoApply(p.who, S.me.id, p.mine, next, ap.rx);
  pgRxSet(p, ap); rb[id] = true; f.rxOpen = null; renderFeed();
  let r; try { r = await window.api.pgReact(peer, id, next); } catch (x) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f) return; // layar ditutup / pindah selagi menunggu
  delete rb[id];
  if (r && r.ok && r.react) pgRxSet(p, f.mine ? r.react : { rx: r.react.rx, mine: r.react.mine }); // daftar pelaku hanya disimpan di Halamanku
  else { pgRxSet(p, before); toast(r && r.ok ? txf('pg.gone', 'Postingan ini sudah tidak tersedia.') : (r && PG_RX_ERR[r.code]) || pgMsg(r)); }
  renderFeed();
}
