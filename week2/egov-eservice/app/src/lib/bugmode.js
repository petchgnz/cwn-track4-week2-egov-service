'use strict';
/**
 * BUG_MODE / TEST_MODE switches (B01).
 *
 *   BUG_MODE=B03,B07   → isBug('B03') === true, isBug('B07') === true
 *   unset / empty      → every isBug() is false (web is 100% correct)
 *
 * Bugs are injected in the module that owns the rule:  if (isBug('B05')) {...}
 * Codes are normalised: 'b3', 'B3', ' B03 ' → 'B03'.
 */

function normalise(code) {
  const m = /^B?(\d{1,2})$/i.exec(String(code || '').trim());
  return m ? 'B' + m[1].padStart(2, '0') : String(code || '').trim().toUpperCase();
}

const ACTIVE = new Set(
  String(process.env.BUG_MODE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalise)
);

const TEST_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.TEST_MODE || '').trim().toLowerCase());

/** true when bug `code` (e.g. 'B03') is switched on via BUG_MODE */
function isBug(code) {
  return ACTIVE.has(normalise(code));
}

/** list of active bug codes, sorted */
function activeBugs() {
  return [...ACTIVE].sort();
}

/** true when TEST_MODE=1 (test hooks /api/test/* enabled) */
function isTestMode() {
  return TEST_MODE;
}

module.exports = { isBug, activeBugs, isTestMode, TEST_MODE };
