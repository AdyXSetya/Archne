'use strict';
// Dimuat otomatis oleh test/run-all.js (-r). Mengisolasi tes ke loopback:
// Core tes TIDAK boleh menyambung ke alamat LAN pribadi mesin ini. Di mesin dengan jaringan nyata (mis. 192.168.x.x), petunjuk alamat
// dari peer (pertukaran alamat) lolos filter produk dan Core tes bisa menyambung satu sama lain lewat TCP LAN, atau ke Archne asli yang
// sedang terbuka di port tetap 41235, sehingga hitungan tes (koneksi TCP, sinyal tersimpan, state kurir) tercemar. Sandbox Linux tanpa
// alamat LAN tidak pernah mengalaminya. Tes yang memasang opts.hintOk sendiri tetap dihormati.
const { Core } = require('../src/archne-core');
const orig = Core.prototype._hintOk;
// addr.js menguji _hintOk yang ASLI (aturan jaringan pribadi/VPN), jadi tidak diisolasi.
const self = require('path').basename(process.argv[1] || '');
if (typeof orig === 'function' && self !== 'addr.js') {
  Core.prototype._hintOk = function (ip, port) {
    if (this.opts && this.opts.hintOk) return !!this.opts.hintOk(ip, port);
    return ip === '127.0.0.1';
  };
}
