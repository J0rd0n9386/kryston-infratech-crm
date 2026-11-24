/**
 * "My Day" and attachment integration tests.
 *
 * Verifies the task-first home payload for Admin Desk and for a spoke, the
 * sidebar badge counters, and the photo / voice-note attachment loop against a
 * real site inspection.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-myday-test-'));
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
    // Remove only the files this test produced; never the shared upload folder.
    const files = db.prepare('SELECT file_url FROM lead_attachments').all();
    for (const file of files) {
      fs.rmSync(path.join(__dirname, '..', 'data', 'uploads', path.basename(file.file_url)), {
        force: true,
      });
    }
  } catch {
    /* best effort */
  }
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

async function login(email) {
  const res = await api('POST', '/api/login', {
    body: { email, password: 'Admin@12345' },
  });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

test('Admin Desk receives an Action Required queue on My Day', async () => {
  const admin = await login('admin@kryston.local');
  const res = await api('GET', '/api/my-day', { token: admin });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const day = res.body;
  assert.equal(day.scope, 'central');
  assert.ok(day.today);
  assert.ok(day.summary);
  assert.equal(typeof day.summary.actionRequired, 'number');
  assert.ok(Array.isArray(day.items));
  assert.ok(Array.isArray(day.recentActivity));

  assert.ok(day.actionQueue.groups.length >= 3);
  const send = day.actionQueue.groups.find((group) => group.key === 'send');
  assert.ok(send, 'a "send" group must exist');
  assert.ok(send.items.length >= 1, 'seeded Response Received / New leads should need action');

  const routeItem = send.items.find((item) => item.action === 'route_lead');
  assert.ok(routeItem, 'a lead must be offered routing');
  assert.equal(routeItem.kind, 'lead');
  assert.equal(routeItem.stage, 'Response Received');
  assert.ok(routeItem.customer_name);
  assert.ok(routeItem.phone);
  assert.equal(day.actionQueue.total, send.count);

  // The queue counts must agree with the summary.
  assert.equal(day.summary.actionRequired, day.actionQueue.total);

  const labels = day.actionQueue.groups.map((group) => group.key);
  for (const key of ['send', 'review', 'approve_work', 'quotes']) {
    assert.ok(labels.includes(key), `missing action group ${key}`);
  }
});

test('a Site Engineer receives their own tasks with a clear next action', async () => {
  const engineer = await login('engineer@kryston.local');
  const res = await api('GET', '/api/my-day', { token: engineer });
  assert.equal(res.status, 200);

  const day = res.body;
  assert.equal(day.scope, 'spoke');
  assert.equal(day.actionQueue.total, 0);
  assert.ok(day.items.length >= 1);

  const siteItem = day.items.find((item) => item.task_type === 'SITE_VISIT');
  assert.ok(siteItem, 'the seeded site visit must appear on the engineer My Day');
  assert.equal(siteItem.action, 'submit_site_report');
  assert.equal(siteItem.bucket, 'urgent');
  assert.equal(siteItem.stage, 'Routed to Engineering');
  assert.ok(siteItem.customer_name);
  assert.ok(siteItem.sla && siteItem.sla.status);
  assert.ok(day.summary.totalToday >= 1);
});

test('a Telecaller receives a "call the customer" action', async () => {
  const telecaller = await login('telecaller@kryston.local');
  const res = await api('GET', '/api/my-day', { token: telecaller });
  assert.equal(res.status, 200);
  const call = res.body.items.find((item) => item.task_type === 'TELECALLER_ENQUIRY');
  assert.ok(call, 'the assigned enquiry task must appear');
  assert.equal(call.action, 'log_call');
  assert.equal(call.bucket, 'late');
  assert.equal(call.phone, null, 'Legacy assignment requires explicit Admin contact permission');
});

test('sidebar badges are cheap role-scoped counters', async () => {
  const admin = await login('admin@kryston.local');
  const adminBadges = await api('GET', '/api/badges', { token: admin });
  assert.equal(adminBadges.status, 200);
  assert.ok(adminBadges.body.actionRequired >= 1);
  assert.ok(adminBadges.body.myWork >= 0);

  const engineer = await login('engineer@kryston.local');
  const engineerBadges = await api('GET', '/api/badges', { token: engineer });
  assert.equal(engineerBadges.status, 200);
  assert.equal(engineerBadges.body.actionRequired, 0);
  assert.ok(engineerBadges.body.myWork >= 1);
});

test('site inspection photos and voice notes are stored, listed and access-controlled', async () => {
  const admin = await login('admin@kryston.local');
  const telecaller = await login('telecaller@kryston.local');
  const engineer = await login('engineer@kryston.local');
  const architect = await login('architect@kryston.local');

  const phone = `7${Date.now().toString().slice(-9)}`;
  const created = await api('POST', '/api/leads', {
    token: admin,
    body: {
      customer_name: 'Attachment Flow Customer',
      phone,
      source: 'Walk-in',
      channel: 'Offline',
      location: 'Sector 70, Noida',
      requirement: 'Site inspection for a duplex interior',
      priority: 'High',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const leadId = created.body.id;

  const assigned = await api('POST', `/api/leads/${leadId}/assign-telecaller`, {
    token: admin,
    body: { telecaller_id: 'KRY-TC-001', instructions: 'Qualify and confirm a site visit.' },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));

  const responded = await api('POST', '/api/telecaller/respond', {
    token: telecaller,
    body: {
      lead_id: leadId,
      call_outcome: 'Connected',
      customer_intent: 'Hot',
      requirement_detail: 'Needs a structural inspection before quoting.',
    },
  });
  assert.equal(responded.status, 201, JSON.stringify(responded.body));

  const routed = await api('POST', `/api/leads/${leadId}/route`, {
    token: admin,
    body: {
      department: 'Technical',
      assigned_to: 'KRY-SE-001',
      task_type: 'SITE_INSPECTION',
      brief: 'Inspect structure, electrical and plumbing.',
      sla_hours: 24,
    },
  });
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  const taskId = routed.body.task_id;

  const visit = await api('POST', '/api/site-visits', {
    token: engineer,
    body: {
      lead_id: leadId,
      task_id: taskId,
      visit_date: new Date().toISOString().slice(0, 10),
      technical_report: 'Structure sound. Electrical needs a new DB. Plumbing route clear.',
    },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  assert.ok(visit.body.site_visit_id, 'the visit id is required to attach evidence');
  const siteVisitId = visit.body.site_visit_id;

  const pngBase64 = Buffer.from('fake-png-bytes-for-test').toString('base64');
  const photo = await api('POST', '/api/attachments', {
    token: engineer,
    body: {
      entity_type: 'site_visit',
      entity_id: String(siteVisitId),
      file_name: 'east-wall.png',
      mime_type: 'image/png',
      caption: 'East wall crack',
      data: `data:image/png;base64,${pngBase64}`,
    },
  });
  assert.equal(photo.status, 201, JSON.stringify(photo.body));
  assert.equal(photo.body.is_image, true);
  assert.equal(photo.body.caption, 'East wall crack');
  const photoId = photo.body.id;

  const voice = await api('POST', '/api/attachments', {
    token: engineer,
    body: {
      entity_type: 'site_visit',
      entity_id: String(siteVisitId),
      file_name: 'site-note.webm',
      mime_type: 'audio/webm',
      data: `data:audio/webm;base64,${Buffer.from('fake-audio').toString('base64')}`,
    },
  });
  assert.equal(voice.status, 201, JSON.stringify(voice.body));
  assert.equal(voice.body.is_audio, true);

  // The whole lead dossier includes evidence from the linked site visit.
  const list = await api('GET', `/api/attachments?lead_id=${encodeURIComponent(leadId)}`, {
    token: admin,
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);
  assert.ok(list.body.some((file) => file.file_name === 'east-wall.png'));
  assert.ok(list.body.some((file) => file.file_name === 'site-note.webm'));

  // An authenticated read returns the exact bytes and mime type.
  const file = await api('GET', `/api/attachments/${photoId}/file`, { token: engineer, raw: true });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.toString(), 'fake-png-bytes-for-test');

  // Unrelated employees cannot read or write the evidence.
  const deniedRead = await api('GET', `/api/attachments/${photoId}/file`, {
    token: architect,
    raw: true,
  });
  assert.equal(deniedRead.status, 403);

  const deniedUpload = await api('POST', '/api/attachments', {
    token: architect,
    body: {
      entity_type: 'site_visit',
      entity_id: String(siteVisitId),
      file_name: 'should-fail.png',
      mime_type: 'image/png',
      data: `data:image/png;base64,${pngBase64}`,
    },
  });
  assert.equal(deniedUpload.status, 403);

  // Oversized payloads are rejected with an actionable message.
  const tooBig = Buffer.alloc(2 * 1024 * 1024 + 10).toString('base64');
  const rejected = await api('POST', '/api/attachments', {
    token: engineer,
    body: {
      entity_type: 'site_visit',
      entity_id: String(siteVisitId),
      file_name: 'huge.png',
      mime_type: 'image/png',
      data: tooBig,
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /2 MB/);
});
