-- Migration 003: 2.3.0-auth-security
-- Lockout tracking, idle sessions, and TOTP two-factor authentication

ALTER TABLE employees ADD COLUMN last_active_at TEXT;
ALTER TABLE employees ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN locked_until TEXT;
ALTER TABLE employees ADD COLUMN two_factor_secret TEXT;
ALTER TABLE employees ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN recovery_codes TEXT;
