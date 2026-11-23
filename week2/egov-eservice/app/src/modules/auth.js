'use strict';
/**
 * B05 · ยืนยันตัวตน + ลงทะเบียน + RBAC (ThaiD / SSO ภาครัฐ จำลอง)
 *
 * CONTRACT §1 (/ /login /register) · §2.2 · §2.3 · §5 · §6.1 · DECISIONS §1 §2 · audit STAFF_LOGIN (§6.8)
 *
 * Pages (server-rendered forms, work without JS; keyboard: Enter submits, next field autofocus)
 *   GET  /                 → redirect by role (not logged in → /login · pending registration → /register)
 *   GET  /login            → tabs citizen (ThaiD) / staff (SSO) · ?tab=staff opens the staff tab
 *   POST /login            → form actions: thaid-start · thaid-verify · staff
 *   GET  /register         → only for a 'register' session (ThaiD ok, not registered yet)
 *   POST /register         → validate mobile/consent → upgrade session → /citizen
 *   POST /logout · GET /logout → destroy session → /login
 *
 * API (JSON, errors {"code","message"} via L.apiError)
 *   POST /api/auth/thaid/start   {"idNo"}           200 {"status":"OTP_SENT"} · 400 INVALID_ID · 423 LOCKED {lockedUntil}
 *   POST /api/auth/thaid/verify  {"idNo","otp"}     200 {"registered":bool} + cookie · 401 OTP_INVALID {attemptsLeft} · 423 LOCKED {lockedUntil}
 *   POST /api/auth/register      {"mobile","email","consent"}  201 · 400 INVALID_MOBILE · 400 CONSENT_REQUIRED · 409 ALREADY_REGISTERED
 *   POST /api/auth/staff/login   {"username","password"} 200 {"role","dept","landing"} · 401 INVALID_CREDENTIALS
 *   POST /api/auth/logout        204
 *   GET  /api/me                 200 {"username","name","role","dept"} · 401
 *
 * OTP rule (DECISIONS §2, BR-02): OTP is always 123456 · 3 consecutive wrong OTPs lock the ID for
 * 15 min counted from the 3rd failure (unlock at exactly +15:00, counter restarts at 0) · a correct
 * OTP resets the counter. Lock state lives in table otp_lock keyed by the ID hash (wiped by reset).
 *
 * Dependencies loaded lazily (other blocks may not exist yet):
 *   src/lib/rules.js  (B03) – ID checksum, local fallback below
 *   src/lib/crypto.js (B02) – hashId / encrypt / decrypt, local fallback below
 */
const nodeCrypto = require('crypto');
const { writeAudit } = require('../lib/audit');

const TEST_OTP = '123456';
const MAX_FAILS = 3;
const LOCK_MINUTES = 15;
const MOBILE_RE = /^0\d{9}$/;

// ------------------------------------------------------------------ lazy deps
function lazyRequire(p) {
  try {
    return require(p);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(p.replace(/^\.\.\//, ''))) return null;
    throw e;
  }
}

/** Thai national ID: exactly 13 digits + checksum (DECISIONS §2 · BR-01) — local reference implementation */
function localIdValid(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}

const RULE_FN_NAMES = ['isValidIdNo', 'validIdNo', 'isValidThaiId', 'validateIdNo', 'checkIdNo', 'idNoValid', 'isValidNationalId', 'validThaiId', 'thaiIdValid', 'idChecksumOk', 'checkThaiId'];

function isValidIdNo(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return false;
  const s = String(raw).trim();
  if (!/^\d{13}$/.test(s)) return false; // 12 / 14 digits / non-digits rejected before anything else
  const rules = lazyRequire('../lib/rules');
  if (rules) {
    const name = RULE_FN_NAMES.find((n) => typeof rules[n] === 'function');
    if (name) {
      try {
        const r = rules[name](s);
        if (typeof r === 'boolean') return r;
        if (r && typeof r === 'object' && ('ok' in r || 'valid' in r)) return Boolean('ok' in r ? r.ok : r.valid);
      } catch {
        /* fall through to local */
      }
    }
  }
  return localIdValid(s);
}

function cryptoLib() {
  return lazyRequire('../lib/crypto');
}

function pickFn(lib, names) {
  if (!lib) return null;
  for (const n of names) if (typeof lib[n] === 'function') return lib[n].bind(lib);
  return null;
}

function hashId(idNo) {
  const fn = pickFn(cryptoLib(), ['hashId', 'hashIdNo', 'idHash', 'hashNationalId']);
  if (fn) return fn(idNo);
  return nodeCrypto.createHash('sha256').update(`egov-id:${idNo}`).digest('hex');
}

const FALLBACK_KEY = nodeCrypto.createHash('sha256').update(process.env.PII_KEY || 'egov-eservice-test-key (simulated)').digest();

function encryptPii(value) {
  const fn = pickFn(cryptoLib(), ['encrypt', 'encryptField', 'encryptPii', 'enc']);
  if (fn) return fn(String(value));
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', FALLBACK_KEY, iv);
  const ct = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return `gcm1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decryptPii(value) {
  if (value === null || value === undefined) return null;
  const fn = pickFn(cryptoLib(), ['decrypt', 'decryptField', 'decryptPii', 'dec']);
  if (fn) {
    try {
      return fn(value);
    } catch {
      return null;
    }
  }
  return null;
}

// ------------------------------------------------------------------ module
module.exports = {
  order: 10,
  register(app, ctx) {
    const { db, clock, layout: L, session, format } = ctx;
    const { esc } = format;

    // ---------------------------------------------------------- data helpers
    function findCitizen(idNo) {
      const h = hashId(idNo);
      let u = db.prepare("SELECT * FROM users WHERE id_hash = ? AND role = 'citizen'").get(h);
      if (u) return u;
      // fallback: compare decrypted ids (in case the seed hashed differently)
      const rows = db.prepare("SELECT * FROM users WHERE role = 'citizen' AND id_enc IS NOT NULL").all();
      for (const r of rows) if (decryptPii(r.id_enc) === idNo) return r;
      return null;
    }

    /** ThaiD simulation: a valid ID that is not in the DB yet becomes a new, unregistered citizen */
    function findOrCreateCitizen(idNo) {
      const existing = findCitizen(idNo);
      if (existing) return existing;
      const now = clock.nowIso();
      const info = db
        .prepare(
          `INSERT INTO users(username, role, dept, name, id_hash, id_enc, id_masked, registered, active, created_at, updated_at)
           VALUES (NULL, 'citizen', NULL, ?, ?, ?, ?, 0, 1, ?, ?)`
        )
        .run(`ผู้ใช้ ThaiD ${idNo.slice(-4)}`, hashId(idNo), encryptPii(idNo), format.maskIdNo(idNo), now, now);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }

    /** current lock row for an ID; an expired lock is cleared (counter restarts at 0 · BR-02) */
    function lockState(idNo) {
      const h = hashId(idNo);
      let row = db.prepare('SELECT * FROM otp_lock WHERE id_hash = ?').get(h);
      if (row && row.locked_until) {
        const until = clock.toDate(row.locked_until).getTime();
        if (clock.nowMs() >= until) {
          db.prepare('UPDATE otp_lock SET fail_count = 0, locked_until = NULL WHERE id_hash = ?').run(h);
          row = { ...row, fail_count: 0, locked_until: null };
        }
      }
      return {
        hash: h,
        fails: row ? row.fail_count : 0,
        lockedUntil: row && row.locked_until ? clock.toIso(row.locked_until) : null,
      };
    }

    function recordFailure(st) {
      const fails = st.fails + 1;
      const now = clock.now();
      const lockedUntil = fails >= MAX_FAILS ? clock.toIso(clock.addMinutes(now, LOCK_MINUTES)) : null;
      db.prepare(
        `INSERT INTO otp_lock(id_hash, fail_count, last_fail_at, locked_until) VALUES (?,?,?,?)
         ON CONFLICT(id_hash) DO UPDATE SET fail_count = excluded.fail_count, last_fail_at = excluded.last_fail_at, locked_until = excluded.locked_until`
      ).run(st.hash, fails, clock.toIso(now), lockedUntil);
      return { fails, lockedUntil, attemptsLeft: Math.max(0, MAX_FAILS - fails) };
    }

    function clearFailures(st) {
      db.prepare('DELETE FROM otp_lock WHERE id_hash = ?').run(st.hash);
    }

    function dropCurrentSession(req) {
      if (req.session && req.session.sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(req.session.sid);
    }

    // ---------------------------------------------------------- core logic (shared by API + pages)
    /** → { ok } | { status, code, extra } */
    function thaidStart(idNoRaw) {
      if (!isValidIdNo(idNoRaw)) return { status: 400, code: 'INVALID_ID' };
      const idNo = String(idNoRaw).trim();
      const st = lockState(idNo);
      if (st.lockedUntil) return { status: 423, code: 'LOCKED', extra: { lockedUntil: st.lockedUntil } };
      return { ok: true, idNo };
    }

    /** → { ok, user } | { status, code, extra } */
    function thaidVerify(idNoRaw, otpRaw) {
      if (!isValidIdNo(idNoRaw)) return { status: 400, code: 'INVALID_ID' };
      const idNo = String(idNoRaw).trim();
      const otp = otpRaw === undefined || otpRaw === null ? '' : String(otpRaw).trim();
      return db.transaction(() => {
        const st = lockState(idNo);
        if (st.lockedUntil) return { status: 423, code: 'LOCKED', extra: { lockedUntil: st.lockedUntil } };
        if (otp !== TEST_OTP) {
          const f = recordFailure(st);
          if (f.lockedUntil) return { status: 423, code: 'LOCKED', extra: { lockedUntil: f.lockedUntil } };
          return { status: 401, code: 'OTP_INVALID', extra: { attemptsLeft: f.attemptsLeft } };
        }
        clearFailures(st);
        const user = findOrCreateCitizen(idNo);
        return { ok: true, user };
      })();
    }

    function startCitizenSession(req, res, user) {
      dropCurrentSession(req);
      const registered = user.registered !== 0;
      session.create(res, user, { kind: registered ? 'auth' : 'register' });
      return registered;
    }

    function validateRegistration(body) {
      const mobile = body && body.mobile !== undefined && body.mobile !== null ? String(body.mobile).trim() : '';
      const email = body && body.email !== undefined && body.email !== null ? String(body.email).trim() : '';
      const c = body ? body.consent : undefined;
      const consent = c === true || c === 1 || ['true', '1', 'on', 'yes'].includes(String(c).toLowerCase());
      const errors = {};
      if (!MOBILE_RE.test(mobile)) errors.mobile = 'INVALID_MOBILE';
      if (!consent) errors.consent = 'CONSENT_REQUIRED';
      return { mobile, email, consent, errors };
    }

    function completeRegistration(req, res, v) {
      const now = clock.nowIso();
      db.prepare(
        `UPDATE users SET mobile_enc = ?, email_enc = ?, registered = 1, consent_at = ?, updated_at = ? WHERE id = ?`
      ).run(encryptPii(v.mobile), v.email ? encryptPii(v.email) : null, now, now, req.pendingUser.id);
      session.upgrade(req, res);
    }

    function staffLogin(usernameRaw, passwordRaw) {
      const { verifyPassword } = require('../lib/password');
      const username = typeof usernameRaw === 'string' ? usernameRaw.trim() : '';
      const password = typeof passwordRaw === 'string' ? passwordRaw : '';
      if (!username || !password) return null;
      const u = db.prepare("SELECT * FROM users WHERE username = ? AND role <> 'citizen' AND active = 1").get(username);
      if (!u || !u.password_hash || !verifyPassword(password, u.password_hash)) return null;
      return u;
    }

    function startStaffSession(req, res, u) {
      dropCurrentSession(req);
      session.create(res, u, { kind: 'auth' });
      writeAudit({ username: u.username, role: u.role, event: 'STAFF_LOGIN', detail: '' });
    }

    // ---------------------------------------------------------- API
    app.post('/api/auth/thaid/start', (req, res) => {
      const r = thaidStart(req.body && req.body.idNo);
      if (!r.ok) return L.apiError(res, r.status, r.code, r.extra);
      return res.status(200).json({ status: 'OTP_SENT' });
    });

    app.post('/api/auth/thaid/verify', (req, res) => {
      const b = req.body || {};
      const r = thaidVerify(b.idNo, b.otp);
      if (!r.ok) return L.apiError(res, r.status, r.code, r.extra);
      const registered = startCitizenSession(req, res, r.user);
      return res.status(200).json({ registered });
    });

    app.post('/api/auth/register', (req, res) => {
      if (req.user) return L.apiError(res, 409, 'ALREADY_REGISTERED', 'ลงทะเบียนแล้ว');
      if (!req.pendingUser) return L.apiError(res, 401, 'UNAUTHENTICATED');
      const v = validateRegistration(req.body);
      if (v.errors.mobile) return L.apiError(res, 400, 'INVALID_MOBILE');
      if (v.errors.consent) return L.apiError(res, 400, 'CONSENT_REQUIRED');
      completeRegistration(req, res, v);
      return res.status(201).json({ registered: true, landing: '/citizen' });
    });

    app.post('/api/auth/staff/login', (req, res) => {
      const b = req.body || {};
      const u = staffLogin(b.username, b.password);
      if (!u) return L.apiError(res, 401, 'INVALID_CREDENTIALS');
      startStaffSession(req, res, u);
      return res.status(200).json({ role: u.role, dept: u.dept || null, landing: L.landingFor({ role: u.role, registered: true }) });
    });

    app.post('/api/auth/logout', (req, res) => {
      session.destroy(req, res);
      return res.status(204).end();
    });

    app.get('/api/me', (req, res) => {
      if (!req.user) return L.apiError(res, 401, 'UNAUTHENTICATED');
      const u = req.user;
      return res.status(200).json({ username: u.username || null, name: u.name, role: u.role, dept: u.dept || null });
    });

    // wrong method on auth endpoints → 405 (CONTRACT §5)
    const methodNotAllowed = (req, res) => L.apiError(res, 405, 'METHOD_NOT_ALLOWED');
    ['/api/auth/thaid/start', '/api/auth/thaid/verify', '/api/auth/register', '/api/auth/staff/login', '/api/auth/logout'].forEach((p) =>
      app.all(p, methodNotAllowed)
    );
    app.all('/api/me', methodNotAllowed);

    // ---------------------------------------------------------- pages
    const PAGE_HEAD = `<style>
.auth-wrap { max-width: 560px; margin: 0 auto; }
.tabs { display: flex; gap: 4px; border-bottom: 2px solid #1d3557; margin: 0 0 16px; flex-wrap: wrap; }
.tabs a { padding: 8px 14px; border: 1px solid #9ca3af; border-bottom: none; border-radius: 6px 6px 0 0; text-decoration: none; color: #1d3557; background: #f3f4f6; }
.tabs a[aria-selected="true"] { background: #1d3557; color: #fff; border-color: #1d3557; font-weight: 600; }
.auth-panel[hidden] { display: none; }
.auth-panel form { margin: 0 0 12px; }
.auth-panel button { margin-top: 12px; }
.otp-step { border-top: 1px solid #e5e7eb; margin-top: 16px; padding-top: 8px; }
.lock-box { background: #fde8e8; border: 1px solid #f5b5b5; color: #8a1111; border-radius: 6px; padding: 10px 14px; margin: 12px 0; }
.hint { color: #4b5563; font-size: 0.925rem; margin: 4px 0; }
input[readonly] { background: #f3f4f6; }
</style>`;

    const TAB_SCRIPT = `(function(){
  var tabs=document.querySelectorAll('[role=tab][data-panel]');
  for(var i=0;i<tabs.length;i++){tabs[i].addEventListener('click',function(e){
    e.preventDefault();
    for(var j=0;j<tabs.length;j++){var t=tabs[j],on=t===this;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;
      var p=document.getElementById(t.getAttribute('data-panel'));if(p)p.hidden=!on;}
    var p2=document.getElementById(this.getAttribute('data-panel'));var f=p2&&p2.querySelector('input:not([type=hidden])');if(f)f.focus();
  });}
})();`;

    /**
     * state: { tab, idNo, otpStep, thaidError, otpError, attemptsLeft, lockedUntil, staffUsername, staffError }
     */
    function loginPage(req, res, state = {}, status = 200) {
      const tab = state.tab === 'staff' ? 'staff' : 'citizen';
      const cit = tab === 'citizen';
      const idVal = esc(state.idNo || '');
      const focusOtp = state.otpStep && cit;
      const focusId = cit && !state.otpStep;

      const lockHtml = state.lockedUntil
        ? `<div class="lock-box" role="alert">
  <p data-testid="lock-message" class="big-msg" style="margin:0 0 4px">${esc(L.ERRORS.LOCKED)}</p>
  <p style="margin:0">ปลดล็อกได้เวลา ${format.timeTag(state.lockedUntil, 'lock-until')}</p>
</div>`
        : '';

      const otpHtml = state.otpStep
        ? `<div data-testid="otp-step" class="otp-step">
  <h3>ขั้นที่ 2: ยืนยันรหัส OTP</h3>
  <p class="hint">(จำลอง) ระบบส่งรหัส OTP ไปยังแอป ThaiD ของเลขบัตร ${esc(format.maskIdNo(state.idNo))} แล้ว · รหัสทดสอบคือ 123456</p>
  <form method="post" action="/login" novalidate>
    <input type="hidden" name="action" value="thaid-verify">
    <input type="hidden" name="idNo" value="${idVal}">
    <label for="otp-input">รหัส OTP 6 หลัก</label>
    <input type="text" id="otp-input" name="otp" data-testid="otp-input" inputmode="numeric" autocomplete="one-time-code"${focusOtp ? ' autofocus' : ''}${state.otpError ? ' aria-invalid="true" aria-describedby="otp-error"' : ''}>
    ${state.otpError ? `<p id="otp-error" data-testid="otp-error" class="field-error" role="alert">${esc(L.ERRORS.OTP_INVALID)}</p>` : ''}
    ${state.attemptsLeft !== undefined && state.attemptsLeft !== null ? `<p data-testid="otp-attempts-left" class="hint">เหลือ ${esc(state.attemptsLeft)} ครั้ง</p>` : ''}
    <div><button type="submit" data-testid="otp-submit">ยืนยัน OTP</button></div>
  </form>
</div>`
        : '';

      const body = `<div class="auth-wrap">
<h1>เข้าสู่ระบบ e-Service</h1>
<div class="tabs" role="tablist" aria-label="ประเภทผู้ใช้">
  <a href="/login" role="tab" id="tab-citizen" data-panel="panel-citizen" data-testid="login-tab-citizen" aria-controls="panel-citizen" aria-selected="${cit}" tabindex="${cit ? 0 : -1}">ประชาชน (ThaiD)</a>
  <a href="/login?tab=staff" role="tab" id="tab-staff" data-panel="panel-staff" data-testid="login-tab-staff" aria-controls="panel-staff" aria-selected="${!cit}" tabindex="${cit ? -1 : 0}">เจ้าหน้าที่ (SSO)</a>
</div>

<section id="panel-citizen" class="auth-panel card" role="tabpanel" aria-labelledby="tab-citizen"${cit ? '' : ' hidden'}>
  <h2>ประชาชน · ThaiD (จำลอง)</h2>
  <form method="post" action="/login" novalidate>
    <input type="hidden" name="action" value="thaid-start">
    <label for="thaid-id-input">เลขบัตรประจำตัวประชาชน 13 หลัก</label>
    <input type="text" id="thaid-id-input" name="idNo" data-testid="thaid-id-input" inputmode="numeric" autocomplete="off" value="${idVal}"${focusId ? ' autofocus' : ''}${state.thaidError ? ' aria-invalid="true" aria-describedby="thaid-error"' : ''}>
    ${state.thaidError ? `<p id="thaid-error" data-testid="thaid-error" class="field-error" role="alert">${esc(L.ERRORS.INVALID_ID)}</p>` : ''}
    <div><button type="submit" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button></div>
  </form>
  ${lockHtml}
  ${otpHtml}
</section>

<section id="panel-staff" class="auth-panel card" role="tabpanel" aria-labelledby="tab-staff"${cit ? ' hidden' : ''}>
  <h2>เจ้าหน้าที่ · SSO ภาครัฐ (จำลอง)</h2>
  <form method="post" action="/login" novalidate>
    <input type="hidden" name="action" value="staff">
    <label for="staff-username">ชื่อผู้ใช้</label>
    <input type="text" id="staff-username" name="username" data-testid="staff-username" autocomplete="username" value="${esc(state.staffUsername || '')}"${!cit ? ' autofocus' : ''}>
    <label for="staff-password">รหัสผ่าน</label>
    <input type="password" id="staff-password" name="password" data-testid="staff-password" autocomplete="current-password">
    ${state.staffError ? `<p data-testid="staff-error" class="field-error" role="alert">${esc(L.ERRORS.INVALID_CREDENTIALS)}</p>` : ''}
    <div><button type="submit" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button></div>
  </form>
</section>
</div>`;
      return L.render(req, res, { status, title: 'เข้าสู่ระบบ', body, head: PAGE_HEAD, scripts: [{ inline: TAB_SCRIPT }] });
    }

    function registerPage(req, res, state = {}, status = 200) {
      const u = req.pendingUser;
      const e = state.errors || {};
      const body = `<div class="auth-wrap">
<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<section class="card">
  <p class="hint">ข้อมูลชื่อ-สกุลดึงจาก ThaiD (จำลอง) แก้ไขไม่ได้</p>
  <form method="post" action="/register" novalidate>
    <label for="reg-name">ชื่อ-สกุล</label>
    <input type="text" id="reg-name" name="name" data-testid="reg-name" value="${esc(u.name)}" readonly aria-readonly="true">
    <label for="reg-mobile">เบอร์มือถือ (บังคับ · 10 หลักขึ้นต้นด้วย 0)</label>
    <input type="tel" id="reg-mobile" name="mobile" data-testid="reg-mobile" inputmode="numeric" autocomplete="tel" value="${esc(state.mobile || '')}" required autofocus${e.mobile ? ' aria-invalid="true" aria-describedby="reg-error-mobile"' : ''}>
    ${e.mobile ? `<p id="reg-error-mobile" data-testid="reg-error-mobile" class="field-error" role="alert">${esc(L.ERRORS.INVALID_MOBILE)}</p>` : ''}
    <label for="reg-email">อีเมล (ไม่บังคับ)</label>
    <input type="email" id="reg-email" name="email" data-testid="reg-email" autocomplete="email" value="${esc(state.email || '')}">
    <label class="check" for="reg-consent">
      <input type="checkbox" id="reg-consent" name="consent" value="1" data-testid="reg-consent"${state.consent ? ' checked' : ''}${e.consent ? ' aria-invalid="true" aria-describedby="reg-error-consent"' : ''}>
      <span>ข้าพเจ้ายินยอมให้เทศบาลเก็บและประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการ e-Service ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</span>
    </label>
    ${e.consent ? `<p id="reg-error-consent" data-testid="reg-error-consent" class="field-error" role="alert">${esc(L.ERRORS.CONSENT_REQUIRED)}</p>` : ''}
    <div><button type="submit" data-testid="reg-submit">ลงทะเบียน</button></div>
  </form>
</section>
</div>`;
      return L.render(req, res, { status, title: 'ลงทะเบียน', body, head: PAGE_HEAD });
    }

    app.get('/', (req, res) => {
      if (req.user) return res.redirect(302, L.landingFor(req.user));
      if (req.pendingUser) return res.redirect(302, '/register');
      return res.redirect(302, '/login');
    });

    app.get('/login', (req, res) => {
      if (req.user) return res.redirect(302, L.landingFor(req.user));
      return loginPage(req, res, { tab: req.query.tab === 'staff' ? 'staff' : 'citizen' });
    });

    app.post('/login', (req, res) => {
      const b = req.body || {};
      const action = String(b.action || '');
      if (action === 'staff') {
        const u = staffLogin(b.username, b.password);
        if (!u) return loginPage(req, res, { tab: 'staff', staffUsername: b.username, staffError: true }, 401);
        startStaffSession(req, res, u);
        return res.redirect(303, L.landingFor({ role: u.role, registered: true }));
      }
      if (action === 'thaid-start') {
        const r = thaidStart(b.idNo);
        if (r.ok) return loginPage(req, res, { idNo: r.idNo, otpStep: true });
        if (r.code === 'LOCKED') return loginPage(req, res, { idNo: String(b.idNo).trim(), lockedUntil: r.extra.lockedUntil }, 423);
        return loginPage(req, res, { idNo: b.idNo, thaidError: true }, 400);
      }
      if (action === 'thaid-verify') {
        const r = thaidVerify(b.idNo, b.otp);
        if (r.ok) {
          const registered = startCitizenSession(req, res, r.user);
          return res.redirect(303, registered ? '/citizen' : '/register');
        }
        if (r.code === 'INVALID_ID') return loginPage(req, res, { idNo: b.idNo, thaidError: true }, 400);
        const idNo = String(b.idNo).trim();
        if (r.code === 'LOCKED') return loginPage(req, res, { idNo, otpStep: true, lockedUntil: r.extra.lockedUntil }, 423);
        return loginPage(req, res, { idNo, otpStep: true, otpError: true, attemptsLeft: r.extra.attemptsLeft }, 401);
      }
      return res.redirect(303, '/login');
    });

    app.get('/register', (req, res) => {
      if (req.user) return res.redirect(302, L.landingFor(req.user));
      if (!req.pendingUser) return res.redirect(302, '/login');
      return registerPage(req, res);
    });

    app.post('/register', (req, res) => {
      if (req.user) return res.redirect(303, L.landingFor(req.user));
      if (!req.pendingUser) return res.redirect(303, '/login');
      const v = validateRegistration(req.body);
      if (v.errors.mobile || v.errors.consent) return registerPage(req, res, v, 400);
      completeRegistration(req, res, v);
      return res.redirect(303, '/citizen');
    });

    const logoutPage = (req, res) => {
      session.destroy(req, res);
      return res.redirect(303, '/login');
    };
    app.post('/logout', logoutPage);
    app.get('/logout', logoutPage);
  },
};

// exported for unit tests / other modules
module.exports.isValidIdNo = isValidIdNo;
module.exports.localIdValid = localIdValid;
