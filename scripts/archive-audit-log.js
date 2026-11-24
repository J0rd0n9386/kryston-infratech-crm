/**
 * Kryston Infratech CRM - Audit Log Archival Utility.
 *
 * Usage: npm run archive-audit
 *        node scripts/archive-audit-log.js [destination-file]
 *
 * Exports audit_log rows older than 2 years to an archival JSONL file.
 * NON-NEGOTIABLE RULE: NEVER delete rows from the ledger table.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

function defaultArchiveDestination() {
  const stamp = new Date().toISOString().slice(0, 10);
  return path.join(config.rootDir, 'data', 'archives', `audit_log_archive_${stamp}.jsonl`);
}

function archiveAuditLog(dbOrPath, destination = defaultArchiveDestination()) {
  let db;
  let shouldClose = false;

  if (typeof dbOrPath === 'string') {
    db = new Database(dbOrPath);
    shouldClose = true;
  } else if (dbOrPath && typeof dbOrPath.prepare === 'function') {
    db = dbOrPath;
  } else {
    db = new Database(config.databasePath);
    shouldClose = true;
  }

  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    // Select all audit log records older than 2 years
    const rows = db
      .prepare(
        `SELECT * FROM audit_log
         WHERE created_at < datetime('now', '-2 years')
         ORDER BY id ASC`,
      )
      .all();

    if (rows.length > 0) {
      const content = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.appendFileSync(destination, content, 'utf8');
    } else {
      fs.writeFileSync(destination, '', 'utf8');
    }

    // Log the archival action to the ledger table itself
    const adminUser = db.prepare("SELECT id FROM employees WHERE role = 'SUPER_ADMIN' LIMIT 1").get();
    const actorId = adminUser ? adminUser.id : null;

    db.prepare(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
       VALUES (?, 'ARCHIVE_AUDIT_LOG', 'system', 'audit_log', ?)`,
    ).run(actorId, `Archived ${rows.length} records older than 2 years to ${path.basename(destination)} (ledger preserved, 0 rows deleted)`);

    return {
      destination,
      rowsArchived: rows.length,
    };
  } finally {
    if (shouldClose) {
      db.close();
    }
  }
}

if (require.main === module) {
  try {
    const dest = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
    const result = archiveAuditLog(config.databasePath, dest);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        message: 'Audit log archival completed (ledger preserved without deletions)',
        ...result,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  }
}

module.exports = { archiveAuditLog, defaultArchiveDestination };
