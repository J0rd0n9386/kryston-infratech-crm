'use strict';

require('./helpers/environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const { createApp } = require('../src/app');
const { getRequiredApproverRole, isRoleAuthorized } = require('../src/lib/services/approval-service');
const { createDelegation, revokeDelegation, hasActiveDelegation, expireDelegations } = require('../src/lib/services/delegation-service');
const { resolveAutoRouting } = require('../src/lib/services/routing-service');
const { checkStageGate } = require('../src/lib/state-machine');

function createTestContext() {
  const tmpDir = path.join(__dirname, '..', 'data', `test-wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);

  // Seed employees
  db.prepare(`
    INSERT INTO employees (id, name, email, role, department, password_hash, active)
    VALUES
      ('EMP-SUPER', 'Super Admin', 'super@kryston.in', 'SUPER_ADMIN', 'Administration', 'hash', 1),
      ('EMP-ADMIN', 'Admin Desk', 'admin@kryston.in', 'ADMIN_DESK', 'Administration', 'hash', 1),
      ('EMP-SM', 'Sales Manager', 'sm@kryston.in', 'SALES_MANAGER', 'Sales', 'hash', 1),
      ('EMP-SBDM', 'Senior BDM', 'sbdm@kryston.in', 'SENIOR_BDM', 'Sales', 'hash', 1),
      ('EMP-BDM', 'BDM Person', 'bdm@kryston.in', 'BDM', 'Sales', 'hash', 1),
      ('EMP-TC1', 'Telecaller One', 'tc1@kryston.in', 'TELECALLER', 'Marketing', 'hash', 1),
      ('EMP-TC2', 'Telecaller Two', 'tc2@kryston.in', 'TELECALLER', 'Marketing', 'hash', 1),
      ('EMP-ENG', 'Site Engineer', 'eng@kryston.in', 'SITE_ENGINEER', 'Technical', 'hash', 1)
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

test('P2 Workflow Engine - Approval Matrix Unit & Hierarchy', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;

    // Check discount tiers
    assert.equal(getRequiredApproverRole(db, 'quotation_discount', 'discount_percent', 0), null);
    assert.equal(getRequiredApproverRole(db, 'quotation_discount', 'discount_percent', 12.0), 'SALES_MANAGER');
    assert.equal(getRequiredApproverRole(db, 'quotation_discount', 'discount_percent', 18.0), 'SENIOR_BDM');
    assert.equal(getRequiredApproverRole(db, 'quotation_discount', 'discount_percent', 25.0), 'SUPER_ADMIN');

    // Hierarchy authorization
    assert.equal(isRoleAuthorized('SALES_MANAGER', 'SALES_MANAGER'), true);
    assert.equal(isRoleAuthorized('SALES_MANAGER', 'SENIOR_BDM'), false);
    assert.equal(isRoleAuthorized('SALES_MANAGER', 'SUPER_ADMIN'), false);

    assert.equal(isRoleAuthorized('SENIOR_BDM', 'SALES_MANAGER'), true);
    assert.equal(isRoleAuthorized('SENIOR_BDM', 'SENIOR_BDM'), true);
    assert.equal(isRoleAuthorized('SENIOR_BDM', 'SUPER_ADMIN'), false);

    assert.equal(isRoleAuthorized('SUPER_ADMIN', 'SALES_MANAGER'), true);
    assert.equal(isRoleAuthorized('SUPER_ADMIN', 'SENIOR_BDM'), true);
    assert.equal(isRoleAuthorized('SUPER_ADMIN', 'SUPER_ADMIN'), true);
  } finally {
    ctx.cleanup();
  }
});

test('P2 Workflow Engine - Delegations Lifecycle', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;
    const superAdmin = { id: 'EMP-SUPER', role: 'SUPER_ADMIN' };
    const telecaller = { id: 'EMP-TC1', role: 'TELECALLER' };

    // Non-super admin cannot delegate
    assert.throws(() => {
      createDelegation(db, telecaller, {
        delegate_id: 'EMP-TC2',
        start_at: '2026-01-01T00:00:00Z',
        end_at: '2026-01-02T00:00:00Z',
      });
    }, /Only Super Admin/);

    // Active delegation
    const now = new Date();
    const start = new Date(now.getTime() - 60000).toISOString();
    const end = new Date(now.getTime() + 3600000).toISOString();

    const created = createDelegation(db, superAdmin, {
      delegate_id: 'EMP-TC1',
      start_at: start,
      end_at: end,
      reason: 'Vacation coverage',
    });
    assert.ok(created.id);
    assert.equal(hasActiveDelegation(db, 'EMP-TC1', 'ADMIN_DESK'), true);

    // Revocation
    revokeDelegation(db, superAdmin, created.id, 'Early return');
    assert.equal(hasActiveDelegation(db, 'EMP-TC1', 'ADMIN_DESK'), false);

    // Auto-expiry test
    const expiredStart = new Date(now.getTime() - 7200000).toISOString();
    const expiredEnd = new Date(now.getTime() - 3600000).toISOString();
    createDelegation(db, superAdmin, {
      delegate_id: 'EMP-TC2',
      start_at: expiredStart,
      end_at: expiredEnd,
      reason: 'Past delegation',
    });
    const expiredCount = expireDelegations(db);
    assert.ok(expiredCount >= 1);
    assert.equal(hasActiveDelegation(db, 'EMP-TC2', 'ADMIN_DESK'), false);
  } finally {
    ctx.cleanup();
  }
});

test('P2 Workflow Engine - Auto Routing for Online Leads', () => {
  const ctx = createTestContext();
  try {
    const { db } = ctx;

    const routeMeta = resolveAutoRouting(db, { source: 'Meta Ads', channel: 'Online' });
    assert.ok(routeMeta);
    assert.equal(routeMeta.role, 'TELECALLER');
    assert.equal(routeMeta.department, 'Marketing');
    assert.ok(['EMP-TC1', 'EMP-TC2'].includes(routeMeta.assigned_to));

    // Unknown source should not auto route
    const routeWalkin = resolveAutoRouting(db, { source: 'Walk-in', channel: 'Offline' });
    assert.equal(routeWalkin, null);
  } finally {
    ctx.cleanup();
  }
});

test('P2 Workflow Engine - Stage Gate Verification', () => {
  // Missing reason for Lost
  const lostCheckNoReason = checkStageGate('Quotation Stage', 'Lost', {});
  assert.equal(lostCheckNoReason.ok, false);

  const lostCheckWithReason = checkStageGate('Quotation Stage', 'Lost', { reason: 'Price too high' });
  assert.equal(lostCheckWithReason.ok, true);

  // Missing details for Quotation Stage
  const quoteCheckEmpty = checkStageGate('Response Received', 'Quotation Stage', {});
  assert.equal(quoteCheckEmpty.ok, false);

  const quoteCheckWithReq = checkStageGate('Response Received', 'Quotation Stage', { requirement: '3BHK Interior' });
  assert.equal(quoteCheckWithReq.ok, true);
});
