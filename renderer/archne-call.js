'use strict';
// Panggilan suara (v0.13.0, tahap 3): audio lewat WebRTC di UI, sinyal lewat window.api.call* (Core membawa sinyalnya saja).
// Tanpa server STUN/TURN: kandidat alamat lokal cukup karena peer saling terhubung lewat LAN/VPN.
//
// Dipisah dari archne-index.html supaya bisa dites di Node dengan WebRTC palsu: Controller menerima semua ketergantungannya lewat `o`
// (api, rtc, ui, waktu). Hanya `browserRtc` dan `makeRinger` yang menyentuh API peramban.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LanCall = factory();
})(this, function () {
  const DISCONNECT_GRACE_MS = 8000; // 'disconnected' sering pulih sendiri (pindah Wi-Fi); lebih lama dari ini dianggap putus
  const SYNC_GUARD_MS = 3000;       // snapshot state yang lebih tua dari ini terhadap panggilan baru tidak boleh mengakhirinya
  const ICE_BUF_MAX = 100;

  // Peredam kebisingan (v0.16.0). Dipilih pengguna saat panggilan berjalan; tiap panggilan mulai dari 'standard'.
  //   off      = tanpa peredam bising (gema dan AGC tetap menyala)
  //   standard = peredam bawaan WebRTC (constraint noiseSuppression)
  //   strong   = standard + pelewat-tinggi + RNNoise (cadangan: noise gate) di jalur WebAudio (browserRtc.strengthen)
  const CAM_MAX = 4; // kamera hidup bersamaan di satu channel (Core yang memutuskan; ini untuk pengecekan awal dan tampilan)
  // Teks UI: kunci i18n + cadangan Indonesia (tanpa I18N = teks Indonesia, tes Node/vm lama tetap jalan). Dibaca saat dipakai, jadi mengikuti bahasa aktif.
  const ct = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb));
  const tnc = (k, n, fb) => (typeof I18N !== 'undefined' && I18N.tn ? I18N.tn(k, n, { count: n }) : fb.replace('{count}', n));
  const camFullMsg = () => ct('cl.camFull', 'Kamera penuh, maksimal {max} orang yang menyalakan kamera.', { max: CAM_MAX });
  const noVidMsg = () => ct('cl.noVid', 'Lawan bicara memakai Archne versi lama, jadi video belum bisa dikirim ke dia. Perbarui Archne di perangkatnya.');
const NOISE_MODES = ['off', 'standard', 'strong'];
  const NOISE_DEFAULT = 'standard';
  const normNoise = (m) => (NOISE_MODES.includes(m) ? m : null);
  function audioConstraints(mode) {
    return { echoCancellation: true, noiseSuppression: mode !== 'off', autoGainControl: true };
  }
  // Video (v0.20.x): resolusi sedang saja, karena mesh mengirim satu aliran per peserta. facing 'user' = kamera depan.
  function videoConstraints(facing) {
    return { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: facing === 'environment' ? 'environment' : 'user' };
  }
  // Tawaran SDP memuat bagian video (m=video yang tidak ditolak, port 0)? Dipakai penerima untuk tahu ini panggilan video.
  // Kamera DM: semua panggilan membawa jalur video kosong (kamera bisa dinyalakan kapan saja tanpa negosiasi ulang). Jalur kosong bertanda a=msid:- (tanpa stream),
  // dan itu BUKAN panggilan video; panggilan video sungguhan membawa id stream asli. sdpVideoKind: 'real' | 'latent' | null (tanpa video).
  function sdpVideoKind(sdp) {
    if (typeof sdp !== 'string') return null;
    let kind = null;
    for (const sec of sdp.split(/^m=/m).slice(1)) {
      if (!/^video [1-9]\d* /.test(sec)) continue;
      if (!/^a=msid:-\s/m.test(sec)) return 'real';
      kind = 'latent';
    }
    return kind;
  }
  function sdpHasVideo(sdp) { return sdpVideoKind(sdp) === 'real'; }

  // Noise gate murni (tanpa API peramban, jadi bisa dites di Node). Per blok: ukur RMS, taksir lantai bising sebagai nilai
  // terkecil dari ~3 detik blok terakhir (tahan terhadap bising yang naik pelan), buka gerbang bila RMS melewati lantai x3
  // (minimal sekitar -40 dBFS), tahan terbuka sebentar supaya akhir kata tidak terpotong, lalu redam ke -16 dB (bukan senyap
  // total, agar tidak terdengar "putus-putus"). Perubahan gain dihaluskan per sampel.
  class NoiseGate {
    constructor(sampleRate) {
      this.sr = sampleRate > 0 ? sampleRate : 48000;
      this.hist = new Float32Array(64).fill(0.01); this.hi = 0;
      this.floor = 0.01; this.open = false; this.hold = 0; this.gain = 1;
      this.atk = 1 - Math.exp(-1 / (this.sr * 0.003));
      this.rel = 1 - Math.exp(-1 / (this.sr * 0.15));
    }
    process(inp, out) {
      const n = inp.length;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += inp[i] * inp[i];
      const rms = n ? Math.sqrt(sum / n) : 0;
      this.hist[this.hi] = rms; this.hi = (this.hi + 1) % this.hist.length;
      let m = Infinity; for (let i = 0; i < this.hist.length; i++) if (this.hist[i] < m) m = this.hist[i];
      this.floor = Math.max(m, 0.0003);
      const openThr = Math.max(this.floor * 3, 0.01), closeThr = openThr * 0.6;
      if (rms > (this.open ? closeThr : openThr)) { this.open = true; this.hold = 8; }
      else if (this.hold > 0) this.hold--;
      else this.open = false;
      const target = this.open ? 1 : 0.15;
      let g = this.gain;
      for (let i = 0; i < n; i++) { g += (target - g) * (target > g ? this.atk : this.rel); out[i] = inp[i] * g; }
      this.gain = g;
      return this.open;
    }
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  // Durasi dalam bahasa sehari-hari untuk riwayat: "45 dtk", "2 mnt 15 dtk", "1 jam 5 mnt".
  function durHuman(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return m ? ct('cl.durHM', '{h} jam {m} mnt', { h, m }) : ct('cl.durH', '{h} jam', { h });
    if (m) return s ? ct('cl.durMS', '{m} mnt {s} dtk', { m, s }) : ct('cl.durM', '{m} mnt', { m });
    return ct('cl.durS', '{s} dtk', { s });
  }

  // Teks satu catatan riwayat { dir: 'in'|'out', out, dur } untuk gelembung chat dan tab Panggilan.
  //   title: judul gelembung; sub: keterangan (durasi atau hasilnya); short: satu baris untuk pratinjau daftar chat; bad: tampil merah.
  // Catatan grup (r.group): judul memuat hasilnya ("Panggilan grup · 5 mnt"), karena baris kedua kartu dipakai untuk daftar peserta (callMembers).
  function callLabel(r) {
    const l = callLabel1(r);
    if (!(r && r.group)) return l;
    const T = r.video ? ct('cl.groupVideo', 'Panggilan video grup') : ct('cl.group', 'Panggilan grup');
    const title = r.out === 'missed' ? (r.video ? ct('cl.missed.groupVideo', 'Panggilan video grup tak terjawab') : ct('cl.missed.group', 'Panggilan grup tak terjawab')) : T + ' · ' + l.sub;
    return { title, sub: l.sub, short: title, bad: l.bad };
  }
  // Daftar peserta untuk kartu grup: "Kamu, Budi, Sari +2" (maksimal 3 nama termasuk Kamu, sisanya +N). o.me=false: tanpa "Kamu" (baris tab Panggilan).
  function callMembers(r, o) {
    const me = !o || o.me !== false;
    const names = (me ? [ct('chat.you', 'Kamu')] : []).concat(((r && r.members) || []).map((x) => String(x.name || '?').split('#')[0]));
    return names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) : '');
  }
  function callLabel1(r) {
    const vid = !!(r && r.video), T = vid ? ct('call.video', 'Panggilan video') : ct('call.voiceAria', 'Panggilan suara'), inn = r && r.dir === 'in'; // video: tawarannya memuat video (Core menandainya di riwayat)
    const lc = (x) => x.charAt(0).toLowerCase() + x.slice(1); // "Sedang sibuk" -> "sedang sibuk" untuk baris pratinjau
    const simple = (sub, bad) => ({ title: T, sub, short: T + ' · ' + lc(sub), bad });
    switch (r && r.out) {
      case 'done': { const d = durHuman(r.dur); return { title: T, sub: d, short: T + ' · ' + d, bad: false }; }
      case 'missed': { const t = vid ? ct('cl.missed.video', 'Panggilan video tak terjawab') : ct('cl.missed.voice', 'Panggilan suara tak terjawab'); return { title: t, sub: ct('cl.sub.missed', 'Tak terjawab'), short: t, bad: true }; }
      case 'rejected': { const x = inn ? ct('cl.sub.rejectedIn', 'Kamu menolak') : ct('cl.sub.rejected', 'Ditolak'); return { title: T, sub: x, short: T + ' · ' + x, bad: false }; }
      case 'noanswer': return simple(ct('cl.sub.noanswer', 'Tidak dijawab'), false);
      case 'busy': return simple(ct('cl.sub.busy', 'Sedang sibuk'), false);
      case 'cancelled': return simple(ct('arc.stCancelled', 'Dibatalkan'), false);
      default: return simple(ct('cl.sub.failed', 'Gagal tersambung'), true);
    }
  }

  // Teks untuk toast saat panggilan berakhir; '' = tidak perlu memberi tahu (tindakan sendiri, atau saling menelepon bersamaan).
  function endText(info) {
    if (info.reason === 'glare') return '';
    if (info.reason === 'mic') return info.err || ct('cl.end.mic', 'Mikrofon tidak bisa dipakai. Izinkan akses mikrofon untuk Archne, lalu coba lagi.');
    if (info.reason === 'error') return info.err || ct('cl.end.error', 'Panggilan gagal');
    if (info.vc) return info.local || info.pv ? '' : ct('cl.end.vcLeft', 'Kamu keluar dari channel: channel dihapus, dikunci, atau aksesmu dicabut'); // channel publik: alasannya (dihapus / dikunci / PIN diganti) sudah diberitahukan lewat pvkick
    if (info.wasActive) return ct('cl.end.doneDur', 'Panggilan berakhir · {dur}', { dur: fmtDur(info.dur) });
    if (info.local) return '';
    switch (info.reason) {
      case 'missed': return info.name ? ct('cl.end.missedFrom', 'Panggilan tak terjawab dari {name}', { name: info.name }) : ct('cl.end.missed', 'Panggilan tak terjawab');
      case 'rejected': return ct('cl.end.rejected', 'Panggilan ditolak');
      case 'busy': return info.name ? ct('cl.end.busyName', '{name} sedang dalam panggilan lain', { name: info.name }) : ct('cl.end.busy', 'Dia sedang dalam panggilan lain');
      case 'noanswer': return ct('cl.sub.noanswer', 'Tidak dijawab');
      case 'unreachable': return ct('cl.end.unreach', 'Tidak terjangkau. Dia sedang offline?');
      case 'refused': return ct('cl.end.refused', 'Panggilan tidak bisa diteruskan. Coba lagi sebentar lagi.');
      case 'failed': return info.wan ? ct('cl.end.failedWan', 'Tidak bisa tersambung langsung. Jaringan salah satu pihak mungkin butuh server TURN (Pengaturan > Lintas jaringan).') : ct('cl.end.failed', 'Gagal tersambung. Pastikan kedua perangkat bisa saling terhubung.');
      case 'blocked': return ct('cl.end.blocked', 'Panggilan diputus karena pengguna ini diblokir');
      case 'cancelled': return info.name ? ct('cl.end.cancelledFrom', 'Panggilan dibatalkan dari {name}', { name: info.name }) : ct('cl.end.cancelled', 'Panggilan dibatalkan');
      case 'ended': return ct('cl.end.ended', 'Panggilan berakhir');
      default: return '';
    }
  }

  function supported(w) {
    try { return !!(w && w.RTCPeerConnection && w.navigator && w.navigator.mediaDevices && typeof w.navigator.mediaDevices.getUserMedia === 'function'); } catch { return false; }
  }

  class Controller {
    // o: { api, rtc: { PeerConnection, getUserMedia(constraints), playRemote(stream)->stop, makeStream(tracks) },
    //      ui: { render(view|null), ring('in'|'out'|null), ended(info) }, now, setTimeout, clearTimeout }
    constructor(o) {
      this.api = o.api; this.rtc = o.rtc; this.ui = o.ui;
      this.native = o.native || null; // opsional (cangkang Android): { begin(), end(), speaker(on) -> Promise<bool> }
      this._micErr = '';
      this.now = o.now || Date.now;
      // dibungkus: setTimeout dkk. di peramban melempar 'Illegal invocation' bila dipanggil dengan this selain window
      this.setT = o.setTimeout ? (f, ms) => o.setTimeout(f, ms) : (f, ms) => setTimeout(f, ms);
      this.clearT = o.clearTimeout ? (t) => o.clearTimeout(t) : (t) => clearTimeout(t);
      this.cur = null;
    }

    view() {
      const c = this.cur;
      if (!c) return null;
      const v = { cid: c.cid, room: c.room, vc: c.vc ? (c.pv ? { gid: c.vc.gid, cid: c.vc.cid, name: c.vc.name, pv: true } : { gid: c.vc.gid, cid: c.vc.cid, name: c.vc.name }) : null, invite: !!c.invite, invites: [...c.invites.values()].map((x) => ({ peer: x.peer, name: x.name })), members: Array.isArray(c.members) ? c.members.map((m) => ({ id: m.id, name: m.name })) : [], peer: c.peer, name: c.name, dir: c.dir, phase: c.phase, video: !!c.video, camErr: c.camErr || '', camOff: !!c.camOff, facing: c.facing === 'environment' ? 'environment' : 'user', vrev: c.vrev || 0, muted: c.muted, deafened: !!c.deafened, speaker: c.speaker, noise: c.noise, since: c.since || 0, canAccept: c.dir === 'in' && c.phase === 'ringing',
        legs: c.legs.map((l) => Object.assign({ cid: l.cid, peer: l.peer, name: l.name, dir: l.dir, state: l.phase, video: !!l.vremote && !l.vlatent, muted: !!(l.deafened || l.muted), deafened: !!l.deafened }, typeof l.vcam === 'boolean' ? { cam: l.vcam } : {})) };
      if (c.vc) { v.camMax = CAM_MAX; v.camCount = (c.camOff ? 0 : 1) + c.legs.filter((l) => l.vcam === true).length; } // channel: kamera hidup sekarang / batas
      return v;
    }
    elapsed() { return this.cur && this.cur.since ? (this.now() - this.cur.since) / 1000 : 0; }
    // Aliran video untuk UI (bukan bagian view() karena bukan data murni). Null bila tidak ada.
    localVideo() { const c = this.cur; return c && c.video && c.stream && c.stream.getVideoTracks && c.stream.getVideoTracks().length ? c.stream : null; }
    // Aliran suara untuk pengukur level (jendela PiP memilih kartu pembicara). Null bila tidak ada; mikrofon sendiri hanya bila tidak dibisukan.
    localAudio() { const c = this.cur; return c && c.stream && !c.muted && c.stream.getAudioTracks && c.stream.getAudioTracks().length ? c.stream : null; }
    remoteAudio(peer) { const c = this.cur, l = c && c.legs.find((x) => x.peer === peer); return l && l.remote && l.remote.getAudioTracks && l.remote.getAudioTracks().length ? l.remote : null; }
    // Jalur video kosong (lawan belum menyalakan kamera) tidak ditampilkan: kartunya tetap avatar, bukan bingkai hitam.
    remoteVideo(peer) {
      const c = this.cur, l = c && c.legs.find((x) => x.peer === peer);
      if (!l || !l.vremote || l.vcam === false || (l.vlatent && l.vcam !== true)) return null;
      return l.vremote;
    }
    _render() { try { this.ui.render(this.view()); } catch {} }
    _ring(k) { try { this.ui.ring(k); } catch {} }

    // Satu kaki = satu lawan bicara: RTCPeerConnection, audio masuk, dan sinyalnya sendiri. Mikrofon dan pilihan peredam milik ruang.
    _leg(peer, name, dir, cid) {
      return { cid: cid || null, at: this.now(), peer, name: name || '?', dir, phase: dir === 'in' ? 'ringing' : 'dialing', pc: null, sender: null, vsender: null, stopAudio: null, remote: null, vremote: null, offer: null, remoteIce: [], localIce: [], failed: false, timer: null, accepting: false, ice: [], wan: false };
    }
    // Satu ruang (this.cur) berisi 1..n kaki. Panggilan 1-1 = ruang dengan satu kaki. Medan peserta pertama (cid, peer, name, dir, pc)
    // tetap bisa dibaca langsung dari ruang supaya kode 1-1 lama dan tes tidak berubah.
    _new(peer, name, dir, cid) {
      const l = this._leg(peer, name, dir, cid);
      const c = { room: cid || null, peer, name: name || '?', dir, phase: dir === 'in' ? 'ringing' : 'dialing', muted: false, deafened: false, premute: false, speaker: false, noise: NOISE_DEFAULT, noiseBusy: false, proc: null, video: false, camErr: '', camOff: true, facing: 'user', camBusy: false, vrev: 0, nat: false, at: this.now(), since: 0, stream: null, legs: [l], invites: new Map(), joining: false, invite: false };
      for (const k of ['cid', 'pc']) Object.defineProperty(c, k, { get: () => (c.legs[0] ? c.legs[0][k] : null) });
      return c;
    }
    _failed(c) { return c.legs.some((l) => l.failed); }

    // ICE per kaki (mode lintas jaringan): Core menjawab [] untuk peer LAN (seperti sebelumnya) dan STUN+TURN untuk peer lintas jaringan.
    // Gagal bertanya = [] (jalur LAN tidak butuh apa pun). False bila panggilan/kaki sudah dibatalkan selama menunggu.
    async _prepIce(c, l) {
      l.ice = []; l.wan = false;
      if (typeof this.api.turnIce === 'function') {
        try {
          const r = await this.api.turnIce(l.peer);
          if (r && r.ok && Array.isArray(r.iceServers)) { l.ice = r.iceServers; l.wan = !!r.wan; }
        } catch {}
      }
      return this.cur === c && c.legs.includes(l);
    }

    _pc(c, l) {
      const pc = new this.rtc.PeerConnection({ iceServers: l.ice || [] });
      l.pc = pc;
      for (const t of c.stream.getTracks()) {
        if (c.vc && t.kind === 'video') continue; // channel: video lewat jalur kosong di bawah, bukan addTrack (supaya tidak ada dua jalur video)
        const snd = pc.addTrack(t, c.stream);
        if (t.kind === 'video') { if (!l.vsender && snd) l.vsender = snd; } // sender audio dipakai peredam bising (replaceTrack); video terpisah
        else if (!l.sender && snd) l.sender = snd;
      }
      // Jalur video sendrecv tanpa trek, ikut dinegosiasikan sejak awal (channel dan, sejak fitur kamera DM, panggilan 1-1 / grup yang belum membawa kamera).
      // Menyalakan kamera = replaceTrack (tanpa negosiasi ulang). Sisi penelepon membuatnya di sini; sisi penjawab memakai jalur dari tawaran (lihat _vidAnswer).
      if (l.dir === 'out' && !l.vsender && typeof pc.addTransceiver === 'function') {
        try { const tr = pc.addTransceiver('video', { direction: 'sendrecv' }); if (tr && tr.sender) l.vsender = tr.sender; } catch {}
        this._vidAttach(c, l);
      }
      pc.onicecandidate = (e) => {
        const cand = e && e.candidate;
        if (!cand || !cand.candidate || this.cur !== c) return; // kandidat kosong = akhir pengumpulan
        const data = JSON.stringify(typeof cand.toJSON === 'function' ? cand.toJSON() : cand);
        if (l.cid) this.api.callIce(l.cid, data); else if (l.localIce.length < ICE_BUF_MAX) l.localIce.push(data);
      };
      pc.ontrack = (e) => {
        if (this.cur !== c) return;
        const st = (e.streams && e.streams[0]) || this.rtc.makeStream([e.track]);
        if (e.track && e.track.kind === 'video') { l.vremote = st; this._render(); return; } // video lawan: UI mengambilnya lewat remoteVideo(peer)
        if (l.stopAudio) l.stopAudio();
        l.stopAudio = this.rtc.playRemote(st);
        l.remote = st;
        if (c.deafened) this._deafLeg(l, true); // kaki yang datang saat deafen aktif langsung dibisukan
      };
      pc.onconnectionstatechange = () => this._conn(c, l, pc.connectionState);
      // kaki yang dibuat sesudah peredam Kuat menyala harus mengirim jalur olahan, bukan mikrofon mentah
      if (c.proc && c.proc.stream && l.sender && typeof l.sender.replaceTrack === 'function') {
        const t = c.proc.stream.getAudioTracks()[0];
        if (t) Promise.resolve(l.sender.replaceTrack(t)).catch(() => {});
      }
      // pengguna sudah memilih selain Standar saat dialog izin mikrofon masih terbuka: terapkan begitu trek dan sender ada
      if (c.noise !== NOISE_DEFAULT && !c.proc) this._applyNoise(c);
      return pc;
    }

    // Sisi penjawab: sesudah setRemoteDescription(tawaran), jalur video dari tawaran dijadikan sendrecv supaya aku juga bisa mengirim kamera.
    // Tawaran dari peer lama (tanpa jalur video) tidak punya jalurnya: kameraku tidak sampai ke dia, suara tetap normal.
    _vidAnswer(c, l, pc) {
      if (l.vsender || !pc || typeof pc.getTransceivers !== 'function') return;
      try {
        const tr = pc.getTransceivers().find((t) => t && !t.stopped && t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
        if (tr) { tr.direction = 'sendrecv'; l.vsender = tr.sender; }
      } catch {}
      this._vidAttach(c, l);
    }
    // Kamera yang sedang hidup (ada di c.stream) dipasang ke kaki ini: kaki yang datang sesudah kamera menyala ikut mengirimnya.
    _vidAttach(c, l) {
      try {
        const vt = c.stream && typeof c.stream.getVideoTracks === 'function' ? c.stream.getVideoTracks().find((t) => t && t.readyState !== 'ended') : null;
        if (vt && l.vsender && typeof l.vsender.replaceTrack === 'function') Promise.resolve(l.vsender.replaceTrack(vt)).catch(() => {});
      } catch {}
    }

    _conn(c, l, st) {
      if (this.cur !== c || !c.legs.includes(l)) return;
      if (st === 'connected') {
        if (l.timer) { this.clearT(l.timer); l.timer = null; }
        if (l.phase !== 'active') { l.phase = 'active'; if (l.cid) { this.api.callConnected(l.cid); if (c.video) this._announce(c); } }
        if (c.phase !== 'active') {
          c.phase = 'active'; c.since = this.now(); c.joining = false;
          this._ring(null);
        }
        this._render();
      } else if (st === 'disconnected') {
        if (!l.timer) l.timer = this.setT(() => { l.timer = null; if (this.cur === c && c.legs.includes(l)) { l.failed = l.phase !== 'active'; this._legDown(c, l, 'failed'); } }, DISCONNECT_GRACE_MS);
      } else if (st === 'failed') {
        l.failed = l.phase !== 'active';
        this._legDown(c, l, 'failed');
      }
    }

    // Satu kaki putus. Kaki terakhir = akhir ruang (hangup biasa); kalau masih ada kaki lain, hanya kaki itu yang ditutup dan Core diberi tahu.
    _legDown(c, l, reason) {
      if (!c.vc && c.legs.length <= 1 && !c.joining) { this.hangup(); return; } // channel: sendirian itu wajar, sesi tetap berjalan
      // masih bergabung (belum pernah aktif): anggota lain masih bisa menelepon; Core yang memutuskan ruang bubar (event end last)
      const cid = l.cid;
      this._removeLeg(c, l, reason);
      if (cid) this.api.callEnd(cid);
    }
    // Lepas satu kaki dari ruang tanpa menyentuh kaki lain. Mikrofon tetap milik ruang.
    _removeLeg(c, l, reason) {
      const i = c.legs.indexOf(l);
      if (i < 0) return;
      c.legs.splice(i, 1);
      this._closeLeg(l);
      this._render();
      try { if (this.ui.legEnded) this.ui.legEnded({ peer: l.peer, name: l.name, cid: l.cid, reason: reason || 'ended', failed: l.failed, vc: !!c.vc }); } catch {}
    }

    // Undangan keluar untuk peserta ini sudah terjawab (kakinya terbentuk) atau gagal: hapus dari daftar menunggu.
    _invDone(c, peer) { if (c.invites.delete(peer)) this._render(); }

    // Tambah kaki keluar ke satu anggota ruang (sisi ber-id lebih kecil): tawaran dibuat di sini, lalu Core mengirimnya lewat callLeg.
    // Mikrofon dipakai bersama; tidak ada dialog izin baru.
    async addLeg(peerId, name) {
      const c = this.cur;
      if (!c || !c.stream || !c.room) return { ok: false, err: ct('cl.err.noCall', 'Tidak ada panggilan yang siap menambah peserta') };
      if (c.legs.some((x) => x.peer === peerId)) return { ok: false, err: ct('cl.err.already', 'Sudah tersambung ke dia') };
      const l = this._leg(peerId, name, 'out');
      c.legs.push(l); c.invites.delete(peerId);
      let sdp;
      if (!(await this._prepIce(c, l))) return { ok: false };
      try {
        const pc = this._pc(c, l);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sdp = (pc.localDescription && pc.localDescription.sdp) || offer.sdp;
      } catch (e) { if (this.cur === c) this._removeLeg(c, l, 'error'); return { ok: false, err: ct('cl.err.audio', 'Gagal menyiapkan audio: {m}', { m: (e && e.message) || e }) }; }
      if (this.cur !== c || !c.legs.includes(l)) return { ok: false };
      const r = await this.api.callLeg(c.room, peerId, sdp);
      if (this.cur !== c || !c.legs.includes(l)) { if (r && r.ok && r.cid) this.api.callEnd(r.cid); return { ok: false }; }
      if (!r || !r.ok) { this._removeLeg(c, l, 'error'); return { ok: false, err: (r && r.err) || ct('cl.err.joinLeg', 'Gagal menyambung ke peserta') }; }
      l.cid = r.cid;
      for (const d of l.localIce.splice(0)) this.api.callIce(l.cid, d);
      this._render();
      return { ok: true, cid: l.cid };
    }

    // Tawaran masuk dari sesama anggota ruang (event 'incoming' dengan auto): dijawab otomatis, tanpa dering.
    async _joinLeg(ev) {
      const c = this.cur;
      if (!c || !c.stream || c.legs.some((x) => x.peer === ev.peer || x.cid === ev.cid)) { this.api.callReject(ev.cid); return { ok: false }; }
      const l = this._leg(ev.peer, ev.name, 'in', ev.cid);
      l.offer = ev.sdp; l.remoteIce = (Array.isArray(ev.ice) ? ev.ice : []).slice(0, ICE_BUF_MAX); l.phase = 'connecting';
      c.legs.push(l); c.invites.delete(ev.peer);
      if (!(await this._prepIce(c, l))) return { ok: false };
      try {
        const pc = this._pc(c, l);
        await pc.setRemoteDescription({ type: 'offer', sdp: l.offer });
        l.vlatent = sdpVideoKind(l.offer) === 'latent';
        this._vidAnswer(c, l, pc);
        await this._drain(l);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        if (this.cur !== c || !c.legs.includes(l)) return { ok: false };
        const r = await this.api.callAnswer(l.cid, (pc.localDescription && pc.localDescription.sdp) || ans.sdp);
        if (this.cur !== c || !c.legs.includes(l)) return { ok: false };
        if (!r || !r.ok) { this._legDown(c, l, 'error'); return { ok: false }; }
      } catch (e) { if (this.cur === c && c.legs.includes(l)) this._legDown(c, l, 'error'); return { ok: false }; }
      this._render();
      return { ok: true };
    }

    _finish(c, info) {
      if (this.cur !== c) return;
      this.cur = null;
      for (const l of c.legs) this._closeLeg(l);
      try { if (c.stream) for (const t of c.stream.getTracks()) t.stop(); } catch {}
      try { if (c.proc) c.proc.stop(); } catch {}
      c.proc = null;
      this._natEnd(c);
      this._ring(null);
      this._render();
      const wasActive = c.phase === 'active' || !!c.since;
      const reason = this._failed(c) && !wasActive ? 'failed' : info.reason;
      try { this.ui.ended({ reason, wasActive, dur: c.since ? (this.now() - c.since) / 1000 : 0, name: c.name, peer: c.peer, dir: c.dir, local: !!info.local, err: info.err, vc: !!c.vc, pv: !!c.pv, wan: c.legs.some((x) => x.wan) }); } catch {}
    }

    _closeLeg(l) {
      if (l.timer) { this.clearT(l.timer); l.timer = null; }
      try { if (l.pc) { l.pc.onicecandidate = l.pc.ontrack = l.pc.onconnectionstatechange = null; l.pc.close(); } } catch {}
      try { if (l.stopAudio) l.stopAudio(); } catch {}
      l.stopAudio = null; l.remote = null; l.vremote = null; l.vsender = null;
    }

    // Mikrofon. Gagal -> null; this._micErr memuat pesan khusus bila penyebabnya jelas (mis. izin ditolak permanen di Android).
    // Bila c.video: minta kamera sekalian. Kamera gagal -> jatuh ke suara saja (c.video = false, c.camErr berisi alasannya), panggilan tetap jalan.
    _gum(c) {
      this._micErr = '';
      const ac = audioConstraints(c ? c.noise : NOISE_DEFAULT);
      const ask = (video) => Promise.resolve().then(() => this.rtc.getUserMedia(video ? { audio: ac, video: videoConstraints() } : { audio: ac }));
      const first = c && c.video ? ask(true).catch((e) => {
        c.video = false; c.camOff = true;
        const d = e && (e.userMsg || e.detail || [e.name, e.message].filter(Boolean).join(': '));
        c.camErr = d ? ct('cl.err.camD', 'Kamera tidak bisa dipakai [{d}]. Panggilan dilanjutkan tanpa video.', { d: String(d).slice(0, 80) }) : ct('cl.err.cam', 'Kamera tidak bisa dipakai. Panggilan dilanjutkan tanpa video.');
        try { if (this.ui.notice) this.ui.notice(c.camErr); } catch {}
        return ask(false);
      }) : ask(false);
      return first.catch((e) => {
        const um = e && typeof e.userMsg === 'string' ? e.userMsg : '';
        if (um) { this._micErr = um; return null; }
        // Penyebab tidak dikenal: sebut apa adanya (nama galat WebView/peramban atau jawaban plugin) supaya bisa didiagnosis, bukan sekadar "tidak bisa dipakai".
        const d = e && (e.detail || [e.name, e.message].filter(Boolean).join(': '));
        this._micErr = d ? ct('cl.err.micD', 'Mikrofon tidak bisa dipakai [{d}]. Izinkan akses mikrofon untuk Archne, lalu coba lagi.', { d: String(d).slice(0, 120) }) : '';
        return null;
      });
    }
    // Sesi audio milik cangkang (mode panggilan, rute suara, layanan latar): mulai setelah mikrofon didapat, selalu dilepas di _finish.
    _natBegin(c) {
      if (!this.native || c.nat) return;
      c.nat = true;
      try { Promise.resolve(this.native.begin()).catch(() => {}); } catch {}
    }
    _natEnd(c) {
      if (!this.native || !c.nat) return;
      c.nat = false;
      try { Promise.resolve(this.native.end()).catch(() => {}); } catch {}
    }
    _stopStream(s) { try { for (const t of s.getTracks()) t.stop(); } catch {} }

    // Menelepon. Hasil dilaporkan lewat ui.ended bila gagal; nilai kembali hanya { ok }.
    async start(peerId, name, opts) {
      if (this.cur) { try { this.ui.ended({ reason: 'error', err: ct('cl.err.busy', 'Masih ada panggilan yang berlangsung'), local: false }); } catch {} return { ok: false }; }
      const c = this.cur = this._new(peerId, name, 'out'), l = c.legs[0];
      c.video = !!(opts && opts.video); c.camOff = !c.video;
      this._ring('out'); this._render();
      const stream = await this._gum(c);
      if (this.cur !== c) { if (stream) this._stopStream(stream); return { ok: false }; } // dibatalkan saat menunggu izin mikrofon
      if (!stream) { this._finish(c, { reason: 'mic', err: this._micErr }); return { ok: false }; }
      c.stream = stream; this._applyMic(c);
      this._natBegin(c);
      if (c.video) this._render(); // pratinjau kamera sendiri
      let sdp;
      if (!(await this._prepIce(c, l))) return { ok: false };
      try {
        const pc = this._pc(c, l);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sdp = (pc.localDescription && pc.localDescription.sdp) || offer.sdp;
      } catch (e) { this._finish(c, { reason: 'error', err: ct('cl.err.audio', 'Gagal menyiapkan audio: {m}', { m: (e && e.message) || e }) }); return { ok: false }; }
      if (this.cur !== c) return { ok: false };
      const r = await this.api.callStart(peerId, sdp);
      if (this.cur !== c) { if (r && r.ok) this.api.callEnd(r.cid); return { ok: false }; } // ditutup saat menunggu inti
      if (!r || !r.ok) { this._finish(c, { reason: 'error', err: (r && r.err) || ct('cl.err.callFail', 'Panggilan gagal') }); return { ok: false }; }
      l.cid = r.cid; c.room = r.cid;
      for (const d of l.localIce.splice(0)) this.api.callIce(l.cid, d);
      return { ok: true, cid: l.cid };
    }

    // ---- Channel voice (v0.19.0, langkah 7) ----
    // Sesi channel = satu ruang (room = id channel) yang boleh berisi 0..n kaki. Core yang menentukan siapa yang harus disambung:
    // 'legneed' -> addLeg (aku sisi penelepon), 'incoming' auto -> _joinLeg (dia penelepon). Mikrofon dan `room` sudah harus siap
    // sebelum api.vcEnter dipanggil, karena 'legneed' untuk yang sudah ada di channel bisa tiba sebelum jawaban IPC-nya.
    // Semua kegagalan dilaporkan lewat ui.ended (seperti start); nilai kembali hanya { ok }.
    async enterChannel(gid, cid, name) {
      let old = this.cur;
      if (old && old.vc && !old.pv && old.room === String(cid) && old.vc.gid === String(gid)) return { ok: true }; // sudah di sini
      if (old && old.vc) { // pindah channel: lepas yang lama dulu (tanpa pemberitahuan), baru masuk yang baru
        await this._chanLeave(old);
        old = this.cur;
      }
      if (old) { try { this.ui.ended({ reason: 'error', err: ct('cl.err.busy', 'Masih ada panggilan yang berlangsung'), local: false }); } catch {} return { ok: false }; }
      const c = this.cur = this._new(null, name, 'out', null);
      c.legs = []; c.room = String(cid); c.phase = 'connecting'; c.vc = { gid: String(gid), cid: String(cid), name: String(name || 'Channel') }; c.entered = 0; c.camOff = true; // channel: masuk hanya suara, kamera dinyalakan sendiri
      this._render();
      const stream = await this._gum(c);
      if (this.cur !== c) { if (stream) this._stopStream(stream); return { ok: false }; } // ditutup saat menunggu izin mikrofon
      if (!stream) { this._finish(c, { reason: 'mic', err: this._micErr }); return { ok: false }; }
      c.stream = stream; this._applyMic(c);
      this._natBegin(c);
      let r;
      try { r = await this.api.vcEnter(c.vc.gid, c.vc.cid); } catch (e) { r = { ok: false, err: (e && e.message) || ct('cl.err.chanJoin', 'Gagal masuk channel') }; }
      if (this.cur !== c) { if (r && r.ok) this.api.vcLeave(); return { ok: false }; } // keluar saat menunggu inti
      if (!r || !r.ok) { this._finish(c, { reason: 'error', err: (r && r.err) || ct('cl.err.chanJoin', 'Gagal masuk channel') }); return { ok: false }; }
      c.entered = this.now(); c.phase = 'active'; c.since = c.entered;
      if (c.muted || c.deafened) this._announce(c); // status yang kupilih saat dialog mikrofon masih terbuka: Core baru mengenal ruangnya sekarang
      this._render();
      return { ok: true };
    }
    // Keluar dari sesi channel (grup atau publik): tutup di sini tanpa pemberitahuan, lalu beri tahu Core lewat api yang sesuai.
    async _chanLeave(c) {
      this._finish(c, { reason: 'ended', local: true });
      try { await (c.pv ? this.api.pvLeave() : this.api.vcLeave()); } catch {}
    }
    // ---- Channel voice publik (v0.20.0, pvch7) ----
    // Sama dengan enterChannel (mikrofon dulu, baru Core; ruang = id channel; kaki lewat 'legneed' / 'incoming' auto), tapi lewat api.pvEnter(cid, pin).
    // Nilai kembali { ok } atau { ok:false, wrong:true } kalau PIN ditolak Core (sesi ditutup tanpa toast: UI yang meminta PIN lagi). Tidak ada keadaan setengah masuk:
    // sesi hanya aktif kalau Core sudah menerima. Berpindah dari channel publik lain = keluar dari yang lama dulu (kalau PIN-nya salah, yang lama sudah terlepas).
    async enterPublic(cid, name, pin) {
      cid = String(cid);
      let old = this.cur;
      if (old && old.pv && old.room === cid) return { ok: true }; // sudah di sini
      if (old && old.pv) { await this._chanLeave(old); old = this.cur; }
      if (old) { try { this.ui.ended({ reason: 'error', err: old.vc ? ct('cl.err.inVc', 'Kamu sedang di channel suara. Keluar dulu sebelum masuk channel lain.') : ct('cl.err.busy', 'Masih ada panggilan yang berlangsung'), local: false }); } catch {} return { ok: false }; }
      const c = this.cur = this._new(null, name, 'out', null);
      c.legs = []; c.room = cid; c.phase = 'connecting'; c.pv = true; c.vc = { gid: '', cid, name: String(name || 'Channel') }; c.entered = 0; c.camOff = true;
      this._render();
      const stream = await this._gum(c);
      if (this.cur !== c) { if (stream) this._stopStream(stream); return { ok: false }; } // ditutup saat menunggu izin mikrofon
      if (!stream) { this._finish(c, { reason: 'mic', err: this._micErr }); return { ok: false }; }
      c.stream = stream; this._applyMic(c);
      this._natBegin(c);
      let r;
      try { r = await this.api.pvEnter(cid, pin ? String(pin) : undefined); } catch (e) { r = { ok: false, err: (e && e.message) || ct('cl.err.chanJoin', 'Gagal masuk channel') }; }
      if (this.cur !== c) { if (r && r.ok) this.api.pvLeave(); return { ok: false }; } // keluar saat menunggu inti
      if (!r || !r.ok) {
        if (r && (r.code === 'pin' || r.err === 'PIN salah')) { this._finish(c, { reason: 'ended', local: true }); return { ok: false, wrong: true }; }
        this._finish(c, { reason: 'error', err: (r && r.err) || ct('cl.err.chanJoin', 'Gagal masuk channel') }); return { ok: false };
      }
      c.entered = this.now(); c.phase = 'active'; c.since = c.entered;
      if (c.muted || c.deafened) this._announce(c);
      this._render();
      return { ok: true };
    }
    // Core mengeluarkanku dari channel publik (dihapus / dikunci / PIN diganti) dan sudah melepas kakinya: sesi di sini ditutup seketika, tanpa menunggu sinkronisasi.
    pvKicked(cid) {
      const c = this.cur;
      if (!c || !c.pv || c.room !== String(cid)) return false;
      this._finish(c, { reason: 'ended', local: true });
      return true;
    }
    // Samakan sesi channel dengan Core: Core melepasku (channel dihapus / dikunci / aku dikeluarkan) -> sesi ditutup;
    // selain itu kaki yang hilang dilepas dan kaki yang tidak punya media di sini ditutup (aturan yang sama dengan ruang biasa).
    // Channel diganti namanya saat aku di dalamnya: judul layar ikut berubah.
    setChannelName(name) {
      const c = this.cur; name = String(name || '');
      if (!c || !c.vc || !name || c.vc.name === name) return false;
      c.vc.name = name; this._render(); return true;
    }
    _syncVc(c, snap, vc, pv) {
      if (!c.entered || this.now() - c.entered <= SYNC_GUARD_MS) return; // masih menunggu mikrofon / jawaban Core, atau snapshot ini bisa lebih tua
      if (c.pv) { if (pv !== c.room) { this._finish(c, { reason: 'ended' }); return; } } // channel publik: state().pv.me harus masih channel ini
      else if (!vc || vc.cid !== c.room || vc.gid !== c.vc.gid) { this._finish(c, { reason: 'ended' }); return; }
      this._reconcile(c, snap && snap.room === c.room ? snap : { room: c.room, legs: [] });
    }

    // Terima panggilan masuk yang sedang berdering.
    async accept() {
      const c = this.cur, l = c && c.legs[0];
      if (c && c.invite && c.dir === 'in' && c.phase === 'ringing') return this._acceptInvite(c);
      if (!c || c.dir !== 'in' || c.phase !== 'ringing' || l.accepting) return { ok: false };
      l.accepting = true; c.phase = l.phase = 'connecting';
      c.video = sdpHasVideo(l.offer); // tawaran berisi video = panggilan video: kamera ikut dinyalakan
      c.camOff = !c.video;
      this._ring(null); this._render();
      const stream = await this._gum(c);
      if (this.cur !== c) { if (stream) this._stopStream(stream); return { ok: false }; } // penelepon membatalkan saat menunggu izin
      if (!stream) { this.api.callReject(l.cid); this._finish(c, { reason: 'mic', err: this._micErr }); return { ok: false }; }
      c.stream = stream; this._applyMic(c);
      this._natBegin(c);
      if (c.video) this._render(); // pratinjau kamera sendiri
      if (!(await this._prepIce(c, l))) return { ok: false };
      try {
        const pc = this._pc(c, l);
        await pc.setRemoteDescription({ type: 'offer', sdp: l.offer });
        l.vlatent = sdpVideoKind(l.offer) === 'latent';
        this._vidAnswer(c, l, pc); // panggilan suara: jalur video kosong dari tawaran dijadikan sendrecv, supaya kamera bisa dinyalakan nanti
        await this._drain(l);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        if (this.cur !== c) return { ok: false };
        const r = await this.api.callAnswer(l.cid, (pc.localDescription && pc.localDescription.sdp) || ans.sdp);
        if (this.cur !== c) return { ok: false };
        if (!r || !r.ok) { this._finish(c, { reason: 'error', err: (r && r.err) || ct('cl.err.answer', 'Gagal menjawab panggilan') }); return { ok: false }; }
      } catch (e) {
        const cid = l.cid;
        this._finish(c, { reason: 'error', err: ct('cl.err.audioConn', 'Gagal menyambungkan audio: {m}', { m: (e && e.message) || e }) });
        this.api.callEnd(cid);
        return { ok: false };
      }
      return { ok: true };
    }

    // Terima undangan ke panggilan yang sedang berjalan. Mikrofon dulu; baru Core diberi tahu. Core lalu mengirim 'legneed' untuk tiap anggota
    // yang harus kuhubungi (id lebih kecil dariku) -> addLeg; anggota lain menelepon aku -> _joinLeg. Event itu bisa tiba sebelum jawaban IPC ini,
    // jadi mikrofon, `joining`, dan `room` sudah harus siap sebelum callInviteAccept dipanggil.
    async _acceptInvite(c) {
      c.phase = 'connecting'; c.accepting = true; c.camOff = !c.video;
      this._ring(null); this._render();
      const room = c.room, stream = await this._gum(c);
      if (this.cur !== c) { if (stream) this._stopStream(stream); return { ok: false }; } // pengundang membatalkan / undangan kedaluwarsa saat menunggu izin
      if (!stream) { this.api.callInviteDecline(room); this._finish(c, { reason: 'mic', err: this._micErr }); return { ok: false }; }
      c.stream = stream; this._applyMic(c); c.joining = true; c.invite = false;
      this._natBegin(c);
      const r = await this.api.callInviteAccept(room);
      if (this.cur !== c) { if (r && r.ok) this.api.callLeave(room); return { ok: false }; } // ditutup saat menunggu inti
      if (!r || !r.ok) { c.joining = false; this._finish(c, { reason: 'error', err: (r && r.err) || ct('cl.err.invAccept', 'Gagal menerima undangan') }); return { ok: false }; }
      return { ok: true };
    }

    // Undang satu orang online ke panggilan yang sedang aktif. Hasil akhirnya datang sebagai event (kaki baru, atau invitefail -> ui.inviteFailed).
    async invite(peerId, name) {
      const c = this.cur, l = c && c.legs.find((x) => x.phase === 'active' && x.cid);
      if (!c || c.invite || !l) return { ok: false, err: ct('cl.err.notConn', 'Panggilan belum tersambung') };
      if (c.legs.some((x) => x.peer === peerId) || c.invites.has(peerId)) return { ok: false, err: ct('cl.err.inCall', 'Dia sudah ada di panggilan ini') };
      const r = await (c.video && !c.camOff ? this.api.callInvite(l.cid, peerId, true) : this.api.callInvite(l.cid, peerId)); // Core mencari ruangnya lewat kaki yang aktif; ruang video membawa penanda ke yang diundang
      if (this.cur !== c) return { ok: false };
      if (!r || !r.ok) return { ok: false, err: (r && r.err) || ct('cl.err.invite', 'Gagal mengundang') };
      if (!c.legs.some((x) => x.peer === peerId)) { c.invites.set(peerId, { peer: peerId, name: name || '?', at: this.now() }); this._render(); }
      return { ok: true };
    }

    reject() {
      const c = this.cur;
      if (!c || c.dir !== 'in' || c.phase !== 'ringing') return;
      if (c.invite) { const room = c.room; this._finish(c, { reason: 'rejected', local: true }); this.api.callInviteDecline(room); return; }
      const cid = c.legs[0].cid;
      this._finish(c, { reason: 'rejected', local: true });
      this.api.callReject(cid);
    }

    // Akhiri / batalkan. Tampilan langsung tertutup; Core diberi tahu sesudahnya.
    hangup() {
      const c = this.cur;
      if (!c) return;
      if (c.vc) { // keluar dari channel: Core melepas semua kakinya dan memberi tahu anggota lain
        this._finish(c, { reason: 'ended', local: true });
        if (c.pv) this.api.pvLeave(); else this.api.vcLeave();
        return;
      }
      const cids = c.legs.map((x) => x.cid).filter(Boolean), room = c.room, active = c.phase === 'active', pending = c.invite && !c.joining;
      this._finish(c, { reason: active ? 'ended' : 'cancelled', local: !this._failed(c) });
      if (pending) this.api.callInviteDecline(room); // undangan belum diterima di Core (masih menunggu izin mikrofon)
      else if (c.joining || cids.length > 1) this.api.callLeave(room); // keluar dari seluruh ruang sekaligus (juga yang masih bergabung, belum punya kaki); peserta lain tetap berbicara
      else for (const cid of cids) this.api.callEnd(cid);
    }

    // Mikrofon mengikuti c.muted. Dipanggil juga saat trek mikrofon baru didapat, supaya status bisu tidak hilang.
    _applyMic(c) {
      try { if (c.stream) for (const t of c.stream.getAudioTracks()) t.enabled = !c.muted; } catch {}
      this._applyCam(c); // dipanggil tiap kali stream lokal baru didapat: status kamera mati yang kupilih saat dialog izin terbuka tidak hilang
    }
    // Kamera mengikuti c.camOff. Dipanggil saat stream lokal baru didapat: kamera yang kumatikan selagi dialog izin masih terbuka dilepas sekarang
    // (belum ada kaki, jadi tidak ada yang perlu dikosongkan). Selebihnya mati = trek dilepas (lihat _chanCam).
    _applyCam(c) {
      try {
        if (!c.stream || typeof c.stream.getVideoTracks !== 'function') return;
        for (const t of c.stream.getVideoTracks()) {
          if (!c.camOff) t.enabled = true;
          else { try { t.stop(); } catch {} try { if (typeof c.stream.removeTrack === 'function') c.stream.removeTrack(t); } catch {} }
        }
      } catch {}
    }
    // Bisukan / pulihkan audio satu lawan bicara, hanya di perangkat ini. Pemutar boleh menyediakan stopAudio.mute(on);
    // bila tidak ada, trek masuk dimatikan (enabled=false) sebagai cadangan.
    _deafLeg(l, on) {
      try {
        if (l.stopAudio && typeof l.stopAudio.mute === 'function') { l.stopAudio.mute(on); return; }
        if (l.remote && typeof l.remote.getAudioTracks === 'function') for (const t of l.remote.getAudioTracks()) t.enabled = !on;
      } catch {}
    }
    // Siarkan status mik/deafen ke peserta lain (4c-2). Core meneruskannya ke semua kaki aktif; gagal kirim tidak boleh mengganggu panggilan.
    _announce(c) {
      try {
        if (!c.room || c.phase === 'ringing' || typeof this.api.callMedia !== 'function') return;
        const cam = this._camState(c); // kamera hidup? hanya dikabarkan di panggilan berkamera, supaya suara saja tetap memakai tiga argumen
        Promise.resolve(cam === undefined ? this.api.callMedia(c.room, !!c.muted, !!c.deafened) : this.api.callMedia(c.room, !!c.muted, !!c.deafened, cam)).catch(() => {});
      } catch {}
    }
    // Kamera milikku hidup (true), mati (false), atau tidak relevan (undefined: panggilan ini tanpa kamera).
    _camState(c) { return c && c.video ? !c.camOff : undefined; }
    _applyDeaf(c) { for (const l of c.legs) this._deafLeg(l, !!c.deafened); }

    mute(on) {
      const c = this.cur;
      if (!c) return false;
      if (c.deafened) { // seperti Discord: membuka mik saat deafen = lepas deafen sekaligus unmute
        if (on === true) return true;
        c.deafened = false; c.muted = false; c.premute = false;
        this._applyDeaf(c); this._applyMic(c); this._announce(c); this._render();
        return false;
      }
      c.muted = typeof on === 'boolean' ? on : !c.muted;
      this._applyMic(c); this._announce(c);
      this._render();
      return c.muted;
    }

    // Deafen: tidak mendengar siapa pun (hanya di perangkat ini; peserta lain tetap saling mendengar) dan mik ikut mati.
    // Saat dilepas, keadaan mute sebelum deafen dipulihkan. Tidak berlaku saat panggilan masih berdering.
    deafen(on) {
      const c = this.cur;
      if (!c || c.phase === 'ringing') return false;
      const want = typeof on === 'boolean' ? on : !c.deafened;
      if (want === c.deafened) return c.deafened;
      if (want) { c.premute = c.muted; c.deafened = true; c.muted = true; }
      else { c.deafened = false; c.muted = c.premute; c.premute = false; }
      this._applyDeaf(c); this._applyMic(c); this._announce(c); this._render();
      return c.deafened;
    }

    // Kamera on/off. on=true nyalakan, on=false matikan, tanpa argumen = balik. Berlaku di semua panggilan (channel, 1-1, grup), seperti WhatsApp / Discord:
    // panggilan suara bisa jadi video dan sebaliknya. Menyala = trek kamera dipasang lewat replaceTrack di jalur video tiap kaki (tanpa negosiasi ulang);
    // mati = jalur dikosongkan dan kamera dilepas (lampu kamera padam). Izin kamera baru diminta saat pertama dinyalakan. Mengembalikan Promise<c.camOff>.
    camera(on) {
      const c = this.cur;
      if (!c || c.invite || c.phase === 'ringing') return Promise.resolve(false);
      if (!c.stream) { // dialog izin mikrofon / kamera masih terbuka: pilihan disimpan dan berlaku begitu stream didapat (_applyCam)
        if (c.video) { c.camOff = typeof on === 'boolean' ? !on : !c.camOff; this._render(); }
        return Promise.resolve(c.camOff);
      }
      return this._chanCam(c, on);
    }
    // Android memutus kamera saat aplikasi di latar belakang atau layar mati, dan kamera channel yang membeku masih menghitung ke batas 4 serta tampil
    // sebagai bingkai mati di layar orang lain. Jadi kamera channel dimatikan sungguhan saat aplikasi ke latar belakang; kembali ke aplikasi tidak
    // menyalakannya lagi sendiri (privasi), hanya memberi tahu. Panggilan 1-1 dan grup tidak disentuh.
    async appHidden(hidden) {
      const c = this.cur;
      if (!c || !c.vc) return;
      if (hidden === true) {
        if (!c.camOff && !c.camBusy) { c.camBg = true; await this._chanCam(c, false); }
      } else if (c.camBg) {
        c.camBg = false;
        try { if (this.ui.notice) this.ui.notice(ct('cl.notice.camBg', 'Kamera dimatikan saat aplikasi di latar belakang. Nyalakan lagi dengan tombol Kamera.')); } catch {}
      }
    }
    // Kamera hidup = trek kamera di c.stream dan di jalur video tiap kaki (replaceTrack); mati = jalur dikosongkan dan kamera dilepas
    // (lampu kamera padam). Izin kamera baru diminta di sini, saat pertama dinyalakan. Mengembalikan c.camOff.
    // Batas 4 kamera hanya untuk channel (Core menegakkannya); panggilan 1-1 / grup tidak dibatasi selain batas peserta.
    async _chanCam(c, on) {
      if (c.camBusy || !c.stream || !c.room) return c.camOff;
      const want = typeof on === 'boolean' ? on : c.camOff; // true = nyalakan
      if (want === !c.camOff) return c.camOff;
      if (want) c.camBg = false; // dinyalakan sendiri lagi: tidak perlu pemberitahuan "dimatikan di latar belakang"
      const notice = (t) => { if (this.cur === c) { try { if (this.ui.notice) this.ui.notice(t); } catch {} } };
      if (want && c.vc && c.legs.filter((x) => x.vcam === true).length >= CAM_MAX) { notice(camFullMsg()); return c.camOff; } // sudah penuh: jangan minta izin kamera dulu
      if (want && !c.vc && c.legs.length && !c.legs.some((x) => x.vsender)) { notice(noVidMsg()); return c.camOff; } // lawan memakai versi lama: tidak ada jalur video, jangan buka kamera sia-sia
      c.camBusy = true;
      try {
        if (want) {
          let gs = null;
          try { gs = await this.rtc.getUserMedia({ video: videoConstraints(c.facing) }); }
          catch (e) {
            const d = e && (e.userMsg || e.detail || [e.name, e.message].filter(Boolean).join(': '));
            c.camErr = d ? ct('cl.err.camOnD', 'Kamera tidak bisa dipakai [{d}].', { d: String(d).slice(0, 80) }) : ct('cl.err.camOn', 'Kamera tidak bisa dipakai.');
            if (this.cur === c) { try { if (this.ui.notice) this.ui.notice(c.camErr); } catch {} }
            return c.camOff;
          }
          const vt = gs && typeof gs.getVideoTracks === 'function' ? gs.getVideoTracks()[0] || null : null;
          if (this.cur !== c || !vt) { if (gs) this._stopStream(gs); return c.camOff; } // keluar / panggilan selesai saat menunggu izin, atau tanpa trek
          // Core memutuskan (channel: batas 4 dan urutan menyala): bila ditolak, kamera dilepas lagi tanpa pernah dikirim ke siapa pun.
          let rr = null;
          try { rr = await this.api.callMedia(c.room, !!c.muted, !!c.deafened, true); } catch {}
          if (this.cur !== c) { this._stopStream(gs); return c.camOff; }
          if (rr && rr.ok === false && rr.err === 'cam_full') { this._stopStream(gs); notice(camFullMsg()); return c.camOff; }
          c.camErr = '';
          const old = typeof c.stream.getVideoTracks === 'function' ? c.stream.getVideoTracks() : []; // sisa trek lama (kamera panggilan video yang belum dilepas)
          for (const t of old) { try { t.stop(); } catch {} try { c.stream.removeTrack(t); } catch {} }
          c.video = true; c.camOff = false; c.vrev = (c.vrev || 0) + 1; // sebelum ada await lagi: mute di sela itu (_applyCam) tidak boleh melepas trek yang baru datang
          try { c.stream.addTrack(vt); } catch {}
          for (const l of c.legs) if (l.vsender && typeof l.vsender.replaceTrack === 'function') { try { await l.vsender.replaceTrack(vt); } catch {} }
          if (this.cur !== c) { this._stopStream({ getTracks: () => [vt] }); return c.camOff; }
        } else {
          for (const l of c.legs) if (l.vsender && typeof l.vsender.replaceTrack === 'function') { try { await l.vsender.replaceTrack(null); } catch {} }
          const old = typeof c.stream.getVideoTracks === 'function' ? c.stream.getVideoTracks() : [];
          for (const t of old) { try { t.stop(); } catch {} try { c.stream.removeTrack(t); } catch {} }
          c.camOff = true;
        }
        if (!want) this._announce(c); // menyalakan sudah dikabarkan di atas (bersama keputusan Core)
        return c.camOff;
      } finally {
        c.camBusy = false;
        if (this.cur === c) this._render();
      }
    }
    // Balik kamera depan <-> belakang. Hasil true bila berhasil.
    flipCamera() {
      const c = this.cur;
      if (!c || !c.video || !c.stream || c.camBusy || c.phase === 'ringing' || c.camOff) return Promise.resolve(false);
      return this._swapCam(c, c.facing === 'environment' ? 'user' : 'environment', ct('cl.err.camOther', 'Kamera lain tidak tersedia'));
    }
    // Ganti trek kamera ke arah `want`. Kamera lama dilepas dulu (kamera ponsel umumnya tidak bisa dibuka dua kali sekaligus); bila yang baru gagal,
    // coba kembali ke arah sebelumnya. Trek baru menggantikan yang lama di semua kaki lewat replaceTrack (tanpa renegotiation) dan di c.stream,
    // jadi kaki yang datang belakangan ikut memakai kamera yang benar.
    async _swapCam(c, want, failMsg) {
      if (c.camBusy || !c.stream) return false;
      c.camBusy = true;
      let nt = null, used = want;
      try {
        const ask = (f) => Promise.resolve().then(() => this.rtc.getUserMedia({ video: videoConstraints(f) }));
        const old = typeof c.stream.getVideoTracks === 'function' ? c.stream.getVideoTracks() : [];
        for (const t of old) { try { t.stop(); } catch {} }
        let gs = null;
        try { gs = await ask(want); } catch { if (want !== c.facing) { try { gs = await ask(c.facing); used = c.facing; } catch {} } }
        nt = gs && typeof gs.getVideoTracks === 'function' ? gs.getVideoTracks()[0] || null : null;
        if (this.cur !== c) { if (gs) this._stopStream(gs); return false; } // panggilan selesai saat menunggu kamera
        if (!nt) {
          if (gs) this._stopStream(gs);
          c.camOff = true; // kamera lama sudah dilepas dan yang baru tidak ada: tampil sebagai kamera mati; menyalakan lagi mencoba ulang
          try { if (this.ui.notice) this.ui.notice(failMsg || ct('cl.err.camPlain', 'Kamera tidak bisa dipakai')); } catch {}
          return false;
        }
        nt.enabled = !c.camOff;
        for (const l of c.legs) if (l.vsender && typeof l.vsender.replaceTrack === 'function') { try { await l.vsender.replaceTrack(nt); } catch {} }
        if (this.cur !== c) { this._stopStream({ getTracks: () => [nt] }); return false; }
        try { for (const t of old) c.stream.removeTrack(t); c.stream.addTrack(nt); } catch {}
        c.facing = used === 'environment' ? 'environment' : 'user';
        c.vrev = (c.vrev || 0) + 1; // UI memasang ulang srcObject bila revisi berubah
        return used === want;
      } finally {
        c.camBusy = false;
        if (this.cur === c) this._render();
      }
    }

    // Peredam kebisingan, dipilih saat panggilan berjalan. Pilihan disimpan di panggilan; bila mikrofon belum ada,
    // dipakai saat getUserMedia. Perubahan diterapkan satu per satu (kunci noiseBusy) supaya ketukan beruntun tidak saling tabrak.
    setNoise(mode) {
      const c = this.cur, m = normNoise(mode);
      if (!c || !m || c.phase === 'ringing' || c.noise === m) return Promise.resolve(false);
      c.noise = m;
      this._render();
      if (!c.stream) return Promise.resolve(true);
      return this._applyNoise(c).then(() => true);
    }
    async _applyNoise(c) {
      if (c.noiseBusy) return; // putaran yang sedang jalan akan membaca c.noise terbaru
      c.noiseBusy = true;
      try {
        let applied;
        do {
          applied = c.noise;
          // 1) constraint pada trek mikrofon asli (Mati/Standar; Kuat memakai Standar sebagai dasar)
          try { for (const t of c.stream.getAudioTracks()) if (typeof t.applyConstraints === 'function') await t.applyConstraints(audioConstraints(applied)); } catch {}
          if (this.cur !== c) return;
          // 2) jalur WebAudio untuk Kuat; dilepas lagi bila pilihan bukan Kuat
          if (applied === 'strong' && !c.proc) {
            let p = null; try { p = typeof this.rtc.strengthen === 'function' ? await this.rtc.strengthen(c.stream) : null; } catch {}
            if (this.cur !== c) { try { if (p) p.stop(); } catch {} return; }
            if (!p || !p.stream || !(await this._send(c, p.stream))) {
              try { if (p) p.stop(); } catch {}
              if (this.cur !== c) return;
              c.noise = 'standard'; this._render();
              try { if (this.ui.notice) this.ui.notice(ct('cl.notice.noiseStrong', 'Peredam Kuat tidak bisa dipakai di perangkat ini. Kembali ke Standar.')); } catch {}
            } else c.proc = p;
          } else if (applied !== 'strong' && c.proc) {
            const p = c.proc; c.proc = null;
            await this._send(c, c.stream);
            try { p.stop(); } catch {}
          }
          if (this.cur !== c) return;
        } while (c.noise !== applied);
      } finally { c.noiseBusy = false; }
    }
    // Ganti trek yang dikirim ke lawan tanpa negosiasi ulang (replaceTrack). false bila gagal.
    // Berlaku ke semua kaki (mikrofon dipakai bersama). false bila tidak ada pengirim atau salah satunya gagal.
    async _send(c, stream) {
      try {
        const t = stream.getAudioTracks()[0], ss = c.legs.map((x) => x.sender).filter(Boolean);
        if (!ss.length || !t || ss.some((x) => typeof x.replaceTrack !== 'function')) return false;
        await Promise.all(ss.map((x) => x.replaceTrack(t)));
        return true;
      } catch { return false; }
    }

    // Speaker (hanya bila cangkang menyediakan). Gagal di cangkang -> tombol kembali ke keadaan semula.
    speaker(on) {
      const c = this.cur;
      if (!c || !this.native || !c.nat) return false;
      const want = typeof on === 'boolean' ? on : !c.speaker, was = c.speaker;
      c.speaker = want;
      this._render();
      let p; try { p = Promise.resolve(this.native.speaker(want)); } catch { p = Promise.resolve(false); }
      p.then((r) => { if (r === false && this.cur === c && c.speaker === want) { c.speaker = was; this._render(); } }, () => { if (this.cur === c && c.speaker === want) { c.speaker = was; this._render(); } });
      return want;
    }

    async _drain(l) {
      for (const d of l.remoteIce.splice(0)) await this._addIce(l, d);
    }
    async _addIce(l, data) {
      try { await l.pc.addIceCandidate(JSON.parse(data)); } catch (e) { try { console.warn('Archne: kandidat ICE ditolak', e && e.message); } catch {} } // kandidat buruk/kedaluwarsa tidak boleh menjatuhkan panggilan
    }

    // Event 'call' dari Core.
    async onEvent(ev) {
      if (!ev || typeof ev !== 'object') return;
      const c = this.cur;
      if (ev.ev === 'incoming') {
        if (c && ev.auto && ev.room && ev.room === c.room) { await this._joinLeg(ev); return; } // anggota ruang yang sama: kaki baru, dijawab otomatis
        if (c) { if (!c.legs.some((x) => x.cid === ev.cid)) this.api.callReject(ev.cid); return; } // sudah sibuk di sisi UI
        const n = this.cur = this._new(ev.peer, ev.name, 'in', ev.cid), nl = n.legs[0];
        nl.offer = ev.sdp; nl.remoteIce = (Array.isArray(ev.ice) ? ev.ice : []).slice(0, ICE_BUF_MAX);
        n.video = sdpHasVideo(ev.sdp); // layar dering menyebut "video"; kamera baru dinyalakan saat dijawab (accept)
        this._ring('in'); this._render();
        return;
      }
      if (ev.ev === 'missed') {
        try { this.ui.ended({ reason: 'missed', wasActive: false, dur: 0, name: ev.name, peer: ev.peer, dir: 'in', local: false }); } catch {}
        return;
      }
      if (ev.ev === 'invited') {
        if (c || !ev.room) { if (ev.room) this.api.callInviteDecline(ev.room); return; } // sudah dalam panggilan: Core biasanya sudah menjawab sibuk
        const n = this.cur = this._new(ev.peer, ev.name, 'in', null);
        n.legs = []; n.room = ev.room; n.invite = true; n.members = Array.isArray(ev.members) ? ev.members : [];
        n.video = ev.video === true; // ruang video: kamera dinyalakan saat undangan diterima (_acceptInvite -> _gum)
        this._ring('in'); this._render();
        return;
      }
      if (ev.ev === 'inviteend') { // pengundang membatalkan, atau undangan kedaluwarsa, sebelum kujawab
        if (c && c.invite && c.room === ev.room) this._finish(c, { reason: ev.reason === 'expired' ? 'missed' : 'cancelled' });
        return;
      }
      if (ev.ev === 'legneed') { // anggota ruang yang harus kuhubungi (id-ku lebih kecil): aku yang membuat tawaran
        if (c && c.room && c.room === ev.room && c.stream) await this.addLeg(ev.peer, ev.name);
        return;
      }
      if (ev.ev === 'invitefail') {
        if (!c || c.room !== ev.room) return;
        const p = c.invites.get(ev.peer);
        this._invDone(c, ev.peer);
        try { if (this.ui.inviteFailed) this.ui.inviteFailed({ peer: ev.peer, name: ev.name || (p && p.name) || '?', reason: ev.reason }); } catch {}
        return;
      }
      if (ev.ev === 'camoff') { // Core: kameraku kalah urutan (dua orang menyalakan bersamaan, sudah ada 4): lepas kamera dan beri tahu
        if (c && c.vc && c.room === ev.room && !c.camOff) { try { if (this.ui.notice) this.ui.notice(camFullMsg()); } catch {} await this._chanCam(c, false); }
        return;
      }
      if (ev.ev === 'joining') return; // keadaan bergabung sudah kupegang sendiri (c.joining)
      const l = c && c.legs.find((x) => x.cid === ev.cid);
      if (!l) { // tidak ada kaki dengan cid ini; tapi Core bilang ruangnya bubar (mis. bergabung lalu tak ada yang tersambung)
        if (c && ev.ev === 'end' && ev.last === true && ev.room && ev.room === c.room && (c.joining || !c.invite)) this._finish(c, { reason: ev.reason, wasActive: ev.wasActive });
        return; // panggilan lain / sudah selesai
      }
      if (ev.ev === 'peerstate') { // status mik/deafen lawan bicara; deafen selalu berarti mik mati. Ikonnya tampil lewat overlayHtml (4c-3).
        l.deafened = ev.deafened === true; l.muted = l.deafened || ev.muted === true;
        if (typeof ev.cam === 'boolean') l.vcam = ev.cam; // kamera lawan hidup/mati (bila dia mengabarkannya)
        this._render();
        return;
      }
      if (ev.ev === 'answer') {
        if (l.dir !== 'out' || !l.pc || l.phase !== 'dialing') return;
        try {
          await l.pc.setRemoteDescription({ type: 'answer', sdp: ev.sdp });
          l.vlatent = sdpVideoKind(ev.sdp) === 'latent';
          if (this.cur !== c) return;
          l.phase = 'connecting'; if (c.phase !== 'active') c.phase = 'connecting'; // kaki baru di ruang yang sudah aktif tidak boleh memundurkan fase ruang / mengulang durasi
          this._ring(null); this._render();
          await this._drain(l);
        } catch (e) { const cid = l.cid; l.failed = true; this._finish(c, { reason: 'failed' }); this.api.callEnd(cid); }
      } else if (ev.ev === 'ice') {
        if (typeof ev.data !== 'string') return;
        if (l.pc && l.pc.remoteDescription) await this._addIce(l, ev.data);
        else if (l.remoteIce.length < ICE_BUF_MAX) l.remoteIce.push(ev.data); // belum ada deskripsi jarak jauh: tahan dulu
      } else if (ev.ev === 'end') {
        if (!c.vc && (c.legs.length <= 1 || ev.last === true)) this._finish(c, { reason: ev.reason, wasActive: ev.wasActive });
        else this._removeLeg(c, l, ev.reason); // peserta itu keluar, ruang jalan terus
      }
    }

    // Dipanggil tiap UI mengambil state: menangkap panggilan yang event-nya terlewat (UI baru terpasang / SSE terputus).
    // Snapshot bisa sedikit lebih tua dari state di sini, jadi semua yang masih baru (< SYNC_GUARD_MS) dibiarkan.
    // vc (opsional): state().vc = channel yang Core catat sedang kumasuki; dipakai untuk sesi channel yang bisa tanpa kaki sama sekali.
    // pv (opsional): state().pv.me = id channel publik yang Core catat sedang kumasuki; aturannya sama dengan vc.
    sync(snap, vc, pv) {
      const c = this.cur;
      if (c && c.vc) { this._syncVc(c, snap, vc, pv || null); return; }
      if (!c && pv) this.api.pvLeave(); // Core mengira aku di channel publik tapi tidak ada media di sini: lepas
      if (!c && vc) { this.api.vcLeave(); return; } // Core mengira aku di channel tapi tidak ada media di sini (halaman dimuat ulang): lepas
      if (!snap) {
        // inti sudah tidak punya ruangnya (event end terlewat); `room` baru terisi setelah inti menjawab, jadi panggilan yang masih menelepon aman
        if (c && c.room && this.now() - c.at > SYNC_GUARD_MS) this._finish(c, { reason: c.invite && !c.joining ? 'missed' : 'ended' });
        return;
      }
      if (!c) {
        if (snap.invite) this.onEvent({ ev: 'invited', room: snap.room, peer: snap.peer, name: snap.name, members: snap.members, video: snap.video === true });
        else if (snap.dir === 'in' && snap.state === 'ringing' && !snap.joining) this.onEvent({ ev: 'incoming', cid: snap.cid, peer: snap.peer, name: snap.name, sdp: snap.sdp, ice: snap.ice });
        else this._orphan(snap); // media panggilan ini hilang bersama halaman sebelumnya: tidak bisa dilanjutkan
        return;
      }
      this._reconcile(c, snap);
    }
    // Bersihkan ruang di inti yang tidak punya media di sini. Ruang berkaki banyak / yang sedang bergabung: keluar sekaligus; kaki tunggal: tutup kakinya.
    _orphan(snap) {
      const legs = Array.isArray(snap.legs) ? snap.legs.filter((x) => x && x.cid) : [];
      if (snap.joining || legs.length > 1) this.api.callLeave(snap.room || snap.cid);
      else this.api.callEnd(snap.cid);
    }
    // Samakan ruang yang kupegang dengan snapshot inti: kaki yang hilang dilepas, kaki yatim ditutup, undangan keluar yang sudah selesai dipangkas.
    _reconcile(c, snap) {
      const now = this.now(), old = now - c.at > SYNC_GUARD_MS;
      if (c.invite) { // masih berdering: undangannya harus masih ada di inti
        if (old && !(snap.invite && snap.room === c.room)) this._finish(c, { reason: 'missed' });
        return;
      }
      if (!c.room) return; // masih menelepon, inti belum menjawab
      if (snap.room && snap.room !== c.room) { if (old) this._finish(c, { reason: 'ended' }); return; }
      const snapLegs = (Array.isArray(snap.legs) ? snap.legs : [{ cid: snap.cid }]).filter((x) => x && x.cid), have = new Set(snapLegs.map((x) => x.cid));
      // 1) kaki yang kupegang tetapi sudah tidak ada di inti (event end terlewat)
      for (const l of [...c.legs]) {
        if (!l.cid || have.has(l.cid) || now - l.at <= SYNC_GUARD_MS) continue; // kaki yang belum punya cid / baru dibuat bisa lebih baru dari snapshot
        if (!c.vc && c.legs.length <= 1 && !c.joining) { this._finish(c, { reason: 'ended' }); return; }
        this._removeLeg(c, l, 'ended'); // inti sudah melepasnya; tidak perlu callEnd
      }
      // 2) kaki di inti yang tidak punya media di sini: tunggu terlihat dua kali berselang >= guard (event 'incoming'-nya mungkin masih di jalan), baru ditutup
      const seen = c.stale || (c.stale = new Map());
      for (const k of [...seen.keys()]) if (!have.has(k) || c.legs.some((l) => l.cid === k)) seen.delete(k);
      for (const x of snapLegs) {
        if (c.legs.some((l) => l.cid === x.cid)) continue;
        const t = seen.get(x.cid);
        if (t === undefined) seen.set(x.cid, now);
        else if (now - t >= SYNC_GUARD_MS) { seen.delete(x.cid); this.api.callEnd(x.cid); }
      }
      // 3) undangan keluar: yang sudah tidak menunggu di inti (invitefail terlewat) atau sudah jadi kaki dihapus dari daftar
      const pend = new Set((Array.isArray(snap.invites) ? snap.invites : []).map((x) => x && x.peer));
      let changed = false;
      for (const [peer, v] of [...c.invites]) if ((!pend.has(peer) && now - (v.at || 0) > SYNC_GUARD_MS) || c.legs.some((l) => l.peer === peer)) { c.invites.delete(peer); changed = true; }
      if (changed) this._render();
    }
  }

  // ---- peramban ----
  // bridge (opsional, Android): sebelum getUserMedia, minta cangkang memastikan izin RECORD_AUDIO (WebView tidak memintanya sendiri).
  const micMsg = (res) => (res === 'denied' ? ct('cl.mic.denied', 'Izin mikrofon diperlukan untuk panggilan. Coba lagi dan pilih Izinkan.')
    : res === 'blocked' ? ct('cl.mic.blocked', 'Izin mikrofon ditolak. Buka Pengaturan > Aplikasi > Archne > Izin, lalu izinkan Mikrofon.') : '');
  // Pesan kamera dipendekkan karena Controller menyelipkannya dalam kalimat "Kamera tidak bisa dipakai [...]. Panggilan dilanjutkan tanpa video." (maks 80 huruf).
  const camMsg = (res) => (res === 'denied' ? ct('cl.cam.denied', 'izin kamera ditolak')
    : res === 'blocked' ? ct('cl.cam.blocked', 'izin kamera ditolak; izinkan di Pengaturan > Aplikasi > Archne') : '');
  // ---- RNNoise (berkas di renderer/vendor/, lihat README "Peredam kebisingan") ----
  const RNNOISE_LOAD_MS = 8000;
  const RNNOISE_DIR = 'vendor/';
  const RNNOISE_ID = '@sapphi-red/web-noise-suppressor/rnnoise';
  const SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];
  const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('waktu habis')), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
  const wasmCaches = new WeakMap(); // per window: { simd, bin } biner WASM, dimuat sekali per sesi aplikasi
  function loadBinary(w, url) {
    // XHR cadangan karena fetch() ke file:// (Electron memuat UI lewat loadFile) tidak selalu diizinkan
    const viaXhr = () => new Promise((res, rej) => { const x = new w.XMLHttpRequest(); x.open('GET', url); x.responseType = 'arraybuffer'; x.onload = () => ((x.status === 200 || x.status === 0) && x.response && x.response.byteLength ? res(x.response) : rej(new Error('HTTP ' + x.status))); x.onerror = () => rej(new Error('xhr')); x.send(); });
    if (typeof w.fetch !== 'function') return viaXhr();
    return w.fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).catch(viaXhr);
  }
  async function rnnoiseChain(w, AC, stream) {
    if (typeof w.AudioWorkletNode !== 'function') return null;
    let ctx = null;
    try {
      ctx = new AC({ sampleRate: 48000 }); // RNNoise mengasumsikan 48 kHz
      if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') { ctx.close(); return null; }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      let simd = false; try { simd = !!(w.WebAssembly && w.WebAssembly.validate(new Uint8Array(SIMD_PROBE))); } catch {}
      let wasmCache = wasmCaches.get(w);
      if (!wasmCache || wasmCache.simd !== simd) { wasmCache = { simd, bin: await loadBinary(w, RNNOISE_DIR + (simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm')) }; wasmCaches.set(w, wasmCache); }
      await ctx.audioWorklet.addModule(RNNOISE_DIR + 'rnnoise-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
      const nn = new w.AudioWorkletNode(ctx, RNNOISE_ID, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { maxChannels: 1, wasmBinary: wasmCache.bin } });
      const dst = ctx.createMediaStreamDestination();
      src.connect(hp); hp.connect(nn); nn.connect(dst);
      const dead = ctx;
      return { engine: 'rnnoise', stream: dst.stream, stop() { try { nn.port.postMessage('destroy'); } catch {} try { src.disconnect(); hp.disconnect(); nn.disconnect(); } catch {} try { dead.close(); } catch {} } };
    } catch { try { if (ctx) ctx.close(); } catch {} return null; }
  }
  // Cadangan: pelewat-tinggi 90 Hz + noise gate (ScriptProcessor, thread utama)
  function gateChain(w, AC, stream) {
    let ctx = null;
    try {
      ctx = new AC();
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      const gate = new NoiseGate(ctx.sampleRate);
      sp.onaudioprocess = (e) => { try { gate.process(e.inputBuffer.getChannelData(0), e.outputBuffer.getChannelData(0)); } catch {} };
      const dst = ctx.createMediaStreamDestination();
      src.connect(hp); hp.connect(sp); sp.connect(dst);
      return { engine: 'gate', stream: dst.stream, stop() { try { sp.onaudioprocess = null; src.disconnect(); hp.disconnect(); sp.disconnect(); } catch {} try { ctx.close(); } catch {} } };
    } catch { try { if (ctx) ctx.close(); } catch {} return null; }
  }

  function browserRtc(w, bridge) {
    return {
      PeerConnection: w.RTCPeerConnection,
      async getUserMedia(c) {
        if (bridge && bridge.audio) {
          // Mikrofon dulu (hanya bila diminta; balik kamera meminta video saja), lalu kamera. Kamera ditolak -> galat bermuatan userMsg,
          // Controller jatuh ke suara saja dan memberi tahu alasannya. Izin yang sudah diberikan dijawab 'granted' seketika oleh plugin.
          if (!(c && c.video && !c.audio)) {
            const r = await bridge.ask('mic', undefined, 120000); // dialog izin bisa lama terbuka
            if (!r.ok) { const e = new Error('mic ' + r.res); e.userMsg = micMsg(r.res); e.detail = 'plugin: ' + (r.res || 'tanpa jawaban'); throw e; }
          }
          if (c && c.video) {
            const r = await bridge.ask('cam', undefined, 120000);
            if (!r.ok) { const e = new Error('cam ' + r.res); e.userMsg = camMsg(r.res); e.detail = 'plugin: ' + (r.res || 'tanpa jawaban'); throw e; }
          }
        }
        return w.navigator.mediaDevices.getUserMedia(c);
      },
      makeStream: (tracks) => new w.MediaStream(tracks),
      // Peredam Kuat. Utama: mikrofon -> pelewat-tinggi 90 Hz -> RNNoise (AudioWorklet + WASM, 48 kHz) -> stream baru.
      // Bila RNNoise gagal dimuat (WebAudio/worklet/WASM tidak ada, CSP, waktu habis): jatuh ke noise gate buatan sendiri.
      // Kontrak tetap { stream, stop(), engine }. null bila WebAudio sama sekali tidak ada.
      async strengthen(stream) {
        const AC = w.AudioContext || w.webkitAudioContext;
        if (!AC) return null;
        let r = null;
        const pending = rnnoiseChain(w, AC, stream);
        try { r = await withTimeout(pending, RNNOISE_LOAD_MS); } catch { r = null; pending.then((late) => { if (late) late.stop(); }, () => {}); } // terlambat: jangan bocorkan AudioContext
        return r || gateChain(w, AC, stream);
      },
      playRemote(stream) {
        const a = new w.Audio();
        a.autoplay = true; a.srcObject = stream;
        const p = a.play(); if (p && p.catch) p.catch(() => {});
        const stop = () => { try { a.pause(); a.srcObject = null; } catch {} };
        stop.mute = (on) => { try { a.muted = !!on; } catch {} }; // deafen: audio lawan dibisukan di perangkat ini
        return stop;
      },
    };
  }

  // ---- Picture-in-Picture: satu kartu saja ----
  // Kartu yang tampil di jendela kecil. cands = kunci kartu yang videonya hidup ('me' = kameraku, selain itu id peserta).
  // Aturan: orang lain didahulukan; 1-1 berarti lawan bicara, dan bila kameranya mati, kameraku. Bila ada beberapa orang berkamera (grup / channel),
  // yang paling keras bicara. Agar tidak melompat-lompat: kartu lama dipertahankan sampai yang lain jelas lebih keras (1,5x) dan sudah PIP_DWELL_MS.
  // levels = { kunci: 0..1 }; st = { key, at } hasil panggilan sebelumnya. Mengembalikan { key, at } baru.
  const PIP_SPEAK = 0.02, PIP_DWELL_MS = 1500;
  function pickPip(cands, levels, st, now) {
    const all = Array.isArray(cands) ? cands : [];
    const rem = all.filter((k) => k !== 'me');
    const pool = rem.length ? rem : all.filter((k) => k === 'me');
    if (!pool.length) return { key: null, at: now };
    const prev = st && pool.includes(st.key) ? st : null;
    if (pool.length === 1) return { key: pool[0], at: prev ? prev.at : now };
    const lv = (k) => (levels && Number(levels[k])) || 0;
    let best = pool[0];
    for (const k of pool) if (lv(k) > lv(best)) best = k;
    if (!prev) return { key: best, at: now };
    if (best !== prev.key && lv(best) >= PIP_SPEAK && lv(best) > lv(prev.key) * 1.5 && now - prev.at >= PIP_DWELL_MS) return { key: best, at: now };
    return prev;
  }
  // Pengukur level suara per peserta (WebAudio AnalyserNode; tidak tersambung ke speaker, jadi tidak menambah suara). sync(map) menerima { kunci: MediaStream }
  // dan memasang / melepas pengamat; levels() mengembalikan { kunci: 0..1 } dengan penurunan halus supaya tidak berkedip. Null bila WebAudio tidak ada.
  function levelMeter(AC) {
    if (!AC) return null;
    let ctx = null;
    const nodes = new Map(); // kunci -> { stream, src, an, buf, lvl }
    const drop = (k) => { const n = nodes.get(k); if (!n) return; try { n.src.disconnect(); } catch {} nodes.delete(k); };
    return {
      sync(map) {
        try { ctx = ctx || new AC(); if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); } catch { return; }
        for (const k of [...nodes.keys()]) if (!map || map[k] !== nodes.get(k).stream) drop(k);
        for (const k of Object.keys(map || {})) {
          if (nodes.has(k) || !map[k]) continue;
          try {
            const src = ctx.createMediaStreamSource(map[k]), an = ctx.createAnalyser();
            an.fftSize = 512; src.connect(an);
            nodes.set(k, { stream: map[k], src, an, buf: new Uint8Array(an.fftSize), lvl: 0 });
          } catch {}
        }
      },
      levels() {
        const out = {};
        for (const [k, n] of nodes) {
          try {
            n.an.getByteTimeDomainData(n.buf);
            let s = 0; for (let i = 0; i < n.buf.length; i++) { const x = (n.buf[i] - 128) / 128; s += x * x; }
            n.lvl = Math.max(Math.sqrt(s / n.buf.length), n.lvl * 0.7);
          } catch { n.lvl = 0; }
          out[k] = n.lvl;
        }
        return out;
      },
      stop() { for (const k of [...nodes.keys()]) drop(k); try { if (ctx && ctx.close) ctx.close(); } catch {} ctx = null; },
    };
  }

  // Jembatan ke cangkang Android lewat postMessage (halaman induk meneruskan ke plugin ArchneAudio). Null bila tidak tertanam di iframe.
  // Protokol: UI -> induk { archne:'native', action:'hello'|'mic'|'cam'|'call-begin'|'call-end'|'speaker'|'pip', id, on }
  //           induk -> UI { archne:'native-caps', audio }, { archne:'native-reply', id, ok, res }, { archne:'native-app', state:'background'|'foreground' }
  //           dan { archne:'native-app', state:'back', id } (tombol Kembali; UI menjawab { archne:'native', action:'back-result', id, on })
  //           dan { archne:'native-app', state:'pip', on } (jendela Picture-in-Picture tampil / ditutup)
  function nativeBridge(w, timers) {
    try { if (!w || !w.parent || w.parent === w || typeof w.addEventListener !== 'function') return null; } catch { return null; }
    const T = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    const waiting = new Map();
    let seq = 0;
    const b = {
      audio: false,
      onApp: null, // (hidden: boolean) => void; diisi UI: aplikasi ke latar belakang (true) atau kembali (false)
      onBack: null, // () => boolean; diisi UI: tombol Kembali perangkat. true = UI sudah menanganinya (tutup dialog, kecilkan panggilan), false = cangkang yang mundur / menyembunyikan aplikasi
      onPip: null, // (on: boolean) => void; diisi UI: jendela Picture-in-Picture tampil (true) atau ditutup (false)
      pipOn: false,
      pipWant: false,
      // Panggilan video aktif = siaga PiP. Hanya dikirim bila berubah.
      pip(on) {
        on = on === true;
        if (on === b.pipWant) return;
        b.pipWant = on;
        try { w.parent.postMessage({ archne: 'native', action: 'pip', id: 0, on }, '*'); } catch {}
      },
      ask(action, on, ms) {
        return new Promise((resolve) => {
          const id = ++seq;
          const t = T.setTimeout(() => { waiting.delete(id); resolve({ ok: false, res: 'timeout' }); }, ms || 4000);
          waiting.set(id, (r) => { T.clearTimeout(t); resolve(r); });
          try { w.parent.postMessage({ archne: 'native', action, id, on: on === true }, '*'); } catch { waiting.delete(id); T.clearTimeout(t); resolve({ ok: false, res: 'send' }); }
        });
      },
      hello() { try { w.parent.postMessage({ archne: 'native', action: 'hello', id: 0 }, '*'); } catch {} },
    };
    w.addEventListener('message', (e) => {
      const d = e && e.data;
      if (!e || e.source !== w.parent || !d || typeof d !== 'object') return;
      if (d.archne === 'native-caps') b.audio = d.audio === true;
      else if (d.archne === 'native-app' && d.state === 'back') { // tombol Kembali: cangkang menunggu jawaban (maks. sebentar), jadi selalu dijawab
        let on = false; try { on = typeof b.onBack === 'function' && b.onBack() === true; } catch { on = false; }
        try { w.parent.postMessage({ archne: 'native', action: 'back-result', id: d.id, on }, '*'); } catch {}
      }
      else if (d.archne === 'native-app' && d.state === 'pip') { b.pipOn = d.on === true; try { if (typeof b.onPip === 'function') b.onPip(b.pipOn); } catch {} }
      else if (d.archne === 'native-app' && (d.state === 'background' || d.state === 'foreground')) { try { if (typeof b.onApp === 'function') b.onApp(d.state === 'background'); } catch {} }
      else if (d.archne === 'native-reply' && waiting.has(d.id)) {
        const f = waiting.get(d.id); waiting.delete(d.id);
        f({ ok: d.ok === true, res: typeof d.res === 'string' ? d.res : '' });
      }
    });
    return b;
  }
  // Hook sesi audio untuk Controller (o.native); semuanya tidak berbuat apa-apa bila cangkang tidak punya audio.
  function makeNative(bridge) {
    if (!bridge) return null;
    return {
      begin: () => (bridge.audio ? bridge.ask('call-begin') : Promise.resolve({ ok: false })),
      end: () => (bridge.audio ? bridge.ask('call-end') : Promise.resolve({ ok: false })),
      speaker: (on) => (bridge.audio ? bridge.ask('speaker', on).then((r) => r.ok) : Promise.resolve(false)),
    };
  }

  // Nada dering dari WebAudio (tanpa berkas suara): 'in' = dering masuk (dua nada), 'out' = nada tunggu.
  function makeRinger(AudioCtx, timers) {
    const T = timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) };
    let ctx = null, tm = null;
    function tone(freqs, ms) {
      try {
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
        const t0 = ctx.currentTime, g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.04);
        g.gain.setValueAtTime(0.18, t0 + ms / 1000 - 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
        g.connect(ctx.destination);
        for (const f of freqs) { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t0); o.stop(t0 + ms / 1000 + 0.02); }
      } catch {}
    }
    function stop() { if (tm) { T.clearInterval(tm); tm = null; } }
    function start(kind) {
      stop();
      if (!AudioCtx) return;
      try { ctx = ctx || new AudioCtx(); } catch { return; }
      const play = () => (kind === 'in' ? tone([440, 480], 1000) : tone([425], 1000));
      play();
      tm = T.setInterval(play, kind === 'in' ? 3000 : 4000);
    }
    return { start, stop, get playing() { return !!tm; } };
  }

  // ---- Panggilan grup, Step 3b: pilihan orang yang bisa diundang ----
  const CALL_MAX_PEERS = 8; // harus sama dengan batas di Core
  // Calon yang bisa diundang: online, terenkripsi, tidak diblokir, belum ada di panggilan / belum diundang.
  // Urutan: teman dulu, lalu user lain; masing-masing menurut nama. `peers`: [{ id, name, online, secure, fst, friend }].
  function inviteCandidates(peers, v, blocked) {
    const have = new Set();
    for (const x of (v && v.legs) || []) if (x && x.peer) have.add(x.peer);
    for (const x of (v && v.invites) || []) if (x && x.peer) have.add(x.peer);
    for (const x of (v && v.members) || []) if (x && x.id) have.add(x.id);
    const blk = blocked instanceof Set ? blocked : new Set(blocked || []);
    const isFriend = (p) => (p.fst || (p.friend ? 'ok' : '')) === 'ok';
    return (Array.isArray(peers) ? peers : []).filter((p) => p && p.id && p.online && p.secure && !blk.has(p.id) && !have.has(p.id))
      .map((p) => ({ id: p.id, name: p.name || '?', friend: isFriend(p) }))
      .sort((a, b) => (b.friend - a.friend) || String(a.name).localeCompare(String(b.name)));
  }
  // Jumlah peserta yang sudah terhitung (aku + kaki + undangan menunggu), untuk menandai ruang penuh.
  function roomCount(v) {
    const ids = new Set();
    for (const x of (v && v.legs) || []) if (x && x.peer) ids.add(x.peer);
    for (const x of (v && v.invites) || []) if (x && x.peer) ids.add(x.peer);
    return ids.size + 1;
  }
  function inviteFailText(info) {
    const p = { name: (info && info.name) || ct('cl.nameFb', 'Dia') };
    switch (info && info.reason) {
      case 'declined': return ct('cl.inv.declined', '{name} menolak undangan', p);
      case 'busy': return ct('cl.inv.busy', '{name} sedang dalam panggilan lain', p);
      case 'noanswer': return ct('cl.inv.noanswer', '{name} tidak menjawab undangan', p);
      case 'unreachable': return ct('cl.inv.unreachable', '{name} tidak terjangkau. Dia sedang offline?', p);
      case 'refused': return ct('cl.inv.refused', 'Undangan untuk {name} tidak bisa diteruskan. Coba lagi sebentar lagi.', p);
      default: return ct('cl.inv.failed', 'Undangan untuk {name} gagal', p);
    }
  }
  // Pemberitahuan saat satu peserta lepas dari panggilan yang masih berjalan (4b). Kosong = tidak perlu diberitahukan.
  // 'error' dilaporkan sendiri oleh pemanggil addLeg, jadi tidak diulang di sini.
  function legText(info) {
    if (!info || info.reason === 'error' || info.vc) return ''; // channel: orang datang-pergi itu biasa, daftar peserta sudah menunjukkannya
    const p = { name: info.name || ct('cl.nameFbLeg', 'Seorang peserta') };
    switch (info.reason) {
      case 'failed': return info.failed ? ct('cl.leg.failed', '{name} gagal tersambung', p) : ct('cl.leg.lost', 'Koneksi dengan {name} terputus', p);
      case 'rejected': return ct('cl.leg.rejected', '{name} menolak bergabung', p);
      case 'busy': return ct('cl.inv.busy', '{name} sedang dalam panggilan lain', p);
      case 'noanswer': return ct('cl.leg.noanswer', '{name} tidak menjawab', p);
      default: return ct('cl.leg.left', '{name} keluar dari panggilan', p);
    }
  }
  // Lembar pilihan (bagian bawah layar). `list`: hasil inviteCandidates.
  function pickerHtml(list, h) {
    const rows = list.map((x) => `<li><button type="button" class="cpr" data-cinv="${h.esc(x.id)}" data-cname="${h.esc(x.name)}"><span class="cpa">${h.avatar(x.id)}</span><span class="cpn">${h.esc(x.name)}</span><span class="cps">${x.friend ? ct('cl.pick.friend', '⭐ Teman') : ct('peer.online', 'Online')}</span></button></li>`).join('');
    const add = ct('cl.add', 'Tambah orang');
    return `<div class="cpk"><div class="cps2" role="dialog" aria-label="${add}"><div class="cpt"><span>${add}</span><button type="button" class="cpx" data-cact="addclose" aria-label="${ct('common.close', 'Tutup')}">✕</button></div>`
      + (list.length ? `<ul class="cpl cpick">${rows}</ul>` : `<div class="cin">${ct('cl.pick.none', 'Tidak ada orang online lain yang bisa diundang.')}</div>`) + '</div></div>';
  }

  // Lencana status peserta (4c-3): deafen = headphone dicoret saja (sudah mencakup mute); mute = mik dicoret. Kosong kalau tidak ada status.
  // Hanya untuk peserta yang sudah tersambung; status kaki yang belum aktif tidak ditampilkan.
  function stateBadge(x, h) {
    if (!x || x.state !== 'active') return '';
    const ic = h.icons || {};
    if (x.deafened) return `<span class="cbd deaf" role="img" aria-label="${ct('cl.deaf', 'Deafen')}" title="${ct('cl.badge.deaf', 'Tidak mendengar (deafen)')}">${ic.headOff || ''}</span>`;
    if (x.muted) return `<span class="cbd mute" role="img" aria-label="${ct('cl.micOff', 'Mik dimatikan')}" title="${ct('cl.micOff', 'Mik dimatikan')}">${ic.micOff || ''}</span>`;
    return '';
  }

  // Layar panggilan boleh dikecilkan (seperti WhatsApp) selama bukan sedang berdering: dering masuk harus dijawab / ditolak dulu.
  // Tampilan video (kartu) bila ruang ini video, atau ada lawan yang mengirim video (aku bisa tanpa kamera tapi tetap melihat mereka). Bukan channel, bukan layar undangan.
  // Channel (langkah 4): kartu video hanya untuk yang kameranya HIDUP (kaki aktif dengan cam === true, dan aku bila kameraku hidup); maksimal 4 (batas Core).
  // Kunci kartu: id peserta, 'me' untuk aku (terakhir). Yang tidak menyalakan kamera hanya muncul di daftar peserta.
  const chanCams = (v) => {
    if (!v || !v.vc || v.invite || v.phase === 'ringing') return [];
    const k = (Array.isArray(v.legs) ? v.legs : []).filter((x) => x && x.peer && x.cam === true && x.state === 'active').map((x) => x.peer);
    if (v.video && v.camOff === false) k.push('me');
    return k;
  };
  // 1-1 / grup (fitur kamera DM): kamera bisa dinyalakan kapan saja, jadi tampilan video hanya selama ada kamera yang hidup (kameraku, atau lawan yang mengabarkan cam;
  // tanpa kabar kamera, jatuh ke ada-tidaknya aliran video lawan, untuk peer lama). Semua kamera mati = kembali ke layar suara.
  const legCam = (x) => !!x && (typeof x.cam === 'boolean' ? x.cam : !!x.video);
  const videoView = (v) => !!v && !v.invite && (v.vc ? chanCams(v).length > 0 : ((!!v.video && !v.camOff) || (Array.isArray(v.legs) && v.legs.some(legCam))));
  const canMinimize = (v) => !!v && v.phase !== 'ringing' && !v.invite;
  // Bar kecil di atas aplikasi: nama, durasi (id calltime, ikut diperbarui timer), mik, dan akhiri. Ketuk bar = kembali ke layar penuh.
  function miniHtml(v, h) {
    const ic = h.icons || {};
    const legs = Array.isArray(v.legs) ? v.legs.filter((x) => x && x.peer) : [], invs = Array.isArray(v.invites) ? v.invites.filter((x) => x && x.peer) : [];
    const name = v.vc ? (v.vc.name || 'Channel') : (legs.length > 1 || invs.length > 0) ? ct('cl.group', 'Panggilan grup') : (v.name || '?');
    const status = v.phase === 'dialing' ? ct('cl.st.dialing', 'Memanggil…') : v.phase === 'connecting' ? ct('cl.st.connecting', 'Menyambungkan…') : fmtDur(v.since ? (Date.now() - v.since) / 1000 : 0);
    const mt = v.muted ? ct('cl.muteOnHint', 'Suara mati. Ketuk untuk menyalakan') : ct('cl.mute', 'Bisukan');
    const hl = v.vc ? ct('vc.leave', 'Keluar') : v.phase === 'dialing' ? ct('common.cancel', 'Batal') : ct('cl.hang', 'Akhiri');
    return `<div class="cmb" data-cact="max" role="button" tabindex="0" aria-label="${ct('cl.back', 'Kembali ke layar panggilan')}" title="${ct('cl.backHint', 'Ketuk untuk kembali ke layar panggilan')}"><span class="cmi">${(v.vc ? ic.speaker : ic.phone) || ''}</span><span class="cmn">${h.esc(name)}</span><span class="cmt" id="calltime" data-phase="${v.phase}">${status}</span></div>`
      + `<button type="button" class="cmx tog${v.muted ? ' on' : ''}" data-cact="mute" aria-label="${mt}" title="${mt}">${(v.muted ? ic.micOff : ic.mic) || ''}</button>`
      + `<button type="button" class="cmx hang" data-cact="hang" aria-label="${hl}" title="${hl}">${ic.phone || ''}</button>`;
  }
  // HTML layar panggilan. `h`: { esc(s), avatar(peerId) -> html, icons: { phone, mic, micOff, chev }, speaker: bool, speakerOn: bool, minimized: bool }
  function overlayHtml(v, h) {
    if (!v) return '';
    if (!canMinimize(v)) return overlayBody(v, h);
    if (h && h.minimized) return miniHtml(v, h);
    const ic = h.icons || {};
    return `<button type="button" class="cmin" data-cact="min" aria-label="${ct('cl.min', 'Kecilkan panggilan')}" title="${ct('cl.minHint', 'Kecilkan panggilan, supaya bisa membuka chat')}">${ic.chev || '⌄'}</button>` + overlayBody(v, h);
  }
  function overlayBody(v, h) {
    if (!v) return '';
    const status = v.phase === 'ringing' ? (v.video ? ct('cl.st.inVideo', 'Panggilan video masuk') : ct('cl.st.inVoice', 'Panggilan suara masuk')) : v.phase === 'dialing' ? ct('cl.st.dialing', 'Memanggil…') : v.phase === 'connecting' ? ct('cl.st.connecting', 'Menyambungkan…') : fmtDur(v.since ? (Date.now() - v.since) / 1000 : 0);
    const btn = (act, cls, label, icon, on) => `<div class="cbw"><button type="button" class="cbtn ${cls}${on ? ' on' : ''}" data-cact="${act}" aria-label="${label}" title="${label}">${icon}</button><span>${label}</span></div>`;
    // Tombol kamera (dan balik kamera bila perangkat punya lebih dari satu): selalu ada selama panggilan tersambung, kamera mati sampai dinyalakan (juga di 1-1 dan grup).
    // Tombol menyala = kamera hidup. Panggilan video yang masih menyambung / memanggil juga punya tombolnya (matikan kamera sebelum dijawab).
    const cam = !v.invite && (v.phase === 'active' || (!v.vc && v.video && v.phase !== 'ringing'));
    const camLabel = v.camOff ? (v.vc && v.camMax && v.camCount >= v.camMax ? ct('cl.cam.full', 'Kamera penuh') : v.vc && v.camCount > 0 ? ct('cl.cam.count', 'Kamera {n}/{max}', { n: v.camCount, max: v.camMax || 4 }) : ct('camera.title', 'Kamera')) : ct('cl.cam.on', 'Kamera hidup');
    // Peredam bising: satu tombol sejajar tombol lain. Setiap ketukan pindah ke mode berikutnya (Mati -> Standar -> Kuat -> Mati).
    // data-cnoise berisi mode BERIKUTNYA (diteruskan ke setNoise oleh archne-index.html); data-nz = mode sekarang. Hanya setelah mikrofon dipakai.
    const nz = normNoise(v.noise) || NOISE_DEFAULT;
    const NL = { off: ct('cl.nz.off', 'Mati'), standard: ct('cl.nz.standard', 'Standar'), strong: ct('cl.nz.strong', 'Kuat') };
    const nzNext = NOISE_MODES[(NOISE_MODES.indexOf(nz) + 1) % NOISE_MODES.length], nzLabel = ct('cl.nz.label', 'Bising: {mode}', { mode: NL[nz] });
    const nzAria = ct('cl.nz.aria', 'Peredam bising: {cur}. Ketuk untuk ganti ke {next}', { cur: NL[nz], next: NL[nzNext] }), nzTitle = ct('cl.nz.title', 'Peredam bising: {cur} (ketuk untuk ganti)', { cur: NL[nz] });
    const nzBtn = v.phase === 'connecting' || v.phase === 'active'
      ? `<div class="cbw"><button type="button" class="cbtn tog nz-${nz}${nz === 'strong' ? ' on' : ''}" data-cnoise="${nzNext}" data-nz="${nz}" aria-label="${nzAria}" title="${nzTitle}">${nz === 'off' ? (h.icons.noiseOff || '') : (h.icons.noise || '')}</button><span>${nzLabel}</span></div>`
      : '';
    const tog = v.phase === 'ringing' ? '' : btn('mute', 'tog', v.muted ? ct('cl.muted', 'Suara mati') : ct('cl.mute', 'Bisukan'), v.muted ? h.icons.micOff : h.icons.mic, v.muted)
      + (cam ? btn('cam', 'tog', camLabel, v.camOff ? (h.icons.videoOff || '') : (h.icons.video || ''), !v.camOff) + (h.flip && !v.camOff ? btn('flip', 'tog', ct('camera.flip', 'Balik kamera'), h.icons.flip || '', false) : '') : '')
      + btn('deafen', 'tog', v.deafened ? ct('cl.deafOn', 'Deafen aktif') : ct('cl.deaf', 'Deafen'), v.deafened ? (h.icons.headOff || '') : (h.icons.head || ''), !!v.deafened)
      + nzBtn
      + (h.speaker ? btn('speaker', 'tog', 'Speaker', h.icons.speaker || '', h.speakerOn === undefined ? v.speaker : h.speakerOn) : '')
      + (v.phase === 'active' && !v.invite && !v.vc && h.canAdd !== false ? btn('add', 'tog', ct('cl.add', 'Tambah orang'), h.icons.add || '', false) : '');
    const main = v.canAccept ? btn('reject', 'red hang', ct('profile.decline', 'Tolak'), h.icons.phone) + btn('accept', 'acc', ct('dlg.accept', 'Terima'), h.icons.phone)
      : btn('hang', 'red hang', v.vc ? ct('vc.leave', 'Keluar') : v.phase === 'dialing' ? ct('common.cancel', 'Batal') : ct('cl.hang', 'Akhiri'), h.icons.phone);
    const ns = ''; // peredam bising sekarang tombol di barisan tombol (nzBtn)
    // Grup: lebih dari satu kaki, ada undangan keluar yang menunggu, atau layar undangan masuk. 1-1 tetap seperti semula.
    const legs = Array.isArray(v.legs) ? v.legs.filter((x) => x && x.peer) : [];
    const invs = Array.isArray(v.invites) ? v.invites.filter((x) => x && x.peer) : [];
    const mem = Array.isArray(v.members) ? v.members.filter((x) => x && x.name) : [];
    const group = !v.invite && (legs.length > 1 || invs.length > 0);
    const pk = Array.isArray(h.picker) && v.phase === 'active' && !v.invite ? pickerHtml(h.picker, h) : ''; // h.picker: daftar calon dari inviteCandidates; kosong = tidak terbuka
    // Video (tahap 3 dan 4): kartu per peserta. Jumlah kartu n (termasuk kamu, maks 8) menentukan grid lewat data-n, tanpa gulir: 2 = berdampingan (laptop) / atas-bawah (HP); 3-4 = 2x2; 5-6 = 3x2 (laptop) / 2x3 (HP); 7-8 = 4x2 (laptop) / 2x4 (HP). Kamu terakhir.
    // <video> tidak dibuat di sini (HTML string dirender ulang tiap perubahan dan akan memutus videonya): archne-index.html menempelkan elemen video
    // yang menetap ke kartu bertanda data-vkey (lihat mountVideos).
    if (videoView(v) && !v.vc && v.phase !== 'ringing') {
      // Perbesar (tahap 5): ketuk kartu = satu kartu penuh (h.focus = kunci kartu); tombol kecil di pojok kembali ke grid. Kartu lain tetap ada
      // di HTML (disembunyikan CSS) supaya elemen videonya tidak dicopot. Kunci yang sudah tidak ada (peserta keluar) diabaikan.
      const keys = group ? [...legs.map((x) => x.peer), ...invs.filter((x) => !legs.some((l) => l.peer === x.peer)).map((x) => x.peer)] : [v.peer];
      keys.push('me');
      const fk = h.focus && keys.includes(h.focus) ? h.focus : '';
      const tile = (key, name, who, me, wait, badge, off) => `<div class="cvt${me ? ' me' : ''}${off ? ' camoff' : ''}${wait ? ' wait' : ''}${fk === key ? ' big' : ''}" data-vkey="${h.esc(key)}" data-cact="focus" data-vfocus="${h.esc(key)}" role="button" tabindex="0" aria-label="${ct('cl.vid.zoom', 'Perbesar video {name}', { name: h.esc(name) })}"><span class="cva">${h.avatar(who)}</span><span class="cvn">${h.esc(name)}${badge || ''}</span>${wait ? `<span class="cvs">${wait}</span>` : ''}${fk === key ? `<button type="button" class="cvx" data-cact="unfocus" aria-label="${ct('cl.vid.grid', 'Kembali ke grid')}" title="${ct('cl.vid.grid', 'Kembali ke grid')}">${(h.icons && h.icons.shrink) || '⤡'}</button>` : ''}</div>`;
      const first = legs.find((x) => x.peer === v.peer) || legs[0], vob = group ? '' : stateBadge(first, h);
      const noCam = (x) => !!x && x.state === 'active' && !legCam(x); // lawan yang kameranya mati: avatar + keterangan, bukan bingkai hitam
      const others = group
        ? legs.map((x) => tile(x.peer, x.name || '?', x.peer, false, x.state !== 'active' ? ct('wan.stConnecting', 'Menyambung…') : noCam(x) ? ct('cl.vid.camOff', 'Kamera mati') : '', stateBadge(x, h), noCam(x))).join('')
          + invs.filter((x) => !legs.some((l) => l.peer === x.peer)).map((x) => tile(x.peer, x.name || '?', x.peer, false, ct('cl.st.inviting', 'Mengundang…'), '')).join('')
        : tile(v.peer, v.name || '?', v.peer, false, noCam(first) ? ct('cl.vid.camOff', 'Kamera mati') : '', '', noCam(first));
      return `<div class="cvh"><span class="cnm">${h.esc(group ? ct('cl.group', 'Panggilan grup') : (v.name || '?'))}</span><span class="cst" id="calltime" data-phase="${v.phase}">${status}</span></div>`
        + `<div class="cvg${group ? ' grid' : ''}${fk ? ' focus' : ''}" data-n="${Math.min(keys.length, CALL_MAX_PEERS)}" role="group" aria-label="${ct('cl.vid.aria', 'Video')}">${others}${tile('me', ct('chat.you', 'Kamu'), h.meId || '', true, v.camOff ? ct('cl.vid.camOff', 'Kamera mati') : '', '', !!v.camOff)}</div>`
        + `${vob ? `<div class="cob">${vob}<span>${first.deafened ? ct('cl.deafShort', 'Tidak mendengar') : ct('cl.micOff', 'Mik dimatikan')}</span></div>` : ''}<div class="cbtns">${tog}${main}</div>${ns}${pk}`;
    }
    if (v.vc) {
      // Channel: aku di urutan pertama, lalu yang sudah punya kaki, lalu yang hadir (kata Core) tapi belum tersambung. h.here = [{ id, name, me }].
      const LS = { active: ct('wan.connected', 'Tersambung'), connecting: ct('wan.stConnecting', 'Menyambung…'), dialing: ct('wan.stConnecting', 'Menyambung…'), ringing: ct('wan.stConnecting', 'Menyambung…') };
      const row = (peer, name, st, cls, badge) => `<li class="${cls}" data-peer="${h.esc(peer)}"><span class="cpa">${h.avatar(peer)}</span><span class="cpn">${h.esc(name || '?')}</span>${badge || ''}<span class="cps">${st}</span></li>`;
      const have = new Set(legs.map((x) => x.peer)), here = (Array.isArray(h.here) ? h.here : []).filter((x) => x && x.id && !x.me && !have.has(x.id));
      const mine = row(h.meId || '', ct('chat.you', 'Kamu'), '', 'ok', stateBadge({ state: 'active', muted: v.muted, deafened: v.deafened }, h));
      const rows = mine + legs.map((x) => row(x.peer, x.name, LS[x.state] || ct('wan.stConnecting', 'Menyambung…'), x.state === 'active' ? 'ok' : 'wait', stateBadge(x, h))).join('')
        + here.map((x) => row(x.id, x.name, ct('wan.stConnecting', 'Menyambung…'), 'wait')).join('');
      const others = legs.length + here.length;
      // Ada yang menyalakan kamera: kartu video di atas (hanya yang kameranya hidup, grid sama seperti panggilan grup), daftar peserta suara di bawah
      // (daftarnya yang digulir bila panjang), tombol tetap di bawah. <video> ditempelkan archne-index.html lewat mountVideos seperti panggilan video.
      const ck = chanCams(v);
      if (ck.length) {
        const fk = h.focus && ck.includes(h.focus) ? h.focus : '';
        const ctile = (key, name, who, me, badge) => `<div class="cvt${me ? ' me' : ''}${fk === key ? ' big' : ''}" data-vkey="${h.esc(key)}" data-cact="focus" data-vfocus="${h.esc(key)}" role="button" tabindex="0" aria-label="${ct('cl.vid.zoom', 'Perbesar video {name}', { name: h.esc(name) })}"><span class="cvp">${h.avatar(who)}</span><span class="cva">${h.avatar(who)}</span><span class="cvn">${h.esc(name)}${badge || ''}</span>${fk === key ? `<button type="button" class="cvx" data-cact="unfocus" aria-label="${ct('cl.vid.grid', 'Kembali ke grid')}" title="${ct('cl.vid.grid', 'Kembali ke grid')}">${(h.icons && h.icons.shrink) || '⤡'}</button>` : ''}</div>`;
        const tiles = legs.filter((x) => x.cam === true && x.state === 'active').map((x) => ctile(x.peer, x.name || '?', x.peer, false, stateBadge(x, h))).join('')
          + (ck.includes('me') ? ctile('me', ct('chat.you', 'Kamu'), h.meId || '', true, '') : '');
        // Daftar peserta di bawah kartu dihapus (tidak penting): siapa yang ada cukup dari kartu + jumlah orang di header; foto profil ada di pojok kiri atas tiap kartu.
        return `<div class="cvh"><span class="cnm">${h.esc(v.vc.name || 'Channel')}</span><span class="cst" id="calltime" data-phase="${v.phase}">${status}</span><span class="cst cvk">${tnc('cl.vc.people', others + 1, 'Channel suara · {count} orang')}</span></div>`
          + `<div class="cvg chv${fk ? ' focus' : ''}" data-n="${ck.length}" role="group" aria-label="${ct('cl.vid.aria', 'Video')}">${tiles}</div>`
          + `<div class="cbtns">${tog}${main}</div>${ns}`;
      }
      return `<div class="cnm">${h.esc(v.vc.name || 'Channel')}</div><div class="cst" id="calltime" data-phase="${v.phase}">${status}</div><div class="cin">${others ? tnc('cl.vc.people', others + 1, 'Channel suara · {count} orang') : ct('cl.vc.waiting', 'Channel suara · menunggu orang lain masuk')}</div><ul class="cpl" aria-label="${ct('cl.people', 'Peserta')}">${rows}</ul><div class="cbtns">${tog}${main}</div>${ns}`;
    }
    if (v.invite) {
      const others = mem.filter((x) => x.id !== v.peer).map((x) => h.esc(x.name)).join(', '); // members memuat si pengundang; dia sudah jadi judul
      const info = `<div class="cin">${others ? ct('cl.inv.with', 'Di panggilan: {names}', { names: others }) : ct('cl.inv.none', 'Belum ada peserta lain')}</div>`;
      return `<div class="cav" data-peer="${h.esc(v.peer || '')}">${h.avatar(v.peer)}</div><div class="cnm">${h.esc(v.name || '?')}</div><div class="cst" id="calltime" data-phase="${v.phase}">${ct('cl.inv.you', 'mengundangmu ke panggilan grup')}</div>${info}<div class="cbtns">${tog}${main}</div>`;
    }
    if (group) {
      const LS = { active: ct('wan.connected', 'Tersambung'), connecting: ct('wan.stConnecting', 'Menyambung…'), dialing: ct('wan.stConnecting', 'Menyambung…'), ringing: ct('wan.stConnecting', 'Menyambung…') };
      const row = (peer, name, st, cls, badge) => `<li class="${cls}" data-peer="${h.esc(peer)}"><span class="cpa">${h.avatar(peer)}</span><span class="cpn">${h.esc(name || '?')}</span>${badge || ''}<span class="cps">${st}</span></li>`;
      const rows = legs.map((x) => row(x.peer, x.name, LS[x.state] || ct('wan.stConnecting', 'Menyambung…'), x.state === 'active' ? 'ok' : 'wait', stateBadge(x, h))).join('')
        + invs.filter((x) => !legs.some((l) => l.peer === x.peer)).map((x) => row(x.peer, x.name, ct('cl.st.inviting', 'Mengundang…'), 'inv')).join('');
      return `<div class="cnm">${ct('cl.group', 'Panggilan grup')}</div><div class="cst" id="calltime" data-phase="${v.phase}">${status}</div><ul class="cpl" aria-label="${ct('cl.people', 'Peserta')}">${rows}</ul><div class="cbtns">${tog}${main}</div>${ns}${pk}`;
    }
    const one = legs.find((x) => x.peer === v.peer) || legs[0]; // 1-1: lawan bicara satu-satunya
    const ob = stateBadge(one, h);
    return `<div class="cav" data-peer="${h.esc(v.peer || '')}">${h.avatar(v.peer)}</div><div class="cnm">${h.esc(v.name || '?')}</div><div class="cst" id="calltime" data-phase="${v.phase}">${status}</div>${ob ? `<div class="cob">${ob}<span>${one.deafened ? ct('cl.deafShort', 'Tidak mendengar') : ct('cl.micOff', 'Mik dimatikan')}</span></div>` : ''}<div class="cbtns">${tog}${main}</div>${ns}${pk}`;
  }

  return { Controller, NoiseGate, NOISE_MODES, NOISE_DEFAULT, audioConstraints, videoConstraints, sdpHasVideo, sdpVideoKind, fmtDur, durHuman, callLabel, callMembers, endText, supported, browserRtc, nativeBridge, makeNative, makeRinger, pickPip, levelMeter, PIP_DWELL_MS, overlayHtml, canMinimize, videoView, inviteCandidates, inviteFailText, legText, roomCount, CALL_MAX_PEERS, DISCONNECT_GRACE_MS, SYNC_GUARD_MS };
});
