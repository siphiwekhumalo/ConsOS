import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { appendAudit, schema, type Tx } from '@constructos/db';
import type { Principal } from '../auth/auth.types';
import { reverseLines, toLines, type JournalLineValues, type Posting } from './calc';
import type { SystemKey } from './chart';

const A = schema.accounts;
const J = schema.journals;
const JL = schema.journalLines;

export type JournalSource = (typeof schema.journalSource.enumValues)[number];

const pgCode = (err: unknown) => (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
const pgMessage = (err: unknown) => (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;

/** Map database rule violations from the ledger to HTTP errors with their own message. */
export function ledgerError(err: unknown, duplicate = 'That already exists'): never {
  const code = pgCode(err);
  if (code === '23505') throw new ConflictException(duplicate);
  if (code === '23514') throw new BadRequestException(pgMessage(err));
  if (code === '42501') throw new ConflictException(pgMessage(err));
  if (code === '23503') throw new ConflictException('This record is still referenced elsewhere');
  throw err;
}

/** The only way anything is written to the general ledger. */
@Injectable()
export class LedgerService {
  /** Look up the accounts the system posts to; fails clearly if the chart is not set up. */
  async systemAccounts<K extends SystemKey>(tx: Tx, keys: K[]): Promise<Record<K, string>> {
    const rows = await tx.select({ id: A.id, key: A.systemKey, active: A.isActive }).from(A).where(isNotNull(A.systemKey));
    const out = {} as Record<K, string>;
    for (const k of keys) {
      const row = rows.find((r) => r.key === k);
      if (!row) throw new BadRequestException(`Set up the chart of accounts first (missing ${k.replace(/_/g, ' ')} account)`);
      if (!row.active) throw new BadRequestException(`The ${k.replace(/_/g, ' ')} account is inactive`);
      out[k] = row.id;
    }
    return out;
  }

  async nextNo(
    tx: Tx,
    kind: 'journal' | 'customer_invoice' | 'payment_in' | 'payment_out' | 'purchase_order' | 'rfq' | 'goods_receipt' | 'work_order' | 'incident' | 'ncr' | 'inspection',
  ): Promise<number> {
    // postgres-js returns the rows as an array.
    const rows = (await tx.execute(sql`select next_doc_no(${kind}) as n`)) as unknown as { n: number }[];
    return Number(rows[0]!.n);
  }

  /**
   * Post a balanced journal. The database re-checks balance at commit, the
   * period lock and account activity; this checks first for clear messages.
   */
  async post(
    tx: Tx,
    p: Principal,
    j: { entryDate: string; description: string; source: JournalSource; sourceId?: string | null; reversesId?: string | null },
    postings: Posting[] | JournalLineValues[],
  ) {
    let lines: JournalLineValues[];
    try {
      lines = 'debit' in (postings[0] ?? {}) ? (postings as JournalLineValues[]) : toLines(postings as Posting[]);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const journalNo = await this.nextNo(tx, 'journal');
    const [journal] = await tx
      .insert(J)
      .values({ tenantId: p.tenantId, journalNo, postedBy: p.userId, ...j, sourceId: j.sourceId ?? null, reversesId: j.reversesId ?? null })
      .returning();
    await tx.insert(JL).values(lines.map((l) => ({ ...l, tenantId: p.tenantId, journalId: journal!.id })));
    await appendAudit(tx, {
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: 'journal.posted',
      entityType: 'journal',
      entityId: journal!.id,
      payload: {
        journalNo,
        entryDate: j.entryDate,
        source: j.source,
        sourceId: j.sourceId ?? null,
        reversesId: j.reversesId ?? null,
        lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, projectId: l.projectId })),
      },
    });
    return journal!;
  }

  /** Post the exact opposite of a journal, dated `entryDate`. */
  async reverse(tx: Tx, p: Principal, journalId: string, entryDate: string, description: string, source: JournalSource = 'reversal') {
    const [orig] = await tx.select().from(J).where(eq(J.id, journalId));
    if (!orig) throw new BadRequestException('Journal not found');
    if (orig.reversesId) throw new BadRequestException('A reversal cannot itself be reversed');
    const [already] = await tx.select({ id: J.id }).from(J).where(eq(J.reversesId, journalId));
    if (already) throw new ConflictException(`Journal ${orig.journalNo} has already been reversed`);
    const lines = await tx.select().from(JL).where(eq(JL.journalId, journalId));
    return this.post(
      tx,
      p,
      { entryDate, description, source, sourceId: orig.sourceId, reversesId: orig.id },
      reverseLines(lines.map((l) => ({ accountId: l.accountId, projectId: l.projectId, description: l.description, debit: l.debit, credit: l.credit }))),
    );
  }

  /** Per-account debit and credit totals between two dates (inclusive; either may be open). */
  async balances(tx: Tx, from: string | null, to: string | null) {
    const conds = [
      from ? sql`${J.entryDate} >= ${from}` : undefined,
      to ? sql`${J.entryDate} <= ${to}` : undefined,
    ].filter(Boolean);
    const rows = await tx
      .select({
        accountId: JL.accountId,
        debit: sql<string>`coalesce(sum(${JL.debit}), 0)::numeric(18,2)::text`,
        credit: sql<string>`coalesce(sum(${JL.credit}), 0)::numeric(18,2)::text`,
      })
      .from(JL)
      .innerJoin(J, eq(J.id, JL.journalId))
      .where(conds.length ? and(...(conds as ReturnType<typeof sql>[])) : undefined)
      .groupBy(JL.accountId);
    return rows;
  }
}
