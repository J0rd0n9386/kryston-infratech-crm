/**
 * Audit, notification and immutable-timeline helpers.
 *
 * All writes are best-effort in the sense that a logging failure must never
 * break a business transaction; however the errors are always surfaced on the
 * server console with enough context to investigate.
 */
'use strict';

const logger = require('./logger');

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function audit(
  db,
  actorId,
  action,
  entityType,
  entityId,
  details = '',
  beforeState = null,
  afterState = null,
  ipAddress = null,
) {
  try {
    db.prepare(
      `INSERT INTO audit_log
        (actor_id, action, entity_type, entity_id, details, before_state, after_state, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      actorId || null,
      action,
      entityType,
      entityId ? String(entityId) : null,
      details ? String(details).slice(0, 4000) : null,
      safeJson(beforeState),
      safeJson(afterState),
      ipAddress || null,
    );
  } catch (err) {
    logger.error({ err }, '[audit] failed');
  }
}

const EVENT_TYPE_MAP = Object.freeze({
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  UPDATE_SUBMITTED: 'UPDATE_SUBMITTED',
  SLA_BREACH: 'SLA_BREACH',
  WO_APPROVED: 'WO_APPROVED',
  WO_FINALIZED: 'WO_APPROVED',
  REWORK_REQUESTED: 'REWORK_REQUESTED',
  TASK_REWORK: 'REWORK_REQUESTED',
  DAILY_DIGEST: 'DAILY_DIGEST',
});

function notify(db, employeeId, type, message, link = '', entityType = '', entityId = '') {
  if (!employeeId) return;
  try {
    db.prepare(
      `INSERT INTO notifications (employee_id, type, message, link, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      employeeId,
      type,
      String(message).slice(0, 2000),
      link || null,
      entityType || null,
      entityId ? String(entityId) : null,
    );
  } catch (err) {
    logger.error({ err }, '[notify] failed');
  }

  // Also enqueue to notification outbox for multi-channel delivery (email, in-app, whatsapp)
  const normalizedEvent = EVENT_TYPE_MAP[type];
  if (normalizedEvent) {
    try {
      const { enqueueNotification } = require('./notifications/dispatcher');
      const dedupeKey = `${normalizedEvent}:${entityType || 'gen'}:${entityId || String(message).slice(0, 30)}:${employeeId}`;
      enqueueNotification(db, {
        eventType: normalizedEvent,
        recipientId: employeeId,
        dedupeKey,
        payload: {
          text: message,
          subject: `${normalizedEvent} - Kryston CRM`,
          link: link || '',
          entityType: entityType || '',
          entityId: entityId ? String(entityId) : '',
        },
      });
    } catch {
      // Best effort enqueue
    }
  }
}

function notifyMany(db, employeeIds, type, message, link = '', entityType = '', entityId = '') {
  const unique = [...new Set((employeeIds || []).filter(Boolean))];
  for (const id of unique) notify(db, id, type, message, link, entityType, entityId);
}

function centralEmployeeIds(db) {
  return db
    .prepare("SELECT id FROM employees WHERE active = 1 AND role IN ('ADMIN_DESK', 'SUPER_ADMIN')")
    .all()
    .map((row) => row.id);
}

function notifyCentral(db, type, message, link = '', entityType = '', entityId = '') {
  notifyMany(db, centralEmployeeIds(db), type, message, link, entityType, entityId);
}

function firstActiveAdminId(db) {
  const admin = db
    .prepare(
      `SELECT id FROM employees
       WHERE active = 1 AND role IN ('ADMIN_DESK', 'SUPER_ADMIN')
       ORDER BY CASE role WHEN 'ADMIN_DESK' THEN 0 ELSE 1 END, id
       LIMIT 1`,
    )
    .get();
  return admin ? admin.id : null;
}

function logAction(db, leadId, actionType, fromEmp, toEmp, toDept, remarks, oldStage, newStage) {
  try {
    db.prepare(
      `INSERT INTO lead_actions
        (lead_id, action_type, from_employee, to_employee, to_department, remarks, old_stage, new_stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      leadId,
      actionType,
      fromEmp || null,
      toEmp || null,
      toDept || null,
      remarks ? String(remarks).slice(0, 4000) : null,
      oldStage || null,
      newStage || null,
    );
  } catch (err) {
    logger.error({ err }, '[timeline] failed');
  }
}

module.exports = {
  audit,
  notify,
  notifyMany,
  notifyCentral,
  centralEmployeeIds,
  firstActiveAdminId,
  logAction,
};
