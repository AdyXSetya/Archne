// Web Lokal (0.34.0 Cronjob C7): bagian "Cron" di tab Dasbor, di bawah Memori / PHP / MySQL / Penyimpanan.
// Merakit kanal pemilik C6: webCronList / Add / Update / Remove / Run / Log / LogClear / Check + kejadian onWebCron. Hanya angka, id, domain, nama, jadwal dan jalur situs; renderer tidak menerima jalur disk maupun isi jawaban PHP.
// Semua teks dari situs / pengguna (nama, jalur, domain) disisipkan lewat esc() sebagai TEKS. Kunci kamus dinamis memakai awalan literal ('lw.cr.code.' + c) agar dikenali tes i18n.
// Keadaan lwCr hidup selama tab Dasbor terbuka (dibuat lwDashStart, dibuang lwDashStop). Kejadian onWebCron memuat ulang daftar + log (ditunda 250 ms agar beruntun jadi satu).
// Formulir: selama terbuka, lwDashPaint TIDAK menggambar ulang (fokus dan isian tidak hilang tiap 5 dtk); pesan galat dan hasil cek jadwal ditulis ke elemen kecilnya saja.
// Peringatan yang sengaja ditampilkan: jadwal sah yang tidak pernah jalan (next kosong), job gagal dengan code 'site' (situs hilang / Mesin PHP mati), dan batas Android (layanan latar).
let lwCr = null; // { jobs, limits, running, sites, loaded, loading, err, nocron, msg, form, logJob, log, logErr, t, tk }; null = bagian tidak aktif
const LW_CR_LOG = 20;
const LW_CR_CODE = { timeout: 'kehabisan waktu', run: 'gagal dijalankan', abort: 'dibatalkan', overlap: 'dilewati: masih berjalan', site: 'situs tidak ditemukan atau Mesin PHP-nya mati', busy: 'Mesin PHP sibuk', http: 'balasan galat' };
const LW_CR_REASON = { schedule: 'terjadwal', missed: 'menyusul', manual: 'manual' };
const LW_CR_STATE = { idle: 'siaga', running: 'berjalan', queued: 'antre' };
const lwCrOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lwCrArr = (a) => (Array.isArray(a) ? a : []);
const lwCrCode = (c) => (lwCrOwn(LW_CR_CODE, c) ? txf('lw.cr.code.' + c, LW_CR_CODE[c]) : txf('lw.cr.code.other', 'gagal'));
const lwCrReason = (c) => (lwCrOwn(LW_CR_REASON, c) ? txf('lw.cr.why.' + c, LW_CR_REASON[c]) : txf('lw.cr.why.other', 'lain'));
const lwCrState = (c) => (lwCrOwn(LW_CR_STATE, c) ? txf('lw.cr.st.' + c, LW_CR_STATE[c]) : '');
const lwCrErr = (r) => (r && r.err) || txf('common.error', 'Terjadi kesalahan');
function lwCrWhen(t) { // hari ini: jam saja; hari lain: tanggal + jam
  try {
    const loc = typeof uiLoc === 'function' ? uiLoc() : undefined, d = new Date(t), tm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    const same = typeof dayKey === 'function' ? dayKey(t) === dayKey(Date.now()) : d.toDateString() === new Date().toDateString();
    return same ? tm : (typeof shortWhen === 'function' ? shortWhen(t) : d.toLocaleDateString(loc, { day: 'numeric', month: 'short' })) + ' ' + tm; // satu pemformat jam saja (shortWhen memakai hm 24 jam => jam tampil dobel)
  } catch (x) { return ''; }
}
async function lwCrCall(name, ...a) { try { const f = window.api && window.api[name]; return f ? await f(...a) : null; } catch (x) { return null; } }

function lwCronStart() {
  const C = lwCr = { jobs: [], limits: null, running: null, sites: [], loaded: false, loading: false, err: '', nocron: false, msg: null, form: null, logJob: null, log: [], logErr: '', t: null, tk: 0 };
  lwCronReload(C);
}
function lwCronStop() { if (lwCr) { if (lwCr.t) clearTimeout(lwCr.t); if (lwCr.form && lwCr.form.t) clearTimeout(lwCr.form.t); } lwCr = null; }
function lwCronFrozen() { return !!(lwCr && lwCr.form && lwCr.form.painted); } // formulir terbuka: lwDashPaint tidak menggambar ulang
function lwCronPaint() { if (!lwCronFrozen() && typeof lwDashPaint === 'function') lwDashPaint(); }

async function lwCronReload(C) {
  C = C || lwCr; if (!C || C !== lwCr) return;
  if (C.loading) { C.again = true; return; }
  C.loading = true; C.again = false;
  const [r, lg] = await Promise.all([lwCrCall('webCronList'), lwCrCall('webCronLog', C.logJob ? { job: C.logJob, limit: LW_CR_LOG } : { limit: LW_CR_LOG })]);
  if (C !== lwCr) return;
  C.loading = false; C.loaded = true;
  if (r && r.ok) { C.jobs = lwCrArr(r.items); C.limits = r.limits || null; C.siteLim = r.siteLimits && typeof r.siteLimits === 'object' ? r.siteLimits : {}; C.running = r.running || null; C.nocron = false; C.err = ''; }
  else if (r && r.code === 'nocron') { C.jobs = []; C.nocron = true; C.err = ''; }
  else C.err = lwCrErr(r);
  if (C.logJob && !C.jobs.some((j) => j.id === C.logJob)) { C.logJob = null; C.again = true; } // job yang dilihat lognya sudah dihapus: kembali ke semua
  if (lg && lg.ok) { C.log = lwCrArr(lg.items); C.logErr = ''; } else C.logErr = lwCrErr(lg);
  lwCronPaint();
  if (C.again) lwCronReload(C);
}
function lwCronEvent() { const C = lwCr; if (!C) return; if (C.t) clearTimeout(C.t); C.t = setTimeout(() => { if (lwCr === C) lwCronReload(C); }, 250); }

// ---- tampilan ----
const lwCrBtn = (act, label, cls, id, dis) => `<button type="button" class="${cls || 'sec'}" data-lw="${act}"${id ? ` data-id="${esc(id)}"` : ''}${dis ? ' disabled' : ''}>${esc(label)}</button>`;
function lwCronAndroid() { const D = typeof lwDashS !== 'undefined' ? lwDashS : null; return !!(D && D.data && D.data.platform === 'android'); }
function lwCronNoteHtml() {
  let h = `<p class="lwnote">${esc(txf('lw.cr.intro', 'Cron menjalankan skrip PHP atau jalur di situsmu sesuai jadwal. Hanya kamu yang bisa membuatnya; situs dari peer tidak bisa membawa cron sendiri. Cron hanya berjalan selama Archne menyala dan hanya untuk situs yang Mesin PHP-nya menyala.'))}</p>`;
  if (lwCronAndroid()) h += `<p class="lwnote err" role="note">${esc(txf('lw.cr.android', 'Di Android, cron hanya berjalan selama layanan latar Archne hidup (notifikasi tetap tampil). Android 15 ke atas membatasi layanan latar jenis sinkronisasi data sekitar 6 jam per 24 jam; saat batas tercapai, Archne menghentikan layanannya dan cron berhenti sampai aplikasi dibuka lagi. Penghemat baterai atau “Hentikan paksa” juga menghentikannya. Matikan optimasi baterai untuk Archne agar lebih andal. Job yang terlewat hanya disusul bila aturannya “Jalankan sekali”.'))}</p>`;
  return h;
}
function lwCronJobHtml(j) {
  const L = j.last, label = j.name || j.path, warn = [];
  if (j.on && j.next === null) warn.push(txf('lw.cr.warnNever', 'Jadwal ini sah tetapi tidak punya waktu berikutnya (mis. 30 Februari), jadi tidak akan berjalan.'));
  if (L && !L.ok && L.code === 'site') warn.push(txf('lw.cr.warnSite', 'Eksekusi terakhir gagal: situs tidak ditemukan atau Mesin PHP-nya dimatikan. Nyalakan lagi Mesin PHP situs ini.'));
  const last = L ? (L.ok ? txf('lw.cr.lastOk', 'Terakhir: berhasil {when}', { when: lwCrWhen(L.endedAt) }) : txf('lw.cr.lastBad', 'Terakhir: gagal ({why}) {when}', { why: lwCrCode(L.code) + (L.status ? ' ' + L.status : ''), when: lwCrWhen(L.endedAt) })) : txf('lw.cr.lastNone', 'Belum pernah berjalan');
  const next = j.on ? (j.next === null ? '' : txf('lw.cr.next', 'Berikutnya: {when}', { when: lwCrWhen(j.next) })) : txf('lw.cr.off', 'Dimatikan');
  return `<li class="lwcrj"><div class="lwcrh"><span class="lwdn" title="${esc(j.path)}">${esc(label)}</span><span class="lwbadge">${esc(j.domain || '?')}</span><span class="lwbadge">${esc(lwCrState(j.state) || j.state)}</span>${j.on ? '' : `<span class="lwbadge">${esc(txf('lw.cr.offBadge', 'mati'))}</span>`}</div>`
    + `<div class="lwdim">${esc(j.expr)} · ${esc(j.path)}</div><div class="lwdim">${esc([next, last].filter(Boolean).join(' · '))}</div>`
    + warn.map((w) => `<p class="lwnote err" role="note">${esc(w)}</p>`).join('')
    + `<div class="lwacts">${lwCrBtn('crrun', txf('lw.cr.run', 'Jalankan'), 'sec', j.id, j.state !== 'idle')}${lwCrBtn('crtoggle', j.on ? txf('lw.cr.disable', 'Matikan') : txf('lw.cr.enable', 'Nyalakan'), 'sec', j.id)}${lwCrBtn('credit', txf('lw.cr.edit', 'Ubah'), 'sec', j.id)}${lwCrBtn('crlog', txf('lw.cr.logBtn', 'Log'), 'sec', j.id)}${lwCrBtn('crdel', txf('lw.cr.del', 'Hapus'), 'sec', j.id)}</div></li>`;
}
function lwCronLogHtml(C) {
  const job = C.logJob ? C.jobs.find((j) => j.id === C.logJob) : null, byId = new Map(C.jobs.map((j) => [j.id, j]));
  const rows = C.log.map((r) => {
    const j = byId.get(r.id), who = r.name || r.path || (j ? (j.name || j.path) : '?'), res = r.ok ? txf('lw.cr.logOk', 'berhasil') : lwCrCode(r.code) + (r.status ? ' ' + r.status : '');
    return `<li><span class="lwbadge">${esc(lwCrReason(r.reason))}</span><span class="lwdn">${esc(who)}</span><span class="lwdim">${esc(res)} · ${esc(lwCrWhen(r.endedAt))}</span></li>`;
  }).join('');
  return `<h3>${esc(job ? txf('lw.cr.logOf', 'Log: {name}', { name: job.name || job.path }) : txf('lw.cr.logT', 'Log eksekusi terakhir'))}</h3>`
    + (C.logErr ? `<p class="lwnote err" role="alert">${esc(C.logErr)}</p>` : '')
    + (rows ? `<ul class="lwdw lwcrl">${rows}</ul>` : `<p class="lwnote">${esc(txf('lw.cr.logNone', 'Belum ada catatan.'))}</p>`)
    + `<p class="lwnote">${esc(txf('lw.cr.logNote', 'Log menyimpan 20 eksekusi terakhir per job (200 total) tanpa isi jawaban.'))}</p>`
    + `<div class="lwacts">${job ? lwCrBtn('crlogall', txf('lw.cr.logAll', 'Semua job')) : ''}${lwCrBtn('crlogclear', job ? txf('lw.cr.logClearJob', 'Kosongkan log job ini') : txf('lw.cr.logClear', 'Kosongkan semua log'), 'sec', '', !C.log.length)}</div>`;
}
function lwCronHtml() {
  const C = lwCr; if (!C) return '';
  let h = `<section class="lwdc lwcr"><h3>Cron</h3>` + lwCronNoteHtml();
  if (!C.loaded) return h + `<p class="lwempty">${esc(txf('lw.d.loading', 'Memuat…'))}</p></section>`;
  if (C.msg) h += `<p class="lwnote${C.msg.ok ? '' : ' err'}" role="status">${esc(C.msg.text)}</p>`;
  if (C.err) h += `<p class="lwnote err" role="alert">${esc(C.err)}</p>`;
  if (C.nocron) return h + `<p class="lwnote">${esc(txf('e.cron.nocron', 'Cron tidak tersedia di perangkat ini'))}</p></section>`;
  if (C.form) return h + lwCronFormHtml(C.form) + '</section>';
  const lim = C.limits ? txf('lw.cr.count', '{n} dari {max} cron', { n: C.jobs.length, max: C.limits.jobs }) : '';
  h += `<div class="lwdrow"><span>${esc(lim)}</span>${C.running ? `<b>${esc(txf('lw.cr.runningNow', 'sedang berjalan'))}</b>` : ''}</div>`;
  h += C.jobs.length ? `<ul class="lwdw lwcrjl">${C.jobs.map(lwCronJobHtml).join('')}</ul>` : `<p class="lwnote">${esc(txf('lw.cr.none', 'Belum ada cron.'))}</p>`;
  h += `<div class="lwacts">${lwCrBtn('cradd', txf('lw.cr.add', 'Tambah cron'), '')}</div>` + lwCronLogHtml(C);
  return h + '</section>';
}
function lwCronFormHtml(F) {
  const f = (id, label, input, hint, st) => `<label class="lwfl" for="${id}"><span>${esc(label)}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ''}${st ? `<small id="${st}" class="lwst" aria-live="polite"></small>` : ''}</label>`;
  const sites = lwCrArr(lwCr && lwCr.sites), siteIn = F.id ? `<input id="lwcr-site" type="text" value="${esc(F.domain)}" disabled>` : `<select id="lwcr-site">${sites.map((s) => `<option value="${esc(s.id)}"${s.id === F.site ? ' selected' : ''}>${esc(s.domain)}</option>`).join('')}</select>`;
  const presets = [['@hourly', txf('lw.cr.p.hourly', 'Tiap jam')], ['@daily', txf('lw.cr.p.daily', 'Tiap hari')], ['*/5 * * * *', txf('lw.cr.p.5min', 'Tiap 5 menit')], ['0 3 * * *', txf('lw.cr.p.3am', 'Tiap 03.00')]];
  return `<div id="lwcr-form" class="lwcrf"><h3>${esc(F.id ? txf('lw.cr.formEdit', 'Ubah cron') : txf('lw.cr.formNew', 'Tambah cron'))}</h3>`
    + f('lwcr-site', txf('lw.cr.fSite', 'Situs'), siteIn)
    + f('lwcr-name', txf('lw.cr.fName', 'Nama (opsional)'), `<input id="lwcr-name" type="text" maxlength="40" autocomplete="off" value="${esc(F.name)}">`)
    + f('lwcr-expr', txf('lw.cr.fExpr', 'Jadwal'), `<input id="lwcr-expr" type="text" maxlength="100" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(F.expr)}">`, txf('lw.cr.fExprHint', '5 kolom: menit jam tanggal bulan hari (waktu perangkat ini), atau preset seperti @daily.'), 'lwcr-chk')
    + `<div class="lwacts">${presets.map((p) => `<button type="button" class="sec" data-lw="crpreset" data-e="${esc(p[0])}">${esc(p[1])}</button>`).join('')}</div>`
    + f('lwcr-path', txf('lw.cr.fPath', 'Jalur di situs'), `<input id="lwcr-path" type="text" maxlength="512" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(F.path)}">`, txf('lw.cr.fPathHint', 'Diawali “/”, mis. /cron.php. Dijalankan oleh Mesin PHP situs itu, bukan dari internet.'))
    + f('lwcr-sec', txf('lw.cr.fSec', 'Batas waktu (detik)'), `<input id="lwcr-sec" type="number" min="1" max="300" step="1" value="${esc(F.sec)}">`, txf('lw.cr.fSecHint', '1 sampai 300 detik. Lewat itu eksekusi dihentikan dan dicatat kehabisan waktu.'))
    + f('lwcr-miss', txf('lw.cr.fMiss', 'Bila terlewat'), `<select id="lwcr-miss"><option value="skip"${F.miss === 'skip' ? ' selected' : ''}>${esc(txf('lw.cr.missSkip', 'Lompati'))}</option><option value="once"${F.miss === 'once' ? ' selected' : ''}>${esc(txf('lw.cr.missOnce', 'Jalankan sekali saat Archne menyala lagi'))}</option></select>`)
    + `<label class="lwfl"><span><input id="lwcr-on" type="checkbox"${F.on ? ' checked' : ''}> ${esc(txf('lw.cr.fOn', 'Aktif'))}</span></label>`
    + `<p id="lwcr-err" class="lwnote err" role="alert"${F.err ? '' : ' hidden'}>${esc(F.err)}</p>`
    + `<div class="lwacts">${lwCrBtn('crsave', F.id ? txf('lw.form.save', 'Simpan') : txf('lw.cr.create', 'Buat'), '', '', F.busy).replace('<button ', '<button id="lwcr-save" ')}${lwCrBtn('crcancel', txf('common.cancel', 'Batal'))}</div></div>`;
}

// ---- formulir ----
async function lwCronOpen(C, job) {
  if (C.form) return;
  C.msg = null;
  let sites = C.sites;
  if (!job) {
    const r = await lwCrCall('webMine');
    if (C !== lwCr || C.form) return;
    sites = r && r.ok ? lwCrArr(r.items).filter((s) => s && s.php && typeof s.id === 'string') : [];
    C.sites = sites;
    if (!sites.length) { C.msg = { ok: false, text: txf('lw.cr.noPhp', 'Belum ada situs dengan Mesin PHP menyala. Nyalakan Mesin PHP di Pengaturan situs lebih dulu.') }; lwCronPaint(); return; }
  }
  const F = C.form = job
    ? { id: job.id, site: job.site, domain: job.domain || '?', name: job.name || '', expr: job.expr, path: job.path, sec: String(Math.round((job.ms || 300000) / 1000)), miss: job.miss === 'once' ? 'once' : 'skip', on: !!job.on, err: '', busy: false, chk: null, tk: 0, t: null, painted: false }
    : { id: null, site: C.sites[0].id, domain: '', name: '', expr: '', path: '/', sec: '300', miss: 'skip', on: true, err: '', busy: false, chk: null, tk: 0, t: null, painted: false };
  if (typeof lwDashPaint === 'function') lwDashPaint(); // gambar pertama formulir (lwCronFrozen masih false)
  F.painted = true;
  if (F.expr) lwCronCheck(C, F);
}
function lwCronClose(C) { if (C.form && C.form.t) clearTimeout(C.form.t); C.form = null; lwCronPaint(); }
function lwCronInput(el) {
  const C = lwCr, F = C && C.form; if (!F || !el) return;
  const k = String(el.id).slice(5);
  if (k === 'on') F.on = !!el.checked;
  else if (k === 'site') F.site = String(el.value);
  else if (k === 'name' || k === 'expr' || k === 'path' || k === 'sec' || k === 'miss') F[k] = String(el.value);
  else return;
  if (k === 'expr') lwCronCheckSoon(C, F);
}
function lwCronCheckSoon(C, F) { if (F.t) clearTimeout(F.t); F.t = setTimeout(() => lwCronCheck(C, F), 250); }
async function lwCronCheck(C, F) {
  const tk = ++F.tk, e = F.expr.trim();
  if (!e) { F.chk = null; lwCronChkPaint(F); return; }
  const r = await lwCrCall('webCronCheck', F.expr);
  if (C !== lwCr || C.form !== F || tk !== F.tk) return; // jawaban lama / formulir sudah ditutup
  F.chk = r && r.ok ? { ok: true, next: lwCrArr(r.next).filter((n) => Number.isFinite(n)) } : { ok: false, text: lwCrErr(r) };
  lwCronChkPaint(F);
}
function lwCronChkPaint(F) {
  const el = $('lwcr-chk'); if (!el) return;
  const c = F.chk;
  if (!c) { el.textContent = ''; el.className = 'lwst'; return; }
  if (!c.ok) { el.textContent = c.text; el.className = 'lwst err'; return; }
  if (!c.next.length) { el.textContent = txf('lw.cr.chkNever', 'Sah, tetapi tidak pernah cocok dengan tanggal mana pun (mis. 30 Februari). Cron ini tidak akan berjalan.'); el.className = 'lwst err'; return; }
  el.textContent = txf('lw.cr.chkNext', 'Berikutnya: {list}', { list: c.next.map(lwCrWhen).join(' · ') }); el.className = 'lwst';
}
function lwCronFormErr(F, text) { F.err = text || ''; const el = $('lwcr-err'); if (el) { el.textContent = F.err; el.hidden = !F.err; } const b = $('lwcr-save'); if (b) b.disabled = !!F.busy; }
async function lwCronSave(C) {
  const F = C.form; if (!F || F.busy) return;
  const sec = Number(F.sec);
  if (!F.id && !F.site) { lwCronFormErr(F, txf('lw.cr.noPhp', 'Belum ada situs dengan Mesin PHP menyala. Nyalakan Mesin PHP di Pengaturan situs lebih dulu.')); return; }
  if (F.sec.trim() === '' || !Number.isFinite(sec)) { lwCronFormErr(F, (((C.siteLim && C.siteLim[F.site] && C.siteLim[F.site].ms) || 300000) === 300000) ? txf('e.cron.ms', 'Batas waktu harus antara 1 detik dan 5 menit') : txf('e.cron.ms2', 'Batas waktu harus antara 1 dan {max} detik', { max: Math.round(((C.siteLim && C.siteLim[F.site] && C.siteLim[F.site].ms) || 300000) / 1000) })); return; }
  const f = { expr: F.expr, path: F.path, name: F.name, on: F.on, ms: Math.round(sec * 1000), miss: F.miss };
  F.busy = true; lwCronFormErr(F, '');
  let r; try { r = F.id ? await window.api.webCronUpdate(F.id, f) : await window.api.webCronAdd(Object.assign({ site: F.site }, f)); } catch (x) { r = null; }
  if (C !== lwCr || C.form !== F) return;
  F.busy = false;
  if (!r || !r.ok) { lwCronFormErr(F, lwCrErr(r)); return; }
  C.msg = { ok: true, text: txf('lw.cr.saved', 'Cron disimpan.') };
  lwCronClose(C); lwCronReload(C);
}

// ---- aksi ----
async function lwCronDo(C, name, ok, ...a) { // satu panggilan kanal; hasilnya jadi pesan, lalu muat ulang
  const r = await lwCrCall(name, ...a);
  if (C !== lwCr) return null;
  C.msg = r && r.ok ? { ok: true, text: ok } : { ok: false, text: lwCrErr(r) };
  lwCronPaint(); lwCronReload(C);
  return r;
}
async function lwCronDel(C, j) {
  const yes = await ask(txf('lw.cr.askDel', 'Hapus cron “{name}” beserta lognya?', { name: j.name || j.path }), { ok: txf('lw.cr.del', 'Hapus'), cancel: txf('common.cancel', 'Batal'), danger: true });
  if (C !== lwCr || !yes) return;
  await lwCronDo(C, 'webCronRemove', txf('lw.cr.deleted', 'Cron dihapus.'), j.id);
}
async function lwCronLogClear(C) {
  const job = C.logJob, yes = await ask(job ? txf('lw.cr.askClearJob', 'Kosongkan log job ini?') : txf('lw.cr.askClear', 'Kosongkan semua log cron?'), { ok: txf('lw.cr.logClear', 'Kosongkan'), cancel: txf('common.cancel', 'Batal'), danger: true });
  if (C !== lwCr || !yes) return;
  await lwCronDo(C, 'webCronLogClear', txf('lw.cr.cleared', 'Log dikosongkan.'), job || undefined);
}
function lwCronAct(act, d) {
  const C = lwCr; if (!C || typeof act !== 'string') return false;
  d = d || {};
  const job = () => C.jobs.find((j) => j.id === d.id);
  if (act === 'cradd') lwCronOpen(C, null);
  else if (act === 'credit') { const j = job(); if (j) lwCronOpen(C, j); }
  else if (act === 'crsave') lwCronSave(C);
  else if (act === 'crcancel') lwCronClose(C);
  else if (act === 'crpreset') { const F = C.form; if (F && typeof d.e === 'string') { F.expr = d.e; const el = $('lwcr-expr'); if (el) el.value = d.e; lwCronCheckSoon(C, F); } }
  else if (act === 'crrun') { const j = job(); if (j) lwCronDo(C, 'webCronRun', txf('lw.cr.started', 'Dijalankan. Hasilnya muncul di log.'), j.id); }
  else if (act === 'crtoggle') { const j = job(); if (j) lwCronDo(C, 'webCronUpdate', j.on ? txf('lw.cr.disabled', 'Cron dimatikan.') : txf('lw.cr.enabled', 'Cron dinyalakan.'), j.id, { on: !j.on }); }
  else if (act === 'crdel') { const j = job(); if (j) lwCronDel(C, j); }
  else if (act === 'crlog') { const j = job(); if (j) { C.logJob = j.id; lwCronReload(C); } }
  else if (act === 'crlogall') { C.logJob = null; lwCronReload(C); }
  else if (act === 'crlogclear') lwCronLogClear(C);
  else return false;
  return true;
}
if (window.api && typeof window.api.onWebCron === 'function') window.api.onWebCron(lwCronEvent);
