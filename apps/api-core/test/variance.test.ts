import { describe, expect, it } from 'vitest';
import type { EstimateLine } from '@constructos/db';
import { analyse, parseAmount } from '../src/commercial/variance';

let n = 0;
const line = (p: Partial<EstimateLine>): EstimateLine =>
  ({
    id: `l${++n}`,
    tenantId: 't',
    estimateId: 'e',
    lineNo: String(n),
    description: 'x',
    unit: 'm',
    clientQty: null,
    clientRate: null,
    internalQty: null,
    internalRate: null,
    source: 'manual',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  }) as EstimateLine;

describe('estimate variance analysis', () => {
  it('matches exactly when client and internal agree', () => {
    const r = analyse([line({ clientQty: '120', clientRate: '450.00', internalQty: '120', internalRate: '450.00' })]);
    expect(r.lines[0]!.flags).toEqual([]);
    expect(r.summary).toMatchObject({ clientTotal: '54000.00', internalTotal: '54000.00', margin: '0.00', leakage: '0.00', flaggedLines: 0 });
  });

  it('flags under-recovery when internal takeoff exceeds client quantity', () => {
    const r = analyse([line({ clientQty: '120', clientRate: '450.00', internalQty: '132', internalRate: '450.00' })]);
    expect(r.lines[0]!.flags).toEqual(['qty_mismatch', 'under_recovery']);
    expect(r.lines[0]!.margin).toBe('-5400.00');
    expect(r.summary.leakage).toBe('5400.00');
  });

  it('flags rate variance beyond 2% but not within it', () => {
    const within = analyse([line({ clientQty: '10', clientRate: '100.00', internalQty: '10', internalRate: '98.50' })]);
    expect(within.lines[0]!.flags).toEqual([]);
    const beyond = analyse([line({ clientQty: '10', clientRate: '100.00', internalQty: '10', internalRate: '90.00' })]);
    expect(beyond.lines[0]!.flags).toEqual(['rate_variance']);
    expect(beyond.summary.marginPct).toBe('10.0');
  });

  it('flags scope the client has not priced as leakage, and unassessed client scope', () => {
    const r = analyse([
      line({ internalQty: '4', internalRate: '2500.00' }),
      line({ clientQty: '1', clientRate: '250000.00' }),
    ]);
    expect(r.lines[0]!.flags).toEqual(['missing_client', 'under_recovery']);
    expect(r.lines[1]!.flags).toEqual(['missing_internal']);
    expect(r.summary).toMatchObject({ leakage: '10000.00', flaggedLines: 2 });
    expect(r.summary.flagCounts).toMatchObject({ missing_client: 1, missing_internal: 1, under_recovery: 1 });
  });

  it('uses exact decimal arithmetic', () => {
    const r = analyse([line({ clientQty: '0.1', clientRate: '0.30', internalQty: '0.1', internalRate: '0.30' })]);
    expect(r.summary.clientTotal).toBe('0.03');
  });

  it('parses amounts as printed on tenders', () => {
    expect(parseAmount('1 200')).toBe('1200');
    expect(parseAmount('102,600.00')).toBe('102600.00');
    expect(parseAmount('R 85.50')).toBe('85.50');
    expect(parseAmount('Rate only')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});
