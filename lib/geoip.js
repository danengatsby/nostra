'use strict';
// Localizarea aproximativă a unei adrese IP din baze locale în format MaxMind DB (DB-IP Lite, CC BY 4.0:
// „IP Geolocation by DB-IP”, https://db-ip.com), fără servicii externe: IP-urile nu pleacă de pe server.
// Același modul ca în Astrohoroscop. Baza de orașe: GEOIP_CITY_DB (implicit data/geoip-city.mmdb); pe server
// .env o indică pe cea a Astrohoroscop, actualizată lunar de astro-geoip.timer. Baza de țări (GEOIP_DB) e opțională.
// Fără baze, locația este necunoscută (null).
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const MARKER = Buffer.from('abcdef4d61784d696e642e636f6d', 'hex'); // \xab\xcd\xef MaxMind.com
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILES = {
  country: () => process.env.GEOIP_DB || path.join(dataDir(), 'geoip-country.mmdb'),
  city: () => process.env.GEOIP_CITY_DB || path.join(dataDir(), 'geoip-city.mmdb'),
};

/** Deschide o bază MMDB dintr-un Buffer. Aruncă o eroare dacă fișierul nu are formatul așteptat. */
function open(buf) {
  const start = buf.lastIndexOf(MARKER, buf.length - 1);
  if (start < 0 || start < buf.length - 128 * 1024) throw new Error('nu este o bază MaxMind DB');
  const db = { buf, dataStart: 0, cache: new Map() };
  const meta = decode(db, start + MARKER.length, start + MARKER.length)[0];
  if (![24, 28, 32].includes(meta.record_size) || !Number.isInteger(meta.node_count) || ![4, 6].includes(meta.ip_version)) {
    throw new Error('metadate MaxMind DB nevalide');
  }
  Object.assign(db, { meta, nodeCount: meta.node_count, recordSize: meta.record_size, nodeBytes: meta.record_size / 4 });
  db.dataStart = db.nodeBytes * db.nodeCount + 16;
  if (db.dataStart > start) throw new Error('arbore MaxMind DB nevalid');
  db.ipv4Start = 0;
  if (meta.ip_version === 6) {
    let node = 0;
    for (let i = 0; i < 96 && node < db.nodeCount; i++) node = record(db, node, 0);
    db.ipv4Start = node;
  }
  return db;
}

function record(db, node, bit) {
  const b = db.buf;
  const off = node * db.nodeBytes;
  if (db.recordSize === 24) return b.readUIntBE(off + 3 * bit, 3);
  if (db.recordSize === 28) {
    return bit === 0 ? ((b[off + 3] & 0xf0) << 20) + b.readUIntBE(off, 3) : ((b[off + 3] & 0x0f) << 24) + b.readUIntBE(off + 4, 3);
  }
  return b.readUInt32BE(off + 4 * bit);
}

// Decodorul secțiunii de date (specificația MaxMind DB 2.0). Întoarce [valoare, poziția următoare].
function decode(db, pos, base, depth = 0) {
  if (depth > 32) throw new Error('structură MaxMind DB prea adâncă');
  const b = db.buf;
  const ctrl = b[pos++];
  let type = ctrl >> 5;
  if (type === 1) {
    const ss = (ctrl >> 3) & 3;
    const vvv = ctrl & 7;
    let ptr;
    if (ss === 0) { ptr = (vvv << 8) | b[pos]; pos += 1; }
    else if (ss === 1) { ptr = ((vvv << 16) | b.readUInt16BE(pos)) + 2048; pos += 2; }
    else if (ss === 2) { ptr = vvv * 0x1000000 + b.readUIntBE(pos, 3) + 526336; pos += 3; }
    else { ptr = b.readUInt32BE(pos); pos += 4; }
    return [decode(db, base + ptr, base, depth + 1)[0], pos];
  }
  if (type === 0) type = 7 + b[pos++];
  let size = ctrl & 0x1f;
  if (size === 29) size = 29 + b[pos++];
  else if (size === 30) { size = 285 + b.readUInt16BE(pos); pos += 2; }
  else if (size === 31) { size = 65821 + b.readUIntBE(pos, 3); pos += 3; }
  switch (type) {
    case 2: return [b.toString('utf8', pos, pos + size), pos + size];
    case 3: return [b.readDoubleBE(pos), pos + 8];
    case 4: return [b.subarray(pos, pos + size), pos + size];
    case 5: case 6: case 9: case 10: {
      let n = 0;
      for (let i = 0; i < size; i++) n = n * 256 + b[pos + i]; // suficient de exact pentru metadate și coduri
      return [n, pos + size];
    }
    case 7: {
      const out = {};
      for (let i = 0; i < size; i++) {
        let key; [key, pos] = decode(db, pos, base, depth + 1);
        [out[key], pos] = decode(db, pos, base, depth + 1);
      }
      return [out, pos];
    }
    case 8: return [size ? b.readIntBE(pos, size) : 0, pos + size];
    case 11: {
      const out = [];
      for (let i = 0; i < size; i++) { let v; [v, pos] = decode(db, pos, base, depth + 1); out.push(v); }
      return [out, pos];
    }
    case 14: return [size !== 0, pos];
    case 15: return [b.readFloatBE(pos), pos + 4];
    default: throw new Error(`tip de date MaxMind DB necunoscut: ${type}`);
  }
}

/** Biții adresei, de la cel mai semnificativ: [număr de biți, funcția bit(i)], sau null pentru o adresă nevalidă. */
function bits(ip) {
  let address = String(ip || '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) address = mapped[1];
  const version = net.isIP(address);
  if (version === 4) {
    const n = address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
    return [32, (i) => Math.floor(n / 2 ** (31 - i)) % 2];
  }
  if (version === 6) {
    let [head, tail = ''] = address.toLowerCase().split('::');
    if (address.includes('.')) return null; // forme IPv6 cu IPv4 la final, altele decât ::ffff:a.b.c.d, nu apar aici
    const h = head ? head.split(':') : [];
    const t = address.includes('::') ? (tail ? tail.split(':') : []) : [];
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((g) => parseInt(g, 16));
    if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
    return [128, (i) => (groups[Math.floor(i / 16)] >> (15 - (i % 16))) & 1];
  }
  return null;
}

function lookup(db, ip) {
  const parsed = bits(ip);
  if (!parsed) return null;
  const [count, bit] = parsed;
  if (count === 128 && db.meta.ip_version === 4) return null;
  let node = count === 32 ? db.ipv4Start : 0;
  for (let i = 0; i < count && node < db.nodeCount; i++) node = record(db, node, bit(i));
  if (node <= db.nodeCount) return null; // fără date pentru adresă (sau arbore nevalid)
  const offset = node - db.nodeCount - 16;
  if (!db.cache.has(offset)) db.cache.set(offset, decode(db, db.dataStart + offset, db.dataStart)[0]);
  return db.cache.get(offset);
}

// Fiecare bază se citește la prima folosire și se recitește dacă fișierul a fost înlocuit (verificare cel mult o dată pe oră).
// Baza de orașe ocupă aproximativ 130 MB de memorie; se încarcă numai când e nevoie de un oraș.
const states = { country: { current: null, loadedMtime: 0, checkedAt: 0 }, city: { current: null, loadedMtime: 0, checkedAt: 0 } };
function database(kind = 'country') {
  const state = states[kind];
  const now = Date.now();
  if (now - state.checkedAt < 3600000 && state.checkedAt) return state.current;
  state.checkedAt = now;
  try {
    const stat = fs.statSync(FILES[kind]());
    if (stat.mtimeMs !== state.loadedMtime) {
      state.current = null; // baza veche poate fi eliberată înainte de citirea celei noi
      state.current = open(fs.readFileSync(FILES[kind]()));
      state.loadedMtime = stat.mtimeMs;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[localizare] baza ${kind === 'city' ? 'de orașe' : 'de țări'} nu poate fi citită:`, err.message);
    state.current = null;
    state.loadedMtime = 0;
  }
  return state.current;
}

const validCode = (code) => (/^[A-Z]{2}$/.test(code || '') ? code : null);

/** Codul ISO al țării (de exemplu „RO”) pentru o adresă IP, sau null dacă nu se poate stabili. */
function country(ip) {
  try {
    const db = database('country');
    return validCode(db && lookup(db, ip)?.country?.iso_code);
  } catch {
    return null;
  }
}

const nameOf = (entry) => {
  const value = entry?.names?.ro || entry?.names?.en || '';
  return typeof value === 'string' ? value.slice(0, 80) : '';
};

/** Locația aproximativă a unei adrese IP: { country, region, city } (orașul și regiunea pot lipsi), sau null. */
function place(ip) {
  try {
    const db = database('city');
    const found = db && lookup(db, ip);
    const code = validCode(found?.country?.iso_code);
    if (code) return { country: code, region: nameOf(found.subdivisions?.[0]), city: nameOf(found.city) };
  } catch { /* cădem pe baza de țări */ }
  const code = country(ip);
  return code ? { country: code, region: '', city: '' } : null;
}

/** Pentru panou: data bazei de țări (AAAA-LL-ZZ), sau null dacă lipsește. */
function info() {
  const db = database('country');
  const epoch = db?.meta?.build_epoch;
  return db ? { built: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString().slice(0, 10) : null, type: String(db.meta.database_type || '') } : null;
}

/** Pentru teste: uită bazele citite, ca următoarea căutare să le citească din nou. */
function reset() {
  for (const state of Object.values(states)) Object.assign(state, { current: null, loadedMtime: 0, checkedAt: 0 });
}

module.exports = { country, place, info, open, lookup, reset };
