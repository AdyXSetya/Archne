// js/archne-wan.js — tombol ikon + dialog Lintas jaringan, kartu undangan di chat + penyatu tumpukan MQTT/WebRTC (renderer/archne-wansetup.js, archne-wan.js, archne-rtcmux.js, archne-rtcglue.js). Dipindah dari skrip inline 0.22.0.
// Dimuat terakhir: memakai $, esc, toast dari js/archne-state-util.js. Core memegang kode dan kunci; UI hanya relay string opak.
// ---- lintas jaringan (langkah 6): layar Pengaturan + penyatu tumpukan MQTT/WebRTC (renderer/archne-wansetup.js) ----
const wanLibs = typeof ArchneWanSetup !== 'undefined' && typeof ArchneWan !== 'undefined' && typeof ArchneRtcMux !== 'undefined' && typeof ArchneRtcGlue !== 'undefined';
const wanApp = !wanLibs ? { sync: () => Promise.resolve(), on() {}, view: () => ({ state: 'error', err: txf('wan.libsMissing', 'Berkas lintas jaringan tidak termuat'), peers: [] }) } : ArchneWanSetup.createWanApp({ api: window.api, mqtt: window.mqtt, nativeWs: (window.api && window.api.wsOpen && typeof ArchneNativeWs !== 'undefined') ? ArchneNativeWs.createNativeWs(window.api) : null, createWan: ArchneWan.createWan, createRtcMux: ArchneRtcMux.createRtcMux, createRtcGlue: ArchneRtcGlue.createRtcGlue, MUX_WINDOW: ArchneRtcGlue.MUX_WINDOW, RTCPeerConnection: window.RTCPeerConnection, base64: location.protocol !== 'file:', getName: () => (S.me && S.me.name) || 'Anon' });
let wanSet = null;
const WAN_ST = { // getter: dibaca saat dipakai (mengikuti bahasa aktif)
  get waiting() { return txf('wan.st.waiting', 'menunggu'); }, get connecting() { return txf('wan.st.connecting', 'menyambung'); }, get direct() { return txf('wan.st.direct', 'langsung'); }, get relay() { return txf('wan.st.relay', 'lewat relay'); }, get failed() { return txf('wan.st.failed', 'gagal'); },
};
const turnF = () => ({ cloudflare: [['keyId', 'TURN Key ID'], ['token', txf('wan.f.token', 'API token (rahasia)'), 1]], metered: [['app', txf('wan.f.app', 'Nama app Metered')], ['apiKey', 'API key', 1]], manual: [['urls', txf('wan.f.urls', 'Alamat (turn:host:3478, pisahkan koma)')], ['username', 'Username'], ['credential', 'Credential', 1]] }); // label dibaca saat dipakai
const INV_RE = /archne:\/\/join\?[^\s"'<>]+/gi;
const INV_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M10.9 7.2L6.1 15.8M13.1 7.2l4.8 8.6M7.5 18h9"/></svg>';
const netTag = (id) => '#' + String(id || '').slice(0, 6);
const brokerHost = (b) => { try { return new URL(b).host; } catch { return String(b || ''); } };

// ---- undangan: tautan archne://join di chat jadi kartu "Tambah"; daftar yang sama muncul di dialog ----
// Core mengintip tautan (invitePeek: netId, broker, ada TURN atau tidak) tanpa menerapkannya; hasilnya di-cache per tautan.
const wanPeekC = new Map(), wanLinks = [];
let joinArm = null;
const wanLid = (link) => { let i = wanLinks.indexOf(link); if (i < 0) i = wanLinks.push(link) - 1; return i; };
function wanPeek(link) {
  let e = wanPeekC.get(link);
  if (e) return e;
  e = { st: 'wait' }; wanPeekC.set(link, e);
  const fin = (r) => { wanPeekC.set(link, r && r.ok && r.info ? { st: 'ok', info: r.info } : { st: 'bad', err: (r && r.err) || txf('wan.invBad', 'Undangan rusak') }); try { render(); wanRender(); } catch {} };
  if (!window.api || !window.api.invitePeek) fin(null); else Promise.resolve(window.api.invitePeek(link)).then(fin, () => fin(null));
  return e;
}
// Satu bentuk untuk kartu di chat dan baris di dialog: { sub, bad, btn }
function inviteParts(link) {
  const e = wanPeek(link), i = e.info, set = wanSet || {};
  if (e.st === 'wait') return { sub: txf('wan.invChecking', 'Memeriksa undangan…'), btn: '' };
  if (e.st === 'bad') return { sub: e.err, bad: true, btn: '' };
  const sub = netTag(i.netId) + ' · ' + brokerHost(i.broker) + (i.hasTurn ? ' · ' + txf('wan.invTurn', 'termasuk TURN') : '');
  if (i.current && set.enabled) return { sub, btn: '<span class="wbadge">' + esc(txf('wan.connected', 'Tersambung')) + '</span>', cur: true };
  const lab = i.current ? txf('wan.activate', 'Aktifkan') : joinArm === link ? txf('wan.sure', 'Yakin? Ketuk lagi') : set.enabled && set.hasCode ? txf('wan.switch', 'Pindah') : txf('wan.add', 'Tambah');
  return { sub, btn: `<button type="button" data-wl="${wanLid(link)}">${esc(lab)}</button>` };
}
function inviteCard(link) {
  const p = inviteParts(link);
  return `<div class="inv" data-inv="${wanLid(link)}"><span class="ii">${INV_IC}</span><div class="ib2"><div class="it">${esc(txf('wan.invCard', 'Undangan jaringan'))}</div><div class="is${p.bad ? ' err' : ''}">${esc(p.sub)}</div></div>${p.btn}${p.bad ? '' : `<button type="button" class="lnkcp" data-lcopy title="${esc(txf('wan.invCopy', 'Salin tautan undangan'))}" aria-label="${esc(txf('wan.invCopy', 'Salin tautan undangan'))}">${IC.copy}</button>`}</div>`;
}
// Dipanggil bodyHtml (archne-state-util.js). null = bukan pesan undangan.
function inviteBody(m) {
  const t = String(m.text || '');
  if (!/archne:\/\/join\?/i.test(t)) return null;
  let out = '', last = 0, mt; INV_RE.lastIndex = 0;
  while ((mt = INV_RE.exec(t))) { out += linkHtml(t.slice(last, mt.index).replace(/[\s:]+$/, '')) + inviteCard(mt[0]); last = mt.index + mt[0].length; }
  return out + linkHtml(t.slice(last));
}
function wanShared() { // tautan unik dari chat, terbaru dulu; satu baris per jaringan
  const msgs = (S.messages || []).filter((m) => !m.sys && !m.file && typeof m.text === 'string' && /archne:\/\/join\?/i.test(m.text)).sort((a, b) => b.ts - a.ts);
  const seenL = new Set(), seenN = new Set(), rows = [];
  for (const m of msgs) {
    INV_RE.lastIndex = 0; let mt;
    while ((mt = INV_RE.exec(m.text)) && rows.length < 6) {
      const link = mt[0]; if (seenL.has(link)) continue; seenL.add(link);
      const e = wanPeek(link); if (e.st === 'ok') { if (seenN.has(e.info.netId)) continue; seenN.add(e.info.netId); }
      rows.push({ link, m });
    }
  }
  return rows;
}
function wanSharedHtml() {
  const rows = wanShared();
  if (!rows.length) return '<div class="wempty">' + esc(txf('wan.sharedEmpty', 'Belum ada. Kalau temanmu membagikan undangan di chat, tampil di sini dan bisa langsung kamu tambahkan.')) + '</div>';
  return '<div class="wlist">' + rows.map(({ link, m }) => {
    const p = inviteParts(link), by = m.from === S.me.id ? txf('wan.sharedByMe', 'Dibagikan kamu') : txf('wan.sharedBy', 'Dibagikan {who}', { who: String(m.name || '?').split('#')[0] });
    return `<div class="wit${p.cur ? ' cur' : ''}"><span class="wic">${INV_IC}</span><div class="wtx2"><div class="wn">${esc(wanPeekC.get(link).info ? txf('wan.netTag', 'Jaringan {tag}', { tag: netTag(wanPeekC.get(link).info.netId) }) : txf('wan.netFriend', 'Jaringan teman'))}</div><div class="wd${p.bad ? ' err' : ''}">${p.bad ? esc(p.sub) : esc(by) + ' · ' + esc(shortWhen(m.ts))}</div></div>${p.btn}</div>`;
  }).join('') + '</div>';
}
async function wanJoin(link) {
  const e = wanPeek(link), i = e.st === 'ok' ? e.info : null, set = wanSet || {};
  if (i && !i.current && set.enabled && set.hasCode && joinArm !== link) { // dua ketukan sebelum pindah jaringan (confirm() bisa diblokir di WebView Android)
    joinArm = link; wanRender(); render();
    setTimeout(() => { if (joinArm === link) { joinArm = null; wanRender(); render(); } }, 5000);
    return;
  }
  joinArm = null;
  await wanAct(() => window.api.inviteApply(link), txf('wan.joined', 'Bergabung ke jaringan'));
  wanRender(); render();
}
if (document.addEventListener) document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-wl]'); if (!b) return; e.preventDefault(); const l = wanLinks[+b.dataset.wl]; if (l) wanJoin(l); });

function wanTurnFields() {
  const p = $('turnp').value, f = turnF()[p] || [], t = wanSet && wanSet.turn || {};
  $('turnf').innerHTML = f.map(([k, ph, sec]) => `<input type="${sec ? 'password' : 'text'}" data-k="${k}" autocomplete="off" placeholder="${esc(ph)}${sec && t.provider === p && t.hasSecret ? ' ' + esc(txf('wan.turnKept', '(tersimpan, isi ulang untuk mengubah)')) : ''}" aria-label="${esc(ph)}" style="width:100%;margin-bottom:6px">`).join('');
  if (t.provider === p) for (const el of $('turnf').querySelectorAll('input[data-k]')) { const v = t[el.dataset.k]; if (v && el.type === 'text') el.value = Array.isArray(v) ? v.join(', ') : v; }
  $('turnsave').style.display = p === 'none' ? 'none' : '';
}
function wanRender() {
  const v = wanApp.view(), set = wanSet || {};
  const b = $('wanbtn'); b.className = 'ibtn' + (set.enabled && v.state === 'online' ? ' on' : set.enabled && v.state === 'connecting' ? ' busy' : '');
  b.title = txf('wan.title', 'Lintas jaringan') + (set.enabled && v.state === 'online' ? ' · ' + tnf('wan.btnOnline', v.peers.length, 'tersambung, {count} perangkat online', { count: v.peers.length }) : set.enabled && v.state === 'connecting' ? ' · ' + txf('wan.btnConnecting', 'menyambung…') : '');
  if ($('wanmodal').style.display !== 'flex') return;
  const on = !!set.enabled, st = $('wanst'), dot = $('wandot');
  const cls = !on ? '' : v.state === 'online' ? 'ok' : v.state === 'error' ? 'err' : 'busy';
  st.className = 'wst' + (cls === 'ok' ? ' ok' : cls === 'err' ? ' err' : ''); dot.className = 'wdot' + (cls ? ' ' + cls : '');
  st.textContent = !on ? txf('wan.stOff', 'Nonaktif. Nyalakan agar bisa terhubung dengan teman di jaringan lain.') : v.state === 'online' ? tnf('wan.stOnline', v.peers.length, 'Tersambung · {count} perangkat online · Jaringan {tag}', { count: v.peers.length, tag: netTag(set.netId) }) : v.state === 'connecting' ? (v.lastErr ? txf('wan.stConnectingErr', 'Menyambung… (percobaan sebelumnya gagal: {err})', { err: v.lastErr }) : txf('wan.stConnecting', 'Menyambung…')) : v.state === 'error' ? txf('wan.stError', 'Gagal tersambung: {err}', { err: v.err || txf('wan.unknown', 'tidak diketahui') }) : (v.err ? txf('wan.stIdleErr', 'Belum tersambung: {err}.', { err: v.err }) : txf('wan.stIdle', 'Belum tersambung.'));
  $('wanon').checked = on;
  $('wanshared').innerHTML = wanSharedHtml();
  $('wanpsec').style.display = on ? '' : 'none';
  $('wanlog').textContent = (v.log || []).slice(-12).map((x) => new Date(x[0]).toTimeString().slice(0, 8) + ' ' + x[1]).join('\n') || txf('wan.logEmpty', '(kosong)');
  $('wanpeers').innerHTML = v.peers.length ? v.peers.map((p) => `<div class="wpeer"><span class="nm">${esc(p.name || '?')}</span><span class="ws ${p.state}" title="${esc(p.note || '')}">${WAN_ST[p.state]}${p.state === 'failed' && p.note ? ': ' + esc(p.note) : ''}</span></div>`).join('') : '<div class="wempty">' + esc(txf('wan.noPeers', 'Belum ada perangkat lain yang online di jaringan ini.')) + '</div>';
}
wanApp.on('change', wanRender);
async function wanLoad() { const r = await window.api.wanSettings(); if (r && r.ok) wanSet = r.settings; const hasT = wanSet && wanSet.turn && wanSet.turn.provider !== 'none'; $('wanwtl').style.display = hasT ? 'flex' : 'none'; if (!hasT) $('wanwt').checked = false; wanWarn(); if (document.activeElement !== $('wanbroker')) $('wanbroker').value = wanSet ? wanSet.broker : ''; $('turnp').value = wanSet && wanSet.turn ? wanSet.turn.provider : 'none'; wanTurnFields(); wanRender(); }
function wanWarn() { $('wanwarn').textContent = $('wanwt').checked ? txf('wan.warnTurn', 'Siapa pun yang memegang undangan ini bisa masuk jaringanmu dan memakai TURN-mu.') : txf('wan.warn', 'Siapa pun yang memegang undangan ini bisa masuk jaringanmu.'); }
async function wanAct(fn, okMsg) { const r = await fn(); if (!r || !r.ok) { toast((r && r.err) || txf('common.failed', 'Gagal')); await wanLoad(); return false; } if (okMsg) toast(okMsg, true); wanPeekC.clear(); await wanLoad(); await wanApp.sync(); wanRender(); return true; }
const wanClose = () => { $('wanmodal').style.display = 'none'; };
$('wanbtn').onclick = async () => { $('wanmodal').style.display = 'flex'; $('wanout').style.display = $('wancp').style.display = 'none'; wanRender(); await wanLoad(); };
$('wanclose').onclick = wanClose;
$('wanmodal').onclick = (e) => { if (e.target === $('wanmodal')) wanClose(); };
$('wanon').onchange = () => wanAct(() => window.api.wanEnable($('wanon').checked));
$('wanwt').onchange = wanWarn;
$('wanjoin').onclick = async () => { const t = $('wanpaste').value.trim(); if (!t) return; if (await wanAct(() => window.api.inviteApply(t), txf('wan.joined', 'Bergabung ke jaringan'))) { $('wanpaste').value = ''; render(); } };
$('wanpaste').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('wanjoin').onclick(); } };
$('wanmk').onclick = async () => { if (!wanSet || !wanSet.hasCode) { if (!(await wanAct(() => window.api.wanEnable(true)))) return; } const r = await window.api.inviteMake($('wanwt').checked); if (!r || !r.ok) { toast((r && r.err) || txf('wan.mkFail', 'Gagal membuat undangan')); return; } $('wanout').value = r.text; $('wanout').style.display = $('wancp').style.display = ''; $('wanout').select(); };
$('wancp').onclick = async () => { try { await navigator.clipboard.writeText($('wanout').value); toast(txf('wan.copied', 'Undangan disalin'), true); } catch { $('wanout').select(); toast(txf('wan.ctrlC', 'Tekan Ctrl+C untuk menyalin')); } };
let rotT = null;
$('wanrot').textContent = txf('wan.rot', 'Ganti kode'); // HTML awal tidak ber-data-i18n (teks ditimpa JS)
$('wanrot').onclick = async () => { // dua ketukan (confirm() bisa diblokir di WebView Android)
  if (!wanSet || !wanSet.hasCode) return toast(txf('wan.noCode', 'Belum ada kode'));
  if (!rotT) { $('wanrot').textContent = txf('wan.rotSure', 'Yakin? Semua peserta lama keluar. Ketuk lagi'); rotT = setTimeout(() => { rotT = null; $('wanrot').textContent = txf('wan.rot', 'Ganti kode'); }, 5000); return; }
  clearTimeout(rotT); rotT = null; $('wanrot').textContent = txf('wan.rot', 'Ganti kode'); $('wanout').style.display = $('wancp').style.display = 'none';
  await wanAct(() => window.api.wanRotate(), txf('wan.rotDone', 'Kode diganti. Buat undangan baru untuk teman.'));
};
$('wanbsave').onclick = () => wanAct(() => window.api.wanBroker($('wanbroker').value), txf('wan.brokerSaved', 'Broker disimpan'));
$('turnp').onchange = wanTurnFields;
$('turnsave').onclick = () => { const cfg = { provider: $('turnp').value }; for (const el of $('turnf').querySelectorAll('input[data-k]')) cfg[el.dataset.k] = el.value; return wanAct(() => window.api.turnSet(cfg), txf('wan.turnSavedToast', 'TURN disimpan')); };
$('turnclr').onclick = () => wanAct(() => window.api.turnClear(), txf('wan.turnClearedToast', 'TURN dihapus'));
wanLoad().then(() => render()).catch(() => {}); // render ulang: render pertama jalan sebelum skrip ini termuat, jadi tautan undangan masih berupa teks mentah.
// status ikon dan kartu undangan butuh pengaturan sejak awal, bukan baru saat dialog dibuka
wanApp.sync().catch(() => {});
