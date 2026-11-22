'use strict';
// Tabelul „Accesări” din /admin: vizite cu IP, locație, sursă, dispozitiv, pagini și pași, comanda pornită.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-access-'));
process.env.DEMO_MODE = '1';
process.env.DEMO_STEP_MS = '2';
process.env.PAYMENT_DEMO = '1';
process.env.MAIL_CAPTURE = '1';
process.env.RATE_PER_HOUR = '50';
process.env.GEOIP_CITY_DB = path.join(process.env.DATA_DIR, 'lipsa.mmdb');
process.env.GEOIP_DB = path.join(process.env.DATA_DIR, 'lipsa-tari.mmdb');
delete process.env.STRIPE_SECRET_KEY;
delete process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD_HASH = require('../lib/adminauth').hashPassword('parola-de-test');

const { app } = require('../server');
const access = require('../lib/access-log');
const orders = require('../lib/orders');

let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const ID = 'a'.repeat(32);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7', 'User-Agent': UA, ...headers }, body: JSON.stringify(body) });
const basic = { Authorization: 'Basic ' + Buffer.from('admin:parola-de-test').toString('base64') };
const adminHtml = async (query = '') => (await fetch(`${base}/admin${query}`, { headers: basic })).text();

test('dispozitivul și sursa se deduc pe scurt, fără a păstra agentul sau adresa completă', () => {
  assert.equal(access.device(UA), 'iPhone · Safari');
  assert.equal(access.device('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36 Edg/148.0'), 'Windows · Edge');
  assert.equal(access.device('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'robot · Googlebot');
  assert.equal(access.sourceOf({}), 'direct');
  assert.equal(access.sourceOf({ ref: 'www.google.ro' }), 'google');
  assert.equal(access.sourceOf({ ref: 'l.facebook.com' }), 'facebook');
  assert.equal(access.sourceOf({ utm: 'postare-luni', ref: 'l.facebook.com' }), 'postare-luni');
  assert.equal(access.sourceOf({ ref: 'astrohor.fun' }), 'astrohoroscop');
  assert.equal(access.sourceOf({ ref: 'nostradamus.my' }), 'paginile-site-ului');
  assert.equal(access.sourceOf({ ref: 'blog.exemplu.ro' }), 'blog.exemplu.ro');
});

test('vizita: prima cerere fixează IP-ul, sursa și dispozitivul; paginile și pașii se adaugă în ordine', async () => {
  assert.equal((await post('/api/visit', { id: 'nu-e-valid', path: '/' })).status, 400);
  assert.equal((await post('/api/visit', { id: ID, path: '/', lang: 'ro', utm: '', ref: 'www.google.com' })).status, 204);
  await post('/api/visit', { id: ID, path: '/exemplu', ref: 'altceva.ro' }, { 'X-Forwarded-For': '198.51.100.99' });
  await post('/api/visit', { id: ID, path: '/<script>' });
  await post('/api/visit', { id: ID, step: 'necunoscut' });
  const [visit] = access.list().rows;
  assert.equal(visit.ip, '203.0.113.7', 'IP-ul primei cereri');
  assert.equal(visit.source, 'google', 'sursa primei cereri');
  assert.equal(visit.device, 'iPhone · Safari');
  assert.equal(visit.country, null, 'fără bază de localizare, locația e necunoscută');
  assert.deepEqual(visit.steps.map((s) => s.name), ['/', '/exemplu', '(altă pagină)']);
});

test('previziunea rapidă, analiza aprofundată și plata apar ca pași, iar comanda în coloana „Comanda”', async () => {
  const base_ = { domain: 'economie', horizon: '1m', region: 'ro', lang: 'ro', private: false, visit: ID };
  const free = await (await post('/api/predict', { ...base_, question: 'Jurnal?', delivery: 'screen' })).json();
  await fetch(`${base}/api/predict/${free.id}/events`).then((r) => r.text());
  await post('/api/visit', { id: ID, path: `/p/${free.id}` });
  await post('/api/visit', { id: ID, step: 'report', detail: free.id });
  await post('/api/visit', { id: ID, step: 'deep_open', detail: free.id });
  const upgrade = await (await post(`/api/p/${free.id}/upgrade`, { email: 'client@example.com', consent: true, visit: ID })).json();
  assert.equal(orders.get(upgrade.orderId).visit, ID);
  const confirmed = await orders.confirm(upgrade.orderId);
  await fetch(`${base}/api/predict/${confirmed.predictionId}/events`).then((r) => r.text());
  await orders.reconcile();
  const names = access.list().rows[0].steps.filter((s) => s.kind === 'step').map((s) => s.name);
  assert.deepEqual(names, ['free', 'report', 'deep_open', 'checkout', 'paid', 'delivered']);

  const html = await adminHtml();
  assert.match(html, /<h2 id="accesari">Accesări<\/h2>/);
  for (const head of ['Data', 'Ora', 'IP', 'Locația', 'Sursa', 'Dispozitiv', 'Pagini și pași', 'Comanda']) assert.match(html, new RegExp(`<th>${head}</th>`));
  assert.match(html, /203\.0\.113\.7/);
  assert.match(html, /Necunoscută/);
  assert.match(html, /previziune rapidă cerută/);
  assert.match(html, /plată începută/);
  assert.match(html, new RegExp(`<span class="tag">${upgrade.orderId.slice(0, 8)}</span> trimisă prin email`));
  assert.doesNotMatch(html, /client@example\.com/, 'emailul nu apare în jurnal');
  assert.doesNotMatch(html, /&lt;script|<script>/, 'căile ciudate nu ajung în pagină');
});

test('vizitele din browserele conectate ca administrator sunt ascunse implicit și marcate', async () => {
  const login = await fetch(`${base}/admin/parola`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: 'admin', password: 'parola-de-test' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const mine = 'b'.repeat(32);
  await post('/api/visit', { id: mine, path: '/' }, { Cookie: cookie, 'X-Forwarded-For': '192.0.2.200' });
  assert.doesNotMatch(await adminHtml(), /192\.0\.2\.200/);
  assert.match(await adminHtml(), /Vizitele din browserele conectate ca administrator \(1\) sunt ascunse/);
  const all = await adminHtml('?toate=1');
  assert.match(all, /192\.0\.2\.200/);
  assert.match(all, /tu \(admin\)/);
});

test('vizitele mai vechi de 14 zile se șterg; jurnalul nu intră în backup', () => {
  const old = 'c'.repeat(32);
  access.touch(old, { ip: '192.0.2.50', get: () => '' }, {}, Date.now() - 15 * 86400000);
  access.step(old, 'report', null, Date.now() - 15 * 86400000);
  assert.ok(access.purge() >= 1);
  assert.ok(!access.list({ includeInternal: true, at: Date.now() + 86400000 }).rows.some((v) => v.ip === '192.0.2.50'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'deploy', 'backup.sh'), 'utf8'), /--exclude='data\/access\.db\*'/);
  assert.equal(fs.statSync(path.join(process.env.DATA_DIR, 'access.db')).mode & 0o777, 0o600);
});
