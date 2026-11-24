/**
 * Reminder Service: Lifecycle management, idempotent trigger runner,
 * snooze, dismiss, and cancel routines.
 */
'use strict';

const { todayLocal, hourLocal, now: clockNow } = require('../clock');
const { audit, notify, notifyCentral, logAction, firstActiveAdminId } = require('../audit-notify');
const { generateId } = require('../id-generator');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../middleware/errors');

const SYSTEM_ACTOR_ID = 'KRY-SYS-001';

function addDaysToDateString(dateStr, days) {
  const parts = dateStr.split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setDate(date.getDate() + days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function createReminder(db, user, leadId, data) {
  const today = todayLocal();
  const type = data.type;
  if (!['CALL_BACK', 'CUSTOMER_WILL_CALL', 'FOLLOW_UP'].includes(type)) {
    throw new ValidationError('Invalid reminder type.');
  }
  const dueDate = data.due_date;
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new ValidationError('due_date must use YYYY-MM-DD format.');
  }
  if (dueDate < today) {
    throw new ValidationError('due_date must be today or in the future.');
  }

  const lead = db.prepare('SELECT id, customer_name, stage FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new NotFoundError('Lead not found.');

  const taskId = data.task_id || null;
  const note = data.note ? String(data.note).slice(0, 4000) : null;

  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO reminders
        (lead_id, task_id, type, due_date, status, note, created_by, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?, ?, datetime('now'))
    `).run(lead.id, taskId, type, dueDate, note, user.id);

    const reminderId = result.lastInsertRowid;

    logAction(
      db,
      lead.id,
      'REMINDER_SET',
      user.id,
      null,
      'Administration',
      `Reminder set: ${type} due on ${dueDate}${note ? ` (${note})` : ''}`,
      lead.stage,
      lead.stage,
    );

    audit(
      db,
      user.id,
      'CREATE_REMINDER',
      'reminder',
      String(reminderId),
      `Reminder ${type} set for ${lead.id} on ${dueDate}`,
    );

    return { id: reminderId, lead_id: lead.id, due_date: dueDate, type, status: 'PENDING' };
  })();
}

function snoozeReminder(db, user, reminderId, body) {
  const today = todayLocal();
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId);
  if (!reminder) throw new NotFoundError('Reminder not found.');
  if (!['PENDING', 'TRIGGERED'].includes(reminder.status)) {
    throw new ValidationError('Only pending or triggered reminders can be snoozed.');
  }

  let newDueDate;
  const targetDate = body.date || body.snooze_until;
  if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    newDueDate = targetDate;
  } else if (body.days) {
    const days = parseInt(body.days, 10);
    if (Number.isNaN(days) || days <= 0) throw new ValidationError('Days must be a positive integer.');
    newDueDate = addDaysToDateString(today, days);
  } else {
    throw new ValidationError('Provide either days or a valid date (YYYY-MM-DD).');
  }

  if (newDueDate <= today) {
    throw new ValidationError('Snooze date must be after today.');
  }

  const note = (body.note || body.reason) ? String(body.note || body.reason).slice(0, 4000) : (reminder.note || null);

  return db.transaction(() => {
    // Resolve current reminder as SNOOZED
    db.prepare(`
      UPDATE reminders
      SET status = 'SNOOZED',
          resolved_by = ?,
          resolved_at = datetime('now'),
          resolution = 'Snoozed'
      WHERE id = ?
    `).run(user.id, reminder.id);

    // If an Admin task was created for this reminder, close it
    if (reminder.admin_task_id) {
      db.prepare(`
        UPDATE tasks
        SET status = 'Closed',
            closed_at = datetime('now'),
            updated_at = datetime('now'),
            version = version + 1
        WHERE id = ?
      `).run(reminder.admin_task_id);
    }

    // Insert new pending reminder linked to previous
    const inserted = db.prepare(`
      INSERT INTO reminders
        (lead_id, task_id, type, due_date, status, note, created_by, created_at, previous_reminder_id)
      VALUES (?, ?, ?, ?, 'PENDING', ?, ?, datetime('now'), ?)
    `).run(reminder.lead_id, reminder.task_id, reminder.type, newDueDate, note, user.id, reminder.id);

    logAction(
      db,
      reminder.lead_id,
      'REMINDER_SNOOZED',
      user.id,
      null,
      'Administration',
      `Reminder snoozed until ${newDueDate}${note ? ` (${note})` : ''}`,
      null,
      null,
    );

    audit(
      db,
      user.id,
      'SNOOZE_REMINDER',
      'reminder',
      String(reminder.id),
      `Snoozed until ${newDueDate}; new reminder ${inserted.lastInsertRowid}`,
    );

    return {
      ok: true,
      old_reminder_id: reminder.id,
      new_reminder_id: inserted.lastInsertRowid,
      due_date: newDueDate,
    };
  })();
}

function dismissReminder(db, user, reminderId, body) {
  const reason = (body && body.reason) ? String(body.reason).trim() : '';
  if (!reason) {
    throw new ValidationError('A reason is required to dismiss a reminder.');
  }

  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId);
  if (!reminder) throw new NotFoundError('Reminder not found.');
  if (['DONE', 'DISMISSED', 'CANCELLED'].includes(reminder.status)) {
    throw new ValidationError('This reminder is already closed.');
  }

  return db.transaction(() => {
    db.prepare(`
      UPDATE reminders
      SET status = 'DISMISSED',
          resolved_by = ?,
          resolved_at = datetime('now'),
          resolution = ?
      WHERE id = ?
    `).run(user.id, reason, reminder.id);

    // Close admin task if associated
    if (reminder.admin_task_id) {
      db.prepare(`
        UPDATE tasks
        SET status = 'Closed',
            closed_at = datetime('now'),
            updated_at = datetime('now'),
            version = version + 1
        WHERE id = ?
      `).run(reminder.admin_task_id);
    }

    logAction(
      db,
      reminder.lead_id,
      'REMINDER_DISMISSED',
      user.id,
      null,
      'Administration',
      `Reminder dismissed: ${reason}`,
      null,
      null,
    );

    audit(
      db,
      user.id,
      'DISMISS_REMINDER',
      'reminder',
      String(reminder.id),
      `Dismissed: ${reason}`,
    );

    return { ok: true, reminder_id: reminder.id, status: 'DISMISSED' };
  })();
}

function cancelForLead(db, leadId, reason = 'Lead moved to Lost or Closed') {
  const pending = db.prepare(`
    SELECT * FROM reminders WHERE lead_id = ? AND status IN ('PENDING', 'TRIGGERED')
  `).all(leadId);

  if (!pending.length) return 0;

  return db.transaction(() => {
    let count = 0;
    for (const rem of pending) {
      db.prepare(`
        UPDATE reminders
        SET status = 'CANCELLED',
            resolved_at = datetime('now'),
            resolution = ?
        WHERE id = ?
      `).run(reason, rem.id);

      if (rem.admin_task_id) {
        db.prepare(`
          UPDATE tasks
          SET status = 'Closed',
              closed_at = datetime('now'),
              updated_at = datetime('now'),
              version = version + 1
          WHERE id = ?
        `).run(rem.admin_task_id);
      }
      count++;
    }

    logAction(
      db,
      leadId,
      'REMINDER_CANCELLED',
      SYSTEM_ACTOR_ID,
      null,
      'Administration',
      `Reminders cancelled: ${reason}`,
      null,
      null,
    );

    return count;
  })();
}

function runDueReminders(db, checkDate = clockNow()) {
  const today = todayLocal(checkDate);
  const currentHour = hourLocal(checkDate);

  // A reminder is due when status = 'PENDING' AND (due_date < today_local OR (due_date = today_local AND local time >= 09:00))
  // For hourly sweeps or after 9 AM
  const dueRows = db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'PENDING'
      AND (
        due_date < ?
        OR (due_date = ? AND ? >= 9)
      )
  `).all(today, today, currentHour);

  if (!dueRows.length) return [];

  const triggered = [];

  for (const reminder of dueRows) {
    const tx = db.transaction(() => {
      // Idempotent test: only proceed if status is still PENDING
      const updateResult = db.prepare(`
        UPDATE reminders
        SET status = 'TRIGGERED',
            triggered_at = datetime('now')
        WHERE id = ? AND status = 'PENDING'
      `).run(reminder.id);

      if (updateResult.changes === 0) return null;

      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(reminder.lead_id);
      if (!lead || lead.deleted_at) return null;

      // Determine Admin owner: current_owner if active Admin Desk/Super Admin, fallback first active admin
      let adminOwner = lead.current_owner;
      const ownerCheck = adminOwner ? db.prepare(`
        SELECT id FROM employees WHERE id = ? AND active = 1 AND role IN ('ADMIN_DESK', 'SUPER_ADMIN')
      `).get(adminOwner) : null;

      if (!ownerCheck) {
        adminOwner = firstActiveAdminId(db) || 'KRY-AD-001';
      }

      // Create Admin Task RE_ENGAGE
      const adminTaskId = generateId(db, 'KRY-TASK', 'tasks');
      const brief = `Re-engage ${lead.id}: customer asked for a call back on ${reminder.due_date}${reminder.note ? ` (${reminder.note})` : ''}`;

      db.prepare(`
        INSERT INTO tasks
          (id, lead_id, assigned_to, assigned_by, department, task_type, brief, due_date, sla_hours,
           status, contact_status, requires_contact, priority, created_at, updated_at, version)
        VALUES
          (?, ?, ?, ?, 'Administration', 'RE_ENGAGE', ?, ?, 24,
           'Assigned', 'CONTACTED', 0, 'High', datetime('now'), datetime('now'), 1)
      `).run(
        adminTaskId,
        lead.id,
        adminOwner,
        SYSTEM_ACTOR_ID,
        brief,
        today,
      );

      // Link Admin Task ID to reminder
      db.prepare('UPDATE reminders SET admin_task_id = ? WHERE id = ?').run(adminTaskId, reminder.id);

      // Notify original assignee for information
      if (reminder.created_by && reminder.created_by !== adminOwner) {
        notify(
          db,
          reminder.created_by,
          'TASK_ASSIGNED',
          `Reminder triggered for lead ${lead.id}: customer requested follow-up today (${reminder.due_date}).`,
          '#taskboard',
          'lead',
          lead.id,
        );
      }

      // Notify all active Admin Desk users
      notifyCentral(
        db,
        'TASK_ASSIGNED',
        `Auto-reminder due today: ${lead.id} (${lead.customer_name}) needs re-engagement.`,
        '#taskboard',
        'lead',
        lead.id,
      );

      // Log timeline entry
      logAction(
        db,
        lead.id,
        'AUTO_REMINDER_TRIGGERED',
        SYSTEM_ACTOR_ID,
        adminOwner,
        'Administration',
        `Reminder due today, Admin alerted: ${brief}`,
        lead.stage,
        lead.stage,
      );

      audit(
        db,
        SYSTEM_ACTOR_ID,
        'AUTO_REMINDER_TRIGGERED',
        'reminder',
        String(reminder.id),
        `Reminder triggered, Admin task ${adminTaskId} created`,
      );

      return {
        reminder_id: reminder.id,
        lead_id: lead.id,
        admin_task_id: adminTaskId,
      };
    });

    const res = tx();
    if (res) triggered.push(res);
  }

  return triggered;
}

module.exports = {
  SYSTEM_ACTOR_ID,
  createReminder,
  snoozeReminder,
  dismissReminder,
  cancelForLead,
  runDueReminders,
};
