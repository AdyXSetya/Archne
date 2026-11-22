package com.xyraori.archne;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpParameters;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Berbagi layar dari HP (v0.32.0, fase E). WebView Android tidak punya getDisplayMedia, jadi layar dan suara sistem ditangkap di sini
 * (MediaProjection + AudioPlaybackCapture) dan dialirkan ke UI lewat PeerConnection LOOPBACK di perangkat yang sama:
 *
 *   plugin (libwebrtc native)  --offer/answer/ICE lewat plugin ini-->  RTCPeerConnection di WebView (iframe UI)
 *
 * UI menerima trek video (dan audio) sebagai MediaStream biasa, lalu memasangnya lewat replaceTrack ke semua kaki panggilan,
 * persis seperti di desktop. Tidak ada sinyal tambahan ke jaringan dan panggilan utama tidak dinegosiasi ulang.
 * Tangkapan berjalan di native, jadi tidak ikut dibekukan saat aplikasi berpindah ke latar belakang (layanan latar bertipe mediaProjection).
 *
 * Audio: AudioPlaybackCapture (Android 10+) menggantikan isi buffer mikrofon milik ADM native lewat AudioBufferCallback, jadi trek audio
 * native HANYA berisi suara sistem (mikrofon asli tetap lewat WebView dan dicampur di UI). Suara Archne sendiri (lawan bicara) dikeluarkan lewat excludeUid.
 * Hanya USAGE_MEDIA/GAME/UNKNOWN yang ikut: notifikasi dan nada dering tidak.
 *
 * Metode: caps(), start({audio}), answer({sdp}), ice({c,mid,ml}), stop(). Kejadian 'sig': {t:'offer',sdp} {t:'ice',c,mid,ml} {t:'ended'} {t:'audiofail'} {t:'size',w,h}.
 * KODE INI BELUM DIKOMPILASI DI LINGKUNGAN PENULIS (tanpa Android SDK): pembuktian ada di HP. Lihat docs/PLANNING-0.32.0.md, fase E.
 */
@CapacitorPlugin(name = "ArchneScreen")
public class ArchneScreen extends Plugin {
  private static final String TAG = "ArchneScreen";
  private static final int MAX_LONG = 1280, MAX_SHORT = 720, FPS = 30;
  private static final int LOOP_MAX_BPS = 8_000_000; // loopback di perangkat sendiri: batas atas lega; batas ke lawan bicara diatur UI per kaki

  private final Handler main = new Handler(Looper.getMainLooper());
  private PluginCall pendingStart;
  private boolean wantAudio;
  private volatile boolean active;

  private EglBase egl;
  private JavaAudioDeviceModule adm;
  private PeerConnectionFactory factory;
  private SurfaceTextureHelper helper;
  private ScreenCapturerAndroid capturer;
  private VideoSource vsrc;
  private VideoTrack vtrack;
  private AudioSource asrc;
  private AudioTrack atrack;
  private PeerConnection pc;
  private volatile SysAudio sys;
  private int cw, ch;
  private boolean remoteSet;
  private final List<IceCandidate> pendIce = new ArrayList<IceCandidate>();
  private final Runnable sizeWatch = new Runnable() { public void run() { if (active) { checkSize(); main.postDelayed(this, 1000); } } };

  // ---- metode plugin ----

  @PluginMethod
  public void caps(PluginCall call) {
    JSObject r = new JSObject();
    r.put("screen", true);
    r.put("audio", Build.VERSION.SDK_INT >= 29);
    call.resolve(r);
  }

  /** start({audio}): minta izin layar (dialog sistem), naikkan layanan latar ke tipe mediaProjection, mulai tangkap, kirim offer. */
  @PluginMethod
  public void start(PluginCall call) {
    if (active || pendingStart != null) { call.reject("busy"); return; }
    wantAudio = Boolean.TRUE.equals(call.getBoolean("audio", false)) && Build.VERSION.SDK_INT >= 29
      && getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    MediaProjectionManager m = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    if (m == null) { call.reject("nosupport"); return; }
    pendingStart = call;
    try { startActivityForResult(call, m.createScreenCaptureIntent(), "consent"); }
    catch (RuntimeException e) { pendingStart = null; call.reject("err:" + e.getMessage()); }
  }

  @ActivityCallback
  private void consent(PluginCall call, ActivityResult result) {
    pendingStart = null;
    if (call == null) return;
    if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("denied"); return; }
    // Android 14+: layanan bertipe mediaProjection HARUS sudah berjalan sebelum MediaProjection diambil (dilakukan capturer.startCapture di bawah).
    if (!ArchneService.screenMode(getContext().getApplicationContext(), true)) { call.reject("nosvc"); return; }
    try {
      begin(result.getData());
      JSObject r = new JSObject();
      r.put("audio", wantAudio);
      r.put("w", cw);
      r.put("h", ch);
      call.resolve(r);
    } catch (Throwable t) { // termasuk UnsatisfiedLinkError bila library native tidak termuat
      Log.e(TAG, "start failed", t);
      cleanup();
      call.reject("err:" + (t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage()));
    }
  }

  @PluginMethod
  public void answer(PluginCall call) {
    final String sdp = call.getString("sdp");
    final PeerConnection p = pc;
    if (!active || p == null || sdp == null) { call.reject("noshare"); return; }
    p.setRemoteDescription(new Obs() {
      @Override public void onSetSuccess() {
        synchronized (pendIce) {
          remoteSet = true;
          for (IceCandidate c : pendIce) p.addIceCandidate(c);
          pendIce.clear();
        }
      }
      @Override public void onSetFailure(String e) { Log.e(TAG, "setRemote: " + e); emit("ended"); cleanup(); }
    }, new SessionDescription(SessionDescription.Type.ANSWER, sdp));
    call.resolve();
  }

  @PluginMethod
  public void ice(PluginCall call) {
    String c = call.getString("c"), mid = call.getString("mid", "");
    Integer idx = call.getInt("ml", 0);
    PeerConnection p = pc;
    if (!active || p == null || c == null) { call.resolve(); return; }
    IceCandidate cand = new IceCandidate(mid, idx == null ? 0 : idx.intValue(), c);
    synchronized (pendIce) { if (!remoteSet) { pendIce.add(cand); call.resolve(); return; } }
    p.addIceCandidate(cand);
    call.resolve();
  }

  @PluginMethod
  public void stop(PluginCall call) { cleanup(); call.resolve(); }

  @Override
  protected void handleOnDestroy() { cleanup(); }

  // ---- inti ----

  @SuppressWarnings("deprecation")
  private DisplayMetrics realMetrics() {
    DisplayMetrics dm = new DisplayMetrics();
    WindowManager wm = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
    wm.getDefaultDisplay().getRealMetrics(dm);
    return dm;
  }

  /** Sisi panjang paling banyak 1280, sisi pendek 720 (resolusi layar asli bila lebih kecil), keduanya genap. Layar tidak diperbesar. */
  private int[] fit(DisplayMetrics dm) {
    int w = dm.widthPixels, h = dm.heightPixels;
    int lg = Math.max(w, h), sh = Math.min(w, h);
    double s = Math.min(1.0, Math.min((double) MAX_LONG / lg, (double) MAX_SHORT / sh));
    int ow = Math.max(2, ((int) Math.round(w * s)) & ~1), oh = Math.max(2, ((int) Math.round(h * s)) & ~1);
    return new int[] { ow, oh };
  }

  private void begin(Intent data) {
    Context ctx = getContext().getApplicationContext();
    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions());
    egl = EglBase.create();
    JavaAudioDeviceModule.Builder ab = JavaAudioDeviceModule.builder(ctx)
      .setUseHardwareAcousticEchoCanceler(false)
      .setUseHardwareNoiseSuppressor(false)
      .setAudioSource(MediaRecorder.AudioSource.MIC)
      .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
        public void onWebRtcAudioRecordInitError(String m) { Log.e(TAG, "adm init: " + m); audioFail(); }
        public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode c, String m) { Log.e(TAG, "adm start: " + m); audioFail(); }
        public void onWebRtcAudioRecordError(String m) { Log.e(TAG, "adm: " + m); audioFail(); }
      });
    sys = null;
    if (wantAudio) { sys = new SysAudio(); ab.setAudioBufferCallback(sys); }
    adm = ab.createAudioDeviceModule();
    factory = PeerConnectionFactory.builder()
      .setAudioDeviceModule(adm)
      .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
      .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
      .createPeerConnectionFactory();

    int[] sz = fit(realMetrics());
    cw = sz[0]; ch = sz[1];
    helper = SurfaceTextureHelper.create("archne-screen", egl.getEglBaseContext());
    vsrc = factory.createVideoSource(true); // isScreencast: encoder mengutamakan ketajaman
    capturer = new ScreenCapturerAndroid(data, new MediaProjection.Callback() {
      @Override public void onStop() { // pengguna menekan "Berhenti berbagi" di bilah sistem, atau proyeksi dicabut
        main.post(new Runnable() { public void run() { if (active) { emit("ended"); cleanup(); } } });
      }
    });
    capturer.initialize(helper, ctx, vsrc.getCapturerObserver());
    active = true;
    capturer.startCapture(cw, ch, FPS);
    vtrack = factory.createVideoTrack("archne-scr-v", vsrc);

    PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(new ArrayList<PeerConnection.IceServer>());
    cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
    pc = factory.createPeerConnection(cfg, new PcObs());
    if (pc == null) throw new IllegalStateException("pc");
    List<String> ids = Collections.singletonList("archne-scr");
    RtpSender vs = pc.addTrack(vtrack, ids);
    tune(vs);
    if (wantAudio) {
      MediaConstraints ac = new MediaConstraints(); // musik/video: tanpa pemrosesan suara
      ac.mandatory.add(new MediaConstraints.KeyValuePair("googEchoCancellation", "false"));
      ac.mandatory.add(new MediaConstraints.KeyValuePair("googNoiseSuppression", "false"));
      ac.mandatory.add(new MediaConstraints.KeyValuePair("googAutoGainControl", "false"));
      ac.mandatory.add(new MediaConstraints.KeyValuePair("googHighpassFilter", "false"));
      asrc = factory.createAudioSource(ac);
      atrack = factory.createAudioTrack("archne-scr-a", asrc);
      pc.addTrack(atrack, ids);
    }
    remoteSet = false;
    synchronized (pendIce) { pendIce.clear(); }
    final PeerConnection p = pc;
    p.createOffer(new Obs() {
      @Override public void onCreateSuccess(final SessionDescription d) {
        p.setLocalDescription(new Obs() {
          @Override public void onSetSuccess() { JSObject o = new JSObject(); o.put("t", "offer"); o.put("sdp", d.description); notifyListeners("sig", o); }
          @Override public void onSetFailure(String e) { Log.e(TAG, "setLocal: " + e); emit("ended"); cleanup(); }
        }, d);
      }
      @Override public void onCreateFailure(String e) { Log.e(TAG, "offer: " + e); emit("ended"); cleanup(); }
    }, new MediaConstraints());
    main.postDelayed(sizeWatch, 1000);
  }

  /** Resolusi dan fps dipertahankan (tidak diturunkan otomatis demi "stabil"); batas atas lega. */
  private void tune(RtpSender s) {
    try {
      RtpParameters p = s.getParameters();
      p.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION;
      for (RtpParameters.Encoding e : p.encodings) { e.maxBitrateBps = LOOP_MAX_BPS; e.maxFramerate = FPS; }
      s.setParameters(p);
    } catch (RuntimeException e) { Log.w(TAG, "tune: " + e); }
  }

  /** HP diputar: ukuran layar berubah, perbarui ukuran tangkapan (tanpa mengganti trek). */
  private void checkSize() {
    try {
      int[] sz = fit(realMetrics());
      if (sz[0] == cw && sz[1] == ch) return;
      cw = sz[0]; ch = sz[1];
      if (capturer != null) capturer.changeCaptureFormat(cw, ch, FPS);
      JSObject o = new JSObject(); o.put("t", "size"); o.put("w", cw); o.put("h", ch); notifyListeners("sig", o);
    } catch (RuntimeException e) { Log.w(TAG, "size: " + e); }
  }

  private void emit(String t) { JSObject o = new JSObject(); o.put("t", t); notifyListeners("sig", o); }

  private void audioFail() { if (active) emit("audiofail"); }

  private synchronized void cleanup() {
    active = false;
    main.removeCallbacks(sizeWatch);
    SysAudio s = sys; sys = null;
    if (s != null) s.release();
    try { if (capturer != null) capturer.stopCapture(); } catch (RuntimeException e) { /* sudah berhenti */ }
    try { if (capturer != null) capturer.dispose(); } catch (RuntimeException e) { /* abaikan */ }
    capturer = null;
    try { if (pc != null) { pc.close(); pc.dispose(); } } catch (RuntimeException e) { /* abaikan */ }
    pc = null;
    try { if (vtrack != null) vtrack.dispose(); } catch (RuntimeException e) { /* abaikan */ }
    try { if (atrack != null) atrack.dispose(); } catch (RuntimeException e) { /* abaikan */ }
    try { if (vsrc != null) vsrc.dispose(); } catch (RuntimeException e) { /* abaikan */ }
    try { if (asrc != null) asrc.dispose(); } catch (RuntimeException e) { /* abaikan */ }
    vtrack = null; atrack = null; vsrc = null; asrc = null;
    try { if (helper != null) helper.dispose(); } catch (RuntimeException e) { /* abaikan */ }
    helper = null;
    try { if (factory != null) factory.dispose(); } catch (RuntimeException e) { /* abaikan */ }
    factory = null;
    try { if (adm != null) adm.release(); } catch (RuntimeException e) { /* abaikan */ }
    adm = null;
    try { if (egl != null) egl.release(); } catch (RuntimeException e) { /* abaikan */ }
    egl = null;
    synchronized (pendIce) { pendIce.clear(); remoteSet = false; }
    ArchneService.screenMode(getContext().getApplicationContext(), false); // idempoten
  }

  // ---- audio sistem ----

  /**
   * Mengganti isi buffer mikrofon ADM native (10 ms per panggilan, dipanggil di utas rekam WebRTC) dengan suara sistem.
   * Gagal membuka AudioRecord = senyap + kejadian 'audiofail' (UI melepas trek audio dan memberi tahu pengguna; layar tetap dibagikan).
   */
  private final class SysAudio implements JavaAudioDeviceModule.AudioBufferCallback {
    private final Object lock = new Object();
    private AudioRecord rec;
    private ByteBuffer rb;
    private boolean tried, released;

    @Override
    public long onBuffer(ByteBuffer buffer, int audioFormat, int channelCount, int sampleRate, int bytesRead, long captureTimeNs) {
      if (!tried) { tried = true; open(audioFormat, channelCount, sampleRate, buffer.capacity()); }
      AudioRecord r; ByteBuffer b;
      synchronized (lock) { r = rec; b = rb; }
      buffer.clear();
      boolean got = false;
      if (r != null && b != null && b.capacity() == buffer.capacity()) {
        b.clear();
        int n = r.read(b, b.capacity());
        if (n == b.capacity()) { b.clear(); buffer.put(b); got = true; }
        else if (n < 0) { Log.w(TAG, "AudioRecord.read: " + n); release(); audioFail(); }
      }
      if (!got) { buffer.clear(); while (buffer.hasRemaining()) buffer.put((byte) 0); } // tidak ada suara sistem: senyap (jangan teruskan mikrofon)
      buffer.clear();
      return captureTimeNs;
    }

    private void open(int fmt, int ch, int rate, int cap) {
      if (Build.VERSION.SDK_INT < 29 || (ch != 1 && ch != 2)) { audioFail(); return; }
      MediaProjection mp = capturer == null ? null : capturer.getMediaProjection();
      if (mp == null) { Log.e(TAG, "no MediaProjection"); audioFail(); return; }
      AudioRecord r = null;
      try {
        AudioPlaybackCaptureConfiguration cfg = config(mp, true);
        int mask = ch == 1 ? AudioFormat.CHANNEL_IN_MONO : AudioFormat.CHANNEL_IN_STEREO;
        int enc = fmt == AudioFormat.ENCODING_DEFAULT ? AudioFormat.ENCODING_PCM_16BIT : fmt;
        int min = AudioRecord.getMinBufferSize(rate, mask, enc);
        if (min <= 0) throw new IllegalStateException("minBuffer " + min);
        r = new AudioRecord.Builder()
          .setAudioFormat(new AudioFormat.Builder().setEncoding(enc).setSampleRate(rate).setChannelMask(mask).build())
          .setBufferSizeInBytes(Math.max(2 * min, cap))
          .setAudioPlaybackCaptureConfig(cfg)
          .build();
        r.startRecording();
        if (r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("not recording");
      } catch (Exception e) {
        Log.e(TAG, "system-audio AudioRecord failed", e);
        if (r != null) { try { r.release(); } catch (RuntimeException x) { /* abaikan */ } }
        audioFail();
        return;
      }
      ByteBuffer b = ByteBuffer.allocateDirect(cap).order(ByteOrder.nativeOrder());
      synchronized (lock) { if (released) { r.release(); return; } rec = r; rb = b; }
    }

    void release() {
      synchronized (lock) {
        released = true;
        if (rec != null) { try { rec.stop(); } catch (RuntimeException e) { /* abaikan */ } try { rec.release(); } catch (RuntimeException e) { /* abaikan */ } rec = null; }
      }
    }
  }

  /** Suara Archne sendiri (lawan bicara, penonton) dikeluarkan lewat excludeUid supaya tidak ada gema. Ditolak sistem -> tanpa pengecualian (UI diberi tahu lewat log saja). */
  private static AudioPlaybackCaptureConfiguration config(MediaProjection mp, boolean exclude) {
    AudioPlaybackCaptureConfiguration.Builder b = new AudioPlaybackCaptureConfiguration.Builder(mp)
      .addMatchingUsage(android.media.AudioAttributes.USAGE_MEDIA)
      .addMatchingUsage(android.media.AudioAttributes.USAGE_GAME)
      .addMatchingUsage(android.media.AudioAttributes.USAGE_UNKNOWN);
    if (exclude) {
      try { return b.excludeUid(Process.myUid()).build(); }
      catch (RuntimeException e) { Log.w(TAG, "excludeUid rejected: " + e); return config(mp, false); }
    }
    return b.build();
  }

  // ---- pengamat WebRTC ----

  private class Obs implements SdpObserver {
    public void onCreateSuccess(SessionDescription d) { }
    public void onSetSuccess() { }
    public void onCreateFailure(String e) { }
    public void onSetFailure(String e) { }
  }

  private class PcObs implements PeerConnection.Observer {
    public void onSignalingChange(PeerConnection.SignalingState s) { }
    public void onIceConnectionChange(PeerConnection.IceConnectionState s) {
      if (s == PeerConnection.IceConnectionState.FAILED && active) { Log.e(TAG, "loopback ICE failed"); emit("ended"); main.post(new Runnable() { public void run() { cleanup(); } }); }
    }
    public void onIceConnectionReceivingChange(boolean b) { }
    public void onIceGatheringChange(PeerConnection.IceGatheringState s) { }
    public void onIceCandidate(IceCandidate c) {
      JSObject o = new JSObject();
      o.put("t", "ice"); o.put("c", c.sdp); o.put("mid", c.sdpMid == null ? "" : c.sdpMid); o.put("ml", c.sdpMLineIndex);
      notifyListeners("sig", o);
    }
    public void onIceCandidatesRemoved(IceCandidate[] c) { }
    public void onAddStream(MediaStream s) { }
    public void onRemoveStream(MediaStream s) { }
    public void onDataChannel(DataChannel d) { }
    public void onRenegotiationNeeded() { }
    public void onAddTrack(RtpReceiver r, MediaStream[] s) { }
  }
}
