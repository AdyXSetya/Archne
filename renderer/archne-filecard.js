'use strict';
// Tampilan berkas (v0.7.0 tahap 5b): fungsi murni yang menghasilkan HTML kartu berkas dan pekerjaan kirim.
// Dipisah dari archne-index.html supaya bisa dites dengan Node. Semua teks dari jaringan (nama berkas, pesan galat) di-escape.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FileCard = factory();
})(this, function () {
  // i18n (D1): I18N dimuat sebelum berkas ini di archne-index.html; di Node murni / tes vm lama I18N tidak ada, maka teks Indonesia cadangan dipakai.
  const fill = (fb, p) => (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb);
  const T = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : fill(fb, p));
  const TN = (k, n, fb, p) => (typeof I18N !== 'undefined' && I18N.tn ? I18N.tn(k, n, p) : fill(fb, Object.assign({ n }, p || {})));
  // pemisah desimal ukuran berkas mengikuti bahasa: EN titik, ID koma (juga bila I18N tidak dimuat)
  const decSep = () => (typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'en' ? '.' : ',');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSize(n) {
    n = Number(n) || 0;
    const sep = decSep(), r = (v, d) => v.toFixed(v < 10 ? d : 0).replace('.', sep);
    if (n < 1024) return n + ' B';
    if (n < 1048576) return r(n / 1024, 1) + ' KB';
    if (n < 1073741824) return r(n / 1048576, 1) + ' MB';
    return r(n / 1073741824, 2) + ' GB';
  }
  const pct = (done, total) => (total > 0 ? Math.max(0, Math.min(100, Math.floor((done * 100) / total))) : 0);

  // Teks kemajuan singkat (v0.25.1): unduh = "42% · 3,1 MB / 7,0 MB"; fase lain hanya persen.
  function progressText(phase, done, total) {
    const p = pct(done, total) + '%';
    return phase === 'download' ? `${p} · ${fmtSize(done)} / ${fmtSize(total)}` : phase === 'unpack' ? T('fc.prog.unpack', 'Menyimpan {p}', { p }) : phase === 'pack' ? T('fc.prog.pack', 'Menyiapkan {p}', { p }) : T('fc.prog.work', 'Memproses {p}', { p });
  }

  // Ekstensi yang bisa dieksekusi. Daftar yang sama dipakai src/archne-ipc.js untuk menolak openFile; test/ui.js memastikan keduanya tidak menyimpang.
  const RISKY = ['.exe', '.com', '.scr', '.pif', '.msi', '.msp', '.msix', '.appx', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe',
    '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.lnk', '.url', '.scf', '.reg', '.inf', '.cpl', '.dll', '.sys', '.gadget', '.apk', '.xapk', '.apks', '.apkm', '.aab', '.dex'];
  const isRisky = (name) => { const m = /\.[^.\\/]*$/.exec(String(name || '')); return !!m && RISKY.includes(m[0].toLowerCase()); };

  // Foto (v0.25.0 Step 1): kartu menampilkan thumbnail dari tawaran (x.th) bila jenisnya foto. Klaim pengirim tidak dipercaya begitu saja:
  // thumbnail hanya tampil bila nama berkas berekstensi gambar dan tidak berisiko, supaya "invoice.pdf" tidak bisa menyamar dengan foto lucu.
  // Yang menentukan bisa-tidaknya dibuka di penampil tetap isi berkas (diperiksa Core saat mediaRead). Daftar ekstensi sama dengan src/archne-mediacheck.js.
  const THUMB_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|heic|heif)$/i, VIEW_EXT = /\.(jpe?g|jfif|png|gif|webp)$/i;
  // Pemutar bawaan (v0.25.0 Step 2): daftar ekstensi sama dengan src/archne-mediacheck.js (dijaga test/mediaplay.js). Isi tetap diperiksa Core saat diputar.
  const AUD_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i, VID_EXT = /\.(mp4|m4v|webm)$/i;
  const playKind = (n) => (AUD_EXT.test(String(n || '')) ? 'aud' : VID_EXT.test(String(n || '')) ? 'vid' : '');
  const TH_BOX = 240; // sisi terpanjang thumbnail di layar (px)
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const hasThumb = (f, risky) => !!(f.x && f.x.k === 'img' && typeof f.x.th === 'string' && f.x.th.length % 4 === 0 && B64.test(f.x.th) && !risky && THUMB_EXT.test(String(f.name || '')));
  // Thumbnail video (Step 3): x.k === 'vid' + JPEG kecil; hanya untuk ekstensi yang diputar bawaan dan tidak berisiko.
  const hasVThumb = (f, risky) => !!(f.x && f.x.k === 'vid' && typeof f.x.th === 'string' && f.x.th.length % 4 === 0 && B64.test(f.x.th) && !risky && VID_EXT.test(String(f.name || '')));
  // Pesan suara (Step 4): x.k === 'vc' dengan durasi, hanya bila nama berekstensi suara (sama dengan src/archne-fileoffer.js VC_NAME) dan tidak berisiko.
  // Core sudah membuang `x` yang ukurannya tidak wajar; di sini klaim itu tetap hanya mengubah tampilan kartu, tidak pernah memutar apa pun sendiri.
  const VC_NAME = /\.(weba|ogg|m4a)$/i;
  const hasVc = (f, risky) => !!(f.x && f.x.k === 'vc' && Number.isSafeInteger(f.x.d) && f.x.d > 0 && !risky && VC_NAME.test(String(f.name || '')));
  const fmtClock = (ms) => { const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  // ---- Ikon (v0.25.1): kartu tanpa teks tombol; semua aksi berupa ikon bundar dengan title/aria-label. Aksi lain ada di menu ⋮ (menuItems).
  const IP = {
    dl: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14', play: 'M8 5.2v13.6a.6.6 0 00.9.5l11-6.8a.6.6 0 000-1l-11-6.8a.6.6 0 00-.9.5z', x: 'M6 6l12 12M18 6L6 18',
    more: 'M12 6.8a1.8 1.8 0 110-3.6 1.8 1.8 0 010 3.6zm0 7a1.8 1.8 0 110-3.6 1.8 1.8 0 010 3.6zm0 7a1.8 1.8 0 110-3.6 1.8 1.8 0 010 3.6z',
    pause: 'M9 5.5v13M15 5.5v13', check: 'M5 12.5l4.5 4.5L19 7.5', cloud: 'M7.5 18.5a4.5 4.5 0 01-.4-8.98 5.5 5.5 0 0110.6 1.4 3.8 3.8 0 01-.7 7.58z', file: 'M7 3h7l5 5v13H7zM14 3v5h5',
    mic: 'M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-3.1A7 7 0 0019 11h-2z',
    music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm10-2a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z', film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5h.01', warn: 'M12 4l9 16H3zM12 10v4.5M12 17.5h.01', retry: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
    ext: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5', folder: 'M3 6h6l2 2.5h12V19H3z', clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4.5l3 1.5', info: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 11v5M12 8h.01',
  };
  const IFILL = { play: 1, more: 1, mic: 1 };
  const ico = (n) => `<svg class="ic${IFILL[n] ? ' f' : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${IP[n]}"/></svg>`;
  const ib = (act, id, icon, label, cls, risky) => `<button type="button" class="fb ic-btn${cls ? ' ' + cls : ''}" data-act="${act}" data-id="${esc(id)}"${risky ? ' data-risky="1"' : ''} title="${esc(label)}" aria-label="${esc(label)}">${ico(icon)}</button>`;
  const chip = (cls, icon, text, title) => `<span class="fst ${cls}" title="${esc(title)}">${ico(icon)}${text ? `<b>${esc(text)}</b>` : ''}</span>`;
  const warnLine = (t, cls) => `<div class="fs ${cls || 'warn'}">${ico('warn')}<span>${esc(t)}</span></div>`;
  const fmoreBtn = (id) => `<button type="button" class="fmore" data-menu="${esc(id)}" title="Menu" aria-label="${esc(T('fc.menuAria', 'Menu berkas'))}" aria-haspopup="menu">${ico('more')}</button>`;

  function thumbHtml(m, f, state, extra) {
    const x = f.x;
    let st = '';
    if (Number.isSafeInteger(x.w) && Number.isSafeInteger(x.h) && x.w > 0 && x.h > 0) {
      const k = Math.min(1, TH_BOX / Math.max(x.w, x.h)), r = x.w / x.h;
      st = ` style="width:${Math.max(40, Math.round(x.w * k))}px${r >= 0.2 && r <= 5 ? `;aspect-ratio:${x.w}/${x.h}` : ''}"`;
    }
    const img = `<img src="data:image/jpeg;base64,${x.th}" alt="" draggable="false">`;
    const vid = x.k === 'vid';
    const dur = vid && Number.isSafeInteger(x.d) && x.d > 0 ? `<span class="fthd">${esc(fmtClock(x.d))}</span>` : '';
    const mid = state === 'recv' ? `<span class="fthp">${ico('dl')}</span>` : state === 'play' ? `<span class="fthp">${ico('play')}</span>` : '';
    const badge = state === 'recv' ? `<span class="fthb">${esc(fmtSize(f.size))}</span>` : '';
    const t = state === 'view' || state === 'recv' || state === 'play'
      ? `<button type="button" class="fth ${state}" data-act="${state}" data-id="${esc(m.id)}"${st} aria-label="${esc(state === 'view' ? T('fc.thView', 'Lihat foto {name}', { name: f.name }) : state === 'play' ? T('fc.thPlay', 'Putar video {name}', { name: f.name }) : vid ? T('fc.thDlVid', 'Unduh video {name}', { name: f.name }) : T('fc.thDlImg', 'Unduh foto {name}', { name: f.name }))}">${img}${mid}${dur}${badge}</button>`
      : `<div class="fth"${st}>${img}${dur}</div>`;
    return `<div class="fthw">${t}${extra || ''}</div>`;
  }

  // Pesan galat penerimaan yang bisa dipahami orang. retry=false: mengulang pasti gagal lagi, jadi tombolnya "Tutup", bukan "Coba lagi".
  // Pesan galat penerimaan yang bisa dipahami orang. retry=false: mengulang pasti gagal lagi, jadi tombolnya "Tutup", bukan "Coba lagi".
  // Tabel berisi [kunci kamus, teks Indonesia cadangan, bisa diulang]; teks dibaca saat dipakai (rxError), jadi mengikuti bahasa aktif.
  const RX_ERR = {
    gone: ['fc.rx.gone', 'Pengirim sudah membatalkan berkas ini atau tidak lagi menyimpannya.', false],
    denied: ['fc.rx.denied', 'Kamu tidak berhak mengambil berkas ini.', false],
    limit: ['fc.rx.limit', 'Berkas melebihi batas ukuran yang diizinkan.', false],
    meta: ['fc.rx.meta', 'Daftar isi berkas tidak sah. Minta pengirim mengirim ulang.', false],
    changed: ['fc.rx.changed', 'Berkas di komputer pengirim berubah atau hilang setelah ditawarkan. Minta pengirim mengirim ulang.', false],
    net: ['fc.rx.net', 'Tidak bisa terhubung ke pengirim, kurir, maupun peer lain yang memegang berkas ini. Pastikan salah satunya online.', true],
    timeout: ['fc.rx.timeout', 'Koneksi macet. Coba lagi.', true],
    busy: ['fc.rx.busy', 'Pengirim sedang melayani terlalu banyak unduhan. Coba lagi sebentar lagi.', true],
    relaycap: ['fc.rx.relaycap', 'Berkas ini terlalu besar untuk jalur relay (batas antar jaringan di pengirim). Coba lagi saat kalian satu jaringan atau terhubung langsung.', false],
    nokey: ['fc.rx.nokey', 'Kunci enkripsi belum tersedia. Tunggu pengirim online, lalu coba lagi.', true],
    crypt: ['fc.rx.crypt', 'Data rusak di tengah jalan (verifikasi enkripsi gagal). Coba lagi.', true],
    hash: ['fc.rx.hash', 'Berkas yang terunduh tidak sama dengan aslinya. Coba lagi untuk mengunduh ulang dari awal.', true],
    size: ['fc.rx.size', 'Ukuran berkas yang terunduh tidak sesuai. Coba lagi untuk mengunduh ulang dari awal.', true],
    corrupt: ['fc.rx.corrupt', 'Berkas yang terunduh rusak. Coba lagi untuk mengunduh ulang dari awal.', true],
    bomb: ['fc.rx.bomb', 'Berkas yang terunduh tidak sesuai ukurannya dan ditolak. Coba lagi untuk mengunduh ulang dari awal.', true],
    proto: ['fc.rx.proto', 'Pengirim memakai versi atau protokol yang tidak cocok. Pastikan kedua pihak memakai Archne versi yang sama.', true],
    range: ['fc.rx.range', 'Pengirim menolak permintaan lanjutan. Coba lagi untuk mengunduh ulang.', true],
    nospace: ['fc.rx.nospace', 'Disk penuh. Kosongkan ruang, lalu coba lagi.', true],
    lan: ['fc.rx.lan', 'Kirim Langsung hanya untuk jaringan lokal (LAN). Pastikan kalian satu Wi-Fi/jaringan; jalur antar jaringan dan relay tidak dipakai.', false],
    unsafe: ['fc.rx.unsafe', 'Nama berkas dari pengirim tidak aman (mencoba keluar dari folder tujuan), jadi seluruh kiriman ditolak.', false],
    disk: ['fc.rx.disk', 'Disk penuh. Kosongkan ruang, lalu lanjutkan.', true],
    io: ['fc.rx.io', 'Tidak bisa menulis ke folder tujuan. Periksa izin folder, lalu lanjutkan.', true],
    perm: ['fc.rx.perm', 'Tidak bisa menulis ke folder unduhan (izin ditolak atau berkas sedang dipakai).', true],
  };
  RX_ERR.bad = RX_ERR.proto;
  RX_ERR.ENOSPC = RX_ERR.nospace;
  RX_ERR.EACCES = RX_ERR.perm;
  RX_ERR.EPERM = RX_ERR.perm;
  RX_ERR.EBUSY = RX_ERR.perm;
  function rxError(code, err) {
    const e = Object.prototype.hasOwnProperty.call(RX_ERR, code) ? RX_ERR[code] : null;
    return e ? { text: T(e[0], e[1]), retry: e[2] } : { text: err || code || T('fc.errUnknown', 'galat tidak dikenal'), retry: true };
  }
  const TX_ERR = {
    changed: ['fc.tx.changed', 'Berkas berubah saat dibaca. Tutup program yang memakainya, lalu kirim lagi.'],
    meta: ['fc.tx.meta', 'Yang dipilih bukan berkas biasa.'],
    ENOENT: ['fc.tx.ENOENT', 'Berkas tidak ditemukan (mungkin sudah dipindah atau dihapus).'],
    perm: ['fc.tx.perm', 'Berkas tidak bisa dibaca (izin ditolak atau sedang dipakai program lain).'],
    busy: ['fc.tx.busy', 'Berkas sedang dipakai program lain.'],
    nospace: ['fc.tx.nospace', 'Disk penuh, tidak bisa menyiapkan berkas untuk dikirim.'],
  };
  TX_ERR.EACCES = TX_ERR.perm;
  TX_ERR.EPERM = TX_ERR.perm;
  TX_ERR.EBUSY = TX_ERR.busy;
  TX_ERR.ENOSPC = TX_ERR.nospace;
  const txError = (code, err) => (Object.prototype.hasOwnProperty.call(TX_ERR, code) ? T(TX_ERR[code][0], TX_ERR[code][1]) : err || code || T('fc.errUnknown', 'galat tidak dikenal'));

  const bar = (key, p) => `<div class="bar"><i data-bar="${esc(key)}" style="width:${p}%"></i></div>`;
  const isAbort = (code) => /abort/i.test(String(code || ''));
  const kindIcon = (name, photo) => (photo ? 'image' : { aud: 'music', vid: 'film' }[playKind(name)] || 'file');

  // Menu ⋮ untuk pesan berkas (js/archne-msgmenu.js menaruhnya di depan butir pesan). Aksi `f:*` dijalankan fileAct() di js/archne-profile-compose.js.
  // Nama berkas tidak tampil di kartu media, jadi menu memuatnya sebagai butir info (tidak bisa diketuk).
  function menuItems(m) {
    const f = m && m.file; if (!f) return [];
    const risky = isRisky(f.name), out = [{ act: 'f:info', icon: 'ⓘ', label: `${f.name} · ${fmtSize(f.size)}`, disabled: true }];
    if (f.mine) return out;
    if (f.saved) {
      const sv = String(f.saved.name || f.name || ''), bad = risky || isRisky(sv), pk = playKind(sv);
      if (!bad) {
        if (VIEW_EXT.test(sv)) out.push({ act: 'f:view', icon: '⛶', label: T('fc.fullscreen', 'Layar penuh') });
        else if (pk) out.push({ act: pk === 'vid' ? 'f:full' : 'f:play', icon: pk === 'vid' ? '⛶' : '▶', label: pk === 'vid' ? T('fc.fullscreen', 'Layar penuh') : T('common.play', 'Putar') });
        if (!hasVc(f, risky)) out.push({ act: 'f:open', icon: '↗', label: T('fc.openWith', 'Buka dengan aplikasi lain') }); // pesan suara hanya diputar di Archne
      }
      out.push({ act: 'f:show', icon: '📂', label: T('fc.showFolder', 'Tampilkan di folder') });
    } else if (f.rx && f.rx.phase === 'error') out.push({ act: 'f:discard', icon: '🗑', label: T('fc.discardPartial', 'Buang sisa unduhan') });
    return out;
  }

  // m = pesan dari state() yang punya m.file. prog = { [id]: { phase, done, total } } kemajuan terbaru dari event (boleh kosong).
  // ctx = { senderOnline } (opsional): dipakai untuk petunjuk saat pengirim offline.
  function cardHtml(m, prog, ctx) {
    const f = m.file, id = m.id, risky = isRisky(f.name), photo = hasThumb(f, risky), vthumb = hasVThumb(f, risky), vc = hasVc(f, risky);
    const rxing = !!(f.rx && (f.rx.phase === 'download' || f.rx.phase === 'unpack')), rxerr = !!(f.rx && f.rx.phase === 'error');
    const rp = rxing ? ((prog && prog[id]) || f.rx) : null;
    const dm = m.to !== 'public' && !String(m.to).startsWith('g:'); // DM: yang memegang berkas adalah kurir. Publik/grup: kurir publik atau peer yang sudah mengunduh
    const sz = `<span${f.mode === 'br' && f.psize < f.size ? ` title="${esc(T('fc.compressed', 'dikompres, dikirim {size}', { size: fmtSize(f.psize) }))}"` : ''}>${esc(fmtSize(f.size))}</span>`;
    const discard = (label) => ib('discard', id, 'x', label, 'sec');
    const live = !risky && f.mode === 'raw' && m.to !== 'public' && playKind(f.name) ? ib('playdl', id, 'play', T('fc.playWhileDl', 'Putar sambil unduh'), 'sec') : '';
    const chips = [], notes = [];
    let lead = '';
    if (f.held) chips.push(chip('cour', 'cloud', String(f.held), dm ? TN('fc.heldCour', f.held, 'Tersedia di {count} kurir: bisa diambil walau pengirim offline', { count: f.held }) : TN('fc.heldPeer', f.held, 'Tersedia di {count} peer lain: bisa diambil walau pengirim offline', { count: f.held })));
    if (f.mine) {
      chips.push(chip('ok', 'check', '', T('fc.offerSent', 'Tawaran berkas terkirim. Penerima mengambilnya dari kamu.')));
      if (f.cap !== undefined) chips.push(chip('warn', 'info', T('fc.stayOnline', 'Tetap online'), f.cap > 0 ? T('fc.capBig', 'Berkas ini lebih besar dari batas antar jaringan ({cap}), jadi tidak dititipkan ke kurir di luar LAN. Penerima mengambilnya langsung darimu: tetap online sampai selesai.', { cap: fmtSize(f.cap) }) : T('fc.capOff', 'Berkas antar jaringan dimatikan di Pengaturan (LAN tetap tanpa batas). Penerima mengambilnya langsung darimu: tetap online sampai selesai.')));
      else if (f.pushing) chips.push(chip('cour', 'cloud', '…', T('fc.pushing', 'Menitipkan ke kurir…')));
      else if (f.pushed) chips.push(chip('cour', 'cloud', String(f.pushed), dm ? TN('fc.pushedCour', f.pushed, 'Dititipkan di {count} kurir: penerima bisa mengambil walau kamu offline', { count: f.pushed }) : TN('fc.pushedPeer', f.pushed, 'Dipegang {count} peer lain (kurir atau yang sudah mengunduh): penerima bisa mengambil walau kamu offline', { count: f.pushed })));
    } else if (f.saved) {
      chips.push(chip('ok', 'check', '', T('fc.saved', 'Tersimpan: {name}', { name: f.saved.name })));
      if (isRisky(f.saved.name) || risky) { notes.push(warnLine(T('fc.riskyNoOpen', 'Berkas ini bisa dijalankan, jadi tidak dibuka dari Archne.'))); lead = ib('show', id, 'folder', T('fc.showFolder', 'Tampilkan di folder'), 'sec'); }
      else if (vc && VC_NAME.test(String(f.saved.name || ''))) lead = ib('play', id, 'play', T('common.play', 'Putar'));
      else if (VIEW_EXT.test(String(f.saved.name || f.name || ''))) lead = ib('view', id, 'image', T('fc.view', 'Lihat'));
      else if (playKind(f.saved.name || f.name)) lead = ib('play', id, 'play', T('common.play', 'Putar'));
      else lead = ib('open', id, 'ext', T('fc.open', 'Buka'));
    } else if (rxing) {
      notes.push(`${bar(id, pct(rp.done, rp.total))}<div class="fs" data-bartxt="${esc(id)}">${esc(progressText(rp.phase, rp.done, rp.total))}</div>`);
      lead = ib('cancelrx', id, 'x', T('common.cancel', 'Batal'), 'sec') + live;
    } else if (rxerr) {
      if (isAbort(f.rx.code)) { notes.push(`<div class="fs">${ico('info')}<span>${esc(T('fc.abortNote', 'Dibatalkan. Unduhan yang sudah masuk disimpan, bisa dilanjutkan.'))}</span></div>`); lead = ib('recv', id, 'retry', T('dlg.continue', 'Lanjutkan'), '', risky) + discard(T('fc.discardPartial', 'Buang sisa unduhan')); }
      else {
        const e = rxError(f.rx.code, f.rx.err);
        notes.push(warnLine(T('fc.failed', 'Gagal: {text}', { text: e.text }), 'err'));
        lead = e.retry ? ib('recv', id, 'retry', T('common.retry', 'Coba lagi'), '', risky) + discard(T('fc.discardPartial', 'Buang sisa unduhan')) : discard(T('common.close', 'Tutup'));
      }
    } else {
      if (risky) notes.push(warnLine(T('fc.riskyWarn', 'Berkas ini bisa dijalankan (mis. program atau skrip). Terima hanya jika kamu mengenal pengirimnya dan memang menunggunya.')));
      if (!f.held && ctx && ctx.senderOnline === false) {
        chips.push(chip('warn', 'clock', T('fc.senderOff', 'Pengirim offline'), dm ? T('fc.offDm', 'Pengirim sedang offline dan belum ada kurir yang memegang berkas ini. Unduhan menunggu sampai dia online.')
          : m.to === 'public' ? T('fc.offPub', 'Pengirim sedang offline dan belum ada kurir atau peer lain yang memegang berkas ini. Unduhan menunggu sampai salah satunya online.')
            : T('fc.offGrp', 'Pengirim sedang offline dan belum ada anggota grup lain yang memegang berkas ini. Unduhan menunggu sampai pengirim atau salah satunya online.')));
      }
      lead = ib('recv', id, 'dl', risky ? T('fc.acceptRisky', 'Terima (berisiko)') : photo ? T('fc.dlPhoto', 'Unduh foto') : vc ? T('fc.dlVoice', 'Unduh suara') : T('dlg.accept', 'Terima'), risky ? 'danger' : '', risky) + live;
    }
    const more = fmoreBtn(id), nh = notes.join(''), ch = chips.join('');
    if (vthumb || photo) {
      const tstate = f.mine ? '' : f.saved ? (vthumb ? 'play' : VIEW_EXT.test(String(f.saved.name || f.name)) ? 'view' : '') : rxing ? '' : 'recv';
      const cancel = rxing ? `<span class="fthx">${ib('cancelrx', id, 'x', T('common.cancel', 'Batal'), 'sec')}</span>` : '';
      const th = thumbHtml(m, f, tstate, more + cancel);
      // Ketuk thumbnail sudah mengunduh/melihat/memutar; tombol terpisah hanya untuk keadaan yang thumbnail-nya tidak bisa diketuk.
      const ld = rxing ? live : (f.saved && !tstate) || rxerr ? lead : (!f.mine && !f.saved ? live : '');
      const meta = ch || ld ? `<div class="fmeta">${ch}${ld}</div>` : '';
      return `<div class="fc fcimg" data-file="${esc(id)}">${th}${meta}${nh}</div>`;
    }
    if (vc) {
      const dur = esc(fmtClock(f.x.d)), lk = f.mine ? `<span class="fk" aria-label="${esc(T('voicenote.title', 'Pesan suara'))}">${ico('mic')}</span>` : lead;
      return `<div class="fc fcvc" data-file="${esc(id)}"><div class="frow">${lk}<div class="fmid"><div class="vtr" aria-hidden="true"><i></i></div><div class="fi"><span class="fst" title="${esc(T('voicenote.title', 'Pesan suara'))}">${ico('mic')}</span><span class="vdur" data-d="${dur}">${dur}</span>${ch}</div></div>${more}</div>${nh}</div>`;
    }
    const kind = kindIcon(f.name, false);
    return `<div class="fc fcg" data-file="${esc(id)}"><div class="frow"><span class="fk" data-k="${{ music: 'aud', film: 'vid' }[kind] || 'file'}">${ico(kind)}</span><div class="fmid"><div class="fn" title="${esc(f.name)}">${esc(f.name)}</div><div class="fi">${sz}${ch}</div></div><div class="fact">${lead}</div>${more}</div>${nh}</div>`;
  }

  // j = { job, name, phase: 'pack' | 'error', done, total, err } dari state().sending
  function jobHtml(j, prog) {
    const row = (mid, act) => `<div class="frow"><span class="fk" data-k="file">${ico('file')}</span><div class="fmid"><div class="fn" title="${esc(j.name)}">${esc(j.name)}</div>${mid}</div><div class="fact">${act}</div></div>`;
    if (j.phase === 'error') {
      return `<div class="fc fcg pend" data-job="${esc(j.job)}">${row('', ib('dismiss', j.job, 'x', T('common.close', 'Tutup'), 'sec'))}${warnLine(T('fc.sendFailed', 'Gagal mengirim: {text}', { text: txError(j.code, j.err) }), 'err')}</div>`;
    }
    const key = 'j:' + j.job, r = (prog && prog[key]) || j;
    return `<div class="fc fcg pend" data-job="${esc(j.job)}">${row(`<div class="fs" data-bartxt="${esc(key)}">${esc(progressText('pack', r.done, r.total))}</div>`, ib('cancelsend', j.job, 'x', T('common.cancel', 'Batal'), 'sec'))}${bar(key, pct(r.done, r.total))}</div>`;
  }

  // Pekerjaan kirim yang tampil di chat `cur` (kunci chat: 'public' | 'g:<id>' | id peer).
  const jobsFor = (sending, cur) => (sending || []).filter((j) => j.to === cur);

  return { esc, fmtSize, pct, progressText, cardHtml, jobHtml, jobsFor, isRisky, RISKY, rxError, txError, hasThumb, hasVThumb, hasVc, playKind, menuItems, ico };
});
