-- Migration 013: Execution, Customer Updates and Procurement
-- Implements change orders with integer paise deltas, purchase requests,
-- and branded customer update drafts.

-- 1. Change Orders
CREATE TABLE IF NOT EXISTS change_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  description TEXT NOT NULL,
  cost_delta_paise INTEGER NOT NULL DEFAULT 0,
  schedule_delta_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Draft', -- 'Draft', 'Pending Customer Approval', 'Approved', 'Rejected'
  customer_approval_ref TEXT,
  approved_by TEXT REFERENCES employees(id),
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_change_orders_project ON change_orders(project_id, status);

-- 2. Purchase Requests (Material Requisitions upgrade)
CREATE TABLE IF NOT EXISTS purchase_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  requested_by TEXT NOT NULL REFERENCES employees(id),
  item_name TEXT NOT NULL,
  category TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'nos',
  estimated_cost_paise INTEGER NOT NULL DEFAULT 0,
  urgency TEXT NOT NULL DEFAULT 'Normal', -- 'Normal', 'Urgent', 'Critical'
  status TEXT NOT NULL DEFAULT 'Pending Admin Approval', -- 'Pending Admin Approval', 'Approved', 'Procuring', 'Fulfilled', 'Rejected'
  approved_by TEXT REFERENCES employees(id),
  approved_at TEXT,
  admin_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchase_requests_proj ON purchase_requests(project_id, status);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_status ON purchase_requests(status);

-- 3. Customer Updates (Branded drafts for Admin sign-off)
CREATE TABLE IF NOT EXISTS customer_updates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  update_type TEXT NOT NULL DEFAULT 'WEEKLY_PROGRESS', -- 'WEEKLY_PROGRESS', 'MILESTONE_REACHED', 'SITE_PHOTOS'
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  photos_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Draft', -- 'Draft', 'Approved by Admin', 'Dispatched'
  dispatched_at TEXT,
  dispatched_via TEXT, -- 'WhatsApp', 'Email', 'Manual'
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_updates_proj ON customer_updates(project_id, status);
CREATE INDEX IF NOT EXISTS idx_customer_updates_lead ON customer_updates(lead_id);
