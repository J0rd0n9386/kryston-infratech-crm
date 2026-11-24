/**
 * BOQ (Bill of Quantities) Calculation and Management Service.
 *
 * Implements strict integer paise financial precision (1 INR = 100 paise),
 * category grouping, CGST/SGST breakdown, and immutable proposal locking.
 */
'use strict';

const { generateId } = require('../id-generator');
const { ValidationError, NotFoundError, ConflictError } = require('../../middleware/errors');
const { audit } = require('../audit-notify');

/**
 * Calculate financial totals for a single BOQ line item.
 */
function calculateLineItem({ quantity = 1, rate_paise = 0, gst_rate = 18.0 }) {
  const qty = Number(quantity) || 0;
  const ratePaise = Math.round(Number(rate_paise) || 0);
  const gstRate = Number(gst_rate) || 0;

  if (qty <= 0) throw new ValidationError('Quantity must be greater than zero.');
  if (ratePaise < 0) throw new ValidationError('Rate cannot be negative.');
  if (gstRate < 0 || gstRate > 100) throw new ValidationError('GST rate must be between 0 and 100.');

  const amountPaise = Math.round(qty * ratePaise);
  const gstAmountPaise = Math.round((amountPaise * gstRate) / 100);
  const totalPaise = amountPaise + gstAmountPaise;

  return {
    quantity: qty,
    rate_paise: ratePaise,
    amount_paise: amountPaise,
    gst_rate: gstRate,
    gst_amount_paise: gstAmountPaise,
    total_paise: totalPaise,
  };
}

/**
 * Aggregate summary across a list of BOQ items.
 */
function summarizeBoq(items = []) {
  let subtotalPaise = 0;
  let gstTotalPaise = 0;
  const categoriesMap = {};

  for (const item of items) {
    const itemAmount = Number(item.amount_paise) || 0;
    const itemGst = Number(item.gst_amount_paise) || 0;
    const itemTotal = Number(item.total_paise) || 0;

    subtotalPaise += itemAmount;
    gstTotalPaise += itemGst;

    const cat = item.category || 'General';
    if (!categoriesMap[cat]) {
      categoriesMap[cat] = {
        category: cat,
        count: 0,
        subtotal_paise: 0,
        gst_paise: 0,
        total_paise: 0,
        items: [],
      };
    }
    categoriesMap[cat].count += 1;
    categoriesMap[cat].subtotal_paise += itemAmount;
    categoriesMap[cat].gst_paise += itemGst;
    categoriesMap[cat].total_paise += itemTotal;
    categoriesMap[cat].items.push(item);
  }

  const grandTotalPaise = subtotalPaise + gstTotalPaise;
  const cgstPaise = Math.round(gstTotalPaise / 2);
  const sgstPaise = gstTotalPaise - cgstPaise;

  return {
    items_count: items.length,
    subtotal_paise: subtotalPaise,
    subtotal_inr: (subtotalPaise / 100).toFixed(2),
    gst_total_paise: gstTotalPaise,
    gst_total_inr: (gstTotalPaise / 100).toFixed(2),
    cgst_paise: cgstPaise,
    cgst_inr: (cgstPaise / 100).toFixed(2),
    sgst_paise: sgstPaise,
    sgst_inr: (sgstPaise / 100).toFixed(2),
    grand_total_paise: grandTotalPaise,
    grand_total_inr: (grandTotalPaise / 100).toFixed(2),
    categories: Object.values(categoriesMap),
  };
}

/**
 * Fetch all BOQ items for a lead (optionally filtered by quotation_id).
 */
function getBoqForLead(db, leadId, quotationId = null) {
  let sql = 'SELECT * FROM boq_items WHERE lead_id = ?';
  const params = [leadId];
  if (quotationId) {
    sql += ' AND quotation_id = ?';
    params.push(quotationId);
  } else {
    sql += ' AND quotation_id IS NULL';
  }
  sql += ' ORDER BY category ASC, id ASC';

  const items = db.prepare(sql).all(...params);
  const summary = summarizeBoq(items);

  return {
    lead_id: leadId,
    quotation_id: quotationId,
    summary,
    items,
  };
}

/**
 * Add a new BOQ item to a lead.
 */
function addBoqItem(db, actor, { lead_id, quotation_id = null, category, item_name, description = '', quantity = 1, unit = 'nos', rate_paise, gst_rate = 18.0 }) {
  const lead = db.prepare('SELECT id, stage FROM leads WHERE id = ?').get(lead_id);
  if (!lead) throw new NotFoundError('Lead not found.');

  // If associated with a finalized quotation, modification is locked
  if (quotation_id) {
    const quote = db.prepare('SELECT id, status FROM quotations WHERE id = ?').get(quotation_id);
    if (quote && ['Sent', 'Approved'].includes(quote.status)) {
      throw new ConflictError('Cannot add BOQ items to a Sent or Approved quotation (version locked).');
    }
  }

  const cleanName = String(item_name || '').trim();
  if (!cleanName) throw new ValidationError('Item name is required.');
  const cleanCat = String(category || 'General').trim();
  const cleanUnit = String(unit || 'nos').trim();
  const cleanDesc = String(description || '').trim();

  const math = calculateLineItem({ quantity, rate_paise, gst_rate });
  const id = generateId(db, 'KRY-BOQ', 'boq_items');

  db.prepare(`
    INSERT INTO boq_items (
      id, lead_id, quotation_id, category, item_name, description, quantity, unit,
      rate_paise, amount_paise, gst_rate, gst_amount_paise, total_paise, version, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  `).run(
    id,
    lead.id,
    quotation_id,
    cleanCat,
    cleanName,
    cleanDesc,
    math.quantity,
    cleanUnit,
    math.rate_paise,
    math.amount_paise,
    math.gst_rate,
    math.gst_amount_paise,
    math.total_paise,
  );

  audit(
    db,
    actor.id,
    'CREATE',
    'boq_item',
    id,
    `Added BOQ item "${cleanName}" (${math.quantity} ${cleanUnit} @ ₹${(math.rate_paise / 100).toFixed(2)})`,
    null,
    { id, lead_id: lead.id, item_name: cleanName, total_paise: math.total_paise },
  );

  return db.prepare('SELECT * FROM boq_items WHERE id = ?').get(id);
}

/**
 * Remove a BOQ item (locked if parent quotation is Sent or Approved).
 */
function deleteBoqItem(db, actor, itemId) {
  const item = db.prepare('SELECT * FROM boq_items WHERE id = ?').get(itemId);
  if (!item) throw new NotFoundError('BOQ item not found.');

  if (item.quotation_id) {
    const quote = db.prepare('SELECT id, status FROM quotations WHERE id = ?').get(item.quotation_id);
    if (quote && ['Sent', 'Approved'].includes(quote.status)) {
      throw new ConflictError('Cannot delete BOQ item from a locked quotation.');
    }
  }

  db.prepare('DELETE FROM boq_items WHERE id = ?').run(itemId);

  audit(
    db,
    actor.id,
    'DELETE',
    'boq_item',
    itemId,
    `Deleted BOQ item "${item.item_name}"`,
    item,
    null,
  );

  return { ok: true, deleted_id: itemId };
}

/**
 * Lock active BOQ items to a specific quotation version upon creation or sending.
 */
function lockBoqToQuotation(db, leadId, quotationId) {
  const updated = db.prepare(`
    UPDATE boq_items
    SET quotation_id = ?
    WHERE lead_id = ? AND quotation_id IS NULL
  `).run(quotationId, leadId);

  return updated.changes;
}

module.exports = {
  calculateLineItem,
  summarizeBoq,
  getBoqForLead,
  addBoqItem,
  deleteBoqItem,
  lockBoqToQuotation,
};
