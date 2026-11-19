'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const { Core } = require('../src/archne-core');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archne-udp-'));
const mk = (n) => new Core({ dataDir: path.join(tmp, n), name: n, discoveryPort: 41999, broadcast: ['127.255.255.255', '127.0.0.1'] });
(async () => {
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    if (A.getState().peers.some((p) => p.online) && B.getState().peers.some((p) => p.online)) {
      console.log('UDP discovery OK (' + (Date.now() - t0) + ' ms)'); await A.stop(); await B.stop(); process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('UDP discovery TIDAK terdeteksi di lingkungan ini'); process.exit(1);
})();
