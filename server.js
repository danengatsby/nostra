'use strict';
// Nostradamus — server web: servește interfața și API-ul de previziuni.

const path = require('node:path');
const fs = require('node:fs');

const envFile = path.join(__dirname, '.env');
// În teste (node --test) .env NU se încarcă: altfel testele ar folosi cheile reale (Stripe live, email, API).
const underTest = process.env.NODE_ENV === 'test' || !!process.env.NODE_TEST_CONTEXT;
if (!underTest && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const express = require('express');
const catalog = require('./lib/catalog');
const store = require('./lib/store');
const operations = require('./lib/operations');
const jobs = require('./lib/jobs');
const seo = require('./lib/seo');
const verify = require('./lib/verify');
const admin = require('./lib/admin');
const payments = require('./lib/payments');
const orders = require('./lib/orders');
const legal = require('./lib/legal');
const adminauth = require('./lib/adminauth');
const mail = require('./lib/mail');
const events = require('./lib/events');
const privacy = require('./lib/privacy');
const access = require('./lib/access-log');
const { t } = require('./lib/messages');

const PORT = Number(process.env.PORT || 3200);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "font-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  // Pe HTTPS (prin nginx), browserul ține minte un an că site-ul se deschide doar securizat.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// Webhook Stripe: plata confirmată direct de Stripe (semnătura se verifică pe corpul brut al cererii).
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = payments.webhookEvent(req.body, req.get('stripe-signature'));
  } catch (e) {
    console.warn('[webhook] respins:', e.message);
    return res.status(400).send('invalid');
  }
  try {
    const object = event.data.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      await orders.confirm(object.client_reference_id);
    } else if (['refund.updated', 'refund.failed'].includes(event.type)) {
      await orders.refreshRefund(object.metadata?.order_id, object.id);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[webhook]', e.message);
    res.status(500).send('error'); // Stripe reîncearcă
  }
});

app.use(express.json({ limit: '8kb' }));

// --- API ---

app.get('/healthz', (req, res) => {
  operations.database().prepare('SELECT id FROM jobs LIMIT 1').get();
  res.set('Cache-Control', 'no-store').json({ status: 'ok', pending: jobs.pending() });
});

app.get('/api/catalog', (req, res) => {
  const payment = { required: payments.mode() !== 'off', price: payments.priceLabel() };
  res.set('Cache-Control', 'public, max-age=300').json({ ...catalog.publicCatalog(), freeDisplay: true, formConversionEnabled: true, payment, contact: legal.company().email });
});

app.post('/api/form-visits', (req, res) => {
  const { id, event, device } = req.body || {};
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return res.sendStatus(400);
  if (event === 'visit' && ['mobile', 'desktop'].includes(device)) {
    operations.visitForm(id, device, catalog.screenEmailRequired());
  } else if (event === 'display') {
    if (!operations.displayReport(id)) return res.sendStatus(404);
  } else return res.sendStatus(400);
  res.status(204).end();
});

// Jurnalul accesărilor (tabelul „Accesări” din /admin): pagina deschisă sau un pas făcut în browser.
// Pașii de pe server (previziune cerută, plată, email) se adaugă direct, la cererile respective.
const CLIENT_STEPS = new Set(['report', 'deep_open', 'share']);
app.post('/api/visit', (req, res) => {
  const { id, path: page, lang, step, detail, utm, ref } = req.body || {};
  if (typeof id !== 'string' || !access.ID_RE.test(id)) return res.sendStatus(400);
  if (access.touch(id, req, { utm, ref, internal: !!adminauth.sessionEmail(req) })) {
    if (typeof page === 'string') access.page(id, page, lang);
    if (typeof step === 'string' && CLIENT_STEPS.has(step)) access.step(id, step, typeof detail === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(detail) ? detail : null);
  }
  res.status(204).end();
});

const uiLang = (v) => (v === 'en' ? 'en' : 'ro');
const visitOf = (body) => (typeof body?.visit === 'string' && access.ID_RE.test(body.visit) ? body.visit : null);

/**
 * Validează cererea venită din formular; întoarce un obiect curat sau aruncă un mesaj pentru utilizator,
 * în limba interfeței (`ui`).
 */
function parseRequest(body = {}, ui = 'ro') {
  const pick = (v, map, fallback) => (typeof v === 'string' && Object.hasOwn(map, v) ? v : fallback);
  const req = {
    domain: pick(body.domain, catalog.DOMAIN, null),
    horizon: pick(body.horizon, catalog.HORIZON, null),
    region: pick(body.region, catalog.REGION, 'global'),
    lang: catalog.LANGS.includes(body.lang) ? body.lang : 'ro',
    question: typeof body.question === 'string' ? body.question.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim() : '',
  };
  if (body.private !== false) req.private = true; // nu apare în listele publice și nu e indexată
  req.effort = catalog.EFFORT_IDS.includes(body.effort) ? body.effort : catalog.defaultEffort();
  if (!req.domain) throw new Error(t('pickDomain', ui));
  if (!req.horizon) throw new Error(t('pickHorizon', ui));
  if (req.question.length > 500) throw new Error(t('questionTooLong', ui));
  if (req.domain === 'altul' && req.question.length < 5) throw new Error(t('otherNeedsQuestion', ui));
  return req;
}

/** Durata tipică a unei previziuni cu modelul dat (media ultimelor 10), pentru estimarea afișată în așteptare. */
function etaSeconds(tier = 'main') {
  const d = store.all().slice(0, 40).map((s) => store.get(s.id)?.meta)
    .filter((m) => m?.durationMs && (m.tier || 'main') === tier).slice(0, 10).map((m) => m.durationMs);
  return d.length ? Math.max(15, Math.round(d.reduce((a, b) => a + b, 0) / d.length / 1000)) : (tier === 'lite' ? 40 : 120);
}

/** Mesajul unei limite atinse: când gratuitul s-a epuizat, amintim de analiza plătită, disponibilă oricând. */
const limitMessage = (e, ui) => (e.code === 'tired' && payments.mode() !== 'off' ? t('freeTired', ui, payments.priceLabel()) : e.message);

function requestEmail(body, ui) {
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email) return { error: t('emailRequired', ui) };
  if (email.length > 254 || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/.test(email)) return { error: t('emailInvalid', ui) };
  return { email };
}

function deliveryEmail(body, ui) {
  const contact = requestEmail(body, ui);
  if (contact.error) return contact;
  if (body?.consent !== true) return { error: t('consentRequired', ui) };
  return contact;
}

app.post('/api/predict', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ui = uiLang(req.body?.ui);
  let request;
  try {
    if (req.body?.delivery !== undefined && !['screen', 'email'].includes(req.body.delivery)) throw new Error(t('badRequest', ui));
    request = parseRequest(req.body, ui);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const screen = req.body.delivery === 'screen' || (req.body.delivery === undefined && payments.mode() === 'off');
  if (screen && (catalog.screenEmailRequired() || req.body.email)) {
    const contact = requestEmail(req.body, ui);
    if (contact.error) return res.status(400).json({ error: !req.body.email ? t('screenEmailRequired', ui) : contact.error });
  }
  try {
    if (req.body?.delivery === 'email' && payments.mode() === 'off') return res.status(503).json({ error: t('paymentsOff', ui) });
    const privateScope = request.private ? privacy.sessionScope(req, privacy.protectResponse(res)) : null;
    if (payments.mode() !== 'off' && req.body?.delivery !== 'screen') {
      // Fără acordul bifat (termeni + furnizare imediată a conținutului digital) nu se deschide plata.
      // Adresa la care trimitem previziunea: obligatorie cu plata activă.
      const { email, error } = deliveryEmail(req.body, ui);
      if (error) return res.status(400).json({ error });
      // Analiza aprofundată: modelul principal, cu efortul plătit (implicit înalt), indiferent de alegerea din formular.
      request.effort = catalog.paidEffort();
      // Cu plăți active, previziunea pornește abia după ce Stripe confirmă plata.
      const order = await orders.create(request, ui, req.ip, seo.BASE_URL_FOR(req), email, privateScope, { visit: visitOf(req.body) });
      access.step(visitOf(req.body), 'checkout', order.orderId.slice(0, 8));
      return res.json({ ...order, etaSec: etaSeconds('main') });
    }
    const result = jobs.submit(request, req.ip, ui, { privateScope });
    operations.count('screen');
    access.step(visitOf(req.body), result.cached ? 'free_cached' : 'free', result.id);
    res.json({ ...result, etaSec: etaSeconds(jobs.get(result.id)?.tier || catalog.freeTier()) });
  } catch (e) {
    if (e instanceof jobs.LimitError) return res.status(e.status).json({ error: limitMessage(e, ui) });
    console.error('[predict]', e?.message || e);
    res.status(500).json({ error: t(payments.mode() !== 'off' && req.body?.delivery !== 'screen' ? 'paymentError' : 'internal', ui) });
  }
});

// După o previziune rapidă (gratuită) se poate cere analiza aprofundată a aceleiași întrebări: o generare nouă,
// plătită, cu modelul principal; rezultatul apare pe ecran și se trimite pe email.
app.post('/api/p/:id/upgrade', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ui = uiLang(req.body?.ui);
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: t('notFound', ui) });
  if (rec.request.private) privacy.protectResponse(res);
  if (payments.mode() === 'off') return res.status(503).json({ error: t('paymentsOff', ui) });
  if (rec.prediction.declined) return res.status(400).json({ error: t('refused', ui) });
  if ((rec.meta?.tier || 'main') !== 'lite') return res.status(400).json({ error: t('alreadyDeep', ui) });
  const { email, error } = deliveryEmail(req.body, ui);
  if (error) return res.status(400).json({ error });
  try {
    const request = { ...rec.request, effort: catalog.paidEffort() };
    const privateScope = request.private ? privacy.sessionScope(req, res) : null;
    const order = await orders.create(request, ui, req.ip, seo.BASE_URL_FOR(req), email, privateScope, { upgradeOf: rec.id, visit: visitOf(req.body) });
    access.step(visitOf(req.body), 'checkout', order.orderId.slice(0, 8));
    res.json({ ...order, etaSec: etaSeconds('main') });
  } catch (e) {
    if (e instanceof jobs.LimitError) return res.status(e.status).json({ error: limitMessage(e, ui) });
    console.error('[email checkout]', e?.message || e);
    res.status(500).json({ error: t('paymentError', ui) });
  }
});

// Întoarcerea de pe pagina de plată: verificăm plata la Stripe și pornim previziunea.
app.post('/api/orders/:id/confirm', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (orders.get(req.params.id)?.request.private) privacy.protectResponse(res);
  const ui = uiLang(req.body?.ui);
  try {
    const st = await orders.confirm(req.params.id);
    if (!st) return res.status(404).json({ error: t('orderNotFound', ui) });
    res.json(st);
  } catch (e) {
    console.error('[confirm]', e?.message || e);
    res.status(502).json({ error: t('unavailable', ui) });
  }
});

// Flux de progres (Server-Sent Events). Retrimite tot ce s-a întâmplat până acum, apoi evenimentele noi.
app.get('/api/predict/:id/events', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);
  const rec = !job ? store.get(id) : null;
  if (!job && !rec) return res.status(404).json({ error: t('notFound', uiLang(req.query.ui)) });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  if (job?.req?.private || rec?.request.private) privacy.protectResponse(res);
  res.flushHeaders();
  const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);

  if (!job || job.status === 'done') {
    send({ type: 'done', data: { id } });
    return res.end();
  }
  for (const ev of job.events) send(ev);
  if (job.status === 'error') return res.end();

  const onEvent = (ev) => {
    send(ev);
    if (ev.type === 'done' || ev.type === 'error') cleanup(true);
  };
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  const cleanup = (end) => {
    clearInterval(ping);
    job.bus.off('event', onEvent);
    if (end) res.end();
  };
  job.bus.on('event', onEvent);
  req.on('close', () => cleanup(false));
});

app.get('/api/p/:id', (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: t('notFound', uiLang(req.query.ui)) });
  const { id, createdAt, request, prediction, meta, verification } = rec;
  // Aceeași întrebare pusă la momente diferite: cum s-a schimbat scenariul de bază (doar previziuni publice).
  const series = request.private ? [] : store.series(request, rec.key.endsWith('|lite') ? 'lite' : 'main');
  const history = series.length > 1 ? series.map((s) => {
    const r = s.id === id ? rec : store.get(s.id);
    const base = r?.prediction.scenarios?.[0];
    return { id: s.id, createdAt: s.createdAt, base: base ? { name: base.name, probability: base.probability } : null };
  }) : [];
  // Se poate cere o versiune nouă când cea mai recentă din serie a ieșit din cache.
  const latest = series.length ? series[series.length - 1].createdAt : createdAt;
  const refreshable = Date.now() - Date.parse(latest) > catalog.HORIZON[request.horizon].cacheHours * 3600000;
  const items = new Map((verification?.items || []).map((it) => [it.index, it]));
  res.set('Cache-Control', 'public, max-age=300');
  if (request.private) privacy.protectResponse(res);
  const dates = prediction.predictions.map((claim, i) => verify.nextCheckTime(rec, claim, items.get(i))).filter(Number.isFinite);
  res.json({
    nextCheckAt: dates.length && process.env.VERIFY_ENABLED !== '0' ? new Date(Math.min(...dates)).toISOString() : null,
    id, createdAt, request, prediction, history, refreshable, refunded: meta.refunded === true,
    // Pentru fiecare afirmație: data verificării și, dacă a fost verificată, rezultatul.
    checks: prediction.predictions.map((p, i) => {
      const it = items.get(i);
      return { resolveBy: verify.resolveDate(rec, p), ...verify.checkResult(it) };
    }),
    meta: { searches: meta.searches, fetches: meta.fetches, consulted: meta.consulted, durationMs: meta.durationMs, tier: meta.tier || 'main' },
  });
});

// Palmaresul nefiltrat are cache; filtrele se validează înainte de a calcula grupul selectat.
let trackCache = { at: 0, data: null };
app.get('/api/track-record', (req, res) => {
  const filters = {};
  for (const [name, allowed] of [['domain', Object.keys(catalog.DOMAIN)], ['horizon', Object.keys(catalog.HORIZON)], ['tier', ['main', 'lite']]]) {
    const value = req.query[name];
    if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) return res.status(400).json({ error: 'Filtru invalid.' });
    if (value) filters[name] = value;
  }
  if (Object.keys(filters).length) return res.set('Cache-Control', 'public, max-age=300').json(verify.trackRecord(filters));
  if (Date.now() - trackCache.at > 300000) trackCache = { at: Date.now(), data: verify.trackRecord() };
  res.set('Cache-Control', 'public, max-age=300').json(trackCache.data);
});

app.get('/api/example', (req, res) => res.set('Cache-Control', 'public, max-age=3600').json(require('./lib/example').example(uiLang(req.query.lang))));

app.get('/api/predict/:id/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = jobs.get(req.params.id);
  const rec = store.get(req.params.id);
  if (!job && !rec) return res.status(404).json({ error: t('notFound', uiLang(req.query.ui)) });
  if (job?.req?.private || rec?.request.private) privacy.protectResponse(res);
  res.json({ id: req.params.id, status: rec ? 'done' : job.status, createdAt: rec?.createdAt || job.createdAt,
    ...(job?.status === 'error' ? { message: [...job.events].reverse().find(e => e.type === 'error')?.data.message || t('failed', uiLang(req.query.ui)) } : {}),
  });
});

app.get('/api/recent', (req, res) => {
  res.set('Cache-Control', 'no-cache').json(store.recent(24));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- Interfața ---

// Termeni și confidențialitate.
app.get(['/termeni', '/terms'], (req, res) => res.set('Cache-Control', 'public, max-age=600').type('html').send(legal.render()));

// Administrare: contul (ADMIN_USER + parolă) sau linkul pe email (ADMIN_EMAILS).
app.get('/admin', admin.auth, admin.page);

// Accesul la statistici fără parolă: linkul de unică folosință trimis pe email.
const adminForm = express.urlencoded({ extended: false, limit: '2kb' });
const ipKey = adminauth.ipKey;
app.post('/admin/link', adminForm, async (req, res) => {
  const email = String(req.body?.email || '').trim().slice(0, 254);
  const token = adminauth.allowLinkRequest(ipKey(req)) && adminauth.createLink(email);
  if (token) {
    try {
      await mail.sendAdminLink(email, `${seo.BASE_URL_FOR(req)}/admin/acces?t=${token}`, adminauth.LINK_MINUTES);
      events.log('admin', { what: 'link-trimis' });
    } catch (e) {
      console.error('[admin] linkul nu a putut fi trimis:', e.message);
    }
  }
  // Același răspuns pentru orice adresă: pagina nu dezvăluie cine are acces.
  admin.loginPage(res, 'Dacă adresa are acces la statistici, ți-am trimis un email cu linkul. Verifică și dosarul Spam.');
});
app.get('/admin/acces', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (!adminauth.allowLinkRequest(ipKey(req))) return admin.loginPage(res.status(429), '', 'Prea multe încercări.');
  const email = adminauth.consumeLink(req.query.t);
  if (!email) return admin.loginPage(res.status(400), '', 'Linkul a expirat sau a fost deja folosit. Cere unul nou.');
  adminauth.setSession(res, email);
  events.log('admin', { what: 'acces-prin-email' });
  res.redirect(303, '/admin');
});
app.post('/admin/parola', adminForm, (req, res) => {
  const k = ipKey(req);
  if (!adminauth.passwordAllowed(k)) return admin.loginPage(res.status(429), '', 'Prea multe încercări. Încearcă din nou peste o oră.');
  if (!adminauth.credentialsOk(req.body?.user, req.body?.password)) {
    adminauth.passwordFailed(k);
    return admin.loginPage(res.status(401), '', 'Utilizatorul sau parola nu sunt corecte.');
  }
  adminauth.setAccountSession(res);
  events.log('admin', { what: 'acces-cu-cont' });
  res.redirect(303, '/admin');
});
app.get('/admin/iesire', (req, res) => {
  adminauth.clearSession(res);
  res.redirect(303, '/');
});

// Imaginea de previzualizare a linkului: /og/site.png sau /og/<id>.png (generată o singură dată).
app.get('/og/:name.png', async (req, res) => {
  const { name } = req.params;
  const rec = name === 'site' ? null : store.get(name);
  if (name !== 'site' && (!rec || rec.prediction.declined)) return res.status(404).end();
  try {
    res.set('Cache-Control', 'public, max-age=86400');
    if (rec?.request.private) privacy.protectResponse(res);
    res.sendFile(await seo.ogImage(name, rec));
  } catch (e) {
    console.error('[og]', name, e.message);
    res.status(500).end();
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /api/\nDisallow: /pay/\nDisallow: /admin\nSitemap: ${seo.BASE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(seo.sitemap(store.recent(5000)));
});

// Service worker-ul nu se ține în cache, ca actualizările aplicației să ajungă imediat.
app.get('/sw.js', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, 'sw.js')));
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').set('Cache-Control', 'public, max-age=3600').sendFile(path.join(PUBLIC, 'manifest.webmanifest')));

app.use(express.static(PUBLIC, { index: false, maxAge: '1h' }));

// Pagina e aceeași aplicație, dar cu titlul, descrierea și imaginea previziunii puse de server,
// ca linkurile distribuite să arate previziunea, nu doar numele site-ului.
const sendPage = (res, rec, privateJob = false) => {
  res.set('Cache-Control', 'no-cache');
  if (rec?.request.private || privateJob) privacy.protectResponse(res);
  return res.type('html').send(seo.renderPage(rec));
};
app.get('/', (req, res) => sendPage(res, null));
app.get('/exemplu', (req, res) => res.set('X-Robots-Tag', 'noindex').type('html').send(seo.renderPage(null)));
app.get('/p/:id', (req, res) => {
  const rec = store.get(req.params.id);
  const job = jobs.get(req.params.id);
  if (!rec && !job) res.status(404).set('X-Robots-Tag', 'noindex');
  sendPage(res, rec, job?.req.private);
});
app.get('/pay/:id', (req, res) => privacy.protectResponse(res).type('html').send(seo.renderPage(null)));
app.use((req, res) => res.status(404).type('html').send(seo.renderPage(null)));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Cerere invalidă.' });
  console.error(err);
  res.status(500).json({ error: 'Eroare internă.' });
});

store.init();
orders.init();
if (require.main === module) {
  if (process.env.DEMO_MODE !== '1' && !process.env.ANTHROPIC_API_KEY) {
    console.warn('ATENȚIE: ANTHROPIC_API_KEY lipsește din .env — previziunile vor eșua. (Pentru probe: DEMO_MODE=1)');
  }
  jobs.recover(orders.finishRecoveredJob);
  verify.start();
  orders.startReconciler();
  access.start();
  if (payments.mode() !== 'off') console.log(`Plăți: ${payments.mode()} (${payments.priceLabel()} / previziune)`);
  app.listen(PORT, HOST, () => console.log(`Nostradamus pornit pe http://${HOST}:${PORT}${process.env.DEMO_MODE === '1' ? ' (DEMO)' : ''}`));

  // Oprirea fără pierderi (systemctl restart/stop): apelurile AI deja pornite se termină, ca să nu fie plătite
  // de două ori la reluare. Între timp site-ul răspunde normal, iar cererile noi așteaptă în coadă repornirea.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) {
      console.warn('[oprire] al doilea semnal: ies imediat; lucrările rămase se reiau la pornire.');
      process.exit(1);
    }
    stopping = true;
    const active = jobs.running();
    console.log(`[oprire] ${signal}: ${active ? `aștept ${active} previziuni în curs` : 'nicio previziune în curs'}; cererile noi se reiau după repornire.`);
    setTimeout(() => {
      console.warn('[oprire] timpul de așteptare a expirat; lucrările rămase se reiau la pornire.');
      process.exit(0);
    }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 9 * 60000));
    await Promise.all([jobs.drain(), verify.stop(), orders.stopReconciler()]);
    console.log('[oprire] gata.');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, parseRequest };
