<?php
// Alat database milik APLIKASI (P.7a-e). Bukan milik situs: dimuat ke /sys oleh Worker dari salinan di dalam aplikasi dan hanya dijalankan
// lewat host (pool.request dengan sys:true), tidak pernah lewat router atau lw_req. Membaca (tables, rows) dan, sejak P.7d, menulis SATU baris per panggilan (insert, update, delete lewat rowid).
// Masukan : POST JSON { op:'tables', db } atau { op:'rows', db, table, offset, limit, sort, dir, q } (P.7b, hanya baca)   Keluaran: JSON { ok:true, ... } | { ok:false, code }
//          { op:'reset', db } (kosongkan semua tabel, struktur tetap) | { op:'insert', db, table, values:[[kolom, nilai|null]] } | { op:'update', db, table, rid, values } | { op:'delete', db, table, rid }  (P.7d: parameter terikat, nama kolom divalidasi terhadap skema; rows kini juga mengembalikan ids + rw)
// Pertahanan berlapis: Node sudah memvalidasi nama; di sini dicek lagi. Tidak ada jalur disk dan tidak ada pesan galat mentah di keluaran.
ini_set('display_errors', '0');
error_reporting(0);
header('Content-Type: application/json; charset=utf-8');

function out($a) { echo json_encode($a, JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_UNICODE); exit; }
function fail($code) { out(array('ok' => false, 'code' => $code)); }
function q($n) { return '"' . str_replace('"', '""', $n) . '"'; }
// Alias rowid yang aman dipakai (bukan nama kolom sungguhan), atau null: tampilan, sqlite_*, dan WITHOUT ROWID tidak punya.
function rid_alias($pdo, $t, $cols) {
  if (strpos($t, 'sqlite_') === 0) return null;
  $low = array_map('strtolower', $cols);
  foreach (array('rowid', 'oid', '_rowid_') as $a) {
    if (in_array($a, $low, true)) continue;
    try { $pdo->query('SELECT ' . $a . ' FROM ' . q($t) . ' LIMIT 0')->closeCursor(); return $a; } catch (Throwable $e) { return null; }
  }
  return null;
}

// P.7f: pecah SQL tanpa menjalankannya. Mengembalikan array(kata_pertama_huruf_kecil, satu_pernyataan:bool) atau null bila cacat
// (tanda kutip / komentar tak tertutup). Memahami '..', "..", `..`, [..], -- komentar, /* komentar */. Hanya SATU pernyataan boleh (; penutup diizinkan).
function sql_scan($sql) {
  $n = strlen($sql); $i = 0; $first = null; $ended = false; $end = $n;
  while ($i < $n) {
    $c = $sql[$i];
    if ($c === ' ' || $c === "\t" || $c === "\n" || $c === "\r" || $c === "\f") { $i++; continue; }
    if ($c === '-' && $i + 1 < $n && $sql[$i + 1] === '-') { $e = strpos($sql, "\n", $i); $i = $e === false ? $n : $e + 1; continue; }
    if ($c === '/' && $i + 1 < $n && $sql[$i + 1] === '*') { $e = strpos($sql, '*/', $i + 2); if ($e === false) return null; $i = $e + 2; continue; }
    if ($c === ';') { if (!$ended) $end = $i; $ended = true; $i++; continue; }
    if ($ended) return array($first, false, $end); // ada isi setelah ; = pernyataan kedua
    if ($first === null) {
      if (!preg_match('/\G[A-Za-z]+/', $sql, $m, 0, $i)) return array('', true);
      $first = strtolower($m[0]);
    }
    if ($c === "'" || $c === '"' || $c === '`' || $c === '[') {
      $close = $c === '[' ? ']' : $c; $j = $i + 1;
      while (true) {
        $e = strpos($sql, $close, $j); if ($e === false) return null;
        if ($close !== ']' && $e + 1 < $n && $sql[$e + 1] === $close) { $j = $e + 2; continue; } // '' dan "" = tanda kutip di dalam
        $i = $e + 1; break;
      }
      continue;
    }
    $i++;
  }
  return array($first === null ? '' : $first, true, $end);
}
function clean_msg($m) { // pesan galat SQLite untuk pemilik: buang awalan PDO dan jalur
  $m = preg_replace('/^SQLSTATE\[[^\]]*\]:[^:]*:\s*(\d+\s+)?/', '', (string)$m);
  $m = str_replace('/data/', '', $m);
  return substr($m, 0, 200);
}
function csv_field($k, $v) { // NULL = kosong; teks kosong = "" ; BLOB = heksa
  if ($k === 'null') return '';
  if ($v === '') return '""';
  $v = (string)$v;
  return preg_match('/[",\r\n]/', $v) ? '"' . str_replace('"', '""', $v) . '"' : $v;
}

try {
  $raw = file_get_contents('php://input', false, null, 0, 1048576);
  $in = json_decode($raw === false ? '' : $raw, true);
  if (!is_array($in) || !isset($in['op']) || !isset($in['db']) || !is_string($in['db']) || !in_array($in['op'], array('tables', 'rows', 'insert', 'update', 'delete', 'checkpoint', 'exec', 'csv', 'reset'), true)) fail('bad');
  $db = $in['db'];
  if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/D', $db) || strpos($db, '..') !== false || substr($db, -1) === '.') fail('badname');
  if (!in_array(strtolower(pathinfo($db, PATHINFO_EXTENSION)), array('sqlite', 'sqlite3', 'db', 'db3'), true)) fail('badname');
  $p = '/data/' . $db;
  if (is_link($p) || !is_file($p)) fail('nodb');
  if (realpath($p) !== $p) fail('badname');
  $h = fopen($p, 'rb'); $magic = $h ? fread($h, 16) : ''; if ($h) fclose($h);
  if ($magic !== "SQLite format 3\0") fail('notdb');

  if ($in['op'] === 'exec') { // P.7f: kotak SQL. Baca-saja kecuali write:true. SATU pernyataan; ATTACH/PRAGMA/VACUUM ditolak di kedua mode.
    $sql = isset($in['sql']) && is_string($in['sql']) ? $in['sql'] : '';
    if (trim($sql) === '' || strlen($sql) > 100000 || strpos($sql, "\0") !== false) fail('bad');
    if (isset($in['write']) && !is_bool($in['write'])) fail('bad');
    $write = isset($in['write']) && $in['write'] === true;
    $sc = sql_scan($sql); if ($sc === null) fail('sql'); if ($sc[1] !== true) fail('multi');
    $kw = $sc[0];
    $readKw = array('select', 'with', 'values', 'explain'); $writeKw = array('insert', 'replace', 'update', 'delete', 'create', 'drop', 'alter');
    if (!in_array($kw, $readKw, true)) {
      if (!in_array($kw, $writeKw, true)) fail('denied');
      if (!$write) fail('needwrite');
    }
    $pdo = new PDO('sqlite:' . $p, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5));
    if ($write) $pdo->exec('PRAGMA foreign_keys=1'); else $pdo->exec('PRAGMA query_only=1');
    $res = array('ok' => true, 'columns' => array(), 'rows' => array(), 'more' => false, 'changes' => null);
    try {
      if ($write) $pdo->beginTransaction();
      $st = $pdo->prepare($sql); $st->execute(); // jumlah kolom baru diketahui PDO setelah execute
      $nc = $st->columnCount();
      if ($nc > 0) {
        $nc = min($nc, 200); $cols = array();
        for ($i = 0; $i < $nc; $i++) { $m = $st->getColumnMeta($i); $cols[] = is_array($m) && isset($m['name']) ? (string)$m['name'] : ('c' . $i); }
        $rows = array(); $typed = null;
        if (in_array($kw, array('select', 'with', 'values'), true)) {
          // PDO tidak membedakan BLOB dari teks, jadi pernyataan dibungkus: kolom dinamai ulang menurut urutan (c0, c1, ...) dan SQLite sendiri yang menjawab typeof().
          // Tubuhnya hanya pernyataan pertama (tanpa ; dan komentar penutup); gagal membungkus = pakai jalur biasa di bawah.
          $names = array(); $sel = array();
          for ($i = 0; $i < $nc; $i++) { $names[] = 'c' . $i; $sel[] = 'typeof(c' . $i . ')'; $sel[] = 'CASE typeof(c' . $i . ") WHEN 'blob' THEN length(c" . $i . ') ELSE substr(CAST(c' . $i . ' AS TEXT), 1, 500) END'; }
          try {
            $ws = $pdo->prepare('WITH u(' . implode(',', $names) . ') AS (' . substr($sql, 0, $sc[2]) . "\n) SELECT " . implode(', ', $sel) . ' FROM u LIMIT 501');
            if ($ws->execute() && $ws->columnCount() === $nc * 2) { $typed = $ws; }
          } catch (Throwable $e) { $typed = null; }
        }
        if ($typed !== null) {
          while (($r = $typed->fetch(PDO::FETCH_NUM)) !== false) {
            if (count($rows) >= 500) { $res['more'] = true; break; }
            $row = array();
            for ($i = 0; $i < $nc; $i++) { $k = $r[$i * 2]; $v = $r[$i * 2 + 1]; $row[] = $k === 'null' ? null : ($k === 'blob' ? array('b' => (int)$v) : (string)$v); }
            $rows[] = $row;
          }
          $typed->closeCursor(); $st->closeCursor();
        } else {
          // EXPLAIN / RETURNING: tanpa typeof(); dianggap BLOB bila bukan UTF-8 sah atau berisi NUL.
          while (($r = $st->fetch(PDO::FETCH_NUM)) !== false) {
            if (count($rows) >= 500) { $res['more'] = true; break; }
            $row = array();
            for ($i = 0; $i < $nc; $i++) {
              $v = $r[$i];
              if ($v === null) $row[] = null;
              elseif (is_string($v) && (strpos($v, "\0") !== false || !mb_check_encoding($v, 'UTF-8'))) $row[] = array('b' => strlen($v));
              else $row[] = mb_substr((string)$v, 0, 500, 'UTF-8');
            }
            $rows[] = $row;
          }
        }
        $res['columns'] = $cols; $res['rows'] = $rows;
      } else { $res['changes'] = $st->rowCount(); }
      $st->closeCursor();
      if ($write) $pdo->commit();
    } catch (Throwable $e) {
      if ($write && $pdo->inTransaction()) { try { $pdo->rollBack(); } catch (Throwable $e2) {} }
      $m = strtolower($e->getMessage());
      if (strpos($m, 'locked') !== false || strpos($m, 'busy') !== false) fail('busy');
      if (strpos($m, 'readonly') !== false || strpos($m, 'read-only') !== false) fail('ro');
      out(array('ok' => false, 'code' => 'sql', 'msg' => clean_msg($e->getMessage())));
    }
    out($res);
  }
  if ($in['op'] === 'csv') { // P.7f: ekspor SATU tabel/tampilan sebagai CSV (base64). NULL = kosong, teks kosong = "", BLOB = heksa. Maks ~1 MB.
    $t = isset($in['table']) && is_string($in['table']) ? $in['table'] : '';
    if ($t === '' || strlen($t) > 200 || strpos($t, "\0") !== false) fail('bad');
    $pdo = new PDO('sqlite:' . $p, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5));
    $pdo->exec('PRAGMA query_only=1');
    $st = $pdo->prepare("SELECT type FROM sqlite_master WHERE type IN ('table','view') AND name = ?"); $st->execute(array($t));
    if ($st->fetchColumn() === false) fail('notable');
    $cols = array();
    foreach ($pdo->query('PRAGMA table_info(' . q($t) . ')')->fetchAll(PDO::FETCH_ASSOC) as $c) { $cols[] = (string)$c['name']; if (count($cols) >= 200) break; }
    if (!$cols) fail('notable');
    $sel = array();
    foreach ($cols as $c) { $sel[] = 'typeof(' . q($c) . ')'; $sel[] = "CASE typeof(" . q($c) . ") WHEN 'blob' THEN hex(" . q($c) . ") ELSE " . q($c) . " END"; }
    $head = array(); foreach ($cols as $c) { $head[] = csv_field('text', $c); }
    $buf = implode(',', $head) . "\r\n";
    $rs = $pdo->query('SELECT ' . implode(', ', $sel) . ' FROM ' . q($t));
    while (($r = $rs->fetch(PDO::FETCH_NUM)) !== false) {
      $f = array(); for ($i = 0; $i < count($cols); $i++) { $f[] = csv_field((string)$r[$i * 2], $r[$i * 2 + 1]); }
      $buf .= implode(',', $f) . "\r\n";
      if (strlen($buf) > 1000000) fail('toobig');
    }
    out(array('ok' => true, 'size' => strlen($buf), 'data' => base64_encode($buf)));
  }

  if ($in['op'] === 'reset') { // Reset data: hapus SEMUA baris di semua tabel biasa, struktur (tabel, kolom, indeks, trigger, tampilan) tetap; trigger tidak ikut aktif (tidak mengisi log, tidak menolak). Satu transaksi: gagal = tidak ada yang berubah.
    $pdo = new PDO('sqlite:' . $p, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5));
    $pdo->exec('PRAGMA foreign_keys=0'); // semuanya dikosongkan, jadi urutan tidak penting; PRAGMA ini tidak berlaku di dalam transaksi, maka dipasang sebelum begin
    $all = $pdo->query("SELECT name, sql FROM sqlite_master WHERE type = 'table'")->fetchAll(PDO::FETCH_ASSOC);
    $virt = array(); $hasSeq = false;
    foreach ($all as $r) { $n = (string)$r['name']; if ($n === 'sqlite_sequence') $hasSeq = true; if (stripos(ltrim((string)$r['sql']), 'CREATE VIRTUAL TABLE') === 0) $virt[] = $n; }
    $todo = array();
    foreach ($all as $r) {
      $n = (string)$r['name'];
      if (strpos($n, 'sqlite_') === 0) continue;                 // tabel internal (sqlite_sequence ditangani terpisah)
      $shadow = false; foreach ($virt as $v) { if ($n !== $v && strpos($n, $v . '_') === 0) { $shadow = true; break; } }
      if ($shadow) continue;                                     // tabel bayangan FTS / rtree: dikosongkan lewat tabel virtualnya, tidak boleh disentuh langsung
      $todo[] = $n;
    }
    // Trigger dicopot sementara DI DALAM transaksi dan dipasang lagi persis seperti semula: tanpa ini, trigger DELETE yang mencatat ke tabel log mengisi log lagi
    // selagi baris dihapus (log tidak pernah bersih), dan trigger yang menolak hapus menggagalkan reset. DDL SQLite ikut transaksi, jadi gagal = semuanya kembali.
    $trg = $pdo->query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")->fetchAll(PDO::FETCH_ASSOC);
    $rows = 0; $tabs = 0;
    try {
      $pdo->beginTransaction();
      foreach ($trg as $t) { $pdo->exec('DROP TRIGGER ' . q((string)$t['name'])); }
      foreach ($todo as $n) { $rows += (int)$pdo->exec('DELETE FROM ' . q($n)); $tabs++; }
      if ($hasSeq) $pdo->exec('DELETE FROM sqlite_sequence');    // hitungan AUTOINCREMENT mulai dari 1 lagi
      foreach ($trg as $t) { $pdo->exec((string)$t['sql']); }
      $pdo->commit();
    } catch (Throwable $e) {
      if ($pdo->inTransaction()) { try { $pdo->rollBack(); } catch (Throwable $e2) {} }
      $m = strtolower($e->getMessage());
      if (strpos($m, 'locked') !== false || strpos($m, 'busy') !== false) fail('busy');
      if (strpos($m, 'readonly') !== false || strpos($m, 'read-only') !== false) fail('ro');
      out(array('ok' => false, 'code' => 'sql', 'msg' => clean_msg($e->getMessage())));
    }
    try { $pdo->exec('VACUUM'); } catch (Throwable $e) {}      // kembalikan ruang berkas; gagal (mis. dipakai proses lain) tidak apa-apa, datanya sudah kosong
    out(array('ok' => true, 'tables' => $tabs, 'rows' => $rows));
  }

  $wr = in_array($in['op'], array('insert', 'update', 'delete'), true);
  $pdo = new PDO('sqlite:' . $p, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5));
  if ($in['op'] === 'checkpoint') { // P.7e: gabungkan WAL ke berkas utama agar ekspor lengkap; tidak mengubah isi
    try { $pdo->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetchAll(); } catch (Throwable $e) { fail('busy'); }
    out(array('ok' => true));
  }
  if ($wr) $pdo->exec('PRAGMA foreign_keys=1'); else $pdo->exec('PRAGMA query_only=1'); // hanya op tulis yang boleh menulis
  if ($wr) {
    $t = isset($in['table']) && is_string($in['table']) ? $in['table'] : '';
    if ($t === '' || strlen($t) > 200 || strpos($t, "\0") !== false) fail('bad');
    if (strpos($t, 'sqlite_') === 0) fail('readonly');
    $st = $pdo->prepare("SELECT type FROM sqlite_master WHERE type IN ('table','view') AND name = ?"); $st->execute(array($t));
    $ty = $st->fetchColumn(); if ($ty === false) fail('notable'); if ($ty !== 'table') fail('readonly');
    $cols = array();
    foreach ($pdo->query('PRAGMA table_info(' . q($t) . ')')->fetchAll(PDO::FETCH_ASSOC) as $c) { $cols[] = (string)$c['name']; if (count($cols) >= 200) break; }
    if (!$cols) fail('notable');
    $names = array(); $args = array();
    if (isset($in['values'])) {
      if (!is_array($in['values']) || count($in['values']) > 200) fail('bad');
      foreach ($in['values'] as $pr) {
        if (!is_array($pr) || count($pr) !== 2 || !isset($pr[0]) || !is_string($pr[0]) || !array_key_exists(1, $pr)) fail('bad');
        if (!in_array($pr[0], $cols, true)) fail('badcol');
        if (in_array($pr[0], $names, true)) fail('bad');
        if ($pr[1] !== null && !is_string($pr[1])) fail('bad');
        $names[] = $pr[0]; $args[] = $pr[1];
      }
    }
    $op = $in['op'];
    if ($op === 'insert') {
      if ($names) {
        $sql = 'INSERT INTO ' . q($t) . ' (' . implode(', ', array_map('q', $names)) . ') VALUES (' . implode(', ', array_fill(0, count($names), '?')) . ')';
      } else { $sql = 'INSERT INTO ' . q($t) . ' DEFAULT VALUES'; }
      $pdo->prepare($sql)->execute($args);
      out(array('ok' => true, 'n' => 1, 'rid' => (string)$pdo->lastInsertId()));
    }
    $alias = rid_alias($pdo, $t, $cols); if ($alias === null) fail('norowid');
    $rid = isset($in['rid']) && is_string($in['rid']) ? $in['rid'] : '';
    if (!preg_match('/^-?[0-9]{1,19}$/D', $rid)) fail('bad');
    if ($op === 'update') {
      if (!$names) fail('bad');
      $set = array(); foreach ($names as $n) { $set[] = q($n) . ' = ?'; }
      $args[] = $rid;
      $s = $pdo->prepare('UPDATE ' . q($t) . ' SET ' . implode(', ', $set) . ' WHERE ' . $alias . ' = ?'); $s->execute($args);
    } else {
      if ($names) fail('bad');
      $s = $pdo->prepare('DELETE FROM ' . q($t) . ' WHERE ' . $alias . ' = ?'); $s->execute(array($rid));
    }
    if ($s->rowCount() !== 1) fail('norow');
    out(array('ok' => true, 'n' => 1));
  }
  if ($in['op'] === 'rows') {
    $t = isset($in['table']) && is_string($in['table']) ? $in['table'] : '';
    if ($t === '' || strlen($t) > 200 || strpos($t, "\0") !== false) fail('bad');
    $st = $pdo->prepare("SELECT type FROM sqlite_master WHERE type IN ('table','view') AND name = ?"); $st->execute(array($t));
    $ty = $st->fetchColumn(); if ($ty === false) fail('notable');
    $cols = array();
    foreach ($pdo->query('PRAGMA table_info(' . q($t) . ')')->fetchAll(PDO::FETCH_ASSOC) as $c) { $cols[] = (string)$c['name']; if (count($cols) >= 200) break; }
    if (!$cols) fail('notable');
    $rid = $ty === 'table' ? rid_alias($pdo, $t, $cols) : null;
    $limit = isset($in['limit']) && is_int($in['limit']) ? max(1, min(500, $in['limit'])) : 50;
    $offset = isset($in['offset']) && is_int($in['offset']) ? max(0, min(10000000, $in['offset'])) : 0;
    $order = '';
    if (isset($in['sort']) && $in['sort'] !== null) {
      if (!is_string($in['sort']) || !in_array($in['sort'], $cols, true)) fail('badcol');
      $order = ' ORDER BY ' . q($in['sort']) . ((isset($in['dir']) && $in['dir'] === 'desc') ? ' DESC' : ' ASC');
    }
    $where = ''; $args = array();
    if (isset($in['q']) && is_string($in['q']) && $in['q'] !== '') {
      $needle = '%' . addcslashes(substr($in['q'], 0, 100), '%_\\') . '%'; $parts = array();
      foreach ($cols as $c) { $parts[] = "(typeof(" . q($c) . ") <> 'blob' AND CAST(" . q($c) . " AS TEXT) LIKE ? ESCAPE '\\')"; $args[] = $needle; }
      $where = ' WHERE ' . implode(' OR ', $parts);
    }
    $sel = array();
    foreach ($cols as $c) { $sel[] = 'typeof(' . q($c) . ')'; $sel[] = "CASE typeof(" . q($c) . ") WHEN 'blob' THEN length(" . q($c) . ") ELSE substr(CAST(" . q($c) . " AS TEXT), 1, 500) END"; }
    if ($rid !== null) $sel[] = $rid;
    $total = null;
    if ($ty === 'table') { $cs = $pdo->prepare('SELECT COUNT(*) FROM ' . q($t) . $where); $cs->execute($args); $total = (int)$cs->fetchColumn(); }
    $rs = $pdo->prepare('SELECT ' . implode(', ', $sel) . ' FROM ' . q($t) . $where . $order . ' LIMIT ' . ($limit + 1) . ' OFFSET ' . $offset);
    $rs->execute($args);
    $out = array(); $ids = array(); $more = false;
    while (($r = $rs->fetch(PDO::FETCH_NUM)) !== false) {
      if (count($out) >= $limit) { $more = true; break; }
      $row = array();
      for ($i = 0; $i < count($cols); $i++) {
        $k = $r[$i * 2]; $v = $r[$i * 2 + 1];
        $row[] = $k === 'null' ? null : ($k === 'blob' ? array('b' => (int)$v) : (string)$v);
      }
      $out[] = $row; $ids[] = $rid !== null ? (string)$r[count($cols) * 2] : null;
    }
    out(array('ok' => true, 'columns' => $cols, 'rows' => $out, 'total' => $total, 'more' => $more, 'view' => $ty === 'view', 'ids' => $ids, 'rw' => $rid !== null));
  }
  $rows = $pdo->query("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name LIMIT 501")->fetchAll(PDO::FETCH_ASSOC);
  $truncated = count($rows) > 500; if ($truncated) array_pop($rows);
  $tables = array();
  foreach ($rows as $r) {
    $name = (string)$r['name']; $isView = $r['type'] === 'view';
    $cols = array();
    foreach ($pdo->query('PRAGMA table_info(' . q($name) . ')')->fetchAll(PDO::FETCH_ASSOC) as $c) {
      $cols[] = array('name' => (string)$c['name'], 'type' => (string)$c['type'], 'notnull' => (int)$c['notnull'] === 1, 'pk' => (int)$c['pk'], 'default' => $c['dflt_value'] === null ? null : (string)$c['dflt_value']);
      if (count($cols) >= 200) break;
    }
    $n = null;
    if (!$isView) { $n = (int)$pdo->query('SELECT COUNT(*) FROM ' . q($name))->fetchColumn(); } // tampilan (view) tidak dihitung: bisa mahal
    $tables[] = array('name' => $name, 'view' => $isView, 'internal' => strpos($name, 'sqlite_') === 0, 'rows' => $n, 'columns' => $cols);
  }
  out(array('ok' => true, 'tables' => $tables, 'truncated' => $truncated));
} catch (Throwable $e) {
  $m = strtolower($e->getMessage());
  fail(strpos($m, 'locked') !== false || strpos($m, 'busy') !== false ? 'busy' : (strpos($m, 'not a database') !== false || strpos($m, 'malformed') !== false ? 'notdb' : (strpos($m, 'constraint') !== false ? 'constraint' : (strpos($m, 'readonly') !== false ? 'ro' : 'io'))));
}
