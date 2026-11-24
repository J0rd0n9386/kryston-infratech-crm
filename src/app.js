/**
 * Express application factory.
 *
 * The app is built independently of the listening server so integration tests
 * can mount it on an ephemeral port with a temporary database. Every cross-cutting
 * concern (request ids, security headers, rate limits, body limits, static assets,
 * API routes, error boundary) is configured here exactly once.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const logger = require('./lib/logger');
const { csrfProtection } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errors');

const ROUTE_MODULES = [
  './routes/auth',
  './routes/employees',
  './routes/leads',
  './routes/taskboard',
  './routes/tasks',
  './routes/queues',
  './routes/reminders',
  './routes/telecaller',
  './routes/dept-updates',
  './routes/quotations',
  './routes/workorders',
  './routes/projects',
  './routes/dashboard',
  './routes/my-day',
  './routes/attachments',
  './routes/notifications',
  './routes/notification-preferences',
  './routes/audit',
  './routes/export',
  './routes/workflow-rules',
  './routes/site-visits-and-boq',
  './routes/billing',
  './routes/execution-procurement',
  './routes/handover',
];

function requestId(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  req.id = /^[A-Za-z0-9._-]{8,80}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function requestLogger(req, res, next) {
  req.log = logger.child({ requestId: req.id });
  if (!config.logRequests || config.isTest) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const logData = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user ? req.user.id : undefined,
    };
    if (res.statusCode >= 500) {
      logger.error(logData, 'HTTP request failed');
    } else {
      logger.info(logData, 'HTTP request completed');
    }
  });
  next();
}

function createApp(database) {
  const db = database || require('./db');
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy === true ? 1 : config.trustProxy);

  app.use(requestId);
  app.use(requestLogger);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          // Site photos and recorded voice notes are previewed from local blob
          // URLs / data URLs created by the browser after an authenticated read.
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:', 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    }),
  );

  app.use(express.json({ limit: config.jsonLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.jsonLimit }));
  app.use(cookieParser());
  app.use(csrfProtection);

  const apiLimiter = rateLimit({
    windowMs: config.apiWindowMs,
    limit: config.isTest ? 10000 : config.apiMaxRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.originalUrl.split('?')[0] === '/api/health',
    message: { error: 'Too many requests. Please slow down and try again shortly.' },
  });
  app.use('/api', apiLimiter);

  const loginLimiter = rateLimit({
    windowMs: config.loginWindowMs,
    limit: config.isTest ? 1000 : config.loginMaxAttempts,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
  });

  app.get('/api/health', (req, res) => {
    let database = 'ok';
    try {
      db.prepare('SELECT 1 AS ok').get();
    } catch {
      database = 'error';
    }
    const healthy = database === 'ok';
    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      app: 'Kryston Infratech CRM',
      status: healthy ? 'healthy' : 'degraded',
      database,
      version: '3.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  // Login is limited separately and more aggressively than the general API.
  app.use('/api/login', loginLimiter);

  app.use('/api', require('./lib/guardian').protectContactResponses(db));
  require('./routes/guardian')(app, db);
  require('./routes/industry-workflows')(app, db);

  for (const modulePath of ROUTE_MODULES) {
    // eslint-disable-next-line global-require
    require(modulePath)(app, db);
  }

  const publicDir = path.join(config.rootDir, 'public');
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      maxAge: config.isProduction ? config.staticMaxAge : 0,
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
