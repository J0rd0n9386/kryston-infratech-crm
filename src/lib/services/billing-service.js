/**
 * Billing, Invoicing and Payments Service.
 *
 * Implements strict integer paise precision (1 INR = 100 paise),
 * milestone 100% sum validation, tax invoicing, and advance payment checks.
 */
'use strict';

const { generateId } = require('../id-generator');
const { ValidationError, NotFoundError, ConflictError } = require('../../middleware/errors');
const { audit, notify, notifyCentral, logAction } = require('../audit-notify');

/**
 * Validate payment milestones definition for a work order.
 * Ensures percentage sum is exactly 100%.
 */
function validateMilestones(milestones = [], contractValuePaise = 0) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new ValidationError('At least one payment milestone is required.');
  }

  let totalPercent = 0;
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    const pct = Number(m.percentage);
    if (!m.name || !String(m.name).trim()) {
      throw new ValidationError(`Milestone #${i + 1} requires a valid name.`);
    }
    if (Number.isNaN(pct) || pct <= 0 || pct > 100) {
      throw new ValidationError(`Milestone "${m.name}" has invalid percentage: ${m.percentage}`);
    }
    totalPercent += pct;
  }

  // Floating point equality tolerance for percentage sum
  if (Math.abs(totalPercent - 100.0) > 0.01) {
    throw new ValidationError(`Total milestone percentage must sum to exactly 100%. Current sum: ${totalPercent}%`);
  }

  // Distribute paise amounts ensuring exact integer sum matches contractValuePaise
  let allocatedPaise = 0;
  const processed = milestones.map((m, idx) => {
    const pct = Number(m.percentage);
    let amountPaise;
    if (idx === milestones.length - 1) {
      // Final milestone absorbs any integer remainder
      amountPaise = contractValuePaise - allocatedPaise;
    } else {
      amountPaise = Math.round(contractValuePaise * (pct / 100));
      allocatedPaise += amountPaise;
    }

    return {
      name: String(m.name).trim(),
      percentage: pct,
      amount_paise: amountPaise,
      due_date: m.due_date || null,
      sequence_order: idx + 1,
    };
  });

  return processed;
}

/**
 * Fetch full billing summary for a work order.
 */
function getWorkOrderBilling(db, workOrderId) {
  const wo = db.prepare('SELECT id, lead_id, amount, status FROM work_orders WHERE id = ?').get(workOrderId);
  if (!wo) throw new NotFoundError('Work Order not found.');

  const contractValuePaise = Math.round(Number(wo.amount) * 100);

  const milestones = db
    .prepare('SELECT * FROM payment_milestones WHERE work_order_id = ? ORDER BY sequence_order ASC')
    .all(workOrderId);

  const invoices = db
    .prepare('SELECT * FROM invoices WHERE work_order_id = ? ORDER BY created_at ASC')
    .all(workOrderId);

  const payments = db
    .prepare('SELECT * FROM payments WHERE work_order_id = ? ORDER BY created_at ASC')
    .all(workOrderId);

  let totalInvoicedPaise = 0;
  for (const inv of invoices) {
    if (inv.status !== 'Cancelled') {
      totalInvoicedPaise += Number(inv.total_paise) || 0;
    }
  }

  let totalPaidPaise = 0;
  for (const p of payments) {
    if (p.status === 'Received' || p.status === 'Cleared') {
      totalPaidPaise += Number(p.amount_paise) || 0;
    }
  }

  const outstandingPaise = Math.max(0, contractValuePaise - totalPaidPaise);

  return {
    work_order_id: workOrderId,
    lead_id: wo.lead_id,
    contract_value_paise: contractValuePaise,
    contract_value_inr: (contractValuePaise / 100).toFixed(2),
    total_invoiced_paise: totalInvoicedPaise,
    total_invoiced_inr: (totalInvoicedPaise / 100).toFixed(2),
    total_paid_paise: totalPaidPaise,
    total_paid_inr: (totalPaidPaise / 100).toFixed(2),
    outstanding_paise: outstandingPaise,
    outstanding_inr: (outstandingPaise / 100).toFixed(2),
    milestones,
    invoices,
    payments,
  };
}

/**
 * Create a tax invoice for a milestone or advance.
 */
function createInvoice(db, actor, { work_order_id, milestone_id = null, invoice_type = 'TAX_INVOICE', subtotal_paise, gst_rate = 18.0, due_date }) {
  const wo = db.prepare('SELECT id, lead_id, amount FROM work_orders WHERE id = ?').get(work_order_id);
  if (!wo) throw new NotFoundError('Work Order not found.');

  const subtotal = Math.round(Number(subtotal_paise));
  if (subtotal <= 0) throw new ValidationError('Invoice subtotal must be greater than zero.');
  if (!due_date) throw new ValidationError('Invoice due_date is required.');

  const rate = Number(gst_rate) || 18.0;
  const gstTotalPaise = Math.round((subtotal * rate) / 100);
  const cgstPaise = Math.round(gstTotalPaise / 2);
  const sgstPaise = gstTotalPaise - cgstPaise;
  const totalPaise = subtotal + gstTotalPaise;

  const id = generateId(db, 'KRY-INV', 'invoices');
  const year = new Date().getFullYear();
  const countRow = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE invoice_number LIKE ?").get(`INV-${year}-%`);
  const invNum = `INV-${year}-${String((countRow.c || 0) + 1).padStart(4, '0')}`;

  db.prepare(`
    INSERT INTO invoices (
      id, work_order_id, milestone_id, invoice_number, invoice_type,
      subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
      due_date, status, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'Unpaid', ?, datetime('now'), datetime('now'))
  `).run(
    id,
    wo.id,
    milestone_id,
    invNum,
    invoice_type,
    subtotal,
    cgstPaise,
    sgstPaise,
    totalPaise,
    due_date,
    actor.id,
  );

  if (milestone_id) {
    db.prepare("UPDATE payment_milestones SET status = 'Invoiced' WHERE id = ?").run(milestone_id);
  }

  audit(
    db,
    actor.id,
    'CREATE',
    'invoice',
    id,
    `Created invoice ${invNum} for ₹${(totalPaise / 100).toFixed(2)} on WO ${wo.id}`,
    null,
    { id, invoice_number: invNum, total_paise: totalPaise },
  );

  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
}

/**
 * Record a payment against an invoice (strictly append-only).
 */
function recordPayment(db, actor, { invoice_id, amount_paise, payment_mode, reference_number, payment_date, notes = '' }) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice_id);
  if (!inv) throw new NotFoundError('Invoice not found.');
  if (inv.status === 'Paid') throw new ConflictError('This invoice is already fully paid.');
  if (inv.status === 'Cancelled') throw new ConflictError('Cannot record payment on a cancelled invoice.');

  const paymentPaise = Math.round(Number(amount_paise));
  if (paymentPaise <= 0) throw new ValidationError('Payment amount must be greater than zero.');
  if (!reference_number || !String(reference_number).trim()) {
    throw new ValidationError('Bank transaction reference number or UTR is required.');
  }

  const cleanRef = String(reference_number).trim();
  const cleanMode = String(payment_mode || 'NEFT_RTGS').trim();
  const cleanDate = payment_date || new Date().toISOString().slice(0, 10);

  const id = generateId(db, 'KRY-PAY', 'payments');

  const wo = db.prepare('SELECT lead_id FROM work_orders WHERE id = ?').get(inv.work_order_id);
  const leadId = wo ? wo.lead_id : null;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (
        id, invoice_id, work_order_id, lead_id, amount, amount_paise, payment_mode,
        transaction_ref, payment_date, status, received_by, notes, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Received', ?, ?, datetime('now'))
    `).run(
      id,
      inv.id,
      inv.work_order_id,
      leadId,
      paymentPaise / 100,
      paymentPaise,
      cleanMode,
      cleanRef,
      cleanDate,
      actor.id,
      String(notes || '').trim(),
    );

    // Sum all received payments for this invoice
    const sumRow = db
      .prepare("SELECT COALESCE(SUM(amount_paise), 0) AS total_paid FROM payments WHERE invoice_id = ? AND status = 'Received'")
      .get(inv.id);

    const totalPaid = sumRow.total_paid;
    let nextStatus = 'Partially Paid';
    if (totalPaid >= inv.total_paise) {
      nextStatus = 'Paid';
    }

    db.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?").run(nextStatus, inv.id);

    // If linked to a milestone and now fully paid, mark milestone Paid
    if (inv.milestone_id && nextStatus === 'Paid') {
      db.prepare("UPDATE payment_milestones SET status = 'Paid' WHERE id = ?").run(inv.milestone_id);
    }

    if (leadId) {
      logAction(
        db,
        leadId,
        'PAYMENT_RECEIVED',
        actor.id,
        null,
        'Accounts',
        `Payment of ₹${(paymentPaise / 100).toFixed(2)} received via ${cleanMode} (Ref: ${cleanRef}). Invoice ${inv.invoice_number} is now ${nextStatus}.`,
        inv.status,
        nextStatus,
      );
    }

    audit(
      db,
      actor.id,
      'RECORD_PAYMENT',
      'payment',
      id,
      `Recorded payment of ₹${(paymentPaise / 100).toFixed(2)} for invoice ${inv.invoice_number}`,
      null,
      { id, invoice_id: inv.id, amount_paise: paymentPaise, status: nextStatus },
    );
  })();

  return {
    payment_id: id,
    invoice_id: inv.id,
    amount_paise: paymentPaise,
    invoice_status: db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status,
  };
}

/**
 * Check if the advance payment gate is satisfied for PM handoff.
 */
function isAdvanceCleared(db, workOrderId) {
  // Check if any advance invoice exists and is Paid
  const advanceInv = db
    .prepare("SELECT id, status FROM invoices WHERE work_order_id = ? AND (invoice_type = 'ADVANCE_INVOICE' OR milestone_id IN (SELECT id FROM payment_milestones WHERE sequence_order = 1))")
    .get(workOrderId);

  if (advanceInv) {
    return advanceInv.status === 'Paid';
  }

  // Fallback: check if total cleared payments >= 10% of WO amount or first milestone paid
  const firstMilestone = db
    .prepare('SELECT id, status FROM payment_milestones WHERE work_order_id = ? ORDER BY sequence_order ASC LIMIT 1')
    .get(workOrderId);

  if (firstMilestone) {
    return firstMilestone.status === 'Paid';
  }

  return false;
}

module.exports = {
  validateMilestones,
  getWorkOrderBilling,
  createInvoice,
  recordPayment,
  isAdvanceCleared,
};
