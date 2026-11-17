'use strict';
// Bugetul zilnic în dolari, restituirea cererii la erori ale serviciului și cache-ul pe orizont.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

delete process.env.DEMO_MODE;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-limits-'));
process.env.DAILY_BUDGET_USD = '1';
process.env.RATE_PER_HOUR = '1';

const store = require('../lib/store');
const cost = require('../lib/cost');
const oracle = require('../lib/oracle');
const jobs = require('../lib/jobs');

store.init();
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const REQ = { domain: 'economie', horizon: '1y', region: 'ro', lang: 'ro', question: '' };
// Consumul unei previziuni, așa cum îl adună oracolul: 0,004 + 0,2 + 0,1 = 0,304 $
const USAGE = { input_tokens: 1000, output_tokens: 10000, web_search_requests: 10 };

/** Client fals al cărui răspuns e decis de `behavior`: 'ok' | 'refusal' | 'error'. */
function client(behavior) {
  return {
    beta: { messages: { stream() {
      const em = new EventEmitter();
      em.finalMessage = async () => {
        if (behavior === 'error') throw Object.assign(new Error('overloaded'), { status: 529 });
        if (behavior === 'refusal') return { stop_reason: 'refusal', usage: { output_tokens: 50 }, content: [] };
        const p = { title: 'T', summary: 'S', predictions: [{ claim: 'C', probability: 60, resolve_by: '2027-01-15' }] };
        return { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 10000, server_tool_use: { web_search_requests: 10 } }, content: [{ type: 'text', text: `<prediction>${JSON.stringify(p)}</prediction>` }] };
      };
      return em;
    } } },
  };
}

/** Așteaptă terminarea unei lucrări. */
function settle(id) {
  const job = jobs.get(id);
  if (job.status === 'done' || job.status === 'error') return Promise.resolve(job.status);
  return new Promise((resolve) => job.bus.on('event', (ev) => {
    if (ev.type === 'done' || ev.type === 'error') resolve(ev.type);
  }));
}

test('costul în dolari se calculează din consumul raportat', () => {
  assert.equal(cost.costUsd(USAGE), 0.304);
  assert.equal(cost.costUsd({ cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 5.2);
  assert.equal(cost.costUsd(undefined), 0);
});

test('eroarea serviciului nu consumă cererea vizitatorului; refuzul o consumă', async () => {
  oracle._setClient(client('error'));
  const a = jobs.submit({ ...REQ, question: 'A?' }, '10.0.0.1');
  assert.equal(await settle(a.id), 'error');

  // Limita e 1/oră, dar cererea eșuată a fost restituită.
  oracle._setClient(client('refusal'));
  const b = jobs.submit({ ...REQ, question: 'B?' }, '10.0.0.1');
  assert.equal(await settle(b.id), 'error');

  // Refuzul ține de întrebare: cererea s-a consumat.
  assert.throws(() => jobs.submit({ ...REQ, question: 'C?' }, '10.0.0.1'), /limita de 1 previziuni pe oră/);
  // Costul refuzului (50 tokeni) a intrat totuși în buget.
  assert.equal(cost.status().spentUsd, 0.001);
});

test('bugetul zilnic oprește previziunile noi, dar nu și cache-ul', async () => {
  oracle._setClient(client('ok'));
  const first = jobs.submit({ ...REQ, question: 'Prima?' }, '10.0.0.2');
  assert.equal(await settle(first.id), 'done');
  assert.equal(store.get(first.id).meta.costUsd, 0.304);
  assert.equal(store.get(first.id).prediction.predictions[0].resolve_by, '2027-01-15');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'raw', `${first.id}.txt`)));

  // Estimarea devine costul real măsurat (0,304 $). 0,305 + 0,304 ≤ 1 → încă una.
  const second = jobs.submit({ ...REQ, question: 'A doua?' }, '10.0.0.3');
  assert.equal(await settle(second.id), 'done');

  // 0,609 + 0,304 ≤ 1 → încă una; după ea, 0,913 + 0,304 > 1 → stop.
  const third = jobs.submit({ ...REQ, question: 'A treia?' }, '10.0.0.4');
  assert.equal(await settle(third.id), 'done');
  assert.throws(() => jobs.submit({ ...REQ, question: 'A patra?' }, '10.0.0.5'), /odihnit pentru azi/);

  // O întrebare deja calculată se servește în continuare, fără cost.
  assert.deepEqual(jobs.submit({ ...REQ, question: 'prima' }, '10.0.0.6'), { id: first.id, cached: true });

  // Registrul e salvat pe disc (rezistă la repornire).
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'budget.json'), 'utf8'));
  assert.equal(saved.predictions, 3);
  assert.equal(saved.spentUsd, 0.913);
});

test('durata cache-ului crește cu orizontul', () => {
  const rec = (id, horizon, hoursAgo) => ({
    id, key: store.cacheKey({ ...REQ, horizon, question: id }),
    createdAt: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    request: { ...REQ, horizon, question: id }, prediction: { title: id, declined: false },
  });
  store.save(rec('saptamana', '1w', 4)); // 4 ore > 3 ore → expirată
  store.save(rec('deceniu', '10y', 100)); // 100 ore < 7 zile → valabilă
  // Expirată → ar fi o previziune nouă, iar bugetul de azi e epuizat de testul anterior.
  assert.throws(() => jobs.submit({ ...REQ, horizon: '1w', question: 'saptamana' }, '10.0.0.7'), /odihnit/);
  assert.equal(jobs.submit({ ...REQ, horizon: '10y', question: 'deceniu' }, '10.0.0.8').cached, true);
});
