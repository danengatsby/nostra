'use strict';
// Cookie funcțional de sesiune: izolează cache-ul privat fără cont și fără a folosi IP-ul/emailul.
const crypto = require('node:crypto');

const COOKIE = 'nostra_private';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const newScope = () => crypto.randomBytes(32).toString('base64url');

function sessionScope(req, res) {
  const raw = (req.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`));
  let token = raw?.slice(COOKIE.length + 1);
  if (!TOKEN_RE.test(token || '')) {
    token = newScope();
    res.cookie(COOKIE, token, { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/' });
  }
  // Pe disc ajunge doar amprenta, iar API-ul public nu expune nici amprenta, nici cookie-ul.
  return crypto.createHash('sha256').update(`nostra-private:${token}`).digest('hex');
}

function protectResponse(res) {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
  return res;
}

module.exports = { sessionScope, newScope, protectResponse };
