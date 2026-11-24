/**
 * Queue Service: Calling Queue, My Work views and badge counters.
 *
 * Implements strict, non-overlapping view rules according to Section 4.2.
 */
'use strict';

const { todayLocal, formatIST } = require('../clock');
const { getSlaStatus } = require('../sla');
const { isCentral } = require('../../middleware/rbac');

function decorateQueueTask(task) {
  if (!task) return null;
  return {
    ...task,
    call_attempts: task.contact_attempts || 0,
    sla: getSlaStatus(task.created_at, task.sla_hours),
    created_at_ist: formatIST(task.created_at),
    last_contact_at_ist: formatIST(task.last_contact_at),
  };
}

function determineTaskView(task, hasPendingReminder, today = todayLocal()) {
  const status = task.status;
  const contact = task.contact_status || 'NOT_CONTACTED';
  const nextDate = task.next_action_date;

  if (status === 'Submitted') {
    return 'My Work > Sent for review';
  }
  if (['Reviewed', 'Closed'].includes(status)) {
    return 'My Work > Done';
  }
  if (['Assigned', 'In Progress'].includes(status)) {
    if (contact === 'NOT_CONTACTED') {
      if (nextDate && nextDate > today) {
        return 'Calling Queue > Scheduled';
      }
      return 'Calling Queue';
    }
    // contact is 'CONTACTED' or 'NOT_REQUIRED'
    if (hasPendingReminder || (contact === 'CONTACTED' && nextDate && nextDate > today)) {
      return 'My Work > Waiting';
    }
    return 'My Work > Active';
  }
  return 'None';
}

function getSummary(db, user) {
  const today = todayLocal();
  const userId = user.id;

  // Calling queue count: NOT_CONTACTED and not scheduled for future
  const callingRow = db.prepare(`
    SELECT count(*) AS count FROM tasks
    WHERE assigned_to = ?
      AND status IN ('Assigned', 'In Progress')
      AND contact_status = 'NOT_CONTACTED'
      AND (next_action_date IS NULL OR next_action_date <= ?)
  `).get(userId, today);

  // Calling queue scheduled count: NOT_CONTACTED with retry in future
  const scheduledRow = db.prepare(`
    SELECT count(*) AS count FROM tasks
    WHERE assigned_to = ?
      AND status IN ('Assigned', 'In Progress')
      AND contact_status = 'NOT_CONTACTED'
      AND next_action_date > ?
  `).get(userId, today);

  // My work tabs counts
  // Active: CONTACTED or NOT_REQUIRED with no pending reminder and not waiting for future date
  const myWorkActiveRow = db.prepare(`
    SELECT count(*) AS count FROM tasks t
    WHERE t.assigned_to = ?
      AND t.status IN ('Assigned', 'In Progress')
      AND t.contact_status IN ('CONTACTED', 'NOT_REQUIRED')
      AND (t.next_action_date IS NULL OR t.next_action_date <= ?)
      AND NOT EXISTS (
        SELECT 1 FROM reminders r
        WHERE r.task_id = t.id AND r.status = 'PENDING'
      )
  `).get(userId, today);

  // Waiting: CONTACTED with future next_action_date OR has a pending reminder
  const myWorkWaitingRow = db.prepare(`
    SELECT count(*) AS count FROM tasks t
    WHERE t.assigned_to = ?
      AND t.status IN ('Assigned', 'In Progress')
      AND (
        (t.contact_status = 'CONTACTED' AND t.next_action_date > ?)
        OR EXISTS (
          SELECT 1 FROM reminders r
          WHERE r.task_id = t.id AND r.status = 'PENDING'
        )
      )
  `).get(userId, today);

  // Sent for review: Submitted
  const myWorkSentRow = db.prepare(`
    SELECT count(*) AS count FROM tasks t
    WHERE t.assigned_to = ?
      AND t.status = 'Submitted'
  `).get(userId);

  // Done: Reviewed or Closed in last 30 days
  const myWorkDoneRow = db.prepare(`
    SELECT count(*) AS count FROM tasks t
    WHERE t.assigned_to = ?
      AND t.status IN ('Reviewed', 'Closed')
      AND (
        t.updated_at >= datetime('now', '-30 days')
        OR t.closed_at >= datetime('now', '-30 days')
      )
  `).get(userId);

  let dueReminders = 0;
  if (isCentral(user)) {
    const dueRemindersRow = db.prepare(`
      SELECT count(*) AS count FROM reminders
      WHERE status = 'TRIGGERED'
         OR (status = 'PENDING' AND due_date <= ?)
    `).get(today);
    dueReminders = dueRemindersRow ? dueRemindersRow.count : 0;
  }

  return {
    calling: callingRow ? callingRow.count : 0,
    scheduled: scheduledRow ? scheduledRow.count : 0,
    myWork: {
      active: myWorkActiveRow ? myWorkActiveRow.count : 0,
      waiting: myWorkWaitingRow ? myWorkWaitingRow.count : 0,
      sent: myWorkSentRow ? myWorkSentRow.count : 0,
      done: myWorkDoneRow ? myWorkDoneRow.count : 0,
      total: (myWorkActiveRow?.count || 0) + (myWorkWaitingRow?.count || 0) + (myWorkSentRow?.count || 0),
    },
    dueReminders,
  };
}

function getCallingQueue(db, user, options = {}) {
  const today = todayLocal();
  const targetUserId = (isCentral(user) && options.employee_id) ? options.employee_id : user.id;
  const isScheduled = Boolean(options.scheduled);

  let filterScheduled = `AND (t.next_action_date IS NULL OR t.next_action_date <= '${today}')`;
  if (isScheduled) {
    filterScheduled = `AND t.next_action_date > '${today}'`;
  }

  const sql = `
    SELECT t.*,
           l.customer_name, l.phone, l.phone_normalized, l.location, l.area,
           l.requirement, l.budget_range, l.timeline, l.priority AS lead_priority,
           l.stage AS lead_stage, l.source AS lead_source, l.channel AS lead_channel,
           tc.name AS telecaller_name,
           (SELECT tr.customer_intent FROM telecaller_responses tr
            WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS customer_intent
    FROM tasks t
    JOIN leads l ON l.id = t.lead_id
    LEFT JOIN employees tc ON tc.id = l.assigned_telecaller
    WHERE t.assigned_to = ?
      AND t.status IN ('Assigned', 'In Progress')
      AND t.contact_status = 'NOT_CONTACTED'
      ${filterScheduled}
    ORDER BY
      CASE WHEN t.due_date < ? THEN 0 ELSE 1 END,
      t.due_date ASC,
      CASE t.priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END,
      t.created_at ASC
  `;

  const rows = db.prepare(sql).all(targetUserId, today);
  return rows.map(decorateQueueTask);
}

function getMyWork(db, user, options = {}) {
  const today = todayLocal();
  const tab = options.tab || 'active';
  const showAll = Boolean(options.all) && isCentral(user);

  let whereAssignee = 't.assigned_to = ?';
  const params = [];
  if (showAll) {
    whereAssignee = '1=1';
  } else {
    params.push(user.id);
  }

  let tabPredicate = '';
  if (tab === 'active') {
    tabPredicate = `
      AND t.status IN ('Assigned', 'In Progress')
      AND t.contact_status IN ('CONTACTED', 'NOT_REQUIRED')
      AND (t.next_action_date IS NULL OR t.next_action_date <= '${today}')
      AND NOT EXISTS (
        SELECT 1 FROM reminders r
        WHERE r.task_id = t.id AND r.status = 'PENDING'
      )
    `;
  } else if (tab === 'waiting') {
    tabPredicate = `
      AND t.status IN ('Assigned', 'In Progress')
      AND (
        (t.contact_status = 'CONTACTED' AND t.next_action_date > '${today}')
        OR EXISTS (
          SELECT 1 FROM reminders r
          WHERE r.task_id = t.id AND r.status = 'PENDING'
        )
      )
    `;
  } else if (tab === 'sent' || tab === 'review') {
    tabPredicate = "AND t.status = 'Submitted'";
  } else if (tab === 'done') {
    const isAllTime = Boolean(options.all_time) || options.filter === 'all';
    tabPredicate = isAllTime
      ? "AND t.status IN ('Reviewed', 'Closed')"
      : `
        AND t.status IN ('Reviewed', 'Closed')
        AND (
          t.updated_at >= datetime('now', '-30 days')
          OR t.closed_at >= datetime('now', '-30 days')
        )
      `;
  } else {
    // Default to active
    tabPredicate = `
      AND t.status IN ('Assigned', 'In Progress')
      AND t.contact_status IN ('CONTACTED', 'NOT_REQUIRED')
      AND (t.next_action_date IS NULL OR t.next_action_date <= '${today}')
      AND NOT EXISTS (
        SELECT 1 FROM reminders r
        WHERE r.task_id = t.id AND r.status = 'PENDING'
      )
    `;
  }

  const sql = `
    SELECT t.*,
           l.customer_name, l.phone, l.phone_normalized, l.location, l.area,
           l.requirement, l.budget_range, l.timeline, l.priority AS lead_priority,
           l.stage AS lead_stage, l.source AS lead_source, l.channel AS lead_channel,
           assignee.name AS assignee_name, creator.name AS creator_name,
           (SELECT r.due_date FROM reminders r
            WHERE r.task_id = t.id AND r.status = 'PENDING'
            ORDER BY r.due_date ASC LIMIT 1) AS reminder_due_date,
           (SELECT r.type FROM reminders r
            WHERE r.task_id = t.id AND r.status = 'PENDING'
            ORDER BY r.due_date ASC LIMIT 1) AS reminder_type,
           (SELECT tr.call_outcome FROM telecaller_responses tr
            WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS latest_call_outcome,
           (SELECT tr.notes FROM telecaller_responses tr
            WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS latest_call_notes,
           (SELECT tr.call_purpose FROM telecaller_responses tr
            WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS latest_call_purpose
    FROM tasks t
    LEFT JOIN leads l ON l.id = t.lead_id
    LEFT JOIN employees assignee ON assignee.id = t.assigned_to
    LEFT JOIN employees creator ON creator.id = t.assigned_by
    WHERE ${whereAssignee}
      ${tabPredicate}
    ORDER BY
      CASE t.status WHEN 'Submitted' THEN 0 WHEN 'In Progress' THEN 1 ELSE 2 END,
      t.updated_at DESC, t.created_at DESC
  `;

  const rows = db.prepare(sql).all(...params);
  return rows.map(decorateQueueTask);
}

module.exports = {
  decorateQueueTask,
  determineTaskView,
  getSummary,
  getCallingQueue,
  getMyWork,
};
