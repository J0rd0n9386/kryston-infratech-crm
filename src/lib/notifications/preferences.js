/**
 * User Notification Preferences Management.
 * Controls which channels (in-app, email, whatsapp) are enabled per event type.
 */
'use strict';

const SUPPORTED_EVENTS = Object.freeze([
  'TASK_ASSIGNED',
  'UPDATE_SUBMITTED',
  'SLA_BREACH',
  'WO_APPROVED',
  'REWORK_REQUESTED',
  'DAILY_DIGEST',
]);

const DEFAULT_PREFERENCES = Object.freeze({
  channel_in_app: 1,
  channel_email: 1,
  channel_whatsapp: 0,
});

/**
 * Get notification preferences for a user across all event types.
 * Returns default values for any event types that haven't been customized.
 *
 * @param {Object} db
 * @param {string} employeeId
 * @returns {Record<string, { channel_in_app: boolean, channel_email: boolean, channel_whatsapp: boolean }>}
 */
function getEmployeePreferences(db, employeeId) {
  const rows = db
    .prepare('SELECT * FROM notification_preferences WHERE employee_id = ?')
    .all(employeeId);

  const lookup = new Map(rows.map((r) => [r.event_type, r]));
  const result = {};

  for (const event of SUPPORTED_EVENTS) {
    const existing = lookup.get(event);
    if (existing) {
      result[event] = {
        channel_in_app: Boolean(existing.channel_in_app),
        channel_email: Boolean(existing.channel_email),
        channel_whatsapp: Boolean(existing.channel_whatsapp),
      };
    } else {
      result[event] = {
        channel_in_app: Boolean(DEFAULT_PREFERENCES.channel_in_app),
        channel_email: Boolean(DEFAULT_PREFERENCES.channel_email),
        channel_whatsapp: Boolean(DEFAULT_PREFERENCES.channel_whatsapp),
      };
    }
  }

  return result;
}

/**
 * Update notification preferences for a user.
 *
 * @param {Object} db
 * @param {string} employeeId
 * @param {string} eventType
 * @param {Object} channels
 * @param {boolean} [channels.channel_in_app]
 * @param {boolean} [channels.channel_email]
 * @param {boolean} [channels.channel_whatsapp]
 */
function setEmployeePreference(db, employeeId, eventType, channels) {
  if (!SUPPORTED_EVENTS.includes(eventType)) {
    throw new Error(`Unsupported event type: ${eventType}`);
  }

  const inApp = channels.channel_in_app !== undefined ? (channels.channel_in_app ? 1 : 0) : 1;
  const email = channels.channel_email !== undefined ? (channels.channel_email ? 1 : 0) : 1;
  const whatsapp = channels.channel_whatsapp !== undefined ? (channels.channel_whatsapp ? 1 : 0) : 0;

  db.prepare(
    `INSERT INTO notification_preferences
      (employee_id, event_type, channel_in_app, channel_email, channel_whatsapp, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(employee_id, event_type) DO UPDATE SET
      channel_in_app = excluded.channel_in_app,
      channel_email = excluded.channel_email,
      channel_whatsapp = excluded.channel_whatsapp,
      updated_at = datetime('now')`,
  ).run(employeeId, eventType, inApp, email, whatsapp);

  return {
    employee_id: employeeId,
    event_type: eventType,
    channel_in_app: Boolean(inApp),
    channel_email: Boolean(email),
    channel_whatsapp: Boolean(whatsapp),
  };
}

/**
 * Check if a specific channel is enabled for a user and event.
 *
 * @param {Object} db
 * @param {string} employeeId
 * @param {string} eventType
 * @param {'in_app'|'email'|'whatsapp'} channel
 * @returns {boolean}
 */
function isChannelEnabled(db, employeeId, eventType, channel) {
  const col = `channel_${channel}`;
  const row = db
    .prepare(`SELECT ${col} AS enabled FROM notification_preferences WHERE employee_id = ? AND event_type = ?`)
    .get(employeeId, eventType);

  if (row) {
    return Boolean(row.enabled);
  }

  // Defaults: in_app and email are ON, whatsapp is OFF
  if (channel === 'in_app' || channel === 'email') return true;
  return false;
}

module.exports = {
  SUPPORTED_EVENTS,
  DEFAULT_PREFERENCES,
  getEmployeePreferences,
  setEmployeePreference,
  isChannelEnabled,
};
