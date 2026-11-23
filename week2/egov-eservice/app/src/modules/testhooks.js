'use strict';
/**
 * Test hooks (B01) — CONTRACT §8. Mounted only when TEST_MODE=1; server.js already answers
 * 404 for every /api/test/* when TEST_MODE is off.
 *   POST /api/test/reset  → wipe everything (sessions, OTP locks, notifications, audit, uploads)
 *                           + clock default + re-seed (src/seed.js) → {"ok":true,"now":"…"}
 *   GET  /api/test/clock  → {"now":"…"}
 *   PUT  /api/test/clock  {"now":"2026-12-01T16:30:00+07:00"} → frozen · 400 INVALID_TIME
 * payments/<ref>/pay and documents/<docNo>/tamper are registered by their owning modules.
 */
module.exports = {
  order: 0,
  register(app, ctx) {
    if (!ctx.TEST_MODE) return;
    const { layout: L, clock, reset, session } = ctx;

    app.post('/api/test/reset', L.ah(async (req, res) => {
      const out = await reset.resetAll();
      session.destroy(req, res); // also clear the caller's cookie
      res.status(200).json({ ok: true, now: out.now });
    }));

    app.get('/api/test/clock', (req, res) => res.status(200).json({ now: clock.nowIso() }));

    app.put('/api/test/clock', (req, res) => {
      const v = req.body && req.body.now;
      if (typeof v !== 'string') return L.apiError(res, 400, 'INVALID_TIME');
      try {
        return res.status(200).json({ now: clock.setNow(v) });
      } catch (e) {
        return L.apiError(res, 400, 'INVALID_TIME');
      }
    });
  },
};
