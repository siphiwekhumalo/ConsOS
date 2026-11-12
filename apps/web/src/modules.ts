import {
  Bot,
  BriefcaseBusiness,
  Calculator,
  ClipboardList,
  FolderKanban,
  HardHat,
  LayoutDashboard,
  Landmark,
  ScrollText,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  Eye,
  Inbox,
  UserCog,
  type LucideIcon,
} from 'lucide-react';
import type { ModuleId, Role } from './api';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** null = core feature available to every tenant. */
  module: ModuleId | null;
  /** Module number in the commercial catalogue. */
  moduleNo?: number;
  roles?: Role[];
  /** Backed by a real service today; otherwise a design preview with sample data. */
  live: boolean;
  description: string;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const COMMERCIAL: Role[] = ['owner', 'admin', 'project_manager', 'finance'];

/**
 * Navigation registry. The sidebar shows only items whose module is active for
 * the tenant (from /me) and whose roles include the user. This is a UX
 * convenience: every service independently enforces modules and roles.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { path: '/', label: 'Dashboard', icon: LayoutDashboard, module: null, live: true, description: 'Portfolio overview' },
      { path: '/projects', label: 'Projects', icon: FolderKanban, module: null, live: true, description: 'All contracts and sites' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { path: '/field', label: 'Field Operations', icon: ClipboardList, module: 'mod_field', moduleNo: 6, live: true, description: 'Site diaries, RFIs and site instructions' },
      { path: '/hse', label: 'HSE & Quality', icon: HardHat, module: 'mod_hse', moduleNo: 8, live: true, description: 'Incidents, inspections, NCRs and corrective actions' },
      { path: '/fleet', label: 'Fleet & Equipment', icon: Truck, module: 'mod_fleet', moduleNo: 7, roles: ['owner', 'admin', 'project_manager', 'site_foreman', 'finance'], live: true, description: 'Plant register, usage charging and maintenance' },
    ],
  },
  {
    label: 'Commercial',
    items: [
      { path: '/commercial', label: 'Commercial Intake', icon: Inbox, module: 'mod_commercial', moduleNo: 0, roles: COMMERCIAL, live: true, description: 'Client JCE intake, scoping and baseline lock' },
      { path: '/crm', label: 'CRM & Bids', icon: BriefcaseBusiness, module: 'mod_crm', moduleNo: 2, roles: COMMERCIAL, live: false, description: 'Clients, tenders and joint ventures' },
      { path: '/estimating', label: 'Estimating', icon: Calculator, module: 'mod_estimating', moduleNo: 4, roles: COMMERCIAL, live: false, description: 'Takeoffs, unit rates and BOQs' },
      { path: '/finance', label: 'Finance & CVR', icon: Landmark, module: 'mod_finance', moduleNo: 3, roles: COMMERCIAL, live: true, description: 'Cost-value reconciliation, valuations and rules' },
      { path: '/procurement', label: 'Procurement', icon: ShoppingCart, module: 'mod_procurement', moduleNo: 5, roles: [...COMMERCIAL, 'site_foreman'], live: true, description: 'Orders, quotes, deliveries, subcontracts and B-BBEE spend' },
    ],
  },
  {
    label: 'People',
    items: [
      { path: '/payroll', label: 'HR & Payroll', icon: Users, module: 'mod_payroll', moduleNo: 1, roles: ['owner', 'admin', 'finance', 'project_manager', 'site_foreman'], live: true, description: 'Employees, timesheets, leave and SARS payroll' },
    ],
  },
  {
    label: 'Intelligence & governance',
    items: [
      { path: '/agent', label: 'AI Operations Agent', icon: Bot, module: 'mod_ai', moduleNo: 10, roles: COMMERCIAL, live: true, description: 'Document intelligence and risk audits' },
      { path: '/portal', label: 'Client Portal', icon: Eye, module: 'mod_portal', moduleNo: 9, roles: ['owner', 'admin', 'project_manager'], live: false, description: 'Owner progress views and sign-offs' },
      { path: '/audit', label: 'Audit Trail', icon: ScrollText, module: null, roles: ['owner', 'admin', 'finance'], live: true, description: 'Tamper-evident ledger' },
      { path: '/settings/users', label: 'Users & access', icon: UserCog, module: null, roles: ['owner', 'admin'], live: true, description: 'Invite people and manage roles' },
    ],
  },
];

export const ALL_NAV = NAV_GROUPS.flatMap((g) => g.items);

export function visibleGroups(active: ModuleId[], role: Role): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => (i.module === null || active.includes(i.module)) && (!i.roles || i.roles.includes(role))),
  })).filter((g) => g.items.length > 0);
}

export const SECURITY_ICON = ShieldCheck;
