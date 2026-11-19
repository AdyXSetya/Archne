// Halaman, sinkron langsung (5d-8): komentar dan reaksi baru muncul di layar yang SEDANG terbuka, tanpa tutup-buka. Skrip global biasa, dimuat sesudah archne-pages-arc.js; memakai pgF, pgId, pgTok, PG_HEX16, renderFeed (32), pgRxSet (36), pgCmtMerge (37).
// Dua jalur, tanpa pesan jaringan baru (hanya pgMine / pgList / pgComments yang sudah ada):
//   1. Halamanku: Core mengirim event lokal 'pgact' { postId, kind:'cmt'|'rx' } tiap ada komentar / reaksi masuk (window.api.onPgAct) -> sinkron sesudah 400 ms (digabung).
//   2. Halaman siapa pun: pemilik tidak bisa mendorong ke penonton (itu butuh pesan jaringan baru), jadi layar menyegarkan diri tiap PG_SYNC_MS selagi terbuka dan jendela terlihat, dan sekali lagi saat jendela kembali terlihat.
// Yang disegarkan: reaksi (rx / mine / who) postingan yang sudah ada, postingan BARU di ujung atas (lebih dari 50 sekaligus: disambung lewat kursor, atau dimuat ulang bila terlalu banyak), postingan yang DIHAPUS pemilik (hilang dari daftar), dan di utas yang sedang terbuka: komentar baru + hitungan (kursor ts:id) serta komentar yang dihapus (utas dimuat ulang bila hitungan tak cocok).
// Tidak menyentuh yang sedang berjalan (reaksi sedang dikirim, komentar sedang dikirim, muat sedang berlangsung), dan menggambar ulang hanya bila ada yang berubah (draf dan fokus kotak komentar dijaga renderFeed).
const PG_SYNC_MS = 20000;
const PG_SYNC_PAGES = 6; // halaman tambahan (@50) untuk menyambung celah bila lebih dari 50 postingan baru: sampai 300 postingan; lebih dari itu = daftar dimuat ulang dari atas
const PG_SYNC_CMT_PAGES = 6; // 6 x 100 >= 500 (batas komentar per postingan, CMT_PER_POST di src/archne-pagecmt.js)
let pgSyncT = null;
let pgSyncSoonT = null;
let pgSyncBusy = false;
let pgSyncAgain = false;
let pgSyncWired = false;
let pgSyncRxHint = false; // 5g: ada event reaksi masuk sejak sinkron terakhir -> reaksi komentar di utas terbuka ikut disegarkan (tanpa event: tidak ada tarikan tambahan)

function pgSyncSig(p) { return JSON.stringify([p.rx || null, p.mine || null, p.who || null]); }
// Tarik daftar terbaru (50 teratas). Bila tak satu pun yang sudah dikenal ada di sana (lebih dari 50 postingan baru sekaligus), ikuti kursor `next` sampai ketemu yang dikenal (maks PG_SYNC_PAGES halaman); masih belum ketemu = gap: true (pemanggil memuat ulang dari atas). null = galat sesaat / layar berganti.
async function pgSyncFeed(f, tok, id) {
  const get = (o) => (f.mine ? window.api.pgMine(o) : window.api.pgList(id, o));
  let r; try { r = await get({ limit: 50 }); } catch (e) { return null; }
  if (tok !== pgTok || pgF !== f || !r || !r.ok) return null;
  const acc = { ok: true, items: Array.isArray(r.items) ? r.items.slice() : [], next: typeof r.next === 'string' ? r.next : null, count: r.count };
  const known = () => acc.items.some((p) => p && f.ids.has(p.id));
  for (let i = 0; i < PG_SYNC_PAGES && acc.next && f.items.length && !known(); i++) {
    let r2; try { r2 = await get({ limit: 50, after: acc.next }); } catch (e) { return null; }
    if (tok !== pgTok || pgF !== f || !r2 || !r2.ok) return null; // galat sesaat: siklus berikutnya mencoba lagi
    acc.items = acc.items.concat(Array.isArray(r2.items) ? r2.items : []); acc.next = typeof r2.next === 'string' ? r2.next : null;
  }
  acc.gap = !!(f.items.length && acc.next && !known());
  return acc;
}
// Gap terlalu besar: buang daftar yang dimuat lalu muat ulang dari atas. Keadaan utas komentar (f.cm), teks utuh, dan lipatan dipertahankan (kuncinya id postingan).
function pgSyncReset(f) { f.items = []; f.ids = new Set(); f.next = null; f.done = false; f.loaded = false; f.skipped = 0; f.err = null; pgLoad(); }
// Gabungkan hasil daftar terbaru ke feed. true bila ada yang berubah. `known` = id yang sudah ada SEBELUM penarikan dimulai: postingan yang kubuat selama menunggu bukan "terhapus".
function pgSyncMerge(f, r, known) {
  let ch = false;
  const items = (Array.isArray(r.items) ? r.items : []).filter((p) => p && typeof p.id === 'string' && PG_HEX16.test(p.id));
  const rid = new Set(items.map((p) => p.id));
  // Terhapus: postingan yang kukenal dan letaknya di dalam rentang yang dicakup daftar ini (dari atas sampai postingan terakhirku yang masih ada di daftar; seluruhnya bila tak ada halaman berikutnya), tetapi tidak ada lagi.
  let lim = r.next ? -1 : f.items.length - 1;
  if (r.next) for (let i = f.items.length - 1; i >= 0; i--) if (rid.has(f.items[i].id)) { lim = i; break; }
  const gone = new Set();
  for (let i = 0; i <= lim; i++) { const p = f.items[i]; if (p && !rid.has(p.id) && known && known.has(p.id)) gone.add(p.id); }
  if (gone.size) {
    f.items = f.items.filter((p) => !gone.has(p.id));
    for (const id of gone) { f.ids.delete(id); f.open.delete(id); delete f.full[id]; if (f.cm) delete f.cm[id]; if (f.rxb) delete f.rxb[id]; }
    ch = true;
  }
  const fresh = []; let hit = false; // postingan baru = yang muncul SEBELUM postingan pertama yang sudah dikenal
  for (const p of items) { if (f.ids.has(p.id)) { hit = true; break; } fresh.push(p); }
  if (fresh.length && (hit || !f.items.length)) { for (const p of fresh) f.ids.add(p.id); f.items = fresh.concat(f.items); ch = true; }
  for (const p of items) {
    if (!f.ids.has(p.id) || (f.rxb && f.rxb[p.id])) continue;
    const t = f.items.find((x) => x.id === p.id);
    if (t && pgSyncSig(t) !== pgSyncSig(p)) { pgRxSet(t, f.mine ? p : { rx: p.rx, mine: p.mine }); ch = true; }
  }
  if (!f.mine && Number.isInteger(r.count) && r.count !== f.count) { f.count = r.count; ch = true; }
  return ch;
}
// Ada komentar yang hilang (dihapus pemilik / di perangkat lain): muat ulang rentang yang sudah termuat dari awal dan ganti isi utas. Seluruh utas bila sudah termuat penuh; kalau belum, sebanyak yang sudah termuat.
async function pgSyncCmtRebuild(f, tok, pid, cm) {
  const want = cm.next === null ? Infinity : Math.max(cm.items.length, 1);
  const t = { ids: new Set(), items: [] }; let next = null, skipped = 0, count = null;
  for (let i = 0; i < PG_SYNC_CMT_PAGES; i++) {
    const o = { limit: 100 }; if (next) o.after = next;
    let r; try { r = await window.api.pgComments(pgId, pid, o); } catch (e) { return false; }
    if (tok !== pgTok || pgF !== f || pgCmtGet(pid) !== cm || cm.busy || cm.sending || cm.rsending) return false;
    if (!r || !r.ok || !r.comments) return false; // galat sesaat: utas dibiarkan, dicoba lagi nanti
    pgCmtMerge(t, r.comments.items); pgCmtRxFrom(t, r.comments);
    if (Number.isInteger(r.comments.skipped)) skipped += r.comments.skipped;
    if (Number.isInteger(r.comments.count)) count = r.comments.count;
    next = typeof r.comments.next === 'string' ? r.comments.next : null;
    if (!next || t.items.length >= want) break;
  }
  cm.items = t.items; cm.ids = t.ids; cm.next = next; cm.skipped = skipped; if (count !== null) cm.count = count;
  return true;
}
// Satu utas yang terbuka dan sudah termuat semua halamannya (cm.next null): ambil yang lebih baru dari komentar terakhir. Bila masih ada halaman yang belum dimuat: hanya hitungan (limit 1).
// Komentar yang dihapus terdeteksi dari hitungan: jumlah komentar yang kupegang melebihi hitungan pemilik (utas penuh), atau hitungan turun (utas sebagian) = muat ulang rentang yang termuat. Sekali per keadaan (cm.rbSig = hitungan pemilik : yang kupegang), supaya hitungan pemilik yang janggal tidak memicu muat ulang tiap siklus.
async function pgSyncCmt(f, tok, pid, cm) {
  const full = cm.next === null, last = cm.items[cm.items.length - 1], o = full ? { limit: 100 } : { limit: 1 };
  // 5g: utas kecil (< 100 komentar, semua termuat) di halaman ORANG LAIN ditarik dari awal, bukan sesudah komentar terakhir: satu permintaan yang sama, tetapi jawabannya memuat reaksi SEMUA komentar (pemilik tidak bisa mendorong; ini satu-satunya jalan tanpa permintaan tambahan). Utas >= 100 komentar tetap memakai kursor (reaksi komentar lamanya menyegar saat dimuat ulang).
  const whole = full && !f.mine && cm.items.length < o.limit;
  if (full && last && !whole) o.after = last.ts + ':' + last.id;
  let r; try { r = await window.api.pgComments(pgId, pid, o); } catch (e) { return false; }
  if (tok !== pgTok || pgF !== f || pgCmtGet(pid) !== cm || cm.busy || cm.sending || cm.rsending) return false;
  if (!r || !r.ok) return false; // galat sesaat (offline): diam, siklus berikutnya mencoba lagi
  if (!r.comments) { if (!cm.gone) { cm.gone = true; return true; } return false; }
  let ch = false;
  if (full) { const n = pgCmtMerge(cm, r.comments.items); if (pgCmtRxFrom(cm, r.comments)) ch = true; if (n) { ch = true; if (typeof r.comments.next === 'string') cm.next = r.comments.next; } }
  const cnt = Number.isInteger(r.comments.count) ? r.comments.count : null, prev = cm.count;
  if (cnt !== null && cnt !== cm.count) { cm.count = cnt; ch = true; }
  const sig = () => cnt + ':' + (cm.items.length + cm.skipped); // tanda keadaan (hitungan pemilik : yang kupegang)
  if (cnt !== null && cm.rbSig !== sig() && (cm.items.length + cm.skipped > cnt || (!full && prev != null && cnt < prev))) {
    if (await pgSyncCmtRebuild(f, tok, pid, cm)) { ch = true; cm.rbSig = sig(); } // sukses: keadaan yang sama tidak dimuat ulang lagi; gagal (offline): dicoba lagi di siklus berikutnya
  }
  return ch;
}
// 5g: reaksi komentar di Halamanku (lokal, tanpa jaringan; hanya sesudah event 'rx'): muat ulang halaman-halaman yang sudah termuat dan terapkan reaksinya. Halaman orang lain tidak disegarkan di sini (butuh satu permintaan jaringan per halaman utas tiap siklus); di sana reaksi komentar menyegar saat utas dimuat ulang.
async function pgSyncCmtRx(f, tok, pid, cm) {
  if (!f.mine || !cm.items.length) return false;
  const last = cm.items[cm.items.length - 1].id; let next = null, ch = false;
  for (let i = 0; i < PG_SYNC_CMT_PAGES; i++) {
    const o = { limit: 100 }; if (next) o.after = next;
    let r; try { r = await window.api.pgComments(pgId, pid, o); } catch (e) { return ch; }
    if (tok !== pgTok || pgF !== f || pgCmtGet(pid) !== cm || cm.busy || cm.sending || cm.rsending) return ch;
    if (!r || !r.ok || !r.comments) return ch;
    if (pgCmtRxFrom(cm, r.comments)) ch = true;
    next = typeof r.comments.next === 'string' ? r.comments.next : null;
    if (!next || r.comments.items.some((x) => x.id === last)) break;
  }
  return ch;
}
async function pgSyncNow() {
  const f = pgF, tok = pgTok, id = pgId;
  if (!f || !id || !f.loaded || f.busy || f.err) return;
  const rxHint = pgSyncRxHint; pgSyncRxHint = false;
  if (typeof document !== 'undefined' && document && document.hidden) return;
  if (pgSyncBusy) { pgSyncAgain = true; return; }
  pgSyncBusy = true; let ch = false;
  try {
    const known = new Set(f.ids), r = await pgSyncFeed(f, tok, id);
    if (tok !== pgTok || pgF !== f) return;
    if (r && r.ok && !f.busy) {
      if (r.gap) { pgSyncReset(f); return; } // lebih dari yang bisa disambung: muat ulang dari atas (pgLoad menggambar sendiri)
      ch = pgSyncMerge(f, r, known) || ch;
    }
    for (const pid of Object.keys(f.cm || {})) {
      const cm = f.cm[pid];
      if (!cm || !cm.open || !cm.loaded || cm.busy || cm.gone || cm.sending || cm.rsending) continue;
      ch = (await pgSyncCmt(f, tok, pid, cm)) || ch;
      if (tok !== pgTok || pgF !== f) return;
      if (f.mine && rxHint) { ch = (await pgSyncCmtRx(f, tok, pid, cm)) || ch; if (tok !== pgTok || pgF !== f) return; } // 5g
    }
  } finally {
    pgSyncBusy = false;
    if (pgSyncAgain) { pgSyncAgain = false; if (pgF === f && tok === pgTok) pgSyncSoon(); } // ada pemicu selagi berjalan: hasil tadi bisa lebih tua dari perubahan di Core
  }
  if (ch && pgF === f && tok === pgTok) renderFeed();
}
function pgSyncSoon() {
  if (pgSyncSoonT || typeof setTimeout !== 'function') return;
  pgSyncSoonT = setTimeout(() => { pgSyncSoonT = null; pgSyncNow(); }, 400);
}
function pgSyncEvent(ev) { // event lokal dari Core: hanya berarti di Halamanku
  if (!ev || typeof ev !== 'object' || (ev.kind !== 'cmt' && ev.kind !== 'rx') || typeof ev.postId !== 'string' || !PG_HEX16.test(ev.postId)) return;
  if (pgF && pgF.mine) { if (ev.kind === 'rx') pgSyncRxHint = true; pgSyncSoon(); }
}
function pgSyncStart() { // dipanggil pgOpen
  pgSyncStop();
  if (!pgSyncWired && typeof window !== 'undefined' && window.api) {
    pgSyncWired = true;
    if (typeof window.api.onPgAct === 'function') window.api.onPgAct(pgSyncEvent);
    if (typeof document !== 'undefined' && document && typeof document.hidden === 'boolean' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => { if (pgF && !document.hidden) pgSyncSoon(); });
  }
  if (typeof setInterval === 'function') pgSyncT = setInterval(pgSyncNow, PG_SYNC_MS);
}
function pgSyncStop() { // dipanggil pgClose
  if (pgSyncT) { clearInterval(pgSyncT); pgSyncT = null; }
  if (pgSyncSoonT) { clearTimeout(pgSyncSoonT); pgSyncSoonT = null; }
  pgSyncAgain = false;
}
