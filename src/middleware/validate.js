/**
 * Input validation and normalisation helpers.
 *
 * Values are normalised and bounded before they reach SQLite. Output escaping
 * is handled by the browser client; this layer never mutates domain meaning.
 */
'use strict';

const { z } = require('zod');
const { ValidationError } = require('./errors');

const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function validate(schemas = {}) {
  return (req, res, next) => {
    try {
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query);
      }
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      return next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issues = err.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
          code: i.code,
        }));
        const message =
          issues.map((i) => `${i.field ? i.field + ': ' : ''}${i.message}`).join(', ') ||
          'Validation failed';
        return next(new ValidationError(message, issues));
      }
      return next(err);
    }
  };
}

function requireFields(...fields) {
  return (req, res, next) => {
    const body = req.body || {};
    const missing = fields.filter(
      (field) => body[field] === undefined || body[field] === null || String(body[field]).trim() === '',
    );
    if (missing.length) {
      return next(new ValidationError(`Missing required field(s): ${missing.join(', ')}`));
    }
    return next();
  };
}

function sanitizeText(value, maxLength = 5000) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .replace(CONTROL_CHARS_RE, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return text.slice(0, maxLength);
}

// Backwards-compatible name used across the route modules.
const sanitize = sanitizeText;

function normalizePhone(phone) {
  let cleaned = String(phone ?? '').replace(/\D/g, '');
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
}

function isValidPhone(phone) {
  return PHONE_RE.test(normalizePhone(phone));
}

function isValidEmail(email) {
  if (email === undefined || email === null || String(email).trim() === '') return false;
  return EMAIL_RE.test(String(email).trim());
}

function passwordIssues(password) {
  const value = String(password ?? '');
  const issues = [];
  if (value.length < 12) issues.push('at least 12 characters');
  if (value.length > 128) issues.push('no more than 128 characters');
  if (!/[A-Za-z]/.test(value)) issues.push('at least one letter');
  if (!/[0-9]/.test(value)) issues.push('at least one number');
  return issues;
}

function assertPassword(password, field = 'password') {
  const issues = passwordIssues(password);
  if (issues.length) {
    throw new ValidationError(`The ${field} must contain ${issues.join(', ')}.`);
  }
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePagination(query, defaultLimit = 100, maxLimit = 500) {
  const limit = Math.min(Math.max(toInt(query.limit, defaultLimit) || defaultLimit, 1), maxLimit);
  const offset = Math.max(toInt(query.offset, 0) || 0, 0);
  return { limit, offset };
}

function isIsoDate(value) {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

function isIsoDateTime(value) {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(String(value));
}

module.exports = {
  z,
  validate,
  requireFields,
  sanitize,
  sanitizeText,
  normalizePhone,
  isValidPhone,
  isValidEmail,
  passwordIssues,
  assertPassword,
  assertEnum,
  toNumber,
  toInt,
  toBool,
  parsePagination,
  isIsoDate,
  isIsoDateTime,
};
