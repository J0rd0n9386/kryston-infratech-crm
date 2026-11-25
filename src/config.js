/**
 * Kryston Infratech CRM - Central configuration.
 *
 * Loads .env exactly once, validates production-critical settings and exposes
 * a frozen configuration object. Every other module imports this file so the
 * process cannot accidentally run with two different secrets or database paths.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(ENV_PATH);

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const JWT_SECRET = process.env.JWT_SECRET || '';
const weakSecret =
  !JWT_SECRET ||
  JWT_SECRET.length < 32 ||
  /replace|change[-_ ]?me|development[-_ ]?secret|unsafe|example/i.test(JWT_SECRET);

if (weakSecret && !isTest) {
  throw new Error(
    'JWT_SECRET must be a unique random value of at least 32 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
  );
}

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(ROOT_DIR, 'data');
const databaseFile = process.env.DATABASE_FILE || path.join(dataDir, 'kryston.db');
const databasePath = path.isAbsolute(databaseFile)
  ? databaseFile
  : path.resolve(ROOT_DIR, databaseFile);

const config = Object.freeze({
  rootDir: ROOT_DIR,
  dataDir,
  env: NODE_ENV,
  isProduction,
  isTest,
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  trustProxy: bool(process.env.TRUST_PROXY, false),
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  jwtIssuer: 'kryston-infratech-crm',
  jwtAudience: 'kryston-crm-web',
  databasePath,
  seedDemo: bool(process.env.SEED_DEMO, !isProduction),
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, isTest ? 4 : 12),
  // Development/demo deployments intentionally use one documented shared password.
  // Production still requires a unique password from the environment.
  demoPassword: isProduction ? process.env.DEMO_PASSWORD : 'Admin@12345',
  syncDemoPasswords: bool(process.env.SYNC_DEMO_PASSWORDS, !isProduction),
  loginWindowMs: int(process.env.LOGIN_WINDOW_MS, 15 * 60 * 1000),
  loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 8),
  apiWindowMs: int(process.env.API_WINDOW_MS, 15 * 60 * 1000),
  apiMaxRequests: int(process.env.API_MAX_REQUESTS, 900),
  // Site photos and voice notes travel as size-limited base64 payloads.
  jsonLimit: process.env.JSON_LIMIT || '4mb',
  logRequests: bool(process.env.LOG_REQUESTS, true),
  staticMaxAge: process.env.STATIC_MAX_AGE || '1h',
  idleTimeoutMs: int(process.env.IDLE_TIMEOUT_MS, 30 * 60 * 1000),
  // Attachments & storage
  attachmentMaxSize: int(process.env.ATTACHMENT_MAX_SIZE, 10 * 1024 * 1024),
  attachmentStorageDir: process.env.ATTACHMENT_STORAGE_DIR || path.join(dataDir, 'attachments'),
  uploadStorageDir: process.env.UPLOAD_STORAGE_DIR || path.join(dataDir, 'uploads'),
  backupDir: process.env.BACKUP_DIR || path.join(dataDir, 'backups'),
  // Notifications & channels
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL || 'notifications@kryston.local',
  whatsappEnabled: bool(process.env.WHATSAPP_ENABLED, false),
  whatsappApiToken: process.env.WHATSAPP_API_TOKEN || '',
  whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || '',
  outboxPollIntervalMs: int(process.env.OUTBOX_POLL_INTERVAL_MS, 5000),
  slaCheckIntervalMs: int(process.env.SLA_CHECK_INTERVAL_MS, 60000),
  dailyDigestHour: int(process.env.DAILY_DIGEST_HOUR, 8),
  // Business rules & analytics
  discountApprovalThresholdPercent: int(process.env.DISCOUNT_APPROVAL_THRESHOLD_PERCENT, 10),
  enforceCentral2fa: bool(process.env.ENFORCE_CENTRAL_2FA, isProduction),
  backupRetentionDays: int(process.env.BACKUP_RETENTION_DAYS, 7),
  backupCronSchedule: process.env.BACKUP_CRON_SCHEDULE || '0 2 * * *',
});

if (config.isProduction) {
  if (config.seedDemo) {
    throw new Error('Refusing to start in production: SEED_DEMO must be false in production.');
  }
  if (!process.env.DEMO_PASSWORD || config.demoPassword === 'Admin@12345') {
    throw new Error('Refusing to start in production: DEMO_PASSWORD must be changed from the default value.');
  }
}

module.exports = config;
