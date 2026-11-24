/**
 * Reminders Cron Job.
 *
 * Runs daily at 09:00 IST and on an hourly sweep at :05 past every hour.
 * Evaluates pending reminders, triggers due items, generates Admin RE_ENGAGE tasks,
 * notifies users, and logs timeline/audit ledgers.
 */
'use strict';

const cron = require('node-cron');
const dbInstance = require('../db');
const logger = require('../lib/logger');
const { APP_TIMEZONE, now: clockNow } = require('../lib/clock');
const { runDueReminders: serviceRunDue } = require('../lib/services/reminder-service');
const { expireDelegations } = require('../lib/services/delegation-service');

function runDueReminders(checkTime = clockNow(), db = dbInstance) {
  try {
    expireDelegations(db);
    return serviceRunDue(db, checkTime);
  } catch (err) {
    logger.error({ err }, '[reminders-job] error running due reminders');
    return [];
  }
}

function scheduleReminderJob(db = dbInstance, options = {}) {
  const timezone = options.timezone || APP_TIMEZONE;

  // 1. Morning trigger at 09:00 IST
  const morningTask = cron.schedule(
    '0 9 * * *',
    () => {
      runDueReminders(clockNow(), db);
    },
    { timezone },
  );

  // 2. Hourly sweep at minute 5 to catch any reminders if server was down at 09:00
  const hourlySweepTask = cron.schedule(
    '5 * * * *',
    () => {
      runDueReminders(clockNow(), db);
    },
    { timezone },
  );

  return {
    start() {
      morningTask.start();
      hourlySweepTask.start();
    },
    stop() {
      morningTask.stop();
      hourlySweepTask.stop();
    },
  };
}

module.exports = {
  runDueReminders,
  scheduleReminderJob,
};
