-- Kryston Infratech Enterprise CRM - Phase 4 Migration
-- 006_analytics_and_business.sql: Lead enterprise fields, quotation versioning, and discount threshold approvals

-- 1. Add enterprise fields to leads: project_type, city, area_sqft, budget_band
ALTER TABLE leads ADD COLUMN project_type TEXT CHECK (project_type IS NULL OR project_type IN ('construction', 'interior', 'architecture'));
ALTER TABLE leads ADD COLUMN city TEXT;
ALTER TABLE leads ADD COLUMN area_sqft REAL;
ALTER TABLE leads ADD COLUMN budget_band TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_project_type ON leads(project_type);
CREATE INDEX IF NOT EXISTS idx_leads_city ON leads(city);

-- 2. Add discount and approval fields to quotations
ALTER TABLE quotations ADD COLUMN discount_percent REAL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN requires_approval INTEGER DEFAULT 0 CHECK (requires_approval IN (0, 1));
ALTER TABLE quotations ADD COLUMN approval_status TEXT DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE quotations ADD COLUMN approval_remarks TEXT;

-- 3. Quotation version history table to preserve snapshot history
CREATE TABLE IF NOT EXISTS quotation_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  amount REAL NOT NULL,
  tax_amount REAL DEFAULT 0,
  discount_percent REAL DEFAULT 0,
  terms TEXT,
  payment_milestones TEXT,
  status TEXT NOT NULL,
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quot_versions_quote_id ON quotation_versions(quotation_id, version);
