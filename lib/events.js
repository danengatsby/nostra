'use strict';
// Jurnalul evenimentelor importante (previziuni terminate, verificări, erori), afișat în pagina de
// administrare. Păstrează ultimele 300 de intrări în data/events.json.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'events.json');
const MAX = 300;

let list = null;

function load() {
  if (list) return list;
  try {
    list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    list = [];
  }
  return list;
}

/** Adaugă un eveniment: `type` = 'prediction' | 'verification' | 'error'. */
function log(type, data = {}) {
  const l = load();
  l.push({ at: new Date().toISOString(), type, ...data });
  if (l.length > MAX) l.splice(0, l.length - MAX);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(l));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) {
    console.error('[events] nu pot salva jurnalul:', e.message);
  }
}

/** Ultimele evenimente, cele mai noi întâi (opțional doar de un anumit tip). */
const recent = (limit = 50, type = null) => load().filter((e) => !type || e.type === type).slice(-limit).reverse();

module.exports = { log, recent };
