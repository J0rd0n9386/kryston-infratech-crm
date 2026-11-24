/**
 * Creates clean project distribution zip file excluding node_modules, temp files, and caches.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const zipName = `Kryston_Infratech_v${pkg.version}.zip`;
const outPath = path.join(rootDir, zipName);
const parentOutPath = path.join(rootDir, '..', zipName);
const stagingDir = path.join(rootDir, 'staging_zip');

if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

const excludeTop = new Set([
  'node_modules',
  'staging_zip',
  'data',
  'backups',
  '.git',
  '.gemini',
  '.env',
  '.env.local',
  'coverage',
]);

const PROHIBITED_PATTERNS = [
  /\bdata[\\/]/i,
  /\bbackups[\\/]/i,
  /\.env(\..+)?$/i,
  /\.db(-\w+)?$/i,
  /\battachments[\\/]/i,
];

function shouldExclude(name, fullPath) {
  if (name === '.env.example') return false;
  if (name.endsWith('.zip')) return true;
  if (name.endsWith('.db') || name.includes('.db-wal') || name.includes('.db-shm')) return true;
  if (name.startsWith('.env') && name !== '.env.example') return true;
  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(fullPath)) return true;
  }
  return false;
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      const childSrc = path.join(src, file);
      const childDst = path.join(dst, file);
      if (shouldExclude(file, childSrc)) continue;
      copyRecursive(childSrc, childDst);
    }
  } else {
    if (!shouldExclude(path.basename(src), src)) {
      fs.copyFileSync(src, dst);
    }
  }
}

for (const item of fs.readdirSync(rootDir)) {
  if (excludeTop.has(item) || item.endsWith('.zip') || shouldExclude(item, path.join(rootDir, item))) continue;
  copyRecursive(path.join(rootDir, item), path.join(stagingDir, item));
}

if (fs.existsSync(outPath)) {
  fs.unlinkSync(outPath);
}

const psScript = `
Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${outPath}' -Force;
Add-Type -AssemblyName System.IO.Compression.FileSystem;
$zip = [System.IO.Compression.ZipFile]::OpenRead('${outPath}');
$leakFound = $false;
foreach ($entry in $zip.Entries) {
  $p = $entry.FullName;
  if ($p -match '(^|[\\\\/])(data|backups|attachments)[\\\\/]' -or $p -match '\\.db(-wal|-shm)?$' -or ($p -match '(^|[\\\\/])\\.env$' -and $p -notmatch '\\.env\\.example')) {
    Write-Error "LEAK DETECTED in zip archive: $p";
    $leakFound = $true;
  }
}
$zip.Dispose();
if ($leakFound) {
  Remove-Item '${outPath}' -Force;
  exit 1;
}
Copy-Item '${outPath}' '${parentOutPath}' -Force;
`;

const tempPsFile = path.join(rootDir, 'scripts', 'temp-zip.ps1');
fs.writeFileSync(tempPsFile, psScript, 'utf8');

try {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPsFile}"`, { stdio: 'inherit' });
  const stats = fs.statSync(outPath);
  console.log(`Successfully created verified clean archive ${zipName}: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
} finally {
  if (fs.existsSync(tempPsFile)) {
    fs.unlinkSync(tempPsFile);
  }
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
