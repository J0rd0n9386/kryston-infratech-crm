/**
 * Reminder endpoints: creation, listing, snooze, and dismiss.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const { validate, z } = require('../middleware/validate');
const {
  createReminder,
  snoozeReminder,
  dismissReminder,
} = require('../lib/services/reminder-service');

const createReminderSchema = z.object({
  type: z.enum(['CALL_BACK', 'CUSTOMER_WILL_CALL', 'FOLLOW_UP']),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must use YYYY-MM-DD format'),
  note: z.string().trim().max(4000).optional().nullable(),
  task_id: z.string().trim().optional().nullable(),
}).strict();

const snoozeReminderSchema = z.object({
  days: z.coerce.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must use YYYY-MM-DD format').optional(),
  snooze_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'snooze_until must use YYYY-MM-DD format').optional(),
  note: z.string().trim().max(4000).optional().nullable(),
  reason: z.string().trim().max(4000).optional().nullable(),
}).strict();

const dismissReminderSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(2000),
}).strict();

module.exports = function registerReminderRoutes(app, db) {
  // POST /api/leads/:id/reminders - Admin Desk, Super Admin
  app.post(
    '/api/leads/:id/reminders',
    auth,
    requireCentral(),
    validate({ body: createReminderSchema }),
    (req, res, next) => {
      try {
        const result = createReminder(db, req.user, req.params.id, req.body);
        res.status(201).json({ ok: true, reminder: result });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/reminders?status= - Admin Desk sees all; others see their assigned/created read-only
  app.get('/api/reminders', auth, (req, res, next) => {
    try {
      const conditions = [];
      const params = [];

      if (!isCentral(req.user)) {
        conditions.push('(r.created_by = ? OR t.assigned_to = ?)');
        params.push(req.user.id, req.user.id);
      }

      if (req.query.status) {
        conditions.push('r.status = ?');
        params.push(req.query.status);
      }

      const sql = `
        SELECT r.*,
               l.customer_name, l.phone, l.stage AS lead_stage,
               creator.name AS creator_name,
               assignee.name AS assignee_name
        FROM reminders r
        JOIN leads l ON l.id = r.lead_id
        LEFT JOIN tasks t ON t.id = r.task_id
        LEFT JOIN employees creator ON creator.id = r.created_by
        LEFT JOIN employees assignee ON assignee.id = t.assigned_to
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY
          CASE r.status WHEN 'TRIGGERED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
          r.due_date ASC, r.created_at DESC
        LIMIT 500
      `;

      const rows = db.prepare(sql).all(...params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/reminders/:id/snooze - Admin Desk, Super Admin
  app.post(
    '/api/reminders/:id/snooze',
    auth,
    requireCentral(),
    validate({ body: snoozeReminderSchema }),
    (req, res, next) => {
      try {
        const result = snoozeReminder(db, req.user, req.params.id, req.body);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/reminders/:id/dismiss - Admin Desk, Super Admin
  app.post(
    '/api/reminders/:id/dismiss',
    auth,
    requireCentral(),
    validate({ body: dismissReminderSchema }),
    (req, res, next) => {
      try {
        const result = dismissReminder(db, req.user, req.params.id, req.body);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );
};
