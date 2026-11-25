"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('Existing .env preserved.');
} else if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || !process.env.DEMO_PASSWORD) {
    throw new Error('Configure JWT_SECRET and DEMO_PASSWORD in the production environment before starting.');
  }
  console.log('Production environment variables detected; no .env file created.');
} else {
  let content = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  content = content.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + crypto.randomBytes(48).toString('hex'));
  content = content.replace(/^DEMO_PASSWORD=.*$/m, 'DEMO_PASSWORD=' + crypto.randomBytes(24).toString('hex'));
  fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  console.log('Created private .env with unique random credentials.');
}
