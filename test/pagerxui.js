'use strict';
// Tes 4a-6 / 4a-7: UI reaksi Halaman (4a-7: Halamanku + daftar pelaku, kelompok H, J, K, L) (renderer/js/archne-pages-react.js + kait di archne-pages.js). Kelima berkas Halaman dimuat BERSAMA di satu vm dengan DOM tiruan (seperti pageview.js).
// Kelompok: A statis (CSS, kait), B pgRxApply murni, C tampilan chip, D alur pasang / ganti / cabut (optimistik lalu keadaan Core), E kegagalan = kembali ke keadaan lama, F satu permintaan per postingan, G jawaban basi, H Halamanku tanpa baris reaksi, I masukan cacat.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = '1'.repeat(16), PEER = 'a'.repeat(16), P1 = '0000000000000001', P2 = '0000000000000002';
const post = (n, o) => Object.assign({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public' }, o || {});

function boot(withRxShow) {
  const els = {}, calls = [], toasts = [];
  const st = { list: null, react: null, mine: null };
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, addEventListener(t, f) { this.h[t] = f; }, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
  const api = {
    pgList: async (...a) => { calls.push(['pgList', ...a]); return st.list; },
    pgMine: async (...a) => { calls.push(['pgMine', ...a]); return st.mine; },
    pgReact: async (...a) => { calls.push(['pgReact', ...a]); const r = st.react; return typeof r === 'function' ? r(...a) : r; },
    onPgDl: () => {},
  };
  const E = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { S: { me: { id: ME }, messages: [] }, esc: E, nameOf: () => 'N', $: el, linkHtml: E, fmt: String, dayLabel: () => 'Hari ini', hm: () => '10:00', toast: (t) => toasts.push(t), ask: async () => true,
    renderProfile() {}, document: { addEventListener() {} }, Date, Promise, setTimeout, Set, window: { api, history: { pushState() {}, back() {} }, location: { protocol: 'file:', pathname: '/archne-index.html' } }, profId: PEER };
  if (withRxShow) ctx.rxShow = (e) => '<i>' + E(e) + '</i>';
  vm.createContext(ctx);
  vm.runInContext(rd('renderer/archne-filecard.js'), ctx);
  vm.runInContext(require('./_src').pagesJs(), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  return { els, calls, toasts, st, run, ctx, H: () => els.pglist.innerHTML, rxCalls: () => calls.filter((c) => c[0] === 'pgReact') };
}
async function openFeed(t, posts, id) { t.st.list = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 }; t.run(`pgOpen('${id || PEER}')`); await sleep(10); }
const click = (t, pg, id, e) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg, id, e } }) } });
const item = (t, id) => JSON.parse(t.run(`JSON.stringify(pgF.items.find((p) => p.id === '${id}'))`));
const QUICK = ['👍', '🩷', '\u263A\uFE0F', '🤣', '🥺', '😭'];

(async () => {
  // A. statis
  {
    const css = rd('renderer/css/archne-pages.css'), src = rd('renderer/js/archne-pages.js'), rx = rd('renderer/js/archne-pages-react.js');
    for (const c of ['.pgrxs', '.pgrxpick', '.pgrx.mine', '.pgrx[disabled]', '.pgrx:focus-visible', '.pgrxadd']) assert(css.includes('#pgmodal ' + c), 'CSS ' + c);
    assert(src.includes("a === 'rx' && id") && src.includes("a === 'rxadd' && id") && src.includes("a === 'who' && id") && src.includes('${pgRxHtml(p)}') && !src.includes("${mine ? '' : pgRxHtml(p)}"), 'kait di archne-pages.js (4a-7: baris reaksi juga di Halamanku, klik who)');
    for (const c of ['.pgrxwho', '.pgwho', '.pgwhorow', '.pgwhoe']) assert(css.includes('#pgmodal ' + c), 'CSS ' + c);
    assert(/DEFAULTS di src\/archne-reactions\.js/.test(rx), 'asal PG_RX_QUICK tercatat');
    const defaults = require('../src/archne-reactions').DEFAULTS; assert.deepStrictEqual(JSON.parse(boot().run('JSON.stringify(PG_RX_QUICK)')), [...defaults], 'PG_RX_QUICK di sumber = DEFAULTS archne-reactions.js (renderer tidak bisa require; tes ini yang menjaganya)'); assert.deepStrictEqual(QUICK, [...defaults]);
    ok('statis: CSS chip / pemilih / disorot / disabled / fokus, kait di archne-pages.js, PG_RX_QUICK sama dengan DEFAULTS archne-reactions.js');
  }
  // B. pgRxApply murni
  {
    const t = boot(), ap = (rx, mine, next) => JSON.parse(t.run(`JSON.stringify(pgRxApply(${JSON.stringify(rx)}, ${JSON.stringify(mine)}, ${JSON.stringify(next)}))`));
    assert.deepStrictEqual(ap(undefined, undefined, '👍'), { rx: [{ e: '👍', n: 1 }], mine: '👍' }, 'dari kosong');
    assert.deepStrictEqual(ap([{ e: '👍', n: 2 }], undefined, '👍'), { rx: [{ e: '👍', n: 3 }], mine: '👍' }, 'tambah ke yang ada');
    assert.deepStrictEqual(ap([{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], '🩷', ''), { rx: [{ e: '👍', n: 2 }], mine: '' }, 'cabut: n 1 -> entri hilang');
    assert.deepStrictEqual(ap([{ e: '👍', n: 3 }], '👍', ''), { rx: [{ e: '👍', n: 2 }], mine: '' }, 'cabut: n turun');
    assert.deepStrictEqual(ap([{ e: '👍', n: 2 }, { e: '🩷', n: 2 }], '👍', '🩷'), { rx: [{ e: '🩷', n: 3 }, { e: '👍', n: 1 }], mine: '🩷' }, 'ganti: terbanyak dulu');
    assert.deepStrictEqual(ap([{ e: '👍', n: 2 }, { e: '🩷', n: 2 }], '', '🥺'), { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 2 }, { e: '🥺', n: 1 }], mine: '🥺' }, 'seri: urutan lama tetap, baru di belakang');
    assert.deepStrictEqual(ap([{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], '', '🩷'), { rx: [{ e: '🩷', n: 2 }, { e: '👍', n: 1 }], mine: '🩷' }, 'naik melewati yang lain');
    const inp = [{ e: '👍', n: 1 }]; t.ctx.inp = inp; t.run("pgRxApply(inp, '👍', '🩷')"); assert.deepStrictEqual(inp, [{ e: '👍', n: 1 }], 'masukan tidak diubah');
    ok('pgRxApply: dari kosong, tambah, cabut (n turun / entri hilang), ganti, urutan terbanyak dulu dan stabil, masukan utuh');
  }
  // C. tampilan
  {
    const t = boot();
    await openFeed(t, [post(1), post(2, { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '🩷' }), post(3, { priv: 'friends', rx: [{ e: '<b>', n: 1 }] })]);
    const H = t.H(), rows = H.split('class="pgpost"').slice(1);
    assert.strictEqual(rows.length, 3); assert.strictEqual((H.match(/data-pg="rxadd"/g) || []).length, 3, 'tiap postingan punya tombol tambah');
    assert(!rows[0].includes('data-pg="rx"'), 'tanpa reaksi: hanya tombol tambah');
    assert(rows[1].includes('data-e="👍"') && rows[1].includes('<b>2</b>') && rows[1].includes('aria-label="Reaksi 👍, 2 orang"'), 'chip + jumlah + label');
    assert(/class="pgrx mine"[^>]*data-e="🩷"[^>]*aria-pressed="true"/.test(rows[1]) && /class="pgrx"[^>]*data-e="👍"[^>]*aria-pressed="false"/.test(rows[1]), 'hanya reaksiku yang disorot');
    assert(rows[2].includes('data-e="&lt;b&gt;"') && !rows[2].includes('data-e="<b>"'), 'emoji di-escape di atribut');
    assert(!H.includes('pgrxpick'), 'pemilih tertutup bawaan');
    const w = boot(true); await openFeed(w, [post(2, { rx: [{ e: '👍', n: 1 }] })]); assert(w.H().includes('<i>👍</i>'), 'memakai rxShow (gambar cadangan) bila ada');
    ok('tampilan: tombol tambah di tiap postingan, chip + jumlah + label, hanya milikku disorot, emoji di-escape, pemilih tertutup, rxShow dipakai bila ada');
  }
  // D. alur
  {
    const t = boot(); await openFeed(t, [post(1, { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }] })]);
    click(t, 'rxadd', P1); assert(t.H().includes('pgrxpick') && t.H().includes('aria-expanded="true"'), 'pemilih terbuka'); assert.strictEqual((t.H().split('pgrxpick')[1].match(/data-pg="rx"/g) || []).length, 6, 'enam pilihan');
    click(t, 'rxadd', P1); assert(!t.H().includes('pgrxpick'), 'ketuk lagi menutup');
    // pasang dari pemilih; jawaban ditahan: tampilan sudah berubah (optimistik), tombol terkunci, pemilih tertutup
    click(t, 'rxadd', P1); let gate; t.st.react = new Promise((r) => { gate = r; });
    click(t, 'rx', P1, '👍'); assert.deepStrictEqual(t.rxCalls(), [['pgReact', PEER, P1, '👍']], 'pemilih -> pgReact(peer, post, e)');
    assert.deepStrictEqual(item(t, P1), { v: 1, id: P1, ts: 1700000000001, kind: 'text', text: 'isi 1', priv: 'public', rx: [{ e: '👍', n: 3 }, { e: '🩷', n: 1 }], mine: '👍' }, 'optimistik');
    assert(!t.H().includes('pgrxpick') && /class="pgrx mine"[^>]*data-e="👍"[^>]*disabled/.test(t.H()), 'pemilih tertutup, tombol terkunci selagi menunggu');
    // Core menjawab dengan angka lain (penonton lain ikut bereaksi): keadaan Core menang
    gate({ ok: true, react: { rx: [{ e: '👍', n: 5 }, { e: '🥺', n: 1 }], mine: '👍' } }); await sleep(5);
    assert.deepStrictEqual(item(t, P1).rx, [{ e: '👍', n: 5 }, { e: '🥺', n: 1 }], 'keadaan Core menggantikan perkiraan'); assert(!/disabled/.test(t.H().split('class="pgrxs"')[1].split('</div>')[0]), 'terbuka lagi'); assert.strictEqual(t.toasts.length, 0);
    // ketuk reaksiku = cabut ('' ke Core); ketuk chip lain = ganti
    t.st.react = { ok: true, react: { rx: [{ e: '🥺', n: 1 }], mine: '' } }; click(t, 'rx', P1, '👍'); await sleep(5);
    assert.deepStrictEqual(t.rxCalls()[1], ['pgReact', PEER, P1, '']); assert.deepStrictEqual([item(t, P1).rx, item(t, P1).mine], [[{ e: '🥺', n: 1 }], undefined], 'cabut: mine hilang');
    t.st.react = { ok: true, react: { rx: [{ e: '🥺', n: 2 }], mine: '🥺' } }; click(t, 'rx', P1, '🥺'); await sleep(5); assert.strictEqual(t.rxCalls()[2][3], '🥺');
    t.st.react = { ok: true, react: { rx: [{ e: '🥺', n: 1 }, { e: '😭', n: 1 }], mine: '😭' } }; click(t, 'rx', P1, '😭'); await sleep(5); assert.strictEqual(t.rxCalls()[3][3], '😭', 'ganti = kirim emoji baru (bukan cabut dulu)');
    t.st.react = { ok: true, react: { rx: [], mine: '' } }; click(t, 'rx', P1, '😭'); await sleep(5); assert.deepStrictEqual([item(t, P1).rx, item(t, P1).mine], [undefined, undefined], 'rx kosong = tanpa field'); assert.strictEqual(t.rxCalls().length, 5);
    ok('alur: pemilih -> pgReact(peer, post, e), optimistik + terkunci + pemilih tertutup, keadaan Core menggantikan perkiraan, ketuk milikku = cabut (\'\'), ketuk lain = ganti, rx kosong = tanpa field');
  }
  // E. kegagalan = keadaan lama utuh + pesan
  {
    const base = () => post(1, { rx: [{ e: '👍', n: 2 }], mine: '👍' }), bare = () => post(2);
    for (const [label, reply, msg] of [
      ['offline', { ok: false, code: 'offline', err: 'x' }, (t) => t.run('PG_ERR.offline')],
      ['old', { ok: false, code: 'old', err: 'x' }, () => 'Aplikasi pemilik belum mendukung reaksi.'],
      ['busy', { ok: false, code: 'busy', err: 'x' }, (t) => t.run('PG_ERR.busy')],
      ['kode asing', { ok: false, code: 'ZZ', err: 'pesan sendiri' }, () => 'pesan sendiri'],
      ['null (tidak ada / tak terlihat)', { ok: true, react: null }, () => 'Postingan ini sudah tidak tersedia.'],
      ['melempar', () => { throw new Error('putus'); }, (t) => t.run('PG_ERR.proto')],
    ]) {
      const t = boot(); await openFeed(t, [base(), bare()]); const before = [item(t, P1), item(t, P2)];
      t.st.react = reply; click(t, 'rx', P1, '🩷'); click(t, 'rx', P2, '🤣'); await sleep(10);
      assert.deepStrictEqual([item(t, P1), item(t, P2)], before, label + ': keadaan lama utuh (termasuk field yang tak ada)');
      assert.deepStrictEqual(t.toasts, [msg(t), msg(t)], label + ': satu pesan per percobaan'); assert(!/data-pg="rx"[^>]*disabled/.test(t.H()), label + ': terbuka lagi');
    }
    ok('kegagalan (offline, old, busy, kode asing, null, melempar): keadaan lama utuh (tanpa field baru), pesan yang tepat, tombol terbuka lagi');
  }
  // F. satu permintaan per postingan
  {
    const t = boot(); await openFeed(t, [post(1), post(2)]); let g1, g2; t.st.react = (p, id) => new Promise((r) => { if (id === P1) g1 = r; else g2 = r; });
    click(t, 'rx', P1, '👍'); click(t, 'rx', P1, '🩷'); click(t, 'rx', P1, '👍'); assert.strictEqual(t.rxCalls().length, 1, 'ketukan berikutnya pada postingan yang sama menunggu');
    click(t, 'rx', P2, '🤣'); assert.strictEqual(t.rxCalls().length, 2, 'postingan lain berjalan sendiri'); assert.strictEqual(item(t, P1).mine, '👍', 'ketukan yang diabaikan tidak mengubah apa pun');
    g1({ ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍' } }); await sleep(5); t.st.react = { ok: true, react: { rx: [{ e: '🩷', n: 1 }], mine: '🩷' } }; click(t, 'rx', P1, '🩷'); await sleep(5); assert.strictEqual(t.rxCalls().length, 3, 'sesudah selesai boleh lagi');
    g2({ ok: true, react: { rx: [{ e: '🤣', n: 1 }], mine: '🤣' } }); await sleep(5); assert.strictEqual(item(t, P2).mine, '🤣');
    { // jawaban Core disalin: mengubah objek jawaban sesudahnya tidak mengubah postingan di feed
      const t = boot(); await openFeed(t, [post(1)]); const rep = { ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍' } }; t.st.react = rep; click(t, 'rx', P1, '👍'); await sleep(5);
      rep.react.rx[0].n = 99; rep.react.rx.push({ e: '🩷', n: 1 }); assert.deepStrictEqual(item(t, P1).rx, [{ e: '👍', n: 1 }], 'postingan tidak berbagi objek dengan jawaban');
    }
    ok('satu permintaan per postingan (ketukan lain diabaikan tanpa efek), postingan lain jalan sendiri, boleh lagi sesudah selesai');
  }
  // G. jawaban basi
  {
    const t = boot(); await openFeed(t, [post(1, { rx: [{ e: '👍', n: 1 }] })]); let gate; t.st.react = new Promise((r) => { gate = r; });
    click(t, 'rx', P1, '🩷'); t.run('pgClose()'); const n = t.run('pgTok'); gate({ ok: false, code: 'offline' }); await sleep(5);
    assert.deepStrictEqual(t.toasts, [], 'layar ditutup: tidak ada pesan'); assert.strictEqual(t.run('pgF'), null, 'tidak membuka apa pun');
    const u = boot(); await openFeed(u, [post(1)]); let g; u.st.react = new Promise((r) => { g = r; }); click(u, 'rx', P1, '👍');
    u.st.list = { ok: true, items: [post(1)], next: null, count: 1, skipped: 0 }; u.run(`pgOpen('${'b'.repeat(16)}')`); await sleep(10); g({ ok: true, react: { rx: [{ e: '👍', n: 9 }], mine: '👍' } }); await sleep(5);
    assert.strictEqual(item(u, P1).rx, undefined, 'pindah ke halaman lain: jawaban lama tidak menyentuh feed baru'); assert.strictEqual(u.rxCalls().length, 1);
    ok('jawaban basi: layar ditutup / pindah peer = tidak ada pesan, tidak ada perubahan');
  }
  // H. Halamanku (4a-7): baris reaksi dari pgMine + panel "Siapa"
  const NAMES = { [ME]: 'Kamu', [PEER]: 'Budi <b>', ['b'.repeat(16)]: 'Cici', ['c'.repeat(16)]: 'Dedi' }, PEER2 = 'b'.repeat(16), PEER3 = 'c'.repeat(16);
  const mineItems = () => [post(1, { rx: [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }], mine: '👍', who: [{ e: '👍', by: [PEER, ME] }, { e: '🩷', by: [PEER2] }] }), post(2)];
  const openMine = async (t, items) => { t.ctx.nameOf = (id) => NAMES[id] || '?'; t.st.mine = { ok: true, items: items || mineItems(), next: null, count: 2, skipped: 0 }; t.run(`pgOpen('${ME}')`); await sleep(10); };
  {
    const t = boot(); await openMine(t);
    assert(t.run('pgF.mine') === true && t.H().includes('isi 1') && t.H().includes('isi 2'), 'Halamanku sungguh terbuka (bukan feed kosong)');
    assert.strictEqual((t.H().match(/data-pg="rxadd"/g) || []).length, 2, 'tombol ＋ di kedua postingan');
    assert(t.H().includes('data-pg="rx" data-id="' + P1 + '" data-e="👍"') && t.H().includes('aria-label="Reaksi 👍, 2 orang"'), 'chip dari pgMine tampil');
    assert(/class="pgrx mine"[^>]*data-e="👍"/.test(t.H()) && !/class="pgrx mine"[^>]*data-e="🩷"/.test(t.H()), 'hanya reaksiku yang disorot');
    assert.strictEqual((t.H().match(/data-pg="who"/g) || []).length, 1, '"Siapa" hanya di postingan yang punya reaksi'); assert(t.H().includes('data-pg="who" data-id="' + P1 + '"') && t.H().includes('aria-expanded="false"'));
    assert(!t.H().includes('pgwho"') && !t.H().includes('Budi'), 'panel tertutup: tidak ada nama');
    click(t, 'who', P1); let h = t.H();
    assert(h.includes('class="pgwho"') && h.includes('Budi &lt;b&gt;') && h.includes('Kamu') && h.includes('Cici'), 'panel terbuka: nama dari nameOf, di-escape'); assert(!h.includes('Budi <b>'), 'nama tidak mentah');
    assert.strictEqual((h.match(/class="pgwhorow"/g) || []).length, 2, 'satu baris per emoji'); assert(h.indexOf('Budi') < h.indexOf('Cici'), 'urutan = urutan rx'); assert(h.includes('aria-expanded="true"'));
    click(t, 'who', P1); assert(!t.H().includes('class="pgwho"'), 'ketuk lagi = tutup');
    click(t, 'who', P2); click(t, 'who', '0000000000000099'); assert(!t.H().includes('class="pgwho"') && t.run('pgF.whoOpen.size') === 0, 'who pada postingan tanpa reaksi / tak dikenal diabaikan');
    ok('Halamanku: chip + ＋ di tiap postingan, hanya milikku disorot, "Siapa" hanya bila ada reaksi, panel buka / tutup, nama di-escape, urutan sama dengan rx');
  }
  // J. pgWhoApply murni
  {
    const t = boot(), wa = (who, me, mine, next, rx) => JSON.parse(t.run(`JSON.stringify(pgWhoApply(${JSON.stringify(who)}, ${JSON.stringify(me)}, ${JSON.stringify(mine)}, ${JSON.stringify(next)}, ${JSON.stringify(rx)}))`));
    assert.deepStrictEqual(wa(undefined, ME, undefined, '👍', [{ e: '👍', n: 1 }]), [{ e: '👍', by: [ME] }], 'dari kosong');
    assert.deepStrictEqual(wa([{ e: '👍', by: [PEER] }], ME, '', '👍', [{ e: '👍', n: 2 }]), [{ e: '👍', by: [PEER, ME] }], 'pelaku baru di ujung');
    assert.deepStrictEqual(wa([{ e: '👍', by: [PEER, ME] }], ME, '👍', '', [{ e: '👍', n: 1 }]), [{ e: '👍', by: [PEER] }], 'cabut: hanya aku yang hilang');
    assert.deepStrictEqual(wa([{ e: '👍', by: [ME] }], ME, '👍', '', []), [], 'cabut yang terakhir: entri hilang');
    assert.deepStrictEqual(wa([{ e: '👍', by: [PEER] }, { e: '🩷', by: [PEER2, ME] }], ME, '🩷', '👍', [{ e: '👍', n: 2 }, { e: '🩷', n: 1 }]), [{ e: '👍', by: [PEER, ME] }, { e: '🩷', by: [PEER2] }], 'ganti: pindah emoji, urutan mengikuti rx');
    assert.deepStrictEqual(wa([{ e: '👍', by: [PEER] }], ME, '👍', '', [{ e: '👍', n: 1 }]), [{ e: '👍', by: [PEER] }], 'id lain tidak ikut terhapus walau emojinya sama dengan mine');
    assert.deepStrictEqual(wa([{ e: '👍', by: [PEER, ME] }], ME, '', '👍', [{ e: '👍', n: 2 }]), [{ e: '👍', by: [PEER, ME] }], 'tidak ganda');
    assert.deepStrictEqual(wa([{ e: '🩷', by: [PEER] }], ME, '', '👍', [{ e: '🩷', n: 1 }, { e: '👍', n: 1 }]), [{ e: '🩷', by: [PEER] }, { e: '👍', by: [ME] }], 'emoji baru di ujung');
    assert.deepStrictEqual(wa('x', ME, '', '👍', [{ e: '👍', n: 1 }]), [{ e: '👍', by: [ME] }], 'who bukan larik = kosong'); assert.deepStrictEqual(wa([null, { e: '👍' }, { e: '👍', by: 'x' }], ME, '', '👍', [{ e: '👍', n: 1 }]).length, 1);
    const inp = [{ e: '👍', by: [PEER, ME] }]; t.ctx.inp = inp; t.run("pgWhoApply(inp, '" + ME + "', '👍', '🩷', [{ e: '🩷', n: 1 }])"); assert.deepStrictEqual(inp, [{ e: '👍', by: [PEER, ME] }], 'masukan tidak diubah');
    ok('pgWhoApply: dari kosong, pelaku baru di ujung, cabut hanya aku, ganti mengikuti urutan rx, tanpa ganda, id lain aman, masukan cacat / tak diubah');
  }
  // K. pemilik bereaksi di Halamanku
  {
    const t = boot(); await openMine(t); const orig = item(t, P1); let rel; const hold = () => { t.st.react = () => new Promise((r) => { rel = r; }); };
    hold(); click(t, 'rxadd', P1); assert(t.H().includes('pgrxpick'), 'pemilih terbuka di Halamanku'); assert.strictEqual(t.run('pgF.rxOpen'), P1); click(t, 'rx', P1, '🩷'); await sleep(1); assert(!t.H().includes('pgrxpick'), 'pemilih tertutup sesudah memilih');
    assert.deepStrictEqual(t.rxCalls().map((c) => c.slice(1)), [[ME, P1, '🩷']], 'peer = id sendiri (reaksi lokal)');
    let it = item(t, P1); assert.deepStrictEqual(it.rx, [{ e: '🩷', n: 2 }, { e: '👍', n: 1 }], 'optimistik rx'); assert.strictEqual(it.mine, '🩷');
    assert.deepStrictEqual(it.who, [{ e: '🩷', by: [PEER2, ME] }, { e: '👍', by: [PEER] }], 'optimistik who: aku pindah emoji, urutan mengikuti rx');
    assert(/data-pg="rx"[^>]*disabled/.test(t.H()), 'terkunci selagi menunggu');
    rel({ ok: true, react: { rx: [{ e: '🩷', n: 3 }, { e: '👍', n: 1 }], mine: '🩷', who: [{ e: '🩷', by: [PEER2, PEER3, ME] }, { e: '👍', by: [PEER] }] } }); await sleep(5);
    it = item(t, P1); assert.deepStrictEqual(it.rx, [{ e: '🩷', n: 3 }, { e: '👍', n: 1 }], 'keadaan Core menggantikan perkiraan'); assert.deepStrictEqual(it.who, [{ e: '🩷', by: [PEER2, PEER3, ME] }, { e: '👍', by: [PEER] }], 'who dari Core menggantikan');
    click(t, 'who', P1); assert(t.H().includes('Dedi') && t.H().includes('Cici'), 'peserta baru dari Core tampil di panel');
    assert(!/data-pg="rx"[^>]*disabled/.test(t.H()), 'terbuka lagi');
    // cabut reaksiku sendiri
    t.st.react = { ok: true, react: { rx: [{ e: '🩷', n: 2 }, { e: '👍', n: 1 }], mine: '', who: [{ e: '🩷', by: [PEER2, PEER3] }, { e: '👍', by: [PEER] }] } }; click(t, 'rx', P1, '🩷'); await sleep(5);
    assert.strictEqual(t.rxCalls().slice(-1)[0][3], '', "ketuk reaksiku = cabut ('')"); it = item(t, P1); assert(!('mine' in it) && !JSON.stringify(it.who).includes(ME), 'aku hilang dari who');
    // gagal: seluruh keadaan lama (termasuk who) kembali
    const t2 = boot(); await openMine(t2); t2.st.react = { ok: false, code: 'proto' }; click(t2, 'rxadd', P1); click(t2, 'rx', P1, '😭'); await sleep(5);
    assert.deepStrictEqual(item(t2, P1), orig, 'gagal: rx, mine, who pulih utuh'); assert.strictEqual(t2.toasts.length, 1);
    t2.st.react = { ok: true, react: null }; click(t2, 'rx', P1, '😭'); await sleep(5); assert.deepStrictEqual(item(t2, P1), orig, 'null: pulih'); assert.deepStrictEqual(t2.toasts.slice(-1), ['Postingan ini sudah tidak tersedia.']);
    t2.st.react = () => { throw new Error('x'); }; click(t2, 'rx', P1, '😭'); await sleep(5); assert.deepStrictEqual(item(t2, P1), orig, 'melempar: pulih');
    // postingan tanpa reaksi: reaksi pertama pemilik, lalu gagal = tanpa field baru
    t2.st.react = { ok: false, code: 'busy' }; click(t2, 'rx', P2, '👍'); await sleep(5); assert.deepStrictEqual(item(t2, P2), post(2), 'gagal pada postingan tanpa reaksi: tanpa field rx / mine / who');
    t2.st.react = { ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍', who: [{ e: '👍', by: [ME] }] } }; click(t2, 'rx', P2, '👍'); await sleep(5);
    assert.deepStrictEqual(item(t2, P2).who, [{ e: '👍', by: [ME] }]); assert(t2.H().includes('data-pg="who" data-id="' + P2 + '"'), '"Siapa" muncul sesudah reaksi pertama');
    // balasan Core tanpa who (tidak seharusnya): daftar dibuang, bukan dibiarkan basi
    t2.st.react = { ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍' } }; click(t2, 'rx', P1, '👍'); await sleep(5); assert(!('who' in item(t2, P1)) && !t2.H().includes('data-pg="who" data-id="' + P1 + '"'), 'tanpa who dari Core = daftar dibuang, tombol hilang');
    // cabut reaksi terakhir: tanpa rx, tanpa mine, tanpa who sisa (objek kembali seperti postingan tanpa reaksi)
    const t3 = boot(); await openMine(t3, [post(1, { rx: [{ e: '👍', n: 1 }], mine: '👍', who: [{ e: '👍', by: [ME] }] })]); t3.st.react = { ok: true, react: { rx: [], mine: '', who: [] } }; click(t3, 'rx', P1, '👍'); await sleep(5);
    assert.deepStrictEqual(item(t3, P1), post(1), 'reaksi terakhir dicabut: tanpa field rx / mine / who'); assert(!t3.H().includes('data-pg="who"'), 'tombol Siapa hilang');
    // balasan Core dengan entri who cacat: tidak melempar, kunci terlepas, entri cacat dibuang
    t3.st.react = { ok: true, react: { rx: [{ e: '👍', n: 1 }], mine: '👍', who: [null, 5, { e: 7 }, { e: '👍', by: [ME] }] } }; click(t3, 'rx', P1, '👍'); await sleep(5);
    assert.deepStrictEqual(item(t3, P1).who, [{ e: '👍', by: [ME] }], 'entri cacat dibuang'); assert(!/data-pg="rx"[^>]*disabled/.test(t3.H()) && !t3.run('pgF.rxb["' + P1 + '"]'), 'kunci terlepas walau who cacat');
    // entri who cacat di data awal juga tidak merusak optimistik: kunci tidak macet
    const t4 = boot(); await openMine(t4, [post(1, { rx: [{ e: '👍', n: 1 }], mine: '👍', who: [null, { e: '👍', by: [ME] }] })]); t4.st.react = { ok: false, code: 'busy' }; click(t4, 'rx', P1, '🩷'); await sleep(5);
    assert(!t4.run('pgF.rxb["' + P1 + '"]') && t4.toasts.length === 1, 'gagal dengan who cacat: kunci terlepas, satu pesan');
    ok('Halamanku: reaksi lokal (peer = id sendiri), optimistik rx + who, who Core menggantikan, cabut, gagal / null / melempar = rx, mine, who pulih utuh, reaksi pertama pada postingan kosong, balasan tanpa who tidak meninggalkan daftar basi');
  }
  // L. daftar pelaku tidak bocor ke feed orang lain
  {
    const t = boot(); t.ctx.nameOf = (id) => NAMES[id] || '?';
    await openFeed(t, [post(1, { rx: [{ e: '👍', n: 1 }], mine: '👍', who: [{ e: '👍', by: [PEER2] }] })]);
    assert(t.run('pgF.mine') === false && !t.H().includes('data-pg="who"') && !t.H().includes('pgwho') && !t.H().includes('Cici'), 'feed orang lain: tanpa tombol Siapa dan tanpa nama walau who ada di data');
    click(t, 'who', P1); assert(!t.H().includes('pgwho') && !t.run('pgF.whoOpen'), 'klik who diabaikan');
    t.st.react = { ok: true, react: { rx: [{ e: '👍', n: 2 }], mine: '👍', who: [{ e: '👍', by: [PEER2, PEER3] }] } }; click(t, 'rx', P1, '😭'); await sleep(5);
    t.st.react = { ok: true, react: { rx: [{ e: '😭', n: 1 }], mine: '😭', who: [{ e: '😭', by: [PEER3] }] } }; click(t, 'rx', P1, '😭'); await sleep(5);
    assert(!('who' in item(t, P1)) && !t.H().includes('Dedi'), 'balasan reaksi di feed orang lain: who tidak disimpan');
    // isi who yang cacat di Halamanku: id bukan 16 heks tidak ditampilkan, banyak pelaku dipotong, rx kosong = panel hilang
    const many = Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(16, '0'));
    const t2 = boot(); await openMine(t2, [post(1, { rx: [{ e: '👍', n: 27 }], who: [{ e: '👍', by: ['<img src=x>', PEER, ...many.slice(0, 24)] }] }), post(2, { who: [{ e: '👍', by: [PEER] }] })]);
    click(t2, 'who', P1); const h = t2.H(); assert(!h.includes('<img') && !h.includes('&lt;img'), 'id bukan heks dibuang'); assert(h.includes('dan 5 lainnya'), 'lebih dari 20 nama dipotong: ' + (h.match(/dan \d+ lainnya/) || [])[0]); assert((h.match(/Budi/g) || []).length === 1);
    assert(!t2.H().includes('data-pg="who" data-id="' + P2 + '"'), 'who basi tanpa rx: tidak ada tombol');
    const t5 = boot(); await openMine(t5, [post(1, { rx: [{ e: '👍', n: 1 }, { e: '🩷', n: 1 }], who: [{ e: '👍', by: [PEER] }, { e: '🩷', by: [] }, { e: '😭' }, null] })]); click(t5, 'who', P1);
    assert.strictEqual((t5.H().match(/class="pgwhorow"/g) || []).length, 1, 'baris tanpa pelaku / cacat tidak ditampilkan');
    ok('daftar pelaku: tidak tampil / tidak tersimpan di feed orang lain, klik who diabaikan; di Halamanku id cacat dibuang, lebih dari 20 dipotong, who tanpa rx tidak punya tombol');
  }
  // I. masukan cacat
  {
    const t = boot(); await openFeed(t, [post(1)]);
    for (const [id, e] of [[P1, ''], [P1, 5], [P1, null], [P1, undefined], ['0000000000000099', '👍'], [undefined, '👍']]) { t.ctx.a1 = id; t.ctx.a2 = e; await t.run('pgRx(a1, a2)'); }
    click(t, 'rx', P1, undefined); click(t, 'rx', undefined, '👍'); await sleep(5);
    assert.strictEqual(t.rxCalls().length, 0, 'tidak ada panggilan'); assert.deepStrictEqual(item(t, P1), post(1), 'postingan utuh'); assert.deepStrictEqual(t.toasts, []);
    t.run('pgClose()'); await t.run(`pgRx('${P1}', '👍')`); await t.run(`pgRxMenu('${P1}')`); assert.strictEqual(t.rxCalls().length, 0, 'layar tertutup: diabaikan');
    ok('masukan cacat (e kosong / bukan string, id tak dikenal / tak ada, layar tertutup): diabaikan tanpa panggilan dan tanpa pesan');
  }
  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
