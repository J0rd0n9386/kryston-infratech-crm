/**
 * Consistent SQLite snapshot.
 *
 * Uses better-sqlite3's online backup API, which is safe while the server is
 * running: SQLite copies a transactionally consistent page set rather than the
 * raw file (raw copies can miss WAL contents). The snapshot is verified with
 * PRAGMA integrity_check before it is reported as successful.
 *
 * Usage: npm run backup [-- <destination-file>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const config = require('./config');
const logger = require('./lib/logger');

function defaultDestination() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return path.join(config.rootDir, 'backups', `kryston-${stamp}.db`);
}

async function backup(destination = defaultDestination()) {
  if (!fs.existsSync(config.databasePath)) {
    throw new Error(`Database file not found: ${config.databasePath}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const source = new Database(config.databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destination);
  } finally {
    source.close();
  }

  const snapshot = new Database(destination, { readonly: true });
  try {
    const integrity = snapshot.prepare('PRAGMA integrity_check').all();
    const errors = integrity.map((row) => Object.values(row)[0]).filter((value) => value !== 'ok');
    if (errors.length) {
      throw new Error(`Backup integrity check failed: ${errors.join('; ')}`);
    }
    const leads = snapshot.prepare('SELECT count(*) AS c FROM leads').get().c;
    const employees = snapshot.prepare('SELECT count(*) AS c FROM employees').get().c;
    const bytes = fs.statSync(destination).size;
    return { destination, bytes, leads, employees };
  } finally {
    snapshot.close();
  }
}

function pruneBackups(backupDir = path.join(config.rootDir, 'backups'), retentionDays = config.backupRetentionDays) {
  if (!fs.existsSync(backupDir)) {
    return { prunedCount: 0, deletedFiles: [] };
  }

  const files = fs.readdirSync(backupDir);
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const deletedFiles = [];

  for (const file of files) {
    if (!file.endsWith('.db')) continue;
    const fullPath = path.join(backupDir, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoffTime) {
        fs.unlinkSync(fullPath);
        deletedFiles.push(file);
      }
    } catch {
      /* ignore file access errors */
    }
  }

  return { prunedCount: deletedFiles.length, deletedFiles };
}

function scheduleBackupJob(options = {}) {
  const schedule = options.schedule || config.backupCronSchedule || '0 2 * * *';
  const task = cron.schedule(schedule, async () => {
    try {
      const result = await backup();
      const pruned = pruneBackups(undefined, options.retentionDays || config.backupRetentionDays);
      logger.info(
        {
          file: result.destination,
          sizeBytes: result.bytes,
          pruned: pruned.prunedCount,
        },
        'Scheduled backup completed successfully',
      );
    } catch (err) {
      logger.error({ err }, 'Scheduled backup failed');
    }
  });

  return task;
}

if (require.main === module) {
  backup(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
    .then((result) => {
      // Prune after manual backup as well
      const pruned = pruneBackups();
      logger.info(
        {
          ok: true,
          file: result.destination,
          sizeBytes: result.bytes,
          leads: result.leads,
          employees: result.employees,
          prunedCount: pruned.prunedCount,
        },
        'Manual backup completed',
      );
    })
    .catch((err) => {
      logger.error({ err }, 'Manual backup failed');
      process.exitCode = 1;
    });
}

module.exports = { backup, defaultDestination, pruneBackups, scheduleBackupJob };
