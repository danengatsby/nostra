'use strict';
// Forma unei previziuni: schema JSON (pentru ieșirea structurată a modelului) și
// curățarea răspunsului, astfel încât interfața să primească mereu date valide.

const CONFIDENCE = ['low', 'medium', 'high'];
const IMPACT = ['positive', 'negative', 'uncertain'];

const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});
const sourceSchema = obj({ title: str, url: str, published_at: str });

const PREDICTION_SCHEMA = obj({
  declined: { type: 'boolean' },
  declined_reason: str,
  title: str,
  summary: str,
  current_state: str,
  confidence: { type: 'string', enum: CONFIDENCE },
  scenarios: { type: 'array', items: obj({ name: str, probability: int, description: str, signals: { type: 'array', items: str } }) },
  predictions: { type: 'array', items: obj({ claim: str, probability: int, timeframe: str, resolve_by: str, resolution_criteria: str, confidence: { type: 'string', enum: CONFIDENCE }, rationale: str, sources: { type: 'array', items: sourceSchema } }) },
  drivers: { type: 'array', items: obj({ name: str, impact: { type: 'string', enum: IMPACT }, explanation: str }) },
  watch: { type: 'array', items: obj({ indicator: str, when: str }) },
  wildcards: { type: 'array', items: str },
  quatrain: str,
  sources: { type: 'array', items: sourceSchema },
});

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+\n/g, '\n').trim().slice(0, max) : '');
const pct = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(99, Math.max(1, n)) : 50;
};
/**
 * Un element care ar trebui să fie text poate veni de la model ca obiect (ex. {event, probability}).
 * În loc să-l pierdem, îl transformăm în text: câmpurile text unite, plus probabilitatea dacă există.
 */
function asText(v) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const parts = Object.values(v).filter((x) => typeof x === 'string' && x.trim());
  const prob = Object.entries(v).find(([k, x]) => /prob/i.test(k) && Number.isFinite(Number(x)));
  return parts.join(' — ') + (prob ? ` (~${Math.round(Number(prob[1]))}%)` : '');
}

/** Data (AAAA-LL-ZZ) la care rezultatul unei afirmații devine public; '' dacă lipsește sau e invalidă. */
function isoDate(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '').trim());
  return m && !Number.isNaN(Date.parse(m[1])) && new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) === m[1] ? m[1] : '';
}

const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** URL-urile pot diferi prin fragment sau slash final; păstrăm calea și query-ul sensibile la litere. */
function sourceKey(value) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}

function sanitizeSources(value, max = 30) {
  return list(value, max).map(s => ({ title: text(s?.title, 200), url: safeUrl(s?.url), published_at: isoDate(s?.published_at) })).filter(s => s.url);
}

/**
 * Curăță previziunea primită de la model: tipuri corecte, lungimi limitate, probabilități între 1 și 99,
 * iar scenariile normalizate astfel încât să însumeze 100%.
 */
function sanitizePrediction(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Răspuns fără obiect JSON');
  const p = {
    declined: raw.declined === true,
    declined_reason: text(raw.declined_reason, 600),
    title: text(raw.title, 160),
    summary: text(raw.summary, 1500),
    current_state: text(raw.current_state, 2500),
    confidence: oneOf(raw.confidence, CONFIDENCE, 'medium'),
    scenarios: list(raw.scenarios, 5).map((s) => ({
      name: text(s?.name, 120),
      probability: pct(s?.probability),
      description: text(s?.description, 1200),
      signals: list(s?.signals, 6).map((x) => text(asText(x), 300)).filter(Boolean),
    })).filter((s) => s.name),
    predictions: list(raw.predictions, 10).map((x) => ({
      claim: text(x?.claim, 500),
      probability: pct(x?.probability),
      timeframe: text(x?.timeframe, 120),
      resolve_by: isoDate(x?.resolve_by),
      resolution_criteria: text(x?.resolution_criteria, 1000),
      confidence: oneOf(x?.confidence, CONFIDENCE, 'medium'),
      rationale: text(x?.rationale, 1000),
      sources: sanitizeSources(x?.sources, 5),
    })).filter((x) => x.claim),
    drivers: list(raw.drivers, 10).map((d) => ({
      name: text(d?.name, 160),
      impact: oneOf(d?.impact, IMPACT, 'uncertain'),
      explanation: text(d?.explanation, 800),
    })).filter((d) => d.name),
    watch: list(raw.watch, 10).map((w) => ({ indicator: text(w?.indicator, 300), when: text(w?.when, 120) })).filter((w) => w.indicator),
    wildcards: list(raw.wildcards, 8).map((x) => text(asText(x), 500)).filter(Boolean),
    quatrain: text(raw.quatrain, 600),
    sources: sanitizeSources(raw.sources),
  };

  // Scenariile se exclud reciproc: le aducem la un total de 100%.
  const total = p.scenarios.reduce((a, s) => a + s.probability, 0);
  if (total > 0 && total !== 100) {
    p.scenarios.forEach((s) => { s.probability = Math.round((s.probability * 100) / total); });
    const diff = 100 - p.scenarios.reduce((a, s) => a + s.probability, 0);
    if (p.scenarios.length) p.scenarios[0].probability += diff;
  }

  if (!p.declined && (!p.title || !p.summary || !p.predictions.length)) {
    throw new Error('Previziunea nu are titlu, rezumat sau afirmații');
  }
  return p;
}

/** Extrage obiectul JSON din textul modelului: întâi din <prediction>…</prediction>, apoi primul {…} complet. */
function extractJson(textOut) {
  const tagged = /<prediction>([\s\S]*?)<\/prediction>/i.exec(textOut);
  let body = tagged ? tagged[1] : textOut;
  body = body.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Nu am găsit JSON în răspuns');
  return JSON.parse(body.slice(start, end + 1));
}

module.exports = { PREDICTION_SCHEMA, sanitizePrediction, extractJson, safeUrl, sourceKey, asText, isoDate };
