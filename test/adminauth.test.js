'use strict';
// Accesul la statistici fără parolă: link de unică folosință pe email → cookie → butonul „Statistici”.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DEMO_MODE = '1';
process.env.MAIL_CAPTURE = '1';
process.env.ADMIN_EMAILS = 'sef@example.com, Doi@Example.com';
process.env.ADMIN_PASSWORD = 'parola-corecta';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-adminauth-'));

const { app } = require('../server');
const mail = require('../lib/mail');

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

const form = (url, data, headers = {}) => fetch(base + url, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data),
});
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const me = async (cookie) => (await (await fetch(`${base}/api/me`, { headers: cookie ? { Cookie: cookie } : {} })).json()).admin;

test('fără acces: butonul nu apare, /admin arată pagina de acces', async () => {
  assert.equal(await me(), false);
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Trimite-mi linkul de acces/);
  assert.doesNotMatch(html, /cheltuit azi/);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /id="stats"[^>]*hidden/);
});

test('linkul pe email: doar pentru adresele de administrator, de unică folosință, apoi acces 180 de zile', async () => {
  const before = mail._sent.length;
  const other = await (await form('/admin/link', { email: 'altcineva@example.com' })).text();
  assert.equal(mail._sent.length, before, 'altă adresă nu primește nimic');
  const mine = await (await form('/admin/link', { email: 'doi@example.com' })).text(); // fără deosebire de majuscule
  assert.equal(other.replace(/\s+/g, ' '), mine.replace(/\s+/g, ' '), 'același răspuns: pagina nu dezvăluie cine are acces');

  const msg = mail._sent.at(-1);
  assert.equal(msg.to, 'doi@example.com');
  const link = /(\/admin\/acces\?t=[A-Za-z0-9_-]+)/.exec(msg.text)[1];

  const open = await fetch(base + link, { redirect: 'manual' });
  assert.equal(open.status, 303);
  assert.equal(open.headers.get('location'), '/admin');
  const sc = open.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Max-Age=15552000/);
  const cookie = cookieOf(open);

  assert.equal(await me(cookie), true, 'butonul „Statistici” apare');
  const stats = await fetch(`${base}/admin`, { headers: { Cookie: cookie } });
  assert.equal(stats.status, 200);
  assert.match(await stats.text(), /Nostradamus — statistici/);

  assert.equal((await fetch(base + link, { redirect: 'manual' })).status, 400, 'linkul nu merge a doua oară');

  // Un cookie modificat nu trece.
  const forged = cookie.replace(/\.(.)/, (m, c) => `.${c === 'A' ? 'B' : 'A'}`);
  assert.equal((await fetch(`${base}/admin`, { headers: { Cookie: forged } })).status, 401);

  // Scoasă din ADMIN_EMAILS, adresa pierde accesul.
  process.env.ADMIN_EMAILS = 'sef@example.com';
  assert.equal(await me(cookie), false);
  process.env.ADMIN_EMAILS = 'sef@example.com, Doi@Example.com';
});

test('cel mult 3 linkuri pe oră pentru aceeași adresă', async () => {
  const before = mail._sent.length;
  for (let i = 0; i < 5; i++) await form('/admin/link', { email: 'sef@example.com' });
  assert.equal(mail._sent.length - before, 3);
});

test('parola, ca rezervă: corectă → acces; greșită de prea multe ori → blocat o oră', async () => {
  assert.equal((await form('/admin/parola', { password: 'gresit' })).status, 401);
  const ok = await form('/admin/parola', { password: 'parola-corecta' });
  assert.equal(ok.status, 303);
  assert.equal(await me(cookieOf(ok)), true);
  for (let i = 0; i < 9; i++) await form('/admin/parola', { password: 'gresit' });
  assert.equal((await form('/admin/parola', { password: 'parola-corecta' })).status, 429);
});

test('ieșirea șterge accesul din browser', async () => {
  const res = await fetch(`${base}/admin/iesire`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /nostra_admin=;.*Max-Age=0/);
});
