'use strict';
// Pembantu tes: menjalankan halaman pembungkus Capacitor (mobile/shell/index.html) di vm dengan Capacitor palsu.
//   const { env } = require('./_mobilewrap');
//   const e = await env((plug, act, args) => ({ value: 'ok' }), { port: 4321, token: 'tok', dxout: '/data/x' });
//   await e.post({ archne: 'native', action: 'mic', id: 1 });   // pesan dari iframe
//   e.sent() -> pesan yang diteruskan ke iframe: [[data, origin], ...]; e.calls -> panggilan plugin: [{ plug, act, args }, ...]
// behave(plug, act, args) boleh mengembalikan nilai/Promise atau melempar (= janji ditolak). opts.noplugins: plugin lokal tidak terdaftar.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'shell', 'index.html'), 'utf8');
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const ORIGIN = (port) => 'http://127.0.0.1:' + port;

async function env(behave, ready, opts) {
  opts = opts || {};
  behave = behave || (() => ({ value: 'ok' }));
  const info = Object.assign({ port: 4321, token: 'tok' }, ready || {});
  const calls = [], listeners = {}, timers = [], intervals = [], store = {}, winListeners = [];
  const frameWin = { posted: [], postMessage(m, o) { frameWin.posted.push(JSON.parse(JSON.stringify([m, o]))); } };
  const frame = { style: {}, contentWindow: frameWin, src: '' };
  const msg = { style: {}, textContent: '' };
  const local = (p) => new Proxy({}, { get: (_, m) => (a) => { calls.push({ plug: p, act: m, args: JSON.parse(JSON.stringify(a || {})) }); return behave(p, m, a); } });
  const plugins = {
    Nodejs: { addListener: async (n, f) => { listeners[n] = f; }, send: async () => {} },
    App: { addListener: async (n, f) => { listeners['app:' + n] = f; } },
    Browser: { open: async (o) => { calls.push({ plug: 'Browser', act: 'open', args: o }); } },
  };
  if (!opts.noplugins) for (const p of ['ArchneBackground', 'ArchneAudio', 'ArchneDownloads']) plugins[p] = local(p);
  const ctx = {
    console, Date, Promise, JSON, Array, String, Number, isFinite, RegExp, Object,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
    setInterval: (f, ms) => { intervals.push({ f, ms }); return intervals.length; }, clearInterval(i) { if (intervals[i - 1]) intervals[i - 1].dead = true; },
    document: { getElementById: (id) => (id === 'f' ? frame : msg), documentElement: {}, write() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    window: null, open() {},
  };
  ctx.window = ctx;
  ctx.Capacitor = { Plugins: plugins, registerPlugin: () => null };
  ctx.addEventListener = (t, f) => { if (t === 'message') winListeners.push(f); };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  listeners.message({ eventName: 'archne:ready', args: [info] }); await flush();
  const origin = ORIGIN(info.port);
  const post = async (data, over) => { for (const f of winListeners) f(Object.assign({ origin, source: frameWin, data }, over || {})); await flush(); };
  return { post, flush, calls, listeners, timers, intervals, store, frame, frameWin, msg, origin, sent: () => frameWin.posted, plug: (p) => calls.filter((c) => c.plug === p) };
}

module.exports = { env, flush, html };
