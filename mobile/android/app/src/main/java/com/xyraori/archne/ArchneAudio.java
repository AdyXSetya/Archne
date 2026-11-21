package com.xyraori.archne;

import android.Manifest;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Sisi Android untuk panggilan suara dan video. Audio WebRTC-nya sendiri jalan di WebView; plugin ini mengurus yang tidak bisa dilakukan WebView.
 * Semua jawaban berbentuk { value: "..." } (lihat halaman pembungkus mobile/shell/index.html):
 *   mic(): pastikan izin RECORD_AUDIO. value: "granted" | "denied" | "blocked" (ditolak permanen).
 *   cam(): sama untuk izin CAMERA (panggilan video).
 *   begin(): mulai sesi panggilan. MODE_IN_COMMUNICATION, fokus audio, rute awal earpiece (headset kabel/Bluetooth dipilih sistem),
 *            dan layanan latar dinaikkan ke tipe mikrofon agar mikrofon tetap hidup saat aplikasi di belakang/layar mati.
 *   end(): kembalikan semuanya. Aman dipanggil berulang.
 *   speaker({on}): true = pengeras suara, false = rute bawaan sistem. Galat "nocall" bila tidak ada sesi, "noroute" bila rute gagal.
 */
@CapacitorPlugin(name = "ArchneAudio", permissions = {
  @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic"),
  @Permission(strings = { Manifest.permission.CAMERA }, alias = "cam")
})
public class ArchneAudio extends Plugin {
  private boolean active = false;
  private int prevMode = AudioManager.MODE_NORMAL;
  private boolean prevSpeaker = false;
  private AudioFocusRequest focus; // API 26+

  private AudioManager am() {
    return (AudioManager) getContext().getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
  }

  private static void value(PluginCall call, String v) {
    JSObject r = new JSObject();
    r.put("value", v);
    call.resolve(r);
  }

  @PluginMethod
  public void mic(PluginCall call) { ask(call, "mic", "micResult"); }

  @PluginMethod
  public void cam(PluginCall call) { ask(call, "cam", "camResult"); }

  private void ask(PluginCall call, String alias, String callback) {
    if (getPermissionState(alias) == PermissionState.GRANTED) { value(call, "granted"); return; }
    requestPermissionForAlias(alias, call, callback);
  }

  @PermissionCallback
  private void micResult(PluginCall call) { answer(call, "mic", Manifest.permission.RECORD_AUDIO); }

  @PermissionCallback
  private void camResult(PluginCall call) { answer(call, "cam", Manifest.permission.CAMERA); }

  private void answer(PluginCall call, String alias, String perm) {
    if (getPermissionState(alias) == PermissionState.GRANTED) { value(call, "granted"); return; }
    // Tanpa dialog (ditolak permanen) atau "jangan tanya lagi": rationale = false. Setelah penolakan pertama rationale = true.
    boolean again = getActivity().shouldShowRequestPermissionRationale(perm);
    value(call, again ? "denied" : "blocked");
  }

  @PluginMethod
  public void begin(PluginCall call) { begin(); value(call, "ok"); }

  @PluginMethod
  public void end(PluginCall call) { end(); value(call, "ok"); }

  @PluginMethod
  public void speaker(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
    if (!active) { call.reject("nocall"); return; }
    if (route(on)) value(call, on ? "speaker" : "default"); else call.reject("noroute");
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
    ArchneService.callMode(getContext().getApplicationContext(), true);
  }

  private synchronized void end() {
    ArchneService.callMode(getContext().getApplicationContext(), false);
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

  // Aktivitas ditutup tanpa end(): jangan tinggalkan mode panggilan dan layanan bertipe mikrofon.
  @Override
  protected void handleOnDestroy() { end(); }
}
