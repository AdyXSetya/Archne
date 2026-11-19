'use strict';
// Broker MQTT palsu di memori untuk tes: subscribe (wildcard "+"), publish, retained, Last Will pada putus mendadak, end().
// Cukup untuk antarmuka mqtt.js yang dipakai renderer/archne-wan.js: connect(url, opts) -> client { on, subscribe, publish, end }.
const match = (filter, topic) => {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) { if (f[i] === '#') return true; if (i >= t.length) return false; if (f[i] !== '+' && f[i] !== t[i]) return false; }
  return f.length === t.length;
};
class FakeBroker {
  constructor() { this.clients = new Set(); this.retained = new Map(); this.log = []; }
  get mqtt() { return { connect: (url, o) => new FakeClient(this, url, o) }; }
  _deliver(topic, payload, retain, from) {
    this.log.push({ topic, payload, retain });
    if (retain) { if (payload === '' || payload === null) this.retained.delete(topic); else this.retained.set(topic, payload); }
    for (const c of this.clients) if (c.connected && c !== from || (c === from && c.connected)) c._offer(topic, payload);
  }
}
class FakeClient {
  constructor(broker, url, o) {
    this.b = broker; this.url = url; this.o = o || {}; this.L = {}; this.subs = []; this.connected = false; this.ended = false;
    setImmediate(() => { if (this.ended) return; this.connected = true; broker.clients.add(this); this._emit('connect'); });
  }
  on(k, f) { (this.L[k] = this.L[k] || []).push(f); return this; }
  _emit(k, ...a) { (this.L[k] || []).forEach((f) => f(...a)); }
  _offer(topic, payload) { if (this.subs.some((s) => match(s, topic))) setImmediate(() => { if (this.connected) this._emit('message', topic, Buffer.from(payload, 'utf8')); }); }
  subscribe(topics, opts, cb) {
    if (typeof opts === 'function') { cb = opts; }
    const arr = Array.isArray(topics) ? topics : [topics];
    this.subs.push(...arr);
    setImmediate(() => { // retained dikirim saat subscribe
      for (const [t, p] of this.b.retained) if (arr.some((s) => match(s, t))) this._offer(t, p);
      cb && cb(null);
    });
  }
  publish(topic, payload, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    setImmediate(() => { if (!this.connected) return cb && cb(new Error('tidak tersambung')); this.b._deliver(topic, String(payload), !!(opts && opts.retain), this); cb && cb(null); });
  }
  // putus mendadak (jaringan mati): broker menyiarkan Last Will
  drop() {
    if (!this.connected) return;
    this.connected = false; this.b.clients.delete(this);
    const w = this.o.will; if (w) this.b._deliver(w.topic, String(w.payload), !!w.retain, null);
    this._emit('close');
  }
  end(force, o, cb) { // putus rapi: Last Will TIDAK disiarkan
    if (typeof force === 'function') cb = force;
    this.ended = true; const was = this.connected; this.connected = false; this.b.clients.delete(this);
    if (was) this._emit('close');
    cb && setImmediate(cb);
  }
}
module.exports = { FakeBroker, match };
