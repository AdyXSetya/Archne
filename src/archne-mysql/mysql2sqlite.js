'use strict';
// P.9 langkah 3: penerjemah dialek MySQL -> SQLite berbasis token.
// Murni (tanpa akses DB): tokenizer, pohon kurung, penulis ulang ekspresi,
// penerjemah SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/ALTER TABLE.
// engine.js mengeksekusi hasil terjemahan terhadap node:sqlite.

const { canonicalType, marker } = require('./mytypes.js');
class SqlError extends Error {
  constructor(code, state, msg) { super(msg); this.errno = code; this.sqlstate = state; }
}

const unsupported = (what) => new SqlError(1235, '42000', `Belum didukung oleh shim: ${what}`);

// ---------- tokenizer ----------
const HEX_RE = /[0-9a-fA-F]+/y, BIN_RE = /[01]+/y;   // sticky: tidak mengiris string sumber
const ESC = { '0': '\0', n: '\n', r: '\r', t: '\t', b: '\b', Z: '\x1a' };
function tokenize(src) {
  const toks = []; let i = 0, pre = '', cond = 0, bin = false;
  const push = (t, v, extra) => { toks.push(Object.assign({ t, v, pre }, t === 'str' && bin ? { bin: true } : null, extra)); pre = ''; bin = false; };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { pre += c; i++; continue; }
    if (c === '#' || (c === '-' && src[i + 1] === '-' && (i + 2 >= src.length || /\s/.test(src[i + 2])))) {
      while (i < src.length && src[i] !== '\n') i++; pre += ' '; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      if (src[i + 2] === '!') { i += 3; while (/\d/.test(src[i])) i++; cond++; continue; }
      const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; pre += ' '; continue;
    }
    if (c === '*' && src[i + 1] === '/') { cond--; i += 2; continue; }
    if (c === '`') {
      let v = ''; i++;
      for (;;) {
        if (i >= src.length) throw new SqlError(1064, '42000', 'Tanda kutip backtick tidak ditutup');
        const d = src[i];
        if (d === '`' && i + 1 < src.length && src[i + 1] === '`') { v += '`'; i += 2; continue; }
        if (d === '`') { i++; break; }
        v += d; i++;
      }
      push('id', v); continue;
    }
    if (c === '"' || c === "'") {
      const q = c; let v = ''; i++;
      for (;;) {
        if (i >= src.length) throw new SqlError(1064, '42000', 'Tanda kutip string tidak ditutup');
        const d = src[i];
        if (d === q && src[i + 1] === q) { v += q; i += 2; continue; }
        if (d === q) { i++; break; }
        if (d === '\\') {
          const e = src[i + 1]; i += 2;
          if (e === '%' || e === '_') { v += '\\' + e; continue; }   // MySQL: \% dan \_ tetap berpasangan (dipakai LIKE), di luar LIKE juga tetap dua karakter
          v += ESC[e] ?? e; continue;
        }
        v += d; i++;
      }
      push(q === "'" ? 'str' : 'id', v); continue;
    }
    // Literal biner. 0x.. / X'..' = string biner (BLOB), b'..' / 0b.. = bilangan (kolom BIT disimpan sebagai integer).
    // SQLite membaca 0x.. sebagai integer (maks 16 digit), jadi tanpa ini data biner rusak diam-diam atau impor gagal.
    {
      const idc = (ch) => ch !== undefined && /[a-zA-Z0-9_\u0080-\uffff]/.test(ch);
      let m;
      if ((c === 'x' || c === 'X' || c === 'b' || c === 'B') && src[i + 1] === "'") {
        const q = src.indexOf("'", i + 2), body = q < 0 ? null : src.slice(i + 2, q), isHex = c === 'x' || c === 'X';
        if (body !== null && (isHex ? /^[0-9a-fA-F]*$/ : /^[01]*$/).test(body)) {
          i = q + 1;
          if (isHex) push('hex', body); else push('num', BigInt('0b' + (body || '0')).toString());
          continue;
        }
      }
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X') && (m = (HEX_RE.lastIndex = i + 2, HEX_RE.exec(src))) && !idc(src[i + 2 + m[0].length])) {
        // angka bila dipakai di operasi aritmetika/bit dan muat 64-bit; selain itu string biner
        const OPS = ['&', '|', '^', '~', '+', '-', '*', '/', '%', '<<', '>>'], j0 = i + 2 + m[0].length;
        let j = j0; while (j < src.length && /\s/.test(src[j])) j++;
        const nx = src.slice(j, j + 2), after = OPS.includes(nx) ? nx : OPS.includes(src[j]) && !(src[j] === '-' && src[j + 1] === '-') && !(src[j] === '/' && src[j + 1] === '*') ? src[j] : null;
        const pv = toks[toks.length - 1], before = pv && pv.t === 'op' && OPS.includes(pv.v) && !(pv.v === '-' && (toks.length < 2 || toks[toks.length - 2].t === 'op'));
        i = j0; push('hex', m[0], { num: m[0].length <= 16 && !!(after || before) }); continue;
      }
      if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B') && (m = (BIN_RE.lastIndex = i + 2, BIN_RE.exec(src))) && !idc(src[i + 2 + m[0].length])) {
        i += 2 + m[0].length; push('num', BigInt('0b' + m[0]).toString()); continue;
      }
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1]))) {
      let v = ''; while (i < src.length && /[\d.eE+\-xXa-fA-F]/.test(src[i])) { v += src[i++]; }
      push('num', v); continue;
    }
    if (/[a-zA-Z_\u0080-\uffff]/.test(c)) {
      let v = ''; while (i < src.length && /[a-zA-Z0-9_\u0080-\uffff]/.test(src[i])) { v += src[i++]; }
      // pengenal charset (_binary 'ab', _utf8mb4 'x', _binary X'ff'): dibuang; _binary menandai string sebagai BLOB
      if (/^_[a-zA-Z][a-zA-Z0-9]*$/.test(v) && /^\s*(?:'|[xX]'|0[xX][0-9a-fA-F])/.test(src.slice(i, i + 4))) { bin = v.toLowerCase() === '_binary'; continue; }
      push('kw', v); continue;
    }
    if (c === '@') {
      i++; let v = '@';
      if (src[i] === '@') { v = '@@'; i++; }
      while (i < src.length && /[a-zA-Z0-9_.]/.test(src[i])) { v += src[i++]; }
      push('kw', v); continue;
    }
    // operator / simbol
    const two = src.slice(i, i + 2);
    if (['<>', '<=', '>=', '!=', ':=', '&&', '||', '<<', '>>', '->'].includes(two)) { push('op', two); i += 2; continue; }
    push('op', c); i++;
  }
  return toks;
}

// ---------- utilitas token ----------
const kwUp = (t) => t.t === 'kw' ? t.v.toUpperCase() : null;
const isKw = (t, ...kws) => t.t === 'kw' && kws.some(k => t.v.toUpperCase() === k);

// ubah token menjadi teks SQL SQLite
function emitTok(t) {
  if (t.t === 'id') return '"' + t.v.replace(/"/g, '""') + '"';
  if (t.t === 'str' && t.bin) return "X'" + Buffer.from(t.v, 'utf8').toString('hex') + "'";
  if (t.t === 'str') return "'" + t.v.replace(/'/g, "''") + "'";
  if (t.t === 'num' || t.t === 'op') return t.v;
  if (t.t === 'hex') return t.num ? '0x' + t.v : "X'" + (t.v.length % 2 ? '0' : '') + t.v + "'";
  return t.v; // kw, dsb.
}

// ---------- penulis ulang ekspresi ----------
// args: irisan token (satu ekspresi, bisa mengandung subkueri)
let _ft = null;    // referensi MATCH ... AGAINST dalam pernyataan ini (kunci 'kualifier|kol1,kol2'), untuk validasi + statistik di engine
let _pre = null;   // pernyataan yang harus dijalankan sebelum query utama (inisialisasi variabel sesi)
function rewriteExpr(toks) {
  // tangani dalam sekali jalan, kembalikan string
  const out = []; let i = 0;
  const peek = (n = 0) => toks[i + n];
  const next = () => toks[i++];

  while (i < toks.length) {
    const t = peek(); const lead = t.pre || '';

    // (SELECT @v := konstanta[, ...]) → dijalankan lebih dulu, diganti (SELECT 1). SQLite membuang kolom
    // co-routine yang tak dipakai sehingga inisialisasi tidak akan pernah berjalan.
    if (_pre && t.t === 'op' && t.v === '(' && isKw(peek(1) ?? {}, 'SELECT') && /^@[^@]/.test(peek(2)?.v ?? '') && peek(3)?.v === ':=') {
      const n = argLen(toks, i + 1), inner = toks.slice(i + 2, i + 1 + n);
      const constOnly = inner.every(tk => /^@[^@]/.test(tk.v ?? '') || tk.v === ':=' || tk.v === ',' || tk.t === 'num' || tk.t === 'str' || isKw(tk, 'NULL') || (tk.t === 'op' && (tk.v === '-' || tk.v === '+')));
      if (constOnly && toks[i + 1 + n]?.v === ')') {
        _pre.push('SELECT ' + rewriteExpr(inner).trim());
        out.push(lead + '(SELECT 1)'); i += n + 2; continue;
      }
    }
    // variabel sesi: @a → __getvar('a'); @a := expr → __setvar('a', expr)   (6c-6b)
    if (t.t === 'kw' && /^@[^@]/.test(t.v)) {
      const vn = t.v.slice(1).toLowerCase().replace(/'/g, "''");
      if (peek(1)?.v === ':=') {
        const END = ['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'AS', 'WHEN', 'THEN', 'ELSE', 'END', 'INTO', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'CROSS'];
        let j = i + 2, dp = 0;
        for (; j < toks.length; j++) {
          const tk = toks[j];
          if (tk.t === 'op') { if (tk.v === '(') dp++; else if (tk.v === ')') { if (dp === 0) break; dp--; } else if ((tk.v === ',' || tk.v === ';') && dp === 0) break; }
          else if (dp === 0 && tk.t === 'kw' && END.includes(tk.v.toUpperCase())) break;
        }
        out.push(lead + "__setvar('" + vn + "'," + rewriteExpr(toks.slice(i + 2, j)).trim() + ')'); i = j; continue;
      }
      out.push(lead + "__getvar('" + vn + "')"); i++; continue;
    }

    // MATCH(c1,c2) AGAINST(expr [IN NATURAL LANGUAGE MODE | IN BOOLEAN MODE | WITH QUERY EXPANSION]) → __ft_match(label, mode, kunci, expr, c1, c2)   (6c-7)
    if (isKw(t, 'MATCH') && peek(1)?.v === '(') {
      const cn = argLen(toks, i + 2), ag = i + 2 + cn + 1;
      if (isKw(toks[ag] ?? {}, 'AGAINST') && toks[ag + 1]?.v === '(') {
        const cols = splitArgs(toks, i + 2), an = argLen(toks, ag + 2), inner = toks.slice(ag + 2, ag + 2 + an);
        const MOD = ['IN', 'NATURAL', 'LANGUAGE', 'BOOLEAN', 'MODE', 'WITH', 'QUERY', 'EXPANSION'];
        let mi = inner.length, d = 0;
        for (let j = 0; j < inner.length; j++) {
          const x = inner[j];
          if (x.v === '(') d++; else if (x.v === ')') d--;
          else if (d === 0 && isKw(x, 'IN', 'WITH') && inner.slice(j).every(y => y.t === 'kw' && MOD.includes(y.v.toUpperCase()))) { mi = j; break; }
        }
        const tail = inner.slice(mi).map(y => y.v.toUpperCase());
        const mode = tail.includes('BOOLEAN') ? 'BOOL' : tail.includes('EXPANSION') ? 'NLQE' : 'NL';
        let fq = '', fn = [];   // kunci referensi: kualifier pertama + nama kolom (huruf kecil); '' bila ada kolom bukan referensi sederhana
        for (const cc of cols) {
          const lastTok = cc[cc.length - 1];
          if (!lastTok || (lastTok.t !== 'kw' && lastTok.t !== 'id')) { fn = null; break; }
          fn.push(String(lastTok.v).toLowerCase());
          if (!fq && cc.length >= 3 && cc[cc.length - 2].v === '.') fq = String(cc[cc.length - 3].v).toLowerCase();
        }
        const fkey = fn ? (fq + '|' + fn.join(',')).replace(/'/g, "''") : '';
        if (_ft && fkey) _ft.push(fkey);
        const raw = toks.slice(i, ag + 2 + an + 1).map((x, n) => (n ? x.pre : '') + (x.t === 'str' ? "'" + x.v.replace(/'/g, "''") + "'" : x.v)).join('');
        out.push(lead + "__ft_match('" + raw.replace(/'/g, "''") + "','" + mode + "','" + fkey + "'," + rewriteExpr(inner.slice(0, mi)).trim() + ',' + cols.map(c => rewriteExpr(c).trim()).join(',') + ')');
        i = ag + 2 + an + 1; continue;
      }
    }

    // fungsi MySQL → SQLite
    if (t.t === 'kw') {
      const up = t.v.toUpperCase();

      // NOW() → datetime('now')
      if (up === 'NOW' && peek(1)?.v === '(' && peek(2)?.v === ')') {
        out.push(lead + "datetime('now')"); i += 3; continue;
      }
      // SYSDATE() / CURRENT_TIMESTAMP → datetime('now')
      if ((up === 'SYSDATE' || up === 'CURDATE') && peek(1)?.v === '(' && peek(2)?.v === ')') {
        out.push(lead + (up === 'CURDATE' ? "date('now')" : "datetime('now')")); i += 3; continue;
      }
      // IFNULL(a,b) → IFNULL(a,b) [sama, SQLite punya]
      // ISNULL(a) → (a IS NULL)
      if (up === 'ISNULL' && peek(1)?.v === '(') {
        i += 2; const arg = collectUntil(toks, i, ')'); i += arg.length + 1;
        out.push(lead + '(' + rewriteExpr(arg) + ' IS NULL)'); continue;
      }
      // MOD(a,b) → (a%b)
      if (up === 'MOD' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        if (args.length !== 2) throw unsupported('MOD dengan ≠ 2 argumen');
        out.push(lead + '(' + rewriteExpr(args[0]) + '%' + rewriteExpr(args[1]) + ')'); continue;
      }
      // CONCAT(a,b,...) → (a||b||...)
      if (up === 'CONCAT' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        out.push(lead + '(' + args.map(rewriteExpr).join('||') + ')'); continue;
      }
      // COLLATE nama → COLLATE NOCASE (*_ci) / BINARY (*_bin, *_cs) (6c-4)
      if (up === 'COLLATE' && peek(1) && peek(1).t !== 'op') {
        const nm = String(peek(1).v).toLowerCase();
        out.push(lead + ' COLLATE ' + (/(_bin|_cs|^binary)$/.test(nm) ? 'BINARY' : 'NOCASE')); i += 2; continue;
      }
      // BINARY expr → (expr COLLATE BINARY); bukan untuk CAST(x AS BINARY)
      if (up === 'BINARY' && peek(1) && !(i > 0 && isKw(toks[i - 1], 'AS')) && !(peek(1).t === 'op' && peek(1).v !== '(')) {
        let end = i + 1;
        if (toks[end].v === '(') end += 1 + argLen(toks, end + 1) + 1;
        else {
          end++;
          while (toks[end]?.v === '.' && toks[end + 1]) end += 2;
          if (toks[end]?.v === '(') end += 1 + argLen(toks, end + 1) + 1;
        }
        const grp = toks.slice(i + 1, end);
        out.push(lead + '(' + rewriteExpr(grp).trim() + ' COLLATE BINARY)'); i = end; continue;
      }
      // CURRENT_DATE() / CURRENT_TIME() / CURRENT_TIMESTAMP() / LOCALTIME[STAMP]() / UTC_*() (6c-2)
      if (['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP'].includes(up) && peek(1)?.v === '(' && peek(2)?.v === ')') {
        out.push(lead + (up === 'CURRENT_DATE' ? "date('now')" : up === 'CURRENT_TIME' ? 'CURTIME()' : "datetime('now')")); i += 3; continue;
      }
      // TIMESTAMPDIFF(unit, a, b) → TSDIFF('UNIT', a, b)
      if (up === 'TIMESTAMPDIFF' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        if (args.length !== 3 || args[0].length !== 1) throw unsupported('TIMESTAMPDIFF dengan argumen tidak lazim');
        out.push(lead + "TSDIFF('" + args[0][0].v.toUpperCase() + "'," + rewriteExpr(args[1]) + ',' + rewriteExpr(args[2]) + ')'); continue;
      }
      // EXTRACT(unit FROM x) → EXTRACT_('UNIT', x)
      if (up === 'EXTRACT' && peek(1)?.v === '(' && peek(3)?.v?.toUpperCase() === 'FROM') {
        const unit = peek(2).v.toUpperCase(); const n = argLen(toks, i + 2);
        const rest = toks.slice(i + 4, i + 2 + n); i += 2 + n + 1;
        out.push(lead + "EXTRACT_('" + unit + "'," + rewriteExpr(rest) + ')'); continue;
      }
      // INSERT(str,pos,len,new) sebagai fungsi → STR_INSERT
      if (up === 'INSERT' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        out.push(lead + 'STR_INSERT(' + args.map(rewriteExpr).join(',') + ')'); continue;
      }
      // DATE_FORMAT(d, fmt) → strftime(fmt_sqlite, d)
      if (up === 'DATE_FORMAT' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        if (args.length !== 2) throw unsupported('DATE_FORMAT ≠ 2 argumen');
        const fmtTok = args[1][0];
        let fmt = fmtTok?.t === 'str' ? fmtTok.v : rewriteExpr(args[1]);
        // konversi format MySQL → SQLite strftime
        if (fmtTok?.t === 'str') {
          fmt = fmt.replace(/%Y/g, '%Y').replace(/%m/g, '%m').replace(/%d/g, '%d')
                   .replace(/%H/g, '%H').replace(/%i/g, '%M').replace(/%s/g, '%S')
                   .replace(/%y/g, '%y').replace(/%e/g, '%d').replace(/%c/g, '%m');
          out.push(lead + "strftime('" + fmt + "'," + rewriteExpr(args[0]) + ')'); continue;
        }
        out.push(lead + 'strftime(' + rewriteExpr(args[1]) + ',' + rewriteExpr(args[0]) + ')'); continue;
      }
      // YEAR/MONTH/DAY/HOUR/MINUTE/SECOND(d) → strftime('%Y'/... , d)
      const dtParts = { YEAR: '%Y', MONTH: '%m', DAY: '%d', HOUR: '%H', MINUTE: '%M', SECOND: '%S' };
      if (dtParts[up] && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        out.push(lead + "CAST(strftime('" + dtParts[up] + "'," + rewriteExpr(args[0]) + ') AS INTEGER)'); continue;
      }
      // DATEDIFF(a,b) → (julianday(a)-julianday(b))
      if (up === 'DATEDIFF' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        out.push(lead + '(julianday(' + rewriteExpr(args[0]) + ')-julianday(' + rewriteExpr(args[1]) + '))'); continue;
      }
      // SUBSTRING(s,pos) / SUBSTRING(s,pos,len) → substr(s,pos[,len])
      if ((up === 'SUBSTRING' || up === 'SUBSTR' || up === 'MID') && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        out.push(lead + 'substr(' + args.map(rewriteExpr).join(',') + ')'); continue;
      }
      // LPAD(s,n,p) / RPAD → SQLite tidak punya; implementasi sederhana via printf
      if ((up === 'LPAD' || up === 'RPAD') && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        const [s, n, p] = args.map(rewriteExpr);
        if (up === 'LPAD') out.push(lead + `substr(replace(printf('%'||${n}||'s',''),char(32),${p})||${s},-(${n}))`);
        else out.push(lead + `substr(${s}||replace(printf('%'||${n}||'s',''),char(32),${p}),1,${n})`);
        continue;
      }
      // FIELD(v,a,b,...) → CASE WHEN v=a THEN 1 WHEN v=b THEN 2 ... ELSE 0 END
      if (up === 'FIELD' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        const [val, ...opts] = args.map(rewriteExpr);
        const cases = opts.map((o, j) => `WHEN ${val}=${o} THEN ${j + 1}`).join(' ');
        out.push(lead + `(CASE ${cases} ELSE 0 END)`); continue;
      }
      // GREATEST/LEAST: SQLite tidak punya; MAX(a,b) pakai CASE
      if ((up === 'GREATEST' || up === 'LEAST') && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        const rw = args.map(rewriteExpr);
        const fn = up === 'GREATEST' ? 'max' : 'min';
        // SQLite: max()/min() pada skalar pakai CASE
        if (rw.length === 2) {
          out.push(lead + up === 'GREATEST'
            ? `(CASE WHEN ${rw[0]}>=${rw[1]} THEN ${rw[0]} ELSE ${rw[1]} END)`
            : `(CASE WHEN ${rw[0]}<=${rw[1]} THEN ${rw[0]} ELSE ${rw[1]} END)`);
        } else {
          // ≥3 argumen: bersarang
          let acc = rw[0];
          for (let k = 1; k < rw.length; k++) {
            acc = up === 'GREATEST'
              ? `(CASE WHEN ${acc}>=${rw[k]} THEN ${acc} ELSE ${rw[k]} END)`
              : `(CASE WHEN ${acc}<=${rw[k]} THEN ${acc} ELSE ${rw[k]} END)`;
          }
          out.push(lead + acc);
        }
        continue;
      }
      // CONVERT(val USING charset) → val (abaikan)
      if (up === 'CONVERT' && peek(1)?.v === '(') {
        i += 2; const inner = collectUntil(toks, i, ')'); i += inner.length + 1;
        const usingIdx = inner.findIndex(x => isKw(x, 'USING'));
        if (usingIdx >= 0) { out.push(lead + rewriteExpr(inner.slice(0, usingIdx))); continue; }
        const cparts = splitTop(inner);
        if (cparts.length === 2) { out.push(lead + castExpr(rewriteExpr(cparts[0]), cparts[1].map(x => x.v).join(' ').toUpperCase())); continue; }
        out.push(lead + 'CONVERT(' + rewriteExpr(inner) + ')'); continue;
      }
      // CAST(x AS tipe) → CAST(x AS tipe_sqlite)
      if (up === 'CAST' && peek(1)?.v === '(') {
        i += 2; const inner = collectUntil(toks, i, ')'); i += inner.length + 1;
        const asIdx = inner.findIndex(x => isKw(x, 'AS'));
        if (asIdx >= 0) {
          const val = rewriteExpr(inner.slice(0, asIdx));
          const typeName = inner.slice(asIdx + 1).map(x => x.v).join(' ').toUpperCase();
          out.push(lead + castExpr(val, typeName)); continue;
        }
        out.push(lead + 'CAST(' + rewriteExpr(inner) + ')'); continue;
      }
      // DATE_ADD/DATE_SUB/ADDDATE/SUBDATE(tgl, INTERVAL n unit)
      if ((up === 'DATE_ADD' || up === 'DATE_SUB' || up === 'ADDDATE' || up === 'SUBDATE') && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        const sign = (up === 'DATE_ADD' || up === 'ADDDATE') ? '+' : '-';
        if (args.length === 2 && isKw(args[1][0], 'INTERVAL') && args[1].length >= 3) {
          const unit = String(args[1][args[1].length - 1].v).toUpperCase();
          out.push(lead + dateShift(rewriteExpr(args[0]).trim(), sign, rewriteExpr(args[1].slice(1, -1)).trim(), unit)); continue;
        }
        if (args.length === 2 && (up === 'ADDDATE' || up === 'SUBDATE')) { out.push(lead + dateShift(rewriteExpr(args[0]).trim(), sign, rewriteExpr(args[1]).trim(), 'DAY')); continue; }
        throw unsupported(up + ' tanpa INTERVAL');
      }
      // GROUP_CONCAT([DISTINCT] expr [ORDER BY ...] [SEPARATOR 'x']) → group_concat(expr, 'x' [ORDER BY ...])
      if (up === 'GROUP_CONCAT' && peek(1)?.v === '(') {
        i += 2; const inner = collectUntil(toks, i, ')'); i += inner.length + 1;
        const sepI = topKw(inner, 'SEPARATOR');
        let body = sepI >= 0 ? inner.slice(0, sepI) : inner;
        const sep = sepI >= 0 ? rewriteExpr(inner.slice(sepI + 1)).trim() : "','";
        let distinct = false;
        if (body[0] && isKw(body[0], 'DISTINCT')) { distinct = true; body = body.slice(1); }
        const ordI = topKw(body, 'ORDER');
        const expr = rewriteExpr(ordI >= 0 ? body.slice(0, ordI) : body).trim();
        const ord = ordI >= 0 ? ' ' + rewriteExpr(body.slice(ordI)).trim() : '';
        if (distinct && sep !== "','") throw unsupported('GROUP_CONCAT DISTINCT dengan SEPARATOR');
        out.push(lead + (distinct ? 'group_concat(DISTINCT ' + expr + ord + ')' : 'group_concat(' + expr + ', ' + sep + ord + ')')); continue;
      }
      // IF(cond,a,b) → CASE WHEN cond THEN a ELSE b END
      if (up === 'IF' && peek(1)?.v === '(') {
        i += 2; const args = splitArgs(toks, i); i += argLen(toks, i) + 1;
        if (args.length !== 3) throw unsupported('IF() dengan ≠ 3 argumen');
        out.push(lead + '(CASE WHEN ' + rewriteExpr(args[0]) + ' THEN ' + rewriteExpr(args[1]) + ' ELSE ' + rewriteExpr(args[2]) + ' END)'); continue;
      }
      // COALESCE / NULLIF / IFNULL → SQLite punya semua
      // GROUP_CONCAT → group_concat (sama)
      // JSON_* → SQLite 3.38+ punya json_*, lewatkan saja
      // DIV (integer division) → /
      if (up === 'DIV') { out.push(lead + '/'); i++; continue; }
      // XOR → (a&~b)|(~a&b) — terlalu rumit, lempar error
      if (up === 'XOR') { throw unsupported('XOR operator'); }
      // INTERVAL → SQLite tidak punya, coba pakai datetime arithmetic
      if (up === 'INTERVAL') {
        // DATE + INTERVAL n UNIT → datetime(date, '+n unit')
        // Tangani di parent, di sini cukup emit keyword
      }
    }

    // backtick identifier sudah jadi 'id', emit sebagai "..."
    if (t.t === 'id') { out.push(lead + emitTok(t)); i++; continue; }
    // string
    if (t.t === 'str') { out.push(emitTok(t)); i++; continue; }
    // operator || MySQL OR → emit as-is (SQLite mendukung ||)
    // Tangani DATE/TIME + INTERVAL sederhana
    if (t.t === 'op' && (t.v === '+' || t.v === '-') && peek(1) && isKw(peek(1), 'INTERVAL') && out.length) {
      const sign = t.v;
      i++; i++; // lewati operator dan INTERVAL
      const numTok = toks[i++];
      const unitTok = toks[i++];
      const unit = unitTok?.v?.toUpperCase() ?? '';
      const unitMap = { DAY: 'days', HOUR: 'hours', MINUTE: 'minutes', SECOND: 'seconds', MONTH: 'months', YEAR: 'years', WEEK: 'days' };
      const prev = out.pop(); const ws = /^\s*/.exec(prev)[0];
      const n = unit === 'WEEK' ? '(' + emitTok(numTok) + '*7)' : emitTok(numTok);
      out.push(ws + "datetime(" + prev.trim() + ",'" + sign + "'||" + n + "||' " + (unitMap[unit] || unit.toLowerCase()) + "')");
      continue;
    }

    // default: emit apa adanya
    out.push(t.pre + emitTok(t)); i++;
  }
  return out.join('');
}

// kumpulkan token sampai karakter penutup (menghitung parentesis bersarang)
function collectUntil(toks, start, close) {
  const result = []; let depth = 0; let i = start;
  while (i < toks.length) {
    const t = toks[i];
    if (t.v === '(' || t.v === '[') { depth++; result.push(t); i++; continue; }
    if (t.v === ')' || t.v === ']') {
      if (depth === 0) break;
      depth--; result.push(t); i++; continue;
    }
    result.push(t); i++;
  }
  return result;
}

// hitung berapa token sampai penutup ')' (untuk maju indeks)
function argLen(toks, start) {
  return collectUntil(toks, start, ')').length;
}

// pisahkan argumen pada koma teratas
function splitArgs(toks, start) {
  const inner = collectUntil(toks, start, ')');
  const args = []; let cur = []; let depth = 0;
  for (const t of inner) {
    if (t.v === '(' || t.v === '[') { depth++; cur.push(t); continue; }
    if (t.v === ')' || t.v === ']') { depth--; cur.push(t); continue; }
    if (t.v === ',' && depth === 0) { args.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) args.push(cur);
  return args;
}

// pisahkan pada koma teratas dari irisan token (tanpa penutup)
function splitTop(inner) {
  const args = []; let cur = []; let d = 0;
  for (const t of inner) {
    if (t.v === '(' || t.v === '[') d++; else if (t.v === ')' || t.v === ']') d--;
    if (t.v === ',' && d === 0 && t.t === 'op') { args.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) args.push(cur);
  return args;
}
// indeks keyword pada kedalaman 0 (atau -1)
function topKw(arr, name) {
  let d = 0;
  for (let k = 0; k < arr.length; k++) {
    const x = arr[k];
    if (x.v === '(') d++; else if (x.v === ')') d--;
    else if (d === 0 && x.t === 'kw' && String(x.v).toUpperCase() === name) return k;
  }
  return -1;
}
const DATE_UNITS = { DAY: ['days', 1], WEEK: ['days', 7], MONTH: ['months', 1], QUARTER: ['months', 3], YEAR: ['years', 1], HOUR: ['hours', 1], MINUTE: ['minutes', 1], SECOND: ['seconds', 1] };
function dateShift(base, sign, n, unit) {
  const u = DATE_UNITS[unit]; if (!u) throw unsupported('INTERVAL satuan ' + unit);
  const amt = (sign === '-' ? '-' : '') + '((' + n + ')' + (u[1] === 1 ? '' : '*' + u[1]) + ')';
  const dateOnly = /^(date\('now'\)|'\d{4}-\d\d-\d\d')$/i.test(base) && ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(unit);
  return (dateOnly ? 'date(' : 'datetime(') + base + ", printf('%+d " + u[0] + "', " + amt + '))';
}

// UPDATE t [AS a] JOIN u ON cond SET a.c = ... [WHERE ...]  →  UPDATE t AS a SET c = ... FROM u WHERE (cond) AND (...)
function translateUpdateJoin(toks) {
  let d = 0, setI = -1, joinI = -1, commaI = -1;
  const JOINS = /^(JOIN|INNER|CROSS|LEFT|RIGHT|STRAIGHT_JOIN)$/;
  for (let j = 1; j < toks.length; j++) {
    const tk = toks[j];
    if (tk.t === 'op') { if (tk.v === '(') d++; else if (tk.v === ')') d--; else if (d === 0 && tk.v === ',' && joinI < 0 && commaI < 0) commaI = j; continue; }
    if (d !== 0 || tk.t !== 'kw') continue;
    const u = tk.v.toUpperCase();
    if (u === 'SET') { setI = j; break; }
    if (joinI < 0 && JOINS.test(u)) joinI = j;
  }
  if (setI < 0 || (joinI < 0 && commaI < 0)) return null;
  const cut = joinI >= 0 ? joinI : commaI;
  let head = toks.slice(1, cut); const jt = toks.slice(cut, setI);
  if (head.length === 2 && !isKw(head[1], 'AS')) head = [head[0], { t: 'kw', v: 'AS', pre: ' ' }, { ...head[1], pre: ' ' }];   // SQLite UPDATE wajib `AS` untuk alias
  let fromToks, onCond = [];
  if (joinI >= 0) {
    if (/^(LEFT|RIGHT)$/i.test(toks[joinI].v)) throw unsupported('UPDATE ... LEFT/RIGHT JOIN');
    let k = 0; while (k < jt.length && /^(INNER|CROSS|JOIN|STRAIGHT_JOIN)$/i.test(jt[k].v)) k++;
    const rest = jt.slice(k);
    let dd = 0, onI = -1, endI = rest.length;
    for (let j = 0; j < rest.length; j++) {
      const tk = rest[j];
      if (tk.t === 'op') { if (tk.v === '(') dd++; else if (tk.v === ')') dd--; continue; }
      if (dd !== 0 || tk.t !== 'kw') continue;
      const u = tk.v.toUpperCase();
      if (onI < 0 && u === 'ON') onI = j;
      else if (onI >= 0 && JOINS.test(u)) { endI = j; break; }
    }
    if (onI >= 0) { fromToks = rest.slice(0, onI).concat(rest.slice(endI)); onCond = rest.slice(onI + 1, endI); } else fromToks = rest;
  } else fromToks = jt.slice(1);
  let e = toks.length, whereI = -1, d2 = 0;
  for (let j = setI + 1; j < toks.length; j++) {
    const tk = toks[j];
    if (tk.t === 'op') { if (tk.v === '(') d2++; else if (tk.v === ')') d2--; continue; }
    if (d2 !== 0 || tk.t !== 'kw') continue;
    const u = tk.v.toUpperCase();
    if (u === 'ORDER' || u === 'LIMIT') throw unsupported('UPDATE multi-tabel dengan ORDER BY/LIMIT');
    if (u === 'WHERE') { e = j; whereI = j; break; }
  }
  const tname = String(head[head.length - 1].v).toLowerCase(), tbase = String(head[0].v).toLowerCase();
  const sets = splitTop(toks.slice(setI + 1, e)).map(a => {
    if (a[1]?.v === '.') { const q = String(a[0].v).toLowerCase(); if (q !== tname && q !== tbase) throw unsupported('UPDATE multi-tabel: SET pada kolom tabel lain'); return rewriteExpr(a.slice(2)).trim(); }
    return rewriteExpr(a).trim();
  }).join(', ');
  const conds = [];
  if (onCond.length) conds.push('(' + rewriteExpr(onCond).trim() + ')');
  if (whereI >= 0) conds.push('(' + rewriteExpr(toks.slice(whereI + 1)).trim() + ')');
  return { sql: 'UPDATE ' + rewriteTokenStream(head).trim() + ' SET ' + sets + ' FROM ' + rewriteTokenStream(fromToks).trim() + (conds.length ? ' WHERE ' + conds.join(' AND ') : ''), type: 'dml' };
}

// ---------- tipe MySQL → SQLite ----------
function mysqlTypeToSqlite(t) {
  // Pemanggil menggabung token dengan spasi ("int ( 11 )", "decimal ( 10 , 2 )"): rapikan dulu, kalau tidak int(11) / decimal(10,2) jatuh ke fallback TEXT.
  t = String(t).replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')').replace(/\s+(UNSIGNED|SIGNED|ZEROFILL)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (/^(TINY|SMALL|MEDIUM|BIG)?INT(\(\d+\))?$|^INTEGER(\(\d+\))?$|^BOOL(EAN)?$|^BIT(\(\d+\))?$|^(UN)?SIGNED( INT(EGER)?)?$/i.test(t)) return 'INTEGER';   // SIGNED / UNSIGNED: tipe sasaran CAST
  if (/^(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)(\(\d+,\d+\))?$/i.test(t)) return 'REAL';
  if (/^(VAR)?CHAR(\(\d+\))?$|^(TINY|MEDIUM|LONG)?TEXT$|^ENUM\(.*\)$|^SET\(.*\)$/i.test(t)) return 'TEXT';
  if (/^(TINY|MEDIUM|LONG)?BLOB$|^BINARY(\(\d+\))?$|^VARBINARY(\(\d+\))?$/i.test(t)) return 'BLOB';
  if (/^DATE(TIME)?$|^TIME$|^YEAR$|^TIMESTAMP$/i.test(t)) return 'TEXT';
  if (/^JSON$/i.test(t)) return 'TEXT';
  return 'TEXT'; // fallback
}

// DECIMAL/NUMERIC → [presisi, skala] seperti MySQL (tanpa kurung = 10,0); tipe lain → null.
function decimalSpec(t) {
  const m = /^\s*(?:DECIMAL|NUMERIC)\b(?:\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?/i.exec(t);
  return m ? [Number(m[1] ?? 10), Number(m[2] ?? 0)] : null;
}
// CAST/CONVERT ke DECIMAL membulatkan ke skalanya seperti MySQL; nol di belakang ditambahkan decimal.js pada hasil query.
function castExpr(val, typeName) {
  const dec = decimalSpec(typeName);
  if (!dec) return 'CAST(' + val + ' AS ' + mysqlTypeToSqlite(typeName) + ')';
  const r = 'ROUND(CAST(' + val + ' AS REAL), ' + dec[1] + '/*dec*/)';   // penanda dibaca decimal.js
  return dec[1] ? r : 'CAST(' + r + ' AS INTEGER)';
}

// ---------- penerjemah DDL ----------
function translateCreateTable(toks) {
  let tableColl = null;   // COLLATE[=] tingkat tabel
  for (let z = 0; z < toks.length; z++) if (isKw(toks[z], 'COLLATE') && depth(toks, z) === 0) { const nx = toks[z + 1]?.v === '=' ? toks[z + 2] : toks[z + 1]; if (nx) tableColl = String(nx.v).toLowerCase(); }
  // CREATE [TEMPORARY] TABLE [IF NOT EXISTS] name ( ... ) [opts]
  let i = 0;
  const advance = () => toks[i++];
  advance(); // CREATE
  let temporary = false;
  if (isKw(toks[i], 'TEMPORARY')) { temporary = true; advance(); }
  advance(); // TABLE
  let ifNotExists = '';
  if (isKw(toks[i], 'IF')) { advance(); advance(); advance(); ifNotExists = 'IF NOT EXISTS '; }

  // nama tabel
  const nameTok = advance();
  const rawTable = nameTok.v;
  const tableName = nameTok.t === 'id' ? '"' + nameTok.v.replace(/"/g, '""') + '"' : nameTok.v;

  // kolom dimulai setelah '('
  if (toks[i]?.v !== '(') throw unsupported('CREATE TABLE tanpa (');
  i++;

  const colDefs = []; const constraints = []; const indexes = [];
  let hasPk = false;

  while (i < toks.length && toks[i]?.v !== ')') {
    const col0 = toks[i];
    let up0 = kwUp(col0) ?? '';
    const CONS = ['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'CONSTRAINT', 'FOREIGN', 'CHECK'];
    if (CONS.includes(up0)) {
      // ambil satu segmen constraint sampai koma level-0 atau ')' penutup tabel (string diabaikan)
      const start = i; let d = 0;
      while (i < toks.length) {
        const tk = toks[i];
        if (tk.t === 'op') {
          if (tk.v === '(') d++;
          else if (tk.v === ')') { if (d === 0) break; d--; }
          else if (tk.v === ',' && d === 0) break;
        }
        i++;
      }
      let seg = toks.slice(start, i);
      if (toks[i]?.t === 'op' && toks[i].v === ',') i++;
      if (up0 === 'CONSTRAINT') { // CONSTRAINT [nama] <jenis> ...
        seg = seg.slice(1);
        if (seg[0] && !CONS.includes(kwUp(seg[0]) ?? '')) seg = seg.slice(1);
        up0 = kwUp(seg[0] ?? {}) ?? '';
      }
      if (up0 === 'PRIMARY' || up0 === 'UNIQUE' || up0 === 'KEY' || up0 === 'INDEX' || up0 === 'FULLTEXT') {
        // kolom = id/kw pada kedalaman 1 (awalan panjang "(10)" dan ASC/DESC dilewati)
        const cols = []; let dd = 0;
        for (const tk of seg) {
          if (tk.t === 'op') { if (tk.v === '(') dd++; else if (tk.v === ')') dd--; continue; }
          if (dd === 1 && (tk.t === 'id' || (tk.t === 'kw' && !isKw(tk, 'ASC', 'DESC')))) cols.push(tk.v);
        }
        if (cols.length) {
          if (up0 === 'PRIMARY') { if (!hasPk) { constraints.push('PRIMARY KEY (' + cols.map(c => '"' + c.replace(/"/g, '""') + '"').join(', ') + ')'); hasPk = true; } }
          else {
            let k = 1; if ((up0 === 'UNIQUE' || up0 === 'FULLTEXT') && isKw(seg[k] ?? {}, 'KEY', 'INDEX')) k++;
            const nm = seg[k] && seg[k].v !== '(' ? seg[k].v : null;
            indexes.push({ unique: up0 === 'UNIQUE', ft: up0 === 'FULLTEXT', name: nm, cols });
          }
        }
      }
      // FOREIGN/CHECK/SPATIAL: dibuang (integritas lanjutan; belum didukung). FULLTEXT dicatat sebagai indeks parsial `WHERE 0` (tanpa entri)
      continue;
    }

    // definisi kolom
    const colNameTok = advance();
    const colName = colNameTok.t === 'id' ? '"' + colNameTok.v.replace(/"/g, '""') + '"' : colNameTok.v;

    // tipe MySQL
    let typeParts = [];
    while (i < toks.length && toks[i]?.v !== ',' && toks[i]?.v !== ')') {
      const tk = toks[i];
      const up = kwUp(tk) ?? '';
      // hentikan di kata kunci kolom
      if (['NOT', 'NULL', 'DEFAULT', 'AUTO_INCREMENT', 'PRIMARY', 'UNIQUE', 'COMMENT', 'COLLATE', 'CHARACTER', 'CHARSET'].includes(up)) break;
      typeParts.push(tk); i++;
      // lewati (n) / (m,n)
      if (toks[i]?.v === '(') {
        typeParts.push(toks[i]); i++;
        while (i < toks.length && toks[i]?.v !== ')') { typeParts.push(toks[i]); i++; }
        if (toks[i]?.v === ')') { typeParts.push(toks[i]); i++; }
      }
    }
    const mysqlType = typeParts.map(t => t.v).join(' ');
    let sqliteType = mysqlTypeToSqlite(mysqlType);
    // DECIMAL/NUMERIC seperti MySQL: presisi dan skala disimpan di tipe deklarasi (afinitas NUMERIC, perbandingan tetap angka). Tanpa kurung = (10,0).
    const dec = decimalSpec(mysqlType);
    if (dec) sqliteType = 'DECIMAL(' + dec.join(',') + ')';

    // AUTO_INCREMENT → INTEGER PRIMARY KEY AUTOINCREMENT
    let autoInc = false, colColl = null;
    let isPk = false, isNotNull = false, defaultVal = null, isUnique = false;
    while (i < toks.length && toks[i]?.v !== ',' && toks[i]?.v !== ')') {
      const tk = toks[i]; const up = kwUp(tk) ?? '';
      if (up === 'AUTO_INCREMENT') { autoInc = true; sqliteType = 'INTEGER'; isPk = true; hasPk = true; i++; continue; }
      if (up === 'PRIMARY') { i++; if (isKw(toks[i], 'KEY')) i++; isPk = true; hasPk = true; continue; }
      if (up === 'UNIQUE') { isUnique = true; i++; if (isKw(toks[i], 'KEY')) i++; continue; }
      if (up === 'NOT') { i++; if (isKw(toks[i], 'NULL')) i++; isNotNull = true; continue; }
      if (up === 'NULL') { i++; continue; }
      if (up === 'DEFAULT') {
        i++;
        const dv = [];
        if (toks[i]?.t === 'op' && (toks[i].v === '-' || toks[i].v === '+')) { dv.push(toks[i]); i++; }
        if (toks[i] && toks[i].v !== '(') { dv.push(toks[i]); i++; if (toks[i]?.v === '(' && toks[i - 1].t === 'kw') { /* CURRENT_TIMESTAMP(n) */ dv.push(toks[i]); i++; while (i < toks.length && toks[i]?.v !== ')') { dv.push(toks[i]); i++; } if (toks[i]) { dv.push(toks[i]); i++; } } }
        while (i < toks.length && toks[i]?.v !== ',' && toks[i]?.v !== ')') {
          if (isKw(toks[i], 'NOT', 'NULL', 'AUTO_INCREMENT', 'PRIMARY', 'UNIQUE', 'COMMENT', 'ON', 'COLLATE')) break;
          if (toks[i]?.v === '(') { dv.push(toks[i]); i++; while (i < toks.length && toks[i]?.v !== ')') { dv.push(toks[i]); i++; } if (toks[i]?.v === ')') { dv.push(toks[i]); i++; } continue; }
          dv.push(toks[i]); i++;
        }
        defaultVal = rewriteExpr(dv); continue;
      }
      if (up === 'COMMENT') { i++; if (toks[i]?.t === 'str') i++; continue; }
      if (up === 'COLLATE' || up === 'CHARACTER') { i++; if (up === 'CHARACTER' && isKw(toks[i], 'SET')) i++; if (up === 'COLLATE') colColl = String(toks[i]?.v ?? '').toLowerCase(); i++; continue; }
      if (up === 'ON') { i++; i++; i++; continue; } // ON UPDATE CURRENT_TIMESTAMP
      i++; // token lain diabaikan
    }
    if (toks[i]?.v === ',') i++;

    const isText = /^(national\s+)?(var)?char|^(tiny|medium|long)?text|^enum|^set\b/i.test(mysqlType);
    const cl = colColl ?? tableColl ?? 'utf8mb4_general_ci';
    const ci = isText && !autoInc && !/(_bin|_cs)$|^binary$/.test(cl) && !typeParts.some(t => isKw(t, 'BINARY'));
    let def = colName + ' ' + sqliteType + (dec ? '' : marker(canonicalType(typeParts))) + (ci ? ' COLLATE NOCASE' : '');   // penanda tipe asli: mytypes.js
    if (isPk && autoInc) def += ' PRIMARY KEY AUTOINCREMENT';
    else if (isPk) def += ' PRIMARY KEY';
    else if (isUnique) def += ' UNIQUE';
    if (isNotNull && !isPk) def += ' NOT NULL';
    if (defaultVal !== null) def += ' DEFAULT ' + defaultVal;
    colDefs.push(def);
  }

  const body = colDefs.concat(constraints).join(', ');
  const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  const after = indexes.map(ix => 'CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX IF NOT EXISTS ' + q(rawTable + '__' + (ix.name || ix.cols.join('_'))) + ' ON ' + tableName + ' (' + ix.cols.map(q).join(', ') + ')' + (ix.ft ? ' WHERE 0' : ''));
  return { sql: 'CREATE ' + (temporary ? 'TEMPORARY ' : '') + 'TABLE ' + ifNotExists + tableName + ' (' + body + ')', after, colDefs, table: rawTable };
}

// helper kedalaman parentesis
function depth(toks, idx) {
  let d = 0;
  for (let j = 0; j < idx; j++) {
    if (toks[j]?.v === '(') d++;
    else if (toks[j]?.v === ')') d--;
  }
  return d;
}

// ---------- penerjemah DML umum ----------
function rewriteTokenStream(toks) {
  // Pre-filter: buang hint MySQL, ganti alias, lalu delegasikan ke rewriteExpr.
  const filtered = []; let i = 0;
  while (i < toks.length) {
    const t = toks[i]; const up = kwUp(t) ?? '';
    if (up === 'STRAIGHT_JOIN') { filtered.push({ ...t, v: 'JOIN' }); i++; continue; }
    if (up === 'SQL_CALC_FOUND_ROWS') { i++; continue; }
    if ((up === 'FORCE' || up === 'USE' || up === 'IGNORE') && isKw(toks[i + 1], 'INDEX', 'KEY')) {
      i += 2;
      if (toks[i]?.v === '(') { const cl = collectUntil(toks, i + 1, ')'); i += cl.length + 2; }
      continue;
    }
    filtered.push(t); i++;
  }
  return rewriteExpr(withLikeEscape(filtered));
}

// MySQL: karakter escape LIKE bawaan = backslash (`LIKE '\_%'` = awalan "_" harfiah). SQLite tanpa ESCAPE menganggap backslash biasa.
// Tambahkan ESCAPE '\' di akhir operand tiap LIKE yang belum punya ESCAPE (WordPress: esc_like, pembersihan transient).
function withLikeEscape(toks) {
  if (isKw(toks[0], 'CREATE')) return toks;
  const out = []; let k = 0;
  const STOP = /^(AND|OR|XOR|NOT|ORDER|GROUP|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|THEN|ELSE|WHEN|END|ESCAPE|FOR|LOCK|INTO|WINDOW|ON|USING|RETURNING|ASC|DESC|AS|IS|IN|FROM|WHERE|SET|SEPARATOR|JOIN|LEFT|RIGHT|INNER|CROSS|NATURAL|OVER)$/i;
  while (k < toks.length) {
    const t = toks[k]; out.push(t); k++;
    if (!isKw(t, 'LIKE') || !toks[k]) continue;
    let d = 0, j = k, done = false;   // done = satu ekspresi operand sudah lengkap; kata/string/angka berikutnya tanpa operator = alias, bukan lanjutan operand
    for (; j < toks.length; j++) {
      const x = toks[j];
      if (x.t === 'op' && x.v === '(') { if (d === 0) done = false; d++; }
      else if (x.t === 'op' && x.v === ')') { if (d === 0) break; d--; if (d === 0) done = true; }
      else if (d === 0) {
        if (x.v === ',' || x.v === ';' || (x.t === 'kw' && STOP.test(String(x.v)))) break;
        if (x.t === 'op') done = false;
        else if (x.t === 'kw' && /^(DIV|MOD|COLLATE|BINARY|REGEXP|RLIKE)$/i.test(String(x.v))) done = false;
        else { if (done) break; done = true; }
      }
    }
    const hasEsc = j < toks.length && isKw(toks[j], 'ESCAPE');
    for (let m = k; m < j; m++) out.push(toks[m]);
    if (!hasEsc) out.push({ t: 'kw', v: 'ESCAPE', pre: ' ' }, { t: 'str', v: '\\', pre: ' ' });
    k = j;
  }
  return out;
}

// ---------- SHOW / DESCRIBE ----------
function translateShow(toks) {
  // toks mulai setelah SHOW
  let what = kwUp(toks[0]) ?? '';
  if (what === 'FULL' || what === 'EXTENDED') { toks = toks.slice(1); what = kwUp(toks[0]) ?? ''; }
  if (what === 'TABLES') {
    const li = toks.findIndex(t => isKw(t, 'LIKE'));
    return { type: 'show_tables', like: li >= 0 ? toks[li + 1]?.v : undefined };
  }
  if (what === 'COLUMNS' || what === 'FIELDS') {
    // SHOW [FULL] COLUMNS FROM tbl
    let i = 1;
    if (isKw(toks[i], 'FROM') || isKw(toks[i], 'IN')) i++;
    const tblTok = toks[i];
    const tbl = tblTok?.t === 'id' ? tblTok.v : tblTok?.v ?? '';
    return { type: 'show_columns', table: tbl };
  }
  const tblOf = (i) => { const t = toks[i]; return t ? String(t.v ?? '').replace(/^.*\./, '') : ''; };
  if (what === 'INDEX' || what === 'INDEXES' || what === 'KEYS') {
    let i = 1;
    if (isKw(toks[i], 'FROM') || isKw(toks[i], 'IN')) i++;
    return { type: 'show_indexes', table: tblOf(i) };
  }
  if (what === 'CREATE') {
    if (isKw(toks[1], 'TABLE')) return { type: 'show_create', table: tblOf(2) };
    return { type: 'show_unknown', sql: 'SELECT 1 WHERE 0' };
  }
  if (what === 'DATABASES' || what === 'SCHEMAS') {
    return { type: 'show_databases' };
  }
  if (what === 'WARNINGS' || what === 'ERRORS') {
    return { type: 'show_warnings' };
  }
  if (what === 'STATUS' || what === 'VARIABLES' || what === 'PROCESSLIST') {
    return { type: 'show_status' };
  }
  return { type: 'show_unknown', sql: 'SELECT 1 WHERE 0' };
}

// ---------- entri utama ----------

// ---------- pemisah multi-statement (sadar kutip dan komentar) ----------
function splitStatements(src) {
  const out = []; let start = 0, i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\' && c !== '`') { i += 2; continue; }
        if (src[i] === c) { if (src[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++; continue;
    }
    if (c === '#' || (c === '-' && src[i + 1] === '-' && (i + 2 >= src.length || /\s/.test(src[i + 2])))) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === ';') { out.push(src.slice(start, i)); start = i + 1; }
    i++;
  }
  out.push(src.slice(start));
  return out.map(x => x.trim()).filter(x => { if (!x) return false; try { return tokenize(x).length > 0; } catch (_) { return true; } });
}

// ---------- ALTER TABLE → rencana operasi (dieksekusi Engine, karena sebagian butuh rebuild tabel) ----------
function colDefFromTokens(defToks) {
  const pre = tokenize('CREATE TABLE _x (');
  const r = translateCreateTable(pre.concat(defToks, tokenize(')')));
  if (r.colDefs.length !== 1) throw unsupported('definisi kolom ALTER');
  return r.colDefs[0];
}
function translateAlter(toks) {
  let i = 1; if (isKw(toks[i] ?? {}, 'IGNORE', 'ONLINE', 'OFFLINE')) i++;
  if (!isKw(toks[i] ?? {}, 'TABLE')) throw unsupported('ALTER selain TABLE');
  i++; const tblTok = toks[i++]; const table = tblTok.v;
  // pecah klausa pada koma level-0
  const clauses = []; let cur = [], d = 0;
  for (; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'op') { if (tk.v === '(') d++; else if (tk.v === ')') d--; else if (tk.v === ',' && d === 0) { clauses.push(cur); cur = []; continue; } }
    cur.push(tk);
  }
  if (cur.length) clauses.push(cur);
  const ops = [];
  const colsIn = (c) => { const r = []; let dd = 0; for (const tk of c) { if (tk.t === 'op') { if (tk.v === '(') dd++; else if (tk.v === ')') dd--; continue; } if (dd === 1 && (tk.t === 'id' || (tk.t === 'kw' && !isKw(tk, 'ASC', 'DESC')))) r.push(tk.v); } return r; };
  for (const c of clauses) {
    let j = 0; const u = (k = 0) => kwUp(c[j + k] ?? {}) ?? '';
    const first = u();
    const stripPos = (arr) => { // buang FIRST / AFTER x di ujung, kembalikan posisi
      const n = arr.length;
      if (n >= 1 && isKw(arr[n - 1], 'FIRST')) return [arr.slice(0, n - 1), { first: true }];
      if (n >= 2 && isKw(arr[n - 2], 'AFTER')) return [arr.slice(0, n - 2), { after: arr[n - 1].v }];
      return [arr, {}];
    };
    if (first === 'ADD') {
      j++; const k = u();
      if (k === 'PRIMARY') ops.push({ op: 'add_pk', cols: colsIn(c) });
      else if (['UNIQUE', 'KEY', 'INDEX', 'FULLTEXT'].includes(k)) {
        let m = j + 1; if ((k === 'UNIQUE' || k === 'FULLTEXT') && isKw(c[m] ?? {}, 'KEY', 'INDEX')) m++;
        ops.push({ op: 'add_index', unique: k === 'UNIQUE', ft: k === 'FULLTEXT', name: c[m] && c[m].v !== '(' ? c[m].v : null, cols: colsIn(c) });
      }
      else if (['SPATIAL', 'CONSTRAINT', 'FOREIGN', 'CHECK'].includes(k)) ops.push({ op: 'noop' });
      else {
        if (k === 'COLUMN') j++;
        if (c[j]?.v === '(') {   // ADD [COLUMN] (c1 def, c2 def, ...)
          const inner = c.slice(j + 1, c.length - 1); let part = [], dp = 0; const parts = [];
          for (const tk of inner) { if (tk.t === 'op') { if (tk.v === '(') dp++; else if (tk.v === ')') dp--; else if (tk.v === ',' && dp === 0) { parts.push(part); part = []; continue; } } part.push(tk); }
          if (part.length) parts.push(part);
          for (const pt of parts) {
            if (['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'FULLTEXT', 'CONSTRAINT', 'FOREIGN'].includes(kwUp(pt[0] ?? {}) ?? '')) throw unsupported('ADD (...) berisi indeks/constraint');
            ops.push({ op: 'add', name: pt[0].v, def: colDefFromTokens(pt) });
          }
          continue;
        }
        const [dt, pos] = stripPos(c.slice(j));
        ops.push({ op: 'add', name: dt[0].v, def: colDefFromTokens(dt), ...pos });
      }
    } else if (first === 'DROP') {
      j++; const k = u();
      if (k === 'PRIMARY') ops.push({ op: 'drop_pk' });
      else if (k === 'INDEX' || k === 'KEY') ops.push({ op: 'drop_index', name: c[j + 1].v });
      else if (['FOREIGN', 'CONSTRAINT', 'CHECK'].includes(k)) ops.push({ op: 'noop' });
      else { if (k === 'COLUMN') j++; ops.push({ op: 'drop_col', name: c[j].v }); }
    } else if (first === 'MODIFY') {
      j++; if (u() === 'COLUMN') j++;
      const [dt, pos] = stripPos(c.slice(j));
      ops.push({ op: 'modify', name: dt[0].v, newName: dt[0].v, def: colDefFromTokens(dt), ...pos });
    } else if (first === 'CHANGE') {
      j++; if (u() === 'COLUMN') j++;
      const old = c[j].v; const [dt, pos] = stripPos(c.slice(j + 1));
      ops.push({ op: 'modify', name: old, newName: dt[0].v, def: colDefFromTokens(dt), ...pos });
    } else if (first === 'RENAME') {
      j++; const k = u();
      if (k === 'COLUMN') ops.push({ op: 'rename_col', from: c[j + 1].v, to: c[j + 3].v });
      else if (k === 'INDEX' || k === 'KEY') ops.push({ op: 'rename_index', from: c[j + 1].v, to: c[j + 3].v });
      else { if (k === 'TO' || k === 'AS') j++; ops.push({ op: 'rename_table', to: c[j].v }); }
    } else if (first === 'ALTER') {
      j++; if (u() === 'COLUMN') j++;
      const name = c[j].v; j++;
      if (u() === 'DROP' && u(1) === 'DEFAULT') ops.push({ op: 'set_default', name, value: null });
      else if (u() === 'SET' && u(1) === 'DEFAULT') ops.push({ op: 'set_default', name, value: rewriteExpr(c.slice(j + 2)).trim() });
      else throw unsupported('ALTER COLUMN ' + u());
    } else if (['ENGINE', 'AUTO_INCREMENT', 'DEFAULT', 'CHARSET', 'CHARACTER', 'COLLATE', 'CONVERT', 'COMMENT', 'ROW_FORMAT', 'ALGORITHM', 'LOCK', 'DISABLE', 'ENABLE', 'FORCE', 'STATS_PERSISTENT'].includes(first)) {
      ops.push({ op: 'noop' });
    } else throw unsupported('ALTER TABLE ' + first);
  }
  return { type: 'alter', table, ops };
}

function translate0(sql) {
  const raw = sql.trim().replace(/;+\s*$/, '');
  if (!raw) return { sql: '', type: 'empty' };

  let toks;
  try { toks = tokenize(raw); }
  catch (e) { return { sql: raw, type: 'passthrough', error: e }; }

  if (!toks.length) return { sql: '', type: 'empty' };

  const first = kwUp(toks[0]) ?? '';
  const second = toks[1] ? (kwUp(toks[1]) ?? '') : '';

  // passthrough aman
  if (first === 'SET' && /^@[^@]/.test(toks[1]?.v ?? '') && !toks.some(t => /^@@/.test(t.v ?? ''))) {   // SET @a = expr[, @b := expr ...]
    const items = []; let cur = [], dp = 0;
    for (const tk of toks.slice(1)) { if (tk.t === 'op') { if (tk.v === '(') dp++; else if (tk.v === ')') dp--; else if (tk.v === ',' && dp === 0) { items.push(cur); cur = []; continue; } } cur.push(tk); }
    if (cur.length) items.push(cur);
    const sqls = items.map(it => {
      if (!/^@[^@]/.test(it[0]?.v ?? '') || !['=', ':='].includes(it[1]?.v)) throw unsupported('SET campuran variabel sesi dan variabel sistem');
      return 'SELECT ' + rewriteExpr([it[0], { t: 'op', v: ':=', pre: '' }, ...it.slice(2)]);
    });
    return { sql: '', sqls, type: 'ddl' };
  }
  if (['SET', 'USE'].includes(first)) return { sql: '', type: 'empty' }; // diabaikan (juga bila dibungkus /*!40101 ... */)
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(first)) return { sql: raw, type: 'transaction' };
  if (first === 'START' && second === 'TRANSACTION') return { sql: 'BEGIN', type: 'transaction' };

  // SHOW
  if (first === 'SHOW') return translateShow(toks.slice(1));

  // DESCRIBE / DESC
  if (first === 'DESCRIBE' || (first === 'DESC' && toks.length > 1 && toks[1].t !== 'kw')) {
    const tblTok = toks[1];
    const tbl = tblTok?.t === 'id' ? tblTok.v : tblTok?.v ?? '';
    return { type: 'show_columns', table: tbl };
  }

  // CREATE TABLE
  if (first === 'CREATE') {
    // CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX ... : buang panjang prefiks col(20); FULLTEXT/SPATIAL diabaikan
    const ii = toks.findIndex(t => isKw(t, 'INDEX'));
    if (ii > 0 && ii <= 2 && !toks.some(t => isKw(t, 'TABLE'))) {
      if (isKw(toks[1], 'SPATIAL')) return { sql: '', type: 'empty' };
      if (isKw(toks[1], 'FULLTEXT')) {   // CREATE FULLTEXT INDEX nama ON tabel (kol, ...) → ALTER TABLE tabel ADD FULLTEXT nama (kol, ...)
        const on = toks.findIndex(t => isKw(t, 'ON')), op = toks.findIndex((t, k) => k > on && t.v === '(');
        if (on < 0 || op < 0) throw new SqlError(1064, '42000', 'You have an error in your SQL syntax near FULLTEXT INDEX');
        const cols = []; let dd = 0;
        for (let k = op; k < toks.length; k++) { const tk = toks[k]; if (tk.t === 'op') { if (tk.v === '(') dd++; else if (tk.v === ')') dd--; continue; } if (dd === 1 && (tk.t === 'id' || (tk.t === 'kw' && !isKw(tk, 'ASC', 'DESC')))) cols.push(tk.v); }
        return { type: 'alter', table: toks[on + 1].v, ops: [{ op: 'add_index', unique: false, ft: true, name: toks[ii + 1].v, cols }] };
      }
      const nt = []; for (let k = 0; k < toks.length; k++) { if (toks[k].v === '(' && toks[k + 1]?.t === 'num' && toks[k + 2]?.v === ')' && k > 0 && toks[k - 1].t !== 'op') { k += 2; continue; } nt.push(toks[k]); }
      return { sql: rewriteTokenStream(nt), type: 'ddl' };
    }
    // CREATE [TEMPORARY] TABLE [IF NOT EXISTS] baru LIKE lama
    const li = toks.findIndex(t => isKw(t, 'LIKE'));
    if (li > 0 && toks.slice(0, li).some(t => isKw(t, 'TABLE')) && !toks.some(t => t.v === '(')) {
      return { type: 'create_like', table: toks[li - 1].v, from: toks[li + 1].v, ifNotExists: toks.some(t => isKw(t, 'EXISTS')) };
    }
    const idx = toks.findIndex(t => isKw(t, 'TABLE'));
    if (idx >= 0) {
      try {
        const ct = translateCreateTable(toks.slice(idx - 1));
        return ct.after.length ? { sql: ct.sql, sqls: [ct.sql, ...ct.after], type: 'ddl' } : { sql: ct.sql, type: 'ddl' };
      } catch (e) {
        return { sql: raw, type: 'passthrough', error: e };
      }
    }
    return { sql: rewriteTokenStream(toks), type: 'ddl' };
  }

  // ALTER TABLE → rewrite sederhana
  if (first === 'ALTER') {
    // ALTER TABLE tbl ADD COLUMN / DROP COLUMN / MODIFY / CHANGE
    // SQLite hanya mendukung ADD COLUMN dan RENAME COLUMN; sisanya dirancang di translateAlter dan dieksekusi Engine
    if (second === 'TABLE' || isKw(toks[1] ?? {}, 'IGNORE')) return translateAlter(toks);
    return { sql: rewriteTokenStream(toks), type: 'ddl' };
  }

  // DROP / TRUNCATE
  if (first === 'DROP' || first === 'TRUNCATE') {
    const r = rewriteTokenStream(toks);
    // TRUNCATE TABLE t → DELETE FROM t (SQLite tidak punya TRUNCATE)
    if (first === 'TRUNCATE') {
      const tblIdx = toks.findIndex(t => !isKw(t, 'TRUNCATE', 'TABLE'));
      const tblN = toks[tblIdx];
      return { sql: 'DELETE FROM ' + (tblN?.t === 'id' ? '"' + tblN.v + '"' : tblN?.v ?? '?'), type: 'dml' };
    }
    return { sql: r, type: 'ddl' };
  }

  // INSERT IGNORE → INSERT OR IGNORE
  // INSERT ... ON DUPLICATE KEY UPDATE → INSERT OR REPLACE
  if (first === 'INSERT') {
    let ts = toks;
    const odku = ts.findIndex((t, j) => isKw(t, 'ON') && isKw(ts[j + 1] ?? {}, 'DUPLICATE') && isKw(ts[j + 2] ?? {}, 'KEY') && isKw(ts[j + 3] ?? {}, 'UPDATE'));
    let isOdku = false;
    if (odku >= 0) {
      isOdku = true;
      const head = ts.slice(0, odku), tail = ts.slice(odku + 4), nt = [];
      for (let j = 0; j < tail.length; j++) { // VALUES(col) -> excluded.col
        if (isKw(tail[j], 'VALUES') && tail[j + 1]?.v === '(' && tail[j + 3]?.v === ')') {
          nt.push({ t: 'kw', v: 'excluded.' + emitTok(tail[j + 2]), pre: tail[j].pre }); j += 3; continue;
        }
        nt.push(tail[j]);
      }
      // INSERT ... SELECT + upsert butuh WHERE true agar tidak ambigu
      const hasSelect = head.some(t => isKw(t, 'SELECT'));
      ts = head.concat([{ t: 'kw', v: (hasSelect ? 'WHERE true ' : '') + 'ON CONFLICT DO UPDATE SET', pre: ' ' }], nt);
    }
    let r = rewriteTokenStream(ts);
    if (/^INSERT\s+IGNORE\b/i.test(r)) r = r.replace(/^INSERT\s+IGNORE\b/i, 'INSERT OR IGNORE');
    return { sql: r, type: 'dml' };
  }

  // REPLACE INTO → INSERT OR REPLACE INTO
  if (first === 'REPLACE') {
    return { sql: rewriteTokenStream(toks).replace(/^REPLACE\b/i, 'INSERT OR REPLACE'), type: 'dml' };
  }

  if (first === 'UPDATE') { const uj = translateUpdateJoin(toks); if (uj) return uj; }

  // UPDATE/DELETE ... [ORDER BY] LIMIT n → subkueri rowid (SQLite tanpa LIMIT di UPDATE/DELETE)
  if (first === 'UPDATE' || first === 'DELETE') {
    let d = 0, tailStart = -1, hasLimit = false;
    for (let j = 1; j < toks.length; j++) {
      const tk = toks[j];
      if (tk.t === 'op') { if (tk.v === '(') d++; else if (tk.v === ')') d--; continue; }
      if (d !== 0 || tk.t !== 'kw') continue;
      const u = tk.v.toUpperCase();
      if (tailStart < 0 && (u === 'WHERE' || u === 'ORDER' || u === 'LIMIT')) tailStart = j;
      if (u === 'LIMIT') hasLimit = true;
    }
    const tblTok = first === 'UPDATE' ? toks[1] : toks[2];
    if (hasLimit && tailStart > 0 && tblTok && !toks.slice(0, tailStart).some(t => isKw(t, 'JOIN', 'USING'))) {
      const head = rewriteTokenStream(toks.slice(0, tailStart));
      const tail = rewriteTokenStream(toks.slice(tailStart));
      const sub = 'SELECT rowid FROM ' + emitTok(tblTok) + ' ' + tail.trim();
      return { sql: head.trimEnd() + ' WHERE rowid IN (' + sub + ')', type: 'dml' };
    }
  }

  // SELECT / UPDATE / DELETE → rewrite ekspresi dan token
  if (first === 'SELECT') toks = withImplicitFtOrder(havingToWhere(toks));
  return { sql: rewriteTokenStream(toks), type: 'dml' };
}

// MySQL membolehkan HAVING pada SELECT tanpa GROUP BY dan tanpa agregat (WordPress: `... HAVING meta_key NOT LIKE ...`); SQLite menolaknya.
// Bila tak ada GROUP BY, agregat, atau UNION di mana pun, HAVING setara dengan menambahkan syaratnya ke WHERE.
function havingToWhere(toks) {
  const h = topKw(toks, 'HAVING'); if (h < 0 || topKw(toks, 'GROUP') >= 0 || topKw(toks, 'UNION') >= 0) return toks;
  const AGG = /^(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|STD|STDDEV|STDDEV_POP|STDDEV_SAMP|VARIANCE|VAR_POP|VAR_SAMP|BIT_AND|BIT_OR|BIT_XOR|JSON_ARRAYAGG|JSON_OBJECTAGG)$/i;
  for (let k = 0; k < toks.length - 1; k++) if (AGG.test(String(toks[k].v)) && toks[k + 1].v === '(') return toks;
  let d = 0, end = toks.length;
  for (let k = h + 1; k < toks.length; k++) {
    const x = toks[k];
    if (x.v === '(') d++; else if (x.v === ')') d--;
    else if (d === 0 && x.t === 'kw' && /^(ORDER|LIMIT|FOR|LOCK|INTO)$/i.test(String(x.v))) { end = k; break; }
  }
  const cond = toks.slice(h + 1, end), w = topKw(toks, 'WHERE');
  const glue = [{ t: 'kw', v: w >= 0 ? 'AND' : 'WHERE', pre: ' ' }, { t: 'op', v: '(', pre: ' ' }];
  return toks.slice(0, h).concat(glue, cond, [{ t: 'op', v: ')', pre: ' ' }], toks.slice(end));
}

// 6c-10: MySQL (manual 14.9.1) mengurutkan hasil MATCH ... AGAINST mode natural di WHERE menurut relevansi menurun
// bila tidak ada ORDER BY. Ditiru dengan menambah ORDER BY <MATCH yang sama> DESC pada SELECT tingkat atas.
// Konservatif: hanya bila MATCH (bukan BOOLEAN) berada di tingkat atas WHERE sebagai konjungsi (tanpa OR/XOR, tanpa NOT,
// tanpa pembanding =,<,<=,<>,!=,IS setelahnya), dan tanpa ORDER/GROUP/HAVING/UNION di tingkat atas.
function withImplicitFtOrder(toks) {
  if (topKw(toks, 'ORDER') >= 0 || topKw(toks, 'GROUP') >= 0 || topKw(toks, 'HAVING') >= 0 || topKw(toks, 'UNION') >= 0) return toks;
  const w = topKw(toks, 'WHERE'); if (w < 0) return toks;
  const STOPK = ['LIMIT', 'FOR', 'LOCK', 'INTO', 'PROCEDURE', 'WINDOW'];
  let end = toks.length, d = 0;
  for (let k = w + 1; k < toks.length; k++) {
    const x = toks[k];
    if (x.v === '(') d++; else if (x.v === ')') d--;
    else if (d === 0 && x.t === 'kw' && STOPK.includes(String(x.v).toUpperCase())) { end = k; break; }
  }
  let m = -1; d = 0;
  for (let k = w + 1; k < end; k++) {
    const x = toks[k];
    if (x.v === '(') { d++; continue; } if (x.v === ')') { d--; continue; }
    if (d !== 0) continue;
    if (x.t === 'kw' && ['OR', 'XOR'].includes(String(x.v).toUpperCase())) return toks;
    if (x.v === '||') return toks;
    if (m < 0 && isKw(x, 'MATCH') && toks[k + 1]?.v === '(') m = k;
  }
  if (m < 0) return toks;
  const cn = argLen(toks, m + 2), ag = m + 2 + cn + 1;
  if (!isKw(toks[ag] ?? {}, 'AGAINST') || toks[ag + 1]?.v !== '(') return toks;
  const an = argLen(toks, ag + 2), close = ag + 2 + an;   // indeks ')' penutup AGAINST
  const body = toks.slice(ag + 2, close);
  if (body.some(y => y.t === 'kw' && String(y.v).toUpperCase() === 'BOOLEAN')) return toks;
  const prev = toks[m - 1];
  if (prev && ((prev.t === 'kw' && String(prev.v).toUpperCase() === 'NOT') || prev.v === '!')) return toks;
  const nx = toks[close + 1];
  if (nx && (['=', '<', '<=', '<>', '!=', '<=>'].includes(nx.v) || isKw(nx, 'IS', 'NOT', 'BETWEEN', 'IN'))) return toks;
  const expr = toks.slice(m, close + 1).map((x, n) => (n ? x : { ...x, pre: ' ' }));
  const ins = [{ t: 'kw', v: 'ORDER', pre: ' ' }, { t: 'kw', v: 'BY', pre: ' ' }, ...expr, { t: 'kw', v: 'DESC', pre: ' ' }];
  return [...toks.slice(0, end), ...ins, ...toks.slice(end)];
}

function translate(sql) {
  _pre = []; _ft = [];
  let r; try { r = translate0(sql); if (_pre.length) r.pre = _pre; if (_ft.length) r.ft = [...new Set(_ft)]; } finally { _pre = null; _ft = null; }
  if (r.nparams === undefined) {
    try { r.nparams = tokenize(sql).filter(t => t.t === 'op' && t.v === '?').length; } catch (_) { r.nparams = 0; }
  }
  return r;
}

module.exports = { splitStatements, translateAlter, translate, tokenize, rewriteExpr, mysqlTypeToSqlite, SqlError };
