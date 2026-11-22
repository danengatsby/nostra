'use strict';
// Oprirea fără pierderi: previziunile pornite se termină, cele din coadă rămân pentru repornire.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '60';
process.env.MAX_CONCURRENT = '1';
process.env.RATE_PER_HOUR = '20';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-shutdown-'));

const store = require('../lib/store');
const jobs = require('../lib/jobs');
const operations = require('../lib/operations');

store.init();
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const REQ = (question) => ({ domain: 'sport', horizon: '1m', region: 'global', lang: 'ro', question });

test('la oprire, lucrarea pornită se termină, iar cele din coadă rămân salvate pentru repornire', async () => {
  const first = jobs.submit(REQ('Oprire: prima'), '10.0.0.1');
  const second = jobs.submit(REQ('Oprire: a doua'), '10.0.0.1');
  assert.equal(jobs.get(first.id).status, 'running');
  assert.equal(jobs.get(second.id).status, 'queued');

  let drained = false;
  const done = jobs.drain().then(() => { drained = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, false, 'oprirea așteaptă lucrarea pornită');

  // O cerere nouă în timpul opririi intră în coadă, fără să pornească.
  const third = jobs.submit(REQ('Oprire: a treia'), '10.0.0.1');
  await done;

  assert.ok(store.get(first.id), 'previziunea pornită a fost salvată');
  assert.equal(jobs.running(), 0);
  assert.equal(jobs.get(second.id).status, 'queued');
  assert.equal(jobs.get(third.id).status, 'queued');
  assert.deepEqual(operations.backlog().map((j) => j.id).sort(), [second.id, third.id].sort());
});

test('SIGTERM: serverul așteaptă previziunea în curs, apoi iese curat', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-sigterm-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'test', DEMO_MODE: '1', DEMO_STEP_MS: '200', DATA_DIR: dataDir, PORT: String(port),
      STRIPE_SECRET_KEY: '', PAYMENT_DEMO: '0', VERIFY_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !log.includes('Nostradamus pornit'); i++) await new Promise((r) => setTimeout(r, 50));
  const res = await fetch(`${base}/api/predict`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'sport', horizon: '1m', region: 'global', lang: 'ro', question: 'SIGTERM', delivery: 'screen', email: 'reader@example.com' }),
  });
  assert.equal(res.status, 200, log);
  const { id } = await res.json();

  child.kill('SIGTERM');
  // În timpul opririi site-ul răspunde în continuare.
  await new Promise((r) => setTimeout(r, 100));
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);

  assert.equal(await exited, 0, log);
  assert.match(log, /aștept 1 previziuni în curs/);
  assert.ok(fs.existsSync(path.join(dataDir, 'predictions', `${id}.json`)), 'previziunea s-a terminat înainte de ieșire');
});

test('HSTS doar pe cererile venite prin HTTPS (proxy local de încredere)', async (t) => {
  const { app } = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const plain = await fetch(`${base}/api/catalog`);
  assert.equal(plain.headers.get('strict-transport-security'), null);
  const secure = await fetch(`${base}/api/catalog`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000');
});
