'use strict';
/**
 * Audit Trail writer (B01) — append-only `audit` table (DECISIONS §13, CONTRACT §6.8).
 *
 *   const { writeAudit } = require('../lib/audit');
 *   writeAudit({ req, event: 'CLAIM', caseNo: 'EG-2569-000028', fromStatus: 'SUBMITTED', toStatus: 'IN_REVIEW' });
 *   writeAudit({ username: 'off.reg1', role: 'officer', event: 'STAFF_LOGIN' });
 *
 * username/role default to req.user (or entry.user). time = test clock (ISO +07:00).
 * Aliases: from/to = fromStatus/toStatus, case_no = caseNo. Returns the new row id.
 * There is deliberately NO update/delete helper (DB triggers reject UPDATE/DELETE too).
 */
const db = require('./db');
const clock = require('./clock');

const EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];

function writeAudit(entry = {}) {
  const u = entry.user || (entry.req && entry.req.user) || {};
  const event = String(entry.event || '').toUpperCase();
  if (!EVENTS.includes(event)) throw new Error(`writeAudit: unknown event ${entry.event}`);
  const row = {
    time: entry.time ? clock.toIso(entry.time) : clock.nowIso(),
    username: entry.username !== undefined ? entry.username : u.username || null,
    role: entry.role !== undefined ? entry.role : u.role || null,
    event,
    case_no: entry.caseNo || entry.case_no || null,
    from_status: entry.fromStatus || entry.from || null,
    to_status: entry.toStatus || entry.to || null,
    detail: entry.detail === undefined || entry.detail === null ? '' : String(entry.detail),
  };
  const info = db
    .prepare(
      `INSERT INTO audit(time, username, role, event, case_no, from_status, to_status, detail)
       VALUES (@time, @username, @role, @event, @case_no, @from_status, @to_status, @detail)`
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

module.exports = { writeAudit, EVENTS };
