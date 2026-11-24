/**
 * Notification Outbox Background Worker.
 *
 * Processes pending items from `notification_outbox`, dispatches to channel adapters
 * (in_app, email, whatsapp), implements exponential backoff on retry, and dead-letters
 * poisoned messages after max attempts. Non-blocking with graceful shutdown.
 */
'use strict';

const logger = require('../logger');
const inAppChannel = require('../channels/in-app');
const emailChannel = require('../channels/email');
const whatsAppChannel = require('../channels/whatsapp');

const CHANNEL_ADAPTERS = {
  in_app: inAppChannel,
  email: emailChannel,
  whatsapp: whatsAppChannel,
};

/**
 * Calculate exponential backoff in seconds.
 * 1st failure: 10s
 * 2nd failure: 20s
 * 3rd failure: 40s
 * 4th failure: 80s
 * 5th failure: dead-letter
 */
function calculateBackoffSeconds(attempts) {
  const baseSeconds = 10;
  return Math.min(1800, Math.pow(2, Math.max(0, attempts - 1)) * baseSeconds);
}

/**
 * Process a single batch of outbox items.
 *
 * @param {Object} db better-sqlite3 database handle
 * @param {number} [limit=50]
 * @returns {Promise<{ processed: number, sent: number, failed: number, deadLettered: number }>}
 */
async function processOutboxBatch(db, limit = 50) {
  const stats = { processed: 0, sent: 0, failed: 0, deadLettered: 0 };

  const items = db
    .prepare(
      `SELECT * FROM notification_outbox
       WHERE status IN ('pending', 'failed')
         AND attempts < max_attempts
         AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(limit);

  if (!items.length) {
    return stats;
  }

  for (const item of items) {
    stats.processed++;

    // Mark as processing
    db.prepare("UPDATE notification_outbox SET status = 'processing' WHERE id = ?").run(item.id);

    let payload;
    try {
      payload = JSON.parse(item.payload);
    } catch (parseErr) {
      // Dead-letter invalid payload immediately
      db.prepare(
        "UPDATE notification_outbox SET status = 'dead_letter', last_error = ?, processed_at = datetime('now') WHERE id = ?",
      ).run(`Invalid JSON payload: ${parseErr.message}`, item.id);
      stats.deadLettered++;
      continue;
    }

    const adapter = CHANNEL_ADAPTERS[item.channel];
    if (!adapter) {
      db.prepare(
        "UPDATE notification_outbox SET status = 'dead_letter', last_error = ?, processed_at = datetime('now') WHERE id = ?",
      ).run(`No adapter for channel: ${item.channel}`, item.id);
      stats.deadLettered++;
      continue;
    }

    try {
      const channelMsg = {
        recipientId: item.recipient_id,
        type: item.event_type,
        text: payload.text || payload.message || '',
        subject: payload.subject || `${item.event_type} - Kryston CRM`,
        link: payload.link || '',
        entityType: payload.entityType || '',
        entityId: payload.entityId || '',
        html: payload.html,
      };

      await adapter.send(db, channelMsg);

      // Successfully sent
      db.prepare(
        "UPDATE notification_outbox SET status = 'sent', processed_at = datetime('now'), last_error = NULL WHERE id = ?",
      ).run(item.id);
      stats.sent++;
    } catch (err) {
      const newAttempts = item.attempts + 1;
      const errorMsg = String(err.message || err).slice(0, 1000);

      if (newAttempts >= item.max_attempts) {
        // Exceeded max attempts: move to dead_letter
        db.prepare(
          `UPDATE notification_outbox
           SET status = 'dead_letter', attempts = ?, last_error = ?, processed_at = datetime('now')
           WHERE id = ?`,
        ).run(newAttempts, errorMsg, item.id);
        stats.deadLettered++;
      } else {
        // Retry with backoff
        const backoffSec = calculateBackoffSeconds(newAttempts);
        db.prepare(
          `UPDATE notification_outbox
           SET status = 'failed',
               attempts = ?,
               next_retry_at = datetime('now', '+' || ? || ' seconds'),
               last_error = ?
           WHERE id = ?`,
        ).run(newAttempts, backoffSec, errorMsg, item.id);
        stats.failed++;
      }
    }
  }

  return stats;
}

/**
 * Background worker instance manager.
 */
class OutboxWorker {
  constructor(db, options = {}) {
    this.db = db;
    this.intervalMs = options.intervalMs || 5000;
    this.timer = null;
    this.running = false;
    this.isProcessing = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        await processOutboxBatch(this.db);
      } catch (err) {
        logger.error({ err }, '[outbox:worker] error during batch processing');
      } finally {
        this.isProcessing = false;
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

  async processNow(limit = 50) {
    return processOutboxBatch(this.db, limit);
  }
}

function createOutboxWorker(db, options = {}) {
  return new OutboxWorker(db, options);
}

module.exports = {
  calculateBackoffSeconds,
  processOutboxBatch,
  OutboxWorker,
  createOutboxWorker,
};
