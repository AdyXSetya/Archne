// ---- Pengaturan: Hemat kuota relay (v0.23.1) ----
// Batas ukuran berkas untuk koneksi ANTAR JARINGAN: titipan ke kurir dan pengambilan langsung lewat relay. Jaringan lokal (LAN) tanpa batas ukuran.
// Berkas yang lebih besar tidak dititipkan (penerima mengambil langsung dari pengirim), dan berkas tidak pernah dititipkan lewat relay (Cloudflare/Metered). Maksimal 100 MB, sengaja TANPA opsi tanpa batas. Logikanya ada di src/core/archne-relay-policy.js.
const RELAY_MB = [0, 1, 5, 10, 25, 50, 100];
const relayLabel = (mb, def) => (mb === 0 ? txf('relay.off', 'Mati (tanpa berkas antar jaringan)') : mb === def ? txf('relay.default', '{size} (bawaan)', { size: setMb(mb) }) : setMb(mb));
SET_SECTIONS.push({
  id: 'relay', icon: 'relay', order: 20,
  get title() { return txf('relay.title', 'Hemat kuota relay'); },
  html(d) {
    const it = d.items && d.items.escMax;
    if (!it) return ''; // inti lama tanpa pengaturan ini
    const defMb = Math.round(it.def / MBYTE), curMb = it.value / MBYTE, preset = RELAY_MB.includes(curMb);
    const opts = RELAY_MB.map((mb) => [String(mb), relayLabel(mb, defMb)]);
    if (!preset) opts.push(['keep', txf('relay.manual', '{size} (diatur manual)', { size: Math.round(curMb * 100) / 100 + ' MB' })]);
    const cur = preset ? String(curMb) : 'keep';
    const sel = `<select id="setrelay" aria-label="${esc(txf('relay.aria', 'Batas ukuran berkas antar jaringan'))}">${opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    return '<div class="sint">' + esc(txf('relay.intro', 'Cloudflare dan Metered menghitung kuota dari semua data yang lewat relay, dan berkas adalah yang terbesar. Pesan teks tetap hemat dan tidak dibatasi.')) + '</div>'
      + `<div class="setgrp"><div class="strow"><div class="stt">${esc(txf('relay.rowTitle', 'Berkas antar jaringan'))}</div><div class="sth">${esc(txf('relay.rowHint', 'Berkas sampai ukuran ini boleh dititipkan ke kurir (supaya penerima bisa mengambilnya saat kamu offline) dan dikirim lewat relay. Yang lebih besar hanya lewat jalur langsung. Jaringan lokal (LAN) tanpa batas.'))}</div><div class="stc">${sel}</div></div></div>`
      + `<div class="setnote">${esc(txf('relay.note', 'Titipan berkas ke kurir hanya lewat jalur langsung atau LAN, tidak pernah lewat relay. Teks, grup, dan pesan penting tetap dititipkan seperti biasa. Batas paling besar {max}.', { max: setMb(Math.round(it.max / MBYTE)) }))}</div>`;
  },
  async save(d) {
    const it = d.items && d.items.escMax, el = $('setrelay');
    if (!it || !el || el.value === 'keep') return { ok: true };
    const bytes = Number(el.value) * MBYTE;
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > it.max) return { ok: false, err: txf('relay.errRange', 'Batas titipan harus antara 0 dan {max}', { max: setMb(Math.round(it.max / MBYTE)) }) };
    if (bytes === it.value) return { ok: true };
    const r = await window.api.setSettings({ escMax: bytes === it.def ? null : bytes });
    return r && r.ok ? { ok: true, data: r, changed: true } : { ok: false, err: setErr(Object.assign({ key: 'escMax' }, r || {})) };
  },
});
