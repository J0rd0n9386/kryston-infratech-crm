-- Migration 011: Site Visit and BOQ Engine
-- Adds structured site visit scheduling and itemized Bill of Quantities (BOQ) with integer paise.

-- 1. Site Visit Scheduling
CREATE TABLE IF NOT EXISTS site_visits_schedule (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  assigned_engineer TEXT NOT NULL REFERENCES employees(id),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Scheduled', -- 'Scheduled', 'Completed', 'Cancelled', 'Rescheduled'
  site_address TEXT,
  notes TEXT,
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_site_visits_lead ON site_visits_schedule(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_site_visits_engineer ON site_visits_schedule(assigned_engineer, scheduled_at);

-- 2. Structured BOQ Items (integer paise, zero float for money)
CREATE TABLE IF NOT EXISTS boq_items (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  quotation_id TEXT REFERENCES quotations(id),
  category TEXT NOT NULL, -- e.g. 'Civil', 'Electrical', 'Plumbing', 'Carpentry', 'Finishing'
  item_name TEXT NOT NULL,
  description TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'nos', -- 'sq ft', 'nos', 'rft', 'ls'
  rate_paise INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 18.0,
  gst_amount_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_boq_items_lead ON boq_items(lead_id, quotation_id);
CREATE INDEX IF NOT EXISTS idx_boq_items_category ON boq_items(lead_id, category);
