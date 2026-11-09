import type { EstimateStage, LineFlag, Role } from '../../api';

export const STAGES: { id: EstimateStage; label: string; hint: string }[] = [
  { id: 'intake', label: 'Intake', hint: 'Client JCE received and standardised' },
  { id: 'technical_review', label: 'Technical Review', hint: 'Internal takeoff and pricing' },
  { id: 'client_approval', label: 'Client Approval', hint: 'Scope frozen, with the client' },
  { id: 'baseline_locked', label: 'Baselines Locked', hint: 'Frozen. Project created' },
];

export const STAGE_LABEL: Record<EstimateStage, string> = {
  intake: 'Intake',
  technical_review: 'Technical Review',
  client_approval: 'Client Approval',
  baseline_locked: 'Baseline Locked',
  rejected: 'Rejected',
};

/** Mirrors the API's approval tiers so the UI only offers moves the user can make. */
export const TRANSITION_ROLES: Record<string, Role[]> = {
  'intake>technical_review': ['owner', 'admin', 'project_manager'],
  'technical_review>client_approval': ['owner', 'admin', 'finance'],
  'technical_review>intake': ['owner', 'admin', 'project_manager', 'finance'],
  'client_approval>technical_review': ['owner', 'admin', 'project_manager', 'finance'],
  'client_approval>baseline_locked': ['owner', 'admin'],
  'intake>rejected': ['owner', 'admin'],
  'technical_review>rejected': ['owner', 'admin'],
  'client_approval>rejected': ['owner', 'admin'],
  'rejected>intake': ['owner', 'admin'],
};

export const canMove = (from: EstimateStage, to: EstimateStage, role: Role) => TRANSITION_ROLES[`${from}>${to}`]?.includes(role) ?? false;

export const FLAG_META: Record<LineFlag, { label: string; tone: 'warning' | 'critical' | 'serious'; help: string }> = {
  under_recovery: { label: 'Under-recovery', tone: 'critical', help: 'Internal cost exceeds what the client will pay' },
  missing_client: { label: 'Unpriced by client', tone: 'critical', help: 'Scope you will perform that the client has not priced' },
  missing_internal: { label: 'Not assessed', tone: 'serious', help: 'Client line with no internal takeoff yet' },
  qty_mismatch: { label: 'Quantity differs', tone: 'warning', help: 'Client and internal quantities differ' },
  rate_variance: { label: 'Rate > 2% off', tone: 'warning', help: 'Rates differ by more than 2%' },
};

export const EDIT_ROLES: Role[] = ['owner', 'admin', 'project_manager', 'finance'];
