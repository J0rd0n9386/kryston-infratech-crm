/**
 * Handover, Snags and Warranty Routes.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const { validate, z } = require('../middleware/validate');
const { NotFoundError, ForbiddenError } = require('../middleware/errors');
const { audit, logAction, notifyCentral } = require('../lib/audit-notify');
const { generateId } = require('../lib/id-generator');
const {
  createSnag,
  resolveSnag,
  approveSnag,
  issueWarranty,
} = require('../lib/services/handover-service');

const createSnagSchema = z.object({
  description: z.string().trim().min(1, 'Description is required.').max(1000),
  location: z.string().trim().max(250).optional().nullable(),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).default('Medium'),
  photo_url: z.string().trim().max(1000).optional().nullable(),
}).strict();

const resolveSnagSchema = z.object({
  notes: z.string().trim().max(1000).optional().nullable(),
}).strict();

const warrantyCreateSchema = z.object({
  scope: z.string().trim().min(1, 'Scope is required.').max(500),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'start_date must be YYYY-MM-DD'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'end_date must be YYYY-MM-DD'),
  terms: z.string().trim().max(4000).optional().nullable(),
}).strict();

const warrantyClaimSchema = z.object({
  issue_description: z.string().trim().min(1, 'Issue description is required.').max(2000),
}).strict();

const referralRequestSchema = z.object({
  customer_rating: z.coerce.number().int().min(1).max(5).optional().nullable(),
  feedback: z.string().trim().max(2000).optional().nullable(),
}).strict();

module.exports = function registerHandoverRoutes(app, db) {
  // 1. Get Snag list for a project
  app.get('/api/projects/:id/snags', auth, (req, res, next) => {
    try {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
      if (!project) throw new NotFoundError('Project not found.');

      if (!isCentral(req.user) && project.project_manager !== req.user.id && project.site_engineer !== req.user.id) {
        throw new ForbiddenError('You are not assigned to this project.');
      }

      const snags = db
        .prepare(`
          SELECT s.*, e1.name as resolved_by_name, e2.name as approved_by_name, e3.name as created_by_name
          FROM snag_items s
          LEFT JOIN employees e1 ON e1.id = s.resolved_by
          LEFT JOIN employees e2 ON e2.id = s.approved_by
          LEFT JOIN employees e3 ON e3.id = s.created_by
          WHERE s.project_id = ?
          ORDER BY s.created_at DESC
        `)
        .all(project.id);

      res.json(snags);
    } catch (err) {
      next(err);
    }
  });

  // 2. Create Snag item
  app.post(
    '/api/projects/:id/snags',
    auth,
    validate({ body: createSnagSchema }),
    (req, res, next) => {
      try {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
        if (!project) throw new NotFoundError('Project not found.');

        if (!isCentral(req.user) && project.project_manager !== req.user.id && project.site_engineer !== req.user.id) {
          throw new ForbiddenError('Only assigned site staff or Central can log snag items.');
        }

        const snag = createSnag(db, {
          projectId: project.id,
          description: req.body.description,
          location: req.body.location,
          priority: req.body.priority,
          photoUrl: req.body.photo_url,
          createdBy: req.user.id,
        });

        logAction(
          db,
          project.lead_id,
          'DEPT_UPDATE',
          req.user.id,
          null,
          'Projects',
          `Snag item logged [${snag.priority}]: ${snag.description}`,
        );

        audit(db, req.user.id, 'CREATE_SNAG', 'snag_items', snag.id, `Logged snag: ${snag.description}`);
        res.status(201).json(snag);
      } catch (err) {
        next(err);
      }
    },
  );

  // 3. Resolve Snag item
  app.patch(
    '/api/snags/:id/resolve',
    auth,
    validate({ body: resolveSnagSchema }),
    (req, res, next) => {
      try {
        const snag = db.prepare('SELECT * FROM snag_items WHERE id = ?').get(req.params.id);
        if (!snag) throw new NotFoundError('Snag item not found.');

        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(snag.project_id);
        if (!isCentral(req.user) && project.project_manager !== req.user.id && project.site_engineer !== req.user.id) {
          throw new ForbiddenError('Only assigned project staff or Central can mark snags resolved.');
        }

        const updated = resolveSnag(db, {
          snagId: snag.id,
          resolvedBy: req.user.id,
          notes: req.body.notes,
        });

        notifyCentral(
          db,
          'SNAG_RESOLVED',
          `Snag ${snag.id} on project ${snag.project_id} resolved by ${req.user.name}. Awaiting Admin approval.`,
          '#projects',
          'project',
          snag.project_id,
        );

        audit(db, req.user.id, 'RESOLVE_SNAG', 'snag_items', snag.id, 'Resolved snag item');
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // 4. Approve Snag item (Admin Desk / Central only)
  app.patch('/api/snags/:id/approve', auth, requireCentral(), (req, res, next) => {
    try {
      const snag = db.prepare('SELECT * FROM snag_items WHERE id = ?').get(req.params.id);
      if (!snag) throw new NotFoundError('Snag item not found.');

      const updated = approveSnag(db, {
        snagId: snag.id,
        approvedBy: req.user.id,
      });

      audit(db, req.user.id, 'APPROVE_SNAG', 'snag_items', snag.id, 'Approved resolved snag item');
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // 5. Warranties for project
  app.get('/api/projects/:id/warranties', auth, (req, res, next) => {
    try {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
      if (!project) throw new NotFoundError('Project not found.');

      const warranties = db
        .prepare(`
          SELECT w.*, e.name as created_by_name
          FROM warranties w
          LEFT JOIN employees e ON e.id = w.created_by
          WHERE w.project_id = ?
          ORDER BY w.created_at DESC
        `)
        .all(project.id);

      res.json(warranties);
    } catch (err) {
      next(err);
    }
  });

  // 6. Issue Warranty Certificate (Admin Desk / Central only)
  app.post(
    '/api/projects/:id/warranties',
    auth,
    requireCentral(),
    validate({ body: warrantyCreateSchema }),
    (req, res, next) => {
      try {
        const warranty = issueWarranty(db, {
          projectId: req.params.id,
          scope: req.body.scope,
          startDate: req.body.start_date,
          endDate: req.body.end_date,
          terms: req.body.terms,
          createdBy: req.user.id,
        });

        audit(
          db,
          req.user.id,
          'ISSUE_WARRANTY',
          'warranties',
          warranty.id,
          `Issued warranty certificate ${warranty.certificate_number}`,
        );

        res.status(201).json(warranty);
      } catch (err) {
        next(err);
      }
    },
  );

  // 7. File Warranty Claim
  app.post(
    '/api/warranties/:id/claims',
    auth,
    validate({ body: warrantyClaimSchema }),
    (req, res, next) => {
      try {
        const warranty = db.prepare('SELECT * FROM warranties WHERE id = ?').get(req.params.id);
        if (!warranty) throw new NotFoundError('Warranty not found.');

        const claimId = generateId(db, 'KRY-CLM', 'warranty_claims');

        db.transaction(() => {
          db.prepare(`
            INSERT INTO warranty_claims (id, warranty_id, project_id, issue_description)
            VALUES (?, ?, ?, ?)
          `).run(claimId, warranty.id, warranty.project_id, req.body.issue_description);

          // Update warranty status to Claimed
          db.prepare("UPDATE warranties SET status = 'Claimed' WHERE id = ?").run(warranty.id);

          // Create an urgent triage task for Admin Desk to dispatch a service technician
          const taskId = generateId(db, 'KRY-TASK', 'tasks');
          db.prepare(`
            INSERT INTO tasks (id, lead_id, assigned_to, assigned_by, department, task_type, brief, due_date, sla_hours, status, requires_contact)
            VALUES (?, ?, ?, ?, 'Administration', 'WARRANTY_SERVICE', ?, date('now', '+1 day'), 24, 'Assigned', 1)
          `).run(
            taskId,
            warranty.lead_id,
            req.user.id,
            req.user.id,
            `Warranty Claim on cert ${warranty.certificate_number}: ${req.body.issue_description}`,
          );

          notifyCentral(
            db,
            'WARRANTY_CLAIM',
            `Warranty claim filed on certificate ${warranty.certificate_number}: ${req.body.issue_description}`,
            '#service',
            'warranty',
            warranty.id,
          );

          audit(
            db,
            req.user.id,
            'WARRANTY_CLAIM_FILED',
            'warranty_claims',
            claimId,
            `Claim filed on ${warranty.certificate_number}`,
          );
        })();

        res.status(201).json({ ok: true, claim_id: claimId });
      } catch (err) {
        next(err);
      }
    },
  );

  // 8. Generate Post-Handover Referral & Review Request
  app.post(
    '/api/projects/:id/referral-request',
    auth,
    requireCentral(),
    validate({ body: referralRequestSchema }),
    (req, res, next) => {
      try {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
        if (!project) throw new NotFoundError('Project not found.');
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);

        const id = generateId(db, 'KRY-REF', 'referral_requests');
        const referralDraft = `Dear ${lead ? lead.customer_name : 'Valued Customer'}, thank you for trusting Kryston Infratech with your project! We would love your feedback and a Google Review: https://g.page/r/kryston/review. If you refer a friend, both of you enjoy exclusive privilege discounts.`;

        db.prepare(`
          INSERT INTO referral_requests (id, project_id, lead_id, customer_rating, feedback, referral_draft, status, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, 'Sent', datetime('now'))
        `).run(
          id,
          project.id,
          project.lead_id,
          req.body.customer_rating || 5,
          req.body.feedback || null,
          referralDraft,
        );

        audit(db, req.user.id, 'SENT_REFERRAL_REQUEST', 'referral_requests', id, `Sent review & referral request for project ${project.id}`);

        res.status(201).json({
          ok: true,
          referral_id: id,
          draft: referralDraft,
          status: 'Sent',
        });
      } catch (err) {
        next(err);
      }
    },
  );
};
