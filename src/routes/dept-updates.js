/**
 * Specialised spoke submissions: site inspections (Site Engineer) and design
 * versions (Architect). Both return to Admin Desk through the assigned task.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireRole, requireCentral, isCentral } = require('../middleware/rbac');
const {
  requireFields,
  sanitizeText,
  toBool,
  toInt,
  isIsoDate,
  validate,
  z,
} = require('../middleware/validate');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../middleware/errors');
const {
  audit,
  notify,
  notifyCentral,
  logAction,
  firstActiveAdminId,
} = require('../lib/audit-notify');

const DESIGN_STATUSES = ['Draft', 'Submitted', 'Revision Needed', 'Approved', 'Rejected'];

const siteVisitSchema = z
  .object({
    lead_id: z.string().trim().min(1, 'Lead ID is required.'),
    task_id: z.union([z.string().trim().min(1), z.number()]),
    visit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'visit_date must use YYYY-MM-DD format.'),
    technical_report: z.string().trim().min(1, 'Technical report is required.').max(8000),
    visit_time: z.string().trim().max(40).optional().nullable(),
    site_condition: z.string().trim().max(2000).optional().nullable(),
    measurements: z.string().trim().max(4000).optional().nullable(),
    customer_present: z.union([z.boolean(), z.number()]).optional().nullable(),
    customer_feedback: z.string().trim().max(4000).optional().nullable(),
    recommendation: z.string().trim().max(4000).optional().nullable(),
    estimated_cost: z.union([z.number(), z.string()]).optional().nullable(),
    civil_cost: z.union([z.number(), z.string()]).optional().nullable(),
    interior_cost: z.union([z.number(), z.string()]).optional().nullable(),
    mep_cost: z.union([z.number(), z.string()]).optional().nullable(),
    labor_logistics_cost: z.union([z.number(), z.string()]).optional().nullable(),
    estimated_timeline: z.string().trim().max(100).optional().nullable(),
    site_risk_level: z.string().trim().max(50).optional().nullable(),
    scope_details: z.string().trim().max(4000).optional().nullable(),
    sales_advice: z.string().trim().max(4000).optional().nullable(),
  })
  .strict();

const designSchema = z
  .object({
    lead_id: z.string().trim().min(1, 'Lead ID is required.'),
    task_id: z.union([z.string().trim().min(1), z.number()]),
    description: z.string().trim().min(1, 'Design description is required.').max(8000),
    design_type: z.string().trim().max(120).optional().nullable(),
    file_url: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

const designPatchSchema = z
  .object({
    status: z.enum(DESIGN_STATUSES),
  })
  .strict();

module.exports = function registerDepartmentUpdateRoutes(app, db) {
  // ---------------------------------------------------------------------------
  // Site visits
  // ---------------------------------------------------------------------------
  app.post(
    '/api/site-visits',
    auth,
    requireRole('SITE_ENGINEER'),
    validate({ body: siteVisitSchema }),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.body.lead_id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        const task = db
          .prepare(
            `SELECT * FROM tasks
             WHERE id = ? AND lead_id = ? AND assigned_to = ? AND department = 'Technical'
               AND status IN ('Assigned','In Progress')`,
          )
          .get(req.body.task_id, lead.id, req.user.id);
        if (!task) {
          throw new ForbiddenError('Submit this inspection through your assigned technical task.');
        }
        const allowedStages = [
          'Routed to Engineering',
          'Site Visit Scheduled',
          'Approved',
          'Work Order Pending Admin Approval',
          'Work Order Finalized',
          'Project Handoff',
          'In Progress',
        ];
        if (!allowedStages.includes(lead.stage)) {
          throw new ConflictError(
            `The lead is currently "${lead.stage}" and cannot accept a site inspection.`,
          );
        }
        if (!isIsoDate(req.body.visit_date)) {
          throw new ValidationError('visit_date must use the YYYY-MM-DD format.');
        }

        const technicalReport = sanitizeText(req.body.technical_report, 8000);
        if (!technicalReport) throw new ValidationError('The technical report is required.');

        const estimatedCost = Number(req.body.estimated_cost) || 0;
        const civilCost = Number(req.body.civil_cost) || 0;
        const interiorCost = Number(req.body.interior_cost) || 0;
        const mepCost = Number(req.body.mep_cost) || 0;
        const laborLogisticsCost = Number(req.body.labor_logistics_cost) || 0;
        const estimatedTimeline = sanitizeText(req.body.estimated_timeline, 100);
        const siteRiskLevel = sanitizeText(req.body.site_risk_level || 'Low', 50);
        const scopeDetails = sanitizeText(req.body.scope_details, 4000);
        const salesAdvice = sanitizeText(req.body.sales_advice, 4000);

        const siteVisitId = db.transaction(() => {
          const inserted = db
            .prepare(
              `INSERT INTO site_visits
                (lead_id, task_id, engineer_id, visit_date, visit_time, site_condition,
                 technical_report, measurements, customer_present, customer_feedback, recommendation,
                 estimated_cost, civil_cost, interior_cost, mep_cost, labor_logistics_cost,
                 estimated_timeline, site_risk_level, scope_details, sales_advice)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              lead.id,
              task.id,
              req.user.id,
              req.body.visit_date,
              sanitizeText(req.body.visit_time, 40),
              sanitizeText(req.body.site_condition, 2000),
              technicalReport,
              sanitizeText(req.body.measurements, 4000),
              toBool(req.body.customer_present, true) ? 1 : 0,
              sanitizeText(req.body.customer_feedback, 4000),
              sanitizeText(req.body.recommendation, 4000),
              estimatedCost,
              civilCost,
              interiorCost,
              mepCost,
              laborLogisticsCost,
              estimatedTimeline,
              siteRiskLevel,
              scopeDetails,
              salesAdvice,
            );

          const costSummary =
            estimatedCost > 0
              ? ` [Est. Construction Cost: ₹${estimatedCost.toLocaleString('en-IN')}]`
              : '';
          db.prepare(
            `UPDATE tasks SET status = 'Submitted', response = ?,
                              contact_status = 'CONTACTED',
                              first_contacted_at = COALESCE(first_contacted_at, datetime('now')),
                              last_contact_at = datetime('now'),
                              submitted_at = datetime('now'), updated_at = datetime('now'),
                              version = version + 1
             WHERE id = ?`,
          ).run(
            `Site inspection on ${req.body.visit_date}:${costSummary} ${technicalReport}`.slice(
              0,
              4000,
            ),
            task.id,
          );

          const adminId = firstActiveAdminId(db);
          const nextStage = ['In Progress', 'Project Handoff', 'Work Order Finalized'].includes(lead.stage)
            ? lead.stage
            : 'Update Received';
          db.prepare(
            `UPDATE leads SET stage = ?, current_owner = ?,
                              estimated_cost = CASE WHEN ? > 0 THEN ? ELSE estimated_cost END,
                              updated_at = datetime('now'), version = version + 1
             WHERE id = ?`,
          ).run(nextStage, adminId, estimatedCost, estimatedCost, lead.id);

          const costActionNote =
            estimatedCost > 0 ? ` (Est. Cost: ₹${estimatedCost.toLocaleString('en-IN')})` : '';
          logAction(
            db,
            lead.id,
            'DEPT_UPDATE',
            req.user.id,
            adminId,
            'Technical',
            `Site Engineer ${req.user.name} submitted inspection & cost report${costActionNote}: ${technicalReport}`,
            lead.stage,
            nextStage,
          );
          notifyCentral(
            db,
            'UPDATE_SUBMITTED',
            `Technical inspection & cost report${costActionNote} submitted by ${req.user.name} for ${lead.id}. Ready for Admin review & routing to Sales.`,
            '#taskboard',
            'lead',
            lead.id,
          );
          audit(
            db,
            req.user.id,
            'SUBMIT_SITE_VISIT',
            'site_visit',
            String(inserted.lastInsertRowid),
            `Lead ${lead.id}, task ${task.id}`,
            null,
            null,
            req.ip,
          );
          return inserted.lastInsertRowid;
        })();

        res.status(201).json({
          ok: true,
          lead_id: lead.id,
          stage: 'Update Received',
          site_visit_id: Number(siteVisitId),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get('/api/site-visits', auth, (req, res) => {
    const conditions = [];
    const params = [];
    if (req.query.lead_id) {
      conditions.push('s.lead_id = ?');
      params.push(String(req.query.lead_id));
    }
    if (!isCentral(req.user)) {
      conditions.push('s.engineer_id = ?');
      params.push(req.user.id);
    }
    const limit = Math.min(Math.max(toInt(req.query.limit, 200) || 200, 1), 500);
    const rows = db
      .prepare(
        `SELECT s.*, e.name AS engineer_name, l.customer_name, l.phone AS customer_phone
         FROM site_visits s
         LEFT JOIN employees e ON e.id = s.engineer_id
         LEFT JOIN leads l ON l.id = s.lead_id
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY s.visit_date DESC, s.created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);
    res.json(rows);
  });

  // ---------------------------------------------------------------------------
  // Designs
  // ---------------------------------------------------------------------------
  app.post(
    '/api/designs',
    auth,
    requireRole('ARCHITECT'),
    validate({ body: designSchema }),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.body.lead_id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        const task = db
          .prepare(
            `SELECT * FROM tasks
             WHERE id = ? AND lead_id = ? AND assigned_to = ? AND department = 'Design'
               AND status IN ('Assigned','In Progress')`,
          )
          .get(req.body.task_id, lead.id, req.user.id);
        if (!task) {
          throw new ForbiddenError('Submit this design through your assigned design task.');
        }
        if (!['Routed to Design', 'Design In Progress'].includes(lead.stage)) {
          throw new ConflictError(
            `The lead is currently "${lead.stage}" and cannot accept a design version.`,
          );
        }

        const description = sanitizeText(req.body.description, 8000);
        if (!description) throw new ValidationError('A design description is required.');
        const designType = sanitizeText(req.body.design_type, 120) || '2D Floor Plan';
        const fileUrl = sanitizeText(req.body.file_url, 2000);

        const last = db
          .prepare('SELECT MAX(version) AS max_version FROM designs WHERE lead_id = ?')
          .get(lead.id);
        const version = (Number(last && last.max_version) || 0) + 1;

        const designId = db.transaction(() => {
          const inserted = db
            .prepare(
              `INSERT INTO designs
                (lead_id, task_id, architect_id, version, design_type, description, file_url, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'Submitted')`,
            )
            .run(lead.id, task.id, req.user.id, version, designType, description, fileUrl);

          db.prepare(
            `UPDATE tasks SET status = 'Submitted', response = ?,
                              contact_status = 'CONTACTED',
                              first_contacted_at = COALESCE(first_contacted_at, datetime('now')),
                              last_contact_at = datetime('now'),
                              submitted_at = datetime('now'), updated_at = datetime('now'),
                              version = version + 1
             WHERE id = ?`,
          ).run(`Design v${version} (${designType}): ${description}`.slice(0, 4000), task.id);

          const adminId = firstActiveAdminId(db);
          db.prepare(
            `UPDATE leads SET stage = 'Update Received', current_owner = ?, updated_at = datetime('now'),
                              version = version + 1
             WHERE id = ?`,
          ).run(adminId, lead.id);

          logAction(
            db,
            lead.id,
            'DEPT_UPDATE',
            req.user.id,
            adminId,
            'Design',
            `Architect ${req.user.name} submitted Design v${version} (${designType}): ${description}`,
            lead.stage,
            'Update Received',
          );
          notifyCentral(
            db,
            'UPDATE_SUBMITTED',
            `Design v${version} submitted by ${req.user.name} for ${lead.id}.`,
            '#taskboard',
            'lead',
            lead.id,
          );
          audit(
            db,
            req.user.id,
            'SUBMIT_DESIGN',
            'design',
            String(inserted.lastInsertRowid),
            `Lead ${lead.id}, version ${version}`,
            null,
            null,
            req.ip,
          );
          return inserted.lastInsertRowid;
        })();

        res.status(201).json({
          ok: true,
          lead_id: lead.id,
          version,
          stage: 'Update Received',
          design_id: Number(designId),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get('/api/designs', auth, (req, res) => {
    const conditions = [];
    const params = [];
    if (req.query.lead_id) {
      conditions.push('d.lead_id = ?');
      params.push(String(req.query.lead_id));
    }
    if (!isCentral(req.user)) {
      conditions.push('d.architect_id = ?');
      params.push(req.user.id);
    }
    const limit = Math.min(Math.max(toInt(req.query.limit, 200) || 200, 1), 500);
    const rows = db
      .prepare(
        `SELECT d.*, e.name AS architect_name, l.customer_name
         FROM designs d
         LEFT JOIN employees e ON e.id = d.architect_id
         LEFT JOIN leads l ON l.id = d.lead_id
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY d.created_at DESC, d.version DESC
         LIMIT ?`,
      )
      .all(...params, limit);
    res.json(rows);
  });

  app.patch(
    '/api/designs/:id',
    auth,
    requireCentral(),
    validate({ body: designPatchSchema }),
    (req, res, next) => {
      try {
        const design = db.prepare('SELECT * FROM designs WHERE id = ?').get(req.params.id);
        if (!design) throw new NotFoundError('Design not found.');
        const status = String(req.body.status || '');
        if (!DESIGN_STATUSES.includes(status)) {
          throw new ValidationError(`status must be one of: ${DESIGN_STATUSES.join(', ')}.`);
        }
        const remarks = sanitizeText(req.body.remarks, 4000);
        if (['Revision Needed', 'Rejected'].includes(status) && !remarks) {
          throw new ValidationError(
            'Remarks are required when requesting a revision or rejecting a design.',
          );
        }

        db.transaction(() => {
          db.prepare(
            `UPDATE designs
           SET status = ?, review_remarks = ?,
               approved_by = CASE WHEN ? = 'Approved' THEN ? ELSE approved_by END,
               approved_at = CASE WHEN ? = 'Approved' THEN datetime('now') ELSE approved_at END
           WHERE id = ?`,
          ).run(status, remarks, status, req.user.id, status, design.id);

          if (design.lead_id) {
            logAction(
              db,
              design.lead_id,
              'ADMIN_REVIEW',
              req.user.id,
              design.architect_id,
              'Design',
              `Admin Desk marked Design v${design.version} as ${status}.${remarks ? ` ${remarks}` : ''}`,
              null,
              null,
            );
          }

          notify(
            db,
            design.architect_id,
            'TASK_REVIEWED',
            `Design v${design.version} was marked ${status} by Admin Desk.${remarks ? ` ${remarks}` : ''}`,
            '#designs',
            'design',
            design.id,
          );
          audit(
            db,
            req.user.id,
            'REVIEW_DESIGN',
            'design',
            design.id,
            `Status ${status}${remarks ? `: ${remarks}` : ''}`,
            { status: design.status },
            { status },
            req.ip,
          );
        })();

        res.json({ ok: true, status });
      } catch (err) {
        next(err);
      }
    },
  );
};
