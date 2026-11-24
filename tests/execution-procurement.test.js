'use strict';

require('./helpers/environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const { createApp } = require('../src/app');

function createTestContext() {
  const tmpDir = path.join(__dirname, '..', 'data', `test-exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);

  db.prepare(`
    INSERT INTO employees (id, name, email, role, department, password_hash, active)
    VALUES
      ('EMP-ADMIN', 'Admin Desk', 'admin@kryston.in', 'ADMIN_DESK', 'Administration', 'hash', 1),
      ('EMP-PM', 'Project Manager', 'pm@kryston.in', 'PROJECT_MANAGER', 'Projects', 'hash', 1),
      ('EMP-ENG', 'Site Engineer', 'eng@kryston.in', 'SITE_ENGINEER', 'Technical', 'hash', 1),
      ('EMP-PURCH', 'Purchase Officer', 'purchase@kryston.in', 'PURCHASE', 'Purchase', 'hash', 1)
  `).run();

  const app = createApp(db);

  return {
    db,
    app,
    cleanup() {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('P5 Execution, Procurement & Customer Updates Lifecycle', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;

    // 1. Setup active lead, work order and project
    db.prepare(`
      INSERT INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by)
      VALUES ('KRY-LEAD-EXEC1', 'Online', 'Website', 'Execution Client', '9811122299', 'In Progress', 'EMP-PM', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO quotations (id, lead_id, version, amount, status, created_by)
      VALUES ('KRY-QUOT-01', 'KRY-LEAD-EXEC1', 1, 1200000, 'Approved', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO work_orders (id, lead_id, quotation_id, amount, customer_approval_date, status, created_by)
      VALUES ('KRY-WO-EXEC1', 'KRY-LEAD-EXEC1', 'KRY-QUOT-01', 1200000, '2026-11-20', 'Finalized', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO projects (id, work_order_id, lead_id, project_manager, site_engineer, status, target_completion, start_date)
      VALUES ('KRY-PROJ-EXEC1', 'KRY-WO-EXEC1', 'KRY-LEAD-EXEC1', 'EMP-PM', 'EMP-ENG', 'In Progress', '2027-02-01', '2026-11-20')
    `).run();

    // 2. Change Order creation and Admin approval
    db.prepare(`
      INSERT INTO change_orders (id, project_id, description, cost_delta_paise, schedule_delta_days, status, created_by)
      VALUES ('KRY-CO-01', 'KRY-PROJ-EXEC1', 'Add False Ceiling in Master Bedroom', 4500000, 7, 'Draft', 'EMP-PM')
    `).run();

    const co = db.prepare('SELECT * FROM change_orders WHERE id = ?').get('KRY-CO-01');
    assert.equal(co.status, 'Draft');
    assert.equal(co.cost_delta_paise, 4500000); // ₹45,000.00
    assert.equal(co.schedule_delta_days, 7);

    // Approve Change Order
    db.prepare(`
      UPDATE change_orders
      SET status = 'Approved', customer_approval_ref = 'CO-SIGN-778', approved_by = 'EMP-ADMIN', updated_at = datetime('now')
      WHERE id = 'KRY-CO-01'
    `).run();

    db.prepare(`
      UPDATE projects
      SET target_completion = date(target_completion, '+' || ? || ' days')
      WHERE id = 'KRY-PROJ-EXEC1'
    `).run(co.schedule_delta_days);

    const updatedProj = db.prepare('SELECT target_completion FROM projects WHERE id = ?').get('KRY-PROJ-EXEC1');
    assert.equal(updatedProj.target_completion, '2027-02-08'); // Extended by 7 days

    // 3. Purchase Request Lifecycle
    db.prepare(`
      INSERT INTO purchase_requests (
        id, project_id, requested_by, item_name, category, quantity, unit,
        estimated_cost_paise, urgency, status
      )
      VALUES ('KRY-PR-01', 'KRY-PROJ-EXEC1', 'EMP-ENG', 'Ultratech Cement', 'Civil', 100, 'bags', 4200000, 'Normal', 'Pending Admin Approval')
    `).run();

    // Admin approves material request
    db.prepare(`
      UPDATE purchase_requests
      SET status = 'Approved', approved_by = 'EMP-ADMIN', approved_at = datetime('now'), updated_at = datetime('now')
      WHERE id = 'KRY-PR-01'
    `).run();

    // Purchase Officer fulfills procurement
    db.prepare(`
      UPDATE purchase_requests
      SET status = 'Fulfilled', admin_notes = 'Delivered to Patna site via Vendor ABC', updated_at = datetime('now')
      WHERE id = 'KRY-PR-01'
    `).run();

    const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get('KRY-PR-01');
    assert.equal(pr.status, 'Fulfilled');

    // 4. Customer Progress Update
    db.prepare(`
      INSERT INTO customer_updates (
        id, project_id, lead_id, update_type, title, summary,
        photos_count, status, created_by
      )
      VALUES (
        'CUST-UPD-01', 'KRY-PROJ-EXEC1', 'KRY-LEAD-EXEC1', 'WEEKLY_PROGRESS',
        'Week 2 Progress: Flooring Complete', 'All Italian marble tiles laid out cleanly in drawing room.',
        4, 'Draft', 'EMP-PM'
      )
    `).run();

    // Admin signs off & dispatches
    db.prepare(`
      UPDATE customer_updates
      SET status = 'Dispatched', dispatched_at = datetime('now'), dispatched_via = 'WhatsApp', updated_at = datetime('now')
      WHERE id = 'CUST-UPD-01'
    `).run();

    const update = db.prepare('SELECT * FROM customer_updates WHERE id = ?').get('CUST-UPD-01');
    assert.equal(update.status, 'Dispatched');
    assert.equal(update.dispatched_via, 'WhatsApp');
  } finally {
    ctx.cleanup();
  }
});
