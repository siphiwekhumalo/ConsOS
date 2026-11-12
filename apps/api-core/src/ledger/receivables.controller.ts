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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { customerInvoicePosting, invoiceTotals, money, valuationInvoiceLines, vatFor } from './calc';
import { LedgerService, ledgerError } from './ledger.service';
import { LEDGER_ROLES, isoDate } from './ledger.controller';
import { PartyBody } from './payables.controller';

const C = schema.customers;
const CI = schema.customerInvoices;
const CIL = schema.customerInvoiceLines;
const VAL = schema.valuations;

const signed = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string');
const Line = z.object({
  description: z.string().trim().min(1).max(300),
  accountId: z.string().uuid(),
  amount: signed.refine((v) => !/^-?0+(\.0+)?$/.test(v), 'amount cannot be zero'),
  vatRate: z.enum(['0', '15']).default('15'),
});
const InvoiceBody = z.object({
  customerId: z.string().uuid(),
  invoiceDate: isoDate,
  dueDate: isoDate.optional(),
  projectId: z.string().uuid().nullable().optional(),
  customerRef: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(Line).min(1).max(200),
});
const InvoicePatch = InvoiceBody.partial();
const FromValuation = z.object({ valuationId: z.string().uuid(), customerId: z.string().uuid(), invoiceDate: isoDate.optional() });
const Void = z.object({ reason: z.string().trim().min(1).max(250) });

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Tax invoice numbers as printed: INV-000123. */
export const invoiceLabel = (n: number | null) => (n === null ? 'Draft' : `INV-${String(n).padStart(6, '0')}`);

@Controller('finance')
@RequiresModule('mod_finance')
@Roles(...LEDGER_ROLES)
export class ReceivablesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ================================================================ customers

  @Get('customers')
  customers(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, (tx) => tx.select().from(C).orderBy(asc(C.name)));
  }

  @Post('customers')
  async addCustomer(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(PartyBody.extend({ billingAddress: z.string().trim().max(500).nullable().optional() }))) body: z.infer<typeof PartyBody> & { billingAddress?: string | null }) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [c] = await tx.insert(C).values({ ...body, tenantId: p.tenantId }).returning();
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'customer.created', entityType: 'customer', entityId: c!.id, payload: body });
        return c;
      });
    } catch (err) {
      ledgerError(err, `A customer called ${body.name} already exists`);
    }
  }

  @Patch('customers/:id')
  async updateCustomer(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(PartyBody.extend({ billingAddress: z.string().trim().max(500).nullable().optional() }).partial())) body: Partial<z.infer<typeof PartyBody>> & { billingAddress?: string | null }) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [c] = await tx.update(C).set(body).where(eq(C.id, id)).returning();
        if (!c) throw new NotFoundException('Customer not found');
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'customer.updated', entityType: 'customer', entityId: id, payload: body });
        return c;
      });
    } catch (err) {
      ledgerError(err, 'Another customer already has that name');
    }
  }

  // ================================================================ invoices

  @Get('customer-invoices')
  list(@CurrentUser() p: Principal, @Query('status') status?: string) {
    const statuses = schema.customerInvoiceStatus.enumValues as readonly string[];
    if (status && !statuses.includes(status)) throw new BadRequestException('Unknown status');
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({ invoice: CI, customerName: C.name })
        .from(CI)
        .innerJoin(C, eq(C.id, CI.customerId))
        .where(status ? eq(CI.status, status as (typeof schema.customerInvoiceStatus.enumValues)[number]) : undefined)
        .orderBy(desc(CI.invoiceDate), desc(CI.createdAt))
        .limit(500);
      return rows.map((r) => ({ ...r.invoice, number: invoiceLabel(r.invoice.invoiceNo), customerName: r.customerName }));
    });
  }

  @Get('customer-invoices/:id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, id));
  }

  @Post('customer-invoices')
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(InvoiceBody)) body: z.infer<typeof InvoiceBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [customer] = await tx.select().from(C).where(eq(C.id, body.customerId));
        if (!customer) throw new BadRequestException('Unknown customer');
        const id = await this.insertDraft(tx, p, {
          customerId: body.customerId,
          invoiceDate: body.invoiceDate,
          dueDate: body.dueDate ?? addDays(body.invoiceDate, customer.paymentTermsDays),
          projectId: body.projectId ?? null,
          valuationId: null,
          customerRef: body.customerRef ?? null,
          notes: body.notes ?? '',
          lines: await this.prepareLines(tx, body.lines),
        });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Draft the tax invoice for a certified payment certificate: work done this
   * period less the retention movement, VAT on the net amount due.
   */
  @Post('customer-invoices/from-valuation')
  async fromValuation(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(FromValuation)) body: z.infer<typeof FromValuation>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [v] = await tx.select().from(VAL).where(eq(VAL.id, body.valuationId));
        if (!v) throw new NotFoundException('Valuation not found');
        if (v.status !== 'certified' && v.status !== 'paid') throw new BadRequestException('Only a certified valuation can be invoiced');
        const [existing] = await tx.select({ id: CI.id }).from(CI).where(and(eq(CI.valuationId, v.id), ne(CI.status, 'void')));
        if (existing) throw new BadRequestException('This valuation already has a tax invoice');
        const [customer] = await tx.select().from(C).where(eq(C.id, body.customerId));
        if (!customer) throw new BadRequestException('Unknown customer');
        const [prev] = await tx
          .select()
          .from(VAL)
          .where(and(eq(VAL.projectId, v.projectId), lt(VAL.valuationNo, v.valuationNo), inArray(VAL.status, ['certified', 'paid'])))
          .orderBy(desc(VAL.valuationNo))
          .limit(1);
        const keys = await this.ledger.systemAccounts(tx, ['contract_revenue', 'retention_receivable']);
        const raw = valuationInvoiceLines({
          valuationNo: v.valuationNo,
          grossToDate: v.grossToDate,
          retentionToDate: v.retentionToDate,
          previousGross: prev?.grossToDate ?? '0',
          previousRetention: prev?.retentionToDate ?? '0',
          contractRevenue: keys.contract_revenue,
          retentionReceivable: keys.retention_receivable,
        });
        if (raw.length === 0) throw new BadRequestException('Nothing to invoice: no movement since the previous certificate');
        const invoiceDate = body.invoiceDate ?? today();
        const lines = raw.map((l) => ({ ...l, vatAmount: vatFor(l.amount, l.vatRate) }));
        const id = await this.insertDraft(tx, p, {
          customerId: body.customerId,
          invoiceDate,
          dueDate: addDays(invoiceDate, customer.paymentTermsDays),
          projectId: v.projectId,
          valuationId: v.id,
          customerRef: v.certificateRef,
          notes: `Payment certificate ${v.certificateRef ?? v.valuationNo}, period ending ${v.periodEnd}.`,
          lines,
        });
        const inv = await this.load(tx, id);
        // Cross-check: the invoice excluding VAT must equal the certificate's amount due.
        if (!new Decimal(inv.subtotal).equals(v.amountDue)) {
          throw new BadRequestException(`Invoice subtotal ${inv.subtotal} does not match the certificate amount due ${v.amountDue}`);
        }
        return inv;
      });
    } catch (err) {
      ledgerError(err, 'This valuation already has a tax invoice');
    }
  }

  @Patch('customer-invoices/:id')
  async update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(InvoicePatch)) body: z.infer<typeof InvoicePatch>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        if (inv.status !== 'draft') throw new BadRequestException('Only a draft invoice can be edited');
        if (inv.valuationId && (body.lines || body.projectId !== undefined)) {
          throw new BadRequestException('Lines of a valuation invoice come from the certificate and cannot be edited');
        }
        const { lines: newLines, ...header } = body;
        let totals = {};
        if (newLines) {
          const lines = await this.prepareLines(tx, newLines);
          await tx.delete(CIL).where(eq(CIL.invoiceId, id));
          await tx.insert(CIL).values(lines.map((l, i) => ({ ...l, tenantId: p.tenantId, invoiceId: id, lineNo: i + 1 })));
          totals = invoiceTotals(lines);
        }
        await tx.update(CI).set({ ...header, ...totals }).where(eq(CI.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'customer_invoice.updated', entityType: 'customer_invoice', entityId: id, payload: { changes: header, linesReplaced: Boolean(newLines), ...totals } });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Delete('customer-invoices/:id')
  async remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        await tx.delete(CI).where(eq(CI.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'customer_invoice.deleted', entityType: 'customer_invoice', entityId: id, payload: { total: inv.total } });
        return { deleted: true };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Issue: assigns the next gap-free tax invoice number and posts Dr receivables, Cr revenue + VAT output. */
  @Post('customer-invoices/:id/issue')
  @HttpCode(200)
  async issue(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        if (inv.status !== 'draft') throw new BadRequestException(`Invoice is already ${inv.status}`);
        if (!new Decimal(inv.total).greaterThan(0)) throw new BadRequestException('The invoice total must be more than zero');
        const [customer] = await tx.select().from(C).where(eq(C.id, inv.customerId));
        const lines = await tx.select().from(CIL).where(eq(CIL.invoiceId, id)).orderBy(asc(CIL.lineNo));
        const keys = await this.ledger.systemAccounts(tx, ['ar_control', 'vat_output']);
        const invoiceNo = await this.ledger.nextNo(tx, 'customer_invoice');
        const journal = await this.ledger.post(
          tx,
          p,
          { entryDate: inv.invoiceDate, description: `${invoiceLabel(invoiceNo)} to ${customer!.name}`.slice(0, 300), source: 'customer_invoice', sourceId: id },
          customerInvoicePosting({
            arControl: keys.ar_control,
            vatOutput: keys.vat_output,
            vatTotal: inv.vatTotal,
            total: inv.total,
            projectId: inv.projectId,
            lines: lines.map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description })),
          }),
        );
        await tx.update(CI).set({ status: 'issued', invoiceNo, journalId: journal.id, issuedAt: new Date(), issuedBy: p.userId }).where(eq(CI.id, id));
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'customer_invoice.issued',
          entityType: 'customer_invoice',
          entityId: id,
          payload: { number: invoiceLabel(invoiceNo), customer: customer!.name, total: inv.total, vat: inv.vatTotal, journalNo: journal.journalNo, valuationId: inv.valuationId },
        });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Void an issued, unpaid tax invoice (in practice: the credit note that cancels it). */
  @Post('customer-invoices/:id/void')
  @HttpCode(200)
  async void(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Void)) body: z.infer<typeof Void>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        if (inv.status !== 'issued') throw new BadRequestException(inv.status === 'draft' ? 'Delete a draft instead of voiding it' : `A ${inv.status.replace('_', ' ')} invoice cannot be voided`);
        const rev = await this.ledger.reverse(tx, p, inv.journalId!, today(), `Credit note cancelling ${invoiceLabel(inv.invoiceNo)}: ${body.reason}`.slice(0, 300), 'void');
        await tx.update(CI).set({ status: 'void', voidedAt: new Date(), voidJournalId: rev.id }).where(eq(CI.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'customer_invoice.voided', entityType: 'customer_invoice', entityId: id, payload: { number: invoiceLabel(inv.invoiceNo), reason: body.reason, journalNo: rev.journalNo } });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ helpers

  private async invoice(tx: Tx, id: string) {
    const [inv] = await tx.select().from(CI).where(eq(CI.id, id));
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  private async load(tx: Tx, id: string) {
    const inv = await this.invoice(tx, id);
    const [[customer], lines, allocations] = await Promise.all([
      tx.select().from(C).where(eq(C.id, inv.customerId)),
      tx.select().from(CIL).where(eq(CIL.invoiceId, id)).orderBy(asc(CIL.lineNo)),
      tx
        .select({ amount: schema.paymentAllocations.amount, paymentNo: schema.payments.paymentNo, paymentDate: schema.payments.paymentDate, reference: schema.payments.reference })
        .from(schema.paymentAllocations)
        .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentAllocations.paymentId))
        .where(eq(schema.paymentAllocations.customerInvoiceId, id)),
    ]);
    return { ...inv, number: invoiceLabel(inv.invoiceNo), customerName: customer?.name ?? '', customer, lines, payments: allocations };
  }

  private async insertDraft(
    tx: Tx,
    p: Principal,
    d: {
      customerId: string;
      invoiceDate: string;
      dueDate: string;
      projectId: string | null;
      valuationId: string | null;
      customerRef: string | null;
      notes: string;
      lines: { description: string; accountId: string; amount: string; vatRate: string; vatAmount: string }[];
    },
  ) {
    const { lines, ...header } = d;
    const [inv] = await tx
      .insert(CI)
      .values({ tenantId: p.tenantId, createdBy: p.userId, ...header, ...invoiceTotals(lines) })
      .returning();
    await tx.insert(CIL).values(lines.map((l, i) => ({ ...l, tenantId: p.tenantId, invoiceId: inv!.id, lineNo: i + 1 })));
    await appendAudit(tx, {
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: 'customer_invoice.drafted',
      entityType: 'customer_invoice',
      entityId: inv!.id,
      payload: { customerId: d.customerId, total: inv!.total, valuationId: d.valuationId },
    });
    return inv!.id;
  }

  private async prepareLines(tx: Tx, lines: z.infer<typeof Line>[]) {
    const accounts = await tx.select().from(schema.accounts).where(inArray(schema.accounts.id, lines.map((l) => l.accountId)));
    return lines.map((l, i) => {
      const acc = accounts.find((a) => a.id === l.accountId);
      if (!acc || !acc.isActive) throw new BadRequestException(`Line ${i + 1}: unknown or inactive account`);
      if (acc.isBank || acc.systemKey === 'ar_control' || acc.systemKey === 'ap_control' || acc.systemKey === 'vat_output' || acc.systemKey === 'vat_input') {
        throw new BadRequestException(`Line ${i + 1}: ${acc.code} ${acc.name} cannot be used on an invoice line`);
      }
      return { description: l.description, accountId: l.accountId, amount: money(new Decimal(l.amount)), vatRate: l.vatRate, vatAmount: vatFor(l.amount, l.vatRate) };
    });
  }
}
