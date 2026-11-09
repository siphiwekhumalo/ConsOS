-- =============================================================================
-- 0004 — Full commercial module catalogue (10 modules)
--
--   mod_payroll      1  HRIS & SARS Payroll
--   mod_crm          2  CRM & Bids                (new)
--   mod_finance      3  Finance & CVR
--   mod_estimating   4  Estimating & Takeoff      (new)
--   mod_procurement  5  Supply Chain & Procurement
--   mod_field        6  Field Operations & Daily Logs
--   mod_fleet        7  Fleet, Equipment & CMMS   (new)
--   mod_hse          8  HSE & Safety
--   mod_portal       9  Client / Owner Portal     (new)
--   mod_ai          10  AI Operations Agent
-- =============================================================================

ALTER TABLE tenants DROP CONSTRAINT tenants_active_modules_check;

ALTER TABLE tenants ADD CONSTRAINT tenants_active_modules_check
  CHECK (active_modules <@ ARRAY[
    'mod_payroll', 'mod_crm', 'mod_finance', 'mod_estimating', 'mod_procurement',
    'mod_field', 'mod_fleet', 'mod_hse', 'mod_portal', 'mod_ai'
  ]::text[]);
