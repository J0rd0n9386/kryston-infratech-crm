/**
 * DPDP Act 2023 Customer Data Privacy & Erasure Service.
 *
 * Implements right-to-erasure / anonymization of Personally Identifiable
 * Information (PII) while strictly preserving immutable financial records,
 * tax invoices, payments, and statutory audit trails.
 */
'use strict';

const { NotFoundError, ForbiddenError, ValidationError } = require('../../middleware/errors');
const { audit, logAction } = require('../audit-notify');

function anonymizeCustomerData(db, leadId, actor, reason) {
  if (!actor || actor.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('Only a Super Admin can execute DPDP Act customer data erasure.');
  }
  if (!reason || !reason.trim()) {
    throw new ValidationError('A valid reason / reference is required for DPDP customer erasure.');
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new NotFoundError('Lead not found.');

  db.transaction(() => {
    // 1. Redact PII in leads table while retaining sequential lead ID
    db.prepare(`
      UPDATE leads
      SET customer_name = 'Anonymized Customer',
          phone = '+91 00000 00000',
          phone_normalized = '0000000000',
          email = NULL,
          location = 'Redacted (DPDP)',
          requirement = 'Redacted per DPDP Act 2023 erasure request',
          deleted_at = coalesce(deleted_at, datetime('now')),
          version = version + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(leadId);

    // 2. Redact sensitive customer notes in tasks
    db.prepare(`
      UPDATE tasks
      SET brief = 'Redacted per DPDP request',
          response = NULL,
          review_remarks = NULL
      WHERE lead_id = ?
    `).run(leadId);

    // 3. Append immutable timeline entry documenting the erasure
    logAction(
      db,
      leadId,
      'DPDP_ERASURE',
      actor.id,
      null,
      'Administration',
      `Customer PII anonymized per DPDP Act 2023. Reason: ${reason.trim()}`,
      lead.stage,
      lead.stage,
    );

    // 4. Record statutory compliance in audit log
    audit(
      db,
      actor.id,
      'DPDP_CUSTOMER_ANONYMIZED',
      'lead',
      leadId,
      `PII anonymized per DPDP Act 2023. Reason: ${reason.trim()}`,
    );
  })();

  return { ok: true, lead_id: leadId, anonymized: true };
}

module.exports = { anonymizeCustomerData };
