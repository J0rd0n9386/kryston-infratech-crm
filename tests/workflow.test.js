/**
 * End-to-end workflow tests.
 *
 * A temporary SQLite database is seeded with the demo organisation, the app is
 * mounted on an ephemeral port and the entire hub-and-spoke lifecycle is driven
 * over HTTP: intake → telecaller → Admin routing → Sales review → quotation →
 * work order → Admin approval/handoff → project execution.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-crm-test-'));
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
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, email);
  return res.body.token;
}

test('health endpoint is public and reports the database', async () => {
  const res = await api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.database, 'ok');
  assert.ok(res.body.timestamp);
});

test('protected endpoints require a session', async () => {
  const res = await api('GET', '/api/leads');
  assert.equal(res.status, 401);
  assert.match(res.body.error, /Authentication required/i);
});

test('login rejects a wrong password without revealing the account', async () => {
  const res = await api('POST', '/api/login', {
    body: { email: 'admin@kryston.local', password: 'wrong-password-123' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Invalid email or password.');
});

test('security headers enforce a strict content security policy', async () => {
  const res = await api('GET', '/', { raw: true });
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('modular client is served without inline handlers', async () => {
  const index = await api('GET', '/', { raw: true });
  assert.equal(index.status, 200);
  const html = await index.text();
  for (const asset of [
    '/js/core.js',
    '/js/pages.js',
    '/js/work.js',
    '/js/commercial.js',
    '/js/admin.js',
    '/js/boot.js',
  ]) {
    assert.ok(html.includes(asset), `index must load ${asset}`);
    const res = await api('GET', asset, { raw: true });
    assert.equal(res.status, 200, `${asset} should be served`);
    assert.ok((await res.text()).length > 100);
  }
  assert.doesNotMatch(html, /\/app\.js/);
  assert.doesNotMatch(html, /on(click|submit|change|input)=/i);
  assert.doesNotMatch(html, /style="/i);
});

test('full hub-and-spoke lifecycle', async () => {
  const admin = await login('admin@kryston.local');
  const telecaller = await login('telecaller@kryston.local');
  const bdm = await login('bdm@kryston.local');
  const manager = await login('salesmanager@kryston.local');
  const pm = await login('projectmanager@kryston.local');

  // 1. Admin Desk intake
  const phone = `9${Date.now().toString().slice(-9)}`;
  const created = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Integration Test Customer',
      phone,
      source: 'Website',
      channel: 'Online',
      email: 'integration@example.com',
      location: 'Sector 18, Noida',
      area: '2400 sq ft',
      requirement: 'Turnkey interior with modular kitchen',
      budget_range: '30 - 40 Lakhs',
      timeline: '2 months',
      priority: 'High',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const leadId = created.body.id;
  assert.match(leadId, /^KRY-LEAD-\d{4}-\d{4}$/);
  assert.equal(created.body.stage, 'New');

  // Duplicate phone is rejected with actionable detail.
  const duplicate = await api('POST', '/api/leads', {
    token: admin,
    body: { customer_name: 'Duplicate', phone, source: 'Website' },
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /Duplicate phone number/);
  assert.match(duplicate.body.error, new RegExp(leadId));

  // 2. Assign telecaller (creates the access-boundary task)
  const assigned = await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: admin,
    body: { telecaller_id: 'KRY-TC-001', instructions: 'Qualify budget and intent.' },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.ok(assigned.body.task_id);

  // Spoke sees only its assigned lead, never the whole register.
  const tcLeads = await api('GET', '/api/telecaller/leads', { token: telecaller });
  assert.equal(tcLeads.status, 200);
  assert.ok(tcLeads.body.some((lead) => lead.id === leadId));
  const allLeadsAsTc = await api('GET', '/api/leads', { token: telecaller });
  assert.equal(allLeadsAsTc.status, 200);
  assert.ok(
    !allLeadsAsTc.body.some((lead) => lead.customer_name === 'Rajesh Sharma'),
    'an unassigned lead must not be visible to a telecaller',
  );

  // 3. Telecaller submits the enquiry to Admin Desk
  const responded = await api('POST', '/api/telecaller/respond', {
    token: telecaller,
    body: {
      lead_id: leadId,
      call_outcome: 'Connected',
      customer_intent: 'Hot',
      budget_range: '32 - 38 Lakhs',
      timeline: '6 weeks',
      requirement_detail: 'Full home interior, false ceiling and modular kitchen.',
      notes: 'Decision maker available on weekends.',
      next_followup: '2030-01-01',
    },
  });
  assert.equal(responded.status, 201, JSON.stringify(responded.body));
  assert.equal(responded.body.stage, 'Response Received');

  // 4. Admin routes one task to Sales
  const routed = await api('POST', `/api/leads/${leadId}/route`, {
    token: admin,
    body: {
      department: 'Sales',
      assigned_to: 'KRY-BDM-001',
      task_type: 'SALES_REVIEW',
      brief: 'Validate scope and prepare the commercial proposal.',
      sla_hours: 48,
    },
  });
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  assert.equal(routed.body.stage, 'Routed to Sales');
  const taskId = routed.body.task_id;

  // A spoke cannot route work to another department.
  const tcRoute = await api('POST', `/api/leads/${leadId}/route`, {
    token: telecaller,
    body: { department: 'Design', assigned_to: 'KRY-AR-001', task_type: 'DESIGN_PREPARATION', brief: 'x' },
  });
  assert.equal(tcRoute.status, 403);

  // 5. Sales works the task and submits back to Admin Desk
  const started = await api('PATCH', `/api/tasks/${taskId}/status`, {
    token: bdm,
    body: { status: 'In Progress' },
  });
  assert.equal(started.status, 200);
  await api('POST', `/api/tasks/${taskId}/contact`, {
    token: bdm,
    body: { outcome: 'CONNECTED', notes: 'Scope validated with customer.' },
  });
  const submitted = await api('POST', `/api/tasks/${taskId}/response`, {
    token: bdm,
    body: { findings: 'Scope validated at 36L with a 6 week programme.', recommendation: 'Proceed to quotation.' },
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.status, 'Submitted');

  // 6. Admin reviews and advances to quotation
  const reviewed = await api('POST', `/api/tasks/${taskId}/review`, {
    token: admin,
    body: { review_remarks: 'Approved for quotation.', next_action: 'Prepare v1.' },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));

  const debugTasks = db.prepare('SELECT id, status, lead_id FROM tasks WHERE lead_id = ?').all(leadId);
  assert.ok(
    debugTasks.every((task) => ['Reviewed', 'Closed', 'Cancelled'].includes(task.status)),
    `open tasks remain: ${JSON.stringify(debugTasks)}`,
  );

  const advanced = await api('POST', `/api/leads/${leadId}/advance-to-quotation`, {
    token: admin,
    body: {},
  });
  assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
  assert.equal(advanced.body.stage, 'Quotation Stage');

  // 7. Assigned Sales employee creates and sends the quotation
  const quote = await api('POST', '/api/quotations', {
    token: bdm,
    body: {
      lead_id: leadId,
      amount: 3600000,
      tax_amount: 648000,
      terms: '30% advance, 40% on structure, 30% on handover.',
      payment_milestones: 'Advance / Structure / Handover',
    },
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const quoteId = quote.body.id;
  assert.equal(quote.body.version, 1);

  const sent = await api('PATCH', `/api/quotations/${quoteId}`, {
    token: admin,
    body: { status: 'Sent', remarks: 'Sent to the customer by email.' },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.lead_stage, 'Quotation Sent');

  // A BDE/BDM cannot approve a quotation.
  const selfApprove = await api('PATCH', `/api/quotations/${quoteId}`, {
    token: bdm,
    body: { status: 'Approved' },
  });
  assert.equal(selfApprove.status, 403);

  // 8. Sales Manager approves the quotation
  const approvedQuote = await api('PATCH', `/api/quotations/${quoteId}`, {
    token: admin,
    body: { status: 'Approved', remarks: 'Commercials approved.' },
  });
  assert.equal(approvedQuote.status, 200, JSON.stringify(approvedQuote.body));
  assert.equal(approvedQuote.body.lead_stage, 'Approved');

  // 9. Sales Manager submits the work order: it must stay pending Admin approval.
  const workOrder = await api('POST', '/api/work-orders', {
    token: manager,
    body: {
      lead_id: leadId,
      quotation_id: quoteId,
      amount: 3600000,
      customer_approval_date: '2030-01-02',
      details: 'Turnkey execution as per approved scope.',
    },
  });
  assert.equal(workOrder.status, 201, JSON.stringify(workOrder.body));
  assert.equal(workOrder.body.status, 'Pending Admin Approval');
  const workOrderId = workOrder.body.id;

  const projectsBefore = await api('GET', '/api/projects', { token: admin });
  const projectCountBefore = projectsBefore.body.length;

  // Only Admin Desk can approve and hand off.
  const managerApprove = await api('POST', `/api/work-orders/${workOrderId}/approve`, {
    token: manager,
    body: { pm_id: 'KRY-PM-001', site_engineer_id: 'KRY-SE-001' },
  });
  assert.equal(managerApprove.status, 403);

  // 10. Admin approves, assigns PM + Site Engineer and creates the project.
  const handoff = await api('POST', `/api/work-orders/${workOrderId}/approve`, {
    token: admin,
    body: {
      pm_id: 'KRY-PM-001',
      site_engineer_id: 'KRY-SE-001',
      target_completion: '2030-03-01',
      milestones: ['Mobilization', 'Civil works', 'Finishing', 'Handover'],
    },
  });
  assert.equal(handoff.status, 201, JSON.stringify(handoff.body));
  const projectId = handoff.body.project_id;
  assert.match(projectId, /^KRY-PROJ-\d{4}-\d{4}$/);

  const projectsAfter = await api('GET', '/api/projects', { token: admin });
  assert.equal(projectsAfter.body.length, projectCountBefore + 1);

  const leadDetail = await api('GET', `/api/leads/${leadId}`, { token: admin });
  assert.equal(leadDetail.status, 200);
  assert.equal(leadDetail.body.lead.stage, 'Project Handoff');
  assert.equal(leadDetail.body.project.id, projectId);
  assert.equal(leadDetail.body.project.milestones.length, 4);

  // 11. PM reports progress and moves the project into execution.
  const progress = await api('POST', `/api/projects/${projectId}/updates`, {
    token: pm,
    body: { update_type: 'Progress', details: 'Site mobilized and civil work started.', progress: 15 },
  });
  assert.equal(progress.status, 201, JSON.stringify(progress.body));

  const finalLead = await api('GET', `/api/leads/${leadId}`, { token: admin });
  assert.equal(finalLead.body.lead.stage, 'In Progress');
  assert.ok(finalLead.body.timeline.some((entry) => entry.action_type === 'PROJECT_HANDOFF'));
  assert.ok(finalLead.body.timeline.some((entry) => entry.action_type === 'WORK_ORDER_FINALIZED'));

  // 12. Spoke dashboards never expose organisation-wide revenue.
  const spokeDashboard = await api('GET', '/api/dashboard', { token: bdm });
  assert.equal(spokeDashboard.status, 200);
  assert.equal(spokeDashboard.body.scope, 'spoke');
  assert.equal(spokeDashboard.body.counts.totalRevenue, 0);
  assert.ok(spokeDashboard.body.counts.totalLeads < 100);

  const centralDashboard = await api('GET', '/api/dashboard', { token: admin });
  assert.equal(centralDashboard.body.scope, 'central');
  assert.ok(centralDashboard.body.counts.totalRevenue > 0);
});

test('direct stage changes are restricted to Lost and Nurture with a reason', async () => {
  const admin = await login('admin@kryston.local');
  const lead = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Stage Guard Customer',
      phone: `8${Date.now().toString().slice(-9)}`,
      source: 'Walk-in',
    },
  });
  assert.equal(lead.status, 201);

  const arbitrary = await api('PATCH', `/api/leads/${lead.body.id}/stage`, {
    token: admin,
    body: { stage: 'Approved' },
  });
  assert.equal(arbitrary.status, 400);

  const noReason = await api('PATCH', `/api/leads/${lead.body.id}/stage`, {
    token: admin,
    body: { stage: 'Lost' },
  });
  assert.equal(noReason.status, 400);

  const lost = await api('PATCH', `/api/leads/${lead.body.id}/stage`, {
    token: admin,
    body: { stage: 'Lost', remarks: 'Customer postponed indefinitely.' },
  });
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  assert.equal(lost.body.new_stage, 'Lost');
});

test('timeline and audit ledgers reject updates and deletes', async () => {
  assert.throws(() => db.prepare("UPDATE lead_actions SET remarks = 'tampered' WHERE id = 1").run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM lead_actions WHERE id = 1').run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = 1").run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run(), /immutable/);
});

test('exports produce CSV and Excel-compatible downloads', async () => {
  const admin = await login('admin@kryston.local');

  const csv = await api('GET', '/api/export/leads.csv', { token: admin, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText, /Customer Name/);

  const xls = await api('GET', '/api/export/timeline.xls', { token: admin, raw: true });
  assert.equal(xls.status, 200);
  assert.match(xls.headers.get('content-type'), /vnd\.ms-excel/);
  const xlsText = await xls.text();
  assert.match(xlsText, /<Workbook/);
  assert.match(xlsText, /urn:schemas-microsoft-com:office:spreadsheet/);

  // Spokes cannot export organisation data.
  const bdm = await login('bdm@kryston.local');
  const denied = await api('GET', '/api/export/leads.csv', { token: bdm });
  assert.equal(denied.status, 403);
});

test('employee administration enforces role, password and hierarchy rules', async () => {
  const admin = await login('admin@kryston.local');

  const weak = await api('POST', '/api/employees', {
    token: admin,
    body: {
      name: 'Weak Password',
      email: 'weak@kryston.local',
      role: 'BDE',
      department: 'Sales',
      password: 'short1',
    },
  });
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /12 characters/);

  const badRole = await api('POST', '/api/employees', {
    token: admin,
    body: {
      name: 'Bad Role',
      email: 'badrole@kryston.local',
      role: 'SUPERUSER',
      department: 'Sales',
      password: 'ValidPassword123',
    },
  });
  assert.equal(badRole.status, 400);

  const created = await api('POST', '/api/employees', {
    token: admin,
    body: {
      name: 'New BDE',
      email: `bde.${Date.now()}@kryston.local`,
      role: 'BDE',
      department: 'Sales',
      password: 'ValidPassword123',
      manager_id: 'KRY-SM-001',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.id, /^KRY-BDE-\d{3}$/);

  const duplicateEmail = await api('POST', '/api/employees', {
    token: admin,
    body: {
      name: 'Duplicate Email',
      email: created.body.email,
      role: 'BDE',
      department: 'Sales',
      password: 'ValidPassword123',
    },
  });
  assert.equal(duplicateEmail.status, 409);

  // A spoke cannot create employees.
  const bdm = await login('bdm@kryston.local');
  const denied = await api('POST', '/api/employees', {
    token: bdm,
    body: { name: 'X', email: 'x@kryston.local', role: 'BDE', department: 'Sales', password: 'ValidPassword123' },
  });
  assert.equal(denied.status, 403);
});
