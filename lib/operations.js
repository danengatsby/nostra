'use strict';
// Coada și contoarele operaționale supraviețuiesc repornirii procesului.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
let db;
function database() {
  if (db) return db;
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const connection = new DatabaseSync(path.join(dir, 'operations.sqlite'));
  connection.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS form_visits (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, device TEXT NOT NULL,
      email_required INTEGER NOT NULL, displayed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS form_visits_day ON form_visits(day);
    CREATE TABLE IF NOT EXISTS metrics (day TEXT, name TEXT, count INTEGER NOT NULL, PRIMARY KEY(day,name));`);
  db = connection;
  return db;
}
function count(name) {
  try {
    database().prepare("INSERT INTO metrics VALUES(date('now'), ?, 1) ON CONFLICT(day,name) DO UPDATE SET count=count+1").run(name);
  } catch (error) {
    // Contorizarea nu trebuie să transforme o plată confirmată într-o eroare pentru client.
    console.error('[metrics]', error.message);
  }
}
function today() {
  return Object.fromEntries(database().prepare("SELECT name,count FROM metrics WHERE day=date('now')").all().map(r => [r.name, r.count]));
}
function pruneVisits() {
  database().exec("DELETE FROM form_visits WHERE day <= date('now','-30 days')");
}
function visitForm(id, device, emailRequired) {
  pruneVisits();
  database().prepare("INSERT OR IGNORE INTO form_visits(id,day,device,email_required) VALUES (?,date('now'),?,?)")
    .run(id, device, Number(emailRequired));
}
function displayReport(id) {
  return database().prepare('UPDATE form_visits SET displayed=1 WHERE id=?').run(id).changes === 1;
}
function formConversion() {
  pruneVisits();
  return database().prepare(`SELECT device, email_required, COUNT(*) AS visits, SUM(displayed) AS reports
    FROM form_visits GROUP BY device, email_required ORDER BY device DESC, email_required DESC`).all();
}
function enqueue(job) {
  const { id, req, ui, privateScope, baseKey, key, tier, paid, createdAt } = job;
  database().prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)').run(id, JSON.stringify({ id, req, ui, privateScope, baseKey, key, tier, paid, createdAt }));
}
function finish(id) { database().prepare('DELETE FROM jobs WHERE id=?').run(id); }
function backlog() { return database().prepare('SELECT payload FROM jobs ORDER BY rowid').all().map(r => JSON.parse(r.payload)); }
module.exports = { database, count, today, visitForm, displayReport, formConversion, enqueue, finish, backlog };
