/**
 * Email Notification Channel via Resend.
 *
 * Env-driven: if RESEND_API_KEY is not configured, operations silently no-op
 * without throwing errors or blocking execution.
 */
'use strict';

const config = require('../../config');

class EmailChannel {
  constructor(options = {}) {
    this.apiKey = options.apiKey !== undefined ? options.apiKey : config.resendApiKey;
    this.fromEmail = options.fromEmail || config.resendFromEmail;
  }

  /**
   * Send an email via Resend API.
   *
   * @param {Object} db better-sqlite3 database handle
   * @param {Object} message
   * @param {string} message.recipientId
   * @param {string} [message.to] Recipient email (or fetched from db)
   * @param {string} message.subject
   * @param {string} message.text
   * @param {string} [message.html]
   * @returns {Promise<{ sent: boolean, reason?: string, id?: string }>}
   */
  async send(db, message) {
    // If Resend API key is not set, silently no-op per specification
    if (!this.apiKey) {
      return { sent: false, channel: 'email', reason: 'RESEND_API_KEY is unset (silently no-op)' };
    }

    let recipientEmail = message.to;
    if (!recipientEmail && message.recipientId && db) {
      const employee = db.prepare('SELECT email FROM employees WHERE id = ?').get(message.recipientId);
      if (employee) recipientEmail = employee.email;
    }

    if (!recipientEmail) {
      return { sent: false, channel: 'email', reason: 'Recipient has no valid email address' };
    }

    const payload = {
      from: this.fromEmail,
      to: [recipientEmail],
      subject: message.subject || 'Kryston Infratech CRM Notification',
      text: message.text || '',
    };

    if (message.html) {
      payload.html = message.html;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Resend API returned HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return { sent: true, channel: 'email', id: data.id };
    } catch (err) {
      // In outbox worker context, throwing allows retry/backoff
      throw new Error(`Resend email delivery failed: ${err.message}`);
    }
  }
}

module.exports = new EmailChannel();
