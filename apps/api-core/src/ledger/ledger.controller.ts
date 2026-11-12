import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
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
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { ageing, balanceSheet, incomeStatement, money, trialBalance, vatSummary } from './calc';
import { DEFAULT_CHART } from './chart';
import { LedgerService, ledgerError } from './ledger.service';
import { Decimal } from '@constructos/dsl-parser';

const A = schema.accounts;
const J = schema.journals;
const JL = schema.journalLines;
const FS = schema.financeSettings;

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
export const amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string, e.g. "1250.00"');
const today = () => new Date().toISOString().slice(0, 10);
const dateParam = (v: string | undefined, fallback: string | null) => {
  if (v === undefined || v === '') return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException('Dates are YYYY-MM-DD');
  return v;
};

const Settings = z
  .object({
    lockedThrough: isoDate.nullable(),
    vatRegistered: z.boolean(),
    vatNumber: z.string().regex(/^4\d{9}$/, 'a South African VAT number is 10 digits starting with 4').nullable(),
    fiscalYearStartMonth: z.number().int().min(1).max(12),
  })
  .partial();

const AccountBody = z.object({
  code: z.string().trim().regex(/^[0-9A-Za-z.\-]{1,20}$/, 'letters, digits, dot or dash'),
  name: z.string().trim().min(1).max(200),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  isBank: z.boolean().optional(),
});
const AccountPatch = z.object({ name: z.string().trim().min(1).max(200), isActive: z.boolean(), code: AccountBody.shape.code }).partial();

const ManualJournal = z.object({
  entryDate: isoDate,
  description: z.string().trim().min(1).max(300),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: amount.optional(),
        credit: amount.optional(),
        projectId: z.string().uuid().nullable().optional(),
        description: z.string().trim().max(300).optional(),
      }),
    )
    .min(2)
    .max(200),
});
const Reverse = z.object({ entryDate: isoDate.optional(), reason: z.string().trim().min(1).max(250) });

/** The general ledger is for finance and leadership. */
export const LEDGER_ROLES = ['owner', 'admin', 'finance'] as const;

@Controller('finance')
@RequiresModule('mod_finance')
@Roles(...LEDGER_ROLES)
export class LedgerController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ================================================================ setup & settings

  @Get('settings')
  settings(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadSettings(tx));
  }

  /** Create the default chart of accounts and settings. Safe to call once. */
  @Post('setup')
  @HttpCode(200)
  setup(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [existing] = await tx.select({ id: A.id }).from(A).limit(1);
      if (existing) throw new ConflictException('The chart of accounts is already set up');
      await tx.insert(A).values(DEFAULT_CHART.map((c) => ({ ...c, tenantId: p.tenantId, isBank: c.isBank ?? false, systemKey: c.systemKey ?? null })));
      await tx.insert(FS).values({ tenantId: p.tenantId }).onConflictDoNothing();
      await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'finance.setup', entityType: 'tenant', entityId: p.tenantId, payload: { accounts: DEFAULT_CHART.length } });
      return this.loadSettings(tx);
    });
  }

  @Patch('settings')
  updateSettings(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(Settings)) body: z.infer<typeof Settings>) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [before] = await tx.select().from(FS).where(eq(FS.tenantId, p.tenantId));
      // Re-opening a closed period is an owner decision.
      if (
        body.lockedThrough !== undefined && before?.lockedThrough &&
        (body.lockedThrough === null || body.lockedThrough < before.lockedThrough) && p.role !== 'owner'
      ) {
        throw new ForbiddenException('Only an owner can re-open a locked period');
      }
      await tx.insert(FS).values({ tenantId: p.tenantId, ...body }).onConflictDoUpdate({ target: FS.tenantId, set: body });
      await appendAudit(tx, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: body.lockedThrough !== undefined && body.lockedThrough !== (before?.lockedThrough ?? null) ? 'finance.period_lock_changed' : 'finance.settings_updated',
        entityType: 'tenant',
        entityId: p.tenantId,
        payload: { before: before ?? null, changes: body },
      });
      return this.loadSettings(tx);
    });
  }

  // ================================================================ accounts

  /** Chart of accounts with all-time balances. */
  @Get('accounts')
  accounts(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [accounts, balances] = await Promise.all([tx.select().from(A).orderBy(asc(A.code)), this.ledger.balances(tx, null, null)]);
      const by = new Map(balances.map((b) => [b.accountId, b]));
      return accounts.map((a) => {
        const b = by.get(a.id);
        const net = new Decimal(b?.debit ?? 0).minus(b?.credit ?? 0);
        return { ...a, balance: money(a.type === 'asset' || a.type === 'expense' ? net : net.negated()), hasPostings: Boolean(b) };
      });
    });
  }

  @Post('accounts')
  async addAccount(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(AccountBody)) body: z.infer<typeof AccountBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [a] = await tx.insert(A).values({ ...body, isBank: body.isBank ?? false, tenantId: p.tenantId }).returning();
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'account.created', entityType: 'account', entityId: a!.id, payload: body });
        return a;
      });
    } catch (err) {
      ledgerError(err, `Account code ${body.code} already exists`);
    }
  }

  @Patch('accounts/:id')
  async updateAccount(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(AccountPatch)) body: z.infer<typeof AccountPatch>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [before] = await tx.select().from(A).where(eq(A.id, id));
        if (!before) throw new NotFoundException('Account not found');
        if (body.isActive === false && before.systemKey) {
          throw new BadRequestException('The system posts to this account automatically; it cannot be deactivated');
        }
        const [a] = await tx.update(A).set(body).where(eq(A.id, id)).returning();
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'account.updated', entityType: 'account', entityId: id, payload: { code: before.code, changes: body } });
        return a;
      });
    } catch (err) {
      ledgerError(err, 'That account code is already used');
    }
  }

  /** One account's postings with a running balance. */
  @Get('accounts/:id/ledger')
  accountLedger(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query('from') from?: string, @Query('to') to?: string) {
    const f = dateParam(from, null);
    const t = dateParam(to, null);
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [a] = await tx.select().from(A).where(eq(A.id, id));
      if (!a) throw new NotFoundException('Account not found');
      const debitNormal = a.type === 'asset' || a.type === 'expense';
      const opening = f
        ? (await this.ledger.balances(tx, null, new Date(Date.parse(`${f}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10))).find((b) => b.accountId === id)
        : undefined;
      let running = new Decimal(opening?.debit ?? 0).minus(opening?.credit ?? 0);
      if (!debitNormal) running = running.negated();
      const openingBalance = money(running);
      const rows = await tx
        .select({ line: JL, journal: J })
        .from(JL)
        .innerJoin(J, eq(J.id, JL.journalId))
        .where(and(eq(JL.accountId, id), f ? gte(J.entryDate, f) : undefined, t ? lte(J.entryDate, t) : undefined))
        .orderBy(asc(J.entryDate), asc(J.journalNo))
        .limit(5000);
      return {
        account: a,
        openingBalance,
        lines: rows.map(({ line, journal }) => {
          const move = new Decimal(line.debit).minus(line.credit);
          running = running.plus(debitNormal ? move : move.negated());
          return {
            id: line.id,
            journalId: journal.id,
            journalNo: journal.journalNo,
            entryDate: journal.entryDate,
            description: line.description ?? journal.description,
            source: journal.source,
            debit: line.debit,
            credit: line.credit,
            balance: money(running),
          };
        }),
        closingBalance: money(running),
      };
    });
  }

  // ================================================================ journals

  @Get('journals')
  journals(@CurrentUser() p: Principal, @Query('from') from?: string, @Query('to') to?: string, @Query('source') source?: string) {
    const f = dateParam(from, null);
    const t = dateParam(to, null);
    return this.db.forTenant(p.tenantId, async (tx) => {
      const sources = schema.journalSource.enumValues as readonly string[];
      if (source && !sources.includes(source)) throw new BadRequestException('Unknown journal source');
      const js = await tx
        .select()
        .from(J)
        .where(and(f ? gte(J.entryDate, f) : undefined, t ? lte(J.entryDate, t) : undefined, source ? eq(J.source, source as (typeof schema.journalSource.enumValues)[number]) : undefined))
        .orderBy(desc(J.entryDate), desc(J.journalNo))
        .limit(300);
      if (js.length === 0) return [];
      const [lines, accounts, reversals] = await Promise.all([
        tx.select().from(JL).where(inArray(JL.journalId, js.map((j) => j.id))),
        tx.select({ id: A.id, code: A.code, name: A.name }).from(A),
        tx.select({ reversesId: J.reversesId }).from(J).where(inArray(J.reversesId, js.map((j) => j.id))),
      ]);
      const acc = new Map(accounts.map((a) => [a.id, a]));
      const reversed = new Set(reversals.map((r) => r.reversesId));
      return js.map((j) => ({
        ...j,
        reversed: reversed.has(j.id),
        lines: lines
          .filter((l) => l.journalId === j.id)
          .map((l) => ({ ...l, accountCode: acc.get(l.accountId)?.code, accountName: acc.get(l.accountId)?.name })),
      }));
    });
  }

  /** A manual journal (accruals, opening balances, corrections). */
  @Post('journals')
  async addJournal(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(ManualJournal)) body: z.infer<typeof ManualJournal>) {
    const lines = body.lines.map((l) => {
      const dr = new Decimal(l.debit ?? 0);
      const cr = new Decimal(l.credit ?? 0);
      if (dr.isZero() === cr.isZero()) throw new BadRequestException('Each line needs either a debit or a credit');
      return { accountId: l.accountId, projectId: l.projectId ?? null, description: l.description || null, debit: money(dr), credit: money(cr) };
    });
    const dr = lines.reduce((s, l) => s.plus(l.debit), new Decimal(0));
    const cr = lines.reduce((s, l) => s.plus(l.credit), new Decimal(0));
    if (!dr.equals(cr)) throw new BadRequestException(`Debits (${money(dr)}) and credits (${money(cr)}) must be equal`);
    try {
      return await this.db.forTenant(p.tenantId, (tx) =>
        this.ledger.post(tx, p, { entryDate: body.entryDate, description: body.description, source: 'manual' }, lines),
      );
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('journals/:id/reverse')
  @HttpCode(200)
  async reverse(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Reverse)) body: z.infer<typeof Reverse>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [j] = await tx.select().from(J).where(eq(J.id, id));
        if (!j) throw new NotFoundException('Journal not found');
        // Documents (invoices, payments) are reversed by voiding the document, so the two never disagree.
        if (j.source !== 'manual' && j.source !== 'bank') {
          throw new BadRequestException('This journal belongs to a document. Void the invoice instead');
        }
        return this.ledger.reverse(tx, p, id, body.entryDate ?? today(), `Reversal of journal ${j.journalNo}: ${body.reason}`.slice(0, 300));
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ reports

  @Get('reports/trial-balance')
  trialBalance(@CurrentUser() p: Principal, @Query('asAt') asAt?: string) {
    const at = dateParam(asAt, today())!;
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [accounts, balances] = await Promise.all([tx.select().from(A).orderBy(asc(A.code)), this.ledger.balances(tx, null, at)]);
      return { asAt: at, ...trialBalance(accounts, balances) };
    });
  }

  @Get('reports/income-statement')
  incomeStatement(@CurrentUser() p: Principal, @Query('from') from?: string, @Query('to') to?: string) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const s = await this.loadSettings(tx);
      const t = dateParam(to, today())!;
      const f = dateParam(from, fiscalYearStart(t, s.fiscalYearStartMonth))!;
      if (f > t) throw new BadRequestException('The start date is after the end date');
      const [accounts, balances] = await Promise.all([tx.select().from(A).orderBy(asc(A.code)), this.ledger.balances(tx, f, t)]);
      return { from: f, to: t, ...incomeStatement(accounts, balances) };
    });
  }

  @Get('reports/balance-sheet')
  balanceSheet(@CurrentUser() p: Principal, @Query('asAt') asAt?: string) {
    const at = dateParam(asAt, today())!;
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [accounts, balances] = await Promise.all([tx.select().from(A).orderBy(asc(A.code)), this.ledger.balances(tx, null, at)]);
      return { asAt: at, ...balanceSheet(accounts, balances) };
    });
  }

  @Get('reports/aged-receivables')
  agedReceivables(@CurrentUser() p: Principal, @Query('asAt') asAt?: string) {
    const at = dateParam(asAt, today())!;
    const CI = schema.customerInvoices;
    const C = schema.customers;
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({ partyId: C.id, partyName: C.name, dueDate: CI.dueDate, total: CI.total, amountPaid: CI.amountPaid })
        .from(CI)
        .innerJoin(C, eq(C.id, CI.customerId))
        .where(and(inArray(CI.status, ['issued', 'part_paid']), lte(CI.invoiceDate, at)));
      return { asAt: at, ...ageing(rows, at) };
    });
  }

  @Get('reports/aged-payables')
  agedPayables(@CurrentUser() p: Principal, @Query('asAt') asAt?: string) {
    const at = dateParam(asAt, today())!;
    const SI = schema.supplierInvoices;
    const S = schema.suppliers;
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx
        .select({ partyId: S.id, partyName: S.name, dueDate: SI.dueDate, total: SI.total, amountPaid: SI.amountPaid })
        .from(SI)
        .innerJoin(S, eq(S.id, SI.supplierId))
        .where(and(inArray(SI.status, ['approved', 'part_paid']), lte(SI.invoiceDate, at)));
      return { asAt: at, ...ageing(rows, at) };
    });
  }

  /** VAT201 working paper for a tax period. Verify before submitting to SARS. */
  @Get('reports/vat')
  vat(@CurrentUser() p: Principal, @Query('from') from?: string, @Query('to') to?: string) {
    const t = dateParam(to, today())!;
    const f = dateParam(from, `${t.slice(0, 7)}-01`)!;
    const CI = schema.customerInvoices;
    const CIL = schema.customerInvoiceLines;
    const SI = schema.supplierInvoices;
    const SIL = schema.supplierInvoiceLines;
    return this.db.forTenant(p.tenantId, async (tx) => {
      const keys = await this.ledger.systemAccounts(tx, ['vat_output', 'vat_input']);
      const balances = await this.ledger.balances(tx, f, t);
      const supplies = await tx
        .select({ rate: CIL.vatRate, total: sql<string>`coalesce(sum(${CIL.amount}), 0)::numeric(18,2)::text` })
        .from(CIL)
        .innerJoin(CI, eq(CI.id, CIL.invoiceId))
        .where(and(ne(CI.status, 'draft'), ne(CI.status, 'void'), gte(CI.invoiceDate, f), lte(CI.invoiceDate, t)))
        .groupBy(CIL.vatRate);
      const [purchases] = await tx
        .select({ total: sql<string>`coalesce(sum(${SIL.amount}), 0)::numeric(18,2)::text` })
        .from(SIL)
        .innerJoin(SI, eq(SI.id, SIL.invoiceId))
        .where(and(ne(SI.status, 'draft'), ne(SI.status, 'void'), gte(SI.invoiceDate, f), lte(SI.invoiceDate, t), eq(SIL.vatRate, '15')));
      const supply = (rate: string) => supplies.find((s) => Number(s.rate) === Number(rate))?.total ?? '0';
      return {
        from: f,
        to: t,
        ...vatSummary({
          outputVat: balances.find((b) => b.accountId === keys.vat_output),
          inputVat: balances.find((b) => b.accountId === keys.vat_input),
          standardRatedSupplies: supply('15'),
          zeroRatedSupplies: supply('0'),
          standardRatedPurchases: purchases?.total ?? '0',
        }),
      };
    });
  }

  // ================================================================ helpers

  private async loadSettings(tx: Tx) {
    const [s] = await tx.select().from(FS);
    const accounts = await tx.select({ id: A.id }).from(A);
    return {
      setUp: accounts.length > 0,
      lockedThrough: s?.lockedThrough ?? null,
      vatRegistered: s?.vatRegistered ?? true,
      vatNumber: s?.vatNumber ?? null,
      fiscalYearStartMonth: s?.fiscalYearStartMonth ?? 3,
    };
  }
}

/** First day of the financial year containing `date`. */
export function fiscalYearStart(date: string, startMonth: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}
