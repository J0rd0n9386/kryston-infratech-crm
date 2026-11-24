/**
 * In-App Notification Channel.
 * Writes directly to the `notifications` table for the user's notification bell.
 */
'use strict';

class InAppChannel {
  /**
   * Deliver an in-app notification.
   * @param {Object} db better-sqlite3 database handle
   * @param {Object} message
   * @param {string} message.recipientId
   * @param {string} message.type
   * @param {string} message.text
   * @param {string} [message.link]
   * @param {string} [message.entityType]
   * @param {string} [message.entityId]
   */
  async send(db, message) {
    if (!message || !message.recipientId) {
      throw new Error('In-app notification requires recipientId');
    }

    // Idempotency check: don't create duplicate notifications for same recipient/message within a short window
    const existing = db
      .prepare(
        `SELECT id FROM notifications
         WHERE employee_id = ? AND message = ? AND type = ? AND created_at >= datetime('now', '-30 seconds')
         LIMIT 1`,
      )
      .get(message.recipientId, String(message.text || '').slice(0, 2000), message.type || 'NOTIFICATION');

    if (existing) {
      return { sent: true, channel: 'in_app', id: existing.id, deduplicated: true };
    }

    const res = db.prepare(
      `INSERT INTO notifications (employee_id, type, message, link, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      message.recipientId,
      message.type || 'NOTIFICATION',
      String(message.text || '').slice(0, 2000),
      message.link || null,
      message.entityType || null,
      message.entityId ? String(message.entityId) : null,
    );

    return { sent: true, channel: 'in_app', id: res.lastInsertRowid };
  }
}

module.exports = new InAppChannel();
