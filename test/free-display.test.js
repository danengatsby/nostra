'use strict';
// Modelul de vânzare: previziunea rapidă gratuită (fără email) și analiza aprofundată plătită, cerută din formular
// sau de pe pagina unei previziuni rapide. Date temporare, fără Stripe, SMTP sau AI reale.
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
delete process.env.FREE_TIER;
delete process.env.FREE_SCREEN_EMAIL_REQUIRED;
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
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
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

test('previziunea gratuită folosește modelul rapid, fără email, acord sau comandă', async t => {
  const catalog = await (await fetch(base + '/api/catalog')).json();
  assert.equal(catalog.freeDisplay, true);
  assert.equal(catalog.emailRequired, false);
  assert.equal(catalog.freeTier, 'lite');
  assert.equal(catalog.payment.required, true);
  const checkout = t.mock.method(payments, 'createCheckout', () => { throw new Error('Previziunea gratuită nu deschide Stripe'); });
  const before = orderCount();
  const sent = mail._sent.length;
  ({ id: readId } = await generate('Lectură gratuită?'));
  const rec = await (await fetch(`${base}/api/p/${readId}`)).json();
  assert.ok(rec.prediction.summary);
  assert.ok(rec.prediction.predictions.length);
  assert.equal(rec.meta.tier, 'lite');
  assert.notEqual(store.get(readId).meta.paid, true);
  assert.equal(store.get(readId).request.email, undefined);
  assert.equal(orderCount(), before);
  assert.equal(mail._sent.length, sent);
  assert.equal(checkout.mock.callCount(), 0);
});

test('FREE_SCREEN_EMAIL_REQUIRED=1 cere din nou emailul, validat fără a fi salvat sau trimis modelului', async t => {
  process.env.FREE_SCREEN_EMAIL_REQUIRED = '1';
  try {
    assert.equal((await (await fetch(base + '/api/catalog')).json()).emailRequired, true);
    const submit = t.mock.method(jobs, 'submit');
    for (const email of [undefined, '', 'invalid', 'a@b', '<a@b.ro>', 'a'.repeat(250) + '@b.ro']) {
      const response = await post('/api/predict', { ...request, question: 'Cu email?', delivery: 'screen', email, ui: 'en' });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /email address/);
    }
    assert.equal(submit.mock.callCount(), 0);
    submit.mock.restore();
    const { id } = await generate('Cu email?', { email: 'reader@example.com' });
    assert.equal(store.get(id).request.email, undefined);
    assert.doesNotMatch(JSON.stringify(await (await fetch(`${base}/api/p/${id}`)).json()), /reader@example/);
  } finally { delete process.env.FREE_SCREEN_EMAIL_REQUIRED; }
});

test('previziunile private gratuite rămân izolate; analiza lor aprofundată rămâne privată', async () => {
  const query = 'Lectură privată gratuită?';
  const a = await generate(query, { private: true });
  const b = await generate(query, { private: true });
  assert.notEqual(a.id, b.id);
  const cookie = a.response.headers.get('set-cookie').split(';')[0];
  const cached = await post('/api/predict', { ...request, question: query, delivery: 'screen', private: true }, { cookie });
  assert.equal((await cached.json()).id, a.id);
  assert.equal(a.response.headers.get('cache-control'), 'private, no-store');
  assert.ok(!(await (await fetch(base + '/api/recent')).json()).some(rec => rec.id === a.id || rec.id === b.id));
  const upgrade = await post(`/api/p/${a.id}/upgrade`, payment, { cookie });
  assert.equal(upgrade.status, 200);
  assert.equal(upgrade.headers.get('cache-control'), 'private, no-store');
  const { orderId } = await upgrade.json();
  const confirmed = await orders.confirm(orderId);
  await finish(confirmed.predictionId);
  const deep = store.get(confirmed.predictionId);
  assert.equal(deep.request.private, true);
  assert.equal(deep.meta.tier, 'main');
  assert.ok(!(await (await fetch(base + '/api/recent')).json()).some(rec => rec.id === deep.id));
});

test('previziunea gratuită păstrează limita de cereri per vizitator', async () => {
  const ip = '198.51.100.10';
  await generate('Limită gratuită 1?', {}, { ip });
  await generate('Limită gratuită 2?', {}, { ip });
  const response = await post('/api/predict', { ...request, question: 'Limită gratuită 3?', delivery: 'screen', ui: 'en' }, { ip });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /limit of 2/);
});

test('analiza aprofundată cere email și acord, doar pentru previziuni rapide existente și nerefuzate', async () => {
  for (const [body, message] of [[{}, /email address/], [{ email: 'invalid' }, /look right/], [{ email: 'client@example.com' }, /tick the box/]]) {
    const response = await post(`/api/p/${readId}/upgrade`, { ...body, ui: 'en' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, message);
  }
  assert.equal((await post('/api/p/missing12345/upgrade', payment)).status, 404);
  const declined = { ...store.get(readId), id: 'declinedfree01', prediction: { ...store.get(readId).prediction, declined: true } };
  store.save(declined);
  assert.equal((await post('/api/p/declinedfree01/upgrade', payment)).status, 400);
  const deep = { ...store.get(readId), id: 'deepalready01', meta: { ...store.get(readId).meta, tier: 'main' } };
  store.save(deep);
  const again = await post('/api/p/deepalready01/upgrade', { ...payment, ui: 'en' });
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /already an in-depth/);
  assert.equal((await post('/api/predict', { ...request, delivery: 'email', email: '', consent: true })).status, 400);
  assert.equal((await post('/api/predict', { ...request, delivery: 'email', email: 'client@example.com' })).status, 400, 'fără acord nu se deschide plata');
});

test('de la previziunea rapidă: întâi plata, apoi o generare nouă cu modelul principal, trimisă o singură dată pe email', async t => {
  const sent = mail._sent.length;
  let paid = false;
  t.mock.method(payments, 'checkPaid', async () => ({ paid, expired: false, paymentIntent: paid ? 'pi_upgrade' : null }));
  const checkout = await post(`/api/p/${readId}/upgrade`, payment);
  assert.equal(checkout.status, 200);
  const { orderId, checkoutUrl } = await checkout.json();
  assert.match(checkoutUrl, new RegExp(`/pay/${orderId}`));
  assert.deepEqual(await orders.confirm(orderId), { status: 'pending', deliveryStatus: null, predictionId: null });
  assert.equal(orders.get(orderId).upgradeOf, readId);
  assert.equal(orders.get(orderId).request.effort, 'high');
  assert.equal(orders.get(orderId).request.question, store.get(readId).request.question);
  paid = true;
  await Promise.all([orders.confirm(orderId), orders.confirm(orderId), orders.confirm(orderId)]);
  const predictionId = orders.get(orderId).predictionId;
  assert.ok(predictionId);
  assert.notEqual(predictionId, readId, 'analiza aprofundată este o previziune nouă');
  await finish(predictionId);
  await orders.reconcile();
  assert.equal(orders.get(orderId).status, 'done');
  const deep = store.get(predictionId);
  assert.equal(deep.meta.tier, 'main');
  assert.equal(deep.meta.paid, true);
  assert.equal(deep.request.effort, 'high');
  assert.equal(mail._sent.length, sent + 1);
  assert.match(mail._sent.at(-1).text, new RegExp(`/p/${predictionId}`));
  assert.equal(mail._sent.at(-1).to, payment.email);
});

test('Stripe: analiza aprofundată costă 2,99 €, iar anularea plății revine la previziunea rapidă', async () => {
  let checkout;
  payments._setClient({ checkout: { sessions: { create: async params => { checkout = params; return { id: 'cs_test_upgrade', url: 'https://checkout.stripe.com/test' }; } } } });
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  try {
    await payments.createCheckout({ id: 'upgrade-order-test01', ui: 'ro', email: payment.email, request, upgradeOf: readId }, 'https://example.com');
    assert.equal(checkout.line_items[0].price_data.product_data.name, 'Analiză aprofundată Nostradamus');
    assert.equal(checkout.line_items[0].price_data.unit_amount, 299);
    assert.equal(checkout.cancel_url, `https://example.com/p/${readId}?anulat=upgrade-order-test01`);
  } finally { delete process.env.STRIPE_SECRET_KEY; payments._setClient(null); }
});

test('fără configurarea plăților, gratuitul funcționează, iar analiza aprofundată este indisponibilă', async () => {
  delete process.env.PAYMENT_DEMO;
  try {
    assert.equal((await (await fetch(base + '/api/catalog')).json()).payment.required, false);
    for (const delivery of [undefined, 'screen']) {
      const free = await post('/api/predict', { ...request, delivery, question: `Fără Stripe ${delivery}?` });
      assert.equal(free.status, 200, 'fără email și fără plăți configurate');
    }
    assert.equal((await post(`/api/p/${readId}/upgrade`, payment)).status, 503);
    assert.equal((await post('/api/predict', { ...request, delivery: 'email', ...payment })).status, 503);
  } finally { process.env.PAYMENT_DEMO = '1'; }
});

test('când bugetul gratuit s-a epuizat, mesajul amintește de analiza plătită, care rămâne disponibilă', async () => {
  cost.record(100, 'fallback');
  const response = await post('/api/predict', { ...request, delivery: 'screen', question: 'Buget gratuit epuizat?', ui: 'en' });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /free forecasts have run out.*2,99 €/);
  const paid = await (await post('/api/predict', { ...request, delivery: 'email', question: 'Generare plătită după buget?', ...payment })).json();
  const confirmed = await orders.confirm(paid.orderId);
  await finish(confirmed.predictionId);
  assert.equal(store.get(confirmed.predictionId).meta.paid, true);
  assert.equal(store.get(confirmed.predictionId).meta.tier, 'main');
  assert.equal((await post(`/api/p/${readId}/upgrade`, payment)).status, 200);
});
