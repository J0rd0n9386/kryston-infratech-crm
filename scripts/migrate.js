#!/usr/bin/env node
/**
 * Kryston Infratech CRM - Database migration CLI.
 *
 * Runs all pending numbered SQL migrations against the configured database.
 * Safe to execute multiple times (idempotent).
 */
'use strict';

const db = require('../src/db');
const { runMigrations, getAppliedVersions } = require('../src/db/migrations');

function main() {
  try {
    const beforeCount = getAppliedVersions(db).size;
    const applied = runMigrations(db, {
      logger: (msg) => console.log(msg),
    });

    if (applied.length === 0) {
      console.log(`Database is already up to date (${beforeCount} migration(s) recorded).`);
    } else {
      console.log(`Successfully applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

main();
