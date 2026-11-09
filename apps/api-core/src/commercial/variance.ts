import { Decimal } from '@constructos/dsl-parser';
import type { EstimateLine } from '@constructos/db';

/**
 * Line-by-line comparison of the client's figures against internal takeoffs.
 * Pure decimal arithmetic: amounts are returned as fixed-2 strings.
 *
 * Flags (any line may carry several):
 *   missing_internal  client line not yet measured/priced internally (scope not assessed)
 *   missing_client    internal scope the client has not priced (unpaid work risk)
 *   qty_mismatch      quantities differ
 *   rate_variance     rates differ by more than RATE_TOLERANCE
 *   under_recovery    internal amount exceeds what the client will pay (margin leakage)
 */
export const RATE_TOLERANCE = new Decimal('0.02');

export type Flag = 'missing_internal' | 'missing_client' | 'qty_mismatch' | 'rate_variance' | 'under_recovery';

export interface LineView {
  id: string;
  lineNo: string;
  description: string;
  unit: string;
  source: string;
  clientQty: string | null;
  clientRate: string | null;
  clientAmount: string | null;
  internalQty: string | null;
  internalRate: string | null;
  internalAmount: string | null;
  /** client − internal; negative = leakage */
  margin: string | null;
  flags: Flag[];
}

export interface EstimateSummary {
  clientTotal: string;
  internalTotal: string;
  margin: string;
  marginPct: string | null;
  /** Sum of every rand where internal exceeds what the client pays. */
  leakage: string;
  lines: number;
  flaggedLines: number;
  flagCounts: Record<Flag, number>;
}

const dec = (v: string | null) => (v === null ? null : new Decimal(v));
const money = (d: InstanceType<typeof Decimal>) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function analyse(lines: EstimateLine[]): { lines: LineView[]; summary: EstimateSummary } {
  let clientTotal = new Decimal(0);
  let internalTotal = new Decimal(0);
  let leakage = new Decimal(0);
  const flagCounts: Record<Flag, number> = {
    missing_internal: 0,
    missing_client: 0,
    qty_mismatch: 0,
    rate_variance: 0,
    under_recovery: 0,
  };

  const views = lines.map((l): LineView => {
    const cq = dec(l.clientQty);
    const cr = dec(l.clientRate);
    const iq = dec(l.internalQty);
    const ir = dec(l.internalRate);
    const ca = cq && cr ? cq.times(cr) : null;
    const ia = iq && ir ? iq.times(ir) : null;
    const flags: Flag[] = [];

    if (ca && !ia) flags.push('missing_internal');
    if (ia && !ca) flags.push('missing_client');
    if (cq && iq && !cq.equals(iq)) flags.push('qty_mismatch');
    if (cr && ir && !cr.isZero() && ir.minus(cr).abs().dividedBy(cr).greaterThan(RATE_TOLERANCE)) flags.push('rate_variance');
    const lineLeak = (ia ?? new Decimal(0)).minus(ca ?? new Decimal(0));
    if (ia && lineLeak.greaterThan(0)) {
      flags.push('under_recovery');
      leakage = leakage.plus(lineLeak);
    }

    if (ca) clientTotal = clientTotal.plus(ca);
    if (ia) internalTotal = internalTotal.plus(ia);
    flags.forEach((f) => flagCounts[f]++);

    return {
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      unit: l.unit,
      source: l.source,
      clientQty: l.clientQty,
      clientRate: l.clientRate,
      clientAmount: ca ? money(ca) : null,
      internalQty: l.internalQty,
      internalRate: l.internalRate,
      internalAmount: ia ? money(ia) : null,
      margin: ca || ia ? money((ca ?? new Decimal(0)).minus(ia ?? new Decimal(0))) : null,
      flags,
    };
  });

  const margin = clientTotal.minus(internalTotal);
  return {
    lines: views,
    summary: {
      clientTotal: money(clientTotal),
      internalTotal: money(internalTotal),
      margin: money(margin),
      marginPct: clientTotal.isZero() ? null : margin.dividedBy(clientTotal).times(100).toDecimalPlaces(1).toFixed(1),
      leakage: money(leakage),
      lines: views.length,
      flaggedLines: views.filter((v) => v.flags.length > 0).length,
      flagCounts,
    },
  };
}

/** Parse a number as printed on a tender ("1 200", "102,600.00", "R 85.50"); null if not a number. */
export function parseAmount(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const cleaned = v.replace(/[\sR]/g, '').replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}
