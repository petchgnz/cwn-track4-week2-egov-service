'use strict';
/**
 * Placeholder pages (B01) for every CONTRACT §1 route. Registered AFTER all modules, so a module
 * that defines the same GET route wins. RBAC is already correct here (redirect /login · 403 forbidden-msg).
 */
module.exports = function placeholders(app, ctx) {
  const L = ctx.layout;
  const { esc } = ctx.format;
  const stub = (title) => (req, res) =>
    L.render(req, res, { title, body: `<h1>${esc(title)}</h1><p class="placeholder">อยู่ระหว่างพัฒนา</p>` });

  app.get('/', (req, res) => {
    if (req.user) return res.redirect(302, L.landingFor(req.user));
    if (req.pendingUser) return res.redirect(302, '/register');
    return res.redirect(302, '/login');
  });
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(302, L.landingFor(req.user));
    return stub('เข้าสู่ระบบ')(req, res);
  });
  app.get('/register', (req, res) => {
    if (!req.pendingUser) return res.redirect(302, req.user ? L.landingFor(req.user) : '/login');
    return stub('ลงทะเบียน')(req, res);
  });
  app.get('/citizen', L.requireRole('citizen'), stub('คำขอของฉัน'));
  app.get('/citizen/new/:service', L.requireRole('citizen'), stub('ยื่นคำขอ'));
  app.get('/citizen/cases/:caseNo', L.requireRole('citizen'), (req, res) => L.sendNotFound(req, res));
  app.get('/officer/queue', L.requireRole('officer', 'head'), stub('คิวงาน'));
  app.get('/officer/cases/:caseNo', L.requireRole('officer', 'head'), (req, res) => L.sendNotFound(req, res));
  app.get('/head/approvals', L.requireRole('head'), stub('รออนุมัติ'));
  app.get('/dashboard', L.requireRole('executive'), stub('Dashboard'));
  app.get('/audit', L.requireRole('auditor'), stub('Audit Trail'));
  app.get('/admin/services', L.requireRole('admin'), stub('จัดการบริการ'));
  app.get('/admin/holidays', L.requireRole('admin'), stub('จัดการวันหยุด'));
  app.get('/admin/users', L.requireRole('admin'), stub('จัดการผู้ใช้'));
  app.get('/notifications', L.requireRole('officer', 'head'), stub('การแจ้งเตือน'));
  app.get('/verify/:code', (req, res) => L.sendNotFound(req, res, L.ERRORS.DOC_NOT_FOUND));
};
