// ---- Sematan pesan (v0.20.0, pin5). Di UI disebut "Sematan" (bukan "Pin", supaya tidak tertukar dengan PIN 6 angka channel terkunci). ----
// Data dari state().pins[chat] = { shared, mine, canShare }. Strip di atas pesan: tinggi maksimum, scroll sendiri, header menempel, bisa dilipat (diingat di peramban).
// Dilipat = satu baris: jumlah + sematan terbaru. Bersama = dilihat semua di chat ini (grup: admin/pemilik yang memasang; DM: kedua orang); pribadi = hanya aku.
let semFold = true, semM = null, semV = null;
const SEM_LONG = 160; // lebih panjang dari ini (atau lebih dari 3 baris): tawarkan "Baca selengkapnya"
const semIsLong = (t) => t.length > SEM_LONG || t.split('\n').length > 3;
try { const v = localStorage.getItem('lc.semfold'); if (v !== null) semFold = v === '1'; } catch (x) {}
const semData = () => (S.pins && S.pins[cur]) || null;
function semRows() { // gabungan bersama + pribadi, terbaru di atas
  const d = semData(); if (!d) return [];
  return d.shared.concat(d.mine).sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? -1 : 1));
}
function semCanShare() { // Core yang menentukan; chat yang belum punya sematan dihitung dari state
  const d = semData(); if (d) return !!d.canShare;
  if (cur === 'public') return false;
  const g = S.groups.find((x) => 'g:' + x.id === cur);
  if (g) return g.creator === S.me.id || (g.admins || []).includes(S.me.id);
  return !!S.peers.find((p) => p.id === cur);
}
const semShareLabel = () => (cur.startsWith('g:') ? txf('sem.shareGroup', 'Untuk semua anggota') : txf('sem.shareDm', 'Untuk berdua'));
function renderSem() {
  const bar = $('sembar'), rows = semRows();
  if (!rows.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const row = (r) => {
    const mineP = r.by === S.me.id, who = r.kind === 'note' ? esc(txf('sem.note', 'Pengumuman')) : esc(r.from === S.me.id ? txf('chat.you', 'Kamu') : tag(r.name, r.from)) + ' · ' + hm(r.at);
    const badge = esc(!r.shared ? txf('sem.badgePriv', 'pribadi') : cur.startsWith('g:') ? txf('sem.badgeAll', 'semua anggota') : txf('sem.badgeTwo', 'berdua'));
    const by = r.shared && !mineP ? ' · ' + esc(txf('sem.pinnedBy', 'disematkan {name}', { name: nameOf(r.by) })) : r.shared && r.kind === 'note' ? ' · ' + esc(txf('sem.byYou', 'oleh kamu')) : '';
    return `<div class="sem" data-sid="${esc(r.id)}" data-sh="${r.shared ? 1 : 0}"><span class="ic">${IC.pin}</span><div class="sc"><div class="sw">${who} · <span class="tg">${badge}</span>${by}</div><div class="sx" data-sact="more" title="${esc(txf('sem.openTitle', 'Ketuk untuk membuka layar penuh'))}">${esc(r.text)}</div>${semIsLong(r.text) ? `<button type="button" class="lnk" data-sact="more">${esc(txf('sem.readMore', 'Baca selengkapnya'))}</button>` : ''}</div>`
      + (r.kind !== 'note' && r.mid ? `<button type="button" class="sec" data-sact="go" title="${esc(txf('sem.goTitle', 'Lompat ke pesan asli'))}" aria-label="${esc(txf('sem.goTitle', 'Lompat ke pesan asli'))}">${esc(txf('sem.go', 'Lompat'))}</button>` : '')
      + (r.canEdit ? `<button type="button" class="sec" data-sact="edit" title="${esc(txf('sem.editTitle', 'Ubah isi pengumuman'))}" aria-label="${esc(txf('sem.tEdit', 'Ubah sematan'))}">${esc(txf('sem.edit', 'Ubah'))}</button>` : '')
      + (r.canRemove ? `<button type="button" class="dng" data-sact="del" title="${esc(txf('sem.unpin', 'Lepas sematan'))}" aria-label="${esc(txf('sem.unpin', 'Lepas sematan'))}">${IC.trash}</button>` : '') + '</div>';
  };
  const latest = rows[0];
  bar.className = semFold ? 'vcfold' : '';
  bar.style.display = 'block';
  bar.innerHTML = `<div class="vch-h" data-sact="fold" role="button" tabindex="0" aria-expanded="${!semFold}"><span class="chev">${IC.chev}</span><span class="vct">${esc(txf('sem.head', 'Sematan · {count}', { count: rows.length }))}<span class="semlast"> · ${esc(latest.text.replace(/\s+/g, ' '))}</span></span><button type="button" data-sact="new">${esc(txf('sem.write', '+ Tulis'))}</button></div>` + rows.map(row).join('');
}
$('sembar').onclick = async (e) => {
  const el = e.target.closest && e.target.closest('[data-sact]'); if (!el) return;
  const act = el.dataset.sact;
  if (e.stopPropagation && act !== 'fold') e.stopPropagation();
  if (act === 'fold') { semFold = !semFold; try { localStorage.setItem('lc.semfold', semFold ? '1' : '0'); } catch (x) {} return renderSem(); }
  if (act === 'new') return semOpen({ mode: 'note' });
  const rowEl = e.target.closest && e.target.closest('[data-sid]'); if (!rowEl) return;
  const r = semRows().find((x) => x.id === rowEl.dataset.sid); if (!r) return;
  if (act === 'more') return semView(r);
  if (act === 'go') return semGo(r);
  if (act === 'edit' && r.canEdit) return semOpen({ mode: 'edit', pid: r.id, shared: r.shared, text: r.text });
  if (act === 'del' && r.canRemove) {
    if (r.shared && !await ask(txf('sem.unpinConfirm', 'Lepas sematan ini untuk semua orang di chat ini?'))) return;
    const res = await window.api.pinRemove(cur, r.id);
    if (res && res.ok === false) toast(res.err || txf('sem.unpinFail', 'Gagal melepas sematan'));
    await refresh();
  }
};
// Lompat hanya bila pesan aslinya masih ada di chat ini. Kalau sudah dibatalkan atau dibersihkan, sematan tetap lengkap: buka tampilan penuhnya.
function semGo(r) {
  if (S.messages.some((m) => m.id === r.mid)) return gotoMsg(r.mid);
  semView(r, true);
}
// Tampilan penuh (layar penuh, bisa di-scroll, tombol Tutup): isi salinan sematan, tidak bergantung pada pesan aslinya.
function semView(r, gone) {
  semV = r.id;
  const exists = !!r.mid && S.messages.some((m) => m.id === r.mid);
  const who = r.kind === 'note' ? txf('sem.note', 'Pengumuman') : (r.from === S.me.id ? txf('chat.you', 'Kamu') : tag(r.name, r.from)) + ' · ' + dayLabel(r.at) + ' ' + hm(r.at);
  const badge = !r.shared ? txf('sem.badgePriv', 'pribadi') : cur.startsWith('g:') ? txf('sem.badgeFullAll', 'untuk semua anggota') : txf('sem.badgeFullTwo', 'untuk berdua');
  $('semvt').textContent = who;
  $('semvt').title = who + ' · ' + badge;
  $('semvb').textContent = r.text; $('semvb').scrollTop = 0;
  $('semvn').style.display = gone && !exists ? 'block' : 'none';
  $('semvn').textContent = txf('sem.goneNote', 'Pesan aslinya sudah tidak ada di chat ini (dibatalkan atau dibersihkan). Sematan ini tetap tersimpan.');
  $('semvgo').style.display = exists ? 'inline-block' : 'none';
  $('semview').style.display = 'flex';
  $('semvb').focus();
}
function semViewClose() { semV = null; $('semview').style.display = 'none'; }
$('semvx').onclick = semViewClose; $('semvx2').onclick = semViewClose;
$('semvgo').onclick = () => { const r = semRows().find((x) => x.id === semV); semViewClose(); if (r && r.mid) gotoMsg(r.mid); };
if (document.addEventListener) document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && semV) semViewClose(); });
function semPinMsg(mid) {
  const m = S.messages.find((x) => x.id === mid); if (!m) return;
  if (semRows().some((r) => r.mid === mid)) { semFold = false; try { localStorage.setItem('lc.semfold', '0'); } catch (x) {} renderSem(); return toast(txf('sem.already', 'Pesan ini sudah disematkan'), true); }
  semOpen({ mode: 'msg', mid, text: m.file ? '📎 ' + m.file.name : m.text });
}
function semOpen(o) {
  const can = semCanShare();
  semM = Object.assign({ scope: cur }, o);
  $('semtitle').textContent = o.mode === 'msg' ? txf('sem.tMsg', 'Sematkan pesan') : o.mode === 'edit' ? txf('sem.tEdit', 'Ubah sematan') : txf('sem.tNote', 'Tulis sematan');
  $('semprev').style.display = o.mode === 'msg' ? 'block' : 'none'; $('semprev').textContent = o.mode === 'msg' ? o.text : '';
  $('semtext').style.display = o.mode === 'msg' ? 'none' : 'block'; $('semtext').value = o.mode === 'edit' ? o.text : '';
  const pickScope = o.mode !== 'edit' && can;
  $('semscope').style.display = pickScope ? 'block' : 'none'; $('semshl').textContent = semShareLabel();
  $('semsh').checked = pickScope && o.mode === 'note'; $('semme').checked = !$('semsh').checked; // pengumuman: bawaannya untuk semua; pesan: bawaannya pribadi
  $('semhint').textContent = o.mode === 'edit' ? (o.shared ? txf('sem.hintEditShared', 'Perubahan terlihat oleh semua orang di chat ini.') : '')
    : !can ? (cur === 'public' ? txf('sem.hintPublic', 'Di tab Publik sematan hanya untuk dirimu sendiri.') : txf('sem.hintAdmin', 'Hanya admin dan pemilik yang bisa menyematkan untuk semua anggota. Ini akan menjadi sematan pribadimu.')) : '';
  $('semerr').textContent = '';
  $('semmodal').style.display = 'flex'; $(o.mode === 'msg' ? 'semok' : 'semtext').focus();
}
$('semcancel').onclick = () => { $('semmodal').style.display = 'none'; semM = null; };
$('semok').onclick = async () => {
  const M = semM; if (!M) return;
  if (M.scope !== cur) { $('semmodal').style.display = 'none'; semM = null; return; } // pindah chat saat dialog terbuka: batal
  const shared = M.mode === 'edit' ? !!M.shared : semCanShare() && $('semsh').checked, text = $('semtext').value.trim();
  if (M.mode !== 'msg' && !text) { $('semerr').textContent = txf('sem.needText', 'Isi teks sematan'); return; }
  const api = window.api;
  const r = M.mode === 'msg' ? await api.pinAdd(M.scope, M.mid, shared) : M.mode === 'edit' ? await api.pinEdit(M.scope, M.pid, text) : await api.pinNote(M.scope, text, shared);
  if (r && r.ok === false) { $('semerr').textContent = r.err || txf('sem.pinFail', 'Gagal menyematkan'); return; }
  $('semmodal').style.display = 'none'; semM = null;
  await refresh();
};
