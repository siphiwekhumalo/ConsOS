import { describe, expect, it } from 'vitest';
import {
  ageing,
  autoMatch,
  balanceSheet,
  bucketFor,
  customerInvoicePosting,
  incomeStatement,
  invoiceTotals,
  parseStatementAmount,
  reverseLines,
  supplierInvoicePosting,
  toLines,
  trialBalance,
  valuationInvoiceLines,
  vatFor,
  vatSummary,
} from '../src/ledger/calc';
import { fiscalYearStart } from '../src/ledger/ledger.controller';

describe('VAT and invoice totals', () => {
  it('charges 15% per line, rounded half-up', () => {
    expect(vatFor('100.00', '15')).toBe('15.00');
    expect(vatFor('0.10', '15')).toBe('0.02'); // 0.015
    expect(vatFor('250.00', '0')).toBe('0.00');
    expect(vatFor('-1000.00', '15')).toBe('-150.00');
  });

  it('totals lines exactly', () => {
    expect(invoiceTotals([{ amount: '0.10', vatAmount: '0.02' }, { amount: '0.20', vatAmount: '0.03' }])).toEqual({ subtotal: '0.30', vatTotal: '0.05', total: '0.35' });
  });
});

describe('postings', () => {
  it('turns signed amounts into debit/credit lines and drops zeros', () => {
    expect(toLines([
      { accountId: 'bank', amount: '-115.00' },
      { accountId: 'exp', amount: '100.00' },
      { accountId: 'vat', amount: '15.00' },
      { accountId: 'x', amount: '0' },
    ])).toEqual([
      { accountId: 'bank', projectId: null, description: null, debit: '0.00', credit: '115.00' },
      { accountId: 'exp', projectId: null, description: null, debit: '100.00', credit: '0.00' },
      { accountId: 'vat', projectId: null, description: null, debit: '15.00', credit: '0.00' },
    ]);
  });

  it('refuses unbalanced or one-sided journals', () => {
    expect(() => toLines([{ accountId: 'a', amount: '10' }, { accountId: 'b', amount: '-9.99' }])).toThrow(/Unbalanced.*0\.01/);
    expect(() => toLines([{ accountId: 'a', amount: '0' }, { accountId: 'b', amount: '0' }])).toThrow(/two non-zero/);
  });

  it('reverses by swapping sides', () => {
    expect(reverseLines([{ debit: '5.00', credit: '0.00' }])).toEqual([{ debit: '0.00', credit: '5.00' }]);
  });

  it('posts a supplier invoice: Dr costs + VAT input, Cr payables', () => {
    const lines = toLines(supplierInvoicePosting({
      apControl: 'ap', vatInput: 'vi', vatTotal: '150.00', total: '1150.00',
      lines: [
        { accountId: 'mat', amount: '800.00', projectId: 'p1', description: 'Lagging' },
        { accountId: 'fees', amount: '200.00', projectId: null, description: 'Delivery' },
      ],
    }));
    expect(lines.map((l) => [l.accountId, l.debit, l.credit, l.projectId])).toEqual([
      ['mat', '800.00', '0.00', 'p1'],
      ['fees', '200.00', '0.00', null],
      ['vi', '150.00', '0.00', null],
      ['ap', '0.00', '1150.00', null],
    ]);
  });

  it('posts a customer invoice: Dr receivables, Cr revenue + VAT output; retention is a debit', () => {
    const lines = toLines(customerInvoicePosting({
      arControl: 'ar', vatOutput: 'vo', vatTotal: '142.50', total: '1092.50', projectId: 'p1',
      lines: [
        { accountId: 'rev', amount: '1000.00', description: 'Work' },
        { accountId: 'ret', amount: '-50.00', description: 'Retention' },
      ],
    }));
    expect(lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      ['ar', '1092.50', '0.00'],
      ['rev', '0.00', '1000.00'],
      ['ret', '50.00', '0.00'],
      ['vo', '0.00', '142.50'],
    ]);
  });
});

describe('valuation tax invoice', () => {
  const base = { contractRevenue: 'rev', retentionReceivable: 'ret', valuationNo: 2 };

  it('invoices the gross movement less the retention movement', () => {
    const lines = valuationInvoiceLines({ ...base, grossToDate: '300000.00', retentionToDate: '15000.00', previousGross: '200000.00', previousRetention: '10000.00' });
    expect(lines).toEqual([
      { accountId: 'rev', description: 'Valuation 2: work done this period', amount: '100000.00', vatRate: '15' },
      { accountId: 'ret', description: 'Valuation 2: retention withheld', amount: '-5000.00', vatRate: '15' },
    ]);
    // Subtotal 95 000 = the certificate's amount due (net 285 000 − previous net 190 000).
    expect(invoiceTotals(lines.map((l) => ({ amount: l.amount, vatAmount: vatFor(l.amount, l.vatRate) })))).toEqual({ subtotal: '95000.00', vatTotal: '14250.00', total: '109250.00' });
  });

  it('omits the retention line when retention has stopped (limit reached)', () => {
    const lines = valuationInvoiceLines({ ...base, grossToDate: '300000.00', retentionToDate: '10000.00', previousGross: '200000.00', previousRetention: '10000.00' });
    expect(lines).toHaveLength(1);
  });
});

const accounts = [
  { id: 'bank', code: '1000', name: 'Bank', type: 'asset' as const },
  { id: 'ar', code: '1100', name: 'Receivables', type: 'asset' as const },
  { id: 'ap', code: '2000', name: 'Payables', type: 'liability' as const },
  { id: 'cap', code: '3000', name: 'Capital', type: 'equity' as const },
  { id: 'rev', code: '4000', name: 'Revenue', type: 'income' as const },
  { id: 'mat', code: '5010', name: 'Materials', type: 'expense' as const },
  { id: 'rent', code: '6100', name: 'Rent', type: 'expense' as const },
];
// Capital 100k in; revenue 50k on credit; materials 30k on credit; rent 5k paid.
const balances = [
  { accountId: 'bank', debit: '100000.00', credit: '5000.00' },
  { accountId: 'ar', debit: '50000.00', credit: '0' },
  { accountId: 'ap', debit: '0', credit: '30000.00' },
  { accountId: 'cap', debit: '0', credit: '100000.00' },
  { accountId: 'rev', debit: '0', credit: '50000.00' },
  { accountId: 'mat', debit: '30000.00', credit: '0' },
  { accountId: 'rent', debit: '5000.00', credit: '0' },
];

describe('financial statements', () => {
  it('trial balance balances', () => {
    const tb = trialBalance(accounts, balances);
    expect(tb).toMatchObject({ totalDebit: '180000.00', totalCredit: '180000.00', balanced: true });
    expect(tb.rows.find((r) => r.id === 'bank')).toMatchObject({ debit: '95000.00', credit: '0.00' });
  });

  it('income statement splits contract costs (5xxx) from overheads', () => {
    expect(incomeStatement(accounts, balances)).toMatchObject({
      revenue: { total: '50000.00' },
      costOfSales: { total: '30000.00' },
      grossProfit: '20000.00',
      grossMarginPct: '40.0',
      operatingExpenses: { total: '5000.00' },
      netProfit: '15000.00',
    });
  });

  it('balance sheet balances with unclosed profit in equity', () => {
    expect(balanceSheet(accounts, balances)).toMatchObject({
      assets: { total: '145000.00' },
      liabilities: { total: '30000.00' },
      equity: { total: '115000.00', accumulatedProfit: '15000.00' },
      liabilitiesAndEquity: '145000.00',
      balanced: true,
    });
  });
});

describe('ageing', () => {
  it('buckets by days past due', () => {
    expect(bucketFor('2026-11-30', '2026-11-11')).toBe('current');
    expect(bucketFor('2026-11-11', '2026-11-11')).toBe('current');
    expect(bucketFor('2026-10-12', '2026-11-11')).toBe('d1_30');
    expect(bucketFor('2026-09-12', '2026-11-11')).toBe('d31_60');
    expect(bucketFor('2026-08-01', '2026-11-11')).toBe('d90_plus');
  });

  it('sums outstanding amounts per party, largest first', () => {
    const r = ageing([
      { partyId: 'a', partyName: 'A', dueDate: '2026-11-30', total: '1000.00', amountPaid: '400.00' },
      { partyId: 'a', partyName: 'A', dueDate: '2026-09-01', total: '500.00', amountPaid: '0' },
      { partyId: 'b', partyName: 'B', dueDate: '2026-10-20', total: '5000.00', amountPaid: '0' },
      { partyId: 'c', partyName: 'C', dueDate: '2026-10-20', total: '10.00', amountPaid: '10.00' },
    ], '2026-11-11');
    expect(r.rows.map((x) => [x.partyName, x.total])).toEqual([['B', '5000.00'], ['A', '1100.00']]);
    expect(r.rows[1]).toMatchObject({ current: '600.00', d61_90: '500.00' });
    expect(r.totals).toMatchObject({ current: '600.00', d1_30: '5000.00', d61_90: '500.00', total: '6100.00' });
  });
});

describe('VAT201 summary', () => {
  it('nets output against input VAT', () => {
    expect(vatSummary({
      outputVat: { accountId: 'vo', debit: '150.00', credit: '15150.00' },
      inputVat: { accountId: 'vi', debit: '4500.00', credit: '0' },
      standardRatedSupplies: '100000', zeroRatedSupplies: '0', standardRatedPurchases: '30000',
    })).toEqual({ standardRatedSupplies: '100000.00', zeroRatedSupplies: '0.00', outputVat: '15000.00', standardRatedPurchases: '30000.00', inputVat: '4500.00', netVat: '10500.00' });
  });
});

describe('bank matching', () => {
  it('matches the same amount on the closest date, one-to-one', () => {
    const m = autoMatch(
      [{ id: 's1', txnDate: '2026-11-03', amount: '-1150.00' }, { id: 's2', txnDate: '2026-11-04', amount: '-1150.00' }, { id: 's3', txnDate: '2026-11-05', amount: '-99.00' }],
      [{ id: 'l1', entryDate: '2026-11-02', amount: '-1150.00' }, { id: 'l2', entryDate: '2026-11-04', amount: '-1150.00' }, { id: 'l3', entryDate: '2026-10-01', amount: '-99.00' }],
    );
    expect(m).toEqual([{ statementLineId: 's1', journalLineId: 'l1' }, { statementLineId: 's2', journalLineId: 'l2' }]);
  });

  it('leaves ties for a person', () => {
    expect(autoMatch(
      [{ id: 's1', txnDate: '2026-11-03', amount: '500.00' }],
      [{ id: 'l1', entryDate: '2026-11-02', amount: '500.00' }, { id: 'l2', entryDate: '2026-11-04', amount: '500.00' }],
    )).toEqual([]);
  });

  it('parses amounts as printed on statements', () => {
    expect(parseStatementAmount('1 234.56')).toBe('1234.56');
    expect(parseStatementAmount('-1,234.56')).toBe('-1234.56');
    expect(parseStatementAmount('(500.00)')).toBe('-500.00');
    expect(parseStatementAmount('500.00 DR')).toBe('-500.00');
    expect(parseStatementAmount('500.00 CR')).toBe('500.00');
    expect(parseStatementAmount('0.00')).toBeNull();
    expect(parseStatementAmount('abc')).toBeNull();
  });
});

describe('financial year', () => {
  it('starts in March by default', () => {
    expect(fiscalYearStart('2026-11-11', 3)).toBe('2026-03-01');
    expect(fiscalYearStart('2027-02-28', 3)).toBe('2026-03-01');
    expect(fiscalYearStart('2026-11-11', 1)).toBe('2026-01-01');
  });
});
