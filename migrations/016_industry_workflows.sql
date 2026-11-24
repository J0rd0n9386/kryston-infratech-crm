-- Industry workflow controls: negotiation revisions, scoped customer contact,
-- department requests and acknowledged project handoff.

ALTER TABLE tasks ADD COLUMN contact_channels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE admin_requests ADD COLUMN target_department TEXT;
ALTER TABLE admin_requests ADD COLUMN due_at TEXT;
ALTER TABLE admin_requests ADD COLUMN acknowledged_at TEXT;

ALTER TABLE quotation_versions ADD COLUMN revision_reason TEXT;
ALTER TABLE quotation_versions ADD COLUMN manager_status TEXT NOT NULL DEFAULT 'Pending';
ALTER TABLE quotation_versions ADD COLUMN manager_remarks TEXT;
ALTER TABLE quotation_versions ADD COLUMN manager_id TEXT REFERENCES employees(id);
ALTER TABLE quotation_versions ADD COLUMN manager_decided_at TEXT;
ALTER TABLE quotation_versions ADD COLUMN admin_status TEXT NOT NULL DEFAULT 'Pending';
ALTER TABLE quotation_versions ADD COLUMN admin_remarks TEXT;
ALTER TABLE quotation_versions ADD COLUMN admin_id TEXT REFERENCES employees(id);
ALTER TABLE quotation_versions ADD COLUMN admin_decided_at TEXT;
ALTER TABLE quotation_versions ADD COLUMN customer_status TEXT NOT NULL DEFAULT 'Pending';
ALTER TABLE quotation_versions ADD COLUMN customer_response_ref TEXT;
ALTER TABLE quotation_versions ADD COLUMN customer_responded_at TEXT;

CREATE TABLE negotiation_rounds (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES quotations(id),
  quotation_version INTEGER NOT NULL,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  requested_by TEXT NOT NULL REFERENCES employees(id),
  customer_request TEXT NOT NULL,
  proposed_amount REAL,
  proposed_discount_percent REAL,
  proposed_terms TEXT,
  proposed_payment_milestones TEXT,
  status TEXT NOT NULL DEFAULT 'Pending Manager'
    CHECK(status IN ('Pending Manager','Pending Admin','Released to Sales','Rejected','Accepted by Customer')),
  manager_id TEXT REFERENCES employees(id),
  manager_decision TEXT,
  manager_remarks TEXT,
  admin_id TEXT REFERENCES employees(id),
  admin_decision TEXT,
  admin_remarks TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  manager_decided_at TEXT,
  admin_decided_at TEXT,
  customer_accepted_at TEXT
);
CREATE INDEX idx_negotiation_quote ON negotiation_rounds(quotation_id, created_at DESC);
CREATE INDEX idx_negotiation_status ON negotiation_rounds(status, created_at DESC);

CREATE TABLE project_handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  quotation_id TEXT NOT NULL REFERENCES quotations(id),
  quotation_version INTEGER NOT NULL,
  scope_summary TEXT NOT NULL,
  exclusions TEXT,
  payment_milestones TEXT,
  site_risks TEXT,
  open_commitments TEXT,
  status TEXT NOT NULL DEFAULT 'Pending PM Acknowledgement'
    CHECK(status IN ('Pending PM Acknowledgement','Acknowledged','Returned to Admin','Complete')),
  prepared_by TEXT NOT NULL REFERENCES employees(id),
  acknowledged_by TEXT REFERENCES employees(id),
  acknowledgement_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_handoffs_status ON project_handoffs(status, created_at DESC);

CREATE TABLE variation_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_order_id TEXT NOT NULL REFERENCES change_orders(id),
  action TEXT NOT NULL CHECK(action IN ('Submitted','Customer Accepted','Customer Rejected','Admin Approved')),
  reference TEXT,
  remarks TEXT,
  actor_id TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
