-- Migration 009: Auth Hardening
-- Adds must_change_password flag to employees for forced initial password change.

ALTER TABLE employees ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
