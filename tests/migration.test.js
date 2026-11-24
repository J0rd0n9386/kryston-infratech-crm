/**
 * Migration verification tests.
 *
 * Copies/initializes a representative pre-Phase-2 database in an isolated temp directory,
 * applies pending numbered migrations, and asserts schema integrity, foreign keys,
 * row counts, version defaults, phone normalization, and append-only ledger immutability.
 *
 * Never runs against the live database.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations, getAppliedVersions, ensureMigrationTable } = require('../src/db/migrations');

test('numbered SQL migrations upgrade legacy database cleanly and idempotently', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-migration-test-'));
  const tempDbPath = path.join(tempDir, 'migration-test.db');
  const migrationsDir = path.resolve(__dirname, '../migrations');

  let db = new Database(tempDbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    ensureMigrationTable(db);

    // Apply baseline migrations 001, 002, 003 representing legacy state
    const baselineFiles = ['001_enterprise_schema.sql', '002_hardening.sql', '003_auth_security.sql'];
    for (let i = 0; i < baselineFiles.length; i++) {
      const ver = i + 1;
      const sql = fs.readFileSync(path.join(migrationsDir, baselineFiles[i]), 'utf8');
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, description, applied_at) VALUES (?, ?, ?, datetime(\'now\'))',
      ).run(ver, `baseline-${ver}`, `Baseline migration ${ver}`);
    }

    // Verify baseline versions
    const preApplied = getAppliedVersions(db);
    assert.deepEqual(Array.from(preApplied).sort((a, b) => a - b), [1, 2, 3]);

    // Insert representative business rows into the legacy database
    db.prepare(`
      INSERT INTO employees (id, name, email, phone, role, department, password_hash, active)
      VALUES ('KRY-ADM-MIG', 'Admin Mig', 'mig-admin@kryston.local', '+91 99999 11111', 'ADMIN_DESK', 'Administration', 'hash', 1)
    `).run();

    db.prepare(`
      INSERT INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by)
      VALUES ('KRY-LEAD-MIG1', 'Online', 'Website', 'Mig Lead', '+91 98765 43210', 'New', 'KRY-ADM-MIG', 'KRY-ADM-MIG')
    `).run();

    db.prepare(`
      INSERT INTO tasks (id, lead_id, assigned_to, assigned_by, department, task_type, brief, due_date, sla_hours, status)
      VALUES ('KRY-TASK-MIG1', 'KRY-LEAD-MIG1', 'KRY-ADM-MIG', 'KRY-ADM-MIG', 'Administration', 'GENERAL_FOLLOWUP', 'Initial follow up', '2030-01-01', 24, 'Assigned')
    `).run();

    db.prepare(`
      INSERT INTO lead_actions (lead_id, action_type, from_employee, to_employee, to_department, remarks, old_stage, new_stage)
      VALUES ('KRY-LEAD-MIG1', 'CREATED', 'KRY-ADM-MIG', 'KRY-ADM-MIG', 'Administration', 'Initial creation', NULL, 'New')
    `).run();

    db.prepare(`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
      VALUES ('KRY-ADM-MIG', 'CREATE', 'lead', 'KRY-LEAD-MIG1', 'Audit creation record')
    `).run();

    const preLeadCount = db.prepare('SELECT count(*) as c FROM leads').get().c;
    const preTaskCount = db.prepare('SELECT count(*) as c FROM tasks').get().c;
    const preActionCount = db.prepare('SELECT count(*) as c FROM lead_actions').get().c;
    const preAuditCount = db.prepare('SELECT count(*) as c FROM audit_log').get().c;

    // Run migrations to apply pending migrations
    const applied = runMigrations(db, { migrationsDir });
    assert.ok(applied.includes('004_phase2_optimistic_locking_and_indexes.sql'));
    assert.ok(applied.includes('005_attachments_and_notifications.sql'));
    assert.ok(applied.includes('006_analytics_and_business.sql'));
    assert.ok(applied.includes('007_calling_queue_and_reminders.sql'));
    assert.ok(applied.includes('008_call_log_enhancements.sql'));
    assert.ok(applied.includes('009_auth_hardening.sql'));
    assert.ok(applied.includes('010_workflow_engine.sql'));
    assert.ok(applied.includes('011_site_visit_and_boq.sql'));
    assert.ok(applied.includes('012_invoicing_and_payments.sql'));
    assert.ok(applied.includes('013_execution_and_procurement.sql'));
    assert.ok(applied.includes('014_handover_and_warranty.sql'));
    assert.ok(applied.includes('017_site_visit_cost_estimation.sql'));

    // Verify all migrations are now registered
    const postApplied = getAppliedVersions(db);
    assert.deepEqual(Array.from(postApplied).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

    // Check PRAGMA integrity_check
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    assert.equal(integrityRows.length, 1);
    assert.equal(Object.values(integrityRows[0])[0], 'ok');

    // Check PRAGMA foreign_key_check
    const fkRows = db.prepare('PRAGMA foreign_key_check').all();
    assert.equal(fkRows.length, 0, `foreign key check failed: ${JSON.stringify(fkRows)}`);

    // Verify existing data preserved
    assert.equal(db.prepare('SELECT count(*) as c FROM leads').get().c, preLeadCount);
    assert.equal(db.prepare('SELECT count(*) as c FROM tasks').get().c, preTaskCount);
    assert.equal(db.prepare('SELECT count(*) as c FROM lead_actions').get().c, preActionCount);
    assert.equal(db.prepare('SELECT count(*) as c FROM audit_log').get().c, preAuditCount);

    // Verify optimistic locking column and phone normalization backfill
    const updatedLead = db.prepare('SELECT * FROM leads WHERE id = ?').get('KRY-LEAD-MIG1');
    assert.equal(updatedLead.version, 1);
    assert.equal(updatedLead.phone_normalized, '9876543210');
    assert.equal(updatedLead.merged_into, null);

    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('KRY-TASK-MIG1');
    assert.equal(updatedTask.version, 1);

    // Verify new indexes exist
    const indexes = db.prepare('SELECT name FROM sqlite_master WHERE type=\'index\'').all().map((r) => r.name);
    assert.ok(indexes.includes('idx_leads_phone_norm'));
    assert.ok(indexes.includes('idx_leads_stage_owner_created'));
    assert.ok(indexes.includes('idx_tasks_assignee_status_due'));
    assert.ok(indexes.includes('idx_lead_actions_lead_created'));
    assert.ok(indexes.includes('idx_tasks_queue'));
    assert.ok(indexes.includes('idx_reminders_due'));
    assert.ok(indexes.includes('idx_activity_task'));

    // Verify task_activity immutability triggers
    db.prepare(`
      INSERT INTO task_activity (task_id, lead_id, employee_id, kind, outcome, notes)
      VALUES ('KRY-TASK-MIG1', 'KRY-LEAD-MIG1', 'KRY-ADM-MIG', 'CALL', 'CONNECTED', 'Test note')
    `).run();

    assert.throws(() => {
      db.prepare('UPDATE task_activity SET notes = \'edited\' WHERE task_id = ?').run('KRY-TASK-MIG1');
    }, /task_activity is append-only/i);

    assert.throws(() => {
      db.prepare('DELETE FROM task_activity WHERE task_id = ?').run('KRY-TASK-MIG1');
    }, /task_activity is append-only/i);

    // Verify triggers on append-only ledgers are still protecting tables
    assert.throws(() => {
      db.prepare('UPDATE lead_actions SET remarks = \'modified\' WHERE lead_id = ?').run('KRY-LEAD-MIG1');
    }, /lead timeline entries are immutable/i);

    assert.throws(() => {
      db.prepare('DELETE FROM lead_actions WHERE lead_id = ?').run('KRY-LEAD-MIG1');
    }, /lead timeline entries are immutable/i);

    assert.throws(() => {
      db.prepare('UPDATE audit_log SET details = \'modified\' WHERE entity_id = ?').run('KRY-LEAD-MIG1');
    }, /audit records are immutable/i);

    assert.throws(() => {
      db.prepare('DELETE FROM audit_log WHERE entity_id = ?').run('KRY-LEAD-MIG1');
    }, /audit records are immutable/i);

    // Idempotency: Running migrations again should apply 0 migrations and leave DB unchanged
    const secondRun = runMigrations(db, { migrationsDir });
    assert.equal(secondRun.length, 0);
    assert.deepEqual(Array.from(getAppliedVersions(db)).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
