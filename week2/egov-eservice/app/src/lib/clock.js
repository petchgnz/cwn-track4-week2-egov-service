'use strict';
/**
 * Application clock (B01) — the ONLY source of "now" for business rules.
 *
 * TEST_MODE=1 : clock is FROZEN (A-37). Boot/reset → 2026-12-01T09:00:00+07:00.
 *               PUT /api/test/clock {"now": ISO-with-offset} moves it.
 * otherwise   : real wall-clock time.
 *
 * All formatting is Asia/Bangkok (+07:00, no DST) independent of the host TZ.
 *
 *   const clock = require('../lib/clock');
 *   clock.now()            → Date (instant)
 *   clock.nowIso()         → '2026-12-01T09:00:00+07:00'
 *   clock.toIso(d)         → ISO +07:00 for any Date / ms / ISO string
 *   clock.parseIso(s)      → Date | null  (offset REQUIRED: 'Z' or ±HH:MM)
 *   clock.bkk(d)           → {year, month, day, hour, minute, second, dow}  (dow 0=Sun … 6=Sat)
 *   clock.bkkDate(d)       → 'YYYY-MM-DD' (Bangkok calendar date)
 *   clock.fromBkk(y,m,d,hh,mm,ss) → Date for a Bangkok wall-clock time
 *   clock.addMinutes(d,n) / addHours(d,n) / addDays(d,n) → Date
 */
const { TEST_MODE } = require('./bugmode');

const OFFSET_MS = 7 * 60 * 60 * 1000;
const DEFAULT_NOW = '2026-12-01T09:00:00+07:00';
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

let frozenMs = TEST_MODE ? Date.parse(DEFAULT_NOW) : null;

const pad = (n, w = 2) => String(n).padStart(w, '0');

function toDate(x) {
  if (x instanceof Date) return new Date(x.getTime());
  if (typeof x === 'number') return new Date(x);
  if (typeof x === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) {
      const [y, m, d] = x.split('-').map(Number);
      return fromBkk(y, m, d);
    }
    const d = parseIso(x) || new Date(x);
    return d;
  }
  return new Date(NaN);
}

/** Strict ISO-8601 parser: offset is mandatory. Returns Date or null. */
function parseIso(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || (sec && +sec > 59)) return null;
  const ms = Date.parse(s.trim());
  if (Number.isNaN(ms)) return null;
  // reject rolled-over dates such as 2026-02-31
  const local = new Date(ms + offsetOf(m[8]));
  if (local.getUTCFullYear() !== +y || local.getUTCMonth() + 1 !== +mo || local.getUTCDate() !== +d) return null;
  return new Date(ms);
}

function offsetOf(tz) {
  if (tz === 'Z') return 0;
  const sign = tz[0] === '-' ? -1 : 1;
  const [hh, mm] = tz.slice(1).split(':').map(Number);
  return sign * (hh * 60 + mm) * 60000;
}

/** Bangkok wall-clock parts of an instant */
function bkk(x) {
  const d = toDate(x);
  const t = new Date(d.getTime() + OFFSET_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
    ms: t.getUTCMilliseconds(),
    dow: t.getUTCDay(),
  };
}

/** Date for a Bangkok wall-clock time (month 1-12) */
function fromBkk(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - OFFSET_MS);
}

/** 'YYYY-MM-DDTHH:MM:SS+07:00' */
function toIso(x) {
  if (x === null || x === undefined || x === '') return null;
  const d = toDate(x);
  if (Number.isNaN(d.getTime())) return null;
  const p = bkk(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+07:00`;
}

/** 'YYYY-MM-DD' Bangkok calendar date */
function bkkDate(x) {
  const p = bkk(x);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function now() {
  return new Date(frozenMs !== null ? frozenMs : Date.now());
}
function nowMs() {
  return now().getTime();
}
function nowIso() {
  return toIso(now());
}

/** Set (and freeze) the clock. Throws {code:'INVALID_TIME'} on bad input. Returns ISO +07:00. */
function setNow(iso) {
  const d = parseIso(iso);
  if (!d) {
    const err = new Error('INVALID_TIME');
    err.code = 'INVALID_TIME';
    throw err;
  }
  frozenMs = d.getTime();
  return nowIso();
}

/** Back to default: frozen 2026-12-01T09:00:00+07:00 in TEST_MODE, real time otherwise */
function reset() {
  frozenMs = TEST_MODE ? Date.parse(DEFAULT_NOW) : null;
  return nowIso();
}

function isFrozen() {
  return frozenMs !== null;
}

const addMinutes = (x, n) => new Date(toDate(x).getTime() + n * 60000);
const addHours = (x, n) => new Date(toDate(x).getTime() + n * 3600000);
const addDays = (x, n) => new Date(toDate(x).getTime() + n * 86400000);

module.exports = {
  DEFAULT_NOW,
  now,
  nowMs,
  nowIso,
  setNow,
  reset,
  isFrozen,
  parseIso,
  toIso,
  toDate,
  bkk,
  bkkDate,
  fromBkk,
  addMinutes,
  addHours,
  addDays,
};
