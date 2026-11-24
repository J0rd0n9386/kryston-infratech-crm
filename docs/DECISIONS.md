# Kryston CRM v2.4.0 Architectural Decisions & Mapping Document

## Phase 0: Codebase Analysis and Decisions Record

This document records the architectural findings, domain entity mappings, analysis of existing queries, and design decisions for implementing Kryston CRM v2.4.0.

---

### 1. Mapping Table: Brief Names vs. Real Implementation

| Item / Brief Name | Real Existing Name / New Implementation | Scope / Location | Notes |
| :--- | :--- | :--- | :--- |
| **tasks** | `tasks` | Table (`migrations/001_enterprise_schema.sql`) | Add columns: `contact_status`, `requires_contact`, `first_contacted_at`, `last_contact_at`, `contact_attempts`, `last_outcome`, `work_summary`, `next_action`, `next_action_date`. |
| **lead_actions** | `lead_actions` | Table (`migrations/001_enterprise_schema.sql`) | Append-only timeline ledger. Action types: `CALL_OUTCOME`, `WORK_NOTE`, `REMINDER_SET`, `AUTO_REMINDER_TRIGGERED`, `REMINDER_SNOOZED`, `REMINDER_DISMISSED`, `REMINDER_CANCELLED`. |
| **task_activity** | `task_activity` | New Table (`migrations/007_calling_queue_and_reminders.sql`) | Append-only call and work note ledger with triggers preventing UPDATE and DELETE. |
| **reminders** | `reminders` | New Table (`migrations/007_calling_queue_and_reminders.sql`) | Reminder lifecycle (`PENDING`, `TRIGGERED`, `DONE`, `SNOOZED`, `DISMISSED`, `CANCELLED`). |
| **audit** / audit log | `audit_log` | Table (`migrations/001_enterprise_schema.sql`) | Uses `audit(db, actorId, action, entityType, entityId, details, beforeState, afterState, ip)`. |
| **department** | `tasks.department` | Column | Check constraint: `'Management'`, `'Administration'`, `'Sales'`, `'Marketing'`, `'Technical'`, `'Design'`, `'Projects'`, `'Purchase'`, `'Accounts'`. |
| **System Actor** | `KRY-SYS-001` ('System') | `employees` table | Seeded as inactive (`active = 0`, role: `'ADMIN_DESK'`) to serve as `assigned_by` for automated reminders/re-engage tasks. |
| **Calls Screen** | `telecaller` / `calling-queue` | `public/js/work.js`, `public/index.html` | Redesigned into dedicated Calling Queue with non-overlapping views. |
| **My Work Screen** | `tasks` / `my-work` | `public/js/work.js`, `public/index.html` | Updated to tabs: Active, Waiting, Sent for review, Done; plus Admin All Work vs My Work. |
| **Lead Board** | `taskboard` | `public/js/work.js` | Admin desk kanban board. Augmented with Due follow-ups strip. |

---

### 2. Analysis of Current Queries Behind Calls and My Work

#### 2.1 The "Calls" Screen (`GET /api/telecaller/leads` in `src/routes/telecaller.js`)
- **Current Query**:
  ```sql
  SELECT l.*, tc.name AS telecaller_name,
         (SELECT t.id FROM tasks t
          WHERE t.lead_id = l.id AND t.task_type = 'TELECALLER_ENQUIRY'
            AND t.status IN ('Assigned','In Progress','Submitted')
          ORDER BY t.created_at DESC LIMIT 1) AS task_id,
         ...
  FROM leads l
  LEFT JOIN employees tc ON tc.id = l.assigned_telecaller
  WHERE l.deleted_at IS NULL
    AND l.stage IN ('With Telecaller', 'Response Received')
  ```
- **Root Cause of Defect #1**:
  Leads in `Response Received` (already submitted to Admin) are included in `l.stage IN ('With Telecaller', 'Response Received')`. Additionally, it queries by `leads` instead of active uncontacted tasks in `tasks`.
- **Solution**:
  The new `GET /api/queues/calling` endpoint strictly filters:
  ```sql
  WHERE t.assigned_to = :userId
    AND t.status IN ('Assigned', 'In Progress')
    AND t.contact_status = 'NOT_CONTACTED'
  ```
  Leads already contacted or submitted will never appear in Calling Queue.

#### 2.2 The "My Work" Screen (`GET /api/tasks` in `src/routes/tasks.js`)
- **Current Query**:
  ```sql
  SELECT t.*, l.customer_name, ...
  FROM tasks t
  LEFT JOIN leads l ON l.id = t.lead_id
  WHERE t.assigned_to = :userId
  ```
- **Root Cause of Defect #3**:
  It returns all tasks for the user regardless of whether contact is pending, active, or waiting. Consequently, newly assigned tasks that were never called show up simultaneously in Calls and My Work.
- **Solution**:
  Enforce strict non-overlapping view rules according to Section 4.2 of the specification:
  - Calling Queue: `assigned_to = me AND status IN ('Assigned', 'In Progress') AND contact_status = 'NOT_CONTACTED' AND (next_action_date IS NULL OR next_action_date <= today)`
  - Calling Queue (Scheduled): `assigned_to = me AND status IN ('Assigned', 'In Progress') AND contact_status = 'NOT_CONTACTED' AND next_action_date > today`
  - My Work (Active): `assigned_to = me AND status IN ('Assigned', 'In Progress') AND contact_status IN ('CONTACTED', 'NOT_REQUIRED') AND no pending reminder`
  - My Work (Waiting): `assigned_to = me AND status IN ('Assigned', 'In Progress') AND (has pending reminder OR contact_status = 'CONTACTED' with future next_action_date)`
  - My Work (Sent for review): `assigned_to = me AND status = 'Submitted'`
  - My Work (Done): `assigned_to = me AND status IN ('Reviewed', 'Closed') AND updated_at >= datetime('now', '-30 days')`

---

### 3. Decisions on Architecture and Data Model

1. **Migration 007 (`migrations/007_calling_queue_and_reminders.sql`)**:
   - Forward-only DDL with column additions, `task_activity` table, `reminders` table, triggers, and indices.
   - Seed `KRY-SYS-001` ('System', 'system@kryston.local', role: 'ADMIN_DESK', active: 0).
2. **Backfill Rules**:
   - Telecaller tasks: `contact_status = 'CONTACTED'` if a `telecaller_responses` row exists for that `(lead_id, assignee)`, otherwise `'NOT_CONTACTED'`.
   - Purchase and Accounts tasks: `requires_contact = 0`, `contact_status = 'NOT_REQUIRED'`.
   - Other departments (Sales, Technical, Design, Projects): `contact_status = 'NOT_CONTACTED'` if `status = 'Assigned'`, otherwise `'CONTACTED'`.
   - Default `contact_attempts = 0`.
3. **Immutability of Activity**:
   - SQLite triggers `task_activity_no_update` and `task_activity_no_delete` raise abort.
4. **Time Handling & Injectable Clock**:
   - `src/lib/clock.js` provides `now()`, `todayLocal()`, and testing hooks (`setFixedTime(iso)`, `reset()`).
   - Timezone defaults to `Asia/Kolkata` (IST).
5. **Reminder Lifecycle & Cron**:
   - Scheduled at `0 9 * * *` (09:00 AM IST) and sweep at `5 * * * *` (every hour).
   - Atomic idempotency check: `UPDATE reminders SET status = 'TRIGGERED', triggered_at = ? WHERE id = ? AND status = 'PENDING'`. Only proceed if changes === 1.
   - Trigger generates Admin Task (`task_type = 'RE_ENGAGE'`) assigned to current lead Admin owner or first active Admin Desk.
6. **Data Quality & UI Hardening**:
   - Phone normalizer utility: sanitizes Indian phone numbers (+91, 91, leading 0), enforcing valid 10-digit mobile `[6-9]\d{9}`.
   - Title case formatter for display names.
   - Structured budget range and timeline selector inputs.
   - Fix CSS `:focus-visible` to eliminate heavy black container outline while preserving accessible keyboard navigation.
   - Topbar sticky styling fix to prevent clipping.
   - Excel export format clarification and clean spreadsheet generation.
