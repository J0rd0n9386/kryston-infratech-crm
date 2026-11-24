/**
 * Quotation lifecycle.
 *
 * Admin Desk advances a reviewed lead to Quotation Stage, the assigned Sales
 * employee creates versions, and a Sales Manager (or central oversight) approves
 * the commercial proposal before a Work Order can be submitted.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { isCentral, isSales, isSalesManager } = require('../middleware/rbac');
const {
  requireFields,
  sanitizeText,
  toNumber,
  toInt,
  validate,
  z,
} = require('../middleware/validate');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { generateId } = require('../lib/id-generator');
const { canTransition } = require('../lib/state-machine');
const { getRequiredApproverRole, isRoleAuthorized } = require('../lib/services/approval-service');
const { lockBoqToQuotation } = require('../lib/services/boq-service');
const { audit, notify, notifyCentral, logAction } = require('../lib/audit-notify');
const config = require('../config');
const PDFDocument = require('pdfkit');

const QUOTE_STATUSES = ['Draft', 'Sent', 'Negotiation', 'Approved', 'Rejected', 'Revised'];

const createQuotationSchema = z.object({
  lead_id: z.string().trim().min(1, 'Lead ID is required.'),
  amount: z.coerce.number().positive('Enter a quotation amount greater than zero.'),
  tax_amount: z.coerce.number().min(0, 'Tax amount cannot be negative.').optional().nullable(),
  discount_percent: z.coerce.number().min(0).max(100).optional().default(0),
  terms: z.string().trim().max(8000).optional().nullable(),
  payment_milestones: z.string().trim().max(8000).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const updateQuotationSchema = z.object({
  status: z.enum(['Draft', 'Sent', 'Negotiation', 'Approved', 'Rejected', 'Revised']),
  remarks: z.string().trim().max(4000).optional().nullable(),
  expected_version: z.coerce.number().int().positive().optional(),
}).strict();

const approveDiscountSchema = z.object({
  action: z.enum(['Approved', 'Rejected']),
  remarks: z.string().trim().max(4000).optional().nullable(),
}).strict();

const reviseQuotationSchema = z.object({
  amount: z.coerce.number().positive('Enter a quotation amount greater than zero.'),
  tax_amount: z.coerce.number().min(0, 'Tax amount cannot be negative.').optional().nullable(),
  discount_percent: z.coerce.number().min(0).max(100).optional().default(0),
  terms: z.string().trim().max(8000).optional().nullable(),
  payment_milestones: z.string().trim().max(8000).optional().nullable(),
  remarks: z.string().trim().max(4000).optional().nullable(),
}).strict();
const QUOTE_TRANSITIONS = Object.freeze({
  Draft: ['Sent', 'Rejected', 'Revised'],
  Sent: ['Negotiation', 'Approved', 'Rejected', 'Revised'],
  Negotiation: ['Approved', 'Rejected', 'Revised'],
  Revised: ['Sent', 'Rejected'],
  Approved: [],
  Rejected: [],
});

const LEAD_STAGE_FOR_QUOTE = Object.freeze({
  Sent: 'Quotation Sent',
  Negotiation: 'Negotiation',
  Approved: 'Approved',
  Revised: 'Quotation Stage',
});

function quoteAccess(db, user, quote) {
  if (isCentral(user)) return true;
  if (isSalesManager(user)) return true;
  if (!isSales(user)) return false;
  if (quote.created_by === user.id) return true;
  const lead = db.prepare('SELECT assigned_bdm FROM leads WHERE id = ?').get(quote.lead_id);
  return Boolean(lead && lead.assigned_bdm === user.id);
}

module.exports = function registerQuotationRoutes(app, db) {
  app.get('/api/quotations', auth, (req, res) => {
    const conditions = [];
    const params = [];
    if (!isCentral(req.user)) {
      if (!isSales(req.user)) return res.json([]);
      if (!isSalesManager(req.user)) {
        conditions.push('(q.created_by = ? OR l.assigned_bdm = ?)');
        params.push(req.user.id, req.user.id);
      }
    }
    if (req.query.lead_id) {
      conditions.push('q.lead_id = ?');
      params.push(String(req.query.lead_id));
    }
    if (req.query.status) {
      conditions.push('q.status = ?');
      params.push(String(req.query.status));
    }
    const limit = Math.min(Math.max(toInt(req.query.limit, 300) || 300, 1), 500);

    const rows = db
      .prepare(
        `SELECT q.*,
                l.customer_name, l.phone AS customer_phone, l.stage AS lead_stage,
                l.assigned_bdm,
                creator.name AS creator_name,
                approver.name AS approver_name,
                ((q.amount * (1.0 - (coalesce(q.discount_percent, 0) / 100.0))) + coalesce(q.tax_amount, 0)) AS total_amount
         FROM quotations q
         JOIN leads l ON l.id = q.lead_id
         LEFT JOIN employees creator ON creator.id = q.created_by
         LEFT JOIN employees approver ON approver.id = q.approved_by
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY q.created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);
    res.json(rows);
  });

  app.get('/api/quotations/:id', auth, (req, res, next) => {
    try {
      const quote = db
        .prepare(
          `SELECT q.*, l.customer_name, l.stage AS lead_stage, l.assigned_bdm,
                  creator.name AS creator_name, approver.name AS approver_name,
                  ((q.amount * (1.0 - (coalesce(q.discount_percent, 0) / 100.0))) + coalesce(q.tax_amount, 0)) AS total_amount
           FROM quotations q
           JOIN leads l ON l.id = q.lead_id
           LEFT JOIN employees creator ON creator.id = q.created_by
           LEFT JOIN employees approver ON approver.id = q.approved_by
           WHERE q.id = ?`,
        )
        .get(req.params.id);
      if (!quote) throw new NotFoundError('Quotation not found.');
      if (!quoteAccess(db, req.user, quote)) throw new ForbiddenError('You cannot access this quotation.');
      res.json(quote);
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/quotations',
    auth,
    validate({ body: createQuotationSchema }),
    (req, res, next) => {
      try {
        if (!isSales(req.user) || isCentral(req.user)) {
          throw new ForbiddenError('Only the assigned Sales employee can create a quotation.');
        }
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.body.lead_id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');
        if (lead.assigned_bdm !== req.user.id) {
          throw new ForbiddenError('This lead is not assigned to you for quotation.');
        }
        if (!['Quotation Stage', 'Quotation Sent', 'Negotiation'].includes(lead.stage)) {
          throw new ConflictError('Admin Desk must advance the lead to Quotation Stage first.');
        }

        const amount = toNumber(req.body.amount, null);
        if (amount === null || amount <= 0) {
          throw new ValidationError('Enter a quotation amount greater than zero.');
        }
        const taxAmount = toNumber(req.body.tax_amount, 0);
        if (taxAmount === null || taxAmount < 0) {
          throw new ValidationError('Tax amount cannot be negative.');
        }
        const discountPercent = toNumber(req.body.discount_percent, 0);
        if (discountPercent === null || discountPercent < 0 || discountPercent > 100) {
          throw new ValidationError('Discount percentage must be between 0 and 100.');
        }
        const requiredRole = getRequiredApproverRole(db, 'quotation_discount', 'discount_percent', discountPercent);
        const requiresApproval = requiredRole !== null ? 1 : 0;
        const approvalStatus = requiresApproval ? 'pending' : 'approved';

        const last = db
          .prepare('SELECT MAX(version) AS max_version FROM quotations WHERE lead_id = ?')
          .get(lead.id);
        const version = (Number(last && last.max_version) || 0) + 1;
        const id = generateId(db, 'KRY-QUOT', 'quotations');

        const terms = sanitizeText(req.body.terms, 8000);
        const paymentMilestones = sanitizeText(req.body.payment_milestones, 8000);

        db.transaction(() => {
          db.prepare(
            `INSERT INTO quotations
              (id, lead_id, version, amount, tax_amount, discount_percent, terms, payment_milestones, status, created_by, requires_approval, approval_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?)`,
          ).run(
            id,
            lead.id,
            version,
            amount,
            taxAmount,
            discountPercent,
            terms,
            paymentMilestones,
            req.user.id,
            requiresApproval,
            approvalStatus,
          );

          db.prepare(
            `INSERT INTO quotation_versions
              (quotation_id, version, amount, tax_amount, discount_percent, terms, payment_milestones, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`,
          ).run(
            id,
            version,
            amount,
            taxAmount,
            discountPercent,
            terms,
            paymentMilestones,
            req.user.id,
          );

          logAction(
            db,
            lead.id,
            'QUOTATION',
            req.user.id,
            lead.current_owner,
            'Sales',
            `Quotation ${id} (v${version}) created for ₹${amount.toLocaleString('en-IN')}${discountPercent > 0 ? ` (discount: ${discountPercent}%)` : ''}.`,
            lead.stage,
            lead.stage,
          );
          notifyCentral(
            db,
            'QUOTATION_CREATED',
            `Quotation ${id} v${version} created for ${lead.customer_name} by ${req.user.name}.${requiresApproval ? ' (Requires Discount Approval)' : ''}`,
            '#quotations',
            'quotation',
            id,
          );
          audit(
            db,
            req.user.id,
            'CREATE',
            'quotation',
            id,
            `Lead ${lead.id}, version ${version}, amount ${amount}, discount ${discountPercent}%`,
            null,
            { status: 'Draft', amount, version, discount_percent: discountPercent, requires_approval: requiresApproval },
            req.ip,
          );
        })();

        res.status(201).json({ id, version, amount, tax_amount: taxAmount, discount_percent: discountPercent, requires_approval: requiresApproval, approval_status: approvalStatus, status: 'Draft' });
      } catch (err) {
        next(err);
      }
    },
  );

  app.patch('/api/quotations/:id', auth, validate({ body: updateQuotationSchema }), (req, res, next) => {
    try {
      const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
      if (!quote) throw new NotFoundError('Quotation not found.');
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(quote.lead_id);
      if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');

      const status = String(req.body.status || '');
      if (!QUOTE_STATUSES.includes(status)) {
        throw new ValidationError(`status must be one of: ${QUOTE_STATUSES.join(', ')}.`);
      }
      const allowed = QUOTE_TRANSITIONS[quote.status] || [];
      if (!allowed.includes(status)) {
        throw new ConflictError(`A quotation in "${quote.status}" cannot move to "${status}".`);
      }

      if (['Approved', 'Sent'].includes(status)) {
        if (quote.requires_approval === 1 && quote.approval_status !== 'approved') {
          throw new ConflictError(
            `Quotation discount of ${quote.discount_percent}% exceeds threshold (${config.discountApprovalThresholdPercent}%) and requires Sales Manager or Admin approval before it can be marked as ${status}.`,
          );
        }
      }

      if (['Sent', 'Approved', 'Rejected'].includes(status) && !isCentral(req.user)) {
        throw new ForbiddenError('Admin Desk must release quotations and make the final approval decision.');
      }
      const managerAction = ['Approved', 'Rejected'].includes(status);
      if (managerAction) {
        if (!isSalesManager(req.user) && !isCentral(req.user)) {
          throw new ForbiddenError('Only a Sales Manager or Admin Desk can approve or reject a quotation.');
        }
      } else if (!isCentral(req.user)) {
        if (!isSales(req.user) || (quote.created_by !== req.user.id && lead.assigned_bdm !== req.user.id)) {
          throw new ForbiddenError('Only the assigned Sales employee can update this quotation.');
        }
      }

      const remarks = sanitizeText(req.body.remarks, 4000);
      if (status === 'Rejected' && !remarks) {
        throw new ValidationError('A reason is required when rejecting a quotation.');
      }

      const nextLeadStage = LEAD_STAGE_FOR_QUOTE[status] || null;
      if (nextLeadStage && nextLeadStage !== lead.stage) {
        if (!canTransition(lead.stage, nextLeadStage, req.user.role)) {
          throw new ConflictError(
            `The lead cannot move from "${lead.stage}" to "${nextLeadStage}" for this quotation action.`,
          );
        }
      }

      db.transaction(() => {
        db.prepare(
          `UPDATE quotations
           SET status = ?,
               approved_by = CASE WHEN ? = 'Approved' THEN ? ELSE approved_by END,
               sent_at = CASE WHEN ? = 'Sent' AND sent_at IS NULL THEN datetime('now') ELSE sent_at END,
               updated_at = datetime('now')
           WHERE id = ?`,
        ).run(status, status, req.user.id, status, quote.id);

        if (nextLeadStage && nextLeadStage !== lead.stage) {
          db.prepare(
            `UPDATE leads SET stage = ?, current_owner = ?, updated_at = datetime('now'), version = version + 1 WHERE id = ?`,
          ).run(nextLeadStage, lead.assigned_bdm || lead.current_owner, lead.id);
          logAction(
            db,
            lead.id,
            'STAGE_CHANGE',
            req.user.id,
            lead.assigned_bdm,
            'Sales',
            `Quotation ${quote.id} marked ${status}.${remarks ? ` ${remarks}` : ''}`,
            lead.stage,
            nextLeadStage,
          );
        }

        if (status === 'Sent') {
          lockBoqToQuotation(db, lead.id, quote.id);
        }

        if (status === 'Negotiation') {
          const currentRounds = (lead.negotiation_rounds || 0) + 1;
          db.prepare('UPDATE leads SET negotiation_rounds = ? WHERE id = ?').run(currentRounds, lead.id);
          if (currentRounds > 2) {
            notifyCentral(
              db,
              'NEGOTIATION_CAP_EXCEEDED',
              `Lead ${lead.id} exceeded 2 negotiation rounds (${currentRounds} rounds). Super Admin intervention recommended.`,
              '#leads',
              'lead',
              lead.id,
            );
            logAction(
              db,
              lead.id,
              'NEGOTIATION_CAP_EXCEEDED',
              req.user.id,
              null,
              'Sales',
              `Negotiation rounds cap exceeded (${currentRounds} rounds). Flagged for Super Admin review.`,
              lead.stage,
              nextLeadStage || lead.stage,
            );
          }
        }

        const message = `Quotation ${quote.id} v${quote.version} marked ${status}.${remarks ? ` ${remarks}` : ''}`;
        if (lead.assigned_bdm) {
          notify(db, lead.assigned_bdm, 'QUOTATION_STATUS', message, '#quotations', 'quotation', quote.id);
        }
        notifyCentral(db, 'QUOTATION_STATUS', message, '#quotations', 'quotation', quote.id);
        audit(
          db,
          req.user.id,
          'UPDATE_STATUS',
          'quotation',
          quote.id,
          `Status ${quote.status} -> ${status}${remarks ? `: ${remarks}` : ''}`,
          { status: quote.status },
          { status },
          req.ip,
        );
      })();

      res.json({ ok: true, id: quote.id, status, lead_stage: nextLeadStage || lead.stage });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/quotations/:id/approve-discount',
    auth,
    validate({ body: approveDiscountSchema }),
    (req, res, next) => {
      try {
        const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
        if (!quote) throw new NotFoundError('Quotation not found.');
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(quote.lead_id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');

        const requiredRole = getRequiredApproverRole(db, 'quotation_discount', 'discount_percent', quote.discount_percent);
        if (requiredRole && !isRoleAuthorized(req.user.role, requiredRole)) {
          throw new ForbiddenError(`Approving this discount (${quote.discount_percent}%) requires at least ${requiredRole} role.`);
        }

        const action = req.body.action; // 'Approved' | 'Rejected'
        const remarks = sanitizeText(req.body.remarks, 4000);
        const requiresApproval = action === 'Approved' ? 0 : quote.requires_approval;
        const approvalStatus = action === 'Approved' ? 'approved' : 'rejected';

        db.transaction(() => {
          db.prepare(
            `UPDATE quotations
             SET requires_approval = ?,
                 approval_status = ?,
                 approval_remarks = ?,
                 approved_by = CASE WHEN ? = 'Approved' THEN ? ELSE approved_by END,
                 updated_at = datetime('now')
             WHERE id = ?`,
          ).run(requiresApproval, approvalStatus, remarks, action, req.user.id, quote.id);

          logAction(
            db,
            lead.id,
            'DISCOUNT_APPROVAL',
            req.user.id,
            quote.created_by,
            'Sales',
            `Quotation ${quote.id} discount (${quote.discount_percent}%) ${action.toLowerCase()} by ${req.user.name}.${remarks ? ` ${remarks}` : ''}`,
            lead.stage,
            lead.stage,
          );

          if (quote.created_by) {
            notify(
              db,
              quote.created_by,
              'DISCOUNT_APPROVAL',
              `Discount of ${quote.discount_percent}% on quotation ${quote.id} was ${action.toLowerCase()} by ${req.user.name}.`,
              '#quotations',
              'quotation',
              quote.id,
            );
          }
          notifyCentral(
            db,
            'DISCOUNT_APPROVAL',
            `Discount on quotation ${quote.id} was ${action.toLowerCase()} by ${req.user.name}.`,
            '#quotations',
            'quotation',
            quote.id,
          );

          audit(
            db,
            req.user.id,
            'APPROVE_DISCOUNT',
            'quotation',
            quote.id,
            `Discount ${quote.discount_percent}% ${action.toLowerCase()}`,
            { requires_approval: quote.requires_approval, approval_status: quote.approval_status },
            { requires_approval: requiresApproval, approval_status: approvalStatus },
            req.ip,
          );
        })();

        res.json({ ok: true, id: quote.id, requires_approval: requiresApproval, approval_status: approvalStatus });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/api/quotations/:id/revise',
    auth,
    validate({ body: reviseQuotationSchema }),
    (req, res, next) => {
      try {
        const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
        if (!quote) throw new NotFoundError('Quotation not found.');
        if (!quoteAccess(db, req.user, quote)) throw new ForbiddenError('You cannot access this quotation.');
        if (!isSales(req.user) && !isCentral(req.user)) {
          throw new ForbiddenError('Only Sales or Admin Desk can revise a quotation.');
        }
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(quote.lead_id);
        if (!lead || lead.deleted_at) throw new NotFoundError('Lead not found.');

        const amount = toNumber(req.body.amount, quote.amount);
        const taxAmount = toNumber(req.body.tax_amount, quote.tax_amount);
        const discountPercent = toNumber(req.body.discount_percent, quote.discount_percent || 0);
        const terms = req.body.terms !== undefined ? sanitizeText(req.body.terms, 8000) : quote.terms;
        const paymentMilestones = req.body.payment_milestones !== undefined ? sanitizeText(req.body.payment_milestones, 8000) : quote.payment_milestones;
        const remarks = sanitizeText(req.body.remarks, 4000);

        const newVersion = quote.version + 1;
        const requiresApproval = discountPercent > config.discountApprovalThresholdPercent ? 1 : 0;
        const approvalStatus = requiresApproval ? 'pending' : 'approved';

        db.transaction(() => {
          db.prepare(
            `UPDATE quotations
             SET version = ?,
                 amount = ?,
                 tax_amount = ?,
                 discount_percent = ?,
                 terms = ?,
                 payment_milestones = ?,
                 status = 'Draft',
                 requires_approval = ?,
                 approval_status = ?,
                 approved_by = NULL,
                 updated_at = datetime('now')
             WHERE id = ?`,
          ).run(
            newVersion,
            amount,
            taxAmount,
            discountPercent,
            terms,
            paymentMilestones,
            requiresApproval,
            approvalStatus,
            quote.id,
          );

          db.prepare(
            `INSERT INTO quotation_versions
              (quotation_id, version, amount, tax_amount, discount_percent, terms, payment_milestones, status, created_by, revision_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)`,
          ).run(
            quote.id,
            newVersion,
            amount,
            taxAmount,
            discountPercent,
            terms,
            paymentMilestones,
            req.user.id,
            remarks || 'Commercial revision',
          );

          logAction(
            db,
            lead.id,
            'QUOTATION_REVISED',
            req.user.id,
            lead.current_owner,
            'Sales',
            `Quotation ${quote.id} revised to v${newVersion} for ₹${amount.toLocaleString('en-IN')}.${remarks ? ` ${remarks}` : ''}`,
            lead.stage,
            lead.stage,
          );

          audit(
            db,
            req.user.id,
            'REVISE',
            'quotation',
            quote.id,
            `Revised to v${newVersion}`,
            { version: quote.version, amount: quote.amount },
            { version: newVersion, amount },
            req.ip,
          );
        })();

        res.json({ ok: true, id: quote.id, version: newVersion, amount, discount_percent: discountPercent, status: 'Draft' });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get('/api/quotations/:id/versions', auth, (req, res, next) => {
    try {
      const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
      if (!quote) throw new NotFoundError('Quotation not found.');
      if (!quoteAccess(db, req.user, quote)) throw new ForbiddenError('You cannot access this quotation.');

      const versions = db
        .prepare(
          `SELECT qv.*, e.name AS creator_name
           FROM quotation_versions qv
           LEFT JOIN employees e ON e.id = qv.created_by
           WHERE qv.quotation_id = ?
           ORDER BY qv.version ASC`,
        )
        .all(quote.id);

      res.json(versions);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/quotations/:id/pdf', auth, (req, res, next) => {
    try {
      const quote = db
        .prepare(
          `SELECT q.*, l.customer_name, l.phone AS customer_phone, l.email AS customer_email,
                  l.location AS customer_location, l.project_type, l.city,
                  creator.name AS creator_name, approver.name AS approver_name
           FROM quotations q
           JOIN leads l ON l.id = q.lead_id
           LEFT JOIN employees creator ON creator.id = q.created_by
           LEFT JOIN employees approver ON approver.id = q.approved_by
           WHERE q.id = ?`,
        )
        .get(req.params.id);
      if (!quote) throw new NotFoundError('Quotation not found.');
      if (!quoteAccess(db, req.user, quote)) throw new ForbiddenError('You cannot access this quotation.');

      if (!isCentral(req.user)) {
        const tasks = db.prepare('SELECT * FROM tasks WHERE lead_id = ? AND assigned_to = ?').all(quote.lead_id, req.user.id);
        const authorised = tasks.some(task => require('../lib/guardian').contactAllowed(task, req.user.id));
        if (!authorised) { quote.customer_phone = null; quote.customer_email = null; }
      }

      const doc = new PDFDocument({ size: 'A4', margin: 40 });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="quotation-${quote.id}-v${quote.version}.pdf"`,
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');

      doc.pipe(res);

      // Header
      doc.fillColor('#1a365d').fontSize(20).text('KRYSTON INFRATECH', { align: 'left' });
      doc.fillColor('#4a5568').fontSize(10).text('Turnkey Construction, Architecture & Interior Infrastructure', { align: 'left' });
      doc.text('New Delhi, India | contact@krystoninfratech.com | +91-11-KRYSTON', { align: 'left' });
      doc.moveDown(1);
      doc.strokeColor('#cbd5e0').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(1);

      // Document Title
      doc.fillColor('#2b6cb0').fontSize(14).text('COMMERCIAL PROPOSAL / QUOTATION', { align: 'center', underline: true });
      doc.moveDown(0.5);

      // Metadata block
      doc.fillColor('#2d3748').fontSize(10);
      const metaY = doc.y;
      doc.text(`Quotation ID: ${quote.id}`, 40, metaY);
      doc.text(`Version: v${quote.version}`, 40, metaY + 15);
      doc.text(`Date: ${new Date(quote.created_at).toLocaleDateString('en-IN')}`, 40, metaY + 30);
      doc.text(`Status: ${quote.status}`, 40, metaY + 45);

      doc.text(`Client: ${quote.customer_name}`, 320, metaY);
      doc.text(`Phone: ${quote.customer_phone || '—'}`, 320, metaY + 15);
      doc.text(`Email: ${quote.customer_email || '—'}`, 320, metaY + 30);
      doc.text(`Location: ${quote.customer_location || quote.city || '—'}`, 320, metaY + 45);

      doc.y = metaY + 70;
      doc.moveDown(0.5);
      doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(1);

      // Financials
      doc.fillColor('#1a202c').fontSize(12).text('COMMERCIAL SUMMARY');
      doc.moveDown(0.5);

      const baseAmount = quote.amount || 0;
      const discountPercent = quote.discount_percent || 0;
      const discountVal = (baseAmount * discountPercent) / 100.0;
      const subtotal = baseAmount - discountVal;
      const taxAmount = quote.tax_amount || 0;
      const totalAmount = subtotal + taxAmount;

      const fmt = (num) => `INR ${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      doc.fontSize(10).fillColor('#4a5568');
      doc.text('Base Amount / Scope of Work:', 40, doc.y);
      doc.text(fmt(baseAmount), 380, doc.y - 12, { align: 'right' });

      doc.moveDown(0.5);
      doc.text(`Commercial Discount (${discountPercent}%):`, 40, doc.y);
      doc.text(`- ${fmt(discountVal)}`, 380, doc.y - 12, { align: 'right' });

      doc.moveDown(0.5);
      doc.text('Subtotal after Discount:', 40, doc.y);
      doc.text(fmt(subtotal), 380, doc.y - 12, { align: 'right' });

      doc.moveDown(0.5);
      doc.text('Taxes (GST / Applicable Duties):', 40, doc.y);
      doc.text(fmt(taxAmount), 380, doc.y - 12, { align: 'right' });

      doc.moveDown(0.5);
      doc.strokeColor('#cbd5e0').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.5);

      doc.fontSize(12).fillColor('#1a365d');
      doc.text('Total Proposal Value:', 40, doc.y);
      doc.text(fmt(totalAmount), 380, doc.y - 14, { align: 'right' });

      doc.moveDown(1.5);

      // Terms & Milestones
      if (quote.payment_milestones) {
        doc.fontSize(11).fillColor('#2d3748').text('Payment Milestones:');
        doc.fontSize(9).fillColor('#4a5568').text(quote.payment_milestones);
        doc.moveDown(1);
      }

      if (quote.terms) {
        doc.fontSize(11).fillColor('#2d3748').text('Terms & Conditions:');
        doc.fontSize(9).fillColor('#4a5568').text(quote.terms);
        doc.moveDown(1);
      }

      // Authorization Stamp
      doc.moveDown(1);
      const signY = doc.y;
      doc.fontSize(9).fillColor('#718096');
      doc.text(`Prepared By: ${quote.creator_name || 'Kryston Sales Team'}`, 40, signY);
      if (quote.approved_by && quote.approver_name) {
        doc.text(`Approved By: ${quote.approver_name} (Commercial Clearance)`, 320, signY);
      } else if (quote.requires_approval) {
        doc.text(`Discount Approval: Pending Management Clearance`, 320, signY);
      }

      doc.moveDown(2);
      doc.fontSize(8).fillColor('#a0aec0').text('This is a system-generated proposal issued by Kryston Infratech CRM.', { align: 'center' });

      doc.end();
    } catch (err) {
      next(err);
    }
  });
};
