/**
 * Security and authentication suite (Phase 1).
 *
 * Verifies:
 * - httpOnly + SameSite=Strict session cookies and CSRF double-submit protection
 * - Account lockout with exponential backoff and no user enumeration
 * - TOTP 2FA enrollment, TOTP verification, single-use recovery codes, and disabling
 * - Strict Zod validation and unknown field rejection
 * - Idle session timeouts
 * - Commercial IDOR redaction for non-commercial spoke roles
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const otplib = require('otplib');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-crm-sec-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = path.join(tempDir, 'sec-test.db');
process.env.SEED_DEMO = 'true';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_PASSWORD = 'Admin@12345';
process.env.IDLE_TIMEOUT_MS = '1800000'; // 30 minutes

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
    /* ignore */
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function api(method, url, { token, cookies, headers: extraHeaders = {}, body, raw = false } = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookies) headers.cookie = cookies;
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

test('session sets httpOnly and SameSite=Strict cookies on login', async () => {
  const res = await api(
    'POST',
    '/api/login',
    { body: { email: 'admin@kryston.local', password: 'Admin@12345' }, raw: true },
  );
  assert.equal(res.status, 200);

  const setCookie = res.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('kryston_session='), 'must set kryston_session cookie');
  assert.ok(setCookie.includes('HttpOnly'), 'session cookie must be HttpOnly');
  assert.ok(setCookie.includes('SameSite=Strict'), 'session cookie must be SameSite=Strict');
  assert.ok(setCookie.includes('kryston_csrf='), 'must set kryston_csrf cookie');
});

test('state-changing request with cookie session rejects when CSRF token is missing or invalid', async () => {
  const loginRes = await api(
    'POST',
    '/api/login',
    { body: { email: 'admin@kryston.local', password: 'Admin@12345' } },
  );
  assert.equal(loginRes.status, 200);
  const token = loginRes.body.token;

  // 1. Missing CSRF header when using cookie
  const rejectRes = await api('POST', '/api/leads', {
    cookies: `kryston_session=${token}`,
    body: {
      channel: 'Online',
      source: 'Google Ads',
      customer_name: 'CSRF Probe',
      phone: '9876543201',
    },
  });
  assert.equal(rejectRes.status, 403);
  assert.match(rejectRes.body.error, /CSRF/i);

  // 2. Mismatching CSRF header
  const mismatchRes = await api('POST', '/api/leads', {
    cookies: `kryston_session=${token}; kryston_csrf=cookie-token-123`,
    headers: { 'x-csrf-token': 'wrong-header-token' },
    body: {
      channel: 'Online',
      source: 'Google Ads',
      customer_name: 'CSRF Probe',
      phone: '9876543202',
    },
  });
  assert.equal(mismatchRes.status, 403);
  assert.match(mismatchRes.body.error, /CSRF/i);

  // 3. Matching CSRF header passes CSRF check
  const allowRes = await api('POST', '/api/leads', {
    cookies: `kryston_session=${token}; kryston_csrf=matching-token-xyz`,
    headers: { 'x-csrf-token': 'matching-token-xyz' },
    body: {
      channel: 'Online',
      source: 'Google Ads',
      customer_name: 'Valid Lead',
      phone: '9876543203',
    },
  });
  assert.equal(allowRes.status, 201);
});

test('per-account lockout with exponential backoff on repeated failed logins', async () => {
  const targetEmail = 'telecaller@kryston.local';
  // Reset any previous state
  db.prepare('UPDATE employees SET failed_login_attempts = 0, locked_until = NULL WHERE email = ?').run(targetEmail);

  // Send 5 failed attempts
  for (let i = 1; i <= 5; i++) {
    const res = await api('POST', '/api/login', {
      body: { email: targetEmail, password: `wrong-pass-${i}` },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid email or password.');
  }

  // Verify account is now locked in DB
  const lockedEmp = db.prepare('SELECT failed_login_attempts, locked_until FROM employees WHERE email = ?').get(targetEmail);
  assert.ok(lockedEmp.failed_login_attempts >= 5);
  assert.ok(lockedEmp.locked_until);
  assert.ok(new Date(lockedEmp.locked_until).getTime() > Date.now());

  // Subsequent login attempt (even with the correct password) is rejected with generic error
  const lockedRes = await api('POST', '/api/login', {
    body: { email: targetEmail, password: 'Admin@12345' },
  });
  assert.equal(lockedRes.status, 401);
  assert.equal(lockedRes.body.error, 'Invalid email or password.');

  // Verify audit log has no passwords stored
  const auditEntries = db
    .prepare("SELECT details FROM audit_log WHERE action IN ('LOGIN_FAILED', 'ACCOUNT_LOCKED') ORDER BY id DESC LIMIT 5")
    .all();
  for (const entry of auditEntries) {
    assert.doesNotMatch(entry.details, /wrong-pass/i);
    assert.doesNotMatch(entry.details, /Admin@12345/);
  }

  // Clean up lock
  db.prepare('UPDATE employees SET failed_login_attempts = 0, locked_until = NULL WHERE email = ?').run(targetEmail);
  const okRes = await api('POST', '/api/login', {
    body: { email: targetEmail, password: 'Admin@12345' },
  });
  assert.equal(okRes.status, 200);
});

test('TOTP 2FA lifecycle: setup, verify, login with code, wrong code, recovery code and disable', async () => {
  const superAdminEmail = 'superadmin@kryston.local';
  db.prepare('UPDATE employees SET two_factor_enabled = 0, two_factor_secret = NULL, recovery_codes = NULL WHERE email = ?').run(superAdminEmail);

  // 1. Log in to get session
  const loginRes = await api('POST', '/api/login', {
    body: { email: superAdminEmail, password: 'Admin@12345' },
  });
  assert.equal(loginRes.status, 200);
  const token = loginRes.body.token;

  // 2. Setup 2FA
  const setupRes = await api('POST', '/api/2fa/setup', { token });
  assert.equal(setupRes.status, 200);
  assert.ok(setupRes.body.secret);
  assert.ok(setupRes.body.qrCode.startsWith('data:image/png;base64,'));
  assert.equal(setupRes.body.recoveryCodes.length, 10);
  const secret = setupRes.body.secret;
  const recoveryCodes = setupRes.body.recoveryCodes;

  // 3. Verify with wrong code -> fails
  const badVerify = await api('POST', '/api/2fa/verify', {
    token,
    body: { code: '000000' },
  });
  assert.equal(badVerify.status, 400);

  // 4. Verify with valid TOTP code
  const validTotp = otplib.generateSync({ secret });
  const goodVerify = await api('POST', '/api/2fa/verify', {
    token,
    body: { code: validTotp },
  });
  assert.equal(goodVerify.status, 200);
  assert.equal(goodVerify.body.ok, true);

  // DB reflects enabled
  const emp = db.prepare('SELECT two_factor_enabled FROM employees WHERE email = ?').get(superAdminEmail);
  assert.equal(emp.two_factor_enabled, 1);

  // 5. Login step 1: credentials check requires 2FA
  const step1 = await api('POST', '/api/login', {
    body: { email: superAdminEmail, password: 'Admin@12345' },
  });
  assert.equal(step1.status, 200);
  assert.equal(step1.body.requires2FA, true);
  assert.ok(step1.body.tempToken);
  assert.equal(step1.body.token, undefined);
  const tempToken = step1.body.tempToken;

  // 6. Login step 2 with wrong code -> fails
  const step2Bad = await api('POST', '/api/login/2fa', {
    body: { tempToken, code: '000000' },
  });
  assert.equal(step2Bad.status, 401);

  // 7. Login step 2 with valid TOTP code -> succeeds
  const freshTotp = otplib.generateSync({ secret });
  const step2Good = await api('POST', '/api/login/2fa', {
    body: { tempToken, code: freshTotp },
  });
  assert.equal(step2Good.status, 200);
  assert.ok(step2Good.body.token);
  assert.equal(step2Good.body.user.email, superAdminEmail);

  // 8. Login step 2 using recovery code
  const step1Rec = await api('POST', '/api/login', {
    body: { email: superAdminEmail, password: 'Admin@12345' },
  });
  assert.equal(step1Rec.status, 200);
  const recCode = recoveryCodes[0];

  const step2Rec = await api('POST', '/api/login/2fa', {
    body: { tempToken: step1Rec.body.tempToken, code: recCode },
  });
  assert.equal(step2Rec.status, 200);
  assert.ok(step2Rec.body.token);

  // 9. Reusing the exact same recovery code fails (single-use)
  const step1Reuse = await api('POST', '/api/login', {
    body: { email: superAdminEmail, password: 'Admin@12345' },
  });
  const step2Reuse = await api('POST', '/api/login/2fa', {
    body: { tempToken: step1Reuse.body.tempToken, code: recCode },
  });
  assert.equal(step2Reuse.status, 401);

  // 10. Disable 2FA with password + code
  const sessionToken = step2Rec.body.token;
  const badDisable = await api('POST', '/api/2fa/disable', {
    token: sessionToken,
    body: { password: 'wrong-password', code: otplib.generateSync({ secret }) },
  });
  assert.equal(badDisable.status, 400);

  const goodDisable = await api('POST', '/api/2fa/disable', {
    token: sessionToken,
    body: { password: 'Admin@12345', code: otplib.generateSync({ secret }) },
  });
  assert.equal(goodDisable.status, 200);
  assert.equal(goodDisable.body.ok, true);

  // Direct login now succeeds without 2FA
  const directLogin = await api('POST', '/api/login', {
    body: { email: superAdminEmail, password: 'Admin@12345' },
  });
  assert.equal(directLogin.status, 200);
  assert.equal(directLogin.body.requires2FA, undefined);
  assert.ok(directLogin.body.token);
});

test('zod validation rejects unknown fields with 400 and typed requestId error', async () => {
  const res = await api('POST', '/api/login', {
    body: {
      email: 'admin@kryston.local',
      password: 'Admin@12345',
      unknown_rogue_field: 'attack',
    },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.requestId);
  assert.match(res.body.error, /unrecognized|unknown/i);
});

test('idle timeout revokes session after inactivity threshold', async () => {
  const loginRes = await api('POST', '/api/login', {
    body: { email: 'admin@kryston.local', password: 'Admin@12345' },
  });
  assert.equal(loginRes.status, 200);
  const token = loginRes.body.token;

  // Set last_active_at in DB to 35 minutes ago (idle timeout is 30m)
  const idleTime = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  db.prepare('UPDATE employees SET last_active_at = ? WHERE id = ?').run(idleTime, loginRes.body.user.id);

  const res = await api('GET', '/api/me', { token });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /inactivity/i);
});

test('IDOR fix: non-commercial spoke cannot inspect commercial quotations or work order values', async () => {
  const adminLogin = await api('POST', '/api/login', {
    body: { email: 'admin@kryston.local', password: 'Admin@12345' },
  });
  const adminToken = adminLogin.body.token;

  const engineerLogin = await api('POST', '/api/login', {
    body: { email: 'engineer@kryston.local', password: 'Admin@12345' },
  });
  const engineerToken = engineerLogin.body.token;
  const engineerId = engineerLogin.body.user.id;

  // 1. Admin creates a lead and routes it to Engineering
  const leadRes = await api('POST', '/api/leads', {
    token: adminToken,
    body: {
      customer_name: 'Commercial Privacy Test',
      phone: '9876543099',
      source: 'Website',
      channel: 'Online',
    },
  });
  assert.equal(leadRes.status, 201);
  const leadId = leadRes.body.id;

  // Telecaller qualification step
  const tcLogin = await api('POST', '/api/login', {
    body: { email: 'telecaller@kryston.local', password: 'Admin@12345' },
  });
  await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: adminToken,
    body: { telecaller_id: tcLogin.body.user.id },
  });
  await api('POST', '/api/telecaller/respond', {
    token: tcLogin.body.token,
    body: {
      lead_id: leadId,
      call_outcome: 'Connected',
      customer_intent: 'Hot',
      budget_range: '50-75L',
    },
  });

  // Admin routes to Technical (assigned to engineer)
  await api('POST', `/api/leads/${leadId}/route`, {
    token: adminToken,
    body: {
      department: 'Technical',
      assigned_to: engineerId,
      task_type: 'SITE_VISIT',
      brief: 'Inspect structural drawings',
    },
  });

  // Add a quotation directly into the DB for this lead to test redaction
  db.prepare(
    `INSERT INTO quotations (id, lead_id, version, amount, tax_amount, status, created_by)
     VALUES (?, ?, 1, 1500000, 270000, 'Sent', ?)`,
  ).run(`KRY-QUOT-TEST-${Date.now()}`, leadId, adminLogin.body.user.id);

  // Set lead work order value
  db.prepare('UPDATE leads SET wo_value = 1770000 WHERE id = ?').run(leadId);

  // 2. Site Engineer accesses the lead: commercial fields must be redacted
  const engView = await api('GET', `/api/leads/${leadId}`, { token: engineerToken });
  assert.equal(engView.status, 200);
  assert.equal(engView.body.lead.customer_name, 'Commercial Privacy Test');
  assert.equal(engView.body.lead.wo_value, null, 'wo_value must be null for non-commercial roles');
  assert.deepEqual(engView.body.quotations, [], 'quotations array must be empty for non-commercial roles');
  assert.equal(engView.body.workOrder, null, 'workOrder must be null for non-commercial roles');

  // 3. Admin accesses the lead: commercial details are visible
  const adminView = await api('GET', `/api/leads/${leadId}`, { token: adminToken });
  assert.equal(adminView.status, 200);
  assert.equal(adminView.body.lead.wo_value, 1770000);
  assert.equal(adminView.body.quotations.length, 1);
  assert.equal(adminView.body.quotations[0].amount, 1500000);

  // 4. Site Engineer attempting to read a task assigned to another engineer is denied (403)
  const anotherTask = db
    .prepare("SELECT id FROM tasks WHERE assigned_to != ? LIMIT 1")
    .get(engineerId);
  if (anotherTask) {
    const taskDeny = await api('GET', `/api/tasks/${anotherTask.id}`, { token: engineerToken });
    assert.equal(taskDeny.status, 403);
  }
});

test('IDOR fix: non-commercial spoke has commercial fields redacted on work orders and projects', async () => {
  const adminLogin = await api('POST', '/api/login', {
    body: { email: 'admin@kryston.local', password: 'Admin@12345' },
  });
  const engineerLogin = await api('POST', '/api/login', {
    body: { email: 'engineer@kryston.local', password: 'Admin@12345' },
  });

  // Seed a work order and project assigned to the engineer
  const woId = `KRY-WO-TEST-${Date.now()}`;
  const projId = `KRY-PROJ-TEST-${Date.now()}`;
  const lead = db.prepare('SELECT id FROM leads LIMIT 1').get();

  db.prepare(
    `INSERT INTO work_orders (id, lead_id, amount, customer_approval_date, details, status, created_by)
     VALUES (?, ?, 2500000, '2030-01-01', 'Test scope', 'Finalized', ?)`,
  ).run(woId, lead.id, adminLogin.body.user.id);

  db.prepare(
    `INSERT INTO projects (id, work_order_id, lead_id, project_manager, site_engineer, status)
     VALUES (?, ?, ?, ?, ?, 'Planning')`,
  ).run(projId, woId, lead.id, adminLogin.body.user.id, engineerLogin.body.user.id);

  // Engineer accesses work order: commercial fields are redacted
  const engWoRes = await api('GET', `/api/work-orders/${woId}`, { token: engineerLogin.body.token });
  assert.equal(engWoRes.status, 200);
  assert.equal(engWoRes.body.amount, null);

  // Engineer accesses project: contract_amount and workOrder pricing are redacted
  const engProjRes = await api('GET', `/api/projects/${projId}`, { token: engineerLogin.body.token });
  assert.equal(engProjRes.status, 200);
  assert.equal(engProjRes.body.project.contract_amount, null);
  assert.equal(engProjRes.body.workOrder.amount, null);

  // Central admin accesses project: sees full contract values
  const adminProjRes = await api('GET', `/api/projects/${projId}`, { token: adminLogin.body.token });
  assert.equal(adminProjRes.status, 200);
  assert.equal(adminProjRes.body.project.contract_amount, 2500000);
  assert.equal(adminProjRes.body.workOrder.amount, 2500000);
});

test('zod validation rejects unknown fields in mutation routes with 400', async () => {
  const adminLogin = await api('POST', '/api/login', {
    body: { email: 'admin@kryston.local', password: 'Admin@12345' },
  });

  const res = await api('POST', '/api/leads', {
    token: adminLogin.body.token,
    body: {
      customer_name: 'Test Unknown Field Lead',
      phone: '9876543111',
      source: 'Website',
      channel: 'Online',
      malicious_extra_field: 'injected',
    },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.requestId);
  assert.match(res.body.error, /unrecognized|unknown/i);
});

test('production hardening rejects startup with SEED_DEMO=true or default DEMO_PASSWORD', () => {
  const { execSync } = require('child_process');
  
  // Test 1: SEED_DEMO=true in production must throw
  assert.throws(() => {
    execSync('node -e "process.env.NODE_ENV=\'production\'; process.env.JWT_SECRET=\'a-very-long-production-secret-of-length-48-chars!\'; process.env.SEED_DEMO=\'true\'; process.env.DEMO_PASSWORD=\'ProdPass!123\'; require(\'./src/config\');"', {
      stdio: 'pipe',
    });
  }, /SEED_DEMO must be false in production/);

  // Test 2: default DEMO_PASSWORD in production must throw
  assert.throws(() => {
    execSync('node -e "process.env.NODE_ENV=\'production\'; process.env.JWT_SECRET=\'a-very-long-production-secret-of-length-48-chars!\'; process.env.SEED_DEMO=\'false\'; process.env.DEMO_PASSWORD=\'Admin@12345\'; require(\'./src/config\');"', {
      stdio: 'pipe',
    });
  }, /DEMO_PASSWORD must be changed/);
});
