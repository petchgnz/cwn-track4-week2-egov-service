-- =====================================================================
-- e-Service กลาง · SQLite schema (B01)
-- Applied on every boot (CREATE ... IF NOT EXISTS) and after every
-- POST /api/test/reset (all rows wiped, then src/seed.js runs).
--
-- Conventions
--   * Every timestamp column is TEXT ISO-8601 with +07:00 offset,
--     e.g. '2026-12-01T09:00:00+07:00'  (use clock.toIso(date)).
--   * Date-only columns are TEXT 'YYYY-MM-DD' (Gregorian, Bangkok date).
--   * Money is INTEGER baht.  Year numbers in running numbers are B.E. (2569).
--   * PDPA (NFR-04): national ID / mobile / email are NEVER stored in plain
--     text.  Use src/lib/crypto.js (B02): *_enc = encrypt(value),
--     id_hash = hashId(idNo) for lookup, id_masked = 'X-XXXX-XXXXX-45-6'.
--   * Usernames (staff) are stored as plain text and used as the actor key
--     in cases.owner / audit.username / notifications.username.
-- =====================================================================

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT UNIQUE,                 -- staff login ('off.reg1'); citizens: optional synthetic id
  password_hash  TEXT,                        -- staff only · format of src/lib/password.js ('scrypt$..')
  role           TEXT NOT NULL CHECK (role IN ('citizen','officer','head','executive','auditor','admin')),
  dept           TEXT CHECK (dept IS NULL OR dept IN ('registry','works')),
  name           TEXT NOT NULL,               -- display name: 'สมชาย ใจดี' / 'เจ้าหน้าที่ทะเบียน 1'
  -- citizen-only (PDPA: encrypted at rest)
  id_hash        TEXT UNIQUE,                 -- hashId(idNo) → lookup by national ID
  id_enc         TEXT,                        -- encrypt('1101700123456')
  id_masked      TEXT,                        -- 'X-XXXX-XXXXX-45-6' (safe to store)
  mobile_enc     TEXT,                        -- encrypt('0812345678')
  email_enc      TEXT,                        -- encrypt('') allowed / NULL
  registered     INTEGER NOT NULL DEFAULT 1,  -- 0 = ThaiD identity known but not registered yet (มานะ)
  consent_at     TEXT,                        -- PDPA consent time
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, dept);

-- ------------------------------------------------------------- sessions
-- Session cookie 'sid' (HttpOnly). Role/dept are SNAPSHOT at login so that
-- admin role changes take effect on the next login (CONTRACT §6.5).
CREATE TABLE IF NOT EXISTS sessions (
  sid         TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'auth' CHECK (kind IN ('auth','register')),  -- 'register' = only /register allowed
  role        TEXT,
  dept        TEXT,
  created_at  TEXT NOT NULL,                  -- real wall-clock time (not the test clock)
  last_seen   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ------------------------------------------------------------- otp_lock
-- ThaiD OTP failure counter / lock per national ID (keyed by id_hash).
CREATE TABLE IF NOT EXISTS otp_lock (
  id_hash       TEXT PRIMARY KEY,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_fail_at  TEXT,
  locked_until  TEXT                          -- ISO +07:00 · 3rd failure time + 15 min
);

-- ------------------------------------------------------------- services
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY,              -- 'SV-01' 'SV-02' 'SV-03'
  name         TEXT NOT NULL,                 -- 'ขอหนังสือรับรอง'
  fee          INTEGER NOT NULL,              -- SV-01: per copy (20) · SV-02: fixed (500) · SV-03: base (1000)
  fee_per_sqm  INTEGER,                       -- SV-03 only (10)
  sla          INTEGER NOT NULL,              -- business days (3 / 10 / 15)
  approver     TEXT NOT NULL CHECK (approver IN ('officer','head')),
  route        TEXT NOT NULL,                 -- JSON steps e.g. '["registry","works","head"]'
  docs         TEXT NOT NULL,                 -- JSON [{"key":"id-card","label":"บัตรประชาชน","required":true,"pdfOnly":false}, ...]
  validity     TEXT,                          -- document validity: '90d' (SV-01) · '1y' (SV-02/03)
  sort         INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT
);

-- ------------------------------------------------------------- holidays
CREATE TABLE IF NOT EXISTS holidays (
  date        TEXT PRIMARY KEY,               -- 'YYYY-MM-DD'
  name        TEXT NOT NULL,
  created_at  TEXT
);

-- ------------------------------------------------------------- counters
-- Running numbers. Keys: 'draft' 'payment' 'case:2569' 'receipt:2569' 'doc:2569'.
-- value = LAST issued number. Use db.nextSeq(key) (src/lib/db.js) inside a transaction.
CREATE TABLE IF NOT EXISTS counters (
  key    TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

-- --------------------------------------------------------------- drafts
-- A draft becomes a case when its payment is PAID (case number issued then).
CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,              -- 'DR-0003'
  seq          INTEGER NOT NULL UNIQUE,
  citizen_id   INTEGER NOT NULL,              -- users.id
  service_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_PAYMENT','SUBMITTED')),
  qty          INTEGER,                       -- SV-01
  area_sqm     INTEGER,                       -- SV-03
  fee          INTEGER,                       -- current computed fee (follows admin fee until locked)
  locked_fee   INTEGER,                       -- fee locked when entering PENDING_PAYMENT (A-42)
  case_no      TEXT,                          -- set when paid
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_citizen ON drafts(citizen_id, status);

-- ---------------------------------------------------------------- cases
CREATE TABLE IF NOT EXISTS cases (
  case_no        TEXT PRIMARY KEY,            -- 'EG-2569-000031'
  year_be        INTEGER NOT NULL,            -- 2569 (B.E. year of payment time)
  seq            INTEGER NOT NULL,            -- 31
  draft_id       TEXT,
  citizen_id     INTEGER NOT NULL,            -- users.id
  service_id     TEXT NOT NULL,
  qty            INTEGER,
  area_sqm       INTEGER,
  fee            INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('SUBMITTED','IN_REVIEW','NEED_FIX','PENDING_APPROVAL','APPROVED','COMPLETED','REJECTED','CANCELLED')),
  step           INTEGER,                     -- SV-03 only: 1 registry · 2 works · 3 head ; other services NULL
  stage          TEXT CHECK (stage IS NULL OR stage IN ('registry','works','head','issue','closed')),
                                              -- where the case is now: dept queue / head approvals / waiting issue / closed
  owner          TEXT,                        -- username holding the case (NULL = unclaimed / at head)
  issuer         TEXT,                        -- registry officer who claimed step 1 (issues the document · A-27)
  approved_by    TEXT,                        -- username of approver (signer)
  approved_at    TEXT,
  return_count   INTEGER NOT NULL DEFAULT 0,
  returned_at    TEXT,                        -- last return time (NEED_FIX)
  return_reason  TEXT,                        -- last return reason (return-reason-display)
  fix_deadline   TEXT,                        -- returned_at + 168h
  paid_at        TEXT NOT NULL,
  payment_ref    TEXT,
  receipt_no     TEXT,
  due_at         TEXT NOT NULL,               -- stored SLA due (seed values are fixed · A-35)
  closed_at      TEXT,                        -- COMPLETED / REJECTED time
  cancelled_at   TEXT,
  cancel_reason  TEXT,                        -- 'CITIZEN' / 'AUTO_FIX_EXPIRED'
  reject_reason  TEXT,
  doc_no         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT,
  UNIQUE (year_be, seq)
);
CREATE INDEX IF NOT EXISTS idx_cases_citizen ON cases(citizen_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status, stage);
CREATE INDEX IF NOT EXISTS idx_cases_owner ON cases(owner);

-- Timeline of a case (timeline-item). Includes citizen events and seed history.
CREATE TABLE IF NOT EXISTS case_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no      TEXT NOT NULL,
  at           TEXT NOT NULL,
  actor        TEXT,                          -- username / 'system' / NULL (citizen)
  actor_role   TEXT,
  event        TEXT NOT NULL,                 -- PAID SUBMITTED CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL AUTO_CANCEL
  from_status  TEXT,
  to_status    TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_no, at);

-- Return / resubmit history (SLA pause: business days in (returned_at, resubmitted_at]).
CREATE TABLE IF NOT EXISTS case_returns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no         TEXT NOT NULL,
  n               INTEGER NOT NULL,           -- 1, 2 (3 only under BUG B12)
  returned_at     TEXT NOT NULL,
  returned_by     TEXT,
  reason          TEXT NOT NULL,
  resubmitted_at  TEXT,
  paused_days     INTEGER,
  due_before      TEXT,
  due_after       TEXT,
  UNIQUE (case_no, n)
);

-- ---------------------------------------------------------------- files
-- Uploaded attachments. Content stored as BLOB so reset wipes it with the DB.
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,              -- fileId (any format, e.g. 'F-000001' or random hex)
  draft_id     TEXT,
  case_no      TEXT,
  doc_key      TEXT NOT NULL CHECK (doc_key IN ('id-card','map','site-photo','plan','deed','extra')),
  name         TEXT NOT NULL,                 -- original filename 'id-card.pdf'
  mime         TEXT NOT NULL,                 -- from magic bytes: application/pdf · image/jpeg · image/png
  size         INTEGER NOT NULL,
  data         BLOB,
  phase        TEXT NOT NULL DEFAULT 'initial' CHECK (phase IN ('initial','fix')),
  uploaded_by  INTEGER,                       -- users.id
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_draft ON files(draft_id);
CREATE INDEX IF NOT EXISTS idx_files_case ON files(case_no);

-- ------------------------------------------------------------- payments
-- QR expiry is computed from the clock: expired ⇔ now − created_at ≥ 15:00 (BUG B05: >).
CREATE TABLE IF NOT EXISTS payments (
  ref          TEXT PRIMARY KEY,              -- 'PP-0002'
  seq          INTEGER NOT NULL UNIQUE,
  draft_id     TEXT NOT NULL,
  citizen_id   INTEGER,
  amount       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','VOID')),  -- VOID = draft deleted / superseded
  created_at   TEXT NOT NULL,                 -- qrCreatedAt
  expires_at   TEXT NOT NULL,                 -- qrExpiresAt = created_at + 15 min
  paid_at      TEXT,
  case_no      TEXT,
  receipt_no   TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_draft ON payments(draft_id);

-- ------------------------------------------------------------- receipts
CREATE TABLE IF NOT EXISTS receipts (
  receipt_no   TEXT PRIMARY KEY,              -- 'RC-2569-000031'
  year_be      INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  case_no      TEXT NOT NULL UNIQUE,
  payment_ref  TEXT,
  amount       INTEGER NOT NULL,
  paid_at      TEXT NOT NULL,
  UNIQUE (year_be, seq)
);

-- ------------------------------------------------------------ documents
-- Signature = HMAC-SHA256(docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer).
-- /api/test/documents/:docNo/tamper changes a stored field WITHOUT re-signing.
CREATE TABLE IF NOT EXISTS documents (
  doc_no       TEXT PRIMARY KEY,              -- 'DOC-2569-000002'
  year_be      INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  case_no      TEXT NOT NULL UNIQUE,
  verify_code  TEXT NOT NULL UNIQUE,          -- [A-Z0-9]{8}
  applicant    TEXT NOT NULL,                 -- full name at issue time (masked on /verify)
  service_id   TEXT NOT NULL,
  issued_at    TEXT NOT NULL,                 -- ISO +07:00
  valid_until  TEXT NOT NULL,                 -- 'YYYY-MM-DD' last valid day
  signer       TEXT NOT NULL,                 -- display name of approver
  signer_username TEXT,
  issued_by    TEXT,                          -- username who pressed "ออกเอกสาร"
  signature    TEXT NOT NULL,
  UNIQUE (year_be, seq)
);

-- -------------------------------------------------------- notifications
-- 1 row per (user, case, level) — never duplicated (DECISIONS §8).
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  case_no     TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('near','overdue')),
  text        TEXT NOT NULL,                  -- 'คำขอ EG-2569-000024 ใกล้ครบกำหนด'
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  UNIQUE (username, case_no, level)
);

-- ---------------------------------------------------------------- audit
-- Append-only. UPDATE is always rejected; DELETE only during test reset
-- (sys_flags 'allow_audit_wipe' is set by src/lib/db.js wipeAll()).
CREATE TABLE IF NOT EXISTS audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  time         TEXT NOT NULL,                 -- ISO +07:00 from the test clock
  username     TEXT,
  role         TEXT,
  event        TEXT NOT NULL CHECK (event IN ('STAFF_LOGIN','CLAIM','RETURN','FORWARD','APPROVE','REJECT','ISSUE','UNMASK','EXPORT','ADMIN_CHANGE')),
  case_no      TEXT,
  from_status  TEXT,
  to_status    TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(time);

CREATE TABLE IF NOT EXISTS sys_flags (
  k  TEXT PRIMARY KEY,
  v  TEXT
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit trail is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
WHEN NOT EXISTS (SELECT 1 FROM sys_flags WHERE k = 'allow_audit_wipe')
BEGIN
  SELECT RAISE(ABORT, 'audit trail is append-only');
END;
