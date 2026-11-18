'use strict';
// Accesul la statistici fără parolă: adresele din ADMIN_EMAILS primesc pe email un link de acces de unică
// folosință (valabil 30 de minute). Linkul pune în browser un cookie semnat, valabil 180 de zile; cât timp
// există, butonul „Statistici” apare pe site și /admin se deschide direct. Parola ADMIN_PASSWORD rămâne
// o variantă de rezervă (formular pe pagina de acces sau HTTP Basic).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
  if (!isAdminEmail(email)) return null;
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
  return entry && entry.exp > Date.now() ? entry.email : null;
}

/** Valoarea cookie-ului de sesiune pentru o adresă (sau pentru accesul cu parolă). */
function sessionValue(email) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function cookieHeader(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
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
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(x > Date.now())) return null;
    // Accesul prin email rămâne valabil doar cât adresa e încă în ADMIN_EMAILS.
    return e === 'password' || isAdminEmail(e) ? e : null;
  } catch {
    return null;
  }
}

const passwordOk = (given) => {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || typeof given !== 'string') return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(pw));
};

/** Limita de parole greșite (împotriva ghicirii). Întoarce false dacă IP-ul e blocat. */
function passwordAllowed(ipKey) {
  const now = Date.now();
  const list = (pwFails.get(ipKey) || []).filter((t) => now - t < 3600000);
  pwFails.set(ipKey, list);
  return list.length < 10;
}
const passwordFailed = (ipKey) => pwFails.set(ipKey, [...(pwFails.get(ipKey) || []), Date.now()]);

module.exports = {
  isAdminEmail, createLink, consumeLink, setSession, clearSession, sessionEmail, passwordOk, passwordAllowed, passwordFailed,
  LINK_MINUTES, _reset: () => { links.clear(); sentLog.clear(); pwFails.clear(); },
};
