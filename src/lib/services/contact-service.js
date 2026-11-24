/**
 * Contact Service: Log call outcomes, handle contact attempts,
 * automated callback reminders, notifications, and view resolution.
 */
'use strict';

const { todayLocal, formatIST } = require('../clock');
const { audit, notifyCentral, logAction } = require('../audit-notify');
const { determineTaskView, decorateQueueTask } = require('./queue-service');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = require('../../middleware/errors');

const VALID_OUTCOMES = [
  'CONNECTED',
  'CALLBACK_REQUESTED',
  'NO_ANSWER',
  'BUSY',
  'SWITCHED_OFF',
  'WRONG_NUMBER',
  'INVALID_NUMBER',
];

const MAX_CONTACT_ATTEMPTS = 3;

function logOutcome(db, user, taskId, body, reqIp = null) {
  let task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task && taskId && String(taskId).startsWith('KRY-LEAD-')) {
    task = db.prepare(`
      SELECT * FROM tasks
      WHERE lead_id = ?
        AND (assigned_to = ? OR ? IN ('SUPER_ADMIN', 'ADMIN_DESK'))
      ORDER BY CASE WHEN status IN ('Assigned', 'In Progress') THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `).get(taskId, user.id, user.role);
  }
  if (!task || (task.assigned_to !== user.id && !['SUPER_ADMIN', 'ADMIN_DESK'].includes(user.role))) {
    throw new NotFoundError('Task not found.');
  }

  if (task.assigned_to === user.id && !require('../guardian').contactAllowed(task, user.id, 'Call')) {
    throw new ForbiddenError('Admin Desk has not authorised phone calls for this assignment.');
  }

  if (!['Assigned', 'In Progress'].includes(task.status)) {
    throw new ConflictError('This task is not in an active state to accept call outcomes.');
  }

  let rawOutcome = String(body.outcome || '').trim().toUpperCase();
  if (rawOutcome === 'INVALID_NUMBER') rawOutcome = 'WRONG_NUMBER';
  if (rawOutcome === 'NOT PICKED') rawOutcome = 'NO_ANSWER';
  if (rawOutcome === 'WRONG NUMBER') rawOutcome = 'WRONG_NUMBER';
  if (rawOutcome === 'CALLBACK REQUESTED') rawOutcome = 'CALLBACK_REQUESTED';
  if (!VALID_OUTCOMES.includes(rawOutcome) && rawOutcome !== 'WRONG_NUMBER') {
    throw new ValidationError(`Outcome must be one of: ${VALID_OUTCOMES.join(', ')}.`);
  }

  const notes = body.notes ? String(body.notes).trim() : '';
  if (rawOutcome === 'CONNECTED' && !notes) {
    throw new ValidationError('Notes are required when call is connected.');
  }

  const today = todayLocal();
  const nextActionDate = (body.next_action_date || body.callback_date) ? String(body.next_action_date || body.callback_date).trim() : null;

  if (rawOutcome === 'CALLBACK_REQUESTED') {
    if (!nextActionDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextActionDate)) {
      throw new ValidationError('A valid next_action_date (YYYY-MM-DD) is required for callback requests.');
    }
    if (nextActionDate < today) {
      throw new ValidationError('Callback date must be today or in the future.');
    }
  }

  const workSummary = (body.work_summary || notes || rawOutcome).slice(0, 4000);
  const nextAction = body.next_action ? String(body.next_action).trim().slice(0, 2000) : null;
  const interest = body.interest ? String(body.interest).trim().slice(0, 80) : null;
  const callPurpose = body.call_purpose ? String(body.call_purpose).trim().slice(0, 100) : null;
  const customerBudget = (body.customer_budget || body.budget_range) ? String(body.customer_budget || body.budget_range).trim().slice(0, 80) : null;
  const requirementType = body.requirement_type ? String(body.requirement_type).trim().slice(0, 100) : null;
  const locationArea = (body.location_area || body.area) ? String(body.location_area || body.area).trim().slice(0, 100) : null;

  return db.transaction(() => {
    const attempts = (task.contact_attempts || 0) + 1;
    const isSuccess = ['CONNECTED', 'CALLBACK_REQUESTED'].includes(rawOutcome);
    const newContactStatus = isSuccess ? 'CONTACTED' : task.contact_status;
    const firstContactedAt = (isSuccess && task.contact_status === 'NOT_CONTACTED')
      ? new Date().toISOString()
      : task.first_contacted_at;

    const newStatus = task.status === 'Assigned' ? 'In Progress' : task.status;

    // 1. Insert into append-only task_activity
    const act = db.prepare(`
      INSERT INTO task_activity
        (task_id, lead_id, employee_id, kind, outcome, interest, notes, work_done, next_action, next_action_date,
         call_purpose, customer_budget, requirement_type, location_area, created_at)
      VALUES (?, ?, ?, 'CALL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      task.id,
      task.lead_id,
      user.id,
      rawOutcome,
      interest,
      notes.slice(0, 4000),
      workSummary,
      nextAction,
      nextActionDate,
      callPurpose,
      customerBudget,
      requirementType,
      locationArea,
    );

    // 2. Update task
    db.prepare(`
      UPDATE tasks
      SET contact_attempts = ?,
          last_contact_at = datetime('now'),
          last_outcome = ?,
          contact_status = ?,
          first_contacted_at = ?,
          work_summary = ?,
          next_action = ?,
          next_action_date = ?,
          status = ?,
          started_at = COALESCE(started_at, datetime('now')),
          updated_at = datetime('now'),
          version = version + 1
      WHERE id = ?
    `).run(
      attempts,
      rawOutcome,
      newContactStatus,
      firstContactedAt,
      workSummary,
      nextAction,
      nextActionDate,
      newStatus,
      task.id,
    );

    let createdReminder = null;

    // 3. Reminder creation for CALLBACK_REQUESTED
    if (rawOutcome === 'CALLBACK_REQUESTED' && nextActionDate) {
      // Cancel previous pending reminders for this task
      db.prepare(`
        UPDATE reminders
        SET status = 'CANCELLED',
            resolved_at = datetime('now'),
            resolution = 'Superseded by newer callback request'
        WHERE task_id = ? AND status = 'PENDING'
      `).run(task.id);

      const reminderType = body.reminder_type || 'CALL_BACK';
      const remResult = db.prepare(`
        INSERT INTO reminders
          (lead_id, task_id, type, due_date, status, note, created_by, created_at)
        VALUES (?, ?, ?, ?, 'PENDING', ?, ?, datetime('now'))
      `).run(
        task.lead_id,
        task.id,
        reminderType,
        nextActionDate,
        notes || 'Customer requested call back',
        user.id,
      );

      createdReminder = {
        id: remResult.lastInsertRowid,
        type: reminderType,
        due_date: nextActionDate,
      };

      if (task.lead_id) {
        logAction(
          db,
          task.lead_id,
          'REMINDER_SET',
          user.id,
          null,
          task.department,
          `Call back on ${formatIST(nextActionDate)} (customer request)`,
          null,
          null,
        );
      }

      notifyCentral(
        db,
        'TASK_ASSIGNED',
        `Callback reminder set for ${task.lead_id || task.id} on ${nextActionDate} by ${user.name}.`,
        '#taskboard',
        'lead',
        task.lead_id || '',
      );
    }

    // 4. Telecaller responses sync if applicable
    if (task.task_type === 'TELECALLER_ENQUIRY' && task.lead_id) {
      db.prepare(`
        INSERT INTO telecaller_responses
          (lead_id, task_id, telecaller_id, customer_intent, budget_range, timeline,
           area, requirement_detail, objections, call_outcome, next_followup, notes,
           call_purpose, requirement_type, location_area, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        task.lead_id,
        task.id,
        user.id,
        interest || body.customer_intent || null,
        customerBudget || null,
        body.timeline || null,
        locationArea || null,
        body.requirement_detail || (requirementType ? `Requirement: ${requirementType}` : null),
        body.objections || null,
        rawOutcome,
        nextActionDate,
        notes || null,
        callPurpose,
        requirementType,
        locationArea,
      );

      // If customer was connected with intent, update lead's intent/budget/timeline if provided
      const leadUpdates = [];
      const leadParams = [];
      if (customerBudget) {
        leadUpdates.push('budget_range = ?');
        leadParams.push(customerBudget);
      }
      if (locationArea) {
        leadUpdates.push('location = COALESCE(location, ?)');
        leadParams.push(locationArea);
        leadUpdates.push('area = ?');
        leadParams.push(locationArea);
      }
      if (callPurpose) {
        leadUpdates.push('call_purpose = ?');
        leadParams.push(callPurpose);
      }
      if (requirementType) {
        leadUpdates.push('requirement_type = ?');
        leadParams.push(requirementType);
        leadUpdates.push('requirement = COALESCE(requirement, ?)');
        leadParams.push(requirementType);
      }
      if (body.timeline) {
        leadUpdates.push('timeline = ?');
        leadParams.push(body.timeline);
      }
      if (leadUpdates.length) {
        leadUpdates.push("updated_at = datetime('now')");
        leadParams.push(task.lead_id);
        db.prepare(`UPDATE leads SET ${leadUpdates.join(', ')} WHERE id = ?`).run(...leadParams);
      }
    }

    // 5. Build timeline remarks
    let remarks = '';
    const outcomeLabel = rawOutcome.replace(/_/g, ' ');
    const purposeTag = callPurpose ? ` [${callPurpose}]` : '';
    const reqInfo = requirementType ? ` | Requirement: ${requirementType}` : '';
    const budgetInfo = customerBudget ? ` (Budget: ${customerBudget})` : '';
    const locInfo = locationArea ? ` | Location: ${locationArea}` : '';

    if (rawOutcome === 'CONNECTED') {
      remarks = `Telecaller logged call. [Connected]${purposeTag}${reqInfo}${budgetInfo}${locInfo}. Notes: ${notes.slice(0, 300)}`;
    } else if (rawOutcome === 'CALLBACK_REQUESTED') {
      remarks = `Telecaller logged call. [Callback Requested]${purposeTag} Next follow-up on ${nextActionDate}${reqInfo}${budgetInfo}. Notes: ${notes.slice(0, 200)}`;
    } else if (rawOutcome === 'NO_ANSWER') {
      remarks = `[No Answer] (attempt ${attempts})${purposeTag}${reqInfo}`;
    } else if (rawOutcome === 'BUSY') {
      remarks = `[Busy] (attempt ${attempts})${purposeTag}${reqInfo}`;
    } else if (rawOutcome === 'SWITCHED_OFF') {
      remarks = `[Switched Off] (attempt ${attempts})${purposeTag}${reqInfo}`;
    } else if (rawOutcome === 'WRONG_NUMBER') {
      remarks = `[Wrong Number] Invalid phone number reported (attempt ${attempts})${purposeTag}`;
    } else {
      remarks = `[${outcomeLabel}]${purposeTag}${reqInfo}${budgetInfo}. Notes: ${notes.slice(0, 200)}`;
    }

    if (task.lead_id) {
      logAction(
        db,
        task.lead_id,
        'CALL_OUTCOME',
        user.id,
        null,
        task.department,
        remarks,
        task.contact_status,
        newContactStatus,
      );
    }

    // 6. Notifications for max attempts or invalid numbers
    if (rawOutcome === 'WRONG_NUMBER') {
      notifyCentral(
        db,
        'TASK_ASSIGNED',
        `Lead ${task.lead_id || task.id} reported as INVALID NUMBER by ${user.name}. Admin review required.`,
        '#taskboard',
        'lead',
        task.lead_id || '',
      );
    } else if (!isSuccess && attempts === MAX_CONTACT_ATTEMPTS) {
      notifyCentral(
        db,
        'TASK_ASSIGNED',
        `Lead ${task.lead_id || task.id} reached ${MAX_CONTACT_ATTEMPTS} failed contact attempts. Admin review required.`,
        '#taskboard',
        'lead',
        task.lead_id || '',
      );
    }

    // 7. Write audit log
    audit(
      db,
      user.id,
      'LOG_CALL_OUTCOME',
      'task',
      task.id,
      `Call outcome: ${rawOutcome} (attempt ${attempts})`,
      { contact_status: task.contact_status, attempts: task.contact_attempts },
      { contact_status: newContactStatus, attempts },
      reqIp,
    );

    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    const hasPendingReminder = Boolean(createdReminder);
    const targetView = determineTaskView(updatedTask, hasPendingReminder, today);

    return {
      ok: true,
      task: decorateQueueTask(updatedTask),
      view: targetView,
      reminder: createdReminder,
      activity_id: act.lastInsertRowid,
    };
  })();
}

module.exports = {
  VALID_OUTCOMES,
  MAX_CONTACT_ATTEMPTS,
  logOutcome,
};
