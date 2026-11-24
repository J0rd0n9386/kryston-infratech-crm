/**
 * Phase P8 DPDP Act 2023 Privacy & KPI Analytics Tests.
 */
'use strict';

require('./helpers/environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const { anonymizeCustomerData } = require('../src/lib/services/privacy-service');

function createTestContext() {
  const tmpDir = path.join(__dirname, '..', 'data', `test-p8-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);

  db.prepare(`
    INSERT INTO employees (id, name, email, role, department, password_hash, active)
    VALUES
      ('EMP-SUPER', 'Super Admin', 'super@kryston.in', 'SUPER_ADMIN', 'Administration', 'hash', 1),
      ('EMP-ADMIN', 'Admin Desk', 'admin@kryston.in', 'ADMIN_DESK', 'Administration', 'hash', 1),
      ('EMP-TELE', 'Telecaller', 'tele@kryston.in', 'TELECALLER', 'Sales', 'hash', 1)
  `).run();

  return {
    db,
    cleanup() {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('P8 DPDP Act 2023 - Customer Data Anonymization with Financial Ledger Preservation', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;

    // 1. Setup a lead with sensitive PII, quotation, work order, and task
    db.prepare(`
      INSERT INTO leads (id, channel, source, customer_name, phone, phone_normalized, email, location, requirement, stage, current_owner, created_by)
      VALUES ('KRY-LEAD-DPDP1', 'Online', 'Website', 'Shri Ram Kumar', '+91 91234 56789', '9123456789', 'ram.kumar@gmail.com', 'Kankarbagh, Patna', 'Complete 3BHK interior', 'Work Order Finalized', 'EMP-ADMIN', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO tasks (id, lead_id, assigned_to, assigned_by, department, task_type, brief, response, due_date, sla_hours, status)
      VALUES ('KRY-TASK-DPDP1', 'KRY-LEAD-DPDP1', 'EMP-TELE', 'EMP-ADMIN', 'Sales', 'TELECALLER_ENQUIRY', 'Customer prefers calls in evening', 'Has high budget and urgent requirement', '2026-12-01', 24, 'Closed')
    `).run();

    db.prepare(`
      INSERT INTO quotations (id, lead_id, version, amount, status, created_by)
      VALUES ('KRY-QUOT-DPDP1', 'KRY-LEAD-DPDP1', 1, 800000, 'Approved', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO work_orders (id, lead_id, quotation_id, amount, customer_approval_date, status, created_by)
      VALUES ('KRY-WO-DPDP1', 'KRY-LEAD-DPDP1', 'KRY-QUOT-DPDP1', 800000, '2026-11-20', 'Finalized', 'EMP-ADMIN')
    `).run();

    // 2. Non-Super Admin attempt must fail with 403 Forbidden
    const telecaller = { id: 'EMP-TELE', role: 'TELECALLER' };
    assert.throws(() => {
      anonymizeCustomerData(db, 'KRY-LEAD-DPDP1', telecaller, 'Customer phone request');
    }, /Only a Super Admin/i);

    // 3. Super Admin executes DPDP erasure
    const superAdmin = { id: 'EMP-SUPER', role: 'SUPER_ADMIN' };
    const res = anonymizeCustomerData(db, 'KRY-LEAD-DPDP1', superAdmin, 'Formal customer DPDP erasure notice #DPDP-2026-088');
    assert.equal(res.ok, true);
    assert.equal(res.anonymized, true);

    // 4. Verify PII is redacted in leads table
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get('KRY-LEAD-DPDP1');
    assert.equal(lead.customer_name, 'Anonymized Customer');
    assert.equal(lead.phone, '+91 00000 00000');
    assert.equal(lead.phone_normalized, '0000000000');
    assert.equal(lead.email, null);
    assert.equal(lead.location, 'Redacted (DPDP)');
    assert.match(lead.requirement, /Redacted per DPDP/i);
    assert.ok(lead.deleted_at);

    // 5. Verify task notes are redacted
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('KRY-TASK-DPDP1');
    assert.equal(task.brief, 'Redacted per DPDP request');
    assert.equal(task.response, null);

    // 6. Verify financial work order is strictly preserved
    const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get('KRY-WO-DPDP1');
    assert.equal(wo.amount, 800000);
    assert.equal(wo.status, 'Finalized');

    // 7. Verify audit log recorded the erasure
    const auditRow = db.prepare("SELECT * FROM audit_log WHERE entity_id = ? AND action = 'DPDP_CUSTOMER_ANONYMIZED'").get('KRY-LEAD-DPDP1');
    assert.ok(auditRow);
    assert.equal(auditRow.actor_id, 'EMP-SUPER');
  } finally {
    ctx.cleanup();
  }
});
