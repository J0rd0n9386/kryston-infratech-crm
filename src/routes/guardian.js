'use strict';
const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const { validate, z } = require('../middleware/validate');
const { NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { audit, notifyCentral } = require('../lib/audit-notify');

module.exports = function registerGuardian(app, db) {
  app.post('/api/tasks/:id/contact-permission', auth, requireCentral(), validate({ body: z.object({
    allowed: z.boolean(), purpose: z.string().trim().min(1).max(1000),
    channels: z.array(z.enum(['Call', 'WhatsApp', 'Email', 'Site Visit'])).max(4).optional().default([]),
    expires_at: z.string().datetime(), expected_version: z.number().int().positive(),
  }).strict() }), (req, res, next) => {
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
      if (!task) throw new NotFoundError('Task not found.');
      if (!['Assigned', 'In Progress'].includes(task.status)) throw new ConflictError('Only active assignments can receive contact permission.');
      if (req.body.allowed && Date.parse(req.body.expires_at) <= Date.now()) throw new ConflictError('Choose a future expiry time.');
      db.transaction(() => {
        const result = db.prepare(`UPDATE tasks SET requires_contact = ?, contact_authorized_to = ?,
          contact_purpose = ?, contact_channels = ?, contact_expires_at = ?, contact_status = ?, version = version + 1
          WHERE id = ? AND version = ?`).run(Number(req.body.allowed), req.body.allowed ? task.assigned_to : null,
          req.body.purpose, JSON.stringify(req.body.allowed ? req.body.channels : []), req.body.expires_at,
          req.body.allowed ? 'NOT_CONTACTED' : 'NOT_REQUIRED', task.id, req.body.expected_version);
        if (!result.changes) throw new ConflictError('Assignment changed. Refresh before deciding.');
        audit(db, req.user.id, 'CONTACT_PERMISSION', 'task', task.id, req.body.purpose, task, req.body);
      })();
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/admin-requests', auth, (req, res) => {
    const central = isCentral(req.user);
    res.json(db.prepare(`SELECT r.*, t.lead_id, l.customer_name, e.name AS requester_name
      FROM admin_requests r JOIN tasks t ON t.id = r.task_id
      JOIN leads l ON l.id = t.lead_id JOIN employees e ON e.id = r.requested_by
      ${central ? '' : 'WHERE r.requested_by = ?'} ORDER BY r.status, r.created_at DESC LIMIT 200`)
      .all(...(central ? [] : [req.user.id])));
  });
  app.post('/api/tasks/:id/admin-request', auth, validate({ body: z.object({
    message: z.string().trim().min(1).max(4000),
    target_department: z.enum(['Sales','Technical','Design','Purchase','Accounts','Projects','Marketing']).optional().nullable(),
    due_at: z.string().datetime().optional().nullable(),
  }).strict() }), (req, res, next) => {
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
      if (!task || task.assigned_to !== req.user.id) throw new ForbiddenError('Only the assigned employee can request clarification.');
      const result = db.transaction(() => {
        const row = db.prepare(`INSERT INTO admin_requests
          (task_id, requested_by, message, target_department, due_at) VALUES (?, ?, ?, ?, ?)`)
          .run(task.id, req.user.id, req.body.message, req.body.target_department || null, req.body.due_at || null);
        notifyCentral(db, 'ADMIN_REQUEST', req.body.message, `#tasks`, 'task', task.id);
        audit(db, req.user.id, 'ADMIN_REQUEST', 'task', task.id, req.body.message);
        return row;
      })();
      res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) { next(error); }
  });
  app.post('/api/admin-requests/:id/resolve', auth, requireCentral(), validate({ body: z.object({ response: z.string().trim().min(1).max(4000) }).strict() }), (req, res, next) => {
    try {
      db.transaction(() => {
        const result = db.prepare(`UPDATE admin_requests SET status = 'Resolved', response = ?, resolved_by = ?,
          resolved_at = datetime('now') WHERE id = ? AND status = 'Open'`).run(req.body.response, req.user.id, req.params.id);
        if (!result.changes) throw new ConflictError('Request already resolved or unavailable.');
        audit(db, req.user.id, 'RESOLVE_ADMIN_REQUEST', 'admin_request', req.params.id, req.body.response);
      })();
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.post('/api/admin-requests/:id/acknowledge', auth, (req, res, next) => {
    try {
      const request = db.prepare('SELECT * FROM admin_requests WHERE id = ?').get(req.params.id);
      if (!request || request.requested_by !== req.user.id || request.status !== 'Resolved') {
        throw new ForbiddenError('Only the requester can acknowledge a resolved request.');
      }
      db.prepare('UPDATE admin_requests SET acknowledged_at = datetime(\'now\') WHERE id = ?').run(request.id);
      audit(db, req.user.id, 'ACKNOWLEDGE_ADMIN_RESPONSE', 'admin_request', request.id, 'Response acknowledged');
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
};
