import { Decimal } from '@constructos/dsl-parser';
import type { CostCode, CostEntry, Valuation, Variation } from '@constructos/db';

/**
 * Project-controls arithmetic. Pure and decimal-only: every amount goes in and
 * comes out as a fixed-2 string, never a JS float.
 */

type D = InstanceType<typeof Decimal>;
const d = (v: string | null | undefined) => new Decimal(v ?? '0');
export const money = (v: D) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const pct = (part: D, whole: D) => (whole.isZero() ? null : part.dividedBy(whole).times(100).toDecimalPlaces(1).toFixed(1));

// ----------------------------------------------------------------- valuations

export interface ValuationInput {
  workDoneToDate: string;
  materialsOnSite: string;
  retentionPct: string;
  retentionLimitPct: string;
  /** Revised contract value (original + approved variations); null = no cap. */
  contractValue: string | null;
  previouslyCertified: string;
}

export interface ValuationFigures {
  grossToDate: string;
  retentionToDate: string;
  netToDate: string;
  amountDue: string;
}

/** Cumulative certificate figures, as on a JBCC / FIDIC / NEC4 payment certificate. */
export function valuationFigures(i: ValuationInput): ValuationFigures {
  const gross = d(i.workDoneToDate).plus(d(i.materialsOnSite));
  let retention = gross.times(d(i.retentionPct)).dividedBy(100);
  if (i.contractValue !== null) {
    const cap = d(i.contractValue).times(d(i.retentionLimitPct)).dividedBy(100);
    if (retention.greaterThan(cap)) retention = cap;
  }
  const grossS = money(gross);
  const retentionS = money(retention);
  const net = d(grossS).minus(d(retentionS));
  return {
    grossToDate: grossS,
    retentionToDate: retentionS,
    netToDate: money(net),
    amountDue: money(net.minus(d(i.previouslyCertified))),
  };
}

// ----------------------------------------------------------------- variations

/** Days left before the contractual notice period expires; null when not applicable. */
export function timeBarDaysLeft(v: Pick<Variation, 'status' | 'notifiedOn' | 'timeBarDays'>, today = new Date()): number | null {
  if (v.status !== 'draft' || !v.timeBarDays) return null;
  const deadline = new Date(`${v.notifiedOn}T00:00:00Z`).getTime() + v.timeBarDays * 86_400_000;
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((deadline - now) / 86_400_000);
}

// ----------------------------------------------------------------- CVR

export interface CostCodeRow {
  id: string;
  code: string;
  description: string;
  budget: string;
  variationBudget: string;
  revisedBudget: string;
  cost: string;
  /** Ordered or subcontracted but not yet invoiced / certified. */
  committed: string;
  /** The larger of the remaining budget and what is already committed. */
  costToComplete: string;
  /** cost + cost to complete */
  forecastFinalCost: string;
  /** revised budget − forecast final cost; negative = overrun */
  overrun: string;
  usedPct: string | null;
}

export interface CvrSummary {
  contractValue: string;
  approvedVariations: string;
  pendingVariations: string;
  revisedContractValue: string;
  originalBudget: string;
  revisedBudget: string;
  costToDate: string;
  committedCost: string;
  certifiedValue: string;
  retentionHeld: string;
  certifiedNet: string;
  paidToDate: string;
  /** certified value − cost to date */
  marginToDate: string;
  marginToDatePct: string | null;
  forecastFinalCost: string;
  /** revised contract value − forecast final cost */
  forecastMargin: string;
  forecastMarginPct: string | null;
  /** cost to date / revised budget */
  costCompletePct: string | null;
  /** certified value / revised contract value */
  valueCompletePct: string | null;
}

export interface CvrMonth {
  month: string; // YYYY-MM
  cost: string; // cumulative
  value: string; // cumulative certified gross
}

export function cvr(
  project: { contractValue: string | null },
  codes: CostCode[],
  entries: Pick<CostEntry, 'costCodeId' | 'amount' | 'entryDate'>[],
  variations: Pick<Variation, 'status' | 'valueClaimed' | 'valueApproved' | 'costEstimate' | 'costCodeId'>[],
  valuations: Pick<Valuation, 'status' | 'periodEnd' | 'grossToDate' | 'retentionToDate' | 'netToDate' | 'valuationNo' | 'amountDue'>[],
  /** Committed, uninvoiced cost per cost code (open orders, uncertified subcontract value). */
  commitments: Map<string, string> = new Map(),
): { summary: CvrSummary; costCodes: CostCodeRow[]; monthly: CvrMonth[] } {
  const costBy = new Map<string, D>();
  for (const e of entries) costBy.set(e.costCodeId, (costBy.get(e.costCodeId) ?? new Decimal(0)).plus(d(e.amount)));

  const approved = variations.filter((v) => v.status === 'approved');
  const pending = variations.filter((v) => v.status === 'draft' || v.status === 'submitted');
  const varBudgetBy = new Map<string, D>();
  let unallocatedVarCost = new Decimal(0);
  for (const v of approved) {
    if (v.costCodeId) varBudgetBy.set(v.costCodeId, (varBudgetBy.get(v.costCodeId) ?? new Decimal(0)).plus(d(v.costEstimate)));
    else unallocatedVarCost = unallocatedVarCost.plus(d(v.costEstimate));
  }

  let originalBudget = new Decimal(0);
  let revisedBudget = new Decimal(0);
  let costToDate = new Decimal(0);
  let committedCost = new Decimal(0);
  let forecastFinal = new Decimal(0);

  const rows = codes.map((c): CostCodeRow => {
    const budget = d(c.budget);
    const varBudget = varBudgetBy.get(c.id) ?? new Decimal(0);
    const revised = budget.plus(varBudget);
    const cost = costBy.get(c.id) ?? new Decimal(0);
    const committed = d(commitments.get(c.id));
    const remaining = revised.minus(cost);
    // Money already committed will be spent even if it exceeds the budget left.
    const floor = remaining.greaterThan(0) ? remaining : new Decimal(0);
    const ctc = committed.greaterThan(floor) ? committed : floor;
    const ffc = cost.plus(ctc);
    originalBudget = originalBudget.plus(budget);
    revisedBudget = revisedBudget.plus(revised);
    costToDate = costToDate.plus(cost);
    committedCost = committedCost.plus(committed);
    forecastFinal = forecastFinal.plus(ffc);
    return {
      id: c.id,
      code: c.code,
      description: c.description,
      budget: money(budget),
      variationBudget: money(varBudget),
      revisedBudget: money(revised),
      cost: money(cost),
      committed: money(committed),
      costToComplete: money(ctc),
      forecastFinalCost: money(ffc),
      overrun: money(revised.minus(ffc)),
      usedPct: pct(cost, revised),
    };
  });
  // Approved variation cost with no cost code still has to be spent.
  revisedBudget = revisedBudget.plus(unallocatedVarCost);
  forecastFinal = forecastFinal.plus(unallocatedVarCost);

  const contractValue = d(project.contractValue);
  const approvedValue = approved.reduce((s, v) => s.plus(d(v.valueApproved)), new Decimal(0));
  const pendingValue = pending.reduce((s, v) => s.plus(d(v.valueClaimed)), new Decimal(0));
  const revisedContract = contractValue.plus(approvedValue);

  const certified = valuations
    .filter((v) => v.status === 'certified' || v.status === 'paid')
    .sort((a, b) => a.valuationNo - b.valuationNo);
  const latest = certified[certified.length - 1];
  const certifiedValue = d(latest?.grossToDate);
  const paid = certified.filter((v) => v.status === 'paid').reduce((s, v) => s.plus(d(v.amountDue)), new Decimal(0));

  const marginToDate = certifiedValue.minus(costToDate);
  const forecastMargin = revisedContract.minus(forecastFinal);

  return {
    summary: {
      contractValue: money(contractValue),
      approvedVariations: money(approvedValue),
      pendingVariations: money(pendingValue),
      revisedContractValue: money(revisedContract),
      originalBudget: money(originalBudget),
      revisedBudget: money(revisedBudget),
      costToDate: money(costToDate),
      committedCost: money(committedCost),
      certifiedValue: money(certifiedValue),
      retentionHeld: money(d(latest?.retentionToDate)),
      certifiedNet: money(d(latest?.netToDate)),
      paidToDate: money(paid),
      marginToDate: money(marginToDate),
      marginToDatePct: pct(marginToDate, certifiedValue),
      forecastFinalCost: money(forecastFinal),
      forecastMargin: money(forecastMargin),
      forecastMarginPct: pct(forecastMargin, revisedContract),
      costCompletePct: pct(costToDate, revisedBudget),
      valueCompletePct: pct(certifiedValue, revisedContract),
    },
    costCodes: rows,
    monthly: monthlySeries(entries, certified),
  };
}

/** Cumulative cost and certified value per calendar month, from the first activity to the last. */
function monthlySeries(
  entries: Pick<CostEntry, 'amount' | 'entryDate'>[],
  certified: Pick<Valuation, 'periodEnd' | 'grossToDate'>[],
): CvrMonth[] {
  const costByMonth = new Map<string, D>();
  for (const e of entries) {
    const m = String(e.entryDate).slice(0, 7);
    costByMonth.set(m, (costByMonth.get(m) ?? new Decimal(0)).plus(d(e.amount)));
  }
  const valueAt = new Map<string, D>();
  for (const v of certified) valueAt.set(String(v.periodEnd).slice(0, 7), d(v.grossToDate));

  const months = [...new Set([...costByMonth.keys(), ...valueAt.keys()])].sort();
  if (months.length === 0) return [];
  const out: CvrMonth[] = [];
  let [y, m] = months[0]!.split('-').map(Number) as [number, number];
  const last = months[months.length - 1]!;
  let cost = new Decimal(0);
  let value = new Decimal(0);
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    cost = cost.plus(costByMonth.get(key) ?? 0);
    if (valueAt.has(key)) value = valueAt.get(key)!;
    out.push({ month: key, cost: money(cost), value: money(value) });
    if (key === last) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
