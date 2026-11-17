'use strict';
// Plata înaintea previziunii: comanda, confirmarea, restituirea la eșec și apelurile către Stripe (simulate).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '2';
process.env.PAYMENT_DEMO = '1';
process.env.RATE_PER_HOUR = '50';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-pay-'));
delete process.env.STRIPE_SECRET_KEY;
delete process.env.BASE_URL;

const { app } = require('../server');
const orders = require('../lib/orders');
const payments = require('../lib/payments');
const oracle = require('../lib/oracle');
const store = require('../lib/store');
const cost = require('../lib/cost');

let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const Q = { domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro' };
const finish = async (id) => (await (await fetch(`${base}/api/predict/${id}/events`)).text());

test('cu plata activă: întâi pagina de plată, previziunea abia după confirmare', async () => {
  const cat = await (await fetch(`${base}/api/catalog`)).json();
  assert.deepEqual(cat.payment, { required: true, price: '1 €' });

  const res = await (await post('/api/predict', { ...Q, question: 'Plătit?' })).json();
  assert.match(res.checkoutUrl, new RegExp(`/pay/${res.orderId}\\?session_id=demo$`));
  assert.equal(res.id, undefined, 'nicio previziune înainte de plată');
  assert.equal(orders.get(res.orderId).status, 'pending');
  assert.equal(store.all().length, 0);

  // Pagina de întoarcere există și nu se indexează.
  const page = await fetch(`${base}/pay/${res.orderId}?session_id=demo`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');

  const st = await (await post(`/api/orders/${res.orderId}/confirm`, {})).json();
  assert.equal(st.status, 'paid');
  assert.ok(st.predictionId);
  assert.match(await finish(st.predictionId), /event: done/);

  const order = orders.get(res.orderId);
  assert.equal(order.status, 'done');
  assert.ok(order.paidAt);
  assert.equal(store.get(st.predictionId).meta.paid, true);

  // Confirmarea repetată (reîncărcarea paginii, webhook) nu pornește o a doua previziune.
  const again = await (await post(`/api/orders/${res.orderId}/confirm`, {})).json();
  assert.deepEqual(again, { status: 'done', predictionId: st.predictionId });
  assert.equal(store.all().length, 1);
});

test('comandă inexistentă și webhook nesemnat', async () => {
  assert.equal((await post('/api/orders/inexistentaaaaaaaaaaa/confirm', { ui: 'en' })).status, 404);
  const wh = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'fals' }, body: '{}' });
  assert.equal(wh.status, 400);
});

test('dacă previziunea eșuează după plată, banii se returnează și vizitatorul află', async () => {
  delete process.env.DEMO_MODE; // oracolul „real”, cu un client care eșuează
  oracle._setClient({ beta: { messages: { stream() {
    const em = new EventEmitter();
    em.finalMessage = async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); };
    return em;
  } } } });
  try {
    const { orderId } = await (await post('/api/predict', { ...Q, question: 'Eșuează?' })).json();
    const { predictionId } = await (await post(`/api/orders/${orderId}/confirm`, {})).json();
    const sse = await finish(predictionId);
    assert.match(sse, /event: error/);
    assert.match(sse, /Plata ți-a fost returnată automat/);
    const o = orders.get(orderId);
    assert.equal(o.status, 'refunded');
    assert.equal(o.refundReason, 'failed');
  } finally {
    process.env.DEMO_MODE = '1';
  }
});

test('dacă oracolul refuză întrebarea, banii se returnează, iar pagina o spune', async () => {
  delete process.env.DEMO_MODE;
  const declined = { declined: true, declined_reason: 'Persoană privată.' };
  oracle._setClient({ beta: { messages: { stream() {
    const em = new EventEmitter();
    em.finalMessage = async () => ({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: `<prediction>${JSON.stringify(declined)}</prediction>` }] });
    return em;
  } } } });
  try {
    const { orderId } = await (await post('/api/predict', { ...Q, question: 'Despre vecinul meu?' })).json();
    const { predictionId } = await (await post(`/api/orders/${orderId}/confirm`, {})).json();
    assert.match(await finish(predictionId), /event: done/);
    assert.equal(orders.get(orderId).status, 'refunded');
    assert.equal(orders.get(orderId).refundReason, 'declined');
    const rec = await (await fetch(`${base}/api/p/${predictionId}`)).json();
    assert.equal(rec.refunded, true);
  } finally {
    process.env.DEMO_MODE = '1';
  }
});

test('verificarea periodică pornește comenzile plătite fără întoarcere pe site și le expiră pe cele vechi', async () => {
  const { orderId } = await (await post('/api/predict', { ...Q, question: 'Fereastră închisă?' })).json();
  const { orderId: old } = await (await post('/api/predict', { ...Q, question: 'Abandonată?' })).json();
  orders.get(old).createdAt = new Date(Date.now() - 2 * 3600000).toISOString();

  await orders.reconcile();
  assert.ok(orders.get(orderId).predictionId, 'plata confirmată fără vizitator');
  await finish(orders.get(orderId).predictionId);
  assert.equal(orders.get(orderId).status, 'done');
  assert.equal(orders.get(old).status, 'expired');
});

test('previziunile plătite nu depind de bugetul zilnic (prețul acoperă costul)', async () => {
  cost.record(5, 'prediction');
  const res = await post('/api/predict', { ...Q, question: 'Buget?', ui: 'en' });
  assert.equal(res.status, 200);
  const { orderId, checkoutUrl } = await res.json();
  assert.ok(checkoutUrl);
  const { predictionId } = await (await post(`/api/orders/${orderId}/confirm`, {})).json();
  assert.match(await finish(predictionId), /event: done/);
  assert.equal(store.get(predictionId).meta.tier, 'main', 'plătit → mereu modelul principal');
});

test('Stripe: sesiunea de plată cere 1 € pentru comanda corectă, iar plata se verifică strict', async () => {
  const calls = {};
  payments._setClient({
    checkout: { sessions: {
      create: async (p) => { calls.create = p; return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }; },
      retrieve: async (id) => ({ id, client_reference_id: calls.create.client_reference_id, amount_total: calls.amount ?? 100, currency: 'eur', payment_status: 'paid', status: 'complete', payment_intent: 'pi_1' }),
    } },
    refunds: { create: async (p, o) => { calls.refund = [p, o]; return { id: 're_1' }; } },
  });
  process.env.STRIPE_SECRET_KEY = 'sk_test_fals';
  try {
    const order = { id: 'comanda-de-test-0001', ui: 'en', request: { question: 'Will it rain?' } };
    const { url, session } = await payments.createCheckout(order, 'https://nostradamus.my');
    assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.equal(session, 'cs_test_1');
    const c = calls.create;
    assert.equal(c.mode, 'payment');
    assert.equal(c.locale, 'en');
    assert.equal(c.client_reference_id, order.id);
    assert.deepEqual([c.line_items[0].price_data.unit_amount, c.line_items[0].price_data.currency], [100, 'eur']);
    assert.match(c.line_items[0].price_data.product_data.description, /Will it rain\?/);
    assert.equal(c.success_url, `https://nostradamus.my/pay/${order.id}?session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(c.cancel_url, `https://nostradamus.my/?anulat=${order.id}`);

    order.session = session;
    assert.deepEqual(await payments.checkPaid(order), { paid: true, paymentIntent: 'pi_1', expired: false });
    calls.amount = 50; // altă sumă decât prețul: nu e acceptată
    assert.equal((await payments.checkPaid(order)).paid, false);

    order.paymentIntent = 'pi_1';
    await payments.refund(order);
    assert.deepEqual(calls.refund[0].payment_intent, 'pi_1');
    assert.equal(calls.refund[1].idempotencyKey, `refund-${order.id}`, 'o comandă nu poate fi restituită de două ori');
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('administrarea arată încasările și comenzile', async () => {
  process.env.ADMIN_PASSWORD = 'p';
  const html = await (await fetch(`${base}/admin`, { headers: { Authorization: `Basic ${Buffer.from('a:p').toString('base64')}` } })).text();
  assert.match(html, /<h2>Plăți<\/h2>/);
  assert.match(html, /restituite automat/);
  assert.match(html, /întrebare refuzată/);
  assert.match(html, /Fereastră închisă\?/);
});
