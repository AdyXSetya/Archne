// Web Lokal (0.34.0 Fase E.5, Sesi E-4): pelengkap tab Pengaturan dan tab Pratinjau di layar situs (archne-web-mine.js memegang formulir dan layar situs).
// Pengaturan: cek LANGSUNG saat mengetik (jeda 300 ms; hanya teks status yang diganti, jadi kursor aman) untuk domain (api.webCheckDomain: Core yang menilai bentuk, nama dicadangkan, dan bentrok di perangkat ini) dan berkas awal (api.webFiles: harus berkas yang ada); zona "Hapus situs".
// Core tetap penentu saat Simpan: cek langsung hanya petunjuk, bukan izin. Balasan terlambat dibuang (M / F / urutan).
// Pratinjau SEMENTARA: api.webPreview mengembalikan satu dokumen HTML (css / js / gambar disisipkan oleh Core), dimuat di <iframe sandbox="allow-scripts" srcdoc> TANPA allow-same-origin (asal buram: tidak bisa menyentuh aplikasi) dan dengan CSP yang menutup jaringan (dipasang Core di dalam dokumen).
// Pratinjau selalu memuat ulang saat tab dibuka (yang tersimpan, bukan draf editor) dan dibuang saat tab ditinggalkan (skrip situs berhenti).
// F.4: di platform dengan penampil (Electron), tab Pratinjau membuka situs di penampil yang SAMA dengan yang dipakai peer (sbOpen dengan id sendiri; sumber = www/, js/archne-sitebar.js + src/archne-sitebrowser.js);
// iframe + api.webPreview di bawah hanya cadangan untuk platform tanpa penampil (Android sampai F.3, peramban biasa).
const lwSetS = { t: { dom: 0, ent: 0 }, seq: { dom: 0, ent: 0 } };
const LW_SET_ID = { dom: ['lwf-domain', 'lwf-domst'], ent: ['lwf-entry', 'lwf-entst'] };
const LW_ENT_BAD = /^\/|\\|\/$|\/\/|(^|\/)\.\.?(\/|$)/; // bentuk yang pasti ditolak Core; jangan dilaporkan "ditemukan"

function lwSetLeave() { for (const k of ['dom', 'ent']) { if (lwSetS.t[k]) clearTimeout(lwSetS.t[k]); lwSetS.t[k] = 0; lwSetS.seq[k]++; } }
function lwSetStatus(id, text, cls) { const el = $(id); if (!el) return; el.textContent = text; el.className = 'lwst' + (cls ? ' ' + cls : ''); }
function lwSetInput(id) { if (id === LW_SET_ID.dom[0]) lwSetSchedule('dom'); else if (id === LW_SET_ID.ent[0]) lwSetSchedule('ent'); else if (String(id).slice(0, 6) === 'lwf-l-') lwLimTouch(); }
function lwSetSchedule(k) {
  const M = lwM, F = M && M.form; if (!F) return;
  if (lwSetS.t[k]) clearTimeout(lwSetS.t[k]);
  lwSetS.t[k] = 0;
  const seq = ++lwSetS.seq[k], el = $(LW_SET_ID[k][0]), st = LW_SET_ID[k][1], v = String(el && el.value != null ? el.value : '').trim();
  if (!v) { lwSetStatus(st, k === 'ent' ? txf('lw.entry.empty', 'Isi nama berkas awal') : '', k === 'ent' ? 'err' : ''); return; }
  lwSetStatus(st, txf('lw.dom.checking', 'Memeriksa…'), '');
  lwSetS.t[k] = setTimeout(() => { lwSetS.t[k] = 0; (k === 'dom' ? lwSetRunDom : lwSetRunEnt)(M, F, v, seq); }, 300);
}
async function lwSetRunDom(M, F, v, seq) {
  let r; try { r = await window.api.webCheckDomain(v, F.id || undefined); } catch (x) { r = null; }
  if (M !== lwM || M.form !== F || seq !== lwSetS.seq.dom) return;
  if (r && r.ok) lwSetStatus('lwf-domst', txf('lw.dom.ok', '{d}.archne bisa dipakai', { d: r.domain }), 'ok');
  else lwSetStatus('lwf-domst', (r && r.err) || txf('common.error', 'Terjadi kesalahan'), 'err');
}
async function lwSetRunEnt(M, F, v, seq) {
  const none = () => lwSetStatus('lwf-entst', txf('lw.entry.none', 'Berkas ini tidak ada di situs'), 'err');
  if (LW_ENT_BAD.test(v)) { none(); return; }
  const i = v.lastIndexOf('/'), dir = i < 0 ? '' : v.slice(0, i), name = i < 0 ? v : v.slice(i + 1);
  let r; try { r = await window.api.webFiles(F.id, dir); } catch (x) { r = null; }
  if (M !== lwM || M.form !== F || seq !== lwSetS.seq.ent) return;
  if (r && r.ok && (r.items || []).some((x) => x.type === 'file' && x.name === name)) lwSetStatus('lwf-entst', txf('lw.entry.ok', 'Berkas ditemukan'), 'ok'); else none();
}
const lwSetDangerHtml = () => `<section class="lwdanger"><h4>${esc(txf('lw.set.danger', 'Hapus situs'))}</h4><p class="lwnote">${esc(txf('lw.set.dangerHint', 'Situs ini dan semua berkasnya dihapus permanen dari perangkat ini. Tidak bisa dibatalkan.'))}</p><button type="button" class="sec dng" data-lw="sitedel">${esc(txf('lw.set.delete', 'Hapus situs ini'))}</button></section>`;

const lwPrevViewer = () => typeof sbApi === 'function' && !!sbApi() && typeof sbOpen === 'function' && !!(S && S.me && S.me.id);
async function lwPrevLoad() {
  const M = lwM, st = M && M.site; if (!st || st.tab !== 'preview') return;
  if (lwPrevViewer()) {
    const pv = st.pv = { state: 'viewer', dirty: lwEdDirty() };
    lwMinePaint();
    const it = (Array.isArray(M.items) ? M.items : []).find((x) => x && x.id === st.id);
    await sbOpen(S.me.id, st.id, it && typeof it.domain === 'string' ? it.domain : ''); // domain asli dibaca proses utama dari catatan situs; ini hanya untuk bilah sebelum state pertama tiba
    return;
  }
  const pv = st.pv = { state: 'loading', r: null, err: '', dirty: lwEdDirty() };
  lwMinePaint();
  let r; try { r = await window.api.webPreview(st.id); } catch (x) { r = null; }
  if (M !== lwM || M.site !== st || st.pv !== pv) return;
  if (r && r.ok && typeof r.html === 'string') { pv.state = 'ok'; pv.r = r; } else { pv.state = 'err'; pv.err = (r && r.err) || txf('common.error', 'Terjadi kesalahan'); }
  lwMinePaint();
}
function lwPrevHtml(st) {
  const pv = st.pv, btn = (a, cls, k, fb, extra) => `<button type="button" class="${cls}" data-lw="${a}"${extra || ''}>${esc(txf(k, fb))}</button>`;
  if (pv && pv.state === 'viewer') {
    const dirty = pv.dirty ? `<p class="lwnote">${esc(txf('lw.prev.dirty', 'Editor punya perubahan yang belum disimpan. Pratinjau memakai versi yang tersimpan.'))}</p>` : '';
    return `<div class="lwpv"><p class="lwnote">${esc(txf('lw.prev.viewer', 'Pratinjau memakai penampil yang sama dengan yang dipakai peer.'))}</p>${dirty}<div class="lwacts">${btn('prevreload', '', 'lw.prev.open', 'Buka pratinjau')}</div></div>`;
  }
  if (!pv || pv.state === 'loading') return `<p class="lwempty">${esc(txf('lw.prev.loading', 'Menyiapkan pratinjau…'))}</p>`;
  if (pv.state === 'err') return `<p class="lwnote err" role="alert">${esc(pv.err)}</p><div class="lwacts">${btn('sitetab', '', 'lw.prev.settings', 'Buka Pengaturan', ' data-st="settings"')}${btn('prevreload', 'sec', 'lw.prev.reload', 'Muat ulang')}</div>`;
  const r = pv.r, notes = [];
  if (pv.dirty) notes.push(txf('lw.prev.dirty', 'Editor punya perubahan yang belum disimpan. Pratinjau memakai versi yang tersimpan.'));
  notes.push(txf('lw.prev.stats', 'Berkas disisipkan: {n}', { n: r.inlined | 0 }));
  if (r.external > 0) notes.push(txf('lw.prev.external', 'Rujukan ke internet yang diblokir: {n}', { n: r.external | 0 }));
  if (Array.isArray(r.missing) && r.missing.length) notes.push(txf('lw.prev.missing', 'Tidak ditemukan, terlalu besar, atau melewati batas: {list}', { list: r.missing.map(String).join(', ') }));
  for (const k of (Array.isArray(r.limits) ? r.limits : [])) if (['module', 'import', 'links', 'media'].includes(k)) notes.push(txf('lw.prev.limit.' + k, ''));
  return `<div class="lwpv"><div class="lwbar"><p class="lwnote">${esc(txf('lw.prev.note', 'Pratinjau sementara: berjalan di kotak terisolasi tanpa akses internet. Tampilan untuk peer bisa sedikit berbeda.'))}</p>${btn('prevreload', 'sec', 'lw.prev.reload', 'Muat ulang')}</div>`
    + `<ul class="lwpvn">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
    + `<iframe id="lwpvf" class="lwpvf" title="${esc(txf('lw.prev.title', 'Pratinjau situs'))}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${esc(r.html)}"></iframe></div>`;
}
function lwSetAct(act) { if (act === 'prevreload') { lwPrevLoad(); return true; } return false; }

// Batas sumber daya situs PHP (Pengaturan situs): memory_limit, unggahan, batas waktu permintaan, Worker nganggur, dan batas cron. Core (src/archne-weblimits.js) yang menilai angka dan menyimpan HANYA yang beda dari bawaan;
// di sini hanya formulir + paket cepat. Bawaan = perilaku lama. Pemilik bebas memilih angka; Dasbor menunjukkan pemakaian sebenarnya.
const LW_LIM_KEYS = ['mem', 'up', 'exec', 'idle', 'cronN', 'cronMs'];
const LW_LIM_STD = { mem: 128, up: 64, exec: 30, idle: 120, cronN: 10, cronMs: 300 };
const LW_LIM_PRESETS = { std: LW_LIM_STD, eco: { mem: 64, up: 16, exec: 20, idle: 30, cronN: 3, cronMs: 60 }, fast: { mem: 512, up: 256, exec: 120, idle: 300, cronN: 30, cronMs: 900 } };
const LW_LIM_UNIT = { mem: 'MB', up: 'MB', exec: 's', idle: 's', cronN: '', cronMs: 's' };
const lwLimFull = (lim) => Object.assign({}, LW_LIM_STD, lim && typeof lim === 'object' ? lim : {});
function lwLimMatch(v) { for (const k of Object.keys(LW_LIM_PRESETS)) if (LW_LIM_KEYS.every((x) => LW_LIM_PRESETS[k][x] === v[x])) return k; return 'custom'; }
function lwLimHtml(lim) {
  const v = lwLimFull(lim), cur = lwLimMatch(v);
  const po = ['std', 'eco', 'fast', 'custom'].map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(txf('lw.lim.p.' + k, k))}</option>`).join('');
  const nf = (k) => `<label class="lwfl lwlimf" for="lwf-l-${k}"><span>${esc(txf('lw.lim.' + k, k))}${LW_LIM_UNIT[k] ? ' (' + LW_LIM_UNIT[k] + ')' : ''}</span><input id="lwf-l-${k}" type="number" inputmode="numeric" step="1" value="${Number.isFinite(v[k]) ? esc(String(v[k])) : ''}"></label>`;
  return `<fieldset class="lwlim"><legend>${esc(txf('lw.lim.title', 'Batas sumber daya PHP'))}</legend>`
    + `<label class="lwfl" for="lwf-limp"><span>${esc(txf('lw.lim.preset', 'Paket'))}</span><select id="lwf-limp">${po}</select><small id="lwf-limph">${esc(txf('lw.lim.ph.' + cur, ''))}</small></label>`
    + `<div class="lwlimg">${LW_LIM_KEYS.map(nf).join('')}</div>`
    + `<p class="lwnote">${esc(txf('lw.lim.hint', 'Bawaan sama seperti sebelumnya. Angka besar di HP berRAM kecil bisa membuat aplikasi tertutup sendiri; Dasbor menunjukkan pemakaian sebenarnya. Perubahan berlaku setelah Simpan (Worker PHP situs ini dimulai ulang).'))}</p></fieldset>`;
}
function lwLimPreset(k) { // paket dipilih -> isi kolom angka (Kustom tidak mengubah apa pun)
  const p = LW_LIM_PRESETS[k]; if (!p) { lwLimHint('custom'); return; }
  for (const x of LW_LIM_KEYS) { const el = $('lwf-l-' + x); if (el) el.value = String(p[x]); }
  lwLimHint(k);
}
function lwLimHint(k) { const h = $('lwf-limph'); if (h) h.textContent = txf('lw.lim.ph.' + k, ''); }
function lwLimTouch() { // kolom angka diubah tangan -> paket mengikuti (cocok paket = paket itu, selain itu Kustom)
  const sel = $('lwf-limp'); if (!sel) return;
  const v = {}; for (const x of LW_LIM_KEYS) { const el = $('lwf-l-' + x); v[x] = el ? Number(el.value) : NaN; }
  const k = lwLimMatch(v); sel.value = k; lwLimHint(k);
}
// Isian terkini -> objek lim untuk IPC, atau undefined bila kolomnya tidak ada (formulir ubah dari daftar tidak punya bagian ini dan tidak boleh mengubah batas diam-diam).
function lwLimRead() {
  const raw = LW_LIM_KEYS.map((x) => { const el = $('lwf-l-' + x); return el && el.value != null ? String(el.value).trim() : ''; });
  if (raw.every((t) => t === '')) return undefined; // bagian ini tidak ada di formulir (atau dikosongkan seluruhnya): jangan mengubah batas diam-diam
  const o = {};
  LW_LIM_KEYS.forEach((x, i) => { o[x] = raw[i] !== '' ? Number(raw[i]) : NaN; });
  return o;
}
