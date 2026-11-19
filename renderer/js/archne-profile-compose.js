// Profil: avatar, nama, status, deskripsi. Orang lain: tombol utama hanya + Teman (belum berteman) dan Chat; Hapus teman / Batalkan permintaan dan Blokir ada di menu ⋮ pojok kanan atas.
// Diri sendiri: ketuk foto -> menu Ganti/Pasang foto dan Hapus foto; ubah deskripsi (terlihat semua orang di jaringan).
let pMenu = false, pAvMenu = false, pDraft = null, pLast = null, pEditName = false, pNameDraft = null; // menu terbuka dan ketikan deskripsi yang dijaga saat menu foto dibuka
const DOTS = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>';
function renderProfile() {
  const box = $('pmodal');
  if (!profId) { box.style.display = 'none'; pMenu = pAvMenu = pEditName = false; pDraft = pLast = pNameDraft = null; return; }
  if (pLast !== profId) { pMenu = pAvMenu = pEditName = false; pDraft = pNameDraft = null; pLast = profId; } // pindah ke profil lain: menu tertutup
  box.style.display = 'flex';
  const me = profId === S.me.id, p = S.peers.find((q) => q.id === profId);
  if (me && (document.activeElement === $('pbio') || document.activeElement === $('pname'))) return; // jangan menghapus ketikan yang sedang berjalan
  const nm = nameOf(profId), bio = bioOf(profId), fst = p ? (p.fst || (p.friend ? 'ok' : '')) : '';
  const status = me ? txf('chat.you', 'Kamu') : p ? `<span class="pdot${p.online ? ' on' : ''}"></span>${p.online ? txf('peer.online', 'Online') : txf('peer.offline', 'Offline')}` : txf('profile.unseen', 'belum terlihat di jaringan');
  let h = `${avHtml(profId, false)}<div class="pnm">${esc(nm)}</div><div class="psub">#${esc(profId.slice(0, 6))} · ${status}${fst === 'ok' ? ' · ' + icn('star', 'fil') + txf('badge.friend', 'Teman') : ''}</div>`;
  if (me) {
    const max = (S.limits && S.limits.maxBio) || 140, hasAv = !!(S.avatars && S.avatars[profId]);
    const avMenu = pAvMenu ? `<div class="pmenu pavm" role="menu"><button data-pact="photo" role="menuitem">${icn('camera')}${hasAv ? txf('profile.changePhoto', 'Ganti foto') : txf('profile.setPhoto', 'Pasang foto')}</button>${hasAv ? '<button class="dng" data-pact="rmphoto" role="menuitem">' + icn('trash') + txf('profile.rmPhoto', 'Hapus foto') + '</button>' : ''}</div>` : '';
    h = `<div class="pavbox"><button class="pavw" data-pact="avmenu" aria-label="${esc(txf('profile.avAria', 'Ubah foto profil'))}" aria-expanded="${pAvMenu}">${avHtml(profId, false)}<span class="pcam">${icn('camera')}</span></button>${avMenu}</div>` + h.slice(h.indexOf('<div class="pnm">')).replace('<div class="pnm">' + esc(nm) + '</div>', pEditName
      ? `<div class="pnedit"><input id="pname" maxlength="32" value="${esc(pNameDraft !== null ? pNameDraft : S.me.name || '')}" placeholder="${esc(txf('side.name', 'Nama panggilan'))}" aria-label="${esc(txf('side.name', 'Nama panggilan'))}">${ibtn('check', txf('common.save', 'Simpan'), 'data-pact="savename"', 'pri')}${ibtn('x', txf('common.cancel', 'Batal'), 'data-pact="cancelname"')}</div>`
      : `<div class="pnm pnme"><span class="pnt">${esc(nm)}</span>${ibtn('edit', txf('profile.editName', 'Ubah nama'), 'data-pact="editname"', 'mini')}</div>`);
    h += `<textarea id="pbio" maxlength="${max}" placeholder="${esc(DEFAULT_BIO)}">${pDraft !== null ? esc(pDraft) : bio === DEFAULT_BIO ? '' : esc(bio)}</textarea>`
      + '<div class="pbtns">' + ibtn('check', txf('common.save', 'Simpan'), 'data-pact="save"', 'pri') + pgBtn(profId) + '</div>';
    const bls = S.blocked || [];
    if (bls.length) h += `<div class="sect" style="margin-top:14px;text-align:left">${icn('block')}${txf('profile.blockedH', 'Diblokir ({count})', { count: bls.length })}</div>` + bls.map((b) => `<div class="brow"><span class="nm">${esc(tag(b.name, b.id))}</span><button data-pact="unblock" data-bid="${esc(b.id)}">${txf('profile.unblock', 'Buka blokir')}</button></div>`).join('');
  } else if ((S.blocked || []).some((b) => b.id === profId)) {
    h += `<div class="pst">${icn('block')}${txf('profile.blockedNote', 'Kamu memblokir orang ini. Pesan dan profilnya disembunyikan, dia tidak bisa menghubungimu.')}</div><div class="pbtns"><button data-pact="unblock" data-bid="${esc(profId)}">${icn('check')}${txf('profile.unblock', 'Buka blokir')}</button></div>`;
  } else {
    // Tombol utama: + Teman (hanya bila belum berteman) dan Chat. Sudah berteman: statusnya cukup di baris #id · Online · Teman.
    const fr = !p ? '' : fst === 'in' ? ibtn('check', txf('dlg.accept', 'Terima'), 'data-pact="friend"', 'pri') + ibtn('x', txf('profile.decline', 'Tolak'), 'data-pact="unfriend"')
      : fst === '' ? ibtn('add', txf('profile.addFriend', 'Teman'), 'data-pact="friend"') : '';
    // Menu ⋮: Hapus teman / Batalkan permintaan di atas, Blokir di bawahnya.
    const mi = (fst === 'ok' ? '<button data-pact="unfriend" role="menuitem">' + icn('x') + txf('profile.unfriend', 'Hapus teman') + '</button>'
      : fst === 'out' ? '<button data-pact="unfriend" role="menuitem">' + icn('reply') + txf('profile.cancelReq', 'Batalkan permintaan') + '</button>' : '')
      + '<button class="dng" data-pact="block" role="menuitem" title="' + esc(txf('profile.blockTitle', 'Putus pertemanan, sembunyikan dia dan pesannya. Dia tidak diberi tahu soal blokirnya')) + '">' + icn('block') + txf('profile.block', 'Blokir') + '</button>';
    h = `<button class="pdots" data-pact="menu" aria-label="${esc(txf('head.more', 'Menu lainnya'))}" aria-expanded="${pMenu}">${DOTS}</button>${pMenu ? `<div class="pmenu pdm" role="menu">${mi}</div>` : ''}` + h;
    const note = fst === 'out' ? icn('clock') + txf('profile.reqSent', 'Permintaan terkirim. Menunggu dia menyetujui.') : fst === 'in' ? icn('hand') + txf('profile.wantsYou', 'Dia ingin berteman denganmu.') : '';
    h += `<div class="bio">${esc(bio)}</div>${note ? `<div class="pst">${note}</div>` : ''}<div class="pbtns">${fr}${p ? ibtn('chat', txf('profile.chat', 'Chat'), 'data-pact="chat"', 'pri') : ''}${pgBtn(profId)}</div>`;
  }
  $('pbody').innerHTML = h;
}
$('pmodal').onclick = async (e) => {
  if (e.target === $('pmodal')) { profId = null; renderProfile(); return; } // klik latar menutup
  const b = e.target.closest && e.target.closest('[data-pact]');
  if (!b) { if (pMenu || pAvMenu) { pMenu = pAvMenu = false; renderProfile(); } return; } // ketuk di luar menu: menu menutup
  const act = b.dataset.pact, id = profId;
  if (act === 'menu') { pMenu = !pMenu; renderProfile(); return; }
  if (act === 'avmenu') { // ketikan deskripsi yang belum disimpan dijaga lewat render ulang
    const t = $('pbio'); pDraft = t && typeof t.value === 'string' && t.value !== '' ? t.value : null;
    pAvMenu = !pAvMenu; if (document.activeElement === t && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderProfile(); pDraft = null; return;
  }
  if (act === 'editname') { pEditName = true; pNameDraft = null; renderProfile(); const i = $('pname'); if (i && i.focus) { i.focus(); if (i.select) i.select(); } return; }
  if (act === 'cancelname') { pEditName = false; pNameDraft = null; renderProfile(); return; }
  if (act === 'savename') {
    const nv = ($('pname') && typeof $('pname').value === 'string' ? $('pname').value : '').trim();
    if (!nv) { toast(txf('profile.nameEmpty', 'Nama tidak boleh kosong')); return; }
    const rn = await window.api.setName(nv); pEditName = false; pNameDraft = null;
    if (rn && rn.ok === false && rn.err) toast(rn.err);
    await refresh(); return;
  }
  pMenu = pAvMenu = false;
  if (act === 'chat') { profId = null; renderProfile(); pickChat(id); return; }
  if (act === 'photo') { $('pfile').click(); renderProfile(); return; } // memilih gambar: lihat $('pfile').onchange
  let r;
  if (act === 'block') {
    const who = nameOf(id);
    if (!await ask(txf('profile.blockConfirm', 'Blokir {who}?\n\n• Dia dan semua pesannya (publik, grup, privat) disembunyikan darimu.\n• Pesan, permintaan teman, dan undangan grup darinya diabaikan.\n• Pertemanan diputus di kedua sisi (dia menerima pemutusan pertemanan biasa, BUKAN kabar bahwa dia diblokir).\n• Di grup yang sama dia tetap bisa membaca pesan grup; untuk memutus total, minta admin mengeluarkannya.\n\nKamu bisa membuka blokir kapan saja dari profilmu.', { who }))) return;
    r = await window.api.blockUser(id);
    if (!(r && r.ok === false && r.err)) profId = null;
  } else if (act === 'unblock') r = await window.api.unblockUser(b.dataset.bid || id);
  else if (act === 'rmphoto') r = await window.api.setAvatar('');
  else if (act === 'save') r = await window.api.setBio($('pbio').value);
  else if (act === 'friend') r = await window.api.addFriend(id);
  else if (act === 'unfriend') r = await window.api.removeFriend(id);
  if (r && r.ok === false && r.err) toast(r.err);
  else if (act === 'save') profId = null;
  await refresh();
};
// Foto profil: gambar dikecilkan di renderer (archne-avatar.js) jadi JPEG kecil, lalu Core memeriksanya lagi dan menandatanganinya bersama deskripsi.
$('pfile').onchange = async () => {
  const f = $('pfile').files && $('pfile').files[0]; $('pfile').value = '';
  if (!f) return;
  try {
    const r = await window.api.setAvatar(await Avatar.fromFile(f));
    if (r && r.ok === false) toast(r.err || txf('profile.photoSaveFail', 'Gagal menyimpan foto'));
  } catch (e) { toast((e && e.message) || txf('profile.photoProcFail', 'Gagal memproses gambar')); }
  await refresh();
};
let lastSeen = new Set();
async function refresh() {
  if (typeof dxSoon === 'function') dxSoon(); // Kirim Langsung (js/archne-direct.js): satu pendaftaran onUpdate saja, supaya tes yang menangkap callback terakhir tetap memanggil refresh
  const prev = S.messages.length ? new Set(S.messages.map((m) => m.id)) : null;
  S = await window.api.state();
  if (S && S.call && typeof playerStop === 'function') playerStop(); // panggilan masuk/berjalan: pemutar berhenti
  await pvLoadAll();
  if (callCtl) { const cv = callCtl.cur && callCtl.cur.pv ? { pv: true, cid: callCtl.cur.room } : S.vc; if (cv) { const nm = vcName(cv); if (nm) callCtl.setChannelName(nm); } callCtl.sync(S.call, S.vc, S.pv && S.pv.me ? S.pv.me : null); tryAnswer(); if ((callPick || (callCtl.cur && callCtl.cur.vc)) && callCtl.cur) callCtl._render(); } // di channel: daftar peserta mengikuti presence terbaru
  if (prev) for (const m of S.messages) if (!prev.has(m.id) && m.from !== S.me.id && !m.sys) {
    const k = m.to === 'public' ? 'public' : m.to.startsWith('g:') ? m.to : m.from;
    if (k !== cur) unread[k] = (unread[k] || 0) + 1;
  }
  render();
}
let toastT;
const toast = (t, good) => { const el = $('toast'); el.className = good ? 'ok' : ''; el.textContent = t; el.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => { el.style.display = 'none'; }, good ? 3500 : 6000); };
$('toast').onclick = () => { clearTimeout(toastT); $('toast').style.display = 'none'; }; // ketuk untuk menutup
// Kabar dari cangkang Android (halaman induk): berkas masuk ke folder Download, atau gagal dibuka/disimpan.
if (window.addEventListener && window.parent && window.parent !== window) window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window.parent || !d || typeof d !== 'object') return;
  if (d.archne === 'native-saved' && typeof d.name === 'string') toast(txf('dl.saved', 'Tersimpan di folder {path}: {name}', { path: 'Download' + (typeof d.dir === 'string' && d.dir ? '/' + d.dir : ''), name: d.name }), true);
  else if (d.archne === 'native-error') toast(String(d.err || txf('common.failed', 'Gagal')));
  else if (d.archne === 'native-info' && typeof d.text === 'string') toast(d.text, true);
  else if (d.archne === 'open-chat' && typeof d.key === 'string') { // ketukan pada notifikasi: buka chat-nya bila ada
    const ok = d.key === 'public' || (d.key.startsWith('g:') ? S.groups.some((g) => 'g:' + g.id === d.key) : /^[0-9a-f]{16}$/.test(d.key) && d.key !== S.me.id);
    if (ok) pickChat(d.key);
  } else if (d.archne === 'answer-call' && typeof d.cid === 'string' && d.cid.length > 0 && d.cid.length <= 64) { // tombol "Jawab" di notifikasi panggilan
    wantAnswer = { cid: d.cid, until: Date.now() + 15000 };
    tryAnswer();
  }
});
// Jawab dari notifikasi: panggilannya baru terlihat UI setelah state dimuat (halaman bisa dimuat ulang saat aplikasi dibuka), jadi coba lagi di tiap sinkronisasi sampai 15 dtk.
let wantAnswer = null;
function tryAnswer() {
  if (!wantAnswer) return;
  if (Date.now() > wantAnswer.until) { wantAnswer = null; return; }
  const c = callCtl && callCtl.cur;
  if (!c || c.cid !== wantAnswer.cid || c.dir !== 'in' || c.phase !== 'ringing') return;
  wantAnswer = null;
  callCtl.accept();
}
// Balas pesan: pasang/lepas penanda balasan di atas kotak ketik.
function setReply(m) {
  const bar = $('rbar');
  if (!m) { replyTo = null; bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const who = m.from === S.me.id ? txf('chat.you', 'Kamu') : tag(m.name, m.from);
  let t = String(m.text || '').replace(/\s+/g, ' '); if (t.length > 120) t = t.slice(0, 120) + '…';
  replyTo = { id: m.id, chat: cur, who, text: t };
  bar.innerHTML = `<div class="rc"><div class="rn">${icn('reply')}<span>${esc(txf('reply.to', 'Membalas {who}', { who }))}</span></div><div class="rt">${esc(t)}</div></div><button type="button" id="rcancel" title="${esc(txf('reply.cancelTitle', 'Batal membalas (Esc)'))}" aria-label="${esc(txf('reply.cancel', 'Batal membalas'))}">${IC.x}</button>`;
  bar.style.display = 'flex';
  $('rcancel').onclick = () => { setReply(null); $('text').focus(); };
  $('text').focus();
}
// Klik kutipan: gulir ke pesan asli dan sorot sebentar. Render ulang berkala tidak menghapus sorotan (flashId).
function gotoMsg(id) {
  const el = document.querySelector(`#msgs [data-mid="${CSS.escape(id)}"]`);
  if (!el) return toast(txf('reply.notShown', 'Pesan asli tidak ada di tampilan (terlalu lama, atau belum dimuat)'));
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flashId = id; flashUntil = Date.now() + 1600;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
// Aksi kartu berkas (tombol ikon di kartu dan butir menu ⋮): satu jalur untuk keduanya.
async function fileAct(act, id, risky) {
  const api = window.api;
  let r;
  if (act === 'recv') {
    if (risky && !await ask(txf('file.riskyConfirm', 'Berkas ini bisa dijalankan (program atau skrip) dan berasal dari orang lain di jaringan.\nTerima hanya jika kamu mengenal pengirimnya dan memang menunggunya.\n\nLanjutkan mengunduh?'), { ok: txf('dlg.accept', 'Terima'), danger: true })) return;
    delete prog[id]; r = await api.receiveFile(id);
  }
  else if (act === 'discard') { delete prog[id]; r = await api.discardIncoming(id); }
  else if (act === 'cancelrx') r = await api.cancelReceive(id);
  else if (act === 'view') { if (typeof openImg === 'function') openImg(id); return; }
  else if (act === 'playdl') { // putar sambil mengunduh: unduhan jalan terus walau pemutar ditutup
    if (typeof openPlayer !== 'function') return;
    delete prog[id]; Promise.resolve(api.receiveFile(id)).then((x) => { if (x && x.ok === false && x.err) toast(x.err); return refresh(); }).catch(() => {});
    openPlayer(id, true); return;
  }
  else if (act === 'play') { if (typeof inlineCan === 'function' && inlineCan(id)) { inlinePlay(id); return; } if (typeof openPlayer === 'function') openPlayer(id); return; } // suara/video berminiatur: di gelembung
  else if (act === 'full') { if (typeof inlineStop === 'function') inlineStop(); if (typeof openPlayer === 'function') openPlayer(id); return; } // Layar penuh (menu ⋮)
  else if (act === 'open') r = await api.openFile(id);
  else if (act === 'show') r = await api.showFile(id);
  else if (act === 'cancelsend') r = await api.cancelSend(id);
  else if (act === 'dismiss') r = await api.dismissSend(id);
  if (r && r.ok === false && r.err) toast(r.err);
  await refresh();
}
$('msgs').onclick = async (e) => {
  const mb = e.target.closest && e.target.closest('[data-more]');
  if (mb) {
    const id = mb.dataset.more, wasOpen = expanded.has(id);
    if (wasOpen) expanded.delete(id); else expanded.add(id);
    render();
    if (wasOpen) { const el = document.querySelector(`#msgs [data-mid="${CSS.escape(id)}"]`); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); } // setelah dilipat, pesan tetap terlihat
    return;
  }
  const gq = e.target.closest && e.target.closest('[data-goto]');
  if (gq) { gotoMsg(gq.dataset.goto); return; }
  const a = e.target.closest && e.target.closest('[data-act]');
  if (a) { await fileAct(a.dataset.act, a.dataset.id, !!a.dataset.risky); return; }
  const u = e.target.closest && e.target.closest('[data-uid]'); // klik nama pengirim: buka profilnya
  if (u) { profId = u.dataset.uid; renderProfile(); return; }
};
// Batalkan pesan untuk semua orang (dipanggil dari menu aksi pesan, js/archne-msgmenu.js).
async function delMsg(id) {
  if (!await ask(txf('msg.recallConfirm', 'Batalkan pesan ini untuk semua orang?\nPesan akan hilang di perangkat penerima juga.'))) return;
  const r = await window.api.deleteMessage(id); if (!r.ok) notify(r.err);
  await refresh();
}
window.api.onUpdate(refresh);
window.api.onRemoved((r) => toast(r.disband ? txf('group.disbanded', 'Grup "{name}" dibubarkan oleh {by}. Grup dihapus dari perangkat ini.', { name: r.name, by: r.by }) : txf('group.kicked', 'Kamu dikeluarkan dari grup "{name}" oleh {by}. Grup dihapus dari perangkat ini.', { name: r.name, by: r.by })));
setInterval(refresh, 4000);
const maxText = () => (S.limits && S.limits.maxText) || 10000;
const fmt = (n) => n.toLocaleString(typeof I18N !== 'undefined' ? uiLoc() : 'id-ID'); // angka mengikuti bahasa aplikasi (id: 10.000, en: 10,000)
// Penghitung + tinggi kotak otomatis. Tidak memotong apa pun: kalau lewat batas, tombol Kirim mati dan angka merah.
function onType() {
  const ta = $('text'), n = ta.value.trim().length, max = maxText(), over = n > max;
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  const c = $('cnt');
  c.style.display = n ? 'block' : 'none';
  c.textContent = over ? txf('compose.over', '{n} / {max} (kelebihan {over})', { n: fmt(n), max: fmt(max), over: fmt(n - max) }) : `${fmt(n)} / ${fmt(max)}`;
  c.classList.toggle('over', over);
  $('sendbtn').disabled = over;
}
$('text').addEventListener('input', onType);
// Layar sentuh (Android): Enter = baris baru, kirim lewat tombol Kirim. Desktop: Enter kirim, Shift+Enter baris baru.
const touchUI = () => !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
// placeholder #text: dari archne-index.html (data-i18n-ph="chat.input", i18n B1); jangan ditimpa di sini.
$('text').title = touchUI() ? '' : txf('compose.enterHint', 'Enter untuk kirim, Shift+Enter untuk baris baru');
$('text').addEventListener('keydown', (e) => { if (e.key === 'Escape' && replyTo) { setReply(null); return; } if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchUI()) { e.preventDefault(); $('form').requestSubmit(); } });
$('form').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('text').value;
  if (!t.trim() || t.trim().length > maxText()) return;
  $('text').value = ''; onType();
  const rt = replyTo && replyTo.chat === cur ? replyTo : null;
  const r = await window.api.send(t, cur, rt ? rt.id : undefined);
  if (r !== true) { $('text').value = t; onType(); notify(r); return; }
  if (rt && replyTo === rt) setReply(null);
};
$('newgrp').onclick = () => {
  const ps = S.peers.filter((p) => p.secure);
  $('gpeers').innerHTML = ps.length ? ps.map((p) => `<label><input type="checkbox" value="${p.id}"> ${esc(tag(p.name, p.id))} ${p.online ? '' : txf('peer.offlineTag', '(offline)')}</label>`).join('') : '<small>' + txf('group.noPeers', 'Belum ada peer yang bisa dienkripsi.') + '</small>';
  $('gname').value = ''; $('modal').style.display = 'flex'; $('gname').focus();
};
$('gcancel').onclick = () => { $('modal').style.display = 'none'; };
$('gok').onclick = async () => {
  const ids = [...document.querySelectorAll('#gpeers input:checked')].map((c) => c.value);
  const r = await window.api.createGroup($('gname').value, ids);
  if (!r.ok) return notify(r.err);
  $('modal').style.display = 'none'; cur = 'g:' + r.id; emptyTab = false; await refresh();
};

// Ubah nama di profil: Enter = simpan, Esc = batal.
$('pmodal').addEventListener('keydown', (e) => {
  if (!e.target || e.target.id !== 'pname') return;
  if (e.key === 'Enter') { e.preventDefault(); const b = $('pmodal').querySelector && $('pmodal').querySelector('[data-pact="savename"]'); if (b && b.click) b.click(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pEditName = false; pNameDraft = null; renderProfile(); }
});
