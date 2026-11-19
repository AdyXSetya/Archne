package com.xyraori.archne;

import android.Manifest;
import android.content.ContentResolver;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Tambahan Kirim Langsung dari HP (memilih berkas dengan path aslinya):
 *  access() -> "ok" | "no"  : apakah Archne boleh membaca berkas lewat path (Android 11+: akses semua berkas; lebih lama: izin penyimpanan).
 *  askAccess() -> "asked"      : membuka pengaturan izin (Android 11+) atau dialog izin; pengguna kembali ke aplikasi lalu mengulang.
 *  pick(dxoutRoot, job) -> [path,...] : pemilih berkas sistem (banyak berkas). Path asli dipakai langsung; berkas yang path-nya tidak bisa dipastikan
 *     (Google Drive dll.) atau tidak terbaca disalin ke <dxoutRoot>/<job>/<acak>/<nama>, yang dihapus inti Node saat sesinya berakhir. Dibatalkan = galat "cancel".
 */
/** save(srcPath, name, mime, sub): salin berkas ke folder Download publik, di subfolder `sub` bila diisi (mis. file_transfer/Proyek). Mengembalikan nama akhir berkas. */
// Galat yang bisa sampai ke pengguna dikirim sebagai KODE "e:<nama>" (mis. "e:storageFull"), bukan kalimat: halaman pembungkus (www/index.html, kamus W,
// kunci "e_<nama>") yang menerjemahkannya sesuai bahasa aplikasi. Pesan sistem mentah (e.getMessage()) dan "cancel" diteruskan apa adanya.
public class ArchneDownloads extends CordovaPlugin {
  private static final int REQ_STORAGE = 7301, REQ_PICK = 7302, REQ_READ = 7303;
  private String pSrc, pName, pMime, pSub, pickRoot, pickJob;
  private CallbackContext pCb, pickCb, askCb;

  @Override
  public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
    if ("access".equals(action)) { cb.success(canReadPaths() ? "ok" : "no"); return true; }
    if ("askAccess".equals(action)) { askAccess(cb); return true; }
    if ("pick".equals(action)) { startPick(args.getString(0), args.getString(1), cb); return true; }
    if (!"save".equals(action)) return false;
    final String src = args.getString(0), name = args.getString(1);
    final String mime = args.isNull(2) ? "application/octet-stream" : args.getString(2);
    final String sub = args.length() > 3 && !args.isNull(3) ? cleanSub(args.getString(3)) : "";
    if (Build.VERSION.SDK_INT < 29 && !cordova.hasPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
      pSrc = src; pName = name; pMime = mime; pSub = sub; pCb = cb;
      cordova.requestPermission(this, REQ_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE);
      return true;
    }
    run(src, name, mime, sub, cb);
    return true;
  }

  @Override
  public void onRequestPermissionResult(int code, String[] perms, int[] results) {
    if (code == REQ_READ && askCb != null) { CallbackContext a = askCb; askCb = null; a.success("asked"); return; }
    if (code != REQ_STORAGE || pCb == null) return;
    CallbackContext cb = pCb; String s = pSrc, n = pName, m = pMime, u = pSub;
    pCb = null; pSrc = null; pName = null; pMime = null; pSub = null;
    if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) run(s, n, m, u == null ? "" : u, cb);
    else cb.error("e:permDenied");
  }

  private void run(final String src, final String name, final String mime, final String sub, final CallbackContext cb) {
    cordova.getThreadPool().execute(new Runnable() {
      public void run() {
        try { cb.success(save(src, name, mime, sub)); }
        catch (Exception e) { cb.error(String.valueOf(e.getMessage())); }
      }
    });
  }

  // ---- Memilih berkas dengan path asli (Kirim Langsung dari HP) ----
  private boolean canReadPaths() {
    if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
    return cordova.hasPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE); // sudah dideklarasikan file-opener2; satu grup dengan baca
  }

  private void askAccess(CallbackContext cb) {
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        Activity a = cordova.getActivity();
        Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + a.getPackageName()));
        try { a.startActivity(i); }
        catch (RuntimeException e) { a.startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)); }
        cb.success("asked");
      } else {
        askCb = cb;
        cordova.requestPermission(this, REQ_READ, Manifest.permission.WRITE_EXTERNAL_STORAGE);
      }
    } catch (RuntimeException e) { cb.error(String.valueOf(e.getMessage())); }
  }

  private void startPick(String root, String job, CallbackContext cb) {
    if (root == null || root.isEmpty() || !new File(root).isAbsolute() || job == null || !job.matches("[A-Za-z0-9_-]{1,40}")) { cb.error("e:badArgs"); return; }
    pickRoot = root; pickJob = job; pickCb = cb;
    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    i.addCategory(Intent.CATEGORY_OPENABLE);
    i.setType("*/*");
    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    cordova.startActivityForResult(this, i, REQ_PICK);
  }

  @Override
  public void onActivityResult(int req, int res, final Intent data) {
    if (req != REQ_PICK || pickCb == null) return;
    final CallbackContext cb = pickCb; final String root = pickRoot, job = pickJob;
    pickCb = null; pickRoot = null; pickJob = null;
    if (res != Activity.RESULT_OK || data == null) { cb.error("cancel"); return; }
    final java.util.ArrayList<Uri> uris = new java.util.ArrayList<Uri>();
    ClipData cd = data.getClipData();
    if (cd != null) for (int k = 0; k < cd.getItemCount(); k++) uris.add(cd.getItemAt(k).getUri());
    else if (data.getData() != null) uris.add(data.getData());
    cordova.getThreadPool().execute(new Runnable() {
      public void run() {
        try {
          JSONArray out = new JSONArray();
          for (Uri u : uris) out.put(pathOrCopy(u, root, job));
          cb.success(out);
        } catch (Exception e) { cb.error(String.valueOf(e.getMessage())); }
      }
    });
  }

  private String pathOrCopy(Uri uri, String root, String job) throws IOException {
    String p = realPath(uri);
    if (p != null) return p;
    Context ctx = cordova.getActivity().getApplicationContext();
    ContentResolver r = ctx.getContentResolver();
    String name = null;
    Cursor c = null;
    try {
      c = r.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
      if (c != null && c.moveToFirst()) name = c.getString(0);
    } catch (RuntimeException e) { /* nama cadangan di bawah */ } finally { if (c != null) c.close(); }
    String safe = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").replace("..", "_").trim();
    if (safe.isEmpty() || safe.startsWith(".")) safe = "berkas" + safe;
    File dir = new File(new File(root, job), Long.toHexString(System.nanoTime()));
    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("e:tmpDir");
    File dst = new File(dir, safe);
    InputStream is = r.openInputStream(uri);
    if (is == null) throw new IOException("e:readPick");
    OutputStream os = null;
    try {
      os = new FileOutputStream(dst);
      byte[] buf = new byte[65536]; int n;
      while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
      os.flush();
    } catch (IOException e) {
      dst.delete(); dir.delete();
      String m = String.valueOf(e.getMessage());
      throw new IOException(m.contains("ENOSPC") ? "e:storageFull" : m);
    } finally {
      try { is.close(); } catch (IOException x) { /* abaikan */ }
      if (os != null) try { os.close(); } catch (IOException x) { /* abaikan */ }
    }
    return dst.getAbsolutePath();
  }

  /** Path asli berkas pilihan, atau null bila tidak bisa dipastikan / tidak terbaca (maka berkas disalin). */
  private String realPath(Uri uri) {
    Context ctx = cordova.getActivity().getApplicationContext();
    try {
      if ("file".equals(uri.getScheme())) return readable(uri.getPath());
      if (DocumentsContract.isDocumentUri(ctx, uri)) {
        String auth = uri.getAuthority(), id = DocumentsContract.getDocumentId(uri);
        if ("com.android.externalstorage.documents".equals(auth)) {
          String[] q = id.split(":", 2);
          if (q.length == 2) {
            File base = "primary".equalsIgnoreCase(q[0]) ? Environment.getExternalStorageDirectory() : new File("/storage/" + q[0]);
            return readable(new File(base, q[1]).getPath());
          }
        } else if ("com.android.providers.downloads.documents".equals(auth)) {
          if (id.startsWith("raw:")) return readable(id.substring(4));
          String num = id.startsWith("msf:") ? id.substring(4) : id;
          long n = Long.parseLong(num);
          String d = dataOf(ContentUris.withAppendedId(Build.VERSION.SDK_INT >= 29 ? MediaStore.Downloads.EXTERNAL_CONTENT_URI : Uri.parse("content://downloads/public_downloads"), n));
          return readable(d);
        } else if ("com.android.providers.media.documents".equals(auth)) {
          String[] q = id.split(":", 2);
          if (q.length == 2) {
            Uri base = "image".equals(q[0]) ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI : "video".equals(q[0]) ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : "audio".equals(q[0]) ? MediaStore.Audio.Media.EXTERNAL_CONTENT_URI : null;
            if (base != null) return readable(dataOf(ContentUris.withAppendedId(base, Long.parseLong(q[1]))));
          }
        }
        return null;
      }
      if ("content".equals(uri.getScheme())) return readable(dataOf(uri));
    } catch (RuntimeException e) { /* tidak bisa dipastikan: salin */ }
    return null;
  }

  private String dataOf(Uri u) {
    Cursor c = null;
    try {
      c = cordova.getActivity().getContentResolver().query(u, new String[] { MediaStore.MediaColumns.DATA }, null, null, null);
      if (c != null && c.moveToFirst()) return c.getString(0);
    } catch (RuntimeException e) { /* tidak ada kolom path */ } finally { if (c != null) c.close(); }
    return null;
  }

  private static String readable(String p) {
    if (p == null) return null;
    File f = new File(p);
    return f.isFile() && f.canRead() ? f.getAbsolutePath() : null;
  }

  /** Subfolder dari JS: segmen dipisah '/', tanpa '', '.', '..', dan karakter terlarang. Hasil kosong = langsung di Download. */
  private static String cleanSub(String raw) {
    StringBuilder b = new StringBuilder();
    if (raw == null) return "";
    for (String seg : raw.replace('\\', '/').split("/")) {
      String t = seg.replaceAll("[:*?\"<>|\\x00-\\x1f]", "_").trim();
      if (t.isEmpty() || t.equals(".") || t.equals("..")) continue;
      if (b.length() > 0) b.append('/');
      b.append(t);
    }
    return b.toString();
  }

  private String save(String src, String name, String mime, String sub) throws IOException {
    File in = new File(src);
    if (!in.isFile()) throw new IOException("e:srcGone");
    String safe = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
    if (safe.isEmpty()) safe = "berkas";
    Context ctx = cordova.getActivity().getApplicationContext();
    if (Build.VERSION.SDK_INT >= 29) {
      ContentResolver r = ctx.getContentResolver();
      ContentValues v = new ContentValues();
      v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
      v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
      v.put(MediaStore.MediaColumns.RELATIVE_PATH, sub.isEmpty() ? Environment.DIRECTORY_DOWNLOADS : Environment.DIRECTORY_DOWNLOADS + "/" + sub);
      v.put(MediaStore.MediaColumns.IS_PENDING, 1);
      Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
      if (uri == null) throw new IOException("e:mediaDenied");
      try {
        OutputStream out = r.openOutputStream(uri);
        if (out == null) throw new IOException("e:writeDl");
        copy(in, out);
        ContentValues d = new ContentValues();
        d.put(MediaStore.MediaColumns.IS_PENDING, 0);
        r.update(uri, d, null, null);
      } catch (IOException | RuntimeException e) {
        try { r.delete(uri, null, null); } catch (RuntimeException x) { /* abaikan */ }
        throw e instanceof IOException ? (IOException) e : new IOException(e.getMessage());
      }
      return safe; // bila nama sudah ada, Android menambah " (1)" sendiri
    }
    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
    if (!sub.isEmpty()) dir = new File(dir, sub);
    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("e:dlDir");
    File dst = new File(dir, safe);
    int dot = safe.lastIndexOf('.');
    String stem = dot > 0 ? safe.substring(0, dot) : safe, ext = dot > 0 ? safe.substring(dot) : "";
    for (int i = 1; dst.exists() && i < 1000; i++) dst = new File(dir, stem + " (" + i + ")" + ext);
    if (dst.exists()) throw new IOException("e:tooMany");
    try { copy(in, new java.io.FileOutputStream(dst)); } catch (IOException e) { dst.delete(); throw e; }
    return dst.getName();
  }

  private static void copy(File in, OutputStream out) throws IOException {
    InputStream is = new FileInputStream(in);
    try {
      byte[] buf = new byte[65536]; int n;
      while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
      out.flush();
    } finally {
      try { is.close(); } catch (IOException x) { /* abaikan */ }
      out.close();
    }
  }
}
