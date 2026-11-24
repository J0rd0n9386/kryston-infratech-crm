/**
 * Central audit trail and system diagnostics.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral } = require('../middleware/rbac');
const { toInt } = require('../middleware/validate');
const { verifySchemaIntegrity, getDatabaseStats, SCHEMA_METADATA } = require('../db/schema');

module.exports = function registerAuditRoutes(app, db) {
  app.get('/api/audit', auth, requireCentral(), (req, res) => {
    const limit = Math.min(Math.max(toInt(req.query.limit, 500) || 500, 1), 1000);
    const offset = Math.max(toInt(req.query.offset, 0) || 0, 0);
    const conditions = [];
    const params = [];
    if (req.query.action) {
      conditions.push('a.action = ?');
      params.push(String(req.query.action));
    }
    if (req.query.entity_type) {
      conditions.push('a.entity_type = ?');
      params.push(String(req.query.entity_type));
    }
    if (req.query.actor_id) {
      conditions.push('a.actor_id = ?');
      params.push(String(req.query.actor_id));
    }

    const rows = db
      .prepare(
        `SELECT a.*, e.name AS actor_name, e.role AS actor_role
         FROM audit_log a
         LEFT JOIN employees e ON e.id = a.actor_id
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    const total = db
      .prepare(
        `SELECT count(*) AS c FROM audit_log a
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
      )
      .get(...params).c;

    res.json({ total, limit, offset, rows });
  });

  app.get('/api/audit/system-health', auth, requireCentral(), (req, res, next) => {
    try {
      const integrity = verifySchemaIntegrity(db);
      const stats = getDatabaseStats(db);
      res.json({ ok: integrity.valid, schema: SCHEMA_METADATA, integrity, stats });
    } catch (err) {
      next(err);
    }
  });
};
