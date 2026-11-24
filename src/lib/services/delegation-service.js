/**
 * Delegation Service: Super Admin delegates Admin Desk orchestration powers.
 *
 * Implements audited delegation lifecycle, date-range bounds, and scheduled auto-expiry.
 */
'use strict';

const { audit, notify } = require('../audit-notify');
const { generateId } = require('../id-generator');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../middleware/errors');

function createDelegation(db, actor, { delegate_id, role = 'ADMIN_DESK', start_at, end_at, reason }) {
  if (actor.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('Only Super Admin can delegate administrative authority.');
  }

  const delegate = db.prepare('SELECT id, name, role, active FROM employees WHERE id = ?').get(delegate_id);
  if (!delegate || !delegate.active) {
    throw new ValidationError('Delegate must be an active employee.');
  }

  if (!start_at || !end_at) {
    throw new ValidationError('start_at and end_at date-times are required.');
  }

  const startTime = new Date(start_at).getTime();
  const endTime = new Date(end_at).getTime();
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
    throw new ValidationError('Invalid date-time format for delegation.');
  }
  if (startTime >= endTime) {
    throw new ValidationError('end_at must be strictly after start_at.');
  }

  const id = generateId(db, 'KRY-DEL', 'delegations');
  const cleanReason = String(reason || '').trim().slice(0, 1000);

  db.prepare(`
    INSERT INTO delegations (id, granter_id, delegate_id, role, start_at, end_at, active, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
  `).run(id, actor.id, delegate.id, role, new Date(startTime).toISOString(), new Date(endTime).toISOString(), cleanReason);

  audit(
    db,
    actor.id,
    'DELEGATE_ADMIN',
    'delegation',
    id,
    `Delegated ${role} authority to ${delegate.name} (${delegate.id}) from ${start_at} to ${end_at}`,
    null,
    { id, delegate_id: delegate.id, role, start_at, end_at, reason: cleanReason },
  );

  notify(
    db,
    delegate.id,
    'TASK_ASSIGNED',
    `You have been granted delegated ${role} authority until ${end_at}.`,
    '#overview',
    'delegation',
    id,
  );

  return { id, delegate_id: delegate.id, role, start_at, end_at, active: 1 };
}

function revokeDelegation(db, actor, id, reason) {
  if (actor.role !== 'SUPER_ADMIN') {
    throw new ForbiddenError('Only Super Admin can revoke administrative delegation.');
  }

  const delegation = db.prepare('SELECT * FROM delegations WHERE id = ?').get(id);
  if (!delegation) throw new NotFoundError('Delegation not found.');
  if (!delegation.active) throw new ValidationError('Delegation is already inactive.');

  db.prepare(`
    UPDATE delegations
    SET active = 0, revoked_at = datetime('now'), reason = coalesce(reason, '') || ' [REVOKED: ' || ? || ']'
    WHERE id = ?
  `).run(String(reason || 'Revoked by Super Admin').slice(0, 500), id);

  audit(
    db,
    actor.id,
    'REVOKE_DELEGATION',
    'delegation',
    id,
    `Revoked delegation ${id} for employee ${delegation.delegate_id}`,
    { active: 1 },
    { active: 0 },
  );

  return { ok: true, id, active: 0 };
}

function hasActiveDelegation(db, employeeId, role = 'ADMIN_DESK') {
  if (!employeeId) return false;
  try {
    const row = db
      .prepare(`
        SELECT 1 FROM delegations
        WHERE delegate_id = ?
          AND role = ?
          AND active = 1
          AND datetime(start_at) <= datetime('now')
          AND datetime(end_at) >= datetime('now')
        LIMIT 1
      `)
      .get(employeeId, role);
    return Boolean(row);
  } catch {
    return false;
  }
}

function expireDelegations(db) {
  const expired = db
    .prepare(`
      UPDATE delegations
      SET active = 0
      WHERE active = 1 AND datetime(end_at) < datetime('now')
    `)
    .run();
  return expired.changes;
}

module.exports = {
  createDelegation,
  revokeDelegation,
  hasActiveDelegation,
  expireDelegations,
};
