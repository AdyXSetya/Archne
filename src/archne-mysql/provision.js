'use strict';
// Fase 5d: menyiapkan database MySQL palsu SEBELUM PHP/server pernah jalan: membuat data/mysql.sqlite kosong dan menetapkan port di <situs>/mysql.json.
// Tidak menyalakan server MySQL dan tidak membuat Worker. Idempoten: berkas/port yang sudah sah tidak pernah ditimpa.
// Hasil: { created:boolean, hasDb:true, hasInfo:true, port } ; created=true bila mysql.sqlite baru dibuat pada panggilan ini.
// Galat (code): NOMYSQL (node:sqlite tak ada), BADDB (mysql.sqlite ada tapi bukan berkas SQLite biasa), EIO (gagal menulis).
const fs = require('fs'), path = require('path'), net = require('net'), crypto = require('crypto');
const uniq = () => process.pid + '-' + crypto.randomBytes(4).toString('hex');

const okPort = (n) => Number.isInteger(n) && n > 1023 && n < 65536;
const err = (code, msg) => Object.assign(new Error(msg), { code });

function readPort(stateFile) { try { const n = JSON.parse(fs.readFileSync(stateFile, 'utf8')).port; return okPort(n) ? n : 0; } catch { return 0; } }
function hasMagic(f) {
  let fd; try { fd = fs.openSync(f, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); return b.toString('latin1') === 'SQLite format 3\0'; } catch { return false; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
// Port bebas dari OS (loopback saja). Bila nanti terpakai saat server dinyalakan, Worker sudah punya jalan keluar (EADDRINUSE -> port lain, mysql.json ditulis ulang).
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function writeJsonAtomic(file, obj) { const t = file + '.tmp-' + uniq(); fs.writeFileSync(t, JSON.stringify(obj)); try { fs.renameSync(t, file); } catch (e) { try { fs.unlinkSync(t); } catch {} throw e; } }

// dataDir = folder data/ situs (sama seperti createMysqlHost.start).
async function provisionMysql(dataDir) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { throw err('NOMYSQL', 'node:sqlite tidak tersedia di perangkat ini.'); }
  const dbFile = path.join(dataDir, 'mysql.sqlite'), stateFile = path.join(path.dirname(dataDir), 'mysql.json');
  let created = false;
  try {
    let st = null; try { st = fs.lstatSync(dbFile); } catch {}
    if (st) { if (!st.isFile() || (st.size > 0 && !hasMagic(dbFile))) throw err('BADDB', 'mysql.sqlite bukan berkas SQLite biasa.'); }
    if (!st || st.size === 0) {
      // Dibuat di berkas sementara lalu dipindah: pembaca lain tak pernah melihat berkas setengah jadi. WAL dinyalakan supaya berkas langsung berkepala SQLite.
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = dbFile + '.new-' + uniq();
      try { fs.unlinkSync(tmp); } catch {}
      const d = new DatabaseSync(tmp);
      try { d.exec('PRAGMA journal_mode=WAL'); } finally { d.close(); }
      try { fs.unlinkSync(tmp + '-wal'); } catch {} try { fs.unlinkSync(tmp + '-shm'); } catch {}
      if (!hasMagic(tmp)) { try { fs.unlinkSync(tmp); } catch {} throw err('EIO', 'Gagal membuat mysql.sqlite.'); }
      fs.renameSync(tmp, dbFile);
      created = true;
    }
    let port = readPort(stateFile);
    if (!port) { port = await freePort(); writeJsonAtomic(stateFile, { port }); }
    return { created, hasDb: true, hasInfo: true, port };
  } catch (e) {
    if (e && e.code && /^(NOMYSQL|BADDB|EIO)$/.test(e.code)) throw e;
    throw err('EIO', 'Gagal menyiapkan database MySQL: ' + String((e && e.message) || e).slice(0, 200));
  }
}
module.exports = { provisionMysql };
