'use strict';
// Sesi penampil situs untuk Android / peramban (0.34.0 Fase F.3.3b). Pasangan createSiteBrowser (Electron) dengan antarmuka yang SAMA untuk archne-ipc.js
// (deps.site: open / nav / refresh / setTop / close / confirmExternal / dismissExternal / dispose / state / isOpen), tetapi tanpa tampilan: tampilannya iframe di UI (F.3.5),
// dan isinya dilayani archne-siteserver.js lewat rpc.siteHost. Sesi ini hanya memegang siklus pembukaan: ambil manifest (fetchSiteShared, kode yang SAMA dengan Electron),
// pasang ke siteHost (jar baru tiap open), dan umumkan status lewat send(state) (kejadian 'sitestate').
//
// Beda dari Electron, sengaja:
//  - Riwayat (kembali / maju / muat ulang), judul, dan jalur ada di iframe, jadi di sini path/title/canBack/canFwd/loading selalu kosong dan nav() tidak berbuat apa-apa
//    ({ ok:false, code:'client' } untuk aksi yang sah): UI-lah yang menjalankannya (F.3.5).
//  - refresh() hanya memperbarui isi yang dilayani; memuat ulang iframe tugas UI sesudah balasan ok.
//  - Tautan http(s) keluar tidak lewat sini (confirmExternal selalu "kedaluwarsa"): iframe tidak bisa membuka peramban luar dari proses ini.
//  - open() dan state menyertakan `url` (http://<siteId>.lw.localhost:PORT/<entry>) untuk src iframe; origin itu terpisah dari UI (spike A.2).
// Nama pemilik SELALU dari core (deps.nameOf), tidak pernah dari renderer atau situs.
const SB = require('./archne-sitebrowser');
const { createPhpGate } = require('./archne-phpgate');
const { makeRemoteSend } = require('./archne-siteremote');
const { tryDomain } = require('./archne-webdomain');
const { ek, errText } = require('./core/archne-ecode');
const PW = require('./archne-pwdetect'); // G.2b

const HEX16 = /^[0-9a-f]{16}$/;
const ACTIONS = new Set(['back', 'forward', 'reload', 'stop']);

function createSiteSession(deps) {
  if (!deps || !deps.core || !deps.siteHost) throw new Error('createSiteSession: core dan siteHost wajib');
  const core = deps.core, host = deps.siteHost, log = deps.log || function () {};
  const php = deps.php || null; // host mesin PHP perangkat ini (archne-phphost.js); tanpa itu situs PHP MILIK SENDIRI = galat phpoff, situs PHP peer tetap bisa dibuka (jalan di perangkat pemilik lewat lw_req)
  const send = (st) => { try { deps.send && deps.send(st); } catch {} };
  let rac = null, phpSite = ''; // pembatal permintaan situs PHP peer; situs PHP yang Worker-nya dipegang sesi ini (dihentikan saat ditutup / diganti)
  const stopPhp = () => { if (rac) { try { rac.abort(); } catch {} rac = null; } const id = phpSite; phpSite = ''; if (id && php) { try { php.stop(id); } catch {} } };
  let seq = 0, ac = null, phase = 'idle', progress = null, opening = null, info = null, closed = false; // info = { ownerId, siteId, domain, own, priv } milik pembukaan yang sedang dilayani

  const ownerName = (id) => { let n = ''; try { n = deps.nameOf ? deps.nameOf(id) : ''; } catch {} return typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 32) : ''; };
  const cur = () => (info ? host.cur : null);
  const urlOf = () => { const c = cur(); return c ? host.urlOf(c.siteId, c.entry) : ''; };
  const state = (extra) => {
    const c = cur(), o = c ? info : opening; // saat menyinkronkan, bilah sudah tahu siapa pemiliknya (nama dari core)
    return Object.assign({
      open: !!c, status: phase, siteId: o ? o.siteId : '', peerId: o ? o.ownerId : '', domain: o ? o.domain : '', owner: o && !o.own ? ownerName(o.ownerId) : '', own: !!(c && info.own), pw: !!(c && info.pw), priv: c && info.own ? info.priv : '',
      link: o ? SB.linkOf(o) : '', rev: c ? c.rev : 0, offline: !!(c && c.offline), stale: !!(c && c.stale), progress, path: '', title: '', canBack: false, canFwd: false, loading: false, url: urlOf(),
    }, extra || {});
  };
  const push = (extra) => send(state(extra));
  const fetch = (ownerId, siteId, my) => SB.fetchSiteShared(core, log, ownerId, siteId, {
    php: !!php, remote: true,
    setAc: (a) => { ac = a; },
    onProgress: (p) => { if (my === seq) { progress = { done: p.done, total: p.total }; push(); } },
    mine: () => my === seq,
  });
  const fail = SB.fail;

  // Buka situs milik peer. Balasan async: { ok:true, rev, offline, stale, url } | { ok:false, err, code }. Panggilan baru membatalkan yang masih berjalan.
  async function open(a) {
    if (!a || typeof a !== 'object' || typeof a.peerId !== 'string' || !HEX16.test(a.peerId) || typeof a.siteId !== 'string' || !HEX16.test(a.siteId)) return fail('e.site.bad', 'Situs tidak valid', 'bad');
    if (closed) return fail('e.site.none', 'Penampil situs tidak tersedia', 'none');
    const domain = typeof a.domain === 'string' ? (tryDomain(a.domain) || '') : '';
    const my = ++seq;
    if (ac) { try { ac.abort(); } catch {} }
    host.clear(); stopPhp(); info = null; progress = null; phase = 'syncing'; // situs sebelumnya langsung berhenti dilayani (iframe lama dapat 404), sama dengan teardown() di Electron
    opening = { ownerId: a.peerId, siteId: a.siteId, domain };
    push({ open: true });
    const r = await fetch(a.peerId, a.siteId, my);
    if (my !== seq) return { ok: false, err: '', code: 'cancel' }; // digantikan open / close yang lebih baru
    opening = null;
    if (r.err) { phase = 'error'; push({ open: false, error: r.err.err }); return r.err; }
    // Situs PHP (P.3, sama dengan createSiteBrowser): pratinjau pemilik -> router lokal (Worker dinyalakan DULU); situs peer -> lw_req ke perangkat pemilik. Dimuat dari akar "/" (entry kosong).
    let gateFor = null;
    if (r.remote) {
      rac = new AbortController();
      const sig = rac.signal;
      gateFor = (jar) => createPhpGate({ jar, send: makeRemoteSend(core, a.peerId, a.siteId, r.first, r.firstAt, sig), host: a.siteId, peer: '' });
    } else if (r.php) {
      let router = null, bad = null;
      try { router = php.router(a.siteId); phpSite = a.siteId; await router.warm(); } catch (e) { bad = e; }
      if (my !== seq) return { ok: false, err: '', code: 'cancel' }; // Worker-nya dihentikan oleh open / close yang menggantikan (jangan stop di sini: bisa situs yang sama dan Worker barunya)
      if (bad) {
        stopPhp(); log('sitesession: mesin PHP gagal ' + (bad.code || bad.message));
        const f = fail('e.site.phpFail', 'Mesin PHP gagal dimulai', 'phpfail'); phase = 'error'; push({ open: false, error: f.err }); return f;
      }
      const me = core && typeof core.id === 'string' && HEX16.test(core.id) ? core.id : '';
      gateFor = (jar) => createPhpGate({ jar, send: (rq) => router.handle(rq), host: a.siteId, peer: me });
    }
    info = { ownerId: a.peerId, siteId: a.siteId, domain: r.own ? r.domain : domain, own: !!r.own, priv: r.priv, gate: !!gateFor }; // situs sendiri: domain dari catatan situs, bukan dari renderer
    const inf = info;
    const c = host.open(Object.assign({ ownerId: a.peerId, siteId: a.siteId, domain: info.domain, own: info.own, priv: info.priv, entry: gateFor ? '' : r.man.entry, rev: r.man.rev, files: SB.filesOf(r.man), offline: r.offline, stale: r.stale, onPw: PW.hook(inf, () => info === inf, push) }, gateFor ? { gateFor } : {}));
    phase = 'ready'; progress = null;
    push();
    return { ok: true, rev: c.rev, offline: c.offline, stale: c.stale, url: urlOf() };
  }

  async function close() {
    seq++;
    if (ac) { try { ac.abort(); } catch {} }
    host.clear(); stopPhp(); info = null; opening = null; progress = null; phase = 'idle';
    send({ open: false, status: 'idle', siteId: '', peerId: '', domain: '', owner: '', own: false, priv: '', link: '', rev: 0, offline: false, stale: false, progress: null, path: '', title: '', canBack: false, canFwd: false, loading: false, url: '' });
    return { ok: true };
  }
  const dispose = () => { closed = true; close().catch(() => {}); };

  function nav(action) {
    if (!ACTIONS.has(action)) return { ok: false, err: errText(ek('e.web.badAction', null, 'Aksi tidak dikenal')) };
    return { ok: false, code: 'client' }; // riwayat ada di iframe (UI)
  }

  // Ambil ulang dari pemilik (berbeda dengan open: jar cookie dan situs tetap). Iframe dimuat ulang oleh UI sesudah balasan ok.
  async function refresh() {
    const c = cur();
    if (!c) return { ok: false };
    const my = ++seq, { ownerId, siteId } = info;
    phase = 'syncing'; push();
    const r = await fetch(ownerId, siteId, my);
    if (my !== seq || !cur()) return { ok: false, code: 'cancel' };
    phase = 'ready'; progress = null;
    if (r.err) { push({ error: r.err.err }); return r.err; }
    if (!!r.php !== !!info.gate) { const f = fail('e.site.phpMode', 'Mode PHP situs berubah. Buka ulang situsnya.', 'mode'); push({ error: f.err }); return f; } // saklar Mesin PHP diubah saat terbuka: gerbang tidak dipasang / dilepas di tengah jalan
    host.refresh({ entry: info.gate ? '' : r.man.entry, rev: r.man.rev, files: SB.filesOf(r.man), offline: r.offline, stale: r.stale });
    if (r.own) { info.domain = r.domain; info.priv = r.priv; }
    push();
    return { ok: true, rev: c.rev, offline: c.offline, stale: c.stale, url: urlOf() };
  }

  const setTop = () => ({ ok: true }); // tinggi bilah mengatur tampilan native di Electron; di sini UI menata iframe sendiri
  const confirmExternal = async () => ({ ok: false, err: errText(ek('e.site.extGone', null, 'Permintaan membuka tautan sudah kedaluwarsa')), code: 'gone' });
  const dismissExternal = () => ({ ok: true });

  return { open, close, refresh, nav, setTop, confirmExternal, dismissExternal, dispose, state, get isOpen() { return !!cur(); } };
}

module.exports = { createSiteSession };
