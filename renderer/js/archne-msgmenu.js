// ---- Menu aksi pesan (v0.24.0). Menggantikan bar melayang .macts: satu menu global #mmenu di luar daftar pesan, jadi tidak bisa menimpa
// gelembung lain, strip sematan, atau tepi layar. Butir dan penempatan dari renderer/archne-msgmenu.js (fungsi murni, dites Node).
//   Desktop : tombol ⋯ di baris waktu gelembung (muncul saat hover) atau klik kanan -> popover yang dijepit ke layar.
//   Sentuh  : ketuk gelembung -> bottom sheet dengan cuplikan pesan. Esc / ketuk di luar menutup.
let mmId = null, mmChat = null, mmA = null, mmAl = null, mmOpenAt = 0;
const mmTouch = () => !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
// ---- Reaksi (rx1). Aturan ada di Core; di sini hanya baris emoji cepat, chip, dan daftar pelaku.
let mmRecent = null; // emoji terakhir kupakai (dimuat sekali, lalu diperbarui lokal)
const rxOk = (m) => !!m && !m.sys && !m.call; // berlaku di semua tab, termasuk Publik (setelah rilis 0.25.0); Core yang memutuskan (versi lama, diblokir, laju)
const rxMine = (m) => { const r = (m.rx || []).find((x) => x.mine); return r ? r.e : ''; };
const rxGlyphOk = {}; // emoji Unicode 14/15 tampil sebagai kotak di perangkat lama: deteksi lewat canvas per emoji (glyph berwarna = ada), bila tidak ada pakai gambar Twemoji bawaan
function rxShow(e) {
  const pic = typeof MsgMenu.img === 'function' ? MsgMenu.img(e) : null;
  if (!pic) return MsgMenu.esc(e);
  if (rxGlyphOk[e] === undefined) {
    rxGlyphOk[e] = true;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 20; const x = c.getContext('2d'); x.font = '16px sans-serif'; x.textBaseline = 'top'; x.fillText(e, 0, 0);
      const d = x.getImageData(0, 0, 20, 20).data; let col = false;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40) { col = true; break; }
      rxGlyphOk[e] = col;
    } catch (x) {}
  }
  return rxGlyphOk[e] ? MsgMenu.esc(e) : pic;
}
function rxH(m) { return m && m.rx && typeof MsgMenu !== 'undefined' ? MsgMenu.chips(m.rx, rxShow) : ''; } // dipakai render gelembung
async function rxToggle(mid, e) {
  const r = await window.api.react(mid, e);
  if (!r || !r.ok) { notify((r && r.err) || txf('rx.fail', 'Reaksi gagal')); return; }
  if (r.e) mmRecent = [r.e].concat((mmRecent || []).filter((x) => x !== r.e)).slice(0, 6);
  await refresh();
}
let rxPress = null, rxSwallow = false;
function rxPicker() { // ganti isi menu dengan picker emoji; satu emoji dari papan ketik langsung dikirim
  const el = $('mmenu'), id = mmId; if (!id) return;
  el.classList.add('pick'); el.innerHTML = MsgMenu.picker(rxShow);
  if (mmA) { const r = el.getBoundingClientRect(), p = MsgMenu.place(mmA, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }, mmAl); el.style.left = p.left + 'px'; el.style.top = p.top + 'px'; }
  const i = el.querySelector('.mmpin'); if (!i) return;
  i.oninput = () => { const v = i.value.trim(); if (v && !/[\x20-\x7e]/.test(v)) { mmClose(); rxToggle(id, v); } }; // tanpa huruf/angka ASCII = emoji: langsung kirim
  i.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const v = i.value.trim(); if (v) { mmClose(); rxToggle(id, v); } } };
  try { i.focus(); } catch (x) {}
}
async function rxWho(mid, e, chip) {
  const r = await window.api.reactWho(mid, e); if (!r || !r.ok || !r.who.length) return;
  const el = $('mmenu'), b = chip.getBoundingClientRect();
  mmId = mid; mmChat = cur; el.className = 'who'; el.innerHTML = MsgMenu.whoHtml(e, r.who, rxShow); $('mmscrim').style.display = 'none';
  el.style.visibility = 'hidden'; el.style.display = 'block';
  const q = el.getBoundingClientRect(), p = MsgMenu.place({ left: b.left, right: b.right, top: b.top, bottom: b.bottom }, { w: q.width, h: q.height }, { w: window.innerWidth, h: window.innerHeight }, 'start');
  el.style.left = p.left + 'px'; el.style.top = p.top + 'px'; el.style.visibility = 'visible';
}
const mmMsg = (id) => S.messages.find((x) => x.id === id) || null;
function mmMark() { // sorot pesan yang menunya terbuka (render ulang berkala menggambar ulang gelembung, jadi dipasang lagi di mmSync)
  document.querySelectorAll('#msgs .m.mm-on').forEach((x) => x.classList.remove('mm-on'));
  if (!mmId) return;
  const el = document.querySelector(`#msgs [data-mid="${CSS.escape(mmId)}"]`); if (el) el.classList.add('mm-on');
}
function mmClose() {
  const el = $('mmenu'); el.style.display = 'none'; el.innerHTML = ''; $('mmscrim').style.display = 'none';
  mmId = null; mmMark();
}
function mmSync() { // dipanggil di akhir render(): pesan sudah hilang atau pindah chat -> tutup
  if (!mmId) return;
  if (cur !== mmChat || !mmMsg(mmId)) { mmClose(); return; }
  mmMark();
}
function mmOpen(id, anchor, align) {
  const m = mmMsg(id); if (!m) return;
  const mine = m.from === S.me.id, pinned = new Set(semRows().map((r) => r.mid).filter(Boolean)).has(id);
  const el = $('mmenu'), sheet = !anchor;
  mmId = id; mmChat = cur; mmA = anchor; mmAl = align; mmOpenAt = Date.now();
  el.className = sheet ? 'sheet' : '';
  if (mmRecent === null) { mmRecent = []; if (window.api && window.api.reactRecent) window.api.reactRecent().then((r) => { if (r && r.ok) mmRecent = r.recent; }, () => {}); }
  el.innerHTML = (sheet ? MsgMenu.preview(m, mine ? txf('chat.you', 'Kamu') : tag(m.name, m.from)) : '') + (rxOk(m) ? MsgMenu.quick(mmRecent, rxMine(m), rxShow) : '') + MsgMenu.html((m.file && typeof FileCard !== 'undefined' ? FileCard.menuItems(m) : []).concat(MsgMenu.items(m, { mine, pinned })));
  $('mmscrim').style.display = sheet ? 'block' : 'none';
  el.style.visibility = 'hidden'; el.style.display = 'block'; // diukur dulu, baru diletakkan
  if (sheet) { el.style.left = ''; el.style.top = ''; }
  else {
    const r = el.getBoundingClientRect(), p = MsgMenu.place(anchor, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }, align);
    el.style.left = p.left + 'px'; el.style.top = p.top + 'px';
  }
  el.style.visibility = 'visible';
  mmMark();
  if (!sheet) { const f = el.querySelector('.mmi:not(:disabled)'); if (f) f.focus(); } // papan ketik: panah + Enter
}
async function mmCopy(t, what) {
  const lbl = what || txf('copy.text', 'Teks'), done = txf('copy.done', '{what} disalin', { what: lbl });
  try { await navigator.clipboard.writeText(t); toast(done, true); return; } catch (x) {}
  try { // cadangan untuk konteks tanpa Clipboard API
    const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta);
    toast(ok ? done : txf('copy.fail', 'Gagal menyalin'), ok);
  } catch (x) { toast(txf('copy.fail', 'Gagal menyalin')); }
}
async function mmAct(act, id) {
  const m = mmMsg(id); if (!m) return;
  if (act === 'reply') setReply(m);
  else if (act === 'pin') semPinMsg(id);
  else if (act === 'copy') await mmCopy(String(m.text || ''));
  else if (act === 'del') await delMsg(id);
  else if (act.indexOf('f:') === 0) await fileAct(act.slice(2), id, false);
}
$('mmenu').onclick = (e) => {
  const more = e.target.closest && e.target.closest('[data-rxmore]'), ok = e.target.closest && e.target.closest('[data-rxok]');
  if (more && more.dataset && more.dataset.rxmore) { rxPicker(); return; }
  if (ok && ok.dataset && ok.dataset.rxok) { const i = $('mmenu').querySelector('.mmpin'), v = i ? i.value.trim() : ''; if (v) { const id = mmId; mmClose(); rxToggle(id, v); } return; }
  const q = e.target.closest && e.target.closest('[data-rxq]');
  if (q && q.dataset && q.dataset.rxq) { const id = mmId; mmClose(); rxToggle(id, q.dataset.rxq); return; }
  const b = e.target.closest && e.target.closest('[data-mm]'); if (!b || b.disabled) return;
  const id = mmId; mmClose(); mmAct(b.dataset.mm, id);
};
$('mmenu').onkeydown = (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const bs = [...$('mmenu').querySelectorAll('.mmi:not(:disabled)')]; if (!bs.length) return;
  const i = bs.indexOf(document.activeElement), n = e.key === 'ArrowDown' ? (i + 1) % bs.length : (i <= 0 ? bs.length - 1 : i - 1);
  e.preventDefault(); bs[n].focus();
};
$('mmscrim').onclick = () => { // ketukan kedua cepat (<350 ms) pada layar sentuh = 👍, seperti WhatsApp
  const id = mmId, quick = !!id && Date.now() - mmOpenAt < 350 && $('mmenu').classList.contains('sheet');
  mmClose();
  if (quick && rxOk(mmMsg(id))) rxToggle(id, '👍').catch(() => {});
};
if (document.addEventListener) document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mmId) { e.stopPropagation(); mmClose(); } }, true);
if (document.addEventListener) document.addEventListener('mousedown', (e) => { // popover: klik di luar menutup (sheet ditutup lewat scrim; menutup di mousedown akan membuat ketukan tembus ke pesan di bawahnya)
  if (mmId && !$('mmenu').classList.contains('sheet') && !(e.target.closest && e.target.closest('#mmenu,.mmore,.fmore'))) mmClose();
}, true);
let mmW = window.innerWidth;
if (window.addEventListener) window.addEventListener('resize', () => { // papan ketik Android mengubah TINGGI jendela (adjustResize): itu bukan alasan menutup menu, kalau tidak picker ➕ menutup dirinya sendiri begitu kolom emoji fokus dan papan ketik ikut tertutup
  const w = window.innerWidth, same = w === mmW; mmW = w;
  if (!mmId) return;
  const ae = document.activeElement, typing = !!(ae && ae.closest && ae.closest('#mmenu')), sheet = $('mmenu').classList.contains('sheet');
  if (same && (typing || sheet)) return; // sheet menempel di dasar layar, jadi ikut naik di atas papan ketik; popover yang sedang diketik juga dibiarkan
  mmClose();
});
$('msgs').addEventListener('wheel', () => { if (mmId && !$('mmenu').classList.contains('sheet')) mmClose(); }, { passive: true });
$('msgs').addEventListener('click', (e) => {
  const t = e.target; if (!t || !t.closest) return;
  const chip = t.closest('.rxc');
  if (chip) { if (rxSwallow) { rxSwallow = false; return; } const m = chip.closest('.m'); if (m && m.dataset.mid) rxToggle(m.dataset.mid, chip.dataset.rxc); return; }
  const more = t.closest('.mmore,.fmore');
  if (more) { // tombol ⋯ (desktop): jangkar = tombolnya; ketuk lagi = tutup
    const id = more.dataset.menu; if (mmId === id) { mmClose(); return; }
    const r = more.getBoundingClientRect(); mmOpen(id, { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, 'end'); return;
  }
  if (!mmTouch() || t.closest('button,a,input,.rq,.who,.vtr')) return; // layar sentuh: ketuk gelembung
  const m = t.closest('.m'); if (m && m.dataset.mid) mmOpen(m.dataset.mid, null);
});
$('msgs').addEventListener('contextmenu', (e) => { // desktop: klik kanan; jika ada teks terpilih, menu bawaan peramban (Salin) tetap muncul
  const t = e.target; if (t && t.closest && t.closest('.rxc')) { e.preventDefault(); if (!mmTouch()) { const c = t.closest('.rxc'), m = c.closest('.m'); if (m && m.dataset.mid) rxWho(m.dataset.mid, c.dataset.rxc, c); } return; }
  if (mmTouch() || !t || !t.closest || t.closest('a,input,textarea')) return;
  const m = t.closest('.m'); if (!m || !m.dataset.mid) return;
  try { if (String(window.getSelection())) return; } catch (x) {}
  e.preventDefault(); mmOpen(m.dataset.mid, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }, 'start');
});
$('msgs').addEventListener('pointerdown', (e) => { // tekan lama pada chip (sentuh): daftar pelaku
  const c = e.target && e.target.closest && e.target.closest('.rxc'); if (!c || e.pointerType === 'mouse') return;
  const m = c.closest('.m'); if (!m || !m.dataset.mid) return;
  clearTimeout(rxPress); rxPress = setTimeout(() => { rxPress = null; rxSwallow = true; rxWho(m.dataset.mid, c.dataset.rxc, c); }, 450);
});
for (const ev of ['pointerup', 'pointercancel', 'pointermove']) $('msgs').addEventListener(ev, () => { if (rxPress) { clearTimeout(rxPress); rxPress = null; } });
$('msgs').addEventListener('dblclick', (e) => { // desktop: klik dua kali pada gelembung = 👍 (ketuk lagi = cabut)
  const t = e.target; if (mmTouch() || !t || !t.closest || t.closest('button,a,input,textarea,.rq,.who,.rxc')) return;
  const el = t.closest('.m'), m = el && el.dataset.mid ? mmMsg(el.dataset.mid) : null; if (!rxOk(m)) return;
  try { window.getSelection().removeAllRanges(); } catch (x) {}
  mmClose(); rxToggle(m.id, '👍').catch(() => {});
});
