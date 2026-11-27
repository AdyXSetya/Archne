'use strict';
// P.9 langkah 6c-7/6c-8: MATCH(cols) AGAINST('q' [mode]) sebagai UDF (tanpa indeks, tanpa FTS5).
// Meniru aturan FULLTEXT InnoDB: token = huruf/angka/_ ; panjang minimum 3 (innodb_ft_min_token_size);
// stopword bawaan InnoDB (36 kata); mode natural language, boolean (+ - > < ~ * "frasa" ( )) dan query expansion.
// Skor: dengan statistik korpus (stats) = jumlah tf * idf^2, idf = log10(N / df) (bentuk InnoDB, dari ingatan,
// BELUM diverifikasi terhadap MySQL asli); tanpa stats = jumlah (1 + ln tf).
// Himpunan baris yang cocok TIDAK bergantung pada skor: baris cocok selalu bernilai > 0 (minimal 1e-6).

const STOP = new Set(('a about an are as at be by com de en for from how i in is it la of on or that the this to was what when where who will with und the www').split(' '));
const MIN_LEN = 3, MAX_LEN = 84;
const indexable = (w) => w.length >= MIN_LEN && w.length <= MAX_LEN && !STOP.has(w);

// teks → daftar token { w: kata huruf kecil, ok: bisa diindeks }
function tokens(text) {
  const out = [];
  const re = /[\p{L}\p{N}_]+/gu; let m;
  const s = String(text);
  while ((m = re.exec(s))) { const w = m[0].toLowerCase(); out.push({ w, ok: indexable(w) }); }
  return out;
}
// nilai-nilai kolom satu baris → deretan token (kolom dipisah penanda celah supaya frasa tak melintasi kolom)
function docTokens(cols) {
  const toks = [];
  for (const c of cols) { for (const t of tokens(c == null ? '' : c)) toks.push(t); toks.push({ w: '\0', ok: false }); }
  return toks;
}
// statistik korpus dari baris-baris tabel (tiap baris = larik nilai kolom indeks)
function buildStats(rows) {
  const docs = rows.map(docTokens), termDf = new Map();
  for (const d of docs) for (const w of new Set(d.filter(t => t.ok).map(t => t.w))) termDf.set(w, (termDf.get(w) || 0) + 1);
  return { N: docs.length, docs, termDf, df: new Map(), qe: new Map() };
}

// ---------- parser query boolean ----------
// Klausa { op: '+'|'-'|'', wt: '>'|'<'|'~'|'', kind: 'term'|'prefix'|'phrase'|'group', ... }
function parseBoolean(q) {
  let i = 0; const s = String(q);
  function clauses(inGroup) {
    const list = [];
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === ')') { if (inGroup) { i++; return list; } i++; continue; }
      let op = '', wt = '';
      while (i < s.length && '+-><~'.includes(s[i])) { if (s[i] === '+' || s[i] === '-') { if (!op) op = s[i]; } else if (!wt) wt = s[i]; i++; }
      if (i >= s.length) break;
      const d = s[i];
      if (d === '(') { i++; const sub = clauses(true); list.push({ op, wt, kind: 'group', sub }); continue; }
      if (d === '"') {
        const e = s.indexOf('"', i + 1); const body = e < 0 ? s.slice(i + 1) : s.slice(i + 1, e); i = e < 0 ? s.length : e + 1;
        list.push({ op, wt, kind: 'phrase', words: tokens(body).map(t => t.w) }); continue;
      }
      const m = /^[\p{L}\p{N}_]+/u.exec(s.slice(i));
      if (!m) { i++; continue; }
      i += m[0].length;
      const star = s[i] === '*'; if (star) i++;
      list.push({ op, wt, kind: star ? 'prefix' : 'term', w: m[0].toLowerCase() });
    }
    return list;
  }
  return clauses(false);
}

// ---------- evaluasi ----------
const tfw = (tf) => tf > 0 ? 1 + Math.log(tf) : 0;
function countTerm(toks, w) { let n = 0; for (const t of toks) if (t.w === w) n++; return n; }
function countPrefix(toks, p) { let n = 0; for (const t of toks) if (t.ok && t.w.startsWith(p)) n++; return n; }
function countPhrase(toks, ws) {
  if (!ws.length) return 0; let n = 0;
  for (let i = 0; i + ws.length <= toks.length; i++) { let ok = true; for (let j = 0; j < ws.length; j++) if (toks[i + j].w !== ws[j]) { ok = false; break; } if (ok) n++; }
  return n;
}
// bobot satu klausa untuk satu dokumen: tf*idf^2 bila ada stats, selain itu 1+ln(tf)
function weigh(stats, sig, tf, hitFn) {
  if (tf <= 0) return 0;
  if (!stats) return tfw(tf);
  let df = sig[0] === 't' && sig[1] === ':' ? (stats.termDf.get(sig.slice(2)) || 0) : stats.df.get(sig);
  if (df === undefined) { df = 0; for (const d of stats.docs) if (hitFn(d)) df++; stats.df.set(sig, df); }
  if (!df) return 0;
  const idf = Math.log10(stats.N / df);
  return tf * idf * idf;
}
function evalClause(c, toks, stats) {
  let tf, sig, fn;
  if (c.kind === 'term') {
    if (!indexable(c.w)) return null;
    tf = countTerm(toks, c.w); sig = 't:' + c.w; fn = (d) => countTerm(d, c.w) > 0;
  } else if (c.kind === 'prefix') {
    if (!c.w.length) return null;
    tf = countPrefix(toks, c.w); sig = 'p:' + c.w; fn = (d) => countPrefix(d, c.w) > 0;
  } else if (c.kind === 'phrase') {
    if (!c.words.length) return null;
    tf = countPhrase(toks, c.words); sig = 'f:' + c.words.join(' '); fn = (d) => countPhrase(d, c.words) > 0;
  } else return evalGroup(c.sub, toks, stats);
  return { hit: tf > 0, score: weigh(stats, sig, tf, fn) };
}
function evalGroup(list, toks, stats) {
  let req = 0, hasPos = false, any = false, score = 0, ok = true;
  for (const c of list) {
    const r = evalClause(c, toks, stats); if (!r) continue;
    if (c.op === '-') { if (r.hit) ok = false; continue; }
    hasPos = true;
    if (c.op === '+') { req++; if (!r.hit) ok = false; }
    if (r.hit) {
      any = true;
      const k = c.wt === '>' ? 1.5 : c.wt === '<' ? 0.5 : c.wt === '~' ? -0.5 : 1;
      score += r.score * k;
    }
  }
  if (!ok || !hasPos || (req === 0 && !any)) return { hit: false, score: 0 };
  return { hit: true, score: Math.max(score, 0) };
}

// ---------- mode natural ----------
function naturalTerms(words, toks, stats) {
  let hit = false, score = 0;
  for (const w of words) { const tf = countTerm(toks, w); if (tf > 0) { hit = true; score += weigh(stats, 't:' + w, tf, (d) => countTerm(d, w) > 0); } }
  return { hit, score };
}
function queryWords(q) { return [...new Set(tokens(q).filter(t => t.ok).map(t => t.w))]; }
// query expansion: kata semua dokumen yang cocok pada putaran pertama ditambahkan ke query (butuh stats)
function expanded(q, stats) {
  let ws = stats.qe.get(q);
  if (!ws) {
    const base = queryWords(q), set = new Set(base);
    for (const d of stats.docs) if (naturalTerms(base, d, null).hit) for (const t of d) if (t.ok) set.add(t.w);
    ws = [...set]; stats.qe.set(q, ws);
  }
  return ws;
}

const cache = new Map();
function cached(key, fn) { let v = cache.get(key); if (v === undefined) { if (cache.size > 500) cache.clear(); v = fn(); cache.set(key, v); } return v; }

// mode: 'NL' | 'BOOL' | 'NLQE'. cols: nilai kolom baris ini (NULL = kosong). stats: dari buildStats (opsional).
function match(mode, q, cols, stats) {
  if (q == null) return 0;
  const toks = docTokens(cols);
  let r;
  if (mode === 'BOOL') r = evalGroup(cached('B' + q, () => parseBoolean(q)), toks, stats);
  else r = naturalTerms(mode === 'NLQE' && stats ? expanded(String(q), stats) : queryWords(q), toks, stats);
  return r.hit ? Math.max(r.score, 1e-6) : 0;
}

module.exports = { match, tokens, parseBoolean, buildStats, STOP, MIN_LEN };
