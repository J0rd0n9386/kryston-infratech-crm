/**
 * CSRF protection middleware for cookie-authenticated sessions.
 * Enforces double-submit token validation on state-changing requests.
 */
'use strict';

const { ForbiddenError } = require('./errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT_PATHS = new Set(['/api/login', '/api/login/2fa']);

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const path = req.path || req.originalUrl.split('?')[0];
  if (CSRF_EXEMPT_PATHS.has(path)) return next();

  // If request carries a session cookie, require valid CSRF double-submit token
  const sessionCookie = req.cookies && req.cookies.kryston_session;
  if (sessionCookie) {
    const csrfCookie = req.cookies && req.cookies.kryston_csrf;
    const csrfHeader = req.headers['x-csrf-token'];

    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return next(new ForbiddenError('Invalid or missing CSRF token.'));
    }
  }

  return next();
}

module.exports = { csrfProtection };
