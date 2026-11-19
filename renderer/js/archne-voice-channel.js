// ---- Channel suara (v0.19.0): daftar channel di bawah header grup. Masuk = sesi audio lewat Controller panggilan (langkah 7); layarnya memakai ulang layar panggilan. ----
let vcFold = false;
try { vcFold = localStorage.getItem('lc.vcfold') === '1'; } catch (x) {}
function renderVc(grp) {
  const bar = $('vcbar');
  if (!grp) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const chs = grp.channels || [], mine = S.vc && S.vc.gid === grp.id ? S.vc.cid : null;
  const who = (c) => (c.here || []).map((x) => (x.me ? txf('chat.you', 'Kamu') : x.name || '?'));
  const row = (c) => {
    const here = who(c), inHere = c.id === mine;
    const btn = inHere ? `<button type="button" class="sec" data-vact="leave" data-cid="${c.id}">${esc(txf('vc.leave', 'Keluar'))}</button>`
      : c.canJoin ? `<button type="button"${callBusy() ? ' class="off" title="' + esc(txf('vc.busyTitle', 'Sedang dalam panggilan. Keluar dulu untuk masuk channel lain.')) + '"' : ''} data-vact="enter" data-cid="${c.id}">${esc(txf('vc.join', 'Masuk'))}</button>` : `<span class="tg" title="${esc(txf('vc.lockedTitle', 'Hanya yang diizinkan, admin, dan pemilik grup yang bisa masuk'))}">${esc(txf('vc.lockedTag', 'terkunci'))}</span>`;
    const mg = c.canManage ? `<button type="button" class="sec" data-vact="edit" data-cid="${c.id}" title="${esc(txf('vc.manageTitle', 'Kelola channel: nama, kunci, dan siapa yang boleh masuk'))}" aria-label="${esc(txf('vc.manageAria', 'Kelola channel'))}">${esc(txf('vc.manage', 'Kelola'))}</button><button type="button" class="dng" data-vact="del" data-cid="${c.id}" title="${esc(txf('vc.delTitle', 'Hapus channel'))}" aria-label="${esc(txf('vc.delTitle', 'Hapus channel'))}">${IC.trash}</button>` : '';
    return `<div class="vch${inHere ? ' in' : ''}" data-cid="${c.id}"><span class="ic">${c.locked ? IC.lock : IC.speaker}</span><div class="vc"><div class="vn">${esc(c.name)}</div><div class="vw${here.length ? ' on' : ''}">${here.length ? esc(here.join(', ')) : esc(txf('vc.empty', 'Kosong'))}</div></div>${btn}${mg}</div>`;
  };
  bar.className = vcFold ? 'vcfold' : '';
  bar.style.display = 'block';
  bar.innerHTML = `<div class="vch-h" data-vact="fold" role="button" tabindex="0" aria-expanded="${!vcFold}"><span class="chev">${IC.chev}</span><span class="vct">${esc(txf('vc.head', 'Channel suara · {count}', { count: chs.length }))}</span><button type="button" data-vact="new">${esc(txf('vc.newBtn', '+ Channel'))}</button></div>`
    + (chs.length ? chs.map(row).join('') : `<div class="vcnone">${esc(txf('vc.none', 'Belum ada channel. Buat satu supaya anggota bisa ngobrol suara kapan saja.'))}</div>`);
}
$('vcbar').onclick = async (e) => {
  const el = e.target.closest && e.target.closest('[data-vact]'); if (!el) return;
  const grp = S.groups.find((g) => 'g:' + g.id === cur); if (!grp) return;
  const act = el.dataset.vact, cid = el.dataset.cid;
  if (e.stopPropagation && act !== 'fold') e.stopPropagation();
  if (act === 'fold') { vcFold = !vcFold; try { localStorage.setItem('lc.vcfold', vcFold ? '1' : '0'); } catch (x) {} return render(); }
  if (act === 'new') return openVm(grp, null);
  const c = (grp.channels || []).find((x) => x.id === cid);
  let r;
  if (act === 'enter' && c && c.canJoin) {
    if (callBusy()) return toast(callBusyMsg()); // satu panggilan / channel pada satu waktu; pindah channel = keluar dulu
    if (!callCtl) return toast(txf('vc.noVoice', 'Perangkat ini belum mendukung suara. Channel butuh mikrofon dan WebRTC.')); // tanpa audio, hanya "hadir" tanpa bisa bicara/mendengar: menyesatkan
    r = await callCtl.enterChannel(grp.id, cid, c.name); // kegagalan sudah dilaporkan Controller lewat toast
    if (r && r.ok === false) return;
  } else if (act === 'leave') {
    if (callCtl && callCtl.cur && callCtl.cur.vc) { callCtl.hangup(); r = { ok: true }; } else r = await window.api.vcLeave();
  }
  else if (act === 'edit' && c && c.canManage) return openVm(grp, c);
  else if (act === 'del' && c && c.canManage) { if (!await ask(txf('vc.delConfirm', 'Hapus channel "{name}"? Channel hilang untuk semua anggota grup.', { name: c.name }))) return; r = await window.api.vcDelete(grp.id, cid); }
  else return;
  if (r && r.ok === false) toast(r.err || txf('common.failed', 'Gagal'));
  await refresh();
};
// Modal channel: dipakai untuk membuat (vmEdit = null) dan mengelola (vmEdit = id channel): nama, kunci, daftar izin per anggota.
let vmGid = null, vmEdit = null, vmAllow = new Set();
function renderVmAllow() {
  const g = S.groups.find((x) => x.id === vmGid); if (!g) return;
  const ch = vmEdit ? (g.channels || []).find((x) => x.id === vmEdit) : null, by = ch ? ch.by : S.me.id;
  const rows = (g.members || []).filter((m) => m.id !== by).map((m) => {
    const adm = m.id === g.creator || (g.admins || []).includes(m.id);
    const tag = adm ? `<span class="tg">${m.id === g.creator ? txf('vc.ownerAlways', 'pemilik: selalu bisa') : txf('vc.adminAlways', 'admin: selalu bisa')}</span>` : '';
    return `<label><input type="checkbox" data-id="${m.id}"${adm || vmAllow.has(m.id) ? ' checked' : ''}${adm ? ' disabled' : ''}> <span>${esc(m.name || m.id.slice(0, 6))}${m.id === S.me.id ? ' ' + txf('vc.youTag', '(kamu)') : ''}</span>${tag}</label>`;
  });
  $('vallow').innerHTML = rows.length ? rows.join('') : `<div class="vnone">${esc(txf('vc.noMembers', 'Belum ada anggota lain di grup ini.'))}</div>`;
}
function syncVm() { $('vallowbox').style.display = $('vlock').checked ? 'block' : 'none'; }
function openVm(grp, c) {
  vmGid = grp.id; vmEdit = c ? c.id : null; vmAllow = new Set(c ? c.allow : []);
  $('vtitle').textContent = c ? txf('vc.manageAria', 'Kelola channel') : txf('vc.titleNew', 'Channel suara baru'); $('vok').textContent = c ? txf('common.save', 'Simpan') : txf('common.create', 'Buat');
  $('vname').value = c ? c.name : ''; $('vlock').checked = !!(c && c.locked);
  renderVmAllow(); syncVm();
  $('vmodal').style.display = 'flex'; $('vname').focus();
}
$('vlock').onchange = syncVm;
$('vallow').onchange = (e) => { const t = e.target, id = t && t.dataset && t.dataset.id; if (!id) return; t.checked ? vmAllow.add(id) : vmAllow.delete(id); };
$('vcancel').onclick = () => { $('vmodal').style.display = 'none'; };
$('vok').onclick = async () => {
  const grp = S.groups.find((g) => g.id === vmGid); if (!grp) { $('vmodal').style.display = 'none'; return; }
  const name = $('vname').value.trim(); if (!name) return toast(txf('vc.needName', 'Isi nama channel'));
  const locked = $('vlock').checked;
  const ch = vmEdit ? (grp.channels || []).find((x) => x.id === vmEdit) : null;
  if (vmEdit && (!ch || !ch.canManage)) { $('vmodal').style.display = 'none'; toast(txf('vc.gone', 'Channel sudah tidak ada atau kamu tak lagi boleh mengelolanya')); return refresh(); }
  // hanya anggota saat ini; pembuat channel dan admin/pemilik grup selalu boleh masuk, jadi tidak perlu ada di daftar
  const by = ch ? ch.by : S.me.id, isAdm = (id) => id === grp.creator || (grp.admins || []).includes(id);
  const norm = (set) => (grp.members || []).map((m) => m.id).filter((id) => set.includes(id) && id !== by && !isAdm(id)); // hanya anggota saat ini; pembuat dan admin/pemilik grup selalu boleh masuk
  const allow = norm([...vmAllow]);
  let r;
  if (!ch) r = await window.api.vcCreate(grp.id, name, locked, allow);
  else {
    const was = norm(ch.allow);
    if (name === ch.name && locked === ch.locked && allow.length === was.length && allow.every((x) => was.includes(x))) { $('vmodal').style.display = 'none'; return; } // tidak ada yang berubah: jangan menaikkan versi
    r = await window.api.vcUpdate(grp.id, ch.id, { name, locked, allow });
  }
  if (r && r.ok === false) return toast(r.err || (ch ? txf('vc.saveFail', 'Gagal menyimpan channel') : txf('vc.createFail', 'Gagal membuat channel')));
  $('vmodal').style.display = 'none';
  await refresh();
};
