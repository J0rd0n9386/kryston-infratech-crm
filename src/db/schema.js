/**
 * Kryston Infratech Enterprise CRM - database schema.
 * ============================================================================
 * SQLite schema for turnkey construction, architecture, interior and infratech
 * operations.
 *
 * Guarantees:
 *  - Hub-and-spoke governance encoded in tables, statuses and constraints.
 *  - Domain CHECK constraints for roles, departments, stages and statuses.
 *  - Referential integrity with explicit ON DELETE rules.
 *  - Append-only ledgers for the lead timeline and the global audit log.
 *  - FTS5 search over leads with real-time trigger synchronisation.
 *  - Composite indexes tuned for Kanban, SLA and dashboard queries.
 *  - Idempotent, additive column migrations for existing installations.
 * ============================================================================
 */
'use strict';

const logger = require('../lib/logger');
const { runMigrations } = require('./migrations');

const ROLES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN_DESK',
  'SALES_MANAGER',
  'SENIOR_BDM',
  'BDM',
  'BDE',
  'TELECALLER',
  'SITE_ENGINEER',
  'ARCHITECT',
  'DIGITAL_MARKETING',
  'PROJECT_MANAGER',
  'PURCHASE',
  'ACCOUNTS',
]);

const DEPARTMENTS = Object.freeze([
  'Management',
  'Administration',
  'Sales',
  'Marketing',
  'Technical',
  'Design',
  'Projects',
  'Purchase',
  'Accounts',
]);

const STAGES = Object.freeze([
  'New',
  'With Telecaller',
  'Response Received',
  'Routed to Sales',
  'Routed to Engineering',
  'Routed to Design',
  'Routed to Purchase',
  'Routed to Accounts',
  'Update Received',
  'Follow-up Required',
  'Site Visit Scheduled',
  'Design In Progress',
  'Quotation Stage',
  'Quotation Sent',
  'Negotiation',
  'Approved',
  'Work Order Pending Admin Approval',
  'Work Order Finalized',
  'Project Handoff',
  'In Progress',
  'Completed',
  'Closed',
  'Lost',
  'Nurture',
]);

const PRIORITIES = Object.freeze(['Low', 'Medium', 'High', 'Urgent']);

const TASK_STATUSES = Object.freeze([
  'Assigned',
  'In Progress',
  'Submitted',
  'Reviewed',
  'Closed',
  'Cancelled',
]);

const TASK_TYPES = Object.freeze([
  'TELECALLER_ENQUIRY',
  'SITE_VISIT',
  'SITE_INSPECTION',
  'DESIGN_PREPARATION',
  'SALES_REVIEW',
  'QUOTATION_PROPOSAL',
  'MATERIAL_CHECK',
  'MATERIAL_PROCUREMENT',
  'VENDOR_COSTING',
  'COSTING_ESTIMATE',
  'PROJECT_EXECUTION',
  'GENERAL_FOLLOWUP',
]);

const SCHEMA_METADATA = Object.freeze({
  version: '2.2.0',
  schemaId: 'KRYSTON_INFRATECH_CRM_V2',
  roles: ROLES,
  departments: DEPARTMENTS,
  stages: STAGES,
  priorities: PRIORITIES,
  taskStatuses: TASK_STATUSES,
  taskTypes: TASK_TYPES,
});

function applyPragmas(db) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 10000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');
}

function initSchema(db) {
  applyPragmas(db);
  runMigrations(db);

  // A partial unique index enforces phone dedup for live leads without blocking
  // soft-deleted historical rows. Skip gracefully if legacy duplicates exist.
  try {
    const duplicates = db
      .prepare(
        `SELECT phone FROM leads
         WHERE deleted_at IS NULL
         GROUP BY phone HAVING count(*) > 1 LIMIT 1`,
      )
      .get();
    if (!duplicates) {
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_phone_active ON leads(phone) WHERE deleted_at IS NULL',
      );
    }
  } catch (err) {
    logger.warn({ err }, '[schema] phone index notice');
  }

  initFullTextSearch(db);
}

function initFullTextSearch(db) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS leads_fts USING fts5(
        id UNINDEXED,
        customer_name,
        phone,
        email,
        location,
        requirement,
        area,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS trg_leads_fts_ai AFTER INSERT ON leads BEGIN
        INSERT INTO leads_fts (id, customer_name, phone, email, location, requirement, area)
        VALUES (
          NEW.id,
          NEW.customer_name,
          NEW.phone,
          coalesce(NEW.email, ''),
          coalesce(NEW.location, ''),
          coalesce(NEW.requirement, ''),
          coalesce(NEW.area, '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_leads_fts_ad AFTER DELETE ON leads BEGIN
        DELETE FROM leads_fts WHERE id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_leads_fts_au AFTER UPDATE ON leads BEGIN
        DELETE FROM leads_fts WHERE id = OLD.id;
        INSERT INTO leads_fts (id, customer_name, phone, email, location, requirement, area)
        VALUES (
          NEW.id,
          NEW.customer_name,
          NEW.phone,
          coalesce(NEW.email, ''),
          coalesce(NEW.location, ''),
          coalesce(NEW.requirement, ''),
          coalesce(NEW.area, '')
        );
      END;
    `);

    db.exec(`
      INSERT INTO leads_fts (id, customer_name, phone, email, location, requirement, area)
      SELECT id, customer_name, phone, coalesce(email, ''), coalesce(location, ''), coalesce(requirement, ''), coalesce(area, '')
      FROM leads
      WHERE id NOT IN (SELECT id FROM leads_fts);
    `);
  } catch (err) {
    logger.warn({ err }, '[fts5] initialization warning');
  }
}

function recordMigration(db, version, name, description) {
  try {
    const existing = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
    if (!existing) {
      db.prepare(
        'INSERT INTO schema_migrations (version, name, description) VALUES (?, ?, ?)',
      ).run(version, name, description);
    }
  } catch (err) {
    logger.warn({ err }, '[migration] record notice');
  }
}

function buildFtsQuery(query) {
  if (!query || typeof query !== 'string' || !query.trim()) return null;
  const tokens = query
    .trim()
    .replace(/["'*^:()\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((word) => `"${word}"*`);
  return tokens.length ? tokens.join(' ') : null;
}

function searchLeadsFts(db, query, limit = 50) {
  const match = buildFtsQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `SELECT l.*, rank
       FROM leads_fts fts
       JOIN leads l ON l.id = fts.id
       WHERE leads_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

function verifySchemaIntegrity(db) {
  const integrityRows = db.prepare('PRAGMA integrity_check').all();
  const integrityErrors = integrityRows
    .map((row) => Object.values(row)[0])
    .filter((message) => message !== 'ok');
  const fkRows = db.prepare('PRAGMA foreign_key_check').all();
  return {
    valid: integrityErrors.length === 0 && fkRows.length === 0,
    integrityErrors,
    fkErrors: fkRows,
  };
}

function getDatabaseStats(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

  const rowCounts = {};
  for (const table of tables) {
    try {
      rowCounts[table] = db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
    } catch {
      rowCounts[table] = -1;
    }
  }

  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const pageCount = db.prepare('PRAGMA page_count').get().page_count;
  const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;

  return {
    tablesCount: tables.length,
    totalSizeBytes: pageSize * pageCount,
    journalMode,
    rowCounts,
  };
}

module.exports = {
  initSchema,
  applyPragmas,
  syncTableColumns: () => {},
  verifySchemaIntegrity,
  getDatabaseStats,
  searchLeadsFts,
  buildFtsQuery,
  SCHEMA_METADATA,
  ROLES,
  DEPARTMENTS,
  STAGES,
  PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
};
