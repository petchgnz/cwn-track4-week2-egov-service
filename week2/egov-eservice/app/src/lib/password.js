'use strict';
/**
 * Staff password hashing (B01) — scrypt, format 'scrypt$N$saltHex$hashHex'.
 *   hashPassword('Test@1234')          → string to store in users.password_hash
 *   verifyPassword('Test@1234', stored) → boolean (timing-safe)
 */
const crypto = require('crypto');

const N = 4096; // cheap enough for a reset that re-seeds the staff accounts before every TC
const KEYLEN = 32;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (!n || !expected.length) return false;
  const got = crypto.scryptSync(String(pw), salt, expected.length, { N: n });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

module.exports = { hashPassword, verifyPassword };
