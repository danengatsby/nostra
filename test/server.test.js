'use strict';
// Fluxul complet prin HTTP, în modul demonstrativ: cerere → progres (SSE) → previziune salvată → cache → limite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '5';
process.env.RATE_PER_HOUR = '4';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-test-'));

const { app } = require('../server');

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

const post = (body) => fetch(`${base}/api/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.com', ...body }) });

async function readEvents(id) {
  const res = await fetch(`${base}/api/predict/${id}/events`);
  assert.ok(res.headers.get("content-type").startsWith("text/event-stream"));
  const text = await res.text(); // serverul închide fluxul după „done”/„error”
  return [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
}

test('o previziune completă, apoi servită din cache', async () => {
  const body = { private: false, domain: 'piete', horizon: '1m', region: 'ro', lang: 'ro', question: 'Unde va fi cursul EUR/RON?' };
  const res = await post(body);
  assert.equal(res.status, 200);
  const { id, cached } = await res.json();
  assert.equal(cached, false);

  const events = await readEvents(id);
  const types = events.map(([t]) => t);
  assert.ok(types.includes('search'));
  assert.equal(types.at(-1), 'done');

  const rec = await (await fetch(`${base}/api/p/${id}`)).json();
  assert.equal(rec.request.question, body.question);
  assert.ok(rec.prediction.title);
  assert.equal(rec.meta.usage, undefined, 'detaliile de cost nu sunt publice');

  // Reconectarea după terminare primește direct „done”.
  assert.deepEqual((await readEvents(id)).map(([t]) => t), ['done']);

  // Aceeași întrebare (altfel scrisă) → același rezultat, fără un nou apel.
  const again = await (await post({ ...body, question: '  unde va fi CURSUL eur/ron? ' })).json();
  assert.deepEqual([again.id, again.cached], [id, true]);
  assert.ok(again.etaSec >= 15);

  const recent = await (await fetch(`${base}/api/recent`)).json();
  assert.equal(recent[0].id, id);
});

test('validarea cererii', async () => {
  assert.equal((await post({ horizon: '1m' })).status, 400);
  assert.equal((await post({ domain: 'economie', horizon: '99y' })).status, 400);
  assert.equal((await post({ domain: 'altul', horizon: '1m', question: '' })).status, 400);
  assert.equal((await post({ domain: 'economie', horizon: '1m', question: 'x'.repeat(501) })).status, 400);
  const bad = await fetch(`${base}/api/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nu e json' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/p/inexistent123`)).status, 404);
  assert.equal((await fetch(`${base}/api/p/..%2F..%2Fpackage`)).status, 404);
  assert.equal((await fetch(`${base}/api/predict/inexistent123/events`)).status, 404);
});

test('previzualizarea linkului: etichete și imagine proprii previziunii', async () => {
  const body = { private: false, domain: 'clima', horizon: '6m', region: 'eu', lang: 'ro', question: 'Iarnă <b>caldă</b>?' };
  const { id } = await (await post(body)).json();
  await readEvents(id);

  const html = await (await fetch(`${base}/p/${id}`)).text();
  assert.match(html, /<meta property="og:title" content="Previziune demonstrativă: Iarnă &lt;b&gt;caldă&lt;\/b&gt;\?">/);
  assert.match(html, new RegExp(`<meta property="og:image" content="https://nostradamus.my/og/${id}.png">`));
  assert.match(html, /<title>Previziune demonstrativă/);
  assert.doesNotMatch(html, /<b>caldă<\/b>/, 'textul utilizatorului e scăpat');

  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /og\/site\.png/);

  const png = await fetch(`${base}/og/${id}.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  assert.equal((await fetch(`${base}/og/inexistent123.png`)).status, 404);

  assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), new RegExp(`/p/${id}</loc>`));
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Sitemap: https:\/\/nostradamus.my\/sitemap.xml/);
});

test('limita pe oră per vizitator', async () => {
  // Primele două teste au consumat deja 2 din 4.
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const res = await post({ domain: 'sport', horizon: '1y', region: 'global', lang: 'en', question: `Întrebarea ${i}` });
    statuses.push(res.status);
    if (res.status === 200) await readEvents((await res.json()).id);
    else assert.match((await res.json()).error, /limita/);
  }
  assert.deepEqual(statuses, [200, 200, 429]);
});

test('pagini și antete de securitate', async () => {
  for (const p of ['/', '/p/abcdefgh123']) {
    const res = await fetch(base + p);
    assert.equal(res.status, p === '/' ? 200 : 404);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await res.text(), /Nostradamus/);
  }
  const cat = await (await fetch(`${base}/api/catalog`)).json();
  assert.ok(cat.domains.length > 5);
  assert.equal(cat.domains[0].hint, undefined);
});

test('API: verificarea fiecărei afirmații și palmaresul', async () => {
  const [first] = await (await fetch(`${base}/api/recent`)).json();
  const rec = await (await fetch(`${base}/api/p/${first.id}`)).json();
  assert.equal(rec.checks.length, rec.prediction.predictions.length);
  assert.equal(rec.checks[0].status, 'pending');
  assert.match(rec.checks[0].resolveBy, /^\d{4}-\d{2}-\d{2}$/);

  const tr = await (await fetch(`${base}/api/track-record`)).json();
  assert.equal(tr.resolved, 0);
  assert.ok(tr.pending > 0);
  assert.equal(tr.buckets.length, 5);
});

test('scriptul și stilurile au versiune în adresă (fără cache vechi după actualizări)', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const v = /src="\/app\.js\?v=([0-9a-f]{10})"/.exec(html)?.[1];
  assert.ok(v, 'app.js are versiune');
  assert.match(html, new RegExp(`href="/style\\.css\\?v=${v}"`));
  const js = await fetch(`${base}/app.js?v=${v}`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /renderEffortHint/);
});

test('catalogul acceptă exclusiv domenii și orizonturi proprii', async () => {
  for (const overrides of [{ domain: 'constructor' }, { horizon: '__proto__' }]) {
    assert.equal((await post({ domain: 'sport', horizon: '1m', ...overrides })).status, 400);
  }
});

test('prima pagină are butonul ASTRO-HOROSCOP către astrohor.fun, în aceeași filă', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const button = html.match(/<a id="astro-header"[^>]*>[^<]*<\/a>/)?.[0];
  assert.ok(button, 'butonul există în antet');
  assert.match(button, /href="https:\/\/astrohor\.fun\/"/);
  assert.match(button, />ASTRO-HOROSCOP</);
  assert.doesNotMatch(button, /target=/);
});
