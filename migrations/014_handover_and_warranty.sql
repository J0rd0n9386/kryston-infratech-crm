-- Migration 014: Handover, Snags and Warranty Lifecycle
-- Implements snag tracking, warranty certificates, warranty claims,
-- and post-handover customer satisfaction / referral requests.

-- 1. Snag Items
CREATE TABLE IF NOT EXISTS snag_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  description TEXT NOT NULL,
  location TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In Progress', 'Resolved', 'Approved')),
  photo_url TEXT,
  resolved_by TEXT REFERENCES employees(id),
  resolved_at TEXT,
  resolved_notes TEXT,
  approved_by TEXT REFERENCES employees(id),
  approved_at TEXT,
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snag_items_project ON snag_items(project_id, status);

-- 2. Warranties
CREATE TABLE IF NOT EXISTS warranties (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  certificate_number TEXT UNIQUE,
  scope TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  terms TEXT,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Expired', 'Claimed', 'Void')),
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_warranties_project ON warranties(project_id, status);
CREATE INDEX IF NOT EXISTS idx_warranties_lead ON warranties(lead_id);

-- 3. Warranty Claims
CREATE TABLE IF NOT EXISTS warranty_claims (
  id TEXT PRIMARY KEY,
  warranty_id TEXT NOT NULL REFERENCES warranties(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  issue_description TEXT NOT NULL,
  reported_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In Review', 'Service Scheduled', 'Resolved', 'Rejected')),
  action_taken TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_warranty_claims_warranty ON warranty_claims(warranty_id, status);

-- 4. Referral & Review Requests
CREATE TABLE IF NOT EXISTS referral_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  customer_rating INTEGER CHECK (customer_rating BETWEEN 1 AND 5),
  feedback TEXT,
  referral_draft TEXT,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Sent', 'Responded', 'Declined')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_referral_requests_proj ON referral_requests(project_id);
