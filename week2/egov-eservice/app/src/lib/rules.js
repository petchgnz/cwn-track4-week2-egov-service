'use strict';
/**
 * Central numeric business rules (B03) — DECISIONS §2 §3 §6 §7 §8 §9 §10 §12 §18 · BR-01..BR-28.
 *
 * PURE functions: nothing here reads the clock or the database (except the one helper
 * `readHolidays(db)`, kept separate on purpose). Callers pass `now` (from clock.now()) and the
 * holiday table explicitly. All calendar maths is Asia/Bangkok (+07:00) via clock.js helpers.
 *
 * Time inputs accept Date · epoch ms · ISO string with offset ('2026-12-01T09:00:00+07:00').
 * Date-only values are 'YYYY-MM-DD' (Bangkok calendar date). Instants returned are ISO +07:00.
 *
 * holidays: array of 'YYYY-MM-DD' | array of rows {date} | Set | (dateStr) => bool.
 *           REQUIRED wherever business days are counted (pass [] for "no holidays") so that a
 *           forgotten argument fails loudly instead of silently behaving like BUG B03.
 *
 * BUG_MODE (BUGS.md) injected here, owner of the rule:
 *   B01 SV-03 area 101 charged ฿1,000 (surcharge uses `area > 101` instead of `area ≥ 101`)
 *   B03 business days skip Sat/Sun only (holiday table ignored) — due date AND remaining days
 *   B04 no SLA pause while NEED_FIX (extendDueAt returns the old due date, 0 paused days)
 *   B05 QR aged exactly 15:00 still payable (`age > 15:00` instead of `age ≥ 15:00` = expired)
 * Every bug-aware function takes a last `opts` argument: `opts.bugs` overrides BUG_MODE
 *   (false → always correct, e.g. for seed · ['B03'] / 'B03,B04' / Set / fn → simulate).
 * B02 (file size `<`) lives in the citizen module; B10 (on-time % ÷ received) in dashboard —
 * they call the correct helpers here (fileSizeOk / ontimePct) with their own bug switch.
 *
 * Quick reference
 *   isValidIdNo('1101700123456') → true              isValidMobile('0812345678') → true
 *   calcFee('SV-03', {areaSqm:101}) → {ok:true, fee:1010}
 *   calcFee('SV-01', {qty:6}) → {ok:false, status:400, code:'INVALID_QTY', message:'จำนวนฉบับต้อง 1–5 ฉบับ'}
 *   computeDueAt('2026-12-01T16:30:00+07:00', 3, holidays) → '2026-12-08T16:30:00+07:00'
 *   extendDueAt(dueAt, returnedAt, resubmittedAt, holidays) → {dueAt, pausedDays}
 *   slaLevel({status, dueAt}, now, holidays) → 'normal'|'near'|'overdue'|'paused'|'closed'|null
 *   remainingBusinessDays(now, dueAt, holidays) → 3
 *   isQrExpired(qrCreatedAt, payAt) → bool         qrExpiresAt(qrCreatedAt) → ISO (+15:00)
 *   formatCaseNo(2569, 31) → 'EG-2569-000031'      caseYearBE(paidAt) → 2569
 *   docValidUntil('2026-12-01T10:00:00+07:00', 'SV-01') → '2027-02-28'
 *   verifyResult({found, signatureOk, validUntil}, now) → 'VALID'|'EXPIRED'|'TAMPERED'|'NOT_FOUND'
 */
const clock = require('./clock');
const bugmode = require('./bugmode');

// ---------------------------------------------------------------------------------- constants
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const CUTOFF = { hour: 16, minute: 30 }; // A-03: paid at ≥ 16:30:00 → D0 = next business day
const DUE_TIME = { hour: 16, minute: 30 }; // due = 16:30 of the N-th business day after D0

const OTP_TEST_CODE = '123456'; // A-05
const OTP_MAX_FAILS = 3; // A-06
const OTP_LOCK_MS = 15 * MINUTE_MS; // A-06: locked 15:00 from the 3rd failure

const QR_TTL_MS = 15 * MINUTE_MS; // A-15: valid while age < 15:00

const FILE_MAX_BYTES = 5 * 1024 * 1024; // 5,242,880 (inclusive) A-10
const FILE_MAX_COUNT = 5; // A-10

const SV01_QTY_MIN = 1;
const SV01_QTY_MAX = 5;
const SV01_QTY_DEFAULT = 1; // A-56
const SV03_AREA_MIN = 1;
const SV03_AREA_MAX = 500;
const SV03_AREA_BASE = 100; // 1–100 → base fee · 101–500 → base + perSqm × (area − 100)

const MAX_WORKLOAD = 10; // A-19 (IN_REVIEW held by the officer, checked at claim time only)
const MAX_RETURNS = 2; // A-20
const REASON_MIN_CHARS = 10; // A-12 (after trimming)
const FIX_WINDOW_MS = 168 * HOUR_MS; // A-21: 7 calendar days from the return time

const ADMIN_FEE_MIN = 0; // A-53
const ADMIN_FEE_MAX = 100000;
const ADMIN_SLA_MIN = 1;
const ADMIN_SLA_MAX = 60;

/** seed catalogue (DECISIONS §3) — admin may change fee/feePerSqm/sla in the services table */
const DEFAULT_SERVICES = Object.freeze({
  'SV-01': Object.freeze({ id: 'SV-01', fee: 20, feePerSqm: null, sla: 3, validity: '90d', approver: 'officer' }),
  'SV-02': Object.freeze({ id: 'SV-02', fee: 500, feePerSqm: null, sla: 10, validity: '1y', approver: 'head' }),
  'SV-03': Object.freeze({ id: 'SV-03', fee: 1000, feePerSqm: 10, sla: 15, validity: '1y', approver: 'head' }),
});

/** messages for the codes returned here (CONTRACT §5, verbatim) */
const MESSAGES = Object.freeze({
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
});

const CLOSED_STATUSES = Object.freeze(['COMPLETED', 'REJECTED', 'CANCELLED']);
const BACKLOG_STATUSES = Object.freeze(['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED']);
const SLA_RUNNING_STATUSES = Object.freeze(['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED']);

// ------------------------------------------------------------------------------------ helpers
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** bug switch: opts.bugs overrides the BUG_MODE env (false / [] → correct behaviour) */
function bugOn(code, opts) {
  const b = opts ? opts.bugs : undefined;
  if (b === undefined || b === null || b === true) return bugmode.isBug(code);
  if (b === false) return false;
  if (typeof b === 'function') return !!b(code);
  if (b instanceof Set) return b.has(code);
  if (Array.isArray(b)) return b.includes(code);
  if (typeof b === 'string') return b.split(',').map((s) => s.trim().toUpperCase()).includes(code);
  return bugmode.isBug(code);
}

/** strict integer parse: 5 · '5' · ' 5 ' → 5 ; 5.5 · '5.5' · '' · null · 'abc' · true → null */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** instant → ms (throws on invalid input so bad data never yields a silent wrong answer) */
function ms(x) {
  const d = clock.toDate(x);
  const t = d.getTime();
  if (Number.isNaN(t)) throw new TypeError(`rules: invalid date/time ${JSON.stringify(x)}`);
  return t;
}

const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Bangkok calendar date 'YYYY-MM-DD' of an instant (date strings pass through) */
function dateOf(x) {
  if (isDateStr(x)) return x;
  ms(x); // validate
  return clock.bkkDate(x);
}

/** 'YYYY-MM-DD' + n calendar days */
function addCalendarDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0=Sun … 6=Sat of a 'YYYY-MM-DD' */
function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** ISO +07:00 for a Bangkok wall-clock time on a 'YYYY-MM-DD' */
function atBkk(dateStr, hour, minute, second = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return clock.toIso(clock.fromBkk(y, m, d, hour, minute, second));
}

// ------------------------------------------------------------------------- §0 business days
/** normalise the holiday argument to a predicate (dateStr) => bool */
function holidayPredicate(holidays) {
  if (holidays === undefined || holidays === null) {
    throw new TypeError('rules: holidays required (array of "YYYY-MM-DD" / rows {date} / Set) — pass [] for none');
  }
  if (typeof holidays === 'function') return (d) => !!holidays(d);
  if (holidays instanceof Set) return (d) => holidays.has(d);
  if (holidays instanceof Map) return (d) => holidays.has(d);
  if (Array.isArray(holidays) || typeof holidays[Symbol.iterator] === 'function') {
    const set = new Set();
    for (const h of holidays) {
      const v = h && typeof h === 'object' ? h.date : h;
      if (v) set.add(isDateStr(v) ? v : dateOf(v));
    }
    return (d) => set.has(d);
  }
  throw new TypeError('rules: holidays must be an array, Set or function');
}

/** only impure helper: holiday dates from the DB (SELECT date FROM holidays) */
function readHolidays(db) {
  return db
    .prepare('SELECT date FROM holidays ORDER BY date')
    .all()
    .map((r) => r.date);
}

/**
 * business-day test built once per call: (dateStr) => bool.
 * Mon–Fri and not a holiday (DECISIONS §0 · A-02). BUG B03: holiday table ignored (Sat/Sun only).
 */
function businessDayFn(holidays, opts) {
  const isHoliday = holidayPredicate(holidays);
  const skipHolidays = !bugOn('B03', opts);
  return (d) => {
    const dow = dayOfWeek(d);
    if (dow === 0 || dow === 6) return false;
    return skipHolidays ? !isHoliday(d) : true;
  };
}

function isBusinessDay(date, holidays, opts) {
  return businessDayFn(holidays, opts)(dateOf(date));
}

function nextBizWith(isBiz, d) {
  for (let i = 0; i < 3660; i++) {
    d = addCalendarDays(d, 1);
    if (isBiz(d)) return d;
  }
  throw new Error('rules: no business day within 10 years');
}

function addBizWith(isBiz, d, n) {
  const count = toInt(n);
  if (count === null || count < 0) throw new TypeError(`rules: business-day count must be an integer ≥ 0 (got ${n})`);
  for (let i = 0; i < count; i++) d = nextBizWith(isBiz, d);
  return d;
}

function countBizWith(isBiz, from, to) {
  let d = from;
  let n = 0;
  while (d < to) {
    d = addCalendarDays(d, 1);
    if (isBiz(d)) n++;
  }
  return n;
}

/** first business day strictly after `date` */
function nextBusinessDay(date, holidays, opts) {
  return nextBizWith(businessDayFn(holidays, opts), dateOf(date));
}

/** the n-th business day after `date` (n = 0 → `date` itself) */
function addBusinessDays(date, n, holidays, opts) {
  return addBizWith(businessDayFn(holidays, opts), dateOf(date), n);
}

/** number of business days in the date range (fromExclusive, toInclusive] — 0 if to ≤ from */
function countBusinessDays(fromExclusive, toInclusive, holidays, opts) {
  return countBizWith(businessDayFn(holidays, opts), dateOf(fromExclusive), dateOf(toInclusive));
}

/** true if the Bangkok time of day is before the 16:30:00 cut-off */
function isBeforeCutoff(at) {
  const p = clock.bkk(clock.toDate(ms(at)));
  return p.hour * 3600 + p.minute * 60 + p.second < CUTOFF.hour * 3600 + CUTOFF.minute * 60;
}

// --------------------------------------------------------------------------------- §8 SLA
/** D0 (BR-12): paid date if it is a business day and before 16:30:00, else next business day */
function slaStartDate(paidAt, holidays, opts) {
  const isBiz = businessDayFn(holidays, opts);
  const d = dateOf(paidAt);
  if (isBiz(d) && isBeforeCutoff(paidAt)) return d;
  return nextBizWith(isBiz, d);
}

/** due = 16:30 of the N-th business day after D0 → ISO '2026-12-08T16:30:00+07:00' */
function computeDueAt(paidAt, slaDays, holidays, opts) {
  const n = toInt(slaDays);
  if (n === null || n < 0) throw new TypeError(`rules: SLA must be an integer ≥ 0 (got ${slaDays})`);
  const d0 = slaStartDate(paidAt, holidays, opts);
  return atBkk(addBusinessDays(d0, n, holidays, opts), DUE_TIME.hour, DUE_TIME.minute);
}

/** business days paused while NEED_FIX (BR-13): count in (return date, resubmit date], dates only */
function pausedBusinessDays(returnedAt, resubmittedAt, holidays, opts) {
  return countBusinessDays(dateOf(returnedAt), dateOf(resubmittedAt), holidays, opts);
}

/**
 * New due date when the citizen resubmits (BR-13):
 *   due' = due + pausedDays business days (same time of day, normally 16:30).
 * Use the holiday table as it is at resubmission time (A-42).
 * BUG B04 → no pause: {dueAt: unchanged, pausedDays: 0}.
 */
function extendDueAt(dueAt, returnedAt, resubmittedAt, holidays, opts) {
  const due = clock.toIso(ms(dueAt));
  const isBiz = businessDayFn(holidays, opts);
  if (bugOn('B04', opts)) {
    ms(returnedAt);
    ms(resubmittedAt);
    return { dueAt: due, pausedDays: 0 };
  }
  const paused = countBizWith(isBiz, dateOf(returnedAt), dateOf(resubmittedAt));
  if (paused === 0) return { dueAt: due, pausedDays: 0 };
  const p = clock.bkk(due);
  const newDate = addBizWith(isBiz, dateOf(due), paused);
  return { dueAt: atBkk(newDate, p.hour, p.minute, p.second), pausedDays: paused };
}

/** remaining days (BR-14) = business days after today up to and including the due date (≥ 0) */
function remainingBusinessDays(now, dueAt, holidays, opts) {
  return countBusinessDays(dateOf(now), dateOf(dueAt), holidays, opts);
}

/** now > due (strict: 16:30:00 is still on time, 16:30:01 is overdue) */
function isOverdue(now, dueAt) {
  return ms(now) > ms(dueAt);
}

/** BR-25 / DECISIONS §18: on time ⇔ closed_at ≤ due (16:30:00 inclusive) */
function isOnTime(closedAt, dueAt) {
  return ms(closedAt) <= ms(dueAt);
}

/**
 * SLA level (CONTRACT §4.2 · BR-14 · A-33).
 *   COMPLETED/REJECTED/CANCELLED → 'closed' · NEED_FIX → 'paused'
 *   now > due → 'overdue' · remaining ≤ 1 → 'near' · else 'normal'
 *   DRAFT / PENDING_PAYMENT / no due date → null
 * caseLike: {status, dueAt|due_at}
 */
function slaLevel(caseLike, now, holidays, opts) {
  const status = caseLike && caseLike.status;
  if (CLOSED_STATUSES.includes(status)) return 'closed';
  if (status === 'NEED_FIX') return 'paused';
  const due = caseLike && (caseLike.dueAt !== undefined ? caseLike.dueAt : caseLike.due_at);
  if (!SLA_RUNNING_STATUSES.includes(status) || !due) return null;
  if (isOverdue(now, due)) return 'overdue';
  return remainingBusinessDays(now, due, holidays, opts) <= 1 ? 'near' : 'normal';
}

/** {level, remaining} — remaining = null when the level is not time-based */
function slaInfo(caseLike, now, holidays, opts) {
  const level = slaLevel(caseLike, now, holidays, opts);
  if (level !== 'normal' && level !== 'near') return { level, remaining: level === 'overdue' ? 0 : null };
  const due = caseLike.dueAt !== undefined ? caseLike.dueAt : caseLike.due_at;
  return { level, remaining: remainingBusinessDays(now, due, holidays, opts) };
}

// ------------------------------------------------------------------- §2 identity / register
/** check digit (13th) for the first 12 digits: (11 − Σ dᵢ×(13−i) mod 11) mod 10 */
function idCheckDigit(first12) {
  const s = String(first12);
  if (!/^\d{12}$/.test(s)) throw new TypeError('rules: idCheckDigit needs 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10;
}

/** BR-01: exactly 13 digits (string) with a valid checksum */
function isValidIdNo(idNo) {
  if (typeof idNo !== 'string' && typeof idNo !== 'number') return false;
  const s = String(idNo);
  if (!/^\d{13}$/.test(s)) return false;
  return idCheckDigit(s.slice(0, 12)) === Number(s[12]);
}

/** BR-03: mobile = 10 digits starting with 0 */
function isValidMobile(mobile) {
  return typeof mobile === 'string' && /^0\d{9}$/.test(mobile);
}

/** BR-02: lock ends 15:00 after the 3rd consecutive failure */
function otpLockedUntil(thirdFailAt) {
  return clock.toIso(ms(thirdFailAt) + OTP_LOCK_MS);
}

/** locked while now < lockedUntil (14:59 locked · 15:00 unlocked) */
function isOtpLocked(lockedUntil, now) {
  if (!lockedUntil) return false;
  return ms(now) < ms(lockedUntil);
}

function otpAttemptsLeft(fails) {
  return Math.max(0, OTP_MAX_FAILS - (toInt(fails) || 0));
}

/**
 * register one wrong OTP. fails = consecutive failures so far (0 after a correct OTP or an unlock).
 * → {fails, locked, lockedUntil, attemptsLeft}; on the 3rd failure the counter restarts at 0
 *   (BR-02: after unlocking the next failure counts as the 1st).
 */
function otpOnFailure(fails, now) {
  const n = (toInt(fails) || 0) + 1;
  if (n >= OTP_MAX_FAILS) {
    return { fails: 0, locked: true, lockedUntil: otpLockedUntil(now), attemptsLeft: 0 };
  }
  return { fails: n, locked: false, lockedUntil: null, attemptsLeft: OTP_MAX_FAILS - n };
}

// ------------------------------------------------------------------------------ §3 fees
function feeError(code) {
  return { ok: false, status: 400, code, message: MESSAGES[code] };
}

/** merge a services-table row ({fee, fee_per_sqm} or {fee, feePerSqm}) over the seed defaults */
function serviceConfig(serviceId, service) {
  const def = DEFAULT_SERVICES[serviceId];
  if (!def) return null;
  const s = service || {};
  const fee = toInt(s.fee);
  const perSqm = toInt(s.feePerSqm !== undefined ? s.feePerSqm : s.fee_per_sqm);
  const base = toInt(s.feeBase);
  return {
    ...def,
    fee: base !== null ? base : fee !== null ? fee : def.fee,
    feePerSqm: perSqm !== null ? perSqm : def.feePerSqm,
    sla: toInt(s.sla) !== null ? toInt(s.sla) : def.sla,
  };
}

/**
 * Fee (BR-04 BR-05 · DECISIONS §3).
 *   SV-01 {qty}: integer 1–5 (missing → 1) → fee × qty
 *   SV-02 {}: fixed fee
 *   SV-03 {areaSqm}: integer 1–100 → base · 101–500 → base + perSqm × (area − 100)
 *          ≤ 0 / not an integer → INVALID_AREA · > 500 → AREA_TOO_LARGE
 *   BUG B01: surcharge only when area > 101 (101 → ฿1,000; 102 → ฿1,020 still correct)
 * service: optional services row (admin-edited fee / fee_per_sqm); defaults = seed values.
 * → {ok:true, fee, qty?, areaSqm?} | {ok:false, status:400, code, message}
 */
function calcFee(serviceId, input, service, opts) {
  const cfg = serviceConfig(serviceId, service);
  if (!cfg) return { ok: false, status: 400, code: 'INVALID_SERVICE', message: 'ไม่พบบริการ' };
  const inp = input || {};
  if (serviceId === 'SV-01') {
    const raw = inp.qty;
    const qty = raw === undefined || raw === null ? SV01_QTY_DEFAULT : toInt(raw);
    if (qty === null || qty < SV01_QTY_MIN || qty > SV01_QTY_MAX) return feeError('INVALID_QTY');
    return { ok: true, fee: cfg.fee * qty, qty };
  }
  if (serviceId === 'SV-02') {
    return { ok: true, fee: cfg.fee };
  }
  // SV-03
  const raw = inp.areaSqm !== undefined ? inp.areaSqm : inp.area_sqm !== undefined ? inp.area_sqm : inp.area;
  const area = toInt(raw);
  if (area === null || area < SV03_AREA_MIN) return feeError('INVALID_AREA');
  if (area > SV03_AREA_MAX) return feeError('AREA_TOO_LARGE');
  const surcharge = bugOn('B01', opts) ? area > SV03_AREA_BASE + 1 : area >= SV03_AREA_BASE + 1;
  const fee = surcharge ? cfg.fee + cfg.feePerSqm * (area - SV03_AREA_BASE) : cfg.fee;
  return { ok: true, fee, areaSqm: area };
}

/** DECISIONS §18 · BR-28: admin fee = integer 0–100,000 */
function validateAdminFee(v) {
  const n = toInt(v);
  if (n === null || n < ADMIN_FEE_MIN || n > ADMIN_FEE_MAX) {
    return { ok: false, status: 400, code: 'INVALID_FEE', message: MESSAGES.INVALID_FEE };
  }
  return { ok: true, value: n };
}

/** DECISIONS §18 · BR-28: admin SLA = integer 1–60 business days */
function validateAdminSla(v) {
  const n = toInt(v);
  if (n === null || n < ADMIN_SLA_MIN || n > ADMIN_SLA_MAX) {
    return { ok: false, status: 400, code: 'INVALID_SLA', message: MESSAGES.INVALID_SLA };
  }
  return { ok: true, value: n };
}

// ---------------------------------------------------------------------------- §4 files
/** BR-07: size ≤ 5,242,880 bytes (correct rule — BUG B02 belongs to the upload module) */
function fileSizeOk(size) {
  const n = toInt(size);
  return n !== null && n >= 0 && n <= FILE_MAX_BYTES;
}

/** BR-07: may a draft that already has `currentCount` files take one more? (5 ✓ · 6th ✗) */
function canAddFile(currentCount) {
  return (toInt(currentCount) || 0) < FILE_MAX_COUNT;
}

/** BR-06: type from magic bytes only → 'application/pdf' | 'image/jpeg' | 'image/png' | null */
function detectFileType(buf) {
  if (!buf || buf.length < 3) return null;
  const b = (i) => buf[i];
  if (buf.length >= 4 && b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf'; // %PDF
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  return null;
}

// --------------------------------------------------------------------- §6 running numbers
/** Buddhist-era year (Bangkok) of an instant: 2026-12-31T23:59+07:00 → 2569 · 2027-01-01T00:00 → 2570 */
function beYearOf(at) {
  return clock.bkk(clock.toDate(ms(at))).year + 543;
}

/** year used for a case/receipt number = B.E. year of the payment time (A-14) */
const caseYearBE = beYearOf;

function formatRunningNo(prefix, yearBE, seq) {
  const y = toInt(yearBE);
  const n = toInt(seq);
  if (y === null || n === null || n < 1 || n > 999999) throw new TypeError(`rules: bad running number ${prefix} ${yearBE} ${seq}`);
  return `${prefix}-${y}-${pad(n, 6)}`;
}

/** 'EG-2569-000031' */
const formatCaseNo = (yearBE, seq) => formatRunningNo('EG', yearBE, seq);
/** 'RC-2569-000031' (A-48: same running number as the case) */
const formatReceiptNo = (yearBE, seq) => formatRunningNo('RC', yearBE, seq);
/** 'DOC-2569-000002' (B.E. year of the issue time · A-48) */
const formatDocNo = (yearBE, seq) => formatRunningNo('DOC', yearBE, seq);

/** counters table key for a running number in the year of `at`: seqKey('case', paidAt) → 'case:2569' */
function seqKey(kind, at) {
  return `${kind}:${beYearOf(at)}`;
}

const RUNNING_NO_RE = /^(EG|RC|DOC)-(\d{4})-(\d{6})$/;

/** 'EG-2569-000031' → {prefix:'EG', yearBE:2569, seq:31} | null */
function parseRunningNo(s) {
  const m = RUNNING_NO_RE.exec(String(s || ''));
  return m ? { prefix: m[1], yearBE: Number(m[2]), seq: Number(m[3]) } : null;
}

const isCaseNo = (s) => /^EG-\d{4}-\d{6}$/.test(String(s || ''));
/** receipt number that belongs to a case number */
const receiptNoForCase = (caseNo) => (isCaseNo(caseNo) ? caseNo.replace(/^EG-/, 'RC-') : null);

/** case numbers in numeric order (year, then running number) */
function compareCaseNo(a, b) {
  const pa = parseRunningNo(a);
  const pb = parseRunningNo(b);
  if (pa && pb) return pa.yearBE - pb.yearBE || pa.seq - pb.seq;
  return String(a || '').localeCompare(String(b || ''));
}

// ---------------------------------------------------------------------------- §7 payment
/** QR expiry instant = created + 15:00 */
function qrExpiresAt(qrCreatedAt) {
  return clock.toIso(ms(qrCreatedAt) + QR_TTL_MS);
}

/** age of the QR at `at` in ms */
function qrAgeMs(qrCreatedAt, at) {
  return ms(at) - ms(qrCreatedAt);
}

/** BR-10: expired ⇔ age ≥ 15:00 (14:59 ✓ · 15:00 ✗). BUG B05: expired ⇔ age > 15:00 */
function isQrExpired(qrCreatedAt, at, opts) {
  const age = qrAgeMs(qrCreatedAt, at);
  return bugOn('B05', opts) ? age > QR_TTL_MS : age >= QR_TTL_MS;
}

/** BR-11: paid amount must equal the (locked) fee exactly — integer baht */
function amountMatches(amount, fee) {
  const a = toInt(amount);
  const f = toInt(fee);
  return a !== null && f !== null && a === f;
}

/** payment status shown to users: PAID · EXPIRED (PENDING and QR expired at `now`) · PENDING · VOID */
function paymentStatus(payment, now, opts) {
  if (!payment) return null;
  if (payment.status === 'PAID' || payment.status === 'VOID') return payment.status;
  const created = payment.qrCreatedAt || payment.created_at || payment.createdAt;
  return isQrExpired(created, now, opts) ? 'EXPIRED' : 'PENDING';
}

// ------------------------------------------------------------------------------ §9 queue
/** BR-16: earliest due first · ties by case number ascending. rows: {dueAt|due_at, caseNo|case_no} */
function compareQueue(a, b) {
  const da = a.dueAt !== undefined ? a.dueAt : a.due_at;
  const db_ = b.dueAt !== undefined ? b.dueAt : b.due_at;
  const ta = da ? ms(da) : Infinity;
  const tb = db_ ? ms(db_) : Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return compareCaseNo(a.caseNo !== undefined ? a.caseNo : a.case_no, b.caseNo !== undefined ? b.caseNo : b.case_no);
}

/** BR-18: may claim while holding < 10 (9 → ✓ becomes 10 · 10 → ✗) */
function canClaim(currentWorkload) {
  return (toInt(currentWorkload) || 0) < MAX_WORKLOAD;
}

/** BR-19: return allowed while returnCount < 2 (2nd ✓ · 3rd ✗) — BUG B12 lives in workflow */
function canReturn(returnCount) {
  return (toInt(returnCount) || 0) < MAX_RETURNS;
}

/** A-12 / BR-19: reason ≥ 10 characters after trimming (9 ✗ · 10 ✓ · 10 spaces ✗) */
function isReasonValid(reason) {
  if (typeof reason !== 'string') return false;
  return Array.from(reason.trim()).length >= REASON_MIN_CHARS;
}

/** A-21: fix deadline = return time + 168 h */
function fixDeadline(returnedAt) {
  return clock.toIso(ms(returnedAt) + FIX_WINDOW_MS);
}

/** BR-20: window over ⇔ now − returnedAt ≥ 168:00 (167:59 ✓ resubmit · 168:00 ✗ auto-cancel) */
function isFixWindowExpired(returnedAt, now) {
  return ms(now) - ms(returnedAt) >= FIX_WINDOW_MS;
}

// --------------------------------------------------------------------------- §10 documents
/** validity code of a service: SV-01 '90d' · SV-02/SV-03 '1y' */
function validityOf(serviceIdOrValidity) {
  const v = String(serviceIdOrValidity || '');
  if (DEFAULT_SERVICES[v]) return DEFAULT_SERVICES[v].validity;
  return v;
}

/**
 * Last valid day 'YYYY-MM-DD' (BR-23 · A-43 · A-61).
 *   'Nd' → issue date + (N − 1) days            (SV-01 90d: 2026-12-01 → 2027-02-28)
 *   'Ny' → anniversary N years later − 1 day; an anniversary that does not exist (29 Feb)
 *          becomes 28 Feb                         (SV-02 1y: 2026-12-01 → 2027-11-30 · 2028-02-29 → 2029-02-27)
 */
function docValidUntil(issuedAt, serviceIdOrValidity) {
  const issue = dateOf(issuedAt);
  const v = validityOf(serviceIdOrValidity);
  let m = /^(\d+)d$/.exec(v);
  if (m) return addCalendarDays(issue, Number(m[1]) - 1);
  m = /^(\d+)y$/.exec(v);
  if (m) {
    const [y, mo, d] = issue.split('-').map(Number);
    const ty = y + Number(m[1]);
    const lastDom = new Date(Date.UTC(ty, mo, 0)).getUTCDate();
    const anniversary = `${ty}-${pad(mo)}-${pad(Math.min(d, lastDom))}`;
    return addCalendarDays(anniversary, -1);
  }
  throw new TypeError(`rules: unknown validity ${JSON.stringify(serviceIdOrValidity)}`);
}

/** expired from 00:00 of the day after the last valid day */
function isDocExpired(validUntil, now) {
  return dateOf(now) > dateOf(validUntil);
}

/**
 * /verify result (A-43 order): not found → NOT_FOUND · signature mismatch → TAMPERED (even if
 * also expired) · past validUntil → EXPIRED · else VALID
 */
function verifyResult(doc, now) {
  if (!doc || doc.found === false) return 'NOT_FOUND';
  if (!doc.signatureOk) return 'TAMPERED';
  const vu = doc.validUntil !== undefined ? doc.validUntil : doc.valid_until;
  return isDocExpired(vu, now) ? 'EXPIRED' : 'VALID';
}

// --------------------------------------------------------------------------- §12 dashboard
/**
 * BR-25: on-time % = onTime ÷ denominator × 100, 1 decimal, half-up (exact integer maths).
 * denominator 0 → null (show '–'). The dashboard passes "closed" (B10 passes "received").
 */
function ontimePct(onTime, denominator) {
  const a = toInt(onTime);
  const b = toInt(denominator);
  if (a === null || b === null || b <= 0) return null;
  const tenths = Math.floor((2 * a * 1000 + b) / (2 * b)); // round(a*1000/b) half-up
  return tenths / 10;
}

/** 85.7 → '85.7%' · 100 → '100.0%' · null → '–' */
function formatPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return '–';
  return `${Number(pct).toFixed(1)}%`;
}

module.exports = {
  // constants
  CUTOFF,
  DUE_TIME,
  OTP_TEST_CODE,
  OTP_MAX_FAILS,
  OTP_LOCK_MS,
  QR_TTL_MS,
  FILE_MAX_BYTES,
  FILE_MAX_COUNT,
  SV01_QTY_MIN,
  SV01_QTY_MAX,
  SV01_QTY_DEFAULT,
  SV03_AREA_MIN,
  SV03_AREA_MAX,
  SV03_AREA_BASE,
  MAX_WORKLOAD,
  MAX_RETURNS,
  REASON_MIN_CHARS,
  FIX_WINDOW_MS,
  ADMIN_FEE_MIN,
  ADMIN_FEE_MAX,
  ADMIN_SLA_MIN,
  ADMIN_SLA_MAX,
  DEFAULT_SERVICES,
  MESSAGES,
  CLOSED_STATUSES,
  BACKLOG_STATUSES,
  SLA_RUNNING_STATUSES,
  // helpers
  toInt,
  dateOf,
  addCalendarDays,
  dayOfWeek,
  bugOn,
  // §0 / §8 calendar + SLA
  readHolidays,
  businessDayFn,
  isBusinessDay,
  nextBusinessDay,
  addBusinessDays,
  countBusinessDays,
  isBeforeCutoff,
  slaStartDate,
  computeDueAt,
  pausedBusinessDays,
  extendDueAt,
  remainingBusinessDays,
  isOverdue,
  isOnTime,
  slaLevel,
  slaInfo,
  // §2 identity
  idCheckDigit,
  isValidIdNo,
  isValidMobile,
  otpLockedUntil,
  isOtpLocked,
  otpAttemptsLeft,
  otpOnFailure,
  // §3 fees / admin ranges
  serviceConfig,
  calcFee,
  validateAdminFee,
  validateAdminSla,
  // §4 files
  fileSizeOk,
  canAddFile,
  detectFileType,
  // §6 running numbers
  beYearOf,
  caseYearBE,
  formatCaseNo,
  formatReceiptNo,
  formatDocNo,
  seqKey,
  parseRunningNo,
  isCaseNo,
  receiptNoForCase,
  compareCaseNo,
  // §7 payment
  qrExpiresAt,
  qrAgeMs,
  isQrExpired,
  amountMatches,
  paymentStatus,
  // §9 queue / workflow
  compareQueue,
  canClaim,
  canReturn,
  isReasonValid,
  fixDeadline,
  isFixWindowExpired,
  // §10 documents
  validityOf,
  docValidUntil,
  isDocExpired,
  verifyResult,
  // §12 dashboard
  ontimePct,
  formatPct,
};
