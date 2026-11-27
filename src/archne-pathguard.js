'use strict';
// Daftar path yang BOLEH dibaca proses utama atas permintaan renderer (hardening v1.0).
// Renderer tidak dipercaya: bila ia disusupi, ia tidak boleh menyuruh proses utama membaca/mengirim berkas sembarang (mis. ~/.ssh/id_rsa).
// Path hanya masuk daftar lewat tindakan pengguna yang diverifikasi proses utama:
//   - dialog pilih berkas/folder (diurus proses utama),
//   - hasil captureSave (berkas di dataDir/capture, dibuat proses utama),
//   - seret-lepas: preload memanggil webUtils.getPathForFile, yang hanya mau memberi path untuk objek File asli dari tindakan pengguna.
// Dipakai di Electron saja (opsional lewat deps.pathGuard); Android/headless tidak memakainya.
const path = require('path');

const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };

function createPathGuard({ max = 4000 } = {}) {
  const set = new Set(); // urutan sisip = urutan umur; yang tertua dibuang bila melebihi batas
  const grant = (p) => {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.indexOf('\0') >= 0 || !path.isAbsolute(p)) return false;
    const k = norm(p);
    set.delete(k); set.add(k);
    while (set.size > max) set.delete(set.values().next().value);
    return true;
  };
  return {
    grant,
    grantAll(list) { if (Array.isArray(list)) for (const p of list) grant(p); return list; },
    has(p) { return typeof p === 'string' && p.indexOf('\0') < 0 && path.isAbsolute(p) && set.has(norm(p)); },
    get size() { return set.size; },
  };
}

module.exports = { createPathGuard };
