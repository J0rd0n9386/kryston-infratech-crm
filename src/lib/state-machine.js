/**
 * Lead lifecycle state machine.
 *
 * The server rejects any stage transition that is not listed here. Admin Desk
 * is the only role that may terminate an open lead (Lost / Nurture). Normal
 * movement happens through workflow endpoints (assign, route, review, quote,
 * work order), never through a free-form stage update.
 */
'use strict';

const STAGES = Object.freeze([
  'New',
  'With Telecaller',
  'Response Received',
  'Routed to Sales',
  'Routed to Engineering',
  'Routed to Design',
  'Routed to Purchase',
  'Routed to Accounts',
  'Update Received',
  'Follow-up Required',
  'Site Visit Scheduled',
  'Design In Progress',
  'Quotation Stage',
  'Quotation Sent',
  'Negotiation',
  'Approved',
  'Work Order Pending Admin Approval',
  'Work Order Finalized',
  'Project Handoff',
  'In Progress',
  'Completed',
  'Closed',
  'Lost',
  'Nurture',
]);

const CENTRAL_ROLES = Object.freeze(['ADMIN_DESK', 'SUPER_ADMIN']);
const SALES_ROLES = Object.freeze(['BDM', 'BDE', 'SENIOR_BDM', 'SALES_MANAGER']);

const TRANSITIONS = Object.freeze({
  New: [
    { to: 'With Telecaller', roles: CENTRAL_ROLES },
    { to: 'Lost', roles: CENTRAL_ROLES },
    { to: 'Nurture', roles: CENTRAL_ROLES },
  ],
  'With Telecaller': [{ to: 'Response Received', roles: ['TELECALLER', ...CENTRAL_ROLES] }],
  'Response Received': [
    { to: 'Routed to Sales', roles: CENTRAL_ROLES },
    { to: 'Routed to Engineering', roles: CENTRAL_ROLES },
    { to: 'Routed to Design', roles: CENTRAL_ROLES },
    { to: 'Routed to Purchase', roles: CENTRAL_ROLES },
    { to: 'Routed to Accounts', roles: CENTRAL_ROLES },
    { to: 'Site Visit Scheduled', roles: CENTRAL_ROLES },
    { to: 'Follow-up Required', roles: CENTRAL_ROLES },
    { to: 'Lost', roles: CENTRAL_ROLES },
    { to: 'Nurture', roles: CENTRAL_ROLES },
  ],
  'Routed to Sales': [
    { to: 'Update Received', roles: [...SALES_ROLES, ...CENTRAL_ROLES] },
    { to: 'Follow-up Required', roles: CENTRAL_ROLES },
  ],
  'Routed to Engineering': [
    { to: 'Update Received', roles: ['SITE_ENGINEER', ...CENTRAL_ROLES] },
    { to: 'Follow-up Required', roles: CENTRAL_ROLES },
  ],
  'Routed to Design': [
    { to: 'Update Received', roles: ['ARCHITECT', ...CENTRAL_ROLES] },
    { to: 'Follow-up Required', roles: CENTRAL_ROLES },
  ],
  'Routed to Purchase': [
    { to: 'Update Received', roles: ['PURCHASE', ...CENTRAL_ROLES] },
    { to: 'Follow-up Required', roles: CENTRAL_ROLES },
  ],
  'Routed to Accounts': [
    { to: 'Update Received', roles: ['ACCOUNTS', ...CENTRAL_ROLES] },
    { to: 'Follow-up Required', roles: CENTRAL_ROLES },
  ],
  'Update Received': [
    { to: 'Routed to Sales', roles: CENTRAL_ROLES },
    { to: 'Routed to Engineering', roles: CENTRAL_ROLES },
    { to: 'Routed to Design', roles: CENTRAL_ROLES },
    { to: 'Routed to Purchase', roles: CENTRAL_ROLES },
    { to: 'Routed to Accounts', roles: CENTRAL_ROLES },
    { to: 'Quotation Stage', roles: CENTRAL_ROLES },
    { to: 'Follow-up Required', roles: CENTRAL_ROLES },
    { to: 'Lost', roles: CENTRAL_ROLES },
    { to: 'Nurture', roles: CENTRAL_ROLES },
  ],
  'Site Visit Scheduled': [
    { to: 'Update Received', roles: ['SITE_ENGINEER', ...CENTRAL_ROLES] },
    { to: 'Design In Progress', roles: CENTRAL_ROLES },
    { to: 'Quotation Stage', roles: CENTRAL_ROLES },
  ],
  'Design In Progress': [
    { to: 'Update Received', roles: ['ARCHITECT', ...CENTRAL_ROLES] },
    { to: 'Quotation Stage', roles: CENTRAL_ROLES },
  ],
  'Quotation Stage': [
    { to: 'Quotation Sent', roles: [...SALES_ROLES, ...CENTRAL_ROLES] },
    { to: 'Negotiation', roles: [...SALES_ROLES, ...CENTRAL_ROLES] },
    { to: 'Lost', roles: CENTRAL_ROLES },
  ],
  'Quotation Sent': [
    { to: 'Negotiation', roles: [...SALES_ROLES, ...CENTRAL_ROLES] },
    { to: 'Approved', roles: ['SALES_MANAGER', ...CENTRAL_ROLES] },
    { to: 'Lost', roles: CENTRAL_ROLES },
  ],
  Negotiation: [
    { to: 'Approved', roles: ['SALES_MANAGER', ...CENTRAL_ROLES] },
    { to: 'Quotation Stage', roles: [...SALES_ROLES, ...CENTRAL_ROLES] },
    { to: 'Lost', roles: CENTRAL_ROLES },
  ],
  Approved: [{ to: 'Work Order Pending Admin Approval', roles: ['SALES_MANAGER'] }],
  'Work Order Pending Admin Approval': [
    { to: 'Work Order Finalized', roles: CENTRAL_ROLES },
    { to: 'Lost', roles: CENTRAL_ROLES },
  ],
  'Work Order Finalized': [{ to: 'Project Handoff', roles: CENTRAL_ROLES }],
  'Project Handoff': [{ to: 'In Progress', roles: ['PROJECT_MANAGER', ...CENTRAL_ROLES] }],
  'In Progress': [{ to: 'Completed', roles: ['PROJECT_MANAGER', ...CENTRAL_ROLES] }],
  Completed: [{ to: 'Closed', roles: CENTRAL_ROLES }],
  'Follow-up Required': [
    { to: 'With Telecaller', roles: CENTRAL_ROLES },
    { to: 'Routed to Sales', roles: CENTRAL_ROLES },
    { to: 'Routed to Engineering', roles: CENTRAL_ROLES },
    { to: 'Routed to Design', roles: CENTRAL_ROLES },
    { to: 'Lost', roles: CENTRAL_ROLES },
    { to: 'Nurture', roles: CENTRAL_ROLES },
  ],
  Nurture: [{ to: 'With Telecaller', roles: CENTRAL_ROLES }],
  Lost: [],
  Closed: [],
});

const OPEN_STAGES = Object.freeze(
  STAGES.filter((stage) => !['Closed', 'Lost'].includes(stage)),
);

function isOpenStage(stage) {
  return OPEN_STAGES.includes(stage);
}

function canTransition(fromStage, toStage, role) {
  if (fromStage === toStage) return true;
  if (CENTRAL_ROLES.includes(role) && ['Lost', 'Nurture'].includes(toStage) && isOpenStage(fromStage)) {
    return true;
  }
  const allowed = TRANSITIONS[fromStage] || [];
  const match = allowed.find((transition) => transition.to === toStage);
  return Boolean(match && match.roles.includes(role));
}

function getAllowedTransitions(fromStage, role) {
  const allowed = TRANSITIONS[fromStage] || [];
  const stages = allowed.filter((transition) => transition.roles.includes(role)).map((t) => t.to);
  if (CENTRAL_ROLES.includes(role) && isOpenStage(fromStage)) {
    for (const terminal of ['Lost', 'Nurture']) {
      if (!stages.includes(terminal)) stages.push(terminal);
    }
  }
  return stages;
}

function checkStageGate(fromStage, toStage, context = {}) {
  const missing = [];

  if (toStage === 'Lost' && !context.reason && !context.lost_reason && !context.remarks) {
    missing.push('A valid lost reason is mandatory before moving lead to Lost.');
  }

  if (toStage === 'Nurture' && !context.reason && !context.remarks) {
    missing.push('A nurture explanation and follow-up plan is mandatory before moving lead to Nurture.');
  }

  if (toStage === 'Quotation Stage') {
    if (!context.requirement && !context.requirement_detail && !context.notes) {
      missing.push('Customer requirement details must be defined before advancing to Quotation Stage.');
    }
  }

  if (toStage === 'Work Order Finalized' && !context.work_order_id && !context.has_approved_wo) {
    missing.push('An approved Work Order is required before stage can be finalized.');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Stage Gate prerequisite check failed for "${toStage}": ${missing.join(' ')}`,
      missing,
    };
  }

  return { ok: true, missing: [] };
}

module.exports = {
  STAGES,
  OPEN_STAGES,
  CENTRAL_ROLES,
  SALES_ROLES,
  TRANSITIONS,
  isOpenStage,
  canTransition,
  getAllowedTransitions,
  checkStageGate,
};
