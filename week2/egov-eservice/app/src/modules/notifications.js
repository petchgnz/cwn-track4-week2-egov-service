'use strict';
/**
 * B09 · แจ้งเตือน SLA + ยกเลิกอัตโนมัติ (ประเมินทุก request)
 *
 * CONTRACT §0 ข้อ 7 · §1 (/notifications) · §2.1 (nav-bell, bell-count) · §2.12 (noti-item, noti-empty)
 * CONTRACT §6.3 (GET /api/notifications)
 * DECISIONS §8 · §9 · §18 · REQUIREMENTS FR-11 FR-20 · BR-14 BR-15 BR-20 · A-21 A-30 A-31 A-46
 * TEST-DATA §8 (§8.1, §8.2)
 *
 * Rules:
 *   1. Executed on every HTTP request except /api/test/* (and /api/health, /static/*, /favicon.ico).
 *   2. Auto-cancels any NEED_FIX case where now − returned_at ≥ 168 hours (7 calendar days):
 *      - status → 'CANCELLED', stage → 'closed', cancel_reason → 'AUTO_FIX_EXPIRED'
 *      - cancelled_at = returned_at + 168h (fix_deadline)
 *      - case_events row inserted with at = returned_at + 168h (A-46)
 *   3. Evaluates current SLA level ('near' or 'overdue') for all active non-paused cases
 *      (SUBMITTED, IN_REVIEW, PENDING_APPROVAL, APPROVED):
 *      - Has holder (owner) → holder
 *      - Unclaimed in department queue → all active officers of that department ('registry' or 'works')
 *      - At head approval step (PENDING_APPROVAL) → head
 *      - Waiting for document issue (APPROVED) → document issuer (registry officer who claimed step 1)
 *      - Level 'overdue' ALWAYS notifies head in addition (deduplicated if head is already a recipient)
 *      - 1 notification per (username, case_no, level) — never duplicated across requests
 *      - Only current level at `now` is evaluated (no retroactive 'near' if clock jumped straight to 'overdue')
 */
const defaultDb = require('../lib/db');
const defaultClock = require('../lib/clock');
const defaultRules = require('../lib/rules');

const PAGE_STYLE = `<style>
.noti-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.noti-item {
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  background: #fff;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.noti-item[data-level="near"] {
  background: #fff4ce;
  border-color: #d97706;
  color: #6b4e00;
}
.noti-item[data-level="overdue"] {
  background: #fde8e8;
  border-color: #dc2626;
  color: #8a1111;
}
.noti-link {
  color: inherit;
  text-decoration: none;
  display: block;
  width: 100%;
}
.noti-link:hover, .noti-link:focus {
  text-decoration: underline;
  color: inherit;
}
</style>`;

/**
 * Determine which department an unclaimed SUBMITTED / IN_REVIEW case currently belongs to.
 */
function resolveCaseDept(c) {
  if (c.stage === 'works' || (c.service_id === 'SV-03' && Number(c.step) === 2)) {
    return 'works';
  }
  return 'registry';
}

/**
 * Determine recipients for a case at a given SLA alert level ('near' or 'overdue').
 * @param {object} c - cases table row
 * @param {'near'|'overdue'} level
 * @param {{ registry: string[], works: string[] }} officersByDept
 * @param {string[]} heads
 * @param {(caseNo: string) => string|null} [findFirstClaimer]
 * @returns {string[]} array of unique usernames
 */
function recipientsForCase(c, level, officersByDept, heads, findFirstClaimer) {
  if (level !== 'near' && level !== 'overdue') return [];
  const recipients = new Set();

  if (c.status === 'PENDING_APPROVAL' || c.stage === 'head') {
    for (const h of heads) recipients.add(h);
  } else if (c.status === 'APPROVED' || c.stage === 'issue') {
    let issuer = c.issuer || c.owner || (c.service_id === 'SV-01' ? c.approved_by : null);
    if (!issuer && typeof findFirstClaimer === 'function') {
      issuer = findFirstClaimer(c.case_no);
    }
    if (issuer) recipients.add(issuer);
  } else if (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW') {
    if (c.owner) {
      recipients.add(c.owner);
    } else {
      const dept = resolveCaseDept(c);
      const deptOfficers = (officersByDept && officersByDept[dept]) || [];
      for (const u of deptOfficers) recipients.add(u);
    }
  }

  if (level === 'overdue') {
    for (const h of heads) recipients.add(h);
  }

  return Array.from(recipients);
}

/**
 * Run auto-cancellation of expired NEED_FIX cases (168h window · BR-20 · A-21 · A-46)
 * and SLA notification evaluation (BR-14 · BR-15 · A-30 · A-31) atomically.
 */
function evaluate(db = defaultDb, clock = defaultClock, rules = defaultRules) {
  const tx = db.transaction(() => {
    const now = clock.now();
    const nowIso = clock.toIso(now);

    // 1. Auto-cancel NEED_FIX cases past 168 hours (A-21, A-46, BR-20)
    const needFixCases = db
      .prepare(
        `SELECT case_no, returned_at, fix_deadline
           FROM cases
          WHERE status = 'NEED_FIX'`
      )
      .all();

    if (needFixCases.length > 0) {
      const stmtCancel = db.prepare(
        `UPDATE cases
            SET status = 'CANCELLED',
                stage = 'closed',
                cancelled_at = @cancelled_at,
                cancel_reason = 'AUTO_FIX_EXPIRED',
                updated_at = @updated_at
          WHERE case_no = @case_no AND status = 'NEED_FIX'`
      );
      const stmtEvent = db.prepare(
        `INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (@case_no, @at, 'system', 'system', 'AUTO_CANCEL', 'NEED_FIX', 'CANCELLED', @detail)`
      );

      for (const c of needFixCases) {
        let expired = false;
        let deadlineIso = null;

        if (c.returned_at) {
          expired = rules.isFixWindowExpired(c.returned_at, now);
          deadlineIso = c.fix_deadline ? clock.toIso(c.fix_deadline) : rules.fixDeadline(c.returned_at);
        } else if (c.fix_deadline) {
          deadlineIso = clock.toIso(c.fix_deadline);
          expired = clock.toDate(now).getTime() >= clock.toDate(c.fix_deadline).getTime();
        }

        if (expired && deadlineIso) {
          const info = stmtCancel.run({
            case_no: c.case_no,
            cancelled_at: deadlineIso,
            updated_at: deadlineIso,
          });
          if (info.changes > 0) {
            stmtEvent.run({
              case_no: c.case_no,
              at: deadlineIso,
              detail: 'หมดเวลาแก้ไขเอกสาร 168 ชั่วโมง ระบบยกเลิกคำขออัตโนมัติ',
            });
          }
        }
      }
    }

    // 2. Evaluate SLA notifications for active cases (DECISIONS §8, §18, A-30, A-31, BR-14, BR-15)
    const activeCases = db
      .prepare(
        `SELECT case_no, service_id, status, step, stage, owner, issuer, approved_by, due_at
           FROM cases
          WHERE status IN ('SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED')
          ORDER BY due_at ASC, case_no ASC`
      )
      .all();

    if (activeCases.length === 0) return;

    const holidays = rules.readHolidays(db);
    const staffRows = db
      .prepare(
        `SELECT username, role, dept
           FROM users
          WHERE active = 1 AND role IN ('officer', 'head')
          ORDER BY id ASC`
      )
      .all();

    const officersByDept = { registry: [], works: [] };
    const heads = [];
    for (const s of staffRows) {
      if (!s.username) continue;
      if (s.role === 'officer' && s.dept && officersByDept[s.dept]) {
        officersByDept[s.dept].push(s.username);
      } else if (s.role === 'head') {
        heads.push(s.username);
      }
    }

    const stmtFirstClaim = db.prepare(
      `SELECT actor FROM case_events WHERE case_no = ? AND event = 'CLAIM' AND actor IS NOT NULL ORDER BY id ASC LIMIT 1`
    );
    const findFirstClaimer = (caseNo) => {
      const row = stmtFirstClaim.get(caseNo);
      return row ? row.actor : null;
    };

    const stmtInsertNoti = db.prepare(
      `INSERT OR IGNORE INTO notifications (username, case_no, level, text, created_at)
       VALUES (@username, @case_no, @level, @text, @created_at)`
    );

    for (const c of activeCases) {
      const level = rules.slaLevel(c, now, holidays);
      if (level !== 'near' && level !== 'overdue') continue;

      const recipients = recipientsForCase(c, level, officersByDept, heads, findFirstClaimer);
      if (recipients.length === 0) continue;

      const levelTh = level === 'near' ? 'ใกล้ครบกำหนด' : 'เกินกำหนด';
      const text = `คำขอ ${c.case_no} ${levelTh}`;

      for (const username of recipients) {
        stmtInsertNoti.run({
          username,
          case_no: c.case_no,
          level,
          text,
          created_at: nowIso,
        });
      }
    }
  });

  tx();
}

function isExcludedPath(p) {
  if (!p) return false;
  return (
    p === '/api/test' ||
    p.startsWith('/api/test/') ||
    p === '/api/health' ||
    p.startsWith('/static/') ||
    p === '/favicon.ico'
  );
}

function register(app, ctx) {
  const db = (ctx && ctx.db) || defaultDb;
  const clock = (ctx && ctx.clock) || defaultClock;
  const rules = (ctx && ctx.rules) || defaultRules;
  const L = ctx.layout;
  const { esc } = ctx.format;
  const hooks = ctx.hooks;

  const runEval = (req) => {
    if (req && req._notiEvaluated) return;
    if (req && isExcludedPath(req.path)) return;
    if (req) req._notiEvaluated = true;
    evaluate(db, clock, rules);
  };

  // Register on central request hook (runs in server.js before every route handler except /api/test/*)
  if (hooks && typeof hooks.onRequest === 'function') {
    hooks.onRequest(runEval);
  }

  // Fallback middleware in case a test mounts the module without server.js request hook pipeline
  app.use((req, res, next) => {
    try {
      runEval(req);
      next();
    } catch (e) {
      next(e);
    }
  });

  function listUserNotifications(username) {
    return db
      .prepare(
        `SELECT id, case_no, level, text, created_at
           FROM notifications
          WHERE username = ?
          ORDER BY id DESC`
      )
      .all(username)
      .map((r) => ({
        id: r.id,
        caseNo: r.case_no,
        level: r.level,
        text: r.text,
        createdAt: r.created_at,
      }));
  }

  // CONTRACT §6.3: GET /api/notifications (officer · head only)
  app.get('/api/notifications', L.requireRole('officer', 'head'), (req, res) => {
    evaluate(db, clock, rules);
    const items = listUserNotifications(req.user.username);
    return res.status(200).json({ items });
  });

  app.all('/api/notifications', (req, res) => L.apiError(res, 405, 'METHOD_NOT_ALLOWED'));

  // CONTRACT §1 & §2.12: GET /notifications (officer · head only)
  app.get('/notifications', L.requireRole('officer', 'head'), (req, res) => {
    evaluate(db, clock, rules);
    const items = listUserNotifications(req.user.username);

    let listHtml;
    if (items.length === 0) {
      listHtml = `<p data-testid="noti-empty" class="big-msg">ไม่มีแจ้งเตือน</p>`;
    } else {
      const rows = items
        .map(
          (item) =>
            `<li data-testid="noti-item" data-case-no="${esc(item.caseNo)}" data-level="${esc(item.level)}" class="noti-item"><a class="noti-link" href="/officer/cases/${esc(item.caseNo)}">${esc(item.text)}</a></li>`
        )
        .join('\n');
      listHtml = `<ul class="noti-list">\n${rows}\n</ul>`;
    }

    const body = `<h1>การแจ้งเตือน</h1>\n<section class="card">\n${listHtml}\n</section>`;
    return L.render(req, res, {
      title: 'การแจ้งเตือน',
      head: PAGE_STYLE,
      body,
    });
  });
}

module.exports = {
  order: 20,
  register,
  evaluate,
  recipientsForCase,
  resolveCaseDept,
};
