// ---- Channel suara publik (v0.20.0, pvch6): strip di tab Publik. Hanya yang ada orangnya + milikku (Core menyaringnya); "Yang kosong" menampilkan semuanya. ----
// Masuk = sesi audio lewat Controller panggilan: callCtl.enterPublic(cid, nama, pin) -> { ok, wrong? } (wrong = PIN ditolak). Layar telpon, minimize, dan larangan telpon ganda dipakai ulang dari channel grup.
const PV_MAX = 16;
let pvFold = false, pvShowEmpty = false, pvAll = null, pvmEdit = null, pinCh = null;
const pvNames = new Map();
try { pvFold = localStorage.getItem('lc.pvfold') === '1'; pvShowEmpty = localStorage.getItem('lc.pvempty') === '1'; } catch (x) {}
// PIN yang pernah benar diingat di perangkat ini (pintu berkas, bukan rahasia), supaya masuk lagi tidak perlu mengetik; dibuang kalau ditolak / diganti.
const pvPins = () => { try { const o = JSON.parse(localStorage.getItem('lc.pvpins') || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (x) { return {}; } };
const pvPinGet = (cid) => { const p = pvPins()[cid]; return typeof p === 'string' && /^[0-9]{6}$/.test(p) ? p : ''; };
function pvPinSet(cid, pin) {
  try { const o = pvPins(); if (pin) o[cid] = pin; else delete o[cid]; const ks = Object.keys(o); for (const k of ks.slice(0, Math.max(0, ks.length - 50))) delete o[k]; localStorage.setItem('lc.pvpins', JSON.stringify(o)); } catch (x) {}
}
const pvRows = () => (pvShowEmpty && pvAll ? pvAll : (S.pv && S.pv.channels) || []);
async function pvLoadAll() {
  if (!pvShowEmpty || cur !== 'public') return;
  try { const r = await window.api.pvList(true); pvAll = r && r.ok !== false && Array.isArray(r.channels) ? r.channels : null; } catch (x) { pvAll = null; }
}
function renderPv() {
  const bar = $('pvbar');
  if (cur !== 'public') { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const chs = pvRows(), me = S.pv && S.pv.me ? S.pv.me : null, busy = callBusy();
  for (const c of chs) pvNames.set(c.id, c.name);
  const who = (c) => { const n = (c.people || []).map((x) => (x.me ? txf('chat.you', 'Kamu') : x.name || '?')); return n.join(', ') + (c.count > n.length ? ' +' + (c.count - n.length) : ''); };
  const row = (c) => {
    const inHere = c.id === me, here = c.count > 0;
    const btn = inHere ? `<button type="button" class="sec" data-pact="leave" data-cid="${c.id}">${esc(txf('vc.leave', 'Keluar'))}</button>`
      : c.full ? `<span class="tg" title="${esc(txf('pv.fullTitle', 'Channel penuh (maksimal {max} orang)', { max: PV_MAX }))}">${esc(txf('pv.full', 'penuh'))}</span>`
      : `<button type="button"${busy ? ' class="off" title="' + esc(txf('vc.busyTitle', 'Sedang dalam panggilan. Keluar dulu untuk masuk channel lain.')) + '"' : ''} data-pact="enter" data-cid="${c.id}">${esc(txf('vc.join', 'Masuk'))}</button>`;
    const mg = c.canManage ? `<button type="button" class="sec" data-pact="edit" data-cid="${c.id}" title="${esc(txf('pv.manageTitle', 'Kelola channel: nama, kunci, dan PIN'))}" aria-label="${esc(txf('vc.manageAria', 'Kelola channel'))}">${esc(txf('vc.manage', 'Kelola'))}</button><button type="button" class="dng" data-pact="del" data-cid="${c.id}" title="${esc(txf('vc.delTitle', 'Hapus channel'))}" aria-label="${esc(txf('vc.delTitle', 'Hapus channel'))}">${IC.trash}</button>` : '';
    return `<div class="vch${inHere ? ' in' : ''}" data-cid="${c.id}"><span class="ic">${c.locked ? IC.lock : IC.speaker}</span><div class="vc"><div class="vn">${esc(c.name)}</div><div class="vw${here ? ' on' : ''}">${here ? esc(who(c)) : esc(txf('vc.empty', 'Kosong'))}</div></div>${here ? `<span class="tg cnt" title="${esc(txf('pv.countTitle', 'Jumlah orang di channel'))}">${c.count}/${PV_MAX}</span>` : ''}${btn}${mg}</div>`;
  };
  bar.className = pvFold ? 'vcfold' : '';
  bar.style.display = 'block';
  bar.innerHTML = `<div class="vch-h" data-pact="fold" role="button" tabindex="0" aria-expanded="${!pvFold}"><span class="chev">${IC.chev}</span><span class="vct">${esc(txf('pv.head', 'Channel suara publik · {count}', { count: chs.length }))}</span><button type="button" class="sec${pvShowEmpty ? ' on' : ''}" data-pact="empty" aria-pressed="${pvShowEmpty}" title="${esc(txf('pv.emptyTitle', 'Tampilkan juga channel yang kosong'))}">${esc(txf('pv.emptyBtn', 'Yang kosong'))}</button><button type="button" data-pact="new">${esc(txf('vc.newBtn', '+ Channel'))}</button></div>`
    + (chs.length ? chs.map(row).join('') : `<div class="vcnone">${esc(pvShowEmpty ? txf('pv.noneAll', 'Belum ada channel publik.') : txf('pv.noneBusy', 'Belum ada channel yang ada orangnya. Buat satu, atau tekan “Yang kosong” untuk melihat semuanya.'))}</div>`);
}
// Masuk lewat Controller panggilan. PIN yang diketik dikirim sekali; Controller mengembalikan { ok, wrong }.
async function pvJoin(c, pin) {
  const r = await callCtl.enterPublic(c.id, c.name, pin || '');
  if (r && r.ok === false) return { ok: false, wrong: r.wrong === true };
  if (pin) pvPinSet(c.id, pin);
  return { ok: true };
}
async function pvEnterUi(c) {
  if (callBusy()) return toast(callBusyMsg());
  if (!callCtl) return toast(txf('vc.noVoice', 'Perangkat ini belum mendukung suara. Channel butuh mikrofon dan WebRTC.'));
  const need = c.locked && !c.mine, pin = need ? pvPinGet(c.id) : '';
  if (need && !pin) return openPin(c);
  const r = await pvJoin(c, pin);
  if (!r.ok && r.wrong) { pvPinSet(c.id, ''); return openPin(c, txf('pv.pinChanged', 'PIN sudah diganti. Masukkan PIN yang baru.')); }
  await refresh();
}
$('pvbar').onclick = async (e) => {
  const el = e.target.closest && e.target.closest('[data-pact]'); if (!el) return;
  const act = el.dataset.pact, cid = el.dataset.cid;
  if (e.stopPropagation && act !== 'fold') e.stopPropagation();
  if (act === 'fold') { pvFold = !pvFold; try { localStorage.setItem('lc.pvfold', pvFold ? '1' : '0'); } catch (x) {} return renderPv(); }
  if (act === 'empty') { pvShowEmpty = !pvShowEmpty; pvAll = null; try { localStorage.setItem('lc.pvempty', pvShowEmpty ? '1' : '0'); } catch (x) {} await pvLoadAll(); return renderPv(); }
  if (act === 'new') return openPvm(null);
  const c = pvRows().find((x) => x.id === cid);
  let r;
  if (act === 'enter' && c) return pvEnterUi(c);
  else if (act === 'leave') { if (callCtl && callCtl.cur && callCtl.cur.pv) { callCtl.hangup(); r = { ok: true }; } else r = await window.api.pvLeave(); }
  else if (act === 'edit' && c && c.canManage) return openPvm(c);
  else if (act === 'del' && c && c.canManage) { if (!await ask(txf('pv.delConfirm', 'Hapus channel "{name}"? Channel hilang untuk semua orang, dan yang sedang di dalam keluar otomatis.', { name: c.name }))) return; r = await window.api.pvDelete(cid); pvPinSet(cid, ''); }
  else return;
  if (r && r.ok === false) toast(r.err || txf('common.failed', 'Gagal'));
  await refresh();
};
// Dialog PIN saat masuk channel terkunci.
function openPin(c, msg) {
  pinCh = c; $('pintitle').innerHTML = icn('lock') + ' ' + esc(c.name); $('pinerr').textContent = msg || ''; $('pinput').value = '';
  $('pinmodal').style.display = 'flex'; $('pinput').focus();
}
const onlyDigits = (el) => { const v = String(el.value).replace(/[^0-9]/g, '').slice(0, 6); if (v !== el.value) el.value = v; };
$('pinput').oninput = () => { onlyDigits($('pinput')); $('pinerr').textContent = ''; };
$('pinput').onkeydown = (e) => { if (e && e.key === 'Enter') $('pinok').onclick(); };
$('pincancel').onclick = () => { pinCh = null; $('pinmodal').style.display = 'none'; };
$('pinok').onclick = async () => {
  const c = pinCh, pin = $('pinput').value; if (!c) return;
  if (!/^[0-9]{6}$/.test(pin)) { $('pinerr').textContent = txf('pv.pin6', 'PIN terdiri dari 6 angka'); return; }
  if (callBusy()) { $('pinmodal').style.display = 'none'; pinCh = null; return toast(callBusyMsg()); }
  $('pinok').disabled = true;
  let r; try { r = await pvJoin(c, pin); } finally { $('pinok').disabled = false; }
  if (!r.ok && r.wrong) { $('pinerr').textContent = txf('pv.pinWrong', 'PIN salah'); $('pinput').value = ''; $('pinput').focus(); return; }
  $('pinmodal').style.display = 'none'; pinCh = null; // berhasil, atau gagal karena hal lain (Controller sudah menampilkan alasannya)
  await refresh();
};
// Dialog buat / kelola channel publik (pvmEdit = null: baru). Gratis atau Kunci + PIN. Saat mengelola channel terkunci, PIN kosong = tidak diubah.
function syncPvm() { $('pvpinbox').style.display = $('pvlock').checked ? 'block' : 'none'; }
function openPvm(c) {
  pvmEdit = c ? c.id : null;
  $('pvtitle').textContent = c ? txf('pv.titleEdit', 'Kelola channel publik') : txf('pv.titleNew', 'Channel suara publik baru'); $('pvok').textContent = c ? txf('common.save', 'Simpan') : txf('common.create', 'Buat');
  $('pvname').value = c ? c.name : ''; $('pvlock').checked = !!(c && c.locked); $('pvpin').value = '';
  $('pvpin').placeholder = c && c.locked ? txf('pv.pinKeep', 'PIN baru (kosong = tidak diubah)') : txf('vc.pin6', 'PIN 6 angka');
  syncPvm(); $('pvmodal').style.display = 'flex'; $('pvname').focus();
}
$('pvlock').onchange = syncPvm;
$('pvpin').oninput = () => onlyDigits($('pvpin'));
$('pvcancel').onclick = () => { $('pvmodal').style.display = 'none'; };
$('pvok').onclick = async () => {
  const name = $('pvname').value.trim(); if (!name) return toast(txf('vc.needName', 'Isi nama channel'));
  const lock = $('pvlock').checked, pin = $('pvpin').value;
  if (lock && pin && !/^[0-9]{6}$/.test(pin)) return toast(txf('pv.pin6', 'PIN terdiri dari 6 angka'));
  const ch = pvmEdit ? pvRows().find((x) => x.id === pvmEdit) : null;
  if (pvmEdit && (!ch || !ch.canManage)) { $('pvmodal').style.display = 'none'; toast(txf('vc.gone', 'Channel sudah tidak ada atau kamu tak lagi boleh mengelolanya')); return refresh(); }
  let r;
  if (!ch) { if (lock && !pin) return toast(txf('pv.needPin', 'Isi PIN 6 angka')); r = await window.api.pvCreate(name, lock ? pin : null); }
  else {
    const patch = {};
    if (name !== ch.name) patch.name = name;
    if (!lock && ch.locked) patch.pin = null;
    else if (lock && pin) patch.pin = pin;
    else if (lock && !ch.locked) return toast(txf('pv.needPin', 'Isi PIN 6 angka'));
    if (!Object.keys(patch).length) { $('pvmodal').style.display = 'none'; return; } // tidak ada yang berubah: jangan menaikkan versi
    r = await window.api.pvUpdate(ch.id, patch);
  }
  if (r && r.ok === false) return toast(r.err || (ch ? txf('vc.saveFail', 'Gagal menyimpan channel') : txf('vc.createFail', 'Gagal membuat channel')));
  $('pvmodal').style.display = 'none';
  await refresh();
};
// Dikeluarkan otomatis (dihapus / dikunci / PIN diganti): beri tahu; PIN lama yang diingat dibuang.
if (typeof window.api.onPvKick === 'function') window.api.onPvKick((ev) => {
  if (callCtl && typeof callCtl.pvKicked === 'function' && ev) callCtl.pvKicked(ev.cid); // Core sudah melepasku: tutup layar telpon seketika
  const nm = pvNames.get(ev && ev.cid), p = { name: nm };
  toast(ev.reason === 'deleted' ? (nm ? txf('pv.kickDel', 'Channel "{name}" dihapus pemiliknya. Kamu keluar.', p) : txf('pv.kickDelNo', 'Channel ini dihapus pemiliknya. Kamu keluar.'))
    : ev.reason === 'pin' ? (nm ? txf('pv.kickPin', 'PIN channel "{name}" diganti. Kamu keluar.', p) : txf('pv.kickPinNo', 'PIN channel ini diganti. Kamu keluar.'))
    : (nm ? txf('pv.kickLock', 'Channel "{name}" dikunci pemiliknya. Kamu keluar.', p) : txf('pv.kickLockNo', 'Channel ini dikunci pemiliknya. Kamu keluar.')));
  if (ev.reason !== 'locked') pvPinSet(ev.cid, '');
});
let memGid = null;
function renderMembers() {
  const g = S.groups.find((x) => x.id === memGid);
  if (!g) { $('mmodal').style.display = 'none'; return; }
  const meId = S.me.id, owner = g.creator === meId, admins = g.admins || [], admin = owner || admins.includes(meId), bl = blockedIds(), leaving = new Set(g.leaving || []);
  $('mtitle').innerHTML = icn('users') + ' ' + esc(g.name) + ' · ' + esc(tnf('grp.members', g.members.length, '{count} anggota', { count: g.members.length }));
  const nm = (x) => x.id === meId ? txf('chat.you', 'Kamu') : ((S.peers.find((p) => p.id === x.id) || {}).name || x.name);
  // Pemilik bisa mengeluarkan siapa saja, mengatur admin, dan memindahkan kepemilikan; admin hanya bisa mengeluarkan anggota biasa.
  // Anggota yang sudah menyatakan keluar (menunggu pemilik/admin online mengeluarkannya dari daftar) tidak diberi tombol.
  const btns = (x) => {
    if (x.id === g.creator || x.id === meId || leaving.has(x.id)) return '';
    const isAdm = admins.includes(x.id);
    return (owner ? `<button class="sec" data-adm="${x.id}" data-on="${isAdm ? 0 : 1}">${esc(isAdm ? txf('mem.revokeAdm', 'Cabut admin') : txf('mem.makeAdm', 'Jadikan admin'))}</button><button class="sec" data-own="${x.id}">${esc(txf('mem.makeOwner', 'Jadikan pemilik'))}</button>` : '')
      + (owner || (admin && !isAdm) ? `<button data-kick="${x.id}">${esc(txf('mem.kick', 'Keluarkan'))}</button>` : '');
  };
  let h = `<div class="mid">${esc(txf('mem.gid', 'ID grup: {id} (tetap, walau nama diganti)', { id: '\u0001' })).replace('\u0001', `<code>${esc(g.id)}</code>`)}</div>`;
  // Foto grup (v0.26.0): semua anggota melihatnya; pemilik/admin bisa memasang, mengganti, dan menghapusnya.
  if (admin || g.av) h += `<div class="mgav">${gavHtml(g, 'md')}${admin ? `<button id="mgphoto" class="sec" type="button">${icn('camera')} ${esc(g.av ? txf('mem.chPhoto', 'Ganti foto grup') : txf('mem.setPhoto', 'Pasang foto grup'))}</button>${g.av ? `<button id="mgrm" class="sec" type="button">${icn('trash')} ${esc(txf('profile.rmPhoto', 'Hapus foto'))}</button>` : ''}` : ''}</div>`;
  if (admin) h += `<div class="mren"><input id="mrename" type="text" maxlength="40" value="${esc(g.name)}" placeholder="${esc(txf('group.name', 'Nama grup'))}"><button id="mrenok">${esc(txf('mem.rename', 'Ganti nama'))}</button></div>`;
  h += '<div>' + g.members.map((x) => `<div class="mrow"><span class="nm" style="color:${color(x.id)}">${esc(nm(x))}<span class="tg"> #${x.id.slice(0, 6)}</span>${bl.has(x.id) ? '<span class="tg blk">' + icn('block') + ' ' + esc(txf('mem.blocked', 'diblokir')) + '</span>' : ''}</span>${x.id === g.creator ? '<span class="role own">' + esc(txf('mem.roleOwner', 'pemilik')) + '</span>' : admins.includes(x.id) ? '<span class="role">' + esc(txf('mem.roleAdmin', 'admin')) + '</span>' : ''}${leaving.has(x.id) ? '<span class="role">' + esc(txf('mem.roleLeft', 'keluar')) + '</span>' : ''}${btns(x)}</div>`).join('') + '</div>';
  if (admin) {
    const cand = S.peers.filter((p) => p.secure && !g.members.some((x) => x.id === p.id));
    h += '<h4>' + esc(txf('mem.addH', 'Tambah anggota')) + '</h4>' + (cand.length ? cand.map((p) => `<label style="display:block;padding:3px 0"><input type="checkbox" value="${p.id}"> ${esc(tag(p.name, p.id))} ${p.online ? '' : txf('peer.offlineTag', '(offline)')}</label>`).join('') + '<div style="margin-top:8px"><button id="maddok">' + esc(txf('mem.add', 'Tambah')) + '</button></div><small style="color:var(--dim)">' + esc(txf('mem.addNote', 'Anggota baru hanya bisa membaca pesan setelah dia bergabung, bukan riwayat sebelumnya.')) + '</small>' : '<small style="color:var(--dim)">' + esc(txf('mem.noAdd', 'Tidak ada peer lain yang bisa ditambahkan.')) + '</small>');
    if (!owner) h += '<h4>' + esc(txf('mem.adminNote', 'Kamu admin: bisa menambah anggota, mengeluarkan anggota biasa, dan mengganti nama. Pemilik dan admin lain tidak bisa dikeluarkan.')) + '</h4>';
  } else h += '<h4>' + esc(txf('mem.ownerOnly', 'Hanya pemilik grup dan admin yang bisa mengubah grup ini.')) + '</h4>';
  const rest = g.members.filter((x) => x.id !== meId && !leaving.has(x.id));
  h += '<div class="mdanger">';
  if (owner && rest.length) {
    h += '<div style="margin-bottom:6px"><small style="color:var(--dim)">' + esc(txf('mem.handTo', 'Kalau kamu keluar, kepemilikan diserahkan ke:')) + '</small><br><select id="mleaveto" style="width:100%"><option value="">' + esc(txf('mem.auto', 'Otomatis (admin tertua, kalau tidak ada: anggota tertua)')) + '</option>' + rest.map((x) => `<option value="${x.id}">${esc(nm(x))} #${x.id.slice(0, 6)}${admins.includes(x.id) ? ' ' + esc(txf('mem.adminTag', '(admin)')) : ''}</option>`).join('') + '</select></div>';
  }
  if (!owner || rest.length) h += '<button id="mleave">' + icn('exit') + ' ' + esc(txf('mem.leave', 'Keluar dari grup')) + '</button><br><small style="color:var(--dim)">' + esc(txf('mem.leaveNote', 'Grup dan riwayatnya dihapus dari perangkat ini. Anggota lain diberi tahu (yang offline menerimanya saat online lagi). Kamu hanya bisa masuk lagi kalau ditambahkan.')) + '</small>';
  if (owner) h += '<div style="margin-top:10px"><button id="mdisband">' + icn('trash') + ' ' + esc(txf('mem.disband', 'Bubarkan grup')) + '</button><br><small style="color:var(--dim)">' + esc(txf('mem.disbandNote', 'Grup dan seluruh riwayatnya dihapus dari semua anggota (yang offline menerimanya saat online lagi). Tidak bisa dibatalkan.')) + '</small></div>';
  h += '</div>';
  $('mbody').innerHTML = h;
  document.querySelectorAll('[data-kick]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.kick, who = nm(g.members.find((x) => x.id === id));
    if (!await ask(txf('mem.kickConfirm', 'Keluarkan {who} dari grup? Kunci grup akan diganti, dan dia tidak bisa membaca pesan baru.', { who }))) return;
    const r = await window.api.removeMember(g.id, id); if (!r.ok) notify(r.err);
    await refresh(); renderMembers();
  });
  document.querySelectorAll('[data-adm]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.adm, on = b.dataset.on === '1', who = nm(g.members.find((x) => x.id === id));
    if (!await ask(on ? txf('mem.admConfirm', 'Jadikan {who} admin? Admin bisa menambah anggota, mengeluarkan anggota biasa, dan mengganti nama grup.', { who }) : txf('mem.admRevoke', 'Cabut status admin {who}?', { who }))) return;
    const r = await window.api.setGroupAdmin(g.id, id, on); if (!r.ok) notify(r.err);
    await refresh(); renderMembers();
  });
  document.querySelectorAll('[data-own]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.own, who = nm(g.members.find((x) => x.id === id));
    if (!await ask(txf('mem.ownConfirm', 'Jadikan {who} pemilik grup "{name}"?\n\nKamu tetap di grup sebagai admin. Hanya pemilik yang bisa mengangkat/mencabut admin, memindahkan kepemilikan, dan membubarkan grup, jadi {who} bisa mencabut statusmu.', { who, name: g.name }))) return;
    const r = await window.api.transferOwner(g.id, id); if (!r.ok) notify(r.err);
    await refresh(); renderMembers();
  });
  if ($('mleave')) $('mleave').onclick = async () => {
    const to = owner && $('mleaveto') ? $('mleaveto').value : '';
    const next = owner ? (to ? nm(g.members.find((x) => x.id === to)) : txf('mem.next', 'admin tertua / anggota tertua')) : '';
    if (!await ask(owner ? txf('mem.leaveConfirmOwner', 'Keluar dari grup "{name}"?\n\nGrup dan riwayatnya dihapus dari perangkat ini.\nKepemilikan diserahkan ke: {next}.\nKamu hanya bisa masuk lagi kalau ditambahkan.', { name: g.name, next }) : txf('mem.leaveConfirm', 'Keluar dari grup "{name}"?\n\nGrup dan riwayatnya dihapus dari perangkat ini.\nKamu hanya bisa masuk lagi kalau ditambahkan.', { name: g.name }))) return;
    const r = await window.api.leaveGroup(g.id, to || undefined); if (!r.ok) return notify(r.err);
    $('mmodal').style.display = 'none'; memGid = null; if (cur === 'g:' + g.id) cur = 'public'; await refresh();
  };
  if ($('mgphoto')) $('mgphoto').onclick = () => $('gfile').click(); // memilih gambar: lihat $('gfile').onchange
  if ($('mgrm')) $('mgrm').onclick = async () => {
    if (!await ask(txf('mem.rmPhotoConfirm', 'Hapus foto grup ini? Berlaku untuk semua anggota.'))) return;
    const r = await window.api.setGroupAvatar(g.id, ''); if (!r.ok) notify(r.err);
    await refresh(); renderMembers();
  };
  if ($('mrenok')) $('mrenok').onclick = async () => {
    const r = await window.api.renameGroup(g.id, $('mrename').value); if (!r.ok) return notify(r.err);
    await refresh(); renderMembers();
  };
  if ($('mdisband')) $('mdisband').onclick = async () => {
    if (!await ask(txf('mem.disbandConfirm', 'Bubarkan grup "{name}"?\n\nGrup dan semua pesannya dihapus dari SEMUA anggota. Tidak bisa dibatalkan.', { name: g.name }))) return;
    const r = await window.api.disbandGroup(g.id); if (!r.ok) return notify(r.err);
    $('mmodal').style.display = 'none'; memGid = null; await refresh();
  };
  if ($('maddok')) $('maddok').onclick = async () => {
    const ids = [...document.querySelectorAll('#mbody input:checked')].map((c) => c.value);
    if (!ids.length) return notify(txf('mem.pickPeer', 'Pilih minimal 1 peer'));
    const r = await window.api.addMembers(g.id, ids); if (!r.ok) notify(r.err);
    await refresh(); renderMembers();
  };
}
// Foto grup: dikecilkan di renderer (archne-avatar.js, sama dengan foto profil) lalu Core memeriksanya lagi dan menyebarkannya sebagai state grup.
$('gfile').onchange = async () => {
  const f = $('gfile').files && $('gfile').files[0]; $('gfile').value = '';
  if (!f || !memGid) return;
  try {
    const r = await window.api.setGroupAvatar(memGid, await Avatar.fromFile(f));
    if (r && r.ok === false) notify(r.err || txf('mem.avSaveFail', 'Gagal menyimpan foto grup'));
  } catch (e) { notify((e && e.message) || txf('profile.photoProcFail', 'Gagal memproses gambar')); }
  await refresh(); renderMembers();
};
function openMembers(gid) { memGid = gid; renderMembers(); $('mmodal').style.display = 'flex'; }
$('mclose').onclick = () => { $('mmodal').style.display = 'none'; memGid = null; };
// Kemajuan: perbarui batang dan teks langsung di DOM, tanpa merender ulang seluruh chat.
window.api.onProgress((p) => {
  const key = p.job ? 'j:' + p.job : p.id;
  if (p.phase === 'download' || p.phase === 'unpack' || p.phase === 'pack') prog[key] = { phase: p.phase, done: p.done, total: p.total }; else delete prog[key];
  const bar = document.querySelector(`[data-bar="${CSS.escape(key)}"]`), txt = document.querySelector(`[data-bartxt="${CSS.escape(key)}"]`);
  if (bar) bar.style.width = FileCard.pct(p.done, p.total) + '%';
  if (txt) txt.textContent = FileCard.progressText(p.phase, p.done, p.total);
});
// Kirim berkas: tombol 📎 atau seret-lepas ke area chat. Tiap berkas satu pekerjaan; kemajuannya tampil sebagai gelembung di chat.
let jobN = 0;
async function sendPaths(paths) {
  const to = cur;
  for (const src of paths) {
    const job = 'j' + Date.now().toString(36) + (jobN++);
    let media; // foto: thumbnail kecil ikut tawaran (renderer/archne-media.js). Gagal/bukan foto = berkas dikirim biasa.
    try { media = (await Media.forSend(src, to, window.api)) || undefined; } catch (e) { media = undefined; }
    window.api.sendFile(job, src, to, media).then(async (r) => {
      await refresh();
      if (!r.ok && r.code !== 'abort' && !(S.sending || []).some((j) => j.job === job)) toast(r.err || txf('file.sendFail', 'Gagal mengirim berkas'));
    });
  }
  await refresh();
}
$('attbtn').onclick = async () => { const ps = await window.api.pickFiles(); if (ps.length) sendPaths(ps); };
let dragN = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
$('main').addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragN++; $('main').classList.add('drag'); } });
$('main').addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
$('main').addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) $('main').classList.remove('drag'); });
$('main').addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragN = 0; $('main').classList.remove('drag');
  const ps = [...e.dataTransfer.files].map((f) => window.api.pathOf(f)).filter(Boolean);
  if (ps.length) sendPaths(ps); else toast(txf('file.dropFail', 'Tidak bisa membaca lokasi berkas yang diseret'));
});
$('myaddr').onclick = async () => {
  const txt = ((S.me.addrs || []).map((a) => a.addr)).join(', '); if (!txt) return;
  if (await copyText(txt)) toast(txf('addr.copied', 'Alamat disalin: {addr}. Kirim ke temanmu, lalu tempel di kolom bawah sidebar miliknya.', { addr: txt }), true);
  else toast(txf('addr.manual', 'Alamatmu: {addr} (salin manual)', { addr: txt }), true);
};
