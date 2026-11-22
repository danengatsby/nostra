'use strict';
// Verificarea previziunilor ajunse la termen: pentru fiecare afirmație a cărei dată de verificare a trecut,
// oracolul caută pe internet ce s-a întâmplat de fapt și o marchează ca adevărată, falsă sau încă nelămurită.
// Din rezultate se calculează palmaresul: câte afirmații s-au adeverit și cât de bine calibrate au fost
// probabilitățile (scorul Brier). Rulează în fundal, o dată pe oră, în cota de buget a verificărilor.

const store = require('./store');
const cost = require('./cost');
const { HORIZON } = require('./catalog');
const { callWithTools, newUsage, SourceTracker } = require('./oracle');
const { safeUrl } = require('./schema');
const events = require('./events');

const GRACE_DAYS = Number(process.env.VERIFY_GRACE_DAYS || 2); // datele oficiale apar uneori cu o zi-două întârziere
const RETRY_DAYS = 7; // o afirmație „nelămurită” se reverifică după o săptămână
const MAX_ATTEMPTS = 4;
const ESTIMATE_USD = 0.15;
const DAY = 86400000;

const SYSTEM = `You are the fact-checker of Nostradamus, a forecasting service. You receive forecast claims made in the past whose resolution date has passed. For each claim, search the web for what actually happened and decide:
- "true": the claim came true as stated (all its conditions met within its timeframe)
- "false": the claim did not come true, or the opposite happened
- "unresolved": the outcome is not yet publicly known, the data has not been published, or the claim is too ambiguous to judge

Rules: judge the claim exactly as written, not its spirit. Apply any recorded resolution criteria exactly; they were fixed when the forecast was made. Never change the threshold, timeframe, or required source after seeing the outcome. If no separate criteria exist, judge the literal claim and mark ambiguous claims "unresolved". Use primary or authoritative sources and check publication dates. A "true" or "false" verdict requires both a concrete evidence sentence (actual fact or figure and its date) and a source URL found by your tools during this verification. Without either, answer "unresolved". Do not guess. Use as few searches as needed.

After your research, answer with a single JSON object wrapped in <verification></verification> tags, nothing after it:
{"results": [{"id": <claim id>, "status": "true"|"false"|"unresolved", "evidence": "<one sentence with the actual figure or fact and its date>", "url": "<the source URL you used, from your searches>"}]}
Write each evidence sentence in the language given in the request.`;

const iso = (d) => new Date(d).toISOString().slice(0, 10);

/** Un verdict final are nevoie de dovadă și URL; aceeași regulă se aplică și fișierelor vechi. */
function checkResult(item) {
  if (!item) return { status: 'pending', evidence: '', url: null };
  const evidence = typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 600) : '';
  // Versiunile vechi păstrau URL-ul numai dacă fusese găsit de instrumentele verificatorului.
  const url = safeUrl(item.url);
  const status = ['true', 'false'].includes(item.status) && evidence && url ? item.status : 'unresolved';
  return { status, evidence, url };
}

const attemptsOf = (item) => Number.isSafeInteger(item?.attempts) && item.attempts >= 0 ? item.attempts : 0;

/** URL-urile pot diferi prin fragment sau slash final; păstrăm calea și query-ul sensibile la litere. */
function sourceKey(value) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}

function claimIndex(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

/** Data de verificare a unei afirmații: `resolve_by` dat de model sau, pentru previziunile mai vechi, sfârșitul perioadei. */
function resolveDate(rec, pred) {
  if (pred.resolve_by) return pred.resolve_by;
  const days = HORIZON[rec.request.horizon]?.days || 365;
  return iso(Date.parse(rec.createdAt) + days * DAY);
}

// Același termen alimentează atât istoricul utilizatorului, cât și verificatorul.
function nextCheckTime(rec, claim, item) {
  const due = Date.parse(resolveDate(rec, claim)) + GRACE_DAYS * DAY;
  if (!item) return due;
  if (checkResult(item).status !== 'unresolved' || attemptsOf(item) >= MAX_ATTEMPTS) return null;
  const checked = Date.parse(item.checkedAt);
  return Number.isFinite(checked) ? Math.max(due, checked + RETRY_DAYS * DAY) : due;
}

function dueClaims(rec, now = Date.now()) {
  if (rec.prediction.declined) return [];
  const done = new Map((rec.verification?.items || []).map(it => [it.index, it]));
  return rec.prediction.predictions.flatMap((claim, i) => {
    const at = nextCheckTime(rec, claim, done.get(i));
    return at !== null && at <= now ? [i] : [];
  });
}

function buildMessage(rec, indices, now) {
  const lang = rec.request.lang === 'en' ? 'English' : 'Romanian (with diacritics)';
  const claims = indices.map((i) => {
    const p = rec.prediction.predictions[i];
    return `<claim id="${i}">\n${p.claim}\nTimeframe: ${p.timeframe || '-'}\nResolution date: ${resolveDate(rec, p)}\nResolution criteria fixed at forecast time: ${p.resolution_criteria || 'Not recorded; judge the literal claim. If ambiguous, mark unresolved.'}\n</claim>`;
  }).join('\n');
  return `Today's date: ${iso(now)}.\nThe forecast was made on ${rec.createdAt.slice(0, 10)}${rec.request.question ? ` for the question: "${rec.request.question}"` : ''}.\nLanguage for evidence: ${lang}.\n\n${claims}`;
}

function parseResults(text) {
  const m = /<verification>([\s\S]*?)<\/verification>/i.exec(text);
  const body = m ? m[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Verificarea nu conține JSON');
  const out = JSON.parse(body.slice(start, end + 1));
  if (!Array.isArray(out?.results)) throw new Error('Verificarea nu are rezultate');
  return out.results;
}

/** Verifică afirmațiile scadente dintr-o previziune și salvează rezultatul. Întoarce costul în $. */
async function verifyRecord(rec, now = Date.now(), signal) {
  const indices = dueClaims(rec, now);
  if (!indices.length) return 0;
  const tracker = new SourceTracker();
  const usage = newUsage();
  let results;
  try {
    const { text } = await callWithTools({
      system: SYSTEM, userMessage: buildMessage(rec, indices, now), effort: 'medium',
      maxSearches: Math.min(10, 2 + indices.length * 2), maxFetches: 2, usage, signal,
      onBlock: (b) => tracker.onBlock(b),
    });
    results = parseResults(text);
  } finally {
    cost.record(cost.costUsd(usage), 'verification');
  }

  const checkedAt = new Date(now).toISOString();
  const items = new Map((rec.verification?.items || []).map((it) => [it.index, it]));
  const knownSources = new Set([...tracker.seen.values(), ...tracker.cited.values()].map(s => sourceKey(s.url)).filter(Boolean));
  for (const index of indices) {
    // Rezultatele lipsă, cu ID invalid sau duplicate sunt ambigue și nu primesc verdict final.
    const matches = results.filter(x => x && claimIndex(x.id) === index);
    const r = matches.length === 1 ? matches[0] : null;
    // Sursa trebuie să fi fost găsită efectiv în această verificare.
    const url = safeUrl(r?.url);
    const known = url && knownSources.has(sourceKey(url));
    items.set(index, {
      index, ...checkResult({ status: r?.status, evidence: r?.evidence, url: known ? url : null }), checkedAt,
      attempts: attemptsOf(items.get(index)) + 1,
    });
  }
  rec.verification = { updatedAt: checkedAt, items: [...items.values()].sort((a, b) => a.index - b.index) };
  store.update(rec);
  return cost.costUsd(usage);
}

let running = false;

/** O trecere a verificatorului: previziunile cele mai vechi întâi, cât permite cota de buget. */
async function runOnce(now = Date.now()) {
  if (running || process.env.DEMO_MODE === '1') return { checked: 0 };
  running = true;
  let checked = 0;
  try {
    for (const summary of store.all().reverse()) {
      const rec = store.get(summary.id);
      if (!rec || !dueClaims(rec, now).length) continue;
      const reserved = require('./jobs').pending('main') * cost.estimate();
      if (!cost.canVerify(ESTIMATE_USD, reserved)) break;
      cost.reserveVerification(ESTIMATE_USD);
      try {
        const usd = await verifyRecord(rec, now);
        checked++;
        console.log(`[verify ${rec.id}] verificată, cost ≈ $${usd.toFixed(3)}`);
        events.log('verification', { id: rec.id, costUsd: usd });
      } catch (e) {
        console.error(`[verify ${rec.id}] eroare:`, e?.status || '', e?.message || e);
        events.log('error', { where: 'verification', id: rec.id, status: e?.status || null, message: String(e?.message || e).slice(0, 300) });
        if (e?.status === 400 || e?.status === 401 || e?.status === 403) break; // problemă de cont: reîncercăm la următoarea trecere
      } finally {
        cost.reserveVerification(0);
      }
    }
  } finally {
    running = false;
  }
  return { checked };
}

function start() {
  if (process.env.VERIFY_ENABLED === '0') return;
  setTimeout(() => runOnce().catch(() => {}), 60000).unref();
  setInterval(() => runOnce().catch(() => {}), 3600000).unref();
}

// ---------- palmaresul ----------

/** Statistici din toate afirmațiile verificate (adevărate sau false). */
function trackRecord(filters = {}) {
  const resolved = [];
  let pending = 0;
  let next = null;
  for (const summary of store.all()) {
    const rec = store.get(summary.id);
    if (!rec || rec.prediction.declined) continue;
    if (filters.domain && rec.request.domain !== filters.domain) continue;
    if (filters.horizon && rec.request.horizon !== filters.horizon) continue;
    if (filters.tier && (rec.meta?.tier || 'main') !== filters.tier) continue;
    const items = new Map((rec.verification?.items || []).map((it) => [it.index, it]));
    rec.prediction.predictions.forEach((p, index) => {
      const it = items.get(index);
      const check = checkResult(it);
      if (check.status === 'true' || check.status === 'false') {
        resolved.push({ id: rec.id, private: rec.request.private === true, title: rec.prediction.title, claim: p.claim, probability: p.probability, outcome: check.status === 'true', evidence: check.evidence, url: check.url, checkedAt: it.checkedAt || rec.createdAt });
      } else {
        pending++;
        const d = resolveDate(rec, p);
        if (!next || d < next) next = d;
      }
    });
  }

  // O afirmație dată cu p < 50% e, de fapt, o predicție că lucrul NU se întâmplă: o întoarcem.
  const norm = resolved.map((r) => (r.probability >= 50 ? { p: r.probability, hit: r.outcome } : { p: 100 - r.probability, hit: !r.outcome }));
  const brier = resolved.length
    ? resolved.reduce((a, r) => a + (r.probability / 100 - (r.outcome ? 1 : 0)) ** 2, 0) / resolved.length
    : null;
  const buckets = [[50, 59], [60, 69], [70, 79], [80, 89], [90, 99]].map(([lo, hi]) => {
    const inB = norm.filter((x) => x.p >= lo && x.p <= hi);
    return {
      range: `${lo}–${hi}%`, count: inB.length,
      expected: inB.length ? Math.round(inB.reduce((a, x) => a + x.p, 0) / inB.length) : null,
      actual: inB.length ? Math.round((100 * inB.filter((x) => x.hit).length) / inB.length) : null,
    };
  });

  return {
    resolved: resolved.length,
    correct: norm.filter((x) => x.hit).length,
    brier: brier === null ? null : Math.round(brier * 1000) / 1000,
    buckets,
    pending,
    nextCheck: next ? iso(Date.parse(next) + GRACE_DAYS * DAY) : null,
    recent: resolved.filter((r) => !r.private).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, 8)
      .map(({ private: _p, ...r }) => r),
  };
}

module.exports = { start, runOnce, verifyRecord, dueClaims, nextCheckTime, resolveDate, trackRecord, parseResults, checkResult };
