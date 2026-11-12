import { BadRequestException, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx } from '@constructos/db';
import type { Principal } from '../auth/auth.types';
import { LedgerService } from '../ledger/ledger.service';
import { orderTotals } from './calc';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const qty = z.string().regex(/^\d{1,15}(\.\d{1,3})?$/, 'quantity as a decimal string');
const price = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'price as a decimal string');

export const OrderLine = z.object({
  description: z.string().trim().min(1).max(300),
  unit: z.string().trim().min(1).max(20),
  quantity: qty.refine((v) => Number(v) > 0, 'quantity must be more than zero'),
  unitPrice: price,
  vatRate: z.enum(['0', '15']).default('15'),
  projectId: z.string().uuid().nullable().optional(),
  costCodeId: z.string().uuid().nullable().optional(),
  category: z.enum(['labour', 'material', 'plant', 'subcontract', 'overhead', 'other']).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
});

export const OrderBody = z.object({
  supplierId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  orderDate: isoDate,
  requiredBy: isoDate.nullable().optional(),
  deliveryAddress: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(OrderLine).min(1).max(200),
});

export const poLabel = (n: number) => `PO-${String(n).padStart(5, '0')}`;

/** Project lines need a cost code on that project; other lines need an active expense or asset account. */
export async function validateLines(tx: Tx, lines: z.infer<typeof OrderLine>[]) {
  const codeIds = lines.map((l) => l.costCodeId).filter((x): x is string => Boolean(x));
  const codes = codeIds.length ? await tx.select().from(schema.costCodes).where(inArray(schema.costCodes.id, codeIds)) : [];
  const accountIds = lines.map((l) => l.accountId).filter((x): x is string => Boolean(x));
  const accounts = accountIds.length ? await tx.select().from(schema.accounts).where(inArray(schema.accounts.id, accountIds)) : [];
  return lines.map((l, i) => {
    const n = i + 1;
    const base = { description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate };
    if (l.projectId) {
      if (!l.costCodeId || !l.category) throw new BadRequestException(`Line ${n}: a project line needs a cost code and a category`);
      const code = codes.find((c) => c.id === l.costCodeId);
      if (!code || code.projectId !== l.projectId) throw new BadRequestException(`Line ${n}: that cost code is not on the chosen project`);
      return { ...base, projectId: l.projectId, costCodeId: l.costCodeId, category: l.category, accountId: null };
    }
    if (!l.accountId) throw new BadRequestException(`Line ${n}: choose a project cost code or an expense account`);
    const acc = accounts.find((a) => a.id === l.accountId);
    if (!acc || !acc.isActive || acc.isBank || (acc.type !== 'expense' && acc.type !== 'asset')) {
      throw new BadRequestException(`Line ${n}: choose an active expense or asset account`);
    }
    return { ...base, projectId: null, costCodeId: null, category: null, accountId: l.accountId };
  });
}

@Injectable()
export class PurchaseOrdersService {
  constructor(private readonly ledger: LedgerService) {}

  /** Create a draft order with its lines and the next PO number. */
  async insertOrder(tx: Tx, p: Principal, body: z.infer<typeof OrderBody> & { rfqId?: string | null }) {
    const [supplier] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, body.supplierId));
    if (!supplier || !supplier.isActive) throw new BadRequestException('Choose an active supplier');
    const prepared = await validateLines(tx, body.lines);
    const poNo = await this.ledger.nextNo(tx, 'purchase_order');
    const { lines: _lines, ...header } = body;
    const [po] = await tx
      .insert(schema.purchaseOrders)
      .values({ ...header, rfqId: body.rfqId ?? null, notes: body.notes ?? '', tenantId: p.tenantId, poNo, createdBy: p.userId, ...orderTotals(prepared) })
      .returning();
    await tx.insert(schema.purchaseOrderLines).values(prepared.map((l, i) => ({ ...l, tenantId: p.tenantId, poId: po!.id, lineNo: i + 1 })));
    await appendAudit(tx, {
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: po!.id,
      payload: { number: poLabel(poNo), supplier: supplier.name, total: po!.total, rfqId: body.rfqId ?? null },
    });
    return po!.id;
  }
}
