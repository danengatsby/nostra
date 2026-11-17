'use strict';
// Previziunile terminate se salvează ca fișiere JSON în data/predictions/. Un index în memorie
// (reconstruit la pornire) servește lista celor recente și cache-ul pentru cereri identice.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'predictions');
const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;

let index = []; // { id, key, createdAt, title, domain, horizon, region, lang, question, declined, private }

function init() {
  fs.mkdirSync(DIR, { recursive: true });
  index = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      index.push(summaryOf(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))));
    } catch (e) {
      console.warn(`[store] ignor ${f}: ${e.message}`);
    }
  }
  index.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const summaryOf = (rec) => ({
  id: rec.id, key: rec.key, createdAt: rec.createdAt, title: rec.prediction.title,
  domain: rec.request.domain, horizon: rec.request.horizon, region: rec.request.region,
  lang: rec.request.lang, question: rec.request.question, declined: rec.prediction.declined,
  private: rec.request.private === true,
});

const newId = () => crypto.randomBytes(9).toString('base64url');

/** Cheia de cache: aceeași întrebare (normalizată) cu aceleași opțiuni. Cele private nu se amestecă cu cele publice. */
function cacheKey(req) {
  const q = (req.question || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return crypto.createHash('sha256').update([req.domain, req.horizon, req.region, req.lang, q, req.private ? 'private' : ''].join('|')).digest('hex').slice(0, 32);
}

function findCached(key, maxAgeHours) {
  if (!(maxAgeHours > 0)) return null;
  const since = new Date(Date.now() - maxAgeHours * 3600000).toISOString();
  return index.find((r) => r.key === key && r.createdAt >= since && !r.declined) || null;
}

function save(rec) {
  const file = path.join(DIR, `${rec.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
  fs.renameSync(tmp, file);
  index.unshift(summaryOf(rec));
}

/** Rescrie o previziune existentă (ex. după verificare), fără s-o mute în lista celor recente. */
function update(rec) {
  const file = path.join(DIR, `${rec.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/** Toate previziunile (rezumate), cele mai noi întâi. */
const all = () => [...index];

/** Previziunile publice cu aceeași cheie (aceeași întrebare și opțiuni), în ordine cronologică. */
const series = (key) => index.filter((r) => r.key === key && !r.private && !r.declined).reverse();

/** Răspunsul brut al modelului, păstrat separat pentru depanare (nu e servit public). */
function saveRaw(id, text) {
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'raw', `${id}.txt`), text);
  } catch (e) {
    console.warn(`[store] nu pot salva răspunsul brut ${id}: ${e.message}`);
  }
}

function get(id) {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function recent(limit = 20) {
  return index.filter((r) => !r.declined && !r.private).slice(0, limit)
    .map(({ id, createdAt, title, domain, horizon, region, lang }) => ({ id, createdAt, title, domain, horizon, region, lang }));
}

module.exports = { init, newId, cacheKey, findCached, save, update, saveRaw, get, all, series, recent, ID_RE };
