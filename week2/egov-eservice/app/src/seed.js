'use strict';
/**
 * Seed data after reset (B02) — TEST-DATA.md §1–§12 + DECISIONS.md §17.
 *
 * Executed inside a transaction on every POST /api/test/reset (after db.wipeAll()
 * and clock.reset() to 2026-12-01T09:00:00+07:00).
 *
 * Personal data (national ID, mobile) is encrypted at rest using AES-256-GCM
 * via src/lib/crypto.js (NFR-04).
 */
const fs = require('fs');
const path = require('path');
const cryptoLib = require('./lib/crypto');
const hooks = require('./lib/hooks');
const { hashPassword: defaultHashPassword } = require('./lib/password');

const { encrypt, hashId, maskIdNo, isValidThaiId, signDocument } = cryptoLib;

/**
 * Generate a real 1,024-byte PDF buffer (same structure as make_testfiles.py).
 */
function makePdfBuffer(n = 1024) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'ascii');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'ascii');
  const padLen = n - head.length - tail.length;
  if (padLen < 0) throw new Error(`PDF size ${n} too small`);
  return Buffer.concat([head, Buffer.alloc(padLen, 0x20), tail]);
}

const PDF_1024 = makePdfBuffer(1024);

// Cache staff password hash across resets so reset is instantaneous (<5ms)
let cachedStaffHash = null;
function getStaffPasswordHash(hashFn) {
  if (!cachedStaffHash) {
    cachedStaffHash = (hashFn || defaultHashPassword)('Test@1234');
  }
  return cachedStaffHash;
}

/**
 * Strip inline SQL comments from sqlite_master for `users` table if present,
 * so `schema.sql` example comments never appear in raw DB file inspection (TC-NFR-04).
 */
function ensureCleanUsersSchema(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (row && row.sql && row.sql.includes('--')) {
    const cleanSql = row.sql.replace(/--[^\r\n]*/g, '');
    db.exec('DROP TABLE users');
    db.exec(cleanSql);
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, dept)');
    return true;
  }
  return false;
}

// Register reset hook to checkpoint WAL / vacuum if needed after schema cleanup
let needsVacuumOnReset = false;
hooks.onReset(() => {
  if (needsVacuumOnReset) {
    try {
      const db = require('./lib/db');
      db.exec('VACUUM');
      db.pragma('wal_checkpoint(TRUNCATE)');
      needsVacuumOnReset = false;
    } catch {
      // ignore if inside transaction
    }
  }
});

// Clean once at module load time as well
try {
  const dbInstance = require('./lib/db');
  const count = dbInstance.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0 && ensureCleanUsersSchema(dbInstance)) {
    dbInstance.exec('VACUUM');
    dbInstance.pragma('wal_checkpoint(TRUNCATE)');
  }
} catch {
  // ignore during standalone load
}

// §1.1 Citizens (ThaiD mock · OTP 123456)
const CITIZENS = [
  {
    key: 'somchai',
    name: 'สมชาย ใจดี',
    idNo: '1101700123456',
    mobile: '0812345678',
    registered: 1,
    consentAt: '2026-10-01T09:00:00+07:00',
  },
  {
    key: 'somying',
    name: 'สมหญิง รักไทย',
    idNo: '3100600987659',
    mobile: '0823456789',
    registered: 1,
    consentAt: '2026-10-01T09:00:00+07:00',
  },
  {
    key: 'mana',
    name: 'มานะ ตั้งใจ',
    idNo: '5500400111221',
    mobile: null,
    registered: 0,
    consentAt: null,
  },
  {
    key: 'piti',
    name: 'ปิติ มีสุข',
    idNo: '1909900555015',
    mobile: '0834567890',
    registered: 1,
    consentAt: '2026-10-01T09:00:00+07:00',
  },
];

// Validate checksum of every seed citizen ID on startup
for (const c of CITIZENS) {
  if (!isValidThaiId(c.idNo)) {
    throw new Error(`Invalid Thai national ID checksum for seed citizen ${c.name}`);
  }
}

// §1.2 Staff accounts (password: Test@1234)
const STAFF = [
  { username: 'off.reg1', name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry' },
  { username: 'off.reg2', name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry' },
  { username: 'off.works1', name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works' },
  { username: 'head1', name: 'หัวหน้าฝ่าย', role: 'head', dept: null },
  { username: 'exec1', name: 'ผู้บริหาร', role: 'executive', dept: null },
  { username: 'audit1', name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: null },
  { username: 'admin1', name: 'ผู้ดูแลระบบ', role: 'admin', dept: null },
];

// §2 Services catalog
const SERVICES = [
  {
    id: 'SV-01',
    name: 'ขอหนังสือรับรอง',
    fee: 20,
    fee_per_sqm: null,
    sla: 3,
    approver: 'officer',
    route: JSON.stringify(['registry']),
    docs: JSON.stringify([
      { key: 'id-card', label: 'บัตรประชาชน', required: true, pdfOnly: false },
    ]),
    validity: '90d',
    sort: 1,
  },
  {
    id: 'SV-02',
    name: 'ขออนุญาตประกอบกิจการ',
    fee: 500,
    fee_per_sqm: null,
    sla: 10,
    approver: 'head',
    route: JSON.stringify(['registry', 'head']),
    docs: JSON.stringify([
      { key: 'id-card', label: 'บัตรประชาชน', required: true, pdfOnly: false },
      { key: 'map', label: 'แผนที่ตั้ง', required: true, pdfOnly: false },
      { key: 'site-photo', label: 'ภาพสถานที่', required: false, pdfOnly: false },
    ]),
    validity: '1y',
    sort: 2,
  },
  {
    id: 'SV-03',
    name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
    fee: 1000,
    fee_per_sqm: 10,
    sla: 15,
    approver: 'head',
    route: JSON.stringify(['registry', 'works', 'head']),
    docs: JSON.stringify([
      { key: 'id-card', label: 'บัตรประชาชน', required: true, pdfOnly: false },
      { key: 'plan', label: 'แบบแปลน', required: true, pdfOnly: true },
      { key: 'deed', label: 'โฉนด', required: true, pdfOnly: false },
    ]),
    validity: '1y',
    sort: 3,
  },
];

// §3 Holidays
const HOLIDAYS = [
  { date: '2026-12-07', name: 'ชดเชยวันหยุดทดสอบ (สมมติ)' },
  { date: '2026-12-10', name: 'วันรัฐธรรมนูญทดสอบ (สมมติ)' },
  { date: '2026-12-31', name: 'วันสิ้นปีทดสอบ (สมมติ)' },
  { date: '2027-01-01', name: 'วันขึ้นปีใหม่ทดสอบ (สมมติ)' },
];

// Mandatory attachment doc keys per service (§4.1 line 95)
const MANDATORY_FILES = {
  'SV-01': [{ doc_key: 'id-card', name: 'id-card.pdf' }],
  'SV-02': [
    { doc_key: 'id-card', name: 'id-card.pdf' },
    { doc_key: 'map', name: 'map.pdf' },
  ],
  'SV-03': [
    { doc_key: 'id-card', name: 'id-card.pdf' },
    { doc_key: 'plan', name: 'plan.pdf' },
    { doc_key: 'deed', name: 'deed.pdf' },
  ],
};

// §4.1 30 paid cases (ordered by paid_at, seq 1..30)
const CASES = [
  {
    seq: 1,
    label: 'H01',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somying',
    status: 'COMPLETED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'off.reg1',
    approved_at: '2026-10-16T13:30:00+07:00',
    paid_at: '2026-10-14T10:00:00+07:00',
    due_at: '2026-10-19T16:30:00+07:00',
    closed_at: '2026-10-16T14:00:00+07:00',
  },
  {
    seq: 2,
    label: 'H05',
    service_id: 'SV-03',
    qty: null,
    area_sqm: 120,
    fee: 1200,
    citizen: 'piti',
    status: 'COMPLETED',
    step: 3,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'head1',
    approved_at: '2026-11-20T10:30:00+07:00',
    paid_at: '2026-11-02T09:00:00+07:00',
    due_at: '2026-11-23T16:30:00+07:00',
    closed_at: '2026-11-20T11:00:00+07:00',
  },
  {
    seq: 3,
    label: 'H02',
    service_id: 'SV-01',
    qty: 2,
    area_sqm: null,
    fee: 40,
    citizen: 'piti',
    status: 'COMPLETED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'off.reg1',
    approved_at: '2026-11-04T14:30:00+07:00',
    paid_at: '2026-11-02T09:30:00+07:00',
    due_at: '2026-11-05T16:30:00+07:00',
    closed_at: '2026-11-04T15:00:00+07:00',
  },
  {
    seq: 4,
    label: 'H06',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'somchai',
    status: 'COMPLETED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'head1',
    approved_at: '2026-11-13T14:30:00+07:00',
    paid_at: '2026-11-02T14:00:00+07:00',
    due_at: '2026-11-16T16:30:00+07:00',
    closed_at: '2026-11-13T15:00:00+07:00',
  },
  {
    seq: 5,
    label: 'H03',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somchai',
    status: 'COMPLETED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'off.reg1',
    approved_at: '2026-11-05T09:30:00+07:00',
    paid_at: '2026-11-03T11:00:00+07:00',
    due_at: '2026-11-06T16:30:00+07:00',
    closed_at: '2026-11-05T10:00:00+07:00',
    doc_no: 'DOC-2569-000001',
  },
  {
    seq: 6,
    label: 'H08',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'piti',
    status: 'COMPLETED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'head1',
    approved_at: '2026-11-19T09:30:00+07:00',
    paid_at: '2026-11-03T15:00:00+07:00',
    due_at: '2026-11-17T16:30:00+07:00',
    closed_at: '2026-11-19T10:00:00+07:00',
  },
  {
    seq: 7,
    label: 'H07',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'somying',
    status: 'COMPLETED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'head1',
    approved_at: '2026-11-18T15:30:00+07:00',
    paid_at: '2026-11-04T10:00:00+07:00',
    due_at: '2026-11-18T16:30:00+07:00',
    closed_at: '2026-11-18T16:00:00+07:00',
  },
  {
    seq: 8,
    label: 'H04',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somying',
    status: 'REJECTED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: 'off.reg1',
    paid_at: '2026-11-09T10:00:00+07:00',
    due_at: '2026-11-12T16:30:00+07:00',
    closed_at: '2026-11-11T09:00:00+07:00',
    reject_reason: 'ข้อมูลในคำขอไม่ถูกต้องตามระเบียบ',
  },
  {
    seq: 9,
    label: 'X01',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somchai',
    status: 'CANCELLED',
    step: null,
    stage: 'closed',
    owner: null,
    issuer: null,
    paid_at: '2026-11-09T14:30:00+07:00',
    due_at: '2026-11-12T16:30:00+07:00',
    closed_at: null,
    cancelled_at: '2026-11-09T15:00:00+07:00',
    cancel_reason: 'CITIZEN',
  },
  {
    seq: 10,
    label: 'W01',
    service_id: 'SV-03',
    qty: null,
    area_sqm: 80,
    fee: 1000,
    citizen: 'somying',
    status: 'IN_REVIEW',
    step: 2,
    stage: 'works',
    owner: null,
    issuer: 'off.reg1',
    paid_at: '2026-11-12T10:00:00+07:00',
    due_at: '2026-12-03T16:30:00+07:00',
  },
  {
    seq: 11,
    label: 'P02',
    service_id: 'SV-03',
    qty: null,
    area_sqm: 150,
    fee: 1500,
    citizen: 'somchai',
    status: 'PENDING_APPROVAL',
    step: 3,
    stage: 'head',
    owner: null,
    issuer: 'off.reg1',
    paid_at: '2026-11-16T10:00:00+07:00',
    due_at: '2026-12-08T16:30:00+07:00',
  },
  {
    seq: 12,
    label: 'R09',
    service_id: 'SV-03',
    qty: null,
    area_sqm: 101,
    fee: 1010,
    citizen: 'piti',
    status: 'IN_REVIEW',
    step: 1,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-18T10:00:00+07:00',
    due_at: '2026-12-11T16:30:00+07:00',
  },
  {
    seq: 13,
    label: 'R01',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'somchai',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-20T10:00:00+07:00',
    due_at: '2026-12-04T16:30:00+07:00',
  },
  {
    seq: 14,
    label: 'P01',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'piti',
    status: 'PENDING_APPROVAL',
    step: null,
    stage: 'head',
    owner: null,
    issuer: 'off.reg1',
    paid_at: '2026-11-20T11:00:00+07:00',
    due_at: '2026-12-04T16:30:00+07:00',
  },
  {
    seq: 15,
    label: 'R02',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'somying',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-20T15:00:00+07:00',
    due_at: '2026-12-04T16:30:00+07:00',
  },
  {
    seq: 16,
    label: 'R03',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'piti',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-23T09:00:00+07:00',
    due_at: '2026-12-08T16:30:00+07:00',
  },
  {
    seq: 17,
    label: 'F01',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somchai',
    status: 'NEED_FIX',
    step: null,
    stage: 'registry',
    owner: 'off.reg1',
    issuer: 'off.reg1',
    return_count: 2,
    returned_at: '2026-11-27T14:00:00+07:00',
    return_reason: 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข',
    fix_deadline: '2026-12-04T14:00:00+07:00',
    paid_at: '2026-11-23T10:00:00+07:00',
    due_at: '2026-11-27T16:30:00+07:00',
  },
  {
    seq: 18,
    label: 'R04',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'somchai',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-24T10:00:00+07:00',
    due_at: '2026-12-09T16:30:00+07:00',
  },
  {
    seq: 19,
    label: 'A01',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'somying',
    status: 'APPROVED',
    step: null,
    stage: 'registry',
    owner: null,
    issuer: 'off.reg1',
    approved_by: 'head1',
    approved_at: '2026-11-30T15:00:00+07:00',
    paid_at: '2026-11-24T14:00:00+07:00',
    due_at: '2026-12-09T16:30:00+07:00',
  },
  {
    seq: 20,
    label: 'O01',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somchai',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg1',
    issuer: 'off.reg1',
    paid_at: '2026-11-25T10:00:00+07:00',
    due_at: '2026-11-30T16:30:00+07:00',
  },
  {
    seq: 21,
    label: 'R08',
    service_id: 'SV-02',
    qty: null,
    area_sqm: null,
    fee: 500,
    citizen: 'somying',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-25T12:00:00+07:00',
    due_at: '2026-12-11T16:30:00+07:00',
  },
  {
    seq: 22,
    label: 'N02',
    service_id: 'SV-01',
    qty: 2,
    area_sqm: null,
    fee: 40,
    citizen: 'somying',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg1',
    issuer: 'off.reg1',
    paid_at: '2026-11-26T10:00:00+07:00',
    due_at: '2026-12-01T16:30:00+07:00',
  },
  {
    seq: 23,
    label: 'F02',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somying',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg1',
    issuer: 'off.reg1',
    return_count: 2,
    returned_at: '2026-11-30T14:00:00+07:00',
    return_reason: 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน',
    fix_deadline: null,
    paid_at: '2026-11-26T10:30:00+07:00',
    due_at: '2026-12-03T16:30:00+07:00',
  },
  {
    seq: 24,
    label: 'N01',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'piti',
    status: 'SUBMITTED',
    step: null,
    stage: 'registry',
    owner: null,
    issuer: null,
    paid_at: '2026-11-27T11:00:00+07:00',
    due_at: '2026-12-02T16:30:00+07:00',
  },
  {
    seq: 25,
    label: 'R05',
    service_id: 'SV-01',
    qty: 3,
    area_sqm: null,
    fee: 60,
    citizen: 'somying',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-30T10:00:00+07:00',
    due_at: '2026-12-03T16:30:00+07:00',
  },
  {
    seq: 26,
    label: 'R07',
    service_id: 'SV-01',
    qty: 5,
    area_sqm: null,
    fee: 100,
    citizen: 'somchai',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-30T16:29:00+07:00',
    due_at: '2026-12-03T16:30:00+07:00',
  },
  {
    seq: 27,
    label: 'R06',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'piti',
    status: 'IN_REVIEW',
    step: null,
    stage: 'registry',
    owner: 'off.reg2',
    issuer: 'off.reg2',
    paid_at: '2026-11-30T16:30:00+07:00',
    due_at: '2026-12-04T16:30:00+07:00',
  },
  {
    seq: 28,
    label: 'S01',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somying',
    status: 'SUBMITTED',
    step: null,
    stage: 'registry',
    owner: null,
    issuer: null,
    paid_at: '2026-12-01T08:10:00+07:00',
    due_at: '2026-12-04T16:30:00+07:00',
  },
  {
    seq: 29,
    label: 'S02',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'piti',
    status: 'SUBMITTED',
    step: null,
    stage: 'registry',
    owner: null,
    issuer: null,
    paid_at: '2026-12-01T08:20:00+07:00',
    due_at: '2026-12-04T16:30:00+07:00',
  },
  {
    seq: 30,
    label: 'S03',
    service_id: 'SV-01',
    qty: 1,
    area_sqm: null,
    fee: 20,
    citizen: 'somchai',
    status: 'SUBMITTED',
    step: null,
    stage: 'registry',
    owner: null,
    issuer: null,
    paid_at: '2026-12-01T08:30:00+07:00',
    due_at: '2026-12-04T16:30:00+07:00',
  },
];

// §4.4 Return history for F01 (EG-2569-000017) and F02 (EG-2569-000023)
const CASE_RETURNS = [
  {
    case_no: 'EG-2569-000017',
    n: 1,
    returned_at: '2026-11-24T11:00:00+07:00',
    returned_by: 'off.reg1',
    reason: 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่',
    resubmitted_at: '2026-11-25T10:00:00+07:00',
    paused_days: 1,
    due_before: '2026-11-26T16:30:00+07:00',
    due_after: '2026-11-27T16:30:00+07:00',
  },
  {
    case_no: 'EG-2569-000017',
    n: 2,
    returned_at: '2026-11-27T14:00:00+07:00',
    returned_by: 'off.reg1',
    reason: 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข',
    resubmitted_at: null,
    paused_days: null,
    due_before: '2026-11-27T16:30:00+07:00',
    due_after: null,
  },
  {
    case_no: 'EG-2569-000023',
    n: 1,
    returned_at: '2026-11-27T10:00:00+07:00',
    returned_by: 'off.reg1',
    reason: 'ภาพเอกสารเบลอ อ่านเลขไม่ได้',
    resubmitted_at: '2026-11-30T10:00:00+07:00',
    paused_days: 1,
    due_before: '2026-12-01T16:30:00+07:00',
    due_after: '2026-12-02T16:30:00+07:00',
  },
  {
    case_no: 'EG-2569-000023',
    n: 2,
    returned_at: '2026-11-30T14:00:00+07:00',
    returned_by: 'off.reg1',
    reason: 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน',
    resubmitted_at: '2026-12-01T08:30:00+07:00',
    paused_days: 1,
    due_before: '2026-12-02T16:30:00+07:00',
    due_after: '2026-12-03T16:30:00+07:00',
  },
];

function pad6(n) {
  return String(n).padStart(6, '0');
}

function seed(db, ctx = {}) {
  if (ensureCleanUsersSchema(db)) {
    needsVacuumOnReset = true;
  }

  const setSeq = ctx.setSeq || db.setSeq;
  const uploadDir = ctx.UPLOAD_DIR || db.UPLOAD_DIR;
  const staffPwHash = getStaffPasswordHash(ctx.hashPassword);
  const seedCreatedAt = '2026-10-01T09:00:00+07:00';

  if (uploadDir) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // 1. Seed Users (Citizens + Staff)
  const insertUser = db.prepare(`
    INSERT INTO users (
      username, password_hash, role, dept, name,
      id_hash, id_enc, id_masked, mobile_enc, email_enc,
      registered, consent_at, active, created_at, updated_at
    ) VALUES (
      @username, @password_hash, @role, @dept, @name,
      @id_hash, @id_enc, @id_masked, @mobile_enc, @email_enc,
      @registered, @consent_at, 1, @created_at, @updated_at
    )
  `);

  const citizenIds = {};
  for (const c of CITIZENS) {
    const info = insertUser.run({
      username: null,
      password_hash: null,
      role: 'citizen',
      dept: null,
      name: c.name,
      id_hash: hashId(c.idNo),
      id_enc: encrypt(c.idNo),
      id_masked: maskIdNo(c.idNo),
      mobile_enc: c.mobile ? encrypt(c.mobile) : null,
      email_enc: null,
      registered: c.registered,
      consent_at: c.consentAt,
      created_at: seedCreatedAt,
      updated_at: seedCreatedAt,
    });
    citizenIds[c.key] = Number(info.lastInsertRowid);
  }

  for (const s of STAFF) {
    insertUser.run({
      username: s.username,
      password_hash: staffPwHash,
      role: s.role,
      dept: s.dept,
      name: s.name,
      id_hash: null,
      id_enc: null,
      id_masked: null,
      mobile_enc: null,
      email_enc: null,
      registered: 1,
      consent_at: null,
      created_at: seedCreatedAt,
      updated_at: seedCreatedAt,
    });
  }

  // 2. Seed Services
  const insertService = db.prepare(`
    INSERT INTO services (
      id, name, fee, fee_per_sqm, sla, approver, route, docs, validity, sort, updated_at
    ) VALUES (
      @id, @name, @fee, @fee_per_sqm, @sla, @approver, @route, @docs, @validity, @sort, @updated_at
    )
  `);
  for (const svc of SERVICES) {
    insertService.run({ ...svc, updated_at: seedCreatedAt });
  }

  // 3. Seed Holidays
  const insertHoliday = db.prepare(`
    INSERT INTO holidays (date, name, created_at) VALUES (@date, @name, @created_at)
  `);
  for (const h of HOLIDAYS) {
    insertHoliday.run({ ...h, created_at: seedCreatedAt });
  }

  // 4. Seed 30 Cases + Receipts + Mandatory Attachment Files + Case Events
  const insertCase = db.prepare(`
    INSERT INTO cases (
      case_no, year_be, seq, draft_id, citizen_id, service_id,
      qty, area_sqm, fee, status, step, stage,
      owner, issuer, approved_by, approved_at,
      return_count, returned_at, return_reason, fix_deadline,
      paid_at, payment_ref, receipt_no, due_at,
      closed_at, cancelled_at, cancel_reason, reject_reason, doc_no,
      created_at, updated_at
    ) VALUES (
      @case_no, @year_be, @seq, @draft_id, @citizen_id, @service_id,
      @qty, @area_sqm, @fee, @status, @step, @stage,
      @owner, @issuer, @approved_by, @approved_at,
      @return_count, @returned_at, @return_reason, @fix_deadline,
      @paid_at, @payment_ref, @receipt_no, @due_at,
      @closed_at, @cancelled_at, @cancel_reason, @reject_reason, @doc_no,
      @created_at, @updated_at
    )
  `);

  const insertReceipt = db.prepare(`
    INSERT INTO receipts (
      receipt_no, year_be, seq, case_no, payment_ref, amount, paid_at
    ) VALUES (
      @receipt_no, @year_be, @seq, @case_no, @payment_ref, @amount, @paid_at
    )
  `);

  const insertFile = db.prepare(`
    INSERT INTO files (
      id, draft_id, case_no, doc_key, name, mime, size, data, phase, uploaded_by, created_at
    ) VALUES (
      @id, @draft_id, @case_no, @doc_key, @name, @mime, @size, @data, @phase, @uploaded_by, @created_at
    )
  `);

  const insertEvent = db.prepare(`
    INSERT INTO case_events (
      case_no, at, actor, actor_role, event, from_status, to_status, detail
    ) VALUES (
      @case_no, @at, @actor, @actor_role, @event, @from_status, @to_status, @detail
    )
  `);

  let fileSeq = 0;
  function addFile({ draft_id = null, case_no = null, doc_key, name, uploaded_by, created_at }) {
    fileSeq += 1;
    const id = `F-${pad6(fileSeq)}`;
    insertFile.run({
      id,
      draft_id,
      case_no,
      doc_key,
      name,
      mime: 'application/pdf',
      size: PDF_1024.length,
      data: PDF_1024,
      phase: 'initial',
      uploaded_by,
      created_at,
    });
    if (uploadDir) {
      try {
        fs.writeFileSync(path.join(uploadDir, id), PDF_1024);
      } catch {
        // ignore if uploadDir not writable
      }
    }
    return id;
  }

  for (const c of CASES) {
    const caseNo = `EG-2569-${pad6(c.seq)}`;
    const receiptNo = `RC-2569-${pad6(c.seq)}`;
    const citizenId = citizenIds[c.citizen];
    const updatedAt = c.closed_at || c.cancelled_at || c.approved_at || c.returned_at || c.paid_at;

    insertCase.run({
      case_no: caseNo,
      year_be: 2569,
      seq: c.seq,
      draft_id: null,
      citizen_id: citizenId,
      service_id: c.service_id,
      qty: c.qty ?? null,
      area_sqm: c.area_sqm ?? null,
      fee: c.fee,
      status: c.status,
      step: c.step ?? null,
      stage: c.stage ?? null,
      owner: c.owner ?? null,
      issuer: c.issuer ?? null,
      approved_by: c.approved_by ?? null,
      approved_at: c.approved_at ?? null,
      return_count: c.return_count ?? 0,
      returned_at: c.returned_at ?? null,
      return_reason: c.return_reason ?? null,
      fix_deadline: c.fix_deadline ?? null,
      paid_at: c.paid_at,
      payment_ref: null,
      receipt_no: receiptNo,
      due_at: c.due_at,
      closed_at: c.closed_at ?? null,
      cancelled_at: c.cancelled_at ?? null,
      cancel_reason: c.cancel_reason ?? null,
      reject_reason: c.reject_reason ?? null,
      doc_no: c.doc_no ?? null,
      created_at: c.paid_at,
      updated_at: updatedAt,
    });

    insertReceipt.run({
      receipt_no: receiptNo,
      year_be: 2569,
      seq: c.seq,
      case_no: caseNo,
      payment_ref: null,
      amount: c.fee,
      paid_at: c.paid_at,
    });

    // Mandatory attachment files for every case (§4.1 line 95)
    for (const f of MANDATORY_FILES[c.service_id]) {
      addFile({
        case_no: caseNo,
        doc_key: f.doc_key,
        name: f.name,
        uploaded_by: citizenId,
        created_at: c.paid_at,
      });
    }

    // Timeline events for the case
    insertEvent.run({
      case_no: caseNo,
      at: c.paid_at,
      actor: null,
      actor_role: 'citizen',
      event: 'SUBMITTED',
      from_status: 'PENDING_PAYMENT',
      to_status: 'SUBMITTED',
      detail: 'ชำระเงินและยื่นคำขอ',
    });

    if (c.seq === 9) {
      // X01: cancelled by citizen
      insertEvent.run({
        case_no: caseNo,
        at: c.cancelled_at,
        actor: null,
        actor_role: 'citizen',
        event: 'CANCEL',
        from_status: 'SUBMITTED',
        to_status: 'CANCELLED',
        detail: 'ประชาชนยกเลิกคำขอ',
      });
    } else if (c.seq === 17) {
      // F01: 2 returns, currently NEED_FIX
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-23T11:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-24T11:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'RETURN',
        from_status: 'IN_REVIEW',
        to_status: 'NEED_FIX',
        detail: 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-25T10:00:00+07:00',
        actor: null,
        actor_role: 'citizen',
        event: 'RESUBMIT',
        from_status: 'NEED_FIX',
        to_status: 'IN_REVIEW',
        detail: 'ส่งแก้ไขเอกสาร',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-27T14:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'RETURN',
        from_status: 'IN_REVIEW',
        to_status: 'NEED_FIX',
        detail: 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข',
      });
    } else if (c.seq === 23) {
      // F02: 2 returns, resubmitted back to IN_REVIEW
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-26T11:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-27T10:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'RETURN',
        from_status: 'IN_REVIEW',
        to_status: 'NEED_FIX',
        detail: 'ภาพเอกสารเบลอ อ่านเลขไม่ได้',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-30T10:00:00+07:00',
        actor: null,
        actor_role: 'citizen',
        event: 'RESUBMIT',
        from_status: 'NEED_FIX',
        to_status: 'IN_REVIEW',
        detail: 'ส่งแก้ไขเอกสาร',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-30T14:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'RETURN',
        from_status: 'IN_REVIEW',
        to_status: 'NEED_FIX',
        detail: 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-12-01T08:30:00+07:00',
        actor: null,
        actor_role: 'citizen',
        event: 'RESUBMIT',
        from_status: 'NEED_FIX',
        to_status: 'IN_REVIEW',
        detail: 'ส่งแก้ไขเอกสาร',
      });
    } else if (c.seq === 10) {
      // W01: SV-03 claimed & forwarded by off.reg1 to works
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-12T11:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-13T10:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'FORWARD',
        from_status: 'IN_REVIEW',
        to_status: 'IN_REVIEW',
        detail: 'ส่งต่อฝ่ายโยธา',
      });
    } else if (c.seq === 11) {
      // P02: SV-03 through off.reg1 and off.works1 to head1
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-16T11:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-17T10:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'FORWARD',
        from_status: 'IN_REVIEW',
        to_status: 'IN_REVIEW',
        detail: 'ส่งต่อฝ่ายโยธา',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-18T10:00:00+07:00',
        actor: 'off.works1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'IN_REVIEW',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-19T10:00:00+07:00',
        actor: 'off.works1',
        actor_role: 'officer',
        event: 'FORWARD',
        from_status: 'IN_REVIEW',
        to_status: 'PENDING_APPROVAL',
        detail: 'ส่งต่อหัวหน้าฝ่าย',
      });
    } else if (c.seq === 14) {
      // P01: SV-02 claimed & forwarded by off.reg1 to head1
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-20T13:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-23T14:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'FORWARD',
        from_status: 'IN_REVIEW',
        to_status: 'PENDING_APPROVAL',
        detail: 'ส่งต่อหัวหน้าฝ่าย',
      });
    } else if (c.seq === 19) {
      // A01: SV-02 claimed & forwarded by off.reg1, approved by head1
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-24T15:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-26T14:00:00+07:00',
        actor: 'off.reg1',
        actor_role: 'officer',
        event: 'FORWARD',
        from_status: 'IN_REVIEW',
        to_status: 'PENDING_APPROVAL',
        detail: 'ส่งต่อหัวหน้าฝ่าย',
      });
      insertEvent.run({
        case_no: caseNo,
        at: '2026-11-30T15:00:00+07:00',
        actor: 'head1',
        actor_role: 'head',
        event: 'APPROVE',
        from_status: 'PENDING_APPROVAL',
        to_status: 'APPROVED',
        detail: '',
      });
    } else if (c.status === 'IN_REVIEW' && c.owner) {
      insertEvent.run({
        case_no: caseNo,
        at: c.paid_at,
        actor: c.owner,
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
    } else if (c.status === 'REJECTED') {
      insertEvent.run({
        case_no: caseNo,
        at: c.paid_at,
        actor: c.issuer || 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: c.closed_at,
        actor: c.issuer || 'off.reg1',
        actor_role: 'officer',
        event: 'REJECT',
        from_status: 'IN_REVIEW',
        to_status: 'REJECTED',
        detail: c.reject_reason || '',
      });
    } else if (c.status === 'COMPLETED') {
      insertEvent.run({
        case_no: caseNo,
        at: c.paid_at,
        actor: c.issuer || 'off.reg1',
        actor_role: 'officer',
        event: 'CLAIM',
        from_status: 'SUBMITTED',
        to_status: 'IN_REVIEW',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: c.approved_at || c.closed_at,
        actor: c.approved_by || 'off.reg1',
        actor_role: c.approved_by === 'head1' ? 'head' : 'officer',
        event: 'APPROVE',
        from_status: c.service_id === 'SV-01' ? 'IN_REVIEW' : 'PENDING_APPROVAL',
        to_status: 'APPROVED',
        detail: '',
      });
      insertEvent.run({
        case_no: caseNo,
        at: c.closed_at,
        actor: c.issuer || 'off.reg1',
        actor_role: 'officer',
        event: 'ISSUE',
        from_status: 'APPROVED',
        to_status: 'COMPLETED',
        detail: c.doc_no || '',
      });
    }
  }

  // 5. Seed Case Return History (§4.4)
  const insertReturn = db.prepare(`
    INSERT INTO case_returns (
      case_no, n, returned_at, returned_by, reason, resubmitted_at, paused_days, due_before, due_after
    ) VALUES (
      @case_no, @n, @returned_at, @returned_by, @reason, @resubmitted_at, @paused_days, @due_before, @due_after
    )
  `);
  for (const r of CASE_RETURNS) {
    insertReturn.run(r);
  }

  // 6. Seed 2 Drafts of Somchai (§4.2) + Pending Payment PP-0001
  const somchaiId = citizenIds.somchai;
  const insertDraft = db.prepare(`
    INSERT INTO drafts (
      id, seq, citizen_id, service_id, status, qty, area_sqm, fee, locked_fee, case_no, created_at, updated_at
    ) VALUES (
      @id, @seq, @citizen_id, @service_id, @status, @qty, @area_sqm, @fee, @locked_fee, @case_no, @created_at, @updated_at
    )
  `);

  // DR-0001: SV-01 DRAFT, qty 2 (฿40), no files attached yet
  insertDraft.run({
    id: 'DR-0001',
    seq: 1,
    citizen_id: somchaiId,
    service_id: 'SV-01',
    status: 'DRAFT',
    qty: 2,
    area_sqm: null,
    fee: 40,
    locked_fee: null,
    case_no: null,
    created_at: '2026-12-01T08:40:00+07:00',
    updated_at: '2026-12-01T08:40:00+07:00',
  });

  // DR-0002: SV-02 PENDING_PAYMENT, ฿500 locked, id-card.pdf + map.pdf attached, QR PP-0001
  insertDraft.run({
    id: 'DR-0002',
    seq: 2,
    citizen_id: somchaiId,
    service_id: 'SV-02',
    status: 'PENDING_PAYMENT',
    qty: null,
    area_sqm: null,
    fee: 500,
    locked_fee: 500,
    case_no: null,
    created_at: '2026-12-01T08:50:00+07:00',
    updated_at: '2026-12-01T08:55:00+07:00',
  });

  addFile({
    draft_id: 'DR-0002',
    case_no: null,
    doc_key: 'id-card',
    name: 'id-card.pdf',
    uploaded_by: somchaiId,
    created_at: '2026-12-01T08:52:00+07:00',
  });
  addFile({
    draft_id: 'DR-0002',
    case_no: null,
    doc_key: 'map',
    name: 'map.pdf',
    uploaded_by: somchaiId,
    created_at: '2026-12-01T08:53:00+07:00',
  });

  const insertPayment = db.prepare(`
    INSERT INTO payments (
      ref, seq, draft_id, citizen_id, amount, status, created_at, expires_at, paid_at, case_no, receipt_no
    ) VALUES (
      @ref, @seq, @draft_id, @citizen_id, @amount, @status, @created_at, @expires_at, @paid_at, @case_no, @receipt_no
    )
  `);
  insertPayment.run({
    ref: 'PP-0001',
    seq: 1,
    draft_id: 'DR-0002',
    citizen_id: somchaiId,
    amount: 500,
    status: 'PENDING',
    created_at: '2026-12-01T08:55:00+07:00',
    expires_at: '2026-12-01T09:10:00+07:00',
    paid_at: null,
    case_no: null,
    receipt_no: null,
  });

  // 7. Seed 1 Issued Document (§5): DOC-2569-000001 for EG-2569-000005
  const doc1 = {
    doc_no: 'DOC-2569-000001',
    year_be: 2569,
    seq: 1,
    case_no: 'EG-2569-000005',
    verify_code: 'K7M2Q9XA',
    applicant: 'สมชาย ใจดี',
    service_id: 'SV-01',
    issued_at: '2026-11-05T10:00:00+07:00',
    valid_until: '2027-02-02',
    signer: 'เจ้าหน้าที่ทะเบียน 1',
    signer_username: 'off.reg1',
    issued_by: 'off.reg1',
  };
  doc1.signature = signDocument(doc1);

  db.prepare(`
    INSERT INTO documents (
      doc_no, year_be, seq, case_no, verify_code, applicant, service_id,
      issued_at, valid_until, signer, signer_username, issued_by, signature
    ) VALUES (
      @doc_no, @year_be, @seq, @case_no, @verify_code, @applicant, @service_id,
      @issued_at, @valid_until, @signer, @signer_username, @issued_by, @signature
    )
  `).run(doc1);

  // 8. Seed Running Number Counters (§12)
  // Next expected: EG-2569-000031, EG-2570-000001, RC-2569-000031, DOC-2569-000002, DR-0003, PP-0002
  for (const k of ['case:2569', 'case_2569', 'EG-2569', 'case']) setSeq(k, 30);
  for (const k of ['case:2570', 'case_2570', 'EG-2570']) setSeq(k, 0);
  for (const k of ['receipt:2569', 'receipt_2569', 'RC-2569', 'receipt']) setSeq(k, 30);
  for (const k of ['receipt:2570', 'receipt_2570', 'RC-2570']) setSeq(k, 0);
  for (const k of ['doc:2569', 'doc_2569', 'document:2569', 'DOC-2569', 'doc']) setSeq(k, 1);
  for (const k of ['doc:2570', 'doc_2570', 'DOC-2570', 'doc:2571', 'doc_2571', 'DOC-2571']) setSeq(k, 0);
  for (const k of ['draft', 'DR']) setSeq(k, 2);
  for (const k of ['payment', 'PP', 'pay']) setSeq(k, 1);
  for (const k of ['file', 'F']) setSeq(k, fileSeq);
}

seed.seed = seed;
seed.run = seed;
seed.default = seed;
seed.makePdfBuffer = makePdfBuffer;

module.exports = seed;
