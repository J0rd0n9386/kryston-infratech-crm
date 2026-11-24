/**
 * Admin Desk task board (central Kanban orchestrator).
 */
'use strict';

const { auth } = require('../middleware/auth');
const { isCentral } = require('../middleware/rbac');
const { getSlaStatus } = require('../lib/sla');
const { ForbiddenError } = require('../middleware/errors');

const COLUMN_DEFINITIONS = [
  { key: 'new', title: 'New Leads', description: 'Awaiting telecaller assignment' },
  { key: 'telecaller', title: 'With Telecaller', description: 'Qualification call in progress' },
  { key: 'response_received', title: 'Response Received', description: 'Ready for Admin routing' },
  { key: 'routed', title: 'Routed to Department', description: 'Spoke work in progress' },
  { key: 'update_received', title: 'Update Received', description: 'Awaiting Admin review' },
  { key: 'review_quote', title: 'Review / Negotiation', description: 'Quotation and approval' },
  { key: 'finalized_closed', title: 'Work Order / Closed', description: 'Handoff and execution' },
];

function columnForStage(stage) {
  if (stage === 'New') return 'new';
  if (stage === 'With Telecaller') return 'telecaller';
  if (stage === 'Response Received') return 'response_received';
  if (
    stage.startsWith('Routed to') ||
    stage === 'Site Visit Scheduled' ||
    stage === 'Design In Progress'
  ) {
    return 'routed';
  }
  if (stage === 'Update Received') return 'update_received';
  if (
    ['Quotation Stage', 'Quotation Sent', 'Negotiation', 'Approved', 'Follow-up Required'].includes(stage)
  ) {
    return 'review_quote';
  }
  return 'finalized_closed';
}

function decorate(task) {
  return task ? { ...task, sla: getSlaStatus(task.created_at, task.sla_hours) } : null;
}

module.exports = function registerTaskboardRoutes(app, db) {
  app.get('/api/taskboard', auth, (req, res, next) => {
    try {
      if (!isCentral(req.user)) {
        throw new ForbiddenError('The Admin Task Board is restricted to Admin Desk and Super Admin.');
      }

      const leads = db
        .prepare(
          `SELECT l.*,
                  tc.name AS telecaller_name,
                  bdm.name AS bdm_name,
                  eng.name AS engineer_name,
                  arc.name AS architect_name,
                  pm.name AS pm_name,
                  owner.name AS owner_name
           FROM leads l
           LEFT JOIN employees tc ON tc.id = l.assigned_telecaller
           LEFT JOIN employees bdm ON bdm.id = l.assigned_bdm
           LEFT JOIN employees eng ON eng.id = l.assigned_engineer
           LEFT JOIN employees arc ON arc.id = l.assigned_architect
           LEFT JOIN employees pm ON pm.id = l.assigned_pm
           LEFT JOIN employees owner ON owner.id = l.current_owner
           WHERE l.deleted_at IS NULL
           ORDER BY l.updated_at DESC
           LIMIT 1000`,
        )
        .all();

      const tasks = db
        .prepare(
          `SELECT t.*, e.name AS assignee_name
           FROM tasks t
           LEFT JOIN employees e ON e.id = t.assigned_to
           WHERE t.status IN ('Assigned', 'In Progress', 'Submitted')
           ORDER BY t.created_at DESC`,
        )
        .all();

      const activeByLead = new Map();
      const pendingByLead = new Map();
      for (const task of tasks) {
        if (!task.lead_id) continue;
        if (task.status === 'Submitted') {
          if (!pendingByLead.has(task.lead_id)) pendingByLead.set(task.lead_id, decorate(task));
        } else if (!activeByLead.has(task.lead_id)) {
          activeByLead.set(task.lead_id, decorate(task));
        }
      }

      const columns = {};
      for (const definition of COLUMN_DEFINITIONS) {
        columns[definition.key] = {
          title: definition.title,
          description: definition.description,
          count: 0,
          items: [],
        };
      }

      for (const lead of leads) {
        const key = columnForStage(lead.stage);
        columns[key].items.push({
          ...lead,
          activeTask: activeByLead.get(lead.id) || null,
          pendingTask: pendingByLead.get(lead.id) || null,
        });
      }
      for (const key of Object.keys(columns)) columns[key].count = columns[key].items.length;

      res.json({ generatedAt: new Date().toISOString(), columns });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/taskboard/stats', auth, (req, res, next) => {
    try {
      if (!isCentral(req.user)) {
        throw new ForbiddenError('Task board metrics are restricted to Admin Desk and Super Admin.');
      }

      const count = (sql, ...params) => db.prepare(sql).get(...params).c;
      const activeTasks = db
        .prepare(
          `SELECT created_at, sla_hours FROM tasks
           WHERE status IN ('Assigned', 'In Progress', 'Submitted')`,
        )
        .all();

      let overdueCount = 0;
      let warningCount = 0;
      for (const task of activeTasks) {
        const sla = getSlaStatus(task.created_at, task.sla_hours);
        if (sla.status === 'overdue') overdueCount += 1;
        else if (sla.status === 'warning') warningCount += 1;
      }

      const slaCompliance =
        activeTasks.length > 0
          ? Math.round(((activeTasks.length - overdueCount) / activeTasks.length) * 100)
          : 100;

      res.json({
        totalLeads: count('SELECT count(*) AS c FROM leads WHERE deleted_at IS NULL'),
        openLeads: count(
          "SELECT count(*) AS c FROM leads WHERE deleted_at IS NULL AND stage NOT IN ('Closed','Lost')",
        ),
        responseReceived: count(
          "SELECT count(*) AS c FROM leads WHERE deleted_at IS NULL AND stage = 'Response Received'",
        ),
        updateReceived: count(
          "SELECT count(*) AS c FROM leads WHERE deleted_at IS NULL AND stage = 'Update Received'",
        ),
        pendingAdminReview: count("SELECT count(*) AS c FROM tasks WHERE status = 'Submitted'"),
        woPendingApproval: count(
          "SELECT count(*) AS c FROM work_orders WHERE status = 'Pending Admin Approval'",
        ),
        woFinalized: count("SELECT count(*) AS c FROM work_orders WHERE status = 'Finalized'"),
        activeTasksCount: activeTasks.length,
        overdueCount,
        warningCount,
        slaCompliance,
      });
    } catch (err) {
      next(err);
    }
  });
};
