# [HISTORICAL ARCHIVE] Kryston Infratech CRM — Phase 0 Codebase Audit & Gap Report

> **NOTICE**: This document is an archived historical gap report from version 2.2.0 (November 22, 2026).
> For the authoritative architecture and current decisions, refer to [docs/DECISIONS_v3.md](DECISIONS_v3.md)
> and [docs/architecture.md](architecture.md).

**Audit Date**: 2026-11-22 (Historical)  
**Target Codebase**: `kryston-infratech-crm` (v2.2.0)  
**Stack**: Express 4, better-sqlite3 (WAL mode), JWT, bcryptjs, helmet, express-rate-limit, vanilla JS SPA (`/public`), node:test  
**Author**: Antigravity Auditor  

---

## 1. Test & Health Verification Run

Before performing file-by-file verification, the repository health and test suites were executed cleanly without modifications:

### 1.1 Syntax Check (`npm run check`)
```text
> kryston-infratech-crm@2.2.0 check
> node scripts/check-syntax.js

Syntax OK: 44 JavaScript file(s).
Exit code: 0
```

### 1.2 Automated Test Suite (`npm test`)
```text
> kryston-infratech-crm@2.2.0 test
> node --test

TAP version 13
# Subtest: Admin Desk receives an Action Required queue on My Day
ok 1 - Admin Desk receives an Action Required queue on My Day
# Subtest: a Site Engineer receives their own tasks with a clear next action
ok 2 - a Site Engineer receives their own tasks with a clear next action
# Subtest: a Telecaller receives a "call the customer" action
ok 3 - a Telecaller receives a "call the customer" action
# Subtest: sidebar badges are cheap role-scoped counters
ok 4 - sidebar badges are cheap role-scoped counters
# Subtest: site inspection photos and voice notes are stored, listed and access-controlled
ok 5 - site inspection photos and voice notes are stored, listed and access-controlled
# Subtest: health endpoint is public and reports the database
ok 6 - health endpoint is public and reports the database
# Subtest: protected endpoints require a session
ok 7 - protected endpoints require a session
# Subtest: login rejects a wrong password without revealing the account
ok 8 - login rejects a wrong password without revealing the account
# Subtest: security headers enforce a strict content security policy
ok 9 - security headers enforce a strict content security policy
# Subtest: modular client is served without inline handlers
ok 10 - modular client is served without inline handlers
# Subtest: full hub-and-spoke lifecycle
ok 11 - full hub-and-spoke lifecycle
# Subtest: direct stage changes are restricted to Lost and Nurture with a reason
ok 12 - direct stage changes are restricted to Lost and Nurture with a reason
# Subtest: timeline and audit ledgers reject updates and deletes
ok 13 - timeline and audit ledgers reject updates and deletes
# Subtest: exports produce CSV and Excel-compatible downloads
ok 14 - exports produce CSV and Excel-compatible downloads
# Subtest: employee administration enforces role, password and hierarchy rules
ok 15 - employee administration enforces role, password and hierarchy rules
1..15
# tests 15
# suites 0
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1579.4384
Exit code: 0
```

All 15 test suites pass cleanly with zero regressions.

---

## 2. Feature-by-Feature Verification (11 Core Capabilities)

| # | Capability Group | Status | Primary Files & Evidence |
|---|-------------------|--------|--------------------------|
| 1 | Lead Intake | **PARTIAL** | [src/routes/leads.js:182-266](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L182-L266), [src/lib/id-generator.js:21-39](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/lib/id-generator.js#L21-L39), [src/middleware/validate.js:40-46](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/middleware/validate.js#L40-L46) |
| 2 | Task Board Columns | **PARTIAL** | [src/routes/taskboard.js:11-39](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/taskboard.js#L11-L39), [public/js/pages.js:611-665](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/pages.js#L611-L665) |
| 3 | Telecaller Form | **DONE** | [src/routes/telecaller.js:104-205](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/telecaller.js#L104-L205), [public/js/work.js:235-310](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/work.js#L235-L310) |
| 4 | Department Update Form | **DONE** | [src/routes/tasks.js:171-268](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/tasks.js#L171-L268), [src/routes/dept-updates.js:25-130](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dept-updates.js#L25-L130), [src/routes/dept-updates.js:162-259](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dept-updates.js#L162-L259) |
| 5 | Immutable Timeline & Audit Log | **DONE** | [src/db/schema.js:500-511](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L500-L511), [src/db/schema.js:566-577](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L566-L577), [src/lib/audit-notify.js:19-49](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/lib/audit-notify.js#L19-L49) |
| 6 | Work Order (WO) Flow | **DONE** | [src/routes/workorders.js:133-375](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/workorders.js#L133-L375), [src/routes/projects.js:156-279](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/projects.js#L156-L279), [src/routes/projects.js:286-378](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/projects.js#L286-L378) |
| 7 | Notifications | **PARTIAL** | [src/routes/notifications.js:11-58](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/notifications.js#L11-L58), [src/lib/audit-notify.js:51-85](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/lib/audit-notify.js#L51-L85), [docs/architecture.md:175-178](file:///f:/Kryston_Infratech_Complete_CRM_v2/docs/architecture.md#L175-L178) |
| 8 | Dashboards | **PARTIAL** | [src/routes/dashboard.js:98-202](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dashboard.js#L98-L202), [src/routes/dashboard.js:204-265](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dashboard.js#L204-L265), [public/js/pages.js:47-150](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/pages.js#L47-L150) |
| 9 | Reports | **PARTIAL** | [src/routes/export.js:15-169](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/export.js#L15-L169), [src/routes/export.js:216-244](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/export.js#L216-L244) |
| 10 | Security | **PARTIAL** | [src/config.js:52-89](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/config.js#L52-L89), [src/app.js:77-124](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/app.js#L77-L124), [src/routes/auth.js:26-61](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/auth.js#L26-L61), [public/js/core.js:93](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/core.js#L93) |
| 11 | Ops & Infrastructure | **PARTIAL** | [src/backup.js:23-50](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/backup.js#L23-L50), [src/app.js:126-140](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/app.js#L126-L140), [src/db/schema.js:572-576](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L572-L576) |

---

### Detailed Verification Findings

#### 2.1 Lead Intake — `PARTIAL`
- **Multi-source & Channel**: In [src/routes/leads.js:193](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L193), `channel` is strictly validated as `['Online', 'Offline']`. In [src/routes/leads.js:212](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L212), `source` is accepted as free-form sanitized text (up to 80 chars). There is no controlled source enum or dedicated marketing channel mapping table.
- **ID Format**: In [src/lib/id-generator.js:21-39](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/lib/id-generator.js#L21-L39) and [src/routes/leads.js:210](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L210), IDs are strictly generated using `MAX(suffix) + 1` formatted as `KRY-LEAD-YYYY-NNNN`.
- **Phone Deduplication Gap**: In [src/middleware/validate.js:40-42](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/middleware/validate.js#L40-L42), `normalizePhone` only executes `replace(/\D/g, '')`. It does not normalize country code prefixes (e.g. `+91`) or leading trunk zeros (`0`). Consequently, `9876543210` (10 digits), `+919876543210` (12 digits `91...`), and `09876543210` (11 digits `0...`) are stored as distinct strings, completely bypassing deduplication checks in [src/routes/leads.js:201](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L201) and the SQLite partial unique index in [src/db/schema.js:622](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L622).

#### 2.2 Task Board Columns & Interaction — `PARTIAL`
- **Column Definitions**: In [src/routes/taskboard.js:11-19](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/taskboard.js#L11-L19), the 7 columns are defined as:
  1. `new` (New Leads)
  2. `telecaller` (With Telecaller)
  3. `response_received` (Response Received)
  4. `routed` (Routed to Department)
  5. `update_received` (Update Received)
  6. `review_quote` (Review / Negotiation)
  7. `finalized_closed` (Work Order / Closed)
  The requested column layout (`New > With Telecaller > Response Received > Routed to Dept > Update Received > Awaiting Admin Review > Closed`) merges quotation review and work order closure into different groupings than requested.
- **Overdue Highlight & SLA Timer**: Implemented in [public/js/pages.js:648](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/pages.js#L648) and [src/lib/sla.js:18-45](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/lib/sla.js#L18-L45) via `dueBadge()` and CSS badge classes (`badge-danger` for overdue, `badge-warning`).
- **Department Pending at a Glance**: Implemented in [public/js/pages.js:644-647](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/pages.js#L644-L647) showing department name and assigned employee on every active card.
- **One-Click Route**: Missing direct one-click routing button on card lane. Currently requires opening modal via `KRY.openLeadModal(lead.id)` in [public/js/pages.js:635](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/pages.js#L635), which introduces a multi-step modal interaction instead of a single-click lane trigger.

#### 2.3 Telecaller Form — `DONE`
- **Fields Captured**: In [src/routes/telecaller.js:150-180](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/telecaller.js#L150-L180), captures `customer_intent`, `budget_range`, `timeline`, `area`, `requirement_detail`, `objections`, `call_outcome`, `call_duration_seconds`, `next_followup`, and `notes`.
- **Returns to Admin Only**: In [src/routes/telecaller.js:182-205](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/telecaller.js#L182-L205), updates `tasks.status = 'Submitted'`, sets `leads.stage = 'Response Received'`, assigns `leads.current_owner = adminId`, triggers `notifyCentral()`, and logs to `lead_actions`. The telecaller has zero capability to route directly to Sales or another department.

#### 2.4 Department Update Form — `DONE`
- **Generic Department Submissions**: Handled in [src/routes/tasks.js:171-268](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/tasks.js#L171-L268) (`POST /api/tasks/:id/response`), capturing `findings`, `recommendation`, and `attachments`. Task status transitions to `Submitted`, and lead stage transitions strictly to `Update Received` with `current_owner = adminId`.
- **Specialized Department Submissions**:
  - Technical / Site Visits: [src/routes/dept-updates.js:25-130](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dept-updates.js#L25-L130) (`POST /api/site-visits`), capturing site conditions, measurements, customer presence, feedback, and technical report; transitions lead to `Update Received`.
  - Design / Floor Plans: [src/routes/dept-updates.js:162-259](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dept-updates.js#L162-L259) (`POST /api/designs`), capturing versioned floor plan/render submissions; transitions lead to `Update Received`.
- **Admin Review Loop**: In [src/routes/tasks.js:270-328](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/tasks.js#L270-L328) (`POST /api/tasks/:id/review`), Admin Desk enters review remarks, marks task `Reviewed`, and logs `ADMIN_REVIEW`.

#### 2.5 Immutable Timeline & Audit Log — `DONE`
- **DB-Enforced Immutability**: In [src/db/schema.js:566-577](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L566-L577), four SQLite triggers (`lead_actions_no_update`, `lead_actions_no_delete`, `audit_log_no_update`, `audit_log_no_delete`) abort any `UPDATE` or `DELETE` statement with `RAISE(ABORT, '... immutable')`. Verified by automated test in `tests/workflow.test.js:114`.
- **Structured Fields**: In [src/db/schema.js:500-511](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L500-L511), `audit_log` records `actor_id`, `action`, `entity_type`, `entity_id`, `before_state` (JSON), `after_state` (JSON), `details`, `ip_address`, and `created_at`.
- **Helper Usage**: In [src/lib/audit-notify.js:19-49](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/lib/audit-notify.js#L19-L49), `audit()` normalizes and stringifies JSON payloads safely.

#### 2.6 Work Order (WO) Flow — `DONE`
- **Sales Manager Commercial Submission**: In [src/routes/workorders.js:133-245](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/workorders.js#L133-L245) (`POST /api/work-orders`), strictly restricts submission to `SALES_MANAGER`, validates that `lead.stage === 'Approved'`, links to an approved quotation, and transitions lead to `Work Order Pending Admin Approval`.
- **Admin Approval & Dual-Role Handoff**: In [src/routes/workorders.js:247-375](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/workorders.js#L247-L375) (`POST /api/work-orders/:id/approve`), Admin Desk assigns an active `PROJECT_MANAGER` and `SITE_ENGINEER`. Transitions WO to `Finalized`, moves lead to `Work Order Finalized` then `Project Handoff`, initializes project in `Planning` status, and seeds `project_milestones`.
- **Execution & Milestones Tracking**: In [src/routes/projects.js:156-279](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/projects.js#L156-L279), PM and Site Engineer submit progress updates, blockers, and attachments. In [src/routes/projects.js:381-426](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/projects.js#L381-L426), individual milestones are updated and verified.
- **Project & Lead Closure**: In [src/routes/projects.js:340-360](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/projects.js#L340-L360), closing project via Admin Desk automatically moves lead to `Completed` then `Closed`.

#### 2.7 Notifications — `PARTIAL`
- **In-App Inbox**: Implemented in [src/routes/notifications.js:11-58](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/notifications.js#L11-L58) (`GET /api/notifications`, `GET /api/notifications/unread-count`, `PATCH /api/notifications/:id/read`), fully scoped to signed-in employee.
- **WO Approved Notification**: In [src/routes/workorders.js:357-360](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/workorders.js#L357-L360), notifies PM upon approval.
- **SLA Breach Automated Dispatch**: Missing. Overdue status is calculated on read in [src/lib/sla.js:18-45](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/lib/sla.js#L18-L45), but no background daemon or trigger sends breach notifications to Admin Desk when SLA crosses 100%.
- **Email, WhatsApp & Daily Digest**: Completely missing (explicitly documented as out of scope in Phase 1 per [docs/architecture.md:175-178](file:///f:/Kryston_Infratech_Complete_CRM_v2/docs/architecture.md#L175-L178)).

#### 2.8 Dashboards — `PARTIAL`
- **Admin Funnel, Dept Pending & SLA**: Implemented in [src/routes/dashboard.js:98-202](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dashboard.js#L98-L202) (`centralDashboard`), returning funnel stage counts, department queue counts, overdue tasks list, and compliance percentage.
- **Department Head Metrics**: Missing dedicated views. In [src/routes/dashboard.js:204-265](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/dashboard.js#L204-L265) (`spokeDashboard`), metrics are strictly scoped to tasks where `t.assigned_to = user.id`. A Sales Manager or Technical Head cannot view aggregated team performance across their subordinates without full central Admin access.
- **Super Admin Activity / Audit**: Implemented via [src/routes/audit.js:12-49](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/audit.js#L12-L49) (`GET /api/audit`).
- **Digital Marketing Source Funnel**: Missing. There is no dashboard endpoint or UI tab showing source breakdown, source conversion rates, or campaign ROAS.

#### 2.9 Reports — `PARTIAL`
- **Formats**: Supports CSV (UTF-8 BOM) and Microsoft SpreadsheetML XML (`.xls`) in [src/routes/export.js:176-209](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/export.js#L176-L209) for `leads`, `tasks`, and `timeline`.
- **Query Filtering Missing**: In [src/routes/export.js:39-75](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/export.js#L39-L75), `DATASETS.leads.rows(db)` completely ignores query parameters (`date`, `department`, `source`, `stage`). It executes an unconditional `SELECT ... WHERE l.deleted_at IS NULL ORDER BY l.created_at DESC`.
- **Dedicated Reporting UI**: Missing. Exports exist only as direct download endpoints; there is no interactive reporting grid with date range pickers and multidimensional filters.

#### 2.10 Security Architecture — `PARTIAL`
- **Password Hashing**: Implemented with bcrypt in [src/config.js:84](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/config.js#L84), [src/routes/auth.js:36,88](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/auth.js#L36), and [src/routes/employees.js:93,184](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/employees.js#L93) (12 rounds default).
- **JWT Storage Location**: Stored in client `localStorage.setItem('kryston.token')` in [public/js/core.js:1181](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/core.js#L1181). This is susceptible to token extraction if an XSS vulnerability occurs. It should be transitioned to an `HttpOnly`, `SameSite=Strict`, `Secure` cookie.
- **Login Rate Limiting**: Implemented in [src/app.js:117-124](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/app.js#L117-L124) (8 attempts / 15 minutes, skipping successful logins).
- **Session Timeout**: Implemented via JWT expiration in [src/config.js:79](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/config.js#L79) (`jwtExpiresIn: '8h'`), with server-side token revocation via `token_version` increment in [src/routes/auth.js:68](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/auth.js#L68).
- **2FA**: Missing (documented as not implemented in [docs/architecture.md:177](file:///f:/Kryston_Infratech_Complete_CRM_v2/docs/architecture.md#L177)).
- **HSTS & Secure Headers**: Helmet CSP configured in [src/app.js:78-97](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/app.js#L78-L97). HSTS is enabled in production (`maxAge: 15552000`) in [src/app.js:100](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/app.js#L100). Secure cookie flags are absent because cookies are not currently used for sessions.

#### 2.11 Operations & Infrastructure — `PARTIAL`
- **Database Backup**: Consistent online snapshot script implemented in [src/backup.js:23-50](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/backup.js#L23-L50) using `better-sqlite3.backup()` and `PRAGMA integrity_check`.
- **Backup Scheduling**: Missing. No built-in cron, Windows task runner, or background scheduler executes automated periodic backups.
- **Audit Retention & Archival**: Missing. The tables `lead_actions` and `audit_log` grow unboundedly. Because database triggers in [src/db/schema.js:566-577](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L566-L577) block `DELETE` operations, any archival or truncation job requires administrative schema modification or partition migration.
- **Health Endpoints**: Implemented in [src/app.js:126-140](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/app.js#L126-L140) (`GET /api/health`), validating database connectivity and skipped from rate-limiting. Detailed diagnostics in [src/routes/audit.js:51-59](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/audit.js#L51-L59) (`GET /api/audit/system-health`).

---

## 3. Vulnerability & Problem Hunt

### 3.1 HIGH SEVERITY

#### [H-1] Information Disclosure / RBAC Leak in `GET /api/leads/:id`
- **Location**: [src/routes/leads.js:268-380](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L268-L380) and [src/middleware/rbac.js:71-88](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/middleware/rbac.js#L71-L88)
- **Description**: In `canAccessLead()`, any employee who held any historical task on a lead (`SELECT 1 FROM tasks WHERE lead_id = ? AND assigned_to = ?`) or whose ID is in `assigned_engineer`/`assigned_architect`/`assigned_telecaller` is granted read access to the lead. When they request `GET /api/leads/:id`, the route responds with all commercial quotations ([src/routes/leads.js:306-314](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L306-L314)) and the full work order contract value ([src/routes/leads.js:316-324](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L316-L324)).
- **Impact**: Non-commercial field staff (Site Engineers, Architects, Telecallers) can inspect internal pricing, quotation margins, payment terms, and client commercial contracts even though [docs/architecture.md:188-192](file:///f:/Kryston_Infratech_Complete_CRM_v2/docs/architecture.md#L188-L192) explicitly mandates that commercial access be restricted to the Sales Manager and Admin Desk.

#### [H-2] JWT Storage in Client LocalStorage
- **Location**: [public/js/core.js:93,424,1181](file:///f:/Kryston_Infratech_Complete_CRM_v2/public/js/core.js#L93) and [src/routes/auth.js:54-58](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/auth.js#L54-L58)
- **Description**: Authentication tokens are returned directly in the login JSON response and written to browser `localStorage` (`kryston.token`).
- **Impact**: Any XSS vulnerability (or browser extension with page access) can immediately read the bearer token from `localStorage` and impersonate any employee or administrator. Best practice is to set an `HttpOnly`, `SameSite=Strict`, `Secure` cookie.

---

### 3.2 MEDIUM SEVERITY

#### [M-1] Race Conditions in Concurrent Admin Routing & Assignment
- **Location**: [src/routes/leads.js:498-546](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L498-L546) (`/api/leads/:id/route`), [src/routes/leads.js:408-450](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L408-L450) (`/api/leads/:id/assign-telecaller`), and [src/routes/workorders.js:247-285](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/workorders.js#L247-L285) (`/api/work-orders/:id/approve`)
- **Description**: The state preconditions (e.g., `lead.stage`, `activeTaskCount`) are checked **outside** the SQLite transaction. The subsequent `UPDATE leads SET stage = ? WHERE id = ?` does not verify that the stage remains unchanged (`WHERE id = ? AND stage = ?`).
- **Impact**: If two Admin Desk operators simultaneously view and route the same lead (e.g. Operator A routes to Sales, Operator B routes to Technical), both requests pass validation, resulting in two concurrent department tasks and an overwritten stage without concurrency conflict notification.

#### [M-2] Phone Deduplication Bypass (+91, Trunk Zero, Spacing)
- **Location**: [src/middleware/validate.js:40-46](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/middleware/validate.js#L40-L46) and [src/routes/leads.js:189-208](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L189-L208)
- **Description**: `normalizePhone` executes `replace(/\D/g, '')`. It does not normalize leading Indian country codes (`91`) or leading trunk zeros (`0`).
- **Impact**: Entering `+91 98765 43210` stores `919876543210` (12 digits), while entering `9876543210` stores `9876543210` (10 digits). The `WHERE phone = ?` query and the unique database index treat these as distinct numbers, allowing duplicate leads for the same customer.

#### [M-3] Correlated Subquery N+1 in Telecaller Queue
- **Location**: [src/routes/telecaller.js:50-68](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/telecaller.js#L50-L68)
- **Description**: The telecaller query runs 6 correlated subqueries per row (`task_created_at`, `task_sla_hours`, `previous_response_id`, `customer_intent`, `call_outcome`, `last_notes`) over a `LIMIT 500` result set.
- **Impact**: Up to 3,000 subqueries are executed on every telecaller queue load, creating unnecessary database locks and slowing queue rendering as lead history expands.

#### [M-4] Unindexed Foreign Key Evaluation in Lead Access Filtering
- **Location**: [src/routes/leads.js:154](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L154) and [src/db/schema.js:534-540](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L534-L540)
- **Description**: Non-central lead listing evaluates `EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.assigned_to = ?)`.
- **Impact**: While indexes exist on `tasks(lead_id, status)` and `tasks(assigned_to, status)`, there is no composite index on `(lead_id, assigned_to)`. As the `tasks` table grows into tens of thousands of rows, evaluating this subquery per lead degrades query performance.

---

### 3.3 LOW SEVERITY

#### [L-1] Missing Format Validation on Task Due Date
- **Location**: [src/routes/leads.js:533,561-574](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/leads.js#L533)
- **Description**: In `/api/leads/:id/route`, `const dueDate = req.body.due_date || null;` is passed directly into SQLite without validating it against `isIsoDate()`.
- **Impact**: Malformed date strings can be saved into `tasks.due_date`, leading to invalid date calculations or display glitches in the UI.

#### [L-2] Customer Phone Number Printed to Server Logs on Schema Duplication Notice
- **Location**: [src/db/schema.js:619](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/db/schema.js#L619)
- **Description**: `console.warn('[schema] duplicate phone ' + duplicates.phone + ' found; unique index not created.');`
- **Impact**: Customer PII (phone number) is logged to `stdout` during server startup if legacy duplicates exist.

#### [L-3] Sign-in Attempt Logging in Audit Details
- **Location**: [src/routes/auth.js:43](file:///f:/Kryston_Infratech_Complete_CRM_v2/src/routes/auth.js#L43)
- **Description**: Failed login attempts record the raw input email in `audit_log.details` (`Failed sign-in attempt for ${email}`).
- **Impact**: If a user accidentally enters their password into the username/email input field, the password is permanently written to the immutable `audit_log` table.

---

## 4. Recommended Fix Order & Implementation Roadmap

To maintain the architectural integrity of Kryston Infratech CRM without regressing existing tests or breaking hub-and-spoke guarantees, fixes should be executed in four disciplined phases:

```
[Phase 1: Security & Concurrency] ──► [Phase 2: Data Integrity & Dedupe] ──► [Phase 3: Pipeline & UI Alignment] ──► [Phase 4: Operations & Notifications]
```

### Phase 1: Security & Concurrency Hardening (P0 — Immediate)
1. **Scope Down `GET /api/leads/:id` Payload**:
   - Redact `quotations`, `workOrder`, and contract values when the requesting user is a spoke (Site Engineer, Architect, Telecaller, Purchase, Accounts).
   - Only return full commercial details to `ADMIN_DESK`, `SUPER_ADMIN`, and `SALES_MANAGER` (or the specific Sales employee owning quotation preparation).
2. **Optimistic Concurrency & Stage Locking**:
   - Update `UPDATE leads SET ... WHERE id = ? AND stage = ?` in routing and assignment endpoints.
   - If zero rows were updated due to a concurrent stage change, throw `ConflictError('This lead was updated by another administrator. Please refresh.')`.
3. **Session Cookie Migration**:
   - Issue JWT in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie alongside the JSON body for backwards compatibility.
   - Update client `api()` helper to rely on cookies while phasing out raw `localStorage` bearer token usage.

### Phase 2: Data Normalization & Query Optimization (P1)
1. **Canonical Phone Normalization**:
   - Enhance `normalizePhone(phone)` in `src/middleware/validate.js` to strip leading `+91` or `0` for 10-digit Indian numbers, standardizing to a canonical 10-digit string before uniqueness checks.
2. **Add Missing Indexes**:
   - Add `CREATE INDEX IF NOT EXISTS idx_tasks_lead_assignee ON tasks(lead_id, assigned_to);` in `src/db/schema.js`.
3. **Optimize Telecaller Queue Query**:
   - Replace the 6 correlated subqueries in `src/routes/telecaller.js` with LEFT JOINs against latest task and response aggregations.
4. **Sanitize Date & PII Logs**:
   - Add `isIsoDate` validation for `due_date` in `/api/leads/:id/route`.
   - Mask phone numbers in startup notices (`src/db/schema.js:619`) and sanitize email strings in failed login audit logs.

### Phase 3: Workflow & UI Alignment (P2)
1. **Task Board Columns Refinement**:
   - Update column definitions in `src/routes/taskboard.js` and `public/js/pages.js` to match the exact 7-stage specification: `New > With Telecaller > Response Received > Routed to Dept > Update Received > Awaiting Admin Review > Closed`.
2. **One-Click Route Quick Action**:
   - Provide direct quick-action buttons on card lanes in the Admin Task Board to initiate routing wizards directly without nested modal navigation.
3. **Department Head Dashboard Scope**:
   - Allow designated department leads (e.g. `SALES_MANAGER`) to view aggregated metrics for all staff in their department while preserving the spoke boundary for individual contributors.
4. **Export Filtering**:
   - Wire query parameters (`startDate`, `endDate`, `department`, `source`, `stage`) into `src/routes/export.js` so exports respect user filters instead of dumping all records.

### Phase 4: Operations & Notifications (P3)
1. **Automated Scheduled Backups**:
   - Implement an in-process timer (or external cron/scheduled task script) that executes `src/backup.js` daily with automated 30-day retention pruning.
2. **SLA Breach In-App Alerts**:
   - Implement an automated check that creates an in-app notification for Admin Desk when an active task crosses its SLA deadline.
3. **Audit Ledger Archival Policy**:
   - Document or script a partition/archival mechanism for older audit logs that complies with SQLite trigger constraints.

---
*Report generated strictly under Phase 0 guidelines. Source code was untouched during this audit.*
