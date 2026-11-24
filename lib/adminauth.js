'use strict';
// Accesul la statistici: contul de administrare (utilizator + parolă, formular pe /admin sau HTTP Basic) sau,
// fără parolă, linkul de unică folosință trimis pe email adreselor din ADMIN_EMAILS (valabil 30 de minute).
// Contul folosește un cookie de sesiune. Accesul prin email este disponibil doar în instalările fără cont.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ipKey = req => crypto.createHash('sha256').update(`nostra-admin:${req.ip}`).digest('base64url').slice(0, 16);
const linkRequests = new Map();
function allowLinkRequest(key) {
  const now = Date.now();
  const recent = (linkRequests.get(key) || []).filter(t => now - t < 3600000);
  if (recent.length >= 20) return false;
  linkRequests.set(key, [...recent, now]);
  return true;
}
const COOKIE = 'nostra_admin';
const SESSION_DAYS = 180;
const LINK_MINUTES = 30;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const admins = () => (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const isAdminEmail = (email) => admins().includes(String(email || '').trim().toLowerCase());

// Cheia de semnare a cookie-urilor: din .env sau generată o dată și păstrată în data/ (doar pentru server).
let secret = null;
function getSecret() {
  if (secret) return secret;
  if (process.env.ADMIN_SESSION_SECRET) return (secret = process.env.ADMIN_SESSION_SECRET);
  const file = path.join(DATA_DIR, '.admin-secret');
  try {
    secret = fs.readFileSync(file, 'utf8').trim();
  } catch {
    secret = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return secret;
}

const sign = (data) => crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Linkurile emise: hash(token) → { email, exp }. În memorie: o repornire anulează linkurile neconsumate.
const links = new Map();
const sentLog = new Map(); // email → [timestamp-uri], cel mult 3 linkuri pe oră
const pwFails = new Map(); // amprentă IP → [timestamp-uri], cel mult 10 parole greșite pe oră

/** Creează un link de acces pentru o adresă de administrator (null dacă nu e cazul sau s-a depășit limita). */
function createLink(email) {
  if (!emailLoginEnabled() || !isAdminEmail(email)) return null;
  const key = email.trim().toLowerCase();
  const now = Date.now();
  const recent = (sentLog.get(key) || []).filter((t) => now - t < 3600000);
  if (recent.length >= 3) return null;
  sentLog.set(key, [...recent, now]);
  const token = crypto.randomBytes(32).toString('base64url');
  links.set(sha(token), { email: key, exp: now + LINK_MINUTES * 60000 });
  return token;
}

/** Consumă un link (o singură dată). Întoarce adresa sau null. */
function consumeLink(token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const k = sha(token);
  const entry = links.get(k);
  links.delete(k);
  return emailLoginEnabled() && entry && entry.exp > Date.now() && isAdminEmail(entry.email) ? entry.email : null;
}

// --- Contul de administrare: utilizator + parolă ---
// Utilizatorul: ADMIN_USER (implicit „admin”). Parola se păstrează doar ca amprentă scrypt în ADMIN_PASSWORD_HASH
// (o scrie `npm run admin-cont`); ADMIN_PASSWORD în clar rămâne acceptată pentru instalările vechi.
const adminUser = () => (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
const accountConfigured = () => !!(process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD);
const emailLoginEnabled = () => !accountConfigured() && admins().length > 0;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** Amprenta unei parole: `scrypt:N:r:p:sare:cheie` (fără `$`, ca să rămână neatinsă în .env). */
function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored || '').split(':');
  const expected = Buffer.from(key || '', 'base64url');
  if (kind !== 'scrypt' || !salt || expected.length < 16) return false;
  try {
    const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

const sameText = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

/** Utilizatorul și parola contului de administrare sunt corecte? (parola se verifică mereu, fără scurtături) */
function credentialsOk(user, password) {
  if (typeof user !== 'string' || typeof password !== 'string' || password.length > 200 || user.length > 100) return false;
  const stored = process.env.ADMIN_PASSWORD_HASH;
  const passwordMatches = stored ? verifyPassword(password, stored)
    : !!process.env.ADMIN_PASSWORD && sameText(password, process.env.ADMIN_PASSWORD);
  return sameText(user.trim().toLowerCase(), adminUser()) && passwordMatches;
}

// Sesiunea contului poartă o etichetă a parolei curente: schimbarea parolei închide sesiunile deschise cu cea veche.
const accountTag = () => sha(`nostra-account:${process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD || ''}`).slice(0, 16);
const accountSession = () => `account:${adminUser()}:${accountTag()}`;

/** Valoarea cookie-ului de sesiune pentru o adresă (sau pentru contul de administrare). */
function sessionValue(email) {
  const payload = Buffer.from(JSON.stringify({ version: email.startsWith('account:') ? 3 : 2, e: email, x: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function cookieHeader(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax${maxAgeSec === undefined ? '' : '; Max-Age=' + maxAgeSec}`;
}
const setSession = (res, email) => res.append('Set-Cookie', cookieHeader(sessionValue(email), SESSION_DAYS * 86400));
const clearSession = (res) => res.append('Set-Cookie', cookieHeader('', 0));

/** Adresa din cookie-ul valid al cererii, sau null. */
function sessionEmail(req) {
  const raw = (req.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig) || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { version, e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(x > Date.now()) || typeof e !== 'string') return null;
    // Contul: valabil cât utilizatorul și parola rămân aceleași. Emailul: cât adresa e încă în ADMIN_EMAILS.
    if (e.startsWith('account:')) return version === 3 && accountConfigured() && e === accountSession() ? e : null;
    return version === 2 && emailLoginEnabled() && isAdminEmail(e) ? e : null;
  } catch {
    return null;
  }
}

const setAccountSession = (res) => res.append('Set-Cookie', cookieHeader(sessionValue(accountSession())));

/** Limita de parole greșite (împotriva ghicirii). Întoarce false dacă IP-ul e blocat. */
function passwordAllowed(ipKey) {
  const now = Date.now();
  const list = (pwFails.get(ipKey) || []).filter((t) => now - t < 3600000);
  pwFails.set(ipKey, list);
  return list.length < 10;
}
const passwordFailed = (ipKey) => pwFails.set(ipKey, [...(pwFails.get(ipKey) || []), Date.now()]);

setInterval(() => {
  const now = Date.now();
  for (const table of [linkRequests, sentLog, pwFails]) {
    for (const [key, times] of table) if (!(times.at(-1) > now - 3600000)) table.delete(key);
  }
  for (const [key, link] of links) if (link.exp <= now) links.delete(key);
}, 60000).unref();

module.exports = {
  ipKey, allowLinkRequest, isAdminEmail, createLink, consumeLink, setSession, clearSession, sessionEmail, passwordAllowed, passwordFailed,
  adminUser, accountConfigured, emailLoginEnabled, hashPassword, verifyPassword, credentialsOk, setAccountSession,
  LINK_MINUTES, _reset: () => { linkRequests.clear(); links.clear(); sentLog.clear(); pwFails.clear(); },
};
