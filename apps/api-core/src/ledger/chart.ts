import type { AccountType } from '@constructos/db';

/** Accounts the system posts to automatically, found by system_key. */
export type SystemKey =
  | 'bank_main'
  | 'ar_control'
  | 'retention_receivable'
  | 'vat_input'
  | 'ap_control'
  | 'vat_output'
  | 'retention_payable'
  | 'retained_earnings'
  | 'contract_revenue'
  | 'cost_labour'
  | 'cost_material'
  | 'cost_plant'
  | 'cost_subcontract'
  | 'cost_overhead'
  | 'cost_other'
  | 'bank_charges';

export interface ChartEntry {
  code: string;
  name: string;
  type: AccountType;
  systemKey?: SystemKey;
  isBank?: boolean;
}

/**
 * Default chart for a South African contractor. 5xxx expense accounts are
 * contract costs (cost of sales); 6xxx are overheads.
 */
export const DEFAULT_CHART: ChartEntry[] = [
  { code: '1000', name: 'Bank: current account', type: 'asset', systemKey: 'bank_main', isBank: true },
  { code: '1100', name: 'Trade receivables', type: 'asset', systemKey: 'ar_control' },
  { code: '1150', name: 'Retention receivable', type: 'asset', systemKey: 'retention_receivable' },
  { code: '1200', name: 'VAT input', type: 'asset', systemKey: 'vat_input' },
  { code: '1300', name: 'Prepayments and deposits', type: 'asset' },
  { code: '1500', name: 'Plant and equipment', type: 'asset' },
  { code: '1510', name: 'Accumulated depreciation: plant', type: 'asset' },
  { code: '1600', name: 'Vehicles', type: 'asset' },
  { code: '1610', name: 'Accumulated depreciation: vehicles', type: 'asset' },
  { code: '2000', name: 'Trade payables', type: 'liability', systemKey: 'ap_control' },
  { code: '2100', name: 'VAT output', type: 'liability', systemKey: 'vat_output' },
  { code: '2150', name: 'Retention payable (subcontractors)', type: 'liability', systemKey: 'retention_payable' },
  { code: '2200', name: 'PAYE, UIF and SDL payable', type: 'liability' },
  { code: '2300', name: 'Accrued expenses', type: 'liability' },
  { code: '2500', name: 'Long-term borrowings', type: 'liability' },
  { code: '3000', name: 'Share capital', type: 'equity' },
  { code: '3100', name: 'Retained earnings', type: 'equity', systemKey: 'retained_earnings' },
  { code: '4000', name: 'Contract revenue', type: 'income', systemKey: 'contract_revenue' },
  { code: '4100', name: 'Plant hire income', type: 'income' },
  { code: '4900', name: 'Other income', type: 'income' },
  { code: '5000', name: 'Contract costs: labour', type: 'expense', systemKey: 'cost_labour' },
  { code: '5010', name: 'Contract costs: materials', type: 'expense', systemKey: 'cost_material' },
  { code: '5020', name: 'Contract costs: plant', type: 'expense', systemKey: 'cost_plant' },
  { code: '5030', name: 'Contract costs: subcontractors', type: 'expense', systemKey: 'cost_subcontract' },
  { code: '5040', name: 'Contract costs: site overheads', type: 'expense', systemKey: 'cost_overhead' },
  { code: '5050', name: 'Contract costs: other', type: 'expense', systemKey: 'cost_other' },
  { code: '6000', name: 'Salaries: head office', type: 'expense' },
  { code: '6100', name: 'Rent and utilities', type: 'expense' },
  { code: '6200', name: 'Insurance', type: 'expense' },
  { code: '6300', name: 'Depreciation', type: 'expense' },
  { code: '6400', name: 'Professional fees', type: 'expense' },
  { code: '6500', name: 'IT and software', type: 'expense' },
  { code: '6800', name: 'Bank charges', type: 'expense', systemKey: 'bank_charges' },
  { code: '6900', name: 'Interest paid', type: 'expense' },
];

/** Where a project cost of each category is expensed. */
export const COST_CATEGORY_KEY = {
  labour: 'cost_labour',
  material: 'cost_material',
  plant: 'cost_plant',
  subcontract: 'cost_subcontract',
  overhead: 'cost_overhead',
  other: 'cost_other',
} as const satisfies Record<string, SystemKey>;
