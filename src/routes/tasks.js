/**
 * Department task loop: spoke receives task, works it, submits findings back to
 * Admin Desk. Only Admin Desk can review and close the loop.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { isCentral } = require('../middleware/rbac');
const { requireCentral } = require('../middleware/rbac');
const {
  sanitizeText,
  toInt,
  validate,
  z,
} = require('../middleware/validate');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { getSlaStatus } = require('../lib/sla');
const { audit, notify, notifyCentral, logAction, firstActiveAdminId } = require('../lib/audit-notify');
const { logOutcome } = require('../lib/services/contact-service');
const { addWorkNote } = require('../lib/services/activity-service');

const taskStatusSchema = z.object({
  status: z.literal('In Progress'),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const taskResponseSchema = z.object({
  findings: z.string().trim().min(1, 'Findings are required.').max(6000),
  recommendation: z.string().trim().max(4000).optional().nullable(),
  attachments: z.string().trim().max(2000).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const taskReviewSchema = z.object({
  review_remarks: z.string().trim().min(1, 'Review remarks are required.').max(4000),
  next_action: z.string().trim().max(2000).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const taskReworkSchema = z.object({
  rework_notes: z.string().trim().min(1, 'Rework notes are required.').max(4000),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const taskReassignSchema = z.object({
  new_assigned_to: z.string().trim().min(1, 'New assignee is required.'),
  reason: z.string().trim().min(1, 'Reassignment reason is required.').max(2000),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const taskReopenSchema = z.object({
  reopen_reason: z.string().trim().min(1, 'Reopen reason is required.').max(2000),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const taskContactSchema = z.object({
  outcome: z.enum(['CONNECTED', 'CALLBACK_REQUESTED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'WRONG_NUMBER', 'INVALID_NUMBER', 'Connected', 'Not Picked', 'Busy', 'Wrong Number']),
  notes: z.string().trim().max(4000).optional().nullable(),
  interest: z.string().trim().max(80).optional().nullable(),
  customer_intent: z.string().trim().max(80).optional().nullable(),
  work_summary: z.string().trim().max(4000).optional().nullable(),
  next_action: z.string().trim().max(2000).optional().nullable(),
  next_action_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'next_action_date must use YYYY-MM-DD format').or(z.literal('')).optional().nullable(),
  callback_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'callback_date must use YYYY-MM-DD format').or(z.literal('')).optional().nullable(),
  duration_seconds: z.coerce.number().min(0).optional().nullable(),
  reminder_type: z.enum(['CALL_BACK', 'CUSTOMER_WILL_CALL', 'FOLLOW_UP']).optional().nullable(),
  budget_range: z.string().trim().max(80).optional().nullable(),
  customer_budget: z.string().trim().max(80).optional().nullable(),
  call_purpose: z.string().trim().max(100).optional().nullable(),
  requirement_type: z.string().trim().max(100).optional().nullable(),
  location_area: z.string().trim().max(100).optional().nullable(),
  timeline: z.string().trim().max(80).optional().nullable(),
  area: z.string().trim().max(80).optional().nullable(),
  requirement_detail: z.string().trim().max(4000).optional().nullable(),
  objections: z.string().trim().max(4000).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const taskWorkNoteSchema = z.object({
  notes: z.string().trim().max(4000).optional().nullable(),
  note: z.string().trim().max(4000).optional().nullable(),
  hours_spent: z.coerce.number().min(0).optional().nullable(),
  work_done: z.string().trim().max(4000).optional().nullable(),
  next_action: z.string().trim().max(2000).optional().nullable(),
  next_action_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'next_action_date must use YYYY-MM-DD format').or(z.literal('')).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const DEPARTMENT_ROLES = Object.freeze({
  Sales: ['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'],
  Technical: ['SITE_ENGINEER'],
  Design: ['ARCHITECT'],
  Purchase: ['PURCHASE'],
  Accounts: ['ACCOUNTS'],
  Projects: ['PROJECT_MANAGER'],
  Marketing: ['TELECALLER'],
});

const DEPARTMENT_STAGE = Object.freeze({
  Sales: 'Routed to Sales',
  Technical: 'Routed to Engineering',
  Design: 'Routed to Design',
  Purchase: 'Routed to Purchase',
  Accounts: 'Routed to Accounts',
  Marketing: 'With Telecaller',
});

const DEPARTMENT_LEAD_COLUMN = Object.freeze({
  Sales: 'assigned_bdm',
  Technical: 'assigned_engineer',
  Design: 'assigned_architect',
  Projects: 'assigned_pm',
  Marketing: 'assigned_telecaller',
});

function decorate(task) {
  return task ? { ...task, sla: getSlaStatus(task.created_at, task.sla_hours) } : task;
}

function checkOptimisticLock(currentVersion, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== null) {
    if (Number(expectedVersion) !== Number(currentVersion)) {
      throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
    }
  }
}

module.exports = function registerTaskRoutes(app, db) {
  app.get('/api/tasks', auth, (req, res) => {
    const conditions = [];
    const params = [];
    if (!isCentral(req.user)) {
      conditions.push('t.assigned_to = ?');
      params.push(req.user.id);
    }
    if (req.query.status) {
      conditions.push('t.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.department) {
      conditions.push('t.department = ?');
      params.push(String(req.query.department));
    }
    if (req.query.lead_id) {
      conditions.push('t.lead_id = ?');
      params.push(String(req.query.lead_id));
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
      conditions.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
      params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
    }

    const limit = Math.min(Math.max(toInt(req.query.limit, 500) || 500, 1), 1000);

    let sql;
    if (cursorCreatedAt && cursorId) {
      sql = `
        SELECT t.*,
               l.customer_name,
               l.phone AS customer_phone,
               l.location AS customer_location,
               l.stage AS lead_stage,
               assignee.name AS assignee_name,
               creator.name AS creator_name,
               reviewer.name AS reviewer_name
        FROM tasks t
        LEFT JOIN leads l ON l.id = t.lead_id
        LEFT JOIN employees assignee ON assignee.id = t.assigned_to
        LEFT JOIN employees creator ON creator.id = t.assigned_by
        LEFT JOIN employees reviewer ON reviewer.id = t.reviewed_by
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`;
    } else {
      sql = `
        SELECT t.*,
               l.customer_name,
               l.phone AS customer_phone,
               l.location AS customer_location,
               l.stage AS lead_stage,
               assignee.name AS assignee_name,
               creator.name AS creator_name,
               reviewer.name AS reviewer_name
        FROM tasks t
        LEFT JOIN leads l ON l.id = t.lead_id
        LEFT JOIN employees assignee ON assignee.id = t.assigned_to
        LEFT JOIN employees creator ON creator.id = t.assigned_by
        LEFT JOIN employees reviewer ON reviewer.id = t.reviewed_by
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY
          CASE t.status WHEN 'Submitted' THEN 0 WHEN 'Assigned' THEN 1 WHEN 'In Progress' THEN 2 ELSE 3 END,
          t.created_at DESC, t.id DESC
        LIMIT ?`;
    }

    const rows = db.prepare(sql).all(...params, limit);

    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      const nextCursor = Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64');
      res.setHeader('X-Next-Cursor', nextCursor);
      res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    }

    res.json(rows.map(decorate));
  });

  app.get('/api/tasks/:id', auth, (req, res, next) => {
    try {
      const task = db
        .prepare(
          `SELECT t.*,
                  l.customer_name, l.phone AS customer_phone, l.location, l.area,
                  l.budget_range, l.requirement, l.stage AS lead_stage,
                  assignee.name AS assignee_name, creator.name AS creator_name,
                  reviewer.name AS reviewer_name
           FROM tasks t
           LEFT JOIN leads l ON l.id = t.lead_id
           LEFT JOIN employees assignee ON assignee.id = t.assigned_to
           LEFT JOIN employees creator ON creator.id = t.assigned_by
           LEFT JOIN employees reviewer ON reviewer.id = t.reviewed_by
           WHERE t.id = ?`,
        )
        .get(req.params.id);
      if (!task) throw new NotFoundError('Task not found.');
      if (!isCentral(req.user) && task.assigned_to !== req.user.id) {
        throw new ForbiddenError('You are not assigned to this task.');
      }

      const updates = db
        .prepare(
          `SELECT du.*, e.name AS employee_name
           FROM dept_updates du LEFT JOIN employees e ON e.id = du.employee_id
           WHERE du.task_id = ? ORDER BY du.created_at DESC`,
        )
        .all(task.id);
      const siteVisits = db
        .prepare(
          `SELECT s.*, e.name AS engineer_name
           FROM site_visits s LEFT JOIN employees e ON e.id = s.engineer_id
           WHERE s.task_id = ? ORDER BY s.created_at DESC`,
        )
        .all(task.id);
      const designs = db
        .prepare(
          `SELECT d.*, e.name AS architect_name
           FROM designs d LEFT JOIN employees e ON e.id = d.architect_id
           WHERE d.task_id = ? ORDER BY d.version DESC`,
        )
        .all(task.id);
      const timeline = task.lead_id
        ? db
            .prepare(
              `SELECT a.*, f.name AS from_employee_name, t.name AS to_employee_name
               FROM lead_actions a
               LEFT JOIN employees f ON f.id = a.from_employee
               LEFT JOIN employees t ON t.id = a.to_employee
               WHERE a.lead_id = ? ORDER BY a.created_at ASC, a.id ASC`,
            )
            .all(task.lead_id)
        : [];
      const activity = db
        .prepare(
          `SELECT act.*, e.name AS employee_name
           FROM task_activity act
           LEFT JOIN employees e ON e.id = act.employee_id
           WHERE act.task_id = ? ORDER BY act.created_at DESC, act.id DESC`,
        )
        .all(task.id);
      const reminders = db
        .prepare(
          `SELECT r.*, e.name AS creator_name
           FROM reminders r
           LEFT JOIN employees e ON e.id = r.created_by
           WHERE r.task_id = ? ORDER BY r.due_date ASC, r.id ASC`,
        )
        .all(task.id);

      const telecallerResponses = db
        .prepare(
          `SELECT tr.*, e.name AS telecaller_name
           FROM telecaller_responses tr
           LEFT JOIN employees e ON e.id = tr.telecaller_id
           WHERE tr.task_id = ? OR (tr.lead_id = ? AND tr.telecaller_id = ?)
           ORDER BY tr.created_at DESC`,
        )
        .all(task.id, task.lead_id, task.assigned_to);

      res.json({
        task: decorate(task),
        updates,
        siteVisits,
        designs,
        timeline,
        activity,
        reminders,
        telecallerResponses,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tasks/:id/logs - Activity timeline & logs endpoint
  app.get('/api/tasks/:id/logs', auth, (req, res, next) => {
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
      if (!task) throw new NotFoundError('Task not found.');
      if (!isCentral(req.user) && task.assigned_to !== req.user.id) {
        throw new ForbiddenError('You are not assigned to this task.');
      }

      const activity = db
        .prepare(
          `SELECT act.*, e.name AS employee_name
           FROM task_activity act
           LEFT JOIN employees e ON e.id = act.employee_id
           WHERE act.task_id = ? ORDER BY act.created_at ASC, act.id ASC`,
        )
        .all(task.id);

      const timeline = task.lead_id
        ? db
            .prepare(
              `SELECT a.*, f.name AS from_employee_name, t.name AS to_employee_name
               FROM lead_actions a
               LEFT JOIN employees f ON f.id = a.from_employee
               LEFT JOIN employees t ON t.id = a.to_employee
               WHERE a.lead_id = ? ORDER BY a.created_at ASC, a.id ASC`,
            )
            .all(task.lead_id)
        : [];

      const telecallerResponses = db
        .prepare(
          `SELECT tr.*, e.name AS telecaller_name
           FROM telecaller_responses tr
           LEFT JOIN employees e ON e.id = tr.telecaller_id
           WHERE tr.task_id = ? OR (tr.lead_id = ? AND tr.telecaller_id = ?)
           ORDER BY tr.created_at DESC`,
        )
        .all(task.id, task.lead_id, task.assigned_to);

      res.json({
        task_id: task.id,
        activity,
        timeline,
        telecallerResponses,
      });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/tasks/:id/status', auth, validate({ body: taskStatusSchema }), (req, res, next) => {
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
      if (!task) throw new NotFoundError('Task not found.');
      if (isCentral(req.user) || task.assigned_to !== req.user.id) {
        throw new ForbiddenError('Only the assigned employee can start this task.');
      }
      if (req.body.status !== 'In Progress') {
        throw new ValidationError('Only the transition to In Progress is supported here.');
      }
      if (task.status !== 'Assigned') {
        throw new ConflictError(`A task in "${task.status}" cannot be started.`);
      }

      checkOptimisticLock(task.version, req.body.expected_version);

      let updateRes;
      if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
        updateRes = db.prepare(
          `UPDATE tasks SET status = 'In Progress',
                            started_at = COALESCE(started_at, datetime('now')),
                            updated_at = datetime('now'),
                            version = version + 1
           WHERE id = ? AND version = ?`,
        ).run(task.id, req.body.expected_version);
        if (updateRes.changes === 0) {
          throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
        }
      } else {
        updateRes = db.prepare(
          `UPDATE tasks SET status = 'In Progress',
                            started_at = COALESCE(started_at, datetime('now')),
                            updated_at = datetime('now'),
                            version = version + 1
           WHERE id = ?`,
        ).run(task.id);
      }

      audit(db, req.user.id, 'START_TASK', 'task', task.id, 'Task moved to In Progress', null, null, req.ip);
      res.json({ ok: true, status: 'In Progress', version: task.version + 1 });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/tasks/:id/contact - Assignee only (others get 404)
  app.post(
    '/api/tasks/:id/contact',
    auth,
    validate({ body: taskContactSchema }),
    (req, res, next) => {
      try {
        const result = logOutcome(db, req.user, req.params.id, req.body, req.ip);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tasks/:id/call-log - Direct alias for Log Call endpoint
  app.post(
    '/api/tasks/:id/call-log',
    auth,
    validate({ body: taskContactSchema }),
    (req, res, next) => {
      try {
        const result = logOutcome(db, req.user, req.params.id, req.body, req.ip);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tasks/:id/snooze - Assignee or Admin snoozes/reschedules the task to a future date
  app.post(
    '/api/tasks/:id/snooze',
    auth,
    validate({
      body: z.object({
        snooze_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'snooze_until must use YYYY-MM-DD format'),
        reason: z.string().trim().max(2000).optional().nullable(),
      }).strict(),
    }),
    (req, res, next) => {
      try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!task) throw new NotFoundError('Task not found.');
        if (!isCentral(req.user) && task.assigned_to !== req.user.id) {
          throw new ForbiddenError('You can only snooze tasks assigned to you.');
        }

        const snoozeDate = req.body.snooze_until;
        const reason = req.body.reason ? req.body.reason.trim() : 'Snoozed by user';

        db.transaction(() => {
          // Update task next_action_date
          db.prepare(`
            UPDATE tasks
            SET next_action_date = ?,
                next_action = ?,
                updated_at = datetime('now'),
                version = version + 1
            WHERE id = ?
          `).run(snoozeDate, `Snoozed until ${snoozeDate}: ${reason}`, task.id);

          // Add task_activity log
          db.prepare(`
            INSERT INTO task_activity
              (task_id, lead_id, employee_id, kind, outcome, notes, work_done, next_action, next_action_date, created_at)
            VALUES (?, ?, ?, 'WORK_NOTE', 'SNOOZED', ?, ?, ?, ?, datetime('now'))
          `).run(
            task.id,
            task.lead_id,
            req.user.id,
            `Task snoozed until ${snoozeDate}. Reason: ${reason}`,
            `Snoozed until ${snoozeDate}`,
            `Follow-up on ${snoozeDate}`,
            snoozeDate,
          );

          if (task.lead_id) {
            logAction(
              db,
              task.lead_id,
              'NOTE',
              req.user.id,
              null,
              task.department,
              `Task ${task.id} snoozed to ${snoozeDate} by ${req.user.name}: ${reason}`,
              null,
              null,
            );
          }
        })();

        res.json({ ok: true, task_id: task.id, snoozed_until: snoozeDate });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tasks/:id/work-note - Assignee only (others get 404)
  app.post(
    '/api/tasks/:id/work-note',
    auth,
    validate({ body: taskWorkNoteSchema }),
    (req, res, next) => {
      try {
        const result = addWorkNote(db, req.user, req.params.id, req.body, req.ip);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/tasks/:id/response',
    auth,
    validate({ body: taskResponseSchema }),
    (req, res, next) => {
      try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!task) throw new NotFoundError('Task not found.');
        if (isCentral(req.user) || task.assigned_to !== req.user.id) {
          throw new ForbiddenError('Only the assigned department employee can submit this task.');
        }
        const allowedRoles = DEPARTMENT_ROLES[task.department];
        if (!allowedRoles || !allowedRoles.includes(req.user.role)) {
          throw new ForbiddenError('Your role does not match this task department.');
        }
        if (task.task_type === 'TELECALLER_ENQUIRY') {
          throw new ConflictError('Submit telecaller enquiries through the Telecaller Desk.');
        }
        if (!['Assigned', 'In Progress'].includes(task.status)) {
          throw new ConflictError('This task is no longer accepting updates.');
        }
        if (task.requires_contact && task.contact_status === 'NOT_CONTACTED') {
          throw new ConflictError('Cannot submit task before contacting customer. Please log a contact outcome first.');
        }

        checkOptimisticLock(task.version, req.body.expected_version);

        const findings = sanitizeText(req.body.findings, 6000);
        if (!findings) throw new ValidationError('Findings are required.');
        const recommendation = sanitizeText(req.body.recommendation, 4000);
        const attachments = sanitizeText(req.body.attachments, 2000);
        const lead = task.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id) : null;

        if (lead) {
          const expectedStage = DEPARTMENT_STAGE[task.department];
          if (expectedStage && lead.stage !== expectedStage) {
            throw new ConflictError(
              `The lead is currently "${lead.stage}". This task can only be submitted while the lead is "${expectedStage}".`,
            );
          }
        }

        db.transaction(() => {
          const inserted = db
            .prepare(
              `INSERT INTO dept_updates
                (task_id, department, employee_id, findings, recommendation, status, attachments)
               VALUES (?, ?, ?, ?, ?, 'Submitted', ?)`,
            )
            .run(task.id, task.department, req.user.id, findings, recommendation, attachments);

          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE tasks SET response = ?, status = 'Submitted',
                                submitted_at = datetime('now'), updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(findings, task.id, req.body.expected_version);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE tasks SET response = ?, status = 'Submitted',
                                submitted_at = datetime('now'), updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ?`,
            ).run(findings, task.id);
          }

          if (lead) {
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
              task.assigned_by,
              task.department,
              `[${task.department}] ${req.user.name} submitted: ${findings}`,
              lead.stage,
              'Update Received',
            );
          }

          notifyCentral(
            db,
            'UPDATE_SUBMITTED',
            `${task.department} update received from ${req.user.name} on task ${task.id}.`,
            '#taskboard',
            'task',
            task.id,
          );
          audit(
            db,
            req.user.id,
            'SUBMIT_RESPONSE',
            'task',
            task.id,
            `Submitted ${task.department} findings (dept_update ${inserted.lastInsertRowid})`,
            null,
            null,
            req.ip,
          );
        })();

        res.json({ ok: true, task_id: task.id, status: 'Submitted', version: task.version + 1 });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/tasks/:id/review',
    auth,
    requireCentral(),
    validate({ body: taskReviewSchema }),
    (req, res, next) => {
      try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!task) throw new NotFoundError('Task not found.');
        if (task.status !== 'Submitted') {
          throw new ConflictError('Only a submitted task can be reviewed.');
        }

        checkOptimisticLock(task.version, req.body.expected_version);

        const remarks = sanitizeText(req.body.review_remarks, 4000);
        const nextAction = sanitizeText(req.body.next_action, 2000);

        db.transaction(() => {
          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE tasks SET reviewed_by = ?, review_remarks = ?, reviewed_at = datetime('now'),
                                status = 'Reviewed', updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(req.user.id, remarks, task.id, req.body.expected_version);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE tasks SET reviewed_by = ?, review_remarks = ?, reviewed_at = datetime('now'),
                                status = 'Reviewed', updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ?`,
            ).run(req.user.id, remarks, task.id);
          }

          db.prepare(
            "UPDATE dept_updates SET status = 'Reviewed' WHERE task_id = ? AND status = 'Submitted'",
          ).run(task.id);

          if (task.lead_id) {
            logAction(
              db,
              task.lead_id,
              'ADMIN_REVIEW',
              req.user.id,
              task.assigned_to,
              task.department,
              `Admin Desk reviewed the update: ${remarks}${nextAction ? ` Next: ${nextAction}` : ''}`,
              null,
              null,
            );
          }

          notify(
            db,
            task.assigned_to,
            'TASK_REVIEWED',
            `Admin Desk reviewed task ${task.id}: ${remarks}`,
            '#tasks',
            'task',
            task.id,
          );
          audit(db, req.user.id, 'REVIEW', 'task', task.id, remarks, null, null, req.ip);
        })();

        res.json({ ok: true, task_id: task.id, status: 'Reviewed', version: task.version + 1 });
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin Desk sends submitted task back to department for rework
  app.post(
    '/api/tasks/:id/rework',
    auth,
    requireCentral(),
    validate({ body: taskReworkSchema }),
    (req, res, next) => {
      try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!task) throw new NotFoundError('Task not found.');
        if (task.status !== 'Submitted') {
          throw new ConflictError('Only a submitted task can be sent for rework.');
        }

        checkOptimisticLock(task.version, req.body.expected_version);

        const notes = sanitizeText(req.body.rework_notes, 4000);
        const lead = task.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id) : null;
        const routedStage = DEPARTMENT_STAGE[task.department] || (lead ? lead.stage : 'Routed to ' + task.department);

        const currentReworkCount = Number(task.rework_count) || 0;
        const newReworkCount = currentReworkCount + 1;
        const isEscalated = currentReworkCount >= 2;

        const superAdmin = isEscalated
          ? db.prepare("SELECT id FROM employees WHERE role = 'SUPER_ADMIN' AND active = 1 ORDER BY id ASC LIMIT 1").get()
          : null;
        const targetAssignee = isEscalated && superAdmin ? superAdmin.id : task.assigned_to;
        const targetStatus = isEscalated ? 'In Progress' : 'In Progress';
        const targetPriority = isEscalated ? 'Urgent' : (task.priority || 'Medium');

        db.transaction(() => {
          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE tasks SET status = ?, review_remarks = ?, rework_count = ?,
                                priority = ?, assigned_to = ?, escalated_to = ?, escalated_at = ?,
                                updated_at = datetime('now'), version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(
              targetStatus,
              isEscalated ? `Auto-escalated to Super Admin after ${currentReworkCount} reworks: ${notes}` : `Rework requested: ${notes}`,
              newReworkCount,
              targetPriority,
              targetAssignee,
              isEscalated && superAdmin ? superAdmin.id : null,
              isEscalated ? new Date().toISOString() : null,
              task.id,
              req.body.expected_version,
            );
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE tasks SET status = ?, review_remarks = ?, rework_count = ?,
                                priority = ?, assigned_to = ?, escalated_to = ?, escalated_at = ?,
                                updated_at = datetime('now'), version = version + 1
               WHERE id = ?`,
            ).run(
              targetStatus,
              isEscalated ? `Auto-escalated to Super Admin after ${currentReworkCount} reworks: ${notes}` : `Rework requested: ${notes}`,
              newReworkCount,
              targetPriority,
              targetAssignee,
              isEscalated && superAdmin ? superAdmin.id : null,
              isEscalated ? new Date().toISOString() : null,
              task.id,
            );
          }

          if (lead && lead.stage === 'Update Received') {
            db.prepare(
              `UPDATE leads SET stage = ?, current_owner = ?, updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ?`,
            ).run(routedStage, targetAssignee, lead.id);

            logAction(
              db,
              lead.id,
              isEscalated ? 'TASK_ESCALATED' : 'TASK_REWORK',
              req.user.id,
              targetAssignee,
              task.department,
              isEscalated
                ? `Task rework exceeded threshold (${currentReworkCount} reworks). Escalated to Super Admin: ${notes}`
                : `Admin Desk requested rework: ${notes}`,
              lead.stage,
              routedStage,
            );
          }

          if (isEscalated && superAdmin) {
            notify(
              db,
              superAdmin.id,
              'TASK_ASSIGNED',
              `ESCALATION: Task ${task.id} exceeded max rework count (${currentReworkCount}). Super Admin review required: ${notes}`,
              '#tasks',
              'task',
              task.id,
            );
          } else {
            notify(
              db,
              task.assigned_to,
              'TASK_REWORK',
              `Admin Desk requested rework on task ${task.id}: ${notes}`,
              '#tasks',
              'task',
              task.id,
            );
          }

          audit(
            db,
            req.user.id,
            isEscalated ? 'ESCALATE_TASK' : 'REWORK_TASK',
            'task',
            task.id,
            isEscalated ? `Escalated after ${currentReworkCount} reworks: ${notes}` : `Rework requested: ${notes}`,
            { status: 'Submitted', rework_count: currentReworkCount },
            { status: targetStatus, rework_count: newReworkCount, escalated: isEscalated },
            req.ip,
          );
        })();

        res.json({
          ok: true,
          task_id: task.id,
          status: targetStatus,
          rework_count: newReworkCount,
          escalated: isEscalated,
          version: task.version + 1,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin Desk reassigns an open task to another active employee in the same department
  app.post(
    '/api/tasks/:id/reassign',
    auth,
    requireCentral(),
    validate({ body: taskReassignSchema }),
    (req, res, next) => {
      try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!task) throw new NotFoundError('Task not found.');
        if (!['Assigned', 'In Progress'].includes(task.status)) {
          throw new ConflictError(`Cannot reassign a task in "${task.status}" status.`);
        }

        checkOptimisticLock(task.version, req.body.expected_version);

        const newAssigneeId = String(req.body.new_assigned_to);
        if (newAssigneeId === task.assigned_to) {
          throw new ValidationError('Task is already assigned to this employee.');
        }

        const newEmployee = db
          .prepare('SELECT id, name, role, department, active FROM employees WHERE id = ?')
          .get(newAssigneeId);

        if (!newEmployee || !newEmployee.active) {
          throw new ValidationError('Assignee must be an active employee.');
        }

        const allowedRoles = DEPARTMENT_ROLES[task.department] || [];
        if (!allowedRoles.includes(newEmployee.role)) {
          throw new ForbiddenError(
            `Cannot reassign across departments. Employee ${newEmployee.name} (${newEmployee.role}) is not in ${task.department}.`,
          );
        }

        const reason = sanitizeText(req.body.reason, 2000);
        const lead = task.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id) : null;
        const leadColumn = DEPARTMENT_LEAD_COLUMN[task.department];

        db.transaction(() => {
          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE tasks SET assigned_to = ?, updated_at = datetime('now'), version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(newEmployee.id, task.id, req.body.expected_version);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE tasks SET assigned_to = ?, updated_at = datetime('now'), version = version + 1
               WHERE id = ?`,
            ).run(newEmployee.id, task.id);
          }

          if (lead) {
            const assignments = ['current_owner = ?', "updated_at = datetime('now')", 'version = version + 1'];
            const params = [newEmployee.id];
            if (leadColumn) {
              assignments.push(`${leadColumn} = ?`);
              params.push(newEmployee.id);
            }
            params.push(lead.id);

            db.prepare(`UPDATE leads SET ${assignments.join(', ')} WHERE id = ?`).run(...params);

            logAction(
              db,
              lead.id,
              'TASK_REASSIGNED',
              req.user.id,
              newEmployee.id,
              task.department,
              `Task ${task.id} reassigned to ${newEmployee.name}: ${reason}`,
              lead.stage,
              lead.stage,
            );
          }

          notify(
            db,
            newEmployee.id,
            'TASK_ASSIGNED',
            `Task ${task.id} reassigned to you: ${task.brief}`,
            '#tasks',
            'task',
            task.id,
          );

          audit(
            db,
            req.user.id,
            'REASSIGN_TASK',
            'task',
            task.id,
            `Reassigned from ${task.assigned_to} to ${newEmployee.id}: ${reason}`,
            { assigned_to: task.assigned_to },
            { assigned_to: newEmployee.id },
            req.ip,
          );
        })();

        res.json({ ok: true, task_id: task.id, assigned_to: newEmployee.id, version: task.version + 1 });
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin Desk reopens a Reviewed or Closed task
  app.post(
    '/api/tasks/:id/reopen',
    auth,
    requireCentral(),
    validate({ body: taskReopenSchema }),
    (req, res, next) => {
      try {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
        if (!task) throw new NotFoundError('Task not found.');
        if (!['Reviewed', 'Closed'].includes(task.status)) {
          throw new ConflictError(`Only a Reviewed or Closed task can be reopened (current: "${task.status}").`);
        }

        checkOptimisticLock(task.version, req.body.expected_version);

        const reason = sanitizeText(req.body.reopen_reason, 2000);
        const lead = task.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(task.lead_id) : null;
        const targetStage = DEPARTMENT_STAGE[task.department] || (lead ? lead.stage : 'Routed to ' + task.department);

        db.transaction(() => {
          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE tasks SET status = 'Assigned', review_remarks = NULL, reviewed_by = NULL,
                                reviewed_at = NULL, updated_at = datetime('now'), version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(task.id, req.body.expected_version);
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE tasks SET status = 'Assigned', review_remarks = NULL, reviewed_by = NULL,
                                reviewed_at = NULL, updated_at = datetime('now'), version = version + 1
               WHERE id = ?`,
            ).run(task.id);
          }

          if (lead) {
            db.prepare(
              `UPDATE leads SET stage = ?, current_owner = ?, updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ?`,
            ).run(targetStage, task.assigned_to, lead.id);

            logAction(
              db,
              lead.id,
              'TASK_REOPENED',
              req.user.id,
              task.assigned_to,
              task.department,
              `Task ${task.id} reopened by Admin Desk: ${reason}`,
              lead.stage,
              targetStage,
            );
          }

          notify(
            db,
            task.assigned_to,
            'TASK_REOPENED',
            `Task ${task.id} was reopened by Admin Desk: ${reason}`,
            '#tasks',
            'task',
            task.id,
          );

          audit(
            db,
            req.user.id,
            'REOPEN_TASK',
            'task',
            task.id,
            `Reopened task: ${reason}`,
            { status: task.status },
            { status: 'Assigned' },
            req.ip,
          );
        })();

        res.json({ ok: true, task_id: task.id, status: 'Assigned', version: task.version + 1 });
      } catch (err) {
        next(err);
      }
    },
  );
};
