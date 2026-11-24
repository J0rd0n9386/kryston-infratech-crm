/**
 * Lead intake, assignment, routing and the immutable lead timeline.
 *
 * This is the hub-and-spoke core: Admin Desk owns every handoff. A spoke only
 * receives a task, submits findings back to Admin Desk and never routes work to
 * another department.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral, canAccessLead, SALES_MANAGER_STAGES } = require('../middleware/rbac');
const {
  z,
  validate,
  requireFields,
  sanitizeText,
  normalizePhone,
  isValidPhone,
  isValidEmail,
  assertEnum,
  toNumber,
  toInt,
  isIsoDate,
} = require('../middleware/validate');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { generateId } = require('../lib/id-generator');
const { canTransition, getAllowedTransitions, isOpenStage, checkStageGate } = require('../lib/state-machine');
const { getSlaStatus } = require('../lib/sla');
const {
  audit,
  notify,
  notifyCentral,
  logAction,
  firstActiveAdminId,
} = require('../lib/audit-notify');
const { createReminder, cancelForLead } = require('../lib/services/reminder-service');
const { resolveAutoRouting } = require('../lib/services/routing-service');
const { addDaysLocal } = require('../lib/clock');
const { PRIORITIES } = require('../db/schema');

const createLeadSchema = z
  .object({
    channel: z.enum(['Online', 'Offline']).optional(),
    source: z.string().min(1).max(80),
    customer_name: z.string().min(1).max(160),
    phone: z.string().min(1).max(30),
    email: z.string().email().optional().nullable().or(z.literal('')),
    location: z.string().max(160).optional().nullable(),
    area: z.string().max(80).optional().nullable(),
    requirement: z.string().max(4000).optional().nullable(),
    budget_range: z.string().max(80).optional().nullable(),
    timeline: z.string().max(80).optional().nullable(),
    priority: z.enum(PRIORITIES).optional(),
    project_type: z.enum(['construction', 'interior', 'architecture']).optional().nullable(),
    city: z.string().max(100).optional().nullable(),
    area_sqft: z.coerce.number().positive().optional().nullable(),
    budget_band: z.string().max(100).optional().nullable(),
    auto_route: z.coerce.boolean().optional().default(false),
  })
  .strict();

const updateLeadSchema = z
  .object({
    customer_name: z.string().min(1).max(160).optional(),
    phone: z.string().min(1).max(30).optional(),
    email: z.string().email().optional().nullable().or(z.literal('')),
    location: z.string().max(160).optional().nullable(),
    area: z.string().max(80).optional().nullable(),
    requirement: z.string().max(4000).optional().nullable(),
    budget_range: z.string().max(80).optional().nullable(),
    timeline: z.string().max(80).optional().nullable(),
    priority: z.enum(PRIORITIES).optional(),
    project_type: z.enum(['construction', 'interior', 'architecture']).optional().nullable(),
    city: z.string().max(100).optional().nullable(),
    area_sqft: z.coerce.number().positive().optional().nullable(),
    budget_band: z.string().max(100).optional().nullable(),
    expected_version: z.coerce.number().int().positive().optional(),
  })
  .strict();

const assignTelecallerSchema = z
  .object({
    telecaller_id: z.string().min(1),
    instructions: z.string().max(4000).optional().nullable(),
    reminder_id: z.union([z.number(), z.string()]).optional().nullable(),
    expected_version: z.coerce.number().int().positive().optional(),
  })
  .strict();

const routeLeadSchema = z
  .object({
    department: z.string().min(1),
    allow_customer_contact: z.boolean().optional().default(false),
    assigned_to: z.string().min(1),
    task_type: z.string().min(1),
    brief: z.string().min(1).max(4000),
    sla_hours: z.union([z.number(), z.string()]).optional(),
    due_date: z.string().optional().nullable(),
    reminder_id: z.union([z.number(), z.string()]).optional().nullable(),
    expected_version: z.coerce.number().int().positive().optional(),
  })
  .strict();

const advanceQuotationSchema = z
  .object({
    expected_version: z.coerce.number().int().positive().optional(),
  })
  .strict();

const LOST_REASONS = ['Price', 'Competitor', 'Timeline', 'No Response', 'Out of Area', 'Other'];

const updateStageSchema = z
  .object({
    stage: z.string().min(1),
    lost_reason: z.string().max(2000).optional().nullable(),
    lost_notes: z.string().max(4000).optional().nullable(),
    reason: z.string().max(2000).optional().nullable(),
    remarks: z.string().max(2000).optional().nullable(),
    reminder_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'reminder_date must be YYYY-MM-DD').optional().nullable(),
    expected_version: z.coerce.number().int().positive().optional(),
  })
  .strict();

const mergeLeadSchema = z
  .object({
    duplicate_lead_id: z.string().trim().min(1, 'Duplicate lead ID is required.'),
    reason: z.string().trim().min(1, 'Merge reason is required.').max(2000),
    expected_version: z.coerce.number().int().positive().optional(),
  })
  .strict();

const dismissDuplicateSchema = z
  .object({
    dismiss_reason: z.string().trim().max(2000).optional().nullable(),
    expected_version: z.coerce.number().int().positive().optional(),
  })
  .strict();

const noteSchema = z
  .object({
    remarks: z.string().min(1).max(4000),
  })
  .strict();

function checkOptimisticLock(currentVersion, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== null) {
    if (Number(expectedVersion) !== Number(currentVersion)) {
      throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
    }
  }
}

const DEPARTMENTS = Object.freeze({
  Sales: {
    roles: ['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'],
    stage: 'Routed to Sales',
    column: 'assigned_bdm',
    taskTypes: ['SALES_REVIEW', 'QUOTATION_PROPOSAL'],
  },
  Technical: {
    roles: ['SITE_ENGINEER'],
    stage: 'Routed to Engineering',
    column: 'assigned_engineer',
    taskTypes: ['SITE_VISIT', 'SITE_INSPECTION'],
  },
  Design: {
    roles: ['ARCHITECT'],
    stage: 'Routed to Design',
    column: 'assigned_architect',
    taskTypes: ['DESIGN_PREPARATION'],
  },
  Purchase: {
    roles: ['PURCHASE'],
    stage: 'Routed to Purchase',
    column: null,
    taskTypes: ['MATERIAL_CHECK', 'MATERIAL_PROCUREMENT', 'VENDOR_COSTING'],
  },
  Accounts: {
    roles: ['ACCOUNTS'],
    stage: 'Routed to Accounts',
    column: null,
    taskTypes: ['COSTING_ESTIMATE'],
  },
});

const LEAD_SELECT = `
  SELECT l.*,
         tc.name AS telecaller_name,
         bdm.name AS bdm_name,
         eng.name AS engineer_name,
         arc.name AS architect_name,
         pm.name AS pm_name,
         creator.name AS creator_name,
         owner.name AS owner_name
  FROM leads l
  LEFT JOIN employees tc ON tc.id = l.assigned_telecaller
  LEFT JOIN employees bdm ON bdm.id = l.assigned_bdm
  LEFT JOIN employees eng ON eng.id = l.assigned_engineer
  LEFT JOIN employees arc ON arc.id = l.assigned_architect
  LEFT JOIN employees pm ON pm.id = l.assigned_pm
  LEFT JOIN employees creator ON creator.id = l.created_by
  LEFT JOIN employees owner ON owner.id = l.current_owner
`;

function getLead(db, id) {
  return db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).get(id);
}

function activeTaskCount(db, leadId) {
  return db
    .prepare(
      `SELECT count(*) AS c FROM tasks
       WHERE lead_id = ? AND status IN ('Assigned', 'In Progress') AND task_type != 'RE_ENGAGE'`,
    )
    .get(leadId).c;
}

function submittedTaskCount(db, leadId) {
  return db
    .prepare(
      `SELECT count(*) AS c FROM tasks WHERE lead_id = ? AND status = 'Submitted'`,
    )
    .get(leadId).c;
}

module.exports = function registerLeadRoutes(app, db) {
  app.get('/api/leads', auth, (req, res) => {
    const { limit, offset } = {
      limit: Math.min(Math.max(toInt(req.query.limit, 500) || 500, 1), 1000),
      offset: Math.max(toInt(req.query.offset, 0) || 0, 0),
    };

    const conditions = ['l.deleted_at IS NULL'];
    const params = [];

    if (req.query.q) {
      const tokens = String(req.query.q)
        .trim()
        .replace(/["'*^:()\-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 12)
        .map((word) => `"${word}"*`)
        .join(' ');
      if (tokens) {
        conditions.push('l.id IN (SELECT id FROM leads_fts WHERE leads_fts MATCH ?)');
        params.push(tokens);
      }
    }
    if (req.query.stage) {
      conditions.push('l.stage = ?');
      params.push(String(req.query.stage));
    }
    if (req.query.source) {
      conditions.push('l.source = ?');
      params.push(String(req.query.source));
    }
    if (req.query.priority) {
      conditions.push('l.priority = ?');
      params.push(String(req.query.priority));
    }
    if (req.query.owner) {
      conditions.push('l.current_owner = ?');
      params.push(String(req.query.owner));
    }

    if (!isCentral(req.user)) {
      const assignedClause = `(
        l.assigned_telecaller = ? OR l.assigned_bdm = ? OR l.assigned_engineer = ?
        OR l.assigned_architect = ? OR l.assigned_pm = ? OR l.created_by = ?
        OR l.current_owner = ?
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.assigned_to = ?)
      )`;
      const assignedParams = [
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
        req.user.id,
      ];
      if (req.user.role === 'SALES_MANAGER') {
        conditions.push(
          `(${assignedClause} OR l.stage IN (${SALES_MANAGER_STAGES.map(() => '?').join(', ')}))`,
        );
        params.push(...assignedParams, ...SALES_MANAGER_STAGES);
      } else {
        conditions.push(assignedClause);
        params.push(...assignedParams);
      }
    }

    // Keyset cursor pagination support (created_at, id)
    let cursorCreatedAt = null;
    let cursorId = null;
    if (req.query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(String(req.query.cursor), 'base64').toString('utf8'));
        if (decoded && decoded.created_at && decoded.id) {
          cursorCreatedAt = decoded.created_at;
          cursorId = decoded.id;
        }
      } catch {
        const parts = String(req.query.cursor).split('___');
        if (parts.length === 2) {
          cursorCreatedAt = parts[0];
          cursorId = parts[1];
        }
      }
    }

    if (cursorCreatedAt && cursorId) {
      conditions.push('(l.created_at < ? OR (l.created_at = ? AND l.id < ?))');
      params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
    }

    let sql;
    if (cursorCreatedAt && cursorId) {
      sql = `${LEAD_SELECT} WHERE ${conditions.join(' AND ')}
        ORDER BY l.created_at DESC, l.id DESC LIMIT ?`;
      params.push(limit);
    } else {
      sql = `${LEAD_SELECT} WHERE ${conditions.join(' AND ')}
        ORDER BY l.updated_at DESC, l.id DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
    }

    const rows = db.prepare(sql).all(...params);
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      const nextCursor = Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64');
      res.setHeader('X-Next-Cursor', nextCursor);
      res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    }
    const sanitizedRows = rows.map((lead) => {
      const canSeeCommercial =
        isCentral(req.user) || req.user.role === 'SALES_MANAGER' || lead.assigned_bdm === req.user.id;
      return canSeeCommercial ? lead : { ...lead, wo_value: null };
    });
    res.json(sanitizedRows);
  });

  app.post(
    '/api/leads',
    auth,
    requireCentral(),
    validate({ body: createLeadSchema }),
    requireFields('customer_name', 'phone', 'source'),
    (req, res, next) => {
      try {
        const phone = normalizePhone(req.body.phone);
        if (!isValidPhone(phone)) {
          throw new ValidationError('Enter a valid 10-digit Indian mobile number.');
        }
        const channel = assertEnum(req.body.channel || 'Online', ['Online', 'Offline'], 'channel');
        const priority = assertEnum(req.body.priority || 'Medium', PRIORITIES, 'priority');
        const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
        if (email && !isValidEmail(email)) throw new ValidationError('Enter a valid email address.');

        const phoneDigits = phone.replace(/\D/g, '');
        const phoneNorm = (phoneDigits.length === 12 && phoneDigits.startsWith('91'))
          ? phoneDigits.slice(2)
          : (phoneDigits.length === 11 && phoneDigits.startsWith('0'))
          ? phoneDigits.slice(1)
          : phoneDigits;

        const existing = db
          .prepare(
            `SELECT id, customer_name, phone, stage, created_at
             FROM leads WHERE (phone = ? OR (phone_normalized = ? AND phone_normalized IS NOT NULL))
               AND deleted_at IS NULL AND merged_into IS NULL`,
          )
          .get(phone, phoneNorm);
        if (existing) {
          throw new ConflictError(
            `Duplicate phone number. Lead ${existing.id} already exists for ${existing.customer_name} (stage: ${existing.stage}).`,
          );
        }

        const id = generateId(db, 'KRY-LEAD', 'leads');
        const customerName = sanitizeText(req.body.customer_name, 160);
        const source = sanitizeText(req.body.source, 80);
        const projectType = req.body.project_type || null;
        const city = req.body.city ? sanitizeText(req.body.city, 100) : null;
        const areaSqft = req.body.area_sqft !== undefined && req.body.area_sqft !== null ? Number(req.body.area_sqft) : null;
        const budgetBand = req.body.budget_band ? sanitizeText(req.body.budget_band, 100) : null;

        db.transaction(() => {
          db.prepare(
            `INSERT INTO leads
              (id, channel, source, customer_name, phone, phone_normalized, email, location, area,
               requirement, budget_range, timeline, priority, stage, current_owner, created_by, version,
               project_type, city, area_sqft, budget_band)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, 1, ?, ?, ?, ?)`,
          ).run(
            id,
            channel,
            source,
            customerName,
            phone,
            phoneNorm,
            email,
            sanitizeText(req.body.location, 160),
            sanitizeText(req.body.area, 80),
            sanitizeText(req.body.requirement, 4000),
            sanitizeText(req.body.budget_range, 80),
            sanitizeText(req.body.timeline, 80),
            priority,
            req.user.id,
            req.user.id,
            projectType,
            city,
            areaSqft,
            budgetBand,
          );

          logAction(
            db,
            id,
            'CREATED',
            req.user.id,
            req.user.id,
            'Administration',
            `Lead created via ${channel} / ${source}`,
            null,
            'New',
          );
          audit(
            db,
            req.user.id,
            'CREATE',
            'lead',
            id,
            `Created lead for ${customerName}`,
            null,
            { id, stage: 'New' },
            req.ip,
          );

          // P2.5 Auto-routing engine check
          if (req.body.auto_route === true) {
            const route = resolveAutoRouting(db, { source, channel });
            if (route && route.role === 'TELECALLER') {
            const taskId = generateId(db, 'KRY-TASK', 'tasks');
            const brief = `Auto-routed lead from ${source} (${channel}). Call customer to verify enquiry.`;
            db.prepare(
              `UPDATE leads
               SET assigned_telecaller = ?, current_owner = ?, stage = 'With Telecaller',
                   updated_at = datetime('now'), version = version + 1
               WHERE id = ?`,
            ).run(route.assigned_to, route.assigned_to, id);

            db.prepare(
              `INSERT INTO tasks
                (id, lead_id, assigned_to, assigned_by, department, task_type, priority, brief, due_date, sla_hours, status, contact_status, requires_contact, version)
               VALUES (?, ?, ?, ?, 'Marketing', 'TELECALLER_ENQUIRY', ?, ?, date('now', '+1 day'), 24, 'Assigned', 'NOT_CONTACTED', 1, 1)`,
            ).run(taskId, id, route.assigned_to, req.user.id, priority, brief);

            logAction(
              db,
              id,
              'AUTO_ROUTED',
              req.user.id,
              route.assigned_to,
              'Marketing',
              `Auto-routed via rule ${route.rule_id} to telecaller ${route.employee_name}`,
              'New',
              'With Telecaller',
            );

            notify(
              db,
              route.assigned_to,
              'LEAD_ASSIGNED',
              `New lead auto-assigned: ${customerName} (${phone}) from ${source}`,
              '#telecaller',
              'task',
              taskId,
            );
          }
        }
        })();

        const finalLead = db.prepare('SELECT id, customer_name, stage, assigned_telecaller FROM leads WHERE id = ?').get(id);
        res.status(201).json({ id: finalLead.id, customer_name: finalLead.customer_name, stage: finalLead.stage, assigned_telecaller: finalLead.assigned_telecaller });
      } catch (err) {
        next(err);
      }
    },
  );

  // Duplicate leads review (must be before /api/leads/:id)
  app.get('/api/leads/duplicates', auth, requireCentral(), (req, res, next) => {
    try {
      const groups = db
        .prepare(
          `SELECT phone_normalized, count(*) AS count
           FROM leads
           WHERE deleted_at IS NULL AND merged_into IS NULL
             AND phone_normalized IS NOT NULL AND phone_normalized != ''
           GROUP BY phone_normalized
           HAVING count > 1
           ORDER BY count DESC`,
        )
        .all();

      const result = groups.map((g) => {
        const cluster = db
          .prepare(
            `SELECT id, customer_name, phone, phone_normalized, stage, channel, source,
                    current_owner, created_at, version
             FROM leads
             WHERE deleted_at IS NULL AND merged_into IS NULL AND phone_normalized = ?
             ORDER BY created_at ASC`,
          )
          .all(g.phone_normalized);
        return {
          phone_normalized: g.phone_normalized,
          count: g.count,
          leads: cluster,
        };
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/leads/:id', auth, (req, res, next) => {
    try {
      const lead = getLead(db, req.params.id);
      if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
      if (!canAccessLead(req.user, lead, db)) {
        throw new ForbiddenError('You are not assigned to this lead.');
      }

      const timeline = db
        .prepare(
          `SELECT a.*, f.name AS from_employee_name, t.name AS to_employee_name
           FROM lead_actions a
           LEFT JOIN employees f ON f.id = a.from_employee
           LEFT JOIN employees t ON t.id = a.to_employee
           WHERE a.lead_id = ? ORDER BY a.created_at ASC, a.id ASC`,
        )
        .all(lead.id);

      const telecallerResponse = db
        .prepare(
          `SELECT tr.*, e.name AS telecaller_name
           FROM telecaller_responses tr
           LEFT JOIN employees e ON e.id = tr.telecaller_id
           WHERE tr.lead_id = ? ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1`,
        )
        .get(lead.id);

      const tasks = db
        .prepare(
          `SELECT t.*, assignee.name AS assignee_name, creator.name AS creator_name
           FROM tasks t
           LEFT JOIN employees assignee ON assignee.id = t.assigned_to
           LEFT JOIN employees creator ON creator.id = t.assigned_by
           WHERE t.lead_id = ? ORDER BY t.created_at DESC`,
        )
        .all(lead.id)
        .map((task) => ({ ...task, sla: getSlaStatus(task.created_at, task.sla_hours) }));

      const canSeeCommercial =
        isCentral(req.user) || req.user.role === 'SALES_MANAGER' || lead.assigned_bdm === req.user.id;

      const quotations = canSeeCommercial
        ? db
            .prepare(
              `SELECT q.*, c.name AS creator_name, a.name AS approver_name
               FROM quotations q
               LEFT JOIN employees c ON c.id = q.created_by
               LEFT JOIN employees a ON a.id = q.approved_by
               WHERE q.lead_id = ? ORDER BY q.version DESC, q.created_at DESC`,
            )
            .all(lead.id)
        : [];

      const workOrder = canSeeCommercial
        ? db
            .prepare(
              `SELECT w.*, c.name AS creator_name, a.name AS approver_name
               FROM work_orders w
               LEFT JOIN employees c ON c.id = w.created_by
               LEFT JOIN employees a ON a.id = w.approved_by
               WHERE w.lead_id = ?`,
            )
            .get(lead.id)
        : null;

      const sanitizedLead = {
        ...lead,
        wo_value: canSeeCommercial ? lead.wo_value : null,
      };

      const project = db
        .prepare(
          `SELECT p.*, pm.name AS pm_name, se.name AS engineer_name
           FROM projects p
           LEFT JOIN employees pm ON pm.id = p.project_manager
           LEFT JOIN employees se ON se.id = p.site_engineer
           WHERE p.lead_id = ?`,
        )
        .get(lead.id);

      const milestones = project
        ? db
            .prepare('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY order_index, id')
            .all(project.id)
        : [];

      const siteVisits = db
        .prepare(
          `SELECT s.*, e.name AS engineer_name
           FROM site_visits s LEFT JOIN employees e ON e.id = s.engineer_id
           WHERE s.lead_id = ? ORDER BY s.created_at DESC`,
        )
        .all(lead.id);

      const designs = db
        .prepare(
          `SELECT d.*, e.name AS architect_name
           FROM designs d LEFT JOIN employees e ON e.id = d.architect_id
           WHERE d.lead_id = ? ORDER BY d.version DESC, d.created_at DESC`,
        )
        .all(lead.id);

      const attachments = db
        .prepare(
          `SELECT a.*, e.name AS uploaded_by_name
           FROM lead_attachments a LEFT JOIN employees e ON e.id = a.uploaded_by
           WHERE a.entity_type = 'lead' AND a.entity_id = ? ORDER BY a.created_at DESC`,
        )
        .all(lead.id);

      const reminders = db
        .prepare(
          `SELECT r.*, e.name AS creator_name
           FROM reminders r LEFT JOIN employees e ON e.id = r.created_by
           WHERE r.lead_id = ? ORDER BY r.due_date DESC`,
        )
        .all(lead.id);

      res.json({
        lead: sanitizedLead,
        allowedStages: getAllowedTransitions(lead.stage, req.user.role),
        timeline,
        telecallerResponse,
        tasks,
        quotations,
        workOrder,
        project: project ? { ...project, milestones } : null,
        siteVisits,
        designs,
        attachments,
        reminders,
        openTasks: activeTaskCount(db, lead.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/leads/:id/timeline', auth, (req, res, next) => {
    try {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
      if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
      if (!canAccessLead(req.user, lead, db)) {
        throw new ForbiddenError('You are not assigned to this lead.');
      }
      const rows = db
        .prepare(
          `SELECT a.*, f.name AS from_employee_name, t.name AS to_employee_name
           FROM lead_actions a
           LEFT JOIN employees f ON f.id = a.from_employee
           LEFT JOIN employees t ON t.id = a.to_employee
           WHERE a.lead_id = ? ORDER BY a.created_at ASC, a.id ASC`,
        )
        .all(lead.id);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/leads/:id/assign-telecaller',
    auth,
    requireCentral(),
    validate({ body: assignTelecallerSchema }),
    requireFields('telecaller_id'),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        if (!['New', 'Nurture', 'Follow-up Required'].includes(lead.stage)) {
          throw new ConflictError('This lead is not ready for telecaller assignment.');
        }

        const telecaller = db
          .prepare(
            "SELECT id, name, role FROM employees WHERE id = ? AND active = 1 AND role = 'TELECALLER'",
          )
          .get(req.body.telecaller_id);
        if (!telecaller) throw new ValidationError('Choose an active telecaller.');

        if (
          db
            .prepare(
              `SELECT 1 FROM tasks WHERE lead_id = ? AND task_type = 'TELECALLER_ENQUIRY'
               AND status IN ('Assigned','In Progress') LIMIT 1`,
            )
            .get(lead.id)
        ) {
          throw new ConflictError('An open telecaller task already exists for this lead.');
        }

        checkOptimisticLock(lead.version, req.body.expected_version);

        const brief =
          sanitizeText(req.body.instructions, 4000) ||
          'Call the customer, verify requirement, budget, timeline and buying intent.';
        const taskId = generateId(db, 'KRY-TASK', 'tasks');

        db.transaction(() => {
          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE leads
               SET assigned_telecaller = ?, current_owner = ?, stage = 'With Telecaller',
                   updated_at = datetime('now'), version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(telecaller.id, telecaller.id, lead.id, req.body.expected_version);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE leads
               SET assigned_telecaller = ?, current_owner = ?, stage = 'With Telecaller',
                   updated_at = datetime('now'), version = version + 1
               WHERE id = ?`,
            ).run(telecaller.id, telecaller.id, lead.id);
          }

          db.prepare(
            `INSERT INTO tasks
              (id, lead_id, assigned_to, assigned_by, department, task_type, priority, brief, due_date, sla_hours, status, contact_status, requires_contact, version)
             VALUES (?, ?, ?, ?, 'Marketing', 'TELECALLER_ENQUIRY', ?, ?, date('now', '+1 day'), 24, 'Assigned', 'NOT_CONTACTED', 1, 1)`,
          ).run(taskId, lead.id, telecaller.id, req.user.id, lead.priority || 'Medium', brief);
          db.prepare("UPDATE tasks SET contact_authorized_to = ?, contact_purpose = ?, contact_expires_at = datetime('now', '+2 days') WHERE id = ?").run(telecaller.id, brief, taskId);

          if (req.body.reminder_id) {
            const rem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.body.reminder_id);
            if (rem) {
              db.prepare(`
                UPDATE reminders
                SET status = 'DONE',
                    resolved_by = ?,
                    resolved_at = datetime('now'),
                    resolution = ?
                WHERE id = ?
              `).run(req.user.id, `Assigned to telecaller ${telecaller.name}`, rem.id);

              if (rem.admin_task_id) {
                db.prepare(`
                  UPDATE tasks
                  SET status = 'Closed',
                      closed_at = datetime('now'),
                      updated_at = datetime('now'),
                      version = version + 1
                  WHERE id = ?
                `).run(rem.admin_task_id);
              }
            }
          }

          logAction(
            db,
            lead.id,
            'ASSIGNED_TO_TELECALLER',
            req.user.id,
            telecaller.id,
            'Marketing',
            `Assigned to ${telecaller.name}: ${brief}`,
            lead.stage,
            'With Telecaller',
          );
          notify(
            db,
            telecaller.id,
            'TASK_ASSIGNED',
            `New lead ${lead.id} (${lead.customer_name}) assigned for an enquiry call.`,
            '#telecaller',
            'lead',
            lead.id,
          );
          audit(
            db,
            req.user.id,
            'ASSIGN',
            'lead',
            lead.id,
            `Assigned telecaller ${telecaller.name}`,
            { stage: lead.stage },
            { stage: 'With Telecaller', telecaller: telecaller.id },
            req.ip,
          );
        })();

        res.json({ ok: true, lead_id: lead.id, assigned_to: telecaller.name, task_id: taskId });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/leads/:id/route',
    auth,
    requireCentral(),
    validate({ body: routeLeadSchema }),
    requireFields('department', 'assigned_to', 'task_type', 'brief'),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        if (!['Response Received', 'Update Received'].includes(lead.stage)) {
          throw new ConflictError('Admin Desk must review the latest response before routing.');
        }
        if (activeTaskCount(db, lead.id) > 0) {
          throw new ConflictError('A department task is still open. Wait for its submission before routing again.');
        }
        if (lead.stage === 'Update Received' && submittedTaskCount(db, lead.id) > 0) {
          throw new ConflictError('Review the submitted department update before routing this lead again.');
        }

        const department = String(req.body.department);
        const config = DEPARTMENTS[department];
        if (!config) {
          throw new ValidationError('Choose Sales, Technical, Design, Purchase or Accounts.');
        }
        if (!config.taskTypes.includes(String(req.body.task_type))) {
          throw new ValidationError('The task type does not match the selected department.');
        }

        const assignee = db
          .prepare('SELECT id, name, role, department FROM employees WHERE id = ? AND active = 1')
          .get(req.body.assigned_to);
        if (!assignee || !config.roles.includes(assignee.role)) {
          throw new ValidationError(`Choose an active ${department} employee.`);
        }

        checkOptimisticLock(lead.version, req.body.expected_version);

        const slaHours = Math.min(Math.max(toInt(req.body.sla_hours, 48) || 48, 1), 720);
        const dueDate = req.body.due_date || null;
        const brief = sanitizeText(req.body.brief, 4000);
        const taskId = generateId(db, 'KRY-TASK', 'tasks');
        const newStage = config.stage;

        db.transaction(() => {
          const assignments = ['current_owner = ?', 'stage = ?', "updated_at = datetime('now')", 'version = version + 1'];
          const params = [assignee.id, newStage];
          if (config.column) {
            assignments.push(`${config.column} = ?`);
            params.push(assignee.id);
          }
          params.push(lead.id);

          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            params.push(req.body.expected_version);
            const updateRes = db.prepare(`UPDATE leads SET ${assignments.join(', ')} WHERE id = ? AND version = ?`).run(...params);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(`UPDATE leads SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
          }

          // Admin routing is the review step for the telecaller's submitted
          // enquiry, so close that loop explicitly instead of leaving a
          // permanently "Submitted" task behind.
          db.prepare(
            `UPDATE tasks
             SET status = 'Reviewed', reviewed_by = ?, reviewed_at = datetime('now'),
                 review_remarks = coalesce(review_remarks, 'Enquiry reviewed by Admin Desk and routed.'),
                 updated_at = datetime('now'), version = version + 1
             WHERE lead_id = ? AND task_type = 'TELECALLER_ENQUIRY' AND status = 'Submitted'`,
          ).run(req.user.id, lead.id);

          const requiresContact = req.body.allow_customer_contact === true ? 1 : 0;
          const contactStatus = requiresContact === 1 ? 'NOT_CONTACTED' : 'NOT_REQUIRED';

          db.prepare(
            `INSERT INTO tasks
              (id, lead_id, assigned_to, assigned_by, department, task_type, priority, brief, due_date, sla_hours, status, contact_status, requires_contact, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Assigned', ?, ?, 1)`,
          ).run(
            taskId,
            lead.id,
            assignee.id,
            req.user.id,
            department,
            String(req.body.task_type),
            lead.priority || 'Medium',
            brief,
            dueDate,
            slaHours,
            contactStatus,
            requiresContact,
          );
          if (requiresContact) {
            db.prepare("UPDATE tasks SET contact_authorized_to = ?, contact_purpose = ?, contact_expires_at = datetime('now', '+2 days') WHERE id = ?").run(assignee.id, brief, taskId);
          }

          if (req.body.reminder_id) {
            const rem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.body.reminder_id);
            if (rem) {
              db.prepare(`
                UPDATE reminders
                SET status = 'DONE',
                    resolved_by = ?,
                    resolved_at = datetime('now'),
                    resolution = ?
                WHERE id = ?
              `).run(req.user.id, `Lead routed to ${department}`, rem.id);

              if (rem.admin_task_id) {
                db.prepare(`
                  UPDATE tasks
                  SET status = 'Closed',
                      closed_at = datetime('now'),
                      updated_at = datetime('now'),
                      version = version + 1
                  WHERE id = ?
                `).run(rem.admin_task_id);
              }
            }
          }

          logAction(
            db,
            lead.id,
            'ROUTED_TO_DEPT',
            req.user.id,
            assignee.id,
            department,
            `Admin Desk routed to ${department} (${assignee.name}): ${brief}`,
            lead.stage,
            newStage,
          );
          notify(
            db,
            assignee.id,
            'TASK_ASSIGNED',
            `New ${department} task ${taskId} for ${lead.customer_name} (${lead.id}).`,
            '#tasks',
            'task',
            taskId,
          );
          audit(
            db,
            req.user.id,
            'ROUTE',
            'lead',
            lead.id,
            `Routed to ${department} (${assignee.name})`,
            { stage: lead.stage },
            { stage: newStage, task_id: taskId },
            req.ip,
          );
        })();

        res.json({ ok: true, lead_id: lead.id, task_id: taskId, stage: newStage });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/leads/:id/advance-to-quotation',
    auth,
    requireCentral(),
    validate({ body: advanceQuotationSchema }),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        if (lead.stage !== 'Update Received') {
          throw new ConflictError('Only a reviewed lead in "Update Received" can advance to quotation.');
        }
        if (!lead.assigned_bdm) {
          throw new ConflictError('Assign the lead to a Sales employee before creating a quotation.');
        }
        const sales = db
          .prepare("SELECT id, name, role, active FROM employees WHERE id = ?")
          .get(lead.assigned_bdm);
        if (!sales || !sales.active || !['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'].includes(sales.role)) {
          throw new ConflictError('The assigned Sales employee is not active.');
        }
        if (activeTaskCount(db, lead.id) > 0 || submittedTaskCount(db, lead.id) > 0) {
          throw new ConflictError('Review all open tasks before advancing to quotation.');
        }
        const reviewedSalesTask = db
          .prepare(
            `SELECT id FROM tasks WHERE lead_id = ? AND department = 'Sales' AND status = 'Reviewed'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(lead.id);
        if (!reviewedSalesTask) {
          throw new ConflictError('A reviewed Sales task is required before quotation.');
        }

        checkOptimisticLock(lead.version, req.body.expected_version);

        db.transaction(() => {
          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE leads SET stage = 'Quotation Stage', current_owner = ?, updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(sales.id, lead.id, req.body.expected_version);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE leads SET stage = 'Quotation Stage', current_owner = ?, updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ?`,
            ).run(sales.id, lead.id);
          }

          logAction(
            db,
            lead.id,
            'STAGE_CHANGE',
            req.user.id,
            sales.id,
            'Sales',
            'Admin Desk approved the reviewed Sales recommendation and advanced the lead to quotation.',
            lead.stage,
            'Quotation Stage',
          );
          notify(
            db,
            sales.id,
            'QUOTE_STAGE',
            `Lead ${lead.id} (${lead.customer_name}) is ready for quotation preparation.`,
            '#quotations',
            'lead',
            lead.id,
          );
          audit(
            db,
            req.user.id,
            'ADVANCE_QUOTATION',
            'lead',
            lead.id,
            `Advanced to quotation for ${sales.name}`,
            { stage: lead.stage },
            { stage: 'Quotation Stage' },
            req.ip,
          );
        })();

        res.json({ ok: true, lead_id: lead.id, stage: 'Quotation Stage', assigned_to: sales.name, version: lead.version + 1 });
      } catch (err) {
        next(err);
      }
    },
  );

  app.patch('/api/leads/:id', auth, requireCentral(), validate({ body: updateLeadSchema }), (req, res, next) => {
    try {
      const lead = getLead(db, req.params.id);
      if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
      checkOptimisticLock(lead.version, req.body.expected_version);

      const updates = [];
      const params = [];

      if (req.body.customer_name !== undefined) {
        updates.push('customer_name = ?');
        params.push(sanitizeText(req.body.customer_name, 160));
      }
      if (req.body.phone !== undefined) {
        if (!isValidPhone(req.body.phone)) throw new ValidationError('Enter a valid phone number.');
        const phoneDigits = req.body.phone.replace(/\D/g, '');
        const phoneNorm = (phoneDigits.length === 12 && phoneDigits.startsWith('91'))
          ? phoneDigits.slice(2)
          : (phoneDigits.length === 11 && phoneDigits.startsWith('0'))
          ? phoneDigits.slice(1)
          : phoneDigits;
        updates.push('phone = ?', 'phone_normalized = ?');
        params.push(req.body.phone, phoneNorm);
      }
      if (req.body.email !== undefined) {
        const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
        if (email && !isValidEmail(email)) throw new ValidationError('Enter a valid email address.');
        updates.push('email = ?');
        params.push(email);
      }
      if (req.body.location !== undefined) {
        updates.push('location = ?');
        params.push(req.body.location ? sanitizeText(req.body.location, 160) : null);
      }
      if (req.body.area !== undefined) {
        updates.push('area = ?');
        params.push(req.body.area ? sanitizeText(req.body.area, 80) : null);
      }
      if (req.body.requirement !== undefined) {
        updates.push('requirement = ?');
        params.push(req.body.requirement ? sanitizeText(req.body.requirement, 4000) : null);
      }
      if (req.body.budget_range !== undefined) {
        updates.push('budget_range = ?');
        params.push(req.body.budget_range ? sanitizeText(req.body.budget_range, 80) : null);
      }
      if (req.body.timeline !== undefined) {
        updates.push('timeline = ?');
        params.push(req.body.timeline ? sanitizeText(req.body.timeline, 80) : null);
      }
      if (req.body.priority !== undefined) {
        updates.push('priority = ?');
        params.push(req.body.priority);
      }
      if (req.body.project_type !== undefined) {
        updates.push('project_type = ?');
        params.push(req.body.project_type);
      }
      if (req.body.city !== undefined) {
        updates.push('city = ?');
        params.push(req.body.city ? sanitizeText(req.body.city, 100) : null);
      }
      if (req.body.area_sqft !== undefined) {
        updates.push('area_sqft = ?');
        params.push(req.body.area_sqft !== null ? Number(req.body.area_sqft) : null);
      }
      if (req.body.budget_band !== undefined) {
        updates.push('budget_band = ?');
        params.push(req.body.budget_band ? sanitizeText(req.body.budget_band, 100) : null);
      }

      if (updates.length === 0) {
        return res.json(getLead(db, req.params.id));
      }

      updates.push('version = version + 1', "updated_at = datetime('now')");
      params.push(req.params.id);

      db.transaction(() => {
        db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        audit(db, req.user.id, 'UPDATE', 'lead', req.params.id, 'Updated lead enterprise fields', lead, getLead(db, req.params.id), req.ip);
      })();

      res.json(getLead(db, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/leads/:id/stage', auth, requireCentral(), validate({ body: updateStageSchema }), (req, res, next) => {
    try {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
      if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
      if (!['Lost', 'Nurture'].includes(req.body.stage)) {
        throw new ValidationError(
          'Only Lost or Nurture can be set directly. Use workflow actions for other stages.',
        );
      }
      if (!isOpenStage(lead.stage)) {
        throw new ConflictError(`A lead in "${lead.stage}" cannot be moved to ${req.body.stage}.`);
      }
      if (!canTransition(lead.stage, req.body.stage, req.user.role)) {
        throw new ForbiddenError('This stage change is not allowed for your role.');
      }
      const reason = sanitizeText(req.body.lost_reason || req.body.reason || req.body.remarks, 2000);
      if (!reason) throw new ValidationError('A reason is required when closing or nurturing a lead.');

      const gate = checkStageGate(lead.stage, req.body.stage, { ...lead, ...req.body, reason });
      if (!gate.ok) {
        throw new ValidationError(gate.error);
      }

      let lostReasonValue = req.body.lost_reason || req.body.reason || null;
      let lostNotesValue = sanitizeText(req.body.lost_notes || req.body.remarks || '', 4000);
      if (req.body.stage === 'Lost') {
        if (!lostReasonValue) {
          if (req.body.remarks) {
            lostReasonValue = 'Other';
            if (!lostNotesValue) lostNotesValue = sanitizeText(req.body.remarks, 4000);
          } else {
            throw new ValidationError(`lost_reason is required and must be one of: ${LOST_REASONS.join(', ')}.`);
          }
        } else if (!LOST_REASONS.includes(lostReasonValue)) {
          if (!lostNotesValue) lostNotesValue = lostReasonValue;
          lostReasonValue = 'Other';
        }
      }

      checkOptimisticLock(lead.version, req.body.expected_version);

      db.transaction(() => {
        let updateRes;
        if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
          updateRes = db.prepare(
            `UPDATE leads SET stage = ?, lost_reason = ?, lost_notes = ?, current_owner = ?, updated_at = datetime('now'),
                              version = version + 1
             WHERE id = ? AND version = ?`,
          ).run(
            req.body.stage,
            req.body.stage === 'Lost' ? lostReasonValue : lead.lost_reason,
            lostNotesValue || null,
            req.body.stage === 'Nurture' ? firstActiveAdminId(db) : null,
            lead.id,
            req.body.expected_version,
          );
          if (updateRes.changes === 0) {
            throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
          }
        } else {
          db.prepare(
            `UPDATE leads SET stage = ?, lost_reason = ?, lost_notes = ?, current_owner = ?, updated_at = datetime('now'),
                              version = version + 1
             WHERE id = ?`,
          ).run(
            req.body.stage,
            req.body.stage === 'Lost' ? lostReasonValue : lead.lost_reason,
            lostNotesValue || null,
            req.body.stage === 'Nurture' ? firstActiveAdminId(db) : null,
            lead.id,
          );
        }

        if (req.body.stage === 'Lost') {
          db.prepare(
            `UPDATE tasks SET status = 'Cancelled', closed_at = datetime('now'), updated_at = datetime('now'),
                              version = version + 1
             WHERE lead_id = ? AND status IN ('Assigned','In Progress','Submitted')`,
          ).run(lead.id);
          cancelForLead(db, lead.id, 'Lead moved to Lost');
        }

        if (req.body.stage === 'Nurture') {
          const reminderDate = req.body.reminder_date || addDaysLocal(30);
          createReminder(db, req.user, lead.id, {
            type: 'FOLLOW_UP',
            due_date: reminderDate,
            notes: `Auto re-engagement for nurtured lead: ${reason}`,
          });
        }
        logAction(
          db,
          lead.id,
          req.body.stage === 'Lost' ? 'LOST' : 'NURTURE',
          req.user.id,
          null,
          'Administration',
          reason,
          lead.stage,
          req.body.stage,
        );
        audit(
          db,
          req.user.id,
          'STAGE_CHANGE',
          'lead',
          lead.id,
          `Moved to ${req.body.stage}: ${reason}`,
          { stage: lead.stage },
          { stage: req.body.stage },
          req.ip,
        );
      })();

      res.json({ ok: true, old_stage: lead.stage, new_stage: req.body.stage, version: lead.version + 1 });
    } catch (err) {
      next(err);
    }
  });

  // Merge duplicate lead into retained lead
  app.post(
    '/api/leads/:id/merge',
    auth,
    requireCentral(),
    validate({ body: mergeLeadSchema }),
    (req, res, next) => {
      try {
        const retainedId = req.params.id;
        const duplicateId = req.body.duplicate_lead_id;
        const reason = sanitizeText(req.body.reason, 2000);

        if (retainedId === duplicateId) {
          throw new ValidationError('Cannot merge a lead into itself.');
        }

        const retainedLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(retainedId);
        if (!retainedLead || retainedLead.deleted_at || retainedLead.merged_into) {
          throw new NotFoundError('Retained lead not found or already merged.');
        }

        const duplicateLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(duplicateId);
        if (!duplicateLead || duplicateLead.deleted_at || duplicateLead.merged_into) {
          throw new NotFoundError('Duplicate lead not found or already merged.');
        }

        checkOptimisticLock(retainedLead.version, req.body.expected_version);

        db.transaction(() => {
          // Reparent mutable child entities
          db.prepare('UPDATE tasks SET lead_id = ?, updated_at = datetime(\'now\') WHERE lead_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE quotations SET lead_id = ?, updated_at = datetime(\'now\') WHERE lead_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE work_orders SET lead_id = ?, updated_at = datetime(\'now\') WHERE lead_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE site_visits SET lead_id = ? WHERE lead_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE designs SET lead_id = ? WHERE lead_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE lead_attachments SET entity_id = ? WHERE entity_type = \'lead\' AND entity_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE material_requisitions SET lead_id = ? WHERE lead_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE telecaller_responses SET lead_id = ? WHERE lead_id = ?').run(retainedId, duplicateId);
          db.prepare('UPDATE projects SET lead_id = ?, updated_at = datetime(\'now\') WHERE lead_id = ?').run(retainedId, duplicateId);

          // Mark duplicate lead as merged & closed
          db.prepare(
            `UPDATE leads
             SET stage = 'Closed', deleted_at = datetime('now'),
                 merged_into = ?, merge_reason = ?, merged_at = datetime('now'),
                 updated_at = datetime('now'), version = version + 1
             WHERE id = ?`,
          ).run(retainedId, reason, duplicateId);

          // Update retained lead version
          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE leads SET version = version + 1, updated_at = datetime('now') WHERE id = ? AND version = ?`,
            ).run(retainedId, req.body.expected_version);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE leads SET version = version + 1, updated_at = datetime('now') WHERE id = ?`,
            ).run(retainedId);
          }

          // Append-only timeline entries on BOTH leads (no update/delete triggers violated)
          logAction(
            db,
            retainedId,
            'DUPLICATE_MERGE',
            req.user.id,
            null,
            'Administration',
            `Merged duplicate lead ${duplicateId} into this record: ${reason}`,
            retainedLead.stage,
            retainedLead.stage,
          );

          logAction(
            db,
            duplicateId,
            'MERGED_INTO',
            req.user.id,
            null,
            'Administration',
            `Lead merged into ${retainedId}: ${reason}`,
            duplicateLead.stage,
            'Closed',
          );

          audit(
            db,
            req.user.id,
            'MERGE_LEADS',
            'lead',
            retainedId,
            `Merged lead ${duplicateId} into ${retainedId}: ${reason}`,
            { duplicate_lead_id: duplicateId },
            { merged_into: retainedId },
            req.ip,
          );
        })();

        res.json({ ok: true, retained_id: retainedId, merged_id: duplicateId, version: retainedLead.version + 1 });
      } catch (err) {
        next(err);
      }
    },
  );

  // Dismiss duplicate alert
  app.post(
    '/api/leads/:id/dismiss-duplicate',
    auth,
    requireCentral(),
    validate({ body: dismissDuplicateSchema }),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');

        const reason = sanitizeText(req.body.dismiss_reason, 2000) || 'Duplicate warning dismissed by Admin Desk';

        logAction(
          db,
          lead.id,
          'DISMISS_DUPLICATE',
          req.user.id,
          null,
          'Administration',
          reason,
          lead.stage,
          lead.stage,
        );

        audit(
          db,
          req.user.id,
          'DISMISS_DUPLICATE',
          'lead',
          lead.id,
          reason,
          null,
          null,
          req.ip,
        );

        res.json({ ok: true, lead_id: lead.id });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/leads/:id/note',
    auth,
    requireCentral(),
    validate({ body: noteSchema }),
    requireFields('remarks'),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        const remarks = sanitizeText(req.body.remarks, 4000);
        logAction(db, lead.id, 'NOTE', req.user.id, null, req.user.department, remarks, null, null);
        audit(db, req.user.id, 'NOTE', 'lead', lead.id, remarks, null, null, req.ip);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/leads/:id/anonymize',
    auth,
    (req, res, next) => {
      try {
        const { anonymizeCustomerData } = require('../lib/services/privacy-service');
        const reason = (req.body && req.body.reason) || 'Customer request under DPDP Act 2023';
        const result = anonymizeCustomerData(db, req.params.id, req.user, reason);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );
};
