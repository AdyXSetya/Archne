package com.xyraori.archne;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * start(port, token[, lang]): jalankan layanan latar depan yang mendengarkan kejadian 'notify' dari inti Node. lang = bahasa aplikasi ('en'|'id'), untuk teks notifikasi.
 * setLang(lang): bahasa aplikasi berganti; teks native (channel, notifikasi layanan, tombol) ikut berganti. Lihat ArchneLang.
 * takeChat(): kunci chat dari ketukan notifikasi terakhir ('' bila tidak ada).
 * takeAnswer(): id panggilan dari tombol "Jawab" di notifikasi panggilan masuk ('' bila tidak ada); UI lalu menjawabnya.
 * batteryAsk(force): minta Android mengecualikan aplikasi dari penghematan baterai (dialog sistem). Tanpa force hanya sekali seumur pemasangan.
 *   Hasil: "ok" (sudah dikecualikan), "asked" (dialog dibuka), "skipped" (sudah pernah ditanya), "failed".
 */
public class ArchneBackground extends CordovaPlugin {
  private static final int REQ_NOTIF = 7302;
  static final String EXTRA_CHAT = "archne_chat";
  static final String EXTRA_ANSWER = "archne_answer";
  static volatile String pendingChat = "";
  static volatile String pendingAnswer = "";

  @Override
  public void pluginInitialize() {
    Intent i = cordova.getActivity().getIntent();
    take(i);
  }

  private static void take(Intent i) {
    if (i == null) return;
    if (i.hasExtra(EXTRA_CHAT)) pendingChat = String.valueOf(i.getStringExtra(EXTRA_CHAT));
    if (i.hasExtra(EXTRA_ANSWER)) pendingAnswer = String.valueOf(i.getStringExtra(EXTRA_ANSWER));
  }

  @Override
  public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
    if ("setLang".equals(action)) {
      if (ArchneLang.set(cordova.getActivity(), args.optString(0, "en"))) ArchneService.relocalize(cordova.getActivity());
      cb.success();
      return true;
    }
    if ("start".equals(action)) {
      ArchneService.port = args.getInt(0);
      ArchneService.token = args.getString(1);
      if (args.length() > 2) ArchneLang.set(cordova.getActivity(), args.optString(2, "en")); // sebelum layanan dibuat: channel langsung berbahasa benar
      if (Build.VERSION.SDK_INT >= 33 && !cordova.hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
        cordova.requestPermission(this, REQ_NOTIF, Manifest.permission.POST_NOTIFICATIONS);
      }
      Intent svc = new Intent(cordova.getActivity(), ArchneService.class);
      try {
        if (Build.VERSION.SDK_INT >= 26) cordova.getActivity().startForegroundService(svc);
        else cordova.getActivity().startService(svc);
        cb.success();
      } catch (RuntimeException e) {
        cb.error(String.valueOf(e.getMessage()));
      }
      return true;
    }
    if ("batteryAsk".equals(action)) {
      cb.success(battery(args.optBoolean(0, false)));
      return true;
    }
    if ("takeChat".equals(action)) {
      String k = pendingChat;
      pendingChat = "";
      cb.success(k);
      return true;
    }
    if ("takeAnswer".equals(action)) {
      String k = pendingAnswer;
      pendingAnswer = "";
      cb.success(k);
      return true;
    }
    return false;
  }

  private String battery(boolean force) {
    if (Build.VERSION.SDK_INT < 23) return "ok";
    Context ctx = cordova.getActivity().getApplicationContext();
    String pkg = ctx.getPackageName();
    PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
    if (pm != null && pm.isIgnoringBatteryOptimizations(pkg)) return "ok";
    SharedPreferences sp = ctx.getSharedPreferences("archne", Context.MODE_PRIVATE);
    if (!force && sp.getBoolean("batt_asked", false)) return "skipped";
    sp.edit().putBoolean("batt_asked", true).apply();
    try {
      cordova.getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:" + pkg)));
      return "asked";
    } catch (RuntimeException e) {
      try { cordova.getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); return "asked"; }
      catch (RuntimeException e2) { return "failed"; }
    }
  }

  @Override
  public void onNewIntent(Intent i) { take(i); }

  @Override
  public void onResume(boolean multitasking) {
    ArchneService.visible = true;
    ArchneService.clearChatNotifications(cordova.getActivity().getApplicationContext());
    ArchneService.clearCall(cordova.getActivity().getApplicationContext());
  }

  @Override
  public void onPause(boolean multitasking) { ArchneService.visible = false; }

  @Override
  public void onDestroy() { ArchneService.visible = false; }
}
