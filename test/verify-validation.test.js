'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-verdicts-'));
delete process.env.DEMO_MODE;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.PAYMENT_DEMO;

const { app } = require('../server');
const store = require('../lib/store');
const oracle = require('../lib/oracle');
const verify = require('../lib/verify');
const NOW = Date.parse('2027-03-20T12:00:00Z');
const DAY = 86400000;
const SOURCE = 'https://source.example/Data?year=2027';
const EVIDENCE = 'Datele publicate la 15 martie 2027 arată o valoare de 4,8%.';
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

function record(count = 1, verification) {
  const request = { domain: 'economie', horizon: '3m', region: 'ro', lang: 'ro', question: '' };
  const rec = {
    id: 'verdictrecord1', key: store.cacheKey(request), request, createdAt: '2026-11-17T20:00:00Z', meta: {},
    prediction: {
      declined: false, title: 'Previziune de verificat', summary: 'Rezumat', scenarios: [],
      predictions: Array.from({ length: count }, (_, index) => ({ claim: `Afirmația ${index}`, probability: 80, resolve_by: '2027-03-10' })),
    },
    ...(verification ? { verification } : {}),
  };
  store.save(rec);
  return rec;
}

function client(results, blocks = [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: SOURCE, title: 'Sursă primară' }] }]) {
  const calls = [];
  oracle._setClient({ beta: { messages: { stream(params) {
    calls.push(params);
    const stream = new EventEmitter();
    stream.finalMessage = async () => {
      const content = [...blocks, { type: 'text', text: `<verification>${JSON.stringify({ results })}</verification>` }];
      content.forEach(b => stream.emit('contentBlock', b));
      return { stop_reason: 'end_turn', content, usage: {} };
    };
    return stream;
  } } } });
  return calls;
}

test('verdictele fără sursă consultată sau fără dovadă rămân nelămurite și nu intră în scor', async () => {
  const cases = [
    { status: 'true', evidence: EVIDENCE, url: 'https://inventat.example/' },
    { status: 'false', evidence: EVIDENCE },
    { status: 'true', evidence: EVIDENCE, url: 'javascript:alert(1)' },
    { status: 'true', evidence: ' \n\t ', url: SOURCE },
    { status: 'false', evidence: { text: EVIDENCE }, url: SOURCE },
    { status: 'pending', evidence: EVIDENCE, url: SOURCE },
  ];
  const rec = record(cases.length);
  client(cases.map((r, id) => ({ id, ...r })));
  await verify.verifyRecord(rec, NOW);
  assert.deepEqual(rec.verification.items.map(it => it.status), cases.map(() => 'unresolved'));
  assert.equal(rec.verification.items[0].url, null);
  assert.equal(rec.verification.items[3].evidence, '');
  const tr = verify.trackRecord();
  assert.equal(tr.resolved, 0);
  assert.equal(tr.brier, null);
  assert.equal(tr.pending, cases.length);
  assert.equal(tr.recent.length, 0);
});

test('URL-ul trebuie găsit în verificarea curentă, chiar dacă apare în previziunea originală', async () => {
  const rec = record();
  rec.prediction.sources = [{ title: 'Sursă veche', url: SOURCE }];
  client([{ id: 0, status: 'true', evidence: EVIDENCE, url: SOURCE }], []);
  await verify.verifyRecord(rec, NOW);
  assert.equal(rec.verification.items[0].status, 'unresolved');
  assert.equal(rec.verification.items[0].url, null);
});

test('sursele din căutare, citire și citări permit verdicte finale; calea URL nu se ignoră', async () => {
  const rec = record(4);
  client([
    { id: 0, status: 'true', evidence: EVIDENCE, url: `${SOURCE}#table` },
    { id: '1', status: 'false', evidence: EVIDENCE, url: 'https://fetch.example/report' },
    { id: 2, status: 'true', evidence: EVIDENCE, url: 'https://cited.example/report/' },
    { id: 3, status: 'true', evidence: EVIDENCE, url: 'https://source.example/data?year=2027' },
  ], [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: SOURCE, title: 'Căutare' }] },
    { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://fetch.example/report/', content: { title: 'Raport' } } },
    { type: 'text', text: 'Sursă citată', citations: [{ url: 'https://cited.example/report', title: 'Citare' }] },
  ]);
  await verify.verifyRecord(rec, NOW);
  assert.deepEqual(rec.verification.items.map(it => it.status), ['true', 'false', 'true', 'unresolved']);
  assert.equal(verify.trackRecord().resolved, 3);
});

test('ID-urile invalide, lipsă sau duplicate nu sunt atribuite primei afirmații', async () => {
  const value = { status: 'true', evidence: EVIDENCE, url: SOURCE };
  for (const results of [
    [null], [{ ...value }], [{ ...value, id: null }], [{ ...value, id: false }],
    [{ ...value, id: '' }], [{ ...value, id: [] }], [{ ...value, id: '00' }],
    [{ ...value, id: 8 }], [{ ...value, id: 0 }, { ...value, id: 0, status: 'false' }],
  ]) {
    const rec = record();
    client(results);
    await verify.verifyRecord(rec, NOW);
    assert.equal(rec.verification.items[0].status, 'unresolved', JSON.stringify(results));
    assert.equal(rec.verification.items[0].attempts, 1);
  }
  assert.throws(() => verify.parseResults('null'));
  assert.throws(() => verify.parseResults('{"results":null}'));
});

test('verdictele vechi fără dovezi sunt excluse și reintră la verificare în limitele existente', () => {
  const checkedAt = new Date(NOW - 8 * DAY).toISOString();
  const rec = record(7, { items: [
    { index: 0, status: 'true', evidence: EVIDENCE, url: null, checkedAt, attempts: 1 },
    { index: 1, status: 'false', evidence: '', url: SOURCE, checkedAt, attempts: 1 },
    { index: 2, status: 'true', evidence: EVIDENCE, url: SOURCE, checkedAt, attempts: 1 },
    { index: 3, status: 'false', evidence: EVIDENCE, url: SOURCE, checkedAt, attempts: 1 },
    { index: 4, status: 'true', evidence: EVIDENCE, url: null, checkedAt, attempts: 4 },
    { index: 5, status: 'unresolved' },
    { index: 6, status: 'unexpected', checkedAt, attempts: 1 },
  ] });
  assert.deepEqual(verify.dueClaims(rec, NOW), [0, 1, 5, 6]);
  const tr = verify.trackRecord();
  assert.equal(tr.resolved, 2);
  assert.equal(tr.correct, 1);
  assert.equal(tr.pending, 5);
  assert.deepEqual(tr.recent.map(it => it.claim).sort(), ['Afirmația 2', 'Afirmația 3']);
  assert.equal(tr.brier, 0.34);
});

test('un verdict vechi fără sursă poate fi reverificat cu dovadă, fără a schimba afirmația', async () => {
  const rec = record(1, { items: [{
    index: 0, status: 'false', evidence: 'Verdict vechi fără sursă', url: null,
    checkedAt: new Date(NOW - 8 * DAY).toISOString(), attempts: 1,
  }] });
  const criteria = 'Adevărat dacă rata oficială este strict sub 5% în februarie 2027; altfel fals.';
  rec.prediction.predictions[0].resolution_criteria = criteria;
  const original = JSON.stringify(rec.prediction);
  const calls = client([{ id: 0, status: 'true', evidence: EVIDENCE, url: SOURCE, resolution_criteria: 'Criteriu schimbat' }]);
  await verify.verifyRecord(rec, NOW);
  assert.match(calls[0].messages[0].content, /Resolution criteria fixed at forecast time:/);
  assert.ok(calls[0].messages[0].content.includes(criteria));
  assert.equal(JSON.stringify(rec.prediction), original);
  assert.equal(rec.verification.items[0].status, 'true');
  assert.equal(rec.verification.items[0].attempts, 2);
  assert.equal(store.get(rec.id).verification.items[0].url, SOURCE);
  assert.equal(verify.trackRecord().resolved, 1);
});

test('verdictul fără sursă se reîncearcă săptămânal, cu maximum patru încercări', async () => {
  const rec = record();
  const calls = client([{ id: 0, status: 'true', evidence: EVIDENCE, url: 'https://inventat.example/' }]);
  await verify.verifyRecord(rec, NOW);
  await verify.verifyRecord(rec, NOW + DAY);
  assert.equal(calls.length, 1);
  for (let attempt = 2; attempt <= 4; attempt++) {
    await verify.verifyRecord(rec, NOW + (attempt - 1) * 7 * DAY);
    assert.equal(rec.verification.items[0].attempts, attempt);
  }
  await verify.verifyRecord(rec, NOW + 40 * DAY);
  assert.equal(calls.length, 4);
  assert.deepEqual(verify.dueClaims(rec, NOW + 40 * DAY), []);
  assert.equal(verify.trackRecord().resolved, 0);
});

test('API-ul și palmaresul aplică aceeași regulă fișierelor vechi, fără apel API extern', async () => {
  const rec = record(3, { items: [
    { index: 0, status: 'true', evidence: EVIDENCE, url: null, checkedAt: new Date(NOW).toISOString(), attempts: 1 },
    { index: 1, status: 'false', evidence: ' ', url: SOURCE, checkedAt: new Date(NOW).toISOString(), attempts: 1 },
    { index: 2, status: 'false', evidence: EVIDENCE, url: SOURCE, checkedAt: new Date(NOW).toISOString(), attempts: 1 },
  ] });
  const result = await (await fetch(`${base}/api/p/${rec.id}`)).json();
  assert.deepEqual(result.checks.map(it => it.status), ['unresolved', 'unresolved', 'false']);
  const tr = await (await fetch(`${base}/api/track-record`)).json();
  assert.equal(tr.resolved, 1);
  assert.equal(tr.correct, 0);
  assert.equal(tr.pending, 2);
  assert.equal(tr.recent[0].claim, 'Afirmația 2');
});
