'use strict';
/**
 * Cookie sessions stored in the `sessions` table (B01).
 * POST /api/test/reset wipes the table → every old cookie becomes invalid.
 *
 *   const session = require('../lib/session');
 *   session.create(res, user, { kind: 'auth' })     // after successful login → sets HttpOnly cookie 'sid'
 *   session.create(res, user, { kind: 'register' }) // ThaiD ok but not registered: only /register + POST /api/auth/register
 *   session.destroy(req, res)                       // logout
 *   session.upgrade(req, res)                       // register → auth (after registration), snapshot role again
 *
 * The core middleware (server.js) sets for every request:
 *   req.session = { sid, kind, userId } | null
 *   req.user    = { id, username, name, role, dept, registered } | null   (only when kind === 'auth')
 *   req.pendingUser = same shape | null                                      (only when kind === 'register')
 * role/dept come from the snapshot taken at login (admin role change → effective next login).
 */
const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'sid';

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      if (!k) return;
      let v = part.slice(i + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    });
  return out;
}

function cookieString(name, value, { maxAge, expires } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  if (expires) s += `; Expires=${expires.toUTCString()}`;
  if (process.env.COOKIE_SECURE === '1') s += '; Secure';
  return s;
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', value);
  else res.setHeader('Set-Cookie', [].concat(prev, value));
}

/** Create a session for `user` (users row, or user id) and set the cookie. Returns sid. */
function create(res, user, { kind = 'auth' } = {}) {
  const sid = crypto.randomBytes(32).toString('hex');
  const u = user && typeof user === 'object' ? user : db.prepare('SELECT * FROM users WHERE id = ?').get(user);
  if (!u) throw new Error('session.create: user not found');
  const t = new Date().toISOString();
  db.prepare('INSERT INTO sessions(sid, user_id, kind, role, dept, created_at, last_seen) VALUES (?,?,?,?,?,?,?)').run(
    sid,
    u.id,
    kind,
    u.role,
    u.dept || null,
    t,
    t
  );
  appendSetCookie(res, cookieString(COOKIE, sid));
  return sid;
}

/** Turn the current 'register' session into a full 'auth' session (re-snapshots role/dept). */
function upgrade(req, res) {
  const sid = req.session && req.session.sid;
  const u = sid && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?').get(sid);
  if (!u) return null;
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  return create(res, u, { kind: 'auth' });
}

function destroy(req, res) {
  const sid = (req.session && req.session.sid) || parseCookies(req.headers.cookie)[COOKIE];
  if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  appendSetCookie(res, cookieString(COOKIE, '', { maxAge: 0, expires: new Date(0) }));
}

function destroyAll() {
  db.prepare('DELETE FROM sessions').run();
}

let loadStmt = null;

/** Express middleware: resolve cookie → req.session / req.user / req.pendingUser */
function middleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.session = null;
  req.user = null;
  req.pendingUser = null;
  const sid = req.cookies[COOKIE];
  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    if (!loadStmt) {
      loadStmt = db.prepare(
        `SELECT s.sid, s.kind, s.role AS s_role, s.dept AS s_dept,
                u.id, u.username, u.name, u.role, u.dept, u.registered, u.active
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.sid = ?`
      );
    }
    const row = loadStmt.get(sid);
    if (row && row.active !== 0) {
      const user = {
        id: row.id,
        username: row.username,
        name: row.name,
        role: row.s_role || row.role,
        dept: row.s_role ? row.s_dept || null : row.dept || null,
        registered: row.registered !== 0,
      };
      req.session = { sid: row.sid, kind: row.kind, userId: row.id };
      if (row.kind === 'auth') req.user = user;
      else req.pendingUser = user;
    }
  }
  next();
}

module.exports = { COOKIE, parseCookies, create, upgrade, destroy, destroyAll, middleware };
