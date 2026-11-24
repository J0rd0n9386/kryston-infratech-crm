/**
 * Handover, Snags and Warranty Service.
 */
'use strict';

const { generateId } = require('../id-generator');
const { ConflictError, ValidationError, NotFoundError } = require('../../middleware/errors');
const { audit, logAction, notifyCentral } = require('../audit-notify');

function verifyHandoverPrerequisites(db, project, options = {}) {
  const { override_billing = false, user = null } = options;

  // 1. Check open / unapproved snags
  const unapprovedSnags = db
    .prepare("SELECT count(*) as count FROM snag_items WHERE project_id = ? AND status != 'Approved'")
    .get(project.id);

  if (unapprovedSnags && unapprovedSnags.count > 0) {
    throw new ConflictError(
      `Handover blocked: ${unapprovedSnags.count} unapproved snag item(s) remain on project ${project.id}.`,
    );
  }

  // 2. Check billing / unpaid invoices
  if (project.work_order_id) {
    const unpaidInvoices = db
      .prepare("SELECT count(*) as count FROM invoices WHERE work_order_id = ? AND status != 'Paid'")
      .get(project.work_order_id);

    if (unpaidInvoices && unpaidInvoices.count > 0) {
      if (!override_billing) {
        throw new ConflictError(
          `Handover blocked: ${unpaidInvoices.count} unpaid invoice(s) remain on work order ${project.work_order_id}.`,
        );
      }
      if (user && user.role !== 'SUPER_ADMIN') {
        throw new ConflictError('Only a Super Admin can waive unpaid invoice requirement for handover.');
      }
      if (user) {
        audit(
          db,
          user.id,
          'HANDOVER_BILLING_WAIVED',
          'project',
          project.id,
          `Super Admin waived ${unpaidInvoices.count} unpaid invoices for handover`,
        );
      }
    }
  }

  return { ok: true };
}

function createSnag(db, { projectId, description, location, priority = 'Medium', photoUrl = null, createdBy }) {
  if (!description || !description.trim()) {
    throw new ValidationError('Snag description is required.');
  }
  const id = generateId(db, 'KRY-SNAG', 'snag_items');
  db.prepare(`
    INSERT INTO snag_items (id, project_id, description, location, priority, photo_url, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, description.trim(), location || null, priority, photoUrl || null, createdBy);

  return db.prepare('SELECT * FROM snag_items WHERE id = ?').get(id);
}

function resolveSnag(db, { snagId, resolvedBy, notes }) {
  const snag = db.prepare('SELECT * FROM snag_items WHERE id = ?').get(snagId);
  if (!snag) throw new NotFoundError('Snag item not found.');

  db.prepare(`
    UPDATE snag_items
    SET status = 'Resolved', resolved_by = ?, resolved_at = datetime('now'),
        resolved_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(resolvedBy, notes || null, snagId);

  return db.prepare('SELECT * FROM snag_items WHERE id = ?').get(snagId);
}

function approveSnag(db, { snagId, approvedBy }) {
  const snag = db.prepare('SELECT * FROM snag_items WHERE id = ?').get(snagId);
  if (!snag) throw new NotFoundError('Snag item not found.');

  db.prepare(`
    UPDATE snag_items
    SET status = 'Approved', approved_by = ?, approved_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(approvedBy, snagId);

  return db.prepare('SELECT * FROM snag_items WHERE id = ?').get(snagId);
}

function issueWarranty(db, { projectId, scope, startDate, endDate, terms, createdBy }) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new NotFoundError('Project not found.');

  const id = generateId(db, 'KRY-WAR', 'warranties');
  const certNumber = `CERT-${id}`;

  db.prepare(`
    INSERT INTO warranties (id, project_id, lead_id, certificate_number, scope, start_date, end_date, terms, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, project.lead_id, certNumber, scope, startDate, endDate, terms || null, createdBy);

  return db.prepare('SELECT * FROM warranties WHERE id = ?').get(id);
}

module.exports = {
  verifyHandoverPrerequisites,
  createSnag,
  resolveSnag,
  approveSnag,
  issueWarranty,
};
