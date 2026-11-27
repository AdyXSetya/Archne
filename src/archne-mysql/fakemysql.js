'use strict';
// P.9 langkah 3: fakemysql.js — lapisan protokol MySQL wire di atas Engine (mysql2sqlite + node:sqlite).
// Murni protokol; seluruh terjemahan SQL ada di engine.js / mysql2sqlite.js.
const net = require('net'), crypto = require('crypto');
const { Engine, typeCode, mapError } = require('./engine.js');

const sha1 = (...b) => crypto.createHash('sha1').update(Buffer.concat(b.map(x => Buffer.from(x)))).digest();
const lenenc = (n) => n < 251 ? Buffer.from([n]) : n < 65536 ? Buffer.from([0xfc, n & 255, n >> 8]) : Buffer.from([0xfd, n & 255, (n >> 8) & 255, n >> 16]);
const lstr = (v) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8'); return Buffer.concat([lenenc(b.length), b]); };
const u16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
const u32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]);

function startFakeMysql({ file = ':memory:', user = 'archne', password, port = 0, host = '127.0.0.1', lockWaitMs = 5000, txMode = 'immediate' } = {}) {
  // 6c-11: satu Engine (satu koneksi SQLite, WAL) PER koneksi MySQL di atas file yang sama → transaksi, savepoint, @var,
  // LAST_INSERT_ID, ROW_COUNT dan prepared statement terisolasi seperti MySQL. ':memory:' tidak bisa dibagi antar koneksi,
  // jadi diganti file sementara. `engine` yang dikembalikan = koneksi admin tersendiri (untuk tes/introspeksi).
  let tmpDir = null;
  if (file === ':memory:') { tmpDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'archne-shim-')); file = require('path').join(tmpDir, 'db.sqlite'); }
  const engine = new Engine({ file });
  const conns = new Set();
  // Coba ulang SATU pernyataan yang gagal karena kunci tulis koneksi lain (SQLITE_BUSY, errcode 5) tanpa memblokir event loop,
  // sampai lockWaitMs (setara innodb_lock_wait_timeout; MySQL asli 50 dtk). Pernyataan yang gagal karena kunci belum mengubah apa pun.
  const isBusy = (e) => e && e.errcode === 5;
  // Penunggu dibangunkan setiap kali SEBUAH perintah (COMMIT/ROLLBACK/autocommit) selesai atau koneksi putus: serah-terima kunci
  // langsung, tanpa polling. Batas 25 ms hanya jaring pengaman (mis. kunci dilepas lewat jalur yang tak lewat antrean).
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
  const waitWake = (ms) => new Promise(r => { const t = setTimeout(r, ms); waiters.push(() => { clearTimeout(t); r(); }); });
  async function withLockRetry(fn, sock) {
    const t0 = Date.now();
    for (;;) {
      try { return fn(); }
      catch (e) { if (!isBusy(e) || sock.destroyed || Date.now() - t0 >= lockWaitMs) throw e; }
      await waitWake(25);
    }
  }
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);   // seperti mysqld: tanpa ini result set (banyak paket kecil) kena Nagle + delayed ACK ~40 ms per kueri
    const engine = new Engine({ file, busyTimeout: 0, txMode }); conns.add(engine);   // busyTimeout 0: node:sqlite sinkron, menunggu di dalam SQLite akan membekukan SEMUA koneksi; tunggu dilakukan asinkron (withLockRetry)   // bayangan: semua `engine` di bawah = milik koneksi ini
    sock.on('close', () => { conns.delete(engine); try { engine.db.close(); } catch (_) {} wake(); });
    let buf = Buffer.alloc(0), seq = 0, authed = false, connId = (Math.random() * 1e6) | 0;
    const scramble = crypto.randomBytes(20);
    const send = (payload) => { sock.write(Buffer.concat([Buffer.from([payload.length & 255, (payload.length >> 8) & 255, payload.length >> 16, seq++ & 255]), payload])); };
    let more = false; // SERVER_MORE_RESULTS_EXISTS untuk multi-statement
    const st = () => (engine._inTx ? 3 : 2) | (more ? 8 : 0);
    const ok = (affected = 0, insertId = 0) => send(Buffer.concat([Buffer.from([0]), lenenc(affected), lenenc(insertId), u16(st()), u16(0)]));
    const err = (code, state, msg) => send(Buffer.concat([Buffer.from([0xff]), u16(code), Buffer.from('#' + state), Buffer.from(msg, 'utf8')]));
    const eof = () => send(Buffer.concat([Buffer.from([0xfe]), u16(0), u16(st())]));

    // Handshake V10
    const caps = 0x1 | 0x2 | 0x4 | 0x8 | 0x200 | 0x2000 | 0x8000 | 0x10000 | 0x20000 | 0x80000;
    send(Buffer.concat([Buffer.from([0x0a]), Buffer.from('8.0.36-archne-sqlite\0'), u32(connId), scramble.subarray(0, 8), Buffer.from([0]),
      u16(caps & 0xffff), Buffer.from([33]), u16(2), u16(caps >>> 16), Buffer.from([21]), Buffer.alloc(10), scramble.subarray(8, 20), Buffer.from([0]),
      Buffer.from('mysql_native_password\0')]));

    function sendResultSet(result) {
      const { cols, rows } = result;
      send(lenenc(cols.length));
      for (const c of cols) {
        const nm = Buffer.from(c.name ?? '', 'utf8');
        send(Buffer.concat([lstr('def'), lstr(''), lstr(''), lstr(''), nm.length <= 251 ? lstr(c.name ?? '') : lstr(c.name ?? ''),
          lstr(c.name ?? ''), Buffer.from([0x0c]), u16(33), u32(1 << 20), Buffer.from([c.decimals == null ? 0xfd : 0xf6]), u16(0), Buffer.from([c.decimals ?? 0]), u16(0)]));
      }
      eof();
      for (const row of rows) {
        const parts = (Array.isArray(row) ? row : Object.values(row)).map(v =>
          v === null || v === undefined ? Buffer.from([0xfb]) : lstr(typeof v === 'bigint' ? v.toString() : v));
        send(Buffer.concat(parts));
      }
      eof();
    }

    function sendBinaryResultSet(result) {
      const { cols, rows } = result;
      send(lenenc(cols.length));
      const tys = [];
      for (const c of cols) {
        // tentukan tipe dari baris pertama
        const sample = rows.length ? (Array.isArray(rows[0]) ? rows[0][tys.length] : Object.values(rows[0])[tys.length]) : undefined;
        const ty = c.decimals == null ? typeCode(sample) : 0xf6;   // NEWDECIMAL: nilai dikirim sebagai teks
        tys.push(ty);
        send(Buffer.concat([lstr('def'), lstr(''), lstr(''), lstr(''), lstr(c.name ?? ''), lstr(c.name ?? ''),
          Buffer.from([0x0c]), u16(ty === 0xfc ? 63 : 33), u32(1 << 20), Buffer.from([ty]), u16(0), Buffer.from([c.decimals ?? 0]), u16(0)]));
      }
      eof();
      for (const row of rows) {
        const vals = Array.isArray(row) ? row : Object.values(row);
        const bm = Buffer.alloc((cols.length + 9) >> 3);
        const parts = [];
        vals.forEach((v, i) => {
          if (v === null || v === undefined) { bm[(i + 2) >> 3] |= 1 << ((i + 2) & 7); return; }
          const ty = tys[i];
          if (ty === 0x08) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(typeof v === 'bigint' ? v : Math.trunc(Number(v)))); parts.push(b); }
          else if (ty === 0x05) { const b = Buffer.alloc(8); b.writeDoubleLE(Number(v)); parts.push(b); }
          else parts.push(lstr(Buffer.isBuffer(v) ? v : String(v)));
        });
        send(Buffer.concat([Buffer.from([0]), bm, ...parts]));
      }
      eof();
    }

    async function runQuery(sql) {
      const stmts = engine.split(sql);
      if (!stmts.length) { more = false; return ok(); }
      try {
        for (let k = 0; k < stmts.length; k++) {
          more = k < stmts.length - 1;
          const result = await withLockRetry(() => engine.query(stmts[k]), sock);
          if (result.type === 'rows') sendResultSet(result); else ok(result.changes, result.lastId);
        }
      } finally { more = false; }
    }

    async function packet(p) {
      if (!authed) {
        const flags = p.readUInt32LE(0); let o = 32;
        const e = p.indexOf(0, o); const u = p.toString('utf8', o, e); o = e + 1;
        const al = p[o++]; const auth = p.subarray(o, o + al);
        let good = user == null || u === user;   // user null = terima nama pengguna apa pun (seperti Laragon: root tanpa kata sandi, hanya loopback)
        if (good && password) {
          const h1 = sha1(password), h2 = sha1(h1), x = sha1(scramble, h2);
          const exp = Buffer.from(h1.map((b, i) => b ^ x[i]));
          good = auth.length === 20 && crypto.timingSafeEqual(auth, exp);
        }
        if (!good) { err(1045, '28000', `Access denied for user '${u}'`); return sock.end(); }
        authed = true; return ok();
      }
      const cmd = p[0];
      try {
        if (cmd === 0x03) return await runQuery(p.toString("utf8", 1));
        if (cmd === 0x16) {
          const { id, cols, np } = engine.prepare(p.toString('utf8', 1));
          send(Buffer.concat([Buffer.from([0]), u32(id), u16(cols.length), u16(np), Buffer.from([0]), u16(0)]));
          if (np) { for (let i = 0; i < np; i++) send(Buffer.concat([lstr('def'),lstr(''),lstr(''),lstr(''),lstr('?'),lstr('?'),Buffer.from([0x0c]),u16(33),u32(1<<20),Buffer.from([0xfd]),u16(0),Buffer.from([0]),u16(0)])); eof(); }
          if (cols.length) { for (const c of cols) send(Buffer.concat([lstr('def'),lstr(''),lstr(''),lstr(''),lstr(c.name??''),lstr(c.name??''),Buffer.from([0x0c]),u16(33),u32(1<<20),Buffer.from([0xfd]),u16(0),Buffer.from([0]),u16(0)])); eof(); }
          return;
        }
        if (cmd === 0x17) {
          const id = p.readUInt32LE(1);
          const S = engine._stmts.get(id);
          if (!S) return err(1243, 'HY000', 'Unknown prepared statement handler');
          let o = 10; const params = [];
          if (S.np) {
            const nb = (S.np + 7) >> 3, bm = p.subarray(o, o + nb); o += nb;
            const bound = p[o++];
            // new_params_bound=0: klien (mysqlnd) tidak mengirim ulang tipe pada execute() berikutnya; pakai tipe yang tersimpan.
            let types; if (bound === 1) { types = []; for (let i = 0; i < S.np; i++) { types.push(p[o]); o += 2; } S.ptypes = types; } else types = S.ptypes || new Array(S.np).fill(0xfd);
            const rl = () => { const f = p[o++]; if (f < 251) return f; if (f === 0xfc) { const v = p.readUInt16LE(o); o += 2; return v; } if (f === 0xfd) { const v = p[o]|(p[o+1]<<8)|(p[o+2]<<16); o+=3; return v; } const v=Number(p.readBigUInt64LE(o));o+=8;return v;};
            for (let i = 0; i < S.np; i++) {
              if (bm[i >> 3] & (1 << (i & 7))) { params.push(null); continue; }
              const t = types[i];
              if (t===0x01){params.push(p.readInt8(o));o+=1;}
              else if(t===0x02){params.push(p.readInt16LE(o));o+=2;}
              else if(t===0x03){params.push(p.readInt32LE(o));o+=4;}
              else if(t===0x08){params.push(Number(p.readBigInt64LE(o)));o+=8;}
              else if(t===0x04){params.push(p.readFloatLE(o));o+=4;}
              else if(t===0x05){params.push(p.readDoubleLE(o));o+=8;}
              else{const l=rl();params.push(p.toString('utf8',o,o+l));o+=l;}
            }
          }
          const result = await withLockRetry(() => engine.execute(id, params), sock);
          if (result.type === 'rows') sendBinaryResultSet(result);
          else ok(result.changes, result.lastId);
          return;
        }
        if (cmd === 0x19) { engine.closeStmt(p.readUInt32LE(1)); seq = 0; return; }
        if (cmd === 0x1b) return eof();  // SET_OPTION (multi-statement on/off)
        if (cmd === 0x0e) return ok();   // PING
        if (cmd === 0x02) return ok();   // INIT_DB
        if (cmd === 0x01) return sock.end(); // QUIT
        return err(1064, '42000', 'Perintah belum didukung: 0x' + cmd.toString(16));
      } catch (e) {
        const me = mapError(e);
        return err(me.errno ?? 1105, me.sqlstate ?? 'HY000', String(me.message).slice(0, 300));
      }
    }

    // perintah satu koneksi diproses berurutan (satu per satu), karena packet() kini asinkron (menunggu kunci)
    const queue = []; let draining = false;
    async function drain() {
      if (draining) return; draining = true;
      try { while (queue.length && !sock.destroyed) { const q = queue.shift(); seq = q.seq; try { await packet(q.p); } catch (e) { try { sock.destroy(); } catch (_) {} } wake(); } }
      finally { draining = false; }
    }
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf[0] | (buf[1] << 8) | (buf[2] << 16);
        if (buf.length < 4 + len) break;
        queue.push({ seq: (buf[3] + 1) & 255, p: buf.subarray(4, 4 + len) }); buf = buf.subarray(4 + len);
      }
      drain();
    });
    sock.on('error', () => {});
  });
  server.on('close', () => { for (const c of conns) { try { c.db.close(); } catch (_) {} } try { engine.db.close(); } catch (_) {} if (tmpDir) { try { require('fs').rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} } });
  return new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, () => { server.removeListener('error', rej); res({ server, engine, port: server.address().port }); }); });
}

module.exports = { startFakeMysql };
