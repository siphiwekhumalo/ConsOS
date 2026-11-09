import type { ModuleId } from './api';

export interface NavItem {
  path: string;
  label: string;
  /** null = core feature, shown to every tenant. */
  module: ModuleId | null;
}

/**
 * Navigation registry. The sidebar renders only items whose module is in the
 * tenant's active list from /me. This is a UX convenience — the API enforces
 * entitlements independently with @RequiresModule.
 */
export const NAV: NavItem[] = [
  { path: '/projects', label: 'Projects', module: null },
  { path: '/field', label: 'Field Operations', module: 'mod_field' },
  { path: '/finance', label: 'Finance & CVR', module: 'mod_finance' },
  { path: '/payroll', label: 'Payroll', module: 'mod_payroll' },
  { path: '/procurement', label: 'Procurement', module: 'mod_procurement' },
  { path: '/hse', label: 'Health & Safety', module: 'mod_hse' },
  { path: '/ai', label: 'AI Assistant', module: 'mod_ai' },
];

export function visibleNav(active: ModuleId[]): NavItem[] {
  return NAV.filter((item) => item.module === null || active.includes(item.module));
}
