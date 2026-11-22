'use strict';
// Accesul la statistici: contul (utilizator + parolă) sau linkul de unică folosință pe email → cookie → /admin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DEMO_MODE = '1';
process.env.MAIL_CAPTURE = '1';
process.env.ADMIN_EMAILS = 'sef@example.com, Doi@Example.com';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-adminauth-'));
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_USER;
process.env.ADMIN_PASSWORD_HASH = require('../lib/adminauth').hashPassword('parola-corecta');

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
// Browserul are acces la statistici? (/admin se deschide direct, fără pagina de autentificare)
const me = async (cookie) => (await fetch(`${base}/admin`, { headers: cookie ? { Cookie: cookie } : {} })).status === 200;

test('fără acces: butonul nu apare, /admin arată pagina de acces', async () => {
  assert.equal(await me(), false);
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Trimite-mi linkul de acces/);
  assert.match(html, /name="user"/);
  assert.match(html, /name="password"/);
  assert.doesNotMatch(html, /cheltuit azi/);
  const home = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(home, /id="stats"/, 'fără butonul „Statistici” în antet');
  assert.equal((await fetch(`${base}/api/me`)).status, 404);
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

  assert.equal(await me(cookie), true, '/admin se deschide direct');
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

test('contul: utilizator + parolă corecte → acces; greșite de prea multe ori → blocat o oră', async () => {
  assert.equal((await form('/admin/parola', { user: 'admin', password: 'gresit' })).status, 401);
  assert.equal((await form('/admin/parola', { user: 'altcineva', password: 'parola-corecta' })).status, 401);
  assert.equal((await form('/admin/parola', { password: 'parola-corecta' })).status, 401, 'fără utilizator nu se intră');
  const ok = await form('/admin/parola', { user: ' Admin ', password: 'parola-corecta' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/admin');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax; Max-Age=15552000/);
  assert.equal(await me(cookieOf(ok)), true);
  const page = await fetch(`${base}/admin`, { headers: { Cookie: cookieOf(ok) } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ieșire/);
  for (let i = 0; i < 7; i++) await form('/admin/parola', { user: 'admin', password: 'gresit' });
  assert.equal((await form('/admin/parola', { user: 'admin', password: 'parola-corecta' })).status, 429);
});

test('schimbarea parolei sau a utilizatorului închide sesiunile deschise înainte', async () => {
  require('../lib/adminauth')._reset();
  const cookie = cookieOf(await form('/admin/parola', { user: 'admin', password: 'parola-corecta' }));
  assert.equal(await me(cookie), true);
  const previous = process.env.ADMIN_PASSWORD_HASH;
  process.env.ADMIN_PASSWORD_HASH = require('../lib/adminauth').hashPassword('parola-noua-123');
  try {
    assert.equal(await me(cookie), false);
  } finally { process.env.ADMIN_PASSWORD_HASH = previous; }
  assert.equal(await me(cookie), true);
  process.env.ADMIN_USER = 'sef';
  try {
    assert.equal(await me(cookie), false);
  } finally { delete process.env.ADMIN_USER; }
});

test('amprenta parolei: scrypt cu sare, fără parola în clar; formatele greșite sunt respinse', () => {
  const { hashPassword, verifyPassword } = require('../lib/adminauth');
  const a = hashPassword('o parolă lungă');
  const b = hashPassword('o parolă lungă');
  assert.notEqual(a, b, 'sare diferită la fiecare amprentă');
  assert.match(a, /^scrypt:16384:8:1:[\w-]+:[\w-]+$/);
  assert.doesNotMatch(a, /parolă/);
  assert.equal(verifyPassword('o parolă lungă', a), true);
  assert.equal(verifyPassword('o parola lunga', a), false);
  for (const bad of ['', 'scrypt', 'bcrypt:1:2:3:4:5', 'scrypt:16384:8:1::', null]) assert.equal(verifyPassword('x', bad), false);
});

test('varianta veche ADMIN_PASSWORD (în clar) funcționează doar fără amprentă', async () => {
  require('../lib/adminauth')._reset();
  const previous = process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD_HASH;
  process.env.ADMIN_PASSWORD = 'parola-veche';
  try {
    assert.equal((await form('/admin/parola', { user: 'admin', password: 'parola-veche' })).status, 303);
    process.env.ADMIN_PASSWORD_HASH = previous;
    assert.equal((await form('/admin/parola', { user: 'admin', password: 'parola-veche' })).status, 401);
  } finally { delete process.env.ADMIN_PASSWORD; process.env.ADMIN_PASSWORD_HASH = previous; }
});

test('ieșirea șterge accesul din browser', async () => {
  const res = await fetch(`${base}/admin/iesire`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /nostra_admin=;.*Max-Age=0/);
});

test('o adresă singură nu emite sesiune și lista administratorilor rămâne privată', async () => {
  for (const route of ['/admin/email-acces', '/api/admin/check']) {
    const res = await form(route, { email: 'sef@example.com' });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('set-cookie'), null);
  }
});

test('Basic cere utilizatorul și parola contului și împarte limita cu formularul', async () => {
  require('../lib/adminauth')._reset();
  const basic = (pair) => fetch(base + '/admin', { headers: { Authorization: 'Basic ' + Buffer.from(pair).toString('base64') } });
  assert.equal((await basic('admin:parola-corecta')).status, 200);
  assert.equal((await basic('altcineva:parola-corecta')).status, 401);
  for (let i = 0; i < 9; i++) await basic('admin:wrong');
  assert.equal((await form('/admin/parola', { user: 'admin', password: 'parola-corecta' })).status, 429);
});

test('npm run admin-cont: scrie utilizatorul și amprenta, șterge parola în clar, păstrează restul', (t) => {
  const { execFileSync } = require('node:child_process');
  const { verifyPassword } = require('../lib/adminauth');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostra-account-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'PORT=3200\nADMIN_PASSWORD=veche\nADMIN_EMAILS=sef@example.com\n');
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'deploy', 'admin-account.js'), '--env', env, '--user', 'Sef', '--generate'], { encoding: 'utf8' });
  const password = /Parola \(afișată o singură dată, păstreaz-o\): (\S+)/.exec(out)[1];
  assert.match(password, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  const text = fs.readFileSync(env, 'utf8');
  assert.match(text, /^PORT=3200$/m);
  assert.match(text, /^ADMIN_EMAILS=sef@example.com$/m);
  assert.match(text, /^ADMIN_USER=sef$/m);
  assert.doesNotMatch(text, /^ADMIN_PASSWORD=/m);
  assert.doesNotMatch(text, new RegExp(password));
  assert.equal(verifyPassword(password, /^ADMIN_PASSWORD_HASH=(.+)$/m.exec(text)[1]), true);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  // Valoarea se citește intactă de încărcătorul .env al lui Node (fără `$` interpretat).
  const loaded = execFileSync(process.execPath, ['-e', `process.loadEnvFile(${JSON.stringify(env)}); process.stdout.write(process.env.ADMIN_PASSWORD_HASH)`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(loaded, /^ADMIN_PASSWORD_HASH=(.+)$/m.exec(text)[1]);
});
