'use strict';
/**
 * Page shell + shared testids (CONTRACT §2.1) + RBAC middleware (B01).
 *
 *   const L = require('../lib/layout');
 *   app.get('/officer/queue', L.requireRole('officer', 'head'), (req, res) =>
 *     L.render(req, res, { title: 'คิวงาน', body: '<h1>คิวงาน</h1>…', error, success }));
 *   app.get('/api/x', L.requireRole('citizen'), …)   // API paths answer JSON 401/403 instead of redirect/HTML
 *
 *   L.page(req, opts) → HTML string      L.render(req, res, opts)  (opts.status default 200)
 *   L.sendForbidden(req, res)            → 403 page with forbidden-msg / JSON {code:'FORBIDDEN'}
 *   L.sendNotFound(req, res)             → 404 page with not-found-msg 'ไม่พบคำขอ' / JSON {code:'NOT_FOUND'}
 *   L.apiError(res, 409, 'ALREADY_CLAIMED' [, message] [, extra])  → {"code","message",...extra}
 *   L.ERRORS.ALREADY_CLAIMED            → 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว' (CONTRACT §5, exact text)
 *   L.landingFor(user)                   → '/officer/queue' …
 *
 * Shared message slots: the shell renders exactly ONE `action-error` (role=alert) and ONE
 * `action-success` (role=status). Pass opts.error / opts.success, or from browser JS call
 * App.showError(msg) / App.showSuccess(msg) (src/public/app.js). Do not render your own copies.
 */
const db = require('./db');
const { esc, ROLE_TH } = require('./format');

const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];

const LANDING = {
  citizen: '/citizen',
  officer: '/officer/queue',
  head: '/head/approvals',
  executive: '/dashboard',
  auditor: '/audit',
  admin: '/admin/services',
};

/** CONTRACT §5 — exact texts */
const ERRORS = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  MISSING_DOCS: 'ยังขาดเอกสาร: ',
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม',
  NOT_FOUND: 'ไม่พบคำขอ',
  CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
  INVALID_TIME: 'รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น ISO 8601 พร้อม offset เช่น 2026-12-01T09:00:00+07:00)',
  DOC_NOT_FOUND: 'ไม่พบเอกสาร',
};

/** menu items per role (CONTRACT §2.1: only for roles that may open the page) */
const NAV = [
  { testid: 'nav-my-cases', href: '/citizen', label: 'คำขอของฉัน', roles: ['citizen'] },
  { testid: 'nav-queue', href: '/officer/queue', label: 'คิวงาน', roles: ['officer', 'head'] },
  { testid: 'nav-approvals', href: '/head/approvals', label: 'รออนุมัติ', roles: ['head'] },
  { testid: 'nav-dashboard', href: '/dashboard', label: 'Dashboard', roles: ['executive'] },
  { testid: 'nav-audit', href: '/audit', label: 'Audit Trail', roles: ['auditor'] },
  { testid: 'nav-admin-services', href: '/admin/services', label: 'บริการ', roles: ['admin'] },
  { testid: 'nav-admin-holidays', href: '/admin/holidays', label: 'วันหยุด', roles: ['admin'] },
  { testid: 'nav-admin-users', href: '/admin/users', label: 'ผู้ใช้', roles: ['admin'] },
];

function isApi(req) {
  return (req.originalUrl || req.url || '').startsWith('/api/');
}

function landingFor(user) {
  if (!user) return '/login';
  if (user.role === 'citizen' && user.registered === false) return '/register';
  return LANDING[user.role] || '/login';
}

/** JSON error {"code","message",...extra}. message defaults to ERRORS[code]. */
function apiError(res, status, code, message, extra) {
  if (message && typeof message === 'object') {
    extra = message;
    message = undefined;
  }
  const body = Object.assign({ code, message: message || ERRORS[code] || code }, extra || {});
  return res.status(status).json(body);
}

function bellCount(user) {
  if (!user || !['officer', 'head'].includes(user.role)) return 0;
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE username = ?').get(user.username).n;
  } catch {
    return 0;
  }
}

function header(req) {
  const user = req && req.user;
  let navHtml = '';
  let whoHtml = '';
  if (user) {
    const items = NAV.filter((n) => n.roles.includes(user.role)).map(
      (n) => `<li><a data-testid="${n.testid}" href="${n.href}">${esc(n.label)}</a></li>`
    );
    if (['officer', 'head'].includes(user.role)) {
      items.push(
        `<li><a data-testid="nav-bell" href="/notifications" class="bell"><span aria-hidden="true">🔔</span> แจ้งเตือน <span data-testid="bell-count" class="count">${bellCount(user)}</span></a></li>`
      );
    }
    navHtml = `<nav class="app-nav" aria-label="เมนูหลัก"><ul>${items.join('')}</ul></nav>`;
    const deptAttr = user.dept ? ` data-dept="${esc(user.dept)}"` : '';
    whoHtml = `<div class="who">
      <span data-testid="user-name" class="user-name">${esc(user.name)}</span>
      <span data-testid="user-role" class="user-role" data-role="${esc(user.role)}"${deptAttr}>${esc(ROLE_TH[user.role] || user.role)}</span>
      <form method="post" action="/logout" class="logout-form"><button type="submit" data-testid="logout-btn" class="btn btn-ghost">ออกจากระบบ</button></form>
    </div>`;
  }
  return `<header data-testid="app-header" class="app-header">
  <div class="container header-inner">
    <a class="brand" href="/">e-Service เทศบาลนครตัวอย่าง <small>(ระบบสมมติ)</small></a>
    ${navHtml}
    ${whoHtml}
  </div>
</header>`;
}

/**
 * Full HTML document.
 * opts: { title, body, error, success, head (extra <head> html), scripts: [src|{inline}], bodyClass, wide }
 */
function page(req, opts = {}) {
  const title = opts.title ? `${opts.title} · e-Service เทศบาลนครตัวอย่าง` : 'e-Service เทศบาลนครตัวอย่าง';
  const scripts = (opts.scripts || [])
    .map((s) => (typeof s === 'string' ? `<script src="${esc(s)}" defer></script>` : `<script>${s.inline}</script>`))
    .join('\n');
  const err = opts.error || '';
  const ok = opts.success || '';
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
${opts.head || ''}
</head>
<body class="${esc(opts.bodyClass || '')}">
<a class="skip-link" href="#main">ข้ามไปเนื้อหาหลัก</a>
${header(req)}
<main id="main" class="container${opts.wide ? ' wide' : ''}" tabindex="-1">
<div data-testid="action-error" role="alert" class="msg msg-error"${err ? '' : ' hidden'}>${esc(err)}</div>
<div data-testid="action-success" role="status" class="msg msg-success"${ok ? '' : ' hidden'}>${esc(ok)}</div>
${opts.body || ''}
</main>
<footer class="app-footer"><div class="container">เทศบาลนครตัวอย่าง (หน่วยงานสมมติ) · ThaiD / PromptPay / ลายเซ็นดิจิทัล เป็นตัวจำลอง</div></footer>
${scripts}
</body>
</html>`;
}

function render(req, res, opts = {}) {
  res.status(opts.status || 200).type('html').send(page(req, opts));
}

function sendForbidden(req, res) {
  if (isApi(req)) return apiError(res, 403, 'FORBIDDEN');
  return render(req, res, {
    status: 403,
    title: 'ไม่มีสิทธิ์',
    body: `<h1>ไม่มีสิทธิ์</h1><p data-testid="forbidden-msg" class="big-msg">${esc(ERRORS.FORBIDDEN_PAGE)}</p><p><a href="${esc(landingFor(req.user))}">กลับหน้าหลัก</a></p>`,
  });
}

function sendNotFound(req, res, message) {
  const msg = message || ERRORS.NOT_FOUND;
  if (isApi(req)) return apiError(res, 404, 'NOT_FOUND', msg);
  return render(req, res, {
    status: 404,
    title: msg,
    body: `<h1>${esc(msg)}</h1><p data-testid="not-found-msg" class="big-msg">${esc(msg)}</p><p><a href="${esc(landingFor(req.user))}">กลับหน้าหลัก</a></p>`,
  });
}

function sendUnauthenticated(req, res) {
  if (isApi(req)) return apiError(res, 401, 'UNAUTHENTICATED');
  if (req.pendingUser) return res.redirect(302, '/register');
  return res.redirect(302, '/login');
}

/**
 * RBAC middleware. requireRole() = any logged-in user. requireRole('officer','head') or requireRole(['officer','head']).
 * Not logged in → page: 302 /login (pending registration → /register) · API: 401 UNAUTHENTICATED
 * Wrong role   → page: 403 forbidden-msg · API: 403 FORBIDDEN
 */
function requireRole(...roles) {
  const allowed = roles.flat().filter(Boolean);
  return function requireRoleMw(req, res, next) {
    if (!req.user) return sendUnauthenticated(req, res);
    if (allowed.length && !allowed.includes(req.user.role)) return sendForbidden(req, res);
    next();
  };
}

const requireLogin = requireRole();

/** wrap async route handlers so rejections reach the error handler */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  ROLES,
  LANDING,
  ERRORS,
  NAV,
  isApi,
  landingFor,
  apiError,
  bellCount,
  header,
  page,
  render,
  sendForbidden,
  sendNotFound,
  sendUnauthenticated,
  requireRole,
  requireLogin,
  ah,
};
