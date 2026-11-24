-- Migration 002: 2.2.0-hardening
-- Session revocation, SLA timestamps, work-order approval and quote review fields

ALTER TABLE employees ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN last_login_at TEXT;

ALTER TABLE leads ADD COLUMN priority TEXT NOT NULL DEFAULT 'Medium';
ALTER TABLE leads ADD COLUMN deleted_at TEXT;

ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'Medium';
ALTER TABLE tasks ADD COLUMN started_at TEXT;
ALTER TABLE tasks ADD COLUMN submitted_at TEXT;
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
UPDATE tasks SET updated_at = datetime('now') WHERE updated_at IS NULL;

ALTER TABLE telecaller_responses ADD COLUMN call_duration_seconds INTEGER DEFAULT 0;
ALTER TABLE dept_updates ADD COLUMN attachments TEXT;
ALTER TABLE designs ADD COLUMN review_remarks TEXT;

ALTER TABLE quotations ADD COLUMN tax_amount REAL DEFAULT 0.0;
ALTER TABLE quotations ADD COLUMN updated_at TEXT;
UPDATE quotations SET updated_at = datetime('now') WHERE updated_at IS NULL;

ALTER TABLE work_orders ADD COLUMN approved_at TEXT;
ALTER TABLE work_orders ADD COLUMN updated_at TEXT;
UPDATE work_orders SET updated_at = datetime('now') WHERE updated_at IS NULL;

ALTER TABLE projects ADD COLUMN updated_at TEXT;
UPDATE projects SET updated_at = datetime('now') WHERE updated_at IS NULL;

ALTER TABLE project_updates ADD COLUMN attachments TEXT;
ALTER TABLE audit_log ADD COLUMN ip_address TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority);
CREATE INDEX IF NOT EXISTS idx_leads_deleted ON leads(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

CREATE TRIGGER IF NOT EXISTS trg_quotations_updated_at
AFTER UPDATE ON quotations FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE quotations SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_work_orders_updated_at
AFTER UPDATE ON work_orders FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE work_orders SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_projects_updated_at
AFTER UPDATE ON projects FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE projects SET updated_at = datetime('now') WHERE id = NEW.id; END;
