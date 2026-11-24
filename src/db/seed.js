/**
 * Demo seed for local evaluation.
 *
 * Disabled in production (SEED_DEMO=false). IDs use the current year so they
 * match the live sequential generator, and every record is idempotent by virtue
 * of the "no employees" guard.
 */
'use strict';

const config = require('../config');

function seedDemo(db, bcrypt) {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE id != 'KRY-SYS-001'").get().c;
  if (existing > 0) return;

  const year = new Date().getFullYear();
  const leadId = (n) => `KRY-LEAD-${year}-${String(n).padStart(4, '0')}`;
  const taskId = (n) => `KRY-TASK-${year}-${String(n).padStart(4, '0')}`;
  const quoteId = (n) => `KRY-QUOT-${year}-${String(n).padStart(4, '0')}`;
  const woId = (n) => `KRY-WO-${year}-${String(n).padStart(4, '0')}`;
  const projId = (n) => `KRY-PROJ-${year}-${String(n).padStart(4, '0')}`;

  const passwordHash = bcrypt.hashSync(config.demoPassword, config.bcryptRounds);
  const utcStamp = (offsetMs = 0) =>
    new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

  const employees = [
    ['KRY-SA-001', 'Super Admin', 'superadmin@kryston.local', 'SUPER_ADMIN', 'Management', null],
    ['KRY-AD-001', 'Admin Desk', 'admin@kryston.local', 'ADMIN_DESK', 'Administration', 'KRY-SA-001'],
    ['KRY-SM-001', 'Sales Manager', 'salesmanager@kryston.local', 'SALES_MANAGER', 'Sales', 'KRY-AD-001'],
    ['KRY-SBDM-001', 'Senior BDM', 'seniorbdm@kryston.local', 'SENIOR_BDM', 'Sales', 'KRY-SM-001'],
    ['KRY-BDM-001', 'BDM Demo', 'bdm@kryston.local', 'BDM', 'Sales', 'KRY-SBDM-001'],
    ['KRY-BDE-001', 'Sales Executive', 'salesexec@kryston.local', 'BDE', 'Sales', 'KRY-SBDM-001'],
    ['KRY-TC-001', 'Telecaller Demo', 'telecaller@kryston.local', 'TELECALLER', 'Marketing', 'KRY-AD-001'],
    ['KRY-SE-001', 'Site Engineer Demo', 'engineer@kryston.local', 'SITE_ENGINEER', 'Technical', 'KRY-AD-001'],
    ['KRY-AR-001', 'Architect Demo', 'architect@kryston.local', 'ARCHITECT', 'Design', 'KRY-AD-001'],
    ['KRY-DM-001', 'Digital Marketing Demo', 'digital@kryston.local', 'DIGITAL_MARKETING', 'Marketing', 'KRY-AD-001'],
    ['KRY-PM-001', 'Project Manager Demo', 'projectmanager@kryston.local', 'PROJECT_MANAGER', 'Projects', 'KRY-AD-001'],
    ['KRY-PUR-001', 'Purchase Officer', 'purchase@kryston.local', 'PURCHASE', 'Purchase', 'KRY-AD-001'],
    ['KRY-AC-001', 'Accounts Demo', 'accounts@kryston.local', 'ACCOUNTS', 'Accounts', 'KRY-AD-001'],
  ];

  const insertEmployee = db.prepare(
    `INSERT INTO employees (id, name, email, phone, password_hash, role, department, manager_id, active)
     VALUES (?, ?, ?, '9876543210', ?, ?, ?, ?, 1)`,
  );
  for (const [id, name, email, role, department, manager] of employees) {
    insertEmployee.run(id, name, email, passwordHash, role, department, manager);
  }

  const insertLead = db.prepare(
    `INSERT INTO leads (
       id, channel, source, customer_name, phone, email, location, area,
       requirement, budget_range, timeline, priority, stage, current_owner,
       assigned_telecaller, assigned_bdm, assigned_engineer, assigned_architect, assigned_pm,
       created_by, wo_value, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
  );

  const insertAction = db.prepare(
    `INSERT INTO lead_actions
      (lead_id, action_type, from_employee, to_employee, to_department, remarks, old_stage, new_stage, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
  );

  const insertTask = db.prepare(
    `INSERT INTO tasks
      (id, lead_id, assigned_to, assigned_by, department, task_type, priority, brief, due_date, sla_hours, status, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now', ?), ?, ?, datetime('now', ?), ?)`,
  );

  function addLead(row, createdAtOffset) {
    insertLead.run(
      row.id,
      row.channel,
      row.source,
      row.customer_name,
      row.phone,
      row.email,
      row.location,
      row.area,
      row.requirement,
      row.budget_range,
      row.timeline,
      row.priority || 'Medium',
      row.stage,
      row.current_owner,
      row.assigned_telecaller || null,
      row.assigned_bdm || null,
      row.assigned_engineer || null,
      row.assigned_architect || null,
      row.assigned_pm || null,
      'KRY-AD-001',
      row.wo_value || null,
      createdAtOffset,
      row.updatedOffset || createdAtOffset,
    );
  }

  // 1. Fresh intake
  addLead(
    {
      id: leadId(1),
      channel: 'Online',
      source: 'Meta Ads',
      customer_name: 'Rajesh Sharma',
      phone: '9811223344',
      email: 'rajesh.sharma@gmail.com',
      location: 'Sector 62, Noida',
      area: '2800 sq ft',
      requirement: 'Full villa interior and modular kitchen',
      budget_range: '₹25 - 35 Lakhs',
      timeline: 'Within 2 months',
      priority: 'High',
      stage: 'New',
      current_owner: 'KRY-AD-001',
    },
    '-3 days',
  );
  insertAction.run(leadId(1), 'CREATED', 'KRY-AD-001', 'KRY-AD-001', 'Administration', 'Lead received via Meta Ads and verified by Admin Desk', null, 'New', '-3 days');

  // 2. With telecaller
  addLead(
    {
      id: leadId(2),
      channel: 'Online',
      source: 'Google Ads',
      customer_name: 'Pooja Verma',
      phone: '9822334455',
      email: 'pooja.verma@outlook.com',
      location: 'Indirapuram, Ghaziabad',
      area: '3BHK, 1850 sq ft',
      requirement: 'Complete home renovation and false ceiling',
      budget_range: '₹15 - 20 Lakhs',
      timeline: 'Immediate',
      stage: 'With Telecaller',
      current_owner: 'KRY-TC-001',
      assigned_telecaller: 'KRY-TC-001',
    },
    '-2 days',
  );
  insertAction.run(leadId(2), 'CREATED', 'KRY-AD-001', 'KRY-AD-001', 'Administration', 'Lead received via Google Ads', null, 'New', '-2 days');
  insertAction.run(leadId(2), 'ASSIGNED_TO_TELECALLER', 'KRY-AD-001', 'KRY-TC-001', 'Marketing', 'Assigned for initial requirement qualification call', 'New', 'With Telecaller', '-2 days');
  insertTask.run(taskId(1), leadId(2), 'KRY-TC-001', 'KRY-AD-001', 'Marketing', 'TELECALLER_ENQUIRY', 'High', 'Call customer, verify location, budget, timeline and intent.', '+1 days', 24, 'Assigned', '-2 days', null);

  // 3. Response received, awaiting Admin routing
  addLead(
    {
      id: leadId(3),
      channel: 'Online',
      source: 'Website',
      customer_name: 'Vikram Malhotra',
      phone: '9833445566',
      email: 'vikram.m@corporates.com',
      location: 'Greater Noida West',
      area: '3500 sq ft commercial',
      requirement: 'Office interior and glass partitions',
      budget_range: '₹40 - 50 Lakhs',
      timeline: '1 month',
      priority: 'Urgent',
      stage: 'Response Received',
      current_owner: 'KRY-AD-001',
      assigned_telecaller: 'KRY-TC-001',
      updatedOffset: '-1 day',
    },
    '-2 days',
  );
  insertAction.run(leadId(3), 'CREATED', 'KRY-AD-001', 'KRY-AD-001', 'Administration', 'Lead registered via website form', null, 'New', '-2 days');
  insertAction.run(leadId(3), 'ASSIGNED_TO_TELECALLER', 'KRY-AD-001', 'KRY-TC-001', 'Marketing', 'Assigned for enquiry capture', 'New', 'With Telecaller', '-2 days');
  insertAction.run(leadId(3), 'TELECALLER_RESPONSE', 'KRY-TC-001', 'KRY-AD-001', 'Administration', 'Hot lead. Customer needs an on-site inspection immediately.', 'With Telecaller', 'Response Received', '-1 day');

  db.prepare(
    `INSERT INTO telecaller_responses
      (lead_id, telecaller_id, customer_intent, budget_range, timeline, area, requirement_detail,
       objections, call_outcome, next_followup, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, date('now', '+1 day'), ?, datetime('now', '-1 day'))`,
  ).run(
    leadId(3),
    'KRY-TC-001',
    'Hot',
    '₹40 - 50 Lakhs',
    '1 month',
    '3500 sq ft commercial space',
    'Turnkey corporate interior, glass cabins, acoustic ceiling, electrical cabling.',
    'Timeline is tight; needs a quotation within 4 days.',
    'Connected',
    'Decision maker spoken to. Eager to meet the Site Engineer.',
  );

  // 4. Routed to Site Engineer
  addLead(
    {
      id: leadId(4),
      channel: 'Offline',
      source: 'Field Marketing',
      customer_name: 'Ananya Gupta',
      phone: '9844556677',
      email: 'ananya.gupta@gmail.com',
      location: 'Golf Course Road, Gurgaon',
      area: '4500 sq ft duplex',
      requirement: 'Turnkey architectural, civil structure and luxury interior',
      budget_range: '₹70 - 90 Lakhs',
      timeline: '3 months',
      priority: 'High',
      stage: 'Routed to Engineering',
      current_owner: 'KRY-SE-001',
      assigned_telecaller: 'KRY-TC-001',
      assigned_bdm: 'KRY-BDM-001',
      assigned_engineer: 'KRY-SE-001',
    },
    '-5 days',
    '-1 day',
  );
  insertAction.run(leadId(4), 'CREATED', 'KRY-AD-001', 'KRY-AD-001', 'Administration', 'Lead captured via field marketing campaign', null, 'New', '-5 days');
  insertAction.run(leadId(4), 'ASSIGNED_TO_TELECALLER', 'KRY-AD-001', 'KRY-TC-001', 'Marketing', 'Initial verification', 'New', 'With Telecaller', '-4 days');
  insertAction.run(leadId(4), 'TELECALLER_RESPONSE', 'KRY-TC-001', 'KRY-AD-001', 'Administration', 'Customer confirmed site visit readiness.', 'With Telecaller', 'Response Received', '-3 days');
  insertAction.run(leadId(4), 'ROUTED_TO_DEPT', 'KRY-AD-001', 'KRY-SE-001', 'Technical', 'Admin routed to Site Engineer for technical measurement and structure analysis', 'Response Received', 'Routed to Engineering', '-1 day');
  insertTask.run(taskId(2), leadId(4), 'KRY-SE-001', 'KRY-AD-001', 'Technical', 'SITE_VISIT', 'High', 'Conduct detailed structural inspection, take room measurements, check plumbing and load-bearing walls.', '+2 days', 48, 'In Progress', '-1 day', utcStamp(-20 * 3600 * 1000));

  // 5. Quotation stage (reviewed sales task)
  addLead(
    {
      id: leadId(5),
      channel: 'Offline',
      source: 'Reference',
      customer_name: 'Meera Kapoor',
      phone: '9866778899',
      email: 'meera.kapoor@kapoorliving.in',
      location: 'Vasant Vihar, New Delhi',
      area: '3200 sq ft',
      requirement: 'Luxury apartment interior and imported modular kitchen',
      budget_range: '₹45 - 55 Lakhs',
      timeline: '4 months',
      priority: 'High',
      stage: 'Quotation Stage',
      current_owner: 'KRY-BDM-001',
      assigned_telecaller: 'KRY-TC-001',
      assigned_bdm: 'KRY-BDM-001',
      updatedOffset: '-2 days',
    },
    '-8 days',
  );
  insertAction.run(leadId(5), 'CREATED', 'KRY-AD-001', 'KRY-AD-001', 'Administration', 'Reference lead from existing client', null, 'New', '-8 days');
  insertAction.run(leadId(5), 'ROUTED_TO_DEPT', 'KRY-AD-001', 'KRY-BDM-001', 'Sales', 'Admin routed to Sales for requirement review and proposal', 'Response Received', 'Routed to Sales', '-4 days');
  insertAction.run(leadId(5), 'DEPT_UPDATE', 'KRY-BDM-001', 'KRY-AD-001', 'Sales', 'Sales reviewed scope and recommended a turnkey quotation.', 'Routed to Sales', 'Update Received', '-3 days');
  insertAction.run(leadId(5), 'ADMIN_REVIEW', 'KRY-AD-001', 'KRY-BDM-001', 'Sales', 'Admin reviewed the Sales recommendation and advanced the lead to quotation.', 'Update Received', 'Quotation Stage', '-2 days');
  insertTask.run(taskId(3), leadId(5), 'KRY-BDM-001', 'KRY-AD-001', 'Sales', 'SALES_REVIEW', 'High', 'Review scope, validate budget and prepare the quotation package.', '-1 days', 48, 'Reviewed', '-4 days', utcStamp(-4 * 24 * 3600 * 1000));
  db.prepare(
    `UPDATE tasks SET response = ?, reviewed_by = 'KRY-AD-001', review_remarks = ?, reviewed_at = datetime('now', '-2 days')
     WHERE id = ?`,
  ).run('Scope validated. Recommend turnkey quotation at ₹48.5L.', 'Proceed to quotation.', taskId(3));

  // 6. Work order finalized and handed off
  addLead(
    {
      id: leadId(6),
      channel: 'Offline',
      source: 'Reference',
      customer_name: 'Sunil Mittal',
      phone: '9855667788',
      email: 'sunil.mittal@mittalgroup.in',
      location: 'Sector 50, Noida',
      area: '5000 sq ft showroom',
      requirement: 'Commercial showroom fitout and facade',
      budget_range: '₹85,00,000',
      timeline: 'Completed',
      priority: 'Urgent',
      stage: 'Work Order Finalized',
      current_owner: 'KRY-PM-001',
      assigned_telecaller: 'KRY-TC-001',
      assigned_bdm: 'KRY-SM-001',
      assigned_engineer: 'KRY-SE-001',
      assigned_architect: 'KRY-AR-001',
      assigned_pm: 'KRY-PM-001',
      wo_value: 8500000,
      updatedOffset: '-1 day',
    },
    '-15 days',
  );
  insertAction.run(leadId(6), 'CREATED', 'KRY-AD-001', 'KRY-AD-001', 'Administration', 'High-value reference lead received', null, 'New', '-15 days');
  insertAction.run(leadId(6), 'ROUTED_TO_DEPT', 'KRY-AD-001', 'KRY-SM-001', 'Sales', 'Admin routed to Sales Manager for quotation and negotiation', 'Response Received', 'Routed to Sales', '-10 days');
  insertAction.run(leadId(6), 'STAGE_CHANGE', 'KRY-SM-001', 'KRY-AD-001', 'Administration', 'Quotation approved by client', 'Quotation Stage', 'Approved', '-3 days');
  insertAction.run(leadId(6), 'WORK_ORDER', 'KRY-AD-001', 'KRY-PM-001', 'Projects', 'Work order finalized at ₹85,00,000. Project created and handed off to Project Execution.', 'Approved', 'Work Order Finalized', '-1 day');

  db.prepare(
    `INSERT INTO quotations
      (id, lead_id, version, amount, tax_amount, terms, payment_milestones, status, created_by, approved_by, sent_at, created_at)
     VALUES (?, ?, 1, ?, 0, ?, ?, 'Approved', 'KRY-SM-001', 'KRY-AD-001', datetime('now', '-5 days'), datetime('now', '-5 days'))`,
  ).run(
    quoteId(1),
    leadId(6),
    8500000,
    '30% advance, 40% on structure, 20% on finishing, 10% on handover.',
    'Stage 1: Advance, Stage 2: Rough-in, Stage 3: Millwork, Stage 4: Handover',
  );

  db.prepare(
    `INSERT INTO work_orders
      (id, lead_id, quotation_id, amount, customer_approval_date, details, status, created_by, approved_by, approved_at, created_at)
     VALUES (?, ?, ?, ?, date('now', '-2 days'), ?, 'Finalized', 'KRY-SM-001', 'KRY-AD-001', datetime('now', '-1 day'), datetime('now', '-1 day'))`,
  ).run(
    woId(1),
    leadId(6),
    quoteId(1),
    8500000,
    'Turnkey showroom execution as per approved 3D drawings and BOQ.',
  );

  db.prepare(
    `INSERT INTO projects
      (id, work_order_id, lead_id, project_manager, site_engineer, status, milestones, progress,
       start_date, target_completion, handoff_by, handoff_at, created_at)
     VALUES (?, ?, ?, 'KRY-PM-001', 'KRY-SE-001', 'In Progress', ?, 18,
       date('now'), date('now', '+60 days'), 'KRY-AD-001', datetime('now', '-1 day'), datetime('now', '-1 day'))`,
  ).run(
    projId(1),
    woId(1),
    leadId(6),
    'Demolition and civil, Electrical, MEP, Flooring, Glass glazing, Interior joinery',
  );

  const insertMilestone = db.prepare(
    `INSERT INTO project_milestones
      (project_id, title, order_index, weightage_percent, target_date, status)
     VALUES (?, ?, ?, ?, date('now', ?), ?)`,
  );
  const milestones = [
    ['Site mobilization', 10, '+5 days', 'Completed'],
    ['Demolition and civil works', 20, '+15 days', 'In Progress'],
    ['Electrical and MEP rough-in', 20, '+30 days', 'Pending'],
    ['Flooring and ceiling', 20, '+45 days', 'Pending'],
    ['Interior joinery and glazing', 20, '+55 days', 'Pending'],
    ['Handover and snag closure', 10, '+60 days', 'Pending'],
  ];
  milestones.forEach(([title, weight, offset, status], index) => {
    insertMilestone.run(projId(1), title, index + 1, weight, offset, status);
  });

  const insertNotification = db.prepare(
    `INSERT INTO notifications (employee_id, type, message, link, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
  );
  insertNotification.run('KRY-AD-001', 'GENERAL', 'Welcome to the Kryston CRM central desk.', '#overview', 'system', 'welcome', '-1 day');
  insertNotification.run('KRY-AD-001', 'UPDATE_SUBMITTED', `Telecaller submitted a response for ${leadId(3)} (Vikram Malhotra).`, '#taskboard', 'lead', leadId(3), '-1 day');
  insertNotification.run('KRY-TC-001', 'TASK_ASSIGNED', `New lead ${leadId(2)} assigned for calling.`, '#telecaller', 'lead', leadId(2), '-2 days');
  insertNotification.run('KRY-SE-001', 'TASK_ASSIGNED', `Task ${taskId(2)}: site visit assigned for Ananya Gupta.`, '#tasks', 'task', taskId(2), '-1 day');
  insertNotification.run('KRY-PM-001', 'WO_FINALIZED', `Project ${projId(1)} handed off for execution.`, '#projects', 'project', projId(1), '-1 day');
}

module.exports = { seedDemo };
