import type { ModuleId, Role } from './api';

export interface NavItem {
  path: string;
  label: string;
  /** null = core feature, shown to every tenant. */
  module: ModuleId | null;
  roles?: Role[];
  /** true = module exists commercially but has no screens yet. */
  comingSoon?: boolean;
}

/**
 * Navigation registry. The sidebar shows only items whose module is in the
 * tenant's active list (from /me) and whose roles include the user. This is a
 * UX convenience: every API independently enforces modules and roles.
 */
export const NAV: NavItem[] = [
  { path: '/projects', label: 'Projects', module: null },
  { path: '/rules', label: 'Commercial rules', module: 'mod_finance', roles: ['owner', 'admin', 'finance', 'project_manager'] },
  { path: '/ai', label: 'AI insights', module: 'mod_ai', roles: ['owner', 'admin', 'project_manager', 'finance'] },
  { path: '/audit', label: 'Audit trail', module: null, roles: ['owner', 'admin', 'finance'] },
  { path: '/payroll', label: 'Payroll', module: 'mod_payroll', comingSoon: true },
  { path: '/procurement', label: 'Procurement', module: 'mod_procurement', comingSoon: true },
  { path: '/hse', label: 'Health & Safety', module: 'mod_hse', comingSoon: true },
];

export function visibleNav(active: ModuleId[], role: Role): NavItem[] {
  return NAV.filter(
    (item) => (item.module === null || active.includes(item.module)) && (!item.roles || item.roles.includes(role)),
  );
}
