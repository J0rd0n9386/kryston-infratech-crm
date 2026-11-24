/**
 * Phase P6 Handover, Snags and Warranty Tests.
 */
'use strict';

require('./helpers/environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const {
  verifyHandoverPrerequisites,
  createSnag,
  resolveSnag,
  approveSnag,
  issueWarranty,
} = require('../src/lib/services/handover-service');

function createTestContext() {
  const tmpDir = path.join(__dirname, '..', 'data', `test-handover-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      ('EMP-PM', 'Project Manager', 'pm@kryston.in', 'PROJECT_MANAGER', 'Projects', 'hash', 1),
      ('EMP-ENG', 'Site Engineer', 'eng@kryston.in', 'SITE_ENGINEER', 'Technical', 'hash', 1)
  `).run();

  return {
    db,
    cleanup() {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('P6 Handover, Snag List, Gate Check and Warranty Lifecycle', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;

    // 1. Setup active lead, quotation, work order and project
    db.prepare(`
      INSERT INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by)
      VALUES ('KRY-LEAD-HO1', 'Offline', 'Walk-in', 'Handover Client', '+91 99887 76655', 'In Progress', 'EMP-PM', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO quotations (id, lead_id, version, amount, status, created_by)
      VALUES ('KRY-QUOT-HO1', 'KRY-LEAD-HO1', 1, 500000, 'Approved', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO work_orders (id, lead_id, quotation_id, amount, customer_approval_date, status, created_by)
      VALUES ('KRY-WO-HO1', 'KRY-LEAD-HO1', 'KRY-QUOT-HO1', 500000, '2026-11-20', 'Finalized', 'EMP-ADMIN')
    `).run();

    db.prepare(`
      INSERT INTO projects (id, work_order_id, lead_id, project_manager, site_engineer, status, target_completion, start_date)
      VALUES ('KRY-PROJ-HO1', 'KRY-WO-HO1', 'KRY-LEAD-HO1', 'EMP-PM', 'EMP-ENG', 'In Progress', '2027-02-01', '2026-11-20')
    `).run();

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get('KRY-PROJ-HO1');

    // 2. Log a snag item
    const snag = createSnag(db, {
      projectId: project.id,
      description: 'Minor paint peeling in master bedroom ceiling',
      location: 'Master Bedroom',
      priority: 'Medium',
      createdBy: 'EMP-PM',
    });
    assert.ok(snag.id.startsWith('KRY-SNAG-'));
    assert.equal(snag.status, 'Open');

    // 3. Handover Gate: Attempting handover should fail because snag is Open
    assert.throws(() => {
      verifyHandoverPrerequisites(db, project);
    }, /unapproved snag item\(s\) remain/i);

    // 4. Resolve snag
    const resolvedSnag = resolveSnag(db, {
      snagId: snag.id,
      resolvedBy: 'EMP-ENG',
      notes: 'Repainted ceiling and touched up primer.',
    });
    assert.equal(resolvedSnag.status, 'Resolved');

    // Handover Gate: Still fails because snag is Resolved but NOT Approved by Admin
    assert.throws(() => {
      verifyHandoverPrerequisites(db, project);
    }, /unapproved snag item\(s\) remain/i);

    // 5. Admin approves snag
    const approvedSnag = approveSnag(db, {
      snagId: snag.id,
      approvedBy: 'EMP-ADMIN',
    });
    assert.equal(approvedSnag.status, 'Approved');

    // 6. Add unpaid invoice to test billing gate
    db.prepare(`
      INSERT INTO invoices (id, work_order_id, invoice_number, subtotal_paise, total_paise, due_date, status)
      VALUES ('KRY-INV-HO1', 'KRY-WO-HO1', 'INV-2026-0001', 50000000, 50000000, '2027-01-01', 'Unpaid')
    `).run();

    // Handover Gate: Fails because unpaid invoice exists
    assert.throws(() => {
      verifyHandoverPrerequisites(db, project);
    }, /unpaid invoice\(s\) remain/i);

    // Super Admin can waive unpaid invoice with override
    const superAdmin = { id: 'EMP-SUPER', role: 'SUPER_ADMIN' };
    const waived = verifyHandoverPrerequisites(db, project, {
      override_billing: true,
      user: superAdmin,
    });
    assert.equal(waived.ok, true);

    // Mark invoice as Paid
    db.prepare("UPDATE invoices SET status = 'Paid' WHERE id = 'KRY-INV-HO1'").run();

    // Normal verification passes now without waiver
    const passed = verifyHandoverPrerequisites(db, project);
    assert.equal(passed.ok, true);

    // 7. Issue Warranty Certificate
    const warranty = issueWarranty(db, {
      projectId: project.id,
      scope: 'Waterproofing & Structural Works',
      startDate: '2026-11-23',
      endDate: '2031-11-23',
      terms: '5-year comprehensive coverage on structural seepage',
      createdBy: 'EMP-ADMIN',
    });
    assert.ok(warranty.id.startsWith('KRY-WAR-'));
    assert.equal(warranty.status, 'Active');
    assert.ok(warranty.certificate_number.startsWith('CERT-KRY-WAR-'));

    // 8. File warranty claim
    db.prepare(`
      INSERT INTO warranty_claims (id, warranty_id, project_id, issue_description, status)
      VALUES ('KRY-CLM-01', ?, ?, 'Water seepage reported near terrace joint.', 'Open')
    `).run(warranty.id, project.id);

    db.prepare("UPDATE warranties SET status = 'Claimed' WHERE id = ?").run(warranty.id);

    const updatedWar = db.prepare('SELECT status FROM warranties WHERE id = ?').get(warranty.id);
    assert.equal(updatedWar.status, 'Claimed');

    // 9. Referral request record
    db.prepare(`
      INSERT INTO referral_requests (id, project_id, lead_id, customer_rating, feedback, referral_draft, status)
      VALUES ('KRY-REF-01', ?, ?, 5, 'Great work', 'Thank you for choosing Kryston!', 'Sent')
    `).run(project.id, project.lead_id);

    const ref = db.prepare('SELECT * FROM referral_requests WHERE id = ?').get('KRY-REF-01');
    assert.equal(ref.status, 'Sent');
    assert.equal(ref.customer_rating, 5);
  } finally {
    ctx.cleanup();
  }
});
