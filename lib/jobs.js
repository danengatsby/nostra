'use strict';
// Cererile de previziune rulează ca „lucrări” în fundal: pagina se poate reconecta oricând la fluxul de
// progres, iar previziunea se termină și se salvează chiar dacă utilizatorul închide fereastra.
// Tot aici sunt limitele de cost: bugetul zilnic în dolari, cereri pe oră per vizitator, câte simultan.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const store = require('./store');
const cost = require('./cost');
const { HORIZON, freeTier } = require('./catalog');
const { runOracle, friendlyError, LITE_MODEL } = require('./oracle');
const { t } = require('./messages');
const operations = require('./operations');
const events = require('./events');
const privacy = require('./privacy');

const cfg = {
  perHour: Number(process.env.RATE_PER_HOUR || 6),
  perDay: Number(process.env.DAILY_LIMIT || 300),
  concurrent: Number(process.env.MAX_CONCURRENT || 3),
  maxQueue: Number(process.env.MAX_QUEUE || 20),
  timeoutMs: Number(process.env.JOB_TIMEOUT_MS || 8 * 60000),
  cache: process.env.CACHE_ENABLED !== '0',
};

const jobs = new Map(); // id -> job (în memorie cât rulează + o oră după)
const queue = [];
let running = 0;
// La oprirea serviciului nu mai pornim lucrări noi; cele din coadă rămân în SQLite și se reiau la pornire.
let draining = false;
const idleWaiters = [];
const checkoutHits = new Map();
const hits = new Map(); // hash IP -> [timestamp-uri]

const ipKey = (ip) => crypto.createHash('sha256').update(`nostra:${ip}`).digest('base64url').slice(0, 16);

class LimitError extends Error {
  constructor(message, status = 429, code = null) { super(message); this.status = status; this.code = code; }
}

/** Câte previziuni au pornit și nu s-au terminat încă (costul lor nu e încă în registru). */
const pending = (tier = null) => [...jobs.values()]
  .filter((j) => (j.status === 'queued' || j.status === 'running') && (!tier || j.tier === tier)).length;

/**
 * Verifică limitele și alege modelul. Cu `liteOnly` (previziunea gratuită, FREE_TIER=lite) se folosește doar
 * modelul rapid, din bugetul lui. Altfel: cât mai e buget principal → 'main'; după aceea → 'lite'.
 * Mesajul „s-a odihnit” apare când nu mai e buget pentru niciun model permis.
 * Cu `consume`, cererea se și numără pentru vizitator; fără, e doar o verificare (înainte de plată).
 * `ignoreBudget`: previziunile plătite nu depind de buget (prețul acoperă costul). Întoarce { ticket, tier }.
 */
function checkLimits(ip, ui, consume = true, { ignoreBudget = false, liteOnly = false } = {}) {
  const now = Date.now();
  const k = ipKey(ip);
  const list = (hits.get(k) || []).filter((t) => now - t < 3600000);
  hits.set(k, list);
  if (list.length >= cfg.perHour) {
    const mins = Math.ceil((3600000 - (now - list[0])) / 60000);
    throw new LimitError(t('perHour', ui, cfg.perHour, mins));
  }
  if (queue.length >= cfg.maxQueue) throw new LimitError(t('queueFull', ui), 503);
  const est = cost.estimate();
  let tier = 'main';
  const day = cost.status();
  const tired = () => new LimitError(t('tired', ui), 429, 'tired');
  if (!ignoreBudget && (day.predictions || 0) + (day.fallbacks || 0) + pending() >= cfg.perDay) throw tired();
  if (!ignoreBudget && (liteOnly || !cost.canSpend(est, pending('main') * est))) {
    if (!cost.canSpendFallback(pending('lite') * cost.FALLBACK_ESTIMATE)) throw tired();
    tier = 'lite';
  }
  if (!consume) return { ticket: null, tier };
  list.push(now);
  return { ticket: { key: k, at: now }, tier };
}

function reserveCheckout(ip, ui) {
  const key = ipKey(ip);
  const now = Date.now();
  const recent = (checkoutHits.get(key) || []).filter(time => now - time < 3600000);
  const limit = Number(process.env.CHECKOUT_PER_HOUR || cfg.perHour);
  if (recent.length >= limit) throw new LimitError(ui === 'en' ? 'Checkout limit reached. Try again later.' : 'Ai atins limita de plăți inițiate. Reîncearcă mai târziu.');
  checkoutHits.set(key, [...recent, now]);
}

setInterval(() => {
  for (const table of [hits, checkoutHits]) for (const [key, times] of table) {
    if (!(times.at(-1) > Date.now() - 3600000)) table.delete(key);
  }
}, 60000).unref();

/** Dă înapoi vizitatorului cererea consumată, când eșecul nu e din cauza lui. */
function refund(ticket) {
  if (!ticket) return;
  const list = hits.get(ticket.key);
  const i = list ? list.indexOf(ticket.at) : -1;
  if (i >= 0) list.splice(i, 1);
}

/**
 * Pornește o previziune (sau o întoarce pe cea din cache). Rezultat: { id, cached }.
 * `ui` este limba interfeței, pentru mesajele de eroare (poate diferi de limba răspunsului).
 * `opts.paid`: cererea a fost plătită — nu mai trece prin limite (au fost verificate înainte de plată),
 * iar `opts.onSettled(outcome)` e anunțată la final: { ok: true, rec } sau { ok: false, err };
 * poate întoarce un text adăugat la mesajul de eroare (de ex. „plata a fost returnată”).
 */
function submit(req, ip, ui = req.lang, opts = {}) {
  // Fără o sesiune transmisă de server, fiecare cerere privată primește propriul spațiu de cache.
  const privateScope = req.private ? opts.privateScope || privacy.newScope() : null;
  const baseKey = store.cacheKey(req, privateScope);
  const hours = HORIZON[req.horizon].cacheHours;
  const cached = cfg.cache ? store.findCached(baseKey, hours) : null;
  if (cached) return { id: cached.id, cached: true };

  // Aceeași cerere rulează deja? Atașăm utilizatorul la ea în loc s-o repetăm.
  for (const job of jobs.values()) {
    if (job.paid === !!opts.paid && job.baseKey === baseKey && (job.status === 'queued' || job.status === 'running')) {
      if (opts.onSettled) job.listeners.push(opts.onSettled);
      return { id: job.id, cached: false };
    }
  }

  const { ticket, tier } = opts.paid ? { ticket: null, tier: 'main' } : checkLimits(ip, ui, true, { liteOnly: freeTier() === 'lite' });
  // Previziunile modelului de rezervă au cache separat, ca mâine cererea să primească analiza completă.
  const liteKey = `${baseKey}|lite`;
  if (tier === 'lite' && cfg.cache) {
    const liteCached = store.findCached(liteKey, hours);
    if (liteCached) { refund(ticket); return { id: liteCached.id, cached: true }; }
  }
  const job = {
    id: store.newId(), baseKey, key: tier === 'lite' ? liteKey : baseKey, tier,
    req, ui, ticket, privateScope, paid: !!opts.paid, listeners: opts.onSettled ? [opts.onSettled] : [],
    status: 'queued', events: [], bus: new EventEmitter(), createdAt: new Date().toISOString(),
  };
  operations.enqueue(job);
  schedule(job);
  pump();
  return { id: job.id, cached: false };
}

function schedule(job) {
  job.bus.setMaxListeners(100);
  jobs.set(job.id, job);
  queue.push(job);
  push(job, 'status', { phase: 'queued', position: queue.length });
}

function recover(onPaidSettled) {
  for (const saved of operations.backlog()) {
    if (store.get(saved.id)) { operations.finish(saved.id); continue; }
    if (jobs.has(saved.id)) continue;
    const listeners = saved.paid && onPaidSettled ? [outcome => onPaidSettled(saved.id, outcome)] : [];
    schedule({ ...saved, listeners, events: [], status: 'queued', bus: new EventEmitter(), ticket: null });
  }
  pump();
}

function push(job, type, data) {
  const ev = { type, data };
  if (type !== 'done') job.events.push(ev); // rezultatul final se trimite separat, din fișier
  if (job.events.length > 300) job.events.splice(1, 1);
  job.bus.emit('event', ev);
}

function pump() {
  while (!draining && running < cfg.concurrent && queue.length) {
    const job = queue.shift();
    running++;
    run(job).finally(() => {
      running--;
      setTimeout(() => jobs.delete(job.id), 3600000).unref();
      queue.forEach((j, i) => push(j, 'status', { phase: 'queued', position: i + 1 }));
      if (draining && running === 0) idleWaiters.splice(0).forEach((resolve) => resolve());
      pump();
    });
  }
}

/**
 * Oprirea fără pierderi: lucrările pornite (apeluri AI deja plătite) se termină, cele din coadă așteaptă
 * repornirea. Cererile noi se primesc în continuare și intră în coadă. Se rezolvă când nu mai rulează nimic.
 */
function drain() {
  draining = true;
  return running === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
}

const running_ = () => running;

async function run(job) {
  job.status = 'running';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const started = Date.now();
  const attempt = () => runOracle(job.req, (type, data) => push(job, type, data), controller.signal, { tier: job.tier });
  try {
    let result;
    try {
      result = await attempt();
    } catch (err) {
      if (!canFallBack(job, err)) throw err;
      // Modelul principal nu a răspuns (suprasolicitat, eroare de serviciu): încercăm modelul de rezervă.
      const lost = cost.costUsd(err?.usage);
      if (lost > 0) cost.record(lost, 'failed');
      console.warn(`[job ${job.id}] modelul principal a eșuat (${err?.status || err?.message}); trec pe modelul de rezervă`);
      events.log('error', { where: 'prediction-main', id: job.id, status: err?.status || null, message: String(err?.message || err).slice(0, 300), costUsd: lost, fallback: true });
      job.tier = 'lite';
      job.key = `${job.baseKey}|lite`;
      operations.enqueue(job);
      push(job, 'status', { phase: 'fallback' });
      result = await attempt();
    }
    const { prediction, meta, rawText } = result;
    const usd = cost.costUsd(meta.usage, meta.model);
    const rec = {
      id: job.id, key: job.key, createdAt: job.createdAt, request: job.req, prediction,
      meta: { ...meta, costUsd: usd, durationMs: Date.now() - started },
    };
    if (job.paid) rec.meta.paid = true;
    if (job.req.private) rec.privateScope = job.privateScope;
    store.save(rec);
    if (rawText) store.saveRaw(job.id, rawText);
    cost.record(usd, job.tier === 'lite' ? 'fallback' : 'prediction');
    job.status = 'done';
    console.log(`[job ${job.id}] gata în ${Math.round((Date.now() - started) / 1000)}s, cost ≈ $${usd.toFixed(3)}`, JSON.stringify(meta.usage || {}));
    events.log('prediction', { id: job.id, costUsd: usd, seconds: Math.round((Date.now() - started) / 1000), paid: job.paid });
    await settle(job, { ok: true, rec });
    push(job, 'done', { id: job.id });
  } catch (err) {
    job.status = 'error';
    const usd = cost.costUsd(err?.usage, job.tier === 'lite' ? LITE_MODEL : null);
    if (usd > 0) cost.record(usd, job.tier === 'lite' ? 'fallback_failed' : 'failed');
    // Un refuz ține de întrebare; orice altă eroare e a noastră, deci cererea nu se consumă.
    if (!err?.userFacing) refund(job.ticket);
    console.error(`[job ${job.id}] eroare${usd ? ` (cost ≈ $${usd.toFixed(3)})` : ''}:`, err?.status || '', err?.message || err);
    events.log('error', { where: 'prediction', id: job.id, status: err?.status || null, message: String(err?.message || err).slice(0, 300), costUsd: usd, question: job.req.question.slice(0, 120) });
    const extra = (await settle(job, { ok: false, err })).filter(Boolean).join(' ');
    push(job, 'error', { message: [friendlyError(err, job.ui), extra].filter(Boolean).join(' ') });
  } finally {
    clearTimeout(timer);
    operations.finish(job.id);
  }
}

/**
 * Se poate trece pe modelul de rezervă? Da, când modelul principal a dat o eroare de serviciu (nu un refuz și
 * nu depășirea timpului), previziunea nu e plătită (cele plătite se restituie) și mai e buget de rezervă.
 */
function canFallBack(job, err) {
  if (job.tier !== 'main' || job.paid || err?.userFacing) return false;
  if (err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError') return false;
  return cost.canSpendFallback(pending('lite') * cost.FALLBACK_ESTIMATE);
}

/** Anunță comenzile plătite atașate lucrării; întoarce textele lor suplimentare. Erorile lor nu opresc lucrarea. */
async function settle(job, outcome) {
  return Promise.all(job.listeners.map((fn) => Promise.resolve().then(() => fn(outcome)).catch((e) => {
    console.error(`[job ${job.id}] eroare la finalizarea comenzii:`, e?.message || e);
    return '';
  })));
}

const get = (id) => jobs.get(id) || null;

/** Verificarea limitelor înainte de plată (fără să consume cererea vizitatorului). */
const precheck = (ip, ui, opts) => checkLimits(ip, ui, false, opts);

module.exports = { reserveCheckout, recover, pending, submit, get, precheck, drain, running: running_, LimitError, cfg, _reset: () => { checkoutHits.clear(); hits.clear(); jobs.clear(); } };
