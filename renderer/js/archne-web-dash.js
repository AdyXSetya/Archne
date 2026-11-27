// Web Lokal (0.34.0 Fase U3): tab Dasbor. Metrik perangkat INI saja (RAM, Worker PHP, penyimpanan per situs, status MySQL); tidak dikirim ke peer dan tidak keluar dari perangkat.
// Data dari api.webDash() / api.webDashPhp() (src/archne-webdash.js): hanya angka, id situs, domain dan judul; renderer tidak pernah menerima jalur disk.
// Label jujur: PHP = php-wasm (PHP yang dikompilasi ke WebAssembly), MySQL = emulasi di atas SQLite. Info PHP yang tampil sudah disaring (versi, ekstensi, batas); bukan phpinfo().
// Penyegaran otomatis tiap 5 dtk selama tab terbuka dan layar terlihat; penyimpanan di-cache Core (20 dtk), tombol "Hitung ulang" memaksa hitung baru.
let lwDashS = null; // { data, err, busy, php: null | { busy, info, err }, timer }
const LW_DASH_EVERY = 5000;

const lwDashSize = (n) => (typeof FileCard !== 'undefined' && FileCard.fmtSize ? FileCard.fmtSize(n) : n + ' B');
const lwDashPct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : 0);
function lwDashBar(pct, label) { return `<div class="lwdbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(label)}"><i style="width:${pct}%"></i></div>`; }

function lwDashStop() { if (lwDashS && lwDashS.timer) { try { clearInterval(lwDashS.timer); } catch (x) {} } lwDashS = null; if (typeof lwCronStop === 'function') lwCronStop(); }
function lwDashStart() {
  lwDashStop();
  const D = lwDashS = { data: null, err: '', busy: false, php: null, wk: null, timer: null };
  if (typeof lwCronStart === 'function') lwCronStart(); // bagian Cron (C7): dimuat bersama Dasbor, dimuat ulang tiap detak
  lwDashPaint();
  lwDashLoad(false);
  D.timer = setInterval(() => { if (lwDashS === D && !(typeof document !== 'undefined' && document.hidden)) { lwDashLoad(false); if (typeof lwCronReload === 'function') lwCronReload(); } }, LW_DASH_EVERY);
}
async function lwDashLoad(fresh) {
  const D = lwDashS, api = window.api;
  if (!D || !api || !api.webDash || D.busy) return;
  D.busy = true; if (fresh) lwDashPaint();
  let r;
  try { r = await api.webDash(fresh ? { fresh: true } : undefined); } catch (x) { r = null; }
  if (lwDashS !== D) return;
  D.busy = false;
  if (r && r.ok && r.mem && r.php && r.mysql && r.storage) { D.data = r; D.err = ''; } else D.err = (r && r.err) || txf('lw.d.fail', 'Dasbor tidak bisa dimuat');
  lwDashPaint();
}
async function lwDashPhp() {
  const D = lwDashS, api = window.api;
  if (!D || !api || !api.webDashPhp || (D.php && D.php.busy)) return;
  D.php = { busy: true, info: null, err: '' }; lwDashPaint();
  let r;
  try { r = await api.webDashPhp(); } catch (x) { r = null; }
  if (lwDashS !== D) return;
  D.php = r && r.ok ? { busy: false, info: r.info, err: '' } : { busy: false, info: null, err: (r && r.err) || txf('lw.d.fail', 'Dasbor tidak bisa dimuat') };
  lwDashPaint();
}
// Jumlah Worker maksimal (perangkat ini, semua situs): Otomatis (menurut RAM) atau Manual (angka bebas >= 1, tanpa batas atas buatan). D.wk = null (ikut data) | { mode, val, busy, err, ok }.
function lwDashWkRead() { // mode + angka yang sedang tampil di formulir (DOM = sumber kebenaran selama formulir terbuka)
  const r = typeof document !== 'undefined' && document.querySelector ? document.querySelector('input[name="lwwkm"]:checked') : null, n = $('lwwkn');
  return { mode: r && r.value === 'manual' ? 'manual' : 'auto', val: n && n.value != null ? String(n.value).trim() : '' };
}
function lwDashWkMode() {
  const D = lwDashS; if (!D) return;
  const c = lwDashWkRead(), cur = D.data && D.data.php ? D.data.php : null;
  D.wk = { mode: c.mode, val: c.val || (cur ? String(cur.max) : '1'), busy: false, err: '', ok: false };
  lwDashPaint(true);
}
async function lwDashWkSet() {
  const D = lwDashS, api = window.api; if (!D || !api || !api.setSettings) return;
  const c = lwDashWkRead(); let patch;
  if (c.mode === 'auto') patch = { phpWorkers: null };
  else {
    const n = Number(c.val);
    if (!/^\d+$/.test(c.val) || !Number.isSafeInteger(n)) { D.wk = { mode: 'manual', val: c.val, busy: false, err: txf('lw.d.wkInt', 'Isi angka bulat.'), ok: false }; lwDashPaint(true); return; }
    if (n < 1) { D.wk = { mode: 'manual', val: c.val, busy: false, err: txf('lw.d.wkMin', 'Minimal 1 Worker.'), ok: false }; lwDashPaint(true); return; }
    patch = { phpWorkers: n };
  }
  D.wk = { mode: c.mode, val: c.val, busy: true, err: '', ok: false }; lwDashPaint(true);
  let r; try { r = await api.setSettings(patch); } catch (x) { r = null; }
  if (lwDashS !== D) return;
  if (r && r.ok) { D.wk = null; await lwDashLoad(false); if (lwDashS === D) { D.wk = { mode: c.mode, val: c.val, busy: false, err: '', ok: true }; lwDashPaint(true); } return; }
  const code = r && r.code, msg = code === 'min' ? txf('lw.d.wkMin', 'Minimal 1 Worker.') : code === 'io' ? txf('set.errIo', 'Gagal menyimpan pengaturan. Penyimpanan perangkat mungkin penuh atau tidak bisa ditulisi.') : txf('lw.d.wkBad', 'Jumlah Worker tidak sah.');
  D.wk = { mode: c.mode, val: c.val, busy: false, err: msg, ok: false }; lwDashPaint(true);
}
function lwDashAct(act) {
  if (act === 'dref') { lwDashLoad(true); return true; }
  if (act === 'dphp') { lwDashPhp(); return true; }
  if (act === 'wkmode') { lwDashWkMode(); return true; }
  if (act === 'wkset') { lwDashWkSet(); return true; }
  return false;
}
const lwDashMemBytes = (v) => { const m = /^(\d{1,12})([KMGkmg]?)$/.exec(String(v || '')); if (!m) return 0; return Number(m[1]) * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 })[m[2].toLowerCase()]; };
function lwDashWkHtml(p, D) {
  const w = D.wk, mode = w ? w.mode : (p.auto === false ? 'manual' : 'auto'), val = w ? w.val : String(p.max), busy = !!(w && w.busy);
  const ml = lwDashMemBytes(D.php && D.php.info && D.php.info.limits && D.php.info.limits.memory_limit);
  const nShow = mode === 'manual' && /^\d+$/.test(val) && Number(val) >= 1 ? Number(val) : p.max;
  const est = ml > 0 ? `<p class="lwnote">${esc(txf('lw.d.wkEst', 'Perkiraan pemakaian memori maksimal: {n} Worker × {m} = {t}', { n: nShow, m: lwDashSize(ml), t: lwDashSize(nShow * ml) }))}</p>` : '';
  return `<div class="lwwk"><div class="lwdrow"><span>${esc(txf('lw.d.wkTitle', 'Jumlah Worker maksimal'))}</span></div>`
    + `<label class="lwwkr"><input type="radio" name="lwwkm" value="auto" data-lw="wkmode"${mode === 'auto' ? ' checked' : ''}${busy ? ' disabled' : ''}> ${esc(txf('lw.d.wkAuto', 'Otomatis menurut RAM ({n} Worker)', { n: p.autoMax }))}</label>`
    + `<label class="lwwkr"><input type="radio" name="lwwkm" value="manual" data-lw="wkmode"${mode === 'manual' ? ' checked' : ''}${busy ? ' disabled' : ''}> ${esc(txf('lw.d.wkManual', 'Manual'))}`
    + ` <input id="lwwkn" class="lwwkn" type="number" min="1" step="1" inputmode="numeric" value="${esc(val)}" aria-label="${esc(txf('lw.d.wkTitle', 'Jumlah Worker maksimal'))}"${mode === 'manual' && !busy ? '' : ' disabled'}></label>`
    + `<div class="lwacts"><button type="button" class="sec" data-lw="wkset"${busy ? ' disabled' : ''}>${esc(txf('lw.d.wkApply', 'Terapkan'))}</button>${w && w.ok ? `<span class="lwst ok" role="status">${esc(txf('lw.d.wkSaved', 'Tersimpan. Berlaku sekarang.'))}</span>` : ''}</div>`
    + (w && w.err ? `<p class="lwnote err" role="alert">${esc(w.err)}</p>` : '')
    + est
    + `<p class="lwnote">${esc(txf('lw.d.wkHint', 'Satu situs memakai satu Worker, jadi jumlahnya tidak melebihi situs PHP yang sedang dipakai. Setiap Worker punya memorinya sendiri (memory_limit situs), jadi angka besar bisa menghabiskan RAM. Tidak ada batas atas dari Archne: ini perangkatmu, keputusannya milikmu. Penurunan menutup Worker yang menganggur; yang sedang bekerja ditutup setelah selesai.'))}</p></div>`;
}

function lwDashMemHtml(d) {
  const m = d.mem, used = Math.max(0, m.total - m.free), pu = lwDashPct(used, m.total), pa = lwDashPct(m.app, m.total);
  const src = m.src === 'processes' ? txf('lw.d.memProc', 'Seluruh proses Archne') : txf('lw.d.memCore', 'Proses inti Archne');
  return `<section class="lwdc"><h3>${esc(txf('lw.d.mem', 'Memori'))}</h3>`
    + `<div class="lwdrow"><span>${esc(txf('lw.d.memSys', 'RAM sistem terpakai'))}</span><b>${esc(lwDashSize(used))} / ${esc(lwDashSize(m.total))} (${pu}%)</b></div>${lwDashBar(pu, txf('lw.d.memSys', 'RAM sistem terpakai'))}`
    + `<div class="lwdrow"><span>${esc(src)}</span><b>${esc(lwDashSize(m.app))} (${pa}%)</b></div>${lwDashBar(pa, src)}`
    + `<p class="lwnote">${esc(txf('lw.d.cpus', '{n} inti prosesor · {os}', { n: d.cpus > 0 ? d.cpus : '—', os: d.platform }))}</p></section>`;
}
function lwDashPhpHtml(d, D) {
  const p = d.php, title = txf('lw.d.php', 'Mesin PHP');
  if (!p.available) return `<section class="lwdc"><h3>${esc(title)}</h3><p class="lwnote">${esc(txf('lw.d.phpNone', 'Mesin PHP tidak tersedia di perangkat ini.'))}</p></section>`;
  const rows = p.workers.length ? p.workers.map((w) => `<li><span class="lwdot${w.ready ? ' on' : ''}" aria-hidden="true"></span><span class="lwdn">${esc(w.domain || '?')}</span><span class="lwdim">${esc(!w.ready ? txf('lw.d.wBoot', 'memulai') : w.busy ? txf('lw.d.wBusy', 'bekerja') : txf('lw.d.wIdle', 'siaga'))}${w.queued ? esc(' · ' + txf('lw.d.wQ', '{n} antre', { n: w.queued })) : ''}</span></li>`).join('') : '';
  let det = '';
  const ph = D.php;
  if (ph && ph.busy) det = `<p class="lwnote">${esc(txf('lw.d.phpLoading', 'Memuat info PHP… (menyalakan Worker bila perlu)'))}</p>`;
  else if (ph && ph.err) det = `<p class="lwnote err">${esc(ph.err)}</p>`;
  else if (ph && ph.info) {
    const i = ph.info, lim = i.limits || {};
    det = `<dl class="lwdl"><dt>PHP</dt><dd>${esc(i.php || '?')}</dd><dt>SQLite</dt><dd>${esc(i.sqlite || '?')}</dd>`
      + Object.keys(lim).filter((k) => lim[k]).map((k) => `<dt>${esc(k)}</dt><dd>${esc(lim[k])}</dd>`).join('')
      + `</dl><div class="lwdext" aria-label="${esc(txf('lw.d.ext', 'Ekstensi'))}">${i.ext.map((e) => `<span class="lwbadge">${esc(e)}</span>`).join('')}</div>`;
  }
  return `<section class="lwdc"><h3>${esc(title)}</h3>`
    + `<p class="lwnote">${esc(txf('lw.d.phpLabel', 'PHP {v} (php-wasm): PHP yang dikompilasi ke WebAssembly, bukan PHP asli.', { v: p.line }))}</p>`
    + `<div class="lwdrow"><span>${esc(txf('lw.d.workers', 'Worker aktif'))}</span><b>${p.active} / ${p.max}${p.waiting ? esc(' · ' + txf('lw.d.waiting', '{n} menunggu slot', { n: p.waiting })) : ''}</b></div>${lwDashBar(lwDashPct(p.active, p.max), txf('lw.d.workers', 'Worker aktif'))}`
    + lwDashWkHtml(p, D)
    + (rows ? `<ul class="lwdw">${rows}</ul>` : `<p class="lwnote">${esc(txf('lw.d.noWorker', 'Tidak ada Worker yang hidup. Worker dinyalakan saat situs PHP dibuka dan ditutup saat nganggur.'))}</p>`)
    + (p.timeoutMs ? `<p class="lwnote">${esc(txf('lw.d.limits', 'Batas waktu per permintaan {s} dtk · Worker nganggur ditutup setelah {m} menit', { s: Math.round(p.timeoutMs / 1000), m: Math.round(p.idleMs / 60000) }))}</p>` : '')
    + det + (ph && ph.info ? '' : `<button type="button" class="sec" data-lw="dphp"${ph && ph.busy ? ' disabled' : ''}>${esc(txf('lw.d.phpBtn', 'Muat info PHP'))}</button>`) + `</section>`;
}
function lwDashMysqlHtml(d) {
  const m = d.mysql, rows = m.sites.map((s) => `<li><span class="lwdot${s.running ? ' on' : ''}" aria-hidden="true"></span><span class="lwdn">${esc(s.domain)}</span><span class="lwdim">${esc(s.running ? txf('lw.d.myOn', 'menyala') : txf('lw.d.myOff', 'mati'))}</span></li>`).join('');
  return `<section class="lwdc"><h3>MySQL</h3>`
    + `<p class="lwnote">${esc(txf('lw.d.mysqlLabel', 'Emulasi di atas SQLite (kompatibel MySQL, bukan MySQL asli). Versi yang dilaporkan: {v}', { v: m.version }))}</p>`
    + (m.available ? `<div class="lwdrow"><span>${esc(txf('lw.d.myRun', 'Server menyala'))}</span><b>${m.running} / ${m.sites.length}</b></div>` : `<p class="lwnote">${esc(txf('lw.d.phpNone', 'Mesin PHP tidak tersedia di perangkat ini.'))}</p>`)
    + (rows ? `<ul class="lwdw">${rows}</ul>` : '') + `</section>`;
}
function lwDashStoreHtml(d) {
  const s = d.storage, max = s.sites.length ? Math.max(1, s.sites[0].total) : 1;
  const rows = s.sites.map((x) => `<tr><td class="lwdn">${esc(x.domain)}${x.php ? ' <span class="lwbadge">PHP</span>' : ''}</td><td class="lwfs">${esc(lwDashSize(x.total))}</td><td class="lwdb">${lwDashBar(lwDashPct(x.total, max), x.domain)}</td><td class="lwfm">www ${esc(lwDashSize(x.www))}${x.php ? esc(' · data ' + lwDashSize(x.data)) : ''}</td></tr>`).join('');
  return `<section class="lwdc"><h3>${esc(txf('lw.d.store', 'Penyimpanan situs'))}</h3>`
    + `<div class="lwdrow"><span>${esc(txf('lw.d.storeTotal', 'Total {n} situs', { n: s.count }))}</span><b>${esc(lwDashSize(s.total))}</b></div>`
    + (rows ? `<div class="lwtw"><table class="lwft"><tbody>${rows}</tbody></table></div>` : `<p class="lwnote">${esc(txf('lw.d.noSites', 'Belum ada situs.'))}</p>`)
    + (s.partial ? `<p class="lwnote">${esc(txf('lw.d.partial', 'Perkiraan: penelusuran dibatasi karena isinya sangat banyak.'))}</p>` : '')
    + `<button type="button" class="sec" data-lw="dref"${lwDashS && lwDashS.busy ? ' disabled' : ''}>${esc(txf('lw.d.recount', 'Hitung ulang'))}</button></section>`;
}
function lwDashPaint(force) {
  const body = $('lwbody'), D = lwDashS; if (!body || !D) return;
  if (!force && typeof document !== 'undefined' && document.activeElement && document.activeElement.id === 'lwwkn') return; // sedang mengetik jumlah Worker: isian dan fokus tidak boleh hilang
  if (typeof lwCronFrozen === 'function' && lwCronFrozen()) return; // formulir cron terbuka: isian dan fokus tidak boleh hilang
  let h;
  if (!D.data) h = D.err ? `<p class="lwnote err" role="alert">${esc(D.err)}</p><button type="button" class="sec" data-lw="dref">${esc(txf('lw.d.retry', 'Coba lagi'))}</button>` : `<p class="lwempty">${esc(txf('lw.d.loading', 'Memuat…'))}</p>`;
  else h = (D.err ? `<p class="lwnote err" role="alert">${esc(D.err)}</p>` : '') + lwDashMemHtml(D.data) + lwDashPhpHtml(D.data, D) + lwDashMysqlHtml(D.data) + lwDashStoreHtml(D.data)
    + `<p class="lwnote">${esc(txf('lw.d.priv', 'Angka ini hanya dari perangkat ini dan tidak dikirim ke siapa pun.'))}</p>`;
  if (typeof lwCronHtml === 'function') h += lwCronHtml();
  body.innerHTML = `<div class="lwdash">${h}</div>`;
}
