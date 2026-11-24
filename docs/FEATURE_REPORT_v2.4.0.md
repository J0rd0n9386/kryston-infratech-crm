# Kryston CRM v2.4.0 Feature Report & Acceptance Sign-off

**Release Version:** v2.4.0  
**Date:** 2026-11-23  
**Status:** COMPLETE & VERIFIED (All 65 Tests Passing)  
**Architecture:** Hub-and-spoke operations CRM (Node.js, Express, SQLite via `better-sqlite3`, Vanilla JS frontend)  

---

## Executive Summary

Kryston CRM v2.4.0 completes the comprehensive workflow upgrade requested in the specification:
1. **Calling Queue**: Specialized queue for intake and tasks requiring contact before work begins. Tasks enter with `contact_status = 'NOT_CONTACTED'`, display customer cards in Title Case, one-click phone copy, phone validation, attempt badges, and call outcome logging.
2. **My Work Workspace**: Re-architected task views with mutually exclusive tabs:
   - **Active**: Tasks contacted or not requiring contact, pending completion.
   - **Waiting**: Tasks with scheduled future actions or pending reminders.
   - **Sent for review**: Submitted tasks awaiting Admin Desk review.
   - **Done**: Reviewed, closed, or cancelled tasks.
   - **Admin Scope Toggle**: Central roles toggle between "All Tasks" and "My Work Only".
3. **Auto-Reminders & Injectable Clock**:
   - Application clock in `Asia/Kolkata` (IST) with dependency-injected test clock (`src/lib/clock.js`).
   - Daily cron at 09:00 IST and hourly sweep at :05 past every hour (`src/jobs/reminders.js`).
   - Reminders trigger `RE_ENGAGE` tasks for Admin Desk and notify assignees.
   - Idempotent execution preventing duplicate tasks or notifications.
   - Admin routing from reminder marks reminder `DONE`, closes `RE_ENGAGE` task, and routes new task.
   - Snooze (creates linked pending reminder) and Dismiss (requires reason).
   - Marking a lead `Lost` automatically cancels active reminders.
4. **Activity Ledger (`task_activity`)**:
   - Append-only immutable ledger tracking `CALL` and `WORK_NOTE` entries.
   - SQLite triggers reject `UPDATE` and `DELETE` operations.
5. **Strict Indian Mobile Validation**:
   - Enforced `/^[6-9]\d{9}$/` regex on 10-digit normalized numbers.
   - Handles `+91` prefix, leading `0`, and spaces cleanly.
   - Invalid numbers (e.g., 12-digit `074880908876`) rejected with HTTP 400.
6. **UI Bug Fixes & Polish**:
   - Focus outline bug on `#view` fixed via `outline: none;` on focus.
   - Topbar sticky positioning and overflow ellipsis for long emails fixed.
   - Due follow-ups strip rendered prominently above Taskboard kanban lanes.
   - Customer modal includes reminder alert banners with instant Snooze/Dismiss actions.
   - Task modal includes complete task activity feed and work note logging.
   - CSP-safe DOM construction throughout (`createElement`, `textContent`, no inline handlers).

---

## Acceptance Test Suite Verification

All 16 acceptance test criteria from Section 8 of the specification have been implemented and verified in `tests/calling-queue.test.js`:

| # | Acceptance Criterion | Test Name / Location | Status | Evidence |
|---|---|---|---|---|
| 1 | New task appears only in Calling Queue, never in My Work | `Criterion 1` in `tests/calling-queue.test.js:86` | PASS | Task in `/api/queues/calling`, absent from `/api/queues/my-work?tab=active` |
| 2 | NO_ANSWER keeps in Calling Queue, attempts=1, CALL_OUTCOME row logged; 3 failed attempts notifies Admin once | `Criterion 2` in `tests/calling-queue.test.js:135` | PASS | `contact_attempts=1`, `task_activity` logged, notification triggered at 3 attempts, deduplicated on 4th |
| 3 | CONNECTED moves to My Work > Active with notes, work summary, timestamps; timeline shows CALL_OUTCOME in IST | `Criterion 3` in `tests/calling-queue.test.js:209` | PASS | `contact_status='CONTACTED'`, task in Active tab, lead timeline has `CALL_OUTCOME` in IST |
| 4 | CALLBACK_REQUESTED with date in 7 days creates PENDING reminder and puts task in My Work > Waiting | `Criterion 4` in `tests/calling-queue.test.js:266` | PASS | Reminder created in `reminders`, task in `/api/queues/my-work?tab=waiting` |
| 5 | Injectable clock test: At 08:59 nothing triggers; at 09:00 reminder TRIGGERED, RE_ENGAGE task created, Admin and assignee notified, AUTO_REMINDER_TRIGGERED on timeline | `Criterion 5` in `tests/calling-queue.test.js:314` | PASS | 08:59 triggers 0 reminders; 09:00 triggers 1 reminder, creates `RE_ENGAGE` task, timeline updated |
| 6 | Idempotency test: Run job twice, restart app; exactly 1 Admin task and 1 notification | `Criterion 6` in `tests/calling-queue.test.js:364` | PASS | Second and third runs trigger 0 reminders; total `RE_ENGAGE` tasks = 1 |
| 7 | Admin routing from triggered reminder marks reminder DONE, closes RE_ENGAGE task, assigns new task in Calling Queue as NOT_CONTACTED | `Criterion 7` in `tests/calling-queue.test.js:379` | PASS | Reminder marked `DONE`, `RE_ENGAGE` closed, new task in Calling Queue with `NOT_CONTACTED` |
| 8 | Snooze 7 days creates linked PENDING reminder; Dismiss requires reason | `Criterion 8` in `tests/calling-queue.test.js:412` | PASS | Old reminder `SNOOZED`, linked reminder created; dismiss without reason rejected (400), with reason marked `DISMISSED` |
| 9 | Lead moved to Lost cancels pending reminders | `Criterion 9` in `tests/calling-queue.test.js:464` | PASS | Lead stage `Lost` cancels pending reminders (`status='CANCELLED'`) |
| 10 | RBAC: non-assignee gets 404 on contact/work-note, cannot read other queue, telecaller cannot route | `Criterion 10` in `tests/calling-queue.test.js:500` | PASS | 404 returned on contact/work-note by non-assignee; 403 on telecaller route |
| 11 | Purchase and Accounts tasks with requires_contact = 0 skip Calling Queue directly into My Work | `Criterion 11` in `tests/calling-queue.test.js:538` | PASS | Purchase task `requires_contact=0`, absent from Calling Queue, present in My Work > Active |
| 12 | Migration test: existing rows correctly backfilled, no task duplicated | `Criterion 12` in `tests/calling-queue.test.js:578` | PASS | Migration 007 backfills existing tasks, `KRY-SYS-001` seeded |
| 13 | Views mutually exclusive: every combination belongs to exactly 1 view | `Criterion 13` in `tests/calling-queue.test.js:592` | PASS | Unit tests verify deterministic, non-overlapping view assignment |
| 14 | Timezone test: due on local date triggers at 09:00 IST (not 09:00 UTC) | `Criterion 14` in `tests/calling-queue.test.js:605` | PASS | Verified clock converts UTC to `Asia/Kolkata` date and hour correctly |
| 15 | task_activity rejects UPDATE and DELETE triggers | `Criterion 15` in `tests/calling-queue.test.js:616` | PASS | SQLite triggers raise `task_activity is append-only` constraint on update/delete |
| 16 | Phone normalization accepts +91 98765 43210 and 098765 43210, and rejects 074880908876 | `Criterion 16` in `tests/calling-queue.test.js:638` | PASS | Valid Indian mobiles accepted and normalized to 10 digits; invalid rejected with 400 |

---

## Test Run Summary

```text
> node --test
TAP version 13
# tests 65
# suites 0
# pass 65
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9702.544
```

- **Calling Queue & Reminders Suite (`tests/calling-queue.test.js`)**: 16/16 PASS
- **Workflow & Lifecycle Suite (`tests/workflow.test.js`)**: PASS
- **Security & RBAC Suite (`tests/security.test.js`)**: PASS
- **Migrations & Integrity Suite (`tests/migration.test.js`)**: PASS
- **My Day & Notifications Suite (`tests/my-day.test.js`, `tests/phase3.test.js`, `tests/phase4.test.js`, `tests/phase2.test.js`)**: PASS

---

## Key Files Created and Modified

1. **Database & Migrations**:
   - `migrations/007_calling_queue_and_reminders.sql`: Forward-only migration adding task contact columns, `task_activity` ledger, `reminders` table, indexes, and immutability triggers.
   - `src/db/migrations.js`: Registered migration 007.
   - `backups/kryston-2026-11-23_08-32-49.db`: Verified online database backup.
2. **Core Services**:
   - `src/lib/clock.js`: Injectable IST clock supporting `now()`, `todayLocal()`, `formatIST()`, `setFixedTime()`, `advanceTime()`, and `reset()`.
   - `src/lib/services/queue-service.js`: Calling Queue and My Work partition logic with `determineTaskView`.
   - `src/lib/services/activity-service.js`: Append-only work note creation with hours spent and next actions.
   - `src/lib/services/reminder-service.js`: Creation, snoozing, dismissing, cancellation, and idempotent batch triggering of due reminders.
   - `src/lib/services/contact-service.js`: Call outcome logging, contact status sync, 3-attempt Admin escalation.
3. **API Routes & Schedulers**:
   - `src/routes/queues.js`: `GET /api/queues/summary`, `GET /api/queues/calling`, `GET /api/queues/my-work`.
   - `src/routes/reminders.js`: `POST /api/leads/:id/reminders`, `GET /api/reminders`, `POST /api/reminders/:id/snooze`, `POST /api/reminders/:id/dismiss`.
   - `src/routes/tasks.js`: Updated with `POST /api/tasks/:id/contact` and `POST /api/tasks/:id/work-note`.
   - `src/routes/leads.js`: Updated route schemas to support `reminder_id`, automatic cancellation of reminders on `Lost`.
   - `src/jobs/reminders.js`: Automated cron jobs for daily 09:00 IST reminder sweep and hourly check.
4. **User Interface**:
   - `public/styles.css`: Stat tiles, tabs bar, quick date chips, due follow-ups strip, focus outline fix, and sticky calling actions.
   - `public/js/work.js`: Calling Queue screen with stats/filters/cards, My Work with Active/Waiting/Review/Done tabs, Call Outcome modal, Work Note modal, Snooze/Dismiss modals.
   - `public/js/pages.js`: Due Follow-ups Strip on Taskboard, Follow-up alert banner in customer modal.
   - `public/js/core.js`: Role-based route guard, relative time formatting, title casing, dynamic badge counters.
   - `public/js/i18n.js`: Comprehensive English & Hindi translations for all new actions and outcomes.
5. **Quality Assurance**:
   - `tests/calling-queue.test.js`: 16 comprehensive automated acceptance tests.
   - `tests/migration.test.js`: Migration 007 verification and trigger immutability tests.
   - `package.json` & `src/app.js`: Version bumped to `2.4.0`.
   - `README.md`: Updated with operational scripts and v2.4.0 documentation.
