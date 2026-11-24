# Kryston Infratech CRM v3.0 Master Architecture & Decisions Record (DECISIONS_v3)

**Document Version**: 3.0.0-draft  
**Codebase Baseline**: Kryston Infratech CRM v2.4.1  
**Target**: Industry-Grade Product (Phases P0 to P8)  
**Date**: November 2026  
**Auditor & Architect**: Principal Systems Architect  

---

## 1. Executive Summary & Architecture Invariants

Kryston Infratech CRM is an enterprise-grade operations platform for a construction, interior, and architecture firm (11–50 employees, Patna). It is built on a strict **Hub-and-Spoke** architecture where **Admin Desk** serves as the central orchestrator.

### 1.1 Core Non-Negotiable Invariants
1. **Sacred Hub-and-Spoke**: Admin Desk is the sole orchestrator. Spokes (Telecaller, Sales/BDM, Site Engineer, Architect, Purchase, Accounts, Project Manager) receive assignments solely through an Admin-assigned task and submit results strictly back to Admin Desk. Spokes never route work directly to one another.
2. **Forward-Only Numbered SQL Migrations**: The next migration is `009_*.sql`. Applied migrations are immutable. Every migration must execute cleanly on a brand new empty database and idempotently on populated production copies with verified backfills.
3. **Append-Only Immutable Ledgers**: `lead_actions`, `audit_log`, and `task_activity` are protected against `UPDATE` and `DELETE` via SQLite triggers. Any new ledger-style entity (such as `payments`, `change_orders`, `approval_actions`) must have identical triggers.
4. **Zero Float Financial Precision**: All monetary values (budgets, quotations, work orders, invoices, payments, change order deltas) are stored as **integer paise** (1 INR = 100 paise). All totals, taxes, and subtotals are computed deterministically on the server.
5. **No Silent Customer Messages**: No email, SMS, or WhatsApp is dispatched automatically to a client. Customer-facing notifications are generated as drafts that require Admin Desk review and explicit sign-off.
6. **Time & Timezone Invariant**: All database timestamps (`created_at`, `updated_at`, `applied_at`) are stored in UTC ISO-8601 (`datetime('now')` / `.toISOString()`). All date-only calculations and scheduling sweeps occur in `Asia/Kolkata` (IST) using `src/lib/clock.js`. Test suites must never depend on the runner's host timezone (`TZ=UTC`, `TZ=Asia/Kolkata`, or `TZ=America/New_York`).
7. **Strict Security Posture**: Enforced Content Security Policy (no inline scripts/styles), HttpOnly + SameSite=Strict session cookies, CSRF protection, optimistic concurrency locking via sequential `version` increments, and comprehensive Role-Based Access Control (RBAC) on every endpoint.

---

## 2. Current State Machine & Workflow Specification

### 2.1 Lead Stages (24 States)
```text
New
  ├── With Telecaller
  │     └── Response Received
  │           ├── Routed to Sales ──────────────┐
  │           ├── Routed to Engineering ────────┤
  │           ├── Routed to Design ─────────────┤
  │           ├── Routed to Purchase ───────────┼─► Update Received
  │           ├── Routed to Accounts ───────────┤        │
  │           ├── Site Visit Scheduled ─────────┤        │
  │           └── Follow-up Required ───────────┘        │
  │                                                      │
  ◄──────────────────────────────────────────────────────┘
  │ (Admin reviews Update Received -> routes next dept or advances)
  ▼
Quotation Stage
  └── Quotation Sent
        └── Negotiation
              └── Approved
                    └── Work Order Pending Admin Approval
                          └── Work Order Finalized
                                └── Project Handoff
                                      └── In Progress
                                            └── Completed
                                                  └── Closed

Terminal / Parallel Exception Stages:
  ├── Lost (Requires mandatory reason; terminal)
  └── Nurture (Auto re-engagement reminder scheduled; can return to With Telecaller)
```

### 2.2 Transition Rules and Authorized Actors
| Current Stage | Allowed Next Stages | Authorized Role(s) |
|---|---|---|
| `New` | `With Telecaller`, `Lost`, `Nurture` | `ADMIN_DESK`, `SUPER_ADMIN` |
| `With Telecaller` | `Response Received` | Assigned `TELECALLER`, `ADMIN_DESK`, `SUPER_ADMIN` |
| `Response Received` | `Routed to Sales / Engineering / Design / Purchase / Accounts`, `Site Visit Scheduled`, `Follow-up Required`, `Lost`, `Nurture` | `ADMIN_DESK`, `SUPER_ADMIN` |
| `Routed to <Dept>` | `Update Received`, `Follow-up Required` | Assigned Spoke for `Update Received`; Central for `Follow-up Required` |
| `Update Received` | `Routed to <Dept>`, `Quotation Stage`, `Follow-up Required`, `Lost`, `Nurture` | `ADMIN_DESK`, `SUPER_ADMIN` |
| `Quotation Stage` | `Quotation Sent`, `Negotiation`, `Lost` | Assigned Sales, `SALES_MANAGER`, Central |
| `Quotation Sent` | `Negotiation`, `Approved`, `Lost` | `SALES_MANAGER`, Central |
| `Negotiation` | `Approved`, `Quotation Stage`, `Lost` | `SALES_MANAGER`, Central |
| `Approved` | `Work Order Pending Admin Approval` | `SALES_MANAGER` only |
| `Work Order Pending Admin Approval` | `Work Order Finalized`, `Lost` | `ADMIN_DESK`, `SUPER_ADMIN` |
| `Work Order Finalized` | `Project Handoff` | `ADMIN_DESK`, `SUPER_ADMIN` |
| `Project Handoff` | `In Progress` | Assigned `PROJECT_MANAGER`, Central |
| `In Progress` | `Completed` | Assigned `PROJECT_MANAGER`, Central |
| `Completed` | `Closed` | `ADMIN_DESK`, `SUPER_ADMIN` |
| `Follow-up Required` | `With Telecaller`, `Routed to <Dept>`, `Lost`, `Nurture` | `ADMIN_DESK`, `SUPER_ADMIN` |
| `Nurture` | `With Telecaller` | `ADMIN_DESK`, `SUPER_ADMIN` |

---

## 3. Verified Gap Analysis (Section 1 Audit)

Every row of the Master Prompt Section 1 table was audited directly against the live v2.4.1 codebase with concrete evidence:

| Master Prompt Item | Status | Verified Evidence in Codebase |
|---|---|---|
| **4 tests fail under `TZ=UTC`** | **CONFIRMED** | Running `TZ=UTC node --test` yields **62 pass, 4 fail** in `tests/calling-queue.test.js` (Criteria 5, 6, 7, 14). Root cause: `src/lib/services/reminder-service.js:272` evaluates `currentHour = checkDate.getHours()`, which uses host local time instead of IST. When runner is UTC, 09:00 IST (03:30 UTC) returns hour `3`, failing the `>= 9` check. Criterion 14 also invokes `clock.now().getHours()`. Under `TZ=Asia/Kolkata`, all 66 pass. |
| **`scripts/make-zip.js` packs `data/` and `backups/`** | **CONFIRMED** | `scripts/make-zip.js:21` has `excludeTop = new Set(['node_modules', 'staging_zip', ...])` which omits `data` and `backups`. Line 37 copies all unexcluded directories recursively, packing `data/kryston.db` (demo DB today, risk of PII leak in prod). Also, `zipName` is hardcoded as `'Kryston_Infratech_v2.4.1.zip'`. |
| **No CI, no Dockerfile, no ESLint/Prettier, 27 raw console.* calls, no OpenAPI, no coverage script** | **CONFIRMED** | Verified: `.github/` does not exist; `Dockerfile` and `docker-compose.yml` do not exist; `.eslintrc` / `prettier` configs do not exist; `docs/openapi.yaml` does not exist; `package.json` lacks `coverage` script; AST/regex walk on `src/` counts exactly **27 raw `console.*` calls** (e.g. `src/lib/notifications/dispatcher.js:55`, `src/backup.js:29`, `src/server.js:45`). |
| **No `rework_count` / loop cap; no negotiation round cap** | **CONFIRMED** | In `src/routes/tasks.js:731` (`POST /api/tasks/:id/rework`), rework resets status to `In Progress` and updates lead stage, but `tasks` table has no `rework_count` column. An Admin can loop a task indefinitely. In `src/routes/quotations.js`, version increments but there is no negotiation round cap or auto-escalation trigger. |
| **No `invoices`, `payments`, structured milestones (only free text), no advance gate** | **CONFIRMED** | `quotations.payment_milestones` is a single free-text column (`z.string().trim().max(8000)`). No `invoices` or `payments` tables exist in migrations 001–008. In `src/routes/workorders.js:378`, Admin finalizes WO and can execute handoff to PM immediately without verifying any advance payment. |
| **No approval-matrix table, no delegation / deputy admin, no auto-routing rules** | **CONFIRMED** | Quotation discount approvals in `src/routes/quotations.js:176` use a static threshold from `config.discountApprovalThresholdPercent` (10%). No `approval_rules` table exists. No `delegations` table or auto-expiry mechanism exists. Lead intake always defaults to manual Admin assignment. |
| **No site-visit scheduling, BOQ table, change orders, handover/snag list, customer-update generator, procurement flow** | **CONFIRMED** | `site_visits` exists only as a single post-hoc technical inspection record; no future visit scheduling table. BOQ is not table-modeled. No `change_orders` table exists. No `snag_items` table exists. No customer progress generator exists. Procurement tasks have no structured vendor quotes or PO tables. |
| **`docs/gap-report.md` is stale (v2.2.0)** | **CONFIRMED** | `docs/gap-report.md` describes v2.2.0 (44 files, dated 2026-11-22). The current codebase has 78 JS files and already resolved numerous items listed in that document. |

---

## 4. Adapted Phase Plan (P1 to P8)

Following the Working Protocol, implementation proceeds **one phase at a time**. After each phase, development stops to deliver a verification report and await explicit approval.

### Phase P1: Hygiene, Resilience & Developer Trust
- **Goal**: Make codebase robust, standardized, containerized, CI-tested, timezone-independent, and leak-proof.
- **Components**:
  1. **TZ Invariance**:
     - Update `src/lib/clock.js` with `clock.hourLocal()` using `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'`.
     - Update `src/lib/services/reminder-service.js` to evaluate `clock.hourLocal(checkDate) >= 9`.
     - Fix `tests/calling-queue.test.js` Criteria 5, 6, 7, and 14 to use `clock.hourLocal()`. Verify test suite passes under `TZ=UTC`, `TZ=Asia/Kolkata`, and `TZ=America/New_York`.
  2. **Safe Release Packaging**:
     - Edit `scripts/make-zip.js`: derive zip name dynamically from `package.json` (`Kryston_Infratech_v${version}.zip`); add `data`, `backups`, `*.db*`, `.env`, and `data/attachments` to `excludeTop`.
     - Add post-archive verification verifying no sensitive files exist in the zip.
  3. **First-Login Password Change & 2FA Enforcement**:
     - Migration `009_auth_hardening.sql`: Add `must_change_password INTEGER NOT NULL DEFAULT 0` to `employees`.
     - Update `auth.js` login flow to return `must_change_password: true` and block access until password update.
     - Enforce TOTP 2FA for `SUPER_ADMIN` and `ADMIN_DESK` (controlled by `config.enforceCentral2fa`, default true in prod).
  4. **Linting & Code Formatting**:
     - Add `eslint.config.js` (Flat Config) + `.prettierrc` matching project formatting conventions.
     - Add `npm run lint` and `npm run format:check` scripts. Fix any latent syntax/type issues.
  5. **CI Automation**:
     - Create `.github/workflows/ci.yml`: runs on push/PR with Node 20 & Node 22 matrix, running `npm run check`, `npm run lint`, and `npm test` under both `TZ=UTC` and `TZ=Asia/Kolkata`, plus `npm audit --omit=dev`.
  6. **Containerization**:
     - Provide production-ready `Dockerfile` (`node:20-slim`, non-root user `node`, healthcheck `/api/health`) and `docker-compose.yml` with persistent named volumes for `data/` and `backups/`.
  7. **Structured Logging**:
     - Replace 27 raw `console.*` calls with `pino` structured logger with request-ID correlation and automated redaction of sensitive fields (`password`, `authorization`, `cookie`, `phone`, `email`).
  8. **Coverage & Docs**:
     - Add `npm run coverage` using Node's built-in test runner coverage (`node --test --experimental-test-coverage`).
     - Mark `docs/gap-report.md` as historical.

### Phase P2: Workflow Engine, Rework Governance & Approvals
- **Goal**: Deterministic orchestration with loop limits, approval matrix, auto-routing, and stage-gate validation.
- **Components**:
  1. **Rework Loop Cap (Max 2)**:
     - Migration `010_workflow_engine.sql`: Add `rework_count INTEGER NOT NULL DEFAULT 0` to `tasks`.
     - In `POST /api/tasks/:id/rework`: Increment `rework_count`. If `rework_count > 2`, block normal spoke reassignment and auto-escalate task to `SUPER_ADMIN` with priority `'Urgent'`.
  2. **Negotiation Loop Cap (Max 2)**:
     - Track Sales<->Admin quotation negotiation rounds on the lead. Cap at 2 rounds before triggering mandatory Super Admin escalation. Display negotiation round count in the UI.
  3. **Dynamic Approval Matrix**:
     - Create table `approval_rules` (id, entity_type, rule_name, metric, min_value, max_value, approver_role, active, version).
     - Seed approval rules: Discount <= 5% -> `SALES_MANAGER`; 5.01%–10% -> `SENIOR_BDM`; > 10% -> `SUPER_ADMIN`.
     - Extract discount approval logic to `src/lib/services/approval-service.js`.
  4. **Delegation / Deputy Admin**:
     - Create table `delegations` (id, granter_id, delegate_id, role, start_at, end_at, active).
     - Middleware checks active delegation for `ADMIN_DESK` authority. Automatically expire delegations via scheduled job.
  5. **Auto-Routing Engine**:
     - Create table `routing_rules` (source, channel, rule_type, target_dept, target_role, active).
     - Implement round-robin assignment for Telecallers on intake from digital sources (Meta Ads, Google). Admin Desk retains override control.
  6. **Lost Reason & Auto-Nurture Schedule**:
     - Add structured `lost_reason` enum (`Price`, `Competitor`, `Timeline`, `Unresponsive`, `OutOfArea`, `Other`) and required notes.
     - Moving lead to `Nurture` schedules an automatic re-engage reminder via `reminderService`.
  7. **Strict Stage-Gates in State Machine**:
     - Validate mandatory prerequisites before allowing stage advancement (e.g. valid phone, visit checklist, approved quotation). Emit structured error messages listing missing criteria.
  8. **Configurable SLA Policies**:
     - Create table `sla_policies` (stage, target_hours, warning_hours, active). Render dynamic Green / Yellow / Red SLA badges.

### Phase P3: Site Visit Scheduling, BOQ Engine & Versioned Proposals
- **Goal**: Complete pre-sales delivery from field inspection to precise bill-of-quantities and client proposals.
- **Components**:
  1. **Structured Site Visit Scheduling**:
     - Create table `site_visits_schedule` (id, lead_id, engineer_id, scheduled_at, status, reschedule_reason, completed_at).
     - Calendar & agenda UI with checklist, photo upload, and voice note integration.
     - Scheduled evening-before reminder to Site Engineer.
  2. **Structured BOQ (Bill of Quantities)**:
     - Create table `boq_items` (id, quotation_id, version, category, description, unit, quantity, rate_paise, amount_paise).
     - Category subtotals, server-computed GST, margin calculation.
     - CSV import/export for BOQ line items.
  3. **Versioned PDF Quotation Generator**:
     - Branded PDF generation using `pdfkit` showing scope, itemized BOQ summary, payment terms, and validity.
     - Once sent to client, the quotation version is locked and immutable. Revisions increment version number.

### Phase P4: Contracts, Invoicing & Payment Governance
- **Goal**: Financial integrity, advance milestone gate, and automated accounts receivable.
- **Components**:
  1. **Structured Milestones & Work Order Contracts**:
     - Create table `payment_milestones` (id, work_order_id, milestone_name, percentage, amount_paise, trigger_condition, status).
     - Validation: milestone percentages must sum exactly to 100%.
  2. **Advance Payment Gate**:
     - Work Order finalization creates Advance Invoice (`KRY-INV-YYYY-NNNN`).
     - **Hard Gate**: Project handoff to Project Manager is strictly BLOCKED until the advance invoice status is `'PAID'`. Super Admin override permitted only with written audit reason.
  3. **Invoicing & Ledger**:
     - Create tables `invoices` and `payments` with append-only ledger triggers.
     - Support partial payments, credit adjustments via reversing entries, and aging reports (0–30, 31–60, 60+ days).
  4. **Accounts Financial UI**:
     - Dedicated Invoices, Receivables, and Collections screens with PDF invoice download.
     - Customer payment reminder drafts generated for Admin preview.

### Phase P5: Project Execution, Customer Progress & Procurement
- **Goal**: Field site tracking, automated transparent client reporting, and material procurement.
- **Components**:
  1. **Daily / Weekly Progress Reports**:
     - Structured submissions by PM & Site Engineer: % milestone progress, work completed, upcoming milestones, blockers, photo evidence.
     - Admin Desk review loop with P2 Rework Cap (max 2).
  2. **Branded Customer Update Generator**:
     - On progress report approval, system drafts customer update (PDF summary + WhatsApp/Email template).
     - Admin Desk previews, edits if needed, and approves dispatch. Dispatches recorded on lead timeline.
  3. **Change Orders**:
     - Create table `change_orders` (id, project_id, description, cost_delta_paise, schedule_delta_days, status, customer_approval_ref).
     - Customer-approved change orders adjust total work order value without overwriting original contract.
  4. **Procurement Workflow**:
     - Create tables `purchase_requests` and `purchase_orders`.
     - Site Engineer / PM requests material -> Admin approves via matrix -> Purchase Officer collects quotes -> PO issued -> Accounts disburses payment on delivery receipt.

### Phase P6: Handover, Snagging & After-Sales
- **Goal**: Flawless completion, defect liability tracking, warranty, and referral generation.
- **Components**:
  1. **Digital Handover Checklist & Snag List**:
     - Create table `snag_items` (id, project_id, location, description, photo_url, assigned_to, status, verified_by).
     - Project cannot transition to `Completed` with unresolved snag items or outstanding invoice balance (Super Admin override permitted with written reason).
  2. **Warranty & Defect Liability Tracker**:
     - Track structural and interior warranty periods from handover date.
  3. **Post-Handover Referral & Review Pipeline**:
     - Scheduled draft for review and referral request at Handover + 14 days for Admin preview and dispatch.

### Phase P7: Role-Specific UX Hardening & Mobile Optimization
- **Goal**: Zero cognitive overload, lightning-fast field execution, and bilingual inclusivity.
- **Components**:
  1. **Role-Tailored "My Day" Dashboards**:
     - High-signal task priority cards sorted by SLA urgency with exactly one primary next action.
  2. **Field Mobile Usability**:
     - Large touch targets, offline photo/voice capture with client-side retry queue (using local storage drafts, no token storage).
  3. **Data Integrity & Standardized Inputs**:
     - Enforce structured dropdown enums for budget, requirements, units, and call outcomes; eliminate free-form noise.
  4. **Admin Message Template Manager**:
     - Admin-editable templates for client updates with variable interpolation and XSS-safe escaping.
  5. **Bilingual Completeness**:
     - Comprehensive English + Hindi/Hinglish keys in `i18n.js` for every new screen, modal, and alert.

### Phase P8: Enterprise Analytics, Security & DPDP Compliance
- **Goal**: Executive visibility, regulatory privacy compliance, and distributed reliability.
- **Components**:
  1. **Role-Scoped KPI Dashboards**:
     - Executive metrics: Lead conversion rate, average quote turnaround, discount variance, collection cycles, department rework rates.
  2. **Data Privacy & DPDP Act 2023 Readiness**:
     - Record customer consent and intake channel.
     - Implement compliant data erasure/anonymization routine that purges PII while preserving financial and audit ledger integrity.
  3. **Off-site Backup & Recovery Drills**:
     - Automated offsite backup hooks (S3-compatible / SFTP) with optional client-side encryption and automated test drill verification.
  4. **High Availability DB Lock**:
     - SQLite advisory lock / table lock to ensure reminder cron and notification outbox workers never conflict across instances.
  5. **OpenAPI Specification**:
     - Complete `docs/openapi.yaml` documenting all API endpoints, request schemas, and responses, backed by CI schema validation.

---

## 5. Architectural Acceptance Checklist

Before any phase is marked complete, it must satisfy:
1. `npm run check`, `npm run lint`, and `npm test` pass under `TZ=UTC` and `TZ=Asia/Kolkata`.
2. New migrations apply cleanly on clean DB and populated v2.4.1 DB.
3. Strict RBAC enforced with positive and negative test coverage.
4. CSP compliance maintained (zero inline scripts or styles).
5. All financial calculations verified in integer paise.
6. Documentation (`docs/architecture.md`, `README.md`, `DECISIONS_v3.md`) updated.
