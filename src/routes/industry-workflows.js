'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral, isSales, isSalesManager } = require('../middleware/rbac');
const { validate, z } = require('../middleware/validate');
const { NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { generateId } = require('../lib/id-generator');
const { audit, notify, notifyCentral, logAction } = require('../lib/audit-notify');

const counterofferSchema = z.object({
  customer_request: z.string().trim().min(1).max(4000),
  proposed_amount: z.coerce.number().positive().optional().nullable(),
  proposed_discount_percent: z.coerce.number().min(0).max(100).optional().nullable(),
  proposed_terms: z.string().trim().max(8000).optional().nullable(),
  proposed_payment_milestones: z.string().trim().max(8000).optional().nullable(),
}).strict();

const decisionSchema = z.object({
  action: z.enum(['Approve', 'Reject']),
  remarks: z.string().trim().min(1).max(4000),
}).strict();

const acceptanceSchema = z.object({
  customer_response_ref: z.string().trim().min(1).max(500),
  remarks: z.string().trim().max(4000).optional().nullable(),
}).strict();

const handoffSchema = z.object({
  scope_summary: z.string().trim().min(1).max(8000),
  exclusions: z.string().trim().max(4000).optional().nullable(),
  site_risks: z.string().trim().max(4000).optional().nullable(),
  open_commitments: z.string().trim().max(4000).optional().nullable(),
}).strict();

module.exports = function registerIndustryWorkflows(app, db) {
  app.get('/api/quotations/:id/negotiations', auth, (req, res, next) => {
    try {
      const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
      if (!quote) throw new NotFoundError('Quotation not found.');
      if (!isCentral(req.user) && !isSales(req.user)) throw new ForbiddenError('Commercial access required.');
      res.json(db.prepare(`SELECT n.*, requester.name AS requester_name, manager.name AS manager_name,
        admin.name AS admin_name FROM negotiation_rounds n
        LEFT JOIN employees requester ON requester.id = n.requested_by
        LEFT JOIN employees manager ON manager.id = n.manager_id
        LEFT JOIN employees admin ON admin.id = n.admin_id
        WHERE n.quotation_id = ? ORDER BY n.created_at DESC`).all(quote.id));
    } catch (error) { next(error); }
  });

  app.post('/api/quotations/:id/counteroffers', auth, validate({ body: counterofferSchema }), (req, res, next) => {
    try {
      const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
      if (!quote) throw new NotFoundError('Quotation not found.');
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(quote.lead_id);
      if (!isSales(req.user) || (quote.created_by !== req.user.id && lead.assigned_bdm !== req.user.id)) {
        throw new ForbiddenError('Only assigned Sales can record the customer counteroffer.');
      }
      if (!['Sent', 'Negotiation'].includes(quote.status)) throw new ConflictError('Release the quotation before recording a counteroffer.');
      const id = generateId(db, 'KRY-NEG', 'negotiation_rounds');
      db.transaction(() => {
        db.prepare(`INSERT INTO negotiation_rounds
          (id, quotation_id, quotation_version, lead_id, requested_by, customer_request,
           proposed_amount, proposed_discount_percent, proposed_terms, proposed_payment_milestones)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, quote.id, quote.version, quote.lead_id, req.user.id, req.body.customer_request,
            req.body.proposed_amount || null, req.body.proposed_discount_percent ?? null,
            req.body.proposed_terms || null, req.body.proposed_payment_milestones || null);
        db.prepare("UPDATE quotations SET status = 'Negotiation', updated_at = datetime('now') WHERE id = ?").run(quote.id);
        notifyCentral(db, 'COUNTEROFFER', `Customer counteroffer recorded for ${lead.customer_name}.`, '#quotations', 'quotation', quote.id);
        logAction(db, lead.id, 'COUNTEROFFER_RECORDED', req.user.id, null, 'Sales', req.body.customer_request, lead.stage, 'Negotiation');
        audit(db, req.user.id, 'CREATE', 'negotiation_round', id, req.body.customer_request, null, req.body, req.ip);
      })();
      res.status(201).json(db.prepare('SELECT * FROM negotiation_rounds WHERE id = ?').get(id));
    } catch (error) { next(error); }
  });

  app.post('/api/negotiations/:id/manager-decision', auth, validate({ body: decisionSchema }), (req, res, next) => {
    try {
      if (!isSalesManager(req.user) && req.user.role !== 'SENIOR_BDM') throw new ForbiddenError('Senior Sales approval required.');
      const round = db.prepare('SELECT * FROM negotiation_rounds WHERE id = ?').get(req.params.id);
      if (!round) throw new NotFoundError('Negotiation round not found.');
      if (round.status !== 'Pending Manager') throw new ConflictError('Manager decision is already recorded.');
      const status = req.body.action === 'Approve' ? 'Pending Admin' : 'Rejected';
      db.prepare(`UPDATE negotiation_rounds SET status = ?, manager_id = ?, manager_decision = ?,
        manager_remarks = ?, manager_decided_at = datetime('now') WHERE id = ?`)
        .run(status, req.user.id, req.body.action, req.body.remarks, round.id);
      notifyCentral(db, 'NEGOTIATION_DECISION', `Manager decision recorded for negotiation ${round.id}.`, '#quotations', 'quotation', round.quotation_id);
      audit(db, req.user.id, 'MANAGER_DECISION', 'negotiation_round', round.id, req.body.remarks, round, { status }, req.ip);
      res.json(db.prepare('SELECT * FROM negotiation_rounds WHERE id = ?').get(round.id));
    } catch (error) { next(error); }
  });

  app.post('/api/negotiations/:id/admin-decision', auth, requireCentral(), validate({ body: decisionSchema }), (req, res, next) => {
    try {
      const round = db.prepare('SELECT * FROM negotiation_rounds WHERE id = ?').get(req.params.id);
      if (!round) throw new NotFoundError('Negotiation round not found.');
      if (round.status !== 'Pending Admin') throw new ConflictError('A manager-approved request is required.');
      const status = req.body.action === 'Approve' ? 'Released to Sales' : 'Rejected';
      db.transaction(() => {
        db.prepare(`UPDATE negotiation_rounds SET status = ?, admin_id = ?, admin_decision = ?,
          admin_remarks = ?, admin_decided_at = datetime('now') WHERE id = ?`)
          .run(status, req.user.id, req.body.action, req.body.remarks, round.id);
        if (status === 'Released to Sales') {
          db.prepare(`UPDATE quotations SET amount = coalesce(?, amount), discount_percent = coalesce(?, discount_percent),
            terms = coalesce(?, terms), payment_milestones = coalesce(?, payment_milestones),
            status = 'Negotiation', updated_at = datetime('now') WHERE id = ?`)
            .run(round.proposed_amount, round.proposed_discount_percent, round.proposed_terms,
              round.proposed_payment_milestones, round.quotation_id);
        }
        audit(db, req.user.id, 'ADMIN_NEGOTIATION_DECISION', 'negotiation_round', round.id,
          req.body.remarks, round, { status }, req.ip);
      })();
      notify(db, round.requested_by, 'NEGOTIATION_RELEASE', `Admin ${status.toLowerCase()} negotiation ${round.id}.`, '#quotations', 'quotation', round.quotation_id);
      res.json(db.prepare('SELECT * FROM negotiation_rounds WHERE id = ?').get(round.id));
    } catch (error) { next(error); }
  });

  app.post('/api/quotations/:id/customer-acceptance', auth, requireCentral(), validate({ body: acceptanceSchema }), (req, res, next) => {
    try {
      const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
      if (!quote) throw new NotFoundError('Quotation not found.');
      if (!['Sent', 'Negotiation', 'Approved'].includes(quote.status)) throw new ConflictError('Quotation must be released before acceptance.');
      db.transaction(() => {
        db.prepare(`UPDATE quotation_versions SET customer_status = 'Accepted', customer_response_ref = ?,
          customer_responded_at = datetime('now'), admin_status = 'Approved', admin_id = ?,
          admin_decided_at = datetime('now') WHERE quotation_id = ? AND version = ?`)
          .run(req.body.customer_response_ref, req.user.id, quote.id, quote.version);
        db.prepare("UPDATE quotations SET status = 'Approved', approved_by = ?, updated_at = datetime('now') WHERE id = ?")
          .run(req.user.id, quote.id);
        db.prepare("UPDATE leads SET stage = 'Approved', updated_at = datetime('now'), version = version + 1 WHERE id = ?")
          .run(quote.lead_id);
        audit(db, req.user.id, 'CUSTOMER_ACCEPTANCE', 'quotation', quote.id,
          req.body.customer_response_ref, quote, { version: quote.version, accepted: true }, req.ip);
      })();
      res.json({ ok: true, quotation_id: quote.id, version: quote.version, status: 'Approved' });
    } catch (error) { next(error); }
  });

  app.post('/api/projects/:id/handoff', auth, requireCentral(), validate({ body: handoffSchema }), (req, res, next) => {
    try {
      const project = db.prepare(`SELECT p.*, wo.quotation_id FROM projects p
        JOIN work_orders wo ON wo.id = p.work_order_id WHERE p.id = ?`).get(req.params.id);
      if (!project) throw new NotFoundError('Project not found.');
      const quote = db.prepare('SELECT * FROM quotations WHERE id = ?').get(project.quotation_id);
      if (!quote || quote.status !== 'Approved') throw new ConflictError('Accepted quotation required for handoff.');
      const id = generateId(db, 'KRY-HO', 'project_handoffs');
      db.prepare(`INSERT INTO project_handoffs
        (id, project_id, lead_id, quotation_id, quotation_version, scope_summary, exclusions,
         payment_milestones, site_risks, open_commitments, prepared_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET scope_summary = excluded.scope_summary,
         exclusions = excluded.exclusions, site_risks = excluded.site_risks,
         open_commitments = excluded.open_commitments, status = 'Pending PM Acknowledgement',
         prepared_by = excluded.prepared_by, created_at = datetime('now')`)
        .run(id, project.id, project.lead_id, quote.id, quote.version, req.body.scope_summary,
          req.body.exclusions || null, quote.payment_milestones || null, req.body.site_risks || null,
          req.body.open_commitments || null, req.user.id);
      notify(db, project.project_manager, 'PROJECT_HANDOFF', `Project ${project.id} is ready for acknowledgement.`, '#projects', 'project', project.id);
      res.status(201).json(db.prepare('SELECT * FROM project_handoffs WHERE project_id = ?').get(project.id));
    } catch (error) { next(error); }
  });

  app.post('/api/project-handoffs/:id/acknowledge', auth, validate({ body: z.object({
    action: z.enum(['Acknowledge', 'Return']), notes: z.string().trim().min(1).max(4000),
  }).strict() }), (req, res, next) => {
    try {
      const handoff = db.prepare(`SELECT h.*, p.project_manager FROM project_handoffs h
        JOIN projects p ON p.id = h.project_id WHERE h.id = ?`).get(req.params.id);
      if (!handoff) throw new NotFoundError('Handoff not found.');
      if (handoff.project_manager !== req.user.id) throw new ForbiddenError('Assigned Project Manager acknowledgement required.');
      const status = req.body.action === 'Acknowledge' ? 'Acknowledged' : 'Returned to Admin';
      db.prepare(`UPDATE project_handoffs SET status = ?, acknowledged_by = ?, acknowledgement_notes = ?,
        acknowledged_at = datetime('now') WHERE id = ?`).run(status, req.user.id, req.body.notes, handoff.id);
      notifyCentral(db, 'HANDOFF_ACKNOWLEDGEMENT', `Project handoff ${handoff.id} is ${status}.`, '#projects', 'project', handoff.project_id);
      res.json({ ok: true, status });
    } catch (error) { next(error); }
  });

  app.post('/api/project-handoffs/:id/complete', auth, requireCentral(), (req, res, next) => {
    try {
      const handoff = db.prepare('SELECT * FROM project_handoffs WHERE id = ?').get(req.params.id);
      if (!handoff) throw new NotFoundError('Handoff not found.');
      if (handoff.status !== 'Acknowledged') throw new ConflictError('Project Manager acknowledgement required.');
      db.transaction(() => {
        db.prepare("UPDATE project_handoffs SET status = 'Complete', completed_at = datetime('now') WHERE id = ?").run(handoff.id);
        db.prepare("UPDATE projects SET status = 'In Progress' WHERE id = ?").run(handoff.project_id);
        db.prepare("UPDATE leads SET stage = 'In Progress', updated_at = datetime('now') WHERE id = ?").run(handoff.lead_id);
      })();
      res.json({ ok: true, status: 'Complete' });
    } catch (error) { next(error); }
  });

  app.get('/api/role-dashboard', auth, (req, res, next) => {
    try {
      const mine = isCentral(req.user) ? '1=1' : 't.assigned_to = ?';
      const params = isCentral(req.user) ? [] : [req.user.id];
      const taskCounts = db.prepare(`SELECT
        sum(CASE WHEN t.status IN ('Assigned','In Progress') THEN 1 ELSE 0 END) active,
        sum(CASE WHEN t.status = 'Submitted' THEN 1 ELSE 0 END) submitted,
        sum(CASE WHEN t.status IN ('Assigned','In Progress') AND datetime(coalesce(t.due_date, t.created_at)) < datetime('now') THEN 1 ELSE 0 END) overdue
        FROM tasks t WHERE ${mine}`).get(...params);
      const negotiations = (isCentral(req.user) || isSales(req.user))
        ? db.prepare(`SELECT status, count(*) count FROM negotiation_rounds GROUP BY status`).all()
        : [];
      const financial = (isCentral(req.user) || req.user.role === 'ACCOUNTS') ? db.prepare(`SELECT
        (SELECT coalesce(sum(total_paise),0) FROM invoices WHERE status != 'Cancelled') invoiced,
        (SELECT coalesce(sum(amount_paise),0) FROM payments WHERE status = 'Cleared') paid`).get() : null;
      const projectCounts = (isCentral(req.user) || ['PROJECT_MANAGER','SITE_ENGINEER'].includes(req.user.role))
        ? db.prepare('SELECT status, count(*) count FROM projects GROUP BY status').all()
        : [];
      res.json({ role: req.user.role, tasks: taskCounts, negotiations, financial, projects: projectCounts });
    } catch (error) { next(error); }
  });
};
