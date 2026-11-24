ALTER TABLE tasks ADD COLUMN contact_authorized_to TEXT;
ALTER TABLE tasks ADD COLUMN contact_purpose TEXT;
ALTER TABLE tasks ADD COLUMN contact_expires_at TEXT;
UPDATE tasks SET requires_contact = 0, contact_status = 'NOT_REQUIRED' WHERE status IN ('Assigned', 'In Progress');
CREATE TABLE admin_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 requested_by TEXT NOT NULL REFERENCES employees(id),
 message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Resolved')),
 response TEXT,
 resolved_by TEXT REFERENCES employees(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 resolved_at TEXT
);
