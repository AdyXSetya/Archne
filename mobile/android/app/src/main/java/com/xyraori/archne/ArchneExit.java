package com.xyraori.archne;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.webkit.WebStorage;

import java.io.File;

/**
 * Keluar dan Reset data (Pengaturan > Aplikasi). Dipanggil plugin ArchneBackground.quit / reset SETELAH cangkang meminta inti Node berhenti rapi
 * (archne:quit -> archne:stopped), jadi tidak ada tulisan yang masih berjalan saat proses dimatikan atau datanya dihapus.
 *
 * quit: layanan latar dihentikan, notifikasi dibersihkan, tugas dihapus dari daftar terbaru, lalu proses dimatikan. Node berjalan di proses yang sama;
 *       tanpa pemusnahan proses ia tetap hidup dan aplikasi terus menerima pesan walau tampilannya sudah ditutup.
 * reset: sama seperti "Hapus penyimpanan" di pengaturan Android: ActivityManager.clearApplicationUserData() menghapus semua data aplikasi (identitas, obrolan, situs,
 *       pengaturan, data WebView) dan mematikan prosesnya. Berkas di folder Download publik tidak tersentuh. Bila sistem menolak, penanda "wipe_pending" disimpan,
 *       proses dimatikan, dan wipeIfPending() menyapu data saat peluncuran berikutnya (sebelum inti Node dimulai).
 */
final class ArchneExit {
  private static final String PREFS = "archne", KEY_WIPE = "wipe_pending";

  private ArchneExit() {}

  private static void stopAll(Context ctx) {
    ArchneBackground.pipWanted = false;
    ArchneBackground.keepAlive = false;
    ArchneService.port = 0; // loop notifikasi menganggur, layanan tidak dihidupkan ulang tanpa inti Node
    ArchneService.token = null;
    try { ctx.stopService(new Intent(ctx, ArchneService.class)); } catch (RuntimeException e) { /* tetap lanjut: proses dimatikan sesudah ini */ }
    try {
      NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm != null) nm.cancelAll();
    } catch (RuntimeException e) { /* abaikan */ }
  }

  private static void closeTask(final Activity a) {
    if (a == null) return;
    a.runOnUiThread(new Runnable() { @Override public void run() { try { a.finishAndRemoveTask(); } catch (RuntimeException e) { /* proses tetap dimatikan */ } } });
  }

  private static void killLater(long ms) {
    new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
      @Override public void run() { Process.killProcess(Process.myPid()); System.exit(0); }
    }, ms);
  }

  static void quit(Activity a) {
    Context ctx = a.getApplicationContext();
    stopAll(ctx);
    closeTask(a);
    killLater(400);
  }

  static void reset(Activity a) {
    Context ctx = a.getApplicationContext();
    // Penanda lebih dulu: bila hapus-penyimpanan dari sistem gagal atau terpotong, peluncuran berikutnya menyelesaikannya.
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_WIPE, true).commit();
    stopAll(ctx);
    boolean sys = false;
    try {
      ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
      sys = am != null && am.clearApplicationUserData();
    } catch (RuntimeException e) { /* jalur cadangan di bawah */ }
    closeTask(a);
    // sys=true: sistem mematikan prosesnya sendiri; pemusnahan di sini hanya jaring pengaman. sys=false: matikan sekarang, data disapu saat dibuka lagi.
    killLater(sys ? 4000 : 600);
  }

  /** Dipanggil MainActivity.onCreate sebelum apa pun dimuat. Tanpa penanda tidak berbuat apa-apa. */
  static void wipeIfPending(Context ctx) {
    SharedPreferences sp;
    try { sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); } catch (RuntimeException e) { return; }
    if (!sp.getBoolean(KEY_WIPE, false)) return;
    // Lokasi data inti Node: getFilesDir()/archne (mobile/shell/main.js: path.join(app.datadir(), 'archne')).
    try { rm(new File(ctx.getFilesDir(), "archne")); } catch (RuntimeException e) { /* dicoba lagi lewat penanda yang tersisa */ return; }
    try {
      File[] cache = ctx.getCacheDir().listFiles();
      if (cache != null) for (File f : cache) rm(f);
    } catch (RuntimeException e) { /* abaikan */ }
    try { WebStorage.getInstance().deleteAllData(); } catch (RuntimeException e) { /* localStorage lama (tema, bahasa) boleh tersisa */ }
    sp.edit().clear().commit(); // penanda dihapus TERAKHIR: gagal di tengah = dicoba lagi
  }

  private static void rm(File f) {
    try { if (!f.getCanonicalPath().equals(f.getAbsolutePath())) { f.delete(); return; } } catch (java.io.IOException e) { return; } // tautan simbolik: hapus tautannya, jangan ikuti
    File[] kids = f.isDirectory() ? f.listFiles() : null;
    if (kids != null) for (File k : kids) rm(k);
    f.delete();
  }
}
