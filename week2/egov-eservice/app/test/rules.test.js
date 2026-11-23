'use strict';
/**
 * Unit tests for src/lib/rules.js (B03) — run: node --test test/rules.test.js
 * Every example / boundary in DECISIONS §2 §3 §6 §7 §8 §9 §10 (+ §12 §18) and the BUGS.md rows
 * for B01 B03 B04 B05. Bugs are simulated with opts.bugs; a child-process test checks BUG_MODE.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RULES_PATH = path.join(__dirname, '..', 'src', 'lib', 'rules.js');
// tests must not depend on the environment of whoever runs them
delete process.env.BUG_MODE;
const R = require(RULES_PATH);

const HOL = ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']; // DECISIONS §0 seed holidays
const T = (s) => `${s}+07:00`; // '2026-12-01T09:00:00' → ISO +07:00
const OK = { bugs: false };
const B = (...codes) => ({ bugs: codes });

// =========================================================================== §2 identity
test('§2 BR-01 id number: 13 digits + checksum', () => {
  assert.equal(R.isValidIdNo('110170012345'), false, '12 digits');
  assert.equal(R.isValidIdNo('1101700123456'), true, '13 digits valid');
  assert.equal(R.isValidIdNo('11017001234567'), false, '14 digits');
  assert.equal(R.isValidIdNo('1101700123457'), false, 'checksum wrong');
  for (const id of ['1101700123456', '3100600987659', '5500400111221', '1909900555015']) {
    assert.equal(R.isValidIdNo(id), true, `seed ${id}`);
  }
  assert.equal(R.idCheckDigit('110170012345'), 6);
  assert.equal(R.isValidIdNo('1-1017-00123-45-6'), false, 'dashes');
  assert.equal(R.isValidIdNo(' 1101700123456'), false, 'spaces');
  assert.equal(R.isValidIdNo(''), false);
  assert.equal(R.isValidIdNo(null), false);
  assert.equal(R.isValidIdNo(undefined), false);
});

test('§2 BR-02 OTP: 3 consecutive failures lock 15:00 (14:59 locked · 15:00 unlocked)', () => {
  assert.equal(R.OTP_TEST_CODE, '123456');
  let s = R.otpOnFailure(0, T('2026-12-01T09:00:00'));
  assert.deepEqual(s, { fails: 1, locked: false, lockedUntil: null, attemptsLeft: 2 });
  s = R.otpOnFailure(s.fails, T('2026-12-01T09:00:10'));
  assert.deepEqual(s, { fails: 2, locked: false, lockedUntil: null, attemptsLeft: 1 }, '2 failures: can still try');
  s = R.otpOnFailure(s.fails, T('2026-12-01T09:00:20'));
  assert.equal(s.locked, true, '3rd failure locks');
  assert.equal(s.lockedUntil, '2026-12-01T09:15:20+07:00');
  assert.equal(s.fails, 0, 'counter restarts at 0 after unlock');
  assert.equal(R.isOtpLocked(s.lockedUntil, T('2026-12-01T09:15:19')), true, '+14:59 still locked');
  assert.equal(R.isOtpLocked(s.lockedUntil, T('2026-12-01T09:15:20')), false, '+15:00 unlocked');
  assert.equal(R.isOtpLocked(null, T('2026-12-01T09:15:20')), false);
  assert.equal(R.otpAttemptsLeft(0), 3);
  assert.equal(R.otpAttemptsLeft(2), 1);
});

test('§2 BR-03 mobile: 10 digits starting with 0', () => {
  assert.equal(R.isValidMobile('081234567'), false, '9 digits');
  assert.equal(R.isValidMobile('0812345678'), true, '10 digits');
  assert.equal(R.isValidMobile('08123456789'), false, '11 digits');
  assert.equal(R.isValidMobile('1812345678'), false, 'not starting with 0');
  assert.equal(R.isValidMobile(''), false);
  assert.equal(R.isValidMobile(812345678), false);
});

// =============================================================================== §3 fees
test('§3 BR-05 SV-03 fee by area (every boundary) + exact messages', () => {
  const rows = [
    [1, 1000],
    [100, 1000],
    [101, 1010],
    [102, 1020],
    [250, 2500],
    [300, 3000],
    [499, 4990],
    [500, 5000],
  ];
  for (const [area, fee] of rows) {
    assert.deepEqual(R.calcFee('SV-03', { areaSqm: area }, null, OK), { ok: true, fee, areaSqm: area }, `area ${area}`);
  }
  for (const area of [0, -1, 1.5, '', 'abc', null, undefined]) {
    const r = R.calcFee('SV-03', { areaSqm: area }, null, OK);
    assert.equal(r.ok, false, `area ${area}`);
    assert.equal(r.code, 'INVALID_AREA');
    assert.equal(r.status, 400);
    assert.equal(r.message, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.');
  }
  const big = R.calcFee('SV-03', { areaSqm: 501 }, null, OK);
  assert.deepEqual(big, { ok: false, status: 400, code: 'AREA_TOO_LARGE', message: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' });
  assert.equal(R.calcFee('SV-03', { areaSqm: '101' }, null, OK).fee, 1010, 'numeric string from a form');
  assert.equal(R.calcFee('SV-03', { area_sqm: 101 }, null, OK).fee, 1010, 'DB column name');
});

test('§3 BR-04 SV-01 copies 1–5 × ฿20 · SV-02 ฿500', () => {
  const exp = { 1: 20, 2: 40, 3: 60, 4: 80, 5: 100 };
  for (const [q, fee] of Object.entries(exp)) {
    assert.deepEqual(R.calcFee('SV-01', { qty: Number(q) }, null, OK), { ok: true, fee, qty: Number(q) });
  }
  for (const q of [0, 6, -1, 2.5, '', 'x']) {
    assert.deepEqual(R.calcFee('SV-01', { qty: q }, null, OK), { ok: false, status: 400, code: 'INVALID_QTY', message: 'จำนวนฉบับต้อง 1–5 ฉบับ' }, `qty ${q}`);
  }
  assert.equal(R.calcFee('SV-01', {}, null, OK).fee, 20, 'A-56 default 1 copy');
  assert.deepEqual(R.calcFee('SV-02', {}, null, OK), { ok: true, fee: 500 });
  assert.equal(R.calcFee('SV-09', {}).ok, false);
});

test('§3/§18 fees follow the services table (admin edits)', () => {
  assert.equal(R.calcFee('SV-01', { qty: 2 }, { fee: 25 }, OK).fee, 50);
  assert.equal(R.calcFee('SV-02', {}, { fee: 600 }, OK).fee, 600);
  assert.equal(R.calcFee('SV-03', { areaSqm: 101 }, { fee: 1200, fee_per_sqm: 20 }, OK).fee, 1220);
  assert.equal(R.calcFee('SV-03', { areaSqm: 150 }, { feeBase: 1000, feePerSqm: 10 }, OK).fee, 1500);
  assert.equal(R.calcFee('SV-01', { qty: 1 }, { fee: 0 }, OK).fee, 0, 'fee 0 allowed');
});

test('BUG B01: area 101 charged ฿1,000; 100/102/500 unchanged', () => {
  assert.equal(R.calcFee('SV-03', { areaSqm: 101 }, null, B('B01')).fee, 1000);
  assert.equal(R.calcFee('SV-03', { areaSqm: 102 }, null, B('B01')).fee, 1020);
  assert.equal(R.calcFee('SV-03', { areaSqm: 100 }, null, B('B01')).fee, 1000);
  assert.equal(R.calcFee('SV-03', { areaSqm: 500 }, null, B('B01')).fee, 5000);
  assert.equal(R.calcFee('SV-03', { areaSqm: 501 }, null, B('B01')).code, 'AREA_TOO_LARGE');
  assert.equal(R.calcFee('SV-03', { areaSqm: 101 }, null, B('B03', 'B05')).fee, 1010, 'other bugs do not leak into fees');
});

test('§18 BR-28 admin ranges: fee 0–100,000 · SLA 1–60', () => {
  assert.equal(R.validateAdminFee(-1).code, 'INVALID_FEE');
  assert.deepEqual(R.validateAdminFee(0), { ok: true, value: 0 });
  assert.deepEqual(R.validateAdminFee(100000), { ok: true, value: 100000 });
  assert.equal(R.validateAdminFee(100001).code, 'INVALID_FEE');
  assert.equal(R.validateAdminFee(25.5).ok, false);
  assert.equal(R.validateAdminFee('').ok, false);
  assert.equal(R.validateAdminFee(-1).message, 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท');
  assert.equal(R.validateAdminSla(0).code, 'INVALID_SLA');
  assert.deepEqual(R.validateAdminSla(1), { ok: true, value: 1 });
  assert.deepEqual(R.validateAdminSla(60), { ok: true, value: 60 });
  assert.equal(R.validateAdminSla(61).code, 'INVALID_SLA');
  assert.equal(R.validateAdminSla(61).message, 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ');
});

// ============================================================================= §4 files
test('§4 BR-06/07 file size ≤ 5,242,880 · max 5 files · magic bytes', () => {
  assert.equal(R.FILE_MAX_BYTES, 5242880);
  assert.equal(R.fileSizeOk(5242879), true);
  assert.equal(R.fileSizeOk(5242880), true);
  assert.equal(R.fileSizeOk(5242881), false);
  assert.equal(R.canAddFile(4), true, '5th file');
  assert.equal(R.canAddFile(5), false, '6th file');
  assert.equal(R.detectFileType(Buffer.from('%PDF-1.4')), 'application/pdf');
  assert.equal(R.detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(R.detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png');
  assert.equal(R.detectFileType(Buffer.from('hello world')), null, '.txt renamed .pdf');
  assert.equal(R.detectFileType(Buffer.from('MZ\x90\x00')), null, '.exe renamed .png');
  assert.equal(R.detectFileType(Buffer.alloc(0)), null);
});

// =================================================================== §6 running numbers
test('§6 BR-09 case number EG-<B.E. of payment>-<6 digits>, yearly restart', () => {
  assert.equal(R.caseYearBE(T('2026-12-31T23:59:00')), 2569);
  assert.equal(R.caseYearBE(T('2026-12-31T23:59:59')), 2569);
  assert.equal(R.caseYearBE(T('2027-01-01T00:00:00')), 2570);
  assert.equal(R.caseYearBE('2026-12-31T16:59:59Z'), 2569, '23:59:59 Bangkok given in UTC');
  assert.equal(R.caseYearBE('2026-12-31T17:00:00Z'), 2570, '00:00 Bangkok given in UTC');
  assert.equal(R.formatCaseNo(2569, 1), 'EG-2569-000001');
  assert.equal(R.formatCaseNo(2569, 31), 'EG-2569-000031');
  assert.equal(R.formatCaseNo(2570, 1), 'EG-2570-000001');
  assert.equal(R.formatReceiptNo(2569, 31), 'RC-2569-000031');
  assert.equal(R.formatDocNo(2569, 2), 'DOC-2569-000002');
  assert.equal(R.formatDocNo(2571, 1), 'DOC-2571-000001');
  assert.equal(R.receiptNoForCase('EG-2569-000031'), 'RC-2569-000031');
  assert.equal(R.seqKey('case', T('2026-12-31T23:59:00')), 'case:2569');
  assert.equal(R.seqKey('case', T('2027-01-01T00:00:00')), 'case:2570');
  assert.equal(R.seqKey('doc', T('2028-02-29T10:00:00')), 'doc:2571');
  assert.deepEqual(R.parseRunningNo('EG-2569-000031'), { prefix: 'EG', yearBE: 2569, seq: 31 });
  assert.equal(R.parseRunningNo('EG-2569-31'), null);
  assert.equal(R.isCaseNo('EG-2569-000031'), true);
  assert.equal(R.isCaseNo('DOC-2569-000001'), false);
  assert.throws(() => R.formatCaseNo(2569, 0));
  assert.throws(() => R.formatCaseNo(2569, 1000000));
});

// ============================================================================ §7 payment
test('§7 BR-10 QR age < 15:00 (PP-0001 created 08:55:00)', () => {
  const created = T('2026-12-01T08:55:00');
  assert.equal(R.qrExpiresAt(created), '2026-12-01T09:10:00+07:00');
  assert.equal(R.qrExpiresAt(T('2026-12-01T09:10:00')), '2026-12-01T09:25:00+07:00', 'PP-0002 regenerated');
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:00:00'), OK), false, '5:00');
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:09:59'), OK), false, '14:59 ✓');
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:10:00'), OK), true, '15:00 ✗');
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:10:01'), OK), true, '15:01 ✗');
  assert.equal(R.paymentStatus({ status: 'PENDING', created_at: created }, T('2026-12-01T09:10:00'), OK), 'EXPIRED');
  assert.equal(R.paymentStatus({ status: 'PENDING', created_at: created }, T('2026-12-01T09:09:59'), OK), 'PENDING');
  assert.equal(R.paymentStatus({ status: 'PAID', created_at: created }, T('2026-12-01T10:00:00'), OK), 'PAID');
});

test('BUG B05: QR aged exactly 15:00 still payable, 15:01 expired', () => {
  const created = T('2026-12-01T08:55:00');
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:10:00'), B('B05')), false);
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:10:01'), B('B05')), true);
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:09:59'), B('B05')), false);
  assert.equal(R.isQrExpired(created, T('2026-12-01T09:10:00'), B('B01', 'B03', 'B04')), true, 'other bugs do not leak');
});

test('§7 BR-11 amount must equal the fee exactly', () => {
  assert.equal(R.amountMatches(19, 20), false, 'short ฿1');
  assert.equal(R.amountMatches(21, 20), false, 'over ฿1');
  assert.equal(R.amountMatches(20, 20), true);
  assert.equal(R.amountMatches(499, 500), false);
  assert.equal(R.amountMatches(500, 500), true);
  assert.equal(R.amountMatches(600, 500), false, 'fee locked at PENDING_PAYMENT');
  assert.equal(R.amountMatches(20.5, 20), false);
  assert.equal(R.amountMatches(undefined, 20), false);
});

// ================================================================================ §8 SLA
test('§0 business days: Mon–Fri minus seed holidays', () => {
  assert.equal(R.isBusinessDay('2026-12-01', HOL, OK), true, 'Tue');
  assert.equal(R.isBusinessDay('2026-12-05', HOL, OK), false, 'Sat');
  assert.equal(R.isBusinessDay('2026-12-06', HOL, OK), false, 'Sun');
  for (const h of HOL) assert.equal(R.isBusinessDay(h, HOL, OK), false, h);
  assert.equal(R.nextBusinessDay('2026-12-04', HOL, OK), '2026-12-08');
  assert.equal(R.addBusinessDays('2026-12-01', 0, HOL, OK), '2026-12-01');
  assert.equal(R.countBusinessDays('2026-12-01', '2026-12-04', HOL, OK), 3);
  assert.equal(R.countBusinessDays('2026-12-04', '2026-12-01', HOL, OK), 0);
  // holiday argument forms
  assert.equal(R.isBusinessDay('2026-12-07', HOL.map((date) => ({ date })), OK), false, 'rows {date}');
  assert.equal(R.isBusinessDay('2026-12-07', new Set(HOL), OK), false, 'Set');
  assert.equal(R.isBusinessDay('2026-12-07', (d) => HOL.includes(d), OK), false, 'function');
  assert.equal(R.isBusinessDay('2026-12-07', [], OK), true, 'no holidays');
  assert.throws(() => R.computeDueAt(T('2026-12-01T09:00:00'), 3), /holidays required/);
});

test('§8 DECISIONS table + TC-SLA-01 rows a–i (due date)', () => {
  const rows = [
    // [paidAt, sla, due]
    ['2026-12-01T09:00:00', 3, '2026-12-04T16:30:00+07:00'], // a / row 1
    ['2026-12-01T16:29:00', 3, '2026-12-04T16:30:00+07:00'], // b / row 2
    ['2026-12-01T16:29:59', 3, '2026-12-04T16:30:00+07:00'], // BR-12 second boundary
    ['2026-12-01T16:30:00', 3, '2026-12-08T16:30:00+07:00'], // c / row 3
    ['2026-12-04T10:00:00', 3, '2026-12-11T16:30:00+07:00'], // d / row 4
    ['2026-12-05T10:00:00', 3, '2026-12-14T16:30:00+07:00'], // e / row 5
    ['2026-12-01T09:00:00', 10, '2026-12-17T16:30:00+07:00'], // f SV-02
    ['2026-12-01T09:00:00', 15, '2026-12-24T16:30:00+07:00'], // g SV-03
    ['2026-12-29T10:00:00', 3, '2027-01-05T16:30:00+07:00'], // h across the year
    ['2026-12-31T23:59:00', 3, '2027-01-07T16:30:00+07:00'], // i across the year
  ];
  for (const [paid, sla, due] of rows) {
    assert.equal(R.computeDueAt(T(paid), sla, HOL, OK), due, `paid ${paid} SLA ${sla}`);
  }
  assert.equal(R.slaStartDate(T('2026-12-01T16:30:00'), HOL, OK), '2026-12-02', 'D0 after cut-off');
  assert.equal(R.slaStartDate(T('2026-12-05T10:00:00'), HOL, OK), '2026-12-08', 'D0 Sat → Tue (Mon 7 holiday)');
  assert.equal(R.slaStartDate(T('2026-12-31T23:59:00'), HOL, OK), '2027-01-04', 'D0 Thu 31 holiday → Mon 4');
  assert.equal(R.slaStartDate(T('2026-12-07T09:00:00'), HOL, OK), '2026-12-08', 'D0 on a holiday before cut-off');
  assert.equal(R.computeDueAt(new Date('2026-12-01T02:00:00Z'), 3, HOL, OK), '2026-12-04T16:30:00+07:00', 'Date input');
});

test('BUG B03: holidays ignored (Sat/Sun only) — BUGS.md values', () => {
  const b = B('B03');
  assert.equal(R.computeDueAt(T('2026-12-01T16:30:00'), 3, HOL, b), '2026-12-07T16:30:00+07:00');
  assert.equal(R.computeDueAt(T('2026-12-04T10:00:00'), 3, HOL, b), '2026-12-09T16:30:00+07:00');
  assert.equal(R.computeDueAt(T('2026-12-05T10:00:00'), 3, HOL, b), '2026-12-10T16:30:00+07:00');
  assert.equal(R.computeDueAt(T('2026-12-29T10:00:00'), 3, HOL, b), '2027-01-01T16:30:00+07:00');
  assert.equal(R.computeDueAt(T('2026-12-31T23:59:00'), 3, HOL, b), '2027-01-06T16:30:00+07:00');
  // rows unaffected by holidays stay correct
  assert.equal(R.computeDueAt(T('2026-12-01T09:00:00'), 3, HOL, b), '2026-12-04T16:30:00+07:00');
  // pause row 6 → 7 Dec instead of 8 Dec
  const ext = R.extendDueAt(T('2026-12-04T16:30:00'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL, b);
  assert.equal(ext.dueAt, '2026-12-07T16:30:00+07:00');
  // same calendar used for remaining days: due Tue 8, Fri 4 09:00 → 2 (Mon 7 counted) → normal
  assert.equal(R.remainingBusinessDays(T('2026-12-04T09:00:00'), T('2026-12-08T16:30:00'), HOL, b), 2);
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: T('2026-12-08T16:30:00') }, T('2026-12-04T09:00:00'), HOL, b), 'normal');
  // B04/B05/B01 do not change the calendar
  assert.equal(R.computeDueAt(T('2026-12-01T16:30:00'), 3, HOL, B('B01', 'B04', 'B05')), '2026-12-08T16:30:00+07:00');
});

test('§8 BR-13 pause while NEED_FIX (DECISIONS row 6 + TC-SLA-02 parts 1–5)', () => {
  // part 1 / row 6: paid Tue 1 09:00 (due Fri 4) · returned Wed 2 11:00 · resubmitted Thu 3 10:00
  let r = R.extendDueAt(T('2026-12-04T16:30:00'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL, OK);
  assert.deepEqual(r, { dueAt: '2026-12-08T16:30:00+07:00', pausedDays: 1 });
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: r.dueAt }, T('2026-12-03T10:00:00'), HOL, OK), 'normal', 'Fri 4 + Tue 8 = 2');
  assert.equal(R.fixDeadline(T('2026-12-02T11:00:00')), '2026-12-09T11:00:00+07:00');
  // part 2: seed …000017 due 27 Nov · returned 27 Nov 14:00 · resubmitted 1 Dec 09:00
  r = R.extendDueAt(T('2026-11-27T16:30:00'), T('2026-11-27T14:00:00'), T('2026-12-01T09:00:00'), HOL, OK);
  assert.deepEqual(r, { dueAt: '2026-12-01T16:30:00+07:00', pausedDays: 2 });
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: r.dueAt }, T('2026-12-01T09:00:00'), HOL, OK), 'near');
  assert.equal(R.remainingBusinessDays(T('2026-12-01T09:00:00'), r.dueAt, HOL, OK), 0);
  // part 3: same case resubmitted Fri 4 10:00 → 5 days (30 Nov, 1, 2, 3, 4)
  r = R.extendDueAt(T('2026-11-27T16:30:00'), T('2026-11-27T14:00:00'), T('2026-12-04T10:00:00'), HOL, OK);
  assert.deepEqual(r, { dueAt: '2026-12-04T16:30:00+07:00', pausedDays: 5 });
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: r.dueAt }, T('2026-12-04T10:00:00'), HOL, OK), 'near');
  // part 4: returned and resubmitted the same day → 0
  r = R.extendDueAt(T('2026-12-04T16:30:00'), T('2026-12-02T09:00:00'), T('2026-12-02T15:00:00'), HOL, OK);
  assert.deepEqual(r, { dueAt: '2026-12-04T16:30:00+07:00', pausedDays: 0 });
  // part 5: returned Fri 4 10:00 · resubmitted Tue 8 17:00 → 1 day (Tue 8) → due Tue 8 16:30 → overdue
  r = R.extendDueAt(T('2026-12-04T16:30:00'), T('2026-12-04T10:00:00'), T('2026-12-08T17:00:00'), HOL, OK);
  assert.deepEqual(r, { dueAt: '2026-12-08T16:30:00+07:00', pausedDays: 1 });
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: r.dueAt }, T('2026-12-08T17:00:00'), HOL, OK), 'overdue');
  assert.equal(R.pausedBusinessDays(T('2026-12-04T10:00:00'), T('2026-12-08T17:00:00'), HOL, OK), 1);
});

test('BUG B04: no pause while NEED_FIX — BUGS.md values', () => {
  const b = B('B04');
  let r = R.extendDueAt(T('2026-12-04T16:30:00'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL, b);
  assert.deepEqual(r, { dueAt: '2026-12-04T16:30:00+07:00', pausedDays: 0 });
  r = R.extendDueAt(T('2026-11-27T16:30:00'), T('2026-11-27T14:00:00'), T('2026-12-01T09:00:00'), HOL, b);
  assert.equal(r.dueAt, '2026-11-27T16:30:00+07:00');
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: r.dueAt }, T('2026-12-01T09:00:00'), HOL, b), 'overdue');
  // B04 leaves the due-date calculation itself alone
  assert.equal(R.computeDueAt(T('2026-12-01T16:30:00'), 3, HOL, b), '2026-12-08T16:30:00+07:00');
  // B03+B04 together = union (no pause, so the B03 calendar has nothing to shift)
  r = R.extendDueAt(T('2026-12-04T16:30:00'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), HOL, B('B03', 'B04'));
  assert.equal(r.dueAt, '2026-12-04T16:30:00+07:00');
});

test('§8 BR-14 level + remaining days (due Fri 4 Dec 16:30 · TC-SLA-03 part A)', () => {
  const c = { status: 'IN_REVIEW', dueAt: T('2026-12-04T16:30:00') };
  const rows = [
    ['2026-12-01T09:00:00', 3, 'normal'],
    ['2026-12-02T09:00:00', 2, 'normal'],
    ['2026-12-03T09:00:00', 1, 'near'],
    ['2026-12-04T16:30:00', 0, 'near'],
    ['2026-12-04T16:30:01', null, 'overdue'],
    ['2026-12-04T16:31:00', null, 'overdue'],
    ['2026-12-05T10:00:00', null, 'overdue'],
  ];
  for (const [now, remaining, level] of rows) {
    assert.equal(R.slaLevel(c, T(now), HOL, OK), level, `level at ${now}`);
    if (remaining !== null) assert.equal(R.remainingBusinessDays(T(now), c.dueAt, HOL, OK), remaining, `remaining at ${now}`);
  }
  assert.deepEqual(R.slaInfo(c, T('2026-12-01T09:00:00'), HOL, OK), { level: 'normal', remaining: 3 });
  assert.deepEqual(R.slaInfo(c, T('2026-12-05T10:00:00'), HOL, OK), { level: 'overdue', remaining: 0 });
  assert.deepEqual(R.slaInfo({ status: 'NEED_FIX', dueAt: c.dueAt }, T('2026-12-01T09:00:00'), HOL, OK), { level: 'paused', remaining: null });
});

test('§8 BR-14 level across weekend + holiday (seed …000016 due Tue 8 Dec · part B)', () => {
  const c = { status: 'IN_REVIEW', due_at: T('2026-12-08T16:30:00') };
  assert.equal(R.remainingBusinessDays(T('2026-12-03T09:00:00'), c.due_at, HOL, OK), 2);
  assert.equal(R.slaLevel(c, T('2026-12-03T09:00:00'), HOL, OK), 'normal');
  assert.equal(R.remainingBusinessDays(T('2026-12-04T09:00:00'), c.due_at, HOL, OK), 1);
  assert.equal(R.slaLevel(c, T('2026-12-04T09:00:00'), HOL, OK), 'near');
  assert.equal(R.slaLevel(c, T('2026-12-08T16:30:00'), HOL, OK), 'near');
  assert.equal(R.slaLevel(c, T('2026-12-08T16:31:00'), HOL, OK), 'overdue');
});

test('§8 levels of seed cases at reset 09:00 (part C) + paused/closed', () => {
  const now = T('2026-12-01T09:00:00');
  const lv = (status, due, at = now) => R.slaLevel({ status, dueAt: due && T(due) }, at, HOL, OK);
  assert.equal(lv('IN_REVIEW', '2026-11-30T16:30:00'), 'overdue', '…000020');
  assert.equal(lv('IN_REVIEW', '2026-12-01T16:30:00'), 'near', '…000022 remaining 0');
  assert.equal(lv('SUBMITTED', '2026-12-02T16:30:00'), 'near', '…000024 remaining 1');
  assert.equal(lv('IN_REVIEW', '2026-12-03T16:30:00'), 'normal', '…000025 remaining 2');
  assert.equal(lv('PENDING_APPROVAL', '2026-12-03T16:30:00'), 'normal');
  assert.equal(lv('APPROVED', '2026-11-30T16:30:00'), 'overdue');
  assert.equal(lv('NEED_FIX', '2026-11-27T16:30:00'), 'paused', '…000017');
  for (const s of ['COMPLETED', 'REJECTED', 'CANCELLED']) assert.equal(lv(s, '2026-11-30T16:30:00'), 'closed', s);
  assert.equal(lv('IN_REVIEW', '2026-12-01T16:30:00', T('2026-12-01T16:30:00')), 'near');
  assert.equal(lv('IN_REVIEW', '2026-12-01T16:30:00', T('2026-12-01T16:31:00')), 'overdue');
  assert.equal(lv('DRAFT', null), null);
  assert.equal(lv('PENDING_PAYMENT', null), null);
  // closed/paused need no calendar
  assert.equal(R.slaLevel({ status: 'COMPLETED' }, now), 'closed');
  assert.equal(R.slaLevel({ status: 'NEED_FIX' }, now), 'paused');
});

test('§8/§18 on time ⇔ closed_at ≤ due (16:29:59 ✓ · 16:30:00 ✓ · 16:30:01 ✗)', () => {
  const due = T('2026-12-03T16:30:00');
  assert.equal(R.isOnTime(T('2026-12-03T16:29:00'), due), true);
  assert.equal(R.isOnTime(T('2026-12-03T16:29:59'), due), true);
  assert.equal(R.isOnTime(T('2026-12-03T16:30:00'), due), true);
  assert.equal(R.isOnTime(T('2026-12-03T16:30:01'), due), false);
  assert.equal(R.isOnTime(T('2026-12-03T16:31:00'), due), false);
});

// ============================================================================= §9 queue
test('§9 BR-16 queue order: earliest due, then case number', () => {
  const rows = [
    { caseNo: 'EG-2569-000027', dueAt: T('2026-12-04T16:30:00') },
    { caseNo: 'EG-2569-000025', dueAt: T('2026-12-03T16:30:00') },
    { caseNo: 'EG-2569-000013', dueAt: T('2026-12-04T16:30:00') },
    { case_no: 'EG-2569-000015', due_at: T('2026-12-04T16:30:00') },
    { caseNo: 'EG-2569-000020', dueAt: T('2026-11-30T16:30:00') },
    { caseNo: 'EG-2569-000028', dueAt: T('2026-12-04T16:30:00') },
  ];
  const order = rows.sort(R.compareQueue).map((r) => r.caseNo || r.case_no);
  assert.deepEqual(order, ['EG-2569-000020', 'EG-2569-000025', 'EG-2569-000013', 'EG-2569-000015', 'EG-2569-000027', 'EG-2569-000028']);
  assert.ok(R.compareCaseNo('EG-2569-000031', 'EG-2570-000001') < 0, 'year first');
});

test('§9 BR-18/19 workload 10 · returns 2 · reason ≥ 10 chars', () => {
  assert.equal(R.canClaim(9), true, 'holding 9 → may claim the 10th');
  assert.equal(R.canClaim(10), false, 'holding 10 → 11th refused');
  assert.equal(R.canClaim(11), false, 'over the cap after a resubmission');
  assert.equal(R.canReturn(0), true, '1st return');
  assert.equal(R.canReturn(1), true, '2nd return');
  assert.equal(R.canReturn(2), false, '3rd return');
  assert.equal(R.isReasonValid('x'.repeat(9)), false, '9 chars');
  assert.equal(R.isReasonValid('xxxxxxxxxx'), true, '10 chars');
  assert.equal(R.isReasonValid(' '.repeat(10)), false, '10 spaces');
  assert.equal(R.isReasonValid('  ' + 'x'.repeat(9) + '  '), false, 'trimmed to 9');
  assert.equal(R.isReasonValid('เอกสารไม่ชัดเจน'), true, 'Thai');
  assert.equal(R.isReasonValid(undefined), false);
  assert.equal(R.MESSAGES.REASON_TOO_SHORT, 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร');
});

test('§9 BR-20 fix window 168 h (167:59 ✓ · 168:00 cancelled)', () => {
  const returned = T('2026-11-27T14:00:00');
  assert.equal(R.fixDeadline(returned), '2026-12-04T14:00:00+07:00');
  assert.equal(R.isFixWindowExpired(returned, T('2026-12-04T13:59:00')), false);
  assert.equal(R.isFixWindowExpired(returned, T('2026-12-04T13:59:59')), false);
  assert.equal(R.isFixWindowExpired(returned, T('2026-12-04T14:00:00')), true);
  assert.equal(R.isFixWindowExpired(T('2026-12-04T10:00:00'), T('2026-12-08T17:00:00')), false, 'TC-SLA-02 part 5');
});

// ========================================================================= §10 documents
test('§10 BR-23 document validity + expiry boundary', () => {
  // SV-01 90 days
  assert.equal(R.docValidUntil(T('2026-12-01T10:00:00'), 'SV-01'), '2027-02-28');
  assert.equal(R.isDocExpired('2027-02-28', T('2027-02-28T23:59:00')), false);
  assert.equal(R.isDocExpired('2027-02-28', T('2027-03-01T00:00:00')), true);
  // SV-02/03 1 year
  assert.equal(R.docValidUntil(T('2026-12-01T10:00:00'), 'SV-02'), '2027-11-30');
  assert.equal(R.docValidUntil(T('2026-12-01T10:00:00'), 'SV-03'), '2027-11-30');
  assert.equal(R.isDocExpired('2027-11-30', T('2027-11-30T23:59:00')), false);
  assert.equal(R.isDocExpired('2027-11-30', T('2027-12-01T00:00:00')), true);
  // seed K7M2Q9XA issued 5 Nov 2026 → 2 Feb 2027
  assert.equal(R.docValidUntil(T('2026-11-05T10:00:00'), 'SV-01'), '2027-02-02');
  assert.equal(R.isDocExpired('2027-02-02', T('2027-02-02T23:59:00')), false);
  assert.equal(R.isDocExpired('2027-02-02', T('2027-02-03T00:00:00')), true);
  // 29 Feb 2028 (A-61)
  assert.equal(R.docValidUntil(T('2028-02-29T10:00:00'), 'SV-01'), '2028-05-28');
  assert.equal(R.docValidUntil(T('2028-02-29T10:00:00'), 'SV-02'), '2029-02-27');
  assert.equal(R.isDocExpired('2028-05-28', T('2028-05-28T23:59:00')), false);
  assert.equal(R.isDocExpired('2028-05-28', T('2028-05-29T00:00:00')), true);
  assert.equal(R.isDocExpired('2029-02-27', T('2029-02-27T23:59:00')), false);
  assert.equal(R.isDocExpired('2029-02-27', T('2029-02-28T00:00:00')), true);
  // validity codes from the services table
  assert.equal(R.docValidUntil('2026-12-01', '90d'), '2027-02-28');
  assert.equal(R.docValidUntil('2026-12-01', '1y'), '2027-11-30');
  assert.throws(() => R.docValidUntil('2026-12-01', 'forever'));
});

test('§10 A-43 verify result order: NOT_FOUND · TAMPERED (even if expired) · EXPIRED · VALID', () => {
  const vu = '2027-02-02';
  assert.equal(R.verifyResult(null, T('2026-12-01T09:00:00')), 'NOT_FOUND');
  assert.equal(R.verifyResult({ found: false }, T('2026-12-01T09:00:00')), 'NOT_FOUND');
  assert.equal(R.verifyResult({ signatureOk: true, validUntil: vu }, T('2026-12-01T09:00:00')), 'VALID');
  assert.equal(R.verifyResult({ signatureOk: true, valid_until: vu }, T('2027-02-03T00:00:00')), 'EXPIRED');
  assert.equal(R.verifyResult({ signatureOk: false, validUntil: vu }, T('2026-12-01T09:00:00')), 'TAMPERED');
  assert.equal(R.verifyResult({ signatureOk: false, validUntil: vu }, T('2027-03-01T00:00:00')), 'TAMPERED');
});

// ========================================================================= §12 dashboard
test('§12 BR-25/26 on-time % half-up · 0 closed → –', () => {
  assert.equal(R.ontimePct(6, 7), 85.7);
  assert.equal(R.ontimePct(2, 3), 66.7);
  assert.equal(R.ontimePct(1, 1), 100);
  assert.equal(R.ontimePct(7, 8), 87.5, 'year from totals');
  assert.equal(R.ontimePct(0, 0), null);
  assert.equal(R.ontimePct(1, 8), 12.5);
  assert.equal(R.ontimePct(1, 16), 6.3, '6.25 rounds half-up');
  assert.equal(R.formatPct(R.ontimePct(6, 7)), '85.7%');
  assert.equal(R.formatPct(R.ontimePct(1, 1)), '100.0%');
  assert.equal(R.formatPct(R.ontimePct(0, 0)), '–');
  // B10 (dashboard divides by received) — same helper, wrong denominator
  assert.equal(R.formatPct(R.ontimePct(6, 26)), '23.1%');
  assert.equal(R.formatPct(R.ontimePct(7, 30)), '23.3%');
  assert.equal(R.formatPct(R.ontimePct(0, 3)), '0.0%');
});

// ==================================================================== BUG_MODE via env
function runWithEnv(bugMode) {
  const script = `
    const R = require(${JSON.stringify(RULES_PATH)});
    const H = ${JSON.stringify(HOL)};
    console.log(JSON.stringify({
      fee101: R.calcFee('SV-03', { areaSqm: 101 }).fee,
      due: R.computeDueAt('2026-12-01T16:30:00+07:00', 3, H),
      ext: R.extendDueAt('2026-12-04T16:30:00+07:00', '2026-12-02T11:00:00+07:00', '2026-12-03T10:00:00+07:00', H).dueAt,
      qr: R.isQrExpired('2026-12-01T08:55:00+07:00', '2026-12-01T09:10:00+07:00'),
      seedSafe: R.computeDueAt('2026-12-01T16:30:00+07:00', 3, H, { bugs: false }),
    }));`;
  const env = { ...process.env };
  delete env.BUG_MODE;
  if (bugMode !== null) env.BUG_MODE = bugMode;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}

test('BUG_MODE env: unset = correct · B01,B03,B04,B05 each flip only their rule', () => {
  assert.deepEqual(runWithEnv(null), {
    fee101: 1010,
    due: '2026-12-08T16:30:00+07:00',
    ext: '2026-12-08T16:30:00+07:00',
    qr: true,
    seedSafe: '2026-12-08T16:30:00+07:00',
  });
  assert.deepEqual(runWithEnv(''), runWithEnv(null), 'empty BUG_MODE = correct');
  assert.equal(runWithEnv('B01').fee101, 1000);
  assert.equal(runWithEnv('B01').due, '2026-12-08T16:30:00+07:00');
  assert.equal(runWithEnv('B03').due, '2026-12-07T16:30:00+07:00');
  assert.equal(runWithEnv('B03').ext, '2026-12-07T16:30:00+07:00');
  assert.equal(runWithEnv('B03').fee101, 1010);
  assert.equal(runWithEnv('B04').ext, '2026-12-04T16:30:00+07:00');
  assert.equal(runWithEnv('B04').due, '2026-12-08T16:30:00+07:00');
  assert.equal(runWithEnv('B05').qr, false);
  assert.equal(runWithEnv('B05').fee101, 1010);
  const all = runWithEnv('B01, B03,B04 ,B05,B07');
  assert.deepEqual(all, {
    fee101: 1000,
    due: '2026-12-07T16:30:00+07:00',
    ext: '2026-12-04T16:30:00+07:00',
    qr: false,
    seedSafe: '2026-12-08T16:30:00+07:00',
  });
});
