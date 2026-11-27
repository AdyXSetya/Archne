// Web Lokal (0.34.0 Fase D.3): tab Jelajah. Daftar situs milik peer yang terhubung (lw_list lewat api.webList), pencarian, urutan, dan gulir bertahap.
// Sumber: tiap peer yang online ditanya webAvail lalu webList (halaman 20, paling banyak LW_POOL peer sekaligus). Peer yang tak bisa dihubungi / belum mendukung Web / gagal dihitung di catatan "{n} peer tidak bisa dihubungi".
// Pencarian: menyaring daftar yang sudah dimuat seketika (judul, domain, deskripsi, kata kunci, nama pemilik); bila ada peer yang daftarnya terpotong, `q` juga dikirim ke peer itu (setelah jeda) dan hasilnya digabung.
// Kartu hanya menampilkan data bersih dari IPC (sudah dikanonkan Core); semua teks tetap di-esc. Ketuk kartu = lwOpenSite (penampil: Fase F).
const LW_PAGE = 20, LW_POOL = 4, LW_SEARCH_MS = 300;
let lwB = null, lwBTimer = null; // lwB: { all: Map(kunci -> situs + peerId), peers: Map(id -> { next, avail }), q, sort, loading, bad }; null = tab tidak aktif (balasan IPC yang terlambat dibuang: B !== lwB)
const lwBKey = (e) => e.peerId + ':' + e.id;
const lwNorm = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase();

function lwBNew(keep) { return { all: new Map(), peers: new Map(), q: keep ? keep.q : '', sort: keep ? keep.sort : 'new', loading: false, bad: 0 }; }
function lwBPeerIds() { return S.peers.filter((p) => p && p.online && p.id !== S.me.id).map((p) => p.id); }
function lwBStop() { if (lwBTimer) { clearTimeout(lwBTimer); lwBTimer = null; } lwB = null; }
function lwBrowseStop() { lwBStop(); }

// Jalankan fn untuk tiap id, paling banyak LW_POOL sekaligus.
async function lwPool(ids, fn) {
  const q = ids.slice();
  await Promise.all(Array.from({ length: Math.min(LW_POOL, q.length) }, async () => { while (q.length) { const id = q.shift(); try { await fn(id); } catch (x) {} } }));
}
// Ambil satu halaman daftar satu peer. mode 'page' = lanjutkan kursor peer (memperbarui next); 'q' = pencarian di peer (tidak mengubah kursor). Mengembalikan false bila peer tak bisa dipakai.
async function lwBFetch(B, id, mode, q) {
  const st = B.peers.get(id) || { next: null, avail: null };
  if (st.avail !== true) {
    const av = await window.api.webAvail(id);
    if (B !== lwB) return false;
    st.avail = !!(av && av.ok); B.peers.set(id, st);
    if (!st.avail) { B.bad++; return false; }
  }
  const o = { limit: LW_PAGE };
  if (mode === 'page' && st.next) o.after = st.next;
  if (mode === 'q') o.q = q;
  const r = await window.api.webList(id, o);
  if (B !== lwB) return false;
  if (!r || !r.ok) { B.bad++; if (mode === 'page') st.next = null; return false; }
  for (const s of Array.isArray(r.items) ? r.items : []) { const e = Object.assign({ peerId: id }, s); if (!B.all.has(lwBKey(e))) B.all.set(lwBKey(e), e); }
  if (mode === 'page') st.next = r.next;
  return true;
}
async function lwBLoad(reset) {
  if (reset || !lwB) lwB = lwBNew(lwB);
  const B = lwB; if (B.loading) return;
  B.loading = true; lwBPaint();
  const ids = reset || !B.peers.size ? lwBPeerIds() : [...B.peers.entries()].filter(([, s]) => s.next).map(([id]) => id);
  await lwPool(ids, (id) => lwBFetch(B, id, 'page'));
  if (B !== lwB) return; // layar ditutup / dimuat ulang selagi menunggu
  B.loading = false; lwBPaint();
  if (B.q) lwBRemote(B.q);
}
// q ke peer yang daftarnya terpotong (masih punya next); hasil digabung ke daftar.
async function lwBRemote(q) {
  const B = lwB; if (!B || B.loading || B.q !== q || !q) return;
  const ids = [...B.peers.entries()].filter(([, s]) => s.next).map(([id]) => id);
  if (!ids.length) return;
  B.loading = true; lwBPaint();
  await lwPool(ids, (id) => lwBFetch(B, id, 'q', q));
  if (B !== lwB) return;
  B.loading = false; lwBPaint();
}
function lwBrowseStart() {
  $('lwbody').innerHTML = `<div class="lwsearch"><input id="lwq" type="search" maxlength="64" autocomplete="off" placeholder="${esc(txf('lw.search.ph', 'Cari situs, domain, atau pemilik'))}" aria-label="${esc(txf('lw.search.aria', 'Cari situs'))}"><select id="lwsort" aria-label="${esc(txf('lw.sort.aria', 'Urutkan'))}">${['new', 'az', 'owner'].map((k) => `<option value="${k}">${esc(txf('lw.sort.' + k, k))}</option>`).join('')}</select><button type="button" class="pib" data-lw="reload" title="${esc(txf('lw.reload', 'Muat ulang'))}" aria-label="${esc(txf('lw.reload', 'Muat ulang'))}">${icn('flip')}</button></div><div id="lwres" class="lwres" aria-live="polite"></div>`;
  lwBStop(); lwBLoad(true);
}
function lwBrowseInput(v) {
  if (!lwB) return;
  lwB.q = String(v || '').slice(0, 64).trim();
  lwBPaint();
  if (lwBTimer) clearTimeout(lwBTimer);
  const B = lwB, q = B.q;
  lwBTimer = setTimeout(() => { lwBTimer = null; if (B === lwB && B.q === q) lwBRemote(q); }, LW_SEARCH_MS);
}
function lwBrowseSort(v) { if (lwB && ['new', 'az', 'owner'].includes(v)) { lwB.sort = v; lwBPaint(); } }
function lwBrowseAct(act, d) {
  if (act === 'reload') { lwBLoad(true); return true; }
  if (act === 'more') { lwBLoad(false); return true; }
  if (act === 'site') { lwOpenSite(d.peer, d.site, d.domain); return true; }
  return false;
}
// Daftar tampil: disaring menurut q (lokal), diurutkan.
function lwBVisible(B) {
  const q = lwNorm(B.q).trim();
  let rows = [...B.all.values()];
  if (q) rows = rows.filter((e) => [e.domain + '.archne', e.title, e.desc, nameOf(e.peerId)].concat(e.tags).some((x) => lwNorm(x).includes(q)));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  if (B.sort === 'az') rows.sort((a, b) => cmp(lwNorm(a.title), lwNorm(b.title)) || b.ts - a.ts);
  else if (B.sort === 'owner') rows.sort((a, b) => cmp(lwNorm(nameOf(a.peerId)), lwNorm(nameOf(b.peerId))) || b.ts - a.ts);
  else rows.sort((a, b) => b.ts - a.ts);
  return rows;
}
function lwBCard(e) {
  const on = !!(S.peers.find((p) => p.id === e.peerId) || {}).online;
  return `<button type="button" class="lwcard" data-lw="site" data-peer="${esc(e.peerId)}" data-site="${esc(e.id)}" data-domain="${esc(e.domain)}"><span class="lwct">${esc(e.title)}</span><span class="lwcd">${esc(e.domain)}.archne</span><span class="lwco"><i class="lwdot${on ? ' on' : ''}" title="${esc(txf(on ? 'lw.online' : 'lw.offline', on ? 'Online' : 'Offline'))}"></i>${esc(txf('lw.by', 'oleh {name}', { name: nameOf(e.peerId) }))}</span><span class="lwcx">${esc(e.desc || txf('lw.noDesc', 'Tanpa deskripsi'))}</span></button>`;
}
function lwBPaint() {
  const el = $('lwres'), B = lwB; if (!el || !B) return;
  const rows = lwBVisible(B), more = [...B.peers.values()].some((s) => s.next);
  let h = '';
  if (rows.length) h += `<div class="lwgrid">${rows.map(lwBCard).join('')}</div>`;
  else if (B.loading) h += `<p class="lwempty">${esc(txf('lw.loading', 'Memuat…'))}</p>`;
  else h += `<p class="lwempty">${esc(B.q ? txf('lw.empty.search', 'Tidak ada situs yang cocok dengan “{q}”.', { q: B.q }) : txf('lw.empty.browse', 'Belum ada situs dari peer yang terhubung.'))}</p>`;
  if (B.bad && !B.loading) h += `<p class="lwnote">${esc(txf('lw.skipped', '{n} peer tidak bisa dihubungi atau belum mendukung Web.', { n: B.bad }))}</p>`;
  if (more && !B.loading) h += `<div class="lwmore"><button type="button" class="sec" data-lw="more">${esc(txf('lw.more', 'Muat lebih banyak'))}</button></div>`;
  el.innerHTML = h;
}
