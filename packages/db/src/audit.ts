import { sql } from 'drizzle-orm';
import type { Tx } from './client';

export interface AuditInput {
  tenantId: string;
  actorUserId: string | null;
  /** dotted lower_snake verb, e.g. "project.created", "valuation.approved" */
  action: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Append an event to the tenant's hash-chained audit ledger.
 * Call inside the same `withTenant` transaction as the change it records, so
 * the event and the change commit or roll back together. seq and hashes are
 * assigned by the database trigger.
 */
export async function appendAudit(tx: Tx, input: AuditInput): Promise<{ id: number; seq: number }> {
  // Raw insert: seq, occurred_at, prev_hash and hash are trigger-assigned.
  const rows = await tx.execute<{ id: string; seq: string }>(sql`
    insert into audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, payload)
    values (
      ${input.tenantId}, ${input.actorUserId}, ${input.action}, ${input.entityType},
      ${input.entityId ?? null}, ${JSON.stringify(input.payload ?? {})}::jsonb
    )
    returning id, seq`);
  const row = rows[0]!;
  return { id: Number(row.id), seq: Number(row.seq) };
}

export interface ChainVerification {
  eventsChecked: number;
  /** null when the whole chain verifies */
  firstBrokenSeq: number | null;
  /** hex hash of the last verified event — what Phase 3 anchors to S3 Object Lock */
  headHash: string;
}

export async function verifyAuditChain(tx: Tx): Promise<ChainVerification> {
  const rows = await tx.execute<{
    events_checked: string;
    first_broken_seq: string | null;
    head_hash: string;
  }>(sql`select * from audit_verify_chain()`);
  const r = rows[0]!;
  return {
    eventsChecked: Number(r.events_checked),
    firstBrokenSeq: r.first_broken_seq === null ? null : Number(r.first_broken_seq),
    headHash: r.head_hash,
  };
}
