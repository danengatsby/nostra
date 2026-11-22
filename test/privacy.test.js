'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-privacy-'));
process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '2';
process.env.RATE_PER_HOUR = '100';
process.env.DAILY_BUDGET_USD = '1';
process.env.FALLBACK_DAILY_USD = '100';
process.env.MAIL_CAPTURE = '1';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYMENT_DEMO;

const { app } = require('../server');
const store = require('../lib/store');
const jobs = require('../lib/jobs');
const orders = require('../lib/orders');
const cost = require('../lib/cost');
const demo = require('../lib/demo');
const seo = require('../lib/seo');
const REQUEST = { domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro', private: true };
let server;
let base;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { delete process.env.PAYMENT_DEMO; });
test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
async function post(url, body, cookie = '', headers = {}) {
  const res = await fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(url === '/api/predict' ? { email: 'reader@example.com', ...body } : body),
  });
  assert.equal(res.status, 200);
  return { res, data: await res.json(), cookie: cookieOf(res) || cookie };
}
const predict = (question, cookie = '', extra = {}, headers = {}) => post('/api/predict', { ...REQUEST, question, ...extra }, cookie, headers);
async function finish(id) {
  const res = await fetch(`${base}/api/predict/${id}/events`);
  const text = await res.text();
  assert.match(text, /event: done/);
  return res;
}
function privateHeaders(res) {
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
}

test('vizitatorii cu același IP nu împart lucrările sau cache-ul privat; aceeași sesiune le refolosește', async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runDemo = demo.runDemo;
  t.mock.method(demo, 'runDemo', async (...args) => { await gate; return runDemo(...args); });
  let a;
  let b;
  try {
    [a, b] = await Promise.all([
      predict('Izolare între vizitatori?', '', {}, { 'X-Forwarded-Proto': 'https' }),
      predict('Izolare între vizitatori?'),
    ]);
    privateHeaders(a.res);
    const header = a.res.headers.get('set-cookie');
    assert.match(header, /nostra_private=[A-Za-z0-9_-]{43}/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.doesNotMatch(header, /Max-Age|Expires/);
    assert.notEqual(a.cookie, b.cookie);
    assert.notEqual(a.data.id, b.data.id);
    const page = await fetch(`${base}/p/${a.data.id}`);
    privateHeaders(page); // și pagina de așteptare este privată, înainte de salvarea rezultatului
    await page.arrayBuffer();
    const stream = await fetch(`${base}/api/predict/${a.data.id}/events`);
    privateHeaders(stream);
    await stream.body.cancel();
    const again = await predict('Izolare între vizitatori?', a.cookie);
    assert.equal(again.data.id, a.data.id, 'aceeași sesiune se atașează lucrării proprii');
    assert.equal(again.data.cached, false);
    const spoof = await predict('Izolare între vizitatori?', b.cookie, { privateScope: jobs.get(a.data.id).privateScope });
    assert.equal(spoof.data.id, b.data.id, 'identificatorii din corpul cererii nu acordă acces');
  } finally { release(); }
  await Promise.all([a, b].map(({ data }) => finish(data.id)));
  const cachedA = await predict('Izolare între vizitatori?', a.cookie);
  const cachedB = await predict('Izolare între vizitatori?', b.cookie);
  assert.deepEqual([cachedA.data.id, cachedA.data.cached], [a.data.id, true]);
  assert.deepEqual([cachedB.data.id, cachedB.data.cached], [b.data.id, true]);
  store.init();
  const afterReload = await predict('Izolare între vizitatori?', a.cookie);
  assert.deepEqual([afterReload.data.id, afterReload.data.cached], [a.data.id, true]);
  const fresh = await predict('Izolare între vizitatori?');
  assert.notEqual(fresh.data.id, a.data.id);
  assert.notEqual(fresh.data.id, b.data.id);
  await finish(fresh.data.id);
});

test('linkurile private rămân distribuibile fără a expune sesiunea sau a permite cache HTTP', async (t) => {
  const { data, cookie } = await predict('Link privat distribuibil?');
  const stream = await finish(data.id);
  privateHeaders(stream);
  t.mock.method(seo, 'ogImage', async () => path.join(__dirname, '..', 'public', 'icons', 'icon-192.png'));
  const record = store.get(data.id);
  for (const url of [`/api/p/${data.id}`, `/p/${data.id}`, `/og/${data.id}.png`]) {
    const res = await fetch(base + url); // destinatarul linkului nu are cookie-ul creatorului
    assert.equal(res.status, 200);
    privateHeaders(res);
    if (!url.endsWith('.png')) {
      const text = await res.text();
      assert.ok(!text.includes(record.privateScope));
      assert.ok(!text.includes(cookie.split('=')[1]));
      assert.ok(!text.includes('privateScope'));
    } else await res.arrayBuffer();
  }
  const result = await (await fetch(`${base}/api/p/${data.id}`)).json();
  assert.deepEqual(result.history, []);
  const recent = await (await fetch(`${base}/api/recent`)).text();
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.ok(!recent.includes(data.id));
  assert.ok(!sitemap.includes(data.id));
});

test('cookie-urile invalide se înlocuiesc; rezultatele publice se partajează fără cookie nou', async () => {
  const a = await predict('Cookie invalid?', 'nostra_private=invalid');
  assert.match(a.cookie, /^nostra_private=[A-Za-z0-9_-]{43}$/);
  await finish(a.data.id);
  const b = await predict('Întrebare publică?', a.cookie, { private: false });
  assert.equal(b.res.headers.get('set-cookie'), null);
  await finish(b.data.id);
  const c = await predict('Întrebare publică?', '', { private: false });
  assert.deepEqual([c.data.id, c.data.cached], [b.data.id, true]);
  assert.equal(c.res.headers.get('set-cookie'), null);
  const res = await fetch(`${base}/api/p/${c.data.id}`);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  await res.arrayBuffer();
});

test('cache-ul privat vechi nu este reutilizat; linkul și SSE vechi primesc no-store', async () => {
  const request = { ...REQUEST, question: 'Previziune privată veche?' };
  const rec = {
    id: 'legacyprivate1', key: store.cacheKey(request), request, createdAt: new Date().toISOString(),
    prediction: { title: 'Veche', summary: 'Rezumat', declined: false, predictions: [], scenarios: [] }, meta: {},
  };
  store.save(rec);
  const fresh = await predict(request.question);
  assert.notEqual(fresh.data.id, rec.id);
  await finish(fresh.data.id);
  privateHeaders(await finish(rec.id)); // nu există lucrare în memorie pentru fișierul vechi
  const result = await fetch(`${base}/api/p/${rec.id}`);
  assert.equal(result.status, 200);
  privateHeaders(result);
  await result.arrayBuffer();
});

test('comenzile private păstrează sesiunea după restart și sunt izolate chiar cu același email', async () => {
  process.env.PAYMENT_DEMO = '1';
  const question = 'Comandă privată cu restart?';
  const extra = { email: 'acelasi@example.com', consent: true };
  const [a, b] = await Promise.all([predict(question, '', extra), predict(question, '', extra)]);
  const scopeA = orders.get(a.data.orderId).privateScope;
  const scopeB = orders.get(b.data.orderId).privateScope;
  assert.ok(scopeA);
  assert.notEqual(scopeA, scopeB);
  assert.ok(!JSON.stringify(a.data).includes(scopeA));
  orders.init();
  assert.equal(orders.get(a.data.orderId).privateScope, scopeA);
  const [confirmedA, confirmedB] = await Promise.all([
    post(`/api/orders/${a.data.orderId}/confirm`, {}),
    post(`/api/orders/${b.data.orderId}/confirm`, {}),
  ]);
  privateHeaders(confirmedA.res);
  assert.notEqual(confirmedA.data.predictionId, confirmedB.data.predictionId);
  await Promise.all([confirmedA, confirmedB].map(({ data }) => finish(data.predictionId)));
  assert.equal(store.get(confirmedA.data.predictionId).privateScope, scopeA);
  assert.equal(orders.get(a.data.orderId).status, 'done');
  const sameSession = await predict(question, a.cookie, extra);
  const confirmedAgain = await post(`/api/orders/${sameSession.data.orderId}/confirm`, {});
  assert.equal(confirmedAgain.data.predictionId, confirmedA.data.predictionId);
  assert.equal(confirmedAgain.data.status, 'done');
});

test('comenzile private vechi fără sesiune sunt reluate în spații separate', async () => {
  process.env.PAYMENT_DEMO = '1';
  const request = { ...REQUEST, question: 'Comenzi vechi private?' };
  for (const id of ['oldprivateorder01', 'oldprivateorder02']) {
    const o = { id, status: 'paid', createdAt: new Date().toISOString(), request, ui: 'ro', amountCents: 100 };
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'orders', `${id}.json`), JSON.stringify(o));
  }
  orders.init();
  await orders.reconcile();
  const a = orders.get('oldprivateorder01');
  const b = orders.get('oldprivateorder02');
  assert.ok(a.privateScope);
  assert.notEqual(a.privateScope, b.privateScope);
  assert.notEqual(a.predictionId, b.predictionId);
  await Promise.all([a, b].map(o => finish(o.predictionId)));
});

test('apelurile interne private fără sesiune nu se atașează între ele', async () => {
  const req = { ...REQUEST, question: 'Fără sesiune internă?' };
  const a = jobs.submit(req, '192.0.2.1');
  const b = jobs.submit(req, '192.0.2.1');
  assert.notEqual(a.id, b.id);
  await Promise.all([a, b].map(o => finish(o.id)));
});

test('modelul de rezervă păstrează izolarea cache-ului privat pe sesiune', async () => {
  cost.record(5, 'prediction');
  const question = 'Izolare model rapid?';
  const [a, b] = await Promise.all([predict(question), predict(question)]);
  assert.notEqual(a.data.id, b.data.id);
  await Promise.all([a, b].map(({ data }) => finish(data.id)));
  assert.equal(store.get(a.data.id).meta.tier, 'lite');
  const again = await predict(question, a.cookie);
  assert.deepEqual([again.data.id, again.data.cached], [a.data.id, true]);
});
