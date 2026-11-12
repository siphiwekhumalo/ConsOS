import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { autoMatch, money, parseStatementAmount } from './calc';
import { LedgerService, ledgerError } from './ledger.service';
import { LEDGER_ROLES, isoDate } from './ledger.controller';

const BSL = schema.bankStatementLines;
const J = schema.journals;
const JL = schema.journalLines;

const Import = z.object({
  lines: z
    .array(
      z.object({
        txnDate: isoDate,
        description: z.string().trim().min(1).max(300),
        reference: z.string().trim().max(100).optional(),
        /** As printed: "1 234.56", "-1,234.56", "(1234.56)", "1234.56 DR". */
        amount: z.string().trim().min(1).max(40),
      }),
    )
    .min(1)
    .max(5000),
});
const Match = z.object({ journalLineId: z.string().uuid() });
const PostLine = z.object({ accountId: z.string().uuid(), description: z.string().trim().min(1).max(300).optional() });

@Controller('finance/bank')
@RequiresModule('mod_finance')
@Roles(...LEDGER_ROLES)
export class BankingController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  /** Reconciliation workspace for one bank account. */
  @Get(':accountId')
  get(@CurrentUser() p: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, accountId));
  }

  /**
   * Import statement lines. Each line gets a stable id from its contents (and
   * its position among identical lines), so importing the same file twice adds nothing.
   */
  @Post(':accountId/import')
  @HttpCode(200)
  async import(@CurrentUser() p: Principal, @Param('accountId', ParseUUIDPipe) accountId: string, @Body(new ZodBodyPipe(Import)) body: z.infer<typeof Import>) {
    const seen = new Map<string, number>();
    const values = body.lines.map((l, i) => {
      const amount = parseStatementAmount(l.amount);
      if (!amount) throw new BadRequestException(`Line ${i + 1}: "${l.amount}" is not an amount`);
      const key = `${l.txnDate}|${amount}|${l.description}|${l.reference ?? ''}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return {
        txnDate: l.txnDate,
        description: l.description,
        reference: l.reference || null,
        amount,
        externalId: createHash('sha256').update(`${key}#${n}`).digest('hex').slice(0, 40),
      };
    });
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        await this.bankAccount(tx, accountId);
        const inserted = await tx
          .insert(BSL)
          .values(values.map((v) => ({ ...v, tenantId: p.tenantId, bankAccountId: accountId })))
          .onConflictDoNothing({ target: [BSL.bankAccountId, BSL.externalId] })
          .returning({ id: BSL.id });
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'bank.statement_imported',
          entityType: 'account',
          entityId: accountId,
          payload: { lines: values.length, imported: inserted.length, duplicates: values.length - inserted.length },
        });
        return { imported: inserted.length, duplicates: values.length - inserted.length, ...(await this.load(tx, accountId)) };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Match every statement line that has exactly one obvious ledger counterpart. */
  @Post(':accountId/auto-match')
  @HttpCode(200)
  async autoMatch(@CurrentUser() p: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const { statement, ledger } = await this.unmatched(tx, accountId);
        const matches = autoMatch(
          statement.map((s) => ({ id: s.id, txnDate: s.txnDate, amount: s.amount })),
          ledger.map((l) => ({ id: l.id, entryDate: l.entryDate, amount: l.amount })),
        );
        for (const m of matches) {
          await tx.update(BSL).set({ matchedLineId: m.journalLineId, matchedAt: new Date(), matchedBy: p.userId }).where(eq(BSL.id, m.statementLineId));
        }
        if (matches.length) {
          await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'bank.auto_matched', entityType: 'account', entityId: accountId, payload: { matched: matches.length } });
        }
        return { matched: matches.length, ...(await this.load(tx, accountId)) };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('lines/:id/match')
  @HttpCode(200)
  async match(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Match)) body: z.infer<typeof Match>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const line = await this.statementLine(tx, id);
        if (line.matchedLineId) throw new BadRequestException('This statement line is already matched');
        await tx.update(BSL).set({ matchedLineId: body.journalLineId, matchedAt: new Date(), matchedBy: p.userId }).where(eq(BSL.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'bank.matched', entityType: 'bank_statement_line', entityId: id, payload: { journalLineId: body.journalLineId, amount: line.amount } });
        return this.load(tx, line.bankAccountId);
      });
    } catch (err) {
      ledgerError(err, 'That ledger entry is already matched to another statement line');
    }
  }

  @Post('lines/:id/unmatch')
  @HttpCode(200)
  async unmatch(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const line = await this.statementLine(tx, id);
        if (!line.matchedLineId) throw new BadRequestException('This statement line is not matched');
        await tx.update(BSL).set({ matchedLineId: null, matchedAt: null, matchedBy: null }).where(eq(BSL.id, id));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'bank.unmatched', entityType: 'bank_statement_line', entityId: id, payload: { journalLineId: line.matchedLineId, amount: line.amount } });
        return this.load(tx, line.bankAccountId);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Post a statement line that has no ledger entry yet (bank charges, interest,
   * debit orders) against another account, and match it in one step.
   */
  @Post('lines/:id/post')
  @HttpCode(200)
  async post(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(PostLine)) body: z.infer<typeof PostLine>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const line = await this.statementLine(tx, id);
        if (line.matchedLineId) throw new BadRequestException('This statement line is already matched');
        const [contra] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, body.accountId));
        if (!contra || !contra.isActive) throw new BadRequestException('Choose an active account');
        if (contra.id === line.bankAccountId) throw new BadRequestException('Choose an account other than this bank account');
        if (contra.systemKey === 'ar_control' || contra.systemKey === 'ap_control') {
          throw new BadRequestException('Record customer receipts and supplier payments as payments, so they settle invoices');
        }
        const description = body.description ?? line.description;
        const journal = await this.ledger.post(
          tx,
          p,
          { entryDate: line.txnDate, description: description.slice(0, 300), source: 'bank', sourceId: line.id },
          [
            { accountId: line.bankAccountId, amount: line.amount, description },
            { accountId: contra.id, amount: money(new Decimal(line.amount).negated()), description },
          ],
        );
        const [bankLine] = await tx.select({ id: JL.id }).from(JL).where(and(eq(JL.journalId, journal.id), eq(JL.accountId, line.bankAccountId)));
        await tx.update(BSL).set({ matchedLineId: bankLine!.id, matchedAt: new Date(), matchedBy: p.userId }).where(eq(BSL.id, id));
        return this.load(tx, line.bankAccountId);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ helpers

  private async bankAccount(tx: Tx, id: string) {
    const [a] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, id));
    if (!a || !a.isBank) throw new NotFoundException('Bank account not found');
    return a;
  }

  private async statementLine(tx: Tx, id: string) {
    const [l] = await tx.select().from(BSL).where(eq(BSL.id, id));
    if (!l) throw new NotFoundException('Statement line not found');
    return l;
  }

  private async unmatched(tx: Tx, accountId: string) {
    const matchedIds = tx.select({ id: BSL.matchedLineId }).from(BSL).where(isNotNull(BSL.matchedLineId));
    const [statement, ledger] = await Promise.all([
      tx.select().from(BSL).where(and(eq(BSL.bankAccountId, accountId), isNull(BSL.matchedLineId))).orderBy(asc(BSL.txnDate)),
      tx
        .select({
          id: JL.id,
          entryDate: J.entryDate,
          journalNo: J.journalNo,
          description: sql<string>`coalesce(${JL.description}, ${J.description})`,
          journalDescription: J.description,
          amount: sql<string>`(${JL.debit} - ${JL.credit})::numeric(18,2)::text`,
        })
        .from(JL)
        .innerJoin(J, eq(J.id, JL.journalId))
        .where(and(eq(JL.accountId, accountId), notInArray(JL.id, matchedIds)))
        .orderBy(asc(J.entryDate)),
    ]);
    return { statement, ledger };
  }

  private async load(tx: Tx, accountId: string) {
    const account = await this.bankAccount(tx, accountId);
    const [{ statement, ledger }, [book], [stmt], matched] = await Promise.all([
      this.unmatched(tx, accountId),
      tx.select({ v: sql<string>`coalesce(sum(${JL.debit} - ${JL.credit}), 0)::numeric(18,2)::text` }).from(JL).where(eq(JL.accountId, accountId)),
      tx.select({ v: sql<string>`coalesce(sum(${BSL.amount}), 0)::numeric(18,2)::text`, last: sql<string | null>`max(${BSL.txnDate})::text` }).from(BSL).where(eq(BSL.bankAccountId, accountId)),
      tx.select().from(BSL).where(and(eq(BSL.bankAccountId, accountId), isNotNull(BSL.matchedLineId))).orderBy(asc(BSL.txnDate)).limit(200),
    ]);
    const unmatchedBook = ledger.reduce((s, l) => s.plus(l.amount), new Decimal(0));
    const unmatchedStatement = statement.reduce((s, l) => s.plus(l.amount), new Decimal(0));
    return {
      account: { id: account.id, code: account.code, name: account.name },
      bookBalance: book?.v ?? '0.00',
      /** Sum of all imported statement lines (the statement balance if the first import started from zero). */
      statementTotal: stmt?.v ?? '0.00',
      lastStatementDate: stmt?.last ?? null,
      unmatchedStatement: statement,
      unmatchedLedger: ledger,
      recentlyMatched: matched.slice(-50).reverse(),
      /** Ledger movements the bank has not shown yet, and bank movements not yet in the ledger. */
      outstanding: { inLedgerNotOnStatement: money(unmatchedBook), onStatementNotInLedger: money(unmatchedStatement) },
      /** Book balance − ledger-only items + statement-only items; equals the statement total when reconciled. */
      reconciledBalance: money(new Decimal(book?.v ?? 0).minus(unmatchedBook).plus(unmatchedStatement)),
    };
  }
}
