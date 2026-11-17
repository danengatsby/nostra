'use strict';
// Previziuni private, mesaje în engleză, istoricul aceleiași întrebări, administrarea și aplicația instalabilă.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '2';
process.env.RATE_PER_HOUR = '50';
process.env.ADMIN_PASSWORD = 'parola-de-test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-features-'));

const { app } = require('../server');
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

const post = (body) => fetch(`${base}/api/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const finish = async (id) => { await (await fetch(`${base}/api/predict/${id}/events`)).text(); };
const Q = { domain: 'sport', horizon: '1w', region: 'global', lang: 'ro' };

test('o previziune privată nu apare public și nu împarte cache-ul cu cea publică', async () => {
  const priv = await (await post({ ...Q, question: 'Cine câștigă derby-ul?', private: true })).json();
  await finish(priv.id);
  const pub = await (await post({ ...Q, question: 'Cine câștigă derby-ul?' })).json();
  assert.notEqual(pub.id, priv.id);
  assert.equal(pub.cached, false);
  await finish(pub.id);

  const recent = await (await fetch(`${base}/api/recent`)).json();
  assert.ok(recent.some((r) => r.id === pub.id));
  assert.ok(!recent.some((r) => r.id === priv.id));
  assert.doesNotMatch(await (await fetch(`${base}/sitemap.xml`)).text(), new RegExp(priv.id));
  assert.match(await (await fetch(`${base}/p/${priv.id}`)).text(), /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(await (await fetch(`${base}/p/${pub.id}`)).text(), /noindex/);
  const rec = await (await fetch(`${base}/api/p/${priv.id}`)).json();
  assert.equal(rec.request.private, true);
  assert.deepEqual(rec.history, []);
});

test('mesajele de eroare urmează limba interfeței', async () => {
  const en = await (await post({ horizon: '1m', ui: 'en' })).json();
  assert.equal(en.error, 'Choose a domain.');
  const ro = await (await post({ horizon: '1m' })).json();
  assert.equal(ro.error, 'Alege un domeniu.');
  assert.equal((await (await fetch(`${base}/api/p/inexistent123?ui=en`)).json()).error, 'This forecast does not exist.');
});

test('aceeași întrebare la momente diferite formează un istoric', async () => {
  const body = { ...Q, question: 'Istoric?' };
  const first = await (await post(body)).json();
  await finish(first.id);
  let rec = await (await fetch(`${base}/api/p/${first.id}`)).json();
  assert.deepEqual(rec.history, []); // o singură previziune: fără istoric
  assert.equal(rec.refreshable, false); // încă în cache (3 ore pentru o săptămână)

  // Simulăm trecerea timpului: prima previziune are 4 ore.
  const saved = store.get(first.id);
  saved.createdAt = new Date(Date.now() - 4 * 3600000).toISOString();
  store.update(saved);
  store.init();
  rec = await (await fetch(`${base}/api/p/${first.id}`)).json();
  assert.equal(rec.refreshable, true);

  const second = await (await post(body)).json();
  assert.equal(second.cached, false);
  await finish(second.id);
  rec = await (await fetch(`${base}/api/p/${second.id}`)).json();
  assert.deepEqual(rec.history.map((h) => h.id), [first.id, second.id]);
  assert.equal(rec.history[1].base.probability, 55);
  assert.equal(rec.refreshable, false);
});

test('pagina de administrare cere parola', async () => {
  assert.equal((await fetch(`${base}/admin`)).status, 401);
  const bad = Buffer.from('admin:gresit').toString('base64');
  assert.equal((await fetch(`${base}/admin`, { headers: { Authorization: `Basic ${bad}` } })).status, 401);
  const good = Buffer.from('admin:parola-de-test').toString('base64');
  const res = await fetch(`${base}/admin`, { headers: { Authorization: `Basic ${good}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.match(html, /cheltuit azi/);
  assert.match(html, /Istoric\?/, 'întrebările apar în lista de previziuni');
  assert.match(html, /privată/);
});

test('registrul de buget păstrează istoricul zilelor încheiate', () => {
  const file = path.join(process.env.DATA_DIR, 'budget.json');
  fs.writeFileSync(file, JSON.stringify({ date: '2026-01-01', spentUsd: 0.9, verifySpentUsd: 0.1, predictions: 2, verifications: 1, recent: [0.4] }));
  cost._reset();
  const st = cost.status();
  assert.equal(st.spentUsd, 0);
  assert.deepEqual(st.history.at(-1), { date: '2026-01-01', spentUsd: 0.9, verifySpentUsd: 0.1, fallbackSpentUsd: 0, predictions: 2, verifications: 1, fallbacks: 0 });
});

test('aplicația instalabilă: manifest, service worker, pictograme', async () => {
  const man = await fetch(`${base}/manifest.webmanifest`);
  assert.match(man.headers.get('content-type'), /application\/manifest\+json/);
  const json = await man.json();
  assert.equal(json.display, 'standalone');
  for (const icon of json.icons) assert.equal((await fetch(base + icon.src)).status, 200);
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  assert.match(await sw.text(), /addEventListener\('fetch'/);
});

test('efortul: în catalog, validat la cerere și separat în cache', async () => {
  const cat = await (await fetch(`${base}/api/catalog`)).json();
  assert.deepEqual(cat.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.ok(['low', 'medium', 'high'].includes(cat.defaultEffort));

  const body = { ...Q, question: 'Efort?' };
  const low = await (await post({ ...body, effort: 'low' })).json();
  await finish(low.id);
  const high = await (await post({ ...body, effort: 'high' })).json();
  assert.notEqual(high.id, low.id, 'aceeași întrebare cu alt efort nu vine din cache');
  await finish(high.id);
  assert.equal((await (await post({ ...body, effort: 'low' })).json()).id, low.id);

  const odd = await (await post({ ...body, question: 'Efort ciudat?', effort: 'maxim' })).json();
  await finish(odd.id);
  const rec = await (await fetch(`${base}/api/p/${odd.id}`)).json();
  assert.equal(rec.request.effort, cat.defaultEffort);
});
