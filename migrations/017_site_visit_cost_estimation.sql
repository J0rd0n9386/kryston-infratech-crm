-- Migration 017: Site engineer construction cost estimation, civil/MEP/interior breakdown and sales negotiation advice
ALTER TABLE site_visits ADD COLUMN estimated_cost REAL DEFAULT 0;
ALTER TABLE site_visits ADD COLUMN civil_cost REAL DEFAULT 0;
ALTER TABLE site_visits ADD COLUMN interior_cost REAL DEFAULT 0;
ALTER TABLE site_visits ADD COLUMN mep_cost REAL DEFAULT 0;
ALTER TABLE site_visits ADD COLUMN labor_logistics_cost REAL DEFAULT 0;
ALTER TABLE site_visits ADD COLUMN estimated_timeline TEXT;
ALTER TABLE site_visits ADD COLUMN site_risk_level TEXT DEFAULT 'Low';
ALTER TABLE site_visits ADD COLUMN scope_details TEXT;
ALTER TABLE site_visits ADD COLUMN sales_advice TEXT;

ALTER TABLE leads ADD COLUMN estimated_cost REAL DEFAULT 0;
