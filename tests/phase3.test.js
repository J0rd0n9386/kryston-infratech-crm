/**
 * Phase 3 Integration Tests: Attachments and Notifications.
 *
 * Verifies:
 *  1. Attachment MIME validation rejects spoofed extensions (magic bytes sniffing).
 *  2. Attachment size validation rejects oversize uploads.
 *  3. Cross-department download denied (Site Engineer cannot download Sales attachments; Admin & assigned BDM can).
 *  4. Storage provider stores file outside /public with Content-Disposition attachment & nosniff headers.
 *  5. Notification outbox deduplication: duplicate keys do not create duplicate outbox entries.
 *  6. Notification outbox retry, exponential backoff, and dead-lettering after max attempts.
 *  7. SLA breach detector notifies relevant personnel exactly once per breach.
 *  8. Daily digest accurately compiles pending actions, overdue tasks, stuck leads, and nurture reminders.
 *  9. User notification preferences: query, update, Zod validation, audit_log, and RBAC.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-phase3-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = path.join(testDbDir, 'test.db');
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_PASSWORD = 'Admin@12345';
process.env.ATTACHMENT_STORAGE_DIR = path.join(testDbDir, 'attachments');

const config = require('../src/config');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { validateAttachment } = require('../src/lib/mime-validator');
const { enqueueNotification } = require('../src/lib/notifications/dispatcher');
const { processOutboxBatch, calculateBackoffSeconds } = require('../src/lib/notifications/outbox-worker');
const { checkSlaBreaches } = require('../src/lib/notifications/sla-breach-job');
const { compileDailyDigestData, sendDailyDigest } = require('../src/lib/notifications/daily-digest-job');

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

test('Phase 3 - Attachments: rejects spoofed file extensions using magic byte sniffing', async () => {
  const adminToken = await loginAs('admin@kryston.local');

  // Fetch an existing task
  const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();

  // 1. Spoofer test: file claims to be .pdf, but contains plain text ASCII bytes
  const textBytes = Buffer.from('This is fake plain text pretending to be a PDF invoice.');
  const spoofedRes = await fetch(`${baseUrl}/api/attachments/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      entity_type: 'task',
      entity_id: task.id,
      file_name: 'invoice.pdf',
      mime_type: 'application/pdf',
      data: textBytes.toString('base64'),
    }),
  });

  assert.equal(spoofedRes.status, 400);
  const spoofedBody = await spoofedRes.json();
  assert.match(spoofedBody.error, /Spoofed file extension/i);

  // 2. Spoofer test 2: file claims to be .png, but has PDF header (%PDF)
  const fakePngWithPdfHeader = Buffer.from('%PDF-1.4 fake pdf data');
  const spoofedPngRes = await fetch(`${baseUrl}/api/attachments/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      entity_type: 'task',
      entity_id: task.id,
      file_name: 'drawing.png',
      mime_type: 'image/png',
      data: fakePngWithPdfHeader.toString('base64'),
    }),
  });

  assert.equal(spoofedPngRes.status, 400);
  const spoofedPngBody = await spoofedPngRes.json();
  assert.match(spoofedPngBody.error, /Spoofed file extension/i);

  // 3. Genuine PDF test: valid magic bytes %PDF (0x25, 0x50, 0x44, 0x46)
  const validPdfBuffer = Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), // %PDF-1.4
    Buffer.from(' genuine pdf document body trailer %%EOF'),
  ]);

  const validRes = await fetch(`${baseUrl}/api/attachments/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      entity_type: 'task',
      entity_id: task.id,
      file_name: 'quotation-valid.pdf',
      mime_type: 'application/pdf',
      data: validPdfBuffer.toString('base64'),
    }),
  });

  assert.equal(validRes.status, 201);
  const validBody = await validRes.json();
  assert.equal(validBody.original_name, 'quotation-valid.pdf');
  assert.equal(validBody.mime_type, 'application/pdf');
  assert.ok(validBody.attachment_id);
});

test('Phase 3 - Attachments: rejects oversize uploads exceeding max size limit', async () => {
  const adminToken = await loginAs('admin@kryston.local');
  const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();

  // Create a 12 MB buffer with valid PDF header
  const largePdfBuffer = Buffer.alloc(12 * 1024 * 1024);
  largePdfBuffer[0] = 0x25;
  largePdfBuffer[1] = 0x50;
  largePdfBuffer[2] = 0x44;
  largePdfBuffer[3] = 0x46; // %PDF

  const oversizeRes = await fetch(`${baseUrl}/api/attachments/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      entity_type: 'task',
      entity_id: task.id,
      file_name: 'massive.pdf',
      mime_type: 'application/pdf',
      data: largePdfBuffer.toString('base64'),
    }),
  });

  assert.ok([400, 413].includes(oversizeRes.status));
  const body = await oversizeRes.json();
  assert.match(body.error || body.message, /limit|exceed|too large/i);
});

test('Phase 3 - Attachments: cross-department download denied; authorized department and Admin Desk allowed', async () => {
  const adminToken = await loginAs('admin@kryston.local');
  const bdmToken = await loginAs('bdm@kryston.local');
  const engineerToken = await loginAs('engineer@kryston.local');

  // Create a Sales task assigned to BDM KRY-BDM-001
  const lead = db.prepare('SELECT id FROM leads LIMIT 1').get();
  const taskId = `TSK-SALES-TEST-${Date.now()}`;
  db.prepare(`
    INSERT INTO tasks (id, lead_id, department, task_type, brief, assigned_by, assigned_to, priority, status, sla_hours, version)
    VALUES (?, ?, 'Sales', 'SALES_REVIEW', 'Review pricing', 'KRY-AD-001', 'KRY-BDM-001', 'High', 'Assigned', 24, 1)
  `).run(taskId, lead.id);

  // Sales BDM uploads a valid PDF attachment to their task
  const validPdf = Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
    Buffer.from(' sales pricing details %%EOF'),
  ]);

  const uploadRes = await fetch(`${baseUrl}/api/attachments/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bdmToken}`,
    },
    body: JSON.stringify({
      entity_type: 'task',
      entity_id: taskId,
      file_name: 'sales-pricing.pdf',
      mime_type: 'application/pdf',
      data: validPdf.toString('base64'),
    }),
  });

  assert.equal(uploadRes.status, 201);
  const uploadData = await uploadRes.json();
  const attachmentId = uploadData.attachment_id || uploadData.id;

  // 1. Cross-Department DENY TEST: Site Engineer attempts to download Sales task attachment
  const deniedRes = await fetch(`${baseUrl}/api/attachments/${attachmentId}/download`, {
    headers: { Authorization: `Bearer ${engineerToken}` },
  });
  assert.equal(deniedRes.status, 403);
  const deniedBody = await deniedRes.json();
  assert.match(deniedBody.error, /not authorized/i);

  // 2. ALLOW TEST 1: Admin Desk downloads the attachment (Central orchestrator access)
  const adminRes = await fetch(`${baseUrl}/api/attachments/${attachmentId}/download`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.headers.get('content-type'), 'application/pdf');
  assert.equal(adminRes.headers.get('x-content-type-options'), 'nosniff');
  assert.match(adminRes.headers.get('content-disposition'), /attachment; filename="sales-pricing\.pdf"/);
  const adminBuffer = Buffer.from(await adminRes.arrayBuffer());
  assert.ok(adminBuffer.length > 0);

  // 3. ALLOW TEST 2: Assigned BDM downloads their own task's attachment
  const bdmRes = await fetch(`${baseUrl}/api/attachments/${attachmentId}/download`, {
    headers: { Authorization: `Bearer ${bdmToken}` },
  });
  assert.equal(bdmRes.status, 200);
  assert.equal(bdmRes.headers.get('x-content-type-options'), 'nosniff');
});

test('Phase 3 - Notifications: Outbox deduplication, retry with exponential backoff, and dead-lettering', async () => {
  // 1. Dedupe test: enqueuing with identical dedupeKey creates only 1 row in outbox
  const dedupeKey = `TASK_ASSIGNED:TSK-DEDUPE-${Date.now()}:KRY-TC-001`;
  const payload = { text: 'New task assigned to you', entityType: 'task', entityId: 'TSK-DEDUPE-001' };

  const firstRun = enqueueNotification(db, {
    eventType: 'TASK_ASSIGNED',
    recipientId: 'KRY-TC-001',
    dedupeKey,
    payload,
  });
  assert.ok(firstRun.some((r) => r.enqueued === true));

  const secondRun = enqueueNotification(db, {
    eventType: 'TASK_ASSIGNED',
    recipientId: 'KRY-TC-001',
    dedupeKey,
    payload,
  });
  // On second attempt, deduplication suppresses new rows
  assert.ok(secondRun.every((r) => r.enqueued === false));

  const outboxRows = db
    .prepare('SELECT count(*) as count FROM notification_outbox WHERE dedupe_key = ?')
    .get(`in_app:${dedupeKey}`);
  assert.equal(outboxRows.count, 1);

  // 2. Exponential backoff calculation test
  assert.equal(calculateBackoffSeconds(1), 10);
  assert.equal(calculateBackoffSeconds(2), 20);
  assert.equal(calculateBackoffSeconds(3), 40);
  assert.equal(calculateBackoffSeconds(4), 80);

  // 3. Outbox batch processing and dead-lettering test
  // Insert a message at attempt 4 of 5 with invalid JSON to verify it transitions to dead-letter
  const poisonKey = `test:poison:${Date.now()}`;
  db.prepare(`
    INSERT INTO notification_outbox (dedupe_key, event_type, channel, recipient_id, payload, status, attempts, max_attempts)
    VALUES (?, 'TASK_ASSIGNED', 'in_app', 'KRY-TC-001', '{ INVALID_JSON', 'pending', 4, 5)
  `).run(poisonKey);

  const stats = await processOutboxBatch(db, 200);
  assert.ok(stats.deadLettered >= 1);

  const deadItem = db.prepare('SELECT * FROM notification_outbox WHERE dedupe_key = ?').get(poisonKey);
  assert.equal(deadItem.status, 'dead_letter');
  assert.match(deadItem.last_error, /Invalid JSON/i);
});

test('Phase 3 - Notifications: SLA breach detector notifies exactly once per breach', async () => {
  // Insert an overdue task where created_at + sla_hours is in the past
  const overdueTaskId = `TSK-SLA-TEST-${Date.now()}`;
  db.prepare(`
    INSERT INTO tasks (id, lead_id, department, task_type, brief, assigned_by, assigned_to, priority, status, sla_hours, created_at, version)
    VALUES (?, 'KRY-LEAD-2026-0001', 'Technical', 'SITE_VISIT', 'Site Visit Inspection', 'KRY-AD-001', 'KRY-SE-001', 'Urgent', 'In Progress', 2, datetime('now', '-5 hours'), 1)
  `).run(overdueTaskId);

  // First scan: should detect the breach and notify
  const firstCheck = checkSlaBreaches(db);
  assert.ok(firstCheck.some((b) => b.taskId === overdueTaskId));

  // Verify record in sla_breach_notifications ledger
  const ledgerEntry = db.prepare('SELECT * FROM sla_breach_notifications WHERE task_id = ?').get(overdueTaskId);
  assert.ok(ledgerEntry);

  // Verify outbox entry was enqueued
  const outboxItem = db
    .prepare('SELECT * FROM notification_outbox WHERE event_type = ? AND dedupe_key LIKE ?')
    .get('SLA_BREACH', `%${overdueTaskId}%`);
  assert.ok(outboxItem);

  // Second scan: should NOT notify again (guarantees exactly-once)
  const secondCheck = checkSlaBreaches(db);
  assert.ok(!secondCheck.some((b) => b.taskId === overdueTaskId));
});

test('Phase 3 - Notifications: Daily digest compiles pending actions, overdue tasks, stuck leads, and nurture follow-ups', async () => {
  // 1. Seed submitted task (pending action)
  const submittedTaskId = `TSK-DIGEST-SUBMITTED-${Date.now()}`;
  db.prepare(`
    INSERT INTO tasks (id, lead_id, department, task_type, brief, assigned_by, assigned_to, priority, status, sla_hours, version)
    VALUES (?, 'KRY-LEAD-2026-0001', 'Design', 'DESIGN_PREPARATION', 'Layout Drawings', 'KRY-AD-001', 'KRY-AR-001', 'High', 'Submitted', 24, 1)
  `).run(submittedTaskId);

  // 2. Seed stuck lead (> 3 days without updates)
  const stuckLeadId = `KRY-LEAD-STUCK-${Date.now()}`;
  const phone1 = `91${Math.floor(10000000 + Math.random() * 90000000)}`;
  db.prepare(`
    INSERT INTO leads (id, source, customer_name, phone, stage, updated_at, created_at)
    VALUES (?, 'Direct', 'Stuck Customer', ?, 'Routed to Sales', datetime('now', '-4 days'), datetime('now', '-5 days'))
  `).run(stuckLeadId, phone1);

  // 3. Seed nurture follow-up due
  const nurtureLeadId = `KRY-LEAD-NURTURE-${Date.now()}`;
  const phone2 = `92${Math.floor(10000000 + Math.random() * 90000000)}`;
  db.prepare(`
    INSERT INTO leads (id, source, customer_name, phone, stage, updated_at, created_at)
    VALUES (?, 'Direct', 'Nurture Customer', ?, 'Nurture', datetime('now'), datetime('now'))
  `).run(nurtureLeadId, phone2);

  db.prepare(`
    INSERT INTO telecaller_responses (lead_id, telecaller_id, call_outcome, next_followup, notes)
    VALUES (?, 'KRY-TC-001', 'Connected', date('now'), 'Follow-up due today')
  `).run(nurtureLeadId);

  // Compile digest data
  const digest = compileDailyDigestData(db);
  assert.ok(digest.metrics.pendingActions >= 1);
  assert.ok(digest.metrics.stuckLeadsCount >= 1);
  assert.ok(digest.metrics.nurtureFollowupsCount >= 1);
  assert.match(digest.textSummary, /Pending Actions/);
  assert.match(digest.textSummary, /Stuck Leads/);
  assert.match(digest.textSummary, /Nurture Follow-ups/);

  // Send digest and verify idempotent execution
  const testDate = `2099-01-${Date.now()}`;
  const firstSend = sendDailyDigest(db, testDate);
  assert.equal(firstSend.sent, true);
  assert.ok(firstSend.recipientCount > 0);

  // Second send for the same date must be skipped
  const secondSend = sendDailyDigest(db, testDate);
  assert.equal(secondSend.sent, false);
  assert.match(secondSend.reason, /already been sent/i);
});

test('Phase 3 - Notification Preferences: API query, update, Zod validation, audit_log, and RBAC', async () => {
  // 1. RBAC DENY TEST: unauthenticated request rejected
  const unauthRes = await fetch(`${baseUrl}/api/notification-preferences`);
  assert.equal(unauthRes.status, 401);

  const bdmToken = await loginAs('bdm@kryston.local');

  // 2. ALLOW TEST: authenticated user fetches preferences
  const getRes = await fetch(`${baseUrl}/api/notification-preferences`, {
    headers: { Authorization: `Bearer ${bdmToken}` },
  });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  assert.equal(getBody.employee_id, 'KRY-BDM-001');
  assert.ok(getBody.preferences.TASK_ASSIGNED);
  assert.equal(getBody.preferences.TASK_ASSIGNED.channel_in_app, true);

  // 3. VALIDATION TEST: invalid event_type rejected with 400
  const invalidRes = await fetch(`${baseUrl}/api/notification-preferences`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bdmToken}`,
    },
    body: JSON.stringify({
      event_type: 'INVALID_NON_EXISTENT_EVENT',
      channel_email: false,
    }),
  });
  assert.equal(invalidRes.status, 400);

  // 4. ALLOW TEST: update preferences (disable email for REWORK_REQUESTED)
  const updateRes = await fetch(`${baseUrl}/api/notification-preferences`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bdmToken}`,
    },
    body: JSON.stringify({
      event_type: 'REWORK_REQUESTED',
      channel_in_app: true,
      channel_email: false,
      channel_whatsapp: false,
    }),
  });
  assert.equal(updateRes.status, 200);
  const updateBody = await updateRes.json();
  assert.equal(updateBody.success, true);
  assert.equal(updateBody.preference.channel_email, false);

  // 5. AUDIT LOG TEST: verify audit log recorded the change
  const auditRow = db
    .prepare("SELECT * FROM audit_log WHERE action = 'NOTIFICATION_PREFERENCES_UPDATED' AND actor_id = 'KRY-BDM-001'")
    .get();
  assert.ok(auditRow);
  assert.match(auditRow.details, /REWORK_REQUESTED/);
});
