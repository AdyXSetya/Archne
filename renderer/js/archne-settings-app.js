// ---- Pengaturan: Aplikasi (tombol Keluar dan Reset data) ----
// Dua tindakan tingkat aplikasi, hanya tampil di tempat yang memang bisa melakukannya:
//   - Desktop (Electron): window.api.appQuit() / appReset() lewat IPC (preload.js -> src/archne-ipc.js -> main.js).
//   - Android: pesan ke cangkang (mobile/shell/index.html) -> plugin ArchneBackground.quit / reset.
//   - Peramban / Termux (serve.bat): tidak ada cara menutup proses dari halaman, bagian ini tidak digambar.
// Bagian ini tidak punya nilai untuk disimpan; save() selalu lolos.
let appBusy = false;
const appInFrame = () => { try { return !!(window.parent && window.parent !== window); } catch (x) { return false; } };
function appKind() {
  if (window.api && typeof window.api.appQuit === 'function' && typeof window.api.appReset === 'function') return 'desktop';
  if (typeof S !== 'undefined' && S && S.canNotify && appInFrame()) return 'android'; // canNotify hanya dipasang inti Node milik cangkang Android
  return '';
}
function appNative(action) { try { window.parent.postMessage({ archne: 'native', action }, '*'); return true; } catch (x) { return false; } }
SET_SECTIONS.push({
  id: 'app', icon: 'gear', order: 90,
  get title() { return txf('app.title', 'Aplikasi'); },
  html() {
    const k = appKind();
    if (!k) return '';
    const quitHint = k === 'android'
      ? txf('app.quit.hintAndroid', 'Menutup Archne sepenuhnya tanpa perlu "Paksa berhenti" dari pengaturan Android. Layanan latar dan notifikasi ikut berhenti, jadi pesan dan panggilan baru masuk lagi setelah Archne dibuka.')
      : txf('app.quit.hintDesktop', 'Menutup Archne sepenuhnya, termasuk koneksi ke teman. Pesan dan panggilan baru masuk lagi setelah Archne dibuka.');
    const row = (act, title, hint, label, cls) => `<div class="strow"><div class="stt">${esc(title)}</div><div class="sth">${esc(hint)}</div><div class="stc"><button type="button" class="sec${cls}" data-appact="${act}">${esc(label)}</button></div></div>`;
    return '<div class="sint">' + esc(txf('app.intro', 'Tutup Archne sepenuhnya, atau kembalikan seperti baru dipasang.')) + '</div>'
      + '<div class="setgrp">'
      + row('quit', txf('app.quit.title', 'Keluar dari Archne'), quitHint, txf('app.quit.btn', 'Keluar'), '')
      + row('reset', txf('app.reset.title', 'Reset data'), txf('app.reset.hint', 'Menghapus semua data Archne di perangkat ini lalu memulai ulang seperti akun baru: identitas dan kunci, teman, obrolan, grup, Halaman, situs Web Lokal, dan pengaturan. Tidak bisa dibatalkan.'), txf('app.reset.btn', 'Reset data'), ' dng')
      + '</div>';
  },
  async save() { return { ok: true }; },
});

const appFail = (act) => toast(txf(act === 'quit' ? 'app.quit.fail' : 'app.reset.fail', act === 'quit' ? 'Gagal menutup aplikasi' : 'Gagal mereset data'));
async function appDo(act) {
  if (appBusy) return;
  const k = appKind();
  if (!k || (act !== 'quit' && act !== 'reset')) return;
  appBusy = true; // mencakup seluruh alur (konfirmasi sampai selesai): klik ganda tidak membuka dua alur
  let started = false;
  try {
    if (act === 'quit') {
      if (!await ask(txf('app.quit.confirm', 'Keluar dari Archne?\nAplikasi ditutup sepenuhnya dan tidak menerima pesan atau panggilan sampai dibuka lagi.'), { ok: txf('app.quit.btn', 'Keluar'), danger: false })) return;
    } else {
      if (!await ask(txf('app.reset.confirm1', 'Hapus semua data Archne?\nIdentitas, teman, obrolan, grup, Halaman, situs, dan pengaturan dihapus permanen. Orang lain akan melihatmu sebagai akun baru. Berkas yang sudah tersimpan di folder Download tidak ikut dihapus.'), { ok: txf('app.reset.next', 'Lanjutkan'), danger: true })) return;
      if (!await ask(txf('app.reset.confirm2', 'Yakin? Ini tidak bisa dibatalkan.\nSetelah dihapus, Archne dimulai ulang sebagai akun baru.'), { ok: txf('app.reset.all', 'Hapus semua'), danger: true })) return;
    }
    if (k === 'desktop') {
      const r = await (act === 'quit' ? window.api.appQuit() : window.api.appReset());
      if (r && r.ok === false) return appFail(act);
    } else if (!appNative(act)) return appFail(act);
    started = true;
    toast(txf(act === 'quit' ? 'app.quit.closing' : 'app.reset.working', act === 'quit' ? 'Menutup Archne...' : 'Menghapus data...'), true);
    // Proses akan berhenti / mulai ulang, jadi tombol dibiarkan terkunci. Bila ternyata tidak (cangkang Android menolak dan mengirim 'native-error'), kunci dilepas setelah 15 dtk.
    setTimeout(() => { appBusy = false; }, 15000);
  } catch (x) { appFail(act); }
  finally { if (!started) appBusy = false; }
}
// addEventListener (bukan onclick) karena archne-direct.js memakai setbody.onclick.
if ($('setbody').addEventListener) $('setbody').addEventListener('click', (e) => { const b = e.target && e.target.closest && e.target.closest('[data-appact]'); if (b) appDo(b.dataset.appact); });
