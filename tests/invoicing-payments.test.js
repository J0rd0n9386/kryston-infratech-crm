'use strict';

require('./helpers/environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const { createApp } = require('../src/app');
const { validateMilestones, createInvoice, recordPayment, isAdvanceCleared } = require('../src/lib/services/billing-service');

function createTestContext() {
  const tmpDir = path.join(__dirname, '..', 'data', `test-billing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      ('EMP-ACC', 'Accounts Officer', 'accounts@kryston.in', 'ACCOUNTS', 'Accounts', 'hash', 1),
      ('EMP-PM', 'Project Manager', 'pm@kryston.in', 'PROJECT_MANAGER', 'Projects', 'hash', 1),
      ('EMP-ENG', 'Site Engineer', 'eng@kryston.in', 'SITE_ENGINEER', 'Technical', 'hash', 1),
      ('EMP-SM', 'Sales Manager', 'sm@kryston.in', 'SALES_MANAGER', 'Sales', 'hash', 1)
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

test('P4 Billing Service - Milestone Validation (100% Sum Check)', () => {
  const contractValuePaise = 50000000; // ₹5,00,000.00

  // Case 1: Sum != 100% must throw
  assert.throws(() => {
    validateMilestones(
      [
        { name: 'Advance', percentage: 20 },
        { name: 'Structure', percentage: 40 },
        { name: 'Finishing', percentage: 30 }, // Total = 90%
      ],
      contractValuePaise,
    );
  }, /Total milestone percentage must sum to exactly 100%/);

  // Case 2: Sum = 100% calculates integer paise
  const valid = validateMilestones(
    [
      { name: 'Advance on Signing', percentage: 20 },
      { name: 'Civil & Structure', percentage: 40 },
      { name: 'Interiors & Woodwork', percentage: 30 },
      { name: 'Handover', percentage: 10 },
    ],
    contractValuePaise,
  );

  assert.equal(valid.length, 4);
  assert.equal(valid[0].amount_paise, 10000000); // 20% of 5L = 1L
  assert.equal(valid[1].amount_paise, 20000000); // 40% of 5L = 2L
  assert.equal(valid[2].amount_paise, 15000000); // 30% of 5L = 1.5L
  assert.equal(valid[3].amount_paise, 5000000); // 10% of 5L = 0.5L

  const totalPaise = valid.reduce((sum, m) => sum + m.amount_paise, 0);
  assert.equal(totalPaise, contractValuePaise);
});

test('P4 Invoicing, Append-Only Payments Ledger & Advance Gate', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;
    const admin = { id: 'EMP-ADMIN', role: 'ADMIN_DESK' };
    const accounts = { id: 'EMP-ACC', role: 'ACCOUNTS' };

    // Setup lead and work order
    db.prepare(`
      INSERT INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by)
      VALUES ('KRY-LEAD-BILL1', 'Online', 'Website', 'Billing Customer', '9899988811', 'Work Order Pending Admin Approval', 'EMP-ADMIN', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO quotations (id, lead_id, version, amount, status, created_by)
      VALUES ('KRY-QUOT-01', 'KRY-LEAD-BILL1', 1, 500000, 'Approved', 'EMP-SM')
    `).run();

    db.prepare(`
      INSERT INTO work_orders (id, lead_id, quotation_id, amount, customer_approval_date, status, created_by)
      VALUES ('KRY-WO-BILL1', 'KRY-LEAD-BILL1', 'KRY-QUOT-01', 500000, '2026-11-23', 'Pending Admin Approval', 'EMP-SM')
    `).run();

    // 1. Create advance milestone and invoice
    db.prepare(`
      INSERT INTO payment_milestones (id, work_order_id, name, percentage, amount_paise, status, sequence_order)
      VALUES ('MS-01', 'KRY-WO-BILL1', 'Advance on Signing', 20, 10000000, 'Pending', 1)
    `).run();

    const invoice = createInvoice(db, accounts, {
      work_order_id: 'KRY-WO-BILL1',
      milestone_id: 'MS-01',
      invoice_type: 'ADVANCE_INVOICE',
      subtotal_paise: 10000000, // ₹1,00,000.00
      gst_rate: 18.0,
      due_date: '2026-12-01',
    });

    assert.ok(invoice.id);
    assert.equal(invoice.total_paise, 11800000); // ₹1,18,000.00 (with 18% GST)
    assert.equal(invoice.status, 'Unpaid');

    // 2. Advance Gate: Advance is unpaid, so PM handoff must be blocked!
    assert.equal(isAdvanceCleared(db, 'KRY-WO-BILL1'), false);

    // 3. Record partial payment
    const partialPay = recordPayment(db, accounts, {
      invoice_id: invoice.id,
      amount_paise: 5000000, // ₹50,000.00
      payment_mode: 'NEFT_RTGS',
      reference_number: 'UTR-TEST-001',
      payment_date: '2026-11-23',
    });
    assert.equal(partialPay.invoice_status, 'Partially Paid');
    assert.equal(isAdvanceCleared(db, 'KRY-WO-BILL1'), false);

    // 4. Record remaining payment to complete advance
    const fullPay = recordPayment(db, accounts, {
      invoice_id: invoice.id,
      amount_paise: 6800000, // Remaining ₹68,000.00
      payment_mode: 'UPI',
      reference_number: 'UPI-TEST-002',
      payment_date: '2026-11-23',
    });
    assert.equal(fullPay.invoice_status, 'Paid');

    // Now advance gate is satisfied!
    assert.equal(isAdvanceCleared(db, 'KRY-WO-BILL1'), true);

    // 5. Append-only trigger verification on payments
    assert.throws(() => {
      db.prepare('UPDATE payments SET amount_paise = 999999 WHERE id = ?').run(partialPay.payment_id);
    }, /payments ledger is append-only and rows cannot be modified/);

    assert.throws(() => {
      db.prepare('DELETE FROM payments WHERE id = ?').run(partialPay.payment_id);
    }, /payments ledger is append-only and rows cannot be deleted/);
  } finally {
    ctx.cleanup();
  }
});
