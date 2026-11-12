import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { LedgerService, ledgerError } from '../ledger/ledger.service';
import { compareQuotes } from './calc';
import { PurchaseOrdersService, poLabel } from './orders.service';

const R = schema.rfqs;
const RI = schema.rfqItems;
const RQ = schema.rfqQuotes;
const RP = schema.rfqQuotePrices;
const S = schema.suppliers;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const qty = z.string().regex(/^\d{1,15}(\.\d{1,3})?$/, 'quantity as a decimal string');
const price = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'price as a decimal string');

const RfqBody = z.object({
  title: z.string().trim().min(1).max(200),
  projectId: z.string().uuid().nullable().optional(),
  closingDate: isoDate,
  items: z.array(z.object({ description: z.string().trim().min(1).max(300), unit: z.string().trim().min(1).max(20), quantity: qty.refine((v) => Number(v) > 0) })).min(1).max(200),
});
const QuoteBody = z.object({
  supplierId: z.string().uuid(),
  quoteRef: z.string().trim().max(60).optional(),
  validUntil: isoDate.optional(),
  leadTimeDays: z.number().int().min(0).max(730).optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Item id → unit price; leave an item out if the supplier did not price it. */
  prices: z.record(z.string().uuid(), price),
});
const Award = z.object({
  quoteId: z.string().uuid(),
  note: z.string().trim().max(2000).optional(),
  /** Where the ordered items are charged. */
  costCodeId: z.string().uuid().nullable().optional(),
  category: z.enum(['labour', 'material', 'plant', 'subcontract', 'overhead', 'other']).optional(),
  accountId: z.string().uuid().nullable().optional(),
});
const Cancel = z.object({ reason: z.string().trim().min(1).max(500) });

@Controller('procurement/rfqs')
@RequiresModule('mod_procurement')
@Roles('owner', 'admin', 'project_manager', 'finance')
export class RfqsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly orders: PurchaseOrdersService,
  ) {}

  @Get()
  list(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rfqs = await tx.select().from(R).orderBy(desc(R.rfqNo)).limit(300);
      const quotes = rfqs.length ? await tx.select({ rfqId: RQ.rfqId }).from(RQ).where(inArray(RQ.rfqId, rfqs.map((r) => r.id))) : [];
      return rfqs.map((r) => ({ ...r, number: rfqLabel(r.rfqNo), quotes: quotes.filter((q) => q.rfqId === r.id).length }));
    });
  }

  @Get(':id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, id));
  }

  @Post()
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(RfqBody)) body: z.infer<typeof RfqBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const rfqNo = await this.ledger.nextNo(tx, 'rfq');
        const [r] = await tx.insert(R).values({ tenantId: p.tenantId, rfqNo, title: body.title, projectId: body.projectId ?? null, closingDate: body.closingDate, createdBy: p.userId }).returning();
        await tx.insert(RI).values(body.items.map((it, i) => ({ ...it, tenantId: p.tenantId, rfqId: r!.id, lineNo: i + 1 })));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'rfq.created', entityType: 'rfq', entityId: r!.id, payload: { number: rfqLabel(rfqNo), title: body.title, items: body.items.length } });
        return this.load(tx, r!.id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Record (or replace) a supplier's quote. */
  @Post(':id/quotes')
  async quote(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(QuoteBody)) body: z.infer<typeof QuoteBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const rfq = await this.rfq(tx, id);
        if (rfq.status !== 'open') throw new BadRequestException(`The RFQ is ${rfq.status}`);
        const items = await tx.select().from(RI).where(eq(RI.rfqId, id));
        const priced = Object.keys(body.prices);
        if (!priced.length) throw new BadRequestException('Enter at least one price');
        if (priced.some((itemId) => !items.find((i) => i.id === itemId))) throw new BadRequestException('A price refers to an item not on this RFQ');
        const [supplier] = await tx.select().from(S).where(eq(S.id, body.supplierId));
        if (!supplier) throw new BadRequestException('Unknown supplier');
        await tx.delete(RQ).where(and(eq(RQ.rfqId, id), eq(RQ.supplierId, body.supplierId)));
        const [q] = await tx
          .insert(RQ)
          .values({ tenantId: p.tenantId, rfqId: id, supplierId: body.supplierId, quoteRef: body.quoteRef ?? null, validUntil: body.validUntil ?? null, leadTimeDays: body.leadTimeDays ?? null, notes: body.notes ?? '' })
          .returning();
        await tx.insert(RP).values(priced.map((itemId) => ({ tenantId: p.tenantId, quoteId: q!.id, itemId, unitPrice: body.prices[itemId]! })));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'rfq.quote_recorded', entityType: 'rfq', entityId: id, payload: { supplier: supplier.name, quoteRef: body.quoteRef ?? null, itemsPriced: priced.length } });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Delete(':id/quotes/:quoteId')
  async removeQuote(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('quoteId', ParseUUIDPipe) quoteId: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        await tx.delete(RQ).where(and(eq(RQ.id, quoteId), eq(RQ.rfqId, id)));
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Award to one quote and draft the purchase order from its prices. Awarding
   * a quote that is not the cheapest complete one requires a note explaining why.
   */
  @Post(':id/award')
  @HttpCode(200)
  async award(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Award)) body: z.infer<typeof Award>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const full = await this.load(tx, id);
        if (full.status !== 'open') throw new BadRequestException(`The RFQ is ${full.status}`);
        const quote = full.quotes.find((q) => q.id === body.quoteId);
        if (!quote) throw new BadRequestException('Unknown quote');
        if (!quote.complete) throw new BadRequestException('This quote does not price every item');
        if (quote.rank !== 1 && !body.note) throw new BadRequestException('This is not the lowest complete quote. Note why it was chosen');
        if (full.projectId && !body.costCodeId) throw new BadRequestException('Choose the cost code the order is charged to');
        if (!full.projectId && !body.accountId) throw new BadRequestException('Choose the account the order is charged to');

        const lines = full.items.map((it) => ({
          description: it.description,
          unit: it.unit,
          quantity: it.quantity,
          unitPrice: quote.prices[it.id]!,
          vatRate: '15' as const,
          projectId: full.projectId,
          costCodeId: full.projectId ? body.costCodeId! : null,
          category: full.projectId ? (body.category ?? 'material') : null,
          accountId: full.projectId ? null : body.accountId!,
        }));
        const poId = await this.orders.insertOrder(tx, p, {
          supplierId: quote.supplierId,
          projectId: full.projectId,
          orderDate: new Date().toISOString().slice(0, 10),
          notes: `Awarded from ${full.number}${quote.quoteRef ? `, quote ${quote.quoteRef}` : ''}`,
          rfqId: id,
          lines,
        });
        await tx.update(R).set({ status: 'awarded', awardedQuoteId: quote.id, awardNote: body.note ?? null }).where(eq(R.id, id));
        const [po] = await tx.select({ poNo: schema.purchaseOrders.poNo }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'rfq.awarded',
          entityType: 'rfq',
          entityId: id,
          payload: { number: full.number, supplier: quote.supplierName, total: quote.total, rank: quote.rank, note: body.note ?? null, purchaseOrder: poLabel(po!.poNo) },
        });
        return { ...(await this.load(tx, id)), purchaseOrderId: poId };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Cancel)) body: z.infer<typeof Cancel>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const rfq = await this.rfq(tx, id);
        await tx.update(R).set({ status: 'cancelled', awardNote: body.reason }).where(eq(R.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'rfq.cancelled', entityType: 'rfq', entityId: id, payload: { number: rfqLabel(rfq.rfqNo), reason: body.reason } });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  private async rfq(tx: Tx, id: string) {
    const [r] = await tx.select().from(R).where(eq(R.id, id));
    if (!r) throw new NotFoundException('RFQ not found');
    return r;
  }

  private async load(tx: Tx, id: string) {
    const rfq = await this.rfq(tx, id);
    const [items, quotes] = await Promise.all([
      tx.select().from(RI).where(eq(RI.rfqId, id)).orderBy(asc(RI.lineNo)),
      tx.select({ q: RQ, supplierName: S.name, bbbeeLevel: S.bbbeeLevel }).from(RQ).innerJoin(S, eq(S.id, RQ.supplierId)).where(eq(RQ.rfqId, id)),
    ]);
    const prices = quotes.length ? await tx.select().from(RP).where(inArray(RP.quoteId, quotes.map((q) => q.q.id))) : [];
    const comparison = compareQuotes(items, quotes.map((q) => q.q), prices);
    return {
      ...rfq,
      number: rfqLabel(rfq.rfqNo),
      items,
      quotes: quotes
        .map(({ q, supplierName, bbbeeLevel }) => ({
          ...q,
          supplierName,
          bbbeeLevel,
          prices: Object.fromEntries(prices.filter((pr) => pr.quoteId === q.id).map((pr) => [pr.itemId, pr.unitPrice])) as Record<string, string>,
          ...comparison.find((c) => c.quoteId === q.id)!,
        }))
        .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)),
    };
  }
}

export const rfqLabel = (n: number) => `RFQ-${String(n).padStart(4, '0')}`;
