/**
 * Commercial modules a tenant can subscribe to.
 * Must match the CHECK constraint on tenants.active_modules (migration 0005).
 */
export const MODULE_IDS = [
  'mod_commercial', // 0  Administration & Commercial (estimate intake → baseline)
  'mod_payroll', // 1  HRIS & SARS Payroll
  'mod_crm', // 2  CRM & Bids
  'mod_finance', // 3  Finance & CVR
  'mod_estimating', // 4  Estimating & Takeoff
  'mod_procurement', // 5  Supply Chain & Procurement
  'mod_field', // 6  Field Operations & Daily Logs
  'mod_fleet', // 7  Fleet, Equipment & CMMS
  'mod_hse', // 8  HSE & Safety
  'mod_portal', // 9  Client / Owner Portal
  'mod_ai', // 10 AI Operations Agent
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}
