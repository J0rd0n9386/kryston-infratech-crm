/**
 * Workflow engine management routes.
 *
 * Exposes administrative endpoints for approval matrix rules, authority delegations,
 * auto-routing rules and SLA settings.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral } = require('../middleware/rbac');
const { z, validate } = require('../middleware/validate');
const { ValidationError, ForbiddenError, NotFoundError } = require('../middleware/errors');
const { generateId } = require('../lib/id-generator');
const { audit } = require('../lib/audit-notify');
const {
  createDelegation,
  revokeDelegation,
} = require('../lib/services/delegation-service');

const createApprovalRuleSchema = z.object({
  entity: z.string().trim().min(1).max(80),
  metric: z.string().trim().min(1).max(80),
  min_value: z.coerce.number().min(0),
  max_value: z.coerce.number().positive(),
  approver_role: z.enum(['SALES_MANAGER', 'SENIOR_BDM', 'SUPER_ADMIN']),
  active: z.coerce.number().int().min(0).max(1).optional().default(1),
}).strict();

const updateApprovalRuleSchema = z.object({
  min_value: z.coerce.number().min(0).optional(),
  max_value: z.coerce.number().positive().optional(),
  approver_role: z.enum(['SALES_MANAGER', 'SENIOR_BDM', 'SUPER_ADMIN']).optional(),
  active: z.coerce.number().int().min(0).max(1).optional(),
}).strict();

const createDelegationSchema = z.object({
  delegate_id: z.string().trim().min(1),
  role: z.string().trim().default('ADMIN_DESK'),
  start_at: z.string().trim().min(1),
  end_at: z.string().trim().min(1),
  reason: z.string().trim().max(1000).optional().nullable(),
}).strict();

const revokeDelegationSchema = z.object({
  reason: z.string().trim().max(1000).optional().nullable(),
}).strict();

const updateSlaSettingSchema = z.object({
  target_minutes: z.coerce.number().int().positive().optional(),
  warning_minutes: z.coerce.number().int().positive().optional(),
  active: z.coerce.number().int().min(0).max(1).optional(),
}).strict();

const createRoutingRuleSchema = z.object({
  source: z.string().trim().min(1).max(80),
  channel: z.string().trim().max(40).optional().nullable(),
  target_dept: z.string().trim().default('Marketing'),
  target_role: z.string().trim().default('TELECALLER'),
  strategy: z.enum(['ROUND_ROBIN']).default('ROUND_ROBIN'),
  active: z.coerce.number().int().min(0).max(1).optional().default(1),
}).strict();

module.exports = function registerWorkflowRuleRoutes(app, db) {
  /* ----------------------------------------------------------- Approval Rules */

  app.get('/api/approval-rules', auth, requireCentral(), (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM approval_rules ORDER BY entity, min_value ASC').all();
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/approval-rules',
    auth,
    validate({ body: createApprovalRuleSchema }),
    (req, res, next) => {
      try {
        if (req.user.role !== 'SUPER_ADMIN') {
          throw new ForbiddenError('Only Super Admin can configure approval matrix rules.');
        }
        if (req.body.min_value >= req.body.max_value) {
          throw new ValidationError('max_value must be greater than min_value.');
        }

        const id = generateId(db, 'KRY-APPR', 'approval_rules');
        db.prepare(`
          INSERT INTO approval_rules (id, entity, metric, min_value, max_value, approver_role, active, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        `).run(
          id,
          req.body.entity,
          req.body.metric,
          req.body.min_value,
          req.body.max_value,
          req.body.approver_role,
          req.body.active ?? 1,
        );

        audit(
          db,
          req.user.id,
          'CREATE',
          'approval_rule',
          id,
          `Created approval rule for ${req.body.entity} (${req.body.min_value}-${req.body.max_value}) -> ${req.body.approver_role}`,
          null,
          req.body,
          req.ip,
        );

        const row = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(id);
        res.status(201).json(row);
      } catch (err) {
        next(err);
      }
    },
  );

  app.patch(
    '/api/approval-rules/:id',
    auth,
    validate({ body: updateApprovalRuleSchema }),
    (req, res, next) => {
      try {
        if (req.user.role !== 'SUPER_ADMIN') {
          throw new ForbiddenError('Only Super Admin can update approval matrix rules.');
        }
        const existing = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(req.params.id);
        if (!existing) throw new NotFoundError('Approval rule not found.');

        const minVal = req.body.min_value !== undefined ? req.body.min_value : existing.min_value;
        const maxVal = req.body.max_value !== undefined ? req.body.max_value : existing.max_value;
        if (minVal >= maxVal) {
          throw new ValidationError('max_value must be greater than min_value.');
        }

        const approverRole = req.body.approver_role || existing.approver_role;
        const active = req.body.active !== undefined ? req.body.active : existing.active;

        db.prepare(`
          UPDATE approval_rules
          SET min_value = ?, max_value = ?, approver_role = ?, active = ?, version = version + 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(minVal, maxVal, approverRole, active, existing.id);

        audit(
          db,
          req.user.id,
          'UPDATE',
          'approval_rule',
          existing.id,
          `Updated approval rule ${existing.id}`,
          existing,
          { min_value: minVal, max_value: maxVal, approver_role: approverRole, active },
          req.ip,
        );

        const updated = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(existing.id);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  /* ------------------------------------------------------------- Delegations */

  app.get('/api/delegations', auth, requireCentral(), (req, res, next) => {
    try {
      const rows = db.prepare(`
        SELECT d.*, g.name AS granter_name, del.name AS delegate_name, del.role AS delegate_role
        FROM delegations d
        LEFT JOIN employees g ON g.id = d.granter_id
        LEFT JOIN employees del ON del.id = d.delegate_id
        ORDER BY d.created_at DESC
      `).all();
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/delegations',
    auth,
    validate({ body: createDelegationSchema }),
    (req, res, next) => {
      try {
        const result = createDelegation(db, req.user, req.body);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/delegations/:id/revoke',
    auth,
    validate({ body: revokeDelegationSchema }),
    (req, res, next) => {
      try {
        const result = revokeDelegation(db, req.user, req.params.id, req.body.reason);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /* ------------------------------------------------------------ SLA Settings */

  app.get('/api/sla-settings', auth, requireCentral(), (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM sla_settings ORDER BY id ASC').all();
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.patch(
    '/api/sla-settings/:id',
    auth,
    requireCentral(),
    validate({ body: updateSlaSettingSchema }),
    (req, res, next) => {
      try {
        const setting = db.prepare('SELECT * FROM sla_settings WHERE id = ?').get(req.params.id);
        if (!setting) throw new NotFoundError('SLA setting not found.');

        const targetMinutes = req.body.target_minutes ?? setting.target_minutes;
        const warningMinutes = req.body.warning_minutes ?? setting.warning_minutes;
        const active = req.body.active ?? setting.active;

        if (warningMinutes >= targetMinutes) {
          throw new ValidationError('warning_minutes must be strictly less than target_minutes.');
        }

        db.prepare(`
          UPDATE sla_settings
          SET target_minutes = ?, warning_minutes = ?, active = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(targetMinutes, warningMinutes, active, setting.id);

        audit(
          db,
          req.user.id,
          'UPDATE',
          'sla_setting',
          setting.id,
          `Updated SLA policy for stage "${setting.stage}"`,
          setting,
          { target_minutes: targetMinutes, warning_minutes: warningMinutes, active },
          req.ip,
        );

        const updated = db.prepare('SELECT * FROM sla_settings WHERE id = ?').get(setting.id);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  /* ----------------------------------------------------------- Routing Rules */

  app.get('/api/routing-rules', auth, requireCentral(), (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM routing_rules ORDER BY id ASC').all();
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/routing-rules',
    auth,
    requireCentral(),
    validate({ body: createRoutingRuleSchema }),
    (req, res, next) => {
      try {
        const id = generateId(db, 'KRY-ROUT', 'routing_rules');
        db.prepare(`
          INSERT INTO routing_rules (id, source, channel, target_dept, target_role, strategy, active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          id,
          req.body.source,
          req.body.channel || null,
          req.body.target_dept,
          req.body.target_role,
          req.body.strategy,
          req.body.active ?? 1,
        );

        audit(
          db,
          req.user.id,
          'CREATE',
          'routing_rule',
          id,
          `Created auto-routing rule for source "${req.body.source}" -> ${req.body.target_role}`,
          null,
          req.body,
          req.ip,
        );

        const row = db.prepare('SELECT * FROM routing_rules WHERE id = ?').get(id);
        res.status(201).json(row);
      } catch (err) {
        next(err);
      }
    },
  );
};
