import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx, type UserRole } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { LedgerService, ledgerError } from '../ledger/ledger.service';
import { vatFor, invoiceTotals } from '../ledger/calc';
import { bbbeeSpend, canApproveOrder, lineAmount, lineCommitment, lineProgress, orderTotals } from './calc';
import { OrderBody, PurchaseOrdersService, poLabel, validateLines } from './orders.service';
import { SupplierBody } from '../ledger/payables.controller';

const PO = schema.purchaseOrders;
const POL = schema.purchaseOrderLines;
const GR = schema.goodsReceipts;
const GRL = schema.goodsReceiptLines;
const S = schema.suppliers;
const SI = schema.supplierInvoices;
const SIL = schema.supplierInvoiceLines;
const PS = schema.procurementSettings;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const qty = z.string().regex(/^\d{1,15}(\.\d{1,3})?$/, 'quantity as a decimal string');
const price = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'price as a decimal string');

const Transition = z.object({
  to: z.enum(['draft', 'submitted', 'approved', 'closed', 'cancelled']),
  reason: z.string().trim().max(500).optional(),
});
const Receive = z.object({
  receivedOn: isoDate,
  deliveryNote: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(2000).optional(),
  // Zero lines (already fully received) are skipped; at least one line must be more than zero.
  lines: z.array(z.object({ poLineId: z.string().uuid(), quantity: qty })).min(1),
});
const InvoiceFromOrder = z.object({
  invoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: isoDate,
  lines: z.array(z.object({ poLineId: z.string().uuid(), quantity: qty, unitPrice: price.optional() })).min(1),
});
const Settings = z.object({ pmApprovalLimit: price, priceTolerancePct: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/) }).partial();

/** Anyone who runs a job can raise a requisition, including site foremen. */
const REQUESTERS: UserRole[] = ['owner', 'admin', 'project_manager', 'finance', 'site_foreman'];
const BUYERS: UserRole[] = ['owner', 'admin', 'project_manager', 'finance'];
const today = () => new Date().toISOString().slice(0, 10);

@Controller('procurement')
@RequiresModule('mod_procurement')
@Roles(...REQUESTERS)
export class OrdersController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly orders: PurchaseOrdersService,
  ) {}

  // ================================================================ settings

  @Get('settings')
  settings(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadSettings(tx));
  }

  @Patch('settings')
  @Roles('owner', 'admin')
  updateSettings(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(Settings)) body: z.infer<typeof Settings>) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const before = await this.loadSettings(tx);
      await tx.insert(PS).values({ tenantId: p.tenantId, ...body }).onConflictDoUpdate({ target: PS.tenantId, set: body });
      await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'procurement.settings_updated', entityType: 'tenant', entityId: p.tenantId, payload: { before, changes: body } });
      return this.loadSettings(tx);
    });
  }

  // ================================================================ suppliers & cost codes
  // Procurement users (site foremen, PMs) need these without access to the books.

  @Get('suppliers')
  suppliers(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, (tx) => tx.select().from(S).orderBy(asc(S.name)));
  }

  @Post('suppliers')
  @Roles(...BUYERS)
  async addSupplier(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(SupplierBody)) body: z.infer<typeof SupplierBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [s] = await tx.insert(S).values({ ...body, tenantId: p.tenantId }).returning();
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'supplier.created', entityType: 'supplier', entityId: s!.id, payload: body });
        return s;
      });
    } catch (err) {
      ledgerError(err, `A supplier called ${body.name} already exists`);
    }
  }

  @Patch('suppliers/:id')
  @Roles(...BUYERS)
  async updateSupplier(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(SupplierBody.partial())) body: Partial<z.infer<typeof SupplierBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [s] = await tx.update(S).set(body).where(eq(S.id, id)).returning();
        if (!s) throw new NotFoundException('Supplier not found');
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'supplier.updated', entityType: 'supplier', entityId: id, payload: body });
        return s;
      });
    } catch (err) {
      ledgerError(err, 'Another supplier already has that name');
    }
  }

  /** Cost codes to charge order lines to (codes and descriptions only, no financials). */
  @Get('projects/:projectId/cost-codes')
  costCodes(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string) {
    const CC = schema.costCodes;
    return this.db.forTenant(p.tenantId, (tx) =>
      tx.select({ id: CC.id, code: CC.code, description: CC.description }).from(CC).where(eq(CC.projectId, projectId)).orderBy(asc(CC.code)),
    );
  }

  /** Expense and asset accounts for overhead order lines (no balances). */
  @Get('accounts')
  accounts(@CurrentUser() p: Principal) {
    const A = schema.accounts;
    return this.db.forTenant(p.tenantId, (tx) =>
      tx
        .select({ id: A.id, code: A.code, name: A.name, type: A.type, systemKey: A.systemKey })
        .from(A)
        .where(and(eq(A.isActive, true), eq(A.isBank, false), inArray(A.type, ['expense', 'asset'])))
        .orderBy(asc(A.code)),
    );
  }

  // ================================================================ orders

  @Get('purchase-orders')
  list(@CurrentUser() p: Principal, @Query('status') status?: string, @Query('projectId') projectId?: string) {
    const statuses = schema.poStatus.enumValues as readonly string[];
    if (status && !statuses.includes(status)) throw new BadRequestException('Unknown status');
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({ po: PO, supplierName: S.name })
        .from(PO)
        .innerJoin(S, eq(S.id, PO.supplierId))
        .where(and(status ? eq(PO.status, status as (typeof schema.poStatus.enumValues)[number]) : undefined, projectId ? eq(PO.projectId, projectId) : undefined))
        .orderBy(desc(PO.poNo))
        .limit(500);
      const progress = rows.length ? await this.progress(tx, rows.map((r) => r.po.id)) : new Map();
      return rows.map((r) => {
        const lines = [...progress.values()].filter((l) => l.poId === r.po.id);
        const fullyReceived = lines.length > 0 && lines.every((l) => new Decimal(l.outstanding).isZero());
        const anyReceived = lines.some((l) => new Decimal(l.received).greaterThan(0));
        return { ...r.po, number: poLabel(r.po.poNo), supplierName: r.supplierName, delivery: fullyReceived ? 'received' : anyReceived ? 'part_received' : 'none' };
      });
    });
  }

  @Get('purchase-orders/:id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, id));
  }

  @Post('purchase-orders')
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(OrderBody)) body: z.infer<typeof OrderBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const id = await this.orders.insertOrder(tx, p, body);
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Patch('purchase-orders/:id')
  async update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(OrderBody.partial())) body: Partial<z.infer<typeof OrderBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const po = await this.order(tx, id);
        if (po.status !== 'draft') throw new BadRequestException('Only a draft order can be edited. Return it to draft first');
        const { lines, ...header } = body;
        let totals = {};
        if (lines) {
          const prepared = await validateLines(tx, lines);
          await tx.delete(POL).where(eq(POL.poId, id));
          await tx.insert(POL).values(prepared.map((l, i) => ({ ...l, tenantId: p.tenantId, poId: id, lineNo: i + 1 })));
          totals = orderTotals(prepared);
        }
        await tx.update(PO).set({ ...header, ...totals }).where(eq(PO.id, id));
        await this.audit(tx, p, 'purchase_order.updated', id, { number: poLabel(po.poNo), changes: header, linesReplaced: Boolean(lines), ...totals });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Delete('purchase-orders/:id')
  async remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const po = await this.order(tx, id);
        await tx.delete(PO).where(eq(PO.id, id));
        await this.audit(tx, p, 'purchase_order.deleted', id, { number: poLabel(po.poNo) });
        return { deleted: true };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** draft → submitted (requisition) → approved (within approval limits) → closed; or cancelled. */
  @Post('purchase-orders/:id/transition')
  @HttpCode(200)
  async transition(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Transition)) body: z.infer<typeof Transition>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const po = await this.order(tx, id);
        const set: Partial<typeof PO.$inferInsert> = { status: body.to };
        if (body.to === 'submitted') {
          const [line] = await tx.select({ id: POL.id }).from(POL).where(eq(POL.poId, id)).limit(1);
          if (!line) throw new BadRequestException('Add at least one line before submitting');
          set.submittedAt = new Date();
        }
        if (body.to === 'draft' && !BUYERS.includes(p.role) && po.createdBy !== p.userId) {
          throw new ForbiddenException('Only the requester or a buyer can return this order to draft');
        }
        if (body.to === 'approved') {
          if (po.status !== 'submitted') throw new BadRequestException('Submit the order for approval first');
          const s = await this.loadSettings(tx);
          const check = canApproveOrder(p.role, po.subtotal, s.pmApprovalLimit, po.createdBy === p.userId);
          if (!check.ok) throw new ForbiddenException(check.reason);
          set.approvedAt = new Date();
          set.approvedBy = p.userId;
        }
        if (body.to === 'closed' || body.to === 'cancelled') {
          if (!BUYERS.includes(p.role)) throw new ForbiddenException('Your role cannot close or cancel orders');
          if (po.status !== 'draft' && !body.reason) throw new BadRequestException('Give a reason');
          set.closedAt = new Date();
          set.closeReason = body.reason ?? null;
        }
        await tx.update(PO).set(set).where(eq(PO.id, id));
        await this.audit(tx, p, `purchase_order.${body.to}`, id, { number: poLabel(po.poNo), from: po.status, to: body.to, subtotal: po.subtotal, reason: body.reason ?? null });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Record a delivery. The database refuses anything beyond what was ordered. */
  @Post('purchase-orders/:id/receive')
  @HttpCode(200)
  async receive(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Receive)) body: z.infer<typeof Receive>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const po = await this.order(tx, id);
        if (po.status !== 'approved') throw new BadRequestException('Goods can only be received against an approved order');
        const lines = body.lines.filter((l) => new Decimal(l.quantity).greaterThan(0));
        if (!lines.length) throw new BadRequestException('Enter a quantity received on at least one line');
        const grnNo = await this.ledger.nextNo(tx, 'goods_receipt');
        const [grn] = await tx
          .insert(GR)
          .values({ tenantId: p.tenantId, grnNo, poId: id, receivedOn: body.receivedOn, deliveryNote: body.deliveryNote ?? null, notes: body.notes ?? '', receivedBy: p.userId })
          .returning();
        await tx.insert(GRL).values(lines.map((l) => ({ tenantId: p.tenantId, receiptId: grn!.id, poLineId: l.poLineId, quantity: l.quantity })));
        await this.audit(tx, p, 'goods.received', id, { number: poLabel(po.poNo), grnNo, deliveryNote: body.deliveryNote ?? null, lines });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Capture the supplier's invoice against this order, defaulting each line to
   * what has been received but not yet invoiced. Saved as a draft supplier
   * invoice; approving it under Payables enforces the three-way match.
   */
  @Post('purchase-orders/:id/invoice')
  @Roles(...BUYERS)
  async invoice(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(InvoiceFromOrder)) body: z.infer<typeof InvoiceFromOrder>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const po = await this.order(tx, id);
        if (po.status !== 'approved' && po.status !== 'closed') throw new BadRequestException('Only an approved order can be invoiced');
        const [supplier] = await tx.select().from(S).where(eq(S.id, po.supplierId));
        const orderLines = await tx.select().from(POL).where(eq(POL.poId, id));
        const lines = body.lines
          .filter((l) => new Decimal(l.quantity).greaterThan(0))
          .map((l) => {
            const ol = orderLines.find((x) => x.id === l.poLineId);
            if (!ol) throw new BadRequestException('A line does not belong to this order');
            const unitPrice = l.unitPrice ?? ol.unitPrice;
            const amount = lineAmount(l.quantity, unitPrice);
            return {
              description: `${ol.description} (${l.quantity} ${ol.unit})`.slice(0, 300),
              amount,
              vatRate: ol.vatRate,
              vatAmount: vatFor(amount, ol.vatRate),
              projectId: ol.projectId,
              costCodeId: ol.costCodeId,
              category: ol.category,
              accountId: ol.accountId,
              poLineId: ol.id,
              quantity: l.quantity,
              unitPrice,
            };
          });
        if (!lines.length) throw new BadRequestException('Enter a quantity on at least one line');
        const [inv] = await tx
          .insert(SI)
          .values({
            tenantId: p.tenantId,
            supplierId: po.supplierId,
            invoiceNo: body.invoiceNo,
            invoiceDate: body.invoiceDate,
            dueDate: new Date(Date.parse(`${body.invoiceDate}T00:00:00Z`) + supplier!.paymentTermsDays * 86_400_000).toISOString().slice(0, 10),
            poId: id,
            notes: `Against ${poLabel(po.poNo)}`,
            createdBy: p.userId,
            ...invoiceTotals(lines),
          })
          .returning();
        await tx.insert(SIL).values(lines.map((l, i) => ({ ...l, tenantId: p.tenantId, invoiceId: inv!.id, lineNo: i + 1 })));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'supplier_invoice.captured', entityType: 'supplier_invoice', entityId: inv!.id, payload: { supplier: supplier!.name, invoiceNo: body.invoiceNo, total: inv!.total, po: poLabel(po.poNo) } });
        return { invoiceId: inv!.id, ...(await this.load(tx, id)) };
      });
    } catch (err) {
      ledgerError(err, `Invoice ${body.invoiceNo} from this supplier is already captured`);
    }
  }

  // ================================================================ B-BBEE

  /** Procurement spend by supplier B-BBEE level (approved invoices, excl. VAT). */
  @Get('reports/bbbee')
  @Roles(...BUYERS)
  bbbee(@CurrentUser() p: Principal, @Query('from') from?: string, @Query('to') to?: string) {
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today();
    const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : `${Number(t.slice(0, 4)) - 1}${t.slice(4)}`;
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({ supplierId: S.id, supplierName: S.name, level: S.bbbeeLevel, expiry: S.bbbeeExpiry, spend: sql<string>`coalesce(sum(${SI.subtotal}), 0)::numeric(18,2)::text` })
        .from(SI)
        .innerJoin(S, eq(S.id, SI.supplierId))
        .where(and(inArray(SI.status, ['approved', 'part_paid', 'paid']), gte(SI.invoiceDate, f), lte(SI.invoiceDate, t)))
        .groupBy(S.id, S.name, S.bbbeeLevel, S.bbbeeExpiry);
      return { from: f, to: t, ...bbbeeSpend(rows, t) };
    });
  }

  // ================================================================ helpers

  private audit(tx: Tx, p: Principal, action: string, entityId: string, payload: Record<string, unknown>) {
    return appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action, entityType: 'purchase_order', entityId, payload });
  }

  private async loadSettings(tx: Tx) {
    const [s] = await tx.select().from(PS);
    return { pmApprovalLimit: s?.pmApprovalLimit ?? '50000.00', priceTolerancePct: s?.priceTolerancePct ?? '0.00' };
  }

  private async order(tx: Tx, id: string) {
    const [po] = await tx.select().from(PO).where(eq(PO.id, id));
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  /** Received and invoiced quantity per order line. */
  private async progress(tx: Tx, poIds: string[]) {
    const lines = await tx.select().from(POL).where(inArray(POL.poId, poIds)).orderBy(asc(POL.lineNo));
    const ids = lines.map((l) => l.id);
    const [received, invoiced] = ids.length
      ? await Promise.all([
          tx.select({ id: GRL.poLineId, q: sql<string>`sum(${GRL.quantity})::text` }).from(GRL).where(inArray(GRL.poLineId, ids)).groupBy(GRL.poLineId),
          tx
            .select({ id: SIL.poLineId, q: sql<string>`sum(${SIL.quantity})::text`, amount: sql<string>`sum(${SIL.amount})::text` })
            .from(SIL)
            .innerJoin(SI, eq(SI.id, SIL.invoiceId))
            .where(and(inArray(SIL.poLineId, ids), inArray(SI.status, ['approved', 'part_paid', 'paid'])))
            .groupBy(SIL.poLineId),
        ])
      : [[], []];
    const r = new Map(received.map((x) => [x.id, x.q]));
    const inv = new Map(invoiced.map((x) => [x.id, x]));
    return new Map(
      lines.map((l) => [
        l.id,
        { ...l, amount: lineAmount(l.quantity, l.unitPrice), invoicedAmount: inv.get(l.id)?.amount ?? '0.00', ...lineProgress(l.quantity, r.get(l.id) ?? '0', inv.get(l.id)?.q ?? '0') },
      ]),
    );
  }

  private async load(tx: Tx, id: string) {
    const po = await this.order(tx, id);
    const [[supplier], progress, receipts, invoices] = await Promise.all([
      tx.select().from(S).where(eq(S.id, po.supplierId)),
      this.progress(tx, [id]),
      tx.select().from(GR).where(eq(GR.poId, id)).orderBy(desc(GR.grnNo)),
      tx.select({ id: SI.id, invoiceNo: SI.invoiceNo, status: SI.status, total: SI.total, invoiceDate: SI.invoiceDate }).from(SI).where(eq(SI.poId, id)).orderBy(desc(SI.invoiceDate)),
    ]);
    const lines = [...progress.values()].map((l) => ({ ...l, committed: lineCommitment(po.status, l.quantity, l.unitPrice, l.invoicedAmount) }));
    return {
      ...po,
      number: poLabel(po.poNo),
      supplierName: supplier?.name ?? '',
      supplier,
      lines,
      receipts: receipts.map((g) => ({ ...g, number: `GRN-${String(g.grnNo).padStart(5, '0')}` })),
      invoices,
      committed: lines.reduce((s, l) => s.plus(l.committed), new Decimal(0)).toFixed(2),
    };
  }

}
