/**
 * Numbered SQL migration runner.
 *
 * Scans the `migrations/` directory, checks `schema_migrations`, and applies
 * unapplied migrations in strict numerical order inside database transactions.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

const MIGRATION_METADATA = {
  1: { name: '2.1.0-enterprise-schema', description: 'Enterprise schema with FTS5, strict CHECKs, and triggers' },
  2: { name: '2.2.0-hardening', description: 'Session revocation, SLA timestamps, work-order approval and quote review fields' },
  3: { name: '2.3.0-auth-security', description: 'Lockout tracking, idle sessions, and TOTP two-factor authentication' },
  4: { name: '2.4.0-optimistic-locking-and-indexes', description: 'Optimistic locking versions, phone normalization, duplicate tracking, and performance indexes' },
  5: { name: '2.5.0-attachments-and-notifications', description: 'Enterprise attachments storage, MIME validation, notification outbox, and preferences' },
  6: { name: '2.6.0-analytics-and-business', description: 'Lead enterprise fields, quotation versioning, and discount threshold approvals' },
  7: { name: '2.4.0-calling-queue-and-reminders', description: 'Calling Queue, My Work, Auto-Reminders, and task activity ledger' },
  8: { name: '2.4.1-call-log-enhancements', description: 'Call log purpose, budget, requirement type, and area fields' },
  9: { name: '2.5.0-auth-hardening', description: 'Force password change on initial login' },
  10: { name: '3.0.0-workflow-engine', description: 'Rework caps, approval matrix, delegations, routing rules, SLA policies' },
  11: { name: '3.1.0-site-visit-and-boq', description: 'Site visit scheduling and BOQ line items with integer paise' },
  12: { name: '3.2.0-invoicing-and-payments', description: 'Payment milestones, invoices, and append-only payment ledger' },
  13: { name: '3.3.0-execution-and-procurement', description: 'Change orders, purchase requests, and customer updates' },
  14: { name: '3.4.0-handover-and-warranty', description: 'Snag items, warranties, and handover audit' },
  15: { name: '3.5.0-admin-guardian', description: 'Admin contact permissions and department requests' },
  16: { name: '3.6.0-industry-workflows', description: 'Negotiation revisions, contact channels and project handoff acknowledgement' },
  17: { name: '3.7.0-site-visit-cost-estimation', description: 'Site engineer construction cost estimation, civil, MEP, interior breakdown and sales negotiation advice' },
};

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function getAppliedVersions(db) {
  ensureMigrationTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  return new Set(rows.map((r) => r.version));
}

function parseMigrationFile(fileName) {
  const match = fileName.match(/^(\d+)[-_](.+)\.sql$/i);
  if (!match) return null;
  return {
    version: parseInt(match[1], 10),
    slug: match[2],
    fileName,
  };
}

function listMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  const entries = fs.readdirSync(migrationsDir);
  return entries
    .map(parseMigrationFile)
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

function runMigrations(db, options = {}) {
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const logger = typeof options.logger === 'function' ? options.logger : null;

  ensureMigrationTable(db);
  const appliedVersions = getAppliedVersions(db);
  const files = listMigrationFiles(migrationsDir);

  const appliedNow = [];

  for (const item of files) {
    if (appliedVersions.has(item.version)) {
      continue;
    }

    const filePath = path.join(migrationsDir, item.fileName);
    const sql = fs.readFileSync(filePath, 'utf8');

    const meta = MIGRATION_METADATA[item.version] || {
      name: `${item.version}.${item.slug}`,
      description: item.slug.replace(/[-_]/g, ' '),
    };

    const applyTx = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, description, applied_at) VALUES (?, ?, ?, datetime(\'now\'))',
      ).run(item.version, meta.name, meta.description);
    });

    try {
      applyTx();
      appliedNow.push(item.fileName);
      if (logger) logger(`[migration] applied ${item.fileName} (${meta.name})`);
    } catch (err) {
      const msg = `[migration] failed on ${item.fileName}: ${err.message}`;
      if (logger) logger(msg);
      throw new Error(msg);
    }
  }

  return appliedNow;
}

module.exports = {
  runMigrations,
  getAppliedVersions,
  listMigrationFiles,
  ensureMigrationTable,
};
