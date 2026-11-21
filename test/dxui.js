'use strict';
// Tes tampilan Kirim Langsung (v0.24.0, step 2b): renderer/archne-dxcard.js (fungsi murni) + kontrak archne-index.html / archne-direct.js / preload.js.
const fs = require('fs'), path = require('path'), assert = require('assert');
const D = require('../renderer/archne-dxcard');
const root = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  OK  ' + n); };
const id = (c) => c.repeat(32);

// ---- 1. format ----
assert.strictEqual(D.fmtSize(0), '0 B'); assert.strictEqual(D.fmtSize(1536), '1,5 KB'); assert.strictEqual(D.fmtSize(3 * 1073741824), '3,00 GB');
assert.strictEqual(D.fmtSize(2 * 1099511627776), '2,00 TB');
assert.strictEqual(D.fmtEta(1000, 100), '10 dtk'); assert.strictEqual(D.fmtEta(6000, 100), '1 mnt 0 dtk'); assert.strictEqual(D.fmtEta(1000, 0), '');
assert.strictEqual(D.pct(50, 200), 25); assert.strictEqual(D.pct(5, 0), 0); assert.strictEqual(D.pct(999, 10), 100);
assert.strictEqual(D.progressText(50, 200, 0), '25% · 50 B / 200 B');
assert(D.progressText(1048576, 10485760, 1048576).includes('1,0 MB/dtk') && D.progressText(1048576, 10485760, 1048576).includes('sisa 9 dtk'));
ok('format ukuran, kecepatan, sisa waktu, persen');

// ---- 2. aksi tiap status ----
const acts = (h) => [...h.matchAll(/data-act="(\w+)"/g)].map((m) => m[1]);
const inn = (state, x) => D.rowHtml(Object.assign({ id: id('a'), fromName: 'Budi', name: 'Proyek', kind: 'dir', count: 12, state, total: 1000, done: 400, speed: 100, ts: 1 }, x), 'in');
const out = (state, x) => D.rowHtml(Object.assign({ id: id('b'), toName: 'Sari', name: 'f.zip', kind: 'file', count: 1, state, total: 1000, sent: 400, ts: 1 }, x), 'out');
assert.deepStrictEqual(acts(inn('offered')), ['accept', 'acceptas', 'decline']);
assert.deepStrictEqual(acts(inn('listing')), []);
assert.deepStrictEqual(acts(inn('running')), ['pause', 'cancel']); assert(inn('running').includes('data-dxbar') && inn('running').includes('40%'));
assert.deepStrictEqual(acts(inn('waiting')), ['pause', 'cancel']); assert(inn('waiting').includes('Menyambung ulang'));
assert.deepStrictEqual(acts(inn('paused', { code: 'restart' })), ['resume', 'cancel']); assert(inn('paused', { code: 'restart' }).includes('Aplikasi sempat ditutup'));
assert.deepStrictEqual(acts(inn('done')), ['opendir', 'remove']);
assert(inn('done', { failed: 2 }).includes('2 berkas gagal'));
assert.deepStrictEqual(acts(inn('error', { code: 'net' })), ['resume', 'cancel']);
assert.deepStrictEqual(acts(inn('error', { code: 'gone' })), ['cancel'], 'pengirim sudah membatalkan: tidak ada Coba lagi');
assert.deepStrictEqual(acts(inn('cancelled', { code: 'gone' })), ['remove']);
assert.deepStrictEqual(acts(out('offered')), ['cancelout']); assert(out('offered').includes('Menunggu Sari'));
assert.deepStrictEqual(acts(out('active')), ['cancelout']); assert(out('active').includes('data-dxbar'));
assert.deepStrictEqual(acts(out('done')), ['remove']); assert.deepStrictEqual(acts(out('declined')), ['remove']); assert(out('declined').includes('menolak'));
assert.deepStrictEqual(acts(out('cancelled')), ['remove']);
ok('tombol tiap status masuk/keluar sesuai (Terima/Pilih folder/Tolak, Jeda/Lanjutkan/Batal, Buka folder, Hapus)');

// ---- 3. keamanan: teks jaringan di-escape, id harus 32 hex ----
const evil = '<img src=x onerror=alert(1)>"\'';
const h = inn('offered', { fromName: evil, name: evil });
assert(!h.includes('<img') && h.includes('&lt;img'), 'nama dari jaringan harus di-escape');
const h2 = inn('error', { err: evil, code: 'io' });
assert(!h2.includes('<img'), 'pesan galat harus di-escape');
assert.strictEqual(D.rowHtml({ id: '"><script>x</script>', state: 'done' }, 'in'), '', 'id bukan 32 hex ditolak');
assert.strictEqual(D.rowHtml(null, 'in'), '');
ok('XSS: nama berkas/peer dan galat di-escape; id selain 32 hex tidak dirender');

// ---- 4. daftar: urutan + kosong + lencana ----
const st = { in: [{ id: id('1'), state: 'done', ts: 5, name: 'x', total: 1, done: 1, kind: 'file', count: 1 }, { id: id('2'), state: 'offered', ts: 1, name: 'y', total: 1, done: 0, kind: 'file', count: 1 }, { id: id('3'), state: 'running', ts: 3, name: 'z', total: 10, done: 1, kind: 'file', count: 1 }],
  out: [{ id: id('4'), state: 'active', ts: 9, name: 'w', total: 10, sent: 1, kind: 'file', count: 1 }] };
const order = [...D.listHtml(st).matchAll(/data-dxrow="(\w{32})"/g)].map((m) => m[1][0]);
assert.deepStrictEqual(order, ['2', '4', '3', '1'], 'tawaran dulu, lalu aktif (terbaru di atas), lalu selesai');
assert(D.listHtml({ in: [], out: [] }).includes('Belum ada transfer'));
assert.strictEqual(D.pending(st), 1); assert.strictEqual(D.pending(null), 0);
ok('urutan daftar: tawaran > aktif > selesai; keadaan kosong; hitungan tawaran menunggu');

// ---- 5. kontrak: archne-index.html, archne-direct.js, preload.js ----
const html = fs.readFileSync(path.join(root, 'renderer', 'archne-index.html'), 'utf8'), js = fs.readFileSync(path.join(root, 'renderer', 'js', 'archne-direct.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const DYN = new Set(['setdxdir', 'setdxreset', 'morebtn', 'dxlistbtn']); // digambar dinamis (Pengaturan 2d; header/menu ⋮ oleh render()), bukan ada di archne-index.html; dicek di test/setui.js dan bagian 6
for (const m of js.matchAll(/\$\('(\w+)'\)/g)) assert(DYN.has(m[1]) || html.includes('id="' + m[1] + '"'), 'archne-index.html tidak punya #' + m[1]);
const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
for (const m of js.matchAll(/\b(?:A|window\.api)\.(\w+)\(/g)) assert(exposed.has(m[1]) || m[1] === 'dxUpload', 'archne-direct.js memakai api.' + m[1] + ' yang tidak ada di preload.js');
const order2 = ['archne-dxcard.js', 'js/archne-dialog.js', 'js/archne-profile-compose.js', 'js/archne-direct.js'].map((n) => html.indexOf('src="' + n + '"'));
assert(order2.every((x) => x > 0) && order2.every((x, i) => !i || x > order2[i - 1]), 'archne-dxcard.js dan archne-dialog.js (ask/notify) harus dimuat sebelum archne-direct.js');
assert(html.includes('href="css/archne-direct.css"'));
assert(!/onUpdate\(/.test(js), 'archne-direct.js tidak boleh mendaftar onUpdate sendiri (refresh() yang memanggil dxSoon)');
assert(fs.readFileSync(path.join(root, 'renderer', 'js', 'archne-profile-compose.js'), 'utf8').includes('dxSoon()'));
const dxOk = ['accept', 'acceptas', 'decline', 'pause', 'resume', 'cancel', 'cancelout', 'remove', 'opendir'];
for (const a of dxOk) assert(js.includes(a + ':'), 'aksi ' + a + ' belum ditangani archne-direct.js');
ok('kontrak: semua #id ada, semua api.dx* ada di preload, urutan script benar, 9 aksi tertangani');

// ---- 6. (2c) tombol kirim di chat pribadi: gerbang LAN/online + kontrak ----
const G = D.sendGate;
assert.deepStrictEqual([G({ lan: true, online: true }).ok, G({ lan: true, online: true }).why], [true, '']);
assert.strictEqual(G({ lan: false, online: true }).why, 'lan', 'peer non-LAN ditolak walau online');
assert.strictEqual(G({ lan: true, online: false, name: 'Budi' }).why, 'offline'); assert(G({ lan: true, online: false, name: 'Budi' }).title.includes('Budi'));
assert.strictEqual(G({ lan: false, online: false }).why, 'lan', 'alasan LAN didahulukan');
assert.strictEqual(G(null).ok, false); assert.strictEqual(G({}).ok, false, 'tanpa penanda lan -> tidak aktif (aman)');
const rend = fs.readFileSync(path.join(root, 'renderer', 'js', 'archne-render.js'), 'utf8');
assert(/S\.canDirect/.test(rend) && rend.includes("one('dxfilebtn'") && rend.includes("one('dxfolderbtn'"), 'butir kirim hanya digambar bila canDirect, di menu ⋮ chat pribadi');
assert(/!grp && cur !== 'public' && \(S\.canDirect \|\| S\.canDirectCopy\)/.test(rend), 'bukan untuk grup/publik; muncul bila ada pemilih berpath (PC) atau jalur salin (HP)');
assert(!/hb\('dxsend'/.test(rend) && !/hb\('bellbtn'/.test(rend), 'header tidak lagi memuat tombol kirim/lonceng (hanya panggilan + video + ⋮)');
const hmenu = rend.slice(rend.indexOf('<div id="hmenu">'), rend.indexOf('renderVc(grp)'));
for (const x of ['bellbtn', 'dxfilebtn', 'dxfolderbtn', 'dxlistbtn']) assert(hmenu.includes('id="' + x + '"') || hmenu.includes("one('" + x + "'"), x + ' ada di menu ⋮');
assert(!html.includes('id="dxbtn"') && !html.includes('id="dxmenu"'), 'tombol transfer di baris profil dan popup lama dibuang');
assert(/dxSendRun\(kind, peer\.id\)/.test(rend) && /dxShow\(\)/.test(rend), 'butir menu memanggil dxSendRun / dxShow');
ok('2c: gerbang LAN+online (non-LAN/offline/tanpa data = nonaktif), butir Kirim berkas/folder di menu ⋮ hanya di chat pribadi saat canDirect; lonceng + Transfer berkas juga di menu');

// ---- 7. (2d) kontrak pengaturan folder terima ----
assert(/dxChooseDir: \(\) =>/.test(preload) && /'dxChooseDir'/.test(fs.readFileSync(path.join(root, 'renderer', 'archne-api-http.js'), 'utf8')), 'dxChooseDir ada di preload.js dan archne-api-http.js');
assert(!/dxChooseDir: \([^)]+\)/.test(preload), 'dxChooseDir tidak menerima argumen (tidak ada path dari renderer)');
assert(/SET_SECTIONS\.push\(\{\s*id: 'direct'/.test(js) && /api\.dxChooseDir\(\)/.test(js.replace('window.api.dxChooseDir()', 'api.dxChooseDir()')), 'bagian Pengaturan terdaftar di archne-direct.js');
assert(/setSettings\(\{ directDir: null \}\)/.test(js), 'reset hanya null');
for (const m of js.replace(/\/\/.*$/gm, '').matchAll(/directDir:\s*(\S+)/g)) assert.strictEqual(m[1].replace(/[^\w]/g, ''), 'null', 'renderer tidak pernah mengirim path directDir');
assert(html.indexOf('src=\"js/archne-settings.js\"') < html.indexOf('src=\"js/archne-direct.js\"'), 'SET_SECTIONS (80) ada sebelum archne-direct.js');
ok('2d: dxChooseDir tanpa argumen di preload/api-http, bagian Pengaturan terdaftar, reset hanya null, urutan skrip');

// ---- 8. (2e) tombol Batalkan pemindaian ----
assert(html.includes('id="dxscanbar"') && html.includes('id="dxscancancel"') && html.includes('id="dxscantxt"'));
assert(/api\.dxCancelScan\(dxJobCur\)/.test(js) && /dxScanBar\(false\)/.test(js) && /finally \{ dxJobCur = null/.test(js), 'batal memakai job aktif; bilah selalu ditutup (finally)');
assert(/code !== 'abort'/.test(js), 'batal tidak dianggap galat');
assert(/#dxscanbar\{display:none/.test(fs.readFileSync(path.join(root, 'renderer', 'css', 'archne-direct.css'), 'utf8')));
ok('2e: bilah pemindaian + tombol Batalkan memanggil dxCancelScan(job aktif); batal bukan galat');

// ---- 9. folder terima bawaan: PC Windows = <drive sistem>\file_transfer; Android = Download/file_transfer (disalin lewat MediaStore) ----
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8'), andMain = fs.readFileSync(path.join(root, 'mobile', 'shell', 'main.js'), 'utf8');
const andIdx = fs.readFileSync(path.join(root, 'mobile', 'shell', 'index.html'), 'utf8'), javaDl = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'xyraori', 'archne', 'ArchneDownloads.java'), 'utf8');
assert(/process\.platform !== 'win32'/.test(mainJs) && /'file_transfer'/.test(mainJs) && /directDir: directDefaultDir\(\) \|\| undefined/.test(mainJs), 'main.js: Windows memakai <drive>\\file_transfer, selain itu bawaan Core');
assert(/on\('direct_file'/.test(andMain) && /sub: 'file_transfer'/.test(andMain) && /directShown/.test(andMain), 'Android: tiap berkas Kirim Langsung disalin ke Download/file_transfer');
assert(/info\.sub/.test(andIdx) && /path: info\.path, name: info\.name, mime: mime, sub: sub/.test(andIdx), 'index.html Android meneruskan subfolder ke plugin');
assert(/cleanSub/.test(javaDl) && /RELATIVE_PATH, sub\.isEmpty\(\)/.test(javaDl) && /equals\("\.\."\)/.test(javaDl), 'plugin: subfolder dibersihkan (tanpa .. / kosong) sebelum dipakai');
ok('folder bawaan: C:\\file_transfer (Windows) dan Download/file_transfer (Android) terkunci di kode; subfolder plugin dibersihkan');

// ---- 10. HP: Kirim Langsung lewat salinan sementara (canDirectCopy) ----
const apiHttp = fs.readFileSync(path.join(root, 'renderer', 'archne-api-http.js'), 'utf8');
assert(/api\.dxUpload = async \(job, file, signal\)/.test(apiHttp) && /dxupload\?job=/.test(apiHttp), 'archne-api-http.js: dxUpload mengunggah ke /dxupload per job');
assert(/copy = !S\.canDirect && !!S\.canDirectCopy/.test(js) && /api\.dxUpload\(job,/.test(js) && /dxCopyAc\.abort\(\)/.test(js), 'archne-direct.js: jalur salin dipakai hanya bila tak ada pemilih berpath; batal menghentikan unggahan');
assert(!/dxCopyMax/.test(js), 'tanpa batas ukuran (hanya penyimpanan HP yang membatasi)');
assert(/S\.canDirect \? one\('dxfolderbtn'/.test(rend), 'folder tidak ditawarkan di HP (tidak ada pemilih folder)');
const plugXml = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
assert(/copy && dxNat\.pick/.test(js) && /action: 'dxpick'/.test(js) && /d\.pick === true/.test(js), 'archne-direct.js: bila cangkang bisa memilih berpath, berkas dikirim dari lokasi aslinya');
assert(/@PluginMethod\s+public void access\(PluginCall/.test(javaDl) && /@PluginMethod\s+public void askAccess\(PluginCall/.test(javaDl) && /@PluginMethod\s+public void pick\(PluginCall/.test(javaDl) && /ACTION_OPEN_DOCUMENT/.test(javaDl) && /EXTRA_ALLOW_MULTIPLE/.test(javaDl), 'plugin: access/askAccess/pick ada, pemilih sistem banyak berkas');
assert(/isExternalStorageManager/.test(javaDl) && /ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION/.test(javaDl) && /MANAGE_EXTERNAL_STORAGE/.test(plugXml), 'plugin: izin akses semua berkas (Android 11+) dideklarasikan dan diminta');
assert(/pathOrCopy/.test(javaDl) && /canRead\(\)/.test(javaDl) && /externalstorage\.documents/.test(javaDl), 'plugin: path asli dipakai bila terbaca, selain itu disalin ke dxout');
assert(/dxout: rt\.core\._dxTmpRoot\(\)/.test(andMain), 'inti memberi tahu cangkang folder dxout (yang dibersihkan Core)');
ok('HP: jalur salin ke cache (dxUpload) hanya tanpa pemilih berpath, tanpa batas ukuran, ada batal, tanpa tombol folder');

console.log('\n' + pass + ' tes Kirim Langsung UI OK');
