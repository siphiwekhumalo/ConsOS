import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { money } from './calc';
import { LedgerService, ledgerError } from './ledger.service';
import { LEDGER_ROLES, amount, isoDate } from './ledger.controller';
import { invoiceLabel } from './receivables.controller';

const PAY = schema.payments;
const PA = schema.paymentAllocations;
const SI = schema.supplierInvoices;
const CI = schema.customerInvoices;

const PaymentBody = z.object({
  direction: z.enum(['in', 'out']),
  /** Supplier (out) or customer (in). */
  partyId: z.string().uuid(),
  bankAccountId: z.string().uuid(),
  paymentDate: isoDate,
  reference: z.string().trim().max(100).optional(),
  allocations: z.array(z.object({ invoiceId: z.string().uuid(), amount })).min(1).max(100),
});

/**
 * Money paid to suppliers and received from customers. Each payment is fully
 * allocated to open invoices, posts Dr payables / Cr bank (out) or Dr bank /
 * Cr receivables (in), and can never be edited.
 */
@Controller('finance/payments')
@RequiresModule('mod_finance')
@Roles(...LEDGER_ROLES)
export class PaymentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  list(@CurrentUser() p: Principal, @Query('direction') direction?: string) {
    if (direction && direction !== 'in' && direction !== 'out') throw new BadRequestException('direction is in or out');
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({ payment: PAY, supplierName: schema.suppliers.name, customerName: schema.customers.name, bankName: schema.accounts.name })
        .from(PAY)
        .leftJoin(schema.suppliers, eq(schema.suppliers.id, PAY.supplierId))
        .leftJoin(schema.customers, eq(schema.customers.id, PAY.customerId))
        .innerJoin(schema.accounts, eq(schema.accounts.id, PAY.bankAccountId))
        .where(direction ? eq(PAY.direction, direction) : undefined)
        .orderBy(desc(PAY.paymentDate), desc(PAY.paymentNo))
        .limit(500);
      return rows.map((r) => ({
        ...r.payment,
        number: `${r.payment.direction === 'in' ? 'RCT' : 'PAY'}-${String(r.payment.paymentNo).padStart(5, '0')}`,
        partyName: r.supplierName ?? r.customerName ?? '',
        bankName: r.bankName,
      }));
    });
  }

  @Post()
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(PaymentBody)) body: z.infer<typeof PaymentBody>) {
    const ids = body.allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Allocate to each invoice once');
    const total = body.allocations.reduce((s, a) => s.plus(a.amount), new Decimal(0));
    if (!total.greaterThan(0)) throw new BadRequestException('The payment must be more than zero');
    try {
      return await this.db.forTenant(p.tenantId, (tx) => (body.direction === 'out' ? this.payOut(tx, p, body, money(total)) : this.receive(tx, p, body, money(total))));
    } catch (err) {
      ledgerError(err);
    }
  }

  private async bank(tx: Tx, id: string) {
    const [a] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    if (!a || !a.isBank || !a.isActive) throw new BadRequestException('Choose an active bank account');
    return a;
  }

  /** Check each allocation against what is still owed, and work out each invoice's new status. */
  private settle<T extends { id: string; total: string; amountPaid: string; status: string }>(
    invoices: T[],
    allocations: { invoiceId: string; amount: string }[],
    partyCheck: (inv: T) => boolean,
    label: (inv: T) => string,
  ) {
    return allocations.map((a) => {
      const inv = invoices.find((i) => i.id === a.invoiceId);
      if (!inv) throw new BadRequestException('Unknown invoice in the allocation');
      if (!partyCheck(inv)) throw new BadRequestException(`${label(inv)} belongs to someone else`);
      if (!['approved', 'issued', 'part_paid'].includes(inv.status)) throw new BadRequestException(`${label(inv)} is ${inv.status.replace('_', ' ')} and cannot be paid`);
      const outstanding = new Decimal(inv.total).minus(inv.amountPaid);
      if (new Decimal(a.amount).greaterThan(outstanding)) {
        throw new BadRequestException(`${label(inv)}: ${a.amount} is more than the ${money(outstanding)} outstanding`);
      }
      const paid = new Decimal(inv.amountPaid).plus(a.amount);
      return { inv, amount: a.amount, amountPaid: money(paid), status: paid.equals(inv.total) ? ('paid' as const) : ('part_paid' as const) };
    });
  }

  private async payOut(tx: Tx, p: Principal, body: z.infer<typeof PaymentBody>, total: string) {
    const bank = await this.bank(tx, body.bankAccountId);
    const [supplier] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, body.partyId));
    if (!supplier) throw new BadRequestException('Unknown supplier');
    const invoices = await tx.select().from(SI).where(inArray(SI.id, body.allocations.map((a) => a.invoiceId)));
    const settled = this.settle(invoices, body.allocations, (i) => i.supplierId === supplier.id, (i) => `Invoice ${i.invoiceNo}`);
    const keys = await this.ledger.systemAccounts(tx, ['ap_control']);
    const paymentNo = await this.ledger.nextNo(tx, 'payment_out');
    const journal = await this.ledger.post(
      tx,
      p,
      { entryDate: body.paymentDate, description: `Payment to ${supplier.name}${body.reference ? ` (${body.reference})` : ''}`.slice(0, 300), source: 'payment' },
      [
        { accountId: keys.ap_control, amount: total, description: 'Trade payables' },
        { accountId: bank.id, amount: money(new Decimal(total).negated()), description: supplier.name },
      ],
    );
    const [pay] = await tx
      .insert(PAY)
      .values({ tenantId: p.tenantId, direction: 'out', paymentNo, supplierId: supplier.id, bankAccountId: bank.id, paymentDate: body.paymentDate, amount: total, reference: body.reference ?? null, journalId: journal.id, createdBy: p.userId })
      .returning();
    await tx.insert(PA).values(settled.map((s) => ({ tenantId: p.tenantId, paymentId: pay!.id, supplierInvoiceId: s.inv.id, amount: s.amount })));
    for (const s of settled) await tx.update(SI).set({ amountPaid: s.amountPaid, status: s.status }).where(eq(SI.id, s.inv.id));
    await appendAudit(tx, {
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: 'payment.made',
      entityType: 'payment',
      entityId: pay!.id,
      payload: { supplier: supplier.name, amount: total, bank: bank.code, journalNo: journal.journalNo, invoices: settled.map((s) => ({ invoiceNo: s.inv.invoiceNo, amount: s.amount, status: s.status })) },
    });
    return { ...pay!, journalNo: journal.journalNo };
  }

  private async receive(tx: Tx, p: Principal, body: z.infer<typeof PaymentBody>, total: string) {
    const bank = await this.bank(tx, body.bankAccountId);
    const [customer] = await tx.select().from(schema.customers).where(eq(schema.customers.id, body.partyId));
    if (!customer) throw new BadRequestException('Unknown customer');
    const invoices = await tx.select().from(CI).where(inArray(CI.id, body.allocations.map((a) => a.invoiceId)));
    const settled = this.settle(invoices, body.allocations, (i) => i.customerId === customer.id, (i) => invoiceLabel(i.invoiceNo));
    const keys = await this.ledger.systemAccounts(tx, ['ar_control']);
    const paymentNo = await this.ledger.nextNo(tx, 'payment_in');
    const journal = await this.ledger.post(
      tx,
      p,
      { entryDate: body.paymentDate, description: `Receipt from ${customer.name}${body.reference ? ` (${body.reference})` : ''}`.slice(0, 300), source: 'payment' },
      [
        { accountId: bank.id, amount: total, description: customer.name },
        { accountId: keys.ar_control, amount: money(new Decimal(total).negated()), description: 'Trade receivables' },
      ],
    );
    const [pay] = await tx
      .insert(PAY)
      .values({ tenantId: p.tenantId, direction: 'in', paymentNo, customerId: customer.id, bankAccountId: bank.id, paymentDate: body.paymentDate, amount: total, reference: body.reference ?? null, journalId: journal.id, createdBy: p.userId })
      .returning();
    await tx.insert(PA).values(settled.map((s) => ({ tenantId: p.tenantId, paymentId: pay!.id, customerInvoiceId: s.inv.id, amount: s.amount })));
    const valuationsPaid: number[] = [];
    for (const s of settled) {
      await tx.update(CI).set({ amountPaid: s.amountPaid, status: s.status }).where(eq(CI.id, s.inv.id));
      // A fully paid valuation invoice marks its payment certificate paid (project controls).
      if (s.status === 'paid' && s.inv.valuationId) {
        const [v] = await tx.select().from(schema.valuations).where(eq(schema.valuations.id, s.inv.valuationId));
        if (v?.status === 'certified') {
          await tx.update(schema.valuations).set({ status: 'paid', paidOn: body.paymentDate }).where(eq(schema.valuations.id, v.id));
          valuationsPaid.push(v.valuationNo);
        }
      }
    }
    await appendAudit(tx, {
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: 'payment.received',
      entityType: 'payment',
      entityId: pay!.id,
      payload: { customer: customer.name, amount: total, bank: bank.code, journalNo: journal.journalNo, invoices: settled.map((s) => ({ number: invoiceLabel(s.inv.invoiceNo), amount: s.amount, status: s.status })), valuationsPaid },
    });
    return { ...pay!, journalNo: journal.journalNo, valuationsPaid };
  }
}
