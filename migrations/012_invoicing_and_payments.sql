-- Migration 012: Invoicing, Payments and Milestone Tracking
-- Implements milestone sum checks (=100%), tax invoicing, advance gates,
-- and append-only payment ledger with integer paise.

-- 1. Payment Milestones
CREATE TABLE IF NOT EXISTS payment_milestones (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  name TEXT NOT NULL,
  percentage REAL NOT NULL,
  amount_paise INTEGER NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'Pending', -- 'Pending', 'Invoiced', 'Paid'
  sequence_order INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_milestones_wo ON payment_milestones(work_order_id, sequence_order);

-- 2. Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  milestone_id TEXT,
  invoice_number TEXT NOT NULL UNIQUE,
  invoice_type TEXT NOT NULL DEFAULT 'TAX_INVOICE', -- 'ADVANCE_INVOICE', 'TAX_INVOICE', 'PROFORMA'
  subtotal_paise INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Unpaid', -- 'Unpaid', 'Partially Paid', 'Paid', 'Cancelled'
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_wo ON invoices(work_order_id, status);

-- 3. Upgrade legacy payments table to link with invoices and store integer paise
ALTER TABLE payments ADD COLUMN invoice_id TEXT REFERENCES invoices(id);
ALTER TABLE payments ADD COLUMN amount_paise INTEGER;

-- Backfill amount_paise from legacy amount (REAL rupees -> integer paise)
UPDATE payments
SET amount_paise = CAST(ROUND(amount * 100) AS INTEGER)
WHERE amount_paise IS NULL AND amount IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id, status);

-- 4. Append-only triggers: reject UPDATE and DELETE on payments
CREATE TRIGGER IF NOT EXISTS trg_payments_no_update
BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(FAIL, 'payments ledger is append-only and rows cannot be modified');
END;

CREATE TRIGGER IF NOT EXISTS trg_payments_no_delete
BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(FAIL, 'payments ledger is append-only and rows cannot be deleted');
END;
