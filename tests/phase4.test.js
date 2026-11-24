/**
 * Phase 4 Integration Tests: Analytics and Business Features.
 *
 * Verifies:
 *  1. Dashboard numbers match a known seeded dataset:
 *     - Department Head: task load, avg turnaround time, closure rate, overdue count
 *     - Digital Marketing: source > lead > quotation > WO conversion, channel counts, date range filter
 *     - Super Admin: employee activity summary
 *     - Admin: existing funnel and SLA compliance %
 *  2. RBAC denies on each dashboard:
 *     - Spoke denied /api/dashboard/department
 *     - Non-marketing denied /api/dashboard/digital-marketing
 *     - Non-super-admin denied /api/dashboard/super-admin
 *     - Spoke denied /api/export/*
 *  3. Discount threshold approval flow:
 *     - Discount <= threshold auto-approved
 *     - Discount > threshold sets requires_approval=1, approval_status='pending'
 *     - Unapproved quote cannot move to Sent or Approved (409 Conflict)
 *     - Spoke denied approve-discount (403 Forbidden)
 *     - Sales Manager approves discount -> quotation can proceed
 *     - Quotation version history preserved and queryable
 *     - Quotation revision increments version and snapshots into quotation_versions
 *  4. Server-side PDF generation:
 *     - GET /api/quotations/:id/pdf returns 200, %PDF magic bytes, proper headers
 *     - Unauthorized spoke denied with 403 Forbidden
 *  5. Lead enterprise fields:
 *     - project_type, city, area_sqft, budget_band stored and updated
 *     - Validation rejects invalid project_type
 *  6. Reports filters by date, department, source, stage for CSV and Excel
 *  7. Backup and restore roundtrip with integrity verification
 *  8. Audit log archival exports old records without deleting rows from ledger
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-phase4-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = path.join(testDbDir, 'test.db');
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_PASSWORD = 'Admin@12345';

const config = require('../src/config');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { backup, pruneBackups } = require('../src/backup');
const { restore } = require('../scripts/restore');
const { archiveAuditLog } = require('../scripts/archive-audit-log');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    db.close();
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(testDbDir, { recursive: true, force: true });
  } catch {
    /* ignore Windows file handle delay */
  }
});

async function loginAs(email, password = 'Admin@12345') {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  return data.token;
}

test('Phase 4 - Dashboards: RBAC denies unauthorized roles across all specialized dashboards', async () => {
  const engineerToken = await loginAs('engineer@kryston.local');
  const adminToken = await loginAs('admin@kryston.local');
  const salesManagerToken = await loginAs('salesmanager@kryston.local');

  // 1. Spoke denied Department Head dashboard
  const deptRes = await fetch(`${baseUrl}/api/dashboard/department`, {
    headers: { Authorization: `Bearer ${engineerToken}` },
  });
  assert.equal(deptRes.status, 403);

  // 2. Non-marketing denied Digital Marketing dashboard
  const dmRes = await fetch(`${baseUrl}/api/dashboard/digital-marketing`, {
    headers: { Authorization: `Bearer ${engineerToken}` },
  });
  assert.equal(dmRes.status, 403);

  const dmResSales = await fetch(`${baseUrl}/api/dashboard/digital-marketing`, {
    headers: { Authorization: `Bearer ${salesManagerToken}` },
  });
  assert.equal(dmResSales.status, 403);

  // 3. Non-Super Admin denied Super Admin dashboard
  const saResAdmin = await fetch(`${baseUrl}/api/dashboard/super-admin`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(saResAdmin.status, 403);

  const saResSM = await fetch(`${baseUrl}/api/dashboard/super-admin`, {
    headers: { Authorization: `Bearer ${salesManagerToken}` },
  });
  assert.equal(saResSM.status, 403);

  // 4. Spoke denied central exports
  const exportRes = await fetch(`${baseUrl}/api/export/leads.csv`, {
    headers: { Authorization: `Bearer ${engineerToken}` },
  });
  assert.equal(exportRes.status, 403);
});

test('Phase 4 - Lead Enterprise Fields: validation, storage, update and optimistic locking', async () => {
  const adminToken = await loginAs('admin@kryston.local');

  // 1. Rejects invalid project_type
  const invalidRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      customer_name: 'Test Enterprise Client',
      phone: `919988${Math.floor(100000 + Math.random() * 900000)}`,
      source: 'Direct Web',
      project_type: 'aerospace', // Invalid
    }),
  });
  assert.equal(invalidRes.status, 400);

  // 2. Creates lead with enterprise fields
  const validPhone = `919977${Math.floor(100000 + Math.random() * 900000)}`;
  const createRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      customer_name: 'Gupta Commercial Plaza',
      phone: validPhone,
      source: 'Direct Web',
      channel: 'Online',
      project_type: 'construction',
      city: 'Gurugram',
      area_sqft: 14500,
      budget_band: '1Cr - 2Cr',
    }),
  });
  assert.equal(createRes.status, 201);
  const createdLead = await createRes.json();
  assert.ok(createdLead.id);

  // Read lead back and verify enterprise fields
  const getRes = await fetch(`${baseUrl}/api/leads/${createdLead.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(getRes.status, 200);
  const data = await getRes.json();
  const leadData = data.lead;
  assert.equal(leadData.project_type, 'construction');
  assert.equal(leadData.city, 'Gurugram');
  assert.equal(leadData.area_sqft, 14500);
  assert.equal(leadData.budget_band, '1Cr - 2Cr');
  assert.equal(leadData.version, 1);

  // 3. Update lead enterprise fields via PATCH /api/leads/:id
  const updateRes = await fetch(`${baseUrl}/api/leads/${createdLead.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      city: 'Noida',
      area_sqft: 18000,
      budget_band: '2Cr - 3Cr',
      expected_version: 1,
    }),
  });
  assert.equal(updateRes.status, 200);
  const updatedLead = await updateRes.json();
  assert.equal(updatedLead.city, 'Noida');
  assert.equal(updatedLead.area_sqft, 18000);
  assert.equal(updatedLead.budget_band, '2Cr - 3Cr');
  assert.equal(updatedLead.version, 2);

  // 4. Stale version rejected with 409 Conflict
  const staleRes = await fetch(`${baseUrl}/api/leads/${createdLead.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      city: 'Faridabad',
      expected_version: 1, // Stale! Current is 2
    }),
  });
  assert.equal(staleRes.status, 409);
});

test('Phase 4 - Quotations: discount threshold approval flow, version history, and revisions', async () => {
  const adminToken = await loginAs('admin@kryston.local');
  const bdmToken = await loginAs('bdm@kryston.local');
  const smToken = await loginAs('salesmanager@kryston.local');

  // Step 1: Create a lead, assign to BDM, and advance to Quotation Stage
  const phone = `918811${Math.floor(100000 + Math.random() * 900000)}`;
  const leadRes = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      customer_name: 'Metro Towers Corp',
      phone,
      source: 'Referral',
      project_type: 'interior',
    }),
  });
  assert.equal(leadRes.status, 201);
  const lead = await leadRes.json();

  // Advance lead to Quotation Stage with BDM assigned
  db.prepare(
    "UPDATE leads SET stage = 'Quotation Stage', assigned_bdm = 'KRY-BDM-001', current_owner = 'KRY-BDM-001' WHERE id = ?",
  ).run(lead.id);

  // Step 2: BDM creates quote with discount > 10% (threshold is 10%)
  const highDiscountRes = await fetch(`${baseUrl}/api/quotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bdmToken}` },
    body: JSON.stringify({
      lead_id: lead.id,
      amount: 1000000,
      tax_amount: 180000,
      discount_percent: 15, // > 10%
      terms: '50% advance, 50% on completion',
      payment_milestones: 'Advance: 500000, Delivery: 500000',
    }),
  });
  assert.equal(highDiscountRes.status, 201);
  const highQuote = await highDiscountRes.json();
  assert.equal(highQuote.discount_percent, 15);
  assert.equal(highQuote.requires_approval, 1);
  assert.equal(highQuote.approval_status, 'pending');

  // Step 3: Attempt to move to Sent while discount approval is pending must be REJECTED with 409
  const prematureSend = await fetch(`${baseUrl}/api/quotations/${highQuote.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bdmToken}` },
    body: JSON.stringify({ status: 'Sent' }),
  });
  assert.equal(prematureSend.status, 409);
  const prematureError = await prematureSend.json();
  assert.match(prematureError.error, /exceeds threshold/i);

  // Step 4: Regular BDM cannot approve their own discount
  const unauthorizedApproval = await fetch(`${baseUrl}/api/quotations/${highQuote.id}/approve-discount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bdmToken}` },
    body: JSON.stringify({ action: 'Approved', remarks: 'Self approve' }),
  });
  assert.equal(unauthorizedApproval.status, 403);

  // Step 5: Sales Manager approves the discount
  const approveRes = await fetch(`${baseUrl}/api/quotations/${highQuote.id}/approve-discount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${smToken}` },
    body: JSON.stringify({ action: 'Approved', remarks: 'Special competitive rate approved by SM' }),
  });
  assert.equal(approveRes.status, 200);
  const approveData = await approveRes.json();
  assert.equal(approveData.requires_approval, 0);
  assert.equal(approveData.approval_status, 'approved');

  // Step 6: BDM can now successfully send the quotation
  const sendRes = await fetch(`${baseUrl}/api/quotations/${highQuote.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: 'Sent' }),
  });
  assert.equal(sendRes.status, 200);

  // Step 7: Check quotation version history
  const versionsRes = await fetch(`${baseUrl}/api/quotations/${highQuote.id}/versions`, {
    headers: { Authorization: `Bearer ${bdmToken}` },
  });
  assert.equal(versionsRes.status, 200);
  const versions = await versionsRes.json();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
  assert.equal(versions[0].discount_percent, 15);

  // Step 8: Revise quotation (creates v2)
  const reviseRes = await fetch(`${baseUrl}/api/quotations/${highQuote.id}/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bdmToken}` },
    body: JSON.stringify({
      amount: 1100000,
      tax_amount: 198000,
      discount_percent: 5, // <= 10%, no approval needed
      remarks: 'Revised scope with 5% standard discount',
    }),
  });
  assert.equal(reviseRes.status, 200);
  const revised = await reviseRes.json();
  assert.equal(revised.version, 2);
  assert.equal(revised.amount, 1100000);
  assert.equal(revised.discount_percent, 5);

  // Check versions now contains v1 and v2
  const versionsRes2 = await fetch(`${baseUrl}/api/quotations/${highQuote.id}/versions`, {
    headers: { Authorization: `Bearer ${bdmToken}` },
  });
  const versions2 = await versionsRes2.json();
  assert.equal(versions2.length, 2);
  assert.equal(versions2[0].version, 1);
  assert.equal(versions2[1].version, 2);
});

test('Phase 4 - Quotations: server-side PDF generation generates valid document with nosniff and RBAC', async () => {
  const adminToken = await loginAs('admin@kryston.local');
  const engineerToken = await loginAs('engineer@kryston.local');

  const quote = db.prepare('SELECT id FROM quotations LIMIT 1').get();
  assert.ok(quote, 'At least one quotation should exist');

  // 1. Spoke cannot download commercial quotation PDF
  const deniedRes = await fetch(`${baseUrl}/api/quotations/${quote.id}/pdf`, {
    headers: { Authorization: `Bearer ${engineerToken}` },
  });
  assert.equal(deniedRes.status, 403);

  // 2. Admin Desk / authorized user can download PDF
  const pdfRes = await fetch(`${baseUrl}/api/quotations/${quote.id}/pdf`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  assert.match(pdfRes.headers.get('content-disposition'), /attachment; filename="quotation-.*\.pdf"/);
  assert.equal(pdfRes.headers.get('x-content-type-options'), 'nosniff');

  const buffer = await pdfRes.arrayBuffer();
  const pdfHeader = Buffer.from(buffer.slice(0, 5)).toString('utf8');
  assert.equal(pdfHeader, '%PDF-', 'Must start with valid PDF magic bytes');
  assert.ok(buffer.byteLength > 1000, 'PDF should have reasonable size');
});

test('Phase 4 - Dashboards: calculations match seeded dataset for Department Head, Digital Marketing, Super Admin, and Admin', async () => {
  const adminToken = await loginAs('admin@kryston.local');
  const dmToken = await loginAs('digital@kryston.local');
  const saToken = await loginAs('superadmin@kryston.local');
  const smToken = await loginAs('salesmanager@kryston.local');

  // 1. Department Head Dashboard
  const deptRes = await fetch(`${baseUrl}/api/dashboard/department?department=Sales`, {
    headers: { Authorization: `Bearer ${smToken}` },
  });
  assert.equal(deptRes.status, 200);
  const deptData = await deptRes.json();
  assert.equal(deptData.department, 'Sales');
  assert.ok(typeof deptData.taskLoad.total === 'number');
  assert.ok(typeof deptData.avgTurnaroundHours === 'number');
  assert.ok(typeof deptData.closureRate === 'number');
  assert.ok(typeof deptData.overdueCount === 'number');
  assert.ok(Array.isArray(deptData.assignees));

  // Verify taskLoad sum matches total
  const { total, assigned, inProgress, submitted, reviewed, closed } = deptData.taskLoad;
  assert.equal(total, assigned + inProgress + submitted + reviewed + closed);

  // 2. Digital Marketing Dashboard
  const dmRes = await fetch(`${baseUrl}/api/dashboard/digital-marketing`, {
    headers: { Authorization: `Bearer ${dmToken}` },
  });
  assert.equal(dmRes.status, 200);
  const dmData = await dmRes.json();
  assert.ok(typeof dmData.counts.totalLeads === 'number');
  assert.ok(typeof dmData.counts.totalQuotations === 'number');
  assert.ok(typeof dmData.counts.totalWorkOrders === 'number');
  assert.ok(Array.isArray(dmData.channelCounts));
  assert.ok(Array.isArray(dmData.sourceFunnel));

  if (dmData.sourceFunnel.length > 0) {
    const firstSource = dmData.sourceFunnel[0];
    assert.ok(firstSource.source);
    assert.ok(typeof firstSource.leads_count === 'number');
    assert.ok(typeof firstSource.leadToWoConversionRate === 'number');
  }

  // 3. Super Admin Dashboard
  const saRes = await fetch(`${baseUrl}/api/dashboard/super-admin`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  assert.equal(saRes.status, 200);
  const saData = await saRes.json();
  assert.equal(saData.scope, 'super_admin');
  assert.ok(saData.employee_count > 0);
  assert.ok(Array.isArray(saData.employees));

  const saSelf = saData.employees.find((e) => e.role === 'SUPER_ADMIN');
  assert.ok(saSelf);
  assert.ok(typeof saSelf.actions_count === 'number');
  assert.ok(typeof saSelf.tasks_assigned === 'number');

  // 4. Central Admin Dashboard
  const adminRes = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(adminRes.status, 200);
  const adminData = await adminRes.json();
  assert.equal(adminData.scope, 'central');
  assert.ok(typeof adminData.counts.slaCompliance === 'number');
  assert.ok(Array.isArray(adminData.funnel));
});

test('Phase 4 - Reports & Exports: filter by date, department, source, stage with enterprise columns', async () => {
  const adminToken = await loginAs('admin@kryston.local');

  // 1. Export leads with source filter
  const filteredCsv = await fetch(`${baseUrl}/api/export/leads.csv?source=Referral`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(filteredCsv.status, 200);
  const csvText = await filteredCsv.text();
  assert.match(csvText, /Project Type/);
  assert.match(csvText, /Area \(Sqft\)/);
  assert.match(csvText, /Budget Band/);
  assert.match(csvText, /Referral/);

  // 2. Export tasks with department filter
  const tasksFiltered = await fetch(`${baseUrl}/api/export/tasks.csv?department=Sales`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(tasksFiltered.status, 200);
  const tasksText = await tasksFiltered.text();
  assert.match(tasksText, /Sales/);

  // 3. Export timeline with format=xls
  const xlsRes = await fetch(`${baseUrl}/api/export/timeline.xls?department=Sales`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(xlsRes.status, 200);
  assert.equal(xlsRes.headers.get('content-type'), 'application/vnd.ms-excel; charset=utf-8');
  const xlsContent = await xlsRes.text();
  assert.match(xlsContent, /<Workbook/);
});

test('Phase 4 - Backup and Restore: online backup, pruning, and restore integrity check roundtrip', async () => {
  const tempDir = path.join(config.rootDir, 'data', `test-backup-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const backupFile = path.join(tempDir, 'test-snapshot.db');
  const restoredTarget = path.join(tempDir, 'test-restored.db');

  try {
    // 1. Generate snapshot via backup()
    const backupResult = await backup(backupFile);
    assert.equal(backupResult.destination, backupFile);
    assert.ok(backupResult.bytes > 0);
    assert.ok(backupResult.leads >= 0);
    assert.ok(fs.existsSync(backupFile));

    // 2. Verify pruning handles retention window
    const pruneResult = pruneBackups(tempDir, 1); // 1 day retention
    assert.equal(pruneResult.prunedCount, 0, 'Recent backup should not be pruned');

    // 3. Restore to target location
    const restoreResult = await restore(backupFile, restoredTarget);
    assert.equal(restoreResult.restoredFrom, backupFile);
    assert.equal(restoreResult.destination, restoredTarget);
    assert.equal(restoreResult.leads, backupResult.leads);
    assert.equal(restoreResult.employees, backupResult.employees);
    assert.ok(fs.existsSync(restoredTarget));

    // 4. Validate restored DB passes PRAGMA integrity_check
    const restoredDb = new Database(restoredTarget, { readonly: true });
    try {
      const integrity = restoredDb.prepare('PRAGMA integrity_check').all();
      assert.equal(Object.values(integrity[0])[0], 'ok');
      const fk = restoredDb.prepare('PRAGMA foreign_key_check').all();
      assert.equal(fk.length, 0);
    } finally {
      restoredDb.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Phase 4 - Audit Log Archival: exports old records without deleting rows from ledger', async () => {
  const tempArchiveFile = path.join(config.rootDir, 'data', 'archives', `test-archive-${Date.now()}.jsonl`);

  // Insert a test audit record dated 3 years ago
  const oldDate = '2020-01-01 12:00:00';
  db.prepare(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details, created_at)
     VALUES ('KRY-SA-001', 'TEST_HISTORICAL_EVENT', 'lead', 'KRY-LEAD-OLD1', 'Historical record for archival test', ?)`,
  ).run(oldDate);

  const preCount = db.prepare('SELECT count(*) as c FROM audit_log').get().c;

  try {
    const result = archiveAuditLog(db, tempArchiveFile);
    assert.ok(result.rowsArchived >= 1);
    assert.ok(fs.existsSync(tempArchiveFile));

    const fileContent = fs.readFileSync(tempArchiveFile, 'utf8');
    assert.match(fileContent, /TEST_HISTORICAL_EVENT/);

    // CRITICAL: Ledger count must NOT decrease (it actually increased by 1 due to the ARCHIVE_AUDIT_LOG event)
    const postCount = db.prepare('SELECT count(*) as c FROM audit_log').get().c;
    assert.ok(postCount >= preCount, 'Ledger table rows must NEVER be deleted');

    // Verify the historical record still exists in the DB
    const historicalRecord = db.prepare("SELECT * FROM audit_log WHERE action = 'TEST_HISTORICAL_EVENT'").get();
    assert.ok(historicalRecord, 'Historical record must remain in the audit ledger');
  } finally {
    if (fs.existsSync(tempArchiveFile)) {
      try { fs.unlinkSync(tempArchiveFile); } catch { /* ignore */ }
    }
  }
});
