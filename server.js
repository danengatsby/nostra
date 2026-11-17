'use strict';
// Nostradamus — server web: servește interfața și API-ul de previziuni.

const path = require('node:path');
const fs = require('node:fs');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const express = require('express');
const catalog = require('./lib/catalog');
const store = require('./lib/store');
const jobs = require('./lib/jobs');
const seo = require('./lib/seo');
const verify = require('./lib/verify');
const admin = require('./lib/admin');
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
  next();
});

app.use(express.json({ limit: '8kb' }));

// --- API ---

app.get('/api/catalog', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').json(catalog.publicCatalog());
});

const uiLang = (v) => (v === 'en' ? 'en' : 'ro');

/**
 * Validează cererea venită din formular; întoarce un obiect curat sau aruncă un mesaj pentru utilizator,
 * în limba interfeței (`ui`).
 */
function parseRequest(body = {}, ui = 'ro') {
  const pick = (v, map, fallback) => (typeof v === 'string' && map[v] ? v : fallback);
  const req = {
    domain: pick(body.domain, catalog.DOMAIN, null),
    horizon: pick(body.horizon, catalog.HORIZON, null),
    region: pick(body.region, catalog.REGION, 'global'),
    lang: catalog.LANGS.includes(body.lang) ? body.lang : 'ro',
    question: typeof body.question === 'string' ? body.question.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim() : '',
  };
  if (body.private === true) req.private = true; // nu apare în listele publice și nu e indexată
  req.effort = catalog.EFFORT_IDS.includes(body.effort) ? body.effort : catalog.defaultEffort();
  if (!req.domain) throw new Error(t('pickDomain', ui));
  if (!req.horizon) throw new Error(t('pickHorizon', ui));
  if (req.question.length > 500) throw new Error(t('questionTooLong', ui));
  if (req.domain === 'altul' && req.question.length < 5) throw new Error(t('otherNeedsQuestion', ui));
  return req;
}

/** Durata tipică a unei previziuni (media ultimelor 10), pentru estimarea afișată în timpul așteptării. */
function etaSeconds() {
  const d = store.all().slice(0, 10).map((s) => store.get(s.id)?.meta?.durationMs).filter(Boolean);
  return d.length ? Math.max(15, Math.round(d.reduce((a, b) => a + b, 0) / d.length / 1000)) : 120;
}

app.post('/api/predict', (req, res) => {
  const ui = uiLang(req.body?.ui);
  let request;
  try {
    request = parseRequest(req.body, ui);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    res.json({ ...jobs.submit(request, req.ip, ui), etaSec: etaSeconds() });
  } catch (e) {
    if (e instanceof jobs.LimitError) return res.status(e.status).json({ error: e.message });
    console.error('[predict]', e);
    res.status(500).json({ error: t('internal', ui) });
  }
});

// Flux de progres (Server-Sent Events). Retrimite tot ce s-a întâmplat până acum, apoi evenimentele noi.
app.get('/api/predict/:id/events', (req, res) => {
  const { id } = req.params;
  const job = jobs.get(id);
  if (!job && !store.get(id)) return res.status(404).json({ error: t('notFound', uiLang(req.query.ui)) });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
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
  const series = request.private ? [] : store.series(rec.key);
  const history = series.length > 1 ? series.map((s) => {
    const r = s.id === id ? rec : store.get(s.id);
    const base = r?.prediction.scenarios?.[0];
    return { id: s.id, createdAt: s.createdAt, base: base ? { name: base.name, probability: base.probability } : null };
  }) : [];
  // Se poate cere o versiune nouă când cea mai recentă din serie a ieșit din cache.
  const latest = series.length ? series[series.length - 1].createdAt : createdAt;
  const refreshable = Date.now() - Date.parse(latest) > catalog.HORIZON[request.horizon].cacheHours * 3600000;
  const items = new Map((verification?.items || []).map((it) => [it.index, it]));
  res.set('Cache-Control', 'public, max-age=300').json({
    id, createdAt, request, prediction, history, refreshable,
    // Pentru fiecare afirmație: data verificării și, dacă a fost verificată, rezultatul.
    checks: prediction.predictions.map((p, i) => {
      const it = items.get(i);
      return { resolveBy: verify.resolveDate(rec, p), status: it?.status || 'pending', evidence: it?.evidence || '', url: it?.url || null };
    }),
    meta: { searches: meta.searches, fetches: meta.fetches, consulted: meta.consulted, durationMs: meta.durationMs },
  });
});

// Palmaresul oracolului (recalculat cel mult o dată la 5 minute).
let trackCache = { at: 0, data: null };
app.get('/api/track-record', (req, res) => {
  if (Date.now() - trackCache.at > 300000) trackCache = { at: Date.now(), data: verify.trackRecord() };
  res.set('Cache-Control', 'public, max-age=300').json(trackCache.data);
});

app.get('/api/recent', (req, res) => {
  res.set('Cache-Control', 'no-cache').json(store.recent(24));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- Interfața ---

// Administrare (parola din ADMIN_PASSWORD).
app.get('/admin', admin.auth, admin.page);

// Imaginea de previzualizare a linkului: /og/site.png sau /og/<id>.png (generată o singură dată).
app.get('/og/:name.png', async (req, res) => {
  const { name } = req.params;
  const rec = name === 'site' ? null : store.get(name);
  if (name !== 'site' && (!rec || rec.prediction.declined)) return res.status(404).end();
  try {
    res.set('Cache-Control', 'public, max-age=86400').sendFile(await seo.ogImage(name, rec));
  } catch (e) {
    console.error('[og]', name, e.message);
    res.status(500).end();
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /api/\nSitemap: ${seo.BASE_URL}/sitemap.xml\n`);
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
const sendPage = (res, rec) => res.set('Cache-Control', 'no-cache').type('html').send(seo.renderPage(rec));
app.get('/', (req, res) => sendPage(res, null));
app.get('/p/:id', (req, res) => sendPage(res, store.get(req.params.id)));
app.use((req, res) => res.status(404).type('html').send(seo.renderPage(null)));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Cerere invalidă.' });
  console.error(err);
  res.status(500).json({ error: 'Eroare internă.' });
});

store.init();
if (require.main === module) {
  if (process.env.DEMO_MODE !== '1' && !process.env.ANTHROPIC_API_KEY) {
    console.warn('ATENȚIE: ANTHROPIC_API_KEY lipsește din .env — previziunile vor eșua. (Pentru probe: DEMO_MODE=1)');
  }
  verify.start();
  app.listen(PORT, HOST, () => console.log(`Nostradamus pornit pe http://${HOST}:${PORT}${process.env.DEMO_MODE === '1' ? ' (DEMO)' : ''}`));
}

module.exports = { app, parseRequest };
