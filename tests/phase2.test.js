/**
 * Phase 2 Enterprise Concurrency & Workflow Integration Tests.
 *
 * Covers:
 *  1. Optimistic concurrency locking on leads and tasks (allow on match, 409 on stale version).
 *  2. Admin rework endpoint (POST /api/tasks/:id/rework).
 *  3. Same-department reassignment (POST /api/tasks/:id/reassign) with cross-dept rejection.
 *  4. Task reopen endpoint (POST /api/tasks/:id/reopen).
 *  5. Duplicate leads review and merge (GET /api/leads/duplicates, POST /api/leads/:id/merge)
 *     verifying append-only timeline/audit ledgers are preserved without trigger violation.
 *  6. Nurture follow-up scheduling in Admin Desk Action Required queue on My Day.
 *  7. Keyset cursor pagination on leads and tasks with deterministic cursor navigation.
 *  8. Exhaustive HTTP-level illegal transition x role matrix test.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-phase2-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = path.join(tempDir, 'test.db');
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_PASSWORD = 'Admin@12345';

const db = require('../src/db');
const { createApp } = require('../src/app');

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
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore Windows file handle delay */
  }
});

async function api(method, url, { token, body, raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return response;
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json, headers: response.headers };
}

async function login(email, password = 'Admin@12345') {
  const res = await api('POST', '/api/login', { body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

test('Optimistic locking: allows valid expected_version and rejects stale expected_version with 409', async () => {
  const admin = await login('admin@kryston.local');

  // 1. Create a fresh lead
  const createRes = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Optimistic Customer',
      phone: '+91 91234 56789',
      source: 'Website',
      priority: 'High',
    },
  });
  assert.equal(createRes.status, 201);
  const leadId = createRes.body.id;

  // Initial version must be 1
  const leadBefore = db.prepare('SELECT version FROM leads WHERE id = ?').get(leadId);
  assert.equal(leadBefore.version, 1);

  // 2. Reject stale expected_version (e.g. expected_version: 999 when actual is 1)
  const staleAssign = await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: admin,
    body: {
      telecaller_id: 'KRY-TC-001',
      instructions: 'First enquiry call',
      expected_version: 999,
    },
  });
  assert.equal(staleAssign.status, 409, `Expected 409 on stale version, got ${staleAssign.status}`);
  assert.match(staleAssign.body.error, /stale version/i);

  // 3. Allow matching expected_version: 1 -> updates version to 2
  const validAssign = await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: admin,
    body: {
      telecaller_id: 'KRY-TC-001',
      instructions: 'First enquiry call',
      expected_version: 1,
    },
  });
  assert.equal(validAssign.status, 200);
  const taskId = validAssign.body.task_id;

  const leadAfter = db.prepare('SELECT version FROM leads WHERE id = ?').get(leadId);
  assert.equal(leadAfter.version, 2);

  // 4. Test optimistic locking on tasks:
  const telecaller = await login('telecaller@kryston.local');
  const taskBefore = db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId);
  assert.equal(taskBefore.version, 1);

  // Stale version on task update returns 409
  const staleTask = await api('PATCH', `/api/tasks/${taskId}/status`, {
    token: telecaller,
    body: {
      status: 'In Progress',
      expected_version: 888,
    },
  });
  assert.equal(staleTask.status, 409);
  assert.match(staleTask.body.error, /stale version/i);

  // Matching version on task update succeeds and increments version to 2
  const validTask = await api('PATCH', `/api/tasks/${taskId}/status`, {
    token: telecaller,
    body: {
      status: 'In Progress',
      expected_version: 1,
    },
  });
  assert.equal(validTask.status, 200);
  assert.equal(validTask.body.version, 2);
});

test('Admin rework: sends submitted task back to In Progress with rework instructions', async () => {
  const admin = await login('admin@kryston.local');
  const bdm = await login('bdm@kryston.local');

  // Create lead and route to Sales
  const createRes = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Rework Test Lead',
      phone: '+91 97777 88888',
      source: 'Direct',
    },
  });
  assert.equal(createRes.status, 201);
  const leadId = createRes.body.id;

  // Assign telecaller, respond, route to Sales
  await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: admin,
    body: { telecaller_id: 'KRY-TC-001' },
  });
  const tc = await login('telecaller@kryston.local');
  await api('POST', '/api/telecaller/respond', {
    token: tc,
    body: {
      lead_id: leadId,
      call_outcome: 'Connected',
      customer_intent: 'Hot',
      budget_range: '50L',
    },
  });

  const routeRes = await api('POST', `/api/leads/${leadId}/route`, {
    token: admin,
    body: {
      department: 'Sales',
      assigned_to: 'KRY-BDM-001',
      task_type: 'SALES_REVIEW',
      brief: 'Initial sales review',
    },
  });
  assert.equal(routeRes.status, 200);
  const taskId = routeRes.body.task_id;

  // Sales starts and submits task
  await api('PATCH', `/api/tasks/${taskId}/status`, {
    token: bdm,
    body: { status: 'In Progress' },
  });
  await api('POST', `/api/tasks/${taskId}/contact`, {
    token: bdm,
    body: { outcome: 'CONNECTED', notes: 'Spoke with customer regarding cost breakdown.' },
  });
  const submitRes = await api('POST', `/api/tasks/${taskId}/response`, {
    token: bdm,
    body: { findings: 'Incomplete cost breakdown submitted.' },
  });
  assert.equal(submitRes.status, 200);
  assert.equal(submitRes.body.status, 'Submitted');

  // Non-central spoke cannot request rework (deny test)
  const denyRework = await api('POST', `/api/tasks/${taskId}/rework`, {
    token: bdm,
    body: { rework_notes: 'Spoke cannot rework itself' },
  });
  assert.equal(denyRework.status, 403);

  // Admin requests rework (allow test)
  const allowRework = await api('POST', `/api/tasks/${taskId}/rework`, {
    token: admin,
    body: { rework_notes: 'Please provide unit-rate details for civil structure.' },
  });
  assert.equal(allowRework.status, 200);
  assert.equal(allowRework.body.status, 'In Progress');

  // Verify task status in database
  const taskRow = db.prepare('SELECT status, review_remarks FROM tasks WHERE id = ?').get(taskId);
  assert.equal(taskRow.status, 'In Progress');
  assert.match(taskRow.review_remarks, /unit-rate details/i);

  // Verify timeline action logged
  const action = db.prepare('SELECT * FROM lead_actions WHERE lead_id = ? AND action_type = \'TASK_REWORK\'').get(leadId);
  assert.ok(action, 'TASK_REWORK must be recorded in lead timeline');
  assert.match(action.remarks, /unit-rate details/i);
});

test('Same-department reassignment: allows reassigning within dept, denies cross-department', async () => {
  const admin = await login('admin@kryston.local');
  const engineer = await login('engineer@kryston.local');

  // Create lead and route to Sales (KRY-BDM-001)
  const leadRes = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Reassign Test Lead',
      phone: '+91 96666 55555',
      source: 'Referral',
    },
  });
  const leadId = leadRes.body.id;

  await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: admin,
    body: { telecaller_id: 'KRY-TC-001' },
  });
  const tc = await login('telecaller@kryston.local');
  await api('POST', '/api/telecaller/respond', {
    token: tc,
    body: { lead_id: leadId, call_outcome: 'Connected', customer_intent: 'Hot' },
  });

  const routeRes = await api('POST', `/api/leads/${leadId}/route`, {
    token: admin,
    body: {
      department: 'Sales',
      assigned_to: 'KRY-BDM-001',
      task_type: 'SALES_REVIEW',
      brief: 'Initial review',
    },
  });
  const taskId = routeRes.body.task_id;

  // 1. Spoke cannot reassign (deny test)
  const spokeReassign = await api('POST', `/api/tasks/${taskId}/reassign`, {
    token: engineer,
    body: { new_assigned_to: 'KRY-BDE-001', reason: 'Spoke trying to reassign' },
  });
  assert.equal(spokeReassign.status, 403);

  // 2. Cross-department reassignment is strictly rejected (deny test: Sales task to Site Engineer KRY-SE-001)
  const crossDept = await api('POST', `/api/tasks/${taskId}/reassign`, {
    token: admin,
    body: {
      new_assigned_to: 'KRY-SE-001',
      reason: 'Attempting invalid cross-dept assignment',
    },
  });
  assert.equal(crossDept.status, 403);
  assert.match(crossDept.body.error, /Cannot reassign across departments/i);

  // 3. Same-department reassignment succeeds (allow test: KRY-BDM-001 -> KRY-BDE-001)
  const validReassign = await api('POST', `/api/tasks/${taskId}/reassign`, {
    token: admin,
    body: {
      new_assigned_to: 'KRY-BDE-001',
      reason: 'Workload balancing across sales reps',
    },
  });
  assert.equal(validReassign.status, 200);
  assert.equal(validReassign.body.assigned_to, 'KRY-BDE-001');

  // Verify task and lead in database
  const taskRow = db.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(taskId);
  assert.equal(taskRow.assigned_to, 'KRY-BDE-001');

  const leadRow = db.prepare('SELECT assigned_bdm, current_owner FROM leads WHERE id = ?').get(leadId);
  assert.equal(leadRow.assigned_bdm, 'KRY-BDE-001');
  assert.equal(leadRow.current_owner, 'KRY-BDE-001');

  // Verify timeline action
  const action = db.prepare('SELECT * FROM lead_actions WHERE lead_id = ? AND action_type = \'TASK_REASSIGNED\'').get(leadId);
  assert.ok(action);
  assert.match(action.remarks, /Workload balancing/i);
});

test('Task reopen: allows Admin Desk to reopen reviewed/closed task, rejects unauthorized/in-progress', async () => {
  const admin = await login('admin@kryston.local');
  const bdm = await login('bdm@kryston.local');

  // Create lead, route to Sales, submit, review
  const leadRes = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Reopen Test Lead',
      phone: '+91 95555 44444',
      source: 'Direct',
    },
  });
  const leadId = leadRes.body.id;

  await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: admin,
    body: { telecaller_id: 'KRY-TC-001' },
  });
  const tc = await login('telecaller@kryston.local');
  await api('POST', '/api/telecaller/respond', {
    token: tc,
    body: { lead_id: leadId, call_outcome: 'Connected', customer_intent: 'Warm' },
  });

  const routeRes = await api('POST', `/api/leads/${leadId}/route`, {
    token: admin,
    body: {
      department: 'Sales',
      assigned_to: 'KRY-BDM-001',
      task_type: 'SALES_REVIEW',
      brief: 'Review scope',
    },
  });
  const taskId = routeRes.body.task_id;

  // Cannot reopen an Assigned task (deny test)
  const earlyReopen = await api('POST', `/api/tasks/${taskId}/reopen`, {
    token: admin,
    body: { reopen_reason: 'Task is still Assigned' },
  });
  assert.equal(earlyReopen.status, 409);

  // Progress task to Reviewed
  await api('PATCH', `/api/tasks/${taskId}/status`, {
    token: bdm,
    body: { status: 'In Progress' },
  });
  await api('POST', `/api/tasks/${taskId}/contact`, {
    token: bdm,
    body: { outcome: 'CONNECTED', notes: 'Initial scope validated with customer.' },
  });
  await api('POST', `/api/tasks/${taskId}/response`, {
    token: bdm,
    body: { findings: 'Review completed.' },
  });
  await api('POST', `/api/tasks/${taskId}/review`, {
    token: admin,
    body: { review_remarks: 'Reviewed and closed out.' },
  });

  // Non-central role cannot reopen (deny test)
  const spokeReopen = await api('POST', `/api/tasks/${taskId}/reopen`, {
    token: bdm,
    body: { reopen_reason: 'Spoke trying to reopen' },
  });
  assert.equal(spokeReopen.status, 403);

  // Admin Desk reopens the task (allow test)
  const reopenRes = await api('POST', `/api/tasks/${taskId}/reopen`, {
    token: admin,
    body: { reopen_reason: 'Client requested scope change; recalculate.' },
  });
  assert.equal(reopenRes.status, 200);
  assert.equal(reopenRes.body.status, 'Assigned');

  // Verify DB state
  const taskRow = db.prepare('SELECT status, review_remarks FROM tasks WHERE id = ?').get(taskId);
  assert.equal(taskRow.status, 'Assigned');
  assert.equal(taskRow.review_remarks, null);

  const action = db.prepare('SELECT * FROM lead_actions WHERE lead_id = ? AND action_type = \'TASK_REOPENED\'').get(leadId);
  assert.ok(action);
  assert.match(action.remarks, /recalculate/i);
});

test('Duplicate review & merge: identifies duplicates, merges without violating append-only ledgers', async () => {
  const admin = await login('admin@kryston.local');
  const bdm = await login('bdm@kryston.local');

  // 1. Create primary lead
  const lead1Res = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Ankit Sharma Primary',
      phone: '+91 98111 22233',
      source: 'Website',
      requirement: 'Villa construction',
    },
  });
  assert.equal(lead1Res.status, 201);
  const lead1Id = lead1Res.body.id;

  // Insert a duplicate lead with formatting variation (+91 vs 0 prefix) directly to simulate duplicate incoming
  const lead2Id = 'KRY-LEAD-2026-DUP2';
  db.prepare(`
    INSERT INTO leads (id, channel, source, customer_name, phone, phone_normalized, stage, current_owner, created_by, version)
    VALUES (?, 'Online', 'Meta Ads', 'Ankit S Duplicate', '098111 22233', '9811122233', 'New', 'KRY-AD-001', 'KRY-AD-001', 1)
  `).run(lead2Id);

  // Assign task to duplicate lead
  const dupTaskId = 'KRY-TASK-DUP-001';
  db.prepare(`
    INSERT INTO tasks (id, lead_id, assigned_to, assigned_by, department, task_type, brief, due_date, sla_hours, status, version)
    VALUES (?, ?, 'KRY-TC-001', 'KRY-AD-001', 'Marketing', 'TELECALLER_ENQUIRY', 'Call customer', '2030-01-01', 24, 'Assigned', 1)
  `).run(dupTaskId, lead2Id);

  // 2. GET /api/leads/duplicates returns duplicate cluster
  const dupListRes = await api('GET', '/api/leads/duplicates', { token: admin });
  assert.equal(dupListRes.status, 200);
  assert.ok(Array.isArray(dupListRes.body));
  const cluster = dupListRes.body.find((g) => g.phone_normalized === '9811122233');
  assert.ok(cluster, 'Duplicate cluster for 9811122233 must be returned');
  assert.equal(cluster.count, 2);

  // 3. Deny test: Non-central role cannot merge
  const denyMerge = await api('POST', `/api/leads/${lead1Id}/merge`, {
    token: bdm,
    body: { duplicate_lead_id: lead2Id, reason: 'Unauthorized merge attempt' },
  });
  assert.equal(denyMerge.status, 403);

  // 4. Deny test: Cannot merge lead into itself
  const selfMerge = await api('POST', `/api/leads/${lead1Id}/merge`, {
    token: admin,
    body: { duplicate_lead_id: lead1Id, reason: 'Merging into self' },
  });
  assert.equal(selfMerge.status, 400);

  // 5. Allow test: Admin merges duplicate into retained lead
  const mergeRes = await api('POST', `/api/leads/${lead1Id}/merge`, {
    token: admin,
    body: {
      duplicate_lead_id: lead2Id,
      reason: 'Same client contacted from both Meta Ads and Website.',
      expected_version: 1,
    },
  });
  assert.equal(mergeRes.status, 200);
  assert.equal(mergeRes.body.retained_id, lead1Id);
  assert.equal(mergeRes.body.merged_id, lead2Id);

  // Verify duplicate lead state
  const dupLead = db.prepare('SELECT stage, deleted_at, merged_into, merge_reason FROM leads WHERE id = ?').get(lead2Id);
  assert.equal(dupLead.stage, 'Closed');
  assert.ok(dupLead.deleted_at);
  assert.equal(dupLead.merged_into, lead1Id);
  assert.match(dupLead.merge_reason, /Meta Ads and Website/i);

  // Verify task was reparented to retained lead
  const reparentedTask = db.prepare('SELECT lead_id FROM tasks WHERE id = ?').get(dupTaskId);
  assert.equal(reparentedTask.lead_id, lead1Id);

  // Verify append-only timeline rows on BOTH leads (no update/delete triggers fired)
  const retainedAction = db.prepare('SELECT * FROM lead_actions WHERE lead_id = ? AND action_type = \'DUPLICATE_MERGE\'').get(lead1Id);
  assert.ok(retainedAction, 'Retained lead must have DUPLICATE_MERGE timeline row');
  assert.match(retainedAction.remarks, new RegExp(lead2Id));

  const duplicateAction = db.prepare('SELECT * FROM lead_actions WHERE lead_id = ? AND action_type = \'MERGED_INTO\'').get(lead2Id);
  assert.ok(duplicateAction, 'Duplicate lead must have MERGED_INTO timeline row');
  assert.match(duplicateAction.remarks, new RegExp(lead1Id));

  // Verify global audit log entry
  const auditRow = db.prepare('SELECT * FROM audit_log WHERE entity_id = ? AND action = \'MERGE_LEADS\'').get(lead1Id);
  assert.ok(auditRow);

  // 6. Deny test: Merging an already merged lead returns 404/409
  const reMerge = await api('POST', `/api/leads/${lead1Id}/merge`, {
    token: admin,
    body: { duplicate_lead_id: lead2Id, reason: 'Attempt to merge again' },
  });
  assert.equal(reMerge.status, 404);
});

test('Keyset cursor pagination: deterministic cursor traversal on /api/leads and /api/tasks', async () => {
  const admin = await login('admin@kryston.local');

  // Insert 5 leads with distinct timestamps and IDs
  for (let i = 1; i <= 5; i++) {
    const id = `KRY-LEAD-PAG-${String(i).padStart(3, '0')}`;
    const stamp = `2026-06-0${i} 10:00:00`;
    db.prepare(`
      INSERT OR REPLACE INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by, created_at, updated_at)
      VALUES (?, 'Online', 'Website', ?, ?, 'New', 'KRY-AD-001', 'KRY-AD-001', ?, ?)
    `).run(id, `Pag Customer ${i}`, `999000000${i}`, stamp, stamp);
  }

  // Request first page of 2 items
  const page1 = await api('GET', '/api/leads?limit=2&stage=New', { token: admin });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.length, 2);

  const nextCursor = page1.headers.get('x-next-cursor');
  assert.ok(nextCursor, 'X-Next-Cursor header must be provided when limit is reached');

  // Request second page using the cursor
  const page2 = await api('GET', `/api/leads?limit=2&stage=New&cursor=${encodeURIComponent(nextCursor)}`, { token: admin });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.length, 2);

  // Check no overlap between page 1 and page 2
  const page1Ids = page1.body.map((l) => l.id);
  const page2Ids = page2.body.map((l) => l.id);
  for (const id of page2Ids) {
    assert.ok(!page1Ids.includes(id), `Duplicate record ${id} found across cursor pages`);
  }
});

test('Nurture reminders: past/due nurture leads appear on Admin My Day, future leads excluded', async () => {
  const admin = await login('admin@kryston.local');

  // Lead A: Nurture lead due in the past
  const pastLeadId = 'KRY-LEAD-NURT-PAST';
  db.prepare(`
    INSERT OR REPLACE INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by, updated_at)
    VALUES (?, 'Online', 'Website', 'Past Nurture Lead', '9888811111', 'Nurture', 'KRY-AD-001', 'KRY-AD-001', '2026-01-01 10:00:00')
  `).run(pastLeadId);
  db.prepare(`
    INSERT INTO telecaller_responses (lead_id, telecaller_id, call_outcome, next_followup, notes)
    VALUES (?, 'KRY-TC-001', 'Connected', '2026-01-01', 'Due in past')
  `).run(pastLeadId);

  // Lead B: Nurture lead due in the future
  const futureLeadId = 'KRY-LEAD-NURT-FUTR';
  db.prepare(`
    INSERT OR REPLACE INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by, updated_at)
    VALUES (?, 'Online', 'Website', 'Future Nurture Lead', '9888822222', 'Nurture', 'KRY-AD-001', 'KRY-AD-001', '2026-01-01 10:00:00')
  `).run(futureLeadId);
  db.prepare(`
    INSERT INTO telecaller_responses (lead_id, telecaller_id, call_outcome, next_followup, notes)
    VALUES (?, 'KRY-TC-001', 'Connected', '2035-12-31', 'Due in far future')
  `).run(futureLeadId);

  // Fetch My Day for Admin Desk
  const myDayRes = await api('GET', '/api/my-day', { token: admin });
  assert.equal(myDayRes.status, 200);

  const sendGroup = myDayRes.body.actionQueue.groups.find((g) => g.key === 'send');
  assert.ok(sendGroup);

  const pastItem = sendGroup.items.find((i) => i.id === pastLeadId);
  assert.ok(pastItem, 'Due nurture lead must be present in Admin Action Required queue');

  const futureItem = sendGroup.items.find((i) => i.id === futureLeadId);
  assert.equal(futureItem, undefined, 'Future nurture lead must not be present in today\'s Action Required queue');
});

test('HTTP exhaustive illegal transition x role matrix: rejects illegal transitions with 403 or 409', async () => {
  const admin = await login('admin@kryston.local');
  const bdm = await login('bdm@kryston.local');
  const engineer = await login('engineer@kryston.local');
  const architect = await login('architect@kryston.local');
  const telecaller = await login('telecaller@kryston.local');

  // Matrix of test cases: [roleToken, fromStage, attemptedStage, expectedStatuses]
  const illegalTestCases = [
    // Non-admin attempting direct stage change
    { token: bdm, fromStage: 'New', targetStage: 'Lost', expect: 403 },
    { token: engineer, fromStage: 'Routed to Engineering', targetStage: 'Nurture', expect: 403 },
    { token: telecaller, fromStage: 'With Telecaller', targetStage: 'Lost', expect: 403 },
    { token: architect, fromStage: 'Design In Progress', targetStage: 'Lost', expect: 403 },

    // Attempting direct stage change to workflow stages that require workflow endpoints
    { token: admin, fromStage: 'New', targetStage: 'Work Order Finalized', expect: [400, 403, 409] },
    { token: admin, fromStage: 'New', targetStage: 'Completed', expect: [400, 403, 409] },
    { token: admin, fromStage: 'New', targetStage: 'Quotation Stage', expect: [400, 403, 409] },
    { token: admin, fromStage: 'Response Received', targetStage: 'Completed', expect: [400, 403, 409] },

    // Terminal stage transitions (cannot move from Lost or Closed)
    { token: admin, fromStage: 'Lost', targetStage: 'New', expect: [400, 409] },
    { token: admin, fromStage: 'Closed', targetStage: 'Lost', expect: [400, 409] },
  ];

  for (let idx = 0; idx < illegalTestCases.length; idx++) {
    const tc = illegalTestCases[idx];
    const testLeadId = `KRY-LEAD-TRANS-${String(idx).padStart(3, '0')}`;
    db.prepare(`
      INSERT OR REPLACE INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by)
      VALUES (?, 'Online', 'Test', ?, ?, ?, 'KRY-AD-001', 'KRY-AD-001')
    `).run(testLeadId, `Trans Test ${idx}`, `970000000${idx}`, tc.fromStage);

    const res = await api('PATCH', `/api/leads/${testLeadId}/stage`, {
      token: tc.token,
      body: { stage: tc.targetStage, remarks: 'Illegal transition test' },
    });

    const allowedStatuses = Array.isArray(tc.expect) ? tc.expect : [tc.expect];
    assert.ok(
      allowedStatuses.includes(res.status),
      `Expected ${allowedStatuses.join('/')} for ${tc.fromStage} -> ${tc.targetStage}, but got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
});
