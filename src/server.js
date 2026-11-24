/**
 * Process bootstrap.
 *
 * Opens the database through the app factory, starts listening, and shuts down
 * gracefully on SIGINT/SIGTERM so SQLite can checkpoint its WAL cleanly.
 */
'use strict';

const config = require('./config');
const db = require('./db');
const logger = require('./lib/logger');
const { createApp } = require('./app');
const { createOutboxWorker } = require('./lib/notifications/outbox-worker');
const { createSlaBreachJob } = require('./lib/notifications/sla-breach-job');
const { sendDailyDigest } = require('./lib/notifications/daily-digest-job');
const { scheduleBackupJob } = require('./backup');
const { scheduleReminderJob } = require('./jobs/reminders');

const app = createApp(db);

// Initialize background notification worker, SLA monitoring, and scheduled backup
const outboxWorker = createOutboxWorker(db, { intervalMs: config.outboxPollIntervalMs });
const slaJob = createSlaBreachJob(db, { intervalMs: config.slaCheckIntervalMs });
let backupJob = null;
let reminderJob = null;

let digestTimer = null;
function scheduleDailyDigest() {
  digestTimer = setInterval(() => {
    const now = new Date();
    if (now.getHours() === config.dailyDigestHour) {
      try {
        sendDailyDigest(db);
      } catch (err) {
        logger.error({ err }, '[digest] error sending daily digest');
      }
    }
  }, 30 * 60 * 1000); // Check every 30 minutes
  if (digestTimer.unref) digestTimer.unref();
}

const server = app.listen(config.port, config.host, () => {
  outboxWorker.start();
  slaJob.start();
  scheduleDailyDigest();
  try {
    reminderJob = scheduleReminderJob(db);
  } catch (err) {
    logger.error({ err }, '[reminders] error initializing reminder schedule');
  }
  try {
    backupJob = scheduleBackupJob();
  } catch (err) {
    logger.error({ err }, '[backup] error initializing backup schedule');
  }

  logger.info(
    {
      env: config.env,
      url: `http://localhost:${config.port}`,
      database: config.databasePath,
      seedDemo: config.seedDemo,
    },
    'Kryston Infratech CRM started',
  );
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, `Received ${signal}; shutting down`);

  try {
    outboxWorker.stop();
    slaJob.stop();
    if (digestTimer) clearInterval(digestTimer);
    if (backupJob) backupJob.stop();
    if (reminderJob) reminderJob.stop();
  } catch (err) {
    logger.error({ err }, 'Worker stop failed');
  }

  const forceExit = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      logger.error({ err }, 'DB close failed');
    }
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});

module.exports = server;
