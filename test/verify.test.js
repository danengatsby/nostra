'use strict';
// Verificarea previziunilor ajunse la termen și palmaresul, cu un client API simulat.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

delete process.env.DEMO_MODE;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-verify-'));
process.env.DAILY_BUDGET_USD = '1';
process.env.VERIFY_DAILY_USD = '0.25';

const store = require('../lib/store');
const cost = require('../lib/cost');
const oracle = require('../lib/oracle');
const verify = require('../lib/verify');

store.init();
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const DAY = 86400000;
const NOW = Date.parse('2027-03-20T12:00:00Z');

function record(id, predictions, extra = {}) {
  const rec = {
    id, key: id, createdAt: '2026-11-17T20:00:00.000Z',
    request: { domain: 'economie', horizon: '3m', region: 'ro', lang: 'ro', question: '' },
    prediction: { declined: false, title: `Titlu ${id}`, summary: 'S', predictions },
    meta: {}, ...extra,
  };
  store.save(rec);
  return rec;
}

/** Client fals: răspunde cu `results` și raportează o căutare pe `url`. */
function client(results, calls, usage = { input_tokens: 2000, output_tokens: 3000, server_tool_use: { web_search_requests: 3 } }) {
  return { beta: { messages: { stream(params) {
    calls.push(params);
    const em = new EventEmitter();
    em.finalMessage = async () => {
      const blocks = [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://insse.ro/ipc-feb-2027', title: 'INS' }] },
        { type: 'text', text: `<verification>${JSON.stringify({ results })}</verification>` },
      ];
      blocks.forEach((b) => em.emit('contentBlock', b));
      return { stop_reason: 'end_turn', usage, content: blocks };
    };
    return em;
  } } } };
}

test('afirmațiile devin scadente după data de verificare plus 2 zile', () => {
  const rec = record('scadenta1', [
    { claim: 'A', probability: 70, resolve_by: '2027-03-17' }, // 17 + 2 = 19 < 20 → scadentă
    { claim: 'B', probability: 70, resolve_by: '2027-03-19' }, // 19 + 2 = 21 > 20 → nu încă
    { claim: 'C', probability: 70, resolve_by: '' }, // fără dată: sfârșitul perioadei (3 luni) → scadentă
  ]);
  assert.deepEqual(verify.dueClaims(rec, NOW), [0, 2]);
  assert.equal(verify.resolveDate(rec, rec.prediction.predictions[2]), '2027-02-16');
});

test('verificarea marchează afirmațiile și păstrează doar surse găsite efectiv', async () => {
  const calls = [];
  const rec = record('verificare01', [
    { claim: 'Inflația peste 6%', probability: 87, resolve_by: '2027-03-13' },
    { claim: 'Dobânda rămâne 6,5%', probability: 85, resolve_by: '2027-03-13' },
    { claim: 'Inflația sub 5%', probability: 20, resolve_by: '2027-03-13' },
  ]);
  oracle._setClient(client([
    { id: 0, status: 'true', evidence: 'INS: 6,8% în februarie 2027.', url: 'https://insse.ro/ipc-feb-2027' },
    { id: 1, status: 'false', evidence: 'BNR a redus dobânda la 6,25%.', url: 'https://inventat.example/x' },
    { id: 2, status: 'bizar' },
  ], calls));

  const usd = await verify.verifyRecord(rec, NOW);
  assert.equal(usd, 0.098); // 2000 × 4 $/M + 3000 × 20 $/M + 3 căutări × 0,01 $
  assert.equal(calls[0].output_config.effort, 'medium');
  assert.match(calls[0].messages[0].content, /<claim id="1">\nDobânda rămâne 6,5%/);

  const saved = store.get('verificare01');
  const [a, b, c] = saved.verification.items;
  assert.deepEqual([a.status, b.status, c.status], ['true', 'false', 'unresolved']);
  assert.equal(a.url, 'https://insse.ro/ipc-feb-2027');
  assert.equal(b.url, null, 'URL-ul inventat nu se păstrează');
  assert.equal(cost.status().verifications, 1);

  // Cele verificate nu mai sunt scadente; cea nelămurită revine după o săptămână.
  assert.deepEqual(verify.dueClaims(saved, NOW + DAY), []);
  assert.deepEqual(verify.dueClaims(saved, NOW + 8 * DAY), [2]);
});

test('palmaresul: procent corect, Brier și calibrare (p < 50% se întoarce)', () => {
  const tr = verify.trackRecord();
  // 87% adevărată → corect; 85% falsă → greșit; 20% nelămurită → în așteptare (+ celelalte din testul 1).
  assert.equal(tr.resolved, 2);
  assert.equal(tr.correct, 1);
  assert.equal(tr.brier, Math.round((((0.87 - 1) ** 2 + (0.85 - 0) ** 2) / 2) * 1000) / 1000);
  const b80 = tr.buckets.find((x) => x.range === '80–89%');
  assert.deepEqual([b80.count, b80.expected, b80.actual], [2, 86, 50]);
  assert.equal(tr.recent.length, 2);
  assert.ok(tr.pending >= 4);
});

test('trecerea verificatorului respectă cota zilnică a verificărilor', async () => {
  for (let i = 0; i < 5; i++) record(`multe0000${i}`, [{ claim: `X${i}`, probability: 60, resolve_by: '2027-01-10' }]);
  const calls = [];
  // Fiecare verificare costă ~0,1 $; cota e 0,25 $ și s-a cheltuit deja ~0,1 $ în testul anterior.
  oracle._setClient(client([{ id: 0, status: 'true', evidence: 'Da.', url: 'https://insse.ro/ipc-feb-2027' }], calls));
  const { checked } = await verify.runOnce(NOW);
  assert.ok(checked >= 1 && checked < 5, `verificate: ${checked}`);
  assert.ok(cost.status().verifySpentUsd <= 0.25 + 0.0001);
});
