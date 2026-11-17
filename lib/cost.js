'use strict';
// Costul fiecărui apel (din tokenii raportați de API) și bugetul zilnic în dolari.
// Registrul se salvează în data/budget.json, ca limita să reziste la repornirea serviciului.

const fs = require('node:fs');
const path = require('node:path');

// Prețuri în $ per milion de tokeni și per căutare web. Claude Opus 5.5 (modelul principal) se poate ajusta
// din .env; Claude Haiku 5.5 (modelul de rezervă) are prețurile pentru cereri de cel mult 100K tokeni.
const PRICE = {
  input: Number(process.env.PRICE_INPUT || 4),
  output: Number(process.env.PRICE_OUTPUT || 20),
  cacheRead: Number(process.env.PRICE_CACHE_READ || 0.2),
  cacheWrite: Number(process.env.PRICE_CACHE_WRITE || 5),
  search: Number(process.env.PRICE_SEARCH || 0.01),
};
const PRICES_BY_MODEL = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, search: 0.01 },
};

const BUDGET = Number(process.env.DAILY_BUDGET_USD || 0); // 0 = fără limită în dolari
// Bugetul separat al modelului de rezervă, folosit după ce bugetul principal de azi s-a epuizat.
const FALLBACK_BUDGET = () => Number(process.env.FALLBACK_DAILY_USD ?? 1);
const FALLBACK_ESTIMATE = 0.06;
// Cât din bugetul zilnic pot folosi verificările previziunilor ajunse la termen (restul rămâne pentru previziuni noi).
const VERIFY_BUDGET = Number(process.env.VERIFY_DAILY_USD ?? 0.25);
const DEFAULT_ESTIMATE = 0.45; // costul tipic al unei previziuni, până avem măsurători proprii

/** Costul în $ al unui consum de tokeni și căutări, după prețurile modelului (implicit modelul principal). */
function costUsd(u = {}, model = null) {
  const P = PRICES_BY_MODEL[model] || PRICE;
  u = u || {};
  const usd = ((u.input_tokens || 0) * P.input
    + (u.output_tokens || 0) * P.output
    + (u.cache_read_input_tokens || 0) * P.cacheRead
    + (u.cache_creation_input_tokens || 0) * P.cacheWrite) / 1e6
    + (u.web_search_requests || 0) * P.search;
  return Math.round(usd * 10000) / 10000;
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = () => path.join(DATA_DIR, 'budget.json');
const today = () => new Date().toISOString().slice(0, 10); // zi UTC, ca facturarea Anthropic

let ledger = null; // { date, spentUsd, verifySpentUsd, predictions, verifications, recent: [costuri ale ultimelor previziuni] }

function load() {
  if (ledger) return ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    ledger = { date: today(), spentUsd: 0, verifySpentUsd: 0, fallbackSpentUsd: 0, predictions: 0, verifications: 0, fallbacks: 0, recent: [] };
  }
  return ledger;
}

function rollover() {
  const l = load();
  if (l.date !== today()) {
    // Ziua încheiată intră în istoric (ultimele 90 de zile), apoi contoarele pornesc de la zero.
    const { date, spentUsd = 0, verifySpentUsd = 0, fallbackSpentUsd = 0, predictions = 0, verifications = 0, fallbacks = 0 } = l;
    l.history = [...(l.history || []), { date, spentUsd, verifySpentUsd, fallbackSpentUsd, predictions, verifications, fallbacks }].slice(-90);
    Object.assign(l, { date: today(), spentUsd: 0, verifySpentUsd: 0, fallbackSpentUsd: 0, predictions: 0, verifications: 0, fallbacks: 0 });
    persist();
  }
  return l;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(ledger));
    fs.renameSync(`${FILE()}.tmp`, FILE());
  } catch (e) {
    console.error('[cost] nu pot salva registrul:', e.message);
  }
}

/** Costul estimat al unei previziuni noi: media ultimelor costuri reale. */
function estimate() {
  const r = load().recent;
  return r.length ? r.reduce((a, b) => a + b, 0) / r.length : DEFAULT_ESTIMATE;
}

/** Mai încape în bugetul de azi o cheltuială de `usd` (plus cele deja pornite, `reserved`)? */
function canSpend(usd, reserved = 0) {
  if (!(BUDGET > 0)) return true;
  return rollover().spentUsd + reserved + usd <= BUDGET;
}

/**
 * Înregistrează o cheltuială reală. `kind`: 'prediction' | 'verification' | 'failed' (buget principal) sau
 * 'fallback' | 'fallback_failed' (bugetul separat al modelului de rezervă).
 */
function record(usd, kind) {
  const l = rollover();
  if (kind === 'fallback' || kind === 'fallback_failed') {
    l.fallbackSpentUsd = Math.round(((l.fallbackSpentUsd || 0) + usd) * 10000) / 10000;
    if (kind === 'fallback') l.fallbacks = (l.fallbacks || 0) + 1;
    persist();
    return;
  }
  l.spentUsd = Math.round((l.spentUsd + usd) * 10000) / 10000;
  if (kind === 'prediction') {
    l.predictions++;
    l.recent = [...l.recent, usd].slice(-10);
  } else if (kind === 'verification') {
    l.verifications++;
    l.verifySpentUsd = Math.round(((l.verifySpentUsd || 0) + usd) * 10000) / 10000;
  }
  persist();
}

/** Mai încape azi o previziune cu modelul de rezervă (în bugetul lui separat; `reserved` = cele pornite)? */
function canSpendFallback(reserved = 0) {
  const b = FALLBACK_BUDGET();
  if (!(b > 0)) return false;
  return (rollover().fallbackSpentUsd || 0) + reserved + FALLBACK_ESTIMATE <= b;
}

/** Mai e loc azi pentru o verificare de ~`usd`? (în cota verificărilor și în bugetul total) */
function canVerify(usd) {
  const l = rollover();
  if (VERIFY_BUDGET >= 0 && (l.verifySpentUsd || 0) + usd > VERIFY_BUDGET) return false;
  return canSpend(usd);
}

const status = () => ({ ...rollover(), budgetUsd: BUDGET, fallbackBudgetUsd: FALLBACK_BUDGET(), estimateUsd: Math.round(estimate() * 100) / 100 });

module.exports = { costUsd, estimate, canSpend, canSpendFallback, FALLBACK_ESTIMATE, canVerify, record, status, PRICE, _reset: () => { ledger = null; } };
