'use strict';
/**
 * B10 · Dashboard ผู้บริหาร + ส่งออกรายงาน Excel (.xlsx) / PDF (.pdf)
 *
 * CONTRACT §1 (/dashboard) · §2.9 · §6.4 · §6.8 · §7
 * DECISIONS §12 · §16 (B10) · §18 · TEST-DATA §7 · REQUIREMENTS FR-22 FR-23 BR-24 BR-25 BR-26
 */
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { writeAudit } = require('../lib/audit');
const fallbackRules = require('../lib/rules');

const VALID_SERVICES = ['ALL', 'SV-01', 'SV-02', 'SV-03'];
const BASE_PERIODS = ['2026-12', '2026-11', '2026-10', '2026'];

const SERVICE_OPTIONS = [
  { value: 'ALL', label: 'ทั้งหมด (ALL)' },
  { value: 'SV-01', label: 'SV-01 ขอหนังสือรับรอง' },
  { value: 'SV-02', label: 'SV-02 ขออนุญาตประกอบกิจการ' },
  { value: 'SV-03', label: 'SV-03 ขออนุญาตก่อสร้าง/ต่อเติมอาคาร' },
];

/** Normalise period query parameter; defaults to the current clock month ('YYYY-MM'). */
function normalisePeriod(raw, clock) {
  const defaultMonth = clock.bkkDate(clock.now()).slice(0, 7);
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultMonth;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    const gregY = y >= 2400 ? y - 543 : y;
    return `${gregY}-${String(m).padStart(2, '0')}`;
  }
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    const gregY = y >= 2400 ? y - 543 : y;
    return String(gregY);
  }
  return defaultMonth;
}

/** Normalise service query parameter; defaults to 'ALL'. */
function normaliseService(raw) {
  if (!raw) return 'ALL';
  const s = String(raw).trim().toUpperCase();
  return VALID_SERVICES.includes(s) ? s : 'ALL';
}

/** True when ISO timestamp `ts` falls in `period` ('YYYY-MM' or 'YYYY') in Asia/Bangkok. */
function inPeriod(ts, period, clock) {
  if (!ts) return false;
  const d = clock.bkkDate(ts); // 'YYYY-MM-DD' in +07:00
  if (!d || d.length < 7) return false;
  if (/^\d{4}-\d{2}$/.test(period)) return d.slice(0, 7) === period;
  if (/^\d{4}$/.test(period)) return d.slice(0, 4) === period;
  return false;
}

/** Period dropdown label in Thai B.E. */
function periodLabel(period, format) {
  if (/^\d{4}-\d{2}$/.test(period)) return `${format.thPeriod(period)} (${period})`;
  if (/^\d{4}$/.test(period)) return `ทั้ง${format.thPeriod(period)} (${period})`;
  return period;
}

/** Compute all dashboard metrics for (period, service) at current clock. */
function computeDashboard(ctx, periodRaw, serviceRaw) {
  const { db, clock, bugmode } = ctx;
  const rules = ctx.rules || fallbackRules;
  const period = normalisePeriod(periodRaw, clock);
  const service = normaliseService(serviceRaw);
  const nowIso = clock.nowIso();

  const cases =
    service === 'ALL'
      ? db.prepare('SELECT case_no, service_id, status, paid_at, due_at, closed_at FROM cases').all()
      : db
          .prepare('SELECT case_no, service_id, status, paid_at, due_at, closed_at FROM cases WHERE service_id = ?')
          .all(service);

  let received = 0;
  let closed = 0;
  let onTime = 0;
  let backlog = 0;
  let overdue = 0;

  for (const c of cases) {
    if (inPeriod(c.paid_at, period, clock)) {
      received++;
    }
    if ((c.status === 'COMPLETED' || c.status === 'REJECTED') && c.closed_at && inPeriod(c.closed_at, period, clock)) {
      closed++;
      if (rules.isOnTime(c.closed_at, c.due_at)) {
        onTime++;
      }
    }
    if (rules.BACKLOG_STATUSES.includes(c.status)) {
      backlog++;
      if (c.status !== 'NEED_FIX' && c.due_at && rules.isOverdue(nowIso, c.due_at)) {
        overdue++;
      }
    }
  }

  // BUG B10: divide on-time count by received instead of closed
  const denominator = bugmode.isBug('B10') ? received : closed;
  const ontimePct = rules.ontimePct(onTime, denominator);
  const ontimeText = rules.formatPct(ontimePct);

  // Officer workload: all officers (even with 0), counting IN_REVIEW cases they hold
  const officers = db
    .prepare("SELECT username, name, dept FROM users WHERE role = 'officer' ORDER BY id ASC")
    .all();
  const countsRows = db
    .prepare("SELECT owner, COUNT(*) AS cnt FROM cases WHERE status = 'IN_REVIEW' AND owner IS NOT NULL GROUP BY owner")
    .all();
  const countByOwner = new Map(countsRows.map((r) => [r.owner, Number(r.cnt) || 0]));

  const workload = officers.map((o) => ({
    username: o.username,
    count: countByOwner.get(o.username) || 0,
  }));

  const workloadDetails = officers.map((o) => ({
    username: o.username,
    name: o.name,
    dept: o.dept,
    count: countByOwner.get(o.username) || 0,
  }));

  return {
    period,
    service,
    received,
    closed,
    onTime,
    ontimePct,
    ontimeText,
    backlog,
    overdue,
    workload,
    workloadDetails,
  };
}

/** Build a workbook buffer for Dashboard .xlsx export (CONTRACT §7). */
async function buildExcelBuffer(stats) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Dashboard');
  ws.addRow(['ตัวชี้วัด', 'ค่า']);
  ws.addRow(['รับเรื่อง', String(stats.received)]);
  ws.addRow(['ปิดงาน', String(stats.closed)]);
  ws.addRow(['ทันกำหนด %', String(stats.ontimeText)]);
  ws.addRow(['งานคงค้าง', String(stats.backlog)]);
  ws.addRow(['เกินกำหนดคงค้าง', String(stats.overdue)]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Build a PDF buffer for Dashboard .pdf export (CONTRACT §7). */
function buildPdfBuffer(stats) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, compress: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ontimeAscii = stats.ontimePct === null ? '-' : `${Number(stats.ontimePct).toFixed(1)}%`;
    const kpiLine = `kpi received=${stats.received} closed=${stats.closed} ontime=${ontimeAscii} backlog=${stats.backlog} overdue=${stats.overdue}`;

    doc.font('Helvetica-Bold').fontSize(14).text('e-Service Executive Dashboard Report', { lineBreak: true });
    doc.moveDown(0.5);
    doc.font('Courier').fontSize(10).text(`period=${stats.period} service=${stats.service}`, { lineBreak: true });
    doc.moveDown(0.5);
    doc.font('Courier').fontSize(10).text(kpiLine, { width: 520, lineBreak: true });
    doc.addContent(`% ${kpiLine}`);
    doc.moveDown(0.5);
    for (const w of stats.workload) {
      doc.font('Courier').fontSize(10).text(`workload ${w.username}=${w.count}`, { lineBreak: true });
    }
    doc.end();
  });
}

module.exports = {
  order: 50,
  register(app, ctx) {
    const { clock, layout: L, format } = ctx;
    const { esc, DEPT_TH } = format;

    function periodList() {
      const currentMonth = clock.bkkDate(clock.now()).slice(0, 7);
      const currentYear = currentMonth.slice(0, 4);
      const list = [];
      const add = (p) => {
        if (p && !list.includes(p)) list.push(p);
      };
      add(currentMonth);
      for (const p of BASE_PERIODS) add(p);
      add(currentYear);
      return list;
    }

    // ------------------------------------------------------------------ API
    app.get('/api/dashboard', L.requireRole('executive'), (req, res) => {
      const stats = computeDashboard(ctx, req.query.period, req.query.service);
      return res.status(200).json({
        received: stats.received,
        closed: stats.closed,
        onTime: stats.onTime,
        ontimePct: stats.ontimePct,
        backlog: stats.backlog,
        overdue: stats.overdue,
        workload: stats.workload,
      });
    });

    app.get(
      '/api/dashboard/export',
      L.requireRole('executive'),
      L.ah(async (req, res) => {
        const fmt = String(req.query.format || '').trim().toLowerCase();
        if (fmt !== 'xlsx' && fmt !== 'pdf') {
          return L.apiError(res, 400, 'BAD_REQUEST', 'รูปแบบส่งออกต้องเป็น xlsx หรือ pdf');
        }
        const stats = computeDashboard(ctx, req.query.period, req.query.service);
        writeAudit({
          req,
          event: 'EXPORT',
          detail: `${fmt} ${stats.period} ${stats.service}`,
        });

        if (fmt === 'xlsx') {
          const buf = await buildExcelBuffer(stats);
          res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.set('Content-Disposition', `attachment; filename="dashboard-${stats.period}-${stats.service}.xlsx"`);
          return res.status(200).send(buf);
        }

        const buf = await buildPdfBuffer(stats);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="dashboard-${stats.period}-${stats.service}.pdf"`);
        return res.status(200).send(buf);
      })
    );

    const methodNotAllowed = (req, res) => L.apiError(res, 405, 'METHOD_NOT_ALLOWED');
    app.all('/api/dashboard', methodNotAllowed);
    app.all('/api/dashboard/export', methodNotAllowed);

    // ------------------------------------------------------------------ Page
    const PAGE_HEAD = `<style>
.dash-toolbar { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: flex-end; }
.dash-field { flex: 1 1 200px; max-width: 300px; }
.dash-field label { margin-top: 0; }
.dash-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.kpi-label { color: #374151; font-weight: 600; font-size: 0.95rem; margin-bottom: 4px; }
</style>`;

    const CLIENT_SCRIPT = `(function(){
  var periodEl = document.querySelector('[data-testid="period-select"]');
  var serviceEl = document.querySelector('[data-testid="service-select"]');
  var xlsxBtn = document.querySelector('[data-testid="export-xlsx-btn"]');
  var pdfBtn = document.querySelector('[data-testid="export-pdf-btn"]');
  var snap = window.__DASH_SNAPSHOT__ || {};
  if (!periodEl || !serviceEl) return;

  function setText(testid, val) {
    var el = document.querySelector('[data-testid="' + testid + '"]');
    if (el) el.textContent = String(val);
  }

  function applyData(d) {
    if (!d) return;
    setText('kpi-received', d.received);
    setText('kpi-closed', d.closed);
    setText('kpi-ontime-pct', d.ontimePct === null || d.ontimePct === undefined ? '–' : Number(d.ontimePct).toFixed(1) + '%');
    setText('kpi-backlog', d.backlog);
    setText('kpi-overdue', d.overdue);
    if (Array.isArray(d.workload)) {
      for (var i = 0; i < d.workload.length; i++) {
        var w = d.workload[i];
        var row = document.querySelector('[data-testid="workload-row"][data-username="' + w.username + '"]');
        if (row) {
          var v = row.querySelector('[data-testid="workload-value"]');
          if (v) v.textContent = String(w.count);
        }
      }
    }
  }

  function updateExportLinks() {
    var p = encodeURIComponent(periodEl.value);
    var s = encodeURIComponent(serviceEl.value);
    if (xlsxBtn) xlsxBtn.setAttribute('href', '/api/dashboard/export?format=xlsx&period=' + p + '&service=' + s);
    if (pdfBtn) pdfBtn.setAttribute('href', '/api/dashboard/export?format=pdf&period=' + p + '&service=' + s);
  }

  function onFilterChange() {
    var p = periodEl.value;
    var s = serviceEl.value;
    updateExportLinks();
    if (snap[p] && snap[p][s]) {
      applyData(snap[p][s]);
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '/dashboard?period=' + encodeURIComponent(p) + '&service=' + encodeURIComponent(s));
    }
    var url = '/api/dashboard?period=' + encodeURIComponent(p) + '&service=' + encodeURIComponent(s);
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && periodEl.value === p && serviceEl.value === s) {
          if (!snap[p]) snap[p] = {};
          snap[p][s] = data;
          applyData(data);
        }
      })
      .catch(function(){});
  }

  periodEl.addEventListener('change', onFilterChange);
  serviceEl.addEventListener('change', onFilterChange);
  if (xlsxBtn) xlsxBtn.addEventListener('click', updateExportLinks);
  if (pdfBtn) pdfBtn.addEventListener('click', updateExportLinks);
})();`;

    app.get('/dashboard', L.requireRole('executive'), (req, res) => {
      const periods = periodList();
      const stats = computeDashboard(ctx, req.query.period, req.query.service);
      if (!periods.includes(stats.period)) periods.unshift(stats.period);

      // Pre-compute snapshot for all period x service combinations for 0ms synchronous updates
      const snapshot = {};
      for (const p of periods) {
        snapshot[p] = {};
        for (const s of VALID_SERVICES) {
          const st = p === stats.period && s === stats.service ? stats : computeDashboard(ctx, p, s);
          snapshot[p][s] = {
            received: st.received,
            closed: st.closed,
            onTime: st.onTime,
            ontimePct: st.ontimePct,
            backlog: st.backlog,
            overdue: st.overdue,
            workload: st.workload,
          };
        }
      }

      const periodOptsHtml = periods
        .map(
          (p) =>
            `<option value="${esc(p)}"${p === stats.period ? ' selected' : ''}>${esc(periodLabel(p, format))}</option>`
        )
        .join('');

      const serviceOptsHtml = SERVICE_OPTIONS.map(
        (o) => `<option value="${esc(o.value)}"${o.value === stats.service ? ' selected' : ''}>${esc(o.label)}</option>`
      ).join('');

      const xlsxHref = `/api/dashboard/export?format=xlsx&period=${encodeURIComponent(stats.period)}&service=${encodeURIComponent(stats.service)}`;
      const pdfHref = `/api/dashboard/export?format=pdf&period=${encodeURIComponent(stats.period)}&service=${encodeURIComponent(stats.service)}`;

      const workloadRowsHtml = stats.workloadDetails
        .map(
          (w) => `<tr data-testid="workload-row" data-username="${esc(w.username)}">
        <td>${esc(w.username)}</td>
        <td>${esc(w.name)}</td>
        <td>${esc(DEPT_TH[w.dept] || w.dept || '–')}</td>
        <td data-testid="workload-value">${esc(w.count)}</td>
      </tr>`
        )
        .join('');

      const body = `<h1>Dashboard ผู้บริหาร</h1>
<section class="card" aria-label="ตัวกรองและการส่งออกรายงาน">
  <form method="get" action="/dashboard" class="dash-toolbar">
    <div class="dash-field">
      <label for="period-select">ช่วงเวลา (เดือน/ปี)</label>
      <select id="period-select" name="period" data-testid="period-select">${periodOptsHtml}</select>
    </div>
    <div class="dash-field">
      <label for="service-select">บริการ</label>
      <select id="service-select" name="service" data-testid="service-select">${serviceOptsHtml}</select>
    </div>
    <div class="dash-actions">
      <a href="${esc(xlsxHref)}" data-testid="export-xlsx-btn" class="btn">ส่งออก Excel</a>
      <a href="${esc(pdfHref)}" data-testid="export-pdf-btn" class="btn btn-secondary">ส่งออก PDF</a>
    </div>
  </form>
</section>

<section aria-labelledby="kpi-heading">
  <h2 id="kpi-heading">ตัวชี้วัดผลการดำเนินงาน</h2>
  <div class="kpis">
    <div class="kpi">
      <div class="kpi-label">รับเรื่อง</div>
      <div class="v" data-testid="kpi-received">${esc(stats.received)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">ปิดงาน</div>
      <div class="v" data-testid="kpi-closed">${esc(stats.closed)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">ทันกำหนด %</div>
      <div class="v" data-testid="kpi-ontime-pct">${esc(stats.ontimeText)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">งานคงค้าง</div>
      <div class="v" data-testid="kpi-backlog">${esc(stats.backlog)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">เกินกำหนดคงค้าง</div>
      <div class="v" data-testid="kpi-overdue">${esc(stats.overdue)}</div>
    </div>
  </div>
</section>

<section class="card" style="margin-top:16px" aria-labelledby="workload-heading">
  <h2 id="workload-heading" style="margin-top:0">งานในมือรายเจ้าหน้าที่</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th scope="col">รหัสเจ้าหน้าที่</th>
          <th scope="col">ชื่อเจ้าหน้าที่</th>
          <th scope="col">ฝ่าย</th>
          <th scope="col">งานในมือ (เรื่อง)</th>
        </tr>
      </thead>
      <tbody>
        ${workloadRowsHtml}
      </tbody>
    </table>
  </div>
</section>`;

      const inlineSnap = `window.__DASH_SNAPSHOT__ = ${JSON.stringify(snapshot)};\n${CLIENT_SCRIPT}`;
      return L.render(req, res, {
        title: 'Dashboard',
        body,
        head: PAGE_HEAD,
        scripts: [{ inline: inlineSnap }],
      });
    });
  },
  computeDashboard,
  buildExcelBuffer,
  buildPdfBuffer,
};
