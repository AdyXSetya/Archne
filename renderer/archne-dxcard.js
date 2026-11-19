'use strict';
// renderer/archne-dxcard.js — tampilan daftar Kirim Langsung (v0.24.0, step 2b): fungsi murni yang menghasilkan HTML baris transfer.
// Dipisah dari archne-index.html supaya bisa dites dengan Node. Semua teks dari jaringan (nama berkas/peer, galat) di-escape.
// Tombol memakai data-act + data-id; penanganan klik ada di js/archne-direct.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DxCard = factory();
})(this, function () {
  // i18n (D2): I18N dimuat sebelum berkas ini di archne-index.html; di Node murni / tes vm lama tidak ada, maka teks Indonesia cadangan dipakai.
  const fill = (fb, p) => (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb);
  const T = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : fill(fb, p));
  const TN = (k, n, fb, p) => (typeof I18N !== 'undefined' && I18N.tn ? I18N.tn(k, n, p) : fill(fb, Object.assign({ n }, p || {})));
  const decSep = () => (typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'en' ? '.' : ','); // desimal: EN titik, ID koma
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HEX32 = /^[0-9a-f]{32}$/;

  function fmtSize(n) {
    n = Number(n) || 0;
    const sep = decSep(), r = (v, d) => v.toFixed(v < 10 ? d : 0).replace('.', sep);
    if (n < 1024) return n + ' B';
    if (n < 1048576) return r(n / 1024, 1) + ' KB';
    if (n < 1073741824) return r(n / 1048576, 1) + ' MB';
    if (n < 1099511627776) return r(n / 1073741824, 2) + ' GB';
    return r(n / 1099511627776, 2) + ' TB';
  }
  const fmtSpeed = (v) => (v > 0 ? fmtSize(v) + T('dxc.perSec', '/dtk') : '');
  function fmtEta(left, speed) {
    if (!(speed > 0) || !(left > 0)) return '';
    const s = Math.ceil(left / speed);
    if (s < 60) return T('dxc.eta.s', '{s} dtk', { s });
    if (s < 3600) return T('dxc.eta.m', '{m} mnt {s} dtk', { m: Math.floor(s / 60), s: s % 60 });
    if (s < 86400) return T('dxc.eta.h', '{h} j {m} mnt', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
    return T('dxc.eta.day', '> 1 hari');
  }
  const pct = (done, total) => (total > 0 ? Math.max(0, Math.min(100, Math.floor((done * 100) / total))) : 0);
  // Teks progres: "42% · 1,2 GB / 3,0 GB · 85 MB/dtk · sisa 21 dtk"
  function progressText(done, total, speed) {
    const parts = [pct(done, total) + '%', fmtSize(done) + ' / ' + fmtSize(total)];
    const sp = fmtSpeed(speed); if (sp) parts.push(sp);
    const eta = fmtEta(total - done, speed); if (eta) parts.push(T('dxc.left', 'sisa {eta}', { eta }));
    return parts.join(' · ');
  }

  const KIND = (k, count) => (k === 'file' ? T('pg.defFile', 'berkas') : TN('dxc.files', Number(count) || 0, '{count} berkas', { count: Number(count) || 0 }));
  // Pesan galat yang bisa dipahami orang (kode dari Core: src/archne-direct.js TEXT). retry: apakah "Lanjutkan" masuk akal.
  // Pesan galat (kode dari Core). Getter: teks dibaca saat dipakai, jadi mengikuti bahasa aktif.
  const CODE_DEF = {
    restart: ['dxc.code.restart', 'Aplikasi sempat ditutup. Tekan Lanjutkan bila pengirim online.'],
    stall: ['dxc.code.stall', 'Koneksi macet terlalu lama. Tekan Lanjutkan bila pengirim online.'],
    net: ['dxc.code.net', 'Koneksi terputus.'],
    timeout: ['dxc.code.timeout', 'Koneksi macet.'],
    gone: ['dxc.code.gone', 'Pengirim sudah membatalkan atau menghapus sesi ini.'],
    denied: ['dxc.code.denied', 'Pengirim menolak permintaan ini.'],
    changed: ['dxc.code.changed', 'Berkas di pengirim berubah atau hilang.'],
    lan: ['dxc.code.lan', 'Kirim Langsung hanya untuk jaringan lokal (LAN).'],
    disk: ['dxc.code.disk', 'Disk penuh.'],
    io: ['dxc.code.io', 'Gagal menulis ke disk.'],
    unsafe: ['dxc.code.unsafe', 'Nama berkas dari pengirim tidak aman.'],
    busy: ['dxc.code.busy', 'Pengirim sedang sibuk.'],
    proto: ['dxc.code.proto', 'Jawaban pengirim tidak sesuai protokol.'],
    bad: ['dxc.code.bad', 'Permintaan tidak valid.'],
    range: ['dxc.code.range', 'Posisi lanjut tidak valid.'],
  };
  const CODE_TEXT = {};
  for (const c of Object.keys(CODE_DEF)) Object.defineProperty(CODE_TEXT, c, { enumerable: true, get: () => T(CODE_DEF[c][0], CODE_DEF[c][1]) });
  const whyText = (it) => esc(CODE_TEXT[it.code] || it.err || ''); // i18n (E3): peta kode (diterjemahkan) lebih dulu; it.err dari Core hanya cadangan untuk kode yang tidak dipetakan

  // Tombol ikon bundar (Step 3, gaya sama dengan kartu berkas): label jadi title + aria-label. 'f' = ikon terisi; 'dng' = ikon merah (membatalkan/menghapus).
  const FOLDER = 'M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2z';
  const ICON = {
    accept: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14', acceptas: FOLDER, decline: 'M6 6l12 12M18 6L6 18', pause: 'M9 5.5v13M15 5.5v13',
    resume: { f: 1, d: 'M8 5.2v13.6a.6.6 0 00.9.5l11-6.8a.6.6 0 000-1l-11-6.8a.6.6 0 00-.9.5z' }, cancel: 'M6 6l12 12M18 6L6 18', cancelout: 'M6 6l12 12M18 6L6 18',
    opendir: FOLDER, remove: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  };
  const DNG = { decline: 1, cancel: 1, cancelout: 1, remove: 1 };
  const icon = (act) => { const v = ICON[act]; if (!v) return ''; const f = typeof v === 'object'; return `<svg viewBox="0 0 24 24" aria-hidden="true"${f ? ' class="f"' : ''}><path d="${f ? v.d : v}"/></svg>`; };
  const btn = (act, id, label, cls) => `<button type="button" class="dxb ic-btn${cls ? ' ' + cls : ''}${DNG[act] ? ' dng' : ''}" data-act="${act}" data-id="${esc(id)}" title="${esc(label)}" aria-label="${esc(label)}">${icon(act) || esc(label)}</button>`;
  const bar = (id, done, total) => `<div class="dxbar"><i data-dxbar="${esc(id)}" style="width:${pct(done, total)}%"></i></div><div class="dxpt" data-dxpt="${esc(id)}">__PT__</div>`;

  // Satu baris. dir: 'in' | 'out'. Item = ringkasan dari Core (directState().in / .out).
  function rowHtml(it, dir) {
    if (!it || !HEX32.test(String(it.id))) return '';
    const id = it.id, st = it.state, inn = dir === 'in';
    const who = esc(inn ? it.fromName || T('dxc.someone', 'Seseorang') : it.toName || T('dxc.someone', 'Seseorang'));
    const done = inn ? it.done : it.sent, total = it.total;
    const head = `<div class="dxh"><span class="dxn" title="${esc(it.name)}">${esc(it.name)}</span><span class="dxs">${esc(fmtSize(total))} · ${esc(KIND(it.kind, it.count))}</span></div>`;
    let info = '', acts = '', prog = '', cls = st;
    const live = bar(id, done, total).replace('__PT__', esc(progressText(done, total, inn ? it.speed : 0)));
    if (inn) {
      if (st === 'offered') { info = T('dxc.offerIn', '{who} ingin mengirim lewat jaringan lokal.', { who }); acts = btn('accept', id, T('dlg.accept', 'Terima')) + btn('acceptas', id, T('dxc.pickDir', 'Pilih folder…'), 'sec') + btn('decline', id, T('profile.decline', 'Tolak'), 'sec'); }
      else if (st === 'listing') info = T('dxc.listing', 'Mengambil daftar berkas…');
      else if (st === 'running') { prog = live; acts = btn('pause', id, T('common.pause', 'Jeda'), 'sec') + btn('cancel', id, T('common.cancel', 'Batal'), 'sec'); }
      else if (st === 'waiting') { info = T('dxc.reconnect', 'Menyambung ulang ke pengirim…'); prog = live; acts = btn('pause', id, T('common.pause', 'Jeda'), 'sec') + btn('cancel', id, T('common.cancel', 'Batal'), 'sec'); }
      else if (st === 'paused') { info = whyText(it) || T('dxc.paused', 'Dijeda.'); prog = live; acts = btn('resume', id, T('dlg.continue', 'Lanjutkan')) + btn('cancel', id, T('common.cancel', 'Batal'), 'sec'); }
      else if (st === 'done') {
        info = it.failed > 0 ? TN('dxc.doneFail', Number(it.failed), 'Selesai, tapi {count} berkas gagal (berubah/hilang di pengirim).', { count: Number(it.failed) }) : T('dxc.done', 'Selesai.');
        acts = btn('opendir', id, T('dxc.openDir', 'Buka folder')) + btn('remove', id, T('dxc.remove', 'Hapus dari daftar'), 'sec');
      } else if (st === 'error') {
        info = whyText(it) || T('dxc.failedDot', 'Gagal.');
        acts = (it.code === 'gone' ? '' : btn('resume', id, T('common.retry', 'Coba lagi'))) + btn('cancel', id, T('common.cancel', 'Batal'), 'sec');
      } else if (st === 'cancelled') { info = whyText(it) || T('arc.cancelled', 'Dibatalkan.'); acts = btn('remove', id, T('dxc.remove', 'Hapus dari daftar'), 'sec'); }
    } else {
      if (st === 'offered') { info = T('dxc.waitAccept', 'Menunggu {who} menerima…', { who }); acts = btn('cancelout', id, T('common.cancel', 'Batal'), 'sec'); }
      else if (st === 'active') { info = T('dxc.fetching', '{who} sedang mengambil. Biarkan aplikasi tetap terbuka.', { who }); prog = live; acts = btn('cancelout', id, T('common.cancel', 'Batal'), 'sec'); }
      else if (st === 'done') { info = T('dxc.sentTo', 'Terkirim ke {who}.', { who }); acts = btn('remove', id, T('dxc.remove', 'Hapus dari daftar'), 'sec'); }
      else if (st === 'declined') { info = T('dxc.declined', '{who} menolak.', { who }); acts = btn('remove', id, T('dxc.remove', 'Hapus dari daftar'), 'sec'); }
      else if (st === 'cancelled') { info = T('arc.cancelled', 'Dibatalkan.'); acts = btn('remove', id, T('dxc.remove', 'Hapus dari daftar'), 'sec'); }
    }
    const tag = `<span class="dxd">${esc(inn ? T('dxc.tagIn', 'Masuk') : T('dxc.tagOut', 'Keluar'))}</span>`;
    return `<div class="dxr ${esc(cls)}" data-dxrow="${esc(id)}" data-dir="${dir}">${tag}${head}${info ? `<div class="dxi">${info}</div>` : ''}${prog}${acts ? `<div class="dxa">${acts}</div>` : ''}</div>`;
  }

  // Urutan: tawaran masuk yang menunggu keputusan dulu, lalu yang aktif, lalu sisanya (terbaru di atas).
  const RANK = { offered: 0, listing: 1, running: 1, waiting: 1, active: 1, paused: 2, error: 2 };
  function listHtml(state) {
    const all = [];
    for (const it of (state && state.in) || []) all.push({ it, dir: 'in' });
    for (const it of (state && state.out) || []) all.push({ it, dir: 'out' });
    if (!all.length) return '<div class="dxe">' + esc(T('dxc.empty', 'Belum ada transfer. Buka chat pribadi dengan teman di jaringan yang sama, lalu pilih Kirim Langsung.')) + '</div>';
    all.sort((a, b) => (RANK[a.it.state] ?? 3) - (RANK[b.it.state] ?? 3) || (b.it.ts || 0) - (a.it.ts || 0));
    return all.map((x) => rowHtml(x.it, x.dir)).join('');
  }
  // Jumlah tawaran masuk yang menunggu keputusan (lencana di tombol).
  const pending = (state) => (((state && state.in) || []).filter((x) => x.state === 'offered')).length;

  // Boleh kirim langsung ke peer ini? Hanya peer online di jaringan lokal (peer.lan dari Core). title dipakai sebagai tooltip tombol.
  function sendGate(peer) {
    if (!peer) return { ok: false, why: 'none', title: T('dx.title', 'Kirim Langsung') };
    if (!peer.lan) return { ok: false, why: 'lan', title: T('dxc.gateLan', 'Kirim Langsung hanya untuk teman di jaringan lokal (LAN) yang sama') };
    if (!peer.online) return { ok: false, why: 'offline', title: T('dxc.gateOffline', 'Kirim Langsung butuh kedua pihak online. {name} sedang offline', { name: peer.name || T('badge.friend', 'Teman') }) };
    return { ok: true, why: '', title: T('dxc.gateOk', 'Kirim Langsung: berkas atau folder tanpa batas ukuran, lewat LAN') };
  }

  return { sendGate, esc, fmtSize, fmtSpeed, fmtEta, pct, progressText, rowHtml, listHtml, pending, CODE_TEXT };
});
