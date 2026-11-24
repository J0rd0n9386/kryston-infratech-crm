/**
 * Telecaller qualification desk.
 *
 * A telecaller can only work assigned leads, and every enquiry is returned to
 * Admin Desk. There is no direct telecaller-to-sales path.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireRole, isCentral } = require('../middleware/rbac');
const {
  requireFields,
  sanitizeText,
  assertEnum,
  toInt,
  isIsoDate,
  validate,
  z,
} = require('../middleware/validate');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { getSlaStatus } = require('../lib/sla');
const { audit, notifyCentral, logAction, firstActiveAdminId } = require('../lib/audit-notify');

const INTENTS = ['Hot', 'Warm', 'Cold', 'Not Interested'];
const OUTCOMES = ['Connected', 'No Answer', 'Busy', 'Callback Requested', 'Invalid Number'];

const telecallerRespondSchema = z.object({
  lead_id: z.string().trim().min(1, 'Lead ID is required.'),
  task_id: z.string().trim().optional().nullable(),
  call_outcome: z.enum(OUTCOMES),
  customer_intent: z.enum(INTENTS).optional().nullable(),
  call_duration_seconds: z.coerce.number().int().min(0).max(86400).optional().nullable(),
  call_duration_minutes: z.coerce.number().min(0).max(1440).optional().nullable(),
  next_followup: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'next_followup must use YYYY-MM-DD format').or(z.literal('')).optional().nullable(),
  budget_range: z.string().trim().max(80).optional().nullable(),
  timeline: z.string().trim().max(80).optional().nullable(),
  area: z.string().trim().max(80).optional().nullable(),
  requirement_detail: z.string().trim().max(4000).optional().nullable(),
  objections: z.string().trim().max(4000).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

module.exports = function registerTelecallerRoutes(app, db) {
  app.get(
    '/api/telecaller/leads',
    auth,
    requireRole('TELECALLER', 'ADMIN_DESK', 'SUPER_ADMIN'),
    (req, res) => {
      const base = `
        SELECT l.*,
               tc.name AS telecaller_name,
               (SELECT t.id FROM tasks t
                 WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
                   AND t.status IN ('Assigned','In Progress','Submitted')
                 ORDER BY t.created_at DESC LIMIT 1) AS task_id,
               (SELECT t.brief FROM tasks t
                 WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
                   AND t.status IN ('Assigned','In Progress','Submitted')
                 ORDER BY t.created_at DESC LIMIT 1) AS task_brief,
               (SELECT t.due_date FROM tasks t
                 WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
                   AND t.status IN ('Assigned','In Progress','Submitted')
                 ORDER BY t.created_at DESC LIMIT 1) AS task_due_date,
               (SELECT t.status FROM tasks t
                 WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
                   AND t.status IN ('Assigned','In Progress','Submitted')
                 ORDER BY t.created_at DESC LIMIT 1) AS task_status,
               (SELECT t.created_at FROM tasks t
                 WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
                   AND t.status IN ('Assigned','In Progress','Submitted')
                 ORDER BY t.created_at DESC LIMIT 1) AS task_created_at,
               (SELECT t.sla_hours FROM tasks t
                 WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
                   AND t.status IN ('Assigned','In Progress','Submitted')
                 ORDER BY t.created_at DESC LIMIT 1) AS task_sla_hours,
               (SELECT tr.id FROM telecaller_responses tr
                 WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS previous_response_id,
               (SELECT tr.customer_intent FROM telecaller_responses tr
                 WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS customer_intent,
               (SELECT tr.call_outcome FROM telecaller_responses tr
                 WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS call_outcome,
               (SELECT tr.notes FROM telecaller_responses tr
                 WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS last_notes
        FROM leads l
        LEFT JOIN employees tc ON tc.id = l.assigned_telecaller
      `;

      let rows;
      if (isCentral(req.user)) {
        rows = db
          .prepare(
            `${base}
             WHERE l.deleted_at IS NULL
               AND l.stage IN ('With Telecaller', 'Response Received')
             ORDER BY l.updated_at DESC LIMIT 500`,
          )
          .all();
      } else {
        rows = db
          .prepare(
            `${base}
             WHERE l.deleted_at IS NULL AND l.assigned_telecaller = ?
             ORDER BY
               CASE WHEN l.stage = 'With Telecaller' THEN 0 ELSE 1 END,
               l.updated_at DESC
             LIMIT 500`,
          )
          .all(req.user.id);
      }

      res.json(
        rows.map((row) => ({
          ...row,
          sla: row.task_created_at
            ? getSlaStatus(row.task_created_at, row.task_sla_hours || 24)
            : null,
        })),
      );
    },
  );

  app.post(
    '/api/telecaller/respond',
    auth,
    requireRole('TELECALLER'),
    validate({ body: telecallerRespondSchema }),
    (req, res, next) => {
      try {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.body.lead_id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        if (lead.assigned_telecaller !== req.user.id) {
          throw new ForbiddenError('This lead is not assigned to you.');
        }
        if (lead.stage !== 'With Telecaller') {
          throw new ConflictError('This lead is not awaiting a telecaller response.');
        }

        const callOutcome = assertEnum(String(req.body.call_outcome), OUTCOMES, 'call_outcome');
        const customerIntent = req.body.customer_intent
          ? assertEnum(String(req.body.customer_intent), INTENTS, 'customer_intent')
          : 'Warm';
        const rawDuration = req.body.call_duration_seconds != null
          ? toInt(req.body.call_duration_seconds, 0)
          : (req.body.call_duration_minutes != null ? Math.round(Number(req.body.call_duration_minutes) * 60) : 0);
        const callDuration = Math.max(0, Math.min(rawDuration || 0, 86400));
        const nextFollowup = req.body.next_followup || null;
        if (nextFollowup && !isIsoDate(nextFollowup)) {
          throw new ValidationError('next_followup must use the YYYY-MM-DD format.');
        }

        const task = req.body.task_id
          ? db
              .prepare(
                `SELECT * FROM tasks WHERE id = ? AND lead_id = ? AND assigned_to = ?
                 AND task_type = 'TELECALLER_ENQUIRY'`,
              )
              .get(req.body.task_id, lead.id, req.user.id)
          : db
              .prepare(
                `SELECT * FROM tasks WHERE lead_id = ? AND assigned_to = ?
                 AND task_type = 'TELECALLER_ENQUIRY' AND status IN ('Assigned','In Progress')
                 ORDER BY created_at DESC LIMIT 1`,
              )
              .get(lead.id, req.user.id);

        if (!task) throw new ConflictError('No open enquiry task is assigned to you for this lead.');
        if (!['Assigned', 'In Progress'].includes(task.status)) {
          throw new ConflictError('This enquiry task has already been submitted.');
        }

        if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
          if (Number(req.body.expected_version) !== Number(task.version)) {
            throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
          }
        }

        const budget = sanitizeText(req.body.budget_range, 80);
        const timeline = sanitizeText(req.body.timeline, 80);
        const area = sanitizeText(req.body.area, 80);
        const requirement = sanitizeText(req.body.requirement_detail, 4000);
        const objections = sanitizeText(req.body.objections, 4000);
        const notes = sanitizeText(req.body.notes, 4000);

        db.transaction(() => {
          const inserted = db
            .prepare(
              `INSERT INTO telecaller_responses
                (lead_id, task_id, telecaller_id, customer_intent, budget_range, timeline, area,
                 requirement_detail, objections, call_outcome, call_duration_seconds,
                 next_followup, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              lead.id,
              task.id,
              req.user.id,
              customerIntent,
              budget,
              timeline,
              area,
              requirement,
              objections,
              callOutcome,
              callDuration,
              nextFollowup,
              notes,
            );

          let updateRes;
          if (req.body.expected_version !== undefined && req.body.expected_version !== null) {
            updateRes = db.prepare(
              `UPDATE tasks SET status = 'Submitted', response = ?,
                                submitted_at = datetime('now'), updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ? AND version = ?`,
            ).run(
              `Outcome: ${callOutcome}. Intent: ${customerIntent}. ${notes || ''}`.trim(),
              task.id,
              req.body.expected_version,
            );
            if (updateRes.changes === 0) {
              throw new ConflictError('This record was modified by another user (stale version). Please refresh and try again.');
            }
          } else {
            db.prepare(
              `UPDATE tasks SET status = 'Submitted', response = ?,
                                submitted_at = datetime('now'), updated_at = datetime('now'),
                                version = version + 1
               WHERE id = ?`,
            ).run(
              `Outcome: ${callOutcome}. Intent: ${customerIntent}. ${notes || ''}`.trim(),
              task.id,
            );
          }

          const adminId = firstActiveAdminId(db);
          db.prepare(
            `UPDATE leads
             SET stage = 'Response Received', current_owner = ?,
                 budget_range = COALESCE(?, budget_range),
                 timeline = COALESCE(?, timeline),
                 area = COALESCE(?, area),
                 updated_at = datetime('now'),
                 version = version + 1
             WHERE id = ?`,
          ).run(adminId, budget, timeline, area, lead.id);

          logAction(
            db,
            lead.id,
            'TELECALLER_RESPONSE',
            req.user.id,
            adminId,
            'Administration',
            `Enquiry submitted by ${req.user.name}. Outcome: ${callOutcome}. Intent: ${customerIntent}. ${notes || ''}`.trim(),
            lead.stage,
            'Response Received',
          );

          notifyCentral(
            db,
            'UPDATE_SUBMITTED',
            `Telecaller ${req.user.name} submitted an enquiry for ${lead.id} (${lead.customer_name}). Ready for routing.`,
            '#taskboard',
            'lead',
            lead.id,
          );

          audit(
            db,
            req.user.id,
            'SUBMIT_ENQUIRY',
            'telecaller_response',
            String(inserted.lastInsertRowid),
            `Lead ${lead.id}, outcome ${callOutcome}, intent ${customerIntent}`,
            null,
            null,
            req.ip,
          );
        })();

        res.status(201).json({ ok: true, lead_id: lead.id, stage: 'Response Received' });
      } catch (err) {
        next(err);
      }
    },
  );
};
