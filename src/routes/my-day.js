/**
 * "My Day" - a task-first home screen API.
 *
 * Instead of a dashboard of counts, every signed-in employee receives a short,
 * ordered plan of the work they can act on right now:
 *
 *   - their own open tasks (calls, site visits, submissions, drawings),
 *   - quotations and work orders that need their decision,
 *   - projects that need a progress update,
 *   - and, for Admin Desk only, a separate "Action Required" queue
 *     (leads to send, reports to review, work orders to approve).
 *
 * The payload is deliberately language-neutral: it returns semantic fields
 * (`kind`, `task_type`, `stage`, `status`, `bucket`, `action`) and the browser
 * translates them into English, Hindi or Hinglish. That keeps the server free
 * of presentation copy and lets the language switch work instantly.
 */
'use strict';

const { auth } = require('../middleware/auth');
const { isCentral, isSales, isSalesManager } = require('../middleware/rbac');
const { getSlaStatus } = require('../lib/sla');

const BUCKET_ORDER = Object.freeze({ late: 0, today: 1, urgent: 2, waiting: 3, upcoming: 4 });

/** Local calendar date (the server and the users are in the same time zone). */
function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDayIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

/**
 * The bucket decides where a card appears on My Day and how it is highlighted.
 * Late work always wins over "due today", which wins over a high priority.
 */
function taskBucket(task, today) {
  if (task.status === 'Submitted' || task.status === 'Reviewed') return 'waiting';
  const sla = getSlaStatus(task.created_at, task.sla_hours);
  if (sla.status === 'overdue') return 'late';
  if (task.due_date && String(task.due_date).slice(0, 10) < today) return 'late';
  if (task.due_date && String(task.due_date).slice(0, 10) === today) return 'today';
  if (sla.status === 'warning') return 'today';
  if (['Urgent', 'High'].includes(task.priority)) return 'urgent';
  return 'upcoming';
}

/** The single next step for a task, used to pick the primary button. */
function taskAction(task) {
  if (task.status === 'Submitted' || task.status === 'Reviewed') return 'open_task';
  if (task.task_type === 'TELECALLER_ENQUIRY') return 'log_call';
  if (task.department === 'Technical') return 'submit_site_report';
  if (task.department === 'Design') return 'submit_drawing';
  return 'submit_report';
}

function ageInDays(value) {
  if (!value) return 0;
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value))
    ? new Date(`${String(value).replace(' ', 'T')}Z`)
    : new Date(value);
  if (Number.isNaN(stamp.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - stamp.getTime()) / 86_400_000));
}

function decorateTask(task, today, { mine = true } = {}) {
  const sla = getSlaStatus(task.created_at, task.sla_hours);
  return {
    key: `task:${task.id}`,
    kind: 'task',
    group: 'my_work',
    id: task.id,
    lead_id: task.lead_id || null,
    customer_name: task.customer_name || null,
    phone: task.customer_phone || task.phone || null,
    location: task.customer_location || task.location || null,
    requirement: task.requirement || null,
    department: task.department,
    task_type: task.task_type,
    stage: task.lead_stage || task.stage || null,
    status: task.status,
    priority: task.priority || 'Medium',
    brief: task.brief || null,
    due_date: task.due_date || null,
    created_at: task.created_at,
    submitted_at: task.submitted_at || null,
    sla,
    bucket: taskBucket(task, today),
    action: taskAction(task),
    mine,
    assignee_name: task.assignee_name || null,
    assignee_phone: task.assignee_phone || null,
    creator_name: task.creator_name || null,
    waiting_days: task.status === 'Submitted' ? ageInDays(task.submitted_at) : 0,
  };
}

function sortItems(items) {
  return items.sort((a, b) => {
    const order = (BUCKET_ORDER[a.bucket] ?? 9) - (BUCKET_ORDER[b.bucket] ?? 9);
    if (order !== 0) return order;
    return String(a.due_date || a.sla?.dueAt || '9999').localeCompare(
      String(b.due_date || b.sla?.dueAt || '9999'),
    );
  });
}

/* ------------------------------------------------------------------ queries */

function loadMyTasks(db, user) {
  return db
    .prepare(
      `SELECT t.*, l.customer_name, l.phone AS customer_phone, l.location AS customer_location,
              l.requirement, l.stage AS lead_stage,
              creator.name AS creator_name
       FROM tasks t
       LEFT JOIN leads l ON l.id = t.lead_id
       LEFT JOIN employees creator ON creator.id = t.assigned_by
       WHERE t.assigned_to = ? AND t.status IN ('Assigned', 'In Progress', 'Submitted')
       ORDER BY t.created_at DESC`,
    )
    .all(user.id);
}

function loadOrgAttentionTasks(db) {
  return db
    .prepare(
      `SELECT t.*, l.customer_name, l.phone AS customer_phone, l.location AS customer_location,
              l.stage AS lead_stage, assignee.name AS assignee_name, assignee.phone AS assignee_phone
       FROM tasks t
       LEFT JOIN leads l ON l.id = t.lead_id
       LEFT JOIN employees assignee ON assignee.id = t.assigned_to
       WHERE t.status IN ('Assigned', 'In Progress')
       ORDER BY t.created_at ASC
       LIMIT 300`,
    )
    .all();
}

function loadSalesQuotes(db, user) {
  if (isSalesManager(user)) {
    return db
      .prepare(
        `SELECT q.*, l.customer_name, l.phone, l.location, l.stage AS lead_stage,
                (q.amount + coalesce(q.tax_amount, 0)) AS total_amount
         FROM quotations q
         JOIN leads l ON l.id = q.lead_id
         WHERE l.deleted_at IS NULL AND q.status IN ('Draft', 'Sent', 'Negotiation')
         ORDER BY q.updated_at DESC
         LIMIT 100`,
      )
      .all();
  }
  return db
    .prepare(
      `SELECT q.*, l.customer_name, l.phone, l.location, l.stage AS lead_stage,
              (q.amount + coalesce(q.tax_amount, 0)) AS total_amount
       FROM quotations q
       JOIN leads l ON l.id = q.lead_id
       WHERE l.deleted_at IS NULL
         AND (q.created_by = ? OR l.assigned_bdm = ?)
         AND q.status IN ('Draft', 'Sent', 'Negotiation')
       ORDER BY q.updated_at DESC
       LIMIT 100`,
    )
    .all(user.id, user.id);
}

function quoteItem(quote, user) {
  const age = ageInDays(quote.sent_at || quote.updated_at || quote.created_at);
  const managerDecision = isSalesManager(user) && ['Sent', 'Negotiation'].includes(quote.status);
  let action = 'send_quotation';
  let bucket = 'today';
  if (quote.status === 'Draft') {
    action = 'send_quotation';
    bucket = age >= 2 ? 'late' : 'today';
  } else if (managerDecision) {
    action = 'approve_quotation';
    bucket = age >= 2 ? 'today' : 'today';
  } else {
    action = 'follow_up_quote';
    bucket = age >= 2 ? 'today' : 'waiting';
  }
  return {
    key: `quotation:${quote.id}`,
    kind: 'quotation',
    group: 'my_work',
    id: quote.id,
    lead_id: quote.lead_id,
    customer_name: quote.customer_name || null,
    phone: quote.phone || null,
    location: quote.location || null,
    stage: quote.lead_stage || null,
    status: quote.status,
    version: quote.version,
    amount: Number(quote.amount) || 0,
    tax_amount: Number(quote.tax_amount) || 0,
    total_amount: Number(quote.total_amount) || 0,
    created_at: quote.created_at,
    sent_at: quote.sent_at || null,
    due_date: null,
    sla: null,
    bucket,
    action,
    mine: true,
    waiting_days: age,
  };
}

function loadQuotationWorkLeads(db, user) {
  return db
    .prepare(
      `SELECT l.*
       FROM leads l
       WHERE l.deleted_at IS NULL
         AND l.assigned_bdm = ?
         AND l.stage IN ('Quotation Stage', 'Quotation Sent', 'Negotiation')
         AND NOT EXISTS (
           SELECT 1 FROM quotations q
           WHERE q.lead_id = l.id AND q.status IN ('Draft', 'Sent', 'Negotiation')
         )
       ORDER BY l.updated_at ASC
       LIMIT 100`,
    )
    .all(user.id);
}

function loadApprovedLeadsWithoutWorkOrder(db, assignedTo) {
  const params = [];
  let ownerClause = '';
  if (assignedTo) {
    ownerClause = 'AND l.assigned_bdm = ?';
    params.push(assignedTo);
  }
  return db
    .prepare(
      `SELECT l.*
       FROM leads l
       WHERE l.deleted_at IS NULL AND l.stage = 'Approved' ${ownerClause}
         AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.lead_id = l.id)
       ORDER BY l.updated_at ASC
       LIMIT 100`,
    )
    .all(...params);
}

function loadMyProjects(db, user) {
  return db
    .prepare(
      `SELECT p.*, l.customer_name, l.phone, l.location, w.amount AS contract_amount,
              (SELECT count(*) FROM project_milestones m
                WHERE m.project_id = p.id AND m.status != 'Completed'
                  AND m.target_date IS NOT NULL AND m.target_date < date('now')) AS late_milestones
       FROM projects p
       JOIN leads l ON l.id = p.lead_id
       JOIN work_orders w ON w.id = p.work_order_id
       WHERE p.status IN ('Planning', 'In Progress', 'On Hold')
         AND (p.project_manager = ? OR p.site_engineer = ?)
       ORDER BY p.updated_at DESC
       LIMIT 100`,
    )
    .all(user.id, user.id);
}

function projectItem(project) {
  const late = Number(project.late_milestones) || 0;
  return {
    key: `project:${project.id}`,
    kind: 'project',
    group: 'my_work',
    id: project.id,
    lead_id: project.lead_id,
    customer_name: project.customer_name || null,
    phone: project.phone || null,
    location: project.location || null,
    stage: project.status,
    status: project.status,
    amount: Number(project.contract_amount) || 0,
    progress: Number(project.progress) || 0,
    late_milestones: late,
    due_date: project.target_completion || null,
    created_at: project.created_at,
    sla: null,
    bucket: late > 0 ? 'late' : 'today',
    action: 'report_progress',
    mine: true,
  };
}

/* -------------------------------------------------------- central action queue */

function leadQueueItem(lead, action, group) {
  return {
    key: `lead:${lead.id}`,
    kind: 'lead',
    group,
    id: lead.id,
    lead_id: lead.id,
    customer_name: lead.customer_name || null,
    phone: lead.phone || null,
    location: lead.location || null,
    stage: lead.stage,
    status: lead.stage,
    priority: lead.priority || 'Medium',
    budget_range: lead.budget_range || null,
    requirement: lead.requirement || null,
    source: lead.source || null,
    telecaller_name: lead.telecaller_name || null,
    waiting_days: ageInDays(lead.updated_at),
    created_at: lead.created_at,
    due_date: null,
    sla: null,
    bucket: ['Urgent', 'High'].includes(lead.priority) ? 'urgent' : 'today',
    action,
    mine: false,
  };
}

function centralActionQueue(db) {
  const leadRows = db
    .prepare(
      `SELECT l.*, tc.name AS telecaller_name,
              (SELECT tr.next_followup FROM telecaller_responses tr
                WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS next_followup,
              (SELECT count(*) FROM tasks t
                WHERE t.lead_id = l.id AND t.status IN ('Assigned', 'In Progress')) AS open_tasks,
              (SELECT count(*) FROM tasks t
                WHERE t.lead_id = l.id AND t.status = 'Submitted') AS submitted_tasks,
              (SELECT count(*) FROM tasks t
                WHERE t.lead_id = l.id AND t.department = 'Sales' AND t.status = 'Reviewed') AS reviewed_sales,
              (SELECT count(*) FROM tasks t
                WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
                  AND t.status IN ('Assigned', 'In Progress')) AS open_calls
       FROM leads l
       LEFT JOIN employees tc ON tc.id = l.assigned_telecaller
       WHERE l.deleted_at IS NULL
         AND l.stage IN ('New', 'Nurture', 'Follow-up Required', 'Response Received', 'Update Received')
       ORDER BY
         CASE l.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
         l.updated_at ASC
       LIMIT 200`,
    )
    .all();

  const today = localDate();
  const send = [];
  for (const lead of leadRows) {
    if (lead.stage === 'Nurture') {
      if (Number(lead.open_calls) > 0) continue;
      // Filter stage = 'Nurture' where next_followup <= date('now') (or null)
      if (lead.next_followup && lead.next_followup > today) {
        continue;
      }
      const item = leadQueueItem(lead, 'assign_telecaller', 'send');
      item.next_followup = lead.next_followup || null;
      if (lead.next_followup && lead.next_followup < today) {
        item.bucket = 'late';
      }
      send.push(item);
      continue;
    }
    if (['New', 'Follow-up Required'].includes(lead.stage)) {
      if (Number(lead.open_calls) > 0) continue;
      send.push(leadQueueItem(lead, 'assign_telecaller', 'send'));
      continue;
    }
    if (lead.stage === 'Response Received') {
      send.push(leadQueueItem(lead, 'route_lead', 'send'));
      continue;
    }
    if (lead.stage === 'Update Received' && Number(lead.open_tasks) === 0 && Number(lead.submitted_tasks) === 0) {
      send.push(
        leadQueueItem(
          lead,
          Number(lead.reviewed_sales) > 0 ? 'prepare_quotation' : 'route_lead',
          'send',
        ),
      );
    }
  }

  const review = db
    .prepare(
      `SELECT t.id, t.lead_id, t.department, t.task_type, t.status, t.priority,
              t.created_at, t.submitted_at, t.sla_hours, t.due_date,
              l.customer_name, l.phone, l.location, l.stage AS lead_stage,
              assignee.name AS assignee_name
       FROM tasks t
       JOIN leads l ON l.id = t.lead_id
       LEFT JOIN employees assignee ON assignee.id = t.assigned_to
       WHERE t.status = 'Submitted'
       ORDER BY t.submitted_at ASC
       LIMIT 200`,
    )
    .all()
    .map((task) => {
      const item = decorateTask(
        { ...task, customer_phone: task.phone, customer_location: task.location },
        localDate(),
        { mine: false },
      );
      return {
        ...item,
        group: 'review',
        action: 'review_submission',
        status: 'Submitted',
        assignee_name: task.assignee_name || null,
      };
    });

  const workOrders = db
    .prepare(
      `SELECT w.id, w.lead_id, w.amount, w.customer_approval_date, w.created_at,
              l.customer_name, l.phone, l.location, creator.name AS creator_name
       FROM work_orders w
       JOIN leads l ON l.id = w.lead_id
       LEFT JOIN employees creator ON creator.id = w.created_by
       WHERE w.status = 'Pending Admin Approval'
       ORDER BY w.created_at ASC
       LIMIT 200`,
    )
    .all()
    .map((order) => ({
      key: `work_order:${order.id}`,
      kind: 'work_order',
      group: 'approve_work',
      id: order.id,
      lead_id: order.lead_id,
      customer_name: order.customer_name || null,
      phone: order.phone || null,
      location: order.location || null,
      stage: 'Waiting for Admin approval',
      status: 'Pending Admin Approval',
      amount: Number(order.amount) || 0,
      creator_name: order.creator_name || null,
      waiting_days: ageInDays(order.created_at),
      created_at: order.created_at,
      due_date: null,
      sla: null,
      bucket: 'today',
      action: 'approve_work_order',
      mine: false,
    }));

  const quotes = db
    .prepare(
      `SELECT q.id, q.lead_id, q.version, q.amount, q.tax_amount, q.status, q.sent_at,
              q.created_at, q.updated_at,
              l.customer_name, l.phone, l.location,
              (q.amount + coalesce(q.tax_amount, 0)) AS total_amount
       FROM quotations q
       JOIN leads l ON l.id = q.lead_id
       WHERE l.deleted_at IS NULL AND q.status IN ('Sent', 'Negotiation')
       ORDER BY coalesce(q.sent_at, q.created_at) ASC
       LIMIT 200`,
    )
    .all()
    .map((quote) => ({
      key: `quotation:${quote.id}`,
      kind: 'quotation',
      group: 'quotes',
      id: quote.id,
      lead_id: quote.lead_id,
      customer_name: quote.customer_name || null,
      phone: quote.phone || null,
      location: quote.location || null,
      stage: 'Quotation sent',
      status: quote.status,
      version: quote.version,
      amount: Number(quote.amount) || 0,
      tax_amount: Number(quote.tax_amount) || 0,
      total_amount: Number(quote.total_amount) || 0,
      created_at: quote.created_at,
      sent_at: quote.sent_at || null,
      waiting_days: ageInDays(quote.sent_at || quote.created_at),
      due_date: null,
      sla: null,
      bucket: 'today',
      action: 'approve_quotation',
      mine: false,
    }));

  const groups = [
    { key: 'send', items: send },
    { key: 'review', items: review },
    { key: 'approve_work', items: workOrders },
    { key: 'quotes', items: quotes },
  ].map((group) => ({ ...group, count: group.items.length }));

  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.count, 0),
  };
}

/* -------------------------------------------------------------- recent activity */

function recentActivity(db, user, scoped) {
  const scopeClause = scoped
    ? `AND a.lead_id IN (
         SELECT l2.id FROM leads l2
         WHERE l2.deleted_at IS NULL AND (
           l2.assigned_telecaller = ? OR l2.assigned_bdm = ? OR l2.assigned_engineer = ?
           OR l2.assigned_architect = ? OR l2.assigned_pm = ?
           OR EXISTS (SELECT 1 FROM tasks t2 WHERE t2.lead_id = l2.id AND t2.assigned_to = ?)
         )
       )`
    : '';
  const params = scoped ? [user.id, user.id, user.id, user.id, user.id, user.id] : [];

  const rows = db
    .prepare(
      `SELECT a.id, a.lead_id, a.action_type, a.remarks, a.old_stage, a.new_stage,
              a.to_department, a.created_at,
              l.customer_name, f.name AS from_name, t.name AS to_name
       FROM lead_actions a
       JOIN leads l ON l.id = a.lead_id
       LEFT JOIN employees f ON f.id = a.from_employee
       LEFT JOIN employees t ON t.id = a.to_employee
       WHERE a.created_at >= datetime('now', '-1 day') ${scopeClause}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 12`,
    )
    .all(...params);

  const summary = db
    .prepare(
      `SELECT
         sum(CASE WHEN a.action_type = 'CREATED' THEN 1 ELSE 0 END) AS new_enquiries,
         sum(CASE WHEN a.action_type IN ('TELECALLER_RESPONSE', 'DEPT_UPDATE') THEN 1 ELSE 0 END) AS reports_received,
         sum(CASE WHEN a.action_type = 'QUOTATION' THEN 1 ELSE 0 END) AS quotations,
         sum(CASE WHEN a.action_type IN ('ADMIN_REVIEW', 'WORK_ORDER_SUBMITTED', 'WORK_ORDER_FINALIZED', 'PROJECT_HANDOFF') THEN 1 ELSE 0 END) AS approvals
       FROM lead_actions a
       JOIN leads l ON l.id = a.lead_id
       WHERE a.created_at >= datetime('now', '-1 day') ${scopeClause}`,
    )
    .get(...params);

  return {
    rows,
    summary: {
      newEnquiries: Number(summary.new_enquiries) || 0,
      reportsReceived: Number(summary.reports_received) || 0,
      quotations: Number(summary.quotations) || 0,
      approvals: Number(summary.approvals) || 0,
    },
  };
}

function ownActionsSinceYesterday(db, userId) {
  return db
    .prepare(
      `SELECT count(*) AS c FROM lead_actions
       WHERE from_employee = ? AND created_at >= datetime('now', '-1 day')`,
    )
    .get(userId).c;
}

/* ------------------------------------------------------------------ assembly */

function buildMyDay(db, user) {
  const central = isCentral(user);
  const today = localDate();
  const items = [];

  for (const task of loadMyTasks(db, user)) {
    items.push(decorateTask(task, today));
  }

  if (central) {
    const seen = new Set(items.map((item) => item.id));
    const attention = loadOrgAttentionTasks(db)
      .filter((task) => !seen.has(task.id))
      .map((task) => decorateTask(task, today, { mine: false }))
      .filter((item) => ['late', 'today', 'urgent'].includes(item.bucket))
      .slice(0, 12);
    items.push(...attention);
  }

  if (isSales(user)) {
    for (const quote of loadSalesQuotes(db, user)) items.push(quoteItem(quote, user));

    if (!isSalesManager(user)) {
      for (const lead of loadQuotationWorkLeads(db, user)) {
        items.push({
          key: `lead:${lead.id}`,
          kind: 'lead',
          group: 'my_work',
          id: lead.id,
          lead_id: lead.id,
          customer_name: lead.customer_name,
          phone: lead.phone,
          location: lead.location,
          stage: lead.stage,
          status: lead.stage,
          requirement: lead.requirement,
          budget_range: lead.budget_range,
          waiting_days: ageInDays(lead.updated_at),
          created_at: lead.created_at,
          due_date: null,
          sla: null,
          bucket: 'today',
          action: 'prepare_quotation',
          mine: true,
        });
      }
    }

    if (isSalesManager(user)) {
      for (const lead of loadApprovedLeadsWithoutWorkOrder(db)) {
        items.push({
          key: `lead:${lead.id}`,
          kind: 'lead',
          group: 'my_work',
          id: lead.id,
          lead_id: lead.id,
          customer_name: lead.customer_name,
          phone: lead.phone,
          location: lead.location,
          stage: lead.stage,
          status: lead.stage,
          requirement: lead.requirement,
          budget_range: lead.budget_range,
          waiting_days: ageInDays(lead.updated_at),
          created_at: lead.created_at,
          due_date: null,
          sla: null,
          bucket: 'today',
          action: 'create_work_order',
          mine: true,
        });
      }
    }
  }

  if (user.role === 'PROJECT_MANAGER' || user.role === 'SITE_ENGINEER') {
    for (const project of loadMyProjects(db, user)) items.push(projectItem(project));
  }

  sortItems(items);

  const summary = {
    late: items.filter((item) => item.bucket === 'late').length,
    today: items.filter((item) => item.bucket === 'today').length,
    urgent: items.filter((item) => item.bucket === 'urgent').length,
    waiting: items.filter((item) => item.bucket === 'waiting').length,
    upcoming: items.filter((item) => item.bucket === 'upcoming').length,
    totalToday: 0,
    doneSinceYesterday: ownActionsSinceYesterday(db, user.id),
  };
  summary.totalToday = summary.late + summary.today + summary.urgent;

  const actionQueue = central ? centralActionQueue(db) : { groups: [], total: 0 };
  summary.actionRequired = actionQueue.total;

  const activity = recentActivity(db, user, !central);

  return {
    scope: central ? 'central' : 'spoke',
    generatedAt: new Date().toISOString(),
    today,
    dayStart: startOfLocalDayIso(0),
    summary,
    items,
    actionQueue,
    recentActivity: activity.rows,
    activitySummary: activity.summary,
  };
}

module.exports = function registerMyDayRoutes(app, db) {
  app.get('/api/my-day', auth, (req, res) => {
    res.json(buildMyDay(db, req.user));
  });

  // Small, cheap counts for the sidebar badges. Kept separate from /api/my-day
  // so the notification poll never rebuilds the whole day plan.
  app.get('/api/badges', auth, (req, res) => {
    const central = isCentral(req.user);
    const count = (sql, ...params) => db.prepare(sql).get(...params).c;

    const myWork = count(
      "SELECT count(*) AS c FROM tasks WHERE assigned_to = ? AND status IN ('Assigned','In Progress')",
      req.user.id,
    );
    const calls = count(
      `SELECT count(*) AS c FROM tasks
       WHERE assigned_to = ? AND task_type = 'TELECALLER_ENQUIRY'
         AND status IN ('Assigned','In Progress')`,
      req.user.id,
    );
    const today = localDate();
    const myDay = count(
      `SELECT count(*) AS c FROM tasks
       WHERE assigned_to = ? AND status IN ('Assigned','In Progress')
         AND (due_date IS NOT NULL AND due_date <= ?
              OR priority IN ('Urgent','High')
              OR created_at < datetime('now', '-' || sla_hours || ' hours'))`,
      req.user.id,
      today,
    );

    let actionRequired = 0;
    if (central) {
      actionRequired =
        count("SELECT count(*) AS c FROM leads WHERE deleted_at IS NULL AND stage = 'Response Received'") +
        count("SELECT count(*) AS c FROM leads WHERE deleted_at IS NULL AND stage IN ('New','Nurture','Follow-up Required')") +
        count("SELECT count(*) AS c FROM tasks WHERE status = 'Submitted'") +
        count("SELECT count(*) AS c FROM work_orders WHERE status = 'Pending Admin Approval'") +
        count("SELECT count(*) AS c FROM quotations WHERE status IN ('Sent','Negotiation')");
    } else if (isSalesManager(req.user)) {
      actionRequired =
        count("SELECT count(*) AS c FROM quotations WHERE status IN ('Sent','Negotiation')") +
        count(
          `SELECT count(*) AS c FROM leads l
           WHERE l.deleted_at IS NULL AND l.stage = 'Approved'
             AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.lead_id = l.id)`,
        );
    }

    res.json({ myDay, myWork, calls, actionRequired });
  });
};

module.exports.buildMyDay = buildMyDay;
