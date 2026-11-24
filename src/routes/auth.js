/**
 * Authentication routes: login, 2FA (TOTP + recovery codes), identity, logout, and password rotation.
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const otplib = require('otplib');
const qrcode = require('qrcode');

const config = require('../config');
const { auth, tokenFor, setSessionCookies, clearSessionCookies } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { audit } = require('../lib/audit-notify');
const { z, validate, assertPassword, isValidEmail, sanitizeText } = require('../middleware/validate');
const { ValidationError, NotFoundError } = require('../middleware/errors');

const DUMMY_HASH = '$2a$12$e8Y6iB2Y/5O5v1Vp71o9E.sZ6y36H8G6n.k/K8O6Y8U8O6Y8U8O6Y';

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(256),
  })
  .strict();

const login2faSchema = z
  .object({
    tempToken: z.string().min(1),
    code: z.string().min(1).max(64),
  })
  .strict();

const passwordChangeSchema = z
  .object({
    current_password: z.string().min(1),
    new_password: z.string().min(12).max(128),
  })
  .strict();

const twoFactorVerifySchema = z
  .object({
    code: z.string().min(1).max(64),
  })
  .strict();

const twoFactorDisableSchema = z
  .object({
    password: z.string().min(1),
    code: z.string().min(1).max(64),
  })
  .strict();

const emailCheckSchema = z
  .object({
    email: z.string().max(254),
  })
  .strict();

function publicUser(employee) {
  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    phone: employee.phone,
    role: employee.role,
    department: employee.department,
    manager_id: employee.manager_id,
    two_factor_enabled: Boolean(employee.two_factor_enabled),
    must_change_password: Boolean(employee.must_change_password),
  };
}

function handleFailedLogin(db, employee, req, res) {
  if (employee) {
    const attempts = (Number(employee.failed_login_attempts) || 0) + 1;
    let lockedUntil = null;
    if (attempts >= 5) {
      // Exponential backoff: 5 attempts = 60s, 6 = 120s, 7 = 240s, 8+ = 900s
      const backoffSeconds = Math.min(900, Math.pow(2, attempts - 5) * 60);
      lockedUntil = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    }
    db.prepare('UPDATE employees SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(
      attempts,
      lockedUntil,
      employee.id,
    );
  }

  audit(
    db,
    employee ? employee.id : null,
    'LOGIN_FAILED',
    'employee',
    employee ? employee.id : null,
    'Failed sign-in attempt',
    null,
    null,
    req.ip,
  );

  return res.status(401).json({ error: 'Invalid email or password.', requestId: req.id });
}

module.exports = function registerAuthRoutes(app, db) {
  app.post('/api/login', validate({ body: loginSchema }), (req, res, next) => {
    try {
      const email = String(req.body.email).trim().toLowerCase();

      const employee = db.prepare('SELECT * FROM employees WHERE email = ? AND active = 1').get(email);

      if (employee && employee.locked_until) {
        const lockExpiry = new Date(employee.locked_until).getTime();
        if (lockExpiry > Date.now()) {
          audit(
            db,
            employee.id,
            'ACCOUNT_LOCKED',
            'employee',
            employee.id,
            'Sign-in attempt while account locked',
            null,
            null,
            req.ip,
          );
          return res.status(401).json({ error: 'Invalid email or password.', requestId: req.id });
        }
      }

      if (!employee) {
        bcrypt.compareSync(String(req.body.password), DUMMY_HASH);
        return handleFailedLogin(db, null, req, res);
      }

      const match = bcrypt.compareSync(String(req.body.password), employee.password_hash);
      if (!match) {
        return handleFailedLogin(db, employee, req, res);
      }

      // Check if 2FA is enabled
      if (employee.two_factor_enabled === 1) {
        const tempToken = jwt.sign(
          { sub: employee.id, purpose: '2fa_login' },
          config.jwtSecret,
          { expiresIn: '5m', jwtid: crypto.randomUUID() },
        );
        return res.json({ requires2FA: true, tempToken });
      }

      // Successful login without 2FA
      db.prepare(
        `UPDATE employees
         SET failed_login_attempts = 0, locked_until = NULL,
             last_login_at = datetime('now'), last_active_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), employee.id);

      const token = tokenFor(employee);
      const csrfToken = crypto.randomBytes(24).toString('hex');
      setSessionCookies(res, token, csrfToken);

      audit(db, employee.id, 'LOGIN', 'employee', employee.id, `Signed in as ${employee.role}`, null, null, req.ip);

      return res.json({
        token,
        user: publicUser(employee),
        csrfToken,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/login/2fa', validate({ body: login2faSchema }), (req, res, next) => {
    try {
      let payload;
      try {
        payload = jwt.verify(req.body.tempToken, config.jwtSecret);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired 2FA session token.', requestId: req.id });
      }

      if (payload.purpose !== '2fa_login') {
        return res.status(401).json({ error: 'Invalid token purpose.', requestId: req.id });
      }

      const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(payload.sub);
      if (!employee || employee.two_factor_enabled !== 1) {
        return res.status(401).json({ error: 'Two-factor authentication is not active for this account.', requestId: req.id });
      }

      if (employee.locked_until && new Date(employee.locked_until).getTime() > Date.now()) {
        audit(
          db,
          employee.id,
          'ACCOUNT_LOCKED',
          'employee',
          employee.id,
          '2FA attempt while account locked',
          null,
          null,
          req.ip,
        );
        return res.status(401).json({ error: 'Invalid email or password.', requestId: req.id });
      }

      const inputCode = String(req.body.code).trim();
      let codeValid = false;

      // 1. Try TOTP code
      if (employee.two_factor_secret) {
        try {
          const result = otplib.verifySync({ token: inputCode, secret: employee.two_factor_secret });
          if (result && result.valid) {
            codeValid = true;
          }
        } catch {
          // ignore verification exception, fall through to recovery code check
        }
      }

      // 2. Try single-use recovery code if TOTP didn't match
      if (!codeValid && employee.recovery_codes) {
        const hashedInput = crypto.createHash('sha256').update(inputCode).digest('hex');
        let codes = [];
        try {
          codes = JSON.parse(employee.recovery_codes);
        } catch {
          codes = [];
        }
        const index = codes.indexOf(hashedInput);
        if (index !== -1) {
          codeValid = true;
          // Consume recovery code immediately
          codes.splice(index, 1);
          db.prepare('UPDATE employees SET recovery_codes = ? WHERE id = ?').run(
            JSON.stringify(codes),
            employee.id,
          );
        }
      }

      if (!codeValid) {
        return handleFailedLogin(db, employee, req, res);
      }

      // Successful 2FA login
      db.prepare(
        `UPDATE employees
         SET failed_login_attempts = 0, locked_until = NULL,
             last_login_at = datetime('now'), last_active_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), employee.id);

      const token = tokenFor(employee);
      const csrfToken = crypto.randomBytes(24).toString('hex');
      setSessionCookies(res, token, csrfToken);

      audit(db, employee.id, 'LOGIN_2FA', 'employee', employee.id, `Signed in with 2FA as ${employee.role}`, null, null, req.ip);

      return res.json({
        token,
        user: publicUser(employee),
        csrfToken,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/2fa/setup', auth, requireRole('SUPER_ADMIN', 'ADMIN_DESK'), async (req, res, next) => {
    try {
      const secret = otplib.generateSecret();
      const otpauth = otplib.generateURI({
        secret,
        label: req.user.email,
        issuer: 'Kryston CRM',
      });
      const qrCode = await qrcode.toDataURL(otpauth);

      // Generate 10 recovery codes
      const recoveryCodes = [];
      const hashedCodes = [];
      for (let i = 0; i < 10; i++) {
        const code = `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
        recoveryCodes.push(code);
        hashedCodes.push(crypto.createHash('sha256').update(code).digest('hex'));
      }

      db.prepare(
        'UPDATE employees SET two_factor_secret = ?, recovery_codes = ?, two_factor_enabled = 0 WHERE id = ?',
      ).run(secret, JSON.stringify(hashedCodes), req.user.id);

      audit(db, req.user.id, '2FA_SETUP', 'employee', req.user.id, 'Initiated 2FA setup', null, null, req.ip);

      res.json({
        secret,
        qrCode,
        recoveryCodes,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/2fa/verify', auth, validate({ body: twoFactorVerifySchema }), (req, res, next) => {
    try {
      const employee = db.prepare('SELECT two_factor_secret FROM employees WHERE id = ?').get(req.user.id);
      if (!employee || !employee.two_factor_secret) {
        throw new ValidationError('Run 2FA setup before verifying.');
      }

      const inputCode = String(req.body.code).trim();
      const result = otplib.verifySync({ token: inputCode, secret: employee.two_factor_secret });
      if (!result || !result.valid) {
        throw new ValidationError('Invalid two-factor verification code.');
      }

      db.prepare('UPDATE employees SET two_factor_enabled = 1 WHERE id = ?').run(req.user.id);
      audit(db, req.user.id, '2FA_ENABLED', 'employee', req.user.id, 'Enabled two-factor authentication', null, null, req.ip);

      res.json({ ok: true, message: 'Two-factor authentication enabled successfully.' });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/2fa/disable', auth, validate({ body: twoFactorDisableSchema }), (req, res, next) => {
    try {
      if (config.enforceCentral2fa && ['SUPER_ADMIN', 'ADMIN_DESK'].includes(req.user.role)) {
        return res.status(403).json({
          error: 'Two-factor authentication is mandatory for Central Admin and cannot be disabled.',
          requestId: req.id,
        });
      }

      const employee = db
        .prepare('SELECT password_hash, two_factor_secret, recovery_codes FROM employees WHERE id = ?')
        .get(req.user.id);

      if (!employee || !bcrypt.compareSync(String(req.body.password), employee.password_hash)) {
        throw new ValidationError('Invalid password.');
      }

      const inputCode = String(req.body.code).trim();
      let codeValid = false;
      if (employee.two_factor_secret) {
        try {
          const result = otplib.verifySync({ token: inputCode, secret: employee.two_factor_secret });
          if (result && result.valid) codeValid = true;
        } catch {
          // ignore
        }
      }

      if (!codeValid && employee.recovery_codes) {
        const hashedInput = crypto.createHash('sha256').update(inputCode).digest('hex');
        let codes = [];
        try {
          codes = JSON.parse(employee.recovery_codes);
        } catch {
          codes = [];
        }
        if (codes.includes(hashedInput)) {
          codeValid = true;
        }
      }

      if (!codeValid) {
        throw new ValidationError('Invalid two-factor authentication code.');
      }

      db.prepare(
        'UPDATE employees SET two_factor_enabled = 0, two_factor_secret = NULL, recovery_codes = NULL WHERE id = ?',
      ).run(req.user.id);

      audit(db, req.user.id, '2FA_DISABLED', 'employee', req.user.id, 'Disabled two-factor authentication', null, null, req.ip);

      res.json({ ok: true, message: 'Two-factor authentication disabled.' });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/me', auth, (req, res) => {
    const fresh = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.user.id);
    res.json(fresh ? publicUser(fresh) : req.user);
  });

  app.post('/api/logout', auth, (req, res) => {
    clearSessionCookies(res);
    db.prepare('UPDATE employees SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
    audit(db, req.user.id, 'LOGOUT', 'employee', req.user.id, 'Signed out and revoked active sessions', null, null, req.ip);
    res.json({ ok: true });
  });

  app.post('/api/me/password', auth, validate({ body: passwordChangeSchema }), (req, res, next) => {
    try {
      const row = db.prepare('SELECT password_hash FROM employees WHERE id = ?').get(req.user.id);
      if (!row || !bcrypt.compareSync(String(req.body.current_password), row.password_hash)) {
        throw new ValidationError('Your current password is incorrect.');
      }
      assertPassword(req.body.new_password, 'new password');
      if (String(req.body.current_password) === String(req.body.new_password)) {
        throw new ValidationError('The new password must be different from the current password.');
      }

      const hash = bcrypt.hashSync(String(req.body.new_password), config.bcryptRounds);
      db.prepare(
        'UPDATE employees SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, last_active_at = ? WHERE id = ?',
      ).run(hash, new Date().toISOString(), req.user.id);

      audit(db, req.user.id, 'PASSWORD_CHANGE', 'employee', req.user.id, 'Password rotated', null, null, req.ip);
      const refreshed = db
        .prepare(
          'SELECT id, name, email, phone, role, department, manager_id, token_version, two_factor_enabled, must_change_password FROM employees WHERE id = ?',
        )
        .get(req.user.id);

      const token = tokenFor(refreshed);
      const csrfToken = crypto.randomBytes(24).toString('hex');
      setSessionCookies(res, token, csrfToken);

      res.json({ ok: true, token, user: publicUser(refreshed), csrfToken });
    } catch (err) {
      next(err);
    }
  });

  // A small, safe alias used by the client to verify connectivity.
  app.get('/api/auth/session', auth, (req, res) => {
    res.json({ ok: true, user: publicUser(req.user), expiresIn: config.jwtExpiresIn });
  });

  app.post('/api/auth/email-check', validate({ body: emailCheckSchema }), (req, res) => {
    const email = sanitizeText(req.body && req.body.email, 254);
    // Deliberately does not reveal whether an account exists.
    res.json({ valid: Boolean(email && isValidEmail(email)) });
  });
};
