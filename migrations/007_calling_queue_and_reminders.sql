-- Migration 007: Calling Queue, My Work, Auto-Reminders, and Activity Ledger
-- Forward-only migration with backfill and append-only immutability triggers.

ALTER TABLE tasks ADD COLUMN contact_status TEXT NOT NULL DEFAULT 'NOT_CONTACTED' CHECK (contact_status IN ('NOT_CONTACTED','CONTACTED','NOT_REQUIRED'));
ALTER TABLE tasks ADD COLUMN requires_contact INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN first_contacted_at TEXT;
ALTER TABLE tasks ADD COLUMN last_contact_at TEXT;
ALTER TABLE tasks ADD COLUMN contact_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_outcome TEXT;
ALTER TABLE tasks ADD COLUMN work_summary TEXT;
ALTER TABLE tasks ADD COLUMN next_action TEXT;
ALTER TABLE tasks ADD COLUMN next_action_date TEXT;

CREATE TABLE IF NOT EXISTS task_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('CALL','WORK_NOTE')),
  outcome TEXT,
  interest TEXT,
  notes TEXT,
  work_done TEXT,
  next_action TEXT,
  next_action_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  task_id TEXT REFERENCES tasks(id),
  type TEXT NOT NULL CHECK (type IN ('CALL_BACK','CUSTOMER_WILL_CALL','FOLLOW_UP')),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','TRIGGERED','DONE','SNOOZED','DISMISSED','CANCELLED')),
  note TEXT,
  created_by TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  triggered_at TEXT,
  admin_task_id TEXT REFERENCES tasks(id),
  resolved_by TEXT REFERENCES employees(id),
  resolved_at TEXT,
  resolution TEXT,
  previous_reminder_id INTEGER REFERENCES reminders(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(assigned_to, status, contact_status);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_date);
CREATE INDEX IF NOT EXISTS idx_activity_task ON task_activity(task_id, id);

CREATE TRIGGER IF NOT EXISTS task_activity_no_update
BEFORE UPDATE ON task_activity
BEGIN
  SELECT RAISE(ABORT, 'task_activity is append-only');
END;

CREATE TRIGGER IF NOT EXISTS task_activity_no_delete
BEFORE DELETE ON task_activity
BEGIN
  SELECT RAISE(ABORT, 'task_activity is append-only');
END;

-- Inactive system actor for automated operations
INSERT OR IGNORE INTO employees (id, name, email, phone, role, department, password_hash, active, joined_at, updated_at)
VALUES ('KRY-SYS-001', 'System', 'system@kryston.local', '+91 99999 00000', 'ADMIN_DESK', 'Administration', '!', 0, datetime('now'), datetime('now'));

-- Backfill existing tasks:
-- 1. Purchase and Accounts tasks: requires_contact = 0, contact_status = 'NOT_REQUIRED'
UPDATE tasks
SET requires_contact = 0,
    contact_status = 'NOT_REQUIRED',
    contact_attempts = 0
WHERE department IN ('Purchase', 'Accounts');

-- 2. Telecaller tasks: CONTACTED only if a telecaller_responses row exists for that lead and assignee, otherwise NOT_CONTACTED
UPDATE tasks
SET requires_contact = 1,
    contact_status = CASE
      WHEN EXISTS (
        SELECT 1 FROM telecaller_responses tr
        WHERE tr.lead_id = tasks.lead_id
          AND tr.telecaller_id = tasks.assigned_to
      ) THEN 'CONTACTED'
      ELSE 'NOT_CONTACTED'
    END,
    contact_attempts = 0
WHERE task_type = 'TELECALLER_ENQUIRY';

-- 3. Other departments: NOT_CONTACTED when status = 'Assigned', otherwise CONTACTED
UPDATE tasks
SET requires_contact = 1,
    contact_status = CASE
      WHEN status = 'Assigned' THEN 'NOT_CONTACTED'
      ELSE 'CONTACTED'
    END,
    contact_attempts = 0
WHERE department NOT IN ('Purchase', 'Accounts')
  AND task_type != 'TELECALLER_ENQUIRY';
