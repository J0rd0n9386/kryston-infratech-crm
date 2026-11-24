-- Migration 008: Call log enhancements (call_purpose, customer_budget, requirement_type, location_area)
-- Supports enhanced Telecaller qualification workflow and structured lead activity ledger

ALTER TABLE task_activity ADD COLUMN call_purpose TEXT;
ALTER TABLE task_activity ADD COLUMN customer_budget TEXT;
ALTER TABLE task_activity ADD COLUMN requirement_type TEXT;
ALTER TABLE task_activity ADD COLUMN location_area TEXT;

ALTER TABLE telecaller_responses ADD COLUMN call_purpose TEXT;
ALTER TABLE telecaller_responses ADD COLUMN requirement_type TEXT;
ALTER TABLE telecaller_responses ADD COLUMN location_area TEXT;

ALTER TABLE leads ADD COLUMN call_purpose TEXT;
ALTER TABLE leads ADD COLUMN requirement_type TEXT;
