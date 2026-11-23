'use strict';
/**
 * B08 · เอกสารดิจิทัล: ออก PDF + ลายเซ็น HMAC + /verify
 *
 * CONTRACT §1 (/verify/:code) · §2.6 (issue-btn, doc-no, verify-code, doc-qr, download-doc-btn)
 *          §2.13 (/verify/:code testids) · §3 (PDF ASCII line + HMAC-SHA256) · §6.2 · §6.3 · §6.4 · §8 (tamper)
 * DECISIONS §10 · §18 (A-22, A-23, A-27, A-43, A-48, A-54, A-58, A-61, A-63)
 * REQUIREMENTS FR-17 · FR-18 · BR-21 · BR-23
 *
 * Endpoints:
 *   POST /api/officer/cases/:caseNo/issue       → issue DOC-<BE>-<6 digits>, update case to COMPLETED, write audit ISSUE
 *   GET  /api/documents/:docNo/pdf              → application/pdf with embedded Thai font, QR code & machine-readable ASCII line
 *   GET  /api/documents/:docNo/qr               → image/png QR code pointing to <BASE_URL>/verify/<verifyCode>
 *   GET  /api/verify/:code                      → public JSON verification result (VALID / EXPIRED / TAMPERED / 404 NOT_FOUND)
 *   GET  /verify/:code                          → public SSR verification page (masked applicant name, PDPA-compliant)
 *   POST /api/test/documents/:docNo/tamper      → test hook (TEST_MODE=1): mutate stored field without recalculating HMAC
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nodeCrypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const cryptoLib = require('../lib/crypto');
const rules = require('../lib/rules');
const { writeAudit } = require('../lib/audit');

const VERIFY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VERIFY_CODE_LEN = 8;

const RESULT_TH = Object.freeze({
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
});

const RESULT_BADGE_CLASS = Object.freeze({
  VALID: 'st-completed',
  EXPIRED: 'st-need_fix',
  TAMPERED: 'st-rejected',
  NOT_FOUND: 'st-cancelled',
});

const SYSTEM_THAI_FONT_PATHS = [
  '/usr/share/fonts/opentype/tlwg/Loma.otf',
  '/usr/share/fonts/opentype/tlwg/Waree.otf',
  '/usr/share/fonts/truetype/tlwg/Loma.ttf',
  '/usr/share/fonts/truetype/tlwg/Garuda.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
];

let cachedThaiFontBuffer = null;

/**
 * Load Thai OpenType/TrueType font for embedding in PDFKit.
 * Prefers system Loma.otf on disk; falls back to embedded brotli-compressed Loma.otf.
 */
function getThaiFontBuffer() {
  if (cachedThaiFontBuffer) return cachedThaiFontBuffer;
  for (const p of SYSTEM_THAI_FONT_PATHS) {
    try {
      if (fs.existsSync(p)) {
        cachedThaiFontBuffer = fs.readFileSync(p);
        return cachedThaiFontBuffer;
      }
    } catch {
      // try next
    }
  }
  if (EMBEDDED_LOMA_OTF_BR_B64) {
    try {
      cachedThaiFontBuffer = zlib.brotliDecompressSync(Buffer.from(EMBEDDED_LOMA_OTF_BR_B64, 'base64'));
      return cachedThaiFontBuffer;
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * BR-23 / A-54 / A-58:
 * Full first name + space + first character of surname + '***'
 * If no surname (single part), returns '<firstName> ***'.
 */
function maskName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length < 2) return `${parts[0]} ***`;
  const first = parts[0];
  const lastInitial = Array.from(parts.slice(1).join(' '))[0] || '';
  return `${first} ${lastInitial}***`;
}

/**
 * Resolve base URL for verification links & QR codes.
 */
function resolveBaseUrl(req) {
  if (process.env.BASE_URL) return String(process.env.BASE_URL).replace(/\/+$/, '');
  if (req && typeof req.get === 'function') {
    const host = req.get('host');
    if (host) return `${req.protocol || 'http'}://${host}`;
  }
  const port = process.env.PORT || 3005;
  return `http://localhost:${port}`;
}

function verifyUrlFor(verifyCode, reqOrBaseUrl) {
  const base =
    typeof reqOrBaseUrl === 'string' && reqOrBaseUrl
      ? reqOrBaseUrl.replace(/\/+$/, '')
      : resolveBaseUrl(reqOrBaseUrl);
  return `${base}/verify/${encodeURIComponent(verifyCode)}`;
}

/**
 * Generate a unique 8-character uppercase alphanumeric verify code ([A-Z0-9]{8}).
 */
function generateUniqueVerifyCode(db) {
  const checkStmt = db.prepare('SELECT 1 FROM documents WHERE verify_code = ?');
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = nodeCrypto.randomBytes(VERIFY_CODE_LEN);
    let code = '';
    for (let i = 0; i < VERIFY_CODE_LEN; i++) {
      code += VERIFY_ALPHABET[bytes[i] % VERIFY_ALPHABET.length];
    }
    if (!checkStmt.get(code)) return code;
  }
  throw new Error('Unable to generate unique verify_code');
}

/**
 * Determine which officer username is authorized to issue the document for a case (DECISIONS §10, §18 A-27):
 * - The registry officer who initially claimed step 1 (`cases.issuer`).
 * - Falls back to `cases.owner` (if registry) or earliest CLAIM event in `case_events` / `audit`.
 */
function resolveIssuerUsername(db, caseRow) {
  if (!caseRow) return null;
  if (caseRow.issuer) return caseRow.issuer;
  if (caseRow.service_id === 'SV-01') {
    if (caseRow.owner) return caseRow.owner;
    if (caseRow.approved_by) return caseRow.approved_by;
  }
  if (caseRow.owner) {
    const u = db.prepare('SELECT dept FROM users WHERE username = ?').get(caseRow.owner);
    if (!u || u.dept === 'registry') return caseRow.owner;
  }
  const ev = db
    .prepare(
      `SELECT ce.actor AS username
         FROM case_events ce
         LEFT JOIN users u ON u.username = ce.actor
        WHERE ce.case_no = ? AND ce.event = 'CLAIM' AND ce.actor IS NOT NULL
          AND (u.dept = 'registry' OR u.dept IS NULL)
        ORDER BY ce.id ASC LIMIT 1`
    )
    .get(caseRow.case_no);
  if (ev && ev.username) return ev.username;

  const au = db
    .prepare(
      `SELECT a.username
         FROM audit a
         LEFT JOIN users u ON u.username = a.username
        WHERE a.case_no = ? AND a.event = 'CLAIM' AND a.username IS NOT NULL
          AND (u.dept = 'registry' OR u.dept IS NULL)
        ORDER BY a.id ASC LIMIT 1`
    )
    .get(caseRow.case_no);
  if (au && au.username) return au.username;

  return caseRow.owner || null;
}

/**
 * Check whether `user` is allowed to press/call "ออกเอกสาร" for `caseRow` (A-27).
 */
function canUserIssueCase(db, user, caseRow) {
  if (!user || user.role !== 'officer' || !caseRow) return false;
  if (user.dept && user.dept !== 'registry') return false;
  const allowedIssuer = resolveIssuerUsername(db, caseRow);
  if (allowedIssuer && user.username !== allowedIssuer) return false;
  return true;
}

/**
 * Determine the signer display name and username (DECISIONS §10):
 * - SV-01: approving officer
 * - SV-02 / SV-03: head of department (`หัวหน้าฝ่าย`)
 */
function resolveSigner(db, caseRow, issuerUser) {
  let signerUsername = caseRow.approved_by || null;
  if (!signerUsername) {
    const ev = db
      .prepare(
        `SELECT actor FROM case_events WHERE case_no = ? AND event = 'APPROVE' AND actor IS NOT NULL ORDER BY id DESC LIMIT 1`
      )
      .get(caseRow.case_no);
    if (ev && ev.actor) signerUsername = ev.actor;
  }
  if (!signerUsername) {
    const au = db
      .prepare(
        `SELECT username FROM audit WHERE case_no = ? AND event = 'APPROVE' AND username IS NOT NULL ORDER BY id DESC LIMIT 1`
      )
      .get(caseRow.case_no);
    if (au && au.username) signerUsername = au.username;
  }
  if (!signerUsername) {
    if (caseRow.service_id === 'SV-01') {
      signerUsername = (issuerUser && issuerUser.username) || caseRow.owner || caseRow.issuer || 'off.reg1';
    } else {
      const headRow = db.prepare("SELECT username FROM users WHERE role = 'head' ORDER BY id ASC LIMIT 1").get();
      signerUsername = (headRow && headRow.username) || 'head1';
    }
  }
  const userRow = signerUsername
    ? db.prepare('SELECT name FROM users WHERE username = ?').get(signerUsername)
    : null;
  const fallbackName =
    caseRow.service_id === 'SV-01'
      ? (issuerUser && issuerUser.name) || 'เจ้าหน้าที่ทะเบียน'
      : 'หัวหน้าฝ่าย';
  return {
    signerUsername,
    signer: (userRow && userRow.name) || fallbackName,
  };
}

function resolveApplicantName(db, caseRow) {
  if (caseRow.applicant_name) return caseRow.applicant_name;
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(caseRow.citizen_id);
  return (u && u.name) || '';
}

/**
 * Issue a digital document for an APPROVED case inside a single SQLite transaction.
 * Returns `{ ok: true, doc, docNo, verifyCode, status: 'COMPLETED', closedAt, validUntil }`
 * or `{ ok: false, status, code }`.
 */
function issueDocumentForCase(ctx, caseNo, actorUser) {
  const { db, clock } = ctx;
  if (!actorUser) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
  if (actorUser.role !== 'officer') return { ok: false, status: 403, code: 'FORBIDDEN' };

  return db.transaction(() => {
    const caseRow = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
    if (!caseRow) return { ok: false, status: 404, code: 'NOT_FOUND' };

    if (!canUserIssueCase(db, actorUser, caseRow)) {
      return { ok: false, status: 403, code: 'FORBIDDEN' };
    }

    if (caseRow.status !== 'APPROVED') {
      return { ok: false, status: 409, code: 'INVALID_STATE' };
    }

    const existingDoc = db.prepare('SELECT * FROM documents WHERE case_no = ?').get(caseNo);
    if (existingDoc) {
      return { ok: false, status: 409, code: 'INVALID_STATE' };
    }

    const issuedAt = clock.nowIso();
    const yearBE = rules.beYearOf(issuedAt);
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM documents WHERE year_be = ?')
      .get(yearBE);
    const seq = db.nextSeq(rules.seqKey('doc', issuedAt), maxRow ? maxRow.m : 0);
    for (const alias of [`doc_${yearBE}`, `document:${yearBE}`, `DOC-${yearBE}`]) {
      db.setSeq(alias, seq);
    }
    if (yearBE === 2569) db.setSeq('doc', seq);

    const docNo = rules.formatDocNo(yearBE, seq);
    const verifyCode = generateUniqueVerifyCode(db);
    const applicant = resolveApplicantName(db, caseRow);
    const serviceId = caseRow.service_id;
    const serviceRow = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    const validUntil = rules.docValidUntil(issuedAt, (serviceRow && serviceRow.validity) || serviceId);
    const { signer, signerUsername } = resolveSigner(db, caseRow, actorUser);

    const docRecord = {
      doc_no: docNo,
      year_be: yearBE,
      seq,
      case_no: caseRow.case_no,
      verify_code: verifyCode,
      applicant,
      service_id: serviceId,
      issued_at: issuedAt,
      valid_until: validUntil,
      signer,
      signer_username: signerUsername,
      issued_by: actorUser.username,
    };
    docRecord.signature = cryptoLib.signDocument(docRecord);

    db.prepare(
      `INSERT INTO documents (
         doc_no, year_be, seq, case_no, verify_code, applicant, service_id,
         issued_at, valid_until, signer, signer_username, issued_by, signature
       ) VALUES (
         @doc_no, @year_be, @seq, @case_no, @verify_code, @applicant, @service_id,
         @issued_at, @valid_until, @signer, @signer_username, @issued_by, @signature
       )`
    ).run(docRecord);

    db.prepare(
      `UPDATE cases
          SET status = 'COMPLETED',
              stage = 'closed',
              owner = NULL,
              closed_at = ?,
              doc_no = ?,
              updated_at = ?
        WHERE case_no = ?`
    ).run(issuedAt, docNo, issuedAt, caseRow.case_no);

    db.prepare(
      `INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail)
       VALUES (?, ?, ?, ?, 'ISSUE', 'APPROVED', 'COMPLETED', ?)`
    ).run(caseRow.case_no, issuedAt, actorUser.username, actorUser.role, docNo);

    writeAudit({
      time: issuedAt,
      username: actorUser.username,
      role: actorUser.role,
      event: 'ISSUE',
      caseNo: caseRow.case_no,
      fromStatus: 'APPROVED',
      toStatus: 'COMPLETED',
      detail: docNo,
    });

    return {
      ok: true,
      doc: docRecord,
      docNo,
      verifyCode,
      status: 'COMPLETED',
      closedAt: issuedAt,
      validUntil,
    };
  })();
}

/**
 * Evaluate verification status for a verifyCode at current test clock time.
 * Order (A-43 / rules.verifyResult): NOT_FOUND -> TAMPERED -> EXPIRED -> VALID.
 */
function evaluateVerifyCode(ctx, verifyCode) {
  const { db, clock } = ctx;
  const code = String(verifyCode || '').trim();
  const docRow = code ? db.prepare('SELECT * FROM documents WHERE verify_code = ?').get(code) : null;
  if (!docRow) {
    return { result: 'NOT_FOUND', doc: null, serviceName: null };
  }
  const signatureOk = cryptoLib.verifyDocumentSignature(docRow);
  const result = rules.verifyResult(
    {
      found: true,
      signatureOk,
      validUntil: docRow.valid_until,
    },
    clock.now()
  );
  const svc = db.prepare('SELECT name FROM services WHERE id = ?').get(docRow.service_id);
  return {
    result,
    doc: docRow,
    serviceName: (svc && svc.name) || ctx.format.SERVICE_NAME[docRow.service_id] || '',
  };
}

/**
 * Generate a PDF buffer for an issued document row (DECISIONS §10, CONTRACT §3).
 * - Embeds Thai font (Loma.otf)
 * - Includes all required fields in Thai + QR code image pointing to <BASE_URL>/verify/<verifyCode>
 * - Includes single machine-readable ASCII line:
 *   `docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=<8 chars> validUntil=2027-02-28`
 */
async function generateDocumentPdf(docRow, opts = {}) {
  const format = opts.format || require('../lib/format');
  const serviceName = opts.serviceName || format.SERVICE_NAME[docRow.service_id] || '';
  const serviceDisplay = format.serviceLabel(docRow.service_id, serviceName);
  const verifyUrl = opts.verifyUrl || verifyUrlFor(docRow.verify_code, opts.req || opts.baseUrl);
  const asciiLine = `docNo=${docRow.doc_no} caseNo=${docRow.case_no} verify=${docRow.verify_code} validUntil=${docRow.valid_until}`;

  const qrPngBuffer = await QRCode.toBuffer(verifyUrl, {
    type: 'png',
    width: 140,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  const thaiFontBuf = getThaiFontBuffer();

  const pdf = new PDFDocument({
    size: 'A4',
    margin: 50,
    compress: false,
    info: {
      Title: `${docRow.doc_no} - ${docRow.case_no}`,
      Author: 'เทศบาลนครตัวอย่าง (หน่วยงานสมมติ)',
    },
  });

  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  // Uncompressed machine-readable ASCII line in stream (CONTRACT §3, A-63)
  pdf.addContent(`% ${asciiLine}`);

  const hasThaiFont = Boolean(thaiFontBuf);
  if (hasThaiFont) {
    pdf.registerFont('ThaiFont', thaiFontBuf);
    pdf.font('ThaiFont');
  } else {
    pdf.font('Helvetica');
  }

  // Header
  pdf.fontSize(20).fillColor('#1d3557').text('เทศบาลนครตัวอย่าง (หน่วยงานสมมติ)', { align: 'center' });
  pdf.fontSize(15).fillColor('#1a1a1a').text('เอกสารดิจิทัลรับรองผลการพิจารณา (e-Service)', { align: 'center' });
  pdf.moveDown(0.8);

  // Horizontal divider
  const startX = 50;
  const endX = 545;
  pdf.moveTo(startX, pdf.y).lineTo(endX, pdf.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
  pdf.moveDown(0.8);

  // Document fields (DECISIONS §10)
  pdf.fontSize(12).fillColor('#1a1a1a');
  const rows = [
    ['เลขเอกสาร (Document No.)', docRow.doc_no],
    ['เลขคำขอ (Case No.)', docRow.case_no],
    ['ชื่อผู้ยื่นคำขอ (Applicant)', docRow.applicant],
    ['บริการ (Service)', serviceDisplay],
    ['วันที่ออกเอกสาร (Issued At)', `${format.thDateTime(docRow.issued_at)} (${format.iso(docRow.issued_at)})`],
    ['วันหมดอายุ / ใช้ได้ถึง (Valid Until)', `${format.thDate(docRow.valid_until)} (${docRow.valid_until})`],
    ['ผู้ลงนามอนุมัติ (Signer)', docRow.signer],
    ['รหัสตรวจสอบ (Verify Code)', docRow.verify_code],
    ['ลิงก์ตรวจสอบ (Verify URL)', verifyUrl],
    ['ลายเซ็นดิจิทัล (HMAC-SHA256)', docRow.signature],
  ];

  for (const [label, value] of rows) {
    pdf.text(`${label}: ${value}`);
    pdf.moveDown(0.3);
  }

  pdf.moveDown(0.5);
  try {
    pdf.image(qrPngBuffer, { width: 120 });
    pdf.moveDown(0.5);
  } catch {
    // ignore image placement failure if any
  }

  if (hasThaiFont) {
    pdf.font('ThaiFont').fontSize(10).fillColor('#4b5563');
    pdf.text('สแกน QR Code หรือเปิดลิงก์ด้านบนเพื่อตรวจสอบความถูกต้องของเอกสารดิจิทัลโดยไม่ต้องเข้าสู่ระบบ');
    pdf.moveDown(0.6);
  }

  // Visible ASCII line using standard Helvetica font as well
  pdf.font('Helvetica').fontSize(9).fillColor('#374151').text(asciiLine);

  pdf.end();
  return done;
}

/**
 * Generate an inline SVG or Data URL QR code for `/verify/<verifyCode>` (for case detail views).
 */
async function generateQrDataUrl(verifyCode, reqOrBaseUrl) {
  const url = verifyUrlFor(verifyCode, reqOrBaseUrl);
  return QRCode.toDataURL(url, { width: 160, margin: 1, errorCorrectionLevel: 'M' });
}

function isFormNavigation(req) {
  const accept = String((req.headers && req.headers.accept) || '');
  const ct = String((req.headers && req.headers['content-type']) || '');
  const fetchMode = String((req.headers && req.headers['sec-fetch-mode']) || '');
  if (fetchMode === 'navigate') return true;
  if (
    accept.startsWith('text/html') &&
    !accept.includes('application/json') &&
    (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data'))
  ) {
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ Express module
module.exports = {
  order: 20,
  register(app, ctx) {
    const { db, clock, layout: L, format } = ctx;
    const { esc } = format;

    // Ensure format.maskName in memory also handles single-word names per A-58 / BR-23
    format.maskName = maskName;

    // Expose helpers on ctx.documents for other modules if needed
    const docHelpers = {
      maskName,
      verifyUrlFor,
      generateUniqueVerifyCode: () => generateUniqueVerifyCode(db),
      resolveIssuerUsername: (caseRow) => resolveIssuerUsername(db, caseRow),
      canUserIssueCase: (user, caseRow) => canUserIssueCase(db, user, caseRow),
      resolveSigner: (caseRow, issuerUser) => resolveSigner(db, caseRow, issuerUser),
      issueDocumentForCase: (caseNo, actorUser) => issueDocumentForCase(ctx, caseNo, actorUser),
      evaluateVerifyCode: (code) => evaluateVerifyCode(ctx, code),
      generateDocumentPdf: (docRow, opts) => generateDocumentPdf(docRow, { format, ...opts }),
      generateQrDataUrl: (verifyCode, reqOrBase) => generateQrDataUrl(verifyCode, reqOrBase),
      getDocumentByNo: (docNo) => db.prepare('SELECT * FROM documents WHERE doc_no = ?').get(docNo) || null,
      getDocumentByCaseNo: (caseNo) => db.prepare('SELECT * FROM documents WHERE case_no = ?').get(caseNo) || null,
      getDocumentByVerifyCode: (code) => db.prepare('SELECT * FROM documents WHERE verify_code = ?').get(code) || null,
    };
    ctx.documents = docHelpers;

    // ---------------------------------------------------------- 1. Issue Document API
    function handleIssue(req, res) {
      const formNav = !L.isApi(req) || isFormNavigation(req);
      if (!req.user) {
        if (formNav && !L.isApi(req)) return L.sendUnauthenticated(req, res);
        return L.apiError(res, 401, 'UNAUTHENTICATED');
      }
      const caseNo = String(req.params.caseNo || '').trim();
      const out = issueDocumentForCase(ctx, caseNo, req.user);
      if (!out.ok) {
        if (formNav) {
          return res.redirect(303, `/officer/cases/${encodeURIComponent(caseNo)}`);
        }
        return L.apiError(res, out.status, out.code);
      }
      if (formNav) {
        return res.redirect(303, `/officer/cases/${encodeURIComponent(caseNo)}`);
      }
      return res.status(200).json({
        docNo: out.docNo,
        verifyCode: out.verifyCode,
        status: out.status,
        closedAt: out.closedAt,
        validUntil: out.validUntil,
      });
    }

    app.post('/api/officer/cases/:caseNo/issue', handleIssue);
    app.post('/api/cases/:caseNo/issue', handleIssue);
    app.post('/officer/cases/:caseNo/issue', handleIssue);

    // ---------------------------------------------------------- 2. Download PDF API
    const handleDownloadPdf = L.ah(async (req, res) => {
      if (!req.user) return L.sendUnauthenticated(req, res);

      const docNo = String(req.params.docNo || '').trim();
      const docRow = docNo ? db.prepare('SELECT * FROM documents WHERE doc_no = ?').get(docNo) : null;
      if (!docRow) {
        return L.apiError(res, 404, 'NOT_FOUND');
      }

      const role = req.user.role;
      if (role === 'citizen') {
        const caseRow = db.prepare('SELECT citizen_id FROM cases WHERE case_no = ?').get(docRow.case_no);
        const isOwner = caseRow && Number(caseRow.citizen_id) === Number(req.user.id);
        if (!isOwner && !ctx.bugmode.isBug('B06')) {
          return L.apiError(res, 404, 'NOT_FOUND');
        }
      } else if (role !== 'officer' && role !== 'head') {
        // CONTRACT §6.2: citizen เจ้าของ · officer · head | คนอื่น → 404
        return L.apiError(res, 404, 'NOT_FOUND');
      }

      const svc = db.prepare('SELECT name FROM services WHERE id = ?').get(docRow.service_id);
      const pdfBuffer = await generateDocumentPdf(docRow, {
        req,
        format,
        serviceName: (svc && svc.name) || format.SERVICE_NAME[docRow.service_id] || '',
      });

      res.status(200);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${docRow.doc_no}.pdf"`);
      res.set('Content-Length', String(pdfBuffer.length));
      return res.end(pdfBuffer);
    });

    app.get('/api/documents/:docNo/pdf', handleDownloadPdf);
    app.get('/documents/:docNo/pdf', handleDownloadPdf);

    // ---------------------------------------------------------- 3. QR Image Endpoints
    const handleDocQr = L.ah(async (req, res) => {
      const docNo = String(req.params.docNo || '').trim();
      const docRow = docNo ? db.prepare('SELECT verify_code FROM documents WHERE doc_no = ?').get(docNo) : null;
      if (!docRow) return L.apiError(res, 404, 'NOT_FOUND');
      const url = verifyUrlFor(docRow.verify_code, req);
      const png = await QRCode.toBuffer(url, { type: 'png', width: 160, margin: 1 });
      res.status(200).type('image/png').send(png);
    });

    const handleVerifyQr = L.ah(async (req, res) => {
      const code = String(req.params.code || '').trim();
      if (!code) return L.apiError(res, 404, 'NOT_FOUND');
      const url = verifyUrlFor(code, req);
      const png = await QRCode.toBuffer(url, { type: 'png', width: 160, margin: 1 });
      res.status(200).type('image/png').send(png);
    });

    app.get('/api/documents/:docNo/qr', handleDocQr);
    app.get('/api/verify/:code/qr', handleVerifyQr);

    // ---------------------------------------------------------- 4. Public Verify API (CONTRACT §6.4)
    app.get('/api/verify/:code', (req, res) => {
      const { result, doc } = evaluateVerifyCode(ctx, req.params.code);
      if (result === 'NOT_FOUND') {
        return res.status(404).json({ result: 'NOT_FOUND' });
      }
      if (result === 'TAMPERED') {
        return res.status(200).json({ result: 'TAMPERED' });
      }
      return res.status(200).json({
        result,
        docNo: doc.doc_no,
        applicantMasked: maskName(doc.applicant),
        serviceId: doc.service_id,
        issuedAt: clock.toIso(doc.issued_at),
        validUntil: doc.valid_until,
        signer: doc.signer,
      });
    });

    // ---------------------------------------------------------- 5. Public Verify Page (CONTRACT §1, §2.13)
    const VERIFY_HEAD = `<style>
.verify-wrap { max-width: 680px; margin: 0 auto; }
.verify-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin: 0 0 16px; }
.verify-badge { font-size: 1.15rem; padding: 6px 16px; }
</style>`;

    function renderVerifyPage(req, res, codeRaw) {
      const { result, doc, serviceName } = evaluateVerifyCode(ctx, codeRaw);
      const httpStatus = result === 'NOT_FOUND' ? 404 : 200;
      const resultText = RESULT_TH[result] || RESULT_TH.NOT_FOUND;
      const badgeCls = RESULT_BADGE_CLASS[result] || 'st-cancelled';

      const showDetails = (result === 'VALID' || result === 'EXPIRED') && doc;
      const detailsHtml = showDetails
        ? `<dl class="kv">
  <dt>เลขเอกสาร</dt>
  <dd data-testid="verify-doc-no">${esc(doc.doc_no)}</dd>
  <dt>ผู้ยื่นคำขอ (ปิดบังตาม PDPA)</dt>
  <dd data-testid="verify-applicant">${esc(maskName(doc.applicant))}</dd>
  <dt>บริการ</dt>
  <dd data-testid="verify-service">${esc(format.serviceLabel(doc.service_id, serviceName))}</dd>
  <dt>วันที่ออกเอกสาร</dt>
  <dd>${format.timeTag(doc.issued_at, 'verify-issued')}</dd>
  <dt>ใช้ได้ถึง</dt>
  <dd>${format.timeTag(doc.valid_until, 'verify-expires', { dateOnly: true })}</dd>
  <dt>ผู้ลงนามอนุมัติ</dt>
  <dd data-testid="verify-signer">${esc(doc.signer)}</dd>
</dl>`
        : `<p class="muted" style="margin:0">${
            result === 'TAMPERED'
              ? 'ข้อมูลเอกสารไม่ตรงกับลายเซ็นดิจิทัลที่บันทึกไว้ ระบบจึงไม่แสดงรายละเอียดของเอกสารนี้'
              : 'ไม่พบข้อมูลเอกสารตามรหัสตรวจสอบที่ระบุ'
          }</p>`;

      const body = `<div class="verify-wrap">
<h1>ตรวจสอบเอกสารดิจิทัล</h1>
<section class="card" aria-labelledby="verify-heading">
  <h2 id="verify-heading" style="margin-top:0">ผลการตรวจสอบ</h2>
  <div class="verify-banner">
    <span data-testid="verify-result" data-result="${esc(result)}" class="badge verify-badge ${esc(badgeCls)}">${esc(resultText)}</span>
  </div>
  ${detailsHtml}
</section>
</div>`;

      return L.render(req, res, {
        status: httpStatus,
        title: 'ตรวจสอบเอกสารดิจิทัล',
        body,
        head: VERIFY_HEAD,
      });
    }

    app.get('/verify/:code', (req, res) => renderVerifyPage(req, res, req.params.code));
    app.get('/verify', (req, res) => renderVerifyPage(req, res, ''));

    // ---------------------------------------------------------- 6. Test Hook: Tamper Document (CONTRACT §8)
    app.post('/api/test/documents/:docNo/tamper', (req, res) => {
      if (!ctx.TEST_MODE) return L.apiError(res, 404, 'NOT_FOUND', 'Not Found');
      const docNo = String(req.params.docNo || '').trim();
      const docRow = docNo ? db.prepare('SELECT * FROM documents WHERE doc_no = ?').get(docNo) : null;
      if (!docRow) {
        return L.apiError(res, 404, 'NOT_FOUND', L.ERRORS.DOC_NOT_FOUND);
      }
      // Mutate a signed field (applicant) WITHOUT recalculating signature
      const tamperedApplicant = docRow.applicant.endsWith(' (แก้ไข)')
        ? `${docRow.applicant}!`
        : `${docRow.applicant} (แก้ไข)`;
      db.prepare('UPDATE documents SET applicant = ? WHERE doc_no = ?').run(tamperedApplicant, docNo);
      return res.status(200).json({ ok: true });
    });
  },
};

const EMBEDDED_LOMA_OTF_BR_B64 = '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';

module.exports.maskName = maskName;
module.exports.verifyUrlFor = verifyUrlFor;
module.exports.generateUniqueVerifyCode = generateUniqueVerifyCode;
module.exports.resolveIssuerUsername = resolveIssuerUsername;
module.exports.canUserIssueCase = canUserIssueCase;
module.exports.resolveSigner = resolveSigner;
module.exports.issueDocumentForCase = issueDocumentForCase;
module.exports.evaluateVerifyCode = evaluateVerifyCode;
module.exports.generateDocumentPdf = generateDocumentPdf;
module.exports.generateQrDataUrl = generateQrDataUrl;
