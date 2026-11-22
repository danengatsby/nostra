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
// Bugetul modelului de rezervă: încape o singură previziune (~0,105 $ cu consumul de test, estimare 0,06 $).
process.env.FALLBACK_DAILY_USD = '0.1';
// Testele de mai jos verifică trecerea de pe modelul principal pe cel rapid: vechiul mod gratuit (FREE_TIER=main).
// Modul implicit (gratuitul doar pe modelul rapid) are testul lui la final.
process.env.FREE_TIER = 'main';

const store = require('../lib/store');
const cost = require('../lib/cost');
const oracle = require('../lib/oracle');
const jobs = require('../lib/jobs');

store.init();
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const REQ = { domain: 'economie', horizon: '1y', region: 'ro', lang: 'ro', question: '' };
// Consumul unei previziuni, așa cum îl adună oracolul: 0,004 + 0,2 + 0,1 = 0,304 $
const USAGE = { input_tokens: 1000, output_tokens: 10000, web_search_requests: 10 };

/**
 * Client fals al cărui răspuns e decis de `behavior`: 'ok' | 'refusal' | 'error' | 'main-error' (doar modelul
 * principal eșuează). `seen` primește modelul fiecărui apel.
 */
function client(behavior, seen = []) {
  return {
    beta: { messages: { stream(params) {
      seen.push(params.model);
      const em = new EventEmitter();
      em.finalMessage = async () => {
        if (behavior === 'error') throw Object.assign(new Error('overloaded'), { status: 529 });
        if (behavior === 'main-error' && params.model !== 'claude-haiku-5-5') throw Object.assign(new Error('overloaded'), { status: 529 });
        if (behavior === 'refusal') return { stop_reason: 'refusal', usage: { output_tokens: 50 }, content: [] };
        const p = require('../lib/example').example().prediction;
        p.predictions[0].resolve_by = '2027-01-15';
        em.emit('contentBlock', { type: 'web_search_tool_result', content: p.sources.map(s => ({ ...s, type: 'web_search_result' })) });
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

  // Bugetul principal e epuizat: a patra merge pe modelul de rezervă (Haiku), din bugetul lui separat.
  const seen = [];
  oracle._setClient(client('ok', seen));
  const fourth = jobs.submit({ ...REQ, question: 'A patra?' }, '10.0.0.5');
  assert.equal(await settle(fourth.id), 'done');
  assert.deepEqual(seen, ['claude-haiku-5-5']);
  const lite = store.get(fourth.id);
  assert.equal(lite.meta.tier, 'lite');
  assert.equal(lite.meta.costUsd, 0.1051, '1000 × 0,10 $/M + 10000 × 0,50 $/M + 10 căutări × 0,01 $');
  assert.match(lite.key, /\|lite$/, 'cache separat: mâine aceeași întrebare primește analiza completă');
  assert.equal(cost.status().spentUsd, 0.913, 'bugetul principal nu se atinge');
  assert.equal(cost.status().fallbackSpentUsd, 0.1051);

  // Abia când s-a epuizat și bugetul de rezervă apare mesajul.
  assert.throws(() => jobs.submit({ ...REQ, question: 'A cincea?' }, '10.0.0.9'), /odihnit pentru azi/);

  // O întrebare deja calculată se servește în continuare, fără cost.
  assert.deepEqual(jobs.submit({ ...REQ, question: 'prima?' }, '10.0.0.6'), { id: first.id, cached: true });

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
  // Expirată → nu mai vine din cache (ar fi o previziune nouă; azi ambele bugete sunt epuizate).
  assert.throws(() => jobs.submit({ ...REQ, horizon: '1w', question: 'saptamana' }, '10.0.0.7'), /odihnit/);
  assert.equal(jobs.submit({ ...REQ, horizon: '10y', question: 'deceniu' }, '10.0.0.8').cached, true);
});

test('dacă modelul principal dă eroare, previziunea se face cu modelul de rezervă', async () => {
  cost._reset();
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'budget.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), spentUsd: 0, recent: [] }));
  const seen = [];
  oracle._setClient(client('main-error', seen));
  const { id } = jobs.submit({ ...REQ, question: 'Opus suprasolicitat?' }, '10.0.1.1');
  const events = [];
  jobs.get(id).bus.on('event', (ev) => events.push(ev.type === 'status' ? ev.data.phase : ev.type));
  assert.equal(await settle(id), 'done');
  assert.deepEqual(seen, ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.ok(events.includes('fallback'), 'vizitatorul vede că oracolul trece pe modelul rapid');
  assert.equal(store.get(id).meta.tier, 'lite');
});

test('plafonul zilnic include ambele modele, iar checkouturile au limită proprie', () => {
  const original = jobs.cfg.perDay;
  jobs.cfg.perDay = 1;
  try {
    assert.throws(() => jobs.precheck('audit-daily', 'ro'), /odihnit/);
    jobs.reserveCheckout('audit-checkout', 'ro');
    assert.throws(() => jobs.reserveCheckout('audit-checkout', 'ro'), jobs.LimitError);
  } finally { jobs.cfg.perDay = original; }
});

test('o generare plătită simultană primește propria lucrare principală', async () => {
  process.env.DEMO_MODE = '1';
  process.env.DEMO_STEP_MS = '2';
  cost.record(1, 'failed');
  process.env.FALLBACK_DAILY_USD = '5';
  const req = { ...REQ, question: 'Două tipuri de generare' };
  const free = jobs.submit(req, 'audit-lite');
  const paid = jobs.submit(req, null, 'ro', { paid: true });
  assert.notEqual(free.id, paid.id);
  assert.deepEqual([jobs.get(free.id).tier, jobs.get(paid.id).tier], ['lite', 'main']);
  await Promise.all([settle(free.id), settle(paid.id)]);
});

test('implicit (FREE_TIER=lite): gratuitul folosește doar modelul rapid, chiar cu buget principal disponibil', async () => {
  delete process.env.FREE_TIER;
  process.env.DEMO_MODE = '1';
  process.env.FALLBACK_DAILY_USD = '0.1';
  cost._reset();
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'budget.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), spentUsd: 0, recent: [] }));
  try {
    assert.ok(cost.canSpend(0.5), 'bugetul principal e disponibil');
    const free = jobs.submit({ ...REQ, question: 'Gratuit rapid?' }, '10.0.2.1');
    assert.equal(jobs.get(free.id).tier, 'lite');
    assert.equal(await settle(free.id), 'done');
    assert.equal(store.get(free.id).meta.tier, 'lite');
    const paid = jobs.submit({ ...REQ, question: 'Plătit aprofundat?' }, null, 'ro', { paid: true });
    assert.equal(jobs.get(paid.id).tier, 'main');
    await settle(paid.id);

    // Bugetul modelului rapid epuizat: gratuitul se oprește (cu cod, pentru mesajul care amintește de varianta plătită),
    // chiar dacă bugetul principal ar mai permite; plata rămâne posibilă.
    cost.record(1, 'fallback');
    assert.throws(() => jobs.submit({ ...REQ, question: 'Gratuit după buget?' }, '10.0.2.2'),
      (e) => e instanceof jobs.LimitError && e.code === 'tired' && e.status === 429);
    assert.doesNotThrow(() => jobs.precheck('10.0.2.3', 'ro', { ignoreBudget: true }));
  } finally { process.env.FREE_TIER = 'main'; }
});
