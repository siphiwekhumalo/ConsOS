import { describe, expect, it } from 'vitest';
import type { CostCode } from '@constructos/db';
import { cvr, timeBarDaysLeft, valuationFigures } from '../src/controls/calc';

const code = (id: string, budget: string): CostCode =>
  ({ id, tenantId: 't', projectId: 'p', code: id, description: id, budget, createdAt: new Date(), updatedAt: new Date() }) as CostCode;

describe('valuation figures', () => {
  const base = { materialsOnSite: '0', retentionPct: '5.00', retentionLimitPct: '5.00', contractValue: '10000000.00', previouslyCertified: '0' };

  it('computes gross, retention, net and amount due', () => {
    expect(valuationFigures({ ...base, workDoneToDate: '1000000.00', materialsOnSite: '50000.00' })).toEqual({
      grossToDate: '1050000.00',
      retentionToDate: '52500.00',
      netToDate: '997500.00',
      amountDue: '997500.00',
    });
  });

  it('deducts what was previously certified', () => {
    const f = valuationFigures({ ...base, workDoneToDate: '1000000.00', previouslyCertified: '500000.00' });
    expect(f.amountDue).toBe('450000.00');
  });

  it('caps retention at the limit of the contract value', () => {
    const f = valuationFigures({ ...base, contractValue: '1000000.00', workDoneToDate: '1200000.00' });
    expect(f.retentionToDate).toBe('50000.00');
    expect(f.netToDate).toBe('1150000.00');
  });

  it('applies no cap when the contract value is unknown, and rounds half up', () => {
    const f = valuationFigures({ ...base, contractValue: null, workDoneToDate: '0.30', retentionPct: '5.00' });
    expect(f.retentionToDate).toBe('0.02'); // 0.015 → 0.02
    expect(f.netToDate).toBe('0.28');
  });

  it('can produce a negative amount due when the certifier values work down', () => {
    const f = valuationFigures({ ...base, workDoneToDate: '400000.00', previouslyCertified: '475000.00' });
    expect(f.amountDue).toBe('-95000.00');
  });
});

describe('variation time bar', () => {
  const today = new Date('2026-11-11T10:00:00Z');
  it('counts the days left on a draft variation', () => {
    expect(timeBarDaysLeft({ status: 'draft', notifiedOn: '2026-11-01', timeBarDays: 56 }, today)).toBe(46);
  });
  it('goes negative once the time bar has passed', () => {
    expect(timeBarDaysLeft({ status: 'draft', notifiedOn: '2026-09-01', timeBarDays: 56 }, today)).toBe(-15);
  });
  it('does not apply once submitted, or without a notice period', () => {
    expect(timeBarDaysLeft({ status: 'submitted', notifiedOn: '2026-11-01', timeBarDays: 56 }, today)).toBeNull();
    expect(timeBarDaysLeft({ status: 'draft', notifiedOn: '2026-11-01', timeBarDays: null }, today)).toBeNull();
  });
});

describe('cost-value reconciliation', () => {
  const r = cvr(
    { contractValue: '200000.00' },
    [code('A', '100000.00'), code('B', '50000.00')],
    [
      { costCodeId: 'A', amount: '60000.00', entryDate: '2026-01-15' },
      { costCodeId: 'B', amount: '70000.00', entryDate: '2026-03-02' },
    ],
    [
      { status: 'approved', valueClaimed: '25000.00', valueApproved: '20000.00', costEstimate: '15000.00', costCodeId: 'A' },
      { status: 'submitted', valueClaimed: '5000.00', valueApproved: null, costEstimate: '3000.00', costCodeId: null },
      { status: 'rejected', valueClaimed: '9000.00', valueApproved: null, costEstimate: '1.00', costCodeId: 'B' },
    ],
    [
      { status: 'certified', valuationNo: 1, periodEnd: '2026-02-28', grossToDate: '150000.00', retentionToDate: '7500.00', netToDate: '142500.00', amountDue: '142500.00' },
      { status: 'draft', valuationNo: 2, periodEnd: '2026-03-31', grossToDate: '190000.00', retentionToDate: '9500.00', netToDate: '180500.00', amountDue: '38000.00' },
    ],
  );

  it('revises budget and contract value with approved variations only', () => {
    expect(r.summary).toMatchObject({
      contractValue: '200000.00',
      approvedVariations: '20000.00',
      pendingVariations: '5000.00',
      revisedContractValue: '220000.00',
      originalBudget: '150000.00',
      revisedBudget: '165000.00',
    });
  });

  it('uses the latest certified valuation as value, ignoring drafts', () => {
    expect(r.summary).toMatchObject({
      certifiedValue: '150000.00',
      retentionHeld: '7500.00',
      costToDate: '130000.00',
      marginToDate: '20000.00',
      marginToDatePct: '13.3',
      paidToDate: '0.00',
    });
  });

  it('forecasts final cost per cost code and flags overruns', () => {
    const [a, b] = r.costCodes;
    expect(a).toMatchObject({ revisedBudget: '115000.00', cost: '60000.00', costToComplete: '55000.00', forecastFinalCost: '115000.00', overrun: '0.00' });
    expect(b).toMatchObject({ revisedBudget: '50000.00', cost: '70000.00', costToComplete: '0.00', forecastFinalCost: '70000.00', overrun: '-20000.00', usedPct: '140.0' });
    expect(r.summary).toMatchObject({ forecastFinalCost: '185000.00', forecastMargin: '35000.00', forecastMarginPct: '15.9' });
  });

  it('builds a cumulative monthly series with no gaps', () => {
    expect(r.monthly).toEqual([
      { month: '2026-01', cost: '60000.00', value: '0.00' },
      { month: '2026-02', cost: '60000.00', value: '150000.00' },
      { month: '2026-03', cost: '130000.00', value: '150000.00' },
    ]);
  });

  it('handles an empty project', () => {
    const empty = cvr({ contractValue: null }, [], [], [], []);
    expect(empty.summary).toMatchObject({ costToDate: '0.00', marginToDatePct: null, forecastMarginPct: null });
    expect(empty.monthly).toEqual([]);
  });
});
