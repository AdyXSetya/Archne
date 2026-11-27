<?php
// Info mesin PHP milik APLIKASI (0.34.0 U3 Dasbor). Pengganti phpinfo() yang SENGAJA disaring: hanya versi, daftar ekstensi, dan beberapa batas.
// Dimuat ke /sys oleh Worker dan hanya dijalankan lewat host (sys:true), tidak pernah lewat router atau lw_req.
// TIDAK PERNAH dikeluarkan: jalur disk (include_path, session.save_path, extension_dir, __FILE__ ...), variabel lingkungan, ini lain, daftar fungsi yang dimatikan.
ini_set('display_errors', '0');
error_reporting(0);
header('Content-Type: application/json; charset=utf-8');

function ver($s) { return is_string($s) && preg_match('/^[0-9A-Za-z.\-+_]{1,40}$/', $s) ? $s : ''; }

$ext = array();
foreach (get_loaded_extensions() as $e) {
  $e = strtolower((string)$e);
  if (preg_match('/^[a-z0-9_]{1,30}$/', $e)) $ext[] = $e;
}
sort($ext);
$ext = array_slice($ext, 0, 100);

$sqlite = '';
if (class_exists('SQLite3')) { $v = SQLite3::version(); $sqlite = ver(isset($v['versionString']) ? $v['versionString'] : ''); }

// Hanya nilai ukuran / angka; nilai lain dibuang.
$lim = array();
foreach (array('memory_limit', 'max_execution_time', 'upload_max_filesize', 'post_max_size', 'max_input_vars') as $k) {
  $v = ini_get($k);
  $lim[$k] = is_string($v) && preg_match('/^-?[0-9]{1,12}[KMGkmg]?$/', $v) ? $v : '';
}

echo json_encode(array(
  'ok' => true,
  'php' => ver(PHP_VERSION),
  'sapi' => 'php-wasm',
  'sqlite' => $sqlite,
  'ext' => $ext,
  'mysqli' => in_array('mysqli', $ext, true),
  'limits' => $lim,
), JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_UNICODE);
