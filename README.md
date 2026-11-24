# Kryston Infratech CRM & Operations ERP (v3.6.0)

[![CI](https://github.com/J0rd0n9386/kryston-infratech-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/J0rd0n9386/kryston-infratech-crm/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-79%20Passing-brightgreen.svg)](#7-tests)
[![Architecture](https://img.shields.io/badge/Architecture-Hub%20%26%20Spoke-blue.svg)](docs/architecture.md)
[![Database](https://img.shields.io/badge/Database-SQLite%20WAL-lightgrey.svg)](https://sqlite.org/)

An industry-grade, hub-and-spoke operations CRM and ERP built for construction, turnkey architecture, and interior infrastructure enterprises.

**Admin Desk is the single orchestrator and source of truth**: every department (Telecalling, Sales, Site Engineering, Architectural Design, Accounts, Procurement, Project Management) receives work via structured Admin-directed tasks and reports findings back to Admin Desk. Spokes never route work directly to each other.

The authoritative workflow, RBAC matrix, API reference and screen inventory are
in [`docs/architecture.md`](docs/architecture.md).

---

## ⚡ Quick Start & Local Setup

Run `npm run setup` before invoking server scripts directly. `npm start`, `npm run dev`, `npm run migrate` and `npm run bootstrap-admin` create a missing local `.env` automatically. Each installation receives a unique random JWT secret. An existing `.env` is preserved. `.env.example` is a template, not a working secret.

Demo seeding is disabled by default. Follow the administrator bootstrap instructions below to create your login. Production requires explicit environment configuration. Keep `.env` private and preserve it when updating the app.

---

## 1. What is implemented

| Area | Behaviour |
|---|---|
| Lead intake | Central-only registration with strict 10-digit Indian mobile validation, phone deduplication and an immutable timeline |
| Calling Queue (v2.4.0) | Dedicated queue for calls needing initial contact; customer cards with Title Case, one-click copy, and attempt badges |
| My Work (v2.4.0) | Categorized tabs (Active, Waiting, Sent for review, Done), Admin scope toggle, work notes and submission actions |
| Auto-Reminders (v2.4.0) | Automated callbacks scheduled in IST; injectable clock, hourly sweeps, Due Follow-ups strip, and RE_ENGAGE tasks |
| Activity Ledger (v2.4.0) | Append-only `task_activity` ledger rejecting UPDATE and DELETE via database triggers |
| Telecaller qualification | Assigned calls only; structured response returns to Admin Desk |
| Department work | Task-scoped read/write access; findings, site inspections and design versions submit back to the hub |
| Quotations | Versioned proposals prepared by the assigned Sales employee; Sales Manager / Admin approval |
| Work orders | Sales Manager submits `Pending Admin Approval`; Admin Desk assigns PM + Site Engineer and creates the project |
| Project execution | Milestone plan, progress updates, blockers and handoff history |
| Governance | Append-only `lead_actions`, `audit_log`, and `task_activity`, CSV/Excel exports, system health and audit screens |
| Security | JWT sessions with revocation, bcrypt passwords, strict RBAC, CSP with no inline scripts/styles, rate limits, request IDs |

### Workflow at a glance

```text
Lead intake
  -> Admin assigns Telecaller
  -> Telecaller submits enquiry
  -> Admin routes exactly one department task
  -> Spoke submits findings
  -> Admin reviews
  -> Quotation Stage -> Sent -> Negotiation -> Approved
  -> Sales Manager submits Work Order (Pending Admin Approval)
  -> Admin Desk assigns PM + Site Engineer
  -> Project Handoff -> In Progress -> Completed
```

Direct stage changes are limited to `Lost` and `Nurture`, and require a written
reason. Everything else must use the workflow endpoints.

---

## 2. Requirements

- **Node.js 20 or newer** (Node 22 is used in development)
- npm 10+
- Windows, macOS or Linux

SQLite is embedded through `better-sqlite3`; no database server is required.

---

## 3. First-time setup

On Windows, double-click **`START-WINDOWS.cmd`**. It performs a clean dependency
install when needed, creates a private `.env` containing random credentials, and
starts the CRM. This prevents both the `better-sqlite3` missing-module error and
placeholder `JWT_SECRET` startup failure on a fresh unzip.

For a manual setup, run `npm ci`, then `npm run setup`. Do not copy the template
secret unchanged; the setup command generates a unique 96-character JWT secret
and preserves any existing `.env`.

Set `SEED_DEMO=true` only for a local evaluation database. Set it to `false`
before production. If the database is empty and you do **not** want demo data,
run the one-time interactive bootstrap instead:

```powershell
npm run bootstrap-admin
```

### Start

```powershell
npm start        # http://localhost:3000
npm run dev      # Node watch mode
```

The sign-in form is always empty. No credentials are pre-filled and there is no
one-click demo login. If demo seeding is enabled, the seeded accounts use the
password in `DEMO_PASSWORD` (default `Admin@12345`) and the addresses documented
in `src/db/seed.js`.

### Production checklist

1. Set `NODE_ENV=production`.
2. Set `SEED_DEMO=false`.
3. Use a long, unique `JWT_SECRET`.
4. Put the app behind TLS (a reverse proxy is recommended).
5. Set `TRUST_PROXY=true` only when a trusted proxy is in front of the app.
6. Run `npm run backup` on a schedule and store backups off the server.
7. Review the RBAC matrix in `docs/architecture.md` against your organisation.

---

## 4. Scripts

| Command | Purpose |
|---|---|
| `npm start` | Start the production server with Pino structured JSON logging |
| `npm run dev` | Start with Node's watch mode |
| `npm test` | Run the full automated regression suite, including workflow, RBAC, security and IST behaviour |
| `npm run check` | Syntax-check every first-party JavaScript file |
| `npm run lint` | ESLint flat-config code quality check |
| `npm run format:check` | Prettier code style verification |
| `npm run coverage` | Run test suite with Node's built-in experimental test coverage |
| `npm run backup` | Create an online SQLite backup and verify its integrity (`backups/`) |
| `npm run restore` | Safely restore database from a verified backup with integrity check |
| `npm run archive-audit` | Export older audit ledger records without deleting rows |
| `npm run bootstrap-admin` | Interactively create the first Super Admin when the database is empty |

---

## 5. Docker Deployment

```powershell
# Build and start via Docker Compose
docker compose up -d

# Check service logs
docker compose logs -f crm
```

---

## 5. Project layout

```text
src/
  app.js                 Express app factory, CSP, rate limits, static files
  server.js              Bootstrap, graceful shutdown, WAL checkpoint
  config.js              Environment validation and frozen configuration
  backup.js              Online SQLite backup + integrity check
  middleware/            Auth, RBAC, validation and typed error handling
  lib/                   State machine, SLA, ID generation, audit/notification helpers
  db/                    Schema, migrations, connection and demo seed
  routes/                Auth, leads, task board, tasks, telecaller, department
                         updates, quotations, work orders, projects, dashboard,
                         notifications, audit and exports
public/
  index.html             CSP-safe shell; no inline handlers or styles
  styles.css             Enterprise design system
  js/core.js             Shared client state, API client, forms, tables, modals
  js/pages.js            Overview, task board, lead register and lead workspace
  js/work.js             Telecaller desk, department tasks, site visits and designs
  js/commercial.js       Quotations, work orders and project execution
  js/admin.js            Employee directory and audit log
  js/boot.js             Session restore, sign-in, navigation and notifications
scripts/                 Syntax gate and one-time admin bootstrap
tests/                   End-to-end workflow tests
docs/architecture.md     Authoritative hub-and-spoke specification
```

---

## 6. Security posture

- Passwords: bcrypt hashes, minimum 12 characters with a letter and a number.
- Sessions: short-lived JWTs bound to issuer/audience and an employee
  `token_version`; logout and password resets revoke existing tokens.
- RBAC: central roles (`SUPER_ADMIN`, `ADMIN_DESK`) plus task-assignment checks
  for every spoke action.
- Headers: strict Content Security Policy (`script-src 'self'`,
  `style-src 'self'`, `frame-ancestors 'none'`), no inline code, no XSS-prone
  HTML string rendering in the client.
- Limits: separate login and API rate limits; JSON body size cap.
- Ledgers: database triggers reject `UPDATE` and `DELETE` on `lead_actions` and
  `audit_log`.
- Errors: typed HTTP errors with request IDs; internal details are not leaked.

The client is a vanilla JavaScript single-page application. It builds every view
with `createElement` and `textContent`, so the strict CSP remains enabled without
`unsafe-inline`.

---

## 7. Tests

```powershell
npm test
npm run check
```

The integration suite covers health, authentication, CSP headers, the full lead
lifecycle (intake, telecaller, routing, Sales review, quotation, Sales Manager
approval, work order, Admin handoff and project progress), stage guards,
immutable ledgers, exports and employee administration.

---

## 8. Operational notes

- The SQLite database defaults to `data/kryston.db`; WAL mode is enabled.
- Schema migrations are numbered SQL files under `migrations/`, tracked in `schema_migrations`, and applied transactionally via `npm run migrate` or automatically at application startup.
- Migrations are forward-only. For rollbacks or disaster recovery, restore the database from a verified online backup created prior to the migration:
  ```powershell
  # Create a backup before running migrations or major operational changes:
  npm run backup
  
  # To restore from a backup:
  # 1. Stop the application server: Stop-Process -Name node (or Ctrl+C)
  # 2. Replace data/kryston.db (and remove data/kryston.db-wal and data/kryston.db-shm if present) with the backup file.
  # 3. Restart the application server.
  ```
- `npm run backup` uses SQLite's online backup API, checks integrity and writes a
  timestamped file under `backups/`.
- The audit screen exposes integrity, foreign-key and row-count diagnostics for
  central roles.
- Exports are central-only and include CSV plus SpreadsheetML `.xls` workbooks.

For the full flow, role matrix, state machine and API contract, read
[`docs/architecture.md`](docs/architecture.md).
