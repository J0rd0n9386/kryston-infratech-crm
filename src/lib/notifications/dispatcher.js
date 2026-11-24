/**
 * Notification Event Dispatcher.
 *
 * Enqueues event notifications into `notification_outbox` for each channel
 * enabled in the recipient's preferences. Enforces deduplication via unique dedupe_key.
 */
'use strict';

const logger = require('../logger');
const { isChannelEnabled } = require('./preferences');

const CHANNELS = ['in_app', 'email', 'whatsapp'];

/**
 * Enqueue a notification to the outbox for an employee.
 *
 * @param {Object} db better-sqlite3 instance
 * @param {Object} params
 * @param {string} params.eventType 'TASK_ASSIGNED' | 'UPDATE_SUBMITTED' | 'SLA_BREACH' | 'WO_APPROVED' | 'REWORK_REQUESTED' | 'DAILY_DIGEST'
 * @param {string} params.recipientId Employee ID receiving the notification
 * @param {string} params.dedupeKey Unique key to ensure idempotency / avoid duplicate notifications
 * @param {Object} params.payload Notification contents { text, subject, link, entityType, entityId, metadata }
 * @returns {Array<{ channel: string, dedupeKey: string, enqueued: boolean }>}
 */
function enqueueNotification(db, { eventType, recipientId, dedupeKey, payload }) {
  if (!recipientId || !eventType || !dedupeKey || !payload) {
    throw new Error('recipientId, eventType, dedupeKey and payload are required to enqueue notification');
  }

  const results = [];
  const payloadJson = JSON.stringify(payload);

  for (const channel of CHANNELS) {
    if (!isChannelEnabled(db, recipientId, eventType, channel)) {
      continue;
    }

    const channelDedupeKey = `${channel}:${dedupeKey}`;

    try {
      // Use INSERT OR IGNORE to guarantee deduplication at database level
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO notification_outbox
          (dedupe_key, event_type, channel, recipient_id, payload, status, attempts, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, datetime('now'))
      `);
      const result = stmt.run(channelDedupeKey, eventType, channel, recipientId, payloadJson);

      results.push({
        channel,
        dedupeKey: channelDedupeKey,
        enqueued: result.changes > 0,
      });
    } catch (err) {
      logger.error({ err, recipientId, channelDedupeKey }, '[outbox:enqueue] Failed to enqueue notification');
    }
  }

  return results;
}

/**
 * Enqueue notification to multiple recipients.
 */
function enqueueNotificationMany(db, { eventType, recipientIds, dedupePrefix, payload }) {
  const uniqueRecipients = [...new Set((recipientIds || []).filter(Boolean))];
  const allResults = [];
  for (const recipientId of uniqueRecipients) {
    const dedupeKey = `${dedupePrefix}:${recipientId}`;
    const res = enqueueNotification(db, { eventType, recipientId, dedupeKey, payload });
    allResults.push(...res);
  }
  return allResults;
}

module.exports = {
  enqueueNotification,
  enqueueNotificationMany,
};
