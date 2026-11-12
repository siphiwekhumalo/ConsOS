import { Decimal } from '@constructos/dsl-parser';
import type { AccountType } from '@constructos/db';

/**
 * General-ledger arithmetic. Pure and decimal-only: amounts are fixed-2 strings.
 * Sign convention inside this module: positive = debit, negative = credit.
 */

type D = InstanceType<typeof Decimal>;
const d = (v: string | number | null | undefined) => new Decimal(v ?? 0);
export const money = (v: D) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const ZERO = new Decimal(0);

// ----------------------------------------------------------------- VAT & invoice totals

/** VAT on one line, rounded half-up to the cent (SARS accepts per-line rounding). */
export function vatFor(amount: string, rate: string): string {
  return money(d(amount).times(d(rate)).dividedBy(100));
}

export function invoiceTotals(lines: { amount: string; vatAmount: string }[]) {
  const subtotal = lines.reduce((s, l) => s.plus(d(l.amount)), ZERO);
  const vat = lines.reduce((s, l) => s.plus(d(l.vatAmount)), ZERO);
  return { subtotal: money(subtotal), vatTotal: money(vat), total: money(subtotal.plus(vat)) };
}

// ----------------------------------------------------------------- postings

export interface Posting {
  accountId: string;
  /** Positive = debit, negative = credit. */
  amount: string;
  projectId?: string | null;
  description?: string | null;
}

export interface JournalLineValues {
  accountId: string;
  projectId: string | null;
  description: string | null;
  debit: string;
  credit: string;
}

/** Turn signed postings into debit/credit lines, dropping zeros, and prove they balance. */
export function toLines(postings: Posting[]): JournalLineValues[] {
  const lines = postings
    .map((p) => ({ ...p, v: d(p.amount) }))
    .filter((p) => !p.v.isZero())
    .map((p) => ({
      accountId: p.accountId,
      projectId: p.projectId ?? null,
      description: p.description ?? null,
      debit: p.v.isPositive() ? money(p.v) : '0.00',
      credit: p.v.isNegative() ? money(p.v.negated()) : '0.00',
    }));
  const net = lines.reduce((s, l) => s.plus(d(l.debit)).minus(d(l.credit)), ZERO);
  if (!net.isZero()) throw new Error(`Unbalanced posting: debits exceed credits by ${money(net)}`);
  if (lines.length < 2) throw new Error('A journal needs at least two non-zero lines');
  return lines;
}

/** Swap every debit and credit: the reversal of a journal. */
export function reverseLines<T extends { debit: string; credit: string }>(lines: T[]): T[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

export interface SupplierInvoicePostingInput {
  apControl: string;
  vatInput: string;
  vatTotal: string;
  total: string;
  lines: { accountId: string; amount: string; projectId: string | null; description: string }[];
}

/** Dr expense / project cost (per line), Dr VAT input, Cr accounts payable. */
export function supplierInvoicePosting(i: SupplierInvoicePostingInput): Posting[] {
  return [
    ...i.lines.map((l) => ({ accountId: l.accountId, amount: l.amount, projectId: l.projectId, description: l.description })),
    { accountId: i.vatInput, amount: i.vatTotal, description: 'Input VAT' },
    { accountId: i.apControl, amount: money(d(i.total).negated()), description: 'Accounts payable' },
  ];
}

export interface CustomerInvoicePostingInput {
  arControl: string;
  vatOutput: string;
  vatTotal: string;
  total: string;
  projectId: string | null;
  lines: { accountId: string; amount: string; description: string }[];
}

/** Dr accounts receivable, Cr income (per line; a negative line such as retention is a debit), Cr VAT output. */
export function customerInvoicePosting(i: CustomerInvoicePostingInput): Posting[] {
  return [
    { accountId: i.arControl, amount: i.total, projectId: i.projectId, description: 'Accounts receivable' },
    ...i.lines.map((l) => ({ accountId: l.accountId, amount: money(d(l.amount).negated()), projectId: i.projectId, description: l.description })),
    { accountId: i.vatOutput, amount: money(d(i.vatTotal).negated()), description: 'Output VAT' },
  ];
}

export interface ValuationInvoiceInput {
  valuationNo: number;
  grossToDate: string;
  retentionToDate: string;
  previousGross: string;
  previousRetention: string;
  contractRevenue: string;
  retentionReceivable: string;
}

/**
 * Tax invoice lines for a payment certificate: the movement in gross value is
 * revenue; the movement in retention is held back (debit retention receivable).
 * VAT is charged on the net amount now due; retention VAT is invoiced on release.
 */
export function valuationInvoiceLines(v: ValuationInvoiceInput) {
  const grossMove = d(v.grossToDate).minus(d(v.previousGross));
  const retentionMove = d(v.retentionToDate).minus(d(v.previousRetention));
  const lines = [
    { accountId: v.contractRevenue, description: `Valuation ${v.valuationNo}: work done this period`, amount: money(grossMove), vatRate: '15' },
  ];
  if (!retentionMove.isZero()) {
    lines.push({
      accountId: v.retentionReceivable,
      description: `Valuation ${v.valuationNo}: retention ${retentionMove.isNegative() ? 'released' : 'withheld'}`,
      amount: money(retentionMove.negated()),
      vatRate: '15',
    });
  }
  return lines.filter((l) => !d(l.amount).isZero());
}

// ----------------------------------------------------------------- reports

export interface AccountRef {
  id: string;
  code: string;
  name: string;
  type: AccountType;
}

export interface Balance {
  accountId: string;
  debit: string;
  credit: string;
}

const isDebitNormal = (t: AccountType) => t === 'asset' || t === 'expense';

export function trialBalance(accounts: AccountRef[], balances: Balance[]) {
  const by = new Map(balances.map((b) => [b.accountId, b]));
  let totalDr = ZERO;
  let totalCr = ZERO;
  const rows = accounts
    .map((a) => {
      const b = by.get(a.id);
      const net = d(b?.debit).minus(d(b?.credit));
      if (net.isZero()) return null;
      if (net.isPositive()) totalDr = totalDr.plus(net);
      else totalCr = totalCr.plus(net.negated());
      return { ...a, debit: net.isPositive() ? money(net) : '0.00', credit: net.isNegative() ? money(net.negated()) : '0.00' };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  return { rows, totalDebit: money(totalDr), totalCredit: money(totalCr), balanced: totalDr.equals(totalCr) };
}

/** Balance in the account's natural direction (assets/expenses debit, others credit). */
function natural(a: AccountRef, b: Balance | undefined) {
  const net = d(b?.debit).minus(d(b?.credit));
  return isDebitNormal(a.type) ? net : net.negated();
}

/**
 * Income statement for a period. Expense accounts coded 5xxx are cost of sales
 * (contract costs); everything else is an operating expense.
 */
export function incomeStatement(accounts: AccountRef[], balances: Balance[]) {
  const by = new Map(balances.map((b) => [b.accountId, b]));
  const section = (pred: (a: AccountRef) => boolean) => {
    const rows = accounts
      .filter(pred)
      .map((a) => ({ id: a.id, code: a.code, name: a.name, amount: natural(a, by.get(a.id)) }))
      .filter((r) => !r.amount.isZero());
    const total = rows.reduce((s, r) => s.plus(r.amount), ZERO);
    return { rows: rows.map((r) => ({ ...r, amount: money(r.amount) })), total, totalS: money(total) };
  };
  const revenue = section((a) => a.type === 'income');
  const costOfSales = section((a) => a.type === 'expense' && a.code.startsWith('5'));
  const operating = section((a) => a.type === 'expense' && !a.code.startsWith('5'));
  const gross = revenue.total.minus(costOfSales.total);
  const net = gross.minus(operating.total);
  const strip = (s: typeof revenue) => ({ rows: s.rows, total: s.totalS });
  return {
    revenue: strip(revenue),
    costOfSales: strip(costOfSales),
    grossProfit: money(gross),
    grossMarginPct: revenue.total.isZero() ? null : gross.dividedBy(revenue.total).times(100).toDecimalPlaces(1).toFixed(1),
    operatingExpenses: strip(operating),
    netProfit: money(net),
  };
}

/**
 * Balance sheet as at a date. Periods are not closed into retained earnings, so
 * cumulative profit is shown as its own equity line; assets = liabilities + equity.
 */
export function balanceSheet(accounts: AccountRef[], balances: Balance[]) {
  const by = new Map(balances.map((b) => [b.accountId, b]));
  const section = (type: AccountType) => {
    const rows = accounts
      .filter((a) => a.type === type)
      .map((a) => ({ id: a.id, code: a.code, name: a.name, amount: natural(a, by.get(a.id)) }))
      .filter((r) => !r.amount.isZero());
    return { rows, total: rows.reduce((s, r) => s.plus(r.amount), ZERO) };
  };
  const assets = section('asset');
  const liabilities = section('liability');
  const equity = section('equity');
  const income = section('income').total;
  const expense = section('expense').total;
  const profit = income.minus(expense);
  const equityTotal = equity.total.plus(profit);
  const fmt = (s: ReturnType<typeof section>) => ({ rows: s.rows.map((r) => ({ ...r, amount: money(r.amount) })), total: money(s.total) });
  return {
    assets: fmt(assets),
    liabilities: fmt(liabilities),
    equity: { ...fmt(equity), accumulatedProfit: money(profit), total: money(equityTotal) },
    liabilitiesAndEquity: money(liabilities.total.plus(equityTotal)),
    balanced: assets.total.equals(liabilities.total.plus(equityTotal)),
  };
}

// ----------------------------------------------------------------- ageing

export const AGE_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function bucketFor(dueDate: string, asAt: string): AgeBucket {
  const overdue = days(dueDate, asAt);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'd1_30';
  if (overdue <= 60) return 'd31_60';
  if (overdue <= 90) return 'd61_90';
  return 'd90_plus';
}

/** Outstanding invoices by party and age (days past due). */
export function ageing(
  invoices: { partyId: string; partyName: string; dueDate: string; total: string; amountPaid: string }[],
  asAt: string,
) {
  const empty = () => Object.fromEntries(AGE_BUCKETS.map((b) => [b, ZERO])) as Record<AgeBucket, D>;
  const parties = new Map<string, { partyId: string; partyName: string; buckets: Record<AgeBucket, D> }>();
  const totals = empty();
  for (const inv of invoices) {
    const due = d(inv.total).minus(d(inv.amountPaid));
    if (due.isZero()) continue;
    const b = bucketFor(inv.dueDate, asAt);
    const p = parties.get(inv.partyId) ?? { partyId: inv.partyId, partyName: inv.partyName, buckets: empty() };
    p.buckets[b] = p.buckets[b].plus(due);
    totals[b] = totals[b].plus(due);
    parties.set(inv.partyId, p);
  }
  const fmt = (r: Record<AgeBucket, D>) => {
    const out = Object.fromEntries(AGE_BUCKETS.map((b) => [b, money(r[b])])) as Record<AgeBucket, string>;
    return { ...out, total: money(AGE_BUCKETS.reduce((s, b) => s.plus(r[b]), ZERO)) };
  };
  return {
    rows: [...parties.values()]
      .map((p) => ({ partyId: p.partyId, partyName: p.partyName, ...fmt(p.buckets) }))
      .sort((a, b) => d(b.total).comparedTo(d(a.total))),
    totals: fmt(totals),
  };
}

// ----------------------------------------------------------------- VAT201 summary

export function vatSummary(i: {
  outputVat: Balance | undefined;
  inputVat: Balance | undefined;
  standardRatedSupplies: string;
  zeroRatedSupplies: string;
  standardRatedPurchases: string;
}) {
  const output = d(i.outputVat?.credit).minus(d(i.outputVat?.debit));
  const input = d(i.inputVat?.debit).minus(d(i.inputVat?.credit));
  const net = output.minus(input);
  return {
    standardRatedSupplies: money(d(i.standardRatedSupplies)),
    zeroRatedSupplies: money(d(i.zeroRatedSupplies)),
    outputVat: money(output),
    standardRatedPurchases: money(d(i.standardRatedPurchases)),
    inputVat: money(input),
    /** Positive = payable to SARS, negative = refund due. */
    netVat: money(net),
  };
}

// ----------------------------------------------------------------- bank matching

export interface StatementLine {
  id: string;
  txnDate: string;
  amount: string;
}
export interface LedgerBankLine {
  id: string;
  entryDate: string;
  /** debit − credit on the bank account: + money in, − money out */
  amount: string;
}

/**
 * Suggest one-to-one matches: same amount, journal dated within `windowDays`
 * of the statement date. The closest date wins; ties are left for a person.
 */
export function autoMatch(statement: StatementLine[], ledger: LedgerBankLine[], windowDays = 5) {
  // Every plausible pair, closest dates first, so an exact-date pair is settled
  // before it can be taken by a looser one.
  const pairs = statement
    .flatMap((s) =>
      ledger
        .filter((l) => d(l.amount).equals(d(s.amount)))
        .map((l) => ({ s: s.id, l: l.id, gap: Math.abs(days(l.entryDate, s.txnDate)) })),
    )
    .filter((p) => p.gap <= windowDays)
    .sort((a, b) => a.gap - b.gap);
  const usedS = new Set<string>();
  const usedL = new Set<string>();
  const matches: { statementLineId: string; journalLineId: string }[] = [];
  for (const p of pairs) {
    if (usedS.has(p.s) || usedL.has(p.l)) continue;
    // Ambiguous: another still-open pair at the same distance shares this line.
    const rival = pairs.some(
      (q) => q !== p && q.gap === p.gap && !usedS.has(q.s) && !usedL.has(q.l) && (q.s === p.s || q.l === p.l),
    );
    if (rival) continue;
    usedS.add(p.s);
    usedL.add(p.l);
    matches.push({ statementLineId: p.s, journalLineId: p.l });
  }
  const order = new Map(statement.map((s, i) => [s.id, i]));
  return matches.sort((a, b) => order.get(a.statementLineId)! - order.get(b.statementLineId)!);
}

/** Parse a decimal as printed on a bank statement ("1 234.56", "-1,234.56", "1234.56 CR"). */
export function parseStatementAmount(raw: string): string | null {
  let s = raw.trim().replace(/\s/g, '').replace(/,/g, '');
  let sign = '';
  // Suffix first, before stripping the currency symbol (the R in "DR"/"CR").
  if (/CR$/i.test(s)) s = s.slice(0, -2);
  else if (/DR$/i.test(s)) { s = s.slice(0, -2); sign = '-'; }
  s = s.replace(/^(-?)R/i, '$1').replace(/^\((R)?/i, '(');
  if (/^\(.*\)$/.test(s)) { s = s.slice(1, -1); sign = '-'; }
  if (s.startsWith('-')) { s = s.slice(1); sign = sign ? '' : '-'; }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = d(`${sign}${s}`);
  return v.isZero() ? null : money(v);
}
