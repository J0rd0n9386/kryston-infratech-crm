/**
 * Legacy compatibility entry.
 *
 * Older modules imported `../auth`. It now re-exports the hardened middleware so
 * there is exactly one JWT secret, one token format and one revocation path.
 */
'use strict';

module.exports = require('./middleware/auth');
