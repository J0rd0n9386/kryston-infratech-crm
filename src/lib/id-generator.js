/**
 * Sequential ID generation: KRY-LEAD-2026-0001, KRY-TASK-2026-0001, ...
 *
 * Uses MAX(suffix) rather than COUNT(*) so deleting or archiving a record can
 * never cause a previously used ID to be reissued. Callers invoke this inside
 * the same transaction as the INSERT, and better-sqlite3 is synchronous, so the
 * read-then-insert pair is serialised.
 */
'use strict';

const ALLOWED_TABLES = new Set([
  'leads',
  'tasks',
  'quotations',
  'work_orders',
  'projects',
  'payments',
  'material_requisitions',
  'delegations',
  'approval_rules',
  'routing_rules',
  'sla_settings',
  'boq_items',
  'invoices',
  'change_orders',
  'purchase_requests',
  'customer_updates',
  'snag_items',
  'warranties',
  'warranty_claims',
  'referral_requests',
]);

function generateId(db, prefix, table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`ID generation is not configured for table "${table}".`);
  }
  const year = new Date().getFullYear();
  const pattern = `${prefix}-${year}-%`;
  const start = pattern.length; // position of the numeric suffix (1-indexed)

  const row = db
    .prepare(
      `SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS max_seq
       FROM ${table}
       WHERE id LIKE ?`,
    )
    .get(start, pattern);

  const next = (Number(row && row.max_seq) || 0) + 1;
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

module.exports = { generateId };
