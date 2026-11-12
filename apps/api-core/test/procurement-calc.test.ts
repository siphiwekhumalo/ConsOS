import { describe, expect, it } from 'vitest';
import type { CostCode } from '@constructos/db';
import {
  bbbeeSpend,
  canApproveOrder,
  compareQuotes,
  lineCommitment,
  lineProgress,
  orderTotals,
  recognitionPct,
  subcontractCertificate,
} from '../src/procurement/calc';
import { cvr } from '../src/controls/calc';

describe('purchase orders', () => {
  it('totals lines exactly, VAT per line', () => {
    expect(orderTotals([
      { quantity: '120.5', unitPrice: '85.40', vatRate: '15' }, // 10 290.70
      { quantity: '1', unitPrice: '0.10', vatRate: '15' },
      { quantity: '2', unitPrice: '500.00', vatRate: '0' },
    ])).toEqual({ subtotal: '11290.80', vatTotal: '1543.63', total: '12834.43' }); // 1543.605 → 1543.61, 0.015 → 0.02
  });

  it('applies approval limits by role', () => {
    expect(canApproveOrder('project_manager', '50000.00', '50000', false)).toEqual({ ok: true });
    expect(canApproveOrder('project_manager', '50000.01', '50000', false).ok).toBe(false);
    expect(canApproveOrder('finance', '9000000.00', '50000', false)).toEqual({ ok: true });
    expect(canApproveOrder('site_foreman', '10.00', '50000', false).ok).toBe(false);
    expect(canApproveOrder('finance', '10.00', '50000', true)).toMatchObject({ ok: false, reason: expect.stringMatching(/you raised/) });
    expect(canApproveOrder('owner', '10.00', '50000', true)).toEqual({ ok: true });
  });

  it('tracks received, invoiced and outstanding quantities', () => {
    expect(lineProgress('100', '60', '40')).toEqual({ ordered: '100.000', received: '60.000', invoiced: '40.000', toInvoice: '20.000', outstanding: '40.000' });
    expect(lineProgress('10', '10', '10')).toMatchObject({ toInvoice: '0.000', outstanding: '0.000' });
  });

  it('commits the uninvoiced value of approved orders only', () => {
    expect(lineCommitment('approved', '100', '50.00', '2000.00')).toBe('3000.00');
    expect(lineCommitment('approved', '100', '50.00', '6000.00')).toBe('0.00');
    expect(lineCommitment('closed', '100', '50.00', '0')).toBe('0.00');
    expect(lineCommitment('submitted', '100', '50.00', '0')).toBe('0.00');
  });
});

describe('RFQ comparison', () => {
  const items = [{ id: 'i1', quantity: '10' }, { id: 'i2', quantity: '2' }];
  it('ranks complete quotes by total and counts lowest prices', () => {
    const r = compareQuotes(items, [{ id: 'A' }, { id: 'B' }, { id: 'C' }], [
      { quoteId: 'A', itemId: 'i1', unitPrice: '100.00' }, { quoteId: 'A', itemId: 'i2', unitPrice: '50.00' }, // 1100
      { quoteId: 'B', itemId: 'i1', unitPrice: '90.00' }, { quoteId: 'B', itemId: 'i2', unitPrice: '200.00' }, // 1300
      { quoteId: 'C', itemId: 'i1', unitPrice: '80.00' }, // incomplete
    ]);
    expect(r.find((x) => x.quoteId === 'A')).toMatchObject({ total: '1100.00', complete: true, rank: 1, lowestOn: 1 });
    expect(r.find((x) => x.quoteId === 'B')).toMatchObject({ total: '1300.00', rank: 2, lowestOn: 0 });
    expect(r.find((x) => x.quoteId === 'C')).toMatchObject({ complete: false, rank: null, lowestOn: 1 });
  });
});

describe('subcontract certificates', () => {
  const base = { retentionPct: '10.00', retentionLimitPct: '5.00', contractValue: '1000000.00' };
  it('first certificate', () => {
    expect(subcontractCertificate({ ...base, workDoneToDate: '200000.00', previousGross: '0', previousRetention: '0' })).toMatchObject({
      retentionToDate: '20000.00', netToDate: '180000.00', previouslyCertified: '0.00', amountDue: '180000.00', grossMovement: '200000.00', retentionMovement: '20000.00',
    });
  });
  it('caps retention at the limit, so later movements carry no retention', () => {
    const c = subcontractCertificate({ ...base, workDoneToDate: '700000.00', previousGross: '500000.00', previousRetention: '50000.00' });
    expect(c).toMatchObject({ retentionToDate: '50000.00', netToDate: '650000.00', previouslyCertified: '450000.00', amountDue: '200000.00', retentionMovement: '0.00' });
  });
});

describe('B-BBEE procurement recognition', () => {
  it('recognises spend by level, only while the certificate is valid', () => {
    expect(recognitionPct(1, '2027-01-01', '2026-11-11')).toBe(135);
    expect(recognitionPct(1, '2026-01-01', '2026-11-11')).toBe(0);
    expect(recognitionPct(null, null, '2026-11-11')).toBe(0);
    const r = bbbeeSpend([
      { supplierId: 'a', supplierName: 'A', level: 1, expiry: null, spend: '100000.00' },
      { supplierId: 'b', supplierName: 'B', level: 4, expiry: null, spend: '50000.00' },
      { supplierId: 'c', supplierName: 'C', level: null, expiry: null, spend: '50000.00' },
    ], '2026-11-11');
    expect(r).toMatchObject({ totalSpend: '200000.00', recognisedSpend: '185000.00', recognisedPct: '92.5' });
    expect(r.byLevel.find((x) => x.level === 'Non-compliant or expired')).toMatchObject({ spend: '50000.00', recognised: '0.00' });
  });
});

describe('CVR with commitments', () => {
  const code = (id: string, budget: string) => ({ id, tenantId: 't', projectId: 'p', code: id, description: id, budget, createdAt: new Date(), updatedAt: new Date() }) as CostCode;
  it('forecasts at least what is already committed', () => {
    const r = cvr({ contractValue: '500000.00' }, [code('A', '100000.00'), code('B', '100000.00')],
      [{ costCodeId: 'A', amount: '20000.00', entryDate: '2026-11-01' }], [], [],
      new Map([['A', '120000.00'], ['B', '30000.00']]));
    const [a, b] = r.costCodes;
    // A: 80k budget left but 120k committed → forecast 140k, 40k over.
    expect(a).toMatchObject({ committed: '120000.00', costToComplete: '120000.00', forecastFinalCost: '140000.00', overrun: '-40000.00' });
    // B: committed below the budget left → forecast stays at budget.
    expect(b).toMatchObject({ committed: '30000.00', costToComplete: '100000.00', overrun: '0.00' });
    expect(r.summary).toMatchObject({ committedCost: '150000.00', forecastFinalCost: '240000.00' });
  });
});
