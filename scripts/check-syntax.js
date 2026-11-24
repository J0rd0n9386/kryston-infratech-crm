/**
 * Syntax gate used by `npm run check`.
 * Runs `node --check` over every first-party JavaScript file so a typo cannot
 * reach the server or the browser bundle unnoticed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = ['src', 'scripts', 'tests', 'public'];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}

targets.forEach((target) => walk(path.join(root, target)));

let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures += 1;
    // eslint-disable-next-line no-console
    console.error(`FAIL ${path.relative(root, file)}\n${result.stderr}`);
  }
}

if (failures === 0) {
  // eslint-disable-next-line no-console
  console.log(`Syntax OK: ${files.length} JavaScript file(s).`);
} else {
  process.exitCode = 1;
}
