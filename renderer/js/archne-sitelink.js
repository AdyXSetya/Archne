// js/archne-sitelink.js — tautan situs di chat (0.34.0 Fase F.5): ketuk chip archne://domain.archne@idPemilik membuka penampil (js/archne-sitebar.js).
// Memakai $, S, toast, txf, sbApi, sbOpen (js/archne-sitebar.js). Dipanggil dari penangan klik di js/archne-weblink.js.
// Tautan hanya membawa domain + id pemilik. id situs DICARI dari daftar milik pemilik itu (webList q=domain, cocok persis), jadi tautan tidak bisa menyodorkan id situs lain;
// nama pemilik di bilah dibaca proses utama dari Core. Tautan ke situs SENDIRI membuka pratinjau (id dari webMine lokal). Tidak ketemu (dihapus / disembunyikan / bukan untukmu) dijawab sama: situs tidak ditemukan.
const SL_PAGES = 5, SL_LIMIT = 20; // paling banyak 5 halaman daftar per ketukan (q menyempitkan hasil, nama yang diawali sama jarang sebanyak itu)
let slBusy = false;

async function slOpen(domain, peerId) {
  const a = window.api;
  if (typeof sbApi !== 'function' || !sbApi() || !a || typeof a.webList !== 'function') { toast(txf('lw.viewerSoon', 'Penampil situs hadir di versi berikutnya.')); return; }
  if (slBusy) return;
  if (typeof domain !== 'string' || typeof peerId !== 'string' || !domain || !peerId) return;
  slBusy = true;
  try {
    if (S && S.me && peerId === S.me.id) { // situs sendiri (F.4): dicari di daftar lokal (tanpa jaringan), lalu dibuka sebagai pratinjau di penampil yang sama
      let r; try { r = typeof a.webMine === 'function' ? await a.webMine() : null; } catch (x) { r = null; }
      const mine = r && r.ok && Array.isArray(r.items) ? r.items.find((m) => m && m.domain === domain && typeof m.id === 'string') : null;
      if (mine) { await sbOpen(peerId, mine.id, mine.domain); return; }
      toast(r && r.ok === false && typeof r.err === 'string' && r.err ? r.err : txf('lw.link.gone', 'Situs {domain}.archne tidak ditemukan di pemilik ini (mungkin sudah dihapus, disembunyikan, atau bukan untukmu)', { domain }));
      return;
    }
    toast(txf('lw.link.finding', 'Mencari situs…'));
    let after = null, hit = null, err = '', failed = false;
    for (let i = 0; i < SL_PAGES && !hit; i++) {
      const o = { limit: SL_LIMIT, q: domain }; if (after) o.after = after;
      let r; try { r = await a.webList(peerId, o); } catch (x) { r = null; }
      if (!r || !r.ok) { failed = true; err = (r && typeof r.err === 'string') ? r.err : ''; break; }
      hit = (Array.isArray(r.items) ? r.items : []).find((s) => s && s.domain === domain && typeof s.id === 'string') || null;
      after = typeof r.next === 'string' ? r.next : null;
      if (!after) break;
    }
    if (hit) { await sbOpen(peerId, hit.id, hit.domain); return; }
    toast(failed ? (err || txf('site.openFail', 'Gagal membuka situs')) : txf('lw.link.gone', 'Situs {domain}.archne tidak ditemukan di pemilik ini (mungkin sudah dihapus, disembunyikan, atau bukan untukmu)', { domain }));
  } finally { slBusy = false; }
}
