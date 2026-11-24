/**
 * Role-based access control.
 *
 * Central roles (Super Admin + Admin Desk) own orchestration. Spokes only act on
 * records explicitly assigned to them. The helpers below are used by routes to
 * enforce that boundary consistently.
 */
'use strict';

const CENTRAL_ROLES = Object.freeze(['SUPER_ADMIN', 'ADMIN_DESK']);
const SALES_ROLES = Object.freeze(['SALES_MANAGER', 'SENIOR_BDM', 'BDM', 'BDE']);
const db = require('../db');
const { hasActiveDelegation } = require('../lib/services/delegation-service');

/**
 * A Sales Manager needs commercial oversight to approve quotations and submit
 * the resulting work order even when the lead itself is owned by a BDE/BDM.
 * Access stays limited to the commercial window; the rest of the pipeline is
 * still task-assignment scoped.
 */
const SALES_MANAGER_STAGES = Object.freeze([
  'Quotation Stage',
  'Quotation Sent',
  'Negotiation',
  'Approved',
  'Work Order Pending Admin Approval',
  'Work Order Finalized',
]);

function isCentral(user) {
  if (!user) return false;
  if (CENTRAL_ROLES.includes(user.role)) return true;
  return hasActiveDelegation(db, user.id, 'ADMIN_DESK');
}

function isSales(user) {
  return Boolean(user && SALES_ROLES.includes(user.role));
}

function isSalesManager(user) {
  return Boolean(user && user.role === 'SALES_MANAGER');
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', requestId: req.id });
    }
    if (req.user.role === 'SUPER_ADMIN' || allowedRoles.includes(req.user.role)) {
      return next();
    }
    // Check if user has active delegated authority for ADMIN_DESK
    if (allowedRoles.includes('ADMIN_DESK') && hasActiveDelegation(db, req.user.id, 'ADMIN_DESK')) {
      req.isDelegated = true;
      return next();
    }
    return res.status(403).json({
      error: `Access denied. Requires one of: ${allowedRoles.join(', ')}.`,
      requestId: req.id,
    });
  };
}

function requireCentral() {
  return requireRole('ADMIN_DESK', 'SUPER_ADMIN');
}

function requireSales() {
  return requireRole(...SALES_ROLES);
}

function requireSalesManager() {
  return requireRole('SALES_MANAGER');
}

/**
 * A spoke may read a lead when it is assigned to them in any capacity, or when
 * they hold at least one task for that lead (the task is the access boundary).
 */
function canAccessLead(user, lead, database) {
  if (!user || !lead) return false;
  if (isCentral(user)) return true;
  if (user.role === 'SALES_MANAGER' && SALES_MANAGER_STAGES.includes(lead.stage)) return true;
  const assigned = [
    lead.assigned_telecaller,
    lead.assigned_bdm,
    lead.assigned_engineer,
    lead.assigned_architect,
    lead.assigned_pm,
    lead.created_by,
    lead.current_owner,
  ].includes(user.id);
  if (assigned) return true;
  return Boolean(
    database.prepare('SELECT 1 FROM tasks WHERE lead_id = ? AND assigned_to = ? LIMIT 1').get(lead.id, user.id),
  );
}

module.exports = {
  CENTRAL_ROLES,
  SALES_ROLES,
  SALES_MANAGER_STAGES,
  isCentral,
  isSales,
  isSalesManager,
  requireRole,
  requireCentral,
  requireSales,
  requireSalesManager,
  canAccessLead,
};
