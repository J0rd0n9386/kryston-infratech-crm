/**
 * Activity Service: Append-only task work notes and activity ledger writes.
 */
'use strict';

const { ValidationError, NotFoundError, ConflictError } = require('../../middleware/errors');
const { audit, logAction } = require('../audit-notify');

function addWorkNote(db, user, taskId, body, reqIp = null) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.assigned_to !== user.id) {
    throw new NotFoundError('Task not found.');
  }

  if (!['Assigned', 'In Progress'].includes(task.status)) {
    throw new ConflictError('Cannot add a work note to a submitted or closed task.');
  }

  const notes = (body.notes || body.note) ? String(body.notes || body.note).trim() : '';
  const workDone = body.work_done ? String(body.work_done).trim() : notes;
  if (!notes && !workDone) {
    throw new ValidationError('Work note details are required.');
  }

  const nextAction = body.next_action ? String(body.next_action).trim().slice(0, 2000) : null;
  const nextActionDate = body.next_action_date ? String(body.next_action_date).trim() : null;

  return db.transaction(() => {
    // 1. Insert into append-only task_activity
    const act = db.prepare(`
      INSERT INTO task_activity
        (task_id, lead_id, employee_id, kind, notes, work_done, next_action, next_action_date, created_at)
      VALUES (?, ?, ?, 'WORK_NOTE', ?, ?, ?, ?, datetime('now'))
    `).run(
      task.id,
      task.lead_id,
      user.id,
      notes.slice(0, 4000),
      workDone.slice(0, 4000),
      nextAction,
      nextActionDate,
    );

    // 2. Update task fields (work_summary, next_action, next_action_date)
    const newStatus = task.status === 'Assigned' ? 'In Progress' : task.status;
    db.prepare(`
      UPDATE tasks
      SET work_summary = ?,
          next_action = ?,
          next_action_date = ?,
          status = ?,
          started_at = COALESCE(started_at, datetime('now')),
          updated_at = datetime('now'),
          version = version + 1
      WHERE id = ?
    `).run(
      workDone.slice(0, 4000),
      nextAction,
      nextActionDate,
      newStatus,
      task.id,
    );

    // 3. Log lead timeline action
    if (task.lead_id) {
      logAction(
        db,
        task.lead_id,
        'WORK_NOTE',
        user.id,
        null,
        task.department,
        `${user.name} added a work note: ${workDone.slice(0, 200)}`,
        null,
        null,
      );
    }

    // 4. Write audit log
    audit(
      db,
      user.id,
      'ADD_WORK_NOTE',
      'task',
      task.id,
      `Work note added by ${user.name}`,
      null,
      null,
      reqIp,
    );

    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    return { ok: true, task: updatedTask, activity_id: act.lastInsertRowid };
  })();
}

module.exports = {
  addWorkNote,
};
