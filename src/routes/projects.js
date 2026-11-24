/**
 * Project execution: progress updates, milestones and closure.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { requireCentral, isCentral } = require('../middleware/rbac');
const {
  requireFields,
  sanitizeText,
  toNumber,
  toInt,
  isIsoDate,
  validate,
  z,
} = require('../middleware/validate');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../middleware/errors');
const { canTransition } = require('../lib/state-machine');
const { audit, notifyCentral, logAction } = require('../lib/audit-notify');
const { verifyHandoverPrerequisites } = require('../lib/services/handover-service');

const PROJECT_STATUSES = ['Planning', 'In Progress', 'On Hold', 'Completed', 'Closed'];
const MILESTONE_STATUSES = ['Pending', 'In Progress', 'Completed', 'Delayed'];

function canViewCommercial(user) {
  if (!user) return false;
  return isCentral(user) || ['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE'].includes(user.role);
}

const projectUpdateSchema = z.object({
  update_type: z.string().trim().min(1, 'Update type is required.').max(120),
  details: z.string().trim().min(1, 'Details are required.').max(6000),
  progress: z.coerce.number().min(0).max(100).optional().nullable(),
  blockers: z.string().trim().max(4000).optional().nullable(),
  attachments: z.string().trim().max(2000).optional().nullable(),
}).strict();

const projectPatchSchema = z.object({
  status: z.enum(['Planning', 'In Progress', 'On Hold', 'Completed', 'Closed']).optional().nullable(),
  project_manager: z.string().trim().optional().nullable(),
  site_engineer: z.string().trim().optional().nullable(),
  target_completion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  progress: z.coerce.number().min(0).max(100).optional().nullable(),
  milestones: z.array(z.any()).optional().nullable(),
  override_billing: z.boolean().optional(),
}).strict();

const milestonePatchSchema = z.object({
  status: z.enum(['Pending', 'In Progress', 'Completed', 'Delayed']).optional().nullable(),
  completed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  weightage_percent: z.coerce.number().min(0).max(100).optional().nullable(),
}).strict();

function projectAccess(user, project) {
  return isCentral(user) || project.project_manager === user.id || project.site_engineer === user.id;
}

function loadProject(db, id) {
  return db
    .prepare(
      `SELECT p.*, w.amount AS contract_amount, w.customer_approval_date,
              l.customer_name, l.phone AS customer_phone, l.location AS project_location,
              l.stage AS lead_stage,
              pm.name AS pm_name, se.name AS engineer_name
       FROM projects p
       JOIN work_orders w ON w.id = p.work_order_id
       JOIN leads l ON l.id = p.lead_id
       LEFT JOIN employees pm ON pm.id = p.project_manager
       LEFT JOIN employees se ON se.id = p.site_engineer
       WHERE p.id = ?`,
    )
    .get(id);
}

function milestoneProgress(db, projectId) {
  const row = db
    .prepare(
      `SELECT coalesce(sum(weightage_percent), 0) AS total,
              coalesce(sum(CASE WHEN status = 'Completed' THEN weightage_percent ELSE 0 END), 0) AS done
       FROM project_milestones WHERE project_id = ?`,
    )
    .get(projectId);
  if (!row.total) return null;
  return Math.round((row.done / row.total) * 1000) / 10;
}

function replaceMilestones(db, projectId, input) {
  if (!Array.isArray(input)) throw new ValidationError('milestones must be an array.');
  const rows = input.slice(0, 50).map((entry, index) => ({
    title: sanitizeText(entry.title, 200) || `Milestone ${index + 1}`,
    description: sanitizeText(entry.description, 2000),
    weightage: Math.max(0, Math.min(toNumber(entry.weightage_percent, 0) || 0, 100)),
    targetDate: entry.target_date && isIsoDate(entry.target_date) ? entry.target_date : null,
    status: MILESTONE_STATUSES.includes(entry.status) ? entry.status : 'Pending',
    completedDate: entry.status === 'Completed' ? entry.completed_date || new Date().toISOString().slice(0, 10) : null,
  }));
  if (!rows.length) throw new ValidationError('At least one milestone is required.');
  const total = rows.reduce((sum, row) => sum + row.weightage, 0);
  if (total > 0 && Math.abs(total - 100) > 0.01) {
    // Normalise to 100 so progress maths stays meaningful.
    rows.forEach((row) => {
      row.weightage = Math.round((row.weightage / total) * 10000) / 100;
    });
  }

  db.prepare('DELETE FROM project_milestones WHERE project_id = ?').run(projectId);
  const insert = db.prepare(
    `INSERT INTO project_milestones
      (project_id, title, description, order_index, weightage_percent, target_date,
       completed_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((row, index) => {
    insert.run(
      projectId,
      row.title,
      row.description,
      index + 1,
      row.weightage,
      row.targetDate,
      row.completedDate,
      row.status,
    );
  });
  return rows;
}

module.exports = function registerProjectRoutes(app, db) {
  app.get('/api/projects', auth, (req, res) => {
    const conditions = [];
    const params = [];
    if (!isCentral(req.user)) {
      conditions.push('(p.project_manager = ? OR p.site_engineer = ?)');
      params.push(req.user.id, req.user.id);
    }
    if (req.query.status) {
      conditions.push('p.status = ?');
      params.push(String(req.query.status));
    }

    const rows = db
      .prepare(
        `SELECT p.*, w.amount AS contract_amount, w.customer_approval_date,
                l.customer_name, l.phone AS customer_phone, l.location AS project_location,
                l.stage AS lead_stage,
                pm.name AS pm_name, se.name AS engineer_name,
                (SELECT count(*) FROM project_milestones m WHERE m.project_id = p.id) AS milestone_count,
                (SELECT count(*) FROM project_milestones m WHERE m.project_id = p.id AND m.status = 'Completed') AS milestones_completed
         FROM projects p
         JOIN work_orders w ON w.id = p.work_order_id
         JOIN leads l ON l.id = p.lead_id
         LEFT JOIN employees pm ON pm.id = p.project_manager
         LEFT JOIN employees se ON se.id = p.site_engineer
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY p.created_at DESC
         LIMIT 500`,
      )
      .all(...params);
    if (!canViewCommercial(req.user)) {
      rows.forEach((r) => {
        r.contract_amount = null;
      });
    }
    res.json(rows);
  });

  app.get('/api/projects/:id', auth, (req, res, next) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) throw new NotFoundError('Project not found.');
      if (!projectAccess(req.user, project)) throw new ForbiddenError('You are not assigned to this project.');

      const updates = db
        .prepare(
          `SELECT pu.*, e.name AS employee_name, e.role AS employee_role
           FROM project_updates pu
           LEFT JOIN employees e ON e.id = pu.employee_id
           WHERE pu.project_id = ? ORDER BY pu.created_at DESC`,
        )
        .all(project.id);
      const milestones = db
        .prepare('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY order_index, id')
        .all(project.id);
      const workOrder = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(project.work_order_id);
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);
      const handoff = db.prepare('SELECT * FROM project_handoffs WHERE project_id = ?').get(project.id) || null;

      if (!canViewCommercial(req.user)) {
        project.contract_amount = null;
        if (workOrder) {
          workOrder.amount = null;
          workOrder.tax_amount = null;
          workOrder.contract_value = null;
          workOrder.payment_terms = null;
        }
      }

      res.json({ project, updates, milestones, workOrder, lead, handoff });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/projects/:id/updates',
    auth,
    validate({ body: projectUpdateSchema }),
    (req, res, next) => {
      try {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
        if (!project) throw new NotFoundError('Project not found.');
        if (isCentral(req.user) || !projectAccess(req.user, project)) {
          throw new ForbiddenError('Only the assigned Project Manager or Site Engineer can submit progress.');
        }
        if (project.status === 'Closed') {
          throw new ConflictError('A closed project cannot accept new updates.');
        }

        const updateType = sanitizeText(req.body.update_type, 120);
        const details = sanitizeText(req.body.details, 6000);
        if (!updateType || !details) throw new ValidationError('Update type and details are required.');

        const progress = Math.max(
          0,
          Math.min(100, toNumber(req.body.progress, project.progress) ?? project.progress),
        );
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);

        db.transaction(() => {
          db.prepare(
            `INSERT INTO project_updates
              (project_id, employee_id, update_type, details, progress, blockers, attachments)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            project.id,
            req.user.id,
            updateType,
            details,
            progress,
            sanitizeText(req.body.blockers, 4000),
            sanitizeText(req.body.attachments, 2000),
          );

          let status = project.status;
          if (progress >= 100) status = 'Completed';
          else if (project.status === 'Planning' && progress > 0) status = 'In Progress';

          db.prepare(
            `UPDATE projects
             SET progress = ?, status = ?,
                 actual_completion = CASE WHEN ? >= 100 AND actual_completion IS NULL THEN date('now') ELSE actual_completion END,
                 updated_at = datetime('now')
             WHERE id = ?`,
          ).run(progress, status, progress, project.id);

          if (lead && progress > 0) {
            if (lead.stage === 'Project Handoff' && canTransition(lead.stage, 'In Progress', req.user.role)) {
              db.prepare("UPDATE leads SET stage = 'In Progress', updated_at = datetime('now'), version = version + 1 WHERE id = ?").run(lead.id);
              logAction(
                db,
                lead.id,
                'STAGE_CHANGE',
                req.user.id,
                project.project_manager,
                'Projects',
                `Project ${project.id} started. Progress ${progress}%.`,
                lead.stage,
                'In Progress',
              );
            }
            if (
              progress >= 100 &&
              ['Project Handoff', 'In Progress'].includes(
                db.prepare('SELECT stage FROM leads WHERE id = ?').get(lead.id).stage,
              )
            ) {
              const current = db.prepare('SELECT stage FROM leads WHERE id = ?').get(lead.id).stage;
              if (current === 'In Progress' && canTransition(current, 'Completed', req.user.role)) {
                db.prepare("UPDATE leads SET stage = 'Completed', updated_at = datetime('now'), version = version + 1 WHERE id = ?").run(lead.id);
                logAction(
                  db,
                  lead.id,
                  'STAGE_CHANGE',
                  req.user.id,
                  project.project_manager,
                  'Projects',
                  `Project ${project.id} completed at 100%.`,
                  current,
                  'Completed',
                );
              }
            }
          }

          logAction(
            db,
            project.lead_id,
            'DEPT_UPDATE',
            req.user.id,
            project.project_manager,
            'Projects',
            `[${project.id}] ${updateType}: ${details}. Progress ${progress}%.${req.body.blockers ? ` Blockers: ${sanitizeText(req.body.blockers, 1000)}` : ''}`,
            null,
            null,
          );
          notifyCentral(
            db,
            'PROJECT_UPDATE',
            `${req.user.name} reported ${progress}% progress on project ${project.id}.`,
            '#projects',
            'project',
            project.id,
          );
          audit(
            db,
            req.user.id,
            'SUBMIT_UPDATE',
            'project',
            project.id,
            `Progress ${progress}% (${updateType})`,
            null,
            null,
            req.ip,
          );
        })();

        res.status(201).json({ ok: true, project_id: project.id, progress });
      } catch (err) {
        next(err);
      }
    },
  );

  app.patch(
    '/api/projects/:id',
    auth,
    requireCentral(),
    validate({ body: projectPatchSchema }),
    (req, res, next) => {
    try {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
      if (!project) throw new NotFoundError('Project not found.');
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(project.lead_id);

      const updates = {};
      if (req.body.status !== undefined) {
        const status = String(req.body.status);
        if (!PROJECT_STATUSES.includes(status)) {
          throw new ValidationError(`status must be one of: ${PROJECT_STATUSES.join(', ')}.`);
        }
        updates.status = status;
      }
      if (req.body.project_manager !== undefined) {
        const pm = db
          .prepare("SELECT id, active FROM employees WHERE id = ? AND role = 'PROJECT_MANAGER'")
          .get(req.body.project_manager);
        if (!pm || !pm.active) throw new ValidationError('Choose an active Project Manager.');
        updates.project_manager = pm.id;
      }
      if (req.body.site_engineer !== undefined) {
        const engineer = db
          .prepare("SELECT id, active FROM employees WHERE id = ? AND role = 'SITE_ENGINEER'")
          .get(req.body.site_engineer);
        if (!engineer || !engineer.active) throw new ValidationError('Choose an active Site Engineer.');
        updates.site_engineer = engineer.id;
      }
      if (req.body.target_completion !== undefined) {
        if (req.body.target_completion && !isIsoDate(req.body.target_completion)) {
          throw new ValidationError('target_completion must use the YYYY-MM-DD format.');
        }
        updates.target_completion = req.body.target_completion || null;
      }
      if (req.body.progress !== undefined) {
        updates.progress = Math.max(0, Math.min(100, toNumber(req.body.progress, project.progress) ?? project.progress));
      }
      if (req.body.milestones !== undefined) {
        replaceMilestones(db, project.id, req.body.milestones);
        const computed = milestoneProgress(db, project.id);
        if (computed !== null) updates.progress = computed;
      }

      if (!Object.keys(updates).length) throw new ValidationError('No supported fields were supplied.');

      if (updates.status === 'Completed' || updates.status === 'Closed') {
        verifyHandoverPrerequisites(db, project, {
          override_billing: Boolean(req.body.override_billing),
          user: req.user,
        });
      }

      db.transaction(() => {
        const columns = Object.keys(updates);
        db.prepare(
          `UPDATE projects SET ${columns.map((column) => `${column} = ?`).join(', ')},
             actual_completion = CASE
               WHEN ? = 'Completed' AND actual_completion IS NULL THEN date('now')
               WHEN ? = 'Closed' AND actual_completion IS NULL THEN date('now')
               ELSE actual_completion END,
             updated_at = datetime('now')
           WHERE id = ?`,
        ).run(...columns.map((column) => updates[column]), updates.status || project.status, updates.status || project.status, project.id);

        if (lead) {
          const nextStatus = updates.status;
          if (nextStatus === 'In Progress' && lead.stage === 'Project Handoff' && canTransition(lead.stage, 'In Progress', req.user.role)) {
            db.prepare("UPDATE leads SET stage = 'In Progress', updated_at = datetime('now'), version = version + 1 WHERE id = ?").run(lead.id);
            logAction(db, lead.id, 'STAGE_CHANGE', req.user.id, project.project_manager, 'Projects', 'Project moved to In Progress by Admin Desk.', lead.stage, 'In Progress');
          }
          if (nextStatus === 'Completed' && lead.stage === 'In Progress' && canTransition(lead.stage, 'Completed', req.user.role)) {
            db.prepare("UPDATE leads SET stage = 'Completed', updated_at = datetime('now'), version = version + 1 WHERE id = ?").run(lead.id);
            logAction(db, lead.id, 'STAGE_CHANGE', req.user.id, project.project_manager, 'Projects', 'Project marked Completed by Admin Desk.', lead.stage, 'Completed');
          }
          if (nextStatus === 'Closed') {
            const current = db.prepare('SELECT stage FROM leads WHERE id = ?').get(lead.id).stage;
            if (current === 'Completed' && canTransition(current, 'Closed', req.user.role)) {
              db.prepare("UPDATE leads SET stage = 'Closed', updated_at = datetime('now'), version = version + 1 WHERE id = ?").run(lead.id);
              logAction(db, lead.id, 'STAGE_CHANGE', req.user.id, null, 'Administration', 'Lead closed after project completion.', current, 'Closed');
            }
          }
        }

        audit(
          db,
          req.user.id,
          'UPDATE',
          'project',
          project.id,
          `Updated ${Object.keys(updates).join(', ')}`,
          { status: project.status, progress: project.progress },
          updates,
          req.ip,
        );
      })();

      res.json({ ok: true, project: loadProject(db, project.id) });
    } catch (err) {
      next(err);
    }
  });

  app.patch(
    '/api/projects/:id/milestones/:milestoneId',
    auth,
    requireCentral(),
    validate({ body: milestonePatchSchema }),
    (req, res, next) => {
    try {
      const milestone = db
        .prepare(
          `SELECT m.* FROM project_milestones m
           JOIN projects p ON p.id = m.project_id
           WHERE m.id = ? AND m.project_id = ?`,
        )
        .get(req.params.milestoneId, req.params.id);
      if (!milestone) throw new NotFoundError('Milestone not found.');

      const status = String(req.body.status || milestone.status);
      if (!MILESTONE_STATUSES.includes(status)) {
        throw new ValidationError(`status must be one of: ${MILESTONE_STATUSES.join(', ')}.`);
      }
      const completedDate =
        status === 'Completed' ? req.body.completed_date || new Date().toISOString().slice(0, 10) : null;

      db.prepare(
        `UPDATE project_milestones
         SET status = ?, completed_date = ?, verified_by = ?, title = coalesce(?, title),
             weightage_percent = coalesce(?, weightage_percent)
         WHERE id = ?`,
      ).run(
        status,
        completedDate,
        status === 'Completed' ? req.user.id : milestone.verified_by,
        sanitizeText(req.body.title, 200),
        req.body.weightage_percent !== undefined
          ? Math.max(0, Math.min(toNumber(req.body.weightage_percent, milestone.weightage_percent) || 0, 100))
          : null,
        milestone.id,
      );

      const computed = milestoneProgress(db, req.params.id);
      if (computed !== null) {
        db.prepare(
          "UPDATE projects SET progress = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(computed, req.params.id);
      }
      audit(db, req.user.id, 'UPDATE_MILESTONE', 'project_milestone', String(milestone.id), `Status ${status}`, null, null, req.ip);
      res.json({ ok: true, status, progress: computed });
    } catch (err) {
      next(err);
    }
  });
};
