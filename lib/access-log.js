'use strict';
// Jurnalul accesărilor, numai pentru administrator (tabelul „Accesări” din /admin): pentru fiecare vizită, adresa IP,
// locația aproximativă dedusă din ea pe server (lib/geoip.js, fără servicii externe), sursa, dispozitivul, paginile
// deschise și pașii parcurși (previziune cerută, raport afișat, plată începută / plătită / trimisă pe email), plus
// comanda pornită din vizită. Nu conține emailuri și nici textul întrebărilor.
//
// Vizita are un identificator aleator generat de browser și păstrat cât fila e deschisă (sessionStorage); o vizită
// nouă începe după 30 de minute de inactivitate sau 2 ore. Datele stau în data/access.db, separat de rest, se șterg
// după 14 zile și nu intră în copiile de siguranță. O eroare aici nu strică niciodată cererea vizitatorului.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const geoip = require('./geoip');

const DAY = 86400000;
const KEEP_DAYS = 14;
const MAX_STEPS = 100; // pe vizită, ca un client stricat sau rău intenționat să nu umple baza
const NEW_PER_HOUR = 60; // vizite noi pe oră de la același IP
const ID_RE = /^[a-f0-9]{32}$/;
const OWN_HOST = 'nostradamus.my';

let db = null;
let file = null;
function open() {
  const wanted = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'access.db');
  if (db && file === wanted) return db;
  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  db = new DatabaseSync(wanted);
  file = wanted;
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, ip TEXT NOT NULL,
      country TEXT, region TEXT, city TEXT, device TEXT, internal INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL, last INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started);
    CREATE TABLE IF NOT EXISTS steps (session TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS steps_session ON steps(session, at);`);
  // Adresele IP sunt date personale: baza o poate citi doar utilizatorul aplicației.
  for (const suffix of ['', '-wal', '-shm']) { try { fs.chmodSync(wanted + suffix, 0o600); } catch { /* nu există încă */ } }
  return db;
}

const safe = (fn) => (...args) => {
  try { return fn(...args); } catch (err) { console.error('[jurnalul accesărilor]', err.code || err.message); return null; }
};

const cleanIp = (ip) => String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').slice(0, 45);

/** Dispozitivul, pe scurt (sistem · browser), din user-agent; agentul întreg nu se păstrează. */
function device(agent) {
  const ua = String(agent || '');
  const bot = /Googlebot|bingbot|YandexBot|DuckDuckBot|Baiduspider|facebookexternalhit|HeadlessChrome|bot\b|crawler|spider/i.exec(ua);
  if (bot) return `robot · ${bot[0]}`;
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook' : /Instagram/.test(ua) ? 'Instagram' : /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
      : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return [system, browser].filter(Boolean).join(' · ') || 'necunoscut';
}

// De unde a venit vizitatorul: un nume scurt, din eticheta pusă în link (utm_source, fbclid, gclid) sau din site-ul
// de pe care a venit (aceeași regulă ca în Astrohoroscop).
const KNOWN_SOURCES = [
  [/facebook|fb\.|fbclid|messenger/, 'facebook'], [/instagram/, 'instagram'], [/whatsapp|wa\.me/, 'whatsapp'],
  [/tiktok/, 'tiktok'], [/youtube|youtu\.be/, 'youtube'], [/google|gclid/, 'google'], [/bing/, 'bing'],
  [/duckduckgo/, 'duckduckgo'], [/twitter|^t\.co$|^x\.com$/, 'x'], [/telegram|^t\.me$/, 'telegram'],
  [/astrohor/, 'astrohoroscop'], [/chatgpt|openai|perplexity|claude\.ai/, 'asistent-ai'],
];
function sourceOf({ utm = '', ref = '' } = {}) {
  const tag = String(utm || '').toLowerCase().trim().slice(0, 60);
  const host = String(ref || '').toLowerCase().trim().replace(/^www\./, '').slice(0, 100);
  for (const value of [tag, host]) {
    if (!value) continue;
    const known = KNOWN_SOURCES.find(([re]) => re.test(value));
    if (known) return known[1];
    // O etichetă proprie pusă în link (de exemplu ?utm_source=postare-luni) se păstrează ca atare.
    if (value === tag) return /^[a-z0-9][a-z0-9_-]{0,23}$/.test(tag) ? tag : 'alt-link';
  }
  if (!host) return 'direct';
  return host === OWN_HOST ? 'paginile-site-ului' : /^[a-z0-9.-]{1,60}$/.test(host) ? host : 'alt-site';
}

const created = new Map(); // IP → momentele vizitelor noi din ultima oră
setInterval(() => {
  for (const [ip, times] of created) if (!(times.at(-1) > Date.now() - 3600000)) created.delete(ip);
}, 600000).unref();

/**
 * Vizita începe sau continuă. Prima cerere fixează IP-ul, locația, dispozitivul și sursa; următoarele actualizează
 * momentul ultimei activități (și marchează vizita ca internă dacă browserul s-a conectat între timp ca administrator).
 * Întoarce true dacă vizita există (sau a fost creată).
 */
function touch(id, req, { utm = '', ref = '', internal = false } = {}, at = Date.now()) {
  if (!ID_RE.test(String(id)) || !req) return false;
  const store = open();
  if (store.prepare('UPDATE sessions SET last=?, internal=MAX(internal,?) WHERE id=?').run(at, internal ? 1 : 0, id).changes) return true;
  const ip = cleanIp(req.ip);
  if (!ip) return false;
  const recent = (created.get(ip) || []).filter((t) => at - t < 3600000);
  if (recent.length >= NEW_PER_HOUR) return false;
  created.set(ip, [...recent, at]);
  const where = geoip.place(ip) || {};
  store.prepare('INSERT OR IGNORE INTO sessions(id,source,ip,country,region,city,device,internal,started,last) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, sourceOf({ utm, ref }), ip, where.country || null, where.region || null, where.city || null,
      device(typeof req.get === 'function' ? req.get('user-agent') : ''), internal ? 1 : 0, at, at);
  return true;
}

function add(session, kind, name, detail, at) {
  if (!ID_RE.test(String(session))) return;
  const store = open();
  if (!store.prepare('SELECT 1 FROM sessions WHERE id=?').get(session)) return;
  if (store.prepare('SELECT COUNT(*) AS n FROM steps WHERE session=?').get(session).n >= MAX_STEPS) return;
  store.prepare('INSERT INTO steps(session,at,kind,name,detail) VALUES(?,?,?,?,?)').run(session, at, kind, name, detail || null);
}

/** O pagină deschisă: calea (validată) și limba interfeței. */
function page(session, raw, lang, at = Date.now()) {
  const value = String(raw || '');
  const pathName = /^\/[A-Za-z0-9_\-/.]{0,80}$/.test(value) ? value : '(altă pagină)';
  add(session, 'page', pathName, lang === 'en' ? 'en' : null, at);
}

/** Un pas al parcursului (previziune cerută, raport, plată…); `detail`: previziunea sau începutul comenzii. */
function step(session, name, detail = null, at = Date.now()) {
  add(session, 'step', String(name).slice(0, 24), detail ? String(detail).slice(0, 40) : null, at);
}

/**
 * Vizitele din ultimele 14 zile, cele mai noi primele, cu pașii în ordine. Fără `includeInternal`, cele din browserele
 * conectate ca administrator se numără separat (`internal`) și nu apar în listă.
 */
function list({ includeInternal = false, limit = 300, at = Date.now() } = {}) {
  const store = open();
  const since = at - KEEP_DAYS * DAY;
  const filter = includeInternal ? '' : 'AND internal=0';
  const total = store.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE started>=? ${filter}`).get(since).n;
  const internal = store.prepare('SELECT COUNT(*) AS n FROM sessions WHERE started>=? AND internal=1').get(since).n;
  const sessions = store.prepare(`SELECT * FROM sessions WHERE started>=? ${filter} ORDER BY started DESC LIMIT ?`).all(since, limit);
  const byId = new Map(sessions.map((s) => [s.id, { ...s, steps: [] }]));
  if (sessions.length) {
    const steps = store.prepare(`SELECT * FROM steps WHERE session IN (SELECT id FROM sessions WHERE started>=? ${filter} ORDER BY started DESC LIMIT ?) ORDER BY at, rowid`)
      .all(since, limit);
    for (const s of steps) byId.get(s.session)?.steps.push({ at: s.at, kind: s.kind, name: s.name, detail: s.detail });
  }
  return { total, internal, keepDays: KEEP_DAYS, rows: [...byId.values()] };
}

/** Șterge vizitele mai vechi de 14 zile. */
function purge(at = Date.now()) {
  const store = open();
  const cutoff = at - KEEP_DAYS * DAY;
  store.exec('BEGIN IMMEDIATE');
  try {
    store.prepare('DELETE FROM steps WHERE session IN (SELECT id FROM sessions WHERE started<?)').run(cutoff);
    const removed = store.prepare('DELETE FROM sessions WHERE started<?').run(cutoff).changes;
    store.exec('COMMIT');
    if (removed) store.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // adresele șterse nu rămân nici în jurnalul bazei
    return removed;
  } catch (err) {
    store.exec('ROLLBACK');
    throw err;
  }
}

function start() {
  safe(purge)();
  setInterval(safe(purge), 30 * 60000).unref();
}

module.exports = { KEEP_DAYS, ID_RE, device, sourceOf, touch: safe(touch), page: safe(page), step: safe(step), list, purge: safe(purge), start };
