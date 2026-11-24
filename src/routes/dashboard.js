/**
 * Role-scoped dashboard analytics.
 *
 * Central roles see the organisation funnel, department queues and SLA health.
 * A spoke only ever receives metrics derived from the leads and tasks that are
 * assigned to them, which keeps the hub-and-spoke boundary intact even on the
 * reporting surface.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { isCentral } = require('../middleware/rbac');
const { getSlaStatus } = require('../lib/sla');

const OPEN_STAGES = [
  'New',
  'With Telecaller',
  'Response Received',
  'Routed to Sales',
  'Routed to Engineering',
  'Routed to Design',
  'Routed to Purchase',
  'Routed to Accounts',
  'Update Received',
  'Follow-up Required',
  'Site Visit Scheduled',
  'Design In Progress',
  'Quotation Stage',
  'Quotation Sent',
  'Negotiation',
  'Approved',
  'Work Order Pending Admin Approval',
  'Work Order Finalized',
  'Project Handoff',
  'In Progress',
];

const FUNNEL = [
  { key: 'intake', label: 'Total Intake', stages: null },
  { key: 'telecaller', label: 'With Telecaller', stages: ['With Telecaller'] },
  { key: 'response', label: 'Response Received', stages: ['Response Received'] },
  {
    key: 'routed',
    label: 'Routed to Department',
    stages: [
      'Routed to Sales',
      'Routed to Engineering',
      'Routed to Design',
      'Routed to Purchase',
      'Routed to Accounts',
      'Site Visit Scheduled',
      'Design In Progress',
    ],
  },
  {
    key: 'quotation',
    label: 'Quotation / Negotiation',
    stages: ['Quotation Stage', 'Quotation Sent', 'Negotiation', 'Approved'],
  },
  {
    key: 'workorder',
    label: 'Work Order',
    stages: ['Work Order Pending Admin Approval', 'Work Order Finalized', 'Project Handoff'],
  },
  { key: 'execution', label: 'Execution', stages: ['In Progress'] },
  { key: 'closed', label: 'Closed / Won', stages: ['Completed', 'Closed'] },
];

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function count(db, sql, params = []) {
  return db.prepare(sql).get(...params).c;
}

function slaSummary(tasks) {
  let overdue = 0;
  let warning = 0;
  const overdueTasks = [];

  for (const task of tasks) {
    const sla = getSlaStatus(task.created_at, task.sla_hours);
    if (sla.status === 'overdue') {
      overdue += 1;
      overdueTasks.push({ ...task, sla });
    } else if (sla.status === 'warning') {
      warning += 1;
    }
  }

  const compliance =
    tasks.length > 0 ? Math.round(((tasks.length - overdue) / tasks.length) * 100) : 100;

  return { overdue, warning, compliance, overdueTasks };
}

function centralDashboard(db) {
  const totalLeads = count(db, 'SELECT count(*) AS c FROM leads WHERE deleted_at IS NULL');
  const openLeads = count(
    db,
    `SELECT count(*) AS c FROM leads
     WHERE deleted_at IS NULL AND stage IN (${placeholders(OPEN_STAGES)})`,
    OPEN_STAGES,
  );
  const workOrdersCount = count(db, 'SELECT count(*) AS c FROM work_orders');
  const pendingWorkOrders = count(
    db,
    "SELECT count(*) AS c FROM work_orders WHERE status = 'Pending Admin Approval'",
  );
  const projectsCount = count(
    db,
    "SELECT count(*) AS c FROM projects WHERE status NOT IN ('Closed')",
  );
  const totalRevenue = db
    .prepare('SELECT coalesce(sum(amount), 0) AS total FROM work_orders')
    .get().total;

  const wonLeads = count(
    db,
    `SELECT count(*) AS c FROM leads
     WHERE deleted_at IS NULL AND stage IN ('Work Order Finalized', 'Project Handoff', 'In Progress', 'Completed', 'Closed')`,
  );
  const conversionRate = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 1000) / 10 : 0;

  let totalInvoicedPaise = 0;
  let totalCollectedPaise = 0;
  try {
    totalInvoicedPaise = db.prepare('SELECT coalesce(sum(total_paise), 0) AS t FROM invoices').get().t || 0;
    totalCollectedPaise = db.prepare("SELECT coalesce(sum(amount_paise), 0) AS t FROM payments WHERE status = 'Received'").get().t || 0;
  } catch {
    /* tables empty or migrating */
  }
  const outstandingPaise = Math.max(0, totalInvoicedPaise - totalCollectedPaise);

  const stageCounts = new Map(
    db
      .prepare(
        `SELECT stage, count(*) AS c FROM leads
         WHERE deleted_at IS NULL GROUP BY stage`,
      )
      .all()
      .map((row) => [row.stage, row.c]),
  );

  const funnel = FUNNEL.map((entry) => ({
    key: entry.key,
    stage: entry.label,
    count:
      entry.stages === null
        ? totalLeads
        : entry.stages.reduce((sum, stage) => sum + (stageCounts.get(stage) || 0), 0),
  }));

  const departmentQueue = db
    .prepare(
      `SELECT department, count(*) AS count,
              sum(CASE WHEN status = 'Submitted' THEN 1 ELSE 0 END) AS submitted
       FROM tasks
       WHERE status IN ('Assigned', 'In Progress', 'Submitted')
       GROUP BY department
       ORDER BY count DESC`,
    )
    .all();

  const activeTasks = db
    .prepare(
      `SELECT t.id, t.lead_id, t.department, t.task_type, t.status, t.created_at, t.sla_hours,
              t.due_date, e.name AS assignee_name, l.customer_name
       FROM tasks t
       LEFT JOIN employees e ON e.id = t.assigned_to
       LEFT JOIN leads l ON l.id = t.lead_id
       WHERE t.status IN ('Assigned', 'In Progress', 'Submitted')`,
    )
    .all();

  const sla = slaSummary(activeTasks);

  const recentActivity = db
    .prepare(
      `SELECT a.id, a.lead_id, a.action_type, a.remarks, a.old_stage, a.new_stage, a.created_at,
              l.customer_name, f.name AS from_name, t.name AS to_name
       FROM lead_actions a
       JOIN leads l ON l.id = a.lead_id
       LEFT JOIN employees f ON f.id = a.from_employee
       LEFT JOIN employees t ON t.id = a.to_employee
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 12`,
    )
    .all();

  return {
    scope: 'central',
    counts: {
      totalLeads,
      openLeads,
      workOrdersCount,
      pendingWorkOrders,
      projectsCount,
      totalRevenue,
      activeTasksCount: activeTasks.length,
      overdueCount: sla.overdue,
      warningCount: sla.warning,
      slaCompliance: sla.compliance,
      myPendingCount:
        count(
          db,
          `SELECT count(*) AS c FROM leads
           WHERE deleted_at IS NULL AND stage IN ('New', 'Response Received', 'Update Received')`,
        ) +
        count(db, "SELECT count(*) AS c FROM work_orders WHERE status = 'Pending Admin Approval'") +
        count(db, "SELECT count(*) AS c FROM tasks WHERE status = 'Submitted'"),
    },
    kpis: {
      conversionRate,
      wonLeads,
      totalInvoicedPaise,
      totalCollectedPaise,
      outstandingPaise,
    },
    funnel,
    departmentQueue,
    overdueTasks: sla.overdueTasks.slice(0, 6),
    recentActivity,
  };
}

function spokeDashboard(db, user) {
  const leadScope = `
    FROM leads l
    WHERE l.deleted_at IS NULL
      AND (
        l.assigned_telecaller = ? OR l.assigned_bdm = ? OR l.assigned_engineer = ?
        OR l.assigned_architect = ? OR l.assigned_pm = ?
        OR EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.assigned_to = ?)
      )`;
  const leadParams = [user.id, user.id, user.id, user.id, user.id, user.id];

  const totalLeads = count(db, `SELECT count(*) AS c ${leadScope}`, leadParams);
  const openLeads = count(
    db,
    `SELECT count(*) AS c ${leadScope} AND l.stage IN (${placeholders(OPEN_STAGES)})`,
    [...leadParams, ...OPEN_STAGES],
  );

  const stageCounts = new Map(
    db
      .prepare(`SELECT l.stage, count(*) AS c ${leadScope} GROUP BY l.stage`)
      .all(...leadParams)
      .map((row) => [row.stage, row.c]),
  );

  const funnel = FUNNEL.map((entry) => ({
    key: entry.key,
    stage: entry.label,
    count:
      entry.stages === null
        ? totalLeads
        : entry.stages.reduce((sum, stage) => sum + (stageCounts.get(stage) || 0), 0),
  }));

  const myTasks = db
    .prepare(
      `SELECT t.id, t.lead_id, t.department, t.task_type, t.status, t.created_at, t.sla_hours,
              t.due_date, l.customer_name
       FROM tasks t
       LEFT JOIN leads l ON l.id = t.lead_id
       WHERE t.assigned_to = ? AND t.status IN ('Assigned', 'In Progress', 'Submitted')
       ORDER BY t.created_at DESC`,
    )
    .all(user.id);

  const sla = slaSummary(myTasks);
  const projectsCount = count(
    db,
    `SELECT count(*) AS c FROM projects
     WHERE status NOT IN ('Closed') AND (project_manager = ? OR site_engineer = ?)`,
    [user.id, user.id],
  );

  const recentActivity = db
    .prepare(
      `SELECT a.id, a.lead_id, a.action_type, a.remarks, a.old_stage, a.new_stage, a.created_at,
              l.customer_name, f.name AS from_name, t.name AS to_name
       FROM lead_actions a
       JOIN leads l ON l.id = a.lead_id
       LEFT JOIN employees f ON f.id = a.from_employee
       LEFT JOIN employees t ON t.id = a.to_employee
       WHERE a.lead_id IN (
         SELECT l2.id FROM leads l2 WHERE l2.deleted_at IS NULL AND (
           l2.assigned_telecaller = ? OR l2.assigned_bdm = ? OR l2.assigned_engineer = ?
           OR l2.assigned_architect = ? OR l2.assigned_pm = ?
           OR EXISTS (SELECT 1 FROM tasks t2 WHERE t2.lead_id = l2.id AND t2.assigned_to = ?)
         )
       )
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 12`,
    )
    .all(user.id, user.id, user.id, user.id, user.id, user.id);

  const departmentQueue = myTasks.length
    ? [
        {
          department: user.department,
          count: myTasks.length,
          submitted: myTasks.filter((task) => task.status === 'Submitted').length,
        },
      ]
    : [];

  return {
    scope: 'spoke',
    counts: {
      totalLeads,
      openLeads,
      workOrdersCount: count(
        db,
        `SELECT count(*) AS c FROM work_orders w
         JOIN leads l ON l.id = w.lead_id
         WHERE l.assigned_bdm = ?`,
        [user.id],
      ),
      pendingWorkOrders: 0,
      projectsCount,
      totalRevenue: 0,
      activeTasksCount: myTasks.length,
      overdueCount: sla.overdue,
      warningCount: sla.warning,
      slaCompliance: sla.compliance,
      myPendingCount: myTasks.filter((task) => task.status !== 'Submitted').length,
    },
    funnel,
    departmentQueue,
    overdueTasks: sla.overdueTasks.slice(0, 6),
    recentActivity,
    myTasks: myTasks.slice(0, 8),
  };
}

function departmentDashboard(db, department) {
  const tasks = db
    .prepare('SELECT id, status, created_at, sla_hours, submitted_at, reviewed_at FROM tasks WHERE department = ?')
    .all(department);

  const total = tasks.length;
  const assigned = tasks.filter((t) => t.status === 'Assigned').length;
  const inProgress = tasks.filter((t) => t.status === 'In Progress').length;
  const submitted = tasks.filter((t) => t.status === 'Submitted').length;
  const reviewed = tasks.filter((t) => t.status === 'Reviewed').length;
  const closed = tasks.filter((t) => t.status === 'Closed').length;

  const activeTasks = tasks.filter((t) => ['Assigned', 'In Progress'].includes(t.status));
  let overdueCount = 0;
  for (const t of activeTasks) {
    const sla = getSlaStatus(t.created_at, t.sla_hours);
    if (sla.status === 'overdue') overdueCount += 1;
  }

  const completedWithTime = tasks.filter((t) => t.submitted_at && t.created_at);
  let avgTurnaroundHours = 0;
  if (completedWithTime.length > 0) {
    const totalHours = completedWithTime.reduce((sum, t) => {
      const created = new Date(t.created_at).getTime();
      const submittedTime = new Date(t.submitted_at).getTime();
      const diffHours = Math.max((submittedTime - created) / (1000 * 60 * 60), 0);
      return sum + diffHours;
    }, 0);
    avgTurnaroundHours = Math.round((totalHours / completedWithTime.length) * 10) / 10;
  }

  const closedCount = submitted + reviewed + closed;
  const closureRate = total > 0 ? Math.round((closedCount / total) * 100) : 100;

  const assignees = db
    .prepare(
      `SELECT e.id, e.name, e.role,
              count(t.id) as task_count,
              sum(CASE WHEN t.status IN ('Assigned', 'In Progress') THEN 1 ELSE 0 END) as active_count,
              sum(CASE WHEN t.status IN ('Submitted', 'Reviewed', 'Closed') THEN 1 ELSE 0 END) as completed_count
       FROM employees e
       LEFT JOIN tasks t ON t.assigned_to = e.id AND t.department = ?
       WHERE e.department = ? OR e.id IN (SELECT assigned_to FROM tasks WHERE department = ?)
       GROUP BY e.id, e.name, e.role`,
    )
    .all(department, department, department);

  return {
    department,
    taskLoad: {
      total,
      assigned,
      inProgress,
      submitted,
      reviewed,
      closed,
    },
    avgTurnaroundHours,
    closureRate,
    overdueCount,
    assignees,
  };
}

function digitalMarketingDashboard(db, filters = {}) {
  const conditions = ['l.deleted_at IS NULL'];
  const params = [];

  if (filters.from) {
    conditions.push('l.created_at >= ?');
    params.push(String(filters.from));
  }
  if (filters.to) {
    const toVal = String(filters.to).length === 10 ? `${filters.to} 23:59:59` : String(filters.to);
    conditions.push('l.created_at <= ?');
    params.push(toVal);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const totalLeads = db.prepare(`SELECT count(*) as c FROM leads l ${whereClause}`).get(...params).c;

  const channelCounts = db
    .prepare(
      `SELECT l.channel, count(*) as count
       FROM leads l
       ${whereClause}
       GROUP BY l.channel
       ORDER BY count DESC`,
    )
    .all(...params);

  const sourceFunnel = db
    .prepare(
      `SELECT l.source,
              l.channel,
              count(DISTINCT l.id) AS leads_count,
              count(DISTINCT q.id) AS quotations_count,
              count(DISTINCT w.id) AS work_orders_count,
              coalesce(sum(DISTINCT w.amount), 0) AS revenue_won
       FROM leads l
       LEFT JOIN quotations q ON q.lead_id = l.id
       LEFT JOIN work_orders w ON w.lead_id = l.id
       ${whereClause}
       GROUP BY l.source, l.channel
       ORDER BY leads_count DESC`,
    )
    .all(...params)
    .map((row) => ({
      ...row,
      leadToQuoteConversionRate: row.leads_count > 0 ? Math.round((row.quotations_count / row.leads_count) * 100) : 0,
      leadToWoConversionRate: row.leads_count > 0 ? Math.round((row.work_orders_count / row.leads_count) * 100) : 0,
    }));

  const totalQuotations = sourceFunnel.reduce((sum, s) => sum + s.quotations_count, 0);
  const totalWorkOrders = sourceFunnel.reduce((sum, s) => sum + s.work_orders_count, 0);
  const totalRevenueWon = sourceFunnel.reduce((sum, s) => sum + s.revenue_won, 0);

  return {
    dateRange: {
      from: filters.from || null,
      to: filters.to || null,
    },
    counts: {
      totalLeads,
      totalQuotations,
      totalWorkOrders,
      totalRevenueWon,
      overallConversionRate: totalLeads > 0 ? Math.round((totalWorkOrders / totalLeads) * 100) : 0,
    },
    channelCounts,
    sourceFunnel,
  };
}

function superAdminDashboard(db) {
  const employees = db
    .prepare(
      `SELECT e.id AS employee_id,
              e.name,
              e.role,
              e.department,
              e.email,
              e.active,
              (SELECT count(*) FROM audit_log a WHERE a.actor_id = e.id) AS actions_count,
              (SELECT count(*) FROM tasks t WHERE t.assigned_to = e.id) AS tasks_assigned,
              (SELECT count(*) FROM tasks t WHERE t.assigned_to = e.id AND t.status IN ('Submitted', 'Reviewed', 'Closed')) AS tasks_completed,
              (SELECT max(created_at) FROM audit_log a WHERE a.actor_id = e.id) AS last_audit_at,
              (SELECT max(created_at) FROM lead_actions la WHERE la.from_employee = e.id) AS last_action_at
       FROM employees e
       ORDER BY actions_count DESC, e.name ASC`,
    )
    .all()
    .map((e) => {
      let lastActive = e.last_audit_at;
      if (e.last_action_at && (!lastActive || e.last_action_at > lastActive)) {
        lastActive = e.last_action_at;
      }
      return {
        employee_id: e.employee_id,
        name: e.name,
        role: e.role,
        department: e.department,
        email: e.email,
        active: e.active !== 0,
        actions_count: e.actions_count,
        tasks_assigned: e.tasks_assigned,
        tasks_completed: e.tasks_completed,
        last_active_at: lastActive || null,
      };
    });

  return {
    scope: 'super_admin',
    generated_at: new Date().toISOString(),
    employee_count: employees.length,
    active_employees: employees.filter((e) => e.active).length,
    employees,
  };
}

module.exports = function registerDashboardRoutes(app, db) {
  app.get('/api/dashboard', auth, (req, res) => {
    res.json(isCentral(req.user) ? centralDashboard(db) : spokeDashboard(db, req.user));
  });

  app.get('/api/dashboard/department', auth, (req, res) => {
    if (!isCentral(req.user) && req.user.role !== 'SALES_MANAGER') {
      return res.status(403).json({ error: 'Access denied. Only department heads and Admin Desk can access this dashboard.', requestId: req.id });
    }
    const dept = req.query.department || (req.user.role === 'SALES_MANAGER' ? 'Sales' : (req.user.department || 'Sales'));
    res.json(departmentDashboard(db, dept));
  });

  app.get('/api/dashboard/digital-marketing', auth, (req, res) => {
    if (!isCentral(req.user) && req.user.role !== 'DIGITAL_MARKETING') {
      return res.status(403).json({ error: 'Access denied. Only Digital Marketing and Central roles can access this dashboard.', requestId: req.id });
    }
    res.json(digitalMarketingDashboard(db, req.query));
  });

  app.get('/api/dashboard/super-admin', auth, (req, res) => {
    if (req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Access denied. Requires SUPER_ADMIN role.', requestId: req.id });
    }
    res.json(superAdminDashboard(db));
  });
};
