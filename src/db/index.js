/**
 * SQLite connection singleton.
 *
 * The database is opened once, schema migrations are applied synchronously and
 * the optional demo seed runs only when explicitly enabled. Tests set
 * DATABASE_FILE to a temporary path before requiring this module.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { initSchema } = require('./schema');
const { seedDemo } = require('./seed');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
db.pragma('synchronous = NORMAL');

initSchema(db);

if (config.seedDemo) {
  seedDemo(db, bcrypt);
}

module.exports = db;
