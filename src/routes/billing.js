/**
 * Invoicing, Payment Milestones, and Payments Ledger Routes.
 *
 * Implements strict integer paise precision, milestone validation,
 * tax invoice generation, and append-only payment recording.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { isCentral } = require('../middleware/rbac');
const { z, validate } = require('../middleware/validate');
const { NotFoundError, ForbiddenError } = require('../middleware/errors');
const {
  validateMilestones,
  getWorkOrderBilling,
  createInvoice,
  recordPayment,
} = require('../lib/services/billing-service');

const createMilestonesSchema = z.object({
  milestones: z.array(
    z.object({
      name: z.string().trim().min(1).max(200),
      percentage: z.coerce.number().positive().max(100),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD').optional().nullable(),
    }),
  ).min(1, 'At least one milestone is required.'),
}).strict();

const createInvoiceSchema = z.object({
  milestone_id: z.string().trim().optional().nullable(),
  invoice_type: z.enum(['ADVANCE_INVOICE', 'TAX_INVOICE', 'PROFORMA']).default('TAX_INVOICE'),
  subtotal_paise: z.coerce.number().int().positive(),
  gst_rate: z.coerce.number().min(0).max(100).optional().default(18.0),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD'),
}).strict();

const recordPaymentSchema = z.object({
  amount_paise: z.coerce.number().int().positive(),
  payment_mode: z.enum(['NEFT_RTGS', 'UPI', 'CHEQUE', 'CASH', 'BANK_TRANSFER']).default('NEFT_RTGS'),
  reference_number: z.string().trim().min(1).max(100),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'payment_date must be YYYY-MM-DD').optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
}).strict();

module.exports = function registerBillingRoutes(app, db) {
  /* --------------------------------------------------- Work Order Billing & Milestones */

  app.get('/api/work-orders/:id/billing', auth, (req, res, next) => {
    try {
      const billing = getWorkOrderBilling(db, req.params.id);
      res.json(billing);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/work-orders/:id/milestones',
    auth,
    validate({ body: createMilestonesSchema }),
    (req, res, next) => {
      try {
        if (!isCentral(req.user) && req.user.role !== 'ACCOUNTS' && req.user.role !== 'SALES_MANAGER') {
          throw new ForbiddenError('Only Accounts, Sales Manager or Admin Desk can configure payment milestones.');
        }

        const wo = db.prepare('SELECT id, amount, status FROM work_orders WHERE id = ?').get(req.params.id);
        if (!wo) throw new NotFoundError('Work order not found.');

        const contractValuePaise = Math.round(Number(wo.amount) * 100);
        const processed = validateMilestones(req.body.milestones, contractValuePaise);

        db.transaction(() => {
          db.prepare('DELETE FROM payment_milestones WHERE work_order_id = ?').run(wo.id);

          const insert = db.prepare(`
            INSERT INTO payment_milestones (id, work_order_id, name, percentage, amount_paise, due_date, status, sequence_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, datetime('now'))
          `);

          for (const m of processed) {
            const milestoneId = `MS-${Date.now().toString(36).toUpperCase()}-${m.sequence_order}`;
            insert.run(milestoneId, wo.id, m.name, m.percentage, m.amount_paise, m.due_date, m.sequence_order);
          }
        })();

        const updated = getWorkOrderBilling(db, wo.id);
        res.status(201).json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  /* ------------------------------------------------------------------------ Invoices */

  app.get('/api/invoices', auth, (req, res, next) => {
    try {
      let sql = `
        SELECT inv.*, wo.lead_id, l.customer_name, l.phone, pm.name AS milestone_name
        FROM invoices inv
        JOIN work_orders wo ON wo.id = inv.work_order_id
        JOIN leads l ON l.id = wo.lead_id
        LEFT JOIN payment_milestones pm ON pm.id = inv.milestone_id
        WHERE 1=1
      `;
      const params = [];

      if (req.query.work_order_id) {
        sql += ' AND inv.work_order_id = ?';
        params.push(req.query.work_order_id);
      }
      if (req.query.status) {
        sql += ' AND inv.status = ?';
        params.push(req.query.status);
      }

      sql += ' ORDER BY inv.created_at DESC';
      const rows = db.prepare(sql).all(...params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/work-orders/:id/invoices',
    auth,
    validate({ body: createInvoiceSchema }),
    (req, res, next) => {
      try {
        if (!isCentral(req.user) && req.user.role !== 'ACCOUNTS') {
          throw new ForbiddenError('Only Accounts or Admin Desk can generate invoices.');
        }

        const invoice = createInvoice(db, req.user, {
          work_order_id: req.params.id,
          milestone_id: req.body.milestone_id,
          invoice_type: req.body.invoice_type,
          subtotal_paise: req.body.subtotal_paise,
          gst_rate: req.body.gst_rate,
          due_date: req.body.due_date,
        });

        res.status(201).json(invoice);
      } catch (err) {
        next(err);
      }
    },
  );

  /* ------------------------------------------------------------------------ Payments */

  app.get('/api/payments', auth, (req, res, next) => {
    try {
      let sql = `
        SELECT p.*, inv.invoice_number, inv.total_paise AS invoice_total_paise,
               wo.lead_id, l.customer_name, emp.name AS recorded_by_name
        FROM payments p
        JOIN invoices inv ON inv.id = p.invoice_id
        JOIN work_orders wo ON wo.id = p.work_order_id
        JOIN leads l ON l.id = wo.lead_id
        JOIN employees emp ON emp.id = p.recorded_by
        WHERE 1=1
      `;
      const params = [];

      if (req.query.invoice_id) {
        sql += ' AND p.invoice_id = ?';
        params.push(req.query.invoice_id);
      }
      if (req.query.work_order_id) {
        sql += ' AND p.work_order_id = ?';
        params.push(req.query.work_order_id);
      }

      sql += ' ORDER BY p.created_at DESC';
      const rows = db.prepare(sql).all(...params);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/invoices/:id/payments',
    auth,
    validate({ body: recordPaymentSchema }),
    (req, res, next) => {
      try {
        if (!isCentral(req.user) && req.user.role !== 'ACCOUNTS') {
          throw new ForbiddenError('Only Accounts or Admin Desk can record payment receipts.');
        }

        const result = recordPayment(db, req.user, {
          invoice_id: req.params.id,
          amount_paise: req.body.amount_paise,
          payment_mode: req.body.payment_mode,
          reference_number: req.body.reference_number,
          payment_date: req.body.payment_date,
          notes: req.body.notes,
        });

        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );
};
