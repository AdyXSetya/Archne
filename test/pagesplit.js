'use strict';
// Tes 3d-a: UI Halaman dipecah per domain (archne-pages.js + archne-pages-compose.js + archne-pages-media.js + archne-pages-files.js + archne-pages-react.js + archne-pages-cmt.js + archne-pages-arc.js).
// Menjaga: urutan muat di archne-index.html, tiap nama top-level tinggal di berkas yang seharusnya (tidak bergeser diam-diam), tak ada deklarasi ganda,
// dan semuanya tetap satu skrip yang sah bila digabung. Logika UI-nya diuji pageui.js / pageview.js / pagefeed.js (memuat ketujuh berkas lewat test/_src.js).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { pagesFiles } = require('./_src');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };

const FILES = ['archne-pages.js', 'archne-pages-compose.js', 'archne-pages-media.js', 'archne-pages-files.js', 'archne-pages-react.js', 'archne-pages-cmt.js', 'archne-pages-arc.js', 'archne-pages-sync.js'];
const OWN = {
  'archne-pages.js': ['PG_WHY', 'pgId', 'pgRefresh', 'pgBtn', 'PG_ERR', 'PG_NORETRY', 'PG_LIMIT', 'pgTok', 'pgF', 'pgMsg', 'pgCut', 'PG_HEX16', 'pgPostHtml', 'renderFeed', 'pgLoad', 'pgFull', 'pgDel', 'pgSkeleton', 'renderPage', 'pgOpen', 'pgClose'],
  'archne-pages-compose.js': ['PG_IMG_MAX', 'PG_FILE_MAX', 'PG_VID_MAX', 'PG_ICO', 'pgAttUi', 'pgImgs', 'pgFiles', 'pgVids', 'pgDraft', 'pgThQ', 'pgBase', 'pgImgUi', 'pgFileUi', 'pgVidUi', 'pgPick', 'pgPickFile', 'pgPickVideo', 'pgThumb', 'pgPost'],
  'archne-pages-media.js': ['PG_TH_RE', 'pgMediaHtml', 'pgMediasHtml', 'PG_VMIME', 'pgVd', 'pgVdFree', 'pgVdClear', 'pgVideosHtml', 'pgVideoGo', 'pgView'],
  'archne-pages-files.js': ['PG_FERR', 'PG_FNORETRY', 'PG_DL_GRACE', 'pgDl', 'pgDlWired', 'pgDlMsg', 'pgFilesHtml', 'pgDlEvent', 'pgFileGo', 'pgFileStop', 'pgDlCancel', 'pgMarkNodl', 'pgToggleDl'],
  'archne-pages-react.js': ['PG_RX_QUICK', 'PG_RX_ERR', 'pgRxShow', 'pgRxApply', 'pgRxSet', 'pgRxHtml', 'pgRxMenu', 'pgRx'],
  'archne-pages-arc.js': ['PG_ARC_ERR', 'pgArcS', 'pgArcWired', 'pgArcSz', 'pgArcMsg', 'pgArcN', 'pgArcDate', 'pgArcCmLine', 'pgArcSumHtml', 'pgArcResHtml', 'pgArcHtml', 'pgArcRender', 'pgArcSet', 'pgArcUi', 'pgArcToggle', 'pgArcExportGo', 'pgArcOpenGo', 'pgArcImportGo', 'pgArcCancelGo', 'pgArcClick', 'pgArcRefreshFeed', 'pgArcEvent'],
  'archne-pages-sync.js': ['PG_SYNC_MS', 'PG_SYNC_PAGES', 'PG_SYNC_CMT_PAGES', 'pgSyncT', 'pgSyncSoonT', 'pgSyncBusy', 'pgSyncAgain', 'pgSyncWired', 'pgSyncSig', 'pgSyncFeed', 'pgSyncReset', 'pgSyncMerge', 'pgSyncCmtRebuild', 'pgSyncCmt', 'pgSyncNow', 'pgSyncSoon', 'pgSyncEvent', 'pgSyncStart', 'pgSyncStop'],
  'archne-pages-cmt.js': ['PG_CMT_LIMIT', 'PG_CMT_MAX', 'PG_CMT_ERR', 'PG_ICO_CMT', 'pgCmtMsg', 'pgCmtGet', 'pgCmtLess', 'pgCmtMerge', 'pgCmtItemHtml', 'pgCmtHtml', 'pgCmtFocusGet', 'pgCmtFocusPut', 'pgCmtToggle', 'pgCmtLoad', 'pgCmtSend', 'pgCmtDel', 'pgCmtDelMine'],
};
// nama top-level sebuah berkas: function / const / let di kolom 0 (deklarator pertama + yang dipisah koma di baris yang sama untuk bentuk sederhana `a = ..., b = ...`)
function names(src) {
  const out = [];
  for (const line of src.split('\n')) {
    let m = /^(?:async\s+)?function\s+(\w+)/.exec(line); if (m) { out.push(m[1]); continue; }
    m = /^(?:const|let)\s+(\w+)/.exec(line); if (m) out.push(m[1]);
  }
  return out;
}

(async () => {
  // A. berkas dan urutan muat
  assert.deepStrictEqual(pagesFiles(), FILES, 'berkas Halaman di renderer/js = tujuh berkas ini (berkas baru: daftarkan di sini dan di archne-index.html)');
  const html = rd('renderer/archne-index.html'), pos = FILES.map((f) => html.indexOf('<script src="js/' + f + '"></script>'));
  assert(pos.every((p) => p > 0), 'ketujuh berkas dimuat di archne-index.html'); assert(pos.every((p, i) => !i || p > pos[i - 1]), 'urutan di archne-index.html = urutan FILES');
  assert(html.indexOf('js/archne-profile-compose.js') < pos[0] && pos[3] < html.indexOf('js/archne-voice-channel.js'), 'di antara archne-profile-compose.js dan archne-voice-channel.js');
  assert(html.slice(pos[0], pos[FILES.length - 1]).split('<script').length === FILES.length, 'tidak ada skrip lain di sela ketujuh berkas');
  assert(html.indexOf('<script src="archne-filecard.js">') < pos[0], 'archne-filecard.js dimuat lebih dulu (FileCard dipakai archne-pages-files.js)');
  ok('archne-index.html: tujuh berkas berurutan, tanpa sisipan, di antara archne-profile-compose.js dan archne-voice-channel.js, sesudah archne-filecard.js');

  // B. kepemilikan nama + tanpa deklarasi ganda
  const src = {}; for (const f of FILES) src[f] = rd('renderer/js/' + f);
  const seen = new Map();
  for (const f of FILES) {
    const have = new Set(names(src[f]));
    for (const n of OWN[f]) assert(have.has(n), n + ' harus dideklarasikan di ' + f);
    for (const n of have) { assert(!seen.has(n), n + ' dideklarasikan di ' + seen.get(n) + ' dan ' + f); seen.set(n, f); }
    assert(/^\/\/ Halaman/.test(src[f]), f + ' diawali komentar header');
  }
  ok('tiap nama top-level tinggal di berkas yang seharusnya; tak ada nama ganda antarberkas');

  // C. gabungan tetap satu skrip yang sah; tiap berkas sah sendiri
  for (const f of FILES) new vm.Script(src[f], { filename: f });
  new vm.Script(FILES.map((f) => src[f]).join('\n'), { filename: 'gabungan' });
  ok('tiap berkas dan gabungannya lolos pengurai (tanpa deklarasi const / let ganda)');

  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
