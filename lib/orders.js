'use strict';
// Comenzile plătite (analiza aprofundată): Stripe confirmă plata înainte de generare.
// Confirmarea vine pe trei căi, toate idempotente: întoarcerea vizitatorului de pe pagina de plată, webhook-ul
// Stripe (dacă e configurat) și o verificare periodică a comenzilor în așteptare (dacă vizitatorul închide
// fereastra imediat după plată). Dacă previziunea eșuează sau oracolul refuză întrebarea, banii se returnează.
//
// Stările unei comenzi: pending → paid → done | refunded | refund_failed; sau pending → expired.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const jobs = require('./jobs');
const payments = require('./payments');
const operations = require('./operations');
const events = require('./events');
const { t } = require('./messages');
const mail = require('./mail');
const legal = require('./legal');
const privacy = require('./privacy');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'orders');
const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
const REFUND_MAX_ATTEMPTS = 5;
const REFUND_RETRY_MS = 2 * 60000;

const orders = new Map();
const starting = new Set(); // comenzi în curs de pornire (împotriva confirmărilor simultane)
const refunding = new Map(); // o singură restituire în curs per comandă
let reconciling = false;

function init() {
  fs.mkdirSync(DIR, { recursive: true });
  orders.clear();
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      orders.set(o.id, o);
    } catch (e) {
      console.warn(`[orders] ignor ${f}: ${e.message}`);
    }
  }
}

function save(o) {
  o.updatedAt = new Date().toISOString();
  orders.set(o.id, o);
  const file = path.join(DIR, `${o.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(o, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

const get = (id) => (ID_RE.test(String(id)) ? orders.get(id) || null : null);

/** Ce vede vizitatorul despre comanda lui. */
function deliveryStatus(o) {
  if (o.refundReason === 'delivery_failed') return 'delivery_failed';
  if (o.emailSentAt && o.status === 'done') return 'delivered';
  if (o.status !== 'done') return null;
  return (o.emailAttempts || 0) >= 3 ? 'delivery_failed' : 'email_pending';
}
const publicStatus = (o) => ({ deliveryStatus: deliveryStatus(o), status: o.status, predictionId: o.predictionId || null,
  ...(o.refundReason === 'declined' ? { declined: true } : {}) });

/**
 * Creează comanda și pagina de plată. Limitele (cereri pe oră, coadă) se verifică ÎNAINTE de plată,
 * ca nimeni să nu plătească pentru o previziune pe care n-o putem porni. `upgradeOf`: previziunea rapidă
 * de la care s-a cerut analiza aprofundată (la anularea plății, vizitatorul revine la ea).
 */
async function create(request, ui, ip, baseUrl, email = null, privateScope = null, { upgradeOf = null } = {}) {
  jobs.precheck(ip, ui, { ignoreBudget: true });
  jobs.reserveCheckout(ip, ui);
  const now = new Date().toISOString();
  const o = {
    id: crypto.randomBytes(15).toString('base64url'),
    createdAt: now,
    request, ui, status: 'pending', baseUrl,
    email, // adresa din formular, unde trimitem previziunea
    amountCents: payments.PRICE_CENTS,
    // Acordul cu termenii și cererea de furnizare imediată (pierderea dreptului de retragere), bifate în formular.
    consent: { at: now, terms: legal.VERSION },
  };
  if (upgradeOf) o.upgradeOf = upgradeOf;
  if (request.private) o.privateScope = privateScope || privacy.newScope();
  const { url, session } = await payments.createCheckout(o, baseUrl);
  o.session = session;
  save(o);
  operations.count('checkout');
  return { orderId: o.id, checkoutUrl: url };
}

/** Verifică plata comenzii și, dacă e plătită, pornește previziunea. Sigură la apeluri repetate. */
async function confirm(id) {
  const o = get(id);
  if (!o) return null;
  if (o.status !== 'pending') return publicStatus(o);
  const { paid, paymentIntent, expired, email } = await payments.checkPaid(o);
  // Între timp, webhook-ul sau altă confirmare poate să fi pornit deja comanda.
  if (o.status !== 'pending') return publicStatus(o);
  if (paid) {
    o.paymentIntent = paymentIntent;
    if (email && !o.email) o.email = email; // de la Stripe, doar dacă formularul n-a dat una
    start(o);
  } else if (expired) {
    o.status = 'expired';
    save(o);
  }
  return publicStatus(o);
}

/** Pornește previziunea pentru o comandă plătită (o singură dată). */
function start(o) {
  if (starting.has(o.id) || (o.status !== 'pending' && o.status !== 'paid')) return;
  starting.add(o.id);
  try {
    if (o.status === 'pending') {
      o.status = 'paid';
      o.paidAt = new Date().toISOString();
      operations.count('paid');
      events.log('payment', { orderId: o.id, amountCents: o.amountCents });
    }
    // Comenzile private vechi primesc un spațiu propriu, fără a reutiliza cache-ul privat global.
    if (o.request.private && !o.privateScope) o.privateScope = privacy.newScope();
    // Păstrăm plata înainte de pornirea lucrării; după restart se recuperează și fără predictionId.
    save(o);
    const res = jobs.submit(o.request, null, o.ui, { paid: true, privateScope: o.privateScope, onSettled: (outcome) => settled(o.id, outcome) });
    o.predictionId = res.id;
    if (res.cached) o.status = 'done';
    save(o);
    if (res.cached) notify(o);
  } finally {
    starting.delete(o.id);
  }
}

/** La finalul previziunii: comanda e gata, sau banii se returnează (eroare sau întrebare refuzată). */
async function settled(id, outcome) {
  const o = get(id);
  if (!o || o.status !== 'paid') return '';
  if (outcome.ok && !outcome.rec.prediction.declined) {
    o.predictionId = outcome.rec.id;
    o.status = 'done';
    save(o);
    await notify(o);
    return '';
  }
  const reason = outcome.ok ? 'declined' : 'failed';
  const ok = await refundOrder(o, reason);
  if (ok) return t('refunded', o.ui);
  return t(o.status === 'refund_pending' ? 'refundPending' : 'refundFailed', o.ui);
}

/** Actualizează și pagina refuzului după o restituire recuperată sau reîncercată. */
function markRefunded(o) {
  const rec = store.get(o.predictionId);
  if (rec?.prediction.declined && !rec.meta.refunded) {
    rec.meta.refunded = true;
    store.update(rec);
  }
}

async function refundOrder(o, reason, now = Date.now()) {
  if (refunding.has(o.id)) return refunding.get(o.id);
  const task = performRefund(o, reason, now);
  refunding.set(o.id, task);
  try {
    return await task;
  } finally {
    refunding.delete(o.id);
  }
}

async function performRefund(o, reason, now) {
  const attempts = (o.refundAttempts || 0) + 1;
  // Persistăm intenția înaintea apelului: o întrerupere în timpul restituirii se reia cu aceeași
  // cheie de idempotency Stripe, fără să pornească din nou previziunea.
  Object.assign(o, {
    status: 'refund_failed', refundReason: reason, refundAttempts: attempts,
    refundAttemptAt: new Date(now).toISOString(),
    refundNextAttemptAt: attempts < REFUND_MAX_ATTEMPTS
      ? new Date(now + REFUND_RETRY_MS * 2 ** (attempts - 1)).toISOString() : null,
  });
  save(o);
  let r;
  try {
    r = await payments.refund(o);
  } catch (e) {
    o.error = String(e?.message || e).slice(0, 300);
    save(o);
    console.error(`[order ${o.id}] restituirea a eșuat:`, e?.message || e);
    events.log('error', { where: 'refund', id: o.id, message: o.error });
    return false;
  }
  return applyRefund(o, r, now);
}

async function refreshRefund(orderId, refundId, now = Date.now()) {
  const o = get(orderId);
  if (!o || o.refundId !== refundId || !refundId) return;
  const previous = o.refundProviderStatus;
  const refund = await payments.getRefund(refundId);
  // Alte confirmări pot sosi în timpul citirii Stripe.
  if (o.refundProviderStatus !== previous || o.refundProviderStatus === refund.status) return;
  applyRefund(o, refund, now);
}

async function finishRecoveredJob(id, outcome) {
  for (const order of orders.values()) {
    if (order.predictionId === id && order.status === 'paid') await settled(order.id, outcome);
  }
}

function applyRefund(o, r, now) {
  o.refundId = r.id;
  o.refundProviderStatus = r.status || 'unknown';
  if (r.status !== 'succeeded') {
    const terminal = ['failed', 'canceled'].includes(r.status);
    o.status = terminal ? 'refund_failed' : 'refund_pending';
    o.refundNextAttemptAt = null;
    if (terminal) o.refundAttempts = REFUND_MAX_ATTEMPTS;
    save(o);
    return false;
  }
  if (o.refundReason === 'delivery_failed') o.emailAttempts = 0; // buget separat pentru notificarea restituirii
  Object.assign(o, { status: 'refunded', refundedAt: new Date(now).toISOString(), refundId: r.id, refundNextAttemptAt: null });
  delete o.error;
  save(o);
  markRefunded(o);
  events.log('refund', { orderId: o.id, reason: o.refundReason });
  notify(o);
  return true;
}

/**
 * Trimite clientului emailul potrivit: linkul previziunii (comandă livrată) sau anunțul de restituire.
 * O singură dată per comandă; dacă trimiterea eșuează, verificarea periodică reîncearcă (de cel mult 3 ori).
 */
async function notify(o) {
  if (!o.email || o.emailSentAt || (o.emailAttempts || 0) >= 3) return;
  if (o.status !== 'done' && o.status !== 'refunded') return;
  if (sending.has(o.id)) return;
  sending.add(o.id);
  try {
    o.emailAttempts = (o.emailAttempts || 0) + 1;
    if (o.status === 'done') {
      const rec = store.get(o.predictionId);
      if (!rec) throw new Error('Rezultatul pentru livrare lipsește.');
      await mail.sendReady(o, rec, o.baseUrl || process.env.BASE_URL || 'https://nostradamus.my');
    } else {
      await mail.sendRefund(o, payments.priceLabel());
    }
    o.emailSentAt = new Date().toISOString();
    if (o.status === 'done') operations.count('delivered');
    events.log('email', { orderId: o.id, kind: o.status === 'done' ? 'ready' : 'refund' });
  } catch (e) {
    console.error(`[order ${o.id}] emailul nu a putut fi trimis:`, e?.message || e);
    events.log('error', { where: 'email', id: o.id, message: String(e?.message || e).slice(0, 300) });
  } finally {
    sending.delete(o.id);
    save(o);
  }
}
const sending = new Set();

/**
 * Verificarea periodică: comenzile în așteptare plătite fără întoarcere pe site pornesc acum; cele plătite
 * a căror previziune s-a pierdut (de ex. la o repornire a serverului în timpul lucrului) sunt reluate.
 */
async function reconcile(now = Date.now()) {
  if (reconciling || stopping) return;
  reconciling = true;
  let finish;
  passDone = new Promise((resolve) => { finish = resolve; });
  try {
    for (const o of [...orders.values()]) {
      try {
        if (o.status === 'pending') {
          // Chiar și după o întrerupere lungă verificăm Stripe înainte de a expira comanda.
          await confirm(o.id);
        } else if (o.status === 'paid') {
          const rec = store.get(o.predictionId);
          const job = jobs.get(o.predictionId);
          if (rec) {
            await settled(o.id, { ok: true, rec });
          } else if (job?.status === 'error') {
            await settled(o.id, { ok: false });
          } else if (!job || job.status === 'done') {
            console.warn(`[order ${o.id}] previziunea ${o.predictionId || '(nepornită)'} s-a pierdut; o reiau`);
            start(o);
          }
        } else if (o.status === 'refund_pending') {
          await refreshRefund(o.id, o.refundId, now);
        } else if (o.status === 'refund_failed' && (o.refundAttempts || 0) < REFUND_MAX_ATTEMPTS
          && (!o.refundNextAttemptAt || Date.parse(o.refundNextAttemptAt) <= now)) {
          await refundOrder(o, o.refundReason || 'failed', now);
        } else if (o.status === 'refunded') {
          markRefunded(o);
          await notify(o);
        } else if (o.status === 'done' && o.email && !o.emailSentAt) {
          await notify(o);
          if (!sending.has(o.id) && deliveryStatus(o) === 'delivery_failed') await refundOrder(o, 'delivery_failed', now);
        }
      } catch (e) {
        console.error(`[order ${o.id}] verificare eșuată:`, e?.message || e);
      }
    }
  } finally {
    reconciling = false;
    finish();
  }
}

let stopping = false;
let passDone = Promise.resolve();
const timers = [];

function startReconciler() {
  if (payments.mode() === 'off') return;
  timers.push(setTimeout(() => reconcile().catch(() => {}), 15000).unref());
  timers.push(setInterval(() => reconcile().catch(() => {}), 120000).unref());
}

/** La oprirea serviciului: fără verificări noi; trecerea în curs (Stripe, emailuri) se termină și se salvează. */
function stopReconciler() {
  stopping = true;
  timers.splice(0).forEach(clearTimeout);
  return reconciling ? passDone : Promise.resolve();
}

/** Rezumat pentru administrare. */
function summary() {
  const list = [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const count = (s) => list.filter((o) => o.status === s).length;
  const paid = list.filter((o) => ['paid', 'done', 'refunded', 'refund_failed', 'refund_pending'].includes(o.status));
  const utcDay = new Date().toISOString().slice(0, 10);
  const checkoutToday = { total: list.filter(o => o.createdAt.startsWith(utcDay)).length, paid: paid.filter(o => o.createdAt.startsWith(utcDay)).length };
  const refunded = list.filter((o) => o.status === 'refunded');
  const cents = paid.reduce((a, o) => a + (o.amountCents || 0), 0) - refunded.reduce((a, o) => a + (o.amountCents || 0), 0);
  return {
    checkoutToday, mode: payments.mode(), price: payments.priceLabel(), revenueEur: cents / 100,
    paid: paid.length, refunded: refunded.length, refundFailed: count('refund_failed'),
    refundNeedsAttention: list.filter((o) => o.status === 'refund_failed' && (o.refundAttempts || 0) >= REFUND_MAX_ATTEMPTS).length,
    pending: count('pending'), expired: count('expired'), recent: list.slice(0, 30),
    emailsSent: list.filter((o) => o.emailSentAt).length, emailsFailed: list.filter((o) => o.email && !o.emailSentAt && (o.emailAttempts || 0) >= 3).length,
  };
}

module.exports = { refreshRefund, finishRecoveredJob, deliveryStatus, init, create, confirm, get, reconcile, startReconciler, stopReconciler, summary, _orders: orders };
