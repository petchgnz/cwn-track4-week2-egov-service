'use strict';
/**
 * e-Service กลาง — entry point (B01).
 *
 * Loads every src/modules/*.js automatically (alphabetical). A module exports either
 *   module.exports = function register(app, ctx) {…}
 *   module.exports = { register(app, ctx) {…}, order?: number }   (lower order loads first, default 100)
 * ctx = { db, clock, layout, format, session, hooks, bugmode, rules?, express, TEST_MODE }
 *
 * Core pipeline: body parsers (≥ 6 MB) → static /static → session → request hooks (SLA/auto-cancel)
 *   → /api/test/* gate (404 unless TEST_MODE=1) → /api/health → modules → placeholders → 404/500.
 * Placeholder pages (src/lib/placeholders.js) answer CONTRACT §1 routes that no module registered yet.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('./lib/db');
const clock = require('./lib/clock');
const layout = require('./lib/layout');
const format = require('./lib/format');
const session = require('./lib/session');
const hooks = require('./lib/hooks');
const bugmode = require('./lib/bugmode');
const reset = require('./lib/reset');

const PORT = Number(process.env.PORT || 3005);
const TEST_MODE = bugmode.isTestMode();
const BODY_LIMIT = process.env.BODY_LIMIT || '12mb';

function tryRequire(p) {
  try {
    return require(p);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(p)) return null;
    throw e;
  }
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('etag', false);

  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

  // never cache HTML/API (tests change clock + state between requests)
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(session.middleware);

  // CONTRACT §0 ข้อ 7: evaluate SLA notifications / auto-cancel before every request except /api/test/* + health
  app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api/test/') || p === '/api/test' || p === '/api/health' || p.startsWith('/static/') || p === '/favicon.ico') return next();
    hooks.runRequestHooks(req).then(() => next(), next);
  });

  // CONTRACT §0 ข้อ 8: /api/test/* exists only with TEST_MODE=1
  app.use('/api/test', (req, res, next) => {
    if (!TEST_MODE) return layout.apiError(res, 404, 'NOT_FOUND', 'Not Found');
    next();
  });

  // CONTRACT §6.6 — exactly {"status":"ok"}
  app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  const rules = tryRequire('./lib/rules');
  const ctx = { db, clock, layout, format, session, hooks, bugmode, rules, reset, express, TEST_MODE };

  const modDir = path.join(__dirname, 'modules');
  const mods = fs.existsSync(modDir)
    ? fs
        .readdirSync(modDir)
        .filter((f) => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('.'))
        .sort()
        .map((f) => {
          const m = require(path.join(modDir, f));
          const register = typeof m === 'function' ? m : m && (m.register || m.default);
          return { file: f, register, order: (m && typeof m.order === 'number') ? m.order : 100 };
        })
    : [];
  mods.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
  for (const m of mods) {
    if (typeof m.register !== 'function') {
      console.warn(`[server] module ${m.file} exports no register(app, ctx) — skipped`);
      continue;
    }
    const sub = m.register(app, ctx);
    if (sub && typeof sub === 'function' && sub !== app) app.use(sub); // module may return a Router
    console.log(`[server] module loaded: ${m.file}`);
  }

  // placeholder pages for CONTRACT §1 routes not yet implemented by a module
  require('./lib/placeholders')(app, ctx);

  // 404
  app.use((req, res) => {
    if (layout.isApi(req)) return layout.apiError(res, 404, 'NOT_FOUND', 'Not Found');
    return layout.sendNotFound(req, res, 'ไม่พบหน้านี้');
  });

  // errors (body too large / bad JSON / unexpected)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return;
    if (err && err.type === 'entity.parse.failed') return layout.apiError(res, 400, 'BAD_REQUEST', 'รูปแบบข้อมูลไม่ถูกต้อง');
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return layout.apiError(res, 413, 'PAYLOAD_TOO_LARGE', 'ข้อมูลใหญ่เกินกำหนด');
    if (err && err.code === 'INVALID_TIME') return layout.apiError(res, 400, 'INVALID_TIME');
    console.error('[server] error:', err && err.stack ? err.stack : err);
    const status = (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) ? err.status : 500;
    if (layout.isApi(req)) return layout.apiError(res, status, (err && err.code && typeof err.code === 'string') ? err.code : 'INTERNAL_ERROR', (err && err.publicMessage) || 'เกิดข้อผิดพลาดภายในระบบ');
    return layout.render(req, res, { status, title: 'เกิดข้อผิดพลาด', body: '<h1>เกิดข้อผิดพลาด</h1><p>เกิดข้อผิดพลาดภายในระบบ</p>' });
  });

  return app;
}

async function start() {
  clock.reset();
  const app = createApp();
  try {
    if (TEST_MODE) await reset.resetAll();
    else await reset.seedIfEmpty();
  } catch (e) {
    console.error('[server] initial seed failed:', e && e.stack ? e.stack : e);
  }
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] e-Service listening on :${PORT} TEST_MODE=${TEST_MODE ? 1 : 0} BUG_MODE=${bugmode.activeBugs().join(',') || '-'} DB_PATH=${db.DB_PATH} now=${clock.nowIso()}`);
  });
  server.requestTimeout = 120000;
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
