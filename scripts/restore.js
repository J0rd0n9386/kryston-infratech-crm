/**
 * Kryston Infratech CRM - Database Restore Utility.
 *
 * Usage: npm run restore -- <backup-file>
 *        node scripts/restore.js <backup-file> [destination]
 *
 * Verifies snapshot integrity before restoring, applies safe atomic restore,
 * and validates the resulting database with PRAGMA integrity_check and foreign_key_check.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

async function restore(backupFilePath, destinationPath = config.databasePath) {
  if (!backupFilePath) {
    throw new Error('Usage: npm run restore -- <backup-file>');
  }

  const resolvedSource = path.resolve(backupFilePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Backup file not found: ${resolvedSource}`);
  }

  const resolvedDest = path.resolve(destinationPath);

  // Step 1: Verify source backup integrity before doing anything
  const sourceDb = new Database(resolvedSource, { readonly: true, fileMustExist: true });
  try {
    const integrity = sourceDb.prepare('PRAGMA integrity_check').all();
    const errors = integrity.map((row) => Object.values(row)[0]).filter((value) => value !== 'ok');
    if (errors.length) {
      throw new Error(`Integrity check failed on backup file: ${errors.join('; ')}`);
    }
  } finally {
    sourceDb.close();
  }

  // Step 2: Ensure destination directory exists
  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });

  // Clean up existing WAL/SHM files at destination if replacing
  const walPath = `${resolvedDest}-wal`;
  const shmPath = `${resolvedDest}-shm`;
  if (fs.existsSync(walPath)) {
    try { fs.unlinkSync(walPath); } catch { /* ignore */ }
  }
  if (fs.existsSync(shmPath)) {
    try { fs.unlinkSync(shmPath); } catch { /* ignore */ }
  }

  // Step 3: Perform atomic SQLite backup copy into destination
  const source = new Database(resolvedSource, { readonly: true });
  try {
    await source.backup(resolvedDest);
  } finally {
    source.close();
  }

  // Step 4: Validate restored database
  const restoredDb = new Database(resolvedDest, { readonly: true });
  try {
    const postIntegrity = restoredDb.prepare('PRAGMA integrity_check').all();
    const postErrors = postIntegrity.map((row) => Object.values(row)[0]).filter((value) => value !== 'ok');
    if (postErrors.length) {
      throw new Error(`Post-restore integrity check failed: ${postErrors.join('; ')}`);
    }

    const fkChecks = restoredDb.prepare('PRAGMA foreign_key_check').all();
    if (fkChecks.length) {
      throw new Error(`Post-restore foreign key check failed: ${JSON.stringify(fkChecks)}`);
    }

    const leads = restoredDb.prepare('SELECT count(*) AS c FROM leads').get().c;
    const employees = restoredDb.prepare('SELECT count(*) AS c FROM employees').get().c;

    return {
      restoredFrom: resolvedSource,
      destination: resolvedDest,
      leads,
      employees,
    };
  } finally {
    restoredDb.close();
  }
}

if (require.main === module) {
  const targetBackup = process.argv[2];
  const targetDest = process.argv[3];

  restore(targetBackup, targetDest)
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          ok: true,
          message: 'Database restored successfully',
          ...result,
        }),
      );
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ ok: false, error: err.message }));
      process.exitCode = 1;
    });
}

module.exports = { restore };
