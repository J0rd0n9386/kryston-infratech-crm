/**
 * Central-only exports.
 *
 * CSV is emitted as UTF-8 with a BOM so Excel opens Indian currency and unicode
 * names correctly. `.xls` downloads use SpreadsheetML (Excel-compatible XML),
 * which avoids adding a binary XLSX dependency while still opening natively in
 * Excel, LibreOffice and Google Sheets.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral } = require('../middleware/rbac');
const { assertEnum } = require('../middleware/validate');

const DATASETS = {
  leads: {
    filename: 'kryston-leads',
    headers: [
      'Lead ID',
      'Channel',
      'Source',
      'Customer Name',
      'Phone',
      'Email',
      'Location',
      'Area',
      'Project Type',
      'City',
      'Area (Sqft)',
      'Budget Band',
      'Stage',
      'Priority',
      'Budget',
      'Timeline',
      'Telecaller',
      'BDM',
      'Site Engineer',
      'Architect',
      'Work Order Value (INR)',
      'Created At',
      'Updated At',
    ],
    rows: (db, filters = {}) => {
      const conditions = ['l.deleted_at IS NULL'];
      const params = [];
      if (filters.from) {
        conditions.push('l.created_at >= ?');
        params.push(String(filters.from));
      }
      if (filters.to) {
        const toVal = String(filters.to).length === 10 ? `${filters.to} 23:59:59` : String(filters.to);
        conditions.push('l.created_at <= ?');
        params.push(toVal);
      }
      if (filters.source) {
        conditions.push('l.source = ?');
        params.push(String(filters.source));
      }
      if (filters.stage) {
        conditions.push('l.stage = ?');
        params.push(String(filters.stage));
      }
      if (filters.department) {
        conditions.push('EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.department = ?)');
        params.push(String(filters.department));
      }
      return db
        .prepare(
          `SELECT l.id, l.channel, l.source, l.customer_name, l.phone, l.email,
                  l.location, l.area, l.project_type, l.city, l.area_sqft, l.budget_band,
                  l.stage, l.priority, l.budget_range, l.timeline,
                  tc.name AS telecaller, bdm.name AS bdm, eng.name AS engineer,
                  arc.name AS architect, l.wo_value, l.created_at, l.updated_at
           FROM leads l
           LEFT JOIN employees tc ON tc.id = l.assigned_telecaller
           LEFT JOIN employees bdm ON bdm.id = l.assigned_bdm
           LEFT JOIN employees eng ON eng.id = l.assigned_engineer
           LEFT JOIN employees arc ON arc.id = l.assigned_architect
           WHERE ${conditions.join(' AND ')}
           ORDER BY l.created_at DESC`,
        )
        .all(...params)
        .map((r) => [
          r.id,
          r.channel,
          r.source,
          r.customer_name,
          r.phone,
          r.email,
          r.location,
          r.area,
          r.project_type,
          r.city,
          r.area_sqft,
          r.budget_band,
          r.stage,
          r.priority,
          r.budget_range,
          r.timeline,
          r.telecaller,
          r.bdm,
          r.engineer,
          r.architect,
          r.wo_value,
          r.created_at,
          r.updated_at,
        ]);
    },
  },
  tasks: {
    filename: 'kryston-tasks',
    headers: [
      'Task ID',
      'Lead ID',
      'Customer',
      'Department',
      'Task Type',
      'Priority',
      'Assigned To',
      'Assigned By',
      'Brief',
      'Due Date',
      'SLA (Hours)',
      'Status',
      'Created At',
      'Submitted At',
      'Reviewed At',
    ],
    rows: (db, filters = {}) => {
      const conditions = [];
      const params = [];
      if (filters.from) {
        conditions.push('t.created_at >= ?');
        params.push(String(filters.from));
      }
      if (filters.to) {
        const toVal = String(filters.to).length === 10 ? `${filters.to} 23:59:59` : String(filters.to);
        conditions.push('t.created_at <= ?');
        params.push(toVal);
      }
      if (filters.department) {
        conditions.push('t.department = ?');
        params.push(String(filters.department));
      }
      if (filters.source) {
        conditions.push('l.source = ?');
        params.push(String(filters.source));
      }
      if (filters.stage) {
        conditions.push('(t.status = ? OR l.stage = ?)');
        params.push(String(filters.stage), String(filters.stage));
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      return db
        .prepare(
          `SELECT t.id, t.lead_id, l.customer_name, t.department, t.task_type, t.priority,
                  assignee.name AS assigned_to, creator.name AS assigned_by, t.brief,
                  t.due_date, t.sla_hours, t.status, t.created_at, t.submitted_at, t.reviewed_at
           FROM tasks t
           LEFT JOIN leads l ON l.id = t.lead_id
           LEFT JOIN employees assignee ON assignee.id = t.assigned_to
           LEFT JOIN employees creator ON creator.id = t.assigned_by
           ${whereClause}
           ORDER BY t.created_at DESC`,
        )
        .all(...params)
        .map((r) => [
          r.id,
          r.lead_id,
          r.customer_name,
          r.department,
          r.task_type,
          r.priority,
          r.assigned_to,
          r.assigned_by,
          r.brief,
          r.due_date,
          r.sla_hours,
          r.status,
          r.created_at,
          r.submitted_at,
          r.reviewed_at,
        ]);
    },
  },
  timeline: {
    filename: 'kryston-lead-timeline',
    headers: [
      'Action ID',
      'Lead ID',
      'Customer',
      'Action Type',
      'From Employee',
      'To Employee',
      'Department',
      'Remarks',
      'Old Stage',
      'New Stage',
      'Timestamp',
    ],
    rows: (db, filters = {}) => {
      const conditions = [];
      const params = [];
      if (filters.from) {
        conditions.push('a.created_at >= ?');
        params.push(String(filters.from));
      }
      if (filters.to) {
        const toVal = String(filters.to).length === 10 ? `${filters.to} 23:59:59` : String(filters.to);
        conditions.push('a.created_at <= ?');
        params.push(toVal);
      }
      if (filters.department) {
        conditions.push('a.to_department = ?');
        params.push(String(filters.department));
      }
      if (filters.source) {
        conditions.push('l.source = ?');
        params.push(String(filters.source));
      }
      if (filters.stage) {
        conditions.push('(a.new_stage = ? OR a.old_stage = ?)');
        params.push(String(filters.stage), String(filters.stage));
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      return db
        .prepare(
          `SELECT a.id, a.lead_id, l.customer_name, a.action_type,
                  f.name AS from_employee, t.name AS to_employee, a.to_department,
                  a.remarks, a.old_stage, a.new_stage, a.created_at
           FROM lead_actions a
           LEFT JOIN leads l ON l.id = a.lead_id
           LEFT JOIN employees f ON f.id = a.from_employee
           LEFT JOIN employees t ON t.id = a.to_employee
           ${whereClause}
           ORDER BY a.created_at DESC, a.id DESC`,
        )
        .all(...params)
        .map((r) => [
          r.id,
          r.lead_id,
          r.customer_name,
          r.action_type,
          r.from_employee,
          r.to_employee,
          r.to_department,
          r.remarks,
          r.old_stage,
          r.new_stage,
          r.created_at,
        ]);
    },
  },
};

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toSpreadsheetXml(sheetName, headers, rows) {
  const cell = (value, header = false) => {
    const text = value === null || value === undefined ? '' : String(value);
    const type = typeof value === 'number' && Number.isFinite(value) ? 'Number' : 'String';
    return `<Cell${header ? ' ss:StyleID="Header"' : ''}><Data ss:Type="${type}">${xmlEscape(text)}</Data></Cell>`;
  };
  const body = [headers, ...rows]
    .map((row) => `<Row>${row.map((value, index) => cell(value, index === 0 && row === headers)).join('')}</Row>`)
    .join('');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#E8EDF4" ss:Pattern="Solid"/></Style>
 </Styles>
 <Worksheet ss:Name="${xmlEscape(sheetName)}">
  <Table>${body}</Table>
 </Worksheet>
</Workbook>`;
}

function safeName(value) {
  return String(value || '').replace(/[^a-z0-9_-]/gi, '');
}

module.exports = function registerExportRoutes(app, db) {
  app.get('/api/export/:dataset.:format', auth, requireCentral(), (req, res, next) => {
    try {
      const dataset = DATASETS[safeName(req.params.dataset)];
      if (!dataset) {
        return res.status(404).json({ error: 'Unknown export dataset.', requestId: req.id });
      }
      const format = assertEnum(String(req.params.format).toLowerCase(), ['csv', 'xls'], 'format');
      const rows = dataset.rows(db, req.query);
      const stamp = new Date().toISOString().slice(0, 10);

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${dataset.filename}-${stamp}.csv"`,
        );
        return res.send(toCsv(dataset.headers, rows));
      }

      res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${dataset.filename}-${stamp}.xls"`,
      );
      return res.send(toSpreadsheetXml(dataset.filename, dataset.headers, rows));
    } catch (err) {
      return next(err);
    }
  });

  // Convenience aliases kept for older links.
  app.get('/api/export/leads.csv', auth, requireCentral(), (req, res) => {
    const rows = DATASETS.leads.rows(db, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kryston-leads.csv"');
    res.send(toCsv(DATASETS.leads.headers, rows));
  });
  app.get('/api/export/tasks.csv', auth, requireCentral(), (req, res) => {
    const rows = DATASETS.tasks.rows(db, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kryston-tasks.csv"');
    res.send(toCsv(DATASETS.tasks.headers, rows));
  });
  app.get('/api/export/timeline.csv', auth, requireCentral(), (req, res) => {
    const rows = DATASETS.timeline.rows(db, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kryston-lead-timeline.csv"');
    res.send(toCsv(DATASETS.timeline.headers, rows));
  });
};
