'use strict';
/**
 * SQLite connection (B01) — one shared better-sqlite3 handle for the process.
 *
 *   const db = require('../lib/db');          // the Database instance itself
 *   const { db } = require('../lib/db');      // same object (alias)
 *   db.prepare('SELECT ...').get(...)
 *   db.transaction(fn)()                      // better-sqlite3 transaction
 *   db.nextSeq('case:2569')                   // next running number (call inside a transaction)
 *   db.DB_PATH · db.DATA_DIR · db.UPLOAD_DIR
 *
 * DB file = env DB_PATH (default <app>/data/egov.db). Schema = src/db/schema.sql.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(APP_ROOT, 'data', 'egov.db'));
const DATA_DIR = path.dirname(DB_PATH);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('secure_delete = ON'); // wiped rows are zero-filled (no plaintext left behind)

function applySchema() {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

/** user tables in the schema (excludes sqlite internals) */
function tableNames() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
}

/** Delete every row of every table (incl. append-only audit) and reset AUTOINCREMENT. */
function wipeAll() {
  const run = db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO sys_flags(k, v) VALUES ('allow_audit_wipe', '1')").run();
    for (const t of tableNames()) {
      if (t === 'sys_flags') continue;
      db.prepare(`DELETE FROM "${t}"`).run();
    }
    db.prepare('DELETE FROM sys_flags').run();
    const hasSeq = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get();
    if (hasSeq) db.prepare('DELETE FROM sqlite_sequence').run();
  });
  run();
  // uploaded files written to disk by any module are wiped as well
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Next running number for `key` (e.g. 'draft', 'payment', 'case:2569', 'receipt:2569', 'doc:2569').
 * Returns last+1 and stores it. Use inside db.transaction() so two payers never get the same number.
 * `floor` (optional) = highest number already used (e.g. SELECT MAX(seq)) — protects against an
 * un-initialised counter.
 */
function nextSeq(key, floor = 0) {
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(key);
  const next = Math.max(row ? row.value : 0, Number(floor) || 0) + 1;
  db.prepare('INSERT INTO counters(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, next);
  return next;
}

/** Set the LAST issued number for `key` (seed uses this: setSeq('case:2569', 30)). */
function setSeq(key, value) {
  db.prepare('INSERT INTO counters(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

applySchema();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

Object.assign(db, {
  db,
  DB_PATH,
  DATA_DIR,
  UPLOAD_DIR,
  SCHEMA_PATH,
  applySchema,
  tableNames,
  wipeAll,
  nextSeq,
  setSeq,
});

module.exports = db;
