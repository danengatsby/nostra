'use strict';
// Cererile de previziune rulează ca „lucrări” în fundal: pagina se poate reconecta oricând la fluxul de
// progres, iar previziunea se termină și se salvează chiar dacă utilizatorul închide fereastra.
// Tot aici sunt limitele de cost: bugetul zilnic în dolari, cereri pe oră per vizitator, câte simultan.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const store = require('./store');
const cost = require('./cost');
const { HORIZON } = require('./catalog');
const { runOracle, friendlyError } = require('./oracle');
const { t } = require('./messages');
const events = require('./events');

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
const hits = new Map(); // hash IP -> [timestamp-uri]

const ipKey = (ip) => crypto.createHash('sha256').update(`nostra:${ip}`).digest('base64url').slice(0, 16);

class LimitError extends Error {
  constructor(message, status = 429) { super(message); this.status = status; }
}

/** Câte previziuni au pornit și nu s-au terminat încă (costul lor nu e încă în registru). */
const pending = () => [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;

/**
 * Verifică limitele (cereri pe oră, buget, coadă). Cu `consume`, cererea se și numără pentru vizitator;
 * fără, e doar o verificare — folosită înainte de plată, ca nimeni să nu plătească pentru o cerere refuzată.
 */
function checkLimits(ip, ui, consume = true) {
  const now = Date.now();
  const k = ipKey(ip);
  const list = (hits.get(k) || []).filter((t) => now - t < 3600000);
  hits.set(k, list);
  if (list.length >= cfg.perHour) {
    const mins = Math.ceil((3600000 - (now - list[0])) / 60000);
    throw new LimitError(t('perHour', ui, cfg.perHour, mins));
  }
  const est = cost.estimate();
  if (!cost.canSpend(est, pending() * est)) throw new LimitError(t('tired', ui));
  if (cost.status().predictions + pending() >= cfg.perDay) throw new LimitError(t('tired', ui));
  if (queue.length >= cfg.maxQueue) throw new LimitError(t('queueFull', ui), 503);
  if (!consume) return null;
  list.push(now);
  return { key: k, at: now };
}

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
  const key = store.cacheKey(req);
  const cached = cfg.cache ? store.findCached(key, HORIZON[req.horizon].cacheHours) : null;
  if (cached) return { id: cached.id, cached: true };

  // Aceeași cerere rulează deja? Atașăm utilizatorul la ea în loc s-o repetăm.
  for (const job of jobs.values()) {
    if (job.key === key && (job.status === 'queued' || job.status === 'running')) {
      if (opts.onSettled) job.listeners.push(opts.onSettled);
      return { id: job.id, cached: false };
    }
  }

  const ticket = opts.paid ? null : checkLimits(ip, ui);
  const job = {
    id: store.newId(), key, req, ui, ticket, paid: !!opts.paid, listeners: opts.onSettled ? [opts.onSettled] : [],
    status: 'queued', events: [], bus: new EventEmitter(), createdAt: new Date().toISOString(),
  };
  job.bus.setMaxListeners(100);
  jobs.set(job.id, job);
  queue.push(job);
  push(job, 'status', { phase: 'queued', position: queue.length });
  pump();
  return { id: job.id, cached: false };
}

function push(job, type, data) {
  const ev = { type, data };
  if (type !== 'done') job.events.push(ev); // rezultatul final se trimite separat, din fișier
  if (job.events.length > 300) job.events.splice(1, 1);
  job.bus.emit('event', ev);
}

function pump() {
  while (running < cfg.concurrent && queue.length) {
    const job = queue.shift();
    running++;
    run(job).finally(() => {
      running--;
      setTimeout(() => jobs.delete(job.id), 3600000).unref();
      queue.forEach((j, i) => push(j, 'status', { phase: 'queued', position: i + 1 }));
      pump();
    });
  }
}

async function run(job) {
  job.status = 'running';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const started = Date.now();
  try {
    const { prediction, meta, rawText } = await runOracle(job.req, (type, data) => push(job, type, data), controller.signal);
    const usd = cost.costUsd(meta.usage);
    const rec = {
      id: job.id, key: job.key, createdAt: job.createdAt, request: job.req, prediction,
      meta: { ...meta, costUsd: usd, durationMs: Date.now() - started },
    };
    if (job.paid) rec.meta.paid = true;
    store.save(rec);
    if (rawText) store.saveRaw(job.id, rawText);
    cost.record(usd, 'prediction');
    job.status = 'done';
    console.log(`[job ${job.id}] gata în ${Math.round((Date.now() - started) / 1000)}s, cost ≈ $${usd.toFixed(3)}`, JSON.stringify(meta.usage || {}));
    events.log('prediction', { id: job.id, costUsd: usd, seconds: Math.round((Date.now() - started) / 1000), paid: job.paid });
    await settle(job, { ok: true, rec });
    push(job, 'done', { id: job.id });
  } catch (err) {
    job.status = 'error';
    const usd = cost.costUsd(err?.usage);
    if (usd > 0) cost.record(usd, 'failed');
    // Un refuz ține de întrebare; orice altă eroare e a noastră, deci cererea nu se consumă.
    if (!err?.userFacing) refund(job.ticket);
    console.error(`[job ${job.id}] eroare${usd ? ` (cost ≈ $${usd.toFixed(3)})` : ''}:`, err?.status || '', err?.message || err);
    events.log('error', { where: 'prediction', id: job.id, status: err?.status || null, message: String(err?.message || err).slice(0, 300), costUsd: usd, question: job.req.question.slice(0, 120) });
    const extra = (await settle(job, { ok: false, err })).filter(Boolean).join(' ');
    push(job, 'error', { message: [friendlyError(err, job.ui), extra].filter(Boolean).join(' ') });
  } finally {
    clearTimeout(timer);
  }
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
const precheck = (ip, ui) => checkLimits(ip, ui, false);

module.exports = { submit, get, precheck, LimitError, cfg, _reset: () => { hits.clear(); jobs.clear(); } };
