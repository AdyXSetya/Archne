function render() {
  const bl = blockedIds();
  if (cur.startsWith('g:') && !S.groups.some((g) => 'g:' + g.id === cur)) cur = 'public'; // grup sudah dihapus (dikeluarkan atau dibubarkan)
  if (cur !== 'public' && !cur.startsWith('g:') && bl.has(cur)) cur = 'public'; // chat dengan orang yang baru kublokir ditutup
  if (memGid && !S.groups.some((g) => g.id === memGid)) { $('mmodal').style.display = 'none'; memGid = null; }
  if (typeof voiceBtnSync === 'function') voiceBtnSync();
  $('myid').textContent = '#' + String(S.me.id || '').slice(0, 6) + ' · port ' + (S.me.port || '');
  $('myid').title = txf('me.fullId', 'ID lengkap: {id}', { id: S.me.id || '' });
  const ad = (S.me.addrs || []);
  $('myaddr').textContent = ad.length ? '📋 ' + ad[0].addr + (ad.length > 1 ? ' +' + (ad.length - 1) : '') : '';
  $('meav').innerHTML = avHtml(S.me.id || '0', 'md');
  $('myname').textContent = S.me.name || '';
  const peers = [...S.peers].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  // Kiri: tiga tab (Publik, Grup, Teman); hanya daftar tab yang aktif yang tampil, jadi tidak perlu scroll panjang.
  // Kanan: daftar orang menurut chat yang dibuka (publik = semua user, grup = anggota, DM = tidak ada).
  if (!emptyTab) tab = tabOf(cur);
  if (cur.startsWith('g:')) last.grup = cur; else if (cur !== 'public') last.teman = cur;
  const sum = (f) => Object.entries(unread).reduce((n, [k, v]) => n + (v && f(k) ? v : 0), 0);
  const tabs = [['public', IC.globe, txf('tab.public', 'Publik'), unread.public || 0], ['grup', IC.users, txf('tab.groups', 'Grup'), sum((k) => k.startsWith('g:'))], ['teman', IC.chat, txf('tab.friends', 'Teman'), sum((k) => k !== 'public' && !k.startsWith('g:')) + S.peers.filter((p) => p.fst === 'in').length], ['calls', IC.phone, txf('tab.calls', 'Panggilan'), tab === 'calls' ? 0 : missedCalls()]];
  $('tabs').innerHTML = tabs.map(([k, ic, l, n]) => `<div class="tab ${tab === k ? 'sel' : ''}" data-tab="${k}" role="tab" tabindex="0">${ic}<span>${l}</span>${n ? `<span class="badge">${n}</span>` : ''}</div>`).join('');
  $('newgrp').style.display = tab === 'grup' ? '' : 'none';
  if (tab === 'calls') markCallsSeen();
  $('clrcalls').style.display = tab === 'calls' && (S.calls || []).length ? 'block' : 'none';
  // pratinjau pesan terakhir tiap chat
  const lastBy = {};
  for (const m of S.messages) { if (m.sys) continue; const k = m.to === 'public' ? 'public' : String(m.to).startsWith('g:') ? m.to : (m.from === S.me.id ? m.to : m.from); if (!lastBy[k] || m.ts >= lastBy[k].ts) lastBy[k] = m; }
  for (const r of S.calls || []) for (const k of (r.group ? (r.members || []).map((x) => x.id) : [r.peer])) { if (!callInChat(r, k)) continue; if (!lastBy[k] || r.at >= lastBy[k].ts) lastBy[k] = { ts: r.at, from: r.dir === 'out' ? S.me.id : k, call: icn('phone') + esc(LC.callLabel(r).short) }; }
  // pratinjau berupa HTML yang sudah di-escape: ikon svg kecil untuk berkas/suara/panggilan, bukan emoji (teks pesan tersimpan tetap)
  const prevOf = (k, withName) => { const m = lastBy[k]; if (!m) return ''; if (m.call) return m.call; const t = m.file ? (m.file.x && m.file.x.k === 'vc' ? icn('mic') + txf('voicenote.title', 'Pesan suara') : icn('clip') + esc(String(m.file.name || txf('prev.file', 'Berkas')))) : esc(lnkShort(String(m.text || '')).replace(/\s+/g, ' ').slice(0, 70)); return (m.from === S.me.id ? txf('chat.you', 'Kamu') + ': ' : withName ? esc(String(m.name || '?').split('#')[0]) + ': ' : '') + t; };
  const whenOf = (k) => (lastBy[k] ? shortWhen(lastBy[k].ts) : '');
  const rowH = (id, av, name, pv, note, extra) => `<div class="item ${cur === id ? 'sel' : ''}" data-id="${id}"${note ? ' data-prof="1"' : ''} tabindex="0">${av}<div class="ib"><div class="r1"><span class="nm">${name}${typeof pgNewMark === 'function' ? pgNewMark(id) : ''}</span><span class="tm">${whenOf(id)}</span></div><div class="r2"><span class="pv">${pv}</span>${unread[id] ? `<span class="badge">${unread[id]}</span>` : ''}</div></div></div>`;
  let h = '';
  if (tab === 'public') h = rowH('public', `<div class="av md pub">${IC.globe}</div>`, txf('list.public', 'Obrolan publik'), prevOf('public', true) || txf('list.publicSub', 'Semua orang di jaringan'));
  else if (tab === 'grup') {
    h = S.groups.map((g) => rowH('g:' + g.id, gavHtml(g, 'md'), esc(g.name), prevOf('g:' + g.id, true) || tnf('grp.members', g.members.length, '{count} anggota', { count: g.members.length }))).join('');
    if (!h) h = '<div class="empty">' + txf('list.noGroups', 'Belum ada grup. Buat grup baru dengan tombol di atas.') + '</div>';
  } else if (tab === 'calls') {
    h = (S.calls || []).map(callRowH).join('') || '<div class="empty">' + txf('list.noCalls', 'Belum ada panggilan. Buka chat temanmu lalu ketuk ikon telepon.') + '</div>';
  } else {
    const { friends, incoming, outgoing, others } = dmLists();
    // permintaan masuk/terkirim: klik membuka profil (di sana Terima/Tolak/Batalkan), bukan chat
    const row = (p, note) => rowH(p.id, `<span class="avw">${avHtml(p.id, 'md')}<span class="dot ${p.online ? 'on' : ''}"></span></span>`, esc(tag(p.name, p.id)), note || prevOf(p.id) || (p.online ? txf('peer.online', 'Online') : txf('peer.offline', 'Offline')), note);
    h = friends.map((p) => row(p)).join('')
      + (incoming.length ? '<div class="sect">' + txf('list.reqIn', 'Permintaan teman') + '</div>' + incoming.map((p) => row(p, txf('list.wantsFriend', 'Ingin berteman'))).join('') : '')
      + (outgoing.length ? '<div class="sect">' + txf('list.reqOut', 'Menunggu persetujuan') + '</div>' + outgoing.map((p) => row(p, txf('list.waiting', 'Menunggu'))).join('') : '')
      + (others.length ? '<div class="sect">' + txf('list.others', 'Obrolan lain') + '</div>' + others.map((p) => row(p)).join('') : '');
    if (!h) h = '<div class="empty">' + txf('list.noFriends', 'Belum ada teman. Buka profil seseorang lalu ketuk Tambah teman. Dia perlu menyetujui dulu.') + '</div>';
  }
  $('list').innerHTML = h;

  const peer = S.peers.find((p) => p.id === cur);
  const grp = S.groups.find((g) => 'g:' + g.id === cur);
  const showUsers = cur === 'public' || !!grp; // DM: tidak ada panel kanan
  $('users').style.display = showUsers ? 'flex' : 'none';
  if (showUsers) {
    // Tanpa baris diri sendiri; dikelompokkan: (Grup) Pemilik, Admin, lalu Teman dan Tidak dikenal. Bagian kosong disembunyikan.
    const byName = (x, y) => (y.online - x.online) || String(x.name).localeCompare(String(y.name));
    const rows = (cur === 'public' ? peers.map((p) => ({ id: p.id, name: p.name, online: !!p.online }))
      : grp.members.filter((x) => x.id !== S.me.id && !bl.has(x.id)).map((x) => { const p = S.peers.find((q) => q.id === x.id); return { id: x.id, name: p ? p.name : x.name, online: !!(p && p.online) }; }))
      .map((r) => Object.assign(r, { creator: !!grp && r.id === grp.creator, admin: !!grp && r.id !== grp.creator && (grp.admins || []).includes(r.id), friend: isFriendId(r.id) })).sort(byName);
    const q = $('usearch').value, shown = rows.filter((r) => matchUser(r.name, r.id, q));
    const uLabel = cur === 'public' ? txf('users.all', 'Semua user') : txf('users.groupMembers', 'Anggota grup'), uOn = rows.filter((r) => r.online).length;
    $('uhead').textContent = q.trim() ? txf('users.headMatch', '{label} · {on}/{total} online · cocok {n}', { label: uLabel, on: uOn, total: rows.length, n: shown.length }) : txf('users.head', '{label} · {on}/{total} online', { label: uLabel, on: uOn, total: rows.length });
    const urow = (r) => `<div class="urow" data-uid="${r.id}" title="${txf('users.rowTitle', 'Klik untuk melihat profil')}"><span class="dot ${r.online ? 'on' : ''}"></span>${avHtml(r.id, true)}<div class="uc"><div class="nm" style="color:${color(r.id || '0')}"><span class="nt">${esc(r.name || '?')}<span class="tg"> #${(r.id || '').slice(0, 6)}</span></span>${badgesOf(r.id, grp)}</div><div class="bs">${esc(bioOf(r.id))}</div></div></div>`;
    const secs = [['Pemilik', txf('badge.owner', 'Pemilik'), shown.filter((r) => r.creator)], ['Admin', txf('badge.admin', 'Admin'), shown.filter((r) => r.admin)], ['Teman', txf('badge.friend', 'Teman'), shown.filter((r) => !r.creator && !r.admin && r.friend)], ['Tidak dikenal', txf('users.unknown', 'Tidak dikenal'), shown.filter((r) => !r.creator && !r.admin && !r.friend)]]; // x[0] = penanda tetap (data-usec), x[1] = label tampil
    $('ulist').innerHTML = !shown.length ? `<div class="empty">${q.trim() ? txf('users.noMatch', 'Tidak ada yang cocok dengan "{q}".', { q: esc(q.trim()) }) : txf('users.empty', 'Belum ada orang lain di sini.')}</div>`
      : secs.filter((x) => x[2].length).map((x) => `<div class="usec" data-usec="${x[0]}">${x[1]} · ${x[2].length}</div>` + x[2].map(urow).join('')).join('');
  }
  const nm = (id) => id === S.me.id ? txf('chat.you', 'Kamu') : (S.peers.find((p) => p.id === id) || { name: (grp.members.find((x) => x.id === id) || {}).name || '?' }).name;
  let hav, ttl, sub;
  if (cur === 'public') { hav = `<div class="av md pub">${IC.globe}</div>`; ttl = txf('list.public', 'Obrolan publik'); const onN = peers.filter((p) => p.online).length + 1; sub = tnf('head.online', onN, '{count} orang online', { count: onN }); }
  else if (grp) { hav = gavHtml(grp, 'md'); ttl = esc(grp.name); sub = tnf('grp.members', grp.members.length, '{count} anggota', { count: grp.members.length }) + ' · #' + grp.id.slice(0, 6) + ' · <span title="' + txf('enc.e2e', 'Terenkripsi end-to-end') + '" role="img" aria-label="' + txf('enc.aria', 'Terenkripsi') + '">' + icn('lock') + '</span>'; }
  else {
    hav = avHtml(cur, 'md');
    ttl = '<span class="plink" data-uid="' + esc(cur) + '" title="' + txf('common.viewProfile', 'Lihat profil') + '">' + esc(peer ? tag(peer.name, peer.id) : cur) + '</span>';
    sub = !peer ? '' : (peer.online ? txf('peer.online', 'Online') : txf('peer.offlineHeld', 'Offline, pesan ditahan')) + (peer.secure ? ' · <span title="' + txf('enc.e2e', 'Terenkripsi end-to-end') + '" role="img" aria-label="' + txf('enc.aria', 'Terenkripsi') + '">' + icn('lock') + '</span>' : ' · <span title="' + txf('enc.oldTitle', 'Versi lama, belum terenkripsi') + '" role="img" aria-label="' + txf('enc.oldAria', 'Belum terenkripsi') + '">' + icn('warn', 'warn') + ' ' + txf('enc.oldTag', 'versi lama') + '</span>');
  }
  const hb = (id, ic, t) => `<button id="${id}" type="button" class="ibtn" title="${t}" aria-label="${t}">${ic}</button>`;
  $('head').innerHTML = hb('sidebtn', IC.back, txf('head.back', 'Kembali ke daftar chat')) + `<div class="hav">${hav}</div><div class="hti"><div class="ttl">${ttl}</div><div class="sub">${sub}</div></div>`
    + (grp ? hb('membtn', IC.users, txf('head.members', 'Anggota ({count})', { count: grp.members.length })) : '') + (cur === 'public' ? hb('usersbtn', IC.users, txf('head.people', 'Orang di jaringan')) : '')
    + (callCtl && peer && !grp && cur !== 'public' ? hb('callbtn', IC.phone, callBusy() ? txf('call.inCall', 'Sedang dalam panggilan') : txf('call.voiceAria', 'Panggilan suara')).replace('class="ibtn"', callBusy() ? 'class="ibtn off"' : 'class="ibtn"') : '')
    + (callCtl && peer && !grp && cur !== 'public' ? hb('vcallbtn', IC.video, callBusy() ? txf('call.inCall', 'Sedang dalam panggilan') : txf('call.video', 'Panggilan video')).replace('class="ibtn"', callBusy() ? 'class="ibtn off"' : 'class="ibtn"') : '')
    + hb('morebtn', IC.more, txf('head.more', 'Menu lainnya'))
    + '<div id="hmenu">'
    + (S.canNotify ? '<button id="bellbtn" type="button" class="mi" title="' + (notifyOn(cur) ? txf('head.notifOnTitle', 'Notifikasi chat ini menyala. Ketuk untuk membisukan.') : txf('head.notifOffTitle', 'Chat ini dibisukan. Ketuk untuk menyalakan notifikasi.')) + '">' + (notifyOn(cur) ? IC.bell : IC.bellOff) + '<span>' + (notifyOn(cur) ? txf('head.mute', 'Bisukan notifikasi') : txf('head.unmute', 'Nyalakan notifikasi')) + '</span></button>' : '')
    + (typeof DxCard !== 'undefined' && peer && !grp && cur !== 'public' && (S.canDirect || S.canDirectCopy) ? (() => { const g = DxCard.sendGate(peer), c = g.ok ? 'mi' : 'mi off', one = (id, t) => '<button id="' + id + '" type="button" class="' + c + '" title="' + esc(g.title) + '">' + IC.dx + '<span>' + t + '</span></button>'; return one('dxfilebtn', txf('dx.sendFile', 'Kirim berkas…')) + (S.canDirect ? one('dxfolderbtn', txf('dx.sendFolder', 'Kirim folder…')) : ''); })() : '')
    + (typeof DxCard !== 'undefined' ? '<button id="dxlistbtn" type="button" class="mi" title="' + txf('dx.listTitle', 'Daftar transfer Kirim Langsung') + '">' + IC.dx + '<span>' + txf('dx.transfers', 'Transfer berkas') + '</span></button>' : '')
    + (S.canOpenFolder === false ? '' : '<button id="dlbtn" type="button" class="mi" title="' + esc(txf('head.dlTitle', 'Buka folder unduhan: {dir}', { dir: S.downloadDir || '' })) + '">' + IC.dl + '<span>' + txf('head.dlFolder', 'Folder unduhan') + '</span></button>')
    + (S.canNotify ? '<button id="battbtn" type="button" class="mi" title="' + txf('head.battTitle', 'Minta Android agar Archne tidak dihentikan saat layar mati') + '">' + IC.bolt + '<span>' + txf('head.battLabel', 'Jaga tetap aktif') + '</span></button>' : '')
    + '<button id="sembtn" type="button" class="mi" title="' + txf('head.semTitle', 'Tulis pengumuman atau catatan yang disematkan di chat ini') + '">' + IC.pin + '<span>' + txf('head.semLabel', 'Tulis sematan') + '</span></button>'
    + '<button id="clrbtn" type="button" class="mi dng" title="' + txf('head.clrTitle', 'Hapus semua pesan di chat ini, hanya dari perangkatmu') + '">' + IC.trash + '<span>' + txf('head.clrLabel', 'Bersihkan chat') + '</span></button></div>';
  renderVc(grp);
  renderPv();
  renderSem();
  if ($('callbtn')) $('callbtn').onclick = () => dial(peer);
  if ($('vcallbtn')) $('vcallbtn').onclick = () => dial(peer, true);
  if ($('bellbtn')) $('bellbtn').onclick = async () => {
    const key = cur, now = notifyOn(key), r = await window.api.setNotify(key, !now);
    if (r && r.ok === false) return toast(r.err || txf('head.notifFail', 'Gagal mengubah notifikasi'));
    toast(now ? txf('head.notifOff', 'Notifikasi chat ini dimatikan') : txf('head.notifOn', 'Notifikasi chat ini dinyalakan'), true);
    await refresh();
  };
  if ($('dxlistbtn')) $('dxlistbtn').onclick = () => dxShow();
  const dxPickTo = (kind) => { const g = DxCard.sendGate(peer); if (!g.ok) return toast(g.title); dxSendRun(kind, peer.id); };
  if ($('dxfilebtn')) $('dxfilebtn').onclick = () => dxPickTo('files');
  if ($('dxfolderbtn')) $('dxfolderbtn').onclick = () => dxPickTo('folder');
  if (typeof dxBadge === 'function') dxBadge();
  if ($('battbtn')) $('battbtn').onclick = () => { try { if (window.parent && window.parent !== window) window.parent.postMessage({ archne: 'native', action: 'battery' }, '*'); } catch (x) {} };
  if ($('dlbtn')) $('dlbtn').onclick = async () => { const r = await window.api.openDownloads(); if (r && r.ok === false) toast(r.err || txf('head.dlFail', 'Tidak bisa membuka folder unduhan')); };
  if ($('membtn')) $('membtn').onclick = () => openMembers(grp.id);
  if ($('sembtn')) $('sembtn').onclick = () => { closeDrawers(); semOpen({ mode: 'note' }); };
  $('clrbtn').onclick = async () => {
    if (!await ask(txf('head.clrConfirm', 'Bersihkan semua pesan di chat ini?\nHanya hilang dari perangkatmu; anggota lain tetap melihat pesannya.'))) return;
    const r = await window.api.clearChat(cur); if (!r.ok) notify(r.err);
    await refresh();
  };
  const msgView = S.messages.filter((m) => cur === 'public' ? m.to === 'public' : cur.startsWith('g:') ? m.to === cur : !m.to.startsWith('g:') && m.to !== 'public' && (m.from === cur || m.to === cur));
  // Panggilan dengan lawan chat ini tampil di antara pesan menurut waktu mulainya (seperti WhatsApp); hanya di chat privat.
  const callView = (cur === 'public' || grp) ? [] : (S.calls || []).filter((r) => callInChat(r, cur)).map((r) => ({ call: r, id: 'c:' + r.id, ts: r.at }));
  const semDone = new Set(semRows().map((r) => r.mid).filter(Boolean));
  const view = callView.length ? msgView.concat(callView).sort((a, b) => a.ts - b.ts) : msgView;
  const box = $('msgs'), stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.classList.toggle('dm', cur !== 'public' && !grp);
  let lastDay = '', pv = null;
  box.innerHTML = view.map((m) => {
    const dk = dayKey(m.ts); let sep = '';
    if (dk !== lastDay) { lastDay = dk; sep = `<div class="day"><span>${dayLabel(m.ts)}</span></div>`; }
    if (m.call) { pv = null; return sep + callBubbleH(m.call); }
    if (m.sys) { pv = null; return sep + `<div class="sys">${esc(m.text)} · ${hm(m.ts)}</div>`; }
    const mine = m.from === S.me.id;
    const cont = !!pv && !sep && pv.from === m.from && m.ts - pv.ts < 300000; pv = m;
    // Status kirim: centang = sampai, jam = menunggu (grup: berapa penerima yang sudah). Ikon + title, bukan huruf.
    const stOk = mine && (m.gs ? m.gs.done === m.gs.total : m.status === 'delivered');
    const st = !mine ? '' : m.gs ? (stOk ? icn('check') : icn('clock') + ` ${m.gs.done}/${m.gs.total}`) : m.status ? (stOk ? icn('check') : icn('clock')) : '';
    const stT = stOk ? txf('msg.delivered', 'Terkirim') : m.gs ? txf('msg.deliveredTo', 'Terkirim ke {done} dari {total}', { done: m.gs.done, total: m.gs.total }) : txf('msg.pending', 'Menunggu diterima');
    const rq = !m.reply ? '' : m.reply.gone ? '<div class="rq gone"><div class="rt">' + icn('reply') + ' ' + txf('msg.replyGone', 'Pesan asli sudah tidak ada') + '</div></div>'
      : `<div class="rq" data-goto="${esc(m.reply.id)}" title="${txf('msg.replyJump', 'Lompat ke pesan asli')}"><div class="rn" style="color:${color(m.reply.from)}">${esc(m.reply.from === S.me.id ? txf('chat.you', 'Kamu') : tag(m.reply.name, m.reply.from))}</div><div class="rt">${esc(lnkShort(m.reply.text))}</div></div>`;
    return sep + `<div class="m ${mine ? 'me' : ''}${cont ? ' cont' : ''}${m.rx && m.rx.length ? ' hasrx' : ''}${flashId === m.id && Date.now() < flashUntil ? ' flash' : ''}" data-mid="${m.id}"><div class="who lk" data-uid="${esc(m.from)}" title="${txf('common.viewProfile', 'Lihat profil')}" style="color:${color(m.from)}">${esc(tag(m.name, m.from))}${mine ? '' : badgesOf(m.from, grp)}</div>${rq}${m.file ? FileCard.cardHtml(m, prog, { senderOnline: (S.peers.find((p) => p.id === m.from) || {}).online }) : bodyHtml(m)}${rxH(m)}<div class="t">${hm(m.ts)}${st ? `<span class="st${stOk ? ' ok' : ''}" title="${stT}" role="img" aria-label="${stT}">${st}</span>` : ''}${typeof rxOk === 'function' && rxOk(m) ? `<button type="button" class="mmore mmreact" data-menu="${m.id}" title="${txf('msg.react', 'Beri reaksi')}" aria-label="${txf('msg.react', 'Beri reaksi')}" aria-haspopup="menu">${IC.smile}</button>` : ''}<button type="button" class="mmore" data-menu="${m.id}" title="${txf('mmenu.aria', 'Aksi pesan')}" aria-label="${txf('mmenu.aria', 'Aksi pesan')}" aria-haspopup="menu">${IC.more}</button></div></div>`;
  }).join('') + FileCard.jobsFor(S.sending, cur).map((j) => `<div class="m me">${FileCard.jobHtml(j, prog)}</div>`).join('');
  if (stick) box.scrollTop = box.scrollHeight;
  renderProfile();
  if (typeof mmSync === 'function') mmSync();
  if (typeof inlineSync === 'function') inlineSync(); // pemutar di gelembung: pasang kembali elemen media ke kartu yang baru digambar
}

const bodyCl = () => (document.body && document.body.classList) || null;
const closeDrawers = () => { const b = bodyCl(); if (b) { b.remove('usersopen'); b.remove('menuopen'); } };
const narrow = () => !!(window.matchMedia && window.matchMedia('(max-width:760px)').matches);
// Layar sempit: daftar chat jadi layar awal; membuka chat memunculkan layar chat. Tombol kembali (juga tombol Kembali Android) menutupnya.
const leaveChat = () => { const b = bodyCl(); if (b) { b.remove('inchat'); b.remove('usersopen'); b.remove('menuopen'); } };
const enterChat = () => { const b = bodyCl(); if (!b || b.contains('inchat')) return; b.add('inchat'); try { if (narrow() && window.history) window.history.pushState({ lc: 1 }, ''); } catch (x) {} };
if (window.addEventListener) window.addEventListener('popstate', () => { if (typeof voiceOpen === 'function' && voiceOpen()) { voicePop(); return; } if (typeof cameraOpen === 'function' && cameraOpen()) { cameraPop(); return; } if (typeof playerModal === 'function' && playerModal()) { playerPop(); return; } if (typeof imgvOpen === 'function' && imgvOpen()) { imgvPop(); return; } leaveChat(); }); // penampil foto terbuka: Kembali menutupnya dulu (js/archne-imgview.js)
if (document.addEventListener) document.addEventListener('click', (e) => { const b = bodyCl(); if (b && b.contains && b.contains('menuopen') && !(e.target.closest && e.target.closest('#morebtn'))) b.remove('menuopen'); });
if ($('scrim')) $('scrim').onclick = closeDrawers;
// Notifikasi: bawaan publik mati, DM dan grup menyala; S.notif[kunci] (true/false) menimpanya.
const notifyOn = (key) => (S.notif && typeof S.notif[key] === 'boolean' ? S.notif[key] : key !== 'public');
const pickChat = (id) => { closeDrawers(); enterChat(); if (id !== cur) { $('usearch').value = ''; setReply(null); } cur = id; emptyTab = false; unread[cur] = 0; render(); };
$('list').onclick = (e) => {
  const cb = e.target.closest && e.target.closest('[data-callback]');
  if (cb) { dial(S.peers.find((p) => p.id === cb.dataset.callback)); return; } // telepon balik dari tab Panggilan
  const el = e.target.closest && e.target.closest('.item'); if (!el) return;
  if (el.dataset.cpeer) { closeDrawers(); enterChat(); if (el.dataset.cpeer !== cur) { $('usearch').value = ''; setReply(null); } cur = el.dataset.cpeer; unread[cur] = 0; emptyTab = true; tab = 'calls'; render(); return; } // buka chatnya, tab tetap Panggilan
  if (el.dataset.prof) { profId = el.dataset.id; renderProfile(); return; } // permintaan teman: buka profil
  pickChat(el.dataset.id);
};
$('usearch').oninput = () => render();
$('usearch').onkeydown = (e) => { if (e.key === 'Escape' && $('usearch').value) { $('usearch').value = ''; render(); } };
// Klik nama (di chat atau judul chat privat) membuka profilnya, tanpa perlu mencari di daftar.
$('head').onclick = (e) => {
  if (e.target.closest && e.target.closest('#sidebtn')) { if (window.history && window.history.state && window.history.state.lc) window.history.back(); else leaveChat(); return; }
  if (e.target.closest && e.target.closest('#usersbtn')) { const b = bodyCl(); if (b) { b.remove('menuopen'); b.contains('usersopen') ? b.remove('usersopen') : b.add('usersopen'); } return; }
  if (e.target.closest && e.target.closest('#morebtn')) { const b = bodyCl(); if (b) b.contains('menuopen') ? b.remove('menuopen') : b.add('menuopen'); return; }
  if (e.target.closest && e.target.closest('.hti') && !e.target.closest('[data-uid]')) { const g = S.groups.find((x) => 'g:' + x.id === cur); if (g) { openMembers(g.id); return; } }
  const u = e.target.closest && e.target.closest('[data-uid]'); if (u) { profId = u.dataset.uid; renderProfile(); } };
$('tabs').onclick = (e) => {
  const el = e.target.closest && e.target.closest('[data-tab]'); if (!el) return;
  const t = el.dataset.tab;
  const bc = bodyCl();
  if (narrow() && bc && !bc.contains('inchat')) { tab = t; emptyTab = true; render(); return; } // HP: tab hanya mengganti daftar
  if (t === 'calls') { tab = 'calls'; emptyTab = true; render(); return; }
  if (t === 'public') return pickChat('public');
  const pool = t === 'grup' ? S.groups.map((g) => 'g:' + g.id) : (() => { const d = dmLists(); return d.friends.concat(d.others, d.incoming, d.outgoing).map((p) => p.id); })();
  const pick = pool.includes(last[t]) ? last[t] : pool[0];
  if (pick) return pickChat(pick);
  tab = t; emptyTab = true; render(); // belum ada isinya: tab tetap terbuka dengan petunjuk
};
if ($('uclose')) $('uclose').onclick = closeDrawers;
if ($('clrcalls')) $('clrcalls').onclick = async () => {
  if (!await ask(txf('calls.clearConfirm', 'Hapus semua riwayat panggilan?\nHanya hilang dari perangkatmu.'))) return;
  const r = await window.api.clearCalls(); if (r && r.ok === false) toast(r.err || txf('calls.clearFail', 'Gagal menghapus riwayat'));
  await refresh();
};
$('meav').onclick = () => { profId = S.me.id; renderProfile(); };
$('myname').onclick = $('meav').onclick; // nama di sidebar hanya tampilan: ubah nama lewat profil (ikon pensil)
$('myname').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('meav').onclick(); } };
$('ulist').onclick = (e) => { // klik orang di panel kanan: buka profilnya
  const el = e.target.closest && e.target.closest('.urow'); if (!el) return;
  closeDrawers(); profId = el.dataset.uid; renderProfile();
};
