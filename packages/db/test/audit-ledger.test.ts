/**
 * Audit ledger guarantees: append-only, hash-chained per tenant, tamper-evident.
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { appendAudit, createDb, verifyAuditChain, withTenant, type DbHandle } from '../src';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;

const run = Date.now().toString(36);
const A = { id: randomUUID(), slug: `aud-a-${run}` };
const B = { id: randomUUID(), slug: `aud-b-${run}` };

let owner: postgres.Sql;
let app: DbHandle;

async function errorText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const parts: string[] = [];
    for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (e.message) parts.push(e.message);
    }
    return parts.join(' | ');
  }
  throw new Error('expected rejection');
}

describe.skipIf(!OWNER_URL || !APP_URL)('audit ledger', () => {
  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [A, B]) {
      await owner.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${t.id}, true)`;
        await tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`;
      });
    }
    app = createDb(APP_URL!, { max: 4 });
  });

  afterAll(async () => {
    await app?.close();
    // Ledger rows are immutable by design; test tenants are left in place
    // (unique slugs per run). Reset local data with `docker compose down -v`.
    await owner?.end({ timeout: 5 });
  });

  it('assigns contiguous per-tenant sequence numbers and verifies', async () => {
    for (let i = 0; i < 3; i++) {
      await withTenant(app.db, A.id, (tx) =>
        appendAudit(tx, {
          tenantId: A.id,
          actorUserId: null,
          action: 'project.created',
          entityType: 'project',
          entityId: randomUUID(),
          payload: { i, value: '1250000.00' },
        }),
      );
    }
    await withTenant(app.db, B.id, (tx) =>
      appendAudit(tx, { tenantId: B.id, actorUserId: null, action: 'project.created', entityType: 'project' }),
    );

    const a = await withTenant(app.db, A.id, verifyAuditChain);
    const b = await withTenant(app.db, B.id, verifyAuditChain);
    expect(a).toMatchObject({ eventsChecked: 3, firstBrokenSeq: null });
    expect(b).toMatchObject({ eventsChecked: 1, firstBrokenSeq: null });
    expect(a.headHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serialises concurrent appends without gaps or forks', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withTenant(app.db, A.id, (tx) =>
          appendAudit(tx, { tenantId: A.id, actorUserId: null, action: 'diary.synced', entityType: 'diary', payload: { i } }),
        ),
      ),
    );
    expect(await withTenant(app.db, A.id, verifyAuditChain)).toMatchObject({
      eventsChecked: 13,
      firstBrokenSeq: null,
    });
  });

  it('rejects update, delete and truncate from the app role', async () => {
    expect(
      await errorText(withTenant(app.db, A.id, (tx) => tx.execute(sql`update audit_events set payload = '{}'`))),
    ).toMatch(/permission denied/);
    expect(
      await errorText(withTenant(app.db, A.id, (tx) => tx.execute(sql`delete from audit_events`))),
    ).toMatch(/permission denied/);
  });

  it('rejects update even from the owner role (append-only trigger)', async () => {
    const msg = await errorText(
      owner.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${A.id}, true)`;
        await tx`update audit_events set payload = '{"forged":true}' where tenant_id = ${A.id} and seq = 2`;
      }),
    );
    expect(msg).toMatch(/append-only/);
  });

  it('cannot write an event into another tenant', async () => {
    const msg = await errorText(
      withTenant(app.db, A.id, (tx) =>
        appendAudit(tx, { tenantId: B.id, actorUserId: null, action: 'project.created', entityType: 'project' }),
      ),
    );
    expect(msg).toMatch(/does not match current tenant|row-level security/);
  });

  it('cannot advance the chain head directly', async () => {
    const msg = await errorText(
      withTenant(app.db, A.id, (tx) => tx.execute(sql`update audit_chain_heads set seq = 0`)),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it('detects tampering by a superuser who bypasses the triggers', async () => {
    // Simulates a rogue DB admin: disable the guard, alter history, re-enable.
    await owner.begin(async (tx) => {
      await tx`alter table audit_events disable trigger audit_events_no_update`;
      await tx`update audit_events set payload = '{"value":"9999999.00"}' where tenant_id = ${B.id} and seq = 1`;
      await tx`alter table audit_events enable trigger audit_events_no_update`;
    });
    expect(await withTenant(app.db, B.id, verifyAuditChain)).toMatchObject({
      eventsChecked: 1,
      firstBrokenSeq: 1,
    });
    // Tenant A's chain is unaffected.
    expect((await withTenant(app.db, A.id, verifyAuditChain)).firstBrokenSeq).toBeNull();
  });
});
