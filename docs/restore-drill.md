# Disaster Recovery & Database Restore Drill

This document outlines the standard operating procedure (SOP) for consistent backup generation, automated retention pruning, and emergency database restoration for the **Kryston Infratech CRM**.

---

## 1. Architecture Overview

- **Engine:** SQLite with Write-Ahead Logging (`WAL` mode).
- **Online Backup:** Uses `better-sqlite3`'s transaction-safe `.backup()` API, which captures a consistent point-in-time page snapshot without locking write transactions or missing WAL frames.
- **Scheduled Backups:** Handled via `node-cron` running daily at `BACKUP_CRON_SCHEDULE` (default: `0 2 * * *` / 2:00 AM IST).
- **Retention Pruning:** Automatically keeps backups for `BACKUP_RETENTION_DAYS` (default: 7 days) and prunes expired `.db` archives.
- **Ledger Invariance:** `audit_log` and `lead_actions` are append-only. Archival exports export rows older than 2 years to compressed/jsonl files but **never** delete from the active database ledger.

---

## 2. Backup Execution

### Automated Backups
The server initializes the cron job automatically on bootstrap. Logs report backup status, size in bytes, and count of pruned historical backups.

### Manual Backup Command
```bash
npm run backup
```
Optional custom destination:
```bash
npm run backup -- ./backups/manual-checkpoint.db
```

---

## 3. Step-by-Step Restore Procedure (Restore Drill)

Follow these steps in case of hardware failure, catastrophic data corruption, or when performing regular DR drills:

### Step 1: Identify the Latest Verified Backup
List available backups in the `backups/` directory:
```bash
ls -lt backups/
```
Verify the integrity of the selected backup file before replacing active storage:
```bash
sqlite3 backups/kryston-YYYY-MM-DD_HH-MM-SS.db "PRAGMA integrity_check;"
```
Output must be `ok`.

### Step 2: Stop the Application Server
Prevent any active client sessions from initiating new transactions:
```bash
# Graceful stop
kill -SIGTERM <server-pid>
```

### Step 3: Execute Restore Utility
Run the restore script specifying the backup file:
```bash
npm run restore -- backups/kryston-YYYY-MM-DD_HH-MM-SS.db
```
The script will automatically:
1. Run `PRAGMA integrity_check` on the backup file.
2. Cleanly checkpoint and remove any stale `-wal` or `-shm` files.
3. Perform a safe atomic restoration to `DATABASE_FILE` (default: `./data/kryston.db`).
4. Execute `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the restored database.
5. Print verification counts for leads and employee accounts.

### Step 4: Start Server and Verify Health
```bash
npm start
```
Check health endpoint:
```bash
curl http://localhost:3000/health
```
Ensure HTTP 200 response with `{"status":"healthy","database":"ok"}`.

---

## 4. Audit Log Archival Drill

To archive historical audit events older than 2 years without violating append-only trigger rules:
```bash
npm run archive-audit
```
- Archive output directory: `data/archives/audit_log_archive_YYYY-MM-DD.jsonl`
- Records archived are retained in the JSONL file.
- The `audit_log` table retains all rows to satisfy strict immutability triggers.
