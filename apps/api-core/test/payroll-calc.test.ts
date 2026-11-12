import { describe, expect, it } from 'vitest';
import { ageOn, allocate, annualTax, leaveBalances, medicalCredit, monthlyPaye, payslip, sdlContribution, taxYearFor, uifContribution, workingDays } from '../src/payroll/calc';

// SARS 2025/26 (as seeded by migration 0011).
const t2026 = {
  brackets: [
    { from: 0, base: 0, rate: 18 },
    { from: 237101, base: 42678, rate: 26 },
    { from: 370501, base: 77362, rate: 31 },
    { from: 512801, base: 121475, rate: 36 },
    { from: 673001, base: 179147, rate: 39 },
    { from: 857901, base: 251258, rate: 41 },
    { from: 1817001, base: 644489, rate: 45 },
  ],
  primaryRebate: '17235.00',
  secondaryRebate: '9444.00',
  tertiaryRebate: '3145.00',
  uifCeilingMonthly: '17712.00',
  medicalCreditMain: '364.00',
  medicalCreditFirstDep: '364.00',
  medicalCreditAdditional: '246.00',
  endsOn: '2026-02-28',
};

describe('tax year and age', () => {
  it('runs March to February', () => {
    expect(taxYearFor('2025-11-25')).toBe('2025/26');
    expect(taxYearFor('2026-02-28')).toBe('2025/26');
    expect(taxYearFor('2026-03-01')).toBe('2026/27');
    expect(taxYearFor('2099-12-01')).toBe('2099/00');
  });
  it('counts whole years', () => {
    expect(ageOn('1961-03-01', '2026-02-28')).toBe(64);
    expect(ageOn('1961-02-28', '2026-02-28')).toBe(65);
  });
});

describe('PAYE (2025/26)', () => {
  it('applies the brackets and the primary rebate', () => {
    expect(annualTax('100000', t2026, 40)).toBe('765.00'); // 18 000 − 17 235
    expect(annualTax('95750', t2026, 40)).toBe('0.00'); // tax threshold under 65
    expect(annualTax('240000', t2026, 40)).toBe('26197.00'); // 42 678 + 26% × 2 900 − 17 235
    expect(annualTax('2000000', t2026, 40)).toBe('709604.00'); // 644 489 + 45% × 183 000 − 17 235
  });
  it('adds the secondary and tertiary rebates by age at the end of the tax year', () => {
    expect(annualTax('240000', t2026, 65)).toBe('16753.00');
    expect(annualTax('240000', t2026, 75)).toBe('13608.00');
  });
  it('annualises a monthly salary and deducts the medical tax credit', () => {
    expect(monthlyPaye('20000.00', t2026, 40, 0)).toBe('2183.08');
    expect(medicalCredit(2, t2026)).toBe('728.00');
    expect(medicalCredit(4, t2026)).toBe('1220.00');
    expect(monthlyPaye('20000.00', t2026, 40, 2)).toBe('1455.08');
    expect(monthlyPaye('7000.00', t2026, 40, 3)).toBe('0.00'); // credit cannot make PAYE negative
  });
  it('caps UIF at the ceiling and applies SDL only when liable', () => {
    expect(uifContribution('30000.00', '17712.00')).toBe('177.12');
    expect(uifContribution('10000.00', '17712.00')).toBe('100.00');
    expect(sdlContribution('20000.00', true)).toBe('200.00');
    expect(sdlContribution('20000.00', false)).toBe('0.00');
  });
});

describe('payslip', () => {
  const base = { dateOfBirth: '1985-06-15', period: '2025-11', hours: { normal: '0', overtime: '0', sunday: '0' }, unpaidLeaveDays: '0', monthlyHours: '195', sdlLiable: true, table: t2026 };
  const monthly = (rate: string, extra: Partial<{ startDate: string; endDate: string | null; medicalAidMembers: number }> = {}) => ({ payBasis: 'monthly' as const, rate, startDate: '2020-01-01', endDate: null, medicalAidMembers: 0, ...extra });

  it('monthly salary: gross, PAYE, UIF, SDL, net and employer cost', () => {
    expect(payslip({ ...base, employee: monthly('20000.00') })).toMatchObject({
      gross: '20000.00', paye: '2183.08', uifEmployee: '177.12', net: '17639.80', uifEmployer: '177.12', sdl: '200.00', employerCost: '20377.12',
    });
  });

  it('pro-rates a start part-way through the month', () => {
    const p = payslip({ ...base, employee: monthly('20000.00', { startDate: '2025-11-16' }) });
    expect(p.gross).toBe('10000.00'); // 15 of 30 days
    expect(p.earnings[0]!.label).toMatch(/15 of 30 days/);
  });

  it('pays overtime at 1.5× and deducts unpaid leave at the daily rate', () => {
    const p = payslip({ ...base, employee: monthly('26000.00'), hours: { normal: '0', overtime: '10', sunday: '0' }, unpaidLeaveDays: '2' });
    // hourly 26 000 / 195 = 133.333…; OT 10 × 200 = 2 000; unpaid 2 × 1 200
    expect(p.earnings.map((e) => [e.code, e.amount])).toEqual([['basic', '26000.00'], ['unpaid_leave', '-2400.00'], ['overtime', '2000.00']]);
    expect(p.gross).toBe('25600.00');
  });

  it('hourly worker: normal, overtime and Sunday time', () => {
    const p = payslip({ ...base, employee: { payBasis: 'hourly', rate: '50.00', startDate: '2020-01-01', endDate: null, medicalAidMembers: 0 }, hours: { normal: '160', overtime: '10', sunday: '8' } });
    expect(p).toMatchObject({ gross: '9550.00', paye: '282.75', uifEmployee: '95.50', net: '9171.75', hoursWorked: '178.00' });
  });
});

describe('labour cost allocation', () => {
  it('splits by hours and always adds up', () => {
    expect(allocate('1000.00', [{ key: 'a', hours: '2' }, { key: 'b', hours: '1' }])).toEqual([{ key: 'a', amount: '666.67' }, { key: 'b', amount: '333.33' }]);
    const three = allocate('100.00', [{ key: 'a', hours: '8' }, { key: 'b', hours: '8' }, { key: 'c', hours: '8' }]);
    expect(three.reduce((s, x) => s + Number(x.amount) * 100, 0)).toBe(10000);
    expect(allocate('500.00', [])).toEqual([]);
  });
});

describe('BCEA leave', () => {
  it('accrues annual leave at 1.25 days a month in the current cycle', () => {
    const b = leaveBalances('2024-01-15', '2025-11-20', [{ kind: 'annual', startsOn: '2025-06-02', days: '3' }, { kind: 'annual', startsOn: '2024-06-02', days: '5' }]);
    expect(b.find((x) => x.kind === 'annual')).toEqual({ kind: 'annual', cycleStart: '2025-01-15', entitlement: '12.5', taken: '3.0', balance: '9.5' });
    expect(b.find((x) => x.kind === 'sick')).toMatchObject({ cycleStart: '2024-01-15', entitlement: '30.0' });
    expect(b.find((x) => x.kind === 'family_responsibility')).toMatchObject({ entitlement: '3.0' });
  });
  it('gives no family responsibility leave in the first four months', () => {
    expect(leaveBalances('2025-09-01', '2025-11-20', []).find((x) => x.kind === 'family_responsibility')!.entitlement).toBe('0.0');
  });
  it('counts Monday to Friday', () => {
    expect(workingDays('2025-11-17', '2025-11-23')).toBe(5);
  });
});
