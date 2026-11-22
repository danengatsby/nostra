'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-product-'));
process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '2';
process.env.RATE_PER_HOUR = '100';
delete process.env.PAYMENT_DEMO;
delete process.env.STRIPE_SECRET_KEY;
const { app } = require('../server');
const store = require('../lib/store');
const jobs = require('../lib/jobs');
const cost = require('../lib/cost');
const demo = require('../lib/demo');
const { sanitizePrediction } = require('../lib/schema');
let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

test('exemplul complet este bilingv, gratuit și nu creează rezultate sau costuri', async () => {
  const before = cost.status().spentUsd;
  for (const lang of ['ro', 'en']) {
    const sample = await (await fetch(`${base}/api/example?lang=${lang}`)).json();
    assert.equal(sample.example, true);
    assert.equal(sample.request.lang, lang);
    assert.equal(sample.prediction.predictions.length, 4);
    assert.equal(sample.prediction.scenarios.reduce((n, s) => n + s.probability, 0), 100);
    assert.match(sample.prediction.summary, lang === 'en' ? /fictional/ : /fictive/);
    assert.equal(sanitizePrediction(sample.prediction).predictions[0].sources.length, 1);
  }
  assert.equal(store.all().length, 0);
  assert.equal(cost.status().spentUsd, before);
  assert.match((await fetch(`${base}/exemplu`)).headers.get('x-robots-tag'), /noindex/);
});

test('filtrele palmaresului se combină și nu contaminează cache-ul nefiltrat', async () => {
  const rows = [
    ['economie', '1m', 'main', 'true'], ['economie', '1y', 'main', 'false'],
    ['sport', '1m', 'lite', 'true'], ['economie', '1m', 'lite', 'false'],
  ];
  rows.forEach(([domain, horizon, tier, status], i) => store.save({
    id: `filtercase0${i}`, key: `key${i}`, createdAt: '2026-01-01T00:00:00Z', request: { domain, horizon, region: 'ro', lang: 'ro', question: '' },
    prediction: { title: 'T', declined: false, predictions: [{ claim: 'C', probability: 80, resolve_by: '2026-02-01' }] }, meta: { tier },
    verification: { items: [{ index: 0, status, evidence: 'Dovadă publicată', url: 'https://example.org/report', checkedAt: '2026-03-01T00:00:00Z' }] },
  }));
  const get = async query => (await fetch(`${base}/api/track-record${query}`)).json();
  assert.equal((await get('')).resolved, 4);
  assert.equal((await get('?domain=economie')).resolved, 3);
  assert.equal((await get('?horizon=1m')).resolved, 3);
  assert.equal((await get('?tier=main')).resolved, 2);
  const selected = await get('?domain=economie&horizon=1m&tier=lite');
  assert.equal(selected.resolved, 1);
  assert.equal(selected.correct, 0);
  assert.equal((await get('?domain=clima')).resolved, 0);
  assert.equal((await get('')).resolved, 4);
  for (const query of ['?domain=unknown', '?tier=bad', '?horizon=bad', '?tier=main&tier=lite']) assert.equal((await fetch(`${base}/api/track-record${query}`)).status, 400);
});

test('starea lucrării permite recuperarea progresului fără să expună sesiunea privată', async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runDemo = demo.runDemo;
  t.mock.method(demo, 'runDemo', async (...args) => { await gate; return runDemo(...args); });
  const request = { domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro', question: 'Status privat?', private: true };
  const job = jobs.submit(request, '192.0.2.1', 'ro', { privateScope: 'internal-only' });
  try {
    const response = await fetch(`${base}/api/predict/${job.id}/status`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json();
    assert.equal(body.status, 'running');
    assert.doesNotMatch(JSON.stringify(body), /internal-only|privateScope|question/);
  } finally { release(); }
  await (await fetch(`${base}/api/predict/${job.id}/events`)).text();
  assert.equal((await (await fetch(`${base}/api/predict/${job.id}/status`)).json()).status, 'done');
  assert.equal((await fetch(`${base}/api/predict/missing1234/status`)).status, 404);
});

test('conversia numără vizite distincte și păstrează ecranul și varianta de la intrarea pe formular', async () => {
  const ops = require('../lib/operations');
  const send = payload => fetch(base + '/api/form-visits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const mobile = 'a'.repeat(32), desktop = 'b'.repeat(32);
  assert.equal((await send({ id: mobile, event: 'visit', device: 'mobile' })).status, 204);
  assert.equal((await send({ id: desktop, event: 'visit', device: 'desktop' })).status, 204);
  await send({ id: mobile, event: 'visit', device: 'desktop' });
  await send({ id: mobile, event: 'display' });
  await send({ id: mobile, event: 'display' });
  assert.equal((await send({ id: 'c'.repeat(32), event: 'display' })).status, 404);
  assert.equal((await send({ id: mobile, event: 'unexpected' })).status, 400);
  assert.deepEqual(ops.formConversion().map(x => [x.device, x.visits, x.reports]), [['mobile', 1, 1], ['desktop', 1, 0]]);
});
