/**
 * SLA calculation.
 *
 * SQLite stores `datetime('now')` as a UTC string without a timezone suffix.
 * Parsing it as local time would shift every SLA by the server's offset, so all
 * timestamps are normalised to explicit UTC before comparison.
 */
'use strict';

function parseTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  if (!text) return null;
  // "YYYY-MM-DD HH:MM:SS" (SQLite) -> UTC ISO.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return new Date(`${text.replace(' ', 'T')}Z`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T00:00:00Z`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getSlaStatus(createdAt, slaHours = 48, referenceDate = new Date()) {
  const start = parseTimestamp(createdAt);
  const hours = Number(slaHours) > 0 ? Number(slaHours) : 48;
  const now = parseTimestamp(referenceDate) || new Date();

  if (!start) {
    return {
      status: 'unknown',
      label: 'No SLA',
      hoursElapsed: 0,
      hoursRemaining: hours,
      slaHours: hours,
      percentElapsed: 0,
      dueAt: null,
    };
  }

  const hoursElapsed = Math.max(0, (now.getTime() - start.getTime()) / 3_600_000);
  const hoursRemaining = hours - hoursElapsed;
  const percentElapsed = Math.min(100, Math.round((hoursElapsed / hours) * 1000) / 10);

  let status = 'on_track';
  if (hoursRemaining < 0) status = 'overdue';
  else if (hoursRemaining <= hours * 0.25) status = 'warning';

  return {
    status,
    label: formatTimeRemaining(hoursRemaining),
    hoursElapsed: Math.round(hoursElapsed * 10) / 10,
    hoursRemaining: Math.round(hoursRemaining * 10) / 10,
    slaHours: hours,
    percentElapsed,
    dueAt: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  };
}

function formatTimeRemaining(hoursRemaining) {
  if (hoursRemaining < 0) {
    const overdue = Math.abs(hoursRemaining);
    if (overdue < 1) return `Overdue by ${Math.max(1, Math.round(overdue * 60))}m`;
    if (overdue < 24) return `Overdue by ${Math.round(overdue)}h`;
    return `Overdue by ${Math.round(overdue / 24)}d`;
  }
  if (hoursRemaining < 1) return `${Math.max(1, Math.round(hoursRemaining * 60))}m left`;
  if (hoursRemaining < 24) return `${Math.round(hoursRemaining)}h left`;
  return `${Math.round(hoursRemaining / 24)}d left`;
}

function decorateTask(task) {
  if (!task) return task;
  return { ...task, sla: getSlaStatus(task.created_at, task.sla_hours) };
}

module.exports = {
  parseTimestamp,
  getSlaStatus,
  formatTimeRemaining,
  decorateTask,
};
