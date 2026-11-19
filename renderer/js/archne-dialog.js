// js/archne-dialog.js — dialog konfirmasi dan pemberitahuan di dalam aplikasi (pengganti confirm()/alert() bawaan peramban).
// confirm()/alert() tampil kuno, memblokir seluruh jendela, dan tidak jalan di sebagian WebView Android. Di sini: kartu bergaya aplikasi, dapat dibatalkan
// dengan Esc/klik latar, dan yang merusak (hapus, blokir, keluar) berwarna merah. Tanpa DOM sungguhan (tes vm) jatuh ke confirm()/alert() asli.
// Dipakai: if (!await ask('Judul?\nPenjelasan')) return;   notify('Gagal ...')
// i18n (C1): kata pertama judul menentukan merah/label tombol. Dua bahasa dikenali (teks yang masuk sudah diterjemahkan pemanggilnya).
// Kalimat Inggris yang diawali kata lain (mis. 'This file...', 'New quota...') TIDAK dikenali: pemanggil wajib memberi { ok, danger } eksplisit.
const DLG_DANGER = /^(hapus|bersihkan|blokir|keluarkan|bubarkan|keluar|batalkan|lepas|cabut|kuota|berkas|delete|clear|block|remove|disband|leave|unsend|unpin|revoke)\b/i;
const DLG_LABEL = { kuota: ['dlg.continue', 'Lanjutkan'], berkas: ['dlg.accept', 'Terima'], batalkan: ['dlg.unsend', 'Batalkan pesan'], jadikan: ['dlg.make', 'Jadikan'], unsend: ['dlg.unsend', 'Batalkan pesan'], make: ['dlg.make', 'Jadikan'] };
let dlgRes = null, dlgBack = null;
const dlgReal = () => !!(document.body && document.body.appendChild);
function dlgSplit(text) { // baris pertama (atau kalimat pertama) jadi judul, sisanya penjelasan
  const t = String(text == null ? '' : text).trim(), nl = t.indexOf('\n');
  if (nl > 0) return [t.slice(0, nl).trim(), t.slice(nl + 1).trim()];
  const m = /^(.{3,}?[?!.])\s+(\S[\s\S]*)$/.exec(t);
  return m ? [m[1], m[2]] : [t, ''];
}
function dlgClose(v) {
  $('dlg').style.display = 'none';
  const r = dlgRes; dlgRes = null;
  try { if (dlgBack && dlgBack.focus) dlgBack.focus(); } catch {} dlgBack = null;
  if (r) r(v);
}
function ask(text, opt) {
  if (!dlgReal()) return Promise.resolve(confirm(text));
  opt = opt || {};
  if (dlgRes) dlgClose(false);
  const [title, body] = dlgSplit(text), first = (/^\S+/.exec(title) || [''])[0].toLowerCase().replace(/[^a-z]/g, '');
  const danger = opt.danger !== undefined ? !!opt.danger : DLG_DANGER.test(title);
  $('dlgt').textContent = title; $('dlgm').textContent = body; $('dlgm').style.display = body ? '' : 'none';
  const lb = DLG_LABEL[first];
  $('dlgok').textContent = opt.ok || (lb ? txf(lb[0], lb[1]) : danger ? first.charAt(0).toUpperCase() + first.slice(1) : txf('dlg.yes', 'Ya'));
  $('dlgno').textContent = opt.cancel || txf('common.cancel', 'Batal');
  $('dlgok').className = danger ? 'dng' : ''; $('dlg').classList.toggle('danger', danger);
  dlgBack = document.activeElement; $('dlg').style.display = 'flex';
  try { (danger ? $('dlgno') : $('dlgok')).focus(); } catch {}
  return new Promise((res) => { dlgRes = res; });
}
function notify(text) { // galat dari Core: toast, bukan kotak OK yang memblokir
  const t = String(text == null || text === '' ? txf('common.error', 'Terjadi kesalahan') : text);
  if (!dlgReal()) return alert(t);
  toast(t);
}
$('dlgok').onclick = () => dlgClose(true);
$('dlgno').onclick = () => dlgClose(false);
$('dlg').onclick = (e) => { if (e.target === $('dlg')) dlgClose(false); };
if (document.addEventListener) document.addEventListener('keydown', (e) => { if (dlgRes && e.key === 'Escape') { e.preventDefault(); dlgClose(false); } });
