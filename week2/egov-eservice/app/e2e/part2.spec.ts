import { test, expect, Page, APIRequestContext, Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const CITIZENS = {
  somchai: '1101700123456',
  somying: '3100600987659',
  mana: '5500400111221',
  piti: '1909900555015',
};

function makePdfBuffer(size = 1024): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const pad = Math.max(0, size - head.length - tail.length);
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

async function reset(request: APIRequestContext) {
  const res = await request.post(`${BASE_URL}/api/test/reset`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
}

async function setClock(request: APIRequestContext, now: string) {
  const res = await request.put(`${BASE_URL}/api/test/clock`, { data: { now } });
  expect(res.status()).toBe(200);
}

async function loginStaffApi(browser: Browser, username: string): Promise<{ ctx: APIRequestContext; close: () => Promise<void> }> {
  const bctx = await browser.newContext({ baseURL: BASE_URL, ...(process.env.PW_VIDEO ? { recordVideo: { dir: `/tmp/pw-p2-videos/${process.env._CUR_TC || "misc"}` } } : {}) });
  const res = await bctx.request.post(`${BASE_URL}/api/auth/staff/login`, {
    data: { username, password: 'Test@1234' },
  });
  expect(res.status()).toBe(200);
  return { ctx: bctx.request, close: () => bctx.close() };
}

async function loginCitizenApi(browser: Browser, idNo: string, otp = '123456'): Promise<{ ctx: APIRequestContext; close: () => Promise<void> }> {
  const bctx = await browser.newContext({ baseURL: BASE_URL, ...(process.env.PW_VIDEO ? { recordVideo: { dir: `/tmp/pw-p2-videos/${process.env._CUR_TC || "misc"}` } } : {}) });
  const r1 = await bctx.request.post(`${BASE_URL}/api/auth/thaid/start`, { data: { idNo } });
  expect(r1.status()).toBe(200);
  const r2 = await bctx.request.post(`${BASE_URL}/api/auth/thaid/verify`, { data: { idNo, otp } });
  expect(r2.status()).toBe(200);
  return { ctx: bctx.request, close: () => bctx.close() };
}

async function loginStaffPage(browser: Browser, username: string): Promise<{ page: Page; req: APIRequestContext; close: () => Promise<void> }> {
  const bctx = await browser.newContext({ baseURL: BASE_URL, ...(process.env.PW_VIDEO ? { recordVideo: { dir: `/tmp/pw-p2-videos/${process.env._CUR_TC || "misc"}` } } : {}) });
  const res = await bctx.request.post(`${BASE_URL}/api/auth/staff/login`, {
    data: { username, password: 'Test@1234' },
  });
  expect(res.status()).toBe(200);
  const page = await bctx.newPage();
  return { page, req: bctx.request, close: () => bctx.close() };
}

async function loginCitizenPage(browser: Browser, idNo: string): Promise<{ page: Page; req: APIRequestContext; close: () => Promise<void> }> {
  const bctx = await browser.newContext({ baseURL: BASE_URL, ...(process.env.PW_VIDEO ? { recordVideo: { dir: `/tmp/pw-p2-videos/${process.env._CUR_TC || "misc"}` } } : {}) });
  const r1 = await bctx.request.post(`${BASE_URL}/api/auth/thaid/start`, { data: { idNo } });
  expect(r1.status()).toBe(200);
  const r2 = await bctx.request.post(`${BASE_URL}/api/auth/thaid/verify`, { data: { idNo, otp: '123456' } });
  expect(r2.status()).toBe(200);
  const page = await bctx.newPage();
  return { page, req: bctx.request, close: () => bctx.close() };
}

async function newPaid(
  browser: Browser,
  request: APIRequestContext,
  opts: { idNo?: string; serviceId: 'SV-01' | 'SV-02' | 'SV-03'; time?: string; qty?: number; areaSqm?: number }
): Promise<{ caseNo: string; receiptNo: string; fee: number }> {
  if (opts.time) {
    await setClock(request, opts.time);
  }
  const idNo = opts.idNo || CITIZENS.somchai;
  const { ctx, close } = await loginCitizenApi(browser, idNo);
  try {
    const draftPayload: Record<string, unknown> = { serviceId: opts.serviceId };
    if (opts.serviceId === 'SV-01') draftPayload.qty = opts.qty ?? 1;
    if (opts.serviceId === 'SV-03') draftPayload.areaSqm = opts.areaSqm ?? 100;

    const dRes = await ctx.post(`${BASE_URL}/api/drafts`, { data: draftPayload });
    expect(dRes.status()).toBe(201);
    const { draftId, fee } = await dRes.json();

    const pdfBuf = makePdfBuffer(1024);
    const reqDocs: Array<{ key: string; name: string }> = [{ key: 'id-card', name: 'id-card.pdf' }];
    if (opts.serviceId === 'SV-02') reqDocs.push({ key: 'map', name: 'map.pdf' });
    if (opts.serviceId === 'SV-03') {
      reqDocs.push({ key: 'plan', name: 'plan.pdf' });
      reqDocs.push({ key: 'deed', name: 'deed.pdf' });
    }
    for (const doc of reqDocs) {
      const fRes = await ctx.post(`${BASE_URL}/api/drafts/${draftId}/files`, {
        multipart: {
          docKey: doc.key,
          file: { name: doc.name, mimeType: 'application/pdf', buffer: pdfBuf },
        },
      });
      expect(fRes.status()).toBe(201);
    }

    const pRes = await ctx.post(`${BASE_URL}/api/drafts/${draftId}/payment`);
    expect(pRes.status()).toBe(201);
    const { ref } = await pRes.json();

    const payRes = await request.post(`${BASE_URL}/api/test/payments/${ref}/pay`, {
      data: { amount: fee },
    });
    expect(payRes.status()).toBe(200);
    const payBody = await payRes.json();
    return { caseNo: payBody.caseNo, receiptNo: payBody.receiptNo, fee };
  } finally {
    await close();
  }
}

function hasKeyDeep(obj: unknown, targetKey: string): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((item) => hasKeyDeep(item, targetKey));
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === targetKey) return true;
    if (hasKeyDeep(v, targetKey)) return true;
  }
  return false;
}

test.describe('Part 2: WORKFLOW, DOC, PDPA, DASH, AUDIT, RBAC, NFR', () => {
  test.beforeEach(async ({}, testInfo) => { process.env._CUR_TC = (testInfo.title.match(/TC-[A-Z0-9-]+/) || ['misc'])[0]; });
  test('TC-WORKFLOW-01 · SV-01 อนุมัติ + ออกเอกสาร', async ({ browser, request }) => {
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const reg1 = await loginStaffApi(browser, 'off.reg1');
    const somying = await loginCitizenPage(browser, CITIZENS.somying);
    const exec1 = await loginStaffApi(browser, 'exec1');
    try {
      await reg2.page.goto('/officer/cases/EG-2569-000025');
      await expect(reg2.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
      await expect(reg2.page.getByTestId('approve-btn')).toHaveCount(1);
      await expect(reg2.page.getByTestId('return-btn')).toHaveCount(1);
      await expect(reg2.page.getByTestId('reject-btn')).toHaveCount(1);
      await expect(reg2.page.getByTestId('forward-btn')).toHaveCount(0);
      await expect(reg2.page.getByTestId('issue-btn')).toHaveCount(0);
      await expect(reg2.page.getByTestId('case-fee')).toHaveText('฿60');

      const forbidRes = await reg1.ctx.post(`${BASE_URL}/api/cases/EG-2569-000026/approve`);
      expect(forbidRes.status()).toBe(403);
      expect((await forbidRes.json()).code).toBe('FORBIDDEN');

      await reg2.page.getByTestId('approve-btn').click();
      await expect(reg2.page.getByTestId('case-status')).toHaveText('อนุมัติ');
      await expect(reg2.page.getByTestId('case-status')).toHaveAttribute('data-status', 'APPROVED');
      await expect(reg2.page.getByTestId('issue-btn')).toHaveCount(1);
      await expect(reg2.page.getByTestId('approve-btn')).toHaveCount(0);

      await reg2.page.getByTestId('issue-btn').click();
      await expect(reg2.page.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
      await expect(reg2.page.getByTestId('case-status')).toHaveAttribute('data-status', 'COMPLETED');
      await expect(reg2.page.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
      const vCode = (await reg2.page.getByTestId('verify-code').textContent())?.trim() || '';
      expect(vCode).toMatch(/^[A-Z0-9]{8}$/);
      await expect(reg2.page.getByTestId('closed-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
      await expect(reg2.page.getByTestId('sla-level')).toHaveText('ปิดแล้ว');

      await somying.page.goto('/citizen/cases/EG-2569-000025');
      await expect(somying.page.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
      await expect(somying.page.getByTestId('download-doc-btn')).toHaveCount(1);

      const pdfRes = await somying.req.get(`${BASE_URL}/api/documents/DOC-2569-000002/pdf`);
      expect(pdfRes.status()).toBe(200);
      expect(pdfRes.headers()['content-type']).toContain('application/pdf');
      expect(pdfRes.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
      const pdfText = (await pdfRes.body()).toString('latin1');
      expect(pdfText).toContain('docNo=DOC-2569-000002 caseNo=EG-2569-000025');

      const dashRes = await exec1.ctx.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`);
      expect(dashRes.status()).toBe(200);
      const dash = await dashRes.json();
      expect(dash.closed).toBe(1);
      expect(dash.onTime).toBe(1);
      expect(dash.received).toBe(3);
      expect(dash.backlog).toBe(20);
    } finally {
      await reg2.close();
      await reg1.close();
      await somying.close();
      await exec1.close();
    }
  });

  test('TC-WORKFLOW-02 · SV-02 ผ่านหัวหน้า', async ({ browser, request }) => {
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const head1 = await loginStaffPage(browser, 'head1');
    const reg1 = await loginStaffPage(browser, 'off.reg1');
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anonPage = await anonCtx.newPage();
    try {
      await reg2.page.goto('/officer/cases/EG-2569-000013');
      await expect(reg2.page.getByTestId('approve-btn')).toHaveCount(0);
      await expect(reg2.page.getByTestId('forward-btn')).toHaveCount(1);
      await expect(reg2.page.getByTestId('forward-target')).toHaveCount(0);

      await reg2.page.getByTestId('forward-btn').click();
      await expect(reg2.page.getByTestId('case-status')).toHaveText('รออนุมัติ');
      await expect(reg2.page.getByTestId('case-status')).toHaveAttribute('data-status', 'PENDING_APPROVAL');

      await reg2.page.goto('/officer/queue');
      await expect(reg2.page.getByTestId('workload-count')).toHaveText('8');
      await expect(reg2.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000013"]')).toHaveCount(0);

      await head1.page.goto('/head/approvals');
      const rows = head1.page.getByTestId('approval-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveAttribute('data-case-no', 'EG-2569-000013');
      await expect(rows.nth(1)).toHaveAttribute('data-case-no', 'EG-2569-000014');
      await expect(rows.nth(2)).toHaveAttribute('data-case-no', 'EG-2569-000011');

      await rows.nth(0).getByTestId('approval-open').click();
      await expect(head1.page.getByTestId('approve-btn')).toHaveCount(1);
      await expect(head1.page.getByTestId('reject-btn')).toHaveCount(1);
      await expect(head1.page.getByTestId('issue-btn')).toHaveCount(0);

      await head1.page.getByTestId('approve-btn').click();
      await expect(head1.page.getByTestId('case-status')).toHaveText('อนุมัติ');
      await expect(head1.page.getByTestId('case-status')).toHaveAttribute('data-status', 'APPROVED');
      await expect(head1.page.getByTestId('issue-btn')).toHaveCount(0);

      await reg1.page.goto('/officer/cases/EG-2569-000013');
      await expect(reg1.page.getByTestId('issue-btn')).toHaveCount(0);
      const issForbid = await reg1.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000013/issue`);
      expect(issForbid.status()).toBe(403);
      expect((await issForbid.json()).code).toBe('FORBIDDEN');

      await reg2.page.goto('/officer/cases/EG-2569-000013');
      await expect(reg2.page.getByTestId('issue-btn')).toHaveCount(1);
      await reg2.page.getByTestId('issue-btn').click();
      await expect(reg2.page.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
      await expect(reg2.page.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
      const vCode1 = (await reg2.page.getByTestId('verify-code').textContent())?.trim() || '';

      await anonPage.goto(`/verify/${vCode1}`);
      await expect(anonPage.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
    } finally {
      await reg2.close();
      await head1.close();
      await reg1.close();
    }

    // Step 8: RESET then off.reg1 issues EG-2569-000019
    await reset(request);
    const reg1After = await loginStaffPage(browser, 'off.reg1');
    try {
      await reg1After.page.goto('/officer/cases/EG-2569-000019');
      await reg1After.page.getByTestId('issue-btn').click();
      await expect(reg1After.page.getByTestId('case-status')).toHaveAttribute('data-status', 'COMPLETED');
      await expect(reg1After.page.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
      const vCode2 = (await reg1After.page.getByTestId('verify-code').textContent())?.trim() || '';
      await anonPage.goto(`/verify/${vCode2}`);
      await expect(anonPage.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
    } finally {
      await reg1After.close();
      await anonCtx.close();
    }
  });

  test('TC-WORKFLOW-03 · SV-03 สามขั้นตอน', async ({ browser, request }) => {
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const works1 = await loginStaffPage(browser, 'off.works1');
    const reg1 = await loginStaffApi(browser, 'off.reg1');
    const head1 = await loginStaffPage(browser, 'head1');
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anonPage = await anonCtx.newPage();
    try {
      await reg2.page.goto('/officer/cases/EG-2569-000012');
      await expect(reg2.page.getByTestId('case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
      await expect(reg2.page.getByTestId('case-fee')).toHaveText('฿1,010');
      await expect(reg2.page.getByTestId('forward-btn')).toHaveCount(1);

      await reg2.page.getByTestId('forward-btn').click();
      await expect(reg2.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
      await expect(reg2.page.getByTestId('case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
      await expect(reg2.page.getByTestId('case-owner')).toHaveText('ยังไม่มีผู้รับ');

      await reg2.page.goto('/officer/queue');
      await expect(reg2.page.getByTestId('workload-count')).toHaveText('8');
      await expect(reg2.page.getByTestId('queue-row')).toHaveCount(16);
      await expect(reg2.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000012"]')).toHaveCount(0);

      await works1.page.goto('/officer/queue');
      const wRows = works1.page.getByTestId('queue-row');
      await expect(wRows).toHaveCount(2);
      await expect(wRows.nth(0)).toHaveAttribute('data-case-no', 'EG-2569-000010');
      await expect(wRows.nth(1)).toHaveAttribute('data-case-no', 'EG-2569-000012');
      await expect(works1.page.getByTestId('claim-btn')).toHaveCount(2);

      const crossClaim = await reg1.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000012/claim`);
      expect(crossClaim.status()).toBe(403);
      expect((await crossClaim.json()).code).toBe('FORBIDDEN');

      await works1.page.goto('/officer/cases/EG-2569-000012');
      await works1.page.getByTestId('claim-btn').click();
      await expect(works1.page.getByTestId('case-owner')).toHaveText('off.works1');
      await works1.page.getByTestId('forward-btn').click();
      await expect(works1.page.getByTestId('case-status')).toHaveText('รออนุมัติ');
      await expect(works1.page.getByTestId('case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');

      await head1.page.goto('/head/approvals');
      await expect(head1.page.getByTestId('approval-row')).toHaveCount(3);
      await expect(head1.page.locator('[data-testid="approval-row"][data-case-no="EG-2569-000012"]')).toHaveCount(1);
      await head1.page.locator('[data-testid="approval-row"][data-case-no="EG-2569-000012"]').getByTestId('approval-open').click();
      await head1.page.getByTestId('approve-btn').click();
      await expect(head1.page.getByTestId('case-status')).toHaveText('อนุมัติ');

      await works1.page.goto('/officer/cases/EG-2569-000012');
      await expect(works1.page.getByTestId('issue-btn')).toHaveCount(0);

      await reg2.page.goto('/officer/cases/EG-2569-000012');
      await expect(reg2.page.getByTestId('issue-btn')).toHaveCount(1);
      await reg2.page.getByTestId('issue-btn').click();
      await expect(reg2.page.getByTestId('case-status')).toHaveText('เสร็จสิ้น');
      const vCode = (await reg2.page.getByTestId('verify-code').textContent())?.trim() || '';

      await anonPage.goto(`/verify/${vCode}`);
      await expect(anonPage.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
    } finally {
      await reg2.close();
      await works1.close();
      await reg1.close();
      await head1.close();
      await anonCtx.close();
    }
  });

  test('TC-WORKFLOW-04 · ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ browser, request }) => {
    // Part A
    await reset(request);
    const reg1A = await loginStaffPage(browser, 'off.reg1');
    const somchaiA = await loginCitizenPage(browser, CITIZENS.somchai);
    try {
      await reg1A.page.goto('/officer/cases/EG-2569-000020');
      await expect(reg1A.page.getByTestId('return-count')).toHaveText('0');
      await reg1A.page.getByTestId('return-btn').click();
      await reg1A.page.getByTestId('return-reason').fill('xxxxxxxxxx');
      await reg1A.page.getByTestId('return-submit').click();
      await expect(reg1A.page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
      await expect(reg1A.page.getByTestId('return-count')).toHaveText('1');

      await somchaiA.page.goto('/citizen/cases/EG-2569-000020');
      await somchaiA.page.getByTestId('submit-fix-btn').click();
      await expect(somchaiA.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');

      await reg1A.page.goto('/officer/cases/EG-2569-000020');
      await reg1A.page.getByTestId('return-btn').click();
      await reg1A.page.getByTestId('return-reason').fill('xxxxxxxxxx');
      await reg1A.page.getByTestId('return-submit').click();
      await expect(reg1A.page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
      await expect(reg1A.page.getByTestId('return-count')).toHaveText('2');

      await somchaiA.page.goto('/citizen/cases/EG-2569-000020');
      await somchaiA.page.getByTestId('submit-fix-btn').click();
      await expect(somchaiA.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');

      await reg1A.page.goto('/officer/cases/EG-2569-000020');
      await expect(reg1A.page.getByTestId('return-btn')).toHaveCount(0);
      await expect(reg1A.page.getByTestId('return-count')).toHaveText('2');
      await expect(reg1A.page.getByTestId('approve-btn')).toHaveCount(1);
      await expect(reg1A.page.getByTestId('reject-btn')).toHaveCount(1);

      const ret3 = await reg1A.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000020/return`, {
        data: { reason: 'xxxxxxxxxx' },
      });
      expect(ret3.status()).toBe(409);
      const ret3Body = await ret3.json();
      expect(ret3Body.code).toBe('RETURN_LIMIT');
      expect(ret3Body.message).toBe('ตีกลับได้สูงสุด 2 ครั้ง');

      const c20 = await (await reg1A.req.get(`${BASE_URL}/api/cases/EG-2569-000020`)).json();
      expect(c20.status).toBe('IN_REVIEW');
      expect(c20.returnCount).toBe(2);
    } finally {
      await reg1A.close();
      await somchaiA.close();
    }

    // Part B: seed EG-2569-000023
    await reset(request);
    const reg1B = await loginStaffPage(browser, 'off.reg1');
    try {
      await reg1B.page.goto('/officer/cases/EG-2569-000023');
      await expect(reg1B.page.getByTestId('return-count')).toHaveText('2');
      await expect(reg1B.page.getByTestId('return-btn')).toHaveCount(0);
      await expect(reg1B.page.getByTestId('approve-btn')).toHaveCount(1);
      await expect(reg1B.page.getByTestId('reject-btn')).toHaveCount(1);
      const retB = await reg1B.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000023/return`, {
        data: { reason: 'xxxxxxxxxx' },
      });
      expect(retB.status()).toBe(409);
      expect((await retB.json()).code).toBe('RETURN_LIMIT');
    } finally {
      await reg1B.close();
    }

    // Part C: SV-02 EG-2569-000013 after 2 returns
    await reset(request);
    const reg2C = await loginStaffPage(browser, 'off.reg2');
    const somchaiC = await loginCitizenApi(browser, CITIZENS.somchai);
    const head1C = await loginStaffPage(browser, 'head1');
    const audit1C = await loginStaffPage(browser, 'audit1');
    try {
      for (let i = 0; i < 2; i++) {
        const r = await reg2C.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000013/return`, {
          data: { reason: 'xxxxxxxxxx' },
        });
        expect(r.status()).toBe(200);
        const s = await somchaiC.ctx.post(`${BASE_URL}/api/cases/EG-2569-000013/resubmit`);
        expect(s.status()).toBe(200);
      }

      await reg2C.page.goto('/officer/cases/EG-2569-000013');
      await expect(reg2C.page.getByTestId('return-btn')).toHaveCount(0);
      await expect(reg2C.page.getByTestId('approve-btn')).toHaveCount(0);
      await expect(reg2C.page.getByTestId('reject-btn')).toHaveCount(0);
      await expect(reg2C.page.getByTestId('forward-btn')).toHaveCount(1);

      const rejRes = await reg2C.req.post(`${BASE_URL}/api/cases/EG-2569-000013/reject`, {
        data: { reason: 'xxxxxxxxxx' },
      });
      expect(rejRes.status()).toBe(403);

      await reg2C.page.getByTestId('forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา');
      await reg2C.page.getByTestId('forward-btn').click();
      await expect(reg2C.page.getByTestId('case-status')).toHaveText('รออนุมัติ');

      await audit1C.page.goto('/audit');
      const fwdRow = audit1C.page.locator('[data-testid="audit-row"][data-event="FORWARD"][data-case-no="EG-2569-000013"]');
      await expect(fwdRow).toHaveCount(1);
      await expect(fwdRow.getByTestId('audit-detail')).toContainText('ส่งต่อให้หัวหน้าพิจารณา');

      await head1C.page.goto('/officer/cases/EG-2569-000013');
      await expect(head1C.page.getByTestId('reject-btn')).toHaveCount(1);
      await expect(head1C.page.getByTestId('approve-btn')).toHaveCount(1);
    } finally {
      await reg2C.close();
      await somchaiC.close();
      await head1C.close();
      await audit1C.close();
    }
  });

  test('TC-WORKFLOW-05 · เหตุผล ≥ 10 ตัวอักษร (ตีกลับ/ไม่อนุมัติ)', async ({ browser, request }) => {
    // Part A: Return EG-2569-000020
    await reset(request);
    const reg1 = await loginStaffPage(browser, 'off.reg1');
    const somchai = await loginCitizenPage(browser, CITIZENS.somchai);
    try {
      await reg1.page.goto('/officer/cases/EG-2569-000020');
      await reg1.page.getByTestId('return-btn').click();
      await reg1.page.getByTestId('return-reason').fill('xxxxxxxxx');
      await reg1.page.getByTestId('return-submit').click();
      await expect(reg1.page.getByTestId('return-reason-error')).toHaveText('กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร');
      await expect(reg1.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');

      const apiShort = await reg1.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000020/return`, {
        data: { reason: 'xxxxxxxxx' },
      });
      expect(apiShort.status()).toBe(400);
      expect((await apiShort.json()).code).toBe('REASON_TOO_SHORT');

      await reg1.page.getByTestId('return-reason').fill('          ');
      await reg1.page.getByTestId('return-submit').click();
      await expect(reg1.page.getByTestId('return-reason-error')).toHaveText('กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร');

      await reg1.page.getByTestId('return-reason').fill('xxxxxxxxxx');
      await reg1.page.getByTestId('return-submit').click();
      await expect(reg1.page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');

      await somchai.page.goto('/citizen/cases/EG-2569-000020');
      await expect(somchai.page.getByTestId('return-reason-display')).toHaveText('xxxxxxxxxx');
    } finally {
      await reg1.close();
      await somchai.close();
    }

    // Part B: Reject SV-01 EG-2569-000026
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const somchaiB = await loginCitizenPage(browser, CITIZENS.somchai);
    const exec1 = await loginStaffApi(browser, 'exec1');
    try {
      await reg2.page.goto('/officer/cases/EG-2569-000026');
      await reg2.page.getByTestId('reject-btn').click();
      await reg2.page.getByTestId('reject-reason').fill('xxxxxxxxx');
      await reg2.page.getByTestId('reject-submit').click();
      await expect(reg2.page.getByTestId('reject-reason-error')).toHaveText('กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร');

      const apiRejShort = await reg2.req.post(`${BASE_URL}/api/cases/EG-2569-000026/reject`, {
        data: { reason: 'xxxxxxxxx' },
      });
      expect(apiRejShort.status()).toBe(400);
      expect((await apiRejShort.json()).code).toBe('REASON_TOO_SHORT');

      await reg2.page.getByTestId('reject-reason').fill('xxxxxxxxxx');
      await reg2.page.getByTestId('reject-submit').click();
      await expect(reg2.page.getByTestId('case-status')).toHaveText('ไม่อนุมัติ');
      await expect(reg2.page.getByTestId('case-status')).toHaveAttribute('data-status', 'REJECTED');
      await expect(reg2.page.getByTestId('closed-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
      await expect(reg2.page.getByTestId('sla-level')).toHaveText('ปิดแล้ว');

      await somchaiB.page.goto('/citizen/cases/EG-2569-000026');
      await expect(somchaiB.page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');

      const dashRes = await exec1.ctx.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`);
      const dash = await dashRes.json();
      expect(dash.closed).toBe(1);
      expect(dash.onTime).toBe(1);
    } finally {
      await reg2.close();
      await somchaiB.close();
      await exec1.close();
    }

    // Part C: Head reject EG-2569-000011
    await reset(request);
    const head1 = await loginStaffApi(browser, 'head1');
    try {
      const r1 = await head1.ctx.post(`${BASE_URL}/api/cases/EG-2569-000011/reject`, {
        data: { reason: 'xxxxxxxxx' },
      });
      expect(r1.status()).toBe(400);
      const r2 = await head1.ctx.post(`${BASE_URL}/api/cases/EG-2569-000011/reject`, {
        data: { reason: 'xxxxxxxxxx' },
      });
      expect(r2.status()).toBe(200);
      expect((await r2.json()).status).toBe('REJECTED');
    } finally {
      await head1.close();
    }
  });

  test('TC-WORKFLOW-06 · เวลาแก้ไข 168 ชั่วโมง', async ({ browser, request }) => {
    await reset(request);
    const somchai0 = await loginCitizenPage(browser, CITIZENS.somchai);
    try {
      await somchai0.page.goto('/citizen/cases/EG-2569-000017');
      await expect(somchai0.page.getByTestId('case-status')).toHaveText('รอแก้ไขเอกสาร');
      await expect(somchai0.page.getByTestId('return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
      await expect(somchai0.page.getByTestId('fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
      await expect(somchai0.page.getByTestId('fix-deadline')).toHaveAttribute('data-iso', '2026-12-04T14:00:00+07:00');
      await expect(somchai0.page.getByTestId('submit-fix-btn')).toHaveCount(1);
    } finally {
      await somchai0.close();
    }

    // Round A: 167:59
    await reset(request);
    await setClock(request, '2026-12-04T13:59:00+07:00');
    const somchaiA = await loginCitizenPage(browser, CITIZENS.somchai);
    try {
      await somchaiA.page.goto('/citizen/cases/EG-2569-000017');
      await expect(somchaiA.page.getByTestId('submit-fix-btn')).toBeEnabled();
      await somchaiA.page.getByTestId('submit-fix-btn').click();
      await expect(somchaiA.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
      await expect(somchaiA.page.getByTestId('case-status')).toHaveAttribute('data-status', 'IN_REVIEW');
    } finally {
      await somchaiA.close();
    }

    // Round B: 168:00
    await reset(request);
    await setClock(request, '2026-12-04T14:00:00+07:00');
    const somchaiB = await loginCitizenPage(browser, CITIZENS.somchai);
    const exec1 = await loginStaffApi(browser, 'exec1');
    try {
      await somchaiB.page.goto('/citizen/cases/EG-2569-000017');
      await expect(somchaiB.page.getByTestId('case-status')).toHaveText('ยกเลิก');
      await expect(somchaiB.page.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
      await expect(somchaiB.page.getByTestId('submit-fix-btn')).toHaveCount(0);
      await expect(somchaiB.page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
      await expect(
        somchaiB.page.locator('[data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]')
      ).toHaveCount(1);

      const resubRes = await somchaiB.req.post(`${BASE_URL}/api/cases/EG-2569-000017/resubmit`);
      expect(resubRes.status()).toBe(409);

      const dash = await (await exec1.ctx.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`)).json();
      expect(dash.backlog).toBe(20);
    } finally {
      await somchaiB.close();
      await exec1.close();
    }
  });

  test('TC-DOC-01 · ออกเอกสารและข้อมูลใน PDF', async ({ browser, request }) => {
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const somying = await loginCitizenApi(browser, CITIZENS.somying);
    const somchai = await loginCitizenApi(browser, CITIZENS.somchai);
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anonPage = await anonCtx.newPage();
    try {
      const appRes = await reg2.req.post(`${BASE_URL}/api/cases/EG-2569-000025/approve`);
      expect(appRes.status()).toBe(200);
      const issRes = await reg2.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/issue`);
      expect(issRes.status()).toBe(200);
      const issBody = await issRes.json();
      expect(issBody.docNo).toBe('DOC-2569-000002');
      expect(issBody.status).toBe('COMPLETED');
      expect(issBody.verifyCode).toMatch(/^[A-Z0-9]{8}$/);
      const vCode = issBody.verifyCode;

      const pdfRes = await somying.ctx.get(`${BASE_URL}/api/documents/DOC-2569-000002/pdf`);
      expect(pdfRes.status()).toBe(200);
      expect(pdfRes.headers()['content-type']).toContain('application/pdf');
      expect(pdfRes.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
      const pdfStr = (await pdfRes.body()).toString('latin1');
      expect(pdfStr).toContain(`docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=${vCode} validUntil=2027-02-28`);

      await anonPage.goto(`/verify/${vCode}`);
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');
      await expect(anonPage.getByTestId('verify-doc-no')).toHaveText('DOC-2569-000002');
      await expect(anonPage.getByTestId('verify-applicant')).toHaveText('สมหญิง ร***');
      await expect(anonPage.getByTestId('verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
      await expect(anonPage.getByTestId('verify-issued')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
      await expect(anonPage.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2027-02-28');
      await expect(anonPage.getByTestId('verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 2');

      await reg2.page.goto('/officer/cases/EG-2569-000025');
      const qrUrl = await reg2.page.getByTestId('doc-qr').getAttribute('data-url');
      expect(qrUrl).toContain(`/verify/${vCode}`);

      const verApi = await anonCtx.request.get(`${BASE_URL}/api/verify/${vCode}`);
      expect(verApi.status()).toBe(200);
      const verJson = await verApi.json();
      expect(verJson.result).toBe('VALID');
      expect(verJson.validUntil).toBe('2027-02-28');
      expect(verJson.issuedAt).toBe('2026-12-01T09:00:00+07:00');

      const otherPdf = await somchai.ctx.get(`${BASE_URL}/api/documents/DOC-2569-000002/pdf`);
      expect(otherPdf.status()).toBe(404);

      const dupIss = await reg2.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/issue`);
      expect(dupIss.status()).toBe(409);
      expect((await dupIss.json()).code).toBe('INVALID_STATE');
    } finally {
      await reg2.close();
      await somying.close();
      await somchai.close();
      await anonCtx.close();
    }
  });

  test('TC-DOC-02 · ตรวจเอกสาร /verify', async ({ browser, request }) => {
    await reset(request);
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const page = await anonCtx.newPage();
    try {
      const r1 = await page.goto('/verify/K7M2Q9XA');
      expect(r1?.status()).toBe(200);
      expect(page.url()).toContain('/verify/K7M2Q9XA');
      await expect(page.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');
      await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'VALID');
      await expect(page.getByTestId('verify-doc-no')).toHaveText('DOC-2569-000001');
      await expect(page.getByTestId('verify-applicant')).toHaveText('สมชาย ใ***');
      await expect(page.getByTestId('verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
      await expect(page.getByTestId('verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
      await expect(page.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2027-02-02');
      await expect(page.getByTestId('verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 1');

      const bodyText = await page.locator('body').innerText();
      expect(bodyText).not.toContain('ใจดี');
      expect(bodyText).not.toContain('1101700123456');

      const api1 = await anonCtx.request.get(`${BASE_URL}/api/verify/K7M2Q9XA`);
      expect(api1.status()).toBe(200);
      const j1 = await api1.json();
      expect(j1.result).toBe('VALID');
      expect(j1.applicantMasked).toBe('สมชาย ใ***');

      const r2 = await page.goto('/verify/ZZZZZZZZ');
      expect(r2?.status()).toBe(404);
      await expect(page.getByTestId('verify-result')).toHaveText('ไม่พบเอกสาร');
      await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'NOT_FOUND');
      await expect(page.getByTestId('verify-applicant')).toHaveCount(0);
      await expect(page.getByTestId('verify-doc-no')).toHaveCount(0);

      const api2 = await anonCtx.request.get(`${BASE_URL}/api/verify/ZZZZZZZZ`);
      expect(api2.status()).toBe(404);
      expect((await api2.json()).result).toBe('NOT_FOUND');
    } finally {
      await anonCtx.close();
    }
  });

  test('TC-DOC-03 · เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ browser, request }) => {
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anonPage = await anonCtx.newPage();
    try {
      // Part A: SV-01 issued 1 Dec 2026 (90 days)
      await reset(request);
      const reg2A = await loginStaffApi(browser, 'off.reg2');
      await reg2A.ctx.post(`${BASE_URL}/api/cases/EG-2569-000025/approve`);
      const issA = await (await reg2A.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/issue`)).json();
      await reg2A.close();

      await setClock(request, '2027-02-28T23:59:00+07:00');
      await anonPage.goto(`/verify/${issA.verifyCode}`);
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');
      await expect(anonPage.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2027-02-28');

      await setClock(request, '2027-03-01T00:00:00+07:00');
      const resA2 = await anonPage.goto(`/verify/${issA.verifyCode}`);
      expect(resA2?.status()).toBe(200);
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารหมดอายุ');
      await expect(anonPage.getByTestId('verify-result')).toHaveAttribute('data-result', 'EXPIRED');
      await expect(anonPage.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2027-02-28');

      // Part B: SV-02 issued 1 Dec 2026 (1 year)
      await reset(request);
      const reg1B = await loginStaffApi(browser, 'off.reg1');
      const issB = await (await reg1B.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000019/issue`)).json();
      await reg1B.close();

      await setClock(request, '2027-11-30T23:59:00+07:00');
      await anonPage.goto(`/verify/${issB.verifyCode}`);
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');
      await expect(anonPage.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2027-11-30');

      await setClock(request, '2027-12-01T00:00:00+07:00');
      await anonPage.goto(`/verify/${issB.verifyCode}`);
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารหมดอายุ');

      // Part C: seed K7M2Q9XA
      await reset(request);
      await setClock(request, '2027-02-02T23:59:00+07:00');
      await anonPage.goto('/verify/K7M2Q9XA');
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');

      await setClock(request, '2027-02-03T00:00:00+07:00');
      await anonPage.goto('/verify/K7M2Q9XA');
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารหมดอายุ');

      // Part E: Leap day 2028-02-29
      await reset(request);
      await setClock(request, '2028-02-29T10:00:00+07:00');
      const reg2E = await loginStaffApi(browser, 'off.reg2');
      const reg1E = await loginStaffApi(browser, 'off.reg1');
      await reg2E.ctx.post(`${BASE_URL}/api/cases/EG-2569-000025/approve`);
      const docE1 = await (await reg2E.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/issue`)).json();
      const docE2 = await (await reg1E.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000019/issue`)).json();
      await reg2E.close();
      await reg1E.close();

      expect(docE1.docNo).toBe('DOC-2571-000001');
      expect(docE2.docNo).toBe('DOC-2571-000002');

      await setClock(request, '2028-05-28T23:59:00+07:00');
      await anonPage.goto(`/verify/${docE1.verifyCode}`);
      await expect(anonPage.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2028-05-28');
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');

      await setClock(request, '2028-05-29T00:00:00+07:00');
      await anonPage.goto(`/verify/${docE1.verifyCode}`);
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารหมดอายุ');

      await setClock(request, '2029-02-27T23:59:00+07:00');
      await anonPage.goto(`/verify/${docE2.verifyCode}`);
      await expect(anonPage.getByTestId('verify-expires')).toHaveAttribute('data-iso', '2029-02-27');
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');

      await setClock(request, '2029-02-28T00:00:00+07:00');
      await anonPage.goto(`/verify/${docE2.verifyCode}`);
      await expect(anonPage.getByTestId('verify-result')).toHaveText('เอกสารหมดอายุ');

      // Part D: Tamper
      await reset(request);
      const tRes = await request.post(`${BASE_URL}/api/test/documents/DOC-2569-000001/tamper`);
      expect(tRes.status()).toBe(200);
      expect((await tRes.json()).ok).toBe(true);

      await anonPage.goto('/verify/K7M2Q9XA');
      await expect(anonPage.getByTestId('verify-result')).toHaveText('ลายเซ็นไม่ถูกต้อง');
      await expect(anonPage.getByTestId('verify-result')).toHaveAttribute('data-result', 'TAMPERED');
      await expect(anonPage.getByTestId('verify-doc-no')).toHaveCount(0);
      await expect(anonPage.getByTestId('verify-applicant')).toHaveCount(0);

      await setClock(request, '2027-03-01T00:00:00+07:00');
      await anonPage.goto('/verify/K7M2Q9XA');
      await expect(anonPage.getByTestId('verify-result')).toHaveText('ลายเซ็นไม่ถูกต้อง');
    } finally {
      await anonCtx.close();
    }
  });

  test('TC-PDPA-01 · ปิดบังเลขบัตรบนจอ', async ({ browser, request }) => {
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const head1 = await loginStaffPage(browser, 'head1');
    const somying = await loginCitizenPage(browser, CITIZENS.somying);
    const somchai = await loginCitizenPage(browser, CITIZENS.somchai);
    try {
      await reg2.page.goto('/officer/queue');
      const maskedCells = reg2.page.getByTestId('row-id-masked');
      const count = await maskedCells.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const txt = (await maskedCells.nth(i).textContent())?.trim() || '';
        expect(txt).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
      }
      await expect(
        reg2.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000025"]').getByTestId('row-id-masked')
      ).toHaveText('X-XXXX-XXXXX-65-9');
      await expect(
        reg2.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000026"]').getByTestId('row-id-masked')
      ).toHaveText('X-XXXX-XXXXX-45-6');

      await reg2.page.goto('/officer/cases/EG-2569-000025');
      await expect(reg2.page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
      const html = await reg2.page.content();
      expect(html).not.toContain('3100600987659');
      expect(html).not.toContain('3-1006-00987-65-9');

      await head1.page.goto('/officer/cases/EG-2569-000025');
      await expect(head1.page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');

      await somying.page.goto('/citizen/cases/EG-2569-000025');
      await expect(somying.page.getByTestId('case-id-full')).toHaveText('3-1006-00987-65-9');

      await somchai.page.goto('/citizen/cases/EG-2569-000020');
      await expect(somchai.page.getByTestId('case-id-full')).toHaveText('1-1017-00123-45-6');
    } finally {
      await reg2.close();
      await head1.close();
      await somying.close();
      await somchai.close();
    }
  });

  test('TC-PDPA-02 · API (JSON) ไม่ส่งเลขบัตรเต็ม', async ({ browser, request }) => {
    await reset(request);
    const endpoints = [
      '/api/officer/queue?filter=all',
      '/api/cases/EG-2569-000025',
      '/api/cases/EG-2569-000026',
      '/api/cases/EG-2569-000020',
      '/api/notifications',
      '/api/cases/EG-2569-000025/files',
    ];

    for (const user of ['off.reg1', 'head1']) {
      const staff = await loginStaffApi(browser, user);
      try {
        for (const ep of endpoints) {
          const res = await staff.ctx.get(`${BASE_URL}${ep}`);
          expect(res.status()).toBe(200);
          const data = await res.json();
          const raw = JSON.stringify(data);
          expect(raw).not.toMatch(/\d{13}/);
          expect(raw).not.toMatch(/\d-\d{4}-\d{5}-\d{2}-\d/);
          expect(hasKeyDeep(data, 'idNo')).toBe(false);
          expect(raw).not.toContain('3100600987659');
          expect(raw).not.toContain('1101700123456');
          expect(raw).not.toContain('1909900555015');

          if (ep.includes('/api/officer/queue')) {
            for (const item of data.items) {
              expect(item.idMasked).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
            }
          }
          if (ep.startsWith('/api/cases/EG-2569-') && !ep.endsWith('/files')) {
            expect(data.idMasked).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
          }
        }
      } finally {
        await staff.close();
      }
    }
  });

  test('TC-PDPA-03 · แสดงเลขเต็มต้องมีเหตุผลและ Audit', async ({ browser, request }) => {
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const audit1 = await loginStaffPage(browser, 'audit1');
    const exec1 = await loginStaffApi(browser, 'exec1');
    const somying = await loginCitizenApi(browser, CITIZENS.somying);
    try {
      await reg2.page.goto('/officer/cases/EG-2569-000025');
      await reg2.page.getByTestId('show-full-id-btn').click();
      await reg2.page.getByTestId('unmask-submit').click();
      await expect(reg2.page.getByTestId('unmask-error')).toHaveText('กรุณากรอกเหตุผล');
      await expect(reg2.page.getByTestId('full-id')).toHaveCount(0);

      const apiEmpty = await reg2.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/unmask`, {
        data: { reason: '' },
      });
      expect(apiEmpty.status()).toBe(400);
      expect((await apiEmpty.json()).code).toBe('REASON_REQUIRED');

      await reg2.page.getByTestId('unmask-reason').fill('    ');
      await reg2.page.getByTestId('unmask-submit').click();
      await expect(reg2.page.getByTestId('unmask-error')).toHaveText('กรุณากรอกเหตุผล');

      await reg2.page.getByTestId('unmask-reason').fill('ตรวจสอบตัวตนซ้ำ');
      await reg2.page.getByTestId('unmask-submit').click();
      await expect(reg2.page.getByTestId('full-id')).toHaveText('3-1006-00987-65-9');

      await reg2.page.reload();
      await expect(reg2.page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
      await expect(reg2.page.getByTestId('full-id')).toHaveCount(0);

      await audit1.page.goto('/audit');
      await audit1.page.getByTestId('audit-filter-event').selectOption('UNMASK');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('1');
      const row = audit1.page.getByTestId('audit-row').first();
      await expect(row).toHaveAttribute('data-actor', 'off.reg2');
      await expect(row.getByTestId('audit-role')).toHaveText('officer');
      await expect(row.getByTestId('audit-case-no')).toHaveText('EG-2569-000025');
      await expect(row.getByTestId('audit-event')).toHaveText('UNMASK');
      await expect(row.getByTestId('audit-detail')).toContainText('ตรวจสอบตัวตนซ้ำ');
      await expect(row.getByTestId('audit-time')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');

      for (const caller of [exec1.ctx, audit1.req, somying.ctx]) {
        const fRes = await caller.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/unmask`, {
          data: { reason: 'x' },
        });
        expect(fRes.status()).toBe(403);
      }
    } finally {
      await reg2.close();
      await audit1.close();
      await exec1.close();
      await somying.close();
    }
  });

  test('TC-DASH-01 · Dashboard ตัวเลขเริ่มต้น', async ({ browser, request }) => {
    await reset(request);
    const exec1 = await loginStaffPage(browser, 'exec1');
    try {
      await exec1.page.goto('/dashboard');
      await expect(exec1.page.getByTestId('period-select')).toHaveValue('2026-12');
      await expect(exec1.page.getByTestId('service-select')).toHaveValue('ALL');

      await expect(exec1.page.getByTestId('kpi-received')).toHaveText('3');
      await expect(exec1.page.getByTestId('kpi-closed')).toHaveText('0');
      await expect(exec1.page.getByTestId('kpi-ontime-pct')).toHaveText('–');
      await expect(exec1.page.getByTestId('kpi-backlog')).toHaveText('21');
      await expect(exec1.page.getByTestId('kpi-overdue')).toHaveText('1');

      const wRows = exec1.page.getByTestId('workload-row');
      await expect(wRows).toHaveCount(3);
      await expect(
        exec1.page.locator('[data-testid="workload-row"][data-username="off.reg1"]').getByTestId('workload-value')
      ).toHaveText('3');
      await expect(
        exec1.page.locator('[data-testid="workload-row"][data-username="off.reg2"]').getByTestId('workload-value')
      ).toHaveText('9');
      await expect(
        exec1.page.locator('[data-testid="workload-row"][data-username="off.works1"]').getByTestId('workload-value')
      ).toHaveText('0');

      const apiAll = await (await exec1.req.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`)).json();
      expect(apiAll.received).toBe(3);
      expect(apiAll.closed).toBe(0);
      expect(apiAll.ontimePct).toBeNull();
      expect(apiAll.backlog).toBe(21);
      expect(apiAll.overdue).toBe(1);

      const text = await exec1.page.locator('body').innerText();
      expect(text).not.toMatch(/\d{13}/);
      expect(text).not.toMatch(/0\d{9}/);
      for (const name of ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ']) {
        expect(text).not.toContain(name);
      }

      const bySvc: Array<{ svc: string; rec: string; cls: string; pct: string; bl: string; ov: string }> = [
        { svc: 'SV-01', rec: '3', cls: '0', pct: '–', bl: '11', ov: '1' },
        { svc: 'SV-02', rec: '0', cls: '0', pct: '–', bl: '7', ov: '0' },
        { svc: 'SV-03', rec: '0', cls: '0', pct: '–', bl: '3', ov: '0' },
      ];
      for (const row of bySvc) {
        await exec1.page.getByTestId('service-select').selectOption(row.svc);
        await expect(exec1.page.getByTestId('kpi-received')).toHaveText(row.rec);
        await expect(exec1.page.getByTestId('kpi-closed')).toHaveText(row.cls);
        await expect(exec1.page.getByTestId('kpi-ontime-pct')).toHaveText(row.pct);
        await expect(exec1.page.getByTestId('kpi-backlog')).toHaveText(row.bl);
        await expect(exec1.page.getByTestId('kpi-overdue')).toHaveText(row.ov);
      }
    } finally {
      await exec1.close();
    }
  });

  test('TC-DASH-02 · Dashboard ย้อนหลัง พ.ย. ต.ค. รายปี', async ({ browser, request }) => {
    await reset(request);
    const exec1 = await loginStaffPage(browser, 'exec1');
    try {
      await exec1.page.goto('/dashboard');
      const cases = [
        { period: '2026-10', service: 'ALL', rec: 1, cls: 1, pctText: '100.0%', pctNum: 100, bl: 21, ov: 1 },
        { period: '2026-11', service: 'ALL', rec: 26, cls: 7, pctText: '85.7%', pctNum: 85.7, bl: 21, ov: 1 },
        { period: '2026-11', service: 'SV-01', rec: 12, cls: 3, pctText: '100.0%', pctNum: 100, bl: 11, ov: 1 },
        { period: '2026-11', service: 'SV-02', rec: 10, cls: 3, pctText: '66.7%', pctNum: 66.7, bl: 7, ov: 0 },
        { period: '2026-11', service: 'SV-03', rec: 4, cls: 1, pctText: '100.0%', pctNum: 100, bl: 3, ov: 0 },
        { period: '2026', service: 'ALL', rec: 30, cls: 8, pctText: '87.5%', pctNum: 87.5, bl: 21, ov: 1 },
        { period: '2026', service: 'SV-01', rec: 16, cls: 4, pctText: '100.0%', pctNum: 100, bl: 11, ov: 1 },
        { period: '2026', service: 'SV-02', rec: 10, cls: 3, pctText: '66.7%', pctNum: 66.7, bl: 7, ov: 0 },
        { period: '2026', service: 'SV-03', rec: 4, cls: 1, pctText: '100.0%', pctNum: 100, bl: 3, ov: 0 },
      ];
      for (const c of cases) {
        await exec1.page.getByTestId('period-select').selectOption(c.period);
        await exec1.page.getByTestId('service-select').selectOption(c.service);
        await expect(exec1.page.getByTestId('kpi-received')).toHaveText(String(c.rec));
        await expect(exec1.page.getByTestId('kpi-closed')).toHaveText(String(c.cls));
        await expect(exec1.page.getByTestId('kpi-ontime-pct')).toHaveText(c.pctText);
        await expect(exec1.page.getByTestId('kpi-backlog')).toHaveText(String(c.bl));
        await expect(exec1.page.getByTestId('kpi-overdue')).toHaveText(String(c.ov));

        const apiRes = await exec1.req.get(`${BASE_URL}/api/dashboard?period=${c.period}&service=${c.service}`);
        expect(apiRes.status()).toBe(200);
        const apiBody = await apiRes.json();
        expect(apiBody.received).toBe(c.rec);
        expect(apiBody.closed).toBe(c.cls);
        expect(apiBody.ontimePct).toBeCloseTo(c.pctNum, 1);
        expect(apiBody.backlog).toBe(c.bl);
        expect(apiBody.overdue).toBe(c.ov);
      }
    } finally {
      await exec1.close();
    }
  });

  test('TC-DASH-03 · ส่งออก Excel/PDF เท่าหน้าจอ และไม่มีข้อมูลส่วนบุคคล', async ({ browser, request }) => {
    await reset(request);
    const exec1 = await loginStaffPage(browser, 'exec1');
    const audit1 = await loginStaffPage(browser, 'audit1');

    async function extractXlsxText(buf: Buffer): Promise<string> {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const XLSX = require('xlsx');
        const wb = XLSX.read(buf, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        return rows.map((r) => r.join('=')).join('\n');
      } catch {
        // try exceljs
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const ExcelJS = require('exceljs');
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf);
          const ws = wb.worksheets[0];
          const lines: string[] = [];
          ws.eachRow((row: { values: unknown[] }) => {
            lines.push(row.values.slice(1).join('='));
          });
          return lines.join('\n');
        } catch {
          return buf.toString('utf8');
        }
      }
    }

    try {
      await exec1.page.goto('/dashboard');
      await exec1.page.getByTestId('period-select').selectOption('2026-11');
      await exec1.page.getByTestId('service-select').selectOption('ALL');

      const xlsxNovRes = await exec1.req.get(`${BASE_URL}/api/dashboard/export?format=xlsx&period=2026-11&service=ALL`);
      expect(xlsxNovRes.status()).toBe(200);
      const xlsxNovText = await extractXlsxText(await xlsxNovRes.body());
      expect(xlsxNovText).toContain('รับเรื่อง=26');
      expect(xlsxNovText).toContain('ปิดงาน=7');
      expect(xlsxNovText).toContain('ทันกำหนด %=85.7%');
      expect(xlsxNovText).toContain('งานคงค้าง=21');
      expect(xlsxNovText).toContain('เกินกำหนดคงค้าง=1');

      const pdfNovRes = await exec1.req.get(`${BASE_URL}/api/dashboard/export?format=pdf&period=2026-11&service=ALL`);
      expect(pdfNovRes.status()).toBe(200);
      expect(pdfNovRes.headers()['content-type']).toContain('application/pdf');
      const pdfNovRaw = (await pdfNovRes.body()).toString('latin1');
      expect(pdfNovRaw).toContain('kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1');
      const pdfNovText = [
        ...(pdfNovRaw.match(/^% .+$/gm) || []),
        ...[...pdfNovRaw.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('utf8')),
      ].join('\n');

      const xlsxDecRes = await exec1.req.get(`${BASE_URL}/api/dashboard/export?format=xlsx&period=2026-12&service=ALL`);
      expect(xlsxDecRes.status()).toBe(200);
      const xlsxDecText = await extractXlsxText(await xlsxDecRes.body());
      expect(xlsxDecText).toContain('รับเรื่อง=3');
      expect(xlsxDecText).toContain('ปิดงาน=0');
      expect(xlsxDecText).toContain('ทันกำหนด %=–');
      expect(xlsxDecText).toContain('งานคงค้าง=21');
      expect(xlsxDecText).toContain('เกินกำหนดคงค้าง=1');

      for (const content of [xlsxNovText, pdfNovText, xlsxDecText]) {
        expect(content).not.toMatch(/\d{13}/);
        expect(content).not.toMatch(/0\d{9}/);
        for (const name of ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ']) {
          expect(content).not.toContain(name);
        }
      }

      await audit1.page.goto('/audit');
      await audit1.page.getByTestId('audit-filter-event').selectOption('EXPORT');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('3');
      const rows = audit1.page.getByTestId('audit-row');
      for (let i = 0; i < 3; i++) {
        await expect(rows.nth(i)).toHaveAttribute('data-actor', 'exec1');
        await expect(rows.nth(i).getByTestId('audit-role')).toHaveText('executive');
      }
    } finally {
      await exec1.close();
      await audit1.close();
    }
  });

  test('TC-DASH-04 · ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ browser, request }) => {
    await reset(request);
    await setClock(request, '2026-12-03T16:00:00+07:00');
    const reg1 = await loginStaffApi(browser, 'off.reg1');
    const reg2 = await loginStaffApi(browser, 'off.reg2');
    const exec1 = await loginStaffPage(browser, 'exec1');
    try {
      // Step 1: at 16:00:00 approve 000025 and 000023
      expect((await reg2.ctx.post(`${BASE_URL}/api/cases/EG-2569-000025/approve`)).status()).toBe(200);
      expect((await reg1.ctx.post(`${BASE_URL}/api/cases/EG-2569-000023/approve`)).status()).toBe(200);

      // Step 2: 16:29:59 issue 000025
      await setClock(request, '2026-12-03T16:29:59+07:00');
      expect((await reg2.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/issue`)).status()).toBe(200);
      const c25 = await (await reg2.ctx.get(`${BASE_URL}/api/cases/EG-2569-000025`)).json();
      expect(c25.closedAt).toBe('2026-12-03T16:29:59+07:00');

      const d2 = await (await exec1.req.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`)).json();
      expect(d2.closed).toBe(1);
      expect(d2.onTime).toBe(1);

      // Step 3: 16:30:00 reject 000026
      await setClock(request, '2026-12-03T16:30:00+07:00');
      expect(
        (
          await reg2.ctx.post(`${BASE_URL}/api/cases/EG-2569-000026/reject`, {
            data: { reason: 'xxxxxxxxxx' },
          })
        ).status()
      ).toBe(200);
      const c26 = await (await reg2.ctx.get(`${BASE_URL}/api/cases/EG-2569-000026`)).json();
      expect(c26.closedAt).toBe('2026-12-03T16:30:00+07:00');

      const d3 = await (await exec1.req.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`)).json();
      expect(d3.closed).toBe(2);
      expect(d3.onTime).toBe(2);

      // Step 4: 16:30:01 issue 000023
      await setClock(request, '2026-12-03T16:30:01+07:00');
      expect((await reg1.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000023/issue`)).status()).toBe(200);
      const c23 = await (await reg1.ctx.get(`${BASE_URL}/api/cases/EG-2569-000023`)).json();
      expect(c23.closedAt).toBe('2026-12-03T16:30:01+07:00');

      const d4 = await (await exec1.req.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`)).json();
      expect(d4.closed).toBe(3);
      expect(d4.onTime).toBe(2);
      expect(d4.backlog).toBe(18);

      await exec1.page.goto('/dashboard');
      await expect(exec1.page.getByTestId('kpi-closed')).toHaveText('3');
      await expect(exec1.page.getByTestId('kpi-backlog')).toHaveText('18');
    } finally {
      await reg1.close();
      await reg2.close();
      await exec1.close();
    }
  });

  test('TC-AUDIT-01 · เหตุการณ์และฟิลด์ใน Audit', async ({ browser, request }) => {
    await reset(request);
    // 1. off.reg2 login + claim 000028
    const reg2 = await loginStaffApi(browser, 'off.reg2');
    expect((await reg2.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000028/claim`)).status()).toBe(200);

    // 2. off.reg1 login + return 000020
    const reg1 = await loginStaffApi(browser, 'off.reg1');
    expect(
      (
        await reg1.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000020/return`, {
          data: { reason: 'xxxxxxxxxx' },
        })
      ).status()
    ).toBe(200);

    // 3. off.reg2 forward 000013
    expect((await reg2.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000013/forward`)).status()).toBe(200);

    // 4. head1 login + approve 000013
    const head1 = await loginStaffApi(browser, 'head1');
    expect((await head1.ctx.post(`${BASE_URL}/api/cases/EG-2569-000013/approve`)).status()).toBe(200);

    // 5. off.reg2 approve 000025 + issue 000025 + reject 000026 + unmask 000025
    expect((await reg2.ctx.post(`${BASE_URL}/api/cases/EG-2569-000025/approve`)).status()).toBe(200);
    expect((await reg2.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/issue`)).status()).toBe(200);
    expect(
      (
        await reg2.ctx.post(`${BASE_URL}/api/cases/EG-2569-000026/reject`, {
          data: { reason: 'xxxxxxxxxx' },
        })
      ).status()
    ).toBe(200);
    expect(
      (
        await reg2.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000025/unmask`, {
          data: { reason: 'ตรวจสอบตัวตนซ้ำ' },
        })
      ).status()
    ).toBe(200);

    // 6. exec1 login + export xlsx
    const exec1 = await loginStaffApi(browser, 'exec1');
    expect(
      (await exec1.ctx.get(`${BASE_URL}/api/dashboard/export?format=xlsx&period=2026-12&service=ALL`)).status()
    ).toBe(200);

    // 7. admin1 login + update SV-01 fee 25
    const admin1 = await loginStaffApi(browser, 'admin1');
    expect(
      (
        await admin1.ctx.put(`${BASE_URL}/api/admin/services/SV-01`, {
          data: { fee: 25, sla: 3 },
        })
      ).status()
    ).toBe(200);

    // 8. audit1 login + open /audit
    const audit1 = await loginStaffPage(browser, 'audit1');
    try {
      await audit1.page.goto('/audit');
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('16');
      const rows = audit1.page.getByTestId('audit-row');
      await expect(rows).toHaveCount(16);

      for (let i = 0; i < 16; i++) {
        await expect(rows.nth(i).getByTestId('audit-time')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
      }

      await expect(audit1.page.locator('[data-testid="audit-row"][data-event="STAFF_LOGIN"]')).toHaveCount(6);
      const claimRow = audit1.page.locator('[data-testid="audit-row"][data-event="CLAIM"]');
      await expect(claimRow).toHaveCount(1);
      await expect(claimRow.getByTestId('audit-actor')).toHaveText('off.reg2');
      await expect(claimRow.getByTestId('audit-case-no')).toHaveText('EG-2569-000028');
      await expect(claimRow.getByTestId('audit-transition')).toHaveText('SUBMITTED → IN_REVIEW');

      const retRow = audit1.page.locator('[data-testid="audit-row"][data-event="RETURN"]');
      await expect(retRow).toHaveCount(1);
      await expect(retRow.getByTestId('audit-transition')).toHaveText('IN_REVIEW → NEED_FIX');
      await expect(retRow.getByTestId('audit-detail')).toContainText('xxxxxxxxxx');

      const issRow = audit1.page.locator('[data-testid="audit-row"][data-event="ISSUE"]');
      await expect(issRow).toHaveCount(1);
      await expect(issRow.getByTestId('audit-transition')).toHaveText('APPROVED → COMPLETED');
      await expect(issRow.getByTestId('audit-detail')).toContainText('DOC-2569-000002');

      const unmaskRow = audit1.page.locator('[data-testid="audit-row"][data-event="UNMASK"]');
      await expect(unmaskRow).toHaveCount(1);
      await expect(unmaskRow.getByTestId('audit-detail')).toContainText('ตรวจสอบตัวตนซ้ำ');

      const admRow = audit1.page.locator('[data-testid="audit-row"][data-event="ADMIN_CHANGE"]');
      await expect(admRow).toHaveCount(1);
      await expect(admRow.getByTestId('audit-detail')).toContainText('SV-01 fee 20 → 25');

      // Filters
      await audit1.page.getByTestId('audit-filter-actor').fill('off.reg2');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('7');

      await audit1.page.getByTestId('audit-filter-actor').fill('');
      await audit1.page.getByTestId('audit-filter-event').selectOption('APPROVE');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('2');

      await audit1.page.getByTestId('audit-filter-actor').fill('off.reg2');
      await audit1.page.getByTestId('audit-filter-event').selectOption('APPROVE');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('1');

      // Reset filter and export CSV
      await audit1.page.getByTestId('audit-filter-actor').fill('');
      await audit1.page.getByTestId('audit-filter-event').selectOption('');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('16');

      const csvRes = await audit1.req.get(`${BASE_URL}/api/audit/export.csv`);
      expect(csvRes.status()).toBe(200);
      const csvLines = (await csvRes.text()).trim().split(/\r?\n/);
      expect(csvLines[0]).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
      expect(csvLines.length).toBe(1 + 16);

      await audit1.page.goto('/audit');
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('17');
    } finally {
      await reg2.close();
      await reg1.close();
      await head1.close();
      await exec1.close();
      await admin1.close();
      await audit1.close();
    }
  });

  test('TC-AUDIT-02 · Audit แก้/ลบไม่ได้ (405)', async ({ browser, request }) => {
    await reset(request);
    const audit1 = await loginStaffPage(browser, 'audit1');
    const admin1 = await loginStaffApi(browser, 'admin1');
    try {
      const beforeRes = await audit1.req.get(`${BASE_URL}/api/audit`);
      expect(beforeRes.status()).toBe(200);
      const before = await beforeRes.json();
      expect(before.items.length).toBeGreaterThanOrEqual(1);
      const id = before.items[0].id;

      for (const ctx of [audit1.req, admin1.ctx]) {
        const r1 = await ctx.put(`${BASE_URL}/api/audit/${id}`, { data: { detail: 'x' } });
        expect(r1.status()).toBe(405);
        expect((await r1.json()).code).toBe('METHOD_NOT_ALLOWED');

        const r2 = await ctx.patch(`${BASE_URL}/api/audit/${id}`, { data: { detail: 'x' } });
        expect(r2.status()).toBe(405);

        const r3 = await ctx.delete(`${BASE_URL}/api/audit/${id}`);
        expect(r3.status()).toBe(405);

        const r4 = await ctx.put(`${BASE_URL}/api/audit`, { data: {} });
        expect(r4.status()).toBe(405);

        const r5 = await ctx.delete(`${BASE_URL}/api/audit`);
        expect(r5.status()).toBe(405);

        const r6 = await ctx.delete(`${BASE_URL}/api/audit/999999`);
        expect(r6.status()).toBe(405);
      }

      const after = await (await audit1.req.get(`${BASE_URL}/api/audit`)).json();
      for (const item of before.items) {
        const found = after.items.find((x: { id: number }) => x.id === item.id);
        expect(found).toEqual(item);
      }

      await audit1.page.goto('/audit');
      await expect(audit1.page.getByTestId('audit-edit-btn')).toHaveCount(0);
      await expect(audit1.page.getByTestId('audit-delete-btn')).toHaveCount(0);

      const admGet = await admin1.ctx.get(`${BASE_URL}/api/audit`);
      expect(admGet.status()).toBe(403);
    } finally {
      await audit1.close();
      await admin1.close();
    }
  });

  test('TC-AUDIT-03 · กรองช่วงวันที่ตามเวลาไทย', async ({ browser, request }) => {
    await reset(request);
    const logins = [
      { clock: '2026-11-30T23:59:59+07:00', user: 'off.reg1' },
      { clock: '2026-12-01T00:00:00+07:00', user: 'off.reg2' },
      { clock: '2026-12-01T23:59:59+07:00', user: 'off.works1' },
      { clock: '2026-12-02T00:00:00+07:00', user: 'off.reg1' },
    ];
    for (const l of logins) {
      await setClock(request, l.clock);
      const s = await loginStaffApi(browser, l.user);
      await s.close();
    }

    await setClock(request, '2026-12-02T09:00:00+07:00');
    const audit1 = await loginStaffPage(browser, 'audit1');
    try {
      const checks = [
        { from: '2026-12-01', to: '2026-12-01', actor: '', count: 2, actors: ['off.works1', 'off.reg2'] },
        { from: '2026-11-30', to: '2026-11-30', actor: '', count: 1, actors: ['off.reg1'] },
        { from: '2026-11-30', to: '2026-12-01', actor: '', count: 3, actors: ['off.works1', 'off.reg2', 'off.reg1'] },
        { from: '2026-12-02', to: '', actor: '', count: 2, actors: ['audit1', 'off.reg1'] },
        { from: '', to: '2026-11-30', actor: '', count: 1, actors: ['off.reg1'] },
        { from: '2026-12-01', to: '2026-12-02', actor: '', count: 4, actors: ['audit1', 'off.reg1', 'off.works1', 'off.reg2'] },
        { from: '2026-12-01', to: '2026-12-01', actor: 'off.reg2', count: 1, actors: ['off.reg2'] },
      ];

      await audit1.page.goto('/audit');
      for (const c of checks) {
        await audit1.page.getByTestId('audit-filter-from').fill(c.from);
        await audit1.page.getByTestId('audit-filter-to').fill(c.to);
        await audit1.page.getByTestId('audit-filter-actor').fill(c.actor);
        await audit1.page.getByTestId('audit-apply-btn').click();
        await expect(audit1.page.getByTestId('audit-count')).toHaveText(String(c.count));

        const apiRes = await audit1.req.get(
          `${BASE_URL}/api/audit?from=${c.from}&to=${c.to}&actor=${c.actor}`
        );
        expect(apiRes.status()).toBe(200);
        const body = await apiRes.json();
        expect(body.count).toBe(c.count);
        expect(body.items.map((x: { username: string }) => x.username)).toEqual(c.actors);
      }
    } finally {
      await audit1.close();
    }
  });

  test('TC-RBAC-01 · ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ browser, request }) => {
    await reset(request);
    const somying = await loginCitizenPage(browser, CITIZENS.somying);
    const somchai = await loginCitizenApi(browser, CITIZENS.somchai);
    try {
      const uiRes = await somying.page.goto('/citizen/cases/EG-2569-000005');
      expect(uiRes?.status()).toBe(404);
      await expect(somying.page.getByTestId('not-found-msg')).toHaveText('ไม่พบคำขอ');
      await expect(somying.page.getByTestId('case-no')).toHaveCount(0);
      await expect(somying.page.getByTestId('case-status')).toHaveCount(0);
      expect(await somying.page.content()).not.toContain('สมชาย');

      const apiOther = await somying.req.get(`${BASE_URL}/api/cases/EG-2569-000005`);
      expect(apiOther.status()).toBe(404);
      const bodyOther = await apiOther.text();
      expect(JSON.parse(bodyOther)).toEqual({ code: 'NOT_FOUND', message: 'ไม่พบคำขอ' });

      const apiNonExist = await somying.req.get(`${BASE_URL}/api/cases/EG-2569-999999`);
      expect(apiNonExist.status()).toBe(404);
      expect(await apiNonExist.text()).toBe(bodyOther);

      expect((await somying.req.get(`${BASE_URL}/api/documents/DOC-2569-000001/pdf`)).status()).toBe(404);
      expect((await somying.req.get(`${BASE_URL}/api/drafts/DR-0001`)).status()).toBe(404);
      expect((await somying.req.post(`${BASE_URL}/api/cases/EG-2569-000030/cancel`)).status()).toBe(404);

      const ownUi = await somying.page.goto('/citizen/cases/EG-2569-000007');
      expect(ownUi?.status()).toBe(200);
      await expect(somying.page.getByTestId('case-no')).toHaveText('EG-2569-000007');

      expect((await somchai.ctx.get(`${BASE_URL}/api/cases/EG-2569-000005`)).status()).toBe(200);
    } finally {
      await somying.close();
      await somchai.close();
    }
  });

  test('TC-RBAC-02 · เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (API)', async ({ browser, request }) => {
    await reset(request);
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const head1 = await loginStaffApi(browser, 'head1');
    const audit1 = await loginStaffPage(browser, 'audit1');
    try {
      const r1 = await reg2.req.post(`${BASE_URL}/api/cases/EG-2569-000014/approve`);
      expect(r1.status()).toBe(403);
      expect((await r1.json()).code).toBe('FORBIDDEN');
      expect((await (await reg2.req.get(`${BASE_URL}/api/cases/EG-2569-000014`)).json()).status).toBe('PENDING_APPROVAL');

      const r2 = await reg2.req.post(`${BASE_URL}/api/cases/EG-2569-000013/approve`);
      expect(r2.status()).toBe(403);
      expect((await (await reg2.req.get(`${BASE_URL}/api/cases/EG-2569-000013`)).json()).status).toBe('IN_REVIEW');

      const r3 = await reg2.req.post(`${BASE_URL}/api/cases/EG-2569-000014/reject`, {
        data: { reason: 'xxxxxxxxxx' },
      });
      expect(r3.status()).toBe(403);

      await reg2.page.goto('/officer/cases/EG-2569-000013');
      await expect(reg2.page.getByTestId('approve-btn')).toHaveCount(0);
      await reg2.page.goto('/officer/cases/EG-2569-000014');
      await expect(reg2.page.getByTestId('approve-btn')).toHaveCount(0);

      const r5 = await head1.ctx.post(`${BASE_URL}/api/cases/EG-2569-000025/approve`);
      expect(r5.status()).toBe(403);

      const r6 = await head1.ctx.post(`${BASE_URL}/api/cases/EG-2569-000014/approve`);
      expect(r6.status()).toBe(200);
      expect((await r6.json()).status).toBe('APPROVED');

      await audit1.page.goto('/audit');
      await audit1.page.getByTestId('audit-filter-event').selectOption('APPROVE');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('1');
      await expect(audit1.page.getByTestId('audit-row').first()).toHaveAttribute('data-actor', 'head1');
    } finally {
      await reg2.close();
      await head1.close();
      await audit1.close();
    }
  });

  test('TC-RBAC-03 · ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser, request }) => {
    const pages = [
      '/citizen',
      '/officer/queue',
      '/head/approvals',
      '/dashboard',
      '/audit',
      '/admin/services',
      '/admin/holidays',
      '/admin/users',
      '/notifications',
      '/verify/K7M2Q9XA',
    ];

    const pageMatrix: Record<string, Record<string, 'redirect' | 200 | 403>> = {
      anon: {
        '/citizen': 'redirect',
        '/officer/queue': 'redirect',
        '/head/approvals': 'redirect',
        '/dashboard': 'redirect',
        '/audit': 'redirect',
        '/admin/services': 'redirect',
        '/admin/holidays': 'redirect',
        '/admin/users': 'redirect',
        '/notifications': 'redirect',
        '/verify/K7M2Q9XA': 200,
      },
      citizen: {
        '/citizen': 200,
        '/officer/queue': 403,
        '/head/approvals': 403,
        '/dashboard': 403,
        '/audit': 403,
        '/admin/services': 403,
        '/admin/holidays': 403,
        '/admin/users': 403,
        '/notifications': 403,
        '/verify/K7M2Q9XA': 200,
      },
      officer: {
        '/citizen': 403,
        '/officer/queue': 200,
        '/head/approvals': 403,
        '/dashboard': 403,
        '/audit': 403,
        '/admin/services': 403,
        '/admin/holidays': 403,
        '/admin/users': 403,
        '/notifications': 200,
        '/verify/K7M2Q9XA': 200,
      },
      head: {
        '/citizen': 403,
        '/officer/queue': 200,
        '/head/approvals': 200,
        '/dashboard': 403,
        '/audit': 403,
        '/admin/services': 403,
        '/admin/holidays': 403,
        '/admin/users': 403,
        '/notifications': 200,
        '/verify/K7M2Q9XA': 200,
      },
      executive: {
        '/citizen': 403,
        '/officer/queue': 403,
        '/head/approvals': 403,
        '/dashboard': 200,
        '/audit': 403,
        '/admin/services': 403,
        '/admin/holidays': 403,
        '/admin/users': 403,
        '/notifications': 403,
        '/verify/K7M2Q9XA': 200,
      },
      auditor: {
        '/citizen': 403,
        '/officer/queue': 403,
        '/head/approvals': 403,
        '/dashboard': 403,
        '/audit': 200,
        '/admin/services': 403,
        '/admin/holidays': 403,
        '/admin/users': 403,
        '/notifications': 403,
        '/verify/K7M2Q9XA': 200,
      },
      admin: {
        '/citizen': 403,
        '/officer/queue': 403,
        '/head/approvals': 403,
        '/dashboard': 403,
        '/audit': 403,
        '/admin/services': 200,
        '/admin/holidays': 200,
        '/admin/users': 200,
        '/notifications': 403,
        '/verify/K7M2Q9XA': 200,
      },
    };

    const navMatrix: Record<string, string[]> = {
      citizen: ['nav-my-cases'],
      officer: ['nav-queue', 'nav-bell'],
      head: ['nav-queue', 'nav-approvals', 'nav-bell'],
      executive: ['nav-dashboard'],
      auditor: ['nav-audit'],
      admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
    };
    const allNavs = [
      'nav-my-cases',
      'nav-queue',
      'nav-approvals',
      'nav-dashboard',
      'nav-audit',
      'nav-admin-services',
      'nav-admin-holidays',
      'nav-admin-users',
      'nav-bell',
    ];

    const roles: Array<{ role: string; login: () => Promise<{ page: Page; req: APIRequestContext; close: () => Promise<void> }> }> = [
      {
        role: 'anon',
        login: async () => {
          const bctx = await browser.newContext({ baseURL: BASE_URL, ...(process.env.PW_VIDEO ? { recordVideo: { dir: `/tmp/pw-p2-videos/${process.env._CUR_TC || "misc"}` } } : {}) });
          const page = await bctx.newPage();
          return { page, req: bctx.request, close: () => bctx.close() };
        },
      },
      { role: 'citizen', login: () => loginCitizenPage(browser, CITIZENS.somying) },
      { role: 'officer', login: () => loginStaffPage(browser, 'off.reg1') },
      { role: 'head', login: () => loginStaffPage(browser, 'head1') },
      { role: 'executive', login: () => loginStaffPage(browser, 'exec1') },
      { role: 'auditor', login: () => loginStaffPage(browser, 'audit1') },
      { role: 'admin', login: () => loginStaffPage(browser, 'admin1') },
    ];

    for (const r of roles) {
      await reset(request);
      const sess = await r.login();
      try {
        // Part A & D: Pages and Nav
        for (const p of pages) {
          const exp = pageMatrix[r.role][p];
          const res = await sess.page.goto(p);
          if (exp === 'redirect') {
            expect(sess.page.url()).toContain('/login');
          } else if (exp === 403) {
            expect(res?.status()).toBe(403);
            await expect(sess.page.getByTestId('forbidden-msg')).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้');
          } else {
            expect(res?.status()).toBe(200);
            if (r.role !== 'anon' && p !== '/verify/K7M2Q9XA') {
              const expectedNavs = navMatrix[r.role];
              for (const navId of allNavs) {
                await expect(sess.page.getByTestId(navId)).toHaveCount(expectedNavs.includes(navId) ? 1 : 0);
              }
            }
          }
        }

        // Part B: APIs
        const code = (allowedRoles: string[], okStatus = 200) =>
          r.role === 'anon' ? 401 : allowedRoles.includes(r.role) ? okStatus : 403;

        expect((await sess.req.get(`${BASE_URL}/api/officer/queue`)).status()).toBe(code(['officer', 'head']));
        expect((await sess.req.get(`${BASE_URL}/api/notifications`)).status()).toBe(code(['officer', 'head']));
        expect((await sess.req.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`)).status()).toBe(
          code(['executive'])
        );
        expect((await sess.req.get(`${BASE_URL}/api/audit`)).status()).toBe(code(['auditor']));
        expect((await sess.req.get(`${BASE_URL}/api/admin/services`)).status()).toBe(code(['admin']));
        expect(
          (await sess.req.post(`${BASE_URL}/api/drafts`, { data: { serviceId: 'SV-01', qty: 1 } })).status()
        ).toBe(code(['citizen'], 201));
        expect((await sess.req.get(`${BASE_URL}/api/cases/EG-2569-000025`)).status()).toBe(
          code(['citizen', 'officer', 'head'])
        );
        expect((await sess.req.post(`${BASE_URL}/api/officer/cases/EG-2569-000028/claim`)).status()).toBe(
          code(['officer'])
        );
      } finally {
        await sess.close();
      }
    }

    // Part C: Department scope
    await reset(request);
    const works1 = await loginStaffApi(browser, 'off.works1');
    const reg1 = await loginStaffApi(browser, 'off.reg1');
    try {
      expect((await works1.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000028/claim`)).status()).toBe(403);
      expect((await reg1.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000010/claim`)).status()).toBe(403);
      const wQueue = await (await works1.ctx.get(`${BASE_URL}/api/officer/queue?filter=all`)).json();
      expect(wQueue.items.map((x: { caseNo: string }) => x.caseNo)).toEqual(['EG-2569-000010']);
    } finally {
      await works1.close();
      await reg1.close();
    }
  });

  test('TC-RBAC-04 · ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ browser, request }) => {
    await reset(request);
    const admin1 = await loginStaffPage(browser, 'admin1');
    const somchai = await loginCitizenPage(browser, CITIZENS.somchai);
    try {
      // 1. Holidays
      await admin1.page.goto('/admin/holidays');
      const hRows = admin1.page.getByTestId('holiday-row');
      await expect(hRows).toHaveCount(4);

      // 2. Before change: NEW_PAID SV-01
      const c31 = await newPaid(browser, request, { serviceId: 'SV-01', qty: 1, time: '2026-12-01T09:00:00+07:00' });
      expect(c31.caseNo).toBe('EG-2569-000031');
      const c31Info = await (await somchai.req.get(`${BASE_URL}/api/cases/EG-2569-000031`)).json();
      expect(c31Info.dueAt).toBe('2026-12-04T16:30:00+07:00');

      // 3. Admin changes SV-01 fee to 25 and SV-02 fee to 600
      await admin1.page.goto('/admin/services');
      await admin1.page.getByTestId('svc-fee-SV-01').fill('25');
      await admin1.page.getByTestId('svc-save-SV-01').click();
      await expect(admin1.page.getByTestId('action-success')).toBeVisible();

      await admin1.page.getByTestId('svc-fee-SV-02').fill('600');
      await admin1.page.getByTestId('svc-save-SV-02').click();
      await expect(admin1.page.getByTestId('action-success')).toBeVisible();

      // 4. Somchai checks new draft fees and old case fee
      await somchai.page.goto('/citizen/new/SV-01');
      await somchai.page.getByTestId('qty-input').fill('5');
      await expect(somchai.page.getByTestId('fee-total')).toHaveText('฿125');
      await somchai.page.getByTestId('qty-input').fill('1');
      await expect(somchai.page.getByTestId('fee-total')).toHaveText('฿25');

      await somchai.page.goto('/citizen/new/SV-02');
      await expect(somchai.page.getByTestId('fee-total')).toHaveText('฿600');

      await somchai.page.goto('/citizen/cases/EG-2569-000030');
      await expect(somchai.page.getByTestId('case-fee')).toHaveText('฿20');

      // 5. Locked payment PP-0001 (DR-0002 at 500)
      await somchai.page.goto('/citizen/new/SV-02?draft=DR-0002');
      await expect(somchai.page.getByTestId('payment-amount')).toHaveText('฿500');
      const pay600 = await request.post(`${BASE_URL}/api/test/payments/PP-0001/pay`, { data: { amount: 600 } });
      expect(pay600.status()).toBe(422);
      expect((await pay600.json()).code).toBe('AMOUNT_MISMATCH');

      const pay500 = await request.post(`${BASE_URL}/api/test/payments/PP-0001/pay`, { data: { amount: 500 } });
      expect(pay500.status()).toBe(200);
      expect((await pay500.json()).caseNo).toBe('EG-2569-000032');

      // 6. Add holiday 2026-12-02
      await admin1.page.goto('/admin/holidays');
      await admin1.page.getByTestId('holiday-date-input').fill('2026-12-02');
      await admin1.page.getByTestId('holiday-name-input').fill('วันหยุดทดสอบ');
      await admin1.page.getByTestId('holiday-add-btn').click();
      await expect(admin1.page.getByTestId('holiday-row')).toHaveCount(5);

      const c31After = await (await somchai.req.get(`${BASE_URL}/api/cases/EG-2569-000031`)).json();
      expect(c31After.dueAt).toBe('2026-12-04T16:30:00+07:00');

      // 7. After adding holiday: NEW_PAID SV-01
      const c33 = await newPaid(browser, request, { serviceId: 'SV-01', qty: 1, time: '2026-12-01T09:00:00+07:00' });
      expect(c33.caseNo).toBe('EG-2569-000033');
      const c33Info = await (await somchai.req.get(`${BASE_URL}/api/cases/EG-2569-000033`)).json();
      expect(c33Info.dueAt).toBe('2026-12-08T16:30:00+07:00');

      // 8. Change exec1 role to auditor
      const uRes = await admin1.req.put(`${BASE_URL}/api/admin/users/exec1`, {
        data: { role: 'auditor', dept: '' },
      });
      expect(uRes.status()).toBe(200);

      const execAsAuditor = await loginStaffPage(browser, 'exec1');
      try {
        await execAsAuditor.page.goto('/');
        expect(execAsAuditor.page.url()).toContain('/audit');
        const dashForbid = await execAsAuditor.page.goto('/dashboard');
        expect(dashForbid?.status()).toBe(403);

        // 9. Filter ADMIN_CHANGE
        await execAsAuditor.page.goto('/audit');
        await execAsAuditor.page.getByTestId('audit-filter-event').selectOption('ADMIN_CHANGE');
        await execAsAuditor.page.getByTestId('audit-apply-btn').click();
        await expect(execAsAuditor.page.getByTestId('audit-count')).toHaveText('4');

        // 10. Admin cannot create draft
        expect(
          (await admin1.req.post(`${BASE_URL}/api/drafts`, { data: { serviceId: 'SV-01', qty: 1 } })).status()
        ).toBe(403);

        // 11. Delete holiday 2026-12-02
        await admin1.page.goto('/admin/holidays');
        await admin1.page
          .locator('[data-testid="holiday-row"][data-date="2026-12-02"]')
          .getByTestId('holiday-delete-btn')
          .click();
        await expect(admin1.page.getByTestId('holiday-row')).toHaveCount(4);

        await execAsAuditor.page.goto('/audit');
        await execAsAuditor.page.getByTestId('audit-filter-event').selectOption('ADMIN_CHANGE');
        await execAsAuditor.page.getByTestId('audit-apply-btn').click();
        await expect(execAsAuditor.page.getByTestId('audit-count')).toHaveText('5');
      } finally {
        await execAsAuditor.close();
      }
    } finally {
      await admin1.close();
      await somchai.close();
    }
  });

  test('TC-RBAC-05 · สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ browser, request }) => {
    await reset(request);
    const reg1 = await loginStaffPage(browser, 'off.reg1');
    const reg2 = await loginStaffPage(browser, 'off.reg2');
    const works1 = await loginStaffApi(browser, 'off.works1');
    const head1 = await loginStaffApi(browser, 'head1');
    const somying = await loginCitizenPage(browser, CITIZENS.somying);
    const somchai = await loginCitizenApi(browser, CITIZENS.somchai);
    const exec1 = await loginStaffApi(browser, 'exec1');
    const audit1 = await loginStaffApi(browser, 'audit1');
    const admin1 = await loginStaffApi(browser, 'admin1');
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });

    async function checkAllow(ctx: APIRequestContext, caseNo: string, expectedCount: number): Promise<string> {
      const fRes = await ctx.get(`${BASE_URL}/api/cases/${caseNo}/files`);
      expect(fRes.status()).toBe(200);
      const { items } = await fRes.json();
      expect(items.length).toBe(expectedCount);
      const fileId = items[0].fileId;
      const dlRes = await ctx.get(`${BASE_URL}/api/files/${fileId}`);
      expect(dlRes.status()).toBe(200);
      expect(dlRes.headers()['content-type']).toContain('application/pdf');
      expect((await dlRes.body()).slice(0, 4).toString('ascii')).toBe('%PDF');
      return fileId;
    }

    async function checkDeny(ctx: APIRequestContext, caseNo: string, fileId: string, status: number) {
      expect((await ctx.get(`${BASE_URL}/api/cases/${caseNo}/files`)).status()).toBe(status);
      expect((await ctx.get(`${BASE_URL}/api/files/${fileId}`)).status()).toBe(status);
    }

    try {
      const fid25 = await checkAllow(reg1.req, 'EG-2569-000025', 1);
      await checkDeny(works1.ctx, 'EG-2569-000025', fid25, 403);

      const fid12 = await checkAllow(reg2.req, 'EG-2569-000012', 3);
      await checkDeny(works1.ctx, 'EG-2569-000012', fid12, 403);

      await checkAllow(works1.ctx, 'EG-2569-000010', 3);
      await checkAllow(reg1.req, 'EG-2569-000010', 3);
      await checkAllow(works1.ctx, 'EG-2569-000011', 3);

      await checkAllow(head1.ctx, 'EG-2569-000025', 1);
      await checkAllow(head1.ctx, 'EG-2569-000010', 3);
      await checkAllow(head1.ctx, 'EG-2569-000012', 3);

      await checkAllow(somying.req, 'EG-2569-000025', 1);
      await checkDeny(somchai.ctx, 'EG-2569-000025', fid25, 404);

      for (const s of [exec1.ctx, audit1.ctx, admin1.ctx]) {
        await checkDeny(s, 'EG-2569-000025', fid25, 403);
      }
      await checkDeny(anonCtx.request, 'EG-2569-000025', fid25, 401);

      expect((await reg1.req.get(`${BASE_URL}/api/files/NON_EXISTENT_FILE_ID`)).status()).toBe(404);

      // UI checks
      await reg1.page.goto('/officer/cases/EG-2569-000025');
      await expect(reg1.page.getByTestId('doc-item')).toHaveCount(1);
      await expect(reg1.page.getByTestId('doc-item').first()).toHaveAttribute('data-name', 'id-card.pdf');
      const href = await reg1.page.getByTestId('doc-download-link').first().getAttribute('href');
      expect(href).toContain('/api/files/');

      await reg2.page.goto('/officer/cases/EG-2569-000012');
      await expect(reg2.page.getByTestId('doc-item')).toHaveCount(3);

      await somying.page.goto('/citizen/cases/EG-2569-000025');
      await expect(somying.page.getByTestId('doc-item')).toHaveCount(1);
    } finally {
      await reg1.close();
      await reg2.close();
      await works1.close();
      await head1.close();
      await somying.close();
      await somchai.close();
      await exec1.close();
      await audit1.close();
      await admin1.close();
      await anonCtx.close();
    }
  });

  test('TC-RBAC-06 · ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ browser, request }) => {
    await reset(request);
    const admin1 = await loginStaffPage(browser, 'admin1');
    const audit1 = await loginStaffPage(browser, 'audit1');
    try {
      await admin1.page.goto('/admin/services');

      // fee = -1
      await admin1.page.getByTestId('svc-fee-SV-01').fill('-1');
      await admin1.page.getByTestId('svc-save-SV-01').click();
      await expect(admin1.page.getByTestId('action-error')).toHaveText(
        'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท'
      );

      // fee = 0 (200)
      const f0 = await admin1.req.put(`${BASE_URL}/api/admin/services/SV-01`, { data: { fee: 0, sla: 3 } });
      expect(f0.status()).toBe(200);

      // fee = 100000 (200)
      const f100k = await admin1.req.put(`${BASE_URL}/api/admin/services/SV-01`, { data: { fee: 100000, sla: 3 } });
      expect(f100k.status()).toBe(200);

      // fee = 100001 (400)
      const fOver = await admin1.req.put(`${BASE_URL}/api/admin/services/SV-01`, { data: { fee: 100001, sla: 3 } });
      expect(fOver.status()).toBe(400);
      expect((await fOver.json()).code).toBe('INVALID_FEE');

      // sla = 0 (400)
      await admin1.page.getByTestId('svc-fee-SV-01').fill('100000');
      await admin1.page.getByTestId('svc-sla-SV-01').fill('0');
      await admin1.page.getByTestId('svc-save-SV-01').click();
      await expect(admin1.page.getByTestId('action-error')).toHaveText('SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ');

      // sla = 1 (200)
      const s1 = await admin1.req.put(`${BASE_URL}/api/admin/services/SV-01`, { data: { fee: 100000, sla: 1 } });
      expect(s1.status()).toBe(200);

      // sla = 60 (200)
      const s60 = await admin1.req.put(`${BASE_URL}/api/admin/services/SV-01`, { data: { fee: 100000, sla: 60 } });
      expect(s60.status()).toBe(200);

      // sla = 61 (400)
      const s61 = await admin1.req.put(`${BASE_URL}/api/admin/services/SV-01`, { data: { fee: 100000, sla: 61 } });
      expect(s61.status()).toBe(400);
      expect((await s61.json()).code).toBe('INVALID_SLA');

      // Duplicate holiday 2026-12-07
      const hDup = await admin1.req.post(`${BASE_URL}/api/admin/holidays`, {
        data: { date: '2026-12-07', name: 'ซ้ำ' },
      });
      expect(hDup.status()).toBe(409);
      expect((await hDup.json()).code).toBe('DUPLICATE_HOLIDAY');

      // Saturday holiday 2026-12-05
      const hSat = await admin1.req.post(`${BASE_URL}/api/admin/holidays`, {
        data: { date: '2026-12-05', name: 'วันเสาร์' },
      });
      expect(hSat.status()).toBe(201);

      // Self role change
      const selfRes = await admin1.req.put(`${BASE_URL}/api/admin/users/admin1`, {
        data: { role: 'executive', dept: '' },
      });
      expect(selfRes.status()).toBe(409);
      expect((await selfRes.json()).code).toBe('SELF_ROLE_CHANGE');
      const me = await (await admin1.req.get(`${BASE_URL}/api/me`)).json();
      expect(me.role).toBe('admin');

      // Audit count = 5
      await audit1.page.goto('/audit');
      await audit1.page.getByTestId('audit-filter-event').selectOption('ADMIN_CHANGE');
      await audit1.page.getByTestId('audit-apply-btn').click();
      await expect(audit1.page.getByTestId('audit-count')).toHaveText('5');
    } finally {
      await admin1.close();
      await audit1.close();
    }
  });

  test('TC-NFR-01 · Responsive 375/768/1280', async ({ browser, request }) => {
    await reset(request);
    const viewports = [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ];

    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anonPage = await anonCtx.newPage();
    const somchai = await loginCitizenPage(browser, CITIZENS.somchai);
    const reg1 = await loginStaffPage(browser, 'off.reg1');
    const head1 = await loginStaffPage(browser, 'head1');
    const exec1 = await loginStaffPage(browser, 'exec1');
    const audit1 = await loginStaffPage(browser, 'audit1');
    const admin1 = await loginStaffPage(browser, 'admin1');

    const targets: Array<{ page: Page; url: string }> = [
      { page: anonPage, url: '/login' },
      { page: somchai.page, url: '/citizen' },
      { page: somchai.page, url: '/citizen/new/SV-03' },
      { page: somchai.page, url: '/citizen/cases/EG-2569-000013' },
      { page: reg1.page, url: '/officer/queue' },
      { page: reg1.page, url: '/officer/cases/EG-2569-000020' },
      { page: head1.page, url: '/head/approvals' },
      { page: exec1.page, url: '/dashboard' },
      { page: audit1.page, url: '/audit' },
      { page: admin1.page, url: '/admin/services' },
      { page: anonPage, url: '/verify/K7M2Q9XA' },
    ];

    try {
      for (const vp of viewports) {
        for (const t of targets) {
          await t.page.setViewportSize(vp);
          await t.page.goto(t.url);
          const overflow = await t.page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          );
          expect(overflow).toBe(true);
        }
      }

      // Main flow at 375px
      const flowCtx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 375, height: 812 } });
      const flowPage = await flowCtx.newPage();
      try {
        await flowPage.goto('/login');
        await flowPage.getByTestId('thaid-id-input').fill(CITIZENS.somchai);
        await flowPage.getByTestId('thaid-submit').click();
        await flowPage.getByTestId('otp-input').fill('123456');
        await flowPage.getByTestId('otp-submit').click();

        await flowPage.getByTestId('start-service-SV-01').click();
        await flowPage.getByTestId('qty-input').fill('1');
        await expect(flowPage.getByTestId('fee-total')).toHaveText('฿20');
        await flowPage.getByTestId('to-upload-btn').click();

        await flowPage.getByTestId('upload-input-id-card').setInputFiles({
          name: 'id-card.pdf',
          mimeType: 'application/pdf',
          buffer: makePdfBuffer(1024),
        });
        await expect(flowPage.getByTestId('to-payment-btn')).toBeEnabled();
        await flowPage.getByTestId('to-payment-btn').click();

        const qrBtn = flowPage.getByTestId('create-qr-btn');
        await expect(qrBtn).toBeVisible();
        const box = await qrBtn.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      } finally {
        await flowCtx.close();
      }
    } finally {
      await anonCtx.close();
      await somchai.close();
      await reg1.close();
      await head1.close();
      await exec1.close();
      await audit1.close();
      await admin1.close();
    }
  });

  test('TC-NFR-02 · WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ browser, request }) => {
    await reset(request);
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anonPage = await anonCtx.newPage();
    const mana = await loginCitizenPage(browser, CITIZENS.mana);
    const somchai = await loginCitizenPage(browser, CITIZENS.somchai);
    const reg1 = await loginStaffPage(browser, 'off.reg1');
    const head1 = await loginStaffPage(browser, 'head1');
    const exec1 = await loginStaffPage(browser, 'exec1');
    const audit1 = await loginStaffPage(browser, 'audit1');
    const admin1 = await loginStaffPage(browser, 'admin1');

    const axeTargets: Array<{ page: Page; url: string }> = [
      { page: anonPage, url: '/login' },
      { page: mana.page, url: '/register' },
      { page: somchai.page, url: '/citizen' },
      { page: somchai.page, url: '/citizen/new/SV-01' },
      { page: somchai.page, url: '/citizen/cases/EG-2569-000017' },
      { page: reg1.page, url: '/officer/queue' },
      { page: reg1.page, url: '/officer/cases/EG-2569-000020' },
      { page: head1.page, url: '/head/approvals' },
      { page: exec1.page, url: '/dashboard' },
      { page: audit1.page, url: '/audit' },
      { page: admin1.page, url: '/admin/services' },
      { page: reg1.page, url: '/notifications' },
      { page: anonPage, url: '/verify/K7M2Q9XA' },
    ];

    try {
      // Part A & C: axe + accessible labels
      for (const t of axeTargets) {
        await t.page.goto(t.url);
        const results = await new AxeBuilder({ page: t.page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(bad).toEqual([]);

        const unlabeledCount = await t.page.evaluate(() => {
          const controls = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
            const input = el as HTMLElement;
            if ((input as HTMLInputElement).type === 'hidden') return false;
            const style = window.getComputedStyle(input);
            return style.display !== 'none' && style.visibility !== 'hidden' && input.offsetParent !== null;
          });
          return controls.filter((el) => {
            if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
            const id = el.getAttribute('id');
            if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false;
            if (el.closest('label')) return false;
            return true;
          }).length;
        });
        expect(unlabeledCount).toBe(0);
      }

      // Part B: Keyboard only
      const kbCtx = await browser.newContext({ baseURL: BASE_URL });
      const kbPage = await kbCtx.newPage();
      try {
        await kbPage.goto('/login');
        async function tabToTestId(testId: string, maxTabs = 40) {
          for (let i = 0; i < maxTabs; i++) {
            const activeId = await kbPage.evaluate(() =>
              document.activeElement?.getAttribute('data-testid')
            );
            if (activeId === testId) {
              const hasFocusRing = await kbPage.evaluate(() => {
                const el = document.activeElement as HTMLElement;
                if (!el) return false;
                const st = window.getComputedStyle(el);
                return (st.outlineStyle && st.outlineStyle !== 'none') || (st.boxShadow && st.boxShadow !== 'none');
              });
              expect(hasFocusRing).toBe(true);
              return;
            }
            await kbPage.keyboard.press('Tab');
          }
          throw new Error(`Could not Tab to ${testId}`);
        }

        await tabToTestId('thaid-id-input');
        await kbPage.keyboard.type(CITIZENS.somchai);
        await kbPage.keyboard.press('Enter');
        await expect(kbPage.getByTestId('otp-step')).toBeVisible();

        await tabToTestId('otp-input');
        await kbPage.keyboard.type('123456');
        await kbPage.keyboard.press('Enter');
        await kbPage.waitForURL('**/citizen');

        await tabToTestId('start-service-SV-01');
        await kbPage.keyboard.press('Enter');
        await kbPage.waitForURL('**/citizen/new/SV-01');

        await tabToTestId('qty-input');
        await kbPage.keyboard.press('Control+A');
        await kbPage.keyboard.type('1');

        await tabToTestId('to-upload-btn');
        await kbPage.keyboard.press('Enter');
        await expect(kbPage.getByTestId('wizard-step')).toContainText('2/3');

        await tabToTestId('upload-input-id-card');
        await kbPage.getByTestId('upload-input-id-card').setInputFiles({
          name: 'id-card.pdf',
          mimeType: 'application/pdf',
          buffer: makePdfBuffer(1024),
        });

        await tabToTestId('to-payment-btn');
        await kbPage.keyboard.press('Enter');
        await expect(kbPage.getByTestId('create-qr-btn')).toBeVisible();
      } finally {
        await kbCtx.close();
      }

      // Part D: Status not color alone + forcedColors
      const statusMap: Record<string, string> = {
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
      const levelMap: Record<string, string> = {
        normal: 'ปกติ',
        near: 'ใกล้ครบกำหนด',
        overdue: 'เกินกำหนด',
        paused: 'หยุดนับ',
        closed: 'ปิดแล้ว',
      };

      await reg1.page.goto('/officer/queue');
      await reg1.page.emulateMedia({ forcedColors: 'active' });
      const rowStatuses = reg1.page.getByTestId('row-status');
      const rsCount = await rowStatuses.count();
      expect(rsCount).toBeGreaterThan(0);
      for (let i = 0; i < rsCount; i++) {
        const el = rowStatuses.nth(i);
        const code = (await el.getAttribute('data-status')) || (await reg1.page.getByTestId('queue-row').nth(i).getAttribute('data-status')) || '';
        const txt = (await el.textContent())?.trim() || '';
        expect(txt).toBe(statusMap[code]);
      }

      const rowLevels = reg1.page.getByTestId('row-sla-level');
      const rlCount = await rowLevels.count();
      expect(rlCount).toBeGreaterThan(0);
      for (let i = 0; i < rlCount; i++) {
        const el = rowLevels.nth(i);
        const code = (await el.getAttribute('data-level')) || (await reg1.page.getByTestId('queue-row').nth(i).getAttribute('data-sla-level')) || '';
        const txt = (await el.textContent())?.trim() || '';
        expect(txt).toBe(levelMap[code]);
      }
    } finally {
      await anonCtx.close();
      await mana.close();
      await somchai.close();
      await reg1.close();
      await head1.close();
      await exec1.close();
      await audit1.close();
      await admin1.close();
    }
  });

  test('TC-NFR-03 · Health เวลาโหลด และผลซ้ำได้', async ({ browser, request }) => {
    // 1. Health
    const hRes = await request.get(`${BASE_URL}/api/health`);
    expect(hRes.status()).toBe(200);
    expect(await hRes.text()).toBe('{"status":"ok"}');

    // 2. Load times <= 3000ms (2nd run after warmup)
    await reset(request);
    const anonCtx = await browser.newContext({ baseURL: BASE_URL });
    const anonPage = await anonCtx.newPage();
    const somchai = await loginCitizenPage(browser, CITIZENS.somchai);
    const reg1 = await loginStaffPage(browser, 'off.reg1');
    const exec1 = await loginStaffPage(browser, 'exec1');
    const audit1 = await loginStaffPage(browser, 'audit1');

    const loadChecks: Array<{ page: Page; url: string }> = [
      { page: anonPage, url: '/login' },
      { page: somchai.page, url: '/citizen' },
      { page: reg1.page, url: '/officer/queue' },
      { page: exec1.page, url: '/dashboard' },
      { page: audit1.page, url: '/audit' },
    ];
    try {
      for (const lc of loadChecks) {
        await lc.page.goto(lc.url, { waitUntil: 'load' });
        const t0 = Date.now();
        await lc.page.goto(lc.url, { waitUntil: 'load' });
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThanOrEqual(3000);
      }
    } finally {
      await anonCtx.close();
      await somchai.close();
      await reg1.close();
      await exec1.close();
      await audit1.close();
    }

    // 3. Reproducibility S1 === S2
    async function captureSnapshot() {
      const clock = await (await request.get(`${BASE_URL}/api/test/clock`)).json();
      const r1 = await loginStaffApi(browser, 'off.reg1');
      const e1 = await loginStaffApi(browser, 'exec1');
      try {
        const q = await (await r1.ctx.get(`${BASE_URL}/api/officer/queue?filter=all`)).json();
        const dash = await (await e1.ctx.get(`${BASE_URL}/api/dashboard?period=2026-12&service=ALL`)).json();
        return {
          clock,
          queue: q.items.map((x: { caseNo: string; dueAt: string; status: string; owner: string }) => ({
            caseNo: x.caseNo,
            dueAt: x.dueAt,
            status: x.status,
            owner: x.owner,
          })),
          dash,
        };
      } finally {
        await r1.close();
        await e1.close();
      }
    }

    await reset(request);
    const s1 = await captureSnapshot();

    // Mutate state
    await setClock(request, '2026-12-10T12:00:00+07:00');
    const rMut = await loginStaffApi(browser, 'off.reg1');
    await rMut.ctx.post(`${BASE_URL}/api/officer/cases/EG-2569-000028/claim`);
    await rMut.close();
    await newPaid(browser, request, { serviceId: 'SV-01', qty: 1 });

    await reset(request);
    const s2 = await captureSnapshot();
    expect(s2).toEqual(s1);
    expect(s2.clock.now).toBe('2026-12-01T09:00:00+07:00');

    // 4. Invalid clock without offset
    const badClock = await request.put(`${BASE_URL}/api/test/clock`, { data: { now: '2026-12-01 09:00' } });
    expect(badClock.status()).toBe(400);
    expect((await badClock.json()).code).toBe('INVALID_TIME');
  });

  test('TC-NFR-04 · เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async ({ browser, request }) => {
    await reset(request);
    // Register Mana with mobile 0845678901
    const manaCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      expect(
        (await manaCtx.request.post(`${BASE_URL}/api/auth/thaid/start`, { data: { idNo: CITIZENS.mana } })).status()
      ).toBe(200);
      expect(
        (
          await manaCtx.request.post(`${BASE_URL}/api/auth/thaid/verify`, {
            data: { idNo: CITIZENS.mana, otp: '123456' },
          })
        ).status()
      ).toBe(200);
      expect(
        (
          await manaCtx.request.post(`${BASE_URL}/api/auth/register`, {
            data: { mobile: '0845678901', email: '', consent: true },
          })
        ).status()
      ).toBe(201);
    } finally {
      await manaCtx.close();
    }

    const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'egov.db');
    const candidates = [
      dbPath,
      `${dbPath}-wal`,
      path.resolve(process.cwd(), 'app.db'),
      path.resolve(process.cwd(), 'egov.db'),
      path.resolve(process.cwd(), 'data', 'app.db'),
    ].filter((p) => fs.existsSync(p));

    expect(candidates.length).toBeGreaterThan(0);

    const forbiddenStrings = [
      '1101700123456',
      '3100600987659',
      '1909900555015',
      '5500400111221',
      '0812345678',
      '0823456789',
      '0834567890',
      '0845678901',
      '1-1017-00123-45-6',
      '3-1006-00987-65-9',
      '1-9099-00555-01-5',
      '5-5004-00111-22-1',
    ];

    for (const file of candidates) {
      const content = fs.readFileSync(file).toString('latin1');
      for (const s of forbiddenStrings) {
        expect(content).not.toContain(s);
      }
    }

    // Positive control: Somchai decrypts own idNo properly
    const somchai = await loginCitizenApi(browser, CITIZENS.somchai);
    try {
      const res = await somchai.ctx.get(`${BASE_URL}/api/cases/EG-2569-000005`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.idNo).toBe('1101700123456');
    } finally {
      await somchai.close();
    }
  });
});
