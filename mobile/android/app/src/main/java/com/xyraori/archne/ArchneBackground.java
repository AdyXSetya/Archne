package com.xyraori.archne;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Semua jawaban berbentuk objek (lihat mobile/shell/index.html).
 * start({port, token, lang}): jalankan layanan latar depan yang mendengarkan kejadian 'notify' dari inti Node. lang = bahasa aplikasi ('en'|'id').
 * setLang({lang}): bahasa aplikasi berganti; teks native (channel, notifikasi layanan, tombol) ikut berganti. Lihat ArchneLang.
 * takeChat() -> {key}: kunci chat dari ketukan notifikasi terakhir ('' bila tidak ada).
 * takeAnswer() -> {cid}: id panggilan dari tombol "Jawab" di notifikasi panggilan masuk ('' bila tidak ada); UI lalu menjawabnya.
 * viewer({on}): mode tonton layar penuh untuk layar yang dibagikan lawan bicara. on=true: landscape dua arah (kiri/kanan mengikuti sensor) + bilah sistem tersembunyi; on=false: pulihkan orientasi dan bilah. Aman dipanggil berulang.
 * pip({on}): panggilan video aktif (on=true) / tidak (on=false). Selagi aktif, tombol Home membuat aplikasi masuk jendela Picture-in-Picture (kamera tetap hidup). on=false saat PiP tampil menutup jendelanya.
 * pipState() -> {on}: apakah aplikasi sedang dalam mode PiP. Kejadian 'pip' {on} dikirim tiap mode berubah.
 * batteryAsk({manual}) -> {value}: minta Android mengecualikan aplikasi dari penghematan baterai (dialog sistem). Tanpa manual hanya sekali seumur pemasangan.
 *   value: "ok" (sudah dikecualikan), "asked" (dialog dibuka), "skipped" (sudah pernah ditanya), "failed".
 */
@CapacitorPlugin(name = "ArchneBackground")
public class ArchneBackground extends Plugin {
  private static final int REQ_NOTIF = 7305;
  static final String EXTRA_CHAT = "archne_chat";
  static final String EXTRA_ANSWER = "archne_answer";
  static volatile String pendingChat = "";
  static volatile String pendingAnswer = "";
  static volatile boolean pipWanted = false;
  static volatile String dxout = ""; // folder salinan sementara Kirim Langsung; disimpan agar UI yang dibuka ulang bisa memakai inti Node yang masih hidup
  private static ArchneBackground inst;

  // load() dipanggil sekali saat jembatan Capacitor dibuat.
  @Override
  public void load() { inst = this; take(getActivity().getIntent()); }

  /** Dipanggil MainActivity saat mode PiP berubah; diteruskan ke pembungkus sebagai kejadian 'pip'. */
  static void pipChanged(boolean on) {
    ArchneBackground p = inst;
    if (p == null) return;
    JSObject o = new JSObject();
    o.put("on", on);
    p.notifyListeners("pip", o);
  }

  private static void take(Intent i) {
    if (i == null) return;
    if (i.hasExtra(EXTRA_CHAT)) pendingChat = String.valueOf(i.getStringExtra(EXTRA_CHAT));
    if (i.hasExtra(EXTRA_ANSWER)) pendingAnswer = String.valueOf(i.getStringExtra(EXTRA_ANSWER));
  }

  // Aplikasi dibuka ulang selagi layanan latar depan (dan inti Node) masih hidup: plugin Node membuat objek baru yang tidak pernah 'ready',
  // sehingga Node.send ditolak dan halaman menunggu selamanya. Port dan token disimpan di proses ini, jadi UI cukup menanyakannya di sini.
  @PluginMethod
  public void info(PluginCall call) {
    JSObject r = new JSObject();
    int p = ArchneService.port;
    String t = ArchneService.token;
    if (p > 0 && t != null && !t.isEmpty()) {
      r.put("port", p);
      r.put("token", t);
      r.put("dxout", dxout);
      r.put("lang", ArchneLang.get(getActivity()));
    } else {
      r.put("port", 0);
    }
    call.resolve(r);
  }

  @PluginMethod
  public void setLang(PluginCall call) {
    if (ArchneLang.set(getActivity(), call.getString("lang", "en"))) ArchneService.relocalize(getActivity());
    call.resolve();
  }

  @PluginMethod
  public void start(PluginCall call) {
    Integer port = call.getInt("port");
    String token = call.getString("token");
    if (port == null || token == null) { call.reject("e:badArgs"); return; }
    ArchneService.port = port;
    ArchneService.token = token;
    String dx = call.getString("dxout");
    dxout = dx == null ? "" : dx;
    ArchneLang.set(getActivity(), call.getString("lang", "en")); // sebelum layanan dibuat: channel langsung berbahasa benar
    if (Build.VERSION.SDK_INT >= 33 && getActivity().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
      getActivity().requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF); // hasilnya tidak ditunggu; layanan tetap jalan
    }
    Intent svc = new Intent(getActivity(), ArchneService.class);
    try {
      if (Build.VERSION.SDK_INT >= 26) getActivity().startForegroundService(svc);
      else getActivity().startService(svc);
      call.resolve();
    } catch (RuntimeException e) {
      call.reject(String.valueOf(e.getMessage()));
    }
  }

  @PluginMethod
  public void viewer(PluginCall call) {
    final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
    getActivity().runOnUiThread(new Runnable() {
      @Override public void run() {
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).viewer(on);
      }
    });
    call.resolve();
  }

  @PluginMethod
  public void pip(PluginCall call) {
    final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
    pipWanted = on;
    getActivity().runOnUiThread(new Runnable() {
      @Override public void run() {
        if (!(getActivity() instanceof MainActivity)) return;
        MainActivity a = (MainActivity) getActivity();
        a.pipArm(on);
        if (!on) a.pipClose();
      }
    });
    call.resolve();
  }

  @PluginMethod
  public void pipState(PluginCall call) {
    JSObject r = new JSObject();
    r.put("on", getActivity() instanceof MainActivity && ((MainActivity) getActivity()).pipActive());
    call.resolve(r);
  }

  @PluginMethod
  public void batteryAsk(PluginCall call) {
    JSObject r = new JSObject();
    r.put("value", battery(Boolean.TRUE.equals(call.getBoolean("manual", false))));
    call.resolve(r);
  }

  @PluginMethod
  public void takeChat(PluginCall call) {
    String k = pendingChat;
    pendingChat = "";
    JSObject r = new JSObject();
    r.put("key", k);
    call.resolve(r);
  }

  @PluginMethod
  public void takeAnswer(PluginCall call) {
    String k = pendingAnswer;
    pendingAnswer = "";
    JSObject r = new JSObject();
    r.put("cid", k);
    call.resolve(r);
  }

  private String battery(boolean force) {
    if (Build.VERSION.SDK_INT < 23) return "ok";
    Context ctx = getContext().getApplicationContext();
    String pkg = ctx.getPackageName();
    PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
    if (pm != null && pm.isIgnoringBatteryOptimizations(pkg)) return "ok";
    SharedPreferences sp = ctx.getSharedPreferences("archne", Context.MODE_PRIVATE);
    if (!force && sp.getBoolean("batt_asked", false)) return "skipped";
    sp.edit().putBoolean("batt_asked", true).apply();
    try {
      getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:" + pkg)));
      return "asked";
    } catch (RuntimeException e) {
      try { getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); return "asked"; }
      catch (RuntimeException e2) { return "failed"; }
    }
  }

  @Override
  protected void handleOnNewIntent(Intent i) { take(i); }

  @Override
  protected void handleOnResume() {
    ArchneService.visible = true;
    ArchneService.clearChatNotifications(getContext().getApplicationContext());
    ArchneService.clearCall(getContext().getApplicationContext());
  }

  @Override
  protected void handleOnPause() { ArchneService.visible = false; }

  @Override
  protected void handleOnDestroy() { ArchneService.visible = false; }
}
