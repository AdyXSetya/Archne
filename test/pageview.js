'use strict';
// Tes 2d-5: gambar penuh di feed Halaman. renderer/js/archne-pages.js (sel + klik) dan archne-imgview.js (mode Halaman) dimuat BERSAMA di satu vm, seperti di aplikasi,
// dengan DOM tiruan; plUrl4 diambil dari archne-player.js yang asli supaya bentuk URL ikut teruji.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
let pass = 0; const ok = (n) => { pass++; console.log('  OK  ' + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = '1'.repeat(16), PEER = 'a'.repeat(16), PID = '0000000000000005', MID = 'bbbbbbbbbbbbbbbb', MID2 = 'cccccccccccccccc', TOK = 'd'.repeat(32);
const post = (n, media) => ({ v: 1, id: n.toString(16).padStart(16, '0'), ts: 1700000000000 + n, kind: 'text', text: 'isi ' + n, priv: 'public', media });
const med = (id, o) => Object.assign({ id, mime: 'image/png', size: 10, name: 'foto.png', th: 'QUJD' }, o || {});

function boot() {
  const els = {}, kds = [], calls = [], toasts = [], hist = { pushes: 0, backs: 0, pushState() { this.pushes++; }, back() { this.backs++; } };
  const st = { list: null, img: null, opened: [] };
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 800, src: undefined, h: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, f) { this.h[t] = f; }, removeAttribute(a) { if (a === 'src') this.src = undefined; }, setPointerCapture() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } });
  const api = {
    pgList: async (...a) => { calls.push(['pgList', ...a]); return st.list; },
    pgImage: async (...a) => { calls.push(['pgImage', ...a]); const r = st.img; return typeof r === 'function' ? r(...a) : r; },
    mediaRead: async (id) => { calls.push(['mediaRead', id]); return { ok: true, mime: 'image/png', b64: 'QQ==' }; },
    openFile: async (id) => { calls.push(['openFile', id]); return { ok: true }; },
    pgFileGet: async (...a) => { calls.push(['pgFileGet', ...a]); const r = st.fget; return typeof r === 'function' ? r(...a) : r; },
    pgFileCancel: async (...a) => { calls.push(['pgFileCancel', ...a]); const r = st.fcancel; return typeof r === 'function' ? r(...a) : r; },
    onPgDl: (cb) => { st.dl = cb; st.dlWired = (st.dlWired || 0) + 1; },
  };
  const win = { api, history: hist, location: { protocol: 'file:', pathname: '/archne-index.html' } };
  const E = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { S: { me: { id: ME }, messages: [] }, esc: E, nameOf: () => 'N', $: el, linkHtml: E, fmt: String, dayLabel: () => 'Hari ini', hm: () => '10:00', toast: (t) => toasts.push(t), ask: async () => true,
    renderProfile() {}, document: { addEventListener(t, f) { if (t === 'keydown') kds.push(f); } }, Date, Promise, setTimeout, Set, window: win, profId: PEER };
  vm.createContext(ctx);
  vm.runInContext(rd('renderer/archne-filecard.js'), ctx); // FileCard global, seperti di archne-index.html (dimuat sebelum archne-pages.js)
  vm.runInContext(require('./_src').pagesJs(), ctx);
  vm.runInContext(rd('renderer/js/archne-imgview.js'), ctx);
  const pl = /function plUrl4\(tok\) \{[\s\S]*?\n\}/.exec(rd('renderer/js/archne-player.js')); assert(pl, 'plUrl4 ada di archne-player.js');
  vm.runInContext(pl[0], ctx);
  el('ivs').clientHeight = 600; // layar penampil 800x600
  const run = (c) => vm.runInContext(c, ctx);
  return { kds, els, calls, toasts, st, win, hist, run, ctx, el, calls2: () => calls.filter((c) => c[0] === 'pgImage') };
}
async function openFeed(t, posts) {
  t.st.list = { ok: true, items: posts, next: null, count: posts.length, skipped: 0 };
  t.run(`pgOpen('${PEER}')`); await sleep(10);
}
const clickView = (t, pid, mid) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'view', pid, mid } }) } });

(async () => {
  // A. statis
  {
    const html = rd('renderer/archne-index.html'), css = rd('renderer/css/archne-pages.css');
    assert(/img-src data: archne-media: 'self';/.test(html) && !/img-src[^;]*(blob:|https?:|file:|\*)/.test(html), 'img-src: hanya data:, archne-media:, self');
    assert(/default-src 'self';/.test(html) && /media-src blob: 'self' archne-media:;/.test(html), 'bagian CSP lain tidak berubah');
    assert(html.includes('id="ivretry"') && html.includes('id="ivopen"'), 'tombol coba lagi ada');
    assert(html.indexOf('js/archne-pages.js') < html.indexOf('js/archne-imgview.js') && html.indexOf('js/archne-imgview.js') < html.indexOf('js/archne-player.js'), 'urutan skrip: PG_ERR (32) sebelum penampil (62)');
    assert(css.includes('.pgview') && css.includes('.pgview:focus-visible'), 'CSS sel gambar + fokus papan ketik');
    assert(/pgImage: \(peerId, postId, mediaId\)/.test(rd('preload.js')) && rd('renderer/archne-api-http.js').includes("'pgImage'"), 'kontrak pgImage ada');
    ok('statis: CSP img-src hanya data:/archne-media:/self, bagian lain utuh, tombol coba lagi, urutan skrip, CSS, kontrak');
  }

  // B. feed: sel jadi tombol, klik membuka penampil dengan data dari feed
  {
    const t = boot();
    await openFeed(t, [post(5, [med(MID, { name: 'a<b>.png' }), med(MID2, { th: undefined }), med('xyz', {}), med(MID, { id: '../x' })]), post(6)]);
    const h = t.els.pglist.innerHTML;
    assert.strictEqual((h.match(/data-pg="view"/g) || []).length, 2, 'hanya gambar ber-id 16 heks yang jadi tombol (2 dari 4)');
    assert(h.includes(`data-pid="${PID}" data-mid="${MID}"`) && h.includes(`data-mid="${MID2}"`), 'atribut id');
    assert(h.includes('aria-label="Buka gambar: a&lt;b&gt;.png"') && !h.includes('<b>'), 'nama di-escape');
    assert(h.includes('pgimgph') && h.includes('class="pgth"'), 'thumbnail dan placeholder tetap tampil di dalam tombol');
    assert(!h.includes('data-mid="xyz"') && !h.includes('../x'), 'id cacat tidak jadi atribut');
    // klik: openImgPage(peer pemilik halaman, id postingan, id gambar, nama dari feed)
    t.st.img = new Promise(() => {}); // tertahan: cukup lihat pemanggilannya
    clickView(t, PID, MID); await sleep(5);
    assert.deepStrictEqual(t.calls2(), [['pgImage', PEER, PID, MID]], 'pgImage dipanggil dengan id pemilik, postingan, gambar');
    assert.strictEqual(t.els.ivt.textContent, 'a<b>.png (1/2)', 'judul penampil = nama dari feed + posisi (textContent, bukan HTML); hanya 2 gambar ber-id sah dihitung');
    // atribut palsu: gambar yang tidak ada di feed tidak pernah diminta
    t.run('closeImg(); imgvPop()'); t.calls.length = 0;
    for (const [p, m] of [[PID, 'eeeeeeeeeeeeeeee'], ['9999999999999999', MID], [undefined, undefined], ['', MID], [PID, '__proto__']]) clickView(t, p, m);
    await sleep(5); assert.strictEqual(t.calls2().length, 0, 'klik dengan id yang tidak ada di feed diabaikan');
    ok('feed: hanya sel ber-id sah jadi tombol, nama di-escape, klik memakai entri feed, atribut palsu diabaikan');

    // halaman milik sendiri: id = id sendiri
    const m = boot(); m.run(`pgOpen('${ME}')`); await sleep(5);
    m.st.list = { ok: true, items: [post(5, [med(MID)])], next: null, count: 1, skipped: 0 }; m.run('pgF.items.push(' + JSON.stringify(post(5, [med(MID)])) + ')'); m.run('renderFeed()');
    m.st.img = new Promise(() => {}); clickView(m, PID, MID); await sleep(5);
    assert.deepStrictEqual(m.calls2(), [['pgImage', ME, PID, MID]], 'Halamanku: gambar milik sendiri juga bisa dibuka');
    // shell tanpa penampil: pesan, bukan galat
    const n = boot(); await openFeed(n, [post(5, [med(MID)])]); n.run('openImgPage = undefined'); clickView(n, PID, MID); await sleep(5);
    assert(n.toasts.length === 1 && /belum bisa/.test(n.toasts[0]) && n.calls2().length === 0, 'tanpa penampil: toast');
    ok('feed: Halamanku memakai id sendiri; shell lama tanpa penampil/pgImage = pesan');
  }

  // C. penampil mode Halaman
  const open = async (t, ans) => { t.st.img = ans; t.run(`openImgPage('${PEER}','${PID}','${MID}','foto.png')`); await sleep(5); };
  const good = { ok: true, image: { tok: TOK, mime: 'image/png', total: 5 } };
  {
    let t = boot(); await open(t, good); const E = t.els;
    assert(E.imgv.classList.contains('on') && E.ivt.textContent === 'foto.png' && E.ivopen.style.display === 'none' && E.ivretry.style.display === 'none', 'terbuka, "buka dengan aplikasi lain" disembunyikan');
    assert.strictEqual(E.ivimg.src, 'archne-media://m/' + TOK, 'desktop: URL penyaji dari token'); assert.strictEqual(t.hist.pushes, 1, 'satu entri riwayat');
    E.ivimg.naturalWidth = 1600; E.ivimg.naturalHeight = 1200; E.ivimg.onload();
    assert(E.ivimg.style.visibility === 'visible' && E.ivzl.textContent === '50%' && E.ivmsg.textContent === '', 'pas layar setelah termuat');
    E.ivopen.onclick(); await sleep(2); assert(!t.calls.some((c) => c[0] === 'openFile'), 'mode Halaman: tidak ada buka berkas');
    t.win.location = { protocol: 'http:', pathname: '/s/ab12cd/index.html' }; await open(t, good); assert.strictEqual(t.els.ivimg.src, '/s/ab12cd/media/' + TOK, 'Android: di bawah awalan sesi');
    t.win.location = { protocol: 'http:', pathname: '/' }; await open(t, good); assert.strictEqual(t.els.ivimg.src, '/media/' + TOK, 'peramban: akar');
    ok('penampil Halaman: URL penyaji (desktop/Android/peramban), pas layar, tanpa tombol buka-berkas, satu entri riwayat');
  }
  {
    const t = boot(); const E = t.els, PG = (c) => t.run(`PG_ERR.${c}`);
    const cases = [[{ ok: false, code: 'offline', err: 'x' }, PG('offline'), true], [{ ok: false, code: 'old' }, PG('old'), false], [{ ok: false, code: 'blocked' }, PG('blocked'), false], [{ ok: false, code: 'busy' }, PG('busy'), true],
      [{ ok: false, code: 'proto' }, PG('proto'), true], [{ ok: false, code: 'aneh', err: 'Pesan dari inti' }, 'Pesan dari inti', true], [{ ok: false }, 'Gambar tidak bisa dimuat.', true],
      [{ ok: true, image: null }, 'Gambar tidak tersedia. Mungkin sudah dihapus atau tidak untukmu.', false]];
    for (const [ans, msg, retry] of cases) { await open(t, ans); assert.strictEqual(E.ivmsg.textContent, msg, JSON.stringify(ans)); assert.strictEqual(E.ivretry.style.display, retry ? '' : 'none', 'coba lagi: ' + JSON.stringify(ans)); assert.strictEqual(E.ivimg.src, undefined, 'tidak ada gambar'); }
    await open(t, () => { throw new Error('IPC putus'); }); assert.strictEqual(E.ivmsg.textContent, PG('proto')); assert.strictEqual(E.ivretry.style.display, '');
    // pemilik/jalur jahat: token atau mime tidak sah tidak pernah menjadi src
    for (const g of [{ tok: '../../x', mime: 'image/png' }, { tok: TOK.toUpperCase(), mime: 'image/png' }, { tok: 'a'.repeat(31), mime: 'image/png' }, { tok: TOK, mime: 'text/html' }, { tok: TOK, mime: 'image/svg+xml' }, { tok: TOK }, 'str', 5]) {
      await open(t, { ok: true, image: g }); assert.strictEqual(E.ivimg.src, undefined, 'bukan src: ' + JSON.stringify(g)); assert.strictEqual(E.ivmsg.textContent, PG('proto')); assert.strictEqual(E.ivretry.style.display, 'none');
    }
    await open(t, undefined); assert.strictEqual(E.ivimg.src, undefined, 'jawaban kosong aman');
    ok('penampil Halaman: tiap kode galat punya pesan dan tombol coba lagi yang tepat (offline/busy/proto bisa diulang; old/blocked/hilang tidak); token/mime tak sah ditolak');
  }
  {
    const t = boot(); const E = t.els; let n = 0;
    await open(t, () => (++n === 1 ? good : { ok: true, image: { tok: 'e'.repeat(32), mime: 'image/jpeg', total: 9 } }));
    E.ivimg.onerror(); // putus di tengah aliran
    assert(/terputus.*offline.*Coba lagi/.test(E.ivmsg.textContent) && E.ivretry.style.display === '' && E.ivimg.style.visibility === 'hidden', 'terputus: pesan + coba lagi');
    E.ivretry.onclick(); await sleep(5);
    assert.strictEqual(t.calls2().length, 2); assert.deepStrictEqual(t.calls2()[1], ['pgImage', PEER, PID, MID], 'coba lagi = token baru untuk gambar yang sama'); assert.strictEqual(E.ivimg.src, 'archne-media://m/' + 'e'.repeat(32));
    assert.strictEqual(E.ivretry.style.display, 'none', 'tombol hilang saat memuat ulang'); assert.strictEqual(t.hist.pushes, 1, 'coba lagi tidak menambah entri riwayat');
    ok('penampil Halaman: putus di tengah aliran -> pesan + coba lagi, mengulang dengan token baru tanpa menumpuk riwayat');
  }
  {
    // balapan: ditutup / diganti selagi menunggu pemilik
    const t = boot(); const E = t.els; let rel; await open(t, new Promise((r) => { rel = r; }));
    t.run('closeImg()'); t.run('imgvPop()'); rel(good); await sleep(5); assert.strictEqual(E.ivimg.src, undefined, 'ditutup selagi menunggu: jawaban terlambat tidak dipasang'); assert(!E.imgv.classList.contains('on'));
    let relA; t.st.img = new Promise((r) => { relA = r; }); t.run(`openImgPage('${PEER}','${PID}','${MID}','A')`);
    t.st.img = { ok: true, image: { tok: 'f'.repeat(32), mime: 'image/webp', total: 1 } }; t.run(`openImgPage('${PEER}','${PID}','${MID2}','B')`); await sleep(5);
    relA(good); await sleep(5); assert.strictEqual(E.ivimg.src, 'archne-media://m/' + 'f'.repeat(32), 'diganti selagi menunggu: yang lama tidak menimpa'); assert.strictEqual(E.ivt.textContent, 'B');
    ok('penampil Halaman: ditutup atau diganti selagi menunggu pemilik tidak memasang jawaban yang basi');
  }
  {
    // kembali ke mode chat: tombol buka-berkas pulih, coba lagi hilang, state Halaman dilepas
    const t = boot(); const E = t.els; await open(t, { ok: false, code: 'offline' }); assert.strictEqual(E.ivretry.style.display, '');
    t.run('closeImg()'); assert.strictEqual(t.hist.backs, 1, 'Tutup memakai history.back'); t.run('imgvPop()');
    assert(!E.imgv.classList.contains('on') && E.ivopen.style.display === '' && E.ivretry.style.display === 'none' && t.run('imgvOpen()') === false && t.run('ivPg') === null, 'ditutup: keadaan bersih');
    await open(t, good); t.run(`openImg('${'ab'.repeat(16)}')`); await sleep(5);
    assert(E.ivopen.style.display === '' && E.ivretry.style.display === 'none' && t.run('ivPg') === null && E.ivimg.src.startsWith('data:image/png'), 'openImg (chat) setelah mode Halaman: normal lagi');
    E.ivopen.onclick(); await sleep(2); assert(t.calls.some((c) => c[0] === 'openFile' && c[1] === 'ab'.repeat(16)), 'mode chat: buka berkas berfungsi');
    ok('penampil: menutup membersihkan mode Halaman; mode chat setelahnya normal (data URL, buka berkas)');
  }
  {
    // D. bergeser antar gambar satu postingan
    const t = boot(); const E = t.els, M3 = 'dddddddddddddddd', key = (k) => { let pd = 0; for (const f of t.kds) f({ key: k, preventDefault() { pd++; }, stopPropagation() {} }); return pd; };
    await openFeed(t, [post(5, [med(MID, { name: 'satu.png' }), med(MID2, { name: 'dua.png' }), med(M3, { name: 'tiga.png' })]), post(6, [med('eeeeeeeeeeeeeeee')])]);
    const toks = { [MID]: 'a1'.repeat(16), [MID2]: 'a2'.repeat(16), [M3]: 'a3'.repeat(16) };
    t.st.img = (peer, pid, mid) => ({ ok: true, image: { tok: toks[mid], mime: 'image/png', total: 5 } });
    clickView(t, PID, MID2); await sleep(5); // buka yang tengah
    assert.strictEqual(E.ivt.textContent, 'dua.png (2/3)'); assert(E.ivprev.style.display === '' && E.ivnext.style.display === '' && !E.ivprev.disabled && !E.ivnext.disabled, 'kedua tombol aktif di tengah');
    E.ivnext.onclick(); await sleep(5);
    assert.deepStrictEqual(t.calls2().map((c) => c[3]), [MID2, M3], 'berikutnya = gambar ke-3 (token baru)'); assert.strictEqual(E.ivimg.src, 'archne-media://m/' + toks[M3]); assert.strictEqual(E.ivt.textContent, 'tiga.png (3/3)');
    assert(!E.ivnext.disabled && !E.ivprev.disabled, 'di ujung: berikutnya tetap aktif (navigasi berputar)'); E.ivnext.onclick(); await sleep(5); assert.strictEqual(E.ivt.textContent, 'satu.png (1/3)', 'lewat ujung: berputar ke gambar pertama'); assert.strictEqual(t.calls2().length, 3, 'berputar meminta token baru');
    assert.strictEqual(key('ArrowLeft'), 1); await sleep(5); assert.strictEqual(E.ivt.textContent, 'tiga.png (3/3)', 'panah kiri dari yang pertama: berputar ke terakhir'); assert.strictEqual(key('ArrowLeft'), 1); await sleep(5); assert.strictEqual(E.ivt.textContent, 'dua.png (2/3)', 'panah kiri'); assert.strictEqual(key('ArrowLeft'), 1); await sleep(5); assert.strictEqual(E.ivt.textContent, 'satu.png (1/3)');
    assert(!E.ivprev.disabled, 'di awal: sebelumnya tetap aktif (navigasi berputar)');
    key('ArrowRight'); await sleep(5); assert.strictEqual(E.ivt.textContent, 'dua.png (2/3)', 'panah kanan');
    assert.strictEqual(t.hist.pushes, 1, 'berpindah tidak menumpuk riwayat'); assert.strictEqual(t.run('ivPg.mediaId'), MID2);
    // gagal di tengah: coba lagi tetap di gambar yang sama dan tetap bisa berpindah
    t.st.img = { ok: false, code: 'offline' }; E.ivnext.onclick(); await sleep(5); assert.strictEqual(E.ivmsg.textContent, t.run('PG_ERR.offline')); assert(E.ivprev.style.display === '' && E.ivnext.style.display === '', 'tombol pindah tetap ada saat galat');
    t.st.img = (peer, pid, mid) => ({ ok: true, image: { tok: toks[mid], mime: 'image/png', total: 5 } }); E.ivretry.onclick(); await sleep(5); assert.strictEqual(E.ivt.textContent, 'tiga.png (3/3)', 'coba lagi memuat gambar yang gagal, daftar tetap');
    // tutup: tombol hilang, panah tidak berbuat apa-apa
    t.run('closeImg(); imgvPop()'); assert(E.ivprev.style.display === 'none' && E.ivnext.style.display === 'none'); const k = t.calls2().length; key('ArrowRight'); await sleep(5); assert.strictEqual(t.calls2().length, k, 'tertutup: panah diam');
    // satu gambar: tidak ada tombol pindah, judul tanpa (1/1)
    clickView(t, '0000000000000006', 'eeeeeeeeeeeeeeee'); await sleep(5); assert(E.ivprev.style.display === 'none' && E.ivnext.style.display === 'none' && E.ivt.textContent === 'foto.png', 'satu gambar: tanpa navigasi'); key('ArrowRight'); await sleep(5); assert.strictEqual(t.calls2().length, k + 1);
    // mode chat setelah mode Halaman: tidak ada tombol pindah
    t.run('closeImg(); imgvPop()'); clickView(t, PID, MID); await sleep(5); t.run(`openImg('${'ab'.repeat(16)}')`); await sleep(5); assert(E.ivprev.style.display === 'none' && E.ivnext.style.display === 'none', 'openImg (chat): tanpa navigasi');
    ok('penampil Halaman: sebelumnya/berikutnya + panah di antara gambar satu postingan, tertahan di ujung, tanpa menumpuk riwayat, bertahan saat galat/coba lagi, hilang saat tertutup/satu gambar/mode chat');
  }
  // E. 3a-7: lampiran di feed penonton
  {
    const F1 = '1111111111111111', F2 = '2222222222222222', F3 = '3333333333333333', ID1 = 'aaaaaaaaaaaaaaaa', ID2 = 'bbbbbbbbbbbbbbbb', P5 = PID, P6 = '0000000000000006';
    const files5 = [{ id: F1, name: 'laporan <b>.pdf', size: 1048576 }, { id: F2, name: 'setup.exe', size: 2048 }, { id: 'xyz', name: 'cacat', size: 5 }, { id: F3, name: 'nol', size: 0 }];
    const tag = (o) => Object.assign({ id: ID1, peerId: PEER, postId: P5, fileId: F1 }, o);
    const clickF = (t, a, pid, fid) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: a, pid, fid } }) } });
    const boot2 = async () => { const t = boot(); await openFeed(t, [Object.assign(post(5), { files: files5 }), post(6)]); return t; };
    // 1. kartu: nama di-escape, ukuran, tombol Unduh; entri cacat (id bukan heks / ukuran 0) tidak tampil; peringatan berkas berisiko; postingan tanpa lampiran tanpa wadah
    {
      const t = await boot2(), h = t.els.pglist.innerHTML;
      assert.strictEqual(t.st.dlWired, 1, 'pendengar pgdl dipasang sekali saat layar dibuka');
      assert(h.includes('laporan &lt;b&gt;.pdf') && !h.includes('<b>.pdf') && h.includes('1,0 MB') && h.includes('2,0 KB'), 'nama di-escape, ukuran');
      assert.strictEqual((h.match(/data-pg="fget"/g) || []).length, 2, 'dua kartu sah, masing-masing satu tombol Unduh'); assert(!h.includes('cacat') && !h.includes('>nol<'));
      assert((h.match(/bisa dijalankan/g) || []).length === 1 && h.indexOf('setup.exe') < h.indexOf('bisa dijalankan'), 'peringatan hanya untuk .exe');
      assert.strictEqual((h.match(/class="pgfiles"/g) || []).length, 1, 'postingan tanpa lampiran tanpa wadah');
      assert(h.includes(`data-pid="${P5}"`) && h.includes(`data-fid="${F1}"`));
      await openFeed(t, [Object.assign(post(5), { files: files5 })]); assert.strictEqual(t.st.dlWired, 1, 'dibuka lagi: tidak dipasang dobel');
      // postingan jahat: bukan larik / id postingan cacat
      for (const bad of ['x', 5, {}, [null, 5, 'a']]) { await openFeed(t, [Object.assign(post(5), { files: bad })]); assert(!t.els.pglist.innerHTML.includes('pgfiles'), 'files cacat: ' + JSON.stringify(bad)); }
      await openFeed(t, [Object.assign(post(5), { id: '../x', files: files5 })]); assert(!t.els.pglist.innerHTML.includes('pgfiles'), 'id postingan cacat: tanpa kartu');
      ok('lampiran: kartu per berkas (nama di-escape, ukuran, Unduh), entri cacat dibuang, peringatan berkas berisiko, pendengar pgdl sekali');
    }
    // 2. unduh sampai selesai: argumen dari feed, progres di tempat (tanpa render ulang), kejadian akhir, tombol Unduh lagi
    {
      const t = await boot2(); let rel; t.st.fget = () => new Promise((r) => { rel = r; });
      const prerender = t.els.pglist.innerHTML; clickF(t, 'fget', P5, F1); await sleep(5);
      assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'pgFileGet'), [['pgFileGet', PEER, P5, F1]], 'id peer + postingan + berkas');
      let h = t.els.pglist.innerHTML; assert(h.includes('data-pg="fcancel"') && h.includes('0% ·') && h.includes(`id="pgdlb-${P5}-${F1}"`) && h.includes('style="width:0%"'), 'berjalan: progres 0 + Batal');
      clickF(t, 'fget', P5, F1); await sleep(2); assert.strictEqual(t.calls.filter((c) => c[0] === 'pgFileGet').length, 1, 'klik ganda saat berjalan = tidak ada panggilan kedua');
      t.st.dl(tag({ phase: 'progress', done: 524288, total: 1048576 })); // event tiba SEBELUM balasan pgFileGet
      assert.strictEqual(t.els[`pgdlt-${P5}-${F1}`].textContent, '50% · 512 KB / 1,0 MB'); assert.strictEqual(t.els[`pgdlb-${P5}-${F1}`].style.width, '50%'); assert.strictEqual(t.els.pglist.innerHTML, h, 'progres diperbarui di tempat: feed tidak digambar ulang');
      rel({ ok: true, id: ID1 }); await sleep(5);
      t.st.dl(tag({ phase: 'progress', done: 900000, total: 1048576 })); assert.strictEqual(t.els[`pgdlb-${P5}-${F1}`].style.width, '85%');
      t.st.dl(tag({ phase: 'done', name: 'laporan (1).pdf', size: 1048576 }));
      h = t.els.pglist.innerHTML; assert(h.includes('Tersimpan: laporan (1).pdf') && h.includes('Unduh lagi') && !h.includes('fcancel') && !h.includes('/home'), 'selesai: nama dari Core, tanpa jalur');
      t.st.dl(tag({ phase: 'progress', done: 1, total: 1048576 })); assert(t.els.pglist.innerHTML === h, 'event sesudah selesai diabaikan'); t.st.dl(tag({ phase: 'error', code: 'offline' })); t.st.dl(tag({ phase: 'none' })); assert(t.els.pglist.innerHTML === h, 'kejadian akhir kedua sesudah selesai diabaikan');
      // unduh lagi = unduhan baru (id baru); event lama (id lama) diabaikan
      t.st.fget = { ok: true, id: ID2 }; clickF(t, 'fget', P5, F1); await sleep(5); t.st.dl(tag({ phase: 'done', name: 'x.pdf' })); assert(t.els.pglist.innerHTML.includes('fcancel') && !t.els.pglist.innerHTML.includes('x.pdf'), 'id lama diabaikan: masih berjalan');
      t.st.dl(tag({ id: ID2, phase: 'done', name: 'baru.pdf' })); assert(t.els.pglist.innerHTML.includes('Tersimpan: baru.pdf'));
      ok('unduh: argumen dari feed, klik ganda diabaikan, progres di tempat (event sebelum balasan diterima), selesai menampilkan nama saja, Unduh lagi = id baru');
    }
    // 3. galat: balasan gagal (many / old / offline) dan kejadian error; Coba lagi hanya bila ada gunanya; tidak ada / diblokir
    {
      const t = await boot2();
      for (const [code, err, msg, retry] of [['many', 'x', 'Terlalu banyak unduhan berjalan', true], ['old', 'x', t.run('PG_ERR.old'), false], ['offline', 'x', t.run('PG_ERR.offline'), true], ['blocked', 'x', t.run('PG_ERR.blocked'), false], ['ENOSPC', 'Penyimpanan penuh', 'Penyimpanan penuh', true], ['EACCES', 'Gagal menyimpan berkas', 'Gagal menyimpan berkas', true], ['gone', 'x', 'berhenti menyediakan', true]]) {
        t.st.fget = { ok: false, code, err }; clickF(t, 'fget', P5, F1); await sleep(5);
        let h = t.els.pglist.innerHTML; assert(h.includes(msg) && h.includes('class="fs err"'), 'balasan gagal ' + code + ': ' + h.slice(0, 80));
        assert.strictEqual(h.includes('data-pg="fget"') && h.includes('Coba lagi'), retry, 'Coba lagi untuk ' + code);
        t.st.fget = { ok: true, id: ID1 }; if (retry) { clickF(t, 'fget', P5, F1); await sleep(5); t.st.dl(tag({ phase: 'error', code, err })); h = t.els.pglist.innerHTML; assert(h.includes(msg) && h.includes('Coba lagi'), 'kejadian error ' + code); }
        else { t.run('pgDl.clear(); renderFeed()'); }
      }
      t.run('pgDl.clear(); renderFeed()'); t.st.fget = { ok: true, id: ID1 }; clickF(t, 'fget', P5, F1); await sleep(5); t.st.dl(tag({ phase: 'none' }));
      let h = t.els.pglist.innerHTML; assert(h.includes('sudah tidak tersedia') && !h.includes('Coba lagi'), 'none: pesan, tanpa Coba lagi'); assert.strictEqual((h.match(/data-pg="fget"/g) || []).length, 1, 'hanya kartu lain yang masih punya Unduh');
      // pesan dari jaringan di-escape; kode / pesan aneh tidak merusak
      t.run('pgDl.clear()'); clickF(t, 'fget', P5, F1); await sleep(5); t.st.dl(tag({ phase: 'error', code: 'zzz', err: '<img src=x onerror=1>' })); h = t.els.pglist.innerHTML; assert(h.includes('&lt;img') && !h.includes('<img src=x'), 'pesan galat di-escape');
      t.run('pgDl.clear()'); t.st.fget = () => { throw new Error('IPC putus'); }; clickF(t, 'fget', P5, F1); await sleep(5); assert(t.els.pglist.innerHTML.includes(t.run('PG_ERR.proto')), 'IPC melempar ditangani');
      ok('galat: balasan gagal dan kejadian error bermakna per kode, Coba lagi hanya bila ada gunanya, none tanpa coba lagi, pesan di-escape, IPC melempar ditangani');
    }
    // 4. batal: tombol Batal -> pgFileCancel(id) -> kejadian cancel; batal sebelum balasan; batal saat tak ada unduhan = kembali ke Unduh
    {
      const t = await boot2(); t.st.fget = { ok: true, id: ID1 }; t.st.fcancel = { ok: true, cancelled: true };
      clickF(t, 'fget', P5, F1); await sleep(5); clickF(t, 'fcancel', P5, F1); await sleep(5);
      assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'pgFileCancel'), [['pgFileCancel', ID1]]); assert(t.els.pglist.innerHTML.includes('Membatalkan…') && t.els.pglist.innerHTML.includes('disabled'), 'tombol terkunci selagi membatalkan');
      clickF(t, 'fcancel', P5, F1); await sleep(2); assert.strictEqual(t.calls.filter((c) => c[0] === 'pgFileCancel').length, 1, 'batal ganda diabaikan');
      t.st.dl(tag({ phase: 'error', code: 'cancel', err: 'Dibatalkan' })); let h = t.els.pglist.innerHTML; assert(h.includes('Unduhan dibatalkan.') && !h.includes('class="fs err"') && h.includes('Coba lagi'), 'dibatalkan: pesan netral + bisa diulang');
      // batal sebelum balasan pgFileGet tiba: dibatalkan begitu id ada
      t.run('pgDl.clear()'); t.calls.length = 0; let rel; t.st.fget = () => new Promise((r) => { rel = r; }); clickF(t, 'fget', P5, F1); await sleep(3); clickF(t, 'fcancel', P5, F1); await sleep(3);
      assert.strictEqual(t.calls.filter((c) => c[0] === 'pgFileCancel').length, 0, 'belum ada id: belum memanggil Core'); rel({ ok: true, id: ID2 }); await sleep(5); assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'pgFileCancel'), [['pgFileCancel', ID2]], 'balasan tiba: dibatalkan dengan id-nya');
      // Core: tidak ada unduhan (sudah selesai / event hilang): setelah masa tunggu kembali ke tombol Unduh
      t.run('pgDl.clear(); PG_DL_GRACE = 20'); t.st.fget = { ok: true, id: ID1 }; t.st.fcancel = { ok: true, cancelled: false }; clickF(t, 'fget', P5, F1); await sleep(5); clickF(t, 'fcancel', P5, F1); await sleep(5);
      assert(t.els.pglist.innerHTML.includes('Membatalkan…'), 'masih menunggu kejadian akhir yang mungkin di jalan'); await sleep(40); h = t.els.pglist.innerHTML; assert(!h.includes('Membatalkan…') && h.includes('data-pg="fget"') && !h.includes('Coba lagi'), 'macet teratasi: kembali ke Unduh');
      t.run('pgDl.clear()'); t.st.fget = { ok: true, id: ID1 }; clickF(t, 'fget', P5, F1); await sleep(5); clickF(t, 'fcancel', P5, F1); await sleep(2); t.st.dl(tag({ phase: 'done', name: 'x.pdf' })); await sleep(40); assert(t.els.pglist.innerHTML.includes('Tersimpan: x.pdf'), 'kejadian akhir tiba dalam masa tunggu: dihormati');
      ok('batal: Batal -> pgFileCancel(id), terkunci + tidak ganda, batal sebelum balasan menunggu id, cancel = pesan netral + Coba lagi, macet (tak ada unduhan) kembali ke Unduh');
    }
    // 5. keamanan klik: hanya berkas yang ada di feed; id cacat / asing diabaikan; event asing diabaikan
    {
      const t = await boot2(); t.st.fget = { ok: true, id: ID1 };
      for (const [pid, fid] of [[P5, 'ffffffffffffffff'], [P6, F1], ['../x', F1], [P5, '../x'], [P5, undefined], [undefined, F1], [P5, 'ABCDEF0123456789'], [P5, F3]]) { clickF(t, 'fget', pid, fid); clickF(t, 'fcancel', pid, fid); }
      await sleep(5); assert.strictEqual(t.calls.filter((c) => c[0] === 'pgFileGet' || c[0] === 'pgFileCancel').length, 0, 'tidak ada panggilan untuk berkas yang tidak ada di feed');
      // event asing: peer lain / berkas tak diunduh / bentuk cacat / fase aneh
      clickF(t, 'fget', P5, F1); await sleep(5); const h = t.els.pglist.innerHTML;
      t.el(`pgdlt-${P5}-${F1}`).textContent = '0% · 0 B / 1,0 MB'; t.el(`pgdlb-${P5}-${F1}`).style.width = '0%'; // elemen sungguhan sudah ada di DOM; tiruan membuatnya saat diminta
      for (const bad of [null, 5, 'x', {}, tag({ peerId: 'b'.repeat(16) }), tag({ postId: P6 }), tag({ fileId: F2 }), tag({ phase: 'aneh' }), tag({ id: 'xyz', phase: 'done' }), tag({ id: ID2, phase: 'done' }), tag({ phase: 'progress', done: -1, total: 5 }), tag({ phase: 'progress', done: 'a', total: 5 }), tag({ phase: 'progress', done: 1, total: 0 })]) { t.st.dl(bad); }
      assert.strictEqual(t.els.pglist.innerHTML, h, 'event cacat / asing tidak mengubah apa pun'); assert.strictEqual(t.els[`pgdlt-${P5}-${F1}`].textContent, '0% · 0 B / 1,0 MB', 'progres cacat (negatif, bukan angka, total 0) tidak mengubah teks'); assert.strictEqual(t.els[`pgdlb-${P5}-${F1}`].style.width, '0%');
      t.st.dl(tag({ phase: 'progress', done: 999999999, total: 1048576 })); assert.strictEqual(t.els[`pgdlb-${P5}-${F1}`].style.width, '100%', 'progres dibatasi sampai total'); assert.strictEqual(t.els[`pgdlt-${P5}-${F1}`].textContent, '100% · 1,0 MB / 1,0 MB', 'done dibatasi sampai total (bukan 954 MB)');
      // layar ditutup: unduhan jalan terus; dibuka lagi = progres terbawa; yang sudah selesai dibuang saat dibuka
      t.run('pgClose()'); t.st.dl(tag({ phase: 'progress', done: 524288, total: 1048576 })); t.st.list = { ok: true, items: [Object.assign(post(5), { files: files5 })], next: null, count: 1, skipped: 0 }; t.run(`pgOpen('${PEER}')`); await sleep(10);
      assert(t.els.pglist.innerHTML.includes('50% ·') && t.els.pglist.innerHTML.includes('fcancel'), 'dibuka lagi: unduhan yang berjalan terlihat');
      t.st.dl(tag({ phase: 'done', name: 'a.pdf' })); t.run('pgClose()'); t.run(`pgOpen('${PEER}')`); await sleep(10); assert(!t.els.pglist.innerHTML.includes('Tersimpan'), 'hasil lama tidak terbawa ke layar baru');
      ok('keamanan: hanya berkas di feed yang bisa diminta, id cacat tanpa panggilan, event asing/cacat diabaikan, progres dibatasi, unduhan berjalan terbawa saat layar dibuka lagi');
    }
    // 6. statis: urutan skrip, CSS, kontrak
    {
      const html = rd('renderer/archne-index.html'), css = rd('renderer/css/archne-pages.css');
      assert(html.indexOf('<script src="archne-filecard.js">') < html.indexOf('js/archne-pages.js'), 'archne-filecard.js dimuat sebelum archne-pages.js'); assert(css.includes('.pgfiles'), 'CSS kartu lampiran');
      assert(rd('preload.js').includes('pgFileGet:') && rd('preload.js').includes('onPgDl:') && rd('renderer/archne-api-http.js').includes('api.onPgDl'), 'kontrak pgFileGet / onPgDl ada');
      ok('statis: urutan skrip, CSS, kontrak');
    }
  }

  // F. 3b: toggle unduh per postingan
  {
    const F1 = '1111111111111111', F2 = '2222222222222222', ID1 = 'aaaaaaaaaaaaaaaa', P5 = PID;
    const files = [{ id: F1, name: 'laporan.pdf', size: 1048576 }, { id: F2, name: 'setup.exe', size: 2048 }];
    const clickX = (t, a, extra) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: Object.assign({ pg: a }, extra) }) } });
    const tag = (o) => Object.assign({ id: ID1, peerId: PEER, postId: P5, fileId: F1 }, o);
    const media = [med(MID)];
    // 1. penonton: nodl true = kartu tanpa Unduh + catatan; peringatan berkas berisiko hilang; gambar tetap bisa dibuka; klik paksa tidak memanggil Core
    {
      const t = boot(); await openFeed(t, [Object.assign(post(5, media), { files, nodl: true }), Object.assign(post(6), { files })]);
      const h = t.els.pglist.innerHTML, first = h.slice(0, h.indexOf('data-pid="0000000000000006"'));
      assert(!first.includes('data-pg="fget"') && !first.includes('bisa dijalankan') && (first.match(/Pemilik mematikan unduhan untuk postingan ini/g) || []).length === 2, 'dua kartu: catatan, tanpa Unduh, tanpa peringatan .exe');
      assert(!h.includes('pgdlbtn') && !h.includes('data-pg="dl"'), 'penonton tidak pernah melihat tombol toggle milik pemilik'); assert(first.includes('laporan.pdf') && first.includes('setup.exe') && first.includes('1,0 MB'), 'nama dan ukuran tetap tampil'); assert(first.includes('data-pg="view"'), 'gambar tetap bisa dibuka');
      const rest = h.slice(h.indexOf('data-pid="0000000000000006"')); assert((rest.match(/data-pg="fget"/g) || []).length === 2 && rest.includes('bisa dijalankan') && !rest.includes('mematikan unduhan'), 'postingan tanpa nodl tidak terpengaruh');
      t.st.fget = { ok: true, id: ID1 }; clickX(t, 'fget', { pid: P5, fid: F1 }); await sleep(5); assert.strictEqual(t.calls.filter((c) => c[0] === 'pgFileGet').length, 0, 'klik paksa pada postingan nodl: tanpa panggilan ke Core');
      ok('penonton: nodl = kartu tanpa Unduh + catatan, tanpa peringatan berkas berisiko, gambar tetap terbuka, klik paksa tanpa panggilan, postingan lain utuh');
    }
    // 2. hanya `true` persis yang berlaku (pemilik jauh tidak dipercaya, tetapi tak ada yang dirugikan: Unduh tetap ditegakkan pemilik)
    {
      for (const v of [false, 'true', 1, null, {}]) { const t = boot(); await openFeed(t, [Object.assign(post(5), { files, nodl: v })]); assert(t.els.pglist.innerHTML.includes('data-pg="fget"') && !t.els.pglist.innerHTML.includes('mematikan unduhan'), 'nodl=' + JSON.stringify(v) + ' bukan true: Unduh tampil'); }
      ok('penonton: hanya nodl === true yang menyembunyikan Unduh');
    }
    // 3. pemilik mematikan SESUDAH feed dimuat: balasan gagal / event error 'nodl' mengganti kartu (tanpa Coba lagi) dan menandai postingan di feed
    {
      const t = boot(); await openFeed(t, [Object.assign(post(5), { files }), Object.assign(post(6), { files })]);
      t.st.fget = { ok: false, code: 'nodl', err: 'x' }; clickX(t, 'fget', { pid: P5, fid: F1 }); await sleep(5);
      let h = t.els.pglist.innerHTML, first = h.slice(0, h.indexOf('data-pid="0000000000000006"'));
      assert(!first.includes('data-pg="fget"') && !first.includes('Coba lagi') && first.includes('Pemilik mematikan unduhan'), 'balasan gagal nodl: kartu berganti, tanpa Coba lagi'); assert.strictEqual(t.run('pgF.items[0].nodl'), true, 'postingan ditandai di feed');
      assert((h.slice(h.indexOf('data-pid="0000000000000006"')).match(/data-pg="fget"/g) || []).length === 2, 'postingan lain tidak ikut');
      // lewat event error (unduhan sempat berjalan, dimatikan di tengah)
      const t2 = boot(); await openFeed(t2, [Object.assign(post(5), { files })]); t2.st.fget = { ok: true, id: ID1 }; clickX(t2, 'fget', { pid: P5, fid: F1 }); await sleep(5);
      t2.st.dl(tag({ phase: 'error', code: 'nodl', err: 'Pemilik mematikan unduhan untuk postingan ini.' })); h = t2.els.pglist.innerHTML;
      assert(!h.includes('data-pg="fget"') && !h.includes('Coba lagi') && !h.includes('fcancel') && h.includes('Pemilik mematikan unduhan'), 'event error nodl: berhenti, tanpa Coba lagi'); assert.strictEqual(t2.run('pgF.items[0].nodl'), true);
      // pgMarkNodl tidak menyentuh feed milik peer lain / feed sendiri
      t2.run(`pgMarkNodl('${'b'.repeat(16)}', '${P5}'); delete pgF.items[0].nodl; pgMarkNodl('${'b'.repeat(16)}', '${P5}')`); assert.strictEqual(t2.run('pgF.items[0].nodl'), undefined, 'peer lain: tidak menandai');
      ok('pemilik mematikan sesudah feed dimuat: balasan / event nodl mengganti kartu (tanpa Coba lagi), menandai postingan, tidak menyentuh postingan atau peer lain');
    }
    // 4. pemilik: tombol "Unduhan: aktif/mati" hanya bila ada lampiran; memanggil pgSetDl dengan allow yang benar; memakai keadaan dari Core; gagal / hilang
    {
      const t = boot(), calls = []; t.win.api.pgMine = async () => ({ ok: true, items: [Object.assign(post(5), { files }), Object.assign(post(6), { files, nodl: true }), post(7)], next: null, count: 3 });
      t.st.setdl = (id, allow) => ({ ok: true, found: true, nodl: !allow }); t.win.api.pgSetDl = async (...a) => { calls.push(a); const r = t.st.setdl; return typeof r === 'function' ? r(...a) : r; };
      t.run(`pgOpen('${ME}')`); await sleep(10);
      let h = t.els.pglist.innerHTML; const part = (n) => { const i = h.indexOf(`data-pid="${n.toString(16).padStart(16, '0')}"`); return h.slice(i, h.indexOf('class="pgpost"', i + 10) < 0 ? undefined : h.indexOf('class="pgpost"', i + 10)); };
      assert(part(5).includes('Unduhan: aktif') && part(5).includes('aria-pressed="true"') && part(6).includes('Unduhan: mati') && part(6).includes('aria-pressed="false"') && part(6).includes('pgdlbtn off') && !part(7).includes('pgdlbtn'), 'aktif / mati / tanpa tombol bila tanpa lampiran');
      assert(part(6).includes('data-pg="fget"'), 'pemilik tetap melihat Unduh di postingannya sendiri walau nodl (menyalin milik sendiri)');
      clickX(t, 'dl', { id: '0000000000000005' }); await sleep(5); assert.deepStrictEqual(calls, [['0000000000000005', false]], 'aktif -> matikan = allow false'); h = t.els.pglist.innerHTML; assert(part(5).includes('Unduhan: mati') && t.run('pgF.items[0].nodl') === true, 'tombol mengikuti keadaan dari Core');
      clickX(t, 'dl', { id: '0000000000000006' }); await sleep(5); assert.deepStrictEqual(calls[1], ['0000000000000006', true], 'mati -> nyalakan = allow true'); h = t.els.pglist.innerHTML; assert(part(6).includes('Unduhan: aktif') && !('nodl' in t.run('pgF.items[1]')), 'field dibuang di feed');
      // Core menjawab lain dari tebakan (mis. sudah berubah di perangkat lain): tombol mengikuti Core
      t.st.setdl = { ok: true, found: true, nodl: true }; clickX(t, 'dl', { id: '0000000000000006' }); await sleep(5); h = t.els.pglist.innerHTML; assert(part(6).includes('Unduhan: mati'), 'mengikuti jawaban Core');
      // lokal sudah sama dengan jawaban Core (dua perangkat / klik cepat): tidak boleh terbalik
      t.run('pgF.items[0].nodl = true'); t.st.setdl = { ok: true, found: true, nodl: true }; clickX(t, 'dl', { id: '0000000000000005' }); await sleep(5); assert.strictEqual(t.run('pgF.items[0].nodl'), true, 'Core bilang mati, lokal sudah mati: tetap mati');
      t.run('delete pgF.items[0].nodl'); t.st.setdl = { ok: true, found: true, nodl: false }; clickX(t, 'dl', { id: '0000000000000005' }); await sleep(5); assert.strictEqual(t.run('pgF.items[0].nodl'), undefined, 'Core bilang aktif, lokal sudah aktif: tetap aktif');
      t.run('pgF.items[0].nodl = true');
      // gagal: toast, tidak berubah
      t.toasts.length = 0; t.st.setdl = { ok: false, err: 'Disk penuh' }; clickX(t, 'dl', { id: '0000000000000005' }); await sleep(5); assert.deepStrictEqual(t.toasts, ['Disk penuh']); assert.strictEqual(t.run('pgF.items[0].nodl'), true, 'gagal: tidak berubah');
      t.toasts.length = 0; t.win.api.pgSetDl = async () => { throw new Error('IPC putus'); }; clickX(t, 'dl', { id: '0000000000000005' }); await sleep(5); assert.strictEqual(t.toasts.length, 1, 'IPC melempar ditangani');
      // postingan sudah tidak ada: dibuang dari feed
      t.win.api.pgSetDl = async () => ({ ok: true, found: false, nodl: false }); clickX(t, 'dl', { id: '0000000000000005' }); await sleep(5); assert.strictEqual(t.run('pgF.items.length'), 2, 'found false: postingan dibuang dari feed'); assert(t.toasts.some((x) => /tidak ada/.test(x)));
      // klik ganda selagi menunggu: satu panggilan, tombol terkunci
      let rel; const c2 = []; t.win.api.pgSetDl = (...a) => { c2.push(a); return new Promise((r) => { rel = r; }); };
      clickX(t, 'dl', { id: '0000000000000006' }); clickX(t, 'dl', { id: '0000000000000006' }); await sleep(3); assert.strictEqual(c2.length, 1, 'klik ganda = satu panggilan'); assert(t.els.pglist.innerHTML.includes(' disabled'), 'terkunci selagi menunggu');
      rel({ ok: true, found: true, nodl: false }); await sleep(5); assert(!t.els.pglist.innerHTML.includes(' disabled>') , 'terbuka lagi');
      // id cacat / bukan postingan di feed: tanpa panggilan
      const c3 = []; t.win.api.pgSetDl = async (...a) => { c3.push(a); return { ok: true, found: true, nodl: false }; };
      for (const id of ['../x', undefined, 'ffffffffffffffff', 'ABCDEF0123456789']) { clickX(t, 'dl', { id }); } await sleep(5); assert.strictEqual(c3.length, 0, 'hanya postingan di feed yang bisa diubah');
      // layar ditutup selagi menunggu: jawaban basi dibuang
      let rel2; t.win.api.pgSetDl = () => new Promise((r) => { rel2 = r; }); clickX(t, 'dl', { id: '0000000000000006' }); await sleep(3); t.toasts.length = 0; t.run('pgClose()'); rel2({ ok: false, err: 'basi' }); await sleep(5); assert.deepStrictEqual(t.toasts, [], 'jawaban basi sesudah layar ditutup: tanpa toast');
      ok('pemilik: tombol aktif/mati hanya bila ada lampiran, allow yang benar, mengikuti jawaban Core, gagal = toast tanpa perubahan, hilang = dibuang, klik ganda satu panggilan, id asing tanpa panggilan, jawaban basi dibuang');
    }
    // 5. kotak tulis: pilihan "Izinkan unduh lampiran" hanya relevan bila ada lampiran; diteruskan sebagai opts; tanpa lampiran tetap 3 argumen
    {
      const t = boot(), calls = []; t.win.api.pgMine = async () => ({ ok: true, items: [], next: null, count: 0 }); t.win.api.pgCreate = async (...a) => { calls.push(a); return { ok: true, post: Object.assign(post(9), { files }) }; };
      t.run(`pgOpen('${ME}')`); await sleep(10);
      assert.strictEqual(t.el('pgdlrow').hidden, true, 'tersembunyi tanpa lampiran'); t.run("pgFiles.push({ src: '/tmp/a.pdf', name: 'a.pdf' }); pgFileUi()"); assert.strictEqual(t.el('pgdlrow').hidden, false, 'tampil bila ada lampiran');
      t.run('pgFiles.length = 0; pgFileUi()'); assert.strictEqual(t.el('pgdlrow').hidden, true, 'tersembunyi lagi');
      const send = async (checked, withFile) => { t.el('pgtxt').value = 'halo'; t.el('pgdl').checked = checked; t.run(withFile ? "pgFiles.push({ src: '/tmp/a.pdf', name: 'a.pdf' })" : 'pgFiles.length = 0'); clickX(t, 'post'); await sleep(10); return calls[calls.length - 1]; };
      let c = await send(false, true); assert.strictEqual(JSON.stringify(c.slice(3)), JSON.stringify([[{ src: '/tmp/a.pdf' }], { nodl: true }]), 'dicentang mati + lampiran: opts { nodl: true }'); // JSON: array dari konteks vm beda realm
      assert.strictEqual(t.el('pgdl').checked, true, 'kotak kembali tercentang sesudah terkirim');
      c = await send(true, true); assert.strictEqual(JSON.stringify(c.slice(3)), JSON.stringify([[{ src: '/tmp/a.pdf' }], null]), 'dicentang: tanpa opts'); assert.strictEqual(c[4], undefined, 'argumen ke-5 undefined');
      c = await send(false, false); assert.strictEqual(c.length, 3, 'tanpa lampiran: panggilan tiga argumen seperti sebelum 3b, kotak diabaikan');
      ok('kotak tulis: pilihan hanya tampil bila ada lampiran, dicentang mati = { nodl: true }, dicentang = tanpa opts, tanpa lampiran tetap 3 argumen, kembali tercentang sesudah kirim');
    }
    // 5b. api-http (Android / peramban): argumen ke-4 (lampiran) dan ke-5 (opts) diteruskan ke rpc/pgCreate; kontrak lama (3 dan 4 argumen) tidak berubah; File diunggah dulu
    {
      const sent = [];
      const fetchFake = async (url, o) => { sent.push([url, o]); return { ok: true, status: 200, json: async () => (/\/upload/.test(url) ? { path: '/data/shared/up-' + sent.length } : { ok: true }) }; };
      const w = {}; vm.runInNewContext(rd('renderer/archne-api-http.js'), { window: w, fetch: fetchFake, location: { pathname: '/' }, document: {}, EventSource: function () { this.addEventListener = () => {}; }, setTimeout, clearTimeout, console, encodeURIComponent, JSON, Promise, Array, Math, Date });
      assert(w.api && typeof w.api.pgCreate === 'function', 'api-http memasang window.api');
      const body = () => JSON.parse(sent.filter(([u]) => /rpc\/pgCreate/.test(u)).pop()[1].body);
      await w.api.pgCreate('t', 'public', [], [{ src: '/a.pdf' }], { nodl: true }); assert.deepStrictEqual(body(), ['t', 'public', [], [{ src: '/a.pdf' }], { nodl: true }], 'lampiran + opts');
      await w.api.pgCreate('t', 'public', [], undefined, { nodl: true }); assert.deepStrictEqual(body(), ['t', 'public', [], null, { nodl: true }], 'opts tanpa lampiran: argumen ke-4 diisi null');
      await w.api.pgCreate('t', 'public', []); assert.deepStrictEqual(body(), ['t', 'public', []], 'kontrak lama: tiga argumen');
      await w.api.pgCreate('t', 'public', [], [{ src: '/a.pdf' }]); assert.deepStrictEqual(body(), ['t', 'public', [], [{ src: '/a.pdf' }]], 'kontrak lama: empat argumen');
      sent.length = 0; await w.api.pgCreate('t', 'public', [], [{ src: { name: 'b.pdf', size: 3 } }], { nodl: true });
      assert(sent.some(([u]) => /\/upload\?name=b\.pdf/.test(u)), 'File diunggah dulu'); assert.deepStrictEqual(body()[3].map((x) => /^\/data\/shared\/up-/.test(x.src)), [true], 'jalur hasil unggah, bukan File'); assert.deepStrictEqual(body()[4], { nodl: true });
      ok('api-http: lampiran + opts diteruskan, argumen ke-4 null bila hanya ada opts, kontrak 3 / 4 argumen tak berubah, File diunggah dulu');
    }
    // 6. statis: kontrak
    {
      const css = rd('renderer/css/archne-pages.css'), pre = rd('preload.js'), http = rd('renderer/archne-api-http.js'), ipc = rd('src/archne-ipc-pages.js');
      assert(css.includes('.pgdlbtn') && css.includes('.pgdlrow'), 'CSS'); assert(/pgSetDl: \(id, allow\)/.test(pre) && /pgCreate: \(text, priv, images, files, opts\)/.test(pre) && http.includes("'pgSetDl'") && /api\.pgCreate = async \(text, priv, images, files, opts\)/.test(http), 'kontrak preload / HTTP');
      assert(/on\('pgSetDl'/.test(ipc) && ipc.includes("'nodl'"), 'IPC'); assert(rd('renderer/js/archne-pages-files.js').includes('nodl: 1'), 'nodl tanpa Coba lagi');
      ok('statis: CSS, kontrak preload / HTTP / IPC');
    }
  }

  // G. 3c-8: video di feed penonton (kartu + Putar -> <video> dari token penyaji)
  {
    const VID = 'eeeeeeeeeeeeeeee', VID2 = 'ffffffffffffffff', VTOK = 'a1'.repeat(16), GOOD = { ok: true, video: { tok: VTOK, mime: 'video/mp4', total: 9 } };
    const vd = (id, o) => Object.assign({ id, mime: 'video/mp4', size: 5 * 1024 * 1024, name: 'klip.mp4' }, o || {});
    const vpost = (n, videos) => Object.assign(post(n), { videos });
    const mkEl = () => ({ tag: 'video', attrs: {}, paused: true, plays: 0, pauses: 0, loads: 0, src: undefined, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { if (k === 'src') this.src = undefined; }, pause() { this.paused = true; this.pauses++; }, play() { this.paused = false; this.plays++; return Promise.resolve(); }, load() { this.loads++; } });
    const vboot = () => {
      const t = boot(), made = [], pv = [], slots = [];
      t.ctx.document.createElement = (tag) => { assert.strictEqual(tag, 'video'); const e = mkEl(); made.push(e); return e; };
      t.ctx.window.api.pgVideo = async (...a) => { pv.push(a); const r = t.st.vid; return typeof r === 'function' ? r(...a) : r; };
      const L = t.el('pglist'); // querySelectorAll tiruan: slot dicari di innerHTML terakhir; appendChild mencatat elemen yang dipasang
      L.querySelectorAll = () => { slots.length = 0; for (const m of String(L.innerHTML).matchAll(/data-pgvk="([^"]+)"/g)) slots.push({ dataset: { pgvk: m[1] }, kids: [], appendChild(e) { this.kids.push(e); } }); return slots; };
      return { t, made, pv, slots, L };
    };
    const clickPlay = (t, pid, vid) => t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'vplay', pid, vid } }) } });
    const cards = (h) => (h.match(/class="pgvcard"/g) || []).length;
    // 0. statis
    assert(rd('renderer/css/archne-pages.css').includes('.pgvcard') && rd('renderer/css/archne-pages.css').includes('.pgvslot video'), 'CSS kartu + slot video');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(vboot().t.run('PG_VMIME'))), require('../src/archne-pagestore').VIDEO_MIME, 'mime renderer = VIDEO_MIME pagestore');
    assert(/pgVideo: \(peerId, postId, videoId\)/.test(rd('preload.js')) && rd('renderer/archne-api-http.js').includes("'pgVideo'"), 'kontrak pgVideo ada');
    // 1. render: kartu hanya untuk entri sah dari 4 teratas, nama di-escape, belum ada IPC, gambar tidak terganggu, postingan tanpa video tanpa wadah
    {
      const v = vboot(); await openFeed(v.t, [vpost(5, [vd(VID, { name: 'a<b>.mp4' }), vd(VID2, { mime: 'video/webm', name: 'dua.webm' }), vd('xyz'), vd('../x')]), post(6, [med(MID)]), post(7)]);
      const h = v.t.els.pglist.innerHTML;
      assert.strictEqual(cards(h), 2, 'id cacat dilewati'); assert(h.includes('a&lt;b&gt;.mp4') && !h.includes('<b>'), 'nama di-escape'); assert(h.includes('5.0 MB') || /\dMB|\d MB|MiB/.test(h), 'ukuran tampil');
      assert.strictEqual((h.match(/data-pg="vplay"/g) || []).length, 2); assert(h.includes(`data-pid="${PID}" data-vid="${VID}"`)); assert.strictEqual(v.pv.length, 0, 'render tidak meminta token'); assert.strictEqual((h.match(/class="pgslide pgslidev"/g) || []).length, 2, 'satu slide video per video (carousel hanya untuk postingan bermedia)'); assert(h.includes('pgth'), 'gambar tetap tampil');
      const bad = [vd('1111111111111111', { mime: 'image/png' }), vd('2222222222222222', { size: 0 }), vd('3333333333333333', { size: 1.5 }), vd('4444444444444444', { name: 7 }), null, 'x'];
      const w = vboot(); await openFeed(w.t, [vpost(5, bad)]); assert.strictEqual(w.t.els.pglist.innerHTML.includes('pgslidev'), false, 'semua entri cacat: tanpa slide video');
      const m = vboot(); await openFeed(m.t, [vpost(5, Array.from({ length: 7 }, (_, i) => vd('00000000000000' + (10 + i))))]); assert.strictEqual(cards(m.t.els.pglist.innerHTML), 4, 'peer jahat: maksimal 4 kartu');
    }
    ok('3c-8: feed: kartu video hanya untuk entri sah (id, mime, ukuran, nama) dari 4 teratas, nama di-escape, tanpa IPC saat render');
    // 2. Putar: pgVideo(peer, post, video); selama menunggu "Memuat…" + tombol mati; sukses = <video controls preload=metadata> di slot dengan URL penyaji; klik ganda tidak dobel
    {
      const v = vboot(), { t } = v; await openFeed(t, [vpost(5, [vd(VID), vd(VID2)])]); let gate; t.st.vid = new Promise((r) => { gate = r; });
      clickPlay(t, PID, VID); clickPlay(t, PID, VID); await sleep(5);
      assert.deepStrictEqual(v.pv, [[PEER, PID, VID]], 'satu panggilan dengan id pemilik, postingan, video'); assert(t.els.pglist.innerHTML.includes('Memuat…') && t.els.pglist.innerHTML.includes('disabled'));
      gate(GOOD); await sleep(5); const e = v.made[0];
      assert.strictEqual(v.made.length, 1); assert(e.controls === true && e.preload === 'metadata' && e.src === 'archne-media://m/' + VTOK && 'playsinline' in e.attrs && /klip\.mp4/.test(e.attrs['aria-label']), 'atribut video + URL desktop');
      assert.strictEqual(v.slots.length, 1); assert.deepStrictEqual(v.slots[0].kids, [e], 'dipasang di slotnya'); assert.strictEqual(v.slots[0].dataset.pgvk, PID + ':' + VID);
      assert.strictEqual(cards(t.els.pglist.innerHTML), 1, 'video lain tetap kartu'); clickPlay(t, PID, VID); await sleep(5); assert.strictEqual(v.pv.length, 1, 'sudah siap: Putar lagi diabaikan');
      t.win.location = { protocol: 'http:', pathname: '/s/ab12cd/index.html' }; clickPlay(t, PID, VID2); t.st.vid = GOOD; await sleep(10); assert.strictEqual(v.made[1].src, '/s/ab12cd/media/' + VTOK, 'Android: di bawah awalan sesi');
      // atribut palsu: video yang tidak ada di feed tidak pernah diminta
      v.pv.length = 0; for (const [p, x] of [[PID, 'dddddddddddddddd'], ['9999999999999999', VID], [undefined, undefined], ['', VID], [PID, '__proto__']]) clickPlay(t, p, x); await sleep(5); assert.strictEqual(v.pv.length, 0);
    }
    ok('3c-8: Putar: token baru diminta hanya saat klik, Memuat… saat menunggu, <video controls preload=metadata> di slot (desktop + Android), klik ganda dan id palsu diabaikan');
    // 3. galat: kode Core -> pesan; yang tak bisa berubah tanpa Coba lagi; null / token cacat / lempar -> pesan sendiri; coba lagi berhasil
    {
      const v = vboot(), { t } = v; await openFeed(t, [vpost(5, [vd(VID)])]); const H = () => t.els.pglist.innerHTML, PG = (c) => t.run(`PG_ERR.${c}`);
      const cases = [[{ ok: false, code: 'offline' }, PG('offline'), true], [{ ok: false, code: 'old' }, PG('old'), false], [{ ok: false, code: 'blocked' }, PG('blocked'), false], [{ ok: false, code: 'busy' }, PG('busy'), true], [{ ok: false, code: 'aneh', err: 'Pesan dari inti' }, 'Pesan dari inti', true], [{ ok: false }, 'Video tidak bisa dimuat.', true],
        [{ ok: true, video: null }, 'Video tidak tersedia. Mungkin sudah dihapus atau tidak untukmu.', false], [{ ok: true, video: { tok: 'pendek', mime: 'video/mp4' } }, PG('proto'), true], [{ ok: true, video: { tok: VTOK, mime: 'image/png' } }, PG('proto'), true], [{ ok: true, video: 'x' }, PG('proto'), true], [{ ok: true }, PG('proto'), true]];
      for (const [ans, msg, retry] of cases) {
        t.run('pgVdClear()'); t.run('renderFeed()'); t.st.vid = ans; clickPlay(t, PID, VID); await sleep(5);
        assert(H().includes('role="alert">' + msg + '</div>'), 'pesan: ' + msg + ' <- ' + H().slice(H().indexOf('pgvcard'), H().indexOf('pgvcard') + 400)); assert.strictEqual(H().includes('data-pg="vplay"'), retry, 'Coba lagi untuk ' + JSON.stringify(ans));
        assert.strictEqual(v.made.length, 0, 'galat: tidak ada elemen video');
      }
      t.run('pgVdClear()'); t.run('renderFeed()'); t.ctx.window.api.pgVideo = async () => { throw new Error('x'); }; clickPlay(t, PID, VID); await sleep(5); assert(H().includes(PG('proto')), 'IPC melempar = proto');
      t.ctx.window.api.pgVideo = async (...a) => { v.pv.push(a); return { ok: false, err: 'A'.repeat(500) }; }; t.run('pgVdClear()'); t.run('renderFeed()'); clickPlay(t, PID, VID); await sleep(5); assert(H().includes('A'.repeat(200) + '</div>') && !H().includes('A'.repeat(201)), 'pesan asing dipotong 200');
      // Coba lagi: berhasil pada percobaan berikutnya
      t.ctx.window.api.pgVideo = async (...a) => { v.pv.push(a); return t.st.vid; }; t.st.vid = { ok: false, code: 'offline' }; t.run('pgVdClear()'); t.run('renderFeed()'); clickPlay(t, PID, VID); await sleep(5); assert(H().includes('Coba lagi'));
      t.st.vid = GOOD; clickPlay(t, PID, VID); await sleep(5); assert.strictEqual(v.made.length, 1); assert(!H().includes('role="alert"'), 'pesan hilang sesudah berhasil');
      // terputus di tengah: elemen dilepas, pesan + Coba lagi, percobaan berikut membuat elemen baru
      const e = v.made[0]; e.onerror(); assert(e.src === undefined && e.pauses >= 1 && e.loads >= 1, 'elemen dilepas'); assert(H().includes('terputus') && H().includes('Coba lagi'));
      clickPlay(t, PID, VID); await sleep(5); assert.strictEqual(v.made.length, 2); e.onerror && e.onerror(); assert.strictEqual(v.made[1].src, 'archne-media://m/' + VTOK, 'onerror elemen lama tidak merusak yang baru');
    }
    ok('3c-8: galat: kode Core -> pesan, old / blocked / peer / video null tanpa Coba lagi, token / mime / bentuk cacat = proto, IPC melempar = proto, pesan asing dipotong, Coba lagi berhasil, aliran terputus melepas elemen');
    // 4. siklus hidup: gambar ulang memasang elemen yang sama dan melanjutkan yang sedang jalan; tutup membersihkan; jawaban basi dibuang; hapus postingan melepas videonya; shell lama = pesan
    {
      const v = vboot(), { t } = v; await openFeed(t, [vpost(5, [vd(VID)])]); t.st.vid = GOOD; clickPlay(t, PID, VID); await sleep(5); const e = v.made[0];
      assert(e.plays >= 1, 'sesudah diketuk, video langsung diputar (tanpa ketuk kedua)'); const b = e.plays; e.paused = true;
      t.run('renderFeed()'); assert.deepStrictEqual(v.slots[0].kids, [e], 'elemen yang sama dipasang ulang'); assert.strictEqual(e.plays, b, 'tidak jalan = tidak dilanjutkan');
      e.paused = false; t.run('renderFeed()'); assert.strictEqual(e.plays, b + 1, 'yang sedang jalan dilanjutkan'); assert.strictEqual(v.made.length, 1);
      t.run('pgClose()'); assert(e.src === undefined && e.pauses >= 1 && e.loads >= 1, 'tutup: pause + sumber dilepas'); assert.strictEqual(t.run('pgVd.size'), 0);
      let gate; const w = vboot(); await openFeed(w.t, [vpost(5, [vd(VID)])]); w.t.st.vid = new Promise((r) => { gate = r; }); clickPlay(w.t, PID, VID); await sleep(5); w.t.run('pgClose()'); gate(GOOD); await sleep(5);
      assert.strictEqual(w.made.length, 0, 'ditutup selagi menunggu: jawaban basi dibuang'); assert.strictEqual(w.t.run('pgVd.size'), 0);
      let g2; const x = vboot(); await openFeed(x.t, [vpost(5, [vd(VID)])]); x.t.st.vid = new Promise((r) => { g2 = r; }); clickPlay(x.t, PID, VID); await sleep(5); x.t.run(`pgOpen('${PEER}')`); g2(GOOD); await sleep(10);
      assert.strictEqual(x.made.length, 0, 'layar dibuka ulang selagi menunggu: jawaban basi dibuang');
      // Halamanku: id sendiri; hapus postingan melepas videonya
      const m = vboot(); m.t.run(`pgOpen('${ME}')`); await sleep(5); m.t.run('pgF.items.push(' + JSON.stringify(vpost(5, [vd(VID)])) + ')'); m.t.run('renderFeed()'); m.t.st.vid = GOOD; clickPlay(m.t, PID, VID); await sleep(5);
      assert.deepStrictEqual(m.pv, [[ME, PID, VID]], 'Halamanku: id sendiri'); m.t.win.api.pgRemove = async () => ({ ok: true }); m.t.ctx.window.api.pgRemove = m.t.win.api.pgRemove; const me = m.made[0];
      m.t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'del', id: PID } }) } }); await sleep(10);
      assert(me.src === undefined && me.pauses >= 1 && m.t.run('pgVd.size') === 0, 'hapus postingan: video dilepas');
      // shell lama
      const n = vboot(); await openFeed(n.t, [vpost(5, [vd(VID)])]); n.t.ctx.window.api.pgVideo = undefined; clickPlay(n.t, PID, VID); await sleep(5); assert(n.t.toasts.length === 1 && /belum bisa memutar/.test(n.t.toasts[0]) && n.t.run('pgVd.size') === 0, 'tanpa pgVideo: toast, tanpa status');
    }
    ok('3c-8: siklus hidup: gambar ulang memasang elemen sama + melanjutkan yang jalan, tutup / buka ulang membersihkan, jawaban basi dibuang, hapus postingan melepas video, Halamanku memakai id sendiri, shell lama = pesan');
    // 5. celah hasil uji mutasi: token hanya 32 heks huruf kecil, id postingan cacat, label Coba lagi terlihat, pesan galat di-escape, entri berformat salah di feed tidak bisa diminta, hapus hanya melepas video postingan itu, buka ulang membersihkan
    {
      const v = vboot(), { t } = v; await openFeed(t, [vpost(5, [vd(VID)])]);
      for (const tk of ['a1'.repeat(8), 'a1'.repeat(16) + 'f', 'A1'.repeat(16), 'a1'.repeat(15) + 'zz']) { t.run('pgVdClear()'); t.run('renderFeed()'); t.st.vid = { ok: true, video: { tok: tk, mime: 'video/mp4', total: 1 } }; clickPlay(t, PID, VID); await sleep(5); assert.strictEqual(v.made.length, 0, 'token cacat ditolak: ' + tk); assert(t.els.pglist.innerHTML.includes(t.run('PG_ERR.proto'))); }
      t.run('pgVdClear()'); t.run('renderFeed()'); t.st.vid = { ok: false, code: 'offline' }; clickPlay(t, PID, VID); await sleep(5); const H = t.els.pglist.innerHTML;
      assert(H.includes('aria-label="Coba lagi memutar video') && !H.includes('aria-label="Putar video'), 'sesudah galat tombolnya bertuliskan Coba lagi'); t.run('pgVdClear()'); t.run('renderFeed()'); assert(t.els.pglist.innerHTML.includes('aria-label="Putar video'), 'awal: Putar');
      t.st.vid = { ok: false, err: '<img src=x onerror=1>' }; clickPlay(t, PID, VID); await sleep(5); assert(t.els.pglist.innerHTML.includes('&lt;img src=x') && !t.els.pglist.innerHTML.includes('<img src=x'), 'pesan asing di-escape');
      const w = vboot(); await openFeed(w.t, [Object.assign(vpost(5, [vd(VID)]), { id: 'xyz' })]); assert.strictEqual(w.t.els.pglist.innerHTML.includes('pgvcard'), false, 'id postingan cacat: tanpa kartu');
      // entri yang ada di feed tetapi mimenya salah (peer jahat) tidak jadi kartu dan tidak bisa diminta
      const x = vboot(); await openFeed(x.t, [vpost(5, [vd(VID, { mime: 'image/png' })])]); x.t.st.vid = GOOD; clickPlay(x.t, PID, VID); await sleep(5); assert.strictEqual(x.pv.length, 0, 'mime salah: tidak diminta');
      // dua video di dua postingan; hapus satu: yang lain tetap berjalan
      const m = vboot(); m.t.run(`pgOpen('${ME}')`); await sleep(5); const P2 = '0000000000000006';
      m.t.run('pgF.items.push(' + JSON.stringify(vpost(5, [vd(VID)])) + ',' + JSON.stringify(vpost(6, [vd(VID)])) + ')'); m.t.run('renderFeed()'); m.t.st.vid = GOOD; clickPlay(m.t, PID, VID); clickPlay(m.t, P2, VID); await sleep(10); assert.strictEqual(m.made.length, 2);
      m.t.ctx.window.api.pgRemove = async () => ({ ok: true }); m.t.els.pgmodal.h.click({ target: { closest: () => ({ dataset: { pg: 'del', id: PID } }) } }); await sleep(10);
      assert(m.made[0].src === undefined && m.made[1].src !== undefined && m.t.run('pgVd.size') === 1, 'hanya video postingan yang dihapus yang dilepas');
      // buka ulang layar (tanpa menutup) membersihkan video yang sudah siap
      const y = vboot(); await openFeed(y.t, [vpost(5, [vd(VID)])]); y.t.st.vid = GOOD; clickPlay(y.t, PID, VID); await sleep(5); y.t.run(`pgOpen('${PEER}')`); assert(y.made[0].src === undefined && y.t.run('pgVd.size') === 0, 'pgOpen: video lama dilepas');
    }
    ok('3c-8: token hanya 32 heks huruf kecil, id postingan cacat, Coba lagi terlihat, pesan galat di-escape, mime salah tak bisa diminta, hapus hanya melepas postingan itu, buka ulang membersihkan');
    // 3d-b2: satu video jalan pada satu waktu + galat 'streams' dari Core
    {
      const v = vboot(), { t } = v, H = () => t.els.pglist.innerHTML; await openFeed(t, [vpost(5, [vd(VID), vd(VID2)])]);
      t.st.vid = GOOD; clickPlay(t, PID, VID); await sleep(5); const e1 = v.made[0]; assert(e1 && typeof e1.onplay === 'function', 'elemen punya pendengar play');
      e1.paused = false; // video pertama sedang jalan
      let gate; t.st.vid = new Promise((r) => { gate = r; }); clickPlay(t, PID, VID2);
      assert.strictEqual(e1.paused, true, 'Putar video lain: yang sedang jalan dijeda SEGERA (sebelum token baru datang)'); assert.strictEqual(e1.src, 'archne-media://m/' + VTOK, 'dijeda, bukan dilepas: sumber tetap'); assert.strictEqual(t.run('pgVd.size'), 2);
      gate(GOOD); await sleep(5); const e2 = v.made[1]; assert(e2.plays >= 1, 'video baru langsung diputar sesudah diketuk (play() dipanggil)');
      e2.paused = false; e2.onplay(); assert.strictEqual(e2.paused, false, 'yang baru jalan tidak menjeda dirinya');
      e1.paused = false; e1.onplay(); assert.strictEqual(e2.paused, true, 'play dari kontrol bawaan video 1 menjeda video 2'); assert.strictEqual(e1.paused, false);
      // pendengar basi (elemen sudah dilepas dari pgVd) tidak menjeda siapa pun
      t.run('pgVdClear()'); t.run('renderFeed()'); t.st.vid = GOOD; clickPlay(t, PID, VID); await sleep(5); const e3 = v.made[2]; e3.paused = false; e1.onplay(); assert.strictEqual(e3.paused, false, 'pendengar basi diabaikan');
      // galat streams: pesan khusus + Coba lagi, lalu berhasil sesudah dijeda
      t.run('pgVdClear()'); t.run('renderFeed()'); t.st.vid = { ok: false, err: 'x', code: 'streams' }; clickPlay(t, PID, VID2); await sleep(5);
      assert(H().includes(t.run('PG_ERR.streams')) && /jeda/i.test(t.run('PG_ERR.streams')), 'pesan streams'); assert(H().includes('data-pg="vplay"') && H().includes('Coba lagi'), 'streams boleh dicoba lagi');
      assert.strictEqual(v.made.length, 3, 'ditolak: tidak ada elemen'); t.st.vid = GOOD; clickPlay(t, PID, VID2); await sleep(5); assert.strictEqual(v.made.length, 4, 'Coba lagi berhasil'); assert(!H().includes(t.run('PG_ERR.streams')));
    }
    ok('3d-b2: Putar menjeda video lain yang jalan (dijeda, bukan dilepas), play dari kontrol menjeda yang lain, video baru tidak jalan sendiri, pendengar basi diabaikan, streams = pesan + Coba lagi');
  }

  console.log('\nLULUS ' + pass + ' kelompok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
