import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { schema, type Tx } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { lineCommitment } from './calc';

const POL = schema.purchaseOrderLines;
const PO = schema.purchaseOrders;
const SIL = schema.supplierInvoiceLines;
const SI = schema.supplierInvoices;
const SC = schema.subcontracts;
const SCC = schema.subcontractCertificates;

/**
 * Committed, not-yet-invoiced cost per cost code (excl. VAT):
 *   open approved order lines − what has been invoiced against them, plus
 *   active subcontract value − the gross certified so far.
 * Optionally limited to one project.
 */
export async function commitmentsByCostCode(tx: Tx, projectId?: string): Promise<Map<string, string>> {
  const out = new Map<string, InstanceType<typeof Decimal>>();
  const add = (code: string, v: string) => out.set(code, (out.get(code) ?? new Decimal(0)).plus(v));

  const lines = await tx
    .select({ id: POL.id, costCodeId: POL.costCodeId, quantity: POL.quantity, unitPrice: POL.unitPrice, status: PO.status })
    .from(POL)
    .innerJoin(PO, eq(PO.id, POL.poId))
    .where(and(eq(PO.status, 'approved'), isNotNull(POL.costCodeId), projectId ? eq(POL.projectId, projectId) : undefined));
  if (lines.length) {
    const invoiced = await tx
      .select({ poLineId: SIL.poLineId, amount: sql<string>`coalesce(sum(${SIL.amount}), 0)::numeric(18,2)::text` })
      .from(SIL)
      .innerJoin(SI, eq(SI.id, SIL.invoiceId))
      .where(and(inArray(SIL.poLineId, lines.map((l) => l.id)), inArray(SI.status, ['approved', 'part_paid', 'paid'])))
      .groupBy(SIL.poLineId);
    const inv = new Map(invoiced.map((r) => [r.poLineId, r.amount]));
    for (const l of lines) add(l.costCodeId!, lineCommitment(l.status, l.quantity, l.unitPrice, inv.get(l.id) ?? '0'));
  }

  const subs = await tx
    .select()
    .from(SC)
    .where(and(eq(SC.status, 'active'), projectId ? eq(SC.projectId, projectId) : undefined));
  if (subs.length) {
    const certified = await tx
      .select({ subcontractId: SCC.subcontractId, gross: sql<string>`max(${SCC.workDoneToDate})::text` })
      .from(SCC)
      .where(and(inArray(SCC.subcontractId, subs.map((s) => s.id)), eq(SCC.status, 'certified')))
      .groupBy(SCC.subcontractId);
    const gross = new Map(certified.map((c) => [c.subcontractId, c.gross]));
    for (const s of subs) {
      const left = new Decimal(s.contractValue).minus(gross.get(s.id) ?? 0);
      if (left.isPositive()) add(s.costCodeId, left.toFixed(2));
    }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, v.toFixed(2)]));
}
