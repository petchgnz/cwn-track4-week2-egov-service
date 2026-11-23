'use strict';
/**
 * B11 · Audit Trail + ผู้ดูแลระบบ (บริการ · วันหยุด · ผู้ใช้)
 *
 * CONTRACT §1 (/audit /admin/services /admin/holidays /admin/users)
 * CONTRACT §2.10 (/audit testids) · §2.11 (/admin/* testids)
 * CONTRACT §5 (error codes & exact Thai messages)
 * CONTRACT §6.4 (GET /api/audit · GET /api/audit/export.csv · PUT/PATCH/DELETE /api/audit[/:id] → 405)
 * CONTRACT §6.5 (GET/PUT /api/admin/services[/:id] · GET/POST/DELETE /api/admin/holidays[/:date] · GET/PUT /api/admin/users[/:username])
 * CONTRACT §6.8 (Audit detail format) · §7 (Audit CSV export format)
 * DECISIONS §1 §3 §13 §18 · BR-27 BR-28 · A-36 A-42 A-51 A-53 A-57
 */
const { writeAudit, EVENTS } = require('../lib/audit');
const defaultRules = require('../lib/rules');

const VALID_ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const VALID_DEPTS = ['registry', 'works'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a Gregorian YYYY-MM-DD calendar date (rejects rolled-over dates like 2026-02-31). */
function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}

/** Escape a single CSV cell per RFC 4180. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function register(app, ctx) {
  const { db, clock, layout: L, format } = ctx;
  const rules = ctx.rules || defaultRules;
  const { esc } = format;

  // =========================================================================
  // 1. AUDIT TRAIL (/audit, /api/audit, /api/audit/export.csv)
  // =========================================================================

  /**
   * Append-only enforcement (DECISIONS §13 · CONTRACT §6.4 · BR-27):
   * PUT / PATCH / DELETE on /api/audit and /api/audit/:id ALWAYS return 405 METHOD_NOT_ALLOWED
   * for every role (including admin) and even when :id does not exist.
   */
  const methodNotAllowed = (req, res) => L.apiError(res, 405, 'METHOD_NOT_ALLOWED');

  app.put('/api/audit', methodNotAllowed);
  app.patch('/api/audit', methodNotAllowed);
  app.delete('/api/audit', methodNotAllowed);
  app.post('/api/audit', methodNotAllowed);

  app.put('/api/audit/:id', methodNotAllowed);
  app.patch('/api/audit/:id', methodNotAllowed);
  app.delete('/api/audit/:id', methodNotAllowed);
  app.post('/api/audit/:id', methodNotAllowed);

  app.put('/audit', methodNotAllowed);
  app.patch('/audit', methodNotAllowed);
  app.delete('/audit', methodNotAllowed);
  app.put('/audit/:id', methodNotAllowed);
  app.patch('/audit/:id', methodNotAllowed);
  app.delete('/audit/:id', methodNotAllowed);

  /**
   * Query & filter audit rows in Thai time (Asia/Bangkok +07:00, BR-27, A-51).
   * Sorted newest → oldest; ties broken by id DESC (TC-AUDIT-01).
   */
  function queryAudit(q = {}) {
    const actor = typeof q.actor === 'string' ? q.actor.trim() : '';
    const event = typeof q.event === 'string' ? q.event.trim().toUpperCase() : '';
    const from = typeof q.from === 'string' && DATE_RE.test(q.from.trim()) ? q.from.trim() : '';
    const to = typeof q.to === 'string' && DATE_RE.test(q.to.trim()) ? q.to.trim() : '';

    const where = [];
    const params = {};
    if (actor) {
      where.push('username = @actor');
      params.actor = actor;
    }
    if (event) {
      where.push('event = @event');
      params.event = event;
    }

    const sql = `SELECT id, time, username, role, event, case_no, from_status, to_status, detail
                   FROM audit
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY id DESC`;
    const rawRows = db.prepare(sql).all(params);

    const filtered = [];
    for (const r of rawRows) {
      const isoTime = clock.toIso(r.time) || r.time;
      const bkkDay = clock.bkkDate(isoTime);
      if (from && bkkDay < from) continue;
      if (to && bkkDay > to) continue;
      filtered.push({
        id: r.id,
        time: isoTime,
        _ms: clock.toDate(isoTime).getTime(),
        username: r.username || null,
        role: r.role || null,
        event: r.event,
        caseNo: r.case_no || null,
        fromStatus: r.from_status || null,
        toStatus: r.to_status || null,
        detail: r.detail === null || r.detail === undefined ? '' : String(r.detail),
      });
    }

    filtered.sort((a, b) => {
      if (a._ms !== b._ms && !Number.isNaN(a._ms) && !Number.isNaN(b._ms)) {
        return b._ms - a._ms;
      }
      return b.id - a.id;
    });

    const items = filtered.map(({ _ms, ...rest }) => rest);
    return { items, filters: { actor, event, from, to } };
  }

  // GET /api/audit (CONTRACT §6.4)
  app.get('/api/audit', L.requireRole('auditor'), (req, res) => {
    const { items } = queryAudit(req.query);
    return res.status(200).json({ count: items.length, items });
  });

  // GET /api/audit/export.csv (CONTRACT §6.4, §6.8, §7, A-36)
  app.get('/api/audit/export.csv', L.requireRole('auditor'), (req, res) => {
    const { items } = queryAudit(req.query);
    // Record EXPORT after snapshotting current rows so exported rows match the screen (TC-AUDIT-01)
    writeAudit({ req, event: 'EXPORT', detail: 'audit-csv' });

    const lines = ['time,username,role,event,caseNo,fromStatus,toStatus,detail'];
    for (const it of items) {
      lines.push(
        [
          csvCell(it.time),
          csvCell(it.username || ''),
          csvCell(it.role || ''),
          csvCell(it.event),
          csvCell(it.caseNo || ''),
          csvCell(it.fromStatus || ''),
          csvCell(it.toStatus || ''),
          csvCell(it.detail || ''),
        ].join(',')
      );
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="audit.csv"');
    return res.status(200).send(lines.join('\n') + '\n');
  });

  app.all('/api/audit/export.csv', methodNotAllowed);

  // GET /audit (CONTRACT §1, §2.10)
  app.get('/audit', L.requireRole('auditor'), (req, res) => {
    const { items, filters } = queryAudit(req.query);
    const qs = new URLSearchParams();
    if (filters.actor) qs.set('actor', filters.actor);
    if (filters.event) qs.set('event', filters.event);
    if (filters.from) qs.set('from', filters.from);
    if (filters.to) qs.set('to', filters.to);
    const csvHref = `/api/audit/export.csv${qs.toString() ? '?' + qs.toString() : ''}`;

    const eventOptions = ['<option value="">ทั้งหมด</option>']
      .concat(
        EVENTS.map(
          (ev) => `<option value="${esc(ev)}"${filters.event === ev ? ' selected' : ''}>${esc(ev)}</option>`
        )
      )
      .join('');

    const rowsHtml = items
      .map((r) => {
        const transition =
          r.fromStatus || r.toStatus ? `${r.fromStatus || '–'} → ${r.toStatus || '–'}` : '–';
        return `<tr data-testid="audit-row" data-id="${esc(r.id)}" data-event="${esc(r.event)}" data-actor="${esc(r.username || '')}" data-case-no="${esc(r.caseNo || '')}">
  <td>${format.timeTag(r.time, 'audit-time')}</td>
  <td data-testid="audit-actor">${esc(r.username || '–')}</td>
  <td data-testid="audit-role">${esc(r.role || '–')}</td>
  <td data-testid="audit-event">${esc(r.event)}</td>
  <td data-testid="audit-case-no">${esc(r.caseNo || '–')}</td>
  <td data-testid="audit-transition">${esc(transition)}</td>
  <td data-testid="audit-detail">${esc(r.detail || '')}</td>
</tr>`;
      })
      .join('\n');

    const body = `<h1>ประวัติการทำรายการ (Audit Trail)</h1>
<section class="card" aria-label="ตัวกรอง Audit Trail">
  <form method="get" action="/audit" novalidate>
    <div class="grid">
      <div>
        <label for="audit-filter-actor">ผู้ทำรายการ (username)</label>
        <input type="text" id="audit-filter-actor" name="actor" data-testid="audit-filter-actor" value="${esc(filters.actor)}" placeholder="เช่น off.reg2">
      </div>
      <div>
        <label for="audit-filter-event">เหตุการณ์</label>
        <select id="audit-filter-event" name="event" data-testid="audit-filter-event">${eventOptions}</select>
      </div>
      <div>
        <label for="audit-filter-from">ตั้งแต่วันที่ (ค.ศ.)</label>
        <input type="date" id="audit-filter-from" name="from" data-testid="audit-filter-from" value="${esc(filters.from)}">
      </div>
      <div>
        <label for="audit-filter-to">ถึงวันที่ (ค.ศ.)</label>
        <input type="date" id="audit-filter-to" name="to" data-testid="audit-filter-to" value="${esc(filters.to)}">
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <button type="submit" data-testid="audit-apply-btn">ค้นหา</button>
      <a href="${esc(csvHref)}" data-testid="audit-export-csv-btn" class="btn btn-secondary">ส่งออก CSV</a>
    </div>
  </form>
</section>

<section class="card" aria-label="รายการ Audit Trail">
  <p style="margin:0 0 12px">พบทั้งหมด <strong data-testid="audit-count">${items.length}</strong> รายการ</p>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th scope="col">เวลา</th>
          <th scope="col">ผู้ทำรายการ</th>
          <th scope="col">บทบาท</th>
          <th scope="col">เหตุการณ์</th>
          <th scope="col">เลขคำขอ</th>
          <th scope="col">สถานะก่อน → หลัง</th>
          <th scope="col">รายละเอียด / เหตุผล</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>
</section>`;

    return L.render(req, res, { title: 'Audit Trail', body });
  });

  // =========================================================================
  // 2. ADMIN: SERVICES (/admin/services, /api/admin/services, /api/admin/services/:id)
  // =========================================================================

  function listServices() {
    return db.prepare('SELECT id, name, fee, fee_per_sqm, sla FROM services ORDER BY sort, id').all();
  }

  /**
   * Validate and update a service's fee / feePerSqm / sla (BR-28, CONTRACT §6.5, §6.8).
   * Returns { ok: true, service, detail } or { ok: false, status, code, message }.
   */
  function updateService(req, serviceId, input = {}) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    if (!svc) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'ไม่พบบริการ' };
    }

    const rawFee =
      serviceId === 'SV-03'
        ? input.feeBase !== undefined
          ? input.feeBase
          : input.fee
        : input.fee !== undefined
          ? input.fee
          : input.feeBase;

    const feeCheck = rules.validateAdminFee(rawFee !== undefined ? rawFee : svc.fee);
    if (!feeCheck.ok) return feeCheck;

    let newPerSqm = svc.fee_per_sqm;
    if (serviceId === 'SV-03') {
      const rawPerSqm =
        input.feePerSqm !== undefined
          ? input.feePerSqm
          : input.fee_per_sqm !== undefined
            ? input.fee_per_sqm
            : svc.fee_per_sqm;
      const perSqmCheck = rules.validateAdminFee(rawPerSqm);
      if (!perSqmCheck.ok) return perSqmCheck;
      newPerSqm = perSqmCheck.value;
    }

    const rawSla = input.sla !== undefined ? input.sla : svc.sla;
    const slaCheck = rules.validateAdminSla(rawSla);
    if (!slaCheck.ok) return slaCheck;

    const newFee = feeCheck.value;
    const newSla = slaCheck.value;
    const now = clock.nowIso();

    db.prepare('UPDATE services SET fee = ?, fee_per_sqm = ?, sla = ?, updated_at = ? WHERE id = ?').run(
      newFee,
      newPerSqm,
      newSla,
      now,
      serviceId
    );

    const changes = [];
    if (svc.fee !== newFee) changes.push(`${serviceId} fee ${svc.fee} → ${newFee}`);
    if (serviceId === 'SV-03' && svc.fee_per_sqm !== newPerSqm) {
      changes.push(`${serviceId} feePerSqm ${svc.fee_per_sqm} → ${newPerSqm}`);
    }
    if (svc.sla !== newSla) changes.push(`${serviceId} sla ${svc.sla} → ${newSla}`);
    if (changes.length === 0) {
      changes.push(`${serviceId} fee ${svc.fee} → ${newFee}`);
    }
    const detail = changes.join(' · ');

    writeAudit({ req, event: 'ADMIN_CHANGE', detail });

    return {
      ok: true,
      service: { id: serviceId, fee: newFee, feePerSqm: newPerSqm, sla: newSla },
      detail,
    };
  }

  app.get('/api/admin/services', L.requireRole('admin'), (req, res) => {
    const items = listServices().map((r) => ({
      id: r.id,
      fee: r.fee,
      feePerSqm: r.fee_per_sqm,
      sla: r.sla,
    }));
    return res.status(200).json({ items });
  });

  app.put('/api/admin/services/:id', L.requireRole('admin'), (req, res) => {
    const r = updateService(req, req.params.id, req.body || {});
    if (!r.ok) return L.apiError(res, r.status, r.code, r.message);
    return res.status(200).json(r.service);
  });

  function renderAdminServices(req, res, opts = {}) {
    const services = listServices();
    const overrides = opts.overrides || {};

    const cardsHtml = services
      .map((s) => {
        const ov = overrides[s.id] || {};
        const feeVal = ov.fee !== undefined ? ov.fee : s.fee;
        const perSqmVal = ov.feePerSqm !== undefined ? ov.feePerSqm : s.fee_per_sqm;
        const slaVal = ov.sla !== undefined ? ov.sla : s.sla;

        const feeInputsHtml =
          s.id === 'SV-03'
            ? `<div>
          <label for="svc-fee-${esc(s.id)}">ค่าธรรมเนียมฐาน พื้นที่ 1–100 ตร.ม. (บาท)</label>
          <input type="number" id="svc-fee-${esc(s.id)}" name="feeBase" data-testid="svc-fee-${esc(s.id)}" value="${esc(feeVal)}">
        </div>
        <div>
          <label for="svc-fee-per-sqm-${esc(s.id)}">ค่าธรรมเนียมส่วนเกิน 100 ตร.ม. (บาท/ตร.ม.)</label>
          <input type="number" id="svc-fee-per-sqm-${esc(s.id)}" name="feePerSqm" data-testid="svc-fee-per-sqm-${esc(s.id)}" value="${esc(perSqmVal)}">
        </div>`
            : `<div>
          <label for="svc-fee-${esc(s.id)}">ค่าธรรมเนียม ${s.id === 'SV-01' ? '(บาทต่อฉบับ)' : '(บาทคงที่)'}</label>
          <input type="number" id="svc-fee-${esc(s.id)}" name="fee" data-testid="svc-fee-${esc(s.id)}" value="${esc(feeVal)}">
        </div>`;

        return `<section class="card" data-testid="service-row" data-service-id="${esc(s.id)}">
  <h2>${esc(s.id)} · ${esc(s.name)}</h2>
  <form method="post" action="/admin/services" novalidate>
    <input type="hidden" name="serviceId" value="${esc(s.id)}">
    <div class="grid">
      ${feeInputsHtml}
      <div>
        <label for="svc-sla-${esc(s.id)}">SLA (วันทำการ)</label>
        <input type="number" id="svc-sla-${esc(s.id)}" name="sla" data-testid="svc-sla-${esc(s.id)}" value="${esc(slaVal)}">
      </div>
    </div>
    <div style="margin-top:12px">
      <button type="submit" data-testid="svc-save-${esc(s.id)}">บันทึก ${esc(s.id)}</button>
    </div>
  </form>
</section>`;
      })
      .join('\n');

    const body = `<h1>จัดการบริการ (ค่าธรรมเนียมและ SLA)</h1>
${cardsHtml}`;

    return L.render(req, res, {
      status: opts.status || 200,
      title: 'จัดการบริการ',
      body,
      error: opts.error,
      success: opts.success,
    });
  }

  app.get('/admin/services', L.requireRole('admin'), (req, res) => {
    return renderAdminServices(req, res);
  });

  app.post('/admin/services', L.requireRole('admin'), (req, res) => {
    const b = req.body || {};
    const serviceId = String(b.serviceId || '').trim();
    const r = updateService(req, serviceId, b);
    if (!r.ok) {
      return renderAdminServices(req, res, {
        status: r.status,
        error: r.message,
        overrides: {
          [serviceId]: {
            fee: b.feeBase !== undefined ? b.feeBase : b.fee,
            feePerSqm: b.feePerSqm,
            sla: b.sla,
          },
        },
      });
    }
    return renderAdminServices(req, res, {
      status: 200,
      success: `บันทึกบริการ ${serviceId} เรียบร้อยแล้ว`,
    });
  });

  // =========================================================================
  // 3. ADMIN: HOLIDAYS (/admin/holidays, /api/admin/holidays, /api/admin/holidays/:date)
  // =========================================================================

  function listHolidays() {
    return db.prepare('SELECT date, name FROM holidays ORDER BY date ASC').all();
  }

  function addHoliday(req, input = {}) {
    const date = typeof input.date === 'string' ? input.date.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!isValidDateStr(date)) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)' };
    }
    const existing = db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(date);
    if (existing) {
      return { ok: false, status: 409, code: 'DUPLICATE_HOLIDAY', message: L.ERRORS.DUPLICATE_HOLIDAY };
    }
    const holidayName = name || 'วันหยุดพิเศษ';
    db.prepare('INSERT INTO holidays(date, name, created_at) VALUES (?, ?, ?)').run(date, holidayName, clock.nowIso());
    writeAudit({ req, event: 'ADMIN_CHANGE', detail: `holiday add ${date}` });
    return { ok: true, holiday: { date, name: holidayName } };
  }

  function deleteHoliday(req, dateRaw) {
    const date = typeof dateRaw === 'string' ? dateRaw.trim() : '';
    const existing = db.prepare('SELECT date, name FROM holidays WHERE date = ?').get(date);
    if (!existing) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'ไม่พบวันหยุด' };
    }
    db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
    writeAudit({ req, event: 'ADMIN_CHANGE', detail: `holiday delete ${date}` });
    return { ok: true, date };
  }

  app.get('/api/admin/holidays', L.requireRole('admin'), (req, res) => {
    return res.status(200).json({ items: listHolidays() });
  });

  app.post('/api/admin/holidays', L.requireRole('admin'), (req, res) => {
    const r = addHoliday(req, req.body || {});
    if (!r.ok) return L.apiError(res, r.status, r.code, r.message);
    return res.status(201).json(r.holiday);
  });

  app.delete('/api/admin/holidays/:date', L.requireRole('admin'), (req, res) => {
    const r = deleteHoliday(req, req.params.date);
    if (!r.ok) return L.apiError(res, r.status, r.code, r.message);
    return res.status(200).json({ ok: true, date: r.date });
  });

  function renderAdminHolidays(req, res, opts = {}) {
    const holidays = listHolidays();
    const formDate = opts.formDate || '';
    const formName = opts.formName || '';

    const rowsHtml = holidays
      .map(
        (h) => `<tr data-testid="holiday-row" data-date="${esc(h.date)}">
  <td>${esc(h.date)}</td>
  <td>${esc(format.thDate(h.date))}</td>
  <td>${esc(h.name)}</td>
  <td>
    <form method="post" action="/admin/holidays" style="margin:0" novalidate>
      <input type="hidden" name="action" value="delete">
      <input type="hidden" name="date" value="${esc(h.date)}">
      <button type="submit" data-testid="holiday-delete-btn" class="btn btn-danger">ลบ</button>
    </form>
  </td>
</tr>`
      )
      .join('\n');

    const body = `<h1>จัดการวันหยุด</h1>
<section class="card" aria-label="เพิ่มวันหยุดใหม่">
  <h2>เพิ่มวันหยุด</h2>
  <form method="post" action="/admin/holidays" novalidate>
    <input type="hidden" name="action" value="add">
    <div class="grid">
      <div>
        <label for="holiday-date-input">วันที่วันหยุด (ค.ศ. YYYY-MM-DD)</label>
        <input type="date" id="holiday-date-input" name="date" data-testid="holiday-date-input" value="${esc(formDate)}">
      </div>
      <div>
        <label for="holiday-name-input">ชื่อวันหยุด</label>
        <input type="text" id="holiday-name-input" name="name" data-testid="holiday-name-input" value="${esc(formName)}">
      </div>
    </div>
    <div style="margin-top:12px">
      <button type="submit" data-testid="holiday-add-btn">เพิ่มวันหยุด</button>
    </div>
  </form>
</section>

<section class="card" aria-label="รายการวันหยุด">
  <h2>รายการวันหยุดในระบบ</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th scope="col">วันที่ (ค.ศ.)</th>
          <th scope="col">วันที่ (พ.ศ.)</th>
          <th scope="col">ชื่อวันหยุด</th>
          <th scope="col">การจัดการ</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>
</section>`;

    return L.render(req, res, {
      status: opts.status || 200,
      title: 'จัดการวันหยุด',
      body,
      error: opts.error,
      success: opts.success,
    });
  }

  app.get('/admin/holidays', L.requireRole('admin'), (req, res) => {
    return renderAdminHolidays(req, res);
  });

  app.post('/admin/holidays', L.requireRole('admin'), (req, res) => {
    const b = req.body || {};
    const action = String(b.action || 'add');
    if (action === 'delete') {
      const r = deleteHoliday(req, b.date);
      if (!r.ok) return renderAdminHolidays(req, res, { status: r.status, error: r.message });
      return renderAdminHolidays(req, res, { status: 200, success: `ลบวันหยุด ${r.date} เรียบร้อยแล้ว` });
    }
    const r = addHoliday(req, b);
    if (!r.ok) {
      return renderAdminHolidays(req, res, {
        status: r.status,
        error: r.message,
        formDate: b.date,
        formName: b.name,
      });
    }
    return renderAdminHolidays(req, res, {
      status: 200,
      success: `เพิ่มวันหยุด ${r.holiday.date} เรียบร้อยแล้ว`,
    });
  });

  // =========================================================================
  // 4. ADMIN: USERS (/admin/users, /api/admin/users, /api/admin/users/:username)
  // =========================================================================

  function listStaffUsers() {
    return db
      .prepare('SELECT username, name, role, dept FROM users WHERE username IS NOT NULL ORDER BY id ASC')
      .all()
      .map((u) => ({
        username: u.username,
        name: u.name,
        role: u.role,
        dept: u.dept || null,
      }));
  }

  function updateUserRole(req, targetUsername, input = {}) {
    const username = typeof targetUsername === 'string' ? targetUsername.trim() : '';
    const target = db.prepare('SELECT id, username, name, role, dept FROM users WHERE username = ?').get(username);
    if (!target) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'ไม่พบผู้ใช้' };
    }
    if (req.user && req.user.username === username) {
      return { ok: false, status: 409, code: 'SELF_ROLE_CHANGE', message: L.ERRORS.SELF_ROLE_CHANGE };
    }
    const newRole = typeof input.role === 'string' ? input.role.trim() : '';
    if (!VALID_ROLES.includes(newRole)) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'บทบาทไม่ถูกต้อง' };
    }
    const rawDept = input.dept === null || input.dept === undefined ? '' : String(input.dept).trim();
    if (rawDept !== '' && !VALID_DEPTS.includes(rawDept)) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'แผนกไม่ถูกต้อง' };
    }
    const newDept = rawDept === '' ? null : rawDept;

    db.prepare('UPDATE users SET role = ?, dept = ?, updated_at = ? WHERE id = ?').run(
      newRole,
      newDept,
      clock.nowIso(),
      target.id
    );

    const detail = `${username} role ${target.role} → ${newRole}`;
    writeAudit({ req, event: 'ADMIN_CHANGE', detail });

    return {
      ok: true,
      user: { username, name: target.name, role: newRole, dept: newDept },
      detail,
    };
  }

  app.get('/api/admin/users', L.requireRole('admin'), (req, res) => {
    return res.status(200).json({ items: listStaffUsers() });
  });

  app.put('/api/admin/users/:username', L.requireRole('admin'), (req, res) => {
    const r = updateUserRole(req, req.params.username, req.body || {});
    if (!r.ok) return L.apiError(res, r.status, r.code, r.message);
    return res.status(200).json(r.user);
  });

  function renderAdminUsers(req, res, opts = {}) {
    const users = listStaffUsers();

    const rowsHtml = users
      .map((u) => {
        const roleOpts = VALID_ROLES.map(
          (r) =>
            `<option value="${esc(r)}"${u.role === r ? ' selected' : ''}>${esc(format.ROLE_TH[r] || r)} (${esc(r)})</option>`
        ).join('');
        const deptOpts = [
          `<option value=""${!u.dept ? ' selected' : ''}>–</option>`,
          `<option value="registry"${u.dept === 'registry' ? ' selected' : ''}>ฝ่ายทะเบียน (registry)</option>`,
          `<option value="works"${u.dept === 'works' ? ' selected' : ''}>ฝ่ายโยธา (works)</option>`,
        ].join('');

        return `<section class="card" data-testid="user-row" data-username="${esc(u.username)}">
  <h2>${esc(u.username)} · ${esc(u.name)}</h2>
  <form method="post" action="/admin/users" novalidate>
    <input type="hidden" name="username" value="${esc(u.username)}">
    <div class="grid">
      <div>
        <label for="role-${esc(u.username)}">บทบาทของ ${esc(u.username)}</label>
        <select id="role-${esc(u.username)}" name="role" data-testid="user-role-select">${roleOpts}</select>
      </div>
      <div>
        <label for="dept-${esc(u.username)}">แผนกของ ${esc(u.username)}</label>
        <select id="dept-${esc(u.username)}" name="dept" data-testid="user-dept-select">${deptOpts}</select>
      </div>
    </div>
    <div style="margin-top:12px">
      <button type="submit" data-testid="user-save-btn">บันทึก ${esc(u.username)}</button>
    </div>
  </form>
</section>`;
      })
      .join('\n');

    const body = `<h1>จัดการผู้ใช้และบทบาท</h1>
${rowsHtml}`;

    return L.render(req, res, {
      status: opts.status || 200,
      title: 'จัดการผู้ใช้',
      body,
      error: opts.error,
      success: opts.success,
    });
  }

  app.get('/admin/users', L.requireRole('admin'), (req, res) => {
    return renderAdminUsers(req, res);
  });

  app.post('/admin/users', L.requireRole('admin'), (req, res) => {
    const b = req.body || {};
    const r = updateUserRole(req, b.username, b);
    if (!r.ok) {
      return renderAdminUsers(req, res, { status: r.status, error: r.message });
    }
    return renderAdminUsers(req, res, {
      status: 200,
      success: `บันทึกบทบาทของ ${r.user.username} เรียบร้อยแล้ว`,
    });
  });
}

module.exports = {
  order: 80,
  register,
  writeAudit,
  EVENTS,
};
