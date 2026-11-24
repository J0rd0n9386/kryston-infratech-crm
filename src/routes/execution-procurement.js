/**
 * Execution, Change Orders, Procurement, and Customer Updates Routes.
 *
 * Implements change order management with integer paise deltas, purchase request
 * approvals, and branded customer progress dispatch.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const { z, validate } = require('../middleware/validate');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { generateId } = require('../lib/id-generator');
const { audit, notify, notifyCentral, logAction } = require('../lib/audit-notify');

const createChangeOrderSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  cost_delta_paise: z.coerce.number().int().default(0),
  schedule_delta_days: z.coerce.number().int().default(0),
  customer_approval_ref: z.string().trim().max(100).optional().nullable(),
}).strict();

const approveChangeOrderSchema = z.object({
  customer_approval_ref: z.string().trim().min(1, 'Customer signed approval reference is required.'),
  remarks: z.string().trim().max(1000).optional().nullable(),
}).strict();

const createPurchaseRequestSchema = z.object({
  item_name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(80).optional().nullable(),
  quantity: z.coerce.number().positive(),
  unit: z.string().trim().max(40).optional().default('nos'),
  estimated_cost_paise: z.coerce.number().int().min(0).default(0),
  urgency: z.enum(['Normal', 'Urgent', 'Critical']).default('Normal'),
}).strict();

const updateProcurementStatusSchema = z.object({
  status: z.enum(['Procuring', 'Fulfilled', 'Rejected']),
  notes: z.string().trim().max(1000).optional().nullable(),
}).strict();

const createCustomerUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(5000),
  update_type: z.enum(['WEEKLY_PROGRESS', 'MILESTONE_REACHED', 'SITE_PHOTOS']).default('WEEKLY_PROGRESS'),
  photos_count: z.coerce.number().int().min(0).default(0),
}).strict();

const dispatchCustomerUpdateSchema = z.object({
  dispatched_via: z.enum(['WhatsApp', 'Email', 'Manual']).default('WhatsApp'),
}).strict();

module.exports = function registerExecutionAndProcurementRoutes(app, db) {
  /* ----------------------------------------------------------- Change Orders */

  app.get('/api/projects/:id/change-orders', auth, (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM change_orders WHERE project_id = ? ORDER BY created_at DESC').all(req.params.id);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/projects/:id/change-orders',
    auth,
    validate({ body: createChangeOrderSchema }),
    (req, res, next) => {
      try {
        const project = db.prepare('SELECT id, lead_id, project_manager FROM projects WHERE id = ?').get(req.params.id);
        if (!project) throw new NotFoundError('Project not found.');

        if (!isCentral(req.user) && project.project_manager !== req.user.id) {
          throw new ForbiddenError('Only the assigned Project Manager or Admin Desk can create change orders.');
        }

        const id = generateId(db, 'KRY-CO', 'change_orders');
        db.prepare(`
          INSERT INTO change_orders (id, project_id, description, cost_delta_paise, schedule_delta_days, status, customer_approval_ref, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'Draft', ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          project.id,
          req.body.description,
          req.body.cost_delta_paise,
          req.body.schedule_delta_days,
          req.body.customer_approval_ref || null,
          req.user.id,
        );

        audit(
          db,
          req.user.id,
          'CREATE',
          'change_order',
          id,
          `Created change order ${id} on project ${project.id} (cost delta: ₹${(req.body.cost_delta_paise / 100).toFixed(2)})`,
          null,
          req.body,
          req.ip,
        );

        const created = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(id);
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/change-orders/:id/approve',
    auth,
    requireCentral(),
    validate({ body: approveChangeOrderSchema }),
    (req, res, next) => {
      try {
        const co = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(req.params.id);
        if (!co) throw new NotFoundError('Change order not found.');
        if (co.status === 'Approved') throw new ConflictError('Change order is already approved.');

        const project = db.prepare('SELECT id, lead_id, target_completion FROM projects WHERE id = ?').get(co.project_id);

        db.transaction(() => {
          db.prepare(`
            UPDATE change_orders
            SET status = 'Approved', customer_approval_ref = ?, approved_by = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(req.body.customer_approval_ref, req.user.id, co.id);

          // If schedule delta > 0, extend target_completion date
          if (co.schedule_delta_days > 0 && project.target_completion) {
            db.prepare(`
              UPDATE projects
              SET target_completion = date(target_completion, '+' || ? || ' days')
              WHERE id = ?
            `).run(co.schedule_delta_days, project.id);
          }

          logAction(
            db,
            project.lead_id,
            'CHANGE_ORDER_APPROVED',
            req.user.id,
            null,
            'Projects',
            `Change Order ${co.id} approved (Ref: ${req.body.customer_approval_ref}). Cost delta: ₹${(co.cost_delta_paise / 100).toFixed(2)}, Schedule delta: +${co.schedule_delta_days} days.`,
            'In Progress',
            'In Progress',
          );

          audit(
            db,
            req.user.id,
            'APPROVE',
            'change_order',
            co.id,
            `Approved change order ${co.id} with ref ${req.body.customer_approval_ref}`,
            co,
            { status: 'Approved', customer_approval_ref: req.body.customer_approval_ref },
            req.ip,
          );
        })();

        const updated = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(co.id);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  /* ------------------------------------------------------- Purchase Requests */

  app.get('/api/purchase-requests', auth, (req, res, next) => {
    try {
      let sql = `
        SELECT pr.*, p.lead_id, l.customer_name, req_emp.name AS requested_by_name, app_emp.name AS approved_by_name
        FROM purchase_requests pr
        JOIN projects p ON p.id = pr.project_id
        JOIN leads l ON l.id = p.lead_id
        JOIN employees req_emp ON req_emp.id = pr.requested_by
        LEFT JOIN employees app_emp ON app_emp.id = pr.approved_by
        WHERE 1=1
      `;
      const params = [];

      if (req.query.project_id) {
        sql += ' AND pr.project_id = ?';
        params.push(req.query.project_id);
      }
      if (req.query.status) {
        sql += ' AND pr.status = ?';
        params.push(req.query.status);
      }

      sql += ' ORDER BY pr.created_at DESC';
      const rows = db.prepare(sql).all(...params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/projects/:id/purchase-requests',
    auth,
    validate({ body: createPurchaseRequestSchema }),
    (req, res, next) => {
      try {
        const project = db.prepare('SELECT id, lead_id, project_manager, site_engineer FROM projects WHERE id = ?').get(req.params.id);
        if (!project) throw new NotFoundError('Project not found.');

        if (!isCentral(req.user) && project.project_manager !== req.user.id && project.site_engineer !== req.user.id) {
          throw new ForbiddenError('Only the assigned PM or Site Engineer can request materials.');
        }

        const id = generateId(db, 'KRY-PR', 'purchase_requests');
        db.prepare(`
          INSERT INTO purchase_requests (
            id, project_id, requested_by, item_name, category, quantity, unit,
            estimated_cost_paise, urgency, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Admin Approval', datetime('now'), datetime('now'))
        `).run(
          id,
          project.id,
          req.user.id,
          req.body.item_name,
          req.body.category || null,
          req.body.quantity,
          req.body.unit || 'nos',
          req.body.estimated_cost_paise,
          req.body.urgency,
        );

        notifyCentral(
          db,
          'PURCHASE_REQUEST',
          `Material request ${id}: ${req.body.quantity} ${req.body.unit || 'nos'} ${req.body.item_name} for project ${project.id}`,
          '#procurement',
          'project',
          project.id,
        );

        audit(
          db,
          req.user.id,
          'CREATE',
          'purchase_request',
          id,
          `Requested ${req.body.quantity} ${req.body.unit || 'nos'} of ${req.body.item_name}`,
          null,
          req.body,
          req.ip,
        );

        const created = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id);
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post('/api/purchase-requests/:id/approve', auth, requireCentral(), (req, res, next) => {
    try {
      const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
      if (!pr) throw new NotFoundError('Purchase request not found.');

      db.transaction(() => {
        db.prepare(`
          UPDATE purchase_requests
          SET status = 'Approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(req.user.id, pr.id);

        audit(
          db,
          req.user.id,
          'APPROVE',
          'purchase_request',
          pr.id,
          `Admin Desk approved material request ${pr.id} (${pr.item_name})`,
          pr,
          { status: 'Approved' },
          req.ip,
        );
      })();

      const updated = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(pr.id);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.patch(
    '/api/purchase-requests/:id/status',
    auth,
    validate({ body: updateProcurementStatusSchema }),
    (req, res, next) => {
      try {
        if (!isCentral(req.user) && req.user.role !== 'PURCHASE') {
          throw new ForbiddenError('Only Purchase Officer or Admin Desk can update procurement status.');
        }

        const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id);
        if (!pr) throw new NotFoundError('Purchase request not found.');

        db.prepare(`
          UPDATE purchase_requests
          SET status = ?, admin_notes = coalesce(admin_notes, '') || ' ' || ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(req.body.status, req.body.notes || '', pr.id);

        audit(
          db,
          req.user.id,
          'UPDATE_STATUS',
          'purchase_request',
          pr.id,
          `Procurement status changed to ${req.body.status}`,
          pr,
          { status: req.body.status },
          req.ip,
        );

        const updated = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(pr.id);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  /* ------------------------------------------------------ Customer Updates */

  app.get('/api/projects/:id/customer-updates', auth, (req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM customer_updates WHERE project_id = ? ORDER BY created_at DESC').all(req.params.id);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/projects/:id/customer-updates',
    auth,
    validate({ body: createCustomerUpdateSchema }),
    (req, res, next) => {
      try {
        const project = db.prepare('SELECT id, lead_id, project_manager FROM projects WHERE id = ?').get(req.params.id);
        if (!project) throw new NotFoundError('Project not found.');

        const id = generateId(db, 'KRY-CUST', 'customer_updates');
        db.prepare(`
          INSERT INTO customer_updates (
            id, project_id, lead_id, update_type, title, summary,
            photos_count, status, created_by, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?, datetime('now'), datetime('now'))
        `).run(
          id,
          project.id,
          project.lead_id,
          req.body.update_type,
          req.body.title,
          req.body.summary,
          req.body.photos_count,
          req.user.id,
        );

        audit(
          db,
          req.user.id,
          'CREATE',
          'customer_update',
          id,
          `Drafted customer progress update "${req.body.title}"`,
          null,
          req.body,
          req.ip,
        );

        const created = db.prepare('SELECT * FROM customer_updates WHERE id = ?').get(id);
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/customer-updates/:id/dispatch',
    auth,
    requireCentral(),
    validate({ body: dispatchCustomerUpdateSchema }),
    (req, res, next) => {
      try {
        const update = db.prepare('SELECT * FROM customer_updates WHERE id = ?').get(req.params.id);
        if (!update) throw new NotFoundError('Customer update not found.');

        db.transaction(() => {
          db.prepare(`
            UPDATE customer_updates
            SET status = 'Dispatched', dispatched_at = datetime('now'), dispatched_via = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(req.body.dispatched_via, update.id);

          logAction(
            db,
            update.lead_id,
            'CUSTOMER_UPDATE_DISPATCHED',
            req.user.id,
            null,
            'Administration',
            `Customer progress update "${update.title}" approved and dispatched via ${req.body.dispatched_via}.`,
            'In Progress',
            'In Progress',
          );

          audit(
            db,
            req.user.id,
            'DISPATCH',
            'customer_update',
            update.id,
            `Dispatched update "${update.title}" via ${req.body.dispatched_via}`,
            update,
            { status: 'Dispatched', dispatched_via: req.body.dispatched_via },
            req.ip,
          );
        })();

        const updated = db.prepare('SELECT * FROM customer_updates WHERE id = ?').get(update.id);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );
};
