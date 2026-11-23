'use strict';
/**
 * Cryptography & PDPA helpers (B02).
 *
 * - AES-256-GCM encryption at rest for personal data (national ID, mobile, email) (DECISIONS §11, NFR-04)
 * - Deterministic HMAC-SHA256 hash (`hashId`) for national ID lookup & OTP lock tracking
 * - Thai national ID 13-digit checksum validation, formatting, and masking
 * - Document digital signature simulation using HMAC-SHA256 (`signDocument`, `verifyDocumentSignature`)
 *   over `docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer` (CONTRACT §3, DECISIONS §10)
 */
const crypto = require('crypto');

const AES_ALGO = 'aes-256-gcm';
const IV_LEN = 12;

const AES_KEY = crypto
  .createHash('sha256')
  .update(String(process.env.EGOV_AES_KEY || 'egov-eservice-test-aes-256-gcm-key-2026'))
  .digest();

const ID_HMAC_KEY = String(process.env.EGOV_ID_HMAC_KEY || 'egov-eservice-test-id-hmac-key-2026');
const DOC_HMAC_KEY = String(process.env.EGOV_DOC_HMAC_KEY || 'egov-eservice-test-doc-hmac-key-2026');

/**
 * Encrypt plaintext string with AES-256-GCM.
 * Returns null for null/undefined, or 'gcm:<ivHex>:<tagHex>:<cipherHex>'.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const str = String(plaintext);
  if (str === '') return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(AES_ALGO, AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt AES-256-GCM ciphertext produced by encrypt().
 * Returns null for null/undefined, '' for empty string.
 */
function decrypt(ciphertext) {
  if (ciphertext === null || ciphertext === undefined) return null;
  const s = String(ciphertext);
  if (s === '') return '';
  const parts = s.includes(':') ? s.split(':') : s.split('$');
  let ivHex, tagHex, dataHex;
  if (parts.length === 4 && (parts[0] === 'gcm' || parts[0] === 'aes256gcm')) {
    [, ivHex, tagHex, dataHex] = parts;
  } else if (parts.length === 3) {
    [ivHex, tagHex, dataHex] = parts;
  } else {
    throw new Error('Invalid encrypted payload format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(AES_ALGO, AES_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Deterministic HMAC-SHA256 hash of a 13-digit national ID for DB index/lookup.
 */
function hashId(idNo) {
  const clean = String(idNo === null || idNo === undefined ? '' : idNo).trim();
  return crypto.createHmac('sha256', ID_HMAC_KEY).update(clean, 'utf8').digest('hex');
}

/**
 * Validate 13-digit Thai national ID with mod-11 checksum (DECISIONS §2, BR-01).
 * 13th digit = (11 - (sum_{i=1..12} d_i * (14 - i)) mod 11) mod 10
 */
function isValidThaiId(idNo) {
  if (typeof idNo !== 'string' && typeof idNo !== 'number') return false;
  const s = String(idNo);
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(s[i]) * (13 - i);
  }
  const check = (11 - (sum % 11)) % 10;
  return check === Number(s[12]);
}

/** '1-XXXX-XXXXX-45-6' -> formatted full ID */
function formatIdNo(idNo) {
  const s = String(idNo || '').replace(/\D/g, '');
  if (s.length !== 13) return String(idNo || '');
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}

/** 'X-XXXX-XXXXX-45-6' -> masked ID for staff views (last 3 digits visible) */
function maskIdNo(idNo) {
  const s = String(idNo || '').replace(/\D/g, '');
  if (s.length !== 13) return 'X-XXXX-XXXXX-XX-X';
  return `X-XXXX-XXXXX-${s.slice(10, 12)}-${s[12]}`;
}

/**
 * Build canonical pipe-delimited string for document HMAC signing (CONTRACT §3, A-22):
 * docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer
 */
function buildDocPayload(docOrNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer) {
  if (docOrNo && typeof docOrNo === 'object') {
    const d = docOrNo;
    return [
      d.docNo ?? d.doc_no ?? '',
      d.caseNo ?? d.case_no ?? '',
      d.applicant ?? d.applicantName ?? d.applicant_name ?? '',
      d.serviceId ?? d.service_id ?? '',
      d.issuedAt ?? d.issued_at ?? '',
      d.validUntil ?? d.valid_until ?? '',
      d.signer ?? '',
    ].join('|');
  }
  return [docOrNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer]
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join('|');
}

/**
 * Compute HMAC-SHA256 signature for a digital document.
 * Accepts either an object `{ docNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer }`
 * (or snake_case DB row) OR 7 positional arguments.
 */
function signDocument(docOrNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer) {
  const payload = buildDocPayload(docOrNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer);
  return crypto.createHmac('sha256', DOC_HMAC_KEY).update(payload, 'utf8').digest('hex');
}

/**
 * Verify HMAC-SHA256 signature of a document row or object.
 */
function verifyDocumentSignature(doc, expectedSig) {
  if (!doc) return false;
  const sig = String(expectedSig !== undefined ? expectedSig : doc.signature || '');
  if (!sig) return false;
  const computed = signDocument(doc);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  AES_KEY,
  ID_HMAC_KEY,
  DOC_HMAC_KEY,
  encrypt,
  decrypt,
  encryptPii: encrypt,
  decryptPii: decrypt,
  enc: encrypt,
  dec: decrypt,
  hashId,
  hashIdNo: hashId,
  idHash: hashId,
  isValidThaiId,
  validateThaiId: isValidThaiId,
  validateIdNo: isValidThaiId,
  formatIdNo,
  maskIdNo,
  buildDocPayload,
  signDocument,
  verifyDocumentSignature,
  verifyDocument: verifyDocumentSignature,
};
