/**
 * One-time initial Super Admin bootstrap.
 *
 * Run this on a fresh installation when SEED_DEMO=false. It refuses to run if
 * any employee already exists, so it can never silently reset or add a second
 * privileged account to a live database.
 *
 * Usage: npm run bootstrap-admin
 */
'use strict';

const path = require('path');
const readline = require('readline');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const config = require('../src/config');
const { initSchema } = require('../src/db/schema');
const { assertPassword, isValidEmail } = require('../src/middleware/validate');

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer).trim())));
}

function askHidden(rl, question) {
  return new Promise((resolve) => {
    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = () => rl.output.write('*');
    rl.output.write(question);
    rl.question('', (answer) => {
      rl._writeToOutput = originalWrite;
      rl.output.write('\n');
      resolve(String(answer));
    });
  });
}

async function main() {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma('foreign_keys = ON');
  initSchema(db);

  const existing = db.prepare('SELECT count(*) AS c FROM employees').get().c;
  if (existing > 0) {
    db.close();
    // eslint-disable-next-line no-console
    console.error(
      `Refusing to bootstrap: ${existing} employee record(s) already exist in ${config.databasePath}.`,
    );
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-console
    console.log('Kryston Infratech CRM - initial Super Admin setup');
    // eslint-disable-next-line no-console
    console.log('This runs once, only on an empty database.\n');

    const name = (await ask(rl, 'Full name: ')) || 'Super Admin';
    const email = (await ask(rl, 'Email: ')).toLowerCase();
    if (!isValidEmail(email)) throw new Error('Enter a valid email address.');

    const phone = (await ask(rl, 'Phone (optional): ')) || null;
    const password = await askHidden(rl, 'Password (min 12 chars, letter + number): ');
    assertPassword(password);
    const confirm = await askHidden(rl, 'Confirm password: ');
    if (password !== confirm) throw new Error('Passwords do not match.');

    const hash = bcrypt.hashSync(password, config.bcryptRounds);
    const id = 'KRY-SA-001';

    db.prepare(
      `INSERT INTO employees (id, name, email, phone, password_hash, role, department, active)
       VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 'Management', 1)`,
    ).run(id, name.slice(0, 120), email, phone, hash);

    // eslint-disable-next-line no-console
    console.log(`\nSuper Admin created: ${id} <${email}>`);
    // eslint-disable-next-line no-console
    console.log('Sign in at /login, then create Admin Desk and department accounts from Employees.');
  } finally {
    rl.close();
    db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`Bootstrap failed: ${err.message}`);
  process.exitCode = 1;
});
