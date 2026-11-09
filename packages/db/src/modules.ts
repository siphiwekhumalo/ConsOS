/**
 * Commercial modules a tenant can subscribe to.
 * Must match the CHECK constraint on tenants.active_modules (migration 0001).
 */
export const MODULE_IDS = [
  'mod_field',
  'mod_finance',
  'mod_payroll',
  'mod_procurement',
  'mod_hse',
  'mod_ai',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}
