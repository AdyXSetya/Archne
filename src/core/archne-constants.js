'use strict';
// src/core/archne-constants.js — semua konstanta batas/kuota/tag protokol (pindahan apa adanya dari src/archne-core.js, Step 1)
const crypto = require('crypto');

const DISCOVERY_PORT = 41234;
// Port TCP tetap (v0.9.3): alamat peer cukup IP. Kalau sudah dipakai (mis. dua Archne di satu PC) jatuh ke port acak dan alamatnya tampil di UI.
const DEFAULT_TCP_PORT = 41235;
const PX_MS = 30000, PX_MAX = 50, PX_PROBE = 8; // pertukaran alamat peer: tiap 30 dtk, maks 50 alamat per jawaban, maks 8 yang dicoba sekali jalan
const ONLINE_MS = 12000;
// HLC: ts pesan = milidetik, selalu lebih besar dari semua ts yang pernah dikirim/dilihat (urutan sebab-akibat tahan jam PC yang meleset).
const HLC_DRIFT = 10 * 60e3; // ts dari peer lain yang lebih maju dari ini tidak dipakai untuk memajukan jam kita
const SYNC_MS = 8000, SYNC_RETRY_MS = 4000; // sinkronisasi berkala per peer (8 dtk: kabar kurir/pemegang berkas terasa realtime); jitter ±20% supaya tidak serempak
// Kurir: batas titipan pesan orang lain supaya perangkat tidak penuh.
const CUSTODY_TTL = 14 * 864e5, RCPT_MAX = 5000;
// Titipan kurir dibagi dua kelas dengan kuota SENDIRI-SENDIRI, supaya banjir pesan tidak bisa menggusur state inti:
//   state = undangan/pembaruan grup (`ginv`: anggota, admin, pemilik, kunci epoch, dikeluarkan). Dipegang sampai ada tanda terima, batas atas 180 hari
//           (anggota yang lama offline tetap tahu kunci dan status keanggotaannya). Kuota lebih besar; penuh = yang dibuang dari pengirim yang paling banyak menitip (adil, bukan yang terlama).
//   pesan = DM (`e1`): kuota dan TTL pendek seperti sebelumnya.
const STATE_MAX = 5000, STATE_PER_SENDER = 1000, STATE_TTL = 180 * 864e5, RCPT_TTL = 180 * 864e5;
// v0.22.0: kelas state = PRIMER (mutlak, ditanggung semua peer): `ginv` + pesan kontrol grup/DM yang bertanda `pc:1` (sematan, channel suara, batal kirim, kontrol teman).
// `pc` ikut ditandatangani pengirim (lihat canon) supaya kurir non-anggota yang tidak bisa membuka isinya tetap tahu ini primer dan tidak menggusurnya dengan obrolan.
const PRIM_CTL = ['\u0001pin:', '\u0001vch:', '\u0001del:', '\u0001frq', '\u0001fac', '\u0001fdl']; // awalan teks kontrol (harus sama dengan Pins.CTL, Vc.CTL, DEL, FTEXT; DEL didefinisikan di bawah, jadi ditulis ulang; dijaga test/primary.js)
const isPrimText = (t) => typeof t === 'string' && PRIM_CTL.some((p) => t.startsWith(p));
const isStateMsg = (m) => m.kind === 'ginv' || m.pc === 1;
//   pesan grup (`g1`) = kelas ketiga, dibawa NON-ANGGOTA sebagai ciphertext tertutup (kunci epoch hanya milik anggota). Kategori pesan seperti DM:
//           kuota sendiri (total, per grup, per pengirim, dan total byte), TTL 14 hari, dan paling akhir dilayani sync. Tidak pernah menyentuh kuota state.
const GMSG_TTL = 14 * 864e5;
// v0.22.1 (Step 2b): titipan SUB (DM `e1` dan pesan grup `g1`) dibatasi BYTE, bukan jumlah. Ongkos sebuah titipan = byte teksnya + CUST_OVERHEAD
// (id, tanda tangan, kunci publik, nama, dan satu berkas segmen di disk), jadi jutaan pesan kosong tetap tidak lolos. Kelas state (primer) tetap berbasis jumlah dan tidak bisa diatur.
//   DM: kuota total; per pengirim = DM_SENDER_FRAC dari kuota. Pesan grup: kuota total; per grup = GMSG_GROUP_FRAC; per pengirim = GMSG_SENDER_FRAC.
//   Tanpa batas (Infinity): per pengirim tetap dibatasi UNLIM_SENDER supaya satu identitas tidak bisa memenuhi disk sendirian; per grup ikut tanpa batas.
// Default 500 MB per jenis (Step 2c: titipan sub di disk, RAM hanya metadata; lihat archne-custody-store.js).
const CUST_OVERHEAD = 700, CUST_DM_QUOTA = 500 * 1048576, CUST_GMSG_QUOTA = 500 * 1048576;
const DM_SENDER_FRAC = 0.1, GMSG_GROUP_FRAC = 0.2, GMSG_SENDER_FRAC = 0.04, UNLIM_SENDER = 2e9;
// v0.22.1 (Step 2d): pesan PUBLIK milik orang lain (riwayat obrolan publik yang kusimpan dan kulayani lewat sync) juga dibatasi byte, dengan ongkos custCost.
// Pesan publik tetap utuh di RAM dan di store.json (tidak lazy seperti titipan), jadi bawaannya jauh lebih kecil: 20 MB (~26 ribu pesan, ~18 MB RAM).
// Pesanku sendiri dan pesan kontrol batal-kirim tidak dihitung dan tidak pernah digusur. Per pengirim = PUBMSG_SENDER_FRAC dari kuota.
// Penuh: pengirim terbanyak kehilangan pesan terlamanya dulu (adil, bukan sekadar yang terlama); pesan masuk yang lebih tua dari semua yang bisa digusur ditolak.
const PUBMSG_QUOTA = 20 * 1048576, PUBMSG_SENDER_FRAC = 0.1;
const custCost = (m) => Buffer.byteLength(String((m && m.text) || '')) + CUST_OVERHEAD;
const GID_TO = /^g:[0-9a-f]{16}$/;
const custClass = (m) => (isStateMsg(m) ? 'state' : m.kind === 'g1' ? 'gmsg' : 'dm');
const custTtl = (m) => (isStateMsg(m) ? STATE_TTL : m.kind === 'g1' ? GMSG_TTL : CUSTODY_TTL);
const custRank = (m, rid) => (m.to === rid ? 0 : isStateMsg(m) ? 1 : m.kind === 'e1' ? 2 : 3); // untuk peminta, state, DM, pesan grup
const RTAG = 'archne-rcpt1:';
// Batas teks per pesan (karakter). Pesan terenkripsi berisi ciphertext base64: 10.000 karakter bisa sampai ~30 KB UTF-8, jadi ~40 KB base64.
const MAX_TEXT = 10000, MAX_CIPHER = 48000;
// Satu baris jaringan dibatasi 8 MB (lineReader). Jawaban sinkronisasi dibatasi per BYTE (bukan jumlah pesan) supaya tetap muat
// walau isinya emoji/huruf non-Latin. Sisa pesan terambil di putaran sinkronisasi berikutnya.
const LINE_MAX = 8e6, SYNC_PUB_BYTES = 2e6, SYNC_GRP_BYTES = 2e6, SYNC_CUS_BYTES = 1.5e6;
const HEX32 = /^[0-9a-f]{32}$/;
const AUTO_IMG_MAX = 8 * 1048576; // v0.25.0 Step 1: ukuran asli terbesar foto yang diunduh otomatis (lebih besar: tunggu diketuk)
const NOTIFY_MAX_AGE = 60 * 60 * 1000; // pesan yang lebih tua dari ini (sinkronisasi riwayat) tidak diberi notifikasi
// Pengunggahan berkas: batas serentak supaya satu peer tidak bisa menghabiskan soket/disk pengirim.
const UP_MAX = 6, UP_PER_IP = 3;
// Titipan BYTE berkas di kurir (v0.7.0 tahap 4a). Kolam DM; berkas publik dan grup punya kolam sendiri (di bawah).
const ESC_QUOTA = 500 * 1048576, ESC_PER_SENDER = 100 * 1048576, ESC_TTL = 7 * 864e5;
const RVTAG = 'archne-revoke1:'; // pencabutan titipan berkas oleh pengirim: RVTAG + id
const RV_MAX = 2000, RV_TTL = 8 * 864e5, ESC_REPLICAS = 2;
// Kolam kurir khusus berkas PUBLIK (terpisah dari kolam DM supaya kuota DM tidak bisa dipenuhi lewat chat publik). Berkas publik memang polos,
// jadi disimpan polos dan bisa dilayani ke siapa saja. Penuh -> yang paling lama tidak dipakai dibuang (LRU), bukan menolak yang baru.
const PUB_QUOTA = 500 * 1048576, PUB_PER_SENDER = 50 * 1048576, PUB_TTL = 3 * 864e5;
// Salinan seed: peer yang sudah mengunduh berkas publik/grup menyimpan bentuk terkemasnya dan ikut melayani peer lain (pengirim boleh offline).
const SEED_QUOTA = 500 * 1048576, SEED_TTL = 3 * 864e5;
// Kolam titipan berkas GRUP: byte tersegel (kunci epoch grup) dititipkan ke anggota grup yang online, termasuk yang belum menekan Terima.
// Terpisah dari kolam DM dan publik; aturannya sama dengan publik (LRU, 50 MB per berkas/pengirim, 3 hari).
const GRP_QUOTA = 500 * 1048576, GRP_PER_SENDER = 100 * 1048576, GRP_TTL = 3 * 864e5; // per pengirim 100 MB = batas atas titipan (ESC_MAX_CEIL), supaya satu berkas selebar batas atas masih muat
// Batas ukuran berkas yang boleh DITITIPKAN pengirim ke kurir (ukuran setelah kompres, psize). Bawaan 10 MB; pengguna boleh menaikkannya sampai 100 MB, TIDAK ADA opsi tanpa batas.
// 0 = titipan berkas dimatikan. Berkas yang lebih besar tidak dititipkan: hanya diambil langsung dari pengirim. Titipan juga hanya ke kurir yang jalurnya langsung/LAN (lihat archne-relay-policy.js).
const ESC_MAX_DEF = 10 * 1048576, ESC_MAX_CEIL = 100 * 1048576;
// 5a-2: batas stream video Halaman yang bisa diatur pengguna (kunci pgStreamMax = per Core, pgStreamPeer = per pemilik jauh): [minimum, bawaan, maksimum]. Tanpa 'unlimited': satu peer tidak boleh menguras jaringan.
const PG_VSTREAM_LIM = { pgStreamMax: [1, 3, 8], pgStreamPeer: [1, 2, 4] };
const FTAG = 'archne-frcpt1:'; // tanda terima BERKAS (bukan pesan): penerima sudah memegang byte berkasnya, kurir boleh membuang: FTAG + id + ':' + penerima
const PTAG = 'archne-put1:'; // tanda tangan pengirim untuk mendorong byte ke kurir: PTAG + id + ':' + psize + ':' + nonce
const PUT_MAX = 4, PUT_PER_IP = 2, NONCE_MAX = 64, NONCE_TTL = 30000;
// Profil (v0.7.3): deskripsi pendek tiap akun, ditandatangani pemiliknya dan tersinkron ke semua akun (juga lewat peer lain).
const PROF_MAX = 140, PROF_DEFAULT = 'Hallo...', PROF_KEEP = 1000, PFTAG = 'archne-prof1:';
// Foto profil (v0.7.4): JPEG kecil (base64) yang ikut dalam catatan profil bertanda tangan (format v2: PF2TAG + JSON [id, ts, bio, sha(foto)]).
// Dibatasi ukuran (AV_MAX karakter base64) dan dimensi (AV_DIM px) supaya sync dan penyimpanan tetap ringan dan dekoder gambar tidak diberi beban besar.
const AV_MAX = 14000, AV_DIM = 192, PF2TAG = 'archne-prof2:', SYNC_PROF_BYTES = 6e5;
// Pertemanan dua arah (v0.7.4): permintaan/persetujuan/pemutusan dikirim sebagai DM terenkripsi dengan teks kontrol (tidak bisa diketik pengguna,
// disaring CTRL di sendText), jadi privat, terkirim walau lawan offline (kurir), dan tidak tampil sebagai pesan.
const FTEXT = { frq: '\u0001frq', fac: '\u0001fac', fdl: '\u0001fdl' };
const FCTL = { [FTEXT.frq]: 'frq', [FTEXT.fac]: 'fac', [FTEXT.fdl]: 'fdl' };
// Keluar dari grup (v0.9.0): bukti keluar ditandatangani orang yang keluar sendiri (tidak bisa dipalsukan admin): LVTAG + gid + ':' + epoch + ':' + ts.
// Bukti ini ikut dalam pemberitahuan keluar (DM terenkripsi ke tiap anggota) dan dalam epoch pengeluaran yang dibuat admin/pemilik.
const LVTAG = 'archne-leave1:';
const LEAVE_DELAY = 300, LEAVE_STAGGER = 4000; // pemilik langsung mengeluarkan yang sudah keluar; admin menunggu giliran supaya tidak serempak
const FR_PENDING_MAX = 100, FR_KEEP = 1000;
const BIO_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const IN_MAX_AGE = 7 * 864e5; // sisa unduhan (.part/.pk) yang lebih tua dari ini disapu saat aplikasi dibuka
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// ep = nomor epoch kunci grup; hanya ikut ditandatangani bila ada (epoch 0 = format v0.2.0, tetap kompatibel).
const canon = (m) => {
  const a = [m.from, m.to, m.ts, m.text];
  if (m.kind) a.push(m.kind);
  if (m.ep !== undefined) a.push(m.ep);
  if (m.pc !== undefined) a.push('pc', m.pc); // v0.22.0: penanda primer; pesan lama tanpa pc tetap bertanda tangan sama
  return JSON.stringify(a);
};
const XTAG = 'archne-x1:';
const KINDS = [undefined, 'e1', 'ginv', 'g1', 'c1']; // c1 = sinyal panggilan: hanya lewat jalur langsung 'call', tidak pernah disimpan/dititipkan (_allowed menolaknya)
const HEX16 = /^[0-9a-f]{16}$/;
// Pesan kontrol "batal kirim": teks diawali karakter kontrol yang tidak bisa diketik pengguna (disaring di sendText).
const DEL = '\u0001del:';
const CTRL = /[\u0000-\u0008]/g;
// Panggilan suara (v0.13.0, lapisan sinyal): pesan bertanda tangan + terenkripsi (kind c1) yang dikirim LANGSUNG ke peer yang online lewat t:'call'.
// Tidak disimpan, tidak dititipkan ke kurir, tidak ikut sync. Orang yang kublokir dibuang diam-diam (ack tetap ok). Satu panggilan sekaligus.
// Tawaran berdering CALL_RING_MS lalu dianggap tak terjawab; SDP/ICE hanya dibawa, audionya ditangani WebRTC di UI.
const CALL_RING_MS = 45000, CALL_CONN_MS = 30000, CALL_NET_MS = 3000, CALL_SKEW = 120000;
// Tawaran SDP memuat bagian video yang tidak ditolak (m=video dengan port bukan 0)? Dipakai untuk menandai panggilan video di riwayat dan notifikasi.
// Catatan: jalur video kosong di tawaran channel (kamera bisa dinyalakan kapan saja, tanpa negosiasi ulang) bukan panggilan video; lihat _vidLeg.
// Kamera DM: panggilan 1-1 dan grup juga membawa jalur video kosong (kamera bisa dinyalakan kapan saja, seperti di channel). Jalur kosong itu bertanda
// a=msid:- (tanpa stream) di bagian videonya, jadi bukan panggilan video; panggilan video sungguhan membawa id stream asli di msid.
const sdpVideo = (sdp) => typeof sdp === 'string' && sdp.split(/^m=/m).slice(1).some((s) => /^video [1-9]\d* /.test(s) && !/^a=msid:-\s/m.test(s));
const CALL_SDP_MAX = 60000, CALL_ICE_MAX = 2000, CALL_ICE_N = 100, CALL_SEEN_MAX = 500;
const CALL_CAM_MAX = 4; // kamera hidup bersamaan di satu channel (mesh: tiap kamera dikirim ke semua peserta); yang lebih dulu menyala menang
const CALL_ST_N = 200; // batas pesan status (mute/deafen) yang diterima per kaki; mencegah banjir dari peer nakal
const VC_BEAT_MS = 20000, VC_TTL_MS = 70000; // presence channel voice: siaran ulang tiap 20 dtk, dianggap hilang kalau 70 dtk tak terdengar
const PV_BAD_MAX = 5, PV_BAD_MS = 5 * 60 * 1000; // PIN channel publik salah yang kuterima: maksimal 5 per orang per 5 menit, selebihnya diabaikan
const VC_TRY_MAX = 5; // percobaan menyambung kaki audio channel yang gagal beruntun per orang sebelum menunggu dia masuk ulang
const CALL_MAX_PEERS = 8; // batas peserta satu panggilan grup (termasuk diri sendiri); mesh, jadi tiap HP mengirim N-1 aliran
const CALL_T = new Set(['offer', 'answer', 'ice', 'end', 'reject', 'busy', 'invite', 'invdec', 'join', 'room', 'invcancel', 'st', 'vp', 'pp']), CALL_CID = /^[0-9a-f]{16}$/;
// Chromium/WebView menyamarkan IP LAN kandidat ICE jadi nama mDNS (xxxxxxxx-xxxx-....local). Lawan harus me-resolve lewat multicast,
// padahal banyak hotspot/router memblokirnya: panggilan macet di "Menghubungkan". Alamat pengirim sudah kita ketahui (kanal chat LAN),
// jadi nama itu diganti dengan IP-nya sebelum diteruskan ke UI. Tanpa IP yang dikenal, teks dibiarkan apa adanya.
const MDNS_NAME = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local\b/gi;
const unmask = (text, ip) => (typeof text === 'string' && typeof ip === 'string' && /^[0-9a-f.:]+$/i.test(ip) ? text.replace(MDNS_NAME, ip) : text);
// Riwayat panggilan (v0.14.0): tiap panggilan yang selesai dicatat di perangkat ini saja (tidak dikirim ke siapa pun), seperti tab Panggilan WhatsApp.
// Hasil: done (tersambung, ada durasi) | missed (masuk, tidak diangkat) | rejected | noanswer (keluar, tidak dijawab) | busy | cancelled (keluar, dibatalkan sebelum diangkat) | failed.
const CALL_OUT = new Set(['done', 'missed', 'rejected', 'noanswer', 'busy', 'cancelled', 'failed']), CALL_LOG_MAX = 300;
// Balas pesan (v0.9.1): referensi ke pesan asli ikut di dalam TEKS pesan (jadi ikut ditandatangani dan, untuk DM/grup, terenkripsi):
// REPLY + id pesan asli (32 hex) + REPLY + isi balasan. Karakter pemisah disaring dari ketikan (CTRL), jadi tidak bisa dipalsukan lewat teks biasa.
const REPLY = '\u0003re:';
const REPLY_RE = /^\u0003re:([0-9a-f]{32})\u0003/;
const REPLY_OVERHEAD = REPLY.length + 32 + 1;
const PREVIEW_MAX = 120;
// Anti-spam isi (v0.9.2), di sisi pengirim: teks yang sama ATAU sangat mirip dengan pesanmu sendiri di chat yang sama tidak dikirim.
// Kemiripan dihitung setelah normalisasi (huruf kecil, tanpa tanda baca/spasi/aksen, huruf berulang diringkas), jadi menambah "." atau
// mengubah satu-dua huruf tidak lolos. Pesan yang sudah dibatalkan tidak dihitung (memperbaiki salah ketik tetap bisa).
const SPAM_WINDOW = 10 * 60e3, SPAM_SHORT_WINDOW = 30e3, SPAM_SHORT_LEN = 12, SPAM_SIM = 0.85, SPAM_CMP_MAX = 3000;

module.exports = { DISCOVERY_PORT, DEFAULT_TCP_PORT, PX_MS, PX_MAX, PX_PROBE, ONLINE_MS, HLC_DRIFT, SYNC_MS, SYNC_RETRY_MS, CUSTODY_TTL, RCPT_MAX, STATE_MAX, STATE_PER_SENDER, STATE_TTL, RCPT_TTL, isStateMsg, PRIM_CTL, isPrimText, CUST_OVERHEAD, CUST_DM_QUOTA, CUST_GMSG_QUOTA, PUBMSG_QUOTA, PUBMSG_SENDER_FRAC, DM_SENDER_FRAC, GMSG_GROUP_FRAC, GMSG_SENDER_FRAC, UNLIM_SENDER, custCost, GMSG_TTL, GID_TO, custClass, custTtl, custRank, RTAG, MAX_TEXT, MAX_CIPHER, LINE_MAX, SYNC_PUB_BYTES, SYNC_GRP_BYTES, SYNC_CUS_BYTES, HEX32, AUTO_IMG_MAX, NOTIFY_MAX_AGE, UP_MAX, UP_PER_IP, ESC_QUOTA, ESC_PER_SENDER, ESC_TTL, RVTAG, RV_MAX, RV_TTL, ESC_REPLICAS, PUB_QUOTA, PUB_PER_SENDER, PUB_TTL, SEED_QUOTA, SEED_TTL, GRP_QUOTA, GRP_PER_SENDER, GRP_TTL, ESC_MAX_DEF, ESC_MAX_CEIL, PG_VSTREAM_LIM, FTAG, PTAG, PUT_MAX, PUT_PER_IP, NONCE_MAX, NONCE_TTL, PROF_MAX, PROF_DEFAULT, PROF_KEEP, PFTAG, AV_MAX, AV_DIM, PF2TAG, SYNC_PROF_BYTES, FTEXT, FCTL, LVTAG, LEAVE_DELAY, LEAVE_STAGGER, FR_PENDING_MAX, FR_KEEP, BIO_BAD, IN_MAX_AGE, sha, canon, XTAG, KINDS, HEX16, DEL, CTRL, CALL_RING_MS, CALL_CONN_MS, CALL_NET_MS, CALL_SKEW, sdpVideo, CALL_SDP_MAX, CALL_ICE_MAX, CALL_ICE_N, CALL_SEEN_MAX, CALL_CAM_MAX, CALL_ST_N, VC_BEAT_MS, VC_TTL_MS, PV_BAD_MAX, PV_BAD_MS, VC_TRY_MAX, CALL_MAX_PEERS, CALL_T, CALL_CID, MDNS_NAME, unmask, CALL_OUT, CALL_LOG_MAX, REPLY, REPLY_RE, REPLY_OVERHEAD, PREVIEW_MAX, SPAM_WINDOW, SPAM_SHORT_WINDOW, SPAM_SHORT_LEN, SPAM_SIM, SPAM_CMP_MAX };
