'use strict';

// Set test configuration before importing application modules.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = require('node:crypto').randomBytes(48).toString('hex');
