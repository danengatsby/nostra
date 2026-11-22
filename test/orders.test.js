'use strict';
// Recuperarea comenzilor folosește numai date temporare și servicii simulate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-recovery-'));
process.env.PAYMENT_DEMO = '1';
process.env.MAIL_CAPTURE = '1';
delete process.env.STRIPE_SECRET_KEY;

const store = require('../lib/store');
const orders = require('../lib/orders');
const jobs = require('../lib/jobs');
const payments = require('../lib/payments');
const mail = require('../lib/mail');
const admin = require('../lib/admin');

const ORDER_ID = 'recovery-order-0001';
const PREDICTION_ID = 'recoverypred1';
const request = { domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro', question: 'Recuperare?' };
const diskOrder = () => JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'orders', `${ORDER_ID}.json`), 'utf8'));

function loadOrder(extra = {}) {
  const o = {
    id: ORDER_ID, request, ui: 'ro', status: 'paid', paymentIntent: 'pi_recovery', amountCents: 100,
    predictionId: PREDICTION_ID, email: 'client@example.com', baseUrl: 'https://example.com',
    createdAt: new Date(Date.now() - 2 * 3600000).toISOString(), ...extra,
  };
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'orders', `${o.id}.json`), JSON.stringify(o));
  orders.init(); // reîncărcare de pe disc, ca după restart
  return orders.get(o.id);
}

function savePrediction(declined = false) {
  const rec = {
    id: PREDICTION_ID, key: store.cacheKey(request), request, createdAt: new Date().toISOString(),
    prediction: { declined, title: 'Rezultat recuperat', summary: 'Rezumat', predictions: [], scenarios: [] }, meta: {},
  };
  store.save(rec);
  return rec;
}

test.beforeEach(() => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'orders'), { recursive: true, force: true });
  fs.rmSync(path.join(process.env.DATA_DIR, 'predictions'), { recursive: true, force: true });
  store.init();
  orders.init();
  mail._sent.length = 0;
});
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('o comandă pending veche, plătită, se verifică și pornește după restart', async (t) => {
  loadOrder({ status: 'pending', predictionId: null, paymentIntent: null });
  const check = t.mock.method(payments, 'checkPaid', async () => ({ paid: true, paymentIntent: 'pi_late' }));
  const submit = t.mock.method(jobs, 'submit', () => {
    assert.equal(diskOrder().status, 'paid', 'plata este persistentă înainte să pornească lucrarea');
    assert.equal(diskOrder().paymentIntent, 'pi_late');
    return { id: PREDICTION_ID, cached: false };
  });
  await orders.reconcile();
  assert.equal(check.mock.callCount(), 1);
  assert.equal(submit.mock.callCount(), 1);
  assert.equal(diskOrder().status, 'paid');
  assert.equal(diskOrder().predictionId, PREDICTION_ID);
});

test('vechimea nu expiră comanda: numai confirmarea Stripe o poate expira', async (t) => {
  loadOrder({ status: 'pending', predictionId: null });
  const check = t.mock.method(payments, 'checkPaid', async () => ({ paid: false, expired: false }));
  await orders.reconcile();
  assert.equal(orders.get(ORDER_ID).status, 'pending');
  check.mock.mockImplementation(async () => ({ paid: false, expired: true }));
  await orders.reconcile();
  assert.equal(diskOrder().status, 'expired');
});

test('eroarea Stripe păstrează pending și permite o nouă reconciliere', async (t) => {
  loadOrder({ status: 'pending', predictionId: null });
  const check = t.mock.method(payments, 'checkPaid', async () => { throw new Error('Stripe indisponibil'); });
  await orders.reconcile();
  assert.equal(diskOrder().status, 'pending');
  check.mock.mockImplementation(async () => ({ paid: false, expired: true }));
  await orders.reconcile();
  assert.equal(diskOrder().status, 'expired');
});

test('rezultatul salvat finalizează paid și trimite emailul o singură dată', async (t) => {
  savePrediction();
  loadOrder();
  const submit = t.mock.method(jobs, 'submit', () => { throw new Error('Nu trebuie regenerat'); });
  await orders.reconcile();
  assert.equal(diskOrder().status, 'done');
  assert.equal(submit.mock.callCount(), 0);
  assert.equal(mail._sent.length, 1);
  assert.match(mail._sent[0].text, /\/p\/recoverypred1/);
  orders.init();
  await orders.reconcile();
  assert.equal(mail._sent.length, 1);
});

test('un refuz salvat declanșează restituirea după restart', async (t) => {
  savePrediction(true);
  loadOrder();
  const refund = t.mock.method(payments, 'refund', async () => ({ id: 're_declined', status: 'succeeded' }));
  const submit = t.mock.method(jobs, 'submit', () => { throw new Error('Nu trebuie regenerat'); });
  await orders.reconcile();
  assert.equal(refund.mock.callCount(), 1);
  assert.equal(submit.mock.callCount(), 0);
  assert.equal(diskOrder().status, 'refunded');
  assert.equal(diskOrder().refundReason, 'declined');
  assert.equal(store.get(PREDICTION_ID).meta.refunded, true);
  assert.equal(mail._sent.length, 1);
});

test('paid fără predictionId se poate relua, inclusiv după eroarea de pornire', async (t) => {
  loadOrder({ predictionId: null });
  const submit = t.mock.method(jobs, 'submit', () => { throw new Error('Pornire întreruptă'); });
  await orders.reconcile();
  assert.equal(diskOrder().status, 'paid');
  assert.equal(diskOrder().paymentIntent, 'pi_recovery');
  orders.init();
  submit.mock.mockImplementation(() => ({ id: PREDICTION_ID, cached: false }));
  await orders.reconcile();
  assert.equal(diskOrder().predictionId, PREDICTION_ID);
});

test('paid cu lucrare pierdută pornește o singură lucrare nouă', async (t) => {
  loadOrder();
  let job = null;
  t.mock.method(jobs, 'get', () => job);
  const submit = t.mock.method(jobs, 'submit', () => {
    job = { status: 'queued' };
    return { id: 'replacement1', cached: false };
  });
  await orders.reconcile();
  await orders.reconcile();
  job.status = 'running';
  await orders.reconcile();
  assert.equal(submit.mock.callCount(), 1);
  assert.equal(diskOrder().predictionId, 'replacement1');
});

test('lucrarea eșuată rămasă în memorie declanșează restituire', async (t) => {
  loadOrder();
  t.mock.method(jobs, 'get', () => ({ status: 'error' }));
  const refund = t.mock.method(payments, 'refund', async () => ({ id: 're_failed', status: 'succeeded' }));
  await orders.reconcile();
  assert.equal(refund.mock.callCount(), 1);
  assert.equal(diskOrder().status, 'refunded');
  assert.equal(diskOrder().refundReason, 'failed');
});

test('restituirile eșuate au întârziere persistentă și actualizează refuzul după succes', async (t) => {
  savePrediction(true);
  loadOrder();
  const refund = t.mock.method(payments, 'refund', async () => { throw new Error('Eroare temporară'); });
  await orders.reconcile();
  const first = diskOrder();
  assert.equal(first.status, 'refund_failed');
  assert.equal(first.refundAttempts, 1);
  assert.equal(Date.parse(first.refundNextAttemptAt) - Date.parse(first.refundAttemptAt), 120000);
  assert.equal(mail._sent.length, 0);
  orders.init();
  await orders.reconcile(Date.parse(first.refundNextAttemptAt) - 1);
  assert.equal(refund.mock.callCount(), 1, 'nu se reîncearcă înainte de termen');
  refund.mock.mockImplementation(async () => {
    assert.equal(diskOrder().refundAttempts, 2, 'încercarea este salvată înainte de apel');
    return { id: 're_retry', status: 'succeeded' };
  });
  await orders.reconcile(Date.parse(first.refundNextAttemptAt));
  assert.equal(diskOrder().status, 'refunded');
  assert.equal(diskOrder().refundId, 're_retry');
  assert.equal(diskOrder().refundNextAttemptAt, null);
  assert.equal(diskOrder().error, undefined);
  assert.equal(store.get(PREDICTION_ID).meta.refunded, true);
  assert.equal(mail._sent.length, 1);
  await orders.reconcile();
  assert.equal(refund.mock.callCount(), 2);
  assert.equal(mail._sent.length, 1);
});

test('după cinci restituiri eșuate se oprește automat și apare alerta de administrare', async (t) => {
  savePrediction(true);
  loadOrder();
  const refund = t.mock.method(payments, 'refund', async () => { throw new Error('Restituire imposibilă'); });
  await orders.reconcile();
  for (let attempt = 2; attempt <= 5; attempt++) {
    const next = Date.parse(diskOrder().refundNextAttemptAt);
    orders.init();
    await orders.reconcile(next);
    assert.equal(diskOrder().refundAttempts, attempt);
  }
  assert.equal(diskOrder().refundNextAttemptAt, null);
  orders.init();
  await orders.reconcile(Date.now() + 86400000);
  assert.equal(refund.mock.callCount(), 5);
  assert.equal(orders.summary().refundNeedsAttention, 1);
  let html;
  const res = { set() { return this; }, type() { return this; }, send(body) { html = body; } };
  admin.page({}, res);
  assert.match(html, /role="alert"/);
  assert.match(html, /1 restituiri necesită intervenție în Stripe/);
  assert.equal(mail._sent.length, 0);
});

test('restituirile vechi fără metadate se reîncearcă, iar cele deja restituite repară pagina refuzului', async (t) => {
  savePrediction(true);
  loadOrder({ status: 'refund_failed', refundReason: 'declined' });
  const refund = t.mock.method(payments, 'refund', async () => ({ id: 're_legacy', status: 'succeeded' }));
  await orders.reconcile();
  assert.equal(diskOrder().refundAttempts, 1);
  const rec = store.get(PREDICTION_ID);
  rec.meta.refunded = false;
  store.update(rec); // întrerupere după salvarea comenzii, înainte de actualizarea previziunii
  orders.init();
  await orders.reconcile();
  assert.equal(refund.mock.callCount(), 1);
  assert.equal(store.get(PREDICTION_ID).meta.refunded, true);
});

test('confirmările simultane nu pornesc de două ori și nu expiră o comandă deja plătită', async (t) => {
  loadOrder({ status: 'pending', predictionId: null });
  const pending = [];
  t.mock.method(payments, 'checkPaid', () => new Promise(resolve => pending.push(resolve)));
  const submit = t.mock.method(jobs, 'submit', () => ({ id: PREDICTION_ID, cached: false }));
  const a = orders.confirm(ORDER_ID);
  const b = orders.confirm(ORDER_ID);
  pending[0]({ paid: true, paymentIntent: 'pi_recovery' });
  await a;
  pending[1]({ paid: false, expired: true });
  await b;
  assert.equal(submit.mock.callCount(), 1);
  assert.equal(diskOrder().status, 'paid');
});

test('reconcilierea nu se suprapune cu sine sau cu restituirea lucrării', async (t) => {
  loadOrder({ status: 'pending', predictionId: null });
  t.mock.method(payments, 'checkPaid', async () => ({ paid: true, paymentIntent: 'pi_recovery' }));
  let settle;
  t.mock.method(jobs, 'submit', (_req, _ip, _ui, opts) => {
    settle = opts.onSettled;
    return { id: PREDICTION_ID, cached: false };
  });
  await orders.confirm(ORDER_ID);
  let finishRefund;
  const refund = t.mock.method(payments, 'refund', () => new Promise(resolve => { finishRefund = resolve; }));
  const result = settle({ ok: false });
  const a = orders.reconcile(Date.now() + 3600000);
  await orders.reconcile(Date.now() + 3600000);
  assert.equal(refund.mock.callCount(), 1);
  finishRefund({ id: 're_once', status: 'succeeded' });
  await Promise.all([result, a]);
  assert.equal(diskOrder().status, 'refunded');
  assert.equal(mail._sent.length, 1);
});

test('verificarea plății folosește prețul comenzii, chiar dacă prețul curent diferă', async () => {
  const o = loadOrder({ status: 'pending', amountCents: 250, session: 'cs_old_price' });
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  payments._setClient({ checkout: { sessions: { retrieve: async () => ({
    client_reference_id: ORDER_ID, amount_total: 250, currency: 'eur', payment_status: 'paid',
    status: 'complete', payment_intent: 'pi_recovery',
  }) } } });
  try {
    assert.equal((await payments.checkPaid(o)).paid, true);
    assert.equal((await payments.checkPaid({ ...o, amountCents: 100 })).paid, false);
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
    payments._setClient(null);
  }
});

test('restituirea pending se recitește după restart și devine finală numai la confirmare', async t => {
  savePrediction(true);
  loadOrder();
  t.mock.method(payments, 'refund', async () => ({ id: 're_pending', status: 'pending' }));
  await orders.reconcile();
  assert.equal(diskOrder().status, 'refund_pending');
  assert.equal(mail._sent.length, 0);
  orders.init();
  t.mock.method(payments, 'getRefund', async id => {
    assert.equal(id, 're_pending');
    return { id, status: 'succeeded' };
  });
  await orders.reconcile();
  assert.equal(diskOrder().status, 'refunded');
  assert.equal(mail._sent.length, 1);
});

test('după trei eșecuri SMTP ale rezultatului se restituie plata o singură dată', async t => {
  savePrediction();
  loadOrder({ status: 'done' });
  t.mock.method(mail, 'sendReady', async () => { throw new Error('SMTP indisponibil'); });
  const refund = t.mock.method(payments, 'refund', async () => ({ id: 're_mail', status: 'succeeded' }));
  for (let i = 0; i < 4; i++) await orders.reconcile();
  assert.equal(refund.mock.callCount(), 1);
  assert.equal(diskOrder().status, 'refunded');
  assert.equal(orders.deliveryStatus(diskOrder()), 'delivery_failed');
});
