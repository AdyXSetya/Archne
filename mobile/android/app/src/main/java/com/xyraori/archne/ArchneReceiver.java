package com.xyraori.archne;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * Tombol di notifikasi yang tidak perlu membuka aplikasi: Balas (balasan langsung), Tandai dibaca / notifikasi digeser, dan Tolak panggilan.
 * Kerja jaringan (HTTP ke inti Node di 127.0.0.1) dijalankan di utas latar dengan goAsync agar tidak menahan utas utama.
 * "Jawab" bukan di sini: itu membuka aplikasi (audio WebRTC ada di UI), lihat ArchneService.showCall.
 */
public class ArchneReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(final Context ctx, Intent i) {
    if (i == null) return;
    String act = String.valueOf(i.getAction());
    final String key = i.getStringExtra(ArchneService.EXTRA_KEY);
    final String cid = i.getStringExtra(ArchneService.EXTRA_CID);

    if (ArchneService.ACTION_READ.equals(act)) {
      if (key != null) ArchneService.markRead(ctx, key);
      return;
    }

    if (ArchneService.ACTION_REPLY.equals(act)) {
      if (key == null) return;
      Bundle r = RemoteInput.getResultsFromIntent(i);
      CharSequence t = r == null ? null : r.getCharSequence(ArchneService.KEY_REPLY);
      final String text = t == null ? "" : t.toString().trim();
      if (text.length() == 0) { ArchneService.postChat(ctx, key, true); return; } // tidak ada teks: cukup hentikan indikator "mengirim"
      final PendingResult pr = goAsync();
      new Thread(new Runnable() {
        public void run() {
          try { ArchneService.reply(ctx, key, text); }
          finally { pr.finish(); }
        }
      }, "archne-reply").start();
      return;
    }

    if (ArchneService.ACTION_DECLINE.equals(act) && cid != null) {
      final PendingResult pr = goAsync();
      new Thread(new Runnable() {
        public void run() {
          try { ArchneService.decline(ctx, cid); }
          finally { pr.finish(); }
        }
      }, "archne-decline").start();
    }
  }
}
