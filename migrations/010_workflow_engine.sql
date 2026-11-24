-- Migration 010: Workflow Engine
-- Adds rework loop caps, negotiation tracking, dynamic approval matrix,
-- delegations, auto-routing rules, and SLA policies.

-- 1. Tasks: rework counter and escalation fields
ALTER TABLE tasks ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN escalated_to TEXT REFERENCES employees(id);
ALTER TABLE tasks ADD COLUMN escalated_at TEXT;

-- 2. Leads: negotiation rounds and lost notes
ALTER TABLE leads ADD COLUMN negotiation_rounds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN lost_notes TEXT;

-- 3. Approval rules matrix (versioned, audited, Super Admin managed)
CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL, -- e.g. 'quotation_discount'
  metric TEXT NOT NULL, -- e.g. 'discount_percent'
  min_value REAL NOT NULL,
  max_value REAL NOT NULL,
  approver_role TEXT NOT NULL, -- 'SALES_MANAGER', 'SENIOR_BDM', 'SUPER_ADMIN'
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_lookup ON approval_rules(entity, active, min_value, max_value);

-- Seed standard discount approval matrix
INSERT OR IGNORE INTO approval_rules (id, entity, metric, min_value, max_value, approver_role, active)
VALUES
  ('AR-DISC-01', 'quotation_discount', 'discount_percent', 10.01, 15.0, 'SALES_MANAGER', 1),
  ('AR-DISC-02', 'quotation_discount', 'discount_percent', 15.01, 20.0, 'SENIOR_BDM', 1),
  ('AR-DISC-03', 'quotation_discount', 'discount_percent', 20.01, 100.0, 'SUPER_ADMIN', 1);

-- 4. Delegations table (Super Admin delegates Admin Desk authority)
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  granter_id TEXT NOT NULL REFERENCES employees(id),
  delegate_id TEXT NOT NULL REFERENCES employees(id),
  role TEXT NOT NULL DEFAULT 'ADMIN_DESK',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delegations_active ON delegations(delegate_id, active, start_at, end_at);

-- 5. Auto-routing rules
CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  channel TEXT,
  target_dept TEXT NOT NULL DEFAULT 'Marketing',
  target_role TEXT NOT NULL DEFAULT 'TELECALLER',
  strategy TEXT NOT NULL DEFAULT 'ROUND_ROBIN',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_source ON routing_rules(source, active);

INSERT OR IGNORE INTO routing_rules (id, source, channel, target_dept, target_role, strategy, active)
VALUES
  ('RR-META-01', 'Meta Ads', 'Online', 'Marketing', 'TELECALLER', 'ROUND_ROBIN', 1),
  ('RR-GOOG-01', 'Google Search', 'Online', 'Marketing', 'TELECALLER', 'ROUND_ROBIN', 1),
  ('RR-WEB-01', 'Website', 'Online', 'Marketing', 'TELECALLER', 'ROUND_ROBIN', 1);

-- 6. Configurable SLA policies table
CREATE TABLE IF NOT EXISTS sla_settings (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL UNIQUE,
  target_minutes INTEGER NOT NULL,
  warning_minutes INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO sla_settings (id, stage, target_minutes, warning_minutes, active)
VALUES
  ('SLA-CALL-01', 'With Telecaller', 30, 20, 1),
  ('SLA-ENG-01', 'Routed to Engineering', 4320, 2880, 1),  -- 3 days target, 2 days warning
  ('SLA-DES-01', 'Routed to Design', 7200, 4320, 1),       -- 5 days target, 3 days warning
  ('SLA-QUOTE-01', 'Quotation Stage', 2880, 1440, 1);      -- 2 days target, 1 day warning
