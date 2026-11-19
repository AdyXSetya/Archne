package com.xyraori.archne;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.content.res.Resources;

import java.util.Locale;

/**
 * Bahasa teks native (notifikasi). Sumber kebenarannya bahasa aplikasi di Core (en bawaan | id); halaman pembungkus
 * (www/index.html) meneruskannya: start(port, token, lang) saat inti siap, setLang(lang) saat pengguna menggantinya.
 * Disimpan di SharedPreferences "archne" kunci "lang" supaya layanan yang dihidupkan ulang sistem tetap memakai bahasa terakhir.
 * Teks ada di res/values/archne_strings.xml (en) dan res/values-in/archne_strings.xml (id); kunci dipanggil TANPA awalan "archne_".
 */
final class ArchneLang {
  private static volatile String cur = null;

  private ArchneLang() {}

  static String get(Context c) {
    String l = cur;
    if (l == null) {
      l = c.getApplicationContext().getSharedPreferences("archne", Context.MODE_PRIVATE).getString("lang", "en");
      cur = "id".equals(l) ? "id" : "en";
      l = cur;
    }
    return l;
  }

  /** Simpan bahasa (nilai selain "id" dianggap en). Mengembalikan true bila berubah. */
  static boolean set(Context c, String lang) {
    String l = "id".equals(lang) ? "id" : "en";
    boolean changed = !l.equals(get(c));
    cur = l;
    if (changed) {
      SharedPreferences sp = c.getApplicationContext().getSharedPreferences("archne", Context.MODE_PRIVATE);
      sp.edit().putString("lang", l).apply();
    }
    return changed;
  }

  /** Teks berbahasa aplikasi. name tanpa awalan archne_; args dipakai bila teksnya berisi %1$s dst. Kunci hilang: kembalikan namanya. */
  static String s(Context c, String name, Object... args) {
    Context base = c.getApplicationContext();
    Configuration cfg = new Configuration(base.getResources().getConfiguration());
    cfg.setLocale(new Locale(get(base)));
    Resources r = base.createConfigurationContext(cfg).getResources();
    int id = r.getIdentifier("archne_" + name, "string", base.getPackageName());
    if (id == 0) return name;
    String t = r.getString(id);
    return args == null || args.length == 0 ? t : String.format(Locale.ROOT, t, args);
  }
}
