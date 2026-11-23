import { expect, Page, test } from '@playwright/test';
import {
  CLOCK,
  ensureTestFiles,
  getTestFilePath,
  getTestFilePayload,
  LOGIN_C,
  LOGIN_S,
  NEW_PAID,
  RESET,
} from './helpers';

test.beforeAll(() => {
  ensureTestFiles();
});

async function returnCaseViaUi(page: Page, reason: string) {
  const reasonInput = page.getByTestId('return-reason');
  if (!(await reasonInput.isVisible())) {
    await page.getByTestId('return-btn').click();
  }
  await expect(reasonInput).toBeVisible();
  await reasonInput.fill(reason);
  const submitBtn = page.getByTestId('return-submit');
  if (await submitBtn.isVisible()) {
    await submitBtn.click();
  } else {
    await page.getByTestId('return-btn').click();
  }
}

test('TC-AUTH-01 · เลขบัตร 13 หลัก + checksum', async ({ page }) => {
  await RESET(page);
  await page.goto('/login');
  const citizenTab = page.getByTestId('login-tab-citizen');
  if ((await citizenTab.count()) > 0) {
    await citizenTab.click();
  }

  const invalidCases = [
    '110170012345',   // 12 หลัก (ต่ำกว่าขอบ)
    '11017001234567', // 14 หลัก (เกินขอบ)
    '1101700123457',  // 13 หลัก checksum ผิด
    '11017001234ab',  // ไม่ใช่ตัวเลขล้วน
  ];

  for (const idNo of invalidCases) {
    await page.getByTestId('thaid-id-input').fill(idNo);
    if (idNo === '11017001234567') {
      await expect(page.getByTestId('thaid-id-input')).toHaveValue('11017001234567');
    }
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('thaid-error')).toHaveText('เลขบัตรประชาชนไม่ถูกต้อง');
    await expect(page.getByTestId('otp-step')).toBeHidden();

    const apiRes = await page.request.post('/api/auth/thaid/start', { data: { idNo } });
    expect(apiRes.status()).toBe(400);
    const body = await apiRes.json();
    expect(body.code).toBe('INVALID_ID');
    expect(body.message).toBe('เลขบัตรประชาชนไม่ถูกต้อง');
  }

  const validIds = ['1101700123456', '3100600987659', '1909900555015', '5500400111221'];
  for (const idNo of validIds) {
    await page.goto('/login');
    await page.getByTestId('thaid-id-input').fill(idNo);
    await page.getByTestId('thaid-submit').click();
    await expect(page.getByTestId('otp-step')).toBeVisible();
    await expect(page.getByTestId('thaid-error')).toBeHidden();

    const apiRes = await page.request.post('/api/auth/thaid/start', { data: { idNo } });
    expect(apiRes.status()).toBe(200);
    const body = await apiRes.json();
    expect(body.status).toBe('OTP_SENT');
  }
});

test('TC-AUTH-02 · OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ page, browser }) => {
  await RESET(page);
  const piti = '1909900555015';

  await page.goto('/login');
  await page.getByTestId('thaid-id-input').fill(piti);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();

  // 1: verify OTP 000000 ครั้งที่ 1
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');

  // 2: verify OTP 000000 ครั้งที่ 2
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');

  // 3: verify OTP 000000 ครั้งที่ 3 → 423 LOCKED
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
  await expect(page.getByTestId('lock-until')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');

  // 4: OTP ถูก 123456 ทันที → ยัง 423
  const res4 = await page.request.post('/api/auth/thaid/verify', {
    data: { idNo: piti, otp: '123456' },
  });
  expect(res4.status()).toBe(423);
  const body4 = await res4.json();
  expect(body4.code).toBe('LOCKED');

  // 5: สมชาย 1101700123456 ล็อกอินปกติระหว่างที่ปิติถูกล็อก → สำเร็จ
  const somchaiCtx = await browser.newContext();
  await LOGIN_C(somchaiCtx, '1101700123456');
  await somchaiCtx.close();

  // 6: CLOCK(2026-12-01T09:14:59+07:00) แล้วปิติ OTP 123456 → ยัง 423
  await CLOCK(page, '2026-12-01T09:14:59+07:00');
  const res6 = await page.request.post('/api/auth/thaid/verify', {
    data: { idNo: piti, otp: '123456' },
  });
  expect(res6.status()).toBe(423);

  // 7: CLOCK(2026-12-01T09:15:00+07:00) แล้วปิติ OTP 000000 → ปลดล็อกแล้ว 401 เหลือ 2 ครั้ง
  await CLOCK(page, '2026-12-01T09:15:00+07:00');
  await page.goto('/login');
  await page.getByTestId('thaid-id-input').fill(piti);
  await page.getByTestId('thaid-submit').click();
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');

  // 8: ปิติ OTP 123456 → 200 ล็อกอินสำเร็จ
  await page.getByTestId('otp-input').fill('123456');
  await page.getByTestId('otp-submit').click();
  await expect(page).toHaveURL(/\/citizen/);

  // 9: RESET · ปิติ ผิด 2 ครั้ง → OTP ถูก (200) → ออกจากระบบ → ผิดอีก 2 ครั้ง → ไม่ล็อก (เหลือ 1 ครั้ง)
  await RESET(page);
  await page.goto('/login');
  await page.getByTestId('thaid-id-input').fill(piti);
  await page.getByTestId('thaid-submit').click();
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');

  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');

  await page.getByTestId('otp-input').fill('123456');
  await page.getByTestId('otp-submit').click();
  await expect(page).toHaveURL(/\/citizen/);

  await page.getByTestId('logout-btn').click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByTestId('thaid-id-input').fill(piti);
  await page.getByTestId('thaid-submit').click();
  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');

  await page.getByTestId('otp-input').fill('000000');
  await page.getByTestId('otp-submit').click();
  await expect(page.getByTestId('otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
});

test('TC-AUTH-03 · ลงทะเบียนครั้งแรก', async ({ page }) => {
  await RESET(page);
  const mana = '5500400111221';

  await page.goto('/login');
  await page.getByTestId('thaid-id-input').fill(mana);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();
  await page.getByTestId('otp-input').fill('123456');
  await page.getByTestId('otp-submit').click();

  await expect(page).toHaveURL(/\/register/);

  // 1: ตรวจ reg-name
  const regName = page.getByTestId('reg-name');
  await expect(regName).toHaveValue('มานะ ตั้งใจ');
  const isReadOnly = await regName.evaluate((el: HTMLInputElement) => el.readOnly);
  expect(isReadOnly).toBe(true);

  // 2: เบอร์ 081234567 (9 หลัก) + ติ๊ก reg-consent
  await page.getByTestId('reg-mobile').fill('081234567');
  await page.getByTestId('reg-consent').check();
  await page.getByTestId('reg-submit').click();
  await expect(page.getByTestId('reg-error-mobile')).toHaveText('เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');
  await expect(page).toHaveURL(/\/register/);

  // 3: เบอร์ 08123456789 (11 หลัก)
  await page.getByTestId('reg-mobile').fill('08123456789');
  await page.getByTestId('reg-consent').check();
  await page.getByTestId('reg-submit').click();
  await expect(page.getByTestId('reg-error-mobile')).toHaveText('เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');

  // 4: เบอร์ 1812345678 (ไม่ขึ้นต้น 0) และ 08123abcde
  for (const badMobile of ['1812345678', '08123abcde']) {
    await page.getByTestId('reg-mobile').fill(badMobile);
    await page.getByTestId('reg-consent').check();
    await page.getByTestId('reg-submit').click();
    await expect(page.getByTestId('reg-error-mobile')).toHaveText('เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');
  }

  // 5: เบอร์ 0845678901 ไม่ติ๊ก reg-consent
  await page.getByTestId('reg-mobile').fill('0845678901');
  await page.getByTestId('reg-consent').uncheck();
  await page.getByTestId('reg-submit').click();
  await expect(page.getByTestId('reg-error-consent')).toHaveText(
    'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)'
  );
  await expect(page).toHaveURL(/\/register/);

  // 6: เบอร์ 0845678901 + ติ๊ก + อีเมลว่าง → reg-submit
  await page.getByTestId('reg-mobile').fill('0845678901');
  await page.getByTestId('reg-email').fill('');
  await page.getByTestId('reg-consent').check();
  await page.getByTestId('reg-submit').click();
  await expect(page).toHaveURL(/\/citizen/);
  await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');

  // 7: ออกจากระบบ → LOGIN_C มานะอีกครั้ง → เข้า /citizen ตรงๆ
  await page.getByTestId('logout-btn').click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByTestId('thaid-id-input').fill(mana);
  await page.getByTestId('thaid-submit').click();
  await page.getByTestId('otp-input').fill('123456');
  await page.getByTestId('otp-submit').click();
  await expect(page).toHaveURL(/\/citizen/);
  await expect(page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');

  // 8: RESET แล้วตรวจ API register
  await RESET(page);
  const startRes = await page.request.post('/api/auth/thaid/start', { data: { idNo: mana } });
  expect(startRes.status()).toBe(200);
  const verifyRes = await page.request.post('/api/auth/thaid/verify', {
    data: { idNo: mana, otp: '123456' },
  });
  expect(verifyRes.status()).toBe(200);
  const verifyBody = await verifyRes.json();
  expect(verifyBody.registered).toBe(false);

  const regBadMobile = await page.request.post('/api/auth/register', {
    data: { mobile: '081234567', email: '', consent: true },
  });
  expect(regBadMobile.status()).toBe(400);
  expect((await regBadMobile.json()).code).toBe('INVALID_MOBILE');

  const regNoConsent = await page.request.post('/api/auth/register', {
    data: { mobile: '0845678901', email: '', consent: false },
  });
  expect(regNoConsent.status()).toBe(400);
  expect((await regNoConsent.json()).code).toBe('CONSENT_REQUIRED');
});

test('TC-AUTH-04 · เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท', async ({ page }) => {
  await RESET(page);

  const accounts: Array<{
    username: string;
    landing: string;
    name: string;
    roleText: string;
    roleCode: string;
    dept?: string;
  }> = [
    {
      username: 'off.reg1',
      landing: '/officer/queue',
      name: 'เจ้าหน้าที่ทะเบียน 1',
      roleText: 'เจ้าหน้าที่',
      roleCode: 'officer',
      dept: 'registry',
    },
    {
      username: 'off.reg2',
      landing: '/officer/queue',
      name: 'เจ้าหน้าที่ทะเบียน 2',
      roleText: 'เจ้าหน้าที่',
      roleCode: 'officer',
      dept: 'registry',
    },
    {
      username: 'off.works1',
      landing: '/officer/queue',
      name: 'เจ้าหน้าที่โยธา 1',
      roleText: 'เจ้าหน้าที่',
      roleCode: 'officer',
      dept: 'works',
    },
    {
      username: 'head1',
      landing: '/head/approvals',
      name: 'หัวหน้าฝ่าย',
      roleText: 'หัวหน้าฝ่าย',
      roleCode: 'head',
    },
    {
      username: 'exec1',
      landing: '/dashboard',
      name: 'ผู้บริหาร',
      roleText: 'ผู้บริหาร',
      roleCode: 'executive',
    },
    {
      username: 'audit1',
      landing: '/audit',
      name: 'ผู้ตรวจสอบภายใน',
      roleText: 'ผู้ตรวจสอบภายใน',
      roleCode: 'auditor',
    },
    {
      username: 'admin1',
      landing: '/admin/services',
      name: 'ผู้ดูแลระบบ',
      roleText: 'ผู้ดูแลระบบ',
      roleCode: 'admin',
    },
  ];

  for (const acc of accounts) {
    await page.goto('/login');
    const staffTab = page.getByTestId('login-tab-staff');
    if ((await staffTab.count()) > 0) {
      await staffTab.click();
    }
    await expect(page.getByTestId('staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
    await page.getByTestId('staff-username').fill(acc.username);
    await page.getByTestId('staff-password').fill('Test@1234');
    await page.getByTestId('staff-submit').click();

    await expect(page).toHaveURL(new RegExp(acc.landing.replace(/\//g, '\\/')));
    await expect(page.getByTestId('user-name')).toHaveText(acc.name);
    await expect(page.getByTestId('user-role')).toHaveText(acc.roleText);
    await expect(page.getByTestId('user-role')).toHaveAttribute('data-role', acc.roleCode);
    if (acc.dept) {
      await expect(page.getByTestId('user-role')).toHaveAttribute('data-dept', acc.dept);
    }

    await page.getByTestId('logout-btn').click();
    await expect(page).toHaveURL(/\/login/);
  }

  // รหัสผ่านผิด / username ไม่มี / เลขบัตรประชาชนในช่อง username
  const invalidLogins = [
    { username: 'off.reg1', password: 'wrong' },
    { username: 'nobody', password: 'Test@1234' },
    { username: '1101700123456', password: 'Test@1234' },
  ];

  for (const cred of invalidLogins) {
    await page.goto('/login');
    const staffTab = page.getByTestId('login-tab-staff');
    if ((await staffTab.count()) > 0) {
      await staffTab.click();
    }
    await page.getByTestId('staff-username').fill(cred.username);
    await page.getByTestId('staff-password').fill(cred.password);
    await page.getByTestId('staff-submit').click();
    await expect(page.getByTestId('staff-error')).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

    const apiRes = await page.request.post('/api/auth/staff/login', { data: cred });
    expect(apiRes.status()).toBe(401);
    const body = await apiRes.json();
    expect(body.code).toBe('INVALID_CREDENTIALS');
  }

  // เปิด /officer/queue หลังออกจากระบบ → redirect /login
  await page.goto('/officer/queue');
  await expect(page).toHaveURL(/\/login/);
});

test('TC-FEE-01 · ค่าธรรมเนียม SV-01/SV-02/SV-03', async ({ page }) => {
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  // SV-03
  await page.goto('/citizen/new/SV-03');
  const sv03Invalid = [
    { area: 0, msg: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', code: 'INVALID_AREA' },
    { area: -1, msg: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', code: 'INVALID_AREA' },
    { area: 501, msg: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน', code: 'AREA_TOO_LARGE' },
  ];

  for (const row of sv03Invalid) {
    await page.getByTestId('area-input').fill(String(row.area));
    await expect(page.getByTestId('fee-total')).toHaveText('–');
    await expect(page.getByTestId('fee-error')).toHaveText(row.msg);
    await expect(page.getByTestId('to-upload-btn')).toBeDisabled();

    const apiRes = await page.request.post('/api/drafts', {
      data: { serviceId: 'SV-03', areaSqm: row.area },
    });
    expect(apiRes.status()).toBe(400);
    const body = await apiRes.json();
    expect(body.code).toBe(row.code);
  }

  const sv03Valid = [
    { area: 1, feeText: '฿1,000', feeNum: 1000 },
    { area: 100, feeText: '฿1,000', feeNum: 1000 },
    { area: 101, feeText: '฿1,010', feeNum: 1010 },
    { area: 102, feeText: '฿1,020', feeNum: 1020 },
    { area: 250, feeText: '฿2,500', feeNum: 2500 },
    { area: 300, feeText: '฿3,000', feeNum: 3000 },
    { area: 499, feeText: '฿4,990', feeNum: 4990 },
    { area: 500, feeText: '฿5,000', feeNum: 5000 },
  ];

  for (const row of sv03Valid) {
    await page.getByTestId('area-input').fill(String(row.area));
    await expect(page.getByTestId('fee-total')).toHaveText(row.feeText);
    await expect(page.getByTestId('to-upload-btn')).toBeEnabled();

    const apiRes = await page.request.post('/api/drafts', {
      data: { serviceId: 'SV-03', areaSqm: row.area },
    });
    expect(apiRes.status()).toBe(201);
    const body = await apiRes.json();
    expect(body.fee).toBe(row.feeNum);
  }

  // SV-01
  await page.goto('/citizen/new/SV-01');
  for (const badQty of [0, 6]) {
    await page.getByTestId('qty-input').fill(String(badQty));
    await expect(page.getByTestId('fee-error')).toHaveText('จำนวนฉบับต้อง 1–5 ฉบับ');
    await expect(page.getByTestId('to-upload-btn')).toBeDisabled();

    const apiRes = await page.request.post('/api/drafts', {
      data: { serviceId: 'SV-01', qty: badQty },
    });
    expect(apiRes.status()).toBe(400);
    expect((await apiRes.json()).code).toBe('INVALID_QTY');
  }

  const sv01Valid = [
    { qty: 1, feeText: '฿20', feeNum: 20 },
    { qty: 2, feeText: '฿40', feeNum: 40 },
    { qty: 3, feeText: '฿60', feeNum: 60 },
    { qty: 4, feeText: '฿80', feeNum: 80 },
    { qty: 5, feeText: '฿100', feeNum: 100 },
  ];

  for (const row of sv01Valid) {
    await page.getByTestId('qty-input').fill(String(row.qty));
    await expect(page.getByTestId('fee-total')).toHaveText(row.feeText);
    await expect(page.getByTestId('to-upload-btn')).toBeEnabled();

    const apiRes = await page.request.post('/api/drafts', {
      data: { serviceId: 'SV-01', qty: row.qty },
    });
    expect(apiRes.status()).toBe(201);
    expect((await apiRes.json()).fee).toBe(row.feeNum);
  }

  // SV-02
  await page.goto('/citizen/new/SV-02');
  await expect(page.getByTestId('fee-total')).toHaveText('฿500');
  const sv02Res = await page.request.post('/api/drafts', { data: { serviceId: 'SV-02' } });
  expect(sv02Res.status()).toBe(201);
  expect((await sv02Res.json()).fee).toBe(500);
});

test('TC-SUBMIT-01 · ยื่นคำขอ SV-01 ครบวงจร', async ({ page }) => {
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  // 1: /citizen → start-service-SV-01
  await page.goto('/citizen');
  await page.getByTestId('start-service-SV-01').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await page.getByTestId('qty-input').fill('2');
  await expect(page.getByTestId('fee-total')).toHaveText('฿40');
  await page.getByTestId('to-upload-btn').click();

  // 2: 2/3 แนบเอกสาร
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('file-item').first()).toHaveAttribute('data-doc-key', 'id-card');
  await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
  await page.getByTestId('to-payment-btn').click();

  // 3: 3/3 ชำระเงิน
  await expect(page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
  await expect(page.getByTestId('payment-amount')).toHaveText('฿40');
  await page.getByTestId('create-qr-btn').click();
  await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
  await expect(page.getByTestId('payment-status')).toHaveText('รอชำระ');

  // 4: POST /api/test/payments/PP-0002/pay {"amount":40}
  const payRes = await page.request.post('/api/test/payments/PP-0002/pay', {
    data: { amount: 40 },
  });
  expect(payRes.status()).toBe(200);
  const payBody = await payRes.json();
  expect(payBody).toEqual({
    status: 'PAID',
    caseNo: 'EG-2569-000031',
    receiptNo: 'RC-2569-000031',
    duplicate: false,
  });

  await page.getByTestId('refresh-payment-btn').click();
  await expect(page.getByTestId('payment-status')).toHaveText('ชำระแล้ว');
  await expect(page.getByTestId('submitted-case-no')).toHaveText('EG-2569-000031');
  await expect(page.getByTestId('receipt-no')).toHaveText('RC-2569-000031');
  await expect(page.getByTestId('receipt-amount')).toHaveText('฿40');
  await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');

  // 5: ไป go-case-btn
  await page.getByTestId('go-case-btn').click();
  await expect(page).toHaveURL(/\/citizen\/cases\/EG-2569-000031/);
  await expect(page.getByTestId('case-status')).toHaveText('ส่งคำขอแล้ว');
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'SUBMITTED');
  await expect(page.getByTestId('case-fee')).toHaveText('฿40');
  await expect(page.getByTestId('sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
  await expect(page.getByTestId('sla-level')).toHaveText('ปกติ');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
  await expect(page.getByTestId('case-step')).toHaveCount(0);

  // LOGIN_S off.reg1 → /officer/queue
  await LOGIN_S(page, 'off.reg1');
  await page.goto('/officer/queue');
  const rows = page.getByTestId('queue-row');
  const targetRow = page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000031"]');
  await expect(targetRow).toHaveCount(1);
  await expect(targetRow.getByTestId('row-owner')).toHaveText('');
  await expect(targetRow.getByTestId('claim-btn')).toHaveCount(1);

  const caseNos = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-case-no') || '')
  );
  const idx30 = caseNos.indexOf('EG-2569-000030');
  const idx31 = caseNos.indexOf('EG-2569-000031');
  expect(idx30).toBeGreaterThanOrEqual(0);
  expect(idx31).toBe(idx30 + 1);
});

test('TC-SUBMIT-02 · เอกสารบังคับครบก่อนชำระ', async ({ page }) => {
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  // SV-02
  await page.goto('/citizen/new/SV-02');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');

  // id-card.pdf อย่างเดียว
  await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

  // + map.pdf (ไม่แนบภาพสถานที่)
  await page.getByTestId('upload-input-map').setInputFiles(getTestFilePath('map.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
  await expect(page.getByTestId('missing-docs')).toHaveCount(0);

  // ลบ map.pdf
  const mapItem = page.locator('[data-testid="file-item"][data-doc-key="map"]');
  await mapItem.getByTestId('file-remove-btn').click();
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

  // SV-03 (พื้นที่ 100)
  await page.goto('/citizen/new/SV-03');
  await page.getByTestId('area-input').fill('100');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');

  // id-card.pdf อย่างเดียว
  await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');

  // + deed.pdf
  await page.getByTestId('upload-input-deed').setInputFiles(getTestFilePath('deed.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');

  // + plan-as-jpg.jpg ในช่อง upload-input-plan
  await page.getByTestId('upload-input-plan').setInputFiles(getTestFilePath('plan-as-jpg.jpg'));
  await expect(page.getByTestId('upload-error')).toHaveText('แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น');
  await expect(page.getByTestId('file-item')).toHaveCount(2);
  await expect(page.getByTestId('to-payment-btn')).toBeDisabled();
  await expect(page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');

  // API check: ร่าง SV-03 ที่ขาดแบบแปลน POST /api/drafts/:id/payment → 409 MISSING_DOCS
  const draftsRes = await page.request.get('/api/drafts');
  const draftsData = await draftsRes.json();
  const sv03Draft = draftsData.items.find((d: { serviceId: string; draftId: string }) => d.serviceId === 'SV-03');
  expect(sv03Draft).toBeTruthy();

  const payFailRes = await page.request.post(`/api/drafts/${sv03Draft.draftId}/payment`);
  expect(payFailRes.status()).toBe(409);
  const payFailBody = await payFailRes.json();
  expect(payFailBody.code).toBe('MISSING_DOCS');
  expect(payFailBody.missing).toEqual(['แบบแปลน']);

  // + plan.pdf
  await page.getByTestId('upload-input-plan').setInputFiles(getTestFilePath('plan.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(3);
  await expect(page.getByTestId('to-payment-btn')).toBeEnabled();
  await expect(page.getByTestId('missing-docs')).toHaveCount(0);

  // หลังแนบครบ → 201
  const payOkRes = await page.request.post(`/api/drafts/${sv03Draft.draftId}/payment`);
  expect(payOkRes.status()).toBe(201);
});

test('TC-SUBMIT-03 · ร่าง การลบร่าง และการยกเลิก', async ({ page, browser }) => {
  // ส่วน A ร่าง
  await RESET(page);
  await LOGIN_C(page, '1101700123456');
  await page.goto('/citizen');

  await expect(page.getByTestId('my-case-row')).toHaveCount(10);
  const draftRows = page.getByTestId('my-draft-row');
  await expect(draftRows).toHaveCount(2);

  const dr1 = page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0001"]');
  const dr2 = page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0002"]');
  await expect(dr1).toHaveAttribute('data-status', 'DRAFT');
  await expect(dr2).toHaveAttribute('data-status', 'PENDING_PAYMENT');
  expect(await dr1.innerText()).not.toContain('EG-');
  expect(await dr2.innerText()).not.toContain('EG-');

  await dr1.getByTestId('open-draft-btn').click();
  await expect(page.getByTestId('qty-input')).toHaveValue('2');
  await expect(page.getByTestId('fee-total')).toHaveText('฿40');

  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('3');
  await page.getByTestId('save-draft-btn').click();
  await expect(page.getByTestId('draft-id')).toHaveText('DR-0003');

  await page.goto('/citizen');
  await expect(page.getByTestId('my-case-row')).toHaveCount(10);

  const casesApi = await page.request.get('/api/cases');
  expect((await casesApi.json()).items.length).toBe(10);
  const draftsApi = await page.request.get('/api/drafts');
  expect((await draftsApi.json()).items.length).toBe(3);

  // ส่วน B ยกเลิก (RESET)
  await RESET(page);
  await LOGIN_C(page, '1101700123456');
  await page.goto('/citizen/cases/EG-2569-000030');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(1);
  await page.getByTestId('cancel-case-btn').click();
  await expect(page.getByTestId('cancel-confirm-text')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await page.getByTestId('confirm-cancel-btn').click();

  await expect(page.getByTestId('case-status')).toHaveText('ยกเลิก');
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
  await expect(page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);

  await LOGIN_S(page, 'off.reg1');
  await page.goto('/officer/queue');
  await expect(page.getByTestId('queue-row')).toHaveCount(16);
  await expect(page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000030"]')).toHaveCount(0);

  await LOGIN_S(page, 'exec1');
  await page.goto('/dashboard');
  await expect(page.getByTestId('kpi-backlog')).toHaveText('20');
  await expect(page.getByTestId('kpi-received')).toHaveText('3');

  // ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ (RESET)
  await RESET(page);
  await LOGIN_S(page, 'off.reg1');
  const claimRes = await page.request.post('/api/officer/cases/EG-2569-000030/claim');
  expect(claimRes.status()).toBe(200);

  await LOGIN_C(page, '1101700123456');
  await page.goto('/citizen/cases/EG-2569-000030');
  await expect(page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(page.getByTestId('cancel-case-btn')).toHaveCount(0);

  const cancel30Res = await page.request.post('/api/cases/EG-2569-000030/cancel');
  expect(cancel30Res.status()).toBe(409);
  const cancel30Body = await cancel30Res.json();
  expect(cancel30Body.code).toBe('CANNOT_CANCEL');
  expect(cancel30Body.message).toBe('ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว');

  const cancel13Res = await page.request.post('/api/cases/EG-2569-000013/cancel');
  expect(cancel13Res.status()).toBe(409);

  // ส่วน E ลบร่าง (RESET · LOGIN_C สมชาย)
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  const del1 = await page.request.delete('/api/drafts/DR-0001');
  expect(del1.status()).toBe(204);
  const get1 = await page.request.get('/api/drafts/DR-0001');
  expect(get1.status()).toBe(404);

  await page.goto('/citizen');
  await expect(page.getByTestId('my-draft-row')).toHaveCount(1);
  await expect(page.getByTestId('my-draft-row').first()).toHaveAttribute('data-draft-id', 'DR-0002');

  const del2 = await page.request.delete('/api/drafts/DR-0002');
  expect(del2.status()).toBe(204);
  const getPay = await page.request.get('/api/payments/PP-0001');
  expect(getPay.status()).toBe(404);
  const payDeleted = await page.request.post('/api/test/payments/PP-0001/pay', {
    data: { amount: 500 },
  });
  expect(payDeleted.status()).toBe(404);

  // ส่วน F ยกเลิกชนกับรับเรื่อง (RESET · สมชายและ off.reg1 คนละ context)
  await RESET(page);
  const citizenCtx = await browser.newContext();
  const officerCtx = await browser.newContext();
  await LOGIN_C(citizenCtx, '1101700123456');
  await LOGIN_S(officerCtx, 'off.reg1');

  const [cRes, oRes] = await Promise.all([
    citizenCtx.request.post('/api/cases/EG-2569-000030/cancel'),
    officerCtx.request.post('/api/officer/cases/EG-2569-000030/claim'),
  ]);

  const cStatus = cRes.status();
  const oStatus = oRes.status();
  expect([cStatus, oStatus].sort()).toEqual([200, 409]);

  const caseCheck = await officerCtx.request.get('/api/cases/EG-2569-000030');
  const caseData = await caseCheck.json();
  const queueMine = await officerCtx.request.get('/api/officer/queue?filter=mine');
  const mineItems = (await queueMine.json()).items;

  if (cStatus === 200) {
    expect((await oRes.json()).code).toBe('INVALID_STATE');
    expect(caseData.status).toBe('CANCELLED');
    expect(caseData.owner).toBeFalsy();
    expect(mineItems.length).toBe(3);
  } else {
    expect((await cRes.json()).code).toBe('CANNOT_CANCEL');
    expect(caseData.status).toBe('IN_REVIEW');
    expect(caseData.owner).toBe('off.reg1');
    expect(mineItems.length).toBe(4);
  }

  await citizenCtx.close();
  await officerCtx.close();
});

test('TC-UPLOAD-01 · ขนาดและจำนวนไฟล์', async ({ page }) => {
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  // สร้างร่างสำหรับตรวจ API แยก 1 ร่าง
  const apiDraftRes = await page.request.post('/api/drafts', {
    data: { serviceId: 'SV-01', qty: 1 },
  });
  expect(apiDraftRes.status()).toBe(201);
  const apiDraftId = (await apiDraftRes.json()).draftId;

  // ร่างบนจอ
  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('1');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');

  // 1: size-5242879.pdf (5,242,879) → รับ
  await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath('size-5242879.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await page.getByTestId('file-remove-btn').first().click();
  await expect(page.getByTestId('file-item')).toHaveCount(0);

  const apiRes79 = await page.request.post(`/api/drafts/${apiDraftId}/files`, {
    multipart: {
      docKey: 'id-card',
      file: getTestFilePayload('size-5242879.pdf'),
    },
  });
  expect(apiRes79.status()).toBe(201);

  // สร้างร่าง API ใหม่เพื่อทดสอบขนาดถัดไปโดยไม่ติดจำนวน
  const apiDraftRes2 = await page.request.post('/api/drafts', {
    data: { serviceId: 'SV-01', qty: 1 },
  });
  const apiDraftId2 = (await apiDraftRes2.json()).draftId;

  // 2: size-5242880.pdf (5,242,880) → รับ (ขอบ ≤ 5 MB · จับบั๊ก B02)
  await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath('size-5242880.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);
  await expect(page.getByTestId('upload-error')).toBeHidden();
  await page.getByTestId('file-remove-btn').first().click();
  await expect(page.getByTestId('file-item')).toHaveCount(0);

  const apiRes80 = await page.request.post(`/api/drafts/${apiDraftId2}/files`, {
    multipart: {
      docKey: 'id-card',
      file: getTestFilePayload('size-5242880.pdf'),
    },
  });
  expect(apiRes80.status()).toBe(201);

  // 3: size-5242881.pdf (5,242,881) → ปฏิเสธ 400 FILE_TOO_LARGE
  await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath('size-5242881.pdf'));
  await expect(page.getByTestId('upload-error')).toHaveText('ไฟล์ใหญ่เกิน 5 MB');
  await expect(page.getByTestId('file-item')).toHaveCount(0);

  const apiRes81 = await page.request.post(`/api/drafts/${apiDraftId2}/files`, {
    multipart: {
      docKey: 'extra',
      file: getTestFilePayload('size-5242881.pdf'),
    },
  });
  expect(apiRes81.status()).toBe(400);
  const body81 = await apiRes81.json();
  expect(body81.code).toBe('FILE_TOO_LARGE');
  expect(body81.message).toBe('ไฟล์ใหญ่เกิน 5 MB');

  // จำนวนไฟล์: id-card.pdf + multi-1..4.pdf = 5 ไฟล์
  await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath('id-card.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(1);

  for (let i = 1; i <= 4; i++) {
    await page.getByTestId('upload-input-extra').setInputFiles(getTestFilePath(`multi-${i}.pdf`));
    await expect(page.getByTestId('file-item')).toHaveCount(1 + i);
  }
  await expect(page.getByTestId('file-item')).toHaveCount(5);

  // แนบ multi-5.pdf (ไฟล์ที่ 6) → ปฏิเสธ
  await page.getByTestId('upload-input-extra').setInputFiles(getTestFilePath('multi-5.pdf'));
  await expect(page.getByTestId('upload-error')).toHaveText('แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
  await expect(page.getByTestId('file-item')).toHaveCount(5);

  // ตรวจ API 400 FILE_COUNT บนร่างที่มี 5 ไฟล์แล้ว
  const apiDraftCountRes = await page.request.post('/api/drafts', {
    data: { serviceId: 'SV-01', qty: 1 },
  });
  const apiDraftCountId = (await apiDraftCountRes.json()).draftId;
  for (let i = 1; i <= 5; i++) {
    const r = await page.request.post(`/api/drafts/${apiDraftCountId}/files`, {
      multipart: { docKey: i === 1 ? 'id-card' : 'extra', file: getTestFilePayload(`multi-${i}.pdf`) },
    });
    expect(r.status()).toBe(201);
  }
  const r6 = await page.request.post(`/api/drafts/${apiDraftCountId}/files`, {
    multipart: { docKey: 'extra', file: getTestFilePayload('multi-6.pdf') },
  });
  expect(r6.status()).toBe(400);
  expect((await r6.json()).code).toBe('FILE_COUNT');

  // ลบ 1 ไฟล์ แล้วแนบ multi-5.pdf → รับครบ 5
  await page.getByTestId('file-remove-btn').last().click();
  await expect(page.getByTestId('file-item')).toHaveCount(4);
  await page.getByTestId('upload-input-extra').setInputFiles(getTestFilePath('multi-5.pdf'));
  await expect(page.getByTestId('file-item')).toHaveCount(5);
});

test('TC-UPLOAD-02 · ชนิดไฟล์จากเนื้อไฟล์', async ({ page }) => {
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  const apiDraftRes = await page.request.post('/api/drafts', {
    data: { serviceId: 'SV-01', qty: 1 },
  });
  const apiDraftId = (await apiDraftRes.json()).draftId;

  await page.goto('/citizen/new/SV-01');
  await page.getByTestId('qty-input').fill('1');
  await page.getByTestId('to-upload-btn').click();
  await expect(page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');

  // ไฟล์ที่รับ: ok-id.pdf, real.jpg, real.png
  for (const validFile of ['ok-id.pdf', 'real.jpg', 'real.png']) {
    await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath(validFile));
    await expect(page.getByTestId('file-item')).toHaveCount(1);
    await page.getByTestId('file-remove-btn').first().click();
    await expect(page.getByTestId('file-item')).toHaveCount(0);

    const apiRes = await page.request.post(`/api/drafts/${apiDraftId}/files`, {
      multipart: { docKey: 'id-card', file: getTestFilePayload(validFile) },
    });
    expect(apiRes.status()).toBe(201);
  }

  // สร้างร่างใหม่สำหรับตรวจว่าไฟล์ที่ปฏิเสธไม่ถูกเก็บ
  const cleanDraftRes = await page.request.post('/api/drafts', {
    data: { serviceId: 'SV-01', qty: 1 },
  });
  const cleanDraftId = (await cleanDraftRes.json()).draftId;

  const invalidFiles = ['fake-text.pdf', 'fake-text.jpg', 'exe-as.png', 'notes.txt'];
  for (const badFile of invalidFiles) {
    await page.getByTestId('upload-input-id-card').setInputFiles(getTestFilePath(badFile));
    await expect(page.getByTestId('upload-error')).toHaveText('รองรับเฉพาะไฟล์ PDF, JPG, PNG');
    await expect(page.getByTestId('file-item')).toHaveCount(0);

    const apiRes = await page.request.post(`/api/drafts/${cleanDraftId}/files`, {
      multipart: { docKey: 'id-card', file: getTestFilePayload(badFile) },
    });
    expect(apiRes.status()).toBe(400);
    expect((await apiRes.json()).code).toBe('FILE_TYPE');
  }

  // fake-text.pdf ส่งด้วย mimeType: application/pdf
  const spoofPayload = getTestFilePayload('fake-text.pdf', 'application/pdf');
  await page.getByTestId('upload-input-id-card').setInputFiles(spoofPayload);
  await expect(page.getByTestId('upload-error')).toHaveText('รองรับเฉพาะไฟล์ PDF, JPG, PNG');
  await expect(page.getByTestId('file-item')).toHaveCount(0);

  const spoofRes = await page.request.post(`/api/drafts/${cleanDraftId}/files`, {
    multipart: { docKey: 'id-card', file: spoofPayload },
  });
  expect(spoofRes.status()).toBe(400);
  expect((await spoofRes.json()).code).toBe('FILE_TYPE');

  const checkDraft = await page.request.get(`/api/drafts/${cleanDraftId}`);
  expect(checkDraft.status()).toBe(200);
  const checkDraftBody = await checkDraft.json();
  if (Array.isArray(checkDraftBody.files)) {
    expect(checkDraftBody.files.length).toBe(0);
  }
});

test('TC-PAY-01 · อายุ QR 15:00', async ({ page }) => {
  // รอบ 1: 09:00:00 (อายุ 5:00) → 200 PAID
  await RESET(page);
  await LOGIN_C(page, '1101700123456');
  const r1 = await page.request.post('/api/test/payments/PP-0001/pay', {
    data: { amount: 500 },
  });
  expect(r1.status()).toBe(200);
  const b1 = await r1.json();
  expect(b1.status).toBe('PAID');
  expect(b1.caseNo).toBe('EG-2569-000031');

  // รอบ 2: RESET · CLOCK(09:09:59) (อายุ 14:59) → 200 PAID
  await RESET(page);
  await CLOCK(page, '2026-12-01T09:09:59+07:00');
  await LOGIN_C(page, '1101700123456');
  const r2 = await page.request.post('/api/test/payments/PP-0001/pay', {
    data: { amount: 500 },
  });
  expect(r2.status()).toBe(200);
  const b2 = await r2.json();
  expect(b2.status).toBe('PAID');
  expect(b2.caseNo).toBe('EG-2569-000031');

  // รอบ 3: RESET · CLOCK(09:10:00) (อายุ 15:00) → 410 QR_EXPIRED (จับบั๊ก B05)
  await RESET(page);
  await CLOCK(page, '2026-12-01T09:10:00+07:00');
  await LOGIN_C(page, '1101700123456');
  const r3 = await page.request.post('/api/test/payments/PP-0001/pay', {
    data: { amount: 500 },
  });
  expect(r3.status()).toBe(410);
  expect((await r3.json()).code).toBe('QR_EXPIRED');

  const getPay3 = await page.request.get('/api/payments/PP-0001');
  expect(getPay3.status()).toBe(200);
  expect((await getPay3.json()).status).toBe('EXPIRED');

  const getCases3 = await page.request.get('/api/cases');
  expect((await getCases3.json()).items.length).toBe(10);

  // รอบ 3 บนจอ: เปิด /citizen/new/SV-02?draft=DR-0002
  await page.goto('/citizen/new/SV-02?draft=DR-0002');
  await expect(page.getByTestId('qr-expired-msg')).toHaveText('QR หมดอายุ กรุณาสร้าง QR ใหม่');
  await expect(page.getByTestId('payment-status')).toHaveText('QR หมดอายุ');
  await expect(page.getByTestId('payment-status')).toHaveAttribute('data-status', 'EXPIRED');
  await expect(page.getByTestId('regenerate-qr-btn')).toBeVisible();
  await page.getByTestId('regenerate-qr-btn').click();

  await expect(page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');

  const payNewQr = await page.request.post('/api/test/payments/PP-0002/pay', {
    data: { amount: 500 },
  });
  expect(payNewQr.status()).toBe(200);
  expect((await payNewQr.json()).caseNo).toBe('EG-2569-000031');

  // รอบ 4: RESET · CLOCK(09:10:01) (อายุ 15:01) → 410 QR_EXPIRED
  await RESET(page);
  await CLOCK(page, '2026-12-01T09:10:01+07:00');
  await LOGIN_C(page, '1101700123456');
  const r4 = await page.request.post('/api/test/payments/PP-0001/pay', {
    data: { amount: 500 },
  });
  expect(r4.status()).toBe(410);
  expect((await r4.json()).code).toBe('QR_EXPIRED');
});

test('TC-PAY-02 · ยอดเงินและ callback ซ้ำ', async ({ page }) => {
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  // สร้างร่าง SV-01 qty 1 (฿20) สร้าง QR ได้ PP-0002
  const draftRes = await page.request.post('/api/drafts', {
    data: { serviceId: 'SV-01', qty: 1 },
  });
  const { draftId } = await draftRes.json();
  await page.request.post(`/api/drafts/${draftId}/files`, {
    multipart: { docKey: 'id-card', file: getTestFilePayload('id-card.pdf') },
  });
  const qrRes = await page.request.post(`/api/drafts/${draftId}/payment`);
  expect(qrRes.status()).toBe(201);
  const { ref } = await qrRes.json();
  expect(ref).toBe('PP-0002');

  // 1: pay amount 19 (ขาด ฿1) → 422 AMOUNT_MISMATCH
  const p1 = await page.request.post('/api/test/payments/PP-0002/pay', { data: { amount: 19 } });
  expect(p1.status()).toBe(422);
  expect((await p1.json()).code).toBe('AMOUNT_MISMATCH');
  expect((await (await page.request.get('/api/payments/PP-0002')).json()).status).toBe('PENDING');
  expect((await (await page.request.get('/api/cases')).json()).items.length).toBe(10);

  // 2: pay amount 21 (เกิน ฿1) → 422
  const p2 = await page.request.post('/api/test/payments/PP-0002/pay', { data: { amount: 21 } });
  expect(p2.status()).toBe(422);
  expect((await (await page.request.get('/api/payments/PP-0002')).json()).status).toBe('PENDING');

  // 3: pay amount 20 → 200 PAID
  const p3 = await page.request.post('/api/test/payments/PP-0002/pay', { data: { amount: 20 } });
  expect(p3.status()).toBe(200);
  const b3 = await p3.json();
  expect(b3.status).toBe('PAID');
  expect(b3.caseNo).toBe('EG-2569-000031');
  expect(b3.receiptNo).toBe('RC-2569-000031');
  expect(b3.duplicate).toBe(false);
  expect((await (await page.request.get('/api/cases')).json()).items.length).toBe(11);

  // 4: pay amount 20 ซ้ำ ref เดิม → 200 duplicate:true
  const p4 = await page.request.post('/api/test/payments/PP-0002/pay', { data: { amount: 20 } });
  expect(p4.status()).toBe(200);
  const b4 = await p4.json();
  expect(b4.duplicate).toBe(true);
  expect(b4.caseNo).toBe('EG-2569-000031');
  expect(b4.receiptNo).toBe('RC-2569-000031');
  expect((await (await page.request.get('/api/cases')).json()).items.length).toBe(11);

  // 5: สร้างร่างใหม่ SV-01 qty 1 จ่ายครบ → EG-2569-000032
  const nextPaid = await NEW_PAID(page, '1101700123456', 'SV-01', undefined, { qty: 1 });
  expect(nextPaid.caseNo).toBe('EG-2569-000032');
  expect(nextPaid.receiptNo).toBe('RC-2569-000032');
});

test('TC-PAY-03 · ชำระพร้อมกัน เลขไม่ซ้ำ', async ({ page, browser }) => {
  await RESET(page);

  const ctxSomchai = await browser.newContext();
  const ctxSomying = await browser.newContext();
  await LOGIN_C(ctxSomchai, '1101700123456');
  await LOGIN_C(ctxSomying, '3100600987659');

  const refs: string[] = [];
  for (const ctx of [ctxSomchai, ctxSomchai, ctxSomchai, ctxSomying, ctxSomying, ctxSomying]) {
    const dRes = await ctx.request.post('/api/drafts', {
      data: { serviceId: 'SV-01', qty: 1 },
    });
    expect(dRes.status()).toBe(201);
    const { draftId } = await dRes.json();

    const fRes = await ctx.request.post(`/api/drafts/${draftId}/files`, {
      multipart: { docKey: 'id-card', file: getTestFilePayload('id-card.pdf') },
    });
    expect(fRes.status()).toBe(201);

    const qRes = await ctx.request.post(`/api/drafts/${draftId}/payment`);
    expect(qRes.status()).toBe(201);
    const { ref } = await qRes.json();
    refs.push(ref);
  }

  expect(refs).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);

  // ยิง pay {"amount":20} ทั้ง 6 ref พร้อมกัน
  const responses = await Promise.all(
    refs.map((ref) =>
      ctxSomchai.request.post(`/api/test/payments/${ref}/pay`, { data: { amount: 20 } })
    )
  );

  const caseNos: string[] = [];
  const receiptNos: string[] = [];
  for (const r of responses) {
    expect(r.status()).toBe(200);
    const body = await r.json();
    caseNos.push(body.caseNo);
    receiptNos.push(body.receiptNo);
  }

  expect([...caseNos].sort()).toEqual([
    'EG-2569-000031',
    'EG-2569-000032',
    'EG-2569-000033',
    'EG-2569-000034',
    'EG-2569-000035',
    'EG-2569-000036',
  ]);
  expect([...receiptNos].sort()).toEqual([
    'RC-2569-000031',
    'RC-2569-000032',
    'RC-2569-000033',
    'RC-2569-000034',
    'RC-2569-000035',
    'RC-2569-000036',
  ]);

  const somchaiCases = (await (await ctxSomchai.request.get('/api/cases')).json()).items;
  const somyingCases = (await (await ctxSomying.request.get('/api/cases')).json()).items;
  expect(somchaiCases.length).toBe(10 + 3);
  expect(somyingCases.length).toBe(11 + 3);

  // การชำระรายการถัดไปได้ EG-2569-000037
  const next = await NEW_PAID(ctxSomchai, '1101700123456', 'SV-01');
  expect(next.caseNo).toBe('EG-2569-000037');

  await ctxSomchai.close();
  await ctxSomying.close();
});

test('TC-PAY-04 · เลขคำขอข้ามปี 2569 → 2570', async ({ page }) => {
  await RESET(page);
  await LOGIN_C(page, '1101700123456');

  // 1: CLOCK(2026-12-31T23:58:00+07:00) สร้างร่าง SV-01 + QR → ยังไม่มีเลขคำขอ
  await CLOCK(page, '2026-12-31T23:58:00+07:00');
  const d1 = await page.request.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } });
  const { draftId: draftId1 } = await d1.json();
  await page.request.post(`/api/drafts/${draftId1}/files`, {
    multipart: { docKey: 'id-card', file: getTestFilePayload('id-card.pdf') },
  });
  const q1 = await page.request.post(`/api/drafts/${draftId1}/payment`);
  const { ref: ref1 } = await q1.json();
  const getPayBefore = await (await page.request.get(`/api/payments/${ref1}`)).json();
  expect(getPayBefore.caseNo).toBeFalsy();

  // 2: CLOCK(2026-12-31T23:59:00+07:00) pay ฿20 → EG-2569-000031
  await CLOCK(page, '2026-12-31T23:59:00+07:00');
  const p1 = await page.request.post(`/api/test/payments/${ref1}/pay`, { data: { amount: 20 } });
  expect(p1.status()).toBe(200);
  const b1 = await p1.json();
  expect(b1.caseNo).toBe('EG-2569-000031');
  expect(b1.receiptNo).toBe('RC-2569-000031');

  await page.goto(`/citizen/new/SV-01?draft=${draftId1}`);
  if ((await page.getByTestId('receipt-paid-at').count()) > 0) {
    await expect(page.getByTestId('receipt-paid-at')).toHaveAttribute(
      'data-iso',
      '2026-12-31T23:59:00+07:00'
    );
  }

  // 3: CLOCK(2027-01-01T00:00:00+07:00) สร้างร่าง SV-01 + QR + pay ฿20 → EG-2570-000001
  const paid2570_1 = await NEW_PAID(
    page,
    '1101700123456',
    'SV-01',
    '2027-01-01T00:00:00+07:00'
  );
  expect(paid2570_1.caseNo).toBe('EG-2570-000001');
  expect(paid2570_1.receiptNo).toBe('RC-2570-000001');

  // 4: ชำระอีกใบที่ 2027-01-01T00:00:00+07:00 → EG-2570-000002
  const paid2570_2 = await NEW_PAID(
    page,
    '1101700123456',
    'SV-01',
    '2027-01-01T00:00:00+07:00'
  );
  expect(paid2570_2.caseNo).toBe('EG-2570-000002');

  // 5: GET /api/cases/EG-2569-000031 → ยังเป็นเลขเดิม
  const oldCaseRes = await page.request.get('/api/cases/EG-2569-000031');
  expect(oldCaseRes.status()).toBe(200);
  expect((await oldCaseRes.json()).caseNo).toBe('EG-2569-000031');
});

test('TC-QUEUE-01 · ลำดับคิวและขอบเขตแผนก', async ({ page }) => {
  await RESET(page);
  await LOGIN_S(page, 'off.reg1');
  await page.goto('/officer/queue');

  const expectedOrder17 = [
    'EG-2569-000020',
    'EG-2569-000022',
    'EG-2569-000024',
    'EG-2569-000023',
    'EG-2569-000025',
    'EG-2569-000026',
    'EG-2569-000013',
    'EG-2569-000015',
    'EG-2569-000027',
    'EG-2569-000028',
    'EG-2569-000029',
    'EG-2569-000030',
    'EG-2569-000016',
    'EG-2569-000018',
    'EG-2569-000019',
    'EG-2569-000012',
    'EG-2569-000021',
  ];

  const rows = page.getByTestId('queue-row');
  await expect(rows).toHaveCount(17);
  const actualCaseNos = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-case-no') || '')
  );
  expect(actualCaseNos).toEqual(expectedOrder17);

  // ไม่อยู่ในคิว
  for (const excluded of ['EG-2569-000017', 'EG-2569-000011', 'EG-2569-000014', 'EG-2569-000005', 'EG-2569-000009']) {
    expect(actualCaseNos).not.toContain(excluded);
  }

  // row-sla-level 3 แถวแรก
  await expect(rows.nth(0).getByTestId('row-sla-level')).toHaveText('เกินกำหนด');
  await expect(rows.nth(1).getByTestId('row-sla-level')).toHaveText('ใกล้ครบกำหนด');
  await expect(rows.nth(2).getByTestId('row-sla-level')).toHaveText('ใกล้ครบกำหนด');

  // row-id-masked ทุกแถวตรง ^X-XXXX-XXXXX-\d{2}-\d$
  const maskedTexts = await page.getByTestId('row-id-masked').allInnerTexts();
  expect(maskedTexts.length).toBe(17);
  for (const m of maskedTexts) {
    expect(m.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
  }

  // claim-btn มี 4 ปุ่ม (000024, 000028, 000029, 000030)
  await expect(page.getByTestId('claim-btn')).toHaveCount(4);
  for (const claimable of ['EG-2569-000024', 'EG-2569-000028', 'EG-2569-000029', 'EG-2569-000030']) {
    await expect(
      page.locator(`[data-testid="queue-row"][data-case-no="${claimable}"]`).getByTestId('claim-btn')
    ).toHaveCount(1);
  }
  await expect(
    page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000019"]').getByTestId('claim-btn')
  ).toHaveCount(0);

  // queue-filter = unclaimed → 4 แถว
  await page.getByTestId('queue-filter').selectOption('unclaimed');
  await expect(rows).toHaveCount(4);
  const unclaimedNos = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-case-no') || '')
  );
  expect(unclaimedNos).toEqual([
    'EG-2569-000024',
    'EG-2569-000028',
    'EG-2569-000029',
    'EG-2569-000030',
  ]);

  // queue-filter = mine → 3 แถว · workload-count = 3
  await page.getByTestId('queue-filter').selectOption('mine');
  await expect(rows).toHaveCount(3);
  const mineReg1Nos = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-case-no') || '')
  );
  expect(mineReg1Nos).toEqual(['EG-2569-000020', 'EG-2569-000022', 'EG-2569-000023']);
  await expect(page.getByTestId('workload-count')).toHaveText('3');

  // off.reg2 filter mine → 9 แถว
  await LOGIN_S(page, 'off.reg2');
  await page.goto('/officer/queue');
  await page.getByTestId('queue-filter').selectOption('mine');
  await expect(rows).toHaveCount(9);
  const mineReg2Nos = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-case-no') || '')
  );
  expect(mineReg2Nos).toEqual([
    'EG-2569-000025',
    'EG-2569-000026',
    'EG-2569-000013',
    'EG-2569-000015',
    'EG-2569-000027',
    'EG-2569-000016',
    'EG-2569-000018',
    'EG-2569-000012',
    'EG-2569-000021',
  ]);
  await expect(page.getByTestId('workload-count')).toHaveText('9');

  // off.works1 เห็น 1 แถว: 000010
  await LOGIN_S(page, 'off.works1');
  await page.goto('/officer/queue');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-case-no', 'EG-2569-000010');

  // head1 เห็น 18 แถว และไม่มี claim-btn เลย
  await LOGIN_S(page, 'head1');
  await page.goto('/officer/queue');
  await expect(rows).toHaveCount(18);
  await expect(page.getByTestId('claim-btn')).toHaveCount(0);
  const headNos = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-case-no') || '')
  );
  const idx10 = headNos.indexOf('EG-2569-000010');
  expect(headNos.slice(idx10, idx10 + 4)).toEqual([
    'EG-2569-000010',
    'EG-2569-000023',
    'EG-2569-000025',
    'EG-2569-000026',
  ]);
});

test('TC-QUEUE-02 · รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ page, browser }) => {
  // ส่วน 1 พร้อมกัน (UI)
  await RESET(page);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await LOGIN_S(ctxA, 'off.reg1');
  await LOGIN_S(ctxB, 'off.reg2');

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto('/officer/queue');
  await pageB.goto('/officer/queue');

  const btnA = pageA
    .locator('[data-testid="queue-row"][data-case-no="EG-2569-000028"]')
    .getByTestId('claim-btn');
  const btnB = pageB
    .locator('[data-testid="queue-row"][data-case-no="EG-2569-000028"]')
    .getByTestId('claim-btn');
  await expect(btnA).toBeVisible();
  await expect(btnB).toBeVisible();

  await Promise.all([btnA.click(), btnB.click()]);

  // ตรวจผลลัพธ์หลังกดพร้อมกัน
  const case28Res = await ctxA.request.get('/api/cases/EG-2569-000028');
  const case28 = await case28Res.json();
  expect(case28.status).toBe('IN_REVIEW');
  expect(['off.reg1', 'off.reg2']).toContain(case28.owner);

  const loserPage = case28.owner === 'off.reg1' ? pageB : pageA;
  await expect(loserPage.getByTestId('action-error')).toHaveText('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');

  // Audit CLAIM ของ EG-2569-000028 มี 1 แถวเท่านั้น
  await LOGIN_S(page, 'audit1');
  const audit1Res = await page.request.get('/api/audit?event=CLAIM');
  const audit1Items = (await audit1Res.json()).items.filter(
    (it: { caseNo: string }) => it.caseNo === 'EG-2569-000028'
  );
  expect(audit1Items.length).toBe(1);

  await ctxA.close();
  await ctxB.close();

  // ส่วน 2 พร้อมกัน (API · RESET)
  await RESET(page);
  const apiCtx1 = await browser.newContext();
  const apiCtx2 = await browser.newContext();
  await LOGIN_S(apiCtx1, 'off.reg1');
  await LOGIN_S(apiCtx2, 'off.reg2');

  const reqs = [
    ...Array.from({ length: 5 }, () =>
      apiCtx1.request.post('/api/officer/cases/EG-2569-000029/claim')
    ),
    ...Array.from({ length: 5 }, () =>
      apiCtx2.request.post('/api/officer/cases/EG-2569-000029/claim')
    ),
  ];
  const claimResponses = await Promise.all(reqs);
  const statuses = claimResponses.map((r) => r.status());
  expect(statuses.filter((s) => s === 200).length).toBe(1);
  expect(statuses.filter((s) => s === 409).length).toBe(9);

  for (const r of claimResponses) {
    if (r.status() === 409) {
      expect((await r.json()).code).toBe('ALREADY_CLAIMED');
    }
  }

  await LOGIN_S(page, 'audit1');
  const audit2Res = await page.request.get('/api/audit?event=CLAIM');
  const audit2Items = (await audit2Res.json()).items.filter(
    (it: { caseNo: string }) => it.caseNo === 'EG-2569-000029'
  );
  expect(audit2Items.length).toBe(1);

  await apiCtx1.close();
  await apiCtx2.close();

  // ส่วน 3 ต่อกัน (กำหนดได้ ไม่พึ่ง race · RESET · จับบั๊ก B08)
  await RESET(page);
  const seqCtx1 = await browser.newContext();
  const seqCtx2 = await browser.newContext();
  await LOGIN_S(seqCtx1, 'off.reg1');
  await LOGIN_S(seqCtx2, 'off.reg2');

  const firstClaim = await seqCtx1.request.post('/api/officer/cases/EG-2569-000029/claim');
  expect(firstClaim.status()).toBe(200);
  expect((await firstClaim.json()).owner).toBe('off.reg1');

  const secondClaim = await seqCtx2.request.post('/api/officer/cases/EG-2569-000029/claim');
  expect(secondClaim.status()).toBe(409);
  const secondBody = await secondClaim.json();
  expect(secondBody.code).toBe('ALREADY_CLAIMED');
  expect(secondBody.message).toBe('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');

  const case29 = await (await seqCtx1.request.get('/api/cases/EG-2569-000029')).json();
  expect(case29.owner).toBe('off.reg1');

  const selfRepeatClaim = await seqCtx1.request.post('/api/officer/cases/EG-2569-000029/claim');
  expect(selfRepeatClaim.status()).toBe(409);

  await LOGIN_S(page, 'off.reg2');
  await page.goto('/officer/queue');
  await expect(page.getByTestId('workload-count')).toHaveText('9');

  await LOGIN_S(page, 'audit1');
  const audit3Res = await page.request.get('/api/audit?event=CLAIM');
  const audit3Items = (await audit3Res.json()).items.filter(
    (it: { caseNo: string }) => it.caseNo === 'EG-2569-000029'
  );
  expect(audit3Items.length).toBe(1);

  await seqCtx1.close();
  await seqCtx2.close();
});

test('TC-QUEUE-03 · งานในมือสูงสุด 10', async ({ page, browser }) => {
  await RESET(page);
  await LOGIN_S(page, 'off.reg2');
  await page.goto('/officer/queue');

  // 1: ดู workload-count = 9
  await expect(page.getByTestId('workload-count')).toHaveText('9');

  // 2: กด claim-btn ของ EG-2569-000028 (ครั้งที่ 10) → สำเร็จ workload-count = 10
  await page
    .locator('[data-testid="queue-row"][data-case-no="EG-2569-000028"]')
    .getByTestId('claim-btn')
    .click();
  await expect(page.getByTestId('workload-count')).toHaveText('10');

  // 3: กด claim-btn ของ EG-2569-000029 (ครั้งที่ 11) → ไม่สำเร็จ action-error = รับงานได้สูงสุด 10 เรื่อง
  await page
    .locator('[data-testid="queue-row"][data-case-no="EG-2569-000029"]')
    .getByTestId('claim-btn')
    .click();
  await expect(page.getByTestId('action-error')).toHaveText('รับงานได้สูงสุด 10 เรื่อง');
  await expect(page.getByTestId('workload-count')).toHaveText('10');

  const apiClaim11 = await page.request.post('/api/officer/cases/EG-2569-000029/claim');
  expect(apiClaim11.status()).toBe(409);
  expect((await apiClaim11.json()).code).toBe('WORKLOAD_LIMIT');

  const case29 = await (await page.request.get('/api/cases/EG-2569-000029')).json();
  expect(case29.status).toBe('SUBMITTED');
  expect(case29.owner).toBeFalsy();

  // 4: เปิด EG-2569-000025 กด approve-btn → workload-count = 9
  await page.goto('/officer/cases/EG-2569-000025');
  await page.getByTestId('approve-btn').click();
  await expect(page.getByTestId('case-status')).toHaveText('อนุมัติ');
  await page.goto('/officer/queue');
  await expect(page.getByTestId('workload-count')).toHaveText('9');

  // 5: claim EG-2569-000029 อีกครั้ง → สำเร็จ workload-count = 10
  await page
    .locator('[data-testid="queue-row"][data-case-no="EG-2569-000029"]')
    .getByTestId('claim-btn')
    .click();
  await expect(page.getByTestId('workload-count')).toHaveText('10');

  // 6: off.reg1 (งานในมือ 3) claim EG-2569-000030 → สำเร็จ
  const reg1Ctx = await browser.newContext();
  await LOGIN_S(reg1Ctx, 'off.reg1');
  const reg1Claim = await reg1Ctx.request.post('/api/officer/cases/EG-2569-000030/claim');
  expect(reg1Claim.status()).toBe(200);
  await reg1Ctx.close();

  // 7: RESET · LOGIN_S off.reg2 · return EG-2569-000025 → รอแก้ไขเอกสาร · workload-count = 8
  await RESET(page);
  await LOGIN_S(page, 'off.reg2');
  await page.goto('/officer/cases/EG-2569-000025');
  await returnCaseViaUi(page, 'xxxxxxxxxx');
  await expect(page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');

  await page.goto('/officer/queue');
  await expect(page.getByTestId('workload-count')).toHaveText('8');

  // 8: claim EG-2569-000028 และ EG-2569-000029 → สำเร็จทั้งคู่ · workload-count = 10
  await page
    .locator('[data-testid="queue-row"][data-case-no="EG-2569-000028"]')
    .getByTestId('claim-btn')
    .click();
  await expect(page.getByTestId('workload-count')).toHaveText('9');
  await page
    .locator('[data-testid="queue-row"][data-case-no="EG-2569-000029"]')
    .getByTestId('claim-btn')
    .click();
  await expect(page.getByTestId('workload-count')).toHaveText('10');

  // 9: สมหญิง (ผู้ยื่น EG-2569-000025) กด submit-fix-btn → สำเร็จ · workload-count ของ off.reg2 = 11
  const somyingCtx = await browser.newContext();
  await LOGIN_C(somyingCtx, '3100600987659');
  const somyingPage = await somyingCtx.newPage();
  await somyingPage.goto('/citizen/cases/EG-2569-000025');
  await somyingPage.getByTestId('submit-fix-btn').click();
  await expect(somyingPage.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await somyingCtx.close();

  await page.goto('/officer/queue');
  await expect(page.getByTestId('workload-count')).toHaveText('11');

  // 10: off.reg2 claim EG-2569-000030 → 409 WORKLOAD_LIMIT · workload-count ยัง 11
  const claimOver = await page.request.post('/api/officer/cases/EG-2569-000030/claim');
  expect(claimOver.status()).toBe(409);
  const claimOverBody = await claimOver.json();
  expect(claimOverBody.code).toBe('WORKLOAD_LIMIT');
  expect(claimOverBody.message).toBe('รับงานได้สูงสุด 10 เรื่อง');
  await page.goto('/officer/queue');
  await expect(page.getByTestId('workload-count')).toHaveText('11');
});

test('TC-SLA-01 · กำหนดเสร็จตามตารางวันที่', async ({ page }) => {
  const rows: Array<{
    serviceId: 'SV-01' | 'SV-02' | 'SV-03';
    paidAt: string;
    expectedIso: string;
    expectedText: string;
    areaSqm?: number;
  }> = [
    {
      serviceId: 'SV-01',
      paidAt: '2026-12-01T09:00:00+07:00',
      expectedIso: '2026-12-04T16:30:00+07:00',
      expectedText: '4 ธ.ค. 2569 16:30',
    },
    {
      serviceId: 'SV-01',
      paidAt: '2026-12-01T16:29:00+07:00',
      expectedIso: '2026-12-04T16:30:00+07:00',
      expectedText: '4 ธ.ค. 2569 16:30',
    },
    {
      serviceId: 'SV-01',
      paidAt: '2026-12-01T16:30:00+07:00',
      expectedIso: '2026-12-08T16:30:00+07:00',
      expectedText: '8 ธ.ค. 2569 16:30',
    },
    {
      serviceId: 'SV-01',
      paidAt: '2026-12-04T10:00:00+07:00',
      expectedIso: '2026-12-11T16:30:00+07:00',
      expectedText: '11 ธ.ค. 2569 16:30',
    },
    {
      serviceId: 'SV-01',
      paidAt: '2026-12-05T10:00:00+07:00',
      expectedIso: '2026-12-14T16:30:00+07:00',
      expectedText: '14 ธ.ค. 2569 16:30',
    },
    {
      serviceId: 'SV-02',
      paidAt: '2026-12-01T09:00:00+07:00',
      expectedIso: '2026-12-17T16:30:00+07:00',
      expectedText: '17 ธ.ค. 2569 16:30',
    },
    {
      serviceId: 'SV-03',
      paidAt: '2026-12-01T09:00:00+07:00',
      expectedIso: '2026-12-24T16:30:00+07:00',
      expectedText: '24 ธ.ค. 2569 16:30',
      areaSqm: 100,
    },
    {
      serviceId: 'SV-01',
      paidAt: '2026-12-29T10:00:00+07:00',
      expectedIso: '2027-01-05T16:30:00+07:00',
      expectedText: '5 ม.ค. 2570 16:30',
    },
    {
      serviceId: 'SV-01',
      paidAt: '2026-12-31T23:59:00+07:00',
      expectedIso: '2027-01-07T16:30:00+07:00',
      expectedText: '7 ม.ค. 2570 16:30',
    },
  ];

  for (const row of rows) {
    await RESET(page);
    const { caseNo } = await NEW_PAID(page, {
      idNo: '1101700123456',
      serviceId: row.serviceId,
      time: row.paidAt,
      areaSqm: row.areaSqm,
    });
    expect(caseNo).toBe('EG-2569-000031');

    const apiRes = await page.request.get(`/api/cases/${caseNo}`);
    expect(apiRes.status()).toBe(200);
    const apiData = await apiRes.json();
    expect(apiData.dueAt).toBe(row.expectedIso);

    await page.goto(`/citizen/cases/${caseNo}`);
    await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', row.expectedIso);
    await expect(page.getByTestId('sla-due')).toHaveText(row.expectedText);
  }
});

test('TC-SLA-02 · หยุดนับ SLA ระหว่างรอแก้ไข', async ({ page }) => {
  // ส่วน 1 (ตาราง DECISIONS ข้อ 8 แถว 6 · จับบั๊ก B04)
  await RESET(page);
  const { caseNo } = await NEW_PAID(page, '1101700123456', 'SV-01', '2026-12-01T09:00:00+07:00');
  expect(caseNo).toBe('EG-2569-000031');

  await CLOCK(page, '2026-12-02T11:00:00+07:00');
  await LOGIN_S(page, 'off.reg1');
  await page.request.post('/api/officer/cases/EG-2569-000031/claim');
  await page.request.post('/api/officer/cases/EG-2569-000031/return', {
    data: { reason: 'xxxxxxxxxx' },
  });

  await LOGIN_C(page, '1101700123456');
  await page.goto('/citizen/cases/EG-2569-000031');
  await expect(page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
  await expect(page.getByTestId('sla-level')).toHaveText('หยุดนับ');
  await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', 'paused');
  await expect(page.getByTestId('fix-deadline')).toHaveAttribute(
    'data-iso',
    '2026-12-09T11:00:00+07:00'
  );

  await CLOCK(page, '2026-12-03T10:00:00+07:00');
  await page.getByTestId('submit-fix-btn').click();
  await expect(page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-08T16:30:00+07:00');
  await expect(page.getByTestId('sla-due')).toHaveText('8 ธ.ค. 2569 16:30');
  await expect(page.getByTestId('sla-level')).toHaveText('ปกติ');

  const c1 = await (await page.request.get('/api/cases/EG-2569-000031')).json();
  expect(c1.dueAt).toBe('2026-12-08T16:30:00+07:00');
  expect(c1.owner).toBe('off.reg1');

  // ส่วน 2 (seed EG-2569-000017 ส่งแก้ 1 ธ.ค. 09:00)
  await RESET(page);
  await LOGIN_C(page, '1101700123456');
  await page.goto('/citizen/cases/EG-2569-000017');
  await expect(page.getByTestId('sla-level')).toHaveText('หยุดนับ');
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-11-27T16:30:00+07:00');
  await page.getByTestId('submit-fix-btn').click();

  await expect(page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-01T16:30:00+07:00');
  await expect(page.getByTestId('sla-level')).toHaveText('ใกล้ครบกำหนด');
  const c2 = await (await page.request.get('/api/cases/EG-2569-000017')).json();
  expect(c2.dueAt).toBe('2026-12-01T16:30:00+07:00');
  expect(c2.owner).toBe('off.reg1');

  // ส่วน 3 (RESET · CLOCK 4 ธ.ค. 10:00 ส่งแก้ EG-2569-000017)
  await RESET(page);
  await CLOCK(page, '2026-12-04T10:00:00+07:00');
  await LOGIN_C(page, '1101700123456');
  await page.goto('/citizen/cases/EG-2569-000017');
  await page.getByTestId('submit-fix-btn').click();
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
  await expect(page.getByTestId('sla-level')).toHaveText('ใกล้ครบกำหนด');

  // ส่วน 4 (ตีกลับและส่งแก้วันเดียวกัน)
  await RESET(page);
  await NEW_PAID(page, '1101700123456', 'SV-01', '2026-12-01T09:00:00+07:00');
  await CLOCK(page, '2026-12-02T09:00:00+07:00');
  await LOGIN_S(page, 'off.reg1');
  await page.request.post('/api/officer/cases/EG-2569-000031/claim');
  await page.request.post('/api/officer/cases/EG-2569-000031/return', {
    data: { reason: 'xxxxxxxxxx' },
  });
  await CLOCK(page, '2026-12-02T15:00:00+07:00');
  await LOGIN_C(page, '1101700123456');
  const res4 = await page.request.post('/api/cases/EG-2569-000031/resubmit');
  expect(res4.status()).toBe(200);
  expect((await res4.json()).dueAt).toBe('2026-12-04T16:30:00+07:00');

  // ส่วน 5 (คร่อมสุดสัปดาห์/วันหยุดและส่งแก้หลัง 16:30)
  await RESET(page);
  await NEW_PAID(page, '1101700123456', 'SV-01', '2026-12-01T09:00:00+07:00');
  await CLOCK(page, '2026-12-04T10:00:00+07:00');
  await LOGIN_S(page, 'off.reg1');
  await page.request.post('/api/officer/cases/EG-2569-000031/claim');
  await page.request.post('/api/officer/cases/EG-2569-000031/return', {
    data: { reason: 'xxxxxxxxxx' },
  });
  await CLOCK(page, '2026-12-08T17:00:00+07:00');
  await LOGIN_C(page, '1101700123456');
  await page.goto('/citizen/cases/EG-2569-000031');
  await page.getByTestId('submit-fix-btn').click();
  await expect(page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-08T16:30:00+07:00');
  await expect(page.getByTestId('sla-level')).toHaveText('เกินกำหนด');
  await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', 'overdue');
});

test('TC-SLA-03 · ระดับเตือน ปกติ/ใกล้/เกิน', async ({ page }) => {
  // ส่วน A (คำขอใหม่)
  await RESET(page);
  await NEW_PAID(page, '1101700123456', 'SV-01', '2026-12-01T09:00:00+07:00');

  const partA = [
    { now: '2026-12-01T09:00:00+07:00', text: 'ปกติ', level: 'normal' },
    { now: '2026-12-02T09:00:00+07:00', text: 'ปกติ', level: 'normal' },
    { now: '2026-12-03T09:00:00+07:00', text: 'ใกล้ครบกำหนด', level: 'near' },
    { now: '2026-12-04T16:30:00+07:00', text: 'ใกล้ครบกำหนด', level: 'near' },
    { now: '2026-12-04T16:30:01+07:00', text: 'เกินกำหนด', level: 'overdue' },
    { now: '2026-12-04T16:31:00+07:00', text: 'เกินกำหนด', level: 'overdue' },
    { now: '2026-12-05T10:00:00+07:00', text: 'เกินกำหนด', level: 'overdue' },
  ];

  for (const row of partA) {
    await CLOCK(page, row.now);
    await page.goto('/citizen/cases/EG-2569-000031');
    await expect(page.getByTestId('sla-level')).toHaveText(row.text);
    await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', row.level);

    const apiCase = await (await page.request.get('/api/cases/EG-2569-000031')).json();
    expect(apiCase.slaLevel).toBe(row.level);
  }

  // ส่วน B (RESET · คำขอ seed EG-2569-000016 กำหนด 8 ธ.ค. 16:30)
  await RESET(page);
  await LOGIN_S(page, 'off.reg2');
  const partB = [
    { now: '2026-12-03T09:00:00+07:00', text: 'ปกติ', level: 'normal' },
    { now: '2026-12-04T09:00:00+07:00', text: 'ใกล้ครบกำหนด', level: 'near' },
    { now: '2026-12-08T16:30:00+07:00', text: 'ใกล้ครบกำหนด', level: 'near' },
    { now: '2026-12-08T16:31:00+07:00', text: 'เกินกำหนด', level: 'overdue' },
  ];

  for (const row of partB) {
    await CLOCK(page, row.now);
    await page.goto('/officer/cases/EG-2569-000016');
    await expect(page.getByTestId('sla-level')).toHaveText(row.text);
    await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', row.level);
  }

  // ส่วน C (RESET · seed ที่ 09:00)
  await RESET(page);
  await LOGIN_S(page, 'off.reg1');
  await page.goto('/officer/queue');

  const queueChecks = [
    { caseNo: 'EG-2569-000020', text: 'เกินกำหนด', level: 'overdue' },
    { caseNo: 'EG-2569-000022', text: 'ใกล้ครบกำหนด', level: 'near' },
    { caseNo: 'EG-2569-000024', text: 'ใกล้ครบกำหนด', level: 'near' },
    { caseNo: 'EG-2569-000025', text: 'ปกติ', level: 'normal' },
  ];

  for (const qc of queueChecks) {
    const qRow = page.locator(`[data-testid="queue-row"][data-case-no="${qc.caseNo}"]`);
    await expect(qRow.getByTestId('row-sla-level')).toHaveText(qc.text);
  }

  await page.goto('/officer/cases/EG-2569-000017');
  await expect(page.getByTestId('sla-level')).toHaveText('หยุดนับ');
  await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', 'paused');

  await LOGIN_C(page, '3100600987659');
  await page.goto('/citizen/cases/EG-2569-000001');
  await expect(page.getByTestId('sla-level')).toHaveText('ปิดแล้ว');
  await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', 'closed');

  await LOGIN_S(page, 'off.reg1');
  await CLOCK(page, '2026-12-01T16:30:00+07:00');
  await page.goto('/officer/cases/EG-2569-000022');
  await expect(page.getByTestId('sla-level')).toHaveText('ใกล้ครบกำหนด');

  await CLOCK(page, '2026-12-01T16:31:00+07:00');
  await page.goto('/officer/cases/EG-2569-000022');
  await expect(page.getByTestId('sla-level')).toHaveText('เกินกำหนด');
});

test('TC-NOTI-01 · ผู้รับแจ้งเตือนตามระดับ', async ({ page }) => {
  await RESET(page);

  // off.reg1
  await LOGIN_S(page, 'off.reg1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('3');
  await expect(page.getByTestId('noti-item')).toHaveCount(3);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"][data-level="near"]')
  ).toHaveText(/คำขอ EG-2569-000024 ใกล้ครบกำหนด/);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000022"][data-level="near"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000020"][data-level="overdue"]')
  ).toHaveText(/คำขอ EG-2569-000020 เกินกำหนด/);

  const reg1Api = await (await page.request.get('/api/notifications')).json();
  expect(reg1Api.items.length).toBe(3);

  // off.reg2
  await LOGIN_S(page, 'off.reg2');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('1');
  await expect(page.getByTestId('noti-item')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"][data-level="near"]')
  ).toHaveCount(1);

  // head1
  await LOGIN_S(page, 'head1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('1');
  await expect(page.getByTestId('noti-item')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000020"][data-level="overdue"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"]')
  ).toHaveCount(0);

  // off.works1
  await LOGIN_S(page, 'off.works1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('0');
  await expect(page.getByTestId('noti-empty')).toHaveText('ไม่มีแจ้งเตือน');

  // ต่อ: CLOCK(2026-12-01T16:31:00+07:00)
  await CLOCK(page, '2026-12-01T16:31:00+07:00');

  await LOGIN_S(page, 'off.reg1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('4');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000022"][data-level="near"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000022"][data-level="overdue"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'head1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('2');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000022"][data-level="overdue"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'off.reg2');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('1');
});

test('TC-NOTI-02 · ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ page }) => {
  // ส่วน A ไม่แจ้งซ้ำ
  await RESET(page);
  await LOGIN_S(page, 'off.reg1');
  await page.request.get('/api/notifications');
  await CLOCK(page, '2026-12-01T16:31:00+07:00');

  for (let i = 0; i < 3; i++) {
    await page.goto('/notifications');
    await page.request.get('/api/notifications');
  }
  for (let i = 0; i < 2; i++) {
    await page.goto('/officer/queue');
  }
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('4');
  await expect(page.getByTestId('noti-item')).toHaveCount(4);

  await LOGIN_S(page, 'head1');
  for (let i = 0; i < 3; i++) {
    await page.goto('/notifications');
    await page.request.get('/api/notifications');
  }
  await expect(page.getByTestId('bell-count')).toHaveText('2');
  await expect(page.getByTestId('noti-item')).toHaveCount(2);

  // ส่วน B ข้ามระดับ: RESET (ยังไม่มี request) · CLOCK(2026-12-05T10:00:00+07:00)
  await RESET(page);
  await CLOCK(page, '2026-12-05T10:00:00+07:00');

  await LOGIN_S(page, 'off.reg1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('7');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"][data-level="overdue"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000022"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000022"][data-level="overdue"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'off.reg2');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('10');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"][data-level="overdue"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'off.works1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('1');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000010"][data-level="overdue"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'head1');
  await page.goto('/notifications');
  await expect(page.getByTestId('bell-count')).toHaveText('15');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000011"][data-level="near"]')
  ).toHaveCount(1);

  // ส่วน C ขั้นรออนุมัติและรอออกเอกสาร (RESET)
  await RESET(page);
  await CLOCK(page, '2026-12-04T09:00:00+07:00');
  await LOGIN_S(page, 'head1');
  await page.goto('/notifications');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000014"][data-level="near"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'off.reg1');
  const reg1NotiC0 = (await (await page.request.get('/api/notifications')).json()).items;
  expect(reg1NotiC0.filter((n: { caseNo: string }) => n.caseNo === 'EG-2569-000014').length).toBe(0);

  await LOGIN_S(page, 'off.reg2');
  const reg2NotiC0 = (await (await page.request.get('/api/notifications')).json()).items;
  expect(reg2NotiC0.filter((n: { caseNo: string }) => n.caseNo === 'EG-2569-000014').length).toBe(0);

  // 1: CLOCK(2026-12-04T16:31:00+07:00)
  await CLOCK(page, '2026-12-04T16:31:00+07:00');
  await LOGIN_S(page, 'head1');
  await page.goto('/notifications');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000014"][data-level="near"]')
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000014"][data-level="overdue"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'off.reg1');
  const reg1NotiC1 = (await (await page.request.get('/api/notifications')).json()).items;
  expect(reg1NotiC1.filter((n: { caseNo: string }) => n.caseNo === 'EG-2569-000014').length).toBe(0);

  // 2: CLOCK(2026-12-08T09:00:00+07:00) → EG-2569-000019 (APPROVED ผู้ออกเอกสาร off.reg1)
  await CLOCK(page, '2026-12-08T09:00:00+07:00');
  await LOGIN_S(page, 'off.reg1');
  await page.goto('/notifications');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000019"][data-level="near"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'off.reg2');
  const reg2NotiC2 = (await (await page.request.get('/api/notifications')).json()).items;
  expect(reg2NotiC2.filter((n: { caseNo: string }) => n.caseNo === 'EG-2569-000019').length).toBe(0);

  await LOGIN_S(page, 'head1');
  const headNotiC2 = (await (await page.request.get('/api/notifications')).json()).items;
  expect(headNotiC2.filter((n: { caseNo: string }) => n.caseNo === 'EG-2569-000019').length).toBe(0);

  // 3: CLOCK(2026-12-09T16:31:00+07:00) → EG-2569-000019 overdue
  await CLOCK(page, '2026-12-09T16:31:00+07:00');
  await LOGIN_S(page, 'off.reg1');
  await page.goto('/notifications');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000019"]')
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000019"][data-level="overdue"]')
  ).toHaveCount(1);

  await LOGIN_S(page, 'head1');
  await page.goto('/notifications');
  await expect(
    page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000019"][data-level="overdue"]')
  ).toHaveCount(1);
});
