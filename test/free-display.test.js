'use strict';
// Lectura gratuită și livrarea opțională folosesc date temporare, fără Stripe, SMTP sau AI reale.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-free-'));
process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '2';
process.env.PAYMENT_DEMO = '1';
process.env.MAIL_CAPTURE = '1';
process.env.RATE_PER_HOUR = '2';
process.env.DAILY_BUDGET_USD = '1';
process.env.FALLBACK_DAILY_USD = '1';
delete process.env.STRIPE_SECRET_KEY;
const { app } = require('../server');
const orders = require('../lib/orders');
const payments = require('../lib/payments');
const jobs = require('../lib/jobs');
const store = require('../lib/store');
const cost = require('../lib/cost');
const mail = require('../lib/mail');
let server, base, readId, serial = 0;
const request = { private: false, domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro' };
const payment = { email: 'client@example.com', consent: true };
const post = (url, body, { ip = `192.0.2.${++serial}`, cookie } = {}) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(url === '/api/predict' ? { email: 'reader@example.com', ...body } : body),
});
const finish = async id => { assert.match(await (await fetch(`${base}/api/predict/${id}/events`)).text(), /event: done/); };
const generate = async (question, extra = {}, options) => {
  const response = await post('/api/predict', { ...request, question, delivery: 'screen', ...extra }, options);
  assert.equal(response.status, 200);
  const result = await response.json();
  await finish(result.id);
  return { id: result.id, response };
};
const orderCount = () => fs.readdirSync(path.join(process.env.DATA_DIR, 'orders')).filter(f => f.endsWith('.json')).length;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

test('cu plăți active, afișarea completă este gratuită cu email obligatoriu, fără acord de livrare sau comandă', async t => {
  const catalog = await (await fetch(base + '/api/catalog')).json();
  assert.equal(catalog.freeDisplay, true);
  assert.equal(catalog.emailRequired, true);
  assert.equal(catalog.payment.required, true);
  const checkout = t.mock.method(payments, 'createCheckout', () => { throw new Error('Lectura gratuită nu deschide Stripe'); });
  const before = orderCount();
  const sent = mail._sent.length;
  ({ id: readId } = await generate('Lectură gratuită?'));
  const rec = await (await fetch(`${base}/api/p/${readId}`)).json();
  assert.ok(rec.prediction.summary);
  assert.ok(rec.prediction.predictions.length);
  assert.notEqual(store.get(readId).meta.paid, true);
  assert.equal(orderCount(), before);
  assert.equal(mail._sent.length, sent);
  assert.equal(checkout.mock.callCount(), 0);
});

test('varianta separată permite lectura fără email și păstrează adresa obligatorie la plată', async () => {
  process.env.FREE_SCREEN_EMAIL_REQUIRED = '0';
  try {
    const catalog = await (await fetch(base + '/api/catalog')).json();
    assert.equal(catalog.emailRequired, false);
    const { id } = await generate('Lectură fără email?', { email: undefined, private: undefined });
    assert.equal(store.get(id).request.private, true, 'fără alegere explicită raportul rămâne accesibil prin link');
    const paid = await post('/api/predict', { ...request, delivery: 'email', email: undefined, consent: true });
    assert.equal(paid.status, 400);
    assert.equal((await post('/api/p/' + id + '/email', { consent: true })).status, 400);
  } finally { delete process.env.FREE_SCREEN_EMAIL_REQUIRED; }
});

test('emailul gratuit este validat fără a fi publicat, folosit ca identificator sau trimis modelului', async () => {
  const { id } = await generate('Email validat la lectură?', { email: 'reader@example.com', consent: false });
  const other = await generate('Email validat la lectură?', { email: 'another@example.com' });
  assert.equal(other.id, id, 'emailul nu modifică identitatea unei previziuni publice');
  assert.equal(store.get(id).request.email, undefined);
  assert.equal(store.get(id).request.consent, undefined);
  assert.doesNotMatch(JSON.stringify(await (await fetch(`${base}/api/p/${id}`)).json()), /reader@example|another@example/);
  const bad = await post('/api/predict', { ...request, delivery: 'unknown', ui: 'en' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Invalid request.');
});

test('fără email valid nu pornește nici afișarea gratuită, nici o lucrare din cache', async t => {
  const submit = t.mock.method(jobs, 'submit', () => { throw new Error('Cererea invalidă nu trebuie trimisă oracolului'); });
  for (const email of [undefined, '', 'invalid', 'a@b', 'a@b.c', '<a@b.ro>', 'a b@c.ro', 'a'.repeat(250) + '@b.ro']) {
    const response = await post('/api/predict', { ...request, question: 'Lectură gratuită?', delivery: 'screen', email, ui: 'en' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /email address/);
  }
  assert.equal(submit.mock.callCount(), 0);
});

test('previziunile private gratuite rămân izolate și nu apar în lista publică', async () => {
  const query = 'Lectură privată gratuită?';
  const a = await generate(query, { private: true });
  const b = await generate(query, { private: true });
  assert.notEqual(a.id, b.id);
  const cookie = a.response.headers.get('set-cookie').split(';')[0];
  const cached = await post('/api/predict', { ...request, question: query, delivery: 'screen', private: true }, { cookie });
  assert.equal((await cached.json()).id, a.id);
  assert.equal(a.response.headers.get('cache-control'), 'private, no-store');
  assert.ok(!(await (await fetch(base + '/api/recent')).json()).some(rec => rec.id === a.id || rec.id === b.id));
  const delivery = await post(`/api/p/${a.id}/email`, payment);
  assert.equal(delivery.headers.get('cache-control'), 'private, no-store');
  const { orderId } = await delivery.json();
  await orders.confirm(orderId);
  assert.equal(orders.get(orderId).predictionId, a.id);
  assert.equal(orders.get(orderId).request.private, true);
});

test('afișarea gratuită păstrează limita de cereri per vizitator', async () => {
  const ip = '198.51.100.10';
  await generate('Limită gratuită 1?', {}, { ip });
  await generate('Limită gratuită 2?', {}, { ip });
  const response = await post('/api/predict', { ...request, question: 'Limită gratuită 3?', delivery: 'screen', ui: 'en' }, { ip });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /limit of 2/);
});

test('livrarea plătită cere suplimentar acord; rezultatele absente sau refuzate nu se vând', async () => {
  for (const [body, message] of [[{}, /email address/], [{ email: 'invalid' }, /look right/], [{ email: 'client@example.com' }, /tick the box/]]) {
    const response = await post(`/api/p/${readId}/email`, { ...body, ui: 'en' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, message);
  }
  assert.equal((await post('/api/p/missing12345/email', payment)).status, 404);
  const declined = { ...store.get(readId), id: 'declinedfree01', prediction: { ...store.get(readId).prediction, declined: true } };
  store.save(declined);
  assert.equal((await post('/api/p/declinedfree01/email', payment)).status, 400);
  assert.equal((await post('/api/predict', { ...request, delivery: 'email', email: '' })).status, 400);
  assert.equal((await post('/api/predict', { ...request, email: '' })).status, 400, 'API-ul vechi păstrează cerințele plății');
});

test('trimiterea rezultatului gratuit așteaptă plata și nu regenerează sau retrimite la confirmări repetate', async t => {
  const count = store.all().length;
  const sent = mail._sent.length;
  const submit = t.mock.method(jobs, 'submit', () => { throw new Error('Nu trebuie regenerat'); });
  const precheck = t.mock.method(jobs, 'precheck', () => { throw new Error('Livrarea nu depinde de limitele de generare'); });
  let paid = false;
  t.mock.method(payments, 'checkPaid', async () => ({ paid, expired: false, paymentIntent: paid ? 'pi_delivery' : null }));
  const checkout = await post(`/api/p/${readId}/email`, payment);
  assert.equal(checkout.status, 200);
  const { orderId } = await checkout.json();
  assert.deepEqual(await orders.confirm(orderId), { status: 'pending', deliveryStatus: null, predictionId: null, delivery: 'email' });
  assert.equal(mail._sent.length, sent);
  assert.equal(orders.get(orderId).deliveryPredictionId, readId);
  paid = true;
  await Promise.all([orders.confirm(orderId), orders.confirm(orderId), orders.confirm(orderId)]);
  await orders.reconcile();
  assert.equal(orders.get(orderId).status, 'done');
  assert.equal(orders.get(orderId).predictionId, readId);
  assert.equal(store.all().length, count);
  assert.equal(submit.mock.callCount(), 0);
  assert.equal(precheck.mock.callCount(), 0);
  assert.equal(mail._sent.length, sent + 1);
  assert.match(mail._sent.at(-1).text, new RegExp(`/p/${readId}`));
  assert.equal(mail._sent.at(-1).to, payment.email);
});

test('o livrare după lectura gratuită se recuperează după restart, fără apel AI', async t => {
  const sent = mail._sent.length;
  const { orderId } = await (await post(`/api/p/${readId}/email`, payment)).json();
  orders.init();
  const submit = t.mock.method(jobs, 'submit', () => { throw new Error('Nu trebuie regenerat'); });
  await orders.reconcile();
  assert.equal(orders.get(orderId).status, 'done');
  assert.equal(orders.get(orderId).predictionId, readId);
  assert.equal(submit.mock.callCount(), 0);
  assert.equal(mail._sent.length, sent + 1);
});

test('dacă rezultatul cumpărat dispare, se restituie plata fără a genera o înlocuire', async t => {
  const { id } = await generate('Rezultat dispărut?');
  const { orderId } = await (await post(`/api/p/${id}/email`, payment)).json();
  fs.unlinkSync(path.join(process.env.DATA_DIR, 'predictions', `${id}.json`));
  const submit = t.mock.method(jobs, 'submit', () => { throw new Error('Nu trebuie regenerat'); });
  await orders.confirm(orderId);
  await orders.reconcile();
  assert.equal(orders.get(orderId).status, 'refunded');
  assert.equal(submit.mock.callCount(), 0);
});

test('fără configurarea plăților, lectura gratuită funcționează iar livrarea plătită este indisponibilă', async () => {
  delete process.env.PAYMENT_DEMO;
  try {
    assert.equal((await (await fetch(base + '/api/catalog')).json()).payment.required, false);
    for (const delivery of [undefined, 'screen']) {
      const missing = await post('/api/predict', { ...request, delivery, email: undefined });
      assert.equal(missing.status, 400, 'emailul este obligatoriu și fără plăți configurate');
    }
    await generate('Gratuit fără Stripe?');
    assert.equal((await post(`/api/p/${readId}/email`, payment)).status, 503);
    assert.equal((await post('/api/predict', { ...request, delivery: 'email', ...payment })).status, 503);
  } finally { process.env.PAYMENT_DEMO = '1'; }
});

test('Stripe descrie trimiterea rezultatului existent și revine la acesta după anulare', async () => {
  let checkout;
  payments._setClient({ checkout: { sessions: { create: async params => { checkout = params; return { id: 'cs_test_delivery', url: 'https://checkout.stripe.com/test' }; } } } });
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  try {
    await payments.createCheckout({ id: 'email-order-test01', ui: 'en', email: payment.email, request, deliveryPredictionId: readId }, 'https://example.com');
    assert.match(checkout.line_items[0].price_data.product_data.name, /email delivery/);
    assert.equal(checkout.line_items[0].price_data.unit_amount, 100);
    assert.equal(checkout.cancel_url, `https://example.com/p/${readId}?anulat=email-order-test01`);
  } finally { delete process.env.STRIPE_SECRET_KEY; payments._setClient(null); }
});

test('bugetele gratuite se respectă; trimiterea unui rezultat existent funcționează și după epuizarea lor', async () => {
  cost.record(100, 'prediction');
  cost.record(100, 'fallback');
  const response = await post('/api/predict', { ...request, delivery: 'screen', question: 'Buget gratuit epuizat?', ui: 'en' });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /resting/);
  const { orderId } = await (await post(`/api/p/${readId}/email`, payment)).json();
  await orders.confirm(orderId);
  assert.equal(orders.get(orderId).status, 'done');
  assert.equal(orders.get(orderId).predictionId, readId);
  const paid = await (await post('/api/predict', { ...request, delivery: 'email', question: 'Generare plătită după buget?', ...payment })).json();
  const confirmed = await orders.confirm(paid.orderId);
  await finish(confirmed.predictionId);
  assert.equal(store.get(confirmed.predictionId).meta.paid, true);
});
