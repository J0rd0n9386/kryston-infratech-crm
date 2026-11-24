/**
 * Employee notification inbox. Every query is scoped to the signed-in employee;
 * no role can read another employee's notifications.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { toInt } = require('../middleware/validate');
const { ValidationError } = require('../middleware/errors');

module.exports = function registerNotificationRoutes(app, db) {
  app.get('/api/notifications', auth, (req, res) => {
    const limit = Math.min(Math.max(toInt(req.query.limit, 100) || 100, 1), 200);
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unread || '').toLowerCase());
    const rows = db
      .prepare(
        `SELECT * FROM notifications
         WHERE employee_id = ?${unreadOnly ? ' AND read_at IS NULL' : ''}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(req.user.id, limit);
    res.json(rows);
  });

  app.get('/api/notifications/unread-count', auth, (req, res) => {
    const row = db
      .prepare(
        'SELECT count(*) AS c FROM notifications WHERE employee_id = ? AND read_at IS NULL',
      )
      .get(req.user.id);
    res.json({ unread: row.c });
  });

  app.patch('/api/notifications/:id/read', auth, (req, res, next) => {
    try {
      const id = toInt(req.params.id, null);
      if (id === null) throw new ValidationError('Invalid notification id.');
      const result = db
        .prepare(
          "UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND employee_id = ? AND read_at IS NULL",
        )
        .run(id, req.user.id);
      res.json({ ok: true, updated: result.changes });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/notifications/read-all', auth, (req, res) => {
    const result = db
      .prepare(
        "UPDATE notifications SET read_at = datetime('now') WHERE employee_id = ? AND read_at IS NULL",
      )
      .run(req.user.id);
    res.json({ ok: true, updated: result.changes });
  });
};
