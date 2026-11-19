'use strict';
// Peluncur Cordova: memanggil API-nya langsung supaya galat ASLI tercetak lengkap (bin/cordova versi 12 menutupinya
// dengan TypeError saat mengisi process.exitCode). Dijalankan dari folder proyek Cordova: node cdv.js prepare android
const path = require('path');
// Tambal hook nodejs-mobile-cordova 0.4.3 saat dimuat (di memori, tanpa mengubah berkas): ia memanggil `new platformAPI()` tanpa argumen,
// padahal cordova-android >= 10 mewajibkan (platform, platformPath) -> ERR_INVALID_ARG_TYPE di path.join(undefined). Hook plugin ini
// jalan di dalam `platform add` (plugin dipasang ulang lalu prepare), sebelum tambalan berkas apa pun sempat dipasang; menambal saat
// dimuat berlaku di semua perintah cordova (platform add, plugin add, prepare, build), apa pun urutannya.
const Module = require('module');
const origCompile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (/nodejs-mobile-cordova[\\/]install[\\/]hooks[\\/]/.test(filename) && content.includes('new platformAPI()')) {
    content = content.split('new platformAPI()').join("new platformAPI('android', platformPath)");
  }
  return origCompile.call(this, content, filename);
};
const cli = require(path.join(process.cwd(), 'node_modules', 'cordova', 'src', 'cli.js'));
const fail = (e) => {
  console.error('CORDOVA ERROR:');
  console.error((e && e.stack) || e);
  if (e && e.cause) console.error('cause:', (e.cause && e.cause.stack) || e.cause);
  process.exit(1);
};
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
try { Promise.resolve(cli(['node', 'cordova'].concat(process.argv.slice(2)))).catch(fail); } catch (e) { fail(e); }
