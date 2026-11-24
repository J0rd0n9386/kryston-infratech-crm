/**
 * Reset Customer & Workflow Data (Clean Slate).
 *
 * Removes all leads, tasks, quotes, work orders, projects, payments,
 * attachments, notifications, and related operational records while
 * preserving:
 *   - All employee accounts (employees table)
 *   - Database schema migrations (schema_migrations)
 *   - Configuration tables (approval_rules, routing_rules, sla_settings, etc.)
 *
 * Resetting tables ensures ID generators start fresh from 0001 (e.g. KRY-LEAD-2026-0001).
 *
 * Usage: node scripts/reset-customers.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const TABLES_TO_CLEAR = [
  'leads',
  'lead_actions',
  'tasks',
  'task_activity',
  'telecaller_responses',
  'dept_updates',
  'site_visits',
  'site_visits_schedule',
  'designs',
  'quotations',
  'quotation_versions',
  'work_orders',
  'projects',
  'project_updates',
  'project_milestones',
  'project_handoffs',
  'payments',
  'payment_milestones',
  'invoices',
  'material_requisitions',
  'lead_attachments',
  'attachments',
  'notifications',
  'notification_outbox',
  'reminders',
  'boq_items',
  'change_orders',
  'purchase_requests',
  'customer_updates',
  'snag_items',
  'warranties',
  'warranty_claims',
  'referral_requests',
  'admin_requests',
  'negotiation_rounds',
  'variation_acceptances',
  'sla_breach_notifications',
  'daily_digest_log',
];

function cleanAttachments(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  const files = fs.readdirSync(dirPath);
  let count = 0;
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        fs.unlinkSync(fullPath);
        count++;
      }
    } catch (err) {
      // ignore
    }
  }
  return count;
}

function main() {
  const dbPath = path.resolve(config.databasePath);
  console.log(`[reset] Opening database: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    console.error(`[reset] Error: Database file not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Verify employees exist before clearing anything
  const empCount = db.prepare('SELECT count(*) as c FROM employees').get().c;
  console.log(`[reset] Found ${empCount} employee accounts. Preserving all of them.`);
  if (empCount === 0) {
    console.warn('[reset] Warning: No employees found in database.');
  }

  console.log('[reset] Temporarily dropping immutable triggers for cleanup...');
  db.exec(`
    DROP TRIGGER IF EXISTS lead_actions_no_delete;
    DROP TRIGGER IF EXISTS audit_log_no_delete;
    DROP TRIGGER IF EXISTS task_activity_no_delete;
    DROP TRIGGER IF EXISTS trg_payments_no_delete;
  `);

  console.log('[reset] Disabling foreign keys for truncation...');
  db.pragma('foreign_keys = OFF');

  const executeWipe = db.transaction(() => {
    // 1. Clear operational / customer tables
    for (const table of TABLES_TO_CLEAR) {
      try {
        db.exec(`DELETE FROM "${table}";`);
      } catch (err) {
        console.warn(`[reset] Note for table ${table}: ${err.message}`);
      }
    }

    // 2. Clear customer/lead audit logs, preserve employee creation audits if any
    try {
      db.exec("DELETE FROM audit_log WHERE entity_type != 'employee';");
    } catch (err) {
      console.warn(`[reset] Note for audit_log: ${err.message}`);
    }

    // 3. Rebuild FTS5 virtual table
    try {
      db.exec("INSERT INTO leads_fts(leads_fts) VALUES('rebuild');");
    } catch (err) {
      console.warn(`[reset] Note for leads_fts rebuild: ${err.message}`);
    }
  });

  console.log('[reset] Executing transactional data purge...');
  executeWipe();

  console.log('[reset] Re-enabling foreign keys...');
  db.pragma('foreign_keys = ON');

  const fkErrors = db.prepare('PRAGMA foreign_key_check;').all();
  if (fkErrors.length > 0) {
    console.error('[reset] Foreign key check errors:', fkErrors);
  } else {
    console.log('[reset] Foreign key check: OK (no integrity errors)');
  }

  console.log('[reset] Restoring immutable triggers...');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lead_actions_no_delete
    BEFORE DELETE ON lead_actions BEGIN SELECT RAISE(ABORT, 'lead timeline entries are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit records are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS task_activity_no_delete
    BEFORE DELETE ON task_activity
    BEGIN
      SELECT RAISE(ABORT, 'task_activity is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_payments_no_delete
    BEFORE DELETE ON payments
    BEGIN
      SELECT RAISE(FAIL, 'payments ledger is append-only and rows cannot be deleted');
    END;
  `);

  console.log('[reset] Vacuuming database...');
  db.exec('VACUUM;');

  // Clean physical files in attachments and uploads
  const attachmentsDir = path.resolve(__dirname, '../data/attachments');
  const uploadsDir = path.resolve(__dirname, '../data/uploads');
  const removedAttachments = cleanAttachments(attachmentsDir);
  const removedUploads = cleanAttachments(uploadsDir);
  console.log(`[reset] Cleared ${removedAttachments} file(s) from ${attachmentsDir}`);
  console.log(`[reset] Cleared ${removedUploads} file(s) from ${uploadsDir}`);

  // Summary of remaining counts
  console.log('\n[reset] Verification summary:');
  const leadsCount = db.prepare('SELECT count(*) as c FROM leads').get().c;
  const tasksCount = db.prepare('SELECT count(*) as c FROM tasks').get().c;
  const quotesCount = db.prepare('SELECT count(*) as c FROM quotations').get().c;
  const projectsCount = db.prepare('SELECT count(*) as c FROM projects').get().c;
  const employeesFinal = db.prepare('SELECT count(*) as c FROM employees').get().c;

  console.log(`  Leads: ${leadsCount}`);
  console.log(`  Tasks: ${tasksCount}`);
  console.log(`  Quotations: ${quotesCount}`);
  console.log(`  Projects: ${projectsCount}`);
  console.log(`  Employees: ${employeesFinal}`);

  db.close();
  console.log('\n[reset] Database reset complete! Clean slate ready for fresh testing.\n');
}

main();
