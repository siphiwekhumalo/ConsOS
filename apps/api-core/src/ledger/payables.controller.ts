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
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx, type UserRole } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { invoiceTotals, money, supplierInvoicePosting, vatFor } from './calc';
import { COST_CATEGORY_KEY } from './chart';
import { LedgerService, ledgerError } from './ledger.service';
import { isoDate } from './ledger.controller';

const S = schema.suppliers;
const SI = schema.supplierInvoices;
const SIL = schema.supplierInvoiceLines;
const CE = schema.costEntries;

const signed = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string');
const vatNo = z.string().regex(/^4\d{9}$/, 'a South African VAT number is 10 digits starting with 4');

export const PartyBody = z.object({
  name: z.string().trim().min(1).max(200),
  vatNumber: vatNo.nullable().optional(),
  registrationNo: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  isActive: z.boolean().optional(),
});

export const SupplierBody = PartyBody.extend({
  bbbeeLevel: z.number().int().min(1).max(8).nullable().optional(),
  bbbeeExpiry: isoDate.nullable().optional(),
  cidbGrading: z.string().trim().toUpperCase().regex(/^[1-9][A-Z]{1,3}$/, 'CIDB grading like 6CE or 7GB').nullable().optional(),
  isSubcontractor: z.boolean().optional(),
});

const Line = z.object({
  description: z.string().trim().min(1).max(300),
  amount: signed.refine((v) => !/^-?0+(\.0+)?$/.test(v), 'amount cannot be zero'),
  vatRate: z.enum(['0', '15']).default('15'),
  projectId: z.string().uuid().nullable().optional(),
  costCodeId: z.string().uuid().nullable().optional(),
  category: z.enum(['labour', 'material', 'plant', 'subcontract', 'overhead', 'other']).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
});
const InvoiceBody = z.object({
  supplierId: z.string().uuid(),
  invoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: isoDate,
  dueDate: isoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
  sourceFileId: z.string().uuid().nullable().optional(),
  lines: z.array(Line).min(1).max(200),
});
const InvoicePatch = InvoiceBody.partial();
const Void = z.object({ reason: z.string().trim().min(1).max(250) });
// Optional body: approving without one is the normal case.
const Approve = z.object({ matchOverrideReason: z.string().trim().min(1).max(500).optional() }).optional().default({});

/** Capturing invoices is open to project managers; approving (which posts) is not. */
const CAPTURE: UserRole[] = ['owner', 'admin', 'finance', 'project_manager'];
const APPROVE: UserRole[] = ['owner', 'admin', 'finance'];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

@Controller('finance')
@RequiresModule('mod_finance')
@Roles(...CAPTURE)
export class PayablesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ================================================================ suppliers

  @Get('suppliers')
  suppliers(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, (tx) => tx.select().from(S).orderBy(asc(S.name)));
  }

  @Post('suppliers')
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

  // ================================================================ invoices

  @Get('supplier-invoices')
  list(@CurrentUser() p: Principal, @Query('status') status?: string) {
    const statuses = schema.supplierInvoiceStatus.enumValues as readonly string[];
    if (status && !statuses.includes(status)) throw new BadRequestException('Unknown status');
    return this.db.forTenant(p.tenantId, (tx) =>
      tx
        .select({ invoice: SI, supplierName: S.name })
        .from(SI)
        .innerJoin(S, eq(S.id, SI.supplierId))
        .where(status ? eq(SI.status, status as (typeof schema.supplierInvoiceStatus.enumValues)[number]) : undefined)
        .orderBy(desc(SI.invoiceDate), desc(SI.createdAt))
        .limit(500)
        .then((rows) => rows.map((r) => ({ ...r.invoice, supplierName: r.supplierName }))),
    );
  }

  @Get('supplier-invoices/:id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, id));
  }

  @Post('supplier-invoices')
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(InvoiceBody)) body: z.infer<typeof InvoiceBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [supplier] = await tx.select().from(S).where(eq(S.id, body.supplierId));
        if (!supplier) throw new BadRequestException('Unknown supplier');
        const lines = await this.prepareLines(tx, body.lines);
        const [inv] = await tx
          .insert(SI)
          .values({
            tenantId: p.tenantId,
            supplierId: body.supplierId,
            invoiceNo: body.invoiceNo,
            invoiceDate: body.invoiceDate,
            dueDate: body.dueDate ?? addDays(body.invoiceDate, supplier.paymentTermsDays),
            notes: body.notes ?? '',
            sourceFileId: body.sourceFileId ?? null,
            createdBy: p.userId,
            ...invoiceTotals(lines),
          })
          .returning();
        await tx.insert(SIL).values(lines.map((l, i) => ({ ...l, tenantId: p.tenantId, invoiceId: inv!.id, lineNo: i + 1 })));
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'supplier_invoice.captured',
          entityType: 'supplier_invoice',
          entityId: inv!.id,
          payload: { supplier: supplier.name, invoiceNo: body.invoiceNo, total: inv!.total },
        });
        return this.load(tx, inv!.id);
      });
    } catch (err) {
      ledgerError(err, `Invoice ${body.invoiceNo} from this supplier is already captured`);
    }
  }

  @Patch('supplier-invoices/:id')
  async update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(InvoicePatch)) body: z.infer<typeof InvoicePatch>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        if (inv.status !== 'draft') throw new BadRequestException('Only a draft invoice can be edited');
        if ((inv.poId || inv.subcontractCertificateId) && (body.lines || body.supplierId)) {
          throw new BadRequestException('This invoice was raised from an order or a subcontract certificate; delete it and capture it again to change its lines');
        }
        const { lines: newLines, ...header } = body;
        let totals = {};
        if (newLines) {
          const lines = await this.prepareLines(tx, newLines);
          await tx.delete(SIL).where(eq(SIL.invoiceId, id));
          await tx.insert(SIL).values(lines.map((l, i) => ({ ...l, tenantId: p.tenantId, invoiceId: id, lineNo: i + 1 })));
          totals = invoiceTotals(lines);
        }
        await tx.update(SI).set({ ...header, ...totals }).where(eq(SI.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'supplier_invoice.updated', entityType: 'supplier_invoice', entityId: id, payload: { invoiceNo: inv.invoiceNo, changes: header, linesReplaced: Boolean(newLines), ...totals } });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err, 'That invoice number is already captured for this supplier');
    }
  }

  @Delete('supplier-invoices/:id')
  async remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        await tx.delete(SI).where(eq(SI.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'supplier_invoice.deleted', entityType: 'supplier_invoice', entityId: id, payload: { invoiceNo: inv.invoiceNo, total: inv.total } });
        return { deleted: true };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Approve for payment: posts Dr cost / expense + Dr VAT input, Cr trade payables,
   * and puts project lines into the project's cost ledger (so CVR sees them).
   */
  @Post('supplier-invoices/:id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Approve)) body: z.infer<typeof Approve>) {
    this.requireRole(p, APPROVE);
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        if (inv.status !== 'draft') throw new BadRequestException(`Invoice is already ${inv.status}`);
        if (!new Decimal(inv.total).isPositive()) throw new BadRequestException('The invoice total must be more than zero');
        const [supplier] = await tx.select().from(S).where(eq(S.id, inv.supplierId));
        const lines = await tx.select().from(SIL).where(eq(SIL.invoiceId, id)).orderBy(asc(SIL.lineNo));
        const keys = await this.ledger.systemAccounts(tx, ['ap_control', 'vat_input', ...Object.values(COST_CATEGORY_KEY)]);
        const journal = await this.ledger.post(
          tx,
          p,
          { entryDate: inv.invoiceDate, description: `${supplier!.name} invoice ${inv.invoiceNo}`.slice(0, 300), source: 'supplier_invoice', sourceId: id },
          supplierInvoicePosting({
            apControl: keys.ap_control,
            vatInput: keys.vat_input,
            vatTotal: inv.vatTotal,
            total: inv.total,
            lines: lines.map((l) => ({
              accountId: l.accountId ?? keys[COST_CATEGORY_KEY[l.category!]],
              amount: l.amount,
              projectId: l.projectId,
              description: l.description,
            })),
          }),
        );
        const projectLines = lines.filter((l) => l.projectId);
        if (projectLines.length) {
          await tx.insert(CE).values(
            projectLines.map((l) => ({
              tenantId: p.tenantId,
              projectId: l.projectId!,
              costCodeId: l.costCodeId!,
              entryDate: inv.invoiceDate,
              category: l.category!,
              description: `${supplier!.name}: ${l.description}`.slice(0, 300),
              amount: l.amount,
              reference: inv.invoiceNo.slice(0, 100),
              source: 'ap_invoice',
              sourceId: id,
              createdBy: p.userId,
            })),
          );
        }
        // The database enforces the three-way match here (invoiced ≤ received, price ≤ order price),
        // unless an override reason is recorded.
        await tx
          .update(SI)
          .set({ status: 'approved', journalId: journal.id, approvedAt: new Date(), approvedBy: p.userId, matchOverrideReason: body.matchOverrideReason ?? null })
          .where(eq(SI.id, id));
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'supplier_invoice.approved',
          entityType: 'supplier_invoice',
          entityId: id,
          payload: { invoiceNo: inv.invoiceNo, supplier: supplier!.name, total: inv.total, journalNo: journal.journalNo, projectCosts: projectLines.length, matchOverrideReason: body.matchOverrideReason ?? null },
        });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Void an approved, unpaid invoice: reverses its journal and its project costs. */
  @Post('supplier-invoices/:id/void')
  @HttpCode(200)
  async void(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Void)) body: z.infer<typeof Void>) {
    this.requireRole(p, APPROVE);
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inv = await this.invoice(tx, id);
        if (inv.status !== 'approved') throw new BadRequestException(inv.status === 'draft' ? 'Delete a draft instead of voiding it' : `A ${inv.status.replace('_', ' ')} invoice cannot be voided`);
        const rev = await this.ledger.reverse(tx, p, inv.journalId!, today(), `Void supplier invoice ${inv.invoiceNo}: ${body.reason}`.slice(0, 300), 'void');
        const costs = await tx.select().from(CE).where(and(eq(CE.sourceId, id), isNull(CE.reversesId)));
        if (costs.length) {
          await tx.insert(CE).values(
            costs.map((c) => ({
              tenantId: p.tenantId,
              projectId: c.projectId,
              costCodeId: c.costCodeId,
              entryDate: today(),
              category: c.category,
              description: `Reversal (invoice voided): ${c.description}`.slice(0, 300),
              amount: money(new Decimal(c.amount).negated()),
              reference: c.reference,
              source: 'ap_invoice',
              sourceId: id,
              reversesId: c.id,
              createdBy: p.userId,
            })),
          );
        }
        await tx.update(SI).set({ status: 'void', voidedAt: new Date(), voidJournalId: rev.id }).where(eq(SI.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'supplier_invoice.voided', entityType: 'supplier_invoice', entityId: id, payload: { invoiceNo: inv.invoiceNo, reason: body.reason, journalNo: rev.journalNo, costsReversed: costs.length } });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ helpers

  private requireRole(p: Principal, roles: UserRole[]) {
    if (!roles.includes(p.role)) throw new ForbiddenException('Your role cannot do this');
  }

  private async invoice(tx: Tx, id: string) {
    const [inv] = await tx.select().from(SI).where(eq(SI.id, id));
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  private async load(tx: Tx, id: string) {
    const inv = await this.invoice(tx, id);
    const [[supplier], lines, allocations] = await Promise.all([
      tx.select().from(S).where(eq(S.id, inv.supplierId)),
      tx.select().from(SIL).where(eq(SIL.invoiceId, id)).orderBy(asc(SIL.lineNo)),
      tx
        .select({ amount: schema.paymentAllocations.amount, paymentNo: schema.payments.paymentNo, paymentDate: schema.payments.paymentDate, reference: schema.payments.reference })
        .from(schema.paymentAllocations)
        .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentAllocations.paymentId))
        .where(eq(schema.paymentAllocations.supplierInvoiceId, id)),
    ]);
    return { ...inv, supplierName: supplier?.name ?? '', lines, payments: allocations };
  }

  /** Validate lines (project lines need a cost code on that project) and work out VAT. */
  private async prepareLines(tx: Tx, lines: z.infer<typeof Line>[]) {
    const codeIds = lines.map((l) => l.costCodeId).filter((x): x is string => Boolean(x));
    const codes = codeIds.length ? await tx.select().from(schema.costCodes).where(inArray(schema.costCodes.id, codeIds)) : [];
    const accountIds = lines.map((l) => l.accountId).filter((x): x is string => Boolean(x));
    const accounts = accountIds.length ? await tx.select().from(schema.accounts).where(inArray(schema.accounts.id, accountIds)) : [];
    return lines.map((l, i) => {
      const n = i + 1;
      if (l.projectId) {
        if (!l.costCodeId || !l.category) throw new BadRequestException(`Line ${n}: a project cost needs a cost code and a category`);
        const code = codes.find((c) => c.id === l.costCodeId);
        if (!code || code.projectId !== l.projectId) throw new BadRequestException(`Line ${n}: that cost code is not on the chosen project`);
        return { description: l.description, amount: money(new Decimal(l.amount)), vatRate: l.vatRate, vatAmount: vatFor(l.amount, l.vatRate), projectId: l.projectId, costCodeId: l.costCodeId, category: l.category, accountId: null };
      }
      if (!l.accountId) throw new BadRequestException(`Line ${n}: choose a project cost code or an expense account`);
      const acc = accounts.find((a) => a.id === l.accountId);
      if (!acc || !acc.isActive) throw new BadRequestException(`Line ${n}: unknown or inactive account`);
      if (acc.isBank || acc.systemKey === 'ap_control' || acc.systemKey === 'ar_control') {
        throw new BadRequestException(`Line ${n}: ${acc.code} ${acc.name} cannot be used on an invoice line`);
      }
      return { description: l.description, amount: money(new Decimal(l.amount)), vatRate: l.vatRate, vatAmount: vatFor(l.amount, l.vatRate), projectId: null, costCodeId: null, category: null, accountId: l.accountId };
    });
  }
}
