package com.xyraori.archne;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.RemoteInput;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Layanan latar depan: menjaga proses (dan inti Node di dalamnya) tetap hidup, dan menampilkan notifikasi untuk
 * kejadian 'notify' dan 'call' yang dikirim inti lewat SSE di 127.0.0.1. Aturan siapa yang diberi notifikasi ada di sisi Node.
 *
 * Tampilan (v0.15.0): gaya percakapan seperti aplikasi chat. Foto profil pengirim (atau lingkaran berhuruf bila belum punya foto),
 * riwayat beberapa pesan terakhir, tombol "Balas" (balas langsung dari notifikasi) dan "Tandai dibaca". Panggilan masuk punya foto
 * penelepon dengan tombol "Tolak" dan "Jawab". Balas dan Tolak dikirim ke inti Node lewat HTTP loopback oleh ArchneReceiver;
 * Jawab membuka aplikasi dan UI langsung menjawab (audio WebRTC ada di UI, bukan di sini).
 */
public class ArchneService extends Service {
  static volatile int port = 0;
  static volatile String token = null;
  static volatile boolean visible = true; // UI sedang tampil: tidak perlu notifikasi
  static volatile boolean callOn = false; // panggilan suara berlangsung: layanan latar naik ke tipe mikrofon (diatur plugin ArchneAudio)
  static volatile boolean screenOn = false; // berbagi layar dari HP berlangsung: layanan latar naik ke tipe mediaProjection (diatur plugin ArchneScreen)
  private static volatile ArchneService inst;
  private static volatile String ringCid = ""; // panggilan masuk yang sedang ditampilkan di notifikasi
  private static final Map<String, String> callNames = new HashMap<String, String>();
  private static final Map<String, Boolean> callVideo = new HashMap<String, Boolean>(); // peer -> panggilan masuk terakhirnya video (teks notifikasi tak terjawab); dikunci bersama callNames

  private static final String CH_SVC = "archne_service", CH_MSG = "archne_messages", CH_CALL = "archne_calls";
  static final String ACTION_REPLY = "com.xyraori.archne.REPLY", ACTION_READ = "com.xyraori.archne.READ", ACTION_DECLINE = "com.xyraori.archne.DECLINE";
  static final String EXTRA_KEY = "key", EXTRA_CID = "cid", KEY_REPLY = "archne_reply_text";
  private static final int ID_SVC = 1, ID_CALL = 4;
  static final String EXTRA_RING = "archne_ring"; // intent layar penuh panggilan masuk: MainActivity tampil di atas layar kunci
  private static final int ACCENT = 0xFF0E8F81;

  // Percakapan yang sedang punya notifikasi (kunci chat -> beberapa pesan terakhir). Di memori saja: hilang bersama prosesnya.
  private static final class Msg {
    final String text, who, from; final long ts; final boolean me; final Bitmap av;
    Msg(String text, String who, String from, long ts, boolean me, Bitmap av) { this.text = text; this.who = who; this.from = from; this.ts = ts; this.me = me; this.av = av; }
  }
  private static final class Chat {
    String title = ""; boolean group = false;
    final ArrayList<Msg> msgs = new ArrayList<Msg>();
  }
  private static final Map<String, Chat> chats = new HashMap<String, Chat>();
  private static final Set<Integer> missedIds = new HashSet<Integer>(); // notifikasi panggilan tak terjawab (dihapus bersama notifikasi chat)
  private static final Map<String, Bitmap> avs = new HashMap<String, Bitmap>(); // id pengguna -> foto bulat (atau huruf)

  private volatile boolean running = false;
  private Thread sse;
  private PowerManager.WakeLock wake;
  private WifiManager.MulticastLock mcast;
  private WifiManager.WifiLock wifi; // jaga radio Wi-Fi tidak masuk mode hemat daya saat layar mati (penyebab pesan telat)

  @Override
  public IBinder onBind(Intent i) { return null; }

  @Override
  public void onCreate() { super.onCreate(); inst = this; }

  /** Dipanggil plugin ArchneAudio: naikkan/turunkan tipe layanan latar. Dijalankan di utas utama; tanpa layanan hidup tidak berbuat apa-apa. */
  static void callMode(Context ctx, boolean on) {
    callOn = on;
    final ArchneService s = inst;
    if (s == null) return;
    new Handler(Looper.getMainLooper()).post(new Runnable() { public void run() { s.promote(); } });
  }

  /**
   * Dipanggil plugin ArchneScreen: naikkan/turunkan tipe mediaProjection. Android 14+ mewajibkan layanan bertipe ini SUDAH berjalan sebelum MediaProjection diambil,
   * jadi saat on=true dipanggil dari utas utama (setelah pengguna memberi izin) promosi dilakukan langsung, bukan diantrekan. Hasil false = layanan tidak ada
   * atau sistem menolak tipenya; pemanggil membatalkan berbagi. on=false selalu aman (tanpa layanan: tidak berbuat apa-apa).
   */
  static boolean screenMode(Context ctx, boolean on) {
    screenOn = on;
    final ArchneService s = inst;
    if (s == null) return !on;
    if (Looper.myLooper() == Looper.getMainLooper()) return s.promote() || !on;
    if (on) { screenOn = false; return false; } // dari utas lain tidak bisa dipastikan berhasil sebelum dipakai
    new Handler(Looper.getMainLooper()).post(new Runnable() { public void run() { s.promote(); } });
    return true;
  }

  /** Bahasa aplikasi berganti (ArchneBackground.setLang): perbarui nama channel dan notifikasi layanan. Notifikasi pesan/panggilan yang sudah tampil dibiarkan. */
  static void relocalize(Context ctx) {
    final ArchneService s = inst;
    if (s == null) return;
    new Handler(Looper.getMainLooper()).post(new Runnable() { public void run() { s.makeChannels(); s.promote(); } });
  }

  private boolean promote() {
    if (!running) return false;
    boolean s = screenOn;
    try { goForeground(); return true; }
    catch (RuntimeException e) { /* tipe ditolak (izin dicabut, atau dipanggil dari latar belakang): turunkan satu per satu */ }
    screenOn = false;
    try { goForeground(); return !s; }
    catch (RuntimeException e) { /* masih ditolak */ }
    callOn = false; // panggilan jalan terus tanpa tipe mikrofon
    try { goForeground(); } catch (RuntimeException e2) { /* abaikan */ }
    return !s;
  }

  private void goForeground() {
    Notification n = ongoing();
    if (Build.VERSION.SDK_INT >= 29) {
      int t = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
      if (callOn && Build.VERSION.SDK_INT >= 30) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
      if (screenOn) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
      startForeground(ID_SVC, n, t);
    } else startForeground(ID_SVC, n);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (port == 0 || token == null) { stopSelf(); return START_NOT_STICKY; } // dihidupkan ulang sistem tanpa inti Node: tidak ada yang dijaga
    makeChannels();
    try { goForeground(); }
    catch (RuntimeException e) { callOn = false; screenOn = false; goForeground(); }
    if (!running) {
      running = true;
      try {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "archne:service");
        wake.setReferenceCounted(false);
        wake.acquire();
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        mcast = wm.createMulticastLock("archne:mcast");
        mcast.setReferenceCounted(false);
        mcast.acquire();
        // LOW_LATENCY hanya aktif saat aplikasi tampil dan layar menyala, jadi untuk latar belakang dipakai HIGH_PERF (Android 14+ tidak punya padanan lain).
        wifi = wm.createWifiLock(Build.VERSION.SDK_INT >= 34 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF, "archne:wifi");
        wifi.setReferenceCounted(false);
        wifi.acquire();
      } catch (RuntimeException e) { /* tanpa kunci: tetap jalan */ }
      sse = new Thread(new Runnable() { public void run() { loop(); } }, "archne-notify");
      sse.setDaemon(true);
      sse.start();
    }
    return START_NOT_STICKY;
  }

  // Android 15+: layanan dataSync dibatasi waktu; sistem memanggil ini lalu menunggu layanan berhenti (kalau tidak, aplikasi dianggap macet).
  // Tanpa @Override agar tetap terkompilasi dengan compileSdk lama.
  public void onTimeout(int startId, int fgsType) { stopSelf(); }

  @Override
  public void onDestroy() {
    running = false;
    if (inst == this) inst = null;
    try { if (wake != null && wake.isHeld()) wake.release(); } catch (RuntimeException e) { /* abaikan */ }
    try { if (mcast != null && mcast.isHeld()) mcast.release(); } catch (RuntimeException e) { /* abaikan */ }
    try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (RuntimeException e) { /* abaikan */ }
    if (sse != null) sse.interrupt();
  }

  private void makeChannels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    // Channel layanan: prioritas minimum (tanpa ikon di bilah status, menciut di dasar panel), tanpa bunyi/getar/lampu/badge,
    // dan disembunyikan dari layar kunci. Pengguna masih bisa mematikannya sendiri di Pengaturan > Notifikasi > Archne.
    NotificationChannel a = new NotificationChannel(CH_SVC, ArchneLang.s(this, "ch_svc"), NotificationManager.IMPORTANCE_MIN);
    a.setDescription(ArchneLang.s(this, "ch_svc_desc"));
    a.setShowBadge(false);
    a.setSound(null, null);
    a.enableVibration(false);
    a.enableLights(false);
    a.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
    nm.createNotificationChannel(a);
    NotificationChannel b = new NotificationChannel(CH_MSG, ArchneLang.s(this, "ch_msg"), NotificationManager.IMPORTANCE_HIGH);
    nm.createNotificationChannel(b);
    NotificationChannel c = new NotificationChannel(CH_CALL, ArchneLang.s(this, "ch_call"), NotificationManager.IMPORTANCE_HIGH);
    c.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
    c.enableVibration(true);
    c.setVibrationPattern(new long[] { 0, 800, 600, 800 });
    nm.createNotificationChannel(c);
  }

  private Notification.Builder builder(String channel) { return builder(this, channel); }

  private static Notification.Builder builder(Context c, String channel) {
    return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
  }

  // Ikon kecil di bilah status: gelembung chat milik Archne (res/drawable/ic_stat_archne.xml dari plugin); bila tidak ada, ikon sistem.
  private static int smallIcon(Context c) {
    int r = c.getResources().getIdentifier("ic_stat_archne", "drawable", c.getPackageName());
    return r != 0 ? r : android.R.drawable.stat_notify_chat;
  }

  private PendingIntent openApp(String chat, int req) { return openApp(this, chat, null, req); }

  /** Buka aplikasi (opsional: langsung ke chat tertentu, dan/atau menjawab panggilan masuk dengan id tertentu). */
  private static PendingIntent openApp(Context c, String chat, String answerCid, int req) {
    Intent i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
    if (i == null) i = new Intent();
    i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    if (chat != null) i.putExtra(ArchneBackground.EXTRA_CHAT, chat);
    if (answerCid != null) i.putExtra(ArchneBackground.EXTRA_ANSWER, answerCid);
    return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  /** PendingIntent ke ArchneReceiver. Data (URI) dibuat unik per aksi+sasaran: PendingIntent dibedakan dari data, bukan dari extras. */
  private static PendingIntent toReceiver(Context c, String action, String key, String cid, boolean mutable, int req) {
    Intent i = new Intent(c, ArchneReceiver.class).setAction(action);
    i.setData(Uri.parse("archne://act/" + Uri.encode(action + "/" + (key != null ? key : cid))));
    if (key != null) i.putExtra(EXTRA_KEY, key);
    if (cid != null) i.putExtra(EXTRA_CID, cid);
    int fl = PendingIntent.FLAG_UPDATE_CURRENT;
    if (mutable) { if (Build.VERSION.SDK_INT >= 31) fl |= PendingIntent.FLAG_MUTABLE; } // balasan langsung wajib mutable agar sistem bisa menyisipkan teksnya
    else fl |= PendingIntent.FLAG_IMMUTABLE;
    return PendingIntent.getBroadcast(c, req, i, fl);
  }

  // Notifikasi layanan versi minimal (v0.15.1): tanpa tombol, tanpa bunyi, tanpa ikon di bilah status (channel IMPORTANCE_MIN).
  // Android mewajibkan ikon kecil, jadi dipakai gelembung Archne; ia hanya tampak di baris panel notifikasi, tidak di bilah status.
  // Selama panggilan, teksnya tetap menyebut mikrofon supaya pengguna tahu mengapa mikrofon aktif.
  private Notification ongoing() {
    Notification.Builder b = builder(CH_SVC)
      .setSmallIcon(smallIcon(this))
      .setContentTitle(callOn ? ArchneLang.s(this, "svc_call") : "Archne")
      .setContentText(callOn ? ArchneLang.s(this, "svc_mic") : ArchneLang.s(this, "svc_idle"))
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_SECRET)
      .setOngoing(true)
      .setShowWhen(false)
      .setOnlyAlertOnce(true)
      .setContentIntent(openApp(null, 3));
    if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_MIN);
    return b.build();
  }

  private static int idOf(String key) { return 100 + (key.hashCode() & 0x3fffffff); }
  private static int rc(String key, int n) { return (idOf(key) & 0x1fffffff) * 4 + n; }

  private static NotificationManager nm(Context c) { return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE); }

  // ---- foto profil ----

  /**
   * Foto bulat untuk notifikasi. b64: foto dari inti (JPEG kecil, base64); "" = pengirim tidak punya foto (pakai lingkaran berhuruf,
   * warnanya sama dengan avatar di UI); null = tidak diketahui (pakai yang sudah tersimpan, kalau tidak ada: huruf).
   */
  static Bitmap avatar(String id, String name, String b64) {
    synchronized (avs) {
      if (b64 != null && b64.length() > 0) {
        try {
          byte[] d = Base64.decode(b64, Base64.DEFAULT);
          Bitmap src = BitmapFactory.decodeByteArray(d, 0, d.length);
          if (src != null) { Bitmap c = circle(src); avs.put(id, c); return c; }
        } catch (RuntimeException e) { /* foto rusak: pakai huruf */ }
      }
      Bitmap have = b64 == null ? avs.get(id) : null;
      if (have != null) return have;
      if (avs.size() > 60) avs.clear();
      Bitmap l = letter(id, name);
      avs.put(id, l);
      return l;
    }
  }

  private static Bitmap circle(Bitmap src) {
    int s = 128;
    Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
    Bitmap sc = Bitmap.createScaledBitmap(src, s, s, true);
    Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    p.setShader(new BitmapShader(sc, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
    new Canvas(out).drawCircle(s / 2f, s / 2f, s / 2f, p);
    return out;
  }

  private static Bitmap letter(String id, String name) {
    int s = 128;
    float hue;
    try { hue = (float) (Integer.parseInt(id.substring(0, 6), 16) % 360); } catch (RuntimeException e) { hue = 200f; }
    Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
    Canvas cv = new Canvas(out);
    Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    p.setColor(Color.HSVToColor(new float[] { hue, 0.65f, 0.62f })); // setara hsl(hue,48%,42%) di UI
    cv.drawCircle(s / 2f, s / 2f, s / 2f, p);
    String n = name == null ? "" : name.trim();
    String t = "?";
    if (n.length() > 0) t = new String(Character.toChars(Character.toUpperCase(n.codePointAt(0))));
    p.setColor(Color.WHITE);
    p.setTypeface(Typeface.DEFAULT_BOLD);
    p.setTextSize(s * 0.5f);
    p.setTextAlign(Paint.Align.CENTER);
    cv.drawText(t, s / 2f, s / 2f - (p.descent() + p.ascent()) / 2f, p);
    return out;
  }

  private static CharSequence colored(String text, int color) {
    SpannableString sp = new SpannableString(text);
    sp.setSpan(new ForegroundColorSpan(color), 0, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    return sp;
  }

  // ---- notifikasi pesan ----

  static void clearChatNotifications(Context ctx) {
    NotificationManager nm = nm(ctx);
    synchronized (chats) {
      for (String k : chats.keySet()) nm.cancel(idOf(k));
      for (Integer id : missedIds) nm.cancel(id.intValue());
      chats.clear();
      missedIds.clear();
    }
  }

  static void clearCall(Context ctx) {
    ringCid = "";
    nm(ctx).cancel(ID_CALL);
  }

  /** Percakapan dibaca (tombol "Tandai dibaca" atau notifikasi digeser): lupakan riwayatnya. */
  static void markRead(Context ctx, String key) {
    synchronized (chats) { chats.remove(key); }
    nm(ctx).cancel(idOf(key));
  }

  /** Gambar ulang notifikasi sebuah percakapan dari riwayatnya. quiet: tanpa bunyi/getar (mis. setelah membalas). */
  static void postChat(Context ctx, String key, boolean quiet) {
    Context c = ctx.getApplicationContext();
    String title; boolean group; ArrayList<Msg> list;
    synchronized (chats) {
      Chat ch = chats.get(key);
      if (ch == null || ch.msgs.isEmpty()) { nm(c).cancel(idOf(key)); return; } // tidak ada riwayat: pastikan indikator "mengirim" hilang
      title = ch.title; group = ch.group; list = new ArrayList<Msg>(ch.msgs);
    }
    Msg last = list.get(list.size() - 1);
    Bitmap large = null;
    for (int i = list.size() - 1; i >= 0 && large == null; i--) if (!list.get(i).me) large = list.get(i).av;

    Notification.MessagingStyle st;
    if (Build.VERSION.SDK_INT >= 28) {
      Person user = new Person.Builder().setName(ArchneLang.s(c, "you")).build();
      st = new Notification.MessagingStyle(user);
      if (group) { st.setConversationTitle(title); st.setGroupConversation(true); }
      for (Msg m : list) {
        Person p = user;
        if (!m.me) {
          Person.Builder pb = new Person.Builder().setName(m.who).setKey(m.from);
          if (m.av != null) pb.setIcon(Icon.createWithBitmap(m.av));
          p = pb.build();
        }
        st.addMessage(new Notification.MessagingStyle.Message(m.text, m.ts, p));
      }
    } else {
      st = new Notification.MessagingStyle(ArchneLang.s(c, "you"));
      if (group) st.setConversationTitle(title);
      for (Msg m : list) st.addMessage(m.text, m.ts, m.me ? null : m.who);
    }

    String preview = (group && !last.me ? last.who + ": " : "") + last.text;
    Notification.Builder b = builder(c, CH_MSG)
      .setSmallIcon(smallIcon(c))
      .setColor(ACCENT)
      .setContentTitle(title)
      .setContentText(preview)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setStyle(st)
      .setWhen(last.ts)
      .setShowWhen(true)
      .setAutoCancel(true)
      .setOnlyAlertOnce(quiet)
      .setContentIntent(openApp(c, key, null, rc(key, 0)))
      .setDeleteIntent(toReceiver(c, ACTION_READ, key, null, false, rc(key, 1)));
    if (large != null) b.setLargeIcon(large);
    if (Build.VERSION.SDK_INT < 26 && !quiet) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);

    RemoteInput ri = new RemoteInput.Builder(KEY_REPLY).setLabel(ArchneLang.s(c, "reply")).build();
    Notification.Action.Builder reply = new Notification.Action.Builder(android.R.drawable.ic_menu_send, ArchneLang.s(c, "reply"), toReceiver(c, ACTION_REPLY, key, null, true, rc(key, 2)))
      .addRemoteInput(ri).setAllowGeneratedReplies(true);
    if (Build.VERSION.SDK_INT >= 28) reply.setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY);
    Notification.Action.Builder read = new Notification.Action.Builder(android.R.drawable.ic_menu_view, ArchneLang.s(c, "mark_read"), toReceiver(c, ACTION_READ, key, null, false, rc(key, 3)));
    if (Build.VERSION.SDK_INT >= 28) read.setSemanticAction(Notification.Action.SEMANTIC_ACTION_MARK_AS_READ);
    b.addAction(reply.build());
    b.addAction(read.build());
    try { nm(c).notify(idOf(key), b.build()); } catch (RuntimeException e) { /* izin notifikasi ditolak */ }
  }

  /** Balasan dari notifikasi: tampil dulu di notifikasi (agar indikator "mengirim" hilang), lalu dikirim lewat inti. Dipanggil di utas latar. */
  static void reply(Context ctx, String key, String text) {
    synchronized (chats) {
      Chat ch = chats.get(key);
      if (ch == null) { ch = new Chat(); ch.title = key.equals("public") ? ArchneLang.s(ctx, "public") : "Archne"; chats.put(key, ch); }
      ch.msgs.add(new Msg(text, ArchneLang.s(ctx, "you"), "", System.currentTimeMillis(), true, null));
      while (ch.msgs.size() > 8) ch.msgs.remove(0);
    }
    postChat(ctx, key, true);
    String err = rpc(ctx, "send", new JSONArray().put(text).put(key).toString());
    if (err != null) {
      synchronized (chats) {
        Chat ch = chats.get(key);
        if (ch != null) ch.msgs.add(new Msg(ArchneLang.s(ctx, "not_sent", err), "Archne", "", System.currentTimeMillis(), false, avatar("archne", "Archne", null)));
      }
      postChat(ctx, key, false);
    }
  }

  /** Tolak panggilan masuk dari tombol "Tolak". Dipanggil di utas latar. */
  static void decline(Context ctx, String cid) {
    rpc(ctx, "callReject", new JSONArray().put(cid).toString());
    clearCall(ctx.getApplicationContext());
  }

  /** Panggil fungsi inti (ipc) lewat HTTP loopback. Mengembalikan null bila berhasil, selain itu teks galatnya. */
  private static String rpc(Context ctx, String name, String args) {
    HttpURLConnection c = null;
    try {
      if (port == 0 || token == null) return ArchneLang.s(ctx, "core_wait");
      c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/s/" + token + "/rpc/" + name).openConnection();
      c.setConnectTimeout(3000);
      c.setReadTimeout(6000);
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      byte[] body = args.getBytes("UTF-8");
      c.setFixedLengthStreamingMode(body.length);
      OutputStream os = c.getOutputStream();
      os.write(body);
      os.close();
      int code = c.getResponseCode();
      if (code != 200) return "HTTP " + code;
      BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
      StringBuilder sb = new StringBuilder();
      String ln;
      while ((ln = r.readLine()) != null) sb.append(ln);
      r.close();
      String out = sb.toString().trim();
      if ("true".equals(out) || out.startsWith("{\"ok\":true")) return null;
      if (out.length() > 1 && out.startsWith("\"") && out.endsWith("\"")) out = out.substring(1, out.length() - 1);
      return out.length() == 0 ? ArchneLang.s(ctx, "failed") : out;
    } catch (Exception e) {
      return String.valueOf(e.getMessage());
    } finally {
      if (c != null) c.disconnect();
    }
  }

  // Panggilan masuk saat aplikasi tidak tampil: notifikasi berdering berulang (FLAG_INSISTENT) sampai dijawab, ditutup, atau 50 detik.
  // Dering di dalam aplikasi (WebAudio) hanya terdengar saat UI di depan; ini jalur latar belakangnya.
  // Bentuk: foto penelepon, tombol Tolak (lewat inti, tanpa membuka aplikasi) dan Jawab (membuka aplikasi, UI langsung menjawab).
  private void showCall(String cid, String peer, String name, String avB64, boolean video) {
    if (visible) return;
    ringCid = cid;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Action decline = new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, colored(ArchneLang.s(this, "decline"), 0xFFE53935),
      toReceiver(this, ACTION_DECLINE, null, cid, false, ID_CALL + 1)).build();
    Notification.Action answer = new Notification.Action.Builder(android.R.drawable.sym_action_call, colored(ArchneLang.s(this, "answer"), 0xFF25A244),
      openApp(this, peer, cid, ID_CALL + 2)).build();
    Bitmap av = avatar(peer, name, avB64);
    // Layar penuh: HP terkunci/layar mati -> aplikasi terbuka di atas layar kunci dan menampilkan UI panggilan masuk; HP menyala -> kepala notifikasi (heads-up).
    Intent ring = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (ring == null) ring = new Intent();
    ring.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    ring.putExtra(ArchneBackground.EXTRA_CHAT, peer).putExtra(EXTRA_RING, true);
    PendingIntent full = PendingIntent.getActivity(this, ID_CALL + 3, ring, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification n = null;
    if (Build.VERSION.SDK_INT >= 31) {
      // Android 12+: gaya panggilan sistem. Tombol Tolak/Jawab tampil langsung (tanpa ditarik/diperluas) dan tidak dilipat bersama notifikasi chat.
      try {
        Person caller = new Person.Builder().setName(name).setKey(peer).setImportant(true).setIcon(Icon.createWithBitmap(av)).build();
        n = builder(CH_CALL)
          .setSmallIcon(android.R.drawable.stat_sys_phone_call)
          .setColor(ACCENT)
          .setContentTitle(name)
          .setContentText(ArchneLang.s(this, video ? "call_video" : "call_voice"))
          .setCategory(Notification.CATEGORY_CALL)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
          .setOngoing(true)
          .setContentIntent(openApp(peer, ID_CALL))
          .setFullScreenIntent(full, true)
          .setStyle(Notification.CallStyle.forIncomingCall(caller, toReceiver(this, ACTION_DECLINE, null, cid, false, ID_CALL + 1), openApp(this, peer, cid, ID_CALL + 2)))
          .setTimeoutAfter(50000)
          .build();
      } catch (RuntimeException e) { n = null; /* gaya panggilan ditolak sistem: pakai bentuk biasa di bawah */ }
    }
    if (n == null) {
      Notification.Builder b = builder(CH_CALL)
        .setSmallIcon(android.R.drawable.stat_sys_phone_call)
        .setColor(ACCENT)
        .setLargeIcon(av)
        .setContentTitle(name)
        .setContentText(ArchneLang.s(this, video ? "call_video" : "call_voice"))
        .setCategory(Notification.CATEGORY_CALL)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setAutoCancel(true)
        .setContentIntent(openApp(peer, ID_CALL))
        .setFullScreenIntent(full, true)
        .addAction(decline)
        .addAction(answer);
      if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(50000);
      else {
        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        b.setPriority(Notification.PRIORITY_HIGH).setSound(ringtone).setVibrate(new long[] { 0, 800, 600, 800 });
      }
      n = b.build();
    }
    n.flags |= Notification.FLAG_INSISTENT;
    try { nm.notify(ID_CALL, n); } catch (RuntimeException e) { /* izin notifikasi ditolak */ }
  }

  private void showMissed(String peer, String name, boolean video) {
    if (visible) return;
    int id = idOf("call:" + peer);
    synchronized (chats) { missedIds.add(Integer.valueOf(id)); }
    Notification.Builder b = builder(CH_MSG)
      .setSmallIcon(android.R.drawable.stat_notify_missed_call)
      .setColor(ACCENT)
      .setLargeIcon(avatar(peer, name, null))
      .setContentTitle(name)
      .setContentText(ArchneLang.s(this, video ? "missed_video" : "missed_voice"))
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
      .setAutoCancel(true)
      .setContentIntent(openApp(this, peer, null, id));
    if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
    try { nm(this).notify(id, b.build()); } catch (RuntimeException e) { /* izin notifikasi ditolak */ }
  }

  /**
   * Langkah 3e: inti Node menerima ajakan sambung lintas jaringan (offer/want) saat UI tidak tampil. WebRTC hanya bisa jalan di WebView,
   * jadi layanan menampilkan notifikasi; ketukannya membuka aplikasi dan UI memutar ulang signal yang tertahan (3d). Dibersihkan bersama notifikasi chat.
   */
  private void showWake(String from, String who) {
    if (visible || from.length() == 0) return;
    String name = who.length() > 0 ? who : "Archne";
    int id = idOf("wake:" + from);
    synchronized (chats) { missedIds.add(Integer.valueOf(id)); }
    Notification.Builder b = builder(CH_MSG)
      .setSmallIcon(smallIcon(this))
      .setColor(ACCENT)
      .setLargeIcon(avatar(from, name, null))
      .setContentTitle(name)
      .setContentText(ArchneLang.s(this, "wake_text", name))
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
      .setAutoCancel(true)
      .setContentIntent(openApp(this, from, null, id));
    if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
    try { nm(this).notify(id, b.build()); } catch (RuntimeException e) { /* izin notifikasi ditolak */ }
  }

  private void onCallEvent(JSONObject o) {
    String ev = o.optString("ev"), cid = o.optString("cid"), peer = o.optString("peer");
    if ("incoming".equals(ev)) {
      String name = o.optString("name", "?");
      boolean video = o.optBoolean("video", false);
      synchronized (callNames) { if (callNames.size() > 50) { callNames.clear(); callVideo.clear(); } callNames.put(peer, name); callVideo.put(peer, Boolean.valueOf(video)); }
      showCall(cid, peer, name, o.has("av") ? o.optString("av", "") : null, video);
    } else if ("end".equals(ev)) {
      if (cid.equals(ringCid)) clearCall(getApplicationContext());
      if ("in".equals(o.optString("dir")) && "missed".equals(o.optString("reason")) && !o.optBoolean("wasActive", false)) {
        String name; boolean video; synchronized (callNames) { name = callNames.get(peer); Boolean v = callVideo.get(peer); video = v != null && v.booleanValue(); }
        showMissed(peer, name == null ? "Archne" : name, video);
      }
    }
  }

  /** Pesan masuk dari inti ('notify'): tambahkan ke riwayat percakapannya lalu gambar ulang notifikasinya. */
  private void show(JSONObject o) throws JSONException {
    if (visible) return;
    String key = o.getString("key"), text = o.optString("text", "");
    String from = o.optString("from", key), who = o.optString("who", o.optString("title", "Archne")), chatName = o.optString("chat", "");
    long ts = o.optLong("ts", System.currentTimeMillis());
    Bitmap av = avatar(from, who, o.has("av") ? o.optString("av", "") : null);
    boolean group = key.equals("public") || key.startsWith("g:");
    synchronized (chats) {
      Chat ch = chats.get(key);
      if (ch == null) { ch = new Chat(); chats.put(key, ch); }
      ch.group = group;
      ch.title = group ? (chatName.length() > 0 ? chatName : o.optString("title", "Archne")) : who;
      ch.msgs.add(new Msg(text, who, from, ts, false, av));
      while (ch.msgs.size() > 8) ch.msgs.remove(0);
    }
    postChat(this, key, false);
  }

  private void loop() {
    while (running) {
      HttpURLConnection c = null;
      try {
        if (port == 0 || token == null) { Thread.sleep(1000); continue; }
        c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/s/" + token + "/events").openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(0);
        BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
        String ev = null, data = null, line;
        while (running && (line = r.readLine()) != null) {
          if (line.startsWith("event:")) ev = line.substring(6).trim();
          else if (line.startsWith("data:")) data = line.substring(5).trim();
          else if (line.isEmpty()) {
            if ("call".equals(ev) && data != null) {
              try { onCallEvent(new JSONObject(data)); } catch (Exception e) { /* data rusak: lewati */ }
            } else if ("wake".equals(ev) && data != null) {
              try { JSONObject w = new JSONObject(data); showWake(w.optString("from", ""), w.optString("who", "")); }
              catch (Exception e) { /* data rusak: lewati */ }
            } else if ("notify".equals(ev) && data != null) {
              try { show(new JSONObject(data)); }
              catch (Exception e) { /* data rusak: lewati */ }
            }
            ev = null; data = null;
          }
        }
      } catch (InterruptedException e) {
        return;
      } catch (Exception e) {
        // inti belum siap atau koneksi putus: coba lagi
      } finally {
        if (c != null) c.disconnect();
      }
      try { Thread.sleep(2000); } catch (InterruptedException e) { return; }
    }
  }
}
