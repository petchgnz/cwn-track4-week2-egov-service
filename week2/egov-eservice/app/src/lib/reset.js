'use strict';
/**
 * Reset + seed orchestration (B01).
 *
 *   resetAll()     wipe every table (sessions, OTP locks, notifications, audit, uploads …),
 *                  clock → default, run src/seed.js (B02) if present, then hooks.onReset callbacks.
 *   seedIfEmpty()  boot without TEST_MODE: seed only when the users table is empty.
 *
 * src/seed.js may export any of:
 *   module.exports = function seed(db, ctx) {…}          (sync → runs inside the reset transaction)
 *   module.exports = { seed(db, ctx) {…} } / { run } / { default }
 *   async functions are awaited (not wrapped in a transaction).
 * ctx = { db, clock, now (Date), nowIso, format, hashPassword, setSeq, nextSeq, UPLOAD_DIR }
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const clock = require('./clock');
const format = require('./format');
const hooks = require('./hooks');
const { hashPassword } = require('./password');

const SEED_PATH = path.join(__dirname, '..', 'seed.js');

let lastSeedError = null;

function loadSeedFn() {
  if (!fs.existsSync(SEED_PATH)) return null;
  const mod = require(SEED_PATH);
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.seed === 'function') return mod.seed;
  if (mod && typeof mod.run === 'function') return mod.run;
  if (mod && typeof mod.default === 'function') return mod.default;
  throw new Error('src/seed.js must export a function (or {seed})');
}

function seedCtx() {
  return {
    db,
    clock,
    now: clock.now(),
    nowIso: clock.nowIso(),
    format,
    hashPassword,
    setSeq: db.setSeq,
    nextSeq: db.nextSeq,
    UPLOAD_DIR: db.UPLOAD_DIR,
  };
}

const isAsync = (fn) => fn && fn.constructor && fn.constructor.name === 'AsyncFunction';

async function runSeed() {
  const fn = loadSeedFn();
  if (!fn) return false;
  if (isAsync(fn)) {
    await fn(db, seedCtx());
  } else {
    const out = db.transaction(() => fn(db, seedCtx()))();
    if (out && typeof out.then === 'function') await out;
  }
  return true;
}

let chain = Promise.resolve();

/** Serialised full reset. Resolves to { ok, now, seeded }. */
function resetAll() {
  const job = chain.then(async () => {
    clock.reset();
    db.wipeAll();
    let seeded = false;
    try {
      seeded = await runSeed();
      lastSeedError = null;
    } catch (e) {
      lastSeedError = e;
      throw e;
    }
    await hooks.runResetHooks();
    return { ok: true, now: clock.nowIso(), seeded };
  });
  chain = job.catch(() => {});
  return job;
}

async function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return false;
  return runSeed();
}

module.exports = { resetAll, seedIfEmpty, runSeed, SEED_PATH, getLastSeedError: () => lastSeedError };
