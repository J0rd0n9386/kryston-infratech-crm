-- Migration 004: 2.4.0-optimistic-locking-and-indexes
-- Optimistic locking versions, phone normalization, duplicate tracking, and performance indexes

ALTER TABLE leads ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE leads ADD COLUMN phone_normalized TEXT;
ALTER TABLE leads ADD COLUMN merged_into TEXT REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN merge_reason TEXT;
ALTER TABLE leads ADD COLUMN merged_at TEXT;

UPDATE leads SET phone_normalized = CASE
  WHEN length(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '')) = 12 AND substr(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', ''), 1, 2) = '91'
    THEN substr(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', ''), 3)
  WHEN length(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '')) = 11 AND substr(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', ''), 1, 1) = '0'
    THEN substr(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', ''), 2)
  ELSE replace(replace(replace(replace(phone, ' ', ''), '-', ''), '+', ''), '(', '')
END
WHERE phone_normalized IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_phone_norm ON leads(phone_normalized) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_stage_owner_created ON leads(stage, current_owner, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_merged_into ON leads(merged_into);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status_due ON tasks(assigned_to, status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_lead_assignee ON tasks(lead_id, assigned_to);

CREATE INDEX IF NOT EXISTS idx_lead_actions_lead_created ON lead_actions(lead_id, created_at DESC);
