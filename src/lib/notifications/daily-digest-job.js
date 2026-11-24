/**
 * Daily Digest Job for Admin Desk.
 *
 * Compiles and sends a daily morning digest containing:
 *  - Pending actions (tasks submitted awaiting review, response received)
 *  - Overdue tasks (tasks past SLA)
 *  - Leads stuck > 3 days without updates
 *  - Nurture follow-ups due today or overdue
 *
 * Guaranteed idempotent per day via `daily_digest_log`.
 */
'use strict';

const { enqueueNotificationMany } = require('./dispatcher');
const { centralEmployeeIds } = require('../audit-notify');
const { todayLocal } = require('../clock');

/**
 * Generate digest metrics and summaries from database state.
 *
 * @param {Object} db better-sqlite3 database handle
 * @returns {Object} Digest contents and formatted summary
 */
function compileDailyDigestData(db) {
  // 1. Pending actions
  const submittedTasksCount = db
    .prepare("SELECT count(*) as count FROM tasks WHERE status = 'Submitted'")
    .get().count;

  const responseReceivedLeadsCount = db
    .prepare("SELECT count(*) as count FROM leads WHERE stage = 'Response Received' AND deleted_at IS NULL")
    .get().count;

  const totalPendingActions = submittedTasksCount + responseReceivedLeadsCount;

  // 2. Overdue tasks
  const overdueTasks = db
    .prepare(
      `SELECT t.id, t.department, t.task_type, t.created_at, t.sla_hours, t.due_date, l.customer_name
       FROM tasks t
       JOIN leads l ON l.id = t.lead_id
       WHERE t.status IN ('Assigned', 'In Progress')
         AND (
           t.created_at < datetime('now', '-' || t.sla_hours || ' hours')
           OR (t.due_date IS NOT NULL AND t.due_date < date('now'))
         )
       ORDER BY t.created_at ASC
       LIMIT 10`,
    )
    .all();
  const overdueTasksCount = db
    .prepare(
      `SELECT count(*) as count FROM tasks
       WHERE status IN ('Assigned', 'In Progress')
         AND (
           created_at < datetime('now', '-' || sla_hours || ' hours')
           OR (due_date IS NOT NULL AND due_date < date('now'))
         )`,
    )
    .get().count;

  // 3. Leads stuck > 3 days
  const stuckLeads = db
    .prepare(
      `SELECT id, customer_name, stage, updated_at
       FROM leads
       WHERE deleted_at IS NULL
         AND stage NOT IN ('Completed', 'Closed', 'Lost')
         AND updated_at < datetime('now', '-3 days')
       ORDER BY updated_at ASC
       LIMIT 10`,
    )
    .all();
  const stuckLeadsCount = db
    .prepare(
      `SELECT count(*) as count FROM leads
       WHERE deleted_at IS NULL
         AND stage NOT IN ('Completed', 'Closed', 'Lost')
         AND updated_at < datetime('now', '-3 days')`,
    )
    .get().count;

  // 4. Nurture follow-ups due (checks latest telecaller response followup)
  const nurtureFollowups = db
    .prepare(
      `SELECT l.id, l.customer_name,
              (SELECT tr.next_followup FROM telecaller_responses tr
               WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) as next_followup
       FROM leads l
       WHERE l.deleted_at IS NULL
         AND l.stage = 'Nurture'
         AND (SELECT tr.next_followup FROM telecaller_responses tr
              WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) <= date('now')
       ORDER BY next_followup ASC
       LIMIT 10`,
    )
    .all();
  const nurtureFollowupsCount = db
    .prepare(
      `SELECT count(*) as count FROM leads l
       WHERE l.deleted_at IS NULL
         AND l.stage = 'Nurture'
         AND (SELECT tr.next_followup FROM telecaller_responses tr
              WHERE tr.lead_id = l.id ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) <= date('now')`,
    )
    .get().count;

  // 5. Reminders due today
  const today = todayLocal ? todayLocal() : new Date().toISOString().slice(0, 10);
  const dueReminders = db
    .prepare(
      `SELECT r.id, r.lead_id, r.type, r.due_date, r.note, l.customer_name
       FROM reminders r
       JOIN leads l ON l.id = r.lead_id
       WHERE r.status IN ('PENDING', 'TRIGGERED')
         AND r.due_date <= ?
       ORDER BY r.due_date ASC
       LIMIT 10`,
    )
    .all(today);
  const dueRemindersCount = db
    .prepare(
      `SELECT count(*) as count FROM reminders
       WHERE status IN ('PENDING', 'TRIGGERED')
         AND due_date <= ?`,
    )
    .get(today).count;

  // Construct structured digest message
  const lines = [
    '=== Kryston Daily Operations Digest ===',
    `Pending Actions: ${totalPendingActions} (${submittedTasksCount} tasks awaiting review, ${responseReceivedLeadsCount} responses received)`,
    `Overdue Tasks: ${overdueTasksCount}`,
    `Leads Stuck > 3 Days: ${stuckLeadsCount}`,
    `Nurture Follow-ups Due: ${nurtureFollowupsCount}`,
    `Reminders Due Today: ${dueRemindersCount}`,
  ];

  if (dueReminders.length) {
    lines.push('\n[Reminders Due Today]');
    for (const r of dueReminders) {
      lines.push(` - ${r.lead_id} (${r.customer_name}): ${r.type} due ${r.due_date}${r.note ? ` - ${r.note}` : ''}`);
    }
  }

  if (overdueTasks.length) {
    lines.push('\n[Overdue Tasks]');
    for (const task of overdueTasks) {
      lines.push(` - ${task.id} (${task.department} - ${task.task_type}) for ${task.customer_name} (Created: ${task.created_at})`);
    }
  }

  if (stuckLeads.length) {
    lines.push('\n[Stuck Leads (>3 days)]');
    for (const lead of stuckLeads) {
      lines.push(` - ${lead.id}: ${lead.customer_name} (${lead.stage}, last updated ${lead.updated_at})`);
    }
  }

  if (nurtureFollowups.length) {
    lines.push('\n[Nurture Follow-ups Due]');
    for (const nf of nurtureFollowups) {
      lines.push(` - ${nf.id}: ${nf.customer_name} (Due: ${nf.next_followup})`);
    }
  }

  const textSummary = lines.join('\n');

  return {
    metrics: {
      pendingActions: totalPendingActions,
      submittedTasksCount,
      responseReceivedLeadsCount,
      overdueTasksCount,
      stuckLeadsCount,
      nurtureFollowupsCount,
      dueRemindersCount,
    },
    overdueTasks,
    stuckLeads,
    nurtureFollowups,
    dueReminders,
    textSummary,
  };
}

/**
 * Execute daily digest delivery for a given date.
 * Idempotent: checks daily_digest_log before sending.
 *
 * @param {Object} db better-sqlite3 instance
 * @param {string} [targetDate] Date string 'YYYY-MM-DD', defaults to current local date
 * @returns {{ sent: boolean, date: string, recipientCount: number, data: Object }}
 */
function sendDailyDigest(db, targetDate = null) {
  const dateStr = targetDate || new Date().toISOString().slice(0, 10);

  // Check idempotency in database
  const existing = db.prepare('SELECT id FROM daily_digest_log WHERE digest_date = ?').get(dateStr);
  if (existing) {
    return {
      sent: false,
      reason: `Digest for ${dateStr} has already been sent`,
      date: dateStr,
      recipientCount: 0,
      data: null,
    };
  }

  const adminIds = centralEmployeeIds(db);
  if (!adminIds.length) {
    return {
      sent: false,
      reason: 'No active Admin Desk employees found to receive digest',
      date: dateStr,
      recipientCount: 0,
      data: null,
    };
  }

  const digestData = compileDailyDigestData(db);

  enqueueNotificationMany(db, {
    eventType: 'DAILY_DIGEST',
    recipientIds: adminIds,
    dedupePrefix: `DIGEST:${dateStr}`,
    payload: {
      text: digestData.textSummary,
      subject: `Kryston Daily Digest - ${dateStr}`,
      link: '#dashboard',
      entityType: 'digest',
      entityId: dateStr,
      metadata: digestData.metrics,
    },
  });

  db.prepare('INSERT INTO daily_digest_log (digest_date, sent_count, sent_at) VALUES (?, ?, datetime(\'now\'))').run(
    dateStr,
    adminIds.length,
  );

  return {
    sent: true,
    date: dateStr,
    recipientCount: adminIds.length,
    data: digestData,
  };
}

module.exports = {
  compileDailyDigestData,
  sendDailyDigest,
};
