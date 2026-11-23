'use strict';
/**
 * Display formatting (B01) — Thai text, B.E. dates, money, data-iso, status/level badges.
 *
 *   const f = require('../lib/format');
 *   f.thDateTime('2026-12-04T16:30:00+07:00')   → '4 ธ.ค. 2569 16:30'
 *   f.thDate('2027-02-02')                       → '2 ก.พ. 2570'
 *   f.money(1010)                                → '฿1,010'     (null/NaN → '–')
 *   f.iso(x)                                     → '2026-12-04T16:30:00+07:00'
 *   f.timeTag(x, 'sla-due')                      → <time data-testid="sla-due" data-iso="…" datetime="…">4 ธ.ค. 2569 16:30</time>
 *   f.timeTag('2027-02-02', 'verify-expires', {dateOnly:true}) → data-iso="2027-02-02"
 *   f.statusBadge('IN_REVIEW')                   → <span data-testid="case-status" data-status="IN_REVIEW">กำลังตรวจสอบ</span>
 *   f.levelBadge('near', 'row-sla-level')        → <span data-testid="row-sla-level" data-level="near">ใกล้ครบกำหนด</span>
 *   f.formatIdNo('1101700123456')                → '1-1017-00123-45-6'
 *   f.maskIdNo('1101700123456')                  → 'X-XXXX-XXXXX-45-6'
 *   f.maskName('สมชาย ใจดี')                      → 'สมชาย ใ***'
 *   f.esc(s)                                     → HTML-escaped string
 */
const clock = require('./clock');

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** CONTRACT §4.1 */
const STATUS_TH = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
};

/** CONTRACT §4.2 */
const LEVEL_TH = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

/** payment-status (CONTRACT §2.5) */
const PAYMENT_STATUS_TH = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };

/** user-role text (CONTRACT §2.1) */
const ROLE_TH = {
  citizen: 'ประชาชน',
  officer: 'เจ้าหน้าที่',
  head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร',
  auditor: 'ผู้ตรวจสอบภายใน',
  admin: 'ผู้ดูแลระบบ',
};

const DEPT_TH = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };

/** CONTRACT §4.3 (display names; editable fees/SLA live in the services table) */
const SERVICE_NAME = {
  'SV-01': 'ขอหนังสือรับรอง',
  'SV-02': 'ขออนุญาตประกอบกิจการ',
  'SV-03': 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
};

/** docKey → Thai label, in CONTRACT §4.3 order */
const DOC_LABEL = {
  'id-card': 'บัตรประชาชน',
  map: 'แผนที่ตั้ง',
  'site-photo': 'ภาพสถานที่',
  plan: 'แบบแปลน',
  deed: 'โฉนด',
  extra: 'เอกสารเพิ่มเติม',
};

/** case-step text for SV-03 (CONTRACT §2.6) */
const STEP_TH = {
  1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน',
  2: 'ขั้นตอน 2/3 · ฝ่ายโยธา',
  3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย',
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isDateOnly(x) {
  return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
}

/** B.E. year of an instant (Bangkok) */
function beYear(x) {
  return clock.bkk(x).year + 543;
}

/** '4 ธ.ค. 2569 16:30' */
function thDateTime(x) {
  if (x === null || x === undefined || x === '') return '–';
  if (isDateOnly(x)) return thDate(x);
  const p = clock.bkk(x);
  if (Number.isNaN(p.year)) return '–';
  return `${p.day} ${TH_MONTHS[p.month - 1]} ${p.year + 543} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** '2 ก.พ. 2570' (accepts 'YYYY-MM-DD', Date or ISO) */
function thDate(x) {
  if (x === null || x === undefined || x === '') return '–';
  let y, m, d;
  if (isDateOnly(x)) {
    [y, m, d] = x.split('-').map(Number);
  } else {
    const p = clock.bkk(x);
    if (Number.isNaN(p.year)) return '–';
    y = p.year;
    m = p.month;
    d = p.day;
  }
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

/** '16:30' */
function thTime(x) {
  const p = clock.bkk(x);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 'ธันวาคม 2569' for a 'YYYY-MM' period, '2569' for 'YYYY' */
function thPeriod(period) {
  const s = String(period || '');
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    return `${TH_MONTHS_FULL[m - 1]} ${y + 543}`;
  }
  if (/^\d{4}$/.test(s)) return `ปี ${Number(s) + 543}`;
  return s;
}

/** '฿1,010' — integer baht; invalid → '–' */
function money(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '–';
  const v = Math.round(Number(n));
  const sign = v < 0 ? '-' : '';
  return `${sign}฿${Math.abs(v).toLocaleString('en-US')}`;
}

/** '1,234' */
function num(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
  return Number(n).toLocaleString('en-US');
}

/** ISO +07:00 (date-only strings pass through unchanged) */
function iso(x) {
  if (x === null || x === undefined || x === '') return '';
  if (isDateOnly(x)) return x;
  return clock.toIso(x) || '';
}

/**
 * <time> element carrying data-iso (A-51).
 * opts: { dateOnly, prefix, tag, className, attrs }
 */
function timeTag(x, testid, opts = {}) {
  const tag = opts.tag || 'time';
  const dateOnly = opts.dateOnly || isDateOnly(x);
  const isoVal = dateOnly ? (isDateOnly(x) ? x : clock.bkkDate(x)) : iso(x);
  const text = x === null || x === undefined || x === '' ? '–' : dateOnly ? thDate(x) : thDateTime(x);
  const tid = testid ? ` data-testid="${esc(testid)}"` : '';
  const cls = opts.className ? ` class="${esc(opts.className)}"` : '';
  const dt = tag === 'time' && isoVal ? ` datetime="${esc(isoVal)}"` : '';
  const extra = opts.attrs ? ' ' + opts.attrs : '';
  return `<${tag}${tid}${cls} data-iso="${esc(isoVal)}"${dt}${extra}>${esc(opts.prefix || '')}${esc(text)}</${tag}>`;
}

/** status badge — text + colour + data-status (CONTRACT §4.1) */
function statusBadge(status, testid = 'case-status') {
  const text = STATUS_TH[status] || status || '–';
  return `<span class="badge st-${esc(String(status || '').toLowerCase())}" data-testid="${esc(testid)}" data-status="${esc(status)}">${esc(text)}</span>`;
}

/** SLA level badge — text + colour + data-level (CONTRACT §4.2) */
function levelBadge(level, testid = 'sla-level') {
  const text = LEVEL_TH[level] || level || '–';
  return `<span class="badge lv-${esc(level)}" data-testid="${esc(testid)}" data-level="${esc(level)}">${esc(text)}</span>`;
}

function serviceLabel(serviceId, name) {
  return `${serviceId} ${name || SERVICE_NAME[serviceId] || ''}`.trim();
}

/** '1101700123456' → '1-1017-00123-45-6' */
function formatIdNo(id) {
  const s = String(id || '').replace(/\D/g, '');
  if (s.length !== 13) return String(id || '');
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}

/** '1101700123456' → 'X-XXXX-XXXXX-45-6' (last 3 digits visible · A-24) */
function maskIdNo(id) {
  const s = String(id || '').replace(/\D/g, '');
  if (s.length !== 13) return 'X-XXXX-XXXXX-XX-X';
  return `X-XXXX-XXXXX-${s.slice(10, 12)}-${s[12]}`;
}

/** 'สมชาย ใจดี' → 'สมชาย ใ***' (A-54) */
function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ? `${parts[0]}` : '';
  const first = parts[0];
  const lastInitial = Array.from(parts.slice(1).join(' '))[0] || '';
  return `${first} ${lastInitial}***`;
}

module.exports = {
  TH_MONTHS,
  TH_MONTHS_FULL,
  STATUS_TH,
  LEVEL_TH,
  PAYMENT_STATUS_TH,
  ROLE_TH,
  DEPT_TH,
  SERVICE_NAME,
  DOC_LABEL,
  STEP_TH,
  esc,
  beYear,
  thDateTime,
  thDate,
  thTime,
  thPeriod,
  money,
  num,
  iso,
  timeTag,
  statusBadge,
  levelBadge,
  serviceLabel,
  formatIdNo,
  maskIdNo,
  maskName,
};
