/**
 * JWT session middleware.
 *
 * Tokens are short-lived, issuer/audience-bound and carry the employee's
 * token_version. Bumping token_version (logout / forced revocation) invalidates
 * every token previously issued to that employee.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

function tokenFor(employee) {
  return jwt.sign(
    {
      sub: employee.id,
      ver: Number(employee.token_version) || 0,
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiresIn,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      jwtid: crypto.randomUUID(),
    },
  );
}

function readToken(req) {
  if (req.cookies && req.cookies.kryston_session) {
    return req.cookies.kryston_session;
  }
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

function setSessionCookies(res, token, csrfToken) {
  res.cookie('kryston_session', token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  });
  if (csrfToken) {
    res.cookie('kryston_csrf', csrfToken, {
      httpOnly: false,
      secure: config.isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000,
    });
  }
}

function clearSessionCookies(res) {
  res.clearCookie('kryston_session', {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
  });
  res.clearCookie('kryston_csrf', {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
  });
}

function parseTimestamp(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const str = String(value).trim();
  const iso = str.includes('T') ? (str.endsWith('Z') ? str : str + 'Z') : str.replace(' ', 'T') + 'Z';
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function auth(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.', requestId: req.id });
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
  } catch {
    return res
      .status(401)
      .json({ error: 'Session expired or invalid. Please sign in again.', requestId: req.id });
  }

  const user = db
    .prepare(
      `SELECT id, name, email, phone, role, department, manager_id, active, token_version,
              last_active_at, two_factor_enabled
       FROM employees WHERE id = ?`,
    )
    .get(payload.sub);

  if (!user || !user.active) {
    return res.status(401).json({ error: 'User account is inactive or not found.', requestId: req.id });
  }
  if ((Number(user.token_version) || 0) !== (Number(payload.ver) || 0)) {
    return res.status(401).json({ error: 'Session has been revoked. Please sign in again.', requestId: req.id });
  }

  const now = Date.now();
  const lastActiveTime = parseTimestamp(user.last_active_at);
  if (lastActiveTime > 0 && now - lastActiveTime > config.idleTimeoutMs) {
    return res.status(401).json({
      error: 'Session timed out due to inactivity. Please sign in again.',
      requestId: req.id,
    });
  }

  if (!lastActiveTime || now - lastActiveTime > 10000) {
    db.prepare('UPDATE employees SET last_active_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  }

  delete user.token_version;
  req.user = user;
  return next();
}

module.exports = {
  auth,
  tokenFor,
  readToken,
  setSessionCookies,
  clearSessionCookies,
};
