const expanded = new Set(); // id pesan panjang yang sedang dibuka penuh
const FOLD_CHARS = 1000, FOLD_LINES = 12; // pesan lebih panjang dari ini dilipat: "Lihat selengkapnya"
let replyTo = null, flashId = null, flashUntil = 0; // replyTo: { id, chat, name, text } pesan yang sedang dibalas
let S = { me: {}, peers: [], groups: [], messages: [], sending: [], blocked: [] }, cur = 'public', unread = {}, prog = {}, tab = 'public', emptyTab = false, last = { grup: null, teman: null }, profId = null; // prog: kemajuan terbaru dari event (id atau 'j:<job>')
const $ = (id) => document.getElementById(id);
const hue = (id) => parseInt(id.slice(0, 6), 16) % 360;
const color = (id) => `hsl(${hue(id)},62%,var(--nl,68%))`; // teks nama: terang di tema gelap, gelap di tema terang
const avc = (id) => `hsl(${hue(id)},48%,42%)`; // latar avatar: huruf putih terbaca di kedua tema
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  dx: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13m-4-4l4 4-4 4M20 16H7m4-4l-4 4 4 4"/></svg>',
  pin: svg('<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 010 6.6M18 14.8c1.9.7 3.2 2.4 3.5 5.2"/>'),
  chat: svg('<path d="M21 12a8.5 8.5 0 01-12.4 7.5L3 21l1.6-5A8.5 8.5 0 1121 12z"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  bell: svg('<path d="M6 17V11a6 6 0 1112 0v6l1.5 2h-15z"/><path d="M10 21h4"/>'),
  bellOff: svg('<path d="M6 17V11a6 6 0 019-5.2M18 11v6l1.5 2H8M10 21h4M3 3l18 18"/>'),
  more: svg('<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>'),
  dl: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  unzip: svg('<path d="M4 8l2-4h12l2 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1z"/><path d="M4 8h16M12 11v6M9 14l3-3 3 3"/>'),
  bolt: svg('<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>'),
  video: svg('<rect x="3" y="6" width="12" height="12" rx="2.5"/><path d="M15 11l6-3.5v9L15 13z"/>'),
  videoOff: svg('<rect x="3" y="6" width="12" height="12" rx="2.5"/><path d="M15 11l6-3.5v9L15 13zM3 3l18 18"/>'),
  screen: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  screenOff: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M3 3l18 18"/>'),
  flip: svg('<path d="M20 11a8 8 0 00-14.5-3.5M4 4v4h4M4 13a8 8 0 0014.5 3.5M20 20v-4h-4"/><circle cx="12" cy="12" r="2.5"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>'),
  micOff: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3M3 3l18 18"/>'),
  head: svg('<path d="M4 15v-3a8 8 0 0116 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>'),
  headOff: svg('<path d="M4 15v-3a8 8 0 0113-5.9M20 12v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/>'),
  noise: svg('<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>'),
  noiseOff: svg('<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4M3 3l18 18"/>'),
  speaker: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  shrink: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  chev: svg('<path d="M6 9l6 6 6-6"/>'),
  add: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M19 8v6M16 11h6"/>'),
  // Step 3 (rapikan UI): ikon kecil di gelembung, bilah balasan, dan header chat
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  mail: svg('<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M4.5 8l7.5 5.5L19.5 8"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>'),
  smile: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2"/><path d="M9 9.5v.1M15 9.5v.1"/>'),
  reply: svg('<path d="M9 7L4 12l5 5"/><path d="M4 12h9a6 6 0 016 6v1"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  // Step 3b: pratinjau daftar chat dan menu profil
  clip: svg('<path d="M20 11.5l-8 8a5 5 0 01-7-7l8.5-8.5a3.3 3.3 0 014.7 4.7L9.5 17.3a1.7 1.7 0 01-2.4-2.4l7.6-7.6"/>'),
  camera: svg('<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/><circle cx="12" cy="13" r="3.5"/>'),
  block: svg('<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>'),
  star: svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8z"/>'),
  // v0.25.1: tautan web + peramban dalam aplikasi; ikon bagian Pengaturan dan modal anggota
  exit: svg('<path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M16 8l4 4-4 4M20 12H9"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>'),
  palette: svg('<path d="M12 3a9 9 0 100 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 004-4c0-4-4-7.8-9-7.8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>'),
  db: svg('<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 3.5 3L16 12l4 4"/>'),
  relay: svg('<circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 000 8.4M16.2 7.8a6 6 0 010 8.4M4.9 4.9a10 10 0 000 14.2M19.1 4.9a10 10 0 010 14.2"/>'),
  link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6.5A2.5 2.5 0 0012.5 4h-6A2.5 2.5 0 004 6.5v6A2.5 2.5 0 006.5 15H9"/>'),
  fwd: svg('<path d="M9 5l7 7-7 7"/>'),
  reload: svg('<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"/>'),
  crown: svg('<path d="M3.5 8l4.5 4 4-6.5 4 6.5 4.5-4-1.8 10H5.3z"/>'),
  home: svg('<path d="M4 11l8-7 8 7"/><path d="M6 10v10h4v-6h4v6h4V10"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  // Web Lokal (U1): ikon pengelola berkas
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  rename: svg('<path d="M5 8V6h14v2M12 6v12M9 18h6"/>'),
  film: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M10 9.5v5l4.5-2.5z"/>'),
  music: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
  code: svg('<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>'),
  play: svg('<path d="M8 5l11 7-11 7z"/>'),
  hand: svg('<path d="M8 12V6.5a1.5 1.5 0 013 0V11m0-5.5a1.5 1.5 0 013 0V11m0-4a1.5 1.5 0 013 0v7a6 6 0 01-6 6h-.5a6 6 0 01-5-2.7L4 14.5a1.5 1.5 0 012.4-1.7L8 14.5"/>'),
};
// Ikon bergaya kecil di dalam teks: icn('lock') -> <svg class="ic"...>; kelas tambahan opsional (mis. 'warn').
const icn = (name, cls) => IC[name].replace('<svg ', '<svg class="ic' + (cls ? ' ' + cls : '') + '" ');
// Tombol ikon saja (tanpa teks): nama tetap ada di title + aria-label. attrs = atribut tambahan mentah (mis. data-pact="chat").
const ibtn = (icon, label, attrs, cls) => `<button type="button" class="pib${cls ? ' ' + cls : ''}" ${attrs || ''} title="${esc(label)}" aria-label="${esc(label)}">${icn(icon)}</button>`;
const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
// i18n (C1): txf/tnf = tx()/tn() dengan cadangan teks Indonesia asli bila archne-i18n.js tidak dimuat (tes vm lama). Kunci wajib ada di archne-en.js dan archne-id.js.
const txf = (k, fb, p) => (typeof tx === 'function' ? tx(k, p) : (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb));
const tnf = (k, n, fb, p) => (typeof tn === 'function' ? tn(k, n, p) : txf(k, fb, Object.assign({ n }, p || {})));
const uiLoc = () => (typeof I18N !== 'undefined' && I18N.getLang ? I18N.getLang() : []); // locale tanggal mengikuti bahasa aplikasi
const dayLabel = (t) => { const n = Date.now(); return dayKey(t) === dayKey(n) ? txf('time.today', 'Hari ini') : dayKey(t) === dayKey(n - 864e5) ? txf('time.yesterday', 'Kemarin') : new Date(t).toLocaleDateString(uiLoc(), { day: 'numeric', month: 'long', year: 'numeric' }); };
const shortWhen = (t) => (dayKey(t) === dayKey(Date.now()) ? hm(t) : new Date(t).toLocaleDateString(uiLoc(), { day: 'numeric', month: 'short' }));
const tag = (name, id) => `${name || '?'}#${id.slice(0, 6)}`;
// Lencana di samping nama#id (Publik dan Grup): mahkota emas = pemilik, mahkota perak = admin, bintang = teman; tidak dikenal = tanpa lencana.
const isFriendId = (id) => { const p = S.peers.find((q) => q.id === id); return !!p && (p.fst || (p.friend ? 'ok' : '')) === 'ok'; };
const bdg = (ic, cls, t) => `<span class="bdg ${cls}" title="${t}" role="img" aria-label="${t}">${icn(ic)}</span>`;
const badgesOf = (id, g) => (g && g.creator === id ? bdg('crown', 'own', txf('badge.owner', 'Pemilik')) : g && (g.admins || []).includes(id) ? bdg('crown', 'adm', txf('badge.admin', 'Admin')) : '') + (isFriendId(id) ? bdg('star', 'fr', txf('badge.friend', 'Teman')) : '');
const DEFAULT_BIO = 'Hallo...';
const bioOf = (id) => (S.bios && S.bios[id]) || DEFAULT_BIO;
const nameOf = (id) => (id === S.me.id ? (S.me.name || 'Kamu') : ((S.peers.find((p) => p.id === id) || {}).name || (S.groups.flatMap((g) => g.members).find((x) => x.id === id) || {}).name || (S.messages.find((m) => m.from === id && m.name) || {}).name || ((S.blocked || []).find((b) => b.id === id) || {}).name || ((S.calls || []).find((c) => c.peer === id) || {}).name || '?'));
// Avatar: foto (tersinkron dari pemiliknya) bila ada, kalau tidak huruf pertama dengan warna dari id.
const avHtml = (id, small) => {
  const u = S.avatars && S.avatars[id], nm = String(nameOf(id)).trim() || '?';
  return `<div class="av${small === 'md' ? ' md' : small ? ' sm' : ''}" style="background:${avc(id || '0')}">${u ? `<img src="${esc(u)}" alt="">` : esc((Array.from(nm)[0] || '?').toUpperCase())}</div>`;
};
// Avatar grup (v0.26.0): foto grup (state grup, dari Core.getState().groups[].av) bila ada, kalau tidak huruf pertama nama grup. Persegi bulat (.sq).
const gavHtml = (g, small) => `<div class="av${small === 'md' ? ' md' : small ? ' sm' : ''} sq" style="background:${avc(g.id)}">${g.av ? `<img src="${esc(g.av)}" alt="">` : esc((Array.from(g.name || '?')[0] || '?').toUpperCase())}</div>`;
// Cari orang: nama (tanpa peduli huruf besar/kecil, cocok di bagian mana pun), `#id` (awalan id), atau gabungan `nama#id`.
function matchUser(name, id, q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return true;
  const i = q.indexOf('#'), n = (i < 0 ? q : q.slice(0, i)).trim(), h = i < 0 ? '' : q.slice(i + 1).trim();
  if (h && !String(id || '').startsWith(h)) return false;
  return !n || String(name || '').toLowerCase().includes(n);
}
const blockedIds = () => new Set((S.blocked || []).map((b) => b.id)); // orang yang kublokir: hilang dari semua daftar
const tabOf = (id) => (id === 'public' ? 'public' : id.startsWith('g:') ? 'grup' : 'teman');
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tab Teman: hanya orang yang saling setuju. Permintaan masuk ("Permintaan teman") dan terkirim ("Menunggu persetujuan") punya bagian sendiri.
// Orang lain yang punya percakapan privat (atau sedang dibuka) tampil di "Obrolan lain", supaya pesan dari yang belum jadi teman tidak hilang.
function dmLists() {
  const peers = [...S.peers].sort((a, b) => (b.online - a.online) || (!!b.bg - !!a.bg) || a.name.localeCompare(b.name));
  const keys = new Set();
  for (const m of S.messages) if (!m.sys && m.to !== 'public' && !String(m.to).startsWith('g:')) keys.add(m.from === S.me.id ? m.to : m.from);
  for (const r of S.calls || []) { if (r.group) { for (const x of r.members || []) if (callInChat(r, x.id)) keys.add(x.id); } else if (!r.hc) keys.add(r.peer); }
  const fs = (p) => p.fst || (p.friend ? 'ok' : '');
  return { friends: peers.filter((p) => fs(p) === 'ok'), incoming: peers.filter((p) => fs(p) === 'in'), outgoing: peers.filter((p) => fs(p) === 'out'),
    others: peers.filter((p) => !fs(p) && (keys.has(p.id) || unread[p.id] || p.id === cur)) };
}
// Riwayat panggilan. Gelembung di chat: sisi kanan = aku yang menelepon, kiri = dia. Daftar tab Panggilan: terbaru di atas.
const callWhen = (t) => { const d = dayKey(t), n = Date.now(); return d === dayKey(n) ? hm(t) : d === dayKey(n - 864e5) ? txf('time.yesterdayAt', 'Kemarin {time}', { time: hm(t) }) : new Date(t).toLocaleDateString(uiLoc(), { day: 'numeric', month: 'short' }) + ' ' + hm(t); };
const callArrow = (r) => (r.dir === 'out' ? '↗' : '↙');
const callInChat = (r, id) => (r.group ? (r.members || []).some((x) => x.id === id) && !(r.hcs || []).includes(id) : r.peer === id && !r.hc);
function callBubbleH(r) {
  const L = LC.callLabel(r), mine = r.dir === 'out';
  return `<div class="m call ${mine ? 'me' : ''}${L.bad ? ' bad' : ''}" data-cid="${esc(r.id)}"><div class="cb"><span class="ci">${r.video ? IC.video : IC.phone}</span><div class="ct"><div class="c1">${esc(L.title)}</div><div class="c2">${callArrow(r)} ${esc(r.group ? LC.callMembers(r) : L.sub)}</div></div></div><div class="t">${hm(r.at)}</div></div>`;
}
function callRowH(r) {
  const L = LC.callLabel(r), nm = r.group ? LC.callMembers(r, { me: false }) : nameOf(r.peer);
  const av = r.group ? `<div class="av md sq" style="background:${avc(r.id)}">${IC.users}</div>` : avHtml(r.peer, 'md');
  const sub = (r.group ? txf('call.tagGroup', 'Grup') + ' · ' : '') + (r.video ? txf('call.tagVideo', 'Video') + ' · ' : '') + L.sub;
  return `<div class="item crow" data-cpeer="${esc(r.peer)}" tabindex="0">${av}<div class="ib"><div class="r1"><span class="nm${L.bad ? ' bad' : ''}">${esc(nm)}</span></div><div class="r2"><span class="pv${L.bad ? ' bad' : ''}"><span class="ar${!L.bad && r.out === 'done' ? ' ok' : ''}">${callArrow(r)}</span>${esc(sub)} · ${esc(callWhen(r.at))}</span></div></div>${callCtl && !r.group ? `<button type="button" class="ibtn cbk${callBusy() ? ' off' : ''}" data-callback="${esc(r.peer)}" title="${callBusy() ? txf('call.inCall', 'Sedang dalam panggilan') : txf('call.again', 'Telepon lagi')}" aria-label="${esc(txf('call.ariaTo', 'Telepon {name}', { name: nm }))}">${IC.phone}</button>` : ''}</div>`;
}
// Lencana tab Panggilan: panggilan tak terjawab sejak tab itu terakhir dibuka (disimpan di peramban bila bisa).
let callsSeen = 0;
try { callsSeen = Number(window.localStorage.getItem('lc.callsSeen')) || 0; } catch (x) {}
const missedCalls = () => (S.calls || []).filter((r) => r.out === 'missed' && r.at > callsSeen).length;
function markCallsSeen() { const t = Date.now(); if (t - callsSeen < 1000) return; callsSeen = t; try { window.localStorage.setItem('lc.callsSeen', String(t)); } catch (x) {} }
// Sedang dalam panggilan (berdering, memanggil, tersambung, atau di channel suara): tidak boleh memulai / masuk panggilan lain.
const callBusy = () => !!(callCtl && callCtl.cur);
const callBusyMsg = () => (callCtl && callCtl.cur && callCtl.cur.vc ? txf('call.busyVc', 'Kamu sedang di channel suara. Keluar dulu sebelum menelepon atau masuk channel lain.') : txf('call.busyCall', 'Kamu sedang dalam panggilan. Akhiri dulu sebelum menelepon yang lain.'));
// Tombol yang bergantung pada keadaan panggilan diperbarui langsung (tanpa menunggu render ulang seluruh aplikasi).
function paintCallBusy() {
  const b = callBusy(), hb = $('callbtn');
  if (hb) { hb.classList.toggle('off', b); hb.title = b ? txf('call.inCall', 'Sedang dalam panggilan') : txf('call.voiceAria', 'Panggilan suara'); }
  const vb = $('vcallbtn');
  if (vb) { vb.classList.toggle('off', b); vb.title = b ? txf('call.inCall', 'Sedang dalam panggilan') : txf('call.video', 'Panggilan video'); }
  for (const x of document.querySelectorAll('#list .cbk')) { x.classList.toggle('off', b); x.title = b ? txf('call.inCall', 'Sedang dalam panggilan') : txf('call.again', 'Telepon lagi'); }
  const g = S && S.groups && S.groups.find((x) => 'g:' + x.id === cur); if (g) renderVc(g);
  renderPv();
}
function dial(peer, video) {
  if (!callCtl) return;
  if (callBusy()) return toast(callBusyMsg());
  if (!peer) return toast(txf('call.peerUnseen', 'Dia belum terlihat di jaringan'));
  if (!peer.online && peer.bg) toast(txf('call.peerBg', 'Dia online di latar belakang. Menyambungkan, tunggu sebentar…')); // Core membangunkan dan menunggu ~25 dtk (callStart)
  else if (!peer.online) return toast(txf('call.peerOffline', 'Dia sedang offline, panggilan tidak bisa tersambung'));
  if (!peer.secure) return toast(txf('call.needEnc', 'Panggilan butuh enkripsi, tapi versi Archne dia terlalu lama'));
  callCtl.start(peer.id, peer.name, video ? { video: true } : undefined);
}
// Lipat pesan panjang: potong di batas karakter atau baris (mana yang lebih dulu), jangan memecah pasangan surrogate (emoji).
function fold(text) {
  let cut = text.length > FOLD_CHARS ? FOLD_CHARS : -1, nl = -1;
  for (let i = 0, n = 0; i < text.length && (cut < 0 || i < cut); i++) if (text.charCodeAt(i) === 10 && ++n >= FOLD_LINES) { nl = i; break; }
  if (nl >= 0) cut = nl;
  if (cut < 0) return null;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return text.slice(0, cut).replace(/\s+$/, '');
}
// Pratinjau satu baris (daftar chat, kutipan balasan): tautan panjang jadi "domain/jalur…".
const lnkShort = (t) => (typeof Linkify === 'undefined' ? String(t == null ? '' : t) : Linkify.short(t));
// Teks pesan -> HTML: di-escape, tautan web jadi chip ringkas (renderer/archne-linkify.js). Teks asli di m.text tidak berubah.
const linkHtml = (t) => (typeof Linkify === 'undefined' ? esc(t) : Linkify.html(t, { esc, icon: IC.link.replace('<svg ', '<svg class="ic" '), copy: IC.copy, nameOf }));
function bodyHtml(m) {
  if (m.file) return null;
  if (typeof inviteBody === 'function') { const iv = inviteBody(m); if (iv !== null) return iv; } // tautan archne://join jadi kartu (js/archne-wan.js)
  const f = fold(m.text);
  if (f === null) return linkHtml(m.text);
  const open = expanded.has(m.id);
  const shown = open ? m.text : m.text.slice(0, typeof Linkify === 'undefined' ? f.length : Linkify.cut(m.text, f.length)).replace(/\s+$/, ''); // tautan tidak pernah terbelah oleh lipatan
  return linkHtml(shown) + (open ? '' : '…') + `<div class="more"><button type="button" class="morebtn" data-more="${m.id}">${open ? txf('msg.less', 'Sembunyikan') : tnf('msg.more', m.text.length, 'Lihat selengkapnya ({count} karakter)', { count: fmt(m.text.length) })}</button></div>`;
}
