'use strict';
/**
 * B07 · ฝั่งเจ้าหน้าที่ / หัวหน้าฝ่าย: คิวงาน · รับเรื่อง · ตีกลับ · ส่งต่อ · อนุมัติ/ไม่อนุมัติ · ปิดบังเลขบัตร · เปิดดูไฟล์แนบ
 *
 * CONTRACT §1 (/officer/queue, /officer/cases/:caseNo, /head/approvals)
 * CONTRACT §2.6 · §2.7 · §2.8 · §4 · §5 · §6.2 (/files) · §6.3 · §6.7
 * DECISIONS §1 · §3 · §5 · §9 · §10 · §11 · §13 · §18
 *
 * BUG_MODE owned here (BUGS.md):
 *   B07 — Officer can approve SV-02 directly via POST /api/cases/:caseNo/approve without head (UI button still hidden)
 *   B08 — POST /api/officer/cases/:caseNo/claim skips the already-claimed check (2nd claimer gets 200 and overwrites owner)
 *   B09 — GET /api/officer/queue includes full "idNo" in JSON items (UI screen still shows masked ID)
 *   B11 — POST /api/officer/cases/:caseNo/unmask does NOT write an UNMASK row to the audit table
 *   B12 — Officer can return a case a 3rd time (return-btn still rendered at returnCount === 2 and API allows 3rd return)
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const cryptoLib = require('../lib/crypto');
const rules = require('../lib/rules');
const { writeAudit } = require('../lib/audit');

const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED'];

/** Check if a later module in Express app._router.stack also registered the same method + path */
function hasDownstreamRoute(app, method, routePath, currentRoute) {
  const stack = app && app._router && app._router.stack;
  if (!Array.isArray(stack)) return false;
  let seenCurrent = false;
  for (const layer of stack) {
    if (!layer || !layer.route) continue;
    if (layer.route === currentRoute) {
      seenCurrent = true;
      continue;
    }
    if (seenCurrent && layer.route.path === routePath && layer.route.methods && layer.route.methods[method]) {
      return true;
    }
  }
  return false;
}

module.exports = {
  order: 20,
  register(app, ctx) {
    const { db, clock, layout: L, format, bugmode } = ctx;
    const { esc } = format;

    // ------------------------------------------------------------------ helpers
    function getHolidays() {
      return rules.readHolidays(db);
    }

    function getCaseWithUser(caseNo) {
      if (!caseNo || typeof caseNo !== 'string') return null;
      return db
        .prepare(
          `SELECT c.*,
                  u.name AS applicant_name,
                  u.id_enc AS applicant_id_enc,
                  u.id_masked AS applicant_id_masked,
                  s.name AS service_name,
                  s.validity AS service_validity,
                  d.doc_no AS issued_doc_no,
                  d.verify_code AS issued_verify_code
             FROM cases c
             JOIN users u ON u.id = c.citizen_id
             LEFT JOIN services s ON s.id = c.service_id
             LEFT JOIN documents d ON d.case_no = c.case_no
            WHERE c.case_no = ?`
        )
        .get(caseNo.trim());
    }

    function getOfficerWorkload(username) {
      if (!username) return 0;
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner = ?")
        .get(username);
      return row ? Number(row.n) : 0;
    }

    /**
     * FR-29 / BR-29: Can this user access attachment files of `caseRow`?
     *   - head: all cases
     *   - officer (registry): all cases (every service starts at registry)
     *   - officer (works): SV-03 cases currently at works or having passed works (step >= 2)
     *   - citizen: own cases only (others -> 404)
     *   - executive / auditor / admin: false (403)
     */
    function checkFileAccess(user, caseRow) {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (['executive', 'auditor', 'admin'].includes(user.role)) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      if (!caseRow) {
        return { ok: false, status: 404, code: 'NOT_FOUND' };
      }
      if (user.role === 'citizen') {
        if (caseRow.citizen_id !== user.id) {
          return { ok: false, status: 404, code: 'NOT_FOUND' };
        }
        return { ok: true };
      }
      if (user.role === 'head') {
        return { ok: true };
      }
      if (user.role === 'officer') {
        if (user.dept === 'registry') {
          return { ok: true };
        }
        if (user.dept === 'works') {
          const passedWorks =
            caseRow.service_id === 'SV-03' &&
            (caseRow.stage === 'works' ||
              (caseRow.step !== null && Number(caseRow.step) >= 2) ||
              ['PENDING_APPROVAL', 'APPROVED', 'COMPLETED'].includes(caseRow.status));
          if (passedWorks) return { ok: true };
        }
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      return { ok: false, status: 403, code: 'FORBIDDEN' };
    }

    function listCaseFiles(caseNo) {
      return db
        .prepare('SELECT id, name, doc_key, size, mime FROM files WHERE case_no = ? ORDER BY id ASC')
        .all(caseNo);
    }

    function listCaseEvents(caseNo) {
      return db
        .prepare('SELECT id, case_no, at, actor, actor_role, event, from_status, to_status, detail FROM case_events WHERE case_no = ? ORDER BY at ASC, id ASC')
        .all(caseNo);
    }

    /**
     * Build queue rows for `user` (`officer` or `head`) and optional `filter` ('all' | 'unclaimed' | 'mine').
     */
    function queryQueueRows(user, filter = 'all') {
      const holidays = getHolidays();
      const now = clock.nowIso();

      let rawRows;
      if (user.role === 'head') {
        rawRows = db
          .prepare(
            `SELECT c.*, u.name AS applicant_name, u.id_masked AS applicant_id_masked, u.id_enc AS applicant_id_enc
               FROM cases c
               JOIN users u ON u.id = c.citizen_id
              WHERE c.status IN ('SUBMITTED', 'IN_REVIEW', 'APPROVED')
                AND c.stage IN ('registry', 'works', 'issue')`
          )
          .all();
      } else {
        const dept = user.dept || 'registry';
        if (dept === 'registry') {
          rawRows = db
            .prepare(
              `SELECT c.*, u.name AS applicant_name, u.id_masked AS applicant_id_masked, u.id_enc AS applicant_id_enc
                 FROM cases c
                 JOIN users u ON u.id = c.citizen_id
                WHERE c.status IN ('SUBMITTED', 'IN_REVIEW', 'APPROVED')
                  AND (c.stage = 'registry' OR (c.status = 'APPROVED' AND c.stage = 'issue'))`
            )
            .all();
        } else {
          rawRows = db
            .prepare(
              `SELECT c.*, u.name AS applicant_name, u.id_masked AS applicant_id_masked, u.id_enc AS applicant_id_enc
                 FROM cases c
                 JOIN users u ON u.id = c.citizen_id
                WHERE c.status IN ('SUBMITTED', 'IN_REVIEW', 'APPROVED')
                  AND c.stage = ?`
            )
            .all(dept);
        }
      }

      rawRows.sort(rules.compareQueue);

      const normFilter = ['all', 'unclaimed', 'mine'].includes(filter) ? filter : 'all';
      const filtered = rawRows.filter((c) => {
        if (normFilter === 'unclaimed') {
          return (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW') && !c.owner;
        }
        if (normFilter === 'mine') {
          return c.status === 'IN_REVIEW' && c.owner === user.username;
        }
        return true;
      });

      return filtered.map((c) => {
        const level = rules.slaLevel({ status: c.status, dueAt: c.due_at }, now, holidays);
        const ownerVal = c.status === 'APPROVED' ? null : c.owner || null;
        const canClaimRow =
          user.role === 'officer' &&
          (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW') &&
          !c.owner &&
          c.stage === user.dept;
        return {
          caseNo: c.case_no,
          serviceId: c.service_id,
          applicantName: c.applicant_name,
          idMasked: c.applicant_id_masked || format.maskIdNo(cryptoLib.decrypt(c.applicant_id_enc)),
          idEnc: c.applicant_id_enc,
          status: c.status,
          step: c.service_id === 'SV-03' ? c.step : null,
          stage: c.stage,
          owner: ownerVal,
          dueAt: c.due_at,
          slaLevel: level,
          canClaim: canClaimRow,
        };
      });
    }

    // ------------------------------------------------------------------ core business actions
    /**
     * Claim a case (CONTRACT §6.3 · BR-17 · BR-18 · BUG B08).
     * Order of checks: permission (403) -> state (409) -> ALREADY_CLAIMED (409) -> WORKLOAD_LIMIT (409).
     */
    const claimCaseTx = db.transaction((caseNo, user) => {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (user.role !== 'officer') return { ok: false, status: 403, code: 'FORBIDDEN' };

      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
      if (!c) return { ok: false, status: 404, code: 'NOT_FOUND' };

      // Department scope check
      if ((c.stage === 'registry' || c.stage === 'works') && c.stage !== user.dept) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }

      // State check (must be SUBMITTED or IN_REVIEW)
      if (c.status !== 'SUBMITTED' && c.status !== 'IN_REVIEW') {
        return { ok: false, status: 409, code: 'INVALID_STATE' };
      }

      if (c.stage !== user.dept) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }

      // ALREADY_CLAIMED check (skipped when BUG B08 is active)
      if (!bugmode.isBug('B08') && c.owner) {
        return { ok: false, status: 409, code: 'ALREADY_CLAIMED' };
      }

      // WORKLOAD_LIMIT check (IN_REVIEW held by this officer < 10)
      const currentWorkload = getOfficerWorkload(user.username);
      if (!rules.canClaim(currentWorkload)) {
        return { ok: false, status: 409, code: 'WORKLOAD_LIMIT' };
      }

      const now = clock.nowIso();
      const fromStatus = c.status;
      const toStatus = 'IN_REVIEW';
      const issuer = user.dept === 'registry' && !c.issuer ? user.username : c.issuer;

      db.prepare(
        `UPDATE cases
            SET status = 'IN_REVIEW',
                owner = ?,
                issuer = ?,
                updated_at = ?
          WHERE case_no = ?`
      ).run(user.username, issuer, now, c.case_no);

      db.prepare(
        `INSERT INTO case_events(case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (?, ?, ?, 'officer', 'CLAIM', ?, 'IN_REVIEW', '')`
      ).run(c.case_no, now, user.username, fromStatus);

      writeAudit({
        username: user.username,
        role: user.role,
        event: 'CLAIM',
        caseNo: c.case_no,
        fromStatus,
        toStatus,
        detail: '',
      });

      return { ok: true, owner: user.username };
    });

    /**
     * Return a case for fix (CONTRACT §6.3 · BR-19 · BUG B12).
     */
    const returnCaseTx = db.transaction((caseNo, user, rawReason) => {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (user.role !== 'officer') return { ok: false, status: 403, code: 'FORBIDDEN' };

      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
      if (!c) return { ok: false, status: 404, code: 'NOT_FOUND' };

      if (c.owner && c.owner !== user.username) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      if (c.stage && (c.stage === 'registry' || c.stage === 'works') && c.stage !== user.dept) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      if (c.status !== 'IN_REVIEW') {
        return { ok: false, status: 409, code: 'INVALID_STATE' };
      }
      if (c.owner !== user.username) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }

      // Return limit <= 2 (overridden when BUG B12 is active)
      const allowReturn = bugmode.isBug('B12') ? true : rules.canReturn(c.return_count);
      if (!allowReturn) {
        return { ok: false, status: 409, code: 'RETURN_LIMIT' };
      }

      const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
      if (!rules.isReasonValid(reason)) {
        return { ok: false, status: 400, code: 'REASON_TOO_SHORT' };
      }

      const now = clock.nowIso();
      const newCount = (Number(c.return_count) || 0) + 1;
      const deadline = rules.fixDeadline(now);

      db.prepare(
        `UPDATE cases
            SET status = 'NEED_FIX',
                return_count = ?,
                returned_at = ?,
                return_reason = ?,
                fix_deadline = ?,
                updated_at = ?
          WHERE case_no = ?`
      ).run(newCount, now, reason, deadline, now, c.case_no);

      db.prepare(
        `INSERT INTO case_returns(case_no, n, returned_at, returned_by, reason, resubmitted_at, paused_days, due_before, due_after)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`
      ).run(c.case_no, newCount, now, user.username, reason, c.due_at);

      db.prepare(
        `INSERT INTO case_events(case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (?, ?, ?, 'officer', 'RETURN', 'IN_REVIEW', 'NEED_FIX', ?)`
      ).run(c.case_no, now, user.username, reason);

      writeAudit({
        username: user.username,
        role: user.role,
        event: 'RETURN',
        caseNo: c.case_no,
        fromStatus: 'IN_REVIEW',
        toStatus: 'NEED_FIX',
        detail: reason,
      });

      return { ok: true, status: 'NEED_FIX', returnCount: newCount };
    });

    /**
     * Forward a case automatically along the service route (CONTRACT §6.3 · BR-21).
     *   SV-02 (registry) -> PENDING_APPROVAL (stage='head')
     *   SV-03 (registry, step 1) -> IN_REVIEW (stage='works', step=2, owner=NULL)
     *   SV-03 (works, step 2) -> PENDING_APPROVAL (stage='head', step=3, owner=NULL)
     */
    const forwardCaseTx = db.transaction((caseNo, user, rawNote) => {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (user.role !== 'officer') return { ok: false, status: 403, code: 'FORBIDDEN' };

      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
      if (!c) return { ok: false, status: 404, code: 'NOT_FOUND' };

      if (c.owner && c.owner !== user.username) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      if (c.stage && (c.stage === 'registry' || c.stage === 'works') && c.stage !== user.dept) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      if (c.status !== 'IN_REVIEW') {
        return { ok: false, status: 409, code: 'INVALID_STATE' };
      }
      if (c.owner !== user.username) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      if (c.service_id === 'SV-01') {
        return { ok: false, status: 409, code: 'INVALID_STATE' };
      }

      const note = typeof rawNote === 'string' ? rawNote.trim() : '';
      const now = clock.nowIso();
      let newStatus;
      let newStage;
      let newStep = c.step;
      let resultPayload;

      if (c.service_id === 'SV-02') {
        newStatus = 'PENDING_APPROVAL';
        newStage = 'head';
        newStep = null;
        resultPayload = { status: 'PENDING_APPROVAL' };
      } else if (c.service_id === 'SV-03') {
        if (c.stage === 'registry' || Number(c.step) === 1) {
          newStatus = 'IN_REVIEW';
          newStage = 'works';
          newStep = 2;
          resultPayload = { status: 'IN_REVIEW', step: 2 };
        } else if (c.stage === 'works' || Number(c.step) === 2) {
          newStatus = 'PENDING_APPROVAL';
          newStage = 'head';
          newStep = 3;
          resultPayload = { status: 'PENDING_APPROVAL', step: 3 };
        } else {
          return { ok: false, status: 409, code: 'INVALID_STATE' };
        }
      } else {
        return { ok: false, status: 409, code: 'INVALID_STATE' };
      }

      db.prepare(
        `UPDATE cases
            SET status = ?,
                stage = ?,
                step = ?,
                owner = NULL,
                updated_at = ?
          WHERE case_no = ?`
      ).run(newStatus, newStage, newStep, now, c.case_no);

      db.prepare(
        `INSERT INTO case_events(case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (?, ?, ?, 'officer', 'FORWARD', 'IN_REVIEW', ?, ?)`
      ).run(c.case_no, now, user.username, newStatus, note || (newStage === 'works' ? 'ส่งต่อฝ่ายโยธา' : 'ส่งต่อหัวหน้าฝ่าย'));

      writeAudit({
        username: user.username,
        role: user.role,
        event: 'FORWARD',
        caseNo: c.case_no,
        fromStatus: 'IN_REVIEW',
        toStatus: newStatus,
        detail: note,
      });

      return { ok: true, ...resultPayload };
    });

    /**
     * Approve a case (CONTRACT §6.3 · BR-21 · BUG B07).
     *   SV-01: holding officer at IN_REVIEW
     *   SV-02/SV-03: head at PENDING_APPROVAL (BUG B07 allows officer to approve SV-02 directly)
     */
    const approveCaseTx = db.transaction((caseNo, user) => {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (user.role !== 'officer' && user.role !== 'head') {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }

      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
      if (!c) return { ok: false, status: 404, code: 'NOT_FOUND' };

      if (c.service_id === 'SV-01') {
        if (user.role !== 'officer') return { ok: false, status: 403, code: 'FORBIDDEN' };
        if (c.owner !== user.username) return { ok: false, status: 403, code: 'FORBIDDEN' };
        if (c.status !== 'IN_REVIEW') return { ok: false, status: 409, code: 'INVALID_STATE' };
      } else {
        // SV-02 or SV-03
        if (user.role === 'officer') {
          if (bugmode.isBug('B07') && c.service_id === 'SV-02' && (c.status === 'IN_REVIEW' || c.status === 'PENDING_APPROVAL')) {
            // BUG B07: officer approves SV-02 without head
          } else {
            return { ok: false, status: 403, code: 'FORBIDDEN' };
          }
        } else if (user.role === 'head') {
          if (c.status !== 'PENDING_APPROVAL') {
            return { ok: false, status: 409, code: 'INVALID_STATE' };
          }
        }
      }

      const now = clock.nowIso();
      const fromStatus = c.status;
      const issuer = c.issuer || (user.role === 'officer' ? user.username : null);

      db.prepare(
        `UPDATE cases
            SET status = 'APPROVED',
                stage = 'registry',
                owner = NULL,
                issuer = COALESCE(issuer, ?),
                approved_by = ?,
                approved_at = ?,
                updated_at = ?
          WHERE case_no = ?`
      ).run(issuer, user.username, now, now, c.case_no);

      db.prepare(
        `INSERT INTO case_events(case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (?, ?, ?, ?, 'APPROVE', ?, 'APPROVED', '')`
      ).run(c.case_no, now, user.username, user.role, fromStatus);

      writeAudit({
        username: user.username,
        role: user.role,
        event: 'APPROVE',
        caseNo: c.case_no,
        fromStatus,
        toStatus: 'APPROVED',
        detail: '',
      });

      return { ok: true, status: 'APPROVED' };
    });

    /**
     * Reject a case (CONTRACT §6.3 · BR-19 · BR-21).
     */
    const rejectCaseTx = db.transaction((caseNo, user, rawReason) => {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (user.role !== 'officer' && user.role !== 'head') {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }

      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
      if (!c) return { ok: false, status: 404, code: 'NOT_FOUND' };

      if (c.service_id === 'SV-01') {
        if (user.role !== 'officer') return { ok: false, status: 403, code: 'FORBIDDEN' };
        if (c.owner !== user.username) return { ok: false, status: 403, code: 'FORBIDDEN' };
        if (c.status !== 'IN_REVIEW') return { ok: false, status: 409, code: 'INVALID_STATE' };
      } else {
        if (user.role !== 'head') return { ok: false, status: 403, code: 'FORBIDDEN' };
        if (c.status !== 'PENDING_APPROVAL') return { ok: false, status: 409, code: 'INVALID_STATE' };
      }

      const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
      if (!rules.isReasonValid(reason)) {
        return { ok: false, status: 400, code: 'REASON_TOO_SHORT' };
      }

      const now = clock.nowIso();
      const fromStatus = c.status;

      db.prepare(
        `UPDATE cases
            SET status = 'REJECTED',
                stage = 'closed',
                owner = NULL,
                closed_at = ?,
                reject_reason = ?,
                updated_at = ?
          WHERE case_no = ?`
      ).run(now, reason, now, c.case_no);

      db.prepare(
        `INSERT INTO case_events(case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (?, ?, ?, ?, 'REJECT', ?, 'REJECTED', ?)`
      ).run(c.case_no, now, user.username, user.role, fromStatus, reason);

      writeAudit({
        username: user.username,
        role: user.role,
        event: 'REJECT',
        caseNo: c.case_no,
        fromStatus,
        toStatus: 'REJECTED',
        detail: reason,
      });

      return { ok: true, status: 'REJECTED', closedAt: now };
    });

    /**
     * Unmask national ID (CONTRACT §6.3 · BR-24 · BUG B11).
     */
    const unmaskCaseTx = db.transaction((caseNo, user, rawReason) => {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (user.role !== 'officer' && user.role !== 'head') {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }

      const c = getCaseWithUser(caseNo);
      if (!c) return { ok: false, status: 404, code: 'NOT_FOUND' };

      const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
      if (!reason) {
        return { ok: false, status: 400, code: 'REASON_REQUIRED' };
      }

      const idNo = cryptoLib.decrypt(c.applicant_id_enc);

      if (!bugmode.isBug('B11')) {
        writeAudit({
          username: user.username,
          role: user.role,
          event: 'UNMASK',
          caseNo: c.case_no,
          fromStatus: null,
          toStatus: null,
          detail: reason,
        });
      }

      return { ok: true, idNo };
    });

    /**
     * Fallback document issuance if documents.js (B08) has not registered POST /api/officer/cases/:caseNo/issue.
     */
    function generateVerifyCode() {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let attempt = 0; attempt < 100; attempt++) {
        const bytes = nodeCrypto.randomBytes(8);
        let code = '';
        for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
        const exists = db.prepare('SELECT 1 FROM documents WHERE verify_code = ?').get(code);
        if (!exists) return code;
      }
      return nodeCrypto.randomBytes(4).toString('hex').toUpperCase();
    }

    const issueCaseFallbackTx = db.transaction((caseNo, user) => {
      if (!user) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
      if (user.role !== 'officer') return { ok: false, status: 403, code: 'FORBIDDEN' };

      const c = getCaseWithUser(caseNo);
      if (!c) return { ok: false, status: 404, code: 'NOT_FOUND' };

      if (c.issuer !== user.username) {
        return { ok: false, status: 403, code: 'FORBIDDEN' };
      }
      if (c.status !== 'APPROVED') {
        return { ok: false, status: 409, code: 'INVALID_STATE' };
      }

      const now = clock.nowIso();
      const yearBE = rules.beYearOf(now);
      const maxRow = db.prepare('SELECT MAX(seq) AS m FROM documents WHERE year_be = ?').get(yearBE);
      const seq = db.nextSeq(rules.seqKey('doc', now), maxRow && maxRow.m ? maxRow.m : 0);
      const docNo = rules.formatDocNo(yearBE, seq);
      const verifyCode = generateVerifyCode();
      const validUntil = rules.docValidUntil(now, c.service_validity || c.service_id);

      const signerUsername = c.approved_by || user.username;
      const signerRow = db.prepare('SELECT name FROM users WHERE username = ?').get(signerUsername);
      const signerName = signerRow ? signerRow.name : user.name;

      const docRow = {
        doc_no: docNo,
        year_be: yearBE,
        seq,
        case_no: c.case_no,
        verify_code: verifyCode,
        applicant: c.applicant_name,
        service_id: c.service_id,
        issued_at: now,
        valid_until: validUntil,
        signer: signerName,
        signer_username: signerUsername,
        issued_by: user.username,
      };
      docRow.signature = cryptoLib.signDocument(docRow);

      db.prepare(
        `INSERT INTO documents (
           doc_no, year_be, seq, case_no, verify_code, applicant, service_id,
           issued_at, valid_until, signer, signer_username, issued_by, signature
         ) VALUES (
           @doc_no, @year_be, @seq, @case_no, @verify_code, @applicant, @service_id,
           @issued_at, @valid_until, @signer, @signer_username, @issued_by, @signature
         )`
      ).run(docRow);

      db.prepare(
        `UPDATE cases
            SET status = 'COMPLETED',
                stage = 'closed',
                owner = NULL,
                closed_at = ?,
                doc_no = ?,
                updated_at = ?
          WHERE case_no = ?`
      ).run(now, docNo, now, c.case_no);

      db.prepare(
        `INSERT INTO case_events(case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (?, ?, ?, 'officer', 'ISSUE', 'APPROVED', 'COMPLETED', ?)`
      ).run(c.case_no, now, user.username, docNo);

      writeAudit({
        username: user.username,
        role: user.role,
        event: 'ISSUE',
        caseNo: c.case_no,
        fromStatus: 'APPROVED',
        toStatus: 'COMPLETED',
        detail: docNo,
      });

      return { ok: true, docNo, verifyCode, status: 'COMPLETED' };
    });

    // ------------------------------------------------------------------ API endpoints
    // GET /api/officer/queue?filter=all|unclaimed|mine
    app.get('/api/officer/queue', L.requireRole('officer', 'head'), (req, res) => {
      const filter = String(req.query.filter || 'all');
      const rows = queryQueueRows(req.user, filter);
      const includeFullId = bugmode.isBug('B09');
      const items = rows.map((r) => {
        const item = {
          caseNo: r.caseNo,
          serviceId: r.serviceId,
          applicantName: r.applicantName,
          idMasked: r.idMasked,
          status: r.status,
          step: r.step,
          owner: r.owner,
          dueAt: r.dueAt,
          slaLevel: r.slaLevel,
        };
        if (includeFullId) {
          item.idNo = cryptoLib.decrypt(r.idEnc);
        }
        return item;
      });
      return res.status(200).json({ items });
    });

    // POST /api/officer/cases/:caseNo/claim
    app.post('/api/officer/cases/:caseNo/claim', (req, res) => {
      const r = claimCaseTx(req.params.caseNo, req.user);
      if (!r.ok) return L.apiError(res, r.status, r.code);
      return res.status(200).json({ owner: r.owner });
    });

    // POST /api/officer/cases/:caseNo/return
    app.post('/api/officer/cases/:caseNo/return', (req, res) => {
      const r = returnCaseTx(req.params.caseNo, req.user, req.body && req.body.reason);
      if (!r.ok) return L.apiError(res, r.status, r.code);
      return res.status(200).json({ status: r.status, returnCount: r.returnCount });
    });

    // POST /api/officer/cases/:caseNo/forward
    app.post('/api/officer/cases/:caseNo/forward', (req, res) => {
      const r = forwardCaseTx(req.params.caseNo, req.user, req.body && req.body.note);
      if (!r.ok) return L.apiError(res, r.status, r.code);
      const out = { status: r.status };
      if (r.step !== undefined) out.step = r.step;
      return res.status(200).json(out);
    });

    // POST /api/cases/:caseNo/approve
    app.post('/api/cases/:caseNo/approve', (req, res) => {
      const r = approveCaseTx(req.params.caseNo, req.user);
      if (!r.ok) return L.apiError(res, r.status, r.code);
      return res.status(200).json({ status: r.status });
    });

    // POST /api/cases/:caseNo/reject
    app.post('/api/cases/:caseNo/reject', (req, res) => {
      const r = rejectCaseTx(req.params.caseNo, req.user, req.body && req.body.reason);
      if (!r.ok) return L.apiError(res, r.status, r.code);
      return res.status(200).json({ status: r.status, closedAt: r.closedAt });
    });

    // POST /api/officer/cases/:caseNo/unmask
    app.post('/api/officer/cases/:caseNo/unmask', (req, res) => {
      const r = unmaskCaseTx(req.params.caseNo, req.user, req.body && req.body.reason);
      if (!r.ok) return L.apiError(res, r.status, r.code);
      return res.status(200).json({ idNo: r.idNo });
    });

    // POST /api/officer/cases/:caseNo/issue (delegates to B08 documents.js if registered, else fallback)
    app.post('/api/officer/cases/:caseNo/issue', (req, res, next) => {
      if (hasDownstreamRoute(app, 'post', '/api/officer/cases/:caseNo/issue', req.route)) {
        return next('route');
      }
      const r = issueCaseFallbackTx(req.params.caseNo, req.user);
      if (!r.ok) return L.apiError(res, r.status, r.code);
      return res.status(200).json({ docNo: r.docNo, verifyCode: r.verifyCode, status: r.status });
    });

    // GET /api/cases/:caseNo (CONTRACT §6.2 & §6.7)
    app.get('/api/cases/:caseNo', (req, res, next) => {
      if (!req.user) return L.apiError(res, 401, 'UNAUTHENTICATED');
      if (['executive', 'auditor', 'admin'].includes(req.user.role)) {
        return L.apiError(res, 403, 'FORBIDDEN');
      }
      // If citizen and citizen.js registered a downstream GET /api/cases/:caseNo, let citizen.js handle or handle directly
      if (req.user.role === 'citizen' && hasDownstreamRoute(app, 'get', '/api/cases/:caseNo', req.route)) {
        return next('route');
      }
      const c = getCaseWithUser(req.params.caseNo);
      if (!c) return L.apiError(res, 404, 'NOT_FOUND');

      if (req.user.role === 'citizen') {
        if (c.citizen_id !== req.user.id && !bugmode.isBug('B06')) {
          return L.apiError(res, 404, 'NOT_FOUND');
        }
      } else if (req.user.role !== 'officer' && req.user.role !== 'head') {
        return L.apiError(res, 403, 'FORBIDDEN');
      }

      const holidays = getHolidays();
      const now = clock.nowIso();
      const level = rules.slaLevel({ status: c.status, dueAt: c.due_at }, now, holidays);
      const docNo = c.issued_doc_no || c.doc_no || null;
      const verifyCode = c.issued_verify_code || null;

      const payload = {
        caseNo: c.case_no,
        serviceId: c.service_id,
        status: c.status,
        step: c.service_id === 'SV-03' ? c.step : null,
        fee: c.fee,
        paidAt: c.paid_at,
        dueAt: c.due_at,
        slaLevel: level,
        owner: c.owner || null,
        returnCount: Number(c.return_count) || 0,
        closedAt: c.closed_at || null,
        applicantName: c.applicant_name,
      };

      if (req.user.role === 'citizen') {
        payload.idNo = cryptoLib.decrypt(c.applicant_id_enc);
      } else {
        payload.idMasked = c.applicant_id_masked || format.maskIdNo(cryptoLib.decrypt(c.applicant_id_enc));
      }

      payload.fixDeadline = c.status === 'NEED_FIX' ? c.fix_deadline : null;
      payload.docNo = docNo;
      payload.verifyCode = verifyCode;

      return res.status(200).json(payload);
    });

    // GET /api/cases/:caseNo/files (FR-29 · BR-29 · CONTRACT §6.2)
    app.get('/api/cases/:caseNo/files', (req, res) => {
      if (!req.user) return L.apiError(res, 401, 'UNAUTHENTICATED');
      if (['executive', 'auditor', 'admin'].includes(req.user.role)) {
        return L.apiError(res, 403, 'FORBIDDEN');
      }
      const c = getCaseWithUser(req.params.caseNo);
      const access = checkFileAccess(req.user, c);
      if (!access.ok) return L.apiError(res, access.status, access.code);

      const items = listCaseFiles(c.case_no).map((f) => ({
        fileId: f.id,
        name: f.name,
        docKey: f.doc_key,
        size: f.size,
      }));
      return res.status(200).json({ items });
    });

    // GET /api/files/:fileId (FR-29 · BR-29 · CONTRACT §6.2)
    app.get('/api/files/:fileId', (req, res) => {
      if (!req.user) return L.apiError(res, 401, 'UNAUTHENTICATED');
      if (['executive', 'auditor', 'admin'].includes(req.user.role)) {
        return L.apiError(res, 403, 'FORBIDDEN');
      }

      const fileRow = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.fileId);
      if (!fileRow) return L.apiError(res, 404, 'NOT_FOUND');

      if (fileRow.case_no) {
        const c = getCaseWithUser(fileRow.case_no);
        const access = checkFileAccess(req.user, c);
        if (!access.ok) return L.apiError(res, access.status, access.code);
      } else if (fileRow.draft_id) {
        const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(fileRow.draft_id);
        if (!draft) return L.apiError(res, 404, 'NOT_FOUND');
        if (req.user.role === 'citizen') {
          if (draft.citizen_id !== req.user.id) return L.apiError(res, 404, 'NOT_FOUND');
        } else {
          return L.apiError(res, 403, 'FORBIDDEN');
        }
      } else {
        return L.apiError(res, 404, 'NOT_FOUND');
      }

      let buf = fileRow.data;
      if (!buf && db.UPLOAD_DIR) {
        const diskPath = path.join(db.UPLOAD_DIR, fileRow.id);
        if (fs.existsSync(diskPath)) {
          buf = fs.readFileSync(diskPath);
        }
      }
      if (!buf) return L.apiError(res, 404, 'NOT_FOUND');

      res.set('Content-Type', fileRow.mime || 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileRow.name || fileRow.id)}"`);
      return res.status(200).send(buf);
    });

    // ------------------------------------------------------------------ HTML Pages
    const WORKFLOW_HEAD = `<style>
.wf-toolbar { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: flex-end; justify-content: space-between; margin-bottom: 16px; }
.wf-toolbar .filter-group { flex: 1 1 220px; max-width: 320px; }
.wf-toolbar .filter-group label { margin-top: 0; }
.wf-workload { font-weight: 600; background: #eef2ff; color: #1e3a8a; border: 1px solid #c7d2fe; padding: 6px 12px; border-radius: 6px; }
.wf-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.wf-box { background: #f9fafb; border: 1px solid #d1d5db; border-radius: 6px; padding: 12px; margin-top: 12px; }
.wf-box[hidden] { display: none; }
.wf-forward-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; width: 100%; margin-top: 8px; }
.wf-forward-group .fg-input { flex: 1 1 220px; }
.doc-list { list-style: none; padding: 0; margin: 0; }
.doc-list li { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 6px 0; border-bottom: 1px solid #e5e7eb; }
.doc-list li:last-child { border-bottom: none; }
</style>`;

    function renderQueueRowHtml(r) {
      const claimHtml = r.canClaim
        ? `<button type="button" data-testid="claim-btn" class="btn" data-claim-case="${esc(r.caseNo)}">รับเรื่อง</button>`
        : '';
      return `<tr data-testid="queue-row" data-case-no="${esc(r.caseNo)}" data-owner="${esc(r.owner || '')}" data-status="${esc(r.status)}" data-sla-level="${esc(r.slaLevel || '')}">
  <td data-testid="row-case-no"><a href="/officer/cases/${esc(r.caseNo)}">${esc(r.caseNo)}</a></td>
  <td data-testid="row-service">${esc(format.serviceLabel(r.serviceId))}</td>
  <td data-testid="row-applicant">${esc(r.applicantName)}</td>
  <td data-testid="row-id-masked">${esc(r.idMasked)}</td>
  <td>${format.statusBadge(r.status, 'row-status')}</td>
  <td>${format.timeTag(r.dueAt, 'row-due')}</td>
  <td>${format.levelBadge(r.slaLevel, 'row-sla-level')}</td>
  <td data-testid="row-owner">${esc(r.owner || '')}</td>
  <td>${claimHtml}</td>
</tr>`;
    }

    // GET /officer/queue (CONTRACT §2.7)
    app.get('/officer/queue', L.requireRole('officer', 'head'), (req, res) => {
      const filter = ['all', 'unclaimed', 'mine'].includes(String(req.query.filter))
        ? String(req.query.filter)
        : 'all';
      const allRows = queryQueueRows(req.user, 'all');
      const initialRows =
        filter === 'all' ? allRows : queryQueueRows(req.user, filter);
      const workload = req.user.role === 'officer' ? getOfficerWorkload(req.user.username) : null;

      // Client-side row descriptors (strictly masked ID, never full idNo!)
      const clientRows = allRows.map((r) => ({
        caseNo: r.caseNo,
        serviceId: r.serviceId,
        serviceLabel: format.serviceLabel(r.serviceId),
        applicantName: r.applicantName,
        idMasked: r.idMasked,
        status: r.status,
        statusTh: format.STATUS_TH[r.status] || r.status,
        dueIso: format.iso(r.dueAt),
        dueTh: format.thDateTime(r.dueAt),
        slaLevel: r.slaLevel || '',
        slaLevelTh: format.LEVEL_TH[r.slaLevel] || r.slaLevel || '–',
        owner: r.owner || '',
        canClaim: Boolean(r.canClaim),
      }));

      const rowsHtml = initialRows.map(renderQueueRowHtml).join('\n');
      const workloadHtml =
        workload !== null
          ? `<div class="wf-workload">งานในมือของฉัน: <span data-testid="workload-count">${esc(workload)}</span> / 10 เรื่อง</div>`
          : '';

      const body = `<h1>คิวงานเจ้าหน้าที่</h1>
<div class="wf-toolbar">
  <div class="filter-group">
    <label for="queue-filter">ตัวกรองคิวงาน</label>
    <select id="queue-filter" name="filter" data-testid="queue-filter" aria-label="ตัวกรองคิวงาน">
      <option value="all"${filter === 'all' ? ' selected' : ''}>ทั้งหมด (all)</option>
      <option value="unclaimed"${filter === 'unclaimed' ? ' selected' : ''}>ยังไม่มีผู้รับ (unclaimed)</option>
      <option value="mine"${filter === 'mine' ? ' selected' : ''}>ของฉัน (mine)</option>
    </select>
  </div>
  ${workloadHtml}
</div>

<section class="card">
  <div class="table-wrap">
    <table data-testid="queue-table">
      <thead>
        <tr>
          <th scope="col">เลขคำขอ</th>
          <th scope="col">บริการ</th>
          <th scope="col">ผู้ยื่น</th>
          <th scope="col">เลขบัตร</th>
          <th scope="col">สถานะ</th>
          <th scope="col">กำหนดเสร็จ</th>
          <th scope="col">ระดับเตือน</th>
          <th scope="col">ผู้ถือเรื่อง</th>
          <th scope="col">การดำเนินการ</th>
        </tr>
      </thead>
      <tbody id="queue-tbody">
        ${rowsHtml}
      </tbody>
    </table>
  </div>
  <p id="queue-empty-msg" data-testid="queue-empty" class="muted"${initialRows.length > 0 ? ' hidden' : ''}>ไม่มีงานในคิว</p>
</section>`;

      const queueScript = `(function(){
  var ROWS = ${JSON.stringify(clientRows)};
  var MY_USER = ${JSON.stringify(req.user.username || '')};
  var IS_OFFICER = ${JSON.stringify(req.user.role === 'officer')};
  var filterEl = document.getElementById('queue-filter');
  var tbody = document.getElementById('queue-tbody');
  var emptyEl = document.getElementById('queue-empty-msg');
  var wlEl = document.querySelector('[data-testid="workload-count"]');

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function filterRows(f) {
    return ROWS.filter(function(r) {
      if (f === 'unclaimed') return (r.status === 'SUBMITTED' || r.status === 'IN_REVIEW') && !r.owner;
      if (f === 'mine') return r.status === 'IN_REVIEW' && r.owner === MY_USER;
      return true;
    });
  }

  function rowToHtml(r) {
    var claimBtn = (IS_OFFICER && r.canClaim && !r.owner && (r.status === 'SUBMITTED' || r.status === 'IN_REVIEW'))
      ? '<button type="button" data-testid="claim-btn" class="btn" data-claim-case="' + escHtml(r.caseNo) + '">รับเรื่อง</button>'
      : '';
    return '<tr data-testid="queue-row" data-case-no="' + escHtml(r.caseNo) + '" data-owner="' + escHtml(r.owner) + '" data-status="' + escHtml(r.status) + '" data-sla-level="' + escHtml(r.slaLevel) + '">'
      + '<td data-testid="row-case-no"><a href="/officer/cases/' + escHtml(r.caseNo) + '">' + escHtml(r.caseNo) + '</a></td>'
      + '<td data-testid="row-service">' + escHtml(r.serviceLabel) + '</td>'
      + '<td data-testid="row-applicant">' + escHtml(r.applicantName) + '</td>'
      + '<td data-testid="row-id-masked">' + escHtml(r.idMasked) + '</td>'
      + '<td><span class="badge st-' + escHtml(r.status.toLowerCase()) + '" data-testid="row-status" data-status="' + escHtml(r.status) + '">' + escHtml(r.statusTh) + '</span></td>'
      + '<td><time data-testid="row-due" data-iso="' + escHtml(r.dueIso) + '" datetime="' + escHtml(r.dueIso) + '">' + escHtml(r.dueTh) + '</time></td>'
      + '<td><span class="badge lv-' + escHtml(r.slaLevel) + '" data-testid="row-sla-level" data-level="' + escHtml(r.slaLevel) + '">' + escHtml(r.slaLevelTh) + '</span></td>'
      + '<td data-testid="row-owner">' + escHtml(r.owner) + '</td>'
      + '<td>' + claimBtn + '</td>'
      + '</tr>';
  }

  function renderTable() {
    var f = filterEl ? filterEl.value : 'all';
    var list = filterRows(f);
    if (tbody) tbody.innerHTML = list.map(rowToHtml).join('');
    if (emptyEl) emptyEl.hidden = list.length > 0;
  }

  if (filterEl) {
    filterEl.addEventListener('change', function() {
      renderTable();
    });
  }

  function syncPost(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, false);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send('{}');
    var data = null;
    try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) {}
    return { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, data: data };
  }

  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-testid="claim-btn"][data-claim-case]') : null;
    if (!btn) return;
    e.preventDefault();
    var caseNo = btn.getAttribute('data-claim-case');
    if (!caseNo) return;
    try {
      var res = syncPost('/api/officer/cases/' + encodeURIComponent(caseNo) + '/claim');
      if (res.ok && res.data) {
        if (window.App) window.App.clearMessages();
        for (var i = 0; i < ROWS.length; i++) {
          if (ROWS[i].caseNo === caseNo) {
            ROWS[i].owner = res.data.owner || MY_USER;
            ROWS[i].status = 'IN_REVIEW';
            ROWS[i].statusTh = 'กำลังตรวจสอบ';
            ROWS[i].canClaim = false;
          }
        }
        if (wlEl) {
          var count = 0;
          for (var j = 0; j < ROWS.length; j++) {
            if (ROWS[j].status === 'IN_REVIEW' && ROWS[j].owner === MY_USER) count++;
          }
          wlEl.textContent = String(count);
        }
        renderTable();
      } else {
        var msg = (res.data && res.data.message) ? res.data.message : 'ไม่สามารถรับเรื่องได้';
        if (window.App) window.App.showError(msg);
      }
    } catch (err) {
      if (window.App) window.App.showError('เกิดข้อผิดพลาดในการเชื่อมต่อ');
    }
  });
})();`;

      return L.render(req, res, {
        title: 'คิวงาน',
        body,
        head: WORKFLOW_HEAD,
        scripts: [{ inline: queueScript }],
      });
    });

    // GET /head/approvals (CONTRACT §2.8)
    app.get('/head/approvals', L.requireRole('head'), (req, res) => {
      const rows = db
        .prepare(
          `SELECT c.*, u.name AS applicant_name
             FROM cases c
             JOIN users u ON u.id = c.citizen_id
            WHERE c.status = 'PENDING_APPROVAL'`
        )
        .all();
      rows.sort(rules.compareQueue);

      const trs = rows
        .map(
          (c) => `<tr data-testid="approval-row" data-case-no="${esc(c.case_no)}">
  <td data-testid="row-case-no">${esc(c.case_no)}</td>
  <td data-testid="row-service">${esc(format.serviceLabel(c.service_id))}</td>
  <td data-testid="row-applicant">${esc(c.applicant_name)}</td>
  <td>${format.timeTag(c.due_at, 'row-due')}</td>
  <td><a data-testid="approval-open" href="/officer/cases/${esc(c.case_no)}" class="btn">เปิดคำขอ</a></td>
</tr>`
        )
        .join('\n');

      const body = `<h1>รายการรออนุมัติ</h1>
<section class="card">
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th scope="col">เลขคำขอ</th>
          <th scope="col">บริการ</th>
          <th scope="col">ผู้ยื่น</th>
          <th scope="col">กำหนดเสร็จ</th>
          <th scope="col">การดำเนินการ</th>
        </tr>
      </thead>
      <tbody>
        ${trs}
      </tbody>
    </table>
  </div>
  ${rows.length === 0 ? '<p class="muted">ไม่มีรายการรออนุมัติ</p>' : ''}
</section>`;

      return L.render(req, res, { title: 'รายการรออนุมัติ', body, head: WORKFLOW_HEAD });
    });

    /**
     * Render the inner content of `/officer/cases/:caseNo` (CONTRACT §2.6).
     */
    function renderOfficerCaseInner(req, c) {
      const user = req.user;
      const holidays = getHolidays();
      const now = clock.nowIso();
      const level = rules.slaLevel({ status: c.status, dueAt: c.due_at }, now, holidays);
      const idMasked = c.applicant_id_masked || format.maskIdNo(cryptoLib.decrypt(c.applicant_id_enc));
      const docNo = c.issued_doc_no || c.doc_no || null;
      const verifyCode = c.issued_verify_code || null;

      // SV-03 step indicator (A-40: ONLY for SV-03)
      const stepNum = c.service_id === 'SV-03' ? (c.step || (c.stage === 'works' ? 2 : c.stage === 'head' ? 3 : 1)) : null;
      const stepHtml =
        c.service_id === 'SV-03' && format.STEP_TH[stepNum]
          ? `<dt>ขั้นตอน</dt><dd data-testid="case-step">${esc(format.STEP_TH[stepNum])}</dd>`
          : '';

      // Closed time (ONLY for COMPLETED or REJECTED)
      const closedHtml =
        (c.status === 'COMPLETED' || c.status === 'REJECTED') && c.closed_at
          ? `<dt>เวลาปิดงาน</dt><dd>${format.timeTag(c.closed_at, 'closed-at')}</dd>`
          : '';

      // Issued document details
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const verifyUrl = verifyCode ? `${baseUrl}/verify/${verifyCode}` : '';
      const issuedDocHtml = docNo
        ? `<dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(docNo)}</dd>
           ${verifyCode ? `<dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(verifyCode)}</dd>` : ''}
           ${verifyCode ? `<dt>QR ตรวจสอบเอกสาร</dt><dd><div data-testid="doc-qr" class="qr-box" data-url="${esc(verifyUrl)}">QR: ${esc(verifyUrl)}</div></dd>` : ''}`
        : '';

      // Attachments (FR-29 / BR-29)
      const fileAccess = checkFileAccess(user, c);
      const files = fileAccess.ok ? listCaseFiles(c.case_no) : [];
      const filesHtml =
        files.length > 0
          ? `<ul class="doc-list">${files
              .map(
                (f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.id)}">
  <span>${esc(format.DOC_LABEL[f.doc_key] || f.doc_key)}: <strong>${esc(f.name)}</strong></span>
  <a data-testid="doc-download-link" href="/api/files/${esc(f.id)}" class="btn btn-secondary">ดาวน์โหลด</a>
</li>`
              )
              .join('')}</ul>`
          : '<p class="muted">ไม่มีเอกสารแนบในขอบเขตที่เข้าถึงได้</p>';

      // Action permission flags
      const canClaimBtn =
        user.role === 'officer' &&
        (c.status === 'SUBMITTED' || c.status === 'IN_REVIEW') &&
        !c.owner &&
        c.stage === user.dept;

      const isHoldingOfficer =
        user.role === 'officer' && c.status === 'IN_REVIEW' && c.owner === user.username;

      const allowReturnCount = bugmode.isBug('B12') ? true : rules.canReturn(c.return_count);
      const canReturnBtn = isHoldingOfficer && allowReturnCount;

      const canForwardBtn =
        isHoldingOfficer && (c.service_id === 'SV-02' || c.service_id === 'SV-03');

      const canApproveOrReject =
        (isHoldingOfficer && c.service_id === 'SV-01') ||
        (user.role === 'head' &&
          (c.service_id === 'SV-02' || c.service_id === 'SV-03') &&
          c.status === 'PENDING_APPROVAL');

      const canIssueBtn =
        user.role === 'officer' && c.status === 'APPROVED' && c.issuer === user.username;

      // Timeline events
      const events = listCaseEvents(c.case_no);
      const timelineHtml = events
        .map(
          (ev) => `<li data-testid="timeline-item" data-iso="${esc(format.iso(ev.at))}">
  <strong>${esc(format.thDateTime(ev.at))}</strong> · ${esc(ev.event)}
  ${ev.from_status || ev.to_status ? `(${esc(ev.from_status || '–')} → ${esc(ev.to_status || '–')})` : ''}
  ${ev.actor ? `โดย ${esc(ev.actor)}` : ''}
  ${ev.detail ? `— ${esc(ev.detail)}` : ''}
</li>`
        )
        .join('\n');

      return `<div class="row" style="justify-content:space-between;margin-bottom:12px">
  <h1 style="margin:0">คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
  <div>${format.statusBadge(c.status, 'case-status')}</div>
</div>

<section class="card">
  <h2>ข้อมูลคำขอ</h2>
  <dl class="kv">
    <dt>บริการ</dt>
    <dd data-testid="case-service">${esc(format.serviceLabel(c.service_id, c.service_name))}</dd>
    ${stepHtml}
    <dt>ค่าธรรมเนียม</dt>
    <dd data-testid="case-fee">${esc(format.money(c.fee))}</dd>
    <dt>ชื่อผู้ยื่น</dt>
    <dd data-testid="applicant-name">${esc(c.applicant_name)}</dd>
    <dt>เลขบัตรประชาชน</dt>
    <dd>
      <span data-testid="applicant-id">${esc(idMasked)}</span>
      <span id="full-id-slot"></span>
      <button type="button" data-testid="show-full-id-btn" class="btn btn-secondary" style="margin-left:8px;padding:4px 10px">แสดงเลขเต็ม</button>
      <div id="unmask-box" class="wf-box" hidden>
        <label for="unmask-reason">เหตุผลในการขอดูเลขบัตรเต็ม</label>
        <input type="text" id="unmask-reason" name="unmaskReason" data-testid="unmask-reason" aria-label="เหตุผลในการขอดูเลขบัตรเต็ม" autocomplete="off">
        <p id="unmask-error" data-testid="unmask-error" class="field-error" role="alert" hidden>${esc(L.ERRORS.REASON_REQUIRED)}</p>
        <div style="margin-top:8px">
          <button type="button" data-testid="unmask-submit" class="btn">ยืนยัน</button>
        </div>
      </div>
    </dd>
    <dt>กำหนดเสร็จ (SLA)</dt>
    <dd>${format.timeTag(c.due_at, 'sla-due')} ${format.levelBadge(level, 'sla-level')}</dd>
    <dt>ผู้ถือเรื่อง</dt>
    <dd data-testid="case-owner">${esc(c.owner || 'ยังไม่มีผู้รับ')}</dd>
    <dt>จำนวนครั้งที่ตีกลับแล้ว</dt>
    <dd data-testid="return-count">${esc(Number(c.return_count) || 0)}</dd>
    ${closedHtml}
    ${issuedDocHtml}
  </dl>
</section>

<section class="card">
  <h2>เอกสารแนบ</h2>
  ${filesHtml}
</section>

<section class="card">
  <h2>การดำเนินการ</h2>
  <div class="wf-actions">
    ${canClaimBtn ? `<button type="button" data-testid="claim-btn" class="btn">รับเรื่อง</button>` : ''}
    ${canApproveOrReject ? `<button type="button" data-testid="approve-btn" class="btn">อนุมัติ</button>` : ''}
    ${canReturnBtn ? `<button type="button" data-testid="return-btn" class="btn btn-secondary">ตีกลับ</button>` : ''}
    ${canApproveOrReject ? `<button type="button" data-testid="reject-btn" class="btn btn-danger">ไม่อนุมัติ</button>` : ''}
    ${canIssueBtn ? `<button type="button" data-testid="issue-btn" class="btn">ออกเอกสาร</button>` : ''}
  </div>

  ${
    canForwardBtn
      ? `<div class="wf-forward-group">
    <div class="fg-input">
      <label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
      <input type="text" id="forward-note" name="forwardNote" data-testid="forward-note" aria-label="หมายเหตุส่งต่อ" autocomplete="off">
    </div>
    <div>
      <button type="button" data-testid="forward-btn" class="btn">ผ่าน/ส่งต่อ</button>
    </div>
  </div>`
      : ''
  }

  ${
    canReturnBtn
      ? `<div id="return-box" class="wf-box" hidden>
    <label for="return-reason">เหตุผลการตีกลับ (อย่างน้อย 10 ตัวอักษร)</label>
    <textarea id="return-reason" name="returnReason" data-testid="return-reason" aria-label="เหตุผลการตีกลับ"></textarea>
    <p id="return-reason-error" data-testid="return-reason-error" class="field-error" role="alert" hidden>${esc(L.ERRORS.REASON_TOO_SHORT)}</p>
    <div style="margin-top:8px">
      <button type="button" data-testid="return-submit" class="btn">ยืนยันตีกลับ</button>
    </div>
  </div>`
      : ''
  }

  ${
    canApproveOrReject
      ? `<div id="reject-box" class="wf-box" hidden>
    <label for="reject-reason">เหตุผลที่ไม่อนุมัติ (อย่างน้อย 10 ตัวอักษร)</label>
    <textarea id="reject-reason" name="rejectReason" data-testid="reject-reason" aria-label="เหตุผลที่ไม่อนุมัติ"></textarea>
    <p id="reject-reason-error" data-testid="reject-reason-error" class="field-error" role="alert" hidden>${esc(L.ERRORS.REASON_TOO_SHORT)}</p>
    <div style="margin-top:8px">
      <button type="button" data-testid="reject-submit" class="btn btn-danger">ยืนยันไม่อนุมัติ</button>
    </div>
  </div>`
      : ''
  }
</section>

<section class="card">
  <h2>ไทม์ไลน์เหตุการณ์</h2>
  <ul data-testid="case-timeline" class="timeline">
    ${timelineHtml}
  </ul>
</section>`;
    }

    // GET /officer/cases/:caseNo (CONTRACT §2.6)
    app.get('/officer/cases/:caseNo', L.requireRole('officer', 'head'), (req, res) => {
      const c = getCaseWithUser(req.params.caseNo);
      if (!c) return L.sendNotFound(req, res);

      const inner = renderOfficerCaseInner(req, c);
      if (req.query.partial === '1') {
        return res.status(200).type('html').send(inner);
      }

      const caseScript = `(function(){
  var CASE_NO = ${JSON.stringify(c.case_no)};
  var root = document.getElementById('case-detail-root');

  function formatId13(id) {
    var s = String(id || '').replace(/\\D/g, '');
    if (s.length !== 13) return String(id || '');
    return s[0] + '-' + s.slice(1, 5) + '-' + s.slice(5, 10) + '-' + s.slice(10, 12) + '-' + s[12];
  }

  function syncApi(method, url, bodyObj) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    xhr.setRequestHeader('Accept', 'application/json');
    if (bodyObj !== undefined) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(bodyObj));
    } else {
      xhr.send();
    }
    var data = null;
    try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) {}
    return { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, data: data };
  }

  function refreshPartial() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/officer/cases/' + encodeURIComponent(CASE_NO) + '?partial=1', false);
    xhr.send();
    if (xhr.status === 200 && root) {
      root.innerHTML = xhr.responseText;
    }
  }

  document.addEventListener('click', function(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-testid]') : null;
    if (!t) return;
    var tid = t.getAttribute('data-testid');

    if (tid === 'show-full-id-btn') {
      e.preventDefault();
      var ubox = document.getElementById('unmask-box');
      if (ubox) {
        ubox.hidden = false;
        var uinp = document.getElementById('unmask-reason');
        if (uinp) uinp.focus();
      }
      return;
    }

    if (tid === 'unmask-submit') {
      e.preventDefault();
      var uinp2 = document.getElementById('unmask-reason');
      var uerr = document.getElementById('unmask-error');
      var slot = document.getElementById('full-id-slot');
      var reasonVal = uinp2 ? uinp2.value : '';
      var res = syncApi('POST', '/api/officer/cases/' + encodeURIComponent(CASE_NO) + '/unmask', { reason: reasonVal });
      if (res.ok && res.data && res.data.idNo) {
        if (uerr) uerr.hidden = true;
        if (slot) {
          slot.innerHTML = ' <strong data-testid="full-id">' + formatId13(res.data.idNo) + '</strong>';
        }
      } else {
        if (slot) slot.innerHTML = '';
        if (uerr) {
          uerr.textContent = (res.data && res.data.message) ? res.data.message : 'กรุณากรอกเหตุผล';
          uerr.hidden = false;
        }
      }
      return;
    }

    if (tid === 'return-btn') {
      e.preventDefault();
      var rbox = document.getElementById('return-box');
      if (rbox) {
        rbox.hidden = false;
        var rinp = document.getElementById('return-reason');
        if (rinp) rinp.focus();
      }
      return;
    }

    if (tid === 'return-submit') {
      e.preventDefault();
      var rinp2 = document.getElementById('return-reason');
      var rerr = document.getElementById('return-reason-error');
      var rVal = rinp2 ? rinp2.value : '';
      var rRes = syncApi('POST', '/api/officer/cases/' + encodeURIComponent(CASE_NO) + '/return', { reason: rVal });
      if (rRes.ok) {
        if (window.App) window.App.clearMessages();
        refreshPartial();
      } else if (rRes.status === 400 && rerr) {
        rerr.textContent = (rRes.data && rRes.data.message) ? rRes.data.message : 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร';
        rerr.hidden = false;
      } else if (window.App) {
        window.App.showError((rRes.data && rRes.data.message) || 'ไม่สามารถตีกลับได้');
      }
      return;
    }

    if (tid === 'reject-btn') {
      e.preventDefault();
      var jbox = document.getElementById('reject-box');
      if (jbox) {
        jbox.hidden = false;
        var jinp = document.getElementById('reject-reason');
        if (jinp) jinp.focus();
      }
      return;
    }

    if (tid === 'reject-submit') {
      e.preventDefault();
      var jinp2 = document.getElementById('reject-reason');
      var jerr = document.getElementById('reject-reason-error');
      var jVal = jinp2 ? jinp2.value : '';
      var jRes = syncApi('POST', '/api/cases/' + encodeURIComponent(CASE_NO) + '/reject', { reason: jVal });
      if (jRes.ok) {
        if (window.App) window.App.clearMessages();
        refreshPartial();
      } else if (jRes.status === 400 && jerr) {
        jerr.textContent = (jRes.data && jRes.data.message) ? jRes.data.message : 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร';
        jerr.hidden = false;
      } else if (window.App) {
        window.App.showError((jRes.data && jRes.data.message) || 'ไม่สามารถทำรายการได้');
      }
      return;
    }

    if (tid === 'claim-btn') {
      e.preventDefault();
      var cRes = syncApi('POST', '/api/officer/cases/' + encodeURIComponent(CASE_NO) + '/claim');
      if (cRes.ok) {
        if (window.App) window.App.clearMessages();
        refreshPartial();
      } else if (window.App) {
        window.App.showError((cRes.data && cRes.data.message) || 'ไม่สามารถรับเรื่องได้');
      }
      return;
    }

    if (tid === 'forward-btn') {
      e.preventDefault();
      var fnEl = document.getElementById('forward-note');
      var noteVal = fnEl ? fnEl.value : '';
      var fRes = syncApi('POST', '/api/officer/cases/' + encodeURIComponent(CASE_NO) + '/forward', { note: noteVal });
      if (fRes.ok) {
        if (window.App) window.App.clearMessages();
        refreshPartial();
      } else if (window.App) {
        window.App.showError((fRes.data && fRes.data.message) || 'ไม่สามารถส่งต่อได้');
      }
      return;
    }

    if (tid === 'approve-btn') {
      e.preventDefault();
      var aRes = syncApi('POST', '/api/cases/' + encodeURIComponent(CASE_NO) + '/approve');
      if (aRes.ok) {
        if (window.App) window.App.clearMessages();
        refreshPartial();
      } else if (window.App) {
        window.App.showError((aRes.data && aRes.data.message) || 'ไม่สามารถอนุมัติได้');
      }
      return;
    }

    if (tid === 'issue-btn') {
      e.preventDefault();
      var iRes = syncApi('POST', '/api/officer/cases/' + encodeURIComponent(CASE_NO) + '/issue');
      if (iRes.ok) {
        if (window.App) window.App.clearMessages();
        refreshPartial();
      } else if (window.App) {
        window.App.showError((iRes.data && iRes.data.message) || 'ไม่สามารถออกเอกสารได้');
      }
      return;
    }
  });
})();`;

      return L.render(req, res, {
        title: `คำขอ ${c.case_no}`,
        body: `<div id="case-detail-root">${inner}</div>`,
        head: WORKFLOW_HEAD,
        scripts: [{ inline: caseScript }],
      });
    });
  },
};
