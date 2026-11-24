-- Kryston Infratech Enterprise CRM - Phase 3 Migration
-- 005_attachments_and_notifications.sql: Attachments storage, notification outbox, preferences, and SLA/digest tracking

-- 1. Attachments table for files linked to dept_updates, designs, site_visits, work orders, quotations, tasks, leads
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('dept_update', 'design', 'site_visit', 'work_order', 'quotation', 'lead', 'task', 'project')),
  entity_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  scan_status TEXT NOT NULL DEFAULT 'clean' CHECK (scan_status IN ('clean', 'infected', 'pending')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_by ON attachments(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at DESC);

-- 2. Per-user notification preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('TASK_ASSIGNED', 'UPDATE_SUBMITTED', 'SLA_BREACH', 'WO_APPROVED', 'REWORK_REQUESTED', 'DAILY_DIGEST')),
  channel_in_app INTEGER NOT NULL DEFAULT 1 CHECK (channel_in_app IN (0, 1)),
  channel_email INTEGER NOT NULL DEFAULT 1 CHECK (channel_email IN (0, 1)),
  channel_whatsapp INTEGER NOT NULL DEFAULT 0 CHECK (channel_whatsapp IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_notif_pref_emp ON notification_preferences(employee_id);

-- 3. Notification Outbox for reliable background delivery with retry, backoff, dedupe, and dead-letter
CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'whatsapp')),
  recipient_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_retry ON notification_outbox(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_outbox_dedupe ON notification_outbox(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_outbox_recipient ON notification_outbox(recipient_id);

-- 4. SLA Breach notifications tracking (ensures exactly-once notification per breach)
CREATE TABLE IF NOT EXISTS sla_breach_notifications (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  breached_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Daily digest log (ensures exactly-once daily digest run per day)
CREATE TABLE IF NOT EXISTS daily_digest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_date TEXT NOT NULL UNIQUE,
  sent_count INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
