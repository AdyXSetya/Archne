'use strict';
// Langkah 3e: jembatan onWake (archne-wanhost) -> kejadian SSE 'wake' untuk layanan latar Android (ArchneService).
// makeOnWake(getRpc, log) -> (n) => void. getRpc dipanggil saat wake terjadi (rpc baru ada setelah startHeadless selesai); null = abaikan.
// Isi kejadian: { from, who, ts }. Tidak membawa isi signal: layanan hanya perlu tahu siapa yang ingin tersambung.
function makeOnWake(getRpc, log) {
  const lg = typeof log === 'function' ? log : () => {};
  return (n) => {
    try {
      const rpc = typeof getRpc === 'function' ? getRpc() : null;
      if (!rpc || !n || typeof n.from !== 'string' || !/^[0-9a-f]{16}$/.test(n.from)) return;
      rpc.broadcast('wake', { from: n.from, who: String(n.who || '').slice(0, 60) || 'Archne', ts: Number.isFinite(n.ts) ? n.ts : Date.now() });
    } catch (e) { lg('wake gagal ' + (e && e.message)); }
  };
}
module.exports = { makeOnWake };
