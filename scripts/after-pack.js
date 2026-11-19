'use strict';
// Hook afterPack electron-builder: menanam ikon (build/icon.ico) dan info versi ke Archne.exe.
//
// Kenapa perlu: package.json memakai win.signAndEditExecutable=false (supaya build tidak butuh winCodeSign/rcedit, yang di Windows tanpa
// mode Developer/admin gagal saat mengekstrak symlink). Konsekuensinya electron-builder TIDAK mengedit .exe, sehingga ikon dan info
// versinya tetap milik Electron. Hook ini mengerjakannya sendiri dengan `resedit` (JavaScript murni, tanpa binary tambahan) di folder
// win-unpacked sebelum dibungkus menjadi portable/installer, jadi keduanya ikut mendapat ikon yang benar.
//
// Berjalan di Windows/Linux/macOS karena murni JS. Bila gagal, build dihentikan dengan pesan jelas (bukan diam-diam memakai ikon Electron).
const fs = require('fs');
const path = require('path');

const ICON = path.join(__dirname, '..', 'build', 'icon.ico');

async function embed(exePath, { productName, description, company, copyright, version, internalName, originalName }, iconPath) {
  const R = await import('resedit');
  const ResEdit = R.NtExecutable ? R : R.default;
  if (!ResEdit || !ResEdit.NtExecutable) throw new Error('library resedit tidak termuat (jalankan npm install)');

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);

  // 1) ikon: ganti semua grup ikon yang ada (Electron punya satu) dengan frame dari icon.ico
  const icoFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) throw new Error('exe tidak punya grup ikon untuk diganti');
  for (const g of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icoFile.icons.map((i) => i.data));
  }

  // 2) info versi (yang tampil di Properties > Details dan Task Manager)
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!vis.length) throw new Error('exe tidak punya resource versi');
  const vi = vis[0];
  const strings = {
    ProductName: productName,
    FileDescription: description || productName,
    CompanyName: company,
    LegalCopyright: copyright,
    InternalName: internalName,
    OriginalFilename: originalName,
  };
  for (const k of Object.keys(strings)) if (strings[k] == null || strings[k] === '') delete strings[k];
  for (const lang of vi.getAllLanguagesForStringValues()) vi.setStringValues(lang, strings);
  const parts = String(version || '0.0.0').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  vi.setFileVersion(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0, vi.lang);
  vi.setProductVersion(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0, vi.lang);
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

exports.embed = embed;

// Titik masuk electron-builder: context = { appOutDir, electronPlatformName, packager }
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const info = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, info.productFilename + '.exe');
  if (!fs.existsSync(exePath)) throw new Error('[ikon] ' + exePath + ' tidak ditemukan');
  if (!fs.existsSync(ICON)) throw new Error('[ikon] ' + ICON + ' tidak ditemukan');
  try {
    await embed(exePath, {
      productName: info.productName,
      description: info.description,
      company: info.companyName,
      copyright: info.copyright,
      version: info.version,
      internalName: info.productFilename,
      originalName: info.productFilename + '.exe',
    }, ICON);
  } catch (e) {
    throw new Error('[ikon] gagal menanam ikon ke ' + path.basename(exePath) + ': ' + (e && e.message ? e.message : e));
  }
  console.log('  • ikon dan info versi ditanam ke ' + path.basename(exePath));
};
