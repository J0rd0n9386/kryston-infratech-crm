/**
 * Application clock and timezone utilities.
 *
 * All database timestamps are UTC.
 * All date-only fields (due_date, next_action_date) are stored in application local date (YYYY-MM-DD).
 * Application timezone defaults to Asia/Kolkata (IST).
 */
'use strict';

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

let fixedTime = null;

function now() {
  if (fixedTime !== null) {
    return new Date(fixedTime);
  }
  return new Date();
}

function isoNow() {
  return now().toISOString();
}

function setFixedTime(value) {
  if (value === null || value === undefined) {
    fixedTime = null;
  } else {
    fixedTime = new Date(value).getTime();
  }
}

function advanceTime(ms) {
  const current = now().getTime();
  fixedTime = current + ms;
}

function reset() {
  fixedTime = null;
}

/**
 * Returns the hour (0-23) in the local application timezone (Asia/Kolkata).
 */
function hourLocal(date = now()) {
  const d = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return Number.parseInt(formatter.format(d), 10);
}

/**
 * Returns YYYY-MM-DD in the local application timezone (Asia/Kolkata)
 */
function todayLocal(date = now()) {
  const d = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(d);
}

/**
 * Returns YYYY-MM-DD for date + days in the local application timezone (Asia/Kolkata)
 */
function addDaysLocal(days, date = now()) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  d.setDate(d.getDate() + days);
  return todayLocal(d);
}

/**
 * Formats a timestamp or date into IST string like '23 Nov 2026, 3:45 PM'
 */
function formatIST(dateOrIso) {
  if (!dateOrIso) return '—';
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (Number.isNaN(d.getTime())) return String(dateOrIso);

  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: APP_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return formatter.format(d);
}

module.exports = {
  APP_TIMEZONE,
  now,
  isoNow,
  setFixedTime,
  advanceTime,
  reset,
  hourLocal,
  todayLocal,
  addDaysLocal,
  formatIST,
};
