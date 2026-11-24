# Kryston CRM v2.4.0: Calling Queue, My Work, Auto-Reminders and Timeline (Feature Specification)

## 1. Mission and Non-Negotiables
Mission: when Admin Desk gives any department a task, the assignee must see two clean places: a Calling Queue (customers not yet contacted) and My Work (customers already contacted, work in progress). Once the assignee calls and submits the outcome, the task leaves the Calling Queue and shows up in My Work with what was done. If the customer says 'call me after 7 days', a reminder is created automatically and on that day Admin Desk is alerted so Admin can transfer the lead to a Telecaller or a department. Admin sees every change on the lead timeline with date and time.

Rules:
1. Read before you write. Names in this brief (tasks, lead_actions, department, dept) are indicative. Map them to the real schema and routes first.
2. Hub-and-spoke stays intact. Reminders only surface to Admin Desk (and the original assignee as information). The system never auto-reassigns, never lets a department self-assign or route work, and never skips a lead stage.
3. Append-only history. Timeline (lead_actions) and audit log are never edited. New activity tables are append-only with database triggers like the existing ones.
4. Server-side RBAC on every new endpoint, validated with the existing schema layer (zod). Add every endpoint to the RBAC matrix docs and make sure scripts/route-auth-sweep.js (if present) still passes.
5. Frontend stays CSP-safe: build DOM with createElement and textContent, no inline handlers, no innerHTML with data, no unsafe-inline.
6. Use the existing i18n mechanism (the header has a language switch). Add every new string through it.
7. Forward-only migration with backfill. Existing data must keep working. Take a backup before migrating (npm run backup).
8. Evidence or it did not happen. Never write 'done' without running npm run check, npm test and quoting results.
9. Windows-friendly (PowerShell dev machine), small commits, do not ask questions: decide, and record in docs/DECISIONS.md.

## 2. The Requirement in Plain Words
- Any department that gets a task first sees that customer in Calling Queue.
- After the call outcome and status report is submitted, the customer disappears from Calling Queue and appears in My Work with the status and what work was done.
- Admin opens the lead and sees on the timeline that something changed, with timestamp and date.
- If the customer says 'I will tell you after 7 days' (or 'call me after 7 days'), a reminder is set automatically. On that day Admin is alerted and decides: transfer to Telecaller or a department for the next action.
- After Admin reviews a department update, Admin can also set 'contact again in N days' and the same reminder system handles it.

## 3. UI Bugs Fixed
1. Calls: Calling Queue shows only NOT_CONTACTED tasks.
2. Calls: Stat tiles with proper layout, distinct counters, aria-live updates.
3. My Work: Strict non-overlapping view rules.
4. My Work: Admin page shows All Work vs My Work; friendly relative time pills.
5. All pages: Clean focus outlines using :focus-visible only, container tabindex="-1" without visible black box.
6. Header: Sticky header height/overflow fixed, ellipsis truncation with title tooltips.
7. Calls / Input: Phone normalization to 10-digit Indian mobile, Title Case names, structured budget & timeline.
8. My Work: Real Excel export or explicit clean naming.

## 4. View Rules and Outcomes
- Tasks have status and contact_status ('NOT_CONTACTED', 'CONTACTED', 'NOT_REQUIRED').
- Calling Queue: assigned_to = me AND status IN ('Assigned', 'In Progress') AND contact_status = 'NOT_CONTACTED' AND not snoozed.
- My Work > Active: assigned_to = me AND status IN ('Assigned', 'In Progress') AND contact_status IN ('CONTACTED', 'NOT_REQUIRED') AND no pending reminder.
- My Work > Waiting: same, but PENDING reminder exists.
- My Work > Sent for review: status = 'Submitted'.
- My Work > Done: status IN ('Reviewed', 'Closed') in last 30 days.
