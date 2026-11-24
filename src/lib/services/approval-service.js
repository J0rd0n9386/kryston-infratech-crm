/**
 * Approval Service: Matrix-based multi-tier approval evaluation.
 *
 * Checks approval_rules table for threshold-based roles (e.g. quotation discounts,
 * procurement limits), supporting role hierarchies and fallback to config.
 */
'use strict';

const config = require('../../config');
const { audit } = require('../audit-notify');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../middleware/errors');

const ROLE_RANK = Object.freeze({
  SUPER_ADMIN: 100,
  SENIOR_BDM: 50,
  SALES_MANAGER: 40,
  ADMIN_DESK: 30,
});

/**
 * Determine the required approver role for a given entity, metric and value.
 *
 * @param {Object} db better-sqlite3 instance
 * @param {string} entity e.g. 'quotation_discount'
 * @param {string} metric e.g. 'discount_percent'
 * @param {number} value e.g. 8.5
 * @returns {string|null} Required approver role, or null if no approval required
 */
function getRequiredApproverRole(db, entity, metric, value) {
  const numVal = Number(value) || 0;
  if (numVal <= 0) return null;

  try {
    const rule = db
      .prepare(
        `SELECT approver_role FROM approval_rules
         WHERE entity = ? AND metric = ? AND active = 1
           AND ? >= min_value AND ? <= max_value
         ORDER BY min_value DESC LIMIT 1`,
      )
      .get(entity, metric, numVal, numVal);

    if (rule && rule.approver_role) {
      return rule.approver_role;
    }
  } catch {
    // If table not yet ready in some unit test context, fall through to config
  }

  // Fallback to legacy config threshold
  if (numVal > config.discountApprovalThresholdPercent) {
    return 'SALES_MANAGER';
  }
  return null;
}

/**
 * Check if the acting user's role satisfies the required approval level.
 *
 * @param {string} actorRole Role of the employee attempting the approval
 * @param {string} requiredRole Required approver role determined by the matrix
 * @returns {boolean}
 */
function isRoleAuthorized(actorRole, requiredRole) {
  if (!requiredRole) return true;
  if (actorRole === 'SUPER_ADMIN') return true;
  if (actorRole === requiredRole) return true;

  // Senior BDM outranks Sales Manager for commercial discounting
  if (actorRole === 'SENIOR_BDM' && requiredRole === 'SALES_MANAGER') return true;
  if (actorRole === 'ADMIN_DESK' && (requiredRole === 'SALES_MANAGER' || requiredRole === 'SENIOR_BDM')) return true;

  return false;
}

module.exports = {
  getRequiredApproverRole,
  isRoleAuthorized,
};
