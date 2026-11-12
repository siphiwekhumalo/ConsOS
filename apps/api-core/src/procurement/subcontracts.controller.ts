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
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx, type UserRole } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { LedgerService, ledgerError } from '../ledger/ledger.service';
import { invoiceTotals, vatFor } from '../ledger/calc';
import { subcontractCertificate } from './calc';

const SC = schema.subcontracts;
const SCC = schema.subcontractCertificates;
const S = schema.suppliers;
const SI = schema.supplierInvoices;
const SIL = schema.supplierInvoiceLines;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string');
const pct = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'percentage as a decimal string');

const SubcontractBody = z.object({
  projectId: z.string().uuid(),
  supplierId: z.string().uuid(),
  ref: z.string().trim().min(1).max(30),
  scope: z.string().trim().min(1).max(2000),
  costCodeId: z.string().uuid(),
  contractValue: amount,
  retentionPct: pct.optional(),
  retentionLimitPct: pct.optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
});
const Transition = z.object({ to: z.enum(['active', 'completed', 'terminated']) });
const CertBody = z.object({ periodEnd: isoDate, workDoneToDate: amount, notes: z.string().trim().max(2000).optional() });
const Certify = z.object({
  /** The subcontractor's tax invoice number, when it has been received. */
  invoiceNo: z.string().trim().min(1).max(60).optional(),
  invoiceDate: isoDate.optional(),
});

const BUYERS: UserRole[] = ['owner', 'admin', 'project_manager', 'finance'];
const CERTIFIERS: UserRole[] = ['owner', 'admin', 'finance'];
const today = () => new Date().toISOString().slice(0, 10);

@Controller('procurement/subcontracts')
@RequiresModule('mod_procurement')
@Roles(...BUYERS)
export class SubcontractsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  list(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({ sc: SC, supplierName: S.name, projectCode: schema.projects.code })
        .from(SC)
        .innerJoin(S, eq(S.id, SC.supplierId))
        .innerJoin(schema.projects, eq(schema.projects.id, SC.projectId))
        .orderBy(asc(schema.projects.code), asc(SC.ref));
      const certs = rows.length ? await tx.select().from(SCC).where(and(inArray(SCC.subcontractId, rows.map((r) => r.sc.id)), eq(SCC.status, 'certified'))) : [];
      return rows.map((r) => {
        const latest = certs.filter((c) => c.subcontractId === r.sc.id).sort((a, b) => b.certNo - a.certNo)[0];
        return { ...r.sc, supplierName: r.supplierName, projectCode: r.projectCode, ...summary(r.sc, latest) };
      });
    });
  }

  @Get(':id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, id));
  }

  @Post()
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(SubcontractBody)) body: z.infer<typeof SubcontractBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [supplier] = await tx.select().from(S).where(eq(S.id, body.supplierId));
        if (!supplier || !supplier.isActive) throw new BadRequestException('Choose an active supplier');
        if (!supplier.isSubcontractor) throw new BadRequestException(`${supplier.name} is not marked as a subcontractor. Update the supplier first`);
        const [sc] = await tx.insert(SC).values({ ...body, tenantId: p.tenantId, createdBy: p.userId }).returning();
        await this.audit(tx, p, 'subcontract.created', sc!.id, { ref: body.ref, supplier: supplier.name, contractValue: body.contractValue });
        return this.load(tx, sc!.id);
      });
    } catch (err) {
      ledgerError(err, 'That subcontract reference is already used on this project');
    }
  }

  @Patch(':id')
  async update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(SubcontractBody.partial())) body: Partial<z.infer<typeof SubcontractBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const sc = await this.subcontract(tx, id);
        await tx.update(SC).set(body).where(eq(SC.id, id));
        await this.audit(tx, p, 'subcontract.updated', id, { ref: sc.ref, changes: body });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post(':id/transition')
  @HttpCode(200)
  async transition(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Transition)) body: z.infer<typeof Transition>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const sc = await this.subcontract(tx, id);
        if (body.to !== 'active' && !CERTIFIERS.includes(p.role)) throw new ForbiddenException('Your role cannot close subcontracts');
        await tx.update(SC).set({ status: body.to }).where(eq(SC.id, id));
        await this.audit(tx, p, `subcontract.${body.to}`, id, { ref: sc.ref, from: sc.status, to: body.to });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ certificates

  @Post(':id/certificates')
  async addCertificate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(CertBody)) body: z.infer<typeof CertBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const sc = await this.subcontract(tx, id);
        const prior = await tx.select().from(SCC).where(eq(SCC.subcontractId, id)).orderBy(desc(SCC.certNo));
        const last = prior.find((c) => c.status === 'certified');
        if (last && body.periodEnd <= String(last.periodEnd)) throw new BadRequestException(`Period end must be after certificate ${last.certNo}`);
        const f = this.figures(sc, body.workDoneToDate, last);
        const certNo = (prior[0]?.certNo ?? 0) + 1;
        const { grossMovement: _g, retentionMovement: _r, ...stored } = f;
        await tx.insert(SCC).values({ tenantId: p.tenantId, subcontractId: id, certNo, periodEnd: body.periodEnd, notes: body.notes ?? '', createdBy: p.userId, ...stored });
        await this.audit(tx, p, 'subcontract.certificate_drafted', id, { ref: sc.ref, certNo, ...stored });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Patch(':id/certificates/:certId')
  async updateCertificate(
    @CurrentUser() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('certId', ParseUUIDPipe) certId: string,
    @Body(new ZodBodyPipe(CertBody.partial())) body: Partial<z.infer<typeof CertBody>>,
  ) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const sc = await this.subcontract(tx, id);
        const cert = await this.certificate(tx, id, certId);
        if (cert.status !== 'draft') throw new BadRequestException('A certified certificate cannot be changed');
        const last = await this.lastCertified(tx, id);
        const { grossMovement: _g, retentionMovement: _r, ...stored } = this.figures(sc, body.workDoneToDate ?? cert.workDoneToDate, last);
        await tx.update(SCC).set({ ...stored, periodEnd: body.periodEnd ?? cert.periodEnd, notes: body.notes ?? cert.notes }).where(eq(SCC.id, certId));
        await this.audit(tx, p, 'subcontract.certificate_updated', id, { ref: sc.ref, certNo: cert.certNo, ...stored });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Delete(':id/certificates/:certId')
  async removeCertificate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('certId', ParseUUIDPipe) certId: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        await this.certificate(tx, id, certId);
        await tx.delete(SCC).where(eq(SCC.id, certId));
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Certify a payment certificate and draft the subcontractor's invoice:
   * the gross movement is a subcontract cost on the project; the retention
   * movement is held back (Cr retention payable); VAT on the net amount due.
   * Finance then approves it under Payables like any other supplier invoice.
   */
  @Post(':id/certificates/:certId/certify')
  @HttpCode(200)
  async certify(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('certId', ParseUUIDPipe) certId: string, @Body(new ZodBodyPipe(Certify)) body: z.infer<typeof Certify>) {
    if (!CERTIFIERS.includes(p.role)) throw new ForbiddenException('Only finance or an administrator can certify payments');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const sc = await this.subcontract(tx, id);
        const cert = await this.certificate(tx, id, certId);
        if (cert.status !== 'draft') throw new BadRequestException('Already certified');
        const [supplier] = await tx.select().from(S).where(eq(S.id, sc.supplierId));
        const keys = await this.ledger.systemAccounts(tx, ['retention_payable']);
        const f = this.figures(sc, cert.workDoneToDate, await this.lastCertified(tx, id));
        await tx.update(SCC).set({ status: 'certified', certifiedAt: new Date(), certifiedBy: p.userId }).where(eq(SCC.id, certId));

        let invoiceId: string | null = null;
        if (new Decimal(f.amountDue).isPositive()) {
          const vatRate = supplier!.vatNumber ? '15' : '0';
          const lines = [
            { description: `${sc.ref} certificate ${cert.certNo}: work done this period`, amount: f.grossMovement, vatRate, projectId: sc.projectId, costCodeId: sc.costCodeId, category: 'subcontract' as const, accountId: null },
            ...(new Decimal(f.retentionMovement).isZero()
              ? []
              : [{ description: `${sc.ref} certificate ${cert.certNo}: retention`, amount: new Decimal(f.retentionMovement).negated().toFixed(2), vatRate, projectId: null, costCodeId: null, category: null, accountId: keys.retention_payable }]),
          ].map((l) => ({ ...l, vatAmount: vatFor(l.amount, l.vatRate) }));
          const invoiceDate = body.invoiceDate ?? today();
          const [inv] = await tx
            .insert(SI)
            .values({
              tenantId: p.tenantId,
              supplierId: sc.supplierId,
              invoiceNo: body.invoiceNo ?? `${sc.ref}-PC${cert.certNo}`,
              invoiceDate,
              dueDate: new Date(Date.parse(`${invoiceDate}T00:00:00Z`) + supplier!.paymentTermsDays * 86_400_000).toISOString().slice(0, 10),
              subcontractCertificateId: certId,
              notes: `Subcontract ${sc.ref}, payment certificate ${cert.certNo} (period ending ${cert.periodEnd}).`,
              createdBy: p.userId,
              ...invoiceTotals(lines),
            })
            .returning();
          await tx.insert(SIL).values(lines.map((l, i) => ({ ...l, tenantId: p.tenantId, invoiceId: inv!.id, lineNo: i + 1 })));
          await tx.update(SCC).set({ supplierInvoiceId: inv!.id }).where(eq(SCC.id, certId));
          invoiceId = inv!.id;
          if (!new Decimal(inv!.subtotal).equals(f.amountDue)) {
            throw new BadRequestException(`Invoice subtotal ${inv!.subtotal} does not match the certificate amount due ${f.amountDue}`);
          }
        }
        await this.audit(tx, p, 'subcontract.certified', id, { ref: sc.ref, certNo: cert.certNo, amountDue: f.amountDue, grossMovement: f.grossMovement, retentionMovement: f.retentionMovement, supplierInvoiceId: invoiceId });
        return { ...(await this.load(tx, id)), supplierInvoiceId: invoiceId };
      });
    } catch (err) {
      ledgerError(err, 'An invoice with that number from this subcontractor is already captured');
    }
  }

  // ================================================================ helpers

  private figures(sc: typeof SC.$inferSelect, workDoneToDate: string, last: typeof SCC.$inferSelect | undefined) {
    return subcontractCertificate({
      workDoneToDate,
      retentionPct: sc.retentionPct,
      retentionLimitPct: sc.retentionLimitPct,
      contractValue: sc.contractValue,
      previousGross: last?.workDoneToDate ?? '0',
      previousRetention: last?.retentionToDate ?? '0',
    });
  }

  private audit(tx: Tx, p: Principal, action: string, id: string, payload: Record<string, unknown>) {
    return appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action, entityType: 'subcontract', entityId: id, payload });
  }

  private async subcontract(tx: Tx, id: string) {
    const [sc] = await tx.select().from(SC).where(eq(SC.id, id));
    if (!sc) throw new NotFoundException('Subcontract not found');
    return sc;
  }

  private async certificate(tx: Tx, id: string, certId: string) {
    const [c] = await tx.select().from(SCC).where(and(eq(SCC.id, certId), eq(SCC.subcontractId, id)));
    if (!c) throw new NotFoundException('Certificate not found');
    return c;
  }

  private async lastCertified(tx: Tx, id: string) {
    const [c] = await tx.select().from(SCC).where(and(eq(SCC.subcontractId, id), eq(SCC.status, 'certified'))).orderBy(desc(SCC.certNo)).limit(1);
    return c;
  }

  private async load(tx: Tx, id: string) {
    const sc = await this.subcontract(tx, id);
    const [[supplier], [project], certs] = await Promise.all([
      tx.select().from(S).where(eq(S.id, sc.supplierId)),
      tx.select({ code: schema.projects.code, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, sc.projectId)),
      tx.select().from(SCC).where(eq(SCC.subcontractId, id)).orderBy(desc(SCC.certNo)),
    ]);
    const invoices = certs.some((c) => c.supplierInvoiceId)
      ? await tx.select({ id: SI.id, status: SI.status, invoiceNo: SI.invoiceNo }).from(SI).where(and(inArray(SI.id, certs.map((c) => c.supplierInvoiceId).filter((x): x is string => Boolean(x))), ne(SI.status, 'void')))
      : [];
    const latest = certs.find((c) => c.status === 'certified');
    return {
      ...sc,
      supplierName: supplier?.name ?? '',
      projectCode: project?.code ?? '',
      projectName: project?.name ?? '',
      ...summary(sc, latest),
      certificates: certs.map((c) => ({ ...c, invoice: invoices.find((i) => i.id === c.supplierInvoiceId) ?? null })),
    };
  }
}

function summary(sc: typeof SC.$inferSelect, latest: typeof SCC.$inferSelect | undefined) {
  const certified = new Decimal(latest?.workDoneToDate ?? 0);
  const left = new Decimal(sc.contractValue).minus(certified);
  return {
    certifiedToDate: certified.toFixed(2),
    retentionHeld: new Decimal(latest?.retentionToDate ?? 0).toFixed(2),
    remaining: (left.isNegative() ? new Decimal(0) : left).toFixed(2),
    percentComplete: new Decimal(sc.contractValue).isZero() ? null : certified.dividedBy(sc.contractValue).times(100).toDecimalPlaces(1).toFixed(1),
  };
}
