package com.xyraori.archne;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Sisi Android untuk panggilan suara. Audio WebRTC-nya sendiri jalan di WebView; plugin ini mengurus yang tidak bisa dilakukan WebView:
 *   mic(): pastikan izin RECORD_AUDIO (WebView hanya meneruskan, tidak memunculkan dialog izin). Hasil: "granted" | "denied" | "blocked" (ditolak permanen).
 *   cam(): sama untuk izin CAMERA (panggilan video). Dipanggil UI hanya saat kamera diminta; hasilnya sama: "granted" | "denied" | "blocked".
 *   begin(): mulai sesi panggilan. Mode MODE_IN_COMMUNICATION, fokus audio, rute awal earpiece (headset kabel/Bluetooth dipilih sistem),
 *            dan layanan latar dinaikkan ke tipe mikrofon agar mikrofon tetap hidup saat aplikasi di belakang/layar mati.
 *   end(): kembalikan semuanya. Aman dipanggil berulang.
 *   speaker(on): true = pengeras suara, false = rute bawaan sistem.
 */
public class ArchneAudio extends CordovaPlugin {
  private static final int REQ_MIC = 7303, REQ_CAM = 7304;
  private CallbackContext micCb, camCb;
  private boolean active = false;
  private int prevMode = AudioManager.MODE_NORMAL;
  private boolean prevSpeaker = false;
  private AudioFocusRequest focus; // API 26+

  private AudioManager am() {
    return (AudioManager) cordova.getActivity().getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
  }

  @Override
  public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
    if ("mic".equals(action)) {
      if (cordova.hasPermission(Manifest.permission.RECORD_AUDIO)) { cb.success("granted"); return true; }
      if (micCb != null) { cb.success("denied"); return true; } // dialog sebelumnya belum selesai
      micCb = cb;
      cordova.requestPermission(this, REQ_MIC, Manifest.permission.RECORD_AUDIO);
      return true;
    }
    if ("cam".equals(action)) {
      if (cordova.hasPermission(Manifest.permission.CAMERA)) { cb.success("granted"); return true; }
      if (camCb != null) { cb.success("denied"); return true; } // dialog sebelumnya belum selesai
      camCb = cb;
      cordova.requestPermission(this, REQ_CAM, Manifest.permission.CAMERA);
      return true;
    }
    if ("begin".equals(action)) { begin(); cb.success("ok"); return true; }
    if ("end".equals(action)) { end(); cb.success("ok"); return true; }
    if ("speaker".equals(action)) {
      boolean on = args.optBoolean(0, false);
      if (!active) { cb.error("nocall"); return true; }
      if (route(on)) cb.success(on ? "speaker" : "default"); else cb.error("noroute");
      return true;
    }
    return false;
  }

  @Override
  public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) throws JSONException {
    if (requestCode != REQ_MIC && requestCode != REQ_CAM) return;
    boolean cam = requestCode == REQ_CAM;
    String perm = cam ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO;
    CallbackContext cb = cam ? camCb : micCb;
    if (cam) camCb = null; else micCb = null;
    if (cb == null) return;
    boolean ok = grantResults != null && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
    if (ok) { cb.success("granted"); return; }
    // Tanpa dialog (ditolak permanen) atau "jangan tanya lagi": rationale = false. Setelah penolakan pertama rationale = true.
    boolean again = cordova.getActivity().shouldShowRequestPermissionRationale(perm);
    cb.success(again ? "denied" : "blocked");
  }

  private synchronized void begin() {
    if (active) return;
    AudioManager a = am();
    if (a == null) return;
    try {
      prevMode = a.getMode();
      prevSpeaker = Build.VERSION.SDK_INT < 31 && a.isSpeakerphoneOn();
      if (Build.VERSION.SDK_INT >= 26) {
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          .setOnAudioFocusChangeListener(new AudioManager.OnAudioFocusChangeListener() { public void onAudioFocusChange(int change) { /* panggilan tetap jalan */ } })
          .build();
        a.requestAudioFocus(focus);
      } else {
        a.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
      }
      a.setMode(AudioManager.MODE_IN_COMMUNICATION);
      active = true;
      route(false);
    } catch (RuntimeException e) { /* tanpa mode panggilan: audio tetap bisa jalan lewat rute bawaan WebView */ }
    ArchneService.callMode(cordova.getActivity().getApplicationContext(), true);
  }

  private synchronized void end() {
    ArchneService.callMode(cordova.getActivity().getApplicationContext(), false);
    if (!active) return;
    active = false;
    AudioManager a = am();
    if (a == null) return;
    try {
      if (Build.VERSION.SDK_INT >= 31) a.clearCommunicationDevice(); else a.setSpeakerphoneOn(prevSpeaker);
      if (Build.VERSION.SDK_INT >= 26) { if (focus != null) a.abandonAudioFocusRequest(focus); } else a.abandonAudioFocus(null);
      focus = null;
      a.setMode(prevMode);
    } catch (RuntimeException e) { /* abaikan */ }
  }

  /** true = berhasil. on=false mengembalikan ke pilihan sistem (earpiece, atau headset bila terpasang). */
  private boolean route(boolean on) {
    AudioManager a = am();
    if (a == null) return false;
    try {
      if (Build.VERSION.SDK_INT >= 31) {
        if (!on) { a.clearCommunicationDevice(); return true; }
        for (AudioDeviceInfo d : a.getAvailableCommunicationDevices()) {
          if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return a.setCommunicationDevice(d);
        }
        return false;
      }
      a.setSpeakerphoneOn(on);
      return true;
    } catch (RuntimeException e) { return false; }
  }

  // Halaman induk dimuat ulang atau aktivitas ditutup tanpa end(): jangan tinggalkan mode panggilan dan layanan bertipe mikrofon.
  @Override
  public void onReset() { end(); }

  @Override
  public void onDestroy() { end(); }
}
