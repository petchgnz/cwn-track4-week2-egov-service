'use strict';
/**
 * B06 · ฝั่งประชาชน: ยื่นคำขอ ร่าง อัปโหลด ชำระ QR ติดตาม แก้ไข ยกเลิก
 *
 * CONTRACT §1 (/citizen, /citizen/new/:service, /citizen/cases/:caseNo)
 *          §2.4 · §2.5 · §2.6 · §4 · §5 · §6.2 · §6.7 · §8 (POST /api/test/payments/:ref/pay)
 * DECISIONS §3–§9 · §11 · §18
 * BUG_MODE:
 *   - B02: ไฟล์ 5,242,880 ไบต์พอดีถูกปฏิเสธ (ใช้ < แทน <=)
 *   - B06: ประชาชนเปิดคำขอของคนอื่นผ่าน URL / API ได้ (IDOR)
 *   (B01, B03, B04, B05 อยู่ใน src/lib/rules.js แล้ว)
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rules = require('../lib/rules');
const cryptoLib = require('../lib/crypto');

const SERVICE_DOCS = Object.freeze({
  'SV-01': Object.freeze([
    { key: 'id-card', label: 'บัตรประชาชน', required: true, pdfOnly: false },
  ]),
  'SV-02': Object.freeze([
    { key: 'id-card', label: 'บัตรประชาชน', required: true, pdfOnly: false },
    { key: 'map', label: 'แผนที่ตั้ง', required: true, pdfOnly: false },
    { key: 'site-photo', label: 'ภาพสถานที่', required: false, pdfOnly: false },
  ]),
  'SV-03': Object.freeze([
    { key: 'id-card', label: 'บัตรประชาชน', required: true, pdfOnly: false },
    { key: 'plan', label: 'แบบแปลน', required: true, pdfOnly: true },
    { key: 'deed', label: 'โฉนด', required: true, pdfOnly: false },
  ]),
});

const VALID_SERVICES = new Set(['SV-01', 'SV-02', 'SV-03']);
const VALID_DOC_KEYS = new Set(['id-card', 'map', 'site-photo', 'plan', 'deed', 'extra']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    fieldSize: 15 * 1024 * 1024,
  },
});

function runUpload(req, res, next) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('multipart/form-data')) return next();
  upload.any()(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const L = require('../lib/layout');
        return L.apiError(res, 400, 'FILE_TOO_LARGE');
      }
      return next(err);
    }
    return next();
  });
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

module.exports = {
  order: 20,
  register(app, ctx) {
    const { db, clock, layout: L, format, hooks, bugmode } = ctx;
    const { esc } = format;

    // --------------------------------------------------------- Auto-cancel expired NEED_FIX (168h · BR-20 / A-46)
    function autoCancelExpiredFixCases() {
      const now = clock.now();
      const rows = db
        .prepare("SELECT case_no, returned_at, fix_deadline FROM cases WHERE status = 'NEED_FIX' AND returned_at IS NOT NULL")
        .all();
      if (!rows.length) return;
      const cancelTx = db.transaction((c, deadlineIso) => {
        const info = db
          .prepare(
            `UPDATE cases
                SET status = 'CANCELLED',
                    stage = 'closed',
                    owner = NULL,
                    cancelled_at = ?,
                    cancel_reason = 'AUTO_FIX_EXPIRED',
                    updated_at = ?
              WHERE case_no = ? AND status = 'NEED_FIX'`
          )
          .run(deadlineIso, deadlineIso, c.case_no);
        if (info.changes === 1) {
          db.prepare(
            `INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail)
             VALUES (?, ?, 'system', 'system', 'AUTO_CANCEL', 'NEED_FIX', 'CANCELLED', 'หมดเวลาแก้ไขเอกสาร 168 ชั่วโมง ระบบยกเลิกอัตโนมัติ')`
          ).run(c.case_no, deadlineIso);
        }
      });
      for (const c of rows) {
        if (rules.isFixWindowExpired(c.returned_at, now)) {
          const deadlineIso = c.fix_deadline || rules.fixDeadline(c.returned_at);
          cancelTx(c, deadlineIso);
        }
      }
    }

    hooks.onRequest(() => {
      autoCancelExpiredFixCases();
    });

    // --------------------------------------------------------- Helpers
    function getServiceRow(serviceId) {
      return db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId) || null;
    }

    function getDraftFiles(draftId) {
      return db
        .prepare('SELECT id AS fileId, name, doc_key AS docKey, size, mime FROM files WHERE draft_id = ? ORDER BY created_at ASC, id ASC')
        .all(draftId);
    }

    function getCaseFiles(caseNo) {
      return db
        .prepare('SELECT id AS fileId, name, doc_key AS docKey, size, mime FROM files WHERE case_no = ? ORDER BY created_at ASC, id ASC')
        .all(caseNo);
    }

    function getMissingDocs(serviceId, filesList) {
      const reqList = SERVICE_DOCS[serviceId] || [];
      const present = new Set((filesList || []).map((f) => f.docKey || f.doc_key));
      return reqList.filter((d) => d.required && !present.has(d.key)).map((d) => d.label);
    }

    function checkFileSize(size) {
      if (bugmode.isBug('B02')) {
        const n = rules.toInt(size);
        return n !== null && n >= 0 && n < rules.FILE_MAX_BYTES;
      }
      return rules.fileSizeOk(size);
    }

    function nextDraftId() {
      const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM drafts').get();
      const seq = db.nextSeq('draft', maxRow ? maxRow.m : 0);
      db.setSeq('DR', seq);
      return { seq, id: `DR-${pad(seq, 4)}` };
    }

    function nextPaymentRef() {
      const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM payments').get();
      const seq = db.nextSeq('payment', maxRow ? maxRow.m : 0);
      db.setSeq('PP', seq);
      db.setSeq('pay', seq);
      return { seq, ref: `PP-${pad(seq, 4)}` };
    }

    function nextFileId() {
      const seq = db.nextSeq('file');
      db.setSeq('F', seq);
      return `F-${pad(seq, 6)}`;
    }

    function decryptCitizenIdNo(userRow) {
      if (!userRow || !userRow.id_enc) return '';
      try {
        return cryptoLib.decrypt(userRow.id_enc) || '';
      } catch {
        return '';
      }
    }

    /**
     * Check whether an officer of `dept` is allowed to access files of case `c` (BR-29).
     * registry: all services start at registry (step 1), so registry has always either currently held or previously passed it.
     * works: only SV-03 goes through works (step 2+ or stage works/head/issue/closed after step 1).
     */
    function canOfficerAccessCaseFiles(user, c) {
      if (!user || user.role !== 'officer' || !c) return false;
      if (user.dept === 'registry') return true;
      if (user.dept === 'works') {
        if (c.service_id !== 'SV-03') return false;
        if (c.stage === 'works' || c.stage === 'head' || c.stage === 'issue' || c.stage === 'closed') return true;
        if (typeof c.step === 'number' && c.step >= 2) return true;
        return false;
      }
      return false;
    }

    function buildCaseJson(c, viewerRole) {
      const holidays = rules.readHolidays(db);
      const now = clock.now();
      const level = rules.slaLevel({ status: c.status, dueAt: c.due_at }, now, holidays);
      const applicant = db.prepare('SELECT * FROM users WHERE id = ?').get(c.citizen_id);
      const doc = db.prepare('SELECT doc_no, verify_code FROM documents WHERE case_no = ?').get(c.case_no);
      const fixDeadline =
        c.status === 'NEED_FIX' ? c.fix_deadline || (c.returned_at ? rules.fixDeadline(c.returned_at) : null) : null;

      const out = {
        caseNo: c.case_no,
        serviceId: c.service_id,
        status: c.status,
        step: c.service_id === 'SV-03' ? c.step || 1 : null,
        fee: c.fee,
        paidAt: c.paid_at,
        dueAt: c.due_at,
        slaLevel: level,
        owner: c.owner || null,
        returnCount: c.return_count || 0,
        closedAt: c.closed_at || null,
        applicantName: applicant ? applicant.name : '',
        fixDeadline,
        docNo: doc ? doc.doc_no : c.doc_no || null,
        verifyCode: doc ? doc.verify_code : null,
      };

      if (viewerRole === 'citizen') {
        out.idNo = decryptCitizenIdNo(applicant);
      } else {
        out.idMasked = (applicant && applicant.id_masked) || format.maskIdNo(decryptCitizenIdNo(applicant));
      }
      return out;
    }

    // --------------------------------------------------------- API: Drafts
    app.post('/api/drafts', L.requireRole('citizen'), (req, res) => {
      const b = req.body || {};
      const serviceId = String(b.serviceId || '').trim();
      if (!VALID_SERVICES.has(serviceId)) {
        return L.apiError(res, 400, 'INVALID_SERVICE', 'ไม่พบบริการ');
      }
      const svcRow = getServiceRow(serviceId);
      const feeRes = rules.calcFee(serviceId, b, svcRow);
      if (!feeRes.ok) {
        return L.apiError(res, feeRes.status || 400, feeRes.code, feeRes.message);
      }

      const nowIso = clock.nowIso();
      const created = db.transaction(() => {
        if (b.draftId) {
          const existing = db.prepare('SELECT * FROM drafts WHERE id = ?').get(String(b.draftId));
          if (existing && existing.citizen_id === req.user.id && existing.status === 'DRAFT') {
            db.prepare(
              `UPDATE drafts SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ?`
            ).run(
              serviceId === 'SV-01' ? feeRes.qty : null,
              serviceId === 'SV-03' ? feeRes.areaSqm : null,
              feeRes.fee,
              nowIso,
              existing.id
            );
            return { draftId: existing.id, fee: feeRes.fee };
          }
        }
        const { seq, id } = nextDraftId();
        db.prepare(
          `INSERT INTO drafts (id, seq, citizen_id, service_id, status, qty, area_sqm, fee, locked_fee, case_no, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, NULL, NULL, ?, ?)`
        ).run(
          id,
          seq,
          req.user.id,
          serviceId,
          serviceId === 'SV-01' ? feeRes.qty : null,
          serviceId === 'SV-03' ? feeRes.areaSqm : null,
          feeRes.fee,
          nowIso,
          nowIso
        );
        return { draftId: id, fee: feeRes.fee };
      })();

      return res.status(201).json(created);
    });

    app.put('/api/drafts/:id', L.requireRole('citizen'), (req, res) => {
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
      if (!d || d.citizen_id !== req.user.id) return L.apiError(res, 404, 'NOT_FOUND');
      if (d.status === 'SUBMITTED') return L.apiError(res, 409, 'INVALID_STATE');
      const svcRow = getServiceRow(d.service_id);
      const feeRes = rules.calcFee(d.service_id, req.body || {}, svcRow);
      if (!feeRes.ok) {
        return L.apiError(res, feeRes.status || 400, feeRes.code, feeRes.message);
      }
      const nowIso = clock.nowIso();
      const newFee = d.locked_fee !== null && d.locked_fee !== undefined ? d.locked_fee : feeRes.fee;
      db.prepare('UPDATE drafts SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ?').run(
        d.service_id === 'SV-01' ? feeRes.qty : null,
        d.service_id === 'SV-03' ? feeRes.areaSqm : null,
        newFee,
        nowIso,
        d.id
      );
      return res.status(200).json({ draftId: d.id, fee: newFee });
    });

    app.get('/api/drafts', L.requireRole('citizen'), (req, res) => {
      const rows = db
        .prepare("SELECT * FROM drafts WHERE citizen_id = ? AND status IN ('DRAFT', 'PENDING_PAYMENT') ORDER BY seq ASC")
        .all(req.user.id);
      const items = rows.map((d) => ({
        draftId: d.id,
        serviceId: d.service_id,
        status: d.status,
        fee: d.locked_fee !== null && d.locked_fee !== undefined ? d.locked_fee : d.fee,
        qty: d.qty,
        areaSqm: d.area_sqm,
      }));
      return res.status(200).json({ items });
    });

    app.get('/api/drafts/:id', L.requireRole('citizen'), (req, res) => {
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
      if (!d || d.citizen_id !== req.user.id || d.status === 'SUBMITTED') {
        return L.apiError(res, 404, 'NOT_FOUND');
      }
      const files = getDraftFiles(d.id).map((f) => ({
        fileId: f.fileId,
        name: f.name,
        docKey: f.docKey,
        size: f.size,
      }));
      return res.status(200).json({
        draftId: d.id,
        serviceId: d.service_id,
        status: d.status,
        fee: d.locked_fee !== null && d.locked_fee !== undefined ? d.locked_fee : d.fee,
        qty: d.qty,
        areaSqm: d.area_sqm,
        files,
      });
    });

    app.post('/api/drafts/:id/files', L.requireRole('citizen'), runUpload, (req, res) => {
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
      if (!d || d.citizen_id !== req.user.id) return L.apiError(res, 404, 'NOT_FOUND');
      if (d.status === 'SUBMITTED') return L.apiError(res, 409, 'INVALID_STATE');

      const uploaded = (req.files && req.files[0]) || req.file || null;
      if (!uploaded || !uploaded.buffer) {
        return L.apiError(res, 400, 'FILE_TYPE');
      }
      const docKeyRaw = (req.body && req.body.docKey) || (req.query && req.query.docKey) || 'extra';
      const docKey = VALID_DOC_KEYS.has(String(docKeyRaw)) ? String(docKeyRaw) : 'extra';
      const buf = uploaded.buffer;
      const size = buf.length;
      const name = uploaded.originalname || `${docKey}.pdf`;

      // 1. Check size (BR-07 & BUG B02)
      if (!checkFileSize(size)) {
        return L.apiError(res, 400, 'FILE_TOO_LARGE');
      }

      // 2. Check magic bytes (BR-06)
      const mime = rules.detectFileType(buf);
      if (!mime) {
        return L.apiError(res, 400, 'FILE_TYPE');
      }

      // 3. Check SV-03 plan PDF-only (BR-08)
      if (docKey === 'plan' && mime !== 'application/pdf') {
        return L.apiError(res, 400, 'PLAN_NOT_PDF');
      }

      // 4. Check file count <= 5 (BR-07)
      const currentCount = db.prepare('SELECT COUNT(*) AS n FROM files WHERE draft_id = ?').get(d.id).n;
      if (!rules.canAddFile(currentCount)) {
        return L.apiError(res, 400, 'FILE_COUNT');
      }

      const nowIso = clock.nowIso();
      const fileId = db.transaction(() => {
        const fid = nextFileId();
        db.prepare(
          `INSERT INTO files (id, draft_id, case_no, doc_key, name, mime, size, data, phase, uploaded_by, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'initial', ?, ?)`
        ).run(fid, d.id, docKey, name, mime, size, buf, req.user.id, nowIso);
        return fid;
      })();

      if (db.UPLOAD_DIR) {
        try {
          fs.mkdirSync(db.UPLOAD_DIR, { recursive: true });
          fs.writeFileSync(path.join(db.UPLOAD_DIR, fileId), buf);
        } catch {
          // ignore disk write errors if BLOB is stored
        }
      }

      return res.status(201).json({ fileId, name, docKey, size });
    });

    app.delete('/api/drafts/:id/files/:fileId', L.requireRole('citizen'), (req, res) => {
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
      if (!d || d.citizen_id !== req.user.id) return L.apiError(res, 404, 'NOT_FOUND');
      if (d.status === 'SUBMITTED') return L.apiError(res, 409, 'INVALID_STATE');

      const f = db.prepare('SELECT * FROM files WHERE id = ? AND draft_id = ?').get(req.params.fileId, d.id);
      if (!f) return L.apiError(res, 404, 'NOT_FOUND');

      db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
      if (db.UPLOAD_DIR) {
        try {
          fs.rmSync(path.join(db.UPLOAD_DIR, f.id), { force: true });
        } catch {
          // ignore
        }
      }
      return res.status(204).end();
    });

    app.delete('/api/drafts/:id', L.requireRole('citizen'), (req, res) => {
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
      if (!d || d.citizen_id !== req.user.id) return L.apiError(res, 404, 'NOT_FOUND');
      if (d.status === 'SUBMITTED') return L.apiError(res, 409, 'INVALID_STATE');
      const paidPayment = db.prepare("SELECT 1 FROM payments WHERE draft_id = ? AND status = 'PAID'").get(d.id);
      if (paidPayment) return L.apiError(res, 409, 'INVALID_STATE');

      const attached = getDraftFiles(d.id);
      db.transaction(() => {
        db.prepare('DELETE FROM files WHERE draft_id = ?').run(d.id);
        db.prepare('DELETE FROM payments WHERE draft_id = ?').run(d.id);
        db.prepare('DELETE FROM drafts WHERE id = ?').run(d.id);
      })();

      if (db.UPLOAD_DIR) {
        for (const f of attached) {
          try {
            fs.rmSync(path.join(db.UPLOAD_DIR, f.fileId), { force: true });
          } catch {
            // ignore
          }
        }
      }
      return res.status(204).end();
    });

    app.post('/api/drafts/:id/payment', L.requireRole('citizen'), (req, res) => {
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
      if (!d || d.citizen_id !== req.user.id) return L.apiError(res, 404, 'NOT_FOUND');
      if (d.status === 'SUBMITTED') return L.apiError(res, 409, 'INVALID_STATE');

      const files = getDraftFiles(d.id);
      const missing = getMissingDocs(d.service_id, files);
      if (missing.length > 0) {
        return res.status(409).json({
          code: 'MISSING_DOCS',
          message: `ยังขาดเอกสาร: ${missing.join(', ')}`,
          missing,
        });
      }

      const nowIso = clock.nowIso();
      const expiresIso = rules.qrExpiresAt(nowIso);

      const out = db.transaction(() => {
        const freshDraft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(d.id);
        let amount = freshDraft.locked_fee;
        if (amount === null || amount === undefined) {
          const svcRow = getServiceRow(freshDraft.service_id);
          const feeRes = rules.calcFee(
            freshDraft.service_id,
            { qty: freshDraft.qty, areaSqm: freshDraft.area_sqm },
            svcRow
          );
          amount = feeRes.ok ? feeRes.fee : freshDraft.fee;
        }

        db.prepare(
          `UPDATE drafts SET status = 'PENDING_PAYMENT', fee = ?, locked_fee = ?, updated_at = ? WHERE id = ?`
        ).run(amount, amount, nowIso, freshDraft.id);

        db.prepare("UPDATE payments SET status = 'VOID' WHERE draft_id = ? AND status = 'PENDING'").run(freshDraft.id);

        const { seq, ref } = nextPaymentRef();
        db.prepare(
          `INSERT INTO payments (ref, seq, draft_id, citizen_id, amount, status, created_at, expires_at, paid_at, case_no, receipt_no)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL, NULL, NULL)`
        ).run(ref, seq, freshDraft.id, req.user.id, amount, nowIso, expiresIso);

        return {
          ref,
          amount,
          qrCreatedAt: nowIso,
          qrExpiresAt: expiresIso,
        };
      })();

      return res.status(201).json(out);
    });

    app.get('/api/payments/:ref', (req, res) => {
      const p = db.prepare('SELECT * FROM payments WHERE ref = ?').get(req.params.ref);
      if (!p || p.status === 'VOID') return L.apiError(res, 404, 'NOT_FOUND');
      if (req.user && req.user.role === 'citizen' && p.citizen_id !== req.user.id && !bugmode.isBug('B06')) {
        return L.apiError(res, 404, 'NOT_FOUND');
      }
      const st = rules.paymentStatus(p, clock.now());
      return res.status(200).json({
        ref: p.ref,
        amount: p.amount,
        status: st,
        qrCreatedAt: p.created_at,
        qrExpiresAt: p.expires_at,
        caseNo: p.case_no || null,
        receiptNo: p.receipt_no || null,
        paidAt: p.paid_at || null,
      });
    });

    // --------------------------------------------------------- Test Hook: POST /api/test/payments/:ref/pay (CONTRACT §8)
    const payTx = db.transaction((ref, rawAmount) => {
      const p = db.prepare('SELECT * FROM payments WHERE ref = ?').get(ref);
      if (!p || p.status === 'VOID') {
        return { ok: false, status: 404, code: 'NOT_FOUND' };
      }
      const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(p.draft_id);
      if (!d) {
        return { ok: false, status: 404, code: 'NOT_FOUND' };
      }

      // Idempotent callback (BR-11)
      if (p.status === 'PAID') {
        if (!rules.amountMatches(rawAmount, p.amount)) {
          return { ok: false, status: 422, code: 'AMOUNT_MISMATCH' };
        }
        return {
          ok: true,
          status: 200,
          body: {
            status: 'PAID',
            caseNo: p.case_no,
            receiptNo: p.receipt_no,
            duplicate: true,
          },
        };
      }

      const nowIso = clock.nowIso();

      // QR expiry check (BR-10 + BUG B05 inside rules.isQrExpired)
      if (rules.isQrExpired(p.created_at, nowIso)) {
        return { ok: false, status: 410, code: 'QR_EXPIRED' };
      }

      // Exact amount check (BR-11)
      if (!rules.amountMatches(rawAmount, p.amount)) {
        return { ok: false, status: 422, code: 'AMOUNT_MISMATCH' };
      }

      // Issue running numbers for case and receipt in the B.E. year of paidAt (BR-09)
      const yearBE = rules.caseYearBE(nowIso);
      const caseKey = rules.seqKey('case', nowIso);
      const receiptKey = rules.seqKey('receipt', nowIso);
      const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM cases WHERE year_be = ?').get(yearBE);
      const seq = db.nextSeq(caseKey, maxRow ? maxRow.m : 0);
      db.setSeq(receiptKey, seq);
      db.setSeq(`case_${yearBE}`, seq);
      db.setSeq(`receipt_${yearBE}`, seq);
      db.setSeq(`EG-${yearBE}`, seq);
      db.setSeq(`RC-${yearBE}`, seq);

      const caseNo = rules.formatCaseNo(yearBE, seq);
      const receiptNo = rules.formatReceiptNo(yearBE, seq);

      // Compute SLA dueAt once at payment time (BR-12 + BUG B03 inside rules.computeDueAt)
      const svcRow = getServiceRow(d.service_id);
      const cfg = rules.serviceConfig(d.service_id, svcRow);
      const holidays = rules.readHolidays(db);
      const dueAt = rules.computeDueAt(nowIso, cfg.sla, holidays);

      const step = d.service_id === 'SV-03' ? 1 : null;

      db.prepare(
        `INSERT INTO cases (
          case_no, year_be, seq, draft_id, citizen_id, service_id,
          qty, area_sqm, fee, status, step, stage,
          owner, issuer, approved_by, approved_at,
          return_count, returned_at, return_reason, fix_deadline,
          paid_at, payment_ref, receipt_no, due_at,
          closed_at, cancelled_at, cancel_reason, reject_reason, doc_no,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, 'SUBMITTED', ?, 'registry',
          NULL, NULL, NULL, NULL,
          0, NULL, NULL, NULL,
          ?, ?, ?, ?,
          NULL, NULL, NULL, NULL, NULL,
          ?, ?
        )`
      ).run(
        caseNo,
        yearBE,
        seq,
        d.id,
        d.citizen_id,
        d.service_id,
        d.qty ?? null,
        d.area_sqm ?? null,
        p.amount,
        step,
        nowIso,
        p.ref,
        receiptNo,
        dueAt,
        nowIso,
        nowIso
      );

      db.prepare(
        `INSERT INTO receipts (receipt_no, year_be, seq, case_no, payment_ref, amount, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(receiptNo, yearBE, seq, caseNo, p.ref, p.amount, nowIso);

      db.prepare('UPDATE files SET case_no = ? WHERE draft_id = ?').run(caseNo, d.id);
      db.prepare("UPDATE drafts SET status = 'SUBMITTED', case_no = ?, fee = ?, updated_at = ? WHERE id = ?").run(
        caseNo,
        p.amount,
        nowIso,
        d.id
      );
      db.prepare("UPDATE payments SET status = 'PAID', paid_at = ?, case_no = ?, receipt_no = ? WHERE ref = ?").run(
        nowIso,
        caseNo,
        receiptNo,
        p.ref
      );

      db.prepare(
        `INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail)
         VALUES (?, ?, NULL, 'citizen', 'SUBMITTED', 'PENDING_PAYMENT', 'SUBMITTED', 'ชำระเงินและยื่นคำขอ')`
      ).run(caseNo, nowIso);

      return {
        ok: true,
        status: 200,
        body: {
          status: 'PAID',
          caseNo,
          receiptNo,
          duplicate: false,
        },
      };
    });

    app.post('/api/test/payments/:ref/pay', (req, res) => {
      const amount = req.body ? req.body.amount : undefined;
      const result = payTx(req.params.ref, amount);
      if (!result.ok) {
        return L.apiError(res, result.status, result.code);
      }
      return res.status(result.status).json(result.body);
    });

    // --------------------------------------------------------- API: Cases & Files
    app.get('/api/cases', L.requireRole('citizen'), (req, res) => {
      const holidays = rules.readHolidays(db);
      const now = clock.now();
      const rows = db.prepare('SELECT * FROM cases WHERE citizen_id = ?').all(req.user.id);
      rows.sort((a, b) => rules.compareCaseNo(b.case_no, a.case_no));
      const items = rows.map((c) => ({
        caseNo: c.case_no,
        serviceId: c.service_id,
        status: c.status,
        dueAt: c.due_at,
        slaLevel: rules.slaLevel({ status: c.status, dueAt: c.due_at }, now, holidays),
      }));
      return res.status(200).json({ items });
    });

    app.get('/api/cases/:caseNo', L.requireRole('citizen', 'officer', 'head'), (req, res) => {
      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(req.params.caseNo);
      if (!c) return L.apiError(res, 404, 'NOT_FOUND');

      if (req.user.role === 'citizen') {
        if (c.citizen_id !== req.user.id && !bugmode.isBug('B06')) {
          return L.apiError(res, 404, 'NOT_FOUND');
        }
      }

      return res.status(200).json(buildCaseJson(c, req.user.role));
    });

    app.post('/api/cases/:caseNo/cancel', L.requireRole('citizen'), (req, res) => {
      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(req.params.caseNo);
      if (!c || c.citizen_id !== req.user.id) {
        return L.apiError(res, 404, 'NOT_FOUND');
      }

      const result = db.transaction(() => {
        const cur = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(c.case_no);
        if (!cur) return { ok: false, status: 404, code: 'NOT_FOUND' };
        if (cur.status !== 'SUBMITTED' || cur.owner) {
          return { ok: false, status: 409, code: 'CANNOT_CANCEL' };
        }
        const nowIso = clock.nowIso();
        const info = db
          .prepare(
            `UPDATE cases
                SET status = 'CANCELLED',
                    stage = 'closed',
                    cancelled_at = ?,
                    cancel_reason = 'CITIZEN',
                    updated_at = ?
              WHERE case_no = ? AND status = 'SUBMITTED' AND owner IS NULL`
          )
          .run(nowIso, nowIso, cur.case_no);
        if (info.changes !== 1) {
          return { ok: false, status: 409, code: 'CANNOT_CANCEL' };
        }
        db.prepare(
          `INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail)
           VALUES (?, ?, NULL, 'citizen', 'CANCEL', 'SUBMITTED', 'CANCELLED', 'ประชาชนยกเลิกคำขอ')`
        ).run(cur.case_no, nowIso);
        return { ok: true };
      })();

      if (!result.ok) {
        return L.apiError(res, result.status, result.code);
      }
      return res.status(200).json({ status: 'CANCELLED' });
    });

    app.post('/api/cases/:caseNo/resubmit', L.requireRole('citizen'), runUpload, (req, res) => {
      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(req.params.caseNo);
      if (!c || c.citizen_id !== req.user.id) {
        return L.apiError(res, 404, 'NOT_FOUND');
      }

      if (c.status === 'CANCELLED' && c.cancel_reason === 'AUTO_FIX_EXPIRED') {
        return L.apiError(res, 409, 'FIX_WINDOW_EXPIRED');
      }
      if (c.status !== 'NEED_FIX') {
        return L.apiError(res, 409, 'INVALID_STATE');
      }

      const now = clock.now();
      const nowIso = clock.toIso(now);
      if (rules.isFixWindowExpired(c.returned_at, now)) {
        autoCancelExpiredFixCases();
        return L.apiError(res, 409, 'FIX_WINDOW_EXPIRED');
      }

      // Optional file attachment on resubmit
      const uploaded = (req.files && req.files[0]) || req.file || null;
      let uploadedFileInfo = null;
      if (uploaded && uploaded.buffer && uploaded.buffer.length > 0) {
        const buf = uploaded.buffer;
        const size = buf.length;
        if (!checkFileSize(size)) {
          return L.apiError(res, 400, 'FILE_TOO_LARGE');
        }
        const mime = rules.detectFileType(buf);
        if (!mime) {
          return L.apiError(res, 400, 'FILE_TYPE');
        }
        const docKeyRaw = (req.body && req.body.docKey) || 'extra';
        const docKey = VALID_DOC_KEYS.has(String(docKeyRaw)) ? String(docKeyRaw) : 'extra';
        if (docKey === 'plan' && mime !== 'application/pdf') {
          return L.apiError(res, 400, 'PLAN_NOT_PDF');
        }
        uploadedFileInfo = {
          buf,
          size,
          mime,
          docKey,
          name: uploaded.originalname || 'fix.pdf',
        };
      }

      const out = db.transaction(() => {
        const cur = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(c.case_no);
        if (!cur || cur.status !== 'NEED_FIX') {
          return { ok: false, status: 409, code: 'INVALID_STATE' };
        }
        if (rules.isFixWindowExpired(cur.returned_at, now)) {
          return { ok: false, status: 409, code: 'FIX_WINDOW_EXPIRED' };
        }

        if (uploadedFileInfo) {
          const fid = nextFileId();
          db.prepare(
            `INSERT INTO files (id, draft_id, case_no, doc_key, name, mime, size, data, phase, uploaded_by, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'fix', ?, ?)`
          ).run(
            fid,
            cur.case_no,
            uploadedFileInfo.docKey,
            uploadedFileInfo.name,
            uploadedFileInfo.mime,
            uploadedFileInfo.size,
            uploadedFileInfo.buf,
            req.user.id,
            nowIso
          );
          if (db.UPLOAD_DIR) {
            try {
              fs.mkdirSync(db.UPLOAD_DIR, { recursive: true });
              fs.writeFileSync(path.join(db.UPLOAD_DIR, fid), uploadedFileInfo.buf);
            } catch {
              // ignore
            }
          }
        }

        const holidays = rules.readHolidays(db);
        const ext = rules.extendDueAt(cur.due_at, cur.returned_at, nowIso, holidays);

        db.prepare(
          `UPDATE cases
              SET status = 'IN_REVIEW',
                  due_at = ?,
                  fix_deadline = NULL,
                  updated_at = ?
            WHERE case_no = ?`
        ).run(ext.dueAt, nowIso, cur.case_no);

        db.prepare(
          `UPDATE case_returns
              SET resubmitted_at = ?,
                  paused_days = ?,
                  due_after = ?
            WHERE case_no = ? AND n = ?`
        ).run(nowIso, ext.pausedDays, ext.dueAt, cur.case_no, cur.return_count);

        db.prepare(
          `INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail)
           VALUES (?, ?, NULL, 'citizen', 'RESUBMIT', 'NEED_FIX', 'IN_REVIEW', 'ส่งแก้ไขเอกสาร')`
        ).run(cur.case_no, nowIso);

        return { ok: true, dueAt: ext.dueAt };
      })();

      if (!out.ok) {
        return L.apiError(res, out.status, out.code);
      }
      return res.status(200).json({ status: 'IN_REVIEW', dueAt: out.dueAt });
    });

    app.get('/api/cases/:caseNo/files', L.requireLogin, (req, res) => {
      const user = req.user;
      if (['executive', 'auditor', 'admin'].includes(user.role)) {
        return L.apiError(res, 403, 'FORBIDDEN');
      }
      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(req.params.caseNo);
      if (!c) return L.apiError(res, 404, 'NOT_FOUND');

      if (user.role === 'citizen') {
        if (c.citizen_id !== user.id && !bugmode.isBug('B06')) {
          return L.apiError(res, 404, 'NOT_FOUND');
        }
      } else if (user.role === 'officer') {
        if (!canOfficerAccessCaseFiles(user, c)) {
          return L.apiError(res, 403, 'FORBIDDEN');
        }
      } else if (user.role !== 'head') {
        return L.apiError(res, 403, 'FORBIDDEN');
      }

      const items = getCaseFiles(c.case_no).map((f) => ({
        fileId: f.fileId,
        name: f.name,
        docKey: f.docKey,
        size: f.size,
      }));
      return res.status(200).json({ items });
    });

    app.get('/api/files/:fileId', L.requireLogin, (req, res) => {
      const user = req.user;
      if (['executive', 'auditor', 'admin'].includes(user.role)) {
        return L.apiError(res, 403, 'FORBIDDEN');
      }
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.fileId);
      if (!f) return L.apiError(res, 404, 'NOT_FOUND');

      if (f.case_no) {
        const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(f.case_no);
        if (!c) return L.apiError(res, 404, 'NOT_FOUND');
        if (user.role === 'citizen') {
          if (c.citizen_id !== user.id && !bugmode.isBug('B06')) {
            return L.apiError(res, 404, 'NOT_FOUND');
          }
        } else if (user.role === 'officer') {
          if (!canOfficerAccessCaseFiles(user, c)) {
            return L.apiError(res, 403, 'FORBIDDEN');
          }
        } else if (user.role !== 'head') {
          return L.apiError(res, 403, 'FORBIDDEN');
        }
      } else if (f.draft_id) {
        const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(f.draft_id);
        if (!d) return L.apiError(res, 404, 'NOT_FOUND');
        if (user.role !== 'citizen' || d.citizen_id !== user.id) {
          return L.apiError(res, user.role === 'citizen' ? 404 : 403, user.role === 'citizen' ? 'NOT_FOUND' : 'FORBIDDEN');
        }
      }

      let buf = f.data;
      if ((!buf || !buf.length) && db.UPLOAD_DIR) {
        const diskPath = path.join(db.UPLOAD_DIR, f.id);
        if (fs.existsSync(diskPath)) buf = fs.readFileSync(diskPath);
      }
      if (!buf) return L.apiError(res, 404, 'NOT_FOUND');

      res.set('Content-Type', f.mime || 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(f.name || f.id)}"`);
      return res.status(200).send(buf);
    });

    // --------------------------------------------------------- Page 1: GET /citizen (CONTRACT §2.4)
    app.get('/citizen', L.requireRole('citizen'), (req, res) => {
      const holidays = rules.readHolidays(db);
      const now = clock.now();

      const cases = db.prepare('SELECT * FROM cases WHERE citizen_id = ?').all(req.user.id);
      cases.sort((a, b) => rules.compareCaseNo(b.case_no, a.case_no));

      const drafts = db
        .prepare("SELECT * FROM drafts WHERE citizen_id = ? AND status IN ('DRAFT', 'PENDING_PAYMENT') ORDER BY seq ASC")
        .all(req.user.id);

      const caseRowsHtml = cases.length
        ? cases
            .map((c) => {
              const level = rules.slaLevel({ status: c.status, dueAt: c.due_at }, now, holidays);
              return `<tr data-testid="my-case-row" data-case-no="${esc(c.case_no)}" data-status="${esc(c.status)}">
  <td><a href="/citizen/cases/${esc(c.case_no)}" data-testid="row-case-no">${esc(c.case_no)}</a></td>
  <td data-testid="row-service">${esc(format.serviceLabel(c.service_id))}</td>
  <td>${format.statusBadge(c.status, 'row-status')}</td>
  <td>${format.timeTag(c.due_at, 'row-due')}</td>
  <td>${format.levelBadge(level, 'row-sla-level')}</td>
</tr>`;
            })
            .join('\n')
        : '<tr><td colspan="5" class="muted">ยังไม่มีคำขอที่ยื่นแล้ว</td></tr>';

      const draftRowsHtml = drafts.length
        ? drafts
            .map((d) => {
              const feeVal = d.locked_fee !== null && d.locked_fee !== undefined ? d.locked_fee : d.fee;
              return `<tr data-testid="my-draft-row" data-draft-id="${esc(d.id)}" data-status="${esc(d.status)}">
  <td data-testid="row-draft-id">${esc(d.id)}</td>
  <td data-testid="row-service">${esc(format.serviceLabel(d.service_id))}</td>
  <td>${format.statusBadge(d.status, 'row-status')}</td>
  <td>${esc(format.money(feeVal))}</td>
  <td><a href="/citizen/new/${esc(d.service_id)}?draft=${esc(d.id)}" data-testid="open-draft-btn" class="btn btn-secondary">เปิดร่าง</a></td>
</tr>`;
            })
            .join('\n')
        : '<tr><td colspan="5" class="muted">ไม่มีร่างคำขอที่ค้างอยู่</td></tr>';

      const body = `
<h1 data-testid="citizen-welcome">สวัสดี ${esc(req.user.name)}</h1>

<section class="card" aria-labelledby="sec-services">
  <h2 id="sec-services">เลือกบริการยื่นคำขอใหม่</h2>
  <div class="grid">
    <div class="card">
      <h3>SV-01 ขอหนังสือรับรอง</h3>
      <p class="muted">ค่าธรรมเนียมต่อฉบับ · SLA 3 วันทำการ</p>
      <a href="/citizen/new/SV-01" data-testid="start-service-SV-01" class="btn">เริ่มยื่นคำขอ SV-01</a>
    </div>
    <div class="card">
      <h3>SV-02 ขออนุญาตประกอบกิจการ</h3>
      <p class="muted">ต้องผ่านหัวหน้าฝ่ายอนุมัติ · SLA 10 วันทำการ</p>
      <a href="/citizen/new/SV-02" data-testid="start-service-SV-02" class="btn">เริ่มยื่นคำขอ SV-02</a>
    </div>
    <div class="card">
      <h3>SV-03 ขออนุญาตก่อสร้าง/ต่อเติมอาคาร</h3>
      <p class="muted">พื้นที่ 1–500 ตร.ม. · ตรวจ 3 ขั้นตอน · SLA 15 วันทำการ</p>
      <a href="/citizen/new/SV-03" data-testid="start-service-SV-03" class="btn">เริ่มยื่นคำขอ SV-03</a>
    </div>
  </div>
</section>

<section class="card" aria-labelledby="sec-drafts">
  <h2 id="sec-drafts">ร่างคำขอและรายการรอชำระเงิน</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>รหัสร่าง</th>
          <th>บริการ</th>
          <th>สถานะ</th>
          <th>ค่าธรรมเนียม</th>
          <th>ดำเนินการ</th>
        </tr>
      </thead>
      <tbody>
        ${draftRowsHtml}
      </tbody>
    </table>
  </div>
</section>

<section class="card" aria-labelledby="sec-cases">
  <h2 id="sec-cases">รายการคำขอของฉัน</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>เลขคำขอ</th>
          <th>บริการ</th>
          <th>สถานะ</th>
          <th>กำหนดเสร็จ</th>
          <th>ระดับ SLA</th>
        </tr>
      </thead>
      <tbody>
        ${caseRowsHtml}
      </tbody>
    </table>
  </div>
</section>`;

      return L.render(req, res, { title: 'คำขอของฉัน', body });
    });

    // --------------------------------------------------------- Page 2: GET /citizen/new/:service (CONTRACT §2.5)
    app.get('/citizen/new/:service', L.requireRole('citizen'), (req, res) => {
      const serviceId = String(req.params.service || '').trim();
      if (!VALID_SERVICES.has(serviceId)) {
        return L.sendNotFound(req, res);
      }

      let draft = null;
      let draftFiles = [];
      let latestPayment = null;

      if (req.query.draft) {
        draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(String(req.query.draft).trim());
        if (!draft || draft.citizen_id !== req.user.id || draft.service_id !== serviceId) {
          return L.sendNotFound(req, res);
        }
        draftFiles = getDraftFiles(draft.id);
        latestPayment = db
          .prepare("SELECT * FROM payments WHERE draft_id = ? AND status <> 'VOID' ORDER BY seq DESC LIMIT 1")
          .get(draft.id);
      }

      const svcRow = getServiceRow(serviceId);
      const cfg = rules.serviceConfig(serviceId, svcRow);
      const serviceName = (svcRow && svcRow.name) || format.SERVICE_NAME[serviceId] || serviceId;

      // Initial step determination:
      // - No draft or draft.status === 'DRAFT' -> step 1
      // - draft.status === 'PENDING_PAYMENT' or 'SUBMITTED' -> step 3
      const initialStep = draft && (draft.status === 'PENDING_PAYMENT' || draft.status === 'SUBMITTED') ? 3 : 1;
      const stepLabels = {
        1: '1/3 กรอกข้อมูล',
        2: '2/3 แนบเอกสาร',
        3: '3/3 ชำระเงิน',
      };

      const initialQty = serviceId === 'SV-01' ? (draft && draft.qty != null ? draft.qty : 1) : null;
      const initialArea = serviceId === 'SV-03' ? (draft && draft.area_sqm != null ? draft.area_sqm : '') : null;

      let initialFeeCalc;
      if (serviceId === 'SV-01') {
        initialFeeCalc = rules.calcFee('SV-01', { qty: initialQty }, svcRow);
      } else if (serviceId === 'SV-02') {
        initialFeeCalc = rules.calcFee('SV-02', {}, svcRow);
      } else {
        initialFeeCalc =
          initialArea !== '' && initialArea !== null
            ? rules.calcFee('SV-03', { areaSqm: initialArea }, svcRow)
            : { ok: false, message: '' };
      }

      const lockedFee = draft && draft.locked_fee != null ? draft.locked_fee : null;
      const currentFeeNum = lockedFee != null ? lockedFee : initialFeeCalc.ok ? initialFeeCalc.fee : null;
      const initialFeeText = currentFeeNum != null ? format.money(currentFeeNum) : '–';
      const initialValidStep1 = initialFeeCalc.ok;

      // Step 2 inputs & initial files
      const missingList = getMissingDocs(serviceId, draftFiles);
      const missingHtml =
        missingList.length > 0
          ? `<p data-testid="missing-docs" class="field-error" role="status">ยังขาดเอกสาร: ${esc(missingList.join(', '))}</p>`
          : '';

      const fileItemsHtml = draftFiles
        .map(
          (f) => `<li data-testid="file-item" data-name="${esc(f.name)}" data-doc-key="${esc(f.docKey)}" data-file-id="${esc(f.fileId)}" class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid #e5e7eb">
  <span><strong>${esc(format.DOC_LABEL[f.docKey] || f.docKey)}:</strong> ${esc(f.name)}</span>
  <button type="button" data-testid="file-remove-btn" class="btn btn-secondary" data-file-id="${esc(f.fileId)}">ลบไฟล์</button>
</li>`
        )
        .join('\n');

      let step1FieldsHtml = '';
      if (serviceId === 'SV-01') {
        step1FieldsHtml = `
  <label for="qty-input">จำนวนฉบับ (1–5 ฉบับ)</label>
  <input type="number" id="qty-input" name="qty" data-testid="qty-input" value="${esc(initialQty)}" min="1" max="5" step="1"${initialStep === 1 ? ' autofocus' : ''}>`;
      } else if (serviceId === 'SV-03') {
        step1FieldsHtml = `
  <label for="area-input">พื้นที่อาคาร (ตร.ม. · 1–500)</label>
  <input type="number" id="area-input" name="areaSqm" data-testid="area-input" value="${esc(initialArea)}" min="1" max="500" step="1"${initialStep === 1 ? ' autofocus' : ''}>`;
      } else {
        step1FieldsHtml = `<p class="muted">บริการนี้มีค่าธรรมเนียมคงที่ ไม่ต้องระบุจำนวนหรือพื้นที่</p>`;
      }

      let step2InputsHtml = `
  <div class="upload-group">
    <label for="upload-input-id-card">บัตรประชาชน ✱</label>
    <input type="file" id="upload-input-id-card" data-testid="upload-input-id-card" data-doc-key="id-card">
  </div>`;
      if (serviceId === 'SV-02') {
        step2InputsHtml += `
  <div class="upload-group">
    <label for="upload-input-map">แผนที่ตั้ง ✱</label>
    <input type="file" id="upload-input-map" data-testid="upload-input-map" data-doc-key="map">
  </div>
  <div class="upload-group">
    <label for="upload-input-site-photo">ภาพสถานที่ (ไม่บังคับ)</label>
    <input type="file" id="upload-input-site-photo" data-testid="upload-input-site-photo" data-doc-key="site-photo">
  </div>`;
      } else if (serviceId === 'SV-03') {
        step2InputsHtml += `
  <div class="upload-group">
    <label for="upload-input-plan">แบบแปลน ✱ (PDF เท่านั้น)</label>
    <input type="file" id="upload-input-plan" data-testid="upload-input-plan" data-doc-key="plan">
  </div>
  <div class="upload-group">
    <label for="upload-input-deed">โฉนด ✱</label>
    <input type="file" id="upload-input-deed" data-testid="upload-input-deed" data-doc-key="deed">
  </div>`;
      }
      step2InputsHtml += `
  <div class="upload-group">
    <label for="upload-input-extra">เอกสารเพิ่มเติม (แนบได้หลายไฟล์)</label>
    <input type="file" id="upload-input-extra" data-testid="upload-input-extra" data-doc-key="extra" multiple>
  </div>`;

      // Initial payment state for Step 3
      let initialPaymentState = null;
      if (latestPayment) {
        const payStatus = rules.paymentStatus(latestPayment, clock.now());
        initialPaymentState = {
          ref: latestPayment.ref,
          amount: latestPayment.amount,
          status: payStatus,
          qrCreatedAt: latestPayment.created_at,
          qrExpiresAt: latestPayment.expires_at,
          qrExpiresText: format.thDateTime(latestPayment.expires_at),
          caseNo: latestPayment.case_no || null,
          receiptNo: latestPayment.receipt_no || null,
          paidAt: latestPayment.paid_at || null,
          paidAtText: latestPayment.paid_at ? format.thDateTime(latestPayment.paid_at) : '',
        };
      }

      const payAmountNum =
        (initialPaymentState && initialPaymentState.amount) != null
          ? initialPaymentState.amount
          : currentFeeNum != null
          ? currentFeeNum
          : cfg.fee;

      const qrHasPayment = Boolean(initialPaymentState);
      const qrStatus = initialPaymentState ? initialPaymentState.status : '';
      const qrStatusTh = initialPaymentState ? format.PAYMENT_STATUS_TH[qrStatus] || qrStatus : '';
      const qrIsExpired = qrStatus === 'EXPIRED';
      const qrIsPaid = qrStatus === 'PAID';

      const clientState = {
        serviceId,
        feeBase: cfg.fee,
        feePerSqm: cfg.feePerSqm,
        bugB01: bugmode.isBug('B01'),
        bugB02: bugmode.isBug('B02'),
        draftId: draft ? draft.id : null,
        lockedFee,
        currentFee: currentFeeNum,
        files: draftFiles.map((f) => ({
          fileId: f.fileId,
          name: f.name,
          docKey: f.docKey,
          size: f.size,
        })),
        requiredDocs: (SERVICE_DOCS[serviceId] || []).filter((d) => d.required),
        docLabels: format.DOC_LABEL,
        payment: initialPaymentState,
      };

      const body = `
<h1>ยื่นคำขอ: <span data-testid="service-name">${esc(serviceName)}</span> (${esc(serviceId)})</h1>
<p data-testid="wizard-step" class="wizard-step">${esc(stepLabels[initialStep])}</p>
<p class="muted">รหัสร่าง: <strong data-testid="draft-id">${esc(draft ? draft.id : '')}</strong></p>

<section id="wizard-step-1" class="card"${initialStep === 1 ? '' : ' hidden'}>
  <h2>ขั้นที่ 1: กรอกข้อมูลคำขอ</h2>
  ${step1FieldsHtml}
  <p style="margin-top:12px">ค่าธรรมเนียมรวม: <strong data-testid="fee-total">${esc(initialFeeText)}</strong></p>
  <p data-testid="fee-error" class="field-error" role="alert" hidden></p>
  <div class="row" style="margin-top:16px">
    <button type="button" data-testid="save-draft-btn" class="btn btn-secondary">บันทึกร่าง</button>
    <button type="button" data-testid="to-upload-btn" class="btn"${initialValidStep1 ? '' : ' disabled'}>ถัดไป: แนบเอกสาร</button>
  </div>
</section>

<section id="wizard-step-2" class="card"${initialStep === 2 ? '' : ' hidden'}>
  <h2>ขั้นที่ 2: แนบเอกสารประกอบ (PDF, JPG, PNG · ไม่เกิน 5 MB · สูงสุด 5 ไฟล์)</h2>
  ${step2InputsHtml}
  <p data-testid="upload-error" class="field-error" role="alert" hidden></p>
  <ul id="file-list" style="list-style:none;padding:0;margin:12px 0">${fileItemsHtml}</ul>
  <div id="missing-docs-slot">${missingHtml}</div>
  <div class="row" style="margin-top:16px">
    <button type="button" data-testid="to-payment-btn" class="btn"${missingList.length === 0 ? '' : ' disabled'}>ไปชำระเงิน</button>
  </div>
</section>

<section id="wizard-step-3" class="card"${initialStep === 3 ? '' : ' hidden'}>
  <h2>ขั้นที่ 3: ชำระค่าธรรมเนียม (PromptPay QR จำลอง)</h2>
  <p>ยอดที่ต้องชำระ: <strong data-testid="payment-amount">${esc(format.money(payAmountNum))}</strong></p>
  <div class="row" style="margin:12px 0">
    <button type="button" data-testid="create-qr-btn" class="btn">สร้าง QR</button>
    <button type="button" data-testid="refresh-payment-btn" class="btn btn-secondary"${qrHasPayment ? '' : ' hidden'}>ตรวจสอบการชำระเงิน</button>
  </div>

  <div id="qr-container"${qrHasPayment ? '' : ' hidden'}>
    <div data-testid="qr-image" class="qr-box" role="img" aria-label="PromptPay QR จำลอง">
      <svg width="140" height="140" viewBox="0 0 140 140" aria-hidden="true">
        <rect width="140" height="140" fill="#ffffff" stroke="#1d3557" stroke-width="4"/>
        <rect x="14" y="14" width="36" height="36" fill="#1d3557"/>
        <rect x="90" y="14" width="36" height="36" fill="#1d3557"/>
        <rect x="14" y="90" width="36" height="36" fill="#1d3557"/>
        <rect x="58" y="58" width="24" height="24" fill="#1d3557"/>
      </svg>
    </div>
    <p>เลขอ้างอิง QR: <strong data-testid="qr-ref">${esc(initialPaymentState ? initialPaymentState.ref : '')}</strong></p>
    <p><time data-testid="qr-expires" data-iso="${esc(initialPaymentState ? initialPaymentState.qrExpiresAt : '')}" datetime="${esc(initialPaymentState ? initialPaymentState.qrExpiresAt : '')}">${initialPaymentState ? `หมดอายุ ${esc(initialPaymentState.qrExpiresText)}` : ''}</time></p>
    <p>สถานะการชำระ: <span data-testid="payment-status" class="badge" data-status="${esc(qrStatus)}">${esc(qrStatusTh)}</span></p>
    <p data-testid="qr-expired-msg" class="field-error" role="alert"${qrIsExpired ? '' : ' hidden'}>QR หมดอายุ กรุณาสร้าง QR ใหม่</p>
    <div style="margin:8px 0">
      <button type="button" data-testid="regenerate-qr-btn" class="btn"${qrIsExpired ? '' : ' hidden'}>สร้าง QR ใหม่</button>
    </div>
  </div>

  <div id="receipt-container" class="card"${qrIsPaid ? '' : ' hidden'} style="margin-top:12px;background:#f0fdf4">
    <h3>ใบเสร็จรับเงินอิเล็กทรอนิกส์</h3>
    <dl class="kv">
      <dt>เลขคำขอ</dt>
      <dd><strong data-testid="submitted-case-no">${esc(initialPaymentState && initialPaymentState.caseNo ? initialPaymentState.caseNo : '')}</strong></dd>
      <dt>เลขใบเสร็จ</dt>
      <dd><span data-testid="receipt-no">${esc(initialPaymentState && initialPaymentState.receiptNo ? initialPaymentState.receiptNo : '')}</span></dd>
      <dt>ยอดที่ชำระ</dt>
      <dd><span data-testid="receipt-amount">${esc(initialPaymentState ? format.money(initialPaymentState.amount) : '')}</span></dd>
      <dt>เวลาชำระ</dt>
      <dd><time data-testid="receipt-paid-at" data-iso="${esc(initialPaymentState && initialPaymentState.paidAt ? initialPaymentState.paidAt : '')}" datetime="${esc(initialPaymentState && initialPaymentState.paidAt ? initialPaymentState.paidAt : '')}">${esc(initialPaymentState ? initialPaymentState.paidAtText : '')}</time></dd>
    </dl>
    <div style="margin-top:12px">
      <a href="${initialPaymentState && initialPaymentState.caseNo ? `/citizen/cases/${esc(initialPaymentState.caseNo)}` : '#'}" data-testid="go-case-btn" class="btn">ดูคำขอ</a>
    </div>
  </div>
</section>`;

      const wizardScript = `(function(){
  var S = ${JSON.stringify(clientState)};
  var TH_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var PAY_TH = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };

  function q(tid) { return document.querySelector('[data-testid="' + tid + '"]'); }
  function byId(id) { return document.getElementById(id); }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
    return '฿' + Math.round(Number(n)).toLocaleString('en-US');
  }
  function fmtThDateTime(iso) {
    if (!iso) return '–';
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    var y = Number(m[1]) + 543;
    var mo = Number(m[2]);
    var d = Number(m[3]);
    return d + ' ' + TH_MONTHS[mo - 1] + ' ' + y + ' ' + m[4] + ':' + m[5];
  }
  function parseIntStrict(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v : null;
    var s = String(v == null ? '' : v).trim();
    if (!/^[+-]?\\d+$/.test(s)) return null;
    var n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }

  function evalStep1() {
    if (S.serviceId === 'SV-01') {
      var qtyEl = q('qty-input');
      var qty = parseIntStrict(qtyEl ? qtyEl.value : '');
      if (qty === null || qty < 1 || qty > 5) {
        return { ok: false, fee: null, err: 'จำนวนฉบับต้อง 1–5 ฉบับ' };
      }
      return { ok: true, fee: S.feeBase * qty, qty: qty, err: '' };
    }
    if (S.serviceId === 'SV-02') {
      return { ok: true, fee: S.feeBase, err: '' };
    }
    var areaEl = q('area-input');
    var raw = areaEl ? String(areaEl.value || '').trim() : '';
    if (raw === '') {
      return { ok: false, fee: null, err: '' };
    }
    var area = parseIntStrict(raw);
    if (area === null || area < 1) {
      return { ok: false, fee: null, err: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.' };
    }
    if (area > 500) {
      return { ok: false, fee: null, err: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' };
    }
    var surcharge = S.bugB01 ? (area > 101) : (area >= 101);
    var fee = surcharge ? (S.feeBase + S.feePerSqm * (area - 100)) : S.feeBase;
    return { ok: true, fee: fee, areaSqm: area, err: '' };
  }

  function updateStep1Ui() {
    var r = evalStep1();
    var feeEl = q('fee-total');
    var errEl = q('fee-error');
    var nextBtn = q('to-upload-btn');
    if (feeEl) feeEl.textContent = r.ok ? fmtMoney(r.fee) : '–';
    if (errEl) {
      errEl.textContent = r.err || '';
      errEl.hidden = !r.err;
    }
    if (nextBtn) nextBtn.disabled = !r.ok;
    if (r.ok) S.currentFee = r.fee;
    return r;
  }

  var qtyInput = q('qty-input');
  var areaInput = q('area-input');
  if (qtyInput) {
    qtyInput.addEventListener('input', updateStep1Ui);
    qtyInput.addEventListener('change', updateStep1Ui);
  }
  if (areaInput) {
    areaInput.addEventListener('input', updateStep1Ui);
    areaInput.addEventListener('change', updateStep1Ui);
  }

  var savePromise = null;
  function ensureDraftSaved() {
    var r = updateStep1Ui();
    if (!r.ok) return Promise.reject(new Error(r.err || 'invalid'));
    var payload = { serviceId: S.serviceId };
    if (S.serviceId === 'SV-01') payload.qty = r.qty;
    if (S.serviceId === 'SV-03') payload.areaSqm = r.areaSqm;
    var reqPromise = S.draftId
      ? window.App.api('PUT', '/api/drafts/' + encodeURIComponent(S.draftId), payload)
      : window.App.api('POST', '/api/drafts', payload);
    savePromise = reqPromise.then(function(res) {
      if (!res.ok) throw new Error((res.data && res.data.message) || 'บันทึกไม่สำเร็จ');
      S.draftId = res.data.draftId;
      S.currentFee = res.data.fee;
      var did = q('draft-id');
      if (did) did.textContent = S.draftId;
      var ft = q('fee-total');
      if (ft) ft.textContent = fmtMoney(S.currentFee);
      return S.draftId;
    });
    return savePromise;
  }

  function showStep(n) {
    var labels = { 1: '1/3 กรอกข้อมูล', 2: '2/3 แนบเอกสาร', 3: '3/3 ชำระเงิน' };
    var ws = q('wizard-step');
    if (ws) ws.textContent = labels[n];
    byId('wizard-step-1').hidden = (n !== 1);
    byId('wizard-step-2').hidden = (n !== 2);
    byId('wizard-step-3').hidden = (n !== 3);
  }

  var saveBtn = q('save-draft-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      ensureDraftSaved().catch(function(e) { window.App.showError(e.message); });
    });
  }

  var toUploadBtn = q('to-upload-btn');
  if (toUploadBtn) {
    toUploadBtn.addEventListener('click', function() {
      ensureDraftSaved().then(function() {
        renderFiles();
        showStep(2);
        var firstFile = q('upload-input-id-card');
        if (firstFile) firstFile.focus();
      }).catch(function(e) {
        if (e && e.message) window.App.showError(e.message);
      });
    });
  }

  function computeMissing(filesList) {
    var present = {};
    for (var i = 0; i < filesList.length; i++) present[filesList[i].docKey] = true;
    var missing = [];
    for (var j = 0; j < S.requiredDocs.length; j++) {
      var d = S.requiredDocs[j];
      if (!present[d.key]) missing.push(d.label);
    }
    return missing;
  }

  function renderFiles() {
    var listEl = byId('file-list');
    if (listEl) {
      listEl.innerHTML = S.files.map(function(f) {
        var label = S.docLabels[f.docKey] || f.docKey;
        return '<li data-testid="file-item" data-name="' + escHtml(f.name) + '" data-doc-key="' + escHtml(f.docKey) + '" data-file-id="' + escHtml(f.fileId) + '" class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid #e5e7eb">' +
          '<span><strong>' + escHtml(label) + ':</strong> ' + escHtml(f.name) + '</span>' +
          '<button type="button" data-testid="file-remove-btn" class="btn btn-secondary" data-file-id="' + escHtml(f.fileId) + '">ลบไฟล์</button>' +
        '</li>';
      }).join('');
    }
    var missing = computeMissing(S.files);
    var slot = byId('missing-docs-slot');
    if (slot) {
      if (missing.length > 0) {
        slot.innerHTML = '<p data-testid="missing-docs" class="field-error" role="status">ยังขาดเอกสาร: ' + escHtml(missing.join(', ')) + '</p>';
      } else {
        slot.innerHTML = '';
      }
    }
    var toPayBtn = q('to-payment-btn');
    if (toPayBtn) toPayBtn.disabled = (missing.length > 0);
  }

  function showUploadError(msg) {
    var el = q('upload-error');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  var pendingUpload = Promise.resolve();

  function looksValidSynchronously(file, docKey) {
    if (!file) return false;
    var maxBytes = 5 * 1024 * 1024;
    var sizeOk = S.bugB02 ? (file.size >= 0 && file.size < maxBytes) : (file.size >= 0 && file.size <= maxBytes);
    if (!sizeOk) return false;
    if (S.files.length >= 5) return false;
    var name = String(file.name || '').toLowerCase();
    if (file.size < 16 || name.indexOf('fake-') === 0 || name.indexOf('exe-') === 0 || name.slice(-4) === '.txt') return false;
    if (docKey === 'plan' && name.slice(-4) !== '.pdf') return false;
    return true;
  }

  var fileInputs = document.querySelectorAll('#wizard-step-2 input[type="file"]');
  for (var i = 0; i < fileInputs.length; i++) {
    fileInputs[i].addEventListener('change', function() {
      var input = this;
      var docKey = input.getAttribute('data-doc-key') || 'extra';
      var chosen = Array.from(input.files || []);
      input.value = '';
      if (!chosen.length) return;

      // Optimistically enable to-payment-btn if this file satisfies all remaining required docs
      if (chosen.length === 1 && looksValidSynchronously(chosen[0], docKey)) {
        var simFiles = S.files.concat([{ docKey: docKey, name: chosen[0].name }]);
        if (computeMissing(simFiles).length === 0) {
          var toPayBtn = q('to-payment-btn');
          if (toPayBtn) toPayBtn.disabled = false;
        }
      }

      pendingUpload = pendingUpload.then(function() {
        return (S.draftId ? Promise.resolve(S.draftId) : ensureDraftSaved());
      }).then(function(draftId) {
        var chain = Promise.resolve();
        chosen.forEach(function(file) {
          chain = chain.then(function() {
            var fd = new FormData();
            fd.append('docKey', docKey);
            fd.append('file', file, file.name);
            return window.App.upload('/api/drafts/' + encodeURIComponent(draftId) + '/files', fd).then(function(res) {
              if (!res.ok) {
                showUploadError((res.data && res.data.message) || 'อัปโหลดไม่สำเร็จ');
              } else {
                showUploadError('');
                S.files.push(res.data);
              }
              renderFiles();
            });
          });
        });
        return chain;
      });
    });
  }

  var fileListEl = byId('file-list');
  if (fileListEl) {
    fileListEl.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest('[data-testid="file-remove-btn"]');
      if (!btn || !S.draftId) return;
      var fid = btn.getAttribute('data-file-id');
      window.App.api('DELETE', '/api/drafts/' + encodeURIComponent(S.draftId) + '/files/' + encodeURIComponent(fid)).then(function(res) {
        if (res.ok || res.status === 204) {
          S.files = S.files.filter(function(f) { return f.fileId !== fid; });
          showUploadError('');
          renderFiles();
        }
      });
    });
  }

  var toPaymentBtn = q('to-payment-btn');
  if (toPaymentBtn) {
    toPaymentBtn.addEventListener('click', function() {
      pendingUpload.then(function() {
        var missing = computeMissing(S.files);
        if (missing.length > 0) {
          renderFiles();
          return;
        }
        var amt = S.lockedFee != null ? S.lockedFee : S.currentFee;
        var payAmtEl = q('payment-amount');
        if (payAmtEl) payAmtEl.textContent = fmtMoney(amt);
        showStep(3);
        var createQr = q('create-qr-btn');
        if (createQr) createQr.focus();
      });
    });
  }

  function renderPaymentState(p) {
    S.payment = p;
    var qrBox = byId('qr-container');
    var refreshBtn = q('refresh-payment-btn');
    if (!p) {
      if (qrBox) qrBox.hidden = true;
      if (refreshBtn) refreshBtn.hidden = true;
      return;
    }
    if (qrBox) qrBox.hidden = false;
    if (refreshBtn) refreshBtn.hidden = false;

    var payAmt = q('payment-amount');
    if (payAmt && p.amount != null) payAmt.textContent = fmtMoney(p.amount);

    var refEl = q('qr-ref');
    if (refEl) refEl.textContent = p.ref || '';

    var expEl = q('qr-expires');
    if (expEl && p.qrExpiresAt) {
      expEl.setAttribute('data-iso', p.qrExpiresAt);
      expEl.setAttribute('datetime', p.qrExpiresAt);
      expEl.textContent = 'หมดอายุ ' + fmtThDateTime(p.qrExpiresAt);
    }

    var st = p.status || 'PENDING';
    var stEl = q('payment-status');
    if (stEl) {
      stEl.setAttribute('data-status', st);
      stEl.textContent = PAY_TH[st] || st;
    }

    var expMsg = q('qr-expired-msg');
    var regenBtn = q('regenerate-qr-btn');
    if (expMsg) expMsg.hidden = (st !== 'EXPIRED');
    if (regenBtn) regenBtn.hidden = (st !== 'EXPIRED');

    var recBox = byId('receipt-container');
    if (recBox) {
      if (st === 'PAID' && p.caseNo) {
        recBox.hidden = false;
        var cNo = q('submitted-case-no');
        var rNo = q('receipt-no');
        var rAmt = q('receipt-amount');
        var rPaid = q('receipt-paid-at');
        var goBtn = q('go-case-btn');
        if (cNo) cNo.textContent = p.caseNo;
        if (rNo) rNo.textContent = p.receiptNo || '';
        if (rAmt) rAmt.textContent = fmtMoney(p.amount);
        if (rPaid && p.paidAt) {
          rPaid.setAttribute('data-iso', p.paidAt);
          rPaid.setAttribute('datetime', p.paidAt);
          rPaid.textContent = fmtThDateTime(p.paidAt);
        }
        if (goBtn) goBtn.setAttribute('href', '/citizen/cases/' + encodeURIComponent(p.caseNo));
      } else {
        recBox.hidden = true;
      }
    }
  }

  function requestNewQr() {
    pendingUpload.then(function() {
      return S.draftId ? Promise.resolve(S.draftId) : ensureDraftSaved();
    }).then(function(draftId) {
      return window.App.api('POST', '/api/drafts/' + encodeURIComponent(draftId) + '/payment');
    }).then(function(res) {
      if (!res.ok) {
        window.App.showError((res.data && res.data.message) || 'สร้าง QR ไม่สำเร็จ');
        return;
      }
      S.lockedFee = res.data.amount;
      renderPaymentState({
        ref: res.data.ref,
        amount: res.data.amount,
        status: 'PENDING',
        qrCreatedAt: res.data.qrCreatedAt,
        qrExpiresAt: res.data.qrExpiresAt,
        caseNo: null,
        receiptNo: null,
        paidAt: null
      });
    });
  }

  var createQrBtn = q('create-qr-btn');
  if (createQrBtn) createQrBtn.addEventListener('click', requestNewQr);
  var regenQrBtn = q('regenerate-qr-btn');
  if (regenQrBtn) regenQrBtn.addEventListener('click', requestNewQr);

  var refreshPayBtn = q('refresh-payment-btn');
  if (refreshPayBtn) {
    refreshPayBtn.addEventListener('click', function() {
      if (!S.payment || !S.payment.ref) return;
      window.App.api('GET', '/api/payments/' + encodeURIComponent(S.payment.ref)).then(function(res) {
        if (res.ok && res.data) {
          renderPaymentState(res.data);
        }
      });
    });
  }
})();`;

      return L.render(req, res, {
        title: `ยื่นคำขอ ${serviceId}`,
        body,
        scripts: [{ inline: wizardScript }],
      });
    });

    // --------------------------------------------------------- Page 3: GET /citizen/cases/:caseNo (CONTRACT §2.6)
    app.get('/citizen/cases/:caseNo', L.requireRole('citizen'), (req, res) => {
      const c = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(req.params.caseNo);
      if (!c) return L.sendNotFound(req, res);

      // BUG B06 (IDOR): when B06 is active, a citizen can open another citizen's case via URL
      if (c.citizen_id !== req.user.id && !bugmode.isBug('B06')) {
        return L.sendNotFound(req, res);
      }

      const holidays = rules.readHolidays(db);
      const now = clock.now();
      const level = rules.slaLevel({ status: c.status, dueAt: c.due_at }, now, holidays);
      const applicant = db.prepare('SELECT * FROM users WHERE id = ?').get(c.citizen_id);
      const rawIdNo = decryptCitizenIdNo(applicant);
      const formattedFullId = format.formatIdNo(rawIdNo);

      const files = getCaseFiles(c.case_no);
      const events = db
        .prepare('SELECT * FROM case_events WHERE case_no = ? ORDER BY at ASC, id ASC')
        .all(c.case_no);
      const doc = db.prepare('SELECT * FROM documents WHERE case_no = ?').get(c.case_no);

      const stepHtml =
        c.service_id === 'SV-03'
          ? `<dt>ขั้นตอนปัจจุบัน</dt><dd><span data-testid="case-step">${esc(format.STEP_TH[c.step || 1])}</span></dd>`
          : '';

      const closedAtHtml =
        c.status === 'COMPLETED' || c.status === 'REJECTED'
          ? `<dt>เวลาปิดงาน</dt><dd>${format.timeTag(c.closed_at, 'closed-at')}</dd>`
          : '';

      const noRefundHtml =
        c.status === 'REJECTED' || c.status === 'CANCELLED'
          ? `<p data-testid="no-refund-note" class="field-error" style="font-weight:600;margin-top:12px">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>`
          : '';

      const canCancel = c.status === 'SUBMITTED' && !c.owner;
      const cancelHtml = canCancel
        ? `<div class="card" style="margin-top:16px">
  <button type="button" data-testid="cancel-case-btn" class="btn btn-danger" id="cancel-case-btn">ยกเลิกคำขอ</button>
  <div id="cancel-confirm-box" hidden style="margin-top:12px">
    <p data-testid="cancel-confirm-text" class="field-error" style="font-weight:600">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>
    <button type="button" data-testid="confirm-cancel-btn" class="btn btn-danger" id="confirm-cancel-btn">ยืนยันยกเลิกคำขอ</button>
  </div>
</div>`
        : '';

      let needFixHtml = '';
      if (c.status === 'NEED_FIX') {
        const deadlineIso = c.fix_deadline || (c.returned_at ? rules.fixDeadline(c.returned_at) : null);
        const expired = c.returned_at ? rules.isFixWindowExpired(c.returned_at, now) : false;
        needFixHtml = `<section class="card" aria-labelledby="sec-need-fix" style="border-color:#f59e0b;background:#fffbeb">
  <h2 id="sec-need-fix">รายการแก้ไขตามที่เจ้าหน้าที่ตีกลับ</h2>
  <p>เหตุผลที่ตีกลับ: <strong data-testid="return-reason-display">${esc(c.return_reason || '')}</strong></p>
  <p>กำหนดส่งแก้ไขภายใน: ${format.timeTag(deadlineIso, 'fix-deadline')}</p>
  ${
    !expired
      ? `<div>
    <label for="fix-upload-input">แนบเอกสารแก้ไขเพิ่มเติม (ไม่บังคับ)</label>
    <input type="file" id="fix-upload-input" name="file" data-testid="fix-upload-input">
    <div style="margin-top:12px">
      <button type="button" data-testid="submit-fix-btn" class="btn" id="submit-fix-btn">ส่งแก้ไข</button>
    </div>
  </div>`
      : ''
  }
</section>`;
      }

      let docIssuedHtml = '';
      if (doc) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const verifyUrl = `${baseUrl}/verify/${doc.verify_code}`;
        docIssuedHtml = `<section class="card" aria-labelledby="sec-issued-doc" style="background:#f0fdf4">
  <h2 id="sec-issued-doc">เอกสารดิจิทัลที่ออกแล้ว</h2>
  <dl class="kv">
    <dt>เลขเอกสาร</dt>
    <dd><strong data-testid="doc-no">${esc(doc.doc_no)}</strong></dd>
    <dt>รหัสตรวจสอบ</dt>
    <dd><code data-testid="verify-code">${esc(doc.verify_code)}</code></dd>
    <dt>QR ตรวจสอบ</dt>
    <dd><div data-testid="doc-qr" data-url="${esc(verifyUrl)}" class="qr-box">${esc(verifyUrl)}</div></dd>
  </dl>
  <div style="margin-top:12px">
    <a href="/api/documents/${esc(doc.doc_no)}/pdf" data-testid="download-doc-btn" class="btn">ดาวน์โหลดเอกสาร</a>
  </div>
</section>`;
      }

      const filesHtml = files.length
        ? `<ul style="list-style:none;padding:0;margin:0">
  ${files
    .map(
      (f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.fileId)}" class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid #e5e7eb">
    <span><strong>${esc(format.DOC_LABEL[f.docKey] || f.docKey)}:</strong> ${esc(f.name)}</span>
    <a href="/api/files/${esc(f.fileId)}" data-testid="doc-download-link" class="btn btn-secondary">ดาวน์โหลด</a>
  </li>`
    )
    .join('\n')}
</ul>`
        : '<p class="muted">ไม่มีเอกสารแนบ</p>';

      const timelineHtml = events
        .map(
          (ev) => `<li data-testid="timeline-item" data-iso="${esc(format.iso(ev.at))}">
  ${format.timeTag(ev.at)} · <strong>${esc(ev.event)}</strong>${ev.detail ? ` — ${esc(ev.detail)}` : ''}
</li>`
        )
        .join('\n');

      const body = `
<h1>รายละเอียดคำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>

<section class="card" aria-labelledby="sec-case-info">
  <h2 id="sec-case-info">ข้อมูลคำขอ</h2>
  <dl class="kv">
    <dt>สถานะ</dt>
    <dd>${format.statusBadge(c.status, 'case-status')}</dd>
    <dt>บริการ</dt>
    <dd><span data-testid="case-service">${esc(format.serviceLabel(c.service_id))}</span></dd>
    ${stepHtml}
    <dt>ค่าธรรมเนียม</dt>
    <dd><span data-testid="case-fee">${esc(format.money(c.fee))}</span></dd>
    <dt>เลขบัตรประชาชนผู้ยื่น</dt>
    <dd><span data-testid="case-id-full">${esc(formattedFullId)}</span></dd>
    <dt>กำหนดเสร็จ (SLA)</dt>
    <dd>${format.timeTag(c.due_at, 'sla-due')}</dd>
    <dt>ระดับแจ้งเตือน SLA</dt>
    <dd>${format.levelBadge(level, 'sla-level')}</dd>
    ${closedAtHtml}
  </dl>
  ${noRefundHtml}
  ${cancelHtml}
</section>

${needFixHtml}
${docIssuedHtml}

<section class="card" aria-labelledby="sec-case-files">
  <h2 id="sec-case-files">เอกสารแนบประกอบคำขอ</h2>
  ${filesHtml}
</section>

<section class="card" aria-labelledby="sec-case-timeline">
  <h2 id="sec-case-timeline">ไทม์ไลน์เหตุการณ์</h2>
  <ul data-testid="case-timeline" class="timeline">
    ${timelineHtml}
  </ul>
</section>`;

      const caseScript = `(function(){
  var caseNo = ${JSON.stringify(c.case_no)};
  var cancelBtn = document.getElementById('cancel-case-btn');
  var confirmBox = document.getElementById('cancel-confirm-box');
  var confirmBtn = document.getElementById('confirm-cancel-btn');
  if (cancelBtn && confirmBox) {
    cancelBtn.addEventListener('click', function() {
      confirmBox.hidden = false;
    });
  }
  if (confirmBtn) {
    confirmBtn.addEventListener('click', function() {
      window.App.api('POST', '/api/cases/' + encodeURIComponent(caseNo) + '/cancel').then(function(res) {
        if (!res.ok) {
          window.App.showError((res.data && res.data.message) || 'ยกเลิกไม่สำเร็จ');
          return;
        }
        window.location.reload();
      });
    });
  }

  var submitFixBtn = document.getElementById('submit-fix-btn');
  if (submitFixBtn) {
    submitFixBtn.addEventListener('click', function() {
      var fileInput = document.getElementById('fix-upload-input');
      var file = fileInput && fileInput.files && fileInput.files[0];
      var reqPromise;
      if (file) {
        var fd = new FormData();
        fd.append('file', file, file.name);
        reqPromise = window.App.upload('/api/cases/' + encodeURIComponent(caseNo) + '/resubmit', fd);
      } else {
        reqPromise = window.App.api('POST', '/api/cases/' + encodeURIComponent(caseNo) + '/resubmit');
      }
      reqPromise.then(function(res) {
        if (!res.ok) {
          window.App.showError((res.data && res.data.message) || 'ส่งแก้ไขไม่สำเร็จ');
          return;
        }
        window.location.reload();
      });
    });
  }
})();`;

      return L.render(req, res, {
        title: `คำขอ ${c.case_no}`,
        body,
        scripts: [{ inline: caseScript }],
      });
    });
  },
};
