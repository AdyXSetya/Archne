'use strict';
// Isi Worker PHP (P.2): satu instans php-wasm per situs. Dijalankan lewat worker_threads oleh archne-phppool.js.
// workerData: { www, data, tmp, php:'8.3', ini:{...}, script:'/www/index.php' }
// workerData.sys = folder alat milik aplikasi (P.7a). Isinya DISALIN ke memori /sys (bukan mount), jadi situs tidak bisa mengubah berkas di disk;
// salinan memori itu ditulis ulang dari isi asli sebelum setiap permintaan sys. Hanya pesan dengan sys:true yang boleh menjalankan skrip /sys.
// Pesan masuk : { id, req:{ method, uri, script, headers, body, server }, sys? }
// Pesan keluar: { ready:true, boot } | { id, status, headers:{nama:[nilai]}, body:Uint8Array } | { id, error } | { fatal }
const { parentPort, workerData: W } = require('worker_threads');
const { EventEmitter } = require('events');
const fs = require('fs'), path = require('path');

const INI = Object.assign({ memory_limit: '128M', upload_max_filesize: '64M', post_max_size: '64M', allow_url_fopen: '1', disable_functions: '', display_errors: '0', 'session.save_path': '/data/sessions' }, W.ini || {});

// exec/shell_exec/popen/proc_open: tidak ada proses anak di WASM. Gagal biasa (kode 127), bukan SPAWN_UNSUPPORTED yang menggantung.
function failingSpawn(command) {
  const cp = new EventEmitter(); cp.stdout = new EventEmitter(); cp.stderr = new EventEmitter();
  cp.stdin = Object.assign(new EventEmitter(), { write(_d, _e, cb) { if (cb) cb(null); }, end() {} });
  setImmediate(() => { cp.stderr.emit('data', Buffer.from(String(command) + ': perintah tidak didukung di Archne\n')); cp.emit('exit', 127); cp.emit('close', 127); });
  return cp;
}

(async () => {
  const t0 = Date.now();
  const { PHP } = await import('@php-wasm/universal');
  const { loadNodeRuntime, createNodeFsMountHandler } = await import('@php-wasm/node');
  const php = new PHP(await loadNodeRuntime(W.php || '8.3', { emscriptenOptions: { processId: 1 } }));
  for (const d of ['/www', '/data', '/tmp']) php.mkdir(d);
  await php.mount('/www', createNodeFsMountHandler(W.www));   // baca-tulis (WordPress menulis wp-content/uploads)
  await php.mount('/data', createNodeFsMountHandler(W.data)); // SQLite dan sesi; tidak pernah dilayani
  if (W.tmp) await php.mount('/tmp', createNodeFsMountHandler(W.tmp));
  php.mkdir('/data/sessions');
  await php.setSpawnHandler(failingSpawn);
  const ini = Object.entries(INI).map(([k, v]) => k + '=' + v).join('\n') + '\n';
  php.writeFile('/internal/shared/php.ini', ini);
  const SYS = new Map(); // '/sys/nama.php' -> isi asli dari disk aplikasi
  if (W.sys) {
    for (const f of fs.readdirSync(W.sys)) if (/^[a-z0-9_-]+\.php$/.test(f)) SYS.set('/sys/' + f, fs.readFileSync(path.join(W.sys, f)));
    php.mkdir('/sys');
  }
  const restoreSys = () => { for (const [p, b] of SYS) php.writeFile(p, b); php.writeFile('/internal/shared/php.ini', ini); }; // juga php.ini: situs tidak boleh menyisipkan auto_prepend_file
  restoreSys();
  parentPort.postMessage({ ready: true, boot: Date.now() - t0 });

  parentPort.on('message', async (m) => {
    if (!m || !m.req) return;
    const r = m.req;
    try {
      const script = r.script || W.script || '/www/index.php';
      const norm = path.posix.normalize('/' + String(script));
      if (m.sys === true) { if (!SYS.has(script)) throw new Error('skrip sys tidak dikenal'); restoreSys(); }
      else if (/^\/sys(\/|$)/i.test(norm)) throw new Error('jalur /sys hanya untuk host');
      const res = await php.runStream({ scriptPath: script, method: r.method || 'GET', relativeUri: r.uri || '/', headers: r.headers || {}, body: r.body, $_SERVER: r.server || {} });
      // Fatal error PHP = exit code != 0 tetapi tetap jawaban HTTP, bukan Worker mati.
      const body = new Uint8Array(await res.stdoutBytes);
      let status = await res.httpStatusCode; const headers = await res.headers;
      const code = await res.exitCode;
      if (code !== 0 && !body.length) status = 500;
      parentPort.postMessage({ id: m.id, status, headers, body }, [body.buffer]);
    } catch (e) { parentPort.postMessage({ id: m.id, error: String((e && e.stack) || e).slice(0, 1500) }); }
  });
})().catch((e) => parentPort.postMessage({ fatal: String((e && e.stack) || e).slice(0, 1500) }));
