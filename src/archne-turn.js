'use strict';
// Konfigurasi ICE (STUN/TURN) untuk mode lintas jaringan, langkah 5. Berjalan di Core (Node 12 ke atas; tanpa fetch/?./??).
// Kredensial TURN hanya hidup di Core: UI hanya menerima `iceServers` jadi dan ringkasan tanpa rahasia (lihat publicInfo).
//
// Penyedia:
//   none        hanya STUN bawaan
//   manual      { urls, username?, credential? }
//   metered     { app, apiKey }        GET https://<app>.metered.live/api/v1/turn/credentials?apiKey=...  -> larik iceServers
//   cloudflare  { keyId, token }       POST https://rtc.live.cloudflare.com/v1/turn/keys/<keyId>/credentials/generate-ice-servers
//                                       -> iceServers berumur pendek; dibuat di sini dan diperbarui sebelum kedaluwarsa
// Pemakaian:  const t = createTurn({ https?, now? });  t.set(cfg);  await t.ice() -> { iceServers, provider, err? }

const nodeHttps = require('https');
const { ek, errText } = require('./core/archne-ecode'); // i18n (E9e): galat berkunci; err hasil ice() diterjemahkan SAAT dikembalikan

const DEFAULT_STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }]; // sama dengan DEFAULT_STUN di renderer/archne-rtcmux.js
const CF_TTL = 86400;                 // umur kredensial Cloudflare (dtk)
const CF_MIN_LEFT = 6 * 3600e3;       // diperbarui bila sisa umur < 6 jam, jadi panggilan yang baru mulai selalu punya >= 6 jam
const METERED_TTL = 3600e3;           // kredensial Metered dari API key: disimpan 1 jam
const FAIL_BACKOFF = 5e3;             // gagal mengambil: jangan coba lagi sebelum ini lewat (singkat: panggilan berikutnya langsung mencoba lagi, bukan menunggu setengah menit tanpa TURN)
const HTTP_TIMEOUT = 4000, HTTP_MAX = 64 * 1024;
const RETRY_MS = 400;                 // jeda sebelum satu kali coba ulang (gangguan jaringan sesaat); token/ID ditolak tidak diulang
const PERMANENT = new Set(['e.turn.cfDenied', 'e.turn.cfNotFound', 'e.turn.meteredDenied', 'e.turn.cfNoTurn', 'e.turn.meteredNone', 'e.turn.tooBig']);
const URL_RE = /^(stun|stuns|turn|turns):[^\s]{1,200}$/i;
const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const KEYID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const S = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : '');

// Bersihkan satu entri iceServers dari sumber luar. Null bila tidak ada URL sah. Port 53 dibuang (diblokir peramban dan hanya memicu peringatan).
function cleanServer(e) {
  if (!e || typeof e !== 'object') return null;
  const raw = Array.isArray(e.urls) ? e.urls : [e.urls];
  const urls = raw.filter((u) => typeof u === 'string' && URL_RE.test(u) && !/:53(\?|$)/.test(u)).slice(0, 8);
  if (!urls.length) return null;
  const o = { urls: urls.length === 1 ? urls[0] : urls };
  if (typeof e.username === 'string' && e.username.length <= 300) o.username = e.username;
  if (typeof e.credential === 'string' && e.credential.length <= 600) o.credential = e.credential;
  return o;
}
function cleanList(v) {
  const arr = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []); // Cloudflare lama mengembalikan objek tunggal
  return arr.slice(0, 8).map(cleanServer).filter(Boolean);
}

// Validasi + bentuk baku. Melempar Error berpesan Indonesia bila tidak sah. { provider:'none' } = tanpa TURN.
function normalize(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('Pengaturan TURN tidak valid');
  const p = cfg.provider;
  if (p === 'none' || p === undefined || p === null || p === '') return { provider: 'none' };
  if (p === 'metered') {
    const app = S(cfg.app, 63).replace(/\.metered\.live$/i, ''), apiKey = S(cfg.apiKey, 200);
    if (!APP_RE.test(app)) throw ek('e.turn.meteredApp', null, 'Nama app Metered tidak valid');
    if (!apiKey || /[\s&?#]/.test(apiKey)) throw ek('e.turn.meteredKey', null, 'API key Metered tidak valid');
    return { provider: 'metered', app: app.toLowerCase(), apiKey };
  }
  if (p === 'cloudflare') {
    const keyId = S(cfg.keyId, 100), token = S(cfg.token, 400);
    if (!KEYID_RE.test(keyId)) throw ek('e.turn.cfKeyId', null, 'TURN Key ID Cloudflare tidak valid');
    if (!token || /\s/.test(token)) throw ek('e.turn.cfToken', null, 'API token Cloudflare tidak valid');
    return { provider: 'cloudflare', keyId, token };
  }
  if (p === 'manual') {
    const list = (Array.isArray(cfg.urls) ? cfg.urls : String(typeof cfg.urls === 'string' ? cfg.urls : '').split(/[\s,]+/)).map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
    if (!list.length || list.length > 8) throw ek('e.turn.count', null, 'Isi 1 sampai 8 alamat TURN/STUN (turn:host:port)');
    for (const u of list) if (!URL_RE.test(u)) throw ek('e.turn.badUrl', { url: u.slice(0, 60) }, 'Alamat tidak sah: {url} (harus diawali turn:, turns:, stun: atau stuns:)');
    const o = { provider: 'manual', urls: list };
    const un = S(cfg.username, 300), cr = S(cfg.credential, 600);
    if ((!un || !cr) && list.some((u) => /^turns?:/i.test(u))) throw ek('e.turn.needCred', null, 'TURN membutuhkan username dan credential');
    if (un) o.username = un;
    if (cr) o.credential = cr;
    return o;
  }
  throw ek('e.turn.unknown', null, 'Penyedia TURN tidak dikenal');
}

// Ringkasan aman untuk UI: tanpa API key, token, atau credential.
function publicInfo(cfg) {
  if (!cfg || cfg.provider === 'none') return { provider: 'none' };
  if (cfg.provider === 'metered') return { provider: 'metered', app: cfg.app, hasSecret: true };
  if (cfg.provider === 'cloudflare') return { provider: 'cloudflare', keyId: cfg.keyId, hasSecret: true };
  return { provider: 'manual', urls: cfg.urls.slice(), username: cfg.username || '', hasSecret: !!cfg.credential };
}

// Permintaan HTTPS kecil. Hasil { status, body } (body string); melempar bila jaringan gagal, kebesaran, atau melewati batas waktu.
function httpsJson(opts, body) {
  return new Promise((resolve, reject) => {
    const req = nodeHttps.request(opts, (res) => {
      const ch = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > HTTP_MAX) { req.destroy(ek('e.turn.tooBig', null, 'Balasan terlalu besar')); return; } ch.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(HTTP_TIMEOUT, () => req.destroy(ek('e.turn.timeout', null, 'Waktu habis')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createTurn(o) {
  o = o || {};
  const http = o.https || httpsJson;
  const now = o.now || (() => Date.now());
  let cfg = { provider: 'none' };
  let cache = null;    // { servers, until, gen }: hasil terakhir yang berhasil dari penyedia (metered/cloudflare)
  let failAt = 0, failErr = null, inflight = null, gen = 0; // failErr = objek galat (diterjemahkan oleh errText saat ice() mengembalikannya)

  function set(c) { cfg = normalize(c); cache = null; failAt = 0; failErr = null; inflight = null; gen++; return publicInfo(cfg); }
  function get() { return cfg; }

  async function fetchMetered(c) {
    const r = await http({ method: 'GET', hostname: c.app + '.metered.live', path: '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(c.apiKey), headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) throw ek('e.turn.meteredDenied', null, 'API key Metered ditolak');
    if (r.status < 200 || r.status >= 300) throw ek('e.turn.meteredStatus', { status: r.status }, 'Metered membalas {status}');
    const servers = cleanList(JSON.parse(r.body));
    if (!servers.length) throw ek('e.turn.meteredNone', null, 'Metered tidak mengembalikan server');
    return { servers, until: now() + METERED_TTL };
  }
  async function fetchCloudflare(c) {
    const body = JSON.stringify({ ttl: CF_TTL });
    const r = await http({ method: 'POST', hostname: 'rtc.live.cloudflare.com', path: '/v1/turn/keys/' + encodeURIComponent(c.keyId) + '/credentials/generate-ice-servers', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (r.status === 401 || r.status === 403) throw ek('e.turn.cfDenied', null, 'Token Cloudflare ditolak');
    if (r.status === 404) throw ek('e.turn.cfNotFound', null, 'TURN Key ID Cloudflare tidak ditemukan');
    if (r.status < 200 || r.status >= 300) throw ek('e.turn.cfStatus', { status: r.status }, 'Cloudflare membalas {status}');
    const servers = cleanList(JSON.parse(r.body).iceServers);
    if (!servers.some((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)))) throw ek('e.turn.cfNoTurn', null, 'Cloudflare tidak mengembalikan server TURN');
    return { servers, until: now() + CF_TTL * 1000 };
  }

  // Satu kali coba ulang untuk gangguan sesaat (timeout, putus, 5xx, balasan rusak). Penolakan tetap (token/ID salah) langsung dilaporkan.
  async function retry(fn) {
    try { return await fn(); } catch (e) {
      if (e && PERMANENT.has(e.ek)) throw e;
      await new Promise((res) => setTimeout(res, o.retryMs != null ? o.retryMs : RETRY_MS));
      return fn();
    }
  }

  // Segar? Cloudflare diperbarui lebih awal (CF_MIN_LEFT) supaya panggilan panjang tidak kehilangan kredensial di tengah.
  const fresh = (c) => c && (cfg.provider === 'cloudflare' ? c.until - now() > CF_MIN_LEFT : c.until > now());

  // -> { iceServers, provider, err? }. Tidak pernah melempar: gagal -> kredensial lama yang masih berlaku, atau STUN bawaan + err.
  async function ice() {
    const c = cfg;
    if (c.provider === 'none') return { iceServers: DEFAULT_STUN.slice(), provider: 'none' };
    if (c.provider === 'manual') {
      const s = { urls: c.urls.length === 1 ? c.urls[0] : c.urls.slice() };
      if (c.username) s.username = c.username;
      if (c.credential) s.credential = c.credential;
      return { iceServers: DEFAULT_STUN.concat([s]), provider: 'manual' };
    }
    if (fresh(cache)) return { iceServers: DEFAULT_STUN.concat(cache.servers), provider: c.provider };
    if (failAt && now() - failAt < FAIL_BACKOFF) return fallback(c, failErr);
    if (!inflight) {
      const g = gen;
      inflight = retry(() => (c.provider === 'metered' ? fetchMetered(c) : fetchCloudflare(c))).then((r) => {
        if (g === gen) { cache = r; failAt = 0; failErr = null; }
      }, (e) => {
        if (g === gen) { failAt = now(); failErr = e instanceof SyntaxError ? ek('e.turn.unreadable', null, 'Balasan penyedia TURN tidak terbaca') : (e && e.message ? e : ek('e.turn.fetchFail', null, 'gagal mengambil kredensial')); }
      }).then(() => { if (g === gen) inflight = null; });
    }
    const wait = inflight;
    await wait;
    if (failAt) return fallback(c, failErr || ek('e.turn.fetchFail', null, 'gagal mengambil kredensial')); // gagal memperbarui: kredensial lama yang masih berlaku tetap dipakai, tapi alasannya dilaporkan
    if (cache && cache.until > now()) return { iceServers: DEFAULT_STUN.concat(cache.servers), provider: c.provider };
    return fallback(c, ek('e.turn.fetchFail', null, 'gagal mengambil kredensial'));
  }
  function fallback(c, e) {
    const err = errText(e); // diterjemahkan ke bahasa aktif sekarang
    if (cache && cache.until > now()) return { iceServers: DEFAULT_STUN.concat(cache.servers), provider: c.provider, err }; // kredensial lama masih berlaku
    return { iceServers: DEFAULT_STUN.slice(), provider: c.provider, err };
  }

  return { set, get, ice, info: () => publicInfo(cfg) };
}

module.exports = { createTurn, normalize, publicInfo, cleanList, DEFAULT_STUN, CF_TTL, CF_MIN_LEFT, METERED_TTL, FAIL_BACKOFF };
