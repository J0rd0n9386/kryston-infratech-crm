'use strict';

require('./helpers/environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const { createApp } = require('../src/app');
const { calculateLineItem, summarizeBoq, addBoqItem, lockBoqToQuotation, deleteBoqItem } = require('../src/lib/services/boq-service');

function createTestContext() {
  const tmpDir = path.join(__dirname, '..', 'data', `test-boq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      ('EMP-ENG', 'Site Engineer', 'eng@kryston.in', 'SITE_ENGINEER', 'Technical', 'hash', 1),
      ('EMP-BDM', 'BDM Person', 'bdm@kryston.in', 'BDM', 'Sales', 'hash', 1)
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

test('P3 BOQ Service - Zero Float Integer Paise Calculation', () => {
  // Test item: 500 sq ft @ 120.50 INR per sq ft = 12050 paise
  const line = calculateLineItem({
    quantity: 500,
    rate_paise: 12050,
    gst_rate: 18.0,
  });

  assert.equal(line.amount_paise, 6025000); // 60,250.00 INR
  assert.equal(line.gst_amount_paise, 1084500); // 10,845.00 INR (18%)
  assert.equal(line.total_paise, 7109500); // 71,095.00 INR

  // Test summary with categories & intra-state tax
  const summary = summarizeBoq([
    {
      category: 'Civil',
      amount_paise: 6025000,
      gst_amount_paise: 1084500,
      total_paise: 7109500,
    },
    {
      category: 'Electrical',
      amount_paise: 2000000,
      gst_amount_paise: 360000,
      total_paise: 2360000,
    },
  ]);

  assert.equal(summary.items_count, 2);
  assert.equal(summary.subtotal_paise, 8025000);
  assert.equal(summary.subtotal_inr, '80250.00');
  assert.equal(summary.gst_total_paise, 1444500);
  assert.equal(summary.cgst_paise, 722250);
  assert.equal(summary.sgst_paise, 722250);
  assert.equal(summary.grand_total_paise, 9469500);
  assert.equal(summary.grand_total_inr, '94695.00');
  assert.equal(summary.categories.length, 2);
});

test('P3 BOQ & Site Visits Lifecycle', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;
    const admin = { id: 'EMP-ADMIN', role: 'ADMIN_DESK' };
    const engineer = { id: 'EMP-ENG', role: 'SITE_ENGINEER' };

    // Create a lead
    db.prepare(`
      INSERT INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by)
      VALUES ('KRY-LEAD-TEST1', 'Online', 'Website', 'BOQ Lead', '9812345678', 'New', 'EMP-ADMIN', 'EMP-ADMIN')
    `).run();

    // 1. Add BOQ items
    const item1 = addBoqItem(db, admin, {
      lead_id: 'KRY-LEAD-TEST1',
      category: 'Civil',
      item_name: 'Italian Marble Flooring',
      quantity: 350,
      unit: 'sq ft',
      rate_paise: 45000, // ₹450/sq ft
      gst_rate: 18.0,
    });
    assert.ok(item1.id);
    assert.equal(item1.amount_paise, 15750000); // 350 * 45000 = 1,57,500.00 INR

    // 2. Schedule site visit
    db.prepare(`
      INSERT INTO site_visits_schedule (id, lead_id, assigned_engineer, scheduled_at, status, site_address, created_by)
      VALUES ('VISIT-01', 'KRY-LEAD-TEST1', 'EMP-ENG', '2026-11-25 10:00:00', 'Scheduled', 'Patna Main Road', 'EMP-ADMIN')
    `).run();

    const visit = db.prepare('SELECT * FROM site_visits_schedule WHERE id = ?').get('VISIT-01');
    assert.equal(visit.status, 'Scheduled');
    assert.equal(visit.assigned_engineer, 'EMP-ENG');

    // 3. Create quotation and lock BOQ items to it
    db.prepare(`
      INSERT INTO quotations (id, lead_id, version, amount, status, created_by)
      VALUES ('KRY-QUOT-TEST1', 'KRY-LEAD-TEST1', 1, 157500, 'Sent', 'EMP-BDM')
    `).run();

    lockBoqToQuotation(db, 'KRY-LEAD-TEST1', 'KRY-QUOT-TEST1');
    const lockedItem = db.prepare('SELECT * FROM boq_items WHERE id = ?').get(item1.id);
    assert.equal(lockedItem.quotation_id, 'KRY-QUOT-TEST1');

    // Deleting from locked quotation must fail
    assert.throws(() => {
      deleteBoqItem(db, admin, item1.id);
    }, /Cannot delete BOQ item from a locked quotation/);
  } finally {
    ctx.cleanup();
  }
});
