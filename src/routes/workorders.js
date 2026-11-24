/**
 * Work order finalisation and project handoff.
 *
 * Sales Manager submits a commercial work order after quotation approval. It
 * stays Pending Admin Approval until Admin Desk assigns a PM and Site Engineer,
 * at which point the project is created and handed off.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const {
  requireFields,
  sanitizeText,
  toNumber,
  isIsoDate,
  validate,
  z,
} = require('../middleware/validate');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { generateId } = require('../lib/id-generator');
const { canTransition } = require('../lib/state-machine');
const { audit, notify, notifyCentral, logAction } = require('../lib/audit-notify');
const { isAdvanceCleared } = require('../lib/services/billing-service');

function canViewCommercial(user) {
  if (!user) return false;
  return isCentral(user) || ['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'].includes(user.role);
}

function sanitizeCommercial(wo, user) {
  if (!wo || canViewCommercial(user)) return wo;
  return {
    ...wo,
    amount: null,
  };
}

const milestoneItemSchema = z.union([
  z.string().trim().max(200),
  z.object({
    title: z.string().trim().max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    weightage_percent: z.coerce.number().min(0).max(100).optional().nullable(),
    target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    status: z.enum(['Pending', 'In Progress', 'Completed', 'Delayed']).optional().nullable(),
  }),
]);

const createWorkOrderSchema = z.object({
  lead_id: z.string().trim().min(1, 'Lead ID is required.'),
  quotation_id: z.string().trim().optional().nullable(),
  amount: z.coerce.number().positive('Work order amount must be greater than zero.'),
  customer_approval_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'customer_approval_date must be YYYY-MM-DD.'),
  details: z.string().trim().max(8000).optional().nullable(),
  documents: z.string().trim().max(4000).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const approveWorkOrderSchema = z.object({
  pm_id: z.string().trim().min(1, 'Select a Project Manager.'),
  site_engineer_id: z.string().trim().min(1, 'Select a Site Engineer.'),
  target_completion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  milestones: z.union([z.array(milestoneItemSchema), z.string()]).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const DEFAULT_MILESTONES = [
  'Site mobilization',
  'Demolition and civil works',
  'Electrical and MEP rough-in',
  'Flooring and ceiling',
  'Interior joinery and glazing',
  'Handover and snag closure',
];

function parseMilestones(input) {
  let raw = [];
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === 'string' && input.trim()) {
    raw = input
      .split(/\r?\n|,/)
      .map((title) => title.trim())
      .filter(Boolean);
  }
  if (!raw.length) raw = DEFAULT_MILESTONES;

  return raw.slice(0, 40).map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        title: entry.slice(0, 200),
        description: null,
        weightage_percent: null,
        target_date: null,
        status: 'Pending',
      };
    }
    return {
      title: sanitizeText(entry.title, 200) || `Milestone ${index + 1}`,
      description: sanitizeText(entry.description, 2000),
      weightage_percent: toNumber(entry.weightage_percent, null),
      target_date: entry.target_date && isIsoDate(entry.target_date) ? entry.target_date : null,
      status: ['Pending', 'In Progress', 'Completed', 'Delayed'].includes(entry.status)
        ? entry.status
        : 'Pending',
    };
  });
}

module.exports = function registerWorkOrderRoutes(app, db) {
  app.get('/api/work-orders', auth, (req, res) => {
    const conditions = [];
    const params = [];
    if (!isCentral(req.user)) {
      conditions.push('(w.created_by = ? OR l.assigned_bdm = ? OR p.project_manager = ? OR p.site_engineer = ?)');
      params.push(req.user.id, req.user.id, req.user.id, req.user.id);
    }
    if (req.query.status) {
      conditions.push('w.status = ?');
      params.push(String(req.query.status));
    }

    const rows = db
      .prepare(
        `SELECT w.*,
                l.customer_name, l.phone AS customer_phone, l.location AS customer_location,
                l.stage AS lead_stage, l.assigned_bdm,
                p.id AS project_id, p.status AS project_status, p.progress AS project_progress,
                creator.name AS creator_name, approver.name AS approver_name,
                q.status AS quotation_status
         FROM work_orders w
         JOIN leads l ON l.id = w.lead_id
         LEFT JOIN quotations q ON q.id = w.quotation_id
         LEFT JOIN projects p ON p.work_order_id = w.id
         LEFT JOIN employees creator ON creator.id = w.created_by
         LEFT JOIN employees approver ON approver.id = w.approved_by
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY w.created_at DESC
         LIMIT 500`,
      )
      .all(...params);
    res.json(rows.map((row) => sanitizeCommercial(row, req.user)));
  });

  app.get('/api/work-orders/:id', auth, (req, res, next) => {
    try {
      const workOrder = db
        .prepare(
          `SELECT w.*, l.customer_name, l.phone AS customer_phone, l.location AS customer_location,
                  l.stage AS lead_stage, l.assigned_bdm,
                  p.id AS project_id, p.status AS project_status, p.progress AS project_progress,
                  p.project_manager, p.site_engineer,
                  creator.name AS creator_name, approver.name AS approver_name
           FROM work_orders w
           JOIN leads l ON l.id = w.lead_id
           LEFT JOIN projects p ON p.work_order_id = w.id
           LEFT JOIN employees creator ON creator.id = w.created_by
           LEFT JOIN employees approver ON approver.id = w.approved_by
           WHERE w.id = ?`,
        )
        .get(req.params.id);
      if (!workOrder) throw new NotFoundError('Work order not found.');
      if (!isCentral(req.user)) {
        const related =
          workOrder.created_by === req.user.id ||
          workOrder.assigned_bdm === req.user.id ||
          workOrder.project_manager === req.user.id ||
          workOrder.site_engineer === req.user.id;
        if (!related) throw new ForbiddenError('You cannot access this work order.');
      }
      res.json(sanitizeCommercial(workOrder, req.user));
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/work-orders',
    auth,
    validate({ body: createWorkOrderSchema }),
    (req, res, next) => {
      try {
        if (req.user.role !== 'SALES_MANAGER') {
          throw new ForbiddenError('Only a Sales Manager can submit a work order.');
        }
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.body.lead_id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        if (lead.stage !== 'Approved') {
          throw new ConflictError('The lead must be in the Approved stage before a work order can be submitted.');
        }
        if (db.prepare('SELECT 1 FROM work_orders WHERE lead_id = ?').get(lead.id)) {
          throw new ConflictError('A work order already exists for this lead.');
        }

        const amount = toNumber(req.body.amount, null);
        if (amount === null || amount <= 0) {
          throw new ValidationError('Enter a work order amount greater than zero.');
        }
        if (!isIsoDate(req.body.customer_approval_date)) {
          throw new ValidationError('customer_approval_date must use the YYYY-MM-DD format.');
        }

        let quotation = null;
        if (req.body.quotation_id) {
          quotation = db
            .prepare('SELECT * FROM quotations WHERE id = ? AND lead_id = ?')
            .get(req.body.quotation_id, lead.id);
          if (!quotation) throw new ValidationError('The selected quotation does not belong to this lead.');
          if (quotation.status !== 'Approved') {
            throw new ConflictError('Only an approved quotation can back a work order.');
          }
        } else {
          quotation = db
            .prepare(
              `SELECT * FROM quotations WHERE lead_id = ? AND status = 'Approved'
               ORDER BY version DESC LIMIT 1`,
            )
            .get(lead.id);
          if (!quotation) {
            throw new ConflictError('An approved quotation is required before submitting a work order.');
          }
        }

        if (!canTransition(lead.stage, 'Work Order Pending Admin Approval', req.user.role)) {
          throw new ForbiddenError('This role cannot submit a work order for the current lead stage.');
        }

        const id = generateId(db, 'KRY-WO', 'work_orders');

        db.transaction(() => {
          db.prepare(
            `INSERT INTO work_orders
              (id, lead_id, quotation_id, amount, customer_approval_date, details, documents,
               status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending Admin Approval', ?)`,
          ).run(
            id,
            lead.id,
            quotation.id,
            amount,
            req.body.customer_approval_date,
            sanitizeText(req.body.details, 8000),
            sanitizeText(req.body.documents, 4000),
            req.user.id,
          );

          db.prepare(
            `UPDATE leads SET stage = 'Work Order Pending Admin Approval', wo_value = ?,
                              updated_at = datetime('now'), version = version + 1 WHERE id = ?`,
          ).run(amount, lead.id);

          logAction(
            db,
            lead.id,
            'WORK_ORDER_SUBMITTED',
            req.user.id,
            lead.assigned_bdm,
            'Sales',
            `Work Order ${id} submitted for ₹${amount.toLocaleString('en-IN')} and awaiting Admin approval.`,
            lead.stage,
            'Work Order Pending Admin Approval',
          );
          notifyCentral(
            db,
            'WO_PENDING_APPROVAL',
            `Work Order ${id} for ${lead.customer_name} is awaiting Admin approval (₹${amount.toLocaleString('en-IN')}).`,
            '#workorders',
            'work_order',
            id,
          );
          audit(
            db,
            req.user.id,
            'SUBMIT_WO',
            'work_order',
            id,
            `Lead ${lead.id}, amount ${amount}, quotation ${quotation.id}`,
            null,
            { status: 'Pending Admin Approval' },
            req.ip,
          );
        })();

        res.status(201).json({ ok: true, id, status: 'Pending Admin Approval' });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/work-orders/:id/approve',
    auth,
    requireCentral(),
    validate({ body: approveWorkOrderSchema }),
    (req, res, next) => {
      try {
        const workOrder = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.id);
        if (!workOrder) throw new NotFoundError('Work order not found.');
        if (workOrder.status !== 'Pending Admin Approval') {
          throw new ConflictError('Only a work order pending Admin approval can be approved.');
        }
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(workOrder.lead_id);
        if (!lead) throw new NotFoundError('Lead not found.');

        const pmId = req.body.pm_id;
        const engineerId = req.body.site_engineer_id;
        const pm = db
          .prepare("SELECT id, name, active, role FROM employees WHERE id = ? AND role = 'PROJECT_MANAGER'")
          .get(pmId);
        const engineer = db
          .prepare("SELECT id, name, active, role FROM employees WHERE id = ? AND role = 'SITE_ENGINEER'")
          .get(engineerId);
        if (!pm || !pm.active) throw new ValidationError('Choose an active Project Manager.');
        if (!engineer || !engineer.active) throw new ValidationError('Choose an active Site Engineer.');

        const targetCompletion =
          req.body.target_completion && isIsoDate(req.body.target_completion)
            ? req.body.target_completion
            : null;
        const milestoneList = parseMilestones(req.body.milestones);

        // P4 Advance payment gate check
        const hasMilestones = db.prepare('SELECT 1 FROM payment_milestones WHERE work_order_id = ? LIMIT 1').get(workOrder.id);
        const hasInvoices = db.prepare('SELECT 1 FROM invoices WHERE work_order_id = ? LIMIT 1').get(workOrder.id);
        if ((hasMilestones || hasInvoices) && !isAdvanceCleared(db, workOrder.id)) {
          throw new ConflictError('Advance invoice must be paid and cleared before project execution handoff.');
        }

        const projectId = generateId(db, 'KRY-PROJ', 'projects');

        db.transaction(() => {
          const woRes = db.prepare(
            `UPDATE work_orders
             SET status = 'Finalized', approved_by = ?, approved_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE id = ? AND status = 'Pending Admin Approval'`,
          ).run(req.user.id, workOrder.id);
          if (woRes.changes === 0) {
            throw new ConflictError('This work order was already updated or approved.');
          }

          const leadRes = db.prepare(
            `UPDATE leads
             SET stage = 'Work Order Finalized', wo_value = ?, assigned_pm = ?, assigned_engineer = ?,
                 current_owner = ?, updated_at = datetime('now')
             WHERE id = ? AND stage = ?`,
          ).run(workOrder.amount, pm.id, engineer.id, pm.id, lead.id, lead.stage);
          if (leadRes.changes === 0) {
            throw new ConflictError('The lead stage was modified concurrently. Please refresh.');
          }

        logAction(
          db,
          lead.id,
          'WORK_ORDER_FINALIZED',
          req.user.id,
          pm.id,
          'Projects',
          `Work Order ${workOrder.id} finalized at ₹${workOrder.amount.toLocaleString('en-IN')}.`,
          lead.stage,
          'Work Order Finalized',
        );

        db.prepare(
          `UPDATE leads SET stage = 'Project Handoff', current_owner = ?, updated_at = datetime('now'), version = version + 1
           WHERE id = ?`,
        ).run(pm.id, lead.id);

        logAction(
          db,
          lead.id,
          'PROJECT_HANDOFF',
          req.user.id,
          pm.id,
          'Projects',
          `Project ${projectId} handed off to ${pm.name} (PM) and ${engineer.name} (Site Engineer).`,
          'Work Order Finalized',
          'Project Handoff',
        );

        db.prepare(
          `INSERT INTO projects
            (id, work_order_id, lead_id, project_manager, site_engineer, status,
             milestones, progress, start_date, target_completion, handoff_by, handoff_at)
           VALUES (?, ?, ?, ?, ?, 'Planning', ?, 0, date('now'), ?, ?, datetime('now'))`,
        ).run(
          projectId,
          workOrder.id,
          lead.id,
          pm.id,
          engineer.id,
          milestoneList.map((m) => m.title).join(', '),
          targetCompletion,
          req.user.id,
        );

        const equalWeight = Math.round((100 / milestoneList.length) * 100) / 100;
        const insertMilestone = db.prepare(
          `INSERT INTO project_milestones
            (project_id, title, description, order_index, weightage_percent, target_date, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        milestoneList.forEach((milestone, index) => {
          insertMilestone.run(
            projectId,
            milestone.title,
            milestone.description,
            index + 1,
            milestone.weightage_percent === null ? equalWeight : milestone.weightage_percent,
            milestone.target_date || targetCompletion,
            milestone.status,
          );
        });

        notify(
          db,
          pm.id,
          'WO_FINALIZED',
          `Project ${projectId} handed off to you for execution (${lead.customer_name}, ₹${workOrder.amount.toLocaleString('en-IN')}).`,
          '#projects',
          'project',
          projectId,
        );
        notify(
          db,
          engineer.id,
          'WO_FINALIZED',
          `You are the Site Engineer for project ${projectId} (${lead.customer_name}).`,
          '#projects',
          'project',
          projectId,
        );
        notifyCentral(
          db,
          'WO_FINALIZED',
          `Work Order ${workOrder.id} approved. Project ${projectId} created and handed off.`,
          '#projects',
          'project',
          projectId,
        );
        audit(
          db,
          req.user.id,
          'APPROVE_WO',
          'work_order',
          workOrder.id,
          `Project ${projectId} created; PM ${pm.name}, Site Engineer ${engineer.name}`,
          { status: 'Pending Admin Approval' },
          { status: 'Finalized', project_id: projectId },
          req.ip,
        );
      })();

      res.status(201).json({
        ok: true,
        work_order_id: workOrder.id,
        project_id: projectId,
        amount: workOrder.amount,
      });
    } catch (err) {
      next(err);
    }
  });
};
