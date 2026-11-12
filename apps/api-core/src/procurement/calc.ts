import { Decimal } from '@constructos/dsl-parser';
import type { UserRole } from '@constructos/db';

/** Procurement arithmetic. Pure and decimal-only: amounts are fixed-2 strings. */

type D = InstanceType<typeof Decimal>;
const d = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const money = (v: D) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const qty = (v: D) => v.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);
const ZERO = new Decimal(0);

// ----------------------------------------------------------------- orders

export const lineAmount = (quantity: string, unitPrice: string) => money(d(quantity).times(d(unitPrice)));

export function orderTotals(lines: { quantity: string; unitPrice: string; vatRate: string }[]) {
  let subtotal = ZERO;
  let vat = ZERO;
  for (const l of lines) {
    const amount = d(lineAmount(l.quantity, l.unitPrice));
    subtotal = subtotal.plus(amount);
    vat = vat.plus(d(money(amount.times(d(l.vatRate)).dividedBy(100))));
  }
  return { subtotal: money(subtotal), vatTotal: money(vat), total: money(subtotal.plus(vat)) };
}

/**
 * Who may approve an order: finance and leadership always; a project manager
 * only up to the tenant's limit (excl. VAT). Nobody approves their own order
 * unless they are the owner.
 */
export function canApproveOrder(role: UserRole, subtotal: string, pmLimit: string, isRequester: boolean): { ok: boolean; reason?: string } {
  if (isRequester && role !== 'owner') return { ok: false, reason: 'You cannot approve an order you raised' };
  if (role === 'owner' || role === 'admin' || role === 'finance') return { ok: true };
  if (role === 'project_manager') {
    return d(subtotal).lessThanOrEqualTo(d(pmLimit))
      ? { ok: true }
      : { ok: false, reason: `Orders over R${money(d(pmLimit))} excl. VAT need finance or an administrator to approve` };
  }
  return { ok: false, reason: 'Your role cannot approve orders' };
}

export interface OrderLineProgress {
  ordered: string;
  received: string;
  invoiced: string;
  /** Received but not yet invoiced: what the next invoice may bill. */
  toInvoice: string;
  /** Still to be delivered. */
  outstanding: string;
}

export function lineProgress(ordered: string, received: string, invoiced: string): OrderLineProgress {
  const o = d(ordered);
  const r = d(received);
  const i = d(invoiced);
  const toInvoice = r.minus(i);
  const outstanding = o.minus(r);
  return {
    ordered: qty(o),
    received: qty(r),
    invoiced: qty(i),
    toInvoice: qty(toInvoice.isNegative() ? ZERO : toInvoice),
    outstanding: qty(outstanding.isNegative() ? ZERO : outstanding),
  };
}

/**
 * Money committed but not yet invoiced on an order line (excl. VAT). A closed
 * or cancelled order commits nothing further.
 */
export function lineCommitment(status: string, quantity: string, unitPrice: string, invoicedAmount: string): string {
  if (status !== 'approved') return '0.00';
  const left = d(lineAmount(quantity, unitPrice)).minus(d(invoicedAmount));
  return money(left.isNegative() ? ZERO : left);
}

// ----------------------------------------------------------------- RFQ comparison

export interface QuoteComparison {
  quoteId: string;
  total: string;
  /** Priced every item on the RFQ. */
  complete: boolean;
  /** Items where this quote is the lowest price. */
  lowestOn: number;
  rank: number | null;
}

/** Total each quote across the RFQ items and rank the complete ones, cheapest first. */
export function compareQuotes(
  items: { id: string; quantity: string }[],
  quotes: { id: string }[],
  prices: { quoteId: string; itemId: string; unitPrice: string }[],
): QuoteComparison[] {
  const priceOf = (q: string, i: string) => prices.find((p) => p.quoteId === q && p.itemId === i)?.unitPrice;
  const lowest = new Map<string, D>();
  for (const it of items) {
    for (const q of quotes) {
      const p = priceOf(q.id, it.id);
      if (p === undefined) continue;
      const cur = lowest.get(it.id);
      if (!cur || d(p).lessThan(cur)) lowest.set(it.id, d(p));
    }
  }
  const rows = quotes.map((q) => {
    let total = ZERO;
    let complete = true;
    let lowestOn = 0;
    for (const it of items) {
      const p = priceOf(q.id, it.id);
      if (p === undefined) {
        complete = false;
        continue;
      }
      total = total.plus(d(lineAmount(it.quantity, p)));
      if (lowest.get(it.id)?.equals(d(p))) lowestOn++;
    }
    return { quoteId: q.id, total: money(total), complete, lowestOn, rank: null as number | null };
  });
  rows
    .filter((r) => r.complete)
    .sort((a, b) => d(a.total).comparedTo(d(b.total)))
    .forEach((r, i) => (r.rank = i + 1));
  return rows;
}

// ----------------------------------------------------------------- subcontract certificates

export function subcontractCertificate(i: {
  workDoneToDate: string;
  retentionPct: string;
  retentionLimitPct: string;
  contractValue: string;
  previousGross: string;
  previousRetention: string;
}) {
  const gross = d(i.workDoneToDate);
  let retention = gross.times(d(i.retentionPct)).dividedBy(100);
  const cap = d(i.contractValue).times(d(i.retentionLimitPct)).dividedBy(100);
  if (retention.greaterThan(cap)) retention = cap;
  const retentionS = money(retention);
  const net = gross.minus(d(retentionS));
  const previouslyCertified = d(i.previousGross).minus(d(i.previousRetention));
  return {
    workDoneToDate: money(gross),
    retentionToDate: retentionS,
    netToDate: money(net),
    previousGross: money(d(i.previousGross)),
    previousRetention: money(d(i.previousRetention)),
    previouslyCertified: money(previouslyCertified),
    amountDue: money(net.minus(previouslyCertified)),
    /** Movement this period: the cost to the project, and the retention held back. */
    grossMovement: money(gross.minus(d(i.previousGross))),
    retentionMovement: money(d(retentionS).minus(d(i.previousRetention))),
  };
}

// ----------------------------------------------------------------- B-BBEE

/** Procurement recognition levels under the amended Codes of Good Practice. */
export const BBBEE_RECOGNITION: Record<number, number> = { 1: 135, 2: 125, 3: 110, 4: 100, 5: 80, 6: 60, 7: 50, 8: 10 };

/** A level only counts while its certificate is valid on the date of the spend. */
export function recognitionPct(level: number | null, expiry: string | null, asAt: string): number {
  if (!level) return 0;
  if (expiry && expiry < asAt) return 0;
  return BBBEE_RECOGNITION[level] ?? 0;
}

export function bbbeeSpend(rows: { supplierId: string; supplierName: string; level: number | null; expiry: string | null; spend: string }[], asAt: string) {
  let total = ZERO;
  let recognised = ZERO;
  const byLevel = new Map<string, { spend: D; recognised: D }>();
  const suppliers = rows.map((r) => {
    const pct = recognitionPct(r.level, r.expiry, asAt);
    const rec = d(r.spend).times(pct).dividedBy(100);
    total = total.plus(d(r.spend));
    recognised = recognised.plus(rec);
    const key = pct === 0 ? 'Non-compliant or expired' : `Level ${r.level}`;
    const b = byLevel.get(key) ?? { spend: ZERO, recognised: ZERO };
    byLevel.set(key, { spend: b.spend.plus(d(r.spend)), recognised: b.recognised.plus(rec) });
    return { ...r, recognitionPct: pct, recognised: money(rec), spend: money(d(r.spend)) };
  });
  return {
    suppliers: suppliers.sort((a, b) => d(b.spend).comparedTo(d(a.spend))),
    byLevel: [...byLevel.entries()].map(([level, v]) => ({ level, spend: money(v.spend), recognised: money(v.recognised) })),
    totalSpend: money(total),
    recognisedSpend: money(recognised),
    recognisedPct: total.isZero() ? null : recognised.dividedBy(total).times(100).toDecimalPlaces(1).toFixed(1),
  };
}
