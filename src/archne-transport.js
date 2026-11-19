'use strict';
// Lapisan transport (mode lintas jaringan, langkah 1).
//
// Core bicara dengan peer lewat "soket": satu koneksi = satu permintaan (baris JSON) dan satu balasan, atau aliran berkas (file_get/file_put).
// Peer di LAN dialamatkan lewat ip:port dan memakai TCP (net). Peer lintas jaringan dialamatkan lewat ID dengan alamat "rtc:<id>" di kolom
// `ip`, dan koneksinya dibuka oleh sebuah transport yang dipasang dari luar (Core.attachTransport), mis. DataChannel WebRTC di langkah 3-4.
//
// Kontrak transport:
//   connect(peer) -> soket-like atau null         // peer.ip = "rtc:<id>". Null = tidak bisa dibuka sekarang (Core menganggapnya gagal).
//   onIncoming    = (soket-like, remoteId) => void // diisi Core saat attachTransport; transport memanggilnya untuk koneksi masuk.
//   close()       (opsional)                       // dipanggil Core.stop()
//
// Kontrak soket-like (subset net.Socket yang dipakai Core dan Xfer): stream Duplex dengan
//   event 'connect' (dipancarkan setelah connect(); Core menunggunya sebelum menulis), 'data', 'end', 'close', 'error',
//   metode write/end/destroy/pause/resume/unshift/setEncoding/setTimeout(ms, cb)/once/on/removeListener/removeAllListeners,
//   properti destroyed. setTimeout adalah batas diam (idle) seperti net.Socket.
// remoteId koneksi masuk harus sudah terotentikasi oleh transport (mis. dari pasangan kunci saat menyambung); Core menolak hello yang
// mengaku ID lain dari alamat rtc: asalnya.

const RTC_PREFIX = 'rtc:';
const HEX16 = /^[0-9a-f]{16}$/;

const isRtcAddr = (ip) => typeof ip === 'string' && ip.startsWith(RTC_PREFIX);
const rtcAddr = (id) => RTC_PREFIX + id;
const rtcId = (ip) => (isRtcAddr(ip) ? ip.slice(RTC_PREFIX.length) : null);
const validRtcAddr = (ip) => isRtcAddr(ip) && HEX16.test(ip.slice(RTC_PREFIX.length));

module.exports = { RTC_PREFIX, isRtcAddr, rtcAddr, rtcId, validRtcAddr };
