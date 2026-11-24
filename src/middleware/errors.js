/**
 * Typed application errors, API 404 handling and the global error boundary.
 */
'use strict';

const logger = require('../lib/logger');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

class ValidationError extends HttpError {
  constructor(message, details) {
    super(400, message, details);
    this.name = 'ValidationError';
  }
}

class ForbiddenError extends HttpError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends HttpError {
  constructor(message = 'Record not found.') {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

class ConflictError extends HttpError {
  constructor(message = 'The request conflicts with the current state.') {
    super(409, message);
    this.name = 'ConflictError';
  }
}

function notFound(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    requestId: req.id,
  });
}

function mapSqliteError(err) {
  if (!err || typeof err.code !== 'string') return null;
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return new ConflictError('A record with these details already exists.');
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return new ConflictError('This record is referenced by another record and cannot be changed.');
  }
  if (err.code === 'SQLITE_CONSTRAINT_CHECK') {
    return new ValidationError('One or more values are not allowed by the data model.');
  }
  if (err.code === 'SQLITE_CONSTRAINT_NOTNULL') {
    return new ValidationError('A required value is missing.');
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = err;

  if (err && err.type === 'entity.parse.failed') {
    error = new ValidationError('Request body is not valid JSON.');
  } else if (err && err.type === 'entity.too.large') {
    error = new HttpError(413, 'Request body is too large.');
  } else if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
    error = new HttpError(401, 'Session expired or invalid. Please sign in again.');
  } else if (!(err instanceof HttpError)) {
    const mapped = mapSqliteError(err);
    if (mapped) error = mapped;
  }

  const status = Number(error.status) || 500;
  if (status >= 500) {
    logger.error(
      {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        err: error,
      },
      error.message,
    );
  }

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : error.message,
    ...(error.details ? { details: error.details } : {}),
    requestId: req.id,
  });
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = {
  HttpError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  notFound,
  errorHandler,
  asyncHandler,
};
