-- Migration 001: 2.1.0-enterprise-schema
-- Initial enterprise schema for Kryston Infratech CRM

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN (
      'SUPER_ADMIN', 'ADMIN_DESK', 'SALES_MANAGER', 'SENIOR_BDM',
      'BDM', 'BDE', 'TELECALLER', 'SITE_ENGINEER', 'ARCHITECT',
      'DIGITAL_MARKETING', 'PROJECT_MANAGER', 'PURCHASE', 'ACCOUNTS'
    )
  ),
  department TEXT NOT NULL CHECK (
    department IN (
      'Management', 'Administration', 'Sales', 'Marketing',
      'Technical', 'Design', 'Projects', 'Purchase', 'Accounts'
    )
  ),
  manager_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'Online' CHECK (channel IN ('Online', 'Offline')),
  source TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  location TEXT,
  area TEXT,
  requirement TEXT,
  budget_range TEXT,
  timeline TEXT,
  stage TEXT NOT NULL DEFAULT 'New' CHECK (
    stage IN (
      'New', 'With Telecaller', 'Response Received', 'Routed to Sales',
      'Routed to Engineering', 'Routed to Design', 'Routed to Purchase',
      'Routed to Accounts', 'Update Received', 'Follow-up Required',
      'Site Visit Scheduled', 'Design In Progress', 'Quotation Stage',
      'Quotation Sent', 'Negotiation', 'Approved',
      'Work Order Pending Admin Approval', 'Work Order Finalized',
      'Project Handoff', 'In Progress', 'Completed', 'Closed', 'Lost', 'Nurture'
    )
  ),
  current_owner TEXT REFERENCES employees(id) ON DELETE SET NULL,
  assigned_telecaller TEXT REFERENCES employees(id) ON DELETE SET NULL,
  assigned_bdm TEXT REFERENCES employees(id) ON DELETE SET NULL,
  assigned_engineer TEXT REFERENCES employees(id) ON DELETE SET NULL,
  assigned_architect TEXT REFERENCES employees(id) ON DELETE SET NULL,
  assigned_pm TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  wo_value REAL CHECK (wo_value IS NULL OR wo_value >= 0),
  lost_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  from_employee TEXT REFERENCES employees(id) ON DELETE SET NULL,
  to_employee TEXT REFERENCES employees(id) ON DELETE SET NULL,
  to_department TEXT,
  remarks TEXT,
  old_stage TEXT,
  new_stage TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  assigned_by TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  department TEXT NOT NULL CHECK (
    department IN (
      'Management', 'Administration', 'Sales', 'Marketing',
      'Technical', 'Design', 'Projects', 'Purchase', 'Accounts'
    )
  ),
  task_type TEXT NOT NULL,
  brief TEXT NOT NULL,
  due_date TEXT,
  sla_hours INTEGER NOT NULL DEFAULT 48 CHECK (sla_hours > 0),
  status TEXT NOT NULL DEFAULT 'Assigned' CHECK (
    status IN ('Assigned', 'In Progress', 'Submitted', 'Reviewed', 'Closed', 'Cancelled')
  ),
  response TEXT,
  reviewed_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  review_remarks TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS telecaller_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  telecaller_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  customer_intent TEXT CHECK (customer_intent IS NULL OR customer_intent IN ('Hot', 'Warm', 'Cold', 'Not Interested')),
  budget_range TEXT,
  timeline TEXT,
  area TEXT,
  requirement_detail TEXT,
  objections TEXT,
  call_outcome TEXT,
  next_followup TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dept_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  findings TEXT NOT NULL,
  recommendation TEXT,
  status TEXT NOT NULL DEFAULT 'Submitted' CHECK (
    status IN ('Submitted', 'Reviewed', 'Clarification Needed', 'Approved', 'Rejected')
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  engineer_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  visit_date TEXT NOT NULL,
  visit_time TEXT,
  site_condition TEXT,
  technical_report TEXT NOT NULL,
  measurements TEXT,
  customer_present INTEGER DEFAULT 1 CHECK (customer_present IN (0, 1)),
  customer_feedback TEXT,
  recommendation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  architect_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  design_type TEXT,
  description TEXT NOT NULL,
  file_url TEXT,
  status TEXT NOT NULL DEFAULT 'Submitted' CHECK (
    status IN ('Draft', 'Submitted', 'Revision Needed', 'Approved', 'Rejected')
  ),
  approved_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotations (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  amount REAL NOT NULL CHECK (amount >= 0),
  terms TEXT,
  payment_milestones TEXT,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (
    status IN ('Draft', 'Sent', 'Negotiation', 'Approved', 'Rejected', 'Revised')
  ),
  created_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE RESTRICT,
  quotation_id TEXT REFERENCES quotations(id) ON DELETE SET NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  customer_approval_date TEXT NOT NULL,
  details TEXT,
  documents TEXT,
  status TEXT NOT NULL DEFAULT 'Pending Admin Approval' CHECK (
    status IN ('Draft', 'Pending Admin Approval', 'Finalized', 'Active', 'Completed', 'Cancelled')
  ),
  created_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL UNIQUE REFERENCES work_orders(id) ON DELETE RESTRICT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  project_manager TEXT REFERENCES employees(id) ON DELETE SET NULL,
  site_engineer TEXT REFERENCES employees(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Planning' CHECK (
    status IN ('Planning', 'In Progress', 'On Hold', 'Completed', 'Closed')
  ),
  milestones TEXT,
  progress REAL NOT NULL DEFAULT 0.0 CHECK (progress >= 0.0 AND progress <= 100.0),
  start_date TEXT,
  target_completion TEXT,
  actual_completion TEXT,
  handoff_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  handoff_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  update_type TEXT NOT NULL,
  details TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0.0 CHECK (progress >= 0.0 AND progress <= 100.0),
  blockers TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  order_index INTEGER NOT NULL DEFAULT 1,
  weightage_percent REAL NOT NULL DEFAULT 0.0 CHECK (weightage_percent >= 0.0 AND weightage_percent <= 100.0),
  target_date TEXT,
  completed_date TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'In Progress', 'Completed', 'Delayed')),
  verified_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  milestone_id INTEGER REFERENCES project_milestones(id) ON DELETE SET NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  payment_mode TEXT NOT NULL DEFAULT 'NEFT/RTGS',
  transaction_ref TEXT,
  payment_date TEXT NOT NULL DEFAULT (date('now')),
  status TEXT NOT NULL DEFAULT 'Received' CHECK (status IN ('Received', 'Pending Verification', 'Dishonoured', 'Refunded')),
  notes TEXT,
  received_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS material_requisitions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  specification TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL DEFAULT 'Nos',
  estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  vendor_name TEXT,
  status TEXT NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested', 'Approved', 'Ordered', 'Delivered', 'Cancelled')),
  requested_by TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  approved_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  required_by_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('lead', 'task', 'design', 'site_visit', 'work_order', 'project')),
  entity_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT,
  file_size_bytes INTEGER,
  caption TEXT,
  uploaded_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  entity_type TEXT,
  entity_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_state TEXT,
  after_state TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_stage_owner ON leads(stage, current_owner);
CREATE INDEX IF NOT EXISTS idx_leads_stage_updated ON leads(stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_channel_source ON leads(channel, source);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_tc ON leads(assigned_telecaller);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_bdm ON leads(assigned_bdm);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_eng ON leads(assigned_engineer);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_arc ON leads(assigned_architect);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_pm ON leads(assigned_pm);
CREATE INDEX IF NOT EXISTS idx_leads_creator ON leads(created_by);

CREATE INDEX IF NOT EXISTS idx_lead_actions_lead_date ON lead_actions(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_actions_created ON lead_actions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_lead_status ON tasks(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_dept_status ON tasks(department, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telecaller_lead ON telecaller_responses(lead_id);
CREATE INDEX IF NOT EXISTS idx_dept_updates_task ON dept_updates(task_id);
CREATE INDEX IF NOT EXISTS idx_site_visits_lead ON site_visits(lead_id);
CREATE INDEX IF NOT EXISTS idx_designs_lead_ver ON designs(lead_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_quotations_lead ON quotations(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_work_orders_lead ON work_orders(lead_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_projects_lead ON projects(lead_id);
CREATE INDEX IF NOT EXISTS idx_projects_pm_status ON projects(project_manager, status);
CREATE INDEX IF NOT EXISTS idx_projects_se_status ON projects(site_engineer, status);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_project_updates_proj ON project_updates(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_milestones_proj ON project_milestones(project_id, order_index);
CREATE INDEX IF NOT EXISTS idx_payments_wo ON payments(work_order_id);
CREATE INDEX IF NOT EXISTS idx_requisitions_proj ON material_requisitions(project_id);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON lead_attachments(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_notifications_emp_unread ON notifications(employee_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_emp_all ON notifications(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_employees_role_active ON employees(role, active);

CREATE TRIGGER IF NOT EXISTS lead_actions_no_update
BEFORE UPDATE ON lead_actions BEGIN SELECT RAISE(ABORT, 'lead timeline entries are immutable'); END;

CREATE TRIGGER IF NOT EXISTS lead_actions_no_delete
BEFORE DELETE ON lead_actions BEGIN SELECT RAISE(ABORT, 'lead timeline entries are immutable'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit records are immutable'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit records are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_leads_updated_at
AFTER UPDATE ON leads FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE leads SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
AFTER UPDATE ON tasks FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_employees_updated_at
AFTER UPDATE ON employees FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE employees SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_requisitions_updated_at
AFTER UPDATE ON material_requisitions FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE material_requisitions SET updated_at = datetime('now') WHERE id = NEW.id; END;
