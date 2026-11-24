'use strict';

require('./helpers/environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { initSchema } = require('../src/db/schema');
const { logOutcome } = require('../src/lib/services/contact-service');

test('Call Log Enhancements: logs call purpose, budget, requirement type, and area into activity ledger and lead', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryston-call-log-test-'));
  const tempDbPath = path.join(tempDir, 'test.db');
  const db = new Database(tempDbPath);

  try {
    initSchema(db);

    const telecaller = {
      id: 'KRY-TC-001',
      name: 'Pooja Telecaller',
      role: 'TELECALLER',
      department: 'Marketing',
    };

    db.prepare(`
      INSERT INTO employees (id, name, email, phone, role, department, password_hash, active)
      VALUES (?, ?, 'tc-test@kryston.local', '+91 98765 00001', ?, ?, 'hash', 1)
    `).run(telecaller.id, telecaller.name, telecaller.role, telecaller.department);

    const leadId = 'KRY-LEAD-TEST01';
    db.prepare(`
      INSERT INTO leads (id, channel, source, customer_name, phone, stage, current_owner, created_by)
      VALUES (?, 'Online', 'Google Ads', 'Vikram Malhotra', '+91 98765 11223', 'With Telecaller', ?, ?)
    `).run(leadId, telecaller.id, telecaller.id);

    const taskId = 'KRY-TASK-TEST01';
    db.prepare(`
      INSERT INTO tasks (id, lead_id, assigned_to, assigned_by, department, task_type, brief, status, requires_contact, contact_status)
      VALUES (?, ?, ?, ?, 'Marketing', 'TELECALLER_ENQUIRY', 'Call lead Vikram', 'Assigned', 1, 'NOT_CONTACTED')
    `).run(taskId, leadId, telecaller.id, telecaller.id);

    // Call log payload with new fields
    const payload = {
      outcome: 'CONNECTED',
      call_purpose: 'Initial Enquiry',
      requirement_type: 'Interior',
      customer_budget: '15L-50L',
      location_area: 'DLF Phase 5, Gurgaon',
      notes: 'Customer wants false ceiling and modular kitchen.',
    };

  db.prepare("UPDATE tasks SET contact_authorized_to = assigned_to, contact_expires_at = datetime('now', '+2 days'), contact_purpose = 'Test qualification call'").run();

    const res = logOutcome(db, telecaller, taskId, payload);
    assert.equal(res.ok, true);

    // Verify task_activity ledger
    const activity = db.prepare('SELECT * FROM task_activity WHERE task_id = ?').get(taskId);
    assert.equal(activity.outcome, 'CONNECTED');
    assert.equal(activity.call_purpose, 'Initial Enquiry');
    assert.equal(activity.requirement_type, 'Interior');
    assert.equal(activity.customer_budget, '15L-50L');
    assert.equal(activity.location_area, 'DLF Phase 5, Gurgaon');
    assert.ok(activity.notes.includes('false ceiling'));

    // Verify lead timeline remark contains structured tags
    const action = db.prepare('SELECT * FROM lead_actions WHERE lead_id = ? AND action_type = ?').get(leadId, 'CALL_OUTCOME');
    assert.ok(action, 'CALL_OUTCOME action recorded');
    assert.ok(action.remarks.includes('[Connected]'), 'Remarks has [Connected]');
    assert.ok(action.remarks.includes('[Initial Enquiry]'), 'Remarks has [Initial Enquiry]');
    assert.ok(action.remarks.includes('Requirement: Interior'), 'Remarks has Requirement');
    assert.ok(action.remarks.includes('Budget: 15L-50L'), 'Remarks has Budget');

    // Verify lead record updated
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    assert.equal(lead.budget_range, '15L-50L');
    assert.equal(lead.area, 'DLF Phase 5, Gurgaon');
    assert.equal(lead.call_purpose, 'Initial Enquiry');
    assert.equal(lead.requirement_type, 'Interior');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
