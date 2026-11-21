'use strict';
// Hook scripts/after-pack.js (resedit) menanam ikon + info versi ke .exe. Tes ini memakai PE sungguhan yang ikut terpasang
// (Setup.exe milik electron-winstaller, punya ikon dan resource versi) lalu memeriksa hasilnya dengan resedit juga.
// Dilewati bila PE contoh tidak ada (mis. dependensi dev tidak terpasang); package.json harus tetap mem-pin resedit.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const root = path.resolve(__dirname, '..');
const ok = (m) => console.log('ok - ' + m);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert(pkg.devDependencies && pkg.devDependencies.resedit, 'resedit ada di devDependencies');
assert(/^\d+\.\d+\.\d+$/.test(pkg.devDependencies.resedit), 'resedit dipin ke versi tepat (hook memodifikasi .exe rilis)');
ok('resedit dipin: ' + pkg.devDependencies.resedit);

const sample = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'Setup.exe');
const icon = path.join(root, 'build', 'icon.ico');
if (!fs.existsSync(sample) || !fs.existsSync(path.join(root, 'node_modules', 'resedit'))) {
  console.log('skip - PE contoh/resedit tidak terpasang (npm ci dulu)');
  process.exit(0);
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-ap-'));
  const exe = path.join(tmp, 'T.exe');
  try {
    fs.copyFileSync(sample, exe);
    const { embed } = require('../scripts/after-pack.js');
    const meta = { productName: 'ArchneTest', description: 'Deskripsi', company: 'xyraori', copyright: 'MIT', version: '1.2.3', internalName: 'ArchneTest', originalName: 'ArchneTest.exe' };
    await embed(exe, meta, icon);
    const R = await import('resedit');
    const read = () => {
      const e = R.NtExecutable.from(fs.readFileSync(exe));
      const res = R.NtExecutableResource.from(e);
      const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
      return { vi, groups: R.Resource.IconGroupEntry.fromEntries(res.entries).length };
    };
    let { vi, groups } = read();
    const lang = vi.getAllLanguagesForStringValues()[0];
    const s = vi.getStringValues(lang);
    assert.strictEqual(s.ProductName, 'ArchneTest');
    assert.strictEqual(s.CompanyName, 'xyraori');
    assert.strictEqual(s.OriginalFilename, 'ArchneTest.exe');
    assert.deepStrictEqual([vi.fixedInfo.fileVersionMS >>> 16, vi.fixedInfo.fileVersionMS & 0xffff, vi.fixedInfo.fileVersionLS >>> 16], [1, 2, 3]);
    assert(groups >= 1, 'grup ikon ada');
    ok('embed: info versi dan ikon tertanam');
    const before = fs.readFileSync(exe);
    await embed(exe, meta, icon);
    ({ vi, groups } = read());
    assert.strictEqual(vi.getStringValues(vi.getAllLanguagesForStringValues()[0]).ProductName, 'ArchneTest');
    assert(fs.readFileSync(exe).length > 0 && before.length > 0);
    ok('embed aman diulang');
    // PE tanpa grup ikon: harus gagal keras, bukan diam-diam lolos
    const bare = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z-x64.exe');
    if (fs.existsSync(bare)) {
      const b = path.join(tmp, 'B.exe'); fs.copyFileSync(bare, b);
      await assert.rejects(() => embed(b, meta, icon), /grup ikon|resource versi/);
      ok('PE tanpa ikon/versi ditolak dengan pesan jelas');
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (_) { /* antivirus Windows bisa menahan berkas sebentar; folder temp tidak kritis */ }; }
})().catch((e) => { console.error(e); process.exit(1); });
