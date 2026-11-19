'use strict';
// renderer/archne-msgmenu.js — menu aksi pesan (v0.24.0): fungsi murni, tanpa DOM, supaya bisa dites dengan Node.
// Menggantikan bar tombol melayang (.macts) yang menimpa gelembung/strip di sekitarnya. Satu menu global (#mmenu):
// popover yang dijepit ke layar (desktop) atau bottom sheet (layar sentuh). Penanganan DOM ada di js/archne-msgmenu.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MsgMenu = factory();
})(this, function () {
  // i18n (D2): I18N dimuat sebelum berkas ini di archne-index.html; di Node murni / tes vm lama tidak ada, maka teks Indonesia cadangan dipakai.
  const fill = (fb, p) => (p ? fb.replace(/\{(\w+)\}/g, (m, x) => (p[x] != null ? p[x] : m)) : fb);
  const T = (k, fb, p) => (typeof I18N !== 'undefined' && I18N.tx ? I18N.tx(k, p) : fill(fb, p));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GAP = 4, EDGE = 8;
  // Cadangan gambar untuk emoji yang baru ada di Unicode 14/15 dan sering jadi kotak kosong di Android < 13 / Windows 10: 🩷 🫡 🫶.
  // Grafik: Twemoji 15.0 (c) Twitter, Inc dan kontributor, CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/); sumber paket @twemoji/svg. CSP hanya mengizinkan img data:, jadi disisipkan sebagai data URI.
  const IMG = {
    '\uD83E\uDE77': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzNiAzNiI+PHBhdGggZmlsbD0iI0Y0QUJCQSIgZD0iTTM1Ljg4NSAxMS44MzNjMC01LjQ1LTQuNDE4LTkuODY4LTkuODY3LTkuODY4LTMuMzA4IDAtNi4yMjcgMS42MzMtOC4wMTggNC4xMjktMS43OTEtMi40OTYtNC43MS00LjEyOS04LjAxNy00LjEyOS01LjQ1IDAtOS44NjggNC40MTctOS44NjggOS44NjggMCAuNzcyLjA5OCAxLjUyLjI2NiAyLjI0MUMxLjc1MSAyMi41ODcgMTEuMjE2IDMxLjU2OCAxOCAzNC4wMzRjNi43ODMtMi40NjYgMTYuMjQ5LTExLjQ0NyAxNy42MTctMTkuOTU5LjE3LS43MjEuMjY4LTEuNDY5LjI2OC0yLjI0MnoiLz48L3N2Zz4=',
    '\uD83E\uDEE1': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbDpzcGFjZT0icHJlc2VydmUiIHZpZXdCb3g9IjAgMCAzNiAzNiI+PHBhdGggZmlsbD0iI0ZGQ0M0RCIgZD0iTTM2IDIxYzAgOC4yODItNi43MTggMTUtMTUgMTUtOC4yODQgMC0xNS02LjcxOC0xNS0xNSAwLTguMjg0IDYuNzE2LTE1IDE1LTE1IDguMjgyIDAgMTUgNi43MTYgMTUgMTUiLz48cGF0aCBmaWxsPSIjRjQ5MDBDIiBkPSJNMjIuODY0IDEuMTM0QTEuNTEgMS41MSAwIDAgMCAyMS41NS4wMDRhMS42MDggMS42MDggMCAwIDAtLjc5OS4xMTlsLTUuNzc1IDIuNDQ2Yy0zLjMxNCAxLjA3NC0zLjExNi45NzUtMy42MjYgMS4yODEtLjkxNS41NDctMi4wMDcgMS41MTMtMy45NjEgMy4zNzdDNS43MjggOC44MTEuMDU5IDkuNzk0LjA0MSAxNS4yOTcuMDM0IDE3LjQzOCAxLjY5OCAxOS4xOTIgNCAxOS4xODVjMi40MjMtLjAwOCAzLjgxNi0xLjI5IDQuNDgyLTIuMTU5YTQuMTYxIDQuMTYxIDAgMCAxIDEuNTItMS4yMjhjMy45My0xLjg3NSAyLjI1Ni0zLjUyMiA1LjE4NS03LjI4MWEuNzEyLjcxMiAwIDAgMC0uMjI2LTEuMDcxbDYuODU4LTQuMDI0Yy42MDgtLjM1Ny44NzgtMS4wMDQuNjk4LTEuNjc0bC4wOTUtLjA1MWEuNTA1LjUwNSAwIDAgMCAuMjUyLS41NjN6Ii8+PHBhdGggZmlsbD0iI0I1NTAwNSIgZD0iTTIyLjgyMyAxLjIzOWEuMzQ4LjM0OCAwIDAgMC0uNDY3LS4xNjRsLTIuNjk4IDEuMjk0YTEuNzQxIDEuNzQxIDAgMCAwLS4wODgtMS4xNjUgMS41MjQgMS41MjQgMCAwIDAtLjMxNi0uNDQ3bC0uNzY0LjMyM2EuODI1LjgyNSAwIDAgMSAuNDQ0LjQxN2MuMjA5LjQ1NC4wNjIgMS4xMi0uNjIzIDEuNTE4bC0yLjU4NSAxLjI0Yy4yNjktLjU0LjMzOC0xLjA5My4yMS0xLjU0MmExLjQ3NiAxLjQ3NiAwIDAgMC0uMjI0LS40NTZsLS42OTEuMjkzYS43MTQuNzE0IDAgMCAxIC4yNDIuMzU0Yy4xOTYuNjg5LS4zMzMgMS43NDctMS41NiAyLjMyMy0xLjE3MS41NS0xLjUzNCAxLjQzMS0xLjk1NSAyLjQ1Mi0uMTkzLjQ2Ny0uNDExLjk5Ni0uNzM0IDEuNTUzLS44NTkgMS40OC0yLjk4MyAzLjg4NS0zLjkzIDQuODE2YS4zNS4zNSAwIDEgMCAuNDkxLjQ5OWMuOTE1LS44OTggMy4xMTEtMy4zNTQgNC4wNDUtNC45NjNsLjAwNC0uMDA3LjAwMS0uMDAxYy45MDMtMS42NiAxLjg5My0yLjI4OCAyLjQ3OC0yLjE3LjQxOS4wODQuNTI5LjU0NS41NTcuODEzYS4zNS4zNSAwIDAgMCAuNjk2LS4wNzJjLS4wOC0uNzctLjQ5Ny0xLjMwMy0xLjExNi0xLjQyNy0uNDAxLS4wODItLjkxOS4wMjEtMS40NzguNDAzLjI3NC0uNTQyLjYwNi0uOTYzIDEuMjQtMS4yNi4wNS0uMDIzLjA5LS4wNTMuMTM3LS4wNzcuMDEtLjAwNC4wMjEtLjAwMi4wMzItLjAwN2w4LjM0OC00LjAwNGMtLjAwMi0uMDA5IDAtLjAxNy0uMDAzLS4wMjZsLjA5NC0uMDUxYS41LjUgMCAwIDAgLjI0Ni0uMzI1LjMzNS4zMzUgMCAwIDAtLjAzMy0uMTM0eiIvPjxwYXRoIGZpbGw9IiM2NTQ3MUIiIGQ9Ik0yMSAyOS4yNWMtNC4wNzYgMC02LjE1Ni0uNTA4LTYuMjQzLS41M2ExLjAwMSAxLjAwMSAwIDAgMS0uNzI4LTEuMjEzIDEuMDA1IDEuMDA1IDAgMCAxIDEuMjExLS43MjhjLjAzOS4wMSAxLjk4Mi40NzEgNS43NTkuNDcxIDMuNzk2IDAgNS43NC0uNDY2IDUuNzYtLjQ3MWEuOTk5Ljk5OSAwIDAgMSAuNDgzIDEuOTRjLS4wODYuMDIzLTIuMTY2LjUzMS02LjI0Mi41MzF6TTE4IDE0aC00YTEgMSAwIDAgMCAwIDJoLjUxOWMtLjMxOS41MzItLjUxOSAxLjIyOC0uNTE5IDIgMCAxLjY1OC44OTYgMyAyIDNzMi0xLjM0MyAyLTNjMC0uNzcyLS4yLTEuNDY4LS41MTktMkgxOGExIDEgMCAwIDAgMC0yem0xMCAwaC00YTEgMSAwIDAgMCAwIDJoLjUxOWMtLjMxOS41MzItLjUxOSAxLjIyOC0uNTE5IDIgMCAxLjY1Ny44OTYgMyAyIDNzMi0xLjM0MiAyLTNjMC0uNzcyLS4yLTEuNDY4LS41MTktMkgyOGExIDEgMCAwIDAgMC0yeiIvPjwvc3ZnPg==',
    '\uD83E\uDEF6': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbDpzcGFjZT0icHJlc2VydmUiIHZpZXdCb3g9IjAgMCAzNiAzNiI+PHBhdGggZmlsbD0iI0ZGREM1RCIgZD0iTTEzLjk5NiAyMy40OThhMTAuODY2IDEwLjg2NiAwIDAgMS01LjkwNS01LjMxNiA3LjI4OCA3LjI4OCAwIDAgMS0uNS01LjIyNSAyLjg0OSAyLjg0OSAwIDAgMSAxLjg0NC0xLjkzNiA0LjgzNSA0LjgzNSAwIDAgMSAzLjEyMS4wMjFsMS43NDEuNjA3Yy40NDkuMjI1Ljc5MS42MTkuOTUgMS4wOTZsLjQzNiAxLjMwN2MuMTkuNTY2LjcyLjk0OCAxLjMxNy45NDggMCAwIDEgMCAxLTF2LTIuMjJhMy44IDMuOCAwIDAgMC0xLjM2OC0yLjkybC0zLjgyLTMuMTgzYTIuMDAxIDIuMDAxIDAgMCAwLTEuODMtLjM4N0w1LjYxNCA2LjgyNWEyIDIgMCAwIDAtMS4wMTMuNjczTDAgMTJ2OC43N2wxLjI2NiAzLjE0MiAzLjE3OSAxLjQxOUM1LjEyOCAyNS4xMjcgNS44MzggMjUgNi41IDI1YzIuNjk0IDAgNi4wMjMuNjQyIDguOTA1IDIuODA0bC45MzcuNzAzYS45NDkuOTQ5IDAgMCAwIDEuMjM5LS4wODhMMTggMjh2LTJjMC0xLTQuMDA0LTIuNTAyLTQuMDA0LTIuNTAyeiIvPjxwYXRoIGZpbGw9IiNGRkRDNUQiIGQ9Ik0zMS4zOTkgNy40OThhMiAyIDAgMCAwLTEuMDEyLS42NzRMMjUuMDE4IDUuMjlhMiAyIDAgMCAwLTEuODMuMzg3bC0zLjgyIDMuMTgzQTMuOCAzLjggMCAwIDAgMTggMTEuNzhWMTRjMCAxIDEgMSAxIDEgLjU5NyAwIDEuMTI3LS4zODIgMS4zMTYtLjk0OWwuNDM2LTEuMzA3Yy4xNTktLjQ3Ny41MDEtLjg3MS45NS0xLjA5NmwxLjc0MS0uNjA3YTQuODM1IDQuODM1IDAgMCAxIDMuMTIxLS4wMjEgMi44NSAyLjg1IDAgMCAxIDEuODQ0IDEuOTM2IDcuMjg4IDcuMjg4IDAgMCAxLS41IDUuMjI1IDEwLjg3IDEwLjg3IDAgMCAxLTUuOTA1IDUuMzE2QzIyLjAwNCAyMy40OTggMTggMjUgMTggMjZ2MmwuNDE5LjQxOWEuOTQ5Ljk0OSAwIDAgMCAxLjIzOS4wODhsLjkzNy0uNzAzQzIzLjQ3NyAyNS42NDIgMjYuODA2IDI1IDI5LjUgMjVjLjY2MSAwIDEuMzcyLjEyOCAyLjA1NC4zMzJsMy4xOC0xLjQyTDM2IDIwLjc3VjEybC00LjYwMS00LjUwMnoiLz48cGF0aCBmaWxsPSIjRjlDQTU1IiBkPSJNNC40NDUgMjUuMzMxYy0xLjU3MS0xLjMtMi4xNzYtLjgzNi0zLjE3OS0yLjQxOS0uMDg1LS4xMy0xLjA2LTIuMDgzLTEuMjY2LTIuMTQyVjI4bDEuOTY3LTEuNDc1Yy42MzYtLjQ3NyAxLjUzMi0uOTEgMi40NzktMS4xOTNsLS4wMDEtLjAwMXptMzAuMjg5LTIuNDE5Yy0xLjAwMyAxLjU4My0xLjYwOCAxLjExOS0zLjE4IDIuNDIuOTQ4LjI4MyAxLjg0My43MTYgMi40NzkgMS4xOTNMMzYgMjh2LTcuMjNjLS4yMDYuMDU5LTEuMTgxIDIuMDEyLTEuMjY2IDIuMTQyeiIvPjwvc3ZnPg==',
  };
  const img = (e) => (IMG[e] ? '<img class="emj" alt="' + e + '" src="' + IMG[e] + '">' : null);

  // Butir menu untuk satu pesan. o = { mine, pinned }. Urutan tetap: Balas, Sematkan, Salin, Batalkan (yang merusak selalu terakhir).
  function items(m, o) {
    o = o || {};
    const out = [{ act: 'reply', icon: '↩', label: T('cmt.reply', 'Balas') }];
    out.push(o.pinned ? { act: 'pin', icon: '📌', label: T('mm.pinned', 'Sudah disematkan'), disabled: true } : { act: 'pin', icon: '📌', label: T('pin.pinBtn', 'Sematkan') });
    if (m && typeof m.text === 'string' && m.text && !m.file && !m.call && !m.sys) out.push({ act: 'copy', icon: '⧉', label: T('mm.copyText', 'Salin teks') });
    if (o.mine) out.push({ act: 'del', icon: '🗑', label: T('mm.del', 'Batalkan untuk semua'), danger: true });
    return out;
  }

  // Baris emoji cepat di atas menu (hanya bila pesan bisa diberi reaksi). Emoji terakhir dipakai di depan, dilengkapi bawaan sampai 6. mine = reaksiku sekarang (disorot).
  // Bawaan = emoji lama (Unicode ≤ 6) yang tampil berwarna dan seragam di Windows/Android/iOS tanpa gambar cadangan; ☺ gaya-teks dan emoji baru (🩷 🥹 🫡) tidak dipakai di sini.
  const QUICK = ['👍', '\u2764\uFE0F', '😂', '😮', '😢', '🙏'];
  const same = esc; // show(e) mengembalikan HTML siap pakai; bawaan: emoji apa adanya (di-escape)
  function quick(recent, mine, show) {
    show = show || same;
    const seen = new Set(), list = [];
    for (const e of (Array.isArray(recent) ? recent : []).concat(QUICK)) if (typeof e === 'string' && e && !seen.has(e) && list.length < 6) { seen.add(e); list.push(e); }
    return '<div class="mmq" role="group" aria-label="' + esc(T('mm.react', 'Reaksi')) + '">' + list.map((e) => '<button type="button" class="mmqb' + (e === mine ? ' on' : '') + '" data-rxq="' + esc(e) + '" aria-label="' + esc(T('mm.reactAria', 'Reaksi {e}', { e })) + '">' + show(e) + '</button>').join('') + '<button type="button" class="mmqb" data-rxmore="1" aria-label="' + esc(T('mm.moreEmoji', 'Emoji lain')) + '"><span class="mmplus" aria-hidden="true">+</span></button></div>';
  }
  // Chip di bawah gelembung. rx = [{ e, n, mine }] dari state().messages[].rx. Kosong -> ''.
  function chips(rx, show) {
    show = show || same;
    if (!Array.isArray(rx) || !rx.length) return '';
    return '<div class="rxs">' + rx.map((r) => '<button type="button" class="rxc' + (r.mine ? ' mine' : '') + '" data-rxc="' + esc(r.e) + '" title="' + esc(T('mm.chipTitle', 'Ketuk untuk bereaksi, tekan lama untuk melihat siapa')) + '">' + show(r.e) + (r.n > 1 ? '<b>' + (r.n | 0) + '</b>' : '') + '</button>').join('') + '</div>';
  }
  // Daftar pelaku satu emoji (tekan lama pada chip): who = [{ id, name }].
  function whoHtml(e, who, show) {
    return '<div class="mmw"><div class="mmwh">' + (show || same)(e) + ' · ' + (who ? who.length : 0) + '</div>' + (who || []).map((w) => '<div class="mmwr">' + esc(w.name) + '</div>').join('') + '</div>';
  }

  // Picker ➕: kolom ketik (papan ketik emoji Gboard / Win+.) + grid bawaan. Hanya satu emoji yang dikirim; Core yang memvalidasi.
  const GRID = ['👍', '👎', '❤️', '😂', '🤣', '😊', '😍', '😘', '😭', '😢', '😮', '😡', '🙏', '👏', '🙌', '🔥', '🎉', '🥳', '💯', '✅', '❌', '🤔', '😅', '😎', '🥰', '👀', '💔', '🤝', '💪', '👌', '😴', '🤯'];
  function picker(show) {
    show = show || same;
    return '<div class="mmp"><div class="mmpi"><input type="text" class="mmpin" maxlength="24" placeholder="' + esc(T('mm.emojiPh', 'Ketik atau tempel emoji')) + '" aria-label="Emoji" autocomplete="off"><button type="button" class="mmpok" data-rxok="1">' + esc(T('common.send', 'Kirim')) + '</button></div><div class="mmpg">'
      + GRID.map((e) => '<button type="button" class="mmqb" data-rxq="' + esc(e) + '" aria-label="' + esc(T('mm.reactAria', 'Reaksi {e}', { e })) + '">' + show(e) + '</button>').join('') + '</div></div>';
  }

  function html(its) {
    return its.map((i) => '<button type="button" role="menuitem" class="mmi' + (i.danger ? ' dng' : '') + '" data-mm="' + esc(i.act) + '"' + (i.disabled ? ' disabled' : '') + '><span class="mi-ic" aria-hidden="true">' + esc(i.icon) + '</span><span>' + esc(i.label) + '</span></button>').join('');
  }

  // Cuplikan pesan untuk kepala bottom sheet (satu baris pendek, supaya jelas pesan mana yang sedang dipilih).
  function preview(m, who) {
    let t = m && m.file ? '📎 ' + String((m.file && m.file.name) || T('prev.file', 'Berkas')) : (typeof Linkify !== 'undefined' ? Linkify.short(String((m && m.text) || '')) : String((m && m.text) || '')).replace(/\s+/g, ' ').trim();
    if (t.length > 90) t = t.slice(0, 89) + '…';
    return '<div class="mmh"><b>' + esc(who || '') + '</b><span>' + esc(t) + '</span></div>';
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Posisi popover. a = { left, right, top, bottom } (kotak jangkar; untuk klik kanan, titik: left=right, top=bottom),
  // size = { w, h }, vp = { w, h }, align = 'end' (rata kanan jangkar, bawaan) | 'start' (mulai dari kiri jangkar).
  // Prioritas: di bawah jangkar, lalu di atas; bila keduanya tak muat, dijepit ke tepi layar. Hasil selalu di dalam layar.
  function place(a, size, vp, align) {
    const w = Math.min(size.w, vp.w - 2 * EDGE), h = Math.min(size.h, vp.h - 2 * EDGE);
    const below = vp.h - a.bottom - EDGE >= h + GAP, above = a.top - EDGE >= h + GAP;
    const raw = below ? a.bottom + GAP : above ? a.top - h - GAP : a.top;
    const top = clamp(raw, EDGE, vp.h - h - EDGE); // jangkar yang sebagian sudah keluar layar tetap menghasilkan menu di dalam layar
    const left = clamp(align === 'start' ? a.left : a.right - w, EDGE, vp.w - w - EDGE);
    return { left, top, side: below ? 'below' : above ? 'above' : 'clamped' };
  }

  return { items, html, preview, place, esc, quick, chips, whoHtml, picker, img, QUICK };
});
