// Web Lokal (0.34.0, UI "Jadikan offline"): sub-tab di layar situs (Webku > Kelola), sejajar Berkas | Database | Pengaturan | Pratinjau.
// Merakit kanal O1-O3c: pindai (api.webAssetScan, baca saja) -> pilih -> Unduh (api.webOfflineStart; kemajuan lewat api.onWebOff) -> Terapkan (api.webOfflineApply) atau Buang (api.webOfflineDiscard) -> Batalkan (api.webOfflineUndo).
// Renderer hanya memegang id situs, URL dan jalur RELATIF dari hasil IPC (tanpa jalur disk). Semua teks dari berkas situs / jaringan (URL, jalur, kode) disisipkan lewat esc() sebagai TEKS: tidak pernah jadi tautan, atribut aksi, atau HTML.
// Pilihan dikirim ke Start sebagai daftar URL dari hasil pindai; Core menghitung ulang pemindaian dan hanya memakai URL yang ada di sana (renderer tidak bisa menyuruh Core mengambil URL sembarang).
// Fase (lwO.phase): load (memuat) | pick (daftar pilihan) | run (mengunduh) | ready (hasil di staging, situs BELUM diubah) | apply (menulis ke situs / membatalkan) | done (hasil Terapkan).
// Keluar dari tab saat Start berjalan TIDAK membatalkan pekerjaan (jalan terus di Core): kembali ke tab = lwOffInit() menyinkronkan lewat webOfflineStatus, dan event 'end' pada layar yang dipulihkan memuat ulang keadaan.
// Aturan tampilan: CDN yang dikenal tercentang bawaan, host lain TIDAK (sama dengan Start tanpa urls); alamat http:// tidak bisa dipilih (Core menolaknya); "mungkin ada yang terlewat" (dynamic O1) dan batas pemindaian selalu disebut.
let lwO = null; // { id, phase, scan, items, groups, online, sel:Set(indeks di items), can:Set, err, msg, prog, res, ready, app, undo, other, stale, resumed, busy, cancelling }; null = tab tidak aktif
const LW_OFF_LIST = 100; // baris maksimum per daftar yang digambar
const lwOffOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const LW_OFF_REJ = { insecure: 'http tidak aman', scheme: 'skema tidak didukung', cred: 'memuat kata sandi', host: 'host tidak sah', port: 'port tidak umum', private: 'alamat privat', dns: 'nama host tidak ditemukan', tls: 'sertifikat tidak sah', net: 'gangguan jaringan', timeout: 'kehabisan waktu', status: 'server menolak', toobig: 'terlalu besar', empty: 'kosong', encoding: 'pengodean tidak didukung', redirects: 'terlalu banyak pengalihan', downgrade: 'dialihkan ke http', type: 'jenis berkas tidak cocok', kind: 'jenis berkas tidak cocok', budget: 'melewati batas penyimpanan', dup: 'kembar', bad: 'tidak sah', abort: 'dibatalkan' };
const LW_OFF_WHY = { service: 'layanan (peta, analitik, captcha, embed, pembayaran)', runtime: 'diminta saat situs berjalan', module: 'modul ES', embed: 'embed (iframe)', media: 'audio / video', private: 'alamat privat', cred: 'memuat kata sandi', limit: 'melewati batas' };
const LW_OFF_SLIM = { entries: 'terlalu banyak entri', files: 'terlalu banyak berkas', bytes: 'melewati batas ukuran', time: 'kehabisan waktu', items: 'terlalu banyak URL' };
const LW_OFF_CLIM = { time: 'waktu', items: 'jumlah berkas', bytes: 'ukuran total', io: 'gangguan penyimpanan' };
const LW_OFF_KIND = { script: 'skrip', style: 'gaya', font: 'font', image: 'gambar' };
const LW_OFF_KEEP = { changed: 'sudah kamu ubah', gone: 'sudah tidak ada', backup: 'cadangan tidak cocok' };
const LW_OFF_CF = { exists: 'berkas lain sudah ada di jalur itu', path: 'jalur terhalang', missing: 'berkas unduhan hilang', bad: 'jalur tidak sah' };
const lwOffRej = (c) => (lwOffOwn(LW_OFF_REJ, c) ? txf('lw.off.rej.' + c, LW_OFF_REJ[c]) : txf('lw.off.rej.other', 'gagal'));
const lwOffWhy = (c) => (lwOffOwn(LW_OFF_WHY, c) ? txf('lw.off.why.' + c, LW_OFF_WHY[c]) : txf('lw.off.why.other', 'tetap butuh internet'));
const lwOffSLim = (c) => (lwOffOwn(LW_OFF_SLIM, c) ? txf('lw.off.slim.' + c, LW_OFF_SLIM[c]) : txf('lw.off.slim.other', 'batas kerja'));
const lwOffCLim = (c) => (lwOffOwn(LW_OFF_CLIM, c) ? txf('lw.off.clim.' + c, LW_OFF_CLIM[c]) : txf('lw.off.clim.other', 'batas kerja'));
const lwOffKind = (c) => (lwOffOwn(LW_OFF_KIND, c) ? txf('lw.off.kind.' + c, LW_OFF_KIND[c]) : txf('lw.off.kind.other', 'lain'));
const lwOffKeep = (c) => (lwOffOwn(LW_OFF_KEEP, c) ? txf('lw.off.keep.' + c, LW_OFF_KEEP[c]) : txf('lw.off.keep.other', 'dibiarkan'));
const lwOffCf = (c) => (lwOffOwn(LW_OFF_CF, c) ? txf('lw.off.cf.' + c, LW_OFF_CF[c]) : txf('lw.off.cf.other', 'tidak disalin'));
const lwOffSize = (n) => (typeof FileCard !== 'undefined' && FileCard.fmtSize ? FileCard.fmtSize(n) : n + ' B');
const lwOffArr = (a) => (Array.isArray(a) ? a : []);
const lwOffErr = (r) => (r && r.err) || txf('common.error', 'Terjadi kesalahan');
async function lwOffCall(name, ...a) { try { const f = window.api && window.api[name]; return f ? await f(...a) : null; } catch (x) { return null; } }

function lwOffStop() { lwO = null; }
function lwOffStart(id) {
  const O = lwO = { id, phase: 'load', scan: null, items: [], groups: [], online: [], sel: new Set(), can: new Set(), err: '', msg: null, prog: null, res: null, ready: null, app: null, undo: null, other: '', stale: false, resumed: false, busy: false, cancelling: false };
  lwOffInit(O);
}
// Sinkron dengan Core: pekerjaan yang berjalan / hasil yang menunggu (mis. sesudah pindah tab), info Batalkan, lalu pindai.
async function lwOffInit(O) {
  O.phase = 'load'; O.prog = null; O.res = null; O.ready = null; O.err = ''; O.resumed = false; O.cancelling = false; lwOffPaint();
  const [st, ui] = await Promise.all([lwOffCall('webOfflineStatus'), lwOffCall('webOfflineUndoInfo', O.id)]);
  if (O !== lwO) return;
  O.undo = ui && ui.ok && ui.has ? ui : null; O.other = ''; O.stale = false;
  if (st && st.ok && st.state === 'running') {
    if (st.id === O.id) { O.phase = st.phase === 'apply' ? 'apply' : 'run'; O.prog = st; O.resumed = true; lwOffPaint(); return; } // jalan terus di Core: hanya menampilkan; hasilnya diambil sesudah event 'end'
    O.other = 'running';
  } else if (st && st.ok && st.state === 'ready') {
    if (st.id !== O.id) O.other = 'ready';
    else if (st.stale) O.stale = true;
    else { O.phase = 'ready'; O.ready = st; }
  }
  await lwOffScan(O);
}
async function lwOffScan(O) {
  if (O.phase === 'load') lwOffPaint();
  const r = await lwOffCall('webAssetScan', O.id);
  if (O !== lwO) return;
  if (!r || !r.ok) {
    O.scan = null; O.items = []; O.groups = []; O.online = []; O.sel = new Set(); O.can = new Set(); O.err = lwOffErr(r);
    if (O.phase === 'load') O.phase = 'pick';
    lwOffPaint(); return;
  }
  lwOffShape(O, r);
  if (O.phase === 'load') O.phase = 'pick';
  lwOffPaint();
}
function lwOffShape(O, r) { // hasil pindai -> keadaan: butir 'local' per host (selectable = bukan http), butir 'online' (tidak bisa dipilih); bawaan terpilih = rank 'cdn'
  const items = lwOffArr(r.items).filter((it) => it && typeof it.url === 'string' && typeof it.host === 'string');
  const by = new Map(); O.online = []; O.can = new Set(); O.sel = new Set();
  items.forEach((it, i) => {
    if (it.cls === 'local') {
      if (!by.has(it.host)) by.set(it.host, { host: it.host, rank: it.rank === 'cdn' ? 'cdn' : 'other', idx: [], pick: [] });
      const g = by.get(it.host); g.idx.push(i);
      if (!it.insecure) { g.pick.push(i); O.can.add(i); if (g.rank === 'cdn') O.sel.add(i); }
    } else if (it.cls === 'online') O.online.push(i);
  });
  O.items = items;
  O.groups = [...by.values()].sort((a, b) => (a.rank === b.rank ? (a.host < b.host ? -1 : 1) : a.rank === 'cdn' ? -1 : 1));
  O.scan = { limits: lwOffArr(r.limits), dynamic: lwOffArr(r.dynamic), skippedN: Number(r.skippedN) || 0 };
}

// ---- tampilan ----
function lwOffRepaint() { if (lwO) lwOffSync(lwO); } // layar situs digambar ulang dari luar (lwMinePaint): HTML-nya sudah benar, keadaan DOM (centang tuan rumah, penghitung, tombol) diisi ulang
function lwOffPaint() {
  const el = $('lwsb'), O = lwO; if (!el || !O || !lwM || !lwM.site || lwM.site.tab !== 'offline') return;
  el.innerHTML = lwOffHtml();
  lwOffSync(O);
}
const lwOffBtn = (act, label, cls, dis, id) => `<button type="button"${id ? ` id="${id}"` : ''}${cls ? ` class="${cls}"` : ''} data-lw="${act}"${dis ? ' disabled' : ''}>${esc(label)}</button>`;
function lwOffUrls(list, f) { // daftar teks (URL / jalur); f(x) -> { tag, url }; dibatasi LW_OFF_LIST baris
  const a = lwOffArr(list), rows = a.slice(0, LW_OFF_LIST).map((x) => { const v = f(x); return `<li><span class="lwbadge">${esc(v.tag)}</span><span class="lwdn" title="${esc(v.url)}">${esc(v.url)}</span></li>`; }).join('');
  return `<ul class="lwoffl">${rows}</ul>` + (a.length > LW_OFF_LIST ? `<p class="lwnote">${esc(txf('lw.off.more', '… dan {n} lagi', { n: a.length - LW_OFF_LIST }))}</p>` : '');
}
function lwOffHtml() {
  const O = lwO; if (!O) return '';
  let h = `<div class="lwoff"><p class="lwnote">${esc(txf('lw.off.intro', 'Penampil Archne memblokir semua permintaan keluar, jadi skrip, gaya, font, dan gambar dari CDN tidak pernah termuat di sini. “Jadikan offline” mengunduhnya sekali ke situs ini dan mengalihkan referensinya ke salinan lokal.'))}</p>`;
  if (O.msg) h += `<div class="lwnote${O.msg.ok ? '' : ' err'}" role="status"><p>${esc(O.msg.text)}</p>${O.msg.items ? lwOffUrls(O.msg.items, (x) => ({ tag: lwOffKeep(x.why), url: String(x.p) })) : ''}</div>`;
  if (O.err) h += `<p class="lwnote err" role="alert">${esc(O.err)}</p>`;
  if (O.other === 'running') h += `<p class="lwnote">${esc(txf('lw.off.otherRun', 'Pengunduhan aset untuk situs lain sedang berjalan. Tunggu selesai atau batalkan dulu.'))}</p>`;
  h += lwOffUndoHtml(O);
  if (O.phase === 'load') h += `<p class="lwempty">${esc(txf('lw.off.loading', 'Memindai situs…'))}</p>`;
  else if (O.phase === 'pick') h += lwOffPickHtml(O);
  else if (O.phase === 'run' || O.phase === 'apply') h += lwOffRunHtml(O);
  else if (O.phase === 'ready') h += lwOffNotes(O) + lwOffReadyHtml(O);
  else if (O.phase === 'done') h += lwOffDoneHtml(O) + lwOffNotes(O);
  return h + '</div>';
}
function lwOffUndoHtml(O) {
  const u = O.undo; if (!u) return '';
  let when = ''; try { when = shortWhen(u.ts); } catch (x) {}
  const dis = O.busy || O.phase === 'run' || O.phase === 'apply';
  return `<section class="lwdc"><h3>${esc(txf('lw.off.undoT', 'Penerapan terakhir bisa dibatalkan'))}</h3><p class="lwnote">${esc(txf('lw.off.undoD', '{when} · {e} berkas diubah, {a} aset ditambahkan. Berkas yang sudah kamu ubah sesudahnya dibiarkan.', { when, e: u.editedN || 0, a: u.addedN || 0 }))}</p>${lwOffBtn('offundo', txf('lw.off.undoGo', 'Batalkan penerapan'), 'sec', dis)}</section>`;
}
function lwOffNotes(O) { // peringatan dari pindai: batas, berkas dilewati, URL yang dirakit saat jalan
  const S = O.scan; if (!S) return '';
  let h = '';
  if (S.limits.length) h += `<p class="lwnote err" role="note">${esc(txf('lw.off.scanLim', 'Pemindaian tidak lengkap ({why}). Mungkin ada aset yang tidak terdaftar.', { why: S.limits.map(lwOffSLim).join(', ') }))}</p>`;
  if (S.skippedN) h += `<p class="lwnote">${esc(txf('lw.off.scanSkip', '{n} berkas tidak dipindai (terlalu besar atau tidak terbaca).', { n: S.skippedN }))}</p>`;
  if (S.dynamic.length) {
    const fs = [...new Set(S.dynamic.map((d) => String(d && d.p)))], more = fs.length > 3 ? ' …' : '';
    h += `<p class="lwnote err" role="note">${esc(txf('lw.off.dyn', 'Mungkin ada yang terlewat: URL yang dirakit saat situs berjalan tidak bisa dipindai. Tandanya ada di {files}.', { files: fs.slice(0, 3).join(', ') + more }))}</p>`;
  }
  return h;
}
function lwOffGroupHtml(O, g, gi) {
  const rows = g.idx.map((it) => {
    const x = O.items[it], can = O.can.has(it), refs = x.refsN ? txf('lw.off.refs', 'dipakai di {n} berkas', { n: x.refsN }) : '';
    return `<li><label class="lwoffr${can ? '' : ' off'}"><input type="checkbox" id="lwoff-c-${it}" data-lw="offtoggle" data-i="${it}"${O.sel.has(it) ? ' checked' : ''}${can ? '' : ' disabled'}><span class="lwbadge">${esc(lwOffKind(x.kind))}</span><span class="lwdn" title="${esc(x.url)}">${esc(x.url)}</span>`
      + (can ? '' : `<span class="lwbadge">${esc(txf('lw.off.insecure', 'http: tidak diunduh'))}</span>`) + (x.sri ? '<span class="lwbadge">SRI</span>' : '') + (refs ? `<span class="lwdim">${esc(refs)}</span>` : '') + '</label></li>';
  }).join('');
  const rank = g.rank === 'cdn' ? txf('lw.off.cdn', 'CDN dikenal') : txf('lw.off.other', 'host lain');
  return `<section class="lwdc lwoffg"><label class="lwoffh"><input type="checkbox" id="lwoff-h-${gi}" data-lw="offhost" data-g="${gi}"${g.pick.length ? '' : ' disabled'}><span class="lwdn">${esc(g.host)}</span><span class="lwbadge">${esc(rank)}</span><span class="lwdim">${g.idx.length}</span></label><ul class="lwol">${rows}</ul></section>`;
}
function lwOffPickHtml(O) {
  let h = lwOffNotes(O);
  if (O.stale) h += `<p class="lwnote">${esc(txf('lw.off.stale', 'Hasil unduhan sebelumnya sudah kedaluwarsa dan akan dibuang saat kamu mengunduh lagi.'))}</p>`;
  if (!O.scan) return h + lwOffBtn('offretry', txf('lw.retry', 'Coba lagi'), 'sec');
  if (!O.groups.length) h += `<p class="lwempty">${esc(txf('lw.off.noneLocal', 'Tidak ada aset eksternal yang bisa disalin dari situs ini.'))}</p>`;
  else {
    h += `<div class="lwftb"><span class="lwsel" id="lwoff-cnt" aria-live="polite"></span>${lwOffBtn('offall', txf('lw.off.all', 'Pilih semua'), 'sec')}${lwOffBtn('offnone', txf('lw.off.none', 'Kosongkan'), 'sec')}${lwOffBtn('offgo', txf('lw.off.go', 'Unduh yang dipilih'), '', true, 'lwoff-go')}</div>`;
    h += O.groups.map((g, gi) => lwOffGroupHtml(O, g, gi)).join('');
    h += `<p class="lwnote">${esc(txf('lw.off.pickHint', 'CDN yang dikenal dicentang bawaan; host lain harus kamu centang sendiri. Situsmu baru berubah saat kamu menekan Terapkan.'))}</p>`;
  }
  if (O.online.length) h += `<section class="lwdc"><h3>${esc(txf('lw.off.onlineT', 'Tetap butuh internet'))}</h3><p class="lwnote">${esc(txf('lw.off.onlineD', 'Ini tidak disalin dan tetap butuh internet saat situs dibuka.'))}</p>${lwOffUrls(O.online, (i) => ({ tag: lwOffWhy(O.items[i].why), url: O.items[i].url }))}</section>`;
  return h;
}
function lwOffProgText(P, apply) {
  if (apply || !P || P.phase === 'apply') return txf('lw.off.applying', 'Memproses perubahan situs…');
  if (P.phase === 'scan' || !P.total) return txf('lw.off.scanning', 'Memindai situs…');
  return txf('lw.off.prog', 'Mengunduh… {done} dari {total} aset · {size}', { done: P.done || 0, total: P.total || 0, size: lwOffSize(P.bytes || 0) }) + (P.failN ? ' · ' + txf('lw.off.progFail', '{n} gagal', { n: P.failN }) : '');
}
const lwOffPct = (P) => (P && P.total > 0 ? Math.max(0, Math.min(100, Math.round(((P.done || 0) / P.total) * 100))) : 0);
function lwOffRunHtml(O) {
  const ap = O.phase === 'apply', pct = lwOffPct(O.prog);
  return `<div class="lwup" role="status" aria-live="polite"><div id="lwoff-ptx">${esc(lwOffProgText(O.prog, ap))}</div><div class="lwupbar" id="lwoff-pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i id="lwoff-pfill" style="width:${pct}%"></i></div></div>`
    + (ap ? '' : `<div class="lwacts">${lwOffBtn('offcancel', txf('common.cancel', 'Batal'), 'sec', O.cancelling)}</div>`);
}
function lwOffReadyHtml(O) {
  const r = O.res || O.ready || {}, full = !!O.res, c = full ? r.chain : null;
  let h = `<section class="lwdc"><h3>${esc(txf('lw.off.readyT', 'Aset sudah diunduh'))}</h3>`
    + `<div class="lwdrow"><span>${esc(txf('lw.off.saved', 'Tersimpan sementara'))}</span><b>${esc(txf('lw.off.savedV', '{n} aset ({size})', { n: r.saved || 0, size: lwOffSize(r.savedBytes || 0) }))}</b></div>`;
  if (r.rejectedN) h += `<div class="lwdrow"><span>${esc(txf('lw.off.failed', 'Gagal diunduh'))}</span><b>${r.rejectedN}</b></div>`;
  if (c && c.rounds) h += `<p class="lwnote">${esc(txf('lw.off.chain', 'Rantai CSS: {a} aset tambahan (font, gambar, @import) dari {r} putaran.', { a: c.added || 0, r: c.rounds }))}</p>`;
  if (c && lwOffArr(c.limits).length) h += `<p class="lwnote err" role="note">${esc(txf('lw.off.chainLim', 'Rantai berhenti karena batas ({why}). Sisanya tetap butuh internet.', { why: c.limits.map(lwOffCLim).join(', ') }))}</p>`;
  if (c && c.skippedN) h += `<p class="lwnote">${esc(txf('lw.off.chainSkip', '{n} referensi di dalam CSS tidak diikuti dan tetap butuh internet:', { n: c.skippedN }))}</p>${lwOffUrls(c.skipped, (x) => ({ tag: lwOffWhy(x.why), url: String(x.url) }))}`;
  if (full && lwOffArr(r.rejected).length) h += `<p class="lwnote">${esc(txf('lw.off.rejList', 'Tidak berhasil diunduh:'))}</p>${lwOffUrls(r.rejected, (x) => ({ tag: lwOffRej(x.code), url: String(x.url) }))}`;
  if (full && r.more) h += `<p class="lwnote">${esc(txf('lw.off.listCut', 'Daftar dipotong; semua yang berhasil tetap ikut diterapkan.'))}</p>`;
  h += `<p class="lwnote">${esc(txf('lw.off.notYet', 'Situs belum diubah. “Terapkan” menyalin aset ke assets/vendor dan menulis ulang referensinya; berkas asli dicadangkan dan bisa dibatalkan.'))}</p>`
    + `<div class="lwacts">${lwOffBtn('offapply', txf('lw.off.apply', 'Terapkan'), '', O.busy || !(r.saved > 0))}${lwOffBtn('offdiscard', txf('lw.off.discard', 'Buang hasil'), 'sec', O.busy)}</div></section>`;
  return h;
}
function lwOffDoneHtml(O) {
  const r = O.app || {};
  let h = `<section class="lwdc"><h3>${esc(txf('lw.off.doneT', 'Selesai diterapkan'))}</h3>`;
  if (r.nochange) h += `<p class="lwnote">${esc(txf('lw.off.noChange', 'Tidak ada yang perlu diubah: situs sudah memakai salinan ini.'))}</p>`;
  else h += `<p class="lwnote">${esc(txf('lw.off.doneD', '{a} aset disalin ke assets/vendor ({u} sudah ada), {e} berkas ditulis ulang ({n} referensi), {s} atribut integrity dihapus.', { a: r.added || 0, u: r.reused || 0, e: r.editedN || 0, n: r.replaced || 0, s: r.sriRemoved || 0 }))}</p>`;
  if (r.undo) h += `<p class="lwnote">${esc(txf('lw.off.doneUndo', 'Bisa dibatalkan lewat kartu di atas.'))}</p>`;
  if (r.conflictN) h += `<p class="lwnote err" role="note">${esc(txf('lw.off.conflicts', '{n} aset tidak disalin karena bentrok dengan berkas milikmu:', { n: r.conflictN }))}</p>${lwOffUrls(r.conflicts, (x) => ({ tag: lwOffCf(x.why), url: String(x.url) }))}`;
  if (r.unresolvedN) h += `<p class="lwnote">${esc(txf('lw.off.unres', '{n} referensi tetap butuh internet (tidak ada salinan lokalnya):', { n: r.unresolvedN }))}</p>${lwOffUrls(r.unresolved, (x) => ({ tag: String(x.p), url: String(x.url) }))}`;
  if (lwOffArr(r.limits).length) h += `<p class="lwnote err" role="note">${esc(txf('lw.off.applyLim', 'Penerapan dibatasi: sebagian berkas tidak diproses.'))}</p>`;
  if (lwOffArr(r.edited).length) h += `<p class="lwnote">${esc(txf('lw.off.edited', 'Berkas yang diubah:'))}</p>${lwOffUrls(r.edited, (x) => ({ tag: String(x.n), url: String(x.p) }))}`;
  return h + `<div class="lwacts">${lwOffBtn('offrescan', txf('lw.off.rescan', 'Pilih aset lagi'), 'sec', O.busy)}</div></section>`;
}

// ---- keadaan pilihan: tanpa menggambar ulang daftar (fokus dan gulir tetap) ----
function lwOffSync(O) {
  const set = (id, f) => { const el = $(id); if (el) f(el); };
  if (O.phase !== 'pick') return; // daftar pilihan hanya digambar di fase pick
  set('lwoff-cnt', (el) => { el.textContent = txf('lw.off.cnt', '{n} dari {m} dipilih', { n: O.sel.size, m: O.can.size }); });
  set('lwoff-go', (el) => { el.disabled = !O.sel.size || O.busy || O.other === 'running'; });
  O.groups.forEach((g, gi) => {
    const n = g.pick.filter((i) => O.sel.has(i)).length;
    set('lwoff-h-' + gi, (el) => { el.checked = g.pick.length > 0 && n === g.pick.length; el.indeterminate = n > 0 && n < g.pick.length; });
    g.pick.forEach((i) => set('lwoff-c-' + i, (el) => { el.checked = O.sel.has(i); }));
  });
}
function lwOffToggle(O, i) { if (O.phase !== 'pick' || !O.can.has(i)) return; if (O.sel.has(i)) O.sel.delete(i); else O.sel.add(i); lwOffSync(O); }
function lwOffHost(O, gi) {
  const g = O.groups[gi]; if (O.phase !== 'pick' || !g) return;
  const all = g.pick.length > 0 && g.pick.every((i) => O.sel.has(i));
  g.pick.forEach((i) => { if (all) O.sel.delete(i); else O.sel.add(i); });
  lwOffSync(O);
}
function lwOffAll(O, on) { if (O.phase !== 'pick') return; O.sel = on ? new Set(O.can) : new Set(); lwOffSync(O); }

// ---- aksi ----
function lwOffAct(act, d) {
  const O = lwO; if (!O || typeof act !== 'string' || act.slice(0, 3) !== 'off') return false;
  d = d || {};
  if (act === 'offtoggle') lwOffToggle(O, Number(d.i));
  else if (act === 'offhost') lwOffHost(O, Number(d.g));
  else if (act === 'offall') lwOffAll(O, true);
  else if (act === 'offnone') lwOffAll(O, false);
  else if (act === 'offgo') lwOffGo(O);
  else if (act === 'offcancel') lwOffCancel(O);
  else if (act === 'offapply') lwOffApply(O);
  else if (act === 'offdiscard') lwOffDiscard(O);
  else if (act === 'offundo') lwOffUndo(O);
  else if (act === 'offrescan' || act === 'offretry') { O.msg = null; O.app = null; lwOffInit(O); }
  else return false;
  return true;
}
async function lwOffGo(O) {
  if (O.busy || O.phase !== 'pick' || !O.sel.size || O.other === 'running') return;
  const idx = [...O.sel].filter((i) => O.can.has(i)).sort((a, b) => a - b), urls = idx.map((i) => O.items[i].url), hosts = new Set(idx.map((i) => O.items[i].host)).size;
  const extra = O.other === 'ready' ? '\n' + txf('lw.off.askOther', 'Hasil unduhan situs lain yang belum diterapkan akan dibuang.') : '';
  const yes = await ask(txf('lw.off.askGo', 'Unduh {n} aset dari {h} domain lewat internet?\nSitusmu belum berubah sampai kamu menekan Terapkan.{extra}', { n: urls.length, h: hosts, extra }), { ok: txf('lw.off.goOk', 'Unduh'), cancel: txf('common.cancel', 'Batal') });
  if (O !== lwO || !yes || O.phase !== 'pick') return;
  O.phase = 'run'; O.prog = { phase: 'scan', done: 0, total: 0, okN: 0, failN: 0, bytes: 0 }; O.err = ''; O.msg = null; O.cancelling = false; lwOffPaint();
  let r; try { r = await window.api.webOfflineStart(O.id, { urls }); } catch (x) { r = null; }
  if (O !== lwO) return; // tab ditinggalkan selagi menunggu: pekerjaan jalan terus di Core, keadaannya dipulihkan lewat webOfflineStatus. (Penjaga kebersihan: lwOffPaint juga menolak bila lwO sudah lain, jadi tanpa ini pun tampilan tidak berubah; tidak diberi kontrol kepekaan.)
  if (!r || !r.ok) { O.phase = 'pick'; O.err = lwOffErr(r); lwOffPaint(); return; }
  if (r.aborted) { O.phase = 'pick'; O.msg = { ok: true, text: txf('lw.off.cancelled', 'Dibatalkan. Tidak ada yang disimpan.') }; lwOffPaint(); return; }
  O.res = r; O.phase = 'ready'; O.other = ''; lwOffPaint();
}
async function lwOffCancel(O) {
  if (O.phase !== 'run' || O.cancelling) return;
  O.cancelling = true; lwOffPaint();
  const r = await lwOffCall('webOfflineCancel');
  if (O !== lwO) return;
  if (!r || !r.ok || !r.cancelled) { O.cancelling = false; lwOffPaint(); } // sudah selesai / tidak bisa dibatalkan: hasil datang lewat jalur biasa
}
async function lwOffApply(O) {
  if (O.busy || O.phase !== 'ready') return;
  const r0 = O.res || O.ready || {}, extra = O.undo ? '\n' + txf('lw.off.askPerm', 'Penerapan sebelumnya tidak bisa dibatalkan lagi sesudah ini.') : '';
  const yes = await ask(txf('lw.off.askApply', 'Terapkan {n} aset ke situs ini?\nBerkas yang diubah dicadangkan lebih dulu dan bisa dibatalkan.{extra}', { n: r0.saved || 0, extra }), { ok: txf('lw.off.apply', 'Terapkan'), cancel: txf('common.cancel', 'Batal') });
  if (O !== lwO || !yes || O.phase !== 'ready') return;
  O.phase = 'apply'; O.prog = null; O.err = ''; O.busy = true; lwOffPaint();
  let r; try { r = await window.api.webOfflineApply(O.id); } catch (x) { r = null; }
  if (O !== lwO) return;
  O.busy = false;
  if (!r || !r.ok) {
    const e = lwOffErr(r);
    if (r && (r.code === 'stale' || r.code === 'nostage')) { await lwOffInit(O); if (O === lwO) { O.err = e; lwOffPaint(); } return; } // hasil staging sudah tidak bisa dipakai: mulai dari pindai
    O.phase = 'ready'; O.err = e; lwOffPaint(); return; // busy / io: hasil masih ada, bisa dicoba lagi
  }
  O.app = r; O.res = null; O.ready = null; O.phase = 'done'; lwOffPaint();
  const ui = await lwOffCall('webOfflineUndoInfo', O.id); // kartu Batalkan + pindai ulang (daftar "tetap butuh internet" dan peringatan ikut segar)
  if (O !== lwO) return;
  O.undo = ui && ui.ok && ui.has ? ui : null; lwOffPaint();
  lwOffScan(O);
}
async function lwOffDiscard(O) {
  if (O.busy || O.phase !== 'ready') return;
  const yes = await ask(txf('lw.off.askDiscard', 'Buang hasil unduhan? Situsmu tidak berubah; kamu perlu mengunduh lagi bila mau memakainya.'), { ok: txf('lw.off.discardOk', 'Buang'), cancel: txf('common.cancel', 'Batal'), danger: true });
  if (O !== lwO || !yes || O.phase !== 'ready') return;
  O.busy = true; lwOffPaint();
  const r = await lwOffCall('webOfflineDiscard');
  if (O !== lwO) return;
  O.busy = false;
  if (!r || !r.ok) { O.err = lwOffErr(r); lwOffPaint(); return; }
  O.msg = null; lwOffInit(O);
}
async function lwOffUndo(O) {
  if (O.busy || O.phase === 'run' || O.phase === 'apply') return;
  const yes = await ask(txf('lw.off.askUndo', 'Kembalikan penerapan terakhir?\nBerkas dikembalikan ke keadaan sebelum diterapkan; berkas yang sudah kamu ubah sesudahnya dibiarkan.'), { ok: txf('lw.off.undoGo', 'Batalkan penerapan'), cancel: txf('common.cancel', 'Batal') });
  if (O !== lwO || !yes) return;
  O.busy = true; O.err = ''; O.msg = null; lwOffPaint();
  let r; try { r = await window.api.webOfflineUndo(O.id); } catch (x) { r = null; }
  if (O !== lwO) return;
  O.busy = false;
  if (!r || !r.ok) { O.err = lwOffErr(r); lwOffPaint(); return; }
  const kept = lwOffArr(r.kept);
  O.msg = { ok: !kept.length, text: txf('lw.off.undone', '{r} berkas dipulihkan, {d} aset dihapus.', { r: r.restored || 0, d: r.removed || 0 }) + (kept.length ? ' ' + txf('lw.off.keptN', '{n} dibiarkan:', { n: kept.length }) : ''), items: kept.length ? kept : null };
  O.app = null; lwOffInit(O);
}

// Kemajuan dari Core (dibatasi 200 ms di sisi Core). 'end' pada layar yang dipulihkan = hasil Start / Apply tidak akan datang lewat janji: sinkron ulang.
function lwOffProg(p) {
  const O = lwO; if (!O || !p || p.id !== O.id) return;
  if (p.phase === 'end') { if (O.resumed && (O.phase === 'run' || O.phase === 'apply')) lwOffInit(O); return; }
  if (O.phase !== 'run' && O.phase !== 'apply') return;
  O.prog = { phase: p.phase, done: p.done || 0, total: p.total || 0, okN: p.okN || 0, failN: p.failN || 0, bytes: p.bytes || 0 };
  const tx = $('lwoff-ptx'), box = $('lwoff-pbar'), fill = $('lwoff-pfill');
  if (!tx || !box || !fill) { lwOffPaint(); return; }
  const pct = lwOffPct(O.prog);
  tx.textContent = lwOffProgText(O.prog, O.phase === 'apply'); fill.style.width = pct + '%'; box.setAttribute('aria-valuenow', String(pct));
}
if (window.api && typeof window.api.onWebOff === 'function') window.api.onWebOff(lwOffProg);
