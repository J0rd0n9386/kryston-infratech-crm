/**
 * SLA Breach Detector Job.
 *
 * Scans active tasks for SLA due-date breaches.
 * Guarantees exactly-once notification per breach by recording notified task IDs
 * into the `sla_breach_notifications` ledger.
 */
'use strict';

const logger = require('../logger');
const { enqueueNotificationMany } = require('./dispatcher');
const { centralEmployeeIds } = require('../audit-notify');

/**
 * Check for SLA breaches and notify relevant personnel.
 *
 * @param {Object} db better-sqlite3 database handle
 * @returns {Array<{ taskId: string, department: string, assignedTo: string, slaDueAt: string }>}
 */
function checkSlaBreaches(db) {
  // Query tasks that are open, have an overdue SLA (created_at + sla_hours in past or due_date in past), and have not yet been notified
  const breachedTasks = db
    .prepare(
      `SELECT t.id, t.lead_id, t.department, t.assigned_to, t.task_type, t.created_at, t.sla_hours, t.due_date, l.customer_name
       FROM tasks t
       JOIN leads l ON l.id = t.lead_id
       WHERE t.status IN ('Assigned', 'In Progress')
         AND (
           t.created_at < datetime('now', '-' || t.sla_hours || ' hours')
           OR (t.due_date IS NOT NULL AND t.due_date < date('now'))
         )
         AND t.id NOT IN (SELECT task_id FROM sla_breach_notifications)
       ORDER BY t.created_at ASC`,
    )
    .all();

  if (!breachedTasks.length) {
    return [];
  }

  const notified = [];
  const adminIds = centralEmployeeIds(db);

  for (const task of breachedTasks) {
    // Record in ledger to guarantee exactly-once notification
    const insertResult = db
      .prepare(
        `INSERT OR IGNORE INTO sla_breach_notifications (task_id, breached_at, notified_at)
         VALUES (?, datetime('now'), datetime('now'))`,
      )
      .run(task.id);

    if (insertResult.changes === 0) {
      // Already recorded concurrently
      continue;
    }

    const recipients = [...new Set([...adminIds, task.assigned_to].filter(Boolean))];
    const message = `SLA Breach: Task ${task.id} (${task.task_type} - ${task.department}) for ${task.customer_name} is overdue.`;

    enqueueNotificationMany(db, {
      eventType: 'SLA_BREACH',
      recipientIds: recipients,
      dedupePrefix: `SLA_BREACH:${task.id}`,
      payload: {
        text: message,
        subject: `SLA Breach: Task ${task.id} is overdue`,
        link: '#tasks',
        entityType: 'task',
        entityId: task.id,
      },
    });

    notified.push({
      taskId: task.id,
      department: task.department,
      assignedTo: task.assigned_to,
      createdAt: task.created_at,
    });
  }

  return notified;
}

class SlaBreachDetectorJob {
  constructor(db, options = {}) {
    this.db = db;
    this.intervalMs = options.intervalMs || 60000;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      try {
        checkSlaBreaches(this.db);
      } catch (err) {
        logger.error({ err }, '[sla:breach:job] error checking breaches');
      }
    }, this.intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkNow() {
    return checkSlaBreaches(this.db);
  }
}

function createSlaBreachJob(db, options = {}) {
  return new SlaBreachDetectorJob(db, options);
}

module.exports = {
  checkSlaBreaches,
  SlaBreachDetectorJob,
  createSlaBreachJob,
};
