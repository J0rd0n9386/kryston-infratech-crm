/**
 * Central structured JSON logger using Pino.
 *
 * Implements automated redaction of sensitive credentials and PII,
 * ISO-8601 timestamps, and request-id correlation.
 */
'use strict';

const pino = require('pino');
const config = require('../config');

const REDACT_PATHS = [
  'authorization',
  'headers.authorization',
  'cookie',
  'headers.cookie',
  'phone',
  'phone_normalized',
  'email',
  'password',
  'password_hash',
  'current_password',
  'new_password',
  'tempToken',
  'secret',
  'two_factor_secret',
  'recovery_codes',
  '*.password',
  '*.phone',
  '*.email',
  'req.headers.authorization',
  'req.headers.cookie',
];

const logger = pino({
  level: process.env.LOG_LEVEL || (config.isTest ? 'silent' : 'info'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
