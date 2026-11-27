package com.xyraori.archne;

import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;
import android.view.View;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  /** Mode tonton layar penuh (layar yang dibagikan lawan bicara): landscape dua arah + bilah sistem tersembunyi. Lihat viewer(). */
  private boolean viewerOn = false;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Reset data yang belum selesai (sistem menolak hapus-penyimpanan): sapu SEBELUM inti Node dan WebView memakai datanya.
    ArchneExit.wipeIfPending(this);
    // Plugin lokal harus didaftarkan sebelum super.onCreate.
    registerPlugin(ArchneAudio.class);
    registerPlugin(ArchneDownloads.class);
    registerPlugin(ArchneBackground.class);
    registerPlugin(ArchneScreen.class);
    super.onCreate(savedInstanceState);
    stripSiteBridges();
    edgeToEdge();
    ring(getIntent());
  }

  /**
   * Spike A.2 (HP asli, 23 Nov 2026): CapacitorCookies dan CapacitorHttp memanggil addJavascriptInterface di load() TANPA syarat
   * (config `enabled:false` hanya mematikan penambalan JS, bukan pendaftaran objeknya), dan addJavascriptInterface menyuntikkan objek ke SEMUA frame,
   * termasuk iframe situs lintas-origin ber-sandbox. Akibatnya situs bisa memanggil CapacitorCookiesAndroidInterface.setCookie(domain, nilai) (menulis cookie
   * ke CookieManager native untuk URL mana pun, mis. origin UI) dan isEnabled(). Archne tidak memakai kedua jalur itu (config bawaan = nonaktif, dan native-bridge.js
   * menjaganya dengan `typeof ... !== 'undefined'`), jadi objeknya dicabut. Jembatan sebenarnya (androidBridge) memakai addWebMessageListener dengan daftar origin dan
   * hanya main frame, jadi tidak ikut bocor (terbukti di log HP: androidBridge tidak terlihat dari situs).
   * Pencabutan berlaku untuk dokumen/frame yang dibuat sesudahnya; load() plugin berjalan di dalam super.onCreate (Bridge), sebelum halaman pertama selesai dimuat.
   * Dipanggil juga di onResume (idempoten) sebagai pengaman bila Bridge dibuat ulang.
   */
  private void stripSiteBridges() {
    try {
      if (getBridge() == null || getBridge().getWebView() == null) return;
      getBridge().getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
      getBridge().getWebView().removeJavascriptInterface("CapacitorHttpAndroidInterface");
    } catch (RuntimeException e) { /* tanpa pencabutan: uji penampil di HP akan menunjukkannya */ }
  }

  @Override
  public void onResume() {
    super.onResume();
    stripSiteBridges();
  }

  /**
   * Android 15+ memaksa tampilan sampai ke tepi layar (target 36): WebView akan tergambar di bawah status bar, bilah navigasi, takik kamera, dan keyboard.
   * Konten diberi jarak sebesar sisipan sistem (bilah + takik + keyboard) dan sisipan dianggap terpakai, jadi halaman dan iframe di dalamnya tidak perlu tahu.
   * Latar #0E141B (sama dengan UI) memenuhi area bilah; ikon bilah dibuat terang. Di Android lama (bilah buram, bukan tepi ke tepi) sisipannya sudah 0.
   */
  private void edgeToEdge() {
    try {
      WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
      final View root = findViewById(android.R.id.content);
      if (root == null) return;
      root.setBackgroundColor(0xFF0E141B);
      ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
        // Mode tonton: bilah sistem tersembunyi dan video memenuhi layar; yang tetap diberi jarak hanya keyboard dan takik kamera (di landscape takik ada di sisi pendek,
        // jadi video tidak tertutup; sisinya hitam menyatu dengan latar mode tonton).
        int types = viewerOn ? (WindowInsetsCompat.Type.ime() | WindowInsetsCompat.Type.displayCutout()) : (WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
        Insets b = insets.getInsets(types);
        v.setPadding(b.left, b.top, b.right, b.bottom);
        return WindowInsetsCompat.CONSUMED;
      });
      WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), root);
      if (c != null) { c.setAppearanceLightStatusBars(false); c.setAppearanceLightNavigationBars(false); }
      ViewCompat.requestApplyInsets(root);
    } catch (RuntimeException e) { /* tampilan tetap jalan, hanya tanpa jarak otomatis */ }
  }

  /**
   * Mode tonton layar penuh. on=true: orientasi dikunci ke landscape yang mengikuti sensor (memutar HP ke kiri atau kanan membalik tampilan,
   * potret tidak dipakai), bilah status/navigasi disembunyikan (usap dari tepi memunculkannya sebentar), dan video boleh sampai ke area takik.
   * on=false: orientasi kembali ke pengaturan sistem, bilah dan jarak takik pulih. Aman dipanggil berulang. Dipanggil plugin ArchneBackground.viewer.
   */
  void viewer(boolean on) {
    viewerOn = on;
    try {
      setRequestedOrientation(on ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
      if (Build.VERSION.SDK_INT >= 28) {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.layoutInDisplayCutoutMode = on ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
        getWindow().setAttributes(lp);
      }
      WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
      if (c != null) {
        if (on) { c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE); c.hide(WindowInsetsCompat.Type.systemBars()); }
        else c.show(WindowInsetsCompat.Type.systemBars());
      }
      View root = findViewById(android.R.id.content);
      if (root != null) {
        root.setBackgroundColor(on ? 0xFF000000 : 0xFF0E141B); // hitam selama mode tonton (tanpa garis aneh di tepi takik); latar UI kembali saat keluar
        ViewCompat.requestApplyInsets(root);
      }
    } catch (RuntimeException e) { /* tampilan biasa tetap jalan; hanya tanpa layar penuh */ }
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    ring(intent);
  }

  /** Dibuka oleh layar penuh panggilan masuk: tampil di atas layar kunci dan menyalakan layar. Dicabut lagi di onStop (chat tidak boleh terbuka di atas layar kunci). */
  private void ring(Intent i) {
    if (i == null || !i.getBooleanExtra(ArchneService.EXTRA_RING, false)) return;
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
  }

  // ---- Picture-in-Picture (panggilan video): tombol Home tidak mematikan kamera, panggilan mengecil jadi jendela mengambang ----
  private boolean canPip() {
    return Build.VERSION.SDK_INT >= 26 && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
  }

  private PictureInPictureParams pipParams(boolean auto) {
    PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(new Rational(9, 16));
    if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(auto);
    return b.build();
  }

  /** Dipanggil plugin ArchneBackground.pip: siaga (panggilan video aktif) atau tidak. Android 12+: masuk PiP otomatis lewat gestur Home. */
  void pipArm(boolean on) {
    if (!canPip()) return;
    try { setPictureInPictureParams(pipParams(on)); } catch (RuntimeException e) { /* jendela belum siap: onUserLeaveHint tetap jadi cadangan */ }
  }

  boolean pipActive() {
    return Build.VERSION.SDK_INT >= 26 && isInPictureInPictureMode();
  }

  /** Panggilan selesai saat jendela PiP masih tampil: tutup jendelanya (aplikasi tetap hidup di latar belakang, tidak di-finish). */
  void pipClose() {
    if (pipActive()) moveTaskToBack(true);
  }

  @Override
  protected void onUserLeaveHint() {
    super.onUserLeaveHint();
    if (!ArchneBackground.pipWanted || !canPip() || pipActive()) return;
    try { enterPictureInPictureMode(pipParams(false)); } catch (RuntimeException e) { /* tidak apa-apa: kamera dimatikan seperti biasa */ }
  }

  @Override
  public void onPictureInPictureModeChanged(boolean inPip, Configuration cfg) {
    super.onPictureInPictureModeChanged(inPip, cfg);
    if (inPip && getBridge() != null && getBridge().getWebView() != null) {
      // WebView tidak boleh ikut dijeda: video dan suara panggilan harus tetap jalan di jendela kecil.
      getBridge().getWebView().onResume();
      getBridge().getWebView().resumeTimers();
    }
    ArchneBackground.pipChanged(inPip);
    // Jalur kedua ke halaman pembungkus: kejadian window 'archnepip' (tidak bergantung pada listener plugin).
    try { if (getBridge() != null) getBridge().triggerWindowJSEvent("archnepip", inPip ? "{\"on\":true}" : "{\"on\":false}"); } catch (RuntimeException e) { /* cukup jalur plugin */ }
  }

  /**
   * Lintas jaringan (MQTT + WebRTC) berjalan di WebView. Android menjeda WebView saat aplikasi ke latar belakang (timer berhenti, WebSocket putus).
   * Selama ArchneBackground.keepAlive menyala, WebView dilanjutkan lagi (sama seperti PiP). Proses sendiri dijaga layanan latar depan.
   * Idempoten; aman dipanggil kapan saja. Tidak berbuat apa-apa bila keepAlive mati (perilaku bawaan).
   */
  void keepWebView() {
    if (!ArchneBackground.keepAlive) return;
    try {
      if (getBridge() == null || getBridge().getWebView() == null) return;
      getBridge().getWebView().onResume();
      getBridge().getWebView().resumeTimers();
    } catch (RuntimeException e) { /* gagal menjaga = perilaku bawaan Android */ }
  }

  @Override
  public void onPause() {
    super.onPause();
    keepWebView();
    // Jeda bisa diterapkan Chromium sesudah onPause kembali: tegaskan sekali lagi sebentar kemudian.
    if (ArchneBackground.keepAlive) new Handler(Looper.getMainLooper()).postDelayed(new Runnable() { @Override public void run() { keepWebView(); } }, 500);
  }

  @Override
  public void onStop() {
    super.onStop();
    keepWebView();
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(false); setTurnScreenOn(false); }
  }
}
