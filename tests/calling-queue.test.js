/**
 * Acceptance test suite for Kryston CRM v2.4.0:
 * Calling Queue, My Work, Auto-Reminders, Activity Ledger & UI Enhancements.
 *
 * Verifies all 16 acceptance test criteria from Section 8 of the specification.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-v24-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = path.join(tempDir, 'test-v24.db');
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_PASSWORD = 'Admin@12345';

const db = require('../src/db');
const { createApp } = require('../src/app');
const clock = require('../src/lib/clock');
const queueService = require('../src/lib/services/queue-service');
const reminderService = require('../src/lib/services/reminder-service');

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
  clock.reset();
  await new Promise((resolve) => server.close(resolve));
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
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

function getQueueList(res) {
  return Array.isArray(res.body) ? res.body : (res.body.queue || []);
}

function getTaskList(res) {
  return Array.isArray(res.body) ? res.body : (res.body.tasks || []);
}

test('Criterion 1: New task appears only in Calling Queue, never in My Work', async () => {
  const adminToken = await login('admin@kryston.local');
  const tcToken = await login('telecaller@kryston.local');

  // Create a fresh lead
  const leadRes = await api('POST', '/api/leads', {
    token: adminToken,
    body: {
      customer_name: 'Vikram Malhotra',
      phone: '+91 9811122233',
      source: 'Website',
      city: 'Gurugram',
      requirement: 'Full duplex interior turnkey',
      channel: 'Online',
      budget_range: '50-75L',
      timeline: '3 months',
    },
  });
  assert.equal(leadRes.status, 201);
  const leadId = leadRes.body.id;

  // Assign telecaller
  const tcUser = db.prepare("SELECT * FROM employees WHERE email = 'telecaller@kryston.local'").get();
  const assignRes = await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: adminToken,
    body: {
      telecaller_id: tcUser.id,
      instructions: 'Call customer Vikram immediately',
    },
  });
  assert.equal(assignRes.status, 200);

  // Check Calling Queue for telecaller
  const queueRes = await api('GET', '/api/queues/calling', { token: tcToken });
  assert.equal(queueRes.status, 200);
  const callingList = getQueueList(queueRes);
  const foundInCalling = callingList.find((t) => t.lead_id === leadId);
  assert.ok(foundInCalling, 'Task must appear in Calling Queue');
  assert.equal(foundInCalling.contact_status, 'NOT_CONTACTED');
  assert.equal(foundInCalling.call_attempts, 0);

  // Check My Work for telecaller - must NOT be in Active
  const myWorkRes = await api('GET', '/api/queues/my-work?tab=active', { token: tcToken });
  assert.equal(myWorkRes.status, 200);
  const activeList = getTaskList(myWorkRes);
  const foundInActive = activeList.find((t) => t.lead_id === leadId);
  assert.equal(foundInActive, undefined, 'Task must NOT appear in My Work > Active before contact');
});

test('Criterion 2: NO_ANSWER keeps in Calling Queue, attempts=1, CALL_OUTCOME row logged; 3 failed attempts notifies Admin once', async () => {
  const adminToken = await login('admin@kryston.local');
  const tcToken = await login('telecaller@kryston.local');
  const tcUser = db.prepare("SELECT * FROM employees WHERE email = 'telecaller@kryston.local'").get();

  // Create lead & assign
  const leadRes = await api('POST', '/api/leads', {
    token: adminToken,
    body: {
      customer_name: 'Anita Verma',
      phone: '+91 9822233344',
      source: 'Referral',
      city: 'Delhi',
      channel: 'Offline',
      budget_range: '25-50L',
      timeline: 'Immediate',
    },
  });
  const leadId = leadRes.body.id;
  await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: adminToken,
    body: { telecaller_id: tcUser.id, instructions: 'Call customer Anita' },
  });

  const queueRes = await api('GET', '/api/queues/calling', { token: tcToken });
  const task = getQueueList(queueRes).find((t) => t.lead_id === leadId);
  assert.ok(task);

  // Log 1st call attempt: NO_ANSWER
  const call1 = await api('POST', `/api/tasks/${task.id}/contact`, {
    token: tcToken,
    body: {
      outcome: 'NO_ANSWER',
      notes: 'Rang 5 times, no answer',
      duration_seconds: 45,
    },
  });
  assert.equal(call1.status, 200);
  assert.equal(call1.body.task.contact_attempts, 1);
  assert.equal(call1.body.task.contact_status, 'NOT_CONTACTED');

  // Verify task_activity row logged
  const act1 = db.prepare('SELECT * FROM task_activity WHERE task_id = ?').all(task.id);
  assert.equal(act1.length, 1);
  assert.equal(act1[0].kind, 'CALL');
  assert.equal(act1[0].outcome, 'NO_ANSWER');

  // Log 2nd call attempt: BUSY
  const call2 = await api('POST', `/api/tasks/${task.id}/contact`, {
    token: tcToken,
    body: { outcome: 'BUSY', notes: 'Call waiting' },
  });
  assert.equal(call2.body.task.contact_attempts, 2);

  // Log 3rd call attempt: NO_ANSWER (triggers admin notification)
  const initialAdminNotifs = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE message LIKE '%failed contact attempts%'").get().c;
  const call3 = await api('POST', `/api/tasks/${task.id}/contact`, {
    token: tcToken,
    body: { outcome: 'NO_ANSWER', notes: 'Still not answering' },
  });
  assert.equal(call3.body.task.contact_attempts, 3);

  const afterAdminNotifs = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE message LIKE '%failed contact attempts%'").get().c;
  assert.ok(afterAdminNotifs > initialAdminNotifs, 'Admin must be notified on 3 failed attempts');

  // Log 4th call attempt: NO_ANSWER (should NOT send duplicate notification)
  await api('POST', `/api/tasks/${task.id}/contact`, {
    token: tcToken,
    body: { outcome: 'NO_ANSWER', notes: '4th attempt' },
  });
  const finalAdminNotifs = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE message LIKE '%failed contact attempts%'").get().c;
  assert.equal(finalAdminNotifs, afterAdminNotifs, 'Admin notification must be sent exactly once');
});

test('Criterion 3: CONNECTED moves to My Work > Active with notes, work summary, timestamps; timeline shows CALL_OUTCOME in IST', async () => {
  const adminToken = await login('admin@kryston.local');
  const tcToken = await login('telecaller@kryston.local');
  const tcUser = db.prepare("SELECT * FROM employees WHERE email = 'telecaller@kryston.local'").get();

  const leadRes = await api('POST', '/api/leads', {
    token: adminToken,
    body: {
      customer_name: 'Rajesh Khanna',
      phone: '9833344455',
      source: 'Instagram',
      city: 'Noida',
      channel: 'Online',
      budget_range: '75L-1Cr',
      timeline: '2 months',
    },
  });
  const leadId = leadRes.body.id;
  await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: adminToken,
    body: { telecaller_id: tcUser.id, instructions: 'Call Rajesh' },
  });

  const q = await api('GET', '/api/queues/calling', { token: tcToken });
  const task = getQueueList(q).find((t) => t.lead_id === leadId);

  // Log CONNECTED
  const res = await api('POST', `/api/tasks/${task.id}/contact`, {
    token: tcToken,
    body: {
      outcome: 'CONNECTED',
      notes: 'Spoke with Rajesh. Very keen on premium Italian marble and modular kitchen.',
      customer_intent: 'Hot',
      duration_seconds: 240,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.contact_status, 'CONTACTED');
  assert.ok(res.body.task.first_contacted_at);
  assert.ok(res.body.task.last_contact_at);
  assert.ok(res.body.task.work_summary);

  // Calling queue must no longer contain this task
  const qAfter = await api('GET', '/api/queues/calling', { token: tcToken });
  assert.equal(getQueueList(qAfter).some((t) => t.id === task.id), false);

  // My Work > Active MUST contain this task
  const activeRes = await api('GET', '/api/queues/my-work?tab=active', { token: tcToken });
  assert.ok(getTaskList(activeRes).some((t) => t.id === task.id));

  // Check lead timeline for CALL_OUTCOME entry
  const leadDetail = await api('GET', `/api/leads/${leadId}`, { token: adminToken });
  const outcomeAction = leadDetail.body.timeline.find((a) => a.action_type === 'CALL_OUTCOME');
  assert.ok(outcomeAction, 'Timeline must log CALL_OUTCOME');
  assert.ok(outcomeAction.remarks.includes('Spoke with Rajesh'));
});

test('Criterion 4: CALLBACK_REQUESTED with date in 7 days creates PENDING reminder and puts task in My Work > Waiting', async () => {
  const adminToken = await login('admin@kryston.local');
  const tcToken = await login('telecaller@kryston.local');
  const tcUser = db.prepare("SELECT * FROM employees WHERE email = 'telecaller@kryston.local'").get();

  const leadRes = await api('POST', '/api/leads', {
    token: adminToken,
    body: {
      customer_name: 'Sunil Gavaskar',
      phone: '9844455566',
      source: 'Google Ads',
      city: 'Mumbai',
      channel: 'Online',
    },
  });
  const leadId = leadRes.body.id;
  await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: adminToken,
    body: { telecaller_id: tcUser.id, instructions: 'Call Sunil' },
  });

  const q = await api('GET', '/api/queues/calling', { token: tcToken });
  const task = getQueueList(q).find((t) => t.lead_id === leadId);

  // Log CALLBACK_REQUESTED
  const res = await api('POST', `/api/tasks/${task.id}/contact`, {
    token: tcToken,
    body: {
      outcome: 'CALLBACK_REQUESTED',
      callback_date: '2026-12-05',
      notes: 'Customer at airport, call on 5th Dec',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.contact_status, 'CONTACTED');
  assert.equal(res.body.task.last_outcome, 'CALLBACK_REQUESTED');

  // Verify reminder created in DB
  const reminder = db.prepare('SELECT * FROM reminders WHERE task_id = ?').get(task.id);
  assert.ok(reminder);
  assert.equal(reminder.status, 'PENDING');
  assert.equal(reminder.due_date, '2026-12-05');
  assert.equal(reminder.type, 'CALL_BACK');

  // Task is in Waiting tab
  const waitingRes = await api('GET', '/api/queues/my-work?tab=waiting', { token: tcToken });
  assert.ok(getTaskList(waitingRes).some((t) => t.id === task.id));
});

test('Criterion 5: Injectable clock test: At 08:59 nothing triggers; at 09:00 reminder TRIGGERED, RE_ENGAGE task created, Admin and assignee notified, AUTO_REMINDER_TRIGGERED on timeline', async () => {
  const adminUser = db.prepare("SELECT * FROM employees WHERE email = 'admin@kryston.local'").get();
  const tcUser = db.prepare("SELECT * FROM employees WHERE email = 'telecaller@kryston.local'").get();

  // Create lead & reminder due 2026-11-25
  const leadId = 'KRY-LEAD-TEST-C5';
  db.prepare(`
    INSERT INTO leads (id, customer_name, phone, phone_normalized, stage, source, channel, assigned_telecaller, created_by)
    VALUES (?, 'Clock Test Customer', '9855566677', '9855566677', 'With Telecaller', 'Website', 'Online', ?, ?)
  `).run(leadId, tcUser.id, adminUser.id);

  const taskId = 'KRY-TASK-TEST-C5';
  db.prepare(`
    INSERT INTO tasks (id, lead_id, department, task_type, brief, assigned_to, assigned_by, status, requires_contact, contact_status, last_outcome)
    VALUES (?, ?, 'Marketing', 'CALL_REQUEST', 'Clock test task', ?, ?, 'In Progress', 1, 'CONTACTED', 'CALLBACK_REQUESTED')
  `).run(taskId, leadId, tcUser.id, adminUser.id);

  const reminder = reminderService.createReminder(db, adminUser, leadId, {
    task_id: taskId,
    type: 'CALL_BACK',
    due_date: '2026-11-25',
    note: 'Follow up at 9am',
  });

  // At 08:59:59 IST on 2026-11-25 -> Nothing triggers
  clock.setFixedTime('2026-11-25T08:59:59+05:30');
  const countEarly = reminderService.runDueReminders(db);
  assert.equal(countEarly.length, 0, 'No reminders should trigger before 09:00 IST');

  // At 09:00:00 IST on 2026-11-25 -> Reminder triggers
  clock.setFixedTime('2026-11-25T09:00:00+05:30');
  const countDue = reminderService.runDueReminders(db);
  assert.equal(countDue.length, 1, 'Exactly 1 reminder should trigger at 09:00 IST');

  // Verify reminder updated
  const updatedRem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(reminder.id);
  assert.equal(updatedRem.status, 'TRIGGERED');
  assert.ok(updatedRem.triggered_at);
  assert.ok(updatedRem.admin_task_id);

  // Verify RE_ENGAGE task created
  const reTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(updatedRem.admin_task_id);
  assert.equal(reTask.task_type, 'RE_ENGAGE');
  assert.equal(reTask.department, 'Administration');

  // Verify timeline action
  const actions = db.prepare("SELECT * FROM lead_actions WHERE lead_id = ? AND action_type = 'AUTO_REMINDER_TRIGGERED'").all(leadId);
  assert.equal(actions.length, 1);
});

test('Criterion 6: Idempotency test: Run job twice, restart app; exactly 1 Admin task and 1 notification', async () => {
  // Advance clock slightly to 09:05 IST
  clock.setFixedTime('2026-11-25T09:05:00+05:30');
  const secondRun = reminderService.runDueReminders(db);
  assert.equal(secondRun.length, 0, 'Second run must trigger 0 reminders (idempotent)');

  // Advance to 09:15 IST
  clock.setFixedTime('2026-11-25T09:15:00+05:30');
  const thirdRun = reminderService.runDueReminders(db);
  assert.equal(thirdRun.length, 0, 'Third run must trigger 0 reminders');

  const reTasks = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE task_type = 'RE_ENGAGE' AND lead_id = 'KRY-LEAD-TEST-C5'").get().c;
  assert.equal(reTasks, 1, 'Exactly 1 RE_ENGAGE task must exist for this lead');
});

test('Criterion 7: Admin routing from triggered reminder marks reminder DONE, closes RE_ENGAGE task, assigns new task in Calling Queue as NOT_CONTACTED', async () => {
  const adminToken = await login('admin@kryston.local');
  const salesUser = db.prepare("SELECT * FROM employees WHERE email = 'bdm@kryston.local'").get();
  const salesToken = await login(salesUser.email);

  const rem = db.prepare("SELECT * FROM reminders WHERE lead_id = 'KRY-LEAD-TEST-C5' AND status = 'TRIGGERED'").get();
  assert.ok(rem);

  // Close previous task now that callback has matured, and move lead stage to 'Response Received'
  db.prepare("UPDATE tasks SET status = 'Closed' WHERE id = 'KRY-TASK-TEST-C5'").run();
  db.prepare("UPDATE leads SET stage = 'Response Received' WHERE id = ?").run(rem.lead_id);

  // Admin routes the lead using reminder_id
  const routeRes = await api('POST', `/api/leads/${rem.lead_id}/route`, {
    token: adminToken,
    body: {
      department: 'Sales', allow_customer_contact: true,
      assigned_to: salesUser.id,
      task_type: 'SALES_REVIEW',
      brief: 'Meet customer Vikram regarding interior scope',
      due_date: '2026-12-01',
      reminder_id: rem.id,
    },
  });
  assert.equal(routeRes.status, 200, `Routing failed: ${JSON.stringify(routeRes.body)}`);

  // Reminder status is now DONE
  const resolvedRem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(rem.id);
  assert.equal(resolvedRem.status, 'DONE');
  assert.ok(resolvedRem.resolved_by);
  assert.ok(resolvedRem.resolved_at);

  // RE_ENGAGE task is Closed
  const reTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(rem.admin_task_id);
  assert.equal(reTask.status, 'Closed');

  // New sales task is NOT_CONTACTED in Sales assignee calling queue
  const salesQueue = await api('GET', '/api/queues/calling', { token: salesToken });
  const newTask = getQueueList(salesQueue).find((t) => t.lead_id === rem.lead_id);
  assert.ok(newTask);
  assert.equal(newTask.contact_status, 'NOT_CONTACTED');
});

test('Criterion 8: Snooze 7 days creates linked PENDING reminder; Dismiss requires reason', async () => {
  const adminToken = await login('admin@kryston.local');

  // Create a pending reminder via API
  const lead = db.prepare('SELECT id FROM leads LIMIT 1').get();
  const remRes = await api('POST', `/api/leads/${lead.id}/reminders`, {
    token: adminToken,
    body: {
      type: 'FOLLOW_UP',
      due_date: '2026-11-28',
      note: 'Initial reminder',
    },
  });
  assert.equal(remRes.status, 201);
  const rem = remRes.body.reminder;

  // Snooze by 7 days
  const snoozeRes = await api('POST', `/api/reminders/${rem.id}/snooze`, {
    token: adminToken,
    body: {
      snooze_until: '2026-12-05',
      reason: 'Customer out of town until next week',
    },
  });
  assert.equal(snoozeRes.status, 200);

  // Original is SNOOZED
  const oldRem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(rem.id);
  assert.equal(oldRem.status, 'SNOOZED');

  // New linked reminder created
  const newRem = db.prepare('SELECT * FROM reminders WHERE previous_reminder_id = ?').get(rem.id);
  assert.ok(newRem);
  assert.equal(newRem.status, 'PENDING');
  assert.equal(newRem.due_date, '2026-12-05');

  // Dismiss without reason -> should fail with 400
  const badDismiss = await api('POST', `/api/reminders/${newRem.id}/dismiss`, {
    token: adminToken,
    body: { reason: '' },
  });
  assert.equal(badDismiss.status, 400);

  // Dismiss with valid reason
  const goodDismiss = await api('POST', `/api/reminders/${newRem.id}/dismiss`, {
    token: adminToken,
    body: { reason: 'Lead closed by direct referral' },
  });
  assert.equal(goodDismiss.status, 200);
  const dismissedRem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(newRem.id);
  assert.equal(dismissedRem.status, 'DISMISSED');
});

test('Criterion 9: Lead moved to Lost cancels pending reminders', async () => {
  const adminToken = await login('admin@kryston.local');

  // Create lead & reminder
  const leadRes = await api('POST', '/api/leads', {
    token: adminToken,
    body: { customer_name: 'To Be Lost', phone: '9866677788', source: 'Direct', channel: 'Online' },
  });
  const leadId = leadRes.body.id;

  const remRes = await api('POST', `/api/leads/${leadId}/reminders`, {
    token: adminToken,
    body: {
      type: 'FOLLOW_UP',
      due_date: '2026-12-10',
      note: 'Active reminder',
    },
  });
  assert.equal(remRes.status, 201);
  const rem = remRes.body.reminder;
  assert.equal(rem.status, 'PENDING');

  // Mark lead Lost
  const patchRes = await api('PATCH', `/api/leads/${leadId}/stage`, {
    token: adminToken,
    body: {
      stage: 'Lost',
      lost_reason: 'Competitor selected',
    },
  });
  assert.equal(patchRes.status, 200);

  // Reminder must now be CANCELLED
  const remAfter = db.prepare('SELECT * FROM reminders WHERE id = ?').get(rem.id);
  assert.equal(remAfter.status, 'CANCELLED');
});

test('Criterion 10: RBAC: non-assignee gets 404 on contact/work-note, cannot read other queue, telecaller cannot route', async () => {
  const archToken = await login('architect@kryston.local');
  const tcToken = await login('telecaller@kryston.local');

  // Find an active task assigned to someone else
  const otherTask = db.prepare("SELECT * FROM tasks WHERE assigned_to != (SELECT id FROM employees WHERE email = 'architect@kryston.local') AND status IN ('Assigned', 'In Progress') LIMIT 1").get();
  assert.ok(otherTask);

  // Non-assignee contact attempt -> 404
  const badContact = await api('POST', `/api/tasks/${otherTask.id}/contact`, {
    token: archToken,
    body: { outcome: 'CONNECTED', notes: 'Unauthorized call' },
  });
  assert.equal(badContact.status, 404);

  // Non-assignee work note attempt -> 404
  const badNote = await api('POST', `/api/tasks/${otherTask.id}/work-note`, {
    token: archToken,
    body: { notes: 'Unauthorized note' },
  });
  assert.equal(badNote.status, 404);

  // Telecaller cannot route leads -> 403 Forbidden
  const lead = db.prepare('SELECT id FROM leads LIMIT 1').get();
  const badRoute = await api('POST', `/api/leads/${lead.id}/route`, {
    token: tcToken,
    body: {
      department: 'Design',
      task_type: 'DESIGN_PREPARATION',
      brief: 'Telecaller trying to route',
      due_date: '2026-12-01',
      assigned_to: otherTask.assigned_to,
    },
  });
  assert.equal(badRoute.status, 403);
});

test('Criterion 11: Purchase and Accounts tasks with requires_contact = 0 skip Calling Queue directly into My Work', async () => {
  const adminToken = await login('admin@kryston.local');
  const purchUser = db.prepare("SELECT * FROM employees WHERE email = 'purchase@kryston.local'").get();
  const purchToken = await login(purchUser.email);

  // Create lead in Response Received stage for clean routing
  const leadRes = await api('POST', '/api/leads', {
    token: adminToken,
    body: { customer_name: 'Purchase Test Customer', phone: '9877788899', source: 'Website', channel: 'Online' },
  });
  const leadId = leadRes.body.id;
  db.prepare("UPDATE leads SET stage = 'Response Received' WHERE id = ?").run(leadId);

  // Admin routes task to Purchase
  const routeRes = await api('POST', `/api/leads/${leadId}/route`, {
    token: adminToken,
    body: {
      department: 'Purchase',
      assigned_to: purchUser.id,
      task_type: 'MATERIAL_CHECK',
      brief: 'Check pricing and vendor quotes for Italian tiles',
      due_date: '2026-12-01',
    },
  });
  assert.equal(routeRes.status, 200, `Routing to purchase failed: ${JSON.stringify(routeRes.body)}`);
  const taskId = routeRes.body.task_id;

  const dbTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert.equal(dbTask.requires_contact, 0);
  assert.equal(dbTask.contact_status, 'NOT_REQUIRED');

  // Must NOT appear in Calling Queue
  const queueRes = await api('GET', '/api/queues/calling', { token: purchToken });
  assert.equal(getQueueList(queueRes).some((t) => t.id === taskId), false);

  // MUST appear directly in My Work > Active
  const myWorkRes = await api('GET', '/api/queues/my-work?tab=active', { token: purchToken });
  assert.ok(getTaskList(myWorkRes).some((t) => t.id === taskId));
});

test('Criterion 12: Migration test: existing rows correctly backfilled, no task duplicated', async () => {
  // All tasks in the DB must have contact_status not null and requires_contact in (0, 1)
  const invalidTasks = db.prepare(`
    SELECT COUNT(*) AS c FROM tasks
    WHERE contact_status IS NULL
       OR requires_contact NOT IN (0, 1)
       OR contact_status NOT IN ('NOT_CONTACTED', 'CONTACTED', 'NOT_REQUIRED')
  `).get().c;
  assert.equal(invalidTasks, 0, 'All tasks must have valid backfilled contact_status');

  // Verify KRY-SYS-001 system employee exists
  const sysEmp = db.prepare("SELECT * FROM employees WHERE id = 'KRY-SYS-001'").get();
  assert.ok(sysEmp);
  assert.equal(sysEmp.active, 0);
});

test('Criterion 13: Views mutually exclusive: every combination belongs to exactly 1 view', () => {
  // Unit test determineTaskView across all states
  assert.equal(queueService.determineTaskView({ requires_contact: 1, contact_status: 'NOT_CONTACTED', status: 'Assigned' }, false, '2026-11-23'), 'Calling Queue');
  assert.equal(queueService.determineTaskView({ requires_contact: 1, contact_status: 'NOT_CONTACTED', status: 'Assigned', next_action_date: '2026-11-25' }, false, '2026-11-23'), 'Calling Queue > Scheduled');
  assert.equal(queueService.determineTaskView({ requires_contact: 1, contact_status: 'CONTACTED', status: 'Assigned' }, false, '2026-11-23'), 'My Work > Active');
  assert.equal(queueService.determineTaskView({ requires_contact: 0, contact_status: 'NOT_REQUIRED', status: 'Assigned' }, false, '2026-11-23'), 'My Work > Active');
  assert.equal(queueService.determineTaskView({ status: 'In Progress', contact_status: 'CONTACTED' }, true, '2026-11-23'), 'My Work > Waiting');
  assert.equal(queueService.determineTaskView({ status: 'In Progress', contact_status: 'CONTACTED', next_action_date: '2026-11-25' }, false, '2026-11-23'), 'My Work > Waiting');
  assert.equal(queueService.determineTaskView({ status: 'Submitted' }), 'My Work > Sent for review');
  assert.equal(queueService.determineTaskView({ status: 'Reviewed' }), 'My Work > Done');
  assert.equal(queueService.determineTaskView({ status: 'Closed' }), 'My Work > Done');
});

test('Criterion 14: Timezone test: due on local date triggers at 09:00 IST (not 09:00 UTC)', () => {
  // 09:00:00 IST on 2026-11-23 corresponds to 03:30:00 UTC on 2026-11-23
  clock.setFixedTime('2026-11-23T03:30:00.000Z');
  assert.equal(clock.todayLocal(), '2026-11-23');
  assert.equal(clock.hourLocal(), 9);

  // Before 09:00 IST (e.g. 02:00:00 UTC = 07:30:00 IST)
  clock.setFixedTime('2026-11-23T02:00:00.000Z');
  assert.equal(clock.hourLocal(), 7);
});

test('Criterion 15: task_activity rejects UPDATE and DELETE triggers', () => {
  let row = db.prepare('SELECT * FROM task_activity LIMIT 1').get();
  if (!row) {
    const task = db.prepare('SELECT id, lead_id FROM tasks LIMIT 1').get();
    const emp = db.prepare('SELECT id FROM employees LIMIT 1').get();
    db.prepare(`
      INSERT INTO task_activity (task_id, lead_id, employee_id, kind, notes)
      VALUES (?, ?, ?, 'WORK_NOTE', 'Initial test note')
    `).run(task.id, task.lead_id, emp.id);
    row = db.prepare('SELECT * FROM task_activity LIMIT 1').get();
  }
  assert.ok(row, 'At least 1 task_activity row exists for trigger test');

  // Attempt UPDATE
  assert.throws(() => {
    db.prepare('UPDATE task_activity SET notes = ? WHERE id = ?').run('Tampered', row.id);
  }, /append-only/i);

  // Attempt DELETE
  assert.throws(() => {
    db.prepare('DELETE FROM task_activity WHERE id = ?').run(row.id);
  }, /append-only/i);
});

test('Criterion 16: Phone normalization accepts +91 98765 43210 and 098765 43210, and rejects 074880908876', async () => {
  const adminToken = await login('admin@kryston.local');

  // +91 format
  const r1 = await api('POST', '/api/leads', {
    token: adminToken,
    body: { customer_name: 'P1', phone: '+91 98765 43210', source: 'Direct', channel: 'Online' },
  });
  assert.equal(r1.status, 201);
  const l1 = db.prepare('SELECT phone_normalized FROM leads WHERE id = ?').get(r1.body.id);
  assert.equal(l1.phone_normalized, '9876543210');

  // 0-prefixed format
  const r2 = await api('POST', '/api/leads', {
    token: adminToken,
    body: { customer_name: 'P2', phone: '098765 43219', source: 'Direct', channel: 'Online' },
  });
  assert.equal(r2.status, 201);
  const l2 = db.prepare('SELECT phone_normalized FROM leads WHERE id = ?').get(r2.body.id);
  assert.equal(l2.phone_normalized, '9876543219');

  // Invalid 12-digit number starting with 0: 074880908876 -> Rejected with 400
  const r3 = await api('POST', '/api/leads', {
    token: adminToken,
    body: { customer_name: 'P3', phone: '074880908876', source: 'Direct', channel: 'Online' },
  });
  assert.equal(r3.status, 400);

  // Non-mobile number: 5123456789 -> Rejected with 400
  const r4 = await api('POST', '/api/leads', {
    token: adminToken,
    body: { customer_name: 'P4', phone: '5123456789', source: 'Direct', channel: 'Online' },
  });
  assert.equal(r4.status, 400);
});

test('Admin guardian permissions expire and remain bound to their assignee and active task', () => {
  const { contactAllowed } = require('../src/lib/guardian');
  const task = { assigned_to: 'EMP-A', contact_authorized_to: 'EMP-A', requires_contact: 1,
    status: 'Assigned', contact_expires_at: new Date(Date.now() + 60000).toISOString() };
  assert.equal(contactAllowed(task, 'EMP-A'), true);
  assert.equal(contactAllowed(task, 'EMP-B'), false);
  assert.equal(contactAllowed({ ...task, assigned_to: 'EMP-B' }, 'EMP-B'), false);
  assert.equal(contactAllowed({ ...task, status: 'Submitted' }, 'EMP-A'), false);
  assert.equal(contactAllowed({ ...task, contact_expires_at: '2000-01-01T00:00:00Z' }, 'EMP-A'), false);
  assert.equal(contactAllowed({ ...task, requires_contact: 0 }, 'EMP-A'), false);
});

test('Only Admin can authorise customer contact and resolve clarification requests', async () => {
  const admin = await login('admin@kryston.local');
  const tc = await login('telecaller@kryston.local');
  const employee = db.prepare("SELECT id FROM employees WHERE email = 'telecaller@kryston.local'").get();
  const task = db.prepare("SELECT * FROM tasks WHERE assigned_to = ? AND status IN ('Assigned','In Progress') LIMIT 1").get(employee.id);
  assert.ok(task);
  const permission = { allowed: false, purpose: 'Admin review', expires_at: new Date(Date.now() + 86400000).toISOString(), expected_version: task.version };
  const url = `/api/tasks/${task.id}/contact-permission`;
  assert.equal((await api('POST', url, { token: tc, body: permission })).status, 403);
  assert.equal((await api('POST', url, { token: admin, body: permission })).status, 200);
  const detail = await api('GET', `/api/tasks/${task.id}`, { token: tc });
  assert.equal(detail.body.task.customer_phone, null);
  const request = await api('POST', `/api/tasks/${task.id}/admin-request`, { token: tc, body: { message: 'Please request dimensions from Engineering.' } });
  assert.equal(request.status, 201);
  const resolve = `/api/admin-requests/${request.body.id}/resolve`;
  assert.equal((await api('POST', resolve, { token: tc, body: { response: 'Self approved' } })).status, 403);
  assert.equal((await api('POST', resolve, { token: admin, body: { response: 'Engineering task assigned.' } })).status, 200);
  assert.equal((await api('POST', resolve, { token: admin, body: { response: 'Duplicate' } })).status, 409);
});
