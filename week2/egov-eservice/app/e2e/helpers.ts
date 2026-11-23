import { APIRequestContext, BrowserContext, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:3005';
export const TESTFILES_DIR = path.resolve(__dirname, '..', 'testfiles');

export type ReqTarget = Page | BrowserContext | APIRequestContext;

export function getReq(target: ReqTarget): APIRequestContext {
  if (target && 'request' in target && typeof (target as Page | BrowserContext).request?.post === 'function') {
    return (target as Page | BrowserContext).request;
  }
  return target as APIRequestContext;
}

export async function clearTargetCookies(target: ReqTarget): Promise<void> {
  if (!target) return;
  if ('context' in target && typeof (target as Page).context === 'function') {
    await (target as Page).context().clearCookies();
  } else if ('clearCookies' in target && typeof (target as BrowserContext).clearCookies === 'function') {
    await (target as BrowserContext).clearCookies();
  }
}

export async function RESET(target: ReqTarget) {
  const req = getReq(target);
  const res = await req.post('/api/test/reset');
  expect(res.status()).toBe(200);
  await clearTargetCookies(target);
  return res.json();
}
export const reset = RESET;

export async function CLOCK(target: ReqTarget, now: string) {
  const req = getReq(target);
  const res = await req.put('/api/test/clock', { data: { now } });
  expect(res.status()).toBe(200);
  return res.json();
}
export const clock = CLOCK;
export const setClock = CLOCK;

export async function LOGIN_C(target: ReqTarget, idNo = '1101700123456', otp = '123456') {
  const req = getReq(target);
  const startRes = await req.post('/api/auth/thaid/start', { data: { idNo } });
  expect(startRes.status()).toBe(200);
  const verifyRes = await req.post('/api/auth/thaid/verify', { data: { idNo, otp } });
  expect(verifyRes.status()).toBe(200);
  return verifyRes.json();
}
export const loginC = LOGIN_C;
export const loginCitizen = LOGIN_C;

export async function LOGIN_S(target: ReqTarget, username: string, password = 'Test@1234') {
  const req = getReq(target);
  const res = await req.post('/api/auth/staff/login', { data: { username, password } });
  expect(res.status()).toBe(200);
  return res.json();
}
export const loginS = LOGIN_S;
export const loginStaff = LOGIN_S;

export function makePdfBuffer(n = 1024): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'ascii');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'ascii');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error(`PDF size too small: ${n}`);
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcVal = zlib.crc32(crcInput) >>> 0;
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function makePngBuffer(n = 1024): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const ihdr = pngChunk('IHDR', ihdrData);
  const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00])));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  const baseLen = sig.length + ihdr.length + idat.length + iend.length;
  const pad = n - baseLen - 12;
  const textPayload = Buffer.concat([Buffer.from('k\0', 'ascii'), Buffer.alloc(Math.max(0, pad - 2), 0x78)]);
  const text = pngChunk('tEXt', textPayload);
  return Buffer.concat([sig, ihdr, idat, text, iend]);
}

export function makeJpgBuffer(n = 1024): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const eoi = Buffer.from([0xff, 0xd9]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const comHeader = Buffer.alloc(4);
  comHeader[0] = 0xff;
  comHeader[1] = 0xfe;
  comHeader.writeUInt16BE(pad + 2, 2);
  return Buffer.concat([soi, app0, comHeader, Buffer.alloc(pad, 0x78), eoi]);
}

let filesEnsured = false;

export function ensureTestFiles(): void {
  if (filesEnsured && fs.existsSync( path.join(TESTFILES_DIR, 'id-card.pdf') )) return;
  fs.mkdirSync(TESTFILES_DIR, { recursive: true });
  const pdf1024 = makePdfBuffer(1024);
  const pdfNames = [
    'ok-id.pdf',
    'id-card.pdf',
    'map.pdf',
    'plan.pdf',
    'deed.pdf',
    'multi-1.pdf',
    'multi-2.pdf',
    'multi-3.pdf',
    'multi-4.pdf',
    'multi-5.pdf',
    'multi-6.pdf',
  ];
  for (const name of pdfNames) {
    fs.writeFileSync(path.join(TESTFILES_DIR, name), pdf1024);
  }
  fs.writeFileSync(path.join(TESTFILES_DIR, 'real.jpg'), makeJpgBuffer(1024));
  fs.writeFileSync(path.join(TESTFILES_DIR, 'plan-as-jpg.jpg'), makeJpgBuffer(1024));
  fs.writeFileSync(path.join(TESTFILES_DIR, 'real.png'), makePngBuffer(1024));
  for (const size of [5242879, 5242880, 5242881]) {
    const p = path.join(TESTFILES_DIR, `size-${size}.pdf`);
    if (!fs.existsSync(p) || fs.statSync(p).size !== size) {
      fs.writeFileSync(p, makePdfBuffer(size));
    }
  }
  const hello = Buffer.from('hello', 'ascii');
  fs.writeFileSync(path.join(TESTFILES_DIR, 'fake-text.pdf'), hello);
  fs.writeFileSync(path.join(TESTFILES_DIR, 'fake-text.jpg'), hello);
  fs.writeFileSync(path.join(TESTFILES_DIR, 'notes.txt'), hello);
  fs.writeFileSync(
    path.join(TESTFILES_DIR, 'exe-as.png'),
    Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(1022, 0)])
  );
  filesEnsured = true;
}

export function getTestFilePath(name: string): string {
  ensureTestFiles();
  return path.join(TESTFILES_DIR, name);
}

export function getTestFilePayload(name: string, overrideMimeType?: string): {
  name: string;
  mimeType: string;
  buffer: Buffer;
} {
  ensureTestFiles();
  const filePath = path.join(TESTFILES_DIR, name);
  const buffer = fs.readFileSync(filePath);
  let mimeType = overrideMimeType;
  if (!mimeType) {
    if (name.endsWith('.pdf')) mimeType = 'application/pdf';
    else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (name.endsWith('.png')) mimeType = 'image/png';
    else mimeType = 'text/plain';
  }
  return { name, mimeType, buffer };
}

export interface NewPaidOptions {
  idNo?: string;
  serviceId?: 'SV-01' | 'SV-02' | 'SV-03';
  time?: string;
  qty?: number;
  areaSqm?: number;
}

export async function NEW_PAID(
  target: ReqTarget,
  arg2?: string | NewPaidOptions,
  serviceIdArg?: 'SV-01' | 'SV-02' | 'SV-03',
  timeArg?: string,
  extraArg?: { qty?: number; areaSqm?: number }
): Promise<{
  caseNo: string;
  receiptNo: string;
  ref: string;
  draftId: string;
  fee: number;
}> {
  let opts: NewPaidOptions = {};
  if (typeof arg2 === 'object' && arg2 !== null) {
    opts = arg2;
  } else {
    opts = {
      idNo: arg2 || '1101700123456',
      serviceId: serviceIdArg || 'SV-01',
      time: timeArg,
      qty: extraArg?.qty,
      areaSqm: extraArg?.areaSqm,
    };
  }

  const req = getReq(target);
  const idNo = opts.idNo || '1101700123456';
  const serviceId = opts.serviceId || 'SV-01';

  if (opts.time) {
    await CLOCK(req, opts.time);
  }
  await LOGIN_C(req, idNo);

  const draftPayload: Record<string, unknown> = { serviceId };
  if (serviceId === 'SV-01') draftPayload.qty = opts.qty ?? 1;
  if (serviceId === 'SV-03') draftPayload.areaSqm = opts.areaSqm ?? 100;

  const draftRes = await req.post('/api/drafts', { data: draftPayload });
  expect(draftRes.status()).toBe(201);
  const { draftId, fee } = await draftRes.json();

  const requiredDocs: Array<{ docKey: string; fileName: string }> =
    serviceId === 'SV-01'
      ? [{ docKey: 'id-card', fileName: 'id-card.pdf' }]
      : serviceId === 'SV-02'
      ? [
          { docKey: 'id-card', fileName: 'id-card.pdf' },
          { docKey: 'map', fileName: 'map.pdf' },
        ]
      : [
          { docKey: 'id-card', fileName: 'id-card.pdf' },
          { docKey: 'plan', fileName: 'plan.pdf' },
          { docKey: 'deed', fileName: 'deed.pdf' },
        ];

  for (const doc of requiredDocs) {
    const payload = getTestFilePayload(doc.fileName);
    const upRes = await req.post(`/api/drafts/${draftId}/files`, {
      multipart: {
        docKey: doc.docKey,
        file: payload,
      },
    });
    expect(upRes.status()).toBe(201);
  }

  const qrRes = await req.post(`/api/drafts/${draftId}/payment`);
  expect(qrRes.status()).toBe(201);
  const { ref, amount } = await qrRes.json();
  const payAmount = amount ?? fee;

  const payRes = await req.post(`/api/test/payments/${ref}/pay`, {
    data: { amount: payAmount },
  });
  expect(payRes.status()).toBe(200);

  const getPayRes = await req.get(`/api/payments/${ref}`);
  expect(getPayRes.status()).toBe(200);
  const payData = await getPayRes.json();

  return {
    caseNo: payData.caseNo,
    receiptNo: payData.receiptNo,
    ref,
    draftId,
    fee: payAmount,
  };
}
export const newPaid = NEW_PAID;
