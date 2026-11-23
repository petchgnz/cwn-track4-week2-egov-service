'use strict';
/**
 * Cross-module hooks (B01).
 *
 *   const hooks = require('../lib/hooks');
 *   hooks.onRequest(fn)  fn(req) sync/async — runs BEFORE every route handler of
 *                        every module, for every HTTP request except /api/test/*,
 *                        /api/health and static assets (CONTRACT §0 ข้อ 7:
 *                        SLA notifications + auto-cancel are evaluated here).
 *   hooks.onReset(fn)    fn() sync/async — runs after POST /api/test/reset wiped
 *                        the DB and re-seeded (clear in-memory caches here).
 */
const requestHooks = [];
const resetHooks = [];

function onRequest(fn) {
  if (typeof fn === 'function') requestHooks.push(fn);
}
function onReset(fn) {
  if (typeof fn === 'function') resetHooks.push(fn);
}

async function runRequestHooks(req) {
  for (const fn of requestHooks) {
    try {
      await fn(req);
    } catch (e) {
      console.error('[hooks] request hook failed:', e && e.stack ? e.stack : e);
    }
  }
}

async function runResetHooks() {
  for (const fn of resetHooks) {
    await fn();
  }
}

module.exports = { onRequest, onReset, runRequestHooks, runResetHooks, requestHooks, resetHooks };
