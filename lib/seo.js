'use strict';
// Previzualizarea linkurilor (WhatsApp, Facebook, X, LinkedIn…) și indexarea în motoarele de căutare:
// pagina /p/:id primește de la server titlul, rezumatul și o imagine 1200×630 proprie previziunii,
// desenată ca SVG și rasterizată cu ffmpeg (librsvg) și fonturile DejaVu ale sistemului.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DOMAIN, HORIZON, REGION } = require('./catalog');

const BASE_URL = (process.env.BASE_URL || 'https://nostradamus.my').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OG_DIR = path.join(DATA_DIR, 'og');
const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const SITE = {
  title: 'Nostradamus — previziuni din datele de azi',
  description: 'Nostradamus caută pe internet cele mai noi informații și face previziuni argumentate, cu probabilități, în economie, politică, tehnologie, sport și alte domenii.',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);

/** Pagina HTML cu etichetele potrivite: pentru o previziune (`rec`) sau pentru site. */
function renderPage(rec) {
  const p = rec?.prediction;
  const ok = p && !p.declined;
  const url = rec ? `${BASE_URL}/p/${rec.id}` : `${BASE_URL}/`;
  const title = ok ? `${p.title} — Nostradamus` : SITE.title;
  const description = ok ? clip(p.summary, 280) : SITE.description;
  const image = `${BASE_URL}/og/${ok ? rec.id : 'site'}.png`;
  const lang = rec?.request?.lang === 'en' ? 'en' : 'ro';

  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="${ok ? 'article' : 'website'}">`,
    '<meta property="og:site_name" content="Nostradamus">',
    `<meta property="og:locale" content="${lang === 'en' ? 'en_GB' : 'ro_RO'}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(ok ? p.title : SITE.title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    ok ? `<meta property="article:published_time" content="${esc(rec.createdAt)}">` : '',
    rec && (!ok || rec.request.private) ? '<meta name="robots" content="noindex">' : '',
  ].filter(Boolean).join('\n  ');

  return TEMPLATE
    .replace(/<html lang="[^"]*">/, `<html lang="${lang}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    .replace('</head>', `  ${tags}\n</head>`);
}

// ---------- imaginea de previzualizare ----------

/** Împarte textul în rânduri de cel mult `max` caractere; ultimul rând se termină cu „…” dacă nu încape. */
function wrap(text, max, lines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur ? `${cur} ${w}` : w).length <= max) cur = cur ? `${cur} ${w}` : w;
    else { out.push(cur || w.slice(0, max)); cur = cur ? w : ''; }
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  const used = out.join(' ').split(/\s+/).length;
  if (used < words.length) out[out.length - 1] = `${out[out.length - 1].replace(/[\s,.;:–-]+$/, '').slice(0, max - 1)}…`;
  return out;
}

const MARK = `<g transform="translate(64 50) scale(1.1)">
  <circle cx="32" cy="32" r="30" fill="#14152b" stroke="#e8c46a" stroke-width="2.5"/>
  <path d="M10 33c6-10 13.5-15 22-15s16 5 22 15c-6 10-13.5 15-22 15s-16-5-22-15z" fill="none" stroke="#e8c46a" stroke-width="2.5" stroke-linejoin="round"/>
  <circle cx="32" cy="33" r="8" fill="#e8c46a"/>
</g>`;

function svgFor(rec) {
  const W = 1200;
  const H = 630;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="g" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#23264a"/><stop offset="1" stop-color="#0f1020"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${MARK}
  <text x="150" y="104" font-family="DejaVu Serif" font-weight="bold" font-size="34" letter-spacing="4" fill="#e8c46a">NOSTRADAMUS</text>
  <text x="${W - 64}" y="104" text-anchor="end" font-family="DejaVu Sans" font-size="26" fill="#a5a7c8">nostradamus.my</text>`;

  if (!rec) {
    const lines = ['Previziuni construite din', 'ce se întâmplă acum în lume'];
    return `${head}
  ${lines.map((l, i) => `<text x="64" y="${270 + i * 76}" font-family="DejaVu Serif" font-weight="bold" font-size="62" fill="#ecebf5">${esc(l)}</text>`).join('\n  ')}
  <text x="64" y="470" font-family="DejaVu Sans" font-size="30" fill="#a5a7c8">Economie, politică, tehnologie, sport și altele —</text>
  <text x="64" y="512" font-family="DejaVu Sans" font-size="30" fill="#a5a7c8">cu probabilități și surse, de la o săptămână la 10 ani.</text>
</svg>`;
  }

  const { request: rq, prediction: p } = rec;
  const en = rq.lang === 'en';
  const meta = [DOMAIN[rq.domain]?.[en ? 'en' : 'ro'], HORIZON[rq.horizon]?.[en ? 'en' : 'ro'], REGION[rq.region]?.[en ? 'en' : 'ro']].filter(Boolean).join('  ·  ');
  const title = wrap(p.title, 34, 3);
  const base = [...p.scenarios].sort((a, b) => b.probability - a.probability)[0];
  const titleY = 230;
  const scenarioY = 470;

  return `${head}
  <text x="64" y="176" font-family="DejaVu Sans" font-size="26" fill="#e8c46a">${esc(meta.toUpperCase())}</text>
  ${title.map((l, i) => `<text x="64" y="${titleY + 20 + i * 64}" font-family="DejaVu Serif" font-weight="bold" font-size="52" fill="#ecebf5">${esc(l)}</text>`).join('\n  ')}
  ${base ? `<rect x="64" y="${scenarioY}" width="${W - 128}" height="96" rx="18" fill="#1a1c36" stroke="#2e3260" stroke-width="2"/>
  <text x="96" y="${scenarioY + 60}" font-family="DejaVu Sans" font-size="30" fill="#ecebf5">${esc(wrap(base.name, 52, 1)[0])}</text>
  <text x="${W - 96}" y="${scenarioY + 64}" text-anchor="end" font-family="DejaVu Sans" font-weight="bold" font-size="46" fill="#e8c46a">${base.probability}%</text>` : ''}
</svg>`;
}

const pending = new Map(); // id -> Promise, ca două cereri simultane să nu ruleze ffmpeg de două ori

/** Calea către PNG-ul de previzualizare (generat la prima cerere). `rec` null = imaginea site-ului. */
function ogImage(id, rec) {
  const dest = path.join(OG_DIR, `${id}.png`);
  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (pending.has(id)) return pending.get(id);
  const job = new Promise((resolve, reject) => {
    fs.mkdirSync(OG_DIR, { recursive: true });
    const src = path.join(OG_DIR, `${id}.svg`);
    const tmp = path.join(OG_DIR, `${id}.tmp.png`);
    fs.writeFileSync(src, svgFor(rec));
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'image2', tmp], { timeout: 20000 }, (err) => {
      fs.rmSync(src, { force: true });
      if (err) { fs.rmSync(tmp, { force: true }); return reject(err); }
      fs.renameSync(tmp, dest);
      resolve(dest);
    });
  }).finally(() => pending.delete(id));
  pending.set(id, job);
  return job;
}

function sitemap(entries) {
  const urls = [`  <url><loc>${BASE_URL}/</loc><changefreq>daily</changefreq></url>`,
    ...entries.map((r) => `  <url><loc>${BASE_URL}/p/${r.id}</loc><lastmod>${r.createdAt.slice(0, 10)}</lastmod></url>`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** Adresa publică pentru linkurile de întoarcere (BASE_URL dacă e setată; altfel cea a cererii, pentru probe locale). */
const BASE_URL_FOR = (req) => (process.env.BASE_URL ? BASE_URL : `${req.protocol}://${req.get('host')}`);

module.exports = { renderPage, ogImage, svgFor, sitemap, wrap, BASE_URL, BASE_URL_FOR };
