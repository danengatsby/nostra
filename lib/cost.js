'use strict';
// Costul fiecărui apel (din tokenii raportați de API) și bugetul zilnic în dolari.
// Registrul se salvează în data/budget.json, ca limita să reziste la repornirea serviciului.

const fs = require('node:fs');
const path = require('node:path');

// Prețuri în $ per milion de tokeni (Claude Opus 5.5) și per căutare web. Se pot ajusta din .env.
const PRICE = {
  input: Number(process.env.PRICE_INPUT || 4),
  output: Number(process.env.PRICE_OUTPUT || 20),
  cacheRead: Number(process.env.PRICE_CACHE_READ || 0.2),
  cacheWrite: Number(process.env.PRICE_CACHE_WRITE || 5),
  search: Number(process.env.PRICE_SEARCH || 0.01),
};

const BUDGET = Number(process.env.DAILY_BUDGET_USD || 0); // 0 = fără limită în dolari
// Cât din bugetul zilnic pot folosi verificările previziunilor ajunse la termen (restul rămâne pentru previziuni noi).
const VERIFY_BUDGET = Number(process.env.VERIFY_DAILY_USD ?? 0.25);
const DEFAULT_ESTIMATE = 0.45; // costul tipic al unei previziuni, până avem măsurători proprii

function costUsd(u = {}) {
  const usd = ((u.input_tokens || 0) * PRICE.input
    + (u.output_tokens || 0) * PRICE.output
    + (u.cache_read_input_tokens || 0) * PRICE.cacheRead
    + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite) / 1e6
    + (u.web_search_requests || 0) * PRICE.search;
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
    ledger = { date: today(), spentUsd: 0, verifySpentUsd: 0, predictions: 0, verifications: 0, recent: [] };
  }
  return ledger;
}

function rollover() {
  const l = load();
  if (l.date !== today()) {
    // Ziua încheiată intră în istoric (ultimele 90 de zile), apoi contoarele pornesc de la zero.
    const { date, spentUsd = 0, verifySpentUsd = 0, predictions = 0, verifications = 0 } = l;
    l.history = [...(l.history || []), { date, spentUsd, verifySpentUsd, predictions, verifications }].slice(-90);
    Object.assign(l, { date: today(), spentUsd: 0, verifySpentUsd: 0, predictions: 0, verifications: 0 });
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

/** Înregistrează o cheltuială reală. `kind`: 'prediction' | 'verification' | 'failed'. */
function record(usd, kind) {
  const l = rollover();
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

/** Mai e loc azi pentru o verificare de ~`usd`? (în cota verificărilor și în bugetul total) */
function canVerify(usd) {
  const l = rollover();
  if (VERIFY_BUDGET >= 0 && (l.verifySpentUsd || 0) + usd > VERIFY_BUDGET) return false;
  return canSpend(usd);
}

const status = () => ({ ...rollover(), budgetUsd: BUDGET, estimateUsd: Math.round(estimate() * 100) / 100 });

module.exports = { costUsd, estimate, canSpend, canVerify, record, status, PRICE, _reset: () => { ledger = null; } };
