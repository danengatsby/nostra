'use strict';
// Cache și istoric: simboluri păstrate, chei vechi invalidate, fără servicii externe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-cache-'));
process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '2';
process.env.RATE_PER_HOUR = '50';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYMENT_DEMO;

const { app } = require('../server');
const store = require('../lib/store');
const REQUEST = { domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro', effort: 'medium' };
const key = (question) => store.cacheKey({ ...REQUEST, question });
let server;
let base;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'predictions'), { recursive: true, force: true });
  store.init();
});
test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('operatorii, semnele, diacriticele și punctuația relevantă nu se confundă', () => {
  const pairs = [
    ['Inflația < 5%?', 'Inflația > 5%?'],
    ['Inflația < 5%?', 'Inflația <= 5%?'],
    ['Inflația = 5%?', 'Inflația != 5%?'],
    ['Creștere de +5%?', 'Creștere de -5%?'],
    ['Creștere de +5%?', 'Creștere de −5%?'],
    ['Curs de 5,2 lei?', 'Curs de 5 2 lei?'],
    ['Curs de 5.2 lei?', 'Curs de 5 2 lei?'],
    ['Va crește cu 5%?', 'Va crește cu 5?'],
    ['A/B?', 'A B?'],
    ['A|B?', 'A B?'],
    ['A_B?', 'A B?'],
    ['Viitorul C++?', 'Viitorul C?'],
    ['Țară?', 'Țara?'],
    ['Prognoză?', 'Prognoză!'],
  ];
  for (const [a, b] of pairs) assert.notEqual(key(a), key(b), `${a} / ${b}`);
});

test('majusculele, spațiile suplimentare și formele Unicode echivalente refolosesc cache-ul', () => {
  const original = 'Inflația < 5%?';
  assert.equal(key(original), key('  INFLAȚIA\t<\n 5%?  '));
  assert.equal(key(original), key(original.normalize('NFD')));
  assert.notEqual(key(original), key('Inflatia < 5%?'), 'diacriticele nu se elimină');
});

test('opțiunile diferite rămân separate în cache', () => {
  const request = { ...REQUEST, question: 'Inflația < 5%?' };
  for (const extra of [
    { domain: 'piete' }, { horizon: '1y' }, { region: 'global' },
    { lang: 'en' }, { private: true }, { effort: 'high' },
  ]) {
    assert.notEqual(store.cacheKey(request), store.cacheKey({ ...request, ...extra }));
  }
});

test('cache-ul vechi este invalidat, iar istoricul se separă după întrebarea originală', async () => {
  const below = { ...REQUEST, question: 'Inflația < 5%?' };
  const above = { ...REQUEST, question: 'Inflația > 5%?' };
  // Aceasta este exact cheia produsă de algoritmul vechi pentru ambele întrebări.
  const legacyKey = crypto.createHash('sha256').update([
    REQUEST.domain, REQUEST.horizon, REQUEST.region, REQUEST.lang, 'inflatia 5', '', REQUEST.effort,
  ].join('|')).digest('hex').slice(0, 32);
  const makeRecord = (id, request, cacheKey, ageMinutes) => ({
    id, key: cacheKey, createdAt: new Date(Date.now() - ageMinutes * 60000).toISOString(), request,
    prediction: {
      title: request.question, summary: 'Rezultat existent', declined: false,
      predictions: [{ claim: request.question, probability: 60 }],
      scenarios: [{ name: 'Scenariu de bază', probability: 60 }],
    }, meta: {},
  });
  const legacy = [
    makeRecord('legacybelow1', below, legacyKey, 4),
    makeRecord('legacyabove1', above, legacyKey, 3),
    makeRecord('legacylite01', below, `${legacyKey}|lite`, 2),
    makeRecord('legacypriv01', { ...below, private: true }, legacyKey, 1),
  ];
  for (const rec of legacy) {
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'predictions', `${rec.id}.json`), JSON.stringify(rec));
  }
  store.init();
  assert.equal(store.findCached(store.cacheKey(below), 24), null);
  assert.equal(store.findCached(store.cacheKey(above), 24), null);
  assert.equal(store.findCached(`${store.cacheKey(below)}|lite`, 24), null);
  const fresh = makeRecord('freshbelow01', below, store.cacheKey(below), 0);
  store.save(fresh);
  store.init(); // verificăm și indexul reconstruit la restart
  assert.equal(store.findCached(store.cacheKey(below), 24).id, fresh.id);
  assert.equal(store.findCached(store.cacheKey(above), 24), null);
  assert.deepEqual(store.series(below).map(r => r.id), ['legacybelow1', fresh.id]);
  assert.deepEqual(store.series(above).map(r => r.id), ['legacyabove1']);
  assert.deepEqual(store.series(below, 'lite').map(r => r.id), ['legacylite01']);
  const old = await (await fetch(`${base}/api/p/legacybelow1`)).json();
  assert.equal(old.request.question, below.question, 'linkul vechi rămâne accesibil');
  assert.deepEqual(old.history.map(r => r.id), ['legacybelow1', fresh.id]);
  const opposite = await (await fetch(`${base}/api/p/legacyabove1`)).json();
  assert.deepEqual(opposite.history, []);
  const lite = await (await fetch(`${base}/api/p/legacylite01`)).json();
  assert.deepEqual(lite.history, []);
  const priv = await (await fetch(`${base}/api/p/legacypriv01`)).json();
  assert.deepEqual(priv.history, []);
});

test('prin HTTP, întrebările opuse nu împart lucrarea activă sau rezultatul salvat', async () => {
  const post = async (question) => {
    const res = await fetch(`${base}/api/predict`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...REQUEST, question, private: false, email: 'reader@example.com' }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const [a, b] = await Promise.all([post('Inflația < 5%?'), post('Inflația > 5%?')]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.cached, false);
  assert.equal(b.cached, false);
  await Promise.all([a, b].map(async ({ id }) => {
    const events = await (await fetch(`${base}/api/predict/${id}/events`)).text();
    assert.match(events, /event: done/);
  }));
  const cachedA = await post('  INFLAȚIA   < 5%?  ');
  const cachedB = await post('Inflația > 5%?');
  assert.deepEqual([cachedA.id, cachedA.cached], [a.id, true]);
  assert.deepEqual([cachedB.id, cachedB.cached], [b.id, true]);
  for (const { id } of [a, b]) {
    const rec = await (await fetch(`${base}/api/p/${id}`)).json();
    assert.deepEqual(rec.history, [], 'întrebările opuse nu formează același istoric');
  }
});
