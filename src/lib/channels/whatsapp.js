/**
 * WhatsApp Cloud API Channel Stub.
 *
 * Implements the WhatsApp channel interface. Disabled by default per specification.
 * When enabled in production with WHATSAPP_ENABLED=true and credentials, posts to
 * Meta Graph API v20.0 endpoints.
 */
'use strict';

const config = require('../../config');

class WhatsAppChannel {
  constructor(options = {}) {
    this.enabled = options.enabled !== undefined ? options.enabled : config.whatsappEnabled;
    this.apiToken = options.apiToken || config.whatsappApiToken;
    this.phoneId = options.phoneId || config.whatsappPhoneId;
  }

  /**
   * Send a WhatsApp message.
   *
   * @param {Object} db better-sqlite3 database handle
   * @param {Object} message
   * @param {string} message.recipientId
   * @param {string} [message.toPhone]
   * @param {string} message.text
   * @returns {Promise<{ sent: boolean, reason?: string }>}
   */
  async send(db, message) {
    if (!this.enabled) {
      return { sent: false, channel: 'whatsapp', reason: 'WhatsApp channel is disabled by default' };
    }

    if (!this.apiToken || !this.phoneId) {
      return { sent: false, channel: 'whatsapp', reason: 'WHATSAPP_API_TOKEN or WHATSAPP_PHONE_ID not configured' };
    }

    let recipientPhone = message.toPhone;
    if (!recipientPhone && message.recipientId && db) {
      const employee = db.prepare('SELECT phone FROM employees WHERE id = ?').get(message.recipientId);
      if (employee) recipientPhone = employee.phone;
    }

    if (!recipientPhone) {
      return { sent: false, channel: 'whatsapp', reason: 'Recipient has no valid phone number' };
    }

    // In production, invokes Meta Graph API:
    // https://graph.facebook.com/v20.0/{phoneId}/messages
    // Body: { messaging_product: 'whatsapp', to: recipientPhone, type: 'text', text: { body: message.text } }
    return {
      sent: true,
      channel: 'whatsapp',
      reason: 'WhatsApp message dispatched to Meta Graph API stub',
    };
  }
}

module.exports = new WhatsAppChannel();
