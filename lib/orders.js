'use strict';
// Comenzile plătite: vizitatorul plătește pe Stripe, iar previziunea pornește doar după confirmarea plății.
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
const events = require('./events');
const { t } = require('./messages');
const mail = require('./mail');
const legal = require('./legal');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'orders');
const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
const PENDING_TTL = 75 * 60000; // pagina de plată Stripe expiră după o oră

const orders = new Map();
const starting = new Set(); // comenzi în curs de pornire (împotriva confirmărilor simultane)

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
const publicStatus = (o) => ({ status: o.status, predictionId: o.predictionId || null });

/**
 * Creează comanda și pagina de plată. Limitele (buget, cereri pe oră) se verifică ÎNAINTE de plată,
 * ca nimeni să nu plătească pentru o previziune pe care n-o mai putem face azi.
 */
async function create(request, ui, ip, baseUrl) {
  jobs.precheck(ip, ui, { ignoreBudget: true }); // plata acoperă costul: bugetul zilnic nu o oprește
  const now = new Date().toISOString();
  const o = {
    id: crypto.randomBytes(15).toString('base64url'),
    createdAt: now,
    request, ui, status: 'pending', baseUrl,
    amountCents: payments.PRICE_CENTS,
    // Acordul cu termenii și cererea de furnizare imediată (pierderea dreptului de retragere), bifate în formular.
    consent: { at: now, terms: legal.VERSION },
  };
  const { url, session } = await payments.createCheckout(o, baseUrl);
  o.session = session;
  save(o);
  return { orderId: o.id, checkoutUrl: url };
}

/** Verifică plata comenzii și, dacă e plătită, pornește previziunea. Sigură la apeluri repetate. */
async function confirm(id) {
  const o = get(id);
  if (!o) return null;
  if (o.status !== 'pending') return publicStatus(o);
  const { paid, paymentIntent, expired, email } = await payments.checkPaid(o);
  if (paid) {
    o.paymentIntent = paymentIntent;
    if (email) o.email = email;
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
      events.log('payment', { orderId: o.id, amountCents: o.amountCents });
    }
    const res = jobs.submit(o.request, null, o.ui, { paid: true, onSettled: (outcome) => settled(o.id, outcome) });
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
    notify(o);
    return '';
  }
  const reason = outcome.ok ? 'declined' : 'failed';
  const ok = await refundOrder(o, reason);
  if (outcome.ok) {
    // Previziunea refuzată rămâne vizibilă, cu mențiunea că plata a fost returnată.
    outcome.rec.meta.refunded = ok;
    store.update(outcome.rec);
  }
  return t(ok ? 'refunded' : 'refundFailed', o.ui);
}

async function refundOrder(o, reason) {
  try {
    const r = await payments.refund(o);
    Object.assign(o, { status: 'refunded', refundedAt: new Date().toISOString(), refundReason: reason, refundId: r.id });
    save(o);
    events.log('refund', { orderId: o.id, reason });
    notify(o);
    return true;
  } catch (e) {
    Object.assign(o, { status: 'refund_failed', refundReason: reason, error: String(e?.message || e).slice(0, 300) });
    save(o);
    console.error(`[order ${o.id}] restituirea a eșuat:`, e?.message || e);
    events.log('error', { where: 'refund', id: o.id, message: o.error });
    return false;
  }
}

/**
 * Trimite clientului emailul potrivit: linkul previziunii (comandă livrată) sau anunțul de restituire.
 * O singură dată per comandă; dacă trimiterea eșuează, verificarea periodică reîncearcă (de cel mult 3 ori).
 */
async function notify(o) {
  if (!o.email || o.emailSentAt || (o.emailAttempts || 0) >= 3 || !mail.configured()) return;
  if (o.status !== 'done' && o.status !== 'refunded') return;
  if (sending.has(o.id)) return;
  sending.add(o.id);
  try {
    o.emailAttempts = (o.emailAttempts || 0) + 1;
    if (o.status === 'done') {
      const rec = store.get(o.predictionId);
      if (!rec) return;
      await mail.sendReady(o, rec, o.baseUrl || process.env.BASE_URL || 'https://nostradamus.my');
    } else {
      await mail.sendRefund(o, payments.priceLabel());
    }
    o.emailSentAt = new Date().toISOString();
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
  for (const o of [...orders.values()]) {
    try {
      if (o.status === 'pending') {
        if (now - Date.parse(o.createdAt) > PENDING_TTL) {
          o.status = 'expired';
          save(o);
        } else {
          await confirm(o.id);
        }
      } else if (o.status === 'paid' && o.predictionId && !jobs.get(o.predictionId) && !store.get(o.predictionId)) {
        console.warn(`[order ${o.id}] previziunea ${o.predictionId} s-a pierdut; o reiau`);
        start(o);
      } else if ((o.status === 'done' || o.status === 'refunded') && o.email && !o.emailSentAt) {
        await notify(o); // emailuri care nu au plecat la prima încercare
      }
    } catch (e) {
      console.error(`[order ${o.id}] verificare eșuată:`, e?.message || e);
    }
  }
}

function startReconciler() {
  if (payments.mode() === 'off') return;
  setTimeout(() => reconcile().catch(() => {}), 15000).unref();
  setInterval(() => reconcile().catch(() => {}), 120000).unref();
}

/** Rezumat pentru administrare. */
function summary() {
  const list = [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const count = (s) => list.filter((o) => o.status === s).length;
  const paid = list.filter((o) => ['paid', 'done', 'refunded', 'refund_failed'].includes(o.status));
  const refunded = list.filter((o) => o.status === 'refunded');
  const cents = paid.reduce((a, o) => a + (o.amountCents || 0), 0) - refunded.reduce((a, o) => a + (o.amountCents || 0), 0);
  return {
    mode: payments.mode(), price: payments.priceLabel(), revenueEur: cents / 100,
    paid: paid.length, refunded: refunded.length, refundFailed: count('refund_failed'),
    pending: count('pending'), expired: count('expired'), recent: list.slice(0, 30),
    emailsSent: list.filter((o) => o.emailSentAt).length, emailsFailed: list.filter((o) => o.email && !o.emailSentAt && (o.emailAttempts || 0) >= 3).length,
  };
}

module.exports = { init, create, confirm, get, reconcile, startReconciler, summary, _orders: orders };
