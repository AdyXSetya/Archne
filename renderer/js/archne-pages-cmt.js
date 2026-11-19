// Halaman, komentar (4b-4; dipecah dari archne-pages.js seperti 33-36): tombol "Komentar" di bawah tiap postingan, daftar komentar (tertua dulu) dengan "Muat komentar lagi", dan kotak tulis. Skrip global biasa, dimuat sesudah archne-pages-react.js; memakai pgF, pgId, pgTok, pgMsg, PG_ERR, PG_HEX16, renderFeed (32), S, nameOf, fmt, esc, dayLabel, hm, $ (hanya saat dipanggil).
// Keadaan per postingan di pgF.cm[id] = { open, items, ids, next, count, skipped, busy, err, loaded, gone, draft, sending, cerr, rm, reply, rd, rsending, rerr }. rm = Set id komentar yang sedang dihapus (5c-2: satu permintaan per komentar, klik ganda tak berefek). Dibuat saat tombol pertama kali diketuk; layar baru = keadaan baru.
// Komentar dimuat saat dibuka (bukan bersama feed): pgComments(pgId, id, { limit, after }). Di Halamanku pgId = id sendiri, jadi lokal tanpa jaringan; di halaman orang lain lewat jaringan, dan galatnya (offline, old, full, ...) tampil sebagai pesan, bukan hilang diam-diam.
// Daftar selalu urut (ts, id), sama dengan Core: komentar yang baru kukirim disisipkan di tempatnya (bukan ditempel di ujung) walau halaman-halaman berikutnya belum dimuat, dan tidak pernah ganda.
// Moderasi (5c-2): hanya di Halamanku (pgF.mine) tiap komentar punya tombol "Hapus" -> konfirmasi -> window.api.pgCmtRemove(postId, cid). Berhasil (juga removed:false = sudah tidak ada) = komentar dibuang dari daftar dan hitungan turun satu; gagal = daftar tak berubah + toast (r.err dari Core; jalur lokal, jadi bukan pesan jaringan PG_ERR).
// Hapus oleh penulis (5e): di halaman ORANG LAIN, komentar yang ditulis akun ini punya tombol "Hapus" (data-pg="cmydel") -> konfirmasi -> window.api.pgCmtDelete(pgId, postId, cid). Berhasil (removed / none / gone / queued) = komentar dibuang dari daftar dan hitungan turun satu; queued = pemilik offline, toast memberi tahu. Gagal = daftar tak berubah + toast (r.err).
// Balasan (5f, pohon): tiap komentar punya tombol "Balas" (data-pg="creply"); kotak balas muncul tepat di bawah komentar itu dan mengirim window.api.pgComment(pgId, postId, teks, idInduk). Balasan membawa `re` (id induk) dan digambar di bawah induknya, menjorok (maks 5 tingkat; lebih dalam sejajar tingkat 5, tiap balasan menyebut nama yang dibalas).
// Daftar tetap datar dan berurut (ts, id) di keadaan; pohon HANYA tata letak (pgCmtTree, urutan DFS, tanpa rekursi DOM). Balasan yang induknya tidak ada di daftar (dihapus / belum dimuat) tampil di tingkat atas dengan keterangan. Keadaan balasan: cm.reply (id yang dibalas), cm.rd[cid] (draf per induk), cm.rsending, cm.rerr.
// Reaksi komentar (5g): tiap komentar punya baris chip reaksi seperti postingan (data-pg="crx" / "crxadd" / "cwho"; id = id postingan, cid = id komentar). Keadaan reaksi menempel di item (c.rx / c.mine / c.who, bentuk sama dengan postingan: pgRxApply / pgWhoApply / pgRxSet dari archne-pages-react.js dipakai ulang) dan datang dari comments.rx { cid: { rx, mine, who? } } (pgCmtRxFrom). Keadaan UI di cm.rxb (cid yang sedang dikirim), cm.rxOpen (cid pemilih terbuka), cm.whoOpen (Set cid). Pembaruan optimistik + kembali ke keadaan lama bila gagal, sama dengan pgRx.
// Draf disimpan di keadaan (bukan hanya di kotak), jadi tidak hilang saat feed digambar ulang (mis. reaksi masuk); gagal kirim = draf utuh + pesan. Teks ditampilkan lewat esc (tanpa tautan): komentar berasal dari orang lain.
const PG_CMT_LIMIT = 10; // komentar per halaman
const PG_CMT_MAX = 1000; // batas karakter (sama dengan CMT_TEXT_MAX di src/archne-pagecmt.js: renderer tidak bisa require; tes menjaganya)
// Getter (seperti PG_ERR di archne-pages.js): teks mengikuti bahasa aktif saat dibaca. rxOld = reaksi pada komentar (dulu const PG_CRX_OLD).
const PG_CMT_ERR = {
  get old() { return txf('cmt.err.old', 'Aplikasi pemilik belum mendukung komentar.'); },
  get full() { return txf('cmt.err.full', 'Batas komentar tercapai: postingan ini sudah penuh, atau kamu sudah terlalu banyak berkomentar di sini.'); },
  get bad() { return txf('cmt.err.bad', 'Komentar tidak valid. Pastikan tidak kosong dan tidak lebih dari {max} karakter.', { max: PG_CMT_MAX }); },
  get noparent() { return txf('cmt.err.noparent', 'Komentar yang kamu balas sudah tidak ada.'); },
  get rxOld() { return txf('cmt.err.rxOld', 'Aplikasi pemilik belum mendukung reaksi pada komentar.'); },
};
const pgCmtMsg = (r) => (r && PG_CMT_ERR[r.code]) || pgMsg(r);
const pgCmtGet = (id) => (pgF && pgF.cm && PG_HEX16.test(String(id)) ? pgF.cm[id] || null : null);
const pgCmtLess = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); // sama dengan order di src/archne-pagecmt.js
function pgCmtMerge(cm, list) { // sisipkan komentar baru (tanpa ganda), jaga urutan (ts, id). Murni terhadap masukan.
  let n = 0;
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c.id !== 'string' || typeof c.text !== 'string' || !Number.isFinite(c.ts) || cm.ids.has(c.id)) continue;
    cm.ids.add(c.id); const it = { id: c.id, by: String(c.by), ts: c.ts, text: c.text }; if (typeof c.re === 'string' && PG_HEX16.test(c.re)) it.re = c.re; cm.items.push(it); n++;
  }
  if (n) cm.items.sort(pgCmtLess);
  return n;
}
function pgCmtTree(items) { // 5f: daftar datar (ts, id) -> urutan tampil pohon [{ c, depth, parent }] (induk dulu, lalu balasannya, tertua dulu). Balasan tanpa induk di daftar = tingkat atas (parent null).
  const byId = new Map(items.map((c) => [c.id, c])), kids = new Map(), roots = [], out = [], seen = new Set();
  for (const c of items) {
    if (c.re && c.re !== c.id && byId.has(c.re)) { if (!kids.has(c.re)) kids.set(c.re, []); kids.get(c.re).push(c); } else roots.push(c);
  }
  const walk = (c, d) => {
    if (seen.has(c.id)) return;
    seen.add(c.id); out.push({ c, depth: d, parent: c.re ? byId.get(c.re) || null : null });
    for (const k of kids.get(c.id) || []) walk(k, d + 1);
  };
  for (const c of roots) walk(c, 0);
  for (const c of items) walk(c, 0); // pengaman: lingkaran yang tak bisa terjadi pun tidak membuat komentar hilang
  return out;
}
const pgCmtDepth = (d) => 'pgcd' + Math.min(5, Math.max(0, d | 0)); // indentasi dibatasi 5 tingkat
function pgCmtItemHtml(c, pid, cm, apid, node) { // pid + cm hanya diberikan di Halamanku: menambah tombol Hapus (pemilik). apid + cm hanya di halaman orang lain: tombol Hapus untuk komentar KU sendiri (5e, penulis). node = { depth, parent } (5f)
  const me = S.me && c.by === S.me.id, postId = pid || apid, depth = node ? node.depth : 0;
  const del = pid && PG_HEX16.test(String(pid)) && PG_HEX16.test(String(c.id)) ? `<button type="button" class="pgcdel" data-pg="cdel" data-id="${pid}" data-cid="${esc(c.id)}" aria-label="${txf('cmt.delAria', 'Hapus komentar dari {name}', { name: esc(nameOf(c.by)) })}"${cm && cm.rm && cm.rm.has(c.id) ? ' disabled' : ''}>${cm && cm.rm && cm.rm.has(c.id) ? txf('cmt.deleting', 'Menghapus…') : txf('cmt.del', 'Hapus')}</button>` : '';
  const rmN = !!(cm && cm.rm && cm.rm.has(c.id));
  const mydel = !pid && me && apid && PG_HEX16.test(String(apid)) && PG_HEX16.test(String(c.id)) ? `<button type="button" class="pgcdel" data-pg="cmydel" data-id="${apid}" data-cid="${esc(c.id)}" aria-label="${txf('cmt.delMineAria', 'Hapus komentarmu')}"${rmN ? ' disabled' : ''}>${rmN ? txf('cmt.deleting', 'Menghapus…') : txf('cmt.del', 'Hapus')}</button>` : '';
  const replying = !!(cm && cm.reply === c.id);
  const rep = postId && PG_HEX16.test(String(postId)) && PG_HEX16.test(String(c.id)) && cm && !cm.gone ? `<button type="button" class="pgcrep" data-pg="creply" data-id="${postId}" data-cid="${esc(c.id)}" aria-expanded="${replying}" aria-label="${txf('cmt.replyAria', 'Balas komentar dari {name}', { name: esc(nameOf(c.by)) })}">${txf('cmt.reply', 'Balas')}</button>` : '';
  const to = c.re ? `<span class="pgcto">↳ ${node && node.parent ? txf('cmt.replyingTo', 'membalas {name}', { name: esc(nameOf(node.parent.by)) }) : txf('cmt.replyingGone', 'membalas komentar yang tidak tersedia')}</span>` : '';
  let h = `<div class="pgc${depth > 0 ? ' ' + pgCmtDepth(depth) : ''}${c.re ? ' pgcre' : ''}" data-cid="${esc(c.id)}"><div class="pgcmeta"><b>${esc(nameOf(c.by))}</b>${me ? '<span class="pgcme">' + txf('cmt.me', 'kamu') + '</span>' : ''}<span>${esc(dayLabel(c.ts))} · ${esc(hm(c.ts))}</span>${to}${rep}${del}${mydel}</div><div class="pgctext">${esc(c.text)}</div>${pgCrxHtml(postId, c, cm)}</div>`;
  if (replying) h += pgCmtReplyBox(postId, c, cm, depth + 1);
  return h;
}
// ---- reaksi komentar (5g) ----
function pgCrxHtml(postId, c, cm) { // baris chip di bawah teks komentar
  if (!cm || cm.gone || !PG_HEX16.test(String(postId)) || !PG_HEX16.test(String(c.id))) return '';
  const rx = Array.isArray(c.rx) ? c.rx : [], busy = !!(cm.rxb && cm.rxb[c.id]), dis = busy ? ' disabled' : '';
  const btn = (e, n) => `<button type="button" class="pgrx${e === c.mine ? ' mine' : ''}" data-pg="crx" data-id="${postId}" data-cid="${esc(c.id)}" data-e="${esc(e)}" aria-pressed="${e === c.mine}" aria-label="${n ? tnf('pg.rxAriaN', n, 'Reaksi {e}, {n} orang', { e: esc(e) }) : txf('pg.rxAria', 'Reaksi {e}', { e: esc(e) })}"${dis}>${pgRxShow(e)}${n ? '<b>' + n + '</b>' : ''}</button>`;
  const open = cm.rxOpen === c.id;
  const add = `<button type="button" class="pgrx pgrxadd" data-pg="crxadd" data-id="${postId}" data-cid="${esc(c.id)}" aria-label="${txf('cmt.rxAddAria', 'Tambah reaksi pada komentar')}" aria-expanded="${open}"${dis}>＋</button>`;
  const hasWho = !!(pgF && pgF.mine) && rx.length > 0 && Array.isArray(c.who) && c.who.some((w) => w && Array.isArray(w.by) && w.by.length), wopen = hasWho && !!(cm.whoOpen && cm.whoOpen.has(c.id));
  const who = hasWho ? `<button type="button" class="pgrx pgrxwho" data-pg="cwho" data-id="${postId}" data-cid="${esc(c.id)}" aria-label="${txf('cmt.whoAria', 'Siapa yang bereaksi pada komentar ini')}" aria-expanded="${wopen}">${txf('pg.who', 'Siapa')}</button>` : '';
  return `<div class="pgrxs pgcrxs">${rx.map((r) => btn(r.e, r.n)).join('')}${add}${who}</div>${open ? `<div class="pgrxpick pgcrxpick" role="group" aria-label="${txf('pg.rxPick', 'Pilih reaksi')}">${PG_RX_QUICK.map((e) => btn(e, 0)).join('')}</div>` : ''}${wopen ? pgWhoHtml(c) : ''}`;
}
function pgCmtRxFrom(cm, cs) { // terapkan comments.rx dari satu halaman pgComments ke item yang sudah ada: yang tak disebut = tanpa reaksi. true bila ada yang berubah. Komentar yang reaksinya sedang dikirim tidak disentuh.
  if (!cm || !cs || !Array.isArray(cs.items) || !Array.isArray(cm.items)) return false;
  const m = cs.rx && typeof cs.rx === 'object' ? cs.rx : {}, by = new Map(cm.items.map((x) => [x.id, x])), sig = (x) => JSON.stringify([x.rx || null, x.mine || null, x.who || null]);
  let ch = false;
  for (const c of cs.items) {
    if (!c || typeof c.id !== 'string') continue; // entri cacat dari IPC (pgCmtMerge juga melewatinya)
    const it = by.get(c.id); if (!it || (cm.rxb && cm.rxb[c.id])) continue;
    const s = m[c.id], b = sig(it);
    pgRxSet(it, s && Array.isArray(s.rx) && s.rx.length ? (pgF && pgF.mine ? s : { rx: s.rx, mine: s.mine }) : null);
    if (sig(it) !== b) ch = true;
  }
  return ch;
}
function pgCmtRxMenu(id, cid) { const cm = pgCmtGet(id); if (!cm || cm.gone || !PG_HEX16.test(String(cid))) return; cm.rxOpen = cm.rxOpen === cid ? null : cid; renderFeed(); }
function pgCmtWho(id, cid) {
  const f = pgF, cm = pgCmtGet(id); if (!f || !f.mine || !cm || cm.gone || !PG_HEX16.test(String(cid))) return;
  const c = cm.items.find((x) => x.id === cid); if (!c || !Array.isArray(c.rx) || !c.rx.length) return;
  const o = cm.whoOpen || (cm.whoOpen = new Set()); if (o.has(cid)) o.delete(cid); else o.add(cid); renderFeed();
}
async function pgCmtRx(id, cid, e) {
  const f = pgF, tok = pgTok, cm = pgCmtGet(id); if (!f || !cm || cm.gone || typeof e !== 'string' || !e || !PG_HEX16.test(String(cid))) return;
  const c = cm.items.find((x) => x.id === cid); if (!c) return;
  const rb = cm.rxb || (cm.rxb = {}); if (rb[cid]) return; // satu permintaan per komentar
  const next = c.mine === e ? '' : e, before = { rx: c.rx, mine: c.mine, who: c.who }, peer = pgId;
  const ap = pgRxApply(c.rx, c.mine, next); if (f.mine) ap.who = pgWhoApply(c.who, S.me.id, c.mine, next, ap.rx);
  pgRxSet(c, ap); rb[cid] = true; cm.rxOpen = null; renderFeed();
  let r; try { r = await window.api.pgCmtReact(peer, id, cid, next); } catch (x) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f || pgCmtGet(id) !== cm) return; // layar ditutup / pindah selagi menunggu
  delete rb[cid];
  const c2 = cm.items.find((x) => x.id === cid); // komentarnya bisa saja hilang selagi menunggu
  if (!c2) { renderFeed(); return; }
  if (r && r.ok && r.react) pgRxSet(c2, f.mine ? r.react : { rx: r.react.rx, mine: r.react.mine }); // daftar pelaku hanya disimpan di Halamanku
  else { pgRxSet(c2, before); toast(r && r.ok ? txf('cmt.gone', 'Komentar ini sudah tidak tersedia.') : r && r.code === 'old' ? PG_CMT_ERR.rxOld : pgCmtMsg(r)); }
  renderFeed();
}
function pgCmtReplyBox(postId, c, cm, depth) { // kotak balas satu komentar (5f)
  const sending = !!cm.rsending;
  return `<div class="pgccomp pgcrcomp ${pgCmtDepth(depth)}"><textarea data-pg="rtxt" data-id="${postId}" data-cid="${esc(c.id)}" rows="2" maxlength="${PG_CMT_MAX}" placeholder="${txf('cmt.replyPh', 'Balas {name}...', { name: esc(nameOf(c.by)) })}" aria-label="${txf('cmt.replyBoxAria', 'Balasan untuk {name}', { name: esc(nameOf(c.by)) })}"${sending ? ' disabled' : ''}>${esc(cm.rd && cm.rd[c.id] || '')}</textarea><div class="pgcrow"><button type="button" class="sec" data-pg="rcancel" data-id="${postId}"${sending ? ' disabled' : ''}>${txf('common.cancel', 'Batal')}</button><button type="button" data-pg="rsend" data-id="${postId}"${sending ? ' disabled' : ''}>${sending ? txf('cmt.sending', 'Mengirim…') : txf('cmt.sendReply', 'Kirim balasan')}</button></div><div class="pgcerr" role="alert">${esc(cm.rerr)}</div></div>`;
}
const PG_ICO_CMT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H9l-5 4V5z"/></svg>'; // ikon tombol komentar
function pgCmtHtml(p) {
  const cm = pgF.cm && pgF.cm[p.id], open = !!(cm && cm.open);
  const nc = cm && cm.count != null ? cm.count : null, lbl = nc != null ? txf('cmt.btnN', 'Komentar ({count})', { count: fmt(nc) }) : txf('cmt.btn', 'Komentar');
  const btn = `<button type="button" class="pgcbtn" data-pg="cmt" data-id="${p.id}" aria-expanded="${open}" title="${txf('cmt.btn', 'Komentar')}" aria-label="${lbl}">${PG_ICO_CMT}${nc ? `<span class="pgcn">${fmt(nc)}</span>` : ''}</button>`; // ikon gelembung + jumlah (disembunyikan bila 0 / belum diketahui)
  if (!open) return `<div class="pgcm">${btn}</div>`;
  let foot = '';
  if (cm.gone) foot = '<div class="pgnote">' + txf('cmt.unavail', 'Komentar postingan ini tidak tersedia.') + '</div>';
  else {
    if (cm.skipped) foot += `<div class="pgnote">${tnf('cmt.skipped', cm.skipped, '{count} komentar dibuang karena tidak sah.', { count: fmt(cm.skipped) })}</div>`;
    if (cm.busy) foot += `<div class="pgnote">${cm.items.length ? txf('pg.loading', 'Memuat…') : txf('cmt.loadingList', 'Memuat komentar…')}</div>`;
    else if (cm.err) foot += `<div class="pgerr" role="alert">${esc(cm.err.msg)}${PG_NORETRY[cm.err.code] ? '' : `<div class="row"><button type="button" class="sec" data-pg="cmore" data-id="${p.id}">${txf('common.retry', 'Coba lagi')}</button></div>`}</div>`;
    else if (cm.next) foot += `<div class="row"><button type="button" class="sec" data-pg="cmore" data-id="${p.id}">${txf('cmt.loadMore', 'Muat komentar lagi')}</button></div>`;
    else if (cm.loaded && !cm.items.length) foot += '<div class="pgnote">' + txf('cmt.none', 'Belum ada komentar.') + '</div>';
  }
  const comp = cm.gone ? '' : `<div class="pgccomp"><textarea data-pg="ctxt" data-id="${p.id}" rows="2" maxlength="${PG_CMT_MAX}" placeholder="${txf('cmt.ph', 'Tulis komentar...')}" aria-label="${txf('cmt.newAria', 'Komentar baru')}"${cm.sending ? ' disabled' : ''}>${esc(cm.draft)}</textarea><div class="pgcrow"><button type="button" data-pg="csend" data-id="${p.id}"${cm.sending ? ' disabled' : ''}>${cm.sending ? txf('cmt.sending', 'Mengirim…') : txf('common.send', 'Kirim')}</button></div><div class="pgcerr" role="alert">${esc(cm.cerr)}</div></div>`;
  return `<div class="pgcm">${btn}<div class="pgcl">${pgCmtTree(cm.items).map((n) => pgCmtItemHtml(n.c, pgF.mine ? p.id : null, cm, pgF.mine ? null : p.id, n)).join('')}</div>${foot}${comp}</div>`;
}
// Fokus kotak komentar dijaga lintas gambar ulang (innerHTML mengganti elemennya): renderFeed memanggil pgCmtFocusGet sebelum dan pgCmtFocusPut sesudah.
function pgCmtFocusGet() {
  const a = typeof document !== 'undefined' && document ? document.activeElement : null;
  return a && a.dataset && (a.dataset.pg === 'ctxt' || a.dataset.pg === 'rtxt') && PG_HEX16.test(String(a.dataset.id)) ? { id: a.dataset.id, k: a.dataset.pg, s: a.selectionStart, e: a.selectionEnd } : null;
}
function pgCmtFocusPut(k) {
  if (!k || !PG_HEX16.test(String(k.id))) return;
  const L = $('pglist'), t = L && typeof L.querySelector === 'function' ? L.querySelector(`[data-pg="${k.k === 'rtxt' ? 'rtxt' : 'ctxt'}"][data-id="${k.id}"]`) : null;
  if (!t || t.disabled) return;
  try { t.focus(); if (Number.isInteger(k.s) && Number.isInteger(k.e) && t.setSelectionRange) t.setSelectionRange(k.s, k.e); } catch (x) {}
}
function pgCmtToggle(id) {
  const f = pgF; if (!f || !PG_HEX16.test(String(id)) || !f.items.some((p) => p.id === id)) return;
  const cm = f.cm && f.cm[id] ? f.cm[id] : ((f.cm || (f.cm = {}))[id] = { open: false, items: [], ids: new Set(), next: null, count: null, skipped: 0, busy: false, err: null, loaded: false, gone: false, draft: '', sending: false, cerr: '', rm: new Set(), reply: null, rd: {}, rsending: false, rerr: '' });
  cm.open = !cm.open; renderFeed();
  if (cm.open && !cm.loaded && !cm.busy && !cm.gone) pgCmtLoad(id);
}
async function pgCmtLoad(id) {
  const f = pgF, tok = pgTok, cm = pgCmtGet(id); if (!cm || cm.busy || cm.gone) return;
  cm.busy = true; cm.err = null; renderFeed();
  const o = { limit: PG_CMT_LIMIT }; if (cm.next) o.after = cm.next;
  let r; try { r = await window.api.pgComments(pgId, id, o); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f) return; // layar ditutup / pindah selagi menunggu
  cm.busy = false;
  if (!r || !r.ok) cm.err = { code: r && r.code, msg: pgCmtMsg(r) };
  else if (!r.comments) cm.gone = true; // null: tidak ada / tak terlihat / diblokir (tak dibedakan)
  else {
    pgCmtMerge(cm, r.comments.items); pgCmtRxFrom(cm, r.comments); cm.next = typeof r.comments.next === 'string' ? r.comments.next : null; cm.loaded = true;
    if (Number.isInteger(r.comments.count)) cm.count = r.comments.count;
    if (Number.isInteger(r.comments.skipped)) cm.skipped += r.comments.skipped;
  }
  renderFeed();
}
async function pgCmtSend(id) {
  const f = pgF, tok = pgTok, cm = pgCmtGet(id); if (!cm || cm.sending || cm.gone) return;
  const text = cm.draft;
  if (!text.trim()) { cm.cerr = txf('cmt.writeFirst', 'Tulis komentarnya dulu.'); renderFeed(); return; }
  if (text.length > PG_CMT_MAX) { cm.cerr = PG_CMT_ERR.bad; renderFeed(); return; }
  cm.sending = true; cm.cerr = ''; renderFeed();
  let r; try { r = await window.api.pgComment(pgId, id, text); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f) return;
  cm.sending = false; f.cmWant = id; // fokus kembali ke kotak sesudah digambar ulang
  if (r && r.ok && r.comment && r.comment.c) {
    const added = pgCmtMerge(cm, [r.comment.c]);
    if (r.comment.st === 'added' && added && cm.count != null) cm.count++; // 'same' = sudah ada (kirim ulang yang persis sama): tidak menambah hitungan
    if (cm.draft === text) cm.draft = ''; // yang diketik selama menunggu tidak dihapus
  } else if (r && r.ok) { cm.cerr = txf('pg.gone', 'Postingan ini sudah tidak tersedia.'); }
  else cm.cerr = pgCmtMsg(r);
  renderFeed();
}
async function pgCmtDel(id, cid) { // 5c-2: pemilik membuang satu komentar dari postingannya
  const f = pgF, tok = pgTok, cm = pgCmtGet(id);
  if (!f || !f.mine || !cm || cm.gone || !PG_HEX16.test(String(cid)) || cm.rm.has(cid) || !cm.items.some((c) => c.id === cid)) return;
  if (!await ask(txf('cmt.delConfirm', 'Hapus komentar ini?\n\nKomentar hilang dari postingan ini dan tidak bisa dibatalkan.'))) return;
  if (tok !== pgTok || pgF !== f || pgCmtGet(id) !== cm || cm.rm.has(cid) || !cm.items.some((c) => c.id === cid)) return; // layar berganti / komentar sudah hilang selagi dialog terbuka
  cm.rm.add(cid); renderFeed();
  let r; try { r = await window.api.pgCmtRemove(id, cid); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f || pgCmtGet(id) !== cm) return;
  cm.rm.delete(cid);
  if (!r || !r.ok) { toast((r && typeof r.err === 'string' && r.err) || txf('cmt.delFail', 'Gagal menghapus komentar.')); renderFeed(); return; } // daftar tak berubah
  if (cm.reply === cid) cm.reply = null; delete cm.rd[cid];
  const n = cm.items.length; cm.items = cm.items.filter((c) => c.id !== cid); cm.ids.delete(cid); // removed:false = sudah tidak ada di Core: sama-sama dibuang dari layar
  if (cm.items.length < n && cm.count != null && cm.count > 0) cm.count--;
  renderFeed();
}
async function pgCmtDelMine(id, cid) { // 5e: penulis menghapus komentarnya sendiri di halaman orang lain (bukan Halamanku: di sana pemilik memakai pgCmtDel)
  const f = pgF, tok = pgTok, cm = pgCmtGet(id), mineC = () => cm && cm.items.find((x) => x.id === cid);
  if (!f || f.mine || !cm || cm.gone || !PG_HEX16.test(String(cid)) || cm.rm.has(cid) || !S.me) return;
  const c0 = mineC(); if (!c0 || c0.by !== S.me.id) return; // hanya komentar yang ditulis akun ini
  if (!await ask(txf('cmt.delMineConfirm', 'Hapus komentarmu?\n\nKomentar hilang dari postingan ini dan tidak bisa dibatalkan. Bila pemilik sedang offline, penghapusan menunggu sampai ia online.'))) return;
  if (tok !== pgTok || pgF !== f || pgCmtGet(id) !== cm || cm.rm.has(cid) || !mineC()) return; // layar berganti / komentar sudah hilang selagi dialog terbuka
  cm.rm.add(cid); renderFeed();
  let r; try { r = await window.api.pgCmtDelete(pgId, id, cid); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f || pgCmtGet(id) !== cm) return;
  cm.rm.delete(cid);
  if (!r || !r.ok) { toast((r && typeof r.err === 'string' && r.err) || txf('cmt.delFail', 'Gagal menghapus komentar.')); renderFeed(); return; } // daftar tak berubah
  if (cm.reply === cid) cm.reply = null; delete cm.rd[cid];
  const n = cm.items.length; cm.items = cm.items.filter((c) => c.id !== cid); cm.ids.delete(cid); // removed / none / gone / queued: semuanya hilang dari layar (queued disembunyikan Core sampai terkirim)
  if (cm.items.length < n && cm.count != null && cm.count > 0) cm.count--;
  if (r.st === 'queued') toast(txf('cmt.queued', 'Pemilik sedang offline. Komentarmu akan dihapus begitu ia online.'));
  renderFeed();
}
function pgCmtReplyToggle(id, cid) { // 5f: buka / tutup kotak balas di bawah komentar `cid`
  const f = pgF, cm = pgCmtGet(id);
  if (!f || !cm || cm.gone || cm.rsending || !PG_HEX16.test(String(cid)) || !cm.items.some((c) => c.id === cid)) return;
  cm.reply = cm.reply === cid ? null : cid; cm.rerr = '';
  if (cm.reply) f.cmWant = { id, k: 'rtxt' }; // fokus ke kotak balasan sesudah digambar ulang
  renderFeed();
}
function pgCmtReplyCancel(id) { const cm = pgCmtGet(id); if (!cm || cm.rsending) return; cm.reply = null; cm.rerr = ''; renderFeed(); }
async function pgCmtReplySend(id) { // 5f: kirim balasan untuk komentar cm.reply
  const f = pgF, tok = pgTok, cm = pgCmtGet(id); if (!cm || cm.rsending || cm.gone || !cm.reply) return;
  const re = cm.reply, text = cm.rd[re] || '';
  if (!cm.items.some((c) => c.id === re)) { cm.reply = null; renderFeed(); return; }
  if (!text.trim()) { cm.rerr = txf('cmt.writeReply', 'Tulis balasannya dulu.'); renderFeed(); return; }
  if (text.length > PG_CMT_MAX) { cm.rerr = PG_CMT_ERR.bad; renderFeed(); return; }
  cm.rsending = true; cm.rerr = ''; renderFeed();
  let r; try { r = await window.api.pgComment(pgId, id, text, re); } catch (e) { r = { ok: false, code: 'proto' }; }
  if (tok !== pgTok || pgF !== f || pgCmtGet(id) !== cm) return;
  cm.rsending = false;
  if (r && r.ok && r.comment && r.comment.c) {
    const added = pgCmtMerge(cm, [r.comment.c]);
    if (r.comment.st === 'added' && added && cm.count != null) cm.count++;
    if ((cm.rd[re] || '') === text) { delete cm.rd[re]; if (cm.reply === re) cm.reply = null; } // yang diketik selama menunggu tidak dihapus
  } else if (r && r.ok) { cm.rerr = txf('pg.gone', 'Postingan ini sudah tidak tersedia.'); }
  else if (r && r.code === 'noparent') { // komentar yang dibalas sudah dihapus pemilik / penulisnya: buang dari layar
    cm.items = cm.items.filter((c) => c.id !== re); cm.ids.delete(re); if (cm.count != null && cm.count > 0) cm.count--;
    cm.reply = null; delete cm.rd[re]; toast(PG_CMT_ERR.noparent);
  } else cm.rerr = r && r.code === 'old' && typeof r.err === 'string' && r.err ? r.err : pgCmtMsg(r);
  renderFeed();
}
$('pgmodal').addEventListener('input', (e) => {
  const t = e.target; if (!t || !t.dataset) return;
  if (t.dataset.pg === 'rtxt') { // 5f: draf balasan per komentar induk
    const rc = pgCmtGet(t.dataset.id);
    if (rc && PG_HEX16.test(String(t.dataset.cid))) { rc.rd[t.dataset.cid] = String(t.value); if (rc.rerr) { rc.rerr = ''; const x = t.parentNode && t.parentNode.querySelector ? t.parentNode.querySelector('.pgcerr') : null; if (x) x.textContent = ''; } }
    return;
  }
  if (t.dataset.pg !== 'ctxt') return;
  const cm = pgCmtGet(t.dataset.id); if (cm) { cm.draft = String(t.value); if (cm.cerr) { cm.cerr = ''; const x = t.parentNode && t.parentNode.querySelector ? t.parentNode.querySelector('.pgcerr') : null; if (x) x.textContent = ''; } }
});
